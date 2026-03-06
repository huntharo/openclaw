import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import { WebSocket } from "ws";
import type { OpenClawConfig } from "../config/config.js";
import { retryAsync } from "../infra/retry.js";
import { rawDataToString } from "../infra/ws.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  clearActiveCodexAppServerRun,
  setActiveCodexAppServerRun,
  type CodexAppServerQueueHandle,
} from "./codex-app-server-runs.js";
import { normalizeProviderId } from "./model-selection.js";
import type { EmbeddedPiRunResult } from "./pi-embedded-runner/types.js";

const log = createSubsystemLogger("agent/codex-app-server");
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_USER_INPUT_TIMEOUT_MS = 15 * 60_000;

type JsonRpcEnvelope = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
};

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

type JsonRpcRequestHandler = (method: string, params: unknown) => Promise<unknown>;
type JsonRpcNotificationHandler = (method: string, params: unknown) => void | Promise<void>;

type JsonRpcClient = {
  setNotificationHandler: (handler: JsonRpcNotificationHandler) => void;
  setRequestHandler: (handler: JsonRpcRequestHandler) => void;
  connect: () => Promise<void>;
  close: () => Promise<void>;
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
};

class WsJsonRpcClient {
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, PendingRequest>();
  private requestCounter = 0;
  private readonly url: string;
  private readonly requestTimeoutMs: number;
  private readonly headers: Record<string, string> | undefined;
  private onNotificationHandler: JsonRpcNotificationHandler | null = null;
  private onRequestHandler: JsonRpcRequestHandler | null = null;

  constructor(params: { url: string; requestTimeoutMs: number; headers?: Record<string, string> }) {
    this.url = params.url;
    this.requestTimeoutMs = params.requestTimeoutMs;
    this.headers = params.headers;
  }

  setNotificationHandler(handler: JsonRpcNotificationHandler) {
    this.onNotificationHandler = handler;
  }

  setRequestHandler(handler: JsonRpcRequestHandler) {
    this.onRequestHandler = handler;
  }

  async connect(): Promise<void> {
    await retryAsync(
      async () => {
        await this.connectOnce();
      },
      {
        attempts: 3,
        minDelayMs: 250,
        maxDelayMs: 2_000,
        jitter: 0.1,
        label: "codex-app-server-connect",
      },
    );
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = null;
    this.flushPending(new Error("codex app server connection closed"));
    if (!socket) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          socket.terminate();
        } catch {
          // no-op
        }
        resolve();
      }, 500);
      socket.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        socket.close();
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("codex app server websocket not connected");
    }
    const id = `rpc-${Date.now().toString(36)}-${++this.requestCounter}`;
    const frame = {
      jsonrpc: "2.0",
      id,
      method,
      params: params ?? {},
    };
    const timeout = Math.max(100, timeoutMs ?? this.requestTimeoutMs);
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app server timeout: ${method}`));
      }, timeout);
      this.pending.set(id, {
        method,
        resolve,
        reject,
        timer,
      });
    });
    socket.send(JSON.stringify(frame));
    return await promise;
  }

  private async connectOnce(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      return;
    }
    if (this.socket) {
      await this.close();
    }
    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url, {
        headers: this.headers,
      });
      this.socket = socket;
      const cleanup = () => {
        socket.removeAllListeners("open");
        socket.removeAllListeners("error");
      };
      socket.once("open", () => {
        cleanup();
        resolve();
      });
      socket.once("error", (err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
      socket.on("message", (raw) => {
        void this.handleMessage(rawDataToString(raw));
      });
      socket.on("close", () => {
        if (this.socket === socket) {
          this.socket = null;
        }
        this.flushPending(new Error("codex app server websocket disconnected"));
      });
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return;
    }
    const frame = payload as JsonRpcEnvelope;
    if (frame.id != null && (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error"))) {
      const key = String(frame.id);
      const pending = this.pending.get(key);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(key);
      if (frame.error) {
        pending.reject(
          new Error(
            `codex app server rpc error (${frame.error.code ?? "unknown"}): ${frame.error.message ?? "unknown"}`,
          ),
        );
        return;
      }
      pending.resolve(frame.result);
      return;
    }

    if (typeof frame.method !== "string" || frame.method.trim() === "") {
      return;
    }
    const method = frame.method.trim();
    const params = frame.params;
    if (frame.id == null) {
      if (this.onNotificationHandler) {
        await this.onNotificationHandler(method, params);
      }
      return;
    }
    const result = this.onRequestHandler ? await this.onRequestHandler(method, params) : undefined;
    this.safeSend({
      jsonrpc: "2.0",
      id: frame.id,
      result: result === undefined ? {} : result,
    });
  }

  private safeSend(payload: Record<string, unknown>) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      // no-op
    }
  }

  private flushPending(err: Error) {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
  }
}

type SharedChannel = {
  onNotification: JsonRpcNotificationHandler | null;
  onRequest: JsonRpcRequestHandler | null;
};

class StdioAppServerHost {
  private process: ChildProcessWithoutNullStreams | null = null;
  private readline: readline.Interface | null = null;
  private readonly channels = new Map<number, SharedChannel>();
  private readonly pending = new Map<string, PendingRequest>();
  private channelCounter = 0;
  private requestCounter = 0;
  private starting: Promise<void> | null = null;
  private currentKey = "";

  async registerChannel(params: {
    command: string;
    args: string[];
    requestTimeoutMs: number;
  }): Promise<number> {
    await this.ensureStarted(params);
    const channelId = ++this.channelCounter;
    this.channels.set(channelId, {
      onNotification: null,
      onRequest: null,
    });
    return channelId;
  }

  unregisterChannel(channelId: number) {
    this.channels.delete(channelId);
  }

  setChannelHandlers(
    channelId: number,
    handlers: Partial<Pick<SharedChannel, "onNotification" | "onRequest">>,
  ) {
    const channel = this.channels.get(channelId);
    if (!channel) {
      return;
    }
    if (handlers.onNotification !== undefined) {
      channel.onNotification = handlers.onNotification;
    }
    if (handlers.onRequest !== undefined) {
      channel.onRequest = handlers.onRequest;
    }
  }

  async request(params: {
    channelId: number;
    method: string;
    payload: unknown;
    timeoutMs: number;
    command: string;
    args: string[];
  }): Promise<unknown> {
    await this.ensureStarted({
      command: params.command,
      args: params.args,
      requestTimeoutMs: params.timeoutMs,
    });
    const child = this.process;
    if (!child || child.stdin.destroyed) {
      throw new Error("codex app server stdio not connected");
    }
    if (!this.channels.has(params.channelId)) {
      throw new Error("codex app server channel is not registered");
    }
    const id = `rpc-${Date.now().toString(36)}-${++this.requestCounter}`;
    const timeout = Math.max(100, params.timeoutMs);
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app server timeout: ${params.method}`));
      }, timeout);
      this.pending.set(id, {
        method: params.method,
        resolve,
        reject,
        timer,
      });
    });
    const frame = {
      jsonrpc: "2.0",
      id,
      method: params.method,
      params: params.payload ?? {},
    };
    child.stdin.write(`${JSON.stringify(frame)}\n`);
    return await promise;
  }

  private async ensureStarted(params: {
    command: string;
    args: string[];
    requestTimeoutMs: number;
  }): Promise<void> {
    const key = `${params.command}\n${params.args.join("\n")}`;
    if (this.process && !this.process.killed && this.currentKey === key) {
      return;
    }
    if (!this.starting) {
      this.starting = (async () => {
        if (this.process && !this.process.killed && this.currentKey !== key) {
          this.terminateProcess(new Error("codex app server process command changed"));
        }
        if (this.process && !this.process.killed) {
          return;
        }
        await this.startProcess({
          command: params.command,
          args: params.args,
          requestTimeoutMs: params.requestTimeoutMs,
        });
        this.currentKey = key;
      })()
        .catch((err) => {
          throw err;
        })
        .finally(() => {
          this.starting = null;
        });
    }
    await this.starting;
  }

  private async startProcess(params: {
    command: string;
    args: string[];
    requestTimeoutMs: number;
  }): Promise<void> {
    log.info("starting codex app server stdio process", {
      command: params.command,
      args: params.args,
    });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(params.command, params.args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });

      let settled = false;
      const startupTimer = setTimeout(
        () => {
          fail(
            new Error(
              `timed out starting codex app server process (${params.command} ${params.args.join(" ")})`,
            ),
          );
        },
        Math.max(1_000, params.requestTimeoutMs),
      );
      const fail = (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(startupTimer);
        this.terminateProcess(err);
        reject(err);
      };
      const succeed = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(startupTimer);
        resolve();
      };

      child.once("error", (err) => {
        fail(err instanceof Error ? err : new Error(String(err)));
      });
      child.once("spawn", () => {
        this.process = child;
        log.info("codex app server stdio process spawned", {
          pid: child.pid,
        });
        this.readline = readline.createInterface({
          input: child.stdout,
          crlfDelay: Infinity,
        });
        this.readline.on("line", (line) => {
          void this.handleRawMessage(line);
        });
        child.stderr.on("data", (chunk) => {
          const text = String(chunk ?? "").trim();
          if (text) {
            log.debug(`codex app server stderr: ${text}`);
          }
        });
        child.once("close", () => {
          log.warn("codex app server stdio process closed", {
            pid: child.pid,
          });
          this.terminateProcess(new Error("codex app server stdio process exited"));
        });
        succeed();
      });
    });
  }

  private async handleRawMessage(rawLine: string): Promise<void> {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      log.debug(`ignoring non-json stdio line from codex app server: ${trimmed.slice(0, 160)}`);
      return;
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return;
    }
    const frame = payload as JsonRpcEnvelope;
    if (frame.id != null && (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error"))) {
      const key = String(frame.id);
      const pending = this.pending.get(key);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      this.pending.delete(key);
      if (frame.error) {
        pending.reject(
          new Error(
            `codex app server rpc error (${frame.error.code ?? "unknown"}) on ${pending.method}: ${frame.error.message ?? "unknown"}`,
          ),
        );
        return;
      }
      pending.resolve(frame.result);
      return;
    }

    if (typeof frame.method !== "string" || frame.method.trim() === "") {
      return;
    }
    const method = frame.method.trim();
    const params = frame.params;
    if (frame.id == null) {
      await Promise.allSettled(
        [...this.channels.values()].map(async (channel) => {
          if (channel.onNotification) {
            await channel.onNotification(method, params);
          }
        }),
      );
      return;
    }

    let handled = false;
    let response: unknown = {};
    for (const channel of this.channels.values()) {
      if (!channel.onRequest) {
        continue;
      }
      try {
        const next = await channel.onRequest(method, params);
        if (next !== undefined) {
          handled = true;
          response = next;
          break;
        }
      } catch (err) {
        log.warn(`codex app server stdio request handler error: ${String(err)}`);
      }
    }
    if (!handled) {
      response = {};
    }
    this.writeProcess({
      jsonrpc: "2.0",
      id: frame.id,
      result: response ?? {},
    });
  }

  private writeProcess(payload: Record<string, unknown>) {
    const child = this.process;
    if (!child || child.stdin.destroyed) {
      return;
    }
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  private terminateProcess(err: Error) {
    const child = this.process;
    this.process = null;
    this.currentKey = "";
    if (this.readline) {
      this.readline.removeAllListeners();
      this.readline.close();
      this.readline = null;
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
    if (!child) {
      return;
    }
    if (!child.killed) {
      try {
        child.kill();
      } catch {
        // no-op
      }
    }
  }
}

const sharedStdioHost = new StdioAppServerHost();

class SharedStdioJsonRpcClient implements JsonRpcClient {
  private channelId: number | null = null;
  private readonly requestTimeoutMs: number;
  private readonly command: string;
  private readonly args: string[];
  private onNotificationHandler: JsonRpcNotificationHandler | null = null;
  private onRequestHandler: JsonRpcRequestHandler | null = null;

  constructor(params: { requestTimeoutMs: number; command: string; args: string[] }) {
    this.requestTimeoutMs = params.requestTimeoutMs;
    this.command = params.command;
    this.args = params.args;
  }

  setNotificationHandler(handler: JsonRpcNotificationHandler) {
    this.onNotificationHandler = handler;
    this.syncHandlers();
  }

  setRequestHandler(handler: JsonRpcRequestHandler) {
    this.onRequestHandler = handler;
    this.syncHandlers();
  }

  async connect(): Promise<void> {
    if (this.channelId != null) {
      return;
    }
    this.channelId = await sharedStdioHost.registerChannel({
      command: this.command,
      args: this.args,
      requestTimeoutMs: this.requestTimeoutMs,
    });
    this.syncHandlers();
  }

  async close(): Promise<void> {
    const channelId = this.channelId;
    this.channelId = null;
    if (channelId == null) {
      return;
    }
    sharedStdioHost.unregisterChannel(channelId);
  }

  async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    const channelId = this.channelId;
    if (channelId == null) {
      throw new Error("codex app server stdio channel not connected");
    }
    return await sharedStdioHost.request({
      channelId,
      method,
      payload: params ?? {},
      timeoutMs: Math.max(100, timeoutMs ?? this.requestTimeoutMs),
      command: this.command,
      args: this.args,
    });
  }

  private syncHandlers() {
    const channelId = this.channelId;
    if (channelId == null) {
      return;
    }
    sharedStdioHost.setChannelHandlers(channelId, {
      onNotification: this.onNotificationHandler,
      onRequest: this.onRequestHandler,
    });
  }
}

