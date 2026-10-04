import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { buildProviderKeyboard, type ProviderInfo } from "./model-buttons.js";

export function buildCommandsPaginationKeyboard(
  currentPage: number,
  totalPages: number,
  agentId?: string,
): Array<Array<{ text: string; callback_data: string }>> {
  const buttons: Array<{ text: string; callback_data: string }> = [];
  const suffix = agentId ? `:${agentId}` : "";

  if (currentPage > 1) {
    buttons.push({
      text: "◀ Prev",
      callback_data: `commands_page_${currentPage - 1}${suffix}`,
    });
  }

  buttons.push({
    text: `${currentPage}/${totalPages}`,
    callback_data: `commands_page_noop${suffix}`,
  });

  if (currentPage < totalPages) {
    buttons.push({
      text: "Next ▶",
      callback_data: `commands_page_${currentPage + 1}${suffix}`,
    });
  }

  return [buttons];
}

export function buildTelegramModelsProviderChannelData(params: {
  providers: ProviderInfo[];
}): ReplyPayload["channelData"] | null {
  if (params.providers.length === 0) {
    return null;
  }
  return {
    telegram: {
      buttons: buildProviderKeyboard(params.providers),
    },
  };
}
