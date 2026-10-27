'use strict';

// Storage is split into transaction-scoped (...Tx) functions and facade
// wrappers. A caller already inside db.transaction() must pass only its
// {run, all, get, exec} scope; these helpers never queue an outer DB call.

const { parseInstant } = require('./evaluate');

const POLICY_COLUMNS = [
  'zone_uuid', 'condition_json', 'timezone', 'enabled', 'observation_window_minutes',
  'min_interval_minutes', 'max_daily_minutes', 'delivery_settings_json', 'effective_from',
  'sync_version', 'updated_at', 'deleted_at',
];
const OCCURRENCE_IDENTITY_COLUMNS = [
  'policy_uuid', 'zone_uuid', 'device_eui', 'due_at', 'policy_revision',
  'schedule_revision', 'policy_sync_version', 'schedule_sync_version',
];
const OCCURRENCE_SNAPSHOT_COLUMNS = [
  'expires_at', 'decision', 'decision_reason', 'decision_evidence_json',
  'decision_at', 'requested_duration_minutes', 'effective_duration_minutes', 'command_id',
  'reservation_start_at', 'reservation_end_at', 'reserved_minutes',
];
const OCCURRENCE_TRANSPORT_COLUMNS = [
  'queue_id', 'sent_at', 'observed_open_at', 'observed_close_at', 'updated_at',
];
const OCCURRENCE_INSERT_COLUMNS = OCCURRENCE_IDENTITY_COLUMNS.concat(
  OCCURRENCE_SNAPSHOT_COLUMNS,
  ['state', 'queue_id', 'claimed_at', 'attempted_at', 'sent_at', 'observed_open_at', 'observed_close_at', 'created_at', 'updated_at'],
);
const RUNTIME_COLUMNS = ['last_trusted_tick_at', 'last_decided_due_at'];
const OBSERVATION_COLUMNS = ['observed_open_at', 'observed_close_at'];
const PRE_ACCEPTANCE_FAILURE_AUTHORIZATION = 'conditional_irrigation_pre_acceptance_failure_v1';
const PRE_ACCEPTANCE_FAILURE_CODES = new Set(['enqueue_rejected', 'enqueue_failed_before_acceptance']);

function noUndefined(value) { return value === undefined ? null : value; }

function errorWithCode(code, message, extra = {}) {
  return Object.assign(new Error(message || code), { code, ...extra });
}

function policyUuid(value) {
  const id = String(value == null ? '' : value).trim();
  if (!id) throw errorWithCode('invalid_policy_uuid', 'policy_uuid is required');
  return id;
}

function policyVersion(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw errorWithCode('invalid_sync_version', 'sync_version must be a positive integer');
  }
  return value;
}

async function getPolicyTx(tx, value) {
  const id = policyUuid(value);
  return tx.get('SELECT * FROM irrigation_policies WHERE policy_uuid=?', [id]);
}

async function getPolicy(db, value) {
  return db.get('SELECT * FROM irrigation_policies WHERE policy_uuid=?', [policyUuid(value)]);
}

