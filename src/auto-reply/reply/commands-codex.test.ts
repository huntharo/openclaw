import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCodexBoundSessionKey } from "../../agents/codex-app-server-bindings.js";
import {
  clearActiveCodexAppServerRun,
  setActiveCodexAppServerRun,
} from "../../agents/codex-app-server-runs.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, updateSessionStore } from "../../config/sessions.js";
import { resolvePreferredOpenClawTmpDir } from "../../infra/tmp-openclaw-dir.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const discoverCodexAppServerThreadsMock = vi.hoisted(() => vi.fn());
const readCodexAppServerThreadContextMock = vi.hoisted(() => vi.fn());
const readCodexAppServerThreadStateMock = vi.hoisted(() => vi.fn());
const readCodexAppServerAccountMock = vi.hoisted(() => vi.fn());
const readCodexAppServerExperimentalFeaturesMock = vi.hoisted(() => vi.fn());
const readCodexAppServerMcpServersMock = vi.hoisted(() => vi.fn());
const readCodexAppServerModelsMock = vi.hoisted(() => vi.fn());
const readCodexAppServerRateLimitsMock = vi.hoisted(() => vi.fn());
const readCodexAppServerSkillsMock = vi.hoisted(() => vi.fn());
const setCodexAppServerThreadNameMock = vi.hoisted(() => vi.fn());
const setCodexAppServerThreadServiceTierMock = vi.hoisted(() => vi.fn());
const startCodexAppServerThreadCompactionMock = vi.hoisted(() => vi.fn());
const startCodexAppServerReviewMock = vi.hoisted(() => vi.fn());
const runCodexAppServerAgentMock = vi.hoisted(() => vi.fn());
const getCodexAppServerRuntimeStatusMock = vi.hoisted(() => vi.fn(() => ({ state: "unknown" })));
const getCodexAppServerAvailabilityErrorMock = vi.hoisted(() =>
  vi.fn<() => string | null>(() => null),
);
const routeReplyMock = vi.hoisted(() => vi.fn());
const sendChatActionMock = vi.hoisted(() => vi.fn(async () => undefined));
const resolveTelegramAccountMock = vi.hoisted(() => vi.fn());
const createTelegramSendChatActionHandlerMock = vi.hoisted(() => vi.fn());
const runCommandWithTimeoutMock = vi.hoisted(() => vi.fn());
const sessionBindingServiceMock = vi.hoisted(() => ({
  bind: vi.fn(),
  getCapabilities: vi.fn(),
  listBySession: vi.fn(),
  resolveByConversation: vi.fn(),
  touch: vi.fn(),
  unbind: vi.fn(),
}));

vi.mock("../../agents/codex-app-server-runner.js", () => ({
  discoverCodexAppServerThreads: (...args: unknown[]) => discoverCodexAppServerThreadsMock(...args),
  isCodexAppServerProvider: (provider: string) => provider === "codex-app-server",
  startCodexAppServerThreadCompaction: (...args: unknown[]) =>
    startCodexAppServerThreadCompactionMock(...args),
  readCodexAppServerThreadContext: (...args: unknown[]) =>
    readCodexAppServerThreadContextMock(...args),
  readCodexAppServerThreadState: (...args: unknown[]) => readCodexAppServerThreadStateMock(...args),
  readCodexAppServerAccount: (...args: unknown[]) => readCodexAppServerAccountMock(...args),
  readCodexAppServerExperimentalFeatures: (...args: unknown[]) =>
    readCodexAppServerExperimentalFeaturesMock(...args),
  readCodexAppServerMcpServers: (...args: unknown[]) => readCodexAppServerMcpServersMock(...args),
  readCodexAppServerModels: (...args: unknown[]) => readCodexAppServerModelsMock(...args),
  readCodexAppServerRateLimits: (...args: unknown[]) => readCodexAppServerRateLimitsMock(...args),
  readCodexAppServerSkills: (...args: unknown[]) => readCodexAppServerSkillsMock(...args),
  setCodexAppServerThreadName: (...args: unknown[]) => setCodexAppServerThreadNameMock(...args),
  setCodexAppServerThreadServiceTier: (...args: unknown[]) =>
    setCodexAppServerThreadServiceTierMock(...args),
  startCodexAppServerReview: (...args: unknown[]) => startCodexAppServerReviewMock(...args),
  runCodexAppServerAgent: (...args: unknown[]) => runCodexAppServerAgentMock(...args),
}));

vi.mock("../../agents/codex-app-server-startup.js", () => ({
  getCodexAppServerAvailabilityError: () => getCodexAppServerAvailabilityErrorMock(),
  getCodexAppServerRuntimeStatus: () => getCodexAppServerRuntimeStatusMock(),
}));

vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => sessionBindingServiceMock,
}));

vi.mock("../../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) => Boolean(channel && channel !== "webchat"),
  routeReply: (...args: unknown[]) => routeReplyMock(...args),
}));

vi.mock("../../telegram/accounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../telegram/accounts.js")>();
  return {
    ...actual,
    resolveTelegramAccount: (...args: unknown[]) => resolveTelegramAccountMock(...args),
  };
});

vi.mock("../../telegram/sendchataction-401-backoff.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../telegram/sendchataction-401-backoff.js")>();
  return {
    ...actual,
    createTelegramSendChatActionHandler: (...args: unknown[]) =>
      createTelegramSendChatActionHandlerMock(...args),
  };
});

const { handleCodexCommand } = await import("./commands-codex.js");

