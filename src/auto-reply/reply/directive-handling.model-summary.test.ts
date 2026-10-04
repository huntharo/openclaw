import { afterEach, expect, it } from "vitest";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import { maybeHandleModelDirectiveInfo } from "./directive-handling.model.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";

const snapshot = captureActivePluginRegistrySnapshot();
afterEach(() => restoreActivePluginRegistrySnapshot(snapshot));

it.each([true, false])(
  "keeps current, thinking and usable browse text with buttons enabled=%s",
  async (buttons) => {
    const plugin = {
      ...createChannelTestPluginBase({ id: "portable" }),
      outbound: {
        deliveryMode: "direct" as const,
        presentationCapabilities: { supported: true, buttons: true, modelPicker: true },
        resolvePresentationCapabilities: () => ({ supported: true, buttons, modelPicker: true }),
      },
    };
    setActivePluginRegistry(createTestRegistry([{ pluginId: "portable", plugin, source: "test" }]));
    const reply = await maybeHandleModelDirectiveInfo({
      directives: parseInlineSessionDirectives("/model"),
      cfg: {},
      agentDir: "/tmp/fixture-agent",
      activeAgentId: "main",
      provider: "anthropic",
      model: "claude-opus-4-6",
      defaultProvider: "anthropic",
      defaultModel: "claude-opus-4-6",
      aliasIndex: { byKey: new Map(), byAlias: new Map() },
      allowedModelCatalog: [],
      currentThinkLevel: "medium",
      resetModelOverride: false,
      surface: "portable",
    });
    expect(reply?.text).toContain("Current: anthropic/claude-opus-4-6");
    expect(reply?.text).toContain("Think: medium");
    expect(reply?.text).toContain("Browse: /models");
    expect(reply?.text).toContain("/model <provider/model> -s");
    expect(reply?.channelData).toBeUndefined();
    expect(reply?.presentation).toEqual(
      buttons
        ? {
            blocks: [
              {
                type: "buttons",
                buttons: [
                  { label: "Browse models", action: { type: "command", command: "/models" } },
                ],
              },
            ],
          }
        : undefined,
    );
  },
);
