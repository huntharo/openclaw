import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayNativeApprovalRuntime } from "../../infra/approval-gateway-runtime.types.js";
import type { GatewayScheduler } from "../../infra/gateway-scheduler.js";
import type { SubsystemLogger } from "../../logging/subsystem.js";
import type { PluginRuntimeCapabilityLease } from "../../plugins/capability-lease.js";
import type { PluginHttpRouteHandoff } from "../../plugins/http-registry.js";
import type { PluginRegistry } from "../../plugins/registry.js";
import type { PluginRuntimeChannel } from "../../plugins/runtime/types-channel.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { ChannelGatewayContext } from "../plugins/types.adapters.js";
import type { ChannelAccountSnapshot, ChannelId, ChannelPlugin } from "../plugins/types.public.js";
import type {
  ChannelAccountStartOutcome,
  ChannelRuntimeSnapshot,
  ChannelRuntimeSnapshotOptions,
  StartChannelOptions,
} from "./snapshot.types.js";
import type { ChannelStartFence } from "./start-fence.js";

export type ChannelAccountLifetime = {
  plugin: ChannelPlugin;
  abort: AbortController;
  capabilityLease: PluginRuntimeCapabilityLease;
  teardown?: {
    context: Omit<ChannelGatewayContext, "setStatus">;
    run: NonNullable<NonNullable<ChannelPlugin["gateway"]>["stopAccount"]>;
  };
};

export type ChannelRuntimeStore = {
  startFence?: ChannelStartFence;
  lifetimes: Map<string, ChannelAccountLifetime>;
  routeHandoffs: Map<
    string,
    { handoff: PluginHttpRouteHandoff; parkedBy: AbortController; admittedSignal?: AbortSignal }
  >;
  starting: Map<string, Promise<void>>;
  stops: Map<string, ChannelAccountStopState>;
  tasks: Map<string, Promise<unknown>>;
  runtimes: Map<string, ChannelAccountSnapshot>;
};

export type ChannelAutostartSuppression = {
  reason: "crash-loop-breaker";
  message: string;
};

type GatewayStartupTrace = {
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
};

export type ChannelManagerOptions = {
  scheduler: GatewayScheduler;
  getRuntimeConfig: () => OpenClawConfig;
  getPluginRegistry: () => PluginRegistry;
  channelLogs: Partial<Record<ChannelId, SubsystemLogger>>;
  channelRuntimeEnvs: Partial<Record<ChannelId, RuntimeEnv>>;
  /** Supply the complete createPluginRuntime().channel surface; partial stubs are unsupported. */
  channelRuntime?: PluginRuntimeChannel;
  /** Resolve the same complete surface only when a channel account starts. */
  resolveChannelRuntime?: () => PluginRuntimeChannel | Promise<PluginRuntimeChannel>;
  startupTrace?: GatewayStartupTrace;
  deferStartupAccountStartsUntil?: Promise<void>;
  getNativeApprovalRuntime?: () => GatewayNativeApprovalRuntime | undefined;
  ambientAutostartSuppressedChannelIds?: ReadonlySet<string>;
  tryRecoverAutostartSuppression?: () => boolean;
  isClosing?: () => boolean;
};

export type StopChannelOptions = {
  manual?: boolean;
  routeHandoff?: boolean;
  /** Report unfinished cleanup to the caller after the bounded stop attempt. */
  strict?: boolean;
};

export type ChannelAccountStopOutcome =
  | { status: "fulfilled" }
  | { status: "rejected"; error: unknown };

type ChannelAccountStopState =
  | { status: "stopping"; attempt: Promise<ChannelAccountStopOutcome> }
  | Extract<ChannelAccountStopOutcome, { status: "rejected" }>;

export type ChannelManager = {
  getRuntimeSnapshot: (options?: ChannelRuntimeSnapshotOptions) => ChannelRuntimeSnapshot;
  pauseChannelStarts: (
    channelIds: Iterable<ChannelId>,
  ) => (outcome: "published" | "rollback" | "failed", channelIds?: ReadonlySet<ChannelId>) => void;
  startChannels: () => Promise<void>;
  startChannel: (
    channel: ChannelId,
    accountId?: string,
    opts?: StartChannelOptions,
  ) => Promise<ReadonlyMap<string, ChannelAccountStartOutcome>>;
  stopChannel: (channel: ChannelId, accountId?: string, opts?: StopChannelOptions) => Promise<void>;
  releaseChannelRouteHandoffs: (channel: ChannelId, accountId?: string) => void;
  setAutostartSuppression: (suppression: ChannelAutostartSuppression | null) => void;
  getAutostartSuppression: () => ChannelAutostartSuppression | null;
  recoverAutostartSuppression: () => Promise<boolean>;
  setAmbientAutostartSuppressedChannelIds: (channelIds: ReadonlySet<string>) => void;
  isAmbientAutostartSuppressed: (channelId: string) => boolean;
  markChannelLoggedOut: (channelId: ChannelId, cleared: boolean, accountId?: string) => void;
  isManuallyStopped: (channelId: ChannelId, accountId: string) => boolean;
  isAccountListed: (channelId: ChannelId, accountId: string) => boolean;
  isAutoRestartScheduled: (channelId: ChannelId, accountId: string) => boolean;
  resetRestartAttempts: (channelId: ChannelId, accountId: string) => void;
  isHealthMonitorEnabled: (channelId: ChannelId, accountId: string) => boolean;
};
