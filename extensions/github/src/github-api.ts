import { createHash } from "node:crypto";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import {
  ApiQuotaError,
  apiQuotaErrorForResponse,
  getSharedApiQuota,
  getSharedApiStore,
  apiStoreRequestKey,
  apiRateLimitHint,
} from "openclaw/plugin-sdk/retry-runtime";
import {
  asFiniteNumber,
  isRecord,
  readNonBlankString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { getGitHubPullRequestStore } from "./pull-request-store.js";

export { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

const DEFAULT_GITHUB_API_BASE_URL = "https://api.github.com";
// Shipped public constant names the default service, independent of the selected Enterprise API.
export const GITHUB_API_ORIGIN = DEFAULT_GITHUB_API_BASE_URL;

function resolveGitHubApiBaseUrl(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_GITHUB_API_BASE_URL;
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !["/", "", "/api/v3", "/api/v3/"].includes(parsed.pathname)
  ) {
    throw new Error("gateway.github.apiBaseUrl must be an HTTPS GitHub API base URL");
  }
  return parsed.origin + (parsed.pathname.startsWith("/api/v3") ? "/api/v3" : "");
}

export const GITHUB_API_BASE_URL = DEFAULT_GITHUB_API_BASE_URL;
function githubGraphqlUrl(baseUrl: string): string {
  return baseUrl.endsWith("/api/v3") ? `${baseUrl.slice(0, -3)}/graphql` : `${baseUrl}/graphql`;
}

export const GITHUB_GRAPHQL_URL = githubGraphqlUrl(GITHUB_API_BASE_URL);

export function resolveGitHubApiUrls(apiBaseUrl: string | undefined) {
  const baseUrl = resolveGitHubApiBaseUrl(apiBaseUrl);
  return { baseUrl, graphqlUrl: githubGraphqlUrl(baseUrl) };
}

export function githubRestApiPath(url: URL, apiBaseUrl = GITHUB_API_BASE_URL): string {
  const basePath = new URL(apiBaseUrl).pathname;
  return url.pathname.slice(basePath === "/" ? 0 : basePath.length);
}
const GITHUB_JSON_MAX_BYTES = 256 * 1024;
export const GITHUB_REQUEST_TIMEOUT_MS = 8_000;
const GITHUB_API_VERSION = "2022-11-28";
const GITHUB_API_MAX_REDIRECTS = 3;
// Body-reported quotas belong to the admitted request even after API configuration changes.
const responseQuotas = new WeakMap<Response, ReturnType<typeof getSharedApiStore>>();
const responseRequests = new WeakMap<Response, string>();

export class ControlUiGitHubError extends Error {
  readonly retryAtMs: number | undefined;
  readonly upstreamStatus: number;
  readonly retryable: boolean;

  // Messages are authored here or by the metadata parser, never upstream bodies.
  constructor(
    readonly statusCode: number,
    message: string,
    options: { retryAtMs?: number; upstreamStatus?: number; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = "ControlUiGitHubError";
    this.upstreamStatus = options.upstreamStatus ?? statusCode;
    this.retryAtMs = options.retryAtMs;
    this.retryable =
      options.retryable ??
      (statusCode === 429 ||
        (options.upstreamStatus !== undefined && options.upstreamStatus >= 500));
  }

  get retryAfterMs(): number | undefined {
    // Cached failures must keep the original reset time when a hovercard reopens.
    return this.retryAtMs === undefined ? undefined : Math.max(0, this.retryAtMs - Date.now());
  }
}

class ControlUiGitHubTransportError extends ControlUiGitHubError {
  constructor(message: string) {
    super(502, message, { retryable: true });
  }
}

export class GitHubGraphQLUnavailableError extends ControlUiGitHubError {
  constructor(upstreamStatus: number) {
    super(403, "GitHub GraphQL access is unavailable for the selected credential", {
      upstreamStatus,
      retryable: false,
    });
  }
}

export function formatControlUiGitHubPreviewError(error: unknown): {
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
} {
  if (error instanceof ControlUiGitHubTransportError) {
    return { message: `${error.message}. Retry or check GitHub availability.`, retryable: true };
  }
  if (error instanceof ControlUiGitHubError) {
    const status = `HTTP ${error.upstreamStatus}`;
    switch (error.statusCode) {
      case 401:
        return {
          message: `GitHub authentication failed (${status}). Reconnect the GitHub identity in Settings.`,
          retryable: false,
        };
      case 403:
        return {
          message: `GitHub access denied (${status}). Check the configured GitHub identity's repository access.`,
          retryable: false,
        };
      case 404:
        // The shared server credential must not reveal whether a private repository exists.
        return {
          message:
            "GitHub item is unavailable or not public (HTTP 404). Open the link on GitHub to check access.",
          retryable: false,
        };
      case 429: {
        const retryAfterMs = error.retryAfterMs;
        const wait =
          retryAfterMs === undefined ? "Wait" : `Wait ${Math.ceil(retryAfterMs / 1_000)} seconds`;
        return {
          message: `GitHub API rate limit exceeded (${status}). ${wait} and retry.`,
          retryable: true,
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        };
      }
      case 502:
        return {
          message: `${error.message.slice(0, 256)}. Retry or check GitHub availability.`,
          retryable: true,
        };
    }
  }
  if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
    return { message: "GitHub request timed out. Retry shortly.", retryable: true };
  }
  // Credential subprocess errors and arbitrary transport diagnostics can contain secrets.
  return {
    message: "GitHub preview could not be loaded. Retry or check the server logs.",
    retryable: false,
  };
}

export function githubApiCredentialCacheScope(token: string | undefined): string {
  return token ? createHash("sha256").update(token).digest("hex") : "anonymous";
}

export function requiredString(record: Record<string, unknown>, key: string): string {
  const value = readNonBlankString(record[key]);
  if (value === undefined) {
    throw new ControlUiGitHubError(502, `GitHub response omitted ${key}`);
  }
  return value;
}

export function readOptionalGitHubString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  return readNonBlankString(record[key]);
}

