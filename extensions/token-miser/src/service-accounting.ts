import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import type { TokenMiserScope } from "./store.js";
type Usage = Awaited<ReturnType<OpenClawPluginApi["runtime"]["llm"]["complete"]>>["usage"];
type Counters = {
  scope: "gateway-runtime";
  decisions: number;
  summarized: number;
  passedThrough: number;
  failedOpen: number;
  originalBytes: number;
  projectedBytes: number;
  retrievedBytes: number;
  retrievalCount: number;
  helper: { calls: number } & Usage;
};

const usageFields = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
] as const;
const emptyCounters = (): Counters => ({
  scope: "gateway-runtime",
  decisions: 0,
  summarized: 0,
  passedThrough: 0,
  failedOpen: 0,
  originalBytes: 0,
  projectedBytes: 0,
  retrievedBytes: 0,
  retrievalCount: 0,
  helper: { calls: 0 },
});

function scopeKey(scope: TokenMiserScope) {
  return JSON.stringify([scope.agentId, scope.sessionId, scope.sessionKey]);
}

export function createTokenMiserAccounting() {
  const counters = new Map<string, Counters>();
  const missingUsage = new Map<string, Set<keyof Usage>>();
  const statsFor = (scope: TokenMiserScope) => {
    const key = scopeKey(scope);
    let stats = counters.get(key);
    if (!stats) {
      stats = emptyCounters();
      if (counters.size >= 1000) {
        const oldest = counters.keys().next().value;
        if (oldest !== undefined) {
          counters.delete(oldest);
          missingUsage.delete(oldest);
        }
      }
      counters.set(key, stats);
    }
    return stats;
  };
  const recordUsage = (scope: TokenMiserScope, usage?: Usage) => {
    const key = scopeKey(scope);
    const stats = statsFor(scope);
    const missing = missingUsage.get(key) ?? new Set<keyof Usage>();
    missingUsage.set(key, missing);
    for (const field of usageFields) {
      const value = usage?.[field];
      if (value === undefined || !Number.isFinite(value) || value < 0) {
        missing.add(field);
        delete stats.helper[field];
      } else if (!missing.has(field)) {
        stats.helper[field] = (stats.helper[field] ?? 0) + value;
      }
    }
  };

  return {
    statsFor,
    recordUsage,
    stats: (scope: TokenMiserScope) => structuredClone(statsFor(scope)),
    recordRetrieval: (scope: TokenMiserScope, bytes: number) => {
      const stats = statsFor(scope);
      stats.retrievalCount += 1;
      stats.retrievedBytes += bytes;
    },
    clear: () => {
      counters.clear();
      missingUsage.clear();
    },
  };
}
