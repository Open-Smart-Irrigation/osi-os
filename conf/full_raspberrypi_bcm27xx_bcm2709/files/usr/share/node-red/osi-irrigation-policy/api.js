'use strict';

// The policy API is deliberately a service first.  Local Node-RED routes and
// the later cloud command adapter call these functions; they do not duplicate
// schedule or conditional-control writes.  All mutation SQL below runs through
// the caller's scoped transaction object.  Writer acquisition and transport
// calls are outside that transaction.

const crypto = require('node:crypto');
const model = require('./model');
const observations = require('./observations');
const policyStore = require('./store');
const clock = require('./clock');
const { parseInstant } = require('./timestamps');
const { occurrencesBetween } = require('./occurrences');
const effects = require('../osi-valve-control/effects');
const dispatch = require('../osi-valve-control/dispatch');
const valveStore = require('../osi-valve-control/store');
const push = require('../osi-valve-control/push');
const cancel = require('../osi-valve-control/cancel');
const { readClockBounds, assertClockBoundsAtActivation } = require('./clock-bounds');

const EUI_RE = /^[0-9A-F]{16}$/;
const UUID_RE = /^[0-9A-Fa-f-]{8,}$/;
const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
};
const MAX_BODY_BYTES = 256 * 1024;
const MAX_RETRIES = 3;

function apiError(statusCode, code, message, details, affectedIds) {
  const error = new Error(message || code);
  error.statusCode = statusCode;
  error.code = code;
  if (details !== undefined) error.details = details;
  if (affectedIds !== undefined) error.affected_ids = [...new Set((affectedIds || []).map(String))];
  return error;
}

function normalizeEui(value, name = 'device_eui') {
  const eui = String(value == null ? '' : value).trim().toUpperCase();
  if (!EUI_RE.test(eui)) throw apiError(422, 'invalid_device_eui', `${name} must be 16 hexadecimal characters`);
  return eui;
}

function parseObject(value, code, fallback = {}) {
  if (value == null || value === '') return fallback;
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object');
    return parsed;
  } catch (_) {
    throw apiError(422, code, `${code} must be a JSON object`);
  }
}

function isoNow(value) {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw apiError(422, 'invalid_activation_time', 'internal activation instant is invalid');
  return new Date(ms).toISOString();
}

function internalNow(options) {
  // `now` is an internal test/worker seam.  HTTP request fields are never read
  // here, so a caller cannot make an enabled policy effective in the past.
  const source = options && options.now !== undefined ? options.now : Date.now();
  return source instanceof Date ? source.getTime() : typeof source === 'number' ? source : Date.parse(source);
}

function strictKeys(value, allowed, code = 'unknown_field') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length) throw apiError(400, code, `unsupported field: ${unknown[0]}`, { field: unknown[0] });
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value || {}, key);
}

function zoneIdentity(row) {
  return row && { id: Number(row.id), zone_uuid: String(row.zone_uuid) };
}

async function assertRequestZoneBinding(db, zone, request, { allowMissing = true } = {}) {
  if (!request || typeof request !== 'object') return;
  const sources = [{ name: 'request', value: request }];
  if (request.policy && typeof request.policy === 'object' && !Array.isArray(request.policy)) {
    sources.push({ name: 'policy', value: request.policy });
  }
  const supplied = [];
  for (const source of sources) {
    for (const key of ['zone_uuid', 'zone_id', 'zoneRef']) {
      if (!hasOwn(source.value, key) || source.value[key] == null || source.value[key] === '') continue;
      supplied.push({ key: source.name + '.' + key, value: source.value[key] });
    }
  }
  if (!supplied.length && allowMissing) return;
  for (const item of supplied) {
    const candidate = await zoneRow(db, item.value);
    if (Number(candidate.id) !== Number(zone.id) || String(candidate.zone_uuid) !== String(zone.zone_uuid)) {
      throw apiError(409, 'zone_identity_conflict', 'request zone identity does not match the authorized route zone', {
        route: zoneIdentity(zone), supplied: { field: item.key, value: item.value },
      }, [zone.zone_uuid, candidate.zone_uuid]);
    }
  }
}

function parseConditionInput(condition) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) throw apiError(422, 'invalid_condition', 'condition must be an object');
  const kind = String(condition.kind || '').toUpperCase();
  const allowed = kind === 'SWT' ? new Set(['kind', 'threshold_kpa', 'sources'])
    : kind === 'VWC' ? new Set(['kind', 'threshold_percent', 'sources'])
      : new Set(['kind', 'minimum_stress', 'response_mode']);
  strictKeys(condition, allowed, 'unknown_condition_field');
  const value = { ...condition, kind };
  const result = model.validateCondition(value);
  if (!result.ok) throw apiError(422, result.error, result.error, result.details);
  return result.value;
}

function normalizeDeliverySettings(value) {
  if (value == null) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw apiError(422, 'invalid_delivery_settings', 'delivery_settings must be an object');
  const result = {};
  const seen = new Set();
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizeEui(rawKey, 'delivery_settings key');
    if (seen.has(key)) throw apiError(422, 'duplicate_delivery_settings_key', 'delivery_settings contains duplicate canonical keys', { device_eui: key });
    seen.add(key);
    strictKeys(rawValue, new Set(['delivery_interval_minutes']), 'unknown_delivery_settings_field');
    const interval = rawValue && rawValue.delivery_interval_minutes;
    if (!Number.isInteger(interval) || interval < 1 || interval > 60) throw apiError(422, 'invalid_delivery_interval', 'delivery_interval_minutes must be an integer from 1 to 60', { device_eui: key });
    result[key] = { delivery_interval_minutes: interval };
  }
  return result;
}

function policyFromRow(row) {
  if (!row) return null;
  return {
    ...row,
    policy_uuid: row.policy_uuid,
    zone_uuid: row.zone_uuid,
    condition: parseObject(row.condition_json, 'condition_json'),
    delivery_settings: parseObject(row.delivery_settings_json, 'delivery_settings_json'),
    enabled: Number(row.enabled) === 1,
  };
}

function currentPolicyInput(row) {
  const policy = policyFromRow(row);
  if (!policy) return {};
  return {
    policy_uuid: policy.policy_uuid,
    zone_uuid: policy.zone_uuid,
    condition: policy.condition,
    timezone: policy.timezone,
    enabled: policy.enabled,
    observation_window_minutes: Number(policy.observation_window_minutes),
    min_interval_minutes: Number(policy.min_interval_minutes),
    max_daily_minutes: Number(policy.max_daily_minutes),
    delivery_settings: policy.delivery_settings,
    effective_from: policy.effective_from,
    sync_version: Number(policy.sync_version),
  };
}

function normalizeEnabled(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  throw apiError(422, 'invalid_enabled', 'enabled must be boolean');
}

function scheduleInputList(request) {
  const list = request.schedule_edits !== undefined ? request.schedule_edits : request.schedules;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw apiError(400, 'invalid_schedule_edits', 'schedules must be an array');
  return list;
}

function validateScheduleInputShape(input, index) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw apiError(400, 'invalid_schedule', `schedules[${index}] must be an object`);
  strictKeys(input, new Set(['schedule_uuid', 'expected_sync_version', 'device_eui', 'weekdays_mask', 'start_time', 'duration_minutes', 'enabled', 'execution', 'label', 'detach', 'kind']), 'unknown_schedule_field');
  if (input.schedule_uuid != null && (!UUID_RE.test(String(input.schedule_uuid)) || String(input.schedule_uuid).length > 128)) throw apiError(422, 'invalid_schedule_uuid', `schedules[${index}].schedule_uuid is invalid`);
  if (input.expected_sync_version !== undefined && input.expected_sync_version !== null
      && (!Number.isInteger(input.expected_sync_version) || input.expected_sync_version < 0)) throw apiError(422, 'invalid_schedule_version', 'expected_sync_version must be a non-negative integer');
  if (input.device_eui !== undefined) normalizeEui(input.device_eui);
  if (input.weekdays_mask !== undefined && (!Number.isInteger(input.weekdays_mask) || input.weekdays_mask < 1 || input.weekdays_mask > 127)) throw apiError(422, 'invalid_weekdays', 'weekdays_mask must be between 1 and 127');
  if (input.start_time !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(input.start_time))) throw apiError(422, 'invalid_start_time', 'start_time must be HH:MM');
  const duration = input.duration_minutes;
  if (duration !== undefined && (!Number.isInteger(duration) || duration < 1 || duration > 240)) throw apiError(422, 'invalid_duration', 'duration_minutes must be between 1 and 240');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw apiError(422, 'invalid_enabled', 'schedule enabled must be boolean');
  if (input.execution !== undefined && !['conditional', 'always'].includes(String(input.execution).toLowerCase())) throw apiError(422, 'invalid_execution', 'execution must be conditional or always');
  if (input.detach !== undefined && typeof input.detach !== 'boolean') throw apiError(422, 'invalid_detach', 'detach must be boolean');
  if (input.kind !== undefined && String(input.kind).toUpperCase() !== 'WEEKLY') throw apiError(422, 'schedule_kind_immutable', 'only WEEKLY rows can be edited by the policy API');
}

function normalizedSchedulePatch(input) {
  return {
    device_eui: input.device_eui === undefined ? undefined : normalizeEui(input.device_eui),
    weekdays_mask: input.weekdays_mask,
    start_time: input.start_time,
    duration_minutes: input.duration_minutes,
    enabled: input.enabled === undefined ? undefined : normalizeEnabled(input.enabled, true),
    label: input.label,
    execution: input.execution === undefined ? undefined : String(input.execution).toLowerCase(),
    detach: input.detach === true,
    kind: input.kind === undefined ? undefined : String(input.kind).toUpperCase(),
  };
}

