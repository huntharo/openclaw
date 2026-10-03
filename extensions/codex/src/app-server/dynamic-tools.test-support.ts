import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness";
import { resetGlobalHookRunner } from "openclaw/plugin-sdk/hook-runtime";
import {
  createEmptyPluginRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, vi } from "vitest";
import { toCodexDynamicToolProtocolResponse } from "./dynamic-tool-execution.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import type {
  CodexDynamicToolCallParams,
  CodexDynamicToolCallResponse,
  JsonValue,
} from "./protocol.js";

export function resetDynamicToolBridgeTestState() {
  resetGlobalHookRunner();
  setActivePluginRegistry(createEmptyPluginRegistry());
}

export function installResultMiddleware(
  handler: ReturnType<
    typeof createEmptyPluginRegistry
  >["agentToolResultMiddlewares"][number]["handler"],
) {
  const registry = createEmptyPluginRegistry();
  registry.agentToolResultMiddlewares.push({
    pluginId: "test-result",
    pluginName: "Test result",
    rawHandler: handler,
    handler,
    runtimes: ["codex"],
    source: "test",
  });
  setActivePluginRegistry(registry);
}

export function createDynamicToolCall(
  tool: string,
  arguments_: JsonValue = {},
  callId = "call-1",
): CodexDynamicToolCallParams {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    callId,
    namespace: null,
    tool,
    arguments: arguments_,
  };
}

export function createTool(overrides: Partial<AnyAgentTool>): AnyAgentTool {
  return {
    name: "tts",
    description: "Convert text to speech.",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute: vi.fn(),
    ...overrides,
  } as unknown as AnyAgentTool;
}

export function textToolResult(text: string, details: unknown = {}): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

export function createSingleToolBridge(
  tool: AnyAgentTool,
  options: Omit<Parameters<typeof createCodexDynamicToolBridge>[0], "tools" | "signal"> = {},
) {
  return createCodexDynamicToolBridge({
    tools: [tool],
    signal: new AbortController().signal,
    ...options,
  });
}

export function createBridgeWithToolResult(
  toolName: string,
  toolResult: AgentToolResult<unknown>,
  hookContext?: Parameters<typeof createCodexDynamicToolBridge>[0]["hookContext"],
) {
  return createSingleToolBridge(
    createTool({ name: toolName, execute: vi.fn(async () => toolResult) }),
    { hookContext },
  );
}

export function firstInputText(response: CodexDynamicToolCallResponse) {
  const firstItem = response.contentItems[0];
  if (firstItem?.type !== "inputText" || typeof firstItem.text !== "string") {
    throw new Error("expected inputText tool result");
  }
  return firstItem.text;
}

export function expectInputText(
  response: CodexDynamicToolCallResponse,
  text: string,
  success = true,
) {
  expect(toCodexDynamicToolProtocolResponse(response)).toEqual({
    success,
    contentItems: [{ type: "inputText", text }],
  });
}
