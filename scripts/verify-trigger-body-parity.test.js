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
