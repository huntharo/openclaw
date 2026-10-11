import { formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { readStringField as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CodexAppServerClient } from "./client.js";
import {
  isJsonObject,
  type CodexThreadForkParams,
  type JsonObject,
  type JsonValue,
} from "./protocol.js";
import { formatCodexUsageLimitErrorMessage } from "./rate-limits.js";

export async function forkCodexSideThread(
  client: CodexAppServerClient,
  params: CodexThreadForkParams,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<unknown> {
  try {
    return await client.request("thread/fork", params, options);
  } catch (error) {
    if (isMissingCodexParentThreadError(error)) {
      throw new Error(
        "Codex /btw needs an active Codex thread. Send a normal message first, then try /btw again.",
        { cause: error },
      );
    }
    throw error;
  }
}

function isMissingCodexParentThreadError(error: unknown): boolean {
  const message = formatErrorMessage(error);
  return (
    message.includes("no rollout found for thread id") ||
    message.includes("includeTurns is unavailable before first user message")
  );
}

export function formatCodexErrorMessage(
  params: JsonObject,
  rateLimits: JsonValue | undefined,
): Error {
  const error = isJsonObject(params.error) ? params.error : undefined;
  const message =
    formatCodexUsageLimitErrorMessage({
      message: error ? readString(error, "message") : undefined,
      codexErrorInfo: error?.codexErrorInfo,
      rateLimits,
    }) ??
    (error ? (readString(error, "message") ?? readString(error, "error")) : undefined) ??
    readString(params, "message") ??
    "Codex /btw side thread failed.";
  return new Error(formatErrorMessage(message));
}
