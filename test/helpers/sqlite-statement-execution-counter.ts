import type { DatabaseSync, StatementSync } from "node:sqlite";
import { vi, type Mock } from "vitest";
import { requireNodeSqlite } from "../../src/infra/node-sqlite.js";

/** Full node reads may add cold snapshot projections beside the node's columns. */
export function isSessionNodePayloadSelect(sql: string): boolean {
  return /^select \*(?:, [\s\S]+)? from "session_nodes"(?:\s|$)/i.test(sql);
}

/** Capture SQL during execution; closing a connection invalidates its statement getters. */
export function observeSqliteReadSql(prototype: StatementSync): {
  queries: string[];
  restore: () => void;
} {
  const queries: string[] = [];
  const observers = (["all", "get", "iterate"] as const).map((method) => {
    const original = prototype[method];
    return vi.spyOn(prototype, method).mockImplementation(
      new Proxy(original, {
        apply(target, receiver: StatementSync, args) {
          queries.push(receiver.sourceSQL);
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
  });
  return {
    queries,
    restore: () => observers.forEach((observer) => observer.mockRestore()),
  };
}

/**
 * Count SQLite query executions per caller-defined bucket. Prepared-statement
 * caching (src/infra/kysely-sync.ts) reuses statements across calls, so
 * counting `prepare` invocations undercounts; this wraps `all`, `get`, `iterate`, and `run` on matching
 * statements and clears the statement cache at attach so statements cached
 * before the spy cannot bypass it.
 */
export { countSqliteStatementExecutions as trackSqliteStatementExecutions } from "./sqlite-statement-executions.js";

/** Observe all host data SQL, including statements prepared before observation began. */
export function observeHostDataSql(onQuery?: (sql: string) => void): {
  calls: Mock[];
  queries: string[];
  restore: () => void;
} {
  // Validate the real runtime once before measurement. The owner's capability
  // probes are setup, not an exemption for arbitrary in-memory database SQL.
  const native = requireNodeSqlite();
  const queries: string[] = [];
  const recordQuery = (sql: string) => {
    queries.push(sql);
    onQuery?.(sql);
  };
  const prepare = vi.fn();
  const exec = vi.fn();
  // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted database receiver.
  const originalPrepare = native.DatabaseSync.prototype.prepare;
  // oxlint-disable-next-line typescript/unbound-method -- Called below with the intercepted database receiver.
  const originalExec = native.DatabaseSync.prototype.exec;
  const spies = [
    vi.spyOn(native.DatabaseSync.prototype, "prepare").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      prepare(sql);
      recordQuery(sql);
      return originalPrepare.call(this, sql);
    }),
    vi.spyOn(native.DatabaseSync.prototype, "exec").mockImplementation(function (
      this: DatabaseSync,
      sql,
    ) {
      exec(sql);
      recordQuery(sql);
      return originalExec.call(this, sql);
    }),
  ];
  const statements = (["get", "all", "run", "iterate"] as const).map((method) => {
    const called = vi.fn();
    const original = native.StatementSync.prototype[method];
    const spy = vi.spyOn(native.StatementSync.prototype, method).mockImplementation(
      new Proxy(original, {
        apply(target, receiver: StatementSync, args) {
          called(...args);
          recordQuery(receiver.sourceSQL);
          return Reflect.apply(target, receiver, args);
        },
      }),
    );
    return { called, spy };
  });
  return {
    calls: [prepare, exec, ...statements.map(({ called }) => called)],
    queries,
    restore: () => {
      spies.forEach((spy) => spy.mockRestore());
      statements.forEach(({ spy }) => spy.mockRestore());
    },
  };
}
