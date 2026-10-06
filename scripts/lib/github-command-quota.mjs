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
  const [
    { ApiQuotaError, getSharedApiQuota, apiStoreRequestKey, apiRateLimitHint },
    { parseHttpCommandResponse },
  ] = await loadQuotaModules();
  quotaErrorConstructor = ApiQuotaError;
  const { env = process.env } = options;
  const hostname = (options.hostname || (await resolvePlainGhHost(env))).trim().toLowerCase();
  const cloud = hostname === "github.com" || hostname.endsWith(".ghe.com");
  const apiBaseUrl = cloud ? `https://api.${hostname}` : `https://${hostname}/api/v3`;
  const token = cloud
    ? env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim()
    : env.GH_ENTERPRISE_TOKEN?.trim() || env.GITHUB_ENTERPRISE_TOKEN?.trim();
  const resourceFor = (args) =>
    args[0] === "api" ? commandRequest(args, apiBaseUrl, apiStoreRequestKey).resource : "core";

  return {
    apiBaseUrl,
    token,
    credentialArgs: ["auth", "token", "--hostname", hostname],
    initialize: (resolvedToken) => getSharedApiQuota({ apiBaseUrl, token: resolvedToken }),
    request: (args) => commandRequest(args, apiBaseUrl, apiStoreRequestKey),
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

function commandRequest(args, apiBaseUrl, requestKey) {
  if (args[0] !== "api") {
    return undefined;
  }
  let endpoint;
  let endpointIndex;
  let method;
  let query;
  let input = false;
  let refresh = false;
  const fields = [];
  const typedFields = [];
  const representation = [];
  for (let index = 1; index < args.length; index++) {
    const [flag, inline] = args[index].split(/[=](.*)/s, 2);
    const value = () => inline ?? args[++index];
    if (["--method", "-X"].includes(flag)) {
      method = value()?.toUpperCase();
    } else if (["--field", "--raw-field", "-f", "-F"].includes(flag)) {
      const field = value();
      const separator = field?.indexOf("=") ?? -1;
      if (separator > 0) {
        const name = field.slice(0, separator);
        const content = field.slice(separator + 1);
        fields.push([name, content]);
        typedFields.push([flag, name, content]);
        if (name === "query") {
          query = content;
        }
      }
    } else if (["--jq", "-q", "--template", "-t"].includes(flag)) {
      representation.push([flag, value()]);
    } else if (["--header", "-H"].includes(flag)) {
      const header = value() ?? "";
      if (/^cache-control\s*:/i.test(header)) {
        refresh ||= /\b(?:max-age\s*=\s*0|no-cache|no-store)\b/i.test(header);
      } else {
        representation.push(["header", header]);
      }
    } else if (flag === "--input") {
      input = true;
      representation.push([flag, value()]);
    } else if (["--preview", "-p", "--cache"].includes(flag)) {
      representation.push([flag, value()]);
    } else if (flag === "--hostname") {
      value();
    } else if (["--silent", "--slurp", "--verbose"].includes(flag)) {
      representation.push([flag]);
    } else if (!args[index].startsWith("-") && !endpoint) {
      endpoint = args[index];
      endpointIndex = index;
    }
  }
  if (!endpoint) {
    throw new Error("GitHub API command endpoint is missing");
  }
  method ??= fields.length || input ? "POST" : "GET";
  const graphqlUrl = apiBaseUrl.endsWith("/api/v3")
    ? apiBaseUrl.slice(0, -3) + "/graphql"
    : apiBaseUrl + "/graphql";
  const graphql = endpoint === "graphql" || endpoint === graphqlUrl;
  const url = new URL(
    graphql && apiBaseUrl.endsWith("/api/v3") ? "../graphql" : endpoint,
    apiBaseUrl + "/",
  );
  const base = new URL(apiBaseUrl + "/");
  if (
    url.origin !== base.origin ||
    url.username ||
    url.password ||
    (!graphql && !url.pathname.startsWith(base.pathname))
  ) {
    throw new Error("GitHub API command endpoint is outside the configured host");
  }
  if (method === "GET" && !input) {
    for (const [name, value] of fields) {
      url.searchParams.append(name, value);
    }
  }
  const mutation = graphql
    ? input || !query || !/^\s*(?:#[^\n]*\n\s*)*(?:query\b|\{)/.test(query)
    : method !== "GET" && method !== "HEAD";
  const payload = method === "GET" ? [] : typedFields;
  const signature =
    payload.length || representation.length ? JSON.stringify([payload, representation]) : undefined;
  return {
    key: requestKey(url.href, method, signature),
    resource: graphql
      ? "graphql"
      : url.pathname.endsWith("/search/code")
        ? "code_search"
        : url.pathname.includes("/search/")
          ? "search"
          : "core",
    url: url.href,
    endpointIndex,
    mutation,
    refresh: refresh || input,
    repository: /\/repos\/([^/]+\/[^/]+)(?:\/|$)/.exec(url.pathname)?.[1],
  };
}

function commandResponse(result) {
  const response = result.response ?? new Response(null, { status: 200 });
  return new Response([204, 205, 304].includes(response.status) ? null : result.body, {
    status: response.status,
    headers: response.headers,
  });
}

function invalidateMutation(quota, request) {
  quota.responses.invalidate((key) => {
    if (!request.repository) {
      return true;
    }
    const [, url] = JSON.parse(key);
    return new URL(url).pathname
      .toLowerCase()
      .includes(`/repos/${request.repository.toLowerCase()}/`);
  });
}

function nextPageArgs(args, request, next, base, visited) {
  let url;
  try {
    visited.add(request.url);
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
  const nextArgs = [...args];
  nextArgs[request.endpointIndex] = url.href;
  // Link supplies the complete query; fields would append it a second time.
  return nextArgs.filter((arg, index) => {
    const field = /^(?:-f|-F|--field|--raw-field)(?:=|$)/;
    return !field.test(arg) && !/^(?:-f|-F|--field|--raw-field)$/.test(nextArgs[index - 1] ?? "");
  });
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
    const paginate = args[0] === "api" && args.includes("--paginate");
    let pageArgs = paginate ? args.filter((arg) => arg !== "--paginate") : args;
    const pages = [];
    const visited = new Set();
    const base = new URL(`${policy.apiBaseUrl}/`);
    for (;;) {
      options.remainingMs?.();
      const request = policy.request(pageArgs);
      const dispatch = () => {
        let release;
        for (;;) {
          const remaining = options.remainingMs?.() ?? Infinity;
          const admission = policy.admit(quota, pageArgs);
          if (admission.delay === undefined) {
            release = admission.release;
            break;
          }
          Atomics.wait(waitSignal, 0, 0, Math.min(admission.delay, remaining));
        }
        let output = "";
        let failure;
        try {
          output = runGh(apiCommand(pageArgs));
        } catch (error) {
          failure = error;
          output = failureOutput(error);
        } finally {
          release();
        }
        return policy.observe(quota, pageArgs, output, failure);
      };
      let result;
      if (!request) {
        result = dispatch();
      } else {
        try {
          const stored = quota.responses.readBuffered(
            request.key,
            () => {
              const dispatched = dispatch();
              if (dispatched.error) {
                throw dispatched.error;
              }
              const response = commandResponse(dispatched);
              if (request.mutation && response.ok) {
                invalidateMutation(quota, request);
              }
              return { body: Buffer.from(dispatched.body), response };
            },
            {
              refresh: request.refresh || request.mutation,
              freshnessMs: request.mutation ? 0 : undefined,
              maxBodyBytes: 64 * 1024 * 1024,
            },
          );
          result = {
            body: Buffer.from(stored.body).toString("utf8"),
            error: undefined,
            response: stored.response,
          };
        } catch (error) {
          if (isGitHubCommandQuotaError(error)) {
            throw error;
          }
          const output = failureOutput(error);
          result = policy.observe(quota, pageArgs, output, error);
        }
      }
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
      pageArgs = nextPageArgs(pageArgs, request, next, base, visited);
    }
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
      options.remainingMs?.();
      const request = policy.request(pageArgs);
      const dispatch = async () => {
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
        return policy.observe(quota, pageArgs, output, failure);
      };
      let result;
      try {
        if (!request) {
          result = await dispatch();
        } else {
          const load = async () => {
            const dispatched = await dispatch();
            if (dispatched.error) {
              throw dispatched.error;
            }
            return commandResponse(dispatched);
          };
          let response;
          if (request.mutation) {
            const observation = quota.responses.beginObservation();
            response = await load();
            if (response.ok) {
              invalidateMutation(quota, request);
              await quota.responses.remember(request.key, response.clone(), observation);
              // Mutation observations feed subscribers but never answer a later mutation.
              quota.responses.invalidate((key) => key === request.key);
            }
          } else {
            response = await quota.responses.read(request.key, load, {
              refresh: request.refresh,
              maxBodyBytes: 64 * 1024 * 1024,
            });
          }
          result = { body: await response.text(), error: undefined, response };
        }
      } catch (error) {
        if (isGitHubCommandQuotaError(error)) {
          throw error;
        }
        result = policy.observe(quota, pageArgs, failureOutput(error), error);
      }
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
      pageArgs = nextPageArgs(pageArgs, request, next, base, visited);
    }
  };
}
