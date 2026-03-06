import { spawn } from "node:child_process";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveCodexAppServerSettings,
  type CodexAppServerSettings,
} from "./codex-app-server-config.js";

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

export const __testing = {
  resetRuntimeStatus() {
    runtimeStatus = { state: "unknown", transport: "stdio" };
  },
};
