import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { createAgentToolResultMiddlewareRunner } from "../agents/harness/tool-result-middleware.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import type {
  AgentToolResultMiddleware,
  AgentToolResultMiddlewareContext,
  AgentToolResultMiddlewareEvent,
  AgentToolResultMiddlewareOptions,
  OpenClawAgentToolResult,
} from "./agent-tool-result-middleware-types.js";
import { createCapturedPluginRegistration } from "./captured-registration.js";
import { createLazyPluginRuntime } from "./loader-module-runtime.js";
import { getPluginValueInstance } from "./plugin-instance-scope.js";
import { createPluginRegistry } from "./registry.js";
import { createPluginRecord } from "./status.test-fixtures.js";

function createFixture() {
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createLazyPluginRuntime({}),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "result-policy",
    origin: "bundled",
    contracts: { agentToolResultMiddleware: ["openclaw", "codex"] },
  });
  const api = builder.createApi(record, {
    config: {},
    hookPolicy: { timeoutMs: 1_000, timeouts: { after_tool_call: 10 } },
  });
  builder.registry.plugins.push(record);
  const register = (
    handler: AgentToolResultMiddleware,
    options?: AgentToolResultMiddlewareOptions,
  ) => {
    api.registerAgentToolResultMiddleware(handler, options);
  };
  const runner = (context: Partial<AgentToolResultMiddlewareContext> = {}) =>
    createAgentToolResultMiddlewareRunner(
      { runtime: "openclaw", ...context },
      builder.registry.agentToolResultMiddlewares.map((entry) => entry.handler),
    );
  return { builder, register, runner };
}

