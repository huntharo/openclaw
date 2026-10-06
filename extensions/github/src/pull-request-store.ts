import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import type { ApiRequestStore, ApiStoreChange } from "openclaw/plugin-sdk/retry-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

type GitHubPullRequestChange = {
  owner: string;
  repo: string;
  number: number;
  observation: number;
};
type PullFact = GitHubPullRequestChange & { value: Record<string, unknown> };

/** Destination repository + PR number identifies facts; session/worktree relationships are projections. */
class GitHubPullRequestStore {
  private readonly records = new Map<string, PullFact>();
  private readonly repositories = new Map<string, { id: number; observation: number }>();
  private readonly listeners = new Set<(change: GitHubPullRequestChange) => void>();
  constructor(private readonly store: ApiRequestStore) {
    store.responses.subscribe((change) => this.observe(change), true);
  }

  subscribe(listener: (change: GitHubPullRequestChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  project(
    owner: string,
    repo: string,
    number: number,
    value: Record<string, unknown>,
  ): Record<string, unknown> {
    const current = this.records.get(this.key(owner, repo, number));
    return structuredClone(current ? { ...value, ...current.value } : value);
  }

  private key(owner: string, repo: string, number: number): string {
    return `${owner}/${repo}#${number}`.toLowerCase();
  }

  private observe(change: ApiStoreChange): void {
    const path = new URL(change.url).pathname;
    if (change.invalidated) {
      const repository = /\/repos\/([^/]+)\/([^/]+)\//.exec(path);
      for (const fact of this.records.values()) {
        if (
          repository?.[1]?.toLowerCase() === fact.owner.toLowerCase() &&
          repository?.[2]?.toLowerCase() === fact.repo.toLowerCase()
        ) {
          // Retain last-known facts for display during a cooldown, but require a fresh read.
          this.publish({ ...fact, observation: change.observation });
        }
      }
      return;
    }
    const repository = /\/repos\/([^/]+)\/([^/]+)$/.exec(path);
    if (repository && isRecord(change.value)) {
      const id = change.value.id;
      if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) {
        const key = path.toLowerCase();
        const previous = this.repositories.get(key);
        if (previous && previous.observation > change.observation) {
          return;
        }
        this.repositories.delete(key);
        this.repositories.set(key, { id, observation: change.observation });
        if (previous && previous.id !== id) {
          const retired: PullFact[] = [];
          for (const [pullKey, fact] of this.records) {
            if (
              fact.owner.toLowerCase() === repository[1]?.toLowerCase() &&
              fact.repo.toLowerCase() === repository[2]?.toLowerCase()
            ) {
              this.records.delete(pullKey);
              retired.push(fact);
            }
          }
          // A reused repository name cannot carry content or pending reads from its old ID.
          this.store.responses.invalidate((requestKey, rawUrl) => {
            return (
              requestKey !== change.key &&
              new URL(rawUrl).pathname.toLowerCase().startsWith(key + "/")
            );
          });
          for (const fact of retired) {
            this.publish({ ...fact, observation: change.observation });
          }
        }
        while (this.repositories.size > 256) {
          const oldest = this.repositories.keys().next().value;
          if (oldest !== undefined) {
            this.repositories.delete(oldest);
          }
        }
      }
      return;
    }
    const resource =
      /\/repos\/([^/]+)\/([^/]+)\/(?:pulls|issues)\/(\d+)\/(?:comments|files|commits|reviews)(?:$|\/)/.exec(
        path,
      );
    const checks =
      /\/repos\/([^/]+)\/([^/]+)\/commits\/([^/]+)\/(?:check-runs|status|statuses)(?:$|\/)/.exec(
        path,
      );
    if (change.changed && (resource || checks)) {
      for (const fact of this.records.values()) {
        const target = resource ?? checks;
        if (
          fact.owner.toLowerCase() === target?.[1]?.toLowerCase() &&
          fact.repo.toLowerCase() === target?.[2]?.toLowerCase() &&
          (resource
            ? fact.number === Number(resource[3])
            : isRecord(fact.value.head) && fact.value.head.sha === checks?.[3])
        ) {
          this.publish({ ...fact, observation: change.observation });
        }
      }
    }
    const endpoint = /\/repos\/([^/]+)\/([^/]+)\/pulls(?:\/(\d+))?(?:$|\/)/.exec(path);
    const commitLookup = /\/repos\/([^/]+)\/([^/]+)\/commits\/[^/]+\/pulls$/.exec(path);
    if (!endpoint && !commitLookup) {
      return;
    }
    // Comments/commits/files contain issue numbers too, but are not PR observations.
    if (endpoint?.[3] && !path.endsWith(`/pulls/${endpoint[3]}`)) {
      return;
    }
    const values = Array.isArray(change.value) ? change.value : [change.value];
    for (const raw of values) {
      // Publication's bounded CLI projection omits prose and still supplies current head/state facts.
      const projected =
        isRecord(raw) && typeof raw.url === "string" ? URL.parse(raw.url) : undefined;
      const pullPath = projected && /\/([^/]+)\/([^/]+)\/pull\/(\d+)$/.exec(projected.pathname);
      const value =
        pullPath && isRecord(raw) && typeof raw.headSha === "string"
          ? {
              number: Number(pullPath[3]),
              html_url: raw.url,
              state: raw.state,
              head: { sha: raw.headSha, ref: raw.headRef },
              base: { ref: raw.baseRef },
            }
          : raw;
      if (!isRecord(value)) {
        continue;
      }
      const base = isRecord(value.base) && isRecord(value.base.repo) ? value.base.repo : undefined;
      const baseOwner = base && isRecord(base.owner) ? base.owner.login : undefined;
      const owner =
        typeof baseOwner === "string"
          ? baseOwner
          : (pullPath?.[1] ?? (endpoint ?? commitLookup)?.[1]);
      const repo =
        base && typeof base.name === "string"
          ? base.name
          : (pullPath?.[2] ?? (endpoint ?? commitLookup)?.[2]);
      const number = value.number ?? (endpoint?.[3] ? Number(endpoint[3]) : undefined);
      if (
        !owner ||
        !repo ||
        typeof number !== "number" ||
        !Number.isSafeInteger(number) ||
        number < 1
      ) {
        continue;
      }
      const key = this.key(owner, repo, number);
      const previous = this.records.get(key);
      if (previous && previous.observation > change.observation) {
        continue;
      }
      // List responses omit detail fields. Preserve them only for the same head.
      const oldHead =
        previous && isRecord(previous.value.head) ? previous.value.head.sha : undefined;
      const newHead = isRecord(value.head) ? value.head.sha : undefined;
      const retained = previous && (!newHead || newHead === oldHead) ? previous.value : {};
      const merged = {
        ...retained,
        ...value,
        ...(isRecord(retained.base) && isRecord(value.base)
          ? { base: { ...retained.base, ...value.base } }
          : {}),
      };
      this.records.delete(key);
      this.records.set(key, {
        owner,
        repo,
        number,
        value: merged,
        observation: change.observation,
      });
      if (!previous || JSON.stringify(previous.value) !== JSON.stringify(merged)) {
        this.publish({ owner, repo, number, observation: change.observation });
      }
      // A detail read can discover a PR after another view cached an empty branch lookup.
      // Retire that lookup so membership is confirmed through the existing discovery path.
      if (
        !previous &&
        endpoint?.[3] &&
        isRecord(value.head) &&
        typeof value.head.ref === "string"
      ) {
        const head = value.head;
        const headRef = value.head.ref;
        const headRepo = isRecord(head.repo) ? head.repo : undefined;
        const headOwner =
          headRepo && isRecord(headRepo.owner)
            ? headRepo.owner.login
            : isRecord(head.user)
              ? head.user.login
              : undefined;
        if (typeof headOwner === "string") {
          this.store.responses.invalidate((requestKey, rawUrl) => {
            const url = new URL(rawUrl);
            return (
              requestKey !== change.key &&
              url.pathname.toLowerCase().endsWith(`/repos/${owner}/${repo}/pulls`.toLowerCase()) &&
              url.searchParams.get("head") === `${headOwner}:${headRef}`
            );
          });
        }
      }
      if (newHead && oldHead && newHead !== oldHead) {
        const pullPath = `/repos/${owner}/${repo}/pulls/${number}`.toLowerCase();
        this.store.responses.invalidate((requestKey, url) => {
          const path = new URL(url).pathname.toLowerCase().replace(/\/$/, "");
          return (
            requestKey !== change.key &&
            [pullPath, `${pullPath}/files`, `${pullPath}/commits`].some((suffix) =>
              path.endsWith(suffix),
            )
          );
        });
      }
      while (this.records.size > 256) {
        const oldest = this.records.keys().next().value;
        if (oldest !== undefined) {
          this.records.delete(oldest);
        }
      }
    }
  }

  private publish({ owner, repo, number, observation }: GitHubPullRequestChange): void {
    for (const listener of this.listeners) {
      listener({ owner, repo, number, observation });
    }
  }
}

const owners = resolveGlobalSingleton(
  Symbol.for("openclaw.githubPullRequestStores"),
  () => ({ values: new WeakMap<ApiRequestStore, GitHubPullRequestStore>() }),
  (state) => {
    state.values = new WeakMap();
  },
  "close-only",
);

export function getGitHubPullRequestStore(store: ApiRequestStore): GitHubPullRequestStore {
  let owner = owners.values.get(store);
  if (!owner) {
    owner = new GitHubPullRequestStore(store);
    owners.values.set(store, owner);
  }
  return owner;
}
