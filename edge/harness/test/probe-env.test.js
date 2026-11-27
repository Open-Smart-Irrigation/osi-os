'use strict';
// The mutation pass's probe environment (lib/probe-env.js) and the boot
// runner the harness runs before every Go start (lib/backend.js).
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { probeEnv, PROFILES, DUAL } = require('../lib/probe-env');
const { runBootRunner, oracleExecutable } = require('../lib/backend');

const ROOT = path.resolve(__dirname, '../../..');
const SCENARIOS = path.join(__dirname, '../scenarios');

function scenarioNames() {
  const out = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.json')) {
        try { const s = JSON.parse(fs.readFileSync(f, 'utf8')); if (s && typeof s.name === 'string' && Array.isArray(s.steps)) out.set(s.name, f); } catch { /* not a scenario */ }
      }
    }
  };
  walk(SCENARIOS);
  return out;
}

test('every profile has its oracle wrapper, and the wrapper preloads the variable the Go side changes', () => {
  for (const [name, p] of Object.entries(PROFILES)) {
    const wrapper = path.join(SCENARIOS, 'dispatch', p.oracle);
    assert.ok(fs.statSync(wrapper).mode & 0o111, name + ': wrapper not executable');
    const preload = /-r "\$here\/([^"]+)"/.exec(fs.readFileSync(wrapper, 'utf8'))[1];
    const text = fs.readFileSync(path.join(SCENARIOS, 'dispatch', preload), 'utf8');
    for (const variable of Object.keys(p.go)) assert.match(text, new RegExp(variable), name + ': preload does not change ' + variable);
  }
});

test('probe scenarios get their profile and mode; others run as recorded by default', () => {
  const names = scenarioNames();
  const expect = {
    'rd-noapp-manual': ['noapp', false], 'dc-noapp-daily': ['noapp', false], 'r1-dispatch-noapp-manual-scoped': ['noapp', true],
    'cb2-nokey-cancel': ['nokey', false], 'r4-dispatch-nokey-timer-states': ['nokey', false], 'cb2-nourl-cancel': ['nourl', false],
    'r3-dispatch-blank-device-eui': ['blank-eui', false], 'r3-q3-claim-empty-device-eui': ['empty-eui', false, ['legacy', 'scoped']],
    'r4-dispatch-uplink-field-tester': ['fieldtester', false],
    'devices-scoped': [null, true, ['scoped']], 'r7-auth-utf8-scoped': [null, true], 'r5-conn-snapshot-key': [null, false, ['legacy', 'scoped']],
    'timed-open': [null, false, ['legacy']], 'connect-blank-eui-fresh': [null, false],
  };
  for (const [name, [profile, scoped, modes]] of Object.entries(expect)) {
    assert.ok(names.has(name), 'no scenario named ' + name);
    const e = probeEnv(name);
    assert.equal(e.profile, profile, name);
    assert.equal(e.scoped, scoped, name);
    if (modes) assert.deepEqual(e.modes, modes, name);
    assert.equal(Boolean(e.oracleNode), Boolean(profile), name);
  }
  for (const name of DUAL) assert.ok(names.has(name), 'DUAL lists a missing scenario: ' + name);
  // noapp unsets the variable (Node's spawn drops undefined values).
  assert.ok('CHIRPSTACK_APP_ACTUATORS' in probeEnv('rd-noapp-manual').goEnv);
  assert.equal(probeEnv('rd-noapp-manual').goEnv.CHIRPSTACK_APP_ACTUATORS, undefined);
});

let runtime = false;
try {
  const { pinned } = oracleExecutable();
  const node = path.join(process.env.HOME || '', '.local/node-v' + pinned + '-linux-x64/bin/node');
  runtime = (process.env.OSI_ORACLE_NODE_REAL || fs.existsSync(node))
    && fs.existsSync(path.join(ROOT, 'scripts/fixtures/release-smoke/node_modules/node-red-node-sqlite/sqlite.js')) ? (process.env.OSI_ORACLE_NODE_REAL || node) : false;
} catch { runtime = false; }
const skip = runtime ? false : 'needs the release-smoke Node and `npm ci --prefix scripts/fixtures/release-smoke`';

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || process.cwd(), 'probe-env-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the boot runner repairs a database before Go starts, with the DEVICE_EUI Go gets', { skip }, (t) => {
  const dir = scratch(t);
  const db = path.join(dir, 'farming.db');
  const seed = spawnSync(runtime, ['scripts/build-seed-db.js', '--out', db], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(seed.status, 0, seed.stderr);
  const w = new DatabaseSync(db);
  w.exec("INSERT INTO users(id, username, password_hash, created_at) VALUES (1, 'farmer', 'x', '2026-11-23T06:00:00.000Z');"
    + "INSERT INTO irrigation_zones(id, name, user_id, timezone, gateway_device_eui, created_at, updated_at)"
    + " VALUES (1, 'Zone 1', 1, 'UTC', NULL, '2026-11-23T06:00:00.000Z', '2026-11-23T06:00:00.000Z');");
  w.close();
  assert.ok(runBootRunner(dir, db, '0016C001F1000001') <= 1);
  const r = new DatabaseSync(db, { readOnly: true });
  assert.equal(r.prepare('SELECT gateway_device_eui AS g FROM irrigation_zones WHERE id = 1').get().g, '0016C001F1000001');
  r.close();
  assert.match(fs.readFileSync(path.join(dir, 'boot-runner.log'), 'utf8'), /done exit=[01]/);
});

test('a runner refusal refuses the start', { skip }, (t) => {
  const dir = scratch(t);
  const db = path.join(dir, 'empty.db');
  fs.writeFileSync(db, '');
  assert.throws(() => runBootRunner(dir, db, '0016C001F1000001'), /boot runner exit 2/);
});
