#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { assertNewEvidencePath, writeEvidence } = require('./lib/x3-evidence-writer');
const { LEGACY, PROFILES, share, execute } = require('./lib/x3-zone-env-harness');
const { adaptNode, METHODS } = require('./x3-zone-env-adapters');

test('evidence destinations cannot replace files, hard links or symbolic links', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x3-evidence-'));
  try {
    const original = path.join(dir, 'oracle');
    fs.writeFileSync(original, 'frozen');
    fs.linkSync(original, path.join(dir, 'hard'));
    fs.symlinkSync(original, path.join(dir, 'link'));
    fs.symlinkSync(path.join(dir, 'absent'), path.join(dir, 'dangling'));
    for (const name of ['oracle', 'hard', 'link', 'dangling']) {
      assert.throws(() => assertNewEvidencePath(path.join(dir, name)), { code: 'EEXIST' });
      assert.throws(() => writeEvidence(path.join(dir, name), {}), { code: 'EEXIST' });
    }
    assert.equal(fs.readFileSync(original, 'utf8'), 'frozen');
    const fresh = path.join(dir, 'fresh');
    assertNewEvidencePath(fresh);
    writeEvidence(fresh, { before: 0, after: null });
    assert.deepEqual(JSON.parse(fs.readFileSync(fresh)), { before: 0, after: null });
    assert.throws(() => writeEvidence(fresh, {}), { code: 'EEXIST' });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('X3_EVIDENCE targeting the original oracle fails before parity and leaves all bytes intact', () => {
  const oracle = path.join(__dirname, 'fixtures/x3-zone-env/expected.json');
  const before = fs.readFileSync(oracle);
  const child = spawnSync(process.execPath, ['scripts/test-x3-zone-env-parity.js', '--verify'], {
    encoding: 'utf8', env: { ...process.env, X3_EVIDENCE: oracle },
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Evidence destination already exists/);
  assert.ok(fs.readFileSync(oracle).equals(before));
});

for (const profile of PROFILES) for (const failed of ['http-facade', 'run-projection']) {
  test(profile + ': failed ' + failed + ' does not quarantine the existing zone-env package', () => {
    const root = path.join(share(profile), 'node-red');
    const child = spawnSync(process.execPath, ['-e', `
      const assert=require('node:assert/strict'),Module=require('node:module'),path=require('node:path');
      const load=Module._load,root=process.argv[1];
      Module._load=function(name,parent,...args){
        if(parent?.filename.startsWith(path.join(root,'osi-zone-env')) && name==='./'+process.argv[2]) throw new Error('fixture extraction dependency failed');
        return load.call(this,name,parent,...args);
      };
      const osiLib=require(path.join(root,'osi-lib'));
      const first=osiLib.require('zone-env');
      assert.equal(first.ok,true,first.error);
      assert.equal(first.value.round(0,2),0);
      assert.equal(first.value.toFiniteNumber(null),null);
      assert.throws(()=>first.value[process.argv[2]==='http-facade'?'environmentSummary':'todayLiters'],/fixture extraction dependency failed/);
      const second=osiLib.require('zone-env');
      assert.equal(second.ok,true);assert.equal(second.quarantined,undefined);
      assert.equal(second.value,first.value);assert.equal(second.value.mean([0,2]),1);
    `, root, failed], { encoding: 'utf8', env: { ...process.env, OSI_LIB_BASE: root } });
    assert.equal(child.status, 0, child.stdout + child.stderr);
  });
}

for (const profile of PROFILES) test(profile + ': failed lazy entry point keeps the approved 503 and legacy early replies', async () => {
  for (const source of LEGACY) {
    const api = require(path.join(share(profile), 'node-red/osi-zone-env'));
    const method = METHODS[source.id];
    const original = Object.getOwnPropertyDescriptor(api, method);
    try {
      Object.defineProperty(api, method, { configurable: true, get() { throw new Error('fixture lazy entry unavailable'); } });
      const adapter = adaptNode(source);
      const failed = await execute(profile, adapter, { node: source.id });
      const message = Array.isArray(failed.result) ? failed.result.find(Boolean) : failed.result;
      assert.equal(failed.thrown, undefined);
      assert.equal(message.statusCode, 503);
      assert.deepEqual(message.payload, source.id === 'zone-env-fn' ? { error: 'module_unavailable', module: 'zone-env', message: 'fixture lazy entry unavailable' } : { message: 'Internal error' });
      assert.equal(failed.closes, source.id === 'zone-env-fn' ? 1 : 0);
      assert.equal(failed.diagnostics.filter(d => d.kind === 'error').length, 1);
      if (source.id === 'strega-today-liters-fn' || source.id === 'get-actuations-query') {
        const early = await execute(profile, adapter, { node: source.id, auth: 'missing', noUser: true });
        const response = Array.isArray(early.result) ? early.result.find(Boolean) : early.result;
        assert.equal(response.statusCode, 401);
        assert.equal(early.diagnostics.filter(d => d.kind === 'error').length, 0);
      }
    } finally { Object.defineProperty(api, method, original); }
  }
});
