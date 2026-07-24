'use strict';

const crypto = require('node:crypto');

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EUI64 = /^[0-9A-F]{16}$/;
const TYPES = new Set(['UPSERT_DEVICE', 'UNCLAIM_DEVICE']);
const DEVICE_TYPES = new Set([
  'KIWI_SENSOR',
  'TEKTELIC_CLOVER',
  'DRAGINO_LSN50',
  'SENSECAP_S2120',
  'AQUASCOPE_LORAIN',
  'STREGA_VALVE',
]);
const DEPTH_KEYS = new Set(['swt_1', 'swt_2', 'swt_3']);

function commandError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw commandError('malformed_command', `${field} must be an object`);
  }
  return value;
}

function exactObject(value, field, required) {
  const result = object(value, field);
  const allowed = new Set(required);
  const missing = required.filter((key) => !Object.hasOwn(result, key));
  const extra = Object.keys(result).filter((key) => !allowed.has(key));
  if (missing.length || extra.length) {
    throw commandError(
      'malformed_command',
      `${field} shape mismatch; missing=${missing.join(',') || 'none'}, ` +
        `extra=${extra.join(',') || 'none'}`
    );
  }
  return result;
}

function requiredText(value, field, maxLength) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw commandError('malformed_command', `${field} is required`);
  if (maxLength && text.length > maxLength) {
    throw commandError(
      'malformed_command',
      `${field} must not exceed ${maxLength} characters`
    );
  }
  return text;
}

function uuid(value, field, nullable) {
  if (nullable && value == null) return null;
  const text = requiredText(value, field).toLowerCase();
  if (!UUID.test(text)) {
    throw commandError('malformed_command', `${field} must be a canonical UUID`);
  }
  return text;
}

function eui(value, field) {
  const text = requiredText(value, field).toUpperCase();
  if (!EUI64.test(text)) {
    throw commandError('malformed_command', `${field} must be an EUI-64`);
  }
  return text;
}

function version(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw commandError(
      'malformed_command',
      `${field} must be a non-negative integer`
    );
  }
  return value;
}

function booleanInteger(value, field) {
  if (![0, 1].includes(value)) {
    throw commandError('malformed_command', `${field} must be 0 or 1`);
  }
  return value;
}

function nullablePositiveFinite(value, field) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw commandError(
      'malformed_command',
      `${field} must be positive and finite or null`
    );
  }
  return value;
}

function canonicalHash(value) {
  function canonical(item) {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') {
      return Object.keys(item).sort().reduce((out, key) => {
        if (key !== 'command_id') out[key] = canonical(item[key]);
        return out;
      }, {});
    }
    return item;
  }
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function typeOf(envelope) {
  return String(
    envelope && (envelope.commandType || envelope.command_type) || ''
  ).trim().toUpperCase();
}

function protectedCandidate(payload) {
  return payload && typeof payload === 'object' && !Array.isArray(payload) &&
    ['effect_key', 'base_sync_version', 'target_sync_version', 'device']
      .some((field) => Object.hasOwn(payload, field));
}

function deliveryId(envelope) {
  const value = envelope && envelope.commandId;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw commandError(
      'malformed_command',
      'Pending delivery commandId must be a positive integer'
    );
  }
  return value;
}

function validateEnvelope(envelope, runtime) {
  envelope = object(envelope, 'Pending command envelope');
  const type = typeOf(envelope);
  if (!TYPES.has(type)) return null;
  const rawPayload = envelope.payload;
  if (!protectedCandidate(rawPayload)) return null;
  const payload = exactObject(
    rawPayload,
    'Pending command payload',
    [
      'command_id',
      'command_type',
      'effect_key',
      'device_eui',
      'gateway_device_eui',
      'base_sync_version',
      'target_sync_version',
      'device',
    ]
  );
  deliveryId(envelope);
  uuid(payload.command_id, 'command_id');
  if (payload.command_type !== type) {
    throw commandError('malformed_command', 'command_type must be canonical');
  }
  const deviceEui = eui(payload.device_eui, 'device_eui');
  const runtimeGateway = eui(
    runtime && runtime.gateway_device_eui,
    'Runtime gateway EUI'
  );
  if (eui(payload.gateway_device_eui, 'gateway_device_eui') !==
      runtimeGateway) {
    throw commandError(
      'gateway_mismatch',
      'Command gateway does not match this gateway'
    );
  }
  const base = version(payload.base_sync_version, 'base_sync_version');
  const target = version(payload.target_sync_version, 'target_sync_version');
  if (target !== base + 1) {
    throw commandError(
      'malformed_command',
      'target_sync_version must equal base_sync_version + 1'
    );
  }
  const prefix = type === 'UNCLAIM_DEVICE' ? 'device_unclaim' : 'device';
  const effectKey = `${prefix}:${deviceEui}:${base}`;
  if (String(payload.effect_key || '').trim() !== effectKey) {
    throw commandError(
      'malformed_command',
      'effect_key does not match device EUI and base version'
    );
  }
  return {
    type,
    payload,
    rawDevice: object(payload.device, 'device'),
    deviceEui,
    gateway: runtimeGateway,
    base,
    target,
    effectKey,
  };
}

