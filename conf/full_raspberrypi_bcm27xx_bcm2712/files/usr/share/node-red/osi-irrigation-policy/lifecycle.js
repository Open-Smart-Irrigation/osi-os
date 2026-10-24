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

const EUI_RE = /^[0-9A-F]{16}$/;
const MAX_RETRIES = 3;
const OPERATIONS = new Set([
  'legacy_schedule_write', 'disable_all', 'zone_delete',
  'device_assign', 'device_unassign', 'device_unclaim',
]);

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
// lifecycle clear revision that goes out with the next snapshot (clearing_scheduled). The
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
