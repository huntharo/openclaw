import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGitHubApi, resolveGitHubApiUrls } from "./github-api.js";

const log = vi.hoisted(() => ({ info: vi.fn(), debug: vi.fn() }));
// mock-isolation: Capture severity without opening process-global log sinks.
vi.mock("openclaw/plugin-sdk/logging-core", () => ({ createSubsystemLogger: () => log }));

const publicRepo = "https://api.github.com/repos/acme/repo";
const query = { query: "query { viewer { login } }", variables: {} };
const quota = { statusCode: 429, retryAfterMs: 60_000 };
function setup(
  base = "https://api.github.com",
  fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}")),
) {
  const request = (url: string, token?: string, gql?: Parameters<typeof fetchGitHubApi>[7]) =>
    fetchGitHubApi(url, fetcher, token, undefined, undefined, undefined, undefined, gql, base);
  return { fetcher, request };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

it.each([false, true])("keeps slow fetch diagnostics at debug (failed=%s)", async (failed) => {
  vi.spyOn(performance, "now")
    .mockReturnValueOnce(0)
    .mockReturnValueOnce(100)
    .mockReturnValueOnce(600);
  const { fetcher, request } = setup();
  if (failed) {
    fetcher.mockRejectedValue(new Error("synthetic network failure"));
    await expect(request(publicRepo)).rejects.toThrow("Could not reach GitHub");
  } else {
    await expect(request(publicRepo)).resolves.toBeInstanceOf(Response);
  }
  expect(log.debug).toHaveBeenCalledWith("Slow GitHub API request", {
    authMs: 100,
    networkMs: 500,
    resource: "core",
    aborted: false,
  });
  expect(log.info).not.toHaveBeenCalled();
});

describe("shared GitHub admission", () => {
  it.each(["files", "commits"])(
    "retires pending %s reads when the PR head changes",
    async (resource) => {
      const api = await import("./github-api.js");
      const started = Promise.withResolvers<void>();
      const old = Promise.withResolvers<Response>();
      const pullUrl = `${api.GITHUB_API_BASE_URL}/repos/acme/repo/pulls/1`;
      let head = "old";
      const fetchImpl = vi.fn<typeof fetch>(async (url) => {
        const requestUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        if (requestUrl.endsWith(`/${resource}`)) {
          started.resolve();
          return old.promise;
        }
        return new Response(JSON.stringify({ number: 1, head: { sha: head } }));
      });
      const request = setup(api.GITHUB_API_BASE_URL, fetchImpl).request;
      await request(pullUrl, "synthetic-head-change");
      const pending = request(`${pullUrl}/${resource}`, "synthetic-head-change");
      await started.promise;
      const outcome = expect(pending).rejects.toThrow("API facts invalidated");
      head = "new";
      await api.fetchGitHubApi(
        pullUrl,
        fetchImpl,
        "synthetic-head-change",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        api.GITHUB_API_BASE_URL,
        { refresh: true },
      );
      old.resolve(new Response(JSON.stringify([{ title: "Old head" }])));
      await outcome;
    },
  );

  it("bounds concurrent REST and GraphQL dispatches and refills without bypassing the bucket", async () => {
    const api = await import("./github-api.js");
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}"));
    const request = setup(api.GITHUB_API_BASE_URL, fetchImpl).request;
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        request(`${api.GITHUB_API_BASE_URL}/repos/acme/repo/pulls/${i + 1}`, "synthetic-token"),
      ),
    );
    await expect(
      request(api.GITHUB_GRAPHQL_URL, "synthetic-token", {
        query: "query { viewer { login } }",
        variables: {},
      }),
    ).rejects.toMatchObject({ statusCode: 429, retryAfterMs: 3_000 });
    expect(fetchImpl).toHaveBeenCalledTimes(20);
    clock.mockReturnValue(1_800_000_003_000);
    await request(`${api.GITHUB_API_BASE_URL}/search/issues?q=repo:acme/repo`, "synthetic-token");
    expect(fetchImpl).toHaveBeenCalledTimes(21);
  });

  it("reserves the remaining primary quota before concurrent reads and honors its reset", async () => {
    const api = await import("./github-api.js");
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response("{}", {
          headers: {
            "x-ratelimit-remaining": "1",
            "x-ratelimit-reset": "1800000090",
            "x-ratelimit-resource": "core",
          },
        }),
    );
    const request = setup(api.GITHUB_API_BASE_URL, fetchImpl).request;
    const url = `${api.GITHUB_API_BASE_URL}/repos/acme/repo/pulls`;
    await request(url, "synthetic-token");
    const results = await Promise.allSettled([
      request(`${url}/1`, "synthetic-token"),
      request(`${url}/2`, "synthetic-token"),
    ]);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(1_800_000_090_000);
    await request(url, "synthetic-token");
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("reserves a cold primary window for requests still awaiting their response", async () => {
    const api = await import("./github-api.js");
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const first = Promise.withResolvers<Response>();
    const second = Promise.withResolvers<Response>();
    const fetchImpl = vi
      .fn<typeof fetch>(async () => new Response("{}"))
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const request = setup(api.GITHUB_API_BASE_URL, fetchImpl).request;
    const url = `${api.GITHUB_API_BASE_URL}/repos/acme/repo/pulls`;
    const a = request(`${url}/1`, "synthetic-cold-primary");
    const b = request(`${url}/2`, "synthetic-cold-primary");
    first.resolve(
      new Response("{}", {
        headers: { "x-ratelimit-remaining": "1", "x-ratelimit-reset": "1800000090" },
      }),
    );
    await a;
    await expect(request(`${url}/3`, "synthetic-cold-primary")).rejects.toMatchObject({
      statusCode: 429,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    second.resolve(
      new Response("{}", {
        headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1800000090" },
      }),
    );
    await b;
  });

  it("applies header cooldowns while a secondary-limit body is still pending", async () => {
    const api = await import("./github-api.js");
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel,
      }),
      { status: 403, headers: { "retry-after": "120" } },
    );
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}"));
    fetchImpl.mockResolvedValueOnce(response);
    const request = setup(api.GITHUB_API_BASE_URL, fetchImpl).request;
    const pending = request(`${api.GITHUB_API_BASE_URL}/repos/acme/repo/pulls`, "synthetic-slow");
    await expect(pending).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 120_000,
    });
    await expect(
      request(`${api.GITHUB_API_BASE_URL}/search/issues?q=test`, "synthetic-slow"),
    ).rejects.toMatchObject({ statusCode: 429 });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    { status: 403, headers: new Headers(), delay: 60_000 },
    {
      status: 403,
      headers: new Headers({
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1800000030",
        "x-ratelimit-resource": "core",
      }),
      delay: 60_000,
    },
    { status: 429, headers: new Headers({ "retry-after": "120" }), delay: 120_000 },
  ])(
    "fails closed across callers after HTTP $status without anonymous retries",
    async ({ status, headers, delay }) => {
      const api = await import("./github-api.js");
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ message: "You have exceeded a secondary rate limit." }), {
            status,
            headers,
          }),
        )
        .mockImplementation(async () => new Response("{}"));
      const url = `${api.GITHUB_API_BASE_URL}/repos/acme/repo/pulls`;
      await expect(api.fetchGitHubJson(url, fetchImpl, "synthetic-token")).rejects.toMatchObject({
        statusCode: 429,
        retryAfterMs: delay,
      });
      await expect(
        api.fetchGitHubJson(
          `${api.GITHUB_API_BASE_URL}/search/issues?q=test`,
          fetchImpl,
          "synthetic-token",
        ),
      ).rejects.toMatchObject({ statusCode: 429 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(1_800_000_000_000 + delay);
      await api.fetchGitHubJson(url, fetchImpl, "synthetic-token");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    },
  );
});

