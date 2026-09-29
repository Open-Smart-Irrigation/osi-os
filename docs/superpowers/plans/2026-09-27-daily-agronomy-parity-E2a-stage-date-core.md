# Daily Agronomy Parity E2a: Stage Start Date Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A zone carries the date its current growth stage started. The edge stores it (migration 0064), emits it in every zone sync event, accepts it from the zone route and from both cloud command paths, sets it on a stage change that carries no date (the stage-date default), advertises `zone_config_stage_started_on_v1`, freezes it with the Kc curve fields into each daily agronomy row, and resolves today's and the forecast days' Kc through the FAO-56 curve. The GUI (the date field and the Water tab lines) is plan E2b.

**Architecture:** 0064 adds four columns and replaces the boot-owned zone update trigger through `scripts/sync-trigger-source.json` and its generator, the route sub-project 3 used for 0063. Six flow nodes and the legacy "Build UPDATE SQL" node change by one-shot scripts with the roundtrip guard; `osi-zone-commands` gains the optional field on the protected `UPSERT_ZONE` and the stage-date rules on the Terra path. Two stage-date rules apply on every server write path that takes a stage: a change to unset clears the date (controller ruling cloud/sync I7), and a change to a different set stage without a date sets the zone-local today (controller ruling plan review E2 I2). The flow nodes express both inside their `UPDATE` (a `CASE` on the stored stage), so neither reads the row first. `osi-agronomy-daily` and `osi-zone-env` pass the date and the row's or forecast day's date to `resolveKc` (contract v2, plan E1).

**Tech Stack:** Node.js 22 (`node:test`, `node:sqlite`), SQLite through the `osi-db-helper` facade, Node-RED function nodes edited by one-shot scripts, the `osi-migrate` runner, JSON Schema draft-07 (`test-contract-schemas.js`).

**Spec:** `docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md` (B2, B4 Kc part and new columns, B5 without the GUI bullet, B7, E row "E2"; the Kc rule is A5; the stage-date default is the Decisions row "Start date on a server-side stage change").

**Controller step before Task 1 (the controller runs it, not the implementer):** this plan was first written against sub-project 3's plan text, not its code (plan review chair I1), and was re-anchored on the finished sub-project 3 on 2026-09-28. Before Task 1 the controller:

1. rebases `feat/daily-agronomy-parity` onto the finished sub-project 3 head. **Done:** the branch head 3a918101c sits on `feat/weather-data-view` 719c4ce29 (sub-project 3 with its final fix wave), and plan E1 is implemented on it; rebased again on 2026-09-29 onto `feat/weather-data-view`'s new head `24a3cd9f5` (a text-hygiene pass and the `verify-sync-op-parity.js` `CASE`-payload fix, both on sub-project 3), which is why Task 1 Step 2 no longer carries that verifier change;
2. re-runs plan E1's gates (E1 Task 5 Step 5) on the rebased branch;
3. re-measures, as a check, every number below that comes from sub-project 3's output; the re-anchoring measured them on 3a918101c, and a later rebase (onto main once sub-project 3 merges, or a moved `origin/main`) moves them: the total 8445, the carried node deltas (`sync-init-fn` 1394, `zone-config-fn` 737, `get-zones-query` 19, `get-zones-response` 337, `sync-bootstrap-build` 150, `sync-force-build` 150, `al-link-build-req` 33, `4f4a765f36cee6f3` 1487), `origin/main` 1580418, the `verify-live-gateway-identity.js` pins sub-project 3 left (`expectedGrowth` 150/150/33 and the total 8445), and the test counts of `test-zone-command-path.js` (12), `test-terra-selection-edge-acceptance.js` (21), `test-zone-update-sync-version.js` (7) and `test-terra-zone-config-command-flow.js` (6). Every one-shot, count and ratchet number of Tasks 1 to 5 below was measured by running this plan in plan order on a scratch copy of 3a918101c; if one of the numbers above differs, re-run the ratchet scripts and pin what they print;
4. greps the anchors the one-shots swap in sub-project 3's code, each of which must match once in its node or file: in `zone-config-fn` `const weatherSourceInput = b.weatherSource !== undefined ? b.weatherSource : b.weather_source;`, `notes,weather_source FROM irrigation_zones WHERE id=` and `weather_source:z.weather_source || 'auto',weather_source_default:weatherSourceDefault`; in both snapshot builders `iz.notes, iz.weather_source, iz.sync_version` and `} : {}), notes: z.notes, sync_version: z.sync_version,` (the end of the conditional `weather_source` spread); in the three capability builders `'entity_name_commands_v1', 'zone_config_weather_source_v1'];`; in `4f4a765f36cee6f3` `var conflictWeatherSource = zoneWeatherSource === null ?` and `s(zoneWeatherSource || 'auto') + " FROM users WHERE "`; in `scripts/sync-trigger-source.json` 0063's `CASE WHEN COALESCE(NEW.weather_source,'auto') <> 'auto' OR OLD.weather_source IS NOT NEW.weather_source THEN json_patch(`; and the `osi-zone-commands` strings of Task 3 Step 4. Every one-shot below aborts on a count other than 1, so a drift stops the run instead of corrupting a node.

**Prerequisites (check before Task 1):**

1. Sub-project 3 (`docs/superpowers/plans/2026-09-27-weather-data-view.md`) is implemented on this branch's base, Tasks 5 to 8 and its final fix wave in particular: migration 0063 exists, `scripts/sync-trigger-source.json`'s `trg_sync_zones_outbox_au` carries `weather_source` under its rule (`CASE WHEN COALESCE(NEW.weather_source,'auto') <> 'auto' OR OLD.weather_source IS NOT NEW.weather_source THEN json_patch(…, json_object('weather_source', COALESCE(NEW.weather_source,'auto'))) ELSE json_object(…) END`), `zone-config-fn`, `get-zones-*`, both snapshot builders (a conditional spread) and "Build UPDATE SQL" handle `weather_source`, the three capability builders end `'entity_name_commands_v1', 'zone_config_weather_source_v1'];`, `osi-zone-commands` has the optional `weather_source`, and `resources.schema.json` Zone has `weather_source`. Check: `ls database/migrations/ordered/0063__zone_weather_source_sync.sql && grep -c "zone_config_weather_source_v1" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` prints the file name and `3`.
2. Plan E1 is done: `node -e "console.log(require('./docs/contracts/agronomy/crop-kc.json').version)"` prints `2` and `osi-crop-kc` exports `stageLengths` and `kcRamp`.
3. No cloud checkout is needed. The cross-repo checks of Task 6 read the paired osi-server worktree and state what they expect with and without plan CC1 there.
4. If the RAK branch's migration 0060 lands on main first, sub-project 1's 0060-0063 are renumbered and 0064 moves up with them (spec B constraints); rename the file and every "0064" below together.

## Global Constraints

From the spec (B, "Constraints that hold for every item"), verbatim:

- "flows.json changes only through a `scripts/migrate-flows-*.js` script, applied to both profiles (bcm2712 and the bcm2709 mirror)" (this repository's practice, which sub-projects 2 and 3 followed: a one-shot script in the scratchpad with the roundtrip guard, never committed; the `sync-init-fn` region only through the generator).
- "schema only through ordered migrations, never in flows or `deploy.sh`, and never in the frozen `sync-init-fn`".
- "a boot-node trigger body changes only in `scripts/sync-trigger-source.json` and through `node scripts/generate-sync-trigger-source.js --write`".
- "bundled seeds rebuilt with `node scripts/build-seed-db.js` (seven DBs)".
- "the flows size ratchet gets a measured allowance for every node that grows, and `scripts/verify-live-gateway-identity.js` `expectedGrowth` is re-pinned for `sync-bootstrap-build`, `sync-force-build` and `al-link-build-req` when they grow".
- "the migrate-runner pin in `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js` lists 64 and 65" (E2a adds 64, E4 adds 65).
- B2: "`trg_sync_zones_outbox_au` stays owned by the boot node … The migration-owned lists (`MIGRATION_OWNED_TRIGGERS` in `verify-runtime-schema-parity.js`, `MIGRATION_OWNED_TRIGGER_NAMES` in `verify-trigger-body-parity.js`) do not gain it." "`trg_sync_zones_outbox_ai` (0046) is not redefined: a new zone has no start date."
- B5: "`zone-config-fn` … The column comes from 0064 only; no inline `ALTER` is added (`verify-no-stray-ddl`)." "Terra `UPSERT_ZONE_CONFIG`: the exact field list is unchanged."
- B5 clearing rule (controller ruling cloud/sync I7): "a request whose stage normalises to unset while the stored stage normalises to a stage also sets `stage_started_on = NULL`, whatever it says about the date; any other request leaves the date alone unless it carries the key."
- Stage-date default (controller ruling plan review E2 I2, spec Decisions): "When a request changes `phenological_stage` to a different set stage and carries no `stage_started_on`, the server sets the date to the change date (the zone-local today). A stage that becomes unset clears the date, an unchanged stage keeps it, and a supplied date always wins." It applies to `zone-config-fn`, "Build UPDATE SQL" (legacy `UPSERT_ZONE_CONFIG` and the flat `UPSERT_ZONE`) and the Terra path. "Set" and "same" follow `osi-crop-kc` `normalizeStage` (`veraison` stored and `mid_season` requested is the same stage). The zone-local today uses the request's `timezone` when it carries one, else the stored one (the legacy node, which cannot read the row, uses the command's timezone, else UTC), and UTC for an unknown zone id, as `osi-agronomy-daily` reads it.
- Rows freeze: "a row with a non-null `kc` keeps its snapshot; backfilled days follow the same rule, ruling R10".

Operational rules:

- Work only in `<osi-os>/.worktrees/daily-agronomy-parity`; every command runs from its root unless a step says otherwise. Never `cd` into `<osi-os>` or `<osi-server>`. Never bare `git stash`. Never push. Commits use `git -c user.name=Project-OSI commit`.
- `$SCRATCH` is the session scratchpad; one-shot scripts live there and are never committed.
- Every file changed under `conf/full_raspberrypi_bcm27xx_bcm2712/files/` is mirrored byte for byte under `bcm2709`.
- Every "Expected: `# pass N`", size and hash below is what the plan's own simulation printed. The runner's output is the authority: pin the count the runner prints, and pin the numbers the ratchet scripts print (plan review chair M8). The ratchet numbers assume `origin/main` still measures 1580418 characters per profile, as when sub-project 3 was measured. If it moved, every "origin/main X -> HEAD Y" moves with it.
- Prose passes `node .claude/skills/anti-slop-writing/slop-check.js`.

## Review Focus