async function zoneRow(db, zoneRef) {
  const value = zoneRef && typeof zoneRef === 'object' ? (zoneRef.zone_uuid || zoneRef.id) : zoneRef;
  if (value == null || value === '') throw apiError(400, 'zone_required', 'zone id or zone_uuid is required');
  const row = Number.isInteger(Number(value)) && String(value).trim() !== ''
    ? await db.get('SELECT * FROM irrigation_zones WHERE id=? AND deleted_at IS NULL', [Number(value)])
    : await db.get('SELECT * FROM irrigation_zones WHERE zone_uuid=? AND deleted_at IS NULL', [String(value)]);
  if (!row) throw apiError(404, 'zone_not_found', 'irrigation zone was not found');
  return row;
}

async function zoneSchedules(db, zoneId) {
  return db.all('SELECT vs.*, d.irrigation_zone_id, d.deleted_at AS device_deleted_at, d.type_id, d.name AS device_name FROM valve_schedules vs JOIN devices d ON UPPER(d.deveui)=UPPER(vs.device_eui) WHERE d.irrigation_zone_id=? AND d.deleted_at IS NULL ORDER BY vs.device_eui, vs.kind, vs.start_time, vs.fire_at, vs.schedule_uuid', [zoneId]);
}

function mutationScopeAllows(scopeHelper, freshScope) {
  if (!freshScope || freshScope.disabled) return false;
  if (scopeHelper && typeof scopeHelper.canMutate === 'function') return scopeHelper.canMutate(freshScope.role);
  return new Set(['admin', 'researcher']).has(String(freshScope.role || '').toLowerCase());
}

async function assertZoneAccess(db, row, actor, { write = false } = {}) {
  if (!actor) return;
  if (actor.scope && typeof actor.scope.assertFreshZoneAccess === 'function' && actor.user_uuid && actor.scopedMode === true) {
    const fresh = await actor.scope.assertFreshZoneAccess(db, actor.user_uuid, row.zone_uuid, { scopedMode: true });
    if (write && !mutationScopeAllows(actor.scope, fresh)) throw apiError(403, 'forbidden', 'viewer cannot edit irrigation policy');
    return;
  }
  if (write && String(actor.role || '').toLowerCase() === 'viewer') throw apiError(403, 'forbidden', 'viewer cannot edit irrigation policy');
  let userId = actor.user_id == null ? actor.userId : actor.user_id;
  if (userId == null && actor.user_uuid) {
    const user = await db.get('SELECT id FROM users WHERE user_uuid=?', [actor.user_uuid]);
    userId = user && user.id;
  }
  if (userId != null && Number(row.user_id) !== Number(userId)) throw apiError(403, 'forbidden', 'zone is owned by another user');
}

async function assertZoneAccessTx(tx, row, actor, { write = false } = {}) {
  if (!actor) return;
  if (actor.scope && typeof actor.scope.assertFreshZoneAccess === 'function' && actor.user_uuid && actor.scopedMode === true) {
    const fresh = await actor.scope.assertFreshZoneAccess(tx, actor.user_uuid, row.zone_uuid, { scopedMode: true });
    if (write && !mutationScopeAllows(actor.scope, fresh)) throw apiError(403, 'forbidden', 'viewer cannot edit irrigation policy');
    return;
  }
  if (write && String(actor.role || '').toLowerCase() === 'viewer') throw apiError(403, 'forbidden', 'viewer cannot edit irrigation policy');
  let userId = actor.user_id == null ? actor.userId : actor.user_id;
  if (userId == null && actor.user_uuid) {
    const user = await tx.get('SELECT id FROM users WHERE user_uuid=?', [actor.user_uuid]);
    userId = user && user.id;
  }
  if (userId != null && Number(row.user_id) !== Number(userId)) throw apiError(403, 'forbidden', 'zone is owned by another user');
}

// R19 finding 6 (spec section 9, "linked activation requires known support"): while the gateway
// is linked to a cloud that has not confirmed conditional_irrigation_v1, the 0077 triggers
// withhold conditional rows from it, so it would keep stale fixed copies. A save that creates or
// keeps conditional rows is refused until support is known; an unlinked gateway is unaffected.
async function assertLinkedPeerSupportsConditional(tx, rows) {
  const conditional = (rows || []).some((row) => row && row.condition_policy_uuid && row.deleted_at == null);
  if (!conditional) return;
  const link = await tx.get("SELECT linked FROM sync_link_state WHERE peer_node='cloud'");
  if (!link || Number(link.linked) !== 1) return;
  const replication = require('./replication');
  if (await replication.peerSupportsConditional(tx)) return;
  throw apiError(503, 'conditional_irrigation_unsupported', 'the linked cloud has not confirmed conditional irrigation support');
}

async function linkFence(tx) {
  // Task 7 installs link_attempt_json.  Older images simply have the column
  // absent; those remain compatible.  A present non-empty value is fail-closed.
  try {
    const row = await tx.get("SELECT link_attempt_json FROM sync_link_state WHERE peer_node='cloud'");
    if (row && row.link_attempt_json != null && String(row.link_attempt_json).trim() !== '') {
      throw apiError(409, 'link_in_progress', 'gateway account linking is in progress');
    }
  } catch (error) {
    if (error && error.code === 'link_in_progress') throw error;
    if (!/no such column|has no column named/i.test(String(error && error.message || error))) throw error;
  }
}

function activeWeekly(rows) {
  return (rows || []).filter((row) => row.kind === 'WEEKLY' && Number(row.enabled) === 1 && row.deleted_at == null);
}

function modeForValve(rows, policyUuid) {
  const live = activeWeekly(rows);
  const conditional = live.filter((row) => row.condition_policy_uuid);
  const fixed = live.filter((row) => !row.condition_policy_uuid);
  const ids = [...new Set(conditional.map((row) => String(row.condition_policy_uuid)))];
  if (conditional.length && (fixed.length || ids.some((id) => id !== policyUuid) || ids.length > 1)) {
    return { ok: false, code: 'mixed_schedule_mode', affected: live.map((row) => row.schedule_uuid) };
  }
  return { ok: true, mode: conditional.length ? 'CONDITIONAL' : 'FIXED', conditional, fixed };
}

function requestPolicyFields(request) {
  const source = request.policy && typeof request.policy === 'object' ? { ...request, ...request.policy } : request;
  strictKeys(source, new Set([
    'policy', 'policy_uuid', 'expected_policy_version', 'zone_uuid', 'condition', 'timezone', 'enabled',
    'observation_window_minutes', 'min_interval_minutes', 'max_daily_minutes', 'delivery_settings',
    'schedules', 'schedule_edits', 'zone_id', 'zoneRef',
  ]), 'unknown_policy_field');
  return source;
}

function sourceConditionForPolicy(policy) {
  return policy && policy.condition && typeof policy.condition === 'object' ? policy.condition : null;
}

async function validateSources(tx, condition, zoneId, dueMs) {
  if (!condition || !['SWT', 'VWC'].includes(String(condition.kind).toUpperCase())) return;
  for (const source of condition.sources || []) {
    const eligibility = await observations.resolveSourceEligibility(tx, source, condition, zoneId, dueMs);
    if (!eligibility.eligible) throw apiError(422, 'source_ineligible', `selected source is not eligible: ${eligibility.reason}`, { source: { device_eui: eligibility.device_eui, channel: eligibility.channel }, reason: eligibility.reason }, [eligibility.device_eui]);
  }
}

async function discoverAffected(db, zone, request) {
  const rows = await zoneSchedules(db, zone.id);
  const ids = new Set(rows.map((row) => String(row.schedule_uuid)));
  const affected = new Set(rows.map((row) => String(row.device_eui).toUpperCase()));
  for (const item of scheduleInputList(request)) {
    validateScheduleInputShape(item, 0);
    if (item.schedule_uuid != null && ids.has(String(item.schedule_uuid))) {
      const row = rows.find((candidate) => candidate.schedule_uuid === String(item.schedule_uuid));
      if (row) affected.add(String(row.device_eui).toUpperCase());
    }
    if (item.device_eui != null) affected.add(normalizeEui(item.device_eui));
  }
  // A managed policy disables the legacy zone trigger in the same transaction.
  // The legacy row has no target EUI and the old worker resolves the zone's
  // STREGA target at execution time, so every live zone valve belongs to the
  // affected writer set whenever that row is enabled.
  const legacy = await db.get('SELECT id FROM irrigation_schedules WHERE irrigation_zone_id=? AND deleted_at IS NULL AND enabled<>0', [zone.id]);
  if (legacy) {
    const legacyValves = await db.all("SELECT deveui FROM devices WHERE irrigation_zone_id=? AND type_id='STREGA_VALVE' AND deleted_at IS NULL", [zone.id]);
    for (const row of legacyValves) affected.add(String(row.deveui).toUpperCase());
  }
  return { rows, keys: [...affected].sort() };
}

function membershipSet(rows) {
  return [...new Set((rows || []).map((row) => String(row.device_eui).toUpperCase()))].sort();
}

function sameSet(a, b) {
  const left = [...new Set(a || [])].sort(); const right = [...new Set(b || [])].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function scheduleRowsByDevice(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = String(row.device_eui).toUpperCase();
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  }
  return map;
}

