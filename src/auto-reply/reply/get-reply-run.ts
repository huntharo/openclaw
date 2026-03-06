import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveSessionAuthProfileOverride } from "../../agents/auth-profiles/session-override.js";
import type { ExecToolDefaults } from "../../agents/bash-tools.js";
import {
  discoverCodexAppServerThreads,
  discoverCodexAppServerSlashCommands,
  type CodexThreadDiscoveryResult,
  type CodexMirrorSlashDiscoveryResult,
  isCodexAppServerProvider,
  runCodexAppServerAgent,
} from "../../agents/codex-app-server-runner.js";
import { resolveEmbeddedSessionLane } from "../../agents/pi-embedded.js";
import { abortAgentRun, isAgentRunActive, isAgentRunStreaming } from "../../agents/run-control.js";
import type { OpenClawConfig } from "../../config/config.js";
import {
  resolveGroupSessionKey,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import { parseDiscordTarget } from "../../discord/targets.js";
import { logVerbose } from "../../globals.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { clearCommandLane, getQueueSize } from "../../process/command-queue.js";
import { normalizeMainKey } from "../../routing/session-key.js";
import type { TelegramInlineButtons } from "../../telegram/button-types.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import { hasControlCommand } from "../command-detection.js";
import { buildInboundMediaNote } from "../media-note.js";
import type { MsgContext, TemplateContext } from "../templating.js";
import {
  type ElevatedLevel,
  formatXHighModelHint,
  normalizeThinkLevel,
  type ReasoningLevel,
  supportsXHighThinking,
  type ThinkLevel,
  type VerboseLevel,
} from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import type { GetReplyOptions, ReplyPayload } from "../types.js";
import { runReplyAgent } from "./agent-runner.js";
import { applySessionHints } from "./body.js";
import type { buildCommandContext } from "./commands.js";
import type { InlineDirectives } from "./directive-handling.js";
import { buildGroupChatContext, buildGroupIntro } from "./groups.js";
import { buildInboundMetaSystemPrompt, buildInboundUserContextPrefix } from "./inbound-meta.js";
import type { createModelSelectionState } from "./model-selection.js";
import { resolveOriginMessageProvider } from "./origin-routing.js";
import { resolveQueueSettings } from "./queue.js";
import { routeReply } from "./route-reply.js";
import { buildBareSessionResetPrompt } from "./session-reset-prompt.js";
import { drainFormattedSystemEvents, ensureSkillSnapshot } from "./session-updates.js";
import { resolveTelegramConversationId } from "./telegram-context.js";
import { resolveTypingMode } from "./typing-mode.js";
import { resolveRunTypingPolicy } from "./typing-policy.js";
import type { TypingController } from "./typing.js";
import { appendUntrustedContext } from "./untrusted-context.js";

type AgentDefaults = NonNullable<OpenClawConfig["agents"]>["defaults"];
type ExecOverrides = Pick<ExecToolDefaults, "host" | "security" | "ask" | "node">;
const log = createSubsystemLogger("agent/codex-app-server/entry");
const CODEX_INPUT_CALLBACK_PREFIX = "codex_input";
const CODEX_USAGE_TEXT = [
  "Usage: /codex <subcommand>",
  "Subcommands:",
  "- /codex oneshot <coding task>",
  "- /codex new [task]",
  "- /codex join <query|thread-id> (find + attach)",
  "- /codex resume <thread-id|alias> (reattach known thread)",
  "- /codex list [filter]",
  "- /codex bind <thread-id> [--thread here] (force-bind explicit thread id)",
  "- /codex detach",
  "- /codex status",
  "- /codex_<slash> [args] (mirrors discovered Codex/MCP slash commands)",
].join("\n");
const CODEX_LIST_SLASH_FILTERS = new Set(["slash", "slashes", "command", "commands", "mcp"]);
const CODEX_MIRROR_DISCOVERY_TTL_MS = 60_000;
const CODEX_THREAD_ID_UUID_GROUP_LENGTHS = [8, 4, 4, 4, 12] as const;

type CodexMirrorDiscoveryCacheEntry = {
  key: string;
  expiresAt: number;
  result: CodexMirrorSlashDiscoveryResult;
};

let codexMirrorDiscoveryCache: CodexMirrorDiscoveryCacheEntry | null = null;

function isAgentNewCommand(normalizedBody: string | undefined): boolean {
  return (normalizedBody ?? "").trim().toLowerCase() === "/agent new";
}

type ParsedCodexCommand =
  | { type: "none" }
  | { type: "legacy-invalid"; text: string }
  | { type: "root" }
  | { type: "oneshot"; prompt: string }
  | { type: "new"; task: string }
  | { type: "join"; query: string }
  | { type: "resume"; target: string }
  | { type: "list"; filter: string }
  | { type: "bind"; threadId: string; bindHere: boolean }
  | { type: "detach" }
  | { type: "status" }
  | { type: "mirrored"; slashName: string; args: string };

function parseCodexCommand(normalizedBody: string | undefined): ParsedCodexCommand {
  const body = (normalizedBody ?? "").trim();
  if (!body) {
    return { type: "none" };
  }
  const mirroredMatch = body.match(/^\/codex_([a-z0-9_-]+)(?:@[^\s]+)?(?:\s+([\s\S]+))?$/i);
  if (mirroredMatch) {
    return {
      type: "mirrored",
      slashName: mirroredMatch[1].trim().toLowerCase(),
      args: (mirroredMatch[2] ?? "").trim(),
    };
  }
  const match = body.match(/^\/codex(?:@[^\s]+)?(?:\s+([\s\S]+))?$/i);
  if (!match) {
    return { type: "none" };
  }
  const tail = (match[1] ?? "").trim();
  if (!tail) {
    return { type: "root" };
  }
  const [rawSubcommand, ...rest] = tail.split(/\s+/);
  const subcommand = rawSubcommand?.toLowerCase() ?? "";
  const argText = rest.join(" ").trim();
  if (!subcommand) {
    return { type: "root" };
  }
  if (subcommand === "oneshot") {
    return argText ? { type: "oneshot", prompt: argText } : { type: "root" };
  }
  if (subcommand === "new") {
    return { type: "new", task: argText };
  }
  if (subcommand === "join") {
    return argText ? { type: "join", query: argText } : { type: "root" };
  }
  if (subcommand === "resume") {
    return argText ? { type: "resume", target: argText } : { type: "root" };
  }
  if (subcommand === "list") {
    return { type: "list", filter: argText };
  }
  if (subcommand === "bind") {
    const bindHere = /(?:^|\s)--thread\s+here(?:\s|$)/i.test(argText);
    const threadId = argText.replace(/(?:^|\s)--thread\s+here(?:\s|$)/gi, " ").trim();
    return threadId ? { type: "bind", threadId, bindHere } : { type: "root" };
  }
  if (subcommand === "detach") {
    return { type: "detach" };
  }
  if (subcommand === "status") {
    return { type: "status" };
  }
  const aliasMatch = tail.match(
    /^(?:please\s+)?(join|open|resume|bind|detach|status)\b(?:\s+(.*))?$/i,
  );
  if (aliasMatch) {
    const action = aliasMatch[1].toLowerCase();
    const aliasArgs = (aliasMatch[2] ?? "").trim();
    if (action === "join" || action === "open") {
      return aliasArgs ? { type: "join", query: aliasArgs } : { type: "root" };
    }
    if (action === "resume") {
      return aliasArgs ? { type: "resume", target: aliasArgs } : { type: "root" };
    }
    if (action === "bind") {
      const bindHere = /(?:^|\s)--thread\s+here(?:\s|$)/i.test(aliasArgs);
      const threadId = aliasArgs.replace(/(?:^|\s)--thread\s+here(?:\s|$)/gi, " ").trim();
      return threadId ? { type: "bind", threadId, bindHere } : { type: "root" };
    }
    if (action === "detach") {
      return { type: "detach" };
    }
    if (action === "status") {
      return { type: "status" };
    }
  }
  return { type: "legacy-invalid", text: tail };
}

function isMalformedUuidLikeCodexThreadId(raw: string): boolean {
  const value = raw.trim();
  const groups = value.split("-");
  if (groups.length !== CODEX_THREAD_ID_UUID_GROUP_LENGTHS.length) {
    return false;
  }
  if (!groups.every((group) => /^[0-9a-f]+$/i.test(group))) {
    return false;
  }
  return groups.some((group, index) => group.length !== CODEX_THREAD_ID_UUID_GROUP_LENGTHS[index]);
}

function buildCodexMirrorDiscoveryCacheKey(params: {
  workspaceDir: string;
  sessionKey?: string;
}): string {
  return `${params.workspaceDir}::${params.sessionKey ?? ""}`;
}

async function resolveCodexMirrorSlashDiscovery(params: {
  cfg: OpenClawConfig;
  workspaceDir: string;
  sessionKey?: string;
  forceRefresh?: boolean;
}): Promise<CodexMirrorSlashDiscoveryResult> {
  const cacheKey = buildCodexMirrorDiscoveryCacheKey({
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
  });
  const now = Date.now();
  if (
    !params.forceRefresh &&
    codexMirrorDiscoveryCache &&
    codexMirrorDiscoveryCache.key === cacheKey &&
    codexMirrorDiscoveryCache.expiresAt > now
  ) {
    return codexMirrorDiscoveryCache.result;
  }
  const result = await discoverCodexAppServerSlashCommands({
    config: params.cfg,
    workspaceDir: params.workspaceDir,
    sessionKey: params.sessionKey,
  });
  codexMirrorDiscoveryCache = {
    key: cacheKey,
    expiresAt: now + CODEX_MIRROR_DISCOVERY_TTL_MS,
    result,
  };
  return result;
}

function formatCodexMirrorSlashDiscovery(result: CodexMirrorSlashDiscoveryResult): string {
  if (!result.available) {
    return `Codex slash discovery unavailable${result.error ? `: ${result.error}` : "."}`;
  }
  if (result.commands.length === 0) {
    return "No discoverable Codex/MCP slash commands are currently available.";
  }
  const rows = result.commands
    .slice(0, 60)
    .map((entry) => `- /codex_${entry.name} (${entry.source})`);
  const suffix = result.commands.length > 60 ? `\n… and ${result.commands.length - 60} more` : "";
  const collisions =
    result.collisions.length > 0
      ? `\n\nName collisions skipped:\n${result.collisions
          .slice(0, 10)
          .map((entry) => `- ${entry.name}: ${entry.raws.join(", ")}`)
          .join("\n")}`
      : "";
  return `Discoverable mirrored commands:\n${rows.join("\n")}${suffix}${collisions}`;
}

function formatCodexThreadDiscovery(params: {
  result: CodexThreadDiscoveryResult;
  filter: string;
  currentThreadId?: string;
}): string {
  const normalizedFilter = params.filter.trim().toLowerCase();
  const rows = params.result.threads.filter((entry) => {
    if (!normalizedFilter) {
      return true;
    }
    return (
      entry.threadId.toLowerCase().includes(normalizedFilter) ||
      (entry.projectKey ?? "").toLowerCase().includes(normalizedFilter) ||
      (entry.title ?? "").toLowerCase().includes(normalizedFilter)
    );
  });
  if (rows.length === 0) {
    return normalizedFilter
      ? `No Codex threads matched "${params.filter.trim()}".`
      : "No Codex threads were returned by Codex App Server.";
  }
  const lines = rows.slice(0, 40).map((entry, index) => {
    const marker = entry.threadId === params.currentThreadId ? "*" : " ";
    const projectPart = entry.projectKey ? ` project=${entry.projectKey}` : "";
    const titlePart = entry.title ? ` title=${entry.title}` : "";
    return `${marker}${index + 1}. thread=${entry.threadId}${projectPart}${titlePart}`;
  });
  const suffix = rows.length > 40 ? `\n… and ${rows.length - 40} more` : "";
  return `Known Codex threads (from Codex App Server):\n${lines.join("\n")}${suffix}`;
}

const ABSOLUTE_PATH_RE = /(?:^|[\s"'`])((?:\/[^/\s"'`]+)+\/?)/g;

function normalizePromptPathCandidate(raw: string): string {
  const withoutTrailing = raw.replace(/[),.;:!?]+$/g, "");
  const trimmed = withoutTrailing.trim();
  if (!trimmed) {
    return "";
  }
  return path.normalize(trimmed);
}

function resolveCodexWorkspaceDirFromPrompt(prompt: string, fallbackDir: string): string {
  const candidates: string[] = [];
  ABSOLUTE_PATH_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ABSOLUTE_PATH_RE.exec(prompt))) {
    const candidate = normalizePromptPathCandidate(match[1] ?? "");
    if (!candidate || !path.isAbsolute(candidate)) {
      continue;
    }
    candidates.push(candidate);
  }
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
      if (stat.isFile()) {
        return path.dirname(candidate);
      }
    } catch {
      // ignore nonexistent path candidates
    }
  }
  return fallbackDir;
}

