import { spawn } from "node:child_process";
import type { OpenClawConfig } from "../config/config.js";
import { updateSessionStore } from "../config/sessions.js";
import { listAllDiscordThreadBindings } from "../discord/monitor/thread-bindings.lifecycle.js";
import {
  loadCombinedSessionStoreForGateway,
  resolveGatewaySessionStoreTarget,
} from "../gateway/session-utils.js";
import type { SessionBindingRecord } from "../infra/outbound/session-binding-service.js";
import {
  getSessionBindingService,
  isSessionBindingError,
  type SessionBindingErrorCode,
} from "../infra/outbound/session-binding-service.js";
import { listAllTelegramThreadBindings } from "../telegram/thread-bindings.js";
import { isCodexBoundSessionKey } from "./codex-app-server-bindings.js";
import {
  resolveCodexAppServerSettings,
  type CodexAppServerSettings,
} from "./codex-app-server-config.js";
import { normalizeProviderId } from "./model-selection.js";

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export type CodexAppServerRuntimeState = "unknown" | "disabled" | "ready" | "unavailable";

export type CodexAppServerRuntimeStatus = {
  state: CodexAppServerRuntimeState;
  transport: "stdio" | "websocket";
  checkedAt?: number;
  command?: string;
  url?: string;
  error?: string;
};

export type CodexPendingInputReconcileResult = {
  checked: number;
  cleared: number;
  failed: number;
};

export type CodexBoundSessionReconcileResult = {
  checked: number;
  repaired: number;
  removed: number;
  failed: number;
  staleSessionKeys: string[];
  failureDetails: string[];
};

let runtimeStatus: CodexAppServerRuntimeStatus = {
  state: "unknown",
  transport: "stdio",
};

function setRuntimeStatus(next: CodexAppServerRuntimeStatus): CodexAppServerRuntimeStatus {
  runtimeStatus = next;
  return getCodexAppServerRuntimeStatus();
}

export function getCodexAppServerRuntimeStatus(): CodexAppServerRuntimeStatus {
  return { ...runtimeStatus };
}

function formatRegisteredMessage(settings: CodexAppServerSettings): string {
  if (settings.transport === "websocket") {
    return `codex app server runtime registered (transport=websocket, url: ${settings.url ?? "<missing>"})`;
  }
  const argsLabel = settings.args.length > 0 ? `, args: ${settings.args.join(" ")}` : "";
  return `codex app server runtime registered (transport=stdio, command: ${settings.command}${argsLabel})`;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return String(error);
}

async function probeStdioCodexAppServer(params: {
  command: string;
  args: string[];
  timeoutMs: number;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stderr: string[] = [];
    const child = spawn(params.command, ["app-server", ...params.args, "--help"], {
      stdio: ["ignore", "ignore", "pipe"],
      env: process.env,
    });

    const timer = setTimeout(
      () => {
        child.kill();
        reject(new Error(`timed out after ${params.timeoutMs}ms`));
      },
      Math.max(250, params.timeoutMs),
    );

    child.stderr?.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        stderr.push(text);
      }
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if ((code ?? 0) === 0) {
        resolve();
        return;
      }
      reject(
        new Error(stderr.join("\n").trim() || `codex app-server --help exited with code ${code}`),
      );
    });
  });
}

export async function initializeCodexAppServerRuntime(params: {
  cfg?: OpenClawConfig;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
  probeStdio?: (input: { command: string; args: string[]; timeoutMs: number }) => Promise<void>;
}): Promise<CodexAppServerRuntimeStatus> {
  const settings = resolveCodexAppServerSettings(params.cfg);
  const checkedAt = Date.now();

  if (!settings.enabled) {
    return setRuntimeStatus({
      state: "disabled",
      transport: settings.transport,
      checkedAt,
      command: settings.transport === "stdio" ? settings.command : undefined,
      url: settings.transport === "websocket" ? settings.url : undefined,
    });
  }

  params.log.info(formatRegisteredMessage(settings));

  if (settings.transport === "websocket") {
    if (!settings.url) {
      const error = 'agents.defaults.codexAppServer.url is required when transport="websocket"';
      params.log.warn(`codex app server runtime setup failed: ${error}`);
      return setRuntimeStatus({
        state: "unavailable",
        transport: settings.transport,
        checkedAt,
        url: settings.url,
        error,
      });
    }
    params.log.info("codex app server runtime ready (websocket transport configured)");
    return setRuntimeStatus({
      state: "ready",
      transport: settings.transport,
      checkedAt,
      url: settings.url,
    });
  }

  try {
    await (params.probeStdio ?? probeStdioCodexAppServer)({
      command: settings.command,
      args: settings.args,
      timeoutMs: Math.min(settings.requestTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS),
    });
    params.log.info("codex app server runtime ready");
    return setRuntimeStatus({
      state: "ready",
      transport: settings.transport,
      checkedAt,
      command: settings.command,
    });
  } catch (error) {
    const message = formatErrorMessage(error);
    params.log.warn(`codex app server runtime setup failed: ${message}`);
    return setRuntimeStatus({
      state: "unavailable",
      transport: settings.transport,
      checkedAt,
      command: settings.command,
      error: message,
    });
  }
}

