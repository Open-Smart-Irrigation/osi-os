'use strict';

// Cloud-originated configuration receiver.  The command-ledger transaction
// owns replay/effect binding, applied_commands and command_ack_outbox; this
// module only validates authorization and performs the canonical local write
// through the same calibration seams used by the HTTP routes.
const ledger = require('../osi-command-ledger');
const calibration = require('./calibration');

const COMMAND_TYPES = [
  'SET_WATERMARK_CALIBRATION',
  'DELETE_WATERMARK_CALIBRATION',
  'SET_CHAMELEON_CONFIG',
  'UPSERT_DEVICE_SOIL_DEPTHS',
];
const EUI = /^[0-9A-F]{16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TYPES = new Set(['KIWI_SENSOR', 'TEKTELIC_CLOVER', 'DRAGINO_SDI12', 'DRAGINO_LSN50']);
const CAL_TYPES = new Set(['SET_WATERMARK_CALIBRATION', 'DELETE_WATERMARK_CALIBRATION', 'SET_CHAMELEON_CONFIG']);
const CAPABILITY = {
  SET_WATERMARK_CALIBRATION: 'watermark_calibration',
  DELETE_WATERMARK_CALIBRATION: 'watermark_calibration',
  SET_CHAMELEON_CONFIG: 'chameleon_config',
  UPSERT_DEVICE_SOIL_DEPTHS: 'soil_moisture_depths',
};

function error(code, message, result = 'REJECTED_PERMANENT') {
  const e = new Error(message);
  e.code = 'watermark_command_rejected';
  e.reason = code;
  e.commandResult = result;
  return e;
}

function str(value) { return value == null ? '' : String(value); }
function upperEui(value) { return str(value).toUpperCase(); }
function canonicalUuid(value) { return str(value).toLowerCase(); }
function scopedAccessEnabled(runtime) {
  if (runtime && runtime.scopedMode !== undefined) return runtime.scopedMode === true;
  return String(process.env.OSI_SCOPED_ACCESS || '') === '1';
}

function expectedEffect(type, gateway, device, base) {
  const prefix = type === 'SET_CHAMELEON_CONFIG' ? 'chameleon_config:set' :
    type === 'UPSERT_DEVICE_SOIL_DEPTHS' ? 'device_soil_depths:set' :
      type === 'DELETE_WATERMARK_CALIBRATION' ? 'watermark_calibration:delete' : 'watermark_calibration:set';
  return `${prefix}:${gateway}:${device}:${base}`;
}

function validateIdentity(type, payload, runtime) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw error('malformed_command', 'payload must be an object');
  if (str(payload.command_type) !== type) throw error('malformed_command', 'command_type does not match the envelope');
  if (!UUID.test(str(payload.command_id))) throw error('malformed_command', 'command_id must be a canonical UUID');
  if (!UUID.test(str(payload.actor_user_uuid))) throw error('malformed_command', 'actor_user_uuid must be a canonical UUID');
  const gateway = str(payload.gateway_device_eui);
  const device = str(payload.device_eui);
  const trusted = upperEui(runtime && runtime.gateway_device_eui);
  if (!EUI.test(gateway) || gateway !== upperEui(gateway)) throw error('binding_mismatch', 'gateway_device_eui must be upper-case canonical EUI', 'CONFLICT');
  if (!EUI.test(device) || device !== upperEui(device)) throw error('binding_mismatch', 'device_eui must be upper-case canonical EUI', 'CONFLICT');
  if (gateway !== trusted) throw error('binding_mismatch', 'command belongs to another gateway', 'CONFLICT');
  const localActor = runtime && (runtime.local_actor_user_uuid || runtime.localActorUserUuid);
  if (localActor && canonicalUuid(localActor) !== canonicalUuid(payload.actor_user_uuid)) {
    throw error('binding_mismatch', 'actor is not the gateway-local actor', 'CONFLICT');
  }
  if (!Number.isSafeInteger(payload.base_sync_version) || payload.base_sync_version < 0) throw error('malformed_command', 'base_sync_version must be a non-negative integer');
  const expectedOperation = type === 'DELETE_WATERMARK_CALIBRATION' ? 'delete' : 'set';
  if (payload.operation !== expectedOperation) throw error('binding_mismatch', 'operation does not match command type', 'CONFLICT');
  const effect = str(payload.effect_key || payload.effectKey || '');
  if (effect !== expectedEffect(type, gateway, device, payload.base_sync_version)) throw error('binding_mismatch', 'effect_key does not match exact base', 'CONFLICT');
  return { gateway, device, actorUuid: canonicalUuid(payload.actor_user_uuid), base: payload.base_sync_version };
}

