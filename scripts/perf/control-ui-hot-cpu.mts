#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { hasErrnoCode } from "../../src/infra/errno.ts";
import { boundedJsonUtf8Bytes } from "../../src/infra/json-utf8-bytes.ts";
import {
  DIAGNOSTIC_CPU_MAX_NODES,
  DIAGNOSTIC_CPU_MAX_SAMPLES,
  sanitizeDiagnosticCpuProfile,
} from "../../src/logging/diagnostic-cpu-profile.ts";
import {
  DIAGNOSTIC_PROFILE_MAX_BYTES,
  resolveControlUiProfileCodeUrl,
} from "../../src/logging/diagnostic-profile.ts";

class RecorderError extends Error {}

async function controlUiScriptPaths() {
  const paths = new Set<string>();
  let bytes = 0;
  const add = (value: string) => {
    if (paths.has(value)) {
      return;
    }
    bytes += Buffer.byteLength(value);
    if (paths.size >= DIAGNOSTIC_CPU_MAX_NODES || bytes > DIAGNOSTIC_PROFILE_MAX_BYTES) {
      throw new RecorderError("The local Control UI code inventory exceeds the diagnostic limits.");
    }
    paths.add(value);
  };
  const source = fileURLToPath(new URL("../../ui/src/", import.meta.url));
  for (const entry of await fs.readdir(source, { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && /\.[cm]?[jt]s$/.test(entry.name) && !entry.name.includes(".test.")) {
      const relative = path.relative(source, path.join(entry.parentPath, entry.name));
      add(`/src/${relative.split(path.sep).join("/")}`);
    }
  }
  const assets = fileURLToPath(new URL("../../dist/control-ui/assets/", import.meta.url));
  const entries = await fs.readdir(assets).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  });
  for (const name of entries) {
    if (/^[A-Za-z0-9_+-]+\.js$/.test(name)) {
      add(`/assets/${name}`);
    }
  }
  return paths;
}

