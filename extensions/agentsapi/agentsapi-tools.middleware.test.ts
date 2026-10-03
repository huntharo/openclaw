import path from "node:path";
import type {
  AgentHarnessAttemptParamsV2,
  AnyAgentTool,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { AuthStorage, ModelRegistry } from "openclaw/plugin-sdk/agent-sessions";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { useSessionStoreTempDirs } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { buildAgentsApiToolSurface } from "./agentsapi-tools.js";
import { createModel } from "./agentsapi.test-support.js";

const tempDirs = useSessionStoreTempDirs(afterAll, "agentsapi-result-projection-");
afterEach(() => {
  setActivePluginRegistry(createEmptyPluginRegistry());
});

describe("Agents API actual function-output selection", () => {
  it.each(["survives", "removed by budget", "mutated during selection"] as const)(
    "settles a middleware reference only when it %s",
    async (boundary) => {
      const workspaceDir = tempDirs.make();
      const target = {
        agentId: "main",
        sessionId: "function-projection",
        sessionKey: "agent:main:function-projection",
        storePath: path.join(workspaceDir, "openclaw-agent.sqlite"),
      };
      await upsertSessionEntry({ ...target, entry: { sessionId: target.sessionId, updatedAt: 1 } });
      const controller = new AbortController();
      const assertCurrent = () => controller.signal.throwIfAborted();
      const marker = '<token_miser_result id="tm_agentsapi_control">';
      const selected = vi.fn();
      const discard = vi.fn(async () => {});
      const seen: string[] = [];
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const candidate = {
        content: [
          {
            type: "text" as const,
            text:
              boundary === "removed by budget" ? "candidate logs\n".repeat(2_000) + marker : marker,
          },
        ],
        details: {},
      };
      const registry = createEmptyPluginRegistry();
      const handler: (typeof registry.agentToolResultMiddlewares)[number]["handler"] = () => ({
        result: candidate,
        projection: {
          select: async (result) => {
            const text = result.content
              .flatMap((block) => (block.type === "text" ? [block.text] : []))
              .join("\n");
            seen.push(text);
            if (boundary === "mutated during selection") {
              entered.resolve();
              await release.promise;
            }
            return text.includes(marker);
          },
          selected,
          discard,
        },
      });
      registry.agentToolResultMiddlewares.push({
        pluginId: "projection-control",
        pluginName: "Projection control",
        rawHandler: handler,
        handler,
        runtimes: ["agentsapi"],
        source: "test",
      });
      setActivePluginRegistry(registry);
      const tool: AnyAgentTool = {
        name: "build_logs",
        label: "Build logs",
        description: "Synthetic completed output.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
        execute: vi.fn<AnyAgentTool["execute"]>(async () => ({
          content: [{ type: "text", text: "Original tool output." }],
          details: {},
        })),
      };
      const authStorage = AuthStorage.inMemory();
      const params: AgentHarnessAttemptParamsV2 = {
        ...target,
        sessionTarget: target,
        sessionFile: path.join(workspaceDir, "session.jsonl"),
        workspaceDir,
        agentDir: workspaceDir,
        config: {},
        runId: "run-projection",
        prompt: "Inspect build output.",
        timeoutMs: 5_000,
        abortSignal: controller.signal,
        provider: "openai",
        modelId: "fixture-model",
        model: createModel({ contextWindow: 128_000 }),
        resolvedApiKey: "fixture-not-real",
        authStorage,
        modelRegistry: ModelRegistry.inMemory(authStorage),
        authProfileStore: { version: 1, profiles: {} },
        thinkLevel: "off",
        contextTokenBudget: 64_000,
        hostCapabilities: {
          kind: "agent-harness-host-capability",
          version: 1,
          assertActive: assertCurrent,
          createToolSurface: () => [tool],
          bindToolSurface: (tools) => tools,
          toolResultPolicy: () => ({
            persistence: "durable",
            task: "Inspect build output.",
            signal: controller.signal,
            assertCurrent,
          }),
          runBeforeToolCall: async (request) => ({ blocked: false, params: request.params }),
          requestApproval: async () => undefined,
          waitForApproval: async () => undefined,
        },
      };
      const surface = buildAgentsApiToolSurface(params, controller.signal, assertCurrent, () => {});
      const execution = surface.execute({
        type: "function_call",
        name: "build_logs",
        arguments: {},
        call_id: "projection-call",
        turn_id: "projection-turn",
      });
      if (boundary === "mutated during selection") {
        await entered.promise;
        expectDefined(candidate.content[0], "middleware candidate text block").text =
          "changed after selection\n".repeat(2_000);
        release.resolve();
      }
      const response = await execution;
      expect(tool.execute).toHaveBeenCalledOnce();
      expect(seen).toHaveLength(1);
      expect(response.success).toBe(true);
      if (boundary !== "removed by budget") {
        expect(response).toMatchObject({ output: marker });
        expect(seen).toEqual([marker]);
        expect(selected).toHaveBeenCalledOnce();
        expect(discard).not.toHaveBeenCalled();
      } else {
        expect(response).toMatchObject({ output: "Original tool output." });
        expect(seen[0]).not.toContain(marker);
        expect(selected).not.toHaveBeenCalled();
        expect(discard).toHaveBeenCalledOnce();
      }
    },
  );
});
