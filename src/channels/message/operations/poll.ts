import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validatePollParams,
} from "../../../../packages/gateway-protocol/src/index.js";
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
import { resolveOutboundChannelPlugin } from "../../../infra/outbound/channel-resolution.js";
import { normalizePollInput } from "../../../polls.js";
import { isChannelPartialDeliveryError } from "../../turn/partial-delivery-error.js";

export const pollOperation: GatewayRequestHandler = async ({
  params: request,
  respond,
  context,
  client,
  sessionMutationCommitGuard,
}) => {
  if (!assertValidParams(request, validatePollParams, "poll", respond)) {
    return;
  }
  const messageAuthority = createMessageActionRuntimeAuthority({
    client,
    context,
    respond,
    sessionMutationCommitGuard,
    request: { action: "poll", accountId: request.accountId, params: {} },
    authorization: resolveAgentRuntimeMessageActionAuthorization(client),
  });
  const messageActionConfig = resolveAgentRuntimeMessageActionConfig(client);
  const agentRuntimeAuthority = messageAuthority.agentRuntimeAuthority;
  const hasAgentRuntimeAuthority = client?.internal?.agentRuntimeIdentity !== undefined;
  const commitAgentRuntimeAuthority = messageAuthority.assertDirectAdapterHandoff;
  const onPlatformSendDispatch = messageAuthority.onPlatformSendDispatch;
  await withMessageOperationRoute({
    context,
    prefix: "poll",
    idempotencyKey: request.idempotencyKey,
    respond,
    requestChannel: request.channel,
    bindingAccountIds: [request.accountId],
    routeAccountIds: (binding) => [request.accountId, binding?.reservedRoute?.accountId],
    conflictMessage: "poll account selections do not match",
    authorize: agentRuntimeAuthority.hasActive,
    resolveChannel: async (requestChannel) => {
      const resolved = await resolveRequestedChannel({
        requestChannel,
        unsupportedMessage: (input) => `unsupported poll channel: ${input}`,
        context,
        config: messageActionConfig,
      });
      if ("error" in resolved) {
        respond(false, undefined, resolved.error);
        return undefined;
      }
      const { cfg, channel } = resolved;
      const plugin = resolveOutboundChannelPlugin({ channel, cfg });
      const outbound = plugin?.outbound;
      if (
        typeof request.durationSeconds === "number" &&
        outbound?.supportsPollDurationSeconds !== true
      ) {
        // Duration support is channel-specific; reject before normalizing to avoid silent truncation.
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `durationSeconds is not supported for ${channel} polls`,
          ),
        );
        return undefined;
      }
      if (typeof request.isAnonymous === "boolean" && outbound?.supportsAnonymousPolls !== true) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `isAnonymous is not supported for ${channel} polls`,
          ),
        );
        return undefined;
      }
      if (!plugin || !outbound?.sendPoll) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unsupported poll channel: ${channel}`),
        );
        return undefined;
      }
      return { cfg, channel, plugin, outbound, sendPoll: outbound.sendPoll };
    },
    work: async ({ cfg, channel, accountId, idem, dedupeKey, authorize, outbound, sendPoll }) => {
      const poll = {
        question: request.question,
        options: request.options,
        maxSelections: request.maxSelections,
        durationSeconds: request.durationSeconds,
        durationHours: request.durationHours,
      };
      const threadId = normalizeOptionalString(request.threadId);
      try {
        const resolvedTarget = resolveGatewayOutboundTarget({
          channel,
          to: request.to.trim(),
          cfg,
          accountId,
        });
        if (!resolvedTarget.ok) {
          return { ok: false, error: resolvedTarget.error };
        }
        const normalized = outbound.pollMaxOptions
          ? normalizePollInput(poll, { maxOptions: outbound.pollMaxOptions })
          : normalizePollInput(poll);
        if (!authorize()) {
          return createGatewayInflightAuthorityFailure({ context, dedupeKey, channel });
        }
        await messageAuthority.beforeDeliveryAttempt();
        commitAgentRuntimeAuthority?.();
        const result = await sendPoll({
          cfg,
          to: resolvedTarget.to,
          poll: normalized,
          accountId,
          threadId,
          silent: request.silent,
          isAnonymous: request.isAnonymous,
          gatewayClientScopes: client?.connect?.scopes ?? [],
          onPlatformSendDispatch,
          assertDirectAdapterHandoff: commitAgentRuntimeAuthority,
        });
        const payload = buildGatewayDeliveryPayload({ runId: idem, channel, result });
        return createGatewayInflightSuccess({ context, dedupeKey, payload, channel });
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
