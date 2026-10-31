'use strict';

// One edge lifecycle boundary for the conditional policy and the legacy schedule
// writers.  Callers do authorization and acquire the complete valve writer set
// through dispatch before entering this module.  The transaction helpers below
// deliberately accept only a transaction scope: they never open a nested
// transaction and never call a transport.

const dispatch = require('../osi-valve-control/dispatch');
const push = require('../osi-valve-control/push');
const store = require('../osi-valve-control/store');
const valveCancel = require('../osi-valve-control/cancel');
const policyStore = require('./store');
const crypto = require('node:crypto');

const EUI_RE = /^[0-9A-F]{16}$/;
const MAX_RETRIES = 3;
const OPERATIONS = new Set([
  'legacy_schedule_write', 'disable_all', 'zone_delete',
  'device_assign', 'device_unassign', 'device_unclaim',
]);

// Issue #233 Phase A (SENSECAP_S2120 weather links). A local zone detach removes the selected
// (station, zone) pair. Only applyS2120CloudUnclaim sets CLOUD_S2120_UNCLAIM, which is not
// exported, so a local DELETE /api/devices/:deveui never gains the all-links cleanup.
const S2120_TYPE = 'SENSECAP_S2120';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const S2120_WEATHER_PAIR = Symbol('s2120WeatherPair');
const CLOUD_S2120_UNCLAIM = Symbol('cloudS2120Unclaim');

// Keep the lifecycle transaction-only helpers behind the same account-link
// fence as the policy API.  A pending link attempt may change the authoritative
// peer context, so a policy or schedule mutation must fail before it writes,
// including when a cloud command adapter calls this module directly.
async function assertLinkFence(tx) {
  const policyApi = require('./api');
  return policyApi.linkFence(tx);
}

function lifecycleError(status, code, message, details, affectedIds) {
  const error = new Error(message || code);
  error.statusCode = status;
  error.code = code;
  if (details !== undefined) error.details = details;
  if (affectedIds !== undefined) error.affected_ids = [...new Set((affectedIds || []).map(String))];
  return error;
}

function eui(value) {
  const result = String(value == null ? '' : value).trim().toUpperCase();
  if (!EUI_RE.test(result)) throw lifecycleError(422, 'invalid_device_eui', 'device_eui must be 16 hexadecimal characters');
  return result;
}

// Older commissioned sensor fixtures can use a stable non-EUI key. Device
// lifecycle lookup remains case-normalized; strict EUI validation is retained
// for every STREGA writer and clear path.
function deviceKey(value) {
  const result = String(value == null ? '' : value).trim().toUpperCase();
  if (!result || result.length > 64) throw lifecycleError(422, 'invalid_device_eui', 'device_eui is required');
  return result;
}

function instant(value) {
  const date = value instanceof Date ? value : new Date(value == null ? Date.now() : value);
  if (!Number.isFinite(date.getTime())) throw lifecycleError(422, 'invalid_lifecycle_time', 'lifecycle timestamp is invalid');
  return date.toISOString();
}

function uniqueEuis(values) {
  return [...new Set((values || []).filter(Boolean).map((value) => String(value).trim().toUpperCase()).filter((value) => EUI_RE.test(value)))].sort();
}

