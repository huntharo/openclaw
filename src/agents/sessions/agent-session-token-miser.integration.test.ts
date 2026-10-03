import { createHash } from "node:crypto";
import path from "node:path";
import type { Context, Model } from "openclaw/plugin-sdk/llm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { sameSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { captureOwnedTranscriptWriteAssertion } from "../../config/sessions/transcript-write-context.js";
import { loadPluginManifest, type PluginManifest } from "../../plugins/manifest.js";
import { resolvePluginModuleExport } from "../../plugins/module-export.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { createPluginRegistry } from "../../plugins/registry.js";
import { disposePluginRegistryInstances, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createPluginRuntime } from "../../plugins/runtime/index.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createPluginToolFactoryContext } from "../../plugins/tool-factory-context.js";
import {
  bindPluginToolCallbacks,
  createPluginToolFactoryResolver,
} from "../../plugins/tool-factory-runtime.js";
import type { OpenClawPluginDefinition } from "../../plugins/types.js";
import {
  loadBundledPluginFacade,
  resolveBundledPluginPublicModulePath,
} from "../../test-utils/bundled-plugin-public-surface.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import "../../test-utils/prepare-compiled-subprocesses.js";
import { toToolDefinitions } from "../agent-tool-definition-adapter.js";
import { applyCodeModeCatalog, createCodeModeTools } from "../code-mode.js";
import { createCodeModeHarness, resetCodeModeTestState } from "../code-mode.test-support.js";
import { buildEmbeddedExtensionFactories } from "../embedded-agent-runner/extensions.js";
import { createEmbeddedAgentResourceLoader } from "../embedded-agent-runner/resource-loader.js";
import { clearToolSearchCatalog } from "../tool-search.js";
import { jsonResult, type AnyAgentTool } from "../tools/common.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "./agent-session-loop-correctness.test-support.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

registerAgentSessionLoopTestLifecycle();
let state: OpenClawTestState;
let manifest: PluginManifest;
let registerTokenMiser: NonNullable<OpenClawPluginDefinition["register"]>;
const ownedRegistries = new Set<ReturnType<typeof createEmptyPluginRegistry>>();
const ownedCatalogs = new Set<Parameters<typeof clearToolSearchCatalog>[0]>();
const ownedControllers = new Set<AbortController>();
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "token-miser-session" });
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
});
afterAll(async () => {
  await state.cleanup();
});
afterEach(async () => {
  for (const controller of ownedControllers) {
    controller.abort();
  }
  ownedControllers.clear();
  for (const context of ownedCatalogs) {
    clearToolSearchCatalog(context);
  }
  ownedCatalogs.clear();
  for (const registry of ownedRegistries) {
    await disposePluginRegistryInstances(registry);
  }
  ownedRegistries.clear();
  setActivePluginRegistry(createEmptyPluginRegistry());
  await resetCodeModeTestState();
});

const payload = ["worker completed 🦀漢字", '"', String.fromCharCode(92, 0, 0xd800, 13, 10)]
  .join("")
  .repeat(600);
const program =
  'const result = await build_logs({label:"requested"}); json(result); await yield_control(); text("finished"); return result.payload;';
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
type Page = {
  id: string;
  mode: "full" | "group";
  data: string;
  nextOffsetBytes?: number;
  memberIds?: string[];
};

