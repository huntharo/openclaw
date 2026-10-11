// Applies plugin middleware to agent tool results at runtime boundaries.
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareOptions,
  AgentToolResultMiddlewareRuntime,
  AgentToolResultMiddlewareScope,
} from "./agent-tool-result-middleware-types.js";
import type { PluginAgentToolResultMiddlewareRegistration } from "./registry-types.js";
import { getActivePluginRegistry } from "./runtime.js";
import {
  createPluginToolMatcherScope,
  normalizePluginToolMatcher,
  pluginToolMatcherCoversTool,
  type PluginToolMatcherScope,
} from "./tool-hook-matcher.js";

const AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES = [
  "openclaw",
  "codex",
  "agentsapi",
] as const satisfies AgentToolResultMiddlewareRuntime[];

const AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIME_SET = new Set<string>(
  AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIMES,
);

export function normalizeAgentToolResultMiddlewareBehavior(
  options?: AgentToolResultMiddlewareOptions,
  existingHandler?: AgentToolResultMiddleware,
): Readonly<{
  failureMode: "error" | "passthrough";
  originalTextMaxBytes?: number;
}> {
  const failureMode = options?.failureMode ?? "error";
  if (failureMode !== "error" && failureMode !== "passthrough") {
    throw new TypeError("Unknown tool-result middleware failure mode");
  }
  const originalTextMaxBytes = options?.originalTextMaxBytes;
  if (
    originalTextMaxBytes !== undefined &&
    (!Number.isSafeInteger(originalTextMaxBytes) ||
      originalTextMaxBytes < 1024 ||
      originalTextMaxBytes > 32 * 1024 * 1024)
  ) {
    throw new TypeError("originalTextMaxBytes must be 1024–33554432 bytes");
  }
  if (
    existingHandler &&
    (existingHandler.originalTextMaxBytes !== originalTextMaxBytes ||
      (existingHandler.failureMode ?? "error") !== failureMode)
  ) {
    throw new TypeError(
      "Repeated middleware registration must use the same original capture cap and failure mode",
    );
  }
  return Object.freeze({ failureMode, originalTextMaxBytes });
}

function normalizeAgentToolResultMiddlewareRuntime(
  runtime: string,
): AgentToolResultMiddlewareRuntime | undefined {
  const normalized = runtime.trim().toLowerCase();
  return AGENT_TOOL_RESULT_MIDDLEWARE_RUNTIME_SET.has(normalized)
    ? (normalized as AgentToolResultMiddlewareRuntime)
    : undefined;
}

export function normalizeAgentToolResultMiddlewareRuntimes(
  options?: AgentToolResultMiddlewareOptions,
  declaredRuntimes?: readonly string[],
): AgentToolResultMiddlewareRuntime[] {
  return normalizeAgentToolResultMiddlewareRuntimeIds(options?.runtimes ?? declaredRuntimes);
}
export function normalizeAgentToolResultMiddlewareRuntimeIds(
  runtimes: readonly string[] | undefined,
): AgentToolResultMiddlewareRuntime[] {
  const normalized: AgentToolResultMiddlewareRuntime[] = [];
  for (const runtime of runtimes ?? []) {
    const value = normalizeAgentToolResultMiddlewareRuntime(runtime);
    if (value && !normalized.includes(value)) {
      normalized.push(value);
    }
  }
  return normalized;
}

function sameMiddlewareScope(
  left: AgentToolResultMiddlewareScope,
  right: AgentToolResultMiddlewareScope,
): boolean {
  return (
    left.runtimes.length === right.runtimes.length &&
    left.runtimes.every((runtime) => right.runtimes.includes(runtime)) &&
    (left.matcher ?? []).length === (right.matcher ?? []).length &&
    (left.matcher ?? []).every((toolName) => right.matcher?.includes(toolName))
  );
}

function readAgentToolResultMiddlewareScopes(
  registration: PluginAgentToolResultMiddlewareRegistration,
): AgentToolResultMiddlewareScope[] {
  return registration.scopes?.length ? registration.scopes : [{ runtimes: registration.runtimes }];
}

export function appendAgentToolResultMiddlewareScope(
  registration: PluginAgentToolResultMiddlewareRegistration,
  scope: AgentToolResultMiddlewareScope,
): void {
  const normalizedMatcher = normalizePluginToolMatcher(scope.matcher);
  const normalizedScope: AgentToolResultMiddlewareScope = {
    runtimes: [...scope.runtimes],
    ...(normalizedMatcher ? { matcher: normalizedMatcher } : {}),
  };
  const scopes = readAgentToolResultMiddlewareScopes(registration);
  if (!scopes.some((existing) => sameMiddlewareScope(existing, normalizedScope))) {
    registration.scopes = [...scopes, normalizedScope];
  } else if (!registration.scopes) {
    registration.scopes = scopes;
  }
  registration.runtimes = normalizeAgentToolResultMiddlewareRuntimeIds(
    readAgentToolResultMiddlewareScopes(registration).flatMap((entry) => entry.runtimes),
  );
}

export function agentToolResultMiddlewareRegistrationCoversTool(
  registration: PluginAgentToolResultMiddlewareRegistration,
  runtime: AgentToolResultMiddlewareRuntime,
  toolName: string,
): boolean {
  return readAgentToolResultMiddlewareScopes(registration).some(
    (scope) =>
      scope.runtimes.includes(runtime) && pluginToolMatcherCoversTool(scope.matcher, toolName),
  );
}

export function getAgentToolResultMiddlewareMatcherScope(
  runtime: AgentToolResultMiddlewareRuntime,
): PluginToolMatcherScope | undefined {
  const matchers = (getActivePluginRegistry()?.agentToolResultMiddlewares ?? []).flatMap(
    (registration) =>
      readAgentToolResultMiddlewareScopes(registration)
        .filter((scope) => scope.runtimes.includes(runtime))
        .map((scope) => scope.matcher),
  );
  return createPluginToolMatcherScope(matchers);
}

export function listAgentToolResultMiddlewares(
  runtime: AgentToolResultMiddlewareRuntime,
): AgentToolResultMiddleware[] {
  return (
    getActivePluginRegistry()
      ?.agentToolResultMiddlewares?.filter((entry) => entry.runtimes.includes(runtime))
      .map((entry) => entry.handler) ?? []
  );
}

/** Producer capture is admitted only by a currently registered runtime consumer. */
export function getAgentToolResultOriginalCaptureBytes(
  runtime: AgentToolResultMiddlewareRuntime,
): number {
  return Math.max(
    0,
    ...listAgentToolResultMiddlewares(runtime).map((handler) => handler.originalTextMaxBytes ?? 0),
  );
}
