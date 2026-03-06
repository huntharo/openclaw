import { spawn } from "node:child_process";
import type { OpenClawConfig } from "../config/config.js";
import { updateSessionStore } from "../config/sessions.js";
import { listAllDiscordThreadBindings } from "../discord/monitor/thread-bindings.lifecycle.js";
import {
  loadCombinedSessionStoreForGateway,
  resolveGatewaySessionStoreTarget,
} from "../gateway/session-utils.js";
import type { SessionBindingRecord } from "../infra/outbound/session-binding-service.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
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

async function unbindCodexStartupBinding(bindingId: string): Promise<number> {
  const removed = await getSessionBindingService().unbind({
    bindingId,
    reason: "stale-session",
  });
  return removed.length;
}

export async function reconcileCodexBoundSessionsOnStartup(params: {
  cfg: OpenClawConfig;
  listBindings?: () => SessionBindingRecord[];
  unbindBinding?: (bindingId: string) => Promise<number>;
}): Promise<CodexBoundSessionReconcileResult> {
  const bindings = (params.listBindings ?? listPersistedCodexBindingsOnStartup)().filter(
    (binding) =>
      binding.targetKind === "session" && isCodexBoundSessionKey(binding.targetSessionKey),
  );
  if (bindings.length === 0) {
    return {
      checked: 0,
      repaired: 0,
      removed: 0,
      failed: 0,
      staleSessionKeys: [],
    };
  }

  const { store } = loadCombinedSessionStoreForGateway(params.cfg);
  let repaired = 0;
  let removed = 0;
  let failed = 0;
  const staleSessionKeys = new Set<string>();
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
    if (!needsCodexBoundSessionRepair(existing)) {
      continue;
    }
    try {
      const target = resolveGatewaySessionStoreTarget({
        cfg: params.cfg,
        key: sessionKey,
      });
      await updateSessionStore(target.storePath, (nextStore) => {
        const liveTarget = resolveGatewaySessionStoreTarget({
          cfg: params.cfg,
          key: sessionKey,
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
        entry.updatedAt = now;
        nextStore[storeKey] = entry;
      });
      store[sessionKey] = {
        ...existing,
        providerOverride: "codex-app-server",
        codexAutoRoute: true,
        updatedAt: now,
      };
      repaired += 1;
    } catch {
      failed += 1;
    }
  }

  return {
    checked: bindings.length,
    repaired,
    removed,
    failed,
    staleSessionKeys: [...staleSessionKeys],
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
