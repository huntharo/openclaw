import type { ApiRequestStore } from "../infra/http-api-quota.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import {
  CONTROL_UI_LINK_READER_CHANGED_EVENT,
  type ControlUiLinkReaderChanged,
} from "../shared/control-ui-link-reader.js";
import { createDeferredCore, type Deferred } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import { gitHubPublicApi } from "./github-public-api.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";

type ReadScope = { store: ApiRequestStore; cacheScope: string };
type PullTarget = { kind: "pull"; owner: string; repo: string; number: number };
type Interest = ReadScope & ControlUiLinkReaderChanged & { connId: string; target: PullTarget };

/** Only successful public readers retain an interest; invalidations carry no upstream PR facts. */
export function createControlUiLinkReaderNotifications(deps: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  isConnectionActive: (connId: string) => boolean;
  prepareRead: (
    connId: string,
    agentId: string,
    signal: AbortSignal,
  ) => Promise<(ReadScope & { assertSelected: () => void }) | undefined>;
}) {
  const scope = new AsyncWorkScope();
  const interests = new Map<string, Map<string, Interest>>();
  const observers = new Map<ApiRequestStore, () => void>();
  const reads = new Map<string, { count: number; done: Deferred }>();
  const dirty = new Set<Interest>();
  let draining: Promise<void> | undefined;
  const keyOf = (agentId: string, url: string) => JSON.stringify([agentId, url]);
  const readKeyOf = (connId: string, agentId: string, url: string) =>
    JSON.stringify([connId, agentId, url]);
  const isCurrent = (interest: Interest) =>
    !scope.isClosing &&
    deps.isConnectionActive(interest.connId) &&
    interests.get(interest.connId)?.get(keyOf(interest.agentId, interest.url)) === interest;

  const drain = () => {
    if (draining || !dirty.size || scope.isClosing) {
      return;
    }
    draining = runInDetachedAsyncContext(() =>
      scope
        .track(async () => {
          while (dirty.size && !scope.isClosing) {
            const batch = [...dirty];
            dirty.clear();
            await Promise.all(
              batch.map(async (queued) => {
                try {
                  await reads.get(readKeyOf(queued.connId, queued.agentId, queued.url))?.done
                    .promise;
                  const interest = interests
                    .get(queued.connId)
                    ?.get(keyOf(queued.agentId, queued.url));
                  // A successful read replaces the interest before releasing this shared read hold.
                  if (
                    !interest ||
                    interest.store !== queued.store ||
                    interest.cacheScope !== queued.cacheScope ||
                    !isCurrent(interest)
                  ) {
                    return;
                  }
                  // Reselect from the live service/connection, never a finished request's handle.
                  const selected = await deps.prepareRead(
                    interest.connId,
                    interest.agentId,
                    scope.signal,
                  );
                  if (
                    !isCurrent(interest) ||
                    selected?.store !== interest.store ||
                    selected.cacheScope !== interest.cacheScope
                  ) {
                    return;
                  }
                  selected.assertSelected();
                  deps.broadcastToConnIds(
                    CONTROL_UI_LINK_READER_CHANGED_EVENT,
                    {
                      url: interest.url,
                      agentId: interest.agentId,
                    } satisfies ControlUiLinkReaderChanged,
                    new Set([interest.connId]),
                    { dropIfSlow: true },
                  );
                } catch {
                  // Revoked/changed identities cannot receive facts or spend retry requests here.
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
    void draining.catch(() => {});
  };

  const pruneObservers = () => {
    const used = new Set(
      [...interests.values()].flatMap((entries) => [...entries.values()].map((i) => i.store)),
    );
    for (const [store, unsubscribe] of observers) {
      if (!used.has(store)) {
        unsubscribe();
        observers.delete(store);
      }
    }
  };

  return {
    beginRead(connId: string, agentId: string, url: string): () => void {
      const key = readKeyOf(connId, agentId, url);
      const pending = reads.get(key) ?? { count: 0, done: createDeferredCore() };
      pending.count += 1;
      reads.set(key, pending);
      return () => {
        pending.count -= 1;
        if (pending.count === 0) {
          reads.delete(key);
          pending.done.resolve();
        }
      };
    },
    remember(interest: Interest): void {
      if (scope.isClosing || !deps.isConnectionActive(interest.connId)) {
        return;
      }
      const entries = interests.get(interest.connId) ?? new Map<string, Interest>();
      const key = keyOf(interest.agentId, interest.url);
      entries.delete(key);
      entries.set(key, interest);
      while (entries.size > 100) {
        entries.delete(entries.keys().next().value!);
      }
      interests.set(interest.connId, entries);
      if (!observers.has(interest.store)) {
        observers.set(
          interest.store,
          gitHubPublicApi.getGitHubPullRequestStore(interest.store).subscribe((change) => {
            for (const watched of interests.values()) {
              for (const current of watched.values()) {
                if (
                  current.store === interest.store &&
                  current.target.owner.toLowerCase() === change.owner.toLowerCase() &&
                  current.target.repo.toLowerCase() === change.repo.toLowerCase() &&
                  current.target.number === change.number
                ) {
                  dirty.add(current);
                }
              }
            }
            drain();
          }),
        );
      }
      pruneObservers();
    },
    unsubscribe(connId: string): void {
      interests.delete(connId);
      pruneObservers();
    },
    stop(): Promise<void> {
      scope.beginClose();
      interests.clear();
      dirty.clear();
      for (const unsubscribe of observers.values()) {
        unsubscribe();
      }
      observers.clear();
      for (const read of reads.values()) {
        read.done.resolve();
      }
      reads.clear();
      return scope.drain();
    },
  };
}

/** Host read adapters accept only the plugin's supported exact PR document URL. */
export function controlUiGitHubReaderUrl(params: Record<string, unknown>): string | undefined {
  const target = gitHubPublicApi.parseGitHubTarget(params);
  const parsed = gitHubPublicApi.parseGitHubLinkParams({ url: params.readerUrl });
  if (target?.kind !== "pull" || parsed?.target.kind !== "pull") {
    return undefined;
  }
  return parsed.target.owner.toLowerCase() === target.owner.toLowerCase() &&
    parsed.target.repo.toLowerCase() === target.repo.toLowerCase() &&
    parsed.target.number === target.number
    ? parsed.url
    : undefined;
}
