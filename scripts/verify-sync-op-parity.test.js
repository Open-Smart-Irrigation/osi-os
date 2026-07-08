'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { checkSyncOpParity, extractFlowOps, extractServerOps } = require('./verify-sync-op-parity');

const ROOT = path.resolve(__dirname, '..');
const SERVER_RELATIVE_SOURCE = path.join('backend', 'src', 'main', 'java', 'org', 'osi', 'server', 'sync', 'EdgeSyncService.java');
const SERVER_SOURCE_CANDIDATES = [
  process.env.OSI_SERVER_EDGE_SYNC_SERVICE
    ? (path.isAbsolute(process.env.OSI_SERVER_EDGE_SYNC_SERVICE)
      ? process.env.OSI_SERVER_EDGE_SYNC_SERVICE
      : path.resolve(ROOT, process.env.OSI_SERVER_EDGE_SYNC_SERVICE))
    : null,
  path.resolve(ROOT, '..', '..', '..', 'osi-server', '.worktrees', path.basename(ROOT), SERVER_RELATIVE_SOURCE),
  path.resolve(ROOT, '..', 'osi-server', SERVER_RELATIVE_SOURCE),
  path.resolve(ROOT, '..', '..', '..', 'osi-server', SERVER_RELATIVE_SOURCE),
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

function writeServerFixture(source) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-op-server-'));
  const fixture = path.join(tmp, 'EdgeSyncService.java');
  fs.writeFileSync(fixture, source);
  return fixture;
}

function createSeedBlankDb() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-op-seed-db-'));
  const dbPath = path.join(tmp, 'farming.db');
  execFileSync('sqlite3', ['-bail', dbPath], {
    input: fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'),
    encoding: 'utf8',
  });
  return dbPath;
}

function sqliteExec(dbPath, sql) {
  execFileSync('sqlite3', ['-bail', dbPath], { input: sql, encoding: 'utf8' });
}

function sqliteJson(dbPath, sql) {
  const output = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' }).trim();
  return output ? JSON.parse(output) : [];
}

function installLinkedUser(dbPath) {
  sqliteExec(dbPath, `
INSERT INTO users(username, password_hash, created_at, updated_at, user_uuid)
VALUES ('sync-op-test-user', 'hash', '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z', 'sync-op-user-uuid');

INSERT INTO sync_link_state(peer_node, linked, server_url, cloud_user_id, gateway_device_eui, updated_at)
VALUES ('cloud', 1, 'https://sync.test.invalid', 'cloud-user-1', '0016C001F11715E2', '2026-07-06T00:00:00Z')
ON CONFLICT(peer_node) DO UPDATE SET
  linked = excluded.linked,
  server_url = excluded.server_url,
  cloud_user_id = excluded.cloud_user_id,
  gateway_device_eui = excluded.gateway_device_eui,
  updated_at = excluded.updated_at;
`);
}

function createZone(dbPath, label) {
  const safeLabel = label.replace(/[^a-z0-9_]/gi, '_');
  sqliteExec(dbPath, `
INSERT INTO irrigation_zones(
  name, user_id, created_at, updated_at, timezone, zone_uuid, gateway_device_eui,
  sync_version, area_m2, irrigation_efficiency_pct, scheduling_mode,
  latitude, longitude, phenological_stage, calibration_key, crop_type,
  variety, soil_type, irrigation_method, notes, prediction_card_enabled
)
VALUES (
  'Zone ${safeLabel}', 1, '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z', 'UTC',
  'zone-${safeLabel}', '0016C001F11715E2', 1, 1000, 85, 'local',
  47.0001, 8.0001, 'default', 'default', 'wheat',
  'standard', 'loam', 'drip', 'initial notes', 0
);
DELETE FROM sync_outbox;
`);
  return sqliteJson(dbPath, "SELECT id FROM irrigation_zones WHERE zone_uuid = 'zone-" + safeLabel + "';")[0].id;
}

