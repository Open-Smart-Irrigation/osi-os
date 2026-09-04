'use strict';
// Applies the cloud->edge valve commands (Valve control Phase B: the four schedule
// commands; cloud full-parity Task 1.4: CANCEL_VALVE_ACTUATION) via the SAME
// store/push/plan/cancel calls api.js's REST routes use, so a cloud edit and a local edit
// compile identically - one code path, two entry points. There is no HTTP auth wrapper
// here (no verifyBearer/ownedValve): these commands carry no end-user identity, only a
// device_eui - the same trust boundary every other cloud command in Route Command's
// dispatch already relies on (flows.json "Valve Cloud Command Bridge" is the caller).
const P = require('./plan');
const store = require('./store');
const push = require('./push');
const { cancelActuation } = require('./cancel');

async function getDevice(db, eui) {
  return db.get(
    'SELECT deveui, type_id, (SELECT timezone FROM irrigation_zones WHERE id = devices.irrigation_zone_id) AS zone_timezone ' +
    'FROM devices WHERE UPPER(deveui)=? AND deleted_at IS NULL',
    [eui]
  );
}

async function applyUpsertValveSchedule({ db, cmd, appId, flushQueue, warn, now, tzFallback }) {
  const eui = String(cmd.device_eui || cmd.deviceEui || '').trim().toUpperCase();
  const scheduleUuid = String(cmd.schedule_uuid || cmd.scheduleUuid || '').trim();
  if (!eui || !scheduleUuid) return { ok: false, error: 'device_eui and schedule_uuid are required' };
  const device = await getDevice(db, eui);
  if (!device) return { ok: false, error: 'not_found' };
  if (device.type_id !== 'STREGA_VALVE') return { ok: false, error: 'not_a_valve' };
  const existing = await db.get('SELECT schedule_uuid, kind FROM valve_schedules WHERE schedule_uuid=?', [scheduleUuid]);

  // D5: deleted_at carried in the upsert - there is no separate VALVE_SCHEDULE_DELETED op
  // on the edge->cloud side, and the same ValveSchedule shape is reused for this command,
  // so a cloud-issued deletion can in principle arrive here too. DELETE_VALVE_SCHEDULE is
  // the normal path; this is defensive, not the expected route.
  if (cmd.deleted_at) {
    if (!existing) return { ok: true, downlinks: [] }; // idempotent: nothing to delete
    await store.softDeleteSchedule(db, scheduleUuid);
    if (existing.kind !== 'WEEKLY') return { ok: true, downlinks: [] };
    const q = await push.compileAndQueue({ db, deviceEui: eui, appId, force: false, now, flushQueue, warn, timeZoneFallback: tzFallback });
    return { ok: true, downlinks: q.messages || [] };
  }

  const v = P.validateScheduleInput(cmd);
  if (!v.ok) return { ok: false, error: String(v.error || 'invalid_schedule') };

  // Validate the compiled plan BEFORE persisting (same order as api.js's POST/PUT routes):
  // a rejected schedule must never reach the DB.
  if (v.value.kind === 'WEEKLY') {
    const allSchedules = await store.listSchedules(db, eui);
    const trialList = existing
      ? allSchedules.map((s) => (s.schedule_uuid === scheduleUuid ? Object.assign({}, s, v.value) : s))
      : allSchedules.concat([Object.assign({ schedule_uuid: scheduleUuid, enabled: 1 }, v.value)]);
    const trial = P.compileWindows(trialList);
    if (trial.errors.length) return { ok: false, error: 'plan_conflict' };
  }

  if (existing) {
    await store.updateSchedule(db, scheduleUuid, v.value);
  } else {
    await store.insertSchedule(db, Object.assign(
      { schedule_uuid: scheduleUuid, device_eui: eui, timezone: device.zone_timezone || tzFallback },
      v.value
    ));
  }
  if (v.value.kind !== 'WEEKLY') return { ok: true, downlinks: [] };
  const q = await push.compileAndQueue({ db, deviceEui: eui, appId, force: false, now, flushQueue, warn, timeZoneFallback: tzFallback });
  return { ok: true, downlinks: q.messages || [] };
}

