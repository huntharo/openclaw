import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ResolvedTelegramAccount } from "./accounts.js";
import { telegramDoctor } from "./doctor.js";
import { telegramSecurityAdapter } from "./security.js";
import { createTelegramSetupPluginBase } from "./setup-plugin.js";

export function createTelegramPluginBase(params: {
  setupWizard: NonNullable<ChannelPlugin<ResolvedTelegramAccount>["setupWizard"]>;
  setupContract: NonNullable<ChannelPlugin<ResolvedTelegramAccount>["setupContract"]>;
}): Pick<
  ChannelPlugin<ResolvedTelegramAccount>,
  | "id"
  | "meta"
  | "setupWizard"
  | "capabilities"
  | "commands"
  | "doctor"
  | "security"
  | "reload"
  | "configSchema"
  | "config"
  | "setupContract"
  | "secrets"
> {
  return {
    ...createTelegramSetupPluginBase(params),
    commands: {
      nativeCommandsAutoEnabled: true,
      nativeSkillsAutoEnabled: true,
    },
    doctor: telegramDoctor,
    security: telegramSecurityAdapter,
  };
}