async function loadTxState(tx, zoneId) {
  const zone = await tx.get('SELECT * FROM irrigation_zones WHERE id=? AND deleted_at IS NULL', [zoneId]);
  if (!zone) throw apiError(404, 'zone_not_found', 'irrigation zone was deleted');
  const schedules = await tx.all('SELECT vs.*, d.irrigation_zone_id, d.deleted_at AS device_deleted_at, d.type_id, d.name AS device_name FROM valve_schedules vs JOIN devices d ON UPPER(d.deveui)=UPPER(vs.device_eui) WHERE d.irrigation_zone_id=? AND d.deleted_at IS NULL ORDER BY vs.device_eui, vs.kind, vs.start_time, vs.fire_at, vs.schedule_uuid', [zoneId]);
  const policy = await tx.get('SELECT * FROM irrigation_policies WHERE zone_uuid=? AND deleted_at IS NULL', [zone.zone_uuid]);
  const legacy = await tx.get('SELECT id FROM irrigation_schedules WHERE irrigation_zone_id=? AND deleted_at IS NULL AND enabled<>0', [zoneId]);
  const legacyValves = legacy
    ? await tx.all("SELECT deveui FROM devices WHERE irrigation_zone_id=? AND type_id='STREGA_VALVE' AND deleted_at IS NULL", [zoneId])
    : [];
  return { zone, schedules, policy, legacy_valve_euis: legacyValves.map((row) => String(row.deveui).toUpperCase()).sort() };
}

// R17-M1 / D18: an enabled VWC-condition policy (create, activate, or an edit that keeps it
// enabled) is refused while the edge VWC gate is off. A paused VWC policy may still be saved.
async function assertVwcAllowed(q, condition) {
  if (!policyStore.isVwcCondition(condition)) return;
  if (await policyStore.vwcConditionEnabled(q)) return;
  throw apiError(422, 'vwc_condition_disabled', 'VWC conditions are turned off on this gateway (conditional_irrigation_vwc_enabled)');
}

function policyValueFromRequest(request, before, zone) {
  const fields = requestPolicyFields(request);
  const current = before ? currentPolicyInput(before) : {};
  const condition = fields.condition === undefined ? current.condition : parseConditionInput(fields.condition);
  if (!condition) throw apiError(422, 'invalid_condition', 'condition is required');
  const timezone = fields.timezone === undefined ? (current.timezone || zone.timezone || 'UTC') : String(fields.timezone).trim();
  const observationWindow = fields.observation_window_minutes === undefined ? (current.observation_window_minutes || 60) : fields.observation_window_minutes;
  const minInterval = fields.min_interval_minutes === undefined ? (current.min_interval_minutes == null ? 60 : current.min_interval_minutes) : fields.min_interval_minutes;
  const maxDaily = fields.max_daily_minutes === undefined ? (current.max_daily_minutes || 240) : fields.max_daily_minutes;
  for (const [name, value, min, max] of [['observation_window_minutes', observationWindow, 1, 1440], ['min_interval_minutes', minInterval, 0, 1440], ['max_daily_minutes', maxDaily, 1, 1440]]) {
    if (!Number.isInteger(value) || value < min || value > max) throw apiError(422, `invalid_${name}`, `${name} is outside its supported range`);
  }
  if (!model.validTimezone(timezone)) throw apiError(422, 'invalid_timezone', 'timezone is not recognized');
  const enabled = normalizeEnabled(fields.enabled, before ? Number(before.enabled) === 1 : true);
  const delivery = fields.delivery_settings === undefined ? normalizeDeliverySettings(current.delivery_settings || {}) : normalizeDeliverySettings(fields.delivery_settings);
  const policyUuid = before ? before.policy_uuid : String(fields.policy_uuid || crypto.randomUUID());
  if (!UUID_RE.test(policyUuid)) throw apiError(422, 'invalid_policy_uuid', 'policy_uuid is invalid');
  return {
    policy_uuid: policyUuid, zone_uuid: zone.zone_uuid, condition, timezone, enabled,
    observation_window_minutes: observationWindow, min_interval_minutes: minInterval, max_daily_minutes: maxDaily,
    delivery_settings: delivery, expected_policy_version: fields.expected_policy_version,
    before,
  };
}

function applyScheduleEdits(rows, request, policy, zone, activationIso) {
  const byId = new Map(rows.map((row) => [String(row.schedule_uuid), { ...row }]));
  const touched = new Set();
  const touchedInputs = new Map();
  const explicit = scheduleInputList(request);
  const inputIds = new Set();
  for (let i = 0; i < explicit.length; i += 1) {
    const input = explicit[i];
    validateScheduleInputShape(input, i);
    const id = input.schedule_uuid == null ? null : String(input.schedule_uuid);
    if (id != null) {
      if (inputIds.has(id)) throw apiError(400, 'duplicate_schedule_id', 'schedule UUID appears more than once in the request', undefined, [id]);
      inputIds.add(id);
      touchedInputs.set(id, input);
    }
    const current = id == null ? null : byId.get(id);
    if (id != null && !current) throw apiError(409, 'schedule_not_found', 'schedule does not belong to this zone', undefined, [id]);
    const patch = normalizedSchedulePatch(input);
    if (current && (input.expected_sync_version === undefined || input.expected_sync_version === null)) throw apiError(400, 'expected_schedule_version_required', 'expected_sync_version is required for an existing schedule', undefined, [id]);
    if (current && input.expected_sync_version !== null && Number(input.expected_sync_version) !== Number(current.sync_version || 0)) throw apiError(409, 'version_conflict', 'schedule version conflict', { expected: input.expected_sync_version, actual: Number(current.sync_version || 0) }, [id]);
    if (!current && !Object.prototype.hasOwnProperty.call(input, 'expected_sync_version')) throw apiError(400, 'expected_schedule_version_required', 'expected_sync_version must be null for a new schedule', undefined, [id || 'new']);
    if (!current && input.expected_sync_version != null) throw apiError(409, 'version_conflict', 'new schedule must use a null expected_sync_version', undefined, [id || 'new']);
    const target = current ? { ...current } : {
      schedule_uuid: id || crypto.randomUUID(), device_eui: patch.device_eui, kind: patch.kind || 'WEEKLY', label: null,
      weekdays_mask: null, start_time: null, fire_at: null, duration_minutes: null, timezone: policy.timezone,
      enabled: 1, once_state: null, sync_version: 0, deleted_at: null, condition_policy_uuid: null, effective_from: null,
    };
    if (target.kind !== 'WEEKLY') throw apiError(422, 'schedule_kind_immutable', 'only WEEKLY rows can be edited by the policy API', undefined, [target.schedule_uuid]);
    if (!target.device_eui && !patch.device_eui) throw apiError(422, 'schedule_target_required', 'schedule device_eui is required', undefined, [target.schedule_uuid]);
    if (!current && !patch.detach && (patch.weekdays_mask === undefined || patch.start_time === undefined || patch.duration_minutes === undefined)) {
      throw apiError(422, 'schedule_fields_required', 'new WEEKLY schedules require weekdays_mask, start_time and duration_minutes', undefined, [target.schedule_uuid]);
    }
    if (patch.device_eui !== undefined) target.device_eui = patch.device_eui;
    if (patch.kind !== undefined) target.kind = patch.kind;
    if (target.kind !== 'WEEKLY') throw apiError(422, 'schedule_kind_immutable', 'only WEEKLY rows can be edited by the policy API', undefined, [target.schedule_uuid]);
    for (const field of ['weekdays_mask', 'start_time', 'duration_minutes', 'label']) if (patch[field] !== undefined) target[field] = patch[field];
    if (patch.enabled !== undefined) target.enabled = patch.enabled ? 1 : 0;
    const execution = patch.execution === undefined ? (target.condition_policy_uuid ? 'conditional' : 'always') : patch.execution;
    target.condition_policy_uuid = execution === 'conditional' ? policy.policy_uuid : null;
    target.timezone = policy.timezone;
    if (patch.detach) {
      target.deleted_at = activationIso;
      target.enabled = 0;
      target.condition_policy_uuid = null;
      target.effective_from = current && current.effective_from ? current.effective_from : null;
    } else {
      target.deleted_at = null;
      if (policy.enabled && target.enabled && target.condition_policy_uuid && (!current || current.condition_policy_uuid !== target.condition_policy_uuid || current.enabled !== target.enabled || current.weekdays_mask !== target.weekdays_mask || current.start_time !== target.start_time || current.duration_minutes !== target.duration_minutes || current.device_eui !== target.device_eui)) target.effective_from = activationIso;
      else if (!policy.enabled && (!current || current.condition_policy_uuid !== target.condition_policy_uuid || current.enabled !== target.enabled)) target.effective_from = null;
    }
    byId.set(target.schedule_uuid, target); touched.add(target.schedule_uuid);
  }
  const live = [...byId.values()];
  const mismatched = [];
  for (const row of live) {
    if (!row || row.kind !== 'WEEKLY' || row.deleted_at != null) continue;
    if (String(row.timezone || '') === String(policy.timezone || '')) continue;
    const input = touchedInputs.get(String(row.schedule_uuid));
    // A timezone change is a reinterpretation of local wall time.  Require an
    // explicit start_time re-expression for an attached row; silently replacing
    // the persisted timezone would move an existing watering instant.
    if (!input || input.start_time === undefined) mismatched.push(String(row.schedule_uuid));
  }
  if (mismatched.length) throw apiError(422, 'timezone_mismatch', 'schedule timezone must match the policy timezone', undefined, mismatched);
  for (const row of live) {
    if (row.condition_policy_uuid && policy.enabled && Number(row.enabled) === 1 && row.effective_from == null) row.effective_from = activationIso;
  }
  return { rows: live, touched, byId };
}