type CodexAppServerSettings = {
  enabled: boolean;
  command: string;
  args: string[];
  url?: string;
  transport: "stdio" | "websocket";
  requestTimeoutMs: number;
  inputTimeoutMs: number;
  headers?: Record<string, string>;
};

export type CodexMirrorSlashSource = "codex" | "mcp" | "unknown";

export type CodexMirrorSlashCommand = {
  name: string;
  source: CodexMirrorSlashSource;
  raw: string;
};

export type CodexMirrorSlashCollision = {
  name: string;
  raws: string[];
};

export type CodexMirrorSlashDiscoveryResult = {
  available: boolean;
  commands: CodexMirrorSlashCommand[];
  collisions: CodexMirrorSlashCollision[];
  error?: string;
};

export type CodexThreadDiscoveryEntry = {
  threadId: string;
  title?: string;
  projectKey?: string;
  updatedAt?: number;
};

export type CodexThreadDiscoveryResult = {
  available: boolean;
  threads: CodexThreadDiscoveryEntry[];
  error?: string;
};

export function isCodexAppServerProvider(provider: string, cfg?: OpenClawConfig): boolean {
  const normalized = normalizeProviderId(provider);
  if (normalized !== "codex-app-server") {
    return false;
  }
  const configured = cfg?.agents?.defaults?.codexAppServer?.enabled;
  if (configured === undefined) {
    return true;
  }
  return configured;
}

function normalizeHeaders(
  input: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!input) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const k = key.trim();
    const v = value.trim();
    if (!k || !v) {
      continue;
    }
    next[k] = v;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function resolveCodexAppServerSettings(cfg?: OpenClawConfig): CodexAppServerSettings {
  const configured = cfg?.agents?.defaults?.codexAppServer;
  const enabled = configured?.enabled ?? true;
  const url = configured?.url?.trim() || process.env.OPENCLAW_CODEX_APP_SERVER_URL?.trim();
  const configuredTransport = configured?.transport?.trim().toLowerCase();
  const transport =
    configuredTransport === "websocket" || configuredTransport === "stdio"
      ? configuredTransport
      : "stdio";
  const command =
    configured?.command?.trim() || process.env.OPENCLAW_CODEX_APP_SERVER_COMMAND?.trim() || "codex";
  const argsFromConfig = (configured?.args ?? []).map((part) => part.trim()).filter(Boolean);
  const argsFromEnv = (process.env.OPENCLAW_CODEX_APP_SERVER_ARGS ?? "")
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const args =
    argsFromConfig.length > 0
      ? ["app-server", ...argsFromConfig]
      : argsFromEnv.length > 0
        ? ["app-server", ...argsFromEnv]
        : ["app-server"];
  const requestTimeoutEnv = Number.parseInt(
    process.env.OPENCLAW_CODEX_APP_SERVER_REQUEST_TIMEOUT_MS ?? "",
    10,
  );
  const resolvedRequestTimeoutEnv =
    Number.isFinite(requestTimeoutEnv) && requestTimeoutEnv > 0
      ? requestTimeoutEnv
      : DEFAULT_REQUEST_TIMEOUT_MS;
  const requestTimeoutMs = configured?.requestTimeoutMs ?? resolvedRequestTimeoutEnv;
  const inputTimeoutEnv = Number.parseInt(
    process.env.OPENCLAW_CODEX_APP_SERVER_INPUT_TIMEOUT_MS ?? "",
    10,
  );
  const resolvedInputTimeoutEnv =
    Number.isFinite(inputTimeoutEnv) && inputTimeoutEnv > 0
      ? inputTimeoutEnv
      : DEFAULT_USER_INPUT_TIMEOUT_MS;
  const inputTimeoutMs = configured?.inputTimeoutMs ?? resolvedInputTimeoutEnv;
  const configuredHeaders = normalizeHeaders(configured?.headers);
  const token =
    configured?.authToken?.trim() || process.env.OPENCLAW_CODEX_APP_SERVER_TOKEN?.trim();
  const headers = {
    ...configuredHeaders,
    ...(token ? { Authorization: `Bearer ${token}` } : undefined),
  };
  return {
    enabled,
    command,
    args,
    url,
    transport,
    requestTimeoutMs: Math.max(100, requestTimeoutMs),
    inputTimeoutMs: Math.max(5_000, inputTimeoutMs),
    headers: Object.keys(headers).length > 0 ? headers : undefined,
  };
}