async function upsertPolicyTx(tx, input, { expectedSyncVersion } = {}) {
  const policy = input || {};
  const id = policyUuid(policy.policy_uuid);
  const expected = expectedSyncVersion === undefined ? undefined : expectedSyncVersion;
  if (expected !== undefined && expected !== null) policyVersion(expected);
  const before = await getPolicyTx(tx, id);
  if (!before && expected !== undefined && expected !== null) {
    throw errorWithCode('version_conflict', 'policy does not exist', { expected, actual: null });
  }
  if (before && expected !== undefined && expected !== before.sync_version) {
    throw errorWithCode('version_conflict', 'policy version conflict', { expected, actual: before.sync_version });
  }

  const hasExplicitVersion = Object.prototype.hasOwnProperty.call(policy, 'sync_version');
  if (hasExplicitVersion && policy.sync_version == null) {
    throw errorWithCode('invalid_sync_version', 'sync_version must be a positive integer');
  }
  const requestedVersion = hasExplicitVersion ? policyVersion(policy.sync_version) : null;
  if (!before) {
    const columns = ['policy_uuid', ...POLICY_COLUMNS];
    const values = [id].concat(POLICY_COLUMNS.map((column) => {
      if (Object.prototype.hasOwnProperty.call(policy, column)) return noUndefined(policy[column]);
      if (column === 'condition_json') return '{}';
      if (column === 'timezone') return 'UTC';
      if (column === 'sync_version') return requestedVersion == null ? 1 : requestedVersion;
      if (column === 'updated_at') return new Date().toISOString();
      return null;
    }));
    await tx.run(`INSERT INTO irrigation_policies(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`, values);
  } else {
    if (requestedVersion != null && requestedVersion <= before.sync_version) {
      throw errorWithCode('version_conflict', 'sync_version must advance on update', {
        expected: requestedVersion, actual: before.sync_version,
      });
    }
    const columns = POLICY_COLUMNS.filter((column) => Object.prototype.hasOwnProperty.call(policy, column) && column !== 'sync_version');
    const nextVersion = requestedVersion == null ? before.sync_version + 1 : requestedVersion;
    const assignments = columns.map((column) => `${column}=?`);
    const values = columns.map((column) => noUndefined(policy[column]));
    assignments.push('sync_version=?');
    values.push(nextVersion, id);
    await tx.run(`UPDATE irrigation_policies SET ${assignments.join(',')} WHERE policy_uuid=?`, values);
  }
  return getPolicyTx(tx, id);
}

async function upsertPolicy(db, input, options) {
  return db.transaction((tx) => upsertPolicyTx(tx, input, options));
}

function occurrenceKey(key) {
  const value = key || {};
  const scheduleUuid = String(value.schedule_uuid == null ? '' : value.schedule_uuid).trim();
  const localDate = String(value.local_date == null ? '' : value.local_date).trim();
  const localTime = String(value.local_time == null ? '' : value.local_time).trim();
  if (!scheduleUuid || !localDate || !localTime) {
    throw errorWithCode('invalid_occurrence_key', 'schedule_uuid, local_date and local_time are required');
  }
  return { schedule_uuid: scheduleUuid, local_date: localDate, local_time: localTime };
}

async function getOccurrenceTx(tx, key) {
  const k = occurrenceKey(key);
  return tx.get('SELECT * FROM irrigation_occurrences WHERE schedule_uuid=? AND local_date=? AND local_time=?', [k.schedule_uuid, k.local_date, k.local_time]);
}

async function insertOccurrenceTx(tx, input) {
  const value = input || {};
  const key = occurrenceKey(value);
  const columns = ['schedule_uuid', 'local_date', 'local_time'].concat(OCCURRENCE_INSERT_COLUMNS);
  const now = new Date().toISOString();
  const params = [key.schedule_uuid, key.local_date, key.local_time].concat(OCCURRENCE_INSERT_COLUMNS.map((column) => {
    if (Object.prototype.hasOwnProperty.call(value, column)) return noUndefined(value[column]);
    if (column === 'state') return 'PENDING';
    if (column === 'created_at' || column === 'updated_at') return now;
    return null;
  }));
  if (value.decision_at != null) assertInstant(value.decision_at, 'decision_at');
  // The conflict target is the occurrence identity. Other constraint failures
  // (required values, state CHECKs, or command_id uniqueness) must surface.
  await tx.run(`INSERT INTO irrigation_occurrences(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')}) ON CONFLICT(schedule_uuid,local_date,local_time) DO NOTHING`, params);
  return getOccurrenceTx(tx, key);
}

async function insertOccurrence(db, input) {
  return db.transaction((tx) => insertOccurrenceTx(tx, input));
}

function currentVersionMismatch(row, options) {
  if (options && options.policySyncVersion !== undefined && options.policySyncVersion !== row.policy_sync_version) return true;
  if (options && options.scheduleSyncVersion !== undefined && options.scheduleSyncVersion !== row.schedule_sync_version) return true;
  return false;
}

