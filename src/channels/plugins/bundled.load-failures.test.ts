import fs from "node:fs";
import path from "node:path";
import { importFreshModule } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock("../../plugins/bundled-channel-runtime.js");
  vi.doUnmock("./bundled-root.js");
});

it("keeps unregistered provider implementations unloaded through core reads and routing", async () => {
  vi.resetModules();
  const root = tempDirs.make("openclaw-provider-isolation-");
  const pluginsDir = path.join(root, "extensions");
  const pluginDir = path.join(pluginsDir, "telegram");
  const modulePath = path.join(pluginDir, "index.cjs");
  const evaluationsPath = path.join(root, "evaluations.txt");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "@openclaw/telegram",
      openclaw: {
        extensions: ["./index.cjs"],
        channel: {
          id: "telegram",
          label: "Telegram",
          configuredState: { specifier: "./configured.cjs", exportName: "configured" },
        },
      },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "telegram",
      channels: ["telegram", "telegram-sibling"],
      configSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
  );
  fs.writeFileSync(
    modulePath,
    `require("node:fs").appendFileSync(${JSON.stringify(evaluationsPath)}, "entry\\n");
module.exports = {
  kind: "bundled-channel-entry", id: "telegram", name: "Telegram", description: "fixture",
  register(api) { api.registerChannel({ plugin: require("./provider.cjs") }); },
  loadChannelPlugin() { return require("./provider.cjs"); }
};`,
  );
  fs.writeFileSync(
    path.join(pluginDir, "provider.cjs"),
    `require("node:fs").appendFileSync(${JSON.stringify(evaluationsPath)}, "implementation\\n");
module.exports = {
  id: "telegram", meta: { id: "telegram", label: "Telegram" },
  capabilities: { chatTypes: ["direct"] },
  config: { listAccountIds() { return ["default"]; }, resolveAccount() { return {}; } },
  outbound: { sendText() {}, async sendPoll({poll}) {
    require("node:fs").appendFileSync(${JSON.stringify(evaluationsPath)}, "poll:" + poll.question + "\\n");
    return { channel: "telegram", messageId: "fixture-poll", chatId: "fixture-chat" };
  }, presentationCapabilities: { supported: true, buttons: true, modelPicker: true } }
};`,
  );
  fs.writeFileSync(
    path.join(pluginDir, "configured.cjs"),
    `require("node:fs").appendFileSync(${JSON.stringify(evaluationsPath)}, "probe\\n");
exports.configured = ({env}) => Boolean(env.TELEGRAM_BOT_TOKEN);`,
  );
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", pluginsDir);
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.doMock("./bundled-root.js", () => ({
    resolveBundledChannelRootScope: () => ({ packageRoot: root, cacheKey: root }),
  }));
  vi.doMock("../../plugins/bundled-channel-runtime.js", () => ({
    listBundledChannelPluginMetadata: () => [
      {
        dirName: "telegram",
        rootDir: pluginDir,
        manifest: { id: "telegram", channels: ["telegram"] },
        source: { source: "./index.cjs", built: "./index.cjs" },
      },
    ],
    resolveBundledChannelGeneratedPath: () => modulePath,
  }));
  const { createEmptyPluginRegistry } = await import("../../plugins/registry-empty.js");
  const { setActivePluginRegistry } = await import("../../plugins/runtime.js");
  setActivePluginRegistry(createEmptyPluginRegistry());
  const { formatOutboundDeliverySummary } = await import("../../infra/outbound/format.js");
  const { getRuntimeVisibleChannelPlugin } =
    await import("../../infra/outbound/runtime-visible-channels.js");
  const { resolveOutboundChannelPlugin } =
    await import("../../infra/outbound/channel-resolution.js");
  const { buildCommandsMessagePaginated } =
    await import("../../auto-reply/command-status-builders.js");
  const { sendHandlers } = await import("../../gateway/server-methods/send.js");
  const cfg = {
    channels: { telegram: { enabled: false } },
    plugins: { entries: { telegram: { enabled: false } } },
  };
  const { detectPluginAutoEnableCandidates } = await import("../../config/plugin-auto-enable.js");
  for (const config of [
    { channels: { telegram: { enabled: false } } },
    { plugins: { enabled: false } },
    { plugins: { entries: { telegram: { enabled: false } } } },
  ]) {
    expect(
      detectPluginAutoEnableCandidates({
        config,
        env: {
          OPENCLAW_BUNDLED_PLUGINS_DIR: pluginsDir,
          OPENCLAW_STATE_DIR: path.join(root, "state"),
          TELEGRAM_BOT_TOKEN: "synthetic",
        },
      }),
    ).toEqual([]);
  }
  const summary = formatOutboundDeliverySummary("telegram");
  const commands = buildCommandsMessagePaginated(cfg, undefined, { surface: "telegram" });
  const visible = getRuntimeVisibleChannelPlugin("telegram");
  const outbound = resolveOutboundChannelPlugin({ channel: "telegram", cfg });
  const evaluations = fs.existsSync(evaluationsPath)
    ? fs.readFileSync(evaluationsPath, "utf8")
    : "";
  expect(evaluations).toBe("");
  expect(summary).toBe("✅ Sent via Telegram. Message ID: unknown");
  expect(commands.presentation).toBeUndefined();
  expect(visible).toBeUndefined();
  expect(outbound).toBeUndefined();

  for (const inactive of [
    { channels: { telegram: { enabled: false } } },
    { channels: { telegram: { enabled: true } }, plugins: { enabled: false } },
    {
      channels: { telegram: { enabled: true } },
      plugins: { entries: { telegram: { enabled: false } } },
    },
    { plugins: { entries: { telegram: { enabled: true } } } },
    { channels: { "telegram-sibling": { enabled: true } } },
  ]) {
    expect(
      resolveOutboundChannelPlugin({ channel: "telegram", cfg: inactive, allowBootstrap: true }),
    ).toBeUndefined();
    expect(fs.existsSync(evaluationsPath)).toBe(false);
  }
  const enabled = {
    channels: { telegram: { enabled: true } },
    plugins: { entries: { telegram: { enabled: true } }, slots: { memory: "none" } },
  };
  const plugin = resolveOutboundChannelPlugin({
    channel: "telegram",
    cfg: enabled,
    allowBootstrap: true,
  });
  if (!plugin) {
    throw new Error("Configured provider fixture was not admitted by outbound bootstrap");
  }
  const { bootstrapOutboundChannelPlugin } =
    await import("../../infra/outbound/channel-bootstrap.runtime.js");
  const { withPluginRuntimeRegistryScope } =
    await import("../../plugins/runtime/gateway-request-scope.js");
  const { disposePluginRegistryInstances } = await import("../../plugins/runtime.js");
  const registry = bootstrapOutboundChannelPlugin({ channel: "telegram", cfg: enabled });
  if (!registry) {
    throw new Error("Configured provider fixture lost its admitted registry");
  }
  try {
    expect(getRuntimeVisibleChannelPlugin("telegram")).toBeUndefined();
    await withPluginRuntimeRegistryScope(registry, async () => {
      expect(getRuntimeVisibleChannelPlugin("telegram")).toBe(plugin);
      expect(resolveOutboundChannelPlugin({ channel: "telegram", cfg: enabled })).toBe(plugin);
      const { makeContext } = await import("../../gateway/server-methods/send.test-support.js");
      const context = makeContext();
      context.getRuntimeConfig = () => enabled;
      const respond = vi.fn();
      const poll = sendHandlers.poll;
      if (!poll) {
        throw new Error("Gateway poll entry is missing");
      }
      await poll({
        params: JSON.parse(
          JSON.stringify({
            channel: "telegram",
            to: "fixture-chat",
            question: "Selected provider?",
            options: ["Yes", "No"],
            idempotencyKey: "messaging-bus-poll",
          }),
        ),
        respond,
        context,
        client: null,
        isWebchatConnect: () => false,
        req: { type: "req", id: "bus-poll", method: "poll" },
      });
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          channel: "telegram",
          messageId: "fixture-poll",
        }),
        undefined,
        { channel: "telegram" },
      );
    });
  } finally {
    await disposePluginRegistryInstances(registry);
  }
  expect(fs.readFileSync(evaluationsPath, "utf8")).toBe(
    "entry\nimplementation\npoll:Selected provider?\n",
  );
});