export function optionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  return asFiniteNumber(record[key]);
}

function githubApiResource(url: URL, apiBaseUrl: string, graphqlUrl: string): string {
  // GitHub separates GraphQL, code search, other searches, and non-search REST.
  const path = githubRestApiPath(url, apiBaseUrl);
  return url.href === graphqlUrl
    ? "graphql"
    : path === "/search/code"
      ? "code_search"
      : path.startsWith("/search/")
        ? "search"
        : "core";
}

function githubQuotaError(error: ApiQuotaError): ControlUiGitHubError {
  return new ControlUiGitHubError(429, "GitHub API quota unavailable", {
    retryAtMs: error.retryAtMs,
    upstreamStatus: error.upstreamStatus,
  });
}

function githubApiHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "OpenClaw-Control-UI",
    "X-GitHub-Api-Version": GITHUB_API_VERSION,
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function isGitHubApiRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function safeGitHubApiUrl(raw: string, apiBase: URL, graphqlUrl: string, base?: URL): URL | null {
  const url = URL.parse(raw, base);
  if (
    !url ||
    url.origin !== apiBase.origin ||
    url.username ||
    url.password ||
    (url.href !== graphqlUrl &&
      !url.pathname.startsWith(`${apiBase.pathname === "/" ? "" : apiBase.pathname}/`))
  ) {
    return null;
  }
  return url;
}

