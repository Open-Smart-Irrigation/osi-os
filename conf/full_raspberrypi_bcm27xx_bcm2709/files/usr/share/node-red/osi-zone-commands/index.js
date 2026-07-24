'use strict';

const crypto = require('node:crypto');

const UUID =
  /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EUI64 = /^[0-9A-F]{16}$/;
const TYPES = new Set([
  'UPSERT_ZONE',
  'DELETE_ZONE',
  'UPSERT_ZONE_CONFIG',
  'UPSERT_ZONE_LOCATION',
]);
const CONFIG_FIELDS = [
  'timezone',
  'phenological_stage',
  'calibration_key',
  'crop_type',
  'variety',
  'soil_type',
  'irrigation_method',
  'area_m2',
  'irrigation_efficiency_pct',
  'scheduling_mode',
  'prediction_card_enabled',
  'notes',
];

function commandError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw commandError('malformed_command', field + ' must be an object');
  }
  return value;
}

function typeOf(envelope) {
  return String(envelope && envelope.commandType || '').trim().toUpperCase();
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

function requiredText(value, field, maxLength) {
  const text = String(value == null ? '' : value).trim();
  if (!text) {
    throw commandError('malformed_command', field + ' is required');
  }
  if (maxLength && text.length > maxLength) {
    throw commandError(
      'malformed_command',
      field + ' must not exceed ' + maxLength + ' characters'
    );
  }
  return text;
}

function nullableText(value, field, maxLength) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (maxLength && text.length > maxLength) {
    throw commandError(
      'malformed_command',
      field + ' must not exceed ' + maxLength + ' characters'
    );
  }
  return text;
}

function uuid(value, field) {
  const normalized = requiredText(value, field).toLowerCase();
  if (!UUID.test(normalized)) {
    throw commandError(
      'malformed_command',
      field + ' must be a contract UUID'
    );
  }
  return normalized;
}

function version(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw commandError(
      'malformed_command',
      field + ' must be a non-negative integer'
    );
  }
  return value;
}

function nullableFinite(value, field, min, max, minExclusive) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw commandError('malformed_command', field + ' must be finite or null');
  }
  if ((minExclusive ? value <= min : value < min) || value > max) {
    throw commandError('malformed_command', field + ' is outside its valid range');
  }
  return value;
}

function booleanInteger(value, field) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw commandError('malformed_command', field + ' must be boolean');
}

function timestamp(value, field) {
  const text = requiredText(value, field, 64);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) {
    throw commandError(
      'malformed_command',
      field + ' must be a canonical ISO timestamp'
    );
  }
  return text;
}

