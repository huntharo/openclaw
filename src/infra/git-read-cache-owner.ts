import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runWithGatewayDetachedWorkContinuation } from "../process/gateway-work-admission.js";
import { racePromiseWithAbortSignal } from "./abort-signal.js";
import {
  addDiffReadDurations,
  startDiffReadTiming,
  type DiffReadCacheMissReason,
  type DiffReadTiming,
} from "./diff-read-timing.js";
import { pruneMapToMaxSize } from "./map-size.js";

const MAX_CACHED_CHECKOUTS = 1_000;
const log = createSubsystemLogger("git/read");

export type GitReadOptions = {
  /** Refresh unversioned layouts; known revisions are always revalidated. */
  refresh?: boolean;
  signal?: AbortSignal;
  diffTiming?: DiffReadTiming;
  /** Bound cold diff waits; share completed cold results for one second. */
  poll?: boolean;
};

type ReadEntry<T> = {
  roots: readonly string[];
  revision: string;
  expiresAt: number;
  promise: Promise<T>;
  controller: AbortController;
  pending: boolean;
  retryAt?: number;
  timing?: DiffReadTiming;
  value?: T;
};

type ReadSlot<T> = {
  entry?: ReadEntry<T>;
  poll?: {
    roots: readonly string[];
    promise: Promise<T>;
    controller: AbortController;
    pending: boolean;
    expiresAt: number;
  };
};

export function gitEnvironmentKey(input: unknown): string {
  return JSON.stringify([
    input,
    Object.entries(process.env)
      .filter(([key]) => /^(GIT_|HOME$|XDG_CONFIG_HOME$|PATH$|SUDO_UID$)/i.test(key))
      .toSorted(([left], [right]) => left.localeCompare(right)),
  ]);
}

function diffRevisionMissReason(previous: string, current: string): DiffReadCacheMissReason {
  try {
    const previousKey: [unknown, string | null] = JSON.parse(previous);
    const currentKey: [unknown, string | null] = JSON.parse(current);
    const before: Record<string, unknown> | null = JSON.parse(previousKey[1] ?? "null");
    const after: Record<string, unknown> | null = JSON.parse(currentKey[1] ?? "null");
    if (before && after) {
      for (const [component, reason] of [
        ["head", "revision-changed-head"],
        ["index", "revision-changed-index"],
        ["untrackedSet", "revision-changed-untracked-set"],
        ["worktreeMtime", "revision-changed-worktree-mtime"],
      ] as const) {
        if (before[component] !== after[component]) {
          return reason;
        }
      }
    }
  } catch {
    // Non-component revisions still invalidate normally and use the bounded fallback.
  }
  return "revision-changed-metadata";
}

