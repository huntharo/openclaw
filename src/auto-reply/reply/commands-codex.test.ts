import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore, updateSessionStore } from "../../config/sessions.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

const discoverCodexAppServerThreadsMock = vi.hoisted(() => vi.fn());

vi.mock("../../agents/codex-app-server-runner.js", () => ({
  discoverCodexAppServerThreads: (...args: unknown[]) => discoverCodexAppServerThreadsMock(...args),
  isCodexAppServerProvider: (provider: string) => provider === "codex-app-server",
}));

const { handleCodexCommand } = await import("./commands-codex.js");

describe("handleCodexCommand", () => {
  let tempDir = "";
  let storePath = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-command-"));
    storePath = path.join(tempDir, "sessions.json");
    discoverCodexAppServerThreadsMock.mockReset().mockResolvedValue([]);
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  function buildParams(commandBody: string, cfg: OpenClawConfig = {}) {
    const params = buildCommandTestParams(commandBody, cfg, {
      Surface: "telegram",
      Provider: "telegram",
    });
    params.storePath = storePath;
    params.sessionEntry = {
      sessionId: params.sessionKey,
      updatedAt: Date.now(),
    };
    return params;
  }

  it("binds the conversation and continues with the initial prompt for /codex new", async () => {
    const params = buildParams("/codex new --cwd /repo/openclaw fix exec approvals");

    const result = await handleCodexCommand(params, true);

    expect(result).toEqual({ shouldContinue: true });
    expect(params.ctx.BodyForAgent).toBe("fix exec approvals");
    const store = loadSessionStore(storePath);
    expect(store[params.sessionKey]?.providerOverride).toBe("codex-app-server");
    expect(store[params.sessionKey]?.codexProjectKey).toBe("/repo/openclaw");
    expect(store[params.sessionKey]?.codexAutoRoute).toBe(true);
  });

  it("detaches locally without deleting the remembered thread", async () => {
    const params = buildParams("/codex detach");
    await updateSessionStore(storePath, (store) => {
      store[params.sessionKey] = {
        sessionId: params.sessionKey,
        updatedAt: Date.now(),
        providerOverride: "codex-app-server",
        codexThreadId: "thread-123",
        codexProjectKey: "/repo/openclaw",
        codexAutoRoute: true,
      };
    });
    params.sessionEntry = loadSessionStore(storePath)[params.sessionKey];

    const result = await handleCodexCommand(params, true);

    expect(result?.reply?.text).toContain("remote thread was left intact");
    const store = loadSessionStore(storePath);
    expect(store[params.sessionKey]?.codexThreadId).toBe("thread-123");
    expect(store[params.sessionKey]?.providerOverride).toBeUndefined();
    expect(store[params.sessionKey]?.codexAutoRoute).toBe(false);
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
    const params = buildParams("/codex join exec approvals");

    const result = await handleCodexCommand(params, true);

    expect(discoverCodexAppServerThreadsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        filter: "exec approvals",
      }),
    );
    expect(result?.reply?.text).toContain("thread-456");
    const store = loadSessionStore(storePath);
    expect(store[params.sessionKey]?.codexThreadId).toBe("thread-456");
    expect(store[params.sessionKey]?.providerOverride).toBe("codex-app-server");
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
});
