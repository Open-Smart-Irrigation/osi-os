'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkSyncOpParity, extractServerOps } = require('./verify-sync-op-parity');

const ROOT = path.resolve(__dirname, '..');
const SERVER_SOURCE_CANDIDATES = [
  process.env.OSI_SERVER_EDGE_SYNC_SERVICE,
  '/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java',
  '/home/phil/Repos/osi-server/.worktrees/sync-contract-tranche-a/backend/src/main/java/org/osi/server/sync/EdgeSyncService.java',
].filter(Boolean);
const SERVER_SOURCE = SERVER_SOURCE_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ||
  SERVER_SOURCE_CANDIDATES[0];

function copyFixtureTree() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-op-parity-'));
  const schemaDir = path.join(tmp, 'docs/contracts/sync-schema');
  const flow2712Dir = path.join(tmp, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share');
  const flow2709Dir = path.join(tmp, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share');
  const serverDir = path.join(tmp, 'server');
  fs.mkdirSync(schemaDir, { recursive: true });
  fs.mkdirSync(flow2712Dir, { recursive: true });
  fs.mkdirSync(flow2709Dir, { recursive: true });
  fs.mkdirSync(serverDir, { recursive: true });

  fs.copyFileSync(
    path.join(ROOT, 'docs/contracts/sync-schema/events.schema.json'),
    path.join(schemaDir, 'events.schema.json')
  );
  fs.copyFileSync(
    path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'),
    path.join(flow2712Dir, 'flows.json')
  );
  fs.copyFileSync(
    path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json'),
    path.join(flow2709Dir, 'flows.json')
  );
  fs.copyFileSync(SERVER_SOURCE, path.join(serverDir, 'EdgeSyncService.java'));
  return tmp;
}

test('parity check reports a bogus flow op', () => {
  const fixtureRoot = copyFixtureTree();
  const flowPath = path.join(fixtureRoot, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
  const flow = fs.readFileSync(flowPath, 'utf8').replace('DEVICE_DATA_APPENDED', 'BOGUS_TEST_OP');
  fs.writeFileSync(flowPath, flow);

  const result = checkSyncOpParity({
    root: fixtureRoot,
    serverSource: path.join(fixtureRoot, 'server/EdgeSyncService.java'),
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /BOGUS_TEST_OP/);
  assert.match(result.message, /flows:bcm2712/);
});

test('parity check reports event payloads missing contract_version', () => {
  const fixtureRoot = copyFixtureTree();
  const flowPath = path.join(fixtureRoot, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
  const flow = fs.readFileSync(flowPath, 'utf8').replace(/'contract_version', 1,\s*/, '');
  fs.writeFileSync(flowPath, flow);

  const result = checkSyncOpParity({
    root: fixtureRoot,
    serverSource: path.join(fixtureRoot, 'server/EdgeSyncService.java'),
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /payload_json missing contract_version/);
  assert.match(result.message, /flows:bcm2712/);
});

test('server extractor reads all applyEvent switch labels', () => {
  const result = extractServerOps(SERVER_SOURCE);

  assert.deepEqual(result.errors, []);
  assert(result.ops.includes('DEVICE_ASSIGNED'));
  assert(result.ops.includes('ZONE_CONFIG_UPSERTED'));
  assert(result.ops.includes('ZONE_LOCATION_UPSERTED'));
});