describe("Token Miser real AgentSession Code Mode delivery", () => {
  it.each(["node", "quickjs"] as const)(
    "preserves %s exec/yield/wait originals through session extensions and registered retrieval",
    async (executor) => {
      const scope = {
        agentId: "main",
        sessionId: `token-miser-${executor}`,
        sessionKey: `agent:main:token-miser-${executor}`,
        storePath: path.join(state.sessionsDir(), "sessions.json"),
        env: state.env,
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const manager = await SessionManager.openAsync(scope, state.workspaceDir);
      const target = manager.getSessionTarget();
      const signal = new AbortController();
      ownedControllers.add(signal);
      const assertTranscript = captureOwnedTranscriptWriteAssertion(target!);
      const assertCurrent = () => {
        signal.signal.throwIfAborted();
        assertTranscript();
        if (!sameSessionTranscriptTargetBinding(target, manager.getSessionTarget())) {
          throw new Error("Transcript binding changed.");
        }
      };
      const runtime = createPluginRuntime();
      const warnings = vi.fn();
      const complete = vi.fn<typeof runtime.llm.complete>(async (params) => {
        const input = params.messages[0]?.content;
        if (typeof input !== "string") {
          throw new Error("Expected helper text input.");
        }
        const evaluation = JSON.parse(input) as { members: Array<{ id: string }> };
        return {
          text: JSON.stringify({
            disposition: "summarize",
            summary: "Build completed; repeated worker messages.",
            usefulDetails: [],
            members: evaluation.members.map(({ id }) => ({
              id,
              summary: "Completed worker output.",
            })),
          }),
          provider: "fixture-provider",
          model: "fixture-model",
          agentId: scope.agentId,
          usage: {},
          execution: {
            mode: "direct-provider",
            owner: { kind: "provider", id: "fixture-provider" },
          },
          audit: { caller: { kind: "plugin", id: "token-miser" } },
        };
      });
      const builder = createPluginRegistry({
        logger: { info() {}, warn: warnings, error() {}, debug() {} },
        runtime: { ...runtime, llm: { ...runtime.llm, complete } },
        activateGlobalSideEffects: false,
      });
      ownedRegistries.add(builder.registry);
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
      let originalJson: string | undefined;
      let memberJson: string | undefined;
      api.registerAgentToolResultMiddleware(
        (event, ctx) => {
          expect(Object.keys(ctx).toSorted()).toEqual([
            "agentId",
            "assertCurrent",
            "persistence",
            "resultVisibility",
            "runId",
            "runtime",
            "sessionId",
            "sessionKey",
            "signal",
            "task",
            "toolNames",
          ]);
          expect(ctx.persistence).toBe("durable");
          expect(typeof ctx.assertCurrent).toBe("function");
          ctx.assertCurrent?.();
          expect(ctx.toolNames).toContain("token_miser_read");
          if (event.toolName === "wait") {
            expect(event.originalCaptureComplete).toBe(true);
            expect(event.originalTextMembers).toHaveLength(1);
            originalJson = JSON.stringify(event.originalTextContent);
            memberJson = JSON.stringify(event.originalTextMembers?.[0]?.content);
          }
        },
        { originalTextMaxBytes: 32 * 1024 * 1024 },
      );
      registerTokenMiser(api);
      expect(builder.registry.diagnostics).toEqual([]);
      setActivePluginRegistry(builder.registry);
      const registration = builder.registry.tools.find((entry) => entry.pluginId === manifest.id);
      if (!registration) {
        throw new Error("Plugin retrieval factory was not registered.");
      }
      const context = createPluginToolFactoryContext({
        entry: registration,
        registry: builder.registry,
        context: {
          config: {},
          agentId: scope.agentId,
          sessionId: scope.sessionId,
          sessionKey: scope.sessionKey,
          workspaceDir: state.workspaceDir,
        },
        assertInvocationCurrent: assertCurrent,
      });
      const factory = createPluginToolFactoryResolver((message) => {
        throw new Error(message);
      });
      const resolved = factory.resolve(
        registration,
        context,
        registration.names ?? [],
        builder.registry,
      ).resolved;
      const retrieval = (Array.isArray(resolved) ? resolved : resolved ? [resolved] : []).map(
        (tool) =>
          bindPluginToolCallbacks(
            registration,
            builder.registry,
            tool,
            context.assertInvocationCurrent,
          ),
      );
      expect(retrieval.map((tool) => tool.name)).toContain("token_miser_read");
      const fixture = createCodeModeHarness({ codeMode: { executor, maxOutputBytes: 1024 } });
      const codeContext = { ...fixture.ctx, ...scope, runId: `run-${executor}` };
      ownedCatalogs.add(codeContext);
      const controls = createCodeModeTools(codeContext);
      const producerResult = jsonResult({ payload });
      const producer: AnyAgentTool = {
        name: "build_logs",
        label: "Build logs",
        description: "Synthetic completed build output.",
        parameters: { type: "object", properties: { label: { type: "string" } } },
        execute: vi.fn(async () => producerResult),
      };
      applyCodeModeCatalog({ ...codeContext, tools: [...controls, producer, ...retrieval] });
      const settingsManager = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      });
      const loader = createEmbeddedAgentResourceLoader({
        cwd: state.workspaceDir,
        agentDir: state.agentDir(),
        settingsManager,
        extensionFactories: buildEmbeddedExtensionFactories({
          cfg: {},
          sessionManager: manager,
          provider: testModel.provider,
          modelId: testModel.id,
          model: testModel,
          ...scope,
          runId: codeContext.runId,
          task: "Check the build result.",
          signal: signal.signal,
          assertCurrent,
        }),
      });
      await loader.reload();
      const recovered = new Map<string, Buffer[]>();
      let currentRead: { id: string; mode: "group" | "full"; offsetBytes: number } | undefined;
      let memberId: string | undefined;
      let referenceId: string | undefined;
      const delivered = { execBytes: 0, waitBytes: 0, retrievalBytes: 0 };
      let calls = 0;
      let providerFailure: Error | undefined;
      const observed: Array<{
        toolName: string;
        isError: boolean;
        contentBytes: number;
        errorContent?: string;
      }> = [];
      streamMocks.streamSimple.mockImplementation((model: Model, providerContext: Context) => {
        const last = providerContext.messages.at(-1);
        if (last?.role === "toolResult") {
          observed.push({
            toolName: last.toolName,
            isError: last.isError,
            contentBytes: Buffer.byteLength(JSON.stringify(last.content)),
            ...(last.isError
              ? {
                  errorContent: last.content
                    .flatMap((block) => (block.type === "text" ? [block.text] : []))
                    .join("\n")
                    .slice(0, 1600),
                }
              : {}),
          });
        }
        try {
          if (last?.role === "toolResult" && last.isError) {
            throw new Error(
              `Actual ${last.toolName} result failed: ${observed.at(-1)?.errorContent}`,
            );
          }
          const call = calls++;
          let request: { name: string; arguments: Record<string, unknown> } | undefined;
          if (call === 0) {
            request = {
              name: "exec",
              arguments: { title: "Inspect build worker output", code: program },
            };
          } else if (call === 1) {
            if (last?.role !== "toolResult") {
              throw new Error("Expected exec result.");
            }
            expect(last.details).toMatchObject({ status: "waiting", replaySafe: false });
            expect(complete).not.toHaveBeenCalled();
            delivered.execBytes = Buffer.byteLength(JSON.stringify(last.content));
            request = {
              name: "wait",
              arguments: { runId: (last.details as { runId: string }).runId },
            };
          } else if (call === 2) {
            if (last?.role !== "toolResult") {
              throw new Error("Expected wait result.");
            }
            delivered.waitBytes = Buffer.byteLength(JSON.stringify(last.content));
            const text = last.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("\n");
            referenceId = text.match(/<token_miser_result id="([^"]+)"/)?.[1];
            expect(referenceId).toBeDefined();
            expect(complete).toHaveBeenCalledOnce();
            currentRead = { id: referenceId!, mode: "group", offsetBytes: 0 };
          } else {
            if (last?.role !== "toolResult" || !currentRead) {
              throw new Error("Expected registered retrieval result.");
            }
            delivered.retrievalBytes += Buffer.byteLength(JSON.stringify(last.content));
            const page = JSON.parse(
              last.content
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .join("\n"),
            ) as Page;
            expect(page.id).toBe(currentRead.id);
            const bytes = recovered.get(page.id) ?? [];
            bytes.push(Buffer.from(page.data, "base64"));
            recovered.set(page.id, bytes);
            memberId ??= page.memberIds?.[0];
            if (page.nextOffsetBytes !== undefined) {
              currentRead = { ...currentRead, mode: "full", offsetBytes: page.nextOffsetBytes };
            } else if (currentRead.id === referenceId) {
              expect(memberId).toBeDefined();
              currentRead = { id: memberId!, mode: "full", offsetBytes: 0 };
            } else {
              currentRead = undefined;
            }
          }
          if (currentRead) {
            request = { name: "token_miser_read", arguments: { ...currentRead, maxBytes: 4000 } };
          }
          return createAssistantResultStream(
            createAssistant(
              model,
              request
                ? [{ type: "toolCall", id: `tm-call-${call}`, ...request }]
                : [{ type: "text", text: "Recovered exact output." }],
              request ? "toolUse" : "stop",
            ),
          );
        } catch (error) {
          providerFailure ??=
            error instanceof Error
              ? error
              : new Error("Fixture provider assertion failed.", { cause: error });
          return createAssistantResultStream(
            createAssistant(
              model,
              [{ type: "text", text: "Fixture stopped after a provider assertion." }],
              "stop",
            ),
          );
        }
      });
      const { session } = await createTestSession({
        sessionManager: manager,
        resourceLoader: loader,
        settingsManager,
        customTools: toToolDefinitions([...controls, ...retrieval]),
      });
      try {
        await session.prompt("Check the build result and read the retained original.");
        if (providerFailure !== undefined) {
          console.info(
            "Token Miser actual registered-tool failure",
            JSON.stringify({
              executor,
              calls,
              toolNames: session.getActiveToolNames(),
              readSchema: retrieval.find((tool) => tool.name === "token_miser_read")?.parameters,
              observed,
              providerError: providerFailure.message,
              helperCalls: complete.mock.calls.length,
              warnings: warnings.mock.calls.map((args) =>
                args.map((value) => String(value).slice(0, 1000)),
              ),
            }),
          );
          throw providerFailure;
        }
        expect(producer.execute).toHaveBeenCalledOnce();
        expect(originalJson).toBeDefined();
        const outerBytes = Buffer.concat(recovered.get(referenceId!) ?? []);
        const memberBytes = Buffer.concat(recovered.get(memberId!) ?? []);
        expect(outerBytes).toEqual(Buffer.from(originalJson!));
        expect(memberBytes).toEqual(Buffer.from(JSON.stringify(producerResult.content)));
        expect(memberJson).toBe(JSON.stringify(producerResult.content));
        const original = JSON.parse(JSON.parse(outerBytes.toString("utf8"))[0].text);
        expect(original.output).toEqual([{ type: "text", text: "finished" }]);
        expect(original.value).toBe(payload);
        expect(JSON.stringify(manager.buildSessionContext().messages)).toContain(
          "token_miser_result",
        );
        console.info(
          "Token Miser AgentSession boundary bytes",
          JSON.stringify({
            executor,
            payloadSha256: sha256(payload),
            programSha256: sha256(program),
            producerExecutions: 1,
            ...delivered,
            originalBytes: outerBytes.byteLength,
            memberBytes: memberBytes.byteLength,
            originalSha256: sha256(outerBytes),
            memberSha256: sha256(memberBytes),
            helperInputBytes: Buffer.byteLength(
              String(complete.mock.calls[0]?.[0].messages[0]?.content),
            ),
            helperCalls: complete.mock.calls.length,
          }),
        );
      } finally {
        signal.abort();
        session.dispose();
      }
    },
  );
});
