import path from "node:path";
import { subscribeGitReadChanges } from "../infra/git-read-cache.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import type { AsyncWorkScope } from "../shared/async-work-scope.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import type { PreparedSessionPrState } from "./control-ui-session-pr-prepared-read.js";
import { subscribeSessionPullRequestStore } from "./control-ui-session-pr-store.js";

/** Fact changes reproject existing authorized subscriptions; consumers never start another poller. */
export function createSessionPrStoreNotifications<State extends PreparedSessionPrState>(deps: {
  states: Map<string, State>;
  scope: AsyncWorkScope;
  pending: (key: string) => Promise<unknown> | undefined;
  reload: (key: string, state: State) => Promise<unknown>;
}) {
  const dirty = new Map<string, State>();
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
  return {
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
      unsubscribePr();
      unsubscribeGit();
      dirty.clear();
    },
  };
}
