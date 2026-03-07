import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import WebSocket from "ws";
import type { OpenClawConfig } from "../config/config.js";
import { rawDataToString } from "../infra/ws.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  resolveCodexAppServerSettings,
  type CodexAppServerSettings,
} from "./codex-app-server-config.js";
import {
  buildCodexPendingInputButtons,
  buildCodexPendingUserInputActions,
  describeCodexPendingInputAction,
  type CodexPendingUserInputAction,
} from "./codex-app-server-pending-input.js";
import {
  clearActiveCodexAppServerRun,
  setActiveCodexAppServerRun,
  type CodexAppServerQueueHandle,
} from "./codex-app-server-runs.js";
import { normalizeProviderId } from "./model-selection.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner/types.js";
import { stableStringify } from "./stable-stringify.js";

const log = createSubsystemLogger("agent/codex-app-server");
const DEFAULT_PROTOCOL_VERSION = "1.0";
const TURN_STEER_METHODS = ["turn/steer"] as const;

type JsonRpcId = string | number;

type JsonRpcEnvelope = {
  jsonrpc?: string;
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type JsonRpcNotificationHandler = (method: string, params: unknown) => Promise<void> | void;
type JsonRpcRequestHandler = (method: string, params: unknown) => Promise<unknown>;

type JsonRpcClient = {
  connect: () => Promise<void>;
  close: () => Promise<void>;
  notify: (method: string, params?: unknown) => Promise<void>;
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  setNotificationHandler: (handler: JsonRpcNotificationHandler) => void;
  setRequestHandler: (handler: JsonRpcRequestHandler) => void;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

function isTransportClosedError(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.trim().toLowerCase();
  return (
    normalized.includes("stdio not connected") ||
    normalized.includes("websocket not connected") ||
    normalized.includes("stdio closed") ||
    normalized.includes("websocket closed") ||
    normalized.includes("socket closed") ||
    normalized.includes("broken pipe")
  );
}

export type ParsedCodexUserInput =
  | { kind: "option"; index: number }
  | { kind: "text"; text: string };

export type PendingCodexUserInputState = {
  requestId: string;
  options: string[];
  actions?: CodexPendingUserInputAction[];
  expiresAt: number;
  promptText?: string;
  method?: string;
};

type LivePendingCodexUserInputState = {
  requestId: string;
  methodLower: string;
  options: string[];
  actions: CodexPendingUserInputAction[];
  expiresAt: number;
  resolve: (value: unknown) => void;
  questionSummaries?: CodexUserInputQuestionSummary[];
  currentQuestionIndex?: number;
  answersByQuestionId?: Record<string, string[]>;
  promptText?: string;
  requestParams?: unknown;
};
export type CodexAppServerReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "custom"; instructions: string };

export type CodexAppServerReviewResult = {
  reviewText: string;
  reviewThreadId?: string;
  turnId?: string;
};

export type CodexAppServerCollaborationMode = {
  mode: string;
  settings?: {
    model?: string;
    reasoningEffort?: string;
    developerInstructions?: string | null;
  };
};

export type CodexAppServerThreadSummary = {
  threadId: string;
  title?: string;
  summary?: string;
  projectKey?: string;
  updatedAt?: number;
};

export type CodexAppServerThreadReplay = {
  lastUserMessage?: string;
  lastAssistantMessage?: string;
};

export type CodexAppServerModelSummary = {
  id: string;
  label?: string;
  description?: string;
  current?: boolean;
};

export type CodexAppServerSkillSummary = {
  cwd?: string;
  name: string;
  description?: string;
  enabled?: boolean;
};

export type CodexAppServerExperimentalFeatureSummary = {
  name: string;
  stage?: string;
  displayName?: string;
  description?: string;
  enabled?: boolean;
  defaultEnabled?: boolean;
};

export type CodexAppServerMcpServerSummary = {
  name: string;
  authStatus?: string;
  toolCount: number;
  resourceCount: number;
  resourceTemplateCount: number;
};

export type CodexAppServerThreadState = {
  threadId: string;
  threadName?: string;
  model?: string;
  modelProvider?: string;
  serviceTier?: string;
  cwd?: string;
  approvalPolicy?: string;
  sandbox?: string;
  reasoningEffort?: string;
};

export type CodexAppServerAccountSummary = {
  type?: "apiKey" | "chatgpt";
  email?: string;
  planType?: string;
  requiresOpenaiAuth?: boolean;
};

export type CodexAppServerRateLimitSummary = {
  name: string;
  limitId?: string;
  remaining?: number;
  limit?: number;
  used?: number;
  usedPercent?: number;
  // Epoch milliseconds normalized from the App Server rate-limit payload.
  resetAt?: number;
  windowSeconds?: number;
  windowMinutes?: number;
};

type RunCodexAppServerAgentParams = {
  sessionId: string;
  sessionKey?: string;
  prompt: string;
  imagePaths?: string[];
  model?: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  timeoutMs?: number;
  runId: string;
  existingThreadId?: string;
  collaborationMode?: CodexAppServerCollaborationMode;
  onPartialReply?: (payload: { text?: string }) => Promise<void> | void;
  onToolResult?: (payload: {
    text?: string;
    channelData?: Record<string, unknown>;
  }) => Promise<void> | void;
  onPendingUserInput?: (state: PendingCodexUserInputState | null) => Promise<void> | void;
  onInterrupted?: () => Promise<void> | void;
};

const OPTION_SELECTION_RE = /^\s*(?:option\s*)?([1-9]\d*)\s*$/i;

export function parseCodexUserInput(text: string, optionsCount: number): ParsedCodexUserInput {
  const normalized = text.trim();
  if (!normalized) {
    return { kind: "text", text: "" };
  }
  const match = normalized.match(OPTION_SELECTION_RE);
  if (!match) {
    return { kind: "text", text: normalized };
  }
  const oneBased = Number.parseInt(match[1] ?? "", 10);
  if (Number.isInteger(oneBased) && oneBased >= 1 && oneBased <= optionsCount) {
    return { kind: "option", index: oneBased - 1 };
  }
  return { kind: "text", text: normalized };
}

export function isCodexAppServerProvider(provider: string, cfg?: OpenClawConfig): boolean {
  if (normalizeProviderId(provider) !== "codex-app-server") {
    return false;
  }
  return cfg?.agents?.defaults?.codexAppServer?.enabled !== false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function pickString(
  record: Record<string, unknown>,
  keys: string[],
  options?: { trim?: boolean },
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") {
      continue;
    }
    const text = options?.trim === false ? value : value.trim();
    if (text) {
      return text;
    }
  }
  return undefined;
}

function pickNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function pickFiniteNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value.trim());
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function pickBoolean(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") {
        return true;
      }
      if (normalized === "false") {
        return false;
      }
    }
  }
  return undefined;
}

function collectText(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectText(entry));
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  const directKeys = [
    "text",
    "delta",
    "message",
    "prompt",
    "question",
    "summary",
    "title",
    "content",
    "description",
    "reason",
  ];
  const out = directKeys.flatMap((key) => collectText(record[key]));
  for (const nestedKey of ["item", "turn", "thread", "response", "result", "data", "questions"]) {
    out.push(...collectText(record[nestedKey]));
  }
  return out;
}

function findFirstNestedString(
  value: unknown,
  keys: readonly string[],
  nestedKeys: readonly string[] = keys,
  depth = 0,
): string | undefined {
  if (depth > 6) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findFirstNestedString(entry, keys, nestedKeys, depth + 1);
      if (match) {
        return match;
      }
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const direct = pickString(record, [...keys]);
  if (direct) {
    return direct;
  }
  for (const key of keys) {
    const nestedRecord = asRecord(record[key]);
    if (!nestedRecord) {
      continue;
    }
    const nested = pickString(nestedRecord, [...nestedKeys]);
    if (nested) {
      return nested;
    }
  }
  for (const nested of Object.values(record)) {
    const match = findFirstNestedString(nested, keys, nestedKeys, depth + 1);
    if (match) {
      return match;
    }
  }
  return undefined;
}

function findFirstArrayByKeys(
  value: unknown,
  keys: readonly string[],
  depth = 0,
): unknown[] | undefined {
  if (depth > 6) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findFirstArrayByKeys(entry, keys, depth + 1);
      if (match && match.length > 0) {
        return match;
      }
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const nested = record[key];
    if (Array.isArray(nested) && nested.length > 0) {
      return nested;
    }
  }
  for (const nested of Object.values(record)) {
    const match = findFirstArrayByKeys(nested, keys, depth + 1);
    if (match && match.length > 0) {
      return match;
    }
  }
  return undefined;
}

function findFirstNestedValue(value: unknown, keys: readonly string[], depth = 0): unknown {
  if (depth > 6) {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = findFirstNestedValue(entry, keys, depth + 1);
      if (match !== undefined) {
        return match;
      }
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    if (record[key] !== undefined) {
      return record[key];
    }
  }
  for (const nested of Object.values(record)) {
    const match = findFirstNestedValue(nested, keys, depth + 1);
    if (match !== undefined) {
      return match;
    }
  }
  return undefined;
}

function collectStreamingText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collectStreamingText(entry)).join("");
  }
  const record = asRecord(value);
  if (!record) {
    return "";
  }

  for (const key of ["delta", "text", "content", "message", "input", "output", "parts"]) {
    const direct = collectStreamingText(record[key]);
    if (direct) {
      return direct;
    }
  }
  for (const nestedKey of ["item", "turn", "thread", "response", "result", "data"]) {
    const nested = collectStreamingText(record[nestedKey]);
    if (nested) {
      return nested;
    }
  }
  return "";
}

function dedupeJoinedText(chunks: string[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const chunk of chunks.map((value) => value.trim()).filter(Boolean)) {
    if (seen.has(chunk)) {
      continue;
    }
    seen.add(chunk);
    out.push(chunk);
  }
  return out.join("\n\n").trim();
}

function extractIds(value: unknown): { threadId?: string; runId?: string; requestId?: string } {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  const threadRecord = asRecord(record.thread) ?? asRecord(record.session);
  const turnRecord = asRecord(record.turn) ?? asRecord(record.run);
  return {
    threadId:
      pickString(record, ["threadId", "thread_id", "conversationId", "conversation_id"]) ??
      pickString(threadRecord ?? {}, ["id", "threadId", "thread_id", "conversationId"]),
    runId:
      pickString(record, ["turnId", "turn_id", "runId", "run_id"]) ??
      pickString(turnRecord ?? {}, ["id", "turnId", "turn_id", "runId", "run_id"]),
    requestId:
      pickString(record, ["requestId", "request_id", "serverRequestId"]) ??
      pickString(asRecord(record.serverRequest) ?? {}, ["id", "requestId", "request_id"]),
  };
}

function mergeAssistantText(existing: string, incoming: string): { next: string; delta: string } {
  if (!incoming.trim()) {
    return { next: existing, delta: "" };
  }
  const nextChunk = incoming;
  if (!existing) {
    return { next: nextChunk.trimStart(), delta: nextChunk.trimStart() };
  }
  if (nextChunk.startsWith(existing)) {
    return { next: nextChunk, delta: nextChunk.slice(existing.length) };
  }
  if (existing.includes(nextChunk)) {
    return { next: existing, delta: "" };
  }
  return {
    next: `${existing}${nextChunk}`,
    delta: nextChunk,
  };
}