async function authorizeDevice(tx, identity, type, runtime) {
  const device = await tx.get(
    'SELECT d.*, iz.zone_uuid, iz.gateway_device_eui AS zone_gateway, iz.deleted_at AS zone_deleted ' +
    'FROM devices d LEFT JOIN irrigation_zones iz ON iz.id=d.irrigation_zone_id ' +
    'WHERE UPPER(d.deveui)=? AND d.deleted_at IS NULL', [identity.device]
  );
  if (!device) throw error('device_not_found', 'Device not found');
  if (upperEui(device.gateway_device_eui) !== identity.gateway) throw error('binding_mismatch', 'device belongs to another gateway', 'CONFLICT');
  if (type === 'SET_CHAMELEON_CONFIG' && device.type_id !== 'DRAGINO_LSN50') throw error('unsupported_device_type', 'Chameleon is only supported on DRAGINO_LSN50');
  if (type === 'UPSERT_DEVICE_SOIL_DEPTHS' && !TYPES.has(device.type_id)) throw error('unsupported_device_type', 'soil moisture depths are not supported on this device');
  const actor = await tx.get('SELECT id,user_uuid,role,disabled_at FROM users WHERE user_uuid=? LIMIT 1', [identity.actorUuid]);
  if (!actor || actor.disabled_at) throw error('actor_missing_or_disabled', 'actor account is missing or disabled');
  if (!scopedAccessEnabled(runtime)) {
    if (device.user_id == null || Number(device.user_id) !== Number(actor.id)) throw error('forbidden', 'actor does not own this device');
    return { device, actor };
  }
  if (!['admin', 'researcher'].includes(actor.role)) throw error('forbidden', 'actor role cannot mutate configuration');
  const linked = await tx.get(
    "SELECT linked,gateway_device_eui FROM sync_link_state WHERE peer_node='cloud' LIMIT 1"
  );
  if (!linked || Number(linked.linked) !== 1 || upperEui(linked.gateway_device_eui) !== identity.gateway) {
    throw error('gateway_not_linked', 'gateway is not linked for cloud configuration');
  }
  const account = runtime && (runtime.linkedAccount || runtime.linked_account);
  if (account && (account.enabled === false || account.disabled === true || account.disabled_at)) {
    throw error('gateway_account_disabled', 'linked gateway account is disabled');
  }
  const capability = runtime && runtime.capabilities;
  const advertised = Array.isArray(capability) ? capability.includes(CAPABILITY[type]) :
    (capability && typeof capability === 'object' ? capability[CAPABILITY[type]] === true : true);
  if (!advertised || (account && account.capabilities && account.capabilities[CAPABILITY[type]] === false)) {
    throw error('capability_missing', 'gateway does not advertise this configuration capability');
  }
  if (device.irrigation_zone_id != null && !device.zone_deleted) {
    const zoneOwned = Number(device.user_id) === Number(actor.id);
    const grant = await tx.get(
      'SELECT 1 AS ok FROM user_zone_assignments WHERE user_uuid=? AND zone_uuid=? AND deleted_at IS NULL LIMIT 1',
      [identity.actorUuid, device.zone_uuid]
    );
    if (!zoneOwned && !grant) throw error('forbidden', 'actor has no active grant for the assigned zone');
    if (upperEui(device.zone_gateway || '') !== identity.gateway) throw error('binding_mismatch', 'assigned zone belongs to another gateway', 'CONFLICT');
  } else if (device.user_id == null || Number(device.user_id) !== Number(actor.id)) {
    if (actor.role !== 'admin') throw error('forbidden', 'unassigned devices require owner or admin access');
  }
  return { device, actor };
}

function normalizeBoolean(value) {
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  if (value === false || value === 0 || value === '0' || value === 'false') return 0;
  throw error('invalid_values', 'chameleon_enabled must be boolean');
}

function normalizeDepths(value) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) throw error('invalid_values', 'soil depths must be an object');
  const out = {};
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = str(rawKey).trim().toLowerCase();
    if (!key) throw error('invalid_values', 'soil depth keys must be nonblank');
    if (rawValue === null || rawValue === 0) continue;
    if (!Number.isInteger(rawValue) || rawValue < 1 || rawValue > 1000) throw error('invalid_values', 'soil depths must be integers from 1 to 1000');
    out[key] = rawValue;
  }
  return Object.keys(out).sort().reduce((o, k) => { o[k] = out[k]; return o; }, {});
}

