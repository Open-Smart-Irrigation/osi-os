'use strict';

const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EUI64 = /^[0-9A-F]{16}$/;
const TYPE = 'UPSERT_ZONE_CONFIG';
// Terra-originated replays reuse this grammar (see docs/contracts/sync-schema/effect-keys.md
// conventions): terra-selection:<zoneUuid>:<baseSyncVersion>:<targetSyncVersion>. Binding the
// embedded zone/base/target back to the command under validation before trusting a match keeps a
// spoofed or stale effect key from replaying an unrelated result.
const TERRA_EFFECT_KEY =
  /^terra-selection:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(0|[1-9]\d*):(0|[1-9]\d*)$/;

const entityName = require('../osi-entity-name');
// osi-crop-kc normalizeStage: the five FAO keys and the nine legacy keys; anything else is unset.
const { normalizeStage } = require('../osi-crop-kc');

// Today in the zone's timezone as YYYY-MM-DD; UTC for a missing or unknown zone id, as
// osi-agronomy-daily reads it (formatToParts: the Node build has English locale data only).
function zoneLocalToday(timezone) {
  let fmt;
  try {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: String(timezone || 'UTC'), year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch (tzError) {
    fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  const parts = {};
  for (const part of fmt.formatToParts(new Date())) parts[part.type] = part.value;
  return parts.year + '-' + parts.month + '-' + parts.day;
}

// The Terra shape never carries a start date (its field list is exact); a full
// UPSERT_ZONE command from a cloud that has not yet reported stage_started_on
// support for this gateway omits the key and falls into the same case
// (final review E-I2). Both paths apply this rule: a change to unset clears
// the date, a change to another set stage starts it on the zone-local today,
// the same stage keeps it (spec 2026-09-27-daily-agronomy-parity B5;
// controller rulings cloud/sync I7 and plan review E2 I2).
function ruleStageStartedOn(current, nextStage) {
  const next = normalizeStage(nextStage);
  const stored = normalizeStage(current.phenological_stage);
  const kept = current.stage_started_on == null ? null : current.stage_started_on;
  if (!next) return stored ? null : kept;
  return next === stored ? kept : zoneLocalToday(current.timezone);
}

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

function own(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function text(value, field, maxLength) {
  if (typeof value !== 'string' || !value.trim()) {
    throw commandError('malformed_command', field + ' is required');
  }
  const normalized = value.trim();
  if (maxLength && normalized.length > maxLength) {
    throw commandError('malformed_command', field + ' is too long');
  }
  return normalized;
}

function uuid(value, field) {
  const normalized = text(value, field, 36).toLowerCase();
  if (!UUID.test(normalized)) {
    throw commandError('malformed_command', field + ' must be a canonical UUID');
  }
  return normalized;
}

// ownerUserUuid is the zone owner's gateway-local users.user_uuid as stored.
// The first admin and backfilled users hold 32 lower-case hex digits; that form
// is accepted and compared unchanged.
const LOCAL_HEX_USER_UUID = /^[0-9a-f]{32}$/;

function ownerUuid(value, field) {
  if (typeof value === 'string' && LOCAL_HEX_USER_UUID.test(value)) return value;
  return uuid(value, field);
}

function eui(value, field) {
  const normalized = text(value, field, 16).toUpperCase();
  if (!EUI64.test(normalized)) {
    throw commandError('gateway_mismatch', field + ' must be a canonical EUI64');
  }
  return normalized;
}

function version(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw commandError('malformed_command', field + ' must be a non-negative safe integer');
  }
  return value;
}

function hash(value) {
  function canonical(item) {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') {
      return Object.keys(item).sort().reduce(function(result, key) {
        result[key] = canonical(item[key]);
        return result;
      }, {});
    }
    return item;
  }
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonical(value)))
    .digest('hex');
}

