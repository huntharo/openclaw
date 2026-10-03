import fs from "node:fs/promises";
import type { Profiler } from "node:inspector";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { captureControlUiHotCpu } from "../../scripts/perf/control-ui-hot-cpu.mts";
import { sanitizeDiagnosticCpuProfile } from "../../src/logging/diagnostic-cpu-profile.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const native = vi.hoisted(() => ({
  launch: vi.fn(),
  close: vi.fn(),
  send: vi.fn(),
  detach: vi.fn(),
  wait: vi.fn(),
  on: vi.fn(),
  parsed: vi.fn(),
  navigated: vi.fn(),
}));
vi.mock("playwright", () => ({ chromium: { launch: native.launch } }));
vi.mock("node:timers/promises", () => ({ setTimeout: native.wait }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const origin = "https://control.example";
const location = {
  origin,
  scriptPaths: new Set(["/src/app-routes.ts", "/assets/app-123.js"]),
  scripts: new Map([["1", `${origin}/src/app-routes.ts?token=private#secret`]]),
};
let now = 0;
let taskSeconds = 0;
let stopped = 0;
let loader = "initial";
let output: string;

function profile(url = `${origin}/src/app-routes.ts?token=private#secret`): Profiler.Profile {
  return {
    startTime: stopped * 5_000_000,
    endTime: (stopped + 1) * 5_000_000,
    nodes: [
      {
        id: 1,
        children: [2],
        callFrame: {
          functionName: "(root)",
          scriptId: "0",
          url: "",
          lineNumber: -1,
          columnNumber: -1,
        },
      },
      {
        id: 2,
        callFrame: {
          functionName: "renderRoute",
          scriptId: "1",
          url,
          lineNumber: 1,
          columnNumber: 2,
        },
      },
    ],
    samples: [2, 2],
    timeDeltas: [10_000, 10_000],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  now = taskSeconds = stopped = 0;
  loader = "initial";
  output = path.join(tempDirs.make("control-ui-recorder-"), "renderer.json");
  vi.spyOn(performance, "now").mockImplementation(() => now);
  native.close.mockResolvedValue(undefined);
  native.detach.mockResolvedValue(undefined);
  native.on.mockImplementation((event, handler) => {
    if (event === "Debugger.scriptParsed") {
      native.parsed.mockImplementation(handler);
    }
    if (event === "Page.frameNavigated") {
      native.navigated.mockImplementation(handler);
    }
  });
  native.launch.mockResolvedValue({
    close: native.close,
    newPage: async () => ({
      goto: async () => {},
      url: () => origin,
      context: () => ({
        newCDPSession: async () => ({ send: native.send, on: native.on, detach: native.detach }),
      }),
    }),
  });
  native.send.mockImplementation(async (method: string) => {
    if (method === "Debugger.enable") {
      native.parsed({
        scriptId: "1",
        url: `${origin}/src/app-routes.ts?token=private#secret`,
        hasSourceURL: false,
      });
      native.parsed({
        scriptId: "2",
        url: `${origin}/src/app-routes.ts?token=private#secret`,
        hasSourceURL: true,
      });
    }
    if (method === "Page.getFrameTree") {
      return { frameTree: { frame: { id: "chosen", loaderId: loader, url: origin } } };
    }
    if (method === "Performance.getMetrics") {
      return {
        metrics: [
          { name: "Timestamp", value: now / 1000 },
          { name: "TaskDuration", value: taskSeconds },
          { name: "JSHeapUsedSize", value: 1024 },
          { name: "JSHeapTotalSize", value: 4096 },
        ],
      };
    }
    if (method === "Profiler.stop") {
      const value = profile();
      stopped++;
      return { profile: value };
    }
    return {};
  });
  native.wait.mockImplementation(async (ms: number) => {
    now += ms;
    taskSeconds += (ms / 1000) * (stopped === 0 ? 0.1 : 0.9);
  });
});
afterEach(() => vi.restoreAllMocks());

function capture(signal = new AbortController().signal, observeMs = 10_000) {
  return captureControlUiHotCpu({
    url: `${origin}/?token=private`,
    output,
    observeMs,
    taskThresholdPercent: 80,
    signal,
    headless: true,
  });
}

it("writes private prior/current sanitized windows after owned debugger cleanup", async () => {
  native.close.mockImplementation(async () => {
    expect(native.detach).toHaveBeenCalledOnce();
    await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  });
  const result = await capture();
  expect(result).toMatchObject({
    triggered: true,
    previousWindow: { mainThreadTaskPercent: 10 },
    currentWindow: { mainThreadTaskPercent: 90, heapUsedBytes: 1024 },
  });
  expect(result.previousWindow!.profile.endTime).toBeLessThanOrEqual(
    result.currentWindow.profile.startTime,
  );
  expect(native.detach).toHaveBeenCalledOnce();
  expect(native.close).toHaveBeenCalled();
  const bytes = await fs.readFile(output, "utf8");
  expect(JSON.parse(bytes)).toEqual(result);
  expect(bytes).toContain("control-ui:src/app-routes.ts");
  expect(bytes).not.toMatch(/control\.example|private|secret|startBlockedMs/);
  expect(Buffer.byteLength(bytes)).toBeLessThanOrEqual(1024 * 1024);
  if (process.platform !== "win32") {
    expect((await fs.stat(output)).mode & 0o777).toBe(0o600);
  }
});

it.each([
  `${origin}/assets/app-123.js?auth=private`,
  `${origin}/src/app-routes.ts?token=private#secret`,
])("keeps only known Control UI code paths: %s", (url) => {
  const value = sanitizeDiagnosticCpuProfile(
    profile(url),
    null,
    { startBlockedMs: 0 },
    { ...location, scripts: new Map([["1", url]]) },
  );
  expect(value.profile.nodes[1]!.callFrame).toMatchObject({
    functionName: "renderRoute",
    url: `control-ui:${new URL(url).pathname.slice(1)}`,
  });
  expect(JSON.stringify(value)).not.toMatch(/private|secret|control\.example/);
});

it.each([
  "https://unrelated.example/src/app-routes.ts?private",
  `${origin}/src/unknown.ts`,
  "https://user:private@control.example/src/app-routes.ts",
  `${origin}/@fs/private/secret.ts`,
  `${origin}/assets/unknown.js`,
  "file:///private/secret.ts",
  "eval://private",
  "node:private",
])("redacts untrusted browser code and symbols: %s", (url) => {
  const value = sanitizeDiagnosticCpuProfile(
    profile(url),
    "/private",
    { startBlockedMs: 0 },
    { ...location, scripts: new Map([["1", url]]) },
  );
  expect(value.profile.nodes[1]!.callFrame).toMatchObject({ functionName: "[redacted]", url: "" });
  expect(JSON.stringify(value)).not.toMatch(/private|secret|unrelated|renderRoute/);
});

it.each(["abort", "navigation", "stop failure", "abort after cleanup"])(
  "returns no artifact on %s and closes its browser",
  async (scenario) => {
    const controller = new AbortController();
    if (scenario === "abort after cleanup") {
      native.close.mockImplementation(async () => controller.abort());
    } else if (scenario === "stop failure") {
      const send = native.send.getMockImplementation()!;
      native.send.mockImplementation(async (method: string) => {
        if (method === "Profiler.stop") {
          throw new Error("private native failure");
        }
        return send(method);
      });
    } else {
      native.wait.mockImplementation(async () => {
        if (scenario === "abort") {
          controller.abort();
          controller.signal.throwIfAborted();
        }
        loader = "replacement";
        native.navigated({ frame: { id: "chosen", loaderId: loader, url: origin } });
        native.parsed({
          scriptId: "1",
          url: `${origin}/src/app-routes.ts?token=private#secret`,
          hasSourceURL: false,
        });
      });
    }
    await expect(capture(controller.signal)).rejects.toThrow();
    expect(native.close).toHaveBeenCalled();
    await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("refuses combined history limits without writing a partial artifact", async () => {
  const send = native.send.getMockImplementation()!;
  native.send.mockImplementation(async (method: string) => {
    const response = await send(method);
    if (method === "Profiler.stop") {
      const value = profile();
      value.samples = Array(40_000).fill(2);
      value.timeDeltas = Array(40_000).fill(10_000);
      return { profile: value };
    }
    return response;
  });
  await expect(capture()).rejects.toThrow("exceeded");
  expect(stopped).toBe(2);
  expect(native.detach).toHaveBeenCalledOnce();
  expect(native.close).toHaveBeenCalled();
  await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
});

it("preserves an existing output file", async () => {
  await fs.writeFile(output, "operator-owned");
  await expect(capture()).rejects.toMatchObject({ code: "EEXIST" });
  expect(await fs.readFile(output, "utf8")).toBe("operator-owned");
  expect(native.close).toHaveBeenCalled();
});

it("redacts a spoofed sourceURL script identity while preserving profile counts", async () => {
  const send = native.send.getMockImplementation()!;
  native.send.mockImplementation(async (method: string) => {
    const response = await send(method);
    if (method === "Profiler.stop") {
      const value = profile();
      value.nodes[1]!.callFrame.scriptId = "2";
      value.nodes[1]!.callFrame.functionName = "sensitiveValue";
      return { profile: value };
    }
    return response;
  });
  const result = await capture();
  expect(result.currentWindow.profile.nodes[1]!.callFrame).toMatchObject({
    functionName: "[redacted]",
    url: "",
  });
  expect(result.currentWindow.profile.nodes).toHaveLength(2);
  expect(result.currentWindow.profile.samples).toEqual([2, 2]);
  expect(await fs.readFile(output, "utf8")).not.toContain("sensitiveValue");
});

it.each([true, undefined])(
  "refuses script identities without explicit hasSourceURL: false (%s)",
  async (hasSourceURL) => {
    const send = native.send.getMockImplementation()!;
    native.send.mockImplementation(async (method: string) => {
      if (method === "Debugger.enable") {
        native.parsed({
          scriptId: "1",
          url: `${origin}/src/app-routes.ts?token=private#secret`,
          hasSourceURL,
        });
        return {};
      }
      return send(method);
    });
    const result = await capture();
    expect(result.currentWindow.profile.nodes[1]!.callFrame).toMatchObject({
      functionName: "[redacted]",
      url: "",
    });
    expect(result.currentWindow.profile.samples).toEqual([2, 2]);
  },
);

it("redacts a frame whose URL differs from its admitted script identity", async () => {
  const send = native.send.getMockImplementation()!;
  native.send.mockImplementation(async (method: string) => {
    if (method === "Profiler.stop") {
      stopped++;
      return { profile: profile(`${origin}/src/app-routes.ts?different=private`) };
    }
    return send(method);
  });
  const result = await capture();
  expect(result.currentWindow.profile.nodes[1]!.callFrame).toMatchObject({
    functionName: "[redacted]",
    url: "",
  });
  expect(result.currentWindow.profile.samples).toEqual([2, 2]);
});

it("bounds admitted scripts and produces no artifact on an inventory overflow", async () => {
  const send = native.send.getMockImplementation()!;
  native.send.mockImplementation(async (method: string) => {
    if (method === "Debugger.enable") {
      for (let id = 1; id <= 16_385; id++) {
        native.parsed({
          scriptId: String(id),
          url: `${origin}/src/app-routes.ts`,
          hasSourceURL: false,
        });
      }
      return {};
    }
    return send(method);
  });
  await expect(capture()).rejects.toThrow("inventory exceeded");
  expect(native.close).toHaveBeenCalled();
  expect(native.detach).toHaveBeenCalledOnce();
  await expect(fs.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
});