async function mergeAssistantReplyAndEmit(params: {
  assistantText: string;
  incomingText: string;
  onPartialReply?: (payload: { text?: string }) => Promise<void> | void;
}): Promise<string> {
  const merged = mergeAssistantText(params.assistantText, params.incomingText);
  if (merged.next !== params.assistantText) {
    await params.onPartialReply?.({ text: merged.next });
  }
  return merged.next;
}

function extractAssistantTextFromItemPayload(
  value: unknown,
  options?: { streaming?: boolean },
): string {
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  const item = asRecord(record.item) ?? record;
  const itemType = pickString(item, ["type"])?.toLowerCase();
  if (itemType !== "agentmessage") {
    return "";
  }
  return options?.streaming
    ? collectStreamingText(item)
    : (pickString(item, ["text"], { trim: false }) ?? collectStreamingText(item));
}

type AssistantNotificationText = {
  mode: "delta" | "snapshot" | "ignore";
  text: string;
  itemId?: string;
};

function extractAssistantItemId(value: unknown): string | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const item = asRecord(record.item) ?? record;
  return pickString(item, ["id", "itemId", "item_id", "messageId", "message_id"]);
}

function extractAssistantNotificationText(
  method: string,
  params: unknown,
): AssistantNotificationText {
  const methodLower = method.trim().toLowerCase();
  if (methodLower === "item/agentmessage/delta") {
    return {
      mode: "delta",
      text: collectStreamingText(params),
      itemId: extractAssistantItemId(params),
    };
  }
  if (methodLower === "item/completed") {
    return {
      mode: "snapshot",
      text: extractAssistantTextFromItemPayload(params),
      itemId: extractAssistantItemId(params),
    };
  }
  return { mode: "ignore", text: "" };
}

function extractOptionValues(value: unknown): string[] {
  const rawOptions = findFirstArrayByKeys(value, [
    "options",
    "choices",
    "availableDecisions",
    "decisions",
  ]);
  if (!rawOptions) {
    return [];
  }
  return rawOptions
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      return (
        pickString(asRecord(entry) ?? {}, ["label", "title", "text", "value", "name", "id"]) ?? ""
      );
    })
    .filter(Boolean);
}

type CodexUserInputQuestionSummary = {
  id: string;
  header?: string;
  question?: string;
  isOther?: boolean;
  options: Array<{
    label: string;
    description?: string;
    recommended?: boolean;
  }>;
};

function extractUserInputQuestionSummaries(value: unknown): CodexUserInputQuestionSummary[] {
  const record = asRecord(value);
  const rawQuestions = Array.isArray(record?.questions) ? record.questions : [];
  return rawQuestions
    .map((entry, index) => {
      const question = asRecord(entry);
      if (!question) {
        return null;
      }
      const rawOptions = Array.isArray(question.options) ? question.options : [];
      return {
        id: pickString(question, ["id"]) ?? `q${index + 1}`,
        header: pickString(question, ["header"]),
        question: pickString(question, ["question"]),
        isOther: question.isOther === true || question.is_other === true,
        options: rawOptions
          .map((option) => {
            const record = asRecord(option);
            if (!record) {
              return null;
            }
            const label = pickString(record, ["label", "title", "text"]);
            if (!label) {
              return null;
            }
            return {
              label,
              description: pickString(record, ["description", "details", "summary"]),
              recommended: /\(recommended\)/i.test(label),
            };
          })
          .filter(Boolean) as CodexUserInputQuestionSummary["options"],
      };
    })
    .filter(Boolean) as CodexUserInputQuestionSummary[];
}

function buildQuestionOptionActions(
  question: CodexUserInputQuestionSummary | undefined,
): CodexPendingUserInputAction[] {
  if (!question) {
    return [];
  }
  return question.options.map((option) => ({
    kind: "option",
    label: option.label,
    value: option.label,
  }));
}

function buildQuestionAnswerPayload(params: {
  questions: CodexUserInputQuestionSummary[];
  answersByQuestionId?: Record<string, string[]>;
}): unknown {
  const answers = Object.fromEntries(
    params.questions.map((question) => [
      question.id,
      { answers: params.answersByQuestionId?.[question.id] ?? [] },
    ]),
  );
  return { answers };
}

function resolvePendingInputSelectionValue(params: {
  parsed: ParsedCodexUserInput;
  options: string[];
  actions: CodexPendingUserInputAction[];
}): string {
  if (params.parsed.kind !== "option") {
    return params.parsed.text;
  }
  const action = params.actions[params.parsed.index];
  if (action?.kind === "approval") {
    return action.decision;
  }
  if (action?.kind === "option") {
    return action.value;
  }
  return params.options[params.parsed.index] ?? "";
}

function buildMarkdownCodeBlock(text: string, language = ""): string {
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return "";
  }
  const fenceMatches = [...normalized.matchAll(/`{3,}/g)];
  const longestFence = fenceMatches.reduce((max, match) => Math.max(max, match[0].length), 2);
  const fence = "`".repeat(longestFence + 1);
  const languageTag = language.trim();
  return `${fence}${languageTag}\n${normalized}\n${fence}`;
}

function buildPromptText(params: {
  method: string;
  requestId: string;
  options: string[];
  actions: CodexPendingUserInputAction[];
  question?: string;
  expiresAt: number;
  requestParams: unknown;
  activeQuestionIndex?: number;
}): string {
  const questions = extractUserInputQuestionSummaries(params.requestParams);
  const lines = [
    /requestapproval/i.test(params.method)
      ? `🧭 Codex approval requested (${params.requestId})`
      : `🧭 Codex input requested (${params.requestId})`,
  ];
  if (params.question && (/requestapproval/i.test(params.method) || questions.length === 0)) {
    lines.push(params.question);
  }
  const requestRecord = asRecord(params.requestParams);
  const command =
    findFirstNestedString(
      params.requestParams,
      ["command", "cmd", "displayCommand", "rawCommand", "shellCommand"],
      ["command", "cmd", "text", "value", "display", "raw"],
    ) ??
    (asRecord(requestRecord?.command)
      ? pickString(asRecord(requestRecord?.command)!, [
          "command",
          "text",
          "value",
          "display",
          "raw",
        ])
      : undefined);
  if (command) {
    lines.push("", "Command:", "", buildMarkdownCodeBlock(command, "sh"));
  }
  const cwd =
    findFirstNestedString(
      params.requestParams,
      ["cwd", "workdir", "workingDirectory", "working_directory"],
      ["cwd", "workdir", "workingDirectory", "working_directory"],
    ) ??
    (asRecord(requestRecord?.command)
      ? pickString(asRecord(requestRecord?.command)!, [
          "cwd",
          "workdir",
          "workingDirectory",
          "working_directory",
        ])
      : undefined);
  if (cwd) {
    lines.push("", `Cwd: ${cwd}`);
  }
  const approvalSessionAction = params.actions.find(
    (action) => action.kind === "approval" && action.decision === "acceptForSession",
  );
  if (approvalSessionAction?.kind === "approval" && approvalSessionAction.sessionPrefix) {
    lines.push("", `Session Prefix: ${approvalSessionAction.sessionPrefix}`);
  }
  if (!/requestapproval/i.test(params.method) && questions.length > 0) {
    const activeQuestionIndex = Math.min(
      Math.max(0, params.activeQuestionIndex ?? 0),
      questions.length - 1,
    );
    const activeQuestion = questions[activeQuestionIndex];
    lines.push(
      "",
      questions.length > 1
        ? `Question ${activeQuestionIndex + 1} of ${questions.length}:`
        : "Question:",
    );
    const heading =
      activeQuestion.header && activeQuestion.question
        ? `${activeQuestion.header}: ${activeQuestion.question}`
        : (activeQuestion.header ??
          activeQuestion.question ??
          `Question ${activeQuestionIndex + 1}`);
    lines.push(heading);
    if (activeQuestion.options.length > 0) {
      activeQuestion.options.forEach((option, optionIndex) => {
        lines.push(`${optionIndex + 1}. ${option.label}`);
        if (option.description) {
          lines.push(`   ${option.description}`);
        }
      });
    }
    if (activeQuestion.isOther) {
      lines.push("Other: You can reply with free text.");
    }
    lines.push("", 'Reply with "1", "2", "option 1", etc., or use a button.');
  } else if (params.actions.length > 0) {
    const numberedActions = params.actions.filter((action) => action.kind !== "steer");
    lines.push("", "Choices:");
    numberedActions.forEach((action, index) => {
      lines.push(`${index + 1}. ${describeCodexPendingInputAction(action)}`);
    });
    lines.push("", 'Reply with "1", "2", "option 1", etc., or use a button.');
    if (/requestapproval/i.test(params.method)) {
      lines.push("You can also reply with free text to tell Codex what to do instead.");
    }
  } else if (params.options.length > 0) {
    lines.push("", "Options:");
    params.options.forEach((option, index) => {
      lines.push(`${index + 1}. ${option}`);
    });
    lines.push("", 'Reply with "1", "2", "option 1", etc., or send free text.');
  } else {
    lines.push("Reply with a free-form response.");
  }
  const seconds = Math.max(1, Math.round((params.expiresAt - Date.now()) / 1000));
  lines.push(`Expires in: ${seconds}s`);
  const requestText =
    /requestapproval/i.test(params.method) || questions.length === 0
      ? dedupeJoinedText(collectText(params.requestParams))
      : "";
  if (requestText && !lines.includes(requestText)) {
    lines.push("", requestText);
  }
  if (/requestapproval/i.test(params.method)) {
    lines.push("", "Approval buttons send exact decisions back to Codex.");
  }
  return lines.join("\n");
}

function buildInteractiveRequestPresentation(params: {
  method: string;
  requestId: string;
  requestParams: unknown;
  question?: string;
  expiresAt: number;
  options: string[];
  activeQuestionIndex?: number;
  questionSummaries?: CodexUserInputQuestionSummary[];
}): {
  questionSummaries: CodexUserInputQuestionSummary[];
  currentQuestionIndex?: number;
  actions: CodexPendingUserInputAction[];
  options: string[];
  promptText: string;
} {
  const questionSummaries =
    params.questionSummaries ??
    (!/requestapproval/i.test(params.method)
      ? extractUserInputQuestionSummaries(params.requestParams)
      : []);
  const currentQuestionIndex =
    questionSummaries.length > 0
      ? Math.min(Math.max(0, params.activeQuestionIndex ?? 0), questionSummaries.length - 1)
      : undefined;
  const actions =
    currentQuestionIndex != null
      ? buildQuestionOptionActions(questionSummaries[currentQuestionIndex])
      : buildCodexPendingUserInputActions({
          method: params.method,
          requestParams: params.requestParams,
          options: params.options,
        });
  const options =
    currentQuestionIndex != null
      ? actions
          .filter(
            (action): action is Extract<CodexPendingUserInputAction, { kind: "option" }> =>
              action.kind === "option",
          )
          .map((action) => action.value)
      : params.options;
  const promptText = buildPromptText({
    method: params.method,
    requestId: params.requestId,
    options,
    actions,
    question: params.question,
    expiresAt: params.expiresAt,
    requestParams: params.requestParams,
    activeQuestionIndex: currentQuestionIndex,
  });
  return {
    questionSummaries,
    currentQuestionIndex,
    actions,
    options,
    promptText,
  };
}

function advancePendingQuestionnaire(params: {
  pendingInput: LivePendingCodexUserInputState;
  answerText: string;
}):
  | {
      done: true;
      response: unknown;
    }
  | {
      done: false;
      nextQuestionIndex: number;
      actions: CodexPendingUserInputAction[];
      options: string[];
      promptText: string;
    } {
  const questionSummaries = params.pendingInput.questionSummaries ?? [];
  if (questionSummaries.length === 0) {
    return { done: true, response: { text: params.answerText } };
  }
  const currentQuestionIndex = params.pendingInput.currentQuestionIndex ?? 0;
  const currentQuestion = questionSummaries[currentQuestionIndex];
  if (currentQuestion) {
    params.pendingInput.answersByQuestionId = {
      ...params.pendingInput.answersByQuestionId,
      [currentQuestion.id]: params.answerText ? [params.answerText] : [],
    };
  }
  const nextQuestionIndex = currentQuestionIndex + 1;
  if (nextQuestionIndex >= questionSummaries.length) {
    return {
      done: true,
      response: buildQuestionAnswerPayload({
        questions: questionSummaries,
        answersByQuestionId: params.pendingInput.answersByQuestionId,
      }),
    };
  }
  const nextState = buildInteractiveRequestPresentation({
    method: params.pendingInput.methodLower,
    requestId: params.pendingInput.requestId,
    requestParams: params.pendingInput.requestParams,
    expiresAt: params.pendingInput.expiresAt,
    options: params.pendingInput.options,
    activeQuestionIndex: nextQuestionIndex,
    questionSummaries,
  });
  return {
    done: false,
    nextQuestionIndex,
    actions: nextState.actions,
    options: nextState.options,
    promptText: nextState.promptText,
  };
}

function pickPendingSelectionText(
  value: unknown,
  options: string[],
  actions: CodexPendingUserInputAction[],
): string {
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  const index = typeof record.index === "number" ? record.index : undefined;
  if (index != null && Number.isInteger(index)) {
    const action = actions[index];
    if (action?.kind === "approval") {
      return action.decision;
    }
    if (action?.kind === "option") {
      return action.value;
    }
    return options[index] ?? "";
  }
  return pickString(record, ["option", "text", "value", "label"]) ?? "";
}

function pickPendingApprovalAction(
  value: unknown,
  actions: CodexPendingUserInputAction[],
): Extract<CodexPendingUserInputAction, { kind: "approval" }> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  const index = typeof record.index === "number" ? record.index : undefined;
  if (index == null || !Number.isInteger(index)) {
    return undefined;
  }
  const action = actions[index];
  return action?.kind === "approval" ? action : undefined;
}

