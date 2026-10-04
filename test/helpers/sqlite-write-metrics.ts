import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { collectSqliteQueryPlanEvidence } from "../../scripts/lib/sqlite-query-plan-evidence.js";
import { countSqliteStatementExecutions } from "./sqlite-statement-executions.js";

type WalSnapshot = { frames: number; commits: number; bytes: number; generation: string };

function readWal(path: string): WalSnapshot {
  if (!fs.existsSync(path) || fs.statSync(path).size === 0) {
    return { frames: 0, commits: 0, bytes: 0, generation: "" };
  }
  const bytes = fs.readFileSync(path);
  if (bytes.length < 32) {
    throw new Error("Incomplete SQLite WAL header");
  }
  const pageSize = bytes.readUInt32BE(8);
  const frameSize = pageSize + 24;
  if (pageSize < 512 || (bytes.length - 32) % frameSize !== 0) {
    throw new Error("Incomplete SQLite WAL frame");
  }
  const generation = bytes.subarray(16, 24).toString("hex");
  let commits = 0;
  for (let offset = 32; offset < bytes.length; offset += frameSize) {
    if (bytes.subarray(offset + 8, offset + 16).toString("hex") !== generation) {
      throw new Error(
        "WAL contains reused frames; measure a fresh isolated WAL without checkpoints",
      );
    }
    if (bytes.readUInt32BE(offset + 4) !== 0) {
      commits += 1;
    }
  }
  return { frames: (bytes.length - 32) / frameSize, commits, bytes: bytes.length, generation };
}

export type SqliteWriteBudget = {
  commits: number;
  writeStatements: number;
  rowsChanged: number;
  walFrames: number;
  walBytes: number;
};

/**
 * Attach before seeding/caching statements, then measure only the workload.
 * The caller owns a file-backed WAL database and disables checkpoints for the
 * measurement. WAL frames/commit markers are SQLite output, not OS disk bytes.
 */
