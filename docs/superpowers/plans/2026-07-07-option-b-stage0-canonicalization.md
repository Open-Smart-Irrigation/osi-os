# Option B Stage 0 — Edge Schema Canonicalization (issue #88) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Execution notes (learned from prior plans):** (1) work inside a feature worktree/branch (`feat/88-stage0-canonicalization`), not the root `main` checkout; (2) after changing the bcm2712 bundled DB, mirror it byte-for-byte to bcm2709 with `cp` — `verify-profile-parity.js` hashes the mirror; (3) run every command from the worktree root; (4) the migration-immutability gate (`verify-migrations.js`) compares against `origin/main` — hard-learned in PR #112: **a new migration without its `CHECKSUMS.json` entry fails CI**; the manifest update is an explicit step here, not an afterthought.
> **Spec:** [`docs/superpowers/specs/2026-07-07-option-b-stage0-canonicalization-design.md`](../specs/2026-07-07-option-b-stage0-canonicalization-design.md) (review rounds 1–2 accepted). Section references (§A–§G) below point there.

**Goal:** Build the Stage 0 canonicalization toolchain: shared SQL normalization (`lib/osi-migrate/sql-normalize.js`), the semantic schema comparator with the five-class diff taxonomy, ordered migration `0005__analysis_views.sql` (folding the live-only `analysis_views` table into the reference), the pre-baseline `sync_outbox` v2 repair, the version-aware `baseline-existing-db.js` stamping tool, CI wiring, the skill-file sanctioned-tools amendment — then prove the whole §F pipeline in a local dry-run against a copy of the kaba100 dev fixture.

**Architecture:** `reference(N)` = `bootstrapFresh` replay of ordered migrations `0001..N` into a scratch DB (§A) — built on demand by `baseline-existing-db.js` from a filtered temp copy of the migrations dir; zero changes to `lib/osi-migrate`. The comparator (§C) snapshots application schema (tables/columns incl. normalized defaults, indexes as ordered tuples, triggers/views by normalized body, CHECKs via a balanced-paren extractor) and classifies every diff as `missing` / `changed` / `extra_forward` / `extra_allowlisted` / `extra_unknown`; the gate (§B) passes at N iff nothing fails, tolerating exactly the extras that match `reference(head)` objects introduced after N (forward drift) plus the named chameleon allowlist. On gate pass the baseline tool stamps ledger rows `1..N` with checksums **from `CHECKSUMS.json`** and calls `syncFingerprints`; on failure it stamps nothing. The expected live-fleet outcome today: N=3 passes with `analysis_views` tolerated as `extra_forward`; `applyPending` later runs `0004` (destructive rebuild) and `0005` (no-op over the early-arrived table).

**Tech Stack:** Node.js (`node:test`, no new dependencies), `sqlite3` CLI via the existing `cliRunner` (`lib/osi-migrate/runner-iface.js`), `lib/osi-migrate` (runner/ledger/loader/fingerprints — consumed, not modified), GitHub Actions (`.github/workflows/migrations.yml`).

## Global Constraints

- **Never modify** `database/migrations/ordered/0001__baseline.sql` … `0004__widen_schedule_trigger_metric_check.sql`, nor their `CHECKSUMS.json` entries — merged migrations are checksummed; an edit wedges every future ledgered DB as `repair_required`. Only *add* the `0005` file + its manifest entry.
- **Never touch** `sync-init-fn` (boot node, FROZEN), `deploy.sh`, or `scripts/repair-pi-schema.js`. No flows.json change of any kind in this plan.
- **No SSH, no live gateways, no production hosts.** The only real-data artifact used is the local dev fixture `/home/phil/backups/kaba100-chameleon-zero-export-20260702/farming-kaba100-20260702T0754Z.db` — **read-only**: Task 7 works on a copy in a scratch dir and verifies the fixture's hash is unchanged afterward. Never commit it or any copy of it.
- All 7 bundled `farming.db` copies stay schema-identical to the seed, and `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db` remains a **byte-for-byte copy** of the bcm2712 one (`verify-profile-parity.js`).
- `0005` is `-- risk: additive`, idempotent (`IF NOT EXISTS`), and its DDL must be semantically identical to `deploy.sh`'s `ensure_analysis_views_schema` shape (§A — live shape wins; the DDL below was extracted from `deploy.sh` lines ~275–285, verbatim modulo indentation).
- CI (`.github/workflows/migrations.yml`) must stay green at every commit; local gates before each commit are listed per task.
- Work on `feat/88-stage0-canonicalization`, commit per task, open a PR at the end, **do not merge it**.

## Non-goals (do not do these)

- No Stage 1 (`deploy.sh` runner invocation), no Stage 2 (boot-DDL removal), no Uganda work (#87), no `writable_schema` retirement (#93), no #107 `schema_sig` fix (Task 1's module is the seam it will import — nothing more).
- No fresh gateway DB copy exfiltration — the §F **rehearsal-of-record** on a fresh post-0.1-deploy kaba100 copy is an OPERATOR runbook step, listed under Follow-ups, not a plan task.
- Do not "fix" trigger `changed` diffs the comparator reports against the stale fixture by loosening the comparator (spec §F expected-fixture-behavior note): the fixture predates the #105 flows deploy; Task 7 simulates the current deploy on the copy instead.

## File Structure (all changes)

- Create: `lib/osi-migrate/sql-normalize.js` + `lib/osi-migrate/__tests__/sql-normalize.test.js` (Task 1)
- Create: `scripts/semantic-schema-compare.js` + `scripts/semantic-schema-compare.test.js` (Task 2)
- Create: `database/migrations/ordered/0005__analysis_views.sql`; modify `database/migrations/ordered/CHECKSUMS.json`, `database/seed-blank.sql`, `scripts/verify-db-schema-consistency.js`; modify (binary) all 7 bundled `farming.db` (Task 3)
- Create: `scripts/repair-sync-outbox-v2.js` + `scripts/repair-sync-outbox-v2.test.js` (Task 4)
- Create: `scripts/baseline-existing-db.js` + `scripts/baseline-existing-db.test.js` (Task 5)
- Modify: `.claude/skills/osi-schema-change-control/SKILL.md`, `.github/workflows/migrations.yml` (Task 6)
- No file changes in Task 7 (dry-run + PR).

---

### Task 1: `lib/osi-migrate/sql-normalize.js` — shared normalization (spec §C)

**Files:**
- Create: `lib/osi-migrate/__tests__/sql-normalize.test.js`
- Create: `lib/osi-migrate/sql-normalize.js`

**Interfaces:**
- Produces: `normalizeSqlClause(text) → string` — consumed by Task 2's comparator and (later, out of scope) issue #107's `schema_sig` fix.
- Rules: whitespace runs collapse; spaces around punctuation/operators (`(),;=<>+-*/|.`) are dropped; keywords/identifiers lowercase; identifier quote styles (`"x"`, `` `x` ``, `[x]`, bare) fold to bare; **single-quoted string literals are copied verbatim** (case + internal spacing preserved — `'A'` ≠ `'a'`, matching `fingerprints.js`'s case-preservation rule).

- [ ] **Step 1.1: Write the failing test** — create `lib/osi-migrate/__tests__/sql-normalize.test.js` with exactly:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSqlClause } = require('../sql-normalize');

test('lowercases keywords/identifiers, collapses whitespace, strips operator spacing', () => {
  assert.equal(
    normalizeSqlClause('CHECK  (Is_Default   IN\n\t(0, 1))'),
    'check(is_default in(0,1))'
  );
});

test('folds all identifier quote styles to bare', () => {
  const want = 'check(is_default in(0,1))';
  assert.equal(normalizeSqlClause('CHECK ("Is_Default" IN (0,1))'), want);
  assert.equal(normalizeSqlClause('CHECK (`Is_Default` IN (0,1))'), want);
  assert.equal(normalizeSqlClause('CHECK ([Is_Default] IN (0,1))'), want);
  assert.equal(normalizeSqlClause('CHECK (is_default IN (0,1))'), want);
});

test('preserves string literal case and internal spacing', () => {
  assert.equal(normalizeSqlClause("DEFAULT 'X  y'"), "default 'X  y'");
  assert.equal(normalizeSqlClause("m IN ('SWT_AVG', 'DENDRO')"), "m in('SWT_AVG','DENDRO')");
});

test('doubled-quote escapes survive in literals and identifiers', () => {
  assert.equal(normalizeSqlClause("DEFAULT 'it''s'"), "default 'it''s'");
  assert.equal(normalizeSqlClause('CHECK ("we""ird" > 0)'), 'check(we"ird>0)');
});

test('operator spacing is insignificant', () => {
  assert.equal(normalizeSqlClause('CHECK (v > 0)'), normalizeSqlClause('check(v>0)'));
});

test('null/undefined normalize to empty string', () => {
  assert.equal(normalizeSqlClause(null), '');
  assert.equal(normalizeSqlClause(undefined), '');
});
```

- [ ] **Step 1.2: Run it (red)**

Run: `node --test lib/osi-migrate/__tests__/sql-normalize.test.js`
Expected: FAIL — `Cannot find module '../sql-normalize'`.

- [ ] **Step 1.3: Implement** — create `lib/osi-migrate/sql-normalize.js` with exactly:

```js
'use strict';
// Shared SQL-clause normalization for semantic schema comparison.
// Option B Stage 0 (issue #88) — spec §C:
//   docs/superpowers/specs/2026-07-07-option-b-stage0-canonicalization-design.md
// This module is ALSO the seam for issue #107's schema_sig CHECK-blindness fix:
// import normalizeSqlClause there; do not re-derive normalization rules.
//
// Rules (each is a spec §C decision, not an accident):
//  1. Whitespace runs outside string literals collapse to one space; spaces
//     adjacent to punctuation/operators are dropped entirely.
//  2. Identifier quote styles fold to bare: "id" == `id` == [id] == id.
//  3. Everything lowercases EXCEPT single-quoted string literals ('A' != 'a'),
//     matching lib/osi-migrate/fingerprints.js normalizeSql case preservation.
//  4. IN (...) list reordering is NOT attempted (sqlite_master text is stable
//     unless hand-edited, which change control already forbids).

const PUNCT = new Set(['(', ')', ',', ';', '=', '<', '>', '+', '-', '*', '/', '|', '.']);

function normalizeSqlClause(text) {
  const src = String(text === null || text === undefined ? '' : text);
  let out = '';
  let pendingSpace = false;
  const emit = (piece, lower) => {
    if (piece === '') return;
    if (pendingSpace) {
      const last = out[out.length - 1];
      if (out !== '' && !PUNCT.has(last) && !PUNCT.has(piece[0])) out += ' ';
      pendingSpace = false;
    }
    out += lower ? piece.toLowerCase() : piece;
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'") {
      // String literal: copy verbatim (incl. '' escapes); case/spacing preserved.
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "'") {
          if (src[j + 1] === "'") { j += 2; continue; }
          j += 1;
          break;
        }
        j += 1;
      }
      emit(src.slice(i, j), false);
      i = j;
      continue;
    }
    if (ch === '"' || ch === '`') {
      // Quoted identifier: unquote (handling doubled-quote escapes), lowercase.
      let j = i + 1;
      let ident = '';
      while (j < src.length) {
        if (src[j] === ch) {
          if (src[j + 1] === ch) { ident += ch; j += 2; continue; }
          j += 1;
          break;
        }
        ident += src[j];
        j += 1;
      }
      emit(ident, true);
      i = j;
      continue;
    }
    if (ch === '[') {
      const end = src.indexOf(']', i + 1);
      if (end !== -1) {
        emit(src.slice(i + 1, end), true);
        i = end + 1;
        continue;
      }
    }
    if (/\s/.test(ch)) { pendingSpace = true; i += 1; continue; }
    emit(ch, true);
    i += 1;
  }
  return out;
}

