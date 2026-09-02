'use strict';

const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EUI64 = /^[0-9A-F]{16}$/;
const TYPE = 'UPSERT_ZONE_CONFIG';

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
    ownerUserUuid: uuid(payload.ownerUserUuid, 'payload.ownerUserUuid'),
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

async function replay(tx, row) {
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
  await queueAck(tx, stored, stored.appliedAt || new Date().toISOString());
  return stored;
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
        'crop_type=?,variety=?,phenological_stage=?,sync_version=?,updated_at=? ' +
        'WHERE zone_uuid=?',
      [
        command.cropType, command.variety, command.phenologicalStage,
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

let tail = Promise.resolve();

function applyZoneCommand(db, envelope, runtime) {
  const scheduled = tail.then(
    function() { return applyOnce(db, envelope, runtime); },
    function() { return applyOnce(db, envelope, runtime); }
  );
  tail = scheduled.then(function() {}, function() {});
  return scheduled;
}

module.exports = {
  applyZoneCommand,
  _resetForTests: function() {
    tail = Promise.resolve();
  },
};
