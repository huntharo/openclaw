import { formatErrorMessage } from "../../infra/errors.js";
import {
  createPluginRuntimeCapabilityLease,
  type PluginRuntimeCapabilityLease,
} from "../../plugins/capability-lease.js";
import {
  createPluginHttpRouteHandoff,
  withPluginHttpRouteRegistry,
} from "../../plugins/http-registry.js";
import { runPluginCleanup } from "../../plugins/plugin-instance-scope.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import { isChannelAccountExplicitlyDisabled } from "../account-config-enabled.js";
import { resolveChannelAccount } from "../account-resolution.js";
import { getLoadedChannelPluginEntryById } from "../plugins/registry-loaded.js";
import type { ChannelId } from "../plugins/types.public.js";
import type { ChannelRuntimeState } from "./state.js";
import { waitForChannelStopGracefully } from "./stop-timeout.js";
import type { StopChannelOptions, ChannelAccountStopOutcome, ChannelManager } from "./types.js";
const CHANNEL_STOP_ABORT_TIMEOUT_MS = 5_000;
export function createChannelStopper(state: ChannelRuntimeState) {
  const {
    getRuntimeConfig,
    withRegistry,
    manuallyStopped,
    recoveryStopTimedOut,
    recoveryStartRequested,
    restartKey,
    releaseRouteHandoff,
    releaseChannelRouteHandoffs,
    ensureChannelLog,
    getStore,
    getRuntime,
    setRuntime,
    setStoppedRuntime,
    createAccountContext,
  } = state;
  const stopChannelInRegistry = async (
    registry: PluginRegistry,
    channelId: ChannelId,
    accountId?: string,
    optsLocal: StopChannelOptions = {},
  ) => {
    const manual = optsLocal.manual ?? true;
    const retainCleanupOwner = manual || !optsLocal.routeHandoff;
    const plugin = getLoadedChannelPluginEntryById(channelId, registry)?.plugin;
    const store = getStore(channelId);
    if (retainCleanupOwner) {
      releaseChannelRouteHandoffs(channelId, accountId);
    }
    const lifecycleIds = new Set<string>([
      ...store.lifetimes.keys(),
      ...store.starting.keys(),
      ...store.stops.keys(),
      ...store.tasks.keys(),
    ]);
    // Preserve no-enumeration channel-wide idle stops. An explicit account stop
    // must still commit manual intent before health monitoring can restart it.
    if (!accountId && lifecycleIds.size === 0) {
      return;
    }
    const cfg = getRuntimeConfig();
    // Enter the registered owner's cleanup scope before accessing config getters.
    const configuredAccountIds =
      !accountId || optsLocal.routeHandoff
        ? plugin
          ? runPluginCleanup(plugin, () => plugin.config.listAccountIds(cfg))
          : []
        : [];
    const knownIds = new Set<string>(
      accountId ? [accountId] : [...lifecycleIds, ...configuredAccountIds],
    );

    // Gate replacement starts before teardown begins. Failures still reject only
    // after every sibling account has finished its independent lifecycle cleanup.
    const stopOutcomes = await Promise.all(
      Array.from(knownIds.values()).map(async (id): Promise<ChannelAccountStopOutcome> => {
        const rKey = restartKey(channelId, id);
        if (manual) {
          manuallyStopped.add(rKey);
        }

        const runStopAttempt = async (
          previousOutcome: ChannelAccountStopOutcome,
        ): Promise<ChannelAccountStopOutcome> => {
          const lifetime = store.lifetimes.get(id);
          const abort = lifetime?.abort;
          const canHandoff =
            optsLocal.routeHandoff &&
            configuredAccountIds.includes(id) &&
            !isChannelAccountExplicitlyDisabled({ cfg, channel: channelId, accountId: id }) &&
            !manuallyStopped.has(rKey);
          if (!canHandoff) {
            releaseRouteHandoff(store, id);
          }
          const task = store.tasks.get(id);
          // Idle accounts have no captured teardown; managed getters need cleanup admission.
          const fallbackStop =
            !lifetime && plugin
              ? runPluginCleanup(plugin, () => {
                  const gateway = plugin.gateway;
                  const stopAccount = gateway?.stopAccount;
                  return stopAccount ? { gateway, stopAccount } : undefined;
                })
              : undefined;
          if (!abort && !task && !lifetime?.teardown && !fallbackStop) {
            return previousOutcome;
          }
          const lease = lifetime?.capabilityLease;
          if (canHandoff && abort && lease && store.routeHandoffs.get(id)?.parkedBy !== abort) {
            const handoff = store.routeHandoffs.get(id)?.handoff ?? createPluginHttpRouteHandoff();
            handoff.park(lease);
            store.routeHandoffs.set(id, { handoff, parkedBy: abort });
          }
          // Parking transfers ingress ownership before cancellation. Retired
          // startup work must never reclaim it while its promise is settling.
          if (optsLocal.routeHandoff) {
            lease?.revoke();
          }
          abort?.abort();
          const log = ensureChannelLog(channelId);
          let outcome: ChannelAccountStopOutcome = { status: "fulfilled" };
          let capabilityLease: PluginRuntimeCapabilityLease | undefined;
          let stopAccountSettled = true;
          try {
            // Running and failed-stop accounts belong to their admitted plugin and config,
            // even after publication removes the account or replaces its registration.
            const teardown = lifetime?.teardown;
            if (teardown || (fallbackStop && plugin)) {
              // Teardown can outlive the start task. Its own lease permits route and status
              // writes only until this stop attempt completes or times out.
              const stopLease = createPluginRuntimeCapabilityLease("channel account stop");
              capabilityLease = stopLease;
              // A plugin stopAccount that never settles must not wedge every
              // stop-driven flow (health monitor sweeps, thaw recovery, reload).
              // Ordinary recovery retains the timed-out owner; explicit handoff
              // retires its slots after revoking OpenClaw runtime authority.
              const runStopAccount = async () => {
                let preparedTeardown = teardown;
                if (fallbackStop && plugin) {
                  const { gateway, stopAccount } = fallbackStop;
                  const account = await runPluginCleanup(plugin, () =>
                    resolveChannelAccount({ plugin, cfg, accountId: id }),
                  );
                  stopLease.assertActive("account resolution");
                  preparedTeardown = {
                    context: createAccountContext(
                      channelId,
                      id,
                      cfg,
                      account,
                      new AbortController().signal,
                    ),
                    run: (context) =>
                      runPluginCleanup(stopAccount, () => stopAccount.call(gateway, context)),
                  };
                }
                if (!preparedTeardown) {
                  return;
                }
                const { context, run } = preparedTeardown;
                return run({
                  ...context,
                  setStatus: (next) =>
                    stopLease.isActive()
                      ? setRuntime(channelId, id, next)
                      : getRuntime(channelId, id),
                });
              };
              const stopAccountAttempt = withPluginHttpRouteRegistry(
                registry,
                runStopAccount,
                stopLease,
              ).catch((error: unknown) => {
                if (!stopLease.isActive()) {
                  log.warn?.(
                    `[${id}] abandoned stopAccount failed late: ${formatErrorMessage(error)}`,
                  );
                  return;
                }
                outcome = { status: "rejected", error };
                log.warn?.(`[${id}] stopAccount failed: ${formatErrorMessage(error)}`);
              });
              stopAccountSettled = await waitForChannelStopGracefully(
                stopAccountAttempt,
                CHANNEL_STOP_ABORT_TIMEOUT_MS,
              );
              if (!stopAccountSettled) {
                log.warn?.(
                  `[${id}] stopAccount exceeded ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms; continuing stop`,
                );
              }
            }
          } catch (error) {
            outcome = { status: "rejected", error };
            log.warn?.(`[${id}] stopAccount failed: ${formatErrorMessage(error)}`);
          } finally {
            capabilityLease?.revoke();
          }
          const stoppedCleanly = await waitForChannelStopGracefully(
            task,
            CHANNEL_STOP_ABORT_TIMEOUT_MS,
          );
          if (!stoppedCleanly) {
            log.warn?.(
              `[${id}] channel stop exceeded ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms after abort; continuing shutdown`,
            );
          }
          if (optsLocal.strict && (!stopAccountSettled || !stoppedCleanly)) {
            outcome = {
              status: "rejected",
              error: new Error(
                `Channel ${channelId}/${id} ${stoppedCleanly ? "stopAccount did not settle" : "still owns running work"}.`,
              ),
            };
          }
          if (outcome.status === "rejected" && retainCleanupOwner) {
            recoveryStopTimedOut.delete(rKey);
            recoveryStartRequested.delete(rKey);
            if (stoppedCleanly && store.tasks.get(id) === task) {
              store.tasks.delete(id);
            }
            setRuntime(channelId, id, {
              running: true,
              restartPending: false,
              lastError: formatErrorMessage(outcome.error),
            });
            return outcome;
          }
          if (!stoppedCleanly && retainCleanupOwner) {
            const stoppedPatch = {
              restartPending: !manual,
              lastError: `channel stop timed out after ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms`,
            };
            if (manual) {
              setRuntime(channelId, id, {
                running: true,
                ...stoppedPatch,
              });
            } else {
              setStoppedRuntime(channelId, id, stoppedPatch);
              recoveryStopTimedOut.add(rKey);
            }
            return outcome;
          }
          recoveryStopTimedOut.delete(rKey);
          recoveryStartRequested.delete(rKey);
          if (store.tasks.get(id) === task) {
            store.tasks.delete(id);
          }
          // Only the final stop releases the captured owner. Handoff retires pending
          // preparation too; its revoked lease fences late results and route writes.
          const latestStop = store.stops.get(id);
          if (
            latestStop?.status === "stopping" &&
            latestStop.attempt === stopAttempt &&
            store.lifetimes.get(id) === lifetime
          ) {
            store.lifetimes.delete(id);
            if (!retainCleanupOwner) {
              store.starting.delete(id);
            }
          }
          setStoppedRuntime(channelId, id, {
            restartPending: false,
            lastStopAt: Date.now(),
            ...(outcome.status === "rejected"
              ? { lastError: formatErrorMessage(outcome.error) }
              : {}),
          });
          return outcome;
        };

        const currentStop = store.stops.get(id);
        const previousStop =
          currentStop?.status === "stopping"
            ? currentStop.attempt
            : Promise.resolve<ChannelAccountStopOutcome>(currentStop ?? { status: "fulfilled" });
        const stopAttempt = previousStop.then(runStopAttempt);
        store.stops.set(id, { status: "stopping", attempt: stopAttempt });
        const outcome = await stopAttempt;
        const latestStop = store.stops.get(id);
        if (latestStop?.status === "stopping" && latestStop.attempt === stopAttempt) {
          if (outcome.status === "rejected" && retainCleanupOwner) {
            store.stops.set(id, outcome);
          } else {
            store.stops.delete(id);
            if (!store.tasks.has(id) && !store.starting.has(id)) {
              store.lifetimes.delete(id);
            }
          }
        }
        return outcome;
      }),
    );
    const failedStop = stopOutcomes.find((outcome) => outcome.status === "rejected");
    if (failedStop?.status === "rejected") {
      throw failedStop.error;
    }
  };

  const stopChannel: ChannelManager["stopChannel"] = (...args) =>
    withRegistry((registry) => stopChannelInRegistry(registry, ...args));

  return stopChannel;
}