function jsonObject(value) {
  if (value == null || value === '') return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function conditionUsesDevice(policy, deviceEui, zoneDevices) {
  if (!policy) return false;
  const condition = jsonObject(policy.condition_json);
  const kind = String(condition.kind || '').toUpperCase();
  if (kind === 'SWT' || kind === 'VWC') {
    const refs = Array.isArray(condition.sources) ? condition.sources : [];
    return refs.some((ref) => String(ref && (ref.device_eui || ref.deveui || ref.deviceEui) || '').trim().toUpperCase() === deviceEui);
  }
  if (kind === 'DENDRO') {
    return (zoneDevices || []).some((device) => String(device.type_id || '').toUpperCase() === 'DRAGINO_LSN50' && Number(device.dendro_enabled) === 1 && String(device.deveui).toUpperCase() === deviceEui);
  }
  return false;
}

async function zoneByRef(db, ref, { includeDeleted = false } = {}) {
  if (ref == null || ref === '') return null;
  if (typeof ref === 'object' && ref.id != null) return db.get('SELECT * FROM irrigation_zones WHERE id=?' + (includeDeleted ? '' : ' AND deleted_at IS NULL') + ' LIMIT 1', [Number(ref.id)]);
  const text = String(typeof ref === 'object' ? (ref.zone_uuid || ref.zoneUuid || ref.id) : ref).trim();
  if (/^\d+$/.test(text)) return db.get('SELECT * FROM irrigation_zones WHERE id=?' + (includeDeleted ? '' : ' AND deleted_at IS NULL') + ' LIMIT 1', [Number(text)]);
  return db.get('SELECT * FROM irrigation_zones WHERE zone_uuid=?' + (includeDeleted ? '' : ' AND deleted_at IS NULL') + ' LIMIT 1', [text]);
}

async function zoneState(db, ref, options = {}) {
  const zone = await zoneByRef(db, ref, options);
  if (!zone) return null;
  const devices = await db.all('SELECT * FROM devices WHERE irrigation_zone_id=? AND deleted_at IS NULL ORDER BY UPPER(deveui)', [zone.id]);
  const schedules = await db.all(
    'SELECT vs.* FROM valve_schedules vs ' +
    'WHERE vs.deleted_at IS NULL AND (' +
      'EXISTS (SELECT 1 FROM devices d WHERE UPPER(d.deveui)=UPPER(vs.device_eui) ' +
        'AND d.irrigation_zone_id=? AND d.deleted_at IS NULL) OR ' +
      'EXISTS (SELECT 1 FROM irrigation_policies p WHERE p.zone_uuid=? ' +
        'AND p.policy_uuid=vs.condition_policy_uuid AND p.deleted_at IS NULL)' +
    ') ORDER BY vs.schedule_uuid',
    [zone.id, zone.zone_uuid]
  );
  const legacy = await db.all('SELECT * FROM irrigation_schedules WHERE irrigation_zone_id=? AND deleted_at IS NULL ORDER BY id', [zone.id]);
  const policy = await db.get('SELECT * FROM irrigation_policies WHERE zone_uuid=? AND deleted_at IS NULL LIMIT 1', [zone.zone_uuid]);
  return { zone, devices, schedules, legacy, policy };
}

async function stateForOperation(db, operation, input = {}) {
  const states = [];
  const add = async (ref, options = {}) => {
    if (ref == null || ref === '') return;
    const state = await zoneState(db, ref, options);
    if (state && !states.some((item) => Number(item.zone.id) === Number(state.zone.id))) states.push(state);
  };
  if (operation === 'disable_all') {
    const refs = Array.isArray(input.zoneIds) && input.zoneIds.length ? input.zoneIds : (Array.isArray(input.zoneUuids) ? input.zoneUuids : []);
    for (const ref of refs) await add(ref);
  } else if (operation === 'zone_delete') {
    await add(input.zoneId !== undefined ? input.zoneId : (input.zoneUuid || input.zone_uuid), { includeDeleted: true });
  } else if (operation === 'legacy_schedule_write') {
    await add(input.zoneId !== undefined ? input.zoneId : (input.zoneUuid || input.zone_uuid));
  } else {
    const deviceEui = deviceKey(input.deviceEui || input.device_eui || input.deveui);
    const device = await db.get('SELECT * FROM devices WHERE UPPER(deveui)=UPPER(?) LIMIT 1', [deviceEui]);
    if (device && device.irrigation_zone_id != null) await add(device.irrigation_zone_id, { includeDeleted: true });
    if (operation === 'device_assign') await add(input.zoneId !== undefined ? input.zoneId : (input.zoneUuid || input.zone_uuid));
    if (operation === 'device_unassign' && input[S2120_WEATHER_PAIR] === true) await add(input.zoneId);
  }
  return { states, deviceEui: input.deviceEui || input.device_eui || input.deveui ? deviceKey(input.deviceEui || input.device_eui || input.deveui) : null };
}

function stateValveEuis(state) {
  return (state && state.devices || []).filter((device) => String(device.type_id || '').toUpperCase() === 'STREGA_VALVE').map((device) => device.deveui)
    .concat((state && state.schedules || []).map((schedule) => schedule.device_eui))
    .concat((state && state.legacy || []).length ? (state.devices || []).filter((device) => String(device.type_id || '').toUpperCase() === 'STREGA_VALVE').map((device) => device.deveui) : []);
}

function affectedPoliciesForDevice(state, deviceEui, operation) {
  const target = String(deviceEui).toUpperCase();
  if (!state || !state.policy) return [];
  const targetSchedule = state.schedules.some((row) => String(row.device_eui).toUpperCase() === target && row.condition_policy_uuid === state.policy.policy_uuid);
  const source = conditionUsesDevice(state.policy, target, state.devices);
  if (targetSchedule || source || operation === 'zone_delete') return [state.policy];
  return [];
}

async function discoverAffectedWriters(db, operation, input = {}) {
  if (!OPERATIONS.has(operation)) throw lifecycleError(400, 'unsupported_lifecycle_operation', 'unsupported lifecycle operation');
  const discovered = await stateForOperation(db, operation, input);
  const writers = [];
  for (const state of discovered.states) writers.push(...stateValveEuis(state));
  if (discovered.deviceEui) {
    const device = await db.get('SELECT type_id FROM devices WHERE UPPER(deveui)=UPPER(?)', [discovered.deviceEui]);
    if (device && String(device.type_id).toUpperCase() === 'STREGA_VALVE') writers.push(discovered.deviceEui);
  }
  return { ...discovered, valveEuis: uniqueEuis(writers) };
}

function assertHeld(held, required, operation) {
  const heldSet = new Set(held || []);
  const missing = uniqueEuis(required).filter((value) => !heldSet.has(value));
  if (missing.length) throw lifecycleError(409, 'membership_drift', 'affected valve membership changed; retry lifecycle operation', { operation, required: uniqueEuis(required), held: [...heldSet].sort() }, missing);
}

async function terminalizeUnattemptedTx(tx, policyUuid, reason, at) {
  if (!policyUuid) return 0;
  const rows = await tx.all("SELECT * FROM irrigation_occurrences WHERE policy_uuid=? AND state IN ('PENDING','CLAIMED')", [policyUuid]);
  let changed = 0;
  for (const row of rows) {
    const outcome = await policyStore.transitionOccurrenceTx(tx, row, {
      state: 'SKIPPED', decision: 'SKIPPED', decision_reason: reason || 'lifecycle_retired', decision_at: at, updated_at: at,
    }, { now: at });
    if (outcome.changed) changed += 1;
  }
  return changed;
}

async function pausePolicyTx(tx, policy, at, reason) {
  await assertLinkFence(tx);
  if (!policy) return null;
  const enabled = Number(policy.enabled) === 1;
  if (enabled) {
    await tx.run('UPDATE irrigation_policies SET enabled=0, updated_at=?, sync_version=COALESCE(sync_version,0)+1 WHERE policy_uuid=? AND deleted_at IS NULL AND enabled=1', [at, policy.policy_uuid]);
  }
  await terminalizeUnattemptedTx(tx, policy.policy_uuid, reason || 'policy_paused', at);
  return tx.get('SELECT * FROM irrigation_policies WHERE policy_uuid=?', [policy.policy_uuid]);
}

async function retirePolicyAndSchedulesTx(tx, policy, at, reason) {
  await assertLinkFence(tx);
  if (!policy) return { policy: null, schedules: [], skipped: 0 };
  const schedules = await tx.all('SELECT * FROM valve_schedules WHERE condition_policy_uuid=? AND deleted_at IS NULL ORDER BY schedule_uuid', [policy.policy_uuid]);
  await tx.run('UPDATE irrigation_policies SET enabled=0, deleted_at=?, updated_at=?, sync_version=COALESCE(sync_version,0)+1 WHERE policy_uuid=? AND deleted_at IS NULL', [at, at, policy.policy_uuid]);
  await tx.run('UPDATE valve_schedules SET enabled=0, deleted_at=?, updated_at=?, sync_version=COALESCE(sync_version,0)+1 WHERE condition_policy_uuid=? AND deleted_at IS NULL', [at, at, policy.policy_uuid]);
  const skipped = await terminalizeUnattemptedTx(tx, policy.policy_uuid, reason || 'policy_retired', at);
  return { policy: await tx.get('SELECT * FROM irrigation_policies WHERE policy_uuid=?', [policy.policy_uuid]), schedules, skipped };
}

async function disableLegacyTx(tx, state, at, input = {}) {
  if (!state || !state.zone) return 0;
  const row = state.legacy.find((item) => Number(item.enabled) === 1) || null;
  if (!row) return 0;
  const syncVersion = input.syncVersion == null && input.appliedSyncVersion == null
    ? Number(row.sync_version || 0) + 1
    : requestedSyncVersion(input, row);
  const result = await tx.run('UPDATE irrigation_schedules SET enabled=0, sync_version=?, updated_at=? WHERE irrigation_zone_id=? AND deleted_at IS NULL AND COALESCE(enabled,0)=1', [syncVersion, at, state.zone.id]);
  return Number(result && result.changes || 0);
}

function requestedSyncVersion(input, current) {
  const requested = input && (input.syncVersion == null ? input.appliedSyncVersion : input.syncVersion);
  if (requested == null) return Number(current && current.sync_version || 0) + 1;
  if (!Number.isSafeInteger(Number(requested)) || Number(requested) < 0) {
    throw lifecycleError(422, 'invalid_sync_version', 'syncVersion must be a non-negative safe integer');
  }
  return Number(requested);
}

function versionInput(input) {
  const raw = input && (input.syncVersion == null ? input.appliedSyncVersion : input.syncVersion);
  if (raw == null) return null;
  if (!Number.isSafeInteger(Number(raw)) || Number(raw) < 0) {
    throw lifecycleError(422, 'invalid_sync_version', 'syncVersion must be a non-negative safe integer');
  }
  return Number(raw);
}

function versionConflict(code, message, current, requested) {
  return lifecycleError(409, code, message, { current_sync_version: Number(current || 0), requested_sync_version: requested });
}

function sameValue(left, right) {
  return (left == null ? null : left) === (right == null ? null : right);
}

function legacyPatchMatches(current, patch) {
  if (!current) return false;
  const expected = {
    trigger_metric: patch.trigger_metric === undefined ? current.trigger_metric : patch.trigger_metric,
    threshold_kpa: patch.threshold_kpa === undefined ? current.threshold_kpa : patch.threshold_kpa,
    duration_minutes: patch.duration_minutes === undefined ? current.duration_minutes : patch.duration_minutes,
    enabled: patch.enabled === undefined ? Number(current.enabled) : (patch.enabled ? 1 : 0),
    response_mode: patch.response_mode === undefined ? current.response_mode : patch.response_mode,
  };
  return sameValue(current.trigger_metric, expected.trigger_metric) &&
    sameValue(current.threshold_kpa, expected.threshold_kpa) &&
    Number(current.duration_minutes || 0) === Number(expected.duration_minutes || 0) &&
    Number(current.enabled || 0) === Number(expected.enabled || 0) &&
    sameValue(current.response_mode, expected.response_mode);
}

function explicitlyDisabled(patch) {
  return Boolean(patch && Object.prototype.hasOwnProperty.call(patch, 'enabled')
    && (patch.enabled === false || patch.enabled === 0));
}

async function classifyVersionTx(tx, operation, input = {}) {
  const requested = versionInput(input);
  if (requested == null) return null;
  if (operation === 'legacy_schedule_write') {
    const state = (await stateForOperation(tx, operation, input)).states[0];
    if (!state) throw lifecycleError(404, 'zone_not_found', 'zone does not exist');
    const patch = input.patch || input.schedule || {};
    const managed = state.policy && state.policy.deleted_at == null;
    const explicitDisabled = explicitlyDisabled(patch);
    if (managed && !explicitDisabled) {
      throw lifecycleError(409, 'managed_schedule_conflict', 'legacy schedule writes are disabled while a conditional policy exists');
    }
    const current = state.legacy[0] || null;
    const currentVersion = Number(current && current.sync_version || 0);
    if (requested < currentVersion) throw versionConflict('stale_sync_version', 'legacy schedule version is stale', currentVersion, requested);
    if (requested === currentVersion) {
      if (!managed && legacyPatchMatches(current, patch)) {
        return { replayed: true, schedule: current, valve_euis: uniqueEuis(stateValveEuis(state)) };
      }
      if (managed && explicitDisabled && Number(state.policy.enabled) === 0
          && current && legacyPatchMatches(current, patch)) {
        return { replayed: true, managed: true, schedule: current, policy: state.policy, disabledSchedules: 0, clears: [], valve_euis: uniqueEuis(stateValveEuis(state)) };
      }
      throw versionConflict('version_conflict', 'legacy schedule version conflicts with current state', currentVersion, requested);
    }
    return null;
  }
  const deviceEui = deviceKey(input.deviceEui || input.device_eui || input.deveui);
  const current = await tx.get('SELECT * FROM devices WHERE UPPER(deveui)=UPPER(?) AND deleted_at IS NULL', [deviceEui]);
  if (!current) throw lifecycleError(404, 'device_not_found', 'device does not exist', undefined, [deviceEui]);
  const currentVersion = Number(current.sync_version || 0);
  if (requested < currentVersion) throw versionConflict('stale_sync_version', 'device version is stale', currentVersion, requested);
  if (requested > currentVersion) return null;
  let exact = false;
  if (operation === 'device_assign') {
    const target = await zoneByRef(tx, input.zoneId !== undefined ? input.zoneId : (input.zoneUuid || input.zone_uuid));
    const requestedGateway = input.gatewayDeviceEui || input.gateway_device_eui || current.gateway_device_eui || null;
    exact = Boolean(target) && Number(current.irrigation_zone_id) === Number(target.id) &&
      sameValue(String(current.gateway_device_eui || '').toUpperCase() || null, String(requestedGateway || '').toUpperCase() || null);
  } else if (operation === 'device_unassign') {
    exact = current.irrigation_zone_id == null;
  } else if (operation === 'device_unclaim') {
    const requestedGateway = input.gatewayDeviceEui || input.gateway_device_eui || null;
    exact = current.user_id == null && current.irrigation_zone_id == null &&
      sameValue(String(current.gateway_device_eui || '').toUpperCase() || null, String(requestedGateway || '').toUpperCase() || null);
  }
  if (exact) return { replayed: true, device: current, changed_policies: [], clears: [], valve_euis: uniqueEuis([deviceEui]) };
  throw versionConflict('version_conflict', 'device version conflicts with current state', currentVersion, requested);
}

async function updateLegacyTx(tx, state, patch, at, input = {}) {
  const current = state.legacy[0] || null;
  const enabled = patch.enabled === undefined ? (current ? Number(current.enabled) : 0) : (patch.enabled ? 1 : 0);
  if (current) {
    await tx.run('UPDATE irrigation_schedules SET trigger_metric=?, threshold_kpa=?, duration_minutes=?, enabled=?, response_mode=?, deleted_at=NULL, sync_version=?, updated_at=? WHERE id=? AND deleted_at IS NULL', [
      patch.trigger_metric === undefined ? current.trigger_metric : patch.trigger_metric,
      patch.threshold_kpa === undefined ? current.threshold_kpa : patch.threshold_kpa,
      patch.duration_minutes === undefined ? current.duration_minutes : patch.duration_minutes,
      enabled,
      patch.response_mode === undefined ? current.response_mode : patch.response_mode,
      requestedSyncVersion(input, current), at, current.id,
    ]);
    return tx.get('SELECT * FROM irrigation_schedules WHERE id=?', [current.id]);
  }
  await tx.run('INSERT INTO irrigation_schedules(irrigation_zone_id,trigger_metric,threshold_kpa,duration_minutes,enabled,response_mode,sync_version,deleted_at,created_at,updated_at) VALUES (?,?,?,?,?, ?,?,NULL,?,?)', [
    state.zone.id, patch.trigger_metric || null, patch.threshold_kpa == null ? null : patch.threshold_kpa, patch.duration_minutes == null ? 0 : patch.duration_minutes, enabled, patch.response_mode || 'proportional', requestedSyncVersion(input, null), at, at,
  ]);
  return tx.get('SELECT * FROM irrigation_schedules WHERE irrigation_zone_id=? AND deleted_at IS NULL LIMIT 1', [state.zone.id]);
}

async function retireDeviceSchedulesTx(tx, deviceEui, at, { all = false } = {}) {
  const rows = await tx.all('SELECT * FROM valve_schedules WHERE UPPER(device_eui)=UPPER(?) AND deleted_at IS NULL ORDER BY schedule_uuid', [deviceEui]);
  const selected = all ? rows : rows.filter((row) => row.condition_policy_uuid != null);
  if (selected.length) {
    await tx.run('UPDATE valve_schedules SET enabled=0, deleted_at=?, updated_at=?, sync_version=COALESCE(sync_version,0)+1 WHERE UPPER(device_eui)=UPPER(?) AND deleted_at IS NULL ' + (all ? '' : 'AND condition_policy_uuid IS NOT NULL'), [at, at, deviceEui]);
  }
  return { before: rows, retired: selected };
}

async function invalidateValveTx(tx, deviceEui, at, reason) {
  await push.invalidateLifecycleClearTx(tx, deviceEui, { reason: reason || 'binding_changed', now: at });
}

async function prepareValveClearTx(tx, deviceEui, at, { retiredSchedules = [], policy = null } = {}) {
  const valve = eui(deviceEui);
  const oldRows = (retiredSchedules || []).filter((row) => String(row.device_eui).toUpperCase() === valve);
  const liveRows = await tx.all('SELECT * FROM valve_schedules WHERE UPPER(device_eui)=UPPER(?) AND deleted_at IS NULL ORDER BY schedule_uuid', [valve]);
  if (!oldRows.length && !liveRows.length) return null;
  // A valve may have been moved to another zone while the old conditional
  // schedule was being retired.  A clear prepared for the old authority must
  // never wipe a live fixed or different-policy schedule in its new zone.
  if (liveRows.some((row) => !policy || row.condition_policy_uuid !== policy.policy_uuid)) return null;
  const settings = await store.getSettings(tx, valve);
  return push.prepareLifecycleClearRevisionTx(tx, {
    deviceEui: valve,
    generation: settings.strega_generation || 'GEN1',
    reason: 'lifecycle_clear',
    now: at,
    policy,
    retiredSchedules: oldRows,
    liveSchedules: liveRows,
    force: true,
  });
}

async function applyZoneDeleteTx(tx, input = {}) {
  await assertLinkFence(tx);
  const at = instant(input.now || input.deletedAt || input.deleted_at);
  const state = await zoneState(tx, input.zoneUuid || input.zone_uuid || input.zoneId, { includeDeleted: true });
  if (!state) throw lifecycleError(404, 'zone_not_found', 'zone does not exist');
  if (input.requireOwner && Number(state.zone.user_id) !== Number(input.actor && input.actor.user_id)) {
    throw lifecycleError(404, 'zone_not_found', 'zone does not exist');
  }
  if (state.zone.deleted_at != null) {
    return { zone: state.zone, policy: state.policy, retired: [], clears: [], valve_euis: uniqueEuis(stateValveEuis(state)) };
  }
  const retired = new Map();
  const results = [];
  if (state.policy && state.policy.deleted_at == null) {
    const outcome = await retirePolicyAndSchedulesTx(tx, state.policy, at, input.reason || 'zone_deleted');
    results.push(outcome);
  }
  for (const schedule of state.schedules) {
    const list = retired.get(String(schedule.device_eui).toUpperCase()) || [];
    list.push(schedule); retired.set(String(schedule.device_eui).toUpperCase(), list);
  }
  for (const device of state.devices) {
    if (String(device.type_id).toUpperCase() === 'STREGA_VALVE') await invalidateValveTx(tx, device.deveui, at, 'zone_deleted');
  }
  await tx.run('UPDATE devices SET irrigation_zone_id=NULL, updated_at=?, sync_version=COALESCE(sync_version,0)+1 WHERE irrigation_zone_id=? AND deleted_at IS NULL', [at, state.zone.id]);
  await tx.run('UPDATE journal_plots SET zone_uuid=NULL, updated_at=?, sync_version=COALESCE(sync_version,0)+1 WHERE zone_uuid=? AND deleted_at IS NULL', [at, state.zone.zone_uuid]);
  await tx.run('UPDATE user_zone_assignments SET deleted_at=?, updated_at=?, sync_version=COALESCE(sync_version,0)+1 WHERE zone_uuid=? AND deleted_at IS NULL', [at, at, state.zone.zone_uuid]);
  await tx.run('UPDATE irrigation_schedules SET enabled=0, deleted_at=?, updated_at=?, sync_version=COALESCE(sync_version,0)+1 WHERE irrigation_zone_id=? AND deleted_at IS NULL', [at, at, state.zone.id]);
  const zoneVersion = input.zoneSyncVersion == null
    ? Number(state.zone.sync_version || 0) + 1
    : requestedSyncVersion({ syncVersion: input.zoneSyncVersion }, state.zone);
  await tx.run('UPDATE irrigation_zones SET deleted_at=?, updated_at=?, sync_version=? WHERE id=? AND deleted_at IS NULL', [input.deletedAt || at, at, zoneVersion, state.zone.id]);
  const clears = [];
  for (const [deviceEui, schedules] of retired) {
    const device = await tx.get('SELECT * FROM devices WHERE UPPER(deveui)=UPPER(?) AND deleted_at IS NULL', [deviceEui]);
    if (device && String(device.type_id).toUpperCase() === 'STREGA_VALVE') {
      const policy = state.policy ? await tx.get('SELECT * FROM irrigation_policies WHERE policy_uuid=?', [state.policy.policy_uuid]) : null;
      const prepared = await prepareValveClearTx(tx, deviceEui, at, { retiredSchedules: schedules, policy });
      if (prepared) clears.push({ device_eui: deviceEui, ...prepared });
    }
  }
  return { zone: await tx.get('SELECT * FROM irrigation_zones WHERE id=?', [state.zone.id]), policy: state.policy ? await tx.get('SELECT * FROM irrigation_policies WHERE policy_uuid=?', [state.policy.policy_uuid]) : null, retired: results, clears, valve_euis: uniqueEuis(stateValveEuis(state)) };
}

async function applyOperationTx(tx, operation, input = {}) {
  const at = instant(input.now);
  const discovered = await stateForOperation(tx, operation, input);
  if (operation === 'zone_delete') return applyZoneDeleteTx(tx, input);
  if (operation === 'disable_all') {
    const changed = new Set(); const paused = [];
    for (const state of discovered.states) {
      const oldLegacy = state.legacy.some((row) => Number(row.enabled) === 1);
      if (state.policy && state.policy.deleted_at == null) {
        const policy = await pausePolicyTx(tx, state.policy, at, 'disable_all');
        paused.push(policy);
        if (Number(state.policy.enabled) === 1) changed.add(String(state.zone.zone_uuid));
      }
      const legacyChanges = await disableLegacyTx(tx, state, at);
      if (oldLegacy || legacyChanges) changed.add(String(state.zone.zone_uuid));
    }
    const clears = [];
    for (const state of discovered.states) {
      if (!state.policy) continue;
      const policy = await tx.get('SELECT * FROM irrigation_policies WHERE policy_uuid=?', [state.policy.policy_uuid]);
      const byEui = new Map();
      for (const row of state.schedules) {
        if (row.condition_policy_uuid !== state.policy.policy_uuid) continue;
        const list = byEui.get(String(row.device_eui).toUpperCase()) || []; list.push(row); byEui.set(String(row.device_eui).toUpperCase(), list);
      }
      for (const [deviceEui, rows] of byEui) {
        const device = await tx.get('SELECT * FROM devices WHERE UPPER(deveui)=UPPER(?) AND deleted_at IS NULL', [deviceEui]);
        if (device && String(device.type_id).toUpperCase() === 'STREGA_VALVE') {
          const prepared = await prepareValveClearTx(tx, deviceEui, at, { retiredSchedules: rows, policy });
          if (prepared) clears.push({ device_eui: deviceEui, ...prepared });
        }
      }
    }
    return { disabledSchedules: changed.size, policy: paused, clears, valve_euis: uniqueEuis(discovered.states.flatMap(stateValveEuis)) };
  }
  const deviceEui = deviceKey(input.deviceEui || input.device_eui || input.deveui);
  const current = await tx.get('SELECT * FROM devices WHERE UPPER(deveui)=UPPER(?) AND deleted_at IS NULL', [deviceEui]);
  if (!current) throw lifecycleError(404, 'device_not_found', 'device does not exist', undefined, [deviceEui]);
  if (input.requireOwner && Number(current.user_id) !== Number(input.actor && input.actor.user_id)) {
    throw lifecycleError(404, 'device_not_found', 'device does not exist', undefined, [deviceEui]);
  }
  if (operation === 'device_unassign' && input[S2120_WEATHER_PAIR] === true) {
    return detachS2120WeatherPairTx(tx, input, current, discovered, at);
  }
  if (operation === 'device_unassign' && input.zoneId != null && Number(current.irrigation_zone_id) !== Number(input.zoneId)) {
    throw lifecycleError(404, 'device_not_found', 'device is not assigned to this zone', undefined, [deviceEui]);
  }
  if (operation === 'device_unassign' && input.zoneUuid != null) {
    const assignedZone = current.irrigation_zone_id == null
      ? null
      : await tx.get('SELECT zone_uuid FROM irrigation_zones WHERE id=?', [current.irrigation_zone_id]);
    if (!assignedZone || String(assignedZone.zone_uuid) !== String(input.zoneUuid)) {
      throw lifecycleError(404, 'device_not_found', 'device is not assigned to this zone', undefined, [deviceEui]);
    }
  }
  const state = discovered.states.find((item) => current.irrigation_zone_id != null && Number(item.zone.id) === Number(current.irrigation_zone_id)) || null;
  const targetState = operation === 'device_assign'
    ? await zoneState(tx, input.zoneId !== undefined ? input.zoneId : (input.zoneUuid || input.zone_uuid))
    : null;
  if (operation === 'device_assign' && !targetState) throw lifecycleError(404, 'zone_not_found', 'target zone does not exist');
  if (operation === 'device_assign' && input.requireZoneOwner
      && Number(targetState.zone.user_id) !== Number(input.actor && input.actor.user_id)) {
    throw lifecycleError(404, 'zone_not_found', 'target zone does not exist');
  }
  if (operation === 'device_assign' && input.requireUnassigned && current.irrigation_zone_id != null) throw lifecycleError(409, 'device_already_assigned', 'device is already assigned to a zone');
  const requestedVersion = input.syncVersion == null ? input.appliedSyncVersion : input.syncVersion;
  const versionAlreadyApplied = requestedVersion == null || Number(requestedVersion) === Number(current.sync_version || 0);
  if (operation === 'device_unassign' && current.irrigation_zone_id == null && versionAlreadyApplied) {
    return { device: current, changed_policies: [], clears: [], valve_euis: uniqueEuis([deviceEui]) };
  }
  if (operation === 'device_assign' && targetState && Number(current.irrigation_zone_id) === Number(targetState.zone.id)
      && versionAlreadyApplied
      && (!input.gatewayDeviceEui || String(input.gatewayDeviceEui).trim().toUpperCase() === String(current.gateway_device_eui || '').trim().toUpperCase())) {
    return { device: current, changed_policies: [], clears: [], valve_euis: uniqueEuis([deviceEui]) };
  }
  const policyWork = [];
  const mutationStates = operation === 'device_assign' ? [state] : [state, targetState];
  for (const candidateState of mutationStates) {
    if (!candidateState || !candidateState.policy || !affectedPoliciesForDevice(candidateState, deviceEui, operation).length) continue;
    if (!policyWork.some((item) => item.policy.policy_uuid === candidateState.policy.policy_uuid)) {
      policyWork.push({ policy: candidateState.policy, state: candidateState });
    }
  }
  const retiredByEui = new Map();
  let changedPolicy = [];
  for (const work of policyWork) {
    const policy = work.policy;
    const policyState = work.state;
    const shouldRetire = String(current.type_id).toUpperCase() === 'STREGA_VALVE' && policyState.schedules.some((row) => String(row.device_eui).toUpperCase() === deviceEui && row.condition_policy_uuid === policy.policy_uuid);
    if (shouldRetire) {
      const rows = policyState.schedules.filter((row) => String(row.device_eui).toUpperCase() === deviceEui && row.condition_policy_uuid === policy.policy_uuid);
      retiredByEui.set(deviceEui, rows);
      await pausePolicyTx(tx, policy, at, operation === 'device_unclaim' ? 'device_unclaimed' : 'device_membership_changed');
      await tx.run('UPDATE valve_schedules SET enabled=0, deleted_at=?, updated_at=?, sync_version=COALESCE(sync_version,0)+1 WHERE UPPER(device_eui)=UPPER(?) AND condition_policy_uuid=? AND deleted_at IS NULL', [at, at, deviceEui, policy.policy_uuid]);
      changedPolicy.push(policy.policy_uuid);
    } else {
      await pausePolicyTx(tx, policy, at, operation === 'device_unclaim' ? 'source_unclaimed' : 'source_removed');
      changedPolicy.push(policy.policy_uuid);
      const rows = policyState.schedules.filter((row) => row.condition_policy_uuid === policy.policy_uuid);
      for (const row of rows) {
        const key = String(row.device_eui).toUpperCase(); const list = retiredByEui.get(key) || []; list.push(row); retiredByEui.set(key, list);
      }
    }
  }
  if (String(current.type_id).toUpperCase() === 'STREGA_VALVE') await invalidateValveTx(tx, deviceEui, at, 'device_membership_changed');
  if (operation === 'device_unassign' || operation === 'device_unclaim') {
    if (operation === 'device_unclaim' && String(current.type_id).toUpperCase() === 'STREGA_VALVE') {
      const removed = await retireDeviceSchedulesTx(tx, deviceEui, at, { all: true });
      const existing = retiredByEui.get(deviceEui) || [];
      retiredByEui.set(deviceEui, [...existing, ...removed.before.filter((row) => !existing.some((prior) => prior.schedule_uuid === row.schedule_uuid))]);
    }
    const fields = operation === 'device_unclaim'
      ? 'user_id=NULL, irrigation_zone_id=NULL, gateway_device_eui=?'
      : 'irrigation_zone_id=NULL';
    const syncVersion = requestedSyncVersion(input, current);
    const params = operation === 'device_unclaim'
      ? [input.gatewayDeviceEui || input.gateway_device_eui || null, at, syncVersion, deviceEui]
      : [at, syncVersion, deviceEui];
    if (operation === 'device_unclaim' && input[CLOUD_S2120_UNCLAIM] === true) await clearCloudS2120WeatherLinksTx(tx, current, at, input.gatewayDeviceEui);
    await tx.run(`UPDATE devices SET ${fields}, updated_at=?, sync_version=? WHERE UPPER(deveui)=UPPER(?) AND deleted_at IS NULL`, params);
  } else if (operation === 'device_assign') {
    if (input.requireUnassigned && current.irrigation_zone_id != null && Number(current.irrigation_zone_id) !== Number(targetState.zone.id)) {
      throw lifecycleError(409, 'device_already_assigned', 'device is already assigned to a zone');
    }
    await tx.run('UPDATE devices SET irrigation_zone_id=?, gateway_device_eui=COALESCE(?,gateway_device_eui), updated_at=?, sync_version=? WHERE UPPER(deveui)=UPPER(?) AND deleted_at IS NULL', [targetState.zone.id, input.gatewayDeviceEui || input.gateway_device_eui || null, at, requestedSyncVersion(input, current), deviceEui]);
  }
  const clears = [];
    for (const [valveEui, rows] of retiredByEui) {
    const device = await tx.get('SELECT * FROM devices WHERE UPPER(deveui)=UPPER(?)', [valveEui]);
    if (!device || String(device.type_id).toUpperCase() !== 'STREGA_VALVE') continue;
    const policy = rows.find((row) => row.condition_policy_uuid) ? await tx.get('SELECT * FROM irrigation_policies WHERE policy_uuid=?', [rows.find((row) => row.condition_policy_uuid).condition_policy_uuid]) : null;
    const prepared = await prepareValveClearTx(tx, valveEui, at, { retiredSchedules: rows, policy });
    if (prepared) clears.push({ device_eui: valveEui, ...prepared });
  }
  return {
    device: await tx.get('SELECT * FROM devices WHERE UPPER(deveui)=UPPER(?)', [deviceEui]),
    changed_policies: changedPolicy,
    clears,
    schedules_cleared: (retiredByEui.get(deviceEui) || []).length,
    valve_euis: uniqueEuis([deviceEui].concat(discovered.states.flatMap(stateValveEuis))),
  };
}

// Issue #233 Phase A helpers. tx.run resolves undefined on the production facade, so every
// write below is proven by a read inside the same BEGIN IMMEDIATE transaction.
function s2120Error(status, code, text) {
  return lifecycleError(status, code, code + ': ' + text);
}

function s2120Eui(value) {
  const result = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return EUI_RE.test(result) ? result : null;
}

function s2120OptionalGateway(value) {
  if (value == null || String(value).trim() === '') return null;
  const result = s2120Eui(String(value));
  if (!result) throw s2120Error(409, 'invalid_gateway_binding', 'a stored gateway binding is not a 16-hex EUI');
  return result;
}

function s2120Version(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw s2120Error(409, 'invalid_version', 'a stored sync version is not a safe non-negative integer');
  return value;
}

function s2120Next(value) {
  const current = s2120Version(value);
  if (current >= Number.MAX_SAFE_INTEGER) throw s2120Error(409, 'version_overflow', 'the sync version cannot advance');
  return current + 1;
}

function s2120Nullable(value) {
  return value == null ? null : Number(value);
}

async function s2120GatewayContextTx(tx, device, zones, runtimeGatewayEui) {
  const link = await tx.get("SELECT linked, gateway_device_eui FROM sync_link_state WHERE peer_node='cloud'", []);
  const linked = Boolean(link) && Number(link.linked) === 1;
  const runtime = s2120Eui(runtimeGatewayEui);
  if (linked && !runtime) throw s2120Error(503, 'runtime_gateway_unavailable', 'the trusted gateway identity is unavailable');
  const linkGateway = s2120OptionalGateway(link && link.gateway_device_eui);
  if (linked && linkGateway && linkGateway !== runtime) throw s2120Error(503, 'link_gateway_transition', 'the gateway identity is changing');
  const deviceGateway = s2120OptionalGateway(device.gateway_device_eui);
  if (deviceGateway && runtime && deviceGateway !== runtime) throw s2120Error(409, 'device_gateway_mismatch', 'the station belongs to another gateway');
  for (const zone of zones) {
    const zoneGateway = s2120OptionalGateway(zone.gateway_device_eui);
    if (zoneGateway && runtime && zoneGateway !== runtime) throw s2120Error(409, 'zone_gateway_mismatch', 'the zone belongs to another gateway');
    if (!runtime && deviceGateway && zoneGateway && deviceGateway !== zoneGateway) throw s2120Error(409, 'zone_gateway_mismatch', 'the zone belongs to another gateway');
  }
  return { linked, runtime, deviceGateway };
}

async function s2120BindGatewayTx(tx, device, runtime) {
  await tx.run(
    "UPDATE devices SET gateway_device_eui=? WHERE deveui=? AND (gateway_device_eui IS NULL OR trim(gateway_device_eui)='') AND deleted_at IS NULL",
    [runtime, device.deveui]
  );
  const bound = await tx.get('SELECT gateway_device_eui FROM devices WHERE deveui=?', [device.deveui]);
  if (!bound || s2120Eui(bound.gateway_device_eui) !== runtime) throw s2120Error(500, 'gateway_postcondition_failed', 'the station gateway binding did not persist');
}

async function s2120BumpWeatherTx(tx, deveui, oldState, at) {
  if (!oldState) {
    await tx.run(
      'INSERT INTO weather_station_zone_state(deveui,sync_version,last_applied_at,updated_at) VALUES (?,0,NULL,?)',
      [deveui, at]
    );
    return 1;
  }
  const target = s2120Next(Number(oldState.sync_version));
  await tx.run(
    'UPDATE weather_station_zone_state SET sync_version=?,last_applied_at=NULL,updated_at=? WHERE deveui=? AND sync_version=?',
    [target, at, deveui, oldState.sync_version]
  );
  return target;
}

async function s2120OutboxAfterTx(tx, start, deveui) {
  return tx.all('SELECT rowid, op, payload_json FROM sync_outbox WHERE rowid>? AND aggregate_key=? ORDER BY rowid', [start, deveui]);
}

async function detachS2120WeatherPairTx(tx, input, current, discovered, at) {
  const deviceEui = String(current.deveui);
  if (String(current.type_id || '').toUpperCase() !== S2120_TYPE) throw s2120Error(404, 'device_not_found', 'the device is not a weather station');
  const zoneId = Number(input.zoneId);
  if (!Number.isSafeInteger(zoneId) || zoneId <= 0) throw s2120Error(400, 'invalid_zone_id', 'the zone id must be a positive integer');
  const zone = await tx.get('SELECT id, zone_uuid, gateway_device_eui FROM irrigation_zones WHERE id=? AND deleted_at IS NULL', [zoneId]);
  if (!zone || !UUID_RE.test(String(zone.zone_uuid || ''))) throw s2120Error(404, 'zone_not_found', 'the zone does not exist');
  const pair = await tx.get('SELECT 1 AS present FROM weather_station_zones WHERE deveui=? AND zone_id=?', [deviceEui, zoneId]);
  const primary = current.irrigation_zone_id != null && Number(current.irrigation_zone_id) === zoneId;
  if (!pair && !primary) throw s2120Error(404, 'device_not_found', 'the station is not assigned to this zone');
  const gateway = await s2120GatewayContextTx(tx, current, [zone], input.runtimeGatewayEui);
  const oldVersion = s2120Version(Number(current.sync_version == null ? 0 : current.sync_version));
  const state = await tx.get('SELECT sync_version FROM weather_station_zone_state WHERE deveui=?', [deviceEui]);
  if (state) s2120Version(Number(state.sync_version));
  if (gateway.linked && !gateway.deviceGateway) await s2120BindGatewayTx(tx, current, gateway.runtime);
  // The station leaves the selected zone, so that zone's policy work matches a primary detach.
  // When the primary is a different zone the station stays there and that zone gets none.
  const selectedState = discovered.states.find((item) => Number(item.zone.id) === zoneId) || null;
  const changedPolicy = [];
  const retiredByEui = new Map();
  if (selectedState && selectedState.policy && affectedPoliciesForDevice(selectedState, deviceEui, 'device_unassign').length) {
    await pausePolicyTx(tx, selectedState.policy, at, 'source_removed');
    changedPolicy.push(selectedState.policy.policy_uuid);
    for (const row of selectedState.schedules.filter((item) => item.condition_policy_uuid === selectedState.policy.policy_uuid)) {
      const key = String(row.device_eui).toUpperCase();
      const list = retiredByEui.get(key) || [];
      list.push(row);
      retiredByEui.set(key, list);
    }
  }
  const start = await tx.get('SELECT COALESCE(MAX(rowid),0) AS n FROM sync_outbox', []);
  if (pair) await tx.run('DELETE FROM weather_station_zones WHERE deveui=? AND zone_id=?', [deviceEui, zoneId]);
  const deviceVersion = primary ? s2120Next(oldVersion) : oldVersion;
  if (primary) {
    await tx.run(
      'UPDATE devices SET irrigation_zone_id=NULL, sync_version=?, updated_at=? WHERE deveui=? AND COALESCE(sync_version,0)=? AND irrigation_zone_id=? AND deleted_at IS NULL',
      [deviceVersion, at, deviceEui, oldVersion, zoneId]
    );
  }
  const weatherVersion = pair ? await s2120BumpWeatherTx(tx, deviceEui, state, at) : (state ? Number(state.sync_version) : 0);
  const after = await tx.get('SELECT * FROM devices WHERE deveui=? AND deleted_at IS NULL', [deviceEui]);
  const stillPaired = await tx.get('SELECT 1 AS present FROM weather_station_zones WHERE deveui=? AND zone_id=?', [deviceEui, zoneId]);
  const remaining = await tx.all(
    'SELECT wsz.zone_id, iz.zone_uuid FROM weather_station_zones wsz JOIN irrigation_zones iz ON iz.id=wsz.zone_id WHERE wsz.deveui=? AND iz.deleted_at IS NULL ORDER BY iz.zone_uuid',
    [deviceEui]
  );
  const afterState = await tx.get('SELECT sync_version FROM weather_station_zone_state WHERE deveui=?', [deviceEui]);
  if (!after || Number(after.sync_version) !== deviceVersion || stillPaired ||
      s2120Nullable(after.irrigation_zone_id) !== (primary ? null : s2120Nullable(current.irrigation_zone_id)) ||
      Number(afterState ? afterState.sync_version : 0) !== weatherVersion) {
    throw s2120Error(500, 'detach_postcondition_failed', 'the selected weather pair detach did not persist');
  }
  const emitted = await s2120OutboxAfterTx(tx, start.n, deviceEui);
  const weather = emitted.filter((row) => row.op === 'WEATHER_STATION_ZONES_REPLACED');
  if (weather.length !== (pair && gateway.linked ? 1 : 0)) {
    throw s2120Error(500, 'weather_outbox_postcondition_failed', 'the weather set event count is wrong');
  }
  if (weather.length && JSON.stringify(JSON.parse(weather[0].payload_json).zone_uuids) !== JSON.stringify(remaining.map((row) => row.zone_uuid))) {
    throw s2120Error(500, 'weather_set_postcondition_failed', 'the weather set event does not list the remaining zones');
  }
  const clears = [];
  for (const [valveEui, rows] of retiredByEui) {
    const valve = await tx.get('SELECT * FROM devices WHERE UPPER(deveui)=UPPER(?)', [valveEui]);
    if (!valve || String(valve.type_id).toUpperCase() !== 'STREGA_VALVE') continue;
    const policy = await tx.get('SELECT * FROM irrigation_policies WHERE policy_uuid=?', [selectedState.policy.policy_uuid]);
    const prepared = await prepareValveClearTx(tx, valveEui, at, { retiredSchedules: rows, policy });
    if (prepared) clears.push({ device_eui: valveEui, ...prepared });
  }
  return {
    device: after,
    changed_policies: changedPolicy,
    clears,
    schedules_cleared: 0,
    valve_euis: uniqueEuis([deviceEui].concat(discovered.states.flatMap(stateValveEuis))),
    weather_pair: {
      zone_id: zoneId,
      primary_cleared: primary,
      weather_sync_version: weatherVersion,
      zone_uuids: remaining.map((row) => row.zone_uuid),
    },
  };
}

// Runs only for the trusted cloud path (CLOUD_S2120_UNCLAIM), inside its device_unclaim
// transaction and before the device UPDATE, so the empty weather set event precedes
// DEVICE_UNCLAIMED while the station is still claimed and gateway-bound.
async function clearCloudS2120WeatherLinksTx(tx, current, at, gatewayDeviceEui) {
  if (String(current.type_id || '').toUpperCase() !== S2120_TYPE) throw s2120Error(409, 'device_type_changed', 'the cloud weather unclaim needs a weather station');
  const deviceEui = String(current.deveui);
  const runtime = s2120Eui(gatewayDeviceEui);
  if (!runtime) throw s2120Error(503, 'runtime_gateway_unavailable', 'the trusted gateway identity is unavailable');
  if (!s2120OptionalGateway(current.gateway_device_eui)) await s2120BindGatewayTx(tx, current, runtime);
  const links = await tx.all('SELECT zone_id FROM weather_station_zones WHERE deveui=?', [deviceEui]);
  if (!links.length) return;
  const state = await tx.get('SELECT sync_version FROM weather_station_zone_state WHERE deveui=?', [deviceEui]);
  if (state) s2120Version(Number(state.sync_version));
  await tx.run('DELETE FROM weather_station_zones WHERE deveui=?', [deviceEui]);
  const weatherVersion = await s2120BumpWeatherTx(tx, deviceEui, state, at);
  const left = await tx.get('SELECT COUNT(*) AS n FROM weather_station_zones WHERE deveui=?', [deviceEui]);
  const afterState = await tx.get('SELECT sync_version FROM weather_station_zone_state WHERE deveui=?', [deviceEui]);
  if (!left || Number(left.n) !== 0 || !afterState || Number(afterState.sync_version) !== weatherVersion) {
    throw s2120Error(500, 'weather_postcondition_failed', 'the cloud weather unclaim did not clear every link');
  }
}

function s2120Sorted(value) {
  if (Array.isArray(value)) return value.map(s2120Sorted);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((out, key) => {
      out[key] = s2120Sorted(value[key] === undefined ? null : value[key]);
      return out;
    }, {});
  }
  return value === undefined ? null : value;
}

