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

describe("thread-scoped rpc guards", () => {
  it("marks turn/steer as requiring a thread id", () => {
    expect(__testing.methodRequiresThreadId("turn/steer")).toBe(true);
    expect(__testing.methodRequiresThreadId("thread/read")).toBe(true);
    expect(__testing.methodRequiresThreadId("thread/list")).toBe(false);
  });

  it("detects thread id fields in camelCase and snake_case payloads", () => {
    expect(__testing.payloadHasThreadId({ threadId: "thread-123" })).toBe(true);
    expect(__testing.payloadHasThreadId({ thread_id: "thread-123" })).toBe(true);
    expect(__testing.payloadHasThreadId({ turnId: "turn-123" })).toBe(false);
    expect(__testing.payloadHasThreadId({})).toBe(false);
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

describe("extractThreadsFromValue", () => {
  it("normalizes mixed second and millisecond timestamps before sorting recent threads", () => {
    expect(
      __testing.extractThreadsFromValue({
        threads: [
          {
            id: "older-ms",
            title: "Older thread",
            cwd: "/repo/openclaw",
            updatedAt: 1_700_000_000_000,
          },
          {
            id: "newer-sec",
            title: "Newest thread",
            cwd: "/repo/openclaw",
            updatedAt: 1_800_000_000,
          },
          {
            id: "middle-sec",
            title: "Middle thread",
            cwd: "/repo/openclaw",
            updatedAt: 1_750_000_000,
          },
        ],
      }),
    ).toEqual([
      {
        threadId: "newer-sec",
        title: "Newest thread",
        summary: "",
        projectKey: "/repo/openclaw",
        updatedAt: 1_800_000_000_000,
      },
      {
        threadId: "middle-sec",
        title: "Middle thread",
        summary: "",
        projectKey: "/repo/openclaw",
        updatedAt: 1_750_000_000_000,
      },
      {
        threadId: "older-ms",
        title: "Older thread",
        summary: "",
        projectKey: "/repo/openclaw",
        updatedAt: 1_700_000_000_000,
      },
    ]);
  });
});

describe("extractThreadState", () => {
  it("pulls model, cwd, permissions, and service tier from thread/resume responses", () => {
    expect(
      __testing.extractThreadState({
        thread: { id: "thread-123", name: "Plan TASKS doc refresh" },
        model: "gpt-5.4",
        modelProvider: "openai",
        serviceTier: "fast",
        cwd: "/repo/openclaw",
        approvalPolicy: "on-request",
        sandbox: {
          workspaceWrite: {
            networkAccess: false,
          },
        },
        reasoningEffort: "high",
      }),
    ).toEqual({
      threadId: "thread-123",
      threadName: "Plan TASKS doc refresh",
      model: "gpt-5.4",
      modelProvider: "openai",
      serviceTier: "fast",
      cwd: "/repo/openclaw",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      reasoningEffort: "high",
    });
  });
});

describe("extractThreadTokenUsageSnapshot", () => {
  it("prefers current-context usage over cumulative totals when both are present", () => {
    expect(
      __testing.extractThreadTokenUsageSnapshot({
        threadId: "thread-123",
        tokenUsage: {
          last: {
            totalTokens: 139_000,
            inputTokens: 120_000,
            cachedInputTokens: 9_000,
            outputTokens: 10_000,
          },
          total: {
            totalTokens: 56_100_000,
            inputTokens: 55_000_000,
            cachedInputTokens: 300_000,
            outputTokens: 1_100_000,
          },
          modelContextWindow: 258_000,
        },
      }),
    ).toEqual({
      totalTokens: 139_000,
      inputTokens: 120_000,
      cachedInputTokens: 9_000,
      outputTokens: 10_000,
      reasoningOutputTokens: undefined,
      contextWindow: 258_000,
      remainingTokens: 119_000,
      remainingPercent: 46,
    });
  });

  it("normalizes thread/tokenUsage/updated notifications into a context snapshot", () => {
    expect(
      __testing.extractThreadTokenUsageSnapshot({
        threadId: "thread-123",
        turnId: "turn-123",
        tokenUsage: {
          total: {
            totalTokens: 54_000,
            inputTokens: 49_000,
            cachedInputTokens: 3_000,
            outputTokens: 5_000,
            reasoningOutputTokens: 1_000,
          },
          modelContextWindow: 272_000,
        },
      }),
    ).toEqual({
      totalTokens: 54_000,
      inputTokens: 49_000,
      cachedInputTokens: 3_000,
      outputTokens: 5_000,
      reasoningOutputTokens: 1_000,
      contextWindow: 272_000,
      remainingTokens: 218_000,
      remainingPercent: 80,
    });
  });
});

describe("extractContextCompactionProgress", () => {
  it("detects compaction item start notifications", () => {
    expect(
      __testing.extractContextCompactionProgress("item/started", {
        item: { id: "compact-1", type: "contextCompaction" },
      }),
    ).toEqual({
      phase: "started",
      itemId: "compact-1",
    });
  });

  it("treats thread/compacted as compaction completion", () => {
    expect(__testing.extractContextCompactionProgress("thread/compacted", {})).toEqual({
      phase: "completed",
    });
  });
});

describe("buildTurnStartPayloads", () => {
  it("does not resend cwd on resumed-thread turn/start payloads", () => {
    expect(
      __testing.buildTurnStartPayloads({
        threadId: "thread-123",
        prompt: "ship it",
        model: "gpt-5.4",
      }),
    ).toEqual([
      {
        threadId: "thread-123",
        input: [{ type: "text", text: "ship it" }],
        model: "gpt-5.4",
      },
      {
        thread_id: "thread-123",
        input: [{ type: "text", text: "ship it" }],
        model: "gpt-5.4",
      },
      {
        threadId: "thread-123",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "ship it" }],
          },
        ],
        model: "gpt-5.4",
      },
      {
        thread_id: "thread-123",
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "ship it" }],
          },
        ],
        model: "gpt-5.4",
      },
    ]);
  });
});

