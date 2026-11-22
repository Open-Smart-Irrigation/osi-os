#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { accountStageSource } = require('./lib/installation-osi-lib');

const root = path.resolve(__dirname, '..');
const flows = JSON.parse(fs.readFileSync(
  path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'),
  'utf8'
));

function node(name) {
  const found = flows.find((candidate) => candidate.name === name);
  assert(found, `missing ${name}`);
  return found;
}

// The account-link stages moved into the installation helper (EB2); their
// nodes only delegate. Read those stages where they now live.
const ACCOUNT_STAGES = {
  'Build server auth request': ['build', 'accountLink_build'],
  'Handle server auth response': ['handle', 'accountLink_handle'],
  'Finalize linked account state': ['finalize', 'accountLink_finalize'],
};

function source(name) {
  const found = node(name);
  const stage = ACCOUNT_STAGES[name];
  return stage ? accountStageSource(flows, 'bcm2712', found.id, stage[0], stage[1]) : found.func || '';
}

function includes(name, text) {
  assert.match(source(name), new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${name}: ${text}`);
}

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

console.log('OK installation recovery flow contract');
