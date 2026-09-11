'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { computeFetchList, extractCallSites, countCallSiteTokens } = require('./deploy-fetch-list.js');

const REPO_ROOT = path.resolve(__dirname, '..');

test('computeFetchList sees every fetch/fetch_required call-site token in deploy.sh', () => {
  const deployText = fs.readFileSync(path.join(REPO_ROOT, 'deploy.sh'), 'utf8');
  const sites = extractCallSites(deployText);
  assert.equal(sites.length, countCallSiteTokens(deployText));
  assert.ok(sites.length > 50, 'expected dozens of fetch call sites in deploy.sh');
});

test('computeFetchList expands the CHECKSUMS.json-driven migration loop', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'database/migrations/ordered/CHECKSUMS.json'), 'utf8')
  );
  const migrationNames = Object.keys(manifest).sort();
  const list = computeFetchList(REPO_ROOT);
  for (const name of migrationNames) {
    assert.ok(
      list.includes(`database/migrations/ordered/${name}`),
      `expected migration ${name} in fetch list`
    );
  }
  assert.equal(
    list.filter((p) => p.startsWith('database/migrations/ordered/') && p.endsWith('.sql')).length,
    migrationNames.length
  );
});

test('computeFetchList expands the static script/module loops', () => {
  const list = computeFetchList(REPO_ROOT);
  for (const script of ['baseline-existing-db.js', 'repair-sync-outbox-v2.js', 'migrate-cli.js', 'semantic-schema-compare.js']) {
    assert.ok(list.includes(`scripts/${script}`), `expected scripts/${script}`);
  }
  for (const module_ of ['backup.js', 'fingerprints.js', 'index.js', 'ledger.js', 'migrations-loader.js', 'runner-iface.js', 'runner.js', 'sql-normalize.js']) {
    assert.ok(list.includes(`lib/osi-migrate/${module_}`), `expected lib/osi-migrate/${module_}`);
  }
});

test('computeFetchList expands the seed DB model-detection branches', () => {
  const list = computeFetchList(REPO_ROOT);
  for (const profile of ['bcm2712', 'bcm2709', 'bcm2708']) {
    assert.ok(
      list.some((p) => p.includes(`full_raspberrypi_bcm27xx_${profile}/files/usr/share/db/farming.db`)),
      `expected a ${profile} seed DB path`
    );
  }
});

test('computeFetchList includes known always-fetched files', () => {
  const list = computeFetchList(REPO_ROOT);
  for (const known of [
    'feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js',
    'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init',
    'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
    'react_gui.tar.gz',
    'scripts/chirpstack-bootstrap.js',
    'scripts/deploy-payload-swap.js',
    'scripts/verify-communication-contract.js',
    'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/cloud-commands.js',
  ]) {
    assert.ok(list.includes(known), `expected ${known} in fetch list`);
  }
});

test('computeFetchList never returns a variable-shaped (unexpanded) path', () => {
  const list = computeFetchList(REPO_ROOT);
  for (const p of list) {
    assert.ok(!p.includes('$'), `unexpanded variable leaked into fetch list: ${p}`);
  }
});

test('computeFetchList returns only distinct, sorted paths', () => {
  const list = computeFetchList(REPO_ROOT);
  const dedup = Array.from(new Set(list)).sort();
  assert.deepEqual(list, dedup);
});

test('every path computeFetchList returns exists in the repo, except the built GUI bundle', () => {
  // react_gui.tar.gz is a build artifact (never checked in); deploy-bundle.sh
  // requires the caller to supply an already-built one (see its own tests).
  const list = computeFetchList(REPO_ROOT).filter((p) => p !== 'react_gui.tar.gz');
  const missing = list.filter((p) => !fs.existsSync(path.join(REPO_ROOT, p)));
  assert.deepEqual(missing, []);
});
