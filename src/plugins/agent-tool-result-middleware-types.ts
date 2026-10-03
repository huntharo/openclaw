import type { AgentToolResult } from "../../packages/agent-core/src/types.js";
import type { PluginToolMatcher } from "./hook-types.js";

export type OpenClawAgentToolResult<TResult = unknown> = AgentToolResult<TResult>;

export type AgentToolResultMiddlewareRuntime = "openclaw" | "codex" | "agentsapi";

export type AgentToolResultMiddlewareEvent = {
  threadId?: string;
  turnId?: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  cwd?: string;
  isError?: boolean;
  result: OpenClawAgentToolResult;
  /** Opt-in, immutable text-only snapshot before middleware normalization. No native details. */
  originalTextContent?: readonly Readonly<{ type: "text"; text: string }>[];
  /** Producer capture completeness; false prevents retention of a truncated view. */
  originalCaptureComplete?: boolean;
  /** Accepted nested calls, only on a complete terminal Code Mode result. */
  originalTextMembers?: readonly Readonly<{
    toolCallId: string;
    toolName: string;
    args: Readonly<Record<string, unknown>>;
    content: readonly Readonly<{ type: "text"; text: string }>[];
  }>[];
};

export type AgentToolResultMiddlewareContext = {
  runtime: AgentToolResultMiddlewareRuntime;
  agentId?: string;
  sessionId?: string;
  sessionKey?: string;
  runId?: string;
  /** Observe-only native relays cannot replace the model's tool response. */
  resultVisibility?: "model" | "observe";
  /** Host-prepared transcript policy. Absence is unknown, not permission to persist. */
  persistence?: "durable" | "ephemeral";
  /** Captured current task, without replaying or rewriting conversation history. */
  task?: string;
  /** Actual admitted callable tool names, including enabled deferred catalog entries. */
  toolNames?: readonly string[];
  signal?: AbortSignal;
  /** Optional for legacy callers; retained continuations must require this capability. */
  assertCurrent?: () => void;
};

export type AgentToolResultMiddlewareProjection = {
  /** Final synchronous participant fence before selection notifications and publication. */
  assertCurrent?: () => void;
  /** Called after the caller's final projection and validation, before publication. */
  select: (result: OpenClawAgentToolResult) => Promise<boolean>;
  /** Notification after every selector succeeds; it cannot change the selected result. */
  selected?: () => void;
  /** Release a staged original when selection fails. Cleanup never grants new authority. */
  discard: () => Promise<void>;
};

export type AgentToolResultMiddlewareResult = {
  result: OpenClawAgentToolResult;
  /** Optional settlement for a persist-before-project replacement. Legacy handlers are unchanged. */
  projection?: AgentToolResultMiddlewareProjection;
};

export type AgentToolResultMiddleware = ((
  event: AgentToolResultMiddlewareEvent,
  ctx: AgentToolResultMiddlewareContext,
) => Promise<AgentToolResultMiddlewareResult | void> | AgentToolResultMiddlewareResult | void) & {
  /** Host-normalized registration fact; consumers request it through registration options. */
  readonly originalTextMaxBytes?: number;
  readonly failureMode?: "error" | "passthrough";
};

export type AgentToolResultMiddlewareOptions = {
  matcher?: PluginToolMatcher;
  /** Defaults to the plugin's contracts.agentToolResultMiddleware declaration. */
  runtimes?: AgentToolResultMiddlewareRuntime[];
  /** Request exact text-only capture; over-budget/mixed output supplies no original snapshot. */
  originalTextMaxBytes?: number;
  /** Handler failure/timeout policy; legacy default is error. */
  failureMode?: "error" | "passthrough";
};

export type AgentToolResultMiddlewareScope = {
  matcher?: PluginToolMatcher;
  runtimes: AgentToolResultMiddlewareRuntime[];
};
