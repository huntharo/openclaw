/** Active channel plugin registry. Provider activation belongs to the loader. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  getLoadedChannelPluginById,
  getLoadedChannelPluginEntryById,
  listLoadedChannelPlugins,
} from "./registry-loaded.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

export { normalizeAnyChannelId as normalizeChannelId } from "../registry.js";

export const listChannelPlugins = (): ChannelPlugin[] => listLoadedChannelPlugins();

/**
 * Returns a loaded channel plugin without falling back to bundled metadata.
 */
export function getLoadedChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  return getLoadedChannelPluginById(id);
}

/**
 * Resolves the active channel implementation together with host-owned provenance.
 */
export function resolveChannelPluginRegistration(id: ChannelId):
  | {
      plugin: ChannelPlugin;
      origin?: string;
      captureReadAuthority?: () => (() => boolean) | undefined;
      resolveChannelRuntime?: NonNullable<
        ReturnType<typeof getLoadedChannelPluginEntryById>
      >["resolveChannelRuntime"];
    }
  | undefined {
  const resolvedId = normalizeOptionalString(id) ?? "";
  if (!resolvedId) {
    return undefined;
  }
  // Resolve implementation and provenance together. Loaded overrides win and
  // must never borrow bundled authority from the fallback with the same id.
  const scopedRegistry = getPluginRuntimeGatewayRequestScope()?.pluginRegistry;
  const scopedEntry = scopedRegistry
    ? getLoadedChannelPluginEntryById(resolvedId, scopedRegistry)
    : undefined;
  const loadedEntry = scopedEntry ?? getLoadedChannelPluginEntryById(resolvedId);
  if (loadedEntry) {
    const origin = normalizeOptionalString(loadedEntry.origin) ?? undefined;
    return {
      plugin: loadedEntry.plugin as ChannelPlugin,
      ...(loadedEntry.resolveChannelRuntime
        ? { resolveChannelRuntime: loadedEntry.resolveChannelRuntime }
        : {}),
      ...(origin ? { origin } : {}),
      // An explicit scope cannot borrow an official grant from a root fallback.
      ...((!scopedRegistry || scopedEntry) && loadedEntry.captureReadAuthority
        ? { captureReadAuthority: loadedEntry.captureReadAuthority }
        : {}),
    };
  }
  return undefined;
}

/**
 * Returns an admitted channel implementation without loading an unregistered provider.
 */
export function getChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  return resolveChannelPluginRegistration(id)?.plugin;
}
