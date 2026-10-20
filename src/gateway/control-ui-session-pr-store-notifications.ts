import path from "node:path";
import { subscribeGitReadChanges } from "../infra/git-read-cache.js";
import type { ApiRequestStore } from "../infra/http-api-quota.js";
import { apiStoreRequestKey } from "../infra/http-api-read-store.js";
import {
  sessionChanges,
  sessionChangeScopeAffectsStoredRows,
} from "../sessions/session-row-changes.js";
import type { AsyncWorkScope } from "../shared/async-work-scope.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { githubPublicationReceipts } from "../state/github-publication-receipts.js";
import type { PreparedSessionPrState } from "./control-ui-session-pr-prepared-read.js";
import { subscribeSessionPullRequestStore } from "./control-ui-session-pr-store.js";

/** Fact changes reproject existing authorized subscriptions; consumers never start another poller. */
export function createSessionPrStoreNotifications<State extends PreparedSessionPrState>(deps: {
  states: Map<string, State>;
  scope: AsyncWorkScope;
  pending: (key: string) => Promise<unknown> | undefined;
  reload: (key: string, state: State) => Promise<unknown>;
  reconcile: (key: string) => Promise<unknown>;
}) {
  const dirty = new Map<string, State>();
  const taskReaders = new Map<
    ApiRequestStore,
    {
      readers: Map<State, Set<string>>;
      unsubscribe: () => void;
    }
  >();
  const releaseTaskReads = new Map<State, () => void>();
  let draining: Promise<void> | undefined;
  let stopped = false;
  const drain = () => {
    if (stopped || deps.scope.isClosing || draining || !dirty.size) {
      return;
    }
    const work = runInDetachedAsyncContext(() =>
      deps.scope
        .track(async () => {
          // Publishing a required PR subread can wake us before its containing lookup finishes.
          // Join that lookup first, then reproject the accepted shared facts once.
          while (dirty.size) {
            if (stopped || deps.scope.isClosing) {
              break;
            }
            const batch = [...dirty];
            dirty.clear();
            await Promise.allSettled(
              batch.map(async ([key, state]) => {
                await deps.pending(key)?.catch(() => {});
                if (stopped || deps.scope.isClosing || deps.states.get(key) !== state) {
                  return;
                }
                if (state.connIds.size) {
                  await deps.reload(key, state);
                } else if (state.prepared) {
                  state.snapshot = undefined;
                  sessionChanges.emit({ ...state.target.params, scope: "runtime" });
                }
              }),
            );
          }
        })
        .finally(() => {
          draining = undefined;
          drain();
        }),
    );
    draining = work;
    void work.catch(() => {});
  };
  const changed = (matches: (state: State) => boolean) => {
    if (stopped || deps.scope.isClosing) {
      return;
    }
    for (const [key, state] of deps.states) {
      if (matches(state)) {
        dirty.set(key, state);
      }
    }
    drain();
  };
  const unsubscribePr = subscribeSessionPullRequestStore((identities) =>
    changed((state) => identities.has(state.target.identity)),
  );
  const unsubscribeGit = subscribeGitReadChanges(({ root }) =>
    changed((state) => {
      const source = state.target.source;
      const cwd = typeof source === "string" ? source : source?.root;
      if (!cwd) {
        return false;
      }
      const relative = path.relative(root, cwd);
      return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
    }),
  );
  const stopLineage = sessionChanges.subscribeFacts((change) => {
    const ownAuthorityChanged =
      "all" in change &&
      (change.scope === "profiles" ||
        change.scope === "config" ||
        change.scope === "config-profiles");
    if (
      deps.states.size === 0 ||
      (!ownAuthorityChanged && !sessionChangeScopeAffectsStoredRows(change)) ||
      ("facts" in change && change.facts?.kind === "unchanged")
    ) {
      return;
    }
    // One notification owns the concurrent reads; each watcher still authorizes its audience.
    const keys: string[] = [];
    for (const [key, state] of deps.states) {
      // A removed root may be immediately replaced under the same key. The next
      // entry notification (or normal poll) reconciles that watch after replacement.
      const removedRoot =
        "sessionKey" in change &&
        change.sessionKey === state.target.params.sessionKey &&
        change.facts?.kind === "removed";
      if (
        !removedRoot &&
        (!ownAuthorityChanged || state.target.ownGitHubProfileId) &&
        (state.target.taskReceipts || state.target.ownGitHubProfileId) &&
        state.connIds.size
      ) {
        keys.push(key);
      }
    }
    if (keys.length > 0) {
      void deps.scope.track(() => Promise.allSettled(keys.map(deps.reconcile))).catch(() => {});
    }
  });

  const stopReceipts = githubPublicationReceipts.subscribeFacts((change) => {
    if (change.kind !== "committed" && change.kind !== "unknown") {
      return;
    }
    // Commit events refresh the existing watched union; no child poller is created.
    for (const [key, state] of deps.states) {
      if (!state.target.taskReceipts) {
        continue;
      }
      state.snapshot = undefined;
      if (state.prepared) {
        sessionChanges.emit({ ...state.target.params, scope: "runtime" });
      }
      if (state.connIds.size) {
        void deps.scope
          .track(async () => {
            await deps.pending(key);
            await deps.reload(key, state);
          })
          .catch(() => {});
      }
    }
  });

  return {
    beginTaskRead(state: State) {
      releaseTaskReads.get(state)?.();
      // Metadata replays dependencies after its read settles, avoiding notifications from
      // the initial response. Passive receipt-only views never register a dependency.
      return (url: string, store: ApiRequestStore) => {
        if (stopped || state.cacheLifetime.signal.aborted || deps.scope.isClosing) {
          return;
        }
        if (!releaseTaskReads.has(state)) {
          const release = () => {
            state.cacheLifetime.signal.removeEventListener("abort", release);
            releaseTaskReads.delete(state);
            for (const [selected, observation] of taskReaders) {
              observation.readers.delete(state);
              if (!observation.readers.size) {
                observation.unsubscribe();
                taskReaders.delete(selected);
              }
            }
          };
          releaseTaskReads.set(state, release);
          state.cacheLifetime.signal.addEventListener("abort", release, { once: true });
        }
        let observation = taskReaders.get(store);
        if (!observation) {
          const readers = new Map<State, Set<string>>();
          observation = {
            readers,
            unsubscribe: store.responses.subscribe((event) => {
              if (event.changed) {
                changed((current) => readers.get(current)?.has(event.key) === true);
              }
            }),
          };
          taskReaders.set(store, observation);
        }
        let requests = observation.readers.get(state);
        if (!requests) {
          requests = new Set();
          observation.readers.set(state, requests);
        }
        requests.add(apiStoreRequestKey(url));
      };
    },
    async settle(pending: Iterable<Promise<unknown>> = []): Promise<void> {
      await Promise.allSettled(pending);
      for (;;) {
        const current = draining;
        if (!current) {
          return;
        }
        await current.catch(() => {});
      }
    },
    stop() {
      stopped = true;
      stopReceipts();
      stopLineage();
      unsubscribePr();
      unsubscribeGit();
      for (const release of releaseTaskReads.values()) {
        release();
      }
      dirty.clear();
    },
  };
}
