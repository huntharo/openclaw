import { startChannelApprovalHandlerBootstrap } from "../../infra/approval-handler-bootstrap.js";
import { createTaskScopedChannelRuntime } from "../../infra/channel-runtime-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { formatGatewayCrashLoopManualChannelStartHint } from "../../infra/gateway-boot-lifecycle.js";
import { resetDirectoryCache } from "../../infra/outbound/target-resolver.js";
import { createPluginRuntimeCapabilityLease } from "../../plugins/capability-lease.js";
import { runPluginCleanup } from "../../plugins/plugin-instance-scope.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import type { PluginRuntimeChannel } from "../../plugins/runtime/types-channel.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import {
  assertSecretOwnerAvailable,
  clearActiveCredentialDegradedOwner,
  setActiveCredentialDegradedOwner,
} from "../../secrets/runtime-degraded-state.js";
import { isAccountEnabled } from "../../shared/account-enabled.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import { isChannelAccountExplicitlyDisabled } from "../account-config-enabled.js";
import { resolveChannelAccount } from "../account-resolution.js";
import { getCredentialUnavailableDiagnostics } from "../account-snapshot-fields.js";
import { getLoadedChannelPluginEntryById } from "../plugins/registry-loaded.js";
import type { ChannelId } from "../plugins/types.public.js";
import type { ChannelAccountStartOutcome, StartChannelOptions } from "./snapshot.types.js";
import { runChannelAccountStartup } from "./startup.js";
import type { ChannelRuntimeState } from "./state.js";
import { startChannelAccountTask } from "./task.js";
import type { ChannelAccountLifetime, ChannelManager } from "./types.js";
const CHANNEL_STARTUP_CONCURRENCY = 4;
export function createChannelStarter(state: ChannelRuntimeState) {
  const {
    opts,
    getRuntimeConfig,
    getPluginRegistry,
    withRegistry,
    restarts,
    manuallyStopped,
    recoveryStopTimedOut,
    recoveryStartRequested,
    restartKey,
    releaseRouteHandoff,
    ensureChannelLog,
    getStore,
    getRuntime,
    setRuntime,
    setStoppedRuntime,
    getChannelRuntime,
    createAccountContext,
    measureStartup,
    evictStaleChannelAccountState,
  } = state;
  const startChannelProcessOwned = async (
    registry: PluginRegistry,
    channelId: ChannelId,
    accountId?: string,
    optsValue: StartChannelOptions = {},
  ): Promise<ReadonlyMap<string, ChannelAccountStartOutcome>> => {
    const store = getStore(channelId);
    const startFence = store.startFence;
    const registration = getLoadedChannelPluginEntryById(channelId, registry);
    // Unchanged instances keep pending starts across registry publication.
    const assertStartCurrent = () => {
      if (
        startFence?.state === "paused" ||
        store.startFence !== startFence ||
        getLoadedChannelPluginEntryById(channelId, getPluginRegistry())?.plugin !==
          registration?.plugin
      ) {
        throw new Error("Channel plugins are reloading; retry the start after reload completes.");
      }
    };
    assertStartCurrent();
    const plugin = registration?.plugin;
    const startAccount = plugin?.gateway?.startAccount;
    if (!startAccount) {
      for (const id of accountId ? [accountId] : store.routeHandoffs.keys()) {
        releaseRouteHandoff(store, id);
      }
      return accountId
        ? new Map([[accountId, { status: "skipped", reason: "unsupported" }]])
        : new Map();
    }
    const { preserveRestartAttempts = false, preserveManualStop = false } = optsValue;
    const cfg = getRuntimeConfig();
    resetDirectoryCache({ cfg, channel: channelId, accountId });
    const accountIds = accountId
      ? [accountId]
      : await measureStartup(`channels.${channelId}.list-accounts`, () =>
          plugin.config.listAccountIds(cfg),
        );
    assertStartCurrent();
    if (!accountId) {
      evictStaleChannelAccountState(channelId, store, accountIds);
    }
    if (accountIds.length === 0) {
      return new Map();
    }
    if (state.autostartSuppression && optsValue.manual !== true) {
      // Safe mode must block every automatic channel start surface; otherwise
      // config reloads can undo the crash-loop breaker while operators inspect.
      const suffix = accountId ? ` account ${accountId}` : "";
      ensureChannelLog(channelId).warn?.(
        `channel autostart suppressed by crash-loop breaker; refusing automatic start for ${channelId}${suffix}. ${formatGatewayCrashLoopManualChannelStartHint({ channelId, ...(accountId ? { accountId } : {}) })}`,
      );
      for (const id of accountIds) {
        releaseRouteHandoff(store, id);
        setStoppedRuntime(channelId, id, {
          restartPending: false,
          lastError: state.autostartSuppression.message,
        });
      }
      return new Map(
        accountIds.map((id) => [
          id,
          { status: "skipped", reason: "autostart-suppressed" } as const,
        ]),
      );
    }
    if (state.ambientAutostartSuppressedChannelIds.has(channelId) && optsValue.manual !== true) {
      for (const id of accountIds) {
        releaseRouteHandoff(store, id);
        setStoppedRuntime(channelId, id, {
          restartPending: false,
          lastError:
            "ambient channel credentials suppressed; configure the channel or start the gateway with --ambient-channels",
        });
      }
      return new Map(
        accountIds.map((id) => [id, { status: "skipped", reason: "ambient-suppressed" } as const]),
      );
    }

    const startOutcomes = new Map<string, ChannelAccountStartOutcome>();
    const startup = await runTasksWithConcurrency({
      limit: CHANNEL_STARTUP_CONCURRENCY,
      tasks: accountIds.map((id) => async () => {
        assertStartCurrent();
        const rKey = restartKey(channelId, id);
        const explicitlyDisabled = isChannelAccountExplicitlyDisabled({
          cfg,
          channel: channelId,
          accountId: id,
        });
        // An operator disable ends ingress even when an aborted predecessor
        // still owns its task slot. Keep that slot for its separate cleanup.
        if (explicitlyDisabled) {
          releaseRouteHandoff(store, id);
        }
        // Record start intent before waiting; a later stop must survive cancelled preparation.
        if (!preserveManualStop && !store.stops.has(id)) {
          manuallyStopped.delete(rKey);
        }
        // A stopped preparation may never publish a task. Reacquire its slot only
        // after cleanup, rechecking ownership when other starts were also waiting.
        for (;;) {
          // An in-flight or failed plugin teardown may still own resources. Only
          // the last queued attempt or a later successful stop clears this gate.
          if (store.stops.has(id)) {
            startOutcomes.set(id, { status: "retry", reason: "stop-in-flight" });
            return;
          }
          if (store.tasks.has(id)) {
            let clearedTimedOutRecoveryTask = false;
            if (recoveryStopTimedOut.has(rKey)) {
              if (manuallyStopped.has(rKey)) {
                startOutcomes.set(id, { status: "skipped", reason: "manual-stop" });
                return;
              }
              // When a previous stop timed out and the health monitor is
              // requesting recovery again, clean up the stuck task so the
              // channel can actually restart instead of staying in limbo.
              if (recoveryStartRequested.has(rKey)) {
                recoveryStopTimedOut.delete(rKey);
                recoveryStartRequested.delete(rKey);
                restarts.delete(rKey);
                store.lifetimes.get(id)?.capabilityLease.revoke();
                store.lifetimes.delete(id);
                store.tasks.delete(id);
                clearedTimedOutRecoveryTask = true;
                setRuntime(channelId, id, {
                  restartPending: false,
                  reconnectAttempts: 0,
                });
              } else {
                recoveryStartRequested.add(rKey);
                setRuntime(channelId, id, { restartPending: true });
                startOutcomes.set(id, { status: "retry", reason: "task-owned" });
                return;
              }
            }
            if (!clearedTimedOutRecoveryTask) {
              startOutcomes.set(id, { status: "retry", reason: "task-owned" });
              return;
            }
          }
          const existingStart = store.starting.get(id);
          if (!existingStart) {
            break;
          }
          await existingStart;
          assertStartCurrent();
        }

        const startGate = createDeferredCore();
        store.starting.set(id, startGate.promise);

        // Reserve the account before the first await so overlapping start calls
        // cannot race into duplicate provider boots for the same account.
        const routeHandoff = store.routeHandoffs.get(id);
        const abort = new AbortController();
        const capabilityLease = createPluginRuntimeCapabilityLease("channel account");
        const lifetime: ChannelAccountLifetime = { plugin, abort, capabilityLease };
        store.lifetimes.set(id, lifetime);
        let handedOffTask = false;
        const log = ensureChannelLog(channelId);
        let scopedChannelRuntime: {
          channelRuntime?: PluginRuntimeChannel;
          dispose: () => void;
        } | null = null;
        let channelRuntimeForTask: PluginRuntimeChannel | undefined;
        let stopApprovalBootstrap: () => Promise<void> = async () => {};
        const stopTaskScopedApprovalRuntime = async () => {
          const scopedRuntime = scopedChannelRuntime;
          scopedChannelRuntime = null;
          const stopBootstrap = stopApprovalBootstrap;
          stopApprovalBootstrap = async () => {};
          scopedRuntime?.dispose();
          await stopBootstrap();
        };
        const cleanupTaskScopedApprovalRuntime = async (label: string) => {
          try {
            await stopTaskScopedApprovalRuntime();
          } catch (error) {
            log.error?.(`[${id}] ${label}: ${formatErrorMessage(error)}`);
          }
        };
        const skipDisabledAccount = () => {
          setRuntime(channelId, id, {
            enabled: false,
            running: false,
            restartPending: false,
          });
          startOutcomes.set(id, { status: "skipped", reason: "disabled" });
        };

        try {
          // Reject active accounts before plugin resolution so an explicit failed SecretRef cannot
          // drift into a channel-specific environment or file fallback.
          const secretOwnerId = `${channelId}:${normalizeAccountId(id)}`;
          clearActiveCredentialDegradedOwner("account", secretOwnerId);
          // Explicitly disabled accounts need no credentials. Unlisted requests still go
          // through the plugin resolver so a disable cannot hide account-selection errors.
          if (
            explicitlyDisabled &&
            plugin.config
              .listAccountIds(cfg)
              .some((listed) => normalizeAccountId(listed) === normalizeAccountId(id))
          ) {
            skipDisabledAccount();
            return;
          }
          try {
            assertSecretOwnerAvailable("account", secretOwnerId);
          } catch (error) {
            if (!optsValue.skipUnavailableAccounts) {
              throw error;
            }
            // Only this snapshot-owned assertion is an expected cold reload
            // outcome; plugin startup and credential-file inspection still fail.
            setStoppedRuntime(channelId, id, {
              restartPending: false,
              lastError: formatErrorMessage(error),
            });
            startOutcomes.set(id, { status: "skipped", reason: "secret-unavailable" });
            return;
          }
          const account = await resolveChannelAccount({ plugin, cfg, accountId: id });
          assertStartCurrent();
          capabilityLease.assertActive("startup");
          if (abort.signal.aborted || manuallyStopped.has(rKey) || opts.isClosing?.()) {
            setStoppedRuntime(channelId, id, { restartPending: false });
            startOutcomes.set(id, { status: "skipped", reason: "manual-stop" });
            return;
          }
          const accountContext = createAccountContext(channelId, id, cfg, account, abort.signal);
          if (plugin.gateway?.stopAccount) {
            const stopAccount = plugin.gateway.stopAccount;
            const gateway = plugin.gateway;
            lifetime.teardown = {
              context: accountContext,
              run: (context) =>
                runPluginCleanup(stopAccount, () => stopAccount.call(gateway, context)),
            };
          }
          const described = plugin.config.describeAccount?.(account, cfg);
          const enabled = plugin.config.isEnabled
            ? plugin.config.isEnabled(account, cfg)
            : isAccountEnabled(account);
          if (!enabled) {
            skipDisabledAccount();
            return;
          }

          const credentialDiagnostics = getCredentialUnavailableDiagnostics(account);
          if (credentialDiagnostics.length > 0) {
            setActiveCredentialDegradedOwner({
              ownerKind: "account",
              ownerId: secretOwnerId,
              state: "unavailable",
              paths: credentialDiagnostics.map((diagnostic) => diagnostic.path),
              refKeys: [],
              reason: "credential file is unavailable",
            });
            assertSecretOwnerAvailable("account", secretOwnerId);
          }

          let configured = true;
          if (plugin.config.isConfigured) {
            configured = await measureStartup(`channels.${channelId}.is-configured`, () =>
              plugin.config.isConfigured!(account, cfg),
            );
          }
          capabilityLease.assertActive("startup");
          if (!configured) {
            setRuntime(channelId, id, {
              enabled: true,
              configured: false,
              linked: undefined,
              running: false,
              restartPending: false,
            });
            startOutcomes.set(id, { status: "skipped", reason: "unconfigured" });
            return;
          }
          setRuntime(channelId, id, {
            enabled: true,
            configured: true,
            ...(plugin.config.isLinked ? { linked: undefined } : {}),
          });

          const fallbackLinked = described?.linked ?? getRuntime(channelId, id).linked;
          const linkState = plugin.config.isLinked
            ? await measureStartup(`channels.${channelId}.is-linked`, () =>
                plugin.config.isLinked!(account, cfg),
              )
            : fallbackLinked === true
              ? "linked"
              : fallbackLinked === false
                ? "not-linked"
                : undefined;
          capabilityLease.assertActive("startup");
          if (linkState === "not-linked" || linkState === "unknown") {
            setRuntime(channelId, id, {
              enabled: true,
              linked: linkState === "not-linked" ? false : undefined,
              running: false,
              restartPending: false,
            });
            startOutcomes.set(id, { status: "skipped", reason: "unlinked" });
            return;
          }

          if (abort.signal.aborted || manuallyStopped.has(rKey)) {
            setStoppedRuntime(channelId, id, {
              restartPending: false,
              lastStopAt: Date.now(),
            });
            startOutcomes.set(id, { status: "skipped", reason: "manual-stop" });
            return;
          }

          scopedChannelRuntime = await measureStartup(`channels.${channelId}.runtime`, async () =>
            createTaskScopedChannelRuntime({
              channelRuntime:
                registration?.resolveChannelRuntime?.() ?? (await getChannelRuntime()),
            }),
          );
          capabilityLease.assertActive("startup");
          channelRuntimeForTask = scopedChannelRuntime.channelRuntime;

          if (!preserveRestartAttempts) {
            restarts.delete(rKey);
          }
          try {
            stopApprovalBootstrap = await measureStartup(
              `channels.${channelId}.approval-bootstrap`,
              () =>
                startChannelApprovalHandlerBootstrap({
                  scheduler: opts.scheduler,
                  plugin,
                  cfg,
                  accountId: id,
                  channelRuntime: channelRuntimeForTask,
                  gatewayRuntime: opts.getNativeApprovalRuntime?.(),
                  logger: log,
                }),
            );
          } catch (error) {
            log.error?.(`[${id}] native approval bootstrap failed: ${formatErrorMessage(error)}`);
          }
          // Preparation can outlive a registry replacement or an operator stop. Never publish
          // its predecessor task after the replacement has admitted new account lifetimes.
          assertStartCurrent();
          capabilityLease.assertActive("startup");
          if (abort.signal.aborted || manuallyStopped.has(rKey) || opts.isClosing?.()) {
            startOutcomes.set(id, { status: "skipped", reason: "manual-stop" });
            return;
          }
          startChannelAccountTask(state, {
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
          });
          handedOffTask = true;
          startOutcomes.set(id, { status: "handed-off" });
        } catch (error) {
          if (!handedOffTask && capabilityLease.isActive()) {
            setStoppedRuntime(channelId, id, {
              restartPending: false,
              lastError: formatErrorMessage(error),
            });
          }
          throw error;
        } finally {
          if (!handedOffTask) {
            if (routeHandoff && capabilityLease.isActive()) {
              releaseRouteHandoff(store, id, routeHandoff);
            }
            capabilityLease.revoke();
            await cleanupTaskScopedApprovalRuntime("channel startup cleanup failed");
          }
          if (!handedOffTask && store.lifetimes.get(id) === lifetime && !store.stops.has(id)) {
            store.lifetimes.delete(id);
          }
          if (store.starting.get(id) === startGate.promise) {
            store.starting.delete(id);
          }
          startGate.resolve();
        }
      }),
    });
    if (startup.hasError) {
      throw startup.firstError;
    }
    return startOutcomes;
  };

  const startChannelInternal: ChannelManager["startChannel"] = (...args) =>
    runChannelAccountStartup(() =>
      withRegistry((registry) => startChannelProcessOwned(registry, ...args)),
    );

  return startChannelInternal;
}