function validate(envelope, runtime) {
  envelope = object(envelope, 'Pending command envelope');
  const commandType = text(envelope.commandType, 'commandType', 64).toUpperCase();
  if (commandType !== TYPE) return null;
  if (!Number.isSafeInteger(envelope.commandId) || envelope.commandId <= 0) {
    throw commandError('malformed_command', 'commandId must be a positive safe integer');
  }
  if (!runtime || runtime.command_type_recognized !== true) {
    throw commandError('malformed_command', 'command type is not registry-recognized');
  }

  const payload = object(envelope.payload, 'payload');
  const fields = [
    'commandType', 'zoneUuid', 'gatewayDeviceEui', 'ownerUserUuid',
    'baseSyncVersion', 'syncVersion', 'cropType', 'variety',
    'phenologicalStage', 'terraConfigurationOperation',
  ];
  const allowed = new Set(fields);
  const missing = fields.filter(function(field) { return !own(payload, field); });
  const extra = Object.keys(payload).filter(function(field) { return !allowed.has(field); });
  if (missing.length || extra.length) {
    throw commandError(
      'malformed_command',
      'payload shape mismatch; missing=' + (missing.join(',') || 'none') +
        ', extra=' + (extra.join(',') || 'none')
    );
  }
  // Terra is the only originator of this command shape (osi-server #68); the marker must be
  // present (enforced by `fields` above) and exactly boolean true, never a truthy stand-in.
  if (payload.terraConfigurationOperation !== true) {
    throw commandError(
      'malformed_command',
      'payload.terraConfigurationOperation must be true'
    );
  }
  if (text(payload.commandType, 'payload.commandType', 64).toUpperCase() !== TYPE) {
    throw commandError('malformed_command', 'payload command type mismatch');
  }

  const zoneUuid = uuid(payload.zoneUuid, 'payload.zoneUuid');
  const aggregateType = text(envelope.aggregateType, 'aggregateType', 64).toUpperCase();
  const aggregateKey = uuid(envelope.aggregateKey, 'aggregateKey');
  if (aggregateType !== 'ZONE' || aggregateKey !== zoneUuid) {
    throw commandError('malformed_command', 'zone aggregate binding is invalid');
  }
  const runtimeGateway = eui(runtime.gateway_device_eui, 'runtime gateway EUI');
  const payloadGateway = eui(payload.gatewayDeviceEui, 'payload.gatewayDeviceEui');

  const base = version(payload.baseSyncVersion, 'payload.baseSyncVersion');
  const target = version(payload.syncVersion, 'payload.syncVersion');
  const outerTarget = version(envelope.appliedSyncVersion, 'appliedSyncVersion');
  if (target !== outerTarget) {
    throw commandError('malformed_command', 'outer and payload target versions differ');
  }
  if (target <= base) {
    throw commandError('malformed_command', 'target version must be greater than base');
  }
  const effectKey = envelope.effectKey == null
    ? null
    : text(envelope.effectKey, 'effectKey', 255);

  const cropType = text(payload.cropType, 'payload.cropType', 128);
  const variety = payload.variety === null
    ? null
    : text(payload.variety, 'payload.variety', 128);
  return {
    id: envelope.commandId,
    eventUuid: uuid(envelope.eventUuid, 'eventUuid'),
    commandType,
    aggregateType,
    aggregateKey,
    zoneUuid,
    gateway: runtimeGateway,
    payloadGateway,
    ownerUserUuid: ownerUuid(payload.ownerUserUuid, 'payload.ownerUserUuid'),
    base,
    target,
    effectKey,
    cropType,
    variety,
    phenologicalStage: text(
      payload.phenologicalStage,
      'payload.phenologicalStage',
      128
    ),
    payload,
  };
}

async function currentZone(tx, zoneUuid) {
  return tx.get(
    'SELECT z.*,u.user_uuid AS owner_user_uuid ' +
      'FROM irrigation_zones z JOIN users u ON u.id=z.user_id ' +
      'WHERE z.zone_uuid=? LIMIT 1',
    [zoneUuid]
  );
}

