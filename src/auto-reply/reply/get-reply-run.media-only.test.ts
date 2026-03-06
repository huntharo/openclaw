import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import type { ReplyPayload } from "../types.js";
import { runPreparedReply } from "./get-reply-run.js";

vi.mock("../../agents/auth-profiles/session-override.js", () => ({
  resolveSessionAuthProfileOverride: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../agents/codex-app-server-runner.js", () => ({
  discoverCodexAppServerThreads: vi.fn().mockResolvedValue({
    available: false,
    threads: [],
    error: "unavailable",
  }),
  discoverCodexAppServerSlashCommands: vi.fn().mockResolvedValue({
    available: false,
    commands: [],
    collisions: [],
    error: "unavailable",
  }),
  isCodexAppServerProvider: vi.fn().mockReturnValue(false),
  runCodexAppServerAgent: vi.fn().mockResolvedValue({
    payloads: [{ text: "codex output summary" }],
    meta: {
      durationMs: 100,
      agentMeta: {
        sessionId: "codex-thread-1",
        runId: "codex-run-1",
        provider: "codex-app-server",
        model: "default",
      },
    },
  }),
}));

vi.mock("../../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: vi.fn().mockReturnValue("session:session-key"),
}));

vi.mock("../../config/sessions.js", () => ({
  resolveGroupSessionKey: vi.fn().mockReturnValue(undefined),
  resolveSessionFilePath: vi.fn().mockReturnValue("/tmp/session.jsonl"),
  resolveSessionFilePathOptions: vi.fn().mockReturnValue({}),
  updateSessionStore: vi.fn(),
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

vi.mock("../../process/command-queue.js", () => ({
  clearCommandLane: vi.fn().mockReturnValue(0),
  getQueueSize: vi.fn().mockReturnValue(0),
}));

vi.mock("../../routing/session-key.js", () => ({
  normalizeMainKey: vi.fn().mockReturnValue("main"),
}));

vi.mock("../../utils/provider-utils.js", () => ({
  isReasoningTagProvider: vi.fn().mockReturnValue(false),
}));

vi.mock("../command-detection.js", () => ({
  hasControlCommand: vi.fn().mockReturnValue(false),
}));

vi.mock("./agent-runner.js", () => ({
  runReplyAgent: vi.fn().mockResolvedValue({ text: "ok" }),
}));

vi.mock("./body.js", () => ({
  applySessionHints: vi.fn().mockImplementation(async ({ baseBody }) => baseBody),
}));

vi.mock("./groups.js", () => ({
  buildGroupIntro: vi.fn().mockReturnValue(""),
  buildGroupChatContext: vi.fn().mockReturnValue(""),
}));

vi.mock("./inbound-meta.js", () => ({
  buildInboundMetaSystemPrompt: vi.fn().mockReturnValue(""),
  buildInboundUserContextPrefix: vi.fn().mockReturnValue(""),
}));

vi.mock("./queue.js", () => ({
  resolveQueueSettings: vi.fn().mockReturnValue({ mode: "followup" }),
}));

vi.mock("./route-reply.js", () => ({
  routeReply: vi.fn(),
}));

vi.mock("./session-updates.js", () => ({
  ensureSkillSnapshot: vi.fn().mockImplementation(async ({ sessionEntry, systemSent }) => ({
    sessionEntry,
    systemSent,
    skillsSnapshot: undefined,
  })),
  drainFormattedSystemEvents: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./typing-mode.js", () => ({
  resolveTypingMode: vi.fn().mockReturnValue("off"),
}));

import {
  discoverCodexAppServerThreads,
  discoverCodexAppServerSlashCommands,
  runCodexAppServerAgent,
} from "../../agents/codex-app-server-runner.js";
import { runReplyAgent } from "./agent-runner.js";
import { routeReply } from "./route-reply.js";
import { drainFormattedSystemEvents } from "./session-updates.js";
import { resolveTypingMode } from "./typing-mode.js";

function baseParams(
  overrides: Partial<Parameters<typeof runPreparedReply>[0]> = {},
): Parameters<typeof runPreparedReply>[0] {
  return {
    ctx: {
      Body: "",
      RawBody: "",
      CommandBody: "",
      ThreadHistoryBody: "Earlier message in this thread",
      OriginatingChannel: "slack",
      OriginatingTo: "C123",
      ChatType: "group",
    },
    sessionCtx: {
      Body: "",
      BodyStripped: "",
      ThreadHistoryBody: "Earlier message in this thread",
      MediaPath: "/tmp/input.png",
      Provider: "slack",
      ChatType: "group",
      OriginatingChannel: "slack",
      OriginatingTo: "C123",
    },
    cfg: { session: {}, channels: {}, agents: { defaults: {} } },
    agentId: "default",
    agentDir: "/tmp/agent",
    agentCfg: {},
    sessionCfg: {},
    commandAuthorized: true,
    command: {
      isAuthorizedSender: true,
      abortKey: "session-key",
      ownerList: [],
      senderIsOwner: false,
    } as never,
    commandSource: "",
    allowTextCommands: true,
    directives: {
      hasThinkDirective: false,
      thinkLevel: undefined,
    } as never,
    defaultActivation: "always",
    resolvedThinkLevel: "high",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    elevatedEnabled: false,
    elevatedAllowed: false,
    blockStreamingEnabled: false,
    resolvedBlockStreamingBreak: "message_end",
    modelState: {
      resolveDefaultThinkingLevel: async () => "medium",
    } as never,
    provider: "anthropic",
    model: "claude-opus-4-1",
    typing: {
      onReplyStart: vi.fn().mockResolvedValue(undefined),
      startTypingLoop: vi.fn().mockResolvedValue(undefined),
      refreshTypingTtl: vi.fn(),
      startTypingOnText: vi.fn().mockResolvedValue(undefined),
      isActive: vi.fn().mockReturnValue(false),
      markDispatchIdle: vi.fn(),
      markRunComplete: vi.fn(),
      cleanup: vi.fn(),
    } as never,
    defaultProvider: "anthropic",
    defaultModel: "claude-opus-4-1",
    timeoutMs: 30_000,
    isNewSession: true,
    resetTriggered: false,
    systemSent: true,
    sessionKey: "session-key",
    workspaceDir: "/tmp/workspace",
    abortedLastRun: false,
    ...overrides,
  };
}

function asSingleReply(
  result: ReplyPayload | ReplyPayload[] | undefined,
): ReplyPayload | undefined {
  return Array.isArray(result) ? result[0] : result;
}

describe("runPreparedReply media-only handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows media-only prompts and preserves thread context in queued followups", async () => {
    const result = await runPreparedReply(baseParams());
    expect(result).toEqual({ text: "ok" });

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(call?.followupRun.prompt).toContain("[Thread history - for context]");
    expect(call?.followupRun.prompt).toContain("Earlier message in this thread");
    expect(call?.followupRun.prompt).toContain("[User sent media without caption]");
  });

  it("keeps thread history context on follow-up turns", async () => {
    const result = await runPreparedReply(
      baseParams({
        isNewSession: false,
      }),
    );
    expect(result).toEqual({ text: "ok" });

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(call?.followupRun.prompt).toContain("[Thread history - for context]");
    expect(call?.followupRun.prompt).toContain("Earlier message in this thread");
  });

  it("returns the empty-body reply when there is no text and no media", async () => {
    const result = await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          Provider: "slack",
        },
      }),
    );

    expect(result).toEqual({
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    });
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
  });

  it("omits auth key labels from /new and /reset confirmation messages", async () => {
    await runPreparedReply(
      baseParams({
        resetTriggered: true,
      }),
    );

    const resetNoticeCall = vi.mocked(routeReply).mock.calls[0]?.[0] as
      | { payload?: { text?: string } }
      | undefined;
    expect(resetNoticeCall?.payload?.text).toContain("✅ New session started · model:");
    expect(resetNoticeCall?.payload?.text).not.toContain("🔑");
    expect(resetNoticeCall?.payload?.text).not.toContain("api-key");
    expect(resetNoticeCall?.payload?.text).not.toContain("env:");
  });

  it("skips reset notice when only webchat fallback routing is available", async () => {
    await runPreparedReply(
      baseParams({
        resetTriggered: true,
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
          ThreadHistoryBody: "Earlier message in this thread",
          OriginatingChannel: undefined,
          OriginatingTo: undefined,
          ChatType: "group",
        },
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          channel: "webchat",
          from: undefined,
          to: undefined,
        } as never,
      }),
    );

    expect(vi.mocked(routeReply)).not.toHaveBeenCalled();
  });

  it("uses inbound origin channel for run messageProvider", async () => {
    await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
          ThreadHistoryBody: "Earlier message in this thread",
          OriginatingChannel: "webchat",
          OriginatingTo: "session:abc",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          ThreadHistoryBody: "Earlier message in this thread",
          MediaPath: "/tmp/input.png",
          Provider: "telegram",
          ChatType: "group",
          OriginatingChannel: "telegram",
          OriginatingTo: "telegram:123",
        },
      }),
    );

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call?.followupRun.run.messageProvider).toBe("webchat");
  });

  it("prefers Provider over Surface when origin channel is missing", async () => {
    await runPreparedReply(
      baseParams({
        ctx: {
          Body: "",
          RawBody: "",
          CommandBody: "",
          ThreadHistoryBody: "Earlier message in this thread",
          OriginatingChannel: undefined,
          OriginatingTo: undefined,
          Provider: "feishu",
          Surface: "webchat",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "",
          BodyStripped: "",
          ThreadHistoryBody: "Earlier message in this thread",
          MediaPath: "/tmp/input.png",
          Provider: "webchat",
          ChatType: "group",
          OriginatingChannel: undefined,
          OriginatingTo: undefined,
        },
      }),
    );

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call?.followupRun.run.messageProvider).toBe("feishu");
  });

  it("passes suppressTyping through typing mode resolution", async () => {
    await runPreparedReply(
      baseParams({
        opts: {
          suppressTyping: true,
        },
      }),
    );

    const call = vi.mocked(resolveTypingMode).mock.calls[0]?.[0] as
      | { suppressTyping?: boolean }
      | undefined;
    expect(call?.suppressTyping).toBe(true);
  });

  it("routes queued system events into user prompt text, not system prompt context", async () => {
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce("System: [t] Model switched.");

    await runPreparedReply(baseParams());

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(call?.commandBody).toContain("System: [t] Model switched.");
    expect(call?.followupRun.run.extraSystemPrompt ?? "").not.toContain("Runtime System Events");
  });

  it("preserves first-token think hint when system events are prepended", async () => {
    // drainFormattedSystemEvents returns just the events block; the caller prepends it.
    // The hint must be extracted from the user body BEFORE prepending, so "System:"
    // does not shadow the low|medium|high shorthand.
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce("System: [t] Node connected.");

    await runPreparedReply(
      baseParams({
        ctx: { Body: "low tell me about cats", RawBody: "low tell me about cats" },
        sessionCtx: { Body: "low tell me about cats", BodyStripped: "low tell me about cats" },
        resolvedThinkLevel: undefined,
      }),
    );

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    // Think hint extracted before events arrived — level must be "low", not the model default.
    expect(call?.followupRun.run.thinkLevel).toBe("low");
    // The stripped user text (no "low" token) must still appear after the event block.
    expect(call?.commandBody).toContain("tell me about cats");
    expect(call?.commandBody).not.toMatch(/^low\b/);
    // System events are still present in the body.
    expect(call?.commandBody).toContain("System: [t] Node connected.");
  });

  it("carries system events into followupRun.prompt for deferred turns", async () => {
    // drainFormattedSystemEvents returns the events block; the caller prepends it to
    // effectiveBaseBody for the queue path so deferred turns see events.
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce("System: [t] Node connected.");

    await runPreparedReply(baseParams());

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    expect(call?.followupRun.prompt).toContain("System: [t] Node connected.");
  });

  it("does not strip think-hint token from deferred queue body", async () => {
    // In steer mode the inferred thinkLevel is never consumed, so the first token
    // must not be stripped from the queue/steer body (followupRun.prompt).
    vi.mocked(drainFormattedSystemEvents).mockResolvedValueOnce(undefined);

    await runPreparedReply(
      baseParams({
        ctx: { Body: "low steer this conversation", RawBody: "low steer this conversation" },
        sessionCtx: {
          Body: "low steer this conversation",
          BodyStripped: "low steer this conversation",
        },
        resolvedThinkLevel: undefined,
      }),
    );

    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call).toBeTruthy();
    // Queue body (used by steer mode) must keep the full original text.
    expect(call?.followupRun.prompt).toContain("low steer this conversation");
  });

  it("resets codex thread binding on /agent new", async () => {
    const sessionEntry = {
      sessionId: "s-1",
      updatedAt: Date.now(),
      codexThreadId: "thread-123",
      codexRunId: "run-123",
      codexProjectKey: "/tmp/workspace",
      pendingUserInputRequestId: "req-1",
      pendingUserInputOptions: ["A", "B"],
      pendingUserInputExpiresAt: Date.now() + 5_000,
    };
    const sessionStore = { "session-key": sessionEntry };

    const result = await runPreparedReply(
      baseParams({
        sessionEntry,
        sessionStore: sessionStore as never,
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          commandBodyNormalized: "/agent new",
        } as never,
      }),
    );

    expect(result).toEqual({
      text: "✅ Reset Codex App Server thread binding for this session. Next message starts a new thread.",
    });
    expect(sessionEntry.codexThreadId).toBeUndefined();
    expect(sessionEntry.pendingUserInputRequestId).toBeUndefined();
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
  });

  it("runs /codex oneshot on demand, then summarizes with the selected model", async () => {
    const sessionEntry = {
      sessionId: "s-1",
      updatedAt: Date.now(),
      codexThreadId: "existing-thread",
      codexProjectKey: "/tmp/workspace",
    };
    const sessionStore = { "session-key": sessionEntry };
    const result = await runPreparedReply(
      baseParams({
        sessionEntry,
        sessionStore: sessionStore as never,
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          commandBodyNormalized: "/codex oneshot inspect the failing test and propose a fix",
        } as never,
      }),
    );

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runCodexAppServerAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runCodexAppServerAgent).mock.calls[0]?.[0]?.prompt).toBe(
      "inspect the failing test and propose a fix",
    );
    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call?.followupRun.run.provider).toBe("anthropic");
    expect(call?.followupRun.run.disableTools).toBe(true);
    expect(call?.commandBody).toContain("[Codex App Server Output]");
    expect(call?.commandBody).toContain("codex output summary");
    expect(sessionEntry.codexThreadId).toBe("codex-thread-1");
  });

  it("flushes short codex partial text before tool-result prompts", async () => {
    const sessionEntry = {
      sessionId: "s-1",
      updatedAt: Date.now(),
    };
    const sessionStore = { "session-key": sessionEntry };
    vi.mocked(runCodexAppServerAgent).mockImplementationOnce(async (args) => {
      await args.onPartialReply?.({ text: "Checking npm registry now." });
      await args.onPendingUserInput?.({
        requestId: "req-1",
        options: ["Approve", "Approve for session", "Deny", "Cancel"],
        expiresAt: Date.now() + 60_000,
      });
      await args.onToolResult?.({ text: "🧭 Agent input requested (req-1)" });
      return {
        payloads: [{ text: "codex output summary" }],
        meta: {
          durationMs: 100,
          agentMeta: {
            sessionId: "codex-thread-1",
            runId: "codex-run-1",
            provider: "codex-app-server",
            model: "default",
          },
        },
      };
    });
    const delivered: Array<{ text?: string; channelData?: Record<string, unknown> }> = [];
    const onReplyStart = vi.fn().mockResolvedValue(undefined);
    const result = await runPreparedReply(
      baseParams({
        sessionEntry,
        sessionStore: sessionStore as never,
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          commandBodyNormalized: "/codex oneshot inspect this quickly",
        } as never,
        opts: {
          onReplyStart,
          onToolResult: async (payload) => {
            delivered.push({
              text: payload.text,
              channelData: payload.channelData,
            });
          },
        },
      }),
    );

    expect(result).toEqual({ text: "ok" });
    expect(delivered[0]?.text).toBe("Running Codex App Server...");
    expect(delivered[1]?.text).toContain("Checking npm registry");
    const promptPayload = delivered.find((entry) => entry.text?.includes("Agent input requested"));
    expect(promptPayload?.text).toContain("Agent input requested");
    expect(promptPayload?.channelData).toMatchObject({
      telegram: {
        buttons: [
          [{ text: "1. Approve", callback_data: "codex_input:req-1:1", style: "success" }],
          [
            {
              text: "2. Approve for session",
              callback_data: "codex_input:req-1:2",
              style: "success",
            },
          ],
          [{ text: "3. Deny", callback_data: "codex_input:req-1:3", style: "danger" }],
          [{ text: "4. Cancel", callback_data: "codex_input:req-1:4", style: "danger" }],
        ],
      },
    });
    expect(onReplyStart).toHaveBeenCalled();
  });

  it("idle-flushes codex partial text when no new deltas arrive", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(runCodexAppServerAgent).mockImplementationOnce(async (args) => {
        await args.onPartialReply?.({ text: "Checking npm registry now." });
        await new Promise((resolve) => setTimeout(resolve, 5_100));
        return {
          payloads: [{ text: "codex output summary" }],
          meta: {
            durationMs: 5_100,
            agentMeta: {
              sessionId: "codex-thread-1",
              runId: "codex-run-1",
              provider: "codex-app-server",
              model: "default",
            },
          },
        };
      });

      const delivered: string[] = [];
      const replyPromise = runPreparedReply(
        baseParams({
          command: {
            isAuthorizedSender: true,
            abortKey: "session-key",
            ownerList: [],
            senderIsOwner: false,
            commandBodyNormalized: "/codex oneshot inspect this quickly",
          } as never,
          opts: {
            onToolResult: async (payload) => {
              if (payload.text) {
                delivered.push(payload.text);
              }
            },
          },
        }),
      );

      await vi.advanceTimersByTimeAsync(5_200);
      const result = await replyPromise;

      expect(result).toEqual({ text: "ok" });
      expect(delivered[0]).toBe("Running Codex App Server...");
      expect(delivered.some((entry) => entry.includes("Checking npm registry"))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("recognizes telegram-style /codex@bot command mentions", async () => {
    const result = await runPreparedReply(
      baseParams({
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          commandBodyNormalized: "/codex@openclaw oneshot inspect this stack trace",
        } as never,
      }),
    );

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runCodexAppServerAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runCodexAppServerAgent).mock.calls[0]?.[0]?.prompt).toBe(
      "inspect this stack trace",
    );
  });

  it("returns usage for /codex with no subcommand", async () => {
    const result = await runPreparedReply(
      baseParams({
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          commandBodyNormalized: "/codex",
        } as never,
      }),
    );

    expect(result).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("Usage: /codex <subcommand>"),
      }),
    );
    expect(vi.mocked(runCodexAppServerAgent)).not.toHaveBeenCalled();
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
  });

  it("requires /codex oneshot instead of legacy /codex <task>", async () => {
    const result = await runPreparedReply(
      baseParams({
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          commandBodyNormalized: "/codex inspect the failing test",
        } as never,
      }),
    );

    expect(result).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("/codex oneshot <coding task>"),
      }),
    );
    expect(vi.mocked(runCodexAppServerAgent)).not.toHaveBeenCalled();
  });

  it("detaches codex thread bindings with /codex detach", async () => {
    const sessionEntry = {
      sessionId: "s-1",
      updatedAt: Date.now(),
      codexThreadId: "thread-123",
      codexRunId: "run-123",
      codexProjectKey: "/tmp/workspace",
      codexAutoRoute: true,
    };
    const sessionStore = { "session-key": sessionEntry };
    const result = await runPreparedReply(
      baseParams({
        sessionEntry,
        sessionStore: sessionStore as never,
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          commandBodyNormalized: "/codex detach",
        } as never,
      }),
    );

    expect(result).toEqual(
      expect.objectContaining({ text: expect.stringContaining("Detached this session") }),
    );
    expect(sessionEntry.codexThreadId).toBeUndefined();
    expect(sessionEntry.codexAutoRoute).toBeUndefined();
    expect(vi.mocked(runCodexAppServerAgent)).not.toHaveBeenCalled();
  });

  it("binds a thread id to the current session with /codex bind", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "s-1",
      updatedAt: Date.now(),
    };
    const sessionStore = { "session-key": sessionEntry };
    const result = await runPreparedReply(
      baseParams({
        sessionEntry,
        sessionStore: sessionStore as never,
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          commandBodyNormalized: "/codex bind thread-abc --thread here",
        } as never,
      }),
    );

    expect(result).toEqual(
      expect.objectContaining({
        text: expect.stringContaining("Bound this session to Codex thread thread-abc"),
      }),
    );
    expect(sessionEntry.codexThreadId).toBe("thread-abc");
    expect(sessionEntry.codexAutoRoute).toBe(true);
    expect(vi.mocked(runCodexAppServerAgent)).not.toHaveBeenCalled();
  });

  it("hydrates /codex bind project context from Codex discovery when available", async () => {
    vi.mocked(discoverCodexAppServerThreads).mockResolvedValueOnce({
      available: true,
      threads: [
        {
          threadId: "thread-abc",
          projectKey: "/Users/huntharo/github/openclaw",
        },
      ],
    });
    const sessionEntry: SessionEntry = {
      sessionId: "s-1",
      updatedAt: Date.now(),
    };
    const sessionStore = { "session-key": sessionEntry };
    const result = await runPreparedReply(
      baseParams({
        sessionEntry,
        sessionStore: sessionStore as never,
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          commandBodyNormalized: "/codex bind thread-abc",
        } as never,
      }),
    );
    const reply = asSingleReply(result);
    expect(reply?.text).toContain("project: /Users/huntharo/github/openclaw");
    expect(sessionEntry.codexProjectKey).toBe("/Users/huntharo/github/openclaw");
  });

  it("replays pending approval prompt when /codex join attaches to a waiting thread", async () => {
    const now = Date.now();
    const sessionEntry: SessionEntry = {
      sessionId: "s-current",
      updatedAt: now,
    };
    const sessionStore = {
      "session-key": sessionEntry,
      "other-session": {
        sessionId: "s-source",
        updatedAt: now + 1,
        codexThreadId: "thread-abc",
        codexRunId: "run-source",
        codexProjectKey: "/tmp/workspace",
        pendingUserInputRequestId: "req-join-1",
        pendingUserInputOptions: ["Approve", "Approve for session", "Deny", "Cancel"],
        pendingUserInputExpiresAt: now + 60_000,
      },
    };
    const result = await runPreparedReply(
      baseParams({
        sessionEntry,
        sessionStore: sessionStore as never,
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          channel: "telegram",
          commandBodyNormalized: "/codex join thread-abc",
        } as never,
      }),
    );
    const reply = asSingleReply(result);
    expect(reply?.text).toContain("Joined this session to Codex thread thread-abc");
    expect(reply?.text).toContain("Agent input requested (req-join-1)");
    expect(reply?.channelData).toMatchObject({
      telegram: {
        buttons: [
          [{ callback_data: "codex_input:req-join-1:1" }],
          [{ callback_data: "codex_input:req-join-1:2" }],
          [{ callback_data: "codex_input:req-join-1:3" }],
          [{ callback_data: "codex_input:req-join-1:4" }],
        ],
      },
    });
    expect(sessionEntry.sessionId).toBe("s-source");
    expect(sessionEntry.pendingUserInputRequestId).toBe("req-join-1");
    expect(sessionEntry.codexAutoRoute).toBe(true);
    expect(vi.mocked(runCodexAppServerAgent)).not.toHaveBeenCalled();
  });

  it("auto-routes plain text to Codex after /codex bind", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "s-1",
      updatedAt: Date.now(),
      codexThreadId: "thread-abc",
      codexProjectKey: "/tmp/codex-project",
      codexAutoRoute: true,
    };
    const sessionStore = { "session-key": sessionEntry };
    const result = await runPreparedReply(
      baseParams({
        sessionEntry,
        sessionStore: sessionStore as never,
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          commandBodyNormalized: "Who are you?",
        } as never,
        ctx: {
          Body: "Who are you?",
          RawBody: "Who are you?",
          CommandBody: "Who are you?",
          ThreadHistoryBody: "Earlier message in this thread",
          OriginatingChannel: "telegram",
          OriginatingTo: "topic:123",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "Who are you?",
          BodyStripped: "Who are you?",
          ThreadHistoryBody: "Earlier message in this thread",
          Provider: "telegram",
          ChatType: "group",
          OriginatingChannel: "telegram",
          OriginatingTo: "topic:123",
        },
      }),
    );
    const reply = asSingleReply(result);
    expect(reply?.text).toContain("codex output summary");
    expect(vi.mocked(runCodexAppServerAgent)).toHaveBeenCalledTimes(1);
    const codexCall = vi.mocked(runCodexAppServerAgent).mock.calls[0]?.[0];
    expect(codexCall?.prompt).toContain("Who are you?");
    expect(codexCall?.workspaceDir).toBe("/tmp/codex-project");
    expect(codexCall?.existingThreadId).toBe("thread-abc");
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
  });

  it("preserves bound routing state when Codex reports thread not found", async () => {
    vi.mocked(runCodexAppServerAgent).mockRejectedValueOnce(
      new Error("thread not found for requested binding thread-abc"),
    );
    const sessionEntry: SessionEntry = {
      sessionId: "s-1",
      updatedAt: Date.now(),
      codexThreadId: "thread-abc",
      codexProjectKey: "/tmp/codex-project",
      codexAutoRoute: true,
    };
    const sessionStore = { "session-key": sessionEntry };
    const result = await runPreparedReply(
      baseParams({
        sessionEntry,
        sessionStore: sessionStore as never,
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          commandBodyNormalized: "What is the CWD?",
        } as never,
        ctx: {
          Body: "What is the CWD?",
          RawBody: "What is the CWD?",
          CommandBody: "What is the CWD?",
          ThreadHistoryBody: "Earlier message in this thread",
          OriginatingChannel: "telegram",
          OriginatingTo: "topic:123",
          ChatType: "group",
        },
        sessionCtx: {
          Body: "What is the CWD?",
          BodyStripped: "What is the CWD?",
          ThreadHistoryBody: "Earlier message in this thread",
          Provider: "telegram",
          ChatType: "group",
          OriginatingChannel: "telegram",
          OriginatingTo: "topic:123",
        },
      }),
    );
    const reply = asSingleReply(result);
    expect(reply?.text).toContain("thread not found for requested binding thread-abc");
    expect(reply?.text).toContain("Binding was kept");
    expect(sessionEntry.codexThreadId).toBe("thread-abc");
    expect(sessionEntry.codexAutoRoute).toBe(true);
    expect(vi.mocked(runReplyAgent)).not.toHaveBeenCalled();
  });

  it("requires known threads for /codex resume and points unknown ids to /codex bind", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "s-1",
      updatedAt: Date.now(),
    };
    const sessionStore = { "session-key": sessionEntry };
    const result = await runPreparedReply(
      baseParams({
        sessionEntry,
        sessionStore: sessionStore as never,
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          commandBodyNormalized: "/codex resume thread-does-not-exist",
        } as never,
      }),
    );
    const reply = asSingleReply(result);
    expect(reply?.text).toContain('No known Codex threads matched "thread-does-not-exist"');
    expect(reply?.text).toContain("/codex bind <thread-id>");
    expect(vi.mocked(runCodexAppServerAgent)).not.toHaveBeenCalled();
  });

  it("clears previous thread state and runs task for /codex new <task>", async () => {
    const sessionEntry = {
      sessionId: "s-1",
      updatedAt: Date.now(),
      codexThreadId: "thread-old",
      codexProjectKey: "/tmp/old",
    };
    const sessionStore = { "session-key": sessionEntry };
    const result = await runPreparedReply(
      baseParams({
        sessionEntry,
        sessionStore: sessionStore as never,
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          commandBodyNormalized: "/codex new investigate flaky test",
        } as never,
      }),
    );

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runCodexAppServerAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runCodexAppServerAgent).mock.calls[0]?.[0]?.prompt).toBe(
      "investigate flaky test",
    );
  });

  it("returns bootstrap ask-then-apply guidance for /codex new without a task", async () => {
    const sessionEntry: SessionEntry = {
      sessionId: "s-1",
      updatedAt: Date.now(),
      codexThreadId: "thread-old",
      codexProjectKey: "/tmp/old",
    };
    const sessionStore = { "session-key": sessionEntry };
    const result = await runPreparedReply(
      baseParams({
        sessionEntry,
        sessionStore: sessionStore as never,
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          commandBodyNormalized: "/codex new",
        } as never,
      }),
    );
    const reply = asSingleReply(result);
    expect(reply?.text).toContain("Bootstrap mode is ask-then-apply");
    expect(reply?.text).toContain("/codex oneshot <task>");
    expect(sessionEntry.codexThreadId).toBeUndefined();
    expect(vi.mocked(runCodexAppServerAgent)).not.toHaveBeenCalled();
  });

  it("routes mirrored /codex_<name> commands through oneshot codex execution", async () => {
    const result = await runPreparedReply(
      baseParams({
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          commandBodyNormalized: "/codex_review focus tests for callback routing",
        } as never,
      }),
    );

    expect(result).toEqual({ text: "ok" });
    expect(vi.mocked(runCodexAppServerAgent)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(runCodexAppServerAgent).mock.calls[0]?.[0]?.prompt).toBe(
      "/review focus tests for callback routing",
    );
  });

  it("rejects unknown mirrored command when discovery is available", async () => {
    vi.mocked(discoverCodexAppServerSlashCommands).mockResolvedValueOnce({
      available: true,
      commands: [{ name: "review", source: "codex", raw: "/review" }],
      collisions: [],
    });
    const result = await runPreparedReply(
      baseParams({
        workspaceDir: "/tmp/ws-codex-mirror-unknown",
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          commandBodyNormalized: "/codex_refactor tighten tests",
        } as never,
      }),
    );
    const reply = asSingleReply(result);
    expect(reply?.text).toContain("Unknown mirrored command");
    expect(vi.mocked(runCodexAppServerAgent)).not.toHaveBeenCalled();
  });

  it("lists discoverable mirrored commands with /codex list commands", async () => {
    vi.mocked(discoverCodexAppServerSlashCommands).mockResolvedValueOnce({
      available: true,
      commands: [
        { name: "review", source: "codex", raw: "/review" },
        { name: "git_status", source: "mcp", raw: "git_status" },
      ],
      collisions: [{ name: "review", raws: ["/review", "review"] }],
    });
    const result = await runPreparedReply(
      baseParams({
        workspaceDir: "/tmp/ws-codex-list-commands",
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          commandBodyNormalized: "/codex list commands",
        } as never,
      }),
    );
    const reply = asSingleReply(result);
    expect(reply?.text).toContain("/codex_review");
    expect(reply?.text).toContain("/codex_git_status");
    expect(reply?.text).toContain("Name collisions skipped");
    expect(vi.mocked(runCodexAppServerAgent)).not.toHaveBeenCalled();
  });

  it("lists Codex thread inventory from Codex App Server with /codex list <filter>", async () => {
    vi.mocked(discoverCodexAppServerThreads).mockResolvedValueOnce({
      available: true,
      threads: [
        {
          threadId: "019-openclaw-1",
          projectKey: "/Users/huntharo/github/openclaw",
          title: "openclaw release prep",
          updatedAt: 1_777_000_000_000,
        },
        {
          threadId: "019-other-1",
          projectKey: "/Users/huntharo/github/other",
          title: "other work",
          updatedAt: 1_776_000_000_000,
        },
      ],
    });
    const result = await runPreparedReply(
      baseParams({
        workspaceDir: "/tmp/ws-codex-list-threads",
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          commandBodyNormalized: "/codex list openclaw",
        } as never,
      }),
    );
    const reply = asSingleReply(result);
    expect(reply?.text).toContain("Known Codex threads (from Codex App Server):");
    expect(reply?.text).toContain("019-openclaw-1");
    expect(reply?.text).not.toContain("019-other-1");
    expect(vi.mocked(runCodexAppServerAgent)).not.toHaveBeenCalled();
  });

  it("falls back to locally bound sessions when Codex list discovery is unavailable", async () => {
    vi.mocked(discoverCodexAppServerThreads).mockResolvedValueOnce({
      available: false,
      threads: [],
      error: "rpc unavailable",
    });
    const now = Date.now();
    const sessionStore = {
      "session-key": {
        sessionId: "s-1",
        updatedAt: now,
        codexThreadId: "thread-local-1",
        codexProjectKey: "/Users/huntharo/github/openclaw",
      },
    };
    const result = await runPreparedReply(
      baseParams({
        sessionEntry: sessionStore["session-key"],
        sessionStore: sessionStore as never,
        command: {
          isAuthorizedSender: true,
          abortKey: "session-key",
          ownerList: [],
          senderIsOwner: false,
          commandBodyNormalized: "/codex list openclaw",
        } as never,
      }),
    );
    const reply = asSingleReply(result);
    expect(reply?.text).toContain("thread-local-1");
    expect(reply?.text).toContain("Codex thread discovery unavailable");
    expect(reply?.text).toContain("locally known OpenClaw-bound Codex threads");
    expect(vi.mocked(runCodexAppServerAgent)).not.toHaveBeenCalled();
  });

  it("forces steer queue mode while pending codex input is active", async () => {
    const sessionEntry = {
      sessionId: "s-1",
      updatedAt: Date.now(),
      pendingUserInputRequestId: "req-1",
      pendingUserInputExpiresAt: Date.now() + 60_000,
    };
    const result = await runPreparedReply(
      baseParams({
        sessionEntry,
        sessionCtx: {
          Body: "1",
          BodyStripped: "1",
          Provider: "telegram",
          ChatType: "group",
          OriginatingChannel: "telegram",
          OriginatingTo: "1234",
        },
        ctx: {
          Body: "1",
          RawBody: "1",
          CommandBody: "1",
          OriginatingChannel: "telegram",
          OriginatingTo: "1234",
          ChatType: "group",
        },
      }),
    );

    expect(result).toEqual({ text: "ok" });
    const call = vi.mocked(runReplyAgent).mock.calls[0]?.[0];
    expect(call?.resolvedQueue.mode).toBe("steer");
    expect(call?.shouldSteer).toBe(true);
  });
});
