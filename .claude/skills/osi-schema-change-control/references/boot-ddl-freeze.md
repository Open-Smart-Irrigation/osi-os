# Boot-DDL freeze

Part of the osi-schema-change-control skill; read SKILL.md first.

## Boot-DDL freeze (the other schema path, and why it's frozen)

The Node-RED node **"Sync Init Schema + Triggers"** (node id `sync-init-fn`,
present byte-identically in both
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` and the
`bcm2709` mirror) performs inline DDL on every boot: verified count is **93**
`ADD COLUMN` statements in the function body, the large majority idempotent
against a schema that already has the column (errors from these are swallowed in
a `try {...} catch (_) {}` sweep). This node is **FROZEN**: do not add new schema
behavior to it. New schema changes go through the ordered-migration runner's
files and the deploy-time runner path. That freeze is the reason the migration
runner cutover stays tractable.

### Incident history (one line each, factual)

- **PR #79** restored the `devices.type_id` CHECK list plus a runtime↔seed parity
  guard after the boot rebuild had silently recreated `devices` with the CHECK
  missing `AQUASCOPE_LORAIN` on every restart (fixed in `a646efe3`).
- **Issue #84 / "duplicate column" verifier failures**: recurring `duplicate
  column` errors were, in writing, blamed on the boot DDL node. The real root
  cause was a stale upgrade-test baseline — the misattribution itself had to be
  corrected (`docs/superpowers/plans/2026-07-04-fix-history-schema-upgrade-baseline.md`).
  Lesson embedded in the playbook (`docs/engineering-playbook.md` §6): "a signal
  that pattern-matches a known failure may have a different cause."
- **PR #86 (2026-07)** shipped the guarded, fail-closed `devices` table rebuild —
  the one sanctioned exception to the freeze, because it is a safety fix rather
  than new schema behavior. Details below.

### The sanctioned exception: guarded fail-closed `devices` rebuild

Verified directly in `sync-init-fn`'s function body (both flows files, byte
identical). The rebuild:

1. Reads the live `devices` table's CHECK clause and extracts the current
   `type_id` set with a regex.
2. Compares it by **set equality** against the canonical types —
   `KIWI_SENSOR`, `STREGA_VALVE`, `DRAGINO_LSN50`, `TEKTELIC_CLOVER`,
   `SENSECAP_S2120`, `AQUASCOPE_LORAIN`, `MILESIGHT_UC512` (named `REQUIRED_TYPES` in the code). If
   the live set is missing a type *or* has an extra/drifted type, `needsRebuild`
   is true — this is stricter than "missing-only," which was a P2 review finding
   fixed before merge (an extra drifted type must also trigger convergence, not
   just an omission).
3. Only if a rebuild is needed: `PRAGMA foreign_keys=OFF`, then inside
   `_db.transaction(...)` — one `operationQueue` slot, `BEGIN IMMEDIATE`,
   auto-`ROLLBACK` on any throw — it drops any stale `devices_new` left from a
   prior crash, creates `devices_new` with the corrected CHECK, copies rows with
   a **plain `INSERT`** (not `INSERT OR IGNORE`), drops `devices_old` if present,
   renames `devices`→`devices_old`→drop, renames `devices_new`→`devices`, and
   recreates the four `devices` indexes. Because the copy is a plain `INSERT`,
   any row that violates the new CHECK throws inside the transaction and rolls
   back the whole rebuild — `devices` is left untouched, not silently missing
   rows. This replaces the old `INSERT OR IGNORE` behavior, exactly the class of
   bug that caused the AQUASCOPE_LORAIN regression above.
4. `PRAGMA foreign_keys=ON` (and `legacy_alter_table=OFF`) are restored in a
   `finally` block that guards each restore independently, so one failing
   restore can't skip the other, on **every** exit path including a caught
   rebuild error. Errors are surfaced via `node.error('devices rebuild ABORTED
   (devices left intact): ' + e.message)` — never swallowed silently, unlike the
   ~93 ADD COLUMN sweep above it in the same function.

**FK fence rationale:** rebuilding a parent table via a drop/rename swap without
`PRAGMA foreign_keys=OFF` held across the swap lets `ON DELETE CASCADE` on child
tables (`device_data`, `chameleon_readings`) fire the moment the old `devices` is
dropped, silently wiping those child rows. This is the documented cause of a real
field history-loss incident (`docs/operations/edge-history-retention.md`); the
fence is what prevents it from recurring.

### Merge gate for any further touch to this block

If you touch the guarded `devices` rebuild block, rerun this gate set in the
current branch and paste fresh output:

```
node scripts/verify-runtime-schema-parity.js     # OK (2 flows: devices CHECK + trigger parity)
node scripts/verify-profile-parity.js            # All parity checks passed.
node scripts/verify-devices-rebuild-fence.js     # OK (2 flows)
node --test scripts/rehearse-devices-rebuild.test.js   # 4/4 pass
```

`rehearse-devices-rebuild.js` executes the **actual shipped function text**
(via `new Function('osiDb','env','node','msg', funcText())`) against a
facade-compatible shim over Node's built-in `node:sqlite` (`DatabaseSync`) — a
real engine, not a fake — across four seeded cases: `healthy` (guard must skip,
rows preserved), `would-drop` (a row the new CHECK would reject must never be
silently dropped, and the abort must be surfaced), `legit-upgrade` (rebuild
succeeds, CHECK gains `AQUASCOPE_LORAIN`), and `extra-type` (a drifted extra type
with no offending rows must still trigger a rebuild that converges the CHECK back
to exactly the canonical types). `verify-devices-rebuild-fence.js` statically
greps both flows files for the fail-closed shape: no `INSERT OR IGNORE INTO
devices_new`, rebuild inside `_db.transaction(`, guarded by
`REQUIRED_TYPES`/`needsRebuild`, `finally` before `foreign_keys=ON`, a
`DROP TABLE IF EXISTS devices_new` pre-clean, and — a Node-RED-specific
deadlock hazard — no `_db.*` calls (only `t.*`) inside the transaction executor
(a facade-level `_db.*` call from inside an open transaction deadlocks on-device,
a separate `operationQueue` slot waiting on the in-flight transaction).

Three of the four are wired into `.github/workflows/migrations.yml`
(`verify-runtime-schema-parity.js`, `verify-devices-rebuild-fence.js`, and the
rehearse test); `verify-profile-parity.js` is CI-gated via the
`verify-sync-flow.yml` workflow (chained from `verify-sync-flow.js`). A
production-copy rehearsal is additionally expected before rollout to a live
gateway (see `osi-live-ops-runbook` for the actual on-Pi procedure).

**Additional gate:** `scripts/verify-sync-flow.js` is CI-gated by its own
workflow, `.github/workflows/verify-sync-flow.yml` — separate from
`migrations.yml`. It chains `verify-db-schema-consistency.js` and
`verify-profile-parity.js`: a full run prints `Sync flow verification passed`
at the end of the sync section and terminates with `All parity checks passed.`.
Do not rely on historical baseline notes; rerun it in the branch you are
changing and treat a RED result as a real regression until proven otherwise.
