import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeArrayBackedTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  ErrorCodes,
  errorShape,
  validateSendParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { createOutboundSendDeps } from "../../../cli/deps.js";
import { readInProcessSessionDeliveryGeneration } from "../../../gateway/in-process-session-delivery.js";
import {
  authorizeGatewaySessionCreation,
  resolveSandboxedSessionCreation,
} from "../../../gateway/operator-role-policy.js";
import {
  createMessageActionRuntimeAuthority,
  resolveAgentRuntimeMessageActionAuthorization,
  resolveAgentRuntimeMessageActionConfig,
} from "../../../gateway/server-methods/message-action-context.js";
import {
  buildGatewayDeliveryPayload,
  createGatewayInflightAuthorityFailure,
  createGatewayInflightSuccess,
  createGatewayInflightUnavailableFailure,
} from "../../../gateway/server-methods/message-operation-result.js";
import { withMessageOperationRoute } from "../../../gateway/server-methods/message-operation-route.js";
import {
  resolveGatewayOutboundTarget,
  resolveRequestedChannel,
} from "../../../gateway/server-methods/send-channel-resolution.js";
import type { GatewayRequestHandler } from "../../../gateway/server-methods/types.js";
import { assertValidParams } from "../../../gateway/server-methods/validation.js";
import { resolveRequestedSessionAgentId } from "../../../gateway/session-request-agent.js";
import { loadSessionEntry } from "../../../gateway/session-utils.js";
import { captureGatewayClientUploadCommitGuard } from "../../../gateway/upload-policy.js";
import { resolveOutboundChannelPlugin } from "../../../infra/outbound/channel-resolution.js";
import {
  hydrateAttachmentParamsForAction,
  resolveAttachmentMediaPolicy,
} from "../../../infra/outbound/message-action-params.js";
import {
  ensureOutboundSessionEntry,
  resolveOutboundSessionRoute,
} from "../../../infra/outbound/outbound-session.js";
import {
  createOutboundPayloadPlan,
  projectOutboundPayloadPlanForMirror,
} from "../../../infra/outbound/payloads.js";
import { buildOutboundSessionContext } from "../../../infra/outbound/session-context.js";
import { maybeResolveIdLikeTarget } from "../../../infra/outbound/target-resolver.js";
import { getAgentScopedMediaLocalRoots } from "../../../media/local-roots.js";
import {
  isAgentHarnessSessionKey,
  resolveMissingAgentHarnessSessionError,
} from "../../../sessions/agent-harness-session-key.js";
import {
  normalizeSessionKeyPreservingOpaquePeerIds,
  parseThreadSessionSuffix,
} from "../../../sessions/session-key-utils.js";
import { withChannelReadAuthority } from "../../../shared/channel-read-authority.js";
import { resolveChannelThreadAddressing } from "../../thread-addressing.js";
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "../../turn/partial-delivery-error.js";
import { sendDurableMessageBatchCore } from "../runtime.js";

