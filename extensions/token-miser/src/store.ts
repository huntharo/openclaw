import { randomUUID } from "node:crypto";
import type {
  PluginBlobStore,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { boundedInteger, createTokenMiserRetriever } from "./store-retrieval.js";
import type {
  TokenMiserScope,
  TokenMiserAuthority,
  TokenMiserMetadata,
  TokenMiserCapture,
  TokenMiserReference,
  TokenMiserAcceptance,
  TokenMiserRetrieval,
  TokenMiserRetrievalResult,
} from "./store-types.js";
export type * from "./store-types.js";

const encoder = new TextEncoder();
const MAX_MEMBERS = 16;

function validateScope(scope: TokenMiserScope): void {
  if (
    !scope.agentId.trim() ||
    !scope.sessionId.trim() ||
    scope.agentId.length > 256 ||
    scope.sessionId.length > 256 ||
    (scope.sessionKey !== undefined && (!scope.sessionKey.trim() || scope.sessionKey.length > 1024))
  ) {
    throw new Error("Token Miser requires a valid agent and canonical session identity.");
  }
}

function sameScope(left: TokenMiserScope, right: TokenMiserScope): boolean {
  return (
    left.agentId === right.agentId &&
    left.sessionId === right.sessionId &&
    left.sessionKey === right.sessionKey
  );
}

function copyScope(scope: TokenMiserScope): TokenMiserScope {
  return {
    agentId: scope.agentId,
    sessionId: scope.sessionId,
    ...(scope.sessionKey !== undefined ? { sessionKey: scope.sessionKey } : {}),
  };
}

export function createTokenMiserStore(options: {
  blobStore: PluginBlobStore<TokenMiserMetadata>;
  acceptanceStore: PluginStateKeyedStore<TokenMiserAcceptance>;
  retentionHours: number;
  maxEntryBytes: number;
  maxResponseBytes?: number;
}) {
  const ttlMs = boundedInteger(options.retentionHours, 1, 168, "retention hours") * 3_600_000;
  const maxEntryBytes = boundedInteger(
    options.maxEntryBytes,
    1024,
    32 * 1024 * 1024,
    "entry byte limit",
  );
  const maxResponseBytes = boundedInteger(
    options.maxResponseBytes ?? 32_000,
    1024,
    64_000,
    "response byte limit",
  );
  const store = options.blobStore;
  const acceptance = options.acceptanceStore;
  const staged = new Map<string, TokenMiserScope>();
  const committed = new Set<string>();
  const commits = new Map<string, { scope: TokenMiserScope; promise: Promise<boolean> }>();
  const discards = new Map<string, { scope: TokenMiserScope; promise: Promise<void> }>();
  const pending = new Set<Promise<unknown>>();
  let closed = false;
  let closing: Promise<void> | undefined;

  function assertAccess(scope: TokenMiserScope, authority: TokenMiserAuthority): void {
    if (closed) {
      throw new Error("Token Miser store is closed.");
    }
    validateScope(scope);
    authority.assertCurrent();
  }

  function track<T>(operation: () => Promise<T>): Promise<T> {
    const promise = operation();
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
    return promise;
  }

  async function read(
    id: string,
    scope: TokenMiserScope,
    authority: TokenMiserAuthority,
    accepted = true,
  ) {
    assertAccess(scope, authority);
    if (accepted && staged.has(id)) {
      throw new Error("Token Miser result is unavailable in this session or has expired.");
    }
    const entry = await store.lookup(id);
    assertAccess(scope, authority);
    if (
      !entry ||
      entry.metadata.version !== 1 ||
      !sameScope(entry.metadata.scope, scope) ||
      !Number.isSafeInteger(entry.metadata.expiresAt) ||
      entry.metadata.expiresAt <= Date.now() ||
      (accepted && staged.has(id)) ||
      (accepted && !(await hasAcceptance(id, entry.metadata, scope, authority))) ||
      (accepted && staged.has(id))
    ) {
      throw new Error("Token Miser result is unavailable in this session or has expired.");
    }
    if (entry.metadata.originalBytes !== entry.bytes.byteLength) {
      throw new Error("Token Miser retained byte count is invalid.");
    }
    return entry;
  }

  async function hasAcceptance(
    id: string,
    metadata: TokenMiserMetadata,
    scope: TokenMiserScope,
    authority: TokenMiserAuthority,
  ): Promise<boolean> {
    assertAccess(scope, authority);
    const marker = await acceptance.lookup(id);
    assertAccess(scope, authority);
    if (!marker) {
      return false;
    }
    return (
      sameScope(marker.scope, scope) &&
      marker.expiresAt === metadata.expiresAt &&
      marker.expiresAt > Date.now()
    );
  }

  const retrieve = createTokenMiserRetriever({ maxResponseBytes, assertAccess, read });

  return {
    stage(
      capture: TokenMiserCapture,
      authority: TokenMiserAuthority,
    ): Promise<TokenMiserReference | undefined> {
      return track(async () => {
        assertAccess(capture.scope, authority);
        if (!authority.allowPersistence) {
          return undefined;
        }
        const { content } = capture;
        const metadata = {
          scope: copyScope(capture.scope),
          runtime: capture.runtime,
          toolCallId: capture.toolCallId,
          toolName: capture.toolName,
          ...(capture.runId !== undefined ? { runId: capture.runId } : {}),
          ...(capture.turnId !== undefined ? { turnId: capture.turnId } : {}),
          ...(capture.memberIds ? { memberIds: [...capture.memberIds] } : {}),
        };
        if (
          !content.length ||
          content.some((block) => block.type !== "text" || typeof block.text !== "string") ||
          !capture.toolCallId ||
          !capture.toolName ||
          (capture.memberIds &&
            (capture.memberIds.length > MAX_MEMBERS ||
              new Set(capture.memberIds).size !== capture.memberIds.length))
        ) {
          throw new Error(
            "Token Miser capture requires text content and attributable tool identities.",
          );
        }
        const bytes = encoder.encode(JSON.stringify(content));
        if (bytes.byteLength > maxEntryBytes) {
          return undefined;
        }
        const id = `tm_${randomUUID()}`;
        const now = Date.now();
        const expiresAt = capture.expiresAt ?? now + ttlMs;
        if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + ttlMs) {
          throw new Error(
            "Token Miser capture deadline must be within the configured retention window.",
          );
        }
        try {
          await store.deleteExpired();
          assertAccess(capture.scope, authority);
          const registered = await store.registerIfAbsent(
            id,
            bytes,
            {
              ...metadata,
              version: 1,
              originalBytes: bytes.byteLength,
              expiresAt,
            },
            { ttlMs: expiresAt - Date.now() },
          );
          if (registered) {
            staged.set(id, metadata.scope);
          }
          assertAccess(capture.scope, authority);
          if (!registered) {
            return undefined;
          }
          const entry = await read(id, capture.scope, authority, false);
          if (entry.expiresAt === undefined) {
            throw new Error("Token Miser staged result has no expiry.");
          }
          return { id, originalBytes: bytes.byteLength, expiresAt };
        } catch {
          if (staged.has(id)) {
            try {
              await store.delete(id);
              staged.delete(id);
            } catch {
              // Failed cleanup stays owned until close retries, then TTL bounds the orphan.
            }
          }
          return undefined;
        }
      });
    },
    commit(id: string, scope: TokenMiserScope, authority: TokenMiserAuthority): Promise<boolean> {
      const capturedScope = copyScope(scope);
      const assertSelecting = () => {
        assertAccess(capturedScope, authority);
        if (discards.has(id)) {
          throw new Error("Token Miser result is being discarded.");
        }
      };
      const existing = commits.get(id);
      if (existing) {
        return track(async () => {
          assertAccess(capturedScope, authority);
          if (!sameScope(existing.scope, capturedScope)) {
            return false;
          }
          const result = await existing.promise;
          assertAccess(capturedScope, authority);
          return result;
        });
      }
      const promise = track(async () => {
        try {
          const entry = await read(id, capturedScope, authority, false);
          if (!authority.allowPersistence) {
            return false;
          }
          if (await hasAcceptance(id, entry.metadata, capturedScope, authority)) {
            assertSelecting();
            if (staged.has(id)) {
              committed.add(id);
            }
            return true;
          }
          if (!staged.has(id)) {
            return false;
          }
          const remainingTtl = entry.metadata.expiresAt - Date.now();
          if (remainingTtl <= 0) {
            return false;
          }
          assertSelecting();
          await acceptance.register(
            id,
            { scope: capturedScope, expiresAt: entry.metadata.expiresAt },
            { ttlMs: remainingTtl, assertCurrent: assertSelecting },
          );
          assertSelecting();
          if (!(await hasAcceptance(id, entry.metadata, capturedScope, authority))) {
            throw new Error("Token Miser acceptance marker was not published.");
          }
          assertSelecting();
          committed.add(id);
          return true;
        } catch {
          const ownedScope = staged.get(id);
          if (ownedScope && sameScope(ownedScope, capturedScope)) {
            committed.delete(id);
            try {
              await acceptance.delete(id);
            } catch {
              // No reference was delivered; failed rollback remains bounded by expiry.
            }
          }
          return false;
        }
      });
      commits.set(id, { scope: capturedScope, promise });
      const release = () => commits.delete(id);
      void promise.then(release, release);
      return promise;
    },
    release(id: string): void {
      if (discards.has(id) && staged.has(id)) {
        throw new Error("Token Miser result was discarded before selection settled.");
      }
      if (committed.delete(id)) {
        staged.delete(id);
      }
    },
    acceptedCount(scope: TokenMiserScope, authority: TokenMiserAuthority): Promise<number> {
      return track(async () => {
        assertAccess(scope, authority);
        const markers = await acceptance.entries();
        assertAccess(scope, authority);
        const accepted = new Map(
          markers
            .filter(
              (entry) =>
                sameScope(entry.value.scope, scope) &&
                entry.value.expiresAt > Date.now() &&
                !staged.has(entry.key),
            )
            .map((entry) => [entry.key, entry.value]),
        );
        const entries = await store.entries();
        assertAccess(scope, authority);
        return entries.filter((entry) => {
          const marker = accepted.get(entry.key);
          return (
            marker &&
            marker.expiresAt > Date.now() &&
            marker.expiresAt === entry.metadata.expiresAt &&
            sameScope(entry.metadata.scope, scope)
          );
        }).length;
      });
    },
    discard(id: string, scope: TokenMiserScope, _authority: TokenMiserAuthority): Promise<void> {
      const capturedScope = copyScope(scope);
      const assertOwned = () => {
        validateScope(capturedScope);
        const ownedScope = staged.get(id);
        if (!ownedScope) {
          return false;
        }
        if (!sameScope(ownedScope, capturedScope)) {
          throw new Error("Token Miser result is unavailable in this session.");
        }
        if (closed) {
          throw new Error("Token Miser store is closed.");
        }
        return true;
      };
      const existing = discards.get(id);
      if (existing) {
        return track(async () => {
          validateScope(capturedScope);
          if (!sameScope(existing.scope, capturedScope)) {
            throw new Error("Token Miser result is unavailable in this session.");
          }
          await existing.promise;
        });
      }
      const promise = track(async () => {
        // Unpublished records retain cleanup custody when the originating session loses authority.
        if (!assertOwned()) {
          return;
        }
        const committing = commits.get(id);
        if (committing) {
          await committing.promise;
          if (!assertOwned()) {
            return;
          }
        }
        await acceptance.delete(id, {
          assertCurrent: () => {
            if (!assertOwned()) {
              throw new Error("Token Miser staged cleanup custody ended.");
            }
          },
        });
        if (!assertOwned()) {
          return;
        }
        await store.delete(id);
        assertOwned();
        committed.delete(id);
        staged.delete(id);
      });
      discards.set(id, { scope: capturedScope, promise });
      const release = () => discards.delete(id);
      void promise.then(release, release);
      return promise;
    },
    retrieve(
      request: TokenMiserRetrieval,
      scope: TokenMiserScope,
      authority: TokenMiserAuthority,
    ): Promise<TokenMiserRetrievalResult> {
      return track(() => retrieve(request, scope, authority));
    },
    close(): Promise<void> {
      closing ??= (async () => {
        closed = true;
        await Promise.allSettled(pending);
        const errors: unknown[] = [];
        for (const id of staged.keys()) {
          try {
            await acceptance.delete(id);
          } catch (error) {
            errors.push(error);
          }
          try {
            await store.delete(id);
            committed.delete(id);
            staged.delete(id);
          } catch (error) {
            errors.push(error);
          }
        }
        if (errors.length) {
          throw new AggregateError(errors, "Token Miser could not clean up all staged results.");
        }
      })();
      return closing;
    },
  };
}

export type TokenMiserStore = ReturnType<typeof createTokenMiserStore>;
