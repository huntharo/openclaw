import { setTimeout as wait } from "node:timers/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGitHubApiBaseUrl, resolveGitHubHost } from "../agents/github-host-runtime.js";
import { ApiQuotaError, getSharedApiQuota, apiRateLimitHint } from "../infra/http-api-quota.js";
import { parseHttpCommandResponse } from "../infra/http-command-response.js";
import { runCommandBuffered, type BufferedCommandResult } from "../process/exec.js";

export type PublicationApiCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  maxOutputBytes?: number;
  beforeRun?: () => void;
};

// gh's internal pagination cannot join Gateway admission. Keep each page on the
// same transport so a throttle stops discovery and publication together.
export async function runPublicationApiCommand(
  argv: string[],
  options: PublicationApiCommandOptions,
) {
  // Pagination and admission share the former single gh process's timeout.
  const deadline = Date.now() + 60_000;
  const remainingMs = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error("GitHub publication API command timed out");
    }
    return remaining;
  };
  const endpointIndex = argv.findIndex(
    (arg) => arg === "graphql" || arg.startsWith("repos/") || arg.startsWith("https://"),
  );
  if (endpointIndex < 0) {
    throw new Error("GitHub publication API endpoint is missing");
  }
  const hostnameIndex = argv.indexOf("--hostname");
  const host = hostnameIndex < 0 ? "github.com" : argv[hostnameIndex + 1];
  if (host !== "github.com" && host !== resolveGitHubHost()) {
    throw new Error("GitHub publication API hostname does not match the configured host");
  }
  const apiBaseUrl = host === "github.com" ? "https://api.github.com" : resolveGitHubApiBaseUrl();
  const env = options.env ?? process.env;
  const token =
    host === "github.com" || host.endsWith(".ghe.com")
      ? env.GH_TOKEN || env.GITHUB_TOKEN
      : env.GH_ENTERPRISE_TOKEN || env.GITHUB_ENTERPRISE_TOKEN;
  const quota = getSharedApiQuota({ apiBaseUrl, token });
  const resource = argv[endpointIndex] === "graphql" ? "graphql" : "core";
  const paginate = argv.includes("--paginate");
  let args = argv.filter((arg) => arg !== "--paginate");
  if (!args.includes("--include")) {
    args.push("--include");
  }
  const pages: Buffer[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  for (;;) {
    let release: () => void;
    for (;;) {
      options.beforeRun?.();
      remainingMs();
      try {
        release = quota.admit(resource);
        break;
      } catch (error) {
        if (!(error instanceof ApiQuotaError) || error.reason !== "admission") {
          throw error;
        }
        await wait(Math.min(error.retryAfterMs, remainingMs()));
      }
    }
    let result: BufferedCommandResult;
    try {
      options.beforeRun?.();
      result = await runCommandBuffered(args, {
        ...options,
        timeoutMs: remainingMs(),
        maxOutputBytes: options.maxOutputBytes ?? 256 * 1024,
      });
    } finally {
      release();
    }
    const parsed = parseHttpCommandResponse(result.stdout.toString("utf8"));
    const response = parsed?.response;
    const body = parsed ? Buffer.from(parsed.body) : result.stdout;
    if (response) {
      quota.observe(response, resource, publicationApiRateLimited(result, body, resource));
    } else if (result.code !== 0 && apiRateLimitHint(result.stderr.toString("utf8"))) {
      quota.observe(new Response(null, { status: 429 }), resource);
    }
    const previousPage = pages.at(-1);
    const needsSeparator = previousPage && previousPage.length > 0 && previousPage.at(-1) !== 10;
    bytes += body.byteLength + (needsSeparator ? 1 : 0);
    if (bytes > (options.maxOutputBytes ?? 256 * 1024)) {
      throw new Error("GitHub publication API output exceeded its limit");
    }
    if (needsSeparator) {
      pages.push(Buffer.from("\n"));
    }
    pages.push(body);
    const next =
      paginate && result.code === 0
        ? response?.headers
            .get("link")
            ?.split(/,\s*(?=<)/u)
            .find((link) => /;\s*rel="next"/u.test(link))
            ?.match(/<([^>]+)>/u)?.[1]
        : undefined;
    if (!next) {
      return { ...result, stdout: Buffer.concat(pages) };
    }
    const url = new URL(next);
    const base = new URL(apiBaseUrl);
    if (
      url.origin !== base.origin ||
      url.username ||
      url.password ||
      !url.pathname.startsWith(base.pathname === "/" ? "/" : base.pathname + "/") ||
      seen.has(url.href)
    ) {
      throw new Error("GitHub publication API pagination did not advance safely");
    }
    seen.add(url.href);
    // Link already carries the complete query; gh fields would append it again.
    args = args.filter(
      (arg, index) =>
        !["-f", "-F", "--field", "--raw-field"].includes(arg) &&
        !["-f", "-F", "--field", "--raw-field"].includes(args[index - 1] ?? ""),
    );
    args[endpointIndex] = url.href;
  }
}

function publicationApiRateLimited(
  result: BufferedCommandResult,
  body: Buffer,
  resource: string,
): boolean | "secondary" {
  const stderrHint = apiRateLimitHint(result.stderr.toString("utf8"));
  if (result.code !== 0 && stderrHint) {
    return stderrHint;
  }
  if (resource !== "graphql" && result.code === 0) {
    return false;
  }
  try {
    const record = asOptionalRecord(JSON.parse(body.toString("utf8")));
    const error = Array.isArray(record?.errors)
      ? record.errors.find((value: unknown) => {
          const candidate = asOptionalRecord(value);
          return (
            candidate?.type === "RATE_LIMIT" ||
            candidate?.type === "RATE_LIMITED" ||
            apiRateLimitHint(candidate?.message)
          );
        })
      : undefined;
    const errorRecord = asOptionalRecord(error);
    return (
      apiRateLimitHint(record?.message) || apiRateLimitHint(errorRecord?.message) || Boolean(error)
    );
  } catch {
    return false;
  }
}