/** Owns a fresh browser and debugger, never an existing operator tab or profile. */
export async function captureControlUiHotCpu(options: {
  url: string;
  output: string;
  observeMs?: number;
  taskThresholdPercent?: number;
  headless?: boolean;
  signal: AbortSignal;
}) {
  let target: URL;
  try {
    target = new URL(options.url);
  } catch {
    throw new RecorderError("Provide an HTTP(S) Control UI URL.");
  }
  if (!/^https?:$/.test(target.protocol) || target.username || target.password) {
    throw new RecorderError("Provide an HTTP(S) Control UI URL without embedded credentials.");
  }
  const observeMs = options.observeMs ?? 60_000;
  const taskThresholdPercent = options.taskThresholdPercent ?? 80;
  if (
    !Number.isInteger(observeMs) ||
    observeMs < 1 ||
    observeMs > 60_000 ||
    !Number.isFinite(taskThresholdPercent) ||
    taskThresholdPercent <= 0 ||
    taskThresholdPercent > 100
  ) {
    throw new RecorderError(
      "observe-ms must be 1–60000; task-threshold-percent must be greater than 0 and at most 100.",
    );
  }
  const lifetime = AbortSignal.any([options.signal, AbortSignal.timeout(observeMs + 30_000)]);
  lifetime.throwIfAborted();
  const location = {
    origin: target.origin,
    scriptPaths: await controlUiScriptPaths(),
    scripts: new Map<string, string>(),
  };
  lifetime.throwIfAborted();
  const browser = await chromium.launch({ headless: options.headless ?? false });
  const closeOnAbort = () => {
    void browser.close().catch(() => {});
  };
  lifetime.addEventListener("abort", closeOnAbort, { once: true });
  type Window = Omit<ReturnType<typeof sanitizeDiagnosticCpuProfile>, "startBlockedMs"> & {
    profilerStartElapsedMs: number;
    mainThreadTaskPercent: number;
    heapUsedBytes: number;
    heapTotalBytes: number;
  };
  const windows: Window[] = [];
  let triggered = false;
  let observedDurationMs = 0;
  let result: ReturnType<typeof artifact>;
  function artifact() {
    return {
      kind: "control-ui-hot-cpu",
      observeMs,
      observedDurationMs,
      taskThresholdPercent,
      triggered,
      currentWindow: windows.at(-1)!,
      ...(windows.length === 2 ? { previousWindow: windows[0] } : {}),
    };
  }
  try {
    lifetime.throwIfAborted();
    const page = await browser.newPage();
    await page.goto(target.href, { waitUntil: "domcontentloaded" });
    if (new URL(page.url()).origin !== target.origin) {
      throw new RecorderError(
        "The page left the chosen Control UI origin; retry with its final URL.",
      );
    }
    const session = await page.context().newCDPSession(page);
    let recording = false;
    let retired = false;
    let inventoryLimitReached = false;
    let scriptBytes = 0;
    try {
      await session.send("Page.enable");
      const { frameTree } = await session.send("Page.getFrameTree");
      const frame = frameTree.frame;
      session.on("Page.frameNavigated", ({ frame: next }) => {
        if (next.id === frame.id && next.loaderId !== frame.loaderId) {
          retired = true;
          location.scripts.clear();
        }
      });
      session.on("Debugger.scriptParsed", ({ scriptId, url, hasSourceURL }) => {
        if (
          retired ||
          hasSourceURL !== false ||
          !/^-?\d{1,32}$/.test(scriptId) ||
          location.scripts.has(scriptId) ||
          resolveControlUiProfileCodeUrl(url, location) === undefined
        ) {
          return;
        }
        scriptBytes += Buffer.byteLength(scriptId) + Buffer.byteLength(url);
        if (
          location.scripts.size >= DIAGNOSTIC_CPU_MAX_NODES ||
          scriptBytes > DIAGNOSTIC_PROFILE_MAX_BYTES
        ) {
          inventoryLimitReached = retired = true;
          location.scripts.clear();
          return;
        }
        location.scripts.set(scriptId, url);
      });
      const assertCurrent = async () => {
        lifetime.throwIfAborted();
        const { frameTree: current } = await session.send("Page.getFrameTree");
        lifetime.throwIfAborted();
        if (inventoryLimitReached) {
          throw new RecorderError("The renderer script inventory exceeded the diagnostic limits.");
        }
        if (
          retired ||
          current.frame.id !== frame.id ||
          current.frame.loaderId !== frame.loaderId ||
          new URL(current.frame.url).origin !== target.origin
        ) {
          throw new RecorderError("The Control UI document changed; retry the recording.");
        }
      };
      await session.send("Debugger.enable");
      await session.send("Debugger.setSkipAllPauses", { skip: true });
      await session.send("Performance.enable", { timeDomain: "timeTicks" });
      await session.send("Profiler.enable");
      await session.send("Profiler.setSamplingInterval", { interval: 10_000 });
      const metrics = async () => {
        const { metrics: values } = await session.send("Performance.getMetrics");
        const read = (name: string) => {
          const value = values.find((metric) => metric.name === name)?.value;
          if (value === undefined || !Number.isFinite(value) || value < 0) {
            throw new RecorderError("Chromium did not provide the required renderer metrics.");
          }
          return value;
        };
        return {
          timestamp: read("Timestamp"),
          tasks: read("TaskDuration"),
          heapUsedBytes: read("JSHeapUsedSize"),
          heapTotalBytes: read("JSHeapTotalSize"),
        };
      };
      const armedAt = performance.now();
      for (;;) {
        await assertCurrent();
        recording = true;
        const startingAt = performance.now();
        await session.send("Profiler.start");
        const profilerStartElapsedMs = performance.now() - startingAt;
        const before = await metrics();
        const requestedDurationMs = Math.max(
          1,
          Math.min(5_000, observeMs - (performance.now() - armedAt)),
        );
        await delay(requestedDurationMs, undefined, { signal: lifetime });
        const after = await metrics();
        const { profile } = await session.send("Profiler.stop");
        recording = false;
        await assertCurrent();
        const elapsed = after.timestamp - before.timestamp;
        if (elapsed <= 0 || after.tasks < before.tasks) {
          throw new RecorderError("Renderer task counters reset; retry the recording.");
        }
        const mainThreadTaskPercent = ((after.tasks - before.tasks) / elapsed) * 100;
        const { startBlockedMs: _startBlockedMs, ...sanitized } = sanitizeDiagnosticCpuProfile(
          profile,
          null,
          { startBlockedMs: 0, requestedDurationMs },
          location,
        );
        windows.push({
          ...sanitized,
          profilerStartElapsedMs,
          mainThreadTaskPercent,
          heapUsedBytes: after.heapUsedBytes,
          heapTotalBytes: after.heapTotalBytes,
        });
        if (windows.length > 2) {
          windows.shift();
        }
        triggered = mainThreadTaskPercent >= taskThresholdPercent;
        observedDurationMs = performance.now() - armedAt;
        if (
          windows.reduce((sum, window) => sum + window.profile.nodes.length, 0) >
            DIAGNOSTIC_CPU_MAX_NODES ||
          windows.reduce((sum, window) => sum + window.profile.samples.length, 0) >
            DIAGNOSTIC_CPU_MAX_SAMPLES ||
          !boundedJsonUtf8Bytes(artifact(), DIAGNOSTIC_PROFILE_MAX_BYTES).complete
        ) {
          throw new RecorderError(
            "Renderer history exceeded the diagnostic profile limits; retry with a shorter observation.",
          );
        }
        if (triggered || observedDurationMs >= observeMs) {
          break;
        }
      }
      await assertCurrent();
      result = artifact();
    } finally {
      retired = true;
      location.scripts.clear();
      if (recording) {
        await session.send("Profiler.stop").catch(() => {});
      }
      await session.send("Profiler.disable").catch(() => {});
      await session.send("Performance.disable").catch(() => {});
      await session.send("Debugger.disable").catch(() => {});
      await session.detach().catch(() => {});
    }
  } finally {
    location.scripts.clear();
    location.scriptPaths.clear();
    lifetime.removeEventListener("abort", closeOnAbort);
    await browser.close();
  }
  lifetime.throwIfAborted();
  const file = await fs.open(options.output, "wx", 0o600);
  let identity: { dev: number; ino: number } | undefined;
  const ownsOutput = async () => {
    if (!identity) {
      return false;
    }
    const current = await fs.lstat(options.output).catch(() => undefined);
    return current?.dev === identity.dev && current.ino === identity.ino;
  };
  try {
    identity = await file.stat();
    lifetime.throwIfAborted();
    await file.writeFile(JSON.stringify(result!));
    await file.close();
    lifetime.throwIfAborted();
    if (!(await ownsOutput())) {
      throw new RecorderError(
        "The output file was replaced during capture; choose a new output path and retry.",
      );
    }
    lifetime.throwIfAborted();
  } catch (error) {
    await file.close().catch(() => {});
    if (await ownsOutput()) {
      await fs.unlink(options.output).catch(() => {
        throw new RecorderError(
          "Capture failed and partial output could not be removed; inspect the output path before retrying.",
        );
      });
    }
    throw error;
  }
  return result!;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const { values } = parseArgs({
      options: {
        url: { type: "string" },
        output: { type: "string" },
        "observe-ms": { type: "string" },
        "task-threshold-percent": { type: "string" },
        headless: { type: "boolean" },
        help: { type: "boolean" },
      },
    });
    if (values.help) {
      console.log(
        "node --import ./scripts/tsx.mjs scripts/perf/control-ui-hot-cpu.mts --url http://127.0.0.1:5173 --output renderer.json [--observe-ms 60000] [--task-threshold-percent 80] [--headless]",
      );
    } else {
      if (!values.url || !values.output) {
        throw new RecorderError(
          "Provide --url and a new --output file path; use --help for usage.",
        );
      }
      console.error("Opening an owned Chromium window; recording begins after the document loads.");
      const result = await captureControlUiHotCpu({
        url: values.url,
        output: values.output,
        observeMs: values["observe-ms"] === undefined ? undefined : Number(values["observe-ms"]),
        taskThresholdPercent:
          values["task-threshold-percent"] === undefined
            ? undefined
            : Number(values["task-threshold-percent"]),
        headless: values.headless,
        signal: controller.signal,
      });
      console.log(
        JSON.stringify({
          written: true,
          triggered: result.triggered,
          observedDurationMs: result.observedDurationMs,
          mainThreadTaskPercent: result.currentWindow.mainThreadTaskPercent,
        }),
      );
    }
  } catch (error) {
    console.error(
      error instanceof RecorderError
        ? error.message
        : "Renderer capture failed; check Chromium availability, the target, and the output path, then retry.",
    );
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
