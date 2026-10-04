import type { DatabaseSync, StatementSync } from "node:sqlite";
import { isMainThread, threadId } from "node:worker_threads";
import { observeSqliteWriteBudget } from "../../../../test/helpers/sqlite-write-metrics.js";
import { transcriptEventNavigationSql } from "../../../config/sessions/transcript-payload.js";
import { getNodeSqliteKysely } from "../../../infra/kysely-sync.js";
import type {
  SqliteWorkerCommand,
  SqliteWorkerOperations,
} from "../../../infra/sqlite-worker-contract.js";
import type { DB } from "../../../state/openclaw-agent-db.generated.js";
import {
  bindSqliteWorkerBackend as bindMetadata,
  type SessionMetadataWorkerOperations,
} from "../session-manager-metadata.worker.js";

type Observer = ReturnType<typeof observeSqliteWriteBudget>;
type Measurement = ReturnType<Observer["end"]>;
export type TranscriptWriteMeasurement = Omit<Measurement, "plans"> & {
  plans: Array<[string, Measurement["plans"] extends Map<string, infer Plan> ? Plan : never]>;
  backendRowsChanged: number;
  command: string;
  workerThreadId: number;
  navigationShape: { rows: number; maxRootMembers: number; maxBytes: number };
};
type Window = {
  observer: Observer;
  prepare: (sql: string) => StatementSync;
  autoCheckpoint?: number;
  commands: string[];
  backendRowsChanged: number;
  lastMeasurement?: Measurement;
};
const windows = new WeakMap<DatabaseSync, Window>();
export type TranscriptBudgetOperations = {
  "fixture.budget.begin": {
    input: undefined;
    output: { autoCheckpoint: number; workerThreadId: number };
  };
  "fixture.budget.end": {
    input: undefined;
    output: {
      autoCheckpoint: number;
      workerThreadId: number;
      measurement?: TranscriptWriteMeasurement;
    };
  };
  "fixture.budget.close": { input: undefined; output: undefined };
  "fixture.budget.invalidate": { input: undefined; output: undefined };
  "fixture.budget.scanControls": {
    input: { sql: string; sessionId: string };
    output: Array<[string, TranscriptWriteMeasurement["plans"][number][1]]>;
  };
  "fixture.budget.execute": {
    input: SqliteWorkerCommand<SqliteWorkerOperations>;
    output: { result: unknown };
  };
};