async function validateScheduleTargets(tx, rows, zoneId, policy) {
  const devices = await tx.all("SELECT deveui, irrigation_zone_id, type_id, deleted_at FROM devices WHERE irrigation_zone_id=?", [zoneId]);
  const byEui = new Map(devices.map((row) => [String(row.deveui).toUpperCase(), row]));
  const selected = new Set();
  for (const row of activeWeekly(rows)) {
    const eui = normalizeEui(row.device_eui);
    if (selected.has(`${row.schedule_uuid}:${eui}`)) throw apiError(422, 'duplicate_schedule_target', 'duplicate schedule target', undefined, [row.schedule_uuid]);
    selected.add(`${row.schedule_uuid}:${eui}`);
    const device = byEui.get(eui);
    if (!device || device.deleted_at != null || Number(device.irrigation_zone_id) !== Number(zoneId)) throw apiError(422, 'device_not_in_zone', 'schedule valve is not assigned to this zone', undefined, [eui, row.schedule_uuid]);
    if (device.type_id !== 'STREGA_VALVE') throw apiError(422, 'not_a_valve', 'schedule target is not a STREGA valve', undefined, [eui]);
  }
  const keys = Object.keys(policy.delivery_settings || {}).map((key) => String(key).toUpperCase());
  const targetEuIs = new Set(activeWeekly(rows).map((row) => String(row.device_eui).toUpperCase()));
  for (const key of keys) if (!targetEuIs.has(key)) throw apiError(422, 'foreign_delivery_settings_key', 'delivery settings key is not a selected valve', { device_eui: key }, [key]);
  for (const eui of targetEuIs) if (!policy.delivery_settings[eui]) policy.delivery_settings[eui] = { delivery_interval_minutes: 10 };
  if (!targetEuIs.size) throw apiError(422, 'no_targets', 'at least one enabled WEEKLY valve target is required');
  const conditionalTargetEuIs = new Set(activeWeekly(rows)
    .filter((row) => row.condition_policy_uuid === policy.policy_uuid)
    .map((row) => String(row.device_eui).toUpperCase()));
  if (policy.enabled && !conditionalTargetEuIs.size) {
    throw apiError(422, 'no_targets', 'an enabled conditional policy requires at least one attached valve target');
  }
  for (const [eui, grouped] of scheduleRowsByDevice(rows)) {
    const mode = modeForValve(grouped, policy.policy_uuid);
    if (!mode.ok) throw apiError(409, mode.code, 'a valve cannot mix fixed and conditional schedules', undefined, mode.affected);
  }
  return { devices, targetEuIs };
}

async function writeScheduleTx(tx, row, current, nowIsoValue) {
  if (!current) {
    await tx.run('INSERT INTO valve_schedules(schedule_uuid,device_eui,kind,label,weekdays_mask,start_time,fire_at,duration_minutes,timezone,enabled,once_state,sync_version,deleted_at,updated_at,condition_policy_uuid,effective_from) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)', [row.schedule_uuid, row.device_eui, row.kind, row.label == null ? null : row.label, row.weekdays_mask == null ? null : row.weekdays_mask, row.start_time == null ? null : row.start_time, row.fire_at == null ? null : row.fire_at, row.duration_minutes, row.timezone, Number(row.enabled) ? 1 : 0, row.kind === 'ONCE' ? 'PENDING' : null, row.deleted_at || null, nowIsoValue, row.condition_policy_uuid || null, row.effective_from || null]);
    return;
  }
  const changed = ['device_eui', 'kind', 'label', 'weekdays_mask', 'start_time', 'fire_at', 'duration_minutes', 'timezone', 'enabled', 'deleted_at', 'condition_policy_uuid', 'effective_from'].some((field) => String(current[field] == null ? '' : current[field]) !== String(row[field] == null ? '' : row[field]));
  if (!changed) return;
  await tx.run('UPDATE valve_schedules SET device_eui=?,kind=?,label=?,weekdays_mask=?,start_time=?,fire_at=?,duration_minutes=?,timezone=?,enabled=?,deleted_at=?,updated_at=?,condition_policy_uuid=?,effective_from=?,sync_version=COALESCE(sync_version,0)+1 WHERE schedule_uuid=? AND device_eui=?', [row.device_eui, row.kind, row.label == null ? null : row.label, row.weekdays_mask == null ? null : row.weekdays_mask, row.start_time == null ? null : row.start_time, row.fire_at == null ? null : row.fire_at, row.duration_minutes, row.timezone, Number(row.enabled) ? 1 : 0, row.deleted_at || null, nowIsoValue, row.condition_policy_uuid || null, row.effective_from || null, row.schedule_uuid, current.device_eui]);
  const after = await tx.get('SELECT * FROM valve_schedules WHERE schedule_uuid=?', [row.schedule_uuid]);
  if (!after || (current.device_eui && String(after.device_eui).toUpperCase() !== String(row.device_eui).toUpperCase())) throw apiError(409, 'membership_drift', 'schedule membership changed while editing', undefined, [row.schedule_uuid]);
}

async function disableLegacyTx(tx, zoneId, nowIsoValue) {
  await tx.run('UPDATE irrigation_schedules SET enabled=0, updated_at=? WHERE irrigation_zone_id=? AND deleted_at IS NULL AND enabled<>0', [nowIsoValue, zoneId]);
}

async function activePolicyExpectationsTx(tx, schedules, policyUuid) {
  const euis = membershipSet(schedules);
  if (!euis.length) return [];
  const placeholders = euis.map(() => '?').join(',');
  // Pause/retirement cancels automatic policy owners only.  Manual, ONCE and
  // valve-program observations on the same valve remain independent history.
  return tx.all(
    "SELECT vae.* FROM valve_actuation_expectations vae WHERE UPPER(vae.device_eui) IN (" + placeholders + ") AND vae.reconciliation_state IN ('PENDING_OBSERVATION','OBSERVED_RUNNING') AND (vae.trigger='conditional' OR EXISTS (SELECT 1 FROM irrigation_occurrences io WHERE io.command_id=vae.command_id AND io.policy_uuid=?)) ORDER BY vae.device_eui, vae.commanded_at, vae.expectation_id",
    euis.concat([policyUuid]),
  );
}

// Shared transaction seams for Task 6b's due/lifecycle adapters.  These
// functions intentionally accept only a scoped {get,all,run,exec} object:
// callers acquire their complete valve set before entering the transaction and
// perform transport/cancellation after it commits.
async function discoverPolicyMembershipTx(tx, zoneId) {
  const state = await loadTxState(tx, zoneId);
  const valveEuis = [...new Set(membershipSet(state.schedules).concat(state.legacy_valve_euis || []))].sort();
  return {
    zone: state.zone,
    policy: state.policy,
    schedules: state.schedules,
    legacy_valve_euis: state.legacy_valve_euis || [],
    valve_euis: valveEuis,
  };
}

// Transaction-only lifecycle preparation seam.  Callers acquire the complete
// affected writer set before entering their transaction, then call this seam
// before tombstoning conditional rows.  It uses Task 5's preparation helper and
// performs no nested transaction, writer acquisition, or transport I/O.  The
// returned revisions are intentionally sent by the caller after commit.
async function preparePolicyRevisionsTx(tx, { policyUuid, zoneId, schedules, now, reason = 'lifecycle', force = true } = {}) {
  if (!policyUuid) throw apiError(400, 'policy_uuid_required', 'policy_uuid is required to prepare policy revisions');
  const rows = schedules || (zoneId == null ? [] : (await discoverPolicyMembershipTx(tx, zoneId)).schedules);
  const byValve = scheduleRowsByDevice(rows || []);
  const revisions = [];
  for (const [deviceEui, valveRows] of byValve) {
    if (!valveRows.some((row) => row.condition_policy_uuid === policyUuid && row.deleted_at == null)) continue;
    const settings = await tx.get('SELECT strega_generation FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)', [deviceEui]);
    const currentSchedules = await tx.all('SELECT * FROM valve_schedules WHERE UPPER(device_eui)=UPPER(?) AND deleted_at IS NULL', [deviceEui]);
    const prepared = await push.prepareClearRevisionTx(tx, {
      deviceEui,
      generation: settings && settings.strega_generation || 'GEN1',
      schedules: currentSchedules,
      now: now == null ? new Date().toISOString() : now,
      reason,
      force,
    });
    revisions.push({ device_eui: deviceEui, revision: prepared.revision, required_push_ids: prepared.required_push_ids });
  }
  return revisions;
}

async function pausePolicyTx(tx, { zoneId, expectedPolicyVersion, now, actor } = {}) {
  await linkFence(tx);
  const state = await loadTxState(tx, zoneId);
  await assertZoneAccessTx(tx, state.zone, actor, { write: true });
  if (!state.policy) throw apiError(404, 'policy_not_found', 'policy does not exist');
  if (expectedPolicyVersion !== undefined && expectedPolicyVersion !== null
      && Number(expectedPolicyVersion) !== Number(state.policy.sync_version)) {
    throw apiError(409, 'version_conflict', 'policy version conflict', { expected: expectedPolicyVersion, actual: state.policy.sync_version });
  }
  const at = isoNow(now == null ? Date.now() : now);
  const { sync_version: _ignoredSyncVersion, ...priorPolicy } = state.policy;
  await policyStore.upsertPolicyTx(tx, {
    ...priorPolicy,
    enabled: 0,
    condition_json: state.policy.condition_json,
    delivery_settings_json: state.policy.delivery_settings_json,
    effective_from: state.policy.effective_from,
    updated_at: at,
    deleted_at: null,
  }, { expectedSyncVersion: Number(state.policy.sync_version) });
  await disableLegacyTx(tx, zoneId, at);
  const active = await activePolicyExpectationsTx(tx, state.schedules, state.policy.policy_uuid);
  return {
    policy: await policyStore.getPolicyTx(tx, state.policy.policy_uuid),
    schedules: state.schedules,
    legacy_valve_euis: state.legacy_valve_euis || [],
    valve_euis: [...new Set(membershipSet(state.schedules).concat(state.legacy_valve_euis || []))].sort(),
    active_expectations: active,
  };
}

