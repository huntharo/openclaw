import { apiStoreRequestKey, getSharedApiStore } from "openclaw/plugin-sdk/retry-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadGitHubDetail } from "./detail.js";
import {
  authenticatedFetch,
  file,
  identity,
  item,
  json,
  requestUrl,
  sha,
  target,
} from "./detail.test-support.js";
import { fetchGitHubApi, fetchGitHubJson } from "./github-api.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GitHub detail shared store", () => {
  it("rereads public visibility after another caller caches repository metadata", async () => {
    const input = target();
    const selected = identity();
    const repositoryUrl = `https://api.github.com/repos/${input.owner}/${input.repo}`;
    let isPrivate = false;
    const fetchMock = vi.fn<typeof fetch>(async (url) =>
      json(
        requestUrl(url) === repositoryUrl
          ? { id: 123, private: isPrivate, visibility: isPrivate ? "private" : "public" }
          : item({ body: "Private issue body" }),
      ),
    );
    const store = getSharedApiStore({
      apiBaseUrl: "https://api.github.com",
      token: selected.token,
      fetchImpl: fetchMock,
    });
    await store.responses.read(apiStoreRequestKey(repositoryUrl), () => fetchMock(repositoryUrl), {
      freshnessMs: 30_000,
    });
    isPrivate = true;
    await expect(loadGitHubDetail(input, selected, fetchMock)).rejects.toMatchObject({
      statusCode: 404,
    });
    expect(fetchMock.mock.calls.map(([url]) => requestUrl(url))).toEqual([
      repositoryUrl,
      repositoryUrl,
    ]);
  });

  it("reloads files and coauthor commits after another reader observes a new PR head", async () => {
    const input = target("pull");
    const selected = identity();
    const repositoryUrl = `https://api.github.com/repos/${input.owner}/${input.repo}`;
    const pullUrl = `${repositoryUrl}/pulls/1`;
    const commitsUrl = `${pullUrl}/commits?per_page=30`;
    let head = sha;
    const nextHead = "c".repeat(40);
    const upstream = authenticatedFetch();
    const fetchMock = vi.fn<typeof fetch>(async (url, options) => {
      const pathname = new URL(requestUrl(url)).pathname;
      if (pathname.endsWith("/pulls/1")) {
        return json(item({ changed_files: 1, head: { sha: head, ref: "feature" } }));
      }
      if (pathname.endsWith("/files")) {
        return json([file({ patch: head === sha ? "Old patch" : "New patch" })]);
      }
      if (pathname.endsWith("/commits")) {
        return json([{ sha: head, author: { login: head === sha ? "old-author" : "new-author" } }]);
      }
      return upstream(url, options);
    });
    expect(await loadGitHubDetail(input, selected, fetchMock)).toMatchObject({
      files: [{ patch: "Old patch" }],
    });
    expect(await fetchGitHubJson(commitsUrl, fetchMock, selected.token)).toMatchObject([
      { author: { login: "old-author" } },
    ]);
    head = nextHead;
    await fetchGitHubApi(
      pullUrl,
      fetchMock,
      selected.token,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "https://api.github.com",
      { refresh: true },
    );
    expect(await loadGitHubDetail(input, selected, fetchMock)).toMatchObject({
      checks: { commit: nextHead },
      files: [{ patch: "New patch" }],
    });
    expect(await fetchGitHubJson(commitsUrl, fetchMock, selected.token)).toMatchObject([
      { author: { login: "new-author" } },
    ]);
    expect(
      fetchMock.mock.calls.filter(([url]) => new URL(requestUrl(url)).pathname.endsWith("/files")),
    ).toHaveLength(2);
  });
});
