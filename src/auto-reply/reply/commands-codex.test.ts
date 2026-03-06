import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCodexBoundSessionKey } from "../../agents/codex-app-server-bindings.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, updateSessionStore } from "../../config/sessions.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const discoverCodexAppServerThreadsMock = vi.hoisted(() => vi.fn());
const getCodexAppServerRuntimeStatusMock = vi.hoisted(() => vi.fn(() => ({ state: "unknown" })));
const getCodexAppServerAvailabilityErrorMock = vi.hoisted(() =>
  vi.fn<() => string | null>(() => null),
);
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
}));

vi.mock("../../agents/codex-app-server-startup.js", () => ({
  getCodexAppServerAvailabilityError: () => getCodexAppServerAvailabilityErrorMock(),
  getCodexAppServerRuntimeStatus: () => getCodexAppServerRuntimeStatusMock(),
}));

vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => sessionBindingServiceMock,
}));

const { handleCodexCommand } = await import("./commands-codex.js");

describe("handleCodexCommand", () => {
  let tempDir = "";
  let storePath = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-command-"));
    storePath = path.join(tempDir, "sessions.json");
    discoverCodexAppServerThreadsMock.mockReset().mockResolvedValue([]);
    getCodexAppServerAvailabilityErrorMock.mockReset().mockReturnValue(null);
    getCodexAppServerRuntimeStatusMock.mockReset().mockReturnValue({ state: "unknown" });
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
        workspaceDir: params.workspaceDir,
        filter: "exec approvals",
      }),
    );
    expect(result?.reply?.text).toContain("thread-456");
    const store = loadSessionStore(storePath);
    expect(store[boundSessionKey]?.codexThreadId).toBe("thread-456");
    expect(store[boundSessionKey]?.providerOverride).toBe("codex-app-server");
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

  it("fails fast when the Codex runtime startup gate is unavailable", async () => {
    getCodexAppServerAvailabilityErrorMock.mockReturnValue(
      "Codex App Server runtime is unavailable: spawn ENOENT",
    );
    const params = buildParams("/codex list");

    const result = await handleCodexCommand(params, true);

    expect(discoverCodexAppServerThreadsMock).not.toHaveBeenCalled();
    expect(result?.reply?.text).toContain("spawn ENOENT");
  });
});
