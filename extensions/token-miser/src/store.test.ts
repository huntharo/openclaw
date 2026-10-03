import type {
  PluginBlobEntry,
  PluginBlobStore,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTokenMiserStore,
  type TokenMiserAcceptance,
  type TokenMiserAuthority,
  type TokenMiserCapture,
  type TokenMiserFullResult,
  type TokenMiserMetadata,
  type TokenMiserRetrievalResult,
} from "./store.js";

const scope = { agentId: "agent-a", sessionId: "session-a", sessionKey: "agent:agent-a:main" };
const authority: TokenMiserAuthority = { allowPersistence: true, assertCurrent() {} };

function fixture() {
  const entries = new Map<string, PluginBlobEntry<TokenMiserMetadata>>();
  const markers = new Map<string, TokenMiserAcceptance>();
  const acceptanceStore: PluginStateKeyedStore<TokenMiserAcceptance> = {
    async register(key, value, opts) {
      opts?.assertCurrent?.();
      markers.set(key, structuredClone(value));
    },
    async registerIfAbsent(key, value) {
      if (markers.has(key)) {
        return false;
      }
      markers.set(key, structuredClone(value));
      return true;
    },
    async lookup(key) {
      return markers.get(key);
    },
    async consume(key) {
      const value = markers.get(key);
      markers.delete(key);
      return value;
    },
    async delete(key, opts) {
      opts?.assertCurrent?.();
      return markers.delete(key);
    },
    async entries() {
      return [...markers].map(([key, value]) => ({ key, value, createdAt: 0 }));
    },
    async clear() {
      markers.clear();
    },
  };
  const blobStore: PluginBlobStore<TokenMiserMetadata> = {
    async register(key, bytes, metadata, opts) {
      entries.set(key, {
        key,
        bytes: Uint8Array.from(bytes),
        metadata: structuredClone(metadata),
        sizeBytes: bytes.byteLength,
        createdAt: Date.now(),
        expiresAt: opts?.ttlMs === undefined ? undefined : Date.now() + opts.ttlMs,
      });
    },
    async registerIfAbsent(key, bytes, metadata, opts) {
      if (entries.has(key)) {
        return false;
      }
      await blobStore.register(key, bytes, metadata, opts);
      return true;
    },
    async lookup(key) {
      return entries.get(key);
    },
    async entries() {
      return [...entries.values()];
    },
    async delete(key) {
      return entries.delete(key);
    },
    async deleteExpiredKey() {
      return undefined;
    },
    async deleteExpired() {
      return [];
    },
    async clear() {
      entries.clear();
    },
  };
  const store = createTokenMiserStore({
    blobStore,
    acceptanceStore,
    retentionHours: 168,
    maxEntryBytes: 32 * 1024 * 1024,
    maxResponseBytes: 1024,
  });
  const capture: TokenMiserCapture = {
    scope,
    runtime: "openclaw",
    runId: "run-a",
    turnId: "turn-a",
    toolCallId: "call-a",
    toolName: "exec",
    content: [{ type: "text", text: "first\nmatch α\nthird\nmatch 🦀\nfifth" }],
  };
  return { entries, markers, blobStore, acceptanceStore, store, capture };
}

async function accepted(f: ReturnType<typeof fixture>, capture = f.capture) {
  const reference = await f.store.stage(capture, authority);
  if (!reference) {
    throw new Error("Expected a retained reference");
  }
  expect(await f.store.commit(reference.id, scope, authority)).toBe(true);
  f.store.release(reference.id);
  return reference;
}

function full(result: TokenMiserRetrievalResult): TokenMiserFullResult {
  if (result.mode !== "full") {
    throw new Error("Expected full retrieval");
  }
  return result;
}

afterEach(() => vi.useRealTimers());

