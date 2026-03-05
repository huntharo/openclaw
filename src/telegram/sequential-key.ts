import { type Message, type UserFromGetMe } from "@grammyjs/types";
import { isAbortRequestText } from "../auto-reply/reply/abort.js";
import { resolveTelegramForumThreadId } from "./bot/helpers.js";

export type TelegramSequentialKeyContext = {
  chat?: { id?: number };
  me?: UserFromGetMe;
  message?: Message;
  callbackQuery?: { data?: string; message?: Message };
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

const CODEX_INPUT_CALLBACK_RE = /^codex_input:(?:[^:]+:)?[1-9]\d*$/i;
const CODEX_PENDING_INPUT_PROMPT_RE = /agent input requested/i;

function buildControlLaneKey(chatId?: number, threadId?: number): string {
  if (typeof chatId !== "number") {
    return "telegram:control";
  }
  return threadId != null
    ? `telegram:${chatId}:topic:${threadId}:control`
    : `telegram:${chatId}:control`;
}

export function getTelegramSequentialKey(ctx: TelegramSequentialKeyContext): string {
  const reaction = ctx.update?.message_reaction;
  if (reaction?.chat?.id) {
    return `telegram:${reaction.chat.id}`;
  }
  const callbackData = (ctx.callbackQuery?.data ?? ctx.update?.callback_query?.data ?? "").trim();
  const msg =
    ctx.message ??
    ctx.callbackQuery?.message ??
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
  if (isAbortRequestText(rawText, botUsername ? { botUsername } : undefined)) {
    if (typeof chatId === "number") {
      return `telegram:${chatId}:control`;
    }
    return "telegram:control";
  }
  const isGroup = msg?.chat?.type === "group" || msg?.chat?.type === "supergroup";
  const messageThreadId = msg?.message_thread_id;
  const isForum = msg?.chat?.is_forum;
  const threadId = isGroup
    ? resolveTelegramForumThreadId({ isForum, messageThreadId })
    : messageThreadId;
  if (CODEX_INPUT_CALLBACK_RE.test(callbackData)) {
    return buildControlLaneKey(chatId, threadId);
  }
  const repliedToText = (
    msg?.reply_to_message?.text ??
    msg?.reply_to_message?.caption ??
    ""
  ).trim();
  const repliedToHasButtons =
    ((msg?.reply_to_message as { reply_markup?: { inline_keyboard?: unknown[] } } | undefined)
      ?.reply_markup?.inline_keyboard?.length ?? 0) > 0;
  if (
    repliedToHasButtons &&
    CODEX_PENDING_INPUT_PROMPT_RE.test(repliedToText) &&
    typeof rawText === "string" &&
    rawText.trim().length > 0
  ) {
    return buildControlLaneKey(chatId, threadId);
  }
  if (typeof chatId === "number") {
    return threadId != null ? `telegram:${chatId}:topic:${threadId}` : `telegram:${chatId}`;
  }
  return "telegram:unknown";
}
