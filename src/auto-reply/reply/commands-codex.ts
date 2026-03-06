import crypto from "node:crypto";
import { buildCodexBoundSessionKey } from "../../agents/codex-app-server-bindings.js";
import {
  discoverCodexAppServerThreads,
  isCodexAppServerProvider,
  readCodexAppServerThreadContext,
  type CodexAppServerThreadSummary,
} from "../../agents/codex-app-server-runner.js";
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
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import type { ReplyPayload } from "../types.js";
import { resolveAcpCommandBindingContext } from "./commands-acp/context.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";
import { isRoutableChannel, routeReply } from "./route-reply.js";

const COMMAND = "/codex";

type CodexAction = "new" | "spawn" | "join" | "steer" | "status" | "detach" | "list" | "help";

type SessionMutation = {
  providerOverride?: string;
  codexThreadId?: string;
  codexProjectKey?: string;
  codexAutoRoute?: boolean;
  pendingUserInputRequestId?: string;
  pendingUserInputOptions?: string[];
  pendingUserInputExpiresAt?: number;
  pendingUserInputPromptText?: string;
  pendingUserInputMethod?: string;
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
    "/codex list [filter]",
  ].join("\n");
}

function buildCodexTelegramButtons(
  options: string[] | undefined,
): ReadonlyArray<ReadonlyArray<{ text: string; callback_data: string }>> | undefined {
  const trimmed = options?.map((option) => option.trim()).filter(Boolean) ?? [];
  if (trimmed.length === 0) {
    return undefined;
  }
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  for (let index = 0; index < trimmed.length; index += 2) {
    rows.push(
      trimmed.slice(index, index + 2).map((option, offset) => {
        const ordinal = index + offset + 1;
        return {
          text: `${ordinal}. ${option}`,
          callback_data: String(ordinal),
        };
      }),
    );
  }
  return rows;
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
  const options = entry?.pendingUserInputOptions?.filter(Boolean) ?? [];
  if (options.length > 0) {
    lines.push("", "Options:");
    options.forEach((option, index) => {
      lines.push(`${index + 1}. ${option}`);
    });
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
  const buttons = buildCodexTelegramButtons(entry?.pendingUserInputOptions);
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

async function sendCodexReplies(params: {
  commandParams: HandleCommandsParams;
  sessionKey: string;
  payloads: ReplyPayload[];
}): Promise<boolean> {
  const route = resolveCodexReplyRoute(params.commandParams);
  if (!route) {
    return false;
  }
  for (const payload of params.payloads) {
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

function resolveStatusText(params: HandleCommandsParams): string {
  const entry = params.sessionEntry;
  const runtimeStatus = getCodexAppServerRuntimeStatus();
  if (
    !entry?.codexThreadId &&
    !isCodexAppServerProvider(entry?.providerOverride ?? "", params.cfg)
  ) {
    return ["Codex is not bound in this conversation.", `Runtime: ${runtimeStatus.state}`].join(
      "\n",
    );
  }
  const lines = ["Codex binding active."];
  lines.push(`Runtime: ${runtimeStatus.state}`);
  if (entry?.codexThreadId) {
    lines.push(`Thread: ${entry.codexThreadId}`);
  }
  if (entry?.codexProjectKey) {
    lines.push(`Project: ${entry.codexProjectKey}`);
  }
  lines.push(`Auto-route: ${entry?.codexAutoRoute === false ? "off" : "on"}`);
  if (entry?.pendingUserInputRequestId) {
    lines.push(`Pending input: ${entry.pendingUserInputRequestId}`);
  }
  if (entry?.pendingUserInputPromptText) {
    lines.push(entry.pendingUserInputPromptText);
  }
  lines.push(`Session: ${params.sessionKey}`);
  return lines.join("\n");
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
  if (!normalized.startsWith(COMMAND)) {
    return null;
  }
  const rawCommandBody =
    typeof params.ctx.CommandBody === "string" ? params.ctx.CommandBody.trim() : normalized;
  const commandMatch = rawCommandBody.match(/^\/codex\b/i);
  const rest = commandMatch ? rawCommandBody.slice(commandMatch[0].length).trim() : "";
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /codex from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const tokens = rest.split(/\s+/).filter(Boolean);
  const action = resolveAction(tokens);
  applyExistingCodexConversationBinding(params);

  if (action === "help") {
    return stopWithText(resolveHelpText());
  }

  if (action === "status") {
    return {
      shouldContinue: false,
      reply: {
        text: resolveStatusText(params),
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
      pendingUserInputExpiresAt: undefined,
      pendingUserInputPromptText: undefined,
      pendingUserInputMethod: undefined,
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
        pendingUserInputExpiresAt: undefined,
        pendingUserInputPromptText: undefined,
        pendingUserInputMethod: undefined,
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
    const filter = tokens.join(" ").trim();
    const workspaceDir = filter
      ? undefined
      : (params.sessionEntry?.codexProjectKey ?? params.workspaceDir);
    const threads = await discoverCodexAppServerThreads({
      config: params.cfg,
      sessionKey: params.sessionKey,
      workspaceDir,
      filter: filter || undefined,
    });
    if (threads.length === 0) {
      return stopWithText("No Codex threads found.");
    }
    const lines = ["Recent Codex threads:"];
    for (const thread of threads.slice(0, 10)) {
      lines.push(
        `- ${thread.threadId}${thread.title ? ` · ${thread.title}` : ""}${thread.projectKey ? ` · ${thread.projectKey}` : ""}`,
      );
    }
    return stopWithText(lines.join("\n"));
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
        pendingUserInputExpiresAt: shouldPreservePendingReplay
          ? existingPendingEntry?.pendingUserInputExpiresAt
          : undefined,
        pendingUserInputPromptText: shouldPreservePendingReplay
          ? existingPendingEntry?.pendingUserInputPromptText
          : undefined,
        pendingUserInputMethod: shouldPreservePendingReplay
          ? existingPendingEntry?.pendingUserInputMethod
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