module.exports = { normalizeSqlClause };
```

- [ ] **Step 1.4: Run it (green)**

Run: `node --test lib/osi-migrate/__tests__/sql-normalize.test.js`
Expected: `# pass 6`, exit 0. (This file is automatically covered by CI's existing `node --test lib/osi-migrate/__tests__/*.test.js` glob — no workflow change needed for it.)

- [ ] **Step 1.5: Commit**

```bash
git add lib/osi-migrate/sql-normalize.js lib/osi-migrate/__tests__/sql-normalize.test.js
git commit -m "feat(osi-migrate): shared SQL-clause normalization for semantic schema comparison (#88 Stage 0)"
```

---

### Task 2: `scripts/semantic-schema-compare.js` — comparator + taxonomy (spec §C)

**Files:**
- Create: `scripts/semantic-schema-compare.test.js`
- Create: `scripts/semantic-schema-compare.js`

**Interfaces:**
- Produces: `snapshotSchema(runner) → snap`, `compareSchemas(liveSnap, refSnap, headSnap?, allowlist?) → { ok, diffs, failingCount }`, `FAILING_CLASSES`, `DEFAULT_ALLOWLIST` — consumed by Task 5. CLI: `node scripts/semantic-schema-compare.js <live.db> <reference.db> [--head-db <head.db>]` compares two explicit DB files (the per-N report walk lives in Task 5's `--report`).
- Diff classes: `missing`/`changed` (fail), `extra_forward`/`extra_allowlisted` (tolerated), `extra_unknown` (fail).

- [ ] **Step 2.1: Write the failing test suite** — create `scripts/semantic-schema-compare.test.js` with exactly:

```js
'use strict';
// Full-taxonomy synthetic-drift suite (spec §G): every diff class is exercised,
// plus the must-NOT-fail cases (formatting-only, sqlite_sequence).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { snapshotSchema, compareSchemas } = require('./semantic-schema-compare');

let seq = 0;
async function snapOf(sql) {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sscmp-')), `t${seq++}.db`);
  const runner = cliRunner(db);
  await runner.exec(sql);
  return snapshotSchema(runner);
}

const BASE = `
CREATE TABLE t1 (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'x',
  v REAL CHECK (v > 0)
);
CREATE INDEX idx_t1 ON t1(name, v);
CREATE TRIGGER trg_t1 AFTER INSERT ON t1 BEGIN UPDATE t1 SET name = 'y' WHERE id = NEW.id; END;
`;

test('identical schemas: ok, zero diffs', async () => {
  const res = compareSchemas(await snapOf(BASE), await snapOf(BASE), await snapOf(BASE));
  assert.equal(res.ok, true);
  assert.deepEqual(res.diffs, []);
});

test('whitespace/case/quote-only differences do NOT fail', async () => {
  const live = await snapOf(`
CREATE TABLE t1 (id INTEGER PRIMARY KEY, "name" text NOT NULL DEFAULT 'x', v REAL check(v   >   0));
CREATE INDEX idx_t1 ON t1("name", v);
CREATE TRIGGER trg_t1 AFTER INSERT ON t1 BEGIN update t1 set "name" = 'y' where id = NEW.id; END;
`);
  const ref = await snapOf(BASE);
  const res = compareSchemas(live, ref, ref);
  assert.equal(res.ok, true, JSON.stringify(res.diffs));
});

test('extra unknown column FAILS', async () => {
  const live = await snapOf(BASE + 'ALTER TABLE t1 ADD COLUMN rogue TEXT;');
  const ref = await snapOf(BASE);
  const res = compareSchemas(live, ref, ref);
  assert.equal(res.ok, false);
  assert.deepEqual(res.diffs.map((d) => [d.class, d.kind, d.name]), [['extra_unknown', 'column', 't1.rogue']]);
});

test('missing trigger FAILS', async () => {
  const live = await snapOf(BASE + 'DROP TRIGGER trg_t1;');
  const ref = await snapOf(BASE);
  const res = compareSchemas(live, ref, ref);
  assert.equal(res.ok, false);
  assert.deepEqual(res.diffs.map((d) => [d.class, d.kind, d.name]), [['missing', 'trigger', 'trg_t1']]);
});

test('changed column default FAILS (MAJOR-3: defaults are semantic)', async () => {
  const live = await snapOf(BASE.replace("DEFAULT 'x'", "DEFAULT 'z'"));
  const ref = await snapOf(BASE);
  const res = compareSchemas(live, ref, ref);
  assert.equal(res.ok, false);
  assert.deepEqual(res.diffs.map((d) => [d.class, d.kind, d.name]), [['changed', 'column', 't1.name']]);
});

const FORWARD = 'CREATE TABLE t2 (k TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0));';

test('live extra identical to a reference(head) forward object is tolerated', async () => {
  const live = await snapOf(BASE + FORWARD);
  const ref = await snapOf(BASE);
  const head = await snapOf(BASE + FORWARD);
  const res = compareSchemas(live, ref, head);
  assert.equal(res.ok, true, JSON.stringify(res.diffs));
  assert.deepEqual(res.diffs.map((d) => [d.class, d.kind, d.name]), [['extra_forward', 'table', 't2']]);
});

test('live extra NOT identical to the head object is extra_unknown', async () => {
  const live = await snapOf(BASE + 'CREATE TABLE t2 (k TEXT PRIMARY KEY, n INTEGER);');
  const ref = await snapOf(BASE);
  const head = await snapOf(BASE + FORWARD);
  const res = compareSchemas(live, ref, head);
  assert.equal(res.ok, false);
  assert.equal(res.diffs[0].class, 'extra_unknown');
});

const CHAM = 'CREATE TABLE chameleon_readings (id INTEGER PRIMARY KEY, deveui TEXT NOT NULL);';

test('chameleon swt_1/2/3 allowlist entries are tolerated by name (spec §D(b))', async () => {
  const live = await snapOf(BASE + CHAM + `
ALTER TABLE chameleon_readings ADD COLUMN swt_1 REAL;
ALTER TABLE chameleon_readings ADD COLUMN swt_2 REAL;
ALTER TABLE chameleon_readings ADD COLUMN swt_3 REAL;`);
  const ref = await snapOf(BASE + CHAM);
  const res = compareSchemas(live, ref, ref);
  assert.equal(res.ok, true, JSON.stringify(res.diffs));
  assert.deepEqual(res.diffs.map((d) => d.class),
    ['extra_allowlisted', 'extra_allowlisted', 'extra_allowlisted']);
});

test('sqlite_sequence presence difference is ignored', async () => {
  const SEQT = 'CREATE TABLE s (id INTEGER PRIMARY KEY AUTOINCREMENT, x TEXT);';
  const live = await snapOf(BASE + SEQT + "INSERT INTO s (x) VALUES ('row');");
  const ref = await snapOf(BASE + SEQT);
  const res = compareSchemas(live, ref, ref);
  assert.equal(res.ok, true, JSON.stringify(res.diffs));
});
```

- [ ] **Step 2.2: Run it (red)**

Run: `node --test scripts/semantic-schema-compare.test.js`
Expected: FAIL — `Cannot find module './semantic-schema-compare'`.

- [ ] **Step 2.3: Implement** — create `scripts/semantic-schema-compare.js` with exactly:

```js
#!/usr/bin/env node
'use strict';
// Semantic schema comparator — Option B Stage 0 (issue #88), spec §C:
//   docs/superpowers/specs/2026-07-07-option-b-stage0-canonicalization-design.md
// Order/whitespace-insensitive SET comparison of application schema between a
// live DB and reference(N); reference(head) classifies live extras as forward
// drift (content from migrations > N delivered early by the ensure_* path).
//
// Diff classes:
//   missing            reference has it, live doesn't                  FAILING
//   changed            both have it, semantic content differs          FAILING
//   extra_forward      live-only, identical object in reference(head)  tolerated
//   extra_allowlisted  live-only, on the static named allowlist        tolerated
//   extra_unknown      live-only, neither rule applies                 FAILING
//
// compareSchemas never throws on a mismatch — mismatches are data ({ok, diffs}).
const fs = require('node:fs');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { normalizeSqlClause } = require('../lib/osi-migrate/sql-normalize');

// Spec §D(b): verified-dead live-only columns (added by deploy.sh
// ensure_chameleon_schema, never read or written by any flow, excluded from
// verify-db-schema-consistency's contract). Named entries only — NOT a general
// "ignore extra columns" rule, which would defeat the gate.
const DEFAULT_ALLOWLIST = { chameleon_readings: ['swt_1', 'swt_2', 'swt_3'] };

// Runner bookkeeping (its presence is what baselining decides, not compares)
// plus SQLite's lazily-created AUTOINCREMENT table. sqlite_* names are already
// excluded by the master query; the set is belt-and-braces.
const IGNORED_TABLES = new Set(['schema_migrations', 'schema_object_fingerprints', 'sqlite_sequence']);

const FAILING_CLASSES = new Set(['missing', 'changed', 'extra_unknown']);

function q(name) { return `"${String(name).replace(/"/g, '""')}"`; }

