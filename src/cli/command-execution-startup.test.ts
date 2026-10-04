// Command execution startup tests cover startup behavior before CLI command execution.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  assertColdMessageSourceUnchanged,
  readColdMessageArtifacts,
} from "./command-execution-startup.artifacts.test-support.js";

const emitCliBannerMock = vi.hoisted(() => vi.fn());
const routeLogsToStderrMock = vi.hoisted(() => vi.fn());
const ensureConfigReadyMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCliPluginRegistryLoadedMock = vi.hoisted(() => vi.fn(async () => {}));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("./banner.js", () => ({
  emitCliBanner: emitCliBannerMock,
}));

vi.mock("../logging/console.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/console.js")>();
  return {
    ...actual,
    routeLogsToStderr: routeLogsToStderrMock,
  };
});

vi.mock("./program/config-guard.js", () => ({
  ensureConfigReady: ensureConfigReadyMock,
}));

vi.mock("./plugin-registry-loader.js", () => ({
  ensureCliPluginRegistryLoaded: ensureCliPluginRegistryLoadedMock,
}));

describe("command-execution-startup", () => {
  let mod: typeof import("./command-execution-startup.js");

  beforeAll(async () => {
    vi.resetModules();
    mod = await import("./command-execution-startup.js");
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves console exports for a co-sharded subsystem logger", async () => {
    const { createSubsystemLogger } = await import("../logging/subsystem.js");

    expect(() =>
      createSubsystemLogger("test/cli-startup").isEnabled("info", "console"),
    ).not.toThrow();
  });

  it("routes logs to stderr and emits banner only when allowed", async () => {
    await mod.applyCliExecutionStartupPresentation({
      startupPolicy: {
        suppressDoctorStdout: true,
        hideBanner: false,
        skipConfigGuard: false,
        loadPlugins: true,
        pluginRegistry: { scope: "all" },
      },
      version: "1.2.3",
      argv: ["node", "openclaw", "status"],
    });

    expect(routeLogsToStderrMock).toHaveBeenCalledTimes(1);
    expect(emitCliBannerMock).toHaveBeenCalledWith("1.2.3", {
      argv: ["node", "openclaw", "status"],
    });

    await mod.applyCliExecutionStartupPresentation({
      startupPolicy: {
        suppressDoctorStdout: false,
        hideBanner: true,
        skipConfigGuard: false,
        loadPlugins: true,
        pluginRegistry: { scope: "all" },
      },
      version: "1.2.3",
      showBanner: true,
    });

    expect(emitCliBannerMock).toHaveBeenCalledTimes(1);
  });

  it("does not emit the banner for JSON output", async () => {
    await mod.applyCliExecutionStartupPresentation({
      startupPolicy: {
        suppressDoctorStdout: true,
        hideBanner: false,
        skipConfigGuard: false,
        loadPlugins: false,
        pluginRegistry: { scope: "channels" },
      },
      version: "1.2.3",
      argv: ["node", "openclaw", "status", "--json"],
    });

    expect(routeLogsToStderrMock).toHaveBeenCalledTimes(1);
    expect(emitCliBannerMock).not.toHaveBeenCalled();
  });

  it("forwards startup policy into bootstrap defaults and overrides", async () => {
    const statusRuntime = {} as never;
    await mod.ensureCliExecutionBootstrap({
      runtime: statusRuntime,
      commandPath: ["status"],
      startupPolicy: {
        suppressDoctorStdout: true,
        hideBanner: false,
        skipConfigGuard: false,
        loadPlugins: false,
        pluginRegistry: { scope: "channels" },
      },
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: statusRuntime,
      commandPath: ["status"],
      measure: expect.any(Function),
      suppressDoctorStdout: true,
    });
    expect(ensureCliPluginRegistryLoadedMock).not.toHaveBeenCalled();

    const messageRuntime = {} as never;
    await mod.ensureCliExecutionBootstrap({
      runtime: messageRuntime,
      commandPath: ["message", "send"],
      startupPolicy: {
        suppressDoctorStdout: false,
        hideBanner: false,
        skipConfigGuard: false,
        loadPlugins: false,
        pluginRegistry: { scope: "all" },
      },
      allowInvalid: true,
      loadPlugins: true,
    });

    expect(ensureConfigReadyMock).toHaveBeenLastCalledWith({
      runtime: messageRuntime,
      commandPath: ["message", "send"],
      measure: expect.any(Function),
      allowInvalid: true,
    });
    expect(ensureCliPluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "all",
      routeLogsToStderr: false,
    });
  });

  it.each([
    { commandPath: ["gateway"], asyncReads: 2 },
    { commandPath: ["gateway", "run"], asyncReads: 2 },
    { commandPath: ["doctor"], asyncReads: 0 },
  ])(
    "routes fresh $commandPath snapshots through their host preparation",
    async ({ commandPath, asyncReads }) => {
      const root = tempDirs.make("openclaw-cli-snapshot-preparation-");
      const configPath = path.join(root, "openclaw.json");
      const env = {
        HOME: root,
        USERPROFILE: root,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: path.join(root, "state"),
        VITEST: "true",
      };
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      const [{ createConfigIoContext }, snapshots, metadata, runtime, lifecycle, state] =
        await Promise.all([
          import("../config/io.context.js"),
          import("../config/io.snapshot.js"),
          import("../config/io.plugin-metadata.js"),
          import("../config/runtime-snapshot.js"),
          import("../plugins/plugin-metadata-lifecycle.js"),
          import("../state/openclaw-state-db.js"),
        ]);
      const context = createConfigIoContext({
        configPath,
        env,
        homedir: () => root,
        observe: false,
      });
      const prepare = vi.spyOn(metadata, "resolveConfigWidePluginMetadataSnapshotAsync");
      const captures: Array<ReturnType<typeof runtime.captureManagedConfigSnapshotPreparation>> =
        [];
      ensureConfigReadyMock.mockImplementationOnce(async () => {
        captures.push(runtime.captureManagedConfigSnapshotPreparation(configPath));
        expect(
          runtime.captureManagedConfigSnapshotPreparation(path.join(root, "other.json")),
        ).toBeNull();
        expect(runtime.hasManagedRuntimeConfigWriteOwner(configPath)).toBe(false);
        await expect(
          runtime.preflightManagedRuntimeConfigWrite(
            configPath,
            {},
            { requireImmediateApplication: true },
          ),
        ).rejects.toThrow("The Gateway cannot apply this activation");
        for (const port of [19001, 19002]) {
          fs.writeFileSync(
            configPath,
            JSON.stringify({ gateway: { mode: "local", port }, plugins: { enabled: false } }),
          );
          const result = await snapshots.readConfigFileSnapshotWithPluginMetadataFromContext(
            context,
            {
              allowCurrentPluginMetadata: false,
            },
          );
          expect(result.snapshot.issues).toEqual([]);
          expect(result.snapshot.valid).toBe(true);
          expect(result.snapshot.config.gateway?.port).toBe(port);
          expect(result.pluginMetadataSnapshot).toBeDefined();
        }
      });
      try {
        await mod.ensureCliExecutionBootstrap({
          runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
          commandPath,
          startupPolicy: {
            suppressDoctorStdout: true,
            hideBanner: true,
            skipConfigGuard: false,
            loadPlugins: false,
            pluginRegistry: { scope: "all" },
          },
        });
        expect(prepare).toHaveBeenCalledTimes(asyncReads);
        expect(runtime.captureManagedConfigSnapshotPreparation(configPath)).toBeNull();
        const captured = captures[0];
        if (asyncReads > 0) {
          if (!captured) {
            throw new Error("Gateway bootstrap did not own snapshot preparation");
          }
          await expect(captured(async () => undefined)).rejects.toThrow(
            "snapshot preparation owner has closed",
          );
        } else {
          expect(captured).toBeNull();
        }
      } finally {
        prepare.mockRestore();
        vi.unstubAllEnvs();
        lifecycle.clearPluginMetadataLifecycleCaches();
        state.closeOpenClawStateDatabaseForTest();
      }
    },
  );
});

