'use strict';

const crypto = require('node:crypto');

const MAX_AGGREGATE_BYTES = 256 * 1024;
const ENTRY_LOCAL_FIELDS = new Set(['id', 'rowid', 'user_id', 'zone_id', 'values']);
const VALUE_LOCAL_FIELDS = new Set(['id', 'rowid', 'entry_uuid']);
const UUID = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;
const EUI64 = /^[0-9a-fA-F]{16}$/;
const EUI48 = /^[0-9a-fA-F]{12}$/;
const ISO_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):?(\d{2}))$/;

function aggregateError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function invalidAggregate(message) {
  throw aggregateError('invalid_aggregate', message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function defineJsonField(target, key, value) {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

function assertWellFormedString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) {
        invalidAggregate('Strings must not contain unpaired UTF-16 surrogates');
      }
      index += 1;
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      invalidAggregate('Strings must not contain unpaired UTF-16 surrogates');
    }
  }
}

function cloneJson(value, ancestors, arrayElement) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    assertWellFormedString(value);
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalidAggregate('Numbers must be finite');
    return Object.is(value, -0) ? 0 : value;
  }
  if (value === undefined) {
    if (arrayElement) invalidAggregate('Array elements must not be undefined or sparse');
    return undefined;
  }
  if (typeof value !== 'object') {
    invalidAggregate('Only JSON values are supported');
  }
  if (ancestors.has(value)) invalidAggregate('Cyclic values are not supported');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype ||
          Object.getOwnPropertySymbols(value).length > 0) {
        invalidAggregate('Arrays must use the standard JSON shape');
      }
      const keys = Object.keys(value);
      if (keys.length !== value.length) invalidAggregate('Arrays must be dense without extra fields');
      const output = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          invalidAggregate('Array elements must not be undefined or sparse');
        }
        output.push(cloneJson(value[index], ancestors, true));
      }
      return output;
    }
    if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length > 0) {
      invalidAggregate('Objects must be plain JSON objects with string keys');
    }
    const output = {};
    for (const key of Object.keys(value)) {
      assertWellFormedString(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        invalidAggregate('Object properties must be enumerable data fields');
      }
      const cloned = cloneJson(descriptor.value, ancestors, false);
      if (cloned !== undefined) defineJsonField(output, key, cloned);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}

function canonicalUuid(raw) {
  const hex = raw.replace(/-/g, '').toLowerCase();
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' + hex.slice(20);
}

function daysInMonth(year, month) {
  if (month === 2) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function canonicalTimestamp(raw) {
  const match = ISO_OFFSET.exec(raw);
  if (!match) invalidAggregate('Timestamp must be a complete ISO-8601 offset value');
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) ||
      hour > 23 || minute > 59 || second > 59) {
    invalidAggregate('Timestamp contains an invalid calendar or clock value');
  }
  const offsetHour = match[10] == null ? 0 : Number(match[10]);
  const offsetMinute = match[11] == null ? 0 : Number(match[11]);
  if (offsetHour > 18 || offsetMinute > 59 || (offsetHour === 18 && offsetMinute !== 0)) {
    invalidAggregate('Timestamp contains an invalid UTC offset');
  }
  const milliseconds = Number(((match[7] || '') + '000').slice(0, 3));
  const instant = new Date(0);
  instant.setUTCFullYear(year, month - 1, day);
  instant.setUTCHours(hour, minute, second, milliseconds);
  const direction = match[9] === '-' ? -1 : 1;
  const offsetMs = direction * (offsetHour * 60 + offsetMinute) * 60 * 1000;
  const canonical = new Date(instant.getTime() - offsetMs).toISOString();
  if (!/^\d{4}-\d{2}-\d{2}T/.test(canonical)) {
    invalidAggregate('Timestamp falls outside the four-digit canonical year range');
  }
  return canonical;
}

function normalizeString(value) {
  if (UUID.test(value)) return canonicalUuid(value);
  if (EUI64.test(value)) return value.toUpperCase();
  if (EUI48.test(value)) {
    const upper = value.toUpperCase();
    return upper.slice(0, 6) + 'FFFE' + upper.slice(6);
  }
  if (ISO_OFFSET.test(value)) return canonicalTimestamp(value);
  return value;
}

function isUuidField(key) {
  return key === 'uuid' || key.endsWith('_uuid');
}

function isEuiField(key) {
  return key === 'eui' || key.endsWith('_eui');
}

function isTimestampField(key) {
  return key === 'timestamp' || key.endsWith('_at') ||
    key === 'occurred_start' || key === 'occurred_end';
}

function assertSemanticField(key, value) {
  if (value === null) return;
  if (isUuidField(key) && (typeof value !== 'string' || !UUID.test(value))) {
    invalidAggregate(key + ' must be a canonicalizable UUID');
  }
  if (isEuiField(key) &&
      (typeof value !== 'string' || (!EUI64.test(value) && !EUI48.test(value)))) {
    invalidAggregate(key + ' must be an EUI-48 or EUI-64');
  }
  if (isTimestampField(key)) {
    if (typeof value !== 'string' || !ISO_OFFSET.test(value)) {
      invalidAggregate(key + ' must be a complete ISO-8601 offset timestamp');
    }
    canonicalTimestamp(value);
  }
}

function escapeString(value) {
  let output = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22) output += '\\"';
    else if (code === 0x5C) output += '\\\\';
    else if (code === 0x08) output += '\\b';
    else if (code === 0x09) output += '\\t';
    else if (code === 0x0A) output += '\\n';
    else if (code === 0x0C) output += '\\f';
    else if (code === 0x0D) output += '\\r';
    else if (code < 0x20) output += '\\u' + code.toString(16).toUpperCase().padStart(4, '0');
    else output += value[index];
  }
  return output + '"';
}