describe("handleCodexCommand", () => {
  let tempDir = "";
  let storePath = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-command-"));
    storePath = path.join(tempDir, "sessions.json");
    discoverCodexAppServerThreadsMock.mockReset().mockResolvedValue([]);
    readCodexAppServerThreadContextMock.mockReset().mockResolvedValue({});
    readCodexAppServerThreadStateMock.mockReset().mockResolvedValue({
      threadId: "thread-123",
      threadName: "Plan TASKS doc refresh",
      model: "gpt-5.4",
      modelProvider: "openai",
      serviceTier: undefined,
      cwd: "/repo/openclaw",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      reasoningEffort: "high",
    });
    readCodexAppServerAccountMock.mockReset().mockResolvedValue({
      type: "chatgpt",
      email: "user@example.com",
      planType: "pro",
      requiresOpenaiAuth: true,
    });
    readCodexAppServerExperimentalFeaturesMock.mockReset().mockResolvedValue([]);
    readCodexAppServerMcpServersMock.mockReset().mockResolvedValue([]);
    readCodexAppServerModelsMock.mockReset().mockResolvedValue([]);
    readCodexAppServerRateLimitsMock.mockReset().mockResolvedValue([
      {
        name: "5h limit",
        usedPercent: 4,
        remaining: 96,
        resetAt: Date.now() + 3_600_000,
      },
    ]);
    readCodexAppServerSkillsMock.mockReset().mockResolvedValue([]);
    setCodexAppServerThreadNameMock.mockReset().mockResolvedValue(undefined);
    setCodexAppServerThreadServiceTierMock.mockReset().mockResolvedValue({
      threadId: "thread-123",
      serviceTier: "fast",
      cwd: "/repo/openclaw",
    });
    startCodexAppServerThreadCompactionMock.mockReset().mockResolvedValue(undefined);
    startCodexAppServerReviewMock.mockReset().mockResolvedValue({
      reviewText:
        "Looks solid overall.\n\nFull review comments:\n\n- [P1] Prefer Stylize helpers — /tmp/file.rs:10-20\n  Use .dim()/.bold() chaining instead of manual Style.\n\n- [P2] Keep helper names consistent — /tmp/file.rs:30-35\n  Rename the helper to match the surrounding naming pattern.",
      reviewThreadId: "thread-123",
      turnId: "turn-123",
    });
    runCodexAppServerAgentMock.mockReset().mockResolvedValue({
      payloads: [{ text: "Codex reply" }],
      meta: {
        agentMeta: {
          sessionId: "thread-123",
        },
      },
    });
    getCodexAppServerAvailabilityErrorMock.mockReset().mockReturnValue(null);
    getCodexAppServerRuntimeStatusMock.mockReset().mockReturnValue({ state: "unknown" });
    routeReplyMock.mockReset().mockResolvedValue({ ok: true, messageId: "m-1" });
    sendChatActionMock.mockReset().mockResolvedValue(undefined);
    resolveTelegramAccountMock.mockReset().mockReturnValue({
      accountId: "default",
      enabled: true,
      token: "telegram-token",
    });
    createTelegramSendChatActionHandlerMock.mockReset().mockReturnValue({
      sendChatAction: sendChatActionMock,
      reset: vi.fn(),
    });
    runCommandWithTimeoutMock.mockReset().mockResolvedValue({
      code: 0,
      stdout: "/repo/openclaw/.git\n",
      stderr: "",
      signal: null,
      timedOut: false,
    });
    sessionBindingServiceMock.bind.mockReset().mockImplementation(async (input: unknown) => {
      const record = input as {
        targetSessionKey: string;
        targetKind: string;
        conversation: Record<string, unknown>;
        metadata?: Record<string, unknown>;
      };
      return {
        bindingId: "binding-1",
        targetSessionKey: record.targetSessionKey,
        targetKind: record.targetKind,
        conversation: record.conversation,
        status: "active",
        boundAt: Date.now(),
        metadata: record.metadata,
      };
    });
    sessionBindingServiceMock.getCapabilities.mockReset().mockReturnValue({
      adapterAvailable: true,
      bindSupported: true,
      unbindSupported: true,
      placements: ["current"],
    });
    sessionBindingServiceMock.listBySession.mockReset().mockReturnValue([]);
    sessionBindingServiceMock.resolveByConversation.mockReset().mockReturnValue(null);
    sessionBindingServiceMock.touch.mockReset();
    sessionBindingServiceMock.unbind.mockReset().mockResolvedValue([]);
  });

  afterEach(async () => {
    vi.useRealTimers();
    clearActiveCodexAppServerRun("session-stop", stopHandle, "stop-session-key");
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  const stopHandle = {
    queueMessage: vi.fn().mockResolvedValue(true),
    submitPendingInput: vi.fn().mockResolvedValue(true),
    interrupt: vi.fn().mockResolvedValue(undefined),
    isStreaming: () => true,
    isAwaitingInput: () => false,
  };

  function buildParams(
    commandBody: string,
    cfg: OpenClawConfig = {},
    ctxOverrides?: Record<string, unknown>,
  ) {
    const params = buildCommandTestParams(commandBody, cfg, {
      Surface: "telegram",
      Provider: "telegram",
      ...ctxOverrides,
    });
    params.storePath = storePath;
    params.sessionEntry = {
      sessionId: params.sessionKey,
      updatedAt: Date.now(),
    };
    return params;
  }

  it("binds a Telegram conversation to a dedicated Codex session for /codex new", async () => {
    const params = buildParams(
      "/codex new --cwd /repo/openclaw fix exec approvals",
      {},
      {
        Surface: "telegram",
        Provider: "telegram",
        OriginatingTo: "1234",
        To: "1234",
      },
    );
    const boundSessionKey = buildCodexBoundSessionKey({
      channel: "telegram",
      accountId: "default",
      conversationId: "1234",
      agentId: "main",
    });

    const result = await handleCodexCommand(params, true);

    expect(result?.reply?.text).toContain("Send the next message to start the thread");
    expect(sessionBindingServiceMock.bind).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionKey: boundSessionKey,
        targetKind: "session",
        conversation: expect.objectContaining({
          channel: "telegram",
          accountId: "default",
          conversationId: "1234",
        }),
      }),
    );
    const store = loadSessionStore(storePath);
    expect(store[boundSessionKey]?.providerOverride).toBe("codex-app-server");
    expect(store[boundSessionKey]?.codexProjectKey).toBe("/repo/openclaw");
    expect(store[boundSessionKey]?.codexAutoRoute).toBe(true);
  });

  it("detaches locally without deleting the remembered thread", async () => {
    const boundSessionKey = buildCodexBoundSessionKey({
      channel: "telegram",
      accountId: "default",
      conversationId: "1234",
      agentId: "main",
    });
    const params = buildParams(
      "/codex detach",
      {},
      {
        Surface: "telegram",
        Provider: "telegram",
        OriginatingTo: "1234",
        To: "1234",
      },
    );
    params.sessionKey = boundSessionKey;
    await updateSessionStore(storePath, (store) => {
      store[boundSessionKey] = {
        sessionId: boundSessionKey,
        updatedAt: Date.now(),
        providerOverride: "codex-app-server",
        codexThreadId: "thread-123",
        codexProjectKey: "/repo/openclaw",
        codexAutoRoute: true,
      };
    });
    params.sessionEntry = loadSessionStore(storePath)[boundSessionKey];
    sessionBindingServiceMock.resolveByConversation.mockReturnValue({
      bindingId: "binding-1",
      targetSessionKey: boundSessionKey,
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "1234",
      },
    });

    const result = await handleCodexCommand(params, true);

    expect(result?.reply?.text).toContain("remote thread was left intact");
    expect(sessionBindingServiceMock.unbind).toHaveBeenCalledWith({
      bindingId: "binding-1",
      reason: "codex-detach",
    });
    const store = loadSessionStore(storePath);
    expect(store[boundSessionKey]?.codexThreadId).toBe("thread-123");
    expect(store[boundSessionKey]?.providerOverride).toBeUndefined();
    expect(store[boundSessionKey]?.codexAutoRoute).toBe(false);
  });

  it("continues immediately when /codex new runs inside an already bound Codex session", async () => {
    const boundSessionKey = buildCodexBoundSessionKey({
      channel: "telegram",
      accountId: "default",
      conversationId: "1234",
      agentId: "main",
    });
    const params = buildParams(
      "/codex new fix exec approvals",
      {},
      {
        Surface: "telegram",
        Provider: "telegram",
        OriginatingTo: "1234",
        To: "1234",
      },
    );
    params.sessionKey = boundSessionKey;
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };
    sessionBindingServiceMock.resolveByConversation.mockReturnValue({
      bindingId: "binding-1",
      targetSessionKey: boundSessionKey,
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "1234",
      },
    });

    const result = await handleCodexCommand(params, true);

    expect(result).toEqual({ shouldContinue: true });
    expect(params.ctx.BodyForAgent).toBe("fix exec approvals");
  });

  it("joins the best matching thread and stores the binding", async () => {
    discoverCodexAppServerThreadsMock.mockResolvedValue([
      {
        threadId: "thread-456",
        title: "Fix exec approvals",
        projectKey: "/repo/openclaw",
        updatedAt: Date.now(),
      },
    ]);
    readCodexAppServerThreadContextMock.mockResolvedValue({
      lastUserMessage: "Please fix exec approvals safely.",
      lastAssistantMessage: "I updated the plan and I am ready for the next change.",
    });
    const params = buildParams(
      "/codex join exec approvals",
      {},
      {
        Surface: "telegram",
        Provider: "telegram",
        OriginatingTo: "1234",
        To: "1234",
      },
    );
    const boundSessionKey = buildCodexBoundSessionKey({
      channel: "telegram",
      accountId: "default",
      conversationId: "1234",
      agentId: "main",
    });

    const result = await handleCodexCommand(params, true);

    expect(discoverCodexAppServerThreadsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        workspaceDir: undefined,
        filter: "exec approvals",
      }),
    );
    expect(readCodexAppServerThreadContextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: boundSessionKey,
        workspaceDir: "/repo/openclaw",
        threadId: "thread-456",
      }),
    );
    expect(result).toEqual({ shouldContinue: false });
    expect(routeReplyMock).toHaveBeenCalledTimes(5);
    expect(routeReplyMock.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        text: "Codex thread bound.\n\nThread: thread-456\nTitle: Fix exec approvals\nProject: /repo/openclaw",
      },
    });
    expect(routeReplyMock.mock.calls[1]?.[0]).toMatchObject({
      payload: { text: "Last User Request in Thread:" },
    });
    expect(routeReplyMock.mock.calls[2]?.[0]).toMatchObject({
      payload: { text: "Please fix exec approvals safely." },
    });
    expect(routeReplyMock.mock.calls[3]?.[0]).toMatchObject({
      payload: { text: "Last Agent Reply in Thread:" },
    });
    expect(routeReplyMock.mock.calls[4]?.[0]).toMatchObject({
      payload: { text: "I updated the plan and I am ready for the next change." },
    });
    const store = loadSessionStore(storePath);
    expect(store[boundSessionKey]?.codexThreadId).toBe("thread-456");
    expect(store[boundSessionKey]?.providerOverride).toBe("codex-app-server");
  });

  it("allows joining an exact thread id from another workspace", async () => {
    discoverCodexAppServerThreadsMock.mockResolvedValue([
      {
        threadId: "019c68d3-d622-75c0-a542-198753af0b2c",
        title: "Plan TASKS doc refresh",
        projectKey: "/Users/huntharo/github/jeerreview",
        updatedAt: Date.now(),
      },
    ]);
    const params = buildParams(
      "/codex join 019c68d3-d622-75c0-a542-198753af0b2c",
      {},
      {
        Surface: "telegram",
        Provider: "telegram",
        OriginatingTo: "1234",
        To: "1234",
      },
    );

    await handleCodexCommand(params, true);

    expect(discoverCodexAppServerThreadsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        workspaceDir: undefined,
        filter: "019c68d3-d622-75c0-a542-198753af0b2c",
      }),
    );
    expect(routeReplyMock.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        text: "Codex thread bound.\n\nThread: 019c68d3-d622-75c0-a542-198753af0b2c\nTitle: Plan TASKS doc refresh\nProject: /Users/huntharo/github/jeerreview",
      },
    });
  });

  it("does not force the current workspace when /codex list has a filter", async () => {
    discoverCodexAppServerThreadsMock.mockResolvedValue([
      {
        threadId: "thread-789",
        title: "OpenClaw approvals",
        projectKey: "/repo/openclaw",
      },
    ]);
    const params = buildParams("/codex list openclaw");

    const result = await handleCodexCommand(params, true);

    expect(discoverCodexAppServerThreadsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: params.sessionKey,
        workspaceDir: undefined,
        filter: "openclaw",
      }),
    );
    expect(result?.reply?.text).toContain("thread-789");
  });

  it("adds Telegram join buttons to /codex list results", async () => {
    discoverCodexAppServerThreadsMock.mockResolvedValue([
      {
        threadId: "019cc38a-0128-7203-9e94-7e97610cdba6",
        title: "App Server Redux 5.4",
        projectKey: "/repo/openclaw",
      },
      {
        threadId: "019cc00d-6cf4-7c11-afcd-2673db349a21",
        title: "Fix Telegram approval flow",
        projectKey: "/repo/openclaw",
      },
    ]);
    const params = buildParams(
      "/codex list",
      {},
      {
        Surface: "telegram",
        Provider: "telegram",
        OriginatingTo: "1234",
        To: "1234",
      },
    );

    const result = await handleCodexCommand(params, true);

    expect(discoverCodexAppServerThreadsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: params.sessionKey,
        workspaceDir: undefined,
        filter: undefined,
      }),
    );
    expect(result?.reply?.text).toContain("Recent Codex threads:");
    expect(result?.reply?.channelData).toEqual({
      telegram: {
        buttons: [
          [
            {
              text: "Join: App Server Redux 5.4",
              callback_data: "/codex join 019cc38a-0128-7203-9e94-7e97610cdba6",
            },
          ],
          [
            {
              text: "Join: Fix Telegram approval flow",
              callback_data: "/codex join 019cc00d-6cf4-7c11-afcd-2673db349a21",
            },
          ],
        ],
      },
    });
  });

  it("uses current workspace when /codex list --cwd is provided without a path", async () => {
    discoverCodexAppServerThreadsMock.mockResolvedValue([
      {
        threadId: "thread-123",
        title: "Workspace scoped",
        projectKey: "/repo/openclaw",
      },
    ]);
    const params = buildParams("/codex list --cwd");

    await handleCodexCommand(params, true);

    expect(discoverCodexAppServerThreadsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        filter: undefined,
      }),
    );
  });

  it("supports em-dash uppercase --CWD without a path", async () => {
    discoverCodexAppServerThreadsMock.mockResolvedValue([
      {
        threadId: "thread-123",
        title: "Workspace scoped",
        projectKey: "/repo/openclaw",
      },
    ]);
    const params = buildParams("/codex list \u2014CWD");

    await handleCodexCommand(params, true);

    expect(discoverCodexAppServerThreadsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        filter: undefined,
      }),
    );
  });

  it("supports explicit /codex list -C <path> with a filter", async () => {
    discoverCodexAppServerThreadsMock.mockResolvedValue([
      {
        threadId: "thread-123",
        title: "OpenClaw scoped",
        projectKey: "/Users/huntharo/github/openclaw",
      },
    ]);
    const params = buildParams("/codex list -C /Users/huntharo/github/openclaw approvals");

    await handleCodexCommand(params, true);

    expect(discoverCodexAppServerThreadsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: params.sessionKey,
        workspaceDir: "/Users/huntharo/github/openclaw",
        filter: "approvals",
      }),
    );
  });

  it("includes runtime state in /codex status output", async () => {
    getCodexAppServerRuntimeStatusMock.mockReturnValue({ state: "ready" });
    const params = buildParams("/codex status");

    const result = await handleCodexCommand(params, true);

    expect(result?.reply?.text).toContain("Runtime: ready");
  });

  it("replays pending Codex input on /codex join", async () => {
    discoverCodexAppServerThreadsMock.mockResolvedValue([
      {
        threadId: "thread-456",
        title: "Fix exec approvals",
        projectKey: "/repo/openclaw",
        updatedAt: Date.now(),
      },
    ]);
    readCodexAppServerThreadContextMock.mockResolvedValue({
      lastUserMessage: "Can you approve the deploy?",
      lastAssistantMessage: "I am waiting for approval.",
    });
    const params = buildParams(
      "/codex join exec approvals",
      {},
      {
        Surface: "telegram",
        Provider: "telegram",
        OriginatingTo: "1234",
        To: "1234",
      },
    );
    const boundSessionKey = buildCodexBoundSessionKey({
      channel: "telegram",
      accountId: "default",
      conversationId: "1234",
      agentId: "main",
    });
    await updateSessionStore(storePath, (store) => {
      store[boundSessionKey] = {
        sessionId: "session-1",
        updatedAt: Date.now(),
        providerOverride: "codex-app-server",
        pendingUserInputRequestId: "req-123",
        pendingUserInputOptions: ["Approve", "Decline"],
        pendingUserInputActions: [
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
        ],
        pendingUserInputExpiresAt: Date.now() + 60_000,
        pendingUserInputPromptText: "Approve deploy?",
        pendingUserInputMethod: "server/requestApproval",
      };
    });

    const result = await handleCodexCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
    expect(routeReplyMock.mock.calls.at(-1)?.[0]).toMatchObject({
      payload: {
        text: expect.stringContaining("Pending Codex input:"),
        channelData: {
          telegram: {
            buttons: [
              [
                { text: "Approve Once", callback_data: expect.stringMatching(/^cdxui:/) },
                { text: "Decline", callback_data: expect.stringMatching(/^cdxui:/) },
              ],
              [{ text: "Tell Codex What To Do", callback_data: expect.stringMatching(/^cdxui:/) }],
            ],
          },
        },
      },
    });
  });

  it("pins the binding notice in Telegram topics like ACP bindings", async () => {
    discoverCodexAppServerThreadsMock.mockResolvedValue([
      {
        threadId: "thread-456",
        title: "Fix exec approvals",
        projectKey: "/repo/openclaw",
        updatedAt: Date.now(),
      },
    ]);
    const params = buildParams(
      "/codex join exec approvals",
      {},
      {
        Surface: "telegram",
        Provider: "telegram",
        OriginatingTo: "group:123:topic:77",
        To: "group:123:topic:77",
        MessageThreadId: "77",
      },
    );

    await handleCodexCommand(params, true);

    expect(routeReplyMock.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        channelData: { telegram: { pin: true } },
      },
    });
  });

  it("does not include older thread history in the routed join replay", async () => {
    discoverCodexAppServerThreadsMock.mockResolvedValue([
      {
        threadId: "thread-456",
        title: "Fix exec approvals",
        projectKey: "/repo/openclaw",
        updatedAt: Date.now(),
      },
    ]);
    readCodexAppServerThreadContextMock.mockResolvedValue({
      lastUserMessage: "Newest request",
      lastAssistantMessage: "Newest response",
    });
    const params = buildParams(
      "/codex join exec approvals",
      {},
      {
        Surface: "telegram",
        Provider: "telegram",
        OriginatingTo: "1234",
        To: "1234",
      },
    );

    await handleCodexCommand(params, true);

    const routedTexts = routeReplyMock.mock.calls
      .map((call) => (call[0] as { payload?: { text?: string } })?.payload?.text)
      .filter(Boolean)
      .join("\n");
    expect(routedTexts).toContain("Newest request");
    expect(routedTexts).toContain("Newest response");
    expect(routedTexts).not.toContain("Older message 1");
  });

  it("shows pending Codex input details and buttons in /codex status", async () => {
    getCodexAppServerRuntimeStatusMock.mockReturnValue({ state: "ready" });
    const params = buildParams(
      "/codex status",
      {},
      {
        Surface: "telegram",
        Provider: "telegram",
        OriginatingTo: "1234",
        To: "1234",
      },
    );
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
      pendingUserInputRequestId: "req-123",
      pendingUserInputOptions: ["Approve", "Decline"],
      pendingUserInputActions: [
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
      ],
      pendingUserInputExpiresAt: Date.now() + 60_000,
      pendingUserInputPromptText: "Approve deploy?",
      pendingUserInputMethod: "server/requestApproval",
    };

    const result = await handleCodexCommand(params, true);

    expect(result?.reply?.text).toContain("Pending input: req-123");
    expect(result?.reply?.text).toContain("Approve deploy?");
    expect(result?.reply?.text).toContain("Mirrored commands: built-in=14 discovered=0");
    expect(
      (result?.reply?.channelData as { telegram?: { buttons?: unknown[][] } } | undefined)?.telegram
        ?.buttons,
    ).toEqual([
      [
        { text: "Approve Once", callback_data: expect.stringMatching(/^cdxui:/) },
        { text: "Decline", callback_data: expect.stringMatching(/^cdxui:/) },
      ],
      [{ text: "Tell Codex What To Do", callback_data: expect.stringMatching(/^cdxui:/) }],
    ]);
  });

  it("runs /codex_plan as a plan-mode Codex turn and delivers the final plan card", async () => {
    const params = buildParams(
      "/codex_plan break this into phases",
      {},
      {
        Surface: "telegram",
        Provider: "telegram",
        OriginatingTo: "1234",
        To: "1234",
      },
    );
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };
    runCodexAppServerAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Fallback assistant summary" }],
      meta: {
        agentMeta: {
          sessionId: "thread-123",
        },
        codexPlanArtifact: {
          explanation: "Break the work into safe increments.",
          steps: [
            { step: "Capture the current behavior", status: "completed" },
            { step: "Patch Telegram delivery", status: "inProgress" },
            { step: "Verify with tests", status: "pending" },
          ],
          markdown: "# Plan\n\n- Patch the command\n- Verify the callback flow",
        },
      },
    });

    const result = await handleCodexCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          text: "Starting Codex plan mode. I’ll relay the questions and final plan as they arrive.",
        },
      }),
    );
    expect(sendChatActionMock).toHaveBeenCalledWith("1234", "typing", undefined);
    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          text: expect.stringContaining("Break the work into safe increments."),
        }),
      }),
    );
    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          text: "Implement this plan?",
          channelData: {
            telegram: {
              buttons: [
                [
                  {
                    text: "Yes, implement this plan",
                    callback_data: expect.stringMatching(/^cdxpl:y:/),
                  },
                ],
                [
                  {
                    text: "No, stay in Plan mode",
                    callback_data: expect.stringMatching(/^cdxpl:n:/),
                  },
                ],
              ],
            },
          },
        },
      }),
    );
    expect(
      routeReplyMock.mock.calls.some(
        (call) => call[0]?.payload?.text === "Fallback assistant summary",
      ),
    ).toBe(false);
    expect(runCodexAppServerAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "break this into phases",
        existingThreadId: "thread-123",
        workspaceDir: "/repo/openclaw",
        collaborationMode: expect.objectContaining({
          mode: "plan",
          settings: expect.objectContaining({
            model: "gpt-5.4",
            reasoningEffort: "high",
            developerInstructions: null,
          }),
        }),
      }),
    );
    expect(runCodexAppServerAgentMock.mock.calls[0]?.[0]).not.toHaveProperty("timeoutMs");
    const store = loadSessionStore(storePath);
    expect(store[params.sessionKey]?.codexPlanPromptRequestId).toBeTruthy();
  });

  it("delivers large /codex_plan results as a markdown attachment plus a separate prompt", async () => {
    const params = buildParams(
      "/codex_plan write the full rollout document",
      {},
      {
        Surface: "telegram",
        Provider: "telegram",
        OriginatingTo: "1234",
        To: "1234",
      },
    );
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };
    runCodexAppServerAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Fallback assistant summary" }],
      meta: {
        agentMeta: {
          sessionId: "thread-123",
        },
        codexPlanArtifact: {
          explanation: "This needs the full rollout guide attached.",
          steps: [{ step: "Write the rollout", status: "inProgress" }],
          markdown: `# Plan\n\n${"Long section.\n".repeat(500)}`,
        },
      },
    });

    const result = await handleCodexCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
    const mediaPayload = routeReplyMock.mock.calls
      .map((call) => call[0]?.payload)
      .find((payload) => typeof payload?.mediaUrl === "string");
    expect(mediaPayload?.mediaUrl).toMatch(/codex-plan-.*\.md$/);
    expect(String(mediaPayload?.mediaUrl).startsWith(resolvePreferredOpenClawTmpDir())).toBe(true);
    const attachmentBody = await fs.readFile(String(mediaPayload?.mediaUrl), "utf8");
    expect(attachmentBody).toContain("# Plan");
    expect(routeReplyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: {
          text: "Implement this plan?",
          channelData: {
            telegram: {
              buttons: expect.any(Array),
            },
          },
        },
      }),
    );
  });

  it("falls back to an inline summary when large /codex_plan attachment delivery fails", async () => {
    const params = buildParams(
      "/codex_plan write the full rollout document",
      {},
      {
        Surface: "telegram",
        Provider: "telegram",
        OriginatingTo: "1234",
        To: "1234",
      },
    );
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };
    runCodexAppServerAgentMock.mockResolvedValueOnce({
      payloads: [{ text: "Fallback assistant summary" }],
      meta: {
        agentMeta: {
          sessionId: "thread-123",
        },
        codexPlanArtifact: {
          explanation: "This needs the full rollout guide attached.",
          steps: [{ step: "Write the rollout", status: "inProgress" }],
          markdown: `# Plan\n\n${"Long section.\n".repeat(500)}`,
        },
      },
    });
    routeReplyMock
      .mockResolvedValueOnce({ ok: true, messageId: "m-start" })
      .mockResolvedValueOnce({ ok: true, messageId: "m-summary" })
      .mockResolvedValueOnce({
        ok: false,
        error:
          "Failed to route reply to telegram: Local media path is not under an allowed directory",
      })
      .mockResolvedValueOnce({ ok: true, messageId: "m-fallback" })
      .mockResolvedValueOnce({ ok: true, messageId: "m-prompt" });

    const result = await handleCodexCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
    const sentTexts = routeReplyMock.mock.calls
      .map((call) => call[0]?.payload?.text)
      .filter((text): text is string => typeof text === "string");
    expect(sentTexts.filter((text) => text.startsWith("Plan ready.")).length).toBe(1);
    expect(
      sentTexts.some((text) =>
        text.includes(
          "I couldn't attach the full Markdown plan here, so here's a condensed inline summary instead.",
        ),
      ),
    ).toBe(true);
    expect(sentTexts.some((text) => text.includes("Implement this plan?"))).toBe(true);
  });

  it("routes /codex_review through review/start and sends finding actions", async () => {
    const params = buildParams(
      "/codex_review",
      {},
      {
        Surface: "telegram",
        Provider: "telegram",
        OriginatingTo: "1234",
        To: "1234",
      },
    );
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };

    const result = await handleCodexCommand(params, true);

    expect(result).toEqual({ shouldContinue: false });
    expect(startCodexAppServerReviewMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-123",
        workspaceDir: "/repo/openclaw",
        target: { type: "uncommittedChanges" },
      }),
    );
    expect(startCodexAppServerReviewMock.mock.calls[0]?.[0]).not.toHaveProperty("timeoutMs");
    expect(routeReplyMock).toHaveBeenCalledTimes(5);
    expect(routeReplyMock.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        text: "Starting Codex review of the current changes. I’ll send the findings when the review finishes.",
      },
    });
    expect(routeReplyMock.mock.calls[1]?.[0]).toMatchObject({
      payload: { text: "Looks solid overall." },
    });
    expect(routeReplyMock.mock.calls[2]?.[0]).toMatchObject({
      payload: {
        text: "P1\nPrefer Stylize helpers\nLocation: /tmp/file.rs:10-20\n\nUse .dim()/.bold() chaining instead of manual Style.",
      },
    });
    expect(routeReplyMock.mock.calls[3]?.[0]).toMatchObject({
      payload: {
        text: "P2\nKeep helper names consistent\nLocation: /tmp/file.rs:30-35\n\nRename the helper to match the surrounding naming pattern.",
      },
    });
    expect(routeReplyMock.mock.calls[4]?.[0]).toMatchObject({
      payload: {
        text: "Choose a review finding to implement, or implement them all.",
        channelData: {
          telegram: {
            buttons: [
              [
                {
                  text: "Implement P1",
                  callback_data: expect.stringMatching(/^cdxrv:/),
                },
              ],
              [
                {
                  text: "Implement P2",
                  callback_data: expect.stringMatching(/^cdxrv:/),
                },
              ],
              [
                {
                  text: "Implement All Fixes",
                  callback_data: expect.stringMatching(/^cdxrv:/),
                },
              ],
            ],
          },
        },
      },
    });
    const store = loadSessionStore(storePath);
    expect(store[params.sessionKey]?.codexReviewActions?.map((action) => action.label)).toEqual([
      "Implement P1",
      "Implement P2",
      "Implement All Fixes",
    ]);
    expect(store[params.sessionKey]?.codexReviewActionRequestId).toBeTruthy();
  });

  it("renames the bound Codex thread through thread/name/set", async () => {
    const params = buildParams("/codex_rename Better thread title");
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };

    const result = await handleCodexCommand(params, true);

    expect(result?.reply?.text).toBe("Renamed Codex thread to: Better thread title");
    expect(setCodexAppServerThreadNameMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-123",
        workspaceDir: "/repo/openclaw",
        name: "Better thread title",
      }),
    );
    expect(runCodexAppServerAgentMock).not.toHaveBeenCalled();
  });

  it("requires a name for /codex_rename", async () => {
    const params = buildParams("/codex_rename");
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };

    const result = await handleCodexCommand(params, true);

    expect(result?.reply?.text).toBe("Usage: /codex_rename [--sync] <new thread name>");
    expect(setCodexAppServerThreadNameMock).not.toHaveBeenCalled();
  });

  it("accepts Telegram smart-dash --sync for /codex_rename and requests topic rename", async () => {
    const params = buildParams("/codex_rename —sync Better topic name");
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };

    const result = await handleCodexCommand(params, true);

    expect(result?.reply?.text).toBe("Renamed Codex thread to: Better topic name");
    expect(result?.reply?.channelData).toEqual({
      telegram: { renameTopicTo: "Better topic name" },
    });
    expect(setCodexAppServerThreadNameMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Better topic name",
      }),
    );
  });

  it("starts Codex compaction through thread/compact/start", async () => {
    const params = buildParams("/codex_compact");
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };

    const result = await handleCodexCommand(params, true);

    expect(result?.reply?.text).toBe("Started Codex thread compaction.");
    expect(startCodexAppServerThreadCompactionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-123",
        workspaceDir: "/repo/openclaw",
      }),
    );
    expect(runCodexAppServerAgentMock).not.toHaveBeenCalled();
  });

  it("renders /codex_skills from App Server skill discovery", async () => {
    const params = buildParams("/codex_skills");
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };
    readCodexAppServerSkillsMock.mockResolvedValue([
      {
        cwd: "/repo/openclaw",
        name: "skill-creator",
        description: "Create or update a Codex skill",
        enabled: true,
      },
      {
        cwd: "/repo/openclaw",
        name: "legacy-helper",
        description: "Old helper",
        enabled: false,
      },
    ]);

    const result = await handleCodexCommand(params, true);

    expect(result?.reply?.text).toContain("Codex skills for /repo/openclaw:");
    expect(result?.reply?.text).toContain("skill-creator - Create or update a Codex skill");
    expect(result?.reply?.text).toContain("legacy-helper (disabled) - Old helper");
    expect(readCodexAppServerSkillsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceDir: "/repo/openclaw",
      }),
    );
    expect(runCodexAppServerAgentMock).not.toHaveBeenCalled();
  });

  it("renders /codex_experimental from App Server feature discovery", async () => {
    const params = buildParams("/codex_experimental");
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };
    readCodexAppServerExperimentalFeaturesMock.mockResolvedValue([
      {
        name: "fancy_feature",
        stage: "beta",
        displayName: "Fancy Feature",
        enabled: true,
        defaultEnabled: false,
      },
    ]);

    const result = await handleCodexCommand(params, true);

    expect(result?.reply?.text).toContain("Codex experimental features:");
    expect(result?.reply?.text).toContain(
      "fancy_feature · stage=beta · enabled · default-off - Fancy Feature",
    );
    expect(readCodexAppServerExperimentalFeaturesMock).toHaveBeenCalled();
    expect(runCodexAppServerAgentMock).not.toHaveBeenCalled();
  });

  it("renders /codex_mcp from App Server MCP server discovery", async () => {
    const params = buildParams("/codex_mcp");
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };
    readCodexAppServerMcpServersMock.mockResolvedValue([
      {
        name: "github",
        authStatus: "authenticated",
        toolCount: 12,
        resourceCount: 3,
        resourceTemplateCount: 1,
      },
    ]);

    const result = await handleCodexCommand(params, true);

    expect(result?.reply?.text).toContain("Codex MCP servers:");
    expect(result?.reply?.text).toContain(
      "github · auth=authenticated · tools=12 · resources=3 · templates=1",
    );
    expect(readCodexAppServerMcpServersMock).toHaveBeenCalled();
    expect(runCodexAppServerAgentMock).not.toHaveBeenCalled();
  });

  it("renders /codex_status locally from App Server state", async () => {
    const params = buildParams("/codex_status");
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };

    const result = await handleCodexCommand(params, true);

    expect(result?.reply?.text).toContain("OpenAI Codex");
    expect(result?.reply?.text).toContain("Thread: Plan TASKS doc refresh");
    expect(result?.reply?.text).toContain("Model: openai/gpt-5.4 · reasoning high");
    expect(result?.reply?.text).toContain("Project folder: /repo/openclaw");
    expect(result?.reply?.text).toContain("Worktree folder: /repo/openclaw");
    expect(result?.reply?.text).toContain("Fast mode: off");
    expect(result?.reply?.text).toContain("Permissions: Default");
    expect(result?.reply?.text).toContain("Account: user@example.com (pro)");
    expect(result?.reply?.text).toContain("Session: thread-123");
    expect(result?.reply?.text).toContain(
      `Rate limits timezone: ${new Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    );
    expect(result?.reply?.text).toContain("5h limit: 96% left");
    expect(runCommandWithTimeoutMock).toHaveBeenCalledWith(
      ["git", "-C", "/repo/openclaw", "rev-parse", "--path-format=absolute", "--git-common-dir"],
      expect.objectContaining({ cwd: "/repo/openclaw", timeoutMs: 5_000 }),
    );
    expect(runCodexAppServerAgentMock).not.toHaveBeenCalled();
    expect(readCodexAppServerThreadStateMock).toHaveBeenCalled();
    expect(readCodexAppServerAccountMock).toHaveBeenCalled();
    expect(readCodexAppServerRateLimitsMock).toHaveBeenCalled();
  });

  it("hides non-matching model-specific usage rows in /codex_status", async () => {
    const params = buildParams("/codex_status");
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };
    readCodexAppServerRateLimitsMock.mockResolvedValue([
      { name: "5h limit", usedPercent: 4 },
      { name: "Weekly limit", usedPercent: 17 },
      { name: "GPT-5.3-Codex-Spark 5h limit", usedPercent: 0 },
      { name: "GPT-5.3-Codex-Spark Weekly limit", usedPercent: 0 },
    ]);

    const result = await handleCodexCommand(params, true);
    const text = result?.reply?.text ?? "";

    expect(text).toContain("5h limit: 96% left");
    expect(text).toContain("Weekly limit: 83% left");
    expect(text).not.toContain("GPT-5.3-Codex-Spark 5h limit");
    expect(text).not.toContain("GPT-5.3-Codex-Spark Weekly limit");
  });

  it("groups model-specific usage rows after generic rows in /codex_status", async () => {
    const params = buildParams("/codex_status");
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };
    readCodexAppServerThreadStateMock.mockResolvedValueOnce({
      threadId: "thread-123",
      threadName: "Plan TASKS doc refresh",
      model: "gpt-5.3-codex-spark",
      modelProvider: "openai",
      serviceTier: undefined,
      cwd: "/repo/openclaw",
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      reasoningEffort: "high",
    });
    readCodexAppServerRateLimitsMock.mockResolvedValue([
      { name: "GPT-5.3-Codex-Spark Weekly limit", usedPercent: 0 },
      { name: "Weekly limit", usedPercent: 17 },
      { name: "GPT-5.3-Codex-Spark 5h limit", usedPercent: 0 },
      { name: "5h limit", usedPercent: 4 },
    ]);

    const result = await handleCodexCommand(params, true);
    const text = result?.reply?.text ?? "";
    const genericFiveHourIndex = text.indexOf("5h limit: 96% left");
    const genericWeeklyIndex = text.indexOf("Weekly limit: 83% left");
    const sparkFiveHourIndex = text.indexOf("GPT-5.3-Codex-Spark 5h limit: 100% left");
    const sparkWeeklyIndex = text.indexOf("GPT-5.3-Codex-Spark Weekly limit: 100% left");

    expect(genericFiveHourIndex).toBeGreaterThan(-1);
    expect(genericWeeklyIndex).toBeGreaterThan(genericFiveHourIndex);
    expect(sparkFiveHourIndex).toBeGreaterThan(genericWeeklyIndex);
    expect(sparkWeeklyIndex).toBeGreaterThan(sparkFiveHourIndex);
  });

  it("formats /codex_status reset windows in local time and rolls stale anchors forward", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-07T12:00:00-05:00"));

    const params = buildParams("/codex_status");
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };
    readCodexAppServerRateLimitsMock.mockResolvedValue([
      {
        name: "5h limit",
        usedPercent: 11,
        resetAt: new Date("2026-01-21T07:28:00-05:00").getTime(),
        windowSeconds: 18_000,
      },
      {
        name: "Weekly limit",
        usedPercent: 20,
        resetAt: new Date("2026-01-21T07:34:00-05:00").getTime(),
        windowSeconds: 604_800,
      },
    ]);

    const result = await handleCodexCommand(params, true);
    const text = result?.reply?.text ?? "";

    expect(text).toContain(
      `Rate limits timezone: ${new Intl.DateTimeFormat().resolvedOptions().timeZone}`,
    );
    expect(text).toContain("5h limit: 89% left (resets 12:28 PM)");
    expect(text).toContain("Weekly limit: 80% left (resets Mar 11)");
    expect(text).not.toContain("Jan 21");
  });

  it("summarizes models for /codex_model with no args", async () => {
    const params = buildParams("/codex_model");
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
      modelOverride: "gpt-5.3-codex",
    };
    readCodexAppServerModelsMock.mockResolvedValue([
      { id: "gpt-5.3-codex", current: true },
      { id: "gpt-5.2-codex" },
    ]);

    const result = await handleCodexCommand(params, true);

    expect(result?.reply?.text).toContain("Current model: gpt-5.3-codex");
    expect(result?.reply?.text).toContain("Available models:");
    expect(result?.reply?.text).toContain("gpt-5.2-codex");
  });

  it("routes /codex_model with args into Codex and stores the requested model", async () => {
    const params = buildParams("/codex_model gpt-5.2-codex");
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };

    const result = await handleCodexCommand(params, true);

    expect(result).toEqual({ shouldContinue: false, reply: { text: "Codex reply" } });
    expect(runCodexAppServerAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "/model gpt-5.2-codex",
        model: "gpt-5.2-codex",
      }),
    );
    expect(runCodexAppServerAgentMock.mock.calls[0]?.[0]).not.toHaveProperty("timeoutMs");
    expect(loadSessionStore(storePath)[params.sessionKey]?.modelOverride).toBe("gpt-5.2-codex");
  });

  it("toggles /codex_fast through structured serviceTier updates", async () => {
    const params = buildParams("/codex_fast");
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };

    const result = await handleCodexCommand(params, true);

    expect(result?.reply?.text).toBe("Fast mode set to on.");
    expect(setCodexAppServerThreadServiceTierMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "thread-123",
        serviceTier: "fast",
      }),
    );
    expect(runCodexAppServerAgentMock).not.toHaveBeenCalled();
    expect(loadSessionStore(storePath)[params.sessionKey]?.codexServiceTier).toBe("fast");
  });

  it("reports /codex_fast status without mutating thread state", async () => {
    const params = buildParams("/codex_fast status");
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };
    readCodexAppServerThreadStateMock.mockResolvedValueOnce({
      threadId: "thread-123",
      serviceTier: "fast",
      cwd: "/repo/openclaw",
    });

    const result = await handleCodexCommand(params, true);

    expect(result?.reply?.text).toBe("Fast mode is on.");
    expect(setCodexAppServerThreadServiceTierMock).not.toHaveBeenCalled();
  });

  it("stops the active bound Codex run through the session-key registry", async () => {
    const params = buildParams("/codex_stop");
    params.sessionKey = "stop-session-key";
    params.sessionEntry = {
      sessionId: "session-stop",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };
    stopHandle.interrupt.mockClear();
    setActiveCodexAppServerRun("session-stop", stopHandle, "stop-session-key");

    const result = await handleCodexCommand(params, true);

    expect(result?.reply?.text).toBe("Stopping Codex now.");
    await vi.waitFor(() => {
      expect(stopHandle.interrupt).toHaveBeenCalledTimes(1);
    });
    expect(runCodexAppServerAgentMock).not.toHaveBeenCalled();
  });

  it("reports when /codex_stop has no active Codex run to interrupt", async () => {
    const params = buildParams("/codex_stop");
    params.sessionEntry = {
      sessionId: "session-stop-idle",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };

    const result = await handleCodexCommand(params, true);

    expect(result?.reply?.text).toBe("No active Codex run to stop.");
    expect(runCodexAppServerAgentMock).not.toHaveBeenCalled();
  });

  it("strips the Telegram bot suffix before reading /codex_skills locally", async () => {
    const params = buildParams("/codex_skills@huntharo_bot");
    params.sessionEntry = {
      sessionId: "session-1",
      updatedAt: Date.now(),
      providerOverride: "codex-app-server",
      codexThreadId: "thread-123",
      codexProjectKey: "/repo/openclaw",
      codexAutoRoute: true,
    };
    readCodexAppServerSkillsMock.mockResolvedValue([
      {
        cwd: "/repo/openclaw",
        name: "skill-creator",
        description: "Create or update a Codex skill",
        enabled: true,
      },
    ]);

    const result = await handleCodexCommand(params, true);

    expect(result?.reply?.text).toContain("skill-creator - Create or update a Codex skill");
    expect(readCodexAppServerSkillsMock).toHaveBeenCalled();
    expect(runCodexAppServerAgentMock).not.toHaveBeenCalled();
  });

  it("fails fast when the Codex runtime startup gate is unavailable", async () => {
    getCodexAppServerAvailabilityErrorMock.mockReturnValue(
      "Codex App Server runtime is unavailable: spawn ENOENT",
    );
    const params = buildParams("/codex list");

    const result = await handleCodexCommand(params, true);

    expect(discoverCodexAppServerThreadsMock).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain("spawn ENOENT");
  });

  it("resolves /codex status through an existing bound conversation session", async () => {
    const boundSessionKey = buildCodexBoundSessionKey({
      channel: "telegram",
      accountId: "default",
      conversationId: "-1003841603622:topic:674",
      agentId: "main",
    });
    await updateSessionStore(storePath, (store) => {
      store[boundSessionKey] = {
        sessionId: boundSessionKey,
        updatedAt: Date.now(),
        providerOverride: "codex-app-server",
        codexThreadId: "019c68d3-d622-75c0-a542-198753af0b2c",
        codexProjectKey: "/Users/huntharo/github/jeerreview",
        codexAutoRoute: true,
      };
    });
    sessionBindingServiceMock.resolveByConversation.mockReturnValue({
      bindingId: "binding-topic-674",
      targetSessionKey: boundSessionKey,
      conversation: {
        channel: "telegram",
        accountId: "default",
        conversationId: "-1003841603622:topic:674",
      },
    });
    getCodexAppServerRuntimeStatusMock.mockReturnValue({ state: "ready" });
    const params = buildParams(
      "/codex status",
      {},
      {
        Surface: "telegram",
        Provider: "telegram",
        OriginatingTo: "telegram:-1003841603622",
        To: "telegram:-1003841603622",
        MessageThreadId: 674,
      },
    );

    const result = await handleCodexCommand(params, true);

    expect(result?.reply?.text).toContain("Codex binding active.");
    expect(result?.reply?.text).toContain("019c68d3-d622-75c0-a542-198753af0b2c");
    expect(result?.reply?.text).toContain("/Users/huntharo/github/jeerreview");
    expect(sessionBindingServiceMock.touch).toHaveBeenCalledWith("binding-topic-674");
  });
});
