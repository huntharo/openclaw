import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { updateSessionStore } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun } from "./queue.js";

const runCodexAppServerAgentMock = vi.fn();

vi.mock("../../agents/model-fallback.js", () => ({
  runWithModelFallback: async (params: {
    provider: string;
    model: string;
    run: (provider: string, model: string) => Promise<unknown>;
  }) => ({
    result: await params.run(params.provider, params.model),
    provider: params.provider,
    model: params.model,
  }),
}));

vi.mock("../../agents/codex-app-server-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../../agents/codex-app-server-runner.js")>(
    "../../agents/codex-app-server-runner.js",
  );
  return {
    ...actual,
    isCodexAppServerProvider: (provider: string) => provider === "codex-app-server",
    runCodexAppServerAgent: (params: unknown) => runCodexAppServerAgentMock(params),
  };
});

import { runAgentTurnWithFallback } from "./agent-runner-execution.js";

describe("runAgentTurnWithFallback codex workspace selection", () => {
  beforeEach(() => {
    runCodexAppServerAgentMock.mockReset().mockResolvedValue({
      payloads: [{ text: "ok" }],
      meta: {
        durationMs: 12,
        aborted: false,
        agentMeta: {
          sessionId: "codex-thread-1",
          provider: "codex-app-server",
          model: "default",
        },
      },
    });
  });

  it("prefers the bound codex project key over the OpenClaw agent workspace", async () => {
    const activeSessionEntry: SessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "codex-thread-1",
      codexProjectKey: "/repo/bound-thread",
    };

    const result = await runAgentTurnWithFallback({
      commandBody: "check npm",
      followupRun: {
        prompt: "check npm",
        summaryLine: "check npm",
        enqueuedAt: Date.now(),
        run: {
          sessionId: "session-1",
          sessionKey: "agent:pwrdrvr:codex:binding:telegram:default:topic-1",
          messageProvider: "telegram",
          sessionFile: "/tmp/session.jsonl",
          workspaceDir: "/repo/openclaw-agent",
          config: {},
          skillsSnapshot: {},
          provider: "codex-app-server",
          model: "default",
          thinkLevel: "low",
          verboseLevel: "off",
          elevatedLevel: "off",
          bashElevated: {
            enabled: false,
            allowed: false,
            defaultLevel: "off",
          },
          timeoutMs: 30_000,
          blockReplyBreak: "message_end",
        },
      } as unknown as FollowupRun,
      sessionCtx: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "group:-100:topic:1",
      } as TemplateContext,
      typingSignals: {
        mode: "instant",
        shouldStartImmediately: true,
        shouldStartOnMessageStart: false,
        shouldStartOnText: true,
        shouldStartOnReasoning: false,
        signalRunStart: vi.fn(),
        signalMessageStart: vi.fn(),
        signalTextDelta: vi.fn(),
        signalReasoningDelta: vi.fn(),
        signalToolStart: vi.fn(),
      },
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => true,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey: "agent:pwrdrvr:codex:binding:telegram:default:topic-1",
      getActiveSessionEntry: () => activeSessionEntry,
      activeSessionStore: {
        "agent:pwrdrvr:codex:binding:telegram:default:topic-1": activeSessionEntry,
      },
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expect(runCodexAppServerAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/repo/bound-thread",
        existingThreadId: "codex-thread-1",
      }),
    );
  });

  it("falls back to the persisted bound codex project key when the in-memory entry is stale", async () => {
    const sessionKey = "agent:pwrdrvr:codex:binding:telegram:default:topic-2";
    const storePath = "/tmp/codex-agent-runner-execution-store.json";
    const persistedEntry: SessionEntry = {
      sessionId: "session-2",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "codex-thread-2",
      codexProjectKey: "/repo/persisted-thread",
    };
    await updateSessionStore(storePath, (store) => {
      store[sessionKey] = persistedEntry;
    });

    const result = await runAgentTurnWithFallback({
      commandBody: "check npm",
      followupRun: {
        prompt: "check npm",
        summaryLine: "check npm",
        enqueuedAt: Date.now(),
        run: {
          sessionId: "session-2",
          sessionKey,
          messageProvider: "telegram",
          sessionFile: "/tmp/session-2.jsonl",
          workspaceDir: "/repo/openclaw-agent",
          config: {},
          skillsSnapshot: {},
          provider: "codex-app-server",
          model: "default",
          thinkLevel: "low",
          verboseLevel: "off",
          elevatedLevel: "off",
          bashElevated: {
            enabled: false,
            allowed: false,
            defaultLevel: "off",
          },
          timeoutMs: 30_000,
          blockReplyBreak: "message_end",
        },
      } as unknown as FollowupRun,
      sessionCtx: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "group:-100:topic:2",
      } as TemplateContext,
      typingSignals: {
        mode: "instant",
        shouldStartImmediately: true,
        shouldStartOnMessageStart: false,
        shouldStartOnText: true,
        shouldStartOnReasoning: false,
        signalRunStart: vi.fn(),
        signalMessageStart: vi.fn(),
        signalTextDelta: vi.fn(),
        signalReasoningDelta: vi.fn(),
        signalToolStart: vi.fn(),
      },
      blockReplyPipeline: null,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      applyReplyToMode: (payload) => payload,
      shouldEmitToolResult: () => true,
      shouldEmitToolOutput: () => true,
      pendingToolTasks: new Set(),
      resetSessionAfterCompactionFailure: async () => false,
      resetSessionAfterRoleOrderingConflict: async () => false,
      isHeartbeat: false,
      sessionKey,
      storePath,
      getActiveSessionEntry: () => ({
        sessionId: "session-2",
        updatedAt: Date.now(),
        providerOverride: "codex-app-server",
      }),
      activeSessionStore: {},
      resolvedVerboseLevel: "off",
    });

    expect(result.kind).toBe("success");
    expect(runCodexAppServerAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/repo/persisted-thread",
        existingThreadId: "codex-thread-2",
      }),
    );
  });
});