function truncateCodexContext(text: string, maxChars = 12_000): string {
  if (text.length <= maxChars) {
    return text;
  }
  const clipped = text.slice(0, maxChars).trimEnd();
  return `${clipped}\n\n[truncated ${text.length - clipped.length} chars]`;
}

function buildCodexInputCallbackData(requestId: string | undefined, optionIndex1: number): string {
  const withRequest = requestId
    ? `${CODEX_INPUT_CALLBACK_PREFIX}:${requestId}:${optionIndex1}`
    : "";
  if (withRequest && withRequest.length <= 64) {
    return withRequest;
  }
  return `${CODEX_INPUT_CALLBACK_PREFIX}:${optionIndex1}`;
}

function resolveCodexOptionButtonStyle(option: string): "success" | "danger" | "primary" {
  const normalized = option.trim().toLowerCase();
  if (normalized.startsWith("deny") || normalized.startsWith("cancel")) {
    return "danger";
  }
  if (normalized.startsWith("approve")) {
    return "success";
  }
  return "primary";
}

function buildCodexInputButtons(params: {
  text: string;
  requestId?: string;
  options?: string[];
}): TelegramInlineButtons | undefined {
  if (!/agent input requested/i.test(params.text)) {
    return undefined;
  }
  const options = params.options?.filter((entry) => entry.trim().length > 0) ?? [];
  if (options.length === 0) {
    return undefined;
  }
  return options.map((option, idx) => [
    {
      text: `${idx + 1}. ${option}`,
      callback_data: buildCodexInputCallbackData(params.requestId, idx + 1),
      style: resolveCodexOptionButtonStyle(option),
    },
  ]);
}

function findCodexProgressBoundary(input: string): number {
  const candidates = ["\n\n", "\n", ". ", "! ", "? "];
  for (const token of candidates) {
    const idx = input.lastIndexOf(token);
    if (idx > 0) {
      return idx + token.length;
    }
  }
  const whitespace = input.lastIndexOf(" ");
  return whitespace > 0 ? whitespace + 1 : input.length;
}

function appendCodexProgressChunk(buffer: string, chunk: string): string {
  if (!chunk) {
    return buffer;
  }
  if (!buffer) {
    return chunk;
  }
  return `${buffer}${chunk}`;
}

function createCodexProgressEmitter(params: {
  emit: (text: string) => Promise<void>;
  minEmitChars?: number;
  maxEmitChars?: number;
  minEmitIntervalMs?: number;
  idleFlushMs?: number;
}) {
  const minEmitChars = Math.max(1, params.minEmitChars ?? 220);
  const maxEmitChars = Math.max(minEmitChars, params.maxEmitChars ?? 1_000);
  const minEmitIntervalMs = Math.max(0, params.minEmitIntervalMs ?? 4_000);
  const idleFlushMs = Math.max(250, params.idleFlushMs ?? minEmitIntervalMs);
  let buffer = "";
  let lastEmitAt = 0;
  let idleTimer: NodeJS.Timeout | undefined;

  const clearIdleFlush = () => {
    if (!idleTimer) {
      return;
    }
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const scheduleIdleFlush = () => {
    clearIdleFlush();
    if (!buffer) {
      return;
    }
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      void flush(true);
    }, idleFlushMs);
    idleTimer.unref?.();
  };

  const flush = async (force = false) => {
    if (!buffer) {
      clearIdleFlush();
      return;
    }
    const now = Date.now();
    const dueByTime = now - lastEmitAt >= minEmitIntervalMs;
    const dueBySize = buffer.length >= maxEmitChars;
    if (!force && !dueByTime && !dueBySize) {
      return;
    }
    if (!force && buffer.length < minEmitChars) {
      return;
    }
    const emitText = force
      ? buffer
      : (() => {
          const boundary = findCodexProgressBoundary(
            buffer.length <= maxEmitChars ? buffer : buffer.slice(0, maxEmitChars),
          );
          return buffer.slice(0, Math.max(1, boundary));
        })();
    buffer = force ? "" : buffer.slice(emitText.length).trimStart();
    if (!emitText.trim()) {
      if (buffer) {
        scheduleIdleFlush();
      } else {
        clearIdleFlush();
      }
      return;
    }
    await params.emit(emitText);
    lastEmitAt = now;
    if (buffer) {
      scheduleIdleFlush();
    } else {
      clearIdleFlush();
    }
  };

  const push = async (chunk: string) => {
    if (!chunk) {
      return;
    }
    buffer = appendCodexProgressChunk(buffer, chunk);
    scheduleIdleFlush();
    await flush(false);
  };

  return {
    push,
    flush,
  };
}

