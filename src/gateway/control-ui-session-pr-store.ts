import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import type { GitCheckoutContext, GitMergedPullHead } from "../infra/git-read-operations.js";
import type { ApiRequestStore } from "../infra/http-api-quota.js";
import { apiStoreRequestKey } from "../infra/http-api-read-store.js";
import { createRetainedCache } from "../infra/retained-cache.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequests,
} from "./control-ui-contract.js";
import {
  createGitHubReadGroup,
  prepareSessionPullRequestGitHubRead,
} from "./control-ui-session-pr-request.js";
import { gitHubPublicApi } from "./github-public-api.js";

export type BranchPullRequestsSnapshot = ControlUiSessionPullRequests & {
  publicationCandidates: ControlUiSessionPullRequest[];
  mergedHeads: GitMergedPullHead[];
  workingBranchHasLivePullRequest: boolean;
};
export type BranchCacheEntry = {
  access: ReturnType<typeof createGitHubReadGroup>;
  expiresAt: number;
  promise: Promise<BranchPullRequestsSnapshot>;
  refreshMode: "normal" | "forced" | null;
  lastGood?: Omit<BranchPullRequestsSnapshot, "rateLimited" | "status" | "branch">;
  store: ApiRequestStore;
  dependencies: Map<string, { store: ApiRequestStore; revision: number; consumed: boolean }>;
  discoveredPullRequests: Set<string>;
  changeGeneration: number;
  invalidationGeneration: number;
  readers: Map<AbortSignal, { identity: string; relationship?: string }>;
  relationships: Set<string>;
};
type Read = ReturnType<typeof prepareSessionPullRequestGitHubRead>;
type BranchLoad = (
  context: GitCheckoutContext,
  read: Read,
  entry: BranchCacheEntry,
) => Promise<BranchPullRequestsSnapshot>;
const SUCCESS_CACHE_MS = 90_000;

function pruneRelationships(entry: BranchCacheEntry) {
  const watched = new Set([...entry.readers.values()].map((reader) => reader.relationship));
  const unwatched = [...entry.relationships].filter((key) => !watched.has(key));
  for (const key of unwatched.slice(0, Math.max(0, unwatched.length - 100))) {
    entry.relationships.delete(key);
  }
}

function createStore() {
  const active = new Map<BranchCacheEntry, number>();
  const cache = createRetainedCache<BranchCacheEntry>({
    onRelease: (entry, signal) => {
      entry.readers.delete(signal);
      pruneRelationships(entry);
      // The retained cache removes its last pin after this callback returns.
      queueMicrotask(pruneSubscriptions);
    },
  });
  const subscriptions = new Map<ApiRequestStore, () => void>();
  const entries = () => new Set([...cache.values(), ...active.keys()]);
  function pruneSubscriptions() {
    const used = new Set<ApiRequestStore>();
    for (const entry of entries()) {
      used.add(entry.store);
      for (const dependency of entry.dependencies.values()) {
        used.add(dependency.store);
      }
    }
    for (const [store, unsubscribe] of subscriptions) {
      if (!used.has(store)) {
        unsubscribe();
        subscriptions.delete(store);
      }
    }
  }
  const scopes = new WeakMap<ApiRequestStore, number>();
  let nextScope = 0;
  const listeners = new Set<(identities: ReadonlySet<string>) => void>();
  const observe = (store: ApiRequestStore) => {
    if (subscriptions.has(store)) {
      return;
    }
    const notify = (identities: Set<string>) => {
      if (identities.size > 0) {
        for (const listener of listeners) {
          listener(identities);
        }
      }
    };
    const canonical = gitHubPublicApi.getGitHubPullRequestStore(store).subscribe((change) => {
      const identities = new Set<string>();
      const pullIdentity = `${change.owner}/${change.repo}#${change.number}`.toLowerCase();
      for (const entry of entries()) {
        if (
          (entry.store === store ||
            [...entry.dependencies.values()].some((dependency) => dependency.store === store)) &&
          (entry.discoveredPullRequests.has(pullIdentity) ||
            entry.lastGood?.pullRequests.some(
              (pull) =>
                pull.owner.toLowerCase() === change.owner.toLowerCase() &&
                pull.repo.toLowerCase() === change.repo.toLowerCase() &&
                pull.number === change.number,
            ))
        ) {
          if (entry.refreshMode) {
            entry.changeGeneration += 1;
          } else {
            entry.expiresAt = 0;
          }
          for (const reader of entry.readers.values()) {
            identities.add(reader.identity);
          }
        }
      }
      notify(identities);
    });
    const requests = store.responses.subscribe((change) => {
      if (!change.changed) {
        return;
      }
      const identities = new Set<string>();
      for (const entry of entries()) {
        if (
          entry.store !== store &&
          ![...entry.dependencies.values()].some((dependency) => dependency.store === store)
        ) {
          continue;
        }
        const dependency = entry.dependencies.get(change.key);
        if (
          dependency?.store === store &&
          (!entry.refreshMode || change.invalidated || dependency.consumed)
        ) {
          if (entry.refreshMode) {
            entry.changeGeneration += 1;
            if (change.invalidated) {
              entry.invalidationGeneration += 1;
            }
          }
          if (!entry.refreshMode || change.invalidated) {
            entry.expiresAt = 0;
          }
          for (const reader of entry.readers.values()) {
            identities.add(reader.identity);
          }
        }
      }
      notify(identities);
    });
    subscriptions.set(store, () => {
      canonical();
      requests();
    });
  };
  return {
    cache,
    listeners,
    observe,
    pruneSubscriptions,
    use(entry: BranchCacheEntry) {
      active.set(entry, (active.get(entry) ?? 0) + 1);
      return () => {
        const remaining = (active.get(entry) ?? 1) - 1;
        if (remaining === 0) {
          active.delete(entry);
        } else {
          active.set(entry, remaining);
        }
        pruneSubscriptions();
      };
    },
    scope(store: ApiRequestStore) {
      let id = scopes.get(store);
      if (id === undefined) {
        id = ++nextScope;
        scopes.set(store, id);
      }
      return id;
    },
    close() {
      for (const entry of entries()) {
        entry.access.abort();
      }
      cache.clear();
      active.clear();
      for (const unsubscribe of subscriptions.values()) {
        unsubscribe();
      }
      subscriptions.clear();
      listeners.clear();
    },
  };
}
const owner = resolveGlobalSingleton(
  Symbol.for("openclaw.sessionPullRequestStore"),
  createStore,
  (store) => store.close(),
  "close-only",
);

