'use strict';

const crypto = require('node:crypto');

const TYPE = 'REPLACE_WEATHER_STATION_ZONES';
const EUI = /^[0-9A-F]{16}$/;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exact(value, field, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('malformed_command', `${field} must be an object`);
  }
  const allowed = new Set(keys);
  if (keys.some((key) => !Object.hasOwn(value, key)) ||
      Object.keys(value).some((key) => !allowed.has(key))) {
    throw failure('malformed_command', `${field} shape mismatch`);
  }
  return value;
}

function eui(value, field) {
  const result = String(value || '').trim().toUpperCase();
  if (!EUI.test(result)) {
    throw failure('malformed_command', `${field} must be an EUI-64`);
  }
  return result;
}

function version(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw failure('malformed_command', `${field} must be a non-negative integer`);
  }
  return value;
}

function zones(value) {
  if (!Array.isArray(value)) {
    throw failure('malformed_command', 'zone_uuids must be an array');
  }
  const result = value.map((item) => String(item || '').trim().toLowerCase());
  if (result.some((item) => !UUID.test(item))) {
    throw failure('malformed_command', 'zone_uuids must contain canonical UUIDs');
  }
  if (new Set(result).size !== result.length) {
    throw failure('malformed_command', 'zone_uuids must be unique');
  }
  if (result.some((item, index) => index && result[index - 1] > item)) {
    throw failure('malformed_command', 'zone_uuids must be sorted');
  }
  return result;
}

function hash(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') {
      return Object.keys(item).sort().reduce((out, key) => {
        if (key !== 'command_id') out[key] = canonical(item[key]);
        return out;
      }, {});
    }
    return item;
  };
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonical(value))).digest('hex');
}

function deliveryId(envelope) {
  const result = envelope && envelope.commandId;
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw failure('malformed_command', 'commandId must be a positive integer');
  }
  return result;
}

function parse(envelope, runtime) {
  if (String(envelope && envelope.commandType || '').toUpperCase() !== TYPE) {
    return null;
  }
  const payload = exact(envelope.payload, 'payload', [
    'command_id', 'command_type', 'effect_key', 'device_eui',
    'gateway_device_eui', 'base_sync_version', 'target_sync_version',
    'weather_station_zones',
  ]);
  deliveryId(envelope);
  if (!UUID.test(String(payload.command_id || '').toLowerCase()) ||
      payload.command_type !== TYPE) {
    throw failure('malformed_command', 'command identity is invalid');
  }
  const deviceEui = eui(payload.device_eui, 'device_eui');
  const gateway = eui(runtime && runtime.gateway_device_eui, 'runtime gateway');
  if (eui(payload.gateway_device_eui, 'gateway_device_eui') !== gateway) {
    throw failure('gateway_mismatch', 'Command gateway does not match this gateway');
  }
  const base = version(payload.base_sync_version, 'base_sync_version');
  const target = version(payload.target_sync_version, 'target_sync_version');
  if (target !== base + 1 ||
      payload.effect_key !== `weather_station_zones:${deviceEui}:${base}`) {
    throw failure('malformed_command', 'Version or effect key is invalid');
  }
  const desired = exact(payload.weather_station_zones, 'weather_station_zones', [
    'contract_version', 'device_eui', 'gateway_device_eui', 'zone_uuids',
    'sync_version', 'last_applied_at',
  ]);
  if (desired.contract_version !== 1 ||
      eui(desired.device_eui, 'desired device_eui') !== deviceEui ||
      eui(desired.gateway_device_eui, 'desired gateway_device_eui') !== gateway ||
      desired.sync_version !== target ||
      desired.last_applied_at !== null) {
    throw failure('malformed_command', 'Desired-state binding is invalid');
  }
  return {
    payload, deviceEui, gateway, base, target,
    effectKey: payload.effect_key, zoneUuids: zones(desired.zone_uuids),
  };
}

async function validateResources(tx, deviceEui, gateway, zoneUuids) {
  const device = await tx.get(
    'SELECT d.type_id,d.user_id,d.gateway_device_eui,d.deleted_at,' +
      'COALESCE(s.sync_version,0) AS assignment_version ' +
      'FROM devices d LEFT JOIN weather_station_zone_state s ' +
      'ON s.deveui=d.deveui WHERE d.deveui=? LIMIT 1',
    [deviceEui]
  );
  if (!device || device.deleted_at) {
    throw failure('missing_resource', 'Weather station does not exist');
  }
  if (device.type_id !== 'SENSECAP_S2120') {
    throw failure('type_mismatch', 'Device is not a SENSECAP_S2120');
  }
  if (String(device.gateway_device_eui || '').toUpperCase() !== gateway) {
    throw failure('gateway_mismatch', 'Weather station belongs to another gateway');
  }
  const rows = zoneUuids.length
    ? await tx.all(
      `SELECT id,zone_uuid,user_id FROM irrigation_zones
        WHERE zone_uuid IN (${zoneUuids.map(() => '?').join(',')})
          AND gateway_device_eui=? AND deleted_at IS NULL`,
      [...zoneUuids, gateway]
    )
    : [];
  if (rows.length !== zoneUuids.length ||
      rows.some((row) => Number(row.user_id) !== Number(device.user_id))) {
    throw failure('inaccessible_zone', 'One or more zones are inaccessible');
  }
  return { device, rows };
}