function createEvent(): AgentToolResultMiddlewareEvent {
  return {
    toolCallId: "call-1",
    toolName: "exec",
    args: {},
    result: {
      content: [{ type: "text", text: "completed 🦀\nexact result" }],
      details: { receipt: { status: "done" } },
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("registered tool-result middleware failure policy", () => {
  it.each(["direct", "captured"] as const)(
    "keeps normalized options through %s wrapping and isolates timeout work",
    async (mode) => {
      vi.useFakeTimers();
      const fixture = createFixture();
      const entered = createDeferred<AgentToolResultMiddlewareEvent>();
      const finish = createDeferred();
      const discard = vi.fn(async () => {});
      const select = vi.fn(async () => true);
      const selected = vi.fn();
      let helperSignal: AbortSignal | undefined;
      const handler: AgentToolResultMiddleware = async (event, context) => {
        helperSignal = context.signal;
        if (isRecord(event.result.details) && isRecord(event.result.details.receipt)) {
          event.result.details.receipt.status = "unfinished";
        }
        entered.resolve(event);
        await finish.promise;
        event.result.content = [{ type: "text", text: "late replacement" }];
        return { result: event.result, projection: { select, selected, discard } };
      };
      const options: AgentToolResultMiddlewareOptions = {
        failureMode: "passthrough",
        originalTextMaxBytes: 4096,
      };
      if (mode === "captured") {
        const captured = createCapturedPluginRegistration({
          contracts: { agentToolResultMiddleware: ["openclaw", "codex"] },
        });
        captured.api.registerAgentToolResultMiddleware(handler, options);
        const capturedRegistration = captured.agentToolResultMiddlewares[0];
        if (!capturedRegistration) {
          throw new Error("Captured middleware registration missing");
        }
        expect(capturedRegistration.rawHandler).toBe(handler);
        expect(capturedRegistration.handler.failureMode).toBe("passthrough");
        expect(capturedRegistration.handler.originalTextMaxBytes).toBe(4096);
        // Capture is an SDK test utility, not a live registry replay path. Feed its
        // real scoped callable and immutable facts into the actual live registrar.
        fixture.register(capturedRegistration.handler, {
          runtimes: capturedRegistration.runtimes,
          failureMode: capturedRegistration.handler.failureMode,
          originalTextMaxBytes: capturedRegistration.handler.originalTextMaxBytes,
        });
      } else {
        fixture.register(handler, options);
      }
      options.failureMode = "error";
      options.originalTextMaxBytes = 1024;
      const registration = fixture.builder.registry.agentToolResultMiddlewares[0];
      if (!registration) {
        throw new Error("Middleware registration missing");
      }
      expect(getPluginValueInstance(registration.handler)?.pluginId).toBe("result-policy");
      expect(registration.handler.failureMode).toBe("passthrough");
      expect(registration.handler.originalTextMaxBytes).toBe(4096);

      const source = createEvent();
      const expected = structuredClone(source.result);
      const work = new AsyncWorkScope();
      const applied = work.run(() => fixture.runner().applyToolResultMiddleware(source));
      const handlerEvent = await entered.promise;
      expect(handlerEvent.originalTextContent).toEqual(expected.content);
      expect(handlerEvent.originalCaptureComplete).toBe(true);
      expect(helperSignal?.aborted).toBe(false);
      expect(source.result).toEqual(expected);

      // Advance the specific after_tool_call policy, not the longer general hook policy.
      await vi.advanceTimersByTimeAsync(10);
      const delivered = await applied;
      expect(delivered).toEqual(expected);
      expect(helperSignal?.aborted).toBe(true);
      expect(work.hasPendingWork).toBe(true);
      finish.resolve();
      await work.drain();
      expect(handlerEvent.result.content).toEqual([{ type: "text", text: "late replacement" }]);
      expect(source.result).toEqual(expected);
      expect(delivered).toEqual(expected);
      expect(discard).toHaveBeenCalledTimes(1);
      expect(select).not.toHaveBeenCalled();
      expect(selected).not.toHaveBeenCalled();
    },
  );

  it("continues later legacy middleware with the result preceding a failed opt-in handler", async () => {
    const fixture = createFixture();
    fixture.register(
      (event) => {
        event.result.content = [{ type: "text", text: "failed replacement" }];
        throw new Error("private handler failure");
      },
      { failureMode: "passthrough" },
    );
    const received: unknown[] = [];
    const seen = vi.fn<AgentToolResultMiddleware>((event) => {
      received.push(structuredClone(event.result));
      event.result.content = [{ type: "text", text: "later transformation" }];
    });
    fixture.register(seen);
    const source = createEvent();
    const before = structuredClone(source.result);
    const result = await fixture.runner().applyToolResultMiddleware(source);
    expect(received).toEqual([before]);
    expect(result.content).toEqual([{ type: "text", text: "later transformation" }]);
  });

  it("keeps the legacy default failure result after an actual registrar timeout", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    const entered = createDeferred();
    const finish = createDeferred();
    fixture.register(async () => {
      entered.resolve();
      await finish.promise;
    });
    const applied = fixture.runner().applyToolResultMiddleware(createEvent());
    await entered.promise;
    await vi.advanceTimersByTimeAsync(10);
    expect(await applied).toEqual({
      content: [{ type: "text", text: "Tool output unavailable due to post-processing error." }],
      details: { status: "error", middlewareError: true },
    });
    finish.resolve();
    await finish.promise;
  });

  it("sanitizes native details before cloning and accepts valid in-place opt-in changes", async () => {
    const fixture = createFixture();
    const handler = vi.fn<AgentToolResultMiddleware>((event) => {
      expect(event.result.details).toEqual({ receipt: { status: "done" } });
      event.result.content = [{ type: "text", text: "compressed" }];
      event.result.details = { status: "success" };
    });
    fixture.register(handler, { failureMode: "passthrough" });
    const source = createEvent();
    const nativeDetails = { receipt: { status: "done" }, method() {} };
    source.result.details = nativeDetails;
    const result = await fixture.runner().applyToolResultMiddleware(source);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      content: [{ type: "text", text: "compressed" }],
      details: { status: "success" },
    });
    expect(source.result.details).toBe(nativeDetails);
    expect(source.result.content).toEqual(createEvent().result.content);
  });

  it("validates an opt-in handler's in-place output rather than passing invalid mutations", async () => {
    const fixture = createFixture();
    fixture.register(
      (event) => {
        event.result.content = [{ type: "text", text: "x".repeat(100_001) }];
      },
      { failureMode: "passthrough" },
    );
    const result = await fixture.runner().applyToolResultMiddleware(createEvent());
    expect(result.details).toEqual({ status: "error", middlewareError: true });
  });

  it("discards a reference when its selector tries to alter the final visible result", async () => {
    const fixture = createFixture();
    const discard = vi.fn(async () => {});
    const selected = vi.fn();
    const select = vi.fn(async (visible: OpenClawAgentToolResult) => {
      visible.content = [{ type: "text", text: "unvalidated tm_altered" }];
      return true;
    });
    fixture.register(
      () => ({
        result: {
          content: [{ type: "text", text: "Retained output tm_pending_selector" }],
          details: { reference: "tm_pending_selector" },
        },
        projection: { select, selected, discard },
      }),
      { failureMode: "passthrough", originalTextMaxBytes: 4096 },
    );
    const source = createEvent();
    const originalBytes = JSON.stringify(source.result.content);
    const result = await fixture.runner().applyToolResultMiddleware(source);
    expect(JSON.stringify(result.content)).toBe(originalBytes);
    expect(result.content).toEqual(source.result.content);
    expect(select).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(selected).not.toHaveBeenCalled();
  });

  it.each(["function", "getter with identity view", "getter with bounded view"] as const)(
    "discards once when detached selected content cannot be admitted: %s",
    async (mode) => {
      const fixture = createFixture();
      const discard = vi.fn(async () => {});
      const select = vi.fn(async () => true);
      const selected = vi.fn();
      const marker = "Retained output tm_uncloneable";
      let text = marker;
      const content = [
        mode === "function"
          ? { type: "text" as const, text: marker, nativeOperation() {} }
          : {
              type: "text" as const,
              get expandBeforeText() {
                text = marker + "x".repeat(100_001);
                return true;
              },
              get text() {
                return text;
              },
            },
      ];
      fixture.register(
        () => ({
          result: {
            content: mode === "function" ? content : [{ type: "text", text: marker }],
            details: { reference: "tm_uncloneable" },
          },
          projection: { select, selected, discard },
        }),
        { failureMode: "passthrough", originalTextMaxBytes: 4096 },
      );
      const source = createEvent();
      const result = await fixture.runner().applyToolResultMiddleware(
        source,
        (candidate) => (mode === "function" ? candidate : { ...candidate, content }),
        mode === "getter with bounded view"
          ? (candidate) => ({
              ...candidate,
              content: candidate.content.map((block) =>
                block.type === "text" ? { ...block, text: block.text.slice(0, 256) } : block,
              ),
            })
          : undefined,
      );
      expect(result.content).toEqual(source.result.content);
      expect(JSON.stringify(result.content)).toBe(JSON.stringify(source.result.content));
      expect(discard).toHaveBeenCalledTimes(1);
      expect(select).not.toHaveBeenCalled();
      expect(selected).not.toHaveBeenCalled();
    },
  );

  it("keeps prepared facts and host settlement authority when an earlier legacy handler mutates context", async () => {
    const fixture = createFixture();
    const host = new AbortController();
    const substitute = new AbortController();
    const toolNames = ["exec", "token_miser_read"];
    let current = true;
    const assertCurrent = () => {
      if (!current) {
        throw new Error("actual host session revoked");
      }
    };
    fixture.register((event, context) => {
      event.args.command = "git status";
      event.args.operation = "write";
      if (isRecord(event.args.request)) {
        event.args.request.kind = "mutation";
        event.args.request.glob = "unrelated/**";
      }
      context.runtime = "codex";
      context.agentId = "other-agent";
      context.sessionId = "other-session";
      context.sessionKey = "other-key";
      context.runId = "other-run";
      context.persistence = "ephemeral";
      context.resultVisibility = "observe";
      context.task = "other task";
      context.assertCurrent = () => {};
      context.signal = substitute.signal;
      context.toolNames = ["other_tool"];
      toolNames.push("legacy_mutated_alias");
    });
    const received = createDeferred<{
      context: AgentToolResultMiddlewareContext;
      args: Record<string, unknown>;
      originalCaptureComplete: boolean | undefined;
    }>();
    const selecting = createDeferred();
    const finish = createDeferred();
    const discard = vi.fn(async () => {});
    const selected = vi.fn();
    const select = vi.fn(async () => {
      selecting.resolve();
      await finish.promise;
      return true;
    });
    fixture.register(
      (event, context) => {
        received.resolve({
          context,
          args: event.args,
          originalCaptureComplete: event.originalCaptureComplete,
        });
        return {
          result: {
            content: [{ type: "text", text: "Retained output tm_host_fenced" }],
            details: {},
          },
          projection: { select, selected, discard },
        };
      },
      { failureMode: "passthrough", originalTextMaxBytes: 4096 },
    );
    const source = createEvent();
    source.args = {
      command: "rg --files src",
      operation: "list",
      request: { kind: "source", glob: "src/**" },
    };
    const applied = fixture
      .runner({
        agentId: "original-agent",
        sessionId: "original-session",
        sessionKey: "original-key",
        runId: "original-run",
        persistence: "durable",
        resultVisibility: "model",
        task: "original task",
        toolNames,
        signal: host.signal,
        assertCurrent,
      })
      .applyToolResultMiddleware(source);
    const outcome = applied.then(
      (result) => ({ result }),
      (error: unknown) => ({ error }),
    );
    try {
      const { context, args, originalCaptureComplete } = await awaitGateBeforeSettlement(
        received.promise,
        outcome,
        "Capture consumer did not receive prepared facts",
      );
      expect(context).toMatchObject({
        runtime: "openclaw",
        agentId: "original-agent",
        sessionId: "original-session",
        sessionKey: "original-key",
        runId: "original-run",
        persistence: "durable",
        resultVisibility: "model",
        task: "original task",
        toolNames: ["exec", "token_miser_read"],
      });
      expect(args).toEqual({
        command: "rg --files src",
        operation: "list",
        request: { kind: "source", glob: "src/**" },
      });
      expect(Object.isFrozen(args)).toBe(true);
      expect(Object.isFrozen(args.request)).toBe(true);
      expect(originalCaptureComplete).toBe(true);
      expect(source.args).toEqual({
        command: "git status",
        operation: "write",
        request: { kind: "mutation", glob: "unrelated/**" },
      });
      expect(Object.isFrozen(context.toolNames)).toBe(true);
      expect(context.signal?.aborted).toBe(false);
      await awaitGateBeforeSettlement(selecting.promise, outcome, "Selection did not start");
      current = false;
      host.abort(new Error("actual host signal aborted"));
      expect(context.signal?.aborted).toBe(true);
      finish.resolve();
      expect(await outcome).toEqual({
        error: expect.objectContaining({ message: "actual host session revoked" }),
      });
      expect(select).toHaveBeenCalledTimes(1);
      expect(selected).not.toHaveBeenCalled();
      expect(discard).toHaveBeenCalledTimes(1);
    } finally {
      finish.resolve();
      await outcome;
    }
  });

  it.each(["mutate", "throw"] as const)(
    "keeps selected reference bytes within budget despite retained mutation and a %s notification",
    async (notification) => {
      const fixture = createFixture();
      const entered = createDeferred<OpenClawAgentToolResult>();
      const finish = createDeferred();
      const discard = vi.fn(async () => {});
      const candidate: OpenClawAgentToolResult = {
        content: [{ type: "text", text: "Retained output tm_settled" }],
        details: { reference: "tm_settled", receipt: { status: "accepted" } },
      };
      const finalBytes = JSON.stringify(candidate.content);
      const finalBudgetBytes = 128;
      let retainedView: OpenClawAgentToolResult | undefined;
      const select = vi.fn(async (visible: OpenClawAgentToolResult) => {
        retainedView = visible;
        entered.resolve(visible);
        await finish.promise;
        return JSON.stringify(visible.content) === finalBytes;
      });
      const selected = vi.fn(() => {
        if (notification === "throw") {
          throw new Error("notification failed after acceptance");
        }
        if (!retainedView) {
          throw new Error("Expected selector view");
        }
        // Nested mutation must be rejected as well as replacing the top-level fields.
        if (isRecord(retainedView.details) && isRecord(retainedView.details.receipt)) {
          retainedView.details.receipt.status = "notification altered";
        }
      });
      fixture.register(
        () => ({
          result: candidate,
          projection: { select, selected, discard },
        }),
        { failureMode: "passthrough", originalTextMaxBytes: 4096 },
      );
      const applied = fixture.runner().applyToolResultMiddleware(
        createEvent(),
        (result) => result,
        (result) => Object.assign({ ...result }, { nativeMetadata() {} }),
      );
      const visible = await entered.promise;
      expect(Object.hasOwn(visible, "nativeMetadata")).toBe(false);
      expect(Buffer.byteLength(JSON.stringify(visible.content))).toBeLessThanOrEqual(
        finalBudgetBytes,
      );
      candidate.content = [{ type: "text", text: "late tm_wrong_ref " + "x".repeat(100_001) }];
      candidate.details = { reference: "tm_wrong_ref" };
      finish.resolve();
      const result = await applied;
      expect(JSON.stringify(result.content)).toBe(finalBytes);
      expect(Buffer.byteLength(JSON.stringify(result.content))).toBeLessThanOrEqual(
        finalBudgetBytes,
      );
      expect(result.details).toEqual({ reference: "tm_settled", receipt: { status: "accepted" } });
      expect(select).toHaveBeenCalledTimes(1);
      expect(selected).toHaveBeenCalledTimes(1);
      expect(discard).not.toHaveBeenCalled();
    },
  );

  it.each([
    { failureMode: "error" as const, originalTextMaxBytes: 4096 },
    { failureMode: "passthrough" as const, originalTextMaxBytes: 8192 },
  ])("rejects conflicting repeated options without broadening matching: %j", async (conflict) => {
    const fixture = createFixture();
    const handler = vi.fn<AgentToolResultMiddleware>();
    fixture.register(handler, {
      matcher: ["exec"],
      runtimes: ["openclaw"],
      failureMode: "passthrough",
      originalTextMaxBytes: 4096,
    });
    fixture.register(handler, { matcher: ["read"], runtimes: ["codex"], ...conflict });
    expect(fixture.builder.registry.agentToolResultMiddlewares).toHaveLength(1);
    expect(fixture.builder.registry.diagnostics).toEqual([
      expect.objectContaining({ level: "error", pluginId: "result-policy" }),
    ]);
    const source = createEvent();
    await fixture
      .runner({ runtime: "codex" })
      .applyToolResultMiddleware({ ...source, toolName: "read" });
    expect(handler).not.toHaveBeenCalled();
    await fixture.runner().applyToolResultMiddleware(source);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not convert revoked host authority into a successful pass-through", async () => {
    const fixture = createFixture();
    const entered = createDeferred();
    const finish = createDeferred();
    let current = true;
    fixture.register(
      async () => {
        entered.resolve();
        await finish.promise;
        throw new Error("helper failed after revocation");
      },
      { failureMode: "passthrough" },
    );
    const publish = vi.fn((result: OpenClawAgentToolResult) => result);
    const applied = fixture
      .runner({
        assertCurrent: () => {
          if (!current) {
            throw new Error("session revoked");
          }
        },
      })
      .applyToolResultMiddleware(createEvent(), publish);
    const rejected = expect(applied).rejects.toThrow("session revoked");
    await entered.promise;
    current = false;
    finish.resolve();
    await rejected;
    expect(publish).not.toHaveBeenCalled();
  });
});