it("preserves cold Gateway admission artifacts and fences later config publication", async () => {
  vi.resetModules();
  for (const name of [
    "./program/config-guard.js",
    "./program/message/plugin-admission.js",
    "../channels/plugins/index.js",
    "../plugins/channel-plugin-ids.js",
    "../plugins/loader.js",
    "../config/config.js",
    "./deps.js",
    "../commands/message.js",
  ]) {
    vi.doUnmock(name);
  }
  const root = tempDirs.make("openclaw-cold-message-admission-");
  const pluginDir = path.join(root, "plugin");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  const evaluationsPath = path.join(root, "evaluations.txt");
  const retirementsPath = path.join(root, "retirements.txt");
  const id = "admitted-chat";
  fs.mkdirSync(pluginDir);
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: id,
      type: "commonjs",
      openclaw: { extensions: ["./index.cjs"], channel: { id, label: "Admitted chat" } },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      channels: [id],
      configSchema: { type: "object" },
      channelConfigs: { [id]: { schema: { type: "object" } } },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(evaluationsPath)}, "entry\\n");
module.exports = { id: ${JSON.stringify(id)}, register(api) {
  api.registerChannel({ plugin: require("./provider.cjs") });
  api.lifecycle.onDispose(() => fs.appendFileSync(${JSON.stringify(retirementsPath)}, "retired\\n"));
} };`,
  );
  fs.writeFileSync(
    path.join(pluginDir, "provider.cjs"),
    `
