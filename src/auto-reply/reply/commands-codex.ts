import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Bot } from "grammy";
import { buildCodexBoundSessionKey } from "../../agents/codex-app-server-bindings.js";
import {
  CODEX_BUILT_IN_MIRRORED_COMMANDS,
  getCodexBuiltInMirroredCommandCount,
} from "../../agents/codex-app-server-mirror-commands.js";
import {
  buildCodexPendingInputButtons,
  buildCodexPendingUserInputActions,
  describeCodexPendingInputAction,
  type CodexPendingUserInputAction,
} from "../../agents/codex-app-server-pending-input.js";
import {
  buildCodexPlanActionCallbackData,
  type CodexPlanAction,
} from "../../agents/codex-app-server-plan-actions.js";
import {
  buildCodexReviewActionCallbackData,
  type CodexReviewAction,
} from "../../agents/codex-app-server-review-actions.js";
import {
  discoverCodexAppServerThreads,
  startCodexAppServerThreadCompaction,
  runCodexAppServerAgent,
  startCodexAppServerReview,
  readCodexAppServerAccount,
  readCodexAppServerExperimentalFeatures,
  readCodexAppServerMcpServers,
  readCodexAppServerModels,
  readCodexAppServerRateLimits,
  readCodexAppServerSkills,
  readCodexAppServerThreadState,
  setCodexAppServerThreadName,
  setCodexAppServerThreadServiceTier,
  isCodexAppServerProvider,
  readCodexAppServerThreadContext,
  type CodexAppServerAccountSummary,
  type CodexAppServerExperimentalFeatureSummary,
  type CodexAppServerMcpServerSummary,
  type CodexAppServerPlanArtifact,
  type CodexAppServerRateLimitSummary,
  type CodexAppServerSkillSummary,
  type CodexAppServerThreadState,
  type CodexAppServerCollaborationMode,
  type PendingCodexUserInputState,
  type CodexAppServerThreadSummary,
} from "../../agents/codex-app-server-runner.js";
import { interruptCodexAppServerRunBySessionKey } from "../../agents/codex-app-server-runs.js";
import {
  getCodexAppServerAvailabilityError,
  getCodexAppServerRuntimeStatus,
} from "../../agents/codex-app-server-startup.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../../channels/thread-bindings-messages.js";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "../../channels/thread-bindings-policy.js";
import { loadSessionStore, updateSessionStore } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { resolveTelegramAccount } from "../../telegram/accounts.js";
import { buildTypingThreadParams } from "../../telegram/bot/helpers.js";
import { createTelegramSendChatActionHandler } from "../../telegram/sendchataction-401-backoff.js";
import { parseTelegramTarget } from "../../telegram/targets.js";
import { shortenHomePath } from "../../utils.js";
import type { ReplyPayload } from "../types.js";
import { resolveAcpCommandBindingContext } from "./commands-acp/context.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";

const COMMAND = "/codex";
const MIRRORED_COMMAND = "/codex_";
const BUILT_IN_MIRRORED_BASE_NAMES: ReadonlySet<string> = new Set(
  CODEX_BUILT_IN_MIRRORED_COMMANDS.map((command) => command.baseName),
);

type CodexAction = "new" | "spawn" | "join" | "steer" | "status" | "detach" | "list" | "help";

type SessionMutation = {
  providerOverride?: string;
  modelOverride?: string;
  codexThreadId?: string;
  codexProjectKey?: string;
  codexServiceTier?: string;
  codexAutoRoute?: boolean;
  pendingUserInputRequestId?: string;
  pendingUserInputOptions?: string[];
  pendingUserInputActions?: CodexPendingUserInputAction[];
  pendingUserInputExpiresAt?: number;
  pendingUserInputPromptText?: string;
  pendingUserInputMethod?: string;
  pendingUserInputAwaitingSteer?: boolean;
  codexReviewActionRequestId?: string;
  codexReviewActions?: CodexReviewAction[];
  codexPlanPromptRequestId?: string;
};

type CodexPlanPromptAction = {
  action: CodexPlanAction;
  label: string;
};

type CodexPlanDelivery = {
  payloads: ReplyPayload[];
  promptRequestId: string;
  attachmentFallbackText?: string;
};

type CodexTargetSession = {
  sessionKey: string;
  sessionEntry?: HandleCommandsParams["sessionEntry"];
  createdBinding: boolean;
  boundConversation: boolean;
  isCurrentSession: boolean;
};

function stopWithText(text: string): CommandHandlerResult {
  return {
    shouldContinue: false,
    reply: { text },
  };
}

function continueWithPrompt(params: HandleCommandsParams, prompt: string): CommandHandlerResult {
  const trimmed = prompt.trim();
  const mutableCtx = params.ctx as Record<string, unknown>;
  mutableCtx.Body = trimmed;
  mutableCtx.RawBody = trimmed;
  mutableCtx.CommandBody = trimmed;
  mutableCtx.BodyForCommands = trimmed;
  mutableCtx.BodyForAgent = trimmed;
  mutableCtx.BodyStripped = trimmed;
  if (params.rootCtx && params.rootCtx !== params.ctx) {
    const mutableRoot = params.rootCtx as Record<string, unknown>;
    mutableRoot.Body = trimmed;
    mutableRoot.RawBody = trimmed;
    mutableRoot.CommandBody = trimmed;
    mutableRoot.BodyForCommands = trimmed;
    mutableRoot.BodyForAgent = trimmed;
    mutableRoot.BodyStripped = trimmed;
  }
  return { shouldContinue: true };
}

function resolveHelpText(): string {
  return [
    "/codex new [--cwd <path>] [prompt]",
    "/codex join <thread-id-or-filter>",
    "/codex steer <instruction>",
    "/codex status",
    "/codex detach",
    "/codex list [--cwd[=<path>]|-C [path]] [filter]",
    "/codex_model [input]",
    "/codex_fast",
    "/codex_permissions [input]",
    "/codex_experimental [input]",
    "/codex_skills [input]",
    "/codex_plan [input]",
    "/codex_review [input]",
    "/codex_stop",
    "/codex_status",
    "/codex_rename [input]",
    "/codex_init [input]",
    "/codex_compact [input]",
    "/codex_diff [input]",
    "/codex_mcp [input]",
  ].join("\n");
}

function normalizeCodexOptionDashes(text: string): string {
  return text.replace(/[\u2010-\u2015\u2212]/g, "-");
}

function parseCodexRenameArguments(argsText: string): { name: string; syncTopic: boolean } | null {
  const normalized = normalizeCodexOptionDashes(argsText).trim();
  if (!normalized) {
    return null;
  }
  const tokens = normalized.split(/\s+/).filter(Boolean);
  let syncTopic = false;
  const nameTokens: string[] = [];
  for (const token of tokens) {
    if (token === "--sync" || token === "-sync") {
      syncTopic = true;
      continue;
    }
    nameTokens.push(token);
  }
  const name = nameTokens.join(" ").trim();
  if (!name) {
    return null;
  }
  return { name, syncTopic };
}

function buildPendingInputReplay(entry: HandleCommandsParams["sessionEntry"]): string | undefined {
  const requestId = entry?.pendingUserInputRequestId?.trim();
  if (!requestId) {
    return undefined;
  }
  const lines = [`Pending Codex input: ${requestId}`];
  const promptText = entry?.pendingUserInputPromptText?.trim();
  if (promptText) {
    lines.push(promptText);
  }
  const actions = entry?.pendingUserInputActions?.filter(Boolean) ?? [];
  const resolvedActions =
    actions.length > 0
      ? actions
      : buildCodexPendingUserInputActions({
          method: entry?.pendingUserInputMethod,
          options: entry?.pendingUserInputOptions,
        });
  if (resolvedActions.length > 0) {
    const numberedActions = resolvedActions.filter((action) => action.kind !== "steer");
    lines.push("", "Choices:");
    numberedActions.forEach((action, index) => {
      lines.push(`${index + 1}. ${describeCodexPendingInputAction(action)}`);
    });
    if (resolvedActions.some((action) => action.kind === "steer")) {
      lines.push("", "Or reply with free text to tell Codex what to do instead.");
    }
  } else {
    const options = entry?.pendingUserInputOptions?.filter(Boolean) ?? [];
    if (options.length > 0) {
      lines.push("", "Options:");
      options.forEach((option, index) => {
        lines.push(`${index + 1}. ${option}`);
      });
    }
  }
  if (entry?.pendingUserInputAwaitingSteer) {
    lines.push("", "Waiting for you to tell Codex what to do instead.");
  }
  if (typeof entry?.pendingUserInputExpiresAt === "number") {
    const seconds = Math.max(0, Math.round((entry.pendingUserInputExpiresAt - Date.now()) / 1000));
    lines.push(`Expires in: ${seconds}s`);
  }
  return lines.join("\n");
}

function buildPendingInputChannelData(
  params: HandleCommandsParams,
  entry: HandleCommandsParams["sessionEntry"],
): Record<string, unknown> | undefined {
  if (params.command.surface !== "telegram") {
    return undefined;
  }
  const requestId = entry?.pendingUserInputRequestId?.trim();
  if (!requestId) {
    return undefined;
  }
  const buttons = buildCodexPendingInputButtons({
    requestId,
    actions:
      entry?.pendingUserInputActions ??
      buildCodexPendingUserInputActions({
        method: entry?.pendingUserInputMethod,
        options: entry?.pendingUserInputOptions,
      }),
  });
  if (!buttons) {
    return undefined;
  }
  return {
    telegram: {
      buttons,
    },
  };
}

function resolveAction(tokens: string[]): CodexAction {
  const action = tokens[0]?.trim().toLowerCase();
  if (
    action === "new" ||
    action === "spawn" ||
    action === "join" ||
    action === "steer" ||
    action === "status" ||
    action === "detach" ||
    action === "list" ||
    action === "help"
  ) {
    tokens.shift();
    return action;
  }
  return "help";
}

function readOptionValue(tokens: string[], index: number, flag: string) {
  const token = tokens[index]?.trim();
  if (!token) {
    return { matched: false } as const;
  }
  if (token === flag) {
    const value = tokens[index + 1]?.trim();
    if (!value || value.startsWith("--")) {
      return { matched: true, nextIndex: index + 1, error: `${flag} requires a value` } as const;
    }
    return { matched: true, nextIndex: index + 2, value } as const;
  }
  if (token.startsWith(`${flag}=`)) {
    const value = token.slice(`${flag}=`.length).trim();
    if (!value) {
      return { matched: true, nextIndex: index + 1, error: `${flag} requires a value` } as const;
    }
    return { matched: true, nextIndex: index + 1, value } as const;
  }
  return { matched: false } as const;
}

function parseNewArguments(tokens: string[]): { cwd?: string; prompt: string } | { error: string } {
  let cwd: string | undefined;
  const promptTokens: string[] = [];
  for (let index = 0; index < tokens.length; ) {
    const cwdOption = readOptionValue(tokens, index, "--cwd");
    if (cwdOption.matched) {
      if (cwdOption.error) {
        return { error: `${cwdOption.error}. Usage: /codex new [--cwd <path>] [prompt]` };
      }
      cwd = cwdOption.value?.trim();
      index = cwdOption.nextIndex;
      continue;
    }
    promptTokens.push(tokens[index] ?? "");
    index += 1;
  }
  return {
    cwd,
    prompt: promptTokens.join(" ").trim(),
  };
}