function normalizeMirrorSlashName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  const withoutSlash = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const token = withoutSlash.split(/\s+/)[0] ?? "";
  const normalized = token
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/[-_]{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return normalized.slice(0, 64);
}

function extractSlashTokenFromString(value: string, allowBareName: boolean): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("/")) {
    const token = trimmed.slice(1).split(/\s+/)[0] ?? "";
    if (/^[a-z0-9][a-z0-9_-]*$/i.test(token)) {
      return token;
    }
    return undefined;
  }
  if (allowBareName && /^[a-z0-9][a-z0-9_-]*$/i.test(trimmed)) {
    return trimmed;
  }
  return undefined;
}

function extractMirrorSlashCandidates(params: {
  value: unknown;
  source: CodexMirrorSlashSource;
  commandContext?: boolean;
  depth?: number;
}): CodexMirrorSlashCommand[] {
  const value = params.value;
  const depth = params.depth ?? 0;
  if (depth > 8 || value == null) {
    return [];
  }
  const commandContext = params.commandContext === true;
  const out: CodexMirrorSlashCommand[] = [];
  const pushCandidate = (rawCandidate: string) => {
    const normalized = normalizeMirrorSlashName(rawCandidate);
    if (!normalized) {
      return;
    }
    out.push({
      name: normalized,
      source: params.source,
      raw: rawCandidate.trim(),
    });
  };
  if (typeof value === "string") {
    const token = extractSlashTokenFromString(value, commandContext);
    if (token) {
      pushCandidate(token);
    }
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => {
      out.push(
        ...extractMirrorSlashCandidates({
          value: entry,
          source: params.source,
          commandContext,
          depth: depth + 1,
        }),
      );
    });
    return out;
  }
  const record = asRecord(value);
  if (!record) {
    return out;
  }
  for (const [key, entry] of Object.entries(record)) {
    const keyLower = key.toLowerCase();
    const nextCommandContext =
      commandContext ||
      /command|slash|tool|mcp|action|actions|manifest|registry|list|item|items|available/.test(
        keyLower,
      );
    if (typeof entry === "string") {
      const allowBareName = commandContext || keyLower === "name" || keyLower === "command";
      const token = extractSlashTokenFromString(entry, allowBareName);
      if (token) {
        pushCandidate(token);
      }
      continue;
    }
    if (Array.isArray(entry) || (entry && typeof entry === "object")) {
      out.push(
        ...extractMirrorSlashCandidates({
          value: entry,
          source: params.source,
          commandContext: nextCommandContext,
          depth: depth + 1,
        }),
      );
    }
  }
  return out;
}

function dedupeMirrorSlashCandidates(
  candidates: CodexMirrorSlashCommand[],
): Pick<CodexMirrorSlashDiscoveryResult, "commands" | "collisions"> {
  const byName = new Map<
    string,
    {
      command: CodexMirrorSlashCommand;
      raws: Set<string>;
    }
  >();
  for (const candidate of candidates) {
    const existing = byName.get(candidate.name);
    if (!existing) {
      byName.set(candidate.name, {
        command: candidate,
        raws: new Set([candidate.raw]),
      });
      continue;
    }
    existing.raws.add(candidate.raw);
    const keepExisting = existing.command.source === "codex";
    const preferIncoming = !keepExisting && candidate.source === "codex";
    if (preferIncoming) {
      existing.command = candidate;
    }
  }
  const commands = [...byName.values()]
    .map((entry) => entry.command)
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const collisions = [...byName.entries()]
    .map(([name, entry]) => ({ name, raws: [...entry.raws].toSorted() }))
    .filter((entry) => entry.raws.length > 1)
    .toSorted((a, b) => a.name.localeCompare(b.name));
  return { commands, collisions };
}

function resolveSlashDiscoveryAttempts(): Array<{
  method: string;
  source: CodexMirrorSlashSource;
  variants: Array<Record<string, unknown>>;
}> {
  return [
    {
      method: "commands/list",
      source: "codex",
      variants: [{}, { scope: "slash" }, { includeMcp: true }],
    },
    {
      method: "slash/list",
      source: "codex",
      variants: [{}, { includeMcp: true }],
    },
    {
      method: "commands/discover",
      source: "codex",
      variants: [{}, { includeMcp: true }],
    },
    {
      method: "mcp/commands/list",
      source: "mcp",
      variants: [{}, { includeBuiltin: false }],
    },
    {
      method: "mcp/list",
      source: "mcp",
      variants: [{}, { kind: "commands" }],
    },
  ];
}

function resolveThreadDiscoveryAttempts(): Array<{
  method: string;
  variants: Array<Record<string, unknown>>;
}> {
  return [
    {
      method: "thread/list",
      variants: [{}, { limit: 200 }, { pageSize: 200 }],
    },
    {
      method: "threads/list",
      variants: [{}, { limit: 200 }, { pageSize: 200 }],
    },
    {
      method: "conversation/list",
      variants: [{}, { limit: 200 }, { pageSize: 200 }],
    },
    {
      method: "conversations/list",
      variants: [{}, { limit: 200 }, { pageSize: 200 }],
    },
    {
      method: "session/list",
      variants: [{}, { limit: 200 }, { pageSize: 200 }],
    },
    {
      method: "sessions/list",
      variants: [{}, { limit: 200 }, { pageSize: 200 }],
    },
  ];
}

