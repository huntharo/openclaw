import { RetrySupervisor } from "../../../packages/retry/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withGatewayNativeApprovalRuntime } from "../../infra/approval-gateway-runtime-context.js";
import type { GatewayNativeApprovalMethod } from "../../infra/approval-gateway-runtime-methods.js";
import type { GatewayNativeApprovalRuntime } from "../../infra/approval-gateway-runtime.types.js";
import { type BackoffPolicy, sleepWithAbort } from "../../infra/backoff.js";
import { registerChannelRuntimeContext } from "../../infra/channel-runtime-context.js";
import { resetDirectoryCache } from "../../infra/outbound/target-resolver.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import type { PluginRuntimeCapabilityLease } from "../../plugins/capability-lease.js";
import { withPluginHttpRouteRegistry } from "../../plugins/http-registry.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import type { PluginRuntimeChannel } from "../../plugins/runtime/types-channel.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { getLoadedChannelPluginEntryById } from "../plugins/registry-loaded.js";
import type { ChannelGatewayContext } from "../plugins/types.adapters.js";
import type { ChannelId, ChannelPlugin } from "../plugins/types.public.js";
import { channelStartFailurePatch } from "../status/patches.js";
import type { StartChannelOptions } from "./snapshot.types.js";
import { runChannelAccountMonitor, waitForChannelStartupHandoff } from "./startup.js";
import type { ChannelRuntimeState } from "./state.js";
import type { ChannelAccountLifetime, ChannelRuntimeStore, ChannelManager } from "./types.js";
type ChannelAccountTask = {
  channelId: ChannelId;
  rKey: string;
  id: string;
  cfg: OpenClawConfig;
  linkState: "linked" | "not-linked" | "unknown" | undefined;
  preserveRestartAttempts: boolean;
  optsValue: StartChannelOptions;
  abort: AbortController;
  accountContext: Omit<ChannelGatewayContext, "setStatus">;
  channelRuntimeForTask: PluginRuntimeChannel | undefined;
  registry: PluginRegistry;
  registration: ReturnType<typeof getLoadedChannelPluginEntryById>;
  capabilityLease: PluginRuntimeCapabilityLease;
  lifetime: ChannelAccountLifetime;
  routeHandoff: ReturnType<ChannelRuntimeStore["routeHandoffs"]["get"]>;
  cleanupTaskScopedApprovalRuntime: (label: string) => Promise<void>;
  startAccount: NonNullable<NonNullable<ChannelPlugin["gateway"]>["startAccount"]>;
  log: SubsystemLogger;
  store: ChannelRuntimeStore;
  startChannelInternal: ChannelManager["startChannel"];
};
const RESTART_POLICY: BackoffPolicy = {
  initialMs: 5_000,
  maxMs: 5 * 60_000,
  factor: 2,
  jitter: 0.1,
};
const MAX_RESTARTS = 10;
const CHANNEL_STABLE_RUN_MS = RESTART_POLICY.maxMs;
// Private context key carried through the generic Plugin SDK registry. This is
// not a new public capability surface; only the host installs its authority.
const CHANNEL_APPROVAL_GATEWAY_RUNTIME_CONTEXT_CAPABILITY = "approval.gateway";

async function waitForDeferredAccountStart(
  deferred: Promise<void>,
  abortSignal: AbortSignal,
): Promise<void> {
  if (abortSignal.aborted) {
    return;
  }
  const aborted = createDeferredCore();
  const onAbort = () => aborted.resolve();
  abortSignal.addEventListener("abort", onAbort, { once: true });
  try {
    await Promise.race([deferred, aborted.promise]);
  } finally {
    abortSignal.removeEventListener("abort", onAbort);
  }
}

