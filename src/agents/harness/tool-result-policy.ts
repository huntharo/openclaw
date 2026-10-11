import { isDeepStrictEqual } from "node:util";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import {
  sameSessionTranscriptTargetBinding,
  type SessionTranscriptTargetBinding,
} from "../../config/sessions/transcript-target-binding.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import type { AgentToolResultMiddlewareContext } from "../../plugins/agent-tool-result-middleware-types.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveAdmittedRunActiveAssertion } from "../admitted-run-context.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { cloneHostSnapshot } from "./host-snapshot.js";

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

export function captureHostToolResultPolicy(
  attempt: Pick<
    Partial<EmbeddedRunAttemptParams>,
    "sessionTarget" | "sessionPersistence" | "prompt" | "abortSignal"
  >,
  assertActive: () => void,
): AgentToolResultPolicy {
  const target = attempt.sessionTarget ? cloneHostSnapshot(attempt.sessionTarget) : undefined;
  const assertTranscript = target ? captureOwnedTranscriptWriteAssertion(target) : undefined;
  return captureAgentToolResultPolicy({
    target: attempt.sessionTarget,
    detached: attempt.sessionPersistence === "detached",
    task: attempt.prompt,
    signal: attempt.abortSignal,
    assertCurrent: () => {
      assertActive();
      assertTranscript?.();
      if (!isDeepStrictEqual(attempt.sessionTarget, target)) {
        throw new Error("Tool-result middleware lost its source transcript.");
      }
    },
  });
}

export function captureEmbeddedToolResultAssertion(params: {
  admittedRunContext: Parameters<typeof resolveAdmittedRunActiveAssertion>[0];
  signal: AbortSignal;
  readTarget: () => SessionTranscriptTargetBinding | undefined;
}): (() => void) | undefined {
  const target = params.readTarget();
  const assertRun = resolveAdmittedRunActiveAssertion(params.admittedRunContext, params.signal);
  const assertTranscript = target ? captureOwnedTranscriptWriteAssertion(target) : undefined;
  return assertRun
    ? () => {
        assertRun();
        params.signal.throwIfAborted();
        assertTranscript?.();
        if (!sameSessionTranscriptTargetBinding(target, params.readTarget())) {
          throw new Error("Tool-result middleware lost its transcript binding.");
        }
      }
    : undefined;
}
