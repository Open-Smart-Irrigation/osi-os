'use strict';

const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{32}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EUI64 = /^[0-9A-F]{16}$/;
const BCRYPT = /^\$2[aby]\$\d{2}\$.{53}$/;
const ROLES = new Set(['admin', 'researcher', 'viewer']);
const TYPES = new Set([
  'UPSERT_SCOPED_USER',
  'RESET_SCOPED_USER_PASSWORD',
  'UPSERT_USER_ZONE_ASSIGNMENT',
  'DELETE_USER_ZONE_ASSIGNMENT',
  'UPSERT_USER_PLOT_ASSIGNMENT',
  'DELETE_USER_PLOT_ASSIGNMENT',
]);

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
    throw commandError('malformed_command', 'Pending delivery commandId must be a positive integer');
  }
  return value;
}

function requiredText(value, field) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw commandError('malformed_command', field + ' is required');
  return text;
}

function uuid(value, field) {
  const normalized = requiredText(value, field).toLowerCase();
  if (!UUID.test(normalized)) {
    throw commandError('malformed_command', field + ' must be a contract UUID');
  }
  return normalized;
}

function baseVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw commandError('malformed_command', 'base_sync_version must be a non-negative integer');
  }
  return value;
}

function effectBinding(type, payload) {
  let resource;
  let prefix;
  if (type === 'UPSERT_SCOPED_USER') {
    resource = object(payload.user, 'user');
    prefix = 'scoped_user';
  } else if (type === 'RESET_SCOPED_USER_PASSWORD') {
    resource = payload;
    prefix = 'scoped_user_password';
  } else if (type === 'UPSERT_USER_ZONE_ASSIGNMENT') {
    resource = object(payload.zone_assignment, 'zone_assignment');
    prefix = 'scoped_zone_assignment';
  } else if (type === 'DELETE_USER_ZONE_ASSIGNMENT') {
    resource = payload;
    prefix = 'scoped_zone_assignment';
  } else if (type === 'UPSERT_USER_PLOT_ASSIGNMENT') {
    resource = object(payload.plot_assignment, 'plot_assignment');
    prefix = 'scoped_plot_assignment';
  } else if (type === 'DELETE_USER_PLOT_ASSIGNMENT') {
    resource = payload;
    prefix = 'scoped_plot_assignment';
  } else {
    return null;
  }
  const key = type.includes('SCOPED_USER')
    ? uuid(resource.user_uuid, 'user_uuid')
    : uuid(resource.assignment_uuid, 'assignment_uuid');
  const base = baseVersion(resource.base_sync_version);
  return {
    key,
    base,
    effectKey: prefix + ':' + key + ':' + base,
  };
}

function validEffectBinding(envelope, runtime) {
  try {
    const type = typeOf(envelope);
    if (!TYPES.has(type) || !runtime || runtime.command_type_recognized !== true) return false;
    const payload = object(envelope.payload, 'Pending command payload');
    const binding = effectBinding(type, payload);
    const supplied = String(
      payload.effect_key || payload.effectKey || envelope.effectKey || ''
    ).trim();
    return supplied === binding.effectKey;
  } catch (_) {
    return false;
  }
}

