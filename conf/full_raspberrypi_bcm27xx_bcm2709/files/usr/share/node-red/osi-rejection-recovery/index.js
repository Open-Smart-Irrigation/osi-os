'use strict';

const crypto = require('node:crypto');

const MAX_EVENT_UUIDS = 100;
const REPAIRABLE_REJECTION_CODE = 'ownership_precondition_missing';
const REPAIRABLE_REJECTION_CLASS = 'REPAIRABLE';
const RECOVERY_OUTCOMES = new Set(['APPLIED', 'ALREADY_APPLIED']);
const REJECTION_POLICY = Object.freeze({
  ownership_precondition_missing: 'REPAIRABLE',
  parent_missing: 'RETRYABLE',
  ownership_mismatch: 'PERMANENT',
  missing_event_uuid: 'PERMANENT',
  unknown_op: 'PERMANENT',
  invalid_payload: 'PERMANENT',
  integrity_violation: 'PERMANENT',
  stale_sync_version: 'PERMANENT',
  equal_version_payload_conflict: 'PERMANENT',
  irrigation_event_identity_collision: 'PERMANENT',
});
const SHA256 = /^[0-9a-f]{64}$/i;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseEventUuidList(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('at least one exact event UUID is required');
  }
  if (values.length > MAX_EVENT_UUIDS) {
    throw new Error(`at most ${MAX_EVENT_UUIDS} event UUIDs may be supplied`);
  }
  const seen = new Set();
  return values.map((value) => {
    const uuid = String(value == null ? '' : value).trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(uuid)) {
      throw new Error(`invalid exact event UUID: ${uuid || '<empty>'}`);
    }
    if (seen.has(uuid)) throw new Error(`duplicate event UUID: ${uuid}`);
    seen.add(uuid);
    return uuid;
  });
}