it("does not reevaluate a bundled source entry after an initialization error", async () => {
  const root = tempDirs.make("openclaw-bundled-source-error-");
  const pluginDir = path.join(root, "extensions", "alpha");
  const modulePath = path.join(pluginDir, "index.ts");
  const evaluationsPath = path.join(root, "evaluations.txt");
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    modulePath,
    [
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(evaluationsPath)}, "evaluated\\n");`,
      'throw new Error("channel initialization failed");',
      "",
    ].join("\n"),
    "utf8",
  );
  vi.doMock("./bundled-root.js", () => ({
    resolveBundledChannelRootScope: () => ({ packageRoot: root, cacheKey: root }),
  }));
  vi.doMock("../../plugins/bundled-channel-runtime.js", () => ({
    listBundledChannelPluginMetadata: () => [
      {
        dirName: "alpha",
        rootDir: pluginDir,
        manifest: { id: "alpha", channels: ["alpha"] },
        source: { source: "./index.ts", built: "./index.ts" },
      },
    ],
    resolveBundledChannelGeneratedPath: () => modulePath,
  }));
  const bundled = await importFreshModule<typeof import("./bundled.js")>(
    import.meta.url,
    "./bundled.js?scope=bundled-source-initialization-error",
  );

  expect(bundled.getBundledChannelPlugin("alpha")).toBeUndefined();
  expect(bundled.getBundledChannelPlugin("alpha")).toBeUndefined();
  expect(fs.readFileSync(evaluationsPath, "utf8")).toBe("evaluated\n");
});
