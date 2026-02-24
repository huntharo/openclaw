import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";

describe("CronService wake targeting", () => {
  it("routes wake events to the provided session key", () => {
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const cron = new CronService({
      storePath: "/tmp/cron-jobs.json",
      cronEnabled: true,
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    const result = cron.wake({
      mode: "now",
      text: "Done: report regenerated",
      sessionKey: "agent:main:telegram:group:-100123",
      agentId: "main",
    });

    expect(result).toEqual({ ok: true });
    expect(enqueueSystemEvent).toHaveBeenCalledWith("Done: report regenerated", {
      sessionKey: "agent:main:telegram:group:-100123",
      agentId: "main",
    });
    expect(requestHeartbeatNow).toHaveBeenCalledWith({
      reason: "wake",
      sessionKey: "agent:main:telegram:group:-100123",
      agentId: "main",
    });
  });

  it("does not request immediate wake when mode is next-heartbeat", () => {
    const enqueueSystemEvent = vi.fn();
    const requestHeartbeatNow = vi.fn();
    const cron = new CronService({
      storePath: "/tmp/cron-jobs.json",
      cronEnabled: true,
      log: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      enqueueSystemEvent,
      requestHeartbeatNow,
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" })),
    });

    const result = cron.wake({
      mode: "next-heartbeat",
      text: "Done: report regenerated",
      sessionKey: "agent:main:telegram:group:-100123",
      agentId: "main",
    });

    expect(result).toEqual({ ok: true });
    expect(enqueueSystemEvent).toHaveBeenCalledWith("Done: report regenerated", {
      sessionKey: "agent:main:telegram:group:-100123",
      agentId: "main",
    });
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
  });
});