export async function fetchGitHubApi(
  rawUrl: string,
  fetchImpl: typeof fetch,
  token?: string,
  beforeRedirect?: (url: URL) => Promise<void>,
  identity?: { revalidate: () => Promise<void>; assertSelected: () => void },
  etag?: string,
  callerSignal?: AbortSignal,
  graphql?: { query: string; variables: Record<string, string> },
  apiBaseUrl = GITHUB_API_BASE_URL,
  readOptions: { refresh?: boolean; freshnessMs?: number } = {},
): Promise<Response> {
  const baseUrl = resolveGitHubApiBaseUrl(apiBaseUrl);
  const initial = safeGitHubApiUrl(rawUrl, new URL(baseUrl), githubGraphqlUrl(baseUrl));
  if (!initial || (graphql && (initial.href !== githubGraphqlUrl(baseUrl) || !token || etag))) {
    throw new ControlUiGitHubError(502, "Invalid GitHub API request");
  }
  const store = getSharedApiStore({ apiBaseUrl: baseUrl, token, fetchImpl });
  getGitHubPullRequestStore(store);
  const authorize = async (redirect?: URL) => {
    callerSignal?.throwIfAborted();
    await identity?.revalidate();
    identity?.assertSelected();
    if (redirect) {
      await beforeRedirect?.(redirect);
    }
  };
  const key = apiStoreRequestKey(
    initial.href,
    graphql ? "POST" : "GET",
    graphql ? JSON.stringify(graphql) : etag,
  );
  const mutation = graphql && /^\s*(?:#[^\n]*\n\s*)*mutation\b/.test(graphql.query);
  let response: Response;
  if (mutation) {
    await authorize();
    response = await dispatchGitHubApi(
      initial.href,
      fetchImpl,
      token,
      beforeRedirect,
      identity,
      etag,
      callerSignal,
      graphql,
      baseUrl,
    );
    if (response.ok) {
      store.responses.invalidate(() => true);
      await store.responses.remember(key, response.clone());
    }
    await authorize();
  } else {
    response = await store.responses.read(
      key,
      (signal, authorizeReaders, assertReaders) =>
        dispatchGitHubApi(
          initial.href,
          fetchImpl,
          token,
          (redirect) => authorizeReaders(redirect),
          { revalidate: () => authorizeReaders(), assertSelected: assertReaders },
          etag,
          signal,
          graphql,
          baseUrl,
        ),
      {
        // Visibility and account admission facts are always reread; content shares a short TTL.
        freshnessMs:
          /^\/repos\/[^/]+\/[^/]+$/.test(githubRestApiPath(initial, baseUrl)) ||
          githubRestApiPath(initial, baseUrl) === "/user"
            ? 0
            : 30_000,
        ...readOptions,
        signal: callerSignal,
        authorize,
        assertCurrent: () => {
          callerSignal?.throwIfAborted();
          identity?.assertSelected();
        },
      },
    );
  }
  responseQuotas.set(response, store);
  responseRequests.set(response, initial.href);
  return response;
}

async function dispatchGitHubApi(
  rawUrl: string,
  fetchImpl: typeof fetch,
  token?: string,
  beforeRedirect?: (url: URL) => Promise<void>,
  identity?: { revalidate: () => Promise<void>; assertSelected: () => void },
  etag?: string,
  callerSignal?: AbortSignal,
  graphql?: { query: string; variables: Record<string, string> },
  apiBaseUrl = GITHUB_API_BASE_URL,
): Promise<Response> {
  callerSignal?.throwIfAborted();
  const baseUrl = resolveGitHubApiBaseUrl(apiBaseUrl);
  const apiBase = new URL(baseUrl);
  const graphqlUrl = githubGraphqlUrl(baseUrl);
  const initialUrl = safeGitHubApiUrl(rawUrl, apiBase, graphqlUrl);
  if (!initialUrl) {
    throw new ControlUiGitHubError(502, "Invalid GitHub API URL");
  }
  if (graphql && (initialUrl.href !== graphqlUrl || !token || etag)) {
    throw new ControlUiGitHubError(502, "Invalid authenticated GitHub GraphQL request");
  }
  let url: URL = initialUrl;
  const quota = getSharedApiQuota({ apiBaseUrl: baseUrl, token, fetchImpl });

  const timeout = AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS);
  const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
  let redirects = 0;
  for (;;) {
    // Recheck every dispatch, including redirects and auxiliary metadata reads.
    // Selection must still be current after the asynchronous credential read.
    if (identity) {
      await identity.revalidate();
      identity.assertSelected();
    }
    callerSignal?.throwIfAborted();
    const resource = githubApiResource(url, baseUrl, graphqlUrl);
    let response: Response;
    try {
      response = await quota.dispatch(resource, () =>
        fetchImpl(url.href, {
          headers: {
            ...githubApiHeaders(token),
            ...(etag ? { "If-None-Match": etag } : {}),
            ...(graphql ? { "Content-Type": "application/json" } : {}),
          },
          ...(graphql ? { method: "POST", body: JSON.stringify(graphql) } : {}),
          redirect: "manual",
          signal,
        }),
      );
    } catch (error) {
      if (error instanceof ApiQuotaError) {
        throw githubQuotaError(error);
      }
      const timedOut = signal.aborted || (error instanceof Error && error.name === "TimeoutError");
      throw new ControlUiGitHubTransportError(
        timedOut ? "GitHub request timed out" : "Could not reach GitHub",
      );
    }
    if (!isGitHubApiRedirect(response.status)) {
      responseQuotas.set(response, quota);
      return response;
    }

    const location: string | null = response.headers.get("location");
    const nextUrl: URL | null = location
      ? safeGitHubApiUrl(location, apiBase, graphqlUrl, url)
      : null;
    redirects += 1;
    if (!nextUrl || redirects > GITHUB_API_MAX_REDIRECTS) {
      await discardResponse(response);
      throw new ControlUiGitHubError(502, "GitHub API returned an unsafe redirect");
    }
    // Credentials stay on the fixed API origin across GitHub redirects;
    // callers still verify the final response repository before returning it.
    await discardResponse(response);
    await beforeRedirect?.(nextUrl);
    if (graphql) {
      throw new ControlUiGitHubError(502, "GitHub GraphQL returned an unexpected redirect");
    }
    url = nextUrl;
  }
}