function buildToolRequestUserInputResponse(
  requestParams: unknown,
  response: unknown,
  actions: CodexPendingUserInputAction[],
  answersByQuestionId?: Record<string, string[]>,
): unknown {
  const questions = extractUserInputQuestionSummaries(requestParams);
  if (questions.length === 0) {
    return response;
  }
  if (answersByQuestionId) {
    return buildQuestionAnswerPayload({
      questions,
      answersByQuestionId,
    });
  }
  const firstQuestion = questions[0];
  const selected = pickPendingSelectionText(
    response,
    firstQuestion?.options.map((option) => option.label) ?? [],
    actions,
  );
  return {
    answers: {
      [firstQuestion.id]: {
        answers: selected ? [selected] : [],
      },
    },
  };
}

function mapPendingInputResponse(params: {
  methodLower: string;
  requestParams: unknown;
  response: unknown;
  options: string[];
  actions: CodexPendingUserInputAction[];
  timedOut: boolean;
}): unknown {
  const { methodLower, requestParams, response, options, actions, timedOut } = params;
  if (methodLower.includes("item/tool/requestuserinput")) {
    return buildToolRequestUserInputResponse(
      requestParams,
      timedOut ? { text: "" } : response,
      actions,
    );
  }
  if (methodLower.includes("requestapproval")) {
    if (timedOut) {
      return { decision: "cancel" };
    }
    const selectedAction = pickPendingApprovalAction(response, actions);
    if (selectedAction) {
      return {
        decision: selectedAction.responseDecision,
        ...(selectedAction.proposedExecpolicyAmendment
          ? { proposedExecpolicyAmendment: selectedAction.proposedExecpolicyAmendment }
          : {}),
      };
    }
    const selected = pickPendingSelectionText(response, options, actions);
    return { decision: selected || "decline" };
  }
  if (timedOut) {
    return { cancelled: true, reason: "timeout" };
  }
  return response;
}

function isInteractiveServerRequest(method: string): boolean {
  const normalized = method.trim().toLowerCase();
  return normalized.includes("requestuserinput") || normalized.includes("requestapproval");
}

const TRAILING_NOTIFICATION_SETTLE_MS = 250;

function isMethodUnavailableError(error: unknown, method?: string): boolean {
  const text = error instanceof Error ? error.message : String(error);
  const normalized = text.toLowerCase();
  if (normalized.includes("method not found") || normalized.includes("unknown method")) {
    return true;
  }
  if (!normalized.includes("unknown variant")) {
    return false;
  }
  if (!method) {
    return true;
  }
  return normalized.includes(`unknown variant \`${method.toLowerCase()}\``);
}

class WsJsonRpcClient implements JsonRpcClient {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private counter = 0;
  private onNotification: JsonRpcNotificationHandler = () => undefined;
  private onRequest: JsonRpcRequestHandler = async () => ({});

  constructor(
    private readonly url: string,
    private readonly headers: Record<string, string> | undefined,
    private readonly requestTimeoutMs: number,
  ) {}

  setNotificationHandler(handler: JsonRpcNotificationHandler): void {
    this.onNotification = handler;
  }

  setRequestHandler(handler: JsonRpcRequestHandler): void {
    this.onRequest = handler;
  }

