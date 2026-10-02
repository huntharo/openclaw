import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { expect, vi } from "vitest";
import { collectSqliteQueryPlanEvidence } from "../../scripts/lib/sqlite-query-plan-evidence.js";
import { trackSqliteStatementExecutions } from "./sqlite-statement-execution-counter.js";

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
  const checkpointSql = new Set<string>();
  let measuring = false;
  const plans = new Map<string, ReturnType<typeof collectSqliteQueryPlanEvidence>>();
  const executions = trackSqliteStatementExecutions(
    db,
    ["writes", "reads"],
    (sql) => {
      let kind = kinds.get(sql);
      if (!kind) {
        // SQLite's VM identifies writes even for WITH and RETURNING statements.
        const program = prepare(`EXPLAIN ${sql}`).all();
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
      return () => {
        // expandedSQL comes from the executed native statement, so ignored names,
        // bare-name settings, and actual bindings follow that statement's contract.
        const raw = prepare(`EXPLAIN QUERY PLAN ${statement.expandedSQL}`)
          .all()
          .map((row) => String(row.detail));
        plans.set(
          sql,
          collectSqliteQueryPlanEvidence([...new Set([...(plans.get(sql)?.raw ?? []), ...raw])]),
        );
      };
    },
  );
  const originalExec = db.exec.bind(db);
  const exec = vi.spyOn(db, "exec").mockImplementation((sql) => {
    if (
      measuring &&
      !/^(?:BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b[^;]*;?\s*$/i.test(sql.trim())
    ) {
      throw new Error("Execute measured data SQL through prepared statements so budgets count it");
    }
    originalExec(sql);
  });
  const assertCheckpointsDisabled = () => {
    if (Number(prepare("PRAGMA wal_autocheckpoint").get()?.wal_autocheckpoint) !== 0) {
      throw new Error("Disable automatic WAL checkpoints in the isolated budget fixture");
    }
  };
  return {
    measure<T>(run: () => T): { result: T; writes: SqliteWriteBudget; plans: typeof plans } {
      if (db.isTransaction || measuring) {
        throw new Error("Start a SQLite budget workload outside a transaction");
      }
      assertCheckpointsDisabled();
      plans.clear();
      const before = readWal(`${path}-wal`);
      const beforeRows = Number(prepare("SELECT total_changes() AS n").get()?.n);
      const beforeStatements = executions.counts.writes;
      measuring = true;
      try {
        const result = run();
        if (isPromiseLike(result)) {
          throw new Error("SQLite budget workloads must be synchronous");
        }
        if (db.isTransaction) {
          throw new Error("SQLite budget workload left a transaction open");
        }
        // Some PRAGMAs change connection settings during prepare, before any step.
        assertCheckpointsDisabled();
        const after = readWal(`${path}-wal`);
        if (
          (before.generation && before.generation !== after.generation) ||
          after.frames < before.frames
        ) {
          throw new Error("SQLite WAL checkpoint/reuse invalidated the budget measurement");
        }
        return {
          result,
          writes: {
            commits: after.commits - before.commits,
            writeStatements: executions.counts.writes - beforeStatements,
            // SQLite total_changes includes trigger writes and rolled-back changes.
            rowsChanged: Number(prepare("SELECT total_changes() AS n").get()?.n) - beforeRows,
            walFrames: after.frames - before.frames,
            walBytes: after.bytes - before.bytes,
          },
          plans: new Map(plans),
        };
      } finally {
        measuring = false;
      }
    },
    restore() {
      exec.mockRestore();
      executions.restore();
    },
  };
}

export function expectSqliteWriteBudget(
  measured: SqliteWriteBudget,
  budget: Pick<SqliteWriteBudget, "commits" | "writeStatements" | "rowsChanged">,
) {
  // WAL geometry is evidence; portable budgets enforce logical work only.
  expect({
    commits: measured.commits,
    writeStatements: measured.writeStatements,
    rowsChanged: measured.rowsChanged,
  }).toEqual(budget);
}

/** Indexed scans also visit an unbounded relation; require a query-specific reason. */
export function expectSqliteQueryScans(
  plans: ReadonlyMap<string, ReturnType<typeof collectSqliteQueryPlanEvidence>>,
  justified: readonly { sql: string; detail: string; reason: string }[] = [],
) {
  const scans = [...plans].flatMap(([sql, plan]) =>
    plan.raw
      .filter((detail) => /^SCAN /i.test(detail) && !/^SCAN CONSTANT ROW/i.test(detail))
      .map((detail) => ({ sql, detail })),
  );
  for (const scan of justified) {
    expect(scan.reason.trim(), `Explain why ${scan.detail} is required`).not.toBe("");
  }
  const sort = (a: { sql: string; detail: string }, b: { sql: string; detail: string }) =>
    a.sql.localeCompare(b.sql) || a.detail.localeCompare(b.detail);
  expect(scans.toSorted(sort)).toEqual(
    justified.map(({ sql, detail }) => ({ sql, detail })).toSorted(sort),
  );
}
