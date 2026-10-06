import { serveWorkerTasks } from "openclaw/plugin-sdk/worker-task-server";
import type {
  ReportWorkerInput,
  ReportWorkerRequest,
  ReportWorkerResponse,
  ReportQuotaFailure,
} from "./run-worker-contract.js";

serveWorkerTasks(async (value, channel) => {
  if (!channel) {
    throw new Error("Missing fixture channel");
  }
  // SAFETY: The test runner owns the fixture input and paired host responses.
  const input = value as ReportWorkerInput;
  if (input.config.github.orgs.includes("quota-fixture")) {
    const reply = await channel.request({ kind: "github-quota", resource: "core", logs: [] });
    const result = reply.input as ReportWorkerResponse;
    reply.consumed();
    const failure = result.ok ? (result.value as ReportQuotaFailure | null) : null;
    return {
      github: {
        ok: !failure,
        stale: Boolean(failure),
        warnings: [],
        stats: {
          retryAt: failure?.retryAtMs ?? 0,
        },
      },
    };
  }
  const request: ReportWorkerRequest = {
    kind: "llm",
    params: { messages: [{ role: "user", content: "Synthetic report" }], purpose: "fixture" },
    logs: [],
  };
  const response = await channel.request(request);
  response.consumed();
  return {};
});
