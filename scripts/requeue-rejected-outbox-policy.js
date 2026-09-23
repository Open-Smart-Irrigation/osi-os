'use strict';

const crypto = require('node:crypto');

const MAX_EVENT_UUIDS = 100;
const REPAIRABLE_REJECTION_CODE = 'ownership_precondition_missing';
const REPAIRABLE_REJECTION_CLASS = 'REPAIRABLE';
const RECOVERY_OUTCOMES = new Set(['APPLIED', 'ALREADY_APPLIED']);
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
  if (!Number.isSafeInteger(response.replayAttemptCount) || response.replayAttemptCount < 1) {
    throw new Error('cloudReplayResponse.replayAttemptCount must be a positive integer');
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

module.exports = {
  MAX_EVENT_UUIDS,
  REPAIRABLE_REJECTION_CODE,
  REPAIRABLE_REJECTION_CLASS,
  RECOVERY_OUTCOMES,
  canonicalJson,
  parseEventUuidList,
  validateReceipt,
  assertPayloadObject,
  envelopeSha256,
  validateEnvelopeSha256,
};
