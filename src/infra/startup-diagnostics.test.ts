import fs from "node:fs";
import { Session as InspectorSession } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  finishStartupDiagnostics,
  installStartupDiagnostics,
  resetStartupDiagnosticsForTest,
} from "./startup-diagnostics.js";

const ORIGINAL_ENV = { ...process.env };
const ORIGINAL_REPORT = process.report
  ? {
      writeReport: process.report.writeReport.bind(process.report),
      directory: process.report.directory,
      signal: process.report.signal,
      compact: process.report.compact,
      excludeEnv: process.report.excludeEnv,
      reportOnSignal: process.report.reportOnSignal,
    }
  : null;

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-startup-diag-test-"));
}

afterEach(() => {
  resetStartupDiagnosticsForTest();
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL_ENV);
  if (process.report && ORIGINAL_REPORT) {
    process.report.writeReport = ORIGINAL_REPORT.writeReport;
    process.report.directory = ORIGINAL_REPORT.directory;
    process.report.signal = ORIGINAL_REPORT.signal;
    process.report.compact = ORIGINAL_REPORT.compact;
    process.report.excludeEnv = ORIGINAL_REPORT.excludeEnv;
    process.report.reportOnSignal = ORIGINAL_REPORT.reportOnSignal;
  }
});

describe("startup diagnostics", () => {
  it("stays disabled without env flags", async () => {
    const session = await installStartupDiagnostics({
      label: "configure",
      env: {},
    });

    expect(session.enabled).toBe(false);
    expect(session.statePath).toBeUndefined();
  });

  it("records breadcrumbs and writes state on finish", async () => {
    const outputDir = makeTempDir();
    const env = {
      ...process.env,
      OPENCLAW_STARTUP_DIAG: "1",
      OPENCLAW_STARTUP_DIAG_DIR: outputDir,
    };
    delete env.VITEST;
    delete env.NODE_ENV;

    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const session = await installStartupDiagnostics({
      label: "configure",
      env,
    });

    session.mark("cli.preaction.plugin-registry-needed", { command: "configure" });
    await session.withPhase("plugins.discovery", async () => {});
    finishStartupDiagnostics("ready", { command: "configure" });

    const snapshot = JSON.parse(fs.readFileSync(session.statePath!, "utf8")) as {
      status: string;
      signal: string;
      events: Array<{ type: string; phase: string }>;
    };

    expect(snapshot.status).toBe("ready");
    expect(snapshot.signal).toBe("SIGUSR2");
    expect(snapshot.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "mark",
          phase: "cli.preaction.plugin-registry-needed",
        }),
        expect.objectContaining({
          type: "enter",
          phase: "plugins.discovery",
        }),
        expect.objectContaining({
          type: "leave",
          phase: "plugins.discovery",
        }),
      ]),
    );
    expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining(`pid=${process.pid}`));
  });

  it("writes a timeout report", async () => {
    vi.useFakeTimers();
    const outputDir = makeTempDir();
    process.env.OPENCLAW_STARTUP_DIAG = "1";
    process.env.OPENCLAW_STARTUP_DIAG_DIR = outputDir;
    process.env.OPENCLAW_STARTUP_DIAG_TIMEOUT_MS = "25";

    const writeReport = vi.fn((reportPath?: string) => reportPath ?? "");
    if (process.report) {
      process.report.writeReport = writeReport;
    }

    const session = await installStartupDiagnostics({
      label: "configure",
    });

    await vi.advanceTimersByTimeAsync(30);

    const snapshot = JSON.parse(fs.readFileSync(session.statePath!, "utf8")) as {
      status: string;
      reportPath?: string;
    };

    expect(snapshot.status).toBe("timeout");
    expect(writeReport).toHaveBeenCalledTimes(1);
    expect(snapshot.reportPath).toContain(".timeout.report.json");
  });

  it("writes a CPU profile on SIGUSR2 when enabled", async () => {
    const outputDir = makeTempDir();
    const env = {
      ...process.env,
      OPENCLAW_STARTUP_DIAG: "1",
      OPENCLAW_STARTUP_DIAG_DIR: outputDir,
      OPENCLAW_STARTUP_DIAG_CPU: "1",
    };
    delete env.VITEST;
    delete env.NODE_ENV;

    vi.spyOn(InspectorSession.prototype, "connect").mockImplementation(() => {});
    const postSpy = vi
      .spyOn(InspectorSession.prototype, "post")
      .mockImplementation(async (method: string) => {
        if (method === "Profiler.stop") {
          return { profile: { nodes: [], samples: [], timeDeltas: [] } };
        }
        return {};
      });
    vi.spyOn(InspectorSession.prototype, "disconnect").mockImplementation(() => {});
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const session = await installStartupDiagnostics({
      label: "configure",
      env,
    });

    process.emit("SIGUSR2");
    await new Promise((resolve) => setTimeout(resolve, 0));

    const snapshot = JSON.parse(fs.readFileSync(session.statePath!, "utf8")) as {
      cpuProfilePath?: string;
      events: Array<{ type: string }>;
    };

    expect(postSpy).toHaveBeenCalledWith("Profiler.enable");
    expect(postSpy).toHaveBeenCalledWith("Profiler.start");
    expect(postSpy).toHaveBeenCalledWith("Profiler.stop");
    expect(snapshot.cpuProfilePath).toContain(".signal.cpuprofile");
    expect(fs.existsSync(snapshot.cpuProfilePath!)).toBe(true);
    expect(snapshot.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "signal" })]),
    );
    expect(stderrWrite).toHaveBeenCalledWith(
      expect.stringContaining("startup CPU profile written:"),
    );
  });
});
