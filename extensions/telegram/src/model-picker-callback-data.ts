import {
  resolveMessagePresentationButtonAction,
  type ModelPickerAction,
} from "openclaw/plugin-sdk/interactive-runtime";
import { fitsTelegramCallbackData } from "./approval-callback-data.js";

const PREFIX = "mp1:";
const INTENTS = {
  "show-providers": "p",
  "show-models": "m",
  "show-recents": "h",
  "choose-model": "s",
  "choose-runtime": "r",
  reset: "d",
  cancel: "c",
} as const;

export function hasTelegramModelPickerCallbackPrefix(data: string): boolean {
  return data.startsWith(PREFIX);
}

/** Tokens locate fresh catalog facts; this envelope carries no actor or route authority. */
export function buildTelegramModelPickerCallbackData(
  action: ModelPickerAction,
): string | undefined {
  const parts: string[] = [INTENTS[action.intent], action.snapshotToken];
  if ("providerToken" in action) {
    parts.push(action.providerToken);
  }
  if ("modelToken" in action) {
    parts.push(action.modelToken);
  }
  if ("runtimeToken" in action) {
    parts.push(action.runtimeToken);
  }
  if ("cursor" in action && action.cursor !== undefined) {
    parts.push(action.cursor);
  }
  const data = `${PREFIX}${parts.join(":")}`;
  return fitsTelegramCallbackData(data) ? data : undefined;
}

export function parseTelegramModelPickerCallbackData(data: string): ModelPickerAction | null {
  if (!hasTelegramModelPickerCallbackPrefix(data) || !fitsTelegramCallbackData(data)) {
    return null;
  }
  const [code, snapshotToken, ...tokens] = data.slice(PREFIX.length).split(":");
  const intent = Object.entries(INTENTS).find(([, value]) => value === code)?.[0];
  if (!intent || !snapshotToken) {
    return null;
  }
  const expected = intent === "choose-runtime" ? 3 : intent === "choose-model" ? 2 : 0;
  const modelPage = intent === "show-models";
  const paginated = modelPage || intent === "show-providers" || intent === "show-recents";
  const minimum = modelPage ? 1 : expected;
  if (tokens.length < minimum || tokens.length > minimum + (paginated ? 1 : 0)) {
    return null;
  }
  const base = { type: "model-picker" as const, version: 1 as const, snapshotToken };
  let decoded: ModelPickerAction;
  switch (intent) {
    case "show-providers":
    case "show-recents":
      decoded = { ...base, intent, ...(tokens[0] !== undefined ? { cursor: tokens[0] } : {}) };
      break;
    case "show-models":
      if (!tokens[0]) {
        return null;
      }
      decoded = {
        ...base,
        intent,
        providerToken: tokens[0],
        ...(tokens[1] !== undefined ? { cursor: tokens[1] } : {}),
      };
      break;
    case "choose-model":
      if (!tokens[0] || !tokens[1]) {
        return null;
      }
      decoded = { ...base, intent, providerToken: tokens[0], modelToken: tokens[1] };
      break;
    case "choose-runtime":
      if (!tokens[0] || !tokens[1] || !tokens[2]) {
        return null;
      }
      decoded = {
        ...base,
        intent,
        providerToken: tokens[0],
        modelToken: tokens[1],
        runtimeToken: tokens[2],
      };
      break;
    case "reset":
    case "cancel":
      decoded = { ...base, intent };
      break;
    default:
      return null;
  }
  const action = resolveMessagePresentationButtonAction({ action: decoded }, { modelPicker: true });
  return action?.type === "model-picker" ? action : null;
}
