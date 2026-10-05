import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { RetrySupervisor } from "../../../packages/retry/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createSubsystemLogger,
  runtimeForLogger,
  type SubsystemLogger,
} from "../../logging/subsystem.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntimeChannel } from "../../plugins/runtime/types-channel.js";
import { normalizeOptionalAccountId } from "../../routing/account-id.js";
import { resolveChannelAccountEntry } from "../../routing/account-lookup.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import type { RuntimeEnv } from "../../runtime.js";
import { clearActiveCredentialDegradedOwner } from "../../secrets/runtime-degraded-state.js";
import { getLoadedChannelPluginEntryById } from "../plugins/registry-loaded.js";
import type { ChannelGatewayContext } from "../plugins/types.adapters.js";
import type { ChannelAccountSnapshot, ChannelId } from "../plugins/types.public.js";
import type {
  ChannelRuntimeStore,
  ChannelAutostartSuppression,
  ChannelManagerOptions,
} from "./types.js";
function sanitizeAbortedTaskStatusPatch(
  patch: ChannelAccountSnapshot,
  current: ChannelAccountSnapshot,
): ChannelAccountSnapshot {
  const next = { ...patch };
  delete next.running;
  delete next.restartPending;
  delete next.reconnectAttempts;
  delete next.lastStartAt;
  delete next.lastStopAt;
  delete next.lifecycle;

  // A stale task may still emit a late "connected" heartbeat after the gateway
  // has already aborted it and marked restart recovery pending. Do not let that
  // old task make the stopped runtime look connected again.
  if (next.connected === true) {
    delete next.connected;
    delete next.lastConnectedAt;
    delete next.lastEventAt;
    delete next.lastTransportActivityAt;
  }

  // Preserve actionable lifecycle diagnostics (for example a stop-timeout
  // recovery error) against late stale-task status patches that merely clear
  // plugin transport errors.
  if (next.lastError === null && current.lastError) {
    delete next.lastError;
  }

  return next;
}