function canonicalHash(value) {
  function canonical(item) {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') {
      return Object.keys(item).sort().reduce(function(out, key) {
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

function protectedCandidate(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return false;
  }
  return [
    'command_id',
    'effect_key',
    'base_sync_version',
    'target_sync_version',
    'zone',
  ].some(function(field) {
    return Object.prototype.hasOwnProperty.call(payload, field);
  });
}

function binding(type, payload) {
  const zoneUuid = uuid(payload.zone_uuid, 'zone_uuid');
  const base = version(payload.base_sync_version, 'base_sync_version');
  const target = version(
    payload.target_sync_version,
    'target_sync_version'
  );
  if (target !== base + 1) {
    throw commandError(
      'malformed_command',
      'target_sync_version must equal base_sync_version + 1'
    );
  }
  const prefix = type === 'DELETE_ZONE' ? 'zone_delete' : 'zone';
  return {
    zoneUuid,
    base,
    target,
    effectKey: prefix + ':' + zoneUuid + ':' + base,
  };
}

function validEffectBinding(envelope, runtime) {
  try {
    const type = typeOf(envelope);
    if (!TYPES.has(type) ||
        !runtime ||
        runtime.command_type_recognized !== true) {
      return false;
    }
    const payload = object(envelope.payload, 'Pending command payload');
    if (!protectedCandidate(payload)) return false;
    const expected = binding(type, payload);
    const supplied = String(
      payload.effect_key || payload.effectKey || envelope.effectKey || ''
    ).trim();
    return supplied === expected.effectKey;
  } catch (_) {
    return false;
  }
}

function validateIdentity(envelope, runtime) {
  const type = typeOf(envelope);
  if (!TYPES.has(type)) return null;
  const payload = object(envelope.payload, 'Pending command payload');
  if (!protectedCandidate(payload)) return null;
  deliveryId(envelope);
  if (payload.command_type !== type ||
      !UUID.test(String(payload.command_id || '').toLowerCase())) {
    throw commandError(
      'malformed_command',
      'Logical command identity or type is invalid'
    );
  }
  const gateway = String(
    runtime && runtime.gateway_device_eui || ''
  ).trim().toUpperCase();
  if (!EUI64.test(gateway)) {
    throw commandError('gateway_mismatch', 'Runtime gateway EUI is invalid');
  }
  const expected = binding(type, payload);
  const suppliedEffect = String(
    payload.effect_key || envelope.effectKey || ''
  ).trim();
  if (suppliedEffect !== expected.effectKey) {
    throw commandError(
      'malformed_command',
      'effect_key does not match zone UUID and base version'
    );
  }
  const outerGateway = String(
    payload.gateway_device_eui || ''
  ).trim().toUpperCase();
  if (outerGateway !== gateway) {
    throw commandError(
      'gateway_mismatch',
      'Command gateway does not match this gateway'
    );
  }
  const zone = object(payload.zone, 'zone');
  if (uuid(zone.zone_uuid, 'zone.zone_uuid') !== expected.zoneUuid) {
    throw commandError(
      'malformed_command',
      'zone UUID does not match command resource'
    );
  }
  if (version(zone.sync_version, 'zone.sync_version') !== expected.target) {
    throw commandError(
      'malformed_command',
      'zone.sync_version must equal target_sync_version'
    );
  }
  return {
    type,
    payload,
    zone,
    gateway,
    zoneUuid: expected.zoneUuid,
    base: expected.base,
    target: expected.target,
    effectKey: expected.effectKey,
  };
}

function normalizedZone(input, type) {
  const zone = object(input, 'zone');
  const result = {
    zoneUuid: uuid(zone.zone_uuid, 'zone.zone_uuid'),
    gatewayDeviceEui: String(
      zone.gateway_device_eui || ''
    ).trim().toUpperCase(),
    syncVersion: version(zone.sync_version, 'zone.sync_version'),
  };
  if (type !== 'DELETE_ZONE') {
    result.name = requiredText(zone.name, 'zone.name', 128);
    result.timezone = requiredText(zone.timezone, 'zone.timezone', 64);
    result.latitude = nullableFinite(
      zone.latitude,
      'zone.latitude',
      -90,
      90,
      false
    );
    result.longitude = nullableFinite(
      zone.longitude,
      'zone.longitude',
      -180,
      180,
      false
    );
    result.phenologicalStage = nullableText(
      zone.phenological_stage,
      'zone.phenological_stage',
      64
    ) || 'default';
    result.calibrationKey = nullableText(
      zone.calibration_key,
      'zone.calibration_key',
      128
    ) || 'default';
    result.cropType = nullableText(zone.crop_type, 'zone.crop_type', 128);
    result.variety = nullableText(zone.variety, 'zone.variety', 128);
    result.soilType = nullableText(zone.soil_type, 'zone.soil_type', 128);
    result.irrigationMethod = nullableText(
      zone.irrigation_method,
      'zone.irrigation_method',
      128
    );
    result.areaM2 = nullableFinite(
      zone.area_m2,
      'zone.area_m2',
      0,
      Number.MAX_VALUE,
      true
    );
    result.irrigationEfficiencyPct = nullableFinite(
      zone.irrigation_efficiency_pct,
      'zone.irrigation_efficiency_pct',
      0,
      100,
      true
    );
    result.schedulingMode = requiredText(
      zone.scheduling_mode,
      'zone.scheduling_mode',
      32
    ).toLowerCase();
    if (!['local', 'server_preferred'].includes(result.schedulingMode)) {
      throw commandError(
        'malformed_command',
        'zone.scheduling_mode is invalid'
      );
    }
    result.predictionCardEnabled = booleanInteger(
      zone.prediction_card_enabled,
      'zone.prediction_card_enabled'
    );
    result.notes = nullableText(zone.notes, 'zone.notes', 4096);
    if (zone.deleted_at != null) {
      throw commandError(
        'malformed_command',
        'zone.deleted_at must be null for an upsert'
      );
    }
  } else {
    result.deletedAt = timestamp(zone.deleted_at, 'zone.deleted_at');
  }
  return result;
}

function assertBase(actual, expected) {
  if (actual !== expected) {
    throw commandError(
      'base_version_conflict',
      'base_sync_version conflict: expected ' + actual
    );
  }
}

async function currentZone(tx, zoneUuid) {
  return tx.get(
    'SELECT * FROM irrigation_zones WHERE zone_uuid=? LIMIT 1',
    [zoneUuid]
  );
}

async function ownerId(tx, user) {
  const resource = object(user, 'zone.user');
  const ownerUuid = uuid(resource.user_uuid, 'zone.user.user_uuid');
  const row = await tx.get(
    'SELECT id FROM users WHERE user_uuid=? AND disabled_at IS NULL LIMIT 1',
    [ownerUuid]
  );
  if (!row) {
    throw commandError('missing_resource', 'Zone owner is not present locally');
  }
  return { id: Number(row.id), uuid: ownerUuid };
}

async function insertZone(tx, command, zone) {
  assertBase(0, command.base);
  const owner = await ownerId(tx, command.zone.user);
  const now = new Date().toISOString();
  await tx.run(
    'INSERT INTO irrigation_zones (' +
      'name,user_id,zone_uuid,gateway_device_eui,timezone,latitude,longitude,' +
      'phenological_stage,calibration_key,crop_type,variety,soil_type,' +
      'irrigation_method,area_m2,irrigation_efficiency_pct,scheduling_mode,' +
      'prediction_card_enabled,notes,sync_version,deleted_at,created_at,updated_at' +
    ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [
      zone.name,
      owner.id,
      zone.zoneUuid,
      command.gateway,
      zone.timezone,
      zone.latitude,
      zone.longitude,
      zone.phenologicalStage,
      zone.calibrationKey,
      zone.cropType,
      zone.variety,
      zone.soilType,
      zone.irrigationMethod,
      zone.areaM2,
      zone.irrigationEfficiencyPct,
      zone.schedulingMode,
      zone.predictionCardEnabled,
      zone.notes,
      command.target,
      null,
      now,
      now,
    ]
  );
}

async function assertExistingOwner(tx, current, command) {
  if (current.deleted_at != null) {
    throw commandError('missing_resource', 'Zone is deleted');
  }
  const owner = await ownerId(tx, command.zone.user);
  if (Number(current.user_id) !== owner.id) {
    throw commandError('owner_mismatch', 'Zone owner cannot be changed');
  }
}

async function updateFullZone(tx, command, current, zone) {
  await assertExistingOwner(tx, current, command);
  await tx.run(
    'UPDATE irrigation_zones SET ' +
      'name=?,timezone=?,latitude=?,longitude=?,phenological_stage=?,' +
      'calibration_key=?,crop_type=?,variety=?,soil_type=?,irrigation_method=?,' +
      'area_m2=?,irrigation_efficiency_pct=?,scheduling_mode=?,' +
      'prediction_card_enabled=?,notes=?,sync_version=?,updated_at=? ' +
      'WHERE zone_uuid=?',
    [
      zone.name,
      zone.timezone,
      zone.latitude,
      zone.longitude,
      zone.phenologicalStage,
      zone.calibrationKey,
      zone.cropType,
      zone.variety,
      zone.soilType,
      zone.irrigationMethod,
      zone.areaM2,
      zone.irrigationEfficiencyPct,
      zone.schedulingMode,
      zone.predictionCardEnabled,
      zone.notes,
      command.target,
      new Date().toISOString(),
      command.zoneUuid,
    ]
  );
}

async function updateConfig(tx, command, current, zone) {
  await assertExistingOwner(tx, current, command);
  const values = {
    timezone: zone.timezone,
    phenological_stage: zone.phenologicalStage,
    calibration_key: zone.calibrationKey,
    crop_type: zone.cropType,
    variety: zone.variety,
    soil_type: zone.soilType,
    irrigation_method: zone.irrigationMethod,
    area_m2: zone.areaM2,
    irrigation_efficiency_pct: zone.irrigationEfficiencyPct,
    scheduling_mode: zone.schedulingMode,
    prediction_card_enabled: zone.predictionCardEnabled,
    notes: zone.notes,
  };
  const assignments = CONFIG_FIELDS.map(function(field) {
    return field + '=?';
  });
  await tx.run(
    'UPDATE irrigation_zones SET ' + assignments.join(',') +
      ',sync_version=?,updated_at=? WHERE zone_uuid=?',
    CONFIG_FIELDS.map(function(field) {
      return values[field];
    }).concat([
      command.target,
      new Date().toISOString(),
      command.zoneUuid,
    ])
  );
}

async function updateLocation(tx, command, current, zone) {
  await assertExistingOwner(tx, current, command);
  await tx.run(
    'UPDATE irrigation_zones SET latitude=?,longitude=?,sync_version=?,updated_at=? ' +
      'WHERE zone_uuid=?',
    [
      zone.latitude,
      zone.longitude,
      command.target,
      new Date().toISOString(),
      command.zoneUuid,
    ]
  );
}

async function deleteZone(tx, command, current, zone) {
  if (current.deleted_at != null) {
    throw commandError('missing_resource', 'Zone is already deleted');
  }
  const now = new Date().toISOString();
  await tx.run(
    'UPDATE devices SET irrigation_zone_id=NULL,updated_at=?,' +
      'sync_version=COALESCE(sync_version,0)+1 ' +
      'WHERE irrigation_zone_id=? AND deleted_at IS NULL',
    [now, Number(current.id)]
  );
  await tx.run(
    'UPDATE irrigation_zones SET deleted_at=?,sync_version=?,updated_at=? ' +
      'WHERE zone_uuid=?',
    [zone.deletedAt, command.target, now, command.zoneUuid]
  );
}

async function applyMutation(tx, command) {
  const zone = normalizedZone(command.zone, command.type);
  if (zone.gatewayDeviceEui !== command.gateway) {
    throw commandError(
      'gateway_mismatch',
      'Zone gateway does not match this gateway'
    );
  }
  const current = await currentZone(tx, command.zoneUuid);
  assertBase(current ? Number(current.sync_version) : 0, command.base);
  if (String(
    current && current.gateway_device_eui || command.gateway
  ).trim().toUpperCase() !== command.gateway) {
    throw commandError(
      'gateway_mismatch',
      'Existing zone belongs to another gateway'
    );
  }
  if (!current) {
    if (command.type !== 'UPSERT_ZONE') {
      throw commandError('missing_resource', 'Zone is not present locally');
    }
    await insertZone(tx, command, zone);
  } else if (command.type === 'UPSERT_ZONE') {
    await updateFullZone(tx, command, current, zone);
  } else if (command.type === 'UPSERT_ZONE_CONFIG') {
    await updateConfig(tx, command, current, zone);
  } else if (command.type === 'UPSERT_ZONE_LOCATION') {
    await updateLocation(tx, command, current, zone);
  } else {
    await deleteZone(tx, command, current, zone);
  }
  return {
    appliedSyncVersion: command.target,
    resourceUuid: command.zoneUuid,
  };
}

function classify(error) {
  if (!error || !error.code) return null;
  if (error.code === 'base_version_conflict') {
    return { result: 'CONFLICT', reason: error.message };
  }
  if ([
    'malformed_command',
    'gateway_mismatch',
    'missing_resource',
    'owner_mismatch',
  ].includes(error.code)) {
    return { result: 'REJECTED_PERMANENT', reason: error.message };
  }
  return null;
}

async function queueAck(tx, ack, appliedAt) {
  await tx.run(
    'DELETE FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
    [String(ack.commandId)]
  );
  await tx.run(
    'INSERT INTO command_ack_outbox(command_id,payload_json,created_at) VALUES (?,?,?)',
    [String(ack.commandId), JSON.stringify(ack), appliedAt]
  );
}

function parsedAck(row) {
  if (!row || !row.result_detail) return null;
  try {
    const value = JSON.parse(row.result_detail);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value
      : null;
  } catch (_) {
    return null;
  }
}

async function replay(tx, row) {
  const stored = parsedAck(row);
  if (!stored) {
    throw commandError(
      'malformed_command',
      'Stored command result is not replayable'
    );
  }
  await queueAck(tx, stored, stored.appliedAt || new Date().toISOString());
  return stored;
}

async function persistTerminal(tx, envelope, command, terminal) {
  const id = deliveryId(envelope);
  const appliedAt = new Date().toISOString();
  const ack = {
    commandId: id,
    commandType: command.type,
    effectKey: command.effectKey,
    status: terminal.result === 'APPLIED' ? 'ACKED' : 'NACKED',
    result: terminal.result,
    appliedSyncVersion: terminal.appliedSyncVersion,
    duplicate: false,
    gatewayDeviceEui: command.gateway,
    appliedAt,
  };
  if (terminal.reason) ack.reason = terminal.reason;
  if (terminal.resourceUuid) ack.resourceUuid = terminal.resourceUuid;
  if (terminal.payloadHash) ack.payloadHash = terminal.payloadHash;
  await tx.run(
    'INSERT INTO applied_commands(' +
      'command_id,device_eui,command_type,effect_key,applied_at,result,' +
      'result_detail,originator' +
    ') VALUES (?,?,?,?,?,?,?,?)',
    [
      String(id),
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

let applyTail = Promise.resolve();

function enqueue(work) {
  const scheduled = applyTail.then(work, work);
  applyTail = scheduled.then(function() {}, function() {});
  return scheduled;
}

async function applyOnce(db, envelope, runtime) {
  envelope = object(envelope, 'Pending command envelope');
  const command = validateIdentity(envelope, runtime);
  if (!command) return { handled: false };
  return db.transaction(async function(tx) {
    const prior = await tx.get(
      'SELECT * FROM applied_commands WHERE command_id=? LIMIT 1',
      [String(deliveryId(envelope))]
    );
    if (prior) {
      return { handled: true, ack: await replay(tx, prior) };
    }
    try {
      const terminal = await applyMutation(tx, command);
      terminal.result = 'APPLIED';
      terminal.payloadHash = canonicalHash(command.payload);
      return {
        handled: true,
        ack: await persistTerminal(tx, envelope, command, terminal),
      };
    } catch (error) {
      const failure = classify(error);
      if (!failure) throw error;
      const current = await currentZone(tx, command.zoneUuid);
      failure.appliedSyncVersion = current
        ? Number(current.sync_version)
        : 0;
      failure.resourceUuid = command.zoneUuid;
      failure.payloadHash = canonicalHash(command.payload);
      return {
        handled: true,
        ack: await persistTerminal(tx, envelope, command, failure),
      };
    }
  });
}

function applyZoneCommand(db, envelope, runtime) {
  return enqueue(function() {
    return applyOnce(db, envelope, runtime);
  });
}

module.exports = {
  TYPES,
  applyZoneCommand,
  validEffectBinding,
  intentHash: canonicalHash,
  _resetForTests: function() {
    applyTail = Promise.resolve();
  },
};
