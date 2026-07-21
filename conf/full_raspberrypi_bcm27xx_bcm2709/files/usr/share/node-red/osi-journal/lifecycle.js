'use strict';

const crypto = require('node:crypto');
const { aggregateHash, buildAggregate } = require('./aggregate');
const { buildContext } = require('./context');
const { validateEntry } = require('./index');

const ENTRY_COLUMNS = [
  'entry_uuid',
  'owner_user_uuid',
  'user_id',
  'author_principal_uuid',
  'author_label',
  'plot_uuid',
  'zone_id',
  'zone_uuid',
  'device_eui',
  'season_uuid',
  'season_crop',
  'season_variety',
  'campaign_uuid',
  'protocol_code',
  'protocol_version',
  'observation_unit_code',
  'pass_uuid',
  'batch_uuid',
  'activity_code',
  'template_code',
  'template_version',
  'layout_code',
  'layout_version',
  'catalog_version',
  'occurred_start',
  'occurred_end',
  'occurred_timezone',
  'occurred_utc_offset_minutes',
  'recorded_at',
  'origin',
  'status',
  'voided_at',
  'voided_by_principal_uuid',
  'void_reason',
  'note',
  'context_json',
  'sync_version',
  'gateway_device_eui',
  'created_at',
  'updated_at',
  'deleted_at',
];
const CORRECTION_IMMUTABLE_COLUMNS = new Set([
  'entry_uuid',
  'owner_user_uuid',
  'user_id',
  'author_principal_uuid',
  'author_label',
  'recorded_at',
  'origin',
  'created_at',
  'deleted_at',
]);
const CORRECTION_COLUMNS = ENTRY_COLUMNS.filter(function(column) {
  return !CORRECTION_IMMUTABLE_COLUMNS.has(column);
});
const UUID = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INPUT_UUID_FIELDS = [
  'entry_uuid', 'plot_uuid', 'campaign_uuid', 'pass_uuid', 'batch_uuid', 'cycle_uuid',
];
const EUI64 = /^[0-9a-fA-F]{16}$/;
const LOCAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const formatterCache = new Map();
const BATCH_INTENT_FIELDS = [
  'status',
  'activity_code',
  'template_code',
  'template_version',
  'layout_code',
  'layout_version',
  'occurred_start_local',
  'occurred_end_local',
  'occurred_timezone',
  'occurred_utc_offset_minutes',
  'occurred_end_utc_offset_minutes',
  'device_eui',
  'season_crop',
  'season_variety',
  'campaign_uuid',
  'protocol_code',
  'protocol_version',
  'observation_unit_code',
  'pass_uuid',
  'note',
  'values',
];

function lifecycleError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function entryValidationError(message, validation) {
  const errors = validation && Array.isArray(validation.errors) ? validation.errors : [];
  const missingCustomDependency = errors.some(function(error) {
    return error && error.code === 'missing_custom_dependency';
  });
  const error = lifecycleError(
    missingCustomDependency ? 'missing_custom_dependency' : 'validation_failed',
    message
  );
  error.errors = errors;
  return error;
}

function nullable(value) {
  return value == null ? null : value;
}

function validateRequestLimit(input) {
  let encoded;
  try {
    encoded = JSON.stringify(input);
  } catch (_) {
    throw lifecycleError('invalid_json', 'Journal request must be JSON-serializable');
  }
  if (encoded === undefined) {
    throw lifecycleError('invalid_json', 'Journal request must be JSON-serializable');
  }
  if (Buffer.byteLength(encoded, 'utf8') > 256 * 1024) {
    throw lifecycleError('limit_exceeded', 'Journal request exceeds the 256 KiB limit');
  }
}

function canonicalUuid(raw) {
  const hex = raw.replace(/-/g, '').toLowerCase();
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' + hex.slice(20);
}

function normalizeUuid(raw, field, required) {
  if (raw == null) {
    if (required) throw lifecycleError('invalid_uuid', field + ' must be a UUID');
    return raw;
  }
  if (typeof raw !== 'string' || !UUID.test(raw)) {
    throw lifecycleError('invalid_uuid', field + ' must be a UUID');
  }
  return canonicalUuid(raw);
}

function normalizeInputIdentities(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw lifecycleError('invalid_type', 'Journal entry must be an object');
  }
  const normalized = Object.assign({}, input);
  for (const field of INPUT_UUID_FIELDS) {
    normalized[field] = normalizeUuid(normalized[field], field, false);
  }
  return normalized;
}

function normalizeBatchMembers(members) {
  if (!Array.isArray(members) || members.length === 0) {
    throw lifecycleError('invalid_batch', 'Batch members must be a nonempty array');
  }
  if (members.length > 100) {
    throw lifecycleError('batch_too_large', 'A journal batch may contain at most 100 members');
  }
  const normalized = members.map(function(member, index) {
    if (!member || typeof member !== 'object' || Array.isArray(member)) {
      throw lifecycleError('invalid_batch', 'Batch member ' + index + ' must be an object');
    }
    if (typeof member.plot_uuid !== 'string' || !CANONICAL_UUID.test(member.plot_uuid) ||
        typeof member.entry_uuid !== 'string' || !CANONICAL_UUID.test(member.entry_uuid)) {
      throw lifecycleError('invalid_uuid', 'Batch member UUIDs must be canonical');
    }
    return {
      plot_uuid: member.plot_uuid,
      entry_uuid: member.entry_uuid,
    };
  });
  if (new Set(normalized.map(function(member) { return member.plot_uuid; })).size !== normalized.length ||
      new Set(normalized.map(function(member) { return member.entry_uuid; })).size !== normalized.length) {
    throw lifecycleError('duplicate_member', 'Batch member plot and entry UUIDs must be unique');
  }
  return normalized;
}

function parseLocalTimestamp(raw) {
  const match = typeof raw === 'string' ? LOCAL_TIMESTAMP.exec(raw) : null;
  if (!match) throw lifecycleError('invalid_local_time', 'Local time must use YYYY-MM-DDTHH:mm');
  const fields = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] || 0),
    millisecond: Number((match[7] || '').padEnd(3, '0')),
  };
  const probe = new Date(0);
  probe.setUTCFullYear(fields.year, fields.month - 1, fields.day);
  probe.setUTCHours(fields.hour, fields.minute, fields.second, fields.millisecond);
  if (probe.getUTCFullYear() !== fields.year || probe.getUTCMonth() !== fields.month - 1 ||
      probe.getUTCDate() !== fields.day || probe.getUTCHours() !== fields.hour ||
      probe.getUTCMinutes() !== fields.minute || probe.getUTCSeconds() !== fields.second) {
    throw lifecycleError('invalid_local_time', 'Local time contains an invalid calendar value');
  }
  fields.naiveEpoch = probe.getTime();
  fields.localDate = match[1] + '-' + match[2] + '-' + match[3];
  return fields;
}

function timezoneFormatter(timezone) {
  if (formatterCache.has(timezone)) return formatterCache.get(timezone);
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      calendar: 'iso8601',
      numberingSystem: 'latn',
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch (cause) {
    const error = lifecycleError('invalid_timezone', 'Timezone is not supported');
    error.cause = cause;
    throw error;
  }
  formatterCache.set(timezone, formatter);
  return formatter;
}

function wallClockAt(formatter, epoch) {
  const fields = {};
  for (const part of formatter.formatToParts(new Date(epoch))) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  return {
    year: fields.year,
    month: fields.month,
    day: fields.day,
    hour: fields.hour,
    minute: fields.minute,
    second: fields.second,
  };
}

function timezoneOffsetAt(formatter, epoch) {
  const secondEpoch = Math.floor(epoch / 1000) * 1000;
  const wall = wallClockAt(formatter, secondEpoch);
  const wallEpoch = Date.UTC(
    wall.year,
    wall.month - 1,
    wall.day,
    wall.hour,
    wall.minute,
    wall.second
  );
  return Math.round((wallEpoch - secondEpoch) / 60000);
}

function sameWallClock(expected, actual, epoch) {
  return expected.year === actual.year && expected.month === actual.month &&
    expected.day === actual.day && expected.hour === actual.hour &&
    expected.minute === actual.minute && expected.second === actual.second &&
    new Date(epoch).getUTCMilliseconds() === expected.millisecond;
}

function resolveLocalTime(raw, timezone, explicitOffsetMinutes) {
  const local = parseLocalTimestamp(raw);
  const formatter = timezoneFormatter(timezone);
  const hasExplicitOffset = explicitOffsetMinutes != null;
  if (hasExplicitOffset && !Number.isInteger(explicitOffsetMinutes)) {
    throw lifecycleError('invalid_utc_offset', 'UTC offset must be an integer number of minutes');
  }
  const offsets = new Set();
  for (const deltaHours of [-36, 0, 36]) {
    offsets.add(timezoneOffsetAt(formatter, local.naiveEpoch + deltaHours * 60 * 60 * 1000));
  }
  const matches = [];
  for (const offsetMinutes of offsets) {
    const epoch = local.naiveEpoch - offsetMinutes * 60 * 1000;
    if (sameWallClock(local, wallClockAt(formatter, epoch), epoch)) {
      matches.push({ epoch, offsetMinutes });
    }
  }
  if (matches.length === 0) {
    throw lifecycleError('nonexistent_local_time', 'Local time does not exist in this timezone');
  }
  const selected = hasExplicitOffset
    ? matches.find(function(match) { return match.offsetMinutes === explicitOffsetMinutes; })
    : null;
  if (hasExplicitOffset && !selected) {
    throw lifecycleError('invalid_utc_offset', 'UTC offset does not match this local time and timezone');
  }
  if (!hasExplicitOffset && matches.length > 1) {
    throw lifecycleError('ambiguous_local_time', 'Local time is ambiguous in this timezone');
  }
  const match = selected || matches[0];
  return {
    instant: new Date(match.epoch).toISOString(),
    offsetMinutes: match.offsetMinutes,
    localDate: local.localDate,
  };
}

async function resolvePlotContext(tx, plotUuid, principal) {
  if (plotUuid == null) {
    return {
      plot_uuid: null,
      zone_id: null,
      zone_uuid: null,
      zone_timezone: null,
      crop_hint: null,
      user_id: principal.user_id,
      owner_user_uuid: principal.owner_user_uuid,
      gateway_device_eui: principal.gateway_device_eui,
    };
  }
  const plot = await tx.get(
    'SELECT p.plot_uuid,p.owner_user_uuid AS plot_owner_user_uuid,p.gateway_device_eui,' +
      'p.zone_uuid AS plot_zone_uuid,p.crop_hint,' +
      'z.id AS zone_id,z.zone_uuid,z.user_id AS zone_user_id,z.timezone AS zone_timezone,' +
      'u.user_uuid AS zone_owner_user_uuid ' +
    'FROM journal_plots AS p ' +
    'LEFT JOIN irrigation_zones AS z ON z.zone_uuid=p.zone_uuid ' +
      'AND (z.gateway_device_eui=p.gateway_device_eui OR z.gateway_device_eui IS NULL) ' +
      'AND z.deleted_at IS NULL ' +
    'LEFT JOIN users AS u ON u.id=z.user_id ' +
    'WHERE p.plot_uuid=? AND p.owner_user_uuid=? AND p.gateway_device_eui=? ' +
      'AND p.active=? AND p.deleted_at IS NULL',
    [plotUuid, principal.owner_user_uuid, principal.gateway_device_eui, 1]
  );
  if (!plot) throw lifecycleError('plot_not_found', 'Plot is not owned by this gateway');
  if (plot.plot_zone_uuid != null && plot.zone_id == null) {
    throw lifecycleError('zone_not_found', 'Plot has no gateway-owned linked zone');
  }
  const linked = plot.zone_id != null;
  const userId = linked ? plot.zone_user_id : principal.user_id;
  const ownerUserUuid = plot.plot_owner_user_uuid;
  if (userId == null || !ownerUserUuid) {
    throw lifecycleError('ownership', 'A gateway-owned plot owner could not be resolved');
  }
  if ((linked && plot.zone_owner_user_uuid !== ownerUserUuid) ||
      Number(userId) !== Number(principal.user_id) ||
      ownerUserUuid !== principal.owner_user_uuid) {
    throw lifecycleError('ownership', 'Plot belongs to another user');
  }
  return {
    plot_uuid: plot.plot_uuid,
    zone_id: linked ? Number(plot.zone_id) : null,
    zone_uuid: linked ? plot.zone_uuid : null,
    zone_timezone: linked ? plot.zone_timezone : null,
    crop_hint: nullable(plot.crop_hint),
    user_id: Number(userId),
    owner_user_uuid: ownerUserUuid,
    gateway_device_eui: plot.gateway_device_eui,
  };
}

async function validatePrincipal(tx, principal) {
  const shaped = principal && typeof principal === 'object' && !Array.isArray(principal) &&
    Number.isInteger(principal.user_id) && principal.user_id > 0 &&
    typeof principal.owner_user_uuid === 'string' && Boolean(principal.owner_user_uuid.trim()) &&
    typeof principal.author_principal_uuid === 'string' &&
      Boolean(principal.author_principal_uuid.trim()) &&
    typeof principal.gateway_device_eui === 'string' && EUI64.test(principal.gateway_device_eui) &&
    ['edge-ui', 'cloud-ui'].includes(principal.origin) &&
    (principal.author_label == null || typeof principal.author_label === 'string');
  if (!shaped) throw lifecycleError('invalid_principal', 'Journal principal is malformed');
  const user = await tx.get('SELECT id,user_uuid FROM users WHERE id=?', [principal.user_id]);
  if (!user || user.user_uuid !== principal.owner_user_uuid) {
    throw lifecycleError('invalid_principal', 'Journal principal user identity does not match');
  }
}

