# Trigger-Body Parity Verifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A CI verifier that fails when any trigger body rewritten by the `sync-init-fn` boot node diverges semantically from the same trigger's body in `database/seed-blank.sql`, closing the drift gap recorded as issue 16 in `tmp/live-pi-verification-192.168.8.180-2026-07-13.md` (the seed's devices trigger ran without the chameleon fields for seven weeks while the boot rewrite had them, and `verify-runtime-schema-parity.js` compares trigger name sets only).

**Architecture:** Reuse `scripts/verify-boot-ddl-interpolation.js` (already on the `integration/fresh-pi-fixes-2026-07-13` branch), which extracts the boot node's `const triggers = [...]` DDL array and evaluates it with a bound test EUI. The new verifier builds one in-memory DB from the seed, snapshots trigger bodies from `sqlite_master`, executes the boot DDL, snapshots again, and compares canonicalized bodies for every trigger the boot statements manage. Canonicalization replaces gateway-EUI literals with a placeholder and collapses formatting, so only semantic drift fails.

**Tech Stack:** Node built-ins only (`node:sqlite` `DatabaseSync`, `node:test`, `node:fs`) — same as the sibling verifier. No new dependencies.

## Global Constraints

- Base branch: `integration/fresh-pi-fixes-2026-07-13` (requires `verify-boot-ddl-interpolation.js` and its exports).
- No new npm dependencies; `node:sqlite` is already used by the sibling verifier.
- Both flows profiles are checked: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` and the bcm2709 mirror (byte-identical, enforced elsewhere by `verify-profile-parity.js`).
- Canonicalization rules must each exist for a named, documented reason; never loosen the comparison to make an unexplained diff pass.
- If Task 2's repo run reveals semantic drift (a real body difference that survives canonicalization), STOP and report the diff list — adjudication of which copy is correct is the orchestrator's call, not the implementer's.
- Evidence rules per `osi-verification-commands`: paste real command output and exit codes; never prove success through a pipe.

---

### Task 1: Canonicalizer and parity core (TDD)

**Files:**
- Create: `scripts/verify-trigger-body-parity.js`
- Create: `scripts/verify-trigger-body-parity.test.js`

**Interfaces:**
- Consumes: `extractTriggerStatements(flowsPath)` and `TEST_GATEWAY_SQL` from `./verify-boot-ddl-interpolation.js` (exported at its line 189).
- Produces: `canonicalizeTriggerSql(sql)`, `verifyFlows(flowsPath, seedPath) -> string[]` (failure messages, empty = pass), both exported for the test and for Task 3's CI wiring.

- [ ] **Step 1: Write the failing test**

```js
// scripts/verify-trigger-body-parity.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { canonicalizeTriggerSql, verifyFlows } = require('./verify-trigger-body-parity.js');

// --- fixtures -------------------------------------------------------------
// A minimal seed with one trigger using the seed's hardcoded fallback EUI.
const SEED_SQL = `
CREATE TABLE t (id INTEGER PRIMARY KEY, gateway_device_eui TEXT);
CREATE TRIGGER trg_t AFTER INSERT ON t FOR EACH ROW BEGIN
  UPDATE t SET gateway_device_eui = COALESCE(NEW.gateway_device_eui, '0016C001F11715E2')
   WHERE id = NEW.id;
END;
`;

// Boot-node func whose triggers array matches extractTriggerStatements()'s
// shape requirements: 'const triggers = [' ... newline before '];'.
function flowsFixture(createStmtJs) {
  const func = [
    "const gateway = String('ABCDEF0123456789').trim().toUpperCase();",
    "const gatewaySql = /^[0-9A-F]{16}$/.test(gateway) ? \"'\" + gateway.replace(/'/g, \"''\") + \"'\" : 'NULL';",
    'const triggers = [',
    '  "DROP TRIGGER IF EXISTS trg_t",',
    '  ' + createStmtJs,
    '];',
  ].join('\n');
  return JSON.stringify([{ id: 'sync-init-fn', type: 'function', name: 'Sync Init Schema + Triggers', func }]);
}

// Boot rewrite equivalent to the seed trigger, formatted single-line the way
// the real node writes DDL, interpolating gatewaySql where the seed hardcodes
// its fallback EUI.
const PARITY_STMT =
  '"CREATE TRIGGER trg_t AFTER INSERT ON t FOR EACH ROW BEGIN UPDATE t SET gateway_device_eui = COALESCE(NEW.gateway_device_eui, " + gatewaySql + ") WHERE id = NEW.id; END;"';