function depthMap(value, configured, type) {
  const map = object(value, 'device.soil_moisture_probe_depths_json');
  const result = {};
  for (const [rawKey, rawValue] of Object.entries(map)) {
    const key = String(rawKey).trim().toLowerCase();
    if (!DEPTH_KEYS.has(key) || !Number.isSafeInteger(rawValue) ||
        rawValue < 1 || rawValue > 1000) {
      throw commandError(
        'malformed_command',
        'device soil probe depths must use swt_1..swt_3 and 1..1000 cm'
      );
    }
    result[key] = rawValue;
  }
  const enabled = booleanInteger(
    configured,
    'device.soil_moisture_probe_depths_configured'
  );
  if (!['KIWI_SENSOR', 'TEKTELIC_CLOVER'].includes(type) &&
      (Object.keys(result).length || enabled !== 0)) {
    throw commandError(
      'type_mismatch',
      'Soil probe depths are valid only for Kiwi and Clover devices'
    );
  }
  return {
    json: JSON.stringify(
      Object.keys(result).sort().reduce((out, key) => {
        out[key] = result[key];
        return out;
      }, {})
    ),
    configured: enabled,
  };
}

function normalizedDevice(command) {
  const device = exactObject(command.rawDevice, 'device', [
    'contract_version',
    'device_eui',
    'name',
    'type',
    'claimed_user_uuid',
    'zone_uuid',
    'dendro_enabled',
    'temp_enabled',
    'rain_gauge_enabled',
    'flow_meter_enabled',
    'is_reference_tree',
    'chameleon_enabled',
    'soil_moisture_probe_depths_json',
    'soil_moisture_probe_depths_configured',
    'chameleon_swt1_depth_cm',
    'chameleon_swt2_depth_cm',
    'chameleon_swt3_depth_cm',
    'strega_model',
    'gateway_device_eui',
    'sync_version',
    'deleted_at',
  ]);
  if (device.contract_version !== 1) {
    throw commandError(
      'malformed_command',
      'device.contract_version must equal 1'
    );
  }
  if (eui(device.device_eui, 'device.device_eui') !== command.deviceEui ||
      eui(device.gateway_device_eui, 'device.gateway_device_eui') !==
        command.gateway ||
      version(device.sync_version, 'device.sync_version') !== command.target) {
    throw commandError(
      'malformed_command',
      'device identity does not match the protected envelope'
    );
  }
  const type = requiredText(device.type, 'device.type').toUpperCase();
  if (!DEVICE_TYPES.has(type)) {
    throw commandError('type_mismatch', 'Device type is not supported');
  }
  const ownerUuid = uuid(
    device.claimed_user_uuid,
    'device.claimed_user_uuid',
    true
  );
  const zoneUuid = uuid(device.zone_uuid, 'device.zone_uuid', true);
  if (command.type === 'UNCLAIM_DEVICE') {
    if (ownerUuid !== null || zoneUuid !== null) {
      throw commandError(
        'malformed_command',
        'UNCLAIM_DEVICE requires null owner and zone UUIDs'
      );
    }
  } else if (ownerUuid === null) {
    throw commandError(
      'malformed_command',
      'UPSERT_DEVICE requires a claimed owner'
    );
  }
  if (device.deleted_at !== null) {
    throw commandError(
      'malformed_command',
      'device.deleted_at must be null'
    );
  }
  const flags = {
    dendro: booleanInteger(device.dendro_enabled, 'device.dendro_enabled'),
    temp: booleanInteger(device.temp_enabled, 'device.temp_enabled'),
    rain: booleanInteger(
      device.rain_gauge_enabled,
      'device.rain_gauge_enabled'
    ),
    flow: booleanInteger(
      device.flow_meter_enabled,
      'device.flow_meter_enabled'
    ),
    reference: booleanInteger(
      device.is_reference_tree,
      'device.is_reference_tree'
    ),
    chameleon: booleanInteger(
      device.chameleon_enabled,
      'device.chameleon_enabled'
    ),
  };
  if (type !== 'DRAGINO_LSN50' &&
      Object.values(flags).some((value) => value !== 0)) {
    throw commandError(
      'type_mismatch',
      'LSN50 feature flags are invalid for this device type'
    );
  }
  if (flags.reference && !flags.dendro) {
    throw commandError(
      'malformed_command',
      'A reference tree requires dendro_enabled'
    );
  }
  const depths = depthMap(
    device.soil_moisture_probe_depths_json,
    device.soil_moisture_probe_depths_configured,
    type
  );
  const chameleonDepths = [
    nullablePositiveFinite(
      device.chameleon_swt1_depth_cm,
      'device.chameleon_swt1_depth_cm'
    ),
    nullablePositiveFinite(
      device.chameleon_swt2_depth_cm,
      'device.chameleon_swt2_depth_cm'
    ),
    nullablePositiveFinite(
      device.chameleon_swt3_depth_cm,
      'device.chameleon_swt3_depth_cm'
    ),
  ];
  if ((type !== 'DRAGINO_LSN50' || flags.chameleon === 0) &&
      chameleonDepths.some((value) => value !== null)) {
    throw commandError(
      'type_mismatch',
      'Chameleon depths require a Chameleon-enabled LSN50'
    );
  }
  const stregaModel = device.strega_model == null
    ? null
    : requiredText(device.strega_model, 'device.strega_model').toUpperCase();
  if (stregaModel != null &&
      (!['STANDARD', 'MOTORIZED'].includes(stregaModel) ||
       type !== 'STREGA_VALVE')) {
    throw commandError(
      'type_mismatch',
      'STREGA model is invalid for this device type'
    );
  }
  return {
    name: requiredText(device.name, 'device.name', 128),
    type,
    ownerUuid,
    zoneUuid,
    flags,
    depths,
    chameleonDepths,
    stregaModel,
  };
}

