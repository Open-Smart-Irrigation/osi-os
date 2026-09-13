# Boot-node schema safety implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the P0 cluster left by the 2026-09-11/12 Uganda incident so that a Node-RED boot can no longer drop, block, or silently diverge the `devices` table, and so the next such failure is visible in logs and caught in CI.

**Architecture:** The frozen `sync-init-fn` boot node keeps its one sanctioned job, converging the `devices.type_id` CHECK, but stops carrying a hand-written column list. The DDL and the copy statement are both built from one `DEVICES_COLUMNS` table in seed order, the copy reads the live column set inside the rebuild transaction and refuses to run when the live table carries a column the payload does not know, and CI asserts the table matches `seed-blank.sql` and covers every migration-added column. The Silvan EUI literal is retired by one new ordered migration plus a boot-node change that makes both sides emit byte-identical trigger text.

**Tech Stack:** Node.js 20 (`node:test`, `node:sqlite`), SQLite 3 (`sqlite3` CLI on device), Node-RED function nodes inside `flows.json`, OpenWrt procd init scripts, `lib/osi-migrate` ordered-migration runner.

**Spec:** `docs/superpowers/specs/2026-09-12-boot-node-schema-safety-brief.md` (verified P0 brief, 2026-09-12) and its adversarial review `docs/superpowers/specs/2026-09-13-boot-node-schema-safety-review.md` (2026-09-13), plus GitHub issues osi-os #219, #220, #221, #224, #223, #173, #157, #153, #93, #87, #222.

## Execution status / review decisions (2026-09-13)

