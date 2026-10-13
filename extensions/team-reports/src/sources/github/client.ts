import { ApiQuotaError } from "openclaw/plugin-sdk/retry-runtime";
import { z } from "zod";
import type { GithubSourceConfig, SourceRuntime, SourceStatus } from "../../types.js";
import { checkAbort, createResponseParser, parseApiBase, wait } from "../http.js";
import {
  ABORT_LABEL,
  createGithubApiReader,
  GithubSourceError,
  resolveGithubApiUrl,
} from "./api-reader.js";

export { ABORT_LABEL, GithubSourceError } from "./api-reader.js";
const GithubErrorBodySchema = z.object({ message: z.string() });

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
  private readonly read;

  constructor(
    private readonly cfg: GithubSourceConfig,
    private readonly runtime: SourceRuntime,
    readonly status: SourceStatus,
  ) {
    try {
      this.base = parseApiBase(cfg.apiBaseUrl, "GitHub");
      this.read = runtime.githubRead ?? createGithubApiReader(cfg, runtime);
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
    return resolveGithubApiUrl(this.base, path);
  }

  async get(path: string): Promise<{ data: unknown; next?: string }> {
    const url = this.url(path);
    for (let failures = 0; ;) {
      checkAbort(this.runtime.signal, ABORT_LABEL);
      let response: Response;
      let data: unknown;
      let errorMessage: string | undefined;
      try {
        response = await this.read(url.href, {
          signal: this.runtime.signal,
          recordStats: (stats) => {
            this.status.stats.apiCalls = Number(this.status.stats.apiCalls) + stats.apiCalls;
            if (stats.rateLimitRemaining !== undefined) {
              this.status.stats.rateLimitRemaining = stats.rateLimitRemaining;
            }
          },
        });
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
        checkAbort(this.runtime.signal, ABORT_LABEL);
      } catch (error) {
        checkAbort(this.runtime.signal, ABORT_LABEL);
        if (error instanceof ApiQuotaError) {
          if (error.reason === "admission") {
            await wait(error.retryAfterMs, this.runtime.signal, ABORT_LABEL);
            continue;
          }
          throw new GithubSourceError(
            `API rate limited; retry in ${Math.ceil(error.retryAfterMs / 1000)} seconds`,
          );
        }
        if (error instanceof GithubSourceError) {
          throw error;
        }
        throw new GithubSourceError("Request failed; check API access and connectivity");
      }
      checkAbort(this.runtime.signal, ABORT_LABEL);
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
