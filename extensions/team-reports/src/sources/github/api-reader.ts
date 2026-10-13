import { responseWithRelease } from "openclaw/plugin-sdk/fetch-runtime";
import { apiStoreRequestKey, getSharedApiStore } from "openclaw/plugin-sdk/retry-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type {
  GithubApiRead,
  GithubReadStats,
  GithubSourceConfig,
  SourceRuntime,
} from "../../types.js";
import { checkAbort, parseApiBase } from "../http.js";

export const ABORT_LABEL = "GitHub collection aborted";
export class GithubSourceError extends Error {}

export function resolveGithubApiUrl(base: URL, path: string): URL {
  const url = new URL(path.replace(/^\/(?!\/)/, ""), base);
  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(base.pathname) ||
    url.username ||
    url.password
  ) {
    throw new GithubSourceError("Refused API pagination outside the configured base URL");
  }
  return url;
}

/** Both local and worker readers use this host-bound transport; facts stay in the shared owner. */
export function createGithubApiReader(
  cfg: GithubSourceConfig,
  runtime: SourceRuntime,
): GithubApiRead {
  const base = parseApiBase(cfg.apiBaseUrl, "GitHub");
  const store = getSharedApiStore({
    apiBaseUrl: base.href,
    token: cfg.token,
    fetchImpl: runtime.fetchImpl,
  });
  return async (path, options = {}) => {
    const url = resolveGithubApiUrl(base, path);
    const signal =
      runtime.signal && options.signal
        ? AbortSignal.any([runtime.signal, options.signal])
        : (runtime.signal ?? options.signal);
    const apiPath = url.pathname.slice(base.pathname.length);
    const resource =
      apiPath === "search/code" ? "code_search" : apiPath.startsWith("search/") ? "search" : "core";
    const stats: GithubReadStats = { apiCalls: 0 };
    try {
      return await store.responses.read(
        apiStoreRequestKey(url.href),
        async (ownerSignal, authorize, assertReaders) => {
          await authorize();
          assertReaders();
          return await store.dispatch(resource, async () => {
            const controller = new AbortController();
            const requestSignal = AbortSignal.any([ownerSignal, controller.signal]);
            const timeout = setTimeout(() => controller.abort(), 30_000);
            let release: (() => Promise<void>) | undefined;
            try {
              stats.apiCalls++;
              const init: RequestInit = {
                headers: {
                  Accept: "application/vnd.github+json",
                  "X-GitHub-Api-Version": "2022-11-28",
                  Authorization: `Bearer ${cfg.token}`,
                },
                signal: requestSignal,
                redirect: "error",
              };
              let response: Response;
              if (runtime.fetchImpl) {
                response = await runtime.fetchImpl(url, init);
              } else {
                const guarded = await fetchWithSsrFGuard({
                  url: url.href,
                  init,
                  signal: ownerSignal,
                  requireHttps: true,
                  timeoutMs: 30_000,
                  maxRedirects: 0,
                  capture: false,
                });
                response = guarded.response;
                release = guarded.release;
              }
              const remaining = response.headers.get("x-ratelimit-remaining");
              if (remaining !== null && Number.isFinite(Number(remaining))) {
                stats.rateLimitRemaining = Number(remaining);
              }
              return responseWithRelease(response, async () => {
                clearTimeout(timeout);
                if (release) {
                  try {
                    await release();
                  } catch {
                    throw new GithubSourceError("Could not release API response");
                  }
                }
              });
            } catch {
              clearTimeout(timeout);
              await release?.().catch(() => {});
              checkAbort(ownerSignal, ABORT_LABEL);
              throw new GithubSourceError(
                controller.signal.aborted
                  ? "API request timed out"
                  : "Request failed; check API access and connectivity",
              );
            }
          });
        },
        { signal, authorize: async () => checkAbort(signal, ABORT_LABEL), freshnessMs: 30_000 },
      );
    } finally {
      options.recordStats?.(stats);
    }
  };
}
