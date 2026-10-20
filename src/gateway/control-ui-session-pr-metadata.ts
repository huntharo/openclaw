import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import type { SessionGitHubPullRequestBinding } from "../config/sessions/types.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import type { ApiRequestStore } from "../infra/http-api-quota.js";
import { apiStoreRequestKey } from "../infra/http-api-read-store.js";
import { createRetainedCache } from "../infra/retained-cache.js";
import { registerOpenClawStateDatabaseLifecycleListener } from "../state/openclaw-state-db-cache.js";
import type { ControlUiSessionPullRequest } from "./control-ui-contract.js";
import {
  createGitHubReadGroup,
  prepareSessionPullRequestGitHubRead,
} from "./control-ui-session-pr-request.js";
import {
  fetchSessionPullRequestCheckRollup,
  sessionPullRequestRepositoryApiUrl,
} from "./control-ui-session-prs-checks.js";
import { gitHubPublicApi } from "./github-public-api.js";

type Read = ReturnType<typeof prepareSessionPullRequestGitHubRead>;
type Entry = {
  access: ReturnType<typeof createGitHubReadGroup>;
  expiresAt: number;
  startedAt: number;
  failed?: boolean;
  promise?: Promise<ControlUiSessionPullRequest>;
  lastGood?: ControlUiSessionPullRequest;
  store: ApiRequestStore;
  dependencies: Map<string, { store: ApiRequestStore; revision: number; observation: number }>;
};
const metadata = createRetainedCache<Entry>();
registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind !== "opened") {
    for (const entry of metadata.values()) {
      entry.access.abort();
    }
    metadata.clear();
  }
});

/** One GitHub metadata read per credential/repository/number, across task and branch views. */
export async function readSessionPullRequestMetadata(
  target: Pick<ControlUiSessionPullRequest, "owner" | "repo" | "number">,
  read: Read,
  load: (read: Read) => Promise<ControlUiSessionPullRequest>,
  options: {
    refresh?: boolean;
    /** A bound workspace must not reuse metadata admitted for another association. */
    bindingIdentity?: string;
    signal?: AbortSignal;
    expected?: string;
    retainFailure?: (error: unknown) => boolean;
    onRetainedFailure?: (error: unknown) => void;
  } = {},
): Promise<ControlUiSessionPullRequest> {
  read.assertCurrent();
  const key = JSON.stringify([
    read.host,
    read.apiBaseUrl,
    read.cacheScope,
    target.owner.toLowerCase(),
    target.repo.toLowerCase(),
    target.number,
    options.bindingIdentity,
  ]);
  let entry = metadata.get(key);
  const now = Date.now();
  const refresh = options.refresh === true || read.refresh === true;
  const matches =
    !options.expected ||
    !entry?.lastGood ||
    pullRequestMetadataSignature(entry.lastGood) === options.expected;
  const reusable =
    entry &&
    entry.store === read.store &&
    [...entry.dependencies].every(([url, dependency]) => {
      const revision = dependency.store.responses.revision(apiStoreRequestKey(url));
      return revision === 0 || revision === dependency.revision;
    }) &&
    !entry.access.signal.aborted &&
    entry.startedAt <= now &&
    entry.expiresAt > now &&
    (entry.failed || matches) &&
    !refresh;
  if (!entry || entry.store !== read.store || entry.access.signal.aborted) {
    entry = {
      access: createGitHubReadGroup(),
      expiresAt: 0,
      startedAt: 0,
      store: read.store,
      dependencies: new Map(),
    };
  }
  const active = entry;
  const release = active.access.add(read.assertCurrent, options.signal);
  try {
    if (!reusable || !active.promise) {
      active.dependencies.clear();
      const transport = prepareSessionPullRequestGitHubRead(
        read.host,
        active.access.assertCurrent,
        {
          signal: active.access.signal,
          credential: read.credential,
          refresh,
          onRequest: (url, store) => {
            active.dependencies.set(url, {
              store,
              revision: store.responses.revision(apiStoreRequestKey(url)),
              observation: 0,
            });
          },
          onResponse: (url, store, observation) => {
            active.dependencies.set(url, {
              store,
              revision: store.responses.revision(apiStoreRequestKey(url)),
              observation,
            });
          },
        },
      );
      active.startedAt = now;
      active.failed = false;
      active.expiresAt = now + 90_000;
      active.promise = load(transport).then(
        (result) => {
          active.lastGood = result;
          return result;
        },
        (error: unknown) => {
          active.failed = true;
          active.expiresAt =
            Date.now() +
            (error instanceof gitHubPublicApi.ControlUiGitHubError && error.statusCode === 429
              ? 300_000
              : 30_000);
          throw error;
        },
      );
      metadata.set(key, active);
    }
    try {
      return await racePromiseWithAbortSignal(active.promise, options.signal);
    } catch (error) {
      read.assertCurrent();
      const retain = options.retainFailure?.(error);
      if (retain && active.lastGood) {
        options.onRetainedFailure?.(error);
        return active.lastGood;
      }
      if (retain === false) {
        active.lastGood = undefined;
      }
      throw error;
    }
  } finally {
    // A branch joining this projection still owns dependencies on every underlying API fact.
    for (const [url, dependency] of active.dependencies) {
      read.observeRequest?.(url, dependency.store);
      // Failed reads remain dependencies, but never report an observation they did not consume.
      if (dependency.observation > 0) {
        read.observeResponse?.(url, dependency.store, dependency.observation);
      }
    }
    release();
    read.assertCurrent();
  }
}

