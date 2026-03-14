import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { Session as InspectorSession } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { resolveStateDir } from "../config/paths.js";
import { isTruthyEnvValue } from "./env.js";

type StartupDiagnosticStatus = "running" | "ready" | "error" | "timeout";
type StartupDiagnosticEventType = "mark" | "enter" | "leave" | "finish" | "signal" | "timeout";

type StartupDiagnosticEvent = {
  type: StartupDiagnosticEventType;
  phase: string;
  at: string;
  details?: Record<string, unknown>;
};

type StartupDiagnosticSnapshot = {
  sessionId: string;
  label: string;
  pid: number;
  signal: NodeJS.Signals;
  status: StartupDiagnosticStatus;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  outputDir: string;
  statePath: string;
  reportPath?: string;
  cpuProfilePath?: string;
  argv: string[];
  nodeVersion: string;
  platform: NodeJS.Platform;
  currentPhase?: string;
  phases: string[];
  events: StartupDiagnosticEvent[];
};

type CpuProfilerState = {
  enabled: boolean;
  session: InspectorSession | null;
  active: boolean;
  writing: boolean;
};

export type StartupDiagnosticsSession = {
  enabled: boolean;
  signal: NodeJS.Signals;
  statePath?: string;
  outputDir?: string;
  mark: (phase: string, details?: Record<string, unknown>) => void;
  withPhase: <T>(phase: string, fn: () => Promise<T> | T) => Promise<T>;
  finish: (
    status: Exclude<StartupDiagnosticStatus, "running">,
    details?: Record<string, unknown>,
  ) => void;
  dispose?: () => void;
};

type StartupDiagnosticsState = {
  session: StartupDiagnosticsSession | null;
};

const DEFAULT_SIGNAL: NodeJS.Signals = "SIGUSR2";
const DEFAULT_OUTPUT_SUBDIR = "diagnostics/startup";
const MAX_EVENTS = 128;
const GLOBAL_STATE_KEY = Symbol.for("openclaw.startupDiagnostics");

const globalState = (() => {
  const target = globalThis as typeof globalThis & {
    [GLOBAL_STATE_KEY]?: StartupDiagnosticsState;
  };
  if (!target[GLOBAL_STATE_KEY]) {
    target[GLOBAL_STATE_KEY] = { session: null };
  }
  return target[GLOBAL_STATE_KEY];
})();

