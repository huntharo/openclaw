import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateMessageActionParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { resolveGatewayConversationReadOrigin } from "../../../gateway/conversation-read-origin.js";
import { selectMessageActionRequesterIdentity } from "../../../gateway/message-action-turn-capability.js";
import { authorizeGatewaySessionCreation } from "../../../gateway/operator-role-policy.js";
import { ADMIN_SCOPE } from "../../../gateway/operator-scopes.js";
import {
  createMessageActionRuntimeAuthority,
  resolveTrustedMessageActionToolContext,
} from "../../../gateway/server-methods/message-action-context.js";
import {
  createGatewayInflightAuthorityFailure,
  createGatewayInflightResult,
  createGatewayInflightSuccess,
  createGatewayInflightUnavailableFailure,
  scheduleDeliveredSourceReplyTranscriptMirror,
} from "../../../gateway/server-methods/message-operation-result.js";
import { withMessageOperationRoute } from "../../../gateway/server-methods/message-operation-route.js";
import {
  resolveMessageActionRuntimeConfig,
  resolveRequestedChannel,
} from "../../../gateway/server-methods/send-channel-resolution.js";
import type { GatewayRequestHandler } from "../../../gateway/server-methods/types.js";
import { assertValidParams } from "../../../gateway/server-methods/validation.js";
import { resolveRequestedSessionAgentId } from "../../../gateway/session-request-agent.js";
import { captureGatewayClientUploadCommitGuard } from "../../../gateway/upload-policy.js";
import { formatForLog } from "../../../gateway/ws-log.js";
import { resolveOutboundChannelPlugin } from "../../../infra/outbound/channel-resolution.js";
import { resolveImplicitMessageActionTarget } from "../../../infra/outbound/message-action-normalization.js";
import {
  hydrateAttachmentParamsForAction,
  resolveAttachmentMediaPolicy,
} from "../../../infra/outbound/message-action-params.js";
import { actionHasTarget } from "../../../infra/outbound/message-action-spec.js";
import {
  beginTerminalSourceReplyDelivery,
  cancelTerminalSourceReplyDelivery,
  reconcileTerminalSourceReplyDelivery,
} from "../../../infra/outbound/source-reply-mirror.js";
import { resolveOutboundTarget } from "../../../infra/outbound/targets.js";
import { resolveAgentScopedOutboundMediaAccess } from "../../../media/read-capability.js";
import { extractToolPayload } from "../../../plugin-sdk/tool-payload.js";
import { withChannelReadAuthority } from "../../../shared/channel-read-authority.js";
import { dispatchChannelMessageAction } from "../../plugins/message-action-dispatch.js";
import { CHANNEL_MESSAGE_ACTION_NAMES } from "../../plugins/message-action-names.js";
import { isChannelPartialDeliveryError } from "../../turn/partial-delivery-error.js";

