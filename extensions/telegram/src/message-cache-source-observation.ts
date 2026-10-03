import type { Message } from "grammy/types";
import {
  preferExistingTelegramMessageObservation,
  type TelegramCachedMessageNode,
  type TelegramMessageObservationMode,
} from "./message-cache-codec.js";

function projectSource(message: Message) {
  return {
    chatId: String(message.chat.id),
    messageId: String(message.message_id),
    senderId: message.from?.id,
    senderChatId: message.sender_chat?.id,
    businessSenderId: message.sender_business_bot?.id,
    businessConnectionId: message.business_connection_id,
    threadId: message.message_thread_id,
    directTopicId: message.direct_messages_topic?.topic_id,
    date: message.date,
    edit_date: message.edit_date,
    text: message.text ?? message.caption,
    caption: message.caption,
    keyboard: message.reply_markup?.inline_keyboard.map((row) =>
      row.map((button) => ({
        text: button.text,
        style: button.style,
        icon: button.icon_custom_emoji_id,
        callback: "callback_data" in button ? button.callback_data : undefined,
        url: "url" in button ? button.url : undefined,
        webApp: "web_app" in button ? button.web_app.url : undefined,
        login: "login_url" in button ? button.login_url.url : undefined,
        loginForwardText: "login_url" in button ? button.login_url.forward_text : undefined,
        loginBot: "login_url" in button ? button.login_url.bot_username : undefined,
        loginWriteAccess: "login_url" in button ? button.login_url.request_write_access : undefined,
        copy: "copy_text" in button ? button.copy_text.text : undefined,
        switchInline: "switch_inline_query" in button ? button.switch_inline_query : undefined,
        switchCurrent:
          "switch_inline_query_current_chat" in button
            ? button.switch_inline_query_current_chat
            : undefined,
        switchChosen:
          "switch_inline_query_chosen_chat" in button
            ? {
                query: button.switch_inline_query_chosen_chat.query,
                users: button.switch_inline_query_chosen_chat.allow_user_chats,
                bots: button.switch_inline_query_chosen_chat.allow_bot_chats,
                groups: button.switch_inline_query_chosen_chat.allow_group_chats,
                channels: button.switch_inline_query_chosen_chat.allow_channel_chats,
              }
            : undefined,
        game: "callback_game" in button,
        pay: "pay" in button,
      })),
    ),
  };
}

type Source = ReturnType<typeof projectSource>;
type ActiveCapture = {
  latest?: Source;
  expected?: Source;
  invalidated: boolean;
};

export type TelegramObservedMessageCaptures = Map<string, Set<ActiveCapture>>;
export type TelegramObservedMessageCapture = Readonly<{
  capture: (admitted: TelegramCachedMessageNode, expectedSource: Message) => void;
  assertCurrent: () => void;
  dispose: () => void;
}>;

const changed = () => new Error("This menu's source changed. Send /models or /commands again.");
const sameSource = (left: Source, right: Source) => JSON.stringify(left) === JSON.stringify(right);

/** The bucket owns only active observations; no full Message or reply ancestry is retained. */
export function beginObservedMessageCapture(params: {
  captures: TelegramObservedMessageCaptures;
  key: string;
  chatId: string | number;
  messageId: string;
  businessConnectionId?: string;
}): TelegramObservedMessageCapture {
  const state: ActiveCapture = { invalidated: false };
  const watchers = params.captures.get(params.key) ?? new Set<ActiveCapture>();
  watchers.add(state);
  params.captures.set(params.key, watchers);
  let disposed = false;
  const assertCurrent = () => {
    if (
      disposed ||
      state.invalidated ||
      !state.expected ||
      !state.latest ||
      !sameSource(state.expected, state.latest)
    ) {
      throw changed();
    }
  };
  return {
    capture: (admitted, expectedSource) => {
      if (disposed || state.expected) {
        throw changed();
      }
      const expected = projectSource(expectedSource);
      const observed = projectSource(admitted.sourceMessage);
      if (
        expected.businessConnectionId !== params.businessConnectionId ||
        expected.chatId !== String(params.chatId) ||
        expected.messageId !== params.messageId ||
        admitted.messageId !== params.messageId ||
        !sameSource(expected, observed)
      ) {
        throw changed();
      }
      if (state.latest && !sameSource(state.latest, observed)) {
        throw changed();
      }
      state.latest ??= observed;
      state.expected = expected;
      assertCurrent();
    },
    assertCurrent,
    dispose: () => {
      disposed = true;
      watchers.delete(state);
      if (watchers.size === 0) {
        params.captures.delete(params.key);
      }
    },
  };
}

/** Publish the merge owner's accepted node, including retained-store compare-and-apply results. */
export function publishObservedMessageSource(
  captures: TelegramObservedMessageCaptures | undefined,
  key: string,
  node: TelegramCachedMessageNode,
  mode: TelegramMessageObservationMode,
) {
  const watchers = captures?.get(key);
  if (!watchers?.size) {
    return;
  }
  const observed = projectSource(node.sourceMessage);
  for (const state of watchers) {
    if (state.latest && preferExistingTelegramMessageObservation(state.latest, observed, mode)) {
      continue;
    }
    // Pending admission must not regain currentness after a full A-to-B-to-A publication.
    if (state.latest && !sameSource(state.latest, observed)) {
      state.invalidated = true;
    }
    state.latest = observed;
    if (state.expected && !sameSource(state.expected, observed)) {
      state.invalidated = true;
    }
  }
}

/** True/no-op edit acknowledgements invalidate active captures without inventing provider state. */
export function invalidateObservedMessageCaptures(
  captures: TelegramObservedMessageCaptures | undefined,
  key: string,
) {
  for (const state of captures?.get(key) ?? []) {
    state.invalidated = true;
  }
}