async function claimOccurrenceTx(tx, key, options = {}) {
  const before = await getOccurrenceTx(tx, key);
  if (!before) throw errorWithCode('occurrence_not_found', 'occurrence does not exist');
  // The composite calendar identity owns replay. Once a decision or reservation
  // exists, a replay receives the durable result and cannot resend.
  if (before.state !== 'PENDING') return { claimed: false, replayed: true, send: false, occurrence: before };
  if (currentVersionMismatch(before, options)) {
    throw errorWithCode('version_conflict', 'occurrence policy or schedule version changed', {
      policySyncVersion: before.policy_sync_version, scheduleSyncVersion: before.schedule_sync_version,
    });
  }
  const now = options.now || new Date().toISOString();
  await tx.run("UPDATE irrigation_occurrences SET state='CLAIMED', claimed_at=?, updated_at=? WHERE schedule_uuid=? AND local_date=? AND local_time=? AND state='PENDING'", [now, now, before.schedule_uuid, before.local_date, before.local_time]);
  const after = await getOccurrenceTx(tx, before);
  if (!after) throw errorWithCode('occurrence_not_found', 'occurrence disappeared after claim');
  return { claimed: after.state === 'CLAIMED', replayed: false, send: false, occurrence: after };
}

async function claimOccurrence(db, key, options) {
  return db.transaction((tx) => claimOccurrenceTx(tx, key, options));
}

const TRANSITIONS = {
  PENDING: new Set(['CLAIMED', 'SKIPPED']),
  CLAIMED: new Set(['SKIPPED', 'RESERVED']),
  RESERVED: new Set(['ATTEMPTED', 'SKIPPED', 'EXPIRED']),
  ATTEMPTED: new Set(['SENT', 'UNKNOWN', 'EXPIRED']),
  // An accepted queue item can later be invalidated by an ambiguous flush.
  // UNKNOWN records transport uncertainty; it does not claim non-delivery and
  // therefore keeps the occurrence's reservation and acceptance markers.
  SENT: new Set(['UNKNOWN']),
  UNKNOWN: new Set([]),
  SKIPPED: new Set([]), EXPIRED: new Set([]),
};

function assertInstant(value, name) {
  if (parseInstant(value) == null) throw errorWithCode('invalid_timestamp', `${name} must be a strict timestamp`);
}

function assertNonDeliveryProof(options, patch, before) {
  if (!options || options.authorization !== PRE_ACCEPTANCE_FAILURE_AUTHORIZATION) {
    throw errorWithCode('pre_acceptance_proof_required', 'recognized pre-acceptance failure authorization is required');
  }
  const evidence = options.preAcceptanceFailure;
  if (!evidence || typeof evidence !== 'object') {
    throw errorWithCode('pre_acceptance_proof_invalid', 'pre-acceptance failure evidence is required');
  }
  if (evidence.command_id == null || evidence.command_id !== before.command_id) {
    throw errorWithCode('pre_acceptance_proof_invalid', 'pre-acceptance failure evidence is not bound to this command');
  }
  const allowedEvidenceKeys = new Set(['command_id', 'phase', 'failure_code', 'accepted', 'queue_id']);
  if (Object.keys(evidence).some((key) => !allowedEvidenceKeys.has(key))) {
    throw errorWithCode('pre_acceptance_proof_invalid', 'pre-acceptance failure evidence contains unsupported fields');
  }
  if (evidence.phase !== 'pre_acceptance' || !PRE_ACCEPTANCE_FAILURE_CODES.has(evidence.failure_code)
      || evidence.accepted !== false || evidence.queue_id !== null || Object.prototype.hasOwnProperty.call(evidence, 'delivered')) {
    throw errorWithCode('pre_acceptance_proof_invalid', 'unsupported or ambiguous pre-acceptance failure evidence');
  }
  if (patch.decision_reason !== undefined && patch.decision_reason !== 'command_expired') {
    throw errorWithCode('invalid_expiry_reason', 'proven non-delivery must use command_expired');
  }
}

function assertAcceptanceMarkers(before, patch) {
  for (const column of ['queue_id', 'sent_at']) {
    if (!Object.prototype.hasOwnProperty.call(patch, column)) continue;
    if (before[column] != null && patch[column] !== before[column]) {
      throw errorWithCode('acceptance_marker_immutable', `${column} cannot be cleared or changed after acceptance`);
    }
  }
  if (patch.state !== 'EXPIRED') return;
  const queueId = Object.prototype.hasOwnProperty.call(patch, 'queue_id') ? patch.queue_id : before.queue_id;
  const sentAt = Object.prototype.hasOwnProperty.call(patch, 'sent_at') ? patch.sent_at : before.sent_at;
  if (queueId != null || sentAt != null) {
    throw errorWithCode('acceptance_marker_present', 'durable acceptance markers prevent pre-acceptance expiry');
  }
}

