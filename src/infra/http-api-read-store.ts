import { createHash } from "node:crypto";
import { racePromiseWithAbortSignal } from "./abort-signal.js";
import { readResponseWithLimit } from "./http-response-body.js";

export type ApiStoreChange = {
  key: string;
  url: string;
  value: unknown;
  observation: number;
  changed: boolean;
  invalidated?: true;
};
export type ApiStoreReadOptions = {
  signal?: AbortSignal;
  refresh?: boolean;
  freshnessMs?: number;
  maxBodyBytes?: number;
  authorize?: (redirect?: URL) => Promise<void>;
  assertCurrent?: () => void;
};
type Reader = Pick<ApiStoreReadOptions, "signal" | "authorize" | "assertCurrent"> & {
  approvedRedirects: Set<string>;
};
type StoredResponse = {
  observation: number;
  body: Uint8Array;
  status: number;
  statusText: string;
  headers: [string, string][];
  url: string;
  redirects: string[];
};
type Entry = {
  controller: AbortController;
  readers: Set<Reader>;
  promise: Promise<StoredResponse>;
  settled: boolean;
  storedAt: number;
  invalidated: boolean;
  version: number;
  observation: number;
  refresh: boolean;
  value?: StoredResponse;
};
const MAX_ENTRIES = 256;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

function isFresh(entry: Entry, freshnessMs = 30_000): boolean {
  const now = Date.now();
  return !entry.invalidated && entry.storedAt <= now && now - entry.storedAt < freshnessMs;
}

/** Request identity excludes transport headers; the containing owner pins host and credential. */
export function apiStoreRequestKey(url: string, method = "GET", body?: string): string {
  const parsed = new URL(url);
  parsed.hash = "";
  parsed.searchParams.sort();
  return JSON.stringify([
    method.toUpperCase(),
    parsed.href,
    body === undefined ? "" : createHash("sha256").update(body).digest("hex"),
  ]);
}

function requestUrl(key: string): string {
  const request: unknown = JSON.parse(key);
  if (!Array.isArray(request) || typeof request[1] !== "string") {
    throw new Error("Invalid API store request key");
  }
  return request[1];
}

/** Shared upstream facts only. Caller authority is checked at admission and every delivery. */
export class ApiResponseStore {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(change: ApiStoreChange) => void>();
  private readonly delivered = new WeakMap<Response, number>();
  private version = 0;
  private observation = 0;

  beginObservation(): number {
    return ++this.observation;
  }

  revision(key: string): number {
    return this.entries.get(key)?.version ?? 0;
  }

  observationOf(response: Response): number {
    return this.delivered.get(response) ?? 0;
  }

  latestObservation(key: string): number {
    return this.entries.get(key)?.value?.observation ?? 0;
  }

  subscribe(listener: (change: ApiStoreChange) => void, replay = false): () => void {
    this.listeners.add(listener);
    if (replay) {
      for (const [key, entry] of this.entries) {
        if (entry.value && entry.value.status >= 200 && entry.value.status < 300) {
          this.publish(key, entry.value, entry.observation, true, [listener]);
        }
      }
    }
    return () => this.listeners.delete(listener);
  }

