import { MessageChannel } from "node:worker_threads";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { apiStoreRequestKey, getSharedApiStore } from "openclaw/plugin-sdk/retry-runtime";
import { afterEach, expect, it, vi } from "vitest";
import { parseTeamReportsConfig } from "./config.js";
import { completion } from "./reports.fixtures.js";
import { TeamReportsRunner } from "./run-worker.js";
import { TeamReportsStore } from "./store.js";

const workerExit = vi.hoisted(() => ({ notify: () => {} }));
vi.mock("node:worker_threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:worker_threads")>();
  return {
    ...actual,
    Worker: class extends actual.Worker {
      constructor(...args: ConstructorParameters<typeof actual.Worker>) {
        super(...args);
        this.once("exit", () => workerExit.notify());
      }
    },
  };
});
afterEach(() => {
  workerExit.notify = () => {};
  vi.restoreAllMocks();
});

it("shares an upstream cooldown with the host across the native report worker", async () => {
  const apiBaseUrl = "https://quota-worker.example.test";
  const token = "synthetic-worker-quota-token";
  const fetchImpl = vi.fn(async () => {
    throw new Error("Unexpected API dispatch");
  });
  const quota = getSharedApiStore({ apiBaseUrl, token, fetchImpl });
  const blocked = quota.observe(
    new Response(null, { status: 429, headers: { "retry-after": "90" } }),
  );
  const config = parseTeamReportsConfig({ github: { token, apiBaseUrl, orgs: ["quota-fixture"] } });
  const runner = new TeamReportsRunner(new URL("./run-worker.test-support.ts", import.meta.url));
  const store = new TeamReportsStore({
    async execute() {
      throw new Error("No storage in quota fixture");
    },
    async close() {},
  });
  try {
    const result = await runner.run({
      config,
      resolved: {
        github: { ...config.github, token, ignoreCommentPatterns: [] },
        people: [],
      },
      periods: [],
      store,
      runtime: {
        logger: { info() {}, warn() {}, error() {} },
        signal: new AbortController().signal,
        fetchImpl,
      },
      onRoster() {},
      llm: {
        complete: async () => {
          throw new Error("No model calls in quota fixture");
        },
      },
    });
    expect(result.github).toMatchObject({ ok: false, stats: { retryAt: blocked?.retryAtMs } });
    expect(fetchImpl).not.toHaveBeenCalled();
  } finally {
    await runner.close();
  }
});

it("native worker reads publish host facts and reuse the same cached observation", async () => {
  const apiBaseUrl = "https://store-worker.example.test";
  const token = "synthetic-worker-store-token";
  const fact = { number: 23, head: { sha: "a".repeat(40) } };
  const fetchImpl = vi.fn(async () => Response.json(fact));
  const owner = getSharedApiStore({ apiBaseUrl, token, fetchImpl });
  const changed = vi.fn();
  const unsubscribe = owner.responses.subscribe(changed);
  const config = parseTeamReportsConfig({ github: { token, apiBaseUrl, orgs: ["store-fixture"] } });
  const runner = new TeamReportsRunner(new URL("./run-worker.test-support.ts", import.meta.url));
  const store = new TeamReportsStore({
    async execute() {
      throw new Error("No storage in response fixture");
    },
    async close() {},
  });
  const params = {
    config,
    resolved: { github: { ...config.github, token, ignoreCommentPatterns: [] }, people: [] },
    periods: [],
    store,
    runtime: {
      logger: { info() {}, warn() {}, error() {} },
      fetchImpl,
      signal: new AbortController().signal,
    },
    onRoster() {},
    llm: {
      complete: async () => {
        throw new Error("No model in response fixture");
      },
    },
  };
  try {
    const first = await runner.run(params);
    expect(first.github).toMatchObject({
      ok: true,
      stats: { apiCalls: 1, headSha: fact.head.sha },
    });
    expect(changed).toHaveBeenCalledOnce();
    expect(changed.mock.calls[0]?.[0]).toMatchObject({ value: fact, changed: true });
    const key = apiStoreRequestKey(`${apiBaseUrl}/repos/example/app/pulls/23`);
    const response = await owner.responses.read(key, async () => {
      throw new Error("Cached worker facts must serve host readers");
    });
    expect(await response.json()).toEqual(fact);
    const second = await runner.run(params);
    expect(second.github).toMatchObject({
      ok: true,
      stats: { apiCalls: 0, headSha: fact.head.sha },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  } finally {
    unsubscribe();
    await runner.close();
  }
});

it("joins an accepted host completion after the report worker has exited", async () => {
  const entered = createDeferred<void>();
  const cancelled = createDeferred<void>();
  const released = createDeferred<void>();
  const exited = createDeferred<void>();
  workerExit.notify = () => exited.resolve();
  const runner = new TeamReportsRunner(new URL("./run-worker.test-support.ts", import.meta.url));
  const controller = new AbortController();
  const config = parseTeamReportsConfig({ github: { token: "fixture", orgs: ["sample"] } });
  const store = new TeamReportsStore({
    async execute() {
      throw new Error("This completion-only fixture must not access storage");
    },
    async close() {},
  });
  let runSettled = false;
  let closeSettled = false;
  const pending = runner
    .run({
      config,
      resolved: {
        github: { ...config.github, token: "fixture", ignoreCommentPatterns: [] },
        people: [],
      },
      store,
      periods: [],
      runtime: { signal: controller.signal, logger: { info() {}, warn() {}, error() {} } },
      onRoster() {},
      llm: {
        complete: async ({ signal }) => {
          signal?.addEventListener("abort", () => cancelled.resolve(), { once: true });
          entered.resolve();
          await released.promise;
          return completion("Late result");
        },
      },
    })
    .finally(() => {
      runSettled = true;
    });
  const rejected = expect(pending).rejects.toThrow("Report cancelled");
  try {
    await entered.promise;
    controller.abort(new Error("Report cancelled"));
    const closing = runner.close().then(() => {
      closeSettled = true;
    });
    await Promise.all([cancelled.promise, exited.promise]);
    // Let native-exit cleanup drain through one message turn, without a timer or polling.
    await new Promise<void>((resolve) => {
      const { port1, port2 } = new MessageChannel();
      port1.once("message", () => {
        port1.close();
        port2.close();
        resolve();
      });
      port2.postMessage(null);
    });
    expect(runSettled).toBe(false);
    expect(closeSettled).toBe(false);
    released.resolve();
    await Promise.all([rejected, closing]);
    expect(runSettled).toBe(true);
    expect(closeSettled).toBe(true);
  } finally {
    released.resolve();
    await runner.close();
  }
});
