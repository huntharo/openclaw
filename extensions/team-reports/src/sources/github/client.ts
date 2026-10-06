import {
  ApiQuotaError,
  getSharedApiQuota,
  apiRateLimitHint,
} from "openclaw/plugin-sdk/retry-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { z } from "zod";
import type { GithubSourceConfig, SourceRuntime, SourceStatus } from "../../types.js";
import { checkAbort, createResponseParser, parseApiBase, wait } from "../http.js";

export const ABORT_LABEL = "GitHub collection aborted";
const GithubErrorBodySchema = z.object({ message: z.string() });

export class GithubSourceError extends Error {}

export class GithubHttpError extends GithubSourceError {
  constructor(readonly status: number) {
    super(`HTTP ${status}; check token permissions and repository access`);
  }
}

export const parse = createResponseParser(
  () => new GithubSourceError("Invalid API response; check API compatibility"),
);

export function pathWithQuery(path: string, query: Record<string, string>): string {
  return `${path}?${new URLSearchParams({ per_page: "100", ...query })}`;
}

export class GithubClient {
  private readonly base: URL;
  private readonly quota;

  constructor(
    private readonly cfg: GithubSourceConfig,
    private readonly runtime: SourceRuntime,
    readonly status: SourceStatus,
  ) {
    try {
      this.base = parseApiBase(cfg.apiBaseUrl, "GitHub");
      this.quota =
        runtime.githubQuota ??
        getSharedApiQuota({
          apiBaseUrl: this.base.href,
          token: cfg.token,
          fetchImpl: runtime.fetchImpl,
        });
    } catch {
      throw new GithubSourceError(
        "GitHub API base URL must be HTTPS without credentials, query, or fragment",
      );
    }
  }

  warn(scope: string, error: unknown): void {
    checkAbort(this.runtime.signal, ABORT_LABEL);
    const detail =
      error instanceof GithubSourceError
        ? error.message
        : "Request failed; check API access and connectivity";
    const message = `${scope}: ${detail}`;
    this.status.warnings.push(
      this.cfg.token ? message.replaceAll(this.cfg.token, "[redacted]") : message,
    );
    this.status.stale = true;
    this.status.ok = false;
  }

  async attempt(scope: string, action: () => Promise<void>): Promise<void> {
    checkAbort(this.runtime.signal, ABORT_LABEL);
    try {
      await action();
    } catch (error) {
      this.warn(scope, error);
    }
  }

  private url(path: string): URL {
    const url = new URL(path.replace(/^\/(?!\/)/, ""), this.base);
    if (
      url.origin !== this.base.origin ||
      !url.pathname.startsWith(this.base.pathname) ||
      url.username ||
      url.password
    ) {
      throw new GithubSourceError("Refused API pagination outside the configured base URL");
    }
    return url;
  }

