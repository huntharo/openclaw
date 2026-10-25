import { readErrorName } from "openclaw/plugin-sdk/error-runtime";
import { responseWithRelease } from "openclaw/plugin-sdk/fetch-runtime";
import {
  ApiQuotaError,
  apiStoreRequestKey,
  getSharedApiStore,
} from "openclaw/plugin-sdk/retry-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { GithubApiRead, GithubReadStats, GithubSourceConfig } from "../../types.js";
import { parseApiBase } from "../http.js";

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
export function createGithubApiReader(cfg: GithubSourceConfig): GithubApiRead {
  const base = parseApiBase(cfg.apiBaseUrl, "GitHub");
  const store = getSharedApiStore({
    apiBaseUrl: base.href,
    token: cfg.token,
  });
  return async (path, options = {}) => {
    const url = resolveGithubApiUrl(base, path);
    const signal = options.signal;
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
            let release: (() => Promise<void>) | undefined;
            try {
              stats.apiCalls++;
              const init: RequestInit = {
                headers: {
                  Accept: "application/vnd.github+json",
                  "X-GitHub-Api-Version": "2022-11-28",
                  Authorization: `Bearer ${cfg.token}`,
                },
                signal: ownerSignal,
                redirect: "error",
              };
              const guarded = await fetchWithSsrFGuard({
                url: url.href,
                init,
                signal: ownerSignal,
                requireHttps: true,
                timeoutMs: 30_000,
                maxRedirects: 0,
                capture: false,
              });
              const response = guarded.response;
              release = guarded.release;
              const remaining = response.headers.get("x-ratelimit-remaining");
              if (remaining !== null && Number.isFinite(Number(remaining))) {
                stats.rateLimitRemaining = Number(remaining);
              }
              return responseWithRelease(response, async () => {
                if (release) {
                  try {
                    await release();
                  } catch {
                    throw new GithubSourceError("Could not release API response");
                  }
                }
              });
            } catch (error) {
              await release?.().catch(() => {});
              throw error;
            }
          });
        },
        { signal, authorize: async () => signal?.throwIfAborted(), freshnessMs: 30_000 },
      );
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof ApiQuotaError || error instanceof GithubSourceError) {
        throw error;
      }
      const name = readErrorName(error);
      throw new GithubSourceError(
        name === "TimeoutError" || name === "AbortError"
          ? "API request timed out"
          : "Request failed; check API access and connectivity",
      );
    } finally {
      options.recordStats?.(stats);
    }
  };
}
