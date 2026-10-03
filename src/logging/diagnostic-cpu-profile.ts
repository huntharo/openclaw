import type { Profiler } from "node:inspector";
import type { DiagnosticsCpuProfileParams } from "../../packages/gateway-protocol/src/schema/diagnostics.js";
import { boundedJsonUtf8Bytes } from "../infra/json-utf8-bytes.js";
import {
  assertProfile,
  captureDiagnosticProfile,
  DIAGNOSTIC_PROFILE_MAX_BYTES,
  ProfileFailure,
  sanitizeDiagnosticProfileFrame,
} from "./diagnostic-profile.js";

const DURATION_MS = 5_000;
const INTERVAL_MICROS = 10_000;
const MAX_NODES = 16_384;
const MAX_SAMPLES = 65_536;

function sanitizeProfile(
  profile: Profiler.Profile,
  packageRoot: string | null,
  {
    startBlockedMs,
    requestedDurationMs = DURATION_MS,
  }: {
    startBlockedMs: number;
    requestedDurationMs?: number;
  },
) {
  assertProfile(
    Array.isArray(profile.nodes) &&
      profile.nodes.length > 0 &&
      Array.isArray(profile.samples) &&
      Array.isArray(profile.timeDeltas) &&
      profile.samples.length === profile.timeDeltas.length &&
      Number.isFinite(profile.startTime) &&
      Number.isFinite(profile.endTime) &&
      profile.endTime >= profile.startTime,
  );
  if (profile.nodes.length > MAX_NODES || profile.samples.length > MAX_SAMPLES) {
    throw new ProfileFailure("profile-too-large");
  }
  const ids = new Set<number>();
  const parents = new Map<number, number>();
  let redactedNodeCount = 0;
  const nodes = profile.nodes.map((node): Profiler.ProfileNode => {
    assertProfile(Number.isSafeInteger(node.id) && node.id > 0 && !ids.has(node.id));
    ids.add(node.id);
    const { callFrame, redacted } = sanitizeDiagnosticProfileFrame(node.callFrame, packageRoot);
    redactedNodeCount += Number(redacted || node.deoptReason !== undefined);
    if (node.children !== undefined) {
      assertProfile(Array.isArray(node.children));
      for (const child of node.children) {
        assertProfile(Number.isSafeInteger(child) && !parents.has(child));
        parents.set(child, node.id);
      }
    }
    assertProfile(
      node.hitCount === undefined || (Number.isSafeInteger(node.hitCount) && node.hitCount >= 0),
    );
    if (node.positionTicks !== undefined) {
      assertProfile(Array.isArray(node.positionTicks));
      for (const tick of node.positionTicks) {
        assertProfile(
          Number.isSafeInteger(tick.line) && Number.isSafeInteger(tick.ticks) && tick.ticks >= 0,
        );
      }
    }
    return {
      id: node.id,
      callFrame,
      ...(node.children !== undefined ? { children: node.children } : {}),
      ...(node.hitCount !== undefined ? { hitCount: node.hitCount } : {}),
      ...(node.positionTicks !== undefined ? { positionTicks: node.positionTicks } : {}),
      ...(node.deoptReason !== undefined ? { deoptReason: "[redacted]" } : {}),
    };
  });
  const roots = nodes.filter((node) => !parents.has(node.id));
  const root = roots[0];
  assertProfile(
    root !== undefined && roots.length === 1 && [...parents.keys()].every((id) => ids.has(id)),
  );
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const visited = new Set<number>();
  const pending = [root.id];
  while (pending.length) {
    const id = pending.pop()!;
    assertProfile(!visited.has(id));
    visited.add(id);
    pending.push(...(byId.get(id)!.children ?? []));
  }
  assertProfile(visited.size === nodes.length);
  assertProfile(profile.samples.every((id) => ids.has(id)));
  // V8 deoptimization samples can arrive out of timestamp order; preserve their signed deltas.
  assertProfile(profile.timeDeltas.every((delta) => Number.isFinite(delta)));
  const result = {
    requestedDurationMs,
    actualDurationMs: (profile.endTime - profile.startTime) / 1_000,
    startBlockedMs,
    samplingIntervalMicros: INTERVAL_MICROS,
    sampleLossCount: null,
    redactedNodeCount,
    profile: {
      nodes,
      startTime: profile.startTime,
      endTime: profile.endTime,
      samples: profile.samples,
      timeDeltas: profile.timeDeltas,
    },
  };
  if (!boundedJsonUtf8Bytes(result, DIAGNOSTIC_PROFILE_MAX_BYTES).complete) {
    throw new ProfileFailure("profile-too-large");
  }
  return result;
}