function isLikelyPathToken(token: string): boolean {
  const value = token.trim();
  if (!value) {
    return false;
  }
  return (
    value.startsWith("/") ||
    value.startsWith("~") ||
    value.startsWith(".") ||
    value.includes("/") ||
    value.includes("\\") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

function parseListArguments(
  tokens: string[],
  defaultWorkspaceDir?: string,
): { workspaceDir?: string; filter?: string } {
  let workspaceDir: string | undefined;
  const filterTokens: string[] = [];

  for (let index = 0; index < tokens.length; ) {
    const token = tokens[index]?.trim();
    if (!token) {
      index += 1;
      continue;
    }
    const normalized = normalizeCodexOptionDashes(token).trim();
    const lower = normalized.toLowerCase();

    if (lower.startsWith("--cwd=") || lower.startsWith("-cwd=")) {
      const value = normalized.slice(normalized.indexOf("=") + 1).trim();
      workspaceDir = value || defaultWorkspaceDir;
      index += 1;
      continue;
    }

    if (lower === "--cwd" || lower === "-cwd" || lower === "-c") {
      const nextToken = tokens[index + 1]?.trim();
      if (nextToken) {
        const nextNormalized = normalizeCodexOptionDashes(nextToken).trim();
        const nextLower = nextNormalized.toLowerCase();
        const looksLikeFlag =
          nextLower === "--cwd" ||
          nextLower === "-cwd" ||
          nextLower === "-c" ||
          nextLower.startsWith("--");
        if (!looksLikeFlag && isLikelyPathToken(nextNormalized)) {
          workspaceDir = nextNormalized;
          index += 2;
          continue;
        }
      }
      workspaceDir = defaultWorkspaceDir;
      index += 1;
      continue;
    }

    filterTokens.push(token);
    index += 1;
  }

  const filter = filterTokens.join(" ").trim() || undefined;
  return {
    workspaceDir,
    filter,
  };
}

async function updateCodexSession(
  params: HandleCommandsParams,
  update: SessionMutation,
  targetSessionKey = params.sessionKey,
): Promise<void> {
  const now = Date.now();
  if (!params.storePath) {
    if (params.sessionEntry && targetSessionKey === params.sessionKey) {
      Object.assign(params.sessionEntry, update, { updatedAt: now });
    }
    return;
  }
  let nextEntry: NonNullable<HandleCommandsParams["sessionEntry"]> | undefined;
  await updateSessionStore(params.storePath, (store) => {
    const existing = store[targetSessionKey] ??
      (targetSessionKey === params.sessionKey ? params.sessionEntry : undefined) ?? {
        sessionId: crypto.randomUUID(),
        updatedAt: now,
      };
    nextEntry = {
      ...existing,
      ...update,
      updatedAt: now,
    };
    store[targetSessionKey] = nextEntry;
  });
  if (params.sessionStore && nextEntry) {
    params.sessionStore[targetSessionKey] = nextEntry;
  }
  if (targetSessionKey === params.sessionKey) {
    params.sessionEntry = nextEntry;
  }
}

function resolveStoredSessionEntry(
  params: HandleCommandsParams,
  sessionKey: string,
): HandleCommandsParams["sessionEntry"] | undefined {
  const fromMemory =
    params.sessionStore?.[sessionKey] ??
    (sessionKey === params.sessionKey ? params.sessionEntry : undefined);
  if (fromMemory) {
    return fromMemory;
  }
  if (!params.storePath) {
    return undefined;
  }
  return loadSessionStore(params.storePath)[sessionKey];
}

function applyCommandTargetSession(params: HandleCommandsParams, sessionKey: string): void {
  params.sessionKey = sessionKey;
  const mutableCtx = params.ctx as Record<string, unknown>;
  mutableCtx.CommandTargetSessionKey = sessionKey;
  mutableCtx.SessionKey = sessionKey;
  if (params.rootCtx && params.rootCtx !== params.ctx) {
    const mutableRoot = params.rootCtx as Record<string, unknown>;
    mutableRoot.CommandTargetSessionKey = sessionKey;
    mutableRoot.SessionKey = sessionKey;
  }
}

function applyExistingCodexConversationBinding(params: HandleCommandsParams): void {
  const bindingContext = resolveAcpCommandBindingContext(params);
  if (!bindingContext.conversationId) {
    return;
  }
  if (bindingContext.channel !== "telegram" && bindingContext.channel !== "discord") {
    return;
  }
  const binding = getSessionBindingService().resolveByConversation({
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    ...(bindingContext.parentConversationId
      ? { parentConversationId: bindingContext.parentConversationId }
      : {}),
  });
  const targetSessionKey = binding?.targetSessionKey?.trim();
  if (!targetSessionKey || !targetSessionKey.startsWith("agent:")) {
    return;
  }
  const boundEntry = resolveStoredSessionEntry(params, targetSessionKey);
  const providerOverride =
    typeof boundEntry?.providerOverride === "string" ? boundEntry.providerOverride : "";
  if (
    !boundEntry?.codexThreadId?.trim() &&
    !isCodexAppServerProvider(providerOverride, params.cfg)
  ) {
    return;
  }
  applyCommandTargetSession(params, targetSessionKey);
  params.sessionEntry = boundEntry;
  if (binding?.bindingId) {
    getSessionBindingService().touch(binding.bindingId);
  }
}

function resolveCodexBindingSessionLabel(params: {
  sessionKey: string;
  projectKey?: string;
}): string {
  const projectKey = params.projectKey?.trim();
  if (projectKey) {
    return `Codex ${projectKey}`;
  }
  return resolveAgentIdFromSessionKey(params.sessionKey) === "main"
    ? "Codex"
    : `Codex ${resolveAgentIdFromSessionKey(params.sessionKey)}`;
}

async function ensureCodexBoundSession(params: {
  commandParams: HandleCommandsParams;
  projectKey?: string;
}): Promise<CodexTargetSession | { error: string }> {
  const bindingContext = resolveAcpCommandBindingContext(params.commandParams);
  if (bindingContext.channel !== "telegram" && bindingContext.channel !== "discord") {
    return {
      sessionKey: params.commandParams.sessionKey,
      sessionEntry: params.commandParams.sessionEntry,
      createdBinding: false,
      boundConversation: false,
      isCurrentSession: true,
    };
  }
  if (bindingContext.channel === "discord" && !bindingContext.threadId) {
    return {
      sessionKey: params.commandParams.sessionKey,
      sessionEntry: params.commandParams.sessionEntry,
      createdBinding: false,
      boundConversation: false,
      isCurrentSession: true,
    };
  }
  if (!bindingContext.conversationId) {
    return {
      error:
        bindingContext.channel === "telegram"
          ? "Codex binding requires a Telegram DM or topic context."
          : "Codex binding requires an active Discord thread.",
    };
  }

  const targetSessionKey = buildCodexBoundSessionKey({
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    agentId:
      params.commandParams.agentId ?? resolveAgentIdFromSessionKey(params.commandParams.sessionKey),
  });
  const existingEntry = resolveStoredSessionEntry(params.commandParams, targetSessionKey);
  const wasCurrentSession = targetSessionKey === params.commandParams.sessionKey;

  const bindingService = getSessionBindingService();
  const existingBinding = bindingService.resolveByConversation({
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    ...(bindingContext.parentConversationId
      ? { parentConversationId: bindingContext.parentConversationId }
      : {}),
  });
  if (existingBinding?.targetSessionKey?.trim() === targetSessionKey) {
    bindingService.touch(existingBinding.bindingId);
    applyCommandTargetSession(params.commandParams, targetSessionKey);
    params.commandParams.sessionEntry = existingEntry;
    return {
      sessionKey: targetSessionKey,
      sessionEntry: existingEntry,
      createdBinding: false,
      boundConversation: true,
      isCurrentSession: wasCurrentSession,
    };
  }

  const capabilities = bindingService.getCapabilities({
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
  });
  if (!capabilities.adapterAvailable || !capabilities.bindSupported) {
    return {
      error: `Codex conversation bindings are unavailable for ${bindingContext.channel}.`,
    };
  }
  if (!capabilities.placements.includes("current")) {
    return {
      error: `Codex conversation bindings do not support the current ${bindingContext.channel} conversation.`,
    };
  }

  const senderId = params.commandParams.command.senderId?.trim() || "";
  const boundBy =
    typeof existingBinding?.metadata?.boundBy === "string"
      ? existingBinding.metadata.boundBy.trim()
      : "";
  if (existingBinding && boundBy && boundBy !== "system" && senderId && senderId !== boundBy) {
    const noun = bindingContext.channel === "telegram" ? "conversation" : "thread";
    return {
      error: `Only ${boundBy} can rebind this ${noun}.`,
    };
  }

  const label = resolveCodexBindingSessionLabel({
    sessionKey: targetSessionKey,
    projectKey: params.projectKey,
  });
  const binding = await bindingService.bind({
    targetSessionKey,
    targetKind: "session",
    conversation: {
      channel: bindingContext.channel,
      accountId: bindingContext.accountId,
      conversationId: bindingContext.conversationId,
      ...(bindingContext.parentConversationId
        ? { parentConversationId: bindingContext.parentConversationId }
        : {}),
    },
    placement: "current",
    metadata: {
      threadName: resolveThreadBindingThreadName({
        agentId: params.commandParams.agentId,
        label,
      }),
      agentId: params.commandParams.agentId,
      label,
      boundBy: senderId || "unknown",
      introText: resolveThreadBindingIntroText({
        agentId: params.commandParams.agentId,
        label,
        idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
          cfg: params.commandParams.cfg,
          channel: bindingContext.channel,
          accountId: bindingContext.accountId,
        }),
        maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
          cfg: params.commandParams.cfg,
          channel: bindingContext.channel,
          accountId: bindingContext.accountId,
        }),
        sessionCwd: params.projectKey,
      }),
      source: "codex",
    },
  });
  applyCommandTargetSession(params.commandParams, targetSessionKey);
  params.commandParams.sessionEntry = existingEntry;
  return {
    sessionKey: targetSessionKey,
    sessionEntry: existingEntry,
    createdBinding: binding.targetSessionKey.trim() === targetSessionKey,
    boundConversation: true,
    isCurrentSession: wasCurrentSession,
  };
}

async function unbindCodexConversation(params: HandleCommandsParams): Promise<void> {
  const bindingContext = resolveAcpCommandBindingContext(params);
  if (bindingContext.channel !== "telegram" && bindingContext.channel !== "discord") {
    return;
  }
  if (!bindingContext.conversationId) {
    return;
  }
  const bindingService = getSessionBindingService();
  const binding = bindingService.resolveByConversation({
    channel: bindingContext.channel,
    accountId: bindingContext.accountId,
    conversationId: bindingContext.conversationId,
    ...(bindingContext.parentConversationId
      ? { parentConversationId: bindingContext.parentConversationId }
      : {}),
  });
  if (!binding) {
    return;
  }
  await bindingService.unbind({
    bindingId: binding.bindingId,
    reason: "codex-detach",
  });
}

function summarizeThreadBinding(thread: CodexAppServerThreadSummary): string {
  const lines = [`Thread: ${thread.threadId}`];
  if (thread.title) {
    lines.push(`Title: ${thread.title}`);
  }
  if (thread.projectKey) {
    lines.push(`Project: ${thread.projectKey}`);
  }
  return lines.join("\n");
}

function buildThreadReplayPayloads(params: {
  lastUserMessage?: string;
  lastAssistantMessage?: string;
}): ReplyPayload[] {
  const payloads: ReplyPayload[] = [];
  if (params.lastUserMessage?.trim()) {
    payloads.push({ text: "Last User Request in Thread:" });
    payloads.push({ text: params.lastUserMessage.trim() });
  }
  if (params.lastAssistantMessage?.trim()) {
    payloads.push({ text: "Last Agent Reply in Thread:" });
    payloads.push({ text: params.lastAssistantMessage.trim() });
  }
  return payloads;
}