function s2120BindingHash(envelope, gateway) {
  const bound = {
    commandId: envelope.commandId,
    eventUuid: envelope.eventUuid,
    commandType: envelope.commandType,
    aggregateType: envelope.aggregateType,
    aggregateKey: envelope.aggregateKey,
    appliedSyncVersion: envelope.appliedSyncVersion,
    effectKey: envelope.effectKey,
    leasedToGateway: envelope.leasedToGateway,
    payload: envelope.payload,
    runtimeGatewayDeviceEui: gateway,
  };
  return crypto.createHash('sha256').update(JSON.stringify(s2120Sorted(bound))).digest('hex');
}

// The legacy camelCase contract the server issues (DeviceController): exactly deviceEui,
// gatewayDeviceEui and syncVersion, optionally commandType UNCLAIM_DEVICE.
function s2120ParseLegacy(envelope, gateway, deviceEui) {
  const payload = envelope.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw s2120Error(400, 'malformed_command', 'the payload is not an object');
  if (!Number.isSafeInteger(payload.syncVersion) || payload.syncVersion <= 0) throw s2120Error(400, 'invalid_version', 'syncVersion must be a positive safe integer');
  const allowed = new Set(['deviceEui', 'gatewayDeviceEui', 'syncVersion', 'commandType']);
  const has = (key) => Object.prototype.hasOwnProperty.call(payload, key);
  if (Object.keys(payload).some((key) => !allowed.has(key)) ||
      !['deviceEui', 'gatewayDeviceEui', 'syncVersion'].every(has) ||
      (has('commandType') && payload.commandType !== 'UNCLAIM_DEVICE') ||
      s2120Eui(payload.deviceEui) !== deviceEui ||
      s2120Eui(payload.gatewayDeviceEui) !== gateway ||
      envelope.commandType !== 'UNCLAIM_DEVICE' ||
      envelope.aggregateType !== 'DEVICE' ||
      s2120Eui(envelope.aggregateKey) !== deviceEui ||
      typeof envelope.eventUuid !== 'string' || !UUID_RE.test(envelope.eventUuid) ||
      envelope.effectKey != null ||
      envelope.appliedSyncVersion !== payload.syncVersion) {
    throw s2120Error(400, 'malformed_command', 'the S2120 unclaim command does not match the legacy contract');
  }
  return payload.syncVersion;
}

