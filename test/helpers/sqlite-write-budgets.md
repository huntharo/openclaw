# SQLite workload budgets

`sqlite-write-metrics.ts` is the Vitest-free measurement owner. Native worker
fixtures can use it directly; `sqlite-write-budget.ts` supplies Vitest assertions.
`sqlite-statement-execution-counter.ts` retains the shared read-counter API.

## Add a workload

1. Pin the unchanged production commit by full SHA. Add the fixture and collector
   without changing production. Run every new workload on that commit first.
2. Use the actual owner entry point, an isolated database, deterministic requests
   and responses, and identical seed bytes/order. Finish migrations, seeds, and
   warmup before `begin()` or `measure()`. Use a fresh database per independent
   case so earlier cases cannot change FTS segment merge costs.
3. Attach before owner caches are created. `begin()` / `end()` span commands on
   the same connection; `measure()` wraps one synchronous operation. Keep the
   collector installed but inactive during setup. Disable `wal_autocheckpoint`
   on that connection for the entire measured window, truncate its WAL before
   beginning, and restore its original setting on success and failure.
4. Record commits, observed executed write statements, authoritative connection
   `total_changes`, read statements/returned rows/bytes, actual bound query plans,
   and observational WAL frames/bytes. Retain the raw scan evidence and explain
   bounded derived scans using the exact statement and input cardinality.
5. Run the identical workload after the owner fix. Report both measurements,
   baseline SHA, workload dimensions, units, validations, and coverage limits in
   the PR. Keep unchanged controls. Optimized branch budgets do not replace the
   original-main evidence; do not add an overwrite-only baseline updater.

## Interpret the measurements

- `total_changes` includes triggers and rolled-back changes. FTS segment merges
  can add changes without extra caller statements; use evidenced bounds when a
  merge cost varies. WAL commit markers represent committed transactions only.
- WAL bytes are SQLite file growth in a fresh, checkpoint-free generation,
  including its header. Frames describe SQLite output, not OS disk bytes or
  fsync calls. Recycled tails, generation changes, and checkpoints invalidate
  measurements and must never be reported as zero write cost.
- Statement counters observe statements prepared after attachment, including
  cached steps across commands. Native statements cached before attachment can
  escape those counters. The whole-window `total_changes` delta still includes
  their writes. Label this limit; do not claim statement counts cover every
  writer operation. Compare backend deltas with the connection delta when
  measuring a delegated backend.
- `expectSqliteQueryScans` checks raw `SCAN` plans, including index scans, with
  exact-query/detail/reason allowances. The existing
  `collectSqliteQueryPlanEvidence.fullTableScans` classification excludes indexed,
  virtual, and subquery scans, but can report derived CTE aliases. Neither API
  silently exempts tables named `input` or `metadata`.
  The collector also reports VM `OpenRead`/`OpenWrite` cursor counts. The
  transcript fixture qualifies its two derived scans only with zero persistent
  cursors, an exact canonical query hash, an actual constant-row plan, and
  admitted fixture JSON shape; changing the source to a physical table fails
  that qualification. Its two ordered tail lookups separately require exact
  canonical statement hashes, unchanged native expanded bindings (including the
  session and `LIMIT 1`), the actual indexed `SEARCH` plan with no sort, and
  same-connection input evidence: objects with at most six root members and
  1,024 bytes. Their `json_each` scans preserve native member types. These are
  synthetic campaign qualifications, never production query exemptions.
- Returned rows and text/blob bytes measure output, not visited rows or SQLite
  internal work. `LIMIT 1` alone does not bound traversal or JSON cardinality.
  History sweeps do not prove the absence of quadratic CPU or internal SQL work.

The transcript campaign runs real `AgentSession.prompt` requests through async
append/adoption and the admitted metadata writer. Its `input`/`metadata` scans
come from `transcript-payload.ts`'s two bound JSON values and one derived
navigation row; they are retained in the report. These cases do not prove
Gateway ingress, broadcaster/UI work, incognito persistence, or crash recovery.
The append-only fixture verifies durable transcript rows against the real
session manager, then reads the canonical navigation input expression (including
its `event_json` fallback) on the admitted connection outside measurement. All
rows used during the window survive in that diagnostic; a rewrite/delete
campaign would need input-shape evidence during execution instead.