function requireObject(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`);
}

function validateReceipt(receipt, expected) {
  requireObject(receipt, 'receipt');
  requireObject(expected, 'expected row identity');
  const request = requireObject(receipt.cloudReplayRequest || receipt.request, 'cloudReplayRequest');
  const response = requireObject(receipt.cloudReplayResponse || receipt.response, 'cloudReplayResponse');
  requireString(request.eventUuid, 'cloudReplayRequest.eventUuid');
  requireString(request.expectedGatewayEui, 'cloudReplayRequest.expectedGatewayEui');
  requireString(request.expectedReason, 'cloudReplayRequest.expectedReason');
  requireString(response.eventUuid, 'cloudReplayResponse.eventUuid');
  requireString(response.outcome, 'cloudReplayResponse.outcome');
  requireString(response.reason, 'cloudReplayResponse.reason', { nullable: true });
  requireString(response.attemptedAt, 'cloudReplayResponse.attemptedAt');
  if (!Number.isSafeInteger(response.replayAttemptCount) || response.replayAttemptCount < 0) {
    throw new Error('cloudReplayResponse.replayAttemptCount must be a nonnegative integer');
  }
  if (!ISO_TIMESTAMP.test(response.attemptedAt) || Number.isNaN(Date.parse(response.attemptedAt))) {
    throw new Error('cloudReplayResponse.attemptedAt must be an ISO timestamp');
  }
  if (!RECOVERY_OUTCOMES.has(response.outcome)) {
    throw new Error(`cloudReplayResponse.outcome is not recoverable: ${response.outcome}`);
  }
  if (request.eventUuid !== expected.eventUuid || response.eventUuid !== expected.eventUuid) {
    throw new Error('receipt eventUuid does not match the selected outbox row');
  }
  if (String(request.expectedGatewayEui).trim().toUpperCase() !== String(expected.gatewayDeviceEui || '').trim().toUpperCase()) {
    throw new Error('receipt expectedGatewayEui does not match the selected outbox row');
  }
  if (request.expectedReason !== (expected.rejectionCode || REPAIRABLE_REJECTION_CODE)) {
    throw new Error('receipt expectedReason does not match the selected rejection code');
  }
  if ((expected.rejectionCode || REPAIRABLE_REJECTION_CODE) !== REPAIRABLE_REJECTION_CODE ||
      (expected.rejectionClass || REPAIRABLE_REJECTION_CLASS) !== REPAIRABLE_REJECTION_CLASS) {
    throw new Error('outbox row is not owned by the fixed repairable rejection policy');
  }
  return receipt;
}

function assertPayloadObject(payloadJson) {
  if (typeof payloadJson !== 'string' || payloadJson.trim() === '') {
    throw new Error('outbox payload_json is empty');
  }
  let payload;
  try { payload = JSON.parse(payloadJson); } catch (error) {
    throw new Error(`outbox payload_json is invalid JSON: ${error.message}`);
  }
  if (!isPlainObject(payload)) throw new Error('outbox payload_json must decode to an object');
  return payload;
}

function envelopeSha256(row, payload) {
  const envelope = {
    eventUuid: row.event_uuid,
    aggregateType: row.aggregate_type,
    aggregateKey: row.aggregate_key,
    op: row.op,
    syncVersion: row.sync_version,
    occurredAt: row.occurred_at,
    payload,
  };
  return crypto.createHash('sha256').update(canonicalJson(envelope)).digest('hex');
}

function validateEnvelopeSha256(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error('envelope SHA256 is invalid');
}

function classifyRejection(result) {
  const code = String(result && (result.rejectionCode || result.rejection_code) || '').trim();
  const rejectionClass = String(result && (result.rejectionClass || result.rejection_class) || '').trim().toUpperCase();
  const expectedClass = REJECTION_POLICY[code];
  const recognized = Boolean(code && expectedClass && expectedClass === rejectionClass &&
    (rejectionClass === 'REPAIRABLE' || rejectionClass === 'PERMANENT'));
  return {
    recognized,
    code: recognized ? code : 'LEGACY_UNCLASSIFIED',
    rejectionClass: recognized ? rejectionClass : 'LEGACY_UNCLASSIFIED',
    eligible: recognized && rejectionClass === 'REPAIRABLE',
  };
}

function validateRecoverableRow(row, eventUuid) {
  if (!row) throw new Error(`event UUID not found: ${eventUuid}`);
  for (const [field, label] of [['event_uuid', 'event_uuid'], ['aggregate_type', 'aggregate_type'], ['aggregate_key', 'aggregate_key'], ['op', 'op'], ['occurred_at', 'occurred_at'], ['gateway_device_eui', 'gateway_device_eui']]) {
    if (typeof row[field] !== 'string' || row[field].trim() === '') throw new Error(`${label} must be a non-empty string`);
  }
  if (String(row.event_uuid) !== String(eventUuid) || !Number.isFinite(Number(row.sync_version)) || Number(row.sync_version) < 0) {
    throw new Error(`event ${eventUuid} has an incomplete outbox envelope`);
  }
  if (row.delivered_at !== null) throw new Error(`event ${eventUuid} is already delivered`);
  if (row.rejected_at === null) throw new Error(`event ${eventUuid} is not rejected`);
  if (row.rejection_code !== REPAIRABLE_REJECTION_CODE ||
      row.rejection_class !== REPAIRABLE_REJECTION_CLASS) {
    throw new Error(`event ${eventUuid} does not have the fixed repairable rejection policy`);
  }
  if (Number(row.recovery_generation || 0) !== 0) {
    throw new Error(`event ${eventUuid} has already consumed recovery generation ${row.recovery_generation}`);
  }
  return assertPayloadObject(row.payload_json);
}

async function recoverOutbox({ Database, dbPath = '/data/db/farming.db', eventUuids: values, receipts: receiptValues, execute = false, actor = 'admin', warn = () => {} }) {
  if (typeof Database !== 'function') throw new Error('database helper unavailable');
  const eventUuids = parseEventUuidList(values);
  if (!Array.isArray(receiptValues)) throw new Error('receipts must be an array of complete receipt objects');
  const receipts = new Map();
  for (const receipt of receiptValues) {
    const request = receipt && (receipt.cloudReplayRequest || receipt.request);
    const eventUuid = String(request && request.eventUuid || '').trim();
    if (!eventUuid || receipts.has(eventUuid)) throw new Error('receipts must contain one complete receipt per selected event UUID');
    receipts.set(eventUuid, receipt);
  }
  if (receipts.size !== eventUuids.length || eventUuids.some((eventUuid) => !receipts.has(eventUuid))) {
    throw new Error('receipts must exactly cover the selected event UUIDs');
  }
  const db = new Database(dbPath);
  const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || [])));
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function onRun(error) { error ? reject(error) : resolve(this); }));
  const close = () => new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
  let committed = false;
  try {
    await run('BEGIN IMMEDIATE');
    const placeholders = eventUuids.map(() => '?').join(',');
    const rows = await all('SELECT event_uuid, aggregate_type, aggregate_key, op, payload_json, sync_version, occurred_at, gateway_device_eui, delivered_at, rejected_at, rejection_reason, rejection_code, rejection_class, recovery_generation FROM sync_outbox WHERE event_uuid IN (' + placeholders + ')', eventUuids);
    const byUuid = new Map(rows.map((row) => [String(row.event_uuid), row]));
    const validated = [];
    for (const eventUuid of eventUuids) {
      const row = byUuid.get(eventUuid);
      const payload = validateRecoverableRow(row, eventUuid);
      const receipt = receipts.get(eventUuid);
      validateReceipt(receipt, { eventUuid, gatewayDeviceEui: row.gateway_device_eui, rejectionCode: row.rejection_code, rejectionClass: row.rejection_class });
      const envelopeSha256 = envelopeSha256ForRow(row, payload);
      validateEnvelopeSha256(envelopeSha256);
      validated.push({ eventUuid, row, receipt, envelopeSha256 });
    }
    const summaryRows = validated.map(({ eventUuid, row }) => ({ eventUuid, generationBefore: Number(row.recovery_generation || 0), eligible: true }));
    if (!execute) {
      await run('ROLLBACK');
      await close();
      return { dryRun: true, execute: false, selected: validated.length, changed: 0, rows: summaryRows };
    }
    const attemptedAt = new Date().toISOString();
    for (const item of validated) {
      await run('INSERT INTO sync_outbox_recovery_audit (event_uuid, generation, actor, attempted_at, previous_rejection_code, previous_rejection_class, previous_rejection_reason, envelope_sha256, receipt_json) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)', [item.eventUuid, actor, attemptedAt, item.row.rejection_code, item.row.rejection_class, item.row.rejection_reason, item.envelopeSha256, JSON.stringify(item.receipt)]);
      const result = await run('UPDATE sync_outbox SET rejected_at = NULL, rejection_reason = NULL, rejection_code = NULL, rejection_class = NULL, last_retryable_failure_at = NULL, retry_count = 0, recovery_generation = 1 WHERE event_uuid = ? AND delivered_at IS NULL AND rejected_at IS NOT NULL AND rejection_code = ? AND rejection_class = ? AND COALESCE(recovery_generation, 0) = 0', [item.eventUuid, REPAIRABLE_REJECTION_CODE, REPAIRABLE_REJECTION_CLASS]);
      if (!result || Number(result.changes || 0) !== 1) throw new Error('event changed while recovery was running: ' + item.eventUuid);
    }
    await run('COMMIT');
    committed = true;
    await close();
    return { dryRun: false, execute: true, selected: validated.length, changed: validated.length, rows: summaryRows };
  } catch (error) {
    if (!committed) {
      try { await run('ROLLBACK'); } catch (rollbackError) { warn('rejection recovery rollback failed: ' + String(rollbackError && rollbackError.message || rollbackError)); }
    }
    try { await close(); } catch (closeError) { warn('rejection recovery close failed: ' + String(closeError && closeError.message || closeError)); }
    throw error;
  }
}

function envelopeSha256ForRow(row, payload) {
  return envelopeSha256(row, payload);
}

module.exports = {
  MAX_EVENT_UUIDS,
  REPAIRABLE_REJECTION_CODE,
  REPAIRABLE_REJECTION_CLASS,
  RECOVERY_OUTCOMES,
  REJECTION_POLICY,
  canonicalJson,
  parseEventUuidList,
  validateReceipt,
  assertPayloadObject,
  envelopeSha256,
  validateEnvelopeSha256,
  classifyRejection,
  validateRecoverableRow,
  recoverOutbox,
};