Reviewed and approved by Phil on 2026-09-13. Implementation starts 2026-09-14 09:00. Wave 1 (Tasks 1-3) and Wave 2 (Task 4) proceed first, built in a worktree from `origin/main`, shipping on the next fleet redeploy after the 2026-09-13 deploy train (edge `main` `04dca4f8b`, cloud `244c73b0`). Wave 3 (Tasks 5-6) is DEFERRED to its own program: Task 5 lands a destructive migration `0057` that the fleet must take immediately after that train; its trigger-text change interacts with the W5 customer-lineage reconciliation fixtures whose numbering is undecided; and the link-node attribution change touches the sync path just repaired on Uganda on 2026-09-12. Task 7 close-out stays but depends on Wave 1 evidence (#222 already fixed by PR #225, #87 by the Uganda head-56 deploy). No collision with PRs #231/#232: those touch other flow nodes, the GUI, and `verify-sync-flow.js` only. The boot node, `lib/osi-migrate`, the migrations and the ratchet allowances are unchanged since baseline `3eee141f5`.

## Global constraints

- Baseline is `origin/main` at `3eee141f5`. The working checkout `feat/valve-control` is hundreds of commits behind; branch every task from `origin/main` and re-verify any claim below before acting on it.
- Ordered migrations under `database/migrations/ordered/` are immutable once merged. `lib/osi-migrate/migrations-loader.js` checksums raw file bytes and the runner marks a changed file `repair_required`. Fix forward with a new `NNNN__slug.sql`; confirm the next free version with `ls database/migrations/ordered/` rather than trusting this document.
- Every migration's first non-blank line is `-- risk: additive|destructive|data`.
- `sync-init-fn` is a frozen DDL surface. The only sanctioned change classes are the guarded `devices` CHECK rebuild (safety) and removal of existing behavior. Every touch reruns the four-verifier merge gate in `osi-schema-change-control`: `verify-runtime-schema-parity.js`, `verify-profile-parity.js`, `verify-devices-rebuild-fence.js`, `node --test scripts/rehearse-devices-rebuild.test.js`.
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/` is the source of truth; `conf/full_raspberrypi_bcm27xx_bcm2709/files/` is a byte-identical mirror. Copy, never hand-edit the mirror. `node scripts/verify-profile-parity.js` must end `All parity checks passed.`
- `flows.json` is script-edited only: parse, mutate, stringify, verify roundtrip. Never a text-editor edit.
- `database/seed-blank.sql` and all 7 bundled `farming.db` copies regenerate in the same commit as any schema change.
- Any change to `lib/osi-migrate/fingerprints.js` normalisation rules bumps `NORMALIZER_VERSION` (currently 3) and sets `PREVIOUS_NORMALIZER_VERSION` to the old value. No task here needs that bump; if one turns out to, stop and re-plan, because a bump invalidates every stamped baseline in the fleet.
- Every new test file is added to `.github/workflows/migrations.yml`'s `node --test` list in the same commit. A test that is written but never run is worse than no test (osi-os#182).
- No task in this plan writes to a live gateway. Live-Pi steps are read-only probes, and every probe on kaba100 or Uganda needs the user's explicit go in the turn it happens; production (`osicloud.ch`, Uganda) is never touched on a standing assumption.
- Prose deliverables (the runbook edit in Wave 4, PR bodies) run `node .claude/skills/anti-slop-writing/slop-check.js <file>`.

---

## Wave order and why

1. **Wave 1 — the boot node and its CI gates (#173, #219, #220, #224, #223).** Tasks 1-3. No migration, no seed change, no fingerprint impact, and it removes every mechanism by which a boot can damage `devices`. Task 1 merges what were three separate fixes because they are one edit: the seed and the boot DDL disagree on column *order* as well as nullability, so changing the DDL without simultaneously replacing the positional copy statement would write integer flags into REAL columns.
2. **Wave 2 — characterise the residual drift (#221).** Task 4. Deliberately a characterisation task, not a code task: the comparator never emits the `table|devices` diff shape the issue assumes, and Task 1 removes both real components of Uganda's refusal. It runs before Wave 3 because Wave 3 rewrites 12 trigger bodies, which changes the drift picture; any residual diff must be named and fixed against today's schema first.
3. **Wave 3 — retire the Silvan EUI literal (#157) and the catalog healer (#93).** Tasks 5-6. Largest surface: 12 seed triggers, 21 literal sites, a new migration, all 7 bundled DBs, and a runtime semantics change that needs its own tests.
4. **Wave 4 — documentation and close-out (#87, #222).** Task 7. No code; needs the evidence Waves 1-3 produce.

#88 (cut the 93 inline `ADD COLUMN`s over to the runner) stays out of scope. Task 1's `DEVICES_COLUMNS` table is deliberately shaped so #88 can delete it wholesale rather than untangle it.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (`sync-init-fn`) | `DEVICES_COLUMNS` in seed order; in-transaction copy builder; trigger text; `writable_schema` block removal | 1, 5, 6 |
| `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` | byte mirror | 1, 5, 6 |
| `scripts/verify-devices-rebuild-fence.js` | `run()`/exports refactor, seed parity gate, migration-superset gate, unknown-column abort check | 1, 6 |
| `scripts/verify-devices-rebuild-fence.test.js` (new) | tests for the above | 1, 6 |
| `scripts/rehearse-devices-rebuild.js` + `.test.js` | three new seeded cases | 1 |
| `scripts/verify-flows-size-ratchet-allowances.json` | `sync-init-fn` growth allowance and `total_allowance` | 1, 6 |
| `scripts/verify-rename-swap-fence.js` + `.test.js` (new) | generic swap-without-FK-fence scanner | 2 |
| `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init` | procd log capture | 3 |
| `scripts/verify-init-log-capture.js` + `.test.js` (new) | asserts the procd instance declares `stdout`/`stderr` | 3 |
| `lib/osi-migrate/__tests__/runner-boot-devices-rebuild-grace.test.js` (new) | stamp → boot → gate characterisation and guard | 4 |
| `database/migrations/ordered/NNNN__gateway_eui_fallback.sql` (new) | recreates the 12 EUI-literal triggers | 5 |
| `database/seed-blank.sql`, 7 bundled `farming.db`, `CHECKSUMS.json` | same text, regenerated together | 5 |
| `scripts/verify-trigger-body-parity.js` | `GATEWAY_EUI_LITERALS` rule updated | 5 |
| `lib/osi-migrate/__tests__/fingerprints-gateway-eui.test.js` | 22-site assertion retired | 5 |
| `docs/operations/uganda-catchup-runbook.md` | reconciled to the recovered state | 7 |
| `.github/workflows/migrations.yml` | wires every new verifier and test file | 1-3, 5 |

---

## Wave 1 — the boot node and its CI gates

### Task 1: One safe `devices` rebuild (#173, #219, #220)

**Files:**
- Modify: `scripts/verify-devices-rebuild-fence.js`
- Create: `scripts/verify-devices-rebuild-fence.test.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` (`sync-init-fn`) and the bcm2709 mirror
- Modify: `scripts/rehearse-devices-rebuild.js`, `scripts/rehearse-devices-rebuild.test.js`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`
- Modify: `.github/workflows/migrations.yml`

**Interfaces:**
- Consumes: `normalizeSqlClause` from `lib/osi-migrate/sql-normalize.js`.
- Produces: from `scripts/verify-devices-rebuild-fence.js`, `parseSeedDevicesColumns(seedSql) -> Array<{name, ddl}>`, `parseBootDevicesColumns(funcText) -> Array<{name, ddl}>`, `migrationAddedDevicesColumns(migrationsDir) -> Set<string>`, `run() -> void`. In the boot node, `DEVICES_COLUMNS` (array of `{ name, ddl, from, dflt }` in `seed-blank.sql` order) and `buildDevicesCopySql(present)`.

Three defects share one edit. The boot DDL declares `chameleon_enabled INTEGER NOT NULL DEFAULT 0` where the seed declares it nullable (#173). It hardcodes a 45-column list that no gate ties to the migrations, so `0026`/`0028`/`0029`'s `sdi12_*` columns could be, and on Uganda were, dropped by a rebuild (#219). And its copy selects those columns unconditionally, so on a source that lacks them the rebuild aborts on every boot (#220).

They cannot be fixed in sequence. The two column lists also differ in **order**: `origin/main`'s `seed-blank.sql` has `…_configured, dendro_ratio_at_retracted, dendro_ratio_at_extended, dendro_force_legacy, dendro_stroke_mm, dendro_ratio_zero, …` while the boot DDL has `…_configured, dendro_force_legacy, dendro_stroke_mm, dendro_ratio_at_retracted, dendro_ratio_at_extended, dendro_ratio_zero, …`. Reordering the DDL to match the seed while the positional `INSERT INTO devices_new SELECT …` still ships would write two `INTEGER DEFAULT 0` flags into two `REAL` columns and two REALs into the flags. One commit, or neither change.

`DEVICES_COLUMNS` adopts seed order. The physical reorder is safe and desirable: `scripts/semantic-schema-compare.js` keys columns by name and sorts them (`snapshotSchema`, the `sorted` map), so the comparator is order-blind, and a named `INSERT` never depends on order. It moves a rebuilt table's layout toward what a seeded gateway already has.

- [ ] **Step 0: Make the verifier requirable**

`scripts/verify-devices-rebuild-fence.js` today runs at require time and calls `process.exit` at top level, so a test that requires it would exit the runner with 0 and assert nothing. Wrap the existing body in `function run() { … }`, end with:

```js
module.exports = { parseSeedDevicesColumns, parseBootDevicesColumns, migrationAddedDevicesColumns, run };
if (require.main === module) run();
```

Commit this refactor on its own so the behavior-preserving move is reviewable: `node scripts/verify-devices-rebuild-fence.js` must still print `verify-devices-rebuild-fence: OK (2 flows)` and exit 0.

- [ ] **Step 1: Write the failing tests**

Create `scripts/verify-devices-rebuild-fence.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseSeedDevicesColumns, parseBootDevicesColumns, migrationAddedDevicesColumns,
} = require('./verify-devices-rebuild-fence');

const repo = path.resolve(__dirname, '..');
const FLOWS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];
const bootFunc = (rel) =>
  (JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf8'))
    .find((n) => n.id === 'sync-init-fn') || {}).func || '';
const seedText = () => fs.readFileSync(path.join(repo, 'database/seed-blank.sql'), 'utf8');

test('boot devices DDL matches the seed column-for-column, in order', () => {
  const seed = parseSeedDevicesColumns(seedText());
  assert.ok(seed.length > 40, 'sanity: the seed parser found the real devices table');
  for (const rel of FLOWS) {
    const boot = parseBootDevicesColumns(bootFunc(rel));
    assert.deepStrictEqual(boot.map((c) => c.name), seed.map((c) => c.name),
      `${rel}: devices column names or order differ from the seed`);
    seed.forEach((c, i) => assert.strictEqual(boot[i].ddl, c.ddl,
      `${rel}: devices.${c.name} declaration differs from the seed`));
  }
});

test('every migration-added devices column is in the boot DDL', () => {
  const added = migrationAddedDevicesColumns(path.join(repo, 'database/migrations/ordered'));
  assert.ok(added.has('sdi12_channel_layout_json'),
    'sanity: the parser sees 0029 ALTER TABLE devices ADD COLUMN');
  for (const rel of FLOWS) {
    const boot = new Set(parseBootDevicesColumns(bootFunc(rel)).map((c) => c.name));
    for (const col of added) {
      assert.ok(boot.has(col), `${rel}: boot DDL is missing migration-added devices.${col}`);
    }
  }
});

test('migrationAddedDevicesColumns ignores ALTERs on other tables', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'addcol-'));
  fs.writeFileSync(path.join(dir, '0001__x.sql'),
    '-- risk: additive\nALTER TABLE devices_audit ADD COLUMN nope TEXT;\n' +
    'ALTER TABLE devices ADD COLUMN yes_col TEXT;\n');
  assert.deepStrictEqual([...migrationAddedDevicesColumns(dir)], ['yes_col']);
});

test('the copy is built inside the transaction and refuses unknown live columns', () => {
  for (const rel of FLOWS) {
    const f = bootFunc(rel);
    assert.match(f, /t\.all\(\s*'PRAGMA table_info\(devices\)'\s*\)/,
      `${rel}: live column set must be read with t.all inside the rebuild transaction`);
    assert.match(f, /devices rebuild ABORTED: unknown live column/,
      `${rel}: an unknown live column must abort the rebuild, not be dropped`);
  }
});
```

Both parsers return `{ name, ddl }` per column of a `CREATE TABLE devices*` statement, with `ddl` the column declaration run through `normalizeSqlClause` from `lib/osi-migrate/sql-normalize.js` (one definition of "the same SQL" in this repo, and it survives the seed's multi-line `CHECK(type_id IN ( … ))`). Both stop at the first table-level `FOREIGN KEY (` at paren depth 1, and both split columns on commas at depth 1 so a `CHECK(a IN ('x','y'))` never splits mid-clause.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test scripts/verify-devices-rebuild-fence.test.js`
Expected: FAIL on all of — `chameleon_enabled` declaration mismatch, column order mismatch at positions 26-29, no `t.all('PRAGMA table_info(devices)')` in either flow, no abort message.

- [ ] **Step 3: Rewrite the boot node's rebuild**

Script-edit the bcm2712 profile, then `cp` to the mirror. Generate `DEVICES_COLUMNS` mechanically from `database/seed-blank.sql` — do not retype it — and keep the generator in the scratchpad, recording its command line in the PR body.

```js
const DEVICES_COLUMNS = [
  { name: 'id', ddl: 'id INTEGER PRIMARY KEY AUTOINCREMENT', from: ['id'], dflt: 'NULL' },
  { name: 'deveui', ddl: 'deveui TEXT UNIQUE NOT NULL', from: ['deveui'], dflt: "''" },
  /* … one entry per seed column, in seed order … */
  { name: 'dendro_enabled', ddl: 'dendro_enabled INTEGER NOT NULL DEFAULT 0', from: ['dendro_enabled'], dflt: '0' },
  { name: 'dendro_ratio_at_retracted', ddl: 'dendro_ratio_at_retracted REAL', from: ['dendro_ratio_at_retracted', 'dendro_ratio_zero'], dflt: 'NULL' },
  { name: 'dendro_ratio_at_extended', ddl: 'dendro_ratio_at_extended REAL', from: ['dendro_ratio_at_extended', 'dendro_ratio_span'], dflt: 'NULL' },
  { name: 'dendro_force_legacy', ddl: 'dendro_force_legacy INTEGER DEFAULT 0', from: ['dendro_force_legacy'], dflt: '0' },
  { name: 'chameleon_enabled', ddl: 'chameleon_enabled INTEGER DEFAULT 0', from: ['chameleon_enabled'], dflt: '0' },
  { name: 'sdi12_channel_layout_json', ddl: 'sdi12_channel_layout_json TEXT', from: ['sdi12_channel_layout_json'], dflt: 'NULL' },
];
const DEVICES_TABLE_CONSTRAINTS = 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL, FOREIGN KEY (farm_id) REFERENCES farms(farm_id) ON DELETE SET NULL';
const DEVICES_NEW_DDL = 'CREATE TABLE IF NOT EXISTS devices_new (' +
  DEVICES_COLUMNS.map((c) => c.ddl).join(', ') + ', ' + DEVICES_TABLE_CONSTRAINTS + ')';
const buildDevicesCopySql = (present) => 'INSERT INTO devices_new (' +
  DEVICES_COLUMNS.map((c) => c.name).join(',') + ') SELECT ' +
  DEVICES_COLUMNS.map((c) => {
    const have = c.from.filter((f) => present.has(f));
    if (have.length === 0) return c.dflt;
    if (have.length === 1 && c.dflt === 'NULL') return have[0];
    return 'COALESCE(' + have.join(',') + ',' + c.dflt + ')';
  }).join(',') + ' FROM devices';
```

Every `ddl` string is byte-equal to the seed's declaration for that column, because Step 1's gate compares them after `normalizeSqlClause`. A column declared `NOT NULL` must have a non-`NULL` `dflt`, or a source missing it would violate the constraint.

Inside the transaction executor, replacing the single `await t.run(DEVICES_COPY_SQL)`:

```js
        const known = new Set(DEVICES_COLUMNS.map((c) => c.name));
        const info = await t.all('PRAGMA table_info(devices)');
        const present = new Set((info || []).map((r) => r.name));
        const unknown = [...present].filter((n) => !known.has(n));
        if (unknown.length) {
          // This payload is older than the live schema (osi-os#222 ordering).
          // Copying would drop these columns and their data; refuse instead.
          throw new Error('devices rebuild ABORTED: unknown live column(s) ' + unknown.join(',')
            + ' — this flows payload predates the live schema; deploy the matching payload first');
        }
        await t.run(buildDevicesCopySql(present)); // plain INSERT: a CHECK violation still rolls back
```

Read the live columns with `t.all`, not `_db.all`. The transaction scope exposes `run`/`all`/`get`/`exec` (`osi-db-helper/index.js`, `createTransactionScope`), and `verify-devices-rebuild-fence.js` forbids `_db.*` inside the executor because a facade-level call from an open transaction deadlocks on-device. Reading outside the transaction would also be wrong on its own terms: the column set could change between the read and the copy.

The unknown-column refusal is the half of #219 that a repo-side CI gate cannot cover. Step 1's superset gate proves the shipped payload knows every column the *current* migrations add; it says nothing about a gateway running an older payload against a newer schema, which is exactly the pairing that damaged Uganda. Refusing leaves `devices` intact and surfaces `node.error` — which, after Task 3, reaches syslog.

- [ ] **Step 4: Wire the new gates into the verifier**

In `run()`, inside the per-flow loop, after the existing fail-closed checks:

```js
  const bootCols = parseBootDevicesColumns(func);
  const seedCols = parseSeedDevicesColumns(fs.readFileSync(SEED, 'utf8'));
  if (bootCols.map((c) => c.name).join(',') !== seedCols.map((c) => c.name).join(',')) {
    problems.push(`${rel}: devices DDL column list or order differs from database/seed-blank.sql`);
  } else {
    seedCols.forEach((c, i) => {
      if (c.ddl !== bootCols[i].ddl) problems.push(`${rel}: devices.${c.name} declaration differs from the seed (${bootCols[i].ddl} vs ${c.ddl})`);
    });
  }
  const bootNames = new Set(bootCols.map((c) => c.name));
  for (const col of migrationAddedDevicesColumns(MIGRATIONS_DIR)) {
    if (!bootNames.has(col)) problems.push(`${rel}: boot DDL is missing migration-added devices.${col}`);
  }
  if (!/t\.all\(\s*'PRAGMA table_info\(devices\)'\s*\)/.test(func)) problems.push(`${rel}: rebuild must read the live column set with t.all inside the transaction`);
  if (!/devices rebuild ABORTED: unknown live column/.test(func)) problems.push(`${rel}: rebuild must abort on a live column the payload does not know`);
```

Keep the superset check even though the seed-equality check subsumes it today: it is the one that names the offending column when someone lands an `ALTER TABLE devices ADD COLUMN` without touching the boot node, the exact CI gap that let `0026` through.

- [ ] **Step 5: Extend the rehearsal**

`scripts/rehearse-devices-rebuild.js` ships five seeded cases on `origin/main` (`healthy`, `would-drop`, `legit-upgrade`, `sdi12-sentinels`, `extra-type`). Add four, each executing the real shipped function text:

```js
test('missing source columns: rebuild succeeds and backfills defaults', async () => {
  const res = await rehearse('missing-source-columns'); // pre-0026 column set, 6-type CHECK, 2 rows
  assert.strictEqual(res.aborted, false, 'rebuild must not abort: ' + (res.error || ''));
  assert.strictEqual(res.rowCount, 2);
  for (const c of ['sdi12_probe_profile', 'sdi12_probe_status', 'sdi12_identity',
                   'sdi12_value_count', 'sdi12_channel_layout_json']) {
    assert.ok(res.columns.includes(c), `rebuilt devices must have ${c}`);
  }
  assert.strictEqual(res.rows[0].sdi12_channel_layout_json, null);
  assert.strictEqual(res.rows[0].dendro_enabled, 0, 'NOT NULL columns take their default, never NULL');
});

test('extra live column: rebuild ABORTS and devices is left intact', async () => {
  const res = await rehearse('extra-live-column'); // head columns + devices.future_col TEXT, 6-type CHECK
  assert.strictEqual(res.aborted, true);
  assert.match(res.error, /unknown live column\(s\) future_col/);
  assert.ok(res.columns.includes('future_col'), 'the live column and its data survive');
  assert.strictEqual(res.rowCount, 2);
});

test('null chameleon_enabled survives the rebuild', async () => {
  const res = await rehearse('null-chameleon');
  assert.strictEqual(res.aborted, false);
  assert.strictEqual(res.rows[0].chameleon_enabled, 0, 'COALESCE default applied');
});

test('Uganda post-repair column set: rebuild succeeds on the manually-repaired shape', async () => {
  const res = await rehearse('uganda-post-repair-columns'); // Uganda's exact post-repair devices
                                                              // column set (2026-09-12 manual
                                                              // repair, chameleon_enabled re-added
                                                              // by hand out of seed order)
  assert.strictEqual(res.aborted, false, 'rebuild must not abort: ' + (res.error || ''));
  assert.ok(res.columns.includes('chameleon_enabled'));
});
```

The `uganda-post-repair-columns` fixture's column list must be captured from a fresh `.backup` copy of Uganda's live DB, taken with Phil's explicit go in the turn it happens — Uganda is production and this is a read against it, not a rehearsal shape to invent from memory.

Extend the harness's result object with `columns`, `rows`, `rowCount` and `error` if it does not already expose them, and keep the five existing cases passing unchanged. Nine cases total after this task.

- [ ] **Step 6: Record the size-ratchet allowance**

`scripts/verify-flows-size-ratchet.js` measures each node against `origin/main` and consults `scripts/verify-flows-size-ratchet-allowances.json` (`node_allowances[<node id>].delta` plus `.reason`, and `total_allowance.delta`). `DEVICES_COLUMNS` is roughly 45 entries of about 100 bytes, so `sync-init-fn` grows by several kilobytes; Task 6's deletion of the `writable_schema` block recovers under a kilobyte and does not offset it.

Measure the real delta with the verifier's own `nodeSizes` over both profiles, then add one entry keyed `sync-init-fn` with the measured number and a reason naming this plan, #173/#219/#220, and what the bytes buy. Raise `total_allowance.delta` by the same amount. Do not regenerate the baseline file to make the check pass — the baseline tracks `origin/main`, and rewriting it would erase every other node's pin.

- [ ] **Step 7: Run the full gate**

```bash
node --test scripts/verify-devices-rebuild-fence.test.js
node --test scripts/rehearse-devices-rebuild.test.js
node scripts/verify-devices-rebuild-fence.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-profile-parity.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-boot-ddl-interpolation.js
node scripts/verify-trigger-body-parity.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-flows-size-ratchet.js
node scripts/verify-sync-flow.js
```

Expected: all exit 0; `verify-devices-rebuild-fence: OK (2 flows)`, nine rehearsal cases pass, `verify-trigger-body-parity: OK`, `verify-sync-flow.js` prints `Sync flow verification passed` and ends `All parity checks passed.`

- [ ] **Step 8: Wire CI and commit**

Add `scripts/verify-devices-rebuild-fence.test.js` to the `node --test` list in `.github/workflows/migrations.yml` (the long line that already carries `scripts/semantic-schema-compare.test.js`).

```bash
git add scripts/verify-devices-rebuild-fence.js scripts/verify-devices-rebuild-fence.test.js \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
  scripts/rehearse-devices-rebuild.js scripts/rehearse-devices-rebuild.test.js \
  scripts/verify-flows-size-ratchet-allowances.json .github/workflows/migrations.yml
git commit -m "fix(boot): rebuild devices from one seed-ordered column table, fail closed on unknown live columns (#173, #219, #220)"
```

---

### Task 2: Generic rename-swap FK fence scanner (#224)

**Files:**
- Create: `scripts/verify-rename-swap-fence.js`, `scripts/verify-rename-swap-fence.test.js`
- Modify: `.github/workflows/migrations.yml`

**Interfaces:**
- Consumes: nothing.
- Produces: `scanSqlText(label, sql) -> Array<string>` and `run()`; `module.exports` with both, `if (require.main === module) run();`.

Two corrections to the naive form of this check. The rule cannot be "contains `PRAGMA foreign_keys=OFF`": migrations `0004`, `0010`, `0027` do rename-swaps and are fenced by the runner, which wraps every `destructive` migration in `PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE; …; COMMIT; PRAGMA foreign_keys=ON;`. And the pattern cannot be `RENAME TO *_old|*_new`: `scripts/ops/uganda-schema-rebuild-20260911.sql` does `DROP TABLE devices;` then `ALTER TABLE devices_rebuild_20260911 RENAME TO devices;` — a swap with neither suffix, and the one that actually ran during the incident.

The rule: within one text, flag any `DROP TABLE [IF EXISTS] <t>` where `<t>` is the source or the target of a `RENAME TO` in the same text, unless the text declares `-- risk: destructive` or carries `PRAGMA foreign_keys=OFF` before the first of the two statements.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { scanSqlText } = require('./verify-rename-swap-fence');

const SUFFIX_SWAP = `ALTER TABLE zones RENAME TO zones_old;
CREATE TABLE zones (id INTEGER PRIMARY KEY);
INSERT INTO zones SELECT * FROM zones_old;
DROP TABLE zones_old;`;

const DROP_FIRST_SWAP = `CREATE TABLE zones_rebuild_20260911 (id INTEGER PRIMARY KEY);
INSERT INTO zones_rebuild_20260911 SELECT id FROM zones;
DROP TABLE zones;
ALTER TABLE zones_rebuild_20260911 RENAME TO zones;`;

test('unfenced suffix swap is reported', () => {
  const p = scanSqlText('f.sql', '-- risk: additive\n' + SUFFIX_SWAP);
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /rename-swap involving zones_old without an FK fence/);
});

test('unfenced drop-then-rename swap is reported', () => {
  const p = scanSqlText('ops.sql', DROP_FIRST_SWAP);
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /rename-swap involving zones without an FK fence/);
});

test('destructive risk class counts as fenced (the runner wraps it)', () => {
  assert.deepStrictEqual(scanSqlText('f.sql', '-- risk: destructive\n' + SUFFIX_SWAP), []);
});

test('an explicit pragma counts as fenced', () => {
  assert.deepStrictEqual(
    scanSqlText('ops.sql', 'PRAGMA foreign_keys=OFF;\n' + DROP_FIRST_SWAP + '\nPRAGMA foreign_keys=ON;'), []);
});

test('a rename with no DROP of either table is not a swap', () => {
  assert.deepStrictEqual(scanSqlText('f.sql', 'ALTER TABLE zones RENAME TO zones_archive;'), []);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/verify-rename-swap-fence.test.js`
Expected: FAIL with `Cannot find module './verify-rename-swap-fence'`.

- [ ] **Step 3: Implement**

Normalise with `String(sql).replace(/\s+/g, ' ')` before matching so SQL embedded in JavaScript string concatenation still matches. `run()` scans four corpora and prints `verify-rename-swap-fence: OK (<n> files)`:

- `database/migrations/ordered/*.sql`
- `scripts/ops/*.sql` — the executed artifacts
- `scripts/ops/*.js` — the generators
- every function-node `func` body in both `flows.json` profiles, labelled `<profile>:<node id>`

Expected current result: zero problems. `sync-init-fn` and `scripts/ops/uganda-schema-rebuild-20260911.sql` both hold `PRAGMA foreign_keys=OFF`; `0004`/`0010`/`0027` pass on their risk header. Anything the scanner reports is a live finding: stop and report it before writing a suppression.

- [ ] **Step 4: Run, wire, commit**

```bash
node --test scripts/verify-rename-swap-fence.test.js
node scripts/verify-rename-swap-fence.js
```

Add both a `- run: node scripts/verify-rename-swap-fence.js` step and the test file to the `node --test` list in `.github/workflows/migrations.yml`.

```bash
git add scripts/verify-rename-swap-fence.js scripts/verify-rename-swap-fence.test.js .github/workflows/migrations.yml
git commit -m "ci(schema): scan every rename-swap rebuild for the FK fence (#224)"
```

---

### Task 3: Capture Node-RED stdout/stderr in the init script (#223)

**Files:**
- Modify: `feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init`
- Create: `scripts/verify-init-log-capture.js`, `scripts/verify-init-log-capture.test.js`
- Modify: `.github/workflows/migrations.yml`

The file lives in the firmware feed, so an image rebuild is one delivery path, though not the one that matters here. `deploy.sh` already installs it on every deploy (`fetch_required "Node-RED init script" … "/etc/init.d/node-red"`, then `chmod 755`), the path is in both fetch lists, and `scripts/deploy-fetch-list.test.js` already asserts it. Already-flashed gateways therefore pick the change up from the next `deploy.sh` run with no new on-device patch step and no change to `deploy.sh`. It takes effect at the `/etc/init.d/node-red restart` deploy performs anyway.

OpenWrt's `syslog`/`logread` is a RAM ring buffer: it is lost on reboot, so `procd_set_param stdout/stderr` alone only survives a service restart, not a power cycle. This task must also add a bounded persistent log sink for the Node-RED service under `/data` (or an equivalent on-disk location), and the live verification step must show the boot-node failure line survives both a service restart AND a reboot. Without the persistent sink, #223 is not closed.

- [ ] **Step 1: Write the failing test**

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { scanInit } = require('./verify-init-log-capture');

const INIT = path.resolve(__dirname,
  '../feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init');

test('shipped init declares stdout and stderr capture', () => {
  assert.deepStrictEqual(scanInit(fs.readFileSync(INIT, 'utf8')), []);
});

test('a missing stderr param is reported', () => {
  const p = scanInit('procd_open_instance\nprocd_set_param stdout 1\nprocd_close_instance\n');
  assert.strictEqual(p.length, 1);
  assert.match(p[0], /procd_set_param stderr/);
});
```

`scanInit(text)` returns one problem per missing parameter, matching `/^\s*procd_set_param\s+(stdout|stderr)\s+1\s*$/m` within the `procd_open_instance` … `procd_close_instance` block.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test scripts/verify-init-log-capture.test.js`
Expected: FAIL — the shipped init declares neither parameter.

- [ ] **Step 3: Edit the init script**

Immediately after `procd_set_param respawn 3600 5 -1`, before `procd_close_instance`:

```sh
    # osi-os#223: route Node-RED's stdout/stderr into syslog so node.error/node.warn
    # survive the process. Without these, a boot-node failure leaves no trace.
    procd_set_param stdout 1
    procd_set_param stderr 1
```

- [ ] **Step 4: Run the verifiers**

```bash
node --test scripts/verify-init-log-capture.test.js
node scripts/verify-init-log-capture.js
node --test scripts/deploy-fetch-list.test.js
```

Expected: all exit 0. The fetch-list test is the proof that already-flashed gateways receive the file.

- [ ] **Step 5: Wire CI and commit**

Add `- run: node scripts/verify-init-log-capture.js` and the test file to the `node --test` list.

```bash
git add feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init \
  scripts/verify-init-log-capture.js scripts/verify-init-log-capture.test.js \
  .github/workflows/migrations.yml
git commit -m "fix(init): persist Node-RED stdout/stderr to syslog (#223)"
```

- [ ] **Step 6: Live verification recipe (operator, at rollout time)**

Never during a deploy window; the 2026-09-13 deploy train must be reported finished on each host before any probe. After the first `deploy.sh` carrying this change:

```sh
grep -n 'procd_set_param std' /etc/init.d/node-red        # two hits
/etc/init.d/node-red restart
sleep 20
logread | grep -i node-red | tail -20
```

The pass signal is any Node-RED `node.warn`/`node.error` line reaching `logread`. An empty result after a restart means the deployed file is not the new one.

---

## Wave 2 — characterise the residual drift

### Task 4: Prove the drift gate accepts a post-boot gateway (#221)

**Files:**
- Create: `lib/osi-migrate/__tests__/runner-boot-devices-rebuild-grace.test.js`
- Create: `lib/osi-migrate/__tests__/helpers/boot-rehearsal.js`
- Modify: `.github/workflows/migrations.yml`
- Modify (only if Step 1 says so): `lib/osi-migrate/runner.js`

This task is a characterisation first and a code change only on evidence. Issue #221 asks for tolerance of a `table|devices` diff, but `scripts/semantic-schema-compare.js`'s `compareSchemas` never emits `{kind: 'table', class: 'changed'}` — a table's contents surface as `column`, `check` and `foreign_key` diffs, and `table` diffs are only `missing`, `extra_forward` or `extra_unknown`. Uganda's 16th refusal was therefore a `changed column devices.chameleon_enabled` (#173) plus `missing column devices.sdi12_*` (#219), both of which Task 1 removes at the source. The 15 trigger diffs were already tolerated by `isBootOwnedTriggerBodyDrift`.

The expected outcome is that Step 1's first test passes with no change to `runner.js`, and #221 closes as fixed by Task 1 with these tests as the standing guard. Do not write tolerance code to satisfy an issue title.

- [ ] **Step 1: Write the characterisation test and read what it reports**

`lib/osi-migrate/__tests__/helpers/boot-rehearsal.js` exposes `stampThenBoot({ head, deviceEui, forceRebuild, mutateAfterBoot })`: build a scratch DB from the real ordered migrations to `head`, stamp fingerprints (what `deploy.sh` does with Node-RED stopped), then execute the **shipped** `sync-init-fn` function text against it through the same `node:sqlite` facade shim `scripts/rehearse-devices-rebuild.js` uses. It returns `{ runner, refRunner, head, diffs }`, where `diffs` is `compareSchemas(live, reference(head)).diffs`. Extract the function text from `flows.json`; a hand-copied DDL in a test proves nothing about the shipped node. `forceRebuild: true` must narrow the live `devices` CHECK **before** the stamp — the way `reseedDevicesCheck` in `scripts/rehearse-devices-rebuild.js` does — so that the stamped baseline holds the pre-rebuild state and the boot pass is what changes it; narrowing after the stamp would bake the rebuild's own result into the baseline and the test would pass vacuously.

```js
test('stamp -> boot rebuild -> drift gate accepts without a manual restamp', async () => {
  const { runner, diffs } = await stampThenBoot({
    head: HEAD, deviceEui: '0016C001F151B1D6', forceRebuild: true });
  const residual = diffs.filter((d) => d.kind !== 'trigger');
  assert.deepStrictEqual(residual, [],
    'a boot rebuild must leave no non-trigger diff: ' + JSON.stringify(residual));
  await assert.doesNotReject(
    applyPending(runner, { migrationsDir: MIGRATIONS, appVersion: 'test', writersStopped: true }));
});

test('a devices rebuild that drops a column still refuses', async () => {
  const { runner } = await stampThenBoot({
    head: HEAD, deviceEui: '0016C001F151B1D6', forceRebuild: true,
    mutateAfterBoot: 'ALTER TABLE devices DROP COLUMN dendro_baseline_pending' });
  // Not sdi12_channel_layout_json: trg_sentek_device_outbox_payload_ai reads it
  // (seed-blank.sql:2506-2507), so SQLite refuses that DROP COLUMN and the helper
  // would throw before applyPending ever runs. dendro_baseline_pending has no
  // trigger or index reference in the seed. To drop a referenced column instead,
  // the helper must do it via a table rebuild.
  await assert.rejects(
    applyPending(runner, { migrationsDir: MIGRATIONS, appVersion: 'test', writersStopped: true }),
    /schema drift detected/);
});

test('an unrelated schema change still refuses', async () => {
  const { runner } = await stampThenBoot({
    head: HEAD, deviceEui: '0016C001F151B1D6',
    mutateAfterBoot: 'DROP INDEX IF EXISTS idx_devices_farm_id' });
  await assert.rejects(
    applyPending(runner, { migrationsDir: MIGRATIONS, appVersion: 'test', writersStopped: true }),
    /schema drift detected/);
});
```

Run: `node --test lib/osi-migrate/__tests__/runner-boot-devices-rebuild-grace.test.js`

Read the first test's failure message if it fails. It prints the residual diffs verbatim, and that list is the decision:

- **Empty list, all three green.** Done. Commit the tests, close #221 citing Task 1, and skip Step 2.
- **A named residual `column`, `check` or `foreign_key` diff on `devices`.** That is a real, reproducible divergence between the boot DDL and the seed that Task 1's textual gate did not catch. Fix the boot DDL so the diff disappears; do not tolerate it. Only if the diff is provably not fixable in the DDL (for example SQLite reporting a different `dflt_value` spelling for identical semantics) does Step 2 apply.
- **A diff on a table other than `devices`.** Out of scope for this task. Report it as a new finding.

- [ ] **Step 2 (conditional): Add a named tolerance**

Only on the third outcome above. In `isBootOwnedTriggerBodyDrift` (rename to `isBootOwnedSchemaDrift`, updating both call sites and the comment block), tolerate exactly the named diff — matched by `kind`, `class`, and the exact `name` string, for `devices` only, with the live and reference values compared through `normalizeSqlClause`. Write the bound in the comment as "this diff and no other", and add a test asserting a neighbouring diff of the same `kind` on the same table still refuses. Do not touch `fingerprints.js`.

- [ ] **Step 3: Note the scope limit**

Whatever the outcome, add a comment above the grace path recording that it can only tolerate what `compareSchemas` reports, and that the comparator ignores column order and anything in `IGNORED_TABLES`. A future reader must not read "the grace path accepted it" as "the schema is identical".

- [ ] **Step 4: Run the whole runner suite and commit**

```bash
node --test lib/osi-migrate/__tests__/*.test.js
node --test scripts/baseline-existing-db.test.js scripts/restamp-fingerprints.test.js scripts/semantic-schema-compare.test.js
```

Expected: all exit 0, including `runner-boot-trigger-grace.test.js` and `fingerprints-boot-rewrite-rehearsal.test.js`, whose "real drift is still caught" case is the regression guard here. The new test file goes into the `node --test lib/osi-migrate/__tests__/*.test.js` glob automatically; the helper lives under `helpers/` so the glob does not try to run it.

```bash
git add lib/osi-migrate/__tests__/runner-boot-devices-rebuild-grace.test.js \
  lib/osi-migrate/__tests__/helpers/boot-rehearsal.js
git commit -m "test(migrate): pin that a boot-node devices rebuild no longer blocks the drift gate (#221)"
```

---

## Wave 3 — retire the Silvan EUI literal and the catalog healer

### Task 5: Data-driven gateway-EUI fallback (#157)

**Files:**
- Create: `database/migrations/ordered/NNNN__gateway_eui_fallback.sql`
- Modify: `database/seed-blank.sql`, `database/migrations/ordered/CHECKSUMS.json`, all 7 bundled `farming.db`
- Modify: both `flows.json` profiles (`sync-init-fn` trigger strings, and the link-finalize node)
- Modify: `scripts/verify-trigger-body-parity.js`
- Modify: `lib/osi-migrate/__tests__/fingerprints-gateway-eui.test.js`
- Test: `lib/osi-migrate/__tests__/fingerprints-boot-rewrite-rehearsal.test.js`, plus a new runtime-semantics test

**What the boot node produces today versus what the migration must produce.** `sync-init-fn` computes `gatewaySql` from `env DEVICE_EUI` (`'0016C001F151B1D6'` on Uganda, the bare string `NULL` when the variable is absent or malformed) and interpolates it at 22 sites across 12 trigger bodies, always as the last argument of a `COALESCE(<…gateway_device_eui…>, <literal>)`. The seed and migrations `0001/0003/0010/0015/0016/0017/0027/0028` bake `'0016C001F11715E2'` into the same slot. `fingerprints.js`'s v3 `canonicalizeGatewayEuiCoalesce` rewrites exactly that slot to `'<gateway_eui>'` when the final argument is `null` or a 16-hex literal, which is why the drift is survivable today.

That last clause is the trap. Suppose the migration replaced the literal with a subquery while the boot node kept interpolating a literal: the canonicaliser's `/(^|,)(null|'[0-9a-f]{16}')$/i` test only fires on a literal tail, so the reference's subquery tail and the live literal would hash differently, and a new permanent drift class would replace the one being retired. The migration and the boot node must therefore emit the same text, and `gatewaySql` must stop appearing in trigger bodies.

Canonical fallback, used verbatim in the migration, in `seed-blank.sql`, and in the boot node's trigger strings:

```sql
NULLIF(trim((SELECT gateway_device_eui FROM sync_link_state WHERE peer_node='cloud')),'')
```

as the final `COALESCE` argument. After this the two sides match token for token, so v3 normalisation is no longer load-bearing for these 12 triggers. It stays in place for gateways that have not yet taken the migration, and it still canonicalises nothing here because the new tail is neither `null` nor a hex literal.

**Runtime semantics change — this is the part that needs deciding, not just implementing.** Today `trg_sync_devices_defaults_ai` and `trg_sync_zones_defaults_ai` stamp the env `DEVICE_EUI` onto a new row at insert. After the migration they read `sync_link_state.gateway_device_eui`, which is:

- `NULL` on a never-linked database (the seed's `sync_link_state` insert only fires for a user with a `server_url` and a sync token, and derives the EUI from existing `devices`/`irrigation_zones` rows);
- set to `NULL` on unlink (`UPDATE sync_link_state SET linked=0, server_url=NULL, cloud_user_id=NULL, gateway_device_eui=NULL, …`);
- after linking, the link-scoped EUI, which is `LINK_GATEWAY_DEVICE_EUI` from `uci osi-server.cloud.link_gateway_device_eui` and can differ from `DEVICE_EUI`.

So a device or zone created while unlinked gets `gateway_device_eui = NULL` and keeps it until the next Node-RED boot, where the two env-driven `UPDATE` sweeps in `sync-init-fn` fill it from `DEVICE_EUI`. Those sweeps are statements, not schema: they leave no fingerprint and they stay. But a gateway that is unlinked, gains a device, and is relinked before a reboot would attribute that row to the env EUI rather than the link EUI, which is the attribution the cloud expects.

Close that window in the same commit: the `al-link-finalize` node already writes `sync_link_state`, so have it also run

```sql
UPDATE devices SET gateway_device_eui = ? WHERE gateway_device_eui IS NULL OR trim(gateway_device_eui) = '';
UPDATE irrigation_zones SET gateway_device_eui = ? WHERE gateway_device_eui IS NULL OR trim(gateway_device_eui) = '';
```

with the link EUI. Statements only; no schema change, no fingerprint impact, and it is the same backfill the boot already does with a different source.

Two details the implementer has to decide rather than assume. `al-link-finalize` on `origin/main` has **no** transaction: it issues sequential `_db.*` calls, with no `_db.transaction` and no `t.run` anywhere in its body. So either wrap the `sync_link_state` upsert and the two backfill `UPDATE`s in `_db.transaction` — this node is not frozen, so that is allowed, and it is the option this plan prefers — or run them sequentially and accept a window in which `sync_link_state` says linked while the backfill has not happened. Pick one in the PR body and say which.

And the `irrigation_zones` backfill has a visible side effect. It runs after `linked=1`, so `trg_sync_zones_outbox_au` fires for every zone whose `gateway_device_eui` was NULL, emitting one `ZONE_UPSERTED` per row at link time. On a gateway with many pre-link zones that is a burst of outbox rows, not a silent update. It is the correct behavior — the cloud does need those zones attributed — but it must be expected rather than discovered, so the third attribution test asserts the emitted event count and payload attribution, not only the column values.

- [ ] **Step 1: Write the failing tests**

Extend `lib/osi-migrate/__tests__/fingerprints-boot-rewrite-rehearsal.test.js`:

```js
test('post-migration trigger bodies are identical between migration and boot node', async () => {
  const { refRunner, liveRunner } = await stampThenBoot({ head: HEAD, deviceEui: '0016C001F151B1D6' });
  for (const name of GATEWAY_EUI_TRIGGERS) {   // the 12 names, listed explicitly
    const live = await triggerSql(liveRunner, name);
    const ref = await triggerSql(refRunner, name);
    assert.ok(!/0016C001F11715E2/.test(live), `${name}: Silvan literal still live`);
    assert.ok(!/0016C001F11715E2/.test(ref), `${name}: Silvan literal still in the reference`);
    assert.strictEqual(normalizeSqlV3(live), normalizeSqlV3(ref), `${name}: bodies differ`);
  }
});

test('no gateway EUI literal survives in the seed', () => {
  const seed = fs.readFileSync(path.join(repo, 'database/seed-blank.sql'), 'utf8');
  assert.strictEqual((seed.match(/0016C001F11715E2/g) || []).length, 0);
});
```

The literal-absence assertions are raw text; the body comparison goes through `normalizeSqlV3`. Raw `live === ref` equality would only hold if the generator emits byte-identical single-line text into the migration, the seed and the boot node's JS string, which is an extra constraint this plan does not impose — the seed is hand-formatted multi-line SQL. If the generator is written to emit one identical form to all three, tighten this assertion to raw equality and say so in the PR body.

Add a new runtime-semantics test (`scripts/test-gateway-eui-attribution.js`, wired into `migrations.yml`) over a seeded DB at head:

```js
test('unlinked insert leaves gateway_device_eui NULL; the boot sweep fills it', async () => { /* … */ });
test('linked insert stamps sync_link_state.gateway_device_eui, not env DEVICE_EUI', async () => { /* … */ });
test('link finalize backfills devices and irrigation_zones, and emits one ZONE_UPSERTED per backfilled zone', async () => { /* … */ });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `node --test lib/osi-migrate/__tests__/fingerprints-boot-rewrite-rehearsal.test.js scripts/test-gateway-eui-attribution.js`
Expected: FAIL — 21 Silvan literal sites in the seed, the migration does not exist, and the link backfill is not implemented.

- [ ] **Step 3: Write the migration**

Confirm the next free version (`ls database/migrations/ordered/`), then:

```sql
-- risk: destructive
-- NNNN: retire the Silvan gateway EUI literal (osi-os#157, root cause of #153).
-- Recreates the 12 sync/outbox triggers that baked '0016C001F11715E2' as their
-- gateway_device_eui fallback, replacing it with the sync_link_state lookup the
-- boot node now emits byte-identically. DROP + CREATE of triggers only: no table
-- is rebuilt and no row is touched. See the plan's Task 5 for the attribution
-- semantics change on unlinked gateways.
DROP TRIGGER IF EXISTS trg_sync_zones_defaults_ai;
CREATE TRIGGER trg_sync_zones_defaults_ai …;
-- … 11 more DROP/CREATE pairs …
```

`destructive` is correct: it drops schema objects, which earns it the runner's `writersStopped` gate and a pre-migration byte-image backup. Postflight `integrity_check` and `foreign_key_check` run for every risk class.

Generate the 12 bodies from the post-edit `seed-blank.sql` with a script so the three copies cannot diverge by hand-typing.

- [ ] **Step 4: Edit the seed, the boot node, and the link handler**

Apply the same 12 bodies to `database/seed-blank.sql` and, script-edited, to `sync-init-fn` in the bcm2712 profile; copy to the mirror. The 12 trigger strings stop concatenating `gatewaySql`; the two backfill `UPDATE`s keep it. Add the link-finalize backfill described above.

- [ ] **Step 5: Retire the 22-site assertion**

`lib/osi-migrate/__tests__/fingerprints-gateway-eui.test.js` asserts `totalSites === 22` and `differingStatements > 0` over the real boot triggers. Both go to zero once `gatewaySql` leaves the trigger bodies, so the file fails in CI unless it is rewritten in this same commit. Replace that test with its inverse — no boot trigger statement varies with `gatewaySql` any more — and keep the file's unit tests of `normalizeSqlV3` untouched, since the normaliser still matters for gateways mid-upgrade.

- [ ] **Step 6: Update the trigger-body parity rule**

`scripts/verify-trigger-body-parity.js` is already a hard gate (exit 1 on failure, wired at two steps in `migrations.yml`). Its rule 1 maps `GATEWAY_EUI_LITERALS = [TEST_GATEWAY_SQL, "'0016C001F11715E2'"]` to a placeholder. Update that list for the new text and keep the gate green; if a fixture disagrees, that is a finding, not a fixture update.

- [ ] **Step 7: Regenerate the bundled DBs and the manifest**

```bash
MIGRATION=database/migrations/ordered/NNNN__gateway_eui_fallback.sql
cd "$(git rev-parse --show-toplevel)" && for db in \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  database/farming.db \
  web/react-gui/farming.db
do sqlite3 -bail "$db" < "$MIGRATION" && echo "OK $db"; done \
  && cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  && echo "OK mirror copy"
```

Regenerate `CHECKSUMS.json` with the repo's own manifest writer; never hand-edit a checksum.

- [ ] **Step 8: Run the full schema gate**

```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-profile-parity.js
node scripts/verify-boot-ddl-interpolation.js
node scripts/verify-trigger-body-parity.js
node --test scripts/verify-trigger-body-parity.test.js
node scripts/verify-devices-rebuild-fence.js
node --test scripts/rehearse-devices-rebuild.test.js
node --test lib/osi-migrate/__tests__/*.test.js
node --test scripts/test-gateway-eui-attribution.js
node scripts/verify-sync-flow.js
```

Expected: all exit 0; `verify-seed-replay: OK`, `DB schema consistency verification passed`, `verify-trigger-body-parity: OK`, `All parity checks passed.`

- [ ] **Step 9: Non-Silvan rehearsal**

Run the boot-rewrite rehearsal at Uganda's EUI (`0016C001F151B1D6`), at AgroLink's (`0016C001F116EBF2`), and with `DEVICE_EUI` unset. This is the check that would have caught `0046`/`0047`; a rehearsal only at Silvan's EUI proves nothing.

- [ ] **Step 10: Commit**

```bash
git add database/migrations/ordered/NNNN__gateway_eui_fallback.sql \
  database/migrations/ordered/CHECKSUMS.json database/seed-blank.sql \
  conf/*/files/usr/share/flows.json conf/*/files/usr/share/db/farming.db \
  database/farming.db web/react-gui/farming.db \
  scripts/verify-trigger-body-parity.js scripts/test-gateway-eui-attribution.js \
  lib/osi-migrate/__tests__/fingerprints-gateway-eui.test.js \
  lib/osi-migrate/__tests__/fingerprints-boot-rewrite-rehearsal.test.js \
  .github/workflows/migrations.yml
git commit -m "fix(schema): replace the Silvan EUI literal with a sync_link_state fallback in seed, migration and boot node (#157)"
```

---

### Task 6: Retire the `writable_schema` healer (#93)

**Files:**
- Modify: both `flows.json` profiles (`sync-init-fn`)
- Modify: `scripts/verify-devices-rebuild-fence.test.js`, `scripts/verify-flows-size-ratchet-allowances.json`

- [ ] **Step 1: Probe the fleet, read-only, with consent**

Ask the user for explicit go before touching kaba100 or Uganda in the turn the probe runs. Never during a deploy window; the 2026-09-13 deploy train must be reported finished on each host before any probe. On Silvan, kaba100, Uganda and agrolink-test-01:

```sh
sqlite3 /data/db/farming.db "SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%devices_old%';"
```

Expected: empty everywhere. Record all four outputs verbatim in the PR body. Uganda was rebuilt during the incident, so re-run it against the current DB rather than trusting a pre-incident reading. Any row means the block is load-bearing there: stop, and repair that gateway offline under `osi-live-ops-runbook` first.

- [ ] **Step 2: Write the failing test**

```js
test('the writable_schema catalog healer is gone from both flows', () => {
  for (const rel of FLOWS) {
    assert.doesNotMatch(bootFunc(rel), /writable_schema/,
      `${rel}: unfenced sqlite_master surgery must not run on every boot (#93)`);
  }
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --test scripts/verify-devices-rebuild-fence.test.js`
Expected: FAIL on both flows.

- [ ] **Step 4: Delete the block**

Script-edit the bcm2712 profile: remove the whole `try { … bad2 … writable_schema … } catch (fkErr) { node.warn('FK self-heal failed: …') }` block and its `q2` helper if nothing else uses it, then copy to the mirror. Deleting behavior from the frozen node is a sanctioned change class; adding any would not be.

- [ ] **Step 5: Run the gate**

```bash
node --test scripts/verify-devices-rebuild-fence.test.js
node scripts/verify-devices-rebuild-fence.js
node scripts/verify-no-stray-ddl.js
node --test scripts/verify-no-stray-ddl.test.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-profile-parity.js
node --test scripts/rehearse-devices-rebuild.test.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-flows-size-ratchet.js
node scripts/verify-sync-flow.js
```

`verify-no-stray-ddl.js` tracks a `writableSchema` marker, so its ratchet counts move in this commit; that is the intended direction and the run must stay green. `sync-init-fn` shrinks, so reduce its `node_allowances` delta and the `total_allowance` by the measured amount rather than leaving a stale allowance in place.

- [ ] **Step 6: Commit**

```bash
git add conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json \
  scripts/verify-devices-rebuild-fence.test.js scripts/verify-flows-size-ratchet-allowances.json
git commit -m "chore(boot): delete the unfenced writable_schema devices_old healer (#93)"
```

---

## Wave 4 — documentation and close-out

### Task 7: Reconcile the Uganda catch-up runbook (#87)

**Files:**
- Modify: `docs/operations/uganda-catchup-runbook.md`

- [ ] **Step 1: Read the current document**

Run: `git show origin/main:docs/operations/uganda-catchup-runbook.md`
It still describes execution as gated on a stable-connectivity window and on Uganda being pre-history-sync. Both are stale.

- [ ] **Step 2: Rewrite the status section against the verified state**

State, with the 2026-09-12 read-only evidence: `schema_migrations` head 56; `devices` carrying all 45 columns including the five `sdi12_*`; `device_data` at 70,578 rows with ingest live (newest `2026-09-12T19:19:49Z`); five incident-window backups under `/data/db/`. Replace the "blocked on connectivity" framing with what the catch-up produced and what the incident cost (70,176 rows deleted by an unfenced cascade, since restored). Link the incident log and the issues that fix the generating defects.

Keep the operational procedure — it is still the recipe for the next behind-schema gateway — but move the Uganda-specific status into a dated outcome section so a future reader does not mistake history for a pending task.

- [ ] **Step 3: Run the slop check**

Run: `node .claude/skills/anti-slop-writing/slop-check.js docs/operations/uganda-catchup-runbook.md`
Expected: `slop-check: PASS (no tier-1 findings)`, exit 0. Read every tier-2 warning; do not bulk-suppress.

- [ ] **Step 4: Commit**

```bash
git add docs/operations/uganda-catchup-runbook.md
git commit -m "docs(ops): reconcile the Uganda catch-up runbook with the recovered gateway state (#87)"
```

---

## Rollout

No task above writes to a live gateway. Rollout happens once Waves 1-3 are merged, by an operator following `osi-live-ops-runbook`, with the user's explicit go for each gateway.

**Stage 0 — rehearsal on fresh byte copies.** Take a current `sqlite3 /data/db/farming.db ".backup /tmp/rehearsal.db"` from kaba100 and from Uganda and `scp` the copy off; never `cp` a live file, and never rehearse on `farming.db.bak-2026-09-11T22-4*`, which are mid-incident snapshots from before the repair rather than the recovered head-56 schema. Uganda is production: ask in the turn.

Off-device, against each copy: run `scripts/migrate-cli.js` to head with `--backup-dir /tmp/rehearsal-backups`, then replay the shipped `sync-init-fn` text at that gateway's real `DEVICE_EUI` through the rehearsal harness, then `node scripts/verify-head-cli.js`. Record `PRAGMA integrity_check`, `PRAGMA foreign_key_check`, the `devices` column list, `SELECT COUNT(*) FROM device_data`, the post-boot drift-gate result, and the `gateway_device_eui` attribution of a row inserted during the replay. A rehearsal that needs `restamp-fingerprints.js` is a failed rehearsal.

**Disk preflight before any live deploy.** Task 5's migration is `destructive`, so `backupDb` writes a full byte copy under `/data/backups/migrate` on top of the pre-deploy backup. Check free space against twice the current `farming.db` size plus headroom (`df -h /data`, `ls -l /data/db/farming.db`) before starting, and prune old `/data/backups/migrate` copies if short. Uganda has repeatedly run close on disk.

**Stage 1 — Silvan.** Demo gateway, and the only one whose EUI is the retired literal, so a mistake in Task 5 would look like success there and nowhere else. After deploy confirm: `logread` shows Node-RED output; `schema_migrations` is at the new head; no trigger body contains `0016C001F11715E2`; `device_data` count unchanged across the deploy; a second `/etc/init.d/node-red restart` followed by `verify-head-cli.js` passes with no restamp. Then run the attribution check end to end — unlink, add a device, relink, and confirm the device's `gateway_device_eui` and its outbox rows carry the link EUI.

**Stage 2 — kaba100.** Same checks. kaba100 produced the #212 drift-after-restart case, so its second-restart check is the real test of Wave 2's conclusion.

**Stage 3 — Uganda.** Production, and the incident gateway. Take and verify a fresh backup (`PRAGMA integrity_check` returns `ok`) before deploy starts. Same checks plus: `device_data` count before and after (monotonic increase from live ingest, never a decrease); the five `sdi12_*` columns still present; one real uplink landing a row after the deploy.

Leave at least a day between stages, and do not start one while the previous gateway has an open question.

## Risks and stop conditions

| Risk | Stop condition |
|---|---|
| Task 5 changes attribution on a gateway that is unlinked when a device or zone is created | Before Stage 1, run `SELECT COUNT(*) FROM devices WHERE gateway_device_eui IS NULL OR trim(gateway_device_eui)=''` and the `irrigation_zones` equivalent on all four gateways, plus `SELECT linked, gateway_device_eui FROM sync_link_state WHERE peer_node='cloud'`. Any unlinked gateway, or any non-zero NULL count, stops the rollout until the link-finalize backfill is confirmed to cover it. |
| Task 4's characterisation finds a residual diff and the tolerance is written too wide | Any tolerance clause that matches more than one named diff, or that does not have a paired test proving a neighbouring diff still refuses. Revert to the refusal. |
| Task 1's unknown-column abort fires in the field on a routine deploy | An `unknown live column` error in `logread` on any gateway. This means a payload/schema inversion (#222 class) — stop the deploy, flip the payload forward, and do not work around the abort. |
| Ratchet allowances drift from reality | Any allowance entry whose `reason` does not carry a measured before/after byte count from `verify-flows-size-ratchet`'s own `nodeSizes`. |
| The migration needs rolling back mid-fleet | The runner's pre-migration byte-image backup under `/data/backups/migrate` is the recovery path, paired with a flows rollback. The migration file must never be edited after merge. |
| Uganda's ingest stalls during the Stage 3 window | No new `device_data` row within 15 minutes of the post-deploy restart. Roll the payload back, restore from the pre-deploy backup, re-open the incident. |
| Task 3's log capture floods the BusyBox syslog ring | After Stage 1, compare `logread | wc -l` growth over an hour against the pre-change rate. If Node-RED dominates the ring, add rate limiting or a rotated file before Stage 3 rather than reverting the capture. |

## Issue close-out mapping

| PR | Closes | Evidence the close comment needs |
|---|---|---|
| PR-A (Task 1) | #173, #219, #220 | Full output of `verify-devices-rebuild-fence.js` and its test file, `rehearse-devices-rebuild.test.js` (nine cases), `verify-runtime-schema-parity.js`, `verify-profile-parity.js`, `verify-trigger-body-parity.js`, `verify-sync-flow.js`. For #173: the seed-versus-boot column diff before and after. For #219: the superset gate failing when a column is removed from `DEVICES_COLUMNS`, plus the `extra-live-column` rehearsal showing the abort. For #220: the `missing-source-columns` rehearsal, pre-fix abort and post-fix success. Plus the measured ratchet allowance. |
| PR-B (Task 2) | #224 | The scanner's clean run over all four corpora, naming `0004`/`0010`/`0027` as fenced by risk class and `scripts/ops/uganda-schema-rebuild-20260911.sql` as fenced by its explicit pragma, plus the drop-then-rename fixture test proving the incident's actual shape is detected. |
| PR-C (Task 3) | #223 | `verify-init-log-capture.js` output, `deploy-fetch-list.test.js` output, and the Stage 1 `grep` + `logread` transcript. |
| PR-D (Task 4) | #221, cross-links #212 | The three tests' output and the residual-diff list from Step 1. If the list is empty, the close comment says #221's premise (a tolerable `table|devices` diff) does not match `compareSchemas`'s diff kinds, names #173 and #219 as the real components of Uganda's refusal, and cites the tests as the standing guard. |
| PR-E (Task 5) | #157, and moves #153 to its remaining sub-items | Full schema gate output, the three-EUI rehearsal, `grep -c 0016C001F11715E2 database/seed-blank.sql` returning 0, the attribution tests, the rewritten `fingerprints-gateway-eui.test.js`, and the Stage 0 rehearsal on the fresh Uganda copy. |
| PR-F (Task 6) | #93 | The four read-only fleet probes returning empty, with the consent turn referenced, and the boot-node gate output after the deletion including `verify-no-stray-ddl.js`. |
| PR-G (Task 7) | #87, #222 | For #87: the runbook diff plus the 2026-09-12 read-only Uganda evidence. For #222: PR #225 is the fix — cite it and the deploy log line showing the payload flipping before the post-migration restart. No code change in PR-G. |

#88 stays open. Comment that Task 1's `DEVICES_COLUMNS` is the surface Option B deletes, and that Task 1's gates now pin the invariants Option B must preserve.

## Self-review notes

- Spec coverage: every issue in scope maps to a task and a PR row. #153 is diagnosis only and is not separately closed.
- The plan adds no new `reference(head)` builds beyond the one the grace path already performs, so the #175/#158 baseline-ladder cost is unchanged.
- Type consistency: `parseSeedDevicesColumns`, `parseBootDevicesColumns`, `migrationAddedDevicesColumns` and `run` are defined in Task 1 Step 0 and used under those names in Tasks 1 and 6; `DEVICES_COLUMNS` and `buildDevicesCopySql` are defined in Task 1 Step 3 and referenced in Tasks 4 and 5; `scanSqlText`/`run` in Task 2; `scanInit` in Task 3; `stampThenBoot` in Task 4 and reused in Task 5.
- Every new test file has an explicit CI wiring step: Task 1 Step 8, Task 2 Step 4, Task 3 Step 5, Task 4 Step 4 (glob), Task 5 Step 10.