export const sendOperation: GatewayRequestHandler = async ({
  params: request,
  respond,
  context,
  client,
  sessionMutationCommitGuard,
}) => {
  if (!assertValidParams(request, validateSendParams, "send", respond)) {
    return;
  }
  const assertClientUploadAllowed = captureGatewayClientUploadCommitGuard({
    method: "send",
    requestParams: request,
    client,
    context,
  });
  const sessionGeneration = readInProcessSessionDeliveryGeneration(request);
  const to = normalizeOptionalString(request.to) ?? "";
  const message = request.message?.trim() ? request.message : "";
  const mediaUrl = normalizeOptionalString(request.mediaUrl);
  const mediaUrls = normalizeArrayBackedTrimmedStringList(request.mediaUrls);
  const buffer = readStringValue(request.buffer);
  if (!message && !mediaUrl && (mediaUrls?.length ?? 0) === 0 && !buffer) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "invalid send params: text or media is required"),
    );
    return;
  }
  const requestedAccountId = normalizeOptionalString(request.accountId);
  const replyToId = normalizeOptionalString(request.replyToId);
  const threadId = normalizeOptionalString(request.threadId);
  const messageActionAuthorization = resolveAgentRuntimeMessageActionAuthorization(client);
  const messageActionConfig = resolveAgentRuntimeMessageActionConfig(client);
  const messageAuthority = createMessageActionRuntimeAuthority({
    client,
    context,
    respond,
    sessionMutationCommitGuard,
    request: { action: "send", accountId: request.accountId, params: {} },
    authorization: messageActionAuthorization,
    assertClientUploadAllowed,
  });
  const agentRuntimeAuthority = messageAuthority.agentRuntimeAuthority;
  const hasAgentRuntimeAuthority = client?.internal?.agentRuntimeIdentity !== undefined;
  const commitAgentRuntimeAuthority = messageAuthority.assertDirectAdapterHandoff;
  const onPlatformSendDispatch = messageAuthority.onPlatformSendDispatch;
  await withMessageOperationRoute({
    context,
    prefix: "send",
    idempotencyKey: request.idempotencyKey,
    respond,
    requestChannel: request.channel,
    bindingAccountIds: [request.accountId],
    routeAccountIds: (binding) => [requestedAccountId, binding?.reservedRoute?.accountId],
    conflictMessage: "send account selections do not match",
    authorize: agentRuntimeAuthority.hasActive,
    assertNewInputAllowed: assertClientUploadAllowed,
    resolveChannel: async (requestChannel) => {
      const resolved = await resolveRequestedChannel({
        requestChannel,
        unsupportedMessage: (input) => `unsupported channel: ${input}`,
        context,
        config: messageActionConfig,
        rejectWebchatAsInternalOnly: true,
      });
      if ("error" in resolved) {
        respond(false, undefined, resolved.error, undefined);
        return undefined;
      }
      const { cfg, channel } = resolved;
      const plugin = resolveOutboundChannelPlugin({ channel, cfg });
      if (!plugin) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unsupported channel: ${channel}`),
        );
        return undefined;
      }
      return { cfg, channel, plugin };
    },
    work: async ({ cfg, channel, accountId, idem, dedupeKey, authorize }) => {
      try {
        const resolvedTarget = resolveGatewayOutboundTarget({
          channel,
          to,
          cfg,
          accountId,
        });
        if (!resolvedTarget.ok) {
          return {
            ok: false,
            error: resolvedTarget.error,
            meta: { channel },
          };
        }
        const idLikeTarget = await withChannelReadAuthority(
          messageActionAuthorization?.scheduled ? commitAgentRuntimeAuthority : undefined,
          () =>
            maybeResolveIdLikeTarget({
              cfg,
              channel,
              input: resolvedTarget.to,
              accountId,
            }),
        );
        const deliveryTarget = idLikeTarget?.to ?? resolvedTarget.to;
        // Preserve opaque, case-sensitive peer IDs (e.g. Matrix room ids) on an
        // explicit session key instead of raw-lowercasing it (openclaw#75670).
        // Non-enrolled channels still canonicalize to lowercase via the registry.
        const providedSessionKey =
          normalizeSessionKeyPreservingOpaquePeerIds(request.sessionKey) || undefined;
        const explicitAgentId = normalizeOptionalString(request.agentId);
        const sessionOwner = providedSessionKey
          ? resolveRequestedSessionAgentId(cfg, providedSessionKey, explicitAgentId)
          : undefined;
        if (sessionOwner && !sessionOwner.ok) {
          return { ok: false, error: sessionOwner.error, meta: { channel } };
        }
        const sessionAgentId = sessionOwner?.agentId;
        const implicitAgent =
          !explicitAgentId && !sessionAgentId
            ? resolveRequestedSessionAgentId(cfg, "main")
            : undefined;
        if (implicitAgent && !implicitAgent.ok) {
          return { ok: false, error: implicitAgent.error, meta: { channel } };
        }
        const effectiveAgentId =
          explicitAgentId ?? sessionAgentId ?? (implicitAgent?.ok ? implicitAgent.agentId : null);
        if (!effectiveAgentId) {
          return {
            ok: false,
            error: errorShape(ErrorCodes.INVALID_REQUEST, "agent selection is required"),
            meta: { channel },
          };
        }
        const sendArgs: Record<string, unknown> = {
          mediaUrl,
          mediaUrls,
          buffer,
          filename: normalizeOptionalString(request.filename),
          contentType: normalizeOptionalString(request.contentType),
        };
        await hydrateAttachmentParamsForAction({
          cfg,
          channel,
          accountId,
          args: sendArgs,
          action: "send",
          assertClientUploadAllowed,
          mediaPolicy: resolveAttachmentMediaPolicy({
            mediaLocalRoots: getAgentScopedMediaLocalRoots(cfg, effectiveAgentId),
          }),
        });
        const hydratedMediaUrl = normalizeOptionalString(sendArgs.mediaUrl);
        const hydratedMediaUrls = normalizeArrayBackedTrimmedStringList(sendArgs.mediaUrls);
        const outboundDeps = context.deps ? createOutboundSendDeps(context.deps) : undefined;
        const outboundPayloads = [
          {
            text: message,
            mediaUrl: hydratedMediaUrl,
            mediaUrls: hydratedMediaUrls,
            ...(request.asVoice === true ? { audioAsVoice: true } : {}),
          },
        ];
        const outboundPayloadPlan = createOutboundPayloadPlan(outboundPayloads);
        const { text: mirrorText, mediaUrls: mirrorMediaUrls } =
          projectOutboundPayloadPlanForMirror(outboundPayloadPlan);
        const derivedRoute = await resolveOutboundSessionRoute({
          cfg,
          channel,
          agentId: effectiveAgentId,
          accountId,
          target: deliveryTarget,
          currentSessionKey: providedSessionKey,
          resolvedTarget: idLikeTarget,
          replyToId,
          threadId,
        });
        const providedSessionBaseKey =
          parseThreadSessionSuffix(providedSessionKey).baseSessionKey ?? providedSessionKey;
        const shouldUseDerivedThreadSessionKey =
          resolveChannelThreadAddressing(channel) === "message" &&
          Boolean(providedSessionKey) &&
          Boolean(normalizeOptionalString(derivedRoute?.threadId)) &&
          normalizeOptionalLowercaseString(derivedRoute?.baseSessionKey) ===
            normalizeOptionalLowercaseString(providedSessionBaseKey) &&
          normalizeOptionalLowercaseString(derivedRoute?.sessionKey) !== providedSessionKey;
        // Message-scoped threads can refine an existing base session only after target lookup.
        const outboundRoute = derivedRoute
          ? providedSessionKey
            ? shouldUseDerivedThreadSessionKey
              ? {
                  ...derivedRoute,
                  baseSessionKey: derivedRoute.baseSessionKey ?? providedSessionKey,
                }
              : {
                  ...derivedRoute,
                  sessionKey: providedSessionKey,
                  baseSessionKey: providedSessionKey,
                }
            : derivedRoute
          : null;
        const outboundSessionKey = outboundRoute?.sessionKey ?? providedSessionKey;
        if (outboundSessionKey) {
          const agentAccessError = authorizeGatewaySessionCreation({
            cfg,
            client,
            agentId: effectiveAgentId,
          });
          if (agentAccessError) {
            return { ok: false, error: agentAccessError, meta: { channel } };
          }
        }
        if (outboundSessionKey && isAgentHarnessSessionKey(outboundSessionKey)) {
          const { canonicalKey, entry } = loadSessionEntry(outboundSessionKey);
          const missingHarnessSessionError = resolveMissingAgentHarnessSessionError(
            canonicalKey,
            entry,
          );
          if (missingHarnessSessionError) {
            return {
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, missingHarnessSessionError),
              meta: { channel },
            };
          }
        }
        // Durable route/session persistence commits only after platform
        // evidence: a failed send must not rebind the folded main session's
        // delivery route. Once-only across multi-payload results, and before
        // the in-delivery transcript mirror so first contacts have a row.
        let outboundRoutePersisted = false;
        const commitOutboundSessionRoute = async () => {
          if (outboundRoutePersisted || !outboundRoute) {
            return;
          }
          outboundRoutePersisted = true;
          await ensureOutboundSessionEntry({
            cfg,
            channel,
            accountId,
            route: outboundRoute,
            creation: resolveSandboxedSessionCreation(client, cfg),
            sourceSessionKey: client?.internal?.agentRuntimeIdentity?.sessionKey,
          });
        };
        const outboundSession = buildOutboundSessionContext({
          cfg,
          agentId: effectiveAgentId,
          sessionKey: outboundSessionKey,
          conversationType: outboundRoute?.chatType,
        });
        // Target, attachment, route, and session preparation may all yield.
        // The durable provider handoff is the final authority commit point.
        if (!authorize()) {
          return createGatewayInflightAuthorityFailure({ context, dedupeKey, channel });
        }
        await messageAuthority.beforeDeliveryAttempt();
        commitAgentRuntimeAuthority?.();
        const send = await sendDurableMessageBatchCore(
          {
            cfg,
            channel,
            to: deliveryTarget,
            accountId,
            payloads: outboundPayloads,
            replyToId: replyToId ?? null,
            session: outboundSession,
            gifPlayback: request.gifPlayback,
            forceDocument: request.forceDocument,
            threadId: outboundRoute?.threadId ?? threadId ?? null,
            deps: outboundDeps,
            gatewayClientScopes: client?.connect?.scopes ?? [],
            silent: request.silent,
            formatting: request.parseMode ? { parseMode: request.parseMode } : undefined,
            ...(sessionGeneration
              ? {
                  deliveryIntentId: idem,
                  reusePendingDeliveryIntent: true,
                  durability: "required" as const,
                }
              : {}),
            onDeliveryResult: commitOutboundSessionRoute,
            // Runtime-bound sends cannot outlive their operational run. Keep
            // recovery from replaying them after the live authority closes.
            onPlatformSendDispatch,
            assertDirectAdapterHandoff: commitAgentRuntimeAuthority,
            skipQueue: hasAgentRuntimeAuthority,
            mirror: outboundSessionKey
              ? {
                  sessionKey: outboundSessionKey,
                  agentId: effectiveAgentId,
                  text: mirrorText || message,
                  mediaUrls: mirrorMediaUrls.length > 0 ? mirrorMediaUrls : undefined,
                  idempotencyKey: idem,
                }
              : undefined,
          },
          undefined,
          undefined,
          sessionGeneration,
        );
        // Safety net for adapters whose results carry no platform identity:
        // any partially or fully sent batch still binds the route.
        if (send.status === "sent" || send.status === "partial_failed") {
          await commitOutboundSessionRoute();
        }
        if (send.status === "failed") {
          throw send.error;
        }
        if (send.status === "partial_failed") {
          throw createChannelPartialDeliveryError(send.error, {
            messageIds: send.results.map((result) => result.messageId),
            receipt: send.receipt,
            visibleReplySent: true,
          });
        }
        const results = send.status === "sent" ? send.results : [];

        const result = results.at(-1);
        if (!result) {
          throw new Error("No delivery result");
        }
        const payload = buildGatewayDeliveryPayload({ runId: idem, channel, result });
        return createGatewayInflightSuccess({
          context,
          dedupeKey,
          payload,
          channel,
        });
      } catch (err) {
        if (
          !isChannelPartialDeliveryError(err) &&
          hasAgentRuntimeAuthority &&
          !agentRuntimeAuthority.hasActive()
        ) {
          return createGatewayInflightAuthorityFailure({ context, dedupeKey, channel });
        }
        return createGatewayInflightUnavailableFailure({ context, dedupeKey, channel, err });
      }
    },
  });
};
