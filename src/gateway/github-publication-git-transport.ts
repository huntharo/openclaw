import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveGitHubApiBaseUrl, resolveGitHubHost } from "../agents/github-host-runtime.js";
import type { WorktreeGitPolicy } from "../agents/worktrees/checkout-git-config.js";
import { splitNullBuffer } from "../agents/worktrees/git-path-inventory.js";
import { hasErrnoCode } from "../infra/errno.js";
import { gitNullConfigPath } from "../infra/git-exec.js";
import { retryableGitNetworkOperation, withGitNetworkRetry } from "../infra/git-network-retry.js";
import { ApiQuotaError, getSharedApiQuota, apiRateLimitHint } from "../infra/http-api-quota.js";
import { parseHttpCommandResponse } from "../infra/http-command-response.js";
import { runCommandBuffered, type BufferedCommandResult } from "../process/exec.js";
import { withGitProcessOperation, type GitProcessOperation } from "../process/spawn-diagnostics.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import {
  githubPublicationBaseFetchArgs,
  githubPublicationBaseLookupArgs,
  githubPublicationUnsafeConfigArgs,
  parseGitHubPublicationBaseRef,
} from "./github-publication-base.js";
import {
  hasUnapprovedGitHubPublicationWorkflowChanges,
  isGitHubPublicationWorkflowPath,
} from "./github-publication-workflows.js";

type GitCommandOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  maxOutputBytes?: number;
  beforeRun?: () => void;
  operation?: GitProcessOperation;
};
type GitCommandResult = { code: number | null; stdout: Buffer };

export function githubPublicationApiArgs(
  endpoint: string,
  method = "GET",
  host = "github.com",
): string[] {
  return [
    "gh",
    "api",
    "--hostname",
    host,
    "--method",
    method,
    endpoint,
    ...(method === "GET" ? [] : ["--input", "-"]),
  ];
}

export async function runPublicationCommand(argv: string[], options: GitCommandOptions = {}) {
  const env = {
    ...(options.env ?? process.env),
    GIT_NO_REPLACE_OBJECTS: "1",
    // gh can invoke Git; keep every publication child pinned against repository hooks.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: os.devNull,
  };
  if (argv[0] === "gh" && argv[1] === "api") {
    return withGitProcessOperation(options.operation ?? "publication", () =>
      runPublicationApiCommand(argv, { ...options, env }),
    );
  }
  return await withGitProcessOperation(options.operation ?? "publication", () =>
    withGitNetworkRetry(
      argv[0] === "git" ? retryableGitNetworkOperation(argv.slice(1)) : undefined,
      { timeoutMs: 60_000, beforeRun: options.beforeRun },
      (timeoutMs) =>
        runCommandBuffered(argv, {
          ...(options.cwd ? { cwd: options.cwd } : {}),
          env,
          ...(options.input !== undefined ? { input: options.input } : {}),
          timeoutMs,
          maxOutputBytes: options.maxOutputBytes ?? 256 * 1024,
        }),
    ),
  );
}