async function retirePolicyTx(tx, { zoneId, now, actor, reason, prepareRevisions = false } = {}) {
  await linkFence(tx);
  const state = await loadTxState(tx, zoneId);
  await assertZoneAccessTx(tx, state.zone, actor, { write: true });
  const affectedValveEuis = [...new Set(membershipSet(state.schedules).concat(state.legacy_valve_euis || []))].sort();
  if (!state.policy) return { policy: null, schedules: state.schedules, legacy_valve_euis: state.legacy_valve_euis || [], valve_euis: affectedValveEuis, active_expectations: [], revisions: [] };
  const at = isoNow(now == null ? Date.now() : now);
  const revisions = prepareRevisions ? await preparePolicyRevisionsTx(tx, {
    policyUuid: state.policy.policy_uuid,
    schedules: state.schedules,
    now: at,
    reason: reason || 'lifecycle',
    force: true,
  }) : [];
  const retiredScheduleIds = state.schedules
    .filter((row) => row.condition_policy_uuid === state.policy.policy_uuid && row.deleted_at == null)
    .map((row) => String(row.schedule_uuid));
  // The policy and schedule identity are sync-contract data.  A retirement is a
  // single versioned mutation: retain condition_policy_uuid on the schedule so
  // history and replay can still identify the policy that owned it.
  await tx.run('UPDATE irrigation_policies SET enabled=0, deleted_at=?, updated_at=?, sync_version=COALESCE(sync_version,0)+1 WHERE policy_uuid=? AND deleted_at IS NULL', [at, at, state.policy.policy_uuid]);
  await tx.run('UPDATE valve_schedules SET enabled=0, deleted_at=?, updated_at=?, sync_version=COALESCE(sync_version,0)+1 WHERE condition_policy_uuid=? AND deleted_at IS NULL', [at, at, state.policy.policy_uuid]);
  await disableLegacyTx(tx, zoneId, at);
  const occurrenceRows = await tx.all('SELECT * FROM irrigation_occurrences WHERE policy_uuid=? AND state IN (\'PENDING\',\'CLAIMED\')', [state.policy.policy_uuid]);
  for (const occurrence of occurrenceRows) {
    await policyStore.transitionOccurrenceTx(tx, occurrence, {
      state: 'SKIPPED',
      decision: 'SKIPPED',
      decision_reason: reason || 'retired',
      decision_at: at,
      updated_at: at,
    }, { now: at });
  }
  const active = await activePolicyExpectationsTx(tx, state.schedules, state.policy.policy_uuid);
  const schedules = retiredScheduleIds.length
    ? await tx.all('SELECT * FROM valve_schedules WHERE schedule_uuid IN (' + retiredScheduleIds.map(() => '?').join(',') + ')', retiredScheduleIds)
    : [];
  return { policy: await tx.get('SELECT * FROM irrigation_policies WHERE policy_uuid=?', [state.policy.policy_uuid]), schedules, legacy_valve_euis: state.legacy_valve_euis || [], valve_euis: affectedValveEuis, active_expectations: active, revisions, reason: reason || 'retired' };
}

async function prepareAffectedRevisionsTx(tx, rows, touched, policy, activationIso, existingModes) {
  const pending = [];
  const byValve = scheduleRowsByDevice(rows);
  for (const [eui, valveRows] of byValve) {
    const mode = modeForValve(valveRows, policy.policy_uuid);
    if (!mode.ok || mode.mode !== 'CONDITIONAL') continue;
    const touchedValve = valveRows.some((row) => touched.has(row.schedule_uuid));
    const prior = existingModes.get(eui);
    if (!touchedValve && prior === 'CONDITIONAL') continue;
    const settings = await tx.get('SELECT strega_generation FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)', [eui]);
    const prepared = await push.prepareClearRevisionTx(tx, { deviceEui: eui, generation: settings && settings.strega_generation || 'GEN1', schedules: await tx.all('SELECT * FROM valve_schedules WHERE UPPER(device_eui)=UPPER(?) AND deleted_at IS NULL', [eui]), now: activationIso, reason: 'conversion', force: true });
    pending.push({ device_eui: eui, revision: prepared.revision, required_push_ids: prepared.required_push_ids });
  }
  return pending;
}

function runtimeQualification(options, context) {
  return effects.qualificationResult(options && options.qualificationProvider, context);
}

// Cloud command adapters run the source mutation inside the command ledger's
// transaction.  The physical clear/compile work remains a post-commit step;
// this helper is the shared transport completion path used by local routes and
// the adapter, so policy writes are never duplicated.
async function completePolicyEditTransport(options, result, activationMs) {
  const revisionResults = [];
  for (const revision of result.revisions || []) {
    if (typeof options.sendPreparedRevision === 'function') {
      revisionResults.push(await options.sendPreparedRevision({ db: options.db, ...revision, transport: options.transport, now: new Date(activationMs), warn: options.warn }));
    } else if (options.transport) {
      revisionResults.push(await push.sendPreparedRevision({ db: options.db, deviceEui: revision.device_eui, revision: revision.revision, transport: options.transport, now: new Date(activationMs), warn: options.warn }));
    }
  }
  const fixedResults = [];
  for (const deviceEui of result.fixed_conversions || []) {
    const compile = options.compileAndQueue || push.compileAndQueue;
    fixedResults.push(await compile({
      db: options.db,
      deviceEui,
      appId: options.appId,
      force: true,
      now: new Date(activationMs),
      flushQueue: options.flushQueue,
      transport: options.transport,
      warn: options.warn,
      timeZoneFallback: result.policy && result.policy.timezone,
    }));
  }
  return { revisionResults, fixedResults };
}

async function completePauseTransport(options, result, nowMs) {
  const cancellations = [];
  for (const row of result.active || result.active_expectations || []) {
    if (typeof options.cancelActuation === 'function') {
      cancellations.push(await options.cancelActuation({ db: options.db, deviceEui: row.device_eui, expectationId: row.expectation_id, reason: 'conditional_policy_paused', transport: options.transport, now: new Date(nowMs), warn: options.warn }));
    } else if (options.transport) {
      cancellations.push(await cancel.cancelActuation({ db: options.db, deviceEui: row.device_eui, expectationId: row.expectation_id, reason: 'conditional_policy_paused', transport: options.transport, now: new Date(nowMs), warn: options.warn }));
    } else {
      throw apiError(503, 'transport_unavailable', 'conditional policy pause requires the live valve transport to cancel pending actuation', undefined, [row.device_eui]);
    }
  }
  const pending = cancellations.some((item) => item && (item.pending || item.transport_uncertain || item.error === 'transport_uncertain'));
  return { status: pending ? 202 : 200, cancellations };
}

async function completeRetryValveTransport(options, result) {
  if (!options.transport || !result || !result.revision) return null;
  return push.sendPreparedRevision({
    db: options.db,
    deviceEui: result.device_eui,
    revision: result.revision,
    transport: options.transport,
    now: new Date(internalNow(options)),
    warn: options.warn,
  });
}

async function notifyAfterCommit(options, input) {
  if (!options || typeof options.notifyProjection !== 'function') return;
  try {
    await options.notifyProjection({
      zone_uuid: input && input.zone_uuid,
      valve_euis: input && input.valve_euis,
      decision_keys: input && input.decision_keys,
    });
  } catch (error) {
    const message = 'conditional projection notification remains pending: ' + String(error && error.message || error);
    if (typeof options.warn === 'function') options.warn(message);
  }
}