async function applyDeleteValveSchedule({ db, cmd, appId, flushQueue, warn, now, tzFallback }) {
  const scheduleUuid = String(cmd.schedule_uuid || cmd.scheduleUuid || '').trim();
  if (!scheduleUuid) return { ok: false, error: 'schedule_uuid is required' };
  const existing = await db.get(
    'SELECT schedule_uuid, device_eui, kind FROM valve_schedules WHERE schedule_uuid=? AND deleted_at IS NULL',
    [scheduleUuid]
  );
  if (!existing) return { ok: false, error: 'not_found' };
  await store.softDeleteSchedule(db, scheduleUuid);
  if (existing.kind !== 'WEEKLY') return { ok: true, downlinks: [] };
  const q = await push.compileAndQueue({ db, deviceEui: existing.device_eui, appId, force: false, now, flushQueue, warn, timeZoneFallback: tzFallback });
  return { ok: true, downlinks: q.messages || [] };
}

async function applyResendValvePlan({ db, cmd, appId, flushQueue, warn, now, tzFallback }) {
  const eui = String(cmd.device_eui || cmd.deviceEui || '').trim().toUpperCase();
  if (!eui) return { ok: false, error: 'device_eui is required' };
  const device = await getDevice(db, eui);
  if (!device) return { ok: false, error: 'not_found' };
  if (device.type_id !== 'STREGA_VALVE') return { ok: false, error: 'not_a_valve' };
  const q = await push.compileAndQueue({ db, deviceEui: eui, appId, force: true, now, flushQueue, warn, timeZoneFallback: device.zone_timezone || tzFallback });
  return { ok: true, downlinks: q.messages || [] };
}

async function applySetValveSchedulerStatus({ db, cmd, appId, flushQueue, warn, now, tzFallback }) {
  const eui = String(cmd.device_eui || cmd.deviceEui || '').trim().toUpperCase();
  const status = String(cmd.status || '').trim().toUpperCase();
  const code = { ACTIVE: '0', SKIP_TODAY: '1', DEACTIVATED: '2' }[status];
  if (!eui || !code) return { ok: false, error: 'invalid_status' };
  const device = await getDevice(db, eui);
  if (!device) return { ok: false, error: 'not_found' };
  if (device.type_id !== 'STREGA_VALVE') return { ok: false, error: 'not_a_valve' };
  const q = await push.queuePushes({ db, deviceEui: eui, appId, pushes: [push.buildStatusPush(code)], flushQueue, warn });
  const tz = device.zone_timezone || tzFallback;
  const lp = P.localParts(now, tz);
  await store.upsertSettings(db, eui, {
    scheduler_status: status,
    skip_today_date: status === 'SKIP_TODAY'
      ? `${lp.year}-${String(lp.month).padStart(2, '0')}-${String(lp.day).padStart(2, '0')}`
      : null,
  });
  return { ok: true, downlinks: q.messages || [] };
}

