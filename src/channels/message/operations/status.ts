import { ErrorCodes, errorShape, validateChannelsStatusParams } from "../../../../packages/gateway-protocol/src/index.js";
import { raceWithTimeout } from "../../../../packages/retry/src/index.js";
import { resolveChannelAccount } from "../../account-resolution.js";
import { redactChannelStatusSummaryBaseUrl } from "../../account-snapshot-fields.js";
import { buildChannelAccountSnapshotFromInspection, buildChannelAccountSnapshotFromRuntime } from "../../account-summary.js";
import { buildChannelUiCatalog } from "../../plugins/catalog.js";
import { resolveChannelDefaultAccountId } from "../../plugins/helpers.js";
import { type ChannelId, normalizeChannelId } from "../../plugins/index.js";
import { listReadOnlyChannelPluginsForConfigAsync } from "../../plugins/read-only.js";
import { buildChannelAccountSnapshotFromAccount } from "../../plugins/status.js";
import type { AnyChannelPlugin as ChannelPlugin } from "../../plugins/types.plugin.js";
import type { ChannelAccountSnapshot } from "../../plugins/types.public.js";
import { resolveUnavailableChannelAccountSnapshot } from "../../status/account-state.js";
import { getChannelActivity } from "../../../infra/channel-activity.js";
import { DEFAULT_ACCOUNT_ID } from "../../../routing/session-key.js";
import { isAccountEnabled } from "../../../shared/account-enabled.js";
import { runTasksWithConcurrency } from "../../../utils/run-with-concurrency.js";
import { DEFAULT_CHANNEL_CONNECT_GRACE_MS, DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS, resolveChannelHealthState } from "../../status/health-policy.js";
import { formatForLog } from "../../../gateway/ws-log.js";
import { resolveRuntimeAccountSnapshot } from "./account.js";
import { collectGatewayChannelStatusIssues } from "./status-issues.js";
import type { GatewayRequestHandlers } from "../../../gateway/server-methods/types.js";
import { assertValidParams } from "../../../gateway/server-methods/validation.js";

const CHANNEL_STATUS_MAX_TIMEOUT_MS = 30_000;
const CHANNEL_STATUS_PROBE_CONCURRENCY = 5;

type ChannelStatusResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; timedOut?: boolean };

async function runChannelStatusHook<T>(params: {
  accountId?: string;
  channelId: ChannelId;
  step: "audit" | "probe" | "summary" | "status";
  timeoutMs?: number;
  warnings: string[];
  run: () => T | Promise<T>;
}): Promise<ChannelStatusResult<T>> {
  const timeoutMs = params.timeoutMs;
  const warningPrefix = `${params.channelId}${params.accountId === undefined ? "" : `:${params.accountId}`} ${params.step}`;
  try {
    // Plugin hooks can be slow or fail independently; keep the remaining status usable.
    const pending: Promise<ChannelStatusResult<T>> = Promise.resolve()
      .then(params.run)
      .then((value): ChannelStatusResult<T> => ({ ok: true, value }));
    const result =
      timeoutMs === undefined
        ? await pending
        : await raceWithTimeout(
            pending,
            timeoutMs,
            (): ChannelStatusResult<T> => ({
              ok: false,
              timedOut: true,
              error: `${params.step} timed out after ${timeoutMs}ms`,
            }),
            { ref: false },
          );
    if (!result.ok) {
      params.warnings.push(`${warningPrefix} timed out after ${timeoutMs}ms`);
    }
    return result;
  } catch (error) {
    const message = formatForLog(error);
    params.warnings.push(`${warningPrefix} failed: ${message}`);
    return { ok: false, error: message };
  }
}

function channelStatusFailureMessage(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.ok !== false || typeof record.error !== "string" || record.error.length === 0) {
    return null;
  }
  return record.error;
}