export function pullRequestMetadataSignature(
  pull: Pick<ControlUiSessionPullRequest, "state" | "title" | "headSha">,
) {
  return JSON.stringify([pull.state, pull.title, pull.headSha]);
}

function derivePullState(value: Record<string, unknown>): ControlUiSessionPullRequest["state"] {
  if (readNonBlankString(value.merged_at)) {
    return "merged";
  }
  if (value.state !== "open") {
    return "closed";
  }
  return value.draft === true ? "draft" : "open";
}

export function parsePullListItem(value: unknown) {
  if (!isRecord(value)) {
    return null;
  }
  const number = asFiniteNumber(value.number);
  const title = readNonBlankString(value.title);
  const url = readNonBlankString(value.html_url);
  const base = isRecord(value.base) ? value.base : {};
  const baseRepo = isRecord(base.repo) ? base.repo : {};
  const baseOwner = isRecord(baseRepo.owner) ? baseRepo.owner : {};
  const owner = readNonBlankString(baseOwner.login);
  const repo = readNonBlankString(baseRepo.name);
  const head = isRecord(value.head) ? value.head : {};
  if (!number || !Number.isSafeInteger(number) || number < 1 || !title || !url || !owner || !repo) {
    return null;
  }
  const user = isRecord(value.user) ? value.user : {};
  const authorLogin = readNonBlankString(user.login);
  return {
    number,
    title,
    url,
    owner,
    repo,
    state: derivePullState(value),
    ...(authorLogin ? { author: { login: authorLogin } } : {}),
    branch: readNonBlankString(head.ref),
    headSha: readNonBlankString(head.sha),
    baseRef: readNonBlankString(base.ref),
    mergeCommitSha: readNonBlankString(value.merge_commit_sha),
  };
}

type PullListItem = NonNullable<ReturnType<typeof parsePullListItem>>;

// Sub-fetch degradation: quota errors abort the whole refresh (so the caller
// serves stale chips with the rate-limit flag); anything else just drops the
// optional field the sub-fetch would have filled.
function rethrowRateLimit(error: unknown): undefined {
  if (error instanceof gitHubPublicApi.ControlUiGitHubError && error.statusCode === 429) {
    throw error;
  }
  return undefined;
}

/**
 * The facts a chip carries without spending quota on per-PR detail calls. The
 * rate-limited path renders exactly this, so both callers share one shape.
 */
export function stateOnlyPullRequestChip(
  item: PullListItem,
  branch: string,
): ControlUiSessionPullRequest {
  return {
    number: item.number,
    owner: item.owner,
    repo: item.repo,
    branch,
    title: item.title,
    url: item.url,
    state: item.state,
    ...(item.headSha && /^[0-9a-f]{40}$/i.test(item.headSha)
      ? { headSha: item.headSha.toLowerCase() }
      : {}),
    ...(item.author ? { author: item.author } : {}),
  };
}

