'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { checkSyncOpParity, extractFlowOps, extractServerOps } = require('./verify-sync-op-parity');

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
    sqlSources: [],
    databaseSources: [],
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
    sqlSources: [],
    databaseSources: [],
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

test('server extractor ignores non-case quoted constants in applyEvent', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-op-server-'));
  const fixture = path.join(tmp, 'EdgeSyncService.java');
  const source = fs.readFileSync(SERVER_SOURCE, 'utf8').replace(
    'private void applyEvent(String gatewayDeviceEui, SyncEventRecord event) {',
    'private void applyEvent(String gatewayDeviceEui, SyncEventRecord event) {\n        String ignoredForParity = "BOGUS_NON_CASE_OP";'
  );
  fs.writeFileSync(fixture, source);

  const result = extractServerOps(fixture);

  assert.deepEqual(result.errors, []);
  assert.equal(result.ops.includes('BOGUS_NON_CASE_OP'), false);
});

test('server extractor ignores commented-out case labels inside applyEvent switch', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-op-server-'));
  const fixture = path.join(tmp, 'EdgeSyncService.java');
  const source = fs.readFileSync(SERVER_SOURCE, 'utf8').replace(
    /switch\s*\(\s*event\.op\(\)\s*\)\s*\{/,
    `switch (event.op()) {
            // case "BOGUS_COMMENTED_CASE" -> applyBogus(event);
            /*
             * case "BOGUS_BLOCK_COMMENTED_CASE" -> applyBogus(event);
             */`
  );
  fs.writeFileSync(fixture, source);

  const result = extractServerOps(fixture);

  assert.deepEqual(result.errors, []);
  assert.equal(result.ops.includes('BOGUS_COMMENTED_CASE'), false);
  assert.equal(result.ops.includes('BOGUS_BLOCK_COMMENTED_CASE'), false);
});

test('flow extractor handles lowercase and multiline sync_outbox inserts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-op-flow-'));
  const flowPath = path.join(tmp, 'flows.json');
  fs.writeFileSync(flowPath, JSON.stringify([
    {
      id: 'fixture',
      name: 'Lowercase insert fixture',
      type: 'function',
      func: `
msg.topic = \`insert
  into sync_outbox
    (event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at)
  values
    ('evt-1', 'DEVICE_DATA', 'device-1', 'DEVICE_DATA_APPENDED', json_object('contract_version', 1), 1, '2026-07-05T00:00:00Z')\`;
return msg;
`
    }
  ]));

  const result = extractFlowOps(flowPath);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.payloadsMissingContractVersion, []);
  assert.deepEqual(result.ops, ['DEVICE_DATA_APPENDED']);
});

test('flow extractor rejects nested-only contract_version payloads', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-op-flow-'));
  const flowPath = path.join(tmp, 'flows.json');
  fs.writeFileSync(flowPath, JSON.stringify([
    {
      id: 'fixture',
      name: 'Nested contract fixture',
      type: 'function',
      func: `
msg.topic = \`INSERT INTO sync_outbox
  (event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at)
VALUES
  ('evt-1', 'DEVICE_DATA', 'device-1', 'DEVICE_DATA_APPENDED', json_object('user', json_object('contract_version', 1)), 1, '2026-07-05T00:00:00Z')\`;
return msg;
`
    }
  ]));

  const result = extractFlowOps(flowPath);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.ops, ['DEVICE_DATA_APPENDED']);
  assert.equal(result.payloadsMissingContractVersion.length, 1);
  assert.match(result.payloadsMissingContractVersion[0], /Nested contract fixture/);
});

test('parity check reports seed SQL trigger payloads missing contract_version', () => {
  const fixtureRoot = copyFixtureTree();
  const databaseDir = path.join(fixtureRoot, 'database');
  fs.mkdirSync(databaseDir, { recursive: true });
  const seedPath = path.join(databaseDir, 'seed-blank.sql');
  fs.writeFileSync(seedPath, `
CREATE TRIGGER trg_fixture_seed
AFTER INSERT ON device_data
FOR EACH ROW
BEGIN
  INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at)
  VALUES ('evt-1', 'DEVICE_DATA', 'device-1', 'DEVICE_DATA_APPENDED', json_object('device_eui', NEW.deveui), 1, '2026-07-05T00:00:00Z');
END;
`);

  const result = checkSyncOpParity({
    root: fixtureRoot,
    serverSource: path.join(fixtureRoot, 'server/EdgeSyncService.java'),
    sqlSources: [{ name: 'seed-sql:fixture', path: seedPath }],
    databaseSources: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /seed-sql:fixture/);
  assert.match(result.message, /payload_json missing contract_version/);
});

test('parity check reports bundled DB trigger payloads missing contract_version', () => {
  const fixtureRoot = copyFixtureTree();
  const dbPath = path.join(fixtureRoot, 'fixture.db');
  execFileSync('sqlite3', [dbPath], {
    input: `
CREATE TABLE device_data(deveui TEXT, recorded_at TEXT);
CREATE TABLE sync_outbox(
  event_uuid TEXT,
  aggregate_type TEXT,
  aggregate_key TEXT,
  op TEXT,
  payload_json TEXT,
  sync_version INTEGER,
  occurred_at TEXT
);
CREATE TRIGGER trg_fixture_db
AFTER INSERT ON device_data
FOR EACH ROW
BEGIN
  INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at)
  VALUES ('evt-1', 'DEVICE_DATA', 'device-1', 'DEVICE_DATA_APPENDED', json_object('device_eui', NEW.deveui), 1, '2026-07-05T00:00:00Z');
END;
`,
    encoding: 'utf8',
  });

  const result = checkSyncOpParity({
    root: fixtureRoot,
    serverSource: path.join(fixtureRoot, 'server/EdgeSyncService.java'),
    sqlSources: [],
    databaseSources: [{ name: 'db:fixture', path: dbPath }],
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /db:fixture/);
  assert.match(result.message, /payload_json missing contract_version/);
});
