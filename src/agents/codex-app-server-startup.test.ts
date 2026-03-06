import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  getCodexAppServerAvailabilityError,
  getCodexAppServerRuntimeStatus,
  initializeCodexAppServerRuntime,
  reconcileCodexBoundSessionsOnStartup,
  reconcileCodexPendingInputsOnStartup,
} from "./codex-app-server-startup.js";

describe("initializeCodexAppServerRuntime", () => {
  let tempDir = "";
  let storePath = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-startup-"));
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(() => {
    __testing.resetRuntimeStatus();
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("marks stdio runtime ready after a successful startup probe", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    const status = await initializeCodexAppServerRuntime({
      cfg: {
        agents: {
          defaults: {
            codexAppServer: {
              command: "codex-bin",
              args: ["--profile", "default"],
            },
          },
        },
      },
      log: { info, warn },
      probeStdio: vi.fn().mockResolvedValue(undefined),
    });

    expect(status.state).toBe("ready");
    expect(status.transport).toBe("stdio");
    expect(status.command).toBe("codex-bin");
    expect(info).toHaveBeenCalledWith(
      "codex app server runtime registered (transport=stdio, command: codex-bin, args: --profile default)",
    );
    expect(info).toHaveBeenCalledWith("codex app server runtime ready");
    expect(warn).not.toHaveBeenCalled();
  });

  it("marks stdio runtime unavailable after a failed startup probe", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    const status = await initializeCodexAppServerRuntime({
      cfg: {
        agents: {
          defaults: {
            codexAppServer: {
              command: "missing-codex",
            },
          },
        },
      },
      log: { info, warn },
      probeStdio: vi.fn().mockRejectedValue(new Error("spawn ENOENT")),
    });

    expect(status.state).toBe("unavailable");
    expect(status.error).toBe("spawn ENOENT");
    expect(warn).toHaveBeenCalledWith("codex app server runtime setup failed: spawn ENOENT");
    expect(getCodexAppServerAvailabilityError({})).toBe(
      "Codex App Server runtime is unavailable: spawn ENOENT",
    );
  });

  it("treats missing websocket url as unavailable", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    const status = await initializeCodexAppServerRuntime({
      cfg: {
        agents: {
          defaults: {
            codexAppServer: {
              transport: "websocket",
            },
          },
        },
      },
      log: { info, warn },
    });

    expect(status.state).toBe("unavailable");
    expect(status.transport).toBe("websocket");
    expect(warn).toHaveBeenCalledWith(
      'codex app server runtime setup failed: agents.defaults.codexAppServer.url is required when transport="websocket"',
    );
  });

  it("marks disabled runtimes without logging startup probes", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    const status = await initializeCodexAppServerRuntime({
      cfg: {
        agents: {
          defaults: {
            codexAppServer: {
              enabled: false,
            },
          },
        },
      },
      log: { info, warn },
    });

    expect(status.state).toBe("disabled");
    expect(getCodexAppServerRuntimeStatus().state).toBe("disabled");
    expect(
      getCodexAppServerAvailabilityError({
        agents: { defaults: { codexAppServer: { enabled: false } } },
      }),
    ).toBe(
      'Provider "codex-app-server" is disabled. Set agents.defaults.codexAppServer.enabled=true.',
    );
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("clears expired pending codex input state during startup reconcile", async () => {
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          "agent:main:telegram:dm:1234": {
            sessionId: "session-1",
            updatedAt: Date.now() - 5_000,
            providerOverride: "codex-app-server",
            pendingUserInputRequestId: "req-expired",
            pendingUserInputOptions: ["Approve", "Decline"],
            pendingUserInputExpiresAt: Date.now() - 1_000,
            pendingUserInputPromptText: "Approve deploy?",
            pendingUserInputMethod: "server/requestApproval",
          },
          "agent:main:telegram:dm:5678": {
            sessionId: "session-2",
            updatedAt: Date.now(),
            providerOverride: "codex-app-server",
            pendingUserInputRequestId: "req-live",
            pendingUserInputOptions: ["Yes", "No"],
            pendingUserInputExpiresAt: Date.now() + 60_000,
            pendingUserInputPromptText: "Ship it?",
            pendingUserInputMethod: "item/tool/requestUserInput",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = await reconcileCodexPendingInputsOnStartup({
      cfg: {
        session: {
          store: storePath,
        },
      },
    });

    expect(result).toEqual({ checked: 2, cleared: 1, failed: 0 });

    const restored = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, unknown>;
    expect(
      restored["agent:main:telegram:dm:1234"] as {
        pendingUserInputRequestId?: string;
        pendingUserInputPromptText?: string;
      },
    ).not.toHaveProperty("pendingUserInputRequestId");
    expect(
      restored["agent:main:telegram:dm:1234"] as {
        pendingUserInputRequestId?: string;
        pendingUserInputPromptText?: string;
      },
    ).not.toHaveProperty("pendingUserInputPromptText");
    expect(
      restored["agent:main:telegram:dm:5678"] as { pendingUserInputRequestId?: string },
    ).toEqual(
      expect.objectContaining({
        pendingUserInputRequestId: "req-live",
      }),
    );
  });

  it("repairs persisted codex bound sessions when the channel binding survives restart", async () => {
    const sessionKey = "agent:main:codex:binding:telegram:default:abc123def4567890";
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [sessionKey]: {
            sessionId: "session-1",
            updatedAt: Date.now() - 60_000,
            providerOverride: "openai",
            codexAutoRoute: false,
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    const result = await reconcileCodexBoundSessionsOnStartup({
      cfg: {
        session: {
          store: storePath,
        },
      },
      listBindings: () => [
        {
          bindingId: "telegram:1",
          targetSessionKey: sessionKey,
          targetKind: "session",
          conversation: {
            channel: "telegram",
            accountId: "default",
            conversationId: "1234",
          },
          status: "active",
          boundAt: Date.now() - 60_000,
        },
      ],
    });

    expect(result).toEqual({
      checked: 1,
      repaired: 1,
      removed: 0,
      failed: 0,
      staleSessionKeys: [],
    });

    const restored = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, unknown>;
    expect(
      restored[sessionKey] as {
        providerOverride?: string;
        codexAutoRoute?: boolean;
      },
    ).toEqual(
      expect.objectContaining({
        providerOverride: "codex-app-server",
        codexAutoRoute: true,
      }),
    );
  });

  it("removes stale codex bindings when the target bound session is missing", async () => {
    const unbindBinding = vi.fn(async () => 1);

    const result = await reconcileCodexBoundSessionsOnStartup({
      cfg: {
        session: {
          store: storePath,
        },
      },
      listBindings: () => [
        {
          bindingId: "discord:1",
          targetSessionKey: "agent:main:codex:binding:discord:default:abc123def4567890",
          targetKind: "session",
          conversation: {
            channel: "discord",
            accountId: "default",
            conversationId: "thread-1",
            parentConversationId: "channel-1",
          },
          status: "active",
          boundAt: Date.now() - 60_000,
        },
      ],
      unbindBinding,
    });

    expect(result).toEqual({
      checked: 1,
      repaired: 0,
      removed: 1,
      failed: 0,
      staleSessionKeys: ["agent:main:codex:binding:discord:default:abc123def4567890"],
    });
    expect(unbindBinding).toHaveBeenCalledWith("discord:1");
  });
});