function buildAck(command, terminal, appliedAt) {
  const value = {
    commandId: command.id,
    eventUuid: command.eventUuid,
    commandType: command.commandType,
    aggregateType: command.aggregateType,
    aggregateKey: command.aggregateKey,
    effectKey: command.effectKey,
    status: terminal.result === 'APPLIED' ? 'ACKED' : 'NACKED',
    result: terminal.result,
    appliedSyncVersion: terminal.appliedSyncVersion,
    duplicate: false,
    gatewayDeviceEui: command.gateway,
    appliedAt,
    resourceUuid: command.zoneUuid,
    payloadHash: terminal.result === 'APPLIED' ? terminal.payloadHash : null,
  };
  if (terminal.reason) value.reason = terminal.reason;
  if (terminal.reasonCode) value.reasonCode = terminal.reasonCode;
  return value;
}

async function appliedAggregateHash(tx, command) {
  const row = await tx.get(
    "SELECT payload_json FROM sync_outbox WHERE aggregate_type='ZONE' " +
      'AND aggregate_key=? AND sync_version=? ORDER BY rowid DESC LIMIT 1',
    [command.zoneUuid, command.target]
  );
  if (!row || typeof row.payload_json !== 'string') {
    throw commandError(
      'missing_sync_event',
      'applied zone mutation did not emit its canonical sync event'
    );
  }
  let payload;
  try {
    payload = JSON.parse(row.payload_json);
  } catch (cause) {
    const error = commandError(
      'invalid_sync_event',
      'applied zone mutation emitted invalid canonical JSON'
    );
    error.cause = cause;
    throw error;
  }
  return hash(object(payload, 'Canonical zone aggregate'));
}

async function queueAck(tx, value, createdAt) {
  await tx.run(
    'DELETE FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
    [String(value.commandId)]
  );
  await tx.run(
    'INSERT INTO command_ack_outbox(command_id,payload_json,created_at) VALUES (?,?,?)',
    [String(value.commandId), JSON.stringify(value), createdAt]
  );
}

function replayFacts(row) {
  let stored;
  try {
    stored = JSON.parse(row.result_detail);
  } catch (error) {
    throw commandError(
      'invalid_replay',
      'stored result is not valid JSON: ' +
        (error && error.message ? error.message : error)
    );
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw commandError('invalid_replay', 'stored result is not replayable');
  }
  return stored;
}

async function replay(tx, row) {
  const stored = replayFacts(row);
  await queueAck(tx, stored, stored.appliedAt || new Date().toISOString());
  return stored;
}

// Replays a terminal result found under a different delivery command_id (matched by Terra
// effect key, not by command_id). Follows the same shape osi-command-ledger's replayAck uses for
// a non-exact-delivery match: the new delivery id replaces the stored one and `duplicate` is set,
// while the rest of the terminal facts (result, appliedSyncVersion, payloadHash, resourceUuid,
// aggregate identity) carry over unchanged so the cloud sees the original outcome, not a
// reclassification.
async function replayForEffectKey(tx, row, command) {
  const stored = replayFacts(row);
  const value = Object.assign({}, stored, {
    commandId: command.id,
    effectKey: stored.effectKey == null ? row.effect_key : stored.effectKey,
    appliedAt: stored.appliedAt || row.applied_at,
    duplicate: true,
  });
  await queueAck(tx, value, new Date().toISOString());
  return value;
}

function terraEffectBindingMatches(command) {
  if (!command.effectKey) return false;
  const match = TERRA_EFFECT_KEY.exec(command.effectKey);
  if (!match) return false;
  return match[1] === command.zoneUuid &&
    Number(match[2]) === command.base &&
    Number(match[3]) === command.target;
}

async function persist(tx, command, terminal) {
  const appliedAt = new Date().toISOString();
  const value = buildAck(command, terminal, appliedAt);
  await tx.run(
    'INSERT INTO applied_commands(' +
      'command_id,device_eui,command_type,effect_key,applied_at,result,' +
      'result_detail,originator) VALUES (?,?,?,?,?,?,?,?)',
    [
      String(command.id), command.gateway, command.commandType,
      command.effectKey, appliedAt, terminal.result,
      JSON.stringify(value), 'cloud',
    ]
  );
  await queueAck(tx, value, appliedAt);
  return value;
}

