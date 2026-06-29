#!/usr/bin/env node
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const currentSchema = fs.readFileSync(path.join(repoRoot, 'database', 'seed-blank.sql'), 'utf8');
const migrationSql = fs.readFileSync(path.join(repoRoot, 'database', 'migrations', '2026-06-28-history-sync-v1.sql'), 'utf8');
const baseRef = process.env.OSI_HISTORY_BASE_REF || 'main';
let mainSchema = null;
try {
  mainSchema = execFileSync('git', ['show', `${baseRef}:database/seed-blank.sql`], { encoding: 'utf8' });
} catch (error) {
  console.warn(`SKIP upgrade-path test: cannot read ${baseRef}:database/seed-blank.sql (${error.message})`);
}
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-sync-history-schema-'));
let dbPath = '';

function sqlite(sql) {
  return execFileSync('sqlite3', [dbPath, sql], { encoding: 'utf8' }).trim();
}

function exec(sql) {
  execFileSync('sqlite3', [dbPath], { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}

function execFails(sql, expectedMessage) {
  try {
    exec(sql);
  } catch (error) {
    const output = `${error.stderr || ''}${error.stdout || ''}${error.message || ''}`;
    if (!output.includes(expectedMessage)) {
      throw new Error(`expected failure containing ${expectedMessage}, got ${output}`);
    }
    return;
  }
  throw new Error(`expected SQL to fail: ${sql}`);
}

function createDb(label, statements) {
  dbPath = path.join(tmpDir, `${label}.db`);
  for (const statement of statements) exec(statement);
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

function assertHistorySchemaAndTriggers(label) {
  const names = new Set(tableNamesWhere("type='table' AND (name LIKE 'sync_history_%' OR name='sync_link_state')"));
  for (const name of ['sync_link_state', 'sync_history_cursors', 'sync_history_dirty_keys', 'sync_history_segments', 'sync_history_quarantine']) {
    if (!names.has(name)) throw new Error(`${label}: missing ${name}`);
  }
  if (label.includes('history migration') && scalar("SELECT COUNT(*) FROM sync_link_state WHERE peer_node='cloud' AND linked=1 AND server_url='https://server.example' AND gateway_device_eui='0016C001F11715E2';") !== 1) {
    throw new Error(`${label}: existing linked user did not seed sync_link_state`);
  }
  const seededLinkedState = scalar("SELECT COUNT(*) FROM sync_link_state WHERE peer_node='cloud' AND linked=1;") === 1;
  if (seededLinkedState) {
    exec("UPDATE sync_link_state SET linked=0 WHERE peer_node='cloud'");
  }

  const cursorColumns = columnNames('sync_history_cursors');
  for (const name of ['last_shadow_acked_id', 'last_shadow_acked_key', 'last_shadow_error']) {
    if (!cursorColumns.includes(name)) throw new Error(`${label}: missing sync_history_cursors.${name}`);
  }

  const irrigationColumns = columnNames('irrigation_events');
  if (!irrigationColumns.includes('event_uuid')) throw new Error(`${label}: missing irrigation_events.event_uuid`);

  const indexNames = new Set(tableNamesWhere("type='index' AND tbl_name='irrigation_events'"));
  if (!indexNames.has('idx_irrigation_events_event_uuid')) throw new Error(`${label}: missing idx_irrigation_events_event_uuid`);

  exec("INSERT INTO users(id, username, password_hash, created_at, user_uuid) VALUES(1, 'local', 'x', '2026-06-28T10:00:00.000Z', 'user-1')");
  exec("INSERT INTO irrigation_zones(id, user_id, name, zone_uuid, gateway_device_eui, sync_version) VALUES(1, 1, 'Zone 1', 'zone-1', '0016C001F11715E2', 1)");
  if (scalar('SELECT COUNT(*) FROM sync_outbox;') !== 0) {
    throw new Error(`${label}: unlinked structural insert created outbox row`);
  }

  exec("INSERT INTO devices(deveui, name, type_id, user_id, irrigation_zone_id, created_at, updated_at, gateway_device_eui) VALUES('A84041CAFECAFE01', 'LSN50', 'DRAGINO_LSN50', 1, 1, '2026-06-28T10:00:00.000Z', '2026-06-28T10:00:00.000Z', '0016C001F11715E2')");
  exec("INSERT INTO device_data(id, deveui, recorded_at, swt_1) VALUES(99, 'A84041CAFECAFE01', '2026-06-28T09:00:00.000Z', 9.0)");
  if (scalar("SELECT COUNT(*) FROM sync_outbox WHERE aggregate_type='DEVICE_DATA';") !== 0) {
    throw new Error(`${label}: never-linked raw device_data insert created outbox row`);
  }
  exec("INSERT INTO zone_daily_environment(zone_id, date, rainfall_mm, computed_at) VALUES(1, '2026-06-27', 1.0, '2026-06-28T09:00:00.000Z')");
  exec("INSERT INTO zone_daily_recommendations(zone_id, date, recommendation_json, computed_at) VALUES(1, '2026-06-27', '{}', '2026-06-28T09:00:00.000Z')");
  exec("INSERT INTO dendrometer_daily(deveui, date, computed_at) VALUES('A84041CAFECAFE01', '2026-06-27', '2026-06-28T09:00:00.000Z')");
  exec("INSERT INTO irrigation_events(id, user_id, irrigation_zone_id, action, payload_json) VALUES(50, 1, 1, 'OPEN', '{}')");
  exec("UPDATE sync_link_state SET gateway_device_eui=NULL WHERE peer_node='cloud'");
  exec("INSERT INTO irrigation_zones(id, user_id, name, zone_uuid, gateway_device_eui, sync_version) VALUES(20, 1, 'Offline Missing Gateway', 'zone-offline-missing-gateway', NULL, 1)");
  exec("INSERT INTO irrigation_events(id, user_id, irrigation_zone_id, action, payload_json) VALUES(51, 1, 20, 'OPEN', '{}')");
  if (scalar("SELECT COUNT(*) FROM sync_outbox WHERE aggregate_type='IRRIGATION_EVENT';") !== 0) {
    throw new Error(`${label}: never-linked irrigation event with missing gateway created outbox row`);
  }
  if (scalar('SELECT COUNT(*) FROM sync_outbox;') !== 0) {
    throw new Error(`${label}: unlinked derived or irrigation insert created outbox row`);
  }

  exec("INSERT INTO sync_link_state(peer_node, linked, gateway_device_eui, updated_at) VALUES('cloud', 1, '0016C001F11715E2', '2026-06-28T10:00:00.000Z') ON CONFLICT(peer_node) DO UPDATE SET linked=1, gateway_device_eui=excluded.gateway_device_eui, updated_at=excluded.updated_at");
  exec("UPDATE irrigation_zones SET name='Zone linked', sync_version=2 WHERE id=1");
  if (scalar("SELECT COUNT(*) FROM sync_outbox WHERE aggregate_type='ZONE';") !== 1) {
    throw new Error(`${label}: linked structural update did not create outbox row`);
  }

  exec("INSERT INTO sync_history_dirty_keys(peer_node, table_name, row_key, changed_at) SELECT 'cloud', 'sentinel', 'sentinel', '2026-06-28T10:00:00.000Z' WHERE 0");
  exec("INSERT INTO device_data(id, deveui, recorded_at, swt_1) VALUES(101, 'A84041CAFECAFE01', '2026-06-28T10:00:00.000Z', 10.0)");
  if (scalar("SELECT COUNT(*) FROM sync_outbox WHERE aggregate_type='DEVICE_DATA';") !== 1) {
    throw new Error(`${label}: linked device_data insert lost legacy durable outbox coverage`);
  }
  exec("INSERT INTO chameleon_readings(id, deveui, recorded_at, data_invalid, comp_pending) VALUES(11, 'A84041CAFECAFE01', '2026-06-28T10:01:00.000Z', 1, 1)");
  if (scalar("SELECT COUNT(*) FROM sync_outbox WHERE aggregate_type='CHAMELEON_READING';") !== 1) {
    throw new Error(`${label}: linked chameleon_readings insert lost legacy durable outbox coverage`);
  }
  if (text("SELECT json_extract(payload_json, '$.data_invalid') || '|' || json_extract(payload_json, '$.comp_pending') FROM sync_outbox WHERE aggregate_type='CHAMELEON_READING';") !== '1|1') {
    throw new Error(`${label}: chameleon outbox payload omitted new validity flags`);
  }
  exec("UPDATE devices SET gateway_device_eui=NULL WHERE deveui='A84041CAFECAFE01'");
  exec("UPDATE sync_link_state SET gateway_device_eui='0016C001F11715E3' WHERE peer_node='cloud'");
  exec("INSERT INTO dendrometer_readings(id, deveui, position_um, recorded_at) VALUES(12, 'A84041CAFECAFE01', 1200.0, '2026-06-28T10:02:00.000Z')");
  if (scalar("SELECT COUNT(*) FROM sync_outbox WHERE aggregate_type='DENDRO_READING';") !== 1) {
    throw new Error(`${label}: linked dendrometer_readings insert lost legacy durable outbox coverage`);
  }
  if (text("SELECT json_extract(payload_json, '$.gateway_device_eui') || '|' || gateway_device_eui FROM sync_outbox WHERE aggregate_type='DENDRO_READING';") !== '0016C001F11715E3|0016C001F11715E3') {
    throw new Error(`${label}: dendrometer reading outbox did not use resolved sync_link_state gateway EUI`);
  }
  exec("UPDATE devices SET gateway_device_eui='0016C001F11715E2' WHERE deveui='A84041CAFECAFE01'");
  exec("UPDATE sync_link_state SET gateway_device_eui='0016C001F11715E2' WHERE peer_node='cloud'");
  exec("UPDATE device_data SET swt_1=11.0 WHERE id=101");
  if (scalar("SELECT COUNT(*) FROM sync_history_dirty_keys WHERE table_name='device_data' AND row_key='DEVICE_DATA|0016C001F11715E2|101';") !== 1) {
    throw new Error(`${label}: linked raw correction did not create dirty key`);
  }

  exec('DELETE FROM sync_outbox');
  exec("INSERT INTO device_data(id, deveui, recorded_at) VALUES(202, 'A84041CAFECAFE01', '2026-06-28T11:00:00.000Z')");
  if (scalar("SELECT COUNT(*) FROM sync_outbox WHERE aggregate_type='DEVICE_DATA';") !== 1) {
    throw new Error(`${label}: linked raw device_data insert did not create legacy outbox row`);
  }

  exec("INSERT INTO zone_daily_environment(zone_id, date, rainfall_mm, computed_at) VALUES(1, '2026-06-28', 2.5, '2026-06-28T10:00:00.000Z')");
  if (scalar("SELECT COUNT(*) FROM sync_history_dirty_keys WHERE table_name='zone_daily_environment' AND row_key='ZONE_ENVIRONMENT|zone-1|2026-06-28';") !== 1) {
    throw new Error(`${label}: zone environment dirty key did not use zone_uuid`);
  }
  exec("INSERT INTO irrigation_zones(id, user_id, name, zone_uuid, gateway_device_eui, sync_version) VALUES(3, 1, 'No UUID A', NULL, '0016C001F11715E2', 1)");
  exec("INSERT INTO irrigation_zones(id, user_id, name, zone_uuid, gateway_device_eui, sync_version) VALUES(4, 1, 'No UUID B', NULL, '0016C001F11715E2', 1)");
  exec("UPDATE irrigation_zones SET deleted_at='2026-06-29T09:00:00.000Z' WHERE id IN (3,4)");
  exec("INSERT INTO zone_daily_environment(zone_id, date, rainfall_mm, computed_at) VALUES(3, '2026-06-29', 1.0, '2026-06-29T10:00:00.000Z')");
  exec("INSERT INTO zone_daily_environment(zone_id, date, rainfall_mm, computed_at) VALUES(4, '2026-06-29', 2.0, '2026-06-29T10:00:00.000Z')");
  if (scalar("SELECT COUNT(*) FROM sync_history_dirty_keys WHERE table_name='zone_daily_environment' AND row_key LIKE 'ZONE_ENVIRONMENT|zone-id:%|2026-06-29';") !== 2) {
    throw new Error(`${label}: zone environment dirty keys collapsed missing zone_uuid rows`);
  }
  exec("INSERT INTO zone_daily_recommendations(zone_id, date, recommendation_json, computed_at) VALUES(3, '2026-06-29', '{}', '2026-06-29T10:00:00.000Z')");
  exec("INSERT INTO zone_daily_recommendations(zone_id, date, recommendation_json, computed_at) VALUES(4, '2026-06-29', '{}', '2026-06-29T10:00:00.000Z')");
  if (scalar("SELECT COUNT(*) FROM sync_history_dirty_keys WHERE table_name='zone_daily_recommendations' AND row_key LIKE 'ZONE_RECOMMENDATION|zone-id:%|2026-06-29';") !== 2) {
    throw new Error(`${label}: zone recommendation dirty keys collapsed missing zone_uuid rows`);
  }

  exec('DELETE FROM sync_outbox');
  exec("INSERT INTO irrigation_events(id, user_id, irrigation_zone_id, action, payload_json, event_uuid) VALUES(1, 1, 1, 'OPEN', '{}', 'irrig-0016C001F11715E2-000000000001')");
  if (text('SELECT event_uuid FROM irrigation_events WHERE id=1;') !== 'irrig-0016C001F11715E2-000000000001') {
    throw new Error(`${label}: irrigation event uuid mismatch`);
  }
  exec('PRAGMA recursive_triggers=OFF');
  exec("INSERT INTO irrigation_events(id, user_id, irrigation_zone_id, action, payload_json) VALUES(2, 1, 1, 'CLOSE', '{}')");
  const eventUuid = text('SELECT event_uuid FROM irrigation_events WHERE id=2;');
  if (!/^irrig-0016C001F11715E2-000000000000002$/.test(eventUuid)) {
    throw new Error(`${label}: irrigation event uuid trigger did not use zone gateway EUI`);
  }
  if (text("SELECT json_extract(payload_json, '$.event_uuid') FROM sync_outbox WHERE aggregate_type='IRRIGATION_EVENT' AND json_extract(payload_json, '$.event_id') = 2;") !== eventUuid) {
    throw new Error(`${label}: irrigation event outbox payload did not include stable event_uuid`);
  }
  exec('DELETE FROM sync_outbox');
  exec("INSERT INTO gateway_locations(gateway_device_eui, latitude, longitude, status, source, updated_at) VALUES('', 47.1001, 8.1002, 'fix', 'gpsd', '2026-06-28T10:03:00.000Z')");
  if (text("SELECT aggregate_key || '|' || json_extract(payload_json, '$.gateway_device_eui') || '|' || gateway_device_eui FROM sync_outbox WHERE aggregate_type='GATEWAY_LOCATION';") !== '0016C001F11715E2|0016C001F11715E2|0016C001F11715E2') {
    throw new Error(`${label}: gateway location outbox did not use resolved sync_link_state gateway EUI`);
  }
  exec("INSERT INTO irrigation_zones(id, user_id, name, zone_uuid, gateway_device_eui, sync_version) VALUES(2, 1, 'No Gateway', 'zone-2', NULL, 1)");
  exec("UPDATE irrigation_zones SET gateway_device_eui=NULL WHERE id=2");
  exec("UPDATE sync_link_state SET gateway_device_eui=NULL WHERE peer_node='cloud'");
  execFails("INSERT INTO irrigation_events(id, user_id, irrigation_zone_id, action, payload_json) VALUES(3, 1, 2, 'OPEN', '{}')", 'missing_gateway_device_eui');
  exec("UPDATE irrigation_zones SET gateway_device_eui='   ' WHERE id=2");
  exec("UPDATE sync_link_state SET gateway_device_eui='   ' WHERE peer_node='cloud'");
  execFails("INSERT INTO irrigation_events(id, user_id, irrigation_zone_id, action, payload_json) VALUES(4, 1, 2, 'OPEN', '{}')", 'missing_gateway_device_eui');

  console.log(`OK sync history schema ${label}`);
}

try {
  createDb('fresh', [currentSchema]);
  assertHistorySchemaAndTriggers('fresh seed');

  if (mainSchema) {
    createDb('upgrade', [
      mainSchema,
      "INSERT INTO users(id, username, password_hash, created_at, auth_mode, user_uuid, cloud_user_id, server_url, server_sync_token, server_linked_at) VALUES(90, 'linked', 'x', '2026-06-28T08:00:00.000Z', 'server', 'user-linked', 42, 'https://server.example', 'sync-token', '2026-06-28T08:00:00.000Z')",
      "INSERT INTO irrigation_zones(id, user_id, name, zone_uuid, gateway_device_eui, sync_version) VALUES(90, 90, 'Linked Zone', 'zone-linked', '0016C001F11715E2', 1)",
      migrationSql
    ]);
    assertHistorySchemaAndTriggers('main seed + history migration');
  }

  console.log('OK sync history schema');
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