export const messageActionOperation: GatewayRequestHandler = async ({
  params: request,
  respond,
  context,
  client,
  sessionMutationCommitGuard,
}) => {
  if (!assertValidParams(request, validateMessageActionParams, "message.action", respond)) {
    return;
  }
  // Hydration replaces the client buffer with a stored path; retain ingress classification.
  const assertClientUploadAllowed = captureGatewayClientUploadCommitGuard({
    method: "message.action",
    requestParams: request,
    client,
    context,
  });
  const trustedContext = resolveTrustedMessageActionToolContext({ client, request });
  if (!trustedContext.ok) {
    respond(false, undefined, trustedContext.error);
    return;
  }
  const conversationReadOrigin = resolveGatewayConversationReadOrigin({
    client,
    requestedOrigin: request.conversationReadOrigin,
  });
  const messageAuthority = createMessageActionRuntimeAuthority({
    client,
    context,
    respond,
    sessionMutationCommitGuard,
    request,
    authorization: trustedContext.messageActionAuthorization,
    assertClientUploadAllowed,
  });
  const assertDirectAdapterHandoff = messageAuthority.assertDirectAdapterHandoff;
  const onPlatformSendDispatch = messageAuthority.onPlatformSendDispatch;
  const downstreamToolContext = trustedContext.toolContext
    ? { ...trustedContext.toolContext, skipCrossContextDecoration: true as const }
    : undefined;
  const downstreamMessageActionAuthorization = trustedContext.messageActionAuthorization
    ? { ...trustedContext.messageActionAuthorization, toolContext: downstreamToolContext }
    : undefined;
  await withMessageOperationRoute({
    context,
    prefix: "message.action",
    operation: request.action,
    idempotencyKey: request.idempotencyKey,
    respond,
    conversationReadOrigin,
    requestChannel: request.channel,
    bindingAccountIds: [messageAuthority.routeAccountId, request.params.accountId],
    routeAccountIds: (binding) => [
      messageAuthority.routeAccountId,
      request.params.accountId,
      binding?.reservedRoute?.accountId,
    ],
    conflictMessage: "message.action accountId does not match params.accountId",
    authorize: messageAuthority.agentRuntimeAuthority.hasActive,
    assertNewInputAllowed: assertClientUploadAllowed,
    replayResults: messageAuthority.assertReadCurrent === undefined,
    resolveChannel: async (requestChannel) => {
      const resolved = await resolveRequestedChannel({
        requestChannel,
        unsupportedMessage: (input) => `unsupported channel: ${input}`,
        context,
        config: trustedContext.messageActionConfig,
        rejectWebchatAsInternalOnly: true,
      });
      if ("error" in resolved) {
        respond(false, undefined, resolved.error);
        return undefined;
      }
      const { cfg: selectedCfg, channel } = resolved;
      const cfg =
        trustedContext.messageActionConfig ?? resolveMessageActionRuntimeConfig(selectedCfg);
      const plugin = resolveOutboundChannelPlugin({ channel, cfg });
      const canonicalAction =
        ((request.action === "send" &&
          Boolean(plugin?.message?.send?.text || plugin?.outbound?.sendText)) ||
          (request.action === "poll" && Boolean(plugin?.outbound?.sendPoll))) &&
        (!plugin?.actions?.handleAction ||
          plugin.actions.supportsAction?.({ action: request.action }) === false);
      if (!plugin || (!plugin.actions?.handleAction && !canonicalAction)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Channel ${channel} does not support action ${request.action}.`,
          ),
        );
        return undefined;
      }
      return { cfg, channel, plugin, canonicalAction };
    },
    work: async ({ cfg, channel, plugin, canonicalAction, accountId, dedupeKey, authorize }) => {
      try {
        return await withChannelReadAuthority(
          request.action === "download-file" || messageAuthority.assertReadCurrent
            ? assertDirectAdapterHandoff
            : undefined,
          async () => {
            const sessionKey = normalizeOptionalString(request.sessionKey);
            const requestedAgentId =
              normalizeOptionalString(request.agentId) ?? trustedContext.runtimeAgentId;
            const sessionOwner = sessionKey
              ? resolveRequestedSessionAgentId(cfg, sessionKey, requestedAgentId)
              : undefined;
            if (sessionOwner && !sessionOwner.ok) {
              return { ok: false, error: sessionOwner.error, meta: { channel } };
            }
            const agentId = sessionOwner?.agentId ?? requestedAgentId;
            const sourceReplySessionKey = trustedContext.sourceReplySessionKey;
            const sourceReplyOwner = sourceReplySessionKey
              ? resolveRequestedSessionAgentId(cfg, sourceReplySessionKey, agentId)
              : undefined;
            if (sourceReplyOwner && !sourceReplyOwner.ok) {
              return { ok: false, error: sourceReplyOwner.error, meta: { channel } };
            }
            // Default-agent resolution may fail, so role-free sends must not enter this policy path.
            if (request.action === "send" && cfg.gateway?.roles) {
              const actionAgent =
                agentId ?? sourceReplyOwner?.agentId ?? resolveRequestedSessionAgentId(cfg, "main");
              if (typeof actionAgent !== "string" && !actionAgent.ok) {
                return { ok: false, error: actionAgent.error, meta: { channel } };
              }
              const actionAgentId =
                typeof actionAgent === "string" ? actionAgent : actionAgent.agentId;
              const agentAccessError = authorizeGatewaySessionCreation({
                cfg,
                client,
                agentId: actionAgentId,
              });
              if (agentAccessError) {
                return { ok: false, error: agentAccessError, meta: { channel } };
              }
            }
            if (accountId) {
              request.params.accountId = accountId;
            }
            if (
              canonicalAction &&
              request.action === "send" &&
              !normalizeOptionalString(request.params.target) &&
              !actionHasTarget("send", request.params, {
                channel,
                aliasSpec: plugin.actions?.messageActionTargetAliases?.send ?? null,
              }) &&
              !resolveImplicitMessageActionTarget(trustedContext.toolContext)
            ) {
              // Native sends could use account defaults without a target. Resolve that
              // owner fact before core routing and source-reply receipts require it.
              const target = resolveOutboundTarget({ channel, plugin, cfg, accountId });
              if (!target.ok) {
                throw target.error;
              }
              request.params.to = target.to;
            }
            const resolvedMediaAccess = resolveAgentScopedOutboundMediaAccess({
              cfg,
              agentId,
              sessionKey,
              messageProvider: sessionKey ? undefined : channel,
              accountId: sessionKey ? (trustedContext.requesterAccountId ?? accountId) : accountId,
              requesterSenderId: trustedContext.requesterSenderId,
              requesterSenderName: trustedContext.requesterSenderName,
              requesterSenderUsername: trustedContext.requesterSenderUsername,
              requesterSenderE164: trustedContext.requesterSenderE164,
            });
            // Gateway actions receive policy-scoped roots/workspace only; the
            // originating agent turn never delegates its host reader over RPC.
            const mediaAccess = {
              localRoots: resolvedMediaAccess.localRoots,
              ...(resolvedMediaAccess.workspaceDir
                ? { workspaceDir: resolvedMediaAccess.workspaceDir }
                : {}),
            };
            if (request.action === "send") {
              await hydrateAttachmentParamsForAction({
                cfg,
                channel,
                accountId,
                args: request.params,
                action: "send",
                assertClientUploadAllowed,
                mediaPolicy: resolveAttachmentMediaPolicy({
                  mediaAccess: resolvedMediaAccess,
                }),
              });
            }
            const sourceReplyMirror = {
              action: request.action,
              channel,
              actionParams: request.params,
              cfg,
              accountId,
              currentAccountId: trustedContext.requesterAccountId,
              sessionKey: sourceReplySessionKey ?? sessionKey,
              sessionId: trustedContext.sessionId,
              agentId,
              toolContext: trustedContext.toolContext,
              replyToIsExplicit: request.reply?.source === "explicit",
              idempotencyKey: request.idempotencyKey,
              toolCallId: trustedContext.sourceReplyToolCallId,
              ...(trustedContext.sourceReplyFinal !== undefined
                ? { sourceReplyFinal: trustedContext.sourceReplyFinal }
                : {}),
            };
            const terminalDeliveryStart =
              trustedContext.sourceReplyFinal === true
                ? await beginTerminalSourceReplyDelivery(sourceReplyMirror)
                : undefined;
            if (terminalDeliveryStart && "outcome" in terminalDeliveryStart) {
              return createGatewayInflightSuccess({
                context,
                dedupeKey,
                payload: terminalDeliveryStart.result,
                channel,
              });
            }
            const terminalDeliveryReceipt = terminalDeliveryStart;
            // Attachment and receipt preparation can outlive the admitted run.
            // Close the receipt and stop before the provider-owned action boundary.
            if (!authorize()) {
              await cancelTerminalSourceReplyDelivery(terminalDeliveryReceipt);
              return createGatewayInflightAuthorityFailure({ context, dedupeKey, channel });
            }
            const gatewayClientScopes = client?.connect?.scopes ?? [];
            const inboundEventKind: "room_event" | "user_request" =
              request.inboundTurnKind === "room_event" ? "room_event" : "user_request";
            const actionContext = {
              channel,
              action: request.action,
              cfg,
              params: request.params,
              reply: request.reply,
              accountId,
              // Only the model's message tool mints an agent-runtime turn context, and
              // it resends proven-not-sent failures itself, so its gateway-owned plugin
              // delivery must not also stay replayable (#124279). Operator, CLI, and
              // external RPC clients carry none and keep recovery's replay (#100979).
              deliveryRetryOwner: trustedContext.runtimeAgentId ? ("caller" as const) : undefined,
              ...selectMessageActionRequesterIdentity(trustedContext),
              senderIsOwner: gatewayClientScopes.includes(ADMIN_SCOPE)
                ? request.senderIsOwner === true
                : false,
              conversationReadOrigin,
              sessionKey,
              sessionId: normalizeOptionalString(request.sessionId),
              inboundEventKind,
              agentId,
              mediaAccess,
              mediaLocalRoots: mediaAccess.localRoots,
              toolContext: downstreamToolContext,
              dryRun: false,
              messageActionAuthorization: downstreamMessageActionAuthorization,
              gatewayClientScopes,
              assertDirectAdapterHandoff,
              onPlatformSendDispatch,
              // Model-authored sends own proven-not-sent retries; every scheduled
              // generic delivery must also stay inside its admitted job lifetime.
              skipQueue:
                client?.internal?.agentRuntimeIdentity !== undefined &&
                (request.action === "send" ||
                  Boolean(trustedContext.messageActionAuthorization?.scheduled)),
            };
            const settleTerminalDelivery = async (
              deliveredPayload: unknown,
              mirrorTranscript = true,
            ) => {
              try {
                await reconcileTerminalSourceReplyDelivery({
                  deliveredPayload,
                  mirror: sourceReplyMirror,
                  receipt: terminalDeliveryReceipt,
                });
              } catch (err) {
                // The pre-send intent remains durable. Return the provider result so
                // the model does not retry an external effect with an unknown outcome.
                context.logGateway?.warn?.("Terminal source reply receipt reconciliation failed.", {
                  error: formatForLog(err),
                  channel,
                  sessionKey,
                });
              }
              if (mirrorTranscript) {
                await scheduleDeliveredSourceReplyTranscriptMirror({
                  context,
                  mirror: {
                    ...sourceReplyMirror,
                    deliveredPayload,
                  },
                });
              }
            };
            let payload: unknown;
            try {
              if (canonicalAction || messageAuthority.assertScheduledWriteCurrent) {
                const action = CHANNEL_MESSAGE_ACTION_NAMES.find((name) => name === request.action);
                if (!action) {
                  throw new Error(`Unsupported canonical message action: ${request.action}`);
                }
                const { runMessageAction } =
                  await import("../../../infra/outbound/message-action-runner.js");
                const result = await runMessageAction({
                  ...actionContext,
                  action,
                  gatewayOwnedDelivery: true,
                  ...(request.action === "send"
                    ? {
                        // This RPC owns source-reply receipts and their transcript mirror.
                        suppressTranscriptMirror: true,
                        actionOrigin: trustedContext.runtimeAgentId
                          ? ("message-tool" as const)
                          : undefined,
                      }
                    : {}),
                  params: {
                    ...request.params,
                    channel,
                    ...(accountId ? { accountId } : {}),
                    idempotencyKey: request.idempotencyKey,
                  },
                });
                payload = result.payload;
              } else {
                await messageAuthority.beforeDeliveryAttempt();
                assertDirectAdapterHandoff?.();
                const handled = await dispatchChannelMessageAction(actionContext);
                if (handled) {
                  payload = extractToolPayload(handled);
                } else {
                  await cancelTerminalSourceReplyDelivery(terminalDeliveryReceipt);
                  const error = errorShape(
                    ErrorCodes.INVALID_REQUEST,
                    `Message action ${request.action} not supported for channel ${channel}.`,
                  );
                  return createGatewayInflightResult({
                    context,
                    dedupeKey,
                    channel,
                    result: { ok: false, error },
                  });
                }
              }
            } catch (err) {
              if (isChannelPartialDeliveryError(err)) {
                // Accepted delivery evidence settles the terminal receipt, but it
                // cannot prove which requested parts should enter the transcript.
                await settleTerminalDelivery(err.deliveryResult, false);
              }
              throw err;
            }
            await settleTerminalDelivery(payload);
            // A downloaded artifact is not cacheable until the enclosing read
            // has accepted its provider/caller lifetime and resource identity.
            return request.action === "download-file"
              ? { ok: true, payload, meta: { channel } }
              : createGatewayInflightSuccess({ context, dedupeKey, payload, channel });
          },
          undefined,
          (result) => {
            if (request.action === "download-file" && result.ok) {
              createGatewayInflightSuccess({
                context,
                dedupeKey,
                payload: result.payload,
                channel,
              });
            }
          },
        );
      } catch (err) {
        if (!isChannelPartialDeliveryError(err) && !authorize()) {
          return createGatewayInflightAuthorityFailure({ context, dedupeKey, channel });
        }
        return createGatewayInflightUnavailableFailure({ context, dedupeKey, channel, err });
      }
    },
  });
};
