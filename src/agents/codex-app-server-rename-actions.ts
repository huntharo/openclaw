export type CodexRenameTopicAction = "withProject" | "threadOnly";

const CALLBACK_PREFIX = "cdxrn";

function encodeAction(action: CodexRenameTopicAction): string {
  return action === "withProject" ? "p" : "t";
}

function decodeAction(code: string): CodexRenameTopicAction | undefined {
  if (code === "p") {
    return "withProject";
  }
  if (code === "t") {
    return "threadOnly";
  }
  return undefined;
}

export function buildCodexRenameActionCallbackData(params: {
  requestId: string;
  action: CodexRenameTopicAction;
}): string {
  return `${CALLBACK_PREFIX}:${encodeAction(params.action)}:${params.requestId.trim()}`;
}

export function parseCodexRenameActionCallbackData(data: string): {
  action: CodexRenameTopicAction;
  requestToken: string;
} | null {
  const trimmed = data.trim();
  if (!trimmed.startsWith(`${CALLBACK_PREFIX}:`)) {
    return null;
  }
  const match = trimmed.match(/^cdxrn:([pt]):([A-Za-z0-9_-]{6,64})$/);
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

export function matchesCodexRenameActionRequestToken(
  requestId: string,
  requestToken: string,
): boolean {
  return requestId.trim() === requestToken.trim();
}
