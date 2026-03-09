import {
  interruptCodexAppServerRun,
  isCodexAppServerRunActive,
  isCodexAppServerRunStreaming,
  queueCodexAppServerMessage,
  queueCodexAppServerMessageBySessionKey,
  submitCodexAppServerPendingInputBySessionKey,
} from "./codex-app-server-runs.js";
import {
  abortEmbeddedPiRun,
  isEmbeddedPiRunActive,
  isEmbeddedPiRunStreaming,
  queueEmbeddedPiMessage,
} from "./pi-embedded.js";

export function queueAgentRunMessage(sessionId: string, text: string): boolean {
  if (queueCodexAppServerMessage(sessionId, text)) {
    return true;
  }
  return queueEmbeddedPiMessage(sessionId, text);
}

export function queueAgentRunMessageBySessionKey(sessionKey: string, text: string): boolean {
  return queueCodexAppServerMessageBySessionKey(sessionKey, text);
}

export function submitAgentRunPendingInputBySessionKey(
  sessionKey: string,
  submission: { actionIndex: number },
): boolean {
  return submitCodexAppServerPendingInputBySessionKey(sessionKey, submission);
}

export function abortAgentRun(sessionId: string): boolean {
  const abortedCodex = interruptCodexAppServerRun(sessionId);
  const abortedEmbedded = abortEmbeddedPiRun(sessionId);
  return abortedCodex || abortedEmbedded;
}

export function isAgentRunActive(sessionId: string): boolean {
  return isCodexAppServerRunActive(sessionId) || isEmbeddedPiRunActive(sessionId);
}

export function isAgentRunStreaming(sessionId: string): boolean {
  return isCodexAppServerRunStreaming(sessionId) || isEmbeddedPiRunStreaming(sessionId);
}