async function transitionOccurrenceTx(tx, keyOrRow, patch = {}, options = {}) {
  const before = await getOccurrenceTx(tx, keyOrRow);
  if (!before) throw errorWithCode('occurrence_not_found', 'occurrence does not exist');

  // A second ATTEMPTED request is always a replay, even if transport already
  // advanced the state. It never regains dispatch authority.
  if (patch.state === 'ATTEMPTED' && before.attempted_at != null) {
    return { changed: false, replayed: true, send: false, occurrence: before };
  }
  if (patch.state === 'EXPIRED' && (before.state === 'SENT' || before.state === 'UNKNOWN')) {
    throw errorWithCode('non_delivery_unavailable', 'v1 cannot prove non-delivery after acceptance');
  }
  if (patch.state && patch.state !== before.state && !TRANSITIONS[before.state].has(patch.state)) {
    throw errorWithCode('invalid_occurrence_transition', `${before.state} cannot transition to ${patch.state}`);
  }
  assertAcceptanceMarkers(before, patch);
  if (patch.state === 'EXPIRED' && before.state === 'ATTEMPTED') assertNonDeliveryProof(options, patch, before);
  if (patch.state === 'EXPIRED' && before.state === 'RESERVED' && patch.decision_reason !== undefined && patch.decision_reason !== 'command_expired') {
    throw errorWithCode('invalid_expiry_reason', 'reserved expiry must use command_expired');
  }
  if (patch.state === 'ATTEMPTED' && before.state !== 'RESERVED') {
    throw errorWithCode('invalid_occurrence_transition', `${before.state} cannot transition to ATTEMPTED`);
  }
  if (patch.decision_at != null) assertInstant(patch.decision_at, 'decision_at');

  const frozen = new Set(OCCURRENCE_IDENTITY_COLUMNS.concat(OCCURRENCE_SNAPSHOT_COLUMNS));
  const identityPatch = Object.keys(patch).filter((column) => frozen.has(column) && OCCURRENCE_IDENTITY_COLUMNS.includes(column));
  if (identityPatch.length) throw errorWithCode('occurrence_identity_immutable', 'occurrence identity and revisions are immutable');

  const snapshotPatch = Object.keys(patch).filter((column) => OCCURRENCE_SNAPSHOT_COLUMNS.includes(column));
  const canEditSnapshot = before.state === 'PENDING' || before.state === 'CLAIMED';
  const expiryReasonOnly = patch.state === 'EXPIRED' && (before.state === 'RESERVED' || before.state === 'ATTEMPTED');
  for (const column of snapshotPatch) {
    if (!canEditSnapshot && !(expiryReasonOnly && column === 'decision_reason')) {
      throw errorWithCode(column === 'decision_evidence_json' ? 'decision_evidence_immutable' : 'occurrence_snapshot_immutable', `${column} is immutable after decision or reservation`);
    }
  }
  if (patch.state === 'EXPIRED' && expiryReasonOnly) {
    if (patch.decision_reason === undefined) patch = { ...patch, decision_reason: 'command_expired' };
  }

  const columns = [];
  const values = [];
  for (const column of OCCURRENCE_SNAPSHOT_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(patch, column)) {
      columns.push(column); values.push(noUndefined(patch[column]));
    }
  }
  for (const column of OCCURRENCE_TRANSPORT_COLUMNS) {
    if (Object.prototype.hasOwnProperty.call(patch, column)) {
      if (!OBSERVATION_COLUMNS.includes(column) && column === 'updated_at') continue;
      columns.push(column); values.push(noUndefined(patch[column]));
    }
  }

  if (patch.state === 'ATTEMPTED') {
    const attemptedAt = patch.attempted_at || options.now || new Date().toISOString();
    assertInstant(attemptedAt, 'attempted_at');
    columns.push('attempted_at', 'state'); values.push(attemptedAt, 'ATTEMPTED');
  } else if (patch.state !== undefined) {
    columns.push('state'); values.push(patch.state);
  }
  if (columns.length) {
    const now = patch.updated_at || new Date().toISOString();
    columns.push('updated_at'); values.push(now);
    await tx.run(`UPDATE irrigation_occurrences SET ${columns.map((column) => `${column}=?`).join(',')} WHERE schedule_uuid=? AND local_date=? AND local_time=?`, values.concat([before.schedule_uuid, before.local_date, before.local_time]));
  }
  const after = await getOccurrenceTx(tx, before);
  return {
    changed: columns.length > 0,
    replayed: false,
    send: patch.state === 'ATTEMPTED',
    occurrence: after,
  };
}