// gh's internal pagination cannot join Gateway admission. Keep each page on the
// same transport so a throttle stops discovery and publication together.
async function runPublicationApiCommand(argv: string[], options: GitCommandOptions) {
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

export async function requirePublicationCommand(
  argv: string[],
  options: GitCommandOptions = {},
): Promise<string> {
  const result = await runPublicationCommand(argv, options);
  if (result.code !== 0) {
    throw new Error(`${argv[0]} command failed`);
  }
  return result.stdout.toString("utf8").trim();
}

// Guard ordinary steps on both sides of the await. Effects whose observations
// must survive revocation use the raw transport and record before rechecking.
export function createGitHubPublicationCommandRunner(
  assertCurrent?: () => void,
  gitOperation: GitProcessOperation = "publication",
) {
  const step = async <T>(operation: () => Promise<T>): Promise<T> => {
    assertCurrent?.();
    const result = await operation();
    assertCurrent?.();
    return result;
  };
  const run = async (argv: string[], options: GitCommandOptions = {}) => {
    const result = await runPublicationCommand(argv, {
      ...options,
      operation: gitOperation,
      beforeRun: assertCurrent,
    });
    assertCurrent?.();
    return result;
  };
  return {
    step,
    run,
    require: async (argv: string[], options: GitCommandOptions = {}) => {
      const result = await requirePublicationCommand(argv, {
        ...options,
        operation: gitOperation,
        beforeRun: assertCurrent,
      });
      assertCurrent?.();
      return result;
    },
  };
}

export async function readGitHubPublicationBaseSha(
  run: ReturnType<typeof createGitHubPublicationCommandRunner>["run"],
  repository: string,
  branch: string,
  host: string,
  env: NodeJS.ProcessEnv,
) {
  const result = await run(githubPublicationBaseLookupArgs(repository, branch, host), { env });
  if (result.code !== 0) {
    throw new Error("GitHub publication workspace base branch could not be verified.");
  }
  return parseGitHubPublicationBaseRef(result.stdout.toString("utf8"), branch);
}

export async function requireGitHubPublicationCommit(
  run: ReturnType<typeof createGitHubPublicationCommandRunner>["run"],
  repository: string,
  sha: string,
  host: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  failure: string,
) {
  const result = await run(githubPublicationBaseFetchArgs(repository, sha, host), { cwd, env });
  if (result.code !== 0) {
    throw new Error(failure);
  }
}

// A recursive tree listing scales with repository size (openclaw itself is
// ~3.3MB), far past the default per-command cap above. Without this explicit
// bound the attribute scan dies as an output-limit "verification" failure on
// any real repository.
const TREE_LISTING_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export async function hasGitHubPublicationWorkflowChanges(params: {
  cwd: string;
  comparisonCommit: string;
  ancestryCommit: string;
  targetCommit: string;
  workspaceTree: string;
  run: typeof runPublicationCommand;
}): Promise<boolean> {
  const trees = new Map<string, Promise<Map<string, string>>>();
  const workflows = (tree: string) =>
    getOrCreatePromise(trees, tree, async () => {
      const listing = await params.run(
        ["git", "ls-tree", "-r", "-z", "--full-tree", tree, "--", ".github/workflows"],
        { cwd: params.cwd, maxOutputBytes: TREE_LISTING_MAX_OUTPUT_BYTES },
      );
      if (listing.code !== 0) {
        throw new Error("GitHub publication workspace workflows could not be verified.");
      }
      const entries = new Map<string, string>();
      for (const record of listing.stdout.toString("latin1").split("\0").filter(Boolean)) {
        const tab = record.indexOf("\t");
        const [mode, , sha] = record.slice(0, tab).split(" ");
        if (tab < 0 || !mode || !sha) {
          throw new Error("GitHub publication workspace workflows could not be verified.");
        }
        const file = record.slice(tab + 1);
        if (isGitHubPublicationWorkflowPath(file)) {
          entries.set(file, mode + ":" + sha);
        }
      }
      return entries;
    });
  const [before, accepted] = await Promise.all([
    workflows(params.comparisonCommit),
    workflows(params.workspaceTree),
  ]);
  return await hasUnapprovedGitHubPublicationWorkflowChanges({
    before,
    accepted,
    readUpstream: async () => {
      const result = await params.run(
        ["git", "merge-base", "--all", params.ancestryCommit, params.targetCommit],
        { cwd: params.cwd },
      );
      if (result.code !== 0) {
        throw new Error("GitHub publication workflow ancestry could not be verified.");
      }
      const bases = result.stdout.toString("utf8").trim().split(/\s+/u);
      if (bases.length !== 1 || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(bases[0]!)) {
        return undefined;
      }
      const [ancestor, target] = await Promise.all([
        workflows(bases[0]!),
        workflows(params.targetCommit),
      ]);
      return { ancestor, target };
    },
  });
}

export async function assertSafeGitPublicationWorkspace(
  cwd: string,
  run: (argv: string[], options?: Omit<GitCommandOptions, "input">) => Promise<GitCommandResult>,
): Promise<void> {
  const isolatedConfig = {
    GIT_CONFIG_GLOBAL: gitNullConfigPath(),
    GIT_CONFIG_SYSTEM: gitNullConfigPath(),
  };
  const [localUnsafe, worktreeConfig] = await Promise.all([
    run(githubPublicationUnsafeConfigArgs("--local"), { cwd, env: isolatedConfig }),
    run(
      ["git", "config", "--local", "--includes", "--bool", "--get", "extensions.worktreeConfig"],
      { cwd, env: isolatedConfig },
    ),
  ]);
  const worktreeConfigValue = worktreeConfig.stdout.toString("utf8").trim();
  const worktreeConfigKnown =
    (worktreeConfig.code === 0 &&
      (worktreeConfigValue === "true" || worktreeConfigValue === "false")) ||
    (worktreeConfig.code === 1 && worktreeConfig.stdout.length === 0);
  if (localUnsafe.code !== 1 || localUnsafe.stdout.length > 0 || !worktreeConfigKnown) {
    throw new Error("GitHub publication workspace has unsupported Git transport configuration.");
  }
  const worktreeUnsafe =
    worktreeConfigValue === "true"
      ? await run(githubPublicationUnsafeConfigArgs("--worktree"), {
          cwd,
          env: isolatedConfig,
        })
      : undefined;
  if (worktreeUnsafe && (worktreeUnsafe.code !== 1 || worktreeUnsafe.stdout.length > 0)) {
    throw new Error("GitHub publication workspace has unsupported Git transport configuration.");
  }
  const [replacements, graftPath] = await Promise.all([
    run(["git", "for-each-ref", "--count=1", "--format=%(refname)", "refs/replace"], { cwd }),
    run(["git", "rev-parse", "--git-path", "info/grafts"], { cwd }),
  ]);
  if (replacements.code !== 0 || replacements.stdout.length > 0 || graftPath.code !== 0) {
    throw new Error("GitHub publication workspace has unsupported Git replacement metadata.");
  }
  const grafts = await readOptionalAttributeFile(
    path.resolve(cwd, graftPath.stdout.toString("utf8").trim()),
  );
  if (grafts && grafts.length > 0) {
    throw new Error("GitHub publication workspace has unsupported Git replacement metadata.");
  }
}

function assertNoGitFilterAttributes(contents: Buffer): void {
  for (const line of contents.toString("latin1").split(/\r?\n/u)) {
    const fields = line.trimStart().split(/[\t ]+/u);
    if (!fields[0] || fields[0].startsWith("#")) {
      continue;
    }
    if (fields.slice(1).some((field) => /^(?:-|!)?filter(?:=|$)/u.test(field))) {
      throw new Error("GitHub publication workspace uses an unsupported Git clean filter.");
    }
  }
}

async function readOptionalAttributeFile(file: string): Promise<Buffer | undefined> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export async function readGitHubPublicationTree(
  cwd: string,
  workspaceTree: string,
  run: (argv: string[], options?: Omit<GitCommandOptions, "input">) => Promise<GitCommandResult>,
): Promise<Buffer> {
  const listing = await run(["git", "ls-tree", "-r", "-z", "--full-tree", workspaceTree], {
    cwd,
    maxOutputBytes: TREE_LISTING_MAX_OUTPUT_BYTES,
  });
  if (listing.code !== 0) {
    throw new Error("GitHub publication workspace tree could not be verified.");
  }
  return listing.stdout;
}

async function assertGitHubPublicationTreeHasNoFilters(
  cwd: string,
  workspaceTree: string,
  run: (argv: string[], options?: Omit<GitCommandOptions, "input">) => Promise<GitCommandResult>,
): Promise<void> {
  const listing = await readGitHubPublicationTree(cwd, workspaceTree, run);
  const attributeObjects = new Set<string>();
  for (const record of listing.toString("latin1").split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) {
      continue;
    }
    const file = record.slice(tab + 1).toLowerCase();
    if (file !== ".gitattributes" && !file.endsWith("/.gitattributes")) {
      continue;
    }
    const objectId = record.slice(0, tab).split(" ")[2];
    if (objectId) {
      attributeObjects.add(objectId);
    }
  }
  if (attributeObjects.size > 1024) {
    throw new Error("GitHub publication workspace has too many Git attribute files.");
  }
  for (const objectId of attributeObjects) {
    const blob = await run(["git", "cat-file", "blob", objectId], { cwd });
    if (blob.code !== 0) {
      throw new Error("GitHub publication workspace attributes could not be verified.");
    }
    assertNoGitFilterAttributes(blob.stdout);
  }

  const infoPath = await run(["git", "rev-parse", "--git-path", "info/attributes"], {
    cwd,
  });
  if (infoPath.code !== 0) {
    throw new Error("GitHub publication workspace attributes could not be verified.");
  }
  const attributeFiles = await Promise.all(
    ["GIT_ATTR_GLOBAL", "GIT_ATTR_SYSTEM"].map(
      async (name) => await run(["git", "var", name], { cwd }),
    ),
  );
  if (attributeFiles.some((result) => result.code !== 0)) {
    throw new Error("GitHub publication workspace attributes could not be verified.");
  }
  const paths = [
    path.resolve(cwd, infoPath.stdout.toString("utf8").trim()),
    ...attributeFiles.flatMap((result) =>
      result.stdout.length > 0 ? [result.stdout.toString("utf8").trim()] : [],
    ),
  ];
  for (const file of paths) {
    const contents = await readOptionalAttributeFile(file);
    if (contents) {
      assertNoGitFilterAttributes(contents);
    }
  }
}

