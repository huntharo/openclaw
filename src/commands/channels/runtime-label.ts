import { findChatChannelMeta } from "../../channels/chat-meta.js";
import { getChannelPlugin } from "../../channels/plugins/index.js";
import type { ChatChannel } from "./shared.js";

/** Display metadata does not admit a channel implementation. */
export const channelLabel = (channel: ChatChannel) => {
  return getChannelPlugin(channel)?.meta.label ?? findChatChannelMeta(channel)?.label ?? channel;
};