describe("buildSessionUpdatePayload", () => {
  it("does not include cwd in session metadata updates", () => {
    expect(__testing.buildSessionUpdatePayload("session-123")).toEqual({
      sessionKey: "session-123",
      session_key: "session-123",
    });
  });
});

describe("buildThreadResumePayloads", () => {
  it("omits cwd for nominal thread resume requests", () => {
    expect(
      __testing.buildThreadResumePayloads({
        threadId: "thread-123",
      }),
    ).toEqual([{ threadId: "thread-123" }]);
  });

  it("does not add cwd when changing service tier on an existing thread", () => {
    expect(
      __testing.buildThreadResumePayloads({
        threadId: "thread-123",
        serviceTier: "fast",
      }),
    ).toEqual([{ threadId: "thread-123", serviceTier: "fast" }]);
  });
});

describe("isCodexAppServerMissingThreadError", () => {
  it("detects the codex missing-thread rollout error without matching field errors", () => {
    expect(
      __testing.isCodexAppServerMissingThreadError(
        new Error("codex app server rpc error (-32600): no rollout found for thread id abc"),
      ),
    ).toBe(true);
    expect(
      __testing.isCodexAppServerMissingThreadError(new Error("missing field `threadId`")),
    ).toBe(false);
  });
});

describe("buildThreadDiscoveryFilter", () => {
  it("keeps cwd only for explicit thread list filtering", () => {
    expect(__testing.buildThreadDiscoveryFilter(undefined, "/repo/openclaw")).toEqual([
      {
        query: undefined,
        cwd: "/repo/openclaw",
        limit: 50,
      },
      {
        filter: undefined,
        cwd: "/repo/openclaw",
        limit: 50,
      },
      {},
    ]);
  });

  it("passes the search term through to the app server request payloads", () => {
    expect(__testing.buildThreadDiscoveryFilter("openclaw", "/repo/openclaw")).toEqual([
      {
        query: "openclaw",
        cwd: "/repo/openclaw",
        limit: 50,
      },
      {
        filter: "openclaw",
        cwd: "/repo/openclaw",
        limit: 50,
      },
      {},
    ]);
  });
});

describe("extractAccountSummary", () => {
  it("parses chatgpt account/read responses", () => {
    expect(
      __testing.extractAccountSummary({
        account: {
          type: "chatgpt",
          email: "user@example.com",
          planType: "pro",
        },
        requiresOpenaiAuth: true,
      }),
    ).toEqual({
      type: "chatgpt",
      email: "user@example.com",
      planType: "pro",
      requiresOpenaiAuth: true,
    });
  });
});

