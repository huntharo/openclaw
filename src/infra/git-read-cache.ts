import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import {
  createGitReadCache,
  gitEnvironmentKey,
  type GitReadOptions,
} from "./git-read-cache-owner.js";
import type { GitReadOperation, GitReadOperations } from "./git-read-operations.js";
import type { GitWorkerOperations } from "./git-worker-contract.js";
import { runGitWorkerOperation } from "./git-worker.js";

export type { GitReadOptions } from "./git-read-cache-owner.js";

const log = createSubsystemLogger("git/read");

export type GitReadChange = {
  root: string;
  type: keyof GitReadOperations | "invalidated";
};

function createDiffReadCache(
  publish: (change: GitReadChange) => void,
  freshness: Parameters<typeof createGitReadCache>[2],
  maxEntries?: number,
) {
  const revisionInput = (
    input: GitReadOperations["checkout.diff"]["input"],
    previous?: GitReadOperations["checkout.diff"]["output"],
  ): GitReadOperations["checkout.revision"]["input"] => ({
    root: input.cwd,
    scope: "diff",
    summaryOnly: input.summaryOnly === true,
    paths: previous?.files
      .flatMap((file) => (file.oldPath ? [file.path, file.oldPath] : [file.path]))
      .toSorted(),
  });
  return createGitReadCache<
    GitReadOperations["checkout.diff"]["input"],
    GitReadOperations["checkout.diff"]["output"]
  >(
    {
      rootsOf: (input) => [input.cwd],
      changed: (root) => publish({ root, type: "checkout.diff" }),
    },
    (input: GitReadOperations["checkout.diff"]["input"], signal, diffTiming) =>
      runGitWorkerOperation({ type: "checkout.diff", input }, { signal, diffTiming }),
    freshness,
    (input, signal, diffTiming, previous) =>
      runGitWorkerOperation(
        {
          type: "checkout.revision",
          input: revisionInput(input, previous),
        },
        { signal, diffTiming },
      ),
    gitEnvironmentKey,
    undefined,
    (value) => (value.unavailableReason === "not_git" ? 1_000 : !value.unavailableReason),
    maxEntries,
    { empty: () => ({ files: [], additions: 0, deletions: 0, computing: true }) },
    (input, previous) => gitEnvironmentKey(revisionInput(input, previous)),
  );
}

function createGitReadCaches(publish: (change: GitReadChange) => void) {
  const comparisons = createGitReadCache<
    GitWorkerOperations["pull-request.branch-comparison"]["input"],
    GitWorkerOperations["pull-request.branch-comparison"]["output"]
  >(
    { rootsOf: (input) => [input.root] },
    (input, signal) =>
      runGitWorkerOperation({ type: "pull-request.branch-comparison", input }, { signal }),
    Number.POSITIVE_INFINITY,
    (input, signal) =>
      runGitWorkerOperation(
        { type: "checkout.revision", input: { ...input, scope: "refs" } },
        { signal },
      ),
    (input) => input.root,
    undefined,
    // Missing objects can arrive without moving refs; retry incomplete comparisons.
    (value) => value.complete,
  );
  return {
    comparisons,
    identities: createGitReadCache(
      {
        rootsOf: (input: GitReadOperations["repository.identities"]["input"]) => input.roots,
        changed: (root) => publish({ root, type: "repository.identities" }),
      },
      (input: GitReadOperations["repository.identities"]["input"], signal) =>
        runGitWorkerOperation({ type: "repository.identities", input }, { signal }),
      // Display-only discovery never delays a listing, even on a cold checkout set.
      // External Git config/relocations have no complete revision: refresh in the background
      // after one minute; checkout-set/environment changes select an independent snapshot.
      60_000,
      undefined,
      gitEnvironmentKey,
      { empty: () => [] },
    ),
    context: createGitReadCache(
      {
        rootsOf: (input: GitReadOperations["checkout.context"]["input"]) => [input.root],
        changed: (root) => publish({ root, type: "checkout.context" }),
      },
      (input: GitReadOperations["checkout.context"]["input"], signal) =>
        runGitWorkerOperation({ type: "checkout.context", input }, { signal }),
      Number.POSITIVE_INFINITY,
      (input, signal) =>
        runGitWorkerOperation(
          { type: "checkout.revision", input: { root: input.root, scope: "context" } },
          { signal },
        ),
      (input) => input.root,
    ),
    branchFacts: createGitReadCache(
      {
        rootsOf: (input: GitReadOperations["pull-request.branch-facts"]["input"]) => [input.root],
        changed: (root) => publish({ root, type: "pull-request.branch-facts" }),
      },
      async (input: GitReadOperations["pull-request.branch-facts"]["input"], signal) => {
        try {
          const { refreshIndex: _, ...comparisonInput } = input;
          const comparison = await comparisons.read(comparisonInput, { signal, refresh: true });
          return await runGitWorkerOperation(
            { type: "pull-request.branch-facts", input: { ...input, comparison } },
            { signal },
          );
        } catch {
          signal.throwIfAborted();
          log.warn(
            "PR comparison unavailable; fetch repository history and retry. Dependent comparisons skipped.",
          );
          return { creatable: false, stats: null };
        }
      },
      // Unstaged edits do not advance the ref/index revision.
      5 * 60_000,
      (input, signal) =>
        runGitWorkerOperation(
          {
            type: "checkout.revision",
            input: { ...input, scope: "worktree" },
          },
          { signal },
        ),
      (input) => input.root,
    ),
    diff: createDiffReadCache(
      publish,
      { milliseconds: 0 },
      // Full results may retain 1.5 MB of patches each.
      32,
    ),
    diffSummary: createDiffReadCache(
      publish,
      // Visible clients share this short-lived summary; never duplicate a slow scan.
      {
        milliseconds: 10_000,
        joinPending: true,
      },
    ),
    branches: createGitReadCache(
      {
        rootsOf: (input: GitReadOperations["repository.branches"]["input"]) => [input.repoRoot],
        changed: (root) => publish({ root, type: "repository.branches" }),
      },
      (input: GitReadOperations["repository.branches"]["input"], signal) =>
        runGitWorkerOperation({ type: "repository.branches", input }, { signal }),
      0,
    ),
    baseline: createGitReadCache(
      {
        rootsOf: (input: GitReadOperations["checkout.baseline"]["input"]) => [input.cwd],
        changed: (root) => publish({ root, type: "checkout.baseline" }),
      },
      (input: GitReadOperations["checkout.baseline"]["input"], signal) =>
        runGitWorkerOperation({ type: "checkout.baseline", input }, { signal }),
      0,
    ),
  };
}