function validateDraftLimits(input, principal) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw lifecycleError('invalid_type', 'Draft must be an object');
  }
  validateRequestLimit(input);
  if (principal && typeof principal.author_label === 'string' &&
      Array.from(principal.author_label).length > 120) {
    throw lifecycleError('limit_exceeded', 'Author label exceeds 120 characters');
  }
  if (input.note != null && typeof input.note !== 'string') {
    throw lifecycleError('invalid_type', 'Draft note must be text');
  }
  if (typeof input.note === 'string' && Array.from(input.note).length > 4000) {
    throw lifecycleError('limit_exceeded', 'Draft note exceeds 4000 characters');
  }
  if (!Array.isArray(input.values)) {
    throw lifecycleError('invalid_type', 'Draft values must be an array');
  }
  if (input.values.length > 128) {
    throw lifecycleError('limit_exceeded', 'Draft exceeds the 128 value limit');
  }
  const groups = new Set();
  const valueKeys = new Set();
  for (let index = 0; index < input.values.length; index += 1) {
    const value = input.values[index];
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw lifecycleError('invalid_type', 'Draft value at index ' + index + ' must be an object');
    }
    const groupIndex = value.group_index == null ? 0 : value.group_index;
    if (!Number.isInteger(groupIndex) || groupIndex < 0) {
      throw lifecycleError('invalid_group', 'Draft group index must be a nonnegative integer');
    }
    groups.add(groupIndex);
    if (groups.size > 32) {
      throw lifecycleError('limit_exceeded', 'Draft exceeds the 32 group limit');
    }
    const valueKey = String(groupIndex) + ':' + String(value.attribute_code || '');
    if (valueKeys.has(valueKey)) {
      const duplicateError = lifecycleError('duplicate_value', 'Attribute is duplicated in this group');
      duplicateError.statusCode = 422;
      duplicateError.details = { field: 'values[' + index + '].attribute_code' };
      throw duplicateError;
    }
    valueKeys.add(valueKey);
    const valueStatus = value.value_status == null ? 'observed' : value.value_status;
    if (!['observed', 'not_observed', 'not_applicable', 'below_detection'].includes(valueStatus)) {
      throw lifecycleError('invalid_status', 'Draft value status is not supported');
    }
    const malformedValue =
      (value.value != null && !['string', 'number', 'boolean'].includes(typeof value.value)) ||
      (typeof value.value === 'number' && !Number.isFinite(value.value)) ||
      (value.value_text != null && typeof value.value_text !== 'string') ||
      (value.value_num != null &&
        (typeof value.value_num !== 'number' || !Number.isFinite(value.value_num))) ||
      (value.entered_value_num != null &&
        (typeof value.entered_value_num !== 'number' || !Number.isFinite(value.entered_value_num)));
    if (malformedValue) {
      throw lifecycleError('invalid_value_shape', 'Draft value representations are malformed');
    }
    if (valueStatus === 'observed') {
      for (const field of ['value', 'value_text']) {
        if (typeof value[field] === 'string' && Buffer.byteLength(value[field], 'utf8') > 4096) {
          throw lifecycleError('limit_exceeded', 'Draft text value exceeds the 4096 byte limit');
        }
      }
    }
  }
}

async function resolveDeviceEui(tx, deviceEui, principal, plot) {
  if (deviceEui == null) return null;
  if (typeof deviceEui !== 'string' || !EUI64.test(deviceEui)) {
    throw lifecycleError('invalid_device', 'Journal device EUI must be an EUI-64');
  }
  const device = await tx.get(
    'SELECT d.deveui,d.user_id,d.irrigation_zone_id,d.gateway_device_eui,' +
      'u.user_uuid,z.id AS linked_zone_id,z.user_id AS zone_user_id,' +
      'z.gateway_device_eui AS zone_gateway_device_eui ' +
    'FROM devices AS d ' +
    'LEFT JOIN users AS u ON u.id=d.user_id ' +
    'LEFT JOIN irrigation_zones AS z ON z.id=d.irrigation_zone_id AND z.deleted_at IS NULL ' +
    'WHERE UPPER(d.deveui)=UPPER(?) AND d.deleted_at IS NULL ' +
      'AND (d.irrigation_zone_id IS NULL OR z.id IS NOT NULL)',
    [deviceEui]
  );
  if (!device) throw lifecycleError('not_found', 'Journal device was not found');
  const owned = device.gateway_device_eui === principal.gateway_device_eui &&
    Number(device.user_id) === Number(principal.user_id) &&
    device.user_uuid === principal.owner_user_uuid;
  const zoneMatches = plot.zone_id == null ||
    (Number(device.irrigation_zone_id) === Number(plot.zone_id) &&
      Number(device.zone_user_id) === Number(principal.user_id) &&
      (device.zone_gateway_device_eui === principal.gateway_device_eui ||
        device.zone_gateway_device_eui == null));
  if (!owned || !zoneMatches) {
    throw lifecycleError('ownership', 'Journal device belongs to another owner or zone');
  }
  return String(device.deveui).toUpperCase();
}

async function coveringSeason(tx, zoneId, localDate) {
  if (zoneId == null) return null;
  return tx.get(
    'SELECT season_uuid,crop_type,variety FROM zone_seasons ' +
    'WHERE zone_id=? AND starts_on<=? AND (ends_on IS NULL OR ends_on>=?) ' +
    'ORDER BY starts_on DESC,season_uuid LIMIT ?',
    [zoneId, localDate, localDate, 1]
  );
}

// D0.1 precedence: crop-cycle helpers -----------------------------------
//
// journal_crop_cycles / journal_crop_cycle_plots (Phase 1, migration 0025)
// track an explicit per-plot crop lifecycle: open on seeding, closed by
// harvest/reseed/manual. openCyclesCoveringPlot() is the single query every
// resolution/cascade path uses to find the OPEN membership(s) covering a
// plot at a given local date (ends_on IS NULL, starts_on<=localDate).
async function openCyclesCoveringPlot(tx, plotUuid, localDate) {
  if (plotUuid == null) return [];
  return tx.all(
    'SELECT cc.cycle_uuid,cc.crop_code,cc.variety,cc.starts_on,cc.opened_by_entry_uuid ' +
    'FROM journal_crop_cycle_plots AS ccp ' +
    'JOIN journal_crop_cycles AS cc ON cc.cycle_uuid=ccp.cycle_uuid AND cc.deleted_at IS NULL ' +
    'WHERE ccp.plot_uuid=? AND ccp.ends_on IS NULL AND cc.starts_on<=? ' +
    'ORDER BY cc.starts_on DESC,cc.cycle_uuid',
    [plotUuid, localDate]
  );
}

// Slice D hardening (P1-a/P1-b): the GUI's Where step and inherited-crop
// banner need an AUTHORITATIVE "what open crop cycle(s) cover this plot
// right now" read -- unlike resolveLiveCropOverrides below (which resolves a
// per-ENTRY historical crop as of that entry's own occurred date), this
// answers a plot-level "as of today" question with no entry/date context
// yet, which is exactly what is available before any activity or occurred
// date has been chosen. Reuses openCyclesCoveringPlot (today's local date)
// rather than re-deriving the open-membership query. Returns the GUI-shaped
// read: crop_code/variety/seeded_on (=cc.starts_on) plus
// opened_by_entry_uuid so the GUI can link/correct the seeding entry without
// a separate reverse-lookup fetch.
// C1 (pre-deploy review): "today" must be the GATEWAY's local calendar date,
// not UTC -- new Date().toISOString() silently used UTC, which is wrong on
// either side of UTC midnight for any gateway not itself on UTC (e.g. a
// gateway west of Greenwich rolls to tomorrow hours late; one east of it
// rolls over hours early), shifting which cycles activeCropCyclesForPlot
// treats as covering "today" by up to a day. There is no single
// gateway-wide timezone config in this module (every OTHER local-date read
// here is per-entry/per-zone -- see occurrenceFor's input.occurred_timezone/
// plot.zone_timezone), so this reuses the same wall-clock helpers
// (timezoneFormatter/wallClockAt) resolveLocalTime relies on, fed with the
// host process's own resolved default timezone -- which on the gateway is
// the system timezone Node inherits from the OS (OpenWrt's configured
// zonename), i.e. the gateway's actual configured UTC offset.
function gatewayTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (_) {
    return 'UTC';
  }
}

function todayLocalDate() {
  const wall = wallClockAt(timezoneFormatter(gatewayTimezone()), Date.now());
  return String(wall.year).padStart(4, '0') + '-' +
    String(wall.month).padStart(2, '0') + '-' +
    String(wall.day).padStart(2, '0');
}

async function activeCropCyclesForPlot(tx, plotUuid) {
  const rows = await openCyclesCoveringPlot(tx, plotUuid, todayLocalDate());
  return rows.map(function(row) {
    return {
      cycle_uuid: row.cycle_uuid,
      crop_code: row.crop_code,
      variety: nullable(row.variety),
      seeded_on: row.starts_on,
      opened_by_entry_uuid: row.opened_by_entry_uuid,
    };
  });
}

// Recover the exact local calendar date used at write time from a stored
// UTC instant + its recorded offset (avoids re-resolving the IANA timezone,
// which is both unnecessary and DST-fragile at read time).
function localDateFromInstant(instant, offsetMinutes) {
  const epoch = Date.parse(instant) + Number(offsetMinutes) * 60000;
  return new Date(epoch).toISOString().slice(0, 10);
}

// D0.1 precedence (spec §5.1/§6, owner brief 2026-07-20). Order, most to
// least authoritative:
//   1. An OPEN journal_crop_cycle_plots membership covering plot+date. Wins
//      over EVERYTHING, including an explicit input crop -- a correction to
//      the running crop identity is meant to go through the seeding entry
//      (D13), not by typing a crop on an unrelated activity. We deliberately
//      return null here (defer): season_crop/season_variety are NOT stamped
//      on the entry while the cycle is open. The live crop is resolved at
//      read time by joining the still-open cycle (see resolveLiveCropOverrides
//      below) so a later correction to the cycle or an auto-close/reseed
//      propagates without rewriting history. Freezing happens exactly once,
//      when the covering membership closes (see freezeClosedSpan).
//   2. Explicit input crop (input.season_crop) -- NEW: previously any
//      covering zone_seasons row (even a NULL-crop one) was checked first
//      and returned unconditionally, silently shadowing an explicit crop.
//   3. A REAL-crop covering zone_seasons row (crop_type IS NOT NULL).
//   4. journal_plots.crop_hint -- legacy plot metadata (D0 decision: kept,
//      not deleted). Ranked above a merely-null-crop zone_seasons row since
//      it is actual information the null row does not carry.
//   5. A covering zone_seasons row even with a NULL crop_type. This tier
//      exists ONLY to keep season_uuid attachment byte-identical to the
//      pre-existing behaviour when nothing better is available (kaba100
//      confirmed live zone_seasons rows with NULL crop from the default-
//      season repair backfill) -- it must never outrank tiers 1-4, which is
//      the bug this change fixes: a NULL-crop row no longer counts as a
//      covering match for precedence purposes, only as a last-resort
//      season_uuid carrier.
//   6. None -- throws season_required for a final entry on a real plot,
//      exactly as before.
const SEEDING_ACTIVITY_CODES = new Set(['seeding', 'planting_transplanting']);
const MANUAL_CLOSE_ACTIVITY_CODES = new Set([
  'tillage_soil_work', 'mowing', 'plant_protection_application',
]);

async function resolveSeason(tx, plot, localDate, input, requireExplicit) {
  const cycleCovered = await openCyclesCoveringPlot(tx, plot.plot_uuid, localDate);
  if (cycleCovered.length) return null; // tier 1: defer to live resolution
  // Tier 1.5: a seeding/planting entry that itself records attr.crop is
  // about to open (or join) a cycle for this exact plot+date the moment it
  // is persisted (applyActivityCycleCascade runs right after insert -- the
  // NOT NULL FK from journal_crop_cycles.opened_by_entry_uuid requires the
  // entry to exist first, so the cascade cannot run before resolveSeason
  // does). Defer here too rather than demanding a redundant top-level
  // season_crop: this entry will resolve live from its own (about to exist)
  // cycle exactly like every other activity on the plot. A seeding entry
  // that records no attr.crop falls through to the normal tiers below (and
  // the cascade itself will refuse it with crop_required_for_seeding).
  if (SEEDING_ACTIVITY_CODES.has(input.activity_code) &&
      findAttributeValue(input.values, 'attr.crop') != null) {
    return null;
  }
  const explicitCrop = typeof input.season_crop === 'string' && input.season_crop.trim();
  if (explicitCrop) {
    return {
      season_uuid: null,
      crop_type: input.season_crop,
      variety: nullable(input.season_variety),
    };
  }
  const covering = await coveringSeason(tx, plot.zone_id, localDate);
  if (covering && covering.crop_type != null) return covering; // tier 3
  const cropHint = typeof plot.crop_hint === 'string' && plot.crop_hint.trim();
  if (cropHint) {
    return { season_uuid: null, crop_type: plot.crop_hint, variety: null }; // tier 4
  }
  if (covering) return covering; // tier 5: legacy NULL-crop attach
  if (requireExplicit && plot.plot_uuid != null) {
    throw lifecycleError('season_required', 'A crop is required when no covering season exists');
  }
  return null; // tier 6
}