export function createGitReadCache<Input, Output>(
  scope: { rootsOf: (input: Input) => readonly string[]; changed?: (root: string) => void },
  load: (input: Input, signal: AbortSignal, timing?: DiffReadTiming) => Promise<Output>,
  freshness: number | { milliseconds: number; joinPending?: true },
  revision?: (
    input: Input,
    signal: AbortSignal,
    timing?: DiffReadTiming,
    previous?: Output,
  ) => Promise<string | null>,
  keyOf: (input: Input) => string = JSON.stringify,
  snapshot?: { empty: () => Output },
  // A numeric result retains an unavailable response until its next probe.
  retain: (value: Output) => boolean | number = () => true,
  maxEntries = MAX_CACHED_CHECKOUTS,
  polling?: { empty: () => Output },
  revisionKeyOf?: (input: Input, previous?: Output) => string,
) {
  const freshnessMs = typeof freshness === "number" ? freshness : freshness.milliseconds;
  const joinPending = typeof freshness !== "number" && freshness.joinPending;
  // Versioned reads retain only the current inputs/revision per checkout. LRU
  // eviction and Gateway shutdown own their lifetime, independently of viewers.
  const entries = new Map<string, ReadSlot<Output>>();
  // Retain only the most recent capacity evictions; older misses become cold again.
  const evicted = new Map<string, true>();
  const pending = new Set<ReadEntry<Output>>();
  const fingerprints = new Map<string, { value: string; roots: readonly string[] }>();
  const revisions = new Map<
    string,
    {
      controller: AbortController;
      promise: Promise<string | null>;
      timing?: DiffReadTiming;
      roots: readonly string[];
    }
  >();
  let refreshTail: Promise<unknown> = Promise.resolve();
  let closed = false;
  let pollCount = 0;
  const releasePoll = (key: string, slot: ReadSlot<Output>) => {
    if (entries.get(key) !== slot || !slot.poll) {
      return;
    }
    delete slot.poll;
    pollCount--;
    if (!slot.entry) {
      entries.delete(key);
    }
  };
  const remove = (key: string, entry: ReadEntry<Output>) => {
    const slot = entries.get(key);
    if (slot?.entry === entry) {
      delete slot.entry;
      if (!slot.poll) {
        entries.delete(key);
      }
    }
  };
  const read = async (input: Input, options: GitReadOptions = {}): Promise<Output> => {
    options.signal?.throwIfAborted();
    using completedTiming = polling ? startDiffReadTiming("checkout.diff") : undefined;
    const timing = completedTiming ?? options.diffTiming;
    const validationStarted = timing ? performance.now() : 0;
    const key = keyOf(input);
    const roots = [...new Set(scope.rootsOf(input))];
    let entry = entries.get(key)?.entry;
    const waitingToRetry = !options.refresh && (entry?.retryAt ?? 0) > Date.now();
    let currentRevision: string | null | undefined;
    if (revision && !waitingToRetry) {
      // Share only overlapping checks of identical inputs, never a settled revision.
      const revisionInput =
        revisionKeyOf?.(input, entry?.value) ??
        (keyOf === gitEnvironmentKey ? key : gitEnvironmentKey(input));
      let check = revisions.get(revisionInput);
      if (!check) {
        const controller = new AbortController();
        const revisionTiming = timing ? { durations: {} } : undefined;
        const promise = revision(input, controller.signal, revisionTiming, entry?.value).finally(
          () => {
            if (revisions.get(revisionInput)?.controller === controller) {
              revisions.delete(revisionInput);
            }
          },
        );
        check = { controller, promise, timing: revisionTiming, roots };
        revisions.set(revisionInput, check);
      }
      currentRevision = await racePromiseWithAbortSignal(check.promise, options.signal, (signal) =>
        toErrorObject(signal.reason, "Git read aborted"),
      );
      check.controller.signal.throwIfAborted();
      if (timing && check.timing) {
        addDiffReadDurations(timing, check.timing);
        timing.revisionUnavailableReason = check.timing.revisionUnavailableReason;
      }
    }
    if (timing) {
      timing.durations["cache-validate"] = performance.now() - validationStarted;
    }
    const retainedFreshnessMs =
      typeof freshness !== "number" && typeof currentRevision === "string"
        ? Number.POSITIVE_INFINITY
        : freshnessMs;
    const revisionKey = waitingToRetry ? entry!.revision : JSON.stringify([input, currentRevision]);
    options.signal?.throwIfAborted();
    if (closed) {
      throw new Error("Git reads are unavailable while the Gateway is restarting");
    }
    entry = entries.get(key)?.entry;
    const previous = entry;
    const wasEvicted = evicted.delete(key);
    let cacheHit = !entry?.pending;
    if (
      (options.refresh && (currentRevision === null || entry?.retryAt !== undefined)) ||
      !entry ||
      entry.revision !== revisionKey ||
      (entry.expiresAt <= Date.now() && (!(snapshot || joinPending) || !entry.pending))
    ) {
      if (snapshot && pending.size >= MAX_CACHED_CHECKOUTS) {
        return entry?.value ?? snapshot.empty();
      }
      cacheHit = false;
      const loadTiming = timing ? { durations: {} } : undefined;
      const previousRefresh = refreshTail;
      const controller = new AbortController();
      const next: ReadEntry<Output> = {
        roots,
        revision: revisionKey,
        expiresAt:
          retainedFreshnessMs === 0
            ? Number.POSITIVE_INFINITY
            : Date.now() +
              (currentRevision === null
                ? Math.min(retainedFreshnessMs, 75_000)
                : retainedFreshnessMs),
        controller,
        pending: true,
        timing: loadTiming,
        value: entry?.value,
        promise: Promise.resolve().then(() =>
          snapshot
            ? runWithGatewayDetachedWorkContinuation(async () => {
                // Serialize display batches; the worker probes four checkouts concurrently.
                await previousRefresh;
                controller.signal.throwIfAborted();
                return load(input, controller.signal, loadTiming);
              }, "runtime:project-discovery")
            : load(input, controller.signal, loadTiming),
        ),
      };
      pending.add(next);
      next.promise = next.promise.then(
        (value) => {
          next.pending = false;
          pending.delete(next);
          controller.signal.throwIfAborted();
          next.value = value;
          if (scope.changed && entries.get(key)?.entry === next && !closed) {
            // Retain digests, not a second copy of potentially large patch bodies.
            const fingerprint = createHash("sha256")
              .update(JSON.stringify([currentRevision, value]))
              .digest("hex");
            const previousFingerprint = fingerprints.get(key)?.value;
            fingerprints.delete(key);
            fingerprints.set(key, { value: fingerprint, roots });
            pruneMapToMaxSize(fingerprints, maxEntries);
            if (previousFingerprint !== fingerprint) {
              for (const root of roots) {
                scope.changed(root);
              }
            }
          }
          controller.signal.throwIfAborted();
          if (snapshot) {
            next.expiresAt = Date.now() + freshnessMs;
          }
          const retention = retain(value);
          if (typeof retention === "number") {
            next.retryAt = next.expiresAt = Date.now() + retention;
          } else if (retainedFreshnessMs === 0 || !retention) {
            remove(key, next);
          } else if (joinPending && currentRevision === null) {
            // Unversioned summaries already allow this admission-based TTL.
            next.retryAt = next.expiresAt;
          }
          return value;
        },
        (error: unknown) => {
          next.pending = false;
          pending.delete(next);
          if (snapshot) {
            next.expiresAt = Date.now() + freshnessMs;
          } else {
            next.expiresAt = 0;
            remove(key, next);
          }
          throw error;
        },
      );
      if (snapshot) {
        refreshTail = next.promise.catch(() => {
          if (!controller.signal.aborted) {
            log.warn(
              "Repository discovery refresh failed; retaining the previous project snapshot",
            );
          }
        });
      }
      // Replace at admission. An older completion updates only its own entry.
      entry = next;
    }
    const slot = entries.get(key) ?? {};
    slot.entry = entry;
    entries.delete(key);
    entries.set(key, slot);
    for (const [oldest, candidate] of entries) {
      if (entries.size <= maxEntries) {
        break;
      }
      if (candidate.poll) {
        if (candidate.poll.pending || candidate.poll.expiresAt > Date.now()) {
          continue;
        }
        releasePoll(oldest, candidate);
      }
      entries.delete(oldest);
      evicted.set(oldest, true);
    }
    pruneMapToMaxSize(evicted, maxEntries);
    // Viewer cancellation stops waiting, not the shared bounded read.
    const value = snapshot
      ? (entry.value ?? snapshot.empty())
      : await racePromiseWithAbortSignal(entry.promise, options.signal, (signal) =>
          toErrorObject(signal.reason, "Git read aborted"),
        );
    if (timing) {
      timing.outcome = cacheHit ? "cache-hit" : "cache-miss";
      timing.missReason = cacheHit
        ? undefined
        : currentRevision === null
          ? (timing.revisionUnavailableReason ?? "no-revision")
          : !previous
            ? wasEvicted
              ? "evicted"
              : "cold"
            : previous.revision !== revisionKey
              ? diffRevisionMissReason(previous.revision, revisionKey)
              : "pending";
      if (!cacheHit && entry.timing) {
        addDiffReadDurations(timing, entry.timing);
      }
    }
    if (completedTiming && options.diffTiming) {
      addDiffReadDurations(options.diffTiming, completedTiming);
      options.diffTiming.outcome = completedTiming.outcome;
      options.diffTiming.missReason = completedTiming.missReason;
    }
    return value;
  };
  return {
    async read(input: Input, options: GitReadOptions = {}): Promise<Output> {
      options.signal?.throwIfAborted();
      if (closed) {
        throw new Error("Git reads are unavailable while the Gateway is restarting");
      }
      if (!polling || !options.poll) {
        return read(input, options);
      }
      const computing = () => {
        if (options.diffTiming) {
          options.diffTiming.outcome = "cache-miss";
          options.diffTiming.missReason = "pending";
        }
        return polling.empty();
      };
      const key = keyOf(input);
      const slot = entries.get(key) ?? {};
      if (slot.poll && !slot.poll.pending && slot.poll.expiresAt <= Date.now()) {
        releasePoll(key, slot);
      }
      let poll = slot.poll;
      if (!poll && slot.entry?.value) {
        return read(input, options);
      }
      if (!poll) {
        if (pollCount >= maxEntries) {
          for (const [otherKey, candidate] of entries) {
            if (
              candidate.poll &&
              !candidate.poll.pending &&
              candidate.poll.expiresAt <= Date.now()
            ) {
              releasePoll(otherKey, candidate);
            }
          }
        }
        if (pollCount >= maxEntries) {
          return computing();
        }
        const controller = new AbortController();
        const promise = runWithGatewayDetachedWorkContinuation(
          () => read(input, { ...options, signal: controller.signal, diffTiming: undefined }),
          "runtime:checkout-diff",
        );
        poll = {
          roots: scope.rootsOf(input),
          promise,
          controller,
          pending: true,
          expiresAt: Number.POSITIVE_INFINITY,
        };
        const admitted = poll;
        // Fan out both outcomes to reconnecting tabs before the next fresh read.
        const settled = () => {
          admitted.pending = false;
          admitted.expiresAt = Date.now() + 1_000;
        };
        void promise.then(settled, settled);
        slot.poll = poll;
        pollCount++;
        entries.set(key, slot);
      }
      let timedOut = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await racePromiseWithAbortSignal(
          poll.pending
            ? Promise.race([
                poll.promise,
                new Promise<Output>((resolve) => {
                  // Let short cold reads finish without another client retry interval.
                  timeout = setTimeout(() => {
                    timedOut = true;
                    resolve(computing());
                  }, 2_000);
                }),
              ])
            : poll.promise,
          options.signal,
          (signal) => toErrorObject(signal.reason, "Git read aborted"),
        );
        if (!timedOut && options.diffTiming) {
          options.diffTiming.outcome = "cache-hit";
          options.diffTiming.missReason = undefined;
        }
        return value;
      } finally {
        clearTimeout(timeout);
      }
    },
    invalidate(root: string): void {
      for (const [key, check] of revisions) {
        if (check.roots.includes(root)) {
          revisions.delete(key);
          check.controller.abort(new Error("Git facts were invalidated"));
        }
      }
      for (const entry of pending) {
        if (entry.roots.includes(root)) {
          entry.expiresAt = 0;
          entry.controller.abort(new Error("Git facts were invalidated"));
        }
      }
      for (const [key, slot] of entries) {
        if (slot.poll?.roots.includes(root)) {
          slot.poll.controller.abort(new Error("Git facts were invalidated"));
          releasePoll(key, slot);
        }
        if (slot.entry?.roots.includes(root)) {
          remove(key, slot.entry);
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
      for (const { controller } of revisions.values()) {
        controller.abort();
      }
      const retiring = [...pending];
      for (const entry of retiring) {
        entry.expiresAt = 0;
        entry.controller.abort();
      }
      const polls = Array.from(entries.values()).flatMap((slot) => (slot.poll ? [slot.poll] : []));
      for (const poll of polls) {
        poll.controller.abort();
      }
      entries.clear();
      pollCount = 0;
      evicted.clear();
      fingerprints.clear();
      await Promise.allSettled([
        ...Array.from(revisions.values(), (check) => check.promise),
        ...retiring.map((entry) => entry.promise),
        ...polls.map((poll) => poll.promise),
      ]);
    },
  };
}