async function applyPolicyEdit(options = {}) {
  const db = options.db;
  if (!db || typeof db.transaction !== 'function') throw new TypeError('applyPolicyEdit requires a transactional db facade');
  const request = options.request && typeof options.request === 'object' ? options.request : {};
  const zone = await zoneRow(db, options.zone !== undefined ? options.zone : (request.zone_uuid || request.zone_id || request.zoneRef));
  await assertRequestZoneBinding(db, zone, request);
  await assertZoneAccess(db, zone, options.actor, { write: true });
  const discovered = await discoverAffected(db, zone, request);
  if (!discovered.keys.length) throw apiError(422, 'no_targets', 'at least one valve target is required');
  const gateFields = requestPolicyFields(request);
  let lastDrift;
  let activationMs = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const keys = attempt === 0 ? discovered.keys : (await discoverAffected(db, zone, request)).keys;
    if (!keys.length) throw apiError(422, 'no_targets', 'at least one valve target is required');
    try {
      const result = await dispatch.withValveWriters(keys, async () => {
        // The trust decision is deliberately after the whole set is acquired.
        // A writer queued behind a manual action cannot reuse a pre-wait clock.
        activationMs = internalNow(options);
        if (!Number.isFinite(activationMs)) throw apiError(422, 'invalid_activation_time', 'internal activation instant is invalid');
        const activationIso = isoNow(activationMs);
        let clockStatus = null;
        let requestedCondition = null;
        const gate = options.runtimeClockStatus || clock.runtimeClockStatus;
        const peek = await db.get('SELECT * FROM irrigation_policies WHERE zone_uuid=? AND deleted_at IS NULL', [zone.zone_uuid]);
        const requestedEnabled = normalizeEnabled(gateFields.enabled, peek ? Number(peek.enabled) === 1 : true);
        if (requestedEnabled) {
          // R17-M1 / D18: the gate is checked on the requested kind before the condition's
          // content, so a VWC request gets vwc_condition_disabled, not a validation error.
          await assertVwcAllowed(db, gateFields.condition === undefined ? (peek ? policyFromRow(peek).condition : null) : gateFields.condition);
          requestedCondition = gateFields.condition === undefined
            ? (peek ? policyFromRow(peek).condition : null)
            : parseConditionInput(gateFields.condition);
          if (!requestedCondition) throw apiError(422, 'invalid_condition', 'condition is required');
          const bounds = await readClockBounds(db, requestedCondition, zone.id);
          clockStatus = await gate({ ...(options.clockOptions || {}), now: activationMs, lastDue: bounds.lastDue, latestSample: bounds.latestSample });
          if (!clockStatus || clockStatus.trusted !== true) throw apiError(503, 'clock_untrusted', 'conditional policy activation requires a trusted runtime clock', { reason: clockStatus && clockStatus.reason || 'clock_untrusted' });
        }
        return db.transaction(async (tx) => {
          await linkFence(tx);
          const state = await loadTxState(tx, zone.id);
          await assertZoneAccessTx(tx, state.zone, options.actor, { write: true });
          if (requestedEnabled) {
            const transactionCondition = gateFields.condition === undefined
              ? (state.policy ? policyFromRow(state.policy).condition : requestedCondition)
              : requestedCondition;
            const transactionBounds = await readClockBounds(tx, transactionCondition, state.zone.id);
            assertClockBoundsAtActivation(transactionBounds, activationMs);
          }
          const currentKeys = membershipSet(state.schedules).concat(state.legacy_valve_euis || []);
          const requestKeys = scheduleInputList(request).map((item) => item.device_eui == null ? null : normalizeEui(item.device_eui)).filter(Boolean);
          const heldKeys = [...new Set(keys)].sort();
          const requiredKeys = [...new Set(currentKeys.concat(requestKeys))].sort();
          if (!requiredKeys.every((eui) => heldKeys.includes(eui))) throw apiError(409, 'membership_drift', 'affected valve membership changed; retry the edit', { required: requiredKeys, held: heldKeys }, requiredKeys);
          const before = state.policy;
          const fields = requestPolicyFields(request);
          const expected = fields.expected_policy_version;
          if (!before && !Object.prototype.hasOwnProperty.call(fields, 'expected_policy_version')) throw apiError(400, 'expected_policy_version_required', 'expected_policy_version must be null when creating a policy');
          if (!before && expected !== null) throw apiError(400, 'expected_policy_version_required', 'expected_policy_version must be null when creating a policy');
          if (before && (expected === undefined || expected === null || !Number.isInteger(expected))) throw apiError(400, 'expected_policy_version_required', 'expected_policy_version is required for an existing policy');
          if (before && Number(expected) !== Number(before.sync_version)) throw apiError(409, 'version_conflict', 'policy version conflict', { expected, actual: Number(before.sync_version) });
          const policy = policyValueFromRequest(request, before, state.zone);
          if (policy.enabled) await assertVwcAllowed(tx, policy.condition);
          await validateSources(tx, policy.condition, state.zone.id, activationMs);
          const previewRows = applyScheduleEdits(state.schedules, request, { ...policy, policy_uuid: policy.policy_uuid }, state.zone, activationIso);
          const enablingPolicy = policy.enabled && (!before || Number(before.enabled) !== 1);
          if (enablingPolicy) {
            for (const row of previewRows.rows) {
              if (row.condition_policy_uuid === policy.policy_uuid && Number(row.enabled) === 1 && row.deleted_at == null) row.effective_from = activationIso;
            }
          }
          const targetInfo = await validateScheduleTargets(tx, previewRows.rows, state.zone.id, { ...policy, policy_uuid: policy.policy_uuid });
          const policyRows = activeWeekly(previewRows.rows);
          await assertLinkedPeerSupportsConditional(tx, previewRows.rows);
          // Conversion/attachment is a complete valve operation.  A live or
          // unresolved owner wins over the edit and causes the entire policy,
          // schedule, legacy-disable and prepared-revision transaction to roll
          // back.  Pause uses a separate seam and deliberately remains
          // available while cancellation/reconciliation is pending.
          for (const eui of requiredKeys) {
            const conflict = await dispatch.findValveConflictTx(tx, eui, 'conditional-policy-edit', activationIso);
            if (conflict) throw apiError(409, 'valve_busy', 'valve has an active or unresolved actuation', { conflict }, [eui]);
            if (await dispatch.hasBlockingObservation(tx, eui)) throw apiError(409, 'valve_busy', 'valve has a pending observation', undefined, [eui]);
          }
          const qualification = runtimeQualification(options, { zone: state.zone, policy, schedules: policyRows, valve_euis: [...targetInfo.targetEuIs].sort() });
          if (policy.enabled && policyRows.some((row) => row.condition_policy_uuid) && !qualification.qualified) throw apiError(503, 'qualification_unavailable', 'conditional activation is not qualified', qualification);
          const validationPolicy = { ...policy, validation_reference_at: activationIso };
          const feasibility = model.validateScheduleSet(validationPolicy, previewRows.rows, { referenceAt: activationIso });
          if (!feasibility.ok) throw apiError(422, feasibility.error, feasibility.error, feasibility.details, feasibility.details && feasibility.details.affected_schedule_ids);
          const existingModes = new Map();
          for (const [eui, grouped] of scheduleRowsByDevice(state.schedules)) existingModes.set(eui, modeForValve(grouped, policy.policy_uuid).mode);
          const fixedConversions = [];
          const previewByValve = scheduleRowsByDevice(previewRows.rows);
          for (const eui of requiredKeys) {
            const prior = existingModes.get(eui);
            const valveRows = previewByValve.get(eui) || [];
            const resulting = modeForValve(valveRows, policy.policy_uuid).mode;
            // R19 finding 2: a valve that stays FIXED but whose fixed rows this edit touched is
            // compiled and pushed exactly like a valve schedule route edit.
            const touchedFixed = valveRows.some((row) => previewRows.touched.has(row.schedule_uuid) && !row.condition_policy_uuid);
            if (resulting === 'FIXED' && (prior === 'CONDITIONAL' || touchedFixed)) fixedConversions.push(eui);
          }
          const resultingEnabled = policy.enabled;
          const policyEffective = resultingEnabled ? activationIso : (before && before.effective_from || null);
          const policyRow = {
            policy_uuid: policy.policy_uuid, zone_uuid: state.zone.zone_uuid, condition_json: JSON.stringify(policy.condition), timezone: policy.timezone,
            enabled: resultingEnabled ? 1 : 0, observation_window_minutes: policy.observation_window_minutes,
            min_interval_minutes: policy.min_interval_minutes, max_daily_minutes: policy.max_daily_minutes,
            delivery_settings_json: JSON.stringify(policy.delivery_settings), effective_from: policyEffective,
            updated_at: activationIso, deleted_at: null,
          };
          await policyStore.upsertPolicyTx(tx, policyRow, { expectedSyncVersion: expected });
          const oldById = new Map(state.schedules.map((row) => [String(row.schedule_uuid), row]));
          for (const row of previewRows.rows) await writeScheduleTx(tx, row, oldById.get(String(row.schedule_uuid)), activationIso);
          // A managed policy owns the zone's automatic authority even when it is
          // paused.  Task 6b owns the legacy execution worker; this transaction
          // removes the old trigger atomically with the policy edit.
          await disableLegacyTx(tx, state.zone.id, activationIso);
          const revisions = await prepareAffectedRevisionsTx(tx, previewRows.rows, previewRows.touched, { ...policy, policy_uuid: policy.policy_uuid }, activationIso, existingModes);
          return {
            policy: await policyStore.getPolicyTx(tx, policy.policy_uuid),
            schedules: await tx.all('SELECT * FROM valve_schedules WHERE schedule_uuid IN (' + previewRows.rows.map(() => '?').join(',') + ')', previewRows.rows.map((row) => row.schedule_uuid)),
            revisions, fixed_conversions: fixedConversions, qualification, validation: feasibility.value, activation_from: resultingEnabled ? activationIso : (before && before.effective_from || null),
          };
        });
      });
      const transportResult = options.deferTransport
        ? { revisionResults: [], fixedResults: [] }
        : await completePolicyEditTransport(options, result, activationMs);
      const revisionResults = transportResult.revisionResults;
      const fixedResults = transportResult.fixedResults;
      await notifyAfterCommit(options, {
        zone_uuid: result.policy && result.policy.zone_uuid,
        valve_euis: [
          ...(result.revisions || []).map((row) => row.device_eui),
          ...(result.fixed_conversions || []),
          ...(result.schedules || []).map((row) => row.device_eui),
        ],
      });
      const mode = (result.schedules || []).some((row) => row.condition_policy_uuid && Number(row.enabled) === 1 && !row.deleted_at) ? 'CONDITIONAL' : 'FIXED';
      const status = (result.revisions && result.revisions.length) || (fixedResults.length && fixedResults.some((item) => item && (item.pending || (Array.isArray(item.messages) && item.messages.length)))) ? 202 : 200;
      return { status, ...result, policy: policyFromRow(result.policy), mode, revision_results: revisionResults, fixed_results: fixedResults };
    } catch (error) {
      if (error && error.code === 'membership_drift') { lastDrift = error; continue; }
      throw error;
    }
  }
  throw lastDrift || apiError(409, 'membership_drift', 'affected valve membership kept changing; retry the edit');
}

async function readSourceOptions(db, zone, policy, nowMs) {
  const condition = policy && policy.condition;
  if (!condition || !['SWT', 'VWC'].includes(String(condition.kind).toUpperCase())) return [];
  const devices = await db.all('SELECT * FROM devices WHERE irrigation_zone_id=? AND deleted_at IS NULL ORDER BY deveui', [zone.id]);
  const options = [];
  for (const device of devices) {
    const channels = String(condition.kind).toUpperCase() === 'SWT' ? [...model.SWT_CHANNELS] : model.commissionedChannels(device);
    for (const channel of channels) {
      const eligibility = await observations.resolveSourceEligibility(db, { device_eui: device.deveui, channel }, condition, zone.id, nowMs);
      options.push({ kind: String(condition.kind).toUpperCase(), device_eui: eligibility.device_eui, channel: eligibility.channel, type_id: device.type_id, eligible: eligibility.eligible, reason: eligibility.reason || null });
    }
  }
  return options;
}