export const channelStatusOperation: GatewayRequestHandlers[string] = async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateChannelsStatusParams, "channels.status", respond)) {
      return;
    }
    const probe = params.probe === true;
    const timeoutMs = Math.min(
      Math.max(1000, params.timeoutMs ?? (probe ? CHANNEL_STATUS_MAX_TIMEOUT_MS : 10_000)),
      CHANNEL_STATUS_MAX_TIMEOUT_MS,
    );
    const rawChannel = params.channel;
    const cfg = context.getRuntimeConfig();
    const plugins = await listReadOnlyChannelPluginsForConfigAsync(cfg);
    const requestedChannel =
      rawChannel !== undefined
        ? (normalizeChannelId(rawChannel) ??
          plugins.find((plugin) => plugin.id === rawChannel.trim().toLowerCase())?.id)
        : undefined;
    const selectedPlugins = requestedChannel
      ? plugins.filter((plugin) => plugin.id === requestedChannel)
      : plugins;
    // Preserve registry-defined UI order while stabilizing keyed status maps for prompt-cache input.
    const statusPlugins = selectedPlugins.toSorted((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    );
    if (rawChannel !== undefined && !requestedChannel) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown channel: ${formatForLog(rawChannel)}`),
      );
      return;
    }
    const runtime = context.getRuntimeSnapshot({
      channelId: requestedChannel,
      inspectAccounts: false,
    });
    const statusWarnings: string[] = [];

    const buildAccountSnapshot = async (
      channelId: ChannelId,
      plugin: ChannelPlugin,
      accountId: string,
      listed: boolean,
      remainingBudget?: () => number,
    ) => {
      const runtimeSnapshot = resolveRuntimeAccountSnapshot({ runtime, channelId, accountId });
      if (!listed && runtimeSnapshot) {
        const snapshot = buildChannelAccountSnapshotFromRuntime(runtimeSnapshot);
        return {
          accountId,
          snapshot:
            resolveUnavailableChannelAccountSnapshot(cfg, {
              channelId,
              accountId,
              runtime: snapshot,
            }) ?? snapshot,
        };
      }
      const unavailable = resolveUnavailableChannelAccountSnapshot(cfg, {
        channelId,
        accountId,
        runtime: runtimeSnapshot,
      });
      const diagnosticSnapshot =
        unavailable ?? (runtimeSnapshot?.enabled === false ? runtimeSnapshot : undefined);
      if (diagnosticSnapshot) {
        return { accountId, snapshot: diagnosticSnapshot };
      }
      if (!remainingBudget) {
        return {
          accountId,
          snapshot: buildChannelAccountSnapshotFromInspection({
            account: plugin.config.inspectAccount?.(cfg, accountId),
            accountId,
            runtime: runtimeSnapshot,
          }),
        };
      }
      remainingBudget();
      const account = await resolveChannelAccount({ plugin, cfg, accountId });
      remainingBudget();
      const enabled = plugin.config.isEnabled?.(account, cfg) ?? isAccountEnabled(account);
      let probeResult: unknown;
      let auditResult: unknown;
      let lastProbeAt: number | null = null;
      for (const step of ["probe", "audit"] as const) {
        if (!enabled || !plugin.status?.[`${step}Account`]) {
          continue;
        }
        // Recheck configuration for each hook, including after an awaited probe.
        remainingBudget();
        if (plugin.config.isConfigured && !(await plugin.config.isConfigured(account, cfg))) {
          continue;
        }
        remainingBudget();
        const result = await runChannelStatusHook({
          channelId,
          accountId,
          step,
          warnings: statusWarnings,
          run: () => {
            return plugin.status![`${step}Account`]!({
              account,
              timeoutMs: remainingBudget(),
              cfg,
              ...(step === "audit" ? { probe: probeResult } : {}),
            });
          },
        });
        if (step === "probe") {
          probeResult = result.ok ? result.value : result;
          lastProbeAt = Date.now();
        } else {
          auditResult = result.ok ? result.value : result;
        }
      }
      remainingBudget();
      const snapshot = await buildChannelAccountSnapshotFromAccount({
        plugin,
        cfg,
        accountId,
        account,
        runtime: runtimeSnapshot,
        probe: probeResult,
        audit: auditResult,
        assertActive: remainingBudget,
      });
      const hookError =
        channelStatusFailureMessage(auditResult) ?? channelStatusFailureMessage(probeResult);
      if (hookError && !snapshot.lastError) {
        snapshot.lastError = hookError;
      }
      if (lastProbeAt) {
        snapshot.lastProbeAt = lastProbeAt;
      }
      return { accountId, account, snapshot };
    };

    const buildChannelAccounts = async (plugin: ChannelPlugin, remainingBudget?: () => number) => {
      const channelId = plugin.id;
      if (runtime.reloadingChannels?.has(channelId)) {
        const defaultAccount = runtime.channels[channelId];
        statusWarnings.push(
          `${channelId}: plugin runtime is paused for reload; reporting recorded account state`,
        );
        return {
          accounts: Object.values(runtime.channelAccounts[channelId] ?? {}),
          defaultAccountId: runtime.reloadingChannels.get(channelId) ?? DEFAULT_ACCOUNT_ID,
          defaultAccount,
          resolvedAccounts: {},
        };
      }
      const configuredAccountIds = plugin.config.listAccountIds(cfg);
      const configuredAccountIdSet = new Set(configuredAccountIds);
      const accountIds = [
        ...new Set([
          ...configuredAccountIds,
          ...Object.keys(runtime.channelAccounts[channelId] ?? {}),
        ]),
      ];
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin,
        cfg,
        accountIds: configuredAccountIds,
      });
      const resolvedAccounts: Record<string, unknown> = {};
      const { results } = await runTasksWithConcurrency({
        tasks: accountIds.map(
          (accountId) => async () =>
            await buildAccountSnapshot(
              channelId,
              plugin,
              accountId,
              configuredAccountIdSet.has(accountId),
              remainingBudget,
            ),
        ),
        limit: remainingBudget ? CHANNEL_STATUS_PROBE_CONCURRENCY : accountIds.length || 1,
        onTaskError: (error, index) => {
          const accountId = accountIds[index] ?? `account ${index + 1}`;
          statusWarnings.push(`${channelId}:${accountId} status failed: ${formatForLog(error)}`);
        },
      });
      const accounts: ChannelAccountSnapshot[] = [];
      for (const result of results) {
        if (result) {
          const { snapshot, accountId } = result;
          const activity = getChannelActivity({ channel: channelId as never, accountId });
          snapshot.lastInboundAt ??= activity.inboundAt;
          snapshot.lastOutboundAt ??= activity.outboundAt;
          snapshot.healthState = resolveChannelHealthState(snapshot, {
            channelId,
            now: Date.now(),
            staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
            channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
          });
          if ("account" in result) {
            resolvedAccounts[result.accountId] = result.account;
          }
          accounts.push(result.snapshot);
        }
      }
      const defaultAccount =
        accounts.find((entry) => entry.accountId === defaultAccountId) ??
        accounts.find((entry) => configuredAccountIdSet.has(entry.accountId));
      return { accounts, defaultAccountId, defaultAccount, resolvedAccounts };
    };

    const uiCatalog = buildChannelUiCatalog(selectedPlugins);
    const channelsMap: Record<string, unknown> = {};
    const accountsMap: Record<string, ChannelAccountSnapshot[]> = {};
    const defaultAccountIdMap: Record<string, string> = {};
    const payload: Record<string, unknown> = {
      ts: Date.now(),
      channelOrder: uiCatalog.order,
      channelLabels: uiCatalog.labels,
      channelDetailLabels: uiCatalog.detailLabels,
      channelSystemImages: uiCatalog.systemImages,
      channelMeta: uiCatalog.entries,
      ...(context.getEventLoopHealth ? { eventLoop: context.getEventLoopHealth() } : {}),
      channels: channelsMap,
      channelAccounts: accountsMap,
      channelDefaultAccountId: defaultAccountIdMap,
    };
    const { results: channelResults } = await runTasksWithConcurrency({
      tasks: statusPlugins.map((plugin) => async () => {
        const deadline = Date.now() + timeoutMs;
        const abort = probe ? new AbortController() : undefined;
        const remainingBudget = () => {
          abort?.signal.throwIfAborted();
          const remaining = deadline - Date.now();
          if (remaining <= 0) {
            throw new Error(`status timed out after ${timeoutMs}ms`);
          }
          return remaining;
        };
        const build = async (live: boolean, error?: string) => {
          const { accounts, defaultAccountId, defaultAccount, resolvedAccounts } =
            await buildChannelAccounts(plugin, live ? remainingBudget : undefined);
          if (error) {
            for (const account of accounts) {
              account.lastError ||= error;
            }
          }
          const fallbackSummary = (lastError = defaultAccount?.lastError) => ({
            ...(!live ? defaultAccount : undefined),
            configured: defaultAccount?.configured ?? (live ? false : undefined),
            ...(lastError ? { lastError } : {}),
          });
          let summary: unknown = fallbackSummary();
          if (
            Date.now() < deadline &&
            plugin.status?.buildChannelSummary &&
            Object.hasOwn(resolvedAccounts, defaultAccountId)
          ) {
            const summaryResult = await runChannelStatusHook({
              step: "summary",
              channelId: plugin.id,
              warnings: statusWarnings,
              run: () => {
                remainingBudget();
                return plugin.status!.buildChannelSummary!({
                  account: resolvedAccounts[defaultAccountId],
                  cfg,
                  defaultAccountId,
                  snapshot: defaultAccount ?? { accountId: defaultAccountId },
                });
              },
            });
            summary = summaryResult.ok
              ? redactChannelStatusSummaryBaseUrl(summaryResult.value)
              : fallbackSummary(summaryResult.error);
          }
          return { pluginId: plugin.id, summary, accounts, defaultAccountId };
        };
        if (!probe) {
          return await build(false);
        }
        // Include credential resolution and snapshot hooks in the same channel budget.
        const result = await runChannelStatusHook({
          step: "status",
          channelId: plugin.id,
          timeoutMs,
          warnings: statusWarnings,
          run: () => build(true),
        });
        if (result.ok && Date.now() < deadline) {
          return result.value;
        }
        abort?.abort();
        const error = result.ok ? `status timed out after ${timeoutMs}ms` : result.error;
        if (result.ok) {
          statusWarnings.push(`${plugin.id} ${error}`);
        }
        return await build(false, error);
      }),
      limit: probe ? CHANNEL_STATUS_PROBE_CONCURRENCY : selectedPlugins.length || 1,
      onTaskError: (error, index) => {
        const channelId = statusPlugins[index]?.id ?? `channel ${index + 1}`;
        statusWarnings.push(`${channelId} channel status failed: ${formatForLog(error)}`);
      },
    });
    for (const result of channelResults) {
      if (result) {
        channelsMap[result.pluginId] = result.summary;
        accountsMap[result.pluginId] = result.accounts;
        defaultAccountIdMap[result.pluginId] = result.defaultAccountId;
      }
    }
    payload.statusIssues = collectGatewayChannelStatusIssues({
      payload,
      plugins: statusPlugins,
      reloadingChannels: runtime.reloadingChannels,
      defaultAccountIds: defaultAccountIdMap,
      context,
      warnings: statusWarnings,
    });
    if (statusWarnings.length > 0) {
      payload.partial = true;
      payload.warnings = statusWarnings.toSorted().slice(0, 50);
    }

    respond(true, payload, undefined);
  };