describe("extractRateLimitSummaries", () => {
  it("parses primary and secondary windows from account/rateLimits/read", () => {
    expect(
      __testing.extractRateLimitSummaries({
        rateLimits: {
          primary: {
            usedPercent: 4,
            windowDurationMins: 300,
            resetsAt: 1_700_000_000,
          },
          secondary: {
            usedPercent: 17,
            windowDurationMins: 10080,
            resetsAt: 1_700_100_000,
          },
        },
      }),
    ).toEqual([
      {
        name: "5h limit",
        limitId: undefined,
        remaining: 96,
        limit: undefined,
        used: undefined,
        usedPercent: 4,
        resetAt: 1_700_000_000_000,
        windowSeconds: 18_000,
        windowMinutes: 300,
      },
      {
        name: "Weekly limit",
        limitId: undefined,
        remaining: 83,
        limit: undefined,
        used: undefined,
        usedPercent: 17,
        resetAt: 1_700_100_000_000,
        windowSeconds: 604_800,
        windowMinutes: 10080,
      },
    ]);
  });
});

describe("extractSkillSummaries", () => {
  it("parses skills/list responses into local summaries", () => {
    expect(
      __testing.extractSkillSummaries({
        data: [
          {
            cwd: "/repo/openclaw",
            skills: [
              {
                name: "skill-creator",
                description: "Create or update a Codex skill",
                enabled: true,
              },
              {
                name: "legacy-helper",
                interface: {
                  shortDescription: "Old helper",
                },
                enabled: false,
              },
            ],
          },
        ],
      }),
    ).toEqual([
      {
        cwd: "/repo/openclaw",
        name: "legacy-helper",
        description: "Old helper",
        enabled: false,
      },
      {
        cwd: "/repo/openclaw",
        name: "skill-creator",
        description: "Create or update a Codex skill",
        enabled: true,
      },
    ]);
  });
});

describe("multi-question request_user_input helpers", () => {
  const multiQuestionRequest = {
    questions: [
      {
        id: "priority",
        header: "Priority",
        question: "What matters most for v1 hosting?",
        options: [
          { label: "Cheap + simple (Recommended)", description: "Lowest monthly cost." },
          { label: "Managed DX", description: "Prefer hosted dashboards." },
        ],
      },
      {
        id: "runtime",
        header: "Runtime",
        question: "Which runtime shape should we optimize for?",
        options: [
          {
            label: "Long-lived service (Recommended)",
            description: "Best fit for stateful flows.",
          },
          { label: "Mostly serverless", description: "Best fit for stateless handlers." },
        ],
        isOther: true,
      },
      {
        id: "db",
        header: "DB",
        question: "What kind of database migration do you want from SQLite?",
        options: [
          { label: "Postgres (Recommended)", description: "Straightforward production path." },
          { label: "Firestore", description: "Bigger data-model rewrite." },
        ],
      },
    ],
  };

  it("renders only the active question for multi-question prompts", () => {
    const presentation = __testing.buildInteractiveRequestPresentation({
      method: "item/tool/requestUserInput",
      requestId: "req-1",
      requestParams: multiQuestionRequest,
      expiresAt: Date.now() + 900_000,
      options: [],
      activeQuestionIndex: 1,
    });

    expect(presentation.promptText).toContain("Question 2 of 3:");
    expect(presentation.promptText).toContain(
      "Runtime: Which runtime shape should we optimize for?",
    );
    expect(presentation.promptText).toContain("1. Long-lived service (Recommended)");
    expect(presentation.promptText).toContain("Other: You can reply with free text.");
    expect(presentation.promptText).not.toContain("Priority: What matters most for v1 hosting?");
    expect(presentation.promptText).not.toContain(
      "DB: What kind of database migration do you want from SQLite?",
    );
  });

  it("advances through questions and builds a combined answers payload", () => {
    const initial = __testing.buildInteractiveRequestPresentation({
      method: "item/tool/requestUserInput",
      requestId: "req-1",
      requestParams: multiQuestionRequest,
      expiresAt: Date.now() + 900_000,
      options: [],
    });
    const pending = {
      requestId: "req-1",
      methodLower: "item/tool/requestuserinput",
      options: initial.options,
      actions: initial.actions,
      expiresAt: Date.now() + 900_000,
      resolve: () => undefined,
      questionSummaries: initial.questionSummaries,
      currentQuestionIndex: initial.currentQuestionIndex,
      answersByQuestionId: {},
      promptText: initial.promptText,
      requestParams: multiQuestionRequest,
    };

    const second = __testing.advancePendingQuestionnaire({
      pendingInput: pending,
      answerText: "Cheap + simple (Recommended)",
    });
    expect(second.done).toBe(false);
    if (second.done) {
      throw new Error("expected second question");
    }
    pending.currentQuestionIndex = second.nextQuestionIndex;
    pending.actions = second.actions;
    pending.options = second.options;
    pending.promptText = second.promptText;

    const third = __testing.advancePendingQuestionnaire({
      pendingInput: pending,
      answerText: "Long-lived service (Recommended)",
    });
    expect(third.done).toBe(false);
    if (third.done) {
      throw new Error("expected third question");
    }
    pending.currentQuestionIndex = third.nextQuestionIndex;
    pending.actions = third.actions;
    pending.options = third.options;
    pending.promptText = third.promptText;

    const done = __testing.advancePendingQuestionnaire({
      pendingInput: pending,
      answerText: "Postgres (Recommended)",
    });
    expect(done).toEqual({
      done: true,
      response: {
        answers: {
          priority: { answers: ["Cheap + simple (Recommended)"] },
          runtime: { answers: ["Long-lived service (Recommended)"] },
          db: { answers: ["Postgres (Recommended)"] },
        },
      },
    });
  });
});