type GitReadRuntime = {
  caches?: ReturnType<typeof createGitReadCaches>;
  closing?: Promise<void>;
  listeners: Set<(change: GitReadChange) => void>;
};

function runtime(): GitReadRuntime {
  return resolveGlobalSingleton<GitReadRuntime>(
    Symbol.for("openclaw.gitReadCache"),
    () => ({ listeners: new Set() }),
    (state) => {
      state.listeners.clear();
      state.closing ??= Promise.resolve()
        .then(async () => {
          const caches = state.caches;
          state.caches = undefined;
          if (caches) {
            await Promise.all(Object.values(caches).map((cache) => cache.close()));
          }
        })
        .finally(() => {
          state.closing = undefined;
        });
      return state.closing;
    },
  );
}

/** Observe the Git owner's accepted facts without starting reads or retaining a checkout. */
export function subscribeGitReadChanges(listener: (change: GitReadChange) => void): () => void {
  const state = runtime();
  if (state.closing) {
    throw new Error("Git reads are unavailable while the Gateway is restarting");
  }
  return registerListener(state.listeners, listener);
}

/** Owned Git mutations retire captured facts before dependent readers can publish them. */
export function invalidateGitReads(root: string): void {
  const state = runtime();
  if (state.closing) {
    return;
  }
  for (const cache of Object.values(state.caches ?? {})) {
    cache.invalidate(root);
  }
  notifyListeners(state.listeners, { root, type: "invalidated" });
}

export function runGitReadOperation<K extends keyof GitReadOperations>(
  operation: { type: K; input: GitReadOperations[K]["input"] },
  options?: GitReadOptions,
): Promise<GitReadOperations[K]["output"]>;
export function runGitReadOperation(operation: GitReadOperation, options?: GitReadOptions) {
  const state = runtime();
  if (state.closing) {
    return Promise.reject(new Error("Git reads are unavailable while the Gateway is restarting"));
  }
  const caches = (state.caches ??= createGitReadCaches((change) =>
    notifyListeners(state.listeners, change),
  ));
  const { context, branchFacts, branches, baseline, identities } = caches;
  switch (operation.type) {
    case "repository.identities":
      return identities.read(operation.input, options);
    case "checkout.revision":
      return runGitWorkerOperation(operation, options);
    case "checkout.context":
      return context.read(operation.input, options);
    case "pull-request.branch-facts":
      return branchFacts.read(operation.input, options);
    case "checkout.diff":
      return readDiff(
        operation.input.summaryOnly ? caches.diffSummary : caches.diff,
        operation.input,
        options,
      );
    case "repository.branches":
      return branches.read(operation.input, options);
    case "checkout.baseline":
      return baseline.read(operation.input, options);
  }
  throw new Error("Unsupported Git read operation");
}

async function readDiff(
  cache: ReturnType<typeof createGitReadCaches>["diff"],
  input: GitReadOperations["checkout.diff"]["input"],
  options?: GitReadOptions,
) {
  const value = await cache.read(input, options);
  // Transport truncation mutates these envelopes, not the shared patch strings.
  return {
    ...value,
    files: value.files.map((file) => ({ ...file })),
    ...(value.commits ? { commits: value.commits.map((commit) => ({ ...commit })) } : {}),
    ...(value.mergeBase ? { mergeBase: { ...value.mergeBase } } : {}),
  };
}
