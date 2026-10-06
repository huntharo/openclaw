import { describe, expect, it, vi } from "vitest";
import {
  createGitHubAsyncCommandQuota,
  createGitHubCommandQuota,
} from "../../scripts/lib/github-command-quota.mjs";
import { getSharedApiStore } from "../../src/infra/http-api-quota.js";

const apiBaseUrl = "https://api.github.com";
const endpoint = "repos/example/project/pulls/23";
const args = ["api", endpoint];
function http(body: string, status = 200, headers: Record<string, string> = {}) {
  return `HTTP/2.0 ${status}\r\n${Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join("")}\r\n${body}`;
}

describe("GitHub CLI shared API ownership", () => {
  it("coalesces async callers, publishes facts, and lets sync callers reuse their observation", async () => {
    const env = { GH_TOKEN: "synthetic-cli-shared-read" };
    const store = getSharedApiStore({ apiBaseUrl, token: env.GH_TOKEN });
    const observations: unknown[] = [];
    const unsubscribe = store.responses.subscribe((change) => observations.push(change.value));
    let started!: () => void;
    let finish!: () => void;
    const dispatched = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const value = { number: 23, state: "open", head: { sha: "current" } };
    const runGhAsync = vi.fn(async () => {
      started();
      await blocked;
      return http(JSON.stringify(value));
    });
    const options = { env, hostname: "github.com", runGhAsync };
    const first = await createGitHubAsyncCommandQuota(options);
    const second = await createGitHubAsyncCommandQuota(options);
    const runGh = vi.fn(() => http('{"state":"closed"}'));
    const sync = await createGitHubCommandQuota({ env, hostname: "github.com", runGh });
    try {
      const pending = first(args);
      await dispatched;
      const joined = second(args);
      expect(sync(args).error?.message).toContain("already in progress");
      expect(runGh).not.toHaveBeenCalled();
      finish();
      expect(await Promise.all([pending, joined])).toEqual([
        { body: JSON.stringify(value), error: undefined },
        { body: JSON.stringify(value), error: undefined },
      ]);
      expect(sync(args)).toEqual({ body: JSON.stringify(value), error: undefined });
      expect(runGhAsync).toHaveBeenCalledTimes(1);
      expect(runGh).not.toHaveBeenCalled();
      expect(observations).toEqual([value]);
    } finally {
      finish();
      unsubscribe();
    }
  });

  it("keeps jq representations separate and honors a forced fresh read", async () => {
    const env = { GH_TOKEN: "synthetic-cli-representations" };
    const runGhAsync = vi.fn(async (command: string[]) =>
      http(command.includes("--jq") ? "" : JSON.stringify({ state: "open" })),
    );
    const read = await createGitHubAsyncCommandQuota({ env, hostname: "github.com", runGhAsync });
    expect((await read(args)).body).toBe('{"state":"open"}');
    expect((await read([...args, "--jq", ".jobs[] | @json"])).body).toBe("");
    expect((await read(args)).body).toBe('{"state":"open"}');
    await read([...args, "-H", "Cache-Control: max-age=0"]);
    expect(runGhAsync).toHaveBeenCalledTimes(3);
  });

  it("invalidates repository facts after each accepted mutation without replaying mutations", async () => {
    const env = { GH_TOKEN: "synthetic-cli-mutation" };
    let state = "open";
    const runGhAsync = vi.fn(async (command: string[]) => {
      if (command.includes("POST")) {
        state = "closed";
      }
      return http(JSON.stringify({ number: 23, state }));
    });
    const read = await createGitHubAsyncCommandQuota({ env, hostname: "github.com", runGhAsync });
    expect((await read(args)).body).toContain('"open"');
    const mutate = ["api", "repos/example/project/issues/23", "-X", "POST"];
    await read(mutate);
    await read(mutate);
    expect((await read(args)).body).toContain('"closed"');
    expect(runGhAsync).toHaveBeenCalledTimes(4);
  });

  it.each(["async", "sync"])(
    "retains %s page boundaries and stops all callers after a secondary limit",
    async (transport) => {
      const env = { GH_TOKEN: `synthetic-cli-pages-and-secondary-${transport}` };
      const second = `${apiBaseUrl}/repos/example/project/pulls?page=2`;
      const run = vi.fn((command: string[]) => {
        if (command.includes(second)) {
          return http('[{"number":24}]');
        }
        if (command.includes(endpoint)) {
          const output = http('{"message":"secondary rate limit"}', 403, { "Retry-After": "120" });
          throw Object.assign(new Error("gh: secondary rate limit (HTTP 403)"), { stdout: output });
        }
        return http('[{"number":23}]', 200, { Link: `<${second}>; rel="next"` });
      });
      const read =
        transport === "async"
          ? await createGitHubAsyncCommandQuota({
              env,
              hostname: "github.com",
              runGhAsync: async (command: string[]) => run(command),
            })
          : await createGitHubCommandQuota({ env, hostname: "github.com", runGh: run });
      expect((await read(["api", "repos/example/project/pulls", "--paginate"])).body).toBe(
        '[{"number":23}]\n[{"number":24}]',
      );
      await expect(Promise.resolve().then(() => read(args))).rejects.toMatchObject({
        reason: "upstream",
        upstreamStatus: 403,
      });
      await expect(
        Promise.resolve().then(() => read(["api", "repos/example/project/actions/runs"])),
      ).rejects.toMatchObject({
        reason: "upstream",
        upstreamStatus: 403,
      });
      expect(run).toHaveBeenCalledTimes(3);
    },
  );
});
