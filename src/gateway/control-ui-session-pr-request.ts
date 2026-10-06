import { getSharedApiStore, type ApiRequestStore } from "../infra/http-api-quota.js";
import { gitHubPublicApi } from "./github-public-api.js";

/** Shared I/O survives one reader's retirement while each reader owns its delivery. */
export function createGitHubReadGroup() {
  const readers = new Set<() => void>();
  const abort = new AbortController();
  const assertCurrent = () => {
    abort.signal.throwIfAborted();
    let failure: unknown = new gitHubPublicApi.ControlUiGitHubError(
      409,
      "GitHub read has no active reader",
    );
    for (const assertReader of readers) {
      try {
        assertReader();
        return;
      } catch (error) {
        failure = error;
      }
    }
    abort.abort(failure);
    throw failure;
  };
  return {
    signal: abort.signal,
    assertCurrent,
    abort: () => {
      readers.clear();
      abort.abort(new Error("GitHub read owner closed"));
    },
    add(assertReader: () => void, signal?: AbortSignal) {
      const reader = () => {
        signal?.throwIfAborted();
        assertReader();
      };
      reader();
      readers.add(reader);
      const release = () => {
        readers.delete(reader);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        release();
        try {
          assertCurrent();
        } catch {
          // The assertion aborts shared transport when no admitted reader remains.
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      return release;
    },
  };
}

/** Session reads pin the admitted host, endpoint and credential across every auxiliary request. */
export function prepareSessionPullRequestGitHubRead(
  host: string,
  fetchImpl: typeof fetch,
  assertAccess: () => void,
  options: {
    optionalAuth?: boolean;
    signal?: AbortSignal;
    refresh?: boolean;
    onRequest?: (url: string, store: ApiRequestStore) => void;
    onResponse?: (url: string, store: ApiRequestStore, observation: number) => void;
  } = {},
) {
  const optionalAuth = options.optionalAuth !== false;
  const selected = gitHubPublicApi.resolveGitHubApiCredentialScope(undefined, host);
  const assertCurrent = () => {
    assertAccess();
    if (
      gitHubPublicApi.resolveGitHubApiCredentialScope(undefined, host).cacheScope !==
      selected.cacheScope
    ) {
      throw new gitHubPublicApi.ControlUiGitHubError(
        409,
        "GitHub identity changed; reopen the session pull request",
      );
    }
  };
  const identity = { assertSelected: assertCurrent, revalidate: async () => assertCurrent() };
  const store = getSharedApiStore({
    apiBaseUrl: selected.apiBaseUrl,
    token: selected.token,
    fetchImpl,
  });
  let responseStore = store;
  return {
    ...selected,
    host,
    get store() {
      return responseStore;
    },
    assertCurrent,
    async request(
      this: void,
      url: string,
      maxBytes?: number,
      signal?: AbortSignal,
      beforeRedirect?: (url: URL) => Promise<void>,
    ) {
      assertCurrent();
      const sourceSignals = [signal, options.signal].filter((value): value is AbortSignal =>
        Boolean(value),
      );
      const requestSignal =
        sourceSignals.length > 1 ? AbortSignal.any(sourceSignals) : sourceSignals[0];
      const readJson = async (token: string | undefined) => {
        const requestStore = getSharedApiStore({
          apiBaseUrl: selected.apiBaseUrl,
          token,
          fetchImpl,
        });
        // Failed observations remain dependencies so another reader's recovery wakes this view.
        options.onRequest?.(url, requestStore);
        const response = await gitHubPublicApi.fetchGitHubApi(
          url,
          fetchImpl,
          token,
          beforeRedirect,
          identity,
          undefined,
          requestSignal,
          undefined,
          selected.apiBaseUrl,
          { refresh: options.refresh },
        );
        const value = await gitHubPublicApi.readGitHubJsonResponse(response, maxBytes);
        responseStore = requestStore;
        options.onResponse?.(url, requestStore, requestStore.responses.observationOf(response));
        return value;
      };
      const value = optionalAuth
        ? await gitHubPublicApi.withOptionalGitHubAuth(selected.token, readJson)
        : await readJson(selected.token);
      assertCurrent();
      return value;
    },
  };
}
