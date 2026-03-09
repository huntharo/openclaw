import crypto from "node:crypto";

export type CodexReviewAction = {
  label: string;
  prompt: string;
};

const CALLBACK_PREFIX = "cdxrv";

function buildRequestToken(requestId: string): string {
  return crypto.createHash("sha1").update(requestId).digest("base64url").slice(0, 10);
}

export function buildCodexReviewActionCallbackData(params: {
  requestId: string;
  actionIndex: number;
}): string {
  return `${CALLBACK_PREFIX}:${params.actionIndex.toString(36)}:${buildRequestToken(params.requestId)}`;
}

export function parseCodexReviewActionCallbackData(data: string): {
  actionIndex: number;
  requestToken: string;
} | null {
  const trimmed = data.trim();
  if (!trimmed.startsWith(`${CALLBACK_PREFIX}:`)) {
    return null;
  }
  const match = trimmed.match(/^cdxrv:([0-9a-z]+):([A-Za-z0-9_-]{6,20})$/);
  if (!match) {
    return null;
  }
  const actionIndex = Number.parseInt(match[1] ?? "", 36);
  if (!Number.isInteger(actionIndex) || actionIndex < 0) {
    return null;
  }
  return {
    actionIndex,
    requestToken: match[2] ?? "",
  };
}

export function matchesCodexReviewActionRequestToken(
  requestId: string,
  requestToken: string,
): boolean {
  return buildRequestToken(requestId) === requestToken;
}