describe("buildPromptText", () => {
  it("renders request_user_input questions with descriptions and recommended labels", () => {
    const text = __testing.buildPromptText({
      method: "item/tool/requestUserInput",
      requestId: "req-plan-1",
      options: ["Use checkboxes", "Use numbered phases (Recommended)"],
      actions: [
        { kind: "option", label: "Use checkboxes", value: "Use checkboxes" },
        {
          kind: "option",
          label: "Use numbered phases (Recommended)",
          value: "Use numbered phases (Recommended)",
        },
      ],
      question: "How should the final plan be organized?",
      expiresAt: Date.now() + 120_000,
      requestParams: {
        questions: [
          {
            id: "plan_shape",
            header: "Plan Shape",
            question: "How should the final plan be organized?",
            isOther: true,
            options: [
              {
                label: "Use checkboxes",
                description: "Track progress inside each phase with checkboxes.",
              },
              {
                label: "Use numbered phases (Recommended)",
                description: "Keep the plan concise and phase-oriented.",
              },
            ],
          },
        ],
      },
    });

    expect(text).toContain("Question:");
    expect(text).toContain("Plan Shape: How should the final plan be organized?");
    expect(text).toContain("1. Use checkboxes");
    expect(text).toContain("Track progress inside each phase with checkboxes.");
    expect(text).toContain("2. Use numbered phases (Recommended)");
    expect(text).toContain("Keep the plan concise and phase-oriented.");
    expect(text).toContain("Other: You can reply with free text.");
    expect(text).toContain('Reply with "1", "2", "option 1", etc., or use a button.');
  });
});

describe("extractExperimentalFeatureSummaries", () => {
  it("parses experimentalFeature/list responses into local summaries", () => {
    expect(
      __testing.extractExperimentalFeatureSummaries({
        data: [
          {
            name: "fancy_feature",
            stage: "beta",
            displayName: "Fancy Feature",
            enabled: true,
            defaultEnabled: false,
          },
        ],
      }),
    ).toEqual([
      {
        name: "fancy_feature",
        stage: "beta",
        displayName: "Fancy Feature",
        description: undefined,
        enabled: true,
        defaultEnabled: false,
      },
    ]);
  });
});

