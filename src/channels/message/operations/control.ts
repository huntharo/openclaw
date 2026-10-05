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
import type { ChannelPlugin } from "../../plugins/types.plugin.js";
import {
  logoutChannelAccount,
  resolveChannelGatewayAccountId,
  type ChannelAccountParams,
  resolveRuntimeAccountSnapshot,
} from "./account.js";
import { resolveDeferredChannelReloadIssue } from "./status-issues.js";

type ChannelOperationParams = {
  channel?: unknown;
  accountId?: unknown;
};

function resolveChannelOperationParams<TParams extends ChannelOperationParams>(params: {
  method: "channels.start" | "channels.stop" | "channels.logout";
  rawParams: unknown;
  respond: RespondFn;
  validate: Validator<TParams>;
}): { params: TParams; channelId: ChannelId; plugin: ChannelPlugin } | null {
  const rawParams = params.rawParams;
  if (!assertValidParams(rawParams, params.validate, params.method, params.respond)) {
    return null;
  }
  const rawChannel = rawParams.channel;
  const channelId = typeof rawChannel === "string" ? normalizeChannelId(rawChannel) : null;
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

async function respondWithChannelOperationPayload<TPayload>(params: {
  respond: RespondFn;
  run: () => Promise<TPayload>;
}): Promise<void> {
  await respondUnavailableOnThrow(params.respond, async () => {
    params.respond(true, await params.run(), undefined);
  });
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
    await respondWithChannelOperationPayload({
      respond,
      run: () =>
        run({
          channelId: resolved.channelId,
          accountId: resolved.params.accountId,
          cfg: context.getRuntimeConfig(),
          context,
          plugin: resolved.plugin,
        }),
    });
  };
}

async function startChannelAccount(params: ChannelAccountParams) {
  if (!params.plugin.gateway?.startAccount) {
    throw new Error(`Channel ${params.channelId} does not support runtime start`);
  }
  const resolvedAccountId = resolveChannelGatewayAccountId(params, () =>
    params.context.getRuntimeSnapshot({ channelId: params.channelId, inspectAccounts: false }),
  );
  const outcomes = await params.context.startChannel(params.channelId, resolvedAccountId, {
    manual: true,
  });
  const outcome = outcomes.get(resolvedAccountId);
  if (!outcome) {
    throw new Error(
      `Channel ${params.channelId} did not report a start outcome for ${resolvedAccountId}`,
    );
  }
  const runtime = params.context.getRuntimeSnapshot({
    channelId: params.channelId,
    inspectAccounts: false,
  });
  const started =
    resolveRuntimeAccountSnapshot({
      runtime,
      channelId: params.channelId,
      accountId: resolvedAccountId,
    })?.running === true;
  const deferredIssue = resolveDeferredChannelReloadIssue(
    params.context,
    params.channelId,
    resolvedAccountId,
  );
  return {
    channel: params.channelId,
    accountId: resolvedAccountId,
    started,
    outcome,
    ...(deferredIssue ? { statusIssues: [deferredIssue] } : {}),
  };
}

async function stopChannelAccount(params: ChannelAccountParams) {
  const resolvedAccountId = resolveChannelGatewayAccountId(params, () =>
    params.context.getRuntimeSnapshot({ channelId: params.channelId, inspectAccounts: false }),
  );
  await params.context.stopChannel(params.channelId, resolvedAccountId);
  const runtime = params.context.getRuntimeSnapshot({
    channelId: params.channelId,
    inspectAccounts: false,
  });
  const stopped =
    resolveRuntimeAccountSnapshot({
      runtime,
      channelId: params.channelId,
      accountId: resolvedAccountId,
    })?.running !== true;
  return {
    channel: params.channelId,
    accountId: resolvedAccountId,
    stopped,
  };
}

export const channelControlOperations = {
  "channels.start": channelAccountOperationHandler(
    "channels.start",
    validateChannelsStartParams,
    startChannelAccount,
  ),
  "channels.stop": channelAccountOperationHandler(
    "channels.stop",
    validateChannelsStopParams,
    stopChannelAccount,
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
    await respondWithChannelOperationPayload({
      respond,
      run: () =>
        logoutChannelAccount({
          channelId,
          accountId,
          cfg: context.getRuntimeConfig(),
          context,
          plugin,
          methodRegistry,
          assertRequestCurrent: requestAuthority.assertCurrent,
        }),
    });
  },
} satisfies GatewayRequestHandlers;