type ExtractedIds = {
  threadId?: string;
  runId?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function pickString(
  record: Record<string, unknown>,
  keys: string[],
  options?: {
    trim?: boolean;
    allowEmpty?: boolean;
  },
): string | undefined {
  const trim = options?.trim ?? true;
  const allowEmpty = options?.allowEmpty ?? false;
  for (const key of keys) {
    const value = record[key];
    if (typeof value !== "string") {
      continue;
    }
    if (!trim) {
      if (allowEmpty || value.length > 0) {
        return value;
      }
      continue;
    }
    const trimmed = value.trim();
    if (allowEmpty || trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function parseTimestampLike(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) {
      return undefined;
    }
    if (value >= 1_000_000_000_000) {
      return Math.floor(value);
    }
    if (value >= 1_000_000_000) {
      return Math.floor(value * 1000);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    const numeric = Number.parseInt(trimmed, 10);
    if (Number.isFinite(numeric)) {
      return parseTimestampLike(numeric);
    }
    return undefined;
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

function resolveThreadProjectKey(record: Record<string, unknown>): string | undefined {
  const direct =
    pickString(record, [
      "cwd",
      "workspaceDir",
      "workspace_dir",
      "workspace",
      "projectKey",
      "project_key",
      "projectPath",
      "project_path",
      "directory",
      "path",
    ]) ?? "";
  if (direct.startsWith("/") || /^[A-Za-z]:\\/.test(direct)) {
    return direct;
  }
  const nestedWorkspace = asRecord(record.workspace) ?? asRecord(record.project);
  if (!nestedWorkspace) {
    return undefined;
  }
  return (
    pickString(nestedWorkspace, ["cwd", "workspaceDir", "path", "projectPath", "root"]) ?? undefined
  );
}

function resolveThreadUpdatedAt(record: Record<string, unknown>): number | undefined {
  const candidates = [
    record.updatedAt,
    record.updated_at,
    record.lastUpdatedAt,
    record.last_updated_at,
    record.lastMessageAt,
    record.last_message_at,
    record.modifiedAt,
    record.modified_at,
    record.timestamp,
    record.createdAt,
    record.created_at,
  ];
  for (const candidate of candidates) {
    const parsed = parseTimestampLike(candidate);
    if (parsed != null) {
      return parsed;
    }
  }
  return undefined;
}

function extractThreadDiscoveryCandidates(params: {
  value: unknown;
  depth?: number;
  inThreadContext?: boolean;
}): CodexThreadDiscoveryEntry[] {
  const depth = params.depth ?? 0;
  if (depth > 8 || params.value == null) {
    return [];
  }
  if (Array.isArray(params.value)) {
    return params.value.flatMap((entry) =>
      extractThreadDiscoveryCandidates({
        value: entry,
        depth: depth + 1,
        inThreadContext: params.inThreadContext,
      }),
    );
  }
  const record = asRecord(params.value);
  if (!record) {
    return [];
  }
  const out: CodexThreadDiscoveryEntry[] = [];
  const keyHints = Object.keys(record).map((key) => key.toLowerCase());
  const hasThreadHint = keyHints.some((key) =>
    /(^|[_-])(thread|threads|conversation|conversations|session|sessions)([_-]|$)/.test(key),
  );
  const inThreadContext = params.inThreadContext === true || hasThreadHint;
  const explicitThreadId =
    pickString(record, ["threadId", "thread_id", "conversationId", "conversation_id"]) ?? "";
  const fallbackId = inThreadContext ? (pickString(record, ["id"]) ?? "") : "";
  const runLikeId = pickString(record, ["runId", "run_id", "turnId", "turn_id"]) ?? "";
  const selectedThreadId =
    explicitThreadId || (fallbackId && fallbackId !== runLikeId ? fallbackId : "");
  if (selectedThreadId) {
    const title =
      pickString(record, ["title", "name", "summary", "label", "displayName"]) ?? undefined;
    const projectKey = resolveThreadProjectKey(record);
    const updatedAt = resolveThreadUpdatedAt(record);
    out.push({
      threadId: selectedThreadId,
      title,
      projectKey,
      updatedAt,
    });
  }
  for (const [key, entry] of Object.entries(record)) {
    if (!entry || (typeof entry !== "object" && !Array.isArray(entry))) {
      continue;
    }
    const keyLower = key.toLowerCase();
    if (/(^|[_-])(turn|turns|run|runs)([_-]|$)/.test(keyLower)) {
      continue;
    }
    out.push(
      ...extractThreadDiscoveryCandidates({
        value: entry,
        depth: depth + 1,
        inThreadContext:
          inThreadContext ||
          /(^|[_-])(thread|threads|conversation|conversations|session|sessions|list|items|results|data)([_-]|$)/.test(
            keyLower,
          ),
      }),
    );
  }
  return out;
}

function dedupeThreadDiscoveryCandidates(
  candidates: CodexThreadDiscoveryEntry[],
): CodexThreadDiscoveryEntry[] {
  const byThreadId = new Map<string, CodexThreadDiscoveryEntry>();
  for (const candidate of candidates) {
    const threadId = candidate.threadId.trim();
    if (!threadId) {
      continue;
    }
    const normalized: CodexThreadDiscoveryEntry = {
      threadId,
      title: candidate.title?.trim() || undefined,
      projectKey: candidate.projectKey?.trim() || undefined,
      updatedAt: candidate.updatedAt,
    };
    const existing = byThreadId.get(threadId);
    if (!existing) {
      byThreadId.set(threadId, normalized);
      continue;
    }
    const existingUpdatedAt = existing.updatedAt ?? 0;
    const nextUpdatedAt = normalized.updatedAt ?? 0;
    if (nextUpdatedAt > existingUpdatedAt) {
      byThreadId.set(threadId, {
        ...existing,
        ...normalized,
      });
      continue;
    }
    byThreadId.set(threadId, {
      ...existing,
      title: existing.title ?? normalized.title,
      projectKey: existing.projectKey ?? normalized.projectKey,
      updatedAt: existing.updatedAt ?? normalized.updatedAt,
    });
  }
  return [...byThreadId.values()].toSorted((a, b) => {
    const tsA = a.updatedAt ?? 0;
    const tsB = b.updatedAt ?? 0;
    if (tsA !== tsB) {
      return tsB - tsA;
    }
    return a.threadId.localeCompare(b.threadId);
  });
}

function extractIds(value: unknown): ExtractedIds {
  const record = asRecord(value);
  if (!record) {
    return {};
  }
  const threadFromTop = pickString(record, ["thread_id", "threadId"]);
  const runFromTop = pickString(record, ["turn_id", "turnId", "run_id", "runId"]);
  const threadFromNested = pickString(asRecord(record.thread) ?? {}, [
    "id",
    "threadId",
    "thread_id",
  ]);
  const runFromNested = pickString(asRecord(record.turn) ?? {}, ["id", "turnId", "turn_id"]);
  const threadId = threadFromTop ?? threadFromNested;
  const runId = runFromTop ?? runFromNested;
  return { threadId, runId };
}

function buildTextInputItems(text: string): Array<Record<string, unknown>> {
  return [
    {
      type: "text",
      text,
      text_elements: [],
    },
  ];
}

function extractQuestionText(params: unknown): string | undefined {
  const record = asRecord(params);
  if (!record) {
    return undefined;
  }
  const questions = record.questions;
  if (Array.isArray(questions) && questions.length > 0) {
    const first = asRecord(questions[0]);
    const question = first ? pickString(first, ["question", "header"]) : undefined;
    if (question) {
      return question;
    }
  }
  const direct = collectText(params).trim();
  return direct || undefined;
}

function extractAgentTextFromCompletedItem(params: unknown): string {
  const record = asRecord(params);
  if (!record) {
    return "";
  }
  const item = asRecord(record.item);
  if (!item) {
    return "";
  }
  const itemType = pickString(item, ["type"]);
  if (itemType?.toLowerCase() !== "agentmessage") {
    return "";
  }
  return pickString(item, ["text"], { trim: false }) ?? "";
}

function extractPartialReplyFromNotification(methodLower: string, params: unknown): string {
  if (
    methodLower === "item/agentmessage/delta" ||
    methodLower === "item/agent_message/delta" ||
    methodLower.endsWith("agentmessage/delta") ||
    methodLower.endsWith("agent_message/delta")
  ) {
    const record = asRecord(params);
    if (!record) {
      return "";
    }
    return (
      pickString(record, ["delta"], { trim: false, allowEmpty: true }) ?? collectText(record.delta)
    );
  }
  if (
    methodLower === "item/completed" ||
    methodLower.endsWith("/item/completed") ||
    methodLower.endsWith("item/completed")
  ) {
    return extractAgentTextFromCompletedItem(params);
  }
  return "";
}

function summarizeLogText(text: string, maxChars = 160): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) {
    return collapsed;
  }
  return `${collapsed.slice(0, maxChars)}…`;
}

function findTextOverlapSuffixPrefix(base: string, incoming: string, maxWindow = 8_192): number {
  const baseWindow = base.length > maxWindow ? base.slice(-maxWindow) : base;
  const incomingWindow = incoming.length > maxWindow ? incoming.slice(0, maxWindow) : incoming;
  const max = Math.min(baseWindow.length, incomingWindow.length);
  for (let size = max; size > 0; size -= 1) {
    if (baseWindow.slice(-size) === incomingWindow.slice(0, size)) {
      return size;
    }
  }
  return 0;
}

function mergeAssistantNotificationText(params: { existing: string; incoming: string }): {
  next: string;
  delta: string;
} {
  const existing = params.existing;
  const incoming = params.incoming;
  if (!incoming) {
    return { next: existing, delta: "" };
  }
  if (!existing) {
    return { next: incoming, delta: incoming };
  }
  if (incoming === existing) {
    return { next: existing, delta: "" };
  }
  // Some App Server implementations stream cumulative snapshots.
  if (incoming.startsWith(existing)) {
    return { next: incoming, delta: incoming.slice(existing.length) };
  }
  if (existing.startsWith(incoming) || existing.endsWith(incoming)) {
    return { next: existing, delta: "" };
  }
  const overlap = findTextOverlapSuffixPrefix(existing, incoming);
  if (overlap > 0) {
    return {
      next: `${existing}${incoming.slice(overlap)}`,
      delta: incoming.slice(overlap),
    };
  }
  return {
    next: `${existing}${incoming}`,
    delta: incoming,
  };
}

function extractAgentTextFromThreadRead(params: unknown, turnId?: string): string {
  const record = asRecord(params);
  if (!record) {
    return "";
  }
  const thread = asRecord(record.thread) ?? record;
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  if (turns.length === 0) {
    return "";
  }
  const selectedTurn = (() => {
    if (!turnId) {
      return asRecord(turns[turns.length - 1]);
    }
    const matched = turns.find((entry) => {
      const turnRecord = asRecord(entry);
      return turnRecord ? pickString(turnRecord, ["id"]) === turnId : false;
    });
    return asRecord(matched) ?? asRecord(turns[turns.length - 1]);
  })();
  if (!selectedTurn) {
    return "";
  }
  const items = Array.isArray(selectedTurn.items) ? selectedTurn.items : [];
  const texts = items
    .map((entry) => {
      const item = asRecord(entry);
      if (!item) {
        return "";
      }
      const type = pickString(item, ["type"])?.toLowerCase();
      if (type === "agentmessage") {
        return pickString(item, ["text"]) ?? "";
      }
      return "";
    })
    .filter(Boolean);
  return texts.join("\n\n").trim();
}

function collectText(value: unknown): string {
  if (!value) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collectText(entry)).join("");
  }
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  const direct = pickString(record, ["text", "delta", "content", "output_text", "message"], {
    trim: false,
    allowEmpty: true,
  });
  if (direct) {
    return direct;
  }
  if (Array.isArray(record.content)) {
    return record.content.map((entry) => collectText(entry)).join("");
  }
  if (Array.isArray(record.output)) {
    return record.output.map((entry) => collectText(entry)).join("");
  }
  return "";
}

function extractOptionValues(params: unknown): string[] {
  const record = asRecord(params);
  if (!record) {
    return [];
  }
  const questions = record.questions;
  if (Array.isArray(questions) && questions.length > 0) {
    const first = asRecord(questions[0]);
    const firstOptions = first?.options;
    if (Array.isArray(firstOptions) && firstOptions.length > 0) {
      const options = firstOptions
        .map((entry) => {
          const option = asRecord(entry);
          if (!option) {
            return "";
          }
          return pickString(option, ["label", "title", "text", "value", "name", "id"]) ?? "";
        })
        .filter(Boolean);
      if (options.length > 0) {
        return options;
      }
    }
  }
  const candidates = ["options", "choices", "allowed", "answers", "items"];
  for (const key of candidates) {
    const value = record[key];
    if (!Array.isArray(value)) {
      continue;
    }
    const options = value
      .map((entry) => {
        if (typeof entry === "string") {
          return entry.trim();
        }
        const entryRecord = asRecord(entry);
        if (!entryRecord) {
          return "";
        }
        return pickString(entryRecord, ["label", "title", "text", "value", "name", "id"]) ?? "";
      })
      .filter(Boolean);
    if (options.length > 0) {
      return options;
    }
  }
  return [];
}

export type ParsedCodexUserInput =
  | { kind: "option"; index: number }
  | { kind: "text"; text: string };

const OPTION_SELECTION_RE = /^\s*(?:option\s*)?([1-9]\d*)\s*$/i;

export function parseCodexUserInput(text: string, optionsCount: number): ParsedCodexUserInput {
  const normalized = text.trim();
  if (!normalized) {
    return { kind: "text", text: "" };
  }
  const match = normalized.match(OPTION_SELECTION_RE);
  if (match) {
    const oneBased = Number.parseInt(match[1] ?? "", 10);
    if (Number.isInteger(oneBased) && oneBased >= 1 && oneBased <= optionsCount) {
      return { kind: "option", index: oneBased - 1 };
    }
  }
  return { kind: "text", text: normalized };
}

function mapApprovalFreeformToOption(text: string, options: string[]): number | undefined {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const approve = ["approve", "approved", "allow", "yes", "accept", "accepted"];
  const deny = ["deny", "denied", "reject", "rejected", "no", "block"];
  if (approve.some((token) => normalized === token || normalized.startsWith(`${token} `))) {
    const idx = options.findIndex((option) => /approve|allow/i.test(option));
    return idx >= 0 ? idx : 0;
  }
  if (deny.some((token) => normalized === token || normalized.startsWith(`${token} `))) {
    const idx = options.findIndex((option) => /deny|reject|block/i.test(option));
    return idx >= 0 ? idx : Math.min(1, Math.max(0, options.length - 1));
  }
  return undefined;
}

function isAlreadyInitializedError(err: unknown): boolean {
  const text = (() => {
    if (typeof err === "string") {
      return err;
    }
    if (err instanceof Error) {
      return err.message;
    }
    if (err && typeof err === "object" && "message" in err) {
      const message = (err as { message?: unknown }).message;
      return typeof message === "string" ? message : "";
    }
    return "";
  })().toLowerCase();
  return text.includes("already initialized");
}

function isConversationNotFoundError(err: unknown): boolean {
  const text = (() => {
    if (typeof err === "string") {
      return err;
    }
    if (err instanceof Error) {
      return err.message;
    }
    if (err && typeof err === "object" && "message" in err) {
      const message = (err as { message?: unknown }).message;
      return typeof message === "string" ? message : "";
    }
    return "";
  })().toLowerCase();
  return text.includes("conversation not found") || text.includes("thread not found");
}

function shouldRetryWithFreshThreadAfterNotFound(params: {
  hadExistingThreadBinding: boolean;
}): boolean {
  // If OpenClaw is explicitly bound to a thread id, never silently recreate
  // and continue on a different thread.
  return !params.hadExistingThreadBinding;
}

function assertBoundThreadAffinity(params: {
  requestedThreadId?: string;
  observedThreadId?: string;
  source: string;
}) {
  const requested = params.requestedThreadId?.trim();
  const observed = params.observedThreadId?.trim();
  if (!requested || !observed || requested === observed) {
    return;
  }
  throw new Error(
    `thread mismatch for requested binding ${requested}: ${params.source} returned ${observed}`,
  );
}

type PendingInput = {
  requestId: string;
  method: string;
  options: string[];
  expiresAt: number;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

function truncatePromptLine(text: string, maxChars = 600): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars)}…`;
}

function extractApprovalPromptContext(requestParams: unknown): {
  command?: string;
  cwd?: string;
  reason?: string;
} {
  const record = asRecord(requestParams);
  if (!record) {
    return {};
  }
  const nested = asRecord(record.commandExecution) ?? asRecord(record.execution) ?? {};
  const commandActions = Array.isArray(record.commandActions) ? record.commandActions : [];
  const commandFromActions = commandActions
    .map((entry) => pickString(asRecord(entry) ?? {}, ["command"], { trim: true }))
    .filter((entry): entry is string => Boolean(entry))
    .join(" ; ");
  const commandRaw =
    pickString(record, ["command", "commandLine", "cmd"]) ??
    pickString(nested, ["command", "commandLine", "cmd"]) ??
    (commandFromActions || undefined);
  const cwdRaw =
    pickString(record, ["cwd", "workingDirectory", "workdir", "directory"]) ??
    pickString(nested, ["cwd", "workingDirectory", "workdir", "directory"]);
  const reasonRaw = pickString(record, ["reason", "message"]) ?? pickString(nested, ["reason"]);
  return {
    command: commandRaw ? truncatePromptLine(commandRaw) : undefined,
    cwd: cwdRaw ? truncatePromptLine(cwdRaw, 260) : undefined,
    reason: reasonRaw ? truncatePromptLine(reasonRaw, 260) : undefined,
  };
}

function buildPromptText(params: {
  method: string;
  requestId: string;
  options: string[];
  question?: string;
  requestParams?: unknown;
  expiresAt: number;
}): string {
  const lines = [`🧭 Agent input requested (${params.requestId})`];
  if (params.question) {
    lines.push(params.question);
  }
  if (params.options.length > 0) {
    lines.push("");
    lines.push("Options:");
    params.options.forEach((option, index) => {
      lines.push(`${index + 1}. ${option}`);
    });
    lines.push("");
    lines.push('Reply with "1", "2", "option 1", etc., or send free text.');
  } else {
    lines.push("Reply with a free-form response.");
  }
  const seconds = Math.max(1, Math.round((params.expiresAt - Date.now()) / 1000));
  lines.push(`Expires in: ${seconds}s`);
  if (/requestapproval/i.test(params.method)) {
    const approvalContext = extractApprovalPromptContext(params.requestParams);
    if (approvalContext.command || approvalContext.cwd || approvalContext.reason) {
      lines.push("");
      if (approvalContext.command) {
        lines.push(`Command: ${approvalContext.command}`);
      }
      if (approvalContext.cwd) {
        lines.push(`Working directory: ${approvalContext.cwd}`);
      }
      if (approvalContext.reason) {
        lines.push(`Reason: ${approvalContext.reason}`);
      }
    }
    lines.push("This response will be sent to Codex as an approval decision.");
  }
  return lines.join("\n");
}

export type PendingCodexUserInputState = {
  requestId: string;
  options: string[];
  expiresAt: number;
};

function resolveApprovalDecisionFromText(text: string, supportsSession: boolean): string {
  const normalized = text.trim().toLowerCase();
  if (!normalized) {
    return "cancel";
  }
  if (supportsSession && /session/.test(normalized)) {
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

function pickPendingSelectionText(value: unknown, options: string[]): string {
  const record = asRecord(value);
  if (!record) {
    return "";
  }
  const indexRaw = record.index;
  if (typeof indexRaw === "number" && Number.isInteger(indexRaw)) {
    const option = options[indexRaw];
    if (option) {
      return option;
    }
  }
  return (
    pickString(record, ["option", "text", "value", "label"]) ??
    (typeof indexRaw === "string" ? indexRaw : "")
  );
}

function buildToolRequestUserInputResponse(requestParams: unknown, value: unknown): unknown {
  const record = asRecord(requestParams);
  const questions = Array.isArray(record?.questions) ? record.questions : [];
  if (questions.length === 0) {
    return value;
  }
  const firstQuestion = asRecord(questions[0]);
  const optionLabels = (() => {
    const opts = firstQuestion?.options;
    if (!Array.isArray(opts)) {
      return [];
    }
    return opts
      .map((entry) => pickString(asRecord(entry) ?? {}, ["label", "title", "text", "value"]))
      .filter((entry): entry is string => Boolean(entry));
  })();
  const selected = pickPendingSelectionText(value, optionLabels);
  const normalized = selected.trim();
  const firstQuestionId = pickString(firstQuestion ?? {}, ["id"]) ?? "q1";
  return {
    answers: {
      [firstQuestionId]: {
        answers: normalized ? [normalized] : [],
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
    if (timedOut) {
      return buildToolRequestUserInputResponse(requestParams, { text: "" });
    }
    return buildToolRequestUserInputResponse(requestParams, response);
  }
  if (methodLower.includes("item/commandexecution/requestapproval")) {
    if (timedOut) {
      return { decision: "cancel" };
    }
    const selected = pickPendingSelectionText(response, options);
    return { decision: resolveApprovalDecisionFromText(selected, true) };
  }
  if (methodLower.includes("item/filechange/requestapproval")) {
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

type RunCodexAppServerAgentParams = {
  sessionId: string;
  sessionKey?: string;
  prompt: string;
  model?: string;
  workspaceDir: string;
  config?: OpenClawConfig;
  timeoutMs: number;
  runId: string;
  existingThreadId?: string;
  onPartialReply?: (payload: { text?: string }) => Promise<void> | void;
  onToolResult?: (payload: { text?: string }) => Promise<void> | void;
  onPendingUserInput?: (state: PendingCodexUserInputState | null) => Promise<void> | void;
  onInterrupted?: () => Promise<void> | void;
};

async function requestWithVariants(params: {
  client: JsonRpcClient;
  methods: string[];
  variants: Array<Record<string, unknown>>;
  timeoutMs: number;
}): Promise<unknown> {
  const errors: string[] = [];
  for (const method of params.methods) {
    for (const variant of params.variants) {
      try {
        return await params.client.request(method, variant, params.timeoutMs);
      } catch (err) {
        errors.push(`${method}: ${String(err)}`);
      }
    }
  }
  throw new Error(errors[errors.length - 1] ?? "codex app server request failed");
}

function getTurnStartRpcMethods(): string[] {
  return ["turn/start"];
}

function buildTurnStartVariants(params: {
  threadId: string;
  prompt: string;
  workspaceDir: string;
  model?: string;
}): Array<Record<string, unknown>> {
  const input = buildTextInputItems(params.prompt);
  return [
    {
      threadId: params.threadId,
      input,
      cwd: params.workspaceDir,
      model: params.model,
    },
    {
      threadId: params.threadId,
      input,
      cwd: params.workspaceDir,
    },
    {
      threadId: params.threadId,
      input,
    },
  ];
}

async function initializeCodexAppServerClient(params: {
  client: JsonRpcClient;
  settings: CodexAppServerSettings;
  sessionKey?: string;
  workspaceDir?: string;
}) {
  const initializeVariants: Array<Record<string, unknown>> = [
    {
      protocolVersion: "1.0",
      clientInfo: { name: "openclaw", version: "1.0" },
      capabilities: {},
    },
    {
      clientInfo: { name: "openclaw", version: "1.0" },
      capabilities: {},
    },
    {
      client: { name: "openclaw", version: "1.0" },
    },
  ];
  let initializeError: unknown;
  let initialized = false;
  for (const variant of initializeVariants) {
    try {
      log.debug("attempting codex app server initialize", {
        hasProtocolVersion: Object.hasOwn(variant, "protocolVersion"),
        hasClientInfo: Object.hasOwn(variant, "clientInfo"),
        hasClient: Object.hasOwn(variant, "client"),
      });
      await params.client.request("initialize", variant, params.settings.requestTimeoutMs);
      initialized = true;
      break;
    } catch (err) {
      if (isAlreadyInitializedError(err)) {
        log.info("codex app server initialize already completed on shared transport");
        initialized = true;
        break;
      }
      log.debug("codex app server initialize attempt failed", {
        error: String(err),
      });
      initializeError = err;
    }
  }
  if (!initialized) {
    throw initializeError instanceof Error
      ? new Error(`initialize: ${initializeError.message}`)
      : new Error(`initialize: ${String(initializeError)}`);
  }
  await params.client.request("initialized", {}).catch(() => undefined);
  if (params.workspaceDir || params.sessionKey) {
    await params.client
      .request("session/update", {
        session_key: params.sessionKey ?? "codex-slash-discovery",
        cwd: params.workspaceDir,
      })
      .catch(() => undefined);
  }
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
      error: "codex app server is disabled",
    };
  }
  const client = createJsonRpcClient(settings);
  const candidates: CodexMirrorSlashCommand[] = [];
  let discoveryAvailable = false;
  let lastError: string | undefined;
  try {
    await client.connect();
    await initializeCodexAppServerClient({
      client,
      settings,
      sessionKey: params?.sessionKey,
      workspaceDir: params?.workspaceDir,
    });
    const attempts = resolveSlashDiscoveryAttempts();
    for (const attempt of attempts) {
      for (const variant of attempt.variants) {
        try {
          const result = await client.request(attempt.method, variant, settings.requestTimeoutMs);
          discoveryAvailable = true;
          candidates.push(
            ...extractMirrorSlashCandidates({
              value: result,
              source: attempt.source,
              commandContext: true,
            }),
          );
          break;
        } catch (err) {
          lastError = String(err);
        }
      }
    }
    if (!discoveryAvailable) {
      return {
        available: false,
        commands: [],
        collisions: [],
        error: lastError ?? "slash discovery unavailable",
      };
    }
    const { commands, collisions } = dedupeMirrorSlashCandidates(candidates);
    return {
      available: true,
      commands,
      collisions,
    };
  } catch (err) {
    return {
      available: false,
      commands: [],
      collisions: [],
      error: String(err),
    };
  } finally {
    await client.close();
  }
}

export async function discoverCodexAppServerThreads(params?: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<CodexThreadDiscoveryResult> {
  const settings = resolveCodexAppServerSettings(params?.config);
  if (!settings.enabled) {
    return {
      available: false,
      threads: [],
      error: "codex app server is disabled",
    };
  }
  const client = createJsonRpcClient(settings);
  let discoveryAvailable = false;
  let lastError: string | undefined;
  const candidates: CodexThreadDiscoveryEntry[] = [];
  try {
    await client.connect();
    await initializeCodexAppServerClient({
      client,
      settings,
      sessionKey: params?.sessionKey,
      workspaceDir: params?.workspaceDir,
    });
    const attempts = resolveThreadDiscoveryAttempts();
    for (const attempt of attempts) {
      for (const variant of attempt.variants) {
        try {
          const result = await client.request(attempt.method, variant, settings.requestTimeoutMs);
          discoveryAvailable = true;
          candidates.push(
            ...extractThreadDiscoveryCandidates({
              value: result,
              inThreadContext: true,
            }),
          );
          break;
        } catch (err) {
          lastError = String(err);
        }
      }
    }
    if (!discoveryAvailable) {
      return {
        available: false,
        threads: [],
        error: lastError ?? "thread discovery unavailable",
      };
    }
    return {
      available: true,
      threads: dedupeThreadDiscoveryCandidates(candidates),
      ...(lastError ? { error: lastError } : {}),
    };
  } catch (err) {
    return {
      available: false,
      threads: [],
      error: String(err),
    };
  } finally {
    await client.close();
  }
}

export const __testing = {
  getTurnStartRpcMethods,
  buildTurnStartVariants,
  buildPromptText,
  extractApprovalPromptContext,
  shouldRetryWithFreshThreadAfterNotFound,
  assertBoundThreadAffinity,
  normalizeMirrorSlashName,
  extractMirrorSlashCandidates,
  dedupeMirrorSlashCandidates,
  extractThreadDiscoveryCandidates,
  dedupeThreadDiscoveryCandidates,
};

function createJsonRpcClient(settings: CodexAppServerSettings): JsonRpcClient {
  if (settings.transport === "websocket") {
    if (!settings.url) {
      throw new Error(
        "Missing agents.defaults.codexAppServer.url (or OPENCLAW_CODEX_APP_SERVER_URL) for websocket transport.",
      );
    }
    return new WsJsonRpcClient({
      url: settings.url,
      requestTimeoutMs: settings.requestTimeoutMs,
      headers: settings.headers,
    });
  }

  return new SharedStdioJsonRpcClient({
    requestTimeoutMs: settings.requestTimeoutMs,
    command: settings.command,
    args: settings.args,
  });
}

export async function runCodexAppServerAgent(
  params: RunCodexAppServerAgentParams,
): Promise<EmbeddedPiRunResult> {
  const startedAt = Date.now();
  const settings = resolveCodexAppServerSettings(params.config);
  log.info("starting codex app server run", {
    sessionId: params.sessionId,
    sessionKey: params.sessionKey ?? null,
    runId: params.runId,
    transport: settings.transport,
    command: settings.transport === "stdio" ? settings.command : undefined,
    args: settings.transport === "stdio" ? settings.args : undefined,
    url: settings.transport === "websocket" ? settings.url : undefined,
    workspaceDir: params.workspaceDir,
    hasExistingThread: Boolean(params.existingThreadId),
  });
  if (!settings.enabled) {
    throw new Error('Provider "codex-app-server" is disabled by config.');
  }
  const client = createJsonRpcClient(settings);

  let active = true;
  let awaitingInput = false;
  let interrupted = false;
  const requestedThreadId = params.existingThreadId?.trim() || undefined;
  let threadId = requestedThreadId;
  const hadExistingThreadBinding = Boolean(threadId);
  let turnId: string | undefined;
  let textBuffer = "";
  let assistantText = "";
  let partialNotificationCount = 0;
  let pendingInput: PendingInput | null = null;
  let turnCompleted = false;
  let terminalErrorMessage: string | undefined;
  let resolveCompletion: (() => void) | null = null;
  const turnCompletion = new Promise<void>((resolve) => {
    resolveCompletion = resolve;
  });

  const applyIds = (value: unknown) => {
    const ids = extractIds(value);
    if (ids.threadId) {
      threadId = ids.threadId;
    }
    if (ids.runId) {
      turnId = ids.runId;
    }
  };

  const completeTurn = () => {
    if (turnCompleted) {
      return;
    }
    turnCompleted = true;
    resolveCompletion?.();
  };

  const resolvePendingFromUserText = (text: string): boolean => {
    if (!pendingInput) {
      return false;
    }
    log.info(
      `codex pending input reply received: requestId=${pendingInput.requestId} chars=${text.length} preview="${summarizeLogText(text)}"`,
    );
    const parsed = parseCodexUserInput(text, pendingInput.options.length);
    let resolvedValue: unknown;
    if (parsed.kind === "option") {
      resolvedValue = {
        index: parsed.index,
        option: pendingInput.options[parsed.index],
        text: pendingInput.options[parsed.index],
      };
    } else {
      const approvalMapped = mapApprovalFreeformToOption(parsed.text, pendingInput.options);
      if (
        approvalMapped != null &&
        approvalMapped >= 0 &&
        approvalMapped < pendingInput.options.length
      ) {
        resolvedValue = {
          index: approvalMapped,
          option: pendingInput.options[approvalMapped],
          text: pendingInput.options[approvalMapped],
        };
      } else {
        resolvedValue = {
          text: parsed.text,
          isOther: true,
        };
      }
    }
    pendingInput.resolve(resolvedValue);
    log.info(
      `codex pending input resolved: requestId=${pendingInput.requestId} mode=${parsed.kind}`,
    );
    return true;
  };

  const queueHandle: CodexAppServerQueueHandle = {
    queueMessage: async (text: string) => {
      log.info(
        `codex queue message received: awaitingInput=${awaitingInput} chars=${text.length} preview="${summarizeLogText(text)}"`,
      );
      if (resolvePendingFromUserText(text)) {
        return true;
      }
      const v2Input = buildTextInputItems(text);
      await requestWithVariants({
        client,
        methods: ["turn/steer", "thread/steer"],
        variants: [
          {
            threadId,
            expectedTurnId: turnId,
            input: v2Input,
          },
          {
            thread_id: threadId,
            expected_turn_id: turnId,
            input: v2Input,
          },
          {
            thread_id: threadId,
            turn_id: turnId,
            input: text,
          },
          {
            threadId: threadId,
            turnId: turnId,
            input: text,
          },
          {
            thread_id: threadId,
            run_id: turnId,
            prompt: text,
          },
        ],
        timeoutMs: settings.requestTimeoutMs,
      }).catch((err) => {
        log.warn(`codex steer failed: ${String(err)}`);
      });
      return true;
    },
    interrupt: async () => {
      interrupted = true;
      await params.onInterrupted?.();
      await requestWithVariants({
        client,
        methods: ["turn/interrupt", "thread/interrupt"],
        variants: [
          { threadId, turnId },
          { thread_id: threadId, turn_id: turnId },
          { threadId: threadId, turnId: turnId },
          { thread_id: threadId, run_id: turnId },
          { threadId: threadId, runId: turnId },
          {},
        ],
        timeoutMs: settings.requestTimeoutMs,
      }).catch((err) => {
        log.warn(`codex interrupt failed: ${String(err)}`);
      });
    },
    isStreaming: () => active,
    isAwaitingInput: () => awaitingInput,
  };

  setActiveCodexAppServerRun(params.sessionId, queueHandle, params.sessionKey);

  const sharedTransport = settings.transport === "stdio";
  const matchesRunBinding = (payload: unknown): boolean => {
    if (!sharedTransport) {
      return true;
    }
    const ids = extractIds(payload);
    if (!threadId && !turnId) {
      return false;
    }
    if (threadId && ids.threadId && ids.threadId !== threadId) {
      return false;
    }
    if (turnId && ids.runId && ids.runId !== turnId) {
      return false;
    }
    return true;
  };

  client.setNotificationHandler(async (method, notificationParams) => {
    const methodLower = method.trim().toLowerCase();
    if (!matchesRunBinding(notificationParams)) {
      return;
    }
    applyIds(notificationParams);
    const notificationRecord = asRecord(notificationParams);
    const text = extractPartialReplyFromNotification(methodLower, notificationParams);
    if (text) {
      const merged = mergeAssistantNotificationText({
        existing: assistantText,
        incoming: text,
      });
      assistantText = merged.next;
      if (merged.delta) {
        textBuffer = assistantText;
      }
      partialNotificationCount += 1;
      if (partialNotificationCount <= 12 || partialNotificationCount % 25 === 0) {
        log.info(
          `codex notification text received: method=${methodLower} sequence=${partialNotificationCount} chars=${text.length} deltaChars=${merged.delta.length} preview="${summarizeLogText(text)}"`,
        );
      }
      if (merged.delta) {
        await params.onPartialReply?.({ text: merged.delta });
      }
    }

    if (methodLower === "turn/started") {
      applyIds(notificationParams);
      return;
    }
    if (methodLower === "turn/completed") {
      const status = pickString(asRecord(notificationRecord?.turn) ?? {}, ["status"]);
      log.info("codex turn completed notification", {
        threadId: threadId ?? null,
        turnId: turnId ?? null,
        status: status ?? "unknown",
      });
      completeTurn();
      return;
    }
    if (methodLower === "error" && notificationRecord) {
      const willRetry = notificationRecord.willRetry === true;
      const errorMessage = collectText(notificationRecord.error).trim() || "codex app server error";
      if (!willRetry) {
        log.warn("codex turn terminal error notification", {
          threadId: threadId ?? null,
          turnId: turnId ?? null,
          error: errorMessage,
        });
        terminalErrorMessage = errorMessage;
        completeTurn();
      }
    }
  });

  client.setRequestHandler(async (method, requestParams) => {
    const methodLower = method.toLowerCase();
    const isInputRequest =
      methodLower.includes("requestuserinput") || methodLower.includes("requestapproval");
    if (!isInputRequest) {
      return undefined;
    }
    if (!matchesRunBinding(requestParams)) {
      return undefined;
    }
    applyIds(requestParams);
    const options = (() => {
      const extracted = extractOptionValues(requestParams);
      if (extracted.length > 0) {
        return extracted;
      }
      if (methodLower.includes("item/commandexecution/requestapproval")) {
        return ["Approve", "Approve for session", "Deny", "Cancel"];
      }
      if (methodLower.includes("item/filechange/requestapproval")) {
        return ["Approve", "Approve for session", "Deny", "Cancel"];
      }
      if (/requestapproval/i.test(method)) {
        return ["Approve", "Deny", "Cancel"];
      }
      return [];
    })();
    const question = extractQuestionText(requestParams);
    const requestId = `${params.runId}-${Date.now().toString(36)}`;
    const expiresAt = Date.now() + settings.inputTimeoutMs;
    const promptText = buildPromptText({
      method,
      requestId,
      options,
      question,
      requestParams,
      expiresAt,
    });
    awaitingInput = true;
    await params.onPendingUserInput?.({
      requestId,
      options,
      expiresAt,
    });
    await params.onToolResult?.({ text: promptText });

    let timedOut = false;
    const response = await new Promise<unknown>((resolve, reject) => {
      pendingInput = {
        requestId,
        method,
        options,
        expiresAt,
        resolve,
        reject,
      };
      setTimeout(() => {
        if (!pendingInput || pendingInput.requestId !== requestId) {
          return;
        }
        pendingInput = null;
        reject(new Error("timed out waiting for user input"));
      }, settings.inputTimeoutMs);
    }).catch((_err) => {
      timedOut = true;
      return { cancelled: true, reason: "timeout" };
    });

    awaitingInput = false;
    pendingInput = null;
    await params.onPendingUserInput?.(null);
    if (timedOut) {
      await params.onToolResult?.({
        text: "Input request timed out. Sent a timeout response to Codex and continued.",
      });
    }
    return mapPendingInputResponse({
      methodLower,
      requestParams,
      response,
      options,
      timedOut,
    });
  });

  try {
    await client.connect();
    log.info("connected to codex app server transport", {
      transport: settings.transport,
    });

    await initializeCodexAppServerClient({
      client,
      settings,
      sessionKey: params.sessionKey ?? params.sessionId,
      workspaceDir: params.workspaceDir,
    });
    log.info("codex app server initialize handshake complete");

    const ensureThreadStarted = async () => {
      if (threadId) {
        return;
      }
      const threadStartResult = await requestWithVariants({
        client,
        methods: ["thread/start", "newConversation"],
        variants: [
          {
            model: params.model,
            cwd: params.workspaceDir,
            experimentalRawEvents: false,
            persistExtendedHistory: true,
          },
          {
            model: params.model,
            cwd: params.workspaceDir,
            experimentalRawEvents: false,
            persistExtendedHistory: false,
          },
          {
            model: params.model,
            cwd: params.workspaceDir,
          },
          {
            cwd: params.workspaceDir,
          },
          {},
        ],
        timeoutMs: settings.requestTimeoutMs,
      });
      applyIds(threadStartResult);
      const threadStartRecord = asRecord(threadStartResult);
      const threadRecord = asRecord(threadStartRecord?.thread);
      threadId =
        threadId ??
        pickString(threadRecord ?? {}, ["id"]) ??
        pickString(threadStartRecord ?? {}, ["conversationId", "threadId", "thread_id", "id"]);
      if (!threadId) {
        throw new Error("thread/start did not return a thread id");
      }
    };

    const startTurn = async () => {
      if (!threadId) {
        throw new Error("missing thread id before turn/start");
      }
      return await requestWithVariants({
        client,
        methods: getTurnStartRpcMethods(),
        variants: buildTurnStartVariants({
          threadId,
          prompt: params.prompt,
          workspaceDir: params.workspaceDir,
          model: params.model,
        }),
        timeoutMs: Math.max(settings.requestTimeoutMs, params.timeoutMs),
      });
    };

    log.info(
      `starting codex turn: workspaceDir=${params.workspaceDir} promptChars=${params.prompt.length} promptPreview="${summarizeLogText(params.prompt, 280)}"`,
    );
    await ensureThreadStarted();
    let turnStartResult: unknown;
    try {
      turnStartResult = await startTurn();
    } catch (err) {
      if (threadId && isConversationNotFoundError(err)) {
        if (!shouldRetryWithFreshThreadAfterNotFound({ hadExistingThreadBinding })) {
          throw new Error(`thread not found for requested binding ${threadId}`, {
            cause: err,
          });
        }
        log.warn("codex thread/conversation not found; recreating thread and retrying turn", {
          staleThreadId: threadId,
        });
        threadId = undefined;
        turnId = undefined;
        await ensureThreadStarted();
        turnStartResult = await startTurn();
      } else {
        throw err;
      }
    }
    applyIds(turnStartResult);
    assertBoundThreadAffinity({
      requestedThreadId,
      observedThreadId: threadId,
      source: "turn/start",
    });
    const turnStartRecord = asRecord(turnStartResult);
    const turnStartTurn = asRecord(turnStartRecord?.turn);
    turnId = turnId ?? pickString(turnStartTurn ?? {}, ["id"]);
    const startStatus = pickString(turnStartTurn ?? {}, ["status"])?.toLowerCase();
    log.info("codex turn start acknowledged", {
      threadId: threadId ?? null,
      turnId: turnId ?? null,
      status: startStatus ?? "unknown",
    });
    await params.onToolResult?.({
      text: `Codex turn started${threadId ? ` (thread ${threadId})` : ""}.`,
    });
    if (startStatus && startStatus !== "inprogress") {
      completeTurn();
    }
    const startText = collectText(turnStartResult).trim();
    if (startText) {
      const merged = mergeAssistantNotificationText({
        existing: assistantText,
        incoming: startText,
      });
      assistantText = merged.next;
      textBuffer = assistantText;
    }

    if (!turnCompleted) {
      let waitTimedOut = false;
      await Promise.race([
        turnCompletion,
        new Promise<void>((resolve) => {
          setTimeout(
            () => {
              waitTimedOut = true;
              resolve();
            },
            Math.max(1_000, params.timeoutMs),
          );
        }),
      ]);
      if (waitTimedOut && !turnCompleted) {
        log.warn("timed out waiting for codex turn completion", {
          threadId: threadId ?? null,
          turnId: turnId ?? null,
          timeoutMs: params.timeoutMs,
        });
      }
    }

    if (threadId && !textBuffer.trim()) {
      const threadReadResult = await requestWithVariants({
        client,
        methods: ["thread/read", "resumeConversation"],
        variants: [
          { threadId, includeTurns: true },
          { thread_id: threadId, includeTurns: true },
          { conversationId: threadId },
        ],
        timeoutMs: settings.requestTimeoutMs,
      }).catch((err) => {
        log.debug(`thread read unavailable after turn completion: ${String(err)}`);
        return undefined;
      });
      if (threadReadResult) {
        const readText = extractAgentTextFromThreadRead(threadReadResult, turnId);
        if (readText) {
          const merged = mergeAssistantNotificationText({
            existing: assistantText,
            incoming: readText,
          });
          assistantText = merged.next;
          textBuffer = assistantText;
        }
      }
    }

    const finalText = (assistantText || textBuffer).trim();
    if (!finalText && terminalErrorMessage) {
      throw new Error(`turn failed: ${terminalErrorMessage}`);
    }
    log.info("codex app server run complete", {
      runId: params.runId,
      threadId: threadId ?? null,
      turnId: turnId ?? null,
      interrupted,
      hasText: Boolean(finalText),
      durationMs: Date.now() - startedAt,
    });
    return {
      payloads: finalText ? [{ text: finalText }] : undefined,
      meta: {
        durationMs: Date.now() - startedAt,
        aborted: interrupted,
        agentMeta: {
          sessionId: threadId ?? "",
          runId: turnId,
          provider: "codex-app-server",
          model: params.model ?? "default",
        },
      },
    };
  } finally {
    log.debug("closing codex app server client channel", {
      runId: params.runId,
      transport: settings.transport,
    });
    active = false;
    pendingInput = null;
    awaitingInput = false;
    try {
      await params.onPendingUserInput?.(null);
    } catch {
      // no-op
    }
    clearActiveCodexAppServerRun(params.sessionId, queueHandle, params.sessionKey);
    await client.close();
  }
}
