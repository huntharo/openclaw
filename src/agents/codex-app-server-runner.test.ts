import { describe, expect, it, vi } from "vitest";
import {
  __testing,
  isCodexAppServerProvider,
  parseCodexUserInput,
} from "./codex-app-server-runner.js";

describe("parseCodexUserInput", () => {
  it("parses numeric option choices", () => {
    expect(parseCodexUserInput("1", 3)).toEqual({ kind: "option", index: 0 });
    expect(parseCodexUserInput("option 2", 3)).toEqual({ kind: "option", index: 1 });
    expect(parseCodexUserInput("Option 3", 3)).toEqual({ kind: "option", index: 2 });
  });

  it("falls back to free-form text for invalid option indices", () => {
    expect(parseCodexUserInput("0", 3)).toEqual({ kind: "text", text: "0" });
    expect(parseCodexUserInput("option 9", 3)).toEqual({ kind: "text", text: "option 9" });
  });

  it("returns text when there is no option syntax", () => {
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

describe("isMethodUnavailableError", () => {
  it("recognizes unknown variant errors for the matching rpc method", () => {
    expect(
      __testing.isMethodUnavailableError(
        new Error(
          "codex app server rpc error (-32600): Invalid request: unknown variant `session/update`",
        ),
        "session/update",
      ),
    ).toBe(true);
  });

  it("does not treat other unknown variant errors as the same rpc method", () => {
    expect(
      __testing.isMethodUnavailableError(
        new Error(
          "codex app server rpc error (-32600): Invalid request: unknown variant `thread/list`",
        ),
        "session/update",
      ),
    ).toBe(false);
  });
});

describe("isTransportClosedError", () => {
  it("recognizes stdio disconnect write failures", () => {
    expect(
      __testing.isTransportClosedError(new Error("codex app server stdio not connected")),
    ).toBe(true);
  });

  it("does not hide unrelated transport errors", () => {
    expect(
      __testing.isTransportClosedError(new Error("codex app server timeout: turn/start")),
    ).toBe(false);
  });
});

describe("applyThreadFilter", () => {
  it("prefers project path matches over summary text matches", () => {
    const threads = [
      {
        threadId: "thread-1",
        projectKey: "/Users/huntharo/github/jeerreview",
      },
      {
        threadId: "thread-2",
        title: "Planning work",
        projectKey: "/Users/huntharo/.openclaw/workspace-pwrdrvr",
        summary: "Discussed jeerreview migration details",
      },
      {
        threadId: "thread-3",
        title: "Plan TASKS doc refresh",
        projectKey: "/Users/huntharo/github/jeerreview",
      },
    ];

    expect(__testing.applyThreadFilter(threads, "jeerreview")).toEqual([threads[0], threads[2]]);
  });

  it("prefers title matches before falling back to summary matches", () => {
    const threads = [
      {
        threadId: "thread-1",
        title: "Fix Telegram approval flow",
        projectKey: "/Users/huntharo/github/openclaw",
      },
      {
        threadId: "thread-2",
        summary: "Work on Telegram approval buttons",
        projectKey: "/Users/huntharo/.openclaw/workspace-pwrdrvr",
      },
    ];

    expect(__testing.applyThreadFilter(threads, "approval")).toEqual([threads[0]]);
  });
});

describe("buildCodexPendingUserInputActions", () => {
  it("renders typed approval actions and a steer affordance", () => {
    expect(
      __testing.buildCodexPendingUserInputActions({
        method: "item/commandExecution/requestApproval",
        requestParams: {
          availableDecisions: [
            { decision: "accept", label: "Approve Once" },
            { decision: "decline", label: "Decline" },
          ],
        },
      }),
    ).toEqual([
      {
        kind: "approval",
        decision: "accept",
        responseDecision: "accept",
        label: "Approve Once",
      },
      {
        kind: "approval",
        decision: "decline",
        responseDecision: "decline",
        label: "Decline",
      },
      { kind: "steer", label: "Tell Codex What To Do" },
    ]);
  });
});

describe("buildMarkdownCodeBlock", () => {
  it("renders shell commands as fenced code blocks", () => {
    expect(
      __testing.buildMarkdownCodeBlock(
        "/bin/zsh -lc 'npm view diver name version description'",
        "sh",
      ),
    ).toBe("```sh\n/bin/zsh -lc 'npm view diver name version description'\n```");
  });

  it("extends the fence length when the command already contains backticks", () => {
    expect(__testing.buildMarkdownCodeBlock("echo ```hello```", "sh")).toBe(
      "````sh\necho ```hello```\n````",
    );
  });
});

describe("mergeAssistantReplyAndEmit", () => {
  it("emits cumulative preview text for snapshot-style partials", async () => {
    const onPartialReply = vi.fn();

    let assistantText = "";
    assistantText = await __testing.mergeAssistantReplyAndEmit({
      assistantText,
      incomingText: "Cod",
      onPartialReply,
    });
    assistantText = await __testing.mergeAssistantReplyAndEmit({
      assistantText,
      incomingText: "Codex",
      onPartialReply,
    });
    assistantText = await __testing.mergeAssistantReplyAndEmit({
      assistantText,
      incomingText: "Codex. I'm your workspace AI engineer.",
      onPartialReply,
    });

    expect(assistantText).toBe("Codex. I'm your workspace AI engineer.");
    expect(onPartialReply).toHaveBeenNthCalledWith(1, { text: "Cod" });
    expect(onPartialReply).toHaveBeenNthCalledWith(2, { text: "Codex" });
    expect(onPartialReply).toHaveBeenNthCalledWith(3, {
      text: "Codex. I'm your workspace AI engineer.",
    });
  });

  it("preserves token spacing when Codex streams raw deltas", async () => {
    const onPartialReply = vi.fn();

    let assistantText = "";
    assistantText = await __testing.mergeAssistantReplyAndEmit({
      assistantText,
      incomingText: "Cod",
      onPartialReply,
    });
    assistantText = await __testing.mergeAssistantReplyAndEmit({
      assistantText,
      incomingText: "ex",
      onPartialReply,
    });
    assistantText = await __testing.mergeAssistantReplyAndEmit({
      assistantText,
      incomingText: ". Your",
      onPartialReply,
    });
    assistantText = await __testing.mergeAssistantReplyAndEmit({
      assistantText,
      incomingText: " pragmatic AI dev partner in this workspace.",
      onPartialReply,
    });

    expect(assistantText).toBe("Codex. Your pragmatic AI dev partner in this workspace.");
    expect(onPartialReply).toHaveBeenNthCalledWith(1, { text: "Cod" });
    expect(onPartialReply).toHaveBeenNthCalledWith(2, { text: "Codex" });
    expect(onPartialReply).toHaveBeenNthCalledWith(3, {
      text: "Codex. Your",
    });
    expect(onPartialReply).toHaveBeenNthCalledWith(4, {
      text: "Codex. Your pragmatic AI dev partner in this workspace.",
    });
  });

  it("does not re-emit when the incoming text is already contained in the preview", async () => {
    const onPartialReply = vi.fn();

    const assistantText = await __testing.mergeAssistantReplyAndEmit({
      assistantText: "Codex. I'm your workspace AI engineer.",
      incomingText: "Codex",
      onPartialReply,
    });

    expect(assistantText).toBe("Codex. I'm your workspace AI engineer.");
    expect(onPartialReply).not.toHaveBeenCalled();
  });
});

describe("collectStreamingText", () => {
  it("prefers raw delta text without trimming token whitespace", () => {
    expect(
      __testing.collectStreamingText({
        item: {
          delta: " pragmatic",
          text: "ignored full snapshot",
        },
      }),
    ).toBe(" pragmatic");
  });

  it("can surface prompt text from turn-start style payloads, so callers must not use it for assistant previews", () => {
    expect(
      __testing.collectStreamingText({
        threadId: "thread-1",
        turnId: "turn-1",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Who are you?" }],
          },
        ],
      }),
    ).toBe("Who are you?");
  });
});

describe("extractAssistantNotificationText", () => {
  it("extracts streamed assistant text from agentMessage delta notifications", () => {
    expect(
      __testing.extractAssistantNotificationText("item/agentMessage/delta", {
        item: {
          id: "assistant-item-1",
          type: "agentMessage",
          delta: " in this workspace.",
        },
      }),
    ).toEqual({
      mode: "delta",
      text: " in this workspace.",
      itemId: "assistant-item-1",
    });
  });

  it("extracts completed assistant snapshots from item/completed notifications", () => {
    expect(
      __testing.extractAssistantNotificationText("item/completed", {
        item: {
          id: "assistant-item-2",
          type: "agentMessage",
          text: "Codex. I'm your AI engineering assistant in this workspace.",
        },
      }),
    ).toEqual({
      mode: "snapshot",
      text: "Codex. I'm your AI engineering assistant in this workspace.",
      itemId: "assistant-item-2",
    });
  });

  it("ignores userMessage item notifications", () => {
    expect(
      __testing.extractAssistantNotificationText("item/completed", {
        item: {
          type: "userMessage",
          text: "Who are you?",
        },
      }),
    ).toEqual({
      mode: "snapshot",
      text: "",
    });
  });

  it("ignores generic turn payloads that can echo prompt input", () => {
    expect(
      __testing.extractAssistantNotificationText("turn/updated", {
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Who are you?" }],
          },
        ],
        turn: {
          id: "turn-1",
        },
      }),
    ).toEqual({
      mode: "ignore",
      text: "",
    });
  });

  it("ignores item/started payloads so early snapshots do not duplicate streamed text", () => {
    expect(
      __testing.extractAssistantNotificationText("item/started", {
        item: {
          type: "agentMessage",
          text: "I’m checking your recent workspace memory notes...",
        },
      }),
    ).toEqual({
      mode: "ignore",
      text: "",
    });
  });
});

