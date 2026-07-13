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
const INPUT_UUID_FIELDS = ['entry_uuid', 'plot_uuid', 'campaign_uuid', 'pass_uuid', 'batch_uuid'];
const EUI64 = /^[0-9a-fA-F]{16}$/;
const LOCAL_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const formatterCache = new Map();

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

function normalizeBatchPlotUuids(plotUuids) {
  const normalized = [];
  for (let index = 0; index < plotUuids.length; index += 1) {
    const plotUuid = plotUuids[index];
    if (typeof plotUuid !== 'string' || !UUID.test(plotUuid)) {
      throw lifecycleError('invalid_batch', 'Every batch member must be a plot UUID');
    }
    normalized.push(canonicalUuid(plotUuid));
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
      user_id: principal.user_id,
      owner_user_uuid: principal.owner_user_uuid,
      gateway_device_eui: principal.gateway_device_eui,
    };
  }
  const plot = await tx.get(
    'SELECT p.plot_uuid,p.owner_user_uuid AS plot_owner_user_uuid,p.gateway_device_eui,' +
      'p.zone_uuid AS plot_zone_uuid,' +
      'z.id AS zone_id,z.zone_uuid,z.user_id AS zone_user_id,z.timezone AS zone_timezone,' +
      'u.user_uuid AS zone_owner_user_uuid ' +
    'FROM journal_plots AS p ' +
    'LEFT JOIN irrigation_zones AS z ON z.zone_uuid=p.zone_uuid ' +
      'AND z.gateway_device_eui=p.gateway_device_eui AND z.deleted_at IS NULL ' +
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
      device.zone_gateway_device_eui === principal.gateway_device_eui);
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