function s2120Ack(ctx, result, version, code, duplicate, cleanup) {
  const envelope = ctx.envelope;
  const aggregateKey = s2120Eui(envelope.aggregateKey) === ctx.deviceEui ? envelope.aggregateKey : null;
  return {
    commandId: envelope.commandId,
    status: result === 'APPLIED' ? 'ACKED' : (result === 'CONFLICT' ? 'CONFLICT' : 'NACKED'),
    result,
    appliedAt: ctx.at,
    appliedSyncVersion: version,
    duplicate: duplicate === true,
    reason: code,
    detail: null,
    eventUuid: typeof envelope.eventUuid === 'string' && UUID_RE.test(envelope.eventUuid) ? envelope.eventUuid : null,
    commandType: envelope.commandType === 'UNCLAIM_DEVICE' ? 'UNCLAIM_DEVICE' : null,
    aggregateType: envelope.aggregateType === 'DEVICE' ? 'DEVICE' : null,
    aggregateKey,
    effectKey: null,
    gatewayDeviceEui: ctx.gateway,
    resourceUuid: aggregateKey,
    payloadHash: null,
    reasonCode: code,
    valveCleanup: cleanup,
  };
}

// One pending REST ACK per command id, byte-identical to the stored decision. A different or
// second pending row is never deleted or replaced: it fails closed.
async function s2120QueueAckTx(tx, commandId, raw, createdAt) {
  const id = String(commandId);
  const pending = await tx.all('SELECT id, payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL', [id]);
  if (pending.length > 1 || (pending.length === 1 && pending[0].payload_json !== raw)) {
    throw s2120Error(500, 'ack_outbox_binding_conflict', 'another pending ACK exists for this command');
  }
  if (pending.length) return;
  await tx.run('INSERT INTO command_ack_outbox(command_id,payload_json,created_at) VALUES (?,?,?)', [id, raw, createdAt]);
  const queued = await tx.all('SELECT payload_json FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL', [id]);
  if (queued.length !== 1 || queued[0].payload_json !== raw) throw s2120Error(500, 'ack_outbox_postcondition_failed', 'the pending ACK did not persist');
}