async function transitionOccurrence(db, keyOrRow, patch, options) {
  return db.transaction((tx) => transitionOccurrenceTx(tx, keyOrRow, patch, options));
}

async function updateRuntimeStateTx(tx, patch = {}) {
  const current = await tx.get('SELECT * FROM irrigation_runtime_state WHERE singleton_id=1');
  const next = {
    last_trusted_tick_at: current ? current.last_trusted_tick_at : null,
    last_decided_due_at: current ? current.last_decided_due_at : null,
  };
  for (const column of RUNTIME_COLUMNS) {
    if (!Object.prototype.hasOwnProperty.call(patch, column) || patch[column] == null) continue;
    assertInstant(patch[column], column);
    if (!next[column] || parseInstant(patch[column]) > parseInstant(next[column])) next[column] = patch[column];
  }
  const now = patch.updated_at || new Date().toISOString();
  if (current) await tx.run('UPDATE irrigation_runtime_state SET last_trusted_tick_at=?, last_decided_due_at=?, updated_at=? WHERE singleton_id=1', [next.last_trusted_tick_at, next.last_decided_due_at, now]);
  else await tx.run('INSERT INTO irrigation_runtime_state(singleton_id,last_trusted_tick_at,last_decided_due_at,updated_at) VALUES (1,?,?,?)', [next.last_trusted_tick_at, next.last_decided_due_at, now]);
  return tx.get('SELECT * FROM irrigation_runtime_state WHERE singleton_id=1');
}

async function updateRuntimeState(db, patch) { return db.transaction((tx) => updateRuntimeStateTx(tx, patch)); }

async function getRuntimeState(db) {
  const row = await db.get('SELECT * FROM irrigation_runtime_state WHERE singleton_id=1');
  return row || { singleton_id: 1, last_trusted_tick_at: null, last_decided_due_at: null, updated_at: null };
}

// R17-M1 / D18 (VWC as a control input waits for the owner): the edge gate for VWC-condition
// policies, app_settings key conditional_irrigation_vwc_enabled. Default OFF: absent, unreadable or
// any value other than 1/true/yes/on is off (fail closed). Same semantics as the cloud flag
// conditional-irrigation.vwc-condition-enabled (default false).
const VWC_CONDITION_SETTING_KEY = 'conditional_irrigation_vwc_enabled';
async function vwcConditionEnabled(db) {
  let value = null;
  try {
    const row = await db.get('SELECT value FROM app_settings WHERE key = ?', [VWC_CONDITION_SETTING_KEY]);
    value = row ? row.value : null;
  } catch (_) {
    return false;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value == null ? '' : value).trim().toLowerCase());
}

function isVwcCondition(condition) {
  return Boolean(condition) && String(condition.kind || '').toUpperCase() === 'VWC';
}

module.exports = {
  VWC_CONDITION_SETTING_KEY, vwcConditionEnabled, isVwcCondition,
  PRE_ACCEPTANCE_FAILURE_AUTHORIZATION,
  getPolicy, getPolicyTx, upsertPolicy, upsertPolicyTx,
  getOccurrence: async (db, key) => {
    const k = occurrenceKey(key);
    return db.get('SELECT * FROM irrigation_occurrences WHERE schedule_uuid=? AND local_date=? AND local_time=?', [k.schedule_uuid, k.local_date, k.local_time]);
  },
  getOccurrenceTx, insertOccurrence, insertOccurrenceTx, claimOccurrence, claimOccurrenceTx,
  transitionOccurrence, transitionOccurrenceTx, updateRuntimeState, updateRuntimeStateTx, getRuntimeState,
};
