#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

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

function includes(name, text) {
  assert.match(node(name).func || '', new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${name}: ${text}`);
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