/** Captures the main isolate's CPU samples through the shared inspector owner. */
export async function captureDiagnosticCpuProfile(
  options: DiagnosticsCpuProfileParams & {
    signal: AbortSignal;
    hasAuthority: () => boolean;
  },
) {
  const hot = "mode" in options ? options : undefined;
  const observeMs = hot?.observeMs ?? 60_000;
  const cpuThresholdPercent = hot?.cpuThresholdPercent ?? 80;
  type Window = ReturnType<typeof sanitizeProfile> & { mainThreadCpuPercent: number };
  const windows: Window[] = [];
  let armedAt: number | undefined;
  let windowStartedAt = 0;
  let cpuBefore: NodeJS.CpuUsage | undefined;
  let mainThreadCpuPercent = 0;
  let requestedDurationMs = DURATION_MS;
  let triggered = false;
  let observedDurationMs = 0;
  const outcome = await captureDiagnosticProfile({
    signal: options.signal,
    hasAuthority: options.hasAuthority,
    durationMs: hot
      ? () => {
          requestedDurationMs = Math.max(
            1,
            Math.min(DURATION_MS, observeMs - (performance.now() - armedAt!)),
          );
          return requestedDurationMs;
        }
      : DURATION_MS,
    setup: async (session) => {
      await session.post("Profiler.enable");
      await session.post("Profiler.setSamplingInterval", { interval: INTERVAL_MICROS });
    },
    start: (session) => {
      // Keep dispatch synchronous so the shared owner measures native start blocking.
      const starting = session.post("Profiler.start");
      return hot
        ? starting.then(() => {
            // Exclude code-map construction and rotation/sanitization from the hot trigger.
            cpuBefore = process.threadCpuUsage();
            windowStartedAt = performance.now();
            armedAt ??= windowStartedAt;
          })
        : starting;
    },
    stop: (session) => {
      if (hot && cpuBefore) {
        const cpu = process.threadCpuUsage(cpuBefore);
        const elapsedMs = performance.now() - windowStartedAt;
        mainThreadCpuPercent = elapsedMs > 0 ? (cpu.user + cpu.system) / (elapsedMs * 10) : 0;
      }
      return session.post("Profiler.stop");
    },
    disable: (session) => session.post("Profiler.disable"),
    sanitize: (profile, packageRoot, measurement) =>
      sanitizeProfile(profile, packageRoot, { ...measurement, requestedDurationMs }),
    ...(hot
      ? {
          onWindow: (result: ReturnType<typeof sanitizeProfile>) => {
            windows.push({ ...result, mainThreadCpuPercent });
            if (windows.length > 2) {
              windows.shift();
            }
            triggered = mainThreadCpuPercent >= cpuThresholdPercent;
            observedDurationMs = performance.now() - armedAt!;
            // Bound the entire retained history, not just each completed window.
            if (
              windows.reduce((sum, window) => sum + window.profile.nodes.length, 0) > MAX_NODES ||
              windows.reduce((sum, window) => sum + window.profile.samples.length, 0) >
                MAX_SAMPLES ||
              !boundedJsonUtf8Bytes(hotResult(), DIAGNOSTIC_PROFILE_MAX_BYTES).complete
            ) {
              throw new ProfileFailure("profile-too-large");
            }
            return !triggered && observedDurationMs < observeMs;
          },
        }
      : {}),
  });
  function hotResult() {
    return {
      ...windows.at(-1)!,
      hot: {
        observeMs,
        observedDurationMs,
        cpuThresholdPercent,
        triggered,
        ...(windows.length === 2 ? { previousWindow: windows[0] } : {}),
      },
    };
  }
  if (outcome.status === "complete" && (options.signal.aborted || !options.hasAuthority())) {
    return { status: "unavailable" as const, reason: "cancelled" as const, cleanupFailed: false };
  }
  return hot && outcome.status === "complete"
    ? { status: "complete" as const, result: hotResult() }
    : outcome;
}
