#!/usr/bin/env node
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const helper = require(path.join(
  root,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-sync-helper'
));
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-durable-history-'));
const dbPath = path.join(tmpDir, 'farming.db');
const gatewayEui = '0016C001F11715E2';

function exec(sql) {
  execFileSync('sqlite3', [dbPath], {
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

function query(sql, params = []) {
  let offset = 0;
  const bound = sql.replace(/\?/g, () => {
    const value = params[offset++];
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'number') return String(value);
    return `'${String(value).replace(/'/g, "''")}'`;
  });
  const output = execFileSync('sqlite3', ['-json', dbPath, bound], {
    encoding: 'utf8'
  }).trim();
  return output ? JSON.parse(output) : [];
}

try {
  exec(fs.readFileSync(path.join(root, 'database/seed-blank.sql'), 'utf8'));
  exec(`
    INSERT INTO users(id, username, password_hash, created_at, user_uuid)
    VALUES(1, 'history-fixture', 'x', '2026-07-25T10:00:00.000Z', 'user-history');
    INSERT INTO irrigation_zones(
      id, user_id, name, zone_uuid, gateway_device_eui, sync_version
    ) VALUES(1, 1, 'History Zone', 'zone-history', '${gatewayEui}', 1);
    INSERT INTO devices(
      deveui, name, type_id, user_id, irrigation_zone_id,
      created_at, updated_at, gateway_device_eui
    ) VALUES
      ('A84041SENSOR0001', 'Sensor', 'DRAGINO_LSN50', 1, 1,
       '2026-07-25T10:00:00.000Z', '2026-07-25T10:00:00.000Z', '${gatewayEui}'),
      ('A84041VALVE00001', 'Valve', 'STREGA_VALVE', 1, 1,
       '2026-07-25T10:00:00.000Z', '2026-07-25T10:00:00.000Z', '${gatewayEui}');
    INSERT INTO device_data(
      id, deveui, recorded_at, swt_1, swt_2, dendro_valid
    ) VALUES(
      101, 'A84041SENSOR0001', '2026-07-25T10:01:00.000Z', 10.5, 11.5, 1
    );
    INSERT INTO chameleon_readings(
      id, deveui, recorded_at, payload_version, status_flags,
      data_invalid, comp_pending, f_port, f_cnt, calibration_status
    ) VALUES(
      201, 'A84041SENSOR0001', '2026-07-25T10:02:00.000Z', 1, 0,
      0, 0, 2, 20, 'calibrated'
    );
    INSERT INTO dendrometer_readings(
      id, deveui, position_um, recorded_at, is_valid, is_outlier,
      dendro_saturated
    ) VALUES(
      301, 'A84041SENSOR0001', 1200.5, '2026-07-25T10:03:00.000Z',
      1, 0, 0
    );
    INSERT INTO dendrometer_daily(
      id, deveui, date, mds_um, twd_um, stress_level, computed_at
    ) VALUES(
      401, 'A84041SENSOR0001', '2026-07-25', 30.5, 12.5, 'moderate',
      '2026-07-25T23:00:00.000Z'
    );
    INSERT INTO zone_daily_environment(
      zone_id, date, rainfall_mm, flow_liters, rain_source, computed_at
    ) VALUES(
      1, '2026-07-25', 2.5, 40.0, 'sensor', '2026-07-25T23:01:00.000Z'
    );
    INSERT INTO zone_daily_recommendations(
      id, zone_id, date, recommendation_json, computed_at
    ) VALUES(
      501, 1, '2026-07-25', '{"action":"WAIT"}', '2026-07-25T23:02:00.000Z'
    );
    INSERT INTO irrigation_events(
      id, user_id, irrigation_zone_id, action, reason, aggregate_kpa,
      threshold_kpa, duration_minutes, valve_deveui, payload_json,
      event_uuid, created_at
    ) VALUES(
      601, 1, 1, 'OPEN', 'threshold', 35.0, 30.0, 15,
      'A84041VALVE00001', '{"source":"fixture"}',
      'irrig-history-601', '2026-07-25T10:04:00.000Z'
    );
    INSERT INTO valve_actuation_expectations(
      expectation_id, device_eui, zone_id, commanded_at,
      commanded_duration_seconds, expected_close_at, estimated_gross_liters,
      volume_source, reconciliation_state, valve_channel, created_at
    ) VALUES(
      'expectation-history-1', 'A84041VALVE00001', 1,
      '2026-07-25T10:05:00.000Z', 900, '2026-07-25T10:20:00.000Z',
      30.0, 'zone_calibration', 'PENDING_OBSERVATION', 1,
      '2026-07-25T10:05:00.000Z'
    );
    INSERT INTO sync_link_state(
      peer_node, linked, server_url, gateway_device_eui, updated_at
    ) VALUES(
      'cloud', 1, 'https://server.example', '${gatewayEui}',
      '2026-07-25T10:06:00.000Z'
    ) ON CONFLICT(peer_node) DO UPDATE SET
      linked=excluded.linked,
      server_url=excluded.server_url,
      gateway_device_eui=excluded.gateway_device_eui,
      updated_at=excluded.updated_at;
  `);

  const evidence = [];
  for (const tableName of helper.tableNames()) {
    const kind = helper.cursorKind(tableName);
    const high = query(helper.snapshotHighQuery(tableName))[0];
    const snapshot = kind === 'id' ? high.snapshot_high_id : high.snapshot_high_key;
    const rows = query(
      helper.batchQuery(tableName, 'backfill'),
      helper.batchQueryParams(tableName, 'backfill', null, snapshot, 250)
    );
    assert.strictEqual(rows.length, 1, `${tableName} bounded row count`);
    const prepared = helper.prepareRow(tableName, gatewayEui, rows[0]);
    assert.strictEqual(prepared.quarantineReason, null, `${tableName} canonical row`);
    const key = helper.segmentKey(tableName, rows[0]);
    const segmentRows = query(...Object.values(helper.segmentQuery(tableName, key)));
    const segment = helper.buildSegment(tableName, gatewayEui, key, segmentRows);
    assert.strictEqual(segment.manifest.canonicalRowCount, 1, `${tableName} canonical count`);
    assert.strictEqual(segment.manifest.syncableRowCount, 1, `${tableName} syncable count`);
    assert.strictEqual(segment.manifest.quarantinedCount, 0, `${tableName} quarantine count`);
    assert.strictEqual(segment.manifest.tombstoneCount, 0, `${tableName} tombstones`);
    assert.match(segment.manifest.syncablePayloadHash, /^[0-9a-f]{64}$/);
    evidence.push({
      tableName,
      historyKey: prepared.historyKey,
      segmentKey: key,
      count: segment.manifest.syncableRowCount,
      hash: segment.manifest.syncablePayloadHash
    });
  }

  const beforeCorrection = helper.prepareRow(
    'device_data',
    gatewayEui,
    query('SELECT * FROM device_data WHERE id=101')[0]
  );
  exec("UPDATE device_data SET swt_1=13.5 WHERE id=101");
  const afterCorrection = helper.prepareRow(
    'device_data',
    gatewayEui,
    query('SELECT * FROM device_data WHERE id=101')[0]
  );
  assert.strictEqual(afterCorrection.historyKey, beforeCorrection.historyKey);
  assert.notStrictEqual(afterCorrection.payloadHash, beforeCorrection.payloadHash);
  assert.strictEqual(
    helper.prepareRow(
      'device_data',
      gatewayEui,
      query('SELECT * FROM device_data WHERE id=101')[0]
    ).payloadHash,
    afterCorrection.payloadHash,
    'duplicate replay hash'
  );
  assert.strictEqual(
    query("SELECT COUNT(*) AS count FROM sync_history_dirty_keys WHERE table_name='device_data' AND row_key=?", [afterCorrection.historyKey])[0].count,
    1,
    'correction dirty key'
  );

  exec(`
    INSERT INTO sync_history_cursors(
      peer_node, table_name, state, snapshot_high_id, last_acked_id
    ) VALUES('cloud', 'device_data', 'backfill', 101, 0);
    BEGIN;
    UPDATE sync_history_cursors
       SET last_acked_id=101
     WHERE peer_node='cloud' AND table_name='device_data';
    ROLLBACK;
  `);
  assert.strictEqual(
    query("SELECT last_acked_id FROM sync_history_cursors WHERE peer_node='cloud' AND table_name='device_data'")[0].last_acked_id,
    0,
    'interrupted transaction cursor'
  );
  exec("UPDATE sync_history_cursors SET last_acked_id=101 WHERE peer_node='cloud' AND table_name='device_data'");
  assert.strictEqual(
    query("SELECT last_acked_id FROM sync_history_cursors WHERE peer_node='cloud' AND table_name='device_data'")[0].last_acked_id,
    101,
    'persisted cursor restart'
  );

  console.log(JSON.stringify({
    gatewayEui,
    families: evidence.length,
    canonicalRows: evidence.reduce((sum, row) => sum + row.count, 0),
    quarantinedRows: 0,
    tombstones: 0,
    evidence
  }));
  console.log('OK durable history integration');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
