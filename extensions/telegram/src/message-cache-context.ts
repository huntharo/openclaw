import type { Message } from "grammy/types";
import {
  compareCachedMessageNodes,
  normalizeMessageNode,
  resolveReplyMessage,
  type TelegramCachedMessageNode,
} from "./message-cache-codec.js";
import type { TelegramMessageCache } from "./message-cache.js";
import { parseTelegramMessageThreadId } from "./outbound-params.js";

type TelegramConversationContextNode = {
  node: TelegramCachedMessageNode;
  isReplyTarget?: boolean;
};

function normalizeSessionBoundaryTimestamp(timestampMs?: number): number | undefined {
  if (typeof timestampMs !== "number" || !Number.isFinite(timestampMs)) {
    return undefined;
  }
  return Math.floor(timestampMs / 1000) * 1000;
}

function isAtOrAfterSessionBoundaryTimestamp(
  node: TelegramCachedMessageNode,
  boundaryTimestampMs?: number,
): boolean {
  if (boundaryTimestampMs === undefined) {
    return true;
  }
  return typeof node.timestamp !== "number" || !Number.isFinite(node.timestamp)
    ? true
    : node.timestamp >= boundaryTimestampMs;
}

/**
 * Hard cap on reply-chain nodes rendered into the prompt. Model-visible context
 * must be bounded; every producer that appends chain entries shares this ceiling
 * so a busy chat cannot grow the turn past its budget.
 */
export const TELEGRAM_REPLY_CHAIN_MAX_DEPTH = 4;

export async function buildTelegramReplyChain(params: {
  cache: TelegramMessageCache;
  accountId: string;
  chatId: string | number;
  msg: Message;
  maxDepth?: number;
}): Promise<TelegramCachedMessageNode[]> {
  const replyMessage = resolveReplyMessage(params.msg);
  if (!replyMessage?.message_id || String(replyMessage.chat?.id) !== String(params.chatId)) {
    return [];
  }
  const maxDepth = params.maxDepth ?? TELEGRAM_REPLY_CHAIN_MAX_DEPTH;
  const visited = new Set<string>();
  const chain: TelegramCachedMessageNode[] = [];
  let current: TelegramCachedMessageNode | null = await params.cache.get({
    accountId: params.accountId,
    chatId: params.chatId,
    businessConnectionId: params.msg.business_connection_id,
    messageId: String(replyMessage.message_id),
  });
  if (!current && params.msg.reply_to_message) {
    current = normalizeMessageNode(params.msg.reply_to_message, {
      businessConnectionId: params.msg.business_connection_id,
      threadId:
        parseTelegramMessageThreadId(params.msg.reply_to_message.message_thread_id) ??
        parseTelegramMessageThreadId(params.msg.message_thread_id),
    });
  }

  while (current?.messageId && chain.length < maxDepth && !visited.has(current.messageId)) {
    visited.add(current.messageId);
    chain.push(current);
    const embeddedReply = current.sourceMessage.reply_to_message;
    if (
      !current.replyToId ||
      chain.length >= maxDepth ||
      visited.has(current.replyToId) ||
      (embeddedReply &&
        (String(embeddedReply.chat.id) !== String(params.chatId) ||
          (embeddedReply.business_connection_id !== undefined &&
            embeddedReply.business_connection_id !== params.msg.business_connection_id)))
    ) {
      break;
    }
    const storedReply = await params.cache.get({
      accountId: params.accountId,
      chatId: params.chatId,
      businessConnectionId: params.msg.business_connection_id,
      messageId: current.replyToId,
    });
    // Legacy retained roots can contain reply snapshots without separate ancestor rows.
    current =
      storedReply ??
      (embeddedReply && String(embeddedReply.message_id) === current.replyToId
        ? normalizeMessageNode(embeddedReply, {
            businessConnectionId: params.msg.business_connection_id,
            threadId:
              parseTelegramMessageThreadId(embeddedReply.message_thread_id) ??
              parseTelegramMessageThreadId(current.threadId),
          })
        : null);
  }

  return chain;
}

export async function buildTelegramConversationContext(params: {
  cache: TelegramMessageCache;
  accountId: string;
  chatId: string | number;
  businessConnectionId?: string;
  messageId?: string;
  threadId?: number;
  replyChainNodes: TelegramCachedMessageNode[];
  recentLimit: number;
  replyTargetWindowSize: number;
  minTimestampMs?: number;
}): Promise<TelegramConversationContextNode[]> {
  const selected = new Map<string, TelegramConversationContextNode>();
  const replyTargetIds = new Set<string>();
  const sessionBoundaryTimestamp = normalizeSessionBoundaryTimestamp(params.minTimestampMs);
  const addNode = (node: TelegramCachedMessageNode, flags?: { replyTarget?: boolean }) => {
    if (
      node.sourceMessage.business_connection_id !== params.businessConnectionId ||
      !node.messageId ||
      node.messageId === params.messageId
    ) {
      return false;
    }
    if (!isAtOrAfterSessionBoundaryTimestamp(node, sessionBoundaryTimestamp)) {
      return false;
    }
    const existing = selected.get(node.messageId);
    const isReplyTarget = existing?.isReplyTarget === true || flags?.replyTarget === true;
    selected.set(node.messageId, {
      node: existing?.node ?? node,
      isReplyTarget: isReplyTarget ? true : undefined,
    });
    return true;
  };
  const addReplyTargetWindow = async (messageId: string) => {
    replyTargetIds.add(messageId);
    for (const node of await params.cache.around({
      accountId: params.accountId,
      chatId: params.chatId,
      businessConnectionId: params.businessConnectionId,
      messageId,
      ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
      before: params.replyTargetWindowSize,
      after: params.replyTargetWindowSize,
    })) {
      addNode(node, { replyTarget: node.messageId === messageId });
    }
  };

  const currentWindow = await params.cache.recentBefore({
    accountId: params.accountId,
    chatId: params.chatId,
    businessConnectionId: params.businessConnectionId,
    messageId: params.messageId,
    ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
    limit: params.recentLimit,
  });
  for (const node of currentWindow) {
    const added = addNode(node);
    if (added && node.replyToId) {
      await addReplyTargetWindow(node.replyToId);
    }
  }

  for (const [index, node] of params.replyChainNodes.entries()) {
    const added = addNode(node, { replyTarget: index === 0 });
    if (added && index === 0 && node.messageId) {
      await addReplyTargetWindow(node.messageId);
    }
    if (added && node.replyToId) {
      replyTargetIds.add(node.replyToId);
    }
  }

  for (const messageId of replyTargetIds) {
    const node = await params.cache.get({
      accountId: params.accountId,
      chatId: params.chatId,
      businessConnectionId: params.businessConnectionId,
      messageId,
    });
    if (node) {
      addNode(node, { replyTarget: true });
    }
  }

  return Array.from(selected.values()).toSorted((left, right) =>
    compareCachedMessageNodes(left.node, right.node),
  );
}
