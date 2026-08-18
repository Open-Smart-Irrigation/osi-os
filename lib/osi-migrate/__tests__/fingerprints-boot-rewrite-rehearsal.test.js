'use strict';
// osi-os#153 end-to-end rehearsal: a fresh set of ordered migrations is
// applied and stamped (as `deploy.sh` does with writers stopped), then the
// ACTUAL `sync-init-fn` boot node DDL (extracted from the real, shipped
// flows.json — not a hand-written stand-in) is executed against the same
// database at a real fleet gateway's DEVICE_EUI, simulating the Node-RED
// restart that immediately follows every deploy. Before the osi-os#153 fix,
// this reliably produced `verifyHead().ok === false` for every gateway whose
// EUI is not Silvan's; this test proves the fix without re-deriving the
// approach independently — it adapts a Fable-reviewer's rehearsal harness
// (`rehearse.js`) used during A6 review of 0047__sdi12_value_count.sql into
// a committed regression test.
//
// It also proves the opposite: with the boot node's own DDL text mutated to
// drop a watched column (the exact shape of a REAL silent-drift bug, not a
// spacing/EUI difference), verifyHead must still report ok:false — the
// EUI/spacing blindness introduced by this fix must not have gone so far
// that it stops detecting genuine drift.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { cliRunner } = require('../runner-iface');
const { bootstrapFresh, verifyHead } = require('../index');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const FLOWS_PATH = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'database/migrations/ordered');

// sdi12_value_count is a real watched column added by 0047 specifically
// because its boot-node mirror (a hand-synced literal, not derived from the
// migration) is exactly the kind of thing that silently drifts — dropping it
// from the boot node's copy must remain a detected regression.
const SDI12_MUTATIONS = [
  " OR COALESCE(NEW.sdi12_value_count,-1) <> COALESCE(OLD.sdi12_value_count,-1)",
  ", 'sdi12_value_count', NEW.sdi12_value_count",
];

// Extract the `const stmts = [...]` / `const triggers = [...]` arrays from
// sync-init-fn's real source and evaluate them as JS with a given gatewaySql,
// exactly as the node does at boot (`gatewaySql = /^[0-9A-F]{16}$/.test(gateway)
// ? "'"+gateway+"'" : 'NULL'`). Mirrors scripts/verify-boot-ddl-interpolation.js's
// extractTriggerStatements, generalized to a caller-supplied EUI/NULL and to
// also grab the ADD-COLUMN sweep (`stmts`), matching rehearse.js.
function extractBootArrays(flowsPath, gatewaySqlLiteral) {
  const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
  const node = flows.find((n) => n && n.id === 'sync-init-fn');
  if (!node) throw new Error('sync-init-fn node not found');
  const lines = node.func.split('\n');
  const grab = (startRe) => {
    const i = lines.findIndex((l) => startRe.test(l));
    const j = lines.findIndex((l, k) => k > i && /^\];\s*$/.test(l));
    if (i === -1 || j === -1) throw new Error(`could not locate array for ${startRe}`);
    return lines.slice(i, j + 1).join('\n').replace(/^const \w+ = /, 'return ');
  };
  const stmts = new Function('gatewaySql', grab(/^const stmts = \[/))(gatewaySqlLiteral);
  const triggers = new Function('gatewaySql', grab(/^const triggers = \[/))(gatewaySqlLiteral);
  return { stmts, triggers };
}

async function runBootNode(runner, flowsPath, eui) {
  const gatewaySqlLiteral = eui === null ? 'NULL' : `'${eui}'`;
  const { stmts, triggers } = extractBootArrays(flowsPath, gatewaySqlLiteral);
  for (const sql of stmts) { try { await runner.exec(sql); } catch (_) { /* boot node swallows these */ } }
  for (const sql of triggers) { await runner.exec(sql); } // trigger DROP+CREATE must not fail
}

// Building the full migration ladder is the expensive part (one sqlite3 CLI
// spawn per PRAGMA per table per migration, compounding as tables accrue).
// Build it exactly once per test-file run and reuse it by file copy for each
// scenario, instead of re-running bootstrapFresh per scenario.
let baselineDbPromise = null;
function baselineDb() {
  if (!baselineDbPromise) {
    baselineDbPromise = (async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-rehearsal-'));
      const db = path.join(dir, 'baseline.db');
      const r = cliRunner(db);
      await bootstrapFresh(r, { migrationsDir: MIGRATIONS_DIR, appVersion: 'test' });
      return db;
    })();
  }
  return baselineDbPromise;
}

async function scenarioRunner() {
  const base = await baselineDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-rehearsal-scenario-'));
  const db = path.join(dir, 't.db');
  fs.copyFileSync(base, db);
  return cliRunner(db);
}

for (const [label, eui] of [
  ['kaba100', '0016C001F11766E7'],
  ['Uganda', '0016C001F151B1D6'],
  ['unset DEVICE_EUI (fresh image, pre-config)', null],
]) {
  test(`boot-rewrite rehearsal: ${label} restart after migrate -> verifyHead ok:true (no false drift)`, async () => {
    const r = await scenarioRunner();
    await runBootNode(r, FLOWS_PATH, eui);
    // A second restart (idempotency: the boot node runs on every boot) must also stay clean.
    await runBootNode(r, FLOWS_PATH, eui);
    const v = await verifyHead(r, { migrationsDir: MIGRATIONS_DIR });
    assert.deepEqual(v, { ok: true }, `expected no drift after a ${label} boot restart, got: ${JSON.stringify(v)}`);
  });
}

test('boot-rewrite rehearsal: real drift (boot copy missing sdi12_value_count) is still caught', async () => {
  const r = await scenarioRunner();

  // Mutate a TEMP copy of flows.json so only the boot node's in-memory copy
  // of the trigger loses the watched column — the migration/seed copy (and
  // therefore this test's baseline) is untouched, exactly modelling "someone
  // hand-edited the frozen boot node and forgot to keep it in sync."
  const flowsRaw = fs.readFileSync(FLOWS_PATH, 'utf8');
  const flows = JSON.parse(flowsRaw);
  const node = flows.find((n) => n && n.id === 'sync-init-fn');
  let mutatedFunc = node.func;
  let removed = 0;
  for (const needle of SDI12_MUTATIONS) {
    const before = mutatedFunc.length;
    mutatedFunc = mutatedFunc.split(needle).join('');
    if (mutatedFunc.length !== before) removed += 1;
  }
  assert.equal(removed, SDI12_MUTATIONS.length, 'test fixture assumption: both sdi12_value_count mentions must be found and removed');
  node.func = mutatedFunc;
  const mutatedFlowsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osimig-rehearsal-mutated-')), 'flows.json');
  fs.writeFileSync(mutatedFlowsPath, JSON.stringify(flows));

  await runBootNode(r, mutatedFlowsPath, '0016C001F11766E7');
  const v = await verifyHead(r, { migrationsDir: MIGRATIONS_DIR });
  assert.equal(v.ok, false, 'dropping a watched column from the boot node copy must remain detectable drift');
});
