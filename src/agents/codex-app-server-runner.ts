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
  clearActiveCodexAppServerRun,
  setActiveCodexAppServerRun,
  type CodexAppServerQueueHandle,
} from "./codex-app-server-runs.js";
import { normalizeProviderId } from "./model-selection.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner/types.js";

const log = createSubsystemLogger("agent/codex-app-server");
const DEFAULT_PROTOCOL_VERSION = "1.0";

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

export type ParsedCodexUserInput =
  | { kind: "option"; index: number }
  | { kind: "text"; text: string };

export type PendingCodexUserInputState = {
  requestId: string;
  options: string[];
  expiresAt: number;
  promptText?: string;
  method?: string;
};

export type CodexMirrorSlashSource = "codex" | "mcp" | "unknown";

export type CodexMirrorSlashCommand = {
  name: string;
  description?: string;
  source: CodexMirrorSlashSource;
};

export type CodexMirrorSlashCollision = {
  name: string;
  sources: CodexMirrorSlashSource[];
};

export type CodexMirrorSlashDiscoveryResult = {
  available: boolean;
  commands: CodexMirrorSlashCommand[];
  collisions: CodexMirrorSlashCollision[];
  error?: string;
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

type RunCodexAppServerAgentParams = {
  sessionId: string;
  sessionKey?: string;
  prompt: string;
  imagePaths?: string[];
  model?: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  timeoutMs: number;
  runId: string;
  existingThreadId?: string;
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
    "summary",
    "title",
    "content",
    "description",
    "reason",
  ];
  const out = directKeys.flatMap((key) => collectText(record[key]));
  for (const nestedKey of ["item", "turn", "thread", "response", "result", "data"]) {
    out.push(...collectText(record[nestedKey]));
  }
  return out;
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
};

function extractAssistantNotificationText(
  method: string,
  params: unknown,
): AssistantNotificationText {
  const methodLower = method.trim().toLowerCase();
  if (methodLower === "item/agentmessage/delta") {
    return {
      mode: "delta",
      text: collectStreamingText(params),
    };
  }
  if (methodLower === "item/completed") {
    return {
      mode: "snapshot",
      text: extractAssistantTextFromItemPayload(params),
    };
  }
  return { mode: "ignore", text: "" };
}

function extractOptionValues(value: unknown): string[] {
  const record = asRecord(value);
  if (!record) {
    return [];
  }
  for (const key of ["options", "choices", "availableDecisions", "decisions"]) {
    const raw = record[key];
    if (!Array.isArray(raw)) {
      continue;
    }
    const values = raw
      .map((entry) => {
        if (typeof entry === "string") {
          return entry.trim();
        }
        return (
          pickString(asRecord(entry) ?? {}, ["label", "title", "text", "value", "name", "id"]) ?? ""
        );
      })
      .filter(Boolean);
    if (values.length > 0) {
      return values;
    }
  }
  return [];
}

function buildPromptText(params: {
  method: string;
  requestId: string;
  options: string[];
  question?: string;
  expiresAt: number;
  requestParams: unknown;
}): string {
  const lines = [`🧭 Codex input requested (${params.requestId})`];
  if (params.question) {
    lines.push(params.question);
  }
  if (params.options.length > 0) {
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
  const requestText = dedupeJoinedText(collectText(params.requestParams));
  if (requestText && !lines.includes(requestText)) {
    lines.push("", requestText);
  }
  if (/requestapproval/i.test(params.method)) {
    lines.push("", "This response will be sent to Codex as an approval decision.");
  }
  return lines.join("\n");
}

function buildCodexTelegramOptionButtons(
  options: string[],
): ReadonlyArray<ReadonlyArray<{ text: string; callback_data: string }>> | undefined {
  const trimmed = options
    .map((option) => option.trim())
    .filter(Boolean)
    .slice(0, 8);
  if (trimmed.length === 0) {
    return undefined;
  }
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let index = 0; index < trimmed.length; index += 2) {
    const row = trimmed.slice(index, index + 2).map((option, offset) => {
      const ordinal = index + offset + 1;
      return {
        text: `${ordinal}. ${option}`,
        callback_data: String(ordinal),
      };
    });
    rows.push(row);
  }
  return rows;
}

function pickPendingSelectionText(value: unknown, options: string[]): string {
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  const index = typeof record.index === "number" ? record.index : undefined;
  if (index != null && Number.isInteger(index)) {
    return options[index] ?? "";
  }
  return pickString(record, ["option", "text", "value", "label"]) ?? "";
}

function resolveApprovalDecisionFromText(text: string, supportsSession: boolean): string {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return "cancel";
  }
  if (supportsSession && normalized.includes("session")) {
    return "acceptForSession";
  }
  if (/cancel|abort|stop/.test(normalized)) {
    return "cancel";
  }
  if (/deny|decline|reject|block|no/.test(normalized)) {
    return "decline";
  }
  if (/approve|allow|accept|yes/.test(normalized)) {
    return "accept";
  }
  return "decline";
}