export function observeSqliteWriteBudget(db: DatabaseSync) {
  const path = db.location();
  if (!path || db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "wal") {
    throw new Error("SQLite write budgets require an isolated file-backed WAL database");
  }
  const prepare = db.prepare.bind(db);
  const kinds = new Map<string, "writes" | "reads">();
  const persistentCursors = new Map<string, number>();
  const checkpointSql = new Set<string>();
  let measuring = false;
  const plans = new Map<
    string,
    ReturnType<typeof collectSqliteQueryPlanEvidence> & {
      persistentCursors: number;
      expandedSql: string;
      expandedSqlStable: boolean;
    }
  >();
  const statementCounts = new Map<string, number>();
  const executions = countSqliteStatementExecutions(
    db,
    ["writes", "reads"],
    (sql) => {
      let kind = kinds.get(sql);
      if (!kind) {
        // SQLite's VM identifies writes even for WITH and RETURNING statements.
        const program = prepare(`EXPLAIN ${sql}`).all();
        persistentCursors.set(
          sql,
          program.filter((row) => row.opcode === "OpenRead" || row.opcode === "OpenWrite").length,
        );
        kind = program.some((row) => row.opcode === "Transaction" && Number(row.p2) !== 0)
          ? "writes"
          : "reads";
        const executableSql = sql.replace(/^(?:\s|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/, "");
        if (
          program.some((row) => row.opcode === "Checkpoint") ||
          (/^pragma\b/i.test(executableSql) && /\bwal_autocheckpoint\b/i.test(executableSql))
        ) {
          checkpointSql.add(sql);
        }
        kinds.set(sql, kind);
      }
      return kind;
    },
    (sql, _bindings, statement) => {
      if (!measuring) {
        return undefined;
      }
      if (checkpointSql.has(sql)) {
        throw new Error("SQLite checkpoint/reuse is forbidden during budget measurement");
      }
      statementCounts.set(sql, (statementCounts.get(sql) ?? 0) + 1);
      return () => {
        // expandedSQL comes from the executed native statement, so ignored names,
        // bare-name settings, and actual bindings follow that statement's contract.
        const expandedSql = statement.expandedSQL;
        const raw = prepare(`EXPLAIN QUERY PLAN ${expandedSql}`)
          .all()
          .map((row) => String(row.detail));
        plans.set(sql, {
          ...collectSqliteQueryPlanEvidence([...new Set([...(plans.get(sql)?.raw ?? []), ...raw])]),
          persistentCursors: persistentCursors.get(sql) ?? 0,
          expandedSql,
          expandedSqlStable:
            !plans.has(sql) ||
            (plans.get(sql)?.expandedSqlStable === true &&
              plans.get(sql)?.expandedSql === expandedSql),
        });
      };
    },
  );
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Save exact identity for restoration; invocation is bound below.
  const previousExec = db.exec;
  const originalExec = previousExec.bind(db);
  db.exec = (sql) => {
    if (
      measuring &&
      !/^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b[^;]*;?\s*$/i.test(sql.trim())
    ) {
      throw new Error("Execute measured data SQL through prepared statements so budgets count it");
    }
    originalExec(sql);
  };
  const assertCheckpointsDisabled = () => {
    if (Number(prepare("PRAGMA wal_autocheckpoint").get()?.wal_autocheckpoint) !== 0) {
      throw new Error("Disable automatic WAL checkpoints in the isolated budget fixture");
    }
  };
  const snapshot = () => ({
    wal: readWal(`${path}-wal`),
    rows: Number(prepare("SELECT total_changes() AS n").get()?.n),
    writes: executions.counts.writes,
    reads: {
      statements: executions.counts.reads,
      rows: executions.rowCounts.reads,
      textBytes: executions.textBytes.reads,
      blobBytes: executions.blobBytes.reads,
    },
  });
  let before: ReturnType<typeof snapshot> | undefined;
  const cancel = () => {
    measuring = false;
    before = undefined;
  };
  const begin = () => {
    if (db.isTransaction || measuring) {
      throw new Error("Start a SQLite budget workload outside a transaction");
    }
    assertCheckpointsDisabled();
    plans.clear();
    statementCounts.clear();
    before = snapshot();
    measuring = true;
  };
  const end = () => {
    if (!before || !measuring) {
      throw new Error("Begin a SQLite budget before ending it");
    }
    try {
      if (db.isTransaction) {
        throw new Error("SQLite budget workload left a transaction open");
      }
      // Some PRAGMAs change connection settings during prepare, before any step.
      assertCheckpointsDisabled();
      const after = snapshot();
      if (
        (before.wal.generation && before.wal.generation !== after.wal.generation) ||
        after.wal.frames < before.wal.frames
      ) {
        throw new Error("SQLite WAL checkpoint/reuse invalidated the budget measurement");
      }
      return {
        writes: {
          commits: after.wal.commits - before.wal.commits,
          writeStatements: after.writes - before.writes,
          // Authoritative connection delta includes triggers and rolled-back changes.
          rowsChanged: after.rows - before.rows,
          walFrames: after.wal.frames - before.wal.frames,
          walBytes: after.wal.bytes - before.wal.bytes,
        },
        reads: {
          statements: after.reads.statements - before.reads.statements,
          rows: after.reads.rows - before.reads.rows,
          textBytes: after.reads.textBytes - before.reads.textBytes,
          blobBytes: after.reads.blobBytes - before.reads.blobBytes,
        },
        plans: new Map(plans),
        statements: [...statementCounts].map(([sql, count]) => ({ sql, executions: count })),
      };
    } finally {
      cancel();
    }
  };
  return {
    begin,
    end,
    cancel,
    measure<T>(run: () => T) {
      begin();
      try {
        const result = run();
        if (isPromiseLike(result)) {
          throw new Error("SQLite budget workloads must be synchronous");
        }
        return { result, ...end() };
      } finally {
        cancel();
      }
    },
    restore() {
      cancel();
      db.exec = previousExec;
      executions.restore();
    },
  };
}
