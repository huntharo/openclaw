import type { ApiQuotaError } from "openclaw/plugin-sdk/retry-runtime";
import type { SqliteWorkerCommand } from "openclaw/plugin-sdk/sqlite-runtime";
import type { generateReportPeriods } from "./run.js";
import type { TeamReportsOperations } from "./store-contract.js";
import type { SummaryLlm } from "./summaries.js";
import type { GithubReadStats, Person, SourceRuntime } from "./types.js";

export type ReportRunRequest = Omit<Parameters<typeof generateReportPeriods>[0], "sources">;
export type ReportWorkerInput = Pick<
  ReportRunRequest,
  "config" | "resolved" | "periods" | "reuseCollectedDays"
>;
export type ReportWorkerLog = {
  level: keyof SourceRuntime["logger"];
  message: string;
  meta?: Record<string, unknown>;
};
export type ReportWorkerOperation =
  | { kind: "store"; command: SqliteWorkerCommand<TeamReportsOperations> }
  | { kind: "llm"; params: Parameters<SummaryLlm["complete"]>[0] & { signal?: never } }
  | { kind: "github-read"; path: string }
  | { kind: "flush" };
export type ReportWorkerRequest = ReportWorkerOperation & {
  logs: ReportWorkerLog[];
  roster?: Person[];
};
export type ReportWorkerResponse = (
  | { ok: true; value: unknown }
  | { ok: false; error: string; quota?: ReportQuotaFailure }
) & { githubStats?: GithubReadStats };
export type ReportGithubResponse = {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
};
type ReportQuotaFailure = Pick<
  ApiQuotaError,
  "reason" | "retryAtMs" | "upstreamStatus" | "resource"
>;
export const REPORT_RUN_TIMEOUT_MS = 45 * 60_000;
