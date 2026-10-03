import type { DatabaseSync, StatementSync } from "node:sqlite";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../src/infra/kysely-sync-cache-state.js";

/** Native execution and returned-payload accounting shared by host and worker fixtures. */
export function countSqliteStatementExecutions<Key extends string>(
  db: DatabaseSync,
  keys: readonly Key[],
  classify: (sql: string) => Key | null,
  onExecute?: (
    sql: string,
    bindings: readonly unknown[],
    statement: StatementSync,
  ) => void | (() => void),
): {
  counts: Record<Key, number>;
  rowCounts: Record<Key, number>;
  textBytes: Record<Key, number>;
  blobBytes: Record<Key, number>;
  restore: () => void;
} {
  clearNodeSqliteKyselyCacheForDatabase(db);
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
  const rowCounts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
  const textBytes = Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
  const blobBytes = Object.fromEntries(keys.map((key) => [key, 0])) as Record<Key, number>;
  const observeRow = (key: Key, row: Record<string, unknown>) => {
    rowCounts[key] += 1;
    for (const value of Object.values(row)) {
      if (typeof value === "string") {
        textBytes[key] += Buffer.byteLength(value);
      } else if (ArrayBuffer.isView(value)) {
        blobBytes[key] += value.byteLength;
      }
    }
  };
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Save exact identity for restoration; invocation is bound below.
  const previousPrepare = db.prepare;
  const originalPrepare = previousPrepare.bind(db);
  const restoreStatements: Array<() => void> = [];
  db.prepare = (sqlText: string) => {
    const statement = originalPrepare(sqlText);
    const key = classify(sqlText);
    if (key !== null) {
      const original = {
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Stored only for restoration; wrappers bind native calls.
        run: statement.run,
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Stored only for restoration; wrappers bind native calls.
        get: statement.get,
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Stored only for restoration; wrappers bind native calls.
        all: statement.all,
        // eslint-disable-next-line @typescript-eslint/unbound-method -- Stored only for restoration; wrappers bind native calls.
        iterate: statement.iterate,
      };
      restoreStatements.push(() => Object.assign(statement, original));
      // Preserve both positional and named-binding overloads at the native call boundary.
      statement.run = new Proxy(statement.run.bind(statement), {
        apply(run, receiver, args) {
          counts[key] += 1;
          const afterExecute = onExecute?.(sqlText, args, statement);
          const result = Reflect.apply(run, receiver, args);
          afterExecute?.();
          return result;
        },
      });
      statement.get = new Proxy(statement.get.bind(statement), {
        apply(get, _receiver, args) {
          counts[key] += 1;
          const afterExecute = onExecute?.(sqlText, args, statement);
          const row = get(...args);
          afterExecute?.();
          if (row) {
            observeRow(key, row);
          }
          return row;
        },
      });
      statement.all = new Proxy(statement.all.bind(statement), {
        apply(all, _receiver, args) {
          counts[key] += 1;
          const afterExecute = onExecute?.(sqlText, args, statement);
          const rows = all(...args);
          afterExecute?.();
          for (const row of rows) {
            observeRow(key, row);
          }
          return rows;
        },
      });
      const originalIterate = statement.iterate.bind(statement) as (
        ...args: unknown[]
      ) => ReturnType<StatementSync["iterate"]>;
      // iterate is overloaded, so the wrapper forwards untyped and casts back.
      statement.iterate = ((...args: unknown[]) => {
        const rows = originalIterate(...args);
        return (function* () {
          // Native iterators step lazily; creating one does not execute its SQL.
          let afterExecute: void | (() => void);
          try {
            afterExecute = onExecute?.(sqlText, args, statement);
          } catch (error) {
            rows.return?.();
            throw error;
          }
          counts[key] += 1;
          let observed = false;
          for (const row of rows) {
            if (!observed) {
              afterExecute?.();
              observed = true;
            }
            observeRow(key, row);
            yield row;
          }
          if (!observed) {
            afterExecute?.();
          }
        })();
      }) as StatementSync["iterate"];
    }
    return statement;
  };
  return {
    counts,
    rowCounts,
    textBytes,
    blobBytes,
    restore: () => {
      clearNodeSqliteKyselyCacheForDatabase(db);
      db.prepare = previousPrepare;
      for (const restore of restoreStatements) {
        restore();
      }
    },
  };
}
