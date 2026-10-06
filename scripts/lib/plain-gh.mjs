import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

/** @typedef {import("node:child_process").ExecFileSyncOptions} ExecFileSyncOptions */
/** @typedef {import("node:child_process").ExecFileSyncOptionsWithBufferEncoding} ExecFileSyncOptionsWithBufferEncoding */
/** @typedef {import("node:child_process").ExecFileSyncOptionsWithStringEncoding} ExecFileSyncOptionsWithStringEncoding */
/**
 * @typedef {(
 *   command: string,
 *   args: readonly string[],
 *   options: ExecFileSyncOptions,
 * ) => string | Uint8Array<ArrayBuffer>} ExecGhReadImpl
 */

const PLAIN_GH_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const execFileAsync = promisify(execFile);

/**
 * Match gh's native default host without reading or extracting its credentials.
 * Keep config parsing lazy for the stdlib-only synchronous reader import path.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<string>}
 */
export async function resolvePlainGhHost(env = process.env) {
  if (env.GH_HOST) {
    return env.GH_HOST;
  }
  const windows = process.platform === "win32";
  const appData = env.AppData || env.APPDATA;
  const home = (windows ? env.USERPROFILE : env.HOME) || "";
  const directory =
    env.GH_CONFIG_DIR ||
    (env.XDG_CONFIG_HOME && path.join(env.XDG_CONFIG_HOME, "gh")) ||
    (windows && appData && path.join(appData, "GitHub CLI")) ||
    path.join(home, ".config", "gh");
  try {
    const { extractErrorCode } =
      process.versions.bun || import.meta.url.endsWith(".js")
        ? await import("../../packages/normalization-core/src/error-coercion.js")
        : await (
            await import("tsx/esm/api")
          ).tsImport(
            new URL("../../packages/normalization-core/src/error-coercion.js", import.meta.url)
              .href,
            import.meta.url,
          );
    const readConfig = (name) =>
      fs.promises
        .readFile(path.join(directory, name), "utf8")
        .catch((/** @type {unknown} */ error) => {
          if (extractErrorCode(error) === "ENOENT") {
            return undefined;
          }
          throw error;
        });
    const hostsText = await readConfig("hosts.yml");
    const generalText = await readConfig("config.yml");
    if (hostsText === undefined && generalText === undefined) {
      return "github.com";
    }
    const { isMap, isScalar, parseDocument } = await import("yaml");
    const hostsDocument = parseDocument(hostsText ?? "", { prettyErrors: false });
    const generalDocument = parseDocument(generalText ?? "", { prettyErrors: false });
    for (const document of [hostsDocument, generalDocument]) {
      if (
        document.errors.length ||
        document.warnings.length ||
        (document.contents && !isMap(document.contents))
      ) {
        return "github.com";
      }
    }
    const hosts =
      isMap(hostsDocument.contents) && hostsDocument.contents.items.length
        ? hostsDocument.contents
        : generalDocument.get("hosts", true);
    if (!isMap(hosts) || hosts.items.length !== 1) {
      return "github.com";
    }
    const [{ key }] = hosts.items;
    return isScalar(key) && typeof key.value === "string" ? key.value : "github.com";
  } catch {
    // Native gh also falls back to its public host when config loading fails.
    return "github.com";
  }
}

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Explicit binary overrides may need credentials from a separate PATH entry
 * point. Forward its token only to that child; the default PATH route owns its
 * credentials and must not have them extracted or reinjected.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function plainGhAuthenticatedEnv(env) {
  const next = plainGhEnv(env);
  if (
    !next.OPENCLAW_GH_BIN ||
    next.GH_TOKEN ||
    next.GITHUB_TOKEN ||
    next.GH_ENTERPRISE_TOKEN ||
    next.GITHUB_ENTERPRISE_TOKEN
  ) {
    return next;
  }

  const tokenEnv = { ...next };
  delete tokenEnv.OPENCLAW_GH_BIN;
  const args = ["auth", "token"];
  if (tokenEnv.GH_HOST) {
    args.push("--hostname", tokenEnv.GH_HOST);
  }
  try {
    const token = execFileSync("gh", args, {
      encoding: "utf8",
      env: tokenEnv,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    }).trim();
    if (token) {
      if (tokenEnv.GH_HOST && tokenEnv.GH_HOST !== "github.com") {
        next.GH_ENTERPRISE_TOKEN = token;
      } else {
        next.GH_TOKEN = token;
      }
    }
  } catch {
    // The selected CLI may have usable credentials in its own config.
  }
  return next;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function plainGhEnv(env = process.env) {
  const next = { ...env };
  delete next.CLICOLOR;
  delete next.CLICOLOR_FORCE;
  delete next.COLORTERM;
  delete next.GH_FORCE_TTY;
  next.NO_COLOR = "1";
  next.FORCE_COLOR = "0";
  next.CLICOLOR = "0";
  next.CLICOLOR_FORCE = "0";
  return next;
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [cwd]
 * @returns {string}
 */
export function resolvePlainGhBin(env = process.env, cwd = process.cwd()) {
  if (env.OPENCLAW_GH_BIN) {
    if (isExecutable(env.OPENCLAW_GH_BIN)) {
      return env.OPENCLAW_GH_BIN;
    }
    throw new Error(`OPENCLAW_GH_BIN is not executable: ${env.OPENCLAW_GH_BIN}`);
  }

  if (process.versions.bun) {
    // oxlint-disable-next-line no-warning-comments -- remove after the upstream Bun PATH fix ships.
    // TODO(bun): remove this once Bun resolves empty PATH entries against the child cwd.
    const names =
      process.platform === "win32"
        ? (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
            .split(";")
            .filter(Boolean)
            .map((extension) => `gh${extension.toLowerCase()}`)
        : ["gh"];
    for (const entry of (env.PATH ?? "").split(path.delimiter)) {
      for (const name of names) {
        const candidate = path.resolve(cwd, entry || ".", name);
        if (isExecutable(candidate)) {
          return candidate;
        }
      }
    }
  }

  // child_process resolves PATH in the child cwd, including relative and empty entries.
  return "gh";
}

/**
 * @overload
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptionsWithStringEncoding} options
 * @returns {string}
 */
/**
 * @overload
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptionsWithBufferEncoding} [options]
 * @returns {Uint8Array<ArrayBuffer>}
 */
/**
 * @overload
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptions} [options]
 * @returns {string | Uint8Array<ArrayBuffer>}
 */
/**
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptions} [options]
 * @returns {string | Uint8Array<ArrayBuffer>}
 */
export function execPlainGh(args, options = {}) {
  const env = plainGhAuthenticatedEnv(options.env ?? process.env);
  const ghBin = resolvePlainGhBin(env, options.cwd ?? process.cwd());
  return execFileSync(ghBin, args, {
    ...options,
    env,
    maxBuffer: options.maxBuffer ?? PLAIN_GH_MAX_BUFFER_BYTES,
  });
}

/**
 * @overload
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptionsWithStringEncoding} options
 * @param {{execFileSyncImpl?: ExecGhReadImpl}} [params]
 * @returns {string}
 */
/**
 * @overload
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptionsWithBufferEncoding} [options]
 * @param {{execFileSyncImpl?: ExecGhReadImpl}} [params]
 * @returns {Uint8Array<ArrayBuffer>}
 */
/**
 * @overload
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptions} [options]
 * @param {{execFileSyncImpl?: ExecGhReadImpl}} [params]
 * @returns {string | Uint8Array<ArrayBuffer>}
 */
/**
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptions} [options]
 * @param {{execFileSyncImpl?: ExecGhReadImpl}} [params]
 * @returns {string | Uint8Array<ArrayBuffer>}
 */
export function execGhRead(args, options = {}, params = {}) {
  const execFileSyncImpl = params.execFileSyncImpl ?? execFileSync;
  return execFileSyncImpl("gh", args, {
    ...options,
    env: ghReadEnv(options.env),
    maxBuffer: options.maxBuffer ?? PLAIN_GH_MAX_BUFFER_BYTES,
  });
}

/** @param {NodeJS.ProcessEnv} [env] */
function ghReadEnv(env) {
  const next = plainGhEnv(env);
  // Cache-aware reads stay on PATH even when another caller selects an explicit binary.
  delete next.OPENCLAW_GH_BIN;
  return next;
}

/**
 * @param {readonly string[]} args
 * @param {import("node:child_process").ExecFileOptions} [options]
 * @returns {Promise<string>}
 */
export async function execGhReadAsync(args, options = {}) {
  const { stdout } = await execFileAsync("gh", args, {
    ...options,
    encoding: "utf8",
    env: ghReadEnv(options.env),
    maxBuffer: options.maxBuffer ?? PLAIN_GH_MAX_BUFFER_BYTES,
  });
  return stdout;
}

/**
 * @param {readonly string[]} args
 * @param {ExecFileSyncOptions} [options]
 * @param {{execFileSyncImpl?: ExecGhReadImpl}} [params]
 * @returns {unknown}
 */
export function execGhJson(args, options = {}, params = {}) {
  return JSON.parse(execGhRead(args, { ...options, encoding: "utf8" }, params));
}

/**
 * @param {string} repo
 * @param {string} sha
 * @param {string} event
 * @param {number} perPage
 * @returns {string[]}
 */
export function workflowRunsApiArgs(repo, sha, event, perPage) {
  return [
    "api",
    "--method",
    "GET",
    `repos/${repo}/actions/workflows/ci.yml/runs`,
    "-f",
    `event=${event}`,
    "-f",
    `head_sha=${sha}`,
    "-f",
    `per_page=${perPage}`,
  ];
}

/**
 * @overload
 * @param {string} endpoint
 * @param {ExecFileSyncOptionsWithStringEncoding} options
 * @returns {string}
 */
/**
 * @overload
 * @param {string} endpoint
 * @param {ExecFileSyncOptionsWithBufferEncoding} [options]
 * @returns {Uint8Array<ArrayBuffer>}
 */
/**
 * @overload
 * @param {string} endpoint
 * @param {ExecFileSyncOptions} [options]
 * @returns {string | Uint8Array<ArrayBuffer>}
 */
/**
 * @param {string} endpoint
 * @param {ExecFileSyncOptions} [options]
 * @returns {string | Uint8Array<ArrayBuffer>}
 */
export function execGhApiRead(endpoint, options = {}) {
  return execGhRead(["api", endpoint, "--method", "GET"], options);
}
