// Covers channel-configured checks from bootstrap and plugin metadata.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { isChannelConfigured } from "./channel-configured.js";

function configuredStatePlugin(
  id: string,
  hasConfiguredState: NonNullable<ChannelPlugin["config"]["hasConfiguredState"]>,
): ChannelPlugin {
  return {
    id,
    meta: { id, label: id, selectionLabel: id, docsPath: "/testing", blurb: "Fixture" },
    capabilities: { chatTypes: ["direct"] },
    config: { listAccountIds: () => ["default"], resolveAccount: () => ({}), hasConfiguredState },
  };
}

describe("isChannelConfigured", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("detects Telegram env configuration through the package metadata seam", () => {
    expect(isChannelConfigured({}, "telegram", { TELEGRAM_BOT_TOKEN: "token" })).toBe(true);
  });

  it("detects Discord env configuration through the package metadata seam", () => {
    expect(isChannelConfigured({}, "discord", { DISCORD_BOT_TOKEN: "token" })).toBe(true);
  });

  it("requires both Slack identity and transport tokens through the package metadata seam", () => {
    expect(isChannelConfigured({}, "slack", { SLACK_BOT_TOKEN: "xoxb-test" })).toBe(false);
    expect(
      isChannelConfigured({}, "slack", {
        SLACK_BOT_TOKEN: "xoxb-test",
        SLACK_APP_TOKEN: "xapp-test",
      }),
    ).toBe(true);
  });

  it("requires both IRC host and nick env vars through the package metadata seam", () => {
    expect(isChannelConfigured({}, "irc", { IRC_HOST: "irc.example.com" })).toBe(false);
    expect(
      isChannelConfigured({}, "irc", {
        IRC_HOST: "irc.example.com",
        IRC_NICK: "openclaw",
      }),
    ).toBe(true);
  });

  it("requires both Mattermost URL and token env vars through the package metadata seam", () => {
    expect(isChannelConfigured({}, "mattermost", { MATTERMOST_BOT_TOKEN: "token" })).toBe(false);
    expect(
      isChannelConfigured({}, "mattermost", {
        MATTERMOST_URL: "https://mattermost.example.test",
      }),
    ).toBe(false);
    expect(
      isChannelConfigured({}, "mattermost", {
        MATTERMOST_BOT_TOKEN: "token",
        MATTERMOST_URL: "https://mattermost.example.test",
      }),
    ).toBe(true);
  });

  it("still falls back to generic config presence for channels without a custom hook", () => {
    expect(
      isChannelConfigured(
        {
          channels: {
            signal: {
              transport: { kind: "managed-native", httpPort: 8080 },
            },
          },
        },
        "signal",
        {},
      ),
    ).toBe(true);
  });

  it("treats explicit enabled channel config as configured state", () => {
    expect(
      isChannelConfigured(
        {
          channels: {
            "openclaw-weixin": {
              enabled: true,
            },
          },
        },
        "openclaw-weixin",
        {},
      ),
    ).toBe(true);
  });

  it("does not treat disabled channel config as configured state", () => {
    expect(
      isChannelConfigured(
        {
          channels: {
            "openclaw-weixin": {
              enabled: false,
            },
          },
        },
        "openclaw-weixin",
        {},
      ),
    ).toBe(false);
  });

  it("honors Matrix bootstrap metadata without consulting operational credential hooks", () => {
    vi.stubEnv("MATRIX_HOMESERVER", "https://ambient.matrix.example");
    const hasConfiguredState = vi.fn(() => {
      throw new Error("operational credential storage must not be read during bootstrap");
    });
    const registry = createTestRegistry([
      {
        pluginId: "matrix",
        source: "setup",
        plugin: configuredStatePlugin("matrix", hasConfiguredState),
      },
    ]);
    withPluginRuntimeRegistryScope(registry, () => {
      expect(
        isChannelConfigured({}, "matrix", { OPENCLAW_STATE_DIR: "state-with-matrix-creds" }),
      ).toBe(false);
      expect(isChannelConfigured({}, "matrix", { MATRIX_ACCESS_TOKEN: "fixture-token" })).toBe(
        true,
      );
      expect(
        isChannelConfigured(
          { channels: { matrix: { homeserver: "https://configured.matrix.example" } } },
          "matrix",
          {},
        ),
      ).toBe(true);
      expect(hasConfiguredState).not.toHaveBeenCalled();
    });
  });

  it("retains already-admitted legacy hooks when no configured-state metadata is declared", () => {
    const hasConfiguredState = vi.fn(
      ({ env }: { env?: NodeJS.ProcessEnv }) => env?.FIXTURE_TOKEN === "configured",
    );
    const registry = createTestRegistry([
      {
        pluginId: "fixture",
        source: "setup",
        plugin: configuredStatePlugin("fixture", hasConfiguredState),
      },
    ]);
    const env = { FIXTURE_TOKEN: "configured" };

    withPluginRuntimeRegistryScope(registry, () => {
      expect(isChannelConfigured({}, "fixture", env)).toBe(true);
      expect(hasConfiguredState).toHaveBeenCalledWith({ cfg: {}, env });
      expect(isChannelConfigured({}, "fixture", {})).toBe(false);
    });
    expect(isChannelConfigured({}, "fixture", env)).toBe(false);
  });
});
