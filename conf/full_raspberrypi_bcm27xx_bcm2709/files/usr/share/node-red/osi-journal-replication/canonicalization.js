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

function fixedNumber(value) {
  if (!Number.isFinite(value)) throw new TypeError('canonical JSON forbids non-finite numbers');
  if (Object.is(value, -0) || value === 0) return '0';
  const text = String(value);
  if (!/[eE]/.test(text)) return text;
  const [coefficient, exponentText] = text.toLowerCase().split('e');
  const negative = coefficient.startsWith('-');
  const unsigned = negative ? coefficient.slice(1) : coefficient;
  const digits = unsigned.replace('.', '');
  const fraction = unsigned.includes('.') ? unsigned.length - unsigned.indexOf('.') - 1 : 0;
  const power = Number(exponentText) - fraction;
  let fixed;
  if (power >= 0) fixed = digits + '0'.repeat(power);
  else if (digits.length + power > 0) fixed = digits.slice(0, digits.length + power) + '.' + digits.slice(digits.length + power);
  else fixed = '0.' + '0'.repeat(-(digits.length + power)) + digits;
  return (negative ? '-' : '') + fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return fixedNumber(value);
  if (typeof value === 'string') return JSON.stringify(normalizeString(value));
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  if (!value || typeof value !== 'object') throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
  return '{' + Object.keys(value).sort().map((key) => {
    if (value[key] === undefined) throw new TypeError(`canonical JSON forbids undefined at ${key}`);
    return JSON.stringify(key) + ':' + canonicalize(value[key]);
  }).join(',') + '}';
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