  async connect(): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) {
      return;
    }
    this.socket = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(this.url, { headers: this.headers });
      socket.once("open", () => resolve(socket));
      socket.once("error", (error) => reject(error));
    });
    this.socket.on("message", (data) => {
      void this.handleMessage(rawDataToString(data)).catch((error) => {
        if (!isTransportClosedError(error)) {
          log.debug(`codex app server websocket message handling failed: ${String(error)}`);
        }
      });
    });
    this.socket.on("close", () => {
      this.flushPending(new Error("codex app server websocket closed"));
      this.socket = null;
    });
  }

  async close(): Promise<void> {
    this.flushPending(new Error("codex app server websocket closed"));
    const socket = this.socket;
    this.socket = null;
    if (!socket) {
      return;
    }
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
      setTimeout(resolve, 250);
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.send({
      jsonrpc: "2.0",
      method,
      params: params ?? {},
    });
  }

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const id = `rpc-${++this.counter}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error(`codex app server timeout: ${method}`));
        },
        Math.max(100, timeoutMs ?? this.requestTimeoutMs),
      );
      this.pending.set(id, { resolve, reject, timer });
    });
    this.send({
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    });
    return await result;
  }

  private send(payload: JsonRpcEnvelope): void {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("codex app server websocket not connected");
    }
    socket.send(JSON.stringify(payload));
  }

  private async handleMessage(raw: string): Promise<void> {
    const payload = parseJsonRpc(raw);
    if (!payload) {
      return;
    }
    await dispatchJsonRpcEnvelope(payload, {
      pending: this.pending,
      onNotification: this.onNotification,
      onRequest: this.onRequest,
      respond: (frame) => this.send(frame),
    });
  }

  private flushPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

class StdioJsonRpcClient implements JsonRpcClient {
  private process: ChildProcessWithoutNullStreams | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private counter = 0;
  private onNotification: JsonRpcNotificationHandler = () => undefined;
  private onRequest: JsonRpcRequestHandler = async () => ({});

  constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly requestTimeoutMs: number,
  ) {}

  setNotificationHandler(handler: JsonRpcNotificationHandler): void {
    this.onNotification = handler;
  }

  setRequestHandler(handler: JsonRpcRequestHandler): void {
    this.onRequest = handler;
  }

  async connect(): Promise<void> {
    if (this.process) {
      return;
    }
    const child = spawn(this.command, ["app-server", ...this.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      throw new Error("codex app server stdio pipes unavailable");
    }
    this.process = child;
    const lineReader = readline.createInterface({ input: child.stdout });
    lineReader.on("line", (line) => {
      void this.handleLine(line).catch((error) => {
        if (!isTransportClosedError(error)) {
          log.debug(`codex app server stdio message handling failed: ${String(error)}`);
        }
      });
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        log.debug(`codex app server stderr: ${text}`);
      }
    });
    child.on("close", () => {
      this.flushPending(new Error("codex app server stdio closed"));
      this.process = null;
    });
  }

  async close(): Promise<void> {
    this.flushPending(new Error("codex app server stdio closed"));
    const child = this.process;
    this.process = null;
    if (!child) {
      return;
    }
    child.kill();
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.write({
      jsonrpc: "2.0",
      method,
      params: params ?? {},
    });
  }

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const id = `rpc-${++this.counter}`;
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error(`codex app server timeout: ${method}`));
        },
        Math.max(100, timeoutMs ?? this.requestTimeoutMs),
      );
      this.pending.set(id, { resolve, reject, timer });
    });
    this.write({
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    });
    return await result;
  }

  private write(payload: JsonRpcEnvelope): void {
    const child = this.process;
    if (!child?.stdin) {
      throw new Error("codex app server stdio not connected");
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private async handleLine(line: string): Promise<void> {
    const payload = parseJsonRpc(line);
    if (!payload) {
      return;
    }
    await dispatchJsonRpcEnvelope(payload, {
      pending: this.pending,
      onNotification: this.onNotification,
      onRequest: this.onRequest,
      respond: (frame) => this.write(frame),
    });
  }

  private flushPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

function parseJsonRpc(raw: string): JsonRpcEnvelope | null {
  try {
    const payload = JSON.parse(raw) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    return payload as JsonRpcEnvelope;
  } catch {
    return null;
  }
}

async function dispatchJsonRpcEnvelope(
  payload: JsonRpcEnvelope,
  params: {
    pending: Map<string, PendingRequest>;
    onNotification: JsonRpcNotificationHandler;
    onRequest: JsonRpcRequestHandler;
    respond: (payload: JsonRpcEnvelope) => void;
  },
): Promise<void> {
  if (payload.id != null && (Object.hasOwn(payload, "result") || Object.hasOwn(payload, "error"))) {
    const key = String(payload.id);
    const pending = params.pending.get(key);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    params.pending.delete(key);
    if (payload.error) {
      pending.reject(
        new Error(
          `codex app server rpc error (${payload.error.code ?? "unknown"}): ${payload.error.message ?? "unknown error"}`,
        ),
      );
      return;
    }
    pending.resolve(payload.result);
    return;
  }

  const method = payload.method?.trim();
  if (!method) {
    return;
  }
  if (payload.id == null) {
    await params.onNotification(method, payload.params);
    return;
  }
  try {
    const result = await params.onRequest(method, payload.params);
    try {
      params.respond({
        jsonrpc: "2.0",
        id: payload.id,
        result: result ?? {},
      });
    } catch (error) {
      if (!isTransportClosedError(error)) {
        throw error;
      }
    }
  } catch (error) {
    const response: JsonRpcEnvelope = {
      jsonrpc: "2.0",
      id: payload.id,
      error: {
        code: -32603,
        message: error instanceof Error ? error.message : String(error),
      },
    };
    try {
      params.respond(response);
    } catch (respondError) {
      if (!isTransportClosedError(respondError)) {
        throw respondError;
      }
    }
  }
}

function createJsonRpcClient(settings: CodexAppServerSettings): JsonRpcClient {
  if (settings.transport === "websocket") {
    if (!settings.url) {
      throw new Error(
        "codex app server websocket transport requires agents.defaults.codexAppServer.url",
      );
    }
    return new WsJsonRpcClient(settings.url, settings.headers, settings.requestTimeoutMs);
  }
  return new StdioJsonRpcClient(settings.command, settings.args, settings.requestTimeoutMs);
}

async function initializeCodexAppServerClient(params: {
  client: JsonRpcClient;
  settings: CodexAppServerSettings;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<void> {
  await params.client.request("initialize", {
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
    clientInfo: { name: "openclaw", version: "1.0.0" },
    capabilities: {
      experimentalApi: true,
    },
  });
  await params.client.notify("initialized", {});
  if (params.sessionKey || params.workspaceDir) {
    await params.client
      .request("session/update", {
        sessionKey: params.sessionKey ?? "openclaw",
        session_key: params.sessionKey ?? "openclaw",
        cwd: params.workspaceDir,
      })
      .catch((error) => {
        if (!isMethodUnavailableError(error, "session/update")) {
          throw error;
        }
      });
  }
}

async function requestWithFallbacks(params: {
  client: JsonRpcClient;
  methods: string[];
  payloads: unknown[];
  timeoutMs: number;
}): Promise<unknown> {
  let lastError: unknown;
  for (const method of params.methods) {
    for (const payload of params.payloads) {
      try {
        return await params.client.request(method, payload, params.timeoutMs);
      } catch (error) {
        lastError = error;
        if (!isMethodUnavailableError(error, method)) {
          continue;
        }
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function buildTurnInput(prompt: string): unknown[] {
  return [
    [{ type: "text", text: prompt }],
    [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    ],
  ];
}

function buildTurnStartPayloads(params: {
  threadId: string;
  prompt: string;
  workspaceDir: string;
  model?: string;
  collaborationMode?: CodexAppServerCollaborationMode;
}): unknown[] {
  return buildTurnInput(params.prompt).flatMap((input) => {
    const base: Record<string, unknown> = {
      threadId: params.threadId,
      input,
      cwd: params.workspaceDir,
    };
    const snake: Record<string, unknown> = {
      thread_id: params.threadId,
      input,
      cwd: params.workspaceDir,
    };
    if (params.model) {
      base.model = params.model;
      snake.model = params.model;
    }
    if (params.collaborationMode) {
      const collaborationMode = {
        mode: params.collaborationMode.mode,
        settings: {
          ...(params.collaborationMode.settings?.model
            ? { model: params.collaborationMode.settings.model }
            : {}),
          ...(params.collaborationMode.settings?.reasoningEffort
            ? { reasoningEffort: params.collaborationMode.settings.reasoningEffort }
            : {}),
          ...(Object.hasOwn(params.collaborationMode.settings ?? {}, "developerInstructions")
            ? {
                developerInstructions:
                  params.collaborationMode.settings?.developerInstructions ?? null,
              }
            : {}),
        },
      };
      base.collaborationMode = collaborationMode;
      snake.collaboration_mode = {
        mode: collaborationMode.mode,
        settings: {
          ...(typeof collaborationMode.settings.model === "string"
            ? { model: collaborationMode.settings.model }
            : {}),
          ...(typeof collaborationMode.settings.reasoningEffort === "string"
            ? { reasoning_effort: collaborationMode.settings.reasoningEffort }
            : {}),
          ...(Object.hasOwn(collaborationMode.settings, "developerInstructions")
            ? {
                developer_instructions: collaborationMode.settings.developerInstructions ?? null,
              }
            : {}),
        },
      };
    }
    return [base, snake];
  });
}

function buildThreadDiscoveryFilter(filter?: string, workspaceDir?: string): unknown[] {
  return [
    {
      query: filter?.trim() || undefined,
      cwd: workspaceDir,
      limit: 50,
    },
    {
      filter: filter?.trim() || undefined,
      cwd: workspaceDir,
      limit: 50,
    },
    {},
  ];
}

function normalizeSearchTokens(filter: string): string[] {
  return filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
}

function matchesAllTokens(value: string | undefined, tokens: string[]): boolean {
  if (tokens.length === 0) {
    return true;
  }
  const haystack = value?.trim().toLowerCase() ?? "";
  if (!haystack) {
    return false;
  }
  return tokens.every((token) => haystack.includes(token));
}

function applyThreadFilter(
  threads: CodexAppServerThreadSummary[],
  filter?: string,
): CodexAppServerThreadSummary[] {
  const tokens = normalizeSearchTokens(filter ?? "");
  if (tokens.length === 0) {
    return threads;
  }

  const projectMatches = threads.filter((thread) => matchesAllTokens(thread.projectKey, tokens));
  if (projectMatches.length > 0) {
    return projectMatches;
  }

  const titleOrIdMatches = threads.filter(
    (thread) => matchesAllTokens(thread.title, tokens) || matchesAllTokens(thread.threadId, tokens),
  );
  if (titleOrIdMatches.length > 0) {
    return titleOrIdMatches;
  }

  return threads.filter((thread) => matchesAllTokens(thread.summary, tokens));
}

function extractThreadsFromValue(value: unknown): CodexAppServerThreadSummary[] {
  const items = extractThreadRecords(value);
  const summaries = new Map<string, CodexAppServerThreadSummary>();
  for (const record of items) {
    const threadId =
      pickString(record, ["threadId", "thread_id", "id", "conversationId", "conversation_id"]) ??
      pickString(asRecord(record.thread) ?? {}, ["id", "threadId", "thread_id"]);
    if (!threadId) {
      continue;
    }
    const sessionRecord = asRecord(record.session);
    summaries.set(threadId, {
      threadId,
      title:
        pickString(record, ["title", "name", "headline"]) ??
        pickString(sessionRecord ?? {}, ["title", "name"]),
      summary:
        pickString(record, ["summary", "preview", "snippet", "text"]) ??
        dedupeJoinedText(collectText(record.messages ?? record.lastMessage ?? record.content)),
      projectKey:
        pickString(record, ["projectKey", "project_key", "cwd"]) ??
        pickString(sessionRecord ?? {}, ["cwd", "projectKey", "project_key"]),
      updatedAt:
        pickNumber(record, ["updatedAt", "updated_at", "lastActivityAt", "createdAt"]) ??
        pickNumber(sessionRecord ?? {}, ["updatedAt", "updated_at", "lastActivityAt"]),
    });
  }
  return [...summaries.values()].toSorted(
    (left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0),
  );
}

function extractThreadRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractThreadRecords(entry));
  }
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  const directId = pickString(record, ["id", "threadId", "thread_id", "conversationId"]);
  if (directId && !Array.isArray(record.items) && !Array.isArray(record.threads)) {
    return [record];
  }
  const out: Record<string, unknown>[] = [];
  for (const key of ["threads", "items", "data", "results"]) {
    const nested = record[key];
    if (Array.isArray(nested)) {
      out.push(...nested.flatMap((entry) => extractThreadRecords(entry)));
    }
  }
  return out;
}

function normalizeConversationRole(value: string | undefined): "user" | "assistant" | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "user") {
    return "user";
  }
  if (normalized === "assistant") {
    return "assistant";
  }
  if (normalized === "usermessage") {
    return "user";
  }
  if (normalized === "agentmessage" || normalized === "assistantmessage") {
    return "assistant";
  }
  return undefined;
}

function collectMessageText(record: Record<string, unknown>): string {
  return dedupeJoinedText([
    ...collectText(record.content),
    ...collectText(record.text),
    ...collectText(record.message),
    ...collectText(record.messages),
    ...collectText(record.input),
    ...collectText(record.output),
    ...collectText(record.parts),
  ]);
}

function extractConversationMessages(
  value: unknown,
): Array<{ role: "user" | "assistant"; text: string }> {
  const out: Array<{ role: "user" | "assistant"; text: string }> = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach((entry) => visit(entry));
      return;
    }
    const record = asRecord(node);
    if (!record) {
      return;
    }

    const role = normalizeConversationRole(
      pickString(record, ["role", "author", "speaker", "source", "type"]),
    );
    const text = collectMessageText(record);
    if (role && text) {
      out.push({ role, text });
    }

    for (const key of [
      "items",
      "messages",
      "content",
      "parts",
      "entries",
      "data",
      "results",
      "turns",
      "events",
      "item",
      "message",
      "thread",
      "response",
      "result",
    ]) {
      visit(record[key]);
    }
  };
  visit(value);
  return out;
}

function extractThreadReplayFromReadResult(value: unknown): CodexAppServerThreadReplay {
  const messages = extractConversationMessages(value);
  let lastUserMessage: string | undefined;
  let lastAssistantMessage: string | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!lastAssistantMessage && message?.role === "assistant") {
      lastAssistantMessage = message.text;
    }
    if (!lastUserMessage && message?.role === "user") {
      lastUserMessage = message.text;
    }
    if (lastUserMessage && lastAssistantMessage) {
      break;
    }
  }
  return {
    lastUserMessage,
    lastAssistantMessage,
  };
}

function extractReviewTextFromNotification(method: string, params: unknown): string | undefined {
  const methodLower = method.trim().toLowerCase();
  if (methodLower !== "item/completed" && methodLower !== "item/started") {
    return undefined;
  }
  const item = asRecord(asRecord(params)?.item);
  const itemType = pickString(item ?? {}, ["type"])
    ?.trim()
    .toLowerCase();
  if (itemType !== "exitedreviewmode") {
    return undefined;
  }
  return pickString(item ?? {}, ["review"]);
}

function extractModelSummaries(value: unknown): CodexAppServerModelSummary[] {
  const out = new Map<string, CodexAppServerModelSummary>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach((entry) => visit(entry));
      return;
    }
    const record = asRecord(node);
    if (!record) {
      return;
    }
    const provider = pickString(record, ["provider", "providerId", "provider_id"]);
    const rawId =
      pickString(record, ["id", "model", "modelId", "model_id", "name", "slug"]) ??
      pickString(record, ["ref", "modelRef", "model_ref"]);
    if (rawId) {
      const id =
        provider && !rawId.includes("/") && !rawId.startsWith("@") ? `${provider}/${rawId}` : rawId;
      const existing = out.get(id);
      const next: CodexAppServerModelSummary = {
        id,
        label:
          pickString(record, ["label", "title", "displayName", "display_name"]) ?? existing?.label,
        description:
          pickString(record, ["description", "summary", "details"]) ?? existing?.description,
        current:
          pickBoolean(record, ["current", "selected", "isCurrent", "is_current", "active"]) ??
          existing?.current,
      };
      out.set(id, next);
    }
    for (const key of ["models", "items", "data", "results", "entries", "available"]) {
      visit(record[key]);
    }
  };
  visit(value);
  return [...out.values()].toSorted((left, right) => {
    if (left.current && !right.current) {
      return -1;
    }
    if (!left.current && right.current) {
      return 1;
    }
    return left.id.localeCompare(right.id);
  });
}

function extractSkillSummaries(value: unknown): CodexAppServerSkillSummary[] {
  const items: CodexAppServerSkillSummary[] = [];
  const containers = Array.isArray(asRecord(value)?.data)
    ? (asRecord(value)?.data as unknown[])
    : Array.isArray(value)
      ? value
      : [];
  for (const containerValue of containers) {
    const container = asRecord(containerValue);
    if (!container) {
      continue;
    }
    const cwd = pickString(container, ["cwd", "path", "projectRoot"]);
    const skills = Array.isArray(container.skills) ? container.skills : [];
    for (const skillValue of skills) {
      const skill = asRecord(skillValue);
      if (!skill) {
        continue;
      }
      const name = pickString(skill, ["name", "id"]);
      if (!name) {
        continue;
      }
      const iface = asRecord(skill.interface);
      items.push({
        cwd,
        name,
        description:
          pickString(skill, ["description", "shortDescription"]) ??
          pickString(iface ?? {}, ["shortDescription", "description"]),
        enabled: pickBoolean(skill, ["enabled", "active", "isEnabled", "is_enabled"]),
      });
    }
  }
  return items.toSorted((left, right) => left.name.localeCompare(right.name));
}

function extractExperimentalFeatureSummaries(
  value: unknown,
): CodexAppServerExperimentalFeatureSummary[] {
  const items: CodexAppServerExperimentalFeatureSummary[] = [];
  const entries = Array.isArray(asRecord(value)?.data)
    ? (asRecord(value)?.data as unknown[])
    : Array.isArray(value)
      ? value
      : [];
  for (const entryValue of entries) {
    const entry = asRecord(entryValue);
    if (!entry) {
      continue;
    }
    const name = pickString(entry, ["name", "id", "key"]);
    if (!name) {
      continue;
    }
    items.push({
      name,
      stage: pickString(entry, ["stage", "status"]),
      displayName: pickString(entry, ["displayName", "display_name", "title"]),
      description: pickString(entry, ["description", "summary", "announcement"]),
      enabled: pickBoolean(entry, ["enabled", "active", "isEnabled", "is_enabled"]),
      defaultEnabled: pickBoolean(entry, ["defaultEnabled", "default_enabled", "enabledByDefault"]),
    });
  }
  return items.toSorted((left, right) => left.name.localeCompare(right.name));
}

function extractMcpServerSummaries(value: unknown): CodexAppServerMcpServerSummary[] {
  const items: CodexAppServerMcpServerSummary[] = [];
  const entries = Array.isArray(asRecord(value)?.data)
    ? (asRecord(value)?.data as unknown[])
    : Array.isArray(value)
      ? value
      : [];
  for (const entryValue of entries) {
    const entry = asRecord(entryValue);
    if (!entry) {
      continue;
    }
    const name = pickString(entry, ["name", "id"]);
    if (!name) {
      continue;
    }
    const tools = asRecord(entry.tools);
    items.push({
      name,
      authStatus: pickString(entry, ["authStatus", "auth_status", "status"]),
      toolCount: tools
        ? Object.keys(tools).length
        : Array.isArray(entry.tools)
          ? entry.tools.length
          : 0,
      resourceCount: Array.isArray(entry.resources) ? entry.resources.length : 0,
      resourceTemplateCount: Array.isArray(entry.resourceTemplates)
        ? entry.resourceTemplates.length
        : Array.isArray(entry.resource_templates)
          ? entry.resource_templates.length
          : 0,
    });
  }
  return items.toSorted((left, right) => left.name.localeCompare(right.name));
}

function summarizeSandboxPolicy(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  if ("dangerFullAccess" in record || "danger_full_access" in record) {
    return "danger-full-access";
  }
  if ("readOnly" in record || "read_only" in record) {
    return "read-only";
  }
  if ("workspaceWrite" in record || "workspace_write" in record) {
    const workspaceWrite = asRecord(record.workspaceWrite ?? record.workspace_write);
    const networkEnabled =
      pickBoolean(workspaceWrite ?? {}, ["networkAccess", "network_access", "enabled"]) === true;
    return networkEnabled ? "workspace-write with network access" : "workspace-write";
  }
  if ("externalSandbox" in record || "external_sandbox" in record) {
    return "external-sandbox";
  }
  const mode = pickString(record, ["mode", "type", "kind", "name"]);
  if (mode) {
    return mode;
  }
  return undefined;
}

function extractThreadState(value: unknown): CodexAppServerThreadState {
  return {
    threadId:
      extractIds(value).threadId ??
      findFirstNestedString(value, ["threadId", "thread_id", "id", "conversationId"]) ??
      "",
    threadName: findFirstNestedString(value, ["threadName", "thread_name", "name", "title"]),
    model: findFirstNestedString(value, ["model", "modelId", "model_id"]),
    modelProvider: findFirstNestedString(value, [
      "modelProvider",
      "model_provider",
      "provider",
      "providerId",
      "provider_id",
    ]),
    serviceTier: findFirstNestedString(value, ["serviceTier", "service_tier"]),
    cwd: findFirstNestedString(value, ["cwd", "workdir", "directory"]),
    approvalPolicy: findFirstNestedString(value, ["approvalPolicy", "approval_policy"]),
    sandbox: summarizeSandboxPolicy(findFirstNestedValue(value, ["sandbox", "sandbox_policy"])),
    reasoningEffort: findFirstNestedString(value, ["reasoningEffort", "reasoning_effort"]),
  };
}

function extractAccountSummary(value: unknown): CodexAppServerAccountSummary {
  const root = asRecord(value) ?? {};
  const account =
    asRecord(findFirstNestedValue(value, ["account"])) ?? asRecord(root.account) ?? undefined;
  const type = pickString(account ?? {}, ["type"]);
  return {
    type: type === "apiKey" || type === "chatgpt" ? type : undefined,
    email: pickString(account ?? {}, ["email"]),
    planType: pickString(account ?? {}, ["planType", "plan_type"]),
    requiresOpenaiAuth: pickBoolean(root, ["requiresOpenaiAuth", "requires_openai_auth"]),
  };
}

function formatRateLimitWindowName(params: {
  limitId?: string;
  limitName?: string;
  windowKey: "primary" | "secondary";
  windowMinutes?: number;
}): string {
  const rawId = params.limitId?.trim();
  const rawName = params.limitName?.trim();
  const minutes = params.windowMinutes;
  let windowLabel: string;
  if (minutes === 300) {
    windowLabel = "5h limit";
  } else if (minutes === 10080) {
    windowLabel = "Weekly limit";
  } else if (minutes === 43200) {
    windowLabel = "Monthly limit";
  } else if (typeof minutes === "number" && minutes > 0) {
    if (minutes % 1440 === 0) {
      windowLabel = `${Math.round(minutes / 1440)}d limit`;
    } else if (minutes % 60 === 0) {
      windowLabel = `${Math.round(minutes / 60)}h limit`;
    } else {
      windowLabel = `${minutes}m limit`;
    }
  } else {
    windowLabel = params.windowKey === "primary" ? "Primary limit" : "Secondary limit";
  }
  if (!rawId || rawId.toLowerCase() === "codex") {
    return windowLabel;
  }
  return `${rawName ?? rawId} ${windowLabel}`.trim();
}

function normalizeEpochMilliseconds(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  const abs = Math.abs(value);
  if (abs < 100_000_000_000) {
    return Math.round(value * 1_000);
  }
  if (abs > 100_000_000_000_000) {
    return Math.round(value / 1_000);
  }
  return Math.round(value);
}

function extractRateLimitSummaries(value: unknown): CodexAppServerRateLimitSummary[] {
  const out = new Map<string, CodexAppServerRateLimitSummary>();
  const addWindow = (
    windowValue: unknown,
    params: { limitId?: string; limitName?: string; windowKey: "primary" | "secondary" },
  ) => {
    const window = asRecord(windowValue);
    if (!window) {
      return;
    }
    const usedPercent = pickFiniteNumber(window, ["usedPercent", "used_percent"]);
    const windowMinutes = pickFiniteNumber(window, [
      "windowDurationMins",
      "window_duration_mins",
      "windowMinutes",
      "window_minutes",
    ]);
    const name = formatRateLimitWindowName({
      limitId: params.limitId,
      limitName: params.limitName,
      windowKey: params.windowKey,
      windowMinutes,
    });
    out.set(name, {
      name,
      limitId: params.limitId,
      usedPercent,
      remaining:
        typeof usedPercent === "number" ? Math.max(0, Math.round(100 - usedPercent)) : undefined,
      resetAt: normalizeEpochMilliseconds(
        pickNumber(window, ["resetsAt", "resets_at", "resetAt", "reset_at"]),
      ),
      windowSeconds: typeof windowMinutes === "number" ? Math.round(windowMinutes * 60) : undefined,
      windowMinutes,
    });
  };
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      node.forEach((entry) => visit(entry));
      return;
    }
    const record = asRecord(node);
    if (!record) {
      return;
    }
    if ("primary" in record || "secondary" in record) {
      const limitId = pickString(record, ["limitId", "limit_id", "id"]);
      const limitName = pickString(record, ["limitName", "limit_name", "name", "label"]);
      addWindow(record.primary, { limitId, limitName, windowKey: "primary" });
      addWindow(record.secondary, { limitId, limitName, windowKey: "secondary" });
    }
    if (record.rateLimitsByLimitId && typeof record.rateLimitsByLimitId === "object") {
      for (const [limitId, snapshot] of Object.entries(record.rateLimitsByLimitId)) {
        const snapshotRecord = asRecord(snapshot);
        if (!snapshotRecord) {
          continue;
        }
        const limitName = pickString(snapshotRecord, ["limitName", "limit_name", "name", "label"]);
        addWindow(snapshotRecord.primary, { limitId, limitName, windowKey: "primary" });
        addWindow(snapshotRecord.secondary, { limitId, limitName, windowKey: "secondary" });
      }
    }
    const remaining = pickFiniteNumber(record, [
      "remaining",
      "remainingCount",
      "remaining_count",
      "available",
    ]);
    const limit = pickFiniteNumber(record, ["limit", "max", "quota", "capacity"]);
    const used = pickFiniteNumber(record, ["used", "consumed", "count"]);
    const resetAt = pickNumber(record, [
      "resetAt",
      "reset_at",
      "resetsAt",
      "resets_at",
      "nextResetAt",
    ]);
    const windowSeconds = pickFiniteNumber(record, [
      "windowSeconds",
      "window_seconds",
      "resetInSeconds",
      "retryAfterSeconds",
    ]);
    const name =
      pickString(record, ["name", "label", "scope", "resource", "model", "id"]) ??
      (typeof remaining === "number" ||
      typeof limit === "number" ||
      typeof used === "number" ||
      typeof resetAt === "number"
        ? `limit-${out.size + 1}`
        : undefined);
    if (name) {
      const existing = out.get(name);
      out.set(name, {
        name,
        limitId: existing?.limitId,
        remaining: remaining ?? existing?.remaining,
        limit: limit ?? existing?.limit,
        used: used ?? existing?.used,
        usedPercent: existing?.usedPercent,
        resetAt: normalizeEpochMilliseconds(resetAt) ?? existing?.resetAt,
        windowSeconds: windowSeconds ?? existing?.windowSeconds,
        windowMinutes: existing?.windowMinutes,
      });
    }
    for (const key of [
      "limits",
      "items",
      "data",
      "results",
      "entries",
      "buckets",
      "rateLimits",
      "rate_limits",
      "rateLimitsByLimitId",
      "rate_limits_by_limit_id",
    ]) {
      visit(record[key]);
    }
  };
  visit(value);
  return [...out.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

export async function discoverCodexAppServerThreads(params?: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
  filter?: string;
}): Promise<CodexAppServerThreadSummary[]> {
  const settings = resolveCodexAppServerSettings(params?.config);
  if (!settings.enabled) {
    return [];
  }
  const client = createJsonRpcClient(settings);
  try {
    await client.connect();
    await initializeCodexAppServerClient({
      client,
      settings,
      sessionKey: params?.sessionKey,
      workspaceDir: params?.workspaceDir,
    });
    const result = await requestWithFallbacks({
      client,
      methods: ["thread/list", "thread/loaded/list"],
      payloads: buildThreadDiscoveryFilter(undefined, params?.workspaceDir),
      timeoutMs: settings.requestTimeoutMs,
    });
    let threads = extractThreadsFromValue(result);
    threads = applyThreadFilter(threads, params?.filter);
    if (params?.workspaceDir) {
      threads = threads.filter(
        (thread) => !thread.projectKey || thread.projectKey.trim() === params.workspaceDir,
      );
    }
    return threads;
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function readCodexAppServerModels(params?: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<CodexAppServerModelSummary[]> {
  const settings = resolveCodexAppServerSettings(params?.config);
  if (!settings.enabled) {
    return [];
  }
  const client = createJsonRpcClient(settings);
  try {
    await client.connect();
    await initializeCodexAppServerClient({
      client,
      settings,
      sessionKey: params?.sessionKey,
      workspaceDir: params?.workspaceDir,
    });
    const result = await requestWithFallbacks({
      client,
      methods: ["model/list"],
      payloads: [{}],
      timeoutMs: settings.requestTimeoutMs,
    });
    return extractModelSummaries(result);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function readCodexAppServerSkills(params?: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
  forceReload?: boolean;
}): Promise<CodexAppServerSkillSummary[]> {
  return await withInitializedCodexClient(params ?? {}, async ({ client, settings }) => {
    const result = await requestWithFallbacks({
      client,
      methods: ["skills/list"],
      payloads: [
        {
          cwds: params?.workspaceDir ? [params.workspaceDir] : undefined,
          forceReload: params?.forceReload,
        },
        {
          cwd: params?.workspaceDir,
          forceReload: params?.forceReload,
        },
      ],
      timeoutMs: settings.requestTimeoutMs,
    });
    return extractSkillSummaries(result);
  });
}

export async function readCodexAppServerExperimentalFeatures(params?: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<CodexAppServerExperimentalFeatureSummary[]> {
  return await withInitializedCodexClient(params ?? {}, async ({ client, settings }) => {
    const result = await requestWithFallbacks({
      client,
      methods: ["experimentalFeature/list"],
      payloads: [{ limit: 100 }, {}],
      timeoutMs: settings.requestTimeoutMs,
    });
    return extractExperimentalFeatureSummaries(result);
  });
}

export async function readCodexAppServerMcpServers(params?: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<CodexAppServerMcpServerSummary[]> {
  return await withInitializedCodexClient(params ?? {}, async ({ client, settings }) => {
    const result = await requestWithFallbacks({
      client,
      methods: ["mcpServerStatus/list"],
      payloads: [{ limit: 100 }, {}],
      timeoutMs: settings.requestTimeoutMs,
    });
    return extractMcpServerSummaries(result);
  });
}

export async function readCodexAppServerRateLimits(params?: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<CodexAppServerRateLimitSummary[]> {
  const settings = resolveCodexAppServerSettings(params?.config);
  if (!settings.enabled) {
    return [];
  }
  const client = createJsonRpcClient(settings);
  try {
    await client.connect();
    await initializeCodexAppServerClient({
      client,
      settings,
      sessionKey: params?.sessionKey,
      workspaceDir: params?.workspaceDir,
    });
    const result = await requestWithFallbacks({
      client,
      methods: ["account/rateLimits/read"],
      payloads: [{}],
      timeoutMs: settings.requestTimeoutMs,
    });
    return extractRateLimitSummaries(result);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function buildThreadResumePayloads(params: {
  threadId: string;
  model?: string;
  cwd?: string;
  serviceTier?: string | null;
}): Array<Record<string, unknown>> {
  const payloads: Array<Record<string, unknown>> = [];
  const base: Record<string, unknown> = {
    threadId: params.threadId,
  };
  const snake: Record<string, unknown> = {
    thread_id: params.threadId,
  };
  if (typeof params.model === "string" && params.model.trim()) {
    base.model = params.model.trim();
    snake.model = params.model.trim();
  }
  if (typeof params.cwd === "string" && params.cwd.trim()) {
    base.cwd = params.cwd.trim();
    snake.cwd = params.cwd.trim();
  }
  if (params.serviceTier !== undefined) {
    base.serviceTier = params.serviceTier;
    snake.serviceTier = params.serviceTier;
    snake.service_tier = params.serviceTier;
  }
  payloads.push(base, snake);
  return payloads;
}

async function withInitializedCodexClient<T>(
  params: {
    config?: OpenClawConfig;
    sessionKey?: string;
    workspaceDir?: string;
  },
  callback: (args: { client: JsonRpcClient; settings: CodexAppServerSettings }) => Promise<T>,
): Promise<T> {
  const settings = resolveCodexAppServerSettings(params.config);
  if (!settings.enabled) {
    throw new Error('Provider "codex-app-server" is disabled.');
  }
  const client = createJsonRpcClient(settings);
  try {
    await client.connect();
    await initializeCodexAppServerClient({
      client,
      settings,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
    });
    return await callback({ client, settings });
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function readCodexAppServerThreadState(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
  threadId: string;
}): Promise<CodexAppServerThreadState> {
  return await withInitializedCodexClient(params, async ({ client, settings }) => {
    try {
      const result = await requestWithFallbacks({
        client,
        methods: ["thread/resume"],
        payloads: buildThreadResumePayloads({
          threadId: params.threadId,
        }),
        timeoutMs: settings.requestTimeoutMs,
      });
      return extractThreadState(result);
    } finally {
      await requestWithFallbacks({
        client,
        methods: ["thread/unsubscribe"],
        payloads: [{ threadId: params.threadId }, { thread_id: params.threadId }],
        timeoutMs: settings.requestTimeoutMs,
      }).catch(() => undefined);
    }
  });
}

export async function setCodexAppServerThreadServiceTier(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
  threadId: string;
  serviceTier: string | null;
}): Promise<CodexAppServerThreadState> {
  return await withInitializedCodexClient(params, async ({ client, settings }) => {
    try {
      const result = await requestWithFallbacks({
        client,
        methods: ["thread/resume"],
        payloads: buildThreadResumePayloads({
          threadId: params.threadId,
          serviceTier: params.serviceTier,
        }),
        timeoutMs: settings.requestTimeoutMs,
      });
      return extractThreadState(result);
    } finally {
      await requestWithFallbacks({
        client,
        methods: ["thread/unsubscribe"],
        payloads: [{ threadId: params.threadId }, { thread_id: params.threadId }],
        timeoutMs: settings.requestTimeoutMs,
      }).catch(() => undefined);
    }
  });
}

export async function setCodexAppServerThreadName(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
  threadId: string;
  name: string;
}): Promise<void> {
  await withInitializedCodexClient(params, async ({ client, settings }) => {
    await requestWithFallbacks({
      client,
      methods: ["thread/name/set"],
      payloads: [
        { threadId: params.threadId, name: params.name },
        { thread_id: params.threadId, name: params.name },
      ],
      timeoutMs: settings.requestTimeoutMs,
    });
  });
}

export async function startCodexAppServerThreadCompaction(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
  threadId: string;
}): Promise<void> {
  await withInitializedCodexClient(params, async ({ client, settings }) => {
    await requestWithFallbacks({
      client,
      methods: ["thread/compact/start"],
      payloads: [{ threadId: params.threadId }, { thread_id: params.threadId }],
      timeoutMs: settings.requestTimeoutMs,
    });
  });
}

export async function readCodexAppServerAccount(params?: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<CodexAppServerAccountSummary> {
  return await withInitializedCodexClient(params ?? {}, async ({ client, settings }) => {
    const result = await requestWithFallbacks({
      client,
      methods: ["account/read"],
      payloads: [{ refreshToken: false }, { refresh_token: false }, {}],
      timeoutMs: settings.requestTimeoutMs,
    });
    return extractAccountSummary(result);
  });
}

export async function readCodexAppServerThreadContext(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
  threadId: string;
}): Promise<CodexAppServerThreadReplay> {
  const settings = resolveCodexAppServerSettings(params.config);
  if (!settings.enabled) {
    return {};
  }
  const client = createJsonRpcClient(settings);
  try {
    await client.connect();
    await initializeCodexAppServerClient({
      client,
      settings,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
    });
    const result = await requestWithFallbacks({
      client,
      methods: ["thread/read"],
      payloads: [
        { threadId: params.threadId, includeTurns: true },
        { thread_id: params.threadId, include_turns: true },
      ],
      timeoutMs: settings.requestTimeoutMs,
    });
    return extractThreadReplayFromReadResult(result);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function startCodexAppServerReview(params: {
  sessionId: string;
  sessionKey?: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  timeoutMs?: number;
  runId: string;
  threadId: string;
  target: CodexAppServerReviewTarget;
  onToolResult?: (payload: {
    text?: string;
    channelData?: Record<string, unknown>;
  }) => Promise<void> | void;
  onPendingUserInput?: (state: PendingCodexUserInputState | null) => Promise<void> | void;
  onInterrupted?: () => Promise<void> | void;
}): Promise<CodexAppServerReviewResult> {
  const settings = resolveCodexAppServerSettings(params.config);
  if (!settings.enabled) {
    throw new Error('Provider "codex-app-server" is disabled.');
  }

  const client = createJsonRpcClient(settings);
  let reviewThreadId = params.threadId.trim();
  let turnId = "";
  let reviewText = "";
  let assistantText = "";
  let awaitingInput = false;
  let interrupted = false;
  let completed = false;
  let notificationQueue = Promise.resolve();
  let pendingInput: LivePendingCodexUserInputState | null = null;
  let completeTurn: (() => void) | null = null;
  const completion = new Promise<void>((resolve) => {
    completeTurn = () => {
      if (completed) {
        return;
      }
      completed = true;
      resolve();
    };
  });

  const emitPendingInputState = async (
    active: LivePendingCodexUserInputState,
    requestMethod: string,
  ) => {
    await params.onPendingUserInput?.({
      requestId: active.requestId,
      options: active.options,
      actions: active.actions,
      expiresAt: active.expiresAt,
      promptText: active.promptText,
      method: requestMethod,
    });
    const telegramButtons = buildCodexPendingInputButtons({
      requestId: active.requestId,
      actions: active.actions,
    });
    await params.onToolResult?.({
      text: active.promptText,
      channelData: telegramButtons
        ? {
            telegram: {
              buttons: telegramButtons,
            },
          }
        : undefined,
    });
  };

  const queueHandle: CodexAppServerQueueHandle = {
    queueMessage: async (text) => {
      const trimmed = text.trim();
      if (!trimmed || !pendingInput) {
        return false;
      }
      const actionSelectionCount =
        pendingInput.actions.filter((action) => action.kind !== "steer").length ||
        pendingInput.options.length;
      const parsed = parseCodexUserInput(trimmed, actionSelectionCount);
      if ((pendingInput.questionSummaries?.length ?? 0) > 0) {
        const answerText = resolvePendingInputSelectionValue({
          parsed,
          options: pendingInput.options,
          actions: pendingInput.actions,
        });
        const next = advancePendingQuestionnaire({
          pendingInput,
          answerText,
        });
        if (next.done) {
          pendingInput.resolve(next.response);
        } else {
          pendingInput.currentQuestionIndex = next.nextQuestionIndex;
          pendingInput.actions = next.actions;
          pendingInput.options = next.options;
          pendingInput.promptText = next.promptText;
          await emitPendingInputState(pendingInput, methodLower);
        }
      } else if (parsed.kind === "option") {
        const action = pendingInput.actions[parsed.index];
        if (action?.kind === "steer") {
          pendingInput.resolve({ steerText: "" });
        } else {
          pendingInput.resolve({
            index: parsed.index,
            option: pendingInput.options[parsed.index] ?? "",
          });
        }
      } else if (pendingInput.methodLower.includes("requestapproval")) {
        pendingInput.resolve({ steerText: parsed.text });
      } else {
        pendingInput.resolve({ text: parsed.text });
      }
      return true;
    },
    submitPendingInput: async ({ actionIndex }) => {
      if (!pendingInput) {
        return false;
      }
      const action = pendingInput.actions[actionIndex];
      if (!action || action.kind === "steer") {
        return false;
      }
      if ((pendingInput.questionSummaries?.length ?? 0) > 0) {
        const answerText =
          action.kind === "option" ? action.value : (pendingInput.options[actionIndex] ?? "");
        const next = advancePendingQuestionnaire({
          pendingInput,
          answerText,
        });
        if (next.done) {
          pendingInput.resolve(next.response);
        } else {
          pendingInput.currentQuestionIndex = next.nextQuestionIndex;
          pendingInput.actions = next.actions;
          pendingInput.options = next.options;
          pendingInput.promptText = next.promptText;
          await emitPendingInputState(pendingInput, methodLower);
        }
      } else {
        pendingInput.resolve({
          index: actionIndex,
          option: pendingInput.options[actionIndex] ?? "",
        });
      }
      return true;
    },
    interrupt: async () => {
      interrupted = true;
      await params.onInterrupted?.();
      if (reviewThreadId) {
        await requestWithFallbacks({
          client,
          methods: ["turn/interrupt"],
          payloads: [
            { threadId: reviewThreadId, turnId: turnId || undefined },
            { thread_id: reviewThreadId, turn_id: turnId || undefined },
          ],
          timeoutMs: settings.requestTimeoutMs,
        }).catch(() => undefined);
      }
      completeTurn?.();
    },
    isStreaming: () => !completed,
    isAwaitingInput: () => awaitingInput,
  };

  const handleNotification = async (method: string, notificationParams: unknown) => {
    const ids = extractIds(notificationParams);
    reviewThreadId ||= ids.threadId ?? "";
    turnId ||= ids.runId ?? "";
    const methodLower = method.trim().toLowerCase();

    if (methodLower === "serverrequest/resolved") {
      pendingInput = null;
      awaitingInput = false;
      await params.onPendingUserInput?.(null);
      return;
    }

    const maybeReviewText = extractReviewTextFromNotification(method, notificationParams);
    if (maybeReviewText?.trim()) {
      reviewText = maybeReviewText.trim();
    }

    const assistantNotification = extractAssistantNotificationText(methodLower, notificationParams);
    if (assistantNotification.mode === "snapshot" && assistantNotification.text.trim()) {
      assistantText = assistantNotification.text.trim();
    }

    if (
      methodLower === "turn/completed" ||
      methodLower === "turn/failed" ||
      methodLower === "turn/cancelled"
    ) {
      completeTurn?.();
    }
  };

  client.setNotificationHandler((method, notificationParams) => {
    const next = notificationQueue.then(() => handleNotification(method, notificationParams));
    notificationQueue = next.catch((error) => {
      log.debug(`codex app server review notification handling failed: ${String(error)}`);
    });
    return next;
  });

  client.setRequestHandler(async (method, requestParams) => {
    const methodLower = method.trim().toLowerCase();
    if (!isInteractiveServerRequest(method)) {
      return {};
    }
    const ids = extractIds(requestParams);
    reviewThreadId ||= ids.threadId ?? "";
    turnId ||= ids.runId ?? "";
    const options = extractOptionValues(requestParams);
    log.debug(`codex review interactive request payload: ${stableStringify(requestParams)}`);
    const question = dedupeJoinedText(collectText(requestParams));
    const requestId = ids.requestId ?? `${params.runId}-${Date.now().toString(36)}`;
    const expiresAt = Date.now() + settings.inputTimeoutMs;
    const presentation = buildInteractiveRequestPresentation({
      method,
      requestId,
      requestParams,
      question,
      expiresAt,
      options,
    });
    const {
      questionSummaries,
      currentQuestionIndex,
      actions,
      options: resolvedOptions,
      promptText,
    } = presentation;

    awaitingInput = true;
    const livePendingInput: LivePendingCodexUserInputState = {
      requestId,
      methodLower,
      options: resolvedOptions,
      actions,
      expiresAt,
      questionSummaries,
      currentQuestionIndex,
      answersByQuestionId: {},
      promptText,
      requestParams,
      resolve: () => undefined,
    };
    await emitPendingInputState(livePendingInput, method);

    let timedOut = false;
    const response = await new Promise<unknown>((resolve) => {
      livePendingInput.resolve = resolve;
      pendingInput = livePendingInput;
      setTimeout(() => {
        if (!pendingInput || pendingInput.requestId !== requestId) {
          return;
        }
        timedOut = true;
        pendingInput = null;
        resolve({ text: "" });
      }, settings.inputTimeoutMs);
    });

    awaitingInput = false;
    pendingInput = null;
    await params.onPendingUserInput?.(null);
    const mappedResponse = mapPendingInputResponse({
      methodLower,
      requestParams,
      response,
      options: resolvedOptions,
      actions,
      timedOut,
    });
    const responseRecord = asRecord(response);
    const steerText =
      methodLower.includes("requestapproval") && typeof responseRecord?.steerText === "string"
        ? responseRecord.steerText.trim()
        : "";
    if (steerText && reviewThreadId) {
      await requestWithFallbacks({
        client,
        methods: [...TURN_STEER_METHODS],
        payloads: [
          { threadId: reviewThreadId, turnId: turnId || undefined, text: steerText },
          { thread_id: reviewThreadId, turn_id: turnId || undefined, text: steerText },
        ],
        timeoutMs: settings.requestTimeoutMs,
      });
    }
    return mappedResponse;
  });

  setActiveCodexAppServerRun(params.sessionId, queueHandle, params.sessionKey);
  try {
    await client.connect();
    await initializeCodexAppServerClient({
      client,
      settings,
      sessionKey: params.sessionKey ?? params.sessionId,
      workspaceDir: params.workspaceDir,
    });
    await requestWithFallbacks({
      client,
      methods: ["thread/resume"],
      payloads: [{ threadId: reviewThreadId }, { thread_id: reviewThreadId }],
      timeoutMs: settings.requestTimeoutMs,
    }).catch(() => undefined);

    const result = await requestWithFallbacks({
      client,
      methods: ["review/start"],
      payloads: [
        {
          threadId: reviewThreadId,
          target: params.target,
          delivery: "inline",
        },
        {
          thread_id: reviewThreadId,
          target: params.target,
          delivery: "inline",
        },
      ],
      timeoutMs: Math.max(params.timeoutMs ?? 0, settings.requestTimeoutMs),
    });
    const resultRecord = asRecord(result);
    reviewThreadId =
      pickString(resultRecord, ["reviewThreadId", "review_thread_id"]) ?? reviewThreadId;
    turnId ||= extractIds(result)?.runId ?? "";

    await completion;
    if (completed && !interrupted) {
      await new Promise<void>((resolve) => setTimeout(resolve, TRAILING_NOTIFICATION_SETTLE_MS));
      await notificationQueue;
    }

    const resolvedReviewText = reviewText || assistantText;
    if (!resolvedReviewText.trim()) {
      throw new Error("Codex review completed without review text.");
    }
    return {
      reviewText: resolvedReviewText.trim(),
      reviewThreadId: reviewThreadId || undefined,
      turnId: turnId || undefined,
    };
  } finally {
    if (reviewThreadId) {
      await requestWithFallbacks({
        client,
        methods: ["thread/unsubscribe"],
        payloads: [{ threadId: reviewThreadId }, { thread_id: reviewThreadId }],
        timeoutMs: settings.requestTimeoutMs,
      }).catch(() => undefined);
    }
    clearActiveCodexAppServerRun(params.sessionId, queueHandle, params.sessionKey);
    await client.close().catch(() => undefined);
  }
}

export async function runCodexAppServerAgent(
  params: RunCodexAppServerAgentParams,
): Promise<EmbeddedPiRunResult> {
  const settings = resolveCodexAppServerSettings(params.config);
  if (!settings.enabled) {
    throw new Error('Provider "codex-app-server" is disabled.');
  }

  const client = createJsonRpcClient(settings);
  let threadId = params.existingThreadId?.trim() || "";
  let turnId = "";
  let assistantText = "";
  let assistantItemId = "";
  let awaitingInput = false;
  let interrupted = false;
  let completed = false;
  let notificationQueue = Promise.resolve();
  let pendingInput: LivePendingCodexUserInputState | null = null;
  let completeTurn: (() => void) | null = null;
  const completion = new Promise<void>((resolve) => {
    completeTurn = () => {
      if (completed) {
        return;
      }
      completed = true;
      resolve();
    };
  });
  const startedAt = Date.now();

  const emitPendingInputState = async (
    active: LivePendingCodexUserInputState,
    requestMethod: string,
  ) => {
    await params.onPendingUserInput?.({
      requestId: active.requestId,
      options: active.options,
      actions: active.actions,
      expiresAt: active.expiresAt,
      promptText: active.promptText,
      method: requestMethod,
    });
    const telegramButtons = buildCodexPendingInputButtons({
      requestId: active.requestId,
      actions: active.actions,
    });
    await params.onToolResult?.({
      text: active.promptText,
      channelData: {
        codexAppServer: {
          interactiveRequest: true,
          method: requestMethod,
          requestId: active.requestId,
          actions: active.actions,
        },
        ...(telegramButtons
          ? {
              telegram: {
                buttons: telegramButtons,
              },
            }
          : {}),
      },
    });
  };

  const queueHandle: CodexAppServerQueueHandle = {
    queueMessage: async (text) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return false;
      }
      if (pendingInput) {
        const actionSelectionCount =
          pendingInput.actions.filter((action) => action.kind !== "steer").length ||
          pendingInput.options.length;
        const parsed = parseCodexUserInput(trimmed, actionSelectionCount);
        if ((pendingInput.questionSummaries?.length ?? 0) > 0) {
          const answerText = resolvePendingInputSelectionValue({
            parsed,
            options: pendingInput.options,
            actions: pendingInput.actions,
          });
          const next = advancePendingQuestionnaire({
            pendingInput,
            answerText,
          });
          if (next.done) {
            pendingInput.resolve(next.response);
          } else {
            pendingInput.currentQuestionIndex = next.nextQuestionIndex;
            pendingInput.actions = next.actions;
            pendingInput.options = next.options;
            pendingInput.promptText = next.promptText;
            await emitPendingInputState(pendingInput, pendingInput.methodLower);
          }
        } else if (parsed.kind === "option") {
          const action = pendingInput.actions[parsed.index];
          if (action?.kind === "steer") {
            pendingInput.resolve({ steerText: "" });
          } else {
            pendingInput.resolve({
              index: parsed.index,
              option: pendingInput.options[parsed.index] ?? "",
            });
          }
        } else {
          if (pendingInput.methodLower.includes("requestapproval")) {
            pendingInput.resolve({ steerText: parsed.text });
          } else {
            pendingInput.resolve({ text: parsed.text });
          }
        }
        return true;
      }
      if (!threadId) {
        return false;
      }
      const steerPayloads = [
        { threadId, turnId: turnId || undefined, text: trimmed },
        { thread_id: threadId, turn_id: turnId || undefined, text: trimmed },
      ];
      await requestWithFallbacks({
        client,
        methods: [...TURN_STEER_METHODS],
        payloads: steerPayloads,
        timeoutMs: settings.requestTimeoutMs,
      });
      return true;
    },
    submitPendingInput: async ({ actionIndex }) => {
      if (!pendingInput) {
        return false;
      }
      const action = pendingInput.actions[actionIndex];
      if (!action || action.kind === "steer") {
        return false;
      }
      if ((pendingInput.questionSummaries?.length ?? 0) > 0) {
        const answerText =
          action.kind === "option" ? action.value : (pendingInput.options[actionIndex] ?? "");
        const next = advancePendingQuestionnaire({
          pendingInput,
          answerText,
        });
        if (next.done) {
          pendingInput.resolve(next.response);
        } else {
          pendingInput.currentQuestionIndex = next.nextQuestionIndex;
          pendingInput.actions = next.actions;
          pendingInput.options = next.options;
          pendingInput.promptText = next.promptText;
          await emitPendingInputState(pendingInput, pendingInput.methodLower);
        }
      } else {
        pendingInput.resolve({
          index: actionIndex,
          option: pendingInput.options[actionIndex] ?? "",
        });
      }
      return true;
    },
    interrupt: async () => {
      if (!threadId) {
        return;
      }
      interrupted = true;
      await params.onInterrupted?.();
      await requestWithFallbacks({
        client,
        methods: ["turn/interrupt", "thread/interrupt"],
        payloads: [
          { threadId, turnId: turnId || undefined },
          { thread_id: threadId, turn_id: turnId || undefined },
        ],
        timeoutMs: settings.requestTimeoutMs,
      }).catch(() => undefined);
      completeTurn?.();
    },
    isStreaming: () => !completed,
    isAwaitingInput: () => awaitingInput,
  };

  const handleNotification = async (method: string, notificationParams: unknown) => {
    const methodLower = method.trim().toLowerCase();
    const ids = extractIds(notificationParams);
    threadId ||= ids.threadId ?? "";
    turnId ||= ids.runId ?? "";

    if (methodLower === "serverrequest/resolved") {
      pendingInput = null;
      awaitingInput = false;
      await params.onPendingUserInput?.(null);
      return;
    }

    const assistantNotification = extractAssistantNotificationText(methodLower, notificationParams);
    if (
      assistantNotification.itemId &&
      assistantItemId &&
      assistantNotification.itemId !== assistantItemId
    ) {
      assistantText = "";
    }
    if (assistantNotification.itemId) {
      assistantItemId = assistantNotification.itemId;
    }
    if (assistantNotification.mode === "delta" && assistantNotification.text) {
      assistantText = await mergeAssistantReplyAndEmit({
        assistantText,
        incomingText: assistantNotification.text,
        onPartialReply: params.onPartialReply,
      });
    } else if (assistantNotification.mode === "snapshot" && assistantNotification.text) {
      const snapshotText = assistantNotification.text.trim();
      if (snapshotText && snapshotText !== assistantText) {
        assistantText = snapshotText;
        await params.onPartialReply?.({ text: assistantText });
      }
    }

    if (
      methodLower === "turn/completed" ||
      methodLower === "turn/failed" ||
      methodLower === "turn/cancelled"
    ) {
      completeTurn?.();
    }
  };

  client.setNotificationHandler((method, notificationParams) => {
    const next = notificationQueue.then(() => handleNotification(method, notificationParams));
    notificationQueue = next.catch((error) => {
      log.debug(`codex app server notification handling failed: ${String(error)}`);
    });
    return next;
  });

  client.setRequestHandler(async (method, requestParams) => {
    const methodLower = method.trim().toLowerCase();
    if (!isInteractiveServerRequest(method)) {
      return {};
    }
    const ids = extractIds(requestParams);
    threadId ||= ids.threadId ?? "";
    turnId ||= ids.runId ?? "";
    const options = extractOptionValues(requestParams);
    log.debug(`codex interactive request payload: ${stableStringify(requestParams)}`);
    const question = dedupeJoinedText(collectText(requestParams));
    const requestId = ids.requestId ?? `${params.runId}-${Date.now().toString(36)}`;
    const expiresAt = Date.now() + settings.inputTimeoutMs;
    const presentation = buildInteractiveRequestPresentation({
      method,
      requestId,
      requestParams,
      question,
      expiresAt,
      options,
    });
    const {
      questionSummaries,
      currentQuestionIndex,
      actions,
      options: resolvedOptions,
      promptText,
    } = presentation;

    awaitingInput = true;
    // Approval and other interactive tool requests split the assistant flow. The
    // next assistant item after approval must start from a fresh reply buffer.
    assistantText = "";
    assistantItemId = "";
    log.info("codex interactive request opened", {
      sessionKey: params.sessionKey,
      requestId,
      method,
      threadId: threadId || undefined,
      turnId: turnId || undefined,
      workspaceDir: params.workspaceDir,
      options: actions.map((action) => action.label),
    });
    const livePendingInput: LivePendingCodexUserInputState = {
      requestId,
      methodLower,
      options: resolvedOptions,
      actions,
      expiresAt,
      questionSummaries,
      currentQuestionIndex,
      answersByQuestionId: {},
      promptText,
      requestParams,
      resolve: () => undefined,
    };
    await emitPendingInputState(livePendingInput, method);

    let timedOut = false;
    const response = await new Promise<unknown>((resolve) => {
      livePendingInput.resolve = resolve;
      pendingInput = livePendingInput;
      setTimeout(() => {
        if (!pendingInput || pendingInput.requestId !== requestId) {
          return;
        }
        timedOut = true;
        pendingInput = null;
        resolve({ text: "" });
      }, settings.inputTimeoutMs);
    });

    awaitingInput = false;
    pendingInput = null;
    await params.onPendingUserInput?.(null);
    const mappedResponse = mapPendingInputResponse({
      methodLower,
      requestParams,
      response,
      options: resolvedOptions,
      actions,
      timedOut,
    });
    const responseRecord = asRecord(response);
    const steerText =
      methodLower.includes("requestapproval") && typeof responseRecord?.steerText === "string"
        ? responseRecord.steerText.trim()
        : "";
    log.info("codex interactive request resolved", {
      sessionKey: params.sessionKey,
      requestId,
      method,
      threadId: threadId || undefined,
      turnId: turnId || undefined,
      workspaceDir: params.workspaceDir,
      timedOut,
      mappedResponse,
      steerText: steerText || undefined,
    });
    if (steerText && threadId) {
      const steerPayloads = [
        { threadId, turnId: turnId || undefined, text: steerText },
        { thread_id: threadId, turn_id: turnId || undefined, text: steerText },
      ];
      await requestWithFallbacks({
        client,
        methods: [...TURN_STEER_METHODS],
        payloads: steerPayloads,
        timeoutMs: settings.requestTimeoutMs,
      });
    }
    return mappedResponse;
  });

  setActiveCodexAppServerRun(params.sessionId, queueHandle, params.sessionKey);
  try {
    await client.connect();
    await initializeCodexAppServerClient({
      client,
      settings,
      sessionKey: params.sessionKey ?? params.sessionId,
      workspaceDir: params.workspaceDir,
    });

    if (!threadId) {
      const created = await requestWithFallbacks({
        client,
        methods: ["thread/new", "thread/start"],
        payloads: [
          { cwd: params.workspaceDir, model: params.model },
          { cwd: params.workspaceDir },
          {},
        ],
        timeoutMs: settings.requestTimeoutMs,
      });
      threadId = extractIds(created).threadId ?? "";
      if (!threadId) {
        throw new Error("Codex App Server did not return a thread id.");
      }
    } else {
      await requestWithFallbacks({
        client,
        methods: ["thread/resume"],
        payloads: [{ threadId }, { thread_id: threadId }],
        timeoutMs: settings.requestTimeoutMs,
      }).catch(() => undefined);
    }

    const started = await requestWithFallbacks({
      client,
      methods: ["turn/start"],
      payloads: buildTurnStartPayloads({
        threadId,
        prompt: params.prompt,
        workspaceDir: params.workspaceDir,
        model: params.model,
        collaborationMode: params.collaborationMode,
      }),
      timeoutMs: Math.max(params.timeoutMs ?? 0, settings.requestTimeoutMs),
    });
    const startedIds = extractIds(started);
    threadId ||= startedIds.threadId ?? "";
    turnId ||= startedIds.runId ?? "";
    // `turn/start` responses can echo request input and metadata; assistant text
    // should come from turn lifecycle notifications instead.

    await completion;
    if (completed && !interrupted) {
      await new Promise<void>((resolve) => setTimeout(resolve, TRAILING_NOTIFICATION_SETTLE_MS));
      await notificationQueue;
    }

    return {
      payloads: assistantText ? [{ text: assistantText }] : undefined,
      meta: {
        durationMs: Date.now() - startedAt,
        aborted: interrupted,
        agentMeta: {
          sessionId: threadId,
          provider: "codex-app-server",
          model: params.model ?? "default",
        },
      },
    };
  } finally {
    if (threadId) {
      await requestWithFallbacks({
        client,
        methods: ["thread/unsubscribe"],
        payloads: [{ threadId }, { thread_id: threadId }],
        timeoutMs: settings.requestTimeoutMs,
      }).catch(() => undefined);
    }
    clearActiveCodexAppServerRun(params.sessionId, queueHandle, params.sessionKey);
    await client.close().catch(() => undefined);
  }
}

export const __testing = {
  advancePendingQuestionnaire,
  applyThreadFilter,
  buildInteractiveRequestPresentation,
  buildCodexPendingUserInputActions,
  buildMarkdownCodeBlock,
  buildPromptText,
  collectStreamingText,
  dispatchJsonRpcEnvelope,
  extractAccountSummary,
  extractOptionValues,
  extractAssistantNotificationText,
  extractExperimentalFeatureSummaries,
  extractMcpServerSummaries,
  extractRateLimitSummaries,
  extractSkillSummaries,
  extractThreadState,
  extractThreadReplayFromReadResult,
  formatRateLimitWindowName,
  isTransportClosedError,
  isMethodUnavailableError,
  mergeAssistantReplyAndEmit,
  mapPendingInputResponse,
  turnSteerMethods: [...TURN_STEER_METHODS],
};
