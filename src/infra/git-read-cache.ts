import { createHash } from "node:crypto";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { notifyListeners, registerListener } from "../shared/listeners.js";
import type { GitReadOperation, GitReadOperations } from "./git-read-operations.js";
import { runGitWorkerOperation } from "./git-worker.js";
import { pruneMapToMaxSize } from "./map-size.js";

const MAX_CACHED_CHECKOUTS = 1_000;

export type GitReadOptions = {
  /** Refresh unversioned layouts; known revisions are always revalidated. */
  refresh?: boolean;
  signal?: AbortSignal;
};

export type GitReadChange = {
  root: string;
  type: keyof GitReadOperations | "invalidated";
};

type ReadEntry<T> = {
  roots: readonly string[];
  revision: string;
  expiresAt: number;
  promise: Promise<T>;
  controller: AbortController;
  subscribers: number;
  pending: boolean;
};

function subscribe<T>(
  entry: ReadEntry<T>,
  clone: (value: T) => T,
  signal?: AbortSignal,
): Promise<T> {
  entry.subscribers += 1;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      entry.subscribers -= 1;
      if (entry.pending && entry.subscribers === 0) {
        entry.expiresAt = 0;
        entry.controller.abort();
        // Final cancellation remains joined to the owner's process teardown.
        void entry.promise.then(complete, complete);
        return;
      }
      complete();
    };
    const abort = () => finish(() => reject(toErrorObject(signal?.reason, "Git read aborted")));
    signal?.addEventListener("abort", abort, { once: true });
    entry.promise.then(
      (value) => finish(() => resolve(clone(value))),
      (error: unknown) => finish(() => reject(toErrorObject(error, "Git read failed"))),
    );
    if (signal?.aborted) {
      abort();
    }
  });
}

function createReadCache<Input, Output>(
  load: (input: Input, signal: AbortSignal) => Promise<Output>,
  options: {
    freshnessMs: number;
    type: keyof GitReadOperations;
    rootsOf: (input: Input) => readonly string[];
    publish: (change: GitReadChange) => void;
    clone?: (value: Output) => Output;
    revision?: (input: Input, signal: AbortSignal) => Promise<string | null>;
    keyOf?: (input: Input) => string;
  },
) {
  const { freshnessMs, type, rootsOf, publish, revision } = options;
  const clone: (value: Output) => Output = options.clone ?? structuredClone;
  const keyOf = options.keyOf ?? JSON.stringify;
  // Versioned reads retain only the current inputs/revision per checkout. LRU
  // eviction and Gateway shutdown own their lifetime, independently of viewers.
  const entries = new Map<string, ReadEntry<Output>>();
  const pending = new Set<ReadEntry<Output>>();
  const revisions = new Map<
    AbortController,
    { promise: Promise<string | null>; roots: readonly string[] }
  >();
  const fingerprints = new Map<string, { value: string; roots: readonly string[] }>();
  let closed = false;
  const remove = (key: string, entry: ReadEntry<Output>) => {
    if (entries.get(key) === entry) {
      entries.delete(key);
    }
  };
  return {
    async read(input: Input, readOptions: GitReadOptions = {}): Promise<Output> {
      readOptions.signal?.throwIfAborted();
      const prepared = structuredClone(input);
      const key = keyOf(prepared);
      const roots = [...new Set(rootsOf(prepared))];
      let currentRevision: string | null | undefined;
      if (revision) {
        const controller = new AbortController();
        const check = revision(
          prepared,
          readOptions.signal
            ? AbortSignal.any([controller.signal, readOptions.signal])
            : controller.signal,
        );
        revisions.set(controller, { promise: check, roots });
        try {
          currentRevision = await check;
          controller.signal.throwIfAborted();
        } finally {
          revisions.delete(controller);
        }
      }
      const revisionKey = JSON.stringify([prepared, currentRevision]);
      readOptions.signal?.throwIfAborted();
      if (closed) {
        throw new Error("Git reads are unavailable while the Gateway is restarting");
      }
      let entry = entries.get(key);
      if (
        (readOptions.refresh && currentRevision === null) ||
        !entry ||
        entry.revision !== revisionKey ||
        entry.expiresAt <= Date.now()
      ) {
        const controller = new AbortController();
        const next: ReadEntry<Output> = {
          roots,
          revision: revisionKey,
          expiresAt:
            freshnessMs === 0
              ? Number.POSITIVE_INFINITY
              : Date.now() +
                (currentRevision === null ? Math.min(freshnessMs, 75_000) : freshnessMs),
          controller,
          subscribers: 0,
          pending: true,
          promise: Promise.resolve().then(() => load(prepared, controller.signal)),
        };
        pending.add(next);
        next.promise = next.promise.then(
          (value) => {
            next.pending = false;
            pending.delete(next);
            controller.signal.throwIfAborted();
            if (entries.get(key) === next && !closed) {
              // Keep only digests: diff reads must not retain settled patch bodies.
              const valueFingerprint = createHash("sha256")
                .update(JSON.stringify([currentRevision, value]))
                .digest("hex");
              const previous = fingerprints.get(key);
              fingerprints.delete(key);
              fingerprints.set(key, { value: valueFingerprint, roots });
              pruneMapToMaxSize(fingerprints, MAX_CACHED_CHECKOUTS);
              if (previous?.value !== valueFingerprint) {
                for (const root of roots) {
                  publish({ root, type });
                }
              }
            }
            controller.signal.throwIfAborted();
            if (freshnessMs === 0) {
              remove(key, next);
            }
            return value;
          },
          (error: unknown) => {
            next.pending = false;
            pending.delete(next);
            next.expiresAt = 0;
            remove(key, next);
            throw error;
          },
        );
        // Replace at admission. An older completion updates only its own entry.
        entry = next;
      }
      entries.delete(key);
      entries.set(key, entry);
      pruneMapToMaxSize(entries, MAX_CACHED_CHECKOUTS);
      return subscribe(entry, clone, readOptions.signal);
    },
    invalidate(root: string): void {
      for (const [controller, check] of revisions) {
        if (check.roots.includes(root)) {
          controller.abort(new Error("Git facts were invalidated"));
        }
      }
      for (const entry of pending) {
        if (entry.roots.includes(root)) {
          entry.expiresAt = 0;
          entry.controller.abort(new Error("Git facts were invalidated"));
        }
      }
      for (const [key, entry] of entries) {
        if (entry.roots.includes(root)) {
          entries.delete(key);
        }
      }
      for (const [key, fingerprint] of fingerprints) {
        if (fingerprint.roots.includes(root)) {
          fingerprints.delete(key);
        }
      }
    },
    async close(): Promise<void> {
      closed = true;
      for (const controller of revisions.keys()) {
        controller.abort();
      }
      const retiring = [...pending];
      for (const entry of retiring) {
        entry.expiresAt = 0;
        entry.controller.abort();
      }
      entries.clear();
      fingerprints.clear();
      await Promise.allSettled([
        ...[...revisions.values()].map((check) => check.promise),
        ...retiring.map((entry) => entry.promise),
      ]);
    },
  };
}

