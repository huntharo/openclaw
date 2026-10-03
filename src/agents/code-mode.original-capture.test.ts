import { afterEach, describe, expect, it, vi } from "vitest";
import { getCodeModeOriginalTextCapture } from "./code-mode-original-text.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import {
  createCodeModeHarness,
  resetCodeModeTestState,
  resultDetails,
} from "./code-mode.test-support.js";
import { clearToolSearchCatalog } from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";

const catalogs: Array<ReturnType<typeof createCodeModeHarness>["ctx"]> = [];
afterEach(async () => {
  for (const ctx of catalogs.splice(0)) {
    clearToolSearchCatalog(ctx);
  }
  await resetCodeModeTestState();
});

const payload = ["🦀漢字", '"', String.fromCharCode(92, 0, 0xd800, 13, 10)].join("").repeat(300);

function harness(
  options: {
    executor?: "node" | "quickjs";
    captureBytes?: number;
    snapshotBytes?: number;
    fail?: boolean;
    small?: boolean;
  } = {},
) {
  const fixture = createCodeModeHarness({
    codeMode: {
      maxOutputBytes: 1024,
      executor: options.executor ?? "node",
      ...(options.snapshotBytes ? { maxSnapshotBytes: options.snapshotBytes } : {}),
    },
  });
  catalogs.push(fixture.ctx);
  const tools = createCodeModeTools({
    ...fixture.ctx,
    originalTextMaxBytes: options.captureBytes ?? 64_000,
  });
  const producer: AnyAgentTool = {
    name: "logs",
    label: "Logs",
    description: "Synthetic completed logs.",
    parameters: { type: "object", properties: { label: { type: "string" } } },
    execute: vi.fn(async (_id, args) => {
      if (options.fail) {
        throw new Error("synthetic tool failure");
      }
      // Tool implementations can mutate input; provenance keeps the requested arguments.
      if (args !== null && typeof args === "object") {
        Object.assign(args, { label: "mutated" });
      }
      return jsonResult({ payload: options.small ? "small" : payload });
    }),
  };
  applyCodeModeCatalog({ ...fixture.ctx, tools: [...tools, producer] });
  return { exec: tools[0]!, wait: tools[1]!, producer };
}

function capturedPayload(result: object): Record<string, unknown> {
  const capture = getCodeModeOriginalTextCapture(result);
  expect(capture?.complete).toBe(true);
  const text = capture?.originalTextContent?.[0]?.text;
  expect(typeof text).toBe("string");
  if (!text) {
    throw new Error("Missing exact captured text.");
  }
  return JSON.parse(text) as Record<string, unknown>;
}

describe("Code Mode original text capture", () => {
  it.each(["node", "quickjs"] as const)(
    "keeps exact %s guest values and incremental output through exec/wait",
    async (executor) => {
      const { exec, wait, producer } = harness({ executor });
      const first = await exec.execute("group", {
        code: 'const result = await logs({label:"original"}); json(result); await yield_control(); text(result.payload.slice(-4)); return result.payload;',
      });
      const firstPublic = resultDetails(first);
      expect(firstPublic.status).toBe("waiting");
      expect(firstPublic.output).toEqual([expect.objectContaining({ truncated: true })]);
      expect(capturedPayload(first).output).toEqual([{ type: "json", value: { payload } }]);
      expect(getCodeModeOriginalTextCapture(first)?.members).toBeUndefined();

      const final = await wait.execute("finish", { runId: firstPublic.runId });
      expect(resultDetails(final)).toMatchObject({
        status: "completed",
        value: { truncated: true },
      });
      const original = capturedPayload(final);
      expect(original.output).toEqual([{ type: "text", text: payload.slice(-4) }]);
      expect(original.value).toBe(payload);
      expect(Buffer.from(JSON.stringify(original.value))).toEqual(
        Buffer.from(JSON.stringify(payload)),
      );
      const members = getCodeModeOriginalTextCapture(final)?.members;
      expect(members).toHaveLength(1);
      expect(members?.[0]).toMatchObject({ toolName: "logs", args: { label: "original" } });
      expect(JSON.parse(members![0]!.content[0]!.text)).toEqual({ payload });
      expect(producer.execute).toHaveBeenCalledOnce();
    },
  );

  it("keeps the existing results owner retrievable without replaying its producer", async () => {
    const { exec, producer } = harness();
    const first = await exec.execute("save", { code: 'return await logs({label:"saved"});' });
    const saved = resultDetails(first).value as { reference: { id: string } };
    expect(saved.reference.id).toMatch(/^result_/);
    expect(capturedPayload(first).value).toEqual({ payload });
    const loaded = await exec.execute("load", {
      code: `return (await results.load(${JSON.stringify(saved.reference.id)})).payload;`,
    });
    expect(capturedPayload(loaded).value).toBe(payload);
    expect(producer.execute).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "disabled capture",
      captureBytes: 0,
      code: "return await logs({});",
      complete: undefined,
    },
    {
      name: "admitted byte capacity",
      captureBytes: 1024,
      code: "return await logs({});",
      complete: false,
    },
    {
      name: "snapshot allowance",
      snapshotBytes: 1024,
      code: 'return "🦀".repeat(1000);',
      complete: false,
    },
    {
      name: "caught nested failure",
      fail: true,
      code: "try { await logs({}); } catch {} return true;",
      complete: false,
    },
    {
      name: "unawaited nested failure",
      fail: true,
      code: "void logs({}); return true;",
      complete: false,
    },
    {
      name: "member capacity",
      small: true,
      code: "for (let i=0;i<17;i++) await logs({}); return true;",
      complete: false,
    },
  ])(
    "declines incomplete originals for $name while keeping public execution semantics",
    async ({ code, complete, ...options }) => {
      const { exec } = harness(options);
      const result = await exec.execute("bounded", { code });
      expect(getCodeModeOriginalTextCapture(result)?.complete).toBe(complete);
      expect(getCodeModeOriginalTextCapture(result)?.originalTextContent).toBeUndefined();
      expect(resultDetails(result).status).toBe(
        options.name === "unawaited nested failure" ? "failed" : "completed",
      );
    },
  );
});