async function readCreationSourceChoices(db, zone, nowMs) {
  const devices = await db.all('SELECT * FROM devices WHERE irrigation_zone_id=? AND deleted_at IS NULL ORDER BY deveui', [zone.id]);
  const choices = { SWT: [], VWC: [], DENDRO: [] };
  for (const kind of ['SWT', 'VWC']) {
    const condition = kind === 'SWT'
      ? { kind, threshold_kpa: 1, sources: [] }
      : { kind, threshold_percent: 0, sources: [] };
    for (const device of devices) {
      // Keep unavailable commissioned choices visible. VWC channels are an
      // explicit source selection, so an SDI-12 device with no commissioned
      // layout still reports channel_not_commissioned for every visible slot.
      const channels = kind === 'SWT'
        ? [...model.SWT_CHANNELS]
        : (device.type_id === 'DRAGINO_SDI12' ? [...model.VWC_CHANNELS] : []);
      for (const channel of channels) {
        const eligibility = await observations.resolveSourceEligibility(db, { device_eui: device.deveui, channel }, condition, zone.id, nowMs);
        choices[kind].push({ kind, device_eui: eligibility.device_eui, channel: eligibility.channel, type_id: device.type_id, eligible: eligibility.eligible, reason: eligibility.reason || null });
      }
    }
  }
  const dendro = await observations.readDendroEvidence(db, { zone_id: zone.id }, nowMs, 60);
  choices.DENDRO.push({
    kind: 'DENDRO',
    eligible: Boolean(dendro && dendro.analysis),
    state: dendro && dendro.analysis ? 'available' : 'unavailable',
    reason: dendro && dendro.reason || null,
    sources: dendro && dendro.sources || [],
  });
  return choices;
}

const NEXT_CHECK_HORIZON_MS = 400 * 24 * 60 * 60 * 1000;

function strictNextPolicyCheck(policy, schedules, nowMs) {
  if (!policy || policy.enabled !== true || !Number.isFinite(nowMs)) return null;
  const timezone = String(policy.timezone || '');
  if (!timezone) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch (_) {
    return null;
  }
  let nextDueMs = null;
  for (const schedule of schedules || []) {
    if (schedule.kind !== 'WEEKLY' || Number(schedule.enabled) !== 1 || schedule.deleted_at != null) continue;
    if (String(schedule.condition_policy_uuid || '') !== String(policy.policy_uuid || '')) continue;
    const effectiveValues = [policy.effective_from, schedule.effective_from].filter((value) => value != null && value !== '');
    let effectiveMs = null;
    for (const value of effectiveValues) {
      const parsed = parseInstant(value);
      if (parsed == null) { effectiveMs = NaN; break; }
      effectiveMs = effectiveMs == null ? parsed : Math.max(effectiveMs, parsed);
    }
    if (Number.isNaN(effectiveMs)) continue;
    const fromMs = Math.max(nowMs, effectiveMs == null ? nowMs : effectiveMs);
    const toMs = fromMs + NEXT_CHECK_HORIZON_MS;
    if (!Number.isFinite(toMs)) continue;
    const preview = {
      ...schedule,
      timezone,
      effective_from: effectiveMs == null ? null : new Date(effectiveMs).toISOString(),
    };
    const occurrences = occurrencesBetween(preview, new Date(fromMs).toISOString(), new Date(toMs).toISOString());
    for (const occurrence of occurrences) {
      const dueMs = parseInstant(occurrence.dueAt);
      if (dueMs == null || dueMs < nowMs || (nextDueMs != null && dueMs >= nextDueMs)) continue;
      nextDueMs = dueMs;
    }
  }
  return nextDueMs == null ? null : new Date(nextDueMs).toISOString();
}

async function readPolicy(options = {}) {
  const db = options.db; if (!db) throw new TypeError('readPolicy requires db');
  const zone = await zoneRow(db, options.zone || options.zoneRef || options.zone_uuid);
  await assertZoneAccess(db, zone, options.actor, { write: false });
  const row = await db.get('SELECT * FROM irrigation_policies WHERE zone_uuid=? AND deleted_at IS NULL', [zone.zone_uuid]);
  const policy = policyFromRow(row);
  const schedules = await zoneSchedules(db, zone.id);
  const nowMs = internalNow(options);
  const vwcEnabled = await policyStore.vwcConditionEnabled(db);
  const sourceChoices = await readCreationSourceChoices(db, zone, nowMs);
  // R17-M1 / D18: with the VWC gate off the editor is offered no VWC sources.
  if (!vwcEnabled) sourceChoices.VWC = [];
  const sourceOptions = policy
    ? (String(policy.condition && policy.condition.kind || '').toUpperCase() === 'DENDRO'
      ? sourceChoices.DENDRO
      : await readSourceOptions(db, zone, policy, nowMs))
    : sourceChoices.SWT.concat(sourceChoices.VWC, sourceChoices.DENDRO);
  const qualification = runtimeQualification(options, {
    zone,
    policy,
    schedules,
    valve_euis: [...new Set(schedules.map((schedule) => String(schedule.device_eui).toUpperCase()))].sort(),
  });
  const valves = [];
  for (const eui of [...new Set(schedules.map((s) => String(s.device_eui).toUpperCase()))].sort()) {
    const control = await valveStore.conditionalControl(db, eui);
    // Projection publication passes a transaction-scoped read facade.  It must
    // not let the status preview persist a derived readiness marker while the
    // source projection is being assembled.
    const readiness = options.skipValveReadiness
      ? null
      : (typeof push.conditionalReadiness === 'function' ? await push.conditionalReadiness(db, eui) : null);
    valves.push({ device_eui: eui, control, readiness });
  }
  const lastResult = row ? await db.get('SELECT * FROM irrigation_occurrences WHERE policy_uuid=? ORDER BY COALESCE(decision_at,due_at) DESC LIMIT 1', [row.policy_uuid]) : null;
  const nextCheck = strictNextPolicyCheck(policy, schedules, nowMs);
  return {
    zone: { id: zone.id, zone_uuid: zone.zone_uuid, name: zone.name, timezone: zone.timezone },
    policy,
    // R17-M1 / D18: the edge VWC gate, and why an existing VWC policy is inactive while it is off.
    vwc_condition_enabled: vwcEnabled,
    inactive_reason: policy && policyStore.isVwcCondition(policy.condition) && !vwcEnabled ? 'vwc_condition_disabled' : null,
    eligible_sources: sourceOptions,
    source_choices: sourceChoices,
    schedules: policy ? schedules.filter((schedule) => schedule.condition_policy_uuid === policy.policy_uuid || schedule.kind === 'ONCE') : schedules,
    valves,
    next_check: nextCheck,
    last_result: lastResult ? { ...lastResult, decision_evidence: parseObject(lastResult.decision_evidence_json, 'decision_evidence_json', null) } : null,
    qualification,
    legacy_process_timezone: options.validatedProcessTimezone !== undefined
      ? options.validatedProcessTimezone
      : (() => {
        const candidate = Intl.DateTimeFormat().resolvedOptions().timeZone || null;
        if (typeof candidate !== 'string' || candidate.length > 64) return null;
        try { new Intl.DateTimeFormat('en-US', { timeZone: candidate }).format(); return candidate; } catch (_) { return null; }
      })(),
  };
}

async function pausePolicy(options = {}) {
  const db = options.db; if (!db) throw new TypeError('pausePolicy requires db');
  const request = options.request || {};
  const zone = await zoneRow(db, options.zone !== undefined ? options.zone : (request.zone_uuid || request.zone_id || request.zoneRef));
  await assertRequestZoneBinding(db, zone, request);
  await assertZoneAccess(db, zone, options.actor, { write: true });
  let discovered = await discoverAffected(db, zone, {});
  let result;
  let nowMs = null;
  let lastDrift;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    const keys = attempt === 0 ? discovered.keys : (await discoverAffected(db, zone, {})).keys;
    try {
      result = await dispatch.withValveWriters(keys, async () => {
        nowMs = internalNow(options);
        if (!Number.isFinite(nowMs)) throw apiError(422, 'invalid_activation_time', 'internal activation instant is invalid');
        const paused = await db.transaction(async (tx) => {
          await linkFence(tx);
          const state = await pausePolicyTx(tx, {
            zoneId: zone.id,
            expectedPolicyVersion: request.expected_policy_version,
            now: isoNow(nowMs),
            actor: options.actor,
          });
          const heldKeys = [...new Set(keys)].sort();
          if (!sameSet(heldKeys, state.valve_euis || [])) {
            throw apiError(409, 'membership_drift', 'affected valve membership changed; retry the pause', {
              required: state.valve_euis || [], held: heldKeys,
            }, state.valve_euis || []);
          }
          return { policy: state.policy, active: state.active_expectations };
        });
        return paused;
      });
      break;
    } catch (error) {
      if (error && error.code === 'membership_drift') { lastDrift = error; discovered = await discoverAffected(db, zone, {}); continue; }
      throw error;
    }
  }
  if (!result) throw lastDrift || apiError(409, 'membership_drift', 'affected valve membership kept changing; retry the pause');
  const transportResult = options.deferTransport
    ? { status: 202, cancellations: [] }
    : await completePauseTransport(options, result, nowMs);
  await notifyAfterCommit(options, {
    zone_uuid: result.policy && result.policy.zone_uuid,
    valve_euis: (result.active || result.active_expectations || []).map((row) => row.device_eui),
  });
  return { status: transportResult.status, policy: policyFromRow(result.policy), cancellations: transportResult.cancellations, active_expectations: result.active || [] };
}