function buildResetSessionNoticeText(params: {
  provider: string;
  model: string;
  defaultProvider: string;
  defaultModel: string;
}): string {
  const modelLabel = `${params.provider}/${params.model}`;
  const defaultLabel = `${params.defaultProvider}/${params.defaultModel}`;
  return modelLabel === defaultLabel
    ? `✅ New session started · model: ${modelLabel}`
    : `✅ New session started · model: ${modelLabel} (default: ${defaultLabel})`;
}

function resolveResetSessionNoticeRoute(params: {
  ctx: MsgContext;
  command: ReturnType<typeof buildCommandContext>;
}): {
  channel: Parameters<typeof routeReply>[0]["channel"];
  to: string;
} | null {
  const commandChannel = params.command.channel?.trim().toLowerCase();
  const fallbackChannel =
    commandChannel && commandChannel !== "webchat"
      ? (commandChannel as Parameters<typeof routeReply>[0]["channel"])
      : undefined;
  const channel = params.ctx.OriginatingChannel ?? fallbackChannel;
  const to = params.ctx.OriginatingTo ?? params.command.from ?? params.command.to;
  if (!channel || channel === "webchat" || !to) {
    return null;
  }
  return { channel, to };
}

async function sendResetSessionNotice(params: {
  ctx: MsgContext;
  command: ReturnType<typeof buildCommandContext>;
  sessionKey: string;
  cfg: OpenClawConfig;
  accountId: string | undefined;
  threadId: string | number | undefined;
  provider: string;
  model: string;
  defaultProvider: string;
  defaultModel: string;
}): Promise<void> {
  const route = resolveResetSessionNoticeRoute({
    ctx: params.ctx,
    command: params.command,
  });
  if (!route) {
    return;
  }
  await routeReply({
    payload: {
      text: buildResetSessionNoticeText({
        provider: params.provider,
        model: params.model,
        defaultProvider: params.defaultProvider,
        defaultModel: params.defaultModel,
      }),
    },
    channel: route.channel,
    to: route.to,
    sessionKey: params.sessionKey,
    accountId: params.accountId,
    threadId: params.threadId,
    cfg: params.cfg,
  });
}

type CodexBindingContext = {
  channel: "discord" | "telegram";
  accountId: string;
  conversationId: string;
  placement: "current" | "child";
  labelNoun: "thread" | "conversation";
};

function resolveCodexBindingContext(params: {
  ctx: MsgContext;
  command: ReturnType<typeof buildCommandContext>;
}): CodexBindingContext | null {
  const channel = (
    params.ctx.OriginatingChannel ??
    params.command.channel ??
    params.ctx.Surface ??
    params.ctx.Provider
  )
    ?.trim()
    .toLowerCase();
  const accountId =
    typeof params.ctx.AccountId === "string" && params.ctx.AccountId.trim()
      ? params.ctx.AccountId.trim()
      : "default";
  if (channel === "telegram") {
    const conversationId = resolveTelegramConversationId({
      ctx: params.ctx,
      command: params.command,
    });
    if (!conversationId) {
      return null;
    }
    return {
      channel: "telegram",
      accountId,
      conversationId,
      placement: "current",
      labelNoun: "conversation",
    };
  }
  if (channel === "discord") {
    const currentThreadId =
      params.ctx.MessageThreadId != null ? String(params.ctx.MessageThreadId).trim() : "";
    const toCandidates = [
      typeof params.ctx.OriginatingTo === "string" ? params.ctx.OriginatingTo.trim() : "",
      typeof params.command.to === "string" ? params.command.to.trim() : "",
      typeof params.ctx.To === "string" ? params.ctx.To.trim() : "",
    ].filter(Boolean);
    const parentChannelId = currentThreadId
      ? ""
      : toCandidates
          .map((candidate) => {
            try {
              const target = parseDiscordTarget(candidate, { defaultKind: "channel" });
              return target?.kind === "channel" ? target.id.trim() : "";
            } catch {
              return "";
            }
          })
          .find(Boolean);
    const conversationId = currentThreadId || parentChannelId;
    if (!conversationId) {
      return null;
    }
    return {
      channel: "discord",
      accountId,
      conversationId,
      placement: currentThreadId ? "current" : "child",
      labelNoun: "thread",
    };
  }
  return null;
}

type RunPreparedReplyParams = {
  ctx: MsgContext;
  sessionCtx: TemplateContext;
  cfg: OpenClawConfig;
  agentId: string;
  agentDir: string;
  agentCfg: AgentDefaults;
  sessionCfg: OpenClawConfig["session"];
  commandAuthorized: boolean;
  command: ReturnType<typeof buildCommandContext>;
  commandSource: string;
  allowTextCommands: boolean;
  directives: InlineDirectives;
  defaultActivation: Parameters<typeof buildGroupIntro>[0]["defaultActivation"];
  resolvedThinkLevel: ThinkLevel | undefined;
  resolvedVerboseLevel: VerboseLevel | undefined;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel: ElevatedLevel;
  execOverrides?: ExecOverrides;
  elevatedEnabled: boolean;
  elevatedAllowed: boolean;
  blockStreamingEnabled: boolean;
  blockReplyChunking?: {
    minChars: number;
    maxChars: number;
    breakPreference: "paragraph" | "newline" | "sentence";
    flushOnParagraph?: boolean;
  };
  resolvedBlockStreamingBreak: "text_end" | "message_end";
  modelState: Awaited<ReturnType<typeof createModelSelectionState>>;
  provider: string;
  model: string;
  perMessageQueueMode?: InlineDirectives["queueMode"];
  perMessageQueueOptions?: {
    debounceMs?: number;
    cap?: number;
    dropPolicy?: InlineDirectives["dropPolicy"];
  };
  typing: TypingController;
  opts?: GetReplyOptions;
  defaultProvider: string;
  defaultModel: string;
  timeoutMs: number;
  isNewSession: boolean;
  resetTriggered: boolean;
  systemSent: boolean;
  sessionEntry?: SessionEntry;
  sessionStore?: Record<string, SessionEntry>;
  sessionKey: string;
  sessionId?: string;
  storePath?: string;
  workspaceDir: string;
  abortedLastRun: boolean;
};

