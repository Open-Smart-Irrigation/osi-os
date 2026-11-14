#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
async function verifyProfile(profile) {
  const payloadRoot = path.join(root, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share`);
  const flows = JSON.parse(fs.readFileSync(path.join(payloadRoot, 'flows.json'), 'utf8'));
  const modulesRoot = path.join(payloadRoot, 'node-red');
  const registry = require(path.join(modulesRoot, 'osi-lib')).NAME_TO_PATH;
  const installation = require(path.join(modulesRoot, registry.installation));

  function node(name) {
    const found = flows.find((candidate) => candidate.name === name);
    assert(found, `missing ${name}`);
    return found;
  }

  function includes(name, text) {
    const source = name === 'Handle server auth response'
      ? installation.requestAlLinkHandleAuth.toString()
      : node(name).func || '';
    assert.match(source, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${name}: ${text}`);
  }

  const authResponse = node('Handle server auth response');
  assert.equal(authResponse.libs.some((lib) => lib.var === 'osiLib' && lib.module === 'osi-lib'), true);
  assert.match(authResponse.func, /const load = osiLib\.require\('installation'\);/);
  assert.match(authResponse.func, /return load\.value\.requestAlLinkHandleAuth\(\{msg,node,global,env,osiLib,osiDb\}\);/);
  assert.equal(typeof installation.requestAlLinkHandleAuth, 'function');

  includes('Build server auth request', 'installation_recovery_v1');
  includes('Build server auth request', 'installationUuid');
  includes('Build server auth request', 'INSERT OR IGNORE INTO installation_identity');
  includes('Handle server auth response', 'installation identity mismatch');
  includes('Handle server auth response', 'offlineVerifierVersion');
  includes('Finalize linked account state', 'installation_uuid');
  includes('Process Result', 'server_offline_verifier_version');
  includes('Process Result', 'installation_uuid');
  includes('Build Cloud Bootstrap', 'installationUuid');
  includes('Build Cloud Bootstrap', 'INSERT OR IGNORE INTO installation_identity');
  includes('Build Cloud Bootstrap', 'recoveryOperationUuid');
  includes('Build Sync State', 'recoveryState');

  assert.equal(node('Build server auth request').libs.some((lib) => lib.var === 'osiLib'), true);
  assert.equal(node('Process Result').libs.some((lib) => lib.var === 'osiLib'), true);

  // Execute the shipped delegation and real exported handler. A mismatched
  // identity must leave on the error output before any database is opened.
  const msg = {
    statusCode: 200,
    _alLinkUnfenced: true,
    _alLinkContext: { installation_uuid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    payload: { installationUuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
  };
  const execute = new Function('msg', 'node', 'global', 'env', 'osiLib', 'osiDb', authResponse.func);
  const result = await execute(msg, {}, {}, {}, {
    require(name) { assert.equal(name, 'installation'); return { ok: true, value: installation }; },
  }, { Database() { assert.fail('identity mismatch must not open a database'); } });
  assert.equal(result[0], null);
  assert.equal(result[1], msg);
  assert.equal(msg.statusCode, 502);
  assert.equal(msg.payload.reason, 'installation_identity_mismatch');
  console.log(`OK ${profile} installation recovery flow contract and identity mismatch refusal`);
}

(async () => {
  for (const profile of ['bcm2712', 'bcm2709']) await verifyProfile(profile);
})().catch((error) => { console.error(error); process.exitCode = 1; });
