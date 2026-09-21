'use strict';
// osi-entity-name -- the edge implementation of the zone and device name rule
// (docs/superpowers/specs/2026-09-21-zone-device-rename-design.md, section 4)
// and of the writers that put a validated name on an existing row.
//
// Pure Node, no npm dependency: this file touches nothing but the database
// handle it is given, so the rule can be required from a REST handler, from a
// command receiver and from a test alike.

const MAX_CODE_POINTS = 100;

// The ECMAScript trim set: WhiteSpace plus LineTerminator, spelled out so the
// GUI copy and the cloud's Java class can be diffed against the same list.
// U+0085 is deliberately absent. It is category Cc, so it fails the control
// check below instead of being trimmed away.
const TRIM_CLASS = '\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF';
const TRIM_RE = new RegExp('^[' + TRIM_CLASS + ']+|[' + TRIM_CLASS + ']+$', 'g');

// Unicode categories Cc, Zl and Zp.
const CONTROL_RE = new RegExp('[\u0000-\u001F\u007F-\u009F\u2028\u2029]');

function nameError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

// String.prototype.isWellFormed landed in V8 11.0, and the gateway image ships
// a Node 20-era OpenWrt package whose exact build is not pinned anywhere in
// this repository. The scan is written by hand so the rule cannot depend on a
// runtime feature nobody has verified on a Pi.
function hasLoneSurrogate(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function normalizeEntityName(raw) {
  // An absent field is a missing name, not a broken one: a PUT body without a
  // `name` key answers name_empty, the same reason an empty string gets, so
  // the GUI shows one sentence for both. Any other non-string is a client that
  // sent the wrong type, and it gets the step-1 reason code.
  if (raw === null || raw === undefined) {
    throw nameError('name_empty', 'name is required');
  }
  if (typeof raw !== 'string') {
    throw nameError('name_invalid_unicode', 'name must be a string');
  }
  if (hasLoneSurrogate(raw)) {
    throw nameError('name_invalid_unicode', 'name contains a lone UTF-16 surrogate');
  }
  const trimmed = raw.replace(TRIM_RE, '');
  if (!trimmed) {
    throw nameError('name_empty', 'name must not be empty');
  }
  if (Array.from(trimmed).length > MAX_CODE_POINTS) {
    throw nameError(
      'name_too_long',
      'name must not exceed ' + MAX_CODE_POINTS + ' characters'
    );
  }
  if (CONTROL_RE.test(trimmed)) {
    throw nameError('name_control_characters', 'name must not contain control characters');
  }
  return trimmed;
}

module.exports = {
  ENTITY_NAME_MAX: MAX_CODE_POINTS,
  normalizeEntityName,
};