// Live-vs-frozen read path (D2.2/§6). For a page of journal_entries rows,
// returns a Map<entry_uuid, {season_uuid,season_crop,season_variety}>
// overriding the STORED columns with the LIVE crop wherever the plot is
// currently covered by exactly one open cycle. Entries whose plot has no
// open cycle (the overwhelming majority, and every entry that predates this
// feature) are left untouched -- this is purely additive. An intercropped
// plot (>1 open cycle) is left to the stored value too: disambiguating which
// crop applies to a given activity is a capture-form (Phase 3) concern.
// `queryAll(sql, params)` lets callers (api.js) supply their own DB/snapshot
// handle wrapper.
async function resolveLiveCropOverrides(queryAll, rows) {
  const plotUuids = Array.from(new Set(
    (rows || []).map(function(row) { return row.plot_uuid; }).filter(function(value) { return value != null; })
  ));
  const overrides = new Map();
  if (!plotUuids.length) return overrides;
  const placeholders = plotUuids.map(function() { return '?'; }).join(',');
  const openRows = await queryAll(
    'SELECT ccp.plot_uuid,cc.cycle_uuid,cc.crop_code,cc.variety,cc.starts_on ' +
    'FROM journal_crop_cycle_plots AS ccp ' +
    'JOIN journal_crop_cycles AS cc ON cc.cycle_uuid=ccp.cycle_uuid AND cc.deleted_at IS NULL ' +
    'WHERE ccp.ends_on IS NULL AND ccp.plot_uuid IN (' + placeholders + ')',
    plotUuids
  );
  const byPlot = new Map();
  for (const cycle of openRows) {
    if (!byPlot.has(cycle.plot_uuid)) byPlot.set(cycle.plot_uuid, []);
    byPlot.get(cycle.plot_uuid).push(cycle);
  }
  for (const row of rows) {
    if (row.plot_uuid == null || row.occurred_start == null) continue;
    const candidates = byPlot.get(row.plot_uuid);
    if (!candidates || !candidates.length) continue;
    const localDate = localDateFromInstant(row.occurred_start, row.occurred_utc_offset_minutes);
    const covering = candidates.filter(function(cycle) { return cycle.starts_on <= localDate; });
    if (covering.length !== 1) continue; // no cover, or ambiguous intercrop: leave stored value
    overrides.set(row.entry_uuid, {
      season_uuid: null,
      season_crop: covering[0].crop_code,
      season_variety: nullable(covering[0].variety),
    });
  }
  return overrides;
}

// P2-b (Slice D hardening): a harvest/manual-close/reseed entry that CLOSED
// a crop-cycle membership never gets its OWN season_crop/season_variety
// frozen (see freezeClosedSpan's excludeEntryUuid) -- by design, so it never
// mis-stamps itself with a crop cycle that might not even be fully committed
// yet when its own cascade runs. From the GUI's perspective this means the
// closing entry itself displays no crop at all, even though it is often the
// MOST informative entry for "what was growing here" (a harvest). This
// resolves, for a page of journal_entries rows, a
// Map<entry_uuid, {crop_code, variety}> for exactly the entries that CLOSED a
// journal_crop_cycle_plots membership (closed_by_entry_uuid = entry_uuid),
// read from the (now historical) closed cycle -- for DISPLAY only. Callers
// must project this onto separate closed_crop_code/closed_crop_variety
// fields, never onto season_crop/season_variety themselves: those stored
// columns must stay NULL/deferred on the closing entry exactly as designed,
// so a correction round-trip (which resends season_crop/season_variety
// verbatim) can never accidentally re-stamp them.
//
// C2 (pre-deploy review): the join guards `cc.deleted_at IS NULL`, matching
// resolveLiveCropOverrides above -- a voided (soft-deleted) crop cycle (see
// applyVoidCycleCascade) must not resurface its crop on the closing entry's
// display any more than a voided cycle may resolve live.
async function resolveClosedCropCycleOverrides(queryAll, rows) {
  const entryUuids = Array.from(new Set(
    (rows || []).map(function(row) { return row.entry_uuid; }).filter(function(value) { return value != null; })
  ));
  const overrides = new Map();
  if (!entryUuids.length) return overrides;
  const placeholders = entryUuids.map(function() { return '?'; }).join(',');
  const closedRows = await queryAll(
    'SELECT ccp.closed_by_entry_uuid AS entry_uuid,cc.crop_code,cc.variety ' +
    'FROM journal_crop_cycle_plots AS ccp ' +
    'JOIN journal_crop_cycles AS cc ON cc.cycle_uuid=ccp.cycle_uuid AND cc.deleted_at IS NULL ' +
    'WHERE ccp.closed_by_entry_uuid IN (' + placeholders + ')',
    entryUuids
  );
  for (const row of closedRows) {
    overrides.set(row.entry_uuid, {
      closed_crop_code: row.crop_code,
      closed_crop_variety: nullable(row.variety),
    });
  }
  return overrides;
}

// Extract the semantic value an entry recorded for a given catalog
// attribute (e.g. attr.crop, attr.variety) from its NORMALIZED value array,
// i.e. before storedValue()'s number/text column split. Used only to learn
// the crop/variety a seeding/planting entry just recorded, for opening or
// updating a crop cycle.
function findAttributeValue(values, attributeCode) {
  const match = (Array.isArray(values) ? values : []).find(function(value) {
    return value.attribute_code === attributeCode && (value.group_index || 0) === 0 &&
      (value.value_status == null || value.value_status === 'observed');
  });
  if (!match) return null;
  const semantic = match.value != null ? match.value : (match.value_text != null ? match.value_text : null);
  return semantic == null ? null : String(semantic);
}

// Stamp (freeze) or clear (unfreeze) the season_crop/season_variety of one
// already-persisted final entry, bumping its sync_version and emitting a
// JOURNAL_ENTRY_UPSERTED outbox event exactly like a correction would. This
// is a background consistency side effect of a DIFFERENT entry's harvest/
// manual-close/reseed (or its void), not itself a command target, so it
// never touches the command/effect-key ledger.
async function stampSeasonSnapshot(tx, entryUuid, cropCode, variety) {
  const entry = await tx.get('SELECT sync_version FROM journal_entries WHERE entry_uuid=?', [entryUuid]);
  if (!entry) return;
  const nextVersion = Number(entry.sync_version) + 1;
  const now = new Date().toISOString();
  await tx.run(
    'UPDATE journal_entries SET season_crop=?,season_variety=?,season_uuid=NULL,sync_version=?,updated_at=? ' +
    'WHERE entry_uuid=? AND sync_version=?',
    [nullable(cropCode), nullable(variety), nextVersion, now, entryUuid, entry.sync_version]
  );
  await emitJournalOutbox(tx, entryUuid, 'JOURNAL_ENTRY_UPSERTED');
}

// Freeze (D2.2/§6 point 3): once a membership closes (harvest, reseed, OR
// manual -- the spec calls out harvest explicitly, but the same "stop
// deferring" step is required whenever a membership stops being open, or a
// deferred entry would permanently lose its crop the moment the cycle it was
// relying on closes), stamp season_crop/season_variety on every final entry
// on that plot whose occurred local date falls in [startsOn,endsOn]. This
// OVERWRITES whatever was stored (even a real zone_seasons-derived crop),
// because tier 1 precedence means the cycle was already the authoritative
// LIVE answer for that entry the entire time the membership was open.
// Entries still covered by a DIFFERENT, still-open cycle on the same plot
// (true intercropping) are skipped -- they remain deferred/live until their
// own ambiguity resolves.
//
// excludeEntryUuid (review fix): the entry whose OWN persistence is driving
// this close (a harvest/manual-close entry closing its own covering cycle,
// or a seeding/reseed entry closing the cycle it supersedes) must never be
// frozen by its own cascade. That entry's sync_version/outbox row is still
// being assembled by its caller (createFinalInTransaction et al.) at this
// point -- stamping it here would bump its sync_version and emit an outbox
// event behind the caller's back, leaving the returned/ACK'd version stale
// (DB ahead of what was reported), producing a missing-v1/duplicate-v2
// outbox pair, breaking `entry.sync_version === 1` batch-retry idempotency,
// and -- for a differing-crop reseed specifically -- mis-stamping the NEW
// seeding entry with the OLD (closing) crop before the new cycle even
// exists. The excluded entry's own season_crop simply stays deferred
// (NULL); it no longer has an open cycle to live-resolve from once this
// close commits, which is an accepted, deliberate trade-off (see the
// review notes) in exchange for correct sync_version accounting.
async function freezeClosedSpan(tx, plotUuid, startsOn, endsOn, cropCode, variety, excludeEntryUuid) {
  const rows = await tx.all(
    "SELECT entry_uuid,occurred_start,occurred_utc_offset_minutes FROM journal_entries " +
    "WHERE plot_uuid=? AND status='final' AND deleted_at IS NULL AND entry_uuid<>?",
    [plotUuid, excludeEntryUuid]
  );
  if (!rows.length) return;
  const stillOpen = await openCyclesCoveringPlot(tx, plotUuid, endsOn);
  for (const row of rows) {
    const localDate = localDateFromInstant(row.occurred_start, row.occurred_utc_offset_minutes);
    if (localDate < startsOn || localDate > endsOn) continue;
    const ambiguous = stillOpen.some(function(other) { return other.starts_on <= localDate; });
    if (ambiguous) continue;
    await stampSeasonSnapshot(tx, row.entry_uuid, cropCode, variety);
  }
}

// Un-freeze (D13/R7): voiding the harvest/manual-close that froze a span
// must undo exactly what freezeClosedSpan wrote. There is no column
// recording which entries a given freeze touched, so this matches the
// freeze postcondition instead: every final entry in [startsOn,endsOn] on
// the plot whose season_uuid is NULL and season_crop/variety equal the
// closing cycle's crop/variety. Resetting them to NULL is correct (not just
// "best effort"): the membership is being reopened, so those entries should
// resume live/deferred resolution from it, regardless of what they showed
// before the freeze.
async function unfreezeClosedSpan(tx, plotUuid, startsOn, endsOn, cropCode, variety) {
  if (endsOn == null) return;
  const normalizedVariety = nullable(variety);
  const rows = await tx.all(
    "SELECT entry_uuid,occurred_start,occurred_utc_offset_minutes,season_variety,sync_version " +
    "FROM journal_entries WHERE plot_uuid=? AND status='final' AND deleted_at IS NULL " +
      "AND season_uuid IS NULL AND season_crop=?",
    [plotUuid, cropCode]
  );
  for (const row of rows) {
    if (nullable(row.season_variety) !== normalizedVariety) continue;
    const localDate = localDateFromInstant(row.occurred_start, row.occurred_utc_offset_minutes);
    if (localDate < startsOn || localDate > endsOn) continue;
    const nextVersion = Number(row.sync_version) + 1;
    const now = new Date().toISOString();
    await tx.run(
      'UPDATE journal_entries SET season_crop=NULL,season_variety=NULL,season_uuid=NULL,' +
        'sync_version=?,updated_at=? WHERE entry_uuid=? AND sync_version=?',
      [nextVersion, now, row.entry_uuid, row.sync_version]
    );
    await emitJournalOutbox(tx, row.entry_uuid, 'JOURNAL_ENTRY_UPSERTED');
  }
}

// Close one open membership row (harvest, reseed, or manual close) and
// freeze its now-closed span in the same step -- the two are inseparable
// (see freezeClosedSpan's comment on why every close reason freezes).
async function closeCycleMembership(tx, cycle, plotUuid, endsOn, closingEntryUuid, closeReason) {
  await tx.run(
    'UPDATE journal_crop_cycle_plots SET ends_on=?,closed_by_entry_uuid=?,close_reason=? ' +
    'WHERE cycle_uuid=? AND plot_uuid=? AND ends_on IS NULL',
    [endsOn, closingEntryUuid, closeReason, cycle.cycle_uuid, plotUuid]
  );
  await freezeClosedSpan(
    tx, plotUuid, cycle.starts_on, endsOn, cycle.crop_code, nullable(cycle.variety), closingEntryUuid
  );
}

function cycleDisambiguationError(code, message, covering) {
  const error = lifecycleError(code, message);
  error.statusCode = 422;
  error.details = {
    openCycles: covering.map(function(cycle) {
      return { cycle_uuid: cycle.cycle_uuid, crop_code: cycle.crop_code, variety: nullable(cycle.variety) };
    }),
  };
  return error;
}

// R7: harvest/manual-close on an intercropped plot (>1 open cycle covering
// it) must name which cycle it closes via input.cycle_uuid.
function selectTargetCycle(covering, input, missingCode, missingMessage) {
  if (covering.length === 1) return covering[0];
  const cycleUuid = nullable(input.cycle_uuid);
  if (cycleUuid) {
    const match = covering.find(function(cycle) { return cycle.cycle_uuid === cycleUuid; });
    if (match) return match;
    throw cycleDisambiguationError(
      'cycle_not_found',
      'cycle_uuid does not match an open crop cycle covering this plot',
      covering
    );
  }
  throw cycleDisambiguationError(missingCode, missingMessage, covering);
}