async function s2120TerminalTx(tx, ctx, result, version, code, duplicate, cleanup) {
  const ack = s2120Ack(ctx, result, version, code, duplicate, cleanup);
  const raw = JSON.stringify(ack);
  const id = String(ctx.envelope.commandId);
  await tx.run(
    'INSERT INTO applied_commands(command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator,binding_hash,resource_type,resource_id,gateway_device_eui) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    [id, ctx.deviceEui, 'UNCLAIM_DEVICE', null, ack.appliedAt, result, raw, 'cloud', ctx.hash, 'DEVICE', ctx.deviceEui, ctx.gateway]
  );
  const stored = await tx.get('SELECT result_detail, binding_hash FROM applied_commands WHERE command_id=?', [id]);
  if (!stored || stored.result_detail !== raw || stored.binding_hash !== ctx.hash) throw s2120Error(500, 'ledger_postcondition_failed', 'the terminal decision did not persist');
  await s2120QueueAckTx(tx, ctx.envelope.commandId, raw, ack.appliedAt);
  return { ack, clears: [] };
}

// Classifies both identities of a cloud UNCLAIM_DEVICE. A disagreement is handled as a
// malformed S2120 command, never passed to the generic path.
async function s2120UnclaimIdentity(db, envelope) {
  const payload = envelope && envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload) ? envelope.payload : {};
  const fromPayload = s2120Eui(payload.deviceEui);
  const candidates = [...new Set([s2120Eui(envelope && envelope.aggregateKey), fromPayload].filter(Boolean))];
  if (!candidates.length) return { station: null, userId: null };
  const rows = await db.all(
    'SELECT UPPER(deveui) AS deveui, type_id, user_id FROM devices WHERE deleted_at IS NULL AND UPPER(deveui) IN (' + candidates.map(() => '?').join(',') + ')',
    candidates
  );
  const stations = rows.filter((row) => String(row.type_id || '').toUpperCase() === S2120_TYPE);
  if (!stations.length) return { station: null, userId: null };
  const chosen = stations.find((row) => row.deveui === fromPayload) || stations[0];
  return { station: chosen.deveui, userId: chosen.user_id == null ? null : chosen.user_id };
}

