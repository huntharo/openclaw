import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../../src/infra/node-sqlite.js";
import { expectSqliteQueryScans, observeSqliteWriteBudget } from "./sqlite-write-budget.js";
import { useAutoCleanupTempDirTracker } from "./temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it("counts cached and RETURNING writes, trigger/rollback changes, and committed WAL records", () => {
  const db = openNodeSqliteDatabase(
    path.join(tempDirs.make("sqlite-budget-counter-"), "test.sqlite"),
  );
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE items (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE audit (value TEXT);
    CREATE TRIGGER record_update AFTER UPDATE ON items BEGIN INSERT INTO audit VALUES (NEW.value); END;`);
  const pageSize = Number(db.prepare("PRAGMA page_size").get()?.page_size);
  const observer = observeSqliteWriteBudget(db);
  try {
    expect(() => observer.measure(() => Promise.resolve())).toThrow("must be synchronous");
    const cached = db.prepare("UPDATE items SET value=? WHERE key='one'");
    db.prepare("INSERT INTO items VALUES ('one', 'seed')").run();
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const measurement = observer.measure(() => {
      db.exec("BEGIN IMMEDIATE");
      cached.run("first");
      db.exec("SAVEPOINT nested");
      cached.run("rolled-back");
      db.exec("ROLLBACK TO nested");
      db.exec("RELEASE nested");
      const returned = db
        .prepare(
          "WITH value(v) AS (VALUES (?)) UPDATE items SET value=(SELECT v FROM value) WHERE key='one' RETURNING value",
        )
        .all("last");
      db.exec("COMMIT");
      return returned;
    });
    expect(measurement.writes).toMatchObject({ commits: 1, writeStatements: 3, rowsChanged: 6 });
    expect(measurement.writes.walFrames).toBeGreaterThan(0);
    expect(measurement.writes.walBytes).toBe(32 + measurement.writes.walFrames * (pageSize + 24));
    expect(measurement.result).toEqual([{ value: "last" }]);
    const deferred = observer.measure(() =>
      db.prepare("UPDATE items SET value=? WHERE key='one' RETURNING value").iterate("stepped"),
    );
    expect(deferred.writes).toMatchObject({ commits: 0, writeStatements: 0, rowsChanged: 0 });
    expect(deferred.plans.size).toBe(0);
    const stepped = observer.measure(() => [...deferred.result]);
    expect(stepped.writes).toMatchObject({ commits: 1, writeStatements: 1, rowsChanged: 2 });
    expect(stepped.result).toEqual([{ value: "stepped" }]);
    expect(db.prepare("SELECT value FROM audit").all()).toEqual([
      { value: "first" },
      { value: "last" },
      { value: "stepped" },
    ]);
    expect(() => observer.measure(() => db.exec("UPDATE items SET value='invisible'"))).toThrow(
      "prepared statements",
    );
  } finally {
    observer.restore();
    db.close();
  }
});

it("rejects table and index scans unless their exact query has a reason, independent of order", () => {
  const db = openNodeSqliteDatabase(
    path.join(tempDirs.make("sqlite-budget-plans-"), "test.sqlite"),
  );
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE items (key TEXT PRIMARY KEY, value TEXT); CREATE INDEX items_key_nocase ON items(key COLLATE NOCASE)",
  );
  const observer = observeSqliteWriteBudget(db);
  try {
    const tableSql = "SELECT value FROM items";
    const indexSql = "SELECT key FROM items ORDER BY key";
    const measurement = observer.measure(() => {
      db.prepare(tableSql).all();
      db.prepare(indexSql).all();
      db.prepare(tableSql).all();
    });
    expect(() => expectSqliteQueryScans(measurement.plans)).toThrow();
    expectSqliteQueryScans(measurement.plans, [
      {
        sql: indexSql,
        detail: "SCAN items USING COVERING INDEX sqlite_autoindex_items_1",
        reason: "Explicit complete ordered key export",
      },
      { sql: tableSql, detail: "SCAN items", reason: "Explicit complete value export" },
    ]);
    const lookup = observer.measure(() =>
      db.prepare("SELECT value FROM items WHERE key=?").get("one"),
    );
    expectSqliteQueryScans(lookup.plans);
    const configured = db.prepare("SELECT value FROM items WHERE key=$key");
    configured.setAllowUnknownNamedParameters(true);
    configured.setAllowBareNamedParameters(false);
    const configuredRead = observer.measure(() =>
      configured.get({ $key: "one", extra: "ignored" }),
    );
    expect(configuredRead.result).toBeUndefined();
    expectSqliteQueryScans(configuredRead.plans);
    const boundSql = "SELECT key FROM items WHERE key LIKE $pattern";
    const bound = db.prepare(boundSql);
    const changingBindings = observer.measure(() => {
      bound.all({ pattern: "one%" });
      bound.all({ pattern: "%one" });
    });
    expect(changingBindings.plans.get(boundSql)?.raw).toEqual(
      expect.arrayContaining([
        "SEARCH items USING COVERING INDEX items_key_nocase (key>? AND key<?)",
        "SCAN items USING COVERING INDEX items_key_nocase",
      ]),
    );
    expect(() => expectSqliteQueryScans(changingBindings.plans)).toThrow();
    expectSqliteQueryScans(changingBindings.plans, [
      {
        sql: boundSql,
        detail: "SCAN items USING COVERING INDEX items_key_nocase",
        reason: "Explicit substring export cannot constrain a leading-wildcard LIKE pattern",
      },
    ]);
    const existingWal = db.prepare("INSERT INTO items VALUES (?, ?)");
    existingWal.run("one", "seed");
    expect(() =>
      observer.measure(() => {
        db.prepare("/* checkpoint */ -- measured\n PRAGMA main.wal_checkpoint(TRUNCATE)").all();
        existingWal.run("two", "new-generation");
      }),
    ).toThrow("checkpoint/reuse");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(() =>
      observer.measure(() => {
        existingWal.run("three", "committed-before-checkpoint");
        db.prepare("/* checkpoint */ -- measured\n PRAGMA main.wal_checkpoint(TRUNCATE)").all();
      }),
    ).toThrow("checkpoint/reuse");
    expect(db.prepare("SELECT value FROM items WHERE key='three'").get()?.value).toBe(
      "committed-before-checkpoint",
    );
    expect(() =>
      observer.measure(() => db.prepare("/* checkpoint */ PRAGMA wal_autocheckpoint=1").all()),
    ).toThrow("checkpoint/reuse");
    db.exec("PRAGMA wal_autocheckpoint=0");
    expect(() =>
      observer.measure(() => db.prepare("/* prepare only */ PRAGMA wal_autocheckpoint=1")),
    ).toThrow("Disable automatic WAL checkpoints");
    db.exec("PRAGMA wal_autocheckpoint=1");
    expect(() => observer.measure(() => bound.all({ pattern: "one%" }))).toThrow(
      "Disable automatic WAL checkpoints",
    );
  } finally {
    observer.restore();
    db.close();
  }
});
