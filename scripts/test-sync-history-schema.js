#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const schema = fs.readFileSync(path.join(repoRoot, 'database', 'seed-blank.sql'), 'utf8');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-sync-history-schema-'));
const dbPath = path.join(tmpDir, 'farming.db');

function sqlite(sql) {
  return execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' }).trim();
}

function exec(sql) {
  execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8' });
}

function columnNames(tableName) {
  const output = sqlite(`PRAGMA table_info(${tableName});`);
  if (!output) return [];
  return output.split('\n').map((line) => line.split('|')[1]).filter(Boolean);
}

function tableNamesWhere(whereClause) {
  const output = sqlite(`SELECT name FROM sqlite_master WHERE ${whereClause} ORDER BY name;`);
  return output ? output.split('\n') : [];
}

function scalar(sql) {
  const output = sqlite(sql);
  return output === '' ? 0 : Number(output);
}

function text(sql) {
  return sqlite(sql);
}

try {
  exec(schema);

  const names = new Set(tableNamesWhere("type='table' AND (name LIKE 'sync_history_%' OR name='sync_link_state')"));
  for (const name of ['sync_link_state', 'sync_history_cursors', 'sync_history_dirty_keys', 'sync_history_segments', 'sync_history_quarantine']) {
    if (!names.has(name)) throw new Error(`missing ${name}`);
  }

  const cursorColumns = columnNames('sync_history_cursors');
  for (const name of ['last_shadow_acked_id', 'last_shadow_acked_key', 'last_shadow_error']) {
    if (!cursorColumns.includes(name)) throw new Error(`missing sync_history_cursors.${name}`);
  }

  const irrigationColumns = columnNames('irrigation_events');
  if (!irrigationColumns.includes('event_uuid')) throw new Error('missing irrigation_events.event_uuid');

  const indexNames = new Set(tableNamesWhere("type='index' AND tbl_name='irrigation_events'"));
  if (!indexNames.has('idx_irrigation_events_event_uuid')) throw new Error('missing idx_irrigation_events_event_uuid');

  exec("INSERT INTO users(id, username, password_hash, created_at, user_uuid) VALUES(1, 'local', 'x', '2026-06-28T10:00:00.000Z', 'user-1')");
  exec("INSERT INTO irrigation_zones(id, user_id, name, zone_uuid, gateway_device_eui, sync_version) VALUES(1, 1, 'Zone 1', 'zone-1', '0016C001F11715E2', 1)");
  if (scalar('SELECT COUNT(*) FROM sync_outbox;') !== 0) {
    throw new Error('unlinked structural insert created outbox row');
  }

  exec("INSERT INTO devices(deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at, gateway_device_eui) VALUES('A84041CAFECAFE01', 'LSN50', 'DRAGINO_LSN50', 1, 1, '2026-06-28T10:00:00.000Z', '2026-06-28T10:00:00.000Z', '0016C001F11715E2')");
  exec("INSERT INTO device_data(id, deveui, recorded_at, swt_1) VALUES(99, 'A84041CAFECAFE01', '2026-06-28T09:00:00.000Z', 9.0)");
  if (scalar("SELECT COUNT(*) FROM sync_outbox WHERE aggregate_type='DEVICE_DATA';") !== 0) {
    throw new Error('never-linked raw device_data insert created outbox row');
  }
  exec("INSERT INTO zone_daily_environment(zone_id, date, rainfall_mm, computed_at) VALUES(1, '2026-06-27', 1.0, '2026-06-28T09:00:00.000Z')");
  exec("INSERT INTO zone_daily_recommendations(zone_id, date, recommendation_json, computed_at) VALUES(1, '2026-06-27', '{}', '2026-06-28T09:00:00.000Z')");
  exec("INSERT INTO dendrometer_daily(deveui, date, computed_at) VALUES('A84041CAFECAFE01', '2026-06-27', '2026-06-28T09:00:00.000Z')");
  exec("INSERT INTO irrigation_events(id, user_id, irrigation_zone_id, action, payload_json) VALUES(50, 1, 1, 'OPEN', '{}')");
  if (scalar('SELECT COUNT(*) FROM sync_outbox;') !== 0) {
    throw new Error('unlinked derived or irrigation insert created outbox row');
  }

  exec("INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) VALUES('cloud', 1, '0016C001F11715E2', '2026-06-28T10:00:00.000Z')");
  exec("UPDATE irrigation_zones SET name='Zone linked', sync_version=2 WHERE id=1");
  if (scalar("SELECT COUNT(*) FROM sync_outbox WHERE aggregate_type='ZONE';") !== 1) {
    throw new Error('linked structural update did not create outbox row');
  }

  exec("INSERT INTO sync_history_dirty_keys(peer_node, table_name, row_key, changed_at) SELECT 'cloud', 'sentinel', 'sentinel', '2026-06-28T10:00:00.000Z' WHERE 0");
  exec("INSERT INTO device_data(id, deveui, recorded_at, swt_1) VALUES(101, 'A84041CAFECAFE01', '2026-06-28T10:00:00.000Z', 10.0)");
  if (scalar("SELECT COUNT(*) FROM sync_outbox WHERE aggregate_type='DEVICE_DATA';") !== 1) {
    throw new Error('linked device_data insert lost legacy durable outbox coverage');
  }
  exec("INSERT INTO chameleon_readings(id, deveui, recorded_at) VALUES(11, 'A84041CAFECAFE01', '2026-06-28T10:01:00.000Z')");
  if (scalar("SELECT COUNT(*) FROM sync_outbox WHERE aggregate_type='CHAMELEON_READING';") !== 1) {
    throw new Error('linked chameleon_readings insert lost legacy durable outbox coverage');
  }
  exec("INSERT INTO dendrometer_readings(id, deveui, position_um, recorded_at) VALUES(12, 'A84041CAFECAFE01', 1200.0, '2026-06-28T10:02:00.000Z')");
  if (scalar("SELECT COUNT(*) FROM sync_outbox WHERE aggregate_type='DENDRO_READING';") !== 1) {
    throw new Error('linked dendrometer_readings insert lost legacy durable outbox coverage');
  }
  exec("UPDATE device_data SET swt_1=11.0 WHERE id=101");
  if (scalar("SELECT COUNT(*) FROM sync_history_dirty_keys WHERE table_name='device_data' AND row_key='DEVICE_DATA|0016C001F11715E2|101';") !== 1) {
    throw new Error('linked raw correction did not create dirty key');
  }

  exec('DELETE FROM sync_outbox');
  exec("INSERT INTO device_data(id, deveui, recorded_at) VALUES(202, 'A84041CAFECAFE01', '2026-06-28T11:00:00.000Z')");
  if (scalar("SELECT COUNT(*) FROM sync_outbox WHERE aggregate_type='DEVICE_DATA';") !== 1) {
    throw new Error('linked raw device_data insert did not create legacy outbox row');
  }

  exec("INSERT INTO zone_daily_environment(zone_id, date, rainfall_mm, computed_at) VALUES(1, '2026-06-28', 2.5, '2026-06-28T10:00:00.000Z')");
  if (scalar("SELECT COUNT(*) FROM sync_history_dirty_keys WHERE table_name='zone_daily_environment' AND row_key='ZONE_ENVIRONMENT|zone-1|2026-06-28';") !== 1) {
    throw new Error('zone environment dirty key did not use zone_uuid');
  }

  exec("INSERT INTO irrigation_events(id, user_id, irrigation_zone_id, action, payload_json, event_uuid) VALUES(1, 1, 1, 'OPEN', '{}', 'irrig-0016C001F11715E2-000000000001')");
  if (text('SELECT event_uuid FROM irrigation_events WHERE id=1;') !== 'irrig-0016C001F11715E2-000000000001') {
    throw new Error('irrigation event uuid mismatch');
  }
  exec("INSERT INTO irrigation_events(id, user_id, irrigation_zone_id, action, payload_json) VALUES(2, 1, 1, 'CLOSE', '{}')");
  if (text('SELECT event_uuid FROM irrigation_events WHERE id=2;') !== 'irrig-0016C001F11715E2-000000000002') {
    throw new Error('irrigation event uuid backfill mismatch');
  }

  console.log('OK sync history schema');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