function parseTimeoutMs(raw: string | undefined): number {
  if (!raw?.trim()) {
    return 0;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function shouldEnable(env: NodeJS.ProcessEnv): boolean {
  return (
    isTruthyEnvValue(env.OPENCLAW_STARTUP_DIAG) ||
    isTruthyEnvValue(env.OPENCLAW_STARTUP_DIAG_CPU) ||
    Boolean(env.OPENCLAW_STARTUP_DIAG_SIGNAL?.trim()) ||
    parseTimeoutMs(env.OPENCLAW_STARTUP_DIAG_TIMEOUT_MS) > 0
  );
}

function resolveSignal(env: NodeJS.ProcessEnv): NodeJS.Signals {
  const requested = env.OPENCLAW_STARTUP_DIAG_SIGNAL?.trim() as NodeJS.Signals | undefined;
  return requested || DEFAULT_SIGNAL;
}

function resolveOutputDir(env: NodeJS.ProcessEnv): string {
  const override = env.OPENCLAW_STARTUP_DIAG_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  try {
    return path.join(resolveStateDir(env), DEFAULT_OUTPUT_SUBDIR);
  } catch {
    return path.join(os.tmpdir(), "openclaw-startup-diagnostics");
  }
}

function sanitizeLabel(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const normalized = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "startup";
}

function shouldAnnounceToStderr(env: NodeJS.ProcessEnv): boolean {
  return !env.VITEST && env.NODE_ENV !== "test";
}

function pushEvent(snapshot: StartupDiagnosticSnapshot, event: StartupDiagnosticEvent): void {
  snapshot.events.push(event);
  if (snapshot.events.length > MAX_EVENTS) {
    snapshot.events.splice(0, snapshot.events.length - MAX_EVENTS);
  }
  snapshot.updatedAt = event.at;
}

function writeSnapshot(snapshot: StartupDiagnosticSnapshot): void {
  fs.mkdirSync(snapshot.outputDir, { recursive: true });
  fs.writeFileSync(snapshot.statePath, `${JSON.stringify(snapshot, null, 2)}\n`);
}

function configureProcessReport(snapshot: StartupDiagnosticSnapshot): void {
  if (!process.report) {
    return;
  }
  process.report.directory = snapshot.outputDir;
  process.report.signal = snapshot.signal;
  process.report.compact = true;
  process.report.excludeEnv = true;
  process.report.reportOnSignal = true;
}

function captureTimeoutReport(snapshot: StartupDiagnosticSnapshot): void {
  try {
    const reportPath = path.join(snapshot.outputDir, `${snapshot.label}.timeout.report.json`);
    process.report?.writeReport?.(reportPath);
    snapshot.reportPath = reportPath;
  } catch {
    // Best-effort text artifact.
  }
}

async function startCpuProfiler(enabled: boolean): Promise<CpuProfilerState> {
  if (!enabled) {
    return { enabled: false, session: null, active: false, writing: false };
  }
  try {
    const session = new InspectorSession();
    session.connect();
    await session.post("Profiler.enable");
    await session.post("Profiler.start");
    return { enabled: true, session, active: true, writing: false };
  } catch {
    return { enabled: false, session: null, active: false, writing: false };
  }
}

async function stopCpuProfiler(
  state: CpuProfilerState,
  snapshot: StartupDiagnosticSnapshot,
  suffix: string,
): Promise<string | undefined> {
  if (!state.enabled || !state.session || !state.active || state.writing) {
    return snapshot.cpuProfilePath;
  }
  state.writing = true;
  try {
    const result = (await state.session.post("Profiler.stop")) as { profile?: unknown };
    const cpuProfilePath = path.join(snapshot.outputDir, `${snapshot.label}.${suffix}.cpuprofile`);
    fs.writeFileSync(cpuProfilePath, `${JSON.stringify(result.profile ?? {}, null, 2)}\n`);
    snapshot.cpuProfilePath = cpuProfilePath;
    state.active = false;
    state.session.disconnect();
    state.session = null;
    return cpuProfilePath;
  } finally {
    state.writing = false;
  }
}

function createDisabledSession(): StartupDiagnosticsSession {
  return {
    enabled: false,
    signal: DEFAULT_SIGNAL,
    mark: () => {},
    withPhase: async <T>(_: string, fn: () => Promise<T> | T) => await fn(),
    finish: () => {},
  };
}

export async function installStartupDiagnostics(params: {
  label: string;
  env?: NodeJS.ProcessEnv;
}): Promise<StartupDiagnosticsSession> {
  const existing = globalState.session;
  if (existing) {
    return existing;
  }

  const env = params.env ?? process.env;
  if (!shouldEnable(env)) {
    const disabled = createDisabledSession();
    globalState.session = disabled;
    return disabled;
  }

  const signal = resolveSignal(env);
  const outputDir = resolveOutputDir(env);
  const label = `${sanitizeLabel(params.label)}-${process.pid}-${randomUUID().slice(0, 8)}`;
  const statePath = path.join(outputDir, `${label}.startup.json`);
  const snapshot: StartupDiagnosticSnapshot = {
    sessionId: label,
    label,
    pid: process.pid,
    signal,
    status: "running",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    outputDir,
    statePath,
    argv: [...process.argv],
    nodeVersion: process.version,
    platform: process.platform,
    phases: [],
    events: [],
  };
  const timeoutMs = parseTimeoutMs(env.OPENCLAW_STARTUP_DIAG_TIMEOUT_MS);
  const captureCpu = isTruthyEnvValue(env.OPENCLAW_STARTUP_DIAG_CPU);

  writeSnapshot(snapshot);
  configureProcessReport(snapshot);
  if (shouldAnnounceToStderr(env)) {
    process.stderr.write(
      `[openclaw] startup diagnostics armed: pid=${process.pid} signal=${signal} state=${statePath}\n`,
    );
  }

  const cpuProfilerState = await startCpuProfiler(captureCpu);
  const flush = () => writeSnapshot(snapshot);

  const mark = (phase: string, details?: Record<string, unknown>) => {
    snapshot.currentPhase = phase;
    pushEvent(snapshot, {
      type: "mark",
      phase,
      at: new Date().toISOString(),
      ...(details ? { details } : {}),
    });
  };

  const withPhase = async <T>(phase: string, fn: () => Promise<T> | T): Promise<T> => {
    snapshot.phases.push(phase);
    snapshot.currentPhase = phase;
    pushEvent(snapshot, {
      type: "enter",
      phase,
      at: new Date().toISOString(),
    });
    try {
      return await fn();
    } finally {
      pushEvent(snapshot, {
        type: "leave",
        phase,
        at: new Date().toISOString(),
      });
      snapshot.phases.pop();
      snapshot.currentPhase = snapshot.phases[snapshot.phases.length - 1];
    }
  };

  const timeoutTimer =
    timeoutMs > 0
      ? setTimeout(() => {
          if (snapshot.status !== "running") {
            return;
          }
          snapshot.status = "timeout";
          snapshot.finishedAt = new Date().toISOString();
          pushEvent(snapshot, {
            type: "timeout",
            phase: snapshot.currentPhase ?? "startup",
            at: snapshot.finishedAt,
            details: { timeoutMs },
          });
          captureTimeoutReport(snapshot);
          void stopCpuProfiler(cpuProfilerState, snapshot, "timeout").then(flush);
          flush();
        }, timeoutMs)
      : null;
  timeoutTimer?.unref?.();

  const finish = (
    status: Exclude<StartupDiagnosticStatus, "running">,
    details?: Record<string, unknown>,
  ) => {
    if (snapshot.status !== "running") {
      return;
    }
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
    }
    snapshot.status = status;
    snapshot.finishedAt = new Date().toISOString();
    pushEvent(snapshot, {
      type: "finish",
      phase: snapshot.currentPhase ?? "startup",
      at: snapshot.finishedAt,
      ...(details ? { details } : {}),
    });
    flush();
  };

  const onSignal = () => {
    pushEvent(snapshot, {
      type: "signal",
      phase: snapshot.currentPhase ?? "startup",
      at: new Date().toISOString(),
      details: { signal },
    });
    void stopCpuProfiler(cpuProfilerState, snapshot, "signal").then((cpuProfilePath) => {
      if (cpuProfilePath && shouldAnnounceToStderr(env)) {
        process.stderr.write(`[openclaw] startup CPU profile written: ${cpuProfilePath}\n`);
      }
      flush();
    });
    flush();
  };

  process.on(signal, onSignal);

  const session: StartupDiagnosticsSession = {
    enabled: true,
    signal,
    statePath,
    outputDir,
    mark,
    withPhase,
    finish,
    dispose: () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      process.removeListener(signal, onSignal);
      if (cpuProfilerState.session) {
        cpuProfilerState.session.disconnect();
        cpuProfilerState.session = null;
      }
      cpuProfilerState.active = false;
    },
  };
  globalState.session = session;
  return session;
}

export function markStartupPhase(phase: string, details?: Record<string, unknown>): void {
  globalState.session?.mark(phase, details);
}

export async function withStartupDiagnosticsPhase<T>(
  phase: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  const session = globalState.session;
  if (!session) {
    return await fn();
  }
  return await session.withPhase(phase, fn);
}

export function finishStartupDiagnostics(
  status: Exclude<StartupDiagnosticStatus, "running">,
  details?: Record<string, unknown>,
): void {
  globalState.session?.finish(status, details);
}

export function resetStartupDiagnosticsForTest(): void {
  globalState.session?.dispose?.();
  globalState.session = null;
}