export function getCodexAppServerAvailabilityError(cfg?: OpenClawConfig): string | null {
  const settings = resolveCodexAppServerSettings(cfg);
  if (!settings.enabled) {
    return 'Provider "codex-app-server" is disabled. Set agents.defaults.codexAppServer.enabled=true.';
  }

  const status = getCodexAppServerRuntimeStatus();
  if (status.state !== "unavailable") {
    return null;
  }

  return `Codex App Server runtime is unavailable: ${status.error ?? "startup probe failed"}`;
}

function hasPendingCodexInput(entry: Record<string, unknown> | undefined): boolean {
  const requestId =
    typeof entry?.pendingUserInputRequestId === "string"
      ? entry.pendingUserInputRequestId.trim()
      : "";
  return requestId.length > 0;
}

function isPendingCodexInputExpired(
  entry: Record<string, unknown> | undefined,
  now: number,
): boolean {
  if (!hasPendingCodexInput(entry)) {
    return false;
  }
  return (
    typeof entry?.pendingUserInputExpiresAt === "number" && entry.pendingUserInputExpiresAt <= now
  );
}

function listPersistedCodexBindingsOnStartup(): SessionBindingRecord[] {
  const discordBindings: SessionBindingRecord[] = listAllDiscordThreadBindings().map((binding) => ({
    bindingId: `${binding.accountId}:${binding.threadId}`,
    targetSessionKey: binding.targetSessionKey,
    targetKind: binding.targetKind === "subagent" ? "subagent" : "session",
    conversation: {
      channel: "discord",
      accountId: binding.accountId,
      conversationId: binding.threadId,
      ...(binding.channelId ? { parentConversationId: binding.channelId } : {}),
    },
    status: "active",
    boundAt: binding.boundAt,
  }));
  const telegramBindings: SessionBindingRecord[] = listAllTelegramThreadBindings().map(
    (binding) => ({
      bindingId: `${binding.accountId}:${binding.conversationId}`,
      targetSessionKey: binding.targetSessionKey,
      targetKind: binding.targetKind === "subagent" ? "subagent" : "session",
      conversation: {
        channel: "telegram",
        accountId: binding.accountId,
        conversationId: binding.conversationId,
      },
      status: "active",
      boundAt: binding.boundAt,
    }),
  );
  return [...discordBindings, ...telegramBindings].filter(
    (binding) =>
      binding.targetKind === "session" && isCodexBoundSessionKey(binding.targetSessionKey),
  );
}

function needsCodexBoundSessionRepair(entry: Record<string, unknown> | undefined): boolean {
  return (
    normalizeProviderId(
      typeof entry?.providerOverride === "string" ? entry.providerOverride : "",
    ) !== "codex-app-server" || entry?.codexAutoRoute === false
  );
}

function resolveCodexStartupChannel(
  entry: Record<string, unknown> | undefined,
): string | undefined {
  const directChannel =
    typeof entry?.channel === "string" ? entry.channel.trim().toLowerCase() : "";
  if (directChannel) {
    return directChannel;
  }
  const originProvider =
    typeof entry?.origin === "object" &&
    entry.origin &&
    typeof (entry.origin as { provider?: unknown }).provider === "string"
      ? (entry.origin as { provider?: string }).provider?.trim().toLowerCase()
      : "";
  if (originProvider) {
    return originProvider;
  }
  return undefined;
}

function resolveTelegramStartupConversationId(
  entry: Record<string, unknown> | undefined,
): string | undefined {
  const groupId = typeof entry?.groupId === "string" ? entry.groupId.trim() : "";
  if (groupId) {
    return groupId;
  }
  const origin =
    typeof entry?.origin === "object" && entry.origin
      ? (entry.origin as Record<string, unknown>)
      : {};
  const targetRaw = typeof origin.to === "string" ? origin.to.trim() : "";
  if (!targetRaw) {
    return undefined;
  }
  const topicThreadId =
    typeof origin.threadId === "string"
      ? origin.threadId.trim()
      : typeof origin.threadId === "number" || typeof origin.threadId === "bigint"
        ? String(origin.threadId).trim()
        : "";
  const chatId = targetRaw
    .replace(/^telegram:(group:)?/i, "")
    .replace(/:topic:\d+$/i, "")
    .trim();
  if (!chatId) {
    return undefined;
  }
  if (topicThreadId) {
    return `${chatId}:topic:${topicThreadId}`;
  }
  return chatId.startsWith("-") ? undefined : chatId;
}