export function subscribeSessionPullRequestStore(
  listener: (identities: ReadonlySet<string>) => void,
): () => void {
  owner.listeners.add(listener);
  return () => owner.listeners.delete(listener);
}

function branchKey(context: GitCheckoutContext, read: Read): string {
  return JSON.stringify([
    owner.scope(read.store),
    read.host,
    read.apiBaseUrl,
    context.owner.toLowerCase(),
    context.repo.toLowerCase(),
    context.branch,
    read.cacheScope,
  ]);
}

export function knownBranchMergedHeads(
  context: GitCheckoutContext,
  read: Read,
  relationship: string,
): readonly GitMergedPullHead[] {
  const key = relationshipKey(context, read, relationship);
  const entry = [...owner.cache.values()].find((candidate) => candidate.relationships.has(key));
  return structuredClone(entry?.lastGood?.mergedHeads ?? []);
}

function relationshipKey(context: GitCheckoutContext, read: Read, relationship: string): string {
  return JSON.stringify([
    relationship,
    read.host,
    read.apiBaseUrl,
    context.owner.toLowerCase(),
    context.repo.toLowerCase(),
    context.branch,
    read.cacheScope,
  ]);
}

export function releaseSessionPullRequestStore(signal?: AbortSignal): void {
  owner.cache.release(signal);
  owner.pruneSubscriptions();
}

