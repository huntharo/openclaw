import { expect } from "vitest";
import type { collectSqliteQueryPlanEvidence } from "../../scripts/lib/sqlite-query-plan-evidence.js";
import type { SqliteWriteBudget } from "./sqlite-write-metrics.js";
export { observeSqliteWriteBudget, type SqliteWriteBudget } from "./sqlite-write-metrics.js";

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
