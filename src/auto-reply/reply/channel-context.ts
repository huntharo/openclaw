/** Resolves channel and account context for command handlers. */
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { ChannelPresentationCapabilities } from "../../channels/plugins/outbound.types.js";
import { getLoadedChannelPluginById } from "../../channels/plugins/registry-loaded.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

type CommandSurfaceParams = {
  ctx: {
    OriginatingChannel?: string;
    Surface?: string;
    Provider?: string;
    AccountId?: string;
  };
  command: {
    channel?: string;
  };
};

type ChannelAccountParams = CommandSurfaceParams & {
  cfg: OpenClawConfig;
};

/** Resolves the command surface channel from inbound context and command state. */
export function resolveCommandSurfaceChannel(params: CommandSurfaceParams): string {
  const channel =
    params.ctx.OriginatingChannel ??
    params.command.channel ??
    params.ctx.Surface ??
    params.ctx.Provider;
  return normalizeOptionalLowercaseString(channel) ?? "";
}

/** Resolves command account id, falling back to plugin default account config. */
export function resolveChannelAccountId(params: ChannelAccountParams): string {
  const accountId = normalizeOptionalString(params.ctx.AccountId) ?? "";
  if (accountId) {
    return accountId;
  }
  const channel = resolveCommandSurfaceChannel(params);
  const plugin = getLoadedChannelPluginById(channel);
  const configuredDefault = normalizeOptionalString(plugin?.config.defaultAccountId?.(params.cfg));
  return configuredDefault || "default";
}

/** Producers consume the outbound owner's effective account capabilities, not a second declaration. */
export function resolveCommandPresentationCapabilities(params: {
  cfg: OpenClawConfig;
  surface?: string;
  accountId?: string;
}): ChannelPresentationCapabilities | undefined {
  const plugin = params.surface ? getLoadedChannelPluginById(params.surface) : undefined;
  const outbound = plugin?.outbound;
  return outbound?.resolvePresentationCapabilities
    ? outbound.resolvePresentationCapabilities({
        cfg: params.cfg,
        accountId: resolveChannelAccountId({
          cfg: params.cfg,
          ctx: { Surface: params.surface, AccountId: params.accountId },
          command: {},
        }),
      })
    : outbound?.presentationCapabilities;
}
