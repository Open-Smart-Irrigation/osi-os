'use strict';
// osi-entity-name/commands.js -- the receiver for UPSERT_DEVICE_NAME and
// UPSERT_ZONE_NAME (design section 5.6), modelled on
// osi-installation-location-helper/commands.js: ONE transaction covers the
// replay check, validation, authorization, the supersession fence, the write,
// the applied_commands row and the command_ack_outbox row.
//
// Two identities travel with every command. envelope.commandId is the numeric
// delivery identity: it keys applied_commands and it is the commandId the
// cloud reads back. payload.command_id is a UUID the cloud mints for tracing,
// and nothing here is keyed on it.
//
// These commands carry no effect_key. effect_key binds a physical effect, and
// the ledger treats a repeated key as a replay, so a constant key per target
// would make the second rename of a device look like a duplicate of the first.
const scope = require('../osi-scope-helper');
const index = require('./index');

const TARGETS = {
  UPSERT_DEVICE_NAME: 'device',
  UPSERT_ZONE_NAME: 'zone',
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EUI = /^[0-9A-F]{16}$/;
const UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const NAME_REASONS = new Set([
  'name_empty',
  'name_too_long',
  'name_control_characters',
  'name_invalid_unicode',
]);

// A rejection is a terminal answer the cloud must see, never a crash: it is
// caught below and turned into a REJECTED_PERMANENT acknowledgement.
function rejection(reason, message) {
  const error = new Error(message);
  error.code = 'entity_name_rejected';
  error.reason = reason;
  return error;
}

function canonicalUuid(value) {
  return String(value == null ? '' : value).trim().toLowerCase();
}

function canonicalEui(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

async function queueAck(tx, ack) {
  await tx.run(
    'DELETE FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
    [String(ack.commandId)]
  );
  await tx.run(
    'INSERT INTO command_ack_outbox(command_id,payload_json,created_at) VALUES(?,?,?)',
    [String(ack.commandId), JSON.stringify(ack), ack.appliedAt]
  );
}

function parsePayload(type, payload, runtime) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw rejection('malformed_command', 'payload must be an object');
  }
  if (String(payload.command_type || '') !== type) {
    throw rejection('malformed_command', 'payload command_type differs from the envelope');
  }
  if (!UUID.test(canonicalUuid(payload.command_id))) {
    throw rejection('malformed_command', 'command_id must be a canonical UUID');
  }
  const actor = canonicalUuid(payload.actor_user_uuid);
  if (!UUID.test(actor)) {
    throw rejection('malformed_command', 'actor_user_uuid must be a canonical UUID');
  }
  const gateway = canonicalEui(payload.gateway_device_eui);
  if (!EUI.test(gateway)) {
    throw rejection('malformed_command', 'gateway_device_eui must be 16 upper-case hex digits');
  }
  const requestedAt = String(payload.requested_at == null ? '' : payload.requested_at).trim();
  if (!UTC_MS.test(requestedAt) || !Number.isFinite(Date.parse(requestedAt))) {
    throw rejection('malformed_command', 'requested_at must be a UTC timestamp with milliseconds');
  }
  const values = payload.values;
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw rejection('malformed_command', 'values must be an object');
  }
  if (typeof values.name !== 'string') {
    throw rejection('malformed_command', 'values.name must be a string');
  }
  let name;
  try {
    name = index.normalizeEntityName(values.name);
  } catch (error) {
    throw rejection(
      NAME_REASONS.has(error.code) ? error.code : 'malformed_command',
      error.message
    );
  }
  const parsed = { actor, gateway, requestedAt, name };
  if (TARGETS[type] === 'device') {
    parsed.target = canonicalEui(payload.device_eui);
    if (!EUI.test(parsed.target)) {
      throw rejection('malformed_command', 'device_eui must be 16 upper-case hex digits');
    }
  } else {
    parsed.target = canonicalUuid(payload.zone_uuid);
    if (!UUID.test(parsed.target)) {
      throw rejection('malformed_command', 'zone_uuid must be a canonical UUID');
    }
  }
  if (parsed.gateway !== canonicalEui(runtime && runtime.gateway_device_eui)) {
    throw rejection('gateway_mismatch', 'command names another gateway');
  }
  return parsed;
}

async function assertActor(tx, actorUuid) {
  const actor = await tx.get(
    'SELECT id, disabled_at FROM users WHERE user_uuid=? LIMIT 1',
    [actorUuid]
  );
  if (!actor || actor.disabled_at) {
    throw rejection('actor_missing_or_disabled', 'actor account is missing or disabled');
  }
  return actor;
}

// The scope assertions answer 403 for a disabled account and 404 for no
// access. The row's existence was already checked above, so a 404 here means
// the actor may not see the target.
function accessRejection(error) {
  const status = Number(error.statusCode || error.status);
  return status === 403
    ? rejection('actor_missing_or_disabled', error.message)
    : rejection('forbidden', error.message);
}

// One cloud clock orders cloud renames of one target among themselves. A
// rename typed at the gateway is not in applied_commands, so it never fences a
// cloud rename (decision D2). Only an APPLIED row arms the fence; a rejected
// command must not block the retry that follows it.
async function assertNotSuperseded(tx, type, target, requestedAt) {
  const later = await tx.get(
    'SELECT 1 AS hit FROM applied_commands ' +
      "WHERE command_type=? AND result='APPLIED' " +
      "AND json_extract(result_detail,'$.target')=? " +
      "AND json_extract(result_detail,'$.requestedAt')>? LIMIT 1",
    [type, target, requestedAt]
  );
  if (later) {
    throw rejection('superseded', 'a later rename of this target has already been applied');
  }
}

