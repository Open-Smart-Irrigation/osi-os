'use strict';

const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const EUI = /^[0-9a-f]{16}$/i;

function normalizeString(value) {
  if (UUID.test(value)) return value.toLowerCase();
  if (EUI.test(value)) return value.toUpperCase();
  if (ISO.test(value)) {
    const date = new Date(value);
    if (!Number.isNaN(date.valueOf())) return date.toISOString();
  }
  return value;
}

function normalize(value) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return normalizeString(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonical JSON forbids non-finite numbers');
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw new TypeError(`canonical JSON forbids undefined at ${key}`);
    result[key] = normalize(value[key]);
  }
  return result;
}

function canonicalize(value) {
  return JSON.stringify(normalize(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

function hashEnvelope(envelope) {
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new TypeError('envelope must be an object');
  const { payload_sha256, ...hashInput } = envelope;
  return sha256(hashInput);
}

module.exports = { canonicalize, sha256, hashMutation: hashEnvelope, hashReplication: hashEnvelope };