function canonicalHash(value) {
  function canonical(item) {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === 'object') {
      return Object.keys(item).sort().reduce(function(out, key) {
        out[key] = canonical(item[key]);
        return out;
      }, {});
    }
    return item;
  }
  return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function classify(error) {
  if (!error || !error.code) return null;
  if (error.code === 'base_version_conflict') {
    return { result: 'CONFLICT', reason: error.message };
  }
  if ([
    'malformed_command',
    'gateway_mismatch',
    'last_admin',
    'missing_resource',
    'duplicate_username',
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
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (_) {
    return null;
  }
}

async function persistTerminal(tx, envelope, runtime, type, effectKey, terminal) {
  const id = deliveryId(envelope);
  const appliedAt = new Date().toISOString();
  const ack = {
    commandId: id,
    commandType: type,
    effectKey,
    status: terminal.result === 'APPLIED' ? 'ACKED' : 'NACKED',
    result: terminal.result,
    appliedSyncVersion: terminal.appliedSyncVersion,
    duplicate: false,
    gatewayDeviceEui: runtime.gateway_device_eui,
    appliedAt,
  };
  if (terminal.reason) ack.reason = terminal.reason;
  if (terminal.resourceUuid) ack.resourceUuid = terminal.resourceUuid;
  if (terminal.payloadHash) ack.payloadHash = terminal.payloadHash;
  await tx.run(
    'INSERT INTO applied_commands(' +
      'command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator' +
    ') VALUES (?,?,?,?,?,?,?,?)',
    [String(id), runtime.gateway_device_eui, type, effectKey, appliedAt,
      terminal.result, JSON.stringify(ack), 'cloud']
  );
  await queueAck(tx, ack, appliedAt);
  return ack;
}

async function replay(tx, row, envelope) {
  const stored = parsedAck(row);
  if (!stored) {
    throw commandError('malformed_command', 'Stored command result is not replayable');
  }
  await queueAck(tx, stored, stored.appliedAt || new Date().toISOString());
  return stored;
}

function assertGateway(resource, gateway) {
  if (String(resource.gateway_device_eui || '').trim().toUpperCase() !== gateway) {
    throw commandError('gateway_mismatch', 'Command resource gateway does not match this gateway');
  }
}

async function currentVersion(tx, table, keyColumn, key) {
  const row = await tx.get(
    'SELECT sync_version FROM ' + table + ' WHERE ' + keyColumn + '=? LIMIT 1',
    [key]
  );
  return row ? Number(row.sync_version) : 0;
}

function assertBase(actual, expected) {
  if (actual !== expected) {
    throw commandError(
      'base_version_conflict',
      'base_sync_version conflict: expected ' + actual
    );
  }
}

async function enabledAdminCount(tx) {
  const row = await tx.get(
    "SELECT COUNT(*) AS n FROM users WHERE role='admin' AND disabled_at IS NULL"
  );
  return Number(row && row.n || 0);
}

async function applyUser(tx, payload, runtime) {
  const user = object(payload.user, 'user');
  assertGateway(user, runtime.gateway_device_eui);
  const userUuid = uuid(user.user_uuid, 'user_uuid');
  const username = requiredText(user.username, 'username');
  if (username.length > 64 || !ROLES.has(user.role)) {
    throw commandError('malformed_command', 'Scoped user fields are invalid');
  }
  const current = await tx.get('SELECT * FROM users WHERE user_uuid=? LIMIT 1', [userUuid]);
  const base = baseVersion(user.base_sync_version);
  assertBase(current ? Number(current.sync_version) : 0, base);
  if (current && current.role === 'admin' && current.disabled_at == null &&
      (user.role !== 'admin' || user.disabled_at != null) &&
      await enabledAdminCount(tx) <= 1) {
    throw commandError('last_admin', 'Cannot disable or demote the last enabled admin');
  }
  const passwordHash = user.password_hash == null ? null : String(user.password_hash);
  if (passwordHash != null && !BCRYPT.test(passwordHash)) {
    throw commandError('malformed_command', 'password_hash must be BCrypt');
  }
  if (!current && !passwordHash) {
    throw commandError('malformed_command', 'New scoped user requires password_hash');
  }
  const target = base + 1;
  if (current) {
    try {
      await tx.run(
        'UPDATE users SET username=?,role=?,disabled_at=?,sync_version=?,' +
          'password_hash=COALESCE(?,password_hash),updated_at=? WHERE user_uuid=?',
        [username, user.role, user.disabled_at == null ? null : String(user.disabled_at),
          target, passwordHash, new Date().toISOString(), userUuid]
      );
    } catch (error) {
      if (String(error && error.message || '').includes('UNIQUE')) {
        throw commandError('duplicate_username', 'Username is already in use');
      }
      throw error;
    }
  } else {
    try {
      const now = new Date().toISOString();
      await tx.run(
        'INSERT INTO users(' +
          'username,password_hash,created_at,updated_at,user_uuid,edge_originated,role,disabled_at,sync_version' +
        ') VALUES (?,?,?,?,?,1,?,?,?)',
        [username, passwordHash, now, now, userUuid, user.role,
          user.disabled_at == null ? null : String(user.disabled_at), target]
      );
    } catch (error) {
      if (String(error && error.message || '').includes('UNIQUE')) {
        throw commandError('duplicate_username', 'Username is already in use');
      }
      throw error;
    }
  }
  return { appliedSyncVersion: target, resourceUuid: userUuid };
}

async function resetPassword(tx, payload) {
  const userUuid = uuid(payload.user_uuid, 'user_uuid');
  const base = baseVersion(payload.base_sync_version);
  const passwordHash = requiredText(payload.password_hash, 'password_hash');
  if (!BCRYPT.test(passwordHash)) {
    throw commandError('malformed_command', 'password_hash must be BCrypt');
  }
  const current = await tx.get('SELECT sync_version FROM users WHERE user_uuid=?', [userUuid]);
  if (!current) throw commandError('missing_resource', 'Scoped user not found');
  assertBase(Number(current.sync_version), base);
  const target = base + 1;
  await tx.run(
    'UPDATE users SET password_hash=?,username=username,sync_version=?,updated_at=? WHERE user_uuid=?',
    [passwordHash, target, new Date().toISOString(), userUuid]
  );
  return { appliedSyncVersion: target, resourceUuid: userUuid };
}

async function upsertAssignment(tx, payload, runtime, kind) {
  const field = kind === 'zone' ? 'zone_assignment' : 'plot_assignment';
  const resourceField = kind === 'zone' ? 'zone_uuid' : 'plot_uuid';
  const table = kind === 'zone' ? 'user_zone_assignments' : 'user_plot_assignments';
  const assignment = object(payload[field], field);
  assertGateway(assignment, runtime.gateway_device_eui);
  const assignmentUuid = uuid(assignment.assignment_uuid, 'assignment_uuid');
  const userUuid = uuid(assignment.user_uuid, 'user_uuid');
  const resourceUuid = uuid(assignment[resourceField], resourceField);
  const user = await tx.get('SELECT user_uuid FROM users WHERE user_uuid=?', [userUuid]);
  if (!user) throw commandError('missing_resource', 'Scoped user not found');
  const base = baseVersion(assignment.base_sync_version);
  const current = await tx.get(
    'SELECT sync_version FROM ' + table + ' WHERE assignment_uuid=?',
    [assignmentUuid]
  );
  assertBase(current ? Number(current.sync_version) : 0, base);
  const target = base + 1;
  if (current) {
    await tx.run(
      'UPDATE ' + table + ' SET user_uuid=?,' + resourceField + '=?,' +
        'assigned_by_user_uuid=?,gateway_device_eui=?,sync_version=?,updated_at=?,deleted_at=NULL ' +
        'WHERE assignment_uuid=?',
      [userUuid, resourceUuid, assignment.assigned_by_user_uuid || null,
        runtime.gateway_device_eui, target, new Date().toISOString(), assignmentUuid]
    );
  } else {
    const now = new Date().toISOString();
    await tx.run(
      'INSERT INTO ' + table + '(' +
        'assignment_uuid,user_uuid,' + resourceField + ',assigned_by_user_uuid,' +
        'gateway_device_eui,sync_version,created_at,updated_at,deleted_at' +
      ') VALUES (?,?,?,?,?,?,?,?,NULL)',
      [assignmentUuid, userUuid, resourceUuid, assignment.assigned_by_user_uuid || null,
        runtime.gateway_device_eui, target, now, now]
    );
  }
  return { appliedSyncVersion: target, resourceUuid: assignmentUuid };
}

async function deleteAssignment(tx, payload, runtime, kind) {
  const table = kind === 'zone' ? 'user_zone_assignments' : 'user_plot_assignments';
  const assignmentUuid = uuid(payload.assignment_uuid, 'assignment_uuid');
  const base = baseVersion(payload.base_sync_version);
  const current = await tx.get(
    'SELECT sync_version,gateway_device_eui FROM ' + table + ' WHERE assignment_uuid=?',
    [assignmentUuid]
  );
  if (!current) throw commandError('missing_resource', 'Scoped assignment not found');
  if (String(current.gateway_device_eui || '').trim().toUpperCase() !==
      runtime.gateway_device_eui) {
    throw commandError('missing_resource', 'Scoped assignment not found');
  }
  assertBase(Number(current.sync_version), base);
  const target = base + 1;
  await tx.run(
    'UPDATE ' + table + ' SET deleted_at=?,sync_version=?,updated_at=? WHERE assignment_uuid=?',
    [new Date().toISOString(), target, new Date().toISOString(), assignmentUuid]
  );
  return { appliedSyncVersion: target, resourceUuid: assignmentUuid };
}

async function applyMutation(tx, type, payload, runtime) {
  if (type === 'UPSERT_SCOPED_USER') return applyUser(tx, payload, runtime);
  if (type === 'RESET_SCOPED_USER_PASSWORD') return resetPassword(tx, payload);
  if (type === 'UPSERT_USER_ZONE_ASSIGNMENT') {
    return upsertAssignment(tx, payload, runtime, 'zone');
  }
  if (type === 'DELETE_USER_ZONE_ASSIGNMENT') {
    return deleteAssignment(tx, payload, runtime, 'zone');
  }
  if (type === 'UPSERT_USER_PLOT_ASSIGNMENT') {
    return upsertAssignment(tx, payload, runtime, 'plot');
  }
  return deleteAssignment(tx, payload, runtime, 'plot');
}

let applyTail = Promise.resolve();

function enqueue(work) {
  const scheduled = applyTail.then(work, work);
  applyTail = scheduled.then(function() {}, function() {});
  return scheduled;
}

async function applyOnce(db, envelope, runtime) {
  envelope = object(envelope, 'Pending command envelope');
  const type = typeOf(envelope);
  if (!TYPES.has(type)) return { handled: false };
  const id = deliveryId(envelope);
  const payload = object(envelope.payload, 'Pending command payload');
  if (payload.command_type !== type || !UUID.test(String(payload.command_id || '').toLowerCase())) {
    throw commandError('malformed_command', 'Logical command identity or type is invalid');
  }
  const gateway = String(runtime && runtime.gateway_device_eui || '').trim().toUpperCase();
  if (!EUI64.test(gateway)) {
    throw commandError('gateway_mismatch', 'Runtime gateway EUI is invalid');
  }
  runtime = Object.assign({}, runtime, { gateway_device_eui: gateway });
  const binding = effectBinding(type, payload);
  const suppliedEffect = String(payload.effect_key || envelope.effectKey || '').trim();
  if (suppliedEffect !== binding.effectKey) {
    throw commandError('malformed_command', 'effect_key does not match resource and base version');
  }
  return db.transaction(async function(tx) {
    const prior = await tx.get(
      'SELECT * FROM applied_commands WHERE command_id=? LIMIT 1',
      [String(id)]
    );
    if (prior) return { handled: true, ack: await replay(tx, prior, envelope) };
    try {
      const terminal = await applyMutation(tx, type, payload, runtime);
      terminal.result = 'APPLIED';
      terminal.payloadHash = canonicalHash(payload);
      const ack = await persistTerminal(
        tx, envelope, runtime, type, binding.effectKey, terminal
      );
      return { handled: true, ack };
    } catch (error) {
      const failure = classify(error);
      if (!failure) throw error;
      failure.appliedSyncVersion = await currentVersionForFailure(
        tx, type, payload
      );
      const ack = await persistTerminal(
        tx, envelope, runtime, type, binding.effectKey, failure
      );
      return { handled: true, ack };
    }
  });
}

async function currentVersionForFailure(tx, type, payload) {
  if (type === 'UPSERT_SCOPED_USER') {
    return currentVersion(tx, 'users', 'user_uuid', payload.user.user_uuid);
  }
  if (type === 'RESET_SCOPED_USER_PASSWORD') {
    return currentVersion(tx, 'users', 'user_uuid', payload.user_uuid);
  }
  const resource = type.startsWith('UPSERT_')
    ? payload[type.includes('ZONE') ? 'zone_assignment' : 'plot_assignment']
    : payload;
  return currentVersion(
    tx,
    type.includes('ZONE') ? 'user_zone_assignments' : 'user_plot_assignments',
    'assignment_uuid',
    resource.assignment_uuid
  );
}

function applyScopedAccessCommand(db, envelope, runtime) {
  return enqueue(function() {
    return applyOnce(db, envelope, runtime).then(function(result) {
      const scope = runtime && runtime.scope_helper;
      if (result.handled && result.ack && result.ack.result === 'APPLIED' &&
          scope && typeof scope.invalidateScope === 'function') {
        scope.invalidateScope();
      }
      return result;
    });
  });
}

module.exports = {
  TYPES,
  applyScopedAccessCommand,
  validEffectBinding,
  _resetForTests: function() {
    applyTail = Promise.resolve();
  },
};