function nack(code, reason, appliedSyncVersion) {
  return {
    result: 'NACKED',
    reasonCode: code,
    reason,
    appliedSyncVersion,
  };
}

async function applyOnce(db, envelope, runtime) {
  const command = validate(envelope, runtime);
  if (!command) return { handled: false };
  return db.transaction(async function(tx) {
    const prior = await tx.get(
      'SELECT * FROM applied_commands WHERE command_id=? LIMIT 1',
      [String(command.id)]
    );
    if (prior) return { handled: true, ack: await replay(tx, prior) };

    // Bind and deduplicate on the Terra effect key before classifying a version conflict: the
    // cloud can recreate the same logical mutation under a new delivery command_id while
    // preserving effectKey, and that re-delivery must replay the original terminal result rather
    // than fall through to base_version_conflict against the (by-then-advanced) current version.
    if (terraEffectBindingMatches(command)) {
      // Only a successful apply may be replayed. Every NACK path also persists a row
      // under this effect key, so replaying the newest-or-oldest terminal row regardless
      // of result would let a transient NACK -- a missing_resource recorded before the
      // zone existed locally -- be replayed for every later retry, permanently blocking
      // the mutation it was meant to protect.
      const effectRow = await tx.get(
        "SELECT * FROM applied_commands WHERE effect_key=? AND command_type=? " +
          "AND result='APPLIED' ORDER BY applied_at,command_id LIMIT 1",
        [command.effectKey, command.commandType]
      );
      if (effectRow) {
        return { handled: true, ack: await replayForEffectKey(tx, effectRow, command) };
      }
    }

    const current = await currentZone(tx, command.zoneUuid);
    if (!current) {
      return {
        handled: true,
        ack: await persist(tx, command, nack(
          'missing_resource', 'zone is not present locally', 0
        )),
      };
    }
    const currentVersion = Number(current.sync_version);
    if (command.payloadGateway !== command.gateway) {
      return {
        handled: true,
        ack: await persist(tx, command, nack(
          'gateway_mismatch', 'command gateway differs from runtime', currentVersion
        )),
      };
    }
    if (String(current.gateway_device_eui || '').trim().toUpperCase() !== command.gateway) {
      return {
        handled: true,
        ack: await persist(tx, command, nack(
          'gateway_mismatch', 'zone belongs to another gateway', currentVersion
        )),
      };
    }
    if (String(current.owner_user_uuid || '').trim().toLowerCase() !== command.ownerUserUuid) {
      return {
        handled: true,
        ack: await persist(tx, command, nack(
          'owner_mismatch', 'zone belongs to another owner', currentVersion
        )),
      };
    }
    if (current.deleted_at != null) {
      return {
        handled: true,
        ack: await persist(tx, command, nack(
          'missing_resource', 'zone is deleted', currentVersion
        )),
      };
    }
    if (currentVersion !== command.base) {
      return {
        handled: true,
        ack: await persist(tx, command, nack(
          'base_version_conflict',
          'base version ' + command.base +
            ' does not match current version ' + currentVersion,
          currentVersion
        )),
      };
    }

    await tx.run(
      'UPDATE irrigation_zones SET ' +
        'crop_type=?,variety=?,phenological_stage=?,stage_started_on=?,sync_version=?,updated_at=? ' +
        'WHERE zone_uuid=?',
      [
        command.cropType, command.variety, command.phenologicalStage,
        ruleStageStartedOn(current, command.phenologicalStage),
        command.target, new Date().toISOString(), command.zoneUuid,
      ]
    );
    return {
      handled: true,
      ack: await persist(tx, command, {
        result: 'APPLIED',
        appliedSyncVersion: command.target,
        payloadHash: await appliedAggregateHash(tx, command),
      }),
    };
  });
}