export async function finishPullRequest(
  item: PullListItem,
  branch: string,
  read: ReturnType<typeof prepareSessionPullRequestGitHubRead>,
  preparedDetails?: unknown,
): Promise<ControlUiSessionPullRequest> {
  const chip = stateOnlyPullRequestChip(item, branch);
  // Merged/closed chips render state only; diff counts and CI rollup are
  // live-work signals, so spend GitHub quota on open PRs alone.
  if (item.state !== "open" && item.state !== "draft") {
    return chip;
  }
  const detailUrl = `${sessionPullRequestRepositoryApiUrl({ ...item, apiBaseUrl: read.apiBaseUrl })}/pulls/${item.number}`;
  const [details, checks] = await Promise.all([
    preparedDetails === undefined
      ? read.request(detailUrl).catch(rethrowRateLimit)
      : Promise.resolve(preparedDetails),
    fetchSessionPullRequestCheckRollup(
      { ...item, apiBaseUrl: read.apiBaseUrl },
      read.request,
    ).catch(rethrowRateLimit),
  ]);
  const observed = isRecord(details)
    ? parsePullListItem(
        gitHubPublicApi
          .getGitHubPullRequestStore(read.store)
          .project(item.owner, item.repo, item.number, details),
      )
    : null;
  const current = observed ?? item;
  return {
    ...stateOnlyPullRequestChip(current, current.branch ?? branch),
    ...(isRecord(details)
      ? {
          additions: asFiniteNumber(details.additions),
          deletions: asFiniteNumber(details.deletions),
          changedFiles: asFiniteNumber(details.changed_files),
        }
      : {}),
    ...(checks &&
    current.headSha === item.headSha &&
    (current.state === "open" || current.state === "draft")
      ? { checks, checksUrl: `${current.url}/checks` }
      : {}),
  };
}

/** Read the accepted original identity, without treating its observed commit as a head lock. */
export async function loadBoundSessionPullRequest(
  binding: SessionGitHubPullRequestBinding,
  read: Read,
  options: {
    bindingIdentity: string;
    refresh?: boolean;
    signal?: AbortSignal;
    onRetainedFailure: (error: unknown) => void;
    preparedDetails?: unknown;
  },
): Promise<ControlUiSessionPullRequest> {
  const [owner, repo] = binding.base.repository.split("/");
  if (
    !owner ||
    !repo ||
    binding.url !== `https://${read.host}/${owner}/${repo}/pull/${binding.number}`
  ) {
    throw new Error("The session pull request association changed");
  }
  const preparedItem = parsePullListItem(options.preparedDetails);
  return readSessionPullRequestMetadata(
    { owner, repo, number: binding.number },
    read,
    async (transport) => {
      const detailUrl = `${sessionPullRequestRepositoryApiUrl({ owner, repo, apiBaseUrl: transport.apiBaseUrl })}/pulls/${binding.number}`;
      const details = options.preparedDetails ?? (await transport.request(detailUrl));
      if (options.preparedDetails !== undefined) {
        // Inspection already read this fact through the publication adapter's shared store.
        // Closed PRs have no check subreads, but still depend on the accepted detail response.
        transport.observeRequest?.(detailUrl, transport.store);
        transport.observeResponse?.(
          detailUrl,
          transport.store,
          transport.store.responses.latestObservation(apiStoreRequestKey(detailUrl)),
        );
      }
      const item = parsePullListItem(details);
      const base = isRecord(details) && isRecord(details.base) ? details.base : undefined;
      const head = isRecord(details) && isRecord(details.head) ? details.head : undefined;
      if (
        !item ||
        item.url !== binding.url ||
        item.number !== binding.number ||
        item.owner.toLowerCase() !== owner.toLowerCase() ||
        item.repo.toLowerCase() !== repo.toLowerCase() ||
        !base ||
        !isRecord(base.repo) ||
        base.repo.id !== binding.base.repositoryId ||
        !head ||
        head.ref !== binding.head.branch ||
        (head.repo !== null && (!isRecord(head.repo) || head.repo.id !== binding.head.repositoryId))
      ) {
        throw new Error("The session pull request association changed");
      }
      try {
        return await finishPullRequest(item, binding.head.branch, transport, details);
      } catch (error) {
        // The identity is verified; quota exhaustion only withholds counts and checks.
        if (error instanceof gitHubPublicApi.ControlUiGitHubError && error.statusCode === 429) {
          options.onRetainedFailure(error);
          return stateOnlyPullRequestChip(item, binding.head.branch);
        }
        throw error;
      }
    },
    {
      ...options,
      ...(preparedItem
        ? {
            expected: pullRequestMetadataSignature(
              stateOnlyPullRequestChip(preparedItem, binding.head.branch),
            ),
          }
        : {}),
      retainFailure: (error) =>
        error instanceof gitHubPublicApi.ControlUiGitHubError &&
        (error.retryable || error.statusCode === 502),
    },
  );
}