describe("extractMcpServerSummaries", () => {
  it("parses mcpServerStatus/list responses into local summaries", () => {
    expect(
      __testing.extractMcpServerSummaries({
        data: [
          {
            name: "github",
            authStatus: "authenticated",
            tools: {
              search: {},
              read: {},
            },
            resources: [{}, {}],
            resourceTemplates: [{}],
          },
        ],
      }),
    ).toEqual([
      {
        name: "github",
        authStatus: "authenticated",
        toolCount: 2,
        resourceCount: 2,
        resourceTemplateCount: 1,
      },
    ]);
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

describe("extractOptionValues", () => {
  it("finds nested approval labels from question payloads", () => {
    expect(
      __testing.extractOptionValues({
        questions: [
          {
            decisions: [
              { decision: "accept", label: "Yes" },
              {
                decision: "acceptWithExecPolicyAmendment",
                label: "Yes, and don't ask again for commands that start with npm view",
              },
              { decision: "decline", label: "No" },
            ],
          },
        ],
      }),
    ).toEqual(["Yes", "Yes, and don't ask again for commands that start with npm view", "No"]);
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

describe("buildPromptText", () => {
  it("renders nested approval question, command, cwd, and labeled choices", () => {
    const text = __testing.buildPromptText({
      method: "item/commandExecution/requestApproval",
      requestId: "req-1",
      options: ["Yes", "Yes, and don't ask again for commands that start with npm view", "No"],
      actions: [
        {
          kind: "approval",
          decision: "accept",
          responseDecision: "accept",
          label: "Yes",
        },
        {
          kind: "approval",
          decision: "acceptForSession",
          responseDecision: "acceptWithExecPolicyAmendment",
          label: "Yes, and don't ask again for commands that start with npm view",
          proposedExecpolicyAmendment: { prefix: "npm view" },
          sessionPrefix: "npm view",
        },
        {
          kind: "approval",
          decision: "decline",
          responseDecision: "decline",
          label: "No",
        },
        { kind: "steer", label: "Tell Codex What To Do" },
      ],
      question: "Do you want to let me query npm for the `diver` package?",
      expiresAt: Date.now() + 900_000,
      requestParams: {
        questions: [
          {
            prompt: "Do you want to let me query npm for the `diver` package?",
            command: {
              text: "npm view diver name version description",
              cwd: "/Users/huntharo/github/openclaw",
            },
          },
        ],
      },
    });

    expect(text).toContain("Do you want to let me query npm for the `diver` package?");
    expect(text).toContain("```sh\nnpm view diver name version description\n```");
    expect(text).toContain("Cwd: /Users/huntharo/github/openclaw");
    expect(text).toContain("1. Yes");
    expect(text).toContain("2. Yes, and don't ask again for commands that start with npm view");
    expect(text).toContain("3. No");
  });
});

describe("turn steer methods", () => {
  it("uses only the documented turn/steer rpc method", () => {
    expect(__testing.turnSteerMethods).toEqual(["turn/steer"]);
  });
});

describe("turn interrupt methods", () => {
  it("uses only the documented turn/interrupt rpc method", () => {
    expect(__testing.turnInterruptMethods).toEqual(["turn/interrupt"]);
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

describe("plan notifications", () => {
  it("extracts structured plan updates from turn/plan/updated", () => {
    expect(
      __testing.extractTurnPlanUpdate({
        plan: {
          explanation: "Break the work into safe increments.",
          steps: [
            { step: "Capture the current behavior", status: "completed" },
            { step: "Patch Telegram delivery", status: "inProgress" },
            { step: "Verify with tests", status: "pending" },
          ],
        },
      }),
    ).toEqual({
      explanation: "Break the work into safe increments.",
      steps: [
        { step: "Capture the current behavior", status: "completed" },
        { step: "Patch Telegram delivery", status: "inProgress" },
        { step: "Verify with tests", status: "pending" },
      ],
    });
  });

  it("extracts plan delta text without treating it as assistant prose", () => {
    expect(
      __testing.extractPlanDeltaNotification({
        item: {
          id: "plan-item-1",
          type: "plan",
          delta: "## Plan\n- add the handler",
        },
      }),
    ).toEqual({
      itemId: "plan-item-1",
      delta: "## Plan\n- add the handler",
    });
    expect(
      __testing.extractAssistantNotificationText("item/plan/delta", {
        item: {
          id: "plan-item-1",
          type: "plan",
          delta: "## Plan\n- add the handler",
        },
      }),
    ).toEqual({
      mode: "ignore",
      text: "",
    });
  });

  it("extracts the final markdown plan from completed plan items", () => {
    expect(
      __testing.extractCompletedPlanText({
        item: {
          id: "plan-item-2",
          type: "plan",
          text: "# /codex_stop Plan\n\nImplement the handler.",
        },
      }),
    ).toEqual({
      itemId: "plan-item-2",
      text: "# /codex_stop Plan\n\nImplement the handler.",
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