async function s2120CloudUnclaimTx(tx, ctx) {
  const { envelope, gateway, deviceEui, hash } = ctx;
  const link = await tx.get("SELECT linked, gateway_device_eui FROM sync_link_state WHERE peer_node='cloud'", []);
  if (!link || Number(link.linked) !== 1) return { hold: 'link_inactive' };
  const linkGateway = link.gateway_device_eui == null ? '' : String(link.gateway_device_eui).trim();
  if (linkGateway !== '' && s2120Eui(linkGateway) !== gateway) return { hold: 'link_gateway_transition' };
  try {
    await assertLinkFence(tx);
  } catch (error) {
    if (error && error.code === 'link_in_progress') return { hold: 'link_in_progress' };
    throw error;
  }
  const prior = await tx.get(
    'SELECT command_id, device_eui, command_type, originator, binding_hash, gateway_device_eui, result_detail FROM applied_commands WHERE command_id=?',
    [String(envelope.commandId)]
  );
  if (prior) {
    if (prior.command_type !== 'UNCLAIM_DEVICE' || prior.originator !== 'cloud' ||
        prior.device_eui !== deviceEui || prior.gateway_device_eui !== gateway ||
        prior.binding_hash !== hash) {
      throw s2120Error(409, 'command_id_binding_conflict', 'this command id is bound to a different decision');
    }
    let stored;
    try {
      stored = JSON.parse(prior.result_detail);
    } catch (parseError) {
      throw s2120Error(409, 'command_id_binding_conflict', 'the stored decision is unreadable: ' + String(parseError && parseError.message || parseError));
    }
    if (!stored || stored.commandId !== envelope.commandId || stored.commandType !== 'UNCLAIM_DEVICE' ||
        (stored.aggregateKey !== null && stored.aggregateKey !== envelope.aggregateKey) ||
        (stored.eventUuid !== null && stored.eventUuid !== envelope.eventUuid)) {
      throw s2120Error(409, 'command_id_binding_conflict', 'the stored decision names another command');
    }
    await s2120QueueAckTx(tx, envelope.commandId, prior.result_detail, ctx.at);
    return { ack: stored, replay: true, clears: [] };
  }
  const device = await tx.get(
    'SELECT deveui, type_id, user_id, irrigation_zone_id, sync_version, gateway_device_eui FROM devices WHERE UPPER(deveui)=? AND deleted_at IS NULL',
    [deviceEui]
  );
  if (!device || String(device.type_id || '').toUpperCase() !== S2120_TYPE) return { hold: 'type_changed_or_missing' };
  const terminal = (result, version, code, duplicate, cleanup) => s2120TerminalTx(tx, ctx, result, version, code, duplicate, cleanup);
  const refused = (code) => unclaimValveCleanup({ deviceEui, refused: { code } });
  let current;
  try {
    current = s2120Version(Number(device.sync_version == null ? 0 : device.sync_version));
  } catch (error) {
    return terminal('REJECTED_PERMANENT', 0, 'invalid_version', false, refused('invalid_version'));
  }
  let target;
  try {
    target = s2120ParseLegacy(envelope, gateway, deviceEui);
  } catch (error) {
    if (!error || !['malformed_command', 'invalid_version'].includes(error.code)) throw error;
    return terminal('REJECTED_PERMANENT', current, error.code, false, refused(error.code));
  }
  const zones = await tx.all(
    'SELECT wsz.zone_id, iz.zone_uuid, iz.gateway_device_eui, iz.deleted_at FROM weather_station_zones wsz LEFT JOIN irrigation_zones iz ON iz.id=wsz.zone_id WHERE wsz.deveui=? ORDER BY wsz.zone_id',
    [device.deveui]
  );
  try {
    const deviceGateway = s2120OptionalGateway(device.gateway_device_eui);
    if (deviceGateway && deviceGateway !== gateway) throw s2120Error(409, 'device_gateway_mismatch', 'the station belongs to another gateway');
    for (const zone of zones) {
      const zoneGateway = s2120OptionalGateway(zone.gateway_device_eui);
      if (zoneGateway && zoneGateway !== gateway) throw s2120Error(409, 'zone_gateway_mismatch', 'a linked zone belongs to another gateway');
    }
  } catch (error) {
    if (!error || !['invalid_gateway_binding', 'device_gateway_mismatch', 'zone_gateway_mismatch'].includes(error.code)) throw error;
    return terminal('CONFLICT', current, error.code, false, refused(error.code));
  }
  if (target < current) return terminal('CONFLICT', current, 'stale_sync_version', false, refused('stale_sync_version'));
  if (target === current) {
    const complete = device.user_id == null && device.irrigation_zone_id == null && zones.length === 0;
    return complete
      ? terminal('APPLIED', current, null, true, unclaimValveCleanup({ deviceEui, mutation: { device } }))
      : terminal('CONFLICT', current, 'equal_version_postcondition_failed', false, refused('equal_version_postcondition_failed'));
  }
  if (current >= Number.MAX_SAFE_INTEGER || target !== current + 1) return terminal('CONFLICT', current, 'version_gap', false, refused('version_gap'));
  if (device.user_id == null) {
    const code = zones.length || device.irrigation_zone_id != null ? 'orphaned_weather_links' : 'version_gap';
    return terminal('CONFLICT', current, code, false, refused(code));
  }
  if (ctx.expectedUserId == null || Number(ctx.expectedUserId) !== Number(device.user_id)) {
    return terminal('CONFLICT', current, 'stale_device_state', false, refused('stale_device_state'));
  }
  const start = await tx.get('SELECT COALESCE(MAX(rowid),0) AS n FROM sync_outbox', []);
  const input = Object.assign({}, ctx.input, { syncVersion: target });
  const held = await discoverAffectedWriters(tx, 'device_unclaim', input);
  assertHeld(ctx.heldValveEuis, held.valveEuis, 'device_unclaim');
  const mutation = await applyLifecycleMutationTx(tx, 'device_unclaim', input);
  const post = await discoverAffectedWriters(tx, 'device_unclaim', input);
  assertHeld(ctx.heldValveEuis, post.valveEuis, 'device_unclaim');
  const after = await tx.get('SELECT user_id, irrigation_zone_id, sync_version FROM devices WHERE deveui=? AND deleted_at IS NULL', [device.deveui]);
  const left = await tx.get('SELECT COUNT(*) AS n FROM weather_station_zones WHERE deveui=?', [device.deveui]);
  if (!after || after.user_id != null || after.irrigation_zone_id != null ||
      Number(after.sync_version) !== target || !left || Number(left.n) !== 0) {
    throw s2120Error(500, 'unclaim_postcondition_failed', 'the cloud unclaim did not persist');
  }
  const emitted = await s2120OutboxAfterTx(tx, start.n, device.deveui);
  const weather = emitted.filter((row) => row.op === 'WEATHER_STATION_ZONES_REPLACED');
  const unclaimed = emitted.filter((row) => row.op === 'DEVICE_UNCLAIMED');
  if (weather.length !== (zones.length ? 1 : 0) || unclaimed.length !== 1 ||
      (weather.length && weather[0].rowid >= unclaimed[0].rowid) ||
      (weather.length && JSON.stringify(JSON.parse(weather[0].payload_json).zone_uuids) !== '[]')) {
    throw s2120Error(500, 'unclaim_outbox_postcondition_failed', 'the empty weather set must precede DEVICE_UNCLAIMED');
  }
  const done = await terminal('APPLIED', target, null, false, unclaimValveCleanup({ deviceEui, mutation }));
  return { ack: done.ack, clears: mutation.clears || [] };
}