function resolveCodexStartupConversation(
  entry: Record<string, unknown> | undefined,
): SessionBindingRecord["conversation"] | null {
  const channel = resolveCodexStartupChannel(entry);
  if (channel !== "telegram") {
    return null;
  }
  const accountId =
    typeof entry?.origin === "object" &&
    entry.origin &&
    typeof (entry.origin as { accountId?: unknown }).accountId === "string"
      ? (entry.origin as { accountId?: string }).accountId?.trim() || "default"
      : "default";
  const conversationId = resolveTelegramStartupConversationId(entry);
  if (!conversationId) {
    return null;
  }
  const topicMatch = /^(.+?):topic:\d+$/.exec(conversationId);
  return {
    channel: "telegram",
    accountId,
    conversationId,
    ...(topicMatch?.[1] ? { parentConversationId: topicMatch[1] } : {}),
  };
}

async function unbindCodexStartupBinding(bindingId: string): Promise<number> {
  const removed = await getSessionBindingService().unbind({
    bindingId,
    reason: "stale-session",
  });
  return removed.length;
}

async function bindCodexStartupBinding(params: {
  targetSessionKey: string;
  conversation: SessionBindingRecord["conversation"];
}): Promise<void> {
  await getSessionBindingService().bind({
    targetSessionKey: params.targetSessionKey,
    targetKind: "session",
    conversation: params.conversation,
    metadata: {
      boundBy: "system",
      source: "codex",
    },
  });
}

function resolveSessionBindingErrorCode(error: unknown): SessionBindingErrorCode | undefined {
  return isSessionBindingError(error) ? error.code : undefined;
}

