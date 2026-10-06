import { afterEach, describe, expect, it, vi } from "vitest";

function scopedRequests(
  api: typeof import("./github-api.js"),
  fetchImpl: typeof fetch,
  baseUrl: string,
) {
  return (url: string, token?: string, graphql?: Parameters<typeof api.fetchGitHubApi>[7]) =>
    api.fetchGitHubApi(
      url,
      fetchImpl,
      token,
      undefined,
      undefined,
      undefined,
      undefined,
      graphql,
      baseUrl,
    );
}

afterEach(() => vi.restoreAllMocks());

describe("shared GitHub admission", () => {
  it("bounds concurrent REST and GraphQL dispatches and refills without bypassing the bucket", async () => {
    const api = await import("./github-api.js");
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}"));
    const request = scopedRequests(api, fetchImpl, api.GITHUB_API_BASE_URL);
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
    const request = scopedRequests(api, fetchImpl, api.GITHUB_API_BASE_URL);
    const url = `${api.GITHUB_API_BASE_URL}/repos/acme/repo/pulls`;
    await request(url, "synthetic-token");
    const results = await Promise.allSettled([
      request(url, "synthetic-token"),
      request(url, "synthetic-token"),
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
    const request = scopedRequests(api, fetchImpl, api.GITHUB_API_BASE_URL);
    const url = `${api.GITHUB_API_BASE_URL}/repos/acme/repo/pulls`;
    const a = request(url, "synthetic-cold-primary");
    const b = request(url, "synthetic-cold-primary");
    first.resolve(
      new Response("{}", {
        headers: { "x-ratelimit-remaining": "1", "x-ratelimit-reset": "1800000090" },
      }),
    );
    await a;
    await expect(request(url, "synthetic-cold-primary")).rejects.toMatchObject({ statusCode: 429 });
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
    const started = Promise.withResolvers<void>();
    const bodyController = Promise.withResolvers<ReadableStreamDefaultController<Uint8Array>>();
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          bodyController.resolve(controller);
        },
      }),
      { status: 403, headers: { "retry-after": "120" } },
    );
    const clone = response.clone.bind(response);
    vi.spyOn(response, "clone").mockImplementation(() => {
      started.resolve();
      return clone();
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}"));
    fetchImpl.mockResolvedValueOnce(response);
    const request = scopedRequests(api, fetchImpl, api.GITHUB_API_BASE_URL);
    const pending = request(`${api.GITHUB_API_BASE_URL}/repos/acme/repo/pulls`, "synthetic-slow");
    const outcome = expect(pending).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 120_000,
    });
    const controller = await bodyController.promise;
    await started.promise;
    try {
      await expect(
        request(`${api.GITHUB_API_BASE_URL}/search/issues?q=test`, "synthetic-slow"),
      ).rejects.toMatchObject({ statusCode: 429 });
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      controller.enqueue(
        new TextEncoder().encode('{"message":"You have exceeded a secondary rate limit."}'),
      );
      controller.close();
      await outcome;
    }
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
    expect(GITHUB_API_BASE_URL).toBe("https://api.github.com");
    expect(GITHUB_API_ORIGIN).toBe("https://api.github.com");
  });

  it("routes Enterprise Server REST and GraphQL requests to their API paths", async () => {
    const api = await import("./github-api.js");
    const { baseUrl, graphqlUrl } = api.resolveGitHubApiUrls("https://ghe.example.test/api/v3/");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const request = scopedRequests(api, fetchImpl, baseUrl);
    await request(`${baseUrl}/repos/acme/private-repo`, "synthetic-token");
    await request(graphqlUrl, "synthetic-token", {
      query: "query { viewer { login } }",
      variables: {},
    });
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://ghe.example.test/api/v3/repos/acme/private-repo",
      "https://ghe.example.test/api/graphql",
    ]);
    await expect(request("https://ghe.example.test/settings", "synthetic-token")).rejects.toThrow(
      "Invalid GitHub API URL",
    );
  });

  it("retains GraphQL quota on its admitted API while public requests are interleaved", async () => {
    const api = await import("./github-api.js");
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const enterpriseBase = "https://ghe.example.test/api/v3";
    const token = "synthetic-quota-token";
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: [{ type: "RATE_LIMITED" }] }), { status: 403 }),
      )
      .mockImplementation(async () => new Response("{}"));
    const enterprise = scopedRequests(api, fetchImpl, enterpriseBase);
    const response = await enterprise(api.resolveGitHubApiUrls(enterpriseBase).graphqlUrl, token, {
      query: "query { viewer { login } }",
      variables: {},
    });
    await expect(api.readGitHubGraphQLResponse(response, fetchImpl, token)).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 60_000,
    });
    await expect(
      api.fetchGitHubApi("https://api.github.com/repos/acme/repo", fetchImpl, token),
    ).resolves.toBeInstanceOf(Response);
    await expect(enterprise(`${enterpriseBase}/repos/acme/repo`, token)).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 60_000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(
      enterprise(`${enterpriseBase}/repos/acme/repo`, "synthetic-rotated-token"),
    ).resolves.toBeInstanceOf(Response);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("keeps a configured HTTPS API port on Enterprise requests", async () => {
    const api = await import("./github-api.js");
    const { baseUrl } = api.resolveGitHubApiUrls("https://ghe.example.test:8443/api/v3");
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}"));
    const request = scopedRequests(api, fetchImpl, baseUrl);
    await request(`${baseUrl}/repos/acme/private-repo`);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://ghe.example.test:8443/api/v3/repos/acme/private-repo",
      expect.any(Object),
    );
    await expect(
      request("https://ghe.example.test/api/v3/repos/acme/private-repo"),
    ).rejects.toThrow("Invalid GitHub API URL");
  });

  it.each([
    "http://api.ghe.example.test",
    "https://user@example.com",
    "https://api.ghe.example.test/other",
  ])("rejects unsafe configured API origin %s", async (origin) => {
    const api = await import("./github-api.js");
    expect(() => api.resolveGitHubApiUrls(origin)).toThrow(
      "gateway.github.apiBaseUrl must be an HTTPS GitHub API base URL",
    );
  });
});
