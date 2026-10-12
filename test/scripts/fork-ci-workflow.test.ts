import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import {
  evaluateWorkflowExpression,
  readWorkflow,
  readWorkflowOutputs,
  runWorkflowShellScript,
} from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each([
  [false, "", true],
  [true, "", false],
  [true, "github", true],
] as const)("routes full CI for fork=%s backend=%s", (fork, runnerBackend, enabled) => {
  const workflow = readWorkflow(".github/workflows/ci.yml");
  for (const eventName of ["pull_request", "push", "workflow_dispatch"] as const) {
    for (const job of ["preflight", "security-fast", "ci-gate"]) {
      expect(
        evaluateWorkflowExpression(workflow.jobs[job].if, {
          eventName,
          repository: fork ? "example/openclaw" : "openclaw/openclaw",
          runnerBackend,
          ciOnPush: "true",
          runAttempt: 1,
          githubEvent: { repository: { fork }, pull_request: { draft: false } },
        }),
        `${eventName}: ${job}`,
      ).toBe(enabled);
    }
  }
});

it.each([
  [false, "", "", true],
  [true, "", "", false],
  [true, "synthetic-primary", "", true],
  [true, "", "synthetic-fallback", true],
] as const)(
  "admits Labeler for fork=%s with available App keys",
  (fork, primary, fallback, enabled) => {
    const workflow = readWorkflow(".github/workflows/labeler.yml");
    const root = tempDirs.make("fork-labeler-");
    const output = path.join(root, "output");
    const summary = path.join(root, "summary");
    const result = runWorkflowShellScript(workflow.jobs.availability.steps[0].run, {
      cwd: root,
      env: {
        IS_FORK: String(fork),
        PRIMARY_KEY: primary,
        FALLBACK_KEY: fallback,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readWorkflowOutputs(output)).toEqual({ enabled: String(enabled) });
    if (!enabled) {
      expect(readFileSync(summary, "utf8")).toContain("neither GitHub App private key");
    }
    for (const [job, eventName] of [
      ["label", "pull_request_target"],
      ["label-issues", "issues"],
      ["backfill-pr-labels", "workflow_dispatch"],
    ] as const) {
      expect(workflow.jobs[job].needs).toBe("availability");
      const raw = workflow.jobs[job].if.trim();
      expect(
        evaluateWorkflowExpression(raw.startsWith("${{") ? raw : `\${{ ${raw} }}`, {
          eventName,
          repository: "example/openclaw",
          runAttempt: 1,
          githubEvent: { action: "opened" },
          additionalNeeds: { availability: { outputs: { enabled: String(enabled) } } },
        }),
        job,
      ).toBe(enabled);
    }
  },
);

it("runs the basic workflow only in fork repositories", () => {
  const workflow = readWorkflow(".github/workflows/fork-ci.yml");
  for (const fork of [false, true]) {
    expect(
      evaluateWorkflowExpression(`\${{ ${workflow.jobs.checks.if} }}`, {
        eventName: "pull_request",
        repository: fork ? "example/openclaw" : "openclaw/openclaw",
        runAttempt: 1,
        githubEvent: { repository: { fork } },
      }),
    ).toBe(fork);
  }
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.jobs.checks["runs-on"]).toBe("ubuntu-24.04");
});
