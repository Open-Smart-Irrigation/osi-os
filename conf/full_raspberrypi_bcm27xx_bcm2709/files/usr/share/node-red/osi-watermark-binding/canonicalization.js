'use strict';

const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A gateway-local actor may also be 32 lower-case hex digits (users.user_uuid
// of the first admin and backfilled users); that form is kept unchanged.
const LOCAL_HEX_ACTOR = /^[0-9a-f]{32}$/;
const EUI = /^[0-9a-f]{16}$/i;
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})$/;
const EUI_FIELDS = new Set(['device_eui', 'gateway_device_eui']);
const UUID_FIELDS = new Set(['actor_user_uuid', 'command_id', 'user_uuid']);
const INSTANT_FIELDS = new Set(['created_at', 'deleted_at', 'measured_at', 'recorded_at', 'requested_at', 'updated_at']);
const HEX = '0123456789abcdef';

function fixedNumber(value) {
  if (!Number.isFinite(value)) throw new TypeError('protected binding forbids non-finite numbers');
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

function assertCalendarTimestamp(value, field) {
  const match = ISO.exec(value);
  if (!match) throw new TypeError(`protected binding ${field} must be an ISO instant`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[8] === 'Z' ? 0 : Number(match[8].replace(':', '').slice(0, 3)) * 60 + Number(match[8].replace(':', '').slice(3));
  const offsetMinutes = match[8] === 'Z' ? 0 : (match[8][0] === '+' ? offset : -offset);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59 || Math.abs(offsetMinutes) > 14 * 60 || Number.isNaN(Date.parse(value))) {
    throw new TypeError(`protected binding ${field} must be a valid ISO instant`);
  }
  return new Date(value).toISOString();
}

function typedString(value, field) {
  if (EUI_FIELDS.has(field)) {
    if (!EUI.test(value)) throw new TypeError(`protected binding ${field} must be an EUI64`);
    return value.toUpperCase();
  }
  if (field === 'actor_user_uuid' && LOCAL_HEX_ACTOR.test(value)) return value;
  if (UUID_FIELDS.has(field)) {
    if (!UUID.test(value)) throw new TypeError(`protected binding ${field} must be a UUID`);
    return value.toLowerCase();
  }
  if (INSTANT_FIELDS.has(field)) return assertCalendarTimestamp(value, field);
  return value;
}

function jsonString(value) {
  let result = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x08) result += '\\b';
    else if (code === 0x09) result += '\\t';
    else if (code === 0x0a) result += '\\n';
    else if (code === 0x0c) result += '\\f';
    else if (code === 0x0d) result += '\\r';
    else if (code === 0x22) result += '\\"';
    else if (code === 0x5c) result += '\\\\';
    else if (code <= 0x1f) result += `\\u00${HEX[(code >>> 4) & 0xf]}${HEX[code & 0xf]}`;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) result += value[index++] + value[index];
      else result += `\\u${HEX[(code >>> 12) & 0xf]}${HEX[(code >>> 8) & 0xf]}${HEX[(code >>> 4) & 0xf]}${HEX[code & 0xf]}`;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      result += `\\u${HEX[(code >>> 12) & 0xf]}${HEX[(code >>> 8) & 0xf]}${HEX[(code >>> 4) & 0xf]}${HEX[code & 0xf]}`;
    } else result += value[index];
  }
  return result + '"';
}

function canonicalize(value, field = null) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return fixedNumber(value);
  if (typeof value === 'string') return jsonString(typedString(value, field));
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalize(item)).join(',') + ']';
  if (!value || typeof value !== 'object') throw new TypeError(`protected binding cannot encode ${typeof value}`);
  return '{' + Object.keys(value).sort().map((key) => {
    if (value[key] === undefined) throw new TypeError(`protected binding forbids undefined at ${key}`);
    return jsonString(key) + ':' + canonicalize(value[key], key);
  }).join(',') + '}';
}

function sha256(value) {
  return crypto.createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

module.exports = {canonicalize, sha256};
