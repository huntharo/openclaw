/** Applies manifest owner policy for plugin availability and activation decisions. */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { hasMeaningfulChannelConfig } from "../config/channel-config-activation.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveEffectivePluginActivationState,
  type NormalizedPluginsConfig,
} from "./config-state.js";
import { isPluginEnabledByDefaultForPlatform } from "./default-enablement.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { normalizePluginPolicyId } from "./plugin-policy-id.js";

type OwnerPlugin = Pick<
  PluginManifestRecord,
  "id" | "origin" | "enabledByDefault" | "enabledByDefaultOnPlatforms"
> &
  Partial<Pick<PluginManifestRecord, "channels">>;

/** Reasons a manifest owner plugin can fail the base activation policy. */
export type ManifestOwnerBasePolicyBlockReason =
  | "plugins-disabled"
  | "blocked-by-denylist"
  | "plugin-disabled"
  | "not-in-allowlist";

/** True when a manifest owner comes from a bundled plugin. */
export function isBundledManifestOwner(plugin: Pick<PluginManifestRecord, "origin">): boolean {
  return plugin.origin === "bundled";
}

/** True when config explicitly trusts a plugin as a manifest owner. */
export function hasExplicitManifestOwnerTrust(params: {
  plugin: Pick<PluginManifestRecord, "id">;
  normalizedConfig: NormalizedPluginsConfig;
}): boolean {
  const policyId = normalizePluginPolicyId(params.plugin.id);
  return (
    params.normalizedConfig.allow.includes(policyId) ||
    params.normalizedConfig.entries[policyId]?.enabled === true
  );
}

/** True when a plugin passes global enablement, allowlist, denylist, and disabled checks. */
export function passesManifestOwnerBasePolicy(params: {
  plugin: Pick<PluginManifestRecord, "id">;
  normalizedConfig: NormalizedPluginsConfig;
  allowExplicitlyDisabled?: boolean;
  allowRestrictiveAllowlistBypass?: boolean;
}): boolean {
  return resolveManifestOwnerBasePolicyBlock(params) === null;
}

/** Resolves the base policy block reason for a manifest owner plugin. */
export function resolveManifestOwnerBasePolicyBlock(params: {
  plugin: Pick<PluginManifestRecord, "id">;
  normalizedConfig: NormalizedPluginsConfig;
  allowExplicitlyDisabled?: boolean;
  allowRestrictiveAllowlistBypass?: boolean;
}): ManifestOwnerBasePolicyBlockReason | null {
  if (!params.normalizedConfig.enabled) {
    return "plugins-disabled";
  }
  const policyId = normalizePluginPolicyId(params.plugin.id);
  if (params.normalizedConfig.deny.includes(policyId)) {
    return "blocked-by-denylist";
  }
  if (
    params.normalizedConfig.entries[policyId]?.enabled === false &&
    params.allowExplicitlyDisabled !== true
  ) {
    return "plugin-disabled";
  }
  if (
    params.allowRestrictiveAllowlistBypass !== true &&
    params.normalizedConfig.allow.length > 0 &&
    !params.normalizedConfig.allow.includes(policyId)
  ) {
    return "not-in-allowlist";
  }
  return null;
}

/** Resolves whether a manifest owner plugin is effectively activated. */
export function isActivatedManifestOwner(params: {
  plugin: OwnerPlugin;
  normalizedConfig: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
}): boolean {
  return resolveEffectivePluginActivationState({
    id: params.plugin.id,
    origin: params.plugin.origin,
    channelIds: params.plugin.channels,
    config: params.normalizedConfig,
    rootConfig: params.rootConfig,
    enabledByDefault: isPluginEnabledByDefaultForPlatform(params.plugin),
  }).activated;
}

/** True when config contains meaningful enabled channel settings. */
export function hasExplicitChannelConfig(params: {
  config: OpenClawConfig;
  channelId: string;
}): boolean {
  const channels = asOptionalRecord(params.config.channels);
  const entry = asOptionalRecord(channels?.[params.channelId]);
  if (!entry) {
    return false;
  }
  const enabled = entry.enabled;
  if (enabled === false) {
    return false;
  }
  return enabled === true || hasMeaningfulChannelConfig(entry);
}

export function hasChannelPluginOwnerTrust(params: {
  plugin: OwnerPlugin;
  normalizedConfig: NormalizedPluginsConfig;
  rootConfig?: OpenClawConfig;
}): boolean {
  return params.plugin.origin === "global" || params.plugin.origin === "config"
    ? hasExplicitManifestOwnerTrust(params)
    : isActivatedManifestOwner(params);
}

export function isChannelPluginEligibleForScopedOwnership(params: {
  plugin: OwnerPlugin;
  normalizedConfig: NormalizedPluginsConfig;
  rootConfig: OpenClawConfig;
  channelId?: string;
}): boolean {
  // Explicit config can activate bundled channel owners even under restrictive allowlists.
  const allowRestrictiveAllowlistBypass =
    params.channelId !== undefined &&
    isBundledManifestOwner(params.plugin) &&
    hasExplicitChannelConfig({
      config: params.rootConfig,
      channelId: params.channelId,
    });
  if (
    !passesManifestOwnerBasePolicy({
      plugin: params.plugin,
      normalizedConfig: params.normalizedConfig,
      allowRestrictiveAllowlistBypass,
    })
  ) {
    return false;
  }
  if (isBundledManifestOwner(params.plugin)) {
    return true;
  }
  return hasChannelPluginOwnerTrust(params);
}
