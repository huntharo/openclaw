import path from "node:path";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareEvent,
} from "openclaw/plugin-sdk/agent-harness";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { sameSessionTranscriptTargetBinding } from "../config/sessions/transcript-target-binding.js";
import { captureOwnedTranscriptWriteAssertion } from "../config/sessions/transcript-write-context.js";
import * as blobState from "../plugin-state/plugin-blob-store.js";
import * as keyedState from "../plugin-state/plugin-state-store.js";
import { loadPluginManifest, type PluginManifest } from "../plugins/manifest.js";
import { resolvePluginModuleExport } from "../plugins/module-export.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { disposePluginRegistryInstances, setActivePluginRegistry } from "../plugins/runtime.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import type { OpenClawPluginDefinition } from "../plugins/types.js";
import {
  loadBundledPluginFacade,
  resolveBundledPluginPublicModulePath,
} from "../test-utils/bundled-plugin-public-surface.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import "../test-utils/prepare-compiled-subprocesses.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import { createCodeModeHarness, resetCodeModeTestState } from "./code-mode.test-support.js";
import { createAgentToolResultMiddlewareRunner } from "./harness/tool-result-middleware.js";
import { SessionManager } from "./sessions/session-manager.js";
import { clearToolSearchCatalog } from "./tool-search.js";
import type { AnyAgentTool } from "./tools/common.js";

let state: OpenClawTestState;
let manifest: PluginManifest;
let registerTokenMiser: NonNullable<OpenClawPluginDefinition["register"]>;
let manager: SessionManager;
let scope: { agentId: string; sessionId: string; sessionKey: string };
const registries = new Set<ReturnType<typeof createEmptyPluginRegistry>>();
const catalogs = new Set<Parameters<typeof clearToolSearchCatalog>[0]>();
const controllers = new Set<AbortController>();
const createBlobStore = blobState.createPluginBlobStore;
const createKeyedStore = keyedState.createPluginStateKeyedStore;
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "token-miser-group" });
  const artifact = { pluginId: "token-miser", artifactBasename: "index.js" };
  const loaded = loadPluginManifest(path.dirname(resolveBundledPluginPublicModulePath(artifact)));
  if (!loaded.ok) {
    throw new Error(loaded.error);
  }
  manifest = loaded.manifest;
  const { definition, register } = resolvePluginModuleExport(
    await loadBundledPluginFacade(artifact),
  );
  if (!register || definition?.id !== manifest.id) {
    throw new Error("Expected Token Miser public entry matching its manifest.");
  }
  registerTokenMiser = register;
  scope = {
    agentId: "main",
    sessionId: "group-session",
    sessionKey: "agent:main:token-miser-group",
  };
  const target = {
    ...scope,
    storePath: path.join(state.sessionsDir(), "sessions.json"),
    env: state.env,
  };
  await upsertSessionEntryCore(target, { sessionId: scope.sessionId, updatedAt: 1 });
  manager = await SessionManager.openAsync(target, state.workspaceDir);
});
afterAll(async () => {
  await state.cleanup();
});
afterEach(async () => {
  for (const registry of registries) {
    await disposePluginRegistryInstances(registry);
  }
  registries.clear();
  for (const controller of controllers) {
    controller.abort();
  }
  controllers.clear();
  for (const catalog of catalogs) {
    clearToolSearchCatalog(catalog);
  }
  catalogs.clear();
  setActivePluginRegistry(createEmptyPluginRegistry());
  await resetCodeModeTestState();
  vi.restoreAllMocks();
});

const measurement = "Computed elapsed: 42 ms; checked workers: 2.";
const value = "worker completed 🦀漢字\n".repeat(400) + measurement;
const memberContent = {
  a: [{ type: "text" as const, text: "worker a completed\n".repeat(300) }],
  b: [{ type: "text" as const, text: "worker b completed\n".repeat(300) }],
};

