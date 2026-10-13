import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { ApiRequestStore, getSharedApiStore } from "./http-api-quota.js";
import { apiStoreRequestKey } from "./http-api-read-store.js";

afterEach(() => vi.useRealTimers());
const key = apiStoreRequestKey("https://api.github.com/repos/owner/repo/pulls/1");
const json = (body: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe("API store admission and delivery", () => {
  it("bounds credential scope admission without retiring held readers or their cooldown", async () => {
    vi.useFakeTimers();
    await drainGlobalSingletonLifecycleState();
    const fetchImpl = vi.fn<typeof fetch>();
    const scope = (token: string) =>
      getSharedApiStore({
        apiBaseUrl: "https://api.github.com",
        token,
        fetchImpl,
      });
    const first = scope("synthetic-retained");
    const started = createDeferred();
    const release = createDeferred();
    const load = vi.fn(async () => {
      started.resolve();
      await release.promise;
      return json({ title: "Shared" });
    });
    const pending = first.responses.read(key, () => first.dispatch("core", load));
    await started.promise;
    first.observe(json({}, 429, { "Retry-After": "120" }));
    const held = [first];
    try {
      for (let i = 1; i < 1_024; i++) {
        held.push(scope(`synthetic-rotation-${i}`));
      }
      expect(() => scope("synthetic-overflow")).toThrow("API request quota unavailable");
      expect(scope("synthetic-retained")).toBe(first);
      const joined = scope("synthetic-retained").responses.read(key, load);
      await expect(first.dispatch("search", load)).rejects.toMatchObject({ retryAfterMs: 120_000 });
      await expect(
        scope("synthetic-rotation-1").dispatch("core", async () => json({})),
      ).resolves.toBeInstanceOf(Response);
      release.resolve();
      expect(await (await pending).json()).toEqual({ title: "Shared" });
      expect(await (await joined).json()).toEqual({ title: "Shared" });
      expect(load).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(120_000);
      await expect(
        scope("synthetic-retained").dispatch("core", async () => json({})),
      ).resolves.toBeInstanceOf(Response);
    } finally {
      release.resolve();
      await pending;
      for (const store of held) {
        store.responses.close();
      }
      await drainGlobalSingletonLifecycleState();
    }
  });

  it.each(["async", "buffered"] as const)(
    "honors the requesting reader's maximum age for %s reads",
    async (mode) => {
      vi.useFakeTimers();
      const store = new ApiRequestStore();
      let title = "Original";
      const transport = vi.fn(() => json({ title }));
      const read = async (freshnessMs: number) => {
        if (mode === "async") {
          return (await store.responses.read(key, async () => transport(), { freshnessMs })).json();
        }
        return store.responses
          .readBuffered(
            key,
            () => ({ body: Buffer.from(JSON.stringify({ title })), response: transport() }),
            { freshnessMs },
          )
          .response.json();
      };
      expect(await read(30_000)).toEqual({ title: "Original" });
      title = "Updated";
      vi.advanceTimersByTime(1_001);
      expect(await read(5_000)).toEqual({ title: "Original" });
      expect(await read(1_000)).toEqual({ title: "Updated" });
      vi.advanceTimersByTime(2_000);
      expect(await read(5_000)).toEqual({ title: "Updated" });
      title = "Fresh admission";
      expect(await read(0)).toEqual({ title: "Fresh admission" });
      expect(transport).toHaveBeenCalledTimes(3);
      store.responses.close();
    },
  );

  it("starts an explicit refresh without letting older pending work overwrite it", async () => {
    const store = new ApiRequestStore();
    const started = createDeferred();
    const release = createDeferred();
    const old = store.responses.read(key, async () => {
      started.resolve();
      await release.promise;
      return json({ title: "Old" });
    });
    await started.promise;
    const refreshed = await store.responses.read(key, async () => json({ title: "New" }), {
      refresh: true,
    });
    expect(await refreshed.json()).toEqual({ title: "New" });
    release.resolve();
    await old;
    expect(await (await store.responses.read(key, vi.fn())).json()).toEqual({ title: "New" });
    store.responses.close();
  });
  it("invalidates pending pre-mutation work and keeps a newer CLI observation", async () => {
    const store = new ApiRequestStore();
    const started = createDeferred();
    const release = createDeferred();
    const oldObservation = store.responses.beginObservation();
    const read = store.responses.read(key, async () => {
      started.resolve();
      await release.promise;
      return json({ title: "Before mutation" });
    });
    await started.promise;
    store.responses.invalidate((target) => target === key);
    await store.responses.remember(key, json({ title: "After mutation" }));
    release.resolve();
    await expect(read).rejects.toThrow("API facts invalidated");
    await store.responses.remember(key, json({ title: "Late old observation" }), oldObservation);
    expect(
      await (await store.responses.read(key, async () => json({ title: "Unexpected" }))).json(),
    ).toEqual({ title: "After mutation" });
    store.responses.close();
  });
  it("coalesces independent readers and cancellation retires only the departing reader", async () => {
    const store = new ApiRequestStore();
    const started = createDeferred();
    const release = createDeferred();
    const cancelled = new AbortController();
    let selected = true;
    const transport = vi.fn(async (signal: AbortSignal) => {
      started.resolve();
      await release.promise;
      expect(signal.aborted).toBe(false);
      return json({ title: "Current" });
    });
    const first = store.responses.read(
      key,
      (signal) => store.dispatch("core", () => transport(signal)),
      { signal: cancelled.signal },
    );
    const second = store.responses.read(
      key,
      (signal) => store.dispatch("core", () => transport(signal)),
      {
        authorize: async () => {
          if (!selected) {
            throw new Error("Grant retired");
          }
        },
      },
    );
    await started.promise;
    cancelled.abort(new Error("Reader retired"));
    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    release.resolve();
    expect(await (await second).json()).toEqual({ title: "Current" });
    selected = false;
    await expect(
      store.responses.read(key, () => Promise.reject(new Error("Unexpected dispatch")), {
        authorize: async () => {
          throw new Error("Grant retired");
        },
      }),
    ).rejects.toThrow("Grant retired");
    expect(transport).toHaveBeenCalledOnce();
    store.responses.close();
  });

  it("one secondary response closes every dispatch until Retry-After, while proven cached data remains readable", async () => {
    vi.useFakeTimers();
    const store = new ApiRequestStore();
    const cached = await store.responses.read(key, () =>
      store.dispatch("core", async () => json({ title: "Known" })),
    );
    expect(await cached.json()).toEqual({ title: "Known" });
    const transport = vi.fn(async () =>
      json({ message: "You have exceeded a secondary rate limit" }, 403, { "Retry-After": "120" }),
    );
    await expect(
      store.responses.read(apiStoreRequestKey("https://api.github.com/search/issues"), () =>
        store.dispatch("search", transport),
      ),
    ).rejects.toMatchObject({ reason: "upstream" });
    await expect(store.dispatch("graphql", transport)).rejects.toMatchObject({
      reason: "upstream",
    });
    expect(await (await store.responses.read(key, transport)).json()).toEqual({ title: "Known" });
    expect(transport).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(120_000);
    const resumed = vi.fn(async () => json({ title: "Recovered" }));
    await store.responses.read(key, () => store.dispatch("core", resumed), { refresh: true });
    expect(resumed).toHaveBeenCalledOnce();
    store.responses.close();
  });
});
