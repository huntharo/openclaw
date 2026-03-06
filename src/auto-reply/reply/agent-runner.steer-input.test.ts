import { describe, expect, it, vi } from "vitest";
import type { TemplateContext } from "../templating.js";
import type { FollowupRun, QueueSettings } from "./queue.js";
import { createMockTypingController } from "./test-helpers.js";

const queueAgentRunMessageMock = vi.fn();

vi.mock("../../agents/run-control.js", () => ({
  queueAgentRunMessage: (...args: unknown[]) => queueAgentRunMessageMock(...args),
}));

import { runReplyAgent } from "./agent-runner.js";

describe("runReplyAgent steer input routing", () => {
  it("uses the raw summary line when steering an active run", async () => {
    queueAgentRunMessageMock.mockReset();
    queueAgentRunMessageMock.mockReturnValue(true);
    const typing = createMockTypingController();
    const followupRun = {
      prompt: "full prompt context",
      summaryLine: "1",
      enqueuedAt: Date.now(),
      run: {
        sessionId: "session-1",
        sessionKey: "main",
        messageProvider: "telegram",
        sessionFile: "/tmp/session.jsonl",
        workspaceDir: "/tmp",
        config: {},
        skillsSnapshot: {},
        provider: "anthropic",
        model: "claude-opus",
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
    } as unknown as FollowupRun;
    const result = await runReplyAgent({
      commandBody: "[Inbound context]\n\nUser said: 1",
      followupRun,
      queueKey: "main",
      resolvedQueue: { mode: "steer" } as QueueSettings,
      shouldSteer: true,
      shouldFollowup: false,
      isActive: true,
      isStreaming: true,
      typing,
      sessionCtx: {
        Provider: "telegram",
        OriginatingChannel: "telegram",
        OriginatingTo: "group:123:topic:1",
      } as TemplateContext,
      defaultModel: "anthropic/claude-opus",
      resolvedVerboseLevel: "off",
      isNewSession: false,
      blockStreamingEnabled: false,
      resolvedBlockStreamingBreak: "message_end",
      shouldInjectGroupIntro: false,
      typingMode: "instant",
    });

    expect(result).toBeUndefined();
    expect(queueAgentRunMessageMock).toHaveBeenCalledWith("session-1", "1");
    expect(typing.cleanup).toHaveBeenCalledTimes(1);
  });
});