// D2.1/R4: a final seeding/planting_transplanting entry opens a cycle (or
// joins/supersedes the one already covering the plot).
//
// cycle_action default decision (documented per the owner brief): when the
// seeded crop+variety exactly match an already-open covering cycle and the
// caller does not send cycle_action, we default to 'continue' (leave the
// existing cycle open, attach nothing new) rather than 'new'. Rationale: an
// unmarked same-crop-and-variety seeding is far more likely to be an
// infill/gap-fill log for the crop already growing than a deliberate
// decision to fragment history into a second identical cycle; 'new' is an
// explicit, deliberate override the capture form sends when the operator
// really means "start over". A DIFFERING crop or variety is never
// ambiguous: it always auto-closes the prior membership (close_reason=
// 'reseed') and opens a fresh cycle, regardless of cycle_action.
async function applySeedingCycleEffect(tx, plot, localDate, entryUuid, principal, input, cropCode, variety) {
  const covering = await openCyclesCoveringPlot(tx, plot.plot_uuid, localDate);
  const normalizedVariety = nullable(variety);
  const rawAction = input.cycle_action;
  if (rawAction != null && rawAction !== 'continue' && rawAction !== 'new') {
    throw lifecycleError('invalid_cycle_action', 'cycle_action must be "continue" or "new"');
  }
  const effectiveAction = rawAction || 'continue';

  // R7 parity (review fix): an intercropped plot (>1 open cycle covering it)
  // must never have its seeding/reseed effect inferred. selectTargetCycle
  // auto-picks the sole cycle when there is exactly one -- single-open-cycle
  // behavior is unchanged -- and otherwise demands an explicit cycle_uuid,
  // exactly like harvest/manual-close, instead of blanket-closing every open
  // cycle (the old differing-crop behavior) or closing whichever OTHER
  // co-cropped cycle also happened to cover the plot (the old same-crop
  // continue behavior).
  const target = covering.length
    ? selectTargetCycle(
        covering,
        input,
        'cycle_uuid_required',
        'Multiple open crop cycles cover this plot; specify cycle_uuid to select which one this seeding affects'
      )
    : null;
  const isMatch = target != null && target.crop_code === cropCode && nullable(target.variety) === normalizedVariety;
  const continuing = isMatch && effectiveAction === 'continue';
  const toClose = target != null && !continuing ? [target] : [];

  if (continuing) return;
  if (cropCode == null) {
    throw lifecycleError(
      'crop_required_for_seeding',
      'A seeding/planting entry must record attr.crop to open a crop cycle'
    );
  }

  // Open the new cycle BEFORE closing whatever this reseed supersedes
  // (review fix, reversed from a naive close-then-open): freezeClosedSpan's
  // still-open ambiguity check (see closeCycleMembership) must be able to
  // see the just-opened cycle so any OTHER final entry dated exactly on the
  // reseed boundary is correctly left deferred/live (truly ambiguous between
  // the closing and opening crop) rather than wrongly frozen to the closing
  // crop. The triggering entry itself is unconditionally excluded from
  // freezing regardless of this ordering (see freezeClosedSpan) -- it must
  // never be stamped with a crop other than the one it is itself seeding.
  const now = new Date().toISOString();
  const cycleUuid = crypto.randomUUID();
  await tx.run(
    'INSERT INTO journal_crop_cycles(' +
      'cycle_uuid,crop_code,variety,group_uuid,opened_by_entry_uuid,starts_on,gateway_device_eui,' +
      'created_by_principal_uuid,sync_version,created_at,updated_at,deleted_at' +
    ') VALUES (?,?,?,NULL,?,?,?,?,0,?,?,NULL)',
    [
      cycleUuid, cropCode, normalizedVariety, entryUuid, localDate,
      plot.gateway_device_eui, principal.author_principal_uuid, now, now,
    ]
  );
  await tx.run(
    'INSERT INTO journal_crop_cycle_plots(cycle_uuid,plot_uuid,ends_on,closed_by_entry_uuid,close_reason) ' +
    'VALUES (?,?,NULL,NULL,NULL)',
    [cycleUuid, plot.plot_uuid]
  );
  for (const cycle of toClose) {
    await closeCycleMembership(tx, cycle, plot.plot_uuid, localDate, entryUuid, 'reseed');
  }
}

// D2.1/D10/R7: a final harvest entry closes the covering membership for its
// own (single) target plot only -- partial harvest across a group falls out
// for free, since each plot is its own journal_entries row (a batch submits
// one final harvest entry per selected plot). A plot with NO open cycle is
// a legacy/perennial no-op, not an error (R7 explicitly anticipates
// harvesting cycle-less plots until the "assign crop" flow exists).
async function applyHarvestCycleEffect(tx, plot, localDate, entryUuid, input) {
  const covering = await openCyclesCoveringPlot(tx, plot.plot_uuid, localDate);
  if (!covering.length) return;
  const target = selectTargetCycle(
    covering,
    input,
    'cycle_uuid_required',
    'Multiple open crop cycles cover this plot; specify cycle_uuid to select which one this harvest closes'
  );
  await closeCycleMembership(tx, target, plot.plot_uuid, localDate, entryUuid, 'harvest');
}

// R3: a tillage_soil_work/mowing/plant_protection_application entry carrying
// ends_crop_cycle:true closes the covering membership (close_reason=
// 'manual'). Unlike harvest, this is an explicit caller intent, so an
// absent covering cycle is a clear user/agent error, not a silent no-op.
async function applyManualCloseCycleEffect(tx, plot, localDate, entryUuid, input) {
  const covering = await openCyclesCoveringPlot(tx, plot.plot_uuid, localDate);
  if (!covering.length) {
    throw lifecycleError('no_open_cycle', 'ends_crop_cycle was set but no open crop cycle covers this plot');
  }
  const target = selectTargetCycle(
    covering,
    input,
    'cycle_uuid_required',
    'Multiple open crop cycles cover this plot; specify cycle_uuid to select which one this closes'
  );
  await closeCycleMembership(tx, target, plot.plot_uuid, localDate, entryUuid, 'manual');
}

// Single dispatch point called after a final entry (create or draft
// promotion) is persisted: routes to the seeding/harvest/manual-close cycle
// effect for its activity, or does nothing for every other activity code.
async function applyActivityCycleCascade(tx, principal, plot, occurrence, entryUuid, activityCode, input, values) {
  if (plot.plot_uuid == null) return;
  const localDate = occurrence.start.localDate;
  if (SEEDING_ACTIVITY_CODES.has(activityCode)) {
    await applySeedingCycleEffect(
      tx, plot, localDate, entryUuid, principal, input,
      findAttributeValue(values, 'attr.crop'),
      findAttributeValue(values, 'attr.variety')
    );
  } else if (activityCode === 'harvest') {
    await applyHarvestCycleEffect(tx, plot, localDate, entryUuid, input);
  } else if (MANUAL_CLOSE_ACTIVITY_CODES.has(activityCode) && input.ends_crop_cycle === true) {
    await applyManualCloseCycleEffect(tx, plot, localDate, entryUuid, input);
  }
}

// S2 (review fix -- a minimum guard, NOT a full correction-cascade): there
// is no per-entry rewrite of ends_on/starts_on/frozen spans when a
// close/open entry is corrected (that full cascade is explicitly deferred,
// see the plan notes), so a correction that would leave crop-cycle state
// inconsistent must be rejected outright rather than silently desyncing it:
//   - correcting the OCCURRED DATE of an entry that closed a cycle (harvest
//     or manual-close) would leave that cycle's ends_on/frozen span stale.
//   - correcting the OCCURRED DATE of a seeding/planting entry that opened a
//     cycle would leave that cycle's starts_on stale.
//   - correcting the CROP/VARIETY of a seeding/planting entry whose cycle
//     has ALREADY CLOSED would update only the (now historical) cycle row,
//     not the entries that already froze from it -- split-brain.
// A crop/variety correction on a seeding whose cycle is STILL open (and
// whose plot+date are unchanged) is deliberately left alone here: that is
// the one case applySeedingCorrectionCascade already keeps correct without
// a rewrite, since live reads join the still-open cycle.
async function assertCorrectionWontDesyncCycle(tx, existing, occurrence, normalized) {
  const originalLocalDate = localDateFromInstant(existing.occurred_start, existing.occurred_utc_offset_minutes);
  const dateChanged = occurrence.start.localDate !== originalLocalDate;

  if (dateChanged) {
    const closedMembership = await tx.get(
      "SELECT ccp.cycle_uuid FROM journal_crop_cycle_plots AS ccp " +
      "JOIN journal_crop_cycles AS cc ON cc.cycle_uuid=ccp.cycle_uuid AND cc.deleted_at IS NULL " +
      "WHERE ccp.closed_by_entry_uuid=?",
      [existing.entry_uuid]
    );
    if (closedMembership) {
      throw lifecycleError(
        'correction_would_desync_cycle',
        "Correcting this entry's occurred date would leave the crop cycle it closed inconsistent"
      );
    }
  }

  if (!SEEDING_ACTIVITY_CODES.has(existing.activity_code)) return;
  const openedCycle = await tx.get(
    'SELECT cc.cycle_uuid,cc.crop_code,cc.variety,ccp.ends_on FROM journal_crop_cycles AS cc ' +
    'JOIN journal_crop_cycle_plots AS ccp ON ccp.cycle_uuid=cc.cycle_uuid ' +
    'WHERE cc.opened_by_entry_uuid=? AND cc.deleted_at IS NULL',
    [existing.entry_uuid]
  );
  if (!openedCycle) return;
  if (dateChanged) {
    throw lifecycleError(
      'correction_would_desync_cycle',
      "Correcting this seeding's occurred date would leave the crop cycle it opened inconsistent"
    );
  }
  if (openedCycle.ends_on == null) return; // still open: the narrow crop/variety cascade stays correct
  const cropCode = findAttributeValue(normalized.values, 'attr.crop');
  const variety = findAttributeValue(normalized.values, 'attr.variety');
  const cropChanged = cropCode != null &&
    (cropCode !== openedCycle.crop_code || nullable(variety) !== nullable(openedCycle.variety));
  if (cropChanged) {
    throw lifecycleError(
      'correction_would_desync_cycle',
      "Correcting this seeding's crop after its crop cycle closed would desync already-frozen entries"
    );
  }
}

// D13 (narrow scope): correcting a seeding/planting entry's crop or variety
// updates the crop_code/variety of the cycle IT opened, in place -- since
// live reads join the cycle rather than a stored column, this is the entire
// propagation mechanism (no per-entry rewrite needed). Scoped deliberately
// narrow: only fires when the corrected entry's plot is unchanged from the
// original (a correction that also relocates the entry to a different plot
// does not attempt to move/re-link the cycle -- out of scope for this
// phase) and only ever updates crop_code/variety, never starts_on or
// membership. A correction that clears the crop entirely is ignored rather
// than blanking a tracked cycle's crop_code (which is NOT NULL).
async function applySeedingCorrectionCascade(tx, existing, plot, normalized) {
  if (!SEEDING_ACTIVITY_CODES.has(existing.activity_code)) return;
  if (nullable(plot.plot_uuid) !== nullable(existing.plot_uuid)) return;
  const cycle = await tx.get(
    'SELECT cycle_uuid,crop_code,variety FROM journal_crop_cycles ' +
    'WHERE opened_by_entry_uuid=? AND deleted_at IS NULL',
    [existing.entry_uuid]
  );
  if (!cycle) return;
  const cropCode = findAttributeValue(normalized.values, 'attr.crop');
  const variety = findAttributeValue(normalized.values, 'attr.variety');
  if (cropCode == null) return;
  if (cropCode === cycle.crop_code && nullable(variety) === nullable(cycle.variety)) return;
  const now = new Date().toISOString();
  await tx.run(
    'UPDATE journal_crop_cycles SET crop_code=?,variety=?,updated_at=?,sync_version=sync_version+1 ' +
    'WHERE cycle_uuid=?',
    [cropCode, nullable(variety), now, cycle.cycle_uuid]
  );
}

// D13/R7 void cascades:
//   - voiding a seeding soft-deletes the cycle IT opened (deleted_at set;
//     the CASCADE FK on journal_crop_cycle_plots is irrelevant here since
//     this is a soft delete, and resolution/read queries already filter
//     cc.deleted_at IS NULL). Refuses with a clear, catchable error if the
//     cycle has dependent final entries (other entries currently relying on
//     it live, or already frozen by it) UNLESS the caller sets
//     options.cascade_ack.
//   - voiding a harvest/manual-close entry reopens the membership(s) IT
//     closed and un-freezes what it froze, UNLESS another cycle is already
//     open on the same plot (a reseed that assumed the plot was free) --
//     that is a collision, refused with a clear error rather than silently
//     creating an unintended second open membership.
async function findCycleDependents(tx, membership, cycle, excludeEntryUuid) {
  const rows = await tx.all(
    "SELECT entry_uuid,occurred_start,occurred_utc_offset_minutes,season_crop,season_variety,season_uuid " +
    "FROM journal_entries WHERE plot_uuid=? AND status='final' AND deleted_at IS NULL AND entry_uuid<>?",
    [membership.plot_uuid, excludeEntryUuid]
  );
  const dependents = [];
  for (const row of rows) {
    const localDate = localDateFromInstant(row.occurred_start, row.occurred_utc_offset_minutes);
    if (localDate < cycle.starts_on) continue;
    if (membership.ends_on == null) {
      dependents.push(row.entry_uuid); // still open: every later entry currently resolves from it live
      continue;
    }
    if (localDate > membership.ends_on) continue;
    if (row.season_crop === cycle.crop_code && nullable(row.season_variety) === nullable(cycle.variety) &&
        row.season_uuid == null) {
      dependents.push(row.entry_uuid); // frozen by this (now-closed) cycle
    }
  }
  return dependents;
}