function shouldPinCodexBindingNotice(params: HandleCommandsParams): boolean {
  const bindingContext = resolveAcpCommandBindingContext(params);
  return (
    bindingContext.channel === "telegram" &&
    Boolean(bindingContext.conversationId?.includes(":topic:"))
  );
}

function resolveCodexReplyRoute(params: HandleCommandsParams): {
  channel: Parameters<typeof routeReply>[0]["channel"];
  to: string;
  accountId?: string;
  threadId?: string | number;
} | null {
  const channel = params.ctx.OriginatingChannel ?? params.command.channel;
  const to = params.ctx.OriginatingTo ?? params.command.from ?? params.command.to;
  if (!channel || !to || !isRoutableChannel(channel)) {
    return null;
  }
  return {
    channel: channel as Parameters<typeof routeReply>[0]["channel"],
    to,
    accountId: params.ctx.AccountId,
    threadId: params.ctx.MessageThreadId,
  };
}

function hasActiveCodexSession(params: HandleCommandsParams): boolean {
  return (
    Boolean(params.sessionEntry?.codexThreadId?.trim()) ||
    isCodexAppServerProvider(params.sessionEntry?.providerOverride ?? "", params.cfg)
  );
}

function resolveCodexBoundSession(
  params: HandleCommandsParams,
): { sessionKey: string; projectKey?: string } | { error: string } {
  applyExistingCodexConversationBinding(params);
  if (!hasActiveCodexSession(params)) {
    return {
      error: "Codex is not bound in this conversation. Use /codex new or /codex join first.",
    };
  }
  return {
    sessionKey: params.sessionKey,
    projectKey: params.sessionEntry?.codexProjectKey ?? params.workspaceDir,
  };
}

function resolveStoredCodexModel(entry: HandleCommandsParams["sessionEntry"]): string | undefined {
  const modelOverride = entry?.modelOverride?.trim();
  if (modelOverride) {
    return modelOverride;
  }
  const model = entry?.model?.trim();
  if (model) {
    return model;
  }
  return undefined;
}

function normalizeCodexServiceTier(value: string | undefined | null): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : undefined;
}

function formatCodexFastModeValue(value: string | undefined): string {
  const normalized = normalizeCodexServiceTier(value);
  if (!normalized) {
    return "off";
  }
  if (normalized === "fast") {
    return "on";
  }
  return normalized;
}

function formatCodexFastModeSetText(value: string | undefined): string {
  return `Fast mode set to ${formatCodexFastModeValue(value)}.`;
}

function formatCodexFastModeStatusText(value: string | undefined): string {
  return `Fast mode is ${formatCodexFastModeValue(value)}.`;
}

function parseCodexFastAction(
  argsText: string,
): "toggle" | "on" | "off" | "status" | { error: string } {
  const normalized = argsText.trim().toLowerCase();
  if (!normalized) {
    return "toggle";
  }
  if (normalized === "on" || normalized === "off" || normalized === "status") {
    return normalized;
  }
  return { error: "Usage: /codex_fast [on|off|status]" };
}

function formatCodexPermissions(params: {
  approvalPolicy?: string;
  sandbox?: string;
}): string | undefined {
  const approval = params.approvalPolicy?.trim();
  const sandbox = params.sandbox?.trim();
  if (!approval && !sandbox) {
    return undefined;
  }
  if (approval === "on-request" && sandbox === "workspace-write") {
    return "Default";
  }
  if (approval === "never" && sandbox === "danger-full-access") {
    return "Full Access";
  }
  if (approval && sandbox) {
    return `Custom (${sandbox}, ${approval})`;
  }
  return approval ?? sandbox;
}

function formatCodexAccountText(account: CodexAppServerAccountSummary | undefined): string {
  if (!account) {
    return "unknown";
  }
  if (account.type === "chatgpt" && account.email?.trim()) {
    return account.planType?.trim()
      ? `${account.email.trim()} (${account.planType.trim()})`
      : account.email.trim();
  }
  if (account.type === "apiKey") {
    return "API key";
  }
  if (account.requiresOpenaiAuth === false) {
    return "not required";
  }
  if (account.requiresOpenaiAuth === true) {
    return "not signed in";
  }
  return "unknown";
}

function formatCodexModelText(threadState: CodexAppServerThreadState | undefined): string {
  const model = threadState?.model?.trim();
  const provider = threadState?.modelProvider?.trim();
  const reasoning = threadState?.reasoningEffort?.trim();
  const parts = [
    provider && model && !model.startsWith(`${provider}/`) ? `${provider}/${model}` : model,
  ].filter(Boolean) as string[];
  if (reasoning) {
    parts.push(`reasoning ${reasoning}`);
  }
  return parts.join(" · ") || "unknown";
}

function advanceCodexResetAtToNextWindow(params: {
  resetAt: number | undefined;
  windowSeconds?: number;
  nowMs: number;
}): number | undefined {
  const resetAt = params.resetAt;
  if (!resetAt || !Number.isFinite(resetAt)) {
    return undefined;
  }
  if (
    !params.windowSeconds ||
    !Number.isFinite(params.windowSeconds) ||
    params.windowSeconds <= 0
  ) {
    return resetAt;
  }
  const windowMs = Math.round(params.windowSeconds * 1_000);
  if (windowMs <= 0 || resetAt >= params.nowMs) {
    return resetAt;
  }
  const missedWindows = Math.floor((params.nowMs - resetAt) / windowMs) + 1;
  return resetAt + missedWindows * windowMs;
}

function getCodexStatusTimeZoneLabel(): string | undefined {
  const timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone?.trim();
  return timeZone || undefined;
}