export function createChannelRuntimeState(opts: ChannelManagerOptions) {
  const {
    getRuntimeConfig,
    channelLogs,
    channelRuntimeEnvs,
    channelRuntime,
    resolveChannelRuntime,
    getPluginRegistry,
    startupTrace,
  } = opts;

  // Each operation retains its Gateway's registry; later retries select its successor.
  // Ambient request or process registries may belong to another live Gateway.
  const withRegistry = <T>(run: (registry: PluginRegistry) => T): T => {
    const registry = getPluginRegistry();
    return withPluginRuntimeRegistryScope(registry, () => run(registry));
  };
  const getChannelPlugin = (channelId: ChannelId) =>
    getLoadedChannelPluginEntryById(channelId, getPluginRegistry())?.plugin;
  const cloneDefaultRuntime = (
    channelId: ChannelId,
    accountId: string,
  ): ChannelAccountSnapshot => ({
    ...getChannelPlugin(channelId)?.status?.defaultRuntime,
    accountId,
  });

  const channelStores = new Map<ChannelId, ChannelRuntimeStore>();
  const restarts = new Map<string, RetrySupervisor>();
  // Tracks accounts that were manually stopped so we don't auto-restart them.
  const manuallyStopped = new Set<string>();
  const recoveryStopTimedOut = new Set<string>();
  const recoveryStartRequested = new Set<string>();
  // Accounts whose crash recovery is already owned by the retry supervisor below
  // (backoff sleep plus its replacement start). `restartPending` cannot answer
  // this: the timed-out-stop recovery sets it too, and that one needs the health
  // monitor to keep driving it.
  const pendingAutoRestarts = new Set<string>();
  let autostartSuppression: ChannelAutostartSuppression | null = null;
  let ambientAutostartSuppressedChannelIds = new Set(
    opts.ambientAutostartSuppressedChannelIds ?? [],
  );

  const restartKey = (channelId: ChannelId, accountId: string) => `${channelId}:${accountId}`;
  const releaseRouteHandoff = (
    store: ChannelRuntimeStore,
    accountId: string,
    expected = store.routeHandoffs.get(accountId),
  ): void => {
    if (expected && store.routeHandoffs.get(accountId) === expected) {
      expected.handoff.release();
      store.routeHandoffs.delete(accountId);
    }
  };
  const releaseChannelRouteHandoffs = (channelId: ChannelId, accountId?: string): void => {
    const store = getStore(channelId);
    for (const id of accountId ? [accountId] : store.routeHandoffs.keys()) {
      const admittedSignal = store.routeHandoffs.get(id)?.admittedSignal;
      // Partial rollback must preserve ingress owned by an admitted sibling.
      if (!admittedSignal || admittedSignal.aborted) {
        releaseRouteHandoff(store, id);
      }
    }
  };
  const ensureChannelLog = (channelId: ChannelId): SubsystemLogger => {
    channelLogs[channelId] ??= createSubsystemLogger("channels").child(channelId);
    return channelLogs[channelId];
  };
  const ensureChannelRuntime = (channelId: ChannelId): RuntimeEnv => {
    channelRuntimeEnvs[channelId] ??= runtimeForLogger(ensureChannelLog(channelId));
    return channelRuntimeEnvs[channelId];
  };

  const resolveAccountHealthMonitorOverride = (
    channelConfig: Record<string, unknown> | undefined,
    channelId: ChannelId,
    accountId: string,
  ): boolean | undefined => {
    const accounts = asOptionalRecord(channelConfig?.accounts);
    if (!accounts) {
      return undefined;
    }
    const direct = resolveChannelAccountEntry(accounts, accountId, channelId);
    const directEnabled = asOptionalRecord(asOptionalRecord(direct)?.healthMonitor)?.enabled;
    if (typeof directEnabled === "boolean") {
      return directEnabled;
    }
    const normalizedAccountId = normalizeOptionalAccountId(accountId);
    if (!normalizedAccountId) {
      return undefined;
    }
    const match = resolveChannelAccountEntry(
      accounts,
      normalizedAccountId,
      channelId,
      normalizeAccountId,
    );
    const enabled = asOptionalRecord(asOptionalRecord(match)?.healthMonitor)?.enabled;
    return typeof enabled === "boolean" ? enabled : undefined;
  };

  const isHealthMonitorEnabled = (channelId: ChannelId, accountId: string): boolean => {
    const cfg = getRuntimeConfig();
    const channelConfig = asOptionalRecord(cfg.channels?.[channelId]);
    const accountOverride = resolveAccountHealthMonitorOverride(
      channelConfig,
      channelId,
      accountId,
    );
    const channelOverride = asOptionalRecord(channelConfig?.healthMonitor)?.enabled;

    return accountOverride ?? (typeof channelOverride === "boolean" ? channelOverride : true);
  };

  const getStore = (channelId: ChannelId): ChannelRuntimeStore => {
    const existing = channelStores.get(channelId);
    if (existing) {
      return existing;
    }
    const next: ChannelRuntimeStore = {
      lifetimes: new Map(),
      routeHandoffs: new Map(),
      starting: new Map(),
      stops: new Map(),
      tasks: new Map(),
      runtimes: new Map(),
    };
    channelStores.set(channelId, next);
    return next;
  };

  const getRuntime = (channelId: ChannelId, accountId: string): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    return store.runtimes.get(accountId) ?? cloneDefaultRuntime(channelId, accountId);
  };

  const setRuntime = (
    channelId: ChannelId,
    accountId: string,
    patch: Omit<ChannelAccountSnapshot, "accountId">,
  ): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    const current = getRuntime(channelId, accountId);
    const hasExplicitReadyRecovery =
      Object.hasOwn(patch, "lifecycle") &&
      patch.lifecycle === "ready" &&
      Object.hasOwn(patch, "terminalDisconnect") &&
      patch.terminalDisconnect === undefined;
    // Weaker/derived signals never clear a terminal diagnosis. Gateway-owned starting still
    // begins a new lifecycle; a channel-authored explicit ready + terminal clear proves recovery.
    const lifecycle =
      current.lifecycle === "blocked" &&
      current.terminalDisconnect === true &&
      patch.lifecycle !== "starting" &&
      !hasExplicitReadyRecovery
        ? "blocked"
        : (patch.lifecycle ??
          (patch.restartPending === true
            ? "recovering"
            : patch.connected === true
              ? "ready"
              : undefined));
    const next = { ...current, ...patch, ...(lifecycle ? { lifecycle } : {}), accountId };
    store.runtimes.set(accountId, next);
    return next;
  };

  const setRuntimeFromTaskStatus = (
    channelId: ChannelId,
    accountId: string,
    patch: ChannelAccountSnapshot,
    abortSignal: AbortSignal,
  ): ChannelAccountSnapshot => {
    const safePatch = abortSignal.aborted
      ? sanitizeAbortedTaskStatusPatch(patch, getRuntime(channelId, accountId))
      : patch;
    const next = setRuntime(channelId, accountId, safePatch);
    // Ready follows all ingress registrations; terminal startup may wait for abort.
    // Retire on this task's terminal report, never an inherited diagnosis.
    if (!abortSignal.aborted && (next.lifecycle === "ready" || patch.terminalDisconnect === true)) {
      releaseRouteHandoff(getStore(channelId), accountId);
    }
    return next;
  };

  const setStoppedRuntime = (
    channelId: ChannelId,
    accountId: string,
    patch: Omit<ChannelAccountSnapshot, "accountId" | "running"> = {},
  ): ChannelAccountSnapshot => {
    const current = getRuntime(channelId, accountId);
    return setRuntime(channelId, accountId, {
      running: false,
      lifecycle: patch.restartPending === true ? "recovering" : "stopped",
      ...(typeof current.connected === "boolean" ? { connected: false } : {}),
      ...patch,
    });
  };

  const getChannelRuntime = async (): Promise<PluginRuntimeChannel | undefined> => {
    return channelRuntime ?? (await resolveChannelRuntime?.());
  };
  const createAccountContext = (
    channelId: ChannelId,
    accountId: string,
    cfg: OpenClawConfig,
    account: unknown,
    abortSignal: AbortSignal,
  ): Omit<ChannelGatewayContext, "setStatus"> => ({
    cfg,
    accountId,
    account,
    abortSignal,
    runtime: ensureChannelRuntime(channelId),
    log: ensureChannelLog(channelId),
    getStatus: () => getRuntime(channelId, accountId),
  });
  const measureStartup = async <T>(name: string, run: () => T | Promise<T>): Promise<T> => {
    return startupTrace ? startupTrace.measure(name, run) : await run();
  };

  const evictStaleChannelAccountState = (
    channelId: ChannelId,
    store: ChannelRuntimeStore,
    accountIds: readonly string[],
  ) => {
    const activeAccountIds = new Set(accountIds);
    for (const id of store.routeHandoffs.keys()) {
      if (!activeAccountIds.has(id)) {
        releaseRouteHandoff(store, id);
      }
    }
    for (const id of store.runtimes.keys()) {
      if (
        activeAccountIds.has(id) ||
        store.lifetimes.has(id) ||
        store.starting.has(id) ||
        store.stops.has(id) ||
        store.tasks.has(id)
      ) {
        continue;
      }
      store.runtimes.delete(id);
      clearActiveCredentialDegradedOwner("account", restartKey(channelId, normalizeAccountId(id)));
      restarts.delete(restartKey(channelId, id));
      manuallyStopped.delete(restartKey(channelId, id));
      recoveryStartRequested.delete(restartKey(channelId, id));
    }
  };

  const pruneInactiveChannelAccountState = (activeChannelIds: ReadonlySet<ChannelId>): void => {
    for (const [channelId, store] of channelStores) {
      if (!activeChannelIds.has(channelId)) {
        evictStaleChannelAccountState(channelId, store, []);
      }
    }
  };

  return {
    opts,
    getRuntimeConfig,
    getPluginRegistry,
    startupTrace,
    withRegistry,
    getChannelPlugin,
    channelStores,
    restarts,
    manuallyStopped,
    recoveryStopTimedOut,
    recoveryStartRequested,
    pendingAutoRestarts,
    restartKey,
    releaseRouteHandoff,
    releaseChannelRouteHandoffs,
    ensureChannelLog,
    ensureChannelRuntime,
    isHealthMonitorEnabled,
    getStore,
    getRuntime,
    setRuntime,
    setRuntimeFromTaskStatus,
    setStoppedRuntime,
    getChannelRuntime,
    createAccountContext,
    measureStartup,
    evictStaleChannelAccountState,
    pruneInactiveChannelAccountState,
    get autostartSuppression() {
      return autostartSuppression;
    },
    set autostartSuppression(value: ChannelAutostartSuppression | null) {
      autostartSuppression = value;
    },
    get ambientAutostartSuppressedChannelIds() {
      return ambientAutostartSuppressedChannelIds;
    },
    set ambientAutostartSuppressedChannelIds(value: Set<string>) {
      ambientAutostartSuppressedChannelIds = value;
    },
  };
}
export type ChannelRuntimeState = ReturnType<typeof createChannelRuntimeState>;