async function replace(tx, command, appliedAt) {
  const resources = await validateResources(
    tx, command.deviceEui, command.gateway, command.zoneUuids
  );
  if (Number(resources.device.assignment_version || 0) !== command.base) {
    throw failure('base_version_conflict', 'Assignment version changed');
  }
  await tx.run('DELETE FROM weather_station_zones WHERE deveui=?', [
    command.deviceEui,
  ]);
  const byUuid = new Map(resources.rows.map((row) => [row.zone_uuid, row.id]));
  for (const zoneUuid of command.zoneUuids) {
    await tx.run(
      'INSERT INTO weather_station_zones(deveui,zone_id) VALUES (?,?)',
      [command.deviceEui, byUuid.get(zoneUuid)]
    );
  }
  if (command.base === 0) {
    await tx.run(
      'INSERT INTO weather_station_zone_state(' +
        'deveui,sync_version,last_applied_at,updated_at) VALUES (?,0,?,?)',
      [command.deviceEui, appliedAt, appliedAt]
    );
  } else {
    await tx.run(
      'UPDATE weather_station_zone_state SET sync_version=?,' +
        'last_applied_at=?,updated_at=? WHERE deveui=?',
      [command.target, appliedAt, appliedAt, command.deviceEui]
    );
  }
}

function resultFor(error) {
  if (error.code === 'base_version_conflict') return 'CONFLICT';
  if ([
    'gateway_mismatch', 'missing_resource', 'type_mismatch',
    'inaccessible_zone',
  ].includes(error.code)) return 'REJECTED_PERMANENT';
  return null;
}

async function queueAck(tx, ack, at) {
  await tx.run(
    'DELETE FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
    [String(ack.commandId)]
  );
  await tx.run(
    'INSERT INTO command_ack_outbox(command_id,payload_json,created_at) ' +
      'VALUES (?,?,?)',
    [String(ack.commandId), JSON.stringify(ack), at]
  );
}

async function terminal(tx, envelope, command, result, current, reason) {
  const at = new Date().toISOString();
  const ack = {
    commandId: deliveryId(envelope),
    commandType: TYPE,
    effectKey: command.effectKey,
    status: result === 'APPLIED' ? 'ACKED'
      : result === 'CONFLICT' ? 'CONFLICT' : 'NACKED',
    result,
    appliedSyncVersion: current,
    duplicate: false,
    gatewayDeviceEui: command.gateway,
    resourceUuid: command.deviceEui,
    payloadHash: hash(command.payload),
    appliedAt: at,
  };
  if (reason) ack.reason = reason;
  await tx.run(
    'INSERT INTO applied_commands(' +
      'command_id,device_eui,command_type,effect_key,applied_at,result,' +
      'result_detail,originator) VALUES (?,?,?,?,?,?,?,?)',
    [String(ack.commandId), command.gateway, TYPE, command.effectKey, at,
      result, JSON.stringify(ack), 'cloud']
  );
  await queueAck(tx, ack, at);
  return ack;
}

async function applyWeatherStationZonesCommand(db, envelope, runtime) {
  const command = parse(envelope, runtime);
  if (!command) return { handled: false };
  return db.transaction(async (tx) => {
    const prior = await tx.get(
      'SELECT result_detail FROM applied_commands WHERE command_id=? LIMIT 1',
      [String(deliveryId(envelope))]
    );
    if (prior) {
      const ack = JSON.parse(prior.result_detail);
      await queueAck(tx, ack, ack.appliedAt);
      return { handled: true, ack };
    }
    try {
      const at = new Date().toISOString();
      await replace(tx, command, at);
      return {
        handled: true,
        ack: await terminal(tx, envelope, command, 'APPLIED', command.target),
      };
    } catch (error) {
      const result = resultFor(error);
      if (!result) throw error;
      const row = await tx.get(
        'SELECT sync_version FROM weather_station_zone_state WHERE deveui=?',
        [command.deviceEui]
      );
      return {
        handled: true,
        ack: await terminal(
          tx, envelope, command, result,
          row ? Number(row.sync_version || 0) : 0,
          error.message
        ),
      };
    }
  });
}

async function replaceLocalWeatherStationZones(db, input, runtime) {
  const deviceEui = eui(input && input.device_eui, 'device_eui');
  const gateway = eui(runtime && runtime.gateway_device_eui, 'runtime gateway');
  const zoneUuids = zones(input && input.zone_uuids);
  return db.transaction(async (tx) => {
    const resources = await validateResources(tx, deviceEui, gateway, zoneUuids);
    const base = Number(resources.device.assignment_version || 0);
    const target = base + 1;
    const at = new Date().toISOString();
    await replace(tx, {
      deviceEui, gateway, zoneUuids, base, target,
    }, at);
    return { device_eui: deviceEui, zone_uuids: zoneUuids, sync_version: target };
  });
}

module.exports = {
  TYPE,
  applyWeatherStationZonesCommand,
  replaceLocalWeatherStationZones,
};
