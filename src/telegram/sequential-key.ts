import { type Message, type UserFromGetMe } from "@grammyjs/types";
import { isCodexAppServerAwaitingInputBySessionKey } from "../agents/codex-app-server-runs.js";
import { isAbortRequestText } from "../auto-reply/reply/abort.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import { resolveTelegramForumThreadId } from "./bot/helpers.js";

export type TelegramSequentialKeyContext = {
  chat?: { id?: number };
  me?: UserFromGetMe;
  message?: Message;
  channelPost?: Message;
  editedChannelPost?: Message;
  update?: {
    message?: Message;
    edited_message?: Message;
    channel_post?: Message;
    edited_channel_post?: Message;
    callback_query?: { data?: string; message?: Message };
    message_reaction?: { chat?: { id?: number } };
  };
};

function resolveTelegramControlLane(params: { chatId?: number; threadId?: number | null }): string {
  if (typeof params.chatId !== "number") {
    return "telegram:control";
  }
  return params.threadId != null
    ? `telegram:${params.chatId}:topic:${params.threadId}:control`
    : `telegram:${params.chatId}:control`;
}

function resolveTelegramConversationId(params: {
  chatId?: number;
  threadId?: number | null;
}): string | null {
  if (typeof params.chatId !== "number") {
    return null;
  }
  return params.threadId != null
    ? `${params.chatId}:topic:${params.threadId}`
    : String(params.chatId);
}

function shouldUseCodexPendingInputControlLane(params: {
  accountId?: string;
  conversationId: string | null;
}): boolean {
  if (!params.conversationId) {
    return false;
  }
  const binding = getSessionBindingService().resolveByConversation({
    channel: "telegram",
    accountId: params.accountId ?? "default",
    conversationId: params.conversationId,
  });
  const targetSessionKey = binding?.targetSessionKey?.trim();
  if (!targetSessionKey) {
    return false;
  }
  return isCodexAppServerAwaitingInputBySessionKey(targetSessionKey);
}

export function getTelegramSequentialKey(
  ctx: TelegramSequentialKeyContext,
  opts?: { accountId?: string },
): string {
  const reaction = ctx.update?.message_reaction;
  if (reaction?.chat?.id) {
    return `telegram:${reaction.chat.id}`;
  }
  const msg =
    ctx.message ??
    ctx.channelPost ??
    ctx.editedChannelPost ??
    ctx.update?.message ??
    ctx.update?.edited_message ??
    ctx.update?.channel_post ??
    ctx.update?.edited_channel_post ??
    ctx.update?.callback_query?.message;
  const chatId = msg?.chat?.id ?? ctx.chat?.id;
  const rawText = msg?.text ?? msg?.caption;
  const botUsername = ctx.me?.username;
  const callbackData =
    ctx.update?.callback_query && "data" in ctx.update.callback_query
      ? typeof ctx.update.callback_query.data === "string"
        ? ctx.update.callback_query.data.trim()
        : ""
      : "";
  if (isAbortRequestText(rawText, botUsername ? { botUsername } : undefined)) {
    return resolveTelegramControlLane({ chatId });
  }
  const isGroup = msg?.chat?.type === "group" || msg?.chat?.type === "supergroup";
  const messageThreadId = msg?.message_thread_id;
  const isForum = msg?.chat?.is_forum;
  const threadId = isGroup
    ? resolveTelegramForumThreadId({ isForum, messageThreadId })
    : messageThreadId;
  const conversationId = resolveTelegramConversationId({ chatId, threadId });
  if (callbackData.startsWith("cdxui:")) {
    return resolveTelegramControlLane({ chatId, threadId });
  }
  if (shouldUseCodexPendingInputControlLane({ accountId: opts?.accountId, conversationId })) {
    return resolveTelegramControlLane({ chatId, threadId });
  }
  if (typeof chatId === "number") {
    return threadId != null ? `telegram:${chatId}:topic:${threadId}` : `telegram:${chatId}`;
  }
  return "telegram:unknown";
}