async function localIdentity(tx, command, device) {
  const current = await tx.get(
    'SELECT * FROM devices WHERE deveui=? LIMIT 1',
    [command.deviceEui]
  );
  if (!current || current.deleted_at != null) {
    throw commandError('missing_resource', 'Device is not present locally');
  }
  if (String(current.gateway_device_eui || '').trim().toUpperCase() !==
      command.gateway) {
    throw commandError(
      'gateway_mismatch',
      'Existing device belongs to another gateway'
    );
  }
  if (String(current.type_id || '').trim().toUpperCase() !== device.type) {
    throw commandError('type_mismatch', 'Device type cannot be changed');
  }
  const actual = Number(current.sync_version || 0);
  if (actual !== command.base) {
    throw commandError(
      'base_version_conflict',
      `base_sync_version conflict: expected ${actual}`
    );
  }
  return current;
}

async function ownerId(tx, ownerUuid) {
  if (ownerUuid == null) return null;
  const owner = await tx.get(
    'SELECT id FROM users WHERE user_uuid=? AND disabled_at IS NULL LIMIT 1',
    [ownerUuid]
  );
  if (!owner) {
    throw commandError(
      'inaccessible_owner',
      'Device owner is not accessible locally'
    );
  }
  return Number(owner.id);
}

async function zoneId(tx, zoneUuid, owner, gateway) {
  if (zoneUuid == null) return null;
  const zone = await tx.get(
    'SELECT id,user_id,gateway_device_eui FROM irrigation_zones ' +
      'WHERE zone_uuid=? AND deleted_at IS NULL LIMIT 1',
    [zoneUuid]
  );
  if (!zone) {
    throw commandError('missing_resource', 'Device zone is not present locally');
  }
  if (String(zone.gateway_device_eui || '').trim().toUpperCase() !== gateway ||
      Number(zone.user_id) !== owner) {
    throw commandError(
      'inaccessible_zone',
      'Device zone is not accessible to the selected owner'
    );
  }
  return Number(zone.id);
}

async function applyMutation(tx, command) {
  const device = normalizedDevice(command);
  const current = await localIdentity(tx, command, device);
  const owner = await ownerId(tx, device.ownerUuid);
  if (command.type === 'UPSERT_DEVICE' &&
      Number(current.user_id) !== owner) {
    throw commandError(
      'owner_mismatch',
      'Device owner cannot be changed by an upsert'
    );
  }
  const zone = await zoneId(tx, device.zoneUuid, owner, command.gateway);
  const now = new Date().toISOString();
  await tx.run(
    'UPDATE devices SET ' +
      'name=?,user_id=?,irrigation_zone_id=?,dendro_enabled=?,' +
      'temp_enabled=?,rain_gauge_enabled=?,flow_meter_enabled=?,' +
      'is_reference_tree=?,chameleon_enabled=?,' +
      'soil_moisture_probe_depths_json=?,' +
      'soil_moisture_probe_depths_configured=?,' +
      'chameleon_swt1_depth_cm=?,chameleon_swt2_depth_cm=?,' +
      'chameleon_swt3_depth_cm=?,strega_model=?,sync_version=?,' +
      'claimed_at=CASE WHEN ? IS NULL THEN NULL ' +
        'WHEN user_id IS NULL THEN ? ELSE claimed_at END,' +
      'updated_at=? WHERE deveui=?',
    [
      device.name,
      owner,
      zone,
      device.flags.dendro,
      device.flags.temp,
      device.flags.rain,
      device.flags.flow,
      device.flags.reference,
      device.flags.chameleon,
      device.depths.json,
      device.depths.configured,
      device.chameleonDepths[0],
      device.chameleonDepths[1],
      device.chameleonDepths[2],
      device.stregaModel,
      command.target,
      owner,
      now,
      now,
      command.deviceEui,
    ]
  );
  return {
    current,
    appliedSyncVersion: command.target,
    resourceUuid: command.deviceEui,
  };
}

