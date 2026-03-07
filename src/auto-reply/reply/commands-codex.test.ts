import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCodexBoundSessionKey } from "../../agents/codex-app-server-bindings.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, updateSessionStore } from "../../config/sessions.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const discoverCodexAppServerThreadsMock = vi.hoisted(() => vi.fn());
const readCodexAppServerThreadContextMock = vi.hoisted(() => vi.fn());
const getCodexAppServerRuntimeStatusMock = vi.hoisted(() => vi.fn(() => ({ state: "unknown" })));
const getCodexAppServerAvailabilityErrorMock = vi.hoisted(() =>
  vi.fn<() => string | null>(() => null),
);
const routeReplyMock = vi.hoisted(() => vi.fn());
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
  readCodexAppServerThreadContext: (...args: unknown[]) =>
    readCodexAppServerThreadContextMock(...args),
}));

vi.mock("../../agents/codex-app-server-startup.js", () => ({
  getCodexAppServerAvailabilityError: () => getCodexAppServerAvailabilityErrorMock(),
  getCodexAppServerRuntimeStatus: () => getCodexAppServerRuntimeStatusMock(),
}));

vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => sessionBindingServiceMock,
}));

vi.mock("./route-reply.js", () => ({
  isRoutableChannel: (channel: string | undefined) => Boolean(channel && channel !== "webchat"),
  routeReply: (...args: unknown[]) => routeReplyMock(...args),
}));

const { handleCodexCommand } = await import("./commands-codex.js");

describe("handleCodexCommand", () => {
  let tempDir = "";
  let storePath = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-command-"));
    storePath = path.join(tempDir, "sessions.json");
    discoverCodexAppServerThreadsMock.mockReset().mockResolvedValue([]);
    readCodexAppServerThreadContextMock.mockReset().mockResolvedValue({});
    getCodexAppServerAvailabilityErrorMock.mockReset().mockReturnValue(null);
    getCodexAppServerRuntimeStatusMock.mockReset().mockReturnValue({ state: "unknown" });
    routeReplyMock.mockReset().mockResolvedValue({ ok: true, messageId: "m-1" });
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
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

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