function fixture(disposition: "summarize" | "pass_through" = "summarize") {
  const blobs = new Map<string, { bytes: Buffer; metadata: unknown }>();
  const markers = new Set<string>();
  const operations: string[] = [];
  const failures = { acceptanceAt: 0 };
  let acceptanceWrites = 0;
  vi.spyOn(blobState, "createPluginBlobStore").mockImplementation(
    <TMetadata>(...args: Parameters<typeof createBlobStore>) => {
      const store = createBlobStore<TMetadata>(...args);
      const observed: ReturnType<typeof createBlobStore<TMetadata>> = {
        ...store,
        async registerIfAbsent(key, bytes, metadata, options) {
          const accepted = await store.registerIfAbsent(key, bytes, metadata, options);
          if (accepted) {
            blobs.set(key, { bytes: Buffer.from(bytes), metadata: structuredClone(metadata) });
          }
          operations.push(`stage:${key}`);
          return accepted;
        },
        async delete(key) {
          const deleted = await store.delete(key);
          blobs.delete(key);
          operations.push(`delete-blob:${key}`);
          return deleted;
        },
      };
      return observed;
    },
  );
  vi.spyOn(keyedState, "createPluginStateKeyedStore").mockImplementation(
    <T>(...args: Parameters<typeof createKeyedStore>) => {
      const store = createKeyedStore<T>(...args);
      const observed: ReturnType<typeof createKeyedStore<T>> = {
        ...store,
        async register(key, entry, options) {
          if (++acceptanceWrites === failures.acceptanceAt) {
            throw new Error("synthetic marker storage failure");
          }
          await store.register(key, entry, options);
          markers.add(key);
          operations.push(`accept:${key}`);
        },
        async delete(key, options) {
          const deleted = await store.delete(key, options);
          markers.delete(key);
          operations.push(`delete-accept:${key}`);
          return deleted;
        },
      };
      return observed;
    },
  );
  const controller = new AbortController();
  controllers.add(controller);
  const target = manager.getSessionTarget();
  const assertTranscript = captureOwnedTranscriptWriteAssertion(target!);
  const assertCurrent = () => {
    controller.signal.throwIfAborted();
    assertTranscript();
    if (!sameSessionTranscriptTargetBinding(target, manager.getSessionTarget())) {
      throw new Error("Transcript binding changed.");
    }
  };
  const runtime = createPluginRuntime();
  const complete = vi.fn<typeof runtime.llm.complete>(async (request) => {
    const prompt = JSON.parse(request.messages[0]?.content ?? "") as {
      outerResult: { output: string; originalBytes: number; truncated: boolean };
      members: Array<{ id: string; output: string }>;
    };
    expect(prompt.outerResult.output).toContain(measurement);
    expect(prompt.outerResult.truncated).toBe(false);
    expect(prompt.members.every((member) => !member.output.includes(measurement))).toBe(true);
    return {
      text: JSON.stringify({
        disposition,
        summary: "Build completed.",
        usefulDetails: disposition === "summarize" ? [measurement] : [],
        members: prompt.members.map(({ id }) => ({ id, summary: "Completed worker output." })),
      }),
      provider: "fixture-provider",
      model: "fixture-model",
      agentId: scope.agentId,
      usage: {},
      execution: { mode: "direct-provider", owner: { kind: "provider", id: "fixture-provider" } },
      audit: { caller: { kind: "plugin", id: "token-miser" } },
    };
  });
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: { ...runtime, llm: { ...runtime.llm, complete } },
    activateGlobalSideEffects: false,
  });
  registries.add(builder.registry);
  const record = createPluginRecord({
    id: manifest.id,
    origin: "bundled",
    contracts: manifest.contracts,
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, {
    config: {},
    pluginConfig: { thresholdBytes: 4096, maxSummaryBytes: 2048 },
  });
  registerTokenMiser(api);
  expect(builder.registry.diagnostics).toEqual([]);
  setActivePluginRegistry(builder.registry);
  const run = (extra?: AgentToolResultMiddleware) => {
    if (extra) {
      api.registerAgentToolResultMiddleware(extra);
    }
    return createAgentToolResultMiddlewareRunner({
      runtime: "openclaw",
      ...scope,
      runId: "group-run",
      task: "Check the build result.",
      persistence: "durable",
      resultVisibility: "model",
      toolNames: ["token_miser_read"],
      signal: controller.signal,
      assertCurrent,
    });
  };
  const execute = async (
    options: { incomplete?: boolean; source?: boolean } = {},
  ): Promise<AgentToolResultMiddlewareEvent> => {
    const harness = createCodeModeHarness({ codeMode: { executor: "node", maxOutputBytes: 1024 } });
    const context = {
      ...harness.ctx,
      ...scope,
      runId: "group-run",
      ...(options.incomplete ? { originalTextMaxBytes: 1024 } : {}),
    };
    catalogs.add(context);
    const controls = createCodeModeTools(context);
    const tool = (name: string): AnyAgentTool => ({
      name,
      label: name,
      description: "Synthetic completed output.",
      parameters: {
        type: "object",
        properties: { label: { type: "string", enum: ["a", "b"] } },
        required: ["label"],
      },
      execute: vi.fn(async (_id, args) => ({
        content: memberContent[(args as { label: "a" | "b" }).label],
        details: { status: "completed" },
      })),
    });
    const logs = tool("build_logs");
    const source = tool("read_file");
    applyCodeModeCatalog({
      ...context,
      tools: [...controls, logs, ...(options.source ? [source] : [])],
    });
    const code = `const results = [await ${options.source ? "read_file" : "build_logs"}({label:"a"}), await build_logs({label:"b"})]; const elapsedMs = 21 * 2; const measurement = "Computed elapsed: " + elapsedMs + " ms; checked workers: " + results.length + "."; text(measurement); return ${JSON.stringify("worker completed 🦀漢字\n")}.repeat(400) + measurement;`;
    const args = { title: "Inspect worker output", code };
    const result = await controls[0]!.execute("outer", args);
    expect(result.details).toMatchObject({ status: "completed" });
    expect(logs.execute).toHaveBeenCalledTimes(options.source ? 1 : 2);
    if (options.source) {
      expect(source.execute).toHaveBeenCalledOnce();
    }
    return { toolCallId: "outer", toolName: "exec", args, result };
  };
  return { blobs, markers, operations, failures, complete, run, execute };
}