export async function runPreparedReply(
  params: RunPreparedReplyParams,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const {
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    agentCfg,
    sessionCfg,
    commandAuthorized,
    command,
    commandSource,
    allowTextCommands,
    directives,
    defaultActivation,
    elevatedEnabled,
    elevatedAllowed,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    modelState,
    provider,
    model,
    perMessageQueueMode,
    perMessageQueueOptions,
    typing,
    opts,
    defaultProvider,
    defaultModel,
    timeoutMs,
    isNewSession,
    resetTriggered,
    systemSent,
    sessionKey,
    sessionId,
    storePath,
    workspaceDir,
    sessionStore,
  } = params;
  let {
    sessionEntry,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    execOverrides,
    abortedLastRun,
  } = params;
  let currentSystemSent = systemSent;

  const isFirstTurnInSession = isNewSession || !currentSystemSent;
  const isGroupChat = sessionCtx.ChatType === "group";
  const wasMentioned = ctx.WasMentioned === true;
  const isHeartbeat = opts?.isHeartbeat === true;
  const { typingPolicy, suppressTyping } = resolveRunTypingPolicy({
    requestedPolicy: opts?.typingPolicy,
    suppressTyping: opts?.suppressTyping === true,
    isHeartbeat,
    originatingChannel: ctx.OriginatingChannel,
  });
  const typingMode = resolveTypingMode({
    configured: sessionCfg?.typingMode ?? agentCfg?.typingMode,
    isGroupChat,
    wasMentioned,
    isHeartbeat,
    typingPolicy,
    suppressTyping,
  });
  const shouldInjectGroupIntro = Boolean(
    isGroupChat && (isFirstTurnInSession || sessionEntry?.groupActivationNeedsSystemIntro),
  );
  // Always include persistent group chat context (name, participants, reply guidance)
  const groupChatContext = isGroupChat ? buildGroupChatContext({ sessionCtx }) : "";
  // Behavioral intro (activation mode, lurking, etc.) only on first turn / activation needed
  const groupIntro = shouldInjectGroupIntro
    ? buildGroupIntro({
        cfg,
        sessionCtx,
        sessionEntry,
        defaultActivation,
        silentToken: SILENT_REPLY_TOKEN,
      })
    : "";
  const groupSystemPrompt = sessionCtx.GroupSystemPrompt?.trim() ?? "";
  const inboundMetaPrompt = buildInboundMetaSystemPrompt(
    isNewSession ? sessionCtx : { ...sessionCtx, ThreadStarterBody: undefined },
  );
  const extraSystemPromptParts = [
    inboundMetaPrompt,
    groupChatContext,
    groupIntro,
    groupSystemPrompt,
  ].filter(Boolean);
  const baseBody = sessionCtx.BodyStripped ?? sessionCtx.Body ?? "";
  const parsedCodexCommand = parseCodexCommand(command.commandBodyNormalized);
  const sessionBindingService = getSessionBindingService();
  const codexBindingContext = resolveCodexBindingContext({ ctx, command });
  const codexConversationBinding = codexBindingContext
    ? sessionBindingService.resolveByConversation({
        channel: codexBindingContext.channel,
        accountId: codexBindingContext.accountId,
        conversationId: codexBindingContext.conversationId,
      })
    : null;
  const isFocusedToCurrentSession =
    codexConversationBinding?.targetSessionKey?.trim() === sessionKey &&
    codexBindingContext?.conversationId === codexConversationBinding.conversation.conversationId;
  const explicitCodexCommandPrompt =
    parsedCodexCommand.type === "oneshot"
      ? parsedCodexCommand.prompt
      : parsedCodexCommand.type === "mirrored"
        ? `/${parsedCodexCommand.slashName}${parsedCodexCommand.args ? ` ${parsedCodexCommand.args}` : ""}`
        : parsedCodexCommand.type === "new" && parsedCodexCommand.task
          ? parsedCodexCommand.task
          : null;
  const shouldAutoRouteToCodex =
    parsedCodexCommand.type === "none" &&
    (sessionEntry?.codexAutoRoute === true ||
      (isFocusedToCurrentSession && Boolean(sessionEntry?.codexThreadId?.trim())));
  let codexCommandPrompt = explicitCodexCommandPrompt;
  const normalizedCommandBody = (command.commandBodyNormalized ?? "").trim();
  log.debug("prepared reply command context", {
    commandSource: ctx.CommandSource ?? "unknown",
    commandBodyNormalized: command.commandBodyNormalized,
    rawBodyNormalized: command.rawBodyNormalized,
    provider,
    model,
  });
  if (normalizedCommandBody.toLowerCase().startsWith("/codex")) {
    log.info("received /codex command", {
      commandSource: ctx.CommandSource ?? "unknown",
      surface: command.surface || "unknown",
      channel: command.channel || "unknown",
      isAuthorizedSender: command.isAuthorizedSender,
      parsed: parsedCodexCommand.type,
      commandBodyNormalized: command.commandBodyNormalized,
    });
  }
  if (
    parsedCodexCommand.type !== "none" &&
    parsedCodexCommand.type !== "legacy-invalid" &&
    !command.isAuthorizedSender
  ) {
    typing.cleanup();
    log.warn("rejected /codex command from unauthorized sender", {
      commandSource: ctx.CommandSource ?? "unknown",
      channel: command.channel || "unknown",
      commandBodyNormalized: command.commandBodyNormalized,
    });
    return {
      text: "Only authorized senders can use /codex.",
    };
  }
  if (command.isAuthorizedSender && parsedCodexCommand.type === "mirrored") {
    const discovery = await resolveCodexMirrorSlashDiscovery({
      cfg,
      workspaceDir,
      sessionKey,
    });
    if (discovery.available && discovery.commands.length > 0) {
      const knownNames = new Set(discovery.commands.map((entry) => entry.name));
      if (!knownNames.has(parsedCodexCommand.slashName)) {
        typing.cleanup();
        const sample = discovery.commands
          .slice(0, 15)
          .map((entry) => `/codex_${entry.name}`)
          .join(", ");
        return {
          text: [
            `Unknown mirrored command: /codex_${parsedCodexCommand.slashName}`,
            sample ? `Known mirrored commands: ${sample}` : "",
            "Run `/codex list commands` to refresh discoverable slash commands.",
          ]
            .filter(Boolean)
            .join("\n"),
        };
      }
    }
  }
  if (
    parsedCodexCommand.type === "root" ||
    parsedCodexCommand.type === "legacy-invalid" ||
    (parsedCodexCommand.type === "oneshot" && !parsedCodexCommand.prompt)
  ) {
    typing.cleanup();
    log.info("replied with /codex usage due to missing/invalid subcommand");
    return {
      text: CODEX_USAGE_TEXT,
    };
  }
  // Use CommandBody/RawBody for bare reset detection (clean message without structural context).
  const rawBodyTrimmed = (ctx.CommandBody ?? ctx.RawBody ?? ctx.Body ?? "").trim();
  const baseBodyTrimmedRaw = baseBody.trim();
  if (
    allowTextCommands &&
    (!commandAuthorized || !command.isAuthorizedSender) &&
    !baseBodyTrimmedRaw &&
    hasControlCommand(commandSource, cfg)
  ) {
    typing.cleanup();
    return undefined;
  }
  const isBareNewOrReset = rawBodyTrimmed === "/new" || rawBodyTrimmed === "/reset";
  const isBareSessionReset =
    isNewSession &&
    ((baseBodyTrimmedRaw.length === 0 && rawBodyTrimmed.length > 0) || isBareNewOrReset);
  const baseBodyFinal = isBareSessionReset ? buildBareSessionResetPrompt(cfg) : baseBody;
  const inboundUserContext = buildInboundUserContextPrefix(
    isNewSession
      ? {
          ...sessionCtx,
          ...(sessionCtx.ThreadHistoryBody?.trim()
            ? { InboundHistory: undefined, ThreadStarterBody: undefined }
            : {}),
        }
      : { ...sessionCtx, ThreadStarterBody: undefined },
  );
  const baseBodyForPrompt = isBareSessionReset
    ? baseBodyFinal
    : [inboundUserContext, baseBodyFinal].filter(Boolean).join("\n\n");
  const baseBodyTrimmed = baseBodyForPrompt.trim();
  const hasMediaAttachment = Boolean(
    sessionCtx.MediaPath || (sessionCtx.MediaPaths && sessionCtx.MediaPaths.length > 0),
  );
  if (!baseBodyTrimmed && !hasMediaAttachment) {
    await typing.onReplyStart();
    logVerbose("Inbound body empty after normalization; skipping agent run");
    typing.cleanup();
    return {
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    };
  }
  // When the user sends media without text, provide a minimal body so the agent
  // run proceeds and the image/document is injected by the embedded runner.
  const effectiveBaseBodyBase = baseBodyTrimmed
    ? baseBodyForPrompt
    : "[User sent media without caption]";
  if (!codexCommandPrompt && shouldAutoRouteToCodex) {
    codexCommandPrompt = effectiveBaseBodyBase;
  }
  let effectiveBaseBody = codexCommandPrompt ?? effectiveBaseBodyBase;
  let prefixedBodyBase = await applySessionHints({
    baseBody: effectiveBaseBody,
    abortedLastRun,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    abortKey: command.abortKey,
  });
  const isGroupSession = sessionEntry?.chatType === "group" || sessionEntry?.chatType === "channel";
  const isMainSession = !isGroupSession && sessionKey === normalizeMainKey(sessionCfg?.mainKey);
  // Extract first-token think hint from the user body BEFORE prepending system events.
  // If done after, the System: prefix becomes parts[0] and silently shadows any
  // low|medium|high shorthand the user typed.
  if (!resolvedThinkLevel && prefixedBodyBase) {
    const parts = prefixedBodyBase.split(/\s+/);
    const maybeLevel = normalizeThinkLevel(parts[0]);
    if (maybeLevel && (maybeLevel !== "xhigh" || supportsXHighThinking(provider, model))) {
      resolvedThinkLevel = maybeLevel;
      prefixedBodyBase = parts.slice(1).join(" ").trim();
    }
  }
  // Drain system events once, then prepend to each path's body independently.
  // The queue/steer path uses effectiveBaseBody (unstripped, no session hints) to match
  // main's pre-PR behavior; the immediate-run path uses prefixedBodyBase (post-hints,
  // post-think-hint-strip) so the run sees the cleaned-up body.
  const eventsBlock = await drainFormattedSystemEvents({
    cfg,
    sessionKey,
    isMainSession,
    isNewSession,
  });
  const prependEvents = (body: string) => (eventsBlock ? `${eventsBlock}\n\n${body}` : body);
  const bodyWithEvents = prependEvents(effectiveBaseBody);
  prefixedBodyBase = prependEvents(prefixedBodyBase);
  prefixedBodyBase = appendUntrustedContext(prefixedBodyBase, sessionCtx.UntrustedContext);
  const threadStarterBody = ctx.ThreadStarterBody?.trim();
  const threadHistoryBody = ctx.ThreadHistoryBody?.trim();
  const threadContextNote = threadHistoryBody
    ? `[Thread history - for context]\n${threadHistoryBody}`
    : threadStarterBody
      ? `[Thread starter - for context]\n${threadStarterBody}`
      : undefined;
  const skillResult = await ensureSkillSnapshot({
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionId,
    isFirstTurnInSession,
    workspaceDir,
    cfg,
    skillFilter: opts?.skillFilter,
  });
  sessionEntry = skillResult.sessionEntry ?? sessionEntry;
  currentSystemSent = skillResult.systemSent;
  const skillsSnapshot = skillResult.skillsSnapshot;
  const prefixedBody = [threadContextNote, prefixedBodyBase].filter(Boolean).join("\n\n");
  const mediaNote = buildInboundMediaNote(ctx);
  const mediaReplyHint = mediaNote
    ? "To send an image back, prefer the message tool (media/path/filePath). If you must inline, use MEDIA:https://example.com/image.jpg (spaces ok, quote if needed) or a safe relative path like MEDIA:./image.jpg. Avoid absolute paths (MEDIA:/...) and ~ paths — they are blocked for security. Keep caption in the text body."
    : undefined;
  let prefixedCommandBody = mediaNote
    ? [mediaNote, mediaReplyHint, prefixedBody ?? ""].filter(Boolean).join("\n").trim()
    : prefixedBody;
  if (!resolvedThinkLevel) {
    resolvedThinkLevel = await modelState.resolveDefaultThinkingLevel();
  }
  if (resolvedThinkLevel === "xhigh" && !supportsXHighThinking(provider, model)) {
    const explicitThink = directives.hasThinkDirective && directives.thinkLevel !== undefined;
    if (explicitThink) {
      typing.cleanup();
      return {
        text: `Thinking level "xhigh" is only supported for ${formatXHighModelHint()}. Use /think high or switch to one of those models.`,
      };
    }
    resolvedThinkLevel = "high";
    if (sessionEntry && sessionStore && sessionKey && sessionEntry.thinkingLevel === "xhigh") {
      sessionEntry.thinkingLevel = "high";
      sessionEntry.updatedAt = Date.now();
      sessionStore[sessionKey] = sessionEntry;
      if (storePath) {
        await updateSessionStore(storePath, (store) => {
          store[sessionKey] = sessionEntry;
        });
      }
    }
  }
  if (resetTriggered && command.isAuthorizedSender) {
    await sendResetSessionNotice({
      ctx,
      command,
      sessionKey,
      cfg,
      accountId: ctx.AccountId,
      threadId: ctx.MessageThreadId,
      provider,
      model,
      defaultProvider,
      defaultModel,
    });
  }
  const persistCodexSessionUpdate = async (patch: Partial<SessionEntry>) => {
    if (!sessionEntry || !sessionStore || !sessionKey) {
      return false;
    }
    Object.assign(sessionEntry, patch);
    sessionEntry.updatedAt = Date.now();
    sessionStore[sessionKey] = sessionEntry;
    if (storePath) {
      await updateSessionStore(storePath, (store) => {
        const current = store[sessionKey] ?? sessionEntry;
        store[sessionKey] = {
          ...current,
          ...patch,
          updatedAt: Date.now(),
        };
      });
    }
    return true;
  };
  const clearCodexSessionState = async (opts?: { keepAutoRoute?: boolean }) =>
    persistCodexSessionUpdate({
      codexThreadId: undefined,
      codexRunId: undefined,
      codexProjectKey: undefined,
      codexAutoRoute: opts?.keepAutoRoute ? sessionEntry?.codexAutoRoute : undefined,
      pendingUserInputRequestId: undefined,
      pendingUserInputOptions: undefined,
      pendingUserInputExpiresAt: undefined,
    });
  const bindCurrentConversationToSession = async (label: string) => {
    if (!codexBindingContext) {
      return {
        ok: true as const,
      };
    }
    const capabilities = sessionBindingService.getCapabilities({
      channel: codexBindingContext.channel,
      accountId: codexBindingContext.accountId,
    });
    if (!capabilities.adapterAvailable || !capabilities.bindSupported) {
      return {
        ok: true as const,
      };
    }
    if (!capabilities.placements.includes(codexBindingContext.placement)) {
      return {
        ok: false as const,
        error: `${codexBindingContext.channel} bindings are unavailable for this ${codexBindingContext.labelNoun}.`,
      };
    }
    const senderId = command.senderId?.trim() || "";
    const existingBinding = sessionBindingService.resolveByConversation({
      channel: codexBindingContext.channel,
      accountId: codexBindingContext.accountId,
      conversationId: codexBindingContext.conversationId,
    });
    const boundBy =
      typeof existingBinding?.metadata?.boundBy === "string"
        ? existingBinding.metadata.boundBy.trim()
        : "";
    if (existingBinding && boundBy && boundBy !== "system" && senderId && senderId !== boundBy) {
      return {
        ok: false as const,
        error: `Only ${boundBy} can rebind this ${codexBindingContext.labelNoun}.`,
      };
    }
    await sessionBindingService.bind({
      targetSessionKey: sessionKey,
      targetKind: "session",
      conversation: {
        channel: codexBindingContext.channel,
        accountId: codexBindingContext.accountId,
        conversationId: codexBindingContext.conversationId,
      },
      placement: codexBindingContext.placement,
      metadata: {
        label,
        boundBy: senderId || "unknown",
      },
    });
    return {
      ok: true as const,
    };
  };
  const unbindCurrentConversation = async () => {
    if (!codexBindingContext) {
      return { ok: true as const, unbound: false };
    }
    const capabilities = sessionBindingService.getCapabilities({
      channel: codexBindingContext.channel,
      accountId: codexBindingContext.accountId,
    });
    if (!capabilities.adapterAvailable || !capabilities.unbindSupported) {
      return { ok: true as const, unbound: false };
    }
    const existingBinding = sessionBindingService.resolveByConversation({
      channel: codexBindingContext.channel,
      accountId: codexBindingContext.accountId,
      conversationId: codexBindingContext.conversationId,
    });
    if (!existingBinding || existingBinding.targetSessionKey !== sessionKey) {
      return { ok: true as const, unbound: false };
    }
    const senderId = command.senderId?.trim() || "";
    const boundBy =
      typeof existingBinding.metadata?.boundBy === "string"
        ? existingBinding.metadata.boundBy.trim()
        : "";
    if (boundBy && boundBy !== "system" && senderId && senderId !== boundBy) {
      return {
        ok: false as const,
        unbound: false as const,
        error: `Only ${boundBy} can unbind this ${codexBindingContext.labelNoun}.`,
      };
    }
    await sessionBindingService.unbind({
      bindingId: existingBinding.bindingId,
      reason: "manual-unfocus",
    });
    return { ok: true as const, unbound: true as const };
  };
  type KnownCodexThread = {
    sessionKey: string;
    sessionId: string;
    threadId: string;
    runId: string;
    projectKey: string;
    pendingRequestId: string;
    pendingOptions: string[];
    pendingExpiresAt?: number;
    updatedAt: number;
  };
  const collectKnownCodexThreads = () => {
    if (!sessionStore) {
      return [] as KnownCodexThread[];
    }
    return Object.entries(sessionStore)
      .map(([key, entry]) => ({
        sessionKey: key,
        sessionId: entry?.sessionId?.trim() ?? "",
        threadId: entry?.codexThreadId?.trim() ?? "",
        runId: entry?.codexRunId?.trim() ?? "",
        projectKey: entry?.codexProjectKey?.trim() ?? "",
        pendingRequestId: entry?.pendingUserInputRequestId?.trim() ?? "",
        pendingOptions: [...(entry?.pendingUserInputOptions ?? [])].filter(
          (option): option is string => typeof option === "string" && option.trim().length > 0,
        ),
        pendingExpiresAt: entry?.pendingUserInputExpiresAt,
        updatedAt: entry?.updatedAt ?? 0,
      }))
      .filter((entry) => entry.threadId.length > 0)
      .toSorted((a, b) => b.updatedAt - a.updatedAt);
  };
  const formatKnownCodexThreads = (filter: string) => {
    const normalizedFilter = filter.trim().toLowerCase();
    const rows = collectKnownCodexThreads().filter((entry) => {
      if (!normalizedFilter) {
        return true;
      }
      return (
        entry.threadId.toLowerCase().includes(normalizedFilter) ||
        entry.projectKey.toLowerCase().includes(normalizedFilter) ||
        entry.sessionKey.toLowerCase().includes(normalizedFilter)
      );
    });
    if (rows.length === 0) {
      return normalizedFilter
        ? `No known Codex threads matched "${filter.trim()}".`
        : "No known Codex threads yet for this session store.";
    }
    const lines = rows.slice(0, 20).map((entry, index) => {
      const marker = entry.sessionKey === sessionKey ? "*" : " ";
      const projectPart = entry.projectKey ? ` project=${entry.projectKey}` : "";
      const runPart = entry.runId ? ` run=${entry.runId}` : "";
      const pendingPart = entry.pendingRequestId ? ` pending=${entry.pendingRequestId}` : "";
      return `${marker}${index + 1}. thread=${entry.threadId}${projectPart}${runPart}${pendingPart} session=${entry.sessionKey}`;
    });
    const suffix = rows.length > 20 ? `\n… and ${rows.length - 20} more` : "";
    return `Known Codex threads:\n${lines.join("\n")}${suffix}`;
  };
  const buildPendingInputReplayReply = (entry: KnownCodexThread): ReplyPayload | undefined => {
    if (!entry.pendingRequestId) {
      return undefined;
    }
    if (entry.pendingExpiresAt != null && entry.pendingExpiresAt <= Date.now()) {
      return undefined;
    }
    const options =
      entry.pendingOptions.length > 0 ? entry.pendingOptions : ["Approve", "Deny", "Cancel"];
    const promptText = [
      `🧭 Agent input requested (${entry.pendingRequestId})`,
      "Pending approval is still waiting for input.",
      "",
      "Options:",
      ...options.map((option, idx) => `${idx + 1}. ${option}`),
      "",
      'Reply with "1", "2", "option 1", etc., or send free text.',
    ].join("\n");
    const buttons =
      command.channel === "telegram"
        ? buildCodexInputButtons({
            text: promptText,
            requestId: entry.pendingRequestId,
            options,
          })
        : undefined;
    return {
      text: promptText,
      ...(buttons ? { channelData: { telegram: { buttons } } } : {}),
    };
  };
  const resolveCodexThreadTarget = (
    raw: string,
    opts?: {
      allowUnknownExplicitId?: boolean;
      allowFuzzyMatch?: boolean;
    },
  ) => {
    const query = raw.trim();
    if (!query) {
      return { ok: false as const, error: "Missing thread id/query." };
    }
    if (isMalformedUuidLikeCodexThreadId(query)) {
      return {
        ok: false as const,
        error:
          `Invalid Codex thread id "${query}". Expected UUID format ` +
          "`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.",
      };
    }
    const rows = collectKnownCodexThreads();
    const exact = rows.find((entry) => entry.threadId === query);
    if (exact) {
      return { ok: true as const, match: exact };
    }
    if (opts?.allowFuzzyMatch !== false) {
      const normalizedQuery = query.toLowerCase();
      const matches = rows.filter(
        (entry) =>
          entry.threadId.toLowerCase().includes(normalizedQuery) ||
          entry.projectKey.toLowerCase().includes(normalizedQuery) ||
          entry.sessionKey.toLowerCase().includes(normalizedQuery),
      );
      if (matches.length === 1) {
        return {
          ok: true as const,
          match: matches[0],
        };
      }
      if (matches.length > 1) {
        return {
          ok: false as const,
          error: `Query matched multiple threads. Use exact thread id.\n${formatKnownCodexThreads(query)}`,
        };
      }
    }
    if (opts?.allowUnknownExplicitId === false) {
      return {
        ok: false as const,
        error: `No known Codex threads matched "${query}". Use \`/codex list\` or \`/codex bind <thread-id>\`.`,
      };
    }
    // Accept explicit ids even if unseen in local store.
    return {
      ok: true as const,
      match: {
        sessionKey: "",
        sessionId: "",
        threadId: query,
        runId: "",
        projectKey: "",
        pendingRequestId: "",
        pendingOptions: [],
        pendingExpiresAt: undefined,
        updatedAt: 0,
      } satisfies KnownCodexThread,
    };
  };
  const hydrateCodexThreadTargetFromDiscovery = async (entry: KnownCodexThread) => {
    if (entry.projectKey || !entry.threadId.trim()) {
      return entry;
    }
    const attempts = await Promise.all([
      discoverCodexAppServerThreads({
        config: cfg,
        sessionKey,
        workspaceDir,
      }),
      discoverCodexAppServerThreads({
        config: cfg,
        sessionKey,
      }),
    ]);
    for (const discovery of attempts) {
      if (!discovery.available || discovery.threads.length === 0) {
        continue;
      }
      const exact = discovery.threads.find((candidate) => candidate.threadId === entry.threadId);
      if (!exact) {
        continue;
      }
      return {
        ...entry,
        runId: entry.runId || "",
        projectKey: exact.projectKey?.trim() || entry.projectKey,
      } satisfies KnownCodexThread;
    }
    return entry;
  };
  if (command.isAuthorizedSender && parsedCodexCommand.type === "status") {
    typing.cleanup();
    return {
      text: [
        `Codex binding status for session ${sessionKey}:`,
        `thread: ${sessionEntry?.codexThreadId?.trim() || "unbound"}`,
        `run: ${sessionEntry?.codexRunId?.trim() || "n/a"}`,
        `project: ${sessionEntry?.codexProjectKey?.trim() || "n/a"}`,
        `routing: ${sessionEntry?.codexAutoRoute === true ? "codex-bound" : "default"}`,
        `focus binding: ${isFocusedToCurrentSession ? "active" : "inactive"}`,
        sessionEntry?.pendingUserInputRequestId
          ? `pending approval: ${sessionEntry.pendingUserInputRequestId}`
          : "pending approval: none",
      ].join("\n"),
    };
  }
  if (command.isAuthorizedSender && parsedCodexCommand.type === "list") {
    const filter = parsedCodexCommand.filter.trim().toLowerCase();
    if (CODEX_LIST_SLASH_FILTERS.has(filter)) {
      const discovery = await resolveCodexMirrorSlashDiscovery({
        cfg,
        workspaceDir,
        sessionKey,
        forceRefresh: true,
      });
      typing.cleanup();
      return { text: formatCodexMirrorSlashDiscovery(discovery) };
    }
    const discoveredThreads = await discoverCodexAppServerThreads({
      config: cfg,
      sessionKey,
      workspaceDir,
    });
    typing.cleanup();
    if (discoveredThreads.available) {
      return {
        text: formatCodexThreadDiscovery({
          result: discoveredThreads,
          filter: parsedCodexCommand.filter,
          currentThreadId: sessionEntry?.codexThreadId?.trim(),
        }),
      };
    }
    return {
      text: `${formatKnownCodexThreads(parsedCodexCommand.filter)}\n\nCodex thread discovery unavailable${discoveredThreads.error ? `: ${discoveredThreads.error}` : "."}\nShowing locally known OpenClaw-bound Codex threads only.`,
    };
  }
  if (command.isAuthorizedSender && parsedCodexCommand.type === "detach") {
    const unbind = await unbindCurrentConversation();
    if (!unbind.ok) {
      typing.cleanup();
      return {
        text: `⚠️ ${unbind.error}`,
      };
    }
    await persistCodexSessionUpdate({
      codexAutoRoute: undefined,
      pendingUserInputRequestId: undefined,
      pendingUserInputOptions: undefined,
      pendingUserInputExpiresAt: undefined,
    });
    typing.cleanup();
    return {
      text: unbind.unbound
        ? "✅ Detached this conversation from Codex focus routing. Remote Codex thread remains active."
        : "✅ Detached this session from Codex auto-routing. Remote Codex thread remains active.",
    };
  }
  if (
    command.isAuthorizedSender &&
    (parsedCodexCommand.type === "join" ||
      parsedCodexCommand.type === "resume" ||
      parsedCodexCommand.type === "bind")
  ) {
    const lookup =
      parsedCodexCommand.type === "join"
        ? resolveCodexThreadTarget(parsedCodexCommand.query, {
            allowUnknownExplicitId: true,
            allowFuzzyMatch: true,
          })
        : parsedCodexCommand.type === "resume"
          ? resolveCodexThreadTarget(parsedCodexCommand.target, {
              allowUnknownExplicitId: false,
              allowFuzzyMatch: true,
            })
          : resolveCodexThreadTarget(parsedCodexCommand.threadId, {
              allowUnknownExplicitId: true,
              allowFuzzyMatch: false,
            });
    if (!lookup.ok) {
      typing.cleanup();
      return { text: `⚠️ ${lookup.error}` };
    }
    const match = await hydrateCodexThreadTargetFromDiscovery(lookup.match);
    const shouldCarryPending =
      Boolean(match.pendingRequestId) &&
      (match.pendingExpiresAt == null || match.pendingExpiresAt > Date.now());
    await persistCodexSessionUpdate({
      sessionId: match.sessionId || sessionEntry?.sessionId,
      codexThreadId: match.threadId,
      codexProjectKey: match.projectKey || undefined,
      codexRunId: match.runId || undefined,
      codexAutoRoute: true,
      pendingUserInputRequestId: shouldCarryPending ? match.pendingRequestId : undefined,
      pendingUserInputOptions: shouldCarryPending ? match.pendingOptions : undefined,
      pendingUserInputExpiresAt: shouldCarryPending ? match.pendingExpiresAt : undefined,
    });
    const bindingAttempt = await bindCurrentConversationToSession(`codex:${match.threadId}`);
    if (!bindingAttempt.ok) {
      typing.cleanup();
      return {
        text: `⚠️ ${bindingAttempt.error}`,
      };
    }
    typing.cleanup();
    const bindHint =
      parsedCodexCommand.type === "bind" && parsedCodexCommand.bindHere
        ? " (bound to current thread context)"
        : "";
    const verb =
      parsedCodexCommand.type === "join"
        ? "Joined"
        : parsedCodexCommand.type === "resume"
          ? "Resumed"
          : "Bound";
    const replay = shouldCarryPending ? buildPendingInputReplayReply(match) : undefined;
    const replayText = replay?.text ? `\n\n${replay.text}` : "";
    const projectHint = match.projectKey ? `\nproject: ${match.projectKey}` : "";
    return {
      text: `✅ ${verb} this session to Codex thread ${match.threadId}${bindHint}.${projectHint}${replayText}`,
      ...(replay?.channelData ? { channelData: replay.channelData } : {}),
    };
  }
  if (command.isAuthorizedSender && parsedCodexCommand.type === "new") {
    await clearCodexSessionState();
    await persistCodexSessionUpdate({
      codexAutoRoute: true,
    });
    const bindingAttempt = await bindCurrentConversationToSession("codex:new");
    if (!bindingAttempt.ok) {
      typing.cleanup();
      return {
        text: `⚠️ ${bindingAttempt.error}`,
      };
    }
    if (!parsedCodexCommand.task) {
      typing.cleanup();
      return {
        text: [
          "✅ Started a fresh Codex session binding for this topic.",
          "Bootstrap mode is ask-then-apply (no implicit worktree/branch/env mutation).",
          "",
          "Next step options:",
          "1. Run `/codex oneshot <task>` directly.",
          "2. Run `/codex new <task>` with setup intent in the task text.",
          "",
          "Suggested bootstrap prompt:",
          '- "Before coding, ask me to confirm cwd, branch/worktree, and env changes."',
        ].join("\n"),
      };
    }
  }
  if (
    command.isAuthorizedSender &&
    isAgentNewCommand(command.commandBodyNormalized) &&
    sessionEntry
  ) {
    await clearCodexSessionState();
    typing.cleanup();
    return {
      text: "✅ Reset Codex App Server thread binding for this session. Next message starts a new thread.",
    };
  }
  const sessionIdFinal = sessionId ?? crypto.randomUUID();
  const sessionFile = resolveSessionFilePath(
    sessionIdFinal,
    sessionEntry,
    resolveSessionFilePathOptions({ agentId, storePath }),
  );
  let codexRelayContext: string | undefined;
  let codexDirectReply: ReplyPayload | undefined;
  if (codexCommandPrompt) {
    const boundCodexProjectKey = sessionEntry?.codexProjectKey?.trim();
    const codexWorkspaceFallback = boundCodexProjectKey || workspaceDir;
    const codexWorkspaceDir = shouldAutoRouteToCodex
      ? codexWorkspaceFallback
      : resolveCodexWorkspaceDirFromPrompt(codexCommandPrompt, codexWorkspaceFallback);
    try {
      log.info("dispatching /codex task to App Server", {
        workspaceDir: codexWorkspaceDir,
        hasExistingThread: Boolean(sessionEntry?.codexThreadId),
      });
      await typing.startTypingLoop();
      typing.refreshTypingTtl();
      let lastCodexTypingPulseAt = 0;
      const pulseCodexTyping = async () => {
        const now = Date.now();
        if (now - lastCodexTypingPulseAt < 2_500) {
          return;
        }
        lastCodexTypingPulseAt = now;
        try {
          await opts?.onReplyStart?.();
        } catch (err) {
          log.debug("codex typing pulse failed", {
            error: String(err),
          });
        }
        typing.refreshTypingTtl();
      };
      const codexProgress = createCodexProgressEmitter({
        emit: async (text) => {
          await pulseCodexTyping();
          typing.refreshTypingTtl();
          await opts?.onToolResult?.({
            text,
            channelData: { forceToolSummary: true },
          });
        },
        minEmitChars: 320,
        maxEmitChars: 1_600,
        minEmitIntervalMs: 5_000,
      });
      await opts?.onToolResult?.({
        text: "Running Codex App Server...",
        channelData: { forceToolSummary: true },
      });
      const existingThreadId =
        sessionEntry?.codexProjectKey && sessionEntry.codexProjectKey !== codexWorkspaceDir
          ? undefined
          : sessionEntry?.codexThreadId;
      const updatePendingInput = async (
        pending: {
          requestId: string;
          options: string[];
          expiresAt: number;
        } | null,
      ) => {
        if (!sessionEntry || !sessionStore || !sessionKey) {
          return;
        }
        sessionEntry.pendingUserInputRequestId = pending?.requestId;
        sessionEntry.pendingUserInputOptions = pending?.options;
        sessionEntry.pendingUserInputExpiresAt = pending?.expiresAt;
        sessionEntry.updatedAt = Date.now();
        sessionStore[sessionKey] = sessionEntry;
        if (storePath) {
          await updateSessionStore(storePath, (store) => {
            store[sessionKey] = sessionEntry;
          });
        }
      };

      const codexResult = await runCodexAppServerAgent({
        sessionId: sessionIdFinal,
        sessionKey,
        prompt: codexCommandPrompt,
        workspaceDir: codexWorkspaceDir,
        config: cfg,
        timeoutMs,
        runId: crypto.randomUUID(),
        existingThreadId,
        onPartialReply: async (payload) => {
          const text = payload.text;
          if (!text) {
            return;
          }
          await pulseCodexTyping();
          typing.refreshTypingTtl();
          await codexProgress.push(text);
        },
        onToolResult: async (payload) => {
          const text = payload.text?.trim();
          if (!text) {
            return;
          }
          await pulseCodexTyping();
          typing.refreshTypingTtl();
          // Ensure short buffered partial deltas are delivered before prompting for
          // approvals or other tool-result notices.
          await codexProgress.flush(true);
          const codexInputButtons = buildCodexInputButtons({
            text,
            requestId: sessionEntry?.pendingUserInputRequestId,
            options: sessionEntry?.pendingUserInputOptions,
          });
          await opts?.onToolResult?.({
            text,
            channelData: {
              forceToolSummary: true,
              ...(codexInputButtons ? { telegram: { buttons: codexInputButtons } } : {}),
            },
          });
        },
        onPendingUserInput: async (pending) => {
          await updatePendingInput(pending ?? null);
        },
      });
      await codexProgress.flush(true);

      const codexText = (codexResult.payloads ?? [])
        .map((payload) => payload.text?.trim() ?? "")
        .filter(Boolean)
        .join("\n\n")
        .trim();
      log.info("completed /codex task from App Server", {
        payloadCount: codexResult.payloads?.length ?? 0,
        hasText: Boolean(codexText),
        threadId: codexResult.meta.agentMeta?.sessionId ?? null,
        runId: codexResult.meta.agentMeta?.runId ?? null,
      });
      codexRelayContext = truncateCodexContext(codexText || "(no text output)");
      const codexThreadId = codexResult.meta.agentMeta?.sessionId?.trim();
      const codexRunId = codexResult.meta.agentMeta?.runId?.trim();
      const hasPendingCodexInput =
        Boolean(sessionEntry?.pendingUserInputRequestId) &&
        (sessionEntry?.pendingUserInputExpiresAt == null ||
          sessionEntry.pendingUserInputExpiresAt > Date.now());
      if (sessionEntry && sessionStore && sessionKey) {
        sessionEntry.codexThreadId = codexThreadId || sessionEntry.codexThreadId;
        sessionEntry.codexRunId = codexRunId || sessionEntry.codexRunId;
        sessionEntry.codexProjectKey = codexWorkspaceDir;
        if (!hasPendingCodexInput) {
          sessionEntry.pendingUserInputRequestId = undefined;
          sessionEntry.pendingUserInputOptions = undefined;
          sessionEntry.pendingUserInputExpiresAt = undefined;
        }
        sessionEntry.updatedAt = Date.now();
        sessionStore[sessionKey] = sessionEntry;
        if (storePath) {
          await updateSessionStore(storePath, (store) => {
            store[sessionKey] = sessionEntry;
          });
        }
      }
      if (shouldAutoRouteToCodex) {
        if (codexText) {
          codexDirectReply = { text: codexText };
        } else if (hasPendingCodexInput && sessionEntry?.pendingUserInputRequestId) {
          const pendingOptions = sessionEntry.pendingUserInputOptions;
          const promptText = `🧭 Agent input requested (${sessionEntry.pendingUserInputRequestId})`;
          const buttons =
            command.channel === "telegram"
              ? buildCodexInputButtons({
                  text: promptText,
                  requestId: sessionEntry.pendingUserInputRequestId,
                  options: pendingOptions,
                })
              : undefined;
          codexDirectReply = {
            text: `${promptText}\nReply with an option number or free-form text.`,
            ...(buttons ? { channelData: { telegram: { buttons } } } : {}),
          };
        } else {
          codexDirectReply = { text: "(Codex run completed with no text output.)" };
        }
      }
      prefixedCommandBody = [
        "[You requested a Codex App Server run. Use its output as high-confidence coding context.]",
        `[Codex App Server Output]\n${codexRelayContext}`,
        `[User Request]\n${codexCommandPrompt}`,
      ].join("\n\n");
      effectiveBaseBody = codexCommandPrompt;
    } catch (err) {
      const errText = String(err);
      if (
        sessionEntry &&
        sessionStore &&
        sessionKey &&
        /conversation not found|thread not found/i.test(errText)
      ) {
        const isBoundCodexSession = sessionEntry.codexAutoRoute === true;
        if (isBoundCodexSession) {
          log.warn(
            "codex bound thread lookup failed; preserving binding state for operator recovery",
            {
              sessionKey,
              workspaceDir: codexWorkspaceDir,
              boundThreadId: sessionEntry.codexThreadId,
            },
          );
        } else {
          await clearCodexSessionState({
            keepAutoRoute: false,
          });
          log.warn("cleared stale codex thread binding after not-found error", {
            sessionKey,
            workspaceDir: codexWorkspaceDir,
          });
        }
      }
      typing.cleanup();
      log.error("failed /codex App Server run", {
        error: errText,
      });
      const notFoundHint =
        /conversation not found|thread not found/i.test(errText) &&
        sessionEntry?.codexAutoRoute === true
          ? "\nBinding was kept. Verify with `/codex status`, then reattach with `/codex resume <thread-id>` or `/codex bind <thread-id>`."
          : "";
      return {
        text: `Codex App Server run failed: ${errText}${notFoundHint}`,
      };
    }
  }
  if (codexDirectReply) {
    typing.cleanup();
    return codexDirectReply;
  }
  // Use bodyWithEvents (events prepended, but no session hints / untrusted context) so
  // deferred turns receive system events while keeping the same scope as effectiveBaseBody did.
  const queueBodyBase = [threadContextNote, bodyWithEvents].filter(Boolean).join("\n\n");
  let queuedBody = mediaNote
    ? [mediaNote, mediaReplyHint, queueBodyBase].filter(Boolean).join("\n").trim()
    : queueBodyBase;
  if (codexRelayContext) {
    queuedBody = [queuedBody, `[Codex App Server Output]\n${codexRelayContext}`]
      .filter(Boolean)
      .join("\n\n");
  }
  const resolvedQueue = resolveQueueSettings({
    cfg,
    channel: sessionCtx.Provider,
    sessionEntry,
    inlineMode: perMessageQueueMode,
    inlineOptions: perMessageQueueOptions,
  });
  const isTelegramSession =
    sessionCtx.Provider?.trim().toLowerCase() === "telegram" ||
    ctx.OriginatingChannel?.trim().toLowerCase() === "telegram";
  const hasPendingCodexInput =
    Boolean(sessionEntry?.pendingUserInputRequestId) &&
    (sessionEntry?.pendingUserInputExpiresAt == null ||
      sessionEntry.pendingUserInputExpiresAt > Date.now());
  const effectiveQueue =
    (isCodexAppServerProvider(provider, cfg) || codexCommandPrompt !== null) &&
    isTelegramSession &&
    resolvedQueue.mode === "collect"
      ? { ...resolvedQueue, mode: "steer" as const }
      : hasPendingCodexInput && resolvedQueue.mode !== "interrupt"
        ? { ...resolvedQueue, mode: "steer" as const }
        : resolvedQueue;
  const sessionLaneKey = resolveEmbeddedSessionLane(sessionKey ?? sessionIdFinal);
  const laneSize = getQueueSize(sessionLaneKey);
  if (effectiveQueue.mode === "interrupt" && laneSize > 0) {
    const cleared = clearCommandLane(sessionLaneKey);
    const aborted = abortAgentRun(sessionIdFinal);
    logVerbose(`Interrupting ${sessionLaneKey} (cleared ${cleared}, aborted=${aborted})`);
  }
  const queueKey = sessionKey ?? sessionIdFinal;
  const isActive = isAgentRunActive(sessionIdFinal);
  const isStreaming = isAgentRunStreaming(sessionIdFinal);
  const shouldSteer = effectiveQueue.mode === "steer" || effectiveQueue.mode === "steer-backlog";
  const shouldFollowup =
    effectiveQueue.mode === "followup" ||
    effectiveQueue.mode === "collect" ||
    effectiveQueue.mode === "steer-backlog";
  const authProfileId = await resolveSessionAuthProfileOverride({
    cfg,
    provider,
    agentDir,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    isNewSession,
  });
  const authProfileIdSource = sessionEntry?.authProfileOverrideSource;
  const followupRun = {
    prompt: queuedBody,
    messageId: sessionCtx.MessageSidFull ?? sessionCtx.MessageSid,
    summaryLine: baseBodyTrimmedRaw,
    enqueuedAt: Date.now(),
    // Originating channel for reply routing.
    originatingChannel: ctx.OriginatingChannel,
    originatingTo: ctx.OriginatingTo,
    originatingAccountId: ctx.AccountId,
    originatingThreadId: ctx.MessageThreadId,
    originatingChatType: ctx.ChatType,
    run: {
      agentId,
      agentDir,
      sessionId: sessionIdFinal,
      sessionKey,
      messageProvider: resolveOriginMessageProvider({
        originatingChannel: ctx.OriginatingChannel ?? sessionCtx.OriginatingChannel,
        // Prefer Provider over Surface for fallback channel identity.
        // Surface can carry relayed metadata (for example "webchat") while Provider
        // still reflects the active channel that should own tool routing.
        provider: ctx.Provider ?? ctx.Surface ?? sessionCtx.Provider,
      }),
      agentAccountId: sessionCtx.AccountId,
      groupId: resolveGroupSessionKey(sessionCtx)?.id ?? undefined,
      groupChannel: sessionCtx.GroupChannel?.trim() ?? sessionCtx.GroupSubject?.trim(),
      groupSpace: sessionCtx.GroupSpace?.trim() ?? undefined,
      senderId: sessionCtx.SenderId?.trim() || undefined,
      senderName: sessionCtx.SenderName?.trim() || undefined,
      senderUsername: sessionCtx.SenderUsername?.trim() || undefined,
      senderE164: sessionCtx.SenderE164?.trim() || undefined,
      senderIsOwner: command.senderIsOwner,
      sessionFile,
      workspaceDir,
      config: cfg,
      skillsSnapshot,
      provider,
      model,
      disableTools: Boolean(codexCommandPrompt),
      authProfileId,
      authProfileIdSource,
      thinkLevel: resolvedThinkLevel,
      verboseLevel: resolvedVerboseLevel,
      reasoningLevel: resolvedReasoningLevel,
      elevatedLevel: resolvedElevatedLevel,
      execOverrides,
      bashElevated: {
        enabled: elevatedEnabled,
        allowed: elevatedAllowed,
        defaultLevel: resolvedElevatedLevel ?? "off",
      },
      timeoutMs,
      blockReplyBreak: resolvedBlockStreamingBreak,
      ownerNumbers: command.ownerList.length > 0 ? command.ownerList : undefined,
      extraSystemPrompt: extraSystemPromptParts.join("\n\n") || undefined,
      ...(isReasoningTagProvider(provider) ? { enforceFinalTag: true } : {}),
    },
  };

  return runReplyAgent({
    commandBody: prefixedCommandBody,
    followupRun,
    queueKey,
    resolvedQueue: effectiveQueue,
    shouldSteer,
    shouldFollowup,
    isActive,
    isStreaming,
    opts,
    typing,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    defaultModel,
    agentCfgContextTokens: agentCfg?.contextTokens,
    resolvedVerboseLevel: resolvedVerboseLevel ?? "off",
    isNewSession,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    sessionCtx,
    shouldInjectGroupIntro,
    typingMode,
  });
}