function fixedNumber(value) {
  if (Object.is(value, -0) || value === 0) return '0';
  let text = String(value);
  if (!/[eE]/.test(text)) return text;
  const initialCoefficient = text.split(/[eE]/)[0].replace('-', '').replace('.', '');
  if (initialCoefficient.length === 1) text = value.toExponential(1);
  const parts = text.toLowerCase().split('e');
  const negative = parts[0][0] === '-';
  const coefficient = negative ? parts[0].slice(1) : parts[0];
  const exponent = Number(parts[1]);
  const point = coefficient.indexOf('.');
  const fractionalDigits = point === -1 ? 0 : coefficient.length - point - 1;
  const digits = coefficient.replace('.', '');
  const power = exponent - fractionalDigits;
  let fixed;
  if (power >= 0) fixed = digits + '0'.repeat(power);
  else if (digits.length + power > 0) {
    const split = digits.length + power;
    fixed = digits.slice(0, split) + '.' + digits.slice(split);
  } else {
    fixed = '0.' + '0'.repeat(-(digits.length + power)) + digits;
  }
  if (fixed.includes('.')) fixed = fixed.replace(/0+$/, '').replace(/\.$/, '');
  return (negative ? '-' : '') + fixed;
}

function canonicalSerialize(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return fixedNumber(value);
  if (typeof value === 'string') return escapeString(normalizeString(value));
  if (Array.isArray(value)) return '[' + value.map(canonicalSerialize).join(',') + ']';
  const fields = [];
  for (const key of Object.keys(value).sort()) {
    assertSemanticField(key, value[key]);
    fields.push(escapeString(key) + ':' + canonicalSerialize(value[key]));
  }
  return '{' + fields.join(',') + '}';
}

function canonicalText(value) {
  const detached = cloneJson(value, new Set(), false);
  if (detached === undefined) invalidAggregate('Aggregate root must be a JSON value');
  const serialized = canonicalSerialize(detached);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_AGGREGATE_BYTES) {
    throw aggregateError('aggregate_too_large', 'Canonical aggregate exceeds 256 KiB');
  }
  return serialized;
}

function codePointCompare(left, right) {
  let a = 0;
  let b = 0;
  while (a < left.length && b < right.length) {
    const leftCode = left.codePointAt(a);
    const rightCode = right.codePointAt(b);
    if (leftCode !== rightCode) return leftCode < rightCode ? -1 : 1;
    a += leftCode > 0xFFFF ? 2 : 1;
    b += rightCode > 0xFFFF ? 2 : 1;
  }
  return left.length - right.length;
}

function projectRow(row, excluded) {
  if (!isPlainObject(row)) invalidAggregate('Aggregate rows must be plain objects');
  if (Object.getOwnPropertySymbols(row).length > 0) {
    invalidAggregate('Aggregate rows must have only string keys');
  }
  const projected = {};
  for (const key of Object.keys(row)) {
    assertWellFormedString(key);
    const descriptor = Object.getOwnPropertyDescriptor(row, key);
    if (!descriptor || !descriptor.enumerable ||
        !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      invalidAggregate('Aggregate row fields must be enumerable data fields');
    }
    if (excluded.has(key)) continue;
    const cloned = cloneJson(descriptor.value, new Set(), false);
    if (cloned !== undefined) defineJsonField(projected, key, cloned);
  }
  return projected;
}

function buildAggregate(entryRow, valueRows) {
  const entry = projectRow(entryRow, ENTRY_LOCAL_FIELDS);
  if (typeof entry.entry_uuid !== 'string' || !UUID.test(entry.entry_uuid)) {
    invalidAggregate('entry_uuid is required and must be a UUID');
  }
  if (!Array.isArray(valueRows)) invalidAggregate('valueRows must be an array');
  const values = [];
  const cells = new Set();
  for (const row of valueRows) {
    if (!isPlainObject(row)) invalidAggregate('Value rows must be plain objects');
    const detachedRow = projectRow(row, new Set(['id', 'rowid']));
    if (detachedRow.entry_uuid != null) {
      if (typeof detachedRow.entry_uuid !== 'string' || !UUID.test(detachedRow.entry_uuid)) {
        invalidAggregate('Value row entry_uuid must be a UUID when present');
      }
      if (canonicalUuid(detachedRow.entry_uuid) !== canonicalUuid(entry.entry_uuid)) {
        invalidAggregate('Value row entry_uuid does not match the aggregate entry');
      }
    }
    const projected = {};
    for (const [key, value] of Object.entries(detachedRow)) {
      if (!VALUE_LOCAL_FIELDS.has(key)) defineJsonField(projected, key, value);
    }
    if (!Number.isSafeInteger(projected.group_index) || projected.group_index < 0) {
      invalidAggregate('group_index must be a nonnegative safe integer');
    }
    if (typeof projected.attribute_code !== 'string' || !projected.attribute_code.trim()) {
      invalidAggregate('attribute_code must be a nonempty string');
    }
    const cell = projected.group_index + '\u0000' + projected.attribute_code;
    if (cells.has(cell)) invalidAggregate('Duplicate aggregate value cell');
    cells.add(cell);
    values.push(projected);
  }
  values.sort(function(left, right) {
    return left.group_index - right.group_index ||
      codePointCompare(left.attribute_code, right.attribute_code);
  });
  const aggregate = {};
  for (const [key, value] of Object.entries(entry)) defineJsonField(aggregate, key, value);
  defineJsonField(aggregate, 'values', values);
  canonicalText(aggregate);
  return aggregate;
}

function aggregateHash(aggregateObj) {
  return crypto.createHash('sha256').update(canonicalText(aggregateObj), 'utf8').digest('hex');
}

module.exports = {
  aggregateHash,
  buildAggregate,
};
