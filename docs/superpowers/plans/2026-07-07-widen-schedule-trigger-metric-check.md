# Widen `irrigation_schedules.trigger_metric` CHECK (issue #92) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the repo half of osi-os #92 — widen the `irrigation_schedules.trigger_metric` CHECK from `('SWT_WM1','SWT_WM2','SWT_AVG')` to the full live vocabulary `('SWT_WM1','SWT_WM2','SWT_AVG','SWT_1','SWT_2','SWT_3','DENDRO')` everywhere the repo defines schema, and fix the sync-contract drift the issue names.

**Architecture:** One `destructive`-class ordered migration (`database/migrations/ordered/0004__widen_schedule_trigger_metric_check.sql`) performs a fail-closed table rebuild using the **rename-old-first** pattern: drop the two schedule triggers, rename the live table aside, `CREATE TABLE irrigation_schedules` with DDL text byte-identical to `database/seed-blank.sql`, copy rows with a plain `INSERT` (a CHECK violation throws → the runner's transaction rolls back → table left intact), drop the old table, recreate both triggers verbatim from the seed. Rename-old-first matters because `scripts/verify-seed-replay.js` fingerprint-compares the **stored `sqlite_master` DDL text** of a migration replay against a fresh seed apply — renaming a `_new` table into place would mangle the stored text (SQLite rewrites/quotes it) and fail CI. The seed, all 7 bundled `farming.db` copies, and the hand-maintained consistency verifier are updated in the same commit. `docs/contracts/sync-schema/resources.schema.json` gets the two fixes issue #92 names (enum + `trigger_value` → `threshold_kpa`).

**Tech Stack:** SQLite (via `sqlite3` CLI for bundled DBs), Node.js verifier scripts, `lib/osi-migrate` runner (CI-time only), JSON Schema contracts.

## Global Constraints

- **Never modify** `database/migrations/ordered/0001__baseline.sql`, `0002__gateway_health.sql`, or `0003__stamp_contract_version_and_zone_op_split.sql` — merged migrations are SHA-256-checksummed (`CHECKSUMS.json`); editing one wedges every ledgered DB as `repair_required`.
- **Never touch** the Node-RED boot node `sync-init-fn` ("Sync Init Schema + Triggers") in either flows.json — it is FROZEN (AGENTS.md "Boot-DDL freeze"). It does **not** create `irrigation_schedules`, so it needs no change.
- **Never touch** `deploy.sh` or `scripts/repair-pi-schema.js` — live-gateway delivery is explicitly out of scope (see Non-goals).
- The migration file body contains **raw SQL statements only** — no `BEGIN`/`COMMIT`, no `PRAGMA foreign_keys`. For `-- risk: destructive` the runner wraps the body itself: `PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE; <sql>; <ledger>; COMMIT; PRAGMA foreign_keys=ON;` and refuses to run without `writersStopped: true` (`bootstrapFresh` passes it — so `verify-seed-replay.js` replays this migration fine).
- All 7 bundled `farming.db` copies must stay schema-identical to the seed, and `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db` must remain a **byte-for-byte copy** of the bcm2712 one (`verify-profile-parity.js`).
- New CHECK vocabulary is exactly the flows API `allowed` list (function node "Verify Zone Ownership"): `['SWT_WM1','SWT_WM2','SWT_AVG','SWT_1','SWT_2','SWT_3','DENDRO']`. Do **not** add `VWC` (it is typed in TS as "planned" but the API does not accept it — YAGNI).
- `web/react-gui/src/types/farming.ts` `TriggerMetric` already contains all 7 accepted values — **no TS change**; Task 3 only verifies this.
- Work on a feature branch (e.g. `fix/92-widen-schedule-trigger-metric-check`), commit per task, open a PR at the end, **do not merge it**.

## Non-goals (do not do these)

- **No live-gateway delivery.** The migration runner does not run on-device; destructive on-device delivery is the Option B Stage 1 project (issue #88). This PR fixes fresh installs + the durable schema record. Say so in the PR body.
- No Uganda CHECK verification (that is a live-ops maintenance-window task, issue #87/#92 rollout).
- No fix for the *other* contract drift you will notice in `Schedule` (`zone_id` integer vs live `zone_uuid` payloads, `irrigation_duration_min` vs live `duration_minutes`). Issue #92 names only the enum and `trigger_value`/`threshold_kpa`. Note the extra drift in the PR body as an observation, nothing more.
- No flows.json changes of any kind.

---

### Task 1: Migration 0004 + seed + all 7 bundled DBs + consistency-verifier pin

**Files:**
- Create: `database/migrations/ordered/0004__widen_schedule_trigger_metric_check.sql`
- Modify: `database/seed-blank.sql` (line ~152, the `trigger_metric` column line)
- Modify: `scripts/verify-db-schema-consistency.js` (two assertion sites, mirroring the existing `AQUASCOTE_LORAIN`-style devices-CHECK pattern at lines ~594-596 and ~641-645)
- Modify (binary, via sqlite3 CLI): all 7 bundled `farming.db` copies

**Interfaces:**
- Produces: the widened CHECK text `CHECK (trigger_metric IN ('SWT_WM1','SWT_WM2','SWT_AVG','SWT_1','SWT_2','SWT_3','DENDRO'))` — Task 2's contract enum and the PR body reference this exact 7-value set.

- [ ] **Step 1: Add the failing assertions to `scripts/verify-db-schema-consistency.js`**

In `verifyDb(...)`, directly **after** the existing devices-CHECK block:

```js
  if (!tableSql(dbPath, 'devices').includes("'AQUASCOPE_LORAIN'")) {
    throw new Error(`${dbPath}: devices.type_id CHECK is missing AQUASCOPE_LORAIN`);
  }
```

add:

```js
  const scheduleSql = tableSql(dbPath, 'irrigation_schedules');
  for (const metric of ["'SWT_1'", "'SWT_2'", "'SWT_3'", "'DENDRO'"]) {
    if (!scheduleSql.includes(metric)) {
      throw new Error(`${dbPath}: irrigation_schedules.trigger_metric CHECK is missing ${metric}`);
    }
  }
```

At the bottom of the file, directly **after** the existing seed-side devices check:

```js
if (!seedSql.includes("'AQUASCOPE_LORAIN'")) {
  throw new Error(`${path.relative(repoRoot, seedSqlPath)}: devices.type_id CHECK is missing AQUASCOPE_LORAIN`);
}
```

add:

```js
if (!seedSql.includes("CHECK (trigger_metric IN ('SWT_WM1','SWT_WM2','SWT_AVG','SWT_1','SWT_2','SWT_3','DENDRO'))")) {
  throw new Error(`${path.relative(repoRoot, seedSqlPath)}: irrigation_schedules.trigger_metric CHECK does not match the canonical 7-value vocabulary`);
}
```

- [ ] **Step 2: Run the verifier to confirm it fails (red)**

Run: `node scripts/verify-db-schema-consistency.js`
Expected: FAIL with `irrigation_schedules.trigger_metric CHECK does not match the canonical 7-value vocabulary` (seed check throws before any DB is verified).

- [ ] **Step 3: Widen the CHECK in `database/seed-blank.sql`**

Replace (exact current text, one line, ~line 152):

```sql
  trigger_metric      TEXT NOT NULL CHECK (trigger_metric IN ('SWT_WM1','SWT_WM2','SWT_AVG')),
```

with:

```sql
  trigger_metric      TEXT NOT NULL CHECK (trigger_metric IN ('SWT_WM1','SWT_WM2','SWT_AVG','SWT_1','SWT_2','SWT_3','DENDRO')),
```

- [ ] **Step 4: Confirm the remaining reds are exactly the expected ones**

Run: `node scripts/verify-db-schema-consistency.js`
Expected: FAIL, now on the **first bundled DB** (`...: irrigation_schedules.trigger_metric CHECK is missing 'SWT_1'`) — the seed-side check passes.

Run: `node scripts/verify-seed-replay.js`
Expected: FAIL with a fingerprint diff on `irrigation_schedules` (replaying 0001–0003 still produces the narrow CHECK; the seed is now wide).

- [ ] **Step 5: Write the migration `database/migrations/ordered/0004__widen_schedule_trigger_metric_check.sql`**

The `CREATE TABLE` block and both `CREATE TRIGGER` blocks below **must be byte-identical to the corresponding blocks in the updated `database/seed-blank.sql`** — the fingerprint comparison hashes stored DDL text. Build them by extraction, not retyping:

```bash
awk '/^CREATE TABLE irrigation_schedules \(/,/^\);/' database/seed-blank.sql
awk '/^CREATE TRIGGER trg_sync_schedules_defaults_ai/,/^END;/' database/seed-blank.sql
awk '/^CREATE TRIGGER trg_sync_schedules_outbox_au/,/^END;/' database/seed-blank.sql
```

Full file content (the three extracted blocks slot in where marked; the surrounding statements are verbatim):

```sql
-- risk: destructive
-- 0004: Widen irrigation_schedules.trigger_metric CHECK to the full live
-- vocabulary (osi-os issue #92). The flows API and GUI accept
-- SWT_1/2/3 and DENDRO since 2026-06-24/25 but the CHECK still carried the
-- original 3-value vocabulary, so every non-SWT_AVG schedule save fails
-- with a CHECK violation (HTTP 500).
--
-- SQLite cannot ALTER a CHECK in place, so this is a fail-closed table
-- rebuild. Pattern is rename-old-first: the replacement table is created
-- under its final name with DDL text byte-identical to seed-blank.sql, so
-- the stored sqlite_master text (which scripts/verify-seed-replay.js
-- fingerprint-compares against a fresh seed apply) stays pristine. Rows
-- are copied with a plain INSERT: any row violating the widened CHECK
-- throws and rolls back the whole migration (the runner wraps this file
-- in PRAGMA foreign_keys=OFF / BEGIN IMMEDIATE ... COMMIT /
-- PRAGMA foreign_keys=ON and requires writersStopped=true).
-- Both schedule triggers are dropped first (ALTER TABLE RENAME would
-- otherwise rewrite their bodies) and recreated verbatim from the seed.
-- No other trigger, view, or FK references irrigation_schedules.

DROP TRIGGER IF EXISTS trg_sync_schedules_defaults_ai;
DROP TRIGGER IF EXISTS trg_sync_schedules_outbox_au;

DROP TABLE IF EXISTS irrigation_schedules_old;

ALTER TABLE irrigation_schedules RENAME TO irrigation_schedules_old;

CREATE TABLE irrigation_schedules (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  irrigation_zone_id  INTEGER NOT NULL,
  trigger_metric      TEXT NOT NULL CHECK (trigger_metric IN ('SWT_WM1','SWT_WM2','SWT_AVG','SWT_1','SWT_2','SWT_3','DENDRO')),
  threshold_kpa       REAL NOT NULL,
  enabled             INTEGER NOT NULL DEFAULT 1,
  last_triggered_at   TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  duration_minutes    INTEGER,
  response_mode       TEXT,
  sync_version        INTEGER DEFAULT 0,
  deleted_at          DATETIME,
  last_applied_at     DATETIME,
  FOREIGN KEY (irrigation_zone_id) REFERENCES irrigation_zones(id) ON DELETE CASCADE,
  UNIQUE (irrigation_zone_id)
);

INSERT INTO irrigation_schedules (
  id, irrigation_zone_id, trigger_metric, threshold_kpa, enabled,
  last_triggered_at, created_at, updated_at, duration_minutes,
  response_mode, sync_version, deleted_at, last_applied_at
)
SELECT
  id, irrigation_zone_id, trigger_metric, threshold_kpa, enabled,
  last_triggered_at, created_at, updated_at, duration_minutes,
  response_mode, sync_version, deleted_at, last_applied_at
FROM irrigation_schedules_old;

DROP TABLE irrigation_schedules_old;

-- <verbatim seed block: CREATE TRIGGER trg_sync_schedules_defaults_ai ... END;>

-- <verbatim seed block: CREATE TRIGGER trg_sync_schedules_outbox_au ... END;>
```

Replace the two `-- <verbatim seed block: ...>` placeholder lines with the exact output of the two trigger `awk` extractions above (including their `END;` lines). The explicit INSERT column list (never `SELECT *`) is deliberate: live-Pi tables have historically drifted in column order, and this migration must stay correct when it is eventually delivered on-device via the Option B runner.

- [ ] **Step 6: Verify migration well-formedness and seed replay (green)**

Run: `node scripts/verify-migrations.js`
Expected: `verify-migrations: OK (4 migrations)`

Run: `node scripts/verify-seed-replay.js`
Expected: `verify-seed-replay: OK`

If seed-replay fails with a fingerprint diff on `irrigation_schedules` or either trigger, the migration's DDL text differs from the seed — diff the stored `sqlite_master.sql` texts and fix 0004 (the seed is the reference).

- [ ] **Step 7: Apply 0004 to the 7 bundled DBs (FK fence wrapped, mirror copied)**

The bundled DBs have no migration ledger; apply the raw file with the destructive-class fence added manually, exactly like the 0002 precedent but wrapped:

```bash
cd "$(git rev-parse --show-toplevel)" && for db in \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  database/farming.db \
  web/react-gui/farming.db
do { echo "PRAGMA foreign_keys=OFF;"; cat database/migrations/ordered/0004__widen_schedule_trigger_metric_check.sql; echo "PRAGMA foreign_keys=ON;"; } | sqlite3 -bail "$db" && echo "OK $db"; done \
  && cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  && echo "OK mirror copy"
```

Expected: `OK <path>` for all six, then `OK mirror copy`.

- [ ] **Step 8: Run the schema verifier set (green)**

```bash
node scripts/verify-db-schema-consistency.js
node scripts/verify-profile-parity.js
node scripts/verify-runtime-schema-parity.js
node --test lib/osi-migrate/__tests__/*.test.js
```

Expected: all 7 DB paths `OK` + `DB schema consistency verification passed`; `All parity checks passed.`; `verify-runtime-schema-parity: OK (2 flows: devices CHECK + trigger parity)`; all runner tests pass.

- [ ] **Step 9: Commit**

```bash
git add database/migrations/ordered/0004__widen_schedule_trigger_metric_check.sql \
        database/seed-blank.sql scripts/verify-db-schema-consistency.js \
        conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
        conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
        database/farming.db web/react-gui/farming.db
git commit -m "fix(schema): widen irrigation_schedules.trigger_metric CHECK to live vocabulary (#92)"
```

---

### Task 2: Sync-contract fix (`Schedule.trigger_metric` enum + `trigger_value` → `threshold_kpa`)

**Files:**
- Modify: `docs/contracts/sync-schema/resources.schema.json` (`definitions.Schedule.properties`)

**Interfaces:**
- Consumes: the 7-value vocabulary from Task 1.
- Produces: contract field name `threshold_kpa` (matches what the live outbox trigger emits in `payload_json`).

- [ ] **Step 1: Edit the Schedule definition**

In `docs/contracts/sync-schema/resources.schema.json`, `definitions.Schedule.properties`, replace:

```json
    "trigger_metric": {
      "type": "string",
      "enum": [
        "SWT_WM1",
        "SWT_WM2",
        "SWT_AVG",
        "DENDRO"
      ]
    },
    "trigger_value": {
      "type": "number"
    },
```

with:

```json
    "trigger_metric": {
      "type": "string",
      "enum": [
        "SWT_WM1",
        "SWT_WM2",
        "SWT_AVG",
        "SWT_1",
        "SWT_2",
        "SWT_3",
        "DENDRO"
      ]
    },
    "threshold_kpa": {
      "type": "number"
    },
```

The `required` array lists only `zone_id` and `trigger_metric` — leave it untouched.

- [ ] **Step 2: Check for other `trigger_value` consumers**

Run: `grep -rn "trigger_value" scripts/ docs/contracts/ web/react-gui/src/ lib/ --include="*.js" --include="*.json" --include="*.ts" --include="*.tsx"`
Expected: no hits outside the file just edited. If a fixture or verifier references the old field name, update it to `threshold_kpa` in this task and include it in the commit; if runtime code (flows, TS) references it, STOP and report — that would mean the drift runs deeper than issue #92 describes.

- [ ] **Step 3: Run the contract verifiers (green)**

```bash
node scripts/verify-sync-contract.js
node scripts/test-contract-schemas.js
```

Expected: both exit 0 with their normal OK output.

- [ ] **Step 4: Commit**

```bash
git add docs/contracts/sync-schema/resources.schema.json
git commit -m "fix(contract): Schedule.trigger_metric full vocabulary; rename trigger_value to threshold_kpa (#92)"
```

---

### Task 3: Full gate, TS verification, PR

**Files:**
- None modified (verification + PR only).

- [ ] **Step 1: Verify the TS union needs no change (read-only)**

Run: `sed -n '177,184p' web/react-gui/src/types/farming.ts`
Expected: `TriggerMetric` already contains `'SWT_WM1' | 'SWT_WM2' | 'SWT_AVG' | 'SWT_1' | 'SWT_2' | 'SWT_3' | 'VWC' | 'DENDRO'`. Do not edit it (`VWC` stays typed-but-not-accepted).

- [ ] **Step 2: Run the full verifier suite**

```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-profile-parity.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-devices-rebuild-fence.js
node --test scripts/rehearse-devices-rebuild.test.js
node --test lib/osi-migrate/__tests__/*.test.js
node scripts/verify-sync-contract.js
node scripts/test-contract-schemas.js
node scripts/verify-sync-flow.js
```

Expected: every script prints its OK line and exits 0 (`verify-sync-flow.js` ends with `Sync flow verification passed` and `All parity checks passed.`). Any RED is a real regression — fix before proceeding, do not rationalize.

- [ ] **Step 3: Frontend sanity (nothing should have changed, prove it)**

```bash
cd web/react-gui && npm run test:unit
```

Expected: PASS (no TS/GUI files were modified).

- [ ] **Step 4: Push branch and open the PR (do not merge)**

```bash
git push -u origin fix/92-widen-schedule-trigger-metric-check
gh pr create --title "fix(schema): widen irrigation_schedules.trigger_metric CHECK to live vocabulary (#92)" --body "<body per below>"
```

PR body must contain: (1) root cause (CHECK never widened when API/GUI moved to canonical metrics 2026-06-24/25); (2) scope statement — this is the **repo half** of #92: fresh installs + durable schema record + contract drift; **live-gateway delivery is deferred to the deploy-time runner work (issue #88)** and Uganda verification to #87; (3) the rename-old-first rationale (fingerprint DDL-text fidelity); (4) real verifier outputs (paste the OK lines from Task 3 Step 2); (5) observed-but-out-of-scope contract drift note (`zone_id` vs live `zone_uuid`, `irrigation_duration_min` vs live `duration_minutes`). Reference issue #92 with "Part of #92" (not "Fixes" — the issue stays open until live delivery).