function classify(error) {
  if (error && error.code === 'base_version_conflict') return 'CONFLICT';
  if (error && [
    'malformed_command',
    'gateway_mismatch',
    'missing_resource',
    'inaccessible_owner',
    'inaccessible_zone',
    'owner_mismatch',
    'type_mismatch',
  ].includes(error.code)) {
    return 'REJECTED_PERMANENT';
  }
  return null;
}

function parsedAck(row) {
  if (!row || !row.result_detail) return null;
  try {
    const result = JSON.parse(row.result_detail);
    return result && typeof result === 'object' && !Array.isArray(result)
      ? result
      : null;
  } catch (_) {
    return null;
  }
}

async function queueAck(tx, ack, appliedAt) {
  await tx.run(
    'DELETE FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
    [String(ack.commandId)]
  );
  await tx.run(
    'INSERT INTO command_ack_outbox(command_id,payload_json,created_at) ' +
      'VALUES (?,?,?)',
    [String(ack.commandId), JSON.stringify(ack), appliedAt]
  );
}

async function persistTerminal(tx, envelope, command, terminal) {
  const appliedAt = terminal.appliedAt || new Date().toISOString();
  const ack = {
    commandId: deliveryId(envelope),
    commandType: command.type,
    effectKey: command.effectKey,
    status: terminal.result === 'APPLIED'
      ? 'ACKED'
      : terminal.result === 'CONFLICT' ? 'CONFLICT' : 'NACKED',
    result: terminal.result,
    appliedSyncVersion: terminal.currentVersion,
    duplicate: false,
    gatewayDeviceEui: command.gateway,
    resourceUuid: command.deviceEui,
    payloadHash: canonicalHash(command.payload),
    appliedAt,
  };
  if (terminal.reason) ack.reason = terminal.reason;
  await tx.run(
    'INSERT INTO applied_commands(' +
      'command_id,device_eui,command_type,effect_key,applied_at,result,' +
      'result_detail,originator' +
    ') VALUES (?,?,?,?,?,?,?,?)',
    [
      String(ack.commandId),
      command.gateway,
      command.type,
      command.effectKey,
      appliedAt,
      terminal.result,
      JSON.stringify(ack),
      'cloud',
    ]
  );
  await queueAck(tx, ack, appliedAt);
  return ack;
}

async function applyOnce(db, envelope, runtime) {
  const command = validateEnvelope(envelope, runtime);
  if (!command) return { handled: false };
  return db.transaction(async (tx) => {
    const prior = await tx.get(
      'SELECT * FROM applied_commands WHERE command_id=? LIMIT 1',
      [String(deliveryId(envelope))]
    );
    if (prior) {
      const ack = parsedAck(prior);
      if (!ack) {
        throw commandError(
          'malformed_command',
          'Stored command result is not replayable'
        );
      }
      await queueAck(tx, ack, ack.appliedAt || new Date().toISOString());
      return { handled: true, ack };
    }
    try {
      const terminal = await applyMutation(tx, command);
      return {
        handled: true,
        ack: await persistTerminal(tx, envelope, command, {
          result: 'APPLIED',
          currentVersion: terminal.appliedSyncVersion,
        }),
      };
    } catch (error) {
      const result = classify(error);
      if (!result) throw error;
      const current = await tx.get(
        'SELECT sync_version FROM devices WHERE deveui=? LIMIT 1',
        [command.deviceEui]
      );
      return {
        handled: true,
        ack: await persistTerminal(tx, envelope, command, {
          result,
          currentVersion: current ? Number(current.sync_version || 0) : 0,
          reason: error.message,
        }),
      };
    }
  });
}

let applyTail = Promise.resolve();

function enqueue(work) {
  const scheduled = applyTail.then(work, work);
  applyTail = scheduled.then(() => {}, () => {});
  return scheduled;
}

function applyDeviceCommand(db, envelope, runtime) {
  return enqueue(() => applyOnce(db, envelope, runtime));
}

module.exports = {
  TYPES,
  applyDeviceCommand,
  intentHash: canonicalHash,
  _resetForTests() {
    applyTail = Promise.resolve();
  },
};
