import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import type { AgentToolResultMiddlewareContext } from "../../plugins/agent-tool-result-middleware-types.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";

export type AgentToolResultPolicy = Pick<
  AgentToolResultMiddlewareContext,
  "persistence" | "task" | "signal" | "assertCurrent"
>;

/** Only the admitted transcript owner selects persistence; plugin request strings cannot. */
export function captureAgentToolResultPolicy(params: {
  target?: Partial<SessionTranscriptRuntimeTarget>;
  detached?: boolean;
  task?: string;
  signal?: AbortSignal;
  assertCurrent?: () => void;
}): AgentToolResultPolicy {
  const { target, detached, task, signal, assertCurrent } = params;
  return {
    persistence:
      !detached &&
      target?.agentId &&
      target.sessionId &&
      target.sessionKey &&
      target.storePath &&
      !isIncognitoSessionKey(target.sessionKey)
        ? "durable"
        : "ephemeral",
    task,
    signal,
    assertCurrent,
  };
}