async function applyVoidCycleCascade(tx, entry, principal, options) {
  const opened = await tx.get(
    'SELECT * FROM journal_crop_cycles WHERE opened_by_entry_uuid=? AND deleted_at IS NULL',
    [entry.entry_uuid]
  );
  if (opened) {
    const membership = await tx.get(
      'SELECT * FROM journal_crop_cycle_plots WHERE cycle_uuid=?',
      [opened.cycle_uuid]
    );
    const dependents = membership
      ? await findCycleDependents(tx, membership, opened, entry.entry_uuid)
      : [];
    if (dependents.length && !options.cascade_ack) {
      const error = lifecycleError(
        'cycle_has_dependents',
        'Voiding this seeding would orphan entries that inherit its crop cycle'
      );
      error.statusCode = 409;
      error.details = { dependentEntryUuids: dependents };
      throw error;
    }
    const now = new Date().toISOString();
    await tx.run(
      'UPDATE journal_crop_cycles SET deleted_at=?,updated_at=?,sync_version=sync_version+1 WHERE cycle_uuid=?',
      [now, now, opened.cycle_uuid]
    );
  }

  const closedMemberships = await tx.all(
    'SELECT ccp.cycle_uuid,ccp.plot_uuid,ccp.ends_on,cc.crop_code,cc.variety,cc.starts_on,' +
      'cc.deleted_at AS cycle_deleted_at ' +
    'FROM journal_crop_cycle_plots AS ccp JOIN journal_crop_cycles AS cc ON cc.cycle_uuid=ccp.cycle_uuid ' +
    'WHERE ccp.closed_by_entry_uuid=?',
    [entry.entry_uuid]
  );
  for (const membership of closedMemberships) {
    if (membership.cycle_deleted_at != null) continue;
    const collision = await tx.get(
      'SELECT ccp2.cycle_uuid FROM journal_crop_cycle_plots AS ccp2 ' +
      'JOIN journal_crop_cycles AS cc2 ON cc2.cycle_uuid=ccp2.cycle_uuid AND cc2.deleted_at IS NULL ' +
      'WHERE ccp2.plot_uuid=? AND ccp2.ends_on IS NULL AND ccp2.cycle_uuid<>?',
      [membership.plot_uuid, membership.cycle_uuid]
    );
    if (collision) {
      const error = lifecycleError(
        'reopen_collision',
        'Another crop cycle is already open on this plot; resolve it before reopening the voided closure'
      );
      error.statusCode = 409;
      error.details = { collidingCycleUuid: collision.cycle_uuid };
      throw error;
    }
    await tx.run(
      'UPDATE journal_crop_cycle_plots SET ends_on=NULL,closed_by_entry_uuid=NULL,close_reason=NULL ' +
      'WHERE cycle_uuid=? AND plot_uuid=?',
      [membership.cycle_uuid, membership.plot_uuid]
    );
    await unfreezeClosedSpan(
      tx, membership.plot_uuid, membership.starts_on, membership.ends_on,
      membership.crop_code, nullable(membership.variety)
    );
  }
}

function parsedDefinition(row) {
  if (!row) return null;
  const definition = Object.assign({}, row, { catalog_errors: [] });
  try {
    definition.definition = JSON.parse(row.definition_json);
  } catch (cause) {
    const error = lifecycleError('invalid_catalog', 'Journal definition JSON is invalid');
    error.cause = cause;
    throw error;
  }
  delete definition.definition_json;
  return definition;
}

async function validationDefinitions(tx, input) {
  const layout = await tx.get(
    'SELECT code,version,definition_json,active FROM journal_layouts WHERE code=? AND version=?',
    [input.layout_code, input.layout_version]
  );
  const template = await tx.get(
    'SELECT code,version,definition_json,active FROM journal_templates WHERE code=? AND version=?',
    [input.template_code, input.template_version]
  );
  return { layout: parsedDefinition(layout), template: parsedDefinition(template) };
}

const ACTUATION_REFERENCE_KEY = 'valve_actuation_expectations.expectation_id';

async function referenceValuesForFinalization(tx, plot, principal) {
  const allowed = new Set();
  if (plot.zone_id != null) {
    const rows = await tx.all(
      'SELECT vae.expectation_id FROM valve_actuation_expectations AS vae ' +
      'JOIN devices AS d ON UPPER(d.deveui)=UPPER(vae.device_eui) ' +
      'WHERE vae.zone_id=? AND d.user_id=? AND d.gateway_device_eui=? ' +
        'AND d.deleted_at IS NULL ORDER BY vae.expectation_id',
      [plot.zone_id, principal.user_id, principal.gateway_device_eui]
    );
    for (const row of rows) allowed.add(row.expectation_id);
  }
  return new Map([[ACTUATION_REFERENCE_KEY, allowed]]);
}

async function currentCatalogVersion(tx, catalog) {
  const state = await tx.get(
    'SELECT catalog_version,catalog_hash FROM journal_catalog_state WHERE id=?',
    [1]
  );
  if (!state) throw lifecycleError('invalid_catalog', 'Journal catalog state is missing');
  const version = Number(state.catalog_version);
  if (!catalog || Number(catalog.version) !== version || catalog.hash !== state.catalog_hash) {
    throw lifecycleError('stale_catalog', 'Journal catalog changed after it was loaded');
  }
  return version;
}

function frozenSeasonForCorrection(existing, plot, occurrence) {
  const sameDeterminants = nullable(existing.plot_uuid) === nullable(plot.plot_uuid) &&
    nullable(existing.zone_uuid) === nullable(plot.zone_uuid) &&
    existing.occurred_start === occurrence.start.instant &&
    existing.occurred_timezone === occurrence.timezone;
  if (!sameDeterminants) return null;
  if (existing.season_uuid == null && existing.season_crop == null &&
      existing.season_variety == null) {
    return { preserve: true, season: null };
  }
  return {
    preserve: true,
    season: {
      season_uuid: nullable(existing.season_uuid),
      crop_type: nullable(existing.season_crop),
      variety: nullable(existing.season_variety),
    },
  };
}

function sameContextDeterminants(existing, plot, deviceEui, occurrence) {
  return nullable(existing.plot_uuid) === nullable(plot.plot_uuid) &&
    nullable(existing.zone_uuid) === nullable(plot.zone_uuid) &&
    nullable(existing.zone_id) === nullable(plot.zone_id) &&
    nullable(existing.device_eui) === nullable(deviceEui) &&
    existing.occurred_start === occurrence.start.instant &&
    nullable(existing.occurred_end) === nullable(occurrence.end && occurrence.end.instant);
}

function serializeGeneratedContext(context) {
  let serialized;
  try {
    serialized = JSON.stringify(context);
  } catch (cause) {
    const error = lifecycleError('invalid_context', 'Generated journal context is not JSON-serializable');
    error.cause = cause;
    throw error;
  }
  if (serialized === undefined) {
    throw lifecycleError('invalid_context', 'Generated journal context is not JSON-serializable');
  }
  if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024) {
    throw lifecycleError('limit_exceeded', 'Generated journal context exceeds the 64 KiB limit');
  }
  return serialized;
}

function contextCacheKey(plot, deviceEui, occurrence) {
  return JSON.stringify([
    plot.zone_id,
    plot.zone_uuid,
    nullable(deviceEui),
    occurrence.start.instant,
    occurrence.end ? occurrence.end.instant : null,
  ]);
}

async function generatedContextJson(tx, plot, deviceEui, occurrence, contextCache) {
  if (plot.zone_id == null || plot.zone_uuid == null) return null;
  const key = contextCache && contextCacheKey(plot, deviceEui, occurrence);
  let baseContext = key && contextCache.has(key) ? contextCache.get(key) : null;
  if (!baseContext) {
    baseContext = await buildContext(
      tx,
      Object.assign({}, plot, { subject_device: nullable(deviceEui) }),
      occurrence.start.instant,
      occurrence.end ? occurrence.end.instant : null
    );
    if (key) contextCache.set(key, baseContext);
  }
  return serializeGeneratedContext(Object.assign({}, baseContext, {
    plot_uuid: plot.plot_uuid,
  }));
}

function entryRow(input, principal, plot, season, occurrence, catalogVersion, options) {
  const now = new Date().toISOString();
  return {
    entry_uuid: options.entry_uuid,
    owner_user_uuid: plot.owner_user_uuid,
    user_id: plot.user_id,
    author_principal_uuid: principal.author_principal_uuid,
    author_label: nullable(principal.author_label),
    plot_uuid: plot.plot_uuid,
    zone_id: plot.zone_id,
    zone_uuid: plot.zone_uuid,
    device_eui: nullable(input.device_eui),
    season_uuid: season ? season.season_uuid : null,
    season_crop: season ? nullable(season.crop_type) : null,
    season_variety: season ? nullable(season.variety) : null,
    campaign_uuid: nullable(input.campaign_uuid),
    protocol_code: nullable(input.protocol_code),
    protocol_version: nullable(input.protocol_version),
    observation_unit_code: nullable(input.observation_unit_code),
    pass_uuid: nullable(input.pass_uuid),
    batch_uuid: nullable(options.batch_uuid),
    activity_code: input.activity_code,
    template_code: input.template_code,
    template_version: input.template_version,
    layout_code: input.layout_code,
    layout_version: input.layout_version,
    catalog_version: catalogVersion,
    occurred_start: occurrence.start.instant,
    occurred_end: occurrence.end ? occurrence.end.instant : null,
    occurred_timezone: occurrence.timezone,
    occurred_utc_offset_minutes: occurrence.start.offsetMinutes,
    recorded_at: now,
    origin: principal.origin,
    status: options.status,
    voided_at: null,
    voided_by_principal_uuid: null,
    void_reason: null,
    note: nullable(input.note),
    context_json: nullable(options.context_json),
    sync_version: options.sync_version,
    gateway_device_eui: plot.gateway_device_eui,
    created_at: now,
    updated_at: now,
    deleted_at: null,
  };
}

async function insertEntry(tx, row) {
  const placeholders = ENTRY_COLUMNS.map(function() { return '?'; }).join(',');
  await tx.run(
    'INSERT INTO journal_entries (' + ENTRY_COLUMNS.join(',') + ') VALUES (' + placeholders + ')',
    ENTRY_COLUMNS.map(function(column) { return nullable(row[column]); })
  );
}

function storedValue(catalog, value) {
  const status = value.value_status == null ? 'observed' : value.value_status;
  const attribute = catalog && catalog.vocabByCode instanceof Map
    ? catalog.vocabByCode.get(value.attribute_code)
    : null;
  const semanticValue = value.value != null
    ? value.value
    : value.value_num != null
      ? value.value_num
      : value.value_text;
  let valueNum = null;
  let valueText = null;
  if (status === 'observed') {
    if (attribute && attribute.value_type === 'boolean') {
      valueNum = semanticValue ? 1 : 0;
    } else if ((attribute && attribute.value_type === 'number') || typeof semanticValue === 'number') {
      valueNum = semanticValue;
    } else if (semanticValue != null) {
      valueText = String(semanticValue);
    }
  }
  return {
    attribute_code: value.attribute_code,
    group_index: value.group_index == null ? 0 : value.group_index,
    value_status: status,
    value_num: nullable(valueNum),
    value_text: nullable(valueText),
    unit_code: nullable(value.unit_code),
    entered_value_num: nullable(value.entered_value_num),
    entered_unit_code: nullable(value.entered_unit_code),
  };
}

async function persistValues(tx, catalog, entryUuid, values, allowIncomplete) {
  const stored = (Array.isArray(values) ? values : []).map(function(value) {
    return storedValue(catalog, value);
  }).sort(function(left, right) {
    return left.group_index - right.group_index ||
      (left.attribute_code < right.attribute_code ? -1 : left.attribute_code > right.attribute_code ? 1 : 0);
  });
  for (const value of stored) {
    if (allowIncomplete && value.value_status === 'observed' &&
        value.value_num == null && value.value_text == null) {
      continue;
    }
    await tx.run(
      'INSERT INTO journal_entry_values (' +
        'entry_uuid,attribute_code,group_index,value_status,value_num,value_text,' +
        'unit_code,entered_value_num,entered_unit_code' +
      ') VALUES (?,?,?,?,?,?,?,?,?)',
      [
        entryUuid,
        value.attribute_code,
        value.group_index,
        value.value_status,
        value.value_num,
        value.value_text,
        value.unit_code,
        value.entered_value_num,
        value.entered_unit_code,
      ]
    );
  }
}

