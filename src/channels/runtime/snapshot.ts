import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { isAccountEnabled } from "../../shared/account-enabled.js";
import { projectSafeChannelAccountSnapshotFields } from "../account-snapshot-fields.js";
import {
  buildChannelAccountSnapshotFromInspection,
  buildChannelAccountSnapshotFromRuntime,
} from "../account-summary.js";
import { resolveChannelDefaultAccountId } from "../plugins/helpers.js";
import { listLoadedChannelPluginsForRegistry } from "../plugins/registry-loaded.js";
import type { ChannelAccountSnapshot, ChannelId, ChannelPlugin } from "../plugins/types.public.js";
import {
  applyChannelAccountState,
  resolveChannelAccountState,
  resolveUnavailableChannelAccountSnapshot,
} from "../status/account-state.js";
import type { ChannelRuntimeSnapshot, ChannelRuntimeSnapshotOptions } from "./snapshot.types.js";
import type { ChannelRuntimeState } from "./state.js";
export function createChannelSnapshotReader(state: ChannelRuntimeState) {
  const { getRuntimeConfig, getPluginRegistry, getStore } = state;
  const captureChannelSnapshot = (plugin: ChannelPlugin, inspectAccounts = true) => {
    const channelId = plugin.id;
    const store = getStore(channelId);
    const cfg = getRuntimeConfig();
    const registry = getPluginRegistry();
    const configuredAccountIds = [...plugin.config.listAccountIds(cfg)];
    const configuredAccountIdSet = new Set(configuredAccountIds);
    const accountIds = [...new Set([...configuredAccountIds, ...store.lifetimes.keys()])];
    const defaultAccountId = resolveChannelDefaultAccountId({
      plugin,
      cfg,
      accountIds: configuredAccountIds,
    });
    const defaultRuntime = { ...plugin.status?.defaultRuntime };
    const accounts = accountIds.map((id) => {
      const initial = { ...defaultRuntime, accountId: id };
      const runtime = () => {
        const current = store.runtimes.get(id) ?? initial;
        return configuredAccountIdSet.has(id)
          ? current
          : buildChannelAccountSnapshotFromRuntime(current);
      };
      let project = (current: ChannelAccountSnapshot) => ({ ...current });
      if (
        configuredAccountIdSet.has(id) &&
        inspectAccounts &&
        !resolveUnavailableChannelAccountSnapshot(cfg, {
          registry,
          channelId,
          accountId: id,
          runtime: runtime(),
        })
      ) {
        const inspected = plugin.config.inspectAccount?.(cfg, id);
        if (inspected) {
          const record = asNullableRecord(inspected);
          // Copy diagnostic facts while admitted; no plugin object or getter is read after fencing.
          const account = {
            ...projectSafeChannelAccountSnapshotFields(inspected),
            accountId: record?.accountId,
            enabled: record?.enabled,
            configured: record?.configured,
            stateReason: record?.stateReason,
          };
          project = (current) =>
            buildChannelAccountSnapshotFromInspection({
              account,
              accountId: id,
              runtime: current,
            });
        } else if (!plugin.config.resolveAccountAsync) {
          const account = plugin.config.resolveAccount(cfg, id);
          const enabled = plugin.config.isEnabled
            ? plugin.config.isEnabled(account, cfg)
            : isAccountEnabled(account);
          const described = plugin.config.describeAccount?.(account, cfg);
          const configured = described?.configured;
          const linked = described?.linked;
          const mode = described?.mode;
          const hasLinkCheck = Boolean(plugin.config.isLinked);
          const reasons = {
            disabledReason: plugin.config.disabledReason?.(account, cfg),
            unconfiguredReason: plugin.config.unconfiguredReason?.(account, cfg),
            unlinkedReason: plugin.config.unlinkedReason?.(account, cfg),
          };
          project = (current) => {
            const next = { ...current, accountId: id, enabled };
            applyChannelAccountState(
              next,
              resolveChannelAccountState({
                enabled,
                configured: configured ?? current.configured ?? true,
                linked:
                  hasLinkCheck || typeof current.linked === "boolean" ? current.linked : linked,
                runtime: current,
                ...reasons,
              }),
            );
            if (mode !== undefined) {
              next.mode = mode;
            }
            return next;
          };
        }
      }
      const read = () => {
        const current = runtime();
        return (
          resolveUnavailableChannelAccountSnapshot(getRuntimeConfig(), {
            registry: getPluginRegistry(),
            channelId,
            accountId: id,
            runtime: current,
          }) ?? project(current)
        );
      };
      return { id, read };
    });
    return {
      listedAccountIds: configuredAccountIdSet,
      read: () => {
        const snapshots = Object.fromEntries(accounts.map(({ id, read }) => [id, read()]));
        return {
          accounts: snapshots,
          defaultAccountId,
          defaultAccount: snapshots[defaultAccountId] ?? {
            ...defaultRuntime,
            accountId: defaultAccountId,
          },
        };
      },
    };
  };

  const getRuntimeSnapshot = (
    options: ChannelRuntimeSnapshotOptions = {},
  ): ChannelRuntimeSnapshot => {
    const { channelId, inspectAccounts = true } = options;
    const channels: ChannelRuntimeSnapshot["channels"] = {};
    const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};
    const reloadingChannels = new Map<ChannelId, string | undefined>();
    for (const plugin of listLoadedChannelPluginsForRegistry(getPluginRegistry())) {
      if (channelId !== undefined && plugin.id !== channelId) {
        continue;
      }
      const fence = getStore(plugin.id).startFence;
      const snapshot = (
        fence && fence.state !== "published"
          ? fence.snapshot
          : captureChannelSnapshot(plugin, inspectAccounts)
      )?.read();
      if (fence?.state === "paused") {
        reloadingChannels.set(plugin.id, snapshot?.defaultAccountId);
      }
      if (snapshot) {
        channels[plugin.id] = snapshot.defaultAccount;
        channelAccounts[plugin.id] = snapshot.accounts;
      }
    }
    return { channels, channelAccounts, reloadingChannels };
  };

  return { captureChannelSnapshot, getRuntimeSnapshot };
}
