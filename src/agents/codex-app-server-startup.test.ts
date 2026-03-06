import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __testing,
  getCodexAppServerAvailabilityError,
  getCodexAppServerRuntimeStatus,
  initializeCodexAppServerRuntime,
} from "./codex-app-server-startup.js";

describe("initializeCodexAppServerRuntime", () => {
  afterEach(() => {
    __testing.resetRuntimeStatus();
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
});
