import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import {
  buildPaginationRow,
  buildProviderKeyboard,
  type ButtonRow,
  type ProviderInfo,
} from "./model-buttons.js";

function withTelegramButtons(buttons: ButtonRow[]): ReplyPayload["channelData"] {
  return { telegram: { buttons } };
}

export function buildCommandsPaginationKeyboard(
  currentPage: number,
  totalPages: number,
  agentId?: string,
): Array<Array<{ text: string; callback_data: string }>> {
  const suffix = agentId ? `:${agentId}` : "";
  return [
    buildPaginationRow(
      currentPage,
      totalPages,
      (page) => `commands_page_${page ?? "noop"}${suffix}`,
    ),
  ];
}

export function buildTelegramModelsProviderChannelData(params: {
  providers: ProviderInfo[];
}): ReplyPayload["channelData"] | null {
  if (params.providers.length === 0) {
    return null;
  }
  return withTelegramButtons(buildProviderKeyboard(params.providers));
}
