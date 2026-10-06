import { serveWorkerTasks } from "openclaw/plugin-sdk/worker-task-server";
import type {
  ReportWorkerInput,
  ReportWorkerRequest,
  ReportWorkerResponse,
  ReportGithubResponse,
} from "./run-worker-contract.js";

serveWorkerTasks(async (value, channel) => {
  if (!channel) {
    throw new Error("Missing fixture channel");
  }
  // SAFETY: The test runner owns the fixture input and paired host responses.
  const input = value as ReportWorkerInput;
  if (input.config.github.orgs.some((org) => org === "quota-fixture" || org === "store-fixture")) {
    const reply = await channel.request({
      kind: "github-read",
      path: "repos/example/app/pulls/23",
      logs: [],
    });
    const result = reply.input as ReportWorkerResponse;
    reply.consumed();
    const failure = result.ok ? undefined : result.quota;
    const body = result.ok ? JSON.parse((result.value as ReportGithubResponse).body) : undefined;
    return {
      github: {
        ok: result.ok,
        stale: !result.ok,
        warnings: [],
        stats: {
          retryAt: failure?.retryAtMs ?? 0,
          apiCalls: result.githubStats?.apiCalls ?? 0,
          headSha: body?.head?.sha ?? "",
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