require("node:fs").appendFileSync(${JSON.stringify(evaluationsPath)}, "implementation\\n");
module.exports = {
  id: ${JSON.stringify(id)}, meta: { id: ${JSON.stringify(id)}, label: "Admitted chat" },
  capabilities: { chatTypes: ["direct"] },
  config: {
    listAccountIds: () => ["default"],
    resolveAccount: () => ({ accountId: "default", enabled: true }),
    isConfigured: () => true, isEnabled: () => true,
  },
  messaging: { normalizeTarget: raw => raw, targetResolver: { looksLikeId: () => true } },
  actions: {
    resolveCliActionRequest({action, args}) {
      if (action !== "thread-create") return null;
      if (args.threadName === "bad-number") return { action: "send", args: {...args, limit: "2x"} };
      if (args.threadName === "bad-poll") return {
        action: "poll", args: {...args, pollAnonymous: true, pollPublic: true}
      };
      return { action: "send", args: {...args, message: args.threadName} };
    },
    resolveExecutionMode: ({action}) => action === "send" ? "gateway" : "local",
  },
  outbound: { deliveryMode: "gateway", sendText() { throw new Error("must dispatch to Gateway"); } },
};`,
  );
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      agents: { entries: { main: { workspace: path.join(root, "workspace") } } },
      plugins: {
        load: { paths: [pluginDir] },
        entries: { [id]: { enabled: true } },
        slots: { memory: "none" },
      },
      channels: { [id]: { enabled: true } },
      logging: { level: "silent", consoleLevel: "silent" },
    }),
  );
  for (const [key, value] of Object.entries({
    HOME: root,
    USERPROFILE: root,
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
  })) {
    vi.stubEnv(key, value);
  }
  const error = vi.fn();
  let republishAfterSecrets = false;

  const exit = vi.fn((_code: number): never => {
    throw new Error("fixture exit");
  });
  const capturedInstances = new Set<string>();
  const gateway = vi.fn(async (_request: Record<string, unknown>) => {
    const admitted = artifacts();
    assertColdMessageSourceUnchanged(before, admitted);
    expect(fs.readFileSync(configPath).equals(configBefore)).toBe(true);
    for (const directory of admitted.instances) {
      capturedInstances.add(directory);
    }
    expect(Object.values(admitted.captures).some((entry) => entry.kind === "link")).toBe(true);
    const { readCachedClawInstallSchemaVersions } =
      await import("../claws/provenance-runtime-read.js");
    expect(readCachedClawInstallSchemaVersions().kind).toBe("ready");
    return { messageId: "synthetic-gateway" };
  });
  vi.doMock("../runtime.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../runtime.js")>()),
    defaultRuntime: { log: vi.fn(), error, exit },
  }));
  vi.doMock("./one-shot-exit.js", () => ({
    requestExitAfterOneShotOutput: (_runtime: unknown, code: number) => exit(code),
  }));
  vi.doMock("../infra/outbound/message.gateway.runtime.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../infra/outbound/message.gateway.runtime.js")>()),
    callGatewayLeastPrivilege: gateway,
  }));
  vi.doMock("./command-config-resolution.js", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./command-config-resolution.js")>();
    const resolve = actual.resolveCommandConfigWithSecrets;
    return {
      ...actual,
      resolveCommandConfigWithSecrets: async (...params: Parameters<typeof resolve>) => {
        const result = await resolve(...params);
        if (republishAfterSecrets) {
          config.setRuntimeConfigSnapshot(config.getRuntimeConfig());
        }
        return result;
      },
    };
  });
  const state = await import("../state/openclaw-state-db.js");
  const config = await import("../config/config.js");
  const lifecycle = await import("../plugins/plugin-metadata-lifecycle.js");
  const { createEmptyPluginRegistry } = await import("../plugins/registry-empty.js");
  const { setActivePluginRegistry } = await import("../plugins/runtime.js");
  const { getChannelPlugin } = await import("../channels/plugins/index.js");
  const guard = await import("./program/config-guard.js");
  const ready = vi.spyOn(guard, "ensureConfigReady");
  const { createMessageCliHelpers } = await import("./program/message/helpers.js");
  state.openOpenClawStateDatabase({ env: process.env });
  state.closeOpenClawStateDatabaseForTest();
  const artifacts = () => readColdMessageArtifacts(stateDir, process.cwd());
  const before = artifacts();
  const assertCapturesRetired = () => {
    for (const directory of capturedInstances) {
      expect(fs.existsSync(directory), directory).toBe(false);
    }
    expect(Object.keys(artifacts().captures)).toEqual([]);
  };
  const configBefore = fs.readFileSync(configPath);
  setActivePluginRegistry(createEmptyPluginRegistry());
  expect(getChannelPlugin(id)).toBeUndefined();
  const run = createMessageCliHelpers(id).runMessageAction;
  const request = {
    channel: id,
    target: "user:fixture",
    threadName: "normalized payload",
    json: true,
  };
  try {
    await expect(run("thread-create", request)).rejects.toThrow("fixture exit");
    expect(error).not.toHaveBeenCalled();
    expect(exit).toHaveBeenLastCalledWith(0);
    expect(gateway).toHaveBeenCalledOnce();
    expect(ready.mock.calls.map(([params]) => params.validateConfigOnly)).toEqual([true]);
    expect(gateway.mock.calls[0]?.[0]).toMatchObject({
      method: "send",
      params: { channel: id, message: "normalized payload" },
    });
    expect(fs.readFileSync(evaluationsPath, "utf8")).toBe("entry\nimplementation\n");

    expect(fs.existsSync(path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite"))).toBe(
      true,
    );
    const published = artifacts();
    expect(fs.readFileSync(configPath)).toEqual(configBefore);
    expect(getChannelPlugin(id)).toBeUndefined();
    expect(fs.readFileSync(retirementsPath, "utf8")).toBe("retired\n");
    assertCapturesRetired();

    for (const [threadName, expectedError] of [
      ["bad-number", "--limit must be a positive integer."],
      ["bad-poll", "--poll-anonymous and --poll-public are mutually exclusive."],
    ]) {
      await expect(run("thread-create", { ...request, threadName, json: false })).rejects.toThrow(
        "fixture exit",
      );
      expect(error).toHaveBeenLastCalledWith(expectedError);
      expect(exit).toHaveBeenLastCalledWith(1);
      expect(gateway).toHaveBeenCalledOnce();
      assertCapturesRetired();
    }
    republishAfterSecrets = true;
    await expect(run("thread-create", { ...request, json: false })).rejects.toThrow("fixture exit");
    expect(error).toHaveBeenLastCalledWith(
      "Message config changed during plugin admission; retry the command.",
    );
    expect(gateway).toHaveBeenCalledOnce();
    assertColdMessageSourceUnchanged(published, artifacts(), "published-agent-state");
    expect(fs.readFileSync(configPath).equals(configBefore)).toBe(true);
    assertCapturesRetired();
    expect(fs.readFileSync(retirementsPath, "utf8")).toBe("retired\n".repeat(4));
  } finally {
    state.closeOpenClawStateDatabaseForTest();
    config.clearRuntimeConfigSnapshot();
    lifecycle.clearPluginMetadataLifecycleCaches();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const name of [
      "./program/config-guard.js",
      "../runtime.js",
      "./one-shot-exit.js",
      "../infra/outbound/message.gateway.runtime.js",
      "./command-config-resolution.js",
      "../commands/message.js",
    ]) {
      vi.doUnmock(name);
    }
    vi.resetModules();
  }
});
