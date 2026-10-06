import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { ApiRequestStore } from "./http-api-quota.js";
import { apiStoreRequestKey } from "./http-api-read-store.js";

afterEach(() => vi.useRealTimers());
const key = apiStoreRequestKey("https://api.github.com/repos/owner/repo/pulls/1");
const json = (body: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe("API store admission and delivery", () => {
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
