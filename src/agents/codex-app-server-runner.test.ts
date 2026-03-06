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

  it("builds turn/start payloads that support thread id field variants", () => {
    const variants = __testing.buildTurnStartVariants({
      threadId: "thread-123",
      prompt: "hello",
      workspaceDir: "/tmp/workspace",
      model: "gpt-5-codex",
    });
    expect(variants.length).toBeGreaterThan(0);
    expect(
      variants.some(
        (variant) =>
          variant.threadId === "thread-123" ||
          variant.thread_id === "thread-123" ||
          variant.conversationId === "thread-123",
      ),
    ).toBe(true);
    expect(
      variants.some((variant) => Object.prototype.hasOwnProperty.call(variant, "thread_id")),
    ).toBe(true);
    expect(
      variants.some((variant) => Object.prototype.hasOwnProperty.call(variant, "conversationId")),
    ).toBe(true);
    expect(variants.some((variant) => Object.prototype.hasOwnProperty.call(variant, "input"))).toBe(
      true,
    );
    expect(
      variants.some((variant) => Object.prototype.hasOwnProperty.call(variant, "prompt")),
    ).toBe(true);
  });

  it("does not retry with a fresh thread when an explicit binding was provided", () => {
    expect(
      __testing.shouldRetryWithFreshThreadAfterNotFound({
        hadExistingThreadBinding: true,
      }),
    ).toBe(false);
    expect(
      __testing.shouldRetryWithFreshThreadAfterNotFound({
        hadExistingThreadBinding: false,
      }),
    ).toBe(true);
  });

  it("throws on thread affinity mismatch for explicit bindings", () => {
    expect(() =>
      __testing.assertBoundThreadAffinity({
        requestedThreadId: "thread-requested",
        observedThreadId: "thread-other",
        source: "turn/start",
      }),
    ).toThrow("thread mismatch for requested binding thread-requested");
    expect(() =>
      __testing.assertBoundThreadAffinity({
        requestedThreadId: "thread-requested",
        observedThreadId: "thread-requested",
        source: "turn/start",
      }),
    ).not.toThrow();
  });
});

describe("approval prompt context", () => {
  it("extracts command and cwd from request approval params", () => {
    expect(
      __testing.extractApprovalPromptContext({
        command: "npm view diver",
        cwd: "/Users/huntharo/github/jeerreview",
        reason: "network access required",
      }),
    ).toEqual({
      command: "npm view diver",
      cwd: "/Users/huntharo/github/jeerreview",
      reason: "network access required",
    });
  });

  it("includes command details in approval prompt text", () => {
    const prompt = __testing.buildPromptText({
      method: "item/commandExecution/requestApproval",
      requestId: "req-1",
      options: ["Approve", "Deny"],
      requestParams: {
        command: "npm view diver",
        cwd: "/Users/huntharo/github/jeerreview",
      },
      expiresAt: Date.now() + 900_000,
    });
    expect(prompt).toContain("Command: npm view diver");
    expect(prompt).toContain("Working directory: /Users/huntharo/github/jeerreview");
    expect(prompt).toContain("This response will be sent to Codex as an approval decision.");
  });
});

describe("codex slash discovery helpers", () => {
  it("normalizes mirrored slash names safely", () => {
    expect(__testing.normalizeMirrorSlashName("/Review")).toBe("review");
    expect(__testing.normalizeMirrorSlashName(" mcp:git.status ")).toBe("mcp-git-status");
    expect(__testing.normalizeMirrorSlashName("___")).toBe("");
  });

  it("extracts slash candidates from nested codex/mcp discovery payloads", () => {
    const extracted = __testing.extractMirrorSlashCandidates({
      value: {
        commands: [{ name: "review" }, { command: "/explain plan" }],
        mcp: {
          items: [{ slash: "git_status" }],
        },
      },
      source: "codex",
      commandContext: true,
    });
    expect(extracted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "review" }),
        expect.objectContaining({ name: "explain" }),
        expect.objectContaining({ name: "git_status" }),
      ]),
    );
  });

  it("dedupes mirrored command names and reports collisions", () => {
    const deduped = __testing.dedupeMirrorSlashCandidates([
      { name: "review", source: "mcp", raw: "review" },
      { name: "review", source: "codex", raw: "/review" },
      { name: "status", source: "codex", raw: "status" },
    ]);
    expect(deduped.commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "review", source: "codex" }),
        expect.objectContaining({ name: "status", source: "codex" }),
      ]),
    );
    expect(deduped.collisions).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "review" })]),
    );
  });
});

describe("codex thread discovery helpers", () => {
  it("extracts thread inventory from nested discovery payloads", () => {
    const extracted = __testing.extractThreadDiscoveryCandidates({
      value: {
        conversations: [
          {
            id: "thread-1",
            cwd: "/Users/huntharo/github/openclaw",
            updatedAt: "2026-03-05T22:19:00.000Z",
          },
          {
            threadId: "thread-2",
            projectKey: "/Users/huntharo/github/other",
            title: "other",
          },
        ],
      },
      inThreadContext: true,
    });
    expect(extracted).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: "thread-1",
          projectKey: "/Users/huntharo/github/openclaw",
        }),
        expect.objectContaining({
          threadId: "thread-2",
          projectKey: "/Users/huntharo/github/other",
        }),
      ]),
    );
  });

  it("dedupes discovered thread entries by id and prefers richer metadata", () => {
    const deduped = __testing.dedupeThreadDiscoveryCandidates([
      { threadId: "thread-1", updatedAt: 1_000 },
      { threadId: "thread-1", projectKey: "/tmp/workspace", updatedAt: 2_000 },
      { threadId: "thread-2", title: "hello" },
    ]);
    expect(deduped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: "thread-1",
          projectKey: "/tmp/workspace",
          updatedAt: 2_000,
        }),
        expect.objectContaining({
          threadId: "thread-2",
          title: "hello",
        }),
      ]),
    );
  });
});
