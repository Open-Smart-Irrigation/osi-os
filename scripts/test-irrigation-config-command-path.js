#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repo = path.resolve(__dirname, '..');
const profiles = [
  'conf/full_raspberrypi_bcm27xx_bcm2712',
  'conf/full_raspberrypi_bcm27xx_bcm2709',
];
const moduleName = 'osi-irrigation-config-commands';

function nodeRedPath(profile, ...parts) {
  return path.join(repo, profile, 'files/usr/share/node-red', ...parts);
}

test('irrigation config helper is registered on every runtime surface', () => {
  const deploy = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  for (const profile of profiles) {
    const packageJson = JSON.parse(
      fs.readFileSync(nodeRedPath(profile, 'package.json'), 'utf8')
    );
    const packageLock = JSON.parse(
      fs.readFileSync(nodeRedPath(profile, 'package-lock.json'), 'utf8')
    );
    const osiLib = require(nodeRedPath(profile, 'osi-lib'));
    const seed = fs.readFileSync(
      path.join(repo, profile, 'files/etc/uci-defaults/98_osi_node_red_seed'),
      'utf8'
    );
    assert.equal(
      packageJson.dependencies[moduleName],
      `file:${moduleName}`
    );
    assert.equal(
      packageLock.packages[''].dependencies[moduleName],
      `file:${moduleName}`
    );
    assert.ok(packageLock.packages[`node_modules/${moduleName}`]);
    assert.equal(
      osiLib.NAME_TO_PATH['irrigation-config-commands'],
      moduleName
    );
    assert.match(seed, new RegExp(`for module in [^\\n]*${moduleName}`));
  }
  assert.match(
    deploy,
    /\/srv\/node-red\/osi-irrigation-config-commands\/package\.json/
  );
  assert.match(
    deploy,
    /\/srv\/node-red\/osi-irrigation-config-commands\/index\.js/
  );
});

test('maintained profiles carry byte-identical helper and ledger sources', () => {
  for (const relative of [
    `${moduleName}/index.js`,
    `${moduleName}/index.test.js`,
    `${moduleName}/package.json`,
    'osi-command-ledger/index.js',
    'osi-command-ledger/index.test.js',
  ]) {
    assert.deepEqual(
      fs.readFileSync(nodeRedPath(profiles[0], relative)),
      fs.readFileSync(nodeRedPath(profiles[1], relative)),
      relative
    );
  }
});

test('helper exposes only protected irrigation config dispatch', () => {
  const helper = require(nodeRedPath(profiles[0], moduleName));
  assert.deepEqual(
    [...helper.TYPES].sort(),
    ['UPSERT_SCHEDULE', 'UPSERT_ZONE_IRRIGATION_CALIBRATION']
  );
  assert.equal(typeof helper.applyIrrigationConfigCommand, 'function');
});