describe("extractThreadReplayFromReadResult", () => {
  it("parses userMessage and agentMessage items from thread/read turns", () => {
    expect(
      __testing.extractThreadReplayFromReadResult({
        thread: {
          id: "thread-1",
          turns: [
            {
              id: "turn-1",
              items: [
                {
                  type: "userMessage",
                  content: [{ type: "text", text: "Old request" }],
                },
                {
                  type: "agentMessage",
                  text: "Old response",
                },
              ],
            },
            {
              id: "turn-2",
              items: [
                {
                  type: "userMessage",
                  content: [{ type: "text", text: "Newest request" }],
                },
                {
                  type: "agentMessage",
                  text: "Newest response",
                },
              ],
            },
          ],
        },
      }),
    ).toEqual({
      lastUserMessage: "Newest request",
      lastAssistantMessage: "Newest response",
    });
  });

  it("returns the most recent user request and assistant reply from a thread read result", () => {
    const messages = Array.from({ length: 100 }, (_, index) => ({
      type: "message",
      role: index % 2 === 0 ? "user" : "assistant",
      content: [
        {
          type: "input_text",
          text:
            index === 98
              ? "Most recent user request"
              : index === 99
                ? "Most recent assistant reply"
                : `Older message ${index}`,
        },
      ],
    }));
    messages[99] = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Most recent assistant reply" }],
    };

    expect(
      __testing.extractThreadReplayFromReadResult({
        thread: {
          id: "thread-1",
        },
        items: messages,
      }),
    ).toEqual({
      lastUserMessage: "Most recent user request",
      lastAssistantMessage: "Most recent assistant reply",
    });
  });

  it("ignores earlier conversation text once a later user and assistant pair exists", () => {
    const replay = __testing.extractThreadReplayFromReadResult({
      items: [
        {
          role: "user",
          text: "Old request that should not be replayed",
        },
        {
          role: "assistant",
          text: "Old response that should not be replayed",
        },
        {
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Newest request" }],
          },
        },
        {
          item: {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Newest response" }],
          },
        },
      ],
    });

    expect(replay.lastUserMessage).toBe("Newest request");
    expect(replay.lastAssistantMessage).toBe("Newest response");
    expect(replay.lastUserMessage).not.toContain("Old request");
    expect(replay.lastAssistantMessage).not.toContain("Old response");
  });
});