export async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => {});
}

export async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer> {
  try {
    return await readResponseWithLimit(response, maxBytes, {
      onOverflow: () => new ControlUiGitHubError(502, "GitHub response exceeded the size limit"),
    });
  } finally {
    await discardResponse(response);
  }
}

// GitHub reports quota exhaustion as 429 or as 403 with exhausted-quota
// headers. Body-reported secondary limits are classified by the JSON reader;
// other 403 responses remain permission failures.
function isGitHubRateLimitResponse(response: Response): boolean {
  return apiQuotaErrorForResponse(response) !== undefined;
}

function githubResponseErrorStatus(response: Response): number {
  if (isGitHubRateLimitResponse(response)) {
    return 429;
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return response.status;
  }
  return 502;
}

function githubResponseError(response: Response, rateLimited = false): ControlUiGitHubError {
  const quotaError = apiQuotaErrorForResponse(response, rateLimited);
  if (quotaError) {
    return githubQuotaError(quotaError);
  }
  return new ControlUiGitHubError(
    githubResponseErrorStatus(response),
    `GitHub request failed (HTTP ${response.status})`,
    {
      upstreamStatus: response.status,
    },
  );
}

/** GraphQL can report failed queries and exhausted quota in an HTTP 200 response. */
export async function readGitHubGraphQLResponse(
  response: Response,
  fetchImpl: typeof fetch,
  token: string,
  maxBytes?: number,
): Promise<unknown> {
  const quota =
    responseQuotas.get(response) ??
    getSharedApiQuota({
      apiBaseUrl: DEFAULT_GITHUB_API_BASE_URL,
      token,
      fetchImpl,
    });
  const value =
    response.status === 403 && !isGitHubRateLimitResponse(response)
      ? await readGitHubJsonBody(response, maxBytes)
      : await readGitHubJsonResponse(response, maxBytes);
  const noData =
    isRecord(value) &&
    (value.data === undefined ||
      value.data === null ||
      (isRecord(value.data) && Object.values(value.data).every((field) => field === null)));
  if (isRecord(value) && value.errors !== undefined) {
    const limited = Array.isArray(value.errors)
      ? value.errors.find(
          (error) =>
            isRecord(error) && (error.type === "RATE_LIMITED" || apiRateLimitHint(error.message)),
        )
      : undefined;
    if (isRecord(limited)) {
      const error = quota.observe(response, "graphql", apiRateLimitHint(limited.message) || true);
      if (error) {
        throw githubQuotaError(error);
      }
    }
    if (
      Array.isArray(value.errors) &&
      value.errors.length > 0 &&
      value.errors.every(
        (error) =>
          isRecord(error) && (error.type === "FORBIDDEN" || error.type === "INSUFFICIENT_SCOPES"),
      ) &&
      noData
    ) {
      throw new GitHubGraphQLUnavailableError(response.status);
    }
    if (!Array.isArray(value.errors) || value.errors.length > 0) {
      throw new ControlUiGitHubError(
        502,
        "GitHub GraphQL request failed; check repository access",
        {
          retryable: false,
        },
      );
    }
  }
  if (!response.ok) {
    if (
      response.status === 403 &&
      noData &&
      isRecord(value) &&
      value.errors === undefined &&
      (value.message === "Resource not accessible by integration" ||
        value.message === "Resource not accessible by personal access token")
    ) {
      throw new GitHubGraphQLUnavailableError(response.status);
    }
    throw githubResponseError(response);
  }
  quota.observe(response, "graphql");
  return value;
}