export function startChannelAccountTask(state: ChannelRuntimeState, input: ChannelAccountTask) {
  const {
    opts,
    startupTrace,
    restarts,
    manuallyStopped,
    recoveryStopTimedOut,
    recoveryStartRequested,
    pendingAutoRestarts,
    releaseRouteHandoff,
    getRuntime,
    setRuntime,
    setRuntimeFromTaskStatus,
    setStoppedRuntime,
    measureStartup,
  } = state;
  const {
    channelId,
    rKey,
    id,
    cfg,
    linkState,
    preserveRestartAttempts,
    optsValue,
    abort,
    accountContext,
    channelRuntimeForTask,
    registry,
    registration,
    capabilityLease,
    lifetime,
    routeHandoff,
    cleanupTaskScopedApprovalRuntime,
    startAccount,
    log,
    store,
    startChannelInternal,
  } = input;
  let channelRunDurationMs: number | undefined;
  setRuntime(channelId, id, {
    enabled: true,
    ...(linkState === "linked" ? { linked: true } : {}),
    running: true,
    lifecycle: "starting",
    restartPending: false,
    lastStartAt: Date.now(),
    lastError: null,
    // Runtime rows are patch-merged; prior ingress or terminal verdicts
    // must not poison a new lifecycle before its plugin reports status.
    ingressUnavailable: undefined,
    terminalDisconnect: undefined,
    ...(getRuntime(channelId, id).healthState === "plugin-trust-refused"
      ? { healthState: undefined }
      : {}),
    reconnectAttempts: preserveRestartAttempts ? (restarts.get(rKey)?.attempts ?? 0) : 0,
  });
  const task = Promise.resolve().then(async () => {
    if (optsValue.deferAccountStartUntil) {
      await waitForDeferredAccountStart(optsValue.deferAccountStartUntil, abort.signal);
    } else if (startupTrace) {
      await waitForChannelStartupHandoff();
    }
    if (abort.signal.aborted || manuallyStopped.has(rKey) || opts.isClosing?.()) {
      return;
    }
    const gatewayApprovalRuntime = opts.getNativeApprovalRuntime?.();
    if (channelRuntimeForTask && gatewayApprovalRuntime) {
      const approvalRuntime: Pick<GatewayNativeApprovalRuntime, "request"> = {
        request: async <T>(
          method: GatewayNativeApprovalMethod,
          requestParams: Record<string, unknown>,
          requestOptions?: { clientDisplayName?: string },
        ): Promise<T> => {
          if (method !== "approval.resolve") {
            throw new Error(`channel approval runtime cannot dispatch ${method}`);
          }
          return await gatewayApprovalRuntime.request<T>(
            "approval.resolve",
            requestParams,
            requestOptions,
          );
        },
      };
      registerChannelRuntimeContext({
        channelRuntime: channelRuntimeForTask,
        channelId,
        accountId: id,
        capability: CHANNEL_APPROVAL_GATEWAY_RUNTIME_CONTEXT_CAPABILITY,
        context: approvalRuntime,
        abortSignal: abort.signal,
      });
    }
    let startAccountTask: ReturnType<typeof startAccount> | undefined;
    await measureStartup(`channels.${channelId}.start-account-handoff`, () => {
      if (abort.signal.aborted || manuallyStopped.has(rKey) || opts.isClosing?.()) {
        return;
      }
      const runStartAccount = () => {
        const startedAt = Date.now();
        const recordDuration = () => {
          channelRunDurationMs = Date.now() - startedAt;
        };
        try {
          return withGatewayNativeApprovalRuntime(opts.getNativeApprovalRuntime?.(), () =>
            startAccount({
              ...accountContext,
              setStatus: (next) =>
                isCurrentTask()
                  ? setRuntimeFromTaskStatus(channelId, id, next, abort.signal)
                  : getRuntime(channelId, id),
              invalidateDirectoryCache: () =>
                resetDirectoryCache({ cfg, channel: channelId, accountId: id }),
              ...(channelRuntimeForTask ? { channelRuntime: channelRuntimeForTask } : {}),
            }),
          ).finally(recordDuration);
        } catch (error) {
          recordDuration();
          throw error;
        }
      };
      startAccountTask = withPluginHttpRouteRegistry(
        registry,
        () => runChannelAccountMonitor(registry, registration?.pluginId, runStartAccount),
        capabilityLease,
      );
    });
    if (!startAccountTask) {
      return;
    }
    await startAccountTask;
  });
  // Recovery can replace a timed-out task before the old promise settles.
  // Only the task that still owns the store slot may write lifecycle state.
  const trackedPromise = task
    .finally(() => capabilityLease.revoke())
    .then(() => {
      if (
        abort.signal.aborted ||
        manuallyStopped.has(rKey) ||
        opts.isClosing?.() ||
        !isCurrentTask()
      ) {
        return;
      }
      if (getRuntime(channelId, id).terminalDisconnect) {
        // Terminal status carries the operator-facing diagnosis and restart policy.
        // Do not replace it with a generic clean-exit error before policy consumes it.
        return;
      }
      const message = "channel exited without an error";
      setRuntime(channelId, id, { lastError: message });
      log.error?.(`[${id}] ${message}`);
    })
    .catch((err: unknown) => {
      if (!isCurrentTask() || store.stops.has(id) || opts.isClosing?.()) {
        return;
      }
      const failure = channelStartFailurePatch(err);
      setRuntime(channelId, id, failure);
      log.error?.(`[${id}] channel exited: ${failure.lastError}`);
    })
    .then(async () => {
      await cleanupTaskScopedApprovalRuntime("channel cleanup failed");
      // stopChannel owns the failed-teardown snapshot until a later
      // successful stop proves replacement is safe.
      if (!isCurrentTask() || store.stops.has(id) || opts.isClosing?.()) {
        return;
      }
      setStoppedRuntime(channelId, id, {
        lastStopAt: Date.now(),
      });
    })
    .then(async () => {
      if (!isCurrentTask() || store.stops.has(id) || opts.isClosing?.()) {
        return;
      }
      if (manuallyStopped.has(rKey)) {
        recoveryStopTimedOut.delete(rKey);
        recoveryStartRequested.delete(rKey);
        return;
      }
      if (getRuntime(channelId, id).terminalDisconnect) {
        // Terminal startup/session failures win over pending recovery.
        // Leaving recovery state behind would restart a channel that needs user action.
        recoveryStopTimedOut.delete(rKey);
        recoveryStartRequested.delete(rKey);
        restarts.delete(rKey);
        setRuntime(channelId, id, {
          restartPending: false,
          reconnectAttempts: 0,
        });
        log.info?.(`[${id}] auto-restart skipped, terminal disconnect`);
        return;
      }
      if (recoveryStopTimedOut.has(rKey)) {
        recoveryStopTimedOut.delete(rKey);
        if (!recoveryStartRequested.delete(rKey)) {
          setRuntime(channelId, id, {
            restartPending: false,
            reconnectAttempts: 0,
          });
          releaseTask();
          return;
        }
        restarts.delete(rKey);
        log.info?.(`[${id}] restarting after timed-out channel stop completed`);
        setRuntime(channelId, id, {
          restartPending: true,
          reconnectAttempts: 0,
        });
        releaseTask();
        try {
          await startChannelInternal(channelId, id, {
            preserveManualStop: true,
          });
        } catch {
          // abort or startup failure — runtime state was recorded by startChannelInternal
        }
        return;
      }
      // Only plugin task lifetime counts. Deferred handoff and cleanup must not
      // make a short crash look stable and erase crash-loop attempts.
      if (channelRunDurationMs !== undefined && channelRunDurationMs >= CHANNEL_STABLE_RUN_MS) {
        restarts.delete(rKey);
      }
      const restart = restarts.get(rKey) ?? new RetrySupervisor(RESTART_POLICY, MAX_RESTARTS);
      restarts.set(rKey, restart);
      const retry = restart.next(abort.signal);
      if (!retry) {
        setRuntime(channelId, id, {
          restartPending: false,
          reconnectAttempts: restart.attempts,
        });
        log.error?.(`[${id}] giving up after ${MAX_RESTARTS} restart attempts`);
        return;
      }
      log.info?.(
        `[${id}] auto-restart attempt ${restart.attempts}/${MAX_RESTARTS} in ${Math.round(retry.delayMs / 1000)}s`,
      );
      setRuntime(channelId, id, {
        restartPending: true,
        reconnectAttempts: restart.attempts,
      });
      pendingAutoRestarts.add(rKey);
      try {
        await sleepWithAbort(retry.delayMs, retry.signal);
        if (manuallyStopped.has(rKey) || opts.isClosing?.()) {
          return;
        }
        releaseTask();
        await startChannelInternal(channelId, id, {
          preserveRestartAttempts: true,
          preserveManualStop: true,
        });
      } catch {
        // abort or startup failure — next crash will retry
      } finally {
        pendingAutoRestarts.delete(rKey);
      }
    })
    .finally(() => {
      releaseTask();
      // Retry ingress spans backoff and preparation. A successful retry
      // transfers admission to its signal before this predecessor ends.
      if (routeHandoff?.admittedSignal === abort.signal) {
        releaseRouteHandoff(store, id, routeHandoff);
      }
    });
  function releaseTask() {
    if (store.tasks.get(id) === trackedPromise) {
      store.tasks.delete(id);
    }
    // Failed or queued teardown retains the admitted context. Every terminal
    // task still aborts before replacement so no predecessor keeps authority.
    if (store.lifetimes.get(id) === lifetime && !store.stops.has(id)) {
      store.lifetimes.delete(id);
    }
    abort.abort();
  }
  function isCurrentTask() {
    return store.tasks.get(id) === trackedPromise;
  }
  store.tasks.set(id, trackedPromise);
  if (routeHandoff) {
    routeHandoff.admittedSignal = abort.signal;
  }
}