function formatCodexStartupFailureDetail(params: {
  sessionKey: string;
  conversationId?: string;
  error: unknown;
}): string {
  const code = resolveSessionBindingErrorCode(params.error);
  const message = params.error instanceof Error ? params.error.message : String(params.error);
  return `${params.sessionKey}${params.conversationId ? ` (${params.conversationId})` : ""}${code ? ` [${code}]` : ""}: ${message}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function bindCodexStartupBindingWithRetry(params: {
  targetSessionKey: string;
  conversation: SessionBindingRecord["conversation"];
  bindBinding?: (params: {
    targetSessionKey: string;
    conversation: SessionBindingRecord["conversation"];
  }) => Promise<void>;
}): Promise<void> {
  const bind = params.bindBinding ?? bindCodexStartupBinding;
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await bind({
        targetSessionKey: params.targetSessionKey,
        conversation: params.conversation,
      });
      return;
    } catch (error) {
      lastError = error;
      if (
        resolveSessionBindingErrorCode(error) !== "BINDING_ADAPTER_UNAVAILABLE" ||
        attempt === 4
      ) {
        throw error;
      }
      await sleep(100 * (attempt + 1));
    }
  }
  throw lastError;
}

async function repairCodexBoundSessionEntry(params: {
  cfg: OpenClawConfig;
  store: Record<string, Record<string, unknown>>;
  sessionKey: string;
  entry: Record<string, unknown>;
  now: number;
}): Promise<boolean> {
  if (!needsCodexBoundSessionRepair(params.entry)) {
    return false;
  }
  const target = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.sessionKey,
  });
  await updateSessionStore(target.storePath, (nextStore) => {
    const liveTarget = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.sessionKey,
      store: nextStore,
    });
    const storeKey =
      [liveTarget.canonicalKey, ...liveTarget.storeKeys].find(
        (candidate) => nextStore[candidate],
      ) ?? liveTarget.canonicalKey;
    const entry = nextStore[storeKey];
    if (!entry) {
      return;
    }
    entry.providerOverride = "codex-app-server";
    entry.codexAutoRoute = true;
    entry.updatedAt = params.now;
    nextStore[storeKey] = entry;
  });
  params.store[params.sessionKey] = {
    ...params.entry,
    providerOverride: "codex-app-server",
    codexAutoRoute: true,
    updatedAt: params.now,
  };
  return true;
}

export async function reconcileCodexBoundSessionsOnStartup(params: {
  cfg: OpenClawConfig;
  listBindings?: () => SessionBindingRecord[];
  unbindBinding?: (bindingId: string) => Promise<number>;
  bindBinding?: (params: {
    targetSessionKey: string;
    conversation: SessionBindingRecord["conversation"];
  }) => Promise<void>;
}): Promise<CodexBoundSessionReconcileResult> {
  const bindings = (params.listBindings ?? listPersistedCodexBindingsOnStartup)().filter(
    (binding) =>
      binding.targetKind === "session" && isCodexBoundSessionKey(binding.targetSessionKey),
  );
  const { store } = loadCombinedSessionStoreForGateway(params.cfg);
  const boundSessionEntries = Object.entries(store).filter(
    ([sessionKey, entry]) =>
      isCodexBoundSessionKey(sessionKey) &&
      typeof entry === "object" &&
      entry !== null &&
      resolveCodexStartupConversation(entry as Record<string, unknown>),
  );
  const bindingsBySessionKey = new Map(
    bindings.map((binding) => [binding.targetSessionKey.trim(), binding]),
  );
  let checked = bindings.length;
  let removed = 0;
  let failed = 0;
  const staleSessionKeys = new Set<string>();
  const repairedSessionKeys = new Set<string>();
  const failureDetails: string[] = [];
  const now = Date.now();

  for (const binding of bindings) {
    const sessionKey = binding.targetSessionKey.trim();
    if (!sessionKey) {
      continue;
    }
    const existing = store[sessionKey];
    if (!existing) {
      staleSessionKeys.add(sessionKey);
      try {
        removed += await (params.unbindBinding ?? unbindCodexStartupBinding)(binding.bindingId);
      } catch {
        failed += 1;
      }
      continue;
    }
    try {
      if (
        await repairCodexBoundSessionEntry({
          cfg: params.cfg,
          store,
          sessionKey,
          entry: existing,
          now,
        })
      ) {
        repairedSessionKeys.add(sessionKey);
      }
    } catch (error) {
      failed += 1;
      failureDetails.push(
        formatCodexStartupFailureDetail({
          sessionKey,
          conversationId: binding.conversation.conversationId,
          error,
        }),
      );
    }
  }

  for (const [sessionKey, entry] of boundSessionEntries) {
    if (bindingsBySessionKey.has(sessionKey)) {
      continue;
    }
    const conversation = resolveCodexStartupConversation(entry as Record<string, unknown>);
    if (!conversation) {
      continue;
    }
    checked += 1;
    try {
      await bindCodexStartupBindingWithRetry({
        targetSessionKey: sessionKey,
        conversation,
        bindBinding: params.bindBinding,
      });
      bindingsBySessionKey.set(sessionKey, {
        bindingId: `${conversation.accountId}:${conversation.conversationId}`,
        targetSessionKey: sessionKey,
        targetKind: "session",
        conversation,
        status: "active",
        boundAt: now,
      });
      repairedSessionKeys.add(sessionKey);
      if (
        await repairCodexBoundSessionEntry({
          cfg: params.cfg,
          store,
          sessionKey,
          entry: entry as Record<string, unknown>,
          now,
        })
      ) {
        repairedSessionKeys.add(sessionKey);
      }
    } catch (error) {
      failed += 1;
      failureDetails.push(
        formatCodexStartupFailureDetail({
          sessionKey,
          conversationId: conversation.conversationId,
          error,
        }),
      );
    }
  }

  return {
    checked,
    repaired: repairedSessionKeys.size,
    removed,
    failed,
    staleSessionKeys: [...staleSessionKeys],
    failureDetails,
  };
}

export async function reconcileCodexPendingInputsOnStartup(params: {
  cfg: OpenClawConfig;
}): Promise<CodexPendingInputReconcileResult> {
  const now = Date.now();
  const { store } = loadCombinedSessionStoreForGateway(params.cfg);
  const pendingKeys = Object.entries(store)
    .filter(([, entry]) => hasPendingCodexInput(entry as Record<string, unknown>))
    .map(([key]) => key);

  let cleared = 0;
  let failed = 0;
  for (const key of pendingKeys) {
    const target = resolveGatewaySessionStoreTarget({ cfg: params.cfg, key });
    try {
      await updateSessionStore(target.storePath, (nextStore) => {
        const liveTarget = resolveGatewaySessionStoreTarget({
          cfg: params.cfg,
          key,
          store: nextStore,
        });
        const storeKey =
          [liveTarget.canonicalKey, ...liveTarget.storeKeys].find(
            (candidate) => nextStore[candidate],
          ) ?? liveTarget.canonicalKey;
        const entry = nextStore[storeKey];
        if (!entry || !isPendingCodexInputExpired(entry as Record<string, unknown>, now)) {
          return;
        }
        entry.pendingUserInputRequestId = undefined;
        entry.pendingUserInputOptions = undefined;
        entry.pendingUserInputExpiresAt = undefined;
        entry.pendingUserInputPromptText = undefined;
        entry.pendingUserInputMethod = undefined;
        entry.updatedAt = now;
        nextStore[storeKey] = entry;
        cleared += 1;
      });
    } catch {
      failed += 1;
    }
  }

  return {
    checked: pendingKeys.length,
    cleared,
    failed,
  };
}

export const __testing = {
  resetRuntimeStatus() {
    runtimeStatus = { state: "unknown", transport: "stdio" };
  },
};