export async function captureGitHubPublicationWorkspaceSnapshot(params: {
  cwd: string;
  assertCurrent?: () => void;
}): Promise<{ sourceHeadCommit: string; sourceIndexTree: string; workspaceTree: string }> {
  const { withSettledLocalWorkspacePath } =
    await import("./worker-environments/local-workspace-projection.js");
  return await withSettledLocalWorkspacePath(params, async (custody) => {
    const admittedPaths = await custody?.canonicalPaths();
    const bound = {
      ...params,
      assertCurrent: () => {
        params.assertCurrent?.();
        custody?.assertCurrent();
      },
    };
    const [{ findLiveRegistryWorktreeByPath }, { withManagedWorktreeGit }, { getRuntimeConfig }] =
      await Promise.all([
        import("../agents/worktrees/registry.js"),
        import("../agents/worktrees/checkout-policy.js"),
        import("../config/config.js"),
      ]);
    const record = findLiveRegistryWorktreeByPath(process.env, params.cwd);
    return record
      ? await withManagedWorktreeGit(
          {
            record,
            env: process.env,
            getConfig: getRuntimeConfig,
            beforeRun: bound.assertCurrent,
          },
          (git) =>
            captureSettledGitHubPublicationWorkspaceSnapshot(
              bound,
              git.sourceOnly ? git : undefined,
              admittedPaths,
            ),
        )
      : await captureSettledGitHubPublicationWorkspaceSnapshot(bound, undefined, admittedPaths);
  });
}

