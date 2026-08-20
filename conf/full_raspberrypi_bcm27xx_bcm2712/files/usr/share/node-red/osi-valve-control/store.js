'use strict';
// All functions accept either the osi-db-helper Database facade or a transaction scope (tx) — both expose get/all/run returning promises.

const VALVE_LIST_SQL = `
SELECT d.deveui, d.name, d.type_id, d.irrigation_zone_id, d.current_state, d.target_state, d.user_id,
       iz.name AS zone_name, iz.zone_uuid, iz.timezone AS zone_timezone,
       vs.strega_generation, vs.flow_rate_lpm, vs.flow_rate_source, vs.default_open_minutes,
       vs.scheduler_status, vs.skip_today_date, vs.last_clock_sync_queued_at, vs.last_clock_sync_acked_at,
       zic.measured_flow_rate_lpm AS zone_flow_rate_lpm,
       (SELECT MAX(dd.recorded_at) FROM device_data dd WHERE dd.deveui = d.deveui) AS last_uplink_at,
       (SELECT vae.expectation_id FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_expectation_id,
       (SELECT vae.reconciliation_state FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_reconciliation_state,
       (SELECT vae.commanded_at FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_commanded_at,
       (SELECT vae.expected_close_at FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_expected_close_at,
       (SELECT vae.commanded_duration_seconds FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_duration_seconds,
       (SELECT vae.trigger FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_trigger,
       (SELECT vae.reconciliation_state FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state LIKE 'STALE_%' AND vae.commanded_at > datetime('now','-1 day') ORDER BY vae.commanded_at DESC LIMIT 1) AS recent_stale_state
  FROM devices d
  LEFT JOIN irrigation_zones iz ON iz.id = d.irrigation_zone_id AND iz.deleted_at IS NULL
  LEFT JOIN valve_settings vs ON vs.device_eui = d.deveui
  LEFT JOIN zone_irrigation_calibration zic ON zic.zone_id = d.irrigation_zone_id
 WHERE d.type_id = 'STREGA_VALVE' AND d.deleted_at IS NULL AND d.user_id = ?
 ORDER BY COALESCE(iz.name,'~'), d.name`;

async function listValvesForUser(db, userId) { return db.all(VALVE_LIST_SQL, [userId]); }

async function listSchedules(db, deviceEui) {
  return db.all('SELECT * FROM valve_schedules WHERE UPPER(device_eui)=UPPER(?) AND deleted_at IS NULL ORDER BY kind, start_time, fire_at', [deviceEui]);
}

const SETTINGS_DEFAULTS = { strega_generation: 'GEN1', flow_rate_lpm: null, flow_rate_source: null, default_open_minutes: null, scheduler_status: 'ACTIVE', skip_today_date: null, last_clock_sync_queued_at: null, last_clock_sync_acked_at: null };

async function getSettings(db, deviceEui) {
  const row = await db.get('SELECT * FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)', [deviceEui]);
  return Object.assign({}, SETTINGS_DEFAULTS, row || {}, { device_eui: String(deviceEui).toUpperCase() });
}

const SETTINGS_COLUMNS = ['strega_generation', 'flow_rate_lpm', 'flow_rate_source', 'flow_rate_updated_at', 'default_open_minutes', 'scheduler_status', 'skip_today_date', 'last_clock_sync_queued_at', 'last_clock_sync_acked_at'];

async function upsertSettings(db, deviceEui, patch) {
  const cols = SETTINGS_COLUMNS.filter((c) => Object.prototype.hasOwnProperty.call(patch || {}, c));
  if (!cols.length) return;
  const eui = String(deviceEui).toUpperCase();
  await db.run('INSERT OR IGNORE INTO valve_settings(device_eui) VALUES (?)', [eui]);
  await db.run('UPDATE valve_settings SET ' + cols.map((c) => c + '=?').join(', ') + ", updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE device_eui=?", cols.map((c) => patch[c]).concat([eui]));
}

// node:sqlite's DatabaseSync/StatementSync rejects `undefined` bind params (must be `null`);
// optional columns (label, weekdays_mask, start_time, fire_at) are legitimately absent for
// the WEEKLY/ONCE variant that doesn't use them, so normalize undefined -> null here.
function n(v) { return v === undefined ? null : v; }

async function insertSchedule(db, r) {
  await db.run(
    'INSERT INTO valve_schedules(schedule_uuid, device_eui, kind, label, weekdays_mask, start_time, fire_at, duration_minutes, timezone, enabled, once_state) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [r.schedule_uuid, String(r.device_eui).toUpperCase(), r.kind, n(r.label), n(r.weekdays_mask), n(r.start_time), n(r.fire_at), r.duration_minutes, r.timezone, r.enabled, r.kind === 'ONCE' ? 'PENDING' : null]
  );
}

const SCHEDULE_COLUMNS = ['label', 'weekdays_mask', 'start_time', 'fire_at', 'duration_minutes', 'timezone', 'enabled', 'once_state', 'once_fired_at'];