// Cloud->edge partial settings update: reuses the SAME store.upsertSettings() call api.js's
// PUT /api/valves/:eui/settings route uses - one code path, two entry points, same as the
// four schedule appliers above. Validation mirrors that route exactly (cloud
// full-parity Task P2-E1): strega_generation GEN1|GEN2, flow_rate_lpm > 0 (or null, which
// clears flow_rate_lpm/flow_rate_source/flow_rate_updated_at together), flow_rate_source
// coerces to 'estimated' unless it is exactly 'measured' (the REST route does not validate
// or reject this field, so this applier doesn't either), default_open_minutes 1-255.
// scheduler_status/skip_today_date are NOT settable here: the REST settings route does not
// accept scheduler_status either (that lives on POST /scheduler-status, i.e.
// SET_VALVE_SCHEDULER_STATUS) - reject rather than silently ignore, so a cloud sender gets
// an explicit signal instead of a command that silently did less than it looked like.
// Unlike SET_STREGA_* generation/model commands elsewhere, the REST route never recompiles
// or re-pushes a plan when strega_generation changes here (no push.compileAndQueue call in
// that route), so this applier must not invent one either - downlinks is always [].
async function applyUpsertValveSettings({ db, cmd, now }) {
  const eui = String(cmd.device_eui || cmd.deviceEui || '').trim().toUpperCase();
  if (!eui) return { ok: false, error: 'device_eui is required' };
  const device = await getDevice(db, eui);
  if (!device) return { ok: false, error: 'not_found' };
  if (device.type_id !== 'STREGA_VALVE') return { ok: false, error: 'not_a_valve' };
  if (cmd.scheduler_status !== undefined) return { ok: false, error: 'scheduler_status_not_supported' };

  const patch = {};
  if (cmd.strega_generation !== undefined) {
    if (!['GEN1', 'GEN2'].includes(cmd.strega_generation)) return { ok: false, error: 'invalid_generation' };
    patch.strega_generation = cmd.strega_generation;
  }
  if (cmd.flow_rate_lpm !== undefined) {
    if (cmd.flow_rate_lpm === null) {
      patch.flow_rate_lpm = null; patch.flow_rate_source = null; patch.flow_rate_updated_at = null;
    } else {
      const n = Number(cmd.flow_rate_lpm);
      if (!Number.isFinite(n) || n <= 0 || n > 10000) return { ok: false, error: 'invalid_flow_rate' };
      patch.flow_rate_lpm = n;
      patch.flow_rate_source = cmd.flow_rate_source === 'measured' ? 'measured' : 'estimated';
      patch.flow_rate_updated_at = now.toISOString();
    }
  }
  if (cmd.default_open_minutes !== undefined) {
    const n = Number(cmd.default_open_minutes);
    if (!Number.isInteger(n) || n < 1 || n > 255) return { ok: false, error: 'invalid_default_open_minutes' };
    patch.default_open_minutes = n;
  }
  await store.upsertSettings(db, eui, patch);
  return { ok: true, downlinks: [] };
}

// Cloud->edge cancel: reuses the SAME core (cancel.js) the REST cancel route uses - one
// code path, two entry points, same as the four schedule appliers above. No downlink is
// ever sent to the valve here; cancellation is a ChirpStack queue flush plus marking the
// newest active expectation CANCELLED (see cancel.js for the no-active-expectation
// behavior note, which deliberately matches the REST route rather than always succeeding).
async function applyCancelValveActuation({ db, cmd, flushQueue, now, warn }) {
  const eui = String(cmd.device_eui || cmd.deviceEui || '').trim().toUpperCase();
  if (!eui) return { ok: false, error: 'device_eui is required' };
  const result = await cancelActuation({ db, deviceEui: eui, reason: cmd.reason, flushQueue, now, warn });
  return { ok: result.ok, error: result.error, downlinks: result.downlinks || [] };
}

const APPLIERS = {
  UPSERT_VALVE_SCHEDULE: applyUpsertValveSchedule,
  DELETE_VALVE_SCHEDULE: applyDeleteValveSchedule,
  RESEND_VALVE_PLAN: applyResendValvePlan,
  SET_VALVE_SCHEDULER_STATUS: applySetValveSchedulerStatus,
  CANCEL_VALVE_ACTUATION: applyCancelValveActuation,
  UPSERT_VALVE_SETTINGS: applyUpsertValveSettings,
};

// Applies one of the cloud->edge valve commands registered in APPLIERS above. Returns
// { ok, error, downlinks } rather than throwing or writing an HTTP response - the caller
// (flows.json's "Valve Cloud Command Bridge") turns this into a command ACK plus MQTT
// downlink messages via the existing command-ack path.
async function applyCloudCommand({ db, cmd, appId, flushQueue, warn, now }) {
  const body = cmd || {};
  const commandType = String(body.commandType || body.command_type || '').trim().toUpperCase();
  const applier = APPLIERS[commandType];
  if (!applier) return { ok: false, error: 'unknown_command_type' };
  const tzFallback = (await store.getGatewaySetting(db, 'gateway_timezone', warn)) || 'UTC';
  return applier({ db, cmd: body, appId, flushQueue, warn, now: now || new Date(), tzFallback });
}

module.exports = { applyCloudCommand };