function assertZoneUpdateOp(dbPath, zoneId, updateSet, expectedOp) {
  sqliteExec(dbPath, `
DELETE FROM sync_outbox;
UPDATE irrigation_zones
SET ${updateSet}, updated_at = '2026-07-06T00:01:00Z'
WHERE id = ${zoneId};
`);
  const rows = sqliteJson(dbPath, 'SELECT op FROM sync_outbox ORDER BY rowid;');
  assert.deepEqual(rows.map((row) => row.op), [expectedOp]);
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

test('server extractor reads canonical applyEvent overload switch labels', () => {
  const fixture = writeServerFixture(`
class EdgeSyncService {
    private boolean applyEvent(String gatewayDeviceEui, SyncEventRecord event, boolean dryRun) {
        Map<String, Object> payload = payloadWithOp(event);
        switch (event.op()) {
            case "DEVICE_DATA_APPENDED" -> {
                if (!dryRun) upsertSensorData(payload);
                return true;
            }
            case "ZONE_UPSERTED", "ZONE_CONFIG_UPSERTED" -> {
                if (!dryRun) upsertZone(payload, gatewayDeviceEui);
                return true;
            }
            default -> {
                if (dryRun) return false;
                throw new IllegalArgumentException("unknown_op: " + event.op());
            }
        }
    }
}
`);

  const result = extractServerOps(fixture);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.ops, ['DEVICE_DATA_APPENDED', 'ZONE_CONFIG_UPSERTED', 'ZONE_UPSERTED']);
});

