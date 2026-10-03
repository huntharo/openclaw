import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBridgeWithToolResult,
  createDynamicToolCall,
  expectInputText,
  firstInputText,
  installResultMiddleware,
  resetDynamicToolBridgeTestState,
  textToolResult,
} from "./dynamic-tools.test-support.js";

afterEach(resetDynamicToolBridgeTestState);

describe("Codex dynamic tool result selection", () => {
  it.each(["output budget", "whole skill"] as const)(
    "discards a reference removed by the actual %s projection",
    async (boundary) => {
      const marker = '<token_miser_result id="tm_adapter_control">';
      const selected = vi.fn();
      const discard = vi.fn(async () => {});
      const select = vi.fn(async (result: AgentToolResult<unknown>) =>
        result.content.some((block) => block.type === "text" && block.text.includes(marker)),
      );
      installResultMiddleware(() => ({
        result: textToolResult("candidate log\n".repeat(2_000) + marker),
        projection: { select, selected, discard },
      }));
      const toolName = boundary === "whole skill" ? "skills_read" : "large_lookup";
      const original =
        boundary === "whole skill"
          ? "requested-skill-instruction\n".repeat(2_000)
          : "Original tool result.";
      const bridge = createBridgeWithToolResult(toolName, textToolResult(original));
      const result = await bridge.handleToolCall(createDynamicToolCall(toolName));
      expect(select).toHaveBeenCalledOnce();
      await expect(select.mock.results[0]?.value).resolves.toBe(false);
      expect(selected).not.toHaveBeenCalled();
      expect(discard).toHaveBeenCalledOnce();
      expect(firstInputText(result)).not.toContain(marker);
      if (boundary === "whole skill") {
        expect(result.success).toBe(false);
        expect(firstInputText(result)).toContain("No instructions were returned");
        expect(firstInputText(result)).not.toContain("requested-skill-instruction");
      } else {
        expectInputText(result, original);
      }
    },
  );

  it("delivers the selected conversion even when its source changes during selection", async () => {
    const marker = '<token_miser_result id="tm_adapter_control">';
    const selected = vi.fn();
    const discard = vi.fn(async () => {});
    const candidate = textToolResult(marker);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    installResultMiddleware(() => ({
      result: candidate,
      projection: {
        select: async (view) => {
          expect(view.content).toEqual([{ type: "text", text: marker }]);
          entered.resolve();
          await release.promise;
          return true;
        },
        selected,
        discard,
      },
    }));
    const bridge = createBridgeWithToolResult("large_lookup", textToolResult("Original output."));
    const execution = bridge.handleToolCall(createDynamicToolCall("large_lookup"));
    await entered.promise;
    candidate.content = [{ type: "text", text: "changed after selection\n".repeat(2_000) }];
    release.resolve();
    const result = await execution;
    expectInputText(result, marker);
    expect(selected).toHaveBeenCalledOnce();
    expect(discard).not.toHaveBeenCalled();
  });
});