// Balanced-paren CHECK extractor over sqlite_master CREATE TABLE text — the
// axis PRAGMA cannot see (issue #107's schema_sig finding). Limitation: an
// unbalanced paren inside a string literal within a CHECK body would confuse
// depth counting; no such CHECK exists in this schema.
function extractChecks(createSql) {
  const checks = [];
  const src = String(createSql || '');
  const re = /\bCHECK\s*\(/gi;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < src.length && depth > 0) {
      if (src[j] === '(') depth += 1;
      else if (src[j] === ')') depth -= 1;
      j += 1;
    }
    checks.push(normalizeSqlClause(`CHECK (${src.slice(m.index + m[0].length, j - 1)})`));
  }
  return checks.sort();
}

async function snapshotSchema(runner) {
  const master = await runner.all(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name");
  const snap = { tables: {}, indexes: {}, triggers: {}, views: {} };
  for (const row of master) {
    if (IGNORED_TABLES.has(row.name) || IGNORED_TABLES.has(row.tbl_name)) continue;
    if (row.type === 'table') {
      const cols = await runner.all(`PRAGMA table_xinfo(${q(row.name)})`);
      const columns = {};
      for (const c of cols) {
        if (c.hidden) continue;
        columns[c.name.toLowerCase()] = [
          c.name.toLowerCase(),
          normalizeSqlClause(c.type || ''),
          c.notnull ? 1 : 0,
          c.dflt_value === null || c.dflt_value === undefined ? '' : normalizeSqlClause(String(c.dflt_value)),
          c.pk ? 1 : 0,
        ].join('|');
      }
      const sorted = {};
      for (const k of Object.keys(columns).sort()) sorted[k] = columns[k];
      snap.tables[row.name] = { columns: sorted, checks: extractChecks(row.sql) };
    } else if (row.type === 'index') {
      if (row.sql === null) continue; // UNIQUE/PK auto-indexes are implied by table DDL
      const xinfo = await runner.all(`PRAGMA index_xinfo(${q(row.name)})`);
      const list = await runner.all(`PRAGMA index_list(${q(row.tbl_name)})`);
      const meta = list.find((x) => x.name === row.name) || {};
      const cols = xinfo.filter((x) => x.key === 1)
        .sort((a, b) => a.seqno - b.seqno)
        .map((x) => (x.name || `expr${x.seqno}`).toLowerCase());
      // ordered tuple — column order in a compound index is semantic (spec §C)
      snap.indexes[row.name] = `table=${row.tbl_name.toLowerCase()}|unique=${meta.unique ? 1 : 0}|cols=${cols.join(',')}`;
    } else if (row.type === 'trigger') {
      snap.triggers[row.name] = normalizeSqlClause(row.sql);
    } else if (row.type === 'view') {
      snap.views[row.name] = normalizeSqlClause(row.sql);
    }
  }
  return snap;
}

function sameTable(a, b) {
  return JSON.stringify(a.columns) === JSON.stringify(b.columns)
    && JSON.stringify(a.checks) === JSON.stringify(b.checks);
}

function compareSchemas(liveSnap, refSnap, headSnap = null, allowlist = DEFAULT_ALLOWLIST) {
  const diffs = [];
  const add = (cls, kind, name, detail) => diffs.push({ class: cls, kind, name, detail });

  for (const t of Object.keys(refSnap.tables)) {
    if (!liveSnap.tables[t]) add('missing', 'table', t, 'reference table absent from live DB');
  }
  for (const t of Object.keys(liveSnap.tables)) {
    if (refSnap.tables[t]) continue;
    const headT = headSnap && headSnap.tables[t];
    if (headT && sameTable(liveSnap.tables[t], headT)) {
      add('extra_forward', 'table', t, 'identical to the reference(head) table introduced after N');
    } else {
      add('extra_unknown', 'table', t, 'live-only table with no identical reference(head) counterpart');
    }
  }
  for (const t of Object.keys(liveSnap.tables)) {
    const ref = refSnap.tables[t];
    if (!ref) continue;
    const live = liveSnap.tables[t];
    const allowCols = new Set((allowlist[t] || []).map((c) => c.toLowerCase()));
    for (const c of Object.keys(ref.columns)) {
      if (!(c in live.columns)) add('missing', 'column', `${t}.${c}`, `reference: ${ref.columns[c]}`);
      else if (live.columns[c] !== ref.columns[c]) add('changed', 'column', `${t}.${c}`, `live=${live.columns[c]} ref=${ref.columns[c]}`);
    }
    for (const c of Object.keys(live.columns)) {
      if (c in ref.columns) continue;
      if (allowCols.has(c)) {
        add('extra_allowlisted', 'column', `${t}.${c}`, 'named allowlist (spec §D(b): verified-dead live-only column)');
        continue;
      }
      const headT = headSnap && headSnap.tables[t];
      if (headT && headT.columns[c] === live.columns[c]) {
        add('extra_forward', 'column', `${t}.${c}`, 'identical to the reference(head) column introduced after N');
      } else {
        add('extra_unknown', 'column', `${t}.${c}`, `live: ${live.columns[c]}`);
      }
    }
    if (JSON.stringify(live.checks) !== JSON.stringify(ref.checks)) {
      const liveOnly = live.checks.filter((c) => !ref.checks.includes(c));
      const refOnly = ref.checks.filter((c) => !live.checks.includes(c));
      const headChecks = (headSnap && headSnap.tables[t] && headSnap.tables[t].checks) || [];
      if (refOnly.length === 0 && liveOnly.every((c) => headChecks.includes(c))) {
        add('extra_forward', 'check', t, `live-only CHECKs identical in reference(head): ${liveOnly.join(' ;; ')}`);
      } else {
        add('changed', 'check', t, `liveOnly=[${liveOnly.join(' ;; ')}] refOnly=[${refOnly.join(' ;; ')}]`);
      }
    }
  }
  for (const [kind, key] of [['index', 'indexes'], ['trigger', 'triggers'], ['view', 'views']]) {
    const liveM = liveSnap[key];
    const refM = refSnap[key];
    const headM = headSnap ? headSnap[key] : {};
    for (const n of Object.keys(refM)) {
      if (!(n in liveM)) add('missing', kind, n, 'reference object absent from live DB');
      else if (liveM[n] !== refM[n]) add('changed', kind, n, `live and reference ${kind} content differ (normalized)`);
    }
    for (const n of Object.keys(liveM)) {
      if (n in refM) continue;
      if (headM && headM[n] === liveM[n]) add('extra_forward', kind, n, 'identical to the reference(head) object introduced after N');
      else add('extra_unknown', kind, n, `live-only ${kind} with no identical reference(head) counterpart`);
    }
  }
  const failingCount = diffs.filter((d) => FAILING_CLASSES.has(d.class)).length;
  return { ok: failingCount === 0, diffs, failingCount };
}

async function main() {
  const argv = process.argv.slice(2);
  const paths = [];
  let headDb = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--head-db') headDb = argv[++i];
    else paths.push(argv[i]);
  }
  const [liveDb, refDb] = paths;
  if (!liveDb || !refDb) {
    console.error('usage: semantic-schema-compare.js <live.db> <reference.db> [--head-db <head.db>]');
    process.exit(2);
  }
  for (const p of [liveDb, refDb, headDb].filter(Boolean)) {
    if (!fs.existsSync(p)) {
      console.error(`[compare] refusing: database file does not exist: ${p}`);
      process.exit(2);
    }
  }
  const live = await snapshotSchema(cliRunner(liveDb));
  const ref = await snapshotSchema(cliRunner(refDb));
  const head = headDb ? await snapshotSchema(cliRunner(headDb)) : null;
  const res = compareSchemas(live, ref, head);
  for (const d of res.diffs) console.log(`[${d.class}] ${d.kind} ${d.name} — ${d.detail}`);
  console.log(res.ok ? 'semantic-schema-compare: PASS' : `semantic-schema-compare: FAIL (${res.failingCount} failing diffs)`);
  process.exit(res.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((e) => { console.error(`[compare] ERROR: ${e.message}`); process.exit(2); });
}

module.exports = { snapshotSchema, compareSchemas, extractChecks, DEFAULT_ALLOWLIST, IGNORED_TABLES, FAILING_CLASSES };
```

- [ ] **Step 2.4: Run it (green)**

Run: `node --test scripts/semantic-schema-compare.test.js`
Expected: `# pass 9`, exit 0.

- [ ] **Step 2.5: Commit**

```bash
git add scripts/semantic-schema-compare.js scripts/semantic-schema-compare.test.js
git commit -m "feat(schema): semantic schema comparator with forward-drift taxonomy (#88 Stage 0)"
```

---

### Task 3: Migration `0005__analysis_views.sql` + seed + 7 bundled DBs + contract + CHECKSUMS entry

**Files:**
- Create: `database/migrations/ordered/0005__analysis_views.sql`
- Modify: `database/migrations/ordered/CHECKSUMS.json` (add the `0005` entry — **do not touch entries 0001–0004**)
- Modify: `database/seed-blank.sql` (append at end)
- Modify: `scripts/verify-db-schema-consistency.js` (`schemaContract` — insert after the `chameleon_calibration_misses` entry)
- Modify (binary, via sqlite3 CLI): all 7 bundled `farming.db` copies

**Interfaces:**
- Produces: `reference(5)` includes `analysis_views`; Task 5's forward-tolerance depends on this DDL being semantically identical to the live `ensure_analysis_views_schema` shape (§A requirement 2 — the DDL below is that shape, extracted from `deploy.sh`).

- [ ] **Step 3.1: Add the failing contract entry** — in `scripts/verify-db-schema-consistency.js`, directly after the `chameleon_calibration_misses` entry (`'array_id', 'last_tried', 'reason',` + closing `],`), insert:

```js
  analysis_views: [
    'id',
    'user_id',
    'owner_user_uuid',
    'name',
    'view_json',
    'is_default',
    'created_at',
    'updated_at',
  ],
```

- [ ] **Step 3.2: Run it (red)**

Run: `node scripts/verify-db-schema-consistency.js`
Expected: FAIL on the first bundled DB, naming `analysis_views` (missing table / missing column wording per the verifier's existing error branch). This is the red proving the contract now demands the fold-in.

- [ ] **Step 3.3: Create `database/migrations/ordered/0005__analysis_views.sql`** with exactly:

```sql
-- risk: additive
-- 0005: Fold analysis_views into the ordered-migration reference (Option B
-- Stage 0, issue #88; spec 2026-07-07-option-b-stage0-canonicalization-design.md §D(a)).
-- The table has existed on every live gateway via deploy.sh's
-- ensure_analysis_views_schema but was never in seed-blank.sql or a migration.
-- DDL below is semantically identical to the deploy.sh shape (live shape wins)
-- and idempotent (IF NOT EXISTS) so applyPending no-ops over the early-arrived
-- live table when a baselined device replays 0005.

CREATE TABLE IF NOT EXISTS analysis_views (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  owner_user_uuid TEXT,
  name TEXT NOT NULL,
  view_json TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

- [ ] **Step 3.4: Add the CHECKSUMS.json entry (the PR #112 lesson — CI fails without it)**

```bash
node -e '
const crypto = require("crypto"), fs = require("fs");
const dir = "database/migrations/ordered/";
const file = "0005__analysis_views.sql";
const manifest = JSON.parse(fs.readFileSync(dir + "CHECKSUMS.json", "utf8"));
manifest[file] = crypto.createHash("sha256").update(fs.readFileSync(dir + file)).digest("hex");
fs.writeFileSync(dir + "CHECKSUMS.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(file, manifest[file]);
'
```

Expected: prints `0005__analysis_views.sql <64-hex-chars>`. Confirm with `git diff database/migrations/ordered/CHECKSUMS.json` that entries 0001–0004 are untouched.

Run: `node scripts/verify-migrations.js`
Expected: `verify-migrations: OK (5 migrations, checksum manifest OK, base immutability OK)`. (If `origin/main` is absent in the worktree, run `git fetch --no-tags origin main:refs/remotes/origin/main` first.)

- [ ] **Step 3.5: Append the identical DDL to `database/seed-blank.sql`** (statements must be textually identical to the migration's — build by extraction, per the 0002 precedent):

```bash
{ echo ''; \
  echo '-- ---------------------------------------------------------------------------'; \
  echo '-- analysis_views (folded from deploy.sh ensure_analysis_views_schema; migration 0005)'; \
  echo '-- ---------------------------------------------------------------------------'; \
  grep -vE '^\s*--' database/migrations/ordered/0005__analysis_views.sql; } >> database/seed-blank.sql
```

Run: `node scripts/verify-seed-replay.js`
Expected: `verify-seed-replay: OK` (replay 0001–0005 == seed). If it FAILS on `analysis_views`, the seed text diverged from the migration text — diff and fix (the migration file is the source; never hand-retype).

- [ ] **Step 3.6: Apply 0005 to the 7 bundled DBs (additive — no FK fence needed) + mirror copy**

```bash
cd "$(git rev-parse --show-toplevel)" && for db in \
  conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
  database/farming.db \
  web/react-gui/farming.db
do sqlite3 -bail "$db" < database/migrations/ordered/0005__analysis_views.sql && echo "OK $db"; done \
  && cp conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
  && echo "OK mirror copy"
```

Expected: `OK <path>` for all six, then `OK mirror copy`.

- [ ] **Step 3.7: Run the schema verifier set (green)**

```bash
node scripts/verify-db-schema-consistency.js
node scripts/verify-profile-parity.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-seed-replay.js
node scripts/verify-migrations.js
node --test lib/osi-migrate/__tests__/*.test.js
```

Expected: all 7 DB paths `OK` + `DB schema consistency verification passed`; `All parity checks passed.`; `verify-runtime-schema-parity: OK (2 flows: devices CHECK + trigger parity)`; `verify-seed-replay: OK`; `verify-migrations: OK (5 migrations, ...)`; all runner tests pass. (No TS change: `analysis_views` is already consumed live via the History API; nothing new is GUI-visible.)

- [ ] **Step 3.8: Commit**

```bash
git add database/migrations/ordered/0005__analysis_views.sql \
        database/migrations/ordered/CHECKSUMS.json \
        database/seed-blank.sql scripts/verify-db-schema-consistency.js \
        conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
        conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db \
        conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db \
        database/farming.db web/react-gui/farming.db
git commit -m "feat(schema): fold analysis_views into seed + ordered migration 0005 (#88 Stage 0)"
```

---

### Task 4: `scripts/repair-sync-outbox-v2.js` — pre-baseline repair (spec §D(c))

**Files:**
- Create: `scripts/repair-sync-outbox-v2.test.js`
- Create: `scripts/repair-sync-outbox-v2.js`

**Interfaces:**
- Produces: `repairSyncOutboxV2(dbPath) → { added: string[] }`. Column types are `TEXT` ×3, matching `seed-blank.sql` (~lines 536–538) so repaired columns equal `reference(1)` under the §C `(name, type)` comparison. TEMPORARY tool — delete once the fleet is baselined (consumed-or-deleted).

- [ ] **Step 4.1: Write the failing test** — create `scripts/repair-sync-outbox-v2.test.js` with exactly:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { repairSyncOutboxV2 } = require('./repair-sync-outbox-v2');

const V1_OUTBOX = `
CREATE TABLE sync_outbox (
  event_uuid TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_key TEXT NOT NULL,
  op TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  sync_version INTEGER NOT NULL DEFAULT 0,
  occurred_at TEXT NOT NULL,
  delivered_at TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  gateway_device_eui TEXT
);`;

async function makeDb(sql) {
  const db = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sov2-')), 'f.db');
  await cliRunner(db).exec(sql);
  return db;
}

test('repairs a v1-shaped sync_outbox (adds all three TEXT columns)', async () => {
  const db = await makeDb(V1_OUTBOX);
  const { added } = await repairSyncOutboxV2(db);
  assert.deepEqual(added, ['rejected_at', 'rejection_reason', 'last_retryable_failure_at']);
  const cols = await cliRunner(db).all('PRAGMA table_xinfo(sync_outbox)');
  for (const name of added) {
    const col = cols.find((c) => c.name === name);
    assert.ok(col, `${name} missing after repair`);
    assert.equal(col.type.toUpperCase(), 'TEXT');
  }
});

test('re-run is a clean no-op', async () => {
  const db = await makeDb(V1_OUTBOX);
  await repairSyncOutboxV2(db);
  const second = await repairSyncOutboxV2(db);
  assert.deepEqual(second.added, []);
});

test('partial subset present: adds only the missing ones', async () => {
  const db = await makeDb(V1_OUTBOX + '\nALTER TABLE sync_outbox ADD COLUMN rejected_at TEXT;');
  const { added } = await repairSyncOutboxV2(db);
  assert.deepEqual(added, ['rejection_reason', 'last_retryable_failure_at']);
});

test('refuses a missing db path (anti-typo)', async () => {
  await assert.rejects(() => repairSyncOutboxV2('/nonexistent/nope.db'), /does not exist/);
});

test('refuses when sync_outbox is missing entirely (the #87 whole-table gap)', async () => {
  const db = await makeDb('CREATE TABLE other (x TEXT);');
  await assert.rejects(() => repairSyncOutboxV2(db), /whole-table gap/);
});
```

- [ ] **Step 4.2: Run it (red)**

Run: `node --test scripts/repair-sync-outbox-v2.test.js`
Expected: FAIL — `Cannot find module './repair-sync-outbox-v2'`.

- [ ] **Step 4.3: Implement** — create `scripts/repair-sync-outbox-v2.js` with exactly:

```js
#!/usr/bin/env node
'use strict';
// Pre-baseline repair: add the sync_outbox v2 columns (history-sync-v1) that
// are in seed-blank.sql / reference(1) but missing on gateways whose last
// repair predates them — verified missing on kaba100; NO existing healer adds
// them (zero refs in sync-init-fn and repair-pi-schema.js). Spec §D(c):
//   docs/superpowers/specs/2026-07-07-option-b-stage0-canonicalization-design.md
//
// NOT an ordered migration: 0001 already contains these columns, so no
// migration slot can express "add them to a pre-ledger DB".
// TEMPORARY tool — delete once the fleet is baselined (consumed-or-deleted,
// per the ownership ADR invariant).
//
// Types are TEXT x3, verified against database/seed-blank.sql (sync_outbox),
// so the repaired columns match reference(1) exactly under the semantic
// comparator's (name, type) column comparison.
const fs = require('node:fs');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');

const COLUMNS = [
  ['rejected_at', 'TEXT'],
  ['rejection_reason', 'TEXT'],
  ['last_retryable_failure_at', 'TEXT'],
];

async function repairSyncOutboxV2(dbPath) {
  if (!fs.existsSync(dbPath)) {
    // sqlite3 would otherwise CREATE an empty DB at a typoed path and "repair" THAT.
    throw new Error(`refusing: database file does not exist: ${dbPath}`);
  }
  const runner = cliRunner(dbPath);
  const before = await runner.all('PRAGMA table_xinfo(sync_outbox)');
  if (before.length === 0) {
    throw new Error('sync_outbox table missing entirely — that is the #87 whole-table gap, out of scope for this repair; refusing');
  }
  const have = new Set(before.map((r) => r.name));
  const added = [];
  for (const [name, type] of COLUMNS) {
    if (have.has(name)) continue; // idempotent: any subset may already exist
    await runner.exec(`ALTER TABLE sync_outbox ADD COLUMN ${name} ${type};`);
    added.push(name);
  }
  const after = new Set((await runner.all('PRAGMA table_xinfo(sync_outbox)')).map((r) => r.name));
  for (const [name] of COLUMNS) {
    if (!after.has(name)) throw new Error(`sync_outbox.${name} still missing after repair`);
  }
  return { added };
}

async function main() {
  const dbPath = process.argv[2];
  if (!dbPath) {
    console.error('usage: repair-sync-outbox-v2.js <path-to-farming.db>');
    process.exit(2);
  }
  const { added } = await repairSyncOutboxV2(dbPath);
  console.error(added.length
    ? `[repair-sync-outbox-v2] added: ${added.join(', ')}`
    : '[repair-sync-outbox-v2] no-op: all three columns already present');
}

if (require.main === module) {
  main().catch((e) => { console.error(`[repair-sync-outbox-v2] FAILED: ${e.message}`); process.exit(1); });
}

module.exports = { repairSyncOutboxV2, COLUMNS };
```

- [ ] **Step 4.4: Run it (green)**

Run: `node --test scripts/repair-sync-outbox-v2.test.js`
Expected: `# pass 5`, exit 0.

- [ ] **Step 4.5: Commit**

```bash
git add scripts/repair-sync-outbox-v2.js scripts/repair-sync-outbox-v2.test.js
git commit -m "feat(schema): pre-baseline sync_outbox v2-column repair (#88 Stage 0, spec D(c))"
```

---

### Task 5: `scripts/baseline-existing-db.js` — version-aware baseline stamping (spec §B/§E)

**Files:**
- Create: `scripts/baseline-existing-db.test.js`
- Create: `scripts/baseline-existing-db.js`

**Interfaces:**
- Consumes: Task 2's `snapshotSchema`/`compareSchemas`/`FAILING_CLASSES`; `lib/osi-migrate` (`bootstrapFresh`, `syncFingerprints`, `ensureLedger`, `successInsertSql`, `loadMigrations`); Task 3's `0005` (the real-shape test depends on it).
- Produces: `runBaseline({ dbPath, version?, report?, migrationsDir?, log? }) → { matched, tried }` and `buildReference(migrationsDir, n, scratchRoot) → refDbPath`. CLI: `node scripts/baseline-existing-db.js <db> [--version N] [--report]` — exit 0 on match, 1 on refusal, 2 on usage/guardrail errors. This is the **second sanctioned schema-bookkeeping tool** (Task 6 amends the skill NEVER-list).

- [ ] **Step 5.1: Write the failing test suite** — create `scripts/baseline-existing-db.test.js` with exactly:

```js
'use strict';
// Gate-pass, gate-fail-stamps-nothing, checksum-source, idempotency, and the
// end-to-end kaba100-shaped scenario (spec §B/§E/§G). Uses the REAL repo
// migrations (0001..0005) except where a synthetic dir is the point.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { applyPending, verifyHead } = require('../lib/osi-migrate');
const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');
const { runBaseline, buildReference } = require('./baseline-existing-db');

const REPO = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-')); }

// deploy.sh ensure_analysis_views_schema shape — the live early-arrived 0005
// content (deliberately different indentation from 0005 to prove semantic,
// not textual, matching).
const LIVE_ANALYSIS_VIEWS = `CREATE TABLE IF NOT EXISTS analysis_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    owner_user_uuid TEXT,
    name TEXT NOT NULL,
    view_json TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );`;

async function makePreLedgerDeviceAt(n, extraSql = '') {
  // reference(n) minus the runner bookkeeping tables = a pre-ledger device.
  const refDb = await buildReference(MIGRATIONS_DIR, n, scratch());
  const db = path.join(scratch(), 'device.db');
  fs.copyFileSync(refDb, db);
  const r = cliRunner(db);
  await r.exec('DROP TABLE IF EXISTS schema_migrations;\nDROP TABLE IF EXISTS schema_object_fingerprints;');
  if (extraSql) await r.exec(extraSql);
  return db;
}

test('kaba100-shaped device (reference(3) + early analysis_views) baselines at N=3; applyPending then carries it to head', async () => {
  const db = await makePreLedgerDeviceAt(3, LIVE_ANALYSIS_VIEWS);
  const logs = [];
  const { matched } = await runBaseline({ dbPath: db, log: (l) => logs.push(l) });
  assert.equal(matched, 3, logs.join('\n'));
  assert.match(logs.join('\n'), /extra_forward:table:analysis_views/);
  const res = await applyPending(cliRunner(db), {
    migrationsDir: MIGRATIONS_DIR, appVersion: 'test', writersStopped: true,
  });
  assert.deepEqual(res.applied, [4, 5]); // 0004 rebuild runs; 0005 no-ops over the early table
  assert.deepEqual(await verifyHead(cliRunner(db), { migrationsDir: MIGRATIONS_DIR }), { ok: true });
});

test('gate failure stamps NOTHING (no ledger tables created)', async () => {
  const db = await makePreLedgerDeviceAt(3, 'CREATE TABLE rogue (x TEXT);');
  const { matched } = await runBaseline({ dbPath: db, log: () => {} });
  assert.equal(matched, null);
  const tables = await cliRunner(db).all(
    "SELECT name FROM sqlite_master WHERE name IN ('schema_migrations','schema_object_fingerprints')");
  assert.deepEqual(tables, []);
});

test('clean head-shaped device baselines at head, idempotently, distinguishably tagged', async () => {
  const head = loadMigrations(MIGRATIONS_DIR).at(-1).version;
  const db = await makePreLedgerDeviceAt(head);
  assert.equal((await runBaseline({ dbPath: db, log: () => {} })).matched, head);
  assert.equal((await runBaseline({ dbPath: db, log: () => {} })).matched, head); // re-run: same result
  const rows = await cliRunner(db).all('SELECT version, status, app_version FROM schema_migrations ORDER BY version');
  assert.equal(rows.length, head);
  assert.ok(rows.every((r) => r.status === 'applied' && r.app_version === 'baseline-existing-db'));
  assert.deepEqual(await verifyHead(cliRunner(db), { migrationsDir: MIGRATIONS_DIR }), { ok: true });
});

test('report mode walks all N and stamps nothing', async () => {
  const db = await makePreLedgerDeviceAt(3, LIVE_ANALYSIS_VIEWS);
  const logs = [];
  const { matched } = await runBaseline({ dbPath: db, report: true, log: (l) => logs.push(l) });
  assert.equal(matched, 3);
  assert.match(logs.join('\n'), /report mode: best match N=3; nothing stamped/);
  const tables = await cliRunner(db).all("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'");
  assert.deepEqual(tables, []);
});

test('checksum manifest divergence from disk refuses before comparing', async () => {
  const dir = scratch();
  fs.writeFileSync(path.join(dir, '0001__x.sql'), '-- risk: additive\nCREATE TABLE a (x TEXT);\n');
  fs.writeFileSync(path.join(dir, 'CHECKSUMS.json'), JSON.stringify({ '0001__x.sql': 'f'.repeat(64) }, null, 2));
  const db = path.join(scratch(), 'd.db');
  await cliRunner(db).exec('CREATE TABLE a (x TEXT);');
  await assert.rejects(
    () => runBaseline({ dbPath: db, migrationsDir: dir, log: () => {} }),
    /manifest mismatch/
  );
});

test('refuses a missing db path (anti-typo)', async () => {
  await assert.rejects(() => runBaseline({ dbPath: '/nonexistent/nope.db', log: () => {} }), /does not exist/);
});
```

- [ ] **Step 5.2: Run it (red)**

Run: `node --test scripts/baseline-existing-db.test.js`
Expected: FAIL — `Cannot find module './baseline-existing-db'`.

- [ ] **Step 5.3: Implement** — create `scripts/baseline-existing-db.js` with exactly:

```js
#!/usr/bin/env node
'use strict';
// baseline-existing-db.js — the SECOND sanctioned schema-bookkeeping tool
// (alongside scripts/restamp-fingerprints.js). Option B Stage 0 (issue #88),
// spec §B/§E:
//   docs/superpowers/specs/2026-07-07-option-b-stage0-canonicalization-design.md
//
// Stamps a pre-ledger device's schema_migrations ledger at the highest version
// N whose reference(N) the live schema semantically matches, tolerating
// forward drift (live extras identical to reference(head) objects introduced
// after N) and the named allowlist. Checksums come from CHECKSUMS.json — never
// recomputed (a wrong checksum bricks the device at its first applyPending via
// the checksum-repair path, runner.js). After stamping: syncFingerprints, so
// the runner's drift preflight sees a consistent world.
//
// Guardrails: refuses a missing db path; on ANY gate failure prints the
// classified diff and stamps NOTHING. NEVER does: DDL, application-data
// writes, backups, applyPending (Stage 1's job, separate blast radius).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cliRunner } = require('../lib/osi-migrate/runner-iface');
const { bootstrapFresh } = require('../lib/osi-migrate');
const { syncFingerprints } = require('../lib/osi-migrate/runner');
const { ensureLedger, successInsertSql } = require('../lib/osi-migrate/ledger');
const { loadMigrations } = require('../lib/osi-migrate/migrations-loader');
const { snapshotSchema, compareSchemas, FAILING_CLASSES } = require('./semantic-schema-compare');

const REPO = path.resolve(__dirname, '..');
const DEFAULT_MIGRATIONS_DIR = path.join(REPO, 'database/migrations/ordered');
const APP_VERSION = 'baseline-existing-db';

function loadManifest(migrationsDir) {
  const p = path.join(migrationsDir, 'CHECKSUMS.json');
  if (!fs.existsSync(p)) throw new Error(`checksum manifest missing: ${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function assertManifestMatchesDisk(migrations, manifest) {
  for (const m of migrations) {
    if (manifest[m.name] !== m.checksum) {
      throw new Error(`checksum manifest mismatch for ${m.name}: this checkout's migration files diverge from CHECKSUMS.json — refusing to baseline anything`);
    }
  }
}

async function buildReference(migrationsDir, n, scratchRoot) {
  const dir = fs.mkdtempSync(path.join(scratchRoot, `ref-${String(n).padStart(4, '0')}-`));
  const subset = path.join(dir, 'migrations');
  fs.mkdirSync(subset);
  for (const f of fs.readdirSync(migrationsDir)) {
    if (!/^\d{4}__[a-z0-9_]+\.sql$/.test(f)) continue;
    if (Number(f.slice(0, 4)) <= n) fs.copyFileSync(path.join(migrationsDir, f), path.join(subset, f));
  }
  const dbPath = path.join(dir, 'reference.db');
  await bootstrapFresh(cliRunner(dbPath), { migrationsDir: subset, appVersion: 'stage0-reference' });
  return dbPath;
}

function summarize(diffs) {
  return diffs.map((d) => `${d.class}:${d.kind}:${d.name}`).join(', ') || 'none';
}

function printDiffs(log, label, diffs) {
  log(`[baseline] ${label}:`);
  for (const d of diffs) log(`  [${d.class}] ${d.kind} ${d.name} — ${d.detail}`);
}

async function stamp(dbPath, migrations, manifest, n) {
  const runner = cliRunner(dbPath);
  await ensureLedger(runner);
  const inserts = migrations
    .filter((m) => m.version <= n)
    .map((m) => successInsertSql({
      version: m.version, name: m.name, checksum: manifest[m.name],
      appVersion: APP_VERSION, backupPath: '',
    }));
  await runner.exec(`BEGIN IMMEDIATE;\n${inserts.join('\n')}\nCOMMIT;`);
  await syncFingerprints(runner);
}

async function runBaseline({ dbPath, version = null, report = false, migrationsDir = DEFAULT_MIGRATIONS_DIR, log = console.error }) {
  if (!dbPath) throw new Error('usage: baseline-existing-db.js <path-to-farming.db> [--version N] [--report]');
  if (!fs.existsSync(dbPath)) {
    // sqlite3 would otherwise CREATE an empty DB at a typoed path and "baseline" THAT.
    throw new Error(`refusing: database file does not exist: ${dbPath}`);
  }
  const migrations = loadMigrations(migrationsDir);
  if (migrations.length === 0) throw new Error(`no migrations found in ${migrationsDir}`);
  const manifest = loadManifest(migrationsDir);
  assertManifestMatchesDisk(migrations, manifest);
  const head = migrations[migrations.length - 1].version;
  if (version !== null && (!Number.isInteger(version) || version < 1 || version > head)) {
    throw new Error(`--version must be an integer in 1..${head}`);
  }
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-baseline-'));
  const liveSnap = await snapshotSchema(cliRunner(dbPath));
  const headSnap = await snapshotSchema(cliRunner(await buildReference(migrationsDir, head, scratchRoot)));

  const candidates = version !== null ? [version] : Array.from({ length: head }, (_, i) => head - i);
  const tried = [];
  let matched = null;
  for (const n of candidates) {
    const refSnap = n === head
      ? headSnap
      : await snapshotSchema(cliRunner(await buildReference(migrationsDir, n, scratchRoot)));
    const res = compareSchemas(liveSnap, refSnap, headSnap);
    tried.push({ n, res });
    const failing = res.diffs.filter((d) => FAILING_CLASSES.has(d.class));
    const tolerated = res.diffs.filter((d) => !FAILING_CLASSES.has(d.class));
    log(res.ok
      ? `[baseline] N=${n}: PASS${tolerated.length ? ` (tolerated: ${summarize(tolerated)})` : ''}`
      : `[baseline] N=${n}: FAIL (${failing.length} failing: ${summarize(failing)})`);
    if (res.ok && matched === null) {
      matched = n;
      if (!report) break; // stamp mode stops at the highest passing N; report mode walks on
    }
  }
  if (matched === null) {
    const best = tried.slice().sort((a, b) => a.res.failingCount - b.res.failingCount)[0];
    log('[baseline] NO VERSION MATCHES — refusing to stamp (spec §B.3).');
    printDiffs(log, `diff at N=${tried[0].n}`, tried[0].res.diffs);
    if (best.n !== tried[0].n) {
      printDiffs(log, `best-scoring candidate N=${best.n} (${best.res.failingCount} failing)`, best.res.diffs);
    }
    return { matched: null, tried };
  }
  if (report) {
    log(`[baseline] report mode: best match N=${matched}; nothing stamped`);
    return { matched, tried };
  }
  await stamp(dbPath, migrations, manifest, matched);
  log(`[baseline] stamped versions 1..${matched} (checksums from CHECKSUMS.json, app_version='${APP_VERSION}') and synced fingerprints.`);
  log('[baseline] next: Stage 1 applyPending (writers stopped) carries the device to head.');
  return { matched, tried };
}

function parseArgs(argv) {
  const opts = { dbPath: null, version: null, report: false, migrationsDir: DEFAULT_MIGRATIONS_DIR };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--version') opts.version = Number(argv[++i]);
    else if (a === '--report') opts.report = true;
    else if (a === '--migrations-dir') opts.migrationsDir = path.resolve(argv[++i] || '');
    else if (!opts.dbPath) opts.dbPath = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

if (require.main === module) {
  (async () => {
    const { matched } = await runBaseline(parseArgs(process.argv.slice(2)));
    process.exit(matched === null ? 1 : 0);
  })().catch((e) => { console.error(`[baseline] FAILED: ${e.message}`); process.exit(2); });
}

module.exports = { runBaseline, buildReference, parseArgs, APP_VERSION };
```

- [ ] **Step 5.4: Run it (green)**

Run: `node --test scripts/baseline-existing-db.test.js`
Expected: `# pass 6`, exit 0. (The suite replays real migrations several times via the sqlite3 CLI — expect tens of seconds, not milliseconds.) The first test's `extra_forward:table:analysis_views` assertion is the executable proof of spec §A requirement 2 (0005 ≡ live ensure_* shape, semantically): if it reports `extra_unknown` instead, 0005's DDL diverged from the deploy.sh shape — fix 0005 (Task 3), not the comparator.

- [ ] **Step 5.5: Commit**

```bash
git add scripts/baseline-existing-db.js scripts/baseline-existing-db.test.js
git commit -m "feat(schema): version-aware semantic baseline stamping tool (#88 Stage 0, spec B/E)"
```

---

### Task 6: Skill NEVER-list amendment + CI wiring + full gate

**Files:**
- Modify: `.claude/skills/osi-schema-change-control/SKILL.md` (3 sites)
- Modify: `.github/workflows/migrations.yml` (1 line)

- [ ] **Step 6.1: Amend the skill's NEVER-do table row.** In `.claude/skills/osi-schema-change-control/SKILL.md`, in the `Hand-edit schema_object_fingerprints` row, replace:

```
The only sanctioned re-baseline is `scripts/restamp-fingerprints.js` (see below).
```

with:

```
The only sanctioned re-baselines are `scripts/restamp-fingerprints.js` (recompute fingerprints of a confirmed-good live schema) and `scripts/baseline-existing-db.js` (semantic-gated first baseline of a pre-ledger device — Option B Stage 0, spec 2026-07-07).
```

- [ ] **Step 6.2: Amend the "Restamp rules" opening sentence.** Replace:

```
`scripts/restamp-fingerprints.js` is the **only** sanctioned way to re-baseline
`schema_object_fingerprints`.
```

with:

```
`scripts/restamp-fingerprints.js` and `scripts/baseline-existing-db.js` (Option B
Stage 0 — semantic-gated ledger baseline + fingerprint sync for pre-ledger
devices) are the **only** sanctioned ways to re-baseline
`schema_object_fingerprints`.
```

- [ ] **Step 6.3: Amend the "Common mistakes" bullet.** Replace:

```
Exactly one sanctioned tool exists for fingerprints
  (`restamp-fingerprints.js`); none for hand-editing `schema_migrations` rows.
```

with:

```
Exactly two sanctioned tools write these tables outside the runner:
  `restamp-fingerprints.js` (fingerprints only) and `baseline-existing-db.js`
  (semantic-gated ledger baseline + fingerprints; Option B Stage 0).
  Hand-editing either table directly remains forbidden.
  (`scripts/repair-sync-outbox-v2.js` is a sanctioned, temporary pre-baseline
  additive repair — not a ledger tool; delete it once the fleet is baselined.)
```

(If the exact wrapping of the old text differs, match on the sentence content — the three sites are: the NEVER-do table, the "Restamp rules" section opening, and the final "Common mistakes" bullet about `schema_object_fingerprints`/`schema_migrations`.)

- [ ] **Step 6.4: Wire the three new scripts test files into CI.** In `.github/workflows/migrations.yml`, extend the existing scripts test line by appending the three new files, so:

```yaml
      - run: node --test scripts/check-sync-parity.test.js scripts/restamp-fingerprints.test.js scripts/verify-migrations.test.js scripts/verify-no-stray-ddl.test.js scripts/verify-no-new-silent-catch.test.js scripts/test-error-recording-flow.js
```

becomes:

```yaml
      - run: node --test scripts/check-sync-parity.test.js scripts/restamp-fingerprints.test.js scripts/verify-migrations.test.js scripts/verify-no-stray-ddl.test.js scripts/verify-no-new-silent-catch.test.js scripts/test-error-recording-flow.js scripts/semantic-schema-compare.test.js scripts/repair-sync-outbox-v2.test.js scripts/baseline-existing-db.test.js
```

(`sql-normalize.test.js` is already covered by the workflow's `lib/osi-migrate/__tests__/*.test.js` glob.)

- [ ] **Step 6.5: Run the full verifier gate**

```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-profile-parity.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-devices-rebuild-fence.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-sync-flow.js
node --test lib/osi-migrate/__tests__/*.test.js
node --test scripts/semantic-schema-compare.test.js scripts/repair-sync-outbox-v2.test.js scripts/baseline-existing-db.test.js
node --test scripts/rehearse-devices-rebuild.test.js
```

Expected: every script prints its OK line and exits 0 (`verify-migrations: OK (5 migrations, ...)`; `verify-sync-flow` ends with `All parity checks passed.`). Any RED is a real regression — fix before proceeding, do not rationalize.

- [ ] **Step 6.6: Commit**

```bash
git add .claude/skills/osi-schema-change-control/SKILL.md .github/workflows/migrations.yml
git commit -m "docs(skill)+ci: sanction baseline-existing-db as second bookkeeping tool; wire Stage 0 tests (#88)"
```

---

### Task 7: Local dry-run against the kaba100 dev fixture + PR

**Files:** none modified. The fixture `/home/phil/backups/kaba100-chameleon-zero-export-20260702/farming-kaba100-20260702T0754Z.db` is **read-only** — every operation below runs on a copy in a scratch dir. Expected per spec §F: this fixture predates the #105 flows deploy, so Phase A **must** show trigger `changed` diffs at N=3 and a refusal — that refusal is the acceptance evidence for the §B precondition, not a bug. Any diff not predicted below is a FINDING: stop, record it, report it in the PR — do not fix silently and do not loosen the comparator.

- [ ] **Step 7.1: Set up the scratch copy (fixture untouched)**

```bash
FIXTURE=/home/phil/backups/kaba100-chameleon-zero-export-20260702/farming-kaba100-20260702T0754Z.db
SCRATCH=$(mktemp -d /tmp/stage0-dryrun-XXXXXX)
sha256sum "$FIXTURE" | tee "$SCRATCH/fixture.sha256"
cp "$FIXTURE" "$SCRATCH/kaba100-copy.db"
sqlite3 "$SCRATCH/kaba100-copy.db" 'PRAGMA integrity_check;'
```

Expected: `ok`. (~231 MB copy; the scratch dir will also hold the 0004 backup — budget ~700 MB free in /tmp.)

- [ ] **Step 7.2: Capture pre-run row counts**

```bash
for t in irrigation_schedules device_data chameleon_readings dendrometer_readings dendrometer_daily irrigation_events zone_daily_environment zone_daily_recommendations analysis_views; do
  echo "$t $(sqlite3 "$SCRATCH/kaba100-copy.db" "SELECT COUNT(*) FROM $t" 2>/dev/null || echo ABSENT)"
done | tee "$SCRATCH/rowcounts-before.txt"
```

Expected: counts for all tables (`analysis_views` may print `ABSENT` if the fixture predates its ensure_* — record whichever it is).

- [ ] **Step 7.3: Phase A — prediction check against the STALE fixture (expected refusal)**

```bash
node scripts/baseline-existing-db.js "$SCRATCH/kaba100-copy.db" --report 2>&1 | tee "$SCRATCH/report-phase-a.txt"
```

Expected: `FAIL` at every N; at N=3 the failing diffs include trigger `changed` entries (pre-`contract_version` bodies — the MAJOR-9 prediction) and `missing` columns `sync_outbox.rejected_at/rejection_reason/last_retryable_failure_at`; possibly `missing` `gateway_health_*` tables if the fixture predates that deploy. Exit code 1. **This refusal is correct behavior** — record the output as evidence. Anything outside these predicted classes is a finding (stop and report).

- [ ] **Step 7.4: Phase B — simulate refactor-program item 0.1's standard deploy on the copy**

(1) The §D(c) repair (also §F step 0), run twice to prove the no-op:

```bash
node scripts/repair-sync-outbox-v2.js "$SCRATCH/kaba100-copy.db"
node scripts/repair-sync-outbox-v2.js "$SCRATCH/kaba100-copy.db"
```

Expected: first run `added: rejected_at, rejection_reason, last_retryable_failure_at`; second run `no-op: all three columns already present`.

(2) The additive `ensure_gateway_health_schema` equivalent (0002 is `IF NOT EXISTS` throughout — safe either way):

```bash
sqlite3 -bail "$SCRATCH/kaba100-copy.db" < database/migrations/ordered/0002__gateway_health.sql && echo "OK 0002"
```

Expected: `OK 0002`.

(3) Boot-node trigger convergence (what `sync-init-fn` does on every boot: DROP + CREATE the full trigger set; the seed's trigger set == current flows', guaranteed by `verify-runtime-schema-parity`):

```bash
COPY_DB="$SCRATCH/kaba100-copy.db" node <<'EOF'
const { execFileSync } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const copy = process.env.COPY_DB;
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'seedtrig-')), 'seed.db');
execFileSync('sqlite3', ['-bail', tmp], { input: fs.readFileSync('database/seed-blank.sql', 'utf8') });
const rows = JSON.parse(execFileSync('sqlite3',
  ['-json', tmp, "SELECT name, sql FROM sqlite_master WHERE type='trigger' ORDER BY name"],
  { encoding: 'utf8' }));
const script = rows.map((r) => `DROP TRIGGER IF EXISTS ${r.name};\n${r.sql};`).join('\n');
execFileSync('sqlite3', ['-bail', copy], { input: `BEGIN IMMEDIATE;\n${script}\nCOMMIT;` });
console.log(`converged ${rows.length} triggers`);
EOF
```

Expected: `converged 30 triggers`.

- [ ] **Step 7.5: Phase C — §F steps 1–2: report, then baseline-stamp**

```bash
node scripts/baseline-existing-db.js "$SCRATCH/kaba100-copy.db" --report 2>&1 | tee "$SCRATCH/report-phase-c.txt"
node scripts/baseline-existing-db.js "$SCRATCH/kaba100-copy.db"
```

Expected: report shows `N=3: PASS` with tolerated `extra_forward:table:analysis_views` (if the fixture had the table) and `extra_allowlisted` chameleon `swt_1/2/3` columns; N=4/5 FAIL on the `irrigation_schedules` CHECK (`changed`). The stamp run ends `stamped versions 1..3 ... and synced fingerprints.`, exit 0. Any `extra_unknown`/unpredicted diff = finding → stop and report.

- [ ] **Step 7.6: §F step 3 — applyPending to head on the copy (0004 rebuild + 0005 no-op)**

```bash
COPY_DB="$SCRATCH/kaba100-copy.db" node <<'EOF'
const path = require('node:path');
const { cliRunner } = require('./lib/osi-migrate/runner-iface');
const { applyPending, verifyHead } = require('./lib/osi-migrate');
(async () => {
  const db = process.env.COPY_DB;
  const migrationsDir = path.resolve('database/migrations/ordered');
  const res = await applyPending(cliRunner(db), { migrationsDir, appVersion: 'stage0-dryrun', writersStopped: true });
  console.log('applied:', JSON.stringify(res.applied));
  const head = await verifyHead(cliRunner(db), { migrationsDir });
  console.log('verifyHead:', JSON.stringify(head));
})().catch((e) => { console.error(e); process.exit(1); });
EOF
```

Expected: `applied: [4,5]` then `verifyHead: {"ok":true}`. (0004 takes an automatic pre-migration backup into the scratch dir — expected.)

- [ ] **Step 7.7: §F steps 4–5 — postflight + row-count invariants + CHECK spot-check**

```bash
sqlite3 "$SCRATCH/kaba100-copy.db" 'PRAGMA integrity_check;'
sqlite3 "$SCRATCH/kaba100-copy.db" 'PRAGMA foreign_key_check;'
for t in irrigation_schedules device_data chameleon_readings dendrometer_readings dendrometer_daily irrigation_events zone_daily_environment zone_daily_recommendations analysis_views; do
  echo "$t $(sqlite3 "$SCRATCH/kaba100-copy.db" "SELECT COUNT(*) FROM $t" 2>/dev/null || echo ABSENT)"
done | tee "$SCRATCH/rowcounts-after.txt"
diff "$SCRATCH/rowcounts-before.txt" "$SCRATCH/rowcounts-after.txt" && echo "ROWCOUNTS IDENTICAL"
sqlite3 "$SCRATCH/kaba100-copy.db" "SELECT sql FROM sqlite_master WHERE name='irrigation_schedules'" | grep -o "SWT_1','SWT_2','SWT_3','DENDRO" && echo "CHECK WIDENED"
```

Expected: `ok`; empty FK output; `ROWCOUNTS IDENTICAL` — **`irrigation_schedules` is the headline invariant (0004 rebuilds it)**; `CHECK WIDENED`. Sole allowed rowcount difference: `analysis_views` changing `ABSENT` → `0` if the fixture lacked the table (0005 created it empty) — if that occurs, the diff shows exactly that one line and nothing else; document it. §F step 6 (Node-RED boot) is **out of scope for the local dry-run** — it belongs to the operator rehearsal-of-record.

- [ ] **Step 7.8: Prove the fixture is untouched, then clean up**

```bash
sha256sum -c "$SCRATCH/fixture.sha256"
rm -rf "$SCRATCH"
```

Expected: `...: OK`, then scratch removed. Never commit anything from the scratch dir.

- [ ] **Step 7.9: Push branch and open the PR (do not merge)**

```bash
git push -u origin feat/88-stage0-canonicalization
gh pr create --title "feat(schema): Option B Stage 0 — semantic reference, comparator, baseline tooling (#88)" --body "<body per below>"
```

PR body must contain: (1) scope — Stage 0 of issue #88 per the spec (link it); tooling + 0005 fold-in only, **no deploy.sh wiring (Stage 1), no boot-node change, no live devices**; (2) the two review-driven design points — forward-drift tolerance (§B) and the pre-baseline repair (§D(c)) — one sentence each; (3) real verifier outputs from Task 6 Step 6.5; (4) the Task 7 dry-run evidence: Phase A predicted refusal (stale-fixture trigger diffs — spec §F expected behavior), Phase C `N=3 PASS` log, `applied: [4,5]`, `verifyHead ok`, `ROWCOUNTS IDENTICAL`, fixture sha256 `OK`; (5) any findings (unpredicted diffs) verbatim; (6) follow-ups below. Reference "Part of #88" (the issue stays open through Stages 1–2).

## Follow-ups (operator runbook steps — NOT plan tasks)

- **Rehearsal-of-record (spec §F):** after refactor-program item 0.1's standard deploy to kaba100, pull a FRESH byte-copy (`.backup` → `integrity_check` → transfer, per `osi-live-ops-runbook`) and run §F steps 0–6 on it — including the Node-RED boot (step 6) this plan's dry-run excludes. Update the spec's DoD line with the evidence and the confirmed N.
- Same per-device rehearsal before Silvan's window; Uganda only inside the #87 combined window (plan §5).
- Delete `scripts/repair-sync-outbox-v2.js` (+ test + CI line) once the fleet is baselined — consumed-or-deleted.
