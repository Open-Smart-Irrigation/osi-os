'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { collectHelperNames, checkSurfaces, checkCodecs } = require('./verify-helper-registration');

const NAME_TO_PATH = {
  'history-sync': 'osi-history-sync-helper',
  'agroscope-uplink-transform': 'codecs/agroscope_uplink_transform',
};

function fixtures(overrides = {}) {
  return {
    name: 'osi-history-sync-helper',
    packageJson: { dependencies: { 'osi-history-sync-helper': 'file:osi-history-sync-helper' } },
    packageLock: { packages: {
      '': { dependencies: { 'osi-history-sync-helper': 'file:osi-history-sync-helper' } },
      'node_modules/osi-history-sync-helper': { resolved: 'osi-history-sync-helper', link: true },
      'osi-history-sync-helper': { version: '1.0.0' },
    } },
    seedSource: 'for module in osi-db-helper osi-history-sync-helper osi-lib; do\n',
    deploySource: [
      '"/srv/node-red/osi-history-sync-helper/package.json"',
      '"/srv/node-red/osi-history-sync-helper/index.js"',
    ].join('\n'),
    moduleDir: { hasDir: true, hasPackageJson: true, hasMain: true, mainName: 'index.js' },
    ...overrides,
  };
}

test('collectHelperNames: unions file: deps with non-codec NAME_TO_PATH values', () => {
  const names = collectHelperNames({
    packageJson: { dependencies: { bcryptjs: '3.0.3', 'osi-db-helper': 'file:osi-db-helper' } },
    nameToPath: NAME_TO_PATH,
  });
  assert.deepEqual(names, ['osi-db-helper', 'osi-history-sync-helper']); // codec entry excluded
});

test('checkSurfaces: fully registered helper produces no issues', () => {
  assert.deepEqual(checkSurfaces(fixtures()), []);
});

test('checkSurfaces: each missing surface is reported', () => {
  assert.match(checkSurfaces(fixtures({ packageJson: { dependencies: {} } })).join(' '), /runtime package\.json/);
  assert.match(checkSurfaces(fixtures({ packageLock: { packages: { '': { dependencies: {} } } } })).join(' '), /package-lock\.json/);
  assert.match(checkSurfaces(fixtures({ seedSource: 'for module in osi-db-helper; do\n' })).join(' '), /98_osi_node_red_seed/);
  assert.match(checkSurfaces(fixtures({ deploySource: '' })).join(' '), /deploy\.sh/);
  assert.match(checkSurfaces(fixtures({ moduleDir: { hasDir: false } })).join(' '), /directory missing/);
  assert.match(checkSurfaces(fixtures({ moduleDir: { hasDir: true, hasPackageJson: false, hasMain: true, mainName: 'index.js' } })).join(' '), /package\.json missing/);
  assert.match(checkSurfaces(fixtures({ moduleDir: { hasDir: true, hasPackageJson: true, hasMain: false, mainName: 'index.js' } })).join(' '), /main file/);
});

test('checkCodecs: codec entries need a deploy.sh fetch line + the file on disk', () => {
  const issues = checkCodecs({ nameToPath: NAME_TO_PATH, deploySource: '', codecsDir: '/nonexistent' });
  assert.equal(issues.length, 2);
  assert.match(issues[0], /agroscope_uplink_transform\.js.*deploy\.sh/);
  assert.match(issues[1], /agroscope_uplink_transform\.js.*missing under/);
});