async function retryValve(options = {}) {
  const db = options.db; if (!db) throw new TypeError('retryValve requires db');
  const request = options.request || {}; const eui = normalizeEui(request.device_eui || request.deveui);
  if (hasOwn(request, 'generation')) throw apiError(400, 'unsupported_generation', 'hardware generation is persisted on the valve and cannot be selected by the request', undefined, [eui]);
  const zone = await zoneRow(db, options.zone !== undefined ? options.zone : (request.zone_uuid || request.zone_id || request.zoneRef));
  await assertRequestZoneBinding(db, zone, request);
  await assertZoneAccess(db, zone, options.actor, { write: true });
  const result = await dispatch.withValveWriter(eui, async () => {
    const nowMs = internalNow(options);
    if (!Number.isFinite(nowMs)) throw apiError(422, 'invalid_activation_time', 'internal activation instant is invalid');
    const prepared = await db.transaction(async (tx) => {
      await linkFence(tx);
      const state = await loadTxState(tx, zone.id);
      await assertZoneAccessTx(tx, state.zone, options.actor, { write: true });
      const device = await tx.get('SELECT deveui,type_id,irrigation_zone_id,deleted_at FROM devices WHERE UPPER(deveui)=UPPER(?) AND deleted_at IS NULL', [eui]);
      if (!device || String(device.type_id) !== 'STREGA_VALVE' || Number(device.irrigation_zone_id) !== Number(zone.id)) {
        throw apiError(422, 'device_not_in_zone', 'retry valve is not assigned to this zone', undefined, [eui]);
      }
      if (!state.policy) throw apiError(409, 'policy_not_found', 'policy does not exist', undefined, [eui]);
      const current = state.schedules.filter((row) => String(row.device_eui).toUpperCase() === eui && row.deleted_at == null && row.condition_policy_uuid === state.policy.policy_uuid);
      if (!current.length) throw apiError(409, 'valve_not_conditional', 'valve is not a current conditional policy member', undefined, [eui]);
      const settings = await tx.get('SELECT strega_generation FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)', [eui]);
      const generation = settings && String(settings.strega_generation || '').toUpperCase() || 'GEN1';
      if (!['GEN1', 'GEN2'].includes(generation)) throw apiError(409, 'invalid_generation', 'persisted valve generation is invalid', undefined, [eui]);
      const schedules = state.schedules.filter((row) => String(row.device_eui).toUpperCase() === eui && row.deleted_at == null);
      return push.prepareClearRevisionTx(tx, {
        deviceEui: eui,
        generation,
        schedules,
        now: new Date(nowMs),
        reason: 'retry',
        force: true,
      });
    });
    const sent = !options.deferTransport && options.transport
      ? await push.sendPreparedRevision({ db, deviceEui: eui, revision: prepared.revision, transport: options.transport, now: new Date(nowMs), warn: options.warn })
      : null;
    return { ...prepared, device_eui: eui, send: sent };
  });
  await notifyAfterCommit(options, { zone_uuid: zone.zone_uuid, valve_euis: [eui] });
  return { status: 202, device_eui: eui, ...result };
}

function encodeDecisionCursor(row) {
  const value = {
    v: 1,
    order_at: row.decision_at || row.due_at,
    schedule_uuid: String(row.schedule_uuid),
    local_date: String(row.local_date),
    local_time: String(row.local_time),
  };
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeDecisionCursor(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string' || raw.length > 2048) throw apiError(422, 'invalid_cursor', 'before cursor is invalid');
  let value;
  if (!/^[A-Za-z0-9_-]+$/.test(raw)) throw apiError(422, 'invalid_cursor', 'before cursor is invalid');
  try {
    const decoded = Buffer.from(raw, 'base64url');
    if (!decoded.length || decoded.toString('base64url') !== raw) throw new Error('non-canonical cursor');
    value = JSON.parse(decoded.toString('utf8'));
  } catch (_) { throw apiError(422, 'invalid_cursor', 'before cursor is invalid'); }
  if (!value || typeof value !== 'object' || value.v !== 1
      || typeof value.order_at !== 'string' || !Number.isFinite(parseInstant(value.order_at))
      || typeof value.schedule_uuid !== 'string' || !value.schedule_uuid
      || typeof value.local_date !== 'string' || !value.local_date
      || typeof value.local_time !== 'string' || !value.local_time) {
    throw apiError(422, 'invalid_cursor', 'before cursor is invalid');
  }
  return value;
}

async function listDecisions(options = {}) {
  const db = options.db; if (!db) throw new TypeError('listDecisions requires db');
  const zone = await zoneRow(db, options.zone || options.zoneRef || options.zone_uuid); await assertZoneAccess(db, zone, options.actor, { write: false });
  const rawLimit = options.limit == null ? 100 : Number(options.limit); if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) throw apiError(422, 'invalid_limit', 'limit must be between 1 and 100');
  const cursor = decodeDecisionCursor(options.before);
  const policy = await db.get('SELECT policy_uuid FROM irrigation_policies WHERE zone_uuid=? AND deleted_at IS NULL', [zone.zone_uuid]);
  if (!policy) return { decisions: [], next_cursor: null, limit: 0 };
  const orderAt = 'COALESCE(decision_at,due_at)';
  let predicate = '';
  let params = [policy.policy_uuid];
  if (cursor) {
    predicate = ` AND (${orderAt} < ? OR (${orderAt} = ? AND schedule_uuid > ?) OR (${orderAt} = ? AND schedule_uuid = ? AND local_date > ?) OR (${orderAt} = ? AND schedule_uuid = ? AND local_date = ? AND local_time > ?))`;
    params = params.concat([
      cursor.order_at, cursor.order_at, cursor.schedule_uuid,
      cursor.order_at, cursor.schedule_uuid, cursor.local_date,
      cursor.order_at, cursor.schedule_uuid, cursor.local_date, cursor.local_time,
    ]);
  }
  params.push(rawLimit + 1);
  const rows = await db.all(`SELECT * FROM irrigation_occurrences WHERE policy_uuid=?${predicate} ORDER BY ${orderAt} DESC, schedule_uuid ASC, local_date ASC, local_time ASC LIMIT ?`, params);
  const page = rows.slice(0, rawLimit).map((row) => ({ ...row, decision_evidence: parseObject(row.decision_evidence_json, 'decision_evidence_json', null) }));
  return { decisions: page, next_cursor: rows.length > rawLimit ? page[page.length - 1] && encodeDecisionCursor(page[page.length - 1]) : null, limit: rawLimit };
}

function requestBody(msg) {
  const contentLength = Number(msg.req && msg.req.headers && msg.req.headers['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) throw apiError(413, 'body_too_large', 'request body exceeds 256 KiB');
  return msg.req && msg.req.body !== undefined ? msg.req.body : (msg.payload || {});
}

function routeMatch(path) {
  return /^\/api\/irrigation-zones\/(\d+|[0-9A-Fa-f-]+)\/irrigation-policy(?:\/(pause|retry-valve|decisions))?$/.exec(path);
}

async function handleHttpRequest(options = {}) {
  const msg = options.msg || {}; const method = String(msg.req && msg.req.method || '').toUpperCase();
  const path = String(msg.req && (msg.req.path || msg.req.originalUrl || msg.req.url) || '').split('?')[0];
  const match = routeMatch(path); const respond = (status, payload) => { msg.statusCode = status; msg.payload = payload; msg.headers = HEADERS; return msg; };
  if (method === 'OPTIONS') return respond(204, null);
  if (!match) return respond(404, { error: 'not_found', reason: 'not_found', message: 'policy route not found' });
  let db = options.db; let ownDb = false;
  try {
    if (!db && options.Database) { db = new options.Database(options.dbPath || '/data/db/farming.db'); ownDb = true; }
    if (!db) throw apiError(503, 'database_unavailable', 'policy database is unavailable');
    const actor = options.actor || msg.auth || msg.user || (msg.req && (msg.req.auth || msg.req.user));
    const zone = match[1]; const child = match[2]; const common = { ...options, db, actor, zone, request: method === 'PUT' || method === 'POST' ? requestBody(msg) : {} };
    let result;
    if (!child && method === 'GET') result = await readPolicy(common);
    else if (!child && method === 'PUT') result = await applyPolicyEdit(common);
    else if (child === 'pause' && method === 'POST') result = await pausePolicy(common);
    else if (child === 'retry-valve' && method === 'POST') result = await retryValve(common);
    else if (child === 'decisions' && method === 'GET') result = await listDecisions({ ...common, limit: new URLSearchParams(String(msg.req && msg.req.url || '').split('?')[1] || '').get('limit'), before: new URLSearchParams(String(msg.req && msg.req.url || '').split('?')[1] || '').get('before') });
    else return respond(405, { error: 'method_not_allowed', reason: 'method_not_allowed', message: 'method not allowed' });
    return respond(result.status || 200, result);
  } catch (error) {
    const status = Number(error && (error.statusCode || error.status)) || 500;
    return respond(status, { error: error.code || 'policy_error', reason: error.code || 'policy_error', message: error.message || 'policy request failed', details: error.details, affected_ids: error.affected_ids || [] });
  } finally {
    if (ownDb && db && typeof db.close === 'function') {
      try { await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve())); } catch (_) { /* route result already decided */ }
    }
  }
}

// R19 finding 5: the valve writers a cloud policy command will take, discovered before its
// ledger transaction opens, so the command acquires them first (the lifecycle adapter's order).
// The service re-discovers inside and refuses a drifted set; the caller then retries.
async function discoverCommandWriters(db, commandType, request = {}) {
  if (commandType === 'RETRY_IRRIGATION_VALVE') {
    const eui = normalizeEui(request.device_eui || request.deveui);
    return eui ? [eui] : [];
  }
  const zone = await zoneRow(db, request.zone_uuid || request.zone_id || request.zoneRef);
  const discovered = await discoverAffected(db, zone, commandType === 'PAUSE_IRRIGATION_POLICY' ? {} : request);
  return discovered.keys;
}

module.exports = {
  apiError,
  discoverCommandWriters,
  linkFence,
  normalizeDeliverySettings,
  completePolicyEditTransport,
  completePauseTransport,
  completeRetryValveTransport,
  readSourceOptions,
  applyPolicyEdit,
  discoverPolicyMembershipTx,
  preparePolicyRevisionsTx,
  pausePolicyTx,
  retirePolicyTx,
  readPolicy,
  pausePolicy,
  retryValve,
  listDecisions,
  handleHttpRequest,
};
