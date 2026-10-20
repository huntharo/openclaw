import { expect, vi } from "vitest";
import { loadGitHubDetail } from "./detail.js";
import type { ControlUiGitHubPreviewIdentity } from "./preview-contract.js";
import type { GitHubTarget } from "./targets.js";

export const date = "2026-09-13T12:00:00Z";
export const sha = "abcdef0123456789abcdef0123456789abcdef01";
export const publicRepo = { id: 123, private: false, visibility: "public" };
let sequence = 0;

export function target(kind: "issue" | "pull" | "commit" = "issue", commitSha = sha): GitHubTarget {
  const repo = "detail-" + ++sequence;
  return kind === "commit"
    ? { kind, owner: "octocat", repo, sha: commitSha }
    : { kind, owner: "octocat", repo, number: 1 };
}
export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
export function item(overrides: Record<string, unknown> = {}) {
  return {
    title: "Read me",
    body: "# Markdown\n\n  indentation  ",
    user: { login: "octocat" },
    state: "open",
    created_at: date,
    updated_at: date,
    comments: 0,
    review_comments: 0,
    changed_files: 0,
    head: { sha, ref: "feature" },
    base: { sha: "b".repeat(40), ref: "main" },
    ...overrides,
  };
}
export function file(overrides: Record<string, unknown> = {}) {
  return {
    filename: "src/file.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    patch: "@@ -1 +1 @@\n-old\n+new",
    ...overrides,
  };
}
export function commit(overrides: Record<string, unknown> = {}, commentCount = 0) {
  return {
    sha,
    author: { login: "octocat" },
    commit: {
      message: "Subject\n\nDetails",
      author: { name: "Octocat", date },
      comment_count: commentCount,
    },
    stats: { additions: 1, deletions: 1 },
    files: [file()],
    ...overrides,
  };
}
export function commentItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    html_url: "https://github.com/octocat/repo/pull/1#issuecomment-1",
    user: { login: "reviewer" },
    created_at: date,
    body: "  Markdown  ",
    ...overrides,
  };
}
export function publicFetch(payload: unknown, ...pages: Response[]) {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) => {
      const href = requestUrl(url);
      if (href.endsWith("/check-runs?filter=latest&per_page=100")) {
        return json({ total_count: 0, check_runs: [] });
      }
      if (href.endsWith("/status?per_page=100")) {
        return json({ sha, total_count: 0, state: "pending", statuses: [] });
      }
      throw new Error("Unexpected request " + href);
    })
    .mockResolvedValueOnce(json(publicRepo))
    .mockResolvedValueOnce(json(payload));
  for (const page of pages) {
    fetchMock.mockResolvedValueOnce(page);
  }
  return fetchMock;
}

export function identity(scope = "selected"): ControlUiGitHubPreviewIdentity {
  return {
    token: "token-" + scope,
    cacheScope: scope,
    revalidate: vi.fn(async () => {}),
    assertSelected: vi.fn(),
  };
}
export function revocableIdentity() {
  const selected = identity();
  const revoke = () => {
    selected.assertSelected = () => {
      throw new Error("identity changed");
    };
  };
  return { selected, revoke };
}

export function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input.toString();
}
export function requestPath(input: Parameters<typeof fetch>[0]): string {
  return new URL(requestUrl(input)).pathname;
}
export function fullPull() {
  return item({ comments: 1, review_comments: 1, changed_files: 1 });
}
export function fetchResponses(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>();
  for (const response of responses) {
    fetchMock.mockResolvedValueOnce(response);
  }
  return fetchMock;
}
export function expectStatus(pending: Promise<unknown>, statusCode: number) {
  return expect(pending).rejects.toMatchObject({ statusCode });
}
export function reader(
  input: GitHubTarget,
  selected: ControlUiGitHubPreviewIdentity,
  fetcher: typeof fetch,
) {
  return (
    section?: Parameters<typeof loadGitHubDetail>[4],
    refresh = false,
    caller = selected,
    transport = fetcher,
  ) => loadGitHubDetail(input, caller, transport, refresh, section);
}

export function authenticatedFetch(
  payload: unknown = item(),
  intercept?: (
    path: string,
    options?: RequestInit,
  ) => Response | undefined | Promise<Response | undefined>,
) {
  return vi.fn<typeof fetch>(async (url, options) => {
    const path = requestPath(url);
    const response = await intercept?.(path, options);
    if (response) {
      return response;
    }
    if (path.endsWith("/check-runs")) {
      return json({ total_count: 0, check_runs: [] });
    }
    if (path.endsWith("/status")) {
      return json({ sha, total_count: 0, state: "pending", statuses: [] });
    }
    if (/^\/repos\/[^/]+\/[^/]+$/u.test(path)) {
      return json(publicRepo);
    }
    if (path.endsWith("/comments")) {
      return json([commentItem({ diff_hunk: "@@ -1 +1 @@\n-old\n+new" })]);
    }
    if (path.endsWith("/files")) {
      return json([file()]);
    }
    return json(payload);
  });
}