test('parity check reports runtime dispatch switch missing an op even if an allow list includes it', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-op-parity-'));
  const schemaPath = path.join(fixtureRoot, 'events.schema.json');
  const flowPath = path.join(fixtureRoot, 'flows.json');
  const serverSource = writeServerFixture(`
class EdgeSyncService {
    private static final Set<String> SUPPORTED_EVENT_OPS = Set.of(
            "DEVICE_DATA_APPENDED",
            "ZONE_CONFIG_UPSERTED"
    );

    private boolean applyEvent(String gatewayDeviceEui, SyncEventRecord event, boolean dryRun) {
        Map<String, Object> payload = payloadWithOp(event);
        switch (event.op()) {
            case "DEVICE_DATA_APPENDED" -> {
                if (!dryRun) upsertSensorData(payload);
                return true;
            }
            default -> {
                if (dryRun) return false;
                throw new IllegalArgumentException("unknown_op: " + event.op());
            }
        }
    }
}
`);
  fs.writeFileSync(schemaPath, JSON.stringify({
    type: 'object',
    properties: {
      op: { enum: ['DEVICE_DATA_APPENDED', 'ZONE_CONFIG_UPSERTED'] },
      payload: {
        type: 'object',
        required: ['contract_version'],
        properties: { contract_version: { type: 'integer', const: 1 } },
      },
    },
  }));
  fs.writeFileSync(flowPath, JSON.stringify([
    {
      id: 'fixture',
      name: 'Fixture sync inserts',
      type: 'function',
      func: `
msg.topic = "INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at) VALUES ('evt-1', 'DEVICE_DATA', 'dev-1', 'DEVICE_DATA_APPENDED', json_object('contract_version', 1), 1, '2026-07-05T00:00:00Z')";
node.send(msg);
msg.topic = "INSERT INTO sync_outbox(event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at) VALUES ('evt-2', 'ZONE_CONFIG', 'zone-1', 'ZONE_CONFIG_UPSERTED', json_object('contract_version', 1), 1, '2026-07-05T00:00:01Z')";
return msg;
`,
    },
  ]));

  const result = checkSyncOpParity({
    root: fixtureRoot,
    schemaPath,
    serverSource,
    flowSources: [{ name: 'fixture', path: 'flows.json' }],
    sqlSources: [],
    databaseSources: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.message, /server missing from union: ZONE_CONFIG_UPSERTED/);
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

test('seed zone outbox trigger emits location config structural and delete ops', () => {
  const dbPath = createSeedBlankDb();
  installLinkedUser(dbPath);

  assertZoneUpdateOp(
    dbPath,
    createZone(dbPath, 'location_only'),
    'latitude = 47.1001, longitude = 8.1001',
    'ZONE_LOCATION_UPSERTED'
  );
  assertZoneUpdateOp(
    dbPath,
    createZone(dbPath, 'config_only'),
    "crop_type = 'maize', notes = 'config changed'",
    'ZONE_CONFIG_UPSERTED'
  );
  assertZoneUpdateOp(
    dbPath,
    createZone(dbPath, 'location_and_config'),
    "latitude = 47.2002, crop_type = 'barley'",
    'ZONE_LOCATION_UPSERTED'
  );
  assertZoneUpdateOp(
    dbPath,
    createZone(dbPath, 'structural'),
    "name = 'Renamed structural zone'",
    'ZONE_UPSERTED'
  );
  assertZoneUpdateOp(
    dbPath,
    createZone(dbPath, 'deleted'),
    "deleted_at = '2026-07-06T00:02:00Z'",
    'ZONE_DELETED'
  );
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

test('flow extractor handles INSERT OR IGNORE/REPLACE sync_outbox inserts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-op-flow-'));
  const flowPath = path.join(tmp, 'flows.json');
  fs.writeFileSync(flowPath, JSON.stringify([
    {
      id: 'fixture',
      name: 'Insert conflict fixture',
      type: 'function',
      func: `
msg.topic = \`INSERT OR IGNORE INTO sync_outbox
  (event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at)
VALUES
  ('evt-1', 'DEVICE_DATA', 'device-1', 'DEVICE_DATA_APPENDED', json_object('contract_version', 1), 1, '2026-07-05T00:00:00Z')\`;
msg.topic2 = \`INSERT OR REPLACE INTO sync_outbox
  (event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at)
VALUES
  ('evt-2', 'ZONE', 'zone-1', 'ZONE_UPSERTED', json_object('contract_version', 1), 2, '2026-07-05T00:00:01Z')\`;
return msg;
`
    }
  ]));

  const result = extractFlowOps(flowPath);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.payloadsMissingContractVersion, []);
  assert.deepEqual(result.ops, ['DEVICE_DATA_APPENDED', 'ZONE_UPSERTED']);
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

test('parity check accepts seed SQL trigger ops as a canonical subset', () => {
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
  VALUES ('evt-1', 'DEVICE_DATA', 'device-1', 'DEVICE_DATA_APPENDED', json_object('contract_version', 1), 1, '2026-07-05T00:00:00Z');
END;
`);

  const result = checkSyncOpParity({
    root: fixtureRoot,
    serverSource: path.join(fixtureRoot, 'server/EdgeSyncService.java'),
    sqlSources: [{ name: 'seed-sql:fixture', path: seedPath }],
    databaseSources: [],
  });

  assert.equal(result.ok, true, result.message);
});

test('parity check rejects seed SQL trigger ops outside the canonical enum union', () => {
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
  VALUES ('evt-1', 'DEVICE_DATA', 'device-1', 'BOGUS_SEED_ONLY_OP', json_object('contract_version', 1), 1, '2026-07-05T00:00:00Z');
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
  assert.match(result.message, /BOGUS_SEED_ONLY_OP/);
});

test('parity check rejects bundled DB trigger ops outside the canonical enum union', () => {
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
  VALUES ('evt-1', 'DEVICE_DATA', 'device-1', 'BOGUS_DB_ONLY_OP', json_object('contract_version', 1), 1, '2026-07-05T00:00:00Z');
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
  assert.match(result.message, /BOGUS_DB_ONLY_OP/);
});

test('CLI fails loudly when explicit OSI_SERVER_EDGE_SYNC_SERVICE is missing', () => {
  const missing = path.join(os.tmpdir(), 'missing-EdgeSyncService.java');
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/verify-sync-op-parity.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { OSI_SERVER_EDGE_SYNC_SERVICE: missing }),
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /OSI_SERVER_EDGE_SYNC_SERVICE/);
  assert.match(`${result.stdout}\n${result.stderr}`, /missing-EdgeSyncService\.java/);
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