function occurrenceFor(input, plot) {
  const timezone = input.occurred_timezone || plot.zone_timezone;
  if (!timezone) throw lifecycleError('invalid_timezone', 'An occurrence timezone is required');
  const start = resolveLocalTime(
    input.occurred_start_local,
    timezone,
    input.occurred_utc_offset_minutes
  );
  let end = null;
  if (input.occurred_end_local == null) {
    if (input.occurred_end_utc_offset_minutes != null) {
      throw lifecycleError('invalid_utc_offset', 'An end UTC offset requires an occurrence end');
    }
  } else {
    end = resolveLocalTime(
      input.occurred_end_local,
      timezone,
      input.occurred_end_utc_offset_minutes
    );
  }
  if (end && start.instant > end.instant) {
    throw lifecycleError('invalid_time_range', 'Occurrence end must not be before its start');
  }
  return {
    timezone,
    start,
    end,
  };
}

function assertOwnedEntry(entry, principal) {
  if (entry.gateway_device_eui !== principal.gateway_device_eui ||
      entry.owner_user_uuid !== principal.owner_user_uuid ||
      Number(entry.user_id) !== Number(principal.user_id)) {
    throw lifecycleError('ownership', 'Journal entry is not owned by this principal and gateway');
  }
}

function assertBaseVersion(entry, baseSyncVersion) {
  if (!Number.isInteger(baseSyncVersion) || Number(entry.sync_version) !== baseSyncVersion) {
    throw lifecycleError('stale_version', 'Journal entry version is stale');
  }
}

function batchUuidForCorrection(input, existing) {
  const supplied = Object.prototype.hasOwnProperty.call(input, 'batch_uuid') &&
    input.batch_uuid !== undefined;
  const existingBatchUuid = nullable(existing.batch_uuid);
  if (supplied && nullable(input.batch_uuid) !== existingBatchUuid) {
    throw lifecycleError('immutable_batch_uuid', 'A correction cannot change batch provenance');
  }
  return existingBatchUuid;
}

async function runAfterValuesHook(principal, details) {
  const hooks = principal.lifecycle_hooks;
  if (hooks && typeof hooks.afterValues === 'function') {
    await hooks.afterValues(details);
  }
}

async function emitJournalOutbox(tx, source, op) {
  let aggregate;
  let aggregateType;
  let aggregateKey;
  let syncVersion;
  let occurredAt;
  let gatewayDeviceEui;
  let entry = null;
  const entryUuid = typeof source === 'string' ? source : source && source.entry_uuid;
  if (entryUuid) {
    entry = await tx.get(
      'SELECT * FROM journal_entries WHERE entry_uuid=?',
      [entryUuid]
    );
    const values = await tx.all(
      'SELECT * FROM journal_entry_values WHERE entry_uuid=? ORDER BY group_index,attribute_code',
      [entryUuid]
    );
    aggregate = buildAggregate(Object.assign({ contract_version: 1 }, entry), values);
    aggregateType = 'JOURNAL_ENTRY';
    aggregateKey = entryUuid;
    syncVersion = entry.sync_version;
    occurredAt = entry.updated_at;
    gatewayDeviceEui = entry.gateway_device_eui;
  } else {
    aggregate = source.aggregate;
    aggregateType = source.aggregate_type;
    aggregateKey = source.aggregate_key;
    syncVersion = source.sync_version;
    occurredAt = source.occurred_at;
    gatewayDeviceEui = source.gateway_device_eui;
  }
  const eventUuid = source && source.event_uuid ? source.event_uuid : crypto.randomUUID();
  await tx.run(
    'INSERT INTO sync_outbox (' +
      'event_uuid,aggregate_type,aggregate_key,op,payload_json,sync_version,occurred_at,gateway_device_eui' +
    ') VALUES (?,?,?,?,?,?,?,?)',
    [
      eventUuid,
      aggregateType,
      aggregateKey,
      op,
      JSON.stringify(aggregate),
      syncVersion,
      occurredAt,
      gatewayDeviceEui,
    ]
  );
  return { aggregate, entry, event_uuid: eventUuid };
}

function safeDuplicateCandidate(candidate) {
  return {
    entryUuid: candidate.entry_uuid,
    occurredStart: candidate.occurred_start,
    activityCode: candidate.activity_code,
    plotUuid: candidate.plot_uuid,
  };
}

function idempotencyConflict(message) {
  const error = lifecycleError('idempotency_conflict', message);
  error.statusCode = 409;
  return error;
}

function batchMemberKey(member) {
  return member.entry_uuid + '\u0000' + member.plot_uuid;
}

function batchMemberIntent(input, member) {
  const intent = {
    intent_version: 1,
    entry_uuid: member.entry_uuid,
    plot_uuid: member.plot_uuid,
  };
  for (const field of BATCH_INTENT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(input, field)) intent[field] = input[field];
  }
  if (Array.isArray(intent.values)) {
    intent.values = intent.values.map(function(value) {
      return Object.assign({}, value, {
        group_index: value.group_index == null ? 0 : value.group_index,
        value_status: value.value_status == null ? 'observed' : value.value_status,
      });
    }).sort(function(left, right) {
      return left.group_index - right.group_index ||
        (left.attribute_code < right.attribute_code ? -1 : left.attribute_code > right.attribute_code ? 1 : 0);
    });
  }
  return intent;
}

function batchMemberEventUuid(input, member) {
  const bytes = Buffer.from(aggregateHash(batchMemberIntent(input, member)), 'hex')
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' + hex.slice(20);
}

async function persistedEntryReceipt(tx, entry, expectedEventUuid) {
  const receipt = await tx.get(
    "SELECT event_uuid FROM sync_outbox WHERE aggregate_type='JOURNAL_ENTRY' " +
      "AND aggregate_key=? AND op='JOURNAL_ENTRY_UPSERTED' AND sync_version=? " +
      'ORDER BY rowid DESC LIMIT 1',
    [entry.entry_uuid, entry.sync_version]
  );
  if (!receipt || typeof receipt.event_uuid !== 'string' || !receipt.event_uuid) {
    throw idempotencyConflict('A persisted journal entry is missing its current outbox receipt');
  }
  if (expectedEventUuid && receipt.event_uuid !== expectedEventUuid) {
    throw idempotencyConflict('A batch retry does not match the original write intent');
  }
  return {
    entry_uuid: entry.entry_uuid,
    outbox_event_uuid: receipt.event_uuid,
    sync_version: entry.sync_version,
  };
}

async function existingBatchRetry(tx, input, members, existingEntries) {
  if (existingEntries.size !== members.length) {
    throw idempotencyConflict('A batch retry cannot mix existing and new member UUIDs');
  }
  for (const entry of existingEntries.values()) {
    if (entry.status !== 'final') {
      throw idempotencyConflict('A batch retry requires final persisted entries');
    }
    if (entry.sync_version !== 1) {
      throw idempotencyConflict('A batch retry requires the original version-one batch state');
    }
  }
  const batchUuids = [...existingEntries.values()].map(function(entry) {
    return entry.batch_uuid;
  });
  const batchUuid = batchUuids[0];
  if (!batchUuid || batchUuids.some(function(value) { return value !== batchUuid; })) {
    throw idempotencyConflict('A batch retry requires one non-null persisted batch UUID');
  }

  const persisted = await tx.all(
    "SELECT entry_uuid,plot_uuid FROM journal_entries WHERE batch_uuid=? AND status='final' AND deleted_at IS NULL",
    [batchUuid]
  );
  const requestedKeys = new Set(members.map(batchMemberKey));
  const persistedKeys = new Set(persisted.map(batchMemberKey));
  if (requestedKeys.size !== persistedKeys.size ||
      [...requestedKeys].some(function(key) { return !persistedKeys.has(key); })) {
    throw idempotencyConflict('A batch retry must match the persisted final batch members exactly');
  }

  const entries = [];
  for (const member of members) {
    entries.push(Object.assign({ plot_uuid: member.plot_uuid }, await persistedEntryReceipt(
      tx,
      existingEntries.get(member.entry_uuid),
      batchMemberEventUuid(input, member)
    )));
  }
  return { batch_uuid: batchUuid, entries };
}

async function findDuplicateCandidate(tx, input, plot, occurrence, excludeEntryUuid) {
  if (!plot.plot_uuid) return;
  const occurredMs = Date.parse(occurrence.start.instant);
  const lowerBound = new Date(occurredMs - 60 * 60 * 1000).toISOString();
  const upperBound = new Date(occurredMs + 60 * 60 * 1000).toISOString();
  const candidate = await tx.get(
    'SELECT entry_uuid,occurred_start,activity_code,plot_uuid FROM journal_entries ' +
    "WHERE plot_uuid=? AND activity_code=? AND status='final' AND deleted_at IS NULL " +
      'AND (? IS NULL OR entry_uuid<>?) ' +
      'AND occurred_start BETWEEN ? AND ? ' +
    'ORDER BY ABS(julianday(occurred_start)-julianday(?)),entry_uuid LIMIT 1',
    [
      plot.plot_uuid,
      input.activity_code,
      nullable(excludeEntryUuid),
      nullable(excludeEntryUuid),
      lowerBound,
      upperBound,
      occurrence.start.instant,
    ]
  );
  return candidate;
}

async function assertNoDuplicateCandidate(
  tx,
  input,
  plot,
  occurrence,
  excludeEntryUuid,
  acknowledgedEntryUuids
) {
  const candidate = await findDuplicateCandidate(tx, input, plot, occurrence, excludeEntryUuid);
  if (!candidate) return;
  const acknowledged = input.duplicate_guard_ack_entry_uuid == null
    ? null
    : normalizeUuid(input.duplicate_guard_ack_entry_uuid, 'duplicate_guard_ack_entry_uuid', true);
  if (acknowledged === candidate.entry_uuid ||
      (acknowledgedEntryUuids && acknowledgedEntryUuids.has(candidate.entry_uuid))) return;
  const error = lifecycleError('duplicate_candidate', 'A similar final journal entry already exists');
  error.statusCode = 409;
  error.details = {
    duplicateCandidate: safeDuplicateCandidate(candidate),
  };
  throw error;
}

function assertJournalEntryEffectKey(effectKey, entryUuid, appliedSyncVersion) {
  if (typeof entryUuid !== 'string' || !CANONICAL_UUID.test(entryUuid)) {
    throw lifecycleError('invalid_effect_key', 'Journal effect-key entry UUID must be canonical');
  }
  if (!Number.isInteger(appliedSyncVersion) || appliedSyncVersion < 1) {
    throw lifecycleError('invalid_effect_key', 'Applied journal sync version must be a positive integer');
  }
  const expected = 'journal_entry:' + entryUuid + ':' + (appliedSyncVersion - 1);
  if (effectKey !== expected) {
    throw lifecycleError('invalid_effect_key', 'Command effect key does not match the journal mutation');
  }
}

function commandIdFromPrincipal(principal) {
  return typeof principal.command_id === 'string' && principal.command_id.trim()
    ? principal.command_id
    : null;
}

function ackCommandIdFromPrincipal(principal, commandId) {
  if (principal.delivery_command_id == null) return commandId;
  if (!Number.isSafeInteger(principal.delivery_command_id) || principal.delivery_command_id <= 0) {
    throw lifecycleError('invalid_command_id', 'Pending delivery command ID must be a positive integer');
  }
  return principal.delivery_command_id;
}

function assertCommandJournalEntryEffectKey(principal, terminal) {
  if (!commandIdFromPrincipal(principal)) return;
  assertJournalEntryEffectKey(principal.effect_key, terminal.entry_uuid, terminal.sync_version);
}

async function recordTerminalCommand(tx, principal, terminal) {
  const commandId = commandIdFromPrincipal(principal);
  if (!commandId) return;
  const expectedCommandType = terminal.expected_command_type || 'UPSERT_JOURNAL_ENTRY';
  const suppliedCommandType = typeof principal.command_type === 'string' &&
    principal.command_type.trim()
    ? principal.command_type
    : null;
  if (suppliedCommandType && suppliedCommandType !== expectedCommandType) {
    throw lifecycleError('invalid_command_type', 'Command type does not match the journal mutation');
  }
  const commandType = suppliedCommandType || expectedCommandType;
  const effectKey = nullable(principal.effect_key);
  const appliedAt = new Date().toISOString();
  const payloadHash = aggregateHash(terminal.aggregate);
  const facts = {
    commandId: ackCommandIdFromPrincipal(principal, commandId),
    commandType,
    status: 'ACKED',
    result: 'APPLIED',
    duplicate: false,
    entryUuid: terminal.entry_uuid,
    ownerUserUuid: principal.owner_user_uuid,
    authorPrincipalUuid: principal.author_principal_uuid,
    authorLabel: principal.author_label == null ? null : principal.author_label,
    appliedSyncVersion: terminal.sync_version,
    effectKey,
    payloadHash,
    submittedIntentHash: principal.submitted_intent_hash || null,
    gatewayDeviceEui: terminal.gateway_device_eui,
    appliedAt,
  };
  await tx.run(
    'INSERT INTO applied_commands (' +
      'command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator' +
    ') VALUES (?,?,?,?,?,?,?,?)',
    [
      commandId,
      terminal.gateway_device_eui,
      commandType,
      effectKey,
      appliedAt,
      'APPLIED',
      JSON.stringify(facts),
      'edge',
    ]
  );
  const hooks = principal.lifecycle_hooks;
  if (hooks && typeof hooks.afterCommandLedger === 'function') {
    await hooks.afterCommandLedger({
      command_id: commandId,
      command_type: commandType,
      entry_uuid: terminal.entry_uuid,
      applied_sync_version: terminal.sync_version,
      effect_key: effectKey,
      payload_hash: payloadHash,
    });
  }
  const ack = facts;
  await tx.run(
    'DELETE FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
    [commandId]
  );
  await tx.run(
    'INSERT INTO command_ack_outbox (command_id,payload_json,created_at) VALUES (?,?,?)',
    [commandId, JSON.stringify(ack), appliedAt]
  );
  if (hooks && typeof hooks.afterCommand === 'function') {
    await hooks.afterCommand({
      command_id: commandId,
      command_type: commandType,
      entry_uuid: terminal.entry_uuid,
      applied_sync_version: terminal.sync_version,
      effect_key: effectKey,
      payload_hash: payloadHash,
      gateway_device_eui: terminal.gateway_device_eui,
      applied_at: appliedAt,
    });
  }
}