  async read(
    key: string,
    load: (
      signal: AbortSignal,
      authorize: (redirect?: URL) => Promise<void>,
      assertCurrent: () => void,
    ) => Promise<Response>,
    options: ApiStoreReadOptions = {},
  ): Promise<Response> {
    options.signal?.throwIfAborted();
    await options.authorize?.();
    options.signal?.throwIfAborted();
    options.assertCurrent?.();
    let entry = this.entries.get(key);
    if (options.refresh && entry && !entry.settled && !entry.refresh) {
      // Explicit refresh advances the observation without waiting for potentially hung old work.
      // The replaced entry may finish its readers, but can no longer publish shared facts.
      entry = undefined;
    }
    // Concurrent forced reads join the same observation. A settled forced read starts a new one.
    if (
      entry?.controller.signal.aborted ||
      (entry?.settled && (options.refresh || !isFresh(entry, options.freshnessMs)))
    ) {
      entry = undefined;
    }
    const reader: Reader = {
      signal: options.signal,
      authorize: options.authorize,
      assertCurrent: options.assertCurrent,
      approvedRedirects: new Set(),
    };
    if (!entry) {
      const previous = this.entries.get(key);
      const controller = new AbortController();
      const readers = new Set<Reader>();
      entry = {
        controller,
        readers,
        settled: false,
        storedAt: 0,
        invalidated: false,
        version: previous?.version ?? 0,
        observation: this.beginObservation(),
        refresh: options.refresh === true,
        promise: Promise.resolve({
          observation: 0,
          body: new Uint8Array(),
          status: 204,
          statusText: "",
          headers: [],
          url: "",
          redirects: [],
        }),
      };
      const current = entry;
      const redirects: string[] = [];
      let admitted = new Set<Reader>();
      const assertReaders = () => {
        controller.signal.throwIfAborted();
        let failure: unknown = new Error("API read has no current reader");
        for (const candidate of admitted) {
          if (!readers.has(candidate)) {
            continue;
          }
          try {
            candidate.signal?.throwIfAborted();
            candidate.assertCurrent?.();
            return;
          } catch (error) {
            failure = error;
          }
        }
        throw failure;
      };
      const authorize = async (redirect?: URL) => {
        controller.signal.throwIfAborted();
        admitted = new Set();
        let failure: unknown = new Error("API read has no current reader");
        for (const candidate of readers) {
          try {
            candidate.signal?.throwIfAborted();
            await candidate.authorize?.(redirect);
            candidate.signal?.throwIfAborted();
            candidate.assertCurrent?.();
            admitted.add(candidate);
            if (redirect) {
              candidate.approvedRedirects.add(redirect.href);
            }
          } catch (error) {
            failure = error;
          }
        }
        if (!admitted.size) {
          throw failure;
        }
        if (redirect) {
          redirects.push(redirect.href);
        }
      };
      // Install pending ownership before the loader can dispatch or a second reader can join.
      this.entries.set(key, current);
      current.promise = Promise.resolve()
        .then(async () => {
          const response = await load(controller.signal, authorize, assertReaders);
          let body: Uint8Array;
          try {
            body = new Uint8Array(
              await readResponseWithLimit(response, options.maxBodyBytes ?? 4 * 1024 * 1024, {
                signal: controller.signal,
              }),
            );
          } finally {
            await response.body?.cancel().catch(() => {});
          }
          controller.signal.throwIfAborted();
          const stored: StoredResponse = {
            observation: current.observation,
            body,
            status: response.status,
            statusText: response.statusText,
            headers: [...response.headers],
            url: response.url,
            redirects,
          };
          current.settled = true;
          current.storedAt = Date.now();
          current.value = stored;
          current.invalidated = !response.ok;
          if (this.entries.get(key) === current && response.ok) {
            const old = previous?.value;
            const changed = !old || !Buffer.from(old.body).equals(body);
            if (changed) {
              current.version = ++this.version;
            }
            this.publish(key, stored, current.observation, changed);
          }
          return stored;
        })
        .catch((error: unknown) => {
          if (this.entries.get(key) === current) {
            this.entries.delete(key);
          }
          throw error;
        });
      this.prune();
    }
    entry.readers.add(reader);
    const pending = entry;
    const release = () => {
      pending.readers.delete(reader);
      if (!pending.settled && pending.readers.size === 0) {
        pending.controller.abort(new Error("API read retired"));
        if (this.entries.get(key) === pending) {
          this.entries.delete(key);
        }
      }
    };
    options.signal?.addEventListener("abort", release, { once: true });
    try {
      let stored = await racePromiseWithAbortSignal(pending.promise, options.signal);
      const current = this.entries.get(key);
      if (current?.value && current.observation > pending.observation) {
        stored = current.value;
      }
      // A follower must independently approve redirects, even when it joined after dispatch.
      for (const redirect of stored.redirects) {
        if (!reader.approvedRedirects.has(redirect)) {
          await options.authorize?.(new URL(redirect));
        }
      }
      await options.authorize?.();
      options.signal?.throwIfAborted();
      options.assertCurrent?.();
      return this.response(stored);
    } finally {
      options.signal?.removeEventListener("abort", release);
      release();
      this.prune();
    }
  }