// Issue #233 Phase A: the cloud UNCLAIM_DEVICE of a SENSECAP_S2120. Holds return { hold } and
// write nothing; a terminal decision returns { ack } after its COMMIT. It never answers
// FAILED_RETRYABLE: the server makes the fifth retryable answer for this unprotected command
// terminal, so a transient state must not consume that budget.
async function applyS2120CloudUnclaim(options = {}) {
  const db = options.db;
  if (!db || typeof db.transaction !== 'function') throw new TypeError('applyS2120CloudUnclaim requires a transactional db facade');
  const envelope = options.envelope && typeof options.envelope === 'object' && !Array.isArray(options.envelope) ? options.envelope : null;
  if (!envelope || !Number.isSafeInteger(envelope.commandId) || envelope.commandId <= 0) return { hold: 'invalid_command_id' };
  const gateway = s2120Eui(options.runtimeGatewayEui);
  const lease = s2120Eui(envelope.leasedToGateway);
  if (!gateway || !lease || lease !== gateway) return { hold: 'lease_gateway_unavailable_or_mismatch' };
  const payload = envelope.payload && typeof envelope.payload === 'object' && !Array.isArray(envelope.payload) ? envelope.payload : {};
  const deviceEui = s2120Eui(options.stationEui);
  if (!deviceEui || (deviceEui !== s2120Eui(envelope.aggregateKey) && deviceEui !== s2120Eui(payload.deviceEui))) return { hold: 'unidentifiable_device' };
  const at = instant(options.now);
  const input = { deviceEui, gatewayDeviceEui: gateway, now: at, [CLOUD_S2120_UNCLAIM]: true };
  const ctx = { envelope, gateway, deviceEui, hash: s2120BindingHash(envelope, gateway), at, input, expectedUserId: options.expectedUserId };
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const discovered = await discoverAffectedWriters(db, 'device_unclaim', input);
    try {
      return await dispatch.withValveWriters(discovered.valveEuis, async () => {
        const outcome = await db.transaction((tx) => s2120CloudUnclaimTx(tx, Object.assign({}, ctx, { heldValveEuis: discovered.valveEuis })));
        if (outcome.hold) return outcome;
        const clearResults = outcome.clears && outcome.clears.length
          ? await sendClears(db, outcome.clears, { transport: options.transport, warn: options.warn }, at)
          : [];
        return { ack: outcome.ack, gateway, replay: outcome.replay === true, clear_results: clearResults };
      });
    } catch (error) {
      if (error && error.code === 'membership_drift') continue;
      throw error;
    }
  }
  return { hold: 'membership_drift' };
}

async function applyLegacyWriteTx(tx, input = {}) {
  const state = (await stateForOperation(tx, 'legacy_schedule_write', input)).states[0];
  if (!state) throw lifecycleError(404, 'zone_not_found', 'zone does not exist');
  const patch = input.patch || input.schedule || {};
  if (state.policy && state.policy.deleted_at == null) {
    const explicitDisabled = explicitlyDisabled(patch);
    if (!explicitDisabled) throw lifecycleError(409, 'managed_schedule_conflict', 'legacy schedule writes are disabled while a conditional policy exists');
    const wasEnabled = Number(state.policy.enabled) === 1 || state.legacy.some((row) => Number(row.enabled) === 1);
    const policy = await pausePolicyTx(tx, state.policy, instant(input.now), 'legacy_schedule_disabled');
    const legacyChanges = await disableLegacyTx(tx, state, instant(input.now), input);
    const clears = [];
    const byEui = new Map();
    for (const row of state.schedules.filter((item) => item.condition_policy_uuid === state.policy.policy_uuid)) {
      const list = byEui.get(String(row.device_eui).toUpperCase()) || []; list.push(row); byEui.set(String(row.device_eui).toUpperCase(), list);
    }
    for (const [valveEui, rows] of byEui) {
      const device = await tx.get('SELECT * FROM devices WHERE UPPER(deveui)=UPPER(?) AND deleted_at IS NULL', [valveEui]);
      if (device && String(device.type_id).toUpperCase() === 'STREGA_VALVE') {
        const prepared = await prepareValveClearTx(tx, valveEui, instant(input.now), { retiredSchedules: rows, policy });
        if (prepared) clears.push({ device_eui: valveEui, ...prepared });
      }
    }
    return { managed: true, policy, disabledSchedules: wasEnabled || legacyChanges ? 1 : 0, clears, valve_euis: uniqueEuis(stateValveEuis(state)) };
  }
  const schedule = await updateLegacyTx(tx, state, patch, instant(input.now), input);
  return { managed: false, schedule, disabledSchedules: patch.enabled === false ? 1 : 0, clears: [], valve_euis: uniqueEuis(stateValveEuis(state)) };
}

async function applyLifecycleMutationTx(tx, operation, input = {}) {
  await assertLinkFence(tx);
  const version = await classifyVersionTx(tx, operation, input);
  if (version && version.replayed) return version;
  if (operation === 'legacy_schedule_write') return applyLegacyWriteTx(tx, input);
  return applyOperationTx(tx, operation, input);
}

async function sendClears(db, clears, options, at) {
  const results = [];
  for (const clear of clears || []) {
    try {
      const pendingResult = (value) => {
        if (value && !value.pending && value.obsolete !== true &&
            value.readiness && value.readiness.state && value.readiness.state !== 'READY') {
          return { ...value, pending: true };
        }
        return value;
      };
      if (typeof options.sendPreparedLifecycleClear === 'function') {
        results.push(pendingResult(await options.sendPreparedLifecycleClear({ db, ...clear, transport: options.transport, now: at, warn: options.warn })));
      } else if (options.transport) {
        results.push(pendingResult(await push.sendPreparedLifecycleClear({ db, deviceEui: clear.device_eui, revision: clear.revision, transport: options.transport, now: at, warn: options.warn })));
      } else {
        results.push({ pending: true, device_eui: clear.device_eui, revision: clear.revision, reason: 'transport_unavailable' });
      }
    } catch (error) {
      // The canonical retirement is already committed. A transport exception
      // records an uncertain clear and leaves its persisted intent for retry;
      // it must never re-enter the mutation transaction or repeat versions.
      results.push({
        pending: true,
        transport_uncertain: true,
        device_eui: clear.device_eui,
        revision: clear.revision,
        reason: error && error.code || 'transport_failed',
        error: error && error.message || String(error),
      });
    }
  }
  return results;
}