// Same trigger with a semantic difference (extra assignment).
const DRIFT_STMT =
  '"CREATE TRIGGER trg_t AFTER INSERT ON t FOR EACH ROW BEGIN UPDATE t SET gateway_device_eui = COALESCE(NEW.gateway_device_eui, " + gatewaySql + "), id = id WHERE id = NEW.id; END;"';

// A trigger the seed does not define at all.
const BOOT_ONLY_STMT =
  '"CREATE TRIGGER trg_extra AFTER INSERT ON t FOR EACH ROW BEGIN UPDATE t SET id = id WHERE id = NEW.id; END;"';

function writeFixtures(dir, createStmtJs) {
  const seedPath = path.join(dir, 'seed.sql');
  const flowsPath = path.join(dir, 'flows.json');
  fs.writeFileSync(seedPath, SEED_SQL);
  fs.writeFileSync(flowsPath, flowsFixture(createStmtJs));
  return { seedPath, flowsPath };
}

test('canonicalize: EUI literals, IF NOT EXISTS, and whitespace collapse to one form', () => {
  const a = canonicalizeTriggerSql(
    "CREATE TRIGGER  IF NOT EXISTS trg_x AFTER INSERT ON t BEGIN\n  SELECT COALESCE( x , '0016C001F11715E2' );\nEND"
  );
  const b = canonicalizeTriggerSql(
    "CREATE TRIGGER trg_x AFTER INSERT ON t BEGIN SELECT COALESCE(x, 'ABCDEF0123456789'); END"
  );
  assert.strictEqual(a, b);
});

test('parity: equivalent seed and boot bodies pass', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { seedPath, flowsPath } = writeFixtures(dir, PARITY_STMT);
  assert.deepStrictEqual(verifyFlows(flowsPath, seedPath), []);
});

test('parity: drifted boot body fails naming the trigger', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { seedPath, flowsPath } = writeFixtures(dir, DRIFT_STMT);
  const failures = verifyFlows(flowsPath, seedPath);
  assert.strictEqual(failures.length, 1);
  assert.match(failures[0], /trg_t: body drift/);
});

test('parity: boot-only trigger with no seed counterpart fails', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tbp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { seedPath, flowsPath } = writeFixtures(dir, PARITY_STMT + ',\n  ' + BOOT_ONLY_STMT);
  const failures = verifyFlows(flowsPath, seedPath);
  assert.strictEqual(failures.length, 1);
  assert.match(failures[0], /trg_extra: created by boot DDL but absent from seed/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test scripts/verify-trigger-body-parity.test.js`
Expected: FAIL with `Cannot find module './verify-trigger-body-parity.js'`.

- [ ] **Step 3: Write the implementation**

```js
#!/usr/bin/env node
'use strict';
// verify-trigger-body-parity - issue 16 regression guard.
//
// The seed (database/seed-blank.sql) and the sync-init-fn boot node are two
// sources of truth for the same triggers. verify-runtime-schema-parity.js
// compares trigger NAME SETS only, so trigger BODIES drifted silently for
// seven weeks (the devices outbox trigger gained chameleon depth fields in
// the boot rewrite on 2026-05-26 while the seed copy never did — found during
// the 2026-07-13 fresh-Pi verification, ledger issue 16).
//
// This verifier builds an in-memory DB from the seed, snapshots trigger
// bodies, executes the boot node's interpolated DDL (reusing
// verify-boot-ddl-interpolation.js's extraction), snapshots again, and
// compares canonicalized bodies for every trigger the boot statements manage.
//
// Canonicalization rules (each exists for a named reason — never add one to
// silence an unexplained diff):
//   1. Gateway-EUI literals -> '<GATEWAY_EUI>': the seed hardcodes a fallback
//      EUI where the boot node interpolates the device's own; this is the one
//      intended difference between the two copies.
//   2. IF NOT EXISTS removed: the boot node DROPs before CREATE, the seed may
//      guard with IF NOT EXISTS; same resulting object.
//   3. Whitespace collapsed, spacing inside parens/commas normalized: the
//      seed is pretty-printed, the boot DDL is single-line.
//
// Usage:
//   node scripts/verify-trigger-body-parity.js            # both profiles
//   node scripts/verify-trigger-body-parity.js --flows <path> [--seed <path>]

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { extractTriggerStatements, TEST_GATEWAY_SQL } = require('./verify-boot-ddl-interpolation.js');

const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_FLOWS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
].map((p) => path.join(repoRoot, p));
const DEFAULT_SEED = path.join(repoRoot, 'database/seed-blank.sql');

// Rule 1: the interpolated test EUI and the seed's hardcoded fallback EUI.
const GATEWAY_EUI_LITERALS = [TEST_GATEWAY_SQL, "'0016C001F11715E2'"];

function canonicalizeTriggerSql(sql) {
  let s = String(sql || '');
  for (const lit of GATEWAY_EUI_LITERALS) s = s.split(lit).join("'<GATEWAY_EUI>'"); // rule 1
  s = s.replace(/\bIF\s+NOT\s+EXISTS\b/gi, ' ');                                    // rule 2
  s = s.replace(/\s+/g, ' ');                                                       // rule 3
  s = s.replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\s*,\s*/g, ', ');
  return s.trim();
}

