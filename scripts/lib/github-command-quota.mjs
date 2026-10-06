import { isCoreQuotaExhausted, isGraphqlQuotaExhausted } from "../pr-lib/gh-api-preflight.mjs";
import { resolvePlainGhHost } from "./plain-gh.mjs";

let quotaModules;
/** @type {typeof import("../../src/infra/http-api-quota.js").ApiQuotaError | undefined} */
let quotaErrorConstructor;

/**
 * @param {unknown} error
 * @returns {error is import("../../src/infra/http-api-quota.js").ApiQuotaError}
 */
export function isGitHubCommandQuotaError(error) {
  return Boolean(quotaErrorConstructor && error instanceof quotaErrorConstructor);
}

async function loadQuotaModules() {
  if (!quotaModules) {
    // Literal imports let the compiler include both owners in the preserved worker graph.
    const load =
      process.versions.bun || import.meta.url.endsWith(".js")
        ? () =>
            Promise.all([
              import("../../src/infra/http-api-quota.js"),
              import("../../src/infra/http-command-response.js"),
            ])
        : async () => {
            const { tsImport } = await import("tsx/esm/api");
            return Promise.all([
              tsImport(
                new URL("../../src/infra/http-api-quota.js", import.meta.url).href,
                import.meta.url,
              ),
              tsImport(
                new URL("../../src/infra/http-command-response.js", import.meta.url).href,
                import.meta.url,
              ),
            ]);
          };
    quotaModules = load();
  }
  return quotaModules;
}

async function createCommandQuotaPolicy(options) {
  const [{ ApiQuotaError, getSharedApiQuota, apiRateLimitHint }, { parseHttpCommandResponse }] =
    await loadQuotaModules();
  quotaErrorConstructor = ApiQuotaError;
  const { env = process.env } = options;
  const hostname = (options.hostname || (await resolvePlainGhHost(env))).trim().toLowerCase();
  const cloud = hostname === "github.com" || hostname.endsWith(".ghe.com");
  const apiBaseUrl = cloud ? `https://api.${hostname}` : `https://${hostname}/api/v3`;
  const token = cloud
    ? env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()
    : env.GH_ENTERPRISE_TOKEN?.trim() || env.GITHUB_ENTERPRISE_TOKEN?.trim();
  const resourceFor = (args) =>
    args[0] === "api" && args.includes("graphql") ? "graphql" : "core";

  return {
    apiBaseUrl,
    token,
    credentialArgs: ["auth", "token", "--hostname", hostname],
    initialize: (resolvedToken) => getSharedApiQuota({ apiBaseUrl, token: resolvedToken }),
    admit(quota, args) {
      try {
        return { release: quota.admit(resourceFor(args)) };
      } catch (error) {
        if (!(error instanceof ApiQuotaError) || error.reason !== "admission") {
          throw error;
        }
        return { delay: error.retryAfterMs };
      }
    },
    observe(quota, args, output, failure) {
      const api = args[0] === "api";
      const http = api ? parseHttpCommandResponse(output) : undefined;
      const body = http?.body ?? output;
      const diagnostics = failure ? `${failure.message ?? ""}\n${failure.stderr ?? ""}` : "";
      const hints = [apiRateLimitHint(diagnostics)];
      let confirmedSuccess = !failure;
      try {
        const value = JSON.parse(body);
        hints.push(apiRateLimitHint(value?.message));
        const errors = Array.isArray(value?.errors) ? value.errors : [];
        confirmedSuccess &&= errors.length === 0;
        for (const error of errors) {
          hints.push(apiRateLimitHint(error?.message) || error?.type === "RATE_LIMITED");
        }
      } catch {
        // Quota headers still apply to non-JSON failures and plain-text job logs.
        if (resourceFor(args) === "graphql") {
          confirmedSuccess = false;
        }
      }
      const status = Number(/\bHTTP ([2-5]\d{2})\b/u.exec(diagnostics)?.[1]);
      const response =
        http?.response ?? new Response(null, { status: failure ? status || 500 : 200 });
      /** @type {boolean | "primary" | "secondary"} */
      let hint =
        hints.find((value) => value === "secondary") ?? hints.find((value) => value) ?? false;
      if (
        api &&
        failure &&
        hint !== "secondary" &&
        (resourceFor(args) === "graphql"
          ? isGraphqlQuotaExhausted(failure)
          : isCoreQuotaExhausted(failure))
      ) {
        hint = "primary";
      }
      const quotaError = quota.observe(response, resourceFor(args), hint, confirmedSuccess);
      if (quotaError) {
        throw quotaError;
      }
      return { body, error: failure, response: http?.response };
    },
  };
}

