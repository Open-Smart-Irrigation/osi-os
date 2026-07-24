'use strict';

const crypto = require('node:crypto');

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EUI64 = /^[0-9A-F]{16}$/;
const TYPES = new Set([
  'UPSERT_SCHEDULE',
  'UPSERT_ZONE_IRRIGATION_CALIBRATION',
]);
const METRICS = new Set([
  'SWT_WM1',
  'SWT_WM2',
  'SWT_AVG',
  'SWT_1',
  'SWT_2',
  'SWT_3',
  'DENDRO',
]);
const RESPONSE_MODES = new Set(['proportional', 'fixed', 'aggressive']);

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

function uuid(value, field) {
  const text = requiredText(value, field).toLowerCase();
  if (!UUID.test(text)) {
    throw commandError('malformed_command', `${field} must be a canonical UUID`);
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

function timestamp(value, field, nullable) {
  if (nullable && value == null) return null;
  const text = requiredText(value, field, 64);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) {
    throw commandError(
      'malformed_command',
      `${field} must be a canonical ISO timestamp`
    );
  }
  return text;
}

function finite(value, field, minExclusive, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) ||
      value <= minExclusive || value > max) {
    throw commandError(
      'malformed_command',
      `${field} is outside its finite range`
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

function typeOf(command) {
  return String(
    command && (command.command_type || command.commandType) || ''
  ).trim().toUpperCase();
}

function protectedShape(command) {
  return command && (
    command.effect_key != null ||
    command.effectKey != null ||
    command.base_sync_version != null ||
    command.baseSyncVersion != null ||
    command.payload && (
      command.payload.effect_key != null ||
      command.payload.effectKey != null ||
      command.payload.base_sync_version != null ||
      command.payload.baseSyncVersion != null
    )
  );
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

function validateEnvelope(envelope, runtime, type, resourceKey, prefix) {
  const payload = exactObject(
    envelope.payload,
    'Pending command payload',
    [
      'command_id',
      'command_type',
      'effect_key',
      'zone_uuid',
      'gateway_device_eui',
      'base_sync_version',
      'target_sync_version',
      resourceKey,
    ]
  );
  deliveryId(envelope);
  uuid(payload.command_id, 'command_id');
  if (payload.command_type !== type) {
    throw commandError('malformed_command', 'command_type must be canonical');
  }
  const zoneUuid = uuid(payload.zone_uuid, 'zone_uuid');
  const gateway = String(
    runtime && runtime.gateway_device_eui || ''
  ).trim().toUpperCase();
  if (!EUI64.test(gateway)) {
    throw commandError('gateway_mismatch', 'Runtime gateway EUI is invalid');
  }
  if (String(payload.gateway_device_eui || '').trim().toUpperCase() !== gateway) {
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
  const effectKey = `${prefix}:${zoneUuid}:${base}`;
  if (String(payload.effect_key || '').trim() !== effectKey) {
    throw commandError(
      'malformed_command',
      'effect_key does not match zone UUID and base version'
    );
  }
  const resource = object(payload[resourceKey], resourceKey);
  if (uuid(resource.zone_uuid, `${resourceKey}.zone_uuid`) !== zoneUuid ||
      String(resource.gateway_device_eui || '').trim().toUpperCase() !== gateway ||
      version(resource.sync_version, `${resourceKey}.sync_version`) !== target) {
    throw commandError(
      'malformed_command',
      `${resourceKey} identity does not match the protected envelope`
    );
  }
  return {
    type,
    payload,
    resource,
    zoneUuid,
    gateway,
    base,
    target,
    effectKey,
  };
}

function scheduleCommand(envelope, runtime) {
  const command = validateEnvelope(
    envelope,
    runtime,
    'UPSERT_SCHEDULE',
    'schedule',
    'schedule'
  );
  const schedule = exactObject(command.resource, 'schedule', [
    'contract_version',
    'zone_uuid',
    'gateway_device_eui',
    'trigger_metric',
    'threshold_kpa',
    'enabled',
    'duration_minutes',
    'response_mode',
    'sync_version',
    'deleted_at',
    'last_applied_at',
  ]);
  if (schedule.contract_version !== 1) {
    throw commandError(
      'malformed_command',
      'schedule.contract_version must equal 1'
    );
  }
  const metric = requiredText(
    schedule.trigger_metric,
    'schedule.trigger_metric'
  ).toUpperCase();
  if (!METRICS.has(metric)) {
    throw commandError('malformed_command', 'schedule.trigger_metric is invalid');
  }
  const threshold = finite(
    schedule.threshold_kpa,
    'schedule.threshold_kpa',
    0,
    300
  );
  if (metric === 'DENDRO' &&
      (!Number.isInteger(threshold) || ![1, 2, 3, 4].includes(threshold))) {
    throw commandError(
      'malformed_command',
      'schedule DENDRO threshold must be an encoded level from 1 to 4'
    );
  }
  if (![0, 1].includes(schedule.enabled)) {
    throw commandError('malformed_command', 'schedule.enabled must be 0 or 1');
  }
  if (!Number.isSafeInteger(schedule.duration_minutes) ||
      schedule.duration_minutes < 1 ||
      schedule.duration_minutes > 240) {
    throw commandError(
      'malformed_command',
      'schedule.duration_minutes must be from 1 to 240'
    );
  }
  const responseMode = requiredText(
    schedule.response_mode,
    'schedule.response_mode'
  ).toLowerCase();
  if (!RESPONSE_MODES.has(responseMode)) {
    throw commandError('malformed_command', 'schedule.response_mode is invalid');
  }
  command.normalized = {
    metric,
    threshold,
    enabled: schedule.enabled,
    durationMinutes: schedule.duration_minutes,
    responseMode,
    deletedAt: timestamp(schedule.deleted_at, 'schedule.deleted_at', true),
  };
  timestamp(schedule.last_applied_at, 'schedule.last_applied_at', true);
  return command;
}

function calibrationCommand(envelope, runtime) {
  const command = validateEnvelope(
    envelope,
    runtime,
    'UPSERT_ZONE_IRRIGATION_CALIBRATION',
    'irrigation_calibration',
    'irrigation_calibration'
  );
  const calibration = exactObject(
    command.resource,
    'irrigation_calibration',
    [
      'contract_version',
      'zone_uuid',
      'gateway_device_eui',
      'measured_flow_rate_lpm',
      'measurement_method',
      'measured_at',
      'sync_version',
      'deleted_at',
      'last_applied_at',
    ]
  );
  if (calibration.contract_version !== 1) {
    throw commandError(
      'malformed_command',
      'irrigation_calibration.contract_version must equal 1'
    );
  }
  command.normalized = {
    measuredFlowRateLpm: finite(
      calibration.measured_flow_rate_lpm,
      'irrigation_calibration.measured_flow_rate_lpm',
      0,
      Number.MAX_VALUE
    ),
    measurementMethod: requiredText(
      calibration.measurement_method,
      'irrigation_calibration.measurement_method',
      200
    ),
    measuredAt: timestamp(
      calibration.measured_at,
      'irrigation_calibration.measured_at',
      false
    ),
    deletedAt: timestamp(
      calibration.deleted_at,
      'irrigation_calibration.deleted_at',
      true
    ),
  };
  timestamp(
    calibration.last_applied_at,
    'irrigation_calibration.last_applied_at',
    true
  );
  return command;
}

async function currentResource(tx, command, zoneId) {
  if (command.type === 'UPSERT_SCHEDULE') {
    return tx.get(
      'SELECT * FROM irrigation_schedules WHERE irrigation_zone_id=? LIMIT 1',
      [zoneId]
    );
  }
  return tx.get(
    'SELECT * FROM zone_irrigation_calibration WHERE zone_id=? LIMIT 1',
    [zoneId]
  );
}

async function zoneIdentity(tx, command) {
  const zone = await tx.get(
    'SELECT id,gateway_device_eui FROM irrigation_zones ' +
      'WHERE zone_uuid=? AND deleted_at IS NULL LIMIT 1',
    [command.zoneUuid]
  );
  if (!zone) {
    throw commandError('missing_resource', 'Zone is not present locally');
  }
  if (String(zone.gateway_device_eui || '').trim().toUpperCase() !==
      command.gateway) {
    throw commandError(
      'gateway_mismatch',
      'Existing zone belongs to another gateway'
    );
  }
  return Number(zone.id);
}

function assertBase(current, command) {
  const actual = current ? Number(current.sync_version || 0) : 0;
  if (actual !== command.base) {
    throw commandError(
      'base_version_conflict',
      `base_sync_version conflict: expected ${actual}`
    );
  }
}

async function writeSchedule(tx, command, zoneId, current, appliedAt) {
  const value = command.normalized;
  if (!current) {
    await tx.run(
      'INSERT INTO irrigation_schedules (' +
        'irrigation_zone_id,trigger_metric,threshold_kpa,duration_minutes,' +
        'enabled,response_mode,sync_version,deleted_at,last_applied_at,' +
        'created_at,updated_at' +
      ') VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [
        zoneId,
        value.metric,
        value.threshold,
        value.durationMinutes,
        value.enabled,
        value.responseMode,
        command.target,
        value.deletedAt,
        appliedAt,
        appliedAt,
        appliedAt,
      ]
    );
    return;
  }
  await tx.run(
    'UPDATE irrigation_schedules SET trigger_metric=?,threshold_kpa=?,' +
      'duration_minutes=?,enabled=?,response_mode=?,sync_version=?,' +
      'deleted_at=?,last_applied_at=?,updated_at=? ' +
      'WHERE irrigation_zone_id=?',
    [
      value.metric,
      value.threshold,
      value.durationMinutes,
      value.enabled,
      value.responseMode,
      command.target,
      value.deletedAt,
      appliedAt,
      appliedAt,
      zoneId,
    ]
  );
}

async function writeCalibration(tx, command, zoneId, current, appliedAt) {
  const value = command.normalized;
  if (!current) {
    await tx.run(
      'INSERT INTO zone_irrigation_calibration (' +
        'zone_id,valve_device_eui,measured_flow_rate_lpm,measurement_method,' +
        'measured_at,created_at,updated_at,sync_version,deleted_at,last_applied_at' +
      ') VALUES (?,NULL,?,?,?,?,?,?,?,?)',
      [
        zoneId,
        value.measuredFlowRateLpm,
        value.measurementMethod,
        value.measuredAt,
        appliedAt,
        appliedAt,
        command.target,
        value.deletedAt,
        appliedAt,
      ]
    );
    return;
  }
  await tx.run(
    'UPDATE zone_irrigation_calibration SET measured_flow_rate_lpm=?,' +
      'measurement_method=?,measured_at=?,updated_at=?,sync_version=?,' +
      'deleted_at=?,last_applied_at=? WHERE zone_id=?',
    [
      value.measuredFlowRateLpm,
      value.measurementMethod,
      value.measuredAt,
      appliedAt,
      command.target,
      value.deletedAt,
      appliedAt,
      zoneId,
    ]
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
    resourceUuid: command.zoneUuid,
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

function classify(error) {
  if (error && error.code === 'base_version_conflict') return 'CONFLICT';
  if (error && [
    'malformed_command',
    'gateway_mismatch',
    'missing_resource',
  ].includes(error.code)) {
    return 'REJECTED_PERMANENT';
  }
  return null;
}

async function applyOnce(db, envelope, runtime, type) {
  envelope = object(envelope, 'Pending command envelope');
  const command = type === 'UPSERT_SCHEDULE'
    ? scheduleCommand(envelope, runtime)
    : calibrationCommand(envelope, runtime);
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

    let current = null;
    try {
      const zoneId = await zoneIdentity(tx, command);
      current = await currentResource(tx, command, zoneId);
      assertBase(current, command);
      const appliedAt = new Date().toISOString();
      if (command.type === 'UPSERT_SCHEDULE') {
        await writeSchedule(tx, command, zoneId, current, appliedAt);
      } else {
        await writeCalibration(tx, command, zoneId, current, appliedAt);
      }
      return {
        handled: true,
        ack: await persistTerminal(tx, envelope, command, {
          result: 'APPLIED',
          currentVersion: command.target,
          appliedAt,
        }),
      };
    } catch (error) {
      const result = classify(error);
      if (!result) throw error;
      const currentVersion = current ? Number(current.sync_version || 0) : 0;
      return {
        handled: true,
        ack: await persistTerminal(tx, envelope, command, {
          result,
          currentVersion,
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

async function applyIrrigationConfigCommand(db, command, runtime) {
  const type = typeOf(command);
  const protectedCommandShape = protectedShape(command);
  if (!TYPES.has(type)) return { handled: false };
  if (!protectedCommandShape) return { handled: false };
  return enqueue(() => applyOnce(db, command, runtime, type));
}

module.exports = {
  TYPES,
  applyIrrigationConfigCommand,
  intentHash: canonicalHash,
  _resetForTests() {
    applyTail = Promise.resolve();
  },
};
