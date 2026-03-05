import { describe, expect, it } from "vitest";
import {
  __testing,
  isCodexAppServerProvider,
  parseCodexUserInput,
} from "./codex-app-server-runner.js";

describe("parseCodexUserInput", () => {
  it("parses numeric option choices", () => {
    expect(parseCodexUserInput("1", 3)).toEqual({ kind: "option", index: 0 });
    expect(parseCodexUserInput("option 2", 3)).toEqual({ kind: "option", index: 1 });
    expect(parseCodexUserInput("  Option 3  ", 3)).toEqual({ kind: "option", index: 2 });
  });

  it("falls back to free-form text for invalid option indices", () => {
    expect(parseCodexUserInput("0", 3)).toEqual({ kind: "text", text: "0" });
    expect(parseCodexUserInput("option 9", 3)).toEqual({ kind: "text", text: "option 9" });
  });

  it("returns free-form text when no option syntax is used", () => {
    expect(parseCodexUserInput("ship it", 3)).toEqual({ kind: "text", text: "ship it" });
  });
});

describe("isCodexAppServerProvider", () => {
  it("matches the codex-app-server provider id", () => {
    expect(isCodexAppServerProvider("codex-app-server")).toBe(true);
  });

  it("respects explicit disablement in config", () => {
    expect(
      isCodexAppServerProvider("codex-app-server", {
        agents: { defaults: { codexAppServer: { enabled: false } } },
      }),
    ).toBe(false);
  });
});

describe("codex app server rpc methods", () => {
  it("does not use deprecated sendUserMessage fallback for starting a turn", () => {
    const methods = __testing.getTurnStartRpcMethods();
    expect(methods).toContain("turn/start");
    expect(methods).not.toContain("sendUserMessage");
  });

  it("builds turn/start payloads that always provide threadId", () => {
    const variants = __testing.buildTurnStartVariants({
      threadId: "thread-123",
      prompt: "hello",
      workspaceDir: "/tmp/workspace",
      model: "gpt-5-codex",
    });
    expect(variants.length).toBeGreaterThan(0);
    for (const variant of variants) {
      expect(variant.threadId).toBe("thread-123");
      expect(variant).not.toHaveProperty("thread_id");
      expect(variant).not.toHaveProperty("conversationId");
    }
  });
});