function firstDiffWindow(s, other) {
  let i = 0;
  while (i < s.length && i < other.length && s[i] === other[i]) i += 1;
  return s.slice(Math.max(0, i - 40), i + 80);
}

function snapshotTriggers(db) {
  return new Map(
    db.prepare("SELECT name, sql FROM sqlite_master WHERE type='trigger'").all().map((r) => [r.name, r.sql])
  );
}

function verifyFlows(flowsPath, seedPath) {
  const stmts = extractTriggerStatements(flowsPath);
  const bootManaged = new Set();
  for (const stmt of stmts) {
    const m = String(stmt).match(/CREATE\s+TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)/i);
    if (m) bootManaged.add(m[1]);
  }

  const db = new DatabaseSync(':memory:');
  const failures = [];
  try {
    db.exec(fs.readFileSync(seedPath, 'utf8'));
    const seedTriggers = snapshotTriggers(db);
    for (const sql of stmts) {
      try { db.exec(sql); } catch (_) { /* execution failures are verify-boot-ddl-interpolation's job */ }
    }
    const bootTriggers = snapshotTriggers(db);

    for (const name of [...bootManaged].sort()) {
      const bootSql = bootTriggers.get(name);
      if (!bootSql) { failures.push(`${name}: named in boot DDL but absent after execution`); continue; }
      const seedSql = seedTriggers.get(name);
      if (seedSql === undefined) { failures.push(`${name}: created by boot DDL but absent from seed-blank.sql`); continue; }
      const a = canonicalizeTriggerSql(seedSql);
      const b = canonicalizeTriggerSql(bootSql);
      if (a !== b) {
        failures.push(
          `${name}: body drift between seed and boot rewrite\n` +
          `      seed: ...${firstDiffWindow(a, b)}...\n` +
          `      boot: ...${firstDiffWindow(b, a)}...`
        );
      }
    }
  } finally {
    db.close();
  }
  return failures;
}

function parseArgs(argv) {
  const o = { flows: null, seed: DEFAULT_SEED };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--flows') (o.flows = o.flows || []).push(argv[++i]);
    else if (a === '--seed') o.seed = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.flows) o.flows = DEFAULT_FLOWS;
  return o;
}

function run() {
  const o = parseArgs(process.argv.slice(2));
  let failed = false;
  for (const flowsPath of o.flows) {
    const rel = path.isAbsolute(flowsPath) ? flowsPath : path.relative(repoRoot, path.resolve(flowsPath));
    const failures = verifyFlows(path.resolve(flowsPath), path.resolve(o.seed));
    if (failures.length) {
      failed = true;
      console.error(`FAIL ${rel}:`);
      for (const f of failures) console.error(`  - ${f}`);
    } else {
      console.log(`OK ${rel} (all boot-managed trigger bodies match seed-blank.sql after canonicalization)`);
    }
  }
  if (failed) {
    console.error('verify-trigger-body-parity: FAIL');
    process.exit(1);
  }
  console.log('verify-trigger-body-parity: OK');
}

if (require.main === module) {
  try {
    run();
  } catch (e) {
    console.error('verify-trigger-body-parity: FAIL - ' + e.message);
    process.exit(1);
  }
}

module.exports = { canonicalizeTriggerSql, verifyFlows };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test scripts/verify-trigger-body-parity.test.js`
Expected: 4 tests pass, exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-trigger-body-parity.js scripts/verify-trigger-body-parity.test.js
git commit -m "feat: trigger-body parity verifier core (issue 16) — canonicalized seed-vs-boot comparison, TDD fixtures"
```

---

### Task 2: Repo-tree discovery run and reconciliation

**Files:**
- Modify: none expected if the tree is clean; otherwise whatever the adjudication names (see stop rule).

**Interfaces:**
- Consumes: `verifyFlows` from Task 1.
- Produces: a passing verifier against the real repo tree, or a BLOCKED report with the diff list.

- [ ] **Step 1: Run against both real profiles and capture output**

Run: `node scripts/verify-trigger-body-parity.js; echo "EXIT=$?"`
Expected (optimistic): `OK` for both profiles, `EXIT=0`. The 0015/0016 work already re-aligned the six versioned outbox triggers and the devices trigger, so the tree may already pass.

