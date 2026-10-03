import {
  createAgentToolResultMiddlewareRunner,
  type AgentToolResultMiddleware,
  type AgentToolResultMiddlewareEvent,
} from "openclaw/plugin-sdk/agent-harness";
import type {
  PluginBlobEntry,
  PluginBlobStore,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { awaitGateBeforeSettlement } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveTokenMiserConfig } from "./config.js";
import { createTokenMiserService } from "./service.js";
import {
  createTokenMiserStore,
  type TokenMiserAcceptance,
  type TokenMiserMetadata,
} from "./store.js";

type AgentToolResultMiddlewareContext = Parameters<AgentToolResultMiddleware>[1];

const scope = { agentId: "agent-a", sessionId: "session-a", sessionKey: "agent:agent-a:main" };
const services: ReturnType<typeof createTokenMiserService>[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

// These SDK fixtures preserve ordinary byte/key semantics; the real store owns acceptance and rollback.
function storage() {
  const blobs = new Map<string, PluginBlobEntry<TokenMiserMetadata>>();
  const markers = new Map<string, TokenMiserAcceptance>();
  const operations: string[] = [];
  const acceptanceStore: PluginStateKeyedStore<TokenMiserAcceptance> = {
    async register(key, value, options) {
      options?.assertCurrent?.();
      markers.set(key, structuredClone(value));
      operations.push(`accept:${key}`);
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
    async delete(key, options) {
      options?.assertCurrent?.();
      operations.push(`delete-accept:${key}`);
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
    async register(key, bytes, metadata, options) {
      blobs.set(key, {
        key,
        bytes: Uint8Array.from(bytes),
        metadata: structuredClone(metadata),
        sizeBytes: bytes.byteLength,
        createdAt: Date.now(),
        expiresAt: options?.ttlMs === undefined ? undefined : Date.now() + options.ttlMs,
      });
      operations.push(`stage:${key}`);
    },
    async registerIfAbsent(key, bytes, metadata, options) {
      if (blobs.has(key)) {
        return false;
      }
      await blobStore.register(key, bytes, metadata, options);
      return true;
    },
    async lookup(key) {
      return blobs.get(key);
    },
    async entries() {
      return [...blobs.values()];
    },
    async delete(key) {
      operations.push(`delete-blob:${key}`);
      return blobs.delete(key);
    },
    async deleteExpiredKey() {
      return undefined;
    },
    async deleteExpired() {
      return [];
    },
    async clear() {
      blobs.clear();
    },
  };
  const store = createTokenMiserStore({
    blobStore,
    acceptanceStore,
    retentionHours: 168,
    maxEntryBytes: 32 * 1024 * 1024,
  });
  return { store, blobs, markers, operations, acceptanceStore, blobStore };
}

const text = ["worker: completed 🦀漢字", '"', String.fromCharCode(92, 0, 0xd800, 13, 10)]
  .join("")
  .repeat(300);
const originalContent = [{ type: "text" as const, text }];
const authority = { allowPersistence: true, assertCurrent() {} };

function event(
  overrides: Partial<AgentToolResultMiddlewareEvent> = {},
): AgentToolResultMiddlewareEvent {
  return {
    toolCallId: "outer",
    toolName: "build_logs",
    args: { command: "pnpm test" },
    result: { content: structuredClone(originalContent), details: { status: "completed" } },
    ...overrides,
  };
}

const context: AgentToolResultMiddlewareContext = {
  runtime: "openclaw",
  ...scope,
  runId: "run-a",
  task: "Check the build result.",
  persistence: "durable",
  resultVisibility: "model",
  toolNames: ["token_miser_read"],
  assertCurrent() {},
};

function fixture(disposition: "summarize" | "pass_through" = "summarize") {
  const f = storage();
  type Complete = Parameters<typeof createTokenMiserService>[0]["complete"];
  const complete = vi.fn<Complete>(async (params) => {
    const input = params.messages[0]?.content;
    if (typeof input !== "string") {
      throw new Error("Expected helper JSON input.");
    }
    const prompt = JSON.parse(input) as { grouped: boolean; members: Array<{ id: string }> };
    return {
      text: JSON.stringify({
        disposition,
        summary: "Build completed; repeated worker messages.",
        usefulDetails: [],
        ...(prompt.grouped
          ? {
              members: prompt.members.map((member) => ({
                id: member.id,
                summary: "Completed worker output.",
              })),
            }
          : {}),
      }),
      provider: "fixture-provider",
      model: "fixture-model",
      agentId: scope.agentId,
      usage: { inputTokens: 12, outputTokens: 7, costUsd: 0.001 },
      execution: { mode: "direct-provider", owner: { kind: "provider", id: "fixture-provider" } },
      audit: { caller: { kind: "plugin", id: "token-miser" } },
    };
  });
  const service = createTokenMiserService({
    store: f.store,
    config: resolveTokenMiserConfig({ thresholdBytes: 2048, maxSummaryBytes: 1024 }),
    complete,
    warn: vi.fn(),
  });
  services.push(service);
  Object.defineProperty(service.middleware, "originalTextMaxBytes", { value: 32 * 1024 * 1024 });
  const run = (
    extra: AgentToolResultMiddleware[] = [],
    ctx = context,
    before: AgentToolResultMiddleware[] = [],
  ) => createAgentToolResultMiddlewareRunner(ctx, [...before, service.middleware, ...extra]);
  return { ...f, service, complete, run };
}

describe("Token Miser selected tool-result delivery", () => {
  it("retains exact immutable original Unicode JSON before legacy middleware mutates the result", async () => {
    const f = fixture();
    const legacy: AgentToolResultMiddleware = (input) => {
      expect(input.originalTextContent).toBeUndefined();
      input.result.content = [{ type: "text", text: "legacy replacement" }];
    };
    const runner = f.run([], context, [legacy]);
    const selected = await runner.applyToolResultMiddleware(event());
    expect(selected.content[0]).toMatchObject({
      text: expect.stringContaining("token_miser_result"),
    });
    expect(f.markers.size).toBe(1);
    const [entry] = [...f.blobs.values()];
    expect(Buffer.from(entry!.bytes)).toEqual(Buffer.from(JSON.stringify(originalContent)));
    const recovered = await f.store.retrieve(
      { id: entry!.key, mode: "full", maxBytes: 23_000 },
      scope,
      authority,
    );
    if (recovered.mode !== "full") {
      throw new Error("Expected exact byte retrieval.");
    }
    expect(Buffer.from(recovered.data, "base64")).toEqual(
      Buffer.from(JSON.stringify(originalContent)),
    );
    expect(f.service.stats(scope)).toMatchObject({
      decisions: 1,
      summarized: 1,
      originalBytes: Buffer.byteLength(JSON.stringify(originalContent)),
      projectedBytes: Buffer.byteLength(JSON.stringify(selected.content)),
      helper: { calls: 1, inputTokens: 12, outputTokens: 7, costUsd: 0.001 },
    });
  });

  it.each(["invalid decision", "helper rejected"])(
    "fails open and records incurred helper work after %s",
    async (mode) => {
      const f = fixture();
      if (mode === "helper rejected") {
        f.complete.mockRejectedValueOnce(new Error("synthetic provider rejection"));
      } else {
        f.complete.mockImplementationOnce(async () => ({
          text: "not JSON",
          provider: "fixture-provider",
          model: "fixture-model",
          agentId: scope.agentId,
          usage: {},
          execution: {
            mode: "direct-provider",
            owner: { kind: "provider", id: "fixture-provider" },
          },
          audit: { caller: { kind: "plugin", id: "token-miser" } },
        }));
      }
      const result = await f.run().applyToolResultMiddleware(event());
      expect(result.content).toEqual(originalContent);
      expect(f.markers.size).toBe(0);
      expect(f.blobs.size).toBe(0);
      expect(f.service.stats(scope)).toMatchObject({
        decisions: 1,
        failedOpen: 1,
        summarized: 0,
        helper: { calls: 1 },
      });
      expect(f.service.stats(scope).helper.inputTokens).toBeUndefined();
    },
  );

  it.each([
    { name: "observe-only native", ctx: { resultVisibility: "observe" as const } },
    { name: "incognito", ctx: { persistence: "ephemeral" as const } },
    { name: "unknown persistence", ctx: { persistence: undefined } },
    { name: "missing current authority", ctx: { assertCurrent: undefined } },
    { name: "missing current task", ctx: { task: undefined } },
    { name: "blocked retrieval tool", ctx: { toolNames: [] } },
    { name: "failed tool", input: { isError: true } },
    {
      name: "structured failure without an event flag",
      input: { result: { content: originalContent, details: { status: "failed" } } },
    },
    {
      name: "still-running tool",
      input: { result: { content: originalContent, details: { status: "waiting" } } },
    },
    { name: "source request", input: { toolName: "read_file", args: { path: "src/owner.ts" } } },
    {
      name: "requested CSV shell read",
      input: { toolName: "exec", args: { command: "cat data.csv" } },
    },
    {
      name: "extensionless shell read",
      input: { toolName: "exec", args: { command: "cat README" } },
    },
    ...["function greet", "export default function greet"].map((declaration) => ({
      name: `ordinary source ${declaration}`,
      ctx: undefined,
      input: {
        toolName: "exec",
        args: { command: "generated-source" },
        result: {
          content: [
            {
              type: "text" as const,
              text: `${declaration}() {\n${"  // Exact generated implementation.\n".repeat(80)}  return 1;\n}`,
            },
          ],
          details: { status: "completed" },
        },
      },
    })),
  ])("skips helper and persistence for $name", async ({ ctx, input }) => {
    const f = fixture();
    const request = event(input);
    const result = await f.run([], { ...context, ...ctx }).applyToolResultMiddleware(request);
    expect(f.complete).not.toHaveBeenCalled();
    expect(result.content).toEqual(request.result.content);
    expect(f.markers.size).toBe(0);
    expect(f.blobs.size).toBe(0);
    expect(f.service.stats(scope).summarized).toBe(0);
  });
});

describe("Token Miser run cleanup and live selection authority", () => {
  it("cleans only the matching pending run and preserves another run's selected artifact", async () => {
    const f = fixture();
    const complete = f.complete.getMockImplementation()!;
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
    const signals: AbortSignal[] = [];
    let calls = 0;
    f.complete.mockImplementation(async (params) => {
      const call = calls++;
      signals.push(params.signal!);
      entered[call]!.resolve();
      await release[call]!.promise;
      return await complete(params);
    });
    const first = f.run().applyToolResultMiddleware(event({ toolCallId: "first" }));
    const second = f
      .run([], { ...context, runId: "run-b" })
      .applyToolResultMiddleware(event({ toolCallId: "second" }));
    try {
      await Promise.all([
        awaitGateBeforeSettlement(entered[0]!.promise, first, "First helper did not start."),
        awaitGateBeforeSettlement(entered[1]!.promise, second, "Second helper did not start."),
      ]);
      expect(f.blobs.size).toBe(2);
      await f.service.cleanup({ sessionKey: "another-session", runId: "run-a" });
      await f.service.cleanup({ sessionKey: scope.sessionKey, runId: "another-run" });
      expect(signals.map((signal) => signal.aborted)).toEqual([false, false]);
      expect(f.blobs.size).toBe(2);
      await f.service.cleanup({ sessionKey: scope.sessionKey, runId: "run-a" });
      expect(signals.map((signal) => signal.aborted)).toEqual([true, false]);
      expect([...f.blobs.values()].map((entry) => entry.metadata.runId)).toEqual(["run-b"]);
      expect(f.markers.size).toBe(0);
    } finally {
      for (const gate of release) {
        gate.resolve();
      }
    }
    expect((await first).content).toEqual(originalContent);
    expect((await second).content[0]).toMatchObject({
      text: expect.stringContaining("token_miser_result"),
    });
    expect(f.markers.size).toBe(1);
    await f.service.cleanup({ sessionKey: scope.sessionKey, runId: "run-b" });
    expect(f.markers.size).toBe(1);
    const [id] = f.markers.keys();
    const recovered = await f.store.retrieve(
      { id: id!, mode: "full", maxBytes: 23_000 },
      scope,
      authority,
    );
    if (recovered.mode !== "full") {
      throw new Error("Expected exact byte retrieval.");
    }
    expect(Buffer.from(recovered.data, "base64")).toEqual(
      Buffer.from(JSON.stringify(originalContent)),
    );
    expect(f.service.stats(scope).summarized).toBe(1);
  });

  it.each(["storage", "helper", "selection"] as const)(
    "publishes no reference when live authority is revoked during %s",
    async (phase) => {
      const f = fixture();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let live = true;
      const ctx = {
        ...context,
        assertCurrent() {
          if (!live) {
            throw new Error("Run authority revoked.");
          }
        },
      };
      if (phase === "storage") {
        const register = f.blobStore.register.bind(f.blobStore);
        f.blobStore.register = async (...args) => {
          await register(...args);
          entered.resolve();
          await release.promise;
        };
      } else if (phase === "helper") {
        const complete = f.complete.getMockImplementation()!;
        f.complete.mockImplementation(async (params) => {
          entered.resolve();
          await release.promise;
          return await complete(params);
        });
      } else {
        const register = f.acceptanceStore.register.bind(f.acceptanceStore);
        f.acceptanceStore.register = async (...args) => {
          await register(...args);
          entered.resolve();
          await release.promise;
        };
      }
      const work = f.run([], ctx).applyToolResultMiddleware(event());
      // Observe rejection immediately; the owner boundary may reject a revoked run.
      const settled = Promise.allSettled([work]);
      try {
        await awaitGateBeforeSettlement(
          entered.promise,
          work,
          "Revocation boundary was not reached.",
        );
        expect(f.blobs.size).toBe(1);
        expect(f.markers.size).toBe(phase === "selection" ? 1 : 0);
        live = false;
      } finally {
        release.resolve();
      }
      const [result] = await settled;
      if (phase === "selection") {
        expect(result).toMatchObject({ status: "fulfilled", value: { content: originalContent } });
      } else {
        expect(result?.status).toBe("rejected");
        if (result?.status === "rejected") {
          expect(String(result.reason)).toContain("Run authority revoked.");
        }
      }
      expect(f.markers.size).toBe(0);
      expect(f.blobs.size).toBe(0);
      expect(f.service.stats(scope).summarized).toBe(0);
      expect(f.complete).toHaveBeenCalledTimes(phase === "storage" ? 0 : 1);
    },
  );

  it("rejects a committed candidate when disposal occurs during a later participant's selection", async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const selected = vi.fn();
    const later: AgentToolResultMiddleware = (input) => ({
      result: input.result,
      projection: {
        select: async () => {
          expect(f.markers.size).toBe(1);
          entered.resolve();
          await release.promise;
          return true;
        },
        selected,
        discard: vi.fn(async () => {}),
      },
    });
    const work = f.run([later]).applyToolResultMiddleware(event());
    try {
      await awaitGateBeforeSettlement(entered.promise, work, "Later selection did not start.");
      await f.service.close();
      expect(f.markers.size).toBe(0);
      expect(f.blobs.size).toBe(0);
    } finally {
      release.resolve();
    }
    expect((await work).content).toEqual(originalContent);
    expect(selected).not.toHaveBeenCalled();
    expect(f.service.stats(scope).summarized).toBe(0);
  });

  it("keeps released exact bytes when a later selected notification fails", async () => {
    const f = fixture();
    const discard = vi.fn(async () => {});
    const later: AgentToolResultMiddleware = (input) => ({
      result: input.result,
      projection: {
        select: async () => true,
        selected: () => {
          throw new Error("Synthetic notification failure.");
        },
        discard,
      },
    });
    const selected = await f.run([later]).applyToolResultMiddleware(event());
    expect(selected.content[0]).toMatchObject({
      text: expect.stringContaining("token_miser_result"),
    });
    expect(discard).not.toHaveBeenCalled();
    expect(await f.store.acceptedCount(scope, authority)).toBe(1);
    await f.service.cleanup({ sessionKey: scope.sessionKey, runId: "run-a" });
    const [id] = f.markers.keys();
    const recovered = await f.store.retrieve(
      { id: id!, mode: "full", maxBytes: 23_000 },
      scope,
      authority,
    );
    if (recovered.mode !== "full") {
      throw new Error("Expected exact byte retrieval.");
    }
    expect(Buffer.from(recovered.data, "base64")).toEqual(
      Buffer.from(JSON.stringify(originalContent)),
    );
    expect(f.service.stats(scope)).toMatchObject({ summarized: 1, retrievalCount: 0 });
  });
});

describe("Token Miser focus byte-prefix coverage", () => {
  it.each([
    { name: "100k single line", text: "L".repeat(100_000) },
    {
      name: "Unicode split at byte 8192",
      text:
        "U".repeat(8191 - Buffer.byteLength('[{"type":"text","text":"')) +
        "🦀" +
        "Z".repeat(90_000),
    },
  ])(
    "focuses $name without corrupting or losing the retained original",
    async ({ name, text: outputText }) => {
      const f = fixture();
      const content = [{ type: "text" as const, text: outputText }];
      const originalBytes = Buffer.from(JSON.stringify(content));
      const published = await f
        .run()
        .applyToolResultMiddleware(
          event({ result: { content, details: { status: "completed" } } }),
        );
      const block = published.content[0];
      if (block?.type !== "text") {
        throw new Error("Expected published retained reference.");
      }
      const id = /<token_miser_result id="([^"]+)"/.exec(block.text)?.[1];
      if (!id) {
        throw new Error("Expected published Token Miser result ID.");
      }
      expect(f.complete).toHaveBeenCalledTimes(1);
      const complete = f.complete.getMockImplementation();
      if (!complete) {
        throw new Error("Expected synthetic helper implementation.");
      }
      f.complete.mockImplementationOnce(async (params) => {
        expect(params.purpose).toBe("token-miser.focus");
        const input = params.messages[0]?.content;
        if (typeof input !== "string") {
          throw new Error("Expected focus helper JSON input.");
        }
        const prompt: unknown = JSON.parse(input);
        if (prompt === null || typeof prompt !== "object" || !("excerpt" in prompt)) {
          throw new Error("Expected explicit focus excerpt.");
        }
        const excerpt = prompt.excerpt;
        if (
          excerpt === null ||
          typeof excerpt !== "object" ||
          !("text" in excerpt) ||
          typeof excerpt.text !== "string" ||
          !("coveredBytes" in excerpt) ||
          typeof excerpt.coveredBytes !== "number"
        ) {
          throw new Error("Expected decoded byte-prefix coverage.");
        }
        expect(excerpt).toMatchObject({
          format: "text-content-json-v1",
          offsetBytes: 0,
          totalBytes: originalBytes.byteLength,
          partial: true,
        });
        expect(excerpt.coveredBytes).toBeGreaterThanOrEqual(8189);
        expect(excerpt.coveredBytes).toBeLessThanOrEqual(8192);
        expect(Buffer.byteLength(excerpt.text)).toBe(excerpt.coveredBytes);
        expect(Buffer.from(excerpt.text)).toEqual(originalBytes.subarray(0, excerpt.coveredBytes));
        expect(excerpt.text).not.toContain("\uFFFD");
        if (name === "Unicode split at byte 8192") {
          expect(excerpt.coveredBytes).toBe(8191);
        }
        return {
          ...(await complete(params)),
          text: "Only the declared prefix was inspected; remaining bytes are unavailable in this excerpt.",
        };
      });
      const focused = await f.service.focus({
        scope,
        authority,
        request: { id, mode: "full" },
        question: "What is present in the inspected prefix, and what remains unread?",
      });
      expect(focused.answer).toContain("Only the declared prefix was inspected");
      expect(f.complete).toHaveBeenCalledTimes(2);
      const chunks: Buffer[] = [];
      let offsetBytes = 0;
      for (;;) {
        const page = await f.store.retrieve(
          { id, mode: "full", offsetBytes, maxBytes: 16_384 },
          scope,
          authority,
        );
        if (page.mode !== "full") {
          throw new Error("Expected full retained byte page.");
        }
        chunks.push(Buffer.from(page.data, "base64"));
        if (page.nextOffsetBytes === undefined) {
          break;
        }
        offsetBytes = page.nextOffsetBytes;
      }
      expect(Buffer.concat(chunks)).toEqual(originalBytes);
      expect(f.service.stats(scope)).toMatchObject({ summarized: 1, helper: { calls: 2 } });
    },
  );
});
