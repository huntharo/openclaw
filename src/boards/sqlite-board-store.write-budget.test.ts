import { afterEach, expect, it, vi } from "vitest";
import {
  expectSqliteQueryScans,
  expectSqliteWriteBudget,
  observeSqliteWriteBudget,
} from "../../test/helpers/sqlite-write-budget.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { bindSqliteWorkerBackend } from "./sqlite-board-store.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  vi.restoreAllMocks();
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
});

it.each([false, true])("bounds board put writes with reordering=%s", async (reorder) => {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("board-write-budget-") };
  const sessionKey = "agent:main:budget";
  const database = openOpenClawAgentDatabase({ agentId: "main", env });
  replaceSessionEntrySync(
    { agentId: "main", sessionKey, storePath: database.path },
    { sessionId: "board-budget-session", updatedAt: 1 },
  );
  // Checkpoints are excluded only in this isolated performance fixture.
  database.db.exec("PRAGMA wal_autocheckpoint=0");
  const observer = observeSqliteWriteBudget(database.db);
  let now = 1_800_000_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const admitted: string[] = [];
  const backend = bindSqliteWorkerBackend(undefined, {
    database: database.db,
    databasePath: database.path,
    admit: (stage) => admitted.push(stage),
  });
  const put = (index: number, iteration: number, after?: string) =>
    backend.execute({
      type: "boards.putWidget",
      input: {
        sessionKey,
        params: {
          sessionKey,
          name: `widget-${index}`,
          content: { kind: "html", html: `<p>${iteration}${"x".repeat(4096)}</p>` },
          ...(after ? { placement: { tabId: "main", after } } : {}),
        },
        viewGeneration: `fixture-${index}-${iteration}`,
      },
    });
  try {
    for (let index = 0; index < 24; index += 1) {
      put(index, 0);
    }
    const before = database.db
      .prepare("SELECT name, position, updated_at FROM board_widgets ORDER BY position")
      .all();
    database.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    admitted.length = 0;
    const measurement = observer.measure(() => {
      for (let iteration = 1; iteration <= 8; iteration += 1) {
        now += 1000;
        // Swap target 0 between positions 1 and 2; only that sibling shifts.
        put(0, iteration, reorder ? `widget-${iteration % 2 === 1 ? 2 : 1}` : undefined);
      }
    });
    console.log(
      JSON.stringify({
        scenario: reorder ? "board-put-reorder" : "board-put-content",
        ...measurement.writes,
        scans: [...measurement.plans.values()].flatMap((plan) =>
          plan.raw.filter((detail) => /^SCAN /i.test(detail)),
        ),
      }),
    );
    expectSqliteQueryScans(measurement.plans);
    expectSqliteWriteBudget(measurement.writes, {
      commits: 8,
      writeStatements: reorder ? 25 : 16,
      rowsChanged: reorder ? 25 : 16,
    });
    expect(admitted).toEqual(Array.from({ length: 8 }, () => ["transaction", "commit"]).flat());
    backend.assertSettled?.();
    const after = database.db
      .prepare("SELECT name, position, updated_at FROM board_widgets ORDER BY position")
      .all();
    expect(after.map((row) => row.name)).toEqual(
      reorder
        ? [
            "widget-1",
            "widget-0",
            ...Array.from({ length: 22 }, (_, index) => `widget-${index + 2}`),
          ]
        : before.map((row) => row.name),
    );
    expect(after.map((row) => row.position)).toEqual(
      Array.from({ length: 24 }, (_, index) => index),
    );
    expect(after.filter((row) => Number(row.name?.toString().split("-")[1]) >= 3)).toEqual(
      before.slice(3),
    );
    const target = database.db
      .prepare(
        "SELECT CAST(html AS TEXT) AS html, revision, updated_at FROM board_widgets WHERE name='widget-0'",
      )
      .get();
    expect(target?.html === `<p>8${"x".repeat(4096)}</p>`).toBe(true);
    expect(target).toMatchObject({ revision: 9, updated_at: now });
  } finally {
    observer.restore();
    await backend.close();
  }
});