// Optional host auth raises quota and unlocks private-repo reads, but an
// unusable credential must not disable public GitHub data that works anonymously.
export async function withOptionalGitHubAuth<T>(
  token: string | undefined,
  request: (token: string | undefined) => Promise<T>,
): Promise<T> {
  try {
    return await request(token);
  } catch (error) {
    const status = error instanceof ControlUiGitHubError ? error.statusCode : 0;
    if (token && [401, 403].includes(status)) {
      return await request(undefined);
    }
    throw error;
  }
}

export async function readGitHubJsonResponse(
  response: Response,
  maxBytes = GITHUB_JSON_MAX_BYTES,
): Promise<unknown> {
  if (!response.ok) {
    if (response.status === 403 && !isGitHubRateLimitResponse(response)) {
      let payload: unknown;
      try {
        payload = await readGitHubJsonBody(response, maxBytes);
      } catch {
        // An unreadable error body must not change a permission failure's status.
      }
      if (
        isRecord(payload) &&
        typeof payload.message === "string" &&
        /\b(?:secondary rate limit|abuse detection)\b/iu.test(payload.message)
      ) {
        const error = responseQuotas.get(response)?.observe(response, "core", "secondary", false);
        throw error ? githubQuotaError(error) : githubResponseError(response, true);
      }
    }
    await discardResponse(response);
    throw githubResponseError(response);
  }
  const value = await readGitHubJsonBody(response, maxBytes);
  const store = responseQuotas.get(response);
  const url = responseRequests.get(response);
  const target = url && /\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(new URL(url).pathname);
  return store && target?.[1] && target[2] && target[3] && isRecord(value)
    ? getGitHubPullRequestStore(store).project(target[1], target[2], Number(target[3]), value)
    : value;
}

async function readGitHubJsonBody(
  response: Response,
  maxBytes = GITHUB_JSON_MAX_BYTES,
): Promise<unknown> {
  let body: Buffer;
  try {
    body = await readBoundedResponse(response, maxBytes);
  } catch (error) {
    if (error instanceof ControlUiGitHubError) {
      throw error;
    }
    throw new ControlUiGitHubError(502, "GitHub response could not be read");
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new ControlUiGitHubError(502, "GitHub response was not valid JSON");
  }
}

/** Fetch a GitHub API JSON document with bounded size and normalized errors. */
export function fetchGitHubJson(
  rawUrl: string,
  fetchImpl: typeof fetch,
  token?: string,
  maxBytes?: number,
  apiBaseUrl = GITHUB_API_BASE_URL,
): Promise<unknown> {
  return withOptionalGitHubAuth(token, async (requestToken) =>
    readGitHubJsonResponse(
      await fetchGitHubApi(
        rawUrl,
        fetchImpl,
        requestToken,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        apiBaseUrl,
      ),
      maxBytes,
    ),
  );
}
