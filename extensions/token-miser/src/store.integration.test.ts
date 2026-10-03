import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createPluginBlobStoreForTests,
  createPluginStateKeyedStoreForTests,
  resetPluginBlobStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawStateDatabaseAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createTokenMiserStore,
  type TokenMiserAcceptance,
  type TokenMiserCapture,
  type TokenMiserMetadata,
  type TokenMiserStore,
} from "./store.js";

const scope = {
  agentId: "worker-proof",
  sessionId: "session-original",
  sessionKey: "agent:worker-proof:main",
};
const authority = { allowPersistence: true, assertCurrent() {} };
const stores = new Set<TokenMiserStore>();
let stateDir = "";
let env: NodeJS.ProcessEnv;

beforeAll(async () => {
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-token-miser-worker-"));
  env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(async () => {
  try {
    for (const store of stores) {
      await store.close();
    }
    await closeOpenClawStateDatabaseAsync();
    resetPluginBlobStoreForTests({ closeDatabase: false });
    resetPluginStateStoreForTests({ closeDatabase: false });
  } finally {
    if (stateDir) {
      await fs.rm(stateDir, { recursive: true, force: true });
    }
  }
});

function fixture(namespace: string, limits = { blobs: 10, markers: 10 }) {
  const blobStore = createPluginBlobStoreForTests<TokenMiserMetadata>(
    "token-miser",
    {
      namespace: `${namespace}.originals`,
      maxEntries: limits.blobs,
      maxBytesPerEntry: 32 * 1024 * 1024,
      maxBytesPerNamespace: 256 * 1024 * 1024,
      overflowPolicy: "reject-new",
    },
    env,
  );
  const acceptanceStore = createPluginStateKeyedStoreForTests<TokenMiserAcceptance>("token-miser", {
    namespace: `${namespace}.accepted`,
    maxEntries: limits.markers,
    overflowPolicy: "reject-new",
    env,
  });
  const store = createTokenMiserStore({
    blobStore,
    acceptanceStore,
    retentionHours: 168,
    maxEntryBytes: 32 * 1024 * 1024,
  });
  stores.add(store);
  const capture: TokenMiserCapture = {
    scope,
    runtime: "openclaw",
    runId: "original-run",
    turnId: "original-turn",
    toolCallId: "original-call",
    toolName: "exec",
    content: [{ type: "text", text: "first\nUnicode 🦀\nlast" }],
  };
  return { blobStore, acceptanceStore, store, capture };
}

async function stage(f: ReturnType<typeof fixture>, capture = f.capture) {
  const reference = await f.store.stage(capture, authority);
  if (!reference) {
    throw new Error("Expected an original retained by the worker");
  }
  return reference;
}

describe("Token Miser SQLite worker retention", () => {
  it("writes one immutable Unicode/JSON original, selects with a small marker, and retrieves exact pages after owner reopen", async () => {
    const f = fixture("round-trip");
    f.capture.content = [
      { type: "text", text: '引🦀\\\n"\ud800\n' + "日志🦀 α\n".repeat(8_000) },
      { type: "text", text: '{"nested":"{\\\"value\\\":true}","escaped":"\\n"}' },
    ];
    const originalJson = JSON.stringify(f.capture.content);
    const insert = vi.spyOn(f.blobStore, "registerIfAbsent");
    const rewrite = vi.spyOn(f.blobStore, "register");
    const markerWrite = vi.spyOn(f.acceptanceStore, "register");
    const reference = await stage(f);
    const before = await f.blobStore.lookup(reference.id);
    expect(Buffer.from(before?.bytes ?? []).equals(Buffer.from(originalJson))).toBe(true);
    expect(await f.store.commit(reference.id, scope, authority)).toBe(true);
    expect(await f.store.acceptedCount(scope, authority)).toBe(0);
    f.store.release(reference.id);
    const after = await f.blobStore.lookup(reference.id);
    expect(after?.bytes).toEqual(before?.bytes);
    expect(after?.createdAt).toBe(before?.createdAt);
    expect(after?.metadata.expiresAt).toBe(reference.expiresAt);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(rewrite).not.toHaveBeenCalled();
    expect(markerWrite).toHaveBeenCalledTimes(1);
    const originalWriteBytes = insert.mock.calls.reduce(
      (total, call) => total + call[1].byteLength,
      0,
    );
    const acceptanceWriteBytes = markerWrite.mock.calls.reduce(
      (total, call) => total + Buffer.byteLength(JSON.stringify(call[1])),
      0,
    );
    expect(originalWriteBytes).toBe(Buffer.byteLength(originalJson));
    expect(acceptanceWriteBytes).toBeLessThan(1024);
    expect(acceptanceWriteBytes * 64).toBeLessThan(originalWriteBytes);
    console.info(
      "Token Miser worker input bytes",
      JSON.stringify({
        originalWriteBytes,
        acceptanceWriteBytes,
        originalWrites: insert.mock.calls.length,
        originalRewrites: rewrite.mock.calls.length,
      }),
    );
    await f.store.close();
    await closeOpenClawStateDatabaseAsync();
    const reopened = fixture("round-trip");
    expect(await reopened.store.acceptedCount(scope, authority)).toBe(1);
    const chunks: Buffer[] = [];
    let offsetBytes = 0;
    for (;;) {
      const result = await reopened.store.retrieve(
        { id: reference.id, mode: "full", offsetBytes, maxBytes: 13_013 },
        scope,
        authority,
      );
      if (result.mode !== "full") {
        throw new Error("Expected a full byte page");
      }
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32_000);
      expect(result.offsetBytes).toBe(offsetBytes);
      chunks.push(Buffer.from(result.data, "base64"));
      if (result.nextOffsetBytes === undefined) {
        break;
      }
      offsetBytes = result.nextOffsetBytes;
    }
    const retrieved = Buffer.concat(chunks);
    expect(retrieved.equals(Buffer.from(originalJson))).toBe(true);
    expect(JSON.parse(retrieved.toString("utf8"))).toEqual(f.capture.content);
    await expect(
      reopened.store.retrieve(
        { id: reference.id, mode: "full" },
        { ...scope, sessionId: "other-session" },
        authority,
      ),
    ).rejects.toThrow("unavailable");
  });

  it.each(["blob", "marker"] as const)(
    "fails open at the %s capacity without evicting an accepted reference",
    async (limited) => {
      const f = fixture(`capacity-${limited}`, { blobs: limited === "blob" ? 1 : 2, markers: 1 });
      const kept = await stage(f);
      expect(await f.store.commit(kept.id, scope, authority)).toBe(true);
      f.store.release(kept.id);
      const second = await f.store.stage(
        {
          ...f.capture,
          toolCallId: "second-call",
          content: [{ type: "text", text: "second output" }],
        },
        authority,
      );
      if (limited === "blob") {
        expect(second).toBeUndefined();
      } else {
        if (!second) {
          throw new Error("Expected a staged original before marker capacity rejects selection");
        }
        expect(await f.store.commit(second.id, scope, authority)).toBe(false);
        await expect(
          f.store.retrieve({ id: second.id, mode: "full" }, scope, authority),
        ).rejects.toThrow("unavailable");
        expect(await f.blobStore.lookup(second.id)).toBeDefined();
      }
      await expect(
        f.store.retrieve({ id: kept.id, mode: "head", limit: 1 }, scope, authority),
      ).resolves.toMatchObject({ lines: [{ line: 1, text: "first" }] });
      expect(await f.store.acceptedCount(scope, authority)).toBe(1);
      await f.store.close();
      expect((await f.blobStore.entries()).map((entry) => entry.key)).toEqual([kept.id]);
      expect((await f.acceptanceStore.entries()).map((entry) => entry.key)).toEqual([kept.id]);
    },
  );

  it("rolls back unreleased group members under one absolute deadline without touching a released original", async () => {
    const f = fixture("group-settlement");
    const kept = await stage(f);
    expect(await f.store.commit(kept.id, scope, authority)).toBe(true);
    f.store.release(kept.id);
    const expiresAt = Date.now() + 3_600_000;
    const member = await stage(f, {
      ...f.capture,
      expiresAt,
      toolCallId: "member-call",
      content: [{ type: "text", text: "member output" }],
    });
    const group = await stage(f, {
      ...f.capture,
      expiresAt,
      toolCallId: "group-call",
      memberIds: [member.id],
      content: [{ type: "text", text: '{"member":"original output"}' }],
    });
    expect(member.expiresAt).toBe(expiresAt);
    expect(group.expiresAt).toBe(expiresAt);
    expect(await f.store.commit(member.id, scope, authority)).toBe(true);
    expect(await f.store.commit(group.id, scope, authority)).toBe(true);
    expect(await f.store.acceptedCount(scope, authority)).toBe(1);
    await f.store.discard(group.id, scope, authority);
    await f.store.discard(member.id, scope, authority);
    await expect(
      f.store.retrieve({ id: group.id, mode: "group" }, scope, authority),
    ).rejects.toThrow("unavailable");
    expect((await f.blobStore.entries()).map((entry) => entry.key)).toEqual([kept.id]);
    expect((await f.acceptanceStore.entries()).map((entry) => entry.key)).toEqual([kept.id]);
  });

  it("enforces the fixed logical deadline against real persisted rows without waiting for physical cleanup", async () => {
    const f = fixture("logical-expiry");
    const id = "tm_expired-worker-record";
    const expiresAt = Date.now() - 1;
    const { content, ...capture } = f.capture;
    const bytes = Buffer.from(JSON.stringify(content));
    await f.blobStore.registerIfAbsent(
      id,
      bytes,
      {
        ...capture,
        version: 1,
        expiresAt,
        originalBytes: bytes.byteLength,
      },
      { ttlMs: 3_600_000 },
    );
    await f.acceptanceStore.register(id, { scope, expiresAt }, { ttlMs: 3_600_000 });
    expect(await f.blobStore.lookup(id)).toBeDefined();
    expect(await f.store.acceptedCount(scope, authority)).toBe(0);
    await expect(f.store.retrieve({ id, mode: "full" }, scope, authority)).rejects.toThrow(
      "expired",
    );
    expect(await f.blobStore.lookup(id)).toBeDefined();
    expect((await f.acceptanceStore.lookup(id))?.expiresAt).toBe(expiresAt);
  });
});