// Every read checks ref/index metadata. A five-minute fallback observes
// unstaged working-tree edits, which do not advance that revision.
function createReadCaches(publish: (change: GitReadChange) => void) {
  return {
    identities: createReadCache(
      (input: GitReadOperations["repository.identities"]["input"], signal) =>
        runGitWorkerOperation({ type: "repository.identities", input }, { signal }),
      {
        // Identity includes Git config and worktree relocation inputs without a complete revision.
        // Share only pending passes so later discovery always sees external changes.
        freshnessMs: 0,
        type: "repository.identities",
        rootsOf: (input) => input.roots,
        publish,
      },
    ),
    context: createReadCache(
      (input: GitReadOperations["checkout.context"]["input"], signal) =>
        runGitWorkerOperation({ type: "checkout.context", input }, { signal }),
      {
        freshnessMs: Number.POSITIVE_INFINITY,
        type: "checkout.context",
        rootsOf: (input) => [input.root],
        publish,
        revision: (input, signal) =>
          runGitWorkerOperation(
            { type: "checkout.revision", input: { root: input.root, includeIndex: false } },
            { signal },
          ),
        keyOf: (input) => input.root,
      },
    ),
    branchFacts: createReadCache(
      (input: GitReadOperations["pull-request.branch-facts"]["input"], signal) =>
        runGitWorkerOperation({ type: "pull-request.branch-facts", input }, { signal }),
      {
        freshnessMs: 5 * 60_000,
        type: "pull-request.branch-facts",
        rootsOf: (input) => [input.root],
        publish,
        revision: (input, signal) =>
          runGitWorkerOperation(
            {
              type: "checkout.revision",
              input: { ...input, includeIndex: true },
            },
            { signal },
          ),
        keyOf: (input) => input.root,
      },
    ),
    diff: createReadCache(
      (input: GitReadOperations["checkout.diff"]["input"], signal) =>
        runGitWorkerOperation({ type: "checkout.diff", input }, { signal }),
      {
        freshnessMs: 0,
        type: "checkout.diff",
        rootsOf: (input) => [input.cwd],
        publish,
        // Callers mutate transport fields; immutable patch strings can stay shared.
        clone: (diff) => ({
          ...diff,
          files: diff.files.map((file) => ({ ...file })),
          ...(diff.commits ? { commits: diff.commits.map((commit) => ({ ...commit })) } : {}),
          ...(diff.mergeBase ? { mergeBase: { ...diff.mergeBase } } : {}),
        }),
      },
    ),
    branches: createReadCache(
      (input: GitReadOperations["repository.branches"]["input"], signal) =>
        runGitWorkerOperation({ type: "repository.branches", input }, { signal }),
      {
        freshnessMs: 0,
        type: "repository.branches",
        rootsOf: (input) => [input.repoRoot],
        publish,
      },
    ),
    baseline: createReadCache(
      (input: GitReadOperations["checkout.baseline"]["input"], signal) =>
        runGitWorkerOperation({ type: "checkout.baseline", input }, { signal }),
      {
        freshnessMs: 0,
        type: "checkout.baseline",
        rootsOf: (input) => [input.cwd],
        publish,
      },
    ),
  };
}

type GitReadRuntime = {
  caches?: ReturnType<typeof createReadCaches>;
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
  const { context, branchFacts, diff, branches, baseline, identities } = (state.caches ??=
    createReadCaches((change) => notifyListeners(state.listeners, change)));
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
      return diff.read(operation.input, options);
    case "repository.branches":
      return branches.read(operation.input, options);
    case "checkout.baseline":
      return baseline.read(operation.input, options);
  }
  throw new Error("Unsupported Git read operation");
}