async function updateSchedule(db, scheduleUuid, patch) {
  const cols = SCHEDULE_COLUMNS.filter((c) => Object.prototype.hasOwnProperty.call(patch || {}, c));
  if (!cols.length) return 0;
  return db.run('UPDATE valve_schedules SET ' + cols.map((c) => c + '=?').join(', ') + ", sync_version = COALESCE(sync_version,0)+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE schedule_uuid=? AND deleted_at IS NULL", cols.map((c) => patch[c]).concat([scheduleUuid]));
}

async function softDeleteSchedule(db, scheduleUuid) {
  return db.run("UPDATE valve_schedules SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), sync_version=COALESCE(sync_version,0)+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE schedule_uuid=? AND deleted_at IS NULL", [scheduleUuid]);
}

async function lastPushHashes(db, deviceEui) {
  const rows = await db.all("SELECT purpose, weekday, payload_hex, plan_hash, state, queued_at FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') AND state IN ('QUEUED','ACKED') ORDER BY queued_at DESC", [deviceEui]);
  const out = {};
  for (const r of rows) {
    const key = r.purpose === 'WEEKDAY_PLAN' ? 'WEEKDAY_PLAN:' + r.weekday : 'DAYMASK_PLAN:' + parseInt(r.payload_hex.slice(0, 2), 16);
    if (!(key in out)) out[key] = r.plan_hash;
  }
  return out;
}

async function insertPushes(db, rows) {
  for (const r of rows) {
    await db.run('INSERT INTO valve_schedule_pushes(push_id, device_eui, purpose, weekday, fport, payload_hex, plan_hash) VALUES (?,?,?,?,?,?,?)', [r.push_id, String(r.device_eui).toUpperCase(), r.purpose, r.weekday, r.fport, r.payload_hex, r.plan_hash]);
  }
}

async function supersedeQueued(db, deviceEui, purpose, weekdayOrMask) {
  if (purpose === 'WEEKDAY_PLAN') {
    return db.run("UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE UPPER(device_eui)=UPPER(?) AND purpose='WEEKDAY_PLAN' AND weekday=? AND state='QUEUED'", [deviceEui, weekdayOrMask]);
  }
  if (purpose === 'DAYMASK_PLAN') {
    return db.run("UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE UPPER(device_eui)=UPPER(?) AND purpose='DAYMASK_PLAN' AND state='QUEUED' AND CAST(('0x' || substr(payload_hex,1,2)) AS INTEGER) = ?", [deviceEui, weekdayOrMask]);
  }
  return db.run("UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE UPPER(device_eui)=UPPER(?) AND purpose=? AND state='QUEUED'", [deviceEui, purpose]);
}

// The live osi-db-helper facade's run() resolves undefined (no change count), so ackPush
// counts via SELECT-then-UPDATE instead of trusting run()'s return value.
async function ackPush(db, deviceEui, purpose, fport, weekdayOrNull, status, atIso) {
  const where = weekdayOrNull == null ? '' : ' AND weekday=?';
  const selParams = [deviceEui, purpose, fport].concat(weekdayOrNull == null ? [] : [weekdayOrNull]);
  const row = await db.get("SELECT push_id FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose=? AND fport=? AND state='QUEUED'" + where + ' ORDER BY queued_at DESC LIMIT 1', selParams);
  if (!row) return 0;
  await db.run("UPDATE valve_schedule_pushes SET state='ACKED', ack_status=?, acked_at=? WHERE push_id=?", [status, atIso, row.push_id]);
  return 1;
}

async function failStalePushes(db, olderThanIso) {
  return db.run("UPDATE valve_schedule_pushes SET state='FAILED', error='no_ack_24h' WHERE state='QUEUED' AND queued_at < ?", [olderThanIso]);
}

async function pushSummary(db, deviceEui) {
  const row = await db.get(`SELECT
      SUM(CASE WHEN state='QUEUED' THEN 1 ELSE 0 END) AS queued,
      SUM(CASE WHEN state='ACKED' THEN 1 ELSE 0 END) AS acked,
      SUM(CASE WHEN state='FAILED' THEN 1 ELSE 0 END) AS failed,
      MAX(CASE WHEN purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') THEN queued_at END) AS last_plan_queued_at,
      MAX(CASE WHEN purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') AND state='ACKED' THEN acked_at END) AS last_plan_acked_at
    FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND queued_at > datetime('now','-30 day')`, [deviceEui]);
  return row || { queued: 0, acked: 0, failed: 0, last_plan_queued_at: null, last_plan_acked_at: null };
}

async function hasPendingObservation(db, deviceEui) {
  const row = await db.get("SELECT 1 AS x FROM valve_actuation_expectations WHERE UPPER(device_eui)=UPPER(?) AND reconciliation_state='PENDING_OBSERVATION' LIMIT 1", [deviceEui]);
  return !!row;
}

async function weekdayPushStates(db, deviceEui) {
  return db.all("SELECT purpose, weekday, payload_hex, state, queued_at, acked_at, error FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') AND state IN ('QUEUED','ACKED','FAILED') ORDER BY queued_at DESC", [deviceEui]);
}

module.exports = { listValvesForUser, listSchedules, getSettings, upsertSettings, insertSchedule, updateSchedule, softDeleteSchedule, lastPushHashes, insertPushes, supersedeQueued, ackPush, failStalePushes, pushSummary, hasPendingObservation, weekdayPushStates, SETTINGS_DEFAULTS };