- [ ] **Step 2: If it fails, classify every reported trigger**

For each `body drift` line, read both bodies in full:

```bash
node -e "
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const { extractTriggerStatements } = require('./scripts/verify-boot-ddl-interpolation.js');
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync('database/seed-blank.sql', 'utf8'));
const before = Object.fromEntries(db.prepare(\"SELECT name, sql FROM sqlite_master WHERE type='trigger'\").all().map(r => [r.name, r.sql]));
for (const s of extractTriggerStatements('conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json')) { try { db.exec(s); } catch (_) {} }
const name = process.argv[1];
console.log('--- seed ---\n' + before[name] + '\n--- boot ---\n' + db.prepare(\"SELECT sql FROM sqlite_master WHERE name = ?\").get(name).sql);
" <trigger_name>
```

Classification rule:
- Cosmetic only (spacing/quoting the canonicalizer misses): add ONE named canonicalization rule with a comment explaining the exact formatting class, extend the Task 1 test with a fixture reproducing it, re-run.
- Semantic (different columns, gates, ops, expressions): STOP. Report status BLOCKED with the trigger names and both bodies. Which copy is correct is an adjudication call (the seed is canonical for schema, but the boot copy has historically been where fixes land first) — do not pick a side yourself.

- [ ] **Step 3: Commit whatever reconciliation was approved**

```bash
git add -A
git commit -m "fix: reconcile seed/boot trigger bodies surfaced by parity verifier"
```

(Skip this step entirely if Step 1 passed clean.)

---

### Task 3: CI wiring and verifier documentation

**Files:**
- Modify: `.github/workflows/migrations.yml` (add one step after the `verify-boot-ddl-interpolation` step)
- Modify: `.claude/skills/osi-verification-commands/SKILL.md` (command table)

**Interfaces:**
- Consumes: the Task 1 script names.
- Produces: CI gating + discoverability.

- [ ] **Step 1: Add the CI step**

In `.github/workflows/migrations.yml`, immediately after the existing `verify-boot-ddl-interpolation` step, add (matching the file's existing step style exactly):

```yaml
      - name: Verify trigger-body parity (seed vs boot DDL)
        run: node scripts/verify-trigger-body-parity.js

      - name: Trigger-body parity unit tests
        run: node --test scripts/verify-trigger-body-parity.test.js
```

- [ ] **Step 2: Document the new verifiers in the command table**

Add rows to the Command Table in `.claude/skills/osi-verification-commands/SKILL.md` (this also back-fills the two verifiers the fix program added without table rows):

```markdown
| Boot-DDL interpolation | `node scripts/verify-boot-ddl-interpolation.js` | Ends `verify-boot-ddl-interpolation: OK`, exit 0. Required when touching `sync-init-fn` DDL strings or seed triggers. |
| Trigger-body parity | `node scripts/verify-trigger-body-parity.js` | Ends `verify-trigger-body-parity: OK`, exit 0. Required when touching any trigger in seed-blank.sql or the `sync-init-fn` rewrites. |
| Function-node parse | `node scripts/verify-flows-fn-parse.js` | Ends `verify-flows-fn-parse: OK`, exit 0. Required for any flows.json function-node edit. |
```

Also add one line to the Surface Selection table's flows.json row: `verify-flows-fn-parse.js`, and to the edge-schema row: `verify-boot-ddl-interpolation.js`, `verify-trigger-body-parity.js`.

- [ ] **Step 3: Run the full local gate set touched by this plan**

Run: `node scripts/verify-boot-ddl-interpolation.js && node scripts/verify-trigger-body-parity.js && node --test scripts/verify-trigger-body-parity.test.js scripts/verify-boot-ddl-interpolation.test.js; echo "EXIT=$?"`
Expected: all OK, `EXIT=0`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/migrations.yml .claude/skills/osi-verification-commands/SKILL.md
git commit -m "ci: gate trigger-body parity; document the fix-program verifiers in the command table"
```

---

## Self-review notes

- Spec coverage: issue 16's fix demand ("compare normalized trigger bodies between the seed and the boot-node rewrites, not just names") is Task 1; the ledger's implicit demand that the current tree be clean or reconciled is Task 2; discoverability/gating is Task 3.
- The canonicalizer's three rules each carry a named reason; Task 2's stop rule prevents the classic failure of loosening the comparison until it passes.
- `TEST_GATEWAY_SQL` and `extractTriggerStatements` signatures match `verify-boot-ddl-interpolation.js:189` exports on the base branch.
- Known limitation, accepted: the verifier compares triggers the boot node manages; seed-only triggers (never rewritten at boot) have no second copy to drift against.
