import type { OpenClawConfig } from "../config/config.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_INPUT_TIMEOUT_MS = 15 * 60_000;

export type CodexAppServerSettings = {
  enabled: boolean;
  transport: "stdio" | "websocket";
  command: string;
  args: string[];
  url?: string;
  headers?: Record<string, string>;
  requestTimeoutMs: number;
  inputTimeoutMs: number;
};

export function resolveCodexAppServerSettings(cfg?: OpenClawConfig): CodexAppServerSettings {
  const configured = cfg?.agents?.defaults?.codexAppServer;
  const transport = configured?.transport === "websocket" ? "websocket" : "stdio";
  const command = configured?.command?.trim() || "codex";
  const args = configured?.args?.filter((value) => value.trim()) ?? [];
  const authHeaders = {
    ...configured?.headers,
    ...(configured?.authToken?.trim()
      ? { Authorization: `Bearer ${configured.authToken.trim()}` }
      : {}),
  };
  return {
    enabled: configured?.enabled !== false,
    transport,
    command,
    args,
    url: configured?.url?.trim() || undefined,
    headers: Object.keys(authHeaders).length > 0 ? authHeaders : undefined,
    requestTimeoutMs: configured?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    inputTimeoutMs: configured?.inputTimeoutMs ?? DEFAULT_INPUT_TIMEOUT_MS,
  };
}
