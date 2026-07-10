'use strict';
// Co-located tests for osi-lib (refactor-program 1.A1, spec §B).
// Env overrides MUST be set before the module is first required —
// BASE/COOLDOWN_MS are read once at load.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const FIXTURE_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-lib-test-'));
process.env.OSI_LIB_BASE = FIXTURE_BASE;
process.env.OSI_LIB_COOLDOWN_MS = '80';

const osiLib = require('./index');

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

test('NAME_TO_PATH is exported and lists the two launch entries', () => {
  assert.deepEqual(Object.keys(osiLib.NAME_TO_PATH).sort(), [
    'agroscope-uplink-transform',
    'history-sync',
  ]);
  assert.equal(osiLib.NAME_TO_PATH['history-sync'], 'osi-history-sync-helper');
  assert.equal(osiLib.NAME_TO_PATH['agroscope-uplink-transform'], 'codecs/agroscope_uplink_transform');
});

test('unknown name returns a typed failure, never throws', () => {
  const r = osiLib.require('no-such-module');
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown osi-lib module: no-such-module/);
});

test('load success returns the module and caches it', () => {
  fs.writeFileSync(path.join(FIXTURE_BASE, 'osi-history-sync-helper.js'),
    "module.exports = { marker: 'v1' };\n");
  const first = osiLib.require('history-sync');
  assert.equal(first.ok, true);
  assert.equal(first.value.marker, 'v1');
  // Overwrite on disk; the cached module must keep serving (success is cached).
  fs.writeFileSync(path.join(FIXTURE_BASE, 'osi-history-sync-helper.js'),
    "module.exports = { marker: 'v2' };\n");
  const second = osiLib.require('history-sync');
  assert.equal(second.ok, true);
  assert.equal(second.value.marker, 'v1');
});

test('load failure -> cooldown quarantine -> retry succeeds after expiry', async () => {
  // codecs/agroscope_uplink_transform does not exist yet in the fixture base.
  const first = osiLib.require('agroscope-uplink-transform');
  assert.equal(first.ok, false);
  assert.equal(first.quarantined, undefined); // a real load attempt, not a cooldown skip
  assert.match(first.error, /Cannot find module/);
  // Immediately again: cooldown must answer without re-attempting the fs load.
  const during = osiLib.require('agroscope-uplink-transform');
  assert.equal(during.ok, false);
  assert.equal(during.quarantined, true);
  assert.match(during.error, /quarantined, retry after cooldown/);
  // Fix the underlying cause, wait out the 80 ms test cooldown, retry succeeds.
  fs.mkdirSync(path.join(FIXTURE_BASE, 'codecs'), { recursive: true });
  fs.writeFileSync(path.join(FIXTURE_BASE, 'codecs', 'agroscope_uplink_transform.js'),
    "module.exports = { toAgroscopeUplink: () => null };\n");
  await sleep(120);
  const after = osiLib.require('agroscope-uplink-transform');
  assert.equal(after.ok, true);
  assert.equal(typeof after.value.toAgroscopeUplink, 'function');
});

test('result-object shape: success has ok+value only; failure has ok+error', () => {
  const ok = osiLib.require('history-sync');
  assert.deepEqual(Object.keys(ok).sort(), ['ok', 'value']);
  const bad = osiLib.require('no-such-module');
  assert.deepEqual(Object.keys(bad).sort(), ['error', 'ok']);
});