  /** CLI/worker adapters feed successful observations through the same write and notification seam. */
  async remember(
    key: string,
    response: Response,
    observation = this.beginObservation(),
  ): Promise<void> {
    const controller = new AbortController();
    const stored: StoredResponse = {
      observation,
      body: new Uint8Array(await readResponseWithLimit(response, 4 * 1024 * 1024)),
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers],
      url: response.url,
      redirects: [],
    };
    if (!response.ok) {
      return;
    }
    const previous = this.entries.get(key);
    if (previous && previous.observation > observation) {
      return;
    }
    const old = previous?.value;
    const entry: Entry = {
      controller,
      readers: new Set(),
      promise: Promise.resolve(stored),
      settled: true,
      storedAt: Date.now(),
      invalidated: false,
      version: previous?.version ?? 0,
      observation,
      refresh: false,
      value: stored,
    };
    this.entries.set(key, entry);
    const changed = !old || !Buffer.from(old.body).equals(stored.body);
    if (changed) {
      entry.version = ++this.version;
    }
    this.publish(key, stored, observation, changed);
    this.prune();
  }

  /** Synchronous CLI readers cannot await pending HTTP work; fail closed rather than duplicate it. */
  readBuffered(
    key: string,
    load: () => { body: Uint8Array; response: Response },
    options: { refresh?: boolean; freshnessMs?: number; maxBodyBytes?: number } = {},
  ): { body: Uint8Array; response: Response } {
    const previous = this.entries.get(key);
    if (previous && !previous.settled) {
      throw new Error("API read is already in progress; retry after it finishes");
    }
    if (previous?.value && !options.refresh && isFresh(previous, options.freshnessMs)) {
      return { body: previous.value.body.slice(), response: this.response(previous.value) };
    }
    const observation = this.beginObservation();
    const result = load();
    if (!result.response.ok) {
      return result;
    }
    if (result.body.byteLength > (options.maxBodyBytes ?? 4 * 1024 * 1024)) {
      throw new Error("API response exceeded the size limit");
    }
    const stored: StoredResponse = {
      observation,
      body: result.body.slice(),
      status: result.response.status,
      statusText: result.response.statusText,
      headers: [...result.response.headers],
      url: result.response.url,
      redirects: [],
    };
    const changed = !previous?.value || !Buffer.from(previous.value.body).equals(stored.body);
    this.entries.set(key, {
      controller: new AbortController(),
      readers: new Set(),
      promise: Promise.resolve(stored),
      settled: true,
      storedAt: Date.now(),
      invalidated: false,
      version: changed ? ++this.version : (previous?.version ?? 0),
      observation,
      refresh: false,
      value: stored,
    });
    this.publish(key, stored, observation, changed);
    this.prune();
    return { body: stored.body.slice(), response: this.response(stored) };
  }

  invalidate(predicate: (key: string, url: string) => boolean): void {
    for (const [key, entry] of this.entries) {
      const url = requestUrl(key);
      if (predicate(key, url)) {
        entry.invalidated = true;
        entry.version = ++this.version;
        // A mutation retires pre-mutation work as well as settled facts.
        if (!entry.settled) {
          this.entries.delete(key);
          entry.controller.abort(new Error("API facts invalidated"));
        }
        for (const listener of this.listeners) {
          listener({
            key,
            url,
            value: undefined,
            observation: this.beginObservation(),
            changed: true,
            invalidated: true,
          });
        }
      }
    }
  }

  close(): void {
    for (const entry of this.entries.values()) {
      entry.controller.abort(new Error("API store closed"));
    }
    this.entries.clear();
    this.listeners.clear();
  }

  private response(value: StoredResponse): Response {
    const response = new Response(
      [204, 205, 304].includes(value.status) ? null : value.body.slice(),
      {
        status: value.status,
        statusText: value.statusText,
        headers: value.headers,
      },
    );
    Object.defineProperty(response, "url", { value: value.url });
    this.delivered.set(response, value.observation);
    return response;
  }

  private publish(
    key: string,
    response: StoredResponse,
    observation: number,
    changed: boolean,
    listeners: Iterable<(change: ApiStoreChange) => void> = this.listeners,
  ): void {
    let value: unknown;
    try {
      value = JSON.parse(Buffer.from(response.body).toString("utf8"));
    } catch {
      return;
    }
    const url = requestUrl(key);
    for (const listener of listeners) {
      listener({ key, url, value: structuredClone(value), observation, changed });
    }
  }

  private prune(): void {
    let bytes = [...this.entries.values()].reduce(
      (sum, entry) => sum + (entry.value?.body.byteLength ?? 0),
      0,
    );
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= MAX_ENTRIES && bytes <= MAX_BODY_BYTES) {
        return;
      }
      if (entry.settled && entry.readers.size === 0) {
        this.entries.delete(key);
        bytes -= entry.value?.body.byteLength ?? 0;
      }
    }
  }
}