async function captureSettledGitHubPublicationWorkspaceSnapshot(
  params: {
    cwd: string;
    assertCurrent?: () => void;
  },
  policy?: WorktreeGitPolicy,
  admittedPaths?: ReadonlySet<string>,
): Promise<{ sourceHeadCommit: string; sourceIndexTree: string; workspaceTree: string }> {
  const { step, require: command } = createGitHubPublicationCommandRunner(params.assertCurrent);
  const git = (args: string[], env?: NodeJS.ProcessEnv, input?: string | Buffer) =>
    policy
      ? step(() =>
          policy.require(params.cwd, args, { env, input, beforeRun: params.assertCurrent }),
        )
      : command(
          ["git", "-c", `core.hooksPath=${os.devNull}`, "-c", "core.fsmonitor=false", ...args],
          {
            cwd: params.cwd,
            env,
            input,
          },
        );
  await step(() => assertSafeGitPublicationWorkspace(params.cwd, runPublicationCommand));
  const sourceHeadCommit = await command(["git", "rev-parse", "--verify", "HEAD^{commit}"], {
    cwd: params.cwd,
  });
  const index = path.resolve(params.cwd, await git(["rev-parse", "--git-path", "index"]));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-github-snapshot-"));
  try {
    const env = {
      GIT_ATTR_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: gitNullConfigPath(),
      GIT_CONFIG_SYSTEM: gitNullConfigPath(),
      GIT_INDEX_FILE: path.join(tempDir, "index"),
    };
    // Preserve staged path inventory, and keep write-tree cache updates off the real index.
    const indexStat = await step(() => fs.stat(index, { bigint: true }));
    await step(() => fs.copyFile(index, env.GIT_INDEX_FILE));
    // A newer copy timestamp hides racy-clean edits. Round down so lost precision only adds reads.
    const indexTimestamp = Number(indexStat.mtimeNs / 1_000_000_000n);
    await step(() => fs.utimes(env.GIT_INDEX_FILE, indexTimestamp, indexTimestamp));
    const sourceIndexTree = await git(["write-tree"], env);
    // Ordinary staging preserves unchanged blobs; renormalization would rewrite unrelated CRLF files.
    await git(["-c", `core.attributesFile=${os.devNull}`, "add", "-A"], env);
    let workspaceTree = await git(["write-tree"], env);
    if (admittedPaths) {
      // Staging must not turn guest-edited ignore rules into host admission.
      // Prune only the private publication index; canonical archive and host
      // index custody are unchanged. This also handles directory replacements
      // without recursive pathspecs enrolling unowned descendants.
      const staged = await step(() =>
        readGitHubPublicationTree(params.cwd, workspaceTree, runPublicationCommand),
      );
      const admitted = new Set(
        [...admittedPaths].map((entry) => Buffer.from(entry).toString("hex")),
      );
      const excluded = splitNullBuffer(staged)
        .map((record) => record.subarray(record.indexOf(9) + 1))
        .filter((entry) => !admitted.has(entry.toString("hex")));
      if (excluded.length) {
        await git(
          ["update-index", "--force-remove", "-z", "--stdin"],
          env,
          Buffer.concat(excluded.flatMap((entry) => [entry, Buffer.from([0])])),
        );
        workspaceTree = await git(["write-tree"], env);
      }
    }
    await step(() =>
      assertGitHubPublicationTreeHasNoFilters(params.cwd, workspaceTree, runPublicationCommand),
    );
    return { sourceHeadCommit, sourceIndexTree, workspaceTree };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

const GITHUB_CREDENTIAL_ARGS = [
  "git",
  "-c",
  "credential.helper=",
  "-c",
  "credential.helper=!gh auth git-credential",
] as const;

export async function readGitHubPublicationCoauthorTrailers(params: {
  cwd: string;
  headCommit: string;
  command: typeof requirePublicationCommand;
}): Promise<string[]> {
  const output = await params.command(
    [
      "git",
      "-c",
      "trailer.separators=:",
      "-c",
      "trailer.co-authored-by.key=Co-authored-by",
      "show",
      "-s",
      "--format=%(trailers:key=Co-authored-by,only,unfold)",
      params.headCommit,
    ],
    { cwd: params.cwd },
  );
  return output.split(/\r?\n/u);
}

export function appendGitHubPublicationMessage(base: string, lines: readonly string[]): string {
  const footer = [...new Set(lines)].join("\n");
  return footer ? `${base.trimEnd()}\n\n${footer}` : base.trimEnd();
}

/** Prepared commits use our terminal credit footer, never matching prose elsewhere in the message. */
export function hasGitHubPublicationMessageFooter(
  message: string,
  coauthorTrailers: readonly string[],
  publicationMarker: string,
): boolean {
  const lines = message.replace(/[\r\n]+$/u, "").split(/\r?\n/u);
  const separator = lines.lastIndexOf("");
  if (separator < 1 || lines.at(-1) !== publicationMarker) {
    return false;
  }
  const actual = lines.slice(separator + 1, -1);
  const expected = new Set(coauthorTrailers);
  return actual.length === expected.size && [...expected].every((line) => actual.includes(line));
}

export async function assertGitHubPublicationBranchRef(
  branch: string,
  run: (argv: string[]) => Promise<number>,
): Promise<void> {
  const code = await run(["git", "symbolic-ref", "--quiet", `refs/heads/${branch}`]);
  if (code === 0) {
    throw new Error("GitHub publication workspace branch ref became symbolic.");
  }
  if (code !== 1) {
    throw new Error("GitHub publication workspace branch ref could not be verified.");
  }
}

export function githubPublicationPushArgs(
  remote: string,
  headCommit: string,
  branch: string,
  expectedRemoteHead: string,
): string[] {
  return [
    ...GITHUB_CREDENTIAL_ARGS,
    "-c",
    `core.hooksPath=${os.devNull}`,
    "push",
    "--porcelain",
    // The executor proves ancestry first. Pin that proof to this exact remote
    // value (or absence); the lease never substitutes for the fast-forward check.
    `--force-with-lease=refs/heads/${branch}:${expectedRemoteHead}`,
    "--no-follow-tags",
    "--recurse-submodules=no",
    "--",
    remote,
    `${headCommit}:refs/heads/${branch}`,
  ];
}

export function githubPublicationRemoteHeadArgs(remote: string, branch: string): string[] {
  return [...GITHUB_CREDENTIAL_ARGS, "ls-remote", "--refs", remote, `refs/heads/${branch}`];
}

export function githubPublicationUpdateRefArgs(
  branch: string,
  commit: string,
  previousHead: string,
): string[] {
  return [
    "git",
    "-c",
    `core.hooksPath=${os.devNull}`,
    "-c",
    "core.fsmonitor=false",
    "update-ref",
    `refs/heads/${branch}`,
    commit,
    previousHead,
  ];
}
