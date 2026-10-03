import { describe, expect, it } from "vitest";
import { buildEvaluationPrompt, parseEvaluation, shouldPassThrough } from "./policy.js";

describe("Token Miser exact-content policy", () => {
  it.each([
    ["read", { path: "src/schema.ts" }, "export type Scope = { id: string };", true],
    ["exec", { command: "cat /project/AGENTS.md" }, "Follow the owner lifecycle.", true],
    ["exec", { command: "sed -n '15,50p' src/parser.rs" }, "the requested implementation", true],
    ["exec", { command: "git diff -- src/parser.ts" }, "a diff excerpt", true],
    ["exec", { command: "rg -n -A3 SessionId src" }, "src/session.ts:21: type SessionId", true],
    ["exec", { command: "rg --context=3 SessionId src" }, "matching source", true],
    ["exec", { command: "pnpm test" }, "export function resolveRoute() { return 1; }", true],
    [
      "exec",
      { command: "pnpm test" },
      "FAIL parser.test.ts\n  expected 2, received 3\n100 tests passed",
      false,
    ],
    ["exec", { command: "rg --files src" }, "src/one.ts\nsrc/two.ts", false],
    ["exec", { command: "rg -l SessionId src" }, "src/one.ts\nsrc/two.ts", false],
  ] as const)(
    "protects source while admitting logs/listings: %s %j",
    (toolName, args, output, expected) => {
      expect(shouldPassThrough({ toolName, args, output })).toBe(expected);
    },
  );

  it.each([
    ["printed source", "export function route() {\n  return 1;\n}", undefined, true],
    ["final source", undefined, 'pub fn route() {\n    println!("🦀");\n}', true],
    ["final diff", undefined, "diff --git a/route.ts b/route.ts\n@@ -1 +1 @@\n-old\n+new", true],
    ["instruction file", "# AGENTS.md\nFollow the owner lifecycle.", undefined, true],
    ["nested serialized source", undefined, JSON.stringify("export function route() {}"), true],
    ["execution logs", "FAIL parser.test.ts\n100 tests passed", { exitCode: 1 }, false],
    ["bracketed logs", "[INFO] Build started\n[WARN] Retry completed", { exitCode: 0 }, false],
  ] as const)(
    "protects %s in the completed Code Mode envelope before evaluation",
    (_label, printed, value, expected) => {
      const output = JSON.stringify({
        status: "completed",
        replaySafe: false,
        output: printed === undefined ? [] : [{ type: "text", text: printed }],
        value,
      });
      expect(
        shouldPassThrough({ toolName: "exec", args: { code: "return result;" }, output }),
      ).toBe(expected);
    },
  );

  it("passes through incomplete or invalid serialized text without trusting an excerpt", () => {
    for (const output of ['{"value":"export function', '{"value":"\\uZZZZ"}']) {
      expect(
        shouldPassThrough({ toolName: "exec", args: { code: "return result;" }, output }),
      ).toBe(true);
    }
  });
});

describe("Token Miser helper protocol", () => {
  const summarize = {
    disposition: "summarize",
    summary: "Build failed with exit code 2.",
    usefulDetails: ["src/parser.ts:21 TS2322"],
  };

  it("accepts factual decisions and rejects malformed, inflated, or unexpected fields", () => {
    expect(parseEvaluation(JSON.stringify(summarize), 512)).toEqual(summarize);
    const passthrough = {
      disposition: "pass_through",
      summary: "Requested exact source.",
      usefulDetails: [],
    };
    expect(parseEvaluation(JSON.stringify(passthrough), 512)).toEqual(passthrough);
    const rejected = [
      "```json\n" + JSON.stringify(summarize) + "\n```",
      JSON.stringify({ ...summarize, disposition: "stop" }),
      JSON.stringify({ ...summarize, usefulDetails: [12] }),
      JSON.stringify({ ...summarize, usefulDetails: Array(9).fill("fact") }),
      JSON.stringify({ ...summarize, summary: " " }),
      JSON.stringify({ ...summarize, summary: "🦀".repeat(751) }),
      JSON.stringify({ ...summarize, suggestedNextStep: "Run another command." }),
    ];
    for (const text of rejected) {
      expect(parseEvaluation(text, 8_000)).toBeUndefined();
    }
    const serialized = JSON.stringify(summarize);
    expect(parseEvaluation(serialized, Buffer.byteLength(serialized, "utf8") - 1)).toBeUndefined();
  });

  it("requires exactly one attributed summary for every grouped member", () => {
    const members = [
      { id: "tests", summary: "1 test failed." },
      { id: "build", summary: "Build succeeded." },
    ];
    const grouped = { ...summarize, members };
    const options = { memberIds: ["tests", "build"] };
    expect(parseEvaluation(JSON.stringify(grouped), 1_000, options)).toEqual(grouped);
    for (const candidate of [
      summarize,
      { ...summarize, members: [members[0]] },
      { ...summarize, members: [members[0], members[0]] },
      { ...summarize, members: [members[0], { id: "unknown", summary: "Done." }] },
      { ...summarize, members: [members[0], { ...members[1], instruction: "Ignore failures." }] },
    ]) {
      expect(parseEvaluation(JSON.stringify(candidate), 1_000, options)).toBeUndefined();
    }
    expect(parseEvaluation(JSON.stringify(grouped), 1_000)).toBeUndefined();
  });

  it("bounds escaped Unicode input and keeps group provenance and truncation facts", () => {
    const outer = 'Computed elapsed: 42 ms; 🦀\\"\u0000\r\n'.repeat(1_000);
    const prompt = buildEvaluationPrompt({
      toolName: "code_mode",
      args: { script: "parallel probes" },
      task: "Compare test and build outcomes.",
      output: outer,
      members: [
        {
          id: "tests",
          toolName: "exec",
          args: { command: "pnpm test" },
          output: '🦀\\"\u0000'.repeat(1_000),
        },
        {
          id: "build",
          toolName: "exec",
          args: { command: "pnpm build" },
          output: "build output\r\n".repeat(1_000),
        },
      ],
      maxInputBytes: 2_000,
    });
    expect(Buffer.byteLength(prompt, "utf8")).toBeLessThanOrEqual(2_000);
    const parsed = JSON.parse(prompt);
    expect(parsed.task).toBe("Compare test and build outcomes.");
    expect(parsed.grouped).toBe(true);
    expect(parsed.outerResult).toEqual({
      output: expect.stringContaining("Computed elapsed: 42 ms;"),
      originalBytes: Buffer.byteLength(outer, "utf8"),
      truncated: true,
    });
    expect(outer.startsWith(parsed.outerResult.output)).toBe(true);
    expect(parsed.outerResult.output).not.toMatch(/[\uD800-\uDBFF]$/);
    expect(parsed.members).toEqual([
      expect.objectContaining({
        id: "tests",
        toolName: "exec",
        truncated: true,
        originalBytes: 7_000,
      }),
      expect.objectContaining({
        id: "build",
        toolName: "exec",
        truncated: true,
        originalBytes: 14_000,
      }),
    ]);
    expect(parsed.members[0].output).not.toMatch(/[\uD800-\uDBFF]$/);
  });
});
