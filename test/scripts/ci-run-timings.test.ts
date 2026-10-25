import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectRunJobsFromPages,
  isRetryableGhJsonErrorMessage,
  parseRunTimingArgs,
  selectLatestMainPushCiRun,
  summarizeRunTimings,
} from "../../scripts/ci-run-timings.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const timestamp = (time: string) => `2026-04-22T${time}Z`;
const completedRun = {
  conclusion: "success",
  createdAt: timestamp("10:00:00"),
  status: "completed",
  updatedAt: timestamp("10:01:30"),
};
const timingJob = (name: string, start: string, end: string, conclusion = "success") => ({
  name,
  conclusion,
  status: "completed",
  startedAt: timestamp(start),
  completedAt: timestamp(end),
});
const run = (databaseId: number, event: string, headSha: string) => ({
  databaseId,
  event,
  headSha,
});
const timingDefaults = {
  compareHours: 12,
  detailRuns: 100,
  explicitRunId: undefined,
  json: false,
  limit: 15,
  outputPath: null,
  recentLimit: null,
  trendHours: null,
  useLatestMain: false,
};
describe("scripts/ci-run-timings.mjs", () => {
  it("separates start delay from job duration without mislabeling dependency wait", () => {
    const summary = summarizeRunTimings(
      {
        ...completedRun,
        jobs: [
          timingJob("slow", "10:00:20", "10:01:20"),
          timingJob("queued", "10:00:50", "10:01:00"),
          timingJob("matrix.check_name", "10:00:01", "10:00:01", "skipped"),
        ],
      },
      2,
    );

    expect(summary.wallSeconds).toBe(90);
    expect(summary.byDuration.map((job) => [job.name, job.durationSeconds])).toEqual([
      ["slow", 60],
      ["queued", 10],
    ]);
    expect(summary.byStartDelay.map((job) => [job.name, job.startDelaySeconds])).toEqual([
      ["queued", 50],
      ["slow", 20],
    ]);
  });

  it("rejects empty CI job payloads instead of printing empty timing evidence", () => {
    expect(() => summarizeRunTimings({ ...completedRun, jobs: [] })).toThrow(
      "CI run timing summary requires at least one job",
    );
  });

  it.each([
    [
      "exact SHA",
      [run(3, "issue_comment", "current"), run(2, "push", "older"), run(1, "push", "current")],
      run(1, "push", "current"),
    ],
    [
      "newest push fallback",
      [run(4, "issue_comment", "current"), run(3, "push", "previous")],
      run(3, "push", "previous"),
    ],
  ])("selects the %s CI run", (_mode, runs, expected) => {
    expect(selectLatestMainPushCiRun(runs, "current")).toEqual(expected);
  });

  it("normalizes paginated GitHub Actions job payloads", () => {
    const defaults = {
      createdAt: null,
      labels: [],
      runnerGroupName: null,
      runnerName: null,
    };
    const restJob = {
      id: 101,
      name: "preflight",
      conclusion: "success",
      status: "completed",
      started_at: timestamp("13:25:16"),
      completed_at: timestamp("13:26:16"),
    };
    const graphqlJob = {
      databaseId: 102,
      ...timingJob("ci-timings-summary", "13:27:00", "13:28:00", "failure"),
    };
    expect(collectRunJobsFromPages([{ jobs: [restJob] }, { jobs: [graphqlJob] }])).toEqual([
      {
        ...defaults,
        databaseId: 101,
        ...timingJob("preflight", "13:25:16", "13:26:16"),
      },
      { ...defaults, ...graphqlJob },
    ]);
  });

  it("retries transient GitHub API failures while preserving auth failures", () => {
    for (const message of [
      "Command failed: gh api repos/openclaw/openclaw/actions/runs/1/jobs\nHTTP 502",
      "read ECONNRESET",
    ]) {
      expect(isRetryableGhJsonErrorMessage(message)).toBe(true);
    }

    expect(
      isRetryableGhJsonErrorMessage("gh: Resource not accessible by integration (HTTP 403)"),
    ).toBe(false);
    for (const message of [
      "gh: API secondary rate limit exceeded (HTTP 403)",
      "gh: HTTP 429: too many requests",
      "gh: abuse detection mechanism",
    ]) {
      expect(isRetryableGhJsonErrorMessage(message)).toBe(false);
    }
  });

  it.each([
    ["HTTP 429 with a non-JSON error body", "api-429"],
    ["a secondary limit without Retry-After", "api-secondary"],
    ["a throttled run lookup", "run-limit"],
    ["primary quota exhaustion before the next job page", "primary"],
  ])("stops further gh dispatches after %s", (_name, mode) => {
    const fixtureDir = tempDirs.make("openclaw-ci-timings-quota-");
    const fakeGhPath = path.join(fixtureDir, "gh");
    const callsPath = path.join(fixtureDir, "calls.jsonl");
    const waitsPath = path.join(fixtureDir, "waits.jsonl");
    const clockPath = path.join(fixtureDir, "clock.mjs");
    writeFileSync(waitsPath, "");
    writeFileSync(
      clockPath,
      `import { appendFileSync } from "node:fs";
process.env.GH_TOKEN = "fixture-ci-quota-token";
const wait = Atomics.wait;
Atomics.wait = (array, index, value, timeout) => {
  if (![1000, 3000, 6000].includes(timeout)) return wait(array, index, value, timeout);
  appendFileSync(${JSON.stringify(waitsPath)}, JSON.stringify(timeout) + "\\n");
  return wait(array, index, value, 0);
};
`,
    );
    writeFileSync(
      fakeGhPath,
      `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
const endpoint = args.find(arg => arg.startsWith("repos/")) ?? "";
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
if (args[0] === "api" && endpoint.endsWith("/actions/runs/123")) {
  if (mode === "run-limit") {
    console.error("gh: abuse detection mechanism (HTTP 403)");
    process.exit(1);
  }
  console.log(JSON.stringify({ status: "completed", conclusion: "success", createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:01:00Z" }));
} else if (args[0] === "api") {
  if (mode === "primary") {
    if (args.includes("--include")) console.log("HTTP/2.0 200 OK\\nx-ratelimit-remaining: 0\\nx-ratelimit-reset: " + (Math.floor(Date.now() / 1000) + 7200) + "\\n");
    console.log(JSON.stringify({ total_count: 2, jobs: [{ id: 1, name: "checks", status: "completed", conclusion: "success", started_at: "2026-09-01T00:00:10Z", completed_at: "2026-09-01T00:00:40Z" }] }));
  } else {
    const status = mode === "api-429" ? 429 : 403;
    if (args.includes("--include")) console.log("HTTP/2.0 " + status + " Forbidden\\n" + (status === 429 ? "retry-after: 7200\\n" : "") + "\\n");
    console.log(status === 429 ? "<html>Too many requests</html>" : JSON.stringify({ message: "You have exceeded a secondary rate limit." }));
    console.error(status === 429 ? "gh: too many requests (HTTP 429)" : "gh: secondary rate limit (HTTP 403)");
    process.exit(1);
  }
} else {
  process.exit(2);
}
`,
    );
    chmodSync(fakeGhPath, 0o755);
    const result = spawnSync(
      process.execPath,
      ["--import", pathToFileURL(clockPath).href, "scripts/ci-run-timings.mjs", "123"],
      {
        cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
        encoding: "utf8",
        env: {
          ...process.env,
          GH_HOST: "github.com",
          OPENCLAW_GH_BIN: fakeGhPath,
        },
      },
    );
    const calls: string[][] = readFileSync(callsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      calls.filter((args) =>
        args.some((arg) =>
          mode === "run-limit" ? arg.endsWith("/runs/123") : arg.includes("/jobs?"),
        ),
      ),
    ).toHaveLength(1);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("API request quota unavailable");
    expect(readFileSync(waitsPath, "utf8")).toBe("");
  });

  it.each([
    ["--latest-main -- --limit 3", { limit: 3, useLatestMain: true }],
    [
      "--trend-hours=72 --compare-hours 12 --detail-runs=80 --json --output ci-trend.json",
      { detailRuns: 80, json: true, outputPath: "ci-trend.json", trendHours: 72 },
    ],
  ])("parses monitor options: %s", (args, expected) => {
    expect(parseRunTimingArgs(args.split(" "))).toEqual({ ...timingDefaults, ...expected });
  });

  it.each([
    ["--limit 3jobs", "must be a positive integer"],
    ["--limit=0", "must be a positive integer"],
    ["--limit", "requires a value"],
    ["--output=", "requires a value"],
    ["--run-id 123456", "Unknown CI run timing option: --run-id"],
    ["123456 789012", "Unexpected CI run id argument: 789012"],
    ["--recent 3 --latest-main", "--recent cannot be combined"],
    ["123456 --latest-main", "A run id cannot be combined"],
    ["--trend-hours 72 --recent 3", "--trend-hours cannot be combined"],
    ["--trend-hours 23", "must cover at least two"],
    ["--json", "require --trend-hours"],
  ])("rejects monitor arguments: %s", (args, message) => {
    expect(() => parseRunTimingArgs(args.split(" "))).toThrow(message);
  });

  it("excludes manual, failed, and unfinished runs from recent main timings", () => {
    const fixtureDir = mkdtempSync(path.join(tmpdir(), "openclaw-ci-timings-recent-"));
    const fakeGhPath = path.join(fixtureDir, "gh");
    const callsPath = path.join(fixtureDir, "calls.jsonl");
    writeFileSync(
      fakeGhPath,
      `#!${process.execPath}
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
const endpoint = args.find(arg => arg.startsWith("repos/")) ?? "";
appendFileSync(process.env.FIXTURE_CALLS_PATH, JSON.stringify(args) + "\\n");
if (args[0] === "api" && endpoint.includes("/workflows/ci.yml/runs?")) {
  console.log(JSON.stringify({ workflow_runs: [
    { id: 201, event: "workflow_dispatch", head_sha: "manual", status: "completed", conclusion: "success" },
    { id: 202, event: "push", head_sha: "failed", status: "completed", conclusion: "failure" },
    { id: 203, event: "push", head_sha: "running", status: "in_progress", conclusion: "" },
    { id: 204, event: "push", head_sha: "first", status: "completed", conclusion: "success" },
    { id: 205, event: "push", head_sha: "second", status: "completed", conclusion: "success" }
  ] }));
} else if (args[0] === "api" && new RegExp("/actions/runs/[0-9]+$").test(endpoint)) {
  console.log(JSON.stringify({ status: "completed", conclusion: "success", createdAt: "2026-08-31T00:00:00Z", updatedAt: "2026-08-31T00:01:00Z" }));
} else if (args[0] === "api" && args.some((arg) => arg.includes("/jobs?"))) {
  console.log(JSON.stringify({ total_count: 1, jobs: [{ id: 1, name: "checks", status: "completed", conclusion: "success", started_at: "2026-08-31T00:00:10Z", completed_at: "2026-08-31T00:00:40Z" }] }));
} else {
  process.exit(2);
}
`,
    );
    chmodSync(fakeGhPath, 0o755);
    try {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          'data:text/javascript,process.env.GH_TOKEN="fixture-token"',
          "scripts/ci-run-timings.mjs",
          "--recent",
          "2",
        ],
        {
          cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
          encoding: "utf8",
          env: {
            ...process.env,
            GH_HOST: "github.com",
            OPENCLAW_GH_BIN: fakeGhPath,
            FIXTURE_CALLS_PATH: callsPath,
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout.match(/CI run \d+/gu)).toEqual(["CI run 204", "CI run 205"]);
      const calls: string[][] = readFileSync(callsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const listEndpoint = calls[0]?.find((arg) => arg.startsWith("repos/"));
      expect(new URL(listEndpoint!, "https://api.github.com").searchParams.get("event")).toBe(
        "push",
      );
      expect(
        calls.flatMap((args) =>
          args.flatMap((arg) => /\/actions\/runs\/(\d+)$/u.exec(arg)?.[1] ?? []),
        ),
      ).toEqual(["204", "205"]);
      expect(calls.every((args) => args[0] === "api" && args.includes("--include"))).toBe(true);
    } finally {
      rmSync(fixtureDir, { force: true, recursive: true });
    }
  });
});
