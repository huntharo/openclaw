import { setTimeout as wait } from "node:timers/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGitHubApiBaseUrl, resolveGitHubHost } from "../agents/github-host-runtime.js";
import { ApiQuotaError, getSharedApiStore, apiRateLimitHint } from "../infra/http-api-quota.js";
import { apiStoreRequestKey } from "../infra/http-api-read-store.js";
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
  let env = options.env ?? process.env;
  let token =
    host === "github.com" || host.endsWith(".ghe.com")
      ? env.GH_TOKEN || env.GITHUB_TOKEN
      : env.GH_ENTERPRISE_TOKEN || env.GITHUB_ENTERPRISE_TOKEN;
  if (!token) {
    options.beforeRun?.();
    const credential = await runCommandBuffered(["gh", "auth", "token", "--hostname", host], {
      cwd: options.cwd,
      env,
      timeoutMs: remainingMs(),
      maxOutputBytes: 4 * 1024,
    });
    options.beforeRun?.();
    token = credential.code === 0 ? credential.stdout.toString("utf8").trim() : undefined;
    if (!token) {
      throw new Error("GitHub CLI authentication is unavailable; sign in before publishing");
    }
    // Pin the locally selected native credential so gh dispatch and shared facts use one identity.
    env = {
      ...env,
      [host === "github.com" || host.endsWith(".ghe.com") ? "GH_TOKEN" : "GH_ENTERPRISE_TOKEN"]:
        token,
    };
  }
  const quota = getSharedApiStore({ apiBaseUrl, token });
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
    const methodIndex = args.findIndex((arg) => arg === "--method" || arg === "-X");
    const method = methodIndex < 0 ? "GET" : args[methodIndex + 1];
    const endpoint = args[endpointIndex];
    if (!method || !endpoint) {
      throw new Error("GitHub publication API arguments are incomplete");
    }
    const url = new URL(endpoint, apiBaseUrl + "/");
    if (method === "GET") {
      for (let index = 0; index < args.length; index++) {
        if (["-f", "-F", "--field", "--raw-field"].includes(args[index] ?? "")) {
          const field = args[++index];
          const separator = field?.indexOf("=") ?? -1;
          if (field && separator > 0) {
            url.searchParams.append(field.slice(0, separator), field.slice(separator + 1));
          }
        }
      }
    }
    const projectionIndex = args.indexOf("--jq");
    const projection = projectionIndex < 0 ? undefined : "jq:" + args[projectionIndex + 1];
    const key = apiStoreRequestKey(url.href, method, projection);
    let receipt: BufferedCommandResult | undefined;
    const execute = async (
      signal?: AbortSignal,
      authorize?: () => Promise<void>,
      assertCurrent = options.beforeRun,
    ) => {
      let release: () => void;
      for (;;) {
        await authorize?.();
        assertCurrent?.();
        signal?.throwIfAborted();
        remainingMs();
        try {
          release = quota.admit(resource);
          break;
        } catch (error) {
          if (!(error instanceof ApiQuotaError) || error.reason !== "admission") {
            throw error;
          }
          await wait(Math.min(error.retryAfterMs, remainingMs()), undefined, { signal });
        }
      }
      try {
        await authorize?.();
        assertCurrent?.();
        receipt = await runCommandBuffered(args, {
          ...options,
          env,
          signal,
          timeoutMs: remainingMs(),
          maxOutputBytes: options.maxOutputBytes ?? 256 * 1024,
        });
      } finally {
        release();
      }
      const parsed = parseHttpCommandResponse(receipt.stdout.toString("utf8"));
      const body = parsed ? Buffer.from(parsed.body) : receipt.stdout;
      const response =
        parsed?.response ?? new Response(null, { status: receipt.code === 0 ? 200 : 500 });
      const error = quota.observe(
        response,
        resource,
        publicationApiRateLimited(receipt, body, resource),
        receipt.code === 0,
      );
      // Preserve the command failure receipt; the open circuit rejects the next dispatch.
      if (error && receipt.code === 0) {
        throw error;
      }
      return new Response(new Uint8Array(body), {
        status: response.status,
        headers: response.headers,
      });
    };
    let response: Response;
    if (method === "GET") {
      response = await quota.responses.read(key, execute, {
        refresh: true,
        authorize: async () => options.beforeRun?.(),
        assertCurrent: options.beforeRun,
      });
    } else {
      const observation = quota.responses.beginObservation();
      response = await execute();
      if (response.ok) {
        const repository = /\/repos\/([^/]+\/[^/]+)/.exec(url.pathname)?.[1];
        quota.responses.invalidate((requestKey) =>
          Boolean(repository && requestKey.includes("/repos/" + repository + "/")),
        );
        await quota.responses.remember(key, response.clone(), observation);
      }
    }
    const body = Buffer.from(await response.arrayBuffer());
    if (method === "GET") {
      options.beforeRun?.();
    }
    // Accepted mutation receipts must still settle when the requester retires after dispatch.
    const result: BufferedCommandResult = receipt ?? {
      stdout: body,
      stderr: Buffer.alloc(0),
      code: response.ok ? 0 : 1,
      signal: null,
      killed: false,
      termination: "exit",
    };
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
    const nextUrl = new URL(next);
    const base = new URL(apiBaseUrl);
    if (
      nextUrl.origin !== base.origin ||
      nextUrl.username ||
      nextUrl.password ||
      !nextUrl.pathname.startsWith(base.pathname === "/" ? "/" : base.pathname + "/") ||
      seen.has(nextUrl.href)
    ) {
      throw new Error("GitHub publication API pagination did not advance safely");
    }
    seen.add(nextUrl.href);
    // Link already carries the complete query; gh fields would append it again.
    args = args.filter(
      (arg, index) =>
        !["-f", "-F", "--field", "--raw-field"].includes(arg) &&
        !["-f", "-F", "--field", "--raw-field"].includes(args[index - 1] ?? ""),
    );
    args[endpointIndex] = nextUrl.href;
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
