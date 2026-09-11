# Uganda schema reconciliation — table-rebuild rehearsal report (2026-09-11, addendum)

Continues `docs/operations/uganda-catchup-rehearsal-20260911-report.md` (PR #209, additive
catch-up artifact). This addendum covers the follow-on work: the data audit, the design
doc, the generated table-rebuild artifact, the updated window script, and full end-to-end
evidence — all against **local byte-copies only**. No SSH. No live DB touched.

Branch: `ops/uganda-schema-reconciliation-20260911`, stacked on `origin/ops/uganda-catchup-rehearsal-20260911` (PR #209, not yet merged).
Design doc: `docs/superpowers/specs/2026-09-11-uganda-schema-reconciliation-design.md`.
Raw evidence files referenced below (numbered logs, JSON) live under
`/home/phil/osi-backups/uganda-rehearsal-20260911/rebuild/` on the workstation that ran
this rehearsal — local-only, not committed to this repo (consistent with the original
rehearsal's evidence index).

## Input, re-verified

- `/home/phil/osi-backups/uganda-farming-20260910T225932Z.db.gz`
- sha256 `0f131395c6dfb02d16ea770c7ab20e4b23615c6ea3311c9e1802b398abee4460` — verified at the
  start of this work and again after every decompress; **never modified**.
- Every decompressed working copy's sha256: `04b75d9688c093ebf3bbab52765d72a1ad21938bc94c06f763b0cf14ecb2136d`
  (matches the original rehearsal's pristine-copy hash throughout).

## 1. Data audit

`scripts/ops/uganda-schema-audit.js` — read-only (enforced by a hard sha256-before/after
assertion inside the script, not just a docstring claim). Full output: `13-schema-audit.json`
in this directory (run against a fresh pristine decompress). Summary:

| Table | Rows | Key finding |
|---|---|---|
| `device_data` | 69,686 | 0 orphans vs `devices.deveui` |
| `devices` | 4 | `chameleon_enabled` diff is **nullability** (`notnull` 1 vs 0), not a default-value diff as the earlier report's paraphrase said — both sides default `0`. `type_id` distribution: `KIWI_SENSOR`×3, `STREGA_VALVE`×1 — 0 rows outside the canonical 6-member CHECK set. |
| `irrigation_events` | 75 | `event_uuid` genuinely absent; all 75 rows would get `NULL` (correct — no retroactive backfill; see design doc §3.3) |
| `valve_actuation_expectations` | 34 | 0 rows NULL in `created_at`/`volume_source` — both already have real values, losing the DB-side default is safe |
| `zone_irrigation_calibration` | 1 | 0 NULLs across all 5 columns going `NOT NULL` |
| `zone_weather_cache` | 0 | 0 orphans, 0 NULLs — every risk here is currently zero-risk in practice; guards still preflight it live at run time regardless |

Exactly **17** in-scope failing diffs (confirmed independently via
`semantic-schema-compare.js` against a freshly-built reference(1), both before and after
generator fixes) — matches the original rehearsal's count precisely.

## 2. Design doc

`docs/superpowers/specs/2026-09-11-uganda-schema-reconciliation-design.md`. Per-table
canonical DDL (quoted verbatim from `0001__baseline.sql`), column mapping, the
`fetched_at <- created_at` mapping decision for `zone_weather_cache` (with a refuse-if-
`updated_at`-diverges guard so real drift is never silently discarded), the FK-fence
ordering rationale (devices has 5 FK-cascade children — `device_data`, `dendrometer_readings`,
`dendro_baselines`, `weather_station_zones`, `chameleon_readings`), the
`PRAGMA legacy_alter_table=ON` requirement (found empirically while building the test
fixture — see §4), disk headroom (~108 MB worst case vs 3.3 GB free), and the
refuse-and-hold orphan-handling policy (recommended over quarantine, since every audited
count is currently zero).

## 3. The generated table-rebuild artifact

- Generator: `scripts/ops/generate-uganda-schema-rebuild-20260911.js`
- Artifact: `scripts/ops/uganda-schema-rebuild-20260911.sql` (generated, never hand-edited)
- `--apply`: preflights the exact drift signature (scoped to the 6 tables only — see the
  bug fix below), skips any already-canonical table, preflights orphan/NULL/drift data
  guards per table, runs the batched DDL under `PRAGMA foreign_keys=OFF` +
  `PRAGMA legacy_alter_table=ON` held across the whole transaction, then
  `integrity_check` + `foreign_key_check`.
- `--dry-run`, `--verify` also provided.

### Bugs found and fixed during TDD (not by hand-inspection)

1. **Missing indexes.** The `valve_actuation_expectations` rebuild block dropped its 3
   indexes and never recreated them. Caught by a fast schema-diff repro script, not by the
   test suite's own `verify()` call — because of bug 2.
2. **`verify()`'s table-scoping blind spot.** Index/trigger diff names carry no table
   prefix (`idx_valve_act_exp_active`, not `valve_actuation_expectations.idx_...`), so the
   original `name.split('.')[0]` scoping filter silently excluded them from `verify()`'s
   own failure check — `verify()` reported PASS with 3 real indexes missing. Fixed by
   deriving the table-scoping name set dynamically from reference(1)'s `sqlite_master`
   instead of guessing from the diff string.
3. **Drift-signature guard too strict for the real window-script sequence.** Running the
   *actual* window script (not just the library calls) against a fresh real Uganda copy
   found that `generate-uganda-schema-rebuild-20260911.js --apply` refused unconditionally,
   because at that point in the sequence (catch-up artifact → **rebuild artifact** →
   `repair-sync-outbox-v2.js`) `sync_outbox` still had its 3 missing v2 columns — a real,
   expected, in-flight diff outside this artifact's 6-table scope, but the original
   `preflightDriftSignature` flagged ANY failing diff anywhere in the database. Fixed the
   same way as bug 2: scope to the 6 tables (+ their reference(1)-derived index/trigger
   names) only. Re-verified end-to-end after the fix (§6).
4. **`PRAGMA legacy_alter_table` requirement.** Building the first test fixture hit
   `error in trigger trg_dp_device_data_outbox_ai: no such table: main.devices` when
   renaming `devices_rebuild_20260911` back to `devices`, even with
   `PRAGMA foreign_keys=OFF`. Root cause: modern SQLite's `ALTER TABLE RENAME` eagerly
   re-validates every other schema object mentioning the renamed table's name; this
   re-validation transiently fails, unrelated to FK enforcement.
   `PRAGMA legacy_alter_table=ON` (held across the same transaction, restored `OFF`
   afterward — same pairing the sanctioned `sync-init-fn` devices rebuild already uses)
   fixes it. Documented in the design doc and the generator's header comment.

## 4. Window script

`scripts/ops/uganda-catchup-window.sh` updated: the rebuild artifact now runs between the
additive catch-up artifact and `repair-sync-outbox-v2.js` (per the brief's ordering),
guarded by its own preflights, with `integrity_check`/`foreign_key_check` immediately
after. The 3 rebuild-only tables were added to the row-count invariant list. Fail-closed
behavior and ash/BusyBox compatibility (`sh -n` clean) preserved.

## 5. Test evidence

`scripts/ops/uganda-schema-audit.test.js` — 6/6 pass (read-only invariant, clean-DB
zero-diff case, drifted-fixture NULL/orphan/mapping numbers, and the `diffTable`
index-scoping regression).

`scripts/ops/generate-uganda-schema-rebuild-20260911.test.js` — all subtests pass:
- `generate()` emits verbatim per-table blocks, no ad hoc DDL.
- `preflightDriftSignature` accepts the audited 17-diff fixture; refuses drift *on one of
  the 6 tables* that isn't one of the 17; does NOT refuse on drift *outside* the 6 tables
  (regression for bug 3 above).
- `preflightTableData` refuses on planted orphans/NULLs; passes on clean data.
- `apply()` rebuilds the drifted fixture to a clean reference(1) match, is idempotent
  (second `apply()` call: `ran: []`), preserves row counts, correctly recreates all 3
  `valve_actuation_expectations` indexes (regression for bug 1/2 above).
- The full end-to-end subtest (fixture → catch-up → rebuild → `repair-sync-outbox-v2` →
  `baseline-existing-db` stamps N=1 → `migrate-cli` reaches head → `verify-head` ok) was
  **verified phase-by-phase as separate foreground commands** rather than as one ~15-minute
  `node:test` subtest (each phase's cost is dominated by `baseline-existing-db.js`'s
  O(head) reference-chain scan and `migrate-cli.js`'s full replay, not test-framework
  overhead — see the original rehearsal report's own note on this cost class):
  - Phase A (fixture + catch-up + rebuild): < 1 s.
  - Phase B (`baseline-existing-db.js`, full N=53..1 scan): `matched: 1`, 573.7 s.
  - Phase C (`migrate-cli.js` to head): applied [2..53], ~86-115 s (partial progress from
    an earlier interrupted attempt was correctly resumed — the runner's per-migration
    fingerprint stamping means a killed run leaves a consistent, resumable state).
  - Phase D (`verify-head-cli.js`, `integrity_check`, `foreign_key_check`, row-count
    invariants): all green, all row counts identical before/after.
- A dedicated refuse-and-hold proof: planting an orphan `device_data` row with a dropped
  FK declaration causes `apply()` to throw *before running any DDL* — sha256 of the DB
  file is provably identical before and after the refusal, and the orphan row is
  untouched. No partial apply is possible: the per-table preflight loop throws before the
  batched DDL transaction is ever assembled.

## 6. Full end-to-end rehearsal on the REAL Uganda byte-copy

This is the headline result. Run against a **fresh decompress of the real Uganda backup**
(sha256 `04b75d9688c093ebf3bbab52765d72a1ad21938bc94c06f763b0cf14ecb2136d`), local only:

```
$ node scripts/ops/generate-uganda-catchup-20260911.js --apply <copy>
[uganda-catchup] applied uganda-catchup-20260911.sql to <copy>; integrity_check ok

$ node scripts/repair-sync-outbox-v2.js <copy>
[repair-sync-outbox-v2] added: rejected_at, rejection_reason, last_retryable_failure_at

$ node scripts/ops/generate-uganda-schema-rebuild-20260911.js --apply <copy>
[uganda-rebuild] applied: devices, device_data, irrigation_events, valve_actuation_expectations,
  zone_irrigation_calibration, zone_weather_cache; integrity_check ok; foreign_key_check ok

$ node scripts/ops/generate-uganda-schema-rebuild-20260911.js --verify <copy>
[uganda-rebuild] --verify PASSED: all 6 tables match reference(1).
```

**`baseline-existing-db.js` stamps N=1** (full log: `14-baseline-post-rebuild.log`):

```
[baseline] N=2: FAIL (5 failing: ...)
[baseline] N=1: PASS (tolerated: extra_allowlisted:column:chameleon_readings.swt_1/2/3)
[baseline] stamped versions 1..1 (checksums from CHECKSUMS.json, app_version='baseline-existing-db')
```

**G4 is GREEN.** This is the direct answer to the original rehearsal's open question: the
17 residual, non-additive diffs are now reconciled and the ledger baseline succeeds.

**`migrate-cli.js` reaches head** (full log: `15-migrate-cli-post-rebuild.log`):

```
[migrate] persistent pre-migration backup: <path> (fsync'd, integrity ok)
[migrate] applied: [2,3,4,...,53]
```

Postflight on the same copy:

| Check | Result |
|---|---|
| `PRAGMA integrity_check` | `ok` |
| `PRAGMA foreign_key_check` | 0 rows |
| `verify-head-cli.js` | `{"ok":true}` |

Row counts, before (pristine) → after (full pipeline to head):

| Table | Before | After |
|---|---|---|
| `device_data` | 69,686 | 69,686 |
| `devices` | 4 | 4 |
| `irrigation_events` | 75 | 75 |
| `valve_actuation_expectations` | 34 | 34 |
| `zone_irrigation_calibration` | 1 | 1 |
| `zone_weather_cache` | 0 | 0 |
| `users` | 1 | 1 |
| `irrigation_zones` | 3 | 3 |
| `sync_outbox` | 15,732 | 15,733 (+1 — a trigger-driven insert during migrate-to-head; not a violation, same class the original rehearsal already documented for the additive artifact) |

**Every history-bearing table's row count is identical before and after the entire
pipeline** (additive catch-up → table-rebuild → `repair-sync-outbox-v2` →
`baseline-existing-db` → `migrate-cli` to head).

### The actual on-device window script, run end-to-end (stubbed Node-RED, local only)

Full log: `16-window-script-dryrun-post-rebuild.log`. Run against ANOTHER fresh
decompress of the real backup, `UGANDA_CATCHUP_STUB_NODE_RED=1`:

```
=== Uganda catch-up + baseline + migrate-to-head window starting ===
--- pre-window row-count snapshot ---   [69686, 75, 4, 1, ... matches above]
--- stop Node-RED ---                    STUB
--- on-device backup ---                 ok, integrity_check ok
--- apply catch-up artifact ---
--- apply table-rebuild artifact ---     applied: devices, device_data, irrigation_events,
                                          valve_actuation_expectations, zone_irrigation_calibration,
                                          zone_weather_cache; integrity_check ok; foreign_key_check ok
--- repair-sync-outbox-v2 ---            added: rejected_at, rejection_reason, last_retryable_failure_at
--- baseline-existing-db ---             [... N=53..2 FAIL ...] N=1: PASS; stamped 1..1
--- migrate-cli ---                      applied: [2..53]
--- postflight: integrity_check ---      ok
--- postflight: foreign_key_check ---    0 violations
--- postflight: verify-head ---          {"ok":true}
--- postflight: row-count invariants --- every table ok (identical); analysis_views ABSENT->0 (new table, expected)
FINAL: OK: catch-up + baseline + migrate-to-head all green; postflight all-green; row counts identical (rc=0)
trap: Node-RED restarted OK
```

**Exit code 0.** This is the single most important proof: the on-device window script
itself — not just the underlying library calls — runs the ENTIRE recovery sequence
against a byte-faithful copy of the real Uganda gateway database and reaches a fully
green, verified state, with Node-RED correctly restarted on the trap. (An earlier run of
this same script, before the drift-signature scoping fix in §3 bug 3, correctly and
safely REFUSED at the rebuild-artifact step and restarted Node-RED — proving the
fail-closed path works too, before the fix made the happy path also work.)

## 7. Restore path

Two distinct restore/rollback mechanisms are in play, both proven:

1. **Refuse-and-hold (this artifact's own safety net).** Proven in §5: any precondition
   failure — drift-signature mismatch or a data guard (orphan/NULL) — throws BEFORE any
   DDL runs. Byte image is provably unchanged (sha256 identical). No partial apply is
   architecturally possible.
2. **`migrate-cli.js`'s byte-image restore (pre-existing, reused unmodified).** Already
   proven end-to-end in the original rehearsal's "Restore-path + migrate-cli mechanics"
   section (fixture-based: broken migration injected, backup taken, restore verified,
   `code=1, restored=true`). Not re-proven here since this PR does not touch
   `migrate-cli.js` or `lib/osi-migrate`; the window script's on-device `.backup` (taken
   BEFORE either artifact runs, integrity-checked) is the operator's manual-restore
   fallback if a later step fails after the rebuild artifact has already committed.

## 8. Verification suite (foreground, current branch)

Full commands and results:

```
node scripts/verify-migrations.js               -> OK (53 migrations, checksum manifest OK, base immutability OK)
node scripts/verify-seed-replay.js               -> OK
node scripts/verify-no-stray-ddl.js              -> OK (HEAD total 702 <= origin/main total 702)
node scripts/verify-runtime-schema-parity.js     -> OK (2 flows: devices CHECK + runtime trigger parity)
node scripts/verify-db-schema-consistency.js     -> OK (all 7 bundled DBs); DB schema consistency verification passed
node scripts/verify-sync-flow.js                 -> All parity checks passed.
node scripts/verify-boot-ddl-interpolation.js    -> OK (both flows.json variants)
node scripts/verify-devices-rebuild-fence.js     -> OK (2 flows)
node --test lib/osi-migrate/__tests__/*.test.js  -> # tests 96, # pass 96, # fail 0
node scripts/verify-dendro-contract-mirror.js /home/phil/Repos/osi-server
                                                  -> Dendro contract mirror matches osi-os source fixtures
```

All green. Expected: this PR adds only new standalone `scripts/ops/*` files and a
`scripts/ops/uganda-catchup-window.sh` edit — it touches **no** ordered migration,
`seed-blank.sql`, bundled `farming.db` copy, `flows.json`, or `lib/osi-migrate` file, so
every schema-parity/CI gate above runs unchanged from `main`.

## 9. Outbox census / schema-change-control constraints

- No new ordered migration; no change to `lib/osi-migrate`, `database/migrations/ordered/`,
  `database/seed-blank.sql`, or `CHECKSUMS.json`.
- `sync_outbox` census unaffected: the rebuild artifact never touches `sync_outbox`; the
  +1 row observed in §6 is from an ordinary trigger firing during `migrate-cli`'s replay
  of already-existing migrations, not from anything this PR adds.

## 10. Summary / next steps

- **Deliverables (this branch, stacked on PR #209):** data audit script + tests, design
  doc, generated table-rebuild artifact + generator + tests, updated window script, this
  report. All committed; PR opened, **not merged**.
- **G4 is now GREEN** on a local byte-copy of the real Uganda backup — the direct
  resolution of the original rehearsal's open finding.
- **Before running this on the real device:** this PR needs the senior adversarial review
  the design doc was explicitly written for. Every irreversible step (the two table
  rebuilds under `PRAGMA foreign_keys=OFF` + `legacy_alter_table=ON`) is documented with
  its guard, its data preflight, and its evidence above.
- G1-G3 and G5 remain untouched by this local-only work (unchanged from PR #209's scope).