/** Branch lookup ownership excludes session identity; each joining reader retains its own grant. */
export async function loadSharedBranchPullRequests(
  context: GitCheckoutContext,
  read: Read,
  options: {
    refresh: boolean;
    signal?: AbortSignal;
    identity: string;
    relationship: string;
    fetchImpl: typeof fetch;
  },
  load: BranchLoad,
): Promise<BranchPullRequestsSnapshot> {
  read.assertCurrent();
  const key = branchKey(context, read);
  const cached = owner.cache.get(key, options.signal);
  const entry: BranchCacheEntry = cached ?? {
    access: createGitHubReadGroup(),
    expiresAt: 0,
    promise: Promise.resolve({
      pullRequests: [],
      publicationCandidates: [],
      mergedHeads: [],
      workingBranchHasLivePullRequest: false,
      rateLimited: false,
    }),
    refreshMode: null,
    store: read.store,
    dependencies: new Map(),
    discoveredPullRequests: new Set(),
    changeGeneration: 0,
    invalidationGeneration: 0,
    readers: new Map(),
    relationships: new Set(),
  };
  if (options.signal && !entry.readers.has(options.signal)) {
    const signal = options.signal;
    entry.readers.set(signal, { identity: options.identity });
  }
  const reusable =
    entry.expiresAt > Date.now() &&
    !entry.access.signal.aborted &&
    [...entry.dependencies].every(
      ([requestKey, dependency]) =>
        !dependency.store.responses.revision(requestKey) ||
        dependency.store.responses.revision(requestKey) === dependency.revision,
    );
  if (entry.access.signal.aborted) {
    entry.access = createGitHubReadGroup();
  }
  const release = entry.access.add(read.assertCurrent, options.signal);
  const refresh = async () => {
    let forced = options.refresh;
    for (;;) {
      entry.access.assertCurrent();
      const generation = entry.changeGeneration;
      const invalidation = entry.invalidationGeneration;
      const transportRead = prepareSessionPullRequestGitHubRead(
        read.host,
        options.fetchImpl,
        entry.access.assertCurrent,
        {
          signal: entry.access.signal,
          refresh: forced,
          onRequest: (url, store) => {
            owner.observe(store);
            entry.dependencies.set(apiStoreRequestKey(url), {
              store,
              revision: store.responses.revision(apiStoreRequestKey(url)),
              consumed: false,
            });
            owner.pruneSubscriptions();
          },
          onResponse: (url, store, observation) => {
            const requestKey = apiStoreRequestKey(url);
            const dependency = entry.dependencies.get(requestKey);
            if (dependency?.store === store) {
              dependency.consumed = true;
              if (store.responses.latestObservation(requestKey) > observation) {
                entry.changeGeneration += 1;
              }
            }
          },
        },
      );
      entry.dependencies.clear();
      owner.pruneSubscriptions();
      entry.discoveredPullRequests.clear();
      const snapshot = await load(context, transportRead, entry);
      entry.access.assertCurrent();
      if (
        generation !== entry.changeGeneration &&
        !snapshot.rateLimited &&
        (snapshot.status !== "unavailable" || invalidation !== entry.invalidationGeneration)
      ) {
        // Changes during sibling subreads reproject accepted facts without forcing another fetch.
        forced = false;
        continue;
      }
      for (const [requestKey, dependency] of entry.dependencies) {
        dependency.revision = dependency.store.responses.revision(requestKey);
      }
      if (!snapshot.rateLimited && snapshot.status !== "unavailable") {
        entry.expiresAt = Date.now() + SUCCESS_CACHE_MS;
      }
      return snapshot;
    }
  };
  const track = (mode: "normal" | "forced", run: () => Promise<BranchPullRequestsSnapshot>) => {
    entry.expiresAt = Date.now() + SUCCESS_CACHE_MS;
    entry.refreshMode = mode;
    const releaseUse = owner.use(entry);
    const promise = run().finally(() => {
      if (entry.promise === promise) {
        entry.refreshMode = null;
      }
      releaseUse();
    });
    entry.promise = promise;
    return promise;
  };
  const releaseUse = owner.use(entry);
  try {
    owner.observe(read.store);
    owner.cache.set(key, entry, options.signal);
    owner.pruneSubscriptions();
    let promise = entry.promise;
    if (entry.refreshMode && (!options.refresh || entry.refreshMode === "forced")) {
      // A cache event during this load does not split identical pending branch lookups.
    } else if (reusable && !options.refresh) {
      // Serving still rechecks this reader below; shared facts do not grant access.
    } else if (entry.refreshMode) {
      const previous = entry.promise;
      promise = track("forced", async () => {
        const snapshot = await previous;
        entry.access.assertCurrent();
        return snapshot.rateLimited ? snapshot : refresh();
      });
    } else {
      promise = track(options.refresh ? "forced" : "normal", refresh);
    }
    const snapshot = await racePromiseWithAbortSignal(promise, options.signal);
    read.assertCurrent();
    const relationship = relationshipKey(context, read, options.relationship);
    entry.relationships.delete(relationship);
    entry.relationships.add(relationship);
    const reader = options.signal && entry.readers.get(options.signal);
    if (reader) {
      reader.relationship = relationship;
    }
    // Unwatched relationships are hints, not grants; bound them with the containing cache.
    pruneRelationships(entry);
    return structuredClone(snapshot);
  } finally {
    release();
    releaseUse();
    read.assertCurrent();
  }
}
