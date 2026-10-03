import { createPreviewMessageReceipt } from "openclaw/plugin-sdk/channel-outbound";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { TelegramDispatchTurn } from "./bot-message-dispatch.types.js";
import { emitTelegramMessageSentHooks } from "./bot/delivery.js";
import type { TelegramInlineButtons } from "./button-types.js";
import { canonicalizeTelegramPresentationPayload } from "./interactive-fallback.js";
import { editMessageTelegram } from "./send.js";

export async function deliverTelegramCallbackReply(
  turn: TelegramDispatchTurn,
  payload: ReplyPayload,
  callbackReply: NonNullable<TelegramDispatchTurn["callbackReply"]>,
) {
  await callbackReply.revalidate();
  callbackReply.assertCurrent();
  const normalized = canonicalizeTelegramPresentationPayload(payload, {
    allowWebAppButtons: !turn.context.isGroup,
    richTables: turn.richMessages,
  });
  // SAFETY: Telegram channelData carries inline buttons; the existing edit owner encodes them.
  const telegramData = normalized.channelData?.telegram as
    | { buttons?: TelegramInlineButtons }
    | undefined;
  const text = normalized.text?.trim();
  if (!text || payload.mediaUrl || payload.mediaUrls?.length) {
    throw new Error("This menu response cannot replace its source. Send the command again.");
  }
  const edit = turn.telegramDeps.editMessageTelegram ?? editMessageTelegram;
  await edit(turn.context.chatId, callbackReply.messageId, text, {
    cfg: turn.cfg,
    token: turn.opts.token,
    accountId: turn.context.route.accountId,
    api: turn.bot.api,
    buttons: telegramData?.buttons ?? [],
    businessConnectionId: callbackReply.businessConnectionId,
    editMode: "auto",
    signal: callbackReply.abortSignal,
    assertPlatformSendAuthorized: callbackReply.assertCurrent,
  });
  const receipt = createPreviewMessageReceipt({ id: callbackReply.messageId });
  turn.deliveryState.markDelivered();
  (turn.telegramDeps.emitTelegramMessageSentHooks ?? emitTelegramMessageSentHooks)({
    sessionKeyForInternalHooks: turn.context.ctxPayload.SessionKey,
    chatId: String(turn.context.chatId),
    accountId: turn.context.route.accountId,
    content: text,
    success: true,
    messageId: callbackReply.messageId,
    isGroup: turn.context.isGroup,
    groupId: turn.context.isGroup ? String(turn.context.chatId) : undefined,
  });
  return { visibleReplySent: true, receipt };
}