async function authorize(tx, parsed, runtime, kind, rowUserId, zoneUuid) {
  const actor = await assertActor(tx, parsed.actor);
  if (runtime.scopedMode === true) {
    let access;
    try {
      access = kind === 'device'
        ? await scope.assertFreshDeviceAccess(tx, parsed.actor, parsed.target, { scopedMode: true })
        : await scope.assertFreshZoneAccess(tx, parsed.actor, zoneUuid, { scopedMode: true });
    } catch (error) {
      throw accessRejection(error);
    }
    if (!scope.canMutate(access.role)) {
      throw rejection('forbidden', 'actor may not rename this ' + kind);
    }
    return;
  }
  // Scoped access off: the wildcard admin that assertFreshDeviceAccess returns
  // in this mode proves nothing, so ownership is checked directly. A NULL
  // user_id is an unclaimed device and fails here.
  if (rowUserId == null || Number(rowUserId) !== Number(actor.id)) {
    throw rejection('forbidden', 'actor does not own this ' + kind);
  }
}

async function applyDevice(tx, parsed, runtime) {
  const row = await tx.get(
    'SELECT deveui, user_id, gateway_device_eui FROM devices WHERE deveui=? AND deleted_at IS NULL LIMIT 1',
    [parsed.target]
  );
  if (!row) throw rejection('not_found', 'device not found');
  const bound = canonicalEui(row.gateway_device_eui);
  if (bound && bound !== parsed.gateway) {
    throw rejection('gateway_mismatch', 'device belongs to another gateway');
  }
  await authorize(tx, parsed, runtime, 'device', row.user_id, null);
  await assertNotSuperseded(tx, 'UPSERT_DEVICE_NAME', parsed.target, parsed.requestedAt);
  return index.renameDeviceInTransaction(tx, { deveui: parsed.target, name: parsed.name });
}

async function applyZone(tx, parsed, runtime) {
  const row = await tx.get(
    'SELECT id, zone_uuid, user_id, gateway_device_eui FROM irrigation_zones ' +
      'WHERE zone_uuid=? AND deleted_at IS NULL LIMIT 1',
    [parsed.target]
  );
  if (!row) throw rejection('not_found', 'zone not found');
  const bound = canonicalEui(row.gateway_device_eui);
  if (bound && bound !== parsed.gateway) {
    throw rejection('gateway_mismatch', 'zone belongs to another gateway');
  }
  await authorize(tx, parsed, runtime, 'zone', row.user_id, row.zone_uuid);
  await assertNotSuperseded(tx, 'UPSERT_ZONE_NAME', parsed.target, parsed.requestedAt);
  return index.renameZoneInTransaction(tx, { zoneUuid: row.zone_uuid, name: parsed.name });
}

async function applyNameCommand(db, envelope, runtime = {}) {
  const type = String((envelope && envelope.commandType) || '');
  if (!TARGETS[type]) return { handled: false };
  const id = envelope.commandId;
  if (!Number.isSafeInteger(id) || id < 1) {
    const error = new Error('invalid protected delivery envelope');
    error.code = 'invalid_entity_name_command';
    throw error;
  }
  const gatewayDeviceEui = canonicalEui(runtime.gateway_device_eui);
  return db.transaction(async (tx) => {
    const previous = await tx.get(
      'SELECT result_detail FROM applied_commands WHERE command_id=?',
      [String(id)]
    );
    if (previous) {
      const stored = JSON.parse(previous.result_detail);
      await queueAck(tx, stored);
      return { handled: true, ack: stored };
    }
    let result = 'APPLIED';
    let reason = null;
    let target = null;
    let requestedAt = null;
    let written = null;
    try {
      const parsed = parsePayload(type, envelope.payload, runtime);
      target = parsed.target;
      requestedAt = parsed.requestedAt;
      written = TARGETS[type] === 'device'
        ? await applyDevice(tx, parsed, runtime)
        : await applyZone(tx, parsed, runtime);
    } catch (error) {
      if (error.code && /SQLITE/.test(error.code)) throw error;
      if (error.code !== 'entity_name_rejected') throw error;
      result = 'REJECTED_PERMANENT';
      reason = error.reason;
    }
    const ack = {
      commandId: id,
      commandType: type,
      effectKey: null,
      gatewayDeviceEui,
      status: result === 'APPLIED' ? 'ACKED' : 'NACKED',
      result,
      reason,
      duplicate: false,
      appliedSyncVersion: written ? written.sync_version : null,
      appliedAt: new Date().toISOString(),
      target,
      requestedAt,
    };
    await tx.run(
      'INSERT INTO applied_commands(' +
        'command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator' +
      ') VALUES(?,?,?,?,?,?,?,?)',
      [
        String(id),
        gatewayDeviceEui || 'UNKNOWN',
        type,
        null,
        ack.appliedAt,
        result,
        JSON.stringify(ack),
        'cloud',
      ]
    );
    await queueAck(tx, ack);
    return { handled: true, ack };
  });
}

module.exports = { applyNameCommand };