  async get(path: string): Promise<{ data: unknown; next?: string }> {
    const url = this.url(path);
    const apiPath = url.pathname.slice(this.base.pathname.length);
    const resource =
      apiPath === "search/code" ? "code_search" : apiPath.startsWith("search/") ? "search" : "core";
    for (let failures = 0; ;) {
      checkAbort(this.runtime.signal, ABORT_LABEL);
      let releaseQuota: () => void | Promise<void>;
      try {
        releaseQuota = await this.quota.admit(resource);
      } catch (error) {
        if (!(error instanceof ApiQuotaError)) {
          throw error;
        }
        if (error.reason === "admission") {
          await wait(error.retryAfterMs, this.runtime.signal, ABORT_LABEL);
          continue;
        }
        throw new GithubSourceError(
          `API rate limited; retry in ${Math.ceil(error.retryAfterMs / 1000)} seconds`,
        );
      }
      let response: Response;
      let data: unknown;
      let errorMessage: string | undefined;
      let quotaError: ApiQuotaError | undefined;
      let release: (() => Promise<void>) | undefined;
      const controller = new AbortController();
      const signal = this.runtime.signal
        ? AbortSignal.any([this.runtime.signal, controller.signal])
        : controller.signal;
      const timeout = setTimeout(() => controller.abort(), 30_000);
      try {
        checkAbort(this.runtime.signal, ABORT_LABEL);
        this.status.stats.apiCalls = Number(this.status.stats.apiCalls) + 1;
        const init: RequestInit = {
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            Authorization: `Bearer ${this.cfg.token}`,
          },
          signal,
          redirect: "error",
        };
        if (this.runtime.fetchImpl) {
          response = await this.runtime.fetchImpl(url, init);
        } else {
          const result = await fetchWithSsrFGuard({
            url: url.href,
            init,
            signal: this.runtime.signal,
            requireHttps: true,
            timeoutMs: 30_000,
            maxRedirects: 0,
            capture: false,
          });
          release = result.release;
          response = result.response;
        }
        await releaseQuota();
        // Headers remain authoritative even if consuming or releasing the body fails.
        quotaError = await this.quota.observe(response, resource, false);
        const remaining = response.headers.get("x-ratelimit-remaining");
        if (remaining !== null && Number.isFinite(Number(remaining))) {
          this.status.stats.rateLimitRemaining = Number(remaining);
        }
        // Error payloads can echo credentials; neither parse errors nor API bodies escape this client.
        const body = await response.text();
        if (response.ok) {
          try {
            data = JSON.parse(body);
          } catch {
            throw new GithubSourceError("Invalid JSON API response");
          }
        } else if (response.status === 403 || response.status === 409 || response.status === 429) {
          try {
            data = JSON.parse(body);
          } catch {
            data = undefined;
          }
        }
        const errorBody = GithubErrorBodySchema.safeParse(data);
        errorMessage = errorBody.success ? errorBody.data.message : undefined;
        const limited = response.status === 403 && apiRateLimitHint(errorMessage ?? "");
        if (
          limited &&
          (!quotaError || (limited === "secondary" && quotaError.resource !== undefined))
        ) {
          quotaError = await this.quota.observe(response, resource, limited);
        }
        checkAbort(this.runtime.signal, ABORT_LABEL);
      } catch (error) {
        checkAbort(this.runtime.signal, ABORT_LABEL);
        if (error instanceof GithubSourceError) {
          throw error;
        }
        throw new GithubSourceError(
          controller.signal.aborted
            ? "API request timed out"
            : "Request failed; check API access and connectivity",
        );
      } finally {
        clearTimeout(timeout);
        await releaseQuota();
        if (release) {
          await release().catch(() => {
            checkAbort(this.runtime.signal, ABORT_LABEL);
            throw new GithubSourceError("Could not release API response");
          });
        }
      }
      checkAbort(this.runtime.signal, ABORT_LABEL);
      if (quotaError) {
        throw new GithubSourceError(
          `API rate limited; retry in ${Math.ceil(quotaError.retryAfterMs / 1000)} seconds`,
        );
      }
      if (response.status >= 500 && failures < 3) {
        failures += 1;
        await wait(1000 * 2 ** (failures - 1), this.runtime.signal, ABORT_LABEL);
        continue;
      }
      if (!response.ok) {
        // GitHub returns this 409 for an empty repository's commit list. Other
        // conflicts remain acquisition failures; never publish their partial counts.
        if (
          response.status === 409 &&
          /^repos\/[^/]+\/[^/]+\/commits$/u.test(url.pathname.slice(this.base.pathname.length)) &&
          errorMessage === "Git Repository is empty."
        ) {
          return { data: [] };
        }
        throw new GithubHttpError(response.status);
      }
      const next = response.headers
        .get("link")
        ?.split(/,\s*(?=<)/)
        .find((part) => /;\s*rel="next"(?:;|\s*$)/i.test(part))
        ?.match(/^\s*<([^>]+)>/)?.[1];
      return { data, next: next ? new URL(next, url).href : undefined };
    }
  }

  async *pages<T>(
    path: string,
    schema: z.ZodType<T>,
    afterPage?: () => Promise<void>,
  ): AsyncGenerator<T> {
    let next: string | undefined = path;
    const seen = new Set<string>();
    while (next) {
      checkAbort(this.runtime.signal, ABORT_LABEL);
      const canonical = this.url(next).href;
      if (seen.has(canonical)) {
        throw new GithubSourceError("API pagination did not advance");
      }
      seen.add(canonical);
      const page = await this.get(next);
      for (const item of parse(z.array(schema), page.data)) {
        checkAbort(this.runtime.signal, ABORT_LABEL);
        yield item;
      }
      await afterPage?.();
      next = page.next;
    }
  }
}