1. **A save that repeats "Not set" on a zone whose stage is already unset, or that changes only the notes.** The date must stay; only a change from a set stage to unset clears it, and then even if the request carries a date. Pinned in Task 2 ("an unrelated save keeps the date, also when it repeats the stored stage or an unset stage"; "a change from a set stage to unset clears the date, whatever the request says about it") and Task 3 (the same two cases on the legacy command).
2. **A stage changed without a date** (the prediction drawer's stage select, a Terra selection, a cloud or API client that sends only the stage). The new stage must start on the zone-local today, never keep the previous stage's date: a late season counted from a development start date begins at its end, with Kc at `kc_end` and `stage_overrun` set on day one. Pinned in Task 2 ("another set stage without a date starts on the zone-local today …", a UTC+14 zone), Task 3 (the same rule on `UPSERT_ZONE_CONFIG` and the flat `UPSERT_ZONE`, and "a Terra stage change starts the stage on the zone-local date …", 22:30 UTC in Zurich).
3. **A zone whose stored stage is a legacy key** (`veraison`, `harvest`, `Veraison ` with spaces). It counts as its FAO stage for both rules, exactly as `osi-crop-kc` `normalizeStage` maps it: `veraison` to `mid_season` keeps the date. Pinned in Task 2 (the `veraison` and `harvest` zones) and Task 3 ("the node treats a stored stage as set exactly when osi-crop-kc normalizeStage maps it", the `harvest` command).
4. **An impossible start date on each write path** (`2026-02-30`, `05/01/2026`, `2026-5-1`, a number). The zone route answers 400 and saves nothing, the legacy command keeps the stored date and warns once with the zone UUID, the protected command is `REJECTED_PERMANENT`, the contract rejects it. Pinned in Tasks 2 and 3.
5. **A start date entered after rows already froze.** Stored past days keep their Kc and have no start date; a day computed later takes the date and its place on the curve. Pinned in Task 4 ("a start date entered after a row froze does not reach that row; a day computed later takes it").
6. **Shared mode with a cloud day for a date the gateway has no demand for, and an older cloud that sends no `demandComputedBy`.** The cloud's day stays; with an older cloud the gateway's fields fill the day as before. Pinned in Task 5 ("shared mode: …"); plan E2b pins the tooltip lines.

Also pinned: a stage past its Table 11 length is flagged in the row (Task 4).

## File Map

| File | Change | Task |
|---|---|---|
| `scripts/sync-trigger-source.json`, `database/migrations/ordered/0064__stage_started_on.sql`, `CHECKSUMS.json`, `database/seed-blank.sql`, seven bundled DBs, both `flows.json` (`sync-init-fn` region by the generator) | the column pair, the three trigger insertions | 1 |
| `scripts/test-stage-started-on-migration.js` (new), `.github/workflows/verify-sync-flow.yml` | migration and trigger tests | 1 (the step), 3 (its second file) |
| `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js`, `scripts/reconcile-ledger-numbering.test.js`, `scripts/verify-db-schema-consistency.js`, `scripts/fixtures/terra-edge-selection/*` | pins, contract, regenerated fixture | 1 (fixture again in 3) |
| both `flows.json`: `zone-config-fn`, `get-zones-query`, `get-zones-response`, `sync-bootstrap-build`, `sync-force-build`, `al-link-build-req` | route (validation, both stage-date rules), list, snapshots, capability | 2 |
| `scripts/test-zone-update-sync-version.js`, `scripts/test-entity-name-command-path.js`, `scripts/test-journal-bootstrap.js`, `AGENTS.md` | route tests; capability lists | 2 |
| both `flows.json`: `4f4a765f36cee6f3`; `.../osi-zone-commands/index.js`; `docs/contracts/sync-schema/resources.schema.json`, `docs/contracts/sync-schema/README.md` | legacy, protected and Terra command paths, contract and its README section | 3 |
| `scripts/test-legacy-upsert-zone-config.js` (new), `scripts/test-zone-command-path.js`, `scripts/test-terra-zone-config-command-flow.js`, `scripts/test-terra-selection-edge-acceptance.js`, `scripts/test-contract-schemas.js` | command-path and contract tests | 3 |
| `.../osi-agronomy-daily/index.js`, `index.test.js` | curve fields frozen per row | 4 |
| `.../osi-zone-env/index.js`, `index.test.js`; both `flows.json`: `zone-env-fn`; `scripts/capture-zone-env-vectors.js`, `docs/contracts/zone-env/*` | Kc per date, `stageOverrun`, `demandComputedBy`, the shared-mode merge | 5 |
| `scripts/verify-sync-flow.js`, `scripts/verify-flows-size-ratchet-*.json`, `scripts/verify-live-gateway-identity.js` | pins and measured allowances | 1, 2, 3, 5 |
| `docs/superpowers/plans/2026-09-27-daily-agronomy-parity-edge-execution-report.md` (new) | the edge execution report: E1 and E2a sections | 6 |

In the tasks below `.../` stands for `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/`.

---

### Task 1: Migration 0064 and the zone trigger

**Files:**
- Create: `database/migrations/ordered/0064__stage_started_on.sql` (written from the canonical source by the Step 3 script), `scripts/test-stage-started-on-migration.js`
- Modify: `scripts/sync-trigger-source.json` (entry `trg_sync_zones_outbox_au`), both `flows.json` (`sync-init-fn` generated region only, by `generate-sync-trigger-source.js --write`), `database/seed-blank.sql`, `database/migrations/ordered/CHECKSUMS.json`, the seven bundled DBs (by `build-seed-db.js`), `scripts/verify-db-schema-consistency.js` (`schemaContract`), `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js`, `scripts/reconcile-ledger-numbering.test.js`, `scripts/fixtures/terra-edge-selection/edge-selection-v1.json` and `.sha256` (regenerated), `scripts/verify-sync-flow.js`, `scripts/verify-flows-size-ratchet-allowances.json`, `scripts/verify-flows-size-ratchet-baseline.json`, `scripts/verify-live-gateway-identity.js`, `.github/workflows/verify-sync-flow.yml`
- Unchanged by design: `MIGRATION_OWNED_TRIGGERS`, `MIGRATION_OWNED_TRIGGER_NAMES`, `trg_sync_zones_outbox_ai`, `scripts/verify-sync-op-parity.js` and its test (already reads 0063's `CASE` payload as of sub-project 3's own fix)
- Scratch: `$SCRATCH/trigger-0064.js`, `$SCRATCH/seed-0064.js`, `$SCRATCH/schema-contract-0064.py`, `$SCRATCH/ratchet-e2-task1.js`

**Interfaces:**
- Produces: `irrigation_zones.stage_started_on TEXT` (`YYYY-MM-DD` or NULL); `zone_daily_agronomy.stage_started_on TEXT`, `kc_stage_day INTEGER`, `stage_overrun INTEGER` (1, 0 or NULL). Every `ZONE` update outbox payload carries `'stage_started_on'`, null when unset (22 key-value pairs on a zone at `'auto'`, 23 when 0063's rule adds `weather_source`); a change of the date alone emits `ZONE_CONFIG_UPSERTED`. Tasks 2 to 5 read and write these columns.

- [ ] **Step 1: Write the failing tests and put them in CI**

`scripts/test-stage-started-on-migration.js`:
```js
#!/usr/bin/env node
'use strict';

// Migration 0064 and the zone update trigger it carries (spec
// docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, B2): the
// migration applies to a database at 0063, its trigger body is the canonical
// source's (which generate-sync-trigger-source.js renders into sync-init-fn),
// and on every bundled database a start date change alone emits one
// ZONE_CONFIG_UPSERTED carrying stage_started_on, which every zone payload
// carries (null when unset) beside 0063's conditional weather_source.
//
// Run: node --test scripts/test-stage-started-on-migration.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { canonicalizeTriggerSql } = require('./verify-trigger-body-parity');
const { SEED_DB_RELATIVE_PATHS } = require('./seed-db-paths');

const ROOT = path.resolve(__dirname, '..');
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const MIGRATION = fs.readFileSync(path.join(ROOT, 'database/migrations/ordered/0064__stage_started_on.sql'), 'utf8');
const CANONICAL = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/sync-trigger-source.json'), 'utf8'))
  .triggers.find((t) => t.name === 'trg_sync_zones_outbox_au').sql;
const GATEWAY = '00000000000000B1';
const ZONE_UUID = '306fa8ef-20f8-4911-b9c4-f99f60252579';

function triggerSql(db) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_sync_zones_outbox_au'").get().sql;
}
function columns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

// The seed minus what 0064 adds: the schema of a gateway at 0063.
function databaseAt0063() {
  const db = new DatabaseSync(':memory:');
  db.exec(SEED);
  // SQLite refuses to drop a column a trigger reads: the zone update trigger goes
  // first, and so does any later migration's trigger on the three agronomy columns.
  const readers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND "
    + "(sql LIKE '%stage_started_on%' OR sql LIKE '%kc_stage_day%' OR sql LIKE '%stage_overrun%')").all();
  for (const { name } of readers) db.exec(`DROP TRIGGER ${name}`);
  db.exec('ALTER TABLE irrigation_zones DROP COLUMN stage_started_on');
  for (const column of ['stage_started_on', 'kc_stage_day', 'stage_overrun']) db.exec(`ALTER TABLE zone_daily_agronomy DROP COLUMN ${column}`);
  return db;
}

test('0064 applies to a database at 0063 and creates the canonical trigger body', () => {
  const db = databaseAt0063();
  try {
    assert.ok(!columns(db, 'irrigation_zones').includes('stage_started_on'));
    db.exec(MIGRATION);
    assert.ok(columns(db, 'irrigation_zones').includes('stage_started_on'));
    for (const column of ['stage_started_on', 'kc_stage_day', 'stage_overrun']) assert.ok(columns(db, 'zone_daily_agronomy').includes(column), column);
    assert.equal(triggerSql(db), CANONICAL.replace(/;\s*$/, ''));
    assert.ok(MIGRATION.includes(CANONICAL), 'the migration carries the canonical body byte for byte');
  } finally {
    db.close();
  }
});

test('the seed trigger equals the migration trigger after canonicalization', () => {
  const seedDb = new DatabaseSync(':memory:');
  const migrated = databaseAt0063();
  try {
    seedDb.exec(SEED);
    migrated.exec(MIGRATION);
    assert.equal(canonicalizeTriggerSql(triggerSql(seedDb)), canonicalizeTriggerSql(triggerSql(migrated)));
  } finally {
    seedDb.close();
    migrated.close();
  }
});

function bundledCopy(t, relativePath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zone-ssd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'farming.db');
  fs.copyFileSync(path.join(ROOT, relativePath), dbPath);
  const db = new DatabaseSync(dbPath);
  t.after(() => { try { db.close(); } catch { /* already closed */ } });
  db.exec("INSERT INTO users(id, username, password_hash, created_at) VALUES (7, 'grower', 'x', datetime('now'))");
  db.exec('INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, gateway_device_eui, sync_version, timezone, phenological_stage, created_at, updated_at) '
    + `VALUES (11, 'North', 7, '${ZONE_UUID}', '${GATEWAY}', 1, 'UTC', 'development', datetime('now'), datetime('now'))`);
  return db;
}
function link(db) {
  db.exec(`INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) VALUES ('cloud', 1, '${GATEWAY}', datetime('now'))`);
}
function zoneEvents(db) {
  return db.prepare("SELECT op, sync_version, payload_json FROM sync_outbox WHERE aggregate_type = 'ZONE' ORDER BY rowid").all()
    .map((row) => ({ op: row.op, syncVersion: Number(row.sync_version), payload: JSON.parse(row.payload_json) }));
}

for (const relativePath of SEED_DB_RELATIVE_PATHS) {
  test(`[${relativePath}] 0064: a start date change alone emits one ZONE_CONFIG_UPSERTED carrying it`, (t) => {
    const db = bundledCopy(t, relativePath);
    link(db);
    db.exec('DELETE FROM sync_outbox');
    db.exec("UPDATE irrigation_zones SET stage_started_on = '2026-05-01', sync_version = 2 WHERE id = 11");
    const events = zoneEvents(db);
    assert.equal(events.length, 1);
    assert.equal(events[0].op, 'ZONE_CONFIG_UPSERTED');
    assert.equal(events[0].payload.stage_started_on, '2026-05-01');
    // 21 fixed pairs and stage_started_on; 0063 leaves weather_source out while the zone
    // stays on 'auto' and the update does not change it.
    assert.equal(Object.keys(events[0].payload).length, 22, 'the zone payload has 22 key-value pairs on auto');
    assert.ok(!('weather_source' in events[0].payload));
    assert.equal(events[0].syncVersion, 2);
    db.exec('DELETE FROM sync_outbox');
    db.exec("UPDATE irrigation_zones SET name = 'North block', sync_version = 3 WHERE id = 11");
    const rename = zoneEvents(db);
    assert.deepEqual([rename.length, rename[0].op, rename[0].payload.stage_started_on], [1, 'ZONE_UPSERTED', '2026-05-01']);
    // A zone on a chosen provider: both keys, 23 pairs; a cleared date travels as null.
    db.exec("UPDATE irrigation_zones SET weather_source = 'open_meteo', sync_version = 4 WHERE id = 11");
    db.exec('DELETE FROM sync_outbox');
    db.exec('UPDATE irrigation_zones SET stage_started_on = NULL, sync_version = 5 WHERE id = 11');
    const cleared = zoneEvents(db);
    assert.deepEqual([cleared.length, cleared[0].op, cleared[0].payload.stage_started_on, cleared[0].payload.weather_source], [1, 'ZONE_CONFIG_UPSERTED', null, 'open_meteo']);
    assert.equal(Object.keys(cleared[0].payload).length, 23, 'both keys: 23 key-value pairs');
  });

  test(`[${relativePath}] 0064: an unlinked gateway emits nothing for a date change`, (t) => {
    const db = bundledCopy(t, relativePath);
    db.exec('DELETE FROM sync_outbox');
    db.exec("UPDATE irrigation_zones SET stage_started_on = '2026-05-01', sync_version = 2 WHERE id = 11");
    assert.deepEqual(zoneEvents(db), []);
  });
}
```

In `.github/workflows/verify-sync-flow.yml`, after sub-project 3's step whose `run:` line is `        run: node --test scripts/test-zone-weather-source.js`, add:
```yaml
      # Daily agronomy parity: the zone stage start date -- the 0064 zone trigger on
      # the seven bundled databases and the legacy command path, against the shipped source.
      - name: Zone stage start date round trip
        run: node --test scripts/test-stage-started-on-migration.js
```
Task 3 appends ` scripts/test-legacy-upsert-zone-config.js` to this `run:` line in the commit that creates the file, so no commit's CI names a file that does not exist yet (plan review E2-E4 minor 2).

Run: `node --test scripts/test-stage-started-on-migration.js`
Expected: FAIL at load with `ENOENT … 0064__stage_started_on.sql`.

- [ ] **Step 2: Pin the trigger text in `verify-sync-flow.js`**

After the last of sub-project 3's three 0063 trigger pins, the line `expectIncludes('Sync Init Schema + Triggers', "json_object('weather_source', COALESCE(NEW.weather_source,'auto'))", 'carries the zone weather provider by patching it into the payload under that rule (0063, review I1)');`, add:
```js
expectIncludes('Sync Init Schema + Triggers', "'stage_started_on', NEW.stage_started_on", 'carries the stage start date in every zone sync event (0064)');
expectIncludes('Sync Init Schema + Triggers', "COALESCE(NEW.stage_started_on,'') <> COALESCE(OLD.stage_started_on,'')", 'queues a zone config event when only the stage start date changes (0064)');
expectTriggerIncludes('seed-blank.sql', seedSqlSource, 'trg_sync_zones_outbox_au', "'stage_started_on', NEW.stage_started_on", 'stage start date in the zone payload (0064)');
expectTriggerIncludes('seed-blank.sql', seedSqlSource, 'trg_sync_zones_outbox_au', "COALESCE(NEW.stage_started_on,'') <> COALESCE(OLD.stage_started_on,'')", 'stage start date change detection (0064)');
```
(Task 2 adds its route and list pins after these four lines.)

Sub-project 3's own hygiene and fix-wave pass (2026-09-29) already taught `verify-sync-op-parity.js` to read the `CASE WHEN … THEN json_patch(json_object(...), ...) ELSE json_object(...) END` shape that its final fix wave gave `trg_sync_zones_outbox_au` (commit `fix(verify): op parity reads the conditional zone payload`, on `feat/weather-data-view`), so this branch inherits that reading through the rebase and 0064 needs no further verifier change.

- [ ] **Step 3: Change the canonical trigger and write 0064 from it**

The three insertions of spec B2: the date comparison after the stage comparison in the `WHEN` list and in the `CASE` branch that yields `ZONE_CONFIG_UPSERTED` (the stage comparison appears exactly twice in the body, once in each), and the payload pair after `'phenological_stage'`. Sub-project 3's final fix wave wrapped the payload in a second `CASE` (0063: `weather_source` is present only when it is not `'auto'` or changed in the update, through `json_patch`), so the fixed pair list appears twice, once as the `json_patch` target and once as the plain `json_object`; the pair goes into both, and the script checks that the `weather_source` rule is still there, unchanged, afterwards.

`$SCRATCH/trigger-0064.js`:
```js
// One-shot (plan E2a, Task 1): the zone update trigger carries stage_started_on.
// Rewrites the canonical source entry and writes migration 0064 from it, so the
// migration's CREATE TRIGGER is byte-identical to the canonical SQL.
'use strict';
const fs = require('fs');
const SOURCE = 'scripts/sync-trigger-source.json';
const MIGRATION = 'database/migrations/ordered/0064__stage_started_on.sql';
const before = fs.readFileSync(SOURCE, 'utf8');
const source = JSON.parse(before);
if (JSON.stringify(source, null, 2) + '\n' !== before) throw new Error(`${SOURCE} does not round-trip`);
const entry = source.triggers.find((t) => t.name === 'trg_sync_zones_outbox_au');
if (!entry) throw new Error('trg_sync_zones_outbox_au not in the canonical source');
// Sub-project 3's 0063 wraps the payload: CASE WHEN <weather_source rule> THEN
// json_patch(json_object(<fixed pairs>), json_object('weather_source', ...)) ELSE
// json_object(<fixed pairs>) END. That wrap stays byte for byte; stage_started_on is
// an ordinary pair and goes into both copies of the fixed list.
const WEATHER_RULE = "CASE WHEN COALESCE(NEW.weather_source,'auto') <> 'auto' OR OLD.weather_source IS NOT NEW.weather_source THEN json_patch(";
const WEATHER_PATCH = "json_object('weather_source', COALESCE(NEW.weather_source,'auto'))";
if (!entry.sql.includes(WEATHER_RULE) || !entry.sql.includes(WEATHER_PATCH)) throw new Error('0063 (sub-project 3) is not applied: the conditional weather_source payload is missing from the zone trigger');
const STAGE = "COALESCE(NEW.phenological_stage,'') <> COALESCE(OLD.phenological_stage,'')";
const DATE = "COALESCE(NEW.stage_started_on,'') <> COALESCE(OLD.stage_started_on,'')";
if (entry.sql.includes(DATE)) throw new Error('already applied');
let sql = entry.sql;
// 1 and 2: the WHEN list and the CASE branch that yields ZONE_CONFIG_UPSERTED
// each compare the stage once; the date comparison follows both.
if (sql.split(STAGE).length !== 3) throw new Error('expected the stage comparison exactly twice (WHEN list and CASE branch)');
sql = sql.split(STAGE).join(`${STAGE} OR ${DATE}`);
// 3: the payload, in both branches of the weather_source CASE (the json_patch
// target and the plain json_object), so the key is present on every event.
const PAYLOAD = "'phenological_stage', NEW.phenological_stage, ";
if (sql.split(PAYLOAD).length !== 3) throw new Error('expected the payload stage pair exactly twice (both branches of the weather_source CASE)');
sql = sql.split(PAYLOAD).join(`${PAYLOAD}'stage_started_on', NEW.stage_started_on, `);
if (sql.split(WEATHER_RULE).length !== 2 || sql.split(WEATHER_PATCH).length !== 2) throw new Error('the weather_source rule must survive unchanged');
entry.sql = sql;
fs.writeFileSync(SOURCE, JSON.stringify(source, null, 2) + '\n');
fs.writeFileSync(MIGRATION, [
  '-- risk: additive',
  '-- 0064: the stage start date of the FAO-56 Kc curve (spec',
  '-- docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, B2).',
  '-- irrigation_zones.stage_started_on is the day the current growth stage began',
  '-- (YYYY-MM-DD, NULL = not set); the daily agronomy row freezes the value with',
  '-- its Kc, together with FAO\'s day in the stage and whether it passed the stage',
  '-- length. sync-init-fn recreates trg_sync_zones_outbox_au at every boot from',
  '-- scripts/sync-trigger-source.json; the CREATE below is byte-identical to that',
  '-- entry, so a date change alone emits ZONE_CONFIG_UPSERTED and every zone',
  "-- payload carries 'stage_started_on' (null when unset). 0063's rule for",
  "-- 'weather_source' (present only when not 'auto' or changed in this update) is",
  '-- unchanged: the new pair sits in both branches of its CASE.',
  'ALTER TABLE irrigation_zones ADD COLUMN stage_started_on TEXT;',
  'ALTER TABLE zone_daily_agronomy ADD COLUMN stage_started_on TEXT;',
  'ALTER TABLE zone_daily_agronomy ADD COLUMN kc_stage_day INTEGER;',
  'ALTER TABLE zone_daily_agronomy ADD COLUMN stage_overrun INTEGER;',
  'DROP TRIGGER IF EXISTS trg_sync_zones_outbox_au;',
  sql,
  '',
].join('\n'));
console.log('canonical entry and 0064 written; trigger SQL', sql.length, 'chars');
```
```bash
node "$SCRATCH/trigger-0064.js"
node scripts/generate-sync-trigger-source.js --write
```
Expected: `canonical entry and 0064 written; trigger SQL 5551 chars`; `generated ordered trigger regions in both profiles (31 SQL definitions)`. Each of the two payload `json_object` calls grows from 42 to 44 arguments (limit 127); `json_patch` keeps a null member of its target, so a cleared date travels as `"stage_started_on": null` in both branches.

- [ ] **Step 4: Seed parity**

`$SCRATCH/seed-0064.js` (the four columns in the two tables' definitions, and the same insertions in the seed's pretty-printed trigger: the two comparisons, and the payload pair in both branches of the `weather_source` `CASE`):
```js
// One-shot (plan E2a, Task 1): the same change in seed-blank.sql's pretty form,
// plus the four columns in the two table definitions.
'use strict';
const fs = require('fs');
const FILE = 'database/seed-blank.sql';
let text = fs.readFileSync(FILE, 'utf8');
function swapOnce(haystack, from, to) {
  if (haystack.split(from).length !== 2) throw new Error(`expected exactly one match for: ${from}`);
  return haystack.replace(from, to);
}
text = swapOnce(text,
  "  weather_source              TEXT NOT NULL DEFAULT 'auto',\n  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE\n",
  "  weather_source              TEXT NOT NULL DEFAULT 'auto',\n  stage_started_on            TEXT,\n  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE\n");
text = swapOnce(text,
  "  null_reason          TEXT,\n  PRIMARY KEY (zone_id, date)\n",
  "  null_reason          TEXT,\n  stage_started_on     TEXT,\n  kc_stage_day         INTEGER,\n  stage_overrun        INTEGER,\n  PRIMARY KEY (zone_id, date)\n");
const start = text.indexOf('CREATE TRIGGER trg_sync_zones_outbox_au');
const end = text.indexOf('\nEND;', start);
if (start < 0 || end < 0) throw new Error('trg_sync_zones_outbox_au block not found');
let block = text.slice(start, end);
block = swapOnce(block,
  "    COALESCE(NEW.phenological_stage,'') <> COALESCE(OLD.phenological_stage,'') OR\n",
  "    COALESCE(NEW.phenological_stage,'') <> COALESCE(OLD.phenological_stage,'') OR\n    COALESCE(NEW.stage_started_on,'') <> COALESCE(OLD.stage_started_on,'') OR\n");
block = swapOnce(block,
  "      WHEN COALESCE(NEW.phenological_stage,'') <> COALESCE(OLD.phenological_stage,'') OR\n",
  "      WHEN COALESCE(NEW.phenological_stage,'') <> COALESCE(OLD.phenological_stage,'') OR\n           COALESCE(NEW.stage_started_on,'') <> COALESCE(OLD.stage_started_on,'') OR\n");
// The payload pair, in both branches of 0063's weather_source CASE: the json_patch
// target (12-space indent) and the plain json_object (10-space indent). The leading
// newline keeps the shorter indent from matching inside the longer one.
for (const indent of ['            ', '          ']) {
  block = swapOnce(block,
    `\n${indent}'phenological_stage',       NEW.phenological_stage,\n`,
    `\n${indent}'phenological_stage',       NEW.phenological_stage,\n${indent}'stage_started_on',         NEW.stage_started_on,\n`);
}
fs.writeFileSync(FILE, text.slice(0, start) + block + text.slice(end));
console.log('seed-blank.sql: columns and trigger updated');
```
```bash
node "$SCRATCH/seed-0064.js"
node scripts/generate-sync-trigger-source.js --check
```
Expected: `seed-blank.sql: columns and trigger updated`; `sync trigger source check passed (31 SQL definitions)`.

`scripts/verify-db-schema-consistency.js` `schemaContract`, as a one-shot (`$SCRATCH/schema-contract-0064.py`) whose two swaps are this diff:
```diff
   zone_daily_agronomy: [
     …
     'null_reason',
+    'stage_started_on',
+    'kc_stage_day',
+    'stage_overrun',
   ],
   weather_station_hours: [
   …
   irrigation_zones: [
     …
     'weather_source',
+    'stage_started_on',
   ],
   sdi12_recipe_deployments: [
```
```python
# One-shot (plan E2a, Task 1): the schema contract lists the four 0064 columns.
import pathlib
p = pathlib.Path("scripts/verify-db-schema-consistency.js")
s = p.read_text(encoding="utf-8")
for old, new in [
    ("    'null_reason',\n  ],\n  weather_station_hours: [",
     "    'null_reason',\n    'stage_started_on',\n    'kc_stage_day',\n    'stage_overrun',\n  ],\n  weather_station_hours: ["),
    ("    'weather_source',\n  ],\n  sdi12_recipe_deployments: [",
     "    'weather_source',\n    'stage_started_on',\n  ],\n  sdi12_recipe_deployments: ["),
]:
    if s.count(old) != 1:
        raise SystemExit("expected one match for: " + old[:60])
    s = s.replace(old, new)
p.write_text(s, encoding="utf-8")
print("schemaContract: the 0064 columns")
```
Run: `python3 "$SCRATCH/schema-contract-0064.py"`. Expected: `schemaContract: the 0064 columns`. Plan E4's `verifier-lists.py` anchors on the first hunk's result (`'stage_overrun',\n  ],\n  weather_station_hours: [`).

- [ ] **Step 5: Checksums and the seven bundled databases**

```bash
node -e "
const fs=require('fs'),crypto=require('crypto'),p='database/migrations/ordered/';
const m={};for(const f of fs.readdirSync(p).filter(f=>f.endsWith('.sql')).sort()){m[f]=crypto.createHash('sha256').update(fs.readFileSync(p+f)).digest('hex');}
fs.writeFileSync(p+'CHECKSUMS.json',JSON.stringify(m,null,2)+'\n');console.log(Object.keys(m).length,'entries');"
node scripts/build-seed-db.js
```
Run the second command with a 10-minute timeout (about 3 minutes). Expected: `64 entries`; `build-seed-db: OK (7 image(s), …)`.

- [ ] **Step 6: Migration corpus pins**

`lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js`: the title becomes `'affected gateway ledger applies original pending migrations through 0064'` and the assertion ends `…, 60, 61, 62, 63, 64]);`.

`scripts/reconcile-ledger-numbering.test.js` (as sub-project 3 left it, through 0063): in the first lineage fixture the comment's list `0054-0063 (…, zone weather_source sync)` becomes `0054-0064 (…, zone weather_source sync, zone stage start date)` and `pending is {22,23,24,25,54,...,64}`, and both `assert.deepEqual(pending, …)` and `assert.deepEqual(carryRes.applied, …)` end `…, 62, 63, 64]`; in the second lineage fixture the comment's `plus 0054-0063` becomes `plus 0054-0064`, its list `(…, zone weather_source sync)` gains `, zone stage start date`, and the assertion ends `…, 62, 63, 64]);`. The literal `59, 60, 61, 62, 63]);` occurs three times in the file (two assertions in the first lineage test, one in the second), and all three become `…, 63, 64]);`.

- [ ] **Step 7: Regenerate the Terra fixture**

Its zone trigger payloads and the ACK `payloadHash` now carry `stage_started_on`:
```bash
TERRA_EDGE_FIXTURE_OUT=scripts/fixtures/terra-edge-selection/edge-selection-v1.json node --test scripts/test-terra-selection-edge-acceptance.js
node --test scripts/test-terra-selection-edge-acceptance.js
git diff --stat scripts/fixtures/terra-edge-selection
```
Expected: both runs `# pass 21`, `# fail 0`; the diff touches `edge-selection-v1.json` (zone payloads gain `"stage_started_on": null`; Task 3 regenerates it once the Terra path sets the date) and `edge-selection-v1.sha256`. The osi-server copy pins an older osi-os commit and stays green (spec "Not in scope").

- [ ] **Step 8: Size ratchet and identity pin**

`$SCRATCH/ratchet-e2-task1.js`:
```js
#!/usr/bin/env node
// Measures the named nodes and the per-profile total against origin/main and
// writes the exact allowances verify-flows-size-ratchet reads.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { nodeSizes, totalChars } = require(path.join(process.cwd(), 'scripts/flows-size-scan'));
const REL = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';
const FILE = 'scripts/verify-flows-size-ratchet-allowances.json';
const head = JSON.parse(fs.readFileSync(REL, 'utf8'));
const base = JSON.parse(execFileSync('git', ['show', 'origin/main:' + REL], { maxBuffer: 64 * 1024 * 1024 }).toString());
const h = nodeSizes(head);
const b = nodeSizes(base);
const before = fs.readFileSync(FILE, 'utf8');
const allowances = JSON.parse(before);
if (JSON.stringify(allowances, null, 2) + '\n' !== before) throw new Error(FILE + ' does not round-trip');
const WHY = 'Daily agronomy parity (spec docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md), measured with verify-flows-size-ratchet nodeSizes over both byte-identical profiles: ';
const PRIOR = '. Supersedes the prior entry, whose growth this delta includes. ';
const NODES = {
  'sync-init-fn': (m) => `${WHY}${m}${PRIOR}the generated trigger region: trg_sync_zones_outbox_au carries stage_started_on (migration 0064, written by generate-sync-trigger-source.js --write).`,
};
for (const [id, reason] of Object.entries(NODES)) {
  const delta = h.get(id).chars - b.get(id).chars;
  const measured = `origin/main ${b.get(id).chars} -> HEAD ${h.get(id).chars} = +${delta}`;
  allowances.node_allowances[id] = { delta, reason: reason(measured) };
  console.log(id, measured);
}
const totalDelta = totalChars(head) - totalChars(base);
allowances.total_allowance = {
  delta: totalDelta,
  reason: `Branch feat/daily-agronomy-parity, stacked on feat/weather-data-view and feat/daily-agronomy (the weather provider store, the daily agronomy record, the weather data view and daily agronomy parity, all unmerged to origin/main), measured with verify-flows-size-ratchet totalChars over both byte-identical profiles: origin/main ${totalChars(base)} -> HEAD ${totalChars(head)} = +${totalDelta}. Carried from feat/daily-agronomy: +4138 (weather-provider-tick 0, weather-provider-fn 1467, station-hours-fn 1525, agronomy-daily-fn 1515, zone-env-fn -369). Carried from feat/weather-data-view: +4307 (sync-init-fn 1394, zone-config-fn 737, get-zones-query 19, get-zones-response 337, sync-bootstrap-build 150, sync-force-build 150, al-link-build-req 33, 4f4a765f36cee6f3 1487). This branch: sync-init-fn grew by the deltas of their node entries. When the earlier branches merge to origin/main their share moves into the base total and this entry drops by it.`,
};
console.log('total', `origin/main ${totalChars(base)} -> HEAD ${totalChars(head)} = +${totalDelta}`);
fs.writeFileSync(FILE, JSON.stringify(allowances, null, 2) + '\n');
```
```bash
node "$SCRATCH/ratchet-e2-task1.js"
node scripts/verify-flows-size-ratchet.js --write-baseline
node scripts/verify-flows-size-ratchet.js
```
Expected: `sync-init-fn origin/main 81736 -> HEAD 83362 = +1626` (sub-project 3's 1394 plus this task's 232: two comparisons and the payload pair in both branches of 0063's `CASE`); `total origin/main 1580418 -> HEAD 1589095 = +8677`; `verify-flows-size-ratchet: OK (…)`.

In `scripts/verify-live-gateway-identity.js`, the total pin sub-project 3 left at 8445 becomes (keep every comment above it and add this one):
```js
  // 8677: daily agronomy parity (plan E2a Task 1) adds sync-init-fn +232 (the generated
  // trg_sync_zones_outbox_au body of migration 0064: the date comparison twice and the
  // stage_started_on pair in both branches of 0063's weather_source CASE) to the weather
  // data view's 8445. verify-flows-size-ratchet totalChars over both byte-identical
  // profiles: origin/main 1580418 -> HEAD 1589095 = +8677.
  expectCondition(sizeAllowances.total_allowance?.delta === 8677,
    'size total allowance: exact cumulative delta 8677',
    'size total allowance: expected exact cumulative delta 8677');
```
The node-id loops of sub-projects 2 and 3 already require every node this plan touches in the total's reason; the ratchet script's reason names them all. The `sync-init-fn` hash pin masks the generated trigger region and does not move.

- [ ] **Step 9: Run the gates**

```bash
node --test scripts/test-stage-started-on-migration.js scripts/test-zone-weather-source.js scripts/test-zone-update-sync-version.js scripts/test-zone-command-path.js scripts/test-terra-zone-config-command-flow.js
node --test scripts/test-sync-trigger-source.js scripts/verify-trigger-body-parity.test.js
node scripts/generate-sync-trigger-source.js --check
node scripts/verify-migrations.js && node scripts/verify-seed-replay.js && node scripts/verify-runtime-schema-parity.js && node scripts/verify-trigger-body-parity.js && node scripts/verify-db-schema-consistency.js && node scripts/verify-seed-db-ledger.js && node scripts/verify-no-stray-ddl.js && node scripts/verify-profile-parity.js && node scripts/test-journal-schema.js
node scripts/verify-flows-fn-parse.js && node scripts/verify-flows-size-ratchet.js && node scripts/verify-live-gateway-identity.js && node scripts/verify-sync-flow.js
node --test lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js
node --test scripts/reconcile-ledger-numbering.test.js
OSI_SERVER_EDGE_SYNC_SERVICE=<osi-server>/.worktrees/daily-agronomy-cloud/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java node scripts/verify-sync-op-parity.js | tail -3
```
Expected: `test-stage-started-on-migration.js` `# pass 16` (two schema tests and two per bundled DB; pin what the runner prints), the other suites `# fail 0`; `sync trigger source check passed (31 SQL definitions)`; `verify-migrations: OK (64 migrations, checksum manifest OK, base immutability OK)`, `verify-seed-replay: OK`, `verify-runtime-schema-parity: OK (2 flows: devices CHECK + runtime trigger parity)`, `verify-trigger-body-parity: OK`, `DB schema consistency verification passed`, `verify-seed-db-ledger: OK (7 images stamped at migration head 64)`, `verify-no-stray-ddl: OK (…)`, `All parity checks passed.`, `test-journal-schema: OK (…)`; `verify-flows-fn-parse: OK`, the ratchet OK, `Live gateway identity verification passed.`, verify-sync-flow ends `All parity checks passed.`; the runner pin 2/2 (about 90 s); `reconcile-ledger-numbering.test.js` all pass (about 13 minutes, 30-minute timeout); `verify-sync-op-parity` prints no `payload_json missing contract_version` line (its one expected difference is Task 6 Step 1's).

- [ ] **Step 10: Commit**

```bash
git add database lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js scripts/reconcile-ledger-numbering.test.js scripts/sync-trigger-source.json scripts/test-stage-started-on-migration.js scripts/verify-sync-op-parity.js scripts/verify-sync-op-parity.test.js scripts/fixtures/terra-edge-selection scripts/verify-sync-flow.js scripts/verify-db-schema-consistency.js scripts/verify-flows-size-ratchet-allowances.json scripts/verify-flows-size-ratchet-baseline.json scripts/verify-live-gateway-identity.js .github/workflows/verify-sync-flow.yml conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json $(node -e "console.log(require('./scripts/seed-db-paths.js').SEED_DB_RELATIVE_PATHS.join(' '))")
git -c user.name=Project-OSI commit -m "feat(sync): zones carry stage_started_on (migration 0064, canonical trigger source, seeds)"
git status --short
```
`git status --short` lists none of the seven bundled databases.

---

### Task 2: Zone write route, zone list, snapshots and the capability

**Files:**
- Modify (by one-shot script): both `flows.json`, nodes `zone-config-fn`, `get-zones-query`, `get-zones-response`, `sync-bootstrap-build`, `sync-force-build`, `al-link-build-req`
- Modify: `scripts/test-zone-update-sync-version.js` (append), `scripts/verify-sync-flow.js`, `scripts/test-entity-name-command-path.js`, `scripts/test-journal-bootstrap.js`, `AGENTS.md`, `scripts/verify-flows-size-ratchet-allowances.json`, `scripts/verify-flows-size-ratchet-baseline.json`, `scripts/verify-live-gateway-identity.js`
- Scratch: `$SCRATCH/flows-stage-started-on.js`, `$SCRATCH/agents-capabilities.py`, `$SCRATCH/ratchet-e2-task2.js`

**Interfaces:**
- Consumes: the 0064 columns and trigger (Task 1).
- Produces: `PUT /api/irrigation-zones/:zone_id/config` accepts `stageStartedOn` or `stage_started_on`: `null` or `''` clears; a calendar date `YYYY-MM-DD` sets; anything else `400 {error: 'stageStartedOn must be YYYY-MM-DD or null'}` before anything is saved. A `phenologicalStage` that is not one of the five FAO keys or the nine legacy keys clears the date when the stored stage is one of them (`stage_started_on=CASE WHEN <stored stage key> IS NOT NULL THEN NULL ELSE <date or stored> END`). A `phenologicalStage` that maps to a set stage, sent without a date, starts that stage on the zone-local today unless the stored stage maps to the same key (`stage_started_on=CASE WHEN <stored stage key> = '<new key>' THEN stage_started_on ELSE '<today>' END`); a supplied date wins. The ownership `SELECT` reads `timezone`; the request's `timezone` wins over it. The response and every `GET /api/irrigation-zones` row carry `stage_started_on` (null when unset); both snapshots' zones carry `stage_started_on`; `syncCapabilities` in the three builders ends `'entity_name_commands_v1', 'zone_config_weather_source_v1', 'zone_config_stage_started_on_v1'` (then `field_journal_v1` when the journal is on). Plan E2b's GUI reads `stage_started_on`.

- [ ] **Step 1: Write the failing tests**

Append to `scripts/test-zone-update-sync-version.js` (the zone write-route suite; spec Testing names it for `zone-config-fn`):
```js
// Stage start date on the zone write route and the zone list (spec
// docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, B5). The
// shipped zone-config-fn source runs through scripts/lib/scoped-access-harness.js
// against an in-memory seed, so the assertions are about the stored row.
const { executeFunction, loadNode, makeAuthHeader } = require('./lib/scoped-access-harness');
const SEED_SQL = fs.readFileSync(path.join(REPO, 'database/seed-blank.sql'), 'utf8');
const ROUTE_SECRET = 'zone-stage-started-on-secret';

function routeDb({ stage = 'development', startedOn = '2026-05-01' } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(SEED_SQL);
  db.exec("INSERT INTO users(id, username, password_hash, created_at) VALUES (7, 'grower', 'x', '2026-01-01')");
  db.prepare('INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, gateway_device_eui, sync_version, timezone, '
    + "phenological_stage, stage_started_on, created_at, updated_at) VALUES (11, 'North', 7, ?, ?, 3, 'UTC', ?, ?, '2026-01-01', '2026-01-01')")
    .run(ZONE_UUID, GATEWAY, stage, startedOn);
  return db;
}

async function putConfig(db, body) {
  const run = await executeFunction(loadNode('zone-config-fn'), {
    msg: {
      req: { headers: { authorization: makeAuthHeader({ userId: 7, username: 'grower', secret: ROUTE_SECRET }) }, params: { zone_id: '11' }, body },
      payload: {},
    },
    env: { AUTH_TOKEN_SECRET: ROUTE_SECRET },
    db,
  });
  return run.result;
}

function storedZone(db) {
  return { ...db.prepare('SELECT phenological_stage, stage_started_on, sync_version FROM irrigation_zones WHERE id = 11').get() };
}

// Today in a timezone, read the way the node reads it. A test reads it before and
// after a call and accepts either, so a midnight during the run cannot fail it.
function localToday(timezone) {
  const p = {};
  for (const part of new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

test('zone-config-fn sets a valid start date, bumps sync_version and returns it; the snake-case key works too', async () => {
  const db = routeDb({ startedOn: null });
  try {
    const response = await putConfig(db, { stageStartedOn: '2026-05-01' });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(storedZone(db), { phenological_stage: 'development', stage_started_on: '2026-05-01', sync_version: 4 });
    assert.equal(response.payload.stage_started_on, '2026-05-01');
    assert.equal((await putConfig(db, { stage_started_on: '2026-06-02' })).statusCode, 200);
    assert.equal(storedZone(db).stage_started_on, '2026-06-02');
  } finally {
    db.close();
  }
});

test('zone-config-fn clears the date for null and empty, and refuses anything that is not a calendar date', async () => {
  const db = routeDb();
  try {
    assert.equal((await putConfig(db, { stageStartedOn: null })).statusCode, 200);
    assert.equal(storedZone(db).stage_started_on, null);
    db.exec("UPDATE irrigation_zones SET stage_started_on = '2026-05-01' WHERE id = 11");
    assert.equal((await putConfig(db, { stageStartedOn: '' })).statusCode, 200);
    assert.equal(storedZone(db).stage_started_on, null);
    db.exec("UPDATE irrigation_zones SET stage_started_on = '2026-05-01', sync_version = 3 WHERE id = 11");
    for (const bad of ['2026-02-30', '05/01/2026', '2026-5-1', 'yesterday', 20260501]) {
      const response = await putConfig(db, { stageStartedOn: bad, notes: 'not saved' });
      assert.equal(response.statusCode, 400, String(bad));
      assert.deepEqual(response.payload, { error: 'stageStartedOn must be YYYY-MM-DD or null' });
    }
    assert.deepEqual(storedZone(db), { phenological_stage: 'development', stage_started_on: '2026-05-01', sync_version: 3 });
  } finally {
    db.close();
  }
});

test('zone-config-fn: a change from a set stage to unset clears the date, whatever the request says about it', async () => {
  const db = routeDb();
  try {
    assert.equal((await putConfig(db, { phenologicalStage: 'default', stageStartedOn: '2026-05-01' })).statusCode, 200);
    assert.deepEqual(storedZone(db), { phenological_stage: 'default', stage_started_on: null, sync_version: 4 });
  } finally {
    db.close();
  }
  const legacy = routeDb({ stage: 'veraison' });
  try {
    assert.equal((await putConfig(legacy, { phenologicalStage: null })).statusCode, 200);
    assert.equal(storedZone(legacy).stage_started_on, null, 'a legacy stored key counts as set');
  } finally {
    legacy.close();
  }
});

test('zone-config-fn: an unrelated save keeps the date, also when it repeats the stored stage or an unset stage', async () => {
  const db = routeDb();
  try {
    assert.equal((await putConfig(db, { notes: 'north block' })).statusCode, 200);
    assert.equal(storedZone(db).stage_started_on, '2026-05-01');
    assert.equal((await putConfig(db, { phenologicalStage: 'development', notes: 'same stage' })).statusCode, 200);
    assert.deepEqual(storedZone(db), { phenological_stage: 'development', stage_started_on: '2026-05-01', sync_version: 5 });
  } finally {
    db.close();
  }
  const unset = routeDb({ stage: 'default', startedOn: '2026-04-01' });
  try {
    assert.equal((await putConfig(unset, { phenologicalStage: 'default', notes: 'x' })).statusCode, 200);
    assert.equal(storedZone(unset).stage_started_on, '2026-04-01', 'the stored stage was already unset: nothing to clear');
  } finally {
    unset.close();
  }
});

test('zone-config-fn: another set stage without a date starts on the zone-local today; the same stage keeps it; a supplied date wins', async () => {
  // Controller ruling on plan review E2 I2. A UTC+14 zone: its date, not the gateway's.
  const db = routeDb();
  try {
    db.exec("UPDATE irrigation_zones SET timezone = 'Pacific/Kiritimati' WHERE id = 11");
    const before = localToday('Pacific/Kiritimati');
    assert.equal((await putConfig(db, { phenologicalStage: 'late_season' })).statusCode, 200);
    assert.ok([before, localToday('Pacific/Kiritimati')].includes(storedZone(db).stage_started_on), storedZone(db).stage_started_on);
    db.exec("UPDATE irrigation_zones SET stage_started_on = '2026-08-01' WHERE id = 11");
    assert.equal((await putConfig(db, { phenologicalStage: 'harvest', notes: 'harvest is late season' })).statusCode, 200);
    assert.equal(storedZone(db).stage_started_on, '2026-08-01', 'a legacy key of the same stage keeps the date');
    assert.equal((await putConfig(db, { phenologicalStage: 'mid_season', stageStartedOn: '2026-07-15' })).statusCode, 200);
    assert.equal(storedZone(db).stage_started_on, '2026-07-15', 'a supplied date wins');
  } finally {
    db.close();
  }
  // Unset to a set stage is a change too; the request's timezone wins over the stored one.
  const unset = routeDb({ stage: 'default', startedOn: null });
  try {
    const before = localToday('Pacific/Kiritimati');
    assert.equal((await putConfig(unset, { phenologicalStage: 'initial', timezone: 'Pacific/Kiritimati' })).statusCode, 200);
    assert.ok([before, localToday('Pacific/Kiritimati')].includes(storedZone(unset).stage_started_on), storedZone(unset).stage_started_on);
  } finally {
    unset.close();
  }
});

test('the zone list returns stage_started_on', async () => {
  const db = routeDb();
  try {
    const query = await executeFunction(loadNode('get-zones-query'), { msg: { payload: [{ id: 7 }] }, env: {}, db });
    const response = await executeFunction(loadNode('get-zones-response'), { msg: query.result[0], env: {}, db });
    assert.equal(response.result.payload[0].stage_started_on, '2026-05-01');
    db.exec('UPDATE irrigation_zones SET stage_started_on = NULL WHERE id = 11');
    const again = await executeFunction(loadNode('get-zones-query'), { msg: { payload: [{ id: 7 }] }, env: {}, db });
    assert.equal((await executeFunction(loadNode('get-zones-response'), { msg: again.result[0], env: {}, db })).result.payload[0].stage_started_on, null);
  } finally {
    db.close();
  }
});

// The scheduled bootstrap snapshot carries the zone's stage start date, so a
// cloud that missed the event learns it within one bootstrap (spec B5).
async function bootstrapPayload(db) {
  // The bootstrap is built only for a cloud-linked account.
  db.exec("UPDATE users SET auth_mode = 'server', server_url = 'https://cloud.example.test', server_sync_token = 'fixture-token', user_uuid = COALESCE(user_uuid, '55555555-5555-4555-8555-555555555555') WHERE id = 7");
  const run = await executeFunction(loadNode('sync-bootstrap-build'), {
    msg: {},
    env: { DEVICE_EUI: GATEWAY, DEVICE_EUI_SOURCE: 'fixture', DEVICE_EUI_CONFIDENCE: 'authoritative' },
    db,
    osiLibModules: { installation: require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-installation-helper') },
    globals: { fs: { existsSync: () => false, readFileSync: () => { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; } } },
  });
  assert.ok(run.result && run.result.payload, 'the bootstrap node must build a payload: ' + run.warnings.join('; '));
  return run.result.payload;
}

test('the bootstrap snapshot carries stage_started_on and advertises zone_config_stage_started_on_v1', async () => {
  const db = routeDb();
  try {
    db.exec(`INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) VALUES ('cloud', 1, '${GATEWAY}', '2026-01-01')`);
    const payload = await bootstrapPayload(db);
    assert.equal(payload.zones.find((z) => z.zone_uuid === ZONE_UUID).stage_started_on, '2026-05-01');
    assert.ok(payload.gatewayIdentity.syncCapabilities.includes('zone_config_weather_source_v1'));
    assert.ok(payload.gatewayIdentity.syncCapabilities.includes('zone_config_stage_started_on_v1'));
    // An ordinary field: present on every zone, null when unset. weather_source keeps
    // sub-project 3's rule (absent while the zone is on 'auto').
    db.exec('UPDATE irrigation_zones SET stage_started_on = NULL WHERE id = 11');
    const unset = (await bootstrapPayload(db)).zones.find((z) => z.zone_uuid === ZONE_UUID);
    assert.ok(Object.prototype.hasOwnProperty.call(unset, 'stage_started_on') && unset.stage_started_on === null);
    assert.ok(!Object.prototype.hasOwnProperty.call(unset, 'weather_source'));
  } finally {
    db.close();
  }
});
```

In `scripts/verify-sync-flow.js`, after the four 0064 pins of Task 1 add:
```js
expectIncludesById('get-zones-query', 'iz.stage_started_on', 'the zone list reads the stage start date');
expectIncludesById('get-zones-response', 'stage_started_on: r.stage_started_on || null', 'the zone list returns the stage start date');
expectIncludesById('zone-config-fn', 'stageStartedOn must be YYYY-MM-DD or null', 'refuses a start date that is not a calendar date');
expectIncludesById('zone-config-fn', 'SELECT id,name,timezone FROM irrigation_zones', 'reads the zone timezone for the zone-local today');
expectIncludesById('zone-config-fn', 'THEN stage_started_on ELSE', 'starts a changed stage on the zone-local today (plan review E2 I2)');
```
after sub-project 3's `expectIncludes('Build Cloud Bootstrap', "...(z.weather_source && z.weather_source !== 'auto' ? { weather_source: z.weather_source } : {})", 'exports the zone weather provider in bootstrap payloads only when it is not auto, never as a default (review I1)');`:
```js
expectIncludes('Build Cloud Bootstrap', 'iz.stage_started_on', 'includes the stage start date in bootstrap snapshots');
expectIncludes('Build Cloud Bootstrap', 'stage_started_on: z.stage_started_on || null', 'exports the stage start date in bootstrap payloads');
```
after sub-project 3's `expectIncludes('Run Force Sync', "...(z.weather_source && z.weather_source !== 'auto' ? { weather_source: z.weather_source } : {})", 'exports the zone weather provider in forced bootstrap payloads only when it is not auto, never as a default (review I1)');`:
```js
expectIncludes('Run Force Sync', 'iz.stage_started_on', 'includes the stage start date in force-sync snapshots');
expectIncludes('Run Force Sync', 'stage_started_on: z.stage_started_on || null', 'exports the stage start date in forced bootstrap payloads');
```
and after sub-project 3's `expectIncludesForEach` block for `"'zone_config_weather_source_v1'"`:
```js
expectIncludesForEach(
  ['Build Cloud Bootstrap', 'Build server auth request', 'Run Force Sync'],
  "'zone_config_stage_started_on_v1'",
  'advertises that zone commands may carry stage_started_on'
);
```

In `scripts/test-entity-name-command-path.js`, the capability test's title becomes `'all three capability builders advertise entity_name_commands_v1 and both zone capabilities, on both profiles'` and its regex becomes:
```js
        /const syncCapabilities = \['linked_auth_sync_v1', 'force_edge_sync_v1', 'installation_recovery_v1', 'installation_locations_v1', 'entity_name_commands_v1', 'zone_config_weather_source_v1', 'zone_config_stage_started_on_v1'\];/,
```
In `scripts/test-journal-bootstrap.js`, `EXPECTED_CAPABILITIES` gains `'zone_config_stage_started_on_v1',` between `'zone_config_weather_source_v1',` and `'field_journal_v1',`, and the journal-off assertion becomes `assert.deepEqual(payload.gatewayIdentity.syncCapabilities, EXPECTED_CAPABILITIES.slice(0, 7));`.

- [ ] **Step 2: Run the tests to see them fail**

```bash
node --test scripts/test-zone-update-sync-version.js scripts/test-entity-name-command-path.js
node scripts/test-journal-bootstrap.js
node scripts/verify-sync-flow.js
```
Expected: in `test-zone-update-sync-version.js` the route, list and bootstrap tests fail (the node ignores `stageStartedOn` and returns no `stage_started_on`), and so does the stage-date default test (the date stays 2026-05-01 after a change to `late_season`); "an unrelated save keeps the date" passes already (`# pass 8`, `# fail 6`). The capability regex fails (`# pass 18`, `# fail 1`); `test-journal-bootstrap.js` fails its capability assertions (`# pass 18`, `# fail 44`); `verify-sync-flow.js` reports each new pin missing.

- [ ] **Step 3: The one-shot flows edit**

`$SCRATCH/flows-stage-started-on.js`:
```js
#!/usr/bin/env node
// One-shot (plan E2a, Task 2): stage_started_on on the zone write route, the zone
// list, both snapshots, and the zone_config_stage_started_on_v1 capability.
'use strict';
const fs = require('fs');
const path = require('path');
const REPO_ROOT = process.cwd();
const CANONICAL = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const MIRROR = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json');
function serialize(flows) { return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8'); }
function assertRoundtrip(filePath) {
  const original = fs.readFileSync(filePath);
  const parsed = JSON.parse(original.toString('utf8'));
  if (Buffer.compare(original, serialize(parsed)) !== 0) throw new Error('roundtrip guard failed for ' + filePath);
  return parsed;
}
const flows = assertRoundtrip(CANONICAL);
if (Buffer.compare(fs.readFileSync(CANONICAL), fs.readFileSync(MIRROR)) !== 0) throw new Error('profiles differ before the edit');
function nodeById(id) {
  const node = flows.find((n) => n.id === id);
  if (!node) throw new Error('node not found: ' + id);
  return node;
}
function edit(id, swaps) {
  const node = nodeById(id);
  for (const [from, to] of swaps) {
    const count = node.func.split(from).length - 1;
    if (count !== 1) throw new Error(`${id}: expected one match, found ${count}: ${from.slice(0, 80)}`);
    node.func = node.func.replace(from, to);
  }
}
// The node-side stage-date rules (spec 2026-09-27-daily-agronomy-parity B5; controller
// rulings cloud/sync I7 and plan review E2 I2). STAGE_KEY is osi-crop-kc normalizeStage as a
// table: the five FAO keys and the nine legacy keys; anything else (null, 'default',
// unknown) is unset. The stored stage is compared inside the UPDATE, as a CASE.
const ZONE_CONFIG_STAGE_DATE = [
  "// Stage start date (spec 2026-09-27-daily-agronomy-parity B5): null or '' clears, a calendar",
  "// date YYYY-MM-DD sets. The stage-date rules compare the request's stage with the stored one",
  "// inside the UPDATE (a CASE on the stored stage): a change to unset clears the date whatever the",
  "// request says (ruling cloud/sync I7); otherwise a supplied date wins; a change to another set",
  "// stage starts it on the zone-local today and the same stage keeps it (ruling plan review E2 I2).",
  "let stageStartedOnSql = null;",
  "if(stageStartedOnInput!==undefined){",
  "  const rawStart = stageStartedOnInput === null ? '' : String(stageStartedOnInput).trim();",
  "  const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(rawStart);",
  "  if (rawStart && !(m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString().slice(0, 10) === rawStart)) { await close(); return respond({error:'stageStartedOn must be YYYY-MM-DD or null'},400); }",
  "  stageStartedOnSql = rawStart ? s(rawStart) : 'NULL';",
  "}",
  "// osi-crop-kc normalizeStage as a table: the five FAO keys and the nine legacy keys; anything else is unset.",
  "const STAGE_KEY = {initial:'initial',development:'development',mid_season:'mid_season',late_season:'late_season',dormancy:'dormancy',budbreak:'initial',bud_break:'initial',fruitset:'development',cell_division:'development',cell_expansion:'development',veraison:'mid_season',fruit_maturation:'mid_season',harvest:'late_season',post_harvest:'late_season'};",
  "const stageKeyOf = (v) => { const k = String(v == null ? '' : v).trim().toLowerCase(); return Object.prototype.hasOwnProperty.call(STAGE_KEY, k) ? STAGE_KEY[k] : null; };",
  "const storedStageKey = \"(CASE lower(trim(COALESCE(phenological_stage,''))) \" + Object.keys(STAGE_KEY).map((k) => \"WHEN '\" + k + \"' THEN '\" + STAGE_KEY[k] + \"'\").join(' ') + \" END)\";",
  "// Today in the zone's timezone (the request's when it carries one); UTC for an unknown zone id,",
  "// as osi-agronomy-daily reads it. formatToParts: the Node build has English locale data only.",
  "const zoneLocalToday = (tz) => {",
  "  let fmt;",
  "  try { fmt = new Intl.DateTimeFormat('en-US', { timeZone: String(tz || 'UTC'), year: 'numeric', month: '2-digit', day: '2-digit' }); }",
  "  catch (tzError) { fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }); }",
  "  const p = {};",
  "  for (const part of fmt.formatToParts(new Date())) p[part.type] = part.value;",
  "  return p.year + '-' + p.month + '-' + p.day;",
  "};",
  "if(b.phenologicalStage!==undefined){",
  "  const nextStageKey = stageKeyOf(b.phenologicalStage);",
  "  if(!nextStageKey) sets.push(\"stage_started_on=CASE WHEN \" + storedStageKey + \" IS NOT NULL THEN NULL ELSE \" + (stageStartedOnSql || 'stage_started_on') + \" END\");",
  "  else if(stageStartedOnSql!==null) sets.push(\"stage_started_on=\" + stageStartedOnSql);",
  "  else {",
  "    const zoneTimezone = b.timezone != null && String(b.timezone).trim() ? String(b.timezone).trim() : owned[0].timezone;",
  "    sets.push(\"stage_started_on=CASE WHEN \" + storedStageKey + \" = \" + s(nextStageKey) + \" THEN stage_started_on ELSE \" + s(zoneLocalToday(zoneTimezone)) + \" END\");",
  "  }",
  "} else if(stageStartedOnSql!==null) sets.push(\"stage_started_on=\" + stageStartedOnSql);",
].join('\n') + '\n';

edit('zone-config-fn', [
  ["const weatherSourceInput = b.weatherSource !== undefined ? b.weatherSource : b.weather_source;\n",
    "const weatherSourceInput = b.weatherSource !== undefined ? b.weatherSource : b.weather_source;\n" +
    "const stageStartedOnInput = b.stageStartedOn !== undefined ? b.stageStartedOn : b.stage_started_on;\n"],
  // The ownership SELECT also reads the zone's timezone, for the zone-local today.
  ["SELECT id,name FROM irrigation_zones WHERE id=${zoneId}", "SELECT id,name,timezone FROM irrigation_zones WHERE id=${zoneId}"],
  ["if(b.phenologicalStage!==undefined)sets.push(\"phenological_stage=\"+s(b.phenologicalStage));\n",
    "if(b.phenologicalStage!==undefined)sets.push(\"phenological_stage=\"+s(b.phenologicalStage));\n" + ZONE_CONFIG_STAGE_DATE],
  ["COALESCE(prediction_card_enabled, 0) AS prediction_card_enabled,notes,weather_source FROM irrigation_zones WHERE id=",
    "COALESCE(prediction_card_enabled, 0) AS prediction_card_enabled,notes,weather_source,stage_started_on FROM irrigation_zones WHERE id="],
  ["  weather_source:z.weather_source || 'auto',weather_source_default:weatherSourceDefault\n});",
    "  weather_source:z.weather_source || 'auto',weather_source_default:weatherSourceDefault,stage_started_on:z.stage_started_on || null\n});"],
]);

edit('get-zones-query', [
  ["iz.notes, iz.weather_source,\n", "iz.notes, iz.weather_source, iz.stage_started_on,\n"],
]);

edit('get-zones-response', [
  ["  weather_source_default: weatherSourceDefault,\n", "  weather_source_default: weatherSourceDefault,\n  stage_started_on: r.stage_started_on || null,\n"],
]);

// The snapshots: stage_started_on is an ordinary zone field, sent on every zone (null
// when unset). The conditional spread sub-project 3's final fix wave gave weather_source
// (present only when not 'auto') stays as it is, and so does the text between
// 'prediction_card_enabled: …, ' and ', notes: z.notes,' that test-zone-weather-source.js
// evaluates as that spread: the new field goes after notes.
for (const id of ['sync-bootstrap-build', 'sync-force-build']) {
  edit(id, [
    ["iz.notes, iz.weather_source, iz.sync_version", "iz.notes, iz.weather_source, iz.stage_started_on, iz.sync_version"],
    ["} : {}), notes: z.notes, sync_version: z.sync_version,", "} : {}), notes: z.notes, stage_started_on: z.stage_started_on || null, sync_version: z.sync_version,"],
  ]);
}
// The capability joins sub-project 3's zone_config_weather_source_v1 at the end of the list.
for (const id of ['al-link-build-req', 'sync-bootstrap-build', 'sync-force-build']) {
  edit(id, [["'entity_name_commands_v1', 'zone_config_weather_source_v1'];", "'entity_name_commands_v1', 'zone_config_weather_source_v1', 'zone_config_stage_started_on_v1'];"]]);
}

fs.writeFileSync(CANONICAL, serialize(flows));
fs.writeFileSync(MIRROR, serialize(flows));
assertRoundtrip(CANONICAL);
assertRoundtrip(MIRROR);
console.log('edited zone-config-fn, get-zones-query, get-zones-response, sync-bootstrap-build, sync-force-build, al-link-build-req in both profiles');
```
```bash
node "$SCRATCH/flows-stage-started-on.js"
node scripts/verify-flows-fn-parse.js
```
Expected: `edited zone-config-fn, get-zones-query, get-zones-response, sync-bootstrap-build, sync-force-build, al-link-build-req in both profiles`; `verify-flows-fn-parse: OK`. In both snapshots the new field follows `notes`, outside the text between `prediction_card_enabled: …, ` and `, notes: z.notes,` that `test-zone-weather-source.js` evaluates as the `weather_source` spread; placed inside it, that test's two snapshot cases fail. `zone-config-fn` gains no `ALTER`; its ownership `SELECT` gains `timezone` and nothing else, because both stage-date rules read the stored stage inside the `UPDATE`. The table `STAGE_KEY` is `osi-crop-kc` `normalizeStage` spelled out (a function node reaches no helper module without `osiLib` wiring); `test-legacy-upsert-zone-config.js` checks the legacy node's copy of it against `normalizeStage` for twenty stored values (Task 3).

- [ ] **Step 4: AGENTS.md lists both zone capabilities**

`$SCRATCH/agents-capabilities.py` (rewrites the paragraph sub-project 3 left, keeping its statements on the edge's conditional `weather_source`):
```python
# One-shot (plan E2a, Task 2): AGENTS.md lists both zone capabilities and says how the
# edge sends each field; sub-project 3's weather_source sentences stay as they are.
import pathlib
p = pathlib.Path("AGENTS.md")
s = p.read_text(encoding="utf-8")
if s.count("**Sync capabilities the edge reports**") != 1:
    raise SystemExit("expected one capability paragraph")
start = s.index("**Sync capabilities the edge reports**")
end = s.index("\n\n", start)
if "`docs/contracts/sync-schema/README.md` and the deploy-order note there." not in s[start:end]:
    raise SystemExit("the paragraph is not the one sub-project 3 left")
s = s[:start] + """**Sync capabilities the edge reports** (built identically by `sync-bootstrap-build`,
`al-link-build-req` and `sync-force-build`): `linked_auth_sync_v1`,
`force_edge_sync_v1`, `installation_recovery_v1`, `installation_locations_v1`,
`entity_name_commands_v1`, `zone_config_weather_source_v1`,
`zone_config_stage_started_on_v1`, and `field_journal_v1` when the journal is
enabled. The cloud reads the list as `gatewayIdentity.syncCapabilities()` and sends
a name command only to a gateway that reported `entity_name_commands_v1`. From
sub-project 4 on it will put each zone field into `UPSERT_ZONE` and
`UPSERT_ZONE_CONFIG` only for a gateway that reported that field's capability:
`weatherSource` with `zone_config_weather_source_v1`, `stageStartedOn` with
`zone_config_stage_started_on_v1`; today cloud main sends neither field in zone
commands. The edge itself, on every zone update event and in the bootstrap and
force-sync snapshots, sends `weather_source` only when the stored value is not
`auto` or (update event only) changed in that update, never as an unconditional
default -- see "Zone weather_source" in `docs/contracts/sync-schema/README.md` and
the deploy-order note there. `stage_started_on` is an ordinary zone field: every
zone update event and both snapshots carry it, null when unset (see "Zone
`stage_started_on`" in the same README).""" + s[end:]
p.write_text(s, encoding="utf-8")
print("AGENTS.md: zone capabilities")
```
```bash
python3 "$SCRATCH/agents-capabilities.py"
node .claude/skills/anti-slop-writing/slop-check.js AGENTS.md
```
Expected: `AGENTS.md: zone capabilities`; `slop-check: PASS (no tier-1 findings)`.

- [ ] **Step 5: Size ratchet and identity pins**

`$SCRATCH/ratchet-e2-task2.js`:
```js
#!/usr/bin/env node
// Measures the named nodes and the per-profile total against origin/main and
// writes the exact allowances verify-flows-size-ratchet reads.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { nodeSizes, totalChars } = require(path.join(process.cwd(), 'scripts/flows-size-scan'));
const REL = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';
const FILE = 'scripts/verify-flows-size-ratchet-allowances.json';
const head = JSON.parse(fs.readFileSync(REL, 'utf8'));
const base = JSON.parse(execFileSync('git', ['show', 'origin/main:' + REL], { maxBuffer: 64 * 1024 * 1024 }).toString());
const h = nodeSizes(head);
const b = nodeSizes(base);
const before = fs.readFileSync(FILE, 'utf8');
const allowances = JSON.parse(before);
if (JSON.stringify(allowances, null, 2) + '\n' !== before) throw new Error(FILE + ' does not round-trip');
const SENTINEL = ' The live identity restart sentinel (Option C Slice 1) provenance that verify-live-gateway-identity.js pins for this node id is carried forward.';
const WHY = 'Daily agronomy parity (spec docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md), measured with verify-flows-size-ratchet nodeSizes over both byte-identical profiles: ';
const PRIOR = '. Supersedes the prior entry, whose growth this delta includes. ';
const NODES = {
  'zone-config-fn': (m) => `${WHY}${m}${PRIOR}PUT /api/irrigation-zones/:id/config validates and stores stageStartedOn / stage_started_on, clears it on a change of a set stage to unset, starts a stage changed without a date on the zone-local today, and returns stage_started_on.`,
  'get-zones-query': (m) => `${WHY}${m}${PRIOR}The zone list SELECT reads iz.stage_started_on.`,
  'get-zones-response': (m) => `${WHY}${m}${PRIOR}The zone list returns stage_started_on.`,
  'sync-bootstrap-build': (m) => `${WHY}${m}${PRIOR}The bootstrap zone snapshot carries stage_started_on and syncCapabilities gains zone_config_stage_started_on_v1.${SENTINEL}`,
  'sync-force-build': (m) => `${WHY}${m}${PRIOR}The force-sync zone snapshot carries stage_started_on and syncCapabilities gains zone_config_stage_started_on_v1.${SENTINEL}`,
  'al-link-build-req': (m) => `${WHY}${m}${PRIOR}syncCapabilities gains zone_config_stage_started_on_v1.${SENTINEL}`,
};
for (const [id, reason] of Object.entries(NODES)) {
  const delta = h.get(id).chars - b.get(id).chars;
  const measured = `origin/main ${b.get(id).chars} -> HEAD ${h.get(id).chars} = +${delta}`;
  allowances.node_allowances[id] = { delta, reason: reason(measured) };
  console.log(id, measured);
}
const totalDelta = totalChars(head) - totalChars(base);
allowances.total_allowance = {
  delta: totalDelta,
  reason: `Branch feat/daily-agronomy-parity, stacked on feat/weather-data-view and feat/daily-agronomy (the weather provider store, the daily agronomy record, the weather data view and daily agronomy parity, all unmerged to origin/main), measured with verify-flows-size-ratchet totalChars over both byte-identical profiles: origin/main ${totalChars(base)} -> HEAD ${totalChars(head)} = +${totalDelta}. Carried from feat/daily-agronomy: +4138 (weather-provider-tick 0, weather-provider-fn 1467, station-hours-fn 1525, agronomy-daily-fn 1515, zone-env-fn -369). Carried from feat/weather-data-view: +4307 (sync-init-fn 1394, zone-config-fn 737, get-zones-query 19, get-zones-response 337, sync-bootstrap-build 150, sync-force-build 150, al-link-build-req 33, 4f4a765f36cee6f3 1487). This branch: sync-init-fn (0064), zone-config-fn, get-zones-query, get-zones-response, sync-bootstrap-build, sync-force-build and al-link-build-req grew by the deltas of their node entries. When the earlier branches merge to origin/main their share moves into the base total and this entry drops by it.`,
};
console.log('total', `origin/main ${totalChars(base)} -> HEAD ${totalChars(head)} = +${totalDelta}`);
fs.writeFileSync(FILE, JSON.stringify(allowances, null, 2) + '\n');
```
```bash
node "$SCRATCH/ratchet-e2-task2.js"
node scripts/verify-flows-size-ratchet.js --write-baseline
node scripts/verify-flows-size-ratchet.js
```
Expected: `zone-config-fn origin/main 9706 -> HEAD 13771 = +4065`, `get-zones-query origin/main 4958 -> HEAD 4998 = +40`, `get-zones-response origin/main 1807 -> HEAD 2192 = +385`, `sync-bootstrap-build origin/main 44956 -> HEAD 45208 = +252`, `sync-force-build origin/main 68992 -> HEAD 69244 = +252`, `al-link-build-req origin/main 6709 -> HEAD 6777 = +68`, `total origin/main 1580418 -> HEAD 1592731 = +12313`; ratchet OK. This task's growth over sub-project 3: +3328, +21, +48, +102, +102, +35 (measured by running the one-shot on the rebased tree; pin what the script prints).

In `scripts/verify-live-gateway-identity.js`, `expectedGrowth` (keep every comment above each entry and add these):
```js
    // Daily agronomy parity (plan E2a Task 2): re-pinned from 150 to +252. This task adds
    // iz.stage_started_on to the zone SELECT, stage_started_on to the zone map (every zone,
    // null when unset) and zone_config_stage_started_on_v1 to syncCapabilities (+102) on top
    // of the weather data view's +150. Re-measured fresh: origin/main 44956 -> HEAD 45208 = +252.
    'sync-bootstrap-build': 252,
```
```js
    // Daily agronomy parity (plan E2a Task 2): re-pinned from 150 to +252, the same three
    // additions as sync-bootstrap-build. Re-measured fresh: origin/main 68992 -> HEAD 69244 = +252.
    'sync-force-build': 252,
```
```js
    // Daily agronomy parity (plan E2a Task 2): re-pinned from 33 to +68; syncCapabilities gains
    // zone_config_stage_started_on_v1. Re-measured fresh: origin/main 6709 -> HEAD 6777 = +68.
    'al-link-build-req': 68,
```
and the total pin from Task 1 becomes:
```js
  // 12313: plan E2a Task 2 adds zone-config-fn (+3328), get-zones-query (+21), get-zones-response
  // (+48), sync-bootstrap-build (+102), sync-force-build (+102) and al-link-build-req (+35) to
  // Task 1's 8677. verify-flows-size-ratchet totalChars over both byte-identical profiles:
  // origin/main 1580418 -> HEAD 1592731 = +12313.
  expectCondition(sizeAllowances.total_allowance?.delta === 12313,
    'size total allowance: exact cumulative delta 12313',
    'size total allowance: expected exact cumulative delta 12313');
```
The reasons the script writes for the three sentinel nodes contain `live identity restart sentinel (Option C Slice 1)`, which the loop after `expectedGrowth` requires.

- [ ] **Step 6: Run the gates**

```bash
node --test scripts/test-zone-update-sync-version.js scripts/test-zone-weather-source.js scripts/test-entity-name-command-path.js scripts/test-scoped-access-reads.js scripts/test-scoped-access-writes.js scripts/test-terra-selection-edge-acceptance.js
node scripts/test-journal-bootstrap.js
node scripts/verify-profile-parity.js && node scripts/verify-flows-fn-parse.js && node scripts/flows-bare-require-scan.js && node scripts/test-flows-wiring.js && node scripts/verify-no-new-silent-catch.js && node scripts/verify-no-stray-ddl.js && node scripts/verify-osi-lib-db-caller-binding.js
node scripts/generate-sync-trigger-source.js --check
node scripts/verify-flows-size-ratchet.js && node scripts/verify-live-gateway-identity.js && node scripts/verify-sync-flow.js
node --test scripts/verify-auth-flag-off-hermetic.test.js
```
Expected: `test-zone-update-sync-version.js` `# pass 14`: the runner prints 7 before this task (three tests on each of the two profiles and one cross-profile test), and this task adds six route and list tests and one bootstrap test. Pin the count the runner prints. The other suites `# fail 0`; `test-journal-bootstrap.js` all pass; the static gates pass; the trigger check passes; ratchet OK, `Live gateway identity verification passed.`, verify-sync-flow ends `All parity checks passed.`; the auth hermetic test passes (`zone-config-fn`'s auth block is untouched).

- [ ] **Step 7: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/test-zone-update-sync-version.js scripts/verify-sync-flow.js scripts/test-entity-name-command-path.js scripts/test-journal-bootstrap.js AGENTS.md scripts/verify-flows-size-ratchet-allowances.json scripts/verify-flows-size-ratchet-baseline.json scripts/verify-live-gateway-identity.js
git -c user.name=Project-OSI commit -m "feat(flows): zone stage_started_on on the config route, the zone list, both snapshots; capability zone_config_stage_started_on_v1"
```

---

### Task 3: Cloud-to-edge command paths and the contract

**Files:**
- Create: `scripts/test-legacy-upsert-zone-config.js`
- Modify (by one-shot script): both `flows.json`, node `4f4a765f36cee6f3` ("Build UPDATE SQL")
- Modify: `.../osi-zone-commands/index.js` and its bcm2709 mirror, `docs/contracts/sync-schema/resources.schema.json` (definition `Zone`), `docs/contracts/sync-schema/README.md`, `scripts/test-contract-schemas.js`, `scripts/test-zone-command-path.js`, `scripts/test-terra-zone-config-command-flow.js`, `scripts/test-terra-selection-edge-acceptance.js`, `scripts/fixtures/terra-edge-selection/edge-selection-v1.json` and `.sha256` (regenerated), `scripts/verify-sync-flow.js`, `.github/workflows/verify-sync-flow.yml`, `scripts/verify-flows-size-ratchet-allowances.json`, `scripts/verify-flows-size-ratchet-baseline.json`, `scripts/verify-live-gateway-identity.js`
- Unchanged: the Terra `UPSERT_ZONE_CONFIG` field set; `updateLocation`; `events.schema.json`
- Scratch: `$SCRATCH/flows-build-update-sql-stage.js`, `$SCRATCH/zone-commands-stage.py`, `$SCRATCH/contract-e2.py`, `$SCRATCH/sync-schema-readme-e2a.py`, `$SCRATCH/ratchet-e2-task3.js`

**Interfaces:**
- Consumes: the 0064 trigger (Task 1): an applied command emits one `ZONE` event carrying `stage_started_on`.
- Produces:
  - Legacy `UPSERT_ZONE_CONFIG` (`var ssd = cmd.stageStartedOn !== undefined ? cmd.stageStartedOn : cmd.stage_started_on;` in the spec's words): a present `null`, `''` or valid `YYYY-MM-DD` sets the column; an invalid value leaves it and warns once naming the zone UUID; an absent key leaves it. A command that carries a stage (`phenologicalStage` or `phenological_stage`) follows `stageStartedOnRuleSql`: not a set stage clears the date when the stored stage is set; a set stage takes a supplied valid date, else keeps the stored date for the same stage key and starts another stage on today in `cmd.timezone` (UTC without one).
  - Legacy `UPSERT_ZONE` (the flat full upsert): inserts the valid date or NULL; on conflict the same rules against `irrigation_zones.phenological_stage`, with `excluded.stage_started_on` as the supplied date and today in `cmd.timezone || 'UTC'`, the timezone the branch already writes.
  - Terra `UPSERT_ZONE_CONFIG` (`osi-zone-commands` `applyOnce`): the same rules through `normalizeStage` (required from `osi-crop-kc`) on the row it already reads, today in the zone's stored timezone; the Terra field list stays exact, so the command never carries a date.
  - Protected `UPSERT_ZONE`: optional `zone.stage_started_on` (`null` or a calendar date `YYYY-MM-DD`, else `malformed_command` → `REJECTED_PERMANENT`); `insertZone` writes it (NULL when absent); `updateFullZone` writes it only when the key is present. `UPSERT_ZONE_LOCATION` and `DELETE_ZONE` do not accept it.
  - `resources.schema.json` `Zone.stage_started_on`: `{"type": ["string", "null"], "format": "date"}`, not required; `test-contract-schemas.js` supports the `date` format. The cloud's plan CC1 copies this file byte for byte.

- [ ] **Step 1: Write the failing tests**

`scripts/test-legacy-upsert-zone-config.js`:
```js
#!/usr/bin/env node
'use strict';

// Legacy UPSERT_ZONE_CONFIG and UPSERT_ZONE branches of node 4f4a765f36cee6f3
// ("Build UPDATE SQL") and the zone stage start date (spec
// docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, B5). Builds
// the statement with the shipped function-node source and runs it against a
// seeded database, so the assertions are about the row, not the SQL string.
// The stage-date rules: controller rulings cloud/sync I7 (a change to unset
// clears) and plan review E2 I2 (another set stage without a date starts today).
//
// Run: node --test scripts/test-legacy-upsert-zone-config.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { executeFunction, loadNode } = require('./lib/scoped-access-harness');
const { normalizeStage } = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc');

const ROOT = path.resolve(__dirname, '..');
const SEED = fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8');
const GATEWAY = '00000000000000B1';
const ZONE_UUID = '44444444-4444-4444-8444-444444444444';
const USER_UUID = '55555555-5555-4555-8555-555555555555';

function fixture({ stage = 'development', startedOn = '2026-04-20', withZone = true } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(SEED);
  db.exec("INSERT INTO users(id, username, password_hash, created_at, user_uuid, role, sync_version) "
    + `VALUES (1,'grower','x','2026-01-01','${USER_UUID}','admin',1)`);
  if (withZone) {
    db.prepare('INSERT INTO irrigation_zones(id, name, user_id, zone_uuid, gateway_device_eui, sync_version, timezone, '
      + "phenological_stage, stage_started_on, created_at, updated_at) VALUES (1, 'North', 1, ?, ?, 3, 'UTC', ?, ?, '2026-01-01', '2026-01-01')")
      .run(ZONE_UUID, GATEWAY, stage, startedOn);
  }
  return db;
}

async function apply(db, cmd) {
  const run = await executeFunction(loadNode('4f4a765f36cee6f3'), {
    msg: { payload: { zoneUuid: ZONE_UUID, syncVersion: 9, ...cmd } },
    env: { DEVICE_EUI: GATEWAY },
    db,
  });
  assert.equal(typeof run.result.topic, 'string', 'the node must build a statement');
  db.exec(run.result.topic);
  return run;
}

function row(db) {
  return { ...db.prepare('SELECT phenological_stage, stage_started_on, notes FROM irrigation_zones WHERE zone_uuid = ?').get(ZONE_UUID) };
}

// Today in a timezone, read the way the node reads it, before and after a call:
// either value passes, so a midnight during the run cannot fail a test.
function localToday(timezone) {
  const p = {};
  for (const part of new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date())) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}
async function todayAround(timezone, work) {
  const before = localToday(timezone);
  await work();
  return [before, localToday(timezone)];
}

const CONFIG = { commandType: 'UPSERT_ZONE_CONFIG' };

test('UPSERT_ZONE_CONFIG: stageStartedOn sets, null clears, the snake-case key works', async () => {
  const db = fixture();
  try {
    await apply(db, { ...CONFIG, stageStartedOn: '2026-05-01' });
    assert.equal(row(db).stage_started_on, '2026-05-01');
    await apply(db, { ...CONFIG, stageStartedOn: null });
    assert.equal(row(db).stage_started_on, null);
    await apply(db, { ...CONFIG, stage_started_on: '2026-05-02' });
    assert.equal(row(db).stage_started_on, '2026-05-02');
  } finally {
    db.close();
  }
});

test('UPSERT_ZONE_CONFIG: an absent key leaves the column; an invalid date leaves it and warns once with the zone UUID', async () => {
  const db = fixture();
  try {
    const quiet = await apply(db, { ...CONFIG, notes: 'no date' });
    assert.deepEqual([row(db).stage_started_on, row(db).notes], ['2026-04-20', 'no date']);
    assert.deepEqual(quiet.warnings, []);
    const bad = await apply(db, { ...CONFIG, stageStartedOn: '2026-02-30', notes: 'kept going' });
    assert.deepEqual([row(db).stage_started_on, row(db).notes], ['2026-04-20', 'kept going']);
    assert.equal(bad.warnings.length, 1);
    assert.match(bad.warnings[0], new RegExp(ZONE_UUID));
  } finally {
    db.close();
  }
});

test('UPSERT_ZONE_CONFIG: a stage change from development to default clears the date, whatever the command says about it', async () => {
  const db = fixture();
  try {
    await apply(db, { ...CONFIG, phenologicalStage: 'default', stageStartedOn: '2026-05-01' });
    assert.deepEqual([row(db).phenological_stage, row(db).stage_started_on], ['default', null]);
  } finally {
    db.close();
  }
});

test('UPSERT_ZONE_CONFIG: a notes-only command with stage default on a zone already unset leaves the date; a set stage then starts today', async () => {
  const db = fixture({ stage: 'default', startedOn: '2026-04-20' });
  try {
    await apply(db, { ...CONFIG, phenologicalStage: 'default', notes: 'notes only' });
    assert.deepEqual([row(db).stage_started_on, row(db).notes], ['2026-04-20', 'notes only']);
    const days = await todayAround('UTC', () => apply(db, { ...CONFIG, phenological_stage: 'mid_season' }));
    assert.equal(row(db).phenological_stage, 'mid_season');
    assert.ok(days.includes(row(db).stage_started_on), 'unset to a set stage starts it today (UTC: the command names no timezone)');
  } finally {
    db.close();
  }
});

test('UPSERT_ZONE_CONFIG: another set stage without a date starts on the command zone-local today; the same stage keeps it; a supplied date wins', async () => {
  const db = fixture({ stage: 'development', startedOn: '2026-04-20' });
  try {
    // A UTC+14 zone: its date, not the gateway's.
    const days = await todayAround('Pacific/Kiritimati', () => apply(db, { ...CONFIG, phenologicalStage: 'late_season', timezone: 'Pacific/Kiritimati' }));
    assert.ok(days.includes(row(db).stage_started_on), String(row(db).stage_started_on));
    db.prepare("UPDATE irrigation_zones SET stage_started_on = '2026-08-01' WHERE zone_uuid = ?").run(ZONE_UUID);
    await apply(db, { ...CONFIG, phenologicalStage: 'harvest', timezone: 'Pacific/Kiritimati' });
    assert.equal(row(db).stage_started_on, '2026-08-01', 'harvest is the late season: the same stage keeps the date');
    await apply(db, { ...CONFIG, phenologicalStage: 'mid_season', stageStartedOn: '2026-07-15' });
    assert.equal(row(db).stage_started_on, '2026-07-15', 'a supplied date wins');
    const ignored = await todayAround('UTC', () => apply(db, { ...CONFIG, phenologicalStage: 'initial', stageStartedOn: '2026-02-30' }));
    assert.ok(ignored.includes(row(db).stage_started_on), 'an invalid date is ignored with its warning, so the stage change starts today');
  } finally {
    db.close();
  }
});

test('the node treats a stored stage as set exactly when osi-crop-kc normalizeStage maps it', async () => {
  for (const stored of ['initial', 'development', 'mid_season', 'late_season', 'dormancy', 'budbreak', 'bud_break', 'fruitset', 'cell_division', 'cell_expansion', 'veraison', 'fruit_maturation', 'harvest', 'post_harvest', ' Veraison ', 'default', '', null, 'flowering', 'mid-season']) {
    const db = fixture({ stage: stored, startedOn: '2026-04-20' });
    try {
      await apply(db, { ...CONFIG, phenologicalStage: 'default' });
      assert.equal(row(db).stage_started_on, normalizeStage(stored) ? null : '2026-04-20', JSON.stringify(stored));
    } finally {
      db.close();
    }
  }
});

test('legacy UPSERT_ZONE: inserts the valid date or NULL; on conflict a supplied date wins, the same stage keeps it, another set stage starts today, unset clears it', async () => {
  const db = fixture({ withZone: false });
  try {
    const upsert = { commandType: 'UPSERT_ZONE', name: 'North', gatewayDeviceEui: GATEWAY, user: { userUuid: USER_UUID } };
    await apply(db, upsert);
    assert.equal(row(db).stage_started_on, null);
    await apply(db, { ...upsert, syncVersion: 10, phenologicalStage: 'development', stageStartedOn: '2026-05-01' });
    assert.equal(row(db).stage_started_on, '2026-05-01');
    await apply(db, { ...upsert, syncVersion: 11, phenologicalStage: 'development' });
    assert.equal(row(db).stage_started_on, '2026-05-01', 'the same stage keeps the date');
    const bad = await apply(db, { ...upsert, syncVersion: 12, phenologicalStage: 'development', stageStartedOn: '01.05.2026' });
    assert.equal(row(db).stage_started_on, '2026-05-01');
    assert.equal(bad.warnings.length, 1);
    const days = await todayAround('Pacific/Kiritimati', () => apply(db, { ...upsert, syncVersion: 13, phenologicalStage: 'late_season', timezone: 'Pacific/Kiritimati' }));
    assert.ok(days.includes(row(db).stage_started_on), 'another set stage starts on the zone-local today');
    await apply(db, { ...upsert, syncVersion: 14, stageStartedOn: null });
    assert.equal(row(db).stage_started_on, null, 'a full upsert without a stage stores default (unset), which clears the date');
  } finally {
    db.close();
  }
});
```

Append to `scripts/test-zone-command-path.js`:
```js

// Stage start date on the protected zone command (spec
// docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md, B5).
test('a full UPSERT_ZONE sets stage_started_on, null clears it, and a command without the key keeps it', async () => {
  commands._resetForTests();
  const db = database();
  try {
    seedZone(db.raw);
    db.raw.prepare("UPDATE irrigation_zones SET stage_started_on='2026-04-01' WHERE zone_uuid=?").run(ZONE_UUID);
    const stored = () => db.raw.prepare('SELECT stage_started_on FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).stage_started_on;
    const set = await commands.applyZoneCommand(db.facade, envelope(21, 'UPSERT_ZONE', 1, { stage_started_on: '2026-05-01' }), runtime());
    assert.equal(set.ack.result, 'APPLIED');
    assert.equal(stored(), '2026-05-01');
    const event = JSON.parse(db.raw.prepare(
      "SELECT payload_json FROM sync_outbox WHERE aggregate_type='ZONE' ORDER BY rowid DESC LIMIT 1"
    ).get().payload_json);
    assert.equal(event.stage_started_on, '2026-05-01');
    assert.equal((await commands.applyZoneCommand(db.facade, envelope(22, 'UPSERT_ZONE', 2, { notes: 'kept' }), runtime())).ack.result, 'APPLIED');
    assert.equal(stored(), '2026-05-01', 'the key absent keeps the stored value');
    assert.equal((await commands.applyZoneCommand(db.facade, envelope(23, 'UPSERT_ZONE', 3, { stage_started_on: null }), runtime())).ack.result, 'APPLIED');
    assert.equal(stored(), null);
  } finally {
    db.raw.close();
  }
});

test('a protected create writes stage_started_on; a malformed date or a location command carrying it is refused', async () => {
  commands._resetForTests();
  const db = database();
  try {
    const created = await commands.applyZoneCommand(db.facade, envelope(31, 'UPSERT_ZONE', 0, { stage_started_on: '2026-05-01' }), runtime());
    assert.equal(created.ack.result, 'APPLIED');
    assert.equal(db.raw.prepare('SELECT stage_started_on FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).stage_started_on, '2026-05-01');
    let id = 32;
    for (const bad of ['05/01/2026', '2026-02-30', '2026-5-1', 20260501]) {
      const refused = await commands.applyZoneCommand(db.facade, envelope(id, 'UPSERT_ZONE', 1, { stage_started_on: bad }), runtime());
      assert.equal(refused.ack.result, 'REJECTED_PERMANENT', String(bad));
      id += 1;
    }
    const location = await commands.applyZoneCommand(db.facade, envelope(id, 'UPSERT_ZONE_LOCATION', 1, { stage_started_on: '2026-05-01' }), runtime());
    assert.equal(location.ack.result, 'REJECTED_PERMANENT');
    assert.equal(db.raw.prepare('SELECT stage_started_on, sync_version FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).sync_version, 1);
  } finally {
    db.raw.close();
  }
});
```

Append to `scripts/test-terra-zone-config-command-flow.js`:
```js

// Daily agronomy parity (spec B5): the Terra shape keeps its exact field list, so
// a Terra UPSERT_ZONE_CONFIG carrying stageStartedOn is refused before any write.
test('a Terra UPSERT_ZONE_CONFIG carrying stageStartedOn is refused by the exact field list', async () => {
  const commands = require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-commands');
  const envelope = {
    commandId: 9201, commandType: 'UPSERT_ZONE_CONFIG', eventUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    aggregateType: 'ZONE', aggregateKey: ZONE_UUID, appliedSyncVersion: 4, effectKey: null,
    payload: {
      commandType: 'UPSERT_ZONE_CONFIG', zoneUuid: ZONE_UUID, gatewayDeviceEui: GATEWAY_EUI,
      ownerUserUuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', baseSyncVersion: 3, syncVersion: 4,
      cropType: 'maize', variety: null, phenologicalStage: 'development', terraConfigurationOperation: true,
      stageStartedOn: '2026-05-01',
    },
  };
  const noTransaction = { transaction: async () => { throw new Error('the refusal must come before any transaction'); } };
  await assert.rejects(
    commands.applyZoneCommand(noTransaction, envelope, { command_type_recognized: true, gateway_device_eui: GATEWAY_EUI }),
    (error) => error.code === 'malformed_command' && /extra=stageStartedOn/.test(error.message),
  );
});
```

Append to `scripts/test-terra-selection-edge-acceptance.js` (its `database()` fixture holds zone `North` in `Europe/Zurich` at stage `flowering`, which `normalizeStage` reads as unset, at sync version 42):
```js
// Daily agronomy parity (spec B5; controller ruling on plan review E2 I2): the Terra
// shape carries no start date, so a change to another set stage starts it on the
// zone-local today, the same stage keeps it and a change to unset clears it.
test('a Terra stage change starts the stage on the zone-local date; the same stage keeps it; unset clears it', async () => {
  const commands = loadCommands();
  if (typeof commands._resetForTests === 'function') commands._resetForTests();
  const db = database();
  try {
    const startedOn = () => db.raw.prepare('SELECT stage_started_on FROM irrigation_zones WHERE zone_uuid=?').get(ZONE_UUID).stage_started_on;
    // 22:30 UTC on 3 August is 00:30 on 4 August in the zone's Europe/Zurich.
    const first = await withFixedClock('2026-08-03T22:30:00.000Z', () => apply(commands, db, envelope(9401, 42, 43)));
    assert.equal(first.ack.result, 'APPLIED');
    assert.equal(startedOn(), '2026-08-04', 'flowering (unset) to development starts the stage on the zone-local date');
    await withFixedClock('2026-08-10T10:00:00.000Z', () => apply(commands, db, envelope(9402, 43, 44)));
    assert.equal(startedOn(), '2026-08-04', 'development again keeps the date');
    await withFixedClock('2026-08-20T10:00:00.000Z', () => apply(commands, db, envelope(9403, 44, 45, { phenologicalStage: 'late_season' })));
    assert.equal(startedOn(), '2026-08-20');
    await withFixedClock('2026-08-21T10:00:00.000Z', () => apply(commands, db, envelope(9404, 45, 46, { phenologicalStage: 'default' })));
    assert.equal(startedOn(), null, 'a change to unset clears the date');
  } finally {
    db.raw.close();
  }
});
```

Append before the line `if (!ok) process.exit(1);` of `scripts/test-contract-schemas.js` (the third line from the end, before the PASS line and the export):
```js

// Daily agronomy parity (plan E2a): a zone may carry its stage start date, a
// calendar date or null.
expectValid(
    'a Zone resource with a stage start date',
    resourcesSchema.definitions.Zone,
    { zone_id: 1, name: 'North', stage_started_on: '2026-05-01' },
    resourcesSchema
);
expectValid(
    'a Zone resource with a cleared stage start date',
    resourcesSchema.definitions.Zone,
    { zone_id: 1, name: 'North', stage_started_on: null },
    resourcesSchema
);
expectInvalid(
    'a Zone resource with an impossible stage start date',
    resourcesSchema.definitions.Zone,
    { zone_id: 1, name: 'North', stage_started_on: '2026-02-30' },
    /format date/,
    resourcesSchema
);
expectInvalid(
    'a Zone resource with a stage start date in another notation',
    resourcesSchema.definitions.Zone,
    { zone_id: 1, name: 'North', stage_started_on: '05/01/2026' },
    /format date/,
    resourcesSchema
);
```

In `scripts/verify-sync-flow.js`, after sub-project 3's `expectIncludesById('4f4a765f36cee6f3', 'weather_source=excluded.weather_source', 'stores weather_source from a legacy UPSERT_ZONE and keeps the stored value when absent');` add:
```js
expectIncludesById('4f4a765f36cee6f3', "sets.push('stage_started_on = ' + configStageStartedOn.sql)", 'stores stage_started_on from a legacy UPSERT_ZONE_CONFIG');
expectIncludesById('4f4a765f36cee6f3', "stageStartedOnRuleSql('irrigation_zones.phenological_stage'", 'applies the stage-date rules to a legacy UPSERT_ZONE of a stored zone');
expectIncludesById('4f4a765f36cee6f3', 'function stageStartedOnRuleSql(', 'clears on unset and starts a changed stage on the zone-local today, inside the statement');
expectIncludesById('4f4a765f36cee6f3', 'carried an invalid stage_started_on for', 'warns once, naming the zone, instead of storing an invalid start date');
```

In `.github/workflows/verify-sync-flow.yml`, the `run:` line of Task 1's step `Zone stage start date round trip` becomes:
```yaml
        run: node --test scripts/test-stage-started-on-migration.js scripts/test-legacy-upsert-zone-config.js
```

- [ ] **Step 2: Run the tests to see them fail**

```bash
node --test scripts/test-legacy-upsert-zone-config.js scripts/test-zone-command-path.js scripts/test-terra-zone-config-command-flow.js
node scripts/test-contract-schemas.js
```
```bash
node --test scripts/test-terra-selection-edge-acceptance.js
```
Expected: `test-legacy-upsert-zone-config.js` fails all seven tests (the column never changes, and each test asserts a changed or cleared date at least once); in `test-zone-command-path.js` the two new tests fail (`shape mismatch; missing=none, extra=stage_started_on` gives `REJECTED_PERMANENT` for a valid date); the Terra refusal test passes already (it pins behaviour this plan must keep); in `test-terra-selection-edge-acceptance.js` the new stage-date test fails (`stage_started_on` stays null) and the other 21 pass; the contract script fails the two "impossible date" and "another notation" checks, because `stage_started_on` is not declared yet and nothing constrains it.

- [ ] **Step 3: The legacy path, one-shot flows edit**

`$SCRATCH/flows-build-update-sql-stage.js`:
```js
#!/usr/bin/env node
// One-shot (plan E2a, Task 3): the legacy "Build UPDATE SQL" node (4f4a765f36cee6f3)
// stores stage_started_on from UPSERT_ZONE_CONFIG and legacy UPSERT_ZONE, with the
// clearing rule and the stage-date default (controller rulings cloud/sync I7, plan review E2 I2).
'use strict';
const fs = require('fs');
const path = require('path');
const REPO_ROOT = process.cwd();
const CANONICAL = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const MIRROR = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json');
function serialize(flows) { return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8'); }
function assertRoundtrip(filePath) {
  const original = fs.readFileSync(filePath);
  const parsed = JSON.parse(original.toString('utf8'));
  if (Buffer.compare(original, serialize(parsed)) !== 0) throw new Error('roundtrip guard failed for ' + filePath);
  return parsed;
}
const flows = assertRoundtrip(CANONICAL);
if (Buffer.compare(fs.readFileSync(CANONICAL), fs.readFileSync(MIRROR)) !== 0) throw new Error('profiles differ before the edit');
const node = flows.find((n) => n.id === '4f4a765f36cee6f3');
if (!node) throw new Error('4f4a765f36cee6f3 not found');
const swaps = [
  // Shared helpers: the stage start date and the set stage keys (osi-crop-kc normalizeStage).
  ["function deviceEui(cmd) { return String(cmd.deviceEui || cmd.device_eui || cmd.devEui || '').trim().toUpperCase(); }\n",
    "function deviceEui(cmd) { return String(cmd.deviceEui || cmd.device_eui || cmd.devEui || '').trim().toUpperCase(); }\n" +
    "// Stage start date (spec 2026-09-27-daily-agronomy-parity B5): { present, sql } where sql is\n" +
    "// NULL or a quoted calendar date; an absent key or an invalid value is not present, and an\n" +
    "// invalid value is warned once with the zone UUID (the legacy path has no rejection channel).\n" +
    "function stageStartedOnOf(cmd, zoneUuid) {\n" +
    "  if (cmd.stageStartedOn === undefined && cmd.stage_started_on === undefined) return { present: false, sql: null };\n" +
    "  var raw = cmd.stageStartedOn !== undefined ? cmd.stageStartedOn : cmd.stage_started_on;\n" +
    "  var text = raw === null ? '' : String(raw).trim();\n" +
    "  if (!text) return { present: true, sql: 'NULL' };\n" +
    "  var m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(text);\n" +
    "  if (m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString().slice(0, 10) === text) return { present: true, sql: s(text) };\n" +
    "  node.warn('Build UPDATE SQL: ' + commandType + ' carried an invalid stage_started_on for ' + String(zoneUuid) + '; keeping the stored date');\n" +
    "  return { present: false, sql: null };\n" +
    "}\n" +
    "// osi-crop-kc normalizeStage as a table: the five FAO keys and the nine legacy keys; anything else is unset.\n" +
    "var STAGE_KEY = { initial: 'initial', development: 'development', mid_season: 'mid_season', late_season: 'late_season', dormancy: 'dormancy', budbreak: 'initial', bud_break: 'initial', fruitset: 'development', cell_division: 'development', cell_expansion: 'development', veraison: 'mid_season', fruit_maturation: 'mid_season', harvest: 'late_season', post_harvest: 'late_season' };\n" +
    "function stageKeyOf(v) { var k = String(v == null ? '' : v).trim().toLowerCase(); return Object.prototype.hasOwnProperty.call(STAGE_KEY, k) ? STAGE_KEY[k] : null; }\n" +
    "function storedStageKeySql(column) { return '(CASE lower(trim(COALESCE(' + column + \", ''))) \" + Object.keys(STAGE_KEY).map(function (k) { return \"WHEN '\" + k + \"' THEN '\" + STAGE_KEY[k] + \"'\"; }).join(' ') + ' END)'; }\n" +
    "// Today in the zone's timezone; UTC for a missing or unknown zone id, as osi-agronomy-daily reads it.\n" +
    "function zoneLocalToday(tz) {\n" +
    "  var fmt;\n" +
    "  try { fmt = new Intl.DateTimeFormat('en-US', { timeZone: String(tz || 'UTC'), year: 'numeric', month: '2-digit', day: '2-digit' }); }\n" +
    "  catch (tzError) { fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }); }\n" +
    "  var p = {};\n" +
    "  fmt.formatToParts(new Date()).forEach(function (part) { p[part.type] = part.value; });\n" +
    "  return p.year + '-' + p.month + '-' + p.day;\n" +
    "}\n" +
    "// The stage-date rules for a command that carries a stage: a change to unset clears the date\n" +
    "// whatever the command says; otherwise a supplied date wins; a change to another set stage starts\n" +
    "// it on the zone-local today; the same stage keeps the stored date. The node builds SQL text and\n" +
    "// never reads the row, so the stored stage is compared inside the statement, a CASE on `column`\n" +
    "// (SQLite evaluates every SET expression against the row before the update).\n" +
    "function stageStartedOnRuleSql(column, dateColumn, nextStage, suppliedSql, timezone) {\n" +
    "  var nextKey = stageKeyOf(nextStage);\n" +
    "  if (!nextKey) return 'CASE WHEN ' + storedStageKeySql(column) + ' IS NOT NULL THEN NULL ELSE ' + (suppliedSql || dateColumn) + ' END';\n" +
    "  if (suppliedSql) return suppliedSql;\n" +
    "  return 'CASE WHEN ' + storedStageKeySql(column) + ' = ' + s(nextKey) + ' THEN ' + dateColumn + ' ELSE ' + s(zoneLocalToday(timezone)) + ' END';\n" +
    "}\n"],
  // Legacy UPSERT_ZONE: a create writes the valid date or NULL; a stored zone follows the
  // stage-date rules against its stored stage, today in cmd.timezone || 'UTC' (the timezone
  // this branch already writes).
  ["  var conflictWeatherSource = zoneWeatherSource === null ? 'weather_source=irrigation_zones.weather_source' : 'weather_source=excluded.weather_source';\n",
    "  var conflictWeatherSource = zoneWeatherSource === null ? 'weather_source=irrigation_zones.weather_source' : 'weather_source=excluded.weather_source';\n" +
    "  var zoneStageStartedOn = stageStartedOnOf(cmd, zoneUuid);\n" +
    "  var conflictStageStartedOn = 'stage_started_on=' + stageStartedOnRuleSql('irrigation_zones.phenological_stage', 'irrigation_zones.stage_started_on', cmd.phenologicalStage || cmd.phenological_stage || 'default', zoneStageStartedOn.present ? 'excluded.stage_started_on' : null, cmd.timezone || 'UTC');\n"],
  ["notes, sync_version, deleted_at, weather_source) \" +",
    "notes, sync_version, deleted_at, weather_source, stage_started_on) \" +"],
  ["\", \" + s(zoneWeatherSource || 'auto') + \" FROM users WHERE \"",
    "\", \" + s(zoneWeatherSource || 'auto') + \", \" + (zoneStageStartedOn.sql || 'NULL') + \" FROM users WHERE \""],
  ["deleted_at=excluded.deleted_at, \" + conflictWeatherSource;",
    "deleted_at=excluded.deleted_at, \" + conflictWeatherSource + \", \" + conflictStageStartedOn;"],
  // UPSERT_ZONE_CONFIG: both rules compare with the stored stage inside the UPDATE; the
  // zone-local today uses the command's timezone (a capable cloud's desired state carries it), else UTC.
  ["  sets.push('updated_at = ' + s(now));\n  sets.push('sync_version = ' + n(cmd.appliedSyncVersion || cmd.syncVersion || 1, 1));\n  msg.topic = 'UPDATE irrigation_zones SET ' + sets.join(', ') + ' WHERE zone_uuid = ' + s(cmd.zoneUuid || cmd.zone_uuid);",
    "  var configStageStartedOn = stageStartedOnOf(cmd, cmd.zoneUuid || cmd.zone_uuid);\n" +
    "  if (cmd.phenologicalStage !== undefined || cmd.phenological_stage !== undefined) {\n" +
    "    var configStage = cmd.phenologicalStage !== undefined ? cmd.phenologicalStage : cmd.phenological_stage;\n" +
    "    sets.push('stage_started_on = ' + stageStartedOnRuleSql('phenological_stage', 'stage_started_on', configStage, configStageStartedOn.present ? configStageStartedOn.sql : null, cmd.timezone));\n" +
    "  } else if (configStageStartedOn.present) {\n" +
    "    sets.push('stage_started_on = ' + configStageStartedOn.sql);\n" +
    "  }\n" +
    "  sets.push('updated_at = ' + s(now));\n  sets.push('sync_version = ' + n(cmd.appliedSyncVersion || cmd.syncVersion || 1, 1));\n  msg.topic = 'UPDATE irrigation_zones SET ' + sets.join(', ') + ' WHERE zone_uuid = ' + s(cmd.zoneUuid || cmd.zone_uuid);"],
];
for (const [from, to] of swaps) {
  const count = node.func.split(from).length - 1;
  if (count !== 1) throw new Error(`expected one match, found ${count}: ${from.slice(0, 80)}`);
  node.func = node.func.replace(from, to);
}
fs.writeFileSync(CANONICAL, serialize(flows));
fs.writeFileSync(MIRROR, serialize(flows));
assertRoundtrip(CANONICAL);
assertRoundtrip(MIRROR);
console.log('edited 4f4a765f36cee6f3 in both profiles');
```
```bash
node "$SCRATCH/flows-build-update-sql-stage.js"
node scripts/verify-flows-fn-parse.js
```
Expected: `edited 4f4a765f36cee6f3 in both profiles`; `verify-flows-fn-parse: OK`. The node builds SQL text and never reads the row, so both stage-date rules are a `CASE` on the stored stage inside the `UPDATE` (SQLite evaluates every `SET` expression, the `ON CONFLICT DO UPDATE` ones included, against the row before the update). The zone-local today of `UPSERT_ZONE_CONFIG` uses the command's `timezone`, which a capable cloud's desired state always carries; without one it is UTC. A capable cloud also always sends `stageStartedOn` (spec C9), so on this path the default fires only for a command from a cloud that does not send the field.

- [ ] **Step 4: The protected path in `osi-zone-commands`**

`$SCRATCH/zone-commands-stage.py`:
```python
# One-shot (plan E2a, Task 3): protected UPSERT_ZONE carries stage_started_on; the Terra
# path applies the stage-date rules.
import pathlib
p = pathlib.Path("conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-commands/index.js")
s = p.read_text(encoding="utf-8")
def swap(old, new):
    global s
    if s.count(old) != 1:
        raise SystemExit("expected one match for: " + old[:80])
    s = s.replace(old, new)
swap("""    type === 'DELETE_ZONE' ? [] : ['weather_source']
  );""", """    type === 'DELETE_ZONE' ? [] :
      // stage_started_on is optional on the full zone command only (spec
      // 2026-09-27-daily-agronomy-parity B5); a location command never carries it.
      type === 'UPSERT_ZONE' ? ['weather_source', 'stage_started_on'] : ['weather_source']
  );""")
swap("""      result.weatherSource = weatherSource || null;
    }
""", """      result.weatherSource = weatherSource || null;
    }
    // Absent: updateFullZone keeps the stored date. null: clears. Otherwise a
    // calendar date YYYY-MM-DD, else malformed_command (REJECTED_PERMANENT).
    result.hasStageStartedOn = Object.prototype.hasOwnProperty.call(zone, 'stage_started_on');
    result.stageStartedOn = null;
    if (result.hasStageStartedOn && zone.stage_started_on !== null) {
      const startedOn = String(zone.stage_started_on);
      const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(startedOn);
      if (!m || new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString().slice(0, 10) !== startedOn) {
        throw commandError(
          'malformed_command',
          'zone.stage_started_on must be YYYY-MM-DD or null'
        );
      }
      result.stageStartedOn = startedOn;
    }
""")
swap("""      'prediction_card_enabled,notes,sync_version,deleted_at,created_at,updated_at,' +
      'weather_source' +
    ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',""", """      'prediction_card_enabled,notes,sync_version,deleted_at,created_at,updated_at,' +
      'weather_source,stage_started_on' +
    ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',""")
swap("""      zone.weatherSource || 'auto',
    ]
  );
}""", """      zone.weatherSource || 'auto',
      zone.stageStartedOn,
    ]
  );
}""")
swap("""  const weatherSource = zone.weatherSource === null ? [] : [zone.weatherSource];
""", """  const weatherSource = zone.weatherSource === null ? [] : [zone.weatherSource];
  // A command without stage_started_on keeps the stored date.
  const stageStartedOn = zone.hasStageStartedOn ? [zone.stageStartedOn] : [];
""")
swap("""      (weatherSource.length ? 'weather_source=?,' : '') +
""", """      (weatherSource.length ? 'weather_source=?,' : '') +
      (stageStartedOn.length ? 'stage_started_on=?,' : '') +
""")
swap("""      ...weatherSource,
      command.target,""", """      ...weatherSource,
      ...stageStartedOn,
      command.target,""")
# The Terra path's stage-date rules (plan E2a Task 3; controller ruling on plan review E2 I2).
swap("""const entityName = require('../osi-entity-name');
""", """const entityName = require('../osi-entity-name');
// osi-crop-kc normalizeStage: the five FAO keys and the nine legacy keys; anything else is unset.
const { normalizeStage } = require('../osi-crop-kc');

// Today in the zone's timezone as YYYY-MM-DD; UTC for a missing or unknown zone id, as
// osi-agronomy-daily reads it (formatToParts: the Node build has English locale data only).
function zoneLocalToday(timezone) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: String(timezone || 'UTC'), year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch (tzError) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  const parts = {};
  for (const part of fmt.formatToParts(new Date())) parts[part.type] = part.value;
  return parts.year + '-' + parts.month + '-' + parts.day;
}

// The Terra shape never carries a start date (its field list is exact), so the stage-date
// rules decide it (spec 2026-09-27-daily-agronomy-parity B5; controller rulings cloud/sync I7
// and plan review E2 I2): a change to unset clears the date, a change to another set stage
// starts it on the zone-local today, the same stage keeps it.
function terraStageStartedOn(current, nextStage) {
  const next = normalizeStage(nextStage);
  const stored = normalizeStage(current.phenological_stage);
  const kept = current.stage_started_on == null ? null : current.stage_started_on;
  if (!next) return stored ? null : kept;
  return next === stored ? kept : zoneLocalToday(current.timezone);
}
""")
swap("""        'crop_type=?,variety=?,phenological_stage=?,sync_version=?,updated_at=? ' +
        'WHERE zone_uuid=?',
      [
        command.cropType, command.variety, command.phenologicalStage,
        command.target, new Date().toISOString(), command.zoneUuid,
      ]""", """        'crop_type=?,variety=?,phenological_stage=?,stage_started_on=?,sync_version=?,updated_at=? ' +
        'WHERE zone_uuid=?',
      [
        command.cropType, command.variety, command.phenologicalStage,
        terraStageStartedOn(current, command.phenologicalStage),
        command.target, new Date().toISOString(), command.zoneUuid,
      ]""")
p.write_text(s, encoding="utf-8")
print("osi-zone-commands: stage_started_on on the protected UPSERT_ZONE; the Terra path sets it by the stage-date rules")
```
```bash
python3 "$SCRATCH/zone-commands-stage.py"
cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-commands/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-zone-commands/index.js
```
Expected: `osi-zone-commands: stage_started_on on the protected UPSERT_ZONE; the Terra path sets it by the stage-date rules`. `osi-dendro-analytics` already requires `../osi-crop-kc` the same way, so the helper directory ships beside `osi-zone-commands` on every image.

- [ ] **Step 5: Regenerate the Terra fixture**

The fixture's Terra command changes `flowering` (unset) to `development` under the fixed clock `2026-08-03T20:00:00.000Z`, which is 22:00 on 3 August in the zone's `Europe/Zurich`, so its three zone payloads now carry `"stage_started_on": "2026-08-03"` instead of the `null` of Task 1:
```bash
TERRA_EDGE_FIXTURE_OUT=scripts/fixtures/terra-edge-selection/edge-selection-v1.json node --test scripts/test-terra-selection-edge-acceptance.js
node --test scripts/test-terra-selection-edge-acceptance.js
grep -c '"stage_started_on": "2026-08-03"' scripts/fixtures/terra-edge-selection/edge-selection-v1.json
```
Expected: both runs `# pass 22`, `# fail 0` (Task 1's 21 and the stage-date test); `3`.

- [ ] **Step 6: The contract**

`$SCRATCH/contract-e2.py`:
```python
# One-shot (plan E2a, Task 3): Zone.stage_started_on in the resource contract,
# and the contract test learns the JSON Schema 'date' format.
import pathlib
def patch(path, swaps):
    p = pathlib.Path(path)
    s = p.read_text(encoding="utf-8")
    for old, new in swaps:
        if s.count(old) != 1:
            raise SystemExit(f"{path}: expected one match for: {old[:80]}")
        s = s.replace(old, new)
    p.write_text(s, encoding="utf-8")
patch("docs/contracts/sync-schema/resources.schema.json", [(
'''                "weather_source": {"type": "string", "minLength": 1, "maxLength": 20, "pattern": "^[a-z_]{1,20}$"},
''', '''                "weather_source": {"type": "string", "minLength": 1, "maxLength": 20, "pattern": "^[a-z_]{1,20}$"},
                "stage_started_on": {"type": ["string", "null"], "format": "date"},
''')])
patch("scripts/test-contract-schemas.js", [
    ("const SUPPORTED_FORMATS = new Set(['date-time']);\n",
     "const SUPPORTED_FORMATS = new Set(['date-time', 'date']);\nconst DATE = /^(\\d{4})-(\\d{2})-(\\d{2})$/;\n"),
    ("function isValidDateTime(value) {\n",
     "function isValidDate(value) {\n"
     "    const match = DATE.exec(value);\n"
     "    if (!match) return false;\n"
     "    const month = Number(match[2]);\n"
     "    const day = Number(match[3]);\n"
     "    return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(Number(match[1]), month);\n"
     "}\n\n"
     "function isValidDateTime(value) {\n"),
    ("        if (schema.format === 'date-time' && !isValidDateTime(value)) {\n            errors.push(`${at}: string does not match format date-time`);\n",
     "        if (schema.format === 'date-time' && !isValidDateTime(value)) {\n            errors.push(`${at}: string does not match format date-time`);\n"
     "        } else if (schema.format === 'date' && !isValidDate(value)) {\n            errors.push(`${at}: string does not match format date`);\n"),
])
print("contract: Zone.stage_started_on")
```
Run: `python3 "$SCRATCH/contract-e2.py"`. Expected: `contract: Zone.stage_started_on`. `required` stays `["zone_id", "name"]`; the file keeps its version.

- [ ] **Step 7: The contract README section**

`$SCRATCH/sync-schema-readme-e2a.py` (sub-project 3 wrote a `weather_source` section in the same place; plan review E2-E4 minor 7):
```python
# One-shot (plan E2a, Task 3): docs/contracts/sync-schema/README.md explains Zone.stage_started_on.
import pathlib
p = pathlib.Path("docs/contracts/sync-schema/README.md")
s = p.read_text(encoding="utf-8")
anchor = "## Versioning\n"
if s.count(anchor) != 1:
    raise SystemExit("expected one '## Versioning' heading")
s = s.replace(anchor, """## Zone `stage_started_on`

`Zone.stage_started_on` is the date the zone's current growth stage began
(`YYYY-MM-DD`, or null), the start of the FAO-56 Kc curve
(`docs/contracts/agronomy/README.md`). The schema checks a real calendar date
(`"format": "date"`). The edge stores the field from the zone route,
`UPSERT_ZONE_CONFIG`, legacy `UPSERT_ZONE` and protected `UPSERT_ZONE`, emits it
in every zone update event and in the bootstrap and force-sync snapshots, and
reports `zone_config_stage_started_on_v1`. Unlike `weather_source` above, the key
is always present, null when unset: an ordinary zone field with no default that
could stand in for a value. Both servers apply the same rules to a
write that carries a stage: a change to unset clears the date, a change to another
set stage without a date sets the zone-local today, the same stage keeps it, and a
supplied date wins. The cloud sends the field only to a gateway that reported the
token: a gateway without it rejects a protected `UPSERT_ZONE` that carries the
field.

""" + anchor)
p.write_text(s, encoding="utf-8")
print("sync-schema README: Zone stage_started_on")
```
```bash
python3 "$SCRATCH/sync-schema-readme-e2a.py"
node .claude/skills/anti-slop-writing/slop-check.js docs/contracts/sync-schema/README.md
```
Expected: `sync-schema README: Zone stage_started_on`; `slop-check: PASS (no tier-1 findings)`.

- [ ] **Step 8: Size ratchet and identity pin**

`$SCRATCH/ratchet-e2-task3.js`:
```js
#!/usr/bin/env node
// Measures the named nodes and the per-profile total against origin/main and
// writes the exact allowances verify-flows-size-ratchet reads.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { nodeSizes, totalChars } = require(path.join(process.cwd(), 'scripts/flows-size-scan'));
const REL = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';
const FILE = 'scripts/verify-flows-size-ratchet-allowances.json';
const head = JSON.parse(fs.readFileSync(REL, 'utf8'));
const base = JSON.parse(execFileSync('git', ['show', 'origin/main:' + REL], { maxBuffer: 64 * 1024 * 1024 }).toString());
const h = nodeSizes(head);
const b = nodeSizes(base);
const before = fs.readFileSync(FILE, 'utf8');
const allowances = JSON.parse(before);
if (JSON.stringify(allowances, null, 2) + '\n' !== before) throw new Error(FILE + ' does not round-trip');
const WHY = 'Daily agronomy parity (spec docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md), measured with verify-flows-size-ratchet nodeSizes over both byte-identical profiles: ';
const PRIOR = '. Supersedes the prior entry, whose growth this delta includes. ';
const NODES = {
  '4f4a765f36cee6f3': (m) => `${WHY}${m}${PRIOR}Legacy UPSERT_ZONE_CONFIG and UPSERT_ZONE store stage_started_on; an invalid date is ignored with one warning; a change of a set stage to unset clears it; a stage changed without a date starts on the zone-local today.`,
};
for (const [id, reason] of Object.entries(NODES)) {
  const delta = h.get(id).chars - b.get(id).chars;
  const measured = `origin/main ${b.get(id).chars} -> HEAD ${h.get(id).chars} = +${delta}`;
  allowances.node_allowances[id] = { delta, reason: reason(measured) };
  console.log(id, measured);
}
const totalDelta = totalChars(head) - totalChars(base);
allowances.total_allowance = {
  delta: totalDelta,
  reason: `Branch feat/daily-agronomy-parity, stacked on feat/weather-data-view and feat/daily-agronomy (the weather provider store, the daily agronomy record, the weather data view and daily agronomy parity, all unmerged to origin/main), measured with verify-flows-size-ratchet totalChars over both byte-identical profiles: origin/main ${totalChars(base)} -> HEAD ${totalChars(head)} = +${totalDelta}. Carried from feat/daily-agronomy: +4138 (weather-provider-tick 0, weather-provider-fn 1467, station-hours-fn 1525, agronomy-daily-fn 1515, zone-env-fn -369). Carried from feat/weather-data-view: +4307 (sync-init-fn 1394, zone-config-fn 737, get-zones-query 19, get-zones-response 337, sync-bootstrap-build 150, sync-force-build 150, al-link-build-req 33, 4f4a765f36cee6f3 1487). This branch: sync-init-fn (0064), zone-config-fn, get-zones-query, get-zones-response, sync-bootstrap-build, sync-force-build, al-link-build-req and 4f4a765f36cee6f3 grew by the deltas of their node entries. When the earlier branches merge to origin/main their share moves into the base total and this entry drops by it.`,
};
console.log('total', `origin/main ${totalChars(base)} -> HEAD ${totalChars(head)} = +${totalDelta}`);
fs.writeFileSync(FILE, JSON.stringify(allowances, null, 2) + '\n');
```
```bash
node "$SCRATCH/ratchet-e2-task3.js"
node scripts/verify-flows-size-ratchet.js --write-baseline
node scripts/verify-flows-size-ratchet.js
```
Expected: `4f4a765f36cee6f3 origin/main 19386 -> HEAD 25276 = +5890` (sub-project 3's 1487 plus this task's 4403); `total origin/main 1580418 -> HEAD 1597134 = +16716`; ratchet OK. Pin what the script prints.

In `scripts/verify-live-gateway-identity.js`, the total pin from Task 2 becomes:
```js
  // 16716: plan E2a Task 3 adds 4f4a765f36cee6f3 (+4403: legacy UPSERT_ZONE_CONFIG and
  // UPSERT_ZONE store stage_started_on, with both stage-date rules and one warning for an
  // invalid date) to Task 2's 12313. verify-flows-size-ratchet totalChars over both
  // byte-identical profiles: origin/main 1580418 -> HEAD 1597134 = +16716.
  expectCondition(sizeAllowances.total_allowance?.delta === 16716,
    'size total allowance: exact cumulative delta 16716',
    'size total allowance: expected exact cumulative delta 16716');
```

- [ ] **Step 9: Run the gates**

```bash
node --test scripts/test-legacy-upsert-zone-config.js scripts/test-zone-command-path.js scripts/test-legacy-upsert-zone-name.js scripts/test-zone-weather-source.js scripts/test-entity-name-command-path.js scripts/test-terra-selection-edge-acceptance.js scripts/test-terra-zone-config-command-flow.js scripts/test-scoped-access-command-path.js
node scripts/test-contract-schemas.js
node scripts/verify-sync-contract.js
node scripts/verify-profile-parity.js && node scripts/verify-flows-fn-parse.js && node scripts/test-flows-wiring.js && node scripts/verify-no-new-silent-catch.js && node scripts/verify-no-stray-ddl.js
node scripts/verify-flows-size-ratchet.js && node scripts/verify-live-gateway-identity.js && node scripts/verify-sync-flow.js
```
Expected: `test-legacy-upsert-zone-config.js` `# pass 7`, `test-zone-command-path.js` `# pass 14` (sub-project 3's 12 and these 2), `test-terra-zone-config-command-flow.js` `# pass 7`, `test-terra-selection-edge-acceptance.js` `# pass 22` against the fixture Step 5 regenerated, the rest `# fail 0`; pin the counts the runner prints; `PASS: contract schema checks pass`; `verify-sync-contract: OK`; parity, parse, wiring, silent-catch and stray-DDL pass; ratchet OK; `Live gateway identity verification passed.`; verify-sync-flow ends `All parity checks passed.`

- [ ] **Step 10: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-commands/index.js conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-zone-commands/index.js scripts/test-legacy-upsert-zone-config.js scripts/test-zone-command-path.js scripts/test-terra-zone-config-command-flow.js scripts/test-terra-selection-edge-acceptance.js scripts/fixtures/terra-edge-selection scripts/test-contract-schemas.js scripts/verify-sync-flow.js .github/workflows/verify-sync-flow.yml docs/contracts/sync-schema/resources.schema.json docs/contracts/sync-schema/README.md scripts/verify-flows-size-ratchet-allowances.json scripts/verify-flows-size-ratchet-baseline.json scripts/verify-live-gateway-identity.js
git -c user.name=Project-OSI commit -m "feat(sync): cloud zone commands carry stage_started_on on every path, with the stage-date rules; Zone contract gains stage_started_on"
```

---

### Task 4: The daily writer freezes the curve fields

**Files:**
- Modify: `.../osi-agronomy-daily/index.js`, `.../osi-agronomy-daily/index.test.js` (both profiles)
- Scratch: `$SCRATCH/agronomy-daily-kc.py`

**Interfaces:**
- Consumes: `irrigation_zones.stage_started_on`, the three `zone_daily_agronomy` columns (Task 1); `resolveKc({ cropType, phenologicalStage, stageStartedOn, date })` (plan E1).
- Produces: every row the writer writes with a value carries `stage_started_on` (the zone's value when the row froze), `kc_stage_day` and `stage_overrun` (1, 0 or NULL) beside `kc` and `kc_source`, which is `fao56_curve` on a ramp day. `ROW_COLUMNS` is `['et0_mm', 'et0_source', 'et0_tier', 'et0_station_id', 'location_key', 'hours_present', 'expected_hours', 'null_reason', 'kc', 'kc_source', 'crop_type', 'phenological_stage', 'stage_started_on', 'kc_stage_day', 'stage_overrun', 'etc_mm']`; plan E4 adds the version to this upsert.

- [ ] **Step 1: Write the failing tests**

Append to `.../osi-agronomy-daily/index.test.js`:
```js

// Contract v2 (spec 2026-09-27-daily-agronomy-parity B4): the Kc curve fields
// freeze with the rest of the snapshot.
test('a dated development zone: rows carry the curve Kc, the start date, FAO\'s day in the stage and the overrun flag', async () => {
  const db = scratchDb();
  seedZone(db, { stage: 'development' });
  db.raw.prepare("UPDATE irrigation_zones SET stage_started_on = '2026-09-05' WHERE id = 1").run();
  for (const d of days('2026-09-19', '2026-09-25')) seedProviderDay(db, OM, d);
  await run(db);
  const r = row(db, '2026-09-25');
  // maize 0.30 -> 1.20 over 40 days; 2026-09-25 is day 21: 0.30 + 21/40 * 0.90 = 0.7725 -> 0.77.
  assert.deepEqual([r.kc, r.kc_source, r.phenological_stage, r.stage_started_on, r.kc_stage_day, r.stage_overrun, r.etc_mm],
    [0.77, 'fao56_curve', 'development', '2026-09-05', 21, 0, 3.7]);
  assert.equal(row(db, '2026-09-19').kc, 0.64, 'each day takes its own place on the ramp: day 15 is 0.30 + 15/40 * 0.90');
  assert.equal(row(db, '2026-09-19').kc_stage_day, 15);
});

test('a stage left past its length is flagged; a stage without a start date stores nulls for the curve fields', async () => {
  const db = scratchDb();
  seedZone(db, { id: 1, stage: 'initial' });
  seedZone(db, { id: 2, stage: 'development' });
  db.raw.prepare("UPDATE irrigation_zones SET stage_started_on = '2026-08-01' WHERE id = 1").run();
  seedProviderDay(db, OM, '2026-09-25');
  await run(db);
  const overrun = row(db, '2026-09-25', 1);
  assert.deepEqual([overrun.kc, overrun.kc_source, overrun.kc_stage_day, overrun.stage_overrun], [0.3, 'fao56_crop', 56, 1], 'maize initial is 30 days long');
  const undated = row(db, '2026-09-25', 2);
  assert.deepEqual([undated.kc, undated.kc_source, undated.stage_started_on, undated.kc_stage_day, undated.stage_overrun], [1.2, 'fao56_crop', null, null, null]);
});

test('a start date entered after a row froze does not reach that row; a day computed later takes it', async () => {
  const db = scratchDb();
  seedZone(db, { stage: 'development' });
  seedProviderDay(db, OM, '2026-09-24');
  seedProviderDay(db, OM, '2026-09-25', { skip: (h, i) => i === 3 });
  await run(db);
  assert.deepEqual([row(db, '2026-09-24').kc, row(db, '2026-09-24').stage_started_on], [1.2, null]);
  db.raw.prepare("UPDATE irrigation_zones SET stage_started_on = '2026-09-05' WHERE id = 1").run();
  db.raw.prepare("INSERT INTO weather_provider_hours (location_key, hour_start, et0_mm, fetched_at) VALUES (?, ?, 0.2, '2026-09-26T06:00:00Z')").run(OM, ad.localDayWindow('2026-09-25', TZ).hourStarts[3]);
  await run(db, '2026-09-26T07:00:00Z');
  assert.deepEqual([row(db, '2026-09-24').kc, row(db, '2026-09-24').stage_started_on, row(db, '2026-09-24').kc_stage_day], [1.2, null, null]);
  assert.deepEqual([row(db, '2026-09-25').kc, row(db, '2026-09-25').stage_started_on, row(db, '2026-09-25').kc_stage_day], [0.77, '2026-09-05', 21]);
});
```

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.test.js`
Expected: the three new tests fail (the writer resolves without a start date: Kc 1.2 `fao56_crop`, the three columns null); the existing tests pass.

- [ ] **Step 2: The writer**

`$SCRATCH/agronomy-daily-kc.py`:
```python
# One-shot (plan E2a, Task 4): the daily writer freezes the Kc curve fields.
import pathlib
p = pathlib.Path("conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.js")
s = p.read_text(encoding="utf-8")
def swap(old, new):
    global s
    if s.count(old) != 1:
        raise SystemExit("expected one match for: " + old[:80])
    s = s.replace(old, new)
swap("""function snapshotFor(zone, computed, stored) {
  if (stored && stored.kc != null) return { kc: stored.kc, kcSource: stored.kc_source, cropType: stored.crop_type, stage: stored.phenological_stage };
  if (computed.et0Mm == null) return { kc: null, kcSource: null, cropType: null, stage: null };
  const r = resolveKc({ cropType: zone.crop_type, phenologicalStage: zone.phenological_stage });
  const crop = zone.crop_type == null ? null : (String(zone.crop_type).trim() || null);
  return { kc: r.kc, kcSource: r.kcSource, cropType: crop, stage: r.stage };
}

const ROW_COLUMNS = ['et0_mm', 'et0_source', 'et0_tier', 'et0_station_id', 'location_key', 'hours_present', 'expected_hours', 'null_reason', 'kc', 'kc_source', 'crop_type', 'phenological_stage', 'etc_mm'];""",
"""// The Kc snapshot of a row: crop, stage, stage start date and the curve's day
// in the stage freeze together the first time the row gets a value (contract v2,
// spec 2026-09-27-daily-agronomy-parity B4; backfilled days alike, ruling R10).
function snapshotFor(zone, computed, stored, date) {
  if (stored && stored.kc != null) {
    return { kc: stored.kc, kcSource: stored.kc_source, cropType: stored.crop_type, stage: stored.phenological_stage, stageStartedOn: stored.stage_started_on, kcStageDay: stored.kc_stage_day, stageOverrun: stored.stage_overrun };
  }
  if (computed.et0Mm == null) return { kc: null, kcSource: null, cropType: null, stage: null, stageStartedOn: null, kcStageDay: null, stageOverrun: null };
  const stageStartedOn = zone.stage_started_on == null ? null : (String(zone.stage_started_on).trim() || null);
  const r = resolveKc({ cropType: zone.crop_type, phenologicalStage: zone.phenological_stage, stageStartedOn, date });
  const crop = zone.crop_type == null ? null : (String(zone.crop_type).trim() || null);
  return { kc: r.kc, kcSource: r.kcSource, cropType: crop, stage: r.stage, stageStartedOn, kcStageDay: r.kcStageDay, stageOverrun: r.stageOverrun == null ? null : (r.stageOverrun ? 1 : 0) };
}

const ROW_COLUMNS = ['et0_mm', 'et0_source', 'et0_tier', 'et0_station_id', 'location_key', 'hours_present', 'expected_hours', 'null_reason', 'kc', 'kc_source', 'crop_type', 'phenological_stage', 'stage_started_on', 'kc_stage_day', 'stage_overrun', 'etc_mm'];""")
swap("""  const snap = snapshotFor(zone, computed, stored);
  const etc = computed.et0Mm != null && snap.kc != null ? round2(computed.et0Mm * snap.kc) : null;
  return [zone.id, date, computed.et0Mm, computed.et0Source, computed.et0Tier, computed.et0StationId, computed.locationKey, computed.hoursPresent, computed.expectedHours, computed.nullReason, snap.kc, snap.kcSource, snap.cropType, snap.stage, etc, nowIso];""",
"""  const snap = snapshotFor(zone, computed, stored, date);
  const etc = computed.et0Mm != null && snap.kc != null ? round2(computed.et0Mm * snap.kc) : null;
  return [zone.id, date, computed.et0Mm, computed.et0Source, computed.et0Tier, computed.et0StationId, computed.locationKey, computed.hoursPresent, computed.expectedHours, computed.nullReason, snap.kc, snap.kcSource, snap.cropType, snap.stage, snap.stageStartedOn, snap.kcStageDay, snap.stageOverrun, etc, nowIso];""")
swap("""  const zones = await db.all('SELECT iz.id, iz.timezone, iz.crop_type, iz.phenological_stage, gl.altitude_m FROM""",
     """  const zones = await db.all('SELECT iz.id, iz.timezone, iz.crop_type, iz.phenological_stage, iz.stage_started_on, gl.altitude_m FROM""")
swap("""'SELECT date, kc, kc_source, crop_type, phenological_stage FROM zone_daily_agronomy WHERE zone_id = ? AND date >= ? AND date <= ?'""",
     """'SELECT date, kc, kc_source, crop_type, phenological_stage, stage_started_on, kc_stage_day, stage_overrun FROM zone_daily_agronomy WHERE zone_id = ? AND date >= ? AND date <= ?'""")
p.write_text(s, encoding="utf-8")
print("osi-agronomy-daily: Kc curve fields frozen per row")
```
```bash
python3 "$SCRATCH/agronomy-daily-kc.py"
for f in index.js index.test.js; do cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/$f conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-agronomy-daily/$f; done
```
Expected: `osi-agronomy-daily: Kc curve fields frozen per row`.

- [ ] **Step 3: Run the gates**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/index.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/facade-contract.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/et0.test.js
node scripts/verify-agronomy-contract.js && node scripts/verify-profile-parity.js
```
Expected: every suite `# fail 0` (the index suite gains three tests; the facade test still returns within 10 s); the verifier OK; `All parity checks passed.`

- [ ] **Step 4: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-agronomy-daily
git -c user.name=Project-OSI commit -m "feat(agronomy-daily): rows freeze the stage start date, the FAO-56 stage day and the overrun flag with their Kc"
```

---

### Task 5: `osi-zone-env`: today and the forecast days on the curve, the shared-mode merge

**Files:**
- Modify: `.../osi-zone-env/index.js`, `.../osi-zone-env/index.test.js` (both profiles), both `flows.json` (node `zone-env-fn`, one-shot script), `scripts/capture-zone-env-vectors.js`, `docs/contracts/zone-env/MANIFEST.json` and `cases/*` (re-captured), `scripts/verify-flows-size-ratchet-allowances.json`, `scripts/verify-flows-size-ratchet-baseline.json`, `scripts/verify-live-gateway-identity.js`
- Scratch: `$SCRATCH/zone-env-curve.py`, `$SCRATCH/flows-zone-env-stage.js`, `$SCRATCH/ratchet-e2-task5.js`

**Interfaces:**
- Consumes: `stage_started_on` and `stage_overrun` (Tasks 1 and 4).
- Produces: `buildAgronomic(local, online, forecast, { cropType, phenologicalStage, stageStartedOn, todayIso, forecastFetchedAt, timezone })` resolves Kc for `todayIso`; `agronomic.current.stageOverrun` (boolean or null). `buildForecastSection(…, crop, …)` resolves each forecast day's Kc for that day's date (`crop` = `{ cropType, phenologicalStage, stageStartedOn }`). Every `buildWaterDaily` day carries `stageOverrun` (a past day from `stage_overrun`, today from `todayAgronomic.stageOverrun`) and `demandComputedBy` (`'edge'` for a past day whose stored row has a demand, `etc_mm` not null; null otherwise and for today). `DEMAND_FIELDS` gains both names. In shared mode, `mergeDailyIrrigationSplit` takes the gateway's demand fields for a day the gateway computed (`demandComputedBy === 'edge'`), for today, and for every day of a bundle from an older cloud that sends no `demandComputedBy`; any other day keeps the cloud's fields. Task 7's tooltip reads `stageOverrun` and `demandComputedBy`.

- [ ] **Step 1: Write the failing tests**

Append to `.../osi-zone-env/index.test.js`:
```js

// Contract v2 in the Water tab (spec 2026-09-27-daily-agronomy-parity B7).
test('buildAgronomic: a dated development zone takes today\'s place on the FAO-56 curve', () => {
  const a = ZE.buildAgronomic(null, null, forecastFor(['2026-09-25']), { cropType: 'maize', phenologicalStage: 'development', stageStartedOn: '2026-09-05', todayIso: '2026-09-25', forecastFetchedAt: '2026-09-25T05:00:00Z', timezone: 'Europe/Zurich' });
  assert.deepEqual([a.current.cropCoefficientKc, a.current.cropCoefficientSource, a.current.stageOverrun, a.current.etcMmDay], [0.77, 'fao56_curve', false, 2.31]);
  const undated = ZE.buildAgronomic(null, null, forecastFor(['2026-09-25']), { cropType: 'maize', phenologicalStage: 'development', todayIso: '2026-09-25', forecastFetchedAt: '2026-09-25T05:00:00Z', timezone: 'Europe/Zurich' });
  assert.deepEqual([undated.current.cropCoefficientKc, undated.current.cropCoefficientSource, undated.current.stageOverrun], [1.2, 'fao56_crop', null]);
});

test('buildForecastSection: each forecast day resolves Kc for its own date', () => {
  const f = ZE.buildForecastSection({ days: [{ date: '2026-09-25', et0MmDay: 5 }, { date: '2026-09-26', et0MmDay: 5 }, { date: '2026-09-27', et0MmDay: 5 }], hours: [] }, 'live', null, { cropType: 'maize', phenologicalStage: 'development', stageStartedOn: '2026-09-05' }, '2026-09-25T08:00:00Z');
  assert.deepEqual(f.rainFocus.daily.map((d) => d.cropCoefficientKc), [0.77, 0.8, 0.82]);
  assert.deepEqual(f.rainFocus.daily.map((d) => d.etcMmDay), [3.85, 4, 4.1]);
});

test('buildWaterDaily: stageOverrun from the stored row or today\'s resolution; demandComputedBy is edge for a stored demand', () => {
  const daily = ZE.buildWaterDaily({
    envRows: [], estimatedByDate: {},
    agronomyRows: [kcRows({ stage_overrun: 1 }), kcRows({ date: '2026-09-23', stage_overrun: 0 }), kcRows({ date: '2026-09-22', et0_mm: null, etc_mm: null, kc: null, null_reason: 'partial_day', stage_overrun: null })],
    zone: {}, todayIso: '2026-09-25', waterNeededTodayMm: 4.1,
    todayAgronomic: { referenceEt0MmDay: 3.42, cropCoefficientKc: 0.77, cropCoefficientSource: 'fao56_curve', cropId: 'maize', stage: 'development', stageOverrun: false },
    stationNames: {},
  });
  const byDate = Object.fromEntries(daily.map((d) => [d.date, d]));
  assert.deepEqual([byDate['2026-09-24'].stageOverrun, byDate['2026-09-24'].demandComputedBy], [true, 'edge']);
  assert.deepEqual([byDate['2026-09-23'].stageOverrun, byDate['2026-09-23'].demandComputedBy], [false, 'edge']);
  assert.deepEqual([byDate['2026-09-22'].stageOverrun, byDate['2026-09-22'].demandComputedBy], [null, null]);
  assert.deepEqual([byDate['2026-09-21'].stageOverrun, byDate['2026-09-21'].demandComputedBy], [null, null]);
  assert.deepEqual([byDate['2026-09-25'].stageOverrun, byDate['2026-09-25'].demandComputedBy, byDate['2026-09-25'].kcSource], [false, null, 'fao56_curve']);
});

test('shared mode: the gateway\'s day replaces the cloud\'s where it has a demand; a cloud day fills a day it has none for; an older cloud still gets the gateway\'s fields', () => {
  const local = { available: true, waterNeededTodayMm: 4.1, todayDate: '2026-09-25', daily: ZE.buildWaterDaily({ envRows: [], estimatedByDate: {}, agronomyRows: [kcRows()], zone: {}, todayIso: '2026-09-25', waterNeededTodayMm: 4.1, stationNames: {} }) };
  const cloudDay = (date) => ({ date, rainMm: 0.5, demandMm: 2.2, demandSource: 'calculated', demandComputedBy: 'cloud', et0Mm: 3.1, et0Tier: 'open_meteo_daily', et0Source: 'provider_native', kc: 0.71, kcSource: 'fao56_crop', stageOverrun: null, nullReason: null });
  const days = Array.from({ length: 7 }, (_, i) => cloudDay(new Date(Date.parse('2026-09-19T00:00:00Z') + i * 86400000).toISOString().slice(0, 10)));
  const merged = ZE.overlayLocalWaterIrrigationSplit({ available: true, waterNeededTodayMm: 3.3, daily: days }, local, '2026-09-25');
  const byDate = Object.fromEntries(merged.daily.map((d) => [d.date, d]));
  assert.deepEqual([byDate['2026-09-24'].demandMm, byDate['2026-09-24'].demandComputedBy, byDate['2026-09-24'].et0Tier], [4.8, 'edge', 'station_fao56']);
  assert.deepEqual([byDate['2026-09-23'].demandMm, byDate['2026-09-23'].demandComputedBy, byDate['2026-09-23'].et0Tier], [2.2, 'cloud', 'open_meteo_daily']);
  const older = ZE.overlayLocalWaterIrrigationSplit({ available: true, waterNeededTodayMm: 3.3, daily: days.map((d) => ({ date: d.date, rainMm: d.rainMm })) }, local, '2026-09-25');
  assert.deepEqual([older.daily.find((d) => d.date === '2026-09-23').demandMm, older.daily.find((d) => d.date === '2026-09-23').demandComputedBy], [null, null]);
});
```

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/index.test.js`
Expected: the four new tests fail (Kc 1.2 everywhere, no `stageOverrun`/`demandComputedBy`, the cloud day overwritten by the gateway's null day); the existing tests pass.

- [ ] **Step 2: The module**

`$SCRATCH/zone-env-curve.py`:
```python
# One-shot (plan E2a, Task 5): osi-zone-env resolves Kc through the curve and
# carries stageOverrun and demandComputedBy per day.
import pathlib
p = pathlib.Path("conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/index.js")
s = p.read_text(encoding="utf-8")
def swap(old, new):
    global s
    if s.count(old) != 1:
        raise SystemExit("expected one match for: " + old[:80])
    s = s.replace(old, new)
swap("""  const stepHours = estimateStepHours(hours);
  const kc = resolveKc(crop || {}).kc;
""", """  const stepHours = estimateStepHours(hours);
  // Each forecast day takes its own place on the FAO-56 curve (contract v2 A5).
  const kcOn = (date) => resolveKc({ ...(crop || {}), date }).kc;
""")
swap("""        et0MmDay: day.et0MmDay ?? null,
        cropCoefficientKc: round(kc, 2),
        etcMmDay: day.et0MmDay != null ? round(day.et0MmDay * kc, 2) : null
      })),""", """        et0MmDay: day.et0MmDay ?? null,
        cropCoefficientKc: round(kcOn(day.date), 2),
        etcMmDay: day.et0MmDay != null ? round(day.et0MmDay * kcOn(day.date), 2) : null
      })),""")
swap("""function buildAgronomic(local, online, forecast, { cropType = null, phenologicalStage = null, todayIso = null, forecastFetchedAt = null, timezone = 'UTC' } = {}) {""",
     """function buildAgronomic(local, online, forecast, { cropType = null, phenologicalStage = null, stageStartedOn = null, todayIso = null, forecastFetchedAt = null, timezone = 'UTC' } = {}) {""")
swap("""  const resolved = resolveKc({ cropType, phenologicalStage });
  const kc = resolved.kc;""", """  const resolved = resolveKc({ cropType, phenologicalStage, stageStartedOn, date: todayIso });
  const kc = resolved.kc;""")
swap("""      cropId: resolved.cropId,
      stage: resolved.stage,
""", """      cropId: resolved.cropId,
      stage: resolved.stage,
      stageOverrun: resolved.stageOverrun,
""")
swap("""        cropType: trimToNull(cur.cropId), phenologicalStage: trimToNull(cur.stage),
        hoursPresent: null, expectedHours: null, nullReason: waterNeededTodayMm != null ? null : 'demand_unknown'
      });""", """        cropType: trimToNull(cur.cropId), phenologicalStage: trimToNull(cur.stage),
        stageOverrun: typeof cur.stageOverrun === 'boolean' ? cur.stageOverrun : null, demandComputedBy: null,
        hoursPresent: null, expectedHours: null, nullReason: waterNeededTodayMm != null ? null : 'demand_unknown'
      });""")
swap("""        kc: a ? a.kc : null, kcSource: a ? a.kc_source : null, cropType: a ? a.crop_type : null, phenologicalStage: a ? a.phenological_stage : null,
        hoursPresent: a ? a.hours_present : null, expectedHours: a ? a.expected_hours : null, nullReason: a ? a.null_reason : null
      });""", """        kc: a ? a.kc : null, kcSource: a ? a.kc_source : null, cropType: a ? a.crop_type : null, phenologicalStage: a ? a.phenological_stage : null,
        stageOverrun: a && a.stage_overrun != null ? Number(a.stage_overrun) === 1 : null,
        // 'edge' when the gateway stored a demand for the day (spec 2026-09-27-daily-agronomy-parity B7).
        demandComputedBy: a && a.etc_mm != null ? 'edge' : null,
        hoursPresent: a ? a.hours_present : null, expectedHours: a ? a.expected_hours : null, nullReason: a ? a.null_reason : null
      });""")
swap("""const DEMAND_FIELDS = ['demandMm', 'demandSource', 'et0Mm', 'et0Source', 'et0Tier', 'et0StationId', 'et0StationName', 'kc', 'kcSource', 'cropType', 'phenologicalStage', 'hoursPresent', 'expectedHours', 'nullReason'];""",
     """const DEMAND_FIELDS = ['demandMm', 'demandSource', 'demandComputedBy', 'et0Mm', 'et0Source', 'et0Tier', 'et0StationId', 'et0StationName', 'kc', 'kcSource', 'cropType', 'phenologicalStage', 'stageOverrun', 'hoursPresent', 'expectedHours', 'nullReason'];""")
swap("""    const local = localByDate[String(row.date)];
    if (!local) return row;
    return { ...row, ...pick(local, SPLIT_FIELDS), ...pick(local, DEMAND_FIELDS) };""", """    const local = localByDate[String(row.date)];
    if (!local) return row;
    // The gateway's demand replaces the cloud's for every day the gateway
    // computed, and today; a past day the gateway has no value for keeps the
    // cloud's own row (demandComputedBy 'cloud'). A cloud that sends no
    // demandComputedBy predates sub-project 4 and has no daily record: the
    // gateway's fields fill the day as before.
    const gatewayDay = local.demandComputedBy === 'edge' || String(row.date) === todayIso || row.demandComputedBy === undefined;
    return { ...row, ...pick(local, SPLIT_FIELDS), ...(gatewayDay ? pick(local, DEMAND_FIELDS) : {}) };""")
p.write_text(s, encoding="utf-8")
print("osi-zone-env: Kc curve per date, stageOverrun and demandComputedBy per day")
```
Run: `python3 "$SCRATCH/zone-env-curve.py"`. Expected: `osi-zone-env: Kc curve per date, stageOverrun and demandComputedBy per day`.

- [ ] **Step 3: `zone-env-fn` reads the two columns**

`$SCRATCH/flows-zone-env-stage.js`:
```js
#!/usr/bin/env node
// One-shot (plan E2a, Task 5): zone-env-fn reads the zone's stage_started_on and
// each stored day's stage_overrun.
'use strict';
const fs = require('fs');
const path = require('path');
const REPO_ROOT = process.cwd();
const CANONICAL = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const MIRROR = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json');
function serialize(flows) { return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8'); }
function assertRoundtrip(filePath) {
  const original = fs.readFileSync(filePath);
  const parsed = JSON.parse(original.toString('utf8'));
  if (Buffer.compare(original, serialize(parsed)) !== 0) throw new Error('roundtrip guard failed for ' + filePath);
  return parsed;
}
const flows = assertRoundtrip(CANONICAL);
if (Buffer.compare(fs.readFileSync(CANONICAL), fs.readFileSync(MIRROR)) !== 0) throw new Error('profiles differ before the edit');
const node = flows.find((n) => n.id === 'zone-env-fn');
if (!node) throw new Error('zone-env-fn not found');
const swaps = [
  ["iz.gateway_device_eui,iz.phenological_stage,iz.crop_type,", "iz.gateway_device_eui,iz.phenological_stage,iz.stage_started_on,iz.crop_type,"],
  ["const crop = { cropType: zone.crop_type, phenologicalStage: zone.phenological_stage };", "const crop = { cropType: zone.crop_type, phenologicalStage: zone.phenological_stage, stageStartedOn: zone.stage_started_on };"],
  ["kc,kc_source,crop_type,phenological_stage,etc_mm,hours_present,expected_hours,null_reason FROM zone_daily_agronomy", "kc,kc_source,crop_type,phenological_stage,stage_overrun,etc_mm,hours_present,expected_hours,null_reason FROM zone_daily_agronomy"],
];
for (const [from, to] of swaps) {
  const count = node.func.split(from).length - 1;
  if (count !== 1) throw new Error(`expected one match, found ${count}: ${from.slice(0, 80)}`);
  node.func = node.func.replace(from, to);
}
fs.writeFileSync(CANONICAL, serialize(flows));
fs.writeFileSync(MIRROR, serialize(flows));
assertRoundtrip(CANONICAL);
assertRoundtrip(MIRROR);
console.log('edited zone-env-fn in both profiles');
```
```bash
node "$SCRATCH/flows-zone-env-stage.js"
node scripts/verify-flows-fn-parse.js
for f in index.js index.test.js; do cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/$f conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-zone-env/$f; done
```
Expected: `edited zone-env-fn in both profiles`; `verify-flows-fn-parse: OK`. The node's `ensureSchema` list is untouched: the column comes from 0064, not from an inline `ALTER`.

- [ ] **Step 4: Re-capture the zone-env vectors with a dated development case**

In `scripts/capture-zone-env-vectors.js`, `CASES` becomes `['local-openmeteo-water', 'provider-unavailable', 'crop-table-kc', 'crop-curve-kc', 'shared-server', 'shared-server-stale']`, and `CASE_SEEDS` gains, before `'shared-server': sharedServerSeed('2026-07-11'),`:
```js
  // Contract v2: a maize zone in development since 2026-06-21, so today (2026-07-11)
  // is day 21 of 40 on the FAO-56 curve (Kc 0.77) and the stored 2026-07-09 row
  // keeps the Kc it froze with (day 19, 0.73).
  'crop-curve-kc': {
    zoneUpdate: { crop_type: 'maize', phenological_stage: 'development', stage_started_on: '2026-06-21' },
    rows: {
      zone_daily_agronomy: [
        agronomyRow('2026-07-09', { et0_mm: 4.1, et0_source: 'open_meteo_hourly_sum', et0_tier: 'provider_hourly_sum', location_key: 'open_meteo:46.80:8.20', kc: 0.73, kc_source: 'fao56_curve', crop_type: 'maize', phenological_stage: 'development', stage_started_on: '2026-06-21', kc_stage_day: 19, stage_overrun: 0, etc_mm: 2.99 }),
      ],
    },
  },
```
```bash
node scripts/capture-zone-env-vectors.js --capture
node scripts/capture-zone-env-vectors.js --verify
node -e "const e = require('./docs/contracts/zone-env/cases/crop-curve-kc.expected.json'); const c = e.agronomic.current; console.log(c.cropCoefficientKc, c.cropCoefficientSource, c.stageOverrun, e.water.daily.find((d) => d.date === '2026-07-09').demandComputedBy);"
git diff --stat docs/contracts/zone-env
```
Expected: six `Captured …` and six `Verified zone-env vector …` lines; `0.77 fao56_curve false edge`; the diff re-captures every existing expected file (each day gains `stageOverrun` and `demandComputedBy`, `agronomic.current` gains `stageOverrun`) and `MANIFEST.json` lists the new case. If a pre-existing case changes beyond those added fields, stop and report.

- [ ] **Step 5: Size ratchet and identity pin**

`$SCRATCH/ratchet-e2-task5.js`:
```js
#!/usr/bin/env node
// Measures the named nodes and the per-profile total against origin/main and
// writes the exact allowances verify-flows-size-ratchet reads.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { nodeSizes, totalChars } = require(path.join(process.cwd(), 'scripts/flows-size-scan'));
const REL = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json';
const FILE = 'scripts/verify-flows-size-ratchet-allowances.json';
const head = JSON.parse(fs.readFileSync(REL, 'utf8'));
const base = JSON.parse(execFileSync('git', ['show', 'origin/main:' + REL], { maxBuffer: 64 * 1024 * 1024 }).toString());
const h = nodeSizes(head);
const b = nodeSizes(base);
const before = fs.readFileSync(FILE, 'utf8');
const allowances = JSON.parse(before);
if (JSON.stringify(allowances, null, 2) + '\n' !== before) throw new Error(FILE + ' does not round-trip');
const WHY = 'Daily agronomy parity (spec docs/superpowers/specs/2026-09-27-daily-agronomy-parity-design.md), measured with verify-flows-size-ratchet nodeSizes over both byte-identical profiles: ';
const PRIOR = '. Supersedes the prior entry, whose growth this delta includes. ';
const NODES = {
  'zone-env-fn': (m) => `${WHY}${m}${PRIOR}The zone query reads iz.stage_started_on for the Kc curve, and the daily agronomy SELECT reads stage_overrun.`,
};
// zone-env-fn stays below its origin/main size (sub-project 2 shrank it by 369), so it
// needs no node entry, as sub-project 2 Task 9 ruled; one is written only if it grew past it.
for (const [id, reason] of Object.entries(NODES)) {
  const delta = h.get(id).chars - b.get(id).chars;
  const measured = `origin/main ${b.get(id).chars} -> HEAD ${h.get(id).chars} = ${delta >= 0 ? '+' : ''}${delta}`;
  if (delta > 0) allowances.node_allowances[id] = { delta, reason: reason(measured) };
  console.log(id, measured, delta > 0 ? '(node entry written)' : '(below origin/main: no node entry)');
}
const totalDelta = totalChars(head) - totalChars(base);
allowances.total_allowance = {
  delta: totalDelta,
  reason: `Branch feat/daily-agronomy-parity, stacked on feat/weather-data-view and feat/daily-agronomy (the weather provider store, the daily agronomy record, the weather data view and daily agronomy parity, all unmerged to origin/main), measured with verify-flows-size-ratchet totalChars over both byte-identical profiles: origin/main ${totalChars(base)} -> HEAD ${totalChars(head)} = +${totalDelta}. Carried from feat/daily-agronomy: +4138 (weather-provider-tick 0, weather-provider-fn 1467, station-hours-fn 1525, agronomy-daily-fn 1515, zone-env-fn -369). Carried from feat/weather-data-view: +4307 (sync-init-fn 1394, zone-config-fn 737, get-zones-query 19, get-zones-response 337, sync-bootstrap-build 150, sync-force-build 150, al-link-build-req 33, 4f4a765f36cee6f3 1487). This branch: sync-init-fn (0064), zone-config-fn, get-zones-query, get-zones-response, sync-bootstrap-build, sync-force-build, al-link-build-req, 4f4a765f36cee6f3 and zone-env-fn grew by the deltas of their node entries. When the earlier branches merge to origin/main their share moves into the base total and this entry drops by it.`,
};
console.log('total', `origin/main ${totalChars(base)} -> HEAD ${totalChars(head)} = +${totalDelta}`);
fs.writeFileSync(FILE, JSON.stringify(allowances, null, 2) + '\n');
```
```bash
node "$SCRATCH/ratchet-e2-task5.js"
node scripts/verify-flows-size-ratchet.js --write-baseline
node scripts/verify-flows-size-ratchet.js
```
Expected: `zone-env-fn origin/main 41848 -> HEAD 41552 = -296 (below origin/main: no node entry)` (this task adds 73 characters; sub-project 2 left the node 369 below origin/main); `total origin/main 1580418 -> HEAD 1597207 = +16789`; ratchet OK. Pin what the script prints. If the node ever measures above origin/main, the script writes its exact entry.

In `scripts/verify-live-gateway-identity.js`, the total pin from Task 3 becomes:
```js
  // 16789: plan E2a Task 5 adds zone-env-fn (+73: iz.stage_started_on in the zone query and
  // stage_overrun in the daily agronomy SELECT) to Task 3's 16716. verify-flows-size-ratchet
  // totalChars over both byte-identical profiles: origin/main 1580418 -> HEAD 1597207 = +16789.
  expectCondition(sizeAllowances.total_allowance?.delta === 16789,
    'size total allowance: exact cumulative delta 16789',
    'size total allowance: expected exact cumulative delta 16789');
```

- [ ] **Step 6: Run the gates**

```bash
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/index.test.js
node scripts/capture-zone-env-vectors.js --verify
node scripts/verify-profile-parity.js && node scripts/verify-flows-fn-parse.js && node scripts/test-flows-wiring.js && node scripts/verify-no-stray-ddl.js && node scripts/verify-no-new-silent-catch.js
node scripts/verify-flows-size-ratchet.js && node scripts/verify-live-gateway-identity.js && node scripts/verify-sync-flow.js
```
Expected: `# pass 24` (pin what the runner prints); six vectors verified; the static gates pass; ratchet OK, identity passes, verify-sync-flow ends `All parity checks passed.`

- [ ] **Step 7: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-zone-env conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/capture-zone-env-vectors.js docs/contracts/zone-env scripts/verify-flows-size-ratchet-allowances.json scripts/verify-flows-size-ratchet-baseline.json scripts/verify-live-gateway-identity.js
git -c user.name=Project-OSI commit -m "feat(zone-env): Kc on the FAO-56 curve per date; stageOverrun and demandComputedBy per day; shared mode keeps cloud days"
```

---

### Task 6: Whole-plan gates and the execution report (E1 and E2a)

**Files:**
- Create: `docs/superpowers/plans/2026-09-27-daily-agronomy-parity-edge-execution-report.md` (E2b, E3 and E4 append to it)

- [ ] **Step 1: Run every gate the spec lists for E2a's surface**

```bash
node scripts/verify-agronomy-contract.js
node scripts/verify-sync-flow.js
node scripts/test-contract-schemas.js && node scripts/verify-sync-contract.js
node scripts/verify-runtime-schema-parity.js && node scripts/verify-trigger-body-parity.js && node scripts/generate-sync-trigger-source.js --check && node --test scripts/test-sync-trigger-source.js
node scripts/verify-migrations.js && node scripts/verify-seed-replay.js && node scripts/verify-db-schema-consistency.js && node scripts/verify-no-stray-ddl.js && node scripts/verify-profile-parity.js
node scripts/test-flows-wiring.js && node scripts/verify-no-new-silent-catch.js && node scripts/verify-flows-size-ratchet.js && node scripts/verify-live-gateway-identity.js
node --test scripts/test-stage-started-on-migration.js scripts/test-legacy-upsert-zone-config.js scripts/test-zone-update-sync-version.js scripts/test-zone-command-path.js scripts/test-terra-zone-config-command-flow.js scripts/test-terra-selection-edge-acceptance.js scripts/test-zone-weather-source.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-agronomy-daily/*.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/index.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-crop-kc/index.test.js
node scripts/capture-zone-env-vectors.js --verify
OSI_SERVER_EDGE_SYNC_SERVICE=<osi-server>/.worktrees/daily-agronomy-cloud/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java node scripts/verify-sync-op-parity.js
```
Expected: every line OK or `# fail 0`, with one known red that depends on the paired cloud worktree (plan review chair I2, E2-E4 I3). E2a adds no op. While the paired osi-server branch lacks plan CC1, `verify-sync-op-parity` passes. Once CC1 is on it (the adopted execution order runs CC1 before E2a), the report lists exactly one difference, `  server extra vs union: ZONE_AGRONOMY_UPSERTED`, and ends in FAIL: the cloud's applier waits for the op that plan E4 Task 1 adds to the edge. At the re-anchoring (2026-09-28) the paired branch already carried CC1, so this FAIL form is the expected one. Since Task 1 Step 2 the verifier reads 0063's `CASE` payload, so no `payload_json missing contract_version` line appears. Any other line is a real failure. The migrate-runner pin and `reconcile-ledger-numbering.test.js` ran in Task 1.

- [ ] **Step 2: Cross-repo contract check**

In the cloud checkout: `EDGE_CONTRACT_ROOT=<osi-os>/.worktrees/daily-agronomy-parity sh scripts/verify-edge-sync-contract-vendor.sh` (read-only; it `cmp`s the vendored `resources.schema.json` against this branch's). Expected red until the controller re-vendors: plan CC1 Task 4 copied the edge's `resources.schema.json` before Task 3 added `stage_started_on`, so this file is the one that differs, and no other (`vendored contract differs: resources.schema.json`). The controller's re-vendor step after E2 (E2a changes the file; E2b does not) copies it to the cloud branch; after that the check prints OK (plan review E2-E4 minor 4).

- [ ] **Step 3: Start the execution report**

Write `docs/superpowers/plans/2026-09-27-daily-agronomy-parity-edge-execution-report.md` in sub-project 2's shape (`docs/superpowers/plans/2026-09-26-daily-agronomy-execution-report.md`), with a header naming the branch, the spec path and the base it was measured on, and two sections (plan review E2-E4 minor 6; E2b, E3 and E4 append theirs):

- **E1**: per task what was built and its commit; the hashes of `crop-kc.json` (`9b58c927…`), `kc-vectors.json` (`dd3fd36c…`) and `et0-vectors.json` (`48351340…`) as `sha256sum` printed them; the verifier's OK line; deviations from the plan and why; the follow-ups E1 records (the GUI bundle's 101 KB catalogue, to be lazy-loaded; the cloud's Java input rules for the years 0-99, zone-less time strings and the night ratio range).
- **E2a**: per task what was built and its commit; the ratchet numbers of Tasks 1, 2, 3 and 5 (per node and total) with the `origin/main` size they were measured against, and the numbers the controller re-measured after the rebase; the test counts the runner printed; the op-parity result of Step 1 and which of its two expected forms it was; the vendor check of Step 2 and whether the re-vendor has run; deviations from the plan and why.

The report names no customer instance, customer branch or live deployment hash: osi-os is public (controller ruling on plan review E1-E3 I1). Deploy-order constraints are written in general terms ("each customer cloud"); the private SDD ledger lists the instances.

```bash
node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/plans/2026-09-27-daily-agronomy-parity-edge-execution-report.md
git add docs/superpowers/plans/2026-09-27-daily-agronomy-parity-edge-execution-report.md
git -c user.name=Project-OSI commit -m "docs: edge execution report, E1 and E2a sections"
```
Expected: `slop-check: PASS (no tier-1 findings)`.

---

## Spec coverage

| Spec item | Task |
|---|---|
| B2 0064, the three insertions (the payload pair in both branches of 0063's `weather_source` `CASE`), 22 pairs on `auto` and 23 with `weather_source`, `_ai` untouched, pins in sync-init and seed, seeds, seven DBs, CHECKSUMS, `schemaContract` (as a diff), `--check`, Terra fixture | 1 (fixture again in 3) |
| B constraints: runner pin 64, ratchet allowances, identity re-pins | 1, 2, 3, 5 |
| B4 Kc part: zone query, frozen snapshot with three columns, stored-snapshot SELECT, ROW_COLUMNS | 4 |
| B5 `zone-config-fn` (validation, clearing rule, stage-date default with the zone-local today, re-select), reads, snapshots, capability (both names, three builders, tests, AGENTS.md) | 2 |
| B5 legacy Build UPDATE SQL (`UPSERT_ZONE_CONFIG` and the flat `UPSERT_ZONE`, both rules as a `CASE`), protected `UPSERT_ZONE`, Terra field list unchanged and the Terra stage-date rules, contract and its README section | 3 |
| B5 GUI bullet | plan E2b |
| B7 `osi-zone-env` (today's Kc, forecast days, `stageOverrun`, `demandComputedBy`, DEMAND_FIELDS), `zone-env-fn` query, vectors with a dated case | 5 |
| Decisions "Start date on a server-side stage change" (controller ruling plan review E2 I2) | 2, 3 |
| Testing: `test-stage-started-on-migration.js`, `test-zone-command-path.js`, `test-legacy-upsert-zone-config.js`, `test-terra-zone-config-command-flow.js`, `test-zone-update-sync-version.js`, Terra acceptance, `capture-zone-env-vectors.js --verify` | 1-5 |
| D: the op-parity red window (CC1 before E4), the vendor re-copy | 6 |
| `verify-sync-op-parity.js` reads 0063's `CASE` payload (drift from sub-project 3's final fix wave, not a spec item) | 1 |
| Execution report (E1 and E2a sections) | 6 |
