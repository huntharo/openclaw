import {
  discoverCodexAppServerThreads,
  isCodexAppServerProvider,
  type CodexAppServerThreadSummary,
} from "../../agents/codex-app-server-runner.js";
import { updateSessionStore } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import type {
  CommandHandler,
  CommandHandlerResult,
  HandleCommandsParams,
} from "./commands-types.js";

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
): Promise<void> {
  if (!params.storePath) {
    if (params.sessionEntry) {
      Object.assign(params.sessionEntry, update, { updatedAt: Date.now() });
    }
    return;
  }
  await updateSessionStore(params.storePath, (store) => {
    const existing = store[params.sessionKey] ??
      params.sessionEntry ?? {
        sessionId: params.sessionKey,
        updatedAt: Date.now(),
      };
    store[params.sessionKey] = {
      ...existing,
      ...update,
      updatedAt: Date.now(),
    };
  });
  if (params.sessionEntry) {
    Object.assign(params.sessionEntry, update, { updatedAt: Date.now() });
  }
}

function summarizeThread(thread: CodexAppServerThreadSummary): string {
  const lines = [`Thread: ${thread.threadId}`];
  if (thread.title) {
    lines.push(`Title: ${thread.title}`);
  }
  if (thread.projectKey) {
    lines.push(`Project: ${thread.projectKey}`);
  }
  if (thread.summary) {
    lines.push(`Summary: ${thread.summary}`);
  }
  return lines.join("\n");
}

function resolveStatusText(params: HandleCommandsParams): string {
  const entry = params.sessionEntry;
  if (
    !entry?.codexThreadId &&
    !isCodexAppServerProvider(entry?.providerOverride ?? "", params.cfg)
  ) {
    return "Codex is not bound in this conversation.";
  }
  const lines = ["Codex binding active."];
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

  if (action === "help") {
    return stopWithText(resolveHelpText());
  }

  if (action === "status") {
    return stopWithText(resolveStatusText(params));
  }

  if (action === "detach") {
    await updateCodexSession(params, {
      providerOverride: undefined,
      codexAutoRoute: false,
      pendingUserInputRequestId: undefined,
      pendingUserInputOptions: undefined,
      pendingUserInputExpiresAt: undefined,
    });
    return stopWithText(
      "Codex detached from this conversation. The remote thread was left intact.",
    );
  }

  if (action === "new" || action === "spawn") {
    const parsed = parseNewArguments(tokens);
    if ("error" in parsed) {
      return stopWithText(`⚠️ ${parsed.error}`);
    }
    await updateCodexSession(params, {
      providerOverride: "codex-app-server",
      codexThreadId: undefined,
      codexProjectKey: parsed.cwd ?? params.workspaceDir,
      codexAutoRoute: true,
      pendingUserInputRequestId: undefined,
      pendingUserInputOptions: undefined,
      pendingUserInputExpiresAt: undefined,
    });
    if (!parsed.prompt) {
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
    await updateCodexSession(params, {
      providerOverride: "codex-app-server",
      codexAutoRoute: true,
    });
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
      workspaceDir: params.workspaceDir,
      filter: token,
    });
    const selected = pickBestThread(threads, token);
    if (!selected) {
      return stopWithText(`No Codex thread matched: ${token}`);
    }
    await updateCodexSession(params, {
      providerOverride: "codex-app-server",
      codexThreadId: selected.threadId,
      codexProjectKey: selected.projectKey ?? params.workspaceDir,
      codexAutoRoute: true,
      pendingUserInputRequestId: undefined,
      pendingUserInputOptions: undefined,
      pendingUserInputExpiresAt: undefined,
    });
    return stopWithText(`Codex thread bound.\n${summarizeThread(selected)}`);
  }

  return stopWithText(resolveHelpText());
};