async function applyMutation(scoped, envelope, runtime, type, identity) {
  const tx = scoped.tx;
  const access = await authorizeDevice(tx, identity, type, runtime);
  if (CAL_TYPES.has(type) && type !== 'SET_CHAMELEON_CONFIG') {
    if (type === 'SET_WATERMARK_CALIBRATION') {
      const body = Object.assign({}, envelope.payload.values || {}, { expected_sync_version: identity.base });
      const input = calibration.validateCalibrationBody(body);
      const saved = await calibration.saveCalibrationTx(tx, { deveui: identity.device, userId: access.actor.id, scoped: true, input });
      return { appliedSyncVersion: saved.row.sync_version, backfill: saved.first, calibrationRow: saved.row };
    }
    const saved = await calibration.deleteCalibrationTx(tx, { deveui: identity.device, userId: access.actor.id, scoped: true, expectedSyncVersion: identity.base });
    return { appliedSyncVersion: saved.sync_version };
  }
  const row = access.device;
  const current = Number(row.sync_version || 0);
  if (identity.base !== current) throw error('stale_sync_version', 'Device changed since the command was issued', 'CONFLICT');
  if (type === 'SET_CHAMELEON_CONFIG') {
    const enabled = normalizeBoolean(envelope.payload.values && envelope.payload.values.chameleon_enabled);
    await tx.run("UPDATE devices SET chameleon_enabled=?, sync_version=COALESCE(sync_version,0)+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE deveui=? AND sync_version=?", [enabled, identity.device, identity.base]);
  } else {
    const values = envelope.payload.values || {};
    const depths = normalizeDepths(values.soil_moisture_probe_depths_json);
    if (values.soil_moisture_probe_depths_configured !== true && values.soil_moisture_probe_depths_configured !== 1) throw error('invalid_values', 'soil_moisture_probe_depths_configured must be true');
    await tx.run("UPDATE devices SET soil_moisture_probe_depths_json=?, soil_moisture_probe_depths_configured=1, sync_version=COALESCE(sync_version,0)+1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE deveui=? AND sync_version=?", [JSON.stringify(depths), identity.device, identity.base]);
  }
  const updated = await tx.get('SELECT sync_version FROM devices WHERE deveui=?', [identity.device]);
  if (!updated || Number(updated.sync_version) !== identity.base + 1) throw error('stale_sync_version', 'Device changed during configuration', 'CONFLICT');
  return { appliedSyncVersion: updated.sync_version };
}

async function applyWatermarkCommand(db, envelope, runtime = {}) {
  const type = String(envelope && envelope.commandType || '').toUpperCase();
  if (!COMMAND_TYPES.includes(type)) return { handled: false };
  const payload = envelope.payload || {};
  const trusted = Object.assign({}, runtime.protected_context || runtime.protectedContext || {}, {
    resource_type: type === 'SET_CHAMELEON_CONFIG' ? 'CHAMELEON_CONFIG' : type === 'UPSERT_DEVICE_SOIL_DEPTHS' ? 'DEVICE_SOIL_DEPTHS' : 'WATERMARK_CALIBRATION',
    operation: type === 'DELETE_WATERMARK_CALIBRATION' ? 'delete' : 'set',
    command_type: type,
  });
  const commandRuntime = Object.assign({}, runtime, { command_type_recognized: true, protected_context: trusted });
  const result = await ledger.withProtectedCommandTransaction(db, Object.assign({}, envelope, { commandType: type }), commandRuntime, async (scoped) => {
    let identity;
    try {
      identity = validateIdentity(type, payload, runtime);
      const result = await applyMutation(scoped, envelope, runtime, type, identity);
      const ack = await scoped.terminalAck({
        commandId: envelope.commandId,
        result: 'APPLIED', status: 'ACKED', reason: null,
        appliedSyncVersion: result.appliedSyncVersion, duplicate: false,
      });
      return { handled: true, ack, backfill: result.backfill, calibrationRow: result.calibrationRow };
    } catch (cause) {
      if (cause && cause.code && /SQLITE/.test(cause.code)) throw cause;
      if (cause && ['stale_sync_version', 'calibration_not_found', 'invalid_calibration', 'invalid_body'].includes(cause.code)) {
        cause = error(cause.code, cause.message, cause.statusCode === 409 ? 'CONFLICT' : 'REJECTED_PERMANENT');
      }
      if (!cause || cause.code !== 'watermark_command_rejected') throw cause;
      const ack = await scoped.terminalAck({
        commandId: envelope.commandId,
        result: cause.commandResult || 'REJECTED_PERMANENT',
        status: cause.commandResult === 'CONFLICT' ? 'CONFLICT' : 'NACKED',
        reason: cause.reason || 'rejected', appliedSyncVersion: null, duplicate: false,
      });
      return { handled: true, ack };
    }
  });
  if (result && result.calibrationRow && result.backfill && result.backfill.more) {
    const rest = await calibration.backfillRemaining(db, upperEui(payload.device_eui), result.calibrationRow, result.backfill);
    if (rest.error) result.backfill_incomplete = true;
    result.backfilled = (result.backfill.converted || 0) + rest.converted;
  }
  return result;
}

const authorizationMatrix = [
  { id: 'missing_actor', outcome: 'REJECTED_PERMANENT' },
  { id: 'disabled_account', outcome: 'REJECTED_PERMANENT' },
  { id: 'viewer', outcome: 'REJECTED_PERMANENT' },
  { id: 'absent_grant', outcome: 'REJECTED_PERMANENT' },
  { id: 'dangling_assignment', outcome: 'REJECTED_PERMANENT' },
  { id: 'deleted_assignment', outcome: 'REJECTED_PERMANENT' },
  { id: 'foreign_assignment', outcome: 'REJECTED_PERMANENT' },
  { id: 'assigned_admin_without_grant', outcome: 'REJECTED_PERMANENT' },
  { id: 'valid_assigned_writer', outcome: 'APPLIED' },
  { id: 'valid_unassigned_owner', outcome: 'APPLIED' },
  { id: 'valid_unassigned_admin', outcome: 'APPLIED' },
  { id: 'stale_base', outcome: 'CONFLICT' },
];

module.exports = { COMMAND_TYPES, authorizationMatrix, applyWatermarkCommand, normalizeDepths, expectedEffect };