async function replaceExistingWithFinal(
  tx,
  catalog,
  existing,
  normalized,
  principal,
  entryIndex,
  plot,
  occurrence,
  season,
  catalogVersion,
  contextJson,
  nextVersion
) {
  const replacement = entryRow(normalized, principal, plot, season, occurrence, catalogVersion, {
    entry_uuid: existing.entry_uuid,
    batch_uuid: normalized.batch_uuid,
    status: 'final',
    context_json: contextJson,
    sync_version: nextVersion,
  });
  replacement.owner_user_uuid = existing.owner_user_uuid;
  replacement.user_id = existing.user_id;
  replacement.author_principal_uuid = existing.author_principal_uuid;
  replacement.author_label = existing.author_label;
  replacement.recorded_at = existing.recorded_at;
  replacement.origin = existing.origin;
  replacement.created_at = existing.created_at;
  replacement.gateway_device_eui = existing.gateway_device_eui;
  await tx.run(
    'UPDATE journal_entries SET ' + CORRECTION_COLUMNS.map(function(column) {
      return column + '=?';
    }).join(',') + ' WHERE entry_uuid=? AND sync_version=?',
    CORRECTION_COLUMNS.map(function(column) {
      return nullable(replacement[column]);
    }).concat([existing.entry_uuid, existing.sync_version])
  );
  await tx.run('DELETE FROM journal_entry_values WHERE entry_uuid=?', [existing.entry_uuid]);
  await persistValues(tx, catalog, existing.entry_uuid, normalized.values, false);
  await runAfterValuesHook(principal, {
    entry_index: entryIndex,
    entry_uuid: existing.entry_uuid,
    plot_uuid: replacement.plot_uuid,
    batch_uuid: replacement.batch_uuid,
    sync_version: nextVersion,
  });
  const emission = await emitJournalOutbox(
    tx,
    existing.entry_uuid,
    'JOURNAL_ENTRY_UPSERTED'
  );
  const terminal = {
    aggregate: emission.aggregate,
    entry_uuid: existing.entry_uuid,
    sync_version: nextVersion,
    gateway_device_eui: existing.gateway_device_eui,
  };
  assertCommandJournalEntryEffectKey(principal, terminal);
  await recordTerminalCommand(tx, principal, terminal);
  return {
    entry_uuid: existing.entry_uuid,
    outbox_event_uuid: emission.event_uuid,
    sync_version: nextVersion,
  };
}

async function correctFinalInTransaction(tx, catalog, input, principal, entryIndex, existing) {
  assertOwnedEntry(existing, principal);
  const originalValues = await tx.all(
    'SELECT * FROM journal_entry_values WHERE entry_uuid=? ORDER BY group_index,attribute_code',
    [existing.entry_uuid]
  );
  assertBaseVersion(existing, input.base_sync_version);
  if (existing.status !== 'final') {
    throw lifecycleError('invalid_state', 'Only a final journal entry can be corrected');
  }

  const plot = await resolvePlotContext(tx, input.plot_uuid, principal);
  if (plot.gateway_device_eui !== existing.gateway_device_eui ||
      plot.owner_user_uuid !== existing.owner_user_uuid ||
      Number(plot.user_id) !== Number(existing.user_id)) {
    throw lifecycleError('ownership', 'Correction would move the entry outside its owner and gateway');
  }
  const occurrence = occurrenceFor(input, plot);
  await assertNoDuplicateCandidate(tx, input, plot, occurrence, existing.entry_uuid);
  const deviceEui = await resolveDeviceEui(tx, input.device_eui, principal, plot);
  const candidate = Object.assign({}, input, {
    owner_user_uuid: existing.owner_user_uuid,
    user_id: existing.user_id,
    author_principal_uuid: existing.author_principal_uuid,
    author_label: existing.author_label,
    gateway_device_eui: existing.gateway_device_eui,
    device_eui: deviceEui,
    batch_uuid: batchUuidForCorrection(input, existing),
    origin: existing.origin,
    occurred_timezone: occurrence.timezone,
    context: null,
    context_json: null,
  });
  delete candidate.duplicate_guard_ack_entry_uuid;
  const definitions = await validationDefinitions(tx, {
    layout_code: existing.layout_code,
    layout_version: existing.layout_version,
    template_code: existing.template_code,
    template_version: existing.template_version,
  });
  const originalEntry = Object.assign({}, existing, { values: originalValues });
  const referenceValues = await referenceValuesForFinalization(tx, plot, principal);
  const validation = validateEntry(
    catalog,
    definitions.layout,
    definitions.template,
    candidate,
    { mode: 'correction', originalEntry, referenceValues }
  );
  if (!validation.ok) {
    throw entryValidationError('Journal correction validation failed', validation);
  }
  const normalized = validation.normalized;
  // S2 (review fix): reject a correction that would leave crop-cycle state
  // inconsistent (see assertCorrectionWontDesyncCycle) BEFORE writing
  // anything, rather than silently desyncing journal_crop_cycle(_plots).
  await assertCorrectionWontDesyncCycle(tx, existing, occurrence, normalized);
  const frozenSeason = frozenSeasonForCorrection(existing, plot, occurrence);
  const season = frozenSeason && frozenSeason.preserve
    ? frozenSeason.season
    : await resolveSeason(tx, plot, occurrence.start.localDate, normalized, true);
  const catalogVersion = await currentCatalogVersion(tx, catalog);
  const contextJson = sameContextDeterminants(existing, plot, deviceEui, occurrence)
    ? nullable(existing.context_json)
    : await generatedContextJson(tx, plot, deviceEui, occurrence);
  const nextVersion = Number(existing.sync_version) + 1;
  const result = await replaceExistingWithFinal(
    tx,
    catalog,
    existing,
    normalized,
    principal,
    entryIndex,
    plot,
    occurrence,
    season,
    catalogVersion,
    contextJson,
    nextVersion
  );
  // D13 (narrow scope, see applySeedingCorrectionCascade): propagate a
  // corrected seeding's crop/variety into the cycle it opened.
  await applySeedingCorrectionCascade(tx, existing, plot, normalized);
  return result;
}

async function promoteDraftInTransaction(tx, catalog, input, principal, entryIndex, existing) {
  assertOwnedEntry(existing, principal);
  assertBaseVersion(existing, input.base_sync_version);
  if (existing.status !== 'draft' || Number(existing.sync_version) !== 0) {
    throw lifecycleError('invalid_state', 'Only a version-zero draft can be finalized');
  }
  const plot = await resolvePlotContext(tx, input.plot_uuid, principal);
  if (plot.gateway_device_eui !== existing.gateway_device_eui ||
      plot.owner_user_uuid !== existing.owner_user_uuid ||
      Number(plot.user_id) !== Number(existing.user_id)) {
    throw lifecycleError('ownership', 'Draft promotion would move the entry outside its owner and gateway');
  }
  const occurrence = occurrenceFor(input, plot);
  await assertNoDuplicateCandidate(tx, input, plot, occurrence, existing.entry_uuid);
  const deviceEui = await resolveDeviceEui(tx, input.device_eui, principal, plot);
  const candidate = Object.assign({}, input, {
    owner_user_uuid: existing.owner_user_uuid,
    user_id: existing.user_id,
    author_principal_uuid: existing.author_principal_uuid,
    author_label: existing.author_label,
    gateway_device_eui: existing.gateway_device_eui,
    device_eui: deviceEui,
    origin: existing.origin,
    occurred_timezone: occurrence.timezone,
    context: null,
    context_json: null,
  });
  delete candidate.duplicate_guard_ack_entry_uuid;
  const definitions = await validationDefinitions(tx, candidate);
  const referenceValues = await referenceValuesForFinalization(tx, plot, principal);
  const validation = validateEntry(
    catalog,
    definitions.layout,
    definitions.template,
    candidate,
    { referenceValues }
  );
  if (!validation.ok) {
    throw entryValidationError('Journal draft finalization validation failed', validation);
  }
  const normalized = validation.normalized;
  const season = await resolveSeason(tx, plot, occurrence.start.localDate, normalized, true);
  const catalogVersion = await currentCatalogVersion(tx, catalog);
  const contextJson = await generatedContextJson(tx, plot, deviceEui, occurrence);
  const result = await replaceExistingWithFinal(
    tx,
    catalog,
    existing,
    normalized,
    principal,
    entryIndex,
    plot,
    occurrence,
    season,
    catalogVersion,
    contextJson,
    1
  );
  // A draft's first finalization is functionally a create: run the same
  // seeding/harvest/manual-close cascade createFinalInTransaction runs.
  await applyActivityCycleCascade(
    tx, principal, plot, occurrence, existing.entry_uuid, normalized.activity_code, input, normalized.values
  );
  // B1(c) (review fix): replaceExistingWithFinal already emitted the outbox
  // event and recorded the terminal command BEFORE the cascade above ran, so
  // re-read the entry's sync_version now and make the RETURNED payload agree
  // with the DB. freezeClosedSpan's excludeEntryUuid guard means this
  // entry's own row is never touched by its own cascade, so this is
  // defensive (matches createFinalInTransaction's equivalent re-read) rather
  // than expected to change anything today.
  const refreshed = await tx.get(
    'SELECT sync_version FROM journal_entries WHERE entry_uuid=?',
    [existing.entry_uuid]
  );
  result.sync_version = Number(refreshed.sync_version);
  return result;
}

async function createFinalInTransaction(tx, catalog, input, principal, entryIndex, contextCache, options) {
  await validatePrincipal(tx, principal);
  const existing = await tx.get(
    'SELECT * FROM journal_entries WHERE entry_uuid=? AND deleted_at IS NULL',
    [input.entry_uuid]
  );
  if (existing && options && options.createOnly) {
    throw lifecycleError('already_exists', 'Journal entry already exists');
  }
  if (existing && existing.status === 'draft') {
    return promoteDraftInTransaction(tx, catalog, input, principal, entryIndex, existing);
  }
  if (existing) {
    return correctFinalInTransaction(tx, catalog, input, principal, entryIndex, existing);
  }
  if (input.base_sync_version !== 0) {
    throw lifecycleError('not_found', 'Journal entry to correct was not found');
  }

  const plot = await resolvePlotContext(tx, input.plot_uuid, principal);
  const occurrence = occurrenceFor(input, plot);
  await assertNoDuplicateCandidate(
    tx,
    input,
    plot,
    occurrence,
    null,
    options && options.duplicateAcknowledgements
  );
  const deviceEui = await resolveDeviceEui(tx, input.device_eui, principal, plot);
  const candidate = Object.assign({}, input, {
    owner_user_uuid: plot.owner_user_uuid,
    user_id: plot.user_id,
    author_principal_uuid: principal.author_principal_uuid,
    author_label: principal.author_label,
    gateway_device_eui: plot.gateway_device_eui,
    device_eui: deviceEui,
    origin: principal.origin,
    occurred_timezone: occurrence.timezone,
    context: null,
    context_json: null,
  });
  delete candidate.duplicate_guard_ack_entry_uuid;
  delete candidate.duplicate_guard_ack_entry_uuids;
  const definitions = await validationDefinitions(tx, candidate);
  const referenceValues = await referenceValuesForFinalization(tx, plot, principal);
  const validation = validateEntry(
    catalog,
    definitions.layout,
    definitions.template,
    candidate,
    { referenceValues }
  );
  if (!validation.ok) {
    throw entryValidationError('Journal entry validation failed', validation);
  }
  const normalized = validation.normalized;
  const season = await resolveSeason(tx, plot, occurrence.start.localDate, normalized, true);
  const catalogVersion = await currentCatalogVersion(tx, catalog);
  const contextJson = await generatedContextJson(tx, plot, deviceEui, occurrence, contextCache);
  const row = entryRow(normalized, principal, plot, season, occurrence, catalogVersion, {
    entry_uuid: input.entry_uuid,
    batch_uuid: input.batch_uuid,
    status: 'final',
    context_json: contextJson,
    sync_version: 1,
  });
  await insertEntry(tx, row);
  await persistValues(tx, catalog, row.entry_uuid, normalized.values, false);
  await runAfterValuesHook(principal, {
    entry_index: entryIndex,
    entry_uuid: row.entry_uuid,
    plot_uuid: row.plot_uuid,
    batch_uuid: row.batch_uuid,
    sync_version: row.sync_version,
  });
  await applyActivityCycleCascade(
    tx, principal, plot, occurrence, row.entry_uuid, normalized.activity_code, input, normalized.values
  );
  const emission = await emitJournalOutbox(
    tx,
    options && options.outbox_event_uuid
      ? { entry_uuid: row.entry_uuid, event_uuid: options.outbox_event_uuid }
      : row.entry_uuid,
    'JOURNAL_ENTRY_UPSERTED'
  );
  // B1(c) (review fix): re-read the post-cascade sync_version from the row
  // emitJournalOutbox just fetched (rather than trusting the in-memory `row`
  // captured before the cascade ran) so the terminal command record and the
  // returned/ACK payload always agree with the DB, even if a future cascade
  // path ever legitimately touches this entry's own version.
  const finalSyncVersion = Number(emission.entry.sync_version);
  const terminal = {
    aggregate: emission.aggregate,
    entry_uuid: row.entry_uuid,
    sync_version: finalSyncVersion,
    gateway_device_eui: row.gateway_device_eui,
  };
  assertCommandJournalEntryEffectKey(principal, terminal);
  await recordTerminalCommand(tx, principal, terminal);
  return {
    entry_uuid: row.entry_uuid,
    outbox_event_uuid: emission.event_uuid,
    sync_version: finalSyncVersion,
  };
}

