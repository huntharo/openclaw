import {
  type ChannelsStartParams,
  ErrorCodes,
  errorShape,
  validateChannelsStartParams,
  validateChannelsStopParams,
  validateChannelsLogoutParams,
} from "../../../../packages/gateway-protocol/src/index.js";
import { readConfigFileSnapshot } from "../../../config/config.js";
import { respondUnavailableOnThrow } from "../../../gateway/server-methods/response.js";
import { readGatewayRequestMutationAuthority } from "../../../gateway/server-methods/session-mutation-guards.js";
import type {
  GatewayRequestHandler,
  GatewayRequestHandlers,
  RespondFn,
} from "../../../gateway/server-methods/types.js";
import { assertValidParams, type Validator } from "../../../gateway/server-methods/validation.js";
import { formatForLog } from "../../../gateway/ws-log.js";
import { type ChannelId, getChannelPlugin, normalizeChannelId } from "../../plugins/index.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../../plugins/types.plugin.js";
import {
  logoutChannelAccount,
  resolveChannelGatewayAccountId,
  type ChannelAccountParams,
  resolveRuntimeAccountSnapshot,
} from "./account.js";
import { resolveDeferredChannelReloadIssue } from "./status-issues.js";

function resolveChannelOperationParams(params: {
  method: "channels.start" | "channels.stop" | "channels.logout";
  rawParams: unknown;
  respond: RespondFn;
  validate: Validator<ChannelsStartParams>;
}): { params: ChannelsStartParams; channelId: ChannelId; plugin: ChannelPlugin } | null {
  const rawParams = params.rawParams;
  if (!assertValidParams(rawParams, params.validate, params.method, params.respond)) {
    return null;
  }
  const rawChannel = rawParams.channel;
  const channelId = normalizeChannelId(rawChannel);
  if (!channelId) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `invalid ${params.method} channel`),
    );
    return null;
  }
  const plugin = getChannelPlugin(channelId);
  if (!plugin) {
    const message =
      params.method === "channels.start"
        ? `unknown channel: ${formatForLog(rawChannel)}`
        : params.method === "channels.stop"
          ? `unknown channel ${channelId}`
          : `channel ${channelId} does not support logout`;
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
    return null;
  }
  const unsupported =
    params.method === "channels.start" && !plugin.gateway?.startAccount
      ? "start"
      : params.method === "channels.logout" && !plugin.gateway?.logoutAccount
        ? "logout"
        : undefined;
  if (unsupported) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `channel ${channelId} does not support ${unsupported}`,
      ),
    );
    return null;
  }
  return { params: rawParams, channelId, plugin };
}

function channelAccountOperationHandler(
  method: "channels.start" | "channels.stop",
  validate: Validator<ChannelsStartParams>,
  run: (params: ChannelAccountParams) => Promise<unknown>,
): GatewayRequestHandler {
  return async ({ params, respond, context }) => {
    const resolved = resolveChannelOperationParams({
      method,
      rawParams: params,
      respond,
      validate,
    });
    if (!resolved) {
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      respond(
        true,
        await run({
          channelId: resolved.channelId,
          accountId: resolved.params.accountId,
          cfg: context.getRuntimeConfig(),
          context,
          plugin: resolved.plugin,
        }),
        undefined,
      );
    });
  };
}

async function changeChannelAccount(params: ChannelAccountParams, action: "start" | "stop") {
  if (action === "start" && !params.plugin.gateway?.startAccount) {
    throw new Error(`Channel ${params.channelId} does not support runtime start`);
  }
  const accountId = resolveChannelGatewayAccountId(params, () =>
    params.context.getRuntimeSnapshot({ channelId: params.channelId, inspectAccounts: false }),
  );
  const outcomes =
    action === "start"
      ? await params.context.startChannel(params.channelId, accountId, { manual: true })
      : await params.context.stopChannel(params.channelId, accountId);
  const outcome = action === "start" && outcomes ? outcomes.get(accountId) : undefined;
  if (action === "start" && !outcome) {
    throw new Error(`Channel ${params.channelId} did not report a start outcome for ${accountId}`);
  }
  const runtime = params.context.getRuntimeSnapshot({
    channelId: params.channelId,
    inspectAccounts: false,
  });
  const running =
    resolveRuntimeAccountSnapshot({ runtime, channelId: params.channelId, accountId })?.running ===
    true;
  const result = { channel: params.channelId, accountId };
  if (action === "stop") {
    return { ...result, stopped: !running };
  }
  const deferredIssue = resolveDeferredChannelReloadIssue(
    params.context,
    params.channelId,
    accountId,
  );
  return {
    ...result,
    started: running,
    outcome,
    ...(deferredIssue ? { statusIssues: [deferredIssue] } : {}),
  };
}

export const channelControlOperations = {
  "channels.start": channelAccountOperationHandler(
    "channels.start",
    validateChannelsStartParams,
    (params) => changeChannelAccount(params, "start"),
  ),
  "channels.stop": channelAccountOperationHandler(
    "channels.stop",
    validateChannelsStopParams,
    (params) => changeChannelAccount(params, "stop"),
  ),
  "channels.logout": async (invocation) => {
    const { params, respond, context } = invocation;
    const resolved = resolveChannelOperationParams({
      method: "channels.logout",
      rawParams: params,
      respond,
      validate: validateChannelsLogoutParams,
    });
    if (!resolved) {
      return;
    }
    const { params: parsedParams, channelId, plugin } = resolved;
    const accountId = parsedParams.accountId;
    const methodRegistry = context.getGatewayMethodRegistry?.();
    const requestAuthority = readGatewayRequestMutationAuthority(invocation);
    const snapshot = await readConfigFileSnapshot();
    if (!snapshot.valid) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "config invalid; fix it before logging out"),
      );
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      respond(
        true,
        await logoutChannelAccount({
          channelId,
          accountId,
          cfg: context.getRuntimeConfig(),
          context,
          plugin,
          methodRegistry,
          assertRequestCurrent: requestAuthority.assertCurrent,
        }),
        undefined,
      );
    });
  },
} satisfies GatewayRequestHandlers;