function localCommand(args) {
  // Help is a local capability probe, including the log reader's gh api --help.
  return args.includes("--help") || args.includes("--version");
}

function apiCommand(args) {
  return args[0] === "api" && !args.includes("--include") ? [...args, "--include"] : args;
}

function failureOutput(error) {
  return typeof error?.stdout === "string" ? error.stdout : "";
}

/**
 * Keep the caller's gh executable and authentication route while budgeting each dispatch.
 * remainingMs must throw the caller's timeout when its deadline expires.
 * @param {{runGh: (args: string[]) => string, hostname?: string, env?: NodeJS.ProcessEnv, remainingMs?: () => number}} options
 */
export async function createGitHubCommandQuota({ runGh, ...options }) {
  const policy = await createCommandQuotaPolicy(options);
  const waitSignal = new Int32Array(new SharedArrayBuffer(4));
  let quota;

  return (args) => {
    if (localCommand(args)) {
      return { body: runGh(args), error: undefined };
    }
    if (!quota) {
      let token = policy.token;
      if (!token) {
        try {
          token = runGh(policy.credentialArgs).trim();
        } catch {
          // The selected CLI retains its ordinary authentication behavior.
        }
      }
      quota = policy.initialize(token);
    }
    let release;
    for (;;) {
      const remaining = options.remainingMs?.() ?? Infinity;
      const admission = policy.admit(quota, args);
      if (admission.delay === undefined) {
        release = admission.release;
        break;
      }
      Atomics.wait(waitSignal, 0, 0, Math.min(admission.delay, remaining));
    }
    let output = "";
    let failure;
    try {
      output = runGh(apiCommand(args));
    } catch (error) {
      failure = error;
      output = failureOutput(error);
    } finally {
      release();
    }
    const { body, error } = policy.observe(quota, args, output, failure);
    return { body, error };
  };
}

/**
 * Async CLI transport, including admission between the existing paginated REST reads.
 * remainingMs must throw the caller's timeout when its deadline expires.
 * @param {{runGhAsync: (args: string[]) => Promise<string>, hostname?: string, env?: NodeJS.ProcessEnv, remainingMs?: () => number}} options
 */
export async function createGitHubAsyncCommandQuota({ runGhAsync, ...options }) {
  const policy = await createCommandQuotaPolicy(options);
  let quota;
  return async (args) => {
    if (localCommand(args)) {
      return { body: await runGhAsync(args), error: undefined };
    }
    if (!quota) {
      let token = policy.token;
      if (!token) {
        try {
          token = (await runGhAsync(policy.credentialArgs)).trim();
        } catch {
          // The selected CLI retains its ordinary authentication behavior.
        }
      }
      quota = policy.initialize(token);
    }
    const paginate = args[0] === "api" && args.includes("--paginate");
    let pageArgs = paginate ? args.filter((arg) => arg !== "--paginate") : args;
    const pages = [];
    const visited = new Set();
    const base = new URL(`${policy.apiBaseUrl}/`);
    for (;;) {
      let release;
      for (;;) {
        const remaining = options.remainingMs?.() ?? Infinity;
        const admission = policy.admit(quota, pageArgs);
        if (admission.delay === undefined) {
          release = admission.release;
          break;
        }
        await new Promise((resolve) => {
          setTimeout(resolve, Math.min(admission.delay, remaining));
        });
      }
      let output = "";
      let failure;
      try {
        output = await runGhAsync(apiCommand(pageArgs));
      } catch (error) {
        failure = error;
        output = failureOutput(error);
      } finally {
        release();
      }
      const result = policy.observe(quota, pageArgs, output, failure);
      pages.push(result.body);
      if (result.error) {
        return { body: pages.join("\n"), error: result.error };
      }
      const next = paginate
        ? /<([^>]+)>;\s*rel="next"/u.exec(result.response?.headers.get("link") ?? "")?.[1]
        : undefined;
      if (!next) {
        return { body: pages.join("\n"), error: undefined };
      }
      let url;
      try {
        visited.add(new URL(pageArgs[1], base).href);
        url = new URL(next, base);
      } catch {
        throw new Error("GitHub API pagination returned an invalid next page");
      }
      if (
        url.origin !== base.origin ||
        !url.pathname.startsWith(base.pathname) ||
        url.username ||
        url.password ||
        visited.has(url.href)
      ) {
        throw new Error("GitHub API pagination returned an invalid next page");
      }
      pageArgs = [pageArgs[0], url.href, ...pageArgs.slice(2)];
    }
  };
}
