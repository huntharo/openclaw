import {
  diagnosticLogger as diag,
  logMessageQueued,
  logSessionStateChange,
} from "../logging/diagnostic.js";

type CodexAppServerQueueHandle = {
  queueMessage: (text: string) => Promise<boolean>;
  interrupt: () => Promise<void>;
  isStreaming: () => boolean;
  isAwaitingInput: () => boolean;
};

const ACTIVE_CODEX_RUNS = new Map<string, CodexAppServerQueueHandle>();
const ACTIVE_CODEX_RUNS_BY_SESSION_KEY = new Map<string, CodexAppServerQueueHandle>();

export function queueCodexAppServerMessage(sessionId: string, text: string): boolean {
  const handle = ACTIVE_CODEX_RUNS.get(sessionId);
  if (!handle) {
    return false;
  }
  if (!handle.isStreaming() && !handle.isAwaitingInput()) {
    return false;
  }
  logMessageQueued({ sessionId, source: "codex-app-server" });
  void handle.queueMessage(text);
  return true;
}

export function queueCodexAppServerMessageBySessionKey(sessionKey: string, text: string): boolean {
  const handle = ACTIVE_CODEX_RUNS_BY_SESSION_KEY.get(sessionKey);
  if (!handle) {
    return false;
  }
  if (!handle.isStreaming() && !handle.isAwaitingInput()) {
    return false;
  }
  logMessageQueued({ sessionId: sessionKey, source: "codex-app-server" });
  void handle.queueMessage(text);
  return true;
}

export function interruptCodexAppServerRun(sessionId: string): boolean {
  const handle = ACTIVE_CODEX_RUNS.get(sessionId);
  if (!handle) {
    return false;
  }
  void handle.interrupt();
  return true;
}

export function isCodexAppServerRunActive(sessionId: string): boolean {
  return ACTIVE_CODEX_RUNS.has(sessionId);
}

export function isCodexAppServerRunStreaming(sessionId: string): boolean {
  const handle = ACTIVE_CODEX_RUNS.get(sessionId);
  if (!handle) {
    return false;
  }
  return handle.isStreaming() || handle.isAwaitingInput();
}

export function setActiveCodexAppServerRun(
  sessionId: string,
  handle: CodexAppServerQueueHandle,
  sessionKey?: string,
) {
  const wasActive = ACTIVE_CODEX_RUNS.has(sessionId);
  ACTIVE_CODEX_RUNS.set(sessionId, handle);
  if (sessionKey?.trim()) {
    ACTIVE_CODEX_RUNS_BY_SESSION_KEY.set(sessionKey, handle);
  }
  logSessionStateChange({
    sessionId,
    sessionKey,
    state: "processing",
    reason: wasActive ? "run_replaced" : "run_started",
  });
  diag.debug(`codex run registered: sessionId=${sessionId} totalActive=${ACTIVE_CODEX_RUNS.size}`);
}

export function clearActiveCodexAppServerRun(
  sessionId: string,
  handle: CodexAppServerQueueHandle,
  sessionKey?: string,
) {
  if (ACTIVE_CODEX_RUNS.get(sessionId) !== handle) {
    return;
  }
  ACTIVE_CODEX_RUNS.delete(sessionId);
  if (sessionKey?.trim() && ACTIVE_CODEX_RUNS_BY_SESSION_KEY.get(sessionKey) === handle) {
    ACTIVE_CODEX_RUNS_BY_SESSION_KEY.delete(sessionKey);
  }
  logSessionStateChange({ sessionId, sessionKey, state: "idle", reason: "run_completed" });
  diag.debug(`codex run cleared: sessionId=${sessionId} totalActive=${ACTIVE_CODEX_RUNS.size}`);
}

export type { CodexAppServerQueueHandle };