/** The fixture borrows the exact production connection and admission; it owns no database. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  context: Parameters<typeof bindMetadata>[1],
) {
  if (isMainThread) {
    throw new Error("Transcript budgets must execute in the admitted SQLite worker");
  }
  let window = windows.get(context.database);
  if (!window) {
    const prepare = context.database.prepare.bind(context.database);
    window = {
      prepare,
      observer: observeSqliteWriteBudget(context.database),
      commands: [],
      backendRowsChanged: 0,
    };
    windows.set(context.database, window);
  }
  const state = window;
  const prepare = state.prepare;
  const readChanges = () => Number(prepare("SELECT total_changes() AS n").get()?.n);
  const navigationShape = () => {
    // Read the exact canonical navigation input after the window, using original
    // native functions so this fixture diagnostic is outside production counters.
    const query = getNodeSqliteKysely<Pick<DB, "transcript_events">>(context.database)
      .selectFrom("transcript_events")
      .select(transcriptEventNavigationSql().as("event_json"))
      .compile();
    const bindings = query.parameters.map((value) => {
      if (typeof value !== "string") {
        throw new Error("Fixture navigation query must bind only its canonical JSON path");
      }
      return value;
    });
    const rows = prepare(query.sql).all(...bindings);
    let maxRootMembers = 0;
    let maxBytes = 0;
    for (const row of rows) {
      if (typeof row.event_json !== "string") {
        throw new Error("Fixture navigation input must be JSON text");
      }
      const event: unknown = JSON.parse(row.event_json);
      if (!event || typeof event !== "object" || Array.isArray(event)) {
        throw new Error("Fixture navigation input must be a JSON object");
      }
      maxRootMembers = Math.max(maxRootMembers, Object.keys(event).length);
      maxBytes = Math.max(maxBytes, Buffer.byteLength(row.event_json));
    }
    return { rows: rows.length, maxRootMembers, maxBytes };
  };
  const restoreCheckpoint = () => {
    if (state.autoCheckpoint !== undefined) {
      prepare(`PRAGMA wal_autocheckpoint=${state.autoCheckpoint}`).all();
      state.autoCheckpoint = undefined;
    }
  };
  const cancel = () => {
    state.observer.cancel();
    restoreCheckpoint();
  };
  let metadata: ReturnType<typeof bindMetadata>;
  try {
    metadata = bindMetadata(undefined, context);
  } catch (error) {
    cancel();
    throw error;
  }
  return {
    execute(command: SqliteWorkerCommand<TranscriptBudgetOperations>) {
      try {
        if (command.type === "fixture.budget.begin") {
          if (state.autoCheckpoint !== undefined) {
            throw new Error("Transcript budget already active");
          }
          const autoCheckpoint = Number(
            prepare("PRAGMA wal_autocheckpoint").get()?.wal_autocheckpoint,
          );
          state.autoCheckpoint = autoCheckpoint;
          prepare("PRAGMA wal_autocheckpoint=0").all();
          if (Number(prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()?.busy) !== 0) {
            throw new Error("The isolated transcript budget WAL could not be truncated");
          }
          state.commands.length = 0;
          state.backendRowsChanged = 0;
          state.observer.begin();
          return { autoCheckpoint, workerThreadId: threadId };
        }
        if (command.type === "fixture.budget.end") {
          let measurement: TranscriptWriteMeasurement | undefined;
          if (state.autoCheckpoint !== undefined) {
            const { plans, ...observed } = state.observer.end();
            state.lastMeasurement = { ...observed, plans };
            measurement = {
              ...observed,
              plans: [...plans],
              backendRowsChanged: state.backendRowsChanged,
              command: state.commands.join(","),
              workerThreadId: threadId,
              navigationShape: navigationShape(),
            };
          }
          restoreCheckpoint();
          return {
            autoCheckpoint: Number(prepare("PRAGMA wal_autocheckpoint").get()?.wal_autocheckpoint),
            workerThreadId: threadId,
            measurement,
          };
        }
        if (command.type === "fixture.budget.close") {
          cancel();
          state.observer.restore();
          windows.delete(context.database);
          return undefined;
        }
        if (command.type === "fixture.budget.invalidate") {
          // A prepared-only PRAGMA changes the real connection; end must reject and restore it.
          prepare("PRAGMA wal_autocheckpoint=1");
          return undefined;
        }
        if (command.type === "fixture.budget.scanControls") {
          if (
            state.autoCheckpoint !== undefined ||
            !state.lastMeasurement?.plans.has(command.input.sql)
          ) {
            throw new Error("Scan controls require a completed observed fixture query");
          }
          const originalCheckpoint = Number(
            prepare("PRAGMA wal_autocheckpoint").get()?.wal_autocheckpoint,
          );
          prepare("PRAGMA wal_autocheckpoint=0").all();
          try {
            const bindings = [
              "$.navigation",
              "type",
              "id",
              "parentId",
              "targetId",
              "appendParentId",
              "appendMode",
              command.input.sessionId,
            ];
            const control = state.observer.measure(() => {
              context.database.prepare(command.input.sql).all(...bindings, 2);
              context.database
                .prepare(command.input.sql.replace("limit ?", "limit ? offset 0"))
                .all(...bindings, 1);
            });
            return [...control.plans];
          } finally {
            prepare(`PRAGMA wal_autocheckpoint=${originalCheckpoint}`).all();
          }
        }
        // SAFETY: The fixture intercepts only the paired metadata module's typed commands.
        const productionCommand =
          command.input as SqliteWorkerCommand<SessionMetadataWorkerOperations>;
        const before = readChanges();
        const result = metadata.execute(productionCommand);
        if (state.autoCheckpoint !== undefined) {
          state.commands.push(productionCommand.type);
          state.backendRowsChanged += readChanges() - before;
        }
        return { result };
      } catch (error) {
        cancel();
        throw error;
      }
    },
    assertSettled() {
      try {
        metadata.assertSettled?.();
      } catch (error) {
        cancel();
        throw error;
      }
    },
    close: () => metadata.close(),
  };
}