function formatCodexRateLimitReset(params: {
  resetAt: number | undefined;
  windowSeconds?: number;
  nowMs?: number;
}): string | undefined {
  const nowMs = params.nowMs ?? Date.now();
  const normalizedResetAt = advanceCodexResetAtToNextWindow({
    resetAt: params.resetAt,
    windowSeconds: params.windowSeconds,
    nowMs,
  });
  if (!normalizedResetAt || !Number.isFinite(normalizedResetAt)) {
    return undefined;
  }
  const now = new Date(nowMs);
  const date = new Date(normalizedResetAt);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  const sameDay = now.toDateString() === date.toDateString();
  if (sameDay) {
    return new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(date);
}

function formatCodexRateLimitLine(
  limit: CodexAppServerRateLimitSummary,
  nowMs = Date.now(),
): string {
  const prefix = `${limit.name}: `;
  const resetText = formatCodexRateLimitReset({
    resetAt: limit.resetAt,
    windowSeconds: limit.windowSeconds,
    nowMs,
  });
  if (typeof limit.usedPercent === "number") {
    const remaining = Math.max(0, Math.round(100 - limit.usedPercent));
    return `${prefix}${remaining}% left${resetText ? ` (resets ${resetText})` : ""}`;
  }
  if (typeof limit.remaining === "number" && typeof limit.limit === "number") {
    return `${prefix}${limit.remaining}/${limit.limit} remaining${resetText ? ` (resets ${resetText})` : ""}`;
  }
  return `${prefix}unavailable`;
}

function splitCodexRateLimitName(name: string): {
  prefix: string;
  label: string;
  labelOrder: number;
} {
  const trimmed = name.trim();
  const lower = trimmed.toLowerCase();
  if (lower.endsWith("5h limit")) {
    const prefix = trimmed.slice(0, Math.max(0, trimmed.length - "5h limit".length)).trim();
    return { prefix, label: "5h limit", labelOrder: 0 };
  }
  if (lower.endsWith("weekly limit")) {
    const prefix = trimmed.slice(0, Math.max(0, trimmed.length - "weekly limit".length)).trim();
    return { prefix, label: "Weekly limit", labelOrder: 1 };
  }
  return { prefix: "", label: trimmed, labelOrder: 99 };
}

function normalizeCodexModelKey(value: string | undefined): string {
  const trimmed = value?.trim().toLowerCase() ?? "";
  const withoutProvider = trimmed.includes("/") ? (trimmed.split("/").at(-1) ?? trimmed) : trimmed;
  return withoutProvider.replace(/[^a-z0-9]+/g, "");
}

function selectVisibleCodexRateLimits(params: {
  rateLimits: CodexAppServerRateLimitSummary[];
  currentModel?: string;
}): CodexAppServerRateLimitSummary[] {
  const currentModelKey = normalizeCodexModelKey(params.currentModel);
  return [...params.rateLimits]
    .filter((limit) => {
      const { prefix } = splitCodexRateLimitName(limit.name);
      if (!prefix) {
        return true;
      }
      if (!currentModelKey) {
        return false;
      }
      return normalizeCodexModelKey(prefix) === currentModelKey;
    })
    .toSorted((left, right) => {
      const leftName = splitCodexRateLimitName(left.name);
      const rightName = splitCodexRateLimitName(right.name);
      const leftPrefixBlank = leftName.prefix ? 1 : 0;
      const rightPrefixBlank = rightName.prefix ? 1 : 0;
      if (leftPrefixBlank !== rightPrefixBlank) {
        return leftPrefixBlank - rightPrefixBlank;
      }
      const prefixCompare = leftName.prefix.localeCompare(rightName.prefix);
      if (prefixCompare !== 0) {
        return prefixCompare;
      }
      if (leftName.labelOrder !== rightName.labelOrder) {
        return leftName.labelOrder - rightName.labelOrder;
      }
      return left.name.localeCompare(right.name);
    });
}

function formatCodexMirroredStatusText(params: {
  threadState?: CodexAppServerThreadState;
  account?: CodexAppServerAccountSummary;
  rateLimits: CodexAppServerRateLimitSummary[];
  entry: HandleCommandsParams["sessionEntry"];
  errors: string[];
  projectFolder?: string;
}): string {
  const lines = ["OpenAI Codex"];
  if (params.threadState?.threadName?.trim()) {
    lines.push(`Thread: ${params.threadState.threadName.trim()}`);
  }
  lines.push(`Model: ${formatCodexModelText(params.threadState)}`);
  lines.push(`Project folder: ${params.projectFolder ?? "unknown"}`);
  lines.push(
    `Worktree folder: ${shortenHomePath(
      params.threadState?.cwd?.trim() || params.entry?.codexProjectKey?.trim() || "unknown",
    )}`,
  );
  lines.push(
    `Fast mode: ${formatCodexFastModeValue(
      params.threadState?.serviceTier ?? params.entry?.codexServiceTier,
    )}`,
  );
  const permissions = formatCodexPermissions({
    approvalPolicy: params.threadState?.approvalPolicy,
    sandbox: params.threadState?.sandbox,
  });
  if (permissions) {
    lines.push(`Permissions: ${permissions}`);
  }
  lines.push(`Account: ${formatCodexAccountText(params.account)}`);
  lines.push(
    `Session: ${params.threadState?.threadId?.trim() || params.entry?.codexThreadId?.trim() || "unknown"}`,
  );
  const visibleRateLimits = selectVisibleCodexRateLimits({
    rateLimits: params.rateLimits,
    currentModel: params.threadState?.model,
  });
  if (visibleRateLimits.length > 0) {
    const timeZoneLabel = getCodexStatusTimeZoneLabel();
    lines.push("");
    if (timeZoneLabel) {
      lines.push(`Rate limits timezone: ${timeZoneLabel}`);
    }
    for (const limit of visibleRateLimits) {
      lines.push(formatCodexRateLimitLine(limit));
    }
  }
  if (params.errors.length > 0) {
    lines.push("");
    for (const error of params.errors) {
      lines.push(`Status note: ${error}`);
    }
  }
  return lines.join("\n");
}

async function resolveCodexProjectFolder(worktreeFolder?: string): Promise<string | undefined> {
  const cwd = worktreeFolder?.trim();
  if (!cwd) {
    return undefined;
  }
  try {
    const result = await runCommandWithTimeout(
      ["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { timeoutMs: 5_000, cwd },
    );
    if (result.code !== 0) {
      return shortenHomePath(cwd);
    }
    const commonDir = result.stdout.trim();
    if (!commonDir) {
      return shortenHomePath(cwd);
    }
    return shortenHomePath(path.dirname(commonDir));
  } catch {
    return shortenHomePath(cwd);
  }
}

function formatModelSummaryLines(params: {
  currentModel?: string;
  models: Awaited<ReturnType<typeof readCodexAppServerModels>>;
}): string[] {
  const lines = [`Current model: ${params.currentModel ?? "unknown"}`];
  if (params.models.length === 0) {
    lines.push("Available models: unavailable");
    return lines;
  }
  lines.push("Available models:");
  for (const model of params.models.slice(0, 10)) {
    const parts = [model.id];
    if (model.label && model.label !== model.id) {
      parts.push(model.label);
    }
    if (model.current) {
      parts.push("current");
    }
    lines.push(`- ${parts.join(" · ")}`);
  }
  if (params.models.length > 10) {
    lines.push(`- …and ${params.models.length - 10} more`);
  }
  return lines;
}

function formatCodexSkillSummaryLines(params: {
  workspaceDir: string;
  skills: CodexAppServerSkillSummary[];
  filter?: string;
}): string[] {
  const filter = params.filter?.trim().toLowerCase();
  const skills = filter
    ? params.skills.filter((skill) => {
        const haystack = [skill.name, skill.description, skill.cwd].filter(Boolean).join("\n");
        return haystack.toLowerCase().includes(filter);
      })
    : params.skills;
  const lines = [`Codex skills for ${params.workspaceDir}:`];
  if (skills.length === 0) {
    lines.push(
      filter ? `No Codex skills matched "${params.filter?.trim()}".` : "No Codex skills found.",
    );
    return lines;
  }
  for (const skill of skills.slice(0, 20)) {
    const suffix = skill.description?.trim() ? ` - ${skill.description.trim()}` : "";
    const state =
      skill.enabled === false ? " (disabled)" : skill.enabled === true ? "" : " (status unknown)";
    lines.push(`- ${skill.name}${state}${suffix}`);
  }
  if (skills.length > 20) {
    lines.push(`- …and ${skills.length - 20} more`);
  }
  return lines;
}

function formatCodexExperimentalFeatureLines(params: {
  features: CodexAppServerExperimentalFeatureSummary[];
  filter?: string;
}): string[] {
  const filter = params.filter?.trim().toLowerCase();
  const features = filter
    ? params.features.filter((feature) => {
        const haystack = [feature.name, feature.displayName, feature.description, feature.stage]
          .filter(Boolean)
          .join("\n");
        return haystack.toLowerCase().includes(filter);
      })
    : params.features;
  const lines = ["Codex experimental features:"];
  if (features.length === 0) {
    lines.push(
      filter
        ? `No experimental features matched "${params.filter?.trim()}".`
        : "No experimental features reported.",
    );
    return lines;
  }
  for (const feature of features.slice(0, 20)) {
    const bits = [
      feature.name,
      feature.stage ? `stage=${feature.stage}` : undefined,
      feature.enabled === true ? "enabled" : feature.enabled === false ? "disabled" : undefined,
      feature.defaultEnabled === true
        ? "default-on"
        : feature.defaultEnabled === false
          ? "default-off"
          : undefined,
    ].filter(Boolean);
    const description = feature.displayName ?? feature.description;
    lines.push(`- ${bits.join(" · ")}${description ? ` - ${description}` : ""}`);
  }
  if (features.length > 20) {
    lines.push(`- …and ${features.length - 20} more`);
  }
  return lines;
}

function formatCodexMcpServerLines(params: {
  servers: CodexAppServerMcpServerSummary[];
  filter?: string;
}): string[] {
  const filter = params.filter?.trim().toLowerCase();
  const servers = filter
    ? params.servers.filter((server) => {
        const haystack = [server.name, server.authStatus].filter(Boolean).join("\n");
        return haystack.toLowerCase().includes(filter);
      })
    : params.servers;
  const lines = ["Codex MCP servers:"];
  if (servers.length === 0) {
    lines.push(
      filter ? `No MCP servers matched "${params.filter?.trim()}".` : "No MCP servers reported.",
    );
    return lines;
  }
  for (const server of servers.slice(0, 20)) {
    const details = [
      server.authStatus ? `auth=${server.authStatus}` : undefined,
      `tools=${server.toolCount}`,
      `resources=${server.resourceCount}`,
      `templates=${server.resourceTemplateCount}`,
    ].filter(Boolean);
    lines.push(`- ${server.name} · ${details.join(" · ")}`);
  }
  if (servers.length > 20) {
    lines.push(`- …and ${servers.length - 20} more`);
  }
  return lines;
}

type ParsedCodexReviewFinding = {
  priorityLabel?: string;
  title: string;
  location?: string;
  body?: string;
};

type ParsedCodexReviewOutput = {
  summary?: string;
  findings: ParsedCodexReviewFinding[];
};

function parseCodexReviewOutput(reviewText: string): ParsedCodexReviewOutput {
  const normalized = reviewText.replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return { findings: [] };
  }
  const lines = normalized.split("\n");
  const markerIndex = lines.findIndex(
    (line) => line.trim() === "Review comment:" || line.trim() === "Full review comments:",
  );
  const summary =
    markerIndex <= 0 ? undefined : lines.slice(0, markerIndex).join("\n").trim() || undefined;
  const findingLines = markerIndex >= 0 ? lines.slice(markerIndex + 1) : lines;
  const findings: ParsedCodexReviewFinding[] = [];
  let current: ParsedCodexReviewFinding | null = null;
  for (const rawLine of findingLines) {
    const line = rawLine.trimEnd();
    const findingMatch = line.match(/^- (?:\[[x ]\] )?(?<title>.+?)(?:\s+—\s+(?<location>.+))?$/);
    if (findingMatch?.groups?.title) {
      if (current) {
        findings.push(current);
      }
      const rawTitle = findingMatch.groups.title.trim();
      const priorityMatch = rawTitle.match(/^\[(P\d)\]\s*(.+)$/i);
      current = {
        priorityLabel: priorityMatch?.[1]?.toUpperCase(),
        title: (priorityMatch?.[2] ?? rawTitle).trim(),
        location: findingMatch.groups.location?.trim() || undefined,
      };
      continue;
    }
    if (!current) {
      continue;
    }
    const bodyLine = line.replace(/^\s{2}/, "").trimEnd();
    current.body = current.body ? `${current.body}\n${bodyLine}` : bodyLine;
  }
  if (current) {
    findings.push(current);
  }
  return {
    summary,
    findings,
  };
}

function formatCodexReviewFindingMessage(params: {
  finding: ParsedCodexReviewFinding;
  index: number;
}): string {
  const heading = params.finding.priorityLabel ?? `Finding ${params.index + 1}`;
  const lines = [heading, params.finding.title];
  if (params.finding.location) {
    lines.push(`Location: ${params.finding.location}`);
  }
  if (params.finding.body?.trim()) {
    lines.push("", params.finding.body.trim());
  }
  return lines.join("\n");
}

function buildCodexReviewActionPrompt(params: {
  finding: ParsedCodexReviewFinding;
  index: number;
}): string {
  return [
    "Please implement this Codex review finding:",
    "",
    formatCodexReviewFindingMessage(params),
  ].join("\n");
}

function buildCodexReviewAllActionPrompt(findings: ParsedCodexReviewFinding[]): string {
  const lines = ["Please implement fixes for all of these Codex review findings:", ""];
  findings.forEach((finding, index) => {
    lines.push(
      `${index + 1}. ${finding.priorityLabel ? `[${finding.priorityLabel}] ` : ""}${finding.title}`,
    );
    if (finding.location) {
      lines.push(`   ${finding.location}`);
    }
    if (finding.body?.trim()) {
      for (const bodyLine of finding.body.trim().split("\n")) {
        lines.push(`   ${bodyLine}`);
      }
    }
  });
  return lines.join("\n");
}

function buildCodexReviewActions(findings: ParsedCodexReviewFinding[]): CodexReviewAction[] {
  const singleActions = findings.slice(0, 6).map((finding, index) => ({
    label: finding.priorityLabel ? `Implement ${finding.priorityLabel}` : `Implement #${index + 1}`,
    prompt: buildCodexReviewActionPrompt({ finding, index }),
  }));
  if (findings.length === 0) {
    return [];
  }
  return [
    ...singleActions,
    {
      label: "Implement All Fixes",
      prompt: buildCodexReviewAllActionPrompt(findings),
    },
  ];
}

function buildCodexReviewActionButtons(params: {
  requestId: string;
  actions: CodexReviewAction[];
}): ReadonlyArray<ReadonlyArray<{ text: string; callback_data: string }>> | undefined {
  if (params.actions.length === 0) {
    return undefined;
  }
  return params.actions.map((action, actionIndex) => [
    {
      text: action.label,
      callback_data: buildCodexReviewActionCallbackData({
        requestId: params.requestId,
        actionIndex,
      }),
    },
  ]);
}

const CODEX_PLAN_INLINE_TEXT_LIMIT = 2600;
const CODEX_PLAN_PROGRESS_DELAY_MS = 12_000;
const CODEX_DIRECT_TELEGRAM_TYPING_INTERVAL_MS = 4_500;

function buildCodexPlanPromptActions(): CodexPlanPromptAction[] {
  return [
    { action: "implement", label: "Yes, implement this plan" },
    { action: "stay", label: "No, stay in Plan mode" },
  ];
}

function buildCodexPlanPromptButtons(params: {
  requestId: string;
}): ReadonlyArray<ReadonlyArray<{ text: string; callback_data: string }>> {
  return buildCodexPlanPromptActions().map((action) => [
    {
      text: action.label,
      callback_data: buildCodexPlanActionCallbackData({
        requestId: params.requestId,
        action: action.action,
      }),
    },
  ]);
}

function formatCodexPlanSteps(steps: CodexAppServerPlanArtifact["steps"]): string | undefined {
  if (steps.length === 0) {
    return undefined;
  }
  const lines = ["Plan steps:"];
  for (const step of steps) {
    const marker =
      step.status === "completed" ? "[x]" : step.status === "inProgress" ? "[>]" : "[ ]";
    lines.push(`- ${marker} ${step.step}`);
  }
  return lines.join("\n");
}

function formatCodexPlanInlineText(plan: CodexAppServerPlanArtifact): string {
  const lines: string[] = ["Plan"];
  if (plan.explanation?.trim()) {
    lines.push("", plan.explanation.trim());
  }
  const stepsText = formatCodexPlanSteps(plan.steps);
  if (stepsText) {
    lines.push("", stepsText);
  }
  if (plan.markdown.trim()) {
    lines.push("", plan.markdown.trim());
  }
  return lines.join("\n").trim();
}

function buildCodexPlanMarkdownPreview(markdown: string, maxChars: number): string | undefined {
  const trimmed = markdown.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars).trimEnd()}\n\n[Preview truncated. Open the attachment for the full plan.]`;
}

async function buildCodexPlanDelivery(
  plan: CodexAppServerPlanArtifact,
): Promise<CodexPlanDelivery> {
  const promptRequestId = crypto.randomUUID();
  const promptButtons = buildCodexPlanPromptButtons({ requestId: promptRequestId });
  const inlineText = formatCodexPlanInlineText(plan);
  const promptPayload: ReplyPayload = {
    text: "Implement this plan?",
    channelData: { telegram: { buttons: promptButtons } },
  };
  if (inlineText.length <= CODEX_PLAN_INLINE_TEXT_LIMIT) {
    return {
      payloads: [{ text: inlineText }, promptPayload],
      promptRequestId,
    };
  }
  const summaryLines = ["Plan ready."];
  if (plan.explanation?.trim()) {
    summaryLines.push("", plan.explanation.trim());
  }
  const stepsText = formatCodexPlanSteps(plan.steps);
  if (stepsText) {
    summaryLines.push("", stepsText);
  }
  const summaryPreview = buildCodexPlanMarkdownPreview(plan.markdown, 1400);
  if (summaryPreview) {
    summaryLines.push("", "Plan preview:", "", summaryPreview);
  }
  summaryLines.push("", "The full plan is attached as Markdown.");
  const tempDir = resolvePreferredOpenClawTmpDir();
  await fs.mkdir(tempDir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(tempDir, `codex-plan-${promptRequestId}.md`);
  await fs.writeFile(tempPath, `${plan.markdown.trim()}\n`, "utf8");
  const fallbackLines = [
    "I couldn't attach the full Markdown plan here, so here's a condensed inline summary instead.",
  ];
  if (plan.explanation?.trim()) {
    fallbackLines.push("", plan.explanation.trim());
  }
  if (stepsText) {
    fallbackLines.push("", stepsText);
  }
  const markdownPreview = plan.markdown.trim();
  if (markdownPreview) {
    const maxPreviewChars = 1800;
    const preview =
      markdownPreview.length > maxPreviewChars
        ? `${markdownPreview.slice(0, maxPreviewChars).trimEnd()}\n\n[Truncated]`
        : markdownPreview;
    fallbackLines.push("", preview);
  }
  return {
    payloads: [{ text: summaryLines.join("\n").trim() }, { mediaUrl: tempPath }, promptPayload],
    promptRequestId,
    attachmentFallbackText: fallbackLines.join("\n").trim(),
  };
}

async function sendCodexPlanDelivery(params: {
  commandParams: HandleCommandsParams;
  sessionKey: string;
  delivery: CodexPlanDelivery;
}): Promise<boolean> {
  try {
    if (
      params.delivery.payloads.length <= 2 ||
      !params.delivery.payloads.some((payload) => Boolean(payload.mediaUrl))
    ) {
      await sendCodexReplies({
        commandParams: params.commandParams,
        sessionKey: params.sessionKey,
        payloads: params.delivery.payloads,
      });
      return true;
    }

    const [summaryPayload, mediaPayload, promptPayload] = params.delivery.payloads;
    if (!summaryPayload || !mediaPayload || !promptPayload) {
      return false;
    }

    await sendCodexReplies({
      commandParams: params.commandParams,
      sessionKey: params.sessionKey,
      payloads: [summaryPayload],
    });

    const attachmentSent = await sendCodexReplies({
      commandParams: params.commandParams,
      sessionKey: params.sessionKey,
      payloads: [mediaPayload],
    }).catch((error) => {
      logVerbose(`Failed to route Codex plan attachment: ${String(error)}`);
      return false;
    });

    if (!attachmentSent && params.delivery.attachmentFallbackText?.trim()) {
      await sendCodexReplies({
        commandParams: params.commandParams,
        sessionKey: params.sessionKey,
        payloads: [{ text: params.delivery.attachmentFallbackText.trim() }],
      });
    }

    await sendCodexReplies({
      commandParams: params.commandParams,
      sessionKey: params.sessionKey,
      payloads: [promptPayload],
    });
    return true;
  } catch (error) {
    logVerbose(`Failed to route Codex plan output: ${String(error)}`);
    await sendCodexReplies({
      commandParams: params.commandParams,
      sessionKey: params.sessionKey,
      payloads: [
        {
          text: "I couldn't deliver the final Codex plan cleanly. Please rerun /codex_plan or resume the thread in Codex CLI.",
        },
      ],
    }).catch(() => undefined);
    return false;
  }
}

function truncateCodexButtonLabel(text: string, maxChars = 48): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function buildCodexListJoinButtons(params: {
  threads: Awaited<ReturnType<typeof discoverCodexAppServerThreads>>;
}): ReadonlyArray<ReadonlyArray<{ text: string; callback_data: string }>> | undefined {
  const rows = params.threads
    .slice(0, 10)
    .map((thread) => {
      const callbackData = `/codex join ${thread.threadId}`;
      if (callbackData.length > 64) {
        return null;
      }
      const labelSource =
        thread.title?.trim() ||
        path.basename(thread.projectKey?.trim() || "") ||
        thread.threadId.trim();
      return [
        {
          text: truncateCodexButtonLabel(`Join: ${labelSource}`),
          callback_data: callbackData,
        },
      ];
    })
    .filter(Boolean) as Array<Array<{ text: string; callback_data: string }>>;
  return rows.length > 0 ? rows : undefined;
}

async function sendCodexReplies(params: {
  commandParams: HandleCommandsParams;
  sessionKey: string;
  payloads: ReplyPayload[];
}): Promise<boolean> {
  const route = resolveCodexReplyRoute(params.commandParams);
  if (!route) {
    return false;
  }
  let typingTriggered = false;
  for (const payload of params.payloads) {
    if (
      !typingTriggered &&
      route.channel === "telegram" &&
      (payload.text?.trim() || payload.mediaUrl || payload.mediaUrls?.length)
    ) {
      typingTriggered = true;
      const account = resolveTelegramAccount({
        cfg: params.commandParams.cfg,
        accountId: route.accountId,
      });
      if (account.enabled && account.token) {
        const bot = new Bot(account.token);
        const typingChatId = parseTelegramTarget(route.to).chatId;
        const typingThreadId =
          typeof route.threadId === "number"
            ? route.threadId
            : typeof route.threadId === "string" && /^\d+$/.test(route.threadId)
              ? Number.parseInt(route.threadId, 10)
              : undefined;
        const sendChatActionHandler = createTelegramSendChatActionHandler({
          sendChatActionFn: (chatId, action, threadParams) =>
            bot.api.sendChatAction(
              chatId,
              action,
              threadParams as Parameters<typeof bot.api.sendChatAction>[2],
            ),
          logger: (message) => logVerbose(`telegram: ${message}`),
        });
        await sendChatActionHandler
          .sendChatAction(typingChatId, "typing", buildTypingThreadParams(typingThreadId))
          .catch((error) => {
            logVerbose(`Failed to send direct Codex typing cue: ${String(error)}`);
          });
      }
    }
    const result = await routeReply({
      payload,
      channel: route.channel,
      to: route.to,
      sessionKey: params.sessionKey,
      accountId: route.accountId,
      threadId: route.threadId,
      cfg: params.commandParams.cfg,
    });
    if (!result.ok) {
      throw new Error(result.error ?? "failed to route Codex reply");
    }
  }
  return true;
}

type DirectCodexTelegramTypingController = {
  start: () => Promise<void>;
  refresh: () => Promise<void>;
  stop: () => void;
};

function createDirectCodexTelegramTypingController(
  params: HandleCommandsParams,
): DirectCodexTelegramTypingController | undefined {
  const route = resolveCodexReplyRoute(params);
  if (!route || route.channel !== "telegram") {
    return undefined;
  }
  const account = resolveTelegramAccount({
    cfg: params.cfg,
    accountId: route.accountId,
  });
  if (!account.enabled || !account.token) {
    return undefined;
  }
  const bot = new Bot(account.token);
  const typingChatId = parseTelegramTarget(route.to).chatId;
  const typingThreadId =
    typeof route.threadId === "number"
      ? route.threadId
      : typeof route.threadId === "string" && /^\d+$/.test(route.threadId)
        ? Number.parseInt(route.threadId, 10)
        : undefined;
  const sendChatActionHandler = createTelegramSendChatActionHandler({
    sendChatActionFn: (chatId, action, threadParams) =>
      bot.api.sendChatAction(
        chatId,
        action,
        threadParams as Parameters<typeof bot.api.sendChatAction>[2],
      ),
    logger: (message) => logVerbose(`telegram: ${message}`),
  });
  let interval: NodeJS.Timeout | undefined;
  let stopped = false;

  const sendTyping = async () => {
    await sendChatActionHandler
      .sendChatAction(typingChatId, "typing", buildTypingThreadParams(typingThreadId))
      .catch((error) => {
        logVerbose(`Failed to send direct Codex typing cue: ${String(error)}`);
      });
  };

  return {
    start: async () => {
      if (stopped) {
        return;
      }
      await sendTyping();
      if (!interval) {
        interval = setInterval(() => {
          void sendTyping();
        }, CODEX_DIRECT_TELEGRAM_TYPING_INTERVAL_MS);
      }
    },
    refresh: async () => {
      if (stopped) {
        return;
      }
      await sendTyping();
    },
    stop: () => {
      stopped = true;
      if (interval) {
        clearInterval(interval);
        interval = undefined;
      }
    },
  };
}

async function resolveStatusText(params: HandleCommandsParams): Promise<string> {
  const entry = params.sessionEntry;
  const runtimeStatus = getCodexAppServerRuntimeStatus();
  if (
    !entry?.codexThreadId &&
    !isCodexAppServerProvider(entry?.providerOverride ?? "", params.cfg)
  ) {
    return [
      "Codex is not bound in this conversation.",
      `Runtime: ${runtimeStatus.state}`,
      `Mirrored commands: built-in=${getCodexBuiltInMirroredCommandCount()}`,
    ].join("\n");
  }
  const lines = ["Codex binding active."];
  lines.push(`Runtime: ${runtimeStatus.state}`);
  if (entry?.codexThreadId) {
    lines.push(`Thread: ${entry.codexThreadId}`);
  }
  if (entry?.codexProjectKey) {
    lines.push(`Project: ${entry.codexProjectKey}`);
  }
  if (entry?.codexServiceTier) {
    lines.push(`Fast mode: ${formatCodexFastModeValue(entry.codexServiceTier)}`);
  }
  lines.push(`Auto-route: ${entry?.codexAutoRoute === false ? "off" : "on"}`);
  lines.push(`Current model: ${resolveStoredCodexModel(entry) ?? "unknown"}`);
  if (entry?.pendingUserInputRequestId) {
    lines.push(`Pending input: ${entry.pendingUserInputRequestId}`);
  }
  if (entry?.pendingUserInputPromptText) {
    lines.push(entry.pendingUserInputPromptText);
  }
  if (entry?.pendingUserInputAwaitingSteer) {
    lines.push("Awaiting steer reply: yes");
  }
  lines.push(`Mirrored commands: built-in=${getCodexBuiltInMirroredCommandCount()}`);
  lines.push(`Session: ${params.sessionKey}`);
  return lines.join("\n");
}

type CodexMirroredInvocation =
  | {
      kind: "namespace";
      rest: string;
    }
  | {
      kind: "mirrored";
      baseName: string;
      argsText: string;
    };

function parseCodexInvocation(rawCommandBody: string): CodexMirroredInvocation | null {
  const mirroredMatch = rawCommandBody.match(/^\/codex_([a-z0-9_]+)\b/i);
  if (mirroredMatch?.[1]) {
    const matchedText = mirroredMatch[0];
    const rawRemainder = rawCommandBody.slice(matchedText.length);
    const normalizedRemainder = rawRemainder.startsWith("@")
      ? rawRemainder.replace(/^@[^\s:]+(?::\s*|\s*)?/, "")
      : rawRemainder;
    return {
      kind: "mirrored",
      baseName: mirroredMatch[1].trim().toLowerCase(),
      argsText: normalizedRemainder.trim(),
    };
  }
  const namespaceMatch = rawCommandBody.match(/^\/codex\b/i);
  if (namespaceMatch) {
    const rawRemainder = rawCommandBody.slice(namespaceMatch[0].length);
    const normalizedRemainder = rawRemainder.startsWith("@")
      ? rawRemainder.replace(/^@[^\s:]+(?::\s*|\s*)?/, "")
      : rawRemainder;
    return {
      kind: "namespace",
      rest: normalizedRemainder.trim(),
    };
  }
  return null;
}

async function updateCodexPendingInputState(params: {
  commandParams: HandleCommandsParams;
  sessionKey: string;
  pending: PendingCodexUserInputState | null;
}): Promise<void> {
  await updateCodexSession(
    params.commandParams,
    {
      pendingUserInputRequestId: params.pending?.requestId,
      pendingUserInputOptions: params.pending?.options,
      pendingUserInputActions: params.pending?.actions,
      pendingUserInputExpiresAt: params.pending?.expiresAt,
      pendingUserInputPromptText: params.pending?.promptText,
      pendingUserInputMethod: params.pending?.method,
      pendingUserInputAwaitingSteer: false,
    },
    params.sessionKey,
  );
}

async function updateCodexReviewActionState(params: {
  commandParams: HandleCommandsParams;
  sessionKey: string;
  requestId?: string;
  actions?: CodexReviewAction[];
}): Promise<void> {
  await updateCodexSession(
    params.commandParams,
    {
      codexReviewActionRequestId: params.requestId,
      codexReviewActions: params.actions,
    },
    params.sessionKey,
  );
}

async function updateCodexPlanPromptState(params: {
  commandParams: HandleCommandsParams;
  sessionKey: string;
  requestId?: string;
}): Promise<void> {
  await updateCodexSession(
    params.commandParams,
    {
      codexPlanPromptRequestId: params.requestId,
    },
    params.sessionKey,
  );
}

async function runCodexSlashCommandDirectly(params: {
  commandParams: HandleCommandsParams;
  slashName: string;
  argsText?: string;
  persistModelOverride?: string;
}): Promise<CommandHandlerResult> {
  const target = resolveCodexBoundSession(params.commandParams);
  if ("error" in target) {
    return stopWithText(target.error);
  }
  await updateCodexSession(
    params.commandParams,
    {
      providerOverride: "codex-app-server",
      codexAutoRoute: true,
      ...(params.persistModelOverride ? { modelOverride: params.persistModelOverride } : {}),
    },
    target.sessionKey,
  );
  const prompt = ["/" + params.slashName, params.argsText?.trim()].filter(Boolean).join(" ");
  const sessionEntry =
    resolveStoredSessionEntry(params.commandParams, target.sessionKey) ??
    params.commandParams.sessionEntry;
  const workspaceDir =
    sessionEntry?.codexProjectKey?.trim() || target.projectKey || params.commandParams.workspaceDir;
  const model =
    params.persistModelOverride ||
    resolveStoredCodexModel(sessionEntry) ||
    params.commandParams.model;
  const result = await runCodexAppServerAgent({
    sessionId: sessionEntry?.sessionId ?? crypto.randomUUID(),
    sessionKey: target.sessionKey,
    prompt,
    model,
    workspaceDir,
    config: params.commandParams.cfg,
    runId: crypto.randomUUID(),
    existingThreadId: sessionEntry?.codexThreadId?.trim(),
    onToolResult: async (payload) => {
      if (!payload.text?.trim() && !payload.channelData) {
        return;
      }
      await sendCodexReplies({
        commandParams: params.commandParams,
        sessionKey: target.sessionKey,
        payloads: [{ text: payload.text?.trim(), channelData: payload.channelData }],
      });
    },
    onPendingUserInput: async (pending) => {
      await updateCodexPendingInputState({
        commandParams: params.commandParams,
        sessionKey: target.sessionKey,
        pending,
      });
    },
  });
  const resolvedThreadId = result.meta?.agentMeta?.sessionId?.trim();
  if (resolvedThreadId) {
    await updateCodexSession(
      params.commandParams,
      {
        providerOverride: "codex-app-server",
        codexAutoRoute: true,
        codexThreadId: resolvedThreadId,
        codexProjectKey: workspaceDir,
        ...(params.persistModelOverride ? { modelOverride: params.persistModelOverride } : {}),
      },
      target.sessionKey,
    );
  }
  const reply = result.payloads?.find(
    (payload) => payload.text?.trim() || payload.mediaUrl || payload.mediaUrls?.length,
  );
  if (!reply) {
    return { shouldContinue: false };
  }
  return { shouldContinue: false, reply };
}

async function handleCodexFastCommand(
  params: HandleCommandsParams,
  argsText: string,
): Promise<CommandHandlerResult> {
  const target = resolveCodexBoundSession(params);
  if ("error" in target) {
    return stopWithText(target.error);
  }
  const sessionEntry = resolveStoredSessionEntry(params, target.sessionKey) ?? params.sessionEntry;
  const threadId = sessionEntry?.codexThreadId?.trim();
  if (!threadId) {
    return stopWithText(
      "Codex fast mode needs a live bound thread. Start or join a Codex thread first.",
    );
  }
  const action = parseCodexFastAction(argsText);
  if (typeof action === "object") {
    return stopWithText(action.error);
  }
  const workspaceDir =
    sessionEntry?.codexProjectKey?.trim() || target.projectKey || params.workspaceDir;
  const currentState = await readCodexAppServerThreadState({
    config: params.cfg,
    sessionKey: target.sessionKey,
    workspaceDir,
    threadId,
  });
  const currentTier = normalizeCodexServiceTier(currentState.serviceTier);
  if (action === "status") {
    await updateCodexSession(
      params,
      {
        providerOverride: "codex-app-server",
        codexAutoRoute: true,
        codexServiceTier: currentTier,
      },
      target.sessionKey,
    );
    return stopWithText(formatCodexFastModeStatusText(currentTier));
  }
  const nextTier =
    action === "toggle"
      ? currentTier === "fast"
        ? null
        : "fast"
      : action === "on"
        ? "fast"
        : null;
  const updatedState = await setCodexAppServerThreadServiceTier({
    config: params.cfg,
    sessionKey: target.sessionKey,
    workspaceDir,
    threadId,
    serviceTier: nextTier,
  });
  const effectiveTier = normalizeCodexServiceTier(updatedState.serviceTier);
  await updateCodexSession(
    params,
    {
      providerOverride: "codex-app-server",
      codexAutoRoute: true,
      codexServiceTier: effectiveTier,
    },
    target.sessionKey,
  );
  return stopWithText(formatCodexFastModeSetText(effectiveTier));
}

async function handleCodexStopCommand(params: HandleCommandsParams): Promise<CommandHandlerResult> {
  const target = resolveCodexBoundSession(params);
  if ("error" in target) {
    return stopWithText(target.error);
  }
  const sessionEntry = resolveStoredSessionEntry(params, target.sessionKey) ?? params.sessionEntry;
  const threadId = sessionEntry?.codexThreadId?.trim();
  if (!threadId) {
    return stopWithText(
      "Codex stop is unavailable until a Codex thread is started or joined in this conversation.",
    );
  }
  if (!interruptCodexAppServerRunBySessionKey(target.sessionKey)) {
    return stopWithText("No active Codex run to stop.");
  }
  return stopWithText("Stopping Codex now.");
}

async function handleCodexMirroredStatusCommand(
  params: HandleCommandsParams,
): Promise<CommandHandlerResult> {
  const target = resolveCodexBoundSession(params);
  if ("error" in target) {
    return stopWithText(target.error);
  }
  const sessionEntry = resolveStoredSessionEntry(params, target.sessionKey) ?? params.sessionEntry;
  const threadId = sessionEntry?.codexThreadId?.trim();
  if (!threadId) {
    return stopWithText(
      "Codex status is unavailable until a Codex thread is started or joined in this conversation.",
    );
  }
  const workspaceDir =
    sessionEntry?.codexProjectKey?.trim() || target.projectKey || params.workspaceDir;
  const errors: string[] = [];
  const [threadState, account, rateLimits] = await Promise.all([
    readCodexAppServerThreadState({
      config: params.cfg,
      sessionKey: target.sessionKey,
      workspaceDir,
      threadId,
    }).catch((error) => {
      errors.push(`thread state unavailable: ${String(error)}`);
      return undefined;
    }),
    readCodexAppServerAccount({
      config: params.cfg,
      sessionKey: target.sessionKey,
      workspaceDir,
    }).catch((error) => {
      errors.push(`account unavailable: ${String(error)}`);
      return undefined;
    }),
    readCodexAppServerRateLimits({
      config: params.cfg,
      sessionKey: target.sessionKey,
      workspaceDir,
    }).catch((error) => {
      errors.push(`rate limits unavailable: ${String(error)}`);
      return [] as CodexAppServerRateLimitSummary[];
    }),
  ]);
  const projectFolder = await resolveCodexProjectFolder(threadState?.cwd ?? workspaceDir);
  await updateCodexSession(
    params,
    {
      providerOverride: "codex-app-server",
      codexAutoRoute: true,
      codexServiceTier: normalizeCodexServiceTier(
        threadState?.serviceTier ?? sessionEntry?.codexServiceTier,
      ),
    },
    target.sessionKey,
  );
  return stopWithText(
    formatCodexMirroredStatusText({
      threadState,
      account,
      rateLimits,
      entry: sessionEntry,
      errors,
      projectFolder,
    }),
  );
}

async function handleCodexRenameCommand(
  params: HandleCommandsParams,
  argsText: string,
): Promise<CommandHandlerResult> {
  const target = resolveCodexBoundSession(params);
  if ("error" in target) {
    return stopWithText(target.error);
  }
  const parsed = parseCodexRenameArguments(argsText);
  if (!parsed) {
    return stopWithText("Usage: /codex_rename [--sync] <new thread name>");
  }
  const sessionEntry = resolveStoredSessionEntry(params, target.sessionKey) ?? params.sessionEntry;
  const threadId = sessionEntry?.codexThreadId?.trim();
  if (!threadId) {
    return stopWithText(
      "Codex rename is unavailable until a Codex thread is started or joined in this conversation.",
    );
  }
  const workspaceDir =
    sessionEntry?.codexProjectKey?.trim() || target.projectKey || params.workspaceDir;
  await setCodexAppServerThreadName({
    config: params.cfg,
    sessionKey: target.sessionKey,
    workspaceDir,
    threadId,
    name: parsed.name,
  });
  return {
    shouldContinue: false,
    reply: {
      text: `Renamed Codex thread to: ${parsed.name}`,
      channelData:
        parsed.syncTopic && params.command.surface === "telegram"
          ? { telegram: { renameTopicTo: parsed.name } }
          : undefined,
    },
  };
}

async function handleCodexCompactCommand(
  params: HandleCommandsParams,
): Promise<CommandHandlerResult> {
  const target = resolveCodexBoundSession(params);
  if ("error" in target) {
    return stopWithText(target.error);
  }
  const sessionEntry = resolveStoredSessionEntry(params, target.sessionKey) ?? params.sessionEntry;
  const threadId = sessionEntry?.codexThreadId?.trim();
  if (!threadId) {
    return stopWithText(
      "Codex compact is unavailable until a Codex thread is started or joined in this conversation.",
    );
  }
  const workspaceDir =
    sessionEntry?.codexProjectKey?.trim() || target.projectKey || params.workspaceDir;
  await startCodexAppServerThreadCompaction({
    config: params.cfg,
    sessionKey: target.sessionKey,
    workspaceDir,
    threadId,
  });
  return stopWithText("Started Codex thread compaction.");
}

async function handleCodexSkillsCommand(
  params: HandleCommandsParams,
  argsText: string,
): Promise<CommandHandlerResult> {
  const target = resolveCodexBoundSession(params);
  if ("error" in target) {
    return stopWithText(target.error);
  }
  const sessionEntry = resolveStoredSessionEntry(params, target.sessionKey) ?? params.sessionEntry;
  const workspaceDir =
    sessionEntry?.codexProjectKey?.trim() || target.projectKey || params.workspaceDir;
  const skills = await readCodexAppServerSkills({
    config: params.cfg,
    sessionKey: target.sessionKey,
    workspaceDir,
  });
  return stopWithText(
    formatCodexSkillSummaryLines({
      workspaceDir,
      skills,
      filter: argsText,
    }).join("\n"),
  );
}

async function handleCodexExperimentalCommand(
  params: HandleCommandsParams,
  argsText: string,
): Promise<CommandHandlerResult> {
  const target = resolveCodexBoundSession(params);
  if ("error" in target) {
    return stopWithText(target.error);
  }
  const sessionEntry = resolveStoredSessionEntry(params, target.sessionKey) ?? params.sessionEntry;
  const workspaceDir =
    sessionEntry?.codexProjectKey?.trim() || target.projectKey || params.workspaceDir;
  const features = await readCodexAppServerExperimentalFeatures({
    config: params.cfg,
    sessionKey: target.sessionKey,
    workspaceDir,
  });
  return stopWithText(
    formatCodexExperimentalFeatureLines({
      features,
      filter: argsText,
    }).join("\n"),
  );
}

async function handleCodexMcpCommand(
  params: HandleCommandsParams,
  argsText: string,
): Promise<CommandHandlerResult> {
  const target = resolveCodexBoundSession(params);
  if ("error" in target) {
    return stopWithText(target.error);
  }
  const sessionEntry = resolveStoredSessionEntry(params, target.sessionKey) ?? params.sessionEntry;
  const workspaceDir =
    sessionEntry?.codexProjectKey?.trim() || target.projectKey || params.workspaceDir;
  const servers = await readCodexAppServerMcpServers({
    config: params.cfg,
    sessionKey: target.sessionKey,
    workspaceDir,
  });
  return stopWithText(
    formatCodexMcpServerLines({
      servers,
      filter: argsText,
    }).join("\n"),
  );
}

function resolveCodexPlanCollaborationMode(params: {
  sessionEntry: HandleCommandsParams["sessionEntry"];
  threadState?: CodexAppServerThreadState;
  fallbackModel?: string;
}): CodexAppServerCollaborationMode {
  return {
    mode: "plan",
    settings: {
      model:
        params.threadState?.model?.trim() ||
        resolveStoredCodexModel(params.sessionEntry) ||
        params.fallbackModel,
      reasoningEffort:
        params.threadState?.reasoningEffort?.trim() ||
        params.sessionEntry?.reasoningLevel?.trim() ||
        undefined,
      developerInstructions: null,
    },
  };
}

async function handleCodexPlanCommand(
  params: HandleCommandsParams,
  argsText: string,
): Promise<CommandHandlerResult> {
  const trimmedArgs = argsText.trim();
  if (!trimmedArgs) {
    return stopWithText("Usage: /codex_plan <planning request>");
  }
  const target = resolveCodexBoundSession(params);
  if ("error" in target) {
    return stopWithText(target.error);
  }
  const sessionEntry = resolveStoredSessionEntry(params, target.sessionKey) ?? params.sessionEntry;
  const workspaceDir =
    sessionEntry?.codexProjectKey?.trim() || target.projectKey || params.workspaceDir;
  const threadId = sessionEntry?.codexThreadId?.trim();
  const threadState = threadId
    ? await readCodexAppServerThreadState({
        config: params.cfg,
        sessionKey: target.sessionKey,
        workspaceDir,
        threadId,
      }).catch(() => undefined)
    : undefined;
  const directTyping = createDirectCodexTelegramTypingController(params);
  await updateCodexPlanPromptState({
    commandParams: params,
    sessionKey: target.sessionKey,
    requestId: undefined,
  });
  await sendCodexReplies({
    commandParams: params,
    sessionKey: target.sessionKey,
    payloads: [
      {
        text: "Starting Codex plan mode. I’ll relay the questions and final plan as they arrive.",
      },
    ],
  }).catch((error) => {
    logVerbose(`Failed to send Codex plan start message: ${String(error)}`);
  });
  await directTyping?.start();
  let keepaliveSent = false;
  let planVisible = false;
  let questionVisible = false;
  const progressTimer = setTimeout(() => {
    void (async () => {
      if (planVisible || questionVisible || keepaliveSent) {
        return;
      }
      keepaliveSent = true;
      await directTyping?.refresh();
      await sendCodexReplies({
        commandParams: params,
        sessionKey: target.sessionKey,
        payloads: [{ text: "Codex is still planning..." }],
      }).catch((error) => {
        logVerbose(`Failed to send Codex plan progress update: ${String(error)}`);
      });
    })();
  }, CODEX_PLAN_PROGRESS_DELAY_MS);
  const result = await (async () => {
    try {
      return await runCodexAppServerAgent({
        sessionId: sessionEntry?.sessionId ?? crypto.randomUUID(),
        sessionKey: target.sessionKey,
        prompt: trimmedArgs,
        model: resolveStoredCodexModel(sessionEntry) || params.model,
        workspaceDir,
        config: params.cfg,
        runId: crypto.randomUUID(),
        existingThreadId: threadId,
        collaborationMode: resolveCodexPlanCollaborationMode({
          sessionEntry,
          threadState,
          fallbackModel: params.model,
        }),
        onToolResult: async (payload) => {
          if (!payload.text?.trim() && !payload.channelData) {
            return;
          }
          if (
            (
              payload.channelData as
                | { codexAppServer?: { interactiveRequest?: boolean } }
                | undefined
            )?.codexAppServer?.interactiveRequest
          ) {
            questionVisible = true;
          }
          await directTyping?.refresh();
          await sendCodexReplies({
            commandParams: params,
            sessionKey: target.sessionKey,
            payloads: [{ text: payload.text?.trim(), channelData: payload.channelData }],
          });
        },
        onPendingUserInput: async (pending) => {
          if (pending) {
            questionVisible = true;
            await directTyping?.refresh();
          }
          await updateCodexPendingInputState({
            commandParams: params,
            sessionKey: target.sessionKey,
            pending,
          });
        },
      });
    } finally {
      clearTimeout(progressTimer);
      directTyping?.stop();
    }
  })();
  const resolvedThreadId = result.meta?.agentMeta?.sessionId?.trim();
  if (resolvedThreadId) {
    await updateCodexSession(
      params,
      {
        providerOverride: "codex-app-server",
        codexAutoRoute: true,
        codexThreadId: resolvedThreadId,
        codexProjectKey: workspaceDir,
      },
      target.sessionKey,
    );
  }
  const planArtifact = result.meta?.codexPlanArtifact;
  if (planArtifact?.markdown.trim()) {
    planVisible = true;
    const delivery = await buildCodexPlanDelivery({
      explanation: planArtifact.explanation,
      steps: planArtifact.steps ?? [],
      markdown: planArtifact.markdown,
    });
    await updateCodexPlanPromptState({
      commandParams: params,
      sessionKey: target.sessionKey,
      requestId: delivery.promptRequestId,
    });
    const routed = await sendCodexPlanDelivery({
      commandParams: params,
      sessionKey: target.sessionKey,
      delivery,
    });
    void routed;
    return { shouldContinue: false };
  }
  const reply = result.payloads?.find(
    (payload) => payload.text?.trim() || payload.mediaUrl || payload.mediaUrls?.length,
  );
  if (!reply) {
    return { shouldContinue: false };
  }
  return { shouldContinue: false, reply };
}

async function handleCodexReviewCommand(
  params: HandleCommandsParams,
  argsText: string,
): Promise<CommandHandlerResult> {
  const target = resolveCodexBoundSession(params);
  if ("error" in target) {
    return stopWithText(target.error);
  }
  const sessionEntry = resolveStoredSessionEntry(params, target.sessionKey) ?? params.sessionEntry;
  const threadId = sessionEntry?.codexThreadId?.trim();
  if (!threadId) {
    return stopWithText(
      "Codex review is unavailable until a Codex thread is started or joined in this conversation.",
    );
  }
  const workspaceDir =
    sessionEntry?.codexProjectKey?.trim() || target.projectKey || params.workspaceDir;
  await sendCodexReplies({
    commandParams: params,
    sessionKey: target.sessionKey,
    payloads: [
      {
        text: argsText.trim()
          ? "Starting Codex review with your custom focus. I’ll send the findings when the review finishes."
          : "Starting Codex review of the current changes. I’ll send the findings when the review finishes.",
      },
    ],
  }).catch((error) => {
    logVerbose(`Failed to send Codex review start message: ${String(error)}`);
  });
  const reviewResult = await startCodexAppServerReview({
    sessionId: sessionEntry?.sessionId ?? crypto.randomUUID(),
    sessionKey: target.sessionKey,
    workspaceDir,
    config: params.cfg,
    runId: crypto.randomUUID(),
    threadId,
    target: argsText.trim()
      ? { type: "custom", instructions: argsText.trim() }
      : { type: "uncommittedChanges" },
    onToolResult: async (payload) => {
      if (!payload.text?.trim() && !payload.channelData) {
        return;
      }
      await sendCodexReplies({
        commandParams: params,
        sessionKey: target.sessionKey,
        payloads: [{ text: payload.text?.trim(), channelData: payload.channelData }],
      });
    },
    onPendingUserInput: async (pending) => {
      await updateCodexPendingInputState({
        commandParams: params,
        sessionKey: target.sessionKey,
        pending,
      });
    },
  });
  const parsed = parseCodexReviewOutput(reviewResult.reviewText);
  const reviewRequestId = crypto.randomUUID();
  const reviewActions = buildCodexReviewActions(parsed.findings);
  await updateCodexReviewActionState({
    commandParams: params,
    sessionKey: target.sessionKey,
    requestId: reviewActions.length > 0 ? reviewRequestId : undefined,
    actions: reviewActions.length > 0 ? reviewActions : undefined,
  });

  const payloads: ReplyPayload[] = [];
  if (parsed.summary) {
    payloads.push({ text: parsed.summary });
  }
  if (parsed.findings.length === 0) {
    payloads.push({ text: "No review findings." });
  } else {
    parsed.findings.forEach((finding, index) => {
      payloads.push({
        text: formatCodexReviewFindingMessage({
          finding,
          index,
        }),
      });
    });
    const buttons = buildCodexReviewActionButtons({
      requestId: reviewRequestId,
      actions: reviewActions,
    });
    payloads.push({
      text: "Choose a review finding to implement, or implement them all.",
      channelData: buttons ? { telegram: { buttons } } : undefined,
    });
  }

  const routed = await sendCodexReplies({
    commandParams: params,
    sessionKey: target.sessionKey,
    payloads,
  }).catch((error) => {
    logVerbose(`Failed to route Codex review output: ${String(error)}`);
    return false;
  });
  if (routed) {
    return { shouldContinue: false };
  }
  return stopWithText(
    payloads
      .map((payload) => payload.text)
      .filter(Boolean)
      .join("\n\n"),
  );
}

function pickBestThread(
  threads: CodexAppServerThreadSummary[],
  token: string,
): CodexAppServerThreadSummary | undefined {
  const exact = threads.find((thread) => thread.threadId === token.trim());
  if (exact) {
    return exact;
  }
  return threads[0];
}

export const handleCodexCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  const normalized = params.command.commandBodyNormalized;
  if (!normalized.startsWith(COMMAND) && !normalized.startsWith(MIRRORED_COMMAND)) {
    return null;
  }
  const rawCommandBody =
    typeof params.ctx.CommandBody === "string" ? params.ctx.CommandBody.trim() : normalized;
  const invocation = parseCodexInvocation(rawCommandBody);
  if (!invocation) {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring Codex command from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  applyExistingCodexConversationBinding(params);

  if (invocation.kind === "mirrored") {
    const availabilityError = getCodexAppServerAvailabilityError(params.cfg);
    if (availabilityError) {
      return stopWithText(`⚠️ ${availabilityError}`);
    }
    if (invocation.baseName === "status") {
      return await handleCodexMirroredStatusCommand(params);
    }
    if (invocation.baseName === "fast") {
      return await handleCodexFastCommand(params, invocation.argsText);
    }
    if (invocation.baseName === "rename") {
      return await handleCodexRenameCommand(params, invocation.argsText);
    }
    if (invocation.baseName === "compact") {
      return await handleCodexCompactCommand(params);
    }
    if (invocation.baseName === "skills") {
      return await handleCodexSkillsCommand(params, invocation.argsText);
    }
    if (invocation.baseName === "experimental") {
      return await handleCodexExperimentalCommand(params, invocation.argsText);
    }
    if (invocation.baseName === "mcp") {
      return await handleCodexMcpCommand(params, invocation.argsText);
    }
    if (invocation.baseName === "review") {
      return await handleCodexReviewCommand(params, invocation.argsText);
    }
    if (invocation.baseName === "plan") {
      return await handleCodexPlanCommand(params, invocation.argsText);
    }
    if (invocation.baseName === "stop") {
      return await handleCodexStopCommand(params);
    }
    if (invocation.baseName === "model") {
      const trimmedArgs = invocation.argsText.trim();
      if (!trimmedArgs) {
        const target = resolveCodexBoundSession(params);
        if ("error" in target) {
          return stopWithText(target.error);
        }
        const models = await readCodexAppServerModels({
          config: params.cfg,
          sessionKey: target.sessionKey,
          workspaceDir: target.projectKey,
        }).catch((error) => {
          logVerbose(`Failed to read Codex model list: ${String(error)}`);
          return [];
        });
        const currentModel =
          models.find((model) => model.current)?.id ?? resolveStoredCodexModel(params.sessionEntry);
        return stopWithText(
          formatModelSummaryLines({
            currentModel,
            models,
          }).join("\n"),
        );
      }
      return await runCodexSlashCommandDirectly({
        commandParams: params,
        slashName: "model",
        argsText: trimmedArgs,
        persistModelOverride: trimmedArgs,
      });
    }
    if (BUILT_IN_MIRRORED_BASE_NAMES.has(invocation.baseName)) {
      return await runCodexSlashCommandDirectly({
        commandParams: params,
        slashName: invocation.baseName,
        argsText: invocation.argsText,
      });
    }
    return stopWithText(`Unknown Codex mirrored command: /codex_${invocation.baseName}`);
  }

  const tokens = invocation.rest.split(/\s+/).filter(Boolean);
  const action = resolveAction(tokens);

  if (action === "help") {
    return stopWithText(resolveHelpText());
  }

  if (action === "status") {
    return {
      shouldContinue: false,
      reply: {
        text: await resolveStatusText(params),
        channelData: buildPendingInputChannelData(params, params.sessionEntry),
      },
    };
  }

  if (action === "detach") {
    await unbindCodexConversation(params);
    await updateCodexSession(params, {
      providerOverride: undefined,
      codexAutoRoute: false,
      pendingUserInputRequestId: undefined,
      pendingUserInputOptions: undefined,
      pendingUserInputActions: undefined,
      pendingUserInputExpiresAt: undefined,
      pendingUserInputPromptText: undefined,
      pendingUserInputMethod: undefined,
      pendingUserInputAwaitingSteer: undefined,
    });
    return stopWithText(
      "Codex detached from this conversation. The remote thread was left intact.",
    );
  }

  const availabilityError = getCodexAppServerAvailabilityError(params.cfg);
  if (availabilityError) {
    return stopWithText(`⚠️ ${availabilityError}`);
  }

  if (action === "new" || action === "spawn") {
    const parsed = parseNewArguments(tokens);
    if ("error" in parsed) {
      return stopWithText(`⚠️ ${parsed.error}`);
    }
    const targetSession = await ensureCodexBoundSession({
      commandParams: params,
      projectKey: parsed.cwd ?? params.workspaceDir,
    });
    if ("error" in targetSession) {
      return stopWithText(`⚠️ ${targetSession.error}`);
    }
    await updateCodexSession(
      params,
      {
        providerOverride: "codex-app-server",
        codexThreadId: undefined,
        codexProjectKey: parsed.cwd ?? params.workspaceDir,
        codexAutoRoute: true,
        pendingUserInputRequestId: undefined,
        pendingUserInputOptions: undefined,
        pendingUserInputActions: undefined,
        pendingUserInputExpiresAt: undefined,
        pendingUserInputPromptText: undefined,
        pendingUserInputMethod: undefined,
        pendingUserInputAwaitingSteer: undefined,
      },
      targetSession.sessionKey,
    );
    if (!parsed.prompt || !targetSession.isCurrentSession || parsed.cwd) {
      return stopWithText(
        `Codex is now bound to this conversation for ${parsed.cwd ?? params.workspaceDir}. Send the next message to start the thread.`,
      );
    }
    return continueWithPrompt(params, parsed.prompt);
  }

  if (action === "steer") {
    const instruction = tokens.join(" ").trim();
    if (!instruction) {
      return stopWithText("Usage: /codex steer <instruction>");
    }
    const targetSession = await ensureCodexBoundSession({
      commandParams: params,
      projectKey: params.sessionEntry?.codexProjectKey ?? params.workspaceDir,
    });
    if ("error" in targetSession) {
      return stopWithText(`⚠️ ${targetSession.error}`);
    }
    await updateCodexSession(
      params,
      {
        providerOverride: "codex-app-server",
        codexAutoRoute: true,
      },
      targetSession.sessionKey,
    );
    if (!targetSession.isCurrentSession) {
      return stopWithText(
        "Codex is now bound to this conversation. Send the next message to continue the session.",
      );
    }
    return continueWithPrompt(params, instruction);
  }

  if (action === "list") {
    const parsed = parseListArguments(
      tokens,
      params.sessionEntry?.codexProjectKey ?? params.workspaceDir,
    );
    const threads = await discoverCodexAppServerThreads({
      config: params.cfg,
      sessionKey: params.sessionKey,
      workspaceDir: parsed.workspaceDir,
      filter: parsed.filter,
    });
    if (threads.length === 0) {
      return stopWithText("No Codex threads found.");
    }
    const lines = ["Recent Codex threads:"];
    const visibleThreads = threads.slice(0, 10);
    for (const thread of visibleThreads) {
      lines.push(
        `- ${thread.threadId}${thread.title ? ` · ${thread.title}` : ""}${thread.projectKey ? ` · ${thread.projectKey}` : ""}`,
      );
    }
    return {
      shouldContinue: false,
      reply: {
        text: lines.join("\n"),
        channelData:
          params.command.surface === "telegram"
            ? {
                telegram: {
                  buttons: buildCodexListJoinButtons({
                    threads: visibleThreads,
                  }),
                },
              }
            : undefined,
      },
    };
  }

  if (action === "join") {
    const token = tokens.join(" ").trim();
    if (!token) {
      return stopWithText("Usage: /codex join <thread-id-or-filter>");
    }
    const threads = await discoverCodexAppServerThreads({
      config: params.cfg,
      sessionKey: params.sessionKey,
      workspaceDir: undefined,
      filter: token,
    });
    const selected = pickBestThread(threads, token);
    if (!selected) {
      return stopWithText(`No Codex thread matched: ${token}`);
    }
    const targetSession = await ensureCodexBoundSession({
      commandParams: params,
      projectKey: selected.projectKey ?? params.workspaceDir,
    });
    if ("error" in targetSession) {
      return stopWithText(`⚠️ ${targetSession.error}`);
    }
    const existingPendingEntry = targetSession.sessionEntry;
    const shouldPreservePendingReplay =
      existingPendingEntry?.codexThreadId?.trim() === selected.threadId &&
      Boolean(existingPendingEntry?.pendingUserInputRequestId?.trim());
    await updateCodexSession(
      params,
      {
        providerOverride: "codex-app-server",
        codexThreadId: selected.threadId,
        codexProjectKey: selected.projectKey ?? params.workspaceDir,
        codexAutoRoute: true,
        pendingUserInputRequestId: shouldPreservePendingReplay
          ? existingPendingEntry?.pendingUserInputRequestId
          : undefined,
        pendingUserInputOptions: shouldPreservePendingReplay
          ? existingPendingEntry?.pendingUserInputOptions
          : undefined,
        pendingUserInputActions: shouldPreservePendingReplay
          ? existingPendingEntry?.pendingUserInputActions
          : undefined,
        pendingUserInputExpiresAt: shouldPreservePendingReplay
          ? existingPendingEntry?.pendingUserInputExpiresAt
          : undefined,
        pendingUserInputPromptText: shouldPreservePendingReplay
          ? existingPendingEntry?.pendingUserInputPromptText
          : undefined,
        pendingUserInputMethod: shouldPreservePendingReplay
          ? existingPendingEntry?.pendingUserInputMethod
          : undefined,
        pendingUserInputAwaitingSteer: shouldPreservePendingReplay
          ? existingPendingEntry?.pendingUserInputAwaitingSteer
          : undefined,
      },
      targetSession.sessionKey,
    );
    const refreshedEntry =
      params.sessionStore?.[targetSession.sessionKey] ?? targetSession.sessionEntry;
    const threadReplay = await readCodexAppServerThreadContext({
      config: params.cfg,
      sessionKey: params.sessionKey,
      workspaceDir: selected.projectKey ?? params.workspaceDir,
      threadId: selected.threadId,
    }).catch((error) => {
      logVerbose(`Failed to read Codex thread context for ${selected.threadId}: ${String(error)}`);
      return {};
    });
    const pendingReplay = buildPendingInputReplay(refreshedEntry);
    const payloads: ReplyPayload[] = [
      {
        text: ["Codex thread bound.", summarizeThreadBinding(selected)].join("\n\n"),
        channelData: shouldPinCodexBindingNotice(params) ? { telegram: { pin: true } } : undefined,
      },
      ...buildThreadReplayPayloads(threadReplay),
    ];
    if (pendingReplay) {
      payloads.push({
        text: pendingReplay,
        channelData: buildPendingInputChannelData(params, refreshedEntry),
      });
    }
    const routed = await sendCodexReplies({
      commandParams: params,
      sessionKey: targetSession.sessionKey,
      payloads,
    }).catch((error) => {
      logVerbose(`Failed to route Codex join replay: ${String(error)}`);
      return false;
    });
    if (routed) {
      return { shouldContinue: false };
    }
    return {
      shouldContinue: false,
      reply: {
        text: ["Codex thread bound.", summarizeThreadBinding(selected), pendingReplay]
          .filter(Boolean)
          .join("\n\n"),
        channelData: buildPendingInputChannelData(params, refreshedEntry),
      },
    };
  }

  return stopWithText(resolveHelpText());
};