describe("GitHub API base URL", () => {
  it("defaults to public GitHub", async () => {
    const { GITHUB_API_BASE_URL, GITHUB_API_ORIGIN } = await import("../api.js");
    expect({ GITHUB_API_BASE_URL, GITHUB_API_ORIGIN }).toEqual({
      GITHUB_API_BASE_URL: "https://api.github.com",
      GITHUB_API_ORIGIN: "https://api.github.com",
    });
  });

  it.each([
    ["https://ghe.example.test/api/v3/", "https://ghe.example.test/api/v3"],
    ["https://ghe.example.test:8443/api/v3", "https://ghe.example.test:8443/api/v3"],
  ])("routes Enterprise REST and GraphQL within %s", async (configured, expected) => {
    const { baseUrl, graphqlUrl } = resolveGitHubApiUrls(configured);
    const { fetcher, request } = setup(baseUrl);
    await request(`${baseUrl}/repos/acme/private-repo`, "synthetic-token");
    await request(graphqlUrl, "synthetic-token", query);
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
      `${expected}/repos/acme/private-repo`,
      expected.replace("/api/v3", "/api/graphql"),
    ]);
    expect(fetcher).toHaveBeenCalledWith(`${expected}/repos/acme/private-repo`, expect.any(Object));
    await expect(request("https://ghe.example.test/settings", "synthetic-token")).rejects.toThrow(
      "Invalid GitHub API URL",
    );
    if (configured.includes(":8443")) {
      await expect(
        request("https://ghe.example.test/api/v3/repos/acme/private-repo"),
      ).rejects.toThrow("Invalid GitHub API URL");
    }
  });

  it("retains GraphQL quota per admitted API and credential across interleaved requests", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const base = "https://ghe.example.test/api/v3";
    const token = "synthetic-quota-token";
    const { fetcher, request } = setup(base);
    fetcher.mockResolvedValueOnce(
      Response.json({ errors: [{ type: "RATE_LIMITED" }] }, { status: 403 }),
    );
    await expect(
      request(resolveGitHubApiUrls(base).graphqlUrl, token, query),
    ).rejects.toMatchObject(quota);
    await expect(fetchGitHubApi(publicRepo, fetcher, token)).resolves.toBeInstanceOf(Response);
    await expect(request(`${base}/repos/acme/repo`, token)).rejects.toMatchObject(quota);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(
      request(`${base}/repos/acme/repo`, "synthetic-rotated-token"),
    ).resolves.toBeInstanceOf(Response);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it.each([
    "http://api.ghe.example.test",
    "https://user@example.com",
    "https://api.ghe.example.test/other",
  ])("rejects unsafe configured API origin %s", (origin) => {
    expect(() => resolveGitHubApiUrls(origin)).toThrow(
      "gateway.github.apiBaseUrl must be an HTTPS GitHub API base URL",
    );
  });
});
