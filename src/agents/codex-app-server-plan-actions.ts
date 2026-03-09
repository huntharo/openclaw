import { createHash } from "node:crypto";

export type CodexPlanAction = "implement" | "stay";

const CALLBACK_PREFIX = "cdxpl";

function buildRequestToken(requestId: string): string {
  return createHash("sha1").update(requestId).digest("base64url").slice(0, 10);
}

function encodeAction(action: CodexPlanAction): string {
  return action === "implement" ? "y" : "n";
}

function decodeAction(code: string): CodexPlanAction | undefined {
  if (code === "y") {
    return "implement";
  }
  if (code === "n") {
    return "stay";
  }
  return undefined;
}

export function buildCodexPlanActionCallbackData(params: {
  requestId: string;
  action: CodexPlanAction;
}): string {
  return `${CALLBACK_PREFIX}:${encodeAction(params.action)}:${buildRequestToken(params.requestId)}`;
}

export function parseCodexPlanActionCallbackData(data: string): {
  action: CodexPlanAction;
  requestToken: string;
} | null {
  const trimmed = data.trim();
  if (!trimmed.startsWith(`${CALLBACK_PREFIX}:`)) {
    return null;
  }
  const match = trimmed.match(/^cdxpl:([yn]):([A-Za-z0-9_-]{6,64})$/);
  if (!match) {
    return null;
  }
  const action = decodeAction(match[1] ?? "");
  if (!action) {
    return null;
  }
  return {
    action,
    requestToken: match[2] ?? "",
  };
}

export function matchesCodexPlanActionRequestToken(
  requestId: string,
  requestToken: string,
): boolean {
  return buildRequestToken(requestId) === requestToken.trim();
}