function buildToolRequestUserInputResponse(requestParams: unknown, response: unknown): unknown {
  const record = asRecord(requestParams);
  const questions = Array.isArray(record?.questions) ? record.questions : [];
  if (questions.length === 0) {
    return response;
  }
  const firstQuestion = asRecord(questions[0]);
  const firstQuestionId = pickString(firstQuestion ?? {}, ["id"]) ?? "q1";
  const selected = pickPendingSelectionText(response, extractOptionValues(firstQuestion));
  return {
    answers: {
      [firstQuestionId]: {
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
  timedOut: boolean;
}): unknown {
  const { methodLower, requestParams, response, options, timedOut } = params;
  if (methodLower.includes("item/tool/requestuserinput")) {
    return buildToolRequestUserInputResponse(requestParams, timedOut ? { text: "" } : response);
  }
  if (methodLower.includes("requestapproval")) {
    if (timedOut) {
      return { decision: "cancel" };
    }
    const selected = pickPendingSelectionText(response, options);
    return { decision: resolveApprovalDecisionFromText(selected, true) };
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
      void this.handleMessage(rawDataToString(data));
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
      void this.handleLine(line);
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
  const result = await params.onRequest(method, payload.params);
  params.respond({
    jsonrpc: "2.0",
    id: payload.id,
    result: result ?? {},
  });
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

function extractSlashCommands(value: unknown): CodexMirrorSlashCommand[] {
  const root = asRecord(value);
  const records = Array.isArray(value)
    ? value
    : [
        ...(Array.isArray(root?.commands) ? (root.commands as unknown[]) : []),
        ...(Array.isArray(root?.items) ? (root.items as unknown[]) : []),
      ];
  const out = new Map<string, CodexMirrorSlashCommand>();
  for (const entry of records) {
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    const name = pickString(record, ["name", "command", "id"]);
    if (!name) {
      continue;
    }
    out.set(name, {
      name,
      description: pickString(record, ["description", "summary", "title"]),
      source:
        (pickString(record, ["source"], { trim: true })?.toLowerCase() as CodexMirrorSlashSource) ??
        "unknown",
    });
  }
  return [...out.values()].toSorted((left, right) => left.name.localeCompare(right.name));
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

export async function discoverCodexAppServerSlashCommands(params?: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<CodexMirrorSlashDiscoveryResult> {
  const settings = resolveCodexAppServerSettings(params?.config);
  if (!settings.enabled) {
    return {
      available: false,
      commands: [],
      collisions: [],
      error: 'Provider "codex-app-server" is disabled.',
    };
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
      methods: ["commands/list", "mcp/commands/list"],
      payloads: [{}],
      timeoutMs: settings.requestTimeoutMs,
    });
    return {
      available: true,
      commands: extractSlashCommands(result),
      collisions: [],
    };
  } catch (error) {
    return {
      available: false,
      commands: [],
      collisions: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await client.close().catch(() => undefined);
  }
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
  let awaitingInput = false;
  let interrupted = false;
  let completed = false;
  let pendingInput: {
    requestId: string;
    methodLower: string;
    options: string[];
    expiresAt: number;
    resolve: (value: unknown) => void;
  } | null = null;
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

  const queueHandle: CodexAppServerQueueHandle = {
    queueMessage: async (text) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return false;
      }
      if (pendingInput) {
        const parsed = parseCodexUserInput(trimmed, pendingInput.options.length);
        if (parsed.kind === "option") {
          pendingInput.resolve({
            index: parsed.index,
            option: pendingInput.options[parsed.index] ?? "",
          });
        } else {
          pendingInput.resolve({ text: parsed.text });
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
        methods: ["turn/steer", "thread/steer"],
        payloads: steerPayloads,
        timeoutMs: settings.requestTimeoutMs,
      });
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

  client.setNotificationHandler(async (method, notificationParams) => {
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
    const question = dedupeJoinedText(collectText(requestParams));
    const requestId = ids.requestId ?? `${params.runId}-${Date.now().toString(36)}`;
    const expiresAt = Date.now() + settings.inputTimeoutMs;
    const promptText = buildPromptText({
      method,
      requestId,
      options,
      question,
      expiresAt,
      requestParams,
    });

    awaitingInput = true;
    await params.onPendingUserInput?.({
      requestId,
      options,
      expiresAt,
      promptText,
      method,
    });
    const telegramButtons = buildCodexTelegramOptionButtons(options);
    await params.onToolResult?.({
      text: promptText,
      ...(telegramButtons
        ? {
            channelData: {
              telegram: {
                buttons: telegramButtons,
              },
            },
          }
        : {}),
    });

    let timedOut = false;
    const response = await new Promise<unknown>((resolve) => {
      pendingInput = {
        requestId,
        methodLower,
        options,
        expiresAt,
        resolve,
      };
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
    return mapPendingInputResponse({
      methodLower,
      requestParams,
      response,
      options,
      timedOut,
    });
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
      payloads: buildTurnInput(params.prompt).map((input) => ({
        threadId,
        thread_id: threadId,
        input,
        cwd: params.workspaceDir,
        model: params.model,
      })),
      timeoutMs: Math.max(params.timeoutMs, settings.requestTimeoutMs),
    });
    const startedIds = extractIds(started);
    threadId ||= startedIds.threadId ?? "";
    turnId ||= startedIds.runId ?? "";
    // `turn/start` responses can echo request input and metadata; assistant text
    // should come from turn lifecycle notifications instead.

    await Promise.race([
      completion,
      new Promise<void>((resolve) => setTimeout(resolve, Math.max(1_000, params.timeoutMs))),
    ]);

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
  applyThreadFilter,
  buildCodexTelegramOptionButtons,
  collectStreamingText,
  extractAssistantNotificationText,
  extractThreadReplayFromReadResult,
  isMethodUnavailableError,
  mergeAssistantReplyAndEmit,
  mapPendingInputResponse,
  resolveApprovalDecisionFromText,
};
