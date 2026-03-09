import { createHash } from "node:crypto";
import { normalizeAccountId, sanitizeAgentId } from "../routing/session-key.js";

export type CodexBoundConversationSpec = {
  channel: "discord" | "telegram";
  accountId: string;
  conversationId: string;
  agentId: string;
};

function buildBindingHash(params: {
  channel: "discord" | "telegram";
  accountId: string;
  conversationId: string;
}): string {
  return createHash("sha256")
    .update(`${params.channel}:${params.accountId}:${params.conversationId}`)
    .digest("hex")
    .slice(0, 16);
}

export function buildCodexBoundSessionKey(spec: CodexBoundConversationSpec): string {
  const channel = spec.channel;
  const accountId = normalizeAccountId(spec.accountId);
  const conversationId = spec.conversationId.trim();
  const hash = buildBindingHash({
    channel,
    accountId,
    conversationId,
  });
  return `agent:${sanitizeAgentId(spec.agentId)}:codex:binding:${channel}:${accountId}:${hash}`;
}

export function isCodexBoundSessionKey(value: string | undefined | null): boolean {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return /^agent:[^:]+:codex:binding:(discord|telegram):[^:]+:[a-f0-9]{16}$/.test(trimmed);
}