// Owner decision 2026-10-22: an unclaimed valve loses its queued opens through the D19(a) cancel
// path (osi-valve-control cancelForUnclaim). Never a CLOSE; a running open runs out its bounded
// duration. Undefined for a device that is not a valve. The caller holds the valve writer.
async function cancelUnclaimedValveActuations(db, device, options = {}, at) {
  if (!device || String(device.type_id || '').toUpperCase() !== 'STREGA_VALVE') return undefined;
  try {
    return await valveCancel.cancelForUnclaim({ db, deviceEui: device.deveui, transport: options.transport || null, now: new Date(instant(at)), warn: options.warn });
  } catch (error) {
    return { state: 'uncertain', error: String(error && error.message || error), results: [], collateral: [], whole_queue_flushed: false };
  }
}

async function sendLifecycleClears(db, clears, options = {}, at) {
  return sendClears(db, clears, options, instant(at));
}

async function applyLifecycleMutation(options = {}) {
  const db = options.db;
  if (!db || typeof db.transaction !== 'function') throw new TypeError('applyLifecycleMutation requires a transactional db facade');
  const operation = String(options.operation || options.kind || '').trim().toLowerCase();
  if (!OPERATIONS.has(operation)) throw lifecycleError(400, 'unsupported_lifecycle_operation', 'unsupported lifecycle operation');
  const input = { ...options, ...(options.input || {}), now: options.now == null ? new Date().toISOString() : options.now };
  let lastDrift;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const discovered = await discoverAffectedWriters(db, operation, input);
    try {
      const result = await dispatch.withValveWriters(discovered.valveEuis, async () => {
        if (typeof options.authorizeAfterWriters === 'function') await options.authorizeAfterWriters(db, input);
        const committed = await db.transaction(async (tx) => {
          const current = await discoverAffectedWriters(tx, operation, input);
          assertHeld(discovered.valveEuis, current.valveEuis, operation);
          if (typeof options.authorizeTx === 'function') await options.authorizeTx(tx, input);
          const value = await applyLifecycleMutationTx(tx, operation, input);
          const post = await discoverAffectedWriters(tx, operation, input);
          assertHeld(discovered.valveEuis, post.valveEuis, operation);
          return value;
        });
        const at = instant(input.now);
        // Owner decision 2026-10-22: queued opens go before the clear is sent (the cancel's
        // whole-queue flush would otherwise remove the clearing plan too).
        const inFlight = operation === 'device_unclaim' && !committed.replayed
          ? await cancelUnclaimedValveActuations(db, committed.device, options, at)
          : undefined;
        const clearResults = await sendClears(db, committed.clears, options, at);
        return { ...committed, ...(inFlight ? { in_flight_cancel: inFlight } : {}), clear_results: clearResults };
      });
      const pending = (result.clear_results || []).some((item) => item && (
        item.pending || item.obsolete === false || item.transport_uncertain || item.blocked ||
        item.readiness && item.readiness.state && item.readiness.state !== 'READY'
      ));
      return { status: pending ? 202 : 200, operation, ...result };
    } catch (error) {
      if (error && error.code === 'membership_drift') { lastDrift = error; continue; }
      throw error;
    }
  }
  throw lastDrift || lifecycleError(409, 'membership_drift', 'affected valve membership kept changing; retry lifecycle operation');
}

// S6 (owner decision 2026-10-22): this service owns unclaim on both paths, the local DELETE
// and the cloud UNCLAIM_DEVICE, and reports W1's AUTH-09 cleanup outcome: the keys and the
// vocabulary of osi-valve-control runUnclaimCleanup, so the cloud maps one contract. The
// schedules are retired in the unclaim transaction and the clearing plan is a durable
// lifecycle clear revision (clearing_scheduled): sent after commit, and when that send could not
// run (no transport, flush failed), by the valve tick once ChirpStack answers
// (push.emitPendingClears, R19 finding 1). The
// outcome says what the cleanup did and never that the plan is gone: the valve has no
// read-back, so may_still_hold_plan stays true and plan_clear_confirmed false. Nothing here
// sends a CLOSE. The lifecycle does not cancel an in-flight actuation, so in_flight_cancel is
// null (not attempted); the clear's queue flush waits behind an active owner instead.
function unclaimCleanupOutcome(fields) {
  return Object.assign({
    outcome: null,
    reason: null,
    attempted: false,
    device_eui: null,
    schedules_cleared: null,
    clearing_downlinks_sent: 0,
    in_flight_cancel: null,
    in_flight_cancel_error: null,
    whole_queue_flushed: null,
    may_still_hold_plan: null,
    plan_clear_confirmed: false,
    // false only on the commit-time ACK of a valve unclaim whose in-flight cancel is still to run;
    // the amended ACK (or a new ACK row after delivery) carries true. The cloud (osi-server
    // c215e2a3c) keeps the more final one.
    final: true,
  }, fields);
}

function unclaimValveCleanup({ deviceEui, mutation, refused, error, final = true } = {}) {
  return Object.assign(unclaimValveCleanupOutcome({ deviceEui, mutation, refused, error }), { final: final !== false });
}

function unclaimValveCleanupOutcome({ deviceEui, mutation, refused, error } = {}) {
  const target = String(deviceEui || '').trim().toUpperCase() || null;
  const device = mutation && mutation.device || null;
  const isValve = Boolean(device) && String(device.type_id || '').toUpperCase() === 'STREGA_VALVE';
  if (error) {
    return unclaimCleanupOutcome({
      outcome: 'failed', reason: 'error: ' + String(error && error.message || error), attempted: true,
      device_eui: target, may_still_hold_plan: isValve ? true : null,
    });
  }
  if (refused) {
    const code = String(refused.code || refused.message || 'refused');
    if (code === 'device_not_found') return unclaimCleanupOutcome({ outcome: 'not_applicable', reason: 'not_found', device_eui: target });
    return unclaimCleanupOutcome({ outcome: 'not_attempted', reason: code, device_eui: target });
  }
  if (!device) return unclaimCleanupOutcome({ outcome: 'not_applicable', reason: 'not_found', device_eui: target });
  if (!isValve) {
    return unclaimCleanupOutcome({ outcome: 'not_applicable', reason: 'not_a_valve', device_eui: target, may_still_hold_plan: false });
  }
  const inFlight = mutation.in_flight_cancel || null;
  const inFlightFields = inFlight
    ? { in_flight_cancel: inFlight.state, in_flight_cancel_error: inFlight.error || null }
    : {};
  const inFlightNote = inFlightReason(inFlight);
  const withNote = (reason) => [reason, inFlightNote].filter(Boolean).join('; ') || null;
  const clear = (mutation.clears || []).find((item) => eui(item.device_eui) === target) || null;
  const schedulesCleared = Number(mutation.schedules_cleared || 0);
  if (!clear) {
    return unclaimCleanupOutcome({
      outcome: 'no_plan_to_clear', reason: withNote(null), attempted: true, device_eui: target, schedules_cleared: schedulesCleared,
      ...inFlightFields,
      whole_queue_flushed: inFlight ? inFlight.whole_queue_flushed === true : null,
      may_still_hold_plan: null,
    });
  }
  const sent = (mutation.clear_results || []).filter((item) => item && (item.device_eui == null || eui(item.device_eui) === target));
  const flushes = sent.map((item) => item.flush).filter(Boolean);
  const waiting = flushes.find((flush) => flush.skipped) || null;
  const failed = sent.find((item) => item.transport_uncertain || (item.readiness && item.readiness.state === 'FAILED')) || null;
  let reason = null;
  if (waiting) reason = 'clear_waits_for: ' + String(waiting.phase || 'owner');
  else if (failed) reason = 'clear_send_pending: ' + String(failed.reason || (failed.readiness && failed.readiness.reason) || 'retry');
  const clearFlushed = flushes.length ? flushes.some((flush) => flush.ok === true && !flush.skipped) : null;
  const cancelFlushed = inFlight ? inFlight.whole_queue_flushed === true : null;
  return unclaimCleanupOutcome({
    outcome: 'clearing_scheduled',
    reason: withNote(reason),
    attempted: true,
    device_eui: target,
    schedules_cleared: schedulesCleared,
    clearing_downlinks_sent: sent.reduce((total, item) => total + Number(item.sent || 0), 0),
    ...inFlightFields,
    whole_queue_flushed: clearFlushed === true || cancelFlushed === true ? true : (clearFlushed === null && cancelFlushed === null ? null : false),
    may_still_hold_plan: true,
  });
}

// What the in-flight cancel means for the operator, appended to the cleanup reason.
function inFlightReason(inFlight) {
  if (!inFlight) return null;
  if (inFlight.state === 'already_running') {
    const ends = (inFlight.results || []).filter((r) => r.outcome === 'already_running').map((r) => r.expected_close_at).filter(Boolean).sort();
    return 'open_running: closes by itself' + (ends.length ? ' at ' + ends[ends.length - 1] : '');
  }
  if (inFlight.state === 'handed_off') return 'queued_open_may_have_been_sent';
  if (inFlight.state === 'uncertain') return 'in_flight_cancel_uncertain' + (inFlight.error ? ': ' + inFlight.error : '');
  if (inFlight.state === 'not_attempted') return 'in_flight_cancel_not_attempted' + (inFlight.error ? ': ' + inFlight.error : '');
  return null;
}

// The ACK reason W1 sets beside valveCleanup; a sensor keeps the old ACK reason.
function unclaimAckReason(cleanup) {
  if (!cleanup || cleanup.outcome === 'not_applicable') return undefined;
  return 'valve_cleanup_' + cleanup.outcome + (cleanup.reason ? ': ' + cleanup.reason : '');
}

module.exports = {
  OPERATIONS,
  S2120_WEATHER_PAIR,
  s2120UnclaimIdentity,
  applyS2120CloudUnclaim,
  unclaimValveCleanup,
  unclaimAckReason,
  cancelUnclaimedValveActuations,
  lifecycleError,
  discoverAffectedWriters,
  assertHeld,
  applyLifecycleMutation,
  applyLifecycleMutationTx,
  applyZoneDeleteTx,
  sendLifecycleClears,
  pausePolicyTx,
  retirePolicyAndSchedulesTx,
};