async function saveDraft(db, catalog, input, principal) {
  validateDraftLimits(input, principal);
  input = normalizeInputIdentities(input);
  return db.transaction(async function(tx) {
    await validatePrincipal(tx, principal);
    const entryUuid = input.entry_uuid || crypto.randomUUID();
    const existing = await tx.get(
      'SELECT * FROM journal_entries WHERE entry_uuid=? AND deleted_at IS NULL',
      [entryUuid]
    );
    const plot = await resolvePlotContext(tx, input.plot_uuid, principal);
    const occurrence = occurrenceFor(input, plot);
    const deviceEui = await resolveDeviceEui(tx, input.device_eui, principal, plot);
    const draftInput = Object.assign({}, input, { device_eui: deviceEui });
    const season = await resolveSeason(tx, plot, occurrence.start.localDate, draftInput, false);
    const catalogVersion = await currentCatalogVersion(tx, catalog);
    const row = entryRow(draftInput, principal, plot, season, occurrence, catalogVersion, {
      entry_uuid: entryUuid,
      batch_uuid: input.batch_uuid,
      status: 'draft',
      sync_version: 0,
    });
    if (existing) {
      assertOwnedEntry(existing, principal);
      if (Number(existing.sync_version) !== 0 || input.base_sync_version !== 0) {
        throw lifecycleError('stale_version', 'Only version-zero drafts can be updated');
      }
      if (existing.status !== 'draft') {
        throw lifecycleError('invalid_state', 'Only a draft journal entry can be saved as a draft');
      }
      row.owner_user_uuid = existing.owner_user_uuid;
      row.user_id = existing.user_id;
      row.author_principal_uuid = existing.author_principal_uuid;
      row.author_label = existing.author_label;
      row.recorded_at = existing.recorded_at;
      row.origin = existing.origin;
      row.created_at = existing.created_at;
      row.gateway_device_eui = existing.gateway_device_eui;
      await tx.run(
        'UPDATE journal_entries SET ' + CORRECTION_COLUMNS.map(function(column) {
          return column + '=?';
        }).join(',') + ' WHERE entry_uuid=? AND sync_version=?',
        CORRECTION_COLUMNS.map(function(column) {
          return nullable(row[column]);
        }).concat([entryUuid, 0])
      );
      await tx.run('DELETE FROM journal_entry_values WHERE entry_uuid=?', [entryUuid]);
      await persistValues(tx, catalog, entryUuid, input.values, true);
      return { entry_uuid: entryUuid, sync_version: 0 };
    }
    await insertEntry(tx, row);
    await persistValues(tx, catalog, entryUuid, input.values, true);
    return { entry_uuid: entryUuid, sync_version: 0 };
  });
}

async function finalize(db, catalog, input, principal) {
  validateRequestLimit(input);
  input = normalizeInputIdentities(input);
  return db.transaction(function(tx) {
    return createFinalInTransaction(tx, catalog, input, principal, 0);
  });
}

async function finalizeCreate(db, catalog, input, principal) {
  validateRequestLimit(input);
  input = normalizeInputIdentities(input);
  return db.transaction(function(tx) {
    return createFinalInTransaction(tx, catalog, input, principal, 0, null, { createOnly: true });
  });
}

async function finalizeBatch(db, catalog, input, members, principal) {
  validateRequestLimit(input);
  input = normalizeInputIdentities(input);
  members = normalizeBatchMembers(members);
  const acknowledgementValues = input.duplicate_guard_ack_entry_uuids == null
    ? []
    : input.duplicate_guard_ack_entry_uuids;
  if (!Array.isArray(acknowledgementValues) || acknowledgementValues.length > 100 ||
      acknowledgementValues.some(function(value) { return !CANONICAL_UUID.test(value); }) ||
      new Set(acknowledgementValues).size !== acknowledgementValues.length) {
    throw lifecycleError('invalid_duplicate_ack', 'Batch duplicate acknowledgements are invalid');
  }
  const acknowledgements = new Set(acknowledgementValues);
  return db.transaction(async function(tx) {
    const duplicateCandidates = [];
    const existingEntries = new Map();
    const newMembers = [];
    for (const member of members) {
      const existing = await tx.get(
        'SELECT * FROM journal_entries WHERE entry_uuid=?',
        [member.entry_uuid]
      );
      if (existing) {
        assertOwnedEntry(existing, principal);
        if (existing.deleted_at != null) {
          throw idempotencyConflict('A batch retry cannot replay a deleted journal entry');
        }
        if (existing.plot_uuid !== member.plot_uuid) {
          throw idempotencyConflict('Entry UUID is already assigned to another plot');
        }
        existingEntries.set(member.entry_uuid, existing);
      } else {
        const plot = await resolvePlotContext(tx, member.plot_uuid, principal);
        newMembers.push({ member, plot });
      }
    }
    if (existingEntries.size) {
      if (existingEntries.size !== members.length) {
        throw idempotencyConflict('A batch retry cannot mix existing and new member UUIDs');
      }
      return existingBatchRetry(tx, input, members, existingEntries);
    }
    for (const item of newMembers) {
      const member = item.member;
      const plot = item.plot;
      const candidateInput = Object.assign({}, input, { plot_uuid: member.plot_uuid });
      const occurrence = occurrenceFor(candidateInput, plot);
      const candidate = await findDuplicateCandidate(tx, candidateInput, plot, occurrence, null);
      if (candidate) duplicateCandidates.push(safeDuplicateCandidate(candidate));
    }
    const candidateUuids = new Set(duplicateCandidates.map(function(candidate) {
      return candidate.entryUuid;
    }));
    for (const acknowledged of acknowledgements) {
      if (!candidateUuids.has(acknowledged)) {
        const error = lifecycleError(
          'invalid_duplicate_ack',
          'A batch duplicate acknowledgement does not match a current candidate'
        );
        error.statusCode = 422;
        throw error;
      }
    }
    const unacknowledged = duplicateCandidates.filter(function(candidate) {
      return !acknowledgements.has(candidate.entryUuid);
    });
    if (unacknowledged.length) {
      const error = lifecycleError(
        'duplicate_candidates',
        'Similar final journal entries already exist'
      );
      error.statusCode = 409;
      error.details = { duplicateCandidates: unacknowledged };
      throw error;
    }
    const batchUuid = crypto.randomUUID();
    const contextCache = new Map();
    const entries = [];
    for (let index = 0; index < members.length; index += 1) {
      const member = members[index];
      const entryInput = Object.assign({}, input, {
        entry_uuid: member.entry_uuid,
        plot_uuid: member.plot_uuid,
        batch_uuid: batchUuid,
        base_sync_version: 0,
      });
      const result = await createFinalInTransaction(
        tx,
        catalog,
        entryInput,
        principal,
        index,
        contextCache,
        {
          duplicateAcknowledgements: acknowledgements,
          outbox_event_uuid: batchMemberEventUuid(input, member),
        }
      );
      entries.push(Object.assign({ plot_uuid: member.plot_uuid }, result));
    }
    return { batch_uuid: batchUuid, entries };
  });
}

async function void_(db, _catalog, entryUuid, baseSyncVersion, reason, principal, options) {
  entryUuid = normalizeUuid(entryUuid, 'entry_uuid', true);
  options = options || {};
  return db.transaction(async function(tx) {
    await validatePrincipal(tx, principal);
    const entry = await tx.get(
      'SELECT * FROM journal_entries WHERE entry_uuid=? AND deleted_at IS NULL',
      [entryUuid]
    );
    if (!entry) throw lifecycleError('not_found', 'Journal entry was not found');
    assertOwnedEntry(entry, principal);
    assertBaseVersion(entry, baseSyncVersion);
    if (entry.status !== 'final') {
      throw lifecycleError('invalid_state', 'Only a final journal entry can be voided');
    }
    if (typeof reason !== 'string' || !reason.trim() || Array.from(reason).length > 4000) {
      throw lifecycleError('invalid_reason', 'Void reason must contain between 1 and 4000 characters');
    }
    // D13/R7: void cascades for a seeding (soft-delete its cycle, guarded by
    // dependents) or a harvest/manual-close (reopen + un-freeze, guarded by
    // a reopen collision). Runs before the status flip so either guard abort
    // rolls back the whole transaction, leaving nothing changed.
    await applyVoidCycleCascade(tx, entry, principal, options);
    // B1(c) (review fix): re-read the sync_version AFTER the cascade rather
    // than trusting `entry` as fetched before it ran. findCycleDependents
    // already excludes this entry_uuid from its own dependents, and (for a
    // closing entry) unfreezeClosedSpan can only match entries whose stored
    // season_crop equals the reopened cycle's crop -- which this entry's own
    // row never carries, since freezeClosedSpan excludes the entry that
    // closed a cycle from ever being frozen by it (see closeCycleMembership).
    // So this entry's own version should not change here, but re-reading
    // keeps the WHERE-clause optimistic check and the returned/ACK payload
    // honest against the DB regardless.
    const refreshed = await tx.get('SELECT sync_version FROM journal_entries WHERE entry_uuid=?', [entryUuid]);
    const now = new Date().toISOString();
    const nextVersion = Number(refreshed.sync_version) + 1;
    await tx.run(
      'UPDATE journal_entries SET ' +
        'status=?,voided_at=?,voided_by_principal_uuid=?,void_reason=?,sync_version=?,updated_at=? ' +
      'WHERE entry_uuid=? AND sync_version=?',
      [
        'voided',
        now,
        principal.author_principal_uuid,
        reason,
        nextVersion,
        now,
        entryUuid,
        refreshed.sync_version,
      ]
    );
    const emission = await emitJournalOutbox(
      tx,
      entryUuid,
      'JOURNAL_ENTRY_VOIDED'
    );
    const terminal = {
      aggregate: emission.aggregate,
      entry_uuid: entryUuid,
      sync_version: nextVersion,
      gateway_device_eui: entry.gateway_device_eui,
      expected_command_type: 'VOID_JOURNAL_ENTRY',
    };
    assertCommandJournalEntryEffectKey(principal, terminal);
    await recordTerminalCommand(tx, principal, terminal);
    return {
      entry_uuid: entryUuid,
      outbox_event_uuid: emission.event_uuid,
      sync_version: nextVersion,
    };
  });
}

async function discardDraft(db, entryUuid, principal) {
  entryUuid = normalizeUuid(entryUuid, 'entry_uuid', true);
  return db.transaction(async function(tx) {
    await validatePrincipal(tx, principal);
    const entry = await tx.get(
      'SELECT * FROM journal_entries WHERE entry_uuid=? AND deleted_at IS NULL',
      [entryUuid]
    );
    if (!entry) {
      // Idempotent: a draft that is already gone (discarded earlier, or never
      // existed) is a no-op success, not a not-found failure. There is no
      // tombstone to distinguish "already discarded" from "never existed",
      // and both are harmless to report as success.
      return { entry_uuid: entryUuid, discarded: true };
    }
    assertOwnedEntry(entry, principal);
    if (entry.status !== 'draft' || Number(entry.sync_version) !== 0) {
      throw lifecycleError('invalid_state', 'Only a version-zero draft can be discarded');
    }
    await tx.run('DELETE FROM journal_entry_values WHERE entry_uuid=?', [entryUuid]);
    await tx.run(
      'DELETE FROM journal_entries WHERE entry_uuid=? AND sync_version=?',
      [entryUuid, 0]
    );
    return { entry_uuid: entryUuid, discarded: true };
  });
}

module.exports = {
  activeCropCyclesForPlot,
  assertJournalEntryEffectKey,
  batchMemberEventUuid,
  discardDraft,
  emitJournalOutbox,
  finalize,
  finalizeCreate,
  finalizeBatch,
  openCyclesCoveringPlot,
  resolveClosedCropCycleOverrides,
  resolveLiveCropOverrides,
  saveDraft,
  void_,
};