describe("Token Miser original retention", () => {
  it("publishes accepted records and retrieves the exact original JSON across arbitrary byte chunks", async () => {
    const f = fixture();
    f.capture.content = [
      { type: "text", text: '引🦀\\\n"\ud800' + "日志α\n".repeat(100) },
      { type: "text", text: '{"escaped":"\\n","last":true}' },
    ];
    const reference = await f.store.stage(f.capture, authority);
    expect(reference).toBeDefined();
    if (!reference) {
      throw new Error("Expected staged result");
    }
    await expect(
      f.store.retrieve({ id: reference.id, mode: "full" }, scope, authority),
    ).rejects.toThrow("unavailable");
    expect(await f.store.commit(reference.id, scope, authority)).toBe(true);
    await expect(
      f.store.retrieve({ id: reference.id, mode: "full" }, scope, authority),
    ).rejects.toThrow("unavailable");
    f.store.release(reference.id);
    expect(f.markers.get(reference.id)?.expiresAt).toBe(reference.expiresAt);
    const chunks: Buffer[] = [];
    let offset = 0;
    for (;;) {
      const result = full(
        await f.store.retrieve(
          { id: reference.id, mode: "full", offsetBytes: offset, maxBytes: 7 },
          scope,
          authority,
        ),
      );
      chunks.push(Buffer.from(result.data, "base64"));
      expect(result.offsetBytes).toBe(offset);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(1024);
      if (result.nextOffsetBytes === undefined) {
        break;
      }
      offset = result.nextOffsetBytes;
    }
    const originalJson = JSON.stringify(f.capture.content);
    expect(Buffer.concat(chunks).equals(Buffer.from(originalJson))).toBe(true);
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual(f.capture.content);
    expect(reference.originalBytes).toBe(Buffer.byteLength(originalJson));
  });

  it("preserves the original deadline through delayed acceptance and rejects expired records", async () => {
    vi.setSystemTime(new Date("2026-10-02T00:00:00Z"));
    const f = fixture();
    const reference = await f.store.stage(f.capture, authority);
    if (!reference) {
      throw new Error("Expected staged result");
    }
    vi.setSystemTime(Date.now() + 60_000);
    expect(await f.store.commit(reference.id, scope, authority)).toBe(true);
    f.store.release(reference.id);
    expect(f.entries.get(reference.id)?.metadata.expiresAt).toBe(reference.expiresAt);
    vi.setSystemTime(reference.expiresAt);
    await expect(
      f.store.retrieve({ id: reference.id, mode: "full" }, scope, authority),
    ).rejects.toThrow("expired");
  });

  it("does not stage private sessions, oversized originals, or unavailable storage", async () => {
    const f = fixture();
    expect(
      await f.store.stage(f.capture, { ...authority, allowPersistence: false }),
    ).toBeUndefined();
    const small = createTokenMiserStore({
      blobStore: f.blobStore,
      acceptanceStore: f.acceptanceStore,
      retentionHours: 168,
      maxEntryBytes: 1024,
    });
    expect(
      await small.stage(
        { ...f.capture, content: [{ type: "text", text: "x".repeat(1024) }] },
        authority,
      ),
    ).toBeUndefined();
    f.blobStore.registerIfAbsent = async () => {
      throw new Error("capacity reached");
    };
    expect(await f.store.stage(f.capture, authority)).toBeUndefined();
    expect(f.entries.size).toBe(0);
  });

  it("fails acceptance closed without delivering a reference when its write fails", async () => {
    const f = fixture();
    const reference = await f.store.stage(f.capture, authority);
    if (!reference) {
      throw new Error("Expected staged result");
    }
    f.acceptanceStore.register = async () => {
      throw new Error("writer failed");
    };
    expect(await f.store.commit(reference.id, scope, authority)).toBe(false);
    await expect(
      f.store.retrieve({ id: reference.id, mode: "full" }, scope, authority),
    ).rejects.toThrow("unavailable");
    await f.store.discard(reference.id, scope, authority);
    expect(f.entries.size).toBe(0);
  });

  it("writes only a small acceptance marker after retaining the immutable original", async () => {
    const f = fixture();
    const reference = await f.store.stage(f.capture, authority);
    if (!reference) {
      throw new Error("Expected staged result");
    }
    const original = f.entries.get(reference.id)?.bytes;
    f.blobStore.register = async () => {
      throw new Error("original must not be rewritten");
    };
    f.blobStore.registerIfAbsent = async () => {
      throw new Error("original must not be inserted twice");
    };
    expect(await f.store.commit(reference.id, scope, authority)).toBe(true);
    expect(f.entries.get(reference.id)?.bytes).toEqual(original);
    expect(f.markers.get(reference.id)).toEqual({ scope, expiresAt: reference.expiresAt });
  });

  it("serializes acceptance and rolls back a marker when authority is revoked after its write", async () => {
    const f = fixture();
    const reference = await f.store.stage(f.capture, authority);
    if (!reference) {
      throw new Error("Expected staged result");
    }
    let current = true;
    const guarded: TokenMiserAuthority = {
      allowPersistence: true,
      assertCurrent() {
        if (!current) {
          throw new Error("revoked");
        }
      },
    };
    const register = f.acceptanceStore.register.bind(f.acceptanceStore);
    let writes = 0;
    f.acceptanceStore.register = async (...args) => {
      writes++;
      await register(...args);
      current = false;
    };
    const outcomes = await Promise.allSettled([
      f.store.commit(reference.id, scope, guarded),
      f.store.commit(reference.id, scope, guarded),
    ]);
    expect(outcomes[0]).toEqual({ status: "fulfilled", value: false });
    expect(outcomes[1].status).toBe("rejected");
    expect(writes).toBe(1);
    expect(f.markers.size).toBe(0);
    await expect(
      f.store.retrieve({ id: reference.id, mode: "full" }, scope, authority),
    ).rejects.toThrow("unavailable");
    await f.store.close();
    expect(f.entries.size).toBe(0);
  });

  it("keeps acceptance reversible until final release and counts only released scoped originals", async () => {
    const f = fixture();
    const kept = await accepted(f);
    const pending = await f.store.stage(f.capture, authority);
    if (!pending) {
      throw new Error("Expected staged result");
    }
    expect(await f.store.commit(pending.id, scope, authority)).toBe(true);
    expect(await f.store.acceptedCount(scope, authority)).toBe(1);
    await f.store.discard(pending.id, scope, authority);
    expect(f.markers.has(pending.id)).toBe(false);
    expect(f.entries.has(pending.id)).toBe(false);
    expect(await f.store.acceptedCount({ ...scope, sessionId: "other" }, authority)).toBe(0);
    await f.store.close();
    expect(f.markers.has(kept.id)).toBe(true);
    expect(f.entries.has(kept.id)).toBe(true);
  });

  it("rolls back owned unpublished acceptance after session authority is revoked", async () => {
    const f = fixture();
    const kept = await accepted(f);
    let current = true;
    const guarded: TokenMiserAuthority = {
      allowPersistence: true,
      assertCurrent() {
        if (!current) {
          throw new Error("revoked");
        }
      },
    };
    const reference = await f.store.stage(f.capture, guarded);
    if (!reference) {
      throw new Error("Expected staged result");
    }
    expect(await f.store.commit(reference.id, scope, guarded)).toBe(true);
    await expect(
      f.store.discard(reference.id, { ...scope, sessionId: "wrong-session" }, guarded),
    ).rejects.toThrow("unavailable");
    current = false;
    await expect(
      f.store.retrieve({ id: reference.id, mode: "full" }, scope, guarded),
    ).rejects.toThrow("revoked");
    await expect(
      Promise.all([
        f.store.discard(reference.id, scope, guarded),
        f.store.discard(reference.id, scope, guarded),
      ]),
    ).resolves.toEqual([undefined, undefined]);
    expect(f.markers.has(reference.id)).toBe(false);
    expect(f.entries.has(reference.id)).toBe(false);
    expect(f.markers.has(kept.id)).toBe(true);
    expect(f.entries.has(kept.id)).toBe(true);
    await expect(f.store.retrieve({ id: kept.id, mode: "full" }, scope, guarded)).rejects.toThrow(
      "revoked",
    );
    await f.store.close();
  });

  it("checks session identity and current authority after awaited reads", async () => {
    const f = fixture();
    const reference = await accepted(f);
    for (const other of [
      { ...scope, agentId: "agent-b" },
      { ...scope, sessionId: "session-b" },
      { ...scope, sessionKey: "other" },
    ]) {
      await expect(
        f.store.retrieve({ id: reference.id, mode: "full" }, other, authority),
      ).rejects.toThrow("unavailable");
    }
    let current = true;
    const originalLookup = f.blobStore.lookup.bind(f.blobStore);
    f.blobStore.lookup = async (id) => {
      const result = await originalLookup(id);
      current = false;
      return result;
    };
    await expect(
      f.store.retrieve({ id: reference.id, mode: "full" }, scope, {
        allowPersistence: true,
        assertCurrent() {
          if (!current) {
            throw new Error("revoked");
          }
        },
      }),
    ).rejects.toThrow("revoked");
  });

  it("returns attributable bounded line, literal-search, batch and group views", async () => {
    const f = fixture();
    const member = await accepted(f);
    const group = await accepted(f, { ...f.capture, memberIds: [member.id] });
    await expect(
      f.store.retrieve({ id: member.id, mode: "head", limit: 2 }, scope, authority),
    ).resolves.toMatchObject({
      lines: [
        { line: 1, text: "first" },
        { line: 2, text: "match α" },
      ],
      nextLine: 3,
    });
    await expect(
      f.store.retrieve({ id: member.id, mode: "tail", limit: 1 }, scope, authority),
    ).resolves.toMatchObject({ lines: [{ line: 5, text: "fifth" }] });
    await expect(
      f.store.retrieve(
        { id: member.id, mode: "lines", startLine: 2, endLine: 3 },
        scope,
        authority,
      ),
    ).resolves.toMatchObject({
      lines: [
        { line: 2, text: "match α" },
        { line: 3, text: "third" },
      ],
    });
    await expect(
      f.store.retrieve(
        { id: member.id, mode: "search", query: "match", limit: 1 },
        scope,
        authority,
      ),
    ).resolves.toMatchObject({ lines: [{ line: 2, text: "match α" }], nextLine: 4 });
    await expect(
      f.store.retrieve({ id: group.id, mode: "group", maxBytes: 10 }, scope, authority),
    ).resolves.toMatchObject({ memberIds: [member.id], mode: "group", nextOffsetBytes: 10 });
    await expect(
      f.store.retrieve(
        { ids: [group.id, member.id], mode: "batch", maxBytes: 10 },
        scope,
        authority,
      ),
    ).resolves.toMatchObject({ mode: "batch", results: [{ id: group.id }, { id: member.id }] });
    const separated = await accepted(f, {
      ...f.capture,
      content: [
        { type: "text", text: "first\r\n" },
        { type: "text", text: "match α\nmatch 🦀" },
        { type: "text", text: "" },
      ],
    });
    await expect(
      f.store.retrieve({ id: separated.id, mode: "head", limit: 2 }, scope, authority),
    ).resolves.toMatchObject({
      totalLines: 5,
      lines: [
        { line: 1, text: "first\r" },
        { line: 2, text: "" },
      ],
      nextLine: 3,
    });
    await expect(
      f.store.retrieve({ id: separated.id, mode: "tail", limit: 2 }, scope, authority),
    ).resolves.toMatchObject({
      totalLines: 5,
      lines: [
        { line: 4, text: "match 🦀" },
        { line: 5, text: "" },
      ],
    });
    await expect(
      f.store.retrieve(
        { id: separated.id, mode: "lines", startLine: 2, endLine: 3 },
        scope,
        authority,
      ),
    ).resolves.toMatchObject({
      lines: [
        { line: 2, text: "" },
        { line: 3, text: "match α" },
      ],
      nextLine: 4,
    });
    await expect(
      f.store.retrieve(
        { id: separated.id, mode: "search", query: "match", limit: 1 },
        scope,
        authority,
      ),
    ).resolves.toMatchObject({ lines: [{ line: 3, text: "match α" }], nextLine: 4 });
    await expect(
      f.store.retrieve({ id: separated.id, mode: "search", query: "α\nmatch" }, scope, authority),
    ).resolves.toMatchObject({ totalLines: 5, lines: [] });
    await expect(
      f.store.retrieve({ id: separated.id, mode: "lines", startLine: 6 }, scope, authority),
    ).rejects.toThrow("start line");
    await expect(
      f.store.retrieve(
        { id: separated.id, mode: "lines", startLine: 4, endLine: 6 },
        scope,
        authority,
      ),
    ).rejects.toThrow("end line");
    const many = await accepted(f, {
      ...f.capture,
      content: [{ type: "text", text: "match\n".repeat(100_000) }],
    });
    await expect(
      f.store.retrieve({ id: many.id, mode: "head", limit: 1 }, scope, authority),
    ).resolves.toMatchObject({
      totalLines: 100_001,
      lines: [{ line: 1, text: "match" }],
      nextLine: 2,
    });
    await expect(
      f.store.retrieve({ id: many.id, mode: "tail", limit: 1 }, scope, authority),
    ).resolves.toMatchObject({ totalLines: 100_001, lines: [{ line: 100_001, text: "" }] });
    await expect(
      f.store.retrieve(
        { id: many.id, mode: "search", query: "match", startLine: 99_999, limit: 1 },
        scope,
        authority,
      ),
    ).resolves.toMatchObject({
      totalLines: 100_001,
      lines: [{ line: 99_999, text: "match" }],
      nextLine: 100_000,
    });
    f.capture.content = [{ type: "text", text: "界".repeat(1000) }];
    const long = await accepted(f);
    await expect(f.store.retrieve({ id: long.id, mode: "head" }, scope, authority)).rejects.toThrow(
      "use full",
    );
    for (const text of ['"\\'.repeat(300), "\ud800".repeat(200)]) {
      const escaped = await accepted(f, { ...f.capture, content: [{ type: "text", text }] });
      await expect(
        f.store.retrieve({ id: escaped.id, mode: "head" }, scope, authority),
      ).rejects.toThrow("use full");
    }
  });

  it("joins pending capture on close and deletes only this instance's unaccepted rows", async () => {
    const f = fixture();
    const kept = await accepted(f);
    const second = createTokenMiserStore({
      blobStore: f.blobStore,
      acceptanceStore: f.acceptanceStore,
      retentionHours: 168,
      maxEntryBytes: 1024,
    });
    const other = await second.stage(f.capture, authority);
    const register = f.blobStore.registerIfAbsent.bind(f.blobStore);
    let release: () => void = () => {
      throw new Error("registration not started");
    };
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.blobStore.registerIfAbsent = async (...args) => {
      await held;
      return register(...args);
    };
    const pending = f.store.stage(f.capture, authority);
    await Promise.resolve();
    const closed = f.store.close();
    release();
    expect(await pending).toBeUndefined();
    await closed;
    expect(f.entries.size).toBe(2);
    expect(f.entries.has(kept.id)).toBe(true);
    expect(other && f.entries.has(other.id)).toBe(true);
    await expect(f.store.retrieve({ id: kept.id, mode: "full" }, scope, authority)).rejects.toThrow(
      "closed",
    );
    await second.close();
    expect(f.entries.size).toBe(1);
  });
});
