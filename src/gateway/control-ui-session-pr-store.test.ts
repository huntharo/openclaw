import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { apiStoreRequestKey, getSharedApiStore } from "../infra/http-api-quota.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createControlUiSessionPullRequestSubscriptions } from "./control-ui-session-pr-subscriptions.js";
import { loadControlUiSessionPullRequests } from "./control-ui-session-prs.js";
import {
  createSessionPullRequestsFixture,
  githubJson,
  pullListItem,
  requestUrl,
  testGitContext,
} from "./control-ui-session-prs.test-support.js";
import { gitHubPublicApi } from "./github-public-api.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";

const fixture = createSessionPullRequestsFixture();
let active: ReturnType<typeof createControlUiSessionPullRequestSubscriptions> | undefined;
beforeEach(() => {
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
});
afterEach(async () => {
  await active?.stop();
  active = undefined;
  vi.unstubAllEnvs();
});

describe("shared PR facts and session projections", () => {
  it("reprojects a canonical change while a first load is waiting on another PR", async () => {
    const firstProjected = createDeferred();
    const siblingResponse = createDeferred<Response>();
    const firstPull = pullListItem();
    const siblingPull = pullListItem({
      number: 103470,
      html_url: "https://github.com/openclaw/openclaw/pull/103470",
      head: { sha: "b".repeat(40), ref: testGitContext.branch },
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(requestUrl(input)).pathname;
      if (path.endsWith("/pulls")) {
        return githubJson([firstPull, siblingPull]);
      }
      if (path.endsWith("/pulls/103469")) {
        return githubJson({ ...firstPull, additions: 4, deletions: 3, changed_files: 2 });
      }
      if (path.endsWith("/pulls/103470")) {
        return siblingResponse.promise;
      }
      if (path.endsWith("/check-runs")) {
        return githubJson({ total_count: 0, check_runs: [] });
      }
      throw new Error(`Unexpected fixture request: ${path}`);
    });
    const store = getSharedApiStore({ apiBaseUrl: "https://api.github.com", fetchImpl });
    const facts = gitHubPublicApi.getGitHubPullRequestStore(store);
    const project = facts.project.bind(facts);
    const projection = vi
      .spyOn(facts, "project")
      .mockImplementation((owner, repo, number, value) => {
        const observed = project(owner, repo, number, value);
        if (number === 103469 && value.additions === 4) {
          firstProjected.resolve();
        }
        return observed;
      });
    const broadcastToConnIds = vi.fn<GatewayBroadcastToConnIdsFn>();
    const session = "agent:main:store-pending-sibling";
    active = createControlUiSessionPullRequestSubscriptions({
      scheduler: createTestGatewayScheduler(),
      prepareRead: fixture.prepareRead,
      broadcastToConnIds,
      load: (params, signal, read) =>
        loadControlUiSessionPullRequests(params, {
          read,
          cacheSignal: signal,
          fetchImpl,
          resolveGitContext: async () => testGitContext,
        }),
    });
    const pending = active.replace("viewer", [session]);
    try {
      // The first PR has been projected; its sibling still prevents installing lastGood.
      await firstProjected.promise;
      const listRequest = fetchImpl.mock.calls.find(([input]) =>
        new URL(requestUrl(input)).pathname.endsWith("/pulls"),
      );
      expect(listRequest).toBeDefined();
      await store.responses.remember(
        apiStoreRequestKey(requestUrl(listRequest![0]), "GET", "jq:publication-projection"),
        githubJson([
          {
            url: firstPull.html_url,
            state: "closed",
            headSha: "a".repeat(40),
            headRef: testGitContext.branch,
            baseRef: "main",
          },
        ]),
      );
      siblingResponse.resolve(githubJson(siblingPull));
      await pending;
      const snapshots = broadcastToConnIds.mock.calls.map(([, payload]) => payload);
      expect(snapshots.length).toBeGreaterThan(0);
      for (const snapshot of snapshots) {
        expect(snapshot).toMatchObject({
          sessions: {
            [session]: {
              pullRequests: expect.arrayContaining([
                expect.objectContaining({ number: 103469, state: "closed" }),
              ]),
            },
          },
        });
      }
      // Re-projection consumes accepted responses rather than repeating the forced observation.
      expect(fetchImpl).toHaveBeenCalledTimes(5);
    } finally {
      siblingResponse.resolve(githubJson(siblingPull));
      await pending;
      projection.mockRestore();
    }
  });

  it("a newly discovered reader PR retires an empty branch lookup", async () => {
    let exists = false;
    const pull = pullListItem({
      head: {
        sha: "a".repeat(40),
        ref: testGitContext.branch,
        repo: { owner: { login: testGitContext.owner } },
      },
    });
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(requestUrl(input)).pathname;
      if (path.endsWith("/pulls")) {
        return githubJson(exists ? [pull] : []);
      }
      if (path.endsWith("/pulls/103469")) {
        return githubJson(pull);
      }
      if (path.endsWith("/check-runs")) {
        return githubJson({ total_count: 0, check_runs: [] });
      }
      throw new Error(`Unexpected fixture request: ${path}`);
    });
    const updated = createDeferred();
    let awaitingUpdate = false;
    const broadcastToConnIds = vi.fn<GatewayBroadcastToConnIdsFn>(() => {
      if (awaitingUpdate) {
        updated.resolve();
      }
    });
    active = createControlUiSessionPullRequestSubscriptions({
      scheduler: createTestGatewayScheduler(),
      prepareRead: fixture.prepareRead,
      broadcastToConnIds,
      load: (params, signal, read) =>
        loadControlUiSessionPullRequests(params, {
          read,
          cacheSignal: signal,
          fetchImpl,
          resolveGitContext: async () => testGitContext,
        }),
    });
    await active.replace("viewer", ["agent:main:store-empty"]);
    expect(broadcastToConnIds.mock.calls[0]?.[1]).toMatchObject({
      sessions: { "agent:main:store-empty": { pullRequests: [] } },
    });
    exists = true;
    awaitingUpdate = true;
    await gitHubPublicApi.readGitHubJsonResponse(
      await gitHubPublicApi.fetchGitHubApi(
        "https://api.github.com/repos/openclaw/openclaw/pulls/103469",
        fetchImpl,
      ),
    );
    await updated.promise;
    expect(broadcastToConnIds.mock.calls.at(-1)?.[1]).toMatchObject({
      sessions: {
        "agent:main:store-empty": {
          pullRequests: expect.arrayContaining([expect.objectContaining({ number: 103469 })]),
        },
      },
    });
    expect(
      fetchImpl.mock.calls.filter(([url]) => new URL(requestUrl(url)).pathname.endsWith("/pulls")),
    ).toHaveLength(2);
  });
  it("five sessions share discovery and a reader refresh updates every subscribed session", async () => {
    const sessions = Array.from({ length: 5 }, (_, index) => `agent:main:store-${index}`);
    let state = "open";
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(requestUrl(input)).pathname;
      if (path.endsWith("/pulls")) {
        return githubJson([pullListItem({ state })]);
      }
      if (path.endsWith("/pulls/103469")) {
        return githubJson(pullListItem({ state, additions: 4, deletions: 3, changed_files: 2 }));
      }
      if (path.endsWith("/check-runs")) {
        return githubJson({ total_count: 0, check_runs: [] });
      }
      throw new Error(`Unexpected fixture request: ${path}`);
    });
    const received = new Map<string, unknown>();
    const updated = createDeferred();
    let awaitingUpdate = false;
    const broadcastToConnIds = vi.fn<GatewayBroadcastToConnIdsFn>((_event, payload) => {
      for (const [session, snapshot] of Object.entries(
        asOptionalRecord(asOptionalRecord(payload)?.sessions) ?? {},
      )) {
        received.set(session, snapshot);
      }
      if (awaitingUpdate && sessions.every((session) => received.has(session))) {
        updated.resolve();
      }
    });
    active = createControlUiSessionPullRequestSubscriptions({
      scheduler: createTestGatewayScheduler(),
      prepareRead: fixture.prepareRead,
      broadcastToConnIds,
      load: (params, signal, read) =>
        loadControlUiSessionPullRequests(params, {
          read,
          cacheSignal: signal,
          fetchImpl,
          resolveGitContext: async () => testGitContext,
        }),
    });
    await active.replace("viewer", sessions);
    expect(received.size).toBe(5);
    for (const snapshot of received.values()) {
      expect(snapshot).toMatchObject({ pullRequests: [{ state: "open" }] });
    }
    expect(
      fetchImpl.mock.calls.filter(([url]) => new URL(requestUrl(url)).pathname.endsWith("/pulls")),
    ).toHaveLength(1);
    expect(
      fetchImpl.mock.calls.filter(([url]) =>
        new URL(requestUrl(url)).pathname.endsWith("/pulls/103469"),
      ),
    ).toHaveLength(1);
    state = "closed";
    received.clear();
    awaitingUpdate = true;
    const response = await gitHubPublicApi.fetchGitHubApi(
      "https://api.github.com/repos/openclaw/openclaw/pulls/103469",
      fetchImpl,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { refresh: true },
    );
    await gitHubPublicApi.readGitHubJsonResponse(response);
    await updated.promise;
    expect(received.size).toBe(5);
    for (const snapshot of received.values()) {
      expect(snapshot).toMatchObject({ pullRequests: [{ state: "closed" }] });
    }
    expect(
      fetchImpl.mock.calls.filter(([url]) => new URL(requestUrl(url)).pathname.endsWith("/pulls")),
    ).toHaveLength(1);
    expect(
      fetchImpl.mock.calls.filter(([url]) =>
        new URL(requestUrl(url)).pathname.endsWith("/pulls/103469"),
      ),
    ).toHaveLength(2);
  });
});