// =============================================================================
// Versioned UPSERT_ZONE / DELETE_ZONE / UPSERT_ZONE_LOCATION command path
// (AgroLink 9016d220 + 568d7f52). UPSERT_ZONE_CONFIG is intentionally
// excluded from TYPES/applyMutation here: that command type is already owned
// end-to-end by the Terra-originated `validate`/`applyOnce` path above (its
// own effect-key grammar, payload shape, and rehearsal suite predate this
// port and stay untouched). Helper names that would otherwise collide with
// the Terra path above are suffixed `2` (uuid2, UUID2, version2,
// currentZone2, applyOnce2, replay2); `commandError`, `object`, and
// `queueAck` are byte-identical between both origins and are reused as
// declared above instead of being redefined.
// =============================================================================

const UUID2 =
  /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TYPES = new Set([
  'UPSERT_ZONE',
  'DELETE_ZONE',
  'UPSERT_ZONE_LOCATION',
]);

function exactObject(value, field, required, optional) {
  const resource = object(value, field);
  const allowed = new Set(required.concat(optional || []));
  const missing = required.filter(function(key) {
    return !Object.prototype.hasOwnProperty.call(resource, key);
  });
  const extra = Object.keys(resource).filter(function(key) {
    return !allowed.has(key);
  });
  if (missing.length || extra.length) {
    throw commandError(
      'malformed_command',
      field + ' shape mismatch; missing=' +
        (missing.join(',') || 'none') + ', extra=' +
        (extra.join(',') || 'none')
    );
  }
  return resource;
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

function uuid2(value, field) {
  const normalized = requiredText(value, field).toLowerCase();
  if (!UUID2.test(normalized)) {
    throw commandError(
      'malformed_command',
      field + ' must be a contract UUID'
    );
  }
  return normalized;
}

function version2(value, field) {
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
  const zoneUuid = uuid2(payload.zone_uuid, 'zone_uuid');
  const base = version2(payload.base_sync_version, 'base_sync_version');
  const target = version2(
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
  exactObject(
    payload,
    'Pending command payload',
    [
      'command_id',
      'command_type',
      'effect_key',
      'zone_uuid',
      'gateway_device_eui',
      'base_sync_version',
      'target_sync_version',
      'zone',
    ]
  );
  deliveryId(envelope);
  if (payload.command_type !== type ||
      !UUID2.test(String(payload.command_id || '').toLowerCase())) {
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
  if (uuid2(zone.zone_uuid, 'zone.zone_uuid') !== expected.zoneUuid) {
    throw commandError(
      'malformed_command',
      'zone UUID does not match command resource'
    );
  }
  if (version2(zone.sync_version, 'zone.sync_version') !== expected.target) {
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
  const common = [
    'contract_version',
    'zone_uuid',
    'gateway_device_eui',
    'sync_version',
    'deleted_at',
  ];
  const portable = [
    'name',
    'timezone',
    'latitude',
    'longitude',
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
    'user',
  ];
  // weather_source is optional: a cloud that has not adopted the field sends
  // the full zone object without it (spec 2026-09-27-weather-data-view-design).
  const zone = exactObject(
    input,
    'zone',
    type === 'DELETE_ZONE' ? common : common.concat(portable),
    type === 'DELETE_ZONE' ? [] :
      // stage_started_on is optional on the full zone command only (spec
      // 2026-09-27-daily-agronomy-parity B5); a location command never carries it.
      type === 'UPSERT_ZONE' ? ['weather_source', 'stage_started_on'] : ['weather_source']
  );
  if (zone.contract_version !== 1) {
    throw commandError(
      'malformed_command',
      'zone.contract_version must equal 1'
    );
  }
  const result = {
    zoneUuid: uuid2(zone.zone_uuid, 'zone.zone_uuid'),
    gatewayDeviceEui: String(
      zone.gateway_device_eui || ''
    ).trim().toUpperCase(),
    syncVersion: version2(zone.sync_version, 'zone.sync_version'),
  };
  if (type !== 'DELETE_ZONE') {
    if (type === 'UPSERT_ZONE') {
      // One name rule for create and for rename, on both sides (decision D4).
      // classify() turns malformed_command into a REJECTED_PERMANENT ack, so a
      // bad name ends as a visible rejection and never as a silent truncation.
      try {
        result.name = entityName.normalizeEntityName(zone.name);
      } catch (error) {
        if (!error || !error.code) throw error;
        throw commandError('malformed_command', 'zone.name is invalid: ' + error.code);
      }
    } else {
      // UPSERT_ZONE_LOCATION never writes the name (updateLocation touches
      // only latitude/longitude/sync_version/updated_at), but exactObject
      // still requires the key, so every location command carries the
      // zone's current name. A legacy row whose stored name is over the
      // shared rule's 100-code-point limit but within the old 128-character
      // bound must keep receiving location updates until it is next saved
      // as a rename (spec: legacy rows "stay as they are, keep syncing, and
      // must satisfy the rule the next time someone saves the name").
      result.name = requiredText(zone.name, 'zone.name', 128);
    }
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
    // null or empty means absent: updateFullZone then keeps the stored value.
    result.weatherSource = null;
    if (zone.weather_source != null) {
      const weatherSource = String(zone.weather_source).trim().toLowerCase();
      if (weatherSource && !/^[a-z_]{1,20}$/.test(weatherSource)) {
        throw commandError(
          'malformed_command',
          'zone.weather_source must be 1 to 20 lower-case letters or underscores'
        );
      }
      result.weatherSource = weatherSource || null;
    }
    // Absent: updateFullZone keeps the stored date. null or '' (after trim):
    // clears, same as the zone route and the two legacy paths -- the cloud
    // never sends '' here, but the meaning is the same one it does send.
    // Otherwise a calendar date YYYY-MM-DD, else malformed_command
    // (REJECTED_PERMANENT).
    result.hasStageStartedOn = Object.prototype.hasOwnProperty.call(zone, 'stage_started_on');
    result.stageStartedOn = null;
    if (result.hasStageStartedOn && zone.stage_started_on !== null) {
      const startedOn = String(zone.stage_started_on).trim();
      if (startedOn !== '') {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startedOn);
        if (!m || new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toISOString().slice(0, 10) !== startedOn) {
          throw commandError(
            'malformed_command',
            'zone.stage_started_on must be YYYY-MM-DD or null'
          );
        }
        result.stageStartedOn = startedOn;
      }
    }
    const user = exactObject(
      zone.user,
      'zone.user',
      ['user_uuid'],
      ['username', 'cloudUserId']
    );
    result.ownerUserUuid = uuid2(
      user.user_uuid,
      'zone.user.user_uuid'
    );
    nullableText(user.username, 'zone.user.username', 64);
    if (user.cloudUserId != null &&
        (!Number.isSafeInteger(user.cloudUserId) ||
         user.cloudUserId <= 0)) {
      throw commandError(
        'malformed_command',
        'zone.user.cloudUserId must be a positive integer or null'
      );
    }
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

async function currentZone2(tx, zoneUuid) {
  return tx.get(
    'SELECT * FROM irrigation_zones WHERE zone_uuid=? LIMIT 1',
    [zoneUuid]
  );
}

async function ownerId(tx, ownerUuid) {
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
  const owner = await ownerId(tx, zone.ownerUserUuid);
  const now = new Date().toISOString();
  await tx.run(
    'INSERT INTO irrigation_zones (' +
      'name,user_id,zone_uuid,gateway_device_eui,timezone,latitude,longitude,' +
      'phenological_stage,calibration_key,crop_type,variety,soil_type,' +
      'irrigation_method,area_m2,irrigation_efficiency_pct,scheduling_mode,' +
      'prediction_card_enabled,notes,sync_version,deleted_at,created_at,updated_at,' +
      'weather_source,stage_started_on' +
    ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
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
      zone.weatherSource || 'auto',
      zone.stageStartedOn,
    ]
  );
}

async function assertExistingOwner(tx, current, zone) {
  if (current.deleted_at != null) {
    throw commandError('missing_resource', 'Zone is deleted');
  }
  const owner = await ownerId(tx, zone.ownerUserUuid);
  if (Number(current.user_id) !== owner.id) {
    throw commandError('owner_mismatch', 'Zone owner cannot be changed');
  }
}

async function updateFullZone(tx, command, current, zone) {
  await assertExistingOwner(tx, current, zone);
  // A command without weather_source keeps the stored provider.
  const weatherSource = zone.weatherSource === null ? [] : [zone.weatherSource];
  // stage_started_on (final review E-I2): a command that omits the key applies
  // the stage-date rule from the stored stage instead of leaving a stale date
  // behind (the cloud omits the key until it learns this gateway supports it).
  // A command that carries the key keeps its sent value, with one override: a
  // change from a set stage to unset always clears the date, whatever value
  // the command sent -- the same rule the Terra path and the legacy node apply
  // (docs/contracts/sync-schema/README.md, "Zone stage_started_on").
  const storedStage = normalizeStage(current.phenological_stage);
  const nextStage = normalizeStage(zone.phenologicalStage);
  const clearedToUnset = Boolean(storedStage) && !nextStage;
  let stageStartedOn;
  if (clearedToUnset) {
    stageStartedOn = current.stage_started_on == null ? [] : [null];
  } else if (zone.hasStageStartedOn) {
    stageStartedOn = [zone.stageStartedOn];
  } else {
    const ruled = ruleStageStartedOn(current, zone.phenologicalStage);
    stageStartedOn = ruled === current.stage_started_on ? [] : [ruled];
  }
  await tx.run(
    'UPDATE irrigation_zones SET ' +
      'name=?,timezone=?,latitude=?,longitude=?,phenological_stage=?,' +
      'calibration_key=?,crop_type=?,variety=?,soil_type=?,irrigation_method=?,' +
      'area_m2=?,irrigation_efficiency_pct=?,scheduling_mode=?,' +
      'prediction_card_enabled=?,notes=?,' +
      (weatherSource.length ? 'weather_source=?,' : '') +
      (stageStartedOn.length ? 'stage_started_on=?,' : '') +
      'sync_version=?,updated_at=? ' +
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
      ...weatherSource,
      ...stageStartedOn,
      command.target,
      new Date().toISOString(),
      command.zoneUuid,
    ]
  );
}

async function updateLocation(tx, command, current, zone) {
  await assertExistingOwner(tx, current, zone);
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
  const current = await currentZone2(tx, command.zoneUuid);
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

async function replay2(tx, row) {
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

async function applyOnce2(db, envelope, runtime) {
  envelope = object(envelope, 'Pending command envelope');
  const command = validateIdentity(envelope, runtime);
  if (!command) return { handled: false };
  return db.transaction(async function(tx) {
    const prior = await tx.get(
      'SELECT * FROM applied_commands WHERE command_id=? LIMIT 1',
      [String(deliveryId(envelope))]
    );
    if (prior) {
      return { handled: true, ack: await replay2(tx, prior) };
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
      const current = await currentZone2(tx, command.zoneUuid);
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

// ---------------------------------------------------------------------------
// Unified entry point: try the Terra UPSERT_ZONE_CONFIG path first (cheap
// no-op for any other command type -- `validate()` returns null before any
// transaction opens), then the versioned zone/delete/location path. Both
// families share one serialization queue since they mutate the same
// irrigation_zones/applied_commands tables and must not race each other.
// ---------------------------------------------------------------------------
async function applyEither(db, envelope, runtime) {
  const terra = await applyOnce(db, envelope, runtime);
  if (terra.handled) return terra;
  return applyOnce2(db, envelope, runtime);
}

let tail = Promise.resolve();

function applyZoneCommand(db, envelope, runtime) {
  const scheduled = tail.then(
    function() { return applyEither(db, envelope, runtime); },
    function() { return applyEither(db, envelope, runtime); }
  );
  tail = scheduled.then(function() {}, function() {});
  return scheduled;
}

module.exports = {
  TYPES,
  applyZoneCommand,
  validEffectBinding,
  intentHash: canonicalHash,
  _resetForTests: function() {
    tail = Promise.resolve();
  },
};