describe("mapPendingInputResponse", () => {
  it("maps approval actions to the expected Codex decision", () => {
    expect(
      __testing.mapPendingInputResponse({
        methodLower: "server/requestapproval",
        requestParams: {},
        response: { index: 1 },
        options: ["Approve Once", "Approve for Session"],
        actions: [
          {
            kind: "approval",
            decision: "accept",
            responseDecision: "accept",
            label: "Approve Once",
          },
          {
            kind: "approval",
            decision: "acceptForSession",
            responseDecision: "acceptForSession",
            label: "Approve for Session",
          },
        ],
        timedOut: false,
      }),
    ).toEqual({ decision: "acceptForSession" });
  });

  it("maps timed-out approvals to cancel", () => {
    expect(
      __testing.mapPendingInputResponse({
        methodLower: "server/requestapproval",
        requestParams: {},
        response: { text: "Approve" },
        options: ["Approve", "Decline"],
        actions: [
          {
            kind: "approval",
            decision: "accept",
            responseDecision: "accept",
            label: "Approve",
          },
          {
            kind: "approval",
            decision: "decline",
            responseDecision: "decline",
            label: "Decline",
          },
        ],
        timedOut: true,
      }),
    ).toEqual({ decision: "cancel" });
  });

  it("preserves exec policy amendments for session-scoped approvals", () => {
    expect(
      __testing.mapPendingInputResponse({
        methodLower: "server/requestapproval",
        requestParams: {},
        response: { index: 0 },
        options: ["Approve for Session"],
        actions: [
          {
            kind: "approval",
            decision: "acceptForSession",
            responseDecision: "acceptWithExecpolicyAmendment",
            label: "Approve for Session",
            proposedExecpolicyAmendment: { prefix: "npm view" },
            sessionPrefix: "npm view",
          },
        ],
        timedOut: false,
      }),
    ).toEqual({
      decision: "acceptWithExecpolicyAmendment",
      proposedExecpolicyAmendment: { prefix: "npm view" },
    });
  });

  it("maps tool request user input selections into answer payloads", () => {
    expect(
      __testing.mapPendingInputResponse({
        methodLower: "item/tool/requestuserinput",
        requestParams: {
          questions: [
            {
              id: "approval",
              options: [{ label: "Approve" }, { label: "Decline" }],
            },
          ],
        },
        response: { index: 1 },
        options: ["Approve", "Decline"],
        actions: [
          { kind: "option", label: "Approve", value: "Approve" },
          { kind: "option", label: "Decline", value: "Decline" },
        ],
        timedOut: false,
      }),
    ).toEqual({
      answers: {
        approval: {
          answers: ["Decline"],
        },
      },
    });
  });
});

describe("dispatchJsonRpcEnvelope", () => {
  it("swallows transport-closed errors while responding to app-server requests", async () => {
    await expect(
      __testing.dispatchJsonRpcEnvelope(
        {
          jsonrpc: "2.0",
          id: "req-1",
          method: "server/requestApproval",
          params: {},
        },
        {
          pending: new Map(),
          onNotification: vi.fn(),
          onRequest: vi.fn(async () => ({ decision: "accept" })),
          respond: () => {
            throw new Error("codex app server stdio not connected");
          },
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("responds with an rpc error when the request handler throws", async () => {
    const respond = vi.fn();

    await __testing.dispatchJsonRpcEnvelope(
      {
        jsonrpc: "2.0",
        id: "req-2",
        method: "server/requestApproval",
        params: {},
      },
      {
        pending: new Map(),
        onNotification: vi.fn(),
        onRequest: vi.fn(async () => {
          throw new Error("boom");
        }),
        respond,
      },
    );

    expect(respond).toHaveBeenCalledWith({
      jsonrpc: "2.0",
      id: "req-2",
      error: {
        code: -32603,
        message: "boom",
      },
    });
  });
});
