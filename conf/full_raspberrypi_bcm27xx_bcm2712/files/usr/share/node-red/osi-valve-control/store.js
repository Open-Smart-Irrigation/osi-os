'use strict';
// All functions accept either the osi-db-helper Database facade or a transaction scope (tx) — both expose get/all/run returning promises.

const VALVE_LIST_SQL = `
SELECT d.deveui, d.name, d.type_id, d.irrigation_zone_id, d.current_state, d.target_state, d.user_id,
       iz.name AS zone_name, iz.zone_uuid, iz.timezone AS zone_timezone,
       COALESCE(vs.strega_generation,'GEN1') AS strega_generation, vs.flow_rate_lpm, vs.flow_rate_source, vs.default_open_minutes,
       COALESCE(vs.scheduler_status,'ACTIVE') AS scheduler_status, vs.skip_today_date, vs.last_clock_sync_queued_at, vs.last_clock_sync_acked_at,
       zic.measured_flow_rate_lpm AS zone_flow_rate_lpm,
       (SELECT MAX(dd.recorded_at) FROM device_data dd WHERE dd.deveui = d.deveui) AS last_uplink_at,
       (SELECT vae.expectation_id FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_expectation_id,
       (SELECT vae.reconciliation_state FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_reconciliation_state,
       (SELECT vae.commanded_at FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_commanded_at,
       (SELECT vae.expected_close_at FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_expected_close_at,
       (SELECT vae.commanded_duration_seconds FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_duration_seconds,
       (SELECT vae.trigger FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') ORDER BY vae.commanded_at DESC LIMIT 1) AS active_trigger,
       (SELECT vae.reconciliation_state FROM valve_actuation_expectations vae WHERE vae.device_eui = d.deveui AND vae.reconciliation_state LIKE 'STALE_%' AND datetime(vae.commanded_at) > datetime('now','-1 day') ORDER BY vae.commanded_at DESC LIMIT 1) AS recent_stale_state
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
  // datetime('now') (space-separated), not a hand-rolled ISO strftime: this matches the
  // column's own DEFAULT (datetime('now')) so every write to valve_settings.updated_at is the
  // same format, regardless of whether the row was just INSERTed or is being UPDATEd here.
  await db.run('UPDATE valve_settings SET ' + cols.map((c) => c + '=?').join(', ') + ", updated_at=datetime('now') WHERE device_eui=?", cols.map((c) => patch[c]).concat([eui]));
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

// Callers cannot rely on a change count here: the live osi-db-helper facade's run() resolves
// undefined, so these deliberately return nothing. Whether the row existed/was updated is the
// caller's job to check (e.g. re-SELECT), not something this function can report.
async function updateSchedule(db, scheduleUuid, patch) {
  const cols = SCHEDULE_COLUMNS.filter((c) => Object.prototype.hasOwnProperty.call(patch || {}, c));
  if (!cols.length) return;
  // datetime('now'), matching valve_schedules.updated_at/created_at's own DEFAULT (datetime('now')).
  await db.run('UPDATE valve_schedules SET ' + cols.map((c) => c + '=?').join(', ') + ", sync_version = COALESCE(sync_version,0)+1, updated_at=datetime('now') WHERE schedule_uuid=? AND deleted_at IS NULL", cols.map((c) => patch[c]).concat([scheduleUuid]));
}

async function softDeleteSchedule(db, scheduleUuid) {
  await db.run("UPDATE valve_schedules SET deleted_at=datetime('now'), sync_version=COALESCE(sync_version,0)+1, updated_at=datetime('now') WHERE schedule_uuid=? AND deleted_at IS NULL", [scheduleUuid]);
}

// A DAYMASK_PLAN row's mask, decoded from its payload's first hex byte, with the 0x80
// "all-days" sentinel normalized to the literal 7-bit mask (0x7F) it represents.
function daymaskOf(payloadHex) {
  const raw = parseInt(String(payloadHex).slice(0, 2), 16);
  return raw === 0x80 ? 0x7F : raw;
}

async function lastPushHashes(db, deviceEui) {
  const rows = await db.all("SELECT purpose, weekday, payload_hex, plan_hash, state, queued_at FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') AND state IN ('QUEUED','ACKED') ORDER BY queued_at DESC", [deviceEui]);
  const out = {};
  for (const r of rows) {
    if (r.purpose === 'WEEKDAY_PLAN') {
      const key = 'WEEKDAY_PLAN:' + r.weekday;
      if (!(key in out)) out[key] = r.plan_hash;
      continue;
    }
    // GEN2 diffing is per-weekday, not per-group (CRITICAL 2, review round 1): a group's
    // daymask can legitimately change across compiles (windows re-split/re-merge across
    // weekdays) while a given weekday's own compiled window stays identical or reverts to an
    // earlier value. Keying the diff on the group's mask made a reverted plan look "already
    // pushed" under a stale per-group key and silently skip the re-push. Expanding each row
    // to the individual weekdays it covers, newest-first-wins, makes the diff correct
    // regardless of how groups are drawn on either side of the comparison.
    const mask = daymaskOf(r.payload_hex);
    for (let d = 0; d < 7; d += 1) {
      if (!((mask >> d) & 1)) continue;
      const key = 'GEN2DAY:' + d;
      if (!(key in out)) out[key] = r.plan_hash;
    }
  }
  return out;
}

async function insertPushes(db, rows) {
  for (const r of rows) {
    await db.run('INSERT INTO valve_schedule_pushes(push_id, device_eui, purpose, weekday, fport, payload_hex, plan_hash) VALUES (?,?,?,?,?,?,?)', [r.push_id, String(r.device_eui).toUpperCase(), r.purpose, r.weekday, r.fport, r.payload_hex, r.plan_hash]);
  }
}

// CRITICAL 1 (review round 1): SQLite's CAST does not parse hex text — CAST(('0x'||'80') AS
// INTEGER) is 0, not 128 — so the old SQL-side mask-equality WHERE clause here never matched
// and the DAYMASK_PLAN branch was dead code: a forced GEN2 re-push left two QUEUED rows for
// the same plan, which failStalePushes later turned into a spurious FAILED entry. Separately,
// exact-mask equality would have been the wrong comparison anyway (CRITICAL 2): regrouping
// means a new push's mask can legitimately differ from an old QUEUED row's mask while still
// covering some of the same weekdays, so a row must be superseded whenever its mask
// *intersects* the new push's mask, not only when it matches exactly. Both are fixed by
// decoding masks and intersecting them in JS, then superseding by push_id.
async function supersedeQueuedGen2(db, deviceEui, daymask) {
  const rows = await db.all("SELECT push_id, payload_hex FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose='DAYMASK_PLAN' AND state='QUEUED'", [deviceEui]);
  const newMask = daymask === 0x80 ? 0x7F : daymask;
  for (const r of rows) {
    if ((daymaskOf(r.payload_hex) & newMask) !== 0) {
      await db.run("UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE push_id=?", [r.push_id]);
    }
  }
}

async function supersedeQueued(db, deviceEui, purpose, weekdayOrMask) {
  if (purpose === 'WEEKDAY_PLAN') {
    return db.run("UPDATE valve_schedule_pushes SET state='SUPERSEDED' WHERE UPPER(device_eui)=UPPER(?) AND purpose='WEEKDAY_PLAN' AND weekday=? AND state='QUEUED'", [deviceEui, weekdayOrMask]);
  }
  if (purpose === 'DAYMASK_PLAN') {
    return supersedeQueuedGen2(db, deviceEui, weekdayOrMask);
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
  // (C2) queued_at is the DB's own datetime('now') default (space-separated); olderThanIso is
  // an ISO instant built by the caller. A raw string comparison mixes formats: at the
  // date/time separator, ' ' (0x20) always sorts below 'T' (0x54) — below every digit, in fact
  // — so on any day the two values happen to share, a genuinely-fresh space-form queued_at
  // reads as "less than" the ISO cutoff regardless of the actual clock time, failing healthy
  // pushes early. Wrapping both sides in datetime() normalizes them to the same canonical form
  // before comparing.
  return db.run("UPDATE valve_schedule_pushes SET state='FAILED', error='no_ack_24h' WHERE state='QUEUED' AND datetime(queued_at) < datetime(?)", [olderThanIso]);
}

// (final-fix-wave IMPORTANT 1) The naive SUM(...)-over-30-days form counted every ACKED/QUEUED
// row across every purpose, so a plan re-edit within the window left the OLD (now-superseded-
// by-newer-row, but not state-SUPERSEDED because it was already ACKED) rows in the tally
// alongside the new ones, inflating "{{acked}} of {{total}}" (e.g. 7 acked + 7 queued = "7 of
// 14" instead of "0 of 7"), and mixed in CLOCK_SYNC/SCHEDULER_STATUS pushes that have nothing
// to do with the weekday plan. Fixed to latest-per-slot semantics, matching how the schedule
// dialog's own per-weekday badges are derived (latestPush() in ValveScheduleDialog.tsx): group
// rows by weekday slot (GEN1: the row's own `weekday`; GEN2: every weekday bit set in the
// row's decoded daymask, via the same daymaskOf() used by lastPushHashes), keep only the
// newest row per slot, and count states from that reduced set. last_plan_queued_at/
// last_plan_acked_at are unrelated to the per-slot ratio and keep their prior semantics.
async function pushSummary(db, deviceEui) {
  const rows = await db.all(
    "SELECT purpose, weekday, payload_hex, state, queued_at FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') AND state IN ('QUEUED','ACKED','FAILED') AND queued_at > datetime('now','-30 day') ORDER BY queued_at DESC",
    [deviceEui]
  );
  const latestStateBySlot = {};
  for (const r of rows) {
    if (r.purpose === 'WEEKDAY_PLAN') {
      const key = 'WEEKDAY_PLAN:' + r.weekday;
      if (!(key in latestStateBySlot)) latestStateBySlot[key] = r.state;
      continue;
    }
    // Same per-weekday expansion as lastPushHashes: a DAYMASK_PLAN row covers every weekday
    // bit set in its decoded mask, and the newest row wins each of those slots individually.
    const mask = daymaskOf(r.payload_hex);
    for (let d = 0; d < 7; d += 1) {
      if (!((mask >> d) & 1)) continue;
      const key = 'GEN2DAY:' + d;
      if (!(key in latestStateBySlot)) latestStateBySlot[key] = r.state;
    }
  }
  let queued = 0, acked = 0, failed = 0;
  for (const state of Object.values(latestStateBySlot)) {
    if (state === 'QUEUED') queued += 1;
    else if (state === 'ACKED') acked += 1;
    else if (state === 'FAILED') failed += 1;
  }
  const meta = await db.get(`SELECT
      MAX(CASE WHEN purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') THEN queued_at END) AS last_plan_queued_at,
      MAX(CASE WHEN purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') AND state='ACKED' THEN acked_at END) AS last_plan_acked_at
    FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND queued_at > datetime('now','-30 day')`, [deviceEui]);
  return {
    queued, acked, failed,
    last_plan_queued_at: (meta && meta.last_plan_queued_at) || null,
    last_plan_acked_at: (meta && meta.last_plan_acked_at) || null,
  };
}

async function hasPendingObservation(db, deviceEui) {
  const row = await db.get("SELECT 1 AS x FROM valve_actuation_expectations WHERE UPPER(device_eui)=UPPER(?) AND reconciliation_state='PENDING_OBSERVATION' LIMIT 1", [deviceEui]);
  return !!row;
}

async function weekdayPushStates(db, deviceEui) {
  return db.all("SELECT purpose, weekday, payload_hex, state, queued_at, acked_at, error FROM valve_schedule_pushes WHERE UPPER(device_eui)=UPPER(?) AND purpose IN ('WEEKDAY_PLAN','DAYMASK_PLAN') AND state IN ('QUEUED','ACKED','FAILED') ORDER BY queued_at DESC", [deviceEui]);
}

// Gateway-level default timezone (FW-T5), read from app_settings(key='gateway_timezone').
// Swallow-with-default everywhere (FW-T5 review R1, m6): this is called once per scheduled
// worker tick (runObserveTick/runClockTick/runHousekeeping), none of which touched
// app_settings before FW-T5 and none of which has any enclosing try/catch around this one
// call — a rethrown error would abort the entire tick over a single non-critical setting
// read, not just this lookup. No caller anywhere discriminates on the specific error (the
// generic 500-catch in an HTTP handler is not "genuine handling" of this read failing), so
// every failure mode — missing table, transient read error, anything else — resolves to
// null (never throws), exactly like an absent row, letting every caller fall back to 'UTC'
// the same way it always has. Matches osi-system-settings/api.js's readGatewayTimezone,
// which uses the same policy.
async function getGatewaySetting(db, key, warn) {
  try {
    const row = await db.get('SELECT value FROM app_settings WHERE key = ?', [key]);
    return row ? row.value : null;
  } catch (error) {
    const detail = String(error && error.message ? error.message : error);
    if (!/no such table:\s*app_settings\b/i.test(detail) && typeof warn === 'function') {
      warn('[valve-control] gateway_timezone read failed: ' + detail);
    }
    return null;
  }
}

module.exports = { listValvesForUser, listSchedules, getSettings, upsertSettings, insertSchedule, updateSchedule, softDeleteSchedule, lastPushHashes, insertPushes, supersedeQueued, ackPush, failStalePushes, pushSummary, hasPendingObservation, weekdayPushStates, getGatewaySetting, SETTINGS_DEFAULTS };
