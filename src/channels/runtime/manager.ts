import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { resolveChannelDefaultAccountId } from "../plugins/helpers.js";
import {
  getLoadedChannelPluginEntryById,
  listLoadedChannelPluginsForRegistry,
} from "../plugins/registry-loaded.js";
import type { ChannelId } from "../plugins/types.public.js";
import { createChannelSnapshotReader } from "./snapshot.js";
import type { StartChannelOptions } from "./snapshot.types.js";
import { pauseChannelStarts } from "./start-fence.js";
import { createChannelStarter } from "./start.js";
import { createChannelRuntimeState } from "./state.js";
import { createChannelStopper } from "./stop.js";
import type { ChannelManagerOptions, ChannelManager } from "./types.js";
export type { ChannelManager, ChannelAutostartSuppression } from "./types.js";
const CHANNEL_STARTUP_CONCURRENCY = 4;
export function createChannelManager(opts: ChannelManagerOptions): ChannelManager & {
  pruneInactiveChannelAccountState: (activeChannelIds: ReadonlySet<ChannelId>) => void;
  resolveRuntimeAccountId: (channelId: ChannelId, accountId: string) => string | undefined;
  hasCurrentAccountTask: (channelId: ChannelId, accountId: string) => boolean;
} {
  const state = createChannelRuntimeState(opts);
  const {
    getRuntimeConfig,
    getPluginRegistry,
    startupTrace,
    withRegistry,
    getChannelPlugin,
    channelStores,
    restarts,
    manuallyStopped,
    pendingAutoRestarts,
    restartKey,
    releaseChannelRouteHandoffs,
    ensureChannelLog,
    isHealthMonitorEnabled,
    getStore,
    getRuntime,
    setStoppedRuntime,
    measureStartup,
    pruneInactiveChannelAccountState,
  } = state;
  const startChannelInternal = createChannelStarter(state);
  const stopChannel = createChannelStopper(state);
  const { captureChannelSnapshot, getRuntimeSnapshot } = createChannelSnapshotReader(state);
  const startChannelsWithOptions = async (startOptions: StartChannelOptions = {}) => {
    let releaseAccountStarts: (() => void) | undefined;
    const deferAccountStartUntil =
      opts.deferStartupAccountStartsUntil ??
      (startupTrace
        ? new Promise<void>((resolve) => {
            releaseAccountStarts = () => {
              const handle = setImmediate(resolve);
              handle.unref?.();
            };
          })
        : undefined);
    try {
      await runTasksWithConcurrency({
        limit: CHANNEL_STARTUP_CONCURRENCY,
        tasks: listLoadedChannelPluginsForRegistry(getPluginRegistry()).map(
          (plugin) => async () => {
            try {
              await measureStartup(`channels.${plugin.id}.start`, () =>
                startChannelInternal(plugin.id, undefined, {
                  ...startOptions,
                  ...(deferAccountStartUntil ? { deferAccountStartUntil } : {}),
                }),
              );
            } catch (err) {
              ensureChannelLog(plugin.id).error?.(
                `[${plugin.id}] channel startup failed: ${formatErrorMessage(err)}`,
              );
            }
          },
        ),
      });
    } finally {
      releaseAccountStarts?.();
    }
  };

  const recoverAutostartSuppression = async (): Promise<boolean> => {
    if (
      !state.autostartSuppression ||
      opts.isClosing?.() ||
      !opts.tryRecoverAutostartSuppression?.() ||
      opts.isClosing?.()
    ) {
      return false;
    }
    state.autostartSuppression = null;
    // Recovery resumes the autostart attempt that safe mode deferred. Preserve
    // explicit operator stops while still covering health-monitor opt-outs.
    await startChannelsWithOptions({ preserveManualStop: true });
    return true;
  };

  const markChannelLoggedOut = (channelId: ChannelId, cleared: boolean, accountId?: string) => {
    const plugin = getChannelPlugin(channelId);
    if (!plugin) {
      return;
    }
    const resolvedId =
      accountId ?? resolveChannelDefaultAccountId({ plugin, cfg: getRuntimeConfig() });
    const store = getStore(channelId);
    // A manual start can overtake logout while its credential hook settles.
    if (store.starting.has(resolvedId) || store.tasks.has(resolvedId)) {
      return;
    }
    const current = getRuntime(channelId, resolvedId);
    setStoppedRuntime(channelId, resolvedId, {
      ...(cleared ? { linked: false } : {}),
      restartPending: false,
      lastError: cleared ? "logged out" : current.lastError,
    });
  };

  return {
    getRuntimeSnapshot,
    pauseChannelStarts: (channelIds) =>
      pauseChannelStarts(channelIds, getStore, (channelId) => {
        const plugin = getChannelPlugin(channelId);
        return plugin ? captureChannelSnapshot(plugin) : undefined;
      }),
    startChannels: () => startChannelsWithOptions(),
    startChannel: startChannelInternal,
    stopChannel,
    releaseChannelRouteHandoffs,
    pruneInactiveChannelAccountState,
    setAutostartSuppression: (suppression) => {
      state.autostartSuppression = suppression;
    },
    getAutostartSuppression: () => state.autostartSuppression,
    recoverAutostartSuppression,
    setAmbientAutostartSuppressedChannelIds: (channelIds) => {
      state.ambientAutostartSuppressedChannelIds = new Set(channelIds);
    },
    isAmbientAutostartSuppressed: (channelId) =>
      state.ambientAutostartSuppressedChannelIds.has(channelId),
    markChannelLoggedOut,
    isManuallyStopped: (channelId, accountId) =>
      manuallyStopped.has(restartKey(channelId, accountId)),
    hasCurrentAccountTask: (channelId, accountId) => {
      const store = channelStores.get(channelId);
      const lifetime = store?.lifetimes.get(accountId);
      // A retained task slot can be an aborted predecessor or supervised backoff.
      return Boolean(
        store &&
        lifetime &&
        store.tasks.has(accountId) &&
        !store.stops.has(accountId) &&
        !lifetime.abort.signal.aborted &&
        lifetime.capabilityLease.isActive() &&
        lifetime.plugin === getChannelPlugin(channelId),
      );
    },
    isAccountListed: (channelId, accountId) => {
      const fence = channelStores.get(channelId)?.startFence;
      // Failed reloads retain diagnostic facts without calling unavailable plugin code.
      return fence && fence.state !== "published"
        ? (fence.snapshot?.listedAccountIds.has(accountId) ?? false)
        : withRegistry(
            (registry) =>
              getLoadedChannelPluginEntryById(channelId, registry)
                ?.plugin.config.listAccountIds(getRuntimeConfig())
                .includes(accountId) ?? false,
          );
    },
    resolveRuntimeAccountId: (channelId, accountId) => {
      const matches = [...(channelStores.get(channelId)?.runtimes.keys() ?? [])].filter(
        (id) => normalizeAccountId(id) === accountId,
      );
      return matches.length === 1 ? matches[0] : undefined;
    },
    isAutoRestartScheduled: (channelId, accountId) =>
      pendingAutoRestarts.has(restartKey(channelId, accountId)),
    resetRestartAttempts: (channelId, accountId) => {
      restarts.delete(restartKey(channelId, accountId));
    },
    isHealthMonitorEnabled,
  };
}
