import { WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import { ApiQuotaError, getSharedApiQuota } from "openclaw/plugin-sdk/retry-runtime";
import {
  REPORT_RUN_TIMEOUT_MS,
  type ReportRunRequest,
  type ReportWorkerInput,
  type ReportWorkerRequest,
  type ReportWorkerResponse,
} from "./run-worker-contract.js";
import type { SourceStatus } from "./types.js";

export class TeamReportsRunner {
  private readonly pool;
  private readonly requests = new Set<Promise<unknown>>();

  constructor(workerUrl: URL) {
    // Long network collection owns one ordered worker, not a shared CPU permit.
    this.pool = new WorkerTaskPool<ReportWorkerInput, Record<string, SourceStatus>>({
      workerUrl,
      maxWorkers: 1,
      maxPendingTasks: 1,
    });
  }

  async run(params: ReportRunRequest): Promise<Record<string, SourceStatus>> {
    const deadline = Date.now() + REPORT_RUN_TIMEOUT_MS;
    const githubQuota = getSharedApiQuota({
      apiBaseUrl: params.resolved.github.apiBaseUrl,
      token: params.resolved.github.token,
    });
    const githubAdmissions = new Map<string, Set<() => void>>();
    try {
      return await this.pool.run(
        {
          config: params.config,
          resolved: params.resolved,
          periods: params.periods,
          reuseCollectedDays: params.reuseCollectedDays,
        },
        {
          signal: params.runtime.signal,
          timeoutMs: REPORT_RUN_TIMEOUT_MS,
          onRequest: (value, { signal }) => {
            // SAFETY: The private worker owns this protocol; source responses never dispatch host calls.
            const request = value as ReportWorkerRequest;
            const pending = (async () => {
              signal.throwIfAborted();
              for (const log of request.logs) {
                params.runtime.logger[log.level]?.(log.message, log.meta);
              }
              if (request.roster) {
                params.onRoster(request.roster);
              }
              let response: ReportWorkerResponse;
              try {
                if (request.kind === "github-quota") {
                  let failure: ApiQuotaError | undefined;
                  try {
                    if (request.release) {
                      const admissions = githubAdmissions.get(request.resource);
                      const release = admissions?.values().next().value;
                      if (release) {
                        release();
                        admissions?.delete(release);
                      }
                    } else if (request.observation) {
                      const { status, headers, rateLimited } = request.observation;
                      failure = githubQuota.observe(
                        new Response(null, { status, headers }),
                        request.resource,
                        rateLimited,
                      );
                    } else {
                      const release = githubQuota.admit(request.resource);
                      const admissions = githubAdmissions.get(request.resource) ?? new Set();
                      admissions.add(release);
                      githubAdmissions.set(request.resource, admissions);
                    }
                  } catch (error) {
                    if (!(error instanceof ApiQuotaError)) {
                      throw error;
                    }
                    failure = error;
                  }
                  response = {
                    ok: true,
                    value: failure
                      ? {
                          reason: failure.reason,
                          retryAtMs: failure.retryAtMs,
                          upstreamStatus: failure.upstreamStatus,
                          resource: failure.resource,
                        }
                      : null,
                  };
                } else {
                  const result =
                    request.kind === "store"
                      ? await params.store.execute(request.command.type, request.command.input, {
                          signal,
                        })
                      : request.kind === "llm"
                        ? await params.llm.complete({ ...request.params, signal })
                        : undefined;
                  response = { ok: true, value: result };
                }
              } catch (error) {
                response = {
                  ok: false,
                  error: error instanceof Error ? error.message : String(error),
                };
              }
              signal.throwIfAborted();
              return { input: response, timeoutMs: Math.max(1, deadline - Date.now()) };
            })();
            this.requests.add(pending);
            void pending.finally(() => this.requests.delete(pending)).catch(() => {});
            return pending;
          },
        },
      );
    } finally {
      // Pool retirement joins the isolate; accepted host writes and LLM cleanup also need settlement.
      await Promise.allSettled(this.requests);
      for (const admissions of githubAdmissions.values()) {
        for (const release of admissions) {
          release();
        }
      }
    }
  }

  async close(): Promise<void> {
    try {
      await this.pool.close();
    } finally {
      await Promise.allSettled(this.requests);
    }
  }
}