async function resolveSeason(tx, plot, localDate, input, requireExplicit) {
  const covering = await coveringSeason(tx, plot.zone_id, localDate);
  if (covering) return covering;
  const explicitCrop = typeof input.season_crop === 'string' && input.season_crop.trim();
  if (explicitCrop) {
    return {
      season_uuid: null,
      crop_type: input.season_crop,
      variety: nullable(input.season_variety),
    };
  }
  if (requireExplicit && plot.plot_uuid != null) {
    throw lifecycleError('season_required', 'A crop is required when no covering season exists');
  }
  return null;
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
    existing.occurred_start === occurrence.start.instant;
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
  const timezone = plot.zone_timezone || input.occurred_timezone;
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
  if (typeof source === 'string') {
    entry = await tx.get(
      'SELECT * FROM journal_entries WHERE entry_uuid=?',
      [source]
    );
    const values = await tx.all(
      'SELECT * FROM journal_entry_values WHERE entry_uuid=? ORDER BY group_index,attribute_code',
      [source]
    );
    aggregate = buildAggregate(Object.assign({ contract_version: 1 }, entry), values);
    aggregateType = 'JOURNAL_ENTRY';
    aggregateKey = source;
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
  const eventUuid = crypto.randomUUID();
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

async function assertNoDuplicateCandidate(tx, input, plot, occurrence, excludeEntryUuid) {
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
  if (!candidate) return;
  const acknowledged = input.duplicate_guard_ack_entry_uuid == null
    ? null
    : normalizeUuid(input.duplicate_guard_ack_entry_uuid, 'duplicate_guard_ack_entry_uuid', true);
  if (acknowledged === candidate.entry_uuid) return;
  const error = lifecycleError('duplicate_candidate', 'A similar final journal entry already exists');
  error.statusCode = 409;
  error.details = {
    entry_uuid: candidate.entry_uuid,
    occurred_start: candidate.occurred_start,
    activity_code: candidate.activity_code,
    plot_uuid: candidate.plot_uuid,
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
    entryUuid: terminal.entry_uuid,
    ownerUserUuid: principal.owner_user_uuid,
    appliedSyncVersion: terminal.sync_version,
    effectKey,
    payloadHash,
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
  const ack = Object.assign({
    commandId: ackCommandIdFromPrincipal(principal, commandId),
    status: 'ACKED',
    result: 'APPLIED',
  }, facts);
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
  const validation = validateEntry(
    catalog,
    definitions.layout,
    definitions.template,
    candidate,
    { mode: 'correction', originalEntry }
  );
  if (!validation.ok) {
    throw entryValidationError('Journal correction validation failed', validation);
  }
  const normalized = validation.normalized;
  const frozenSeason = frozenSeasonForCorrection(existing, plot, occurrence);
  const season = frozenSeason && frozenSeason.preserve
    ? frozenSeason.season
    : await resolveSeason(tx, plot, occurrence.start.localDate, normalized, true);
  const catalogVersion = await currentCatalogVersion(tx, catalog);
  const contextJson = sameContextDeterminants(existing, plot, deviceEui, occurrence)
    ? nullable(existing.context_json)
    : await generatedContextJson(tx, plot, deviceEui, occurrence);
  const nextVersion = Number(existing.sync_version) + 1;
  return replaceExistingWithFinal(
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
  const validation = validateEntry(catalog, definitions.layout, definitions.template, candidate, {});
  if (!validation.ok) {
    throw entryValidationError('Journal draft finalization validation failed', validation);
  }
  const normalized = validation.normalized;
  const season = await resolveSeason(tx, plot, occurrence.start.localDate, normalized, true);
  const catalogVersion = await currentCatalogVersion(tx, catalog);
  const contextJson = await generatedContextJson(tx, plot, deviceEui, occurrence);
  return replaceExistingWithFinal(
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
  await assertNoDuplicateCandidate(tx, input, plot, occurrence, null);
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
  const definitions = await validationDefinitions(tx, candidate);
  const validation = validateEntry(catalog, definitions.layout, definitions.template, candidate, {});
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
  const emission = await emitJournalOutbox(
    tx,
    row.entry_uuid,
    'JOURNAL_ENTRY_UPSERTED'
  );
  const terminal = {
    aggregate: emission.aggregate,
    entry_uuid: row.entry_uuid,
    sync_version: row.sync_version,
    gateway_device_eui: row.gateway_device_eui,
  };
  assertCommandJournalEntryEffectKey(principal, terminal);
  await recordTerminalCommand(tx, principal, terminal);
  return {
    entry_uuid: row.entry_uuid,
    outbox_event_uuid: emission.event_uuid,
    sync_version: row.sync_version,
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

async function finalizeBatch(db, catalog, input, plotUuids, principal) {
  validateRequestLimit(input);
  input = normalizeInputIdentities(input);
  if (!Array.isArray(plotUuids) || plotUuids.length === 0) {
    throw lifecycleError('invalid_batch', 'Batch plots must be a nonempty array');
  }
  if (plotUuids.length > 100) {
    throw lifecycleError('batch_too_large', 'A journal batch may contain at most 100 plots');
  }
  plotUuids = normalizeBatchPlotUuids(plotUuids);
  if (new Set(plotUuids).size !== plotUuids.length) {
    throw lifecycleError('duplicate_plot', 'A journal batch cannot contain duplicate plots');
  }
  return db.transaction(async function(tx) {
    const batchUuid = crypto.randomUUID();
    const contextCache = new Map();
    const entries = [];
    for (let index = 0; index < plotUuids.length; index += 1) {
      const entryInput = Object.assign({}, input, {
        entry_uuid: crypto.randomUUID(),
        plot_uuid: plotUuids[index],
        batch_uuid: batchUuid,
        base_sync_version: 0,
      });
      const result = await createFinalInTransaction(
        tx,
        catalog,
        entryInput,
        principal,
        index,
        contextCache
      );
      entries.push(Object.assign({ plot_uuid: plotUuids[index] }, result));
    }
    return { batch_uuid: batchUuid, entries };
  });
}

async function void_(db, _catalog, entryUuid, baseSyncVersion, reason, principal) {
  entryUuid = normalizeUuid(entryUuid, 'entry_uuid', true);
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
    const now = new Date().toISOString();
    const nextVersion = Number(entry.sync_version) + 1;
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
        entry.sync_version,
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

module.exports = {
  assertJournalEntryEffectKey,
  emitJournalOutbox,
  finalize,
  finalizeCreate,
  finalizeBatch,
  saveDraft,
  void_,
};