describe("Token Miser actual Code Mode group selection", () => {
  it.each(["summarize", "pass_through"] as const)(
    "attributes grouped %s output through the public plugin entry",
    async (disposition) => {
      const f = fixture(disposition);
      const input = await f.execute();
      const result = await f.run().applyToolResultMiddleware(input, (candidate) => {
        expect(f.markers.size).toBe(0);
        return candidate;
      });
      expect(f.complete).toHaveBeenCalledOnce();
      if (disposition === "pass_through") {
        expect(result.content).toEqual(input.result.content);
        expect(f.blobs.size).toBe(0);
        expect(f.markers.size).toBe(0);
        return;
      }
      expect(f.markers.size).toBe(3);
      expect(f.blobs.size).toBe(3);
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining(measurement) });
      const outer = [...f.blobs.values()].find(
        ({ metadata }) =>
          metadata !== null &&
          typeof metadata === "object" &&
          "toolCallId" in metadata &&
          metadata.toolCallId === "outer",
      );
      expect(outer).toBeDefined();
      const original = JSON.parse(JSON.parse(outer!.bytes.toString())[0].text) as { value: string };
      expect(original.value).toBe(value);
      for (const content of Object.values(memberContent)) {
        const member = [...f.blobs].find(([, entry]) =>
          entry.bytes.equals(Buffer.from(JSON.stringify(content))),
        );
        expect(member).toBeDefined();
        expect(result.content[0]).toMatchObject({
          text: expect.stringContaining(`Member ${member![0]}:`),
        });
      }
    },
  );

  it("rolls back every accepted group marker when a later selector rejects", async () => {
    const f = fixture();
    const input = await f.execute();
    const result = await f
      .run((event) => ({
        result: event.result,
        projection: {
          select: async () => {
            expect(f.markers.size).toBe(3);
            return false;
          },
          discard: async () => {},
        },
      }))
      .applyToolResultMiddleware(input);
    expect(result.content).toEqual(input.result.content);
    expect(f.operations.filter((operation) => operation.startsWith("accept:"))).toHaveLength(3);
    expect(f.markers.size).toBe(0);
    expect(f.blobs.size).toBe(0);
    expect(f.complete).toHaveBeenCalledOnce();
  });

  it.each(["invalid handler", "throwing handler", "invalid final projection", "removed reference"])(
    "discards the actual group for %s",
    async (mode) => {
      const f = fixture();
      const input = await f.execute();
      const later: AgentToolResultMiddleware = (event) => {
        if (mode === "throwing handler") {
          throw new Error("synthetic middleware failure");
        }
        if (mode === "invalid handler") {
          Object.assign(event.result, { content: [{ type: "invalid" }] });
        }
        return { result: event.result };
      };
      const result = await f
        .run(mode.includes("handler") ? later : undefined)
        .applyToolResultMiddleware(input, (candidate) => {
          const selected = { ...candidate };
          if (mode === "invalid final projection") {
            Object.assign(selected, { content: [{ type: "invalid" }] });
          }
          if (mode === "removed reference") {
            selected.content = [
              { type: "text", text: "Caller output budget removed the reference." },
            ];
          }
          return selected;
        });
      expect(f.complete).toHaveBeenCalledOnce();
      expect(f.markers.size).toBe(0);
      expect(f.blobs.size).toBe(0);
      expect(f.operations.some((operation) => operation.startsWith("accept:"))).toBe(false);
      expect(JSON.stringify(result.content)).not.toContain("token_miser_result");
    },
  );

  it("removes earlier markers after a partial group acceptance failure", async () => {
    const f = fixture();
    f.failures.acceptanceAt = 2;
    const input = await f.execute();
    const result = await f.run().applyToolResultMiddleware(input);
    expect(result.content).toEqual(input.result.content);
    expect(f.complete).toHaveBeenCalledOnce();
    expect(f.operations.filter((operation) => operation.startsWith("accept:"))).toHaveLength(1);
    expect(f.markers.size).toBe(0);
    expect(f.blobs.size).toBe(0);
  });

  it.each(["incomplete producer", "source member"] as const)(
    "skips helper and persistence for an actual %s",
    async (mode) => {
      const f = fixture();
      const input = await f.execute({
        incomplete: mode === "incomplete producer",
        source: mode === "source member",
      });
      if (mode === "incomplete producer") {
        input.originalCaptureComplete = true;
        input.originalTextMembers = [
          { toolCallId: "spoofed", toolName: "build_logs", args: {}, content: memberContent.a },
        ];
      }
      const result = await f.run().applyToolResultMiddleware(input);
      expect(result.content).toEqual(input.result.content);
      expect(f.complete).not.toHaveBeenCalled();
      expect(f.blobs.size).toBe(0);
      expect(f.markers.size).toBe(0);
    },
  );
});
