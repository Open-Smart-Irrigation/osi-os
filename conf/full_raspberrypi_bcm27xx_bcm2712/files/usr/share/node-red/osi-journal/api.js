'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { aggregateHash, buildAggregate } = require('./aggregate');
const { loadCatalog } = require('./catalog');
const { numericConstraintsValid, unitFacts } = require('./unit-family');

const UUID = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EUI64 = /^[0-9A-F]{16}$/;
const MAX_BODY_BYTES = 256 * 1024;
const IDENTITY_FIELDS = new Set([
  'user_id',
  'owner_user_uuid',
  'author_principal_uuid',
  'author_label',
  'principal',
  'origin',
  'gateway_device_eui',
  'gatewayDeviceEui',
]);
const RESEARCH_IDENTITY_FIELDS = new Set([
  'owner_user_uuid',
  'author_principal_uuid',
  'author_label',
  'voided_by_principal_uuid',
]);
const ENTRY_FILTERS = [
  'entry_uuid',
  'plot_uuid',
  'zone_uuid',
  'activity_code',
  'status',
  'occurred_from',
  'occurred_to',
  'campaign_uuid',
  'protocol_code',
  'protocol_version',
  'observation_unit_code',
  'batch_uuid',
  'pass_uuid',
];
const VOCAB_KINDS = new Set(['activity', 'attribute', 'unit', 'choice']);
const VALUE_TYPES = new Set(['number', 'text', 'choice', 'date', 'boolean']);
const MAPPING_ROLES = new Set([
  'concept', 'variable', 'coded_value', 'operation_type',
  'data_type_definition', 'unit_of_measure',
]);
const MAPPING_RELATIONS = new Set(['exact', 'close', 'broad', 'narrow', 'related']);
const EXPORTER_VERSION = '1.0.0';
const RESEARCH_SCHEMA_DESCRIPTOR = Object.freeze({
  name: 'osi-journal-research',
  version: 1,
  entry_shape: 'journal_entry_aggregate_without_author_or_owner_identity',
  value_shape: 'typed_long_form_with_entered_and_canonical_units',
  missing_value_field: 'value_status',
  package_members: ['entries.csv', 'values.csv', 'vocab_mappings.csv', 'manifest.json'],
});
const RESEARCH_SCHEMA_HASH = aggregateHash(RESEARCH_SCHEMA_DESCRIPTOR);
const RESEARCH_METADATA_DESCRIPTOR = Object.freeze({
  name: 'osi-journal-research-metadata',
  version: 1,
  sections: [
    'coverage', 'selection', 'source', 'exporter', 'schema', 'context_generator',
    'catalog', 'definitions', 'mapping_sources', 'unit_transformations',
    'record_counts', 'provenance',
  ],
  unavailable_fact_shape: ['value', 'reason'],
});
const RESEARCH_METADATA_HASH = aggregateHash(RESEARCH_METADATA_DESCRIPTOR);

function codePointCompare(left, right) {
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : (leftText > rightText ? 1 : 0);
}

function apiError(statusCode, code, message, details) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function badRequest(code, message, details) {
  throw apiError(400, code, message, details);
}

function semanticError(code, message, details) {
  throw apiError(422, code, message, details);
}

function nullable(value) {
  return value == null ? null : value;
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value)) badRequest('invalid_body', label + ' must be a JSON object');
}

function assertBodyLimit(value) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch (_) {
    badRequest('invalid_json', 'Request body must be JSON-serializable');
  }
  if (encoded === undefined) badRequest('invalid_json', 'Request body must be JSON-serializable');
  if (Buffer.byteLength(encoded, 'utf8') > MAX_BODY_BYTES) {
    throw apiError(413, 'body_too_large', 'Request body exceeds 256 KiB');
  }
}

function assertNoRequestIdentity(value) {
  assertObject(value, 'Request body');
  for (const key of Object.keys(value)) {
    if (IDENTITY_FIELDS.has(key) || /^author(?:_|$)/.test(key) || /^owner(?:_|$)/.test(key)) {
      badRequest('identity_field_forbidden', 'Request identity fields are server-derived', { field: key });
    }
  }
}

function canonicalUuid(raw, field, required) {
  if (raw == null || raw === '') {
    if (required) badRequest('invalid_uuid', field + ' must be a UUID');
    return null;
  }
  if (typeof raw !== 'string' || !UUID.test(raw)) {
    badRequest('invalid_uuid', field + ' must be a UUID');
  }
  const hex = raw.replace(/-/g, '').toLowerCase();
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' + hex.slice(20);
}

function canonicalDuplicateAcknowledgements(raw) {
  if (!Array.isArray(raw)) {
    badRequest('invalid_duplicate_ack', 'duplicate_guard_ack_entry_uuids must be an array');
  }
  if (raw.length > 100) {
    throw apiError(413, 'too_many_duplicate_acks', 'At most 100 duplicate acknowledgements are allowed');
  }
  const values = raw.map(function(value) {
    if (typeof value !== 'string' || !CANONICAL_UUID.test(value)) {
      badRequest('invalid_duplicate_ack', 'Duplicate acknowledgements must be canonical UUIDs');
    }
    return value;
  });
  if (new Set(values).size !== values.length) {
    badRequest('duplicate_duplicate_ack', 'Duplicate acknowledgement UUIDs must be unique');
  }
  return values;
}

function normalizeGatewayIdentity(identity) {
  const shaped = identity;
  if (!isObject(shaped)) {
    throw apiError(503, 'gateway_identity_unavailable', 'Gateway identity is not ready');
  }
  const deviceEui = String(
    shaped.deviceEui || shaped.device_eui || shaped.gatewayDeviceEui || shaped.gateway_device_eui || ''
  ).trim().replace(/[^0-9a-fA-F]/g, '').toUpperCase();
  const confidence = String(shaped.confidence || '').trim().toLowerCase();
  if (!EUI64.test(deviceEui) ||
      ['0101010101010101', '0000000000000000', 'FFFFFFFFFFFFFFFF'].includes(deviceEui) ||
      !['authoritative', 'persisted'].includes(confidence)) {
    throw apiError(503, 'gateway_identity_unavailable', 'Gateway identity is not ready');
  }
  return { deviceEui, confidence };
}

function unauthorized() {
  return apiError(401, 'unauthorized', 'Unauthorized');
}

function verifyBearer(authorization, secret, nowMs) {
  try {
    if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) throw unauthorized();
    if (typeof secret !== 'string' || !secret) throw unauthorized();
    const token = authorization.slice(7).trim();
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw unauthorized();
    const expected = crypto.createHmac('sha256', secret).update(parts[0]).digest('base64url');
    const actualBytes = Buffer.from(parts[1], 'utf8');
    const expectedBytes = Buffer.from(expected, 'utf8');
    if (actualBytes.length !== expectedBytes.length ||
        !crypto.timingSafeEqual(actualBytes, expectedBytes)) throw unauthorized();
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const userId = Number(payload.userId);
    const username = String(payload.username || '').trim();
    const exp = Number(payload.exp || 0);
    const clock = nowMs == null ? Date.now() : Number(nowMs);
    if (!Number.isInteger(userId) || userId <= 0 || !username || username.length > 120 ||
        !Number.isFinite(exp) || exp <= 0 || clock > exp) throw unauthorized();
    return { userId, username, exp };
  } catch (error) {
    if (error && error.code === 'unauthorized') throw error;
    throw unauthorized();
  }
}

function syncDbCall(db, method, sql, params) {
  if (db && typeof db.prepare === 'function') {
    const statement = db.prepare(sql);
    if (method === 'get') return Promise.resolve(statement.get(...(params || [])));
    if (method === 'all') return Promise.resolve(statement.all(...(params || [])));
    return Promise.resolve(statement.run(...(params || [])));
  }
  if (!db || typeof db[method] !== 'function') {
    return Promise.reject(new TypeError('Database does not provide ' + method + '()'));
  }
  if (db[method].length >= 3) {
    return new Promise(function(resolve, reject) {
      db[method](sql, params || [], function(error, result) {
        if (error) reject(error);
        else if (method === 'run') resolve(this && typeof this.changes === 'number' ? this.changes : 0);
        else resolve(result);
      });
    });
  }
  return Promise.resolve(db[method](sql, params || [])).then(function(result) {
    if (method === 'run' && result && typeof result.changes === 'number') return result.changes;
    return result;
  });
}

function dbGet(db, sql, params) {
  return syncDbCall(db, 'get', sql, params);
}

function dbAll(db, sql, params) {
  return syncDbCall(db, 'all', sql, params).then(function(rows) { return rows || []; });
}

function dbRun(db, sql, params) {
  return syncDbCall(db, 'run', sql, params);
}

async function resolvePrincipal(db, tokenPrincipal, gatewayIdentity) {
  if (!isObject(tokenPrincipal) || !Number.isInteger(tokenPrincipal.userId) || tokenPrincipal.userId <= 0 ||
      typeof tokenPrincipal.username !== 'string' || !tokenPrincipal.username.trim()) {
    throw unauthorized();
  }
  const identity = normalizeGatewayIdentity(gatewayIdentity);
  const user = await dbGet(
    db,
    'SELECT id,username,user_uuid FROM users WHERE id=? AND username=? LIMIT 1',
    [tokenPrincipal.userId, tokenPrincipal.username.trim()]
  );
  if (!user || !user.user_uuid) throw unauthorized();
  return {
    user_id: Number(user.id),
    owner_user_uuid: String(user.user_uuid),
    author_principal_uuid: String(user.user_uuid),
    author_label: String(user.username).slice(0, 120),
    gateway_device_eui: identity.deviceEui,
    origin: 'edge-ui',
  };
}

function parsedJson(raw, fallback) {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function catalogDto(catalog) {
  const vocab = [...catalog.vocabByCode.values()].map(function(row) {
    const output = Object.assign({}, row);
    delete output.labels_json;
    delete output.constraints_json;
    return output;
  }).sort(function(left, right) { return left.code.localeCompare(right.code); });
  const definitions = function(index) {
    return [...index.values()].flatMap(function(versions) {
      return [...versions.values()].map(function(row) {
        const output = Object.assign({}, row);
        delete output.labels_json;
        delete output.definition_json;
        return output;
      });
    }).sort(function(left, right) { return left.code.localeCompare(right.code) || left.version - right.version; });
  };
  const products = [...catalog.products.values()].map(function(row) {
    const output = Object.assign({}, row);
    delete output.composition_json;
    return output;
  }).sort(function(left, right) { return left.product_uuid.localeCompare(right.product_uuid); });
  const mappings = (catalog.mappings || []).map(function(row) {
    const output = Object.assign({}, row);
    delete output.id;
    return output;
  });
  return {
    catalog_version: Number(catalog.version),
    catalog_hash: catalog.hash,
    vocab,
    templates: definitions(catalog.templates),
    layouts: definitions(catalog.layouts),
    products,
    mappings,
  };
}

async function loadScopedCatalog(db, principal) {
  return catalogDto(await loadCatalog(db, principal));
}

function normalizedStringFilter(raw, field) {
  if (raw == null || raw === '') return null;
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 4096) {
    badRequest('invalid_filter', field + ' filter is invalid');
  }
  return raw;
}

function normalizeEntryFilters(rawFilters) {
  const raw = isObject(rawFilters) ? rawFilters : {};
  const filters = {};
  for (const field of ENTRY_FILTERS) {
    if (field === 'status') continue;
    let value = normalizedStringFilter(raw[field], field);
    if (value != null && ['entry_uuid', 'plot_uuid', 'zone_uuid', 'campaign_uuid', 'batch_uuid', 'pass_uuid'].includes(field)) {
      value = canonicalUuid(value, field, true);
    }
    if (value != null && ['occurred_from', 'occurred_to'].includes(field) && !Number.isFinite(Date.parse(value))) {
      badRequest('invalid_filter', field + ' must be an ISO timestamp');
    }
    if (value != null) filters[field] = value;
  }
  filters.status = String(raw.status || 'final').trim().toLowerCase();
  if (!['draft', 'final', 'voided', 'all'].includes(filters.status)) {
    badRequest('invalid_filter', 'status filter is invalid');
  }
  const limit = raw.limit == null || raw.limit === '' ? 50 : Number(raw.limit);
  if (!Number.isInteger(limit) || limit < 1) badRequest('invalid_limit', 'limit must be a positive integer');
  filters.limit = Math.min(limit, 100);
  if (raw.cursor != null && raw.cursor !== '') filters.cursor = String(raw.cursor);
  return filters;
}

function canonicalExportSelection(rawFilters) {
  const source = isObject(rawFilters) ? Object.assign({}, rawFilters) : {};
  delete source.cursor;
  delete source.limit;
  const selection = normalizeEntryFilters(source);
  delete selection.cursor;
  delete selection.limit;
  return selection;
}

function filterHash(filters) {
  const stable = {};
  for (const key of Object.keys(filters).sort()) {
    if (key !== 'cursor' && key !== 'limit') stable[key] = filters[key];
  }
  return crypto.createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function decodeCursor(raw, expectedHash) {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(value) || value.length !== 3 ||
        typeof value[0] !== 'string' || typeof value[1] !== 'string' || value[2] !== expectedHash) {
      throw new Error('shape');
    }
    return { occurred_start: value[0], entry_uuid: canonicalUuid(value[1], 'cursor', true) };
  } catch (_) {
    badRequest('invalid_cursor', 'Cursor does not match these filters');
  }
}

function encodeCursor(row, hash) {
  return Buffer.from(JSON.stringify([row.occurred_start, row.entry_uuid, hash])).toString('base64url');
}

async function buildEntryWhere(db, rawFilters, principal, includeCursor) {
  const filters = normalizeEntryFilters(rawFilters);
  const hash = filterHash(filters);
  const cursor = includeCursor === false ? null : decodeCursor(filters.cursor, hash);
  const clauses = [
    'e.owner_user_uuid=?',
    'e.user_id=?',
    'e.gateway_device_eui=?',
    'e.deleted_at IS NULL',
  ];
  const params = [principal.owner_user_uuid, principal.user_id, principal.gateway_device_eui];
  if (filters.status !== 'all') {
    clauses.push('e.status=?');
    params.push(filters.status);
  }
  const fieldColumns = {
    entry_uuid: 'e.entry_uuid',
    plot_uuid: 'e.plot_uuid',
    activity_code: 'e.activity_code',
    campaign_uuid: 'e.campaign_uuid',
    protocol_code: 'e.protocol_code',
    protocol_version: 'e.protocol_version',
    observation_unit_code: 'e.observation_unit_code',
    batch_uuid: 'e.batch_uuid',
    pass_uuid: 'e.pass_uuid',
  };
  if (filters.zone_uuid != null) {
    const zone = await ownedZone(db, filters.zone_uuid, principal);
    clauses.push('e.zone_id=?');
    params.push(Number(zone.id));
  }
  for (const [field, column] of Object.entries(fieldColumns)) {
    if (filters[field] == null) continue;
    clauses.push(column + '=?');
    params.push(filters[field]);
  }
  if (filters.occurred_from != null) {
    clauses.push('e.occurred_start>=?');
    params.push(new Date(filters.occurred_from).toISOString());
  }
  if (filters.occurred_to != null) {
    clauses.push('e.occurred_start<=?');
    params.push(new Date(filters.occurred_to).toISOString());
  }
  if (cursor) {
    clauses.push('(e.occurred_start<? OR (e.occurred_start=? AND e.entry_uuid>?))');
    params.push(cursor.occurred_start, cursor.occurred_start, cursor.entry_uuid);
  }
  return { filters, hash, clauses, params };
}

async function listEntriesInSnapshot(db, rawFilters, principal) {
  const query = await buildEntryWhere(db, rawFilters, principal, true);
  const filters = query.filters;
  const params = query.params.slice();
  params.push(filters.limit + 1);
  const rows = await dbAll(
    db,
    'SELECT e.* FROM journal_entries AS e WHERE ' + query.clauses.join(' AND ') +
      ' ORDER BY e.occurred_start DESC,e.entry_uuid ASC LIMIT ?',
    params
  );
  const hasMore = rows.length > filters.limit;
  if (hasMore) rows.pop();
  const valuesByEntry = new Map();
  if (rows.length) {
    const uuids = rows.map(function(row) { return row.entry_uuid; });
    const valueRows = await dbAll(
      db,
      'SELECT * FROM journal_entry_values WHERE entry_uuid IN (' +
        uuids.map(function() { return '?'; }).join(',') +
      ') ORDER BY entry_uuid,group_index,attribute_code',
      uuids
    );
    for (const value of valueRows) {
      if (!valuesByEntry.has(value.entry_uuid)) valuesByEntry.set(value.entry_uuid, []);
      valuesByEntry.get(value.entry_uuid).push(value);
    }
  }
  const entries = rows.map(function(row) {
    return buildAggregate(Object.assign({ contract_version: 1 }, row), valuesByEntry.get(row.entry_uuid) || []);
  });
  return {
    entries,
    next_cursor: hasMore ? encodeCursor(rows[rows.length - 1], query.hash) : null,
  };
}

async function listEntries(db, rawFilters, principal) {
  return inReadSnapshot(db, function(snapshot) {
    return listEntriesInSnapshot(snapshot, rawFilters, principal);
  });
}

async function writeTransaction(db, executor) {
  if (db && typeof db.transaction === 'function') return db.transaction(executor);
  if (!db || typeof db.exec !== 'function') throw new TypeError('Database must provide transaction()');
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = await executor(db);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      error.rollbackError = rollbackError;
    }
    throw error;
  }
}

function boundedText(value, field, options) {
  options = options || {};
  if (value == null) {
    if (options.required) semanticError('required', field + ' is required', { field });
    return null;
  }
  if (typeof value !== 'string') semanticError('invalid_type', field + ' must be text', { field });
  const normalized = options.trim === false ? value : value.trim();
  if (options.required && !normalized) semanticError('required', field + ' is required', { field });
  const maxBytes = options.maxBytes || 4096;
  if (Buffer.byteLength(normalized, 'utf8') > maxBytes) {
    throw apiError(413, 'text_too_large', field + ' exceeds its byte limit', { field, max_bytes: maxBytes });
  }
  return normalized || (options.required ? normalized : null);
}

function exactBaseVersion(value, creating) {
  if (!Number.isInteger(value) || value < 0 || (creating && value !== 0)) {
    throw apiError(409, 'stale_version', creating
      ? 'New resources require base_sync_version 0'
      : 'base_sync_version must match the current resource version');
  }
  return value;
}

async function ownedZone(tx, zoneUuid, principal) {
  const zone = await dbGet(
    tx,
    'SELECT z.id,z.name,z.zone_uuid,z.gateway_device_eui,z.user_id,u.user_uuid ' +
      'FROM irrigation_zones AS z JOIN users AS u ON u.id=z.user_id ' +
      'WHERE z.zone_uuid=? AND z.user_id=? AND u.user_uuid=? AND z.deleted_at IS NULL ' +
        'AND (z.gateway_device_eui=? OR z.gateway_device_eui IS NULL) LIMIT 1',
    [zoneUuid, principal.user_id, principal.owner_user_uuid, principal.gateway_device_eui]
  );
  if (!zone) throw apiError(404, 'not_found', 'Zone was not found');
  return zone;
}

async function activeLayout(tx, code, version) {
  const normalizedCode = boundedText(code, 'layout_code', { required: true, maxBytes: 120 });
  if (version != null && (!Number.isInteger(version) || version < 1)) {
    semanticError('invalid_layout', 'layout_version is invalid');
  }
  const layout = version == null
    ? await dbGet(
      tx,
      'SELECT code,version FROM journal_layouts WHERE code=? AND active=1 ' +
        'ORDER BY version DESC LIMIT 1',
      [normalizedCode]
    )
    : await dbGet(
      tx,
      'SELECT code,version FROM journal_layouts WHERE code=? AND version=? AND active=1',
      [normalizedCode, version]
    );
  if (!layout) semanticError('invalid_layout', 'Layout version is not active');
  return layout;
}

function plotAggregate(row, settings) {
  return {
    contract_version: 1,
    plot_uuid: row.plot_uuid,
    plot_code: row.plot_code,
    name: nullable(row.name),
    zone_uuid: nullable(row.zone_uuid),
    station_code: nullable(row.station_code),
    crop_hint: nullable(row.crop_hint),
    area_m2: row.area_m2 == null ? null : Number(row.area_m2),
    active: Number(row.active),
    sync_version: Number(row.sync_version),
    owner_user_uuid: row.owner_user_uuid,
    gateway_device_eui: row.gateway_device_eui,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: nullable(row.deleted_at),
    settings: {
      layout_code: settings.layout_code,
      updated_at: settings.updated_at,
      updated_by_principal_uuid: settings.updated_by_principal_uuid,
      sync_version: Number(settings.sync_version),
    },
  };
}

async function emitPlot(tx, row, settings) {
  const { emitJournalOutbox } = require('./lifecycle');
  return emitJournalOutbox(tx, {
    aggregate: plotAggregate(row, settings),
    aggregate_type: 'JOURNAL_PLOT',
    aggregate_key: row.plot_uuid,
    sync_version: Number(row.sync_version),
    occurred_at: row.updated_at,
    gateway_device_eui: row.gateway_device_eui,
  }, 'JOURNAL_PLOT_UPSERTED');
}

async function recordResourceCommand(tx, principal, terminal) {
  const commandId = typeof principal.command_id === 'string' && principal.command_id.trim()
    ? principal.command_id.trim()
    : null;
  if (!commandId) return;
  if (principal.command_type && principal.command_type !== terminal.command_type) {
    throw apiError(400, 'invalid_command_type', 'Command type does not match the resource mutation');
  }
  const expectedEffectKey = terminal.effect_prefix + ':' + terminal.aggregate_key + ':' +
    terminal.base_sync_version;
  if (principal.effect_key !== expectedEffectKey) {
    throw apiError(400, 'invalid_effect_key', 'Command effect key does not match the resource mutation');
  }
  const { aggregateHash } = require('./aggregate');
  const now = new Date().toISOString();
  const payloadHash = aggregateHash(terminal.aggregate);
  const ackCommandId = principal.delivery_command_id == null
    ? commandId
    : principal.delivery_command_id;
  if (principal.delivery_command_id != null &&
      (!Number.isSafeInteger(ackCommandId) || ackCommandId <= 0)) {
    throw apiError(400, 'invalid_command_id', 'Pending delivery command ID must be a positive integer');
  }
  const facts = {
    commandId: ackCommandId,
    commandType: terminal.command_type,
    status: 'ACKED',
    result: 'APPLIED',
    duplicate: false,
    aggregateKey: terminal.aggregate_key,
    aggregateType: terminal.aggregate_type,
    ownerUserUuid: principal.owner_user_uuid,
    authorPrincipalUuid: principal.author_principal_uuid,
    authorLabel: principal.author_label == null ? null : principal.author_label,
    appliedSyncVersion: terminal.sync_version,
    effectKey: principal.effect_key,
    payloadHash,
    submittedIntentHash: principal.submitted_intent_hash || null,
    gatewayDeviceEui: terminal.gateway_device_eui,
    appliedAt: now,
  };
  await dbRun(
    tx,
    'INSERT INTO applied_commands (' +
      'command_id,device_eui,command_type,effect_key,applied_at,result,result_detail,originator' +
    ') VALUES (?,?,?,?,?,?,?,?)',
    [commandId, terminal.gateway_device_eui, terminal.command_type, principal.effect_key,
      now, 'APPLIED', JSON.stringify(facts), 'edge']
  );
  const hooks = principal.lifecycle_hooks;
  if (hooks && typeof hooks.afterCommandLedger === 'function') {
    await hooks.afterCommandLedger(facts);
  }
  await dbRun(
    tx,
    'DELETE FROM command_ack_outbox WHERE command_id=? AND delivered_at IS NULL',
    [commandId]
  );
  await dbRun(
    tx,
    'INSERT INTO command_ack_outbox (command_id,payload_json,created_at) VALUES (?,?,?)',
    [commandId, JSON.stringify(facts), now]
  );
  if (hooks && typeof hooks.afterCommand === 'function') await hooks.afterCommand(facts);
}

async function unresolvedGroupWouldBecomeHeterogeneous(tx, plotUuid, layoutCode, principal) {
  return dbGet(
    tx,
    'SELECT g.group_uuid FROM journal_plot_groups AS g ' +
      'JOIN journal_plot_group_members AS mine ON mine.group_uuid=g.group_uuid AND mine.plot_uuid=? ' +
      'JOIN journal_plots AS mine_plot ON mine_plot.plot_uuid=mine.plot_uuid ' +
      'JOIN journal_plot_group_members AS other ON other.group_uuid=g.group_uuid AND other.plot_uuid<>? ' +
      'JOIN journal_plots AS other_plot ON other_plot.plot_uuid=other.plot_uuid ' +
      'JOIN journal_plot_settings AS s ON s.plot_uuid=other.plot_uuid ' +
      'WHERE g.resolved_at IS NULL AND g.deleted_at IS NULL AND s.layout_code<>? ' +
        'AND g.owner_user_uuid=? AND g.gateway_device_eui=? ' +
        'AND mine_plot.owner_user_uuid=? AND mine_plot.gateway_device_eui=? ' +
        'AND other_plot.owner_user_uuid=? AND other_plot.gateway_device_eui=? LIMIT 1',
    [plotUuid, plotUuid, layoutCode, principal.owner_user_uuid, principal.gateway_device_eui,
      principal.owner_user_uuid, principal.gateway_device_eui,
      principal.owner_user_uuid, principal.gateway_device_eui]
  );
}

async function upsertPlot(db, input, principal, pathUuid, options) {
  assertBodyLimit(input);
  assertNoRequestIdentity(input);
  options = options || {};
  const inputUuid = canonicalUuid(input.plot_uuid, 'plot_uuid', !pathUuid);
  const plotUuid = canonicalUuid(pathUuid || inputUuid, 'plot_uuid', true);
  if (inputUuid && inputUuid !== plotUuid) badRequest('path_body_mismatch', 'Path and body plot UUID differ');
  return writeTransaction(db, async function(tx) {
    const existing = await dbGet(
      tx,
      'SELECT * FROM journal_plots WHERE plot_uuid=? AND owner_user_uuid=? AND gateway_device_eui=? ' +
        'AND deleted_at IS NULL',
      [plotUuid, principal.owner_user_uuid, principal.gateway_device_eui]
    );
    if (pathUuid && !existing) throw apiError(404, 'not_found', 'Plot was not found');
    if (!pathUuid && !existing && await dbGet(tx, 'SELECT 1 FROM journal_plots WHERE plot_uuid=?', [plotUuid])) {
      throw apiError(404, 'not_found', 'Plot was not found');
    }
    if (existing && existing.zone_uuid) await ownedZone(tx, existing.zone_uuid, principal);
    const creating = !existing;
    exactBaseVersion(input.base_sync_version, creating);
    const zoneUuid = canonicalUuid(input.zone_uuid, 'zone_uuid', false);
    if (zoneUuid) await ownedZone(tx, zoneUuid, principal);
    if (zoneUuid) {
      const byZone = await dbGet(
        tx,
        'SELECT plot_uuid FROM journal_plots WHERE owner_user_uuid=? AND gateway_device_eui=? AND zone_uuid=? ' +
          'AND active=1 AND deleted_at IS NULL AND plot_uuid<>? ORDER BY created_at,plot_uuid LIMIT 1',
        [principal.owner_user_uuid, principal.gateway_device_eui, zoneUuid, plotUuid]
      );
      if (byZone) {
        if (creating && options.returnExistingZonePlot) {
          const row = await dbGet(
            tx,
            'SELECT * FROM journal_plots WHERE plot_uuid=? AND owner_user_uuid=? AND gateway_device_eui=?',
            [byZone.plot_uuid, principal.owner_user_uuid, principal.gateway_device_eui]
          );
          const settings = await dbGet(tx, 'SELECT * FROM journal_plot_settings WHERE plot_uuid=?', [byZone.plot_uuid]);
          return { plot: plotAggregate(row, settings), created: false };
        }
        throw apiError(409, 'zone_plot_conflict', 'This zone already has an active application plot');
      }
    }
    const layoutVersion = input.layout_version == null ? null : Number(input.layout_version);
    const layout = await activeLayout(tx, input.layout_code, layoutVersion);
    if (existing && Number(existing.sync_version) !== input.base_sync_version) {
      throw apiError(409, 'stale_version', 'Plot version is stale');
    }
    if (existing) {
      const oldSettings = await dbGet(tx, 'SELECT * FROM journal_plot_settings WHERE plot_uuid=?', [plotUuid]);
      if (oldSettings && oldSettings.layout_code !== layout.code &&
          await unresolvedGroupWouldBecomeHeterogeneous(tx, plotUuid, layout.code, principal)) {
        throw apiError(409, 'heterogeneous_group', 'Layout change would make an unresolved plot group heterogeneous');
      }
    }
    const plotCode = boundedText(input.plot_code, 'plot_code', { required: true, maxBytes: 240 });
    const name = boundedText(input.name, 'name', { maxBytes: 4096 });
    const stationCode = boundedText(input.station_code, 'station_code', { maxBytes: 240 });
    const cropHint = boundedText(input.crop_hint, 'crop_hint', { maxBytes: 4096 });
    let area = input.area_m2 == null ? null : Number(input.area_m2);
    if (area != null && (!Number.isFinite(area) || area <= 0)) {
      semanticError('invalid_area', 'area_m2 must be a positive finite number');
    }
    const active = input.active == null ? 1 : Number(input.active);
    if (![0, 1].includes(active)) semanticError('invalid_active', 'active must be 0 or 1');
    if (existing && active === 0) {
      const unresolved = await dbGet(
        tx,
        'SELECT g.group_uuid FROM journal_plot_groups AS g ' +
          'JOIN journal_plot_group_members AS m ON m.group_uuid=g.group_uuid ' +
          'JOIN journal_plots AS p ON p.plot_uuid=m.plot_uuid ' +
          'WHERE m.plot_uuid=? AND g.resolved_at IS NULL AND g.deleted_at IS NULL ' +
            'AND g.owner_user_uuid=? AND g.gateway_device_eui=? ' +
            'AND p.owner_user_uuid=? AND p.gateway_device_eui=? LIMIT 1',
        [plotUuid, principal.owner_user_uuid, principal.gateway_device_eui,
          principal.owner_user_uuid, principal.gateway_device_eui]
      );
      if (unresolved) {
        throw apiError(409, 'plot_in_unresolved_group', 'Resolve or edit the plot group before deactivating this plot');
      }
    }
    const now = new Date().toISOString();
    const nextVersion = creating ? 1 : Number(existing.sync_version) + 1;
    const createdAt = creating ? now : existing.created_at;
    try {
      if (creating) {
        await dbRun(
          tx,
          'INSERT INTO journal_plots (' +
            'plot_uuid,plot_code,name,zone_uuid,station_code,crop_hint,area_m2,active,sync_version,' +
            'gateway_device_eui,created_at,updated_at,deleted_at,owner_user_uuid' +
          ') VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [plotUuid, plotCode, name, zoneUuid, stationCode, cropHint, area, active, nextVersion,
            principal.gateway_device_eui, createdAt, now, null, principal.owner_user_uuid]
        );
        await dbRun(
          tx,
          'INSERT INTO journal_plot_settings (' +
            'plot_uuid,layout_code,updated_at,updated_by_principal_uuid,sync_version' +
          ') VALUES (?,?,?,?,?)',
          [plotUuid, layout.code, now, principal.author_principal_uuid, nextVersion]
        );
      } else {
        await dbRun(
          tx,
          'UPDATE journal_plots SET plot_code=?,name=?,zone_uuid=?,station_code=?,crop_hint=?,area_m2=?,' +
            'active=?,sync_version=?,updated_at=? WHERE plot_uuid=? AND owner_user_uuid=? ' +
            'AND gateway_device_eui=? AND sync_version=?',
          [plotCode, name, zoneUuid, stationCode, cropHint, area, active, nextVersion, now,
            plotUuid, principal.owner_user_uuid, principal.gateway_device_eui, existing.sync_version]
        );
        await dbRun(
          tx,
          'UPDATE journal_plot_settings SET layout_code=?,updated_at=?,updated_by_principal_uuid=?,' +
            'sync_version=? WHERE plot_uuid=?',
          [layout.code, now, principal.author_principal_uuid, nextVersion, plotUuid]
        );
      }
    } catch (error) {
      if (/UNIQUE constraint failed: journal_plots\.gateway_device_eui, journal_plots\.plot_code/.test(String(error.message))) {
        throw apiError(409, 'plot_code_conflict', 'Plot code is already in use');
      }
      throw error;
    }
    const row = await dbGet(
      tx,
      'SELECT * FROM journal_plots WHERE plot_uuid=? AND owner_user_uuid=? AND gateway_device_eui=?',
      [plotUuid, principal.owner_user_uuid, principal.gateway_device_eui]
    );
    const settings = await dbGet(tx, 'SELECT * FROM journal_plot_settings WHERE plot_uuid=?', [plotUuid]);
    const emission = await emitPlot(tx, row, settings);
    await recordResourceCommand(tx, principal, {
      aggregate: emission.aggregate,
      aggregate_key: plotUuid,
      aggregate_type: 'JOURNAL_PLOT',
      base_sync_version: input.base_sync_version,
      command_type: 'UPSERT_JOURNAL_PLOT',
      effect_prefix: 'journal_plot',
      gateway_device_eui: principal.gateway_device_eui,
      sync_version: nextVersion,
    });
    return { plot: plotAggregate(row, settings), outbox_event_uuid: emission.event_uuid, created: creating };
  });
}

async function ensureZonePlot(db, zoneUuid, input, principal) {
  const canonicalZone = canonicalUuid(zoneUuid, 'zone_uuid', true);
  const zone = await ownedZone(db, canonicalZone, principal);
  const existing = await dbGet(
    db,
    'SELECT p.plot_uuid FROM journal_plots AS p WHERE p.owner_user_uuid=? AND p.gateway_device_eui=? ' +
      'AND p.zone_uuid=? ' +
      'AND p.deleted_at IS NULL ORDER BY p.created_at,p.plot_uuid LIMIT 1',
    [principal.owner_user_uuid, principal.gateway_device_eui, canonicalZone]
  );
  if (existing) return existing.plot_uuid;
  if (!input.layout_code) semanticError('layout_required', 'First use of a zone requires an explicit layout');
  const plotUuid = crypto.randomUUID();
  const sanitizedName = String(zone.name || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  let plotCode = sanitizedName || 'zone-' + canonicalZone.slice(0, 8);
  const collision = await dbGet(
    db,
    'SELECT 1 FROM journal_plots WHERE gateway_device_eui=? AND plot_code=? AND deleted_at IS NULL',
    [principal.gateway_device_eui, plotCode]
  );
  if (collision) plotCode = plotCode.slice(0, 71) + '-' + canonicalZone.slice(0, 8);
  const result = await upsertPlot(db, {
    plot_uuid: plotUuid,
    base_sync_version: 0,
    plot_code: plotCode,
    name: zone.name,
    zone_uuid: canonicalZone,
    station_code: null,
    crop_hint: null,
    area_m2: null,
    active: 1,
    layout_code: input.layout_code,
    layout_version: input.layout_version == null ? null : Number(input.layout_version),
  }, principal, null, { returnExistingZonePlot: true });
  return result.plot.plot_uuid;
}

async function assertPlotZoneMatch(db, plotUuid, zoneUuid, principal) {
  const plot = await dbGet(
    db,
    'SELECT plot_uuid,zone_uuid FROM journal_plots WHERE plot_uuid=? AND owner_user_uuid=? ' +
      'AND gateway_device_eui=? ' +
      'AND active=1 AND deleted_at IS NULL',
    [plotUuid, principal.owner_user_uuid, principal.gateway_device_eui]
  );
  if (!plot) throw apiError(404, 'not_found', 'Plot was not found');
  if (zoneUuid && plot.zone_uuid !== zoneUuid) {
    semanticError('plot_zone_mismatch', 'Plot and zone do not refer to the same land unit');
  }
}

async function saveEntry(db, input, principal, options) {
  assertBodyLimit(input);
  assertNoRequestIdentity(input);
  options = options || {};
  const mode = options.mode || 'create';
  const body = Object.assign({}, input);
  const batchRequest = Array.isArray(body.plot_uuids);
  if (Object.prototype.hasOwnProperty.call(body, 'duplicate_guard_ack_entry_uuids')) {
    if (!batchRequest) {
      badRequest('invalid_batch_control', 'duplicate_guard_ack_entry_uuids is valid only for batches');
    }
    body.duplicate_guard_ack_entry_uuids = canonicalDuplicateAcknowledgements(
      body.duplicate_guard_ack_entry_uuids
    );
  }
  if (batchRequest && Object.prototype.hasOwnProperty.call(body, 'duplicate_guard_ack_entry_uuid')) {
    badRequest('invalid_batch_control', 'Batches use duplicate_guard_ack_entry_uuids');
  }
  if (!['draft', 'final'].includes(body.status)) {
    semanticError('status_required', 'status must be explicitly draft or final');
  }
  if (mode === 'update') {
    const pathUuid = canonicalUuid(options.entryUuid, 'entry_uuid', true);
    const bodyUuid = canonicalUuid(body.entry_uuid, 'entry_uuid', false);
    if (bodyUuid && bodyUuid !== pathUuid) badRequest('path_body_mismatch', 'Path and body entry UUID differ');
    body.entry_uuid = pathUuid;
    if (!Number.isInteger(body.base_sync_version) || body.base_sync_version < 0) {
      throw apiError(409, 'stale_version', 'PUT requires base_sync_version');
    }
    if (Array.isArray(body.plot_uuids)) badRequest('invalid_batch', 'PUT cannot create a multi-plot batch');
  } else {
    if (body.status === 'final' && body.base_sync_version !== 0) {
      throw apiError(409, 'stale_version', 'POST final requires base_sync_version 0');
    }
    if (!body.entry_uuid && !Array.isArray(body.plot_uuids)) body.entry_uuid = crypto.randomUUID();
  }
  const zoneUuid = canonicalUuid(body.zone_uuid, 'zone_uuid', false);
  let plotUuid = canonicalUuid(body.plot_uuid, 'plot_uuid', false);
  if (!plotUuid && zoneUuid) {
    plotUuid = await ensureZonePlot(db, zoneUuid, body, principal);
  }
  if (plotUuid) await assertPlotZoneMatch(db, plotUuid, zoneUuid, principal);
  body.plot_uuid = plotUuid;
  delete body.zone_uuid;
  const catalog = await loadCatalog(db, principal);
  const lifecycle = require('./lifecycle');
  if (body.status === 'draft') {
    if (Array.isArray(body.plot_uuids)) badRequest('invalid_batch', 'Drafts cannot be multi-plot batches');
    return lifecycle.saveDraft(db, catalog, body, principal);
  }
  if (Array.isArray(body.plot_uuids)) {
    if (mode !== 'create') badRequest('invalid_batch', 'Only POST may create a batch');
    const plotUuids = body.plot_uuids.map(function(value) { return canonicalUuid(value, 'plot_uuids', true); });
    delete body.plot_uuids;
    return lifecycle.finalizeBatch(db, catalog, body, plotUuids, principal);
  }
  return mode === 'create'
    ? lifecycle.finalizeCreate(db, catalog, body, principal)
    : lifecycle.finalize(db, catalog, body, principal);
}

async function voidEntry(db, entryUuid, input, principal) {
  assertBodyLimit(input);
  assertNoRequestIdentity(input);
  const bodyUuid = canonicalUuid(input.entry_uuid, 'entry_uuid', false);
  const pathUuid = canonicalUuid(entryUuid, 'entry_uuid', true);
  if (bodyUuid && bodyUuid !== pathUuid) badRequest('path_body_mismatch', 'Path and body entry UUID differ');
  if (!Number.isInteger(input.base_sync_version) || input.base_sync_version < 1) {
    throw apiError(409, 'stale_version', 'Void requires the current base_sync_version');
  }
  const reason = boundedText(input.reason || input.void_reason, 'reason', { required: true, maxBytes: 4000 });
  return require('./lifecycle').void_(db, null, pathUuid, input.base_sync_version, reason, principal);
}

async function listPlots(db, principal) {
  const rows = await dbAll(
    db,
    'SELECT p.*,s.layout_code,s.updated_at AS settings_updated_at,' +
      's.updated_by_principal_uuid,s.sync_version AS settings_sync_version ' +
    'FROM journal_plots AS p JOIN journal_plot_settings AS s ON s.plot_uuid=p.plot_uuid ' +
      'LEFT JOIN irrigation_zones AS z ON z.zone_uuid=p.zone_uuid AND z.deleted_at IS NULL ' +
    'WHERE p.owner_user_uuid=? AND p.gateway_device_eui=? AND p.deleted_at IS NULL ' +
      'AND (p.zone_uuid IS NULL OR (z.user_id=? AND (z.gateway_device_eui=? OR z.gateway_device_eui IS NULL))) ' +
    'ORDER BY p.plot_code,p.plot_uuid',
    [principal.owner_user_uuid, principal.gateway_device_eui, principal.user_id, principal.gateway_device_eui]
  );
  return {
    plots: rows.map(function(row) {
      return plotAggregate(row, {
        layout_code: row.layout_code,
        updated_at: row.settings_updated_at,
        updated_by_principal_uuid: row.updated_by_principal_uuid,
        sync_version: row.settings_sync_version,
      });
    }),
  };
}

function jsonObjectText(value, field, required) {
  if (value == null) {
    if (required) semanticError('required', field + ' is required');
    return null;
  }
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch (_) {
      semanticError('invalid_json', field + ' must contain a JSON object');
    }
  }
  if (!isObject(parsed)) semanticError('invalid_json', field + ' must contain a JSON object');
  const text = JSON.stringify(parsed);
  if (Buffer.byteLength(text, 'utf8') > 64 * 1024) {
    throw apiError(413, 'text_too_large', field + ' exceeds 64 KiB');
  }
  return text;
}

function normalizedMappings(input) {
  const mappings = input == null ? [] : input;
  if (!Array.isArray(mappings)) semanticError('invalid_mappings', 'mappings must be an array');
  if (mappings.length > 128) throw apiError(413, 'too_many_mappings', 'At most 128 mappings are allowed');
  const seen = new Set();
  return mappings.map(function(mapping, index) {
    if (!isObject(mapping)) semanticError('invalid_mapping', 'Each mapping must be an object', { index });
    const role = boundedText(mapping.mapping_role, 'mapping_role', { required: true, maxBytes: 120 });
    const relation = mapping.mapping_relation == null ? 'exact' :
      boundedText(mapping.mapping_relation, 'mapping_relation', { required: true, maxBytes: 120 });
    if (!MAPPING_ROLES.has(role)) semanticError('invalid_mapping', 'Mapping role is invalid', { index });
    if (!MAPPING_RELATIONS.has(relation)) semanticError('invalid_mapping', 'Mapping relation is invalid', { index });
    const row = {
      scheme_uri: boundedText(mapping.scheme_uri, 'scheme_uri', { required: true, maxBytes: 4096 }),
      scheme_version: boundedText(mapping.scheme_version, 'scheme_version', { required: true, maxBytes: 240 }),
      mapping_role: role,
      external_id: boundedText(mapping.external_id, 'external_id', { required: true, maxBytes: 4096 }),
      external_parent_id: boundedText(mapping.external_parent_id, 'external_parent_id', { maxBytes: 4096 }),
      mapping_relation: relation,
      source_uri: boundedText(mapping.source_uri, 'source_uri', { maxBytes: 4096 }),
      active: mapping.active == null ? 1 : Number(mapping.active),
    };
    if (![0, 1].includes(row.active)) semanticError('invalid_mapping', 'Mapping active must be 0 or 1', { index });
    const key = [row.scheme_uri, row.mapping_role, row.external_id].join('\u0000');
    if (seen.has(key)) semanticError('duplicate_mapping', 'Mappings must be unique', { index });
    seen.add(key);
    return row;
  }).sort(function(left, right) {
    return left.scheme_uri.localeCompare(right.scheme_uri) ||
      left.mapping_role.localeCompare(right.mapping_role) ||
      left.external_id.localeCompare(right.external_id);
  });
}

function vocabAggregate(row, mappings) {
  return {
    contract_version: 1,
    code: row.code,
    kind: row.kind,
    parent_code: nullable(row.parent_code),
    value_type: nullable(row.value_type),
    quantity_kind: nullable(row.quantity_kind),
    basis: nullable(row.basis),
    default_unit_code: nullable(row.default_unit_code),
    labels_json: row.labels_json,
    icon_key: nullable(row.icon_key),
    constraints_json: nullable(row.constraints_json),
    agrovoc_uri: nullable(row.agrovoc_uri),
    icasa_code: nullable(row.icasa_code),
    adapt_code: nullable(row.adapt_code),
    scope: 'custom',
    owner_user_uuid: row.owner_user_uuid,
    gateway_device_eui: row.gateway_device_eui,
    custom_field_uuid: row.custom_field_uuid,
    active: Number(row.active),
    sort_order: Number(row.sort_order),
    sync_version: Number(row.sync_version),
    created_at: row.created_at,
    deleted_at: nullable(row.deleted_at),
    mappings: mappings.map(function(mapping) {
      return {
        scheme_uri: mapping.scheme_uri,
        scheme_version: mapping.scheme_version,
        mapping_role: mapping.mapping_role,
        external_id: mapping.external_id,
        external_parent_id: nullable(mapping.external_parent_id),
        mapping_relation: mapping.mapping_relation,
        source_uri: nullable(mapping.source_uri),
        active: Number(mapping.active),
      };
    }),
  };
}

async function customTermIsUsed(tx, code) {
  return dbGet(
    tx,
    "SELECT 1 AS used FROM journal_entries AS e WHERE e.status IN ('final','voided') AND (" +
      'e.activity_code=? OR EXISTS (' +
        'SELECT 1 FROM journal_entry_values AS v WHERE v.entry_uuid=e.entry_uuid AND (' +
          'v.attribute_code=? OR v.value_text=? OR v.unit_code=? OR v.entered_unit_code=?' +
        ')' +
      ')' +
    ') LIMIT 1',
    [code, code, code, code, code]
  );
}

function customDependencyError(code, field) {
  throw apiError(422, 'missing_custom_dependency', 'A custom vocabulary dependency is not installed', [{
    dependency_code: code,
    field,
  }]);
}

function customCode(value) {
  return typeof value === 'string' && /^custom\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

function parsedConstraintObject(raw) {
  if (raw == null) return {};
  const parsed = parsedJson(raw, null);
  return isObject(parsed) ? parsed : null;
}

function unitRuleRow(row, constraints) {
  return Object.assign({}, row, {
    constraints: constraints == null ? parsedConstraintObject(row.constraints_json) : constraints,
    catalog_errors: [],
  });
}

function irrelevantField(semantic, constraints, fields) {
  for (const field of fields) {
    if (field === 'constraints') {
      const numericKeys = [
        'min', 'max', 'step', 'requires_explicit_unit', 'allow_default_unit',
        'semantic_discriminator', 'dimension', 'to_canonical',
      ];
      if (constraints && numericKeys.some(function(key) {
        return Object.prototype.hasOwnProperty.call(constraints, key);
      })) return 'constraints';
    } else if (semantic[field] != null) return field;
  }
  return null;
}

function throwIrrelevantField(field) {
  throw apiError(422, 'invalid_irrelevant_field', 'Vocabulary field is not valid for this kind', { field });
}

function irrelevantConstraintField(constraints, fields) {
  return fields.find(function(field) {
    return Object.prototype.hasOwnProperty.call(constraints, field);
  });
}

async function scopedUnit(tx, code, principal, field) {
  const unit = await dbGet(
    tx,
    'SELECT * FROM journal_vocab WHERE code=? AND deleted_at IS NULL',
    [code]
  );
  if (!unit) {
    if (customCode(code)) customDependencyError(code, field);
    semanticError('invalid_numeric_contract', 'Referenced unit was not found', { field });
  }
  if (unit.scope === 'custom' &&
      (unit.owner_user_uuid !== principal.owner_user_uuid ||
        unit.gateway_device_eui !== principal.gateway_device_eui)) {
    throw apiError(404, 'not_found', 'Referenced unit was not found');
  }
  return unit;
}

async function validateCustomParent(tx, parentCode, principal) {
  if (!parentCode) return;
  const parent = await dbGet(tx, 'SELECT * FROM journal_vocab WHERE code=? AND deleted_at IS NULL', [parentCode]);
  if (!parent) semanticError('parent_not_found', 'Parent vocabulary term was not found');
  if (parent.scope === 'custom' &&
      (parent.owner_user_uuid !== principal.owner_user_uuid ||
        parent.gateway_device_eui !== principal.gateway_device_eui)) {
    throw apiError(404, 'not_found', 'Parent vocabulary term was not found');
  }
  if (parent.kind !== 'attribute') {
    semanticError('invalid_parent', 'Choice parent must be an attribute');
  }
}

async function validateVocabularyContract(
  tx,
  code,
  semantic,
  constraintsJson,
  principal
) {
  const constraints = parsedConstraintObject(constraintsJson);
  if (!constraints) semanticError('invalid_constraints', 'constraints_json must contain an object');
  let irrelevant;
  if (semantic.kind === 'activity') {
    irrelevant = irrelevantField(semantic, constraints, [
      'parent_code', 'value_type', 'quantity_kind', 'basis', 'default_unit_code', 'constraints',
    ]);
    if (irrelevant) throwIrrelevantField(irrelevant);
    return;
  }
  if (semantic.kind === 'choice') {
    irrelevant = irrelevantField(semantic, constraints, [
      'value_type', 'quantity_kind', 'basis', 'default_unit_code', 'constraints',
    ]);
    if (irrelevant) throwIrrelevantField(irrelevant);
    return;
  }
  if (semantic.kind === 'unit') {
    irrelevant = irrelevantField(semantic, constraints, [
      'parent_code', 'value_type', 'default_unit_code',
    ]);
    if (irrelevant) throwIrrelevantField(irrelevant);
    const attributeConstraint = irrelevantConstraintField(constraints, [
      'min', 'max', 'step', 'requires_explicit_unit', 'allow_default_unit',
      'semantic_discriminator',
    ]);
    if (attributeConstraint) throwIrrelevantField('constraints.' + attributeConstraint);
    const proposed = unitRuleRow(Object.assign({ code, active: 1, deleted_at: null }, semantic), constraints);
    const facts = unitFacts(proposed);
    if (!facts) semanticError('invalid_unit_contract', 'Unit conversion metadata is invalid');
    let target;
    if (facts.canonical_unit_code === code) {
      target = proposed;
    } else {
      target = unitRuleRow(await scopedUnit(
        tx,
        facts.canonical_unit_code,
        principal,
        'constraints.to_canonical.unit_code'
      ));
    }
    const targetFacts = unitFacts(target);
    if (!targetFacts || Number(target.active) !== 1 || target.deleted_at ||
        targetFacts.quantity_kind !== facts.quantity_kind ||
        targetFacts.basis !== facts.basis || targetFacts.dimension !== facts.dimension ||
        targetFacts.canonical_unit_code !== target.code || targetFacts.scale !== 1 ||
        targetFacts.offset !== 0) {
      semanticError('invalid_unit_contract', 'Canonical unit target is incompatible');
    }
    return;
  }
  if (semantic.value_type !== 'number') {
    irrelevant = irrelevantField(semantic, constraints, [
      'parent_code', 'quantity_kind', 'basis', 'default_unit_code', 'constraints',
    ]);
    if (irrelevant) throwIrrelevantField(irrelevant);
    return;
  }
  if (semantic.parent_code != null) throwIrrelevantField('parent_code');
  const unitConstraint = irrelevantConstraintField(constraints, ['dimension', 'to_canonical']);
  if (unitConstraint) throwIrrelevantField('constraints.' + unitConstraint);
  const attribute = Object.assign({
    code,
    active: 1,
    deleted_at: null,
    catalog_errors: [],
    constraints,
  }, semantic);
  if (!numericConstraintsValid(attribute)) {
    semanticError('invalid_numeric_contract', 'Numeric attribute unit metadata is invalid');
  }
  if (semantic.default_unit_code) {
    const unit = unitRuleRow(await scopedUnit(
      tx,
      semantic.default_unit_code,
      principal,
      'default_unit_code'
    ));
    const facts = unitFacts(unit);
    if (!facts || Number(unit.active) !== 1 || unit.deleted_at ||
        facts.quantity_kind !== semantic.quantity_kind || facts.basis !== semantic.basis ||
        facts.canonical_unit_code !== unit.code || facts.scale !== 1 || facts.offset !== 0) {
      semanticError('invalid_numeric_contract', 'Default unit is not canonical for this attribute');
    }
    return;
  }
  const candidates = await dbAll(
    tx,
    'SELECT * FROM journal_vocab WHERE kind=? AND active=1 AND deleted_at IS NULL ' +
      'AND quantity_kind=? AND basis=? AND (scope=? OR (scope=? AND owner_user_uuid=? AND gateway_device_eui=?))',
    ['unit', semantic.quantity_kind, semantic.basis, 'core', 'custom',
      principal.owner_user_uuid, principal.gateway_device_eui]
  );
  if (!candidates.some(function(row) { return Boolean(unitFacts(unitRuleRow(row))); })) {
    semanticError('invalid_numeric_contract', 'No usable unit matches the attribute quantity and basis');
  }
}

async function upsertCustomVocab(db, input, principal, pathUuid) {
  assertBodyLimit(input);
  assertNoRequestIdentity(input);
  const inputUuid = canonicalUuid(input.custom_field_uuid, 'custom_field_uuid', !pathUuid);
  const customFieldUuid = canonicalUuid(pathUuid || inputUuid, 'custom_field_uuid', true);
  if (inputUuid && inputUuid !== customFieldUuid) {
    badRequest('path_body_mismatch', 'Path and body custom vocabulary UUID differ');
  }
  const expectedCode = 'custom.' + customFieldUuid;
  if (input.code != null && input.code !== expectedCode) {
    semanticError('invalid_code', 'Custom vocabulary code must be derived from its UUID');
  }
  return writeTransaction(db, async function(tx) {
    const existing = await dbGet(tx, 'SELECT * FROM journal_vocab WHERE code=?', [expectedCode]);
    if (existing && (existing.scope !== 'custom' ||
        existing.owner_user_uuid !== principal.owner_user_uuid ||
        existing.gateway_device_eui !== principal.gateway_device_eui)) {
      throw apiError(404, 'not_found', 'Custom vocabulary term was not found');
    }
    const creating = !existing;
    exactBaseVersion(input.base_sync_version, creating);
    if (existing && Number(existing.sync_version) !== input.base_sync_version) {
      throw apiError(409, 'stale_version', 'Custom vocabulary version is stale');
    }
    const kind = boundedText(input.kind, 'kind', { required: true, maxBytes: 120 });
    if (!VOCAB_KINDS.has(kind)) semanticError('invalid_kind', 'Vocabulary kind is invalid');
    const parentCode = boundedText(input.parent_code, 'parent_code', { maxBytes: 4096 });
    const valueType = boundedText(input.value_type, 'value_type', { maxBytes: 120 });
    if (valueType && !VALUE_TYPES.has(valueType)) semanticError('invalid_value_type', 'value_type is invalid');
    if (kind === 'attribute' && !valueType) semanticError('invalid_value_type', 'Attributes require value_type');
    if (kind !== 'attribute' && valueType) semanticError('invalid_value_type', 'Only attributes may define value_type');
    if (kind === 'choice' && !parentCode) semanticError('parent_required', 'Choices require parent_code');
    if (kind !== 'choice' && parentCode) semanticError('invalid_parent', 'Only choices may define parent_code');
    await validateCustomParent(tx, parentCode, principal);
    const labelsJson = jsonObjectText(input.labels_json == null ? input.labels : input.labels_json, 'labels_json', true);
    const constraintsJson = input.constraints_json == null && input.constraints == null
      ? null
      : jsonObjectText(input.constraints_json == null ? input.constraints : input.constraints_json,
        'constraints_json', false);
    const mappings = normalizedMappings(input.mappings);
    const active = input.active == null ? 1 : Number(input.active);
    if (![0, 1].includes(active)) semanticError('invalid_active', 'active must be 0 or 1');
    const semantic = {
      kind,
      parent_code: parentCode,
      value_type: valueType,
      quantity_kind: boundedText(input.quantity_kind, 'quantity_kind', { maxBytes: 240 }),
      basis: boundedText(input.basis, 'basis', { maxBytes: 240 }),
      default_unit_code: boundedText(input.default_unit_code, 'default_unit_code', { maxBytes: 4096 }),
    };
    await validateVocabularyContract(tx, expectedCode, semantic, constraintsJson, principal);
    if (existing && await customTermIsUsed(tx, expectedCode)) {
      for (const field of Object.keys(semantic)) {
        if (nullable(existing[field]) !== nullable(semantic[field])) {
          throw apiError(409, 'semantic_fields_frozen', 'Used vocabulary semantics cannot be changed', { field });
        }
      }
      if (semantic.kind === 'unit') {
        const previousFacts = unitFacts(unitRuleRow(existing));
        const nextFacts = unitFacts(unitRuleRow(semantic, parsedConstraintObject(constraintsJson)));
        const conversionFields = ['dimension', 'canonical_unit_code', 'scale', 'offset'];
        if (!previousFacts || !nextFacts || conversionFields.some(function(field) {
          return previousFacts[field] !== nextFacts[field];
        })) {
          throw apiError(409, 'semantic_fields_frozen', 'Used vocabulary semantics cannot be changed', {
            field: 'conversion',
          });
        }
      }
    }
    const now = new Date().toISOString();
    const nextVersion = creating ? 1 : Number(existing.sync_version) + 1;
    const createdAt = creating ? now : existing.created_at;
    const values = [
      expectedCode,
      semantic.kind,
      semantic.parent_code,
      semantic.value_type,
      semantic.quantity_kind,
      semantic.basis,
      semantic.default_unit_code,
      labelsJson,
      boundedText(input.icon_key, 'icon_key', { maxBytes: 240 }),
      constraintsJson,
      boundedText(input.agrovoc_uri, 'agrovoc_uri', { maxBytes: 4096 }),
      boundedText(input.icasa_code, 'icasa_code', { maxBytes: 4096 }),
      boundedText(input.adapt_code, 'adapt_code', { maxBytes: 4096 }),
      'custom',
      principal.owner_user_uuid,
      principal.gateway_device_eui,
      customFieldUuid,
      active,
      Number.isInteger(input.sort_order) ? input.sort_order : 0,
      nextVersion,
      createdAt,
      null,
    ];
    if (creating) {
      await dbRun(
        tx,
        'INSERT INTO journal_vocab (' +
          'code,kind,parent_code,value_type,quantity_kind,basis,default_unit_code,labels_json,icon_key,' +
          'constraints_json,agrovoc_uri,icasa_code,adapt_code,scope,owner_user_uuid,gateway_device_eui,' +
          'custom_field_uuid,active,sort_order,sync_version,created_at,deleted_at' +
        ') VALUES (' + values.map(function() { return '?'; }).join(',') + ')',
        values
      );
    } else {
      await dbRun(
        tx,
        'UPDATE journal_vocab SET kind=?,parent_code=?,value_type=?,quantity_kind=?,basis=?,' +
          'default_unit_code=?,labels_json=?,icon_key=?,constraints_json=?,agrovoc_uri=?,icasa_code=?,' +
          'adapt_code=?,active=?,sort_order=?,sync_version=?,deleted_at=? WHERE code=? AND sync_version=?',
        [semantic.kind, semantic.parent_code, semantic.value_type, semantic.quantity_kind, semantic.basis,
          semantic.default_unit_code, labelsJson, values[8], constraintsJson, values[10], values[11], values[12],
          active, values[18], nextVersion, null, expectedCode, existing.sync_version]
      );
      await dbRun(tx, 'DELETE FROM journal_vocab_mappings WHERE term_code=?', [expectedCode]);
    }
    for (const mapping of mappings) {
      await dbRun(
        tx,
        'INSERT INTO journal_vocab_mappings (' +
          'term_code,scheme_uri,scheme_version,mapping_role,external_id,external_parent_id,' +
          'mapping_relation,source_uri,active' +
        ') VALUES (?,?,?,?,?,?,?,?,?)',
        [expectedCode, mapping.scheme_uri, mapping.scheme_version, mapping.mapping_role,
          mapping.external_id, mapping.external_parent_id, mapping.mapping_relation,
          mapping.source_uri, mapping.active]
      );
    }
    const row = await dbGet(tx, 'SELECT * FROM journal_vocab WHERE code=?', [expectedCode]);
    const persistedMappings = await dbAll(
      tx,
      'SELECT * FROM journal_vocab_mappings WHERE term_code=? ' +
        'ORDER BY scheme_uri,mapping_role,external_id',
      [expectedCode]
    );
    const aggregate = vocabAggregate(row, persistedMappings);
    const { emitJournalOutbox } = require('./lifecycle');
    const emission = await emitJournalOutbox(tx, {
      aggregate,
      aggregate_type: 'JOURNAL_VOCAB',
      aggregate_key: customFieldUuid,
      sync_version: nextVersion,
      occurred_at: now,
      gateway_device_eui: principal.gateway_device_eui,
    }, 'JOURNAL_VOCAB_UPSERTED');
    await recordResourceCommand(tx, principal, {
      aggregate,
      aggregate_key: customFieldUuid,
      aggregate_type: 'JOURNAL_VOCAB',
      base_sync_version: input.base_sync_version,
      command_type: 'UPSERT_JOURNAL_CUSTOM_VOCAB',
      effect_prefix: 'journal_vocab',
      gateway_device_eui: principal.gateway_device_eui,
      sync_version: nextVersion,
    });
    return { custom_vocab: aggregate, outbox_event_uuid: emission.event_uuid, created: creating };
  });
}

function plotGroupAggregate(row, members) {
  return {
    contract_version: 1,
    group_uuid: row.group_uuid,
    label: row.label,
    owner_user_uuid: row.owner_user_uuid,
    gateway_device_eui: row.gateway_device_eui,
    created_by_principal_uuid: row.created_by_principal_uuid,
    created_at: row.created_at,
    resolved_at: nullable(row.resolved_at),
    resolved_by_principal_uuid: nullable(row.resolved_by_principal_uuid),
    sync_version: Number(row.sync_version),
    deleted_at: nullable(row.deleted_at),
    members: members.slice().sort(),
  };
}

async function loadCurrentAggregateInSnapshot(db, type, key, principal) {
  const scope = [key, principal.owner_user_uuid, principal.gateway_device_eui];
  if (type === 'UPSERT_JOURNAL_ENTRY' || type === 'VOID_JOURNAL_ENTRY') {
    const row = await dbGet(
      db,
      'SELECT * FROM journal_entries WHERE entry_uuid=? AND owner_user_uuid=? ' +
        'AND gateway_device_eui=? AND deleted_at IS NULL LIMIT 1',
      scope
    );
    if (!row) return null;
    const values = await dbAll(
      db,
      'SELECT * FROM journal_entry_values WHERE entry_uuid=? ORDER BY group_index,attribute_code',
      [key]
    );
    return buildAggregate(Object.assign({ contract_version: 1 }, row), values);
  }
  if (type === 'UPSERT_JOURNAL_CUSTOM_VOCAB') {
    const row = await dbGet(
      db,
      'SELECT * FROM journal_vocab WHERE custom_field_uuid=? AND owner_user_uuid=? ' +
        'AND gateway_device_eui=? AND deleted_at IS NULL LIMIT 1',
      scope
    );
    if (!row) return null;
    const mappings = await dbAll(
      db,
      'SELECT * FROM journal_vocab_mappings WHERE term_code=? ' +
        'ORDER BY scheme_uri,mapping_role,external_id',
      [row.code]
    );
    return vocabAggregate(row, mappings);
  }
  if (type === 'UPSERT_JOURNAL_PLOT') {
    const row = await dbGet(
      db,
      'SELECT * FROM journal_plots WHERE plot_uuid=? AND owner_user_uuid=? ' +
        'AND gateway_device_eui=? AND deleted_at IS NULL LIMIT 1',
      scope
    );
    if (!row) return null;
    const settings = await dbGet(
      db,
      'SELECT * FROM journal_plot_settings WHERE plot_uuid=? LIMIT 1',
      [key]
    );
    if (!settings) return null;
    return plotAggregate(row, settings);
  }
  if (type === 'UPSERT_JOURNAL_PLOT_GROUP') {
    const row = await dbGet(
      db,
      'SELECT * FROM journal_plot_groups WHERE group_uuid=? AND owner_user_uuid=? ' +
        'AND gateway_device_eui=? AND deleted_at IS NULL LIMIT 1',
      scope
    );
    if (!row) return null;
    const members = await dbAll(
      db,
      'SELECT plot_uuid FROM journal_plot_group_members WHERE group_uuid=? ORDER BY plot_uuid',
      [key]
    );
    return plotGroupAggregate(row, members.map(function(member) { return member.plot_uuid; }));
  }
  return null;
}

async function loadCurrentAggregate(db, type, key, principal) {
  return inReadSnapshot(db, function(snapshot) {
    return loadCurrentAggregateInSnapshot(snapshot, type, key, principal);
  });
}

async function validatedGroupMembers(tx, rawMembers, principal) {
  if (!Array.isArray(rawMembers)) semanticError('invalid_members', 'members must be an array');
  if (rawMembers.length > 100) throw apiError(413, 'too_many_members', 'A plot group may contain at most 100 plots');
  const members = rawMembers.map(function(value) { return canonicalUuid(value, 'members', true); });
  if (new Set(members).size !== members.length) semanticError('duplicate_member', 'Plot group members must be unique');
  if (!members.length) return members;
  const rows = await dbAll(
    tx,
    'SELECT p.plot_uuid,s.layout_code FROM journal_plots AS p ' +
      'JOIN journal_plot_settings AS s ON s.plot_uuid=p.plot_uuid ' +
      'WHERE p.plot_uuid IN (' + members.map(function() { return '?'; }).join(',') + ') ' +
        'AND p.owner_user_uuid=? AND p.gateway_device_eui=? AND p.active=1 AND p.deleted_at IS NULL',
    members.concat([principal.owner_user_uuid, principal.gateway_device_eui])
  );
  if (rows.length !== members.length) throw apiError(404, 'not_found', 'One or more plots were not found');
  if (new Set(rows.map(function(row) { return row.layout_code; })).size > 1) {
    semanticError('heterogeneous_group', 'All plots in a group must use the same layout');
  }
  return members.sort();
}

async function upsertPlotGroup(db, input, principal, pathUuid) {
  assertBodyLimit(input);
  assertNoRequestIdentity(input);
  const inputUuid = canonicalUuid(input.group_uuid, 'group_uuid', !pathUuid);
  const groupUuid = canonicalUuid(pathUuid || inputUuid, 'group_uuid', true);
  if (inputUuid && inputUuid !== groupUuid) badRequest('path_body_mismatch', 'Path and body group UUID differ');
  return writeTransaction(db, async function(tx) {
    const existing = await dbGet(
      tx,
      'SELECT * FROM journal_plot_groups WHERE group_uuid=? AND owner_user_uuid=? AND gateway_device_eui=? ' +
        'AND deleted_at IS NULL',
      [groupUuid, principal.owner_user_uuid, principal.gateway_device_eui]
    );
    if (pathUuid && !existing) throw apiError(404, 'not_found', 'Plot group was not found');
    if (!pathUuid && !existing &&
        await dbGet(tx, 'SELECT 1 FROM journal_plot_groups WHERE group_uuid=?', [groupUuid])) {
      throw apiError(404, 'not_found', 'Plot group was not found');
    }
    const creating = !existing;
    exactBaseVersion(input.base_sync_version, creating);
    if (existing && Number(existing.sync_version) !== input.base_sync_version) {
      throw apiError(409, 'stale_version', 'Plot group version is stale');
    }
    const label = boundedText(input.label, 'label', { required: true, maxBytes: 4096 });
    if (typeof input.resolved !== 'boolean') semanticError('invalid_resolved', 'resolved must be a boolean');
    const resolved = input.resolved;
    const storedMembers = existing
      ? (await dbAll(
        tx,
        'SELECT m.plot_uuid FROM journal_plot_group_members AS m ' +
          'JOIN journal_plot_groups AS g ON g.group_uuid=m.group_uuid ' +
          'JOIN journal_plots AS p ON p.plot_uuid=m.plot_uuid ' +
          'WHERE m.group_uuid=? AND g.owner_user_uuid=? AND g.gateway_device_eui=? ' +
            'AND p.owner_user_uuid=? AND p.gateway_device_eui=? ORDER BY m.plot_uuid',
        [groupUuid, principal.owner_user_uuid, principal.gateway_device_eui,
          principal.owner_user_uuid, principal.gateway_device_eui]
      )).map(function(row) { return row.plot_uuid; })
      : [];
    const requestedMembers = Array.isArray(input.members)
      ? input.members.map(function(value) { return canonicalUuid(value, 'members', true); }).sort()
      : null;
    if (!requestedMembers) semanticError('invalid_members', 'members must be an array');
    const sameMembers = JSON.stringify(storedMembers) === JSON.stringify(requestedMembers);
    if (existing && existing.resolved_at && resolved && !sameMembers) {
      throw apiError(409, 'resolved_group_members_frozen', 'Unresolve the plot group before changing membership');
    }
    let members;
    if (existing && existing.resolved_at && resolved && sameMembers) {
      members = storedMembers;
    } else {
      members = await validatedGroupMembers(tx, requestedMembers, principal);
    }
    if (!resolved && members.length === 0) {
      semanticError('empty_active_group', 'An unresolved plot group must contain at least one plot');
    }
    const now = new Date().toISOString();
    const nextVersion = creating ? 1 : Number(existing.sync_version) + 1;
    const createdAt = creating ? now : existing.created_at;
    const creator = creating ? principal.author_principal_uuid : existing.created_by_principal_uuid;
    const resolvedAt = resolved ? (existing && existing.resolved_at ? existing.resolved_at : now) : null;
    const resolver = resolved ? (existing && existing.resolved_by_principal_uuid
      ? existing.resolved_by_principal_uuid
      : principal.author_principal_uuid) : null;
    if (creating) {
      await dbRun(
        tx,
        'INSERT INTO journal_plot_groups (' +
          'group_uuid,label,gateway_device_eui,created_by_principal_uuid,created_at,resolved_at,' +
          'resolved_by_principal_uuid,sync_version,deleted_at,owner_user_uuid' +
        ') VALUES (?,?,?,?,?,?,?,?,?,?)',
        [groupUuid, label, principal.gateway_device_eui, creator, createdAt,
          resolvedAt, resolver, nextVersion, null, principal.owner_user_uuid]
      );
    } else {
      await dbRun(
        tx,
        'UPDATE journal_plot_groups SET label=?,resolved_at=?,resolved_by_principal_uuid=?,' +
          'sync_version=? WHERE group_uuid=? AND owner_user_uuid=? AND gateway_device_eui=? AND sync_version=?',
        [label, resolvedAt, resolver, nextVersion, groupUuid, principal.owner_user_uuid,
          principal.gateway_device_eui, existing.sync_version]
      );
      await dbRun(
        tx,
        'DELETE FROM journal_plot_group_members WHERE group_uuid=? ' +
          'AND EXISTS (SELECT 1 FROM journal_plot_groups AS g WHERE g.group_uuid=? ' +
            'AND g.owner_user_uuid=? AND g.gateway_device_eui=?)',
        [groupUuid, groupUuid, principal.owner_user_uuid, principal.gateway_device_eui]
      );
    }
    for (const plotUuid of members) {
      await dbRun(
        tx,
        'INSERT INTO journal_plot_group_members (group_uuid,plot_uuid) ' +
          'SELECT g.group_uuid,p.plot_uuid FROM journal_plot_groups AS g,journal_plots AS p ' +
          'WHERE g.group_uuid=? AND g.owner_user_uuid=? AND g.gateway_device_eui=? ' +
            'AND g.deleted_at IS NULL AND p.plot_uuid=? AND p.owner_user_uuid=? ' +
            'AND p.gateway_device_eui=? AND p.deleted_at IS NULL',
        [groupUuid, principal.owner_user_uuid, principal.gateway_device_eui, plotUuid,
          principal.owner_user_uuid, principal.gateway_device_eui]
      );
    }
    const row = await dbGet(
      tx,
      'SELECT * FROM journal_plot_groups WHERE group_uuid=? AND owner_user_uuid=? AND gateway_device_eui=?',
      [groupUuid, principal.owner_user_uuid, principal.gateway_device_eui]
    );
    const aggregate = plotGroupAggregate(row, members);
    const { emitJournalOutbox } = require('./lifecycle');
    const emission = await emitJournalOutbox(tx, {
      aggregate,
      aggregate_type: 'JOURNAL_PLOT_GROUP',
      aggregate_key: groupUuid,
      sync_version: nextVersion,
      occurred_at: now,
      gateway_device_eui: principal.gateway_device_eui,
    }, 'JOURNAL_PLOT_GROUP_UPSERTED');
    await recordResourceCommand(tx, principal, {
      aggregate,
      aggregate_key: groupUuid,
      aggregate_type: 'JOURNAL_PLOT_GROUP',
      base_sync_version: input.base_sync_version,
      command_type: 'UPSERT_JOURNAL_PLOT_GROUP',
      effect_prefix: 'journal_plot_group',
      gateway_device_eui: principal.gateway_device_eui,
      sync_version: nextVersion,
    });
    return { plot_group: aggregate, outbox_event_uuid: emission.event_uuid, created: creating };
  });
}

async function listPlotGroupsInSnapshot(db, principal) {
  const rows = await dbAll(
    db,
    'SELECT * FROM journal_plot_groups WHERE owner_user_uuid=? AND gateway_device_eui=? AND deleted_at IS NULL ' +
      'ORDER BY resolved_at IS NOT NULL,label,group_uuid',
    [principal.owner_user_uuid, principal.gateway_device_eui]
  );
  if (!rows.length) return { plot_groups: [] };
  const ids = rows.map(function(row) { return row.group_uuid; });
  const memberships = await dbAll(
    db,
      'SELECT m.group_uuid,m.plot_uuid FROM journal_plot_group_members AS m ' +
      'JOIN journal_plot_groups AS g ON g.group_uuid=m.group_uuid ' +
      'JOIN journal_plots AS p ON p.plot_uuid=m.plot_uuid ' +
      'WHERE m.group_uuid IN (' + ids.map(function() { return '?'; }).join(',') + ') ' +
      'AND g.owner_user_uuid=? AND g.gateway_device_eui=? ' +
      'AND p.owner_user_uuid=? AND p.gateway_device_eui=? ' +
      'ORDER BY m.group_uuid,m.plot_uuid',
    ids.concat([principal.owner_user_uuid, principal.gateway_device_eui,
      principal.owner_user_uuid, principal.gateway_device_eui])
  );
  const byGroup = new Map();
  for (const member of memberships) {
    if (!byGroup.has(member.group_uuid)) byGroup.set(member.group_uuid, []);
    byGroup.get(member.group_uuid).push(member.plot_uuid);
  }
  return {
    plot_groups: rows.map(function(row) {
      return plotGroupAggregate(row, byGroup.get(row.group_uuid) || []);
    }),
  };
}

async function listPlotGroups(db, principal) {
  return inReadSnapshot(db, function(snapshot) {
    return listPlotGroupsInSnapshot(snapshot, principal);
  });
}

async function inReadSnapshot(db, executor) {
  if (db && typeof db.readSnapshot === 'function') return db.readSnapshot(executor);
  return executor(db);
}

async function forEachEntryPage(db, rawFilters, principal, visitor) {
  const filters = Object.assign({}, canonicalExportSelection(rawFilters), { limit: 50 });
  for (;;) {
    const page = await listEntries(db, filters, principal);
    await visitor(page.entries);
    if (!page.next_cursor) break;
    filters.cursor = page.next_cursor;
  }
}

async function scanEntrySummary(db, rawFilters, principal) {
  const summary = {
    entries: 0,
    values: 0,
    occurred_from: null,
    occurred_to: null,
    occurred_end_from: null,
    occurred_end_to: null,
    recorded_from: null,
    recorded_to: null,
  };
  const plotUuids = new Set();
  const zoneUuids = new Set();
  const templateVersions = new Map();
  const layoutVersions = new Map();
  const unitRoles = new Map();
  const contextGenerators = new Map();
  let unpinnedContextEntries = 0;
  let noContextEntries = 0;
  const rememberVersion = function(target, code, version) {
    const key = String(code) + '\u0000' + String(version);
    if (!target.has(key)) target.set(key, { code: String(code), version: Number(version) });
  };
  const rememberUnit = function(code, role) {
    if (!code) return;
    if (!unitRoles.has(code)) unitRoles.set(code, new Set());
    unitRoles.get(code).add(role);
  };
  await forEachEntryPage(db, rawFilters, principal, async function(entries) {
    for (const entry of entries) {
      summary.entries += 1;
      summary.values += entry.values.length;
      if (entry.plot_uuid) plotUuids.add(entry.plot_uuid);
      if (entry.zone_uuid) zoneUuids.add(entry.zone_uuid);
      rememberVersion(templateVersions, entry.template_code, entry.template_version);
      rememberVersion(layoutVersions, entry.layout_code, entry.layout_version);
      for (const value of entry.values) {
        rememberUnit(value.entered_unit_code, 'entered');
        rememberUnit(value.unit_code, 'canonical');
      }
      if (summary.occurred_from == null || entry.occurred_start < summary.occurred_from) {
        summary.occurred_from = entry.occurred_start;
      }
      if (summary.occurred_to == null || entry.occurred_start > summary.occurred_to) {
        summary.occurred_to = entry.occurred_start;
      }
      const effectiveEnd = entry.occurred_end || entry.occurred_start;
      if (summary.occurred_end_from == null || effectiveEnd < summary.occurred_end_from) {
        summary.occurred_end_from = effectiveEnd;
      }
      if (summary.occurred_end_to == null || effectiveEnd > summary.occurred_end_to) {
        summary.occurred_end_to = effectiveEnd;
      }
      if (summary.recorded_from == null || entry.recorded_at < summary.recorded_from) {
        summary.recorded_from = entry.recorded_at;
      }
      if (summary.recorded_to == null || entry.recorded_at > summary.recorded_to) {
        summary.recorded_to = entry.recorded_at;
      }
      if (entry.context_json == null) {
        noContextEntries += 1;
      } else {
        let context = null;
        try {
          context = typeof entry.context_json === 'string'
            ? JSON.parse(entry.context_json)
            : entry.context_json;
        } catch (_) {
          context = null;
        }
        const name = context && context.generator_name;
        const version = context && Number(context.generator_version);
        const contractHash = context && context.generator_contract_sha256;
        if (typeof name === 'string' && name && Number.isInteger(version) && version > 0 &&
            typeof contractHash === 'string' && /^[a-f0-9]{64}$/.test(contractHash)) {
          const key = name + '\u0000' + String(version) + '\u0000' + contractHash;
          const existing = contextGenerators.get(key);
          if (existing) existing.entry_count += 1;
          else {
            contextGenerators.set(key, {
              generator_name: name,
              generator_version: version,
              generator_contract_sha256: contractHash,
              entry_count: 1,
            });
          }
        } else {
          unpinnedContextEntries += 1;
        }
      }
    }
  });
  const versionSort = function(left, right) {
    return codePointCompare(left.code, right.code) || left.version - right.version;
  };
  summary.plot_uuids = [...plotUuids].sort();
  summary.zone_uuids = [...zoneUuids].sort();
  summary.template_versions = [...templateVersions.values()].sort(versionSort);
  summary.layout_versions = [...layoutVersions.values()].sort(versionSort);
  summary.units = [...unitRoles.entries()].map(function(pair) {
    return { unit_code: pair[0], roles: [...pair[1]].sort() };
  }).sort(function(left, right) { return codePointCompare(left.unit_code, right.unit_code); });
  summary.context_generators = [...contextGenerators.values()].sort(function(left, right) {
    return codePointCompare(left.generator_name, right.generator_name) ||
      left.generator_version - right.generator_version ||
      codePointCompare(left.generator_contract_sha256, right.generator_contract_sha256);
  });
  summary.unpinned_context_entries = unpinnedContextEntries;
  summary.no_context_entries = noContextEntries;
  return summary;
}

async function forEachWidePage(db, rawFilters, principal, visitor) {
  const sourceFilters = canonicalExportSelection(rawFilters);
  const query = await buildEntryWhere(db, sourceFilters, principal, false);
  const fixedColumns = [
    'entry_uuid', 'plot_uuid', 'zone_uuid', 'activity_code', 'template_code', 'template_version',
    'layout_code', 'layout_version', 'occurred_start', 'occurred_end', 'occurred_timezone', 'status',
    'campaign_uuid', 'protocol_code', 'protocol_version', 'observation_unit_code', 'pass_uuid',
    'batch_uuid', 'note', 'sync_version',
  ];
  let cursor = null;
  const pageSize = 50;
  for (;;) {
    const clauses = query.clauses.slice();
    const params = query.params.slice();
    if (cursor) {
      clauses.push('(e.occurred_start<? OR (e.occurred_start=? AND e.entry_uuid>?))');
      params.push(cursor.occurred_start, cursor.occurred_start, cursor.entry_uuid);
    }
    params.push(pageSize);
    const rows = await dbAll(
      db,
      'SELECT ' + fixedColumns.map(function(column) { return 'e.' + column; }).join(',') +
        ' FROM journal_entries AS e WHERE ' + clauses.join(' AND ') +
        ' ORDER BY e.occurred_start DESC,e.entry_uuid ASC LIMIT ?',
      params
    );
    if (!rows.length) break;
    const uuids = rows.map(function(row) { return row.entry_uuid; });
    const values = await dbAll(
      db,
      'SELECT entry_uuid,attribute_code,group_index,value_status,value_num,value_text,unit_code ' +
        'FROM journal_entry_values WHERE entry_uuid IN (' +
        uuids.map(function() { return '?'; }).join(',') +
        ') ORDER BY entry_uuid,group_index,attribute_code',
      uuids
    );
    const byEntry = new Map();
    for (const value of values) {
      if (!byEntry.has(value.entry_uuid)) byEntry.set(value.entry_uuid, []);
      byEntry.get(value.entry_uuid).push(value);
    }
    for (const row of rows) row.values = byEntry.get(row.entry_uuid) || [];
    await visitor(rows, fixedColumns);
    if (rows.length < pageSize) break;
    const last = rows[rows.length - 1];
    cursor = { occurred_start: last.occurred_start, entry_uuid: last.entry_uuid };
  }
}

function researchEntry(entry) {
  const output = Object.assign({}, entry);
  for (const field of RESEARCH_IDENTITY_FIELDS) delete output[field];
  return output;
}

function formulaSafeText(value) {
  const text = String(value == null ? '' : value);
  return /^[ \u00a0]*(?:[=+\-@]|\t|\r)/.test(text) ? "'" + text : text;
}

function csvCell(value, protectFormulaStrings) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  let text;
  if (value == null) text = '';
  else if (typeof value === 'object') text = JSON.stringify(value);
  else text = String(value);
  if (protectFormulaStrings !== false) text = formulaSafeText(text);
  return '"' + text.replace(/"/g, '""') + '"';
}

function csvLine(columns, row, protectFormulaStrings) {
  return columns.map(function(column) {
    return csvCell(row[column], protectFormulaStrings);
  }).join(',') + '\r\n';
}

function writableAborted(writable) {
  return Boolean(writable && (writable.destroyed || writable.writableEnded));
}

async function writeChunk(writable, chunk) {
  if (writableAborted(writable)) throw apiError(499, 'client_aborted', 'Export client disconnected');
  if (!writable.write(chunk)) {
    await new Promise(function(resolve, reject) {
      const cleanup = function() {
        writable.removeListener('drain', onDrain);
        writable.removeListener('close', onClose);
        writable.removeListener('error', onError);
      };
      const onDrain = function() {
        cleanup();
        resolve();
      };
      const onClose = function() {
        cleanup();
        reject(apiError(499, 'client_aborted', 'Export client disconnected'));
      };
      const onError = function(error) {
        cleanup();
        reject(error);
      };
      writable.once('drain', onDrain);
      writable.once('close', onClose);
      writable.once('error', onError);
    });
  }
}

function optionalSink(writable) {
  if (writable) return { writable, collected: null };
  const chunks = [];
  return {
    writable: {
      destroyed: false,
      writableEnded: false,
      write(chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk), 'utf8'));
        return true;
      },
      end() {
        this.writableEnded = true;
      },
    },
    collected: chunks,
  };
}

function collectedResult(sink, asText) {
  if (!sink.collected) return null;
  const buffer = Buffer.concat(sink.collected);
  return asText ? buffer.toString('utf8') : buffer;
}

async function finishWritable(writable) {
  if (!writableAborted(writable)) writable.end();
}

async function exportWideCsv(db, rawFilters, principal, writable) {
  const sink = optionalSink(writable);
  await inReadSnapshot(db, async function(snapshot) {
    const selection = canonicalExportSelection(rawFilters);
    const query = await buildEntryWhere(snapshot, selection, principal, false);
    const cells = await dbAll(
      snapshot,
      'SELECT DISTINCT v.group_index,v.attribute_code FROM journal_entries AS e ' +
        'JOIN journal_entry_values AS v ON v.entry_uuid=e.entry_uuid WHERE ' +
        query.clauses.join(' AND ') + ' ORDER BY v.group_index,v.attribute_code',
      query.params
    );
    const dynamic = [];
    for (const cell of cells) {
      const prefix = 'value.' + String(cell.group_index) + '.' + cell.attribute_code;
      dynamic.push(prefix + '.status', prefix + '.value', prefix + '.unit');
    }
    const fixed = [
      'entry_uuid', 'plot_uuid', 'zone_uuid', 'activity_code', 'template_code', 'template_version',
      'layout_code', 'layout_version', 'occurred_start', 'occurred_end', 'occurred_timezone', 'status',
      'campaign_uuid', 'protocol_code', 'protocol_version', 'observation_unit_code', 'pass_uuid',
      'batch_uuid', 'note', 'sync_version',
    ];
    const columns = fixed.concat(dynamic);
    await writeChunk(sink.writable, columns.map(function(column) {
      return csvCell(column, true);
    }).join(',') + '\r\n');
    await forEachWidePage(snapshot, selection, principal, async function(entries) {
      let chunk = '';
      for (const entry of entries) {
        const row = {};
        for (const column of fixed) row[column] = entry[column];
        for (const value of entry.values || []) {
          const prefix = 'value.' + String(value.group_index) + '.' + value.attribute_code;
          row[prefix + '.status'] = value.value_status;
          row[prefix + '.value'] = value.value_num == null ? value.value_text : value.value_num;
          row[prefix + '.unit'] = value.unit_code;
        }
        chunk += csvLine(columns, row);
      }
      if (chunk) await writeChunk(sink.writable, chunk);
    });
    await finishWritable(sink.writable);
  });
  return collectedResult(sink, true);
}

function entryRows(entries) {
  return entries.map(function(entry) {
    const row = researchEntry(entry);
    delete row.values;
    return row;
  });
}

function valueRows(entries) {
  return entries.flatMap(function(entry) {
    return (entry.values || []).map(function(value) {
      return {
        entry_uuid: entry.entry_uuid,
        attribute_code: value.attribute_code,
        group_index: value.group_index,
        value_status: value.value_status,
        entered_value_num: nullable(value.entered_value_num),
        entered_unit_code: nullable(value.entered_unit_code),
        value_num: nullable(value.value_num),
        value_text: nullable(value.value_text),
        unit_code: nullable(value.unit_code),
      };
    });
  });
}

function availableFact(rawValue, unavailableReason) {
  const value = rawValue == null ? '' : String(rawValue).trim();
  return value
    ? { value, reason: null }
    : { value: null, reason: unavailableReason };
}

function definitionMetadata(uses, index, unavailableReason) {
  return uses.map(function(use) {
    const versions = index.get(use.code);
    const row = versions && versions.get(use.version);
    const raw = row && typeof row.definition_json === 'string' ? row.definition_json : null;
    return {
      code: use.code,
      version: use.version,
      hash_scope: 'raw_definition_json_utf8',
      definition_sha256: raw == null
        ? null
        : crypto.createHash('sha256').update(raw, 'utf8').digest('hex'),
      reason: raw == null ? unavailableReason : null,
    };
  });
}

function mappingSourceMetadata(mappings) {
  const sources = new Map();
  for (const mapping of mappings || []) {
    const sourceUri = typeof mapping.source_uri === 'string' && mapping.source_uri.trim()
      ? mapping.source_uri.trim()
      : null;
    const key = String(mapping.scheme_uri || '') + '\u0000' + String(mapping.scheme_version || '') +
      '\u0000' + String(sourceUri || '');
    if (!sources.has(key)) {
      sources.set(key, {
        scheme_uri: nullable(mapping.scheme_uri),
        scheme_version: nullable(mapping.scheme_version),
        source_uri: availableFact(sourceUri, 'mapping_source_uri_not_recorded'),
        license: { value: null, reason: 'mapping_license_not_recorded' },
        mapping_count: 0,
      });
    }
    sources.get(key).mapping_count += 1;
  }
  return [...sources.values()].sort(function(left, right) {
    return codePointCompare(left.scheme_uri || '', right.scheme_uri || '') ||
      codePointCompare(left.scheme_version || '', right.scheme_version || '') ||
      codePointCompare(left.source_uri.value || '', right.source_uri.value || '');
  });
}

function unitTransformationMetadata(units, catalog) {
  return units.map(function(use) {
    const row = catalog.vocabByCode.get(use.unit_code);
    if (!row || row.kind !== 'unit') {
      return {
        unit_code: use.unit_code,
        roles: use.roles,
        transformation: null,
        hash_scope: 'raw_constraints_json_utf8',
        definition_sha256: null,
        reason: 'unit_definition_not_installed',
      };
    }
    const raw = typeof row.constraints_json === 'string' ? row.constraints_json : null;
    const constraints = row.constraints && typeof row.constraints === 'object' ? row.constraints : {};
    const toCanonical = constraints.to_canonical && typeof constraints.to_canonical === 'object'
      ? constraints.to_canonical
      : null;
    return {
      unit_code: use.unit_code,
      roles: use.roles,
      transformation: {
        quantity_kind: nullable(row.quantity_kind),
        basis: nullable(row.basis),
        dimension: nullable(constraints.dimension),
        to_canonical: toCanonical,
        formula: toCanonical ? 'canonical_value = entered_value * scale + offset' : null,
      },
      hash_scope: 'raw_constraints_json_utf8',
      definition_sha256: raw == null
        ? null
        : crypto.createHash('sha256').update(raw, 'utf8').digest('hex'),
      reason: toCanonical ? null : 'unit_transformation_not_recorded',
    };
  });
}

function frozenContextGeneratorMetadata(summary) {
  const unpinnedCount = Number(summary.unpinned_context_entries || 0);
  const noContextCount = Number(summary.no_context_entries || 0);
  return {
    hash_scope: 'frozen_context_json_generator_contract',
    pinned: summary.context_generators || [],
    per_capture_binary_hash: {
      value: null,
      reason: 'context_generator_binary_hash_not_recorded_at_capture',
    },
    unpinned_entries: {
      count: unpinnedCount,
      reason: unpinnedCount ? 'context_generator_pin_not_recorded' : null,
    },
    no_context_entries: {
      count: noContextCount,
      reason: noContextCount ? 'context_snapshot_not_recorded' : null,
    },
  };
}

function exportMetadata(summary, principal, catalog, selection, environment, generatedAt) {
  environment = environment || {};
  return {
    metadata_contract: {
      name: RESEARCH_METADATA_DESCRIPTOR.name,
      version: RESEARCH_METADATA_DESCRIPTOR.version,
      hash_scope: 'research_metadata_semantic_descriptor_v1',
      hash_sha256: RESEARCH_METADATA_HASH,
    },
    dataset_uuid: crypto.randomUUID(),
    export_uuid: crypto.randomUUID(),
    generated_at: generatedAt || new Date().toISOString(),
    coverage: {
      occurred_from: summary.occurred_from,
      occurred_to: summary.occurred_to,
      occurred_end_from: summary.occurred_end_from,
      occurred_end_to: summary.occurred_end_to,
      occurred_end_semantics: 'occurred_end_or_occurred_start_for_instantaneous_entries',
      recorded_from: summary.recorded_from,
      recorded_to: summary.recorded_to,
    },
    selection: Object.assign({}, selection),
    source: {
      system: 'OSI OS edge',
      authority: 'edge-canonical',
      gateway_device_eui: principal.gateway_device_eui,
      farm_identifier: { value: null, reason: 'farm_identifier_not_recorded' },
      zone_uuids: summary.zone_uuids,
      plot_uuids: summary.plot_uuids,
    },
    exporter: {
      name: 'osi-journal',
      version: { value: EXPORTER_VERSION, reason: null },
      edge_build_version: availableFact(
        environment.edgeBuildVersion,
        'edge_build_version_unavailable'
      ),
      commit: availableFact(environment.edgeBuildCommit, 'edge_build_commit_unavailable'),
    },
    schema: {
      name: RESEARCH_SCHEMA_DESCRIPTOR.name,
      version: RESEARCH_SCHEMA_DESCRIPTOR.version,
      hash_scope: 'logical_research_schema_descriptor_v1',
      hash_sha256: RESEARCH_SCHEMA_HASH,
    },
    context_generator: frozenContextGeneratorMetadata(summary),
    catalog: {
      hash_scope: 'core_catalog_state',
      core_version: Number(catalog.version),
      core_hash: catalog.hash,
      scoped_effective_hash: {
        value: null,
        reason: 'scoped_catalog_hash_not_materialized',
      },
    },
    definitions: {
      templates: definitionMetadata(
        summary.template_versions,
        catalog.templates,
        'template_definition_not_installed'
      ),
      layouts: definitionMetadata(
        summary.layout_versions,
        catalog.layouts,
        'layout_definition_not_installed'
      ),
    },
    mapping_sources: mappingSourceMetadata(catalog.mappings),
    unit_transformations: unitTransformationMetadata(summary.units, catalog),
    record_counts: {
      entries: summary.entries,
      values: summary.values,
      vocab_mappings: (catalog.mappings || []).length,
    },
    provenance: {
      author_identity_included: false,
      owner_identity_included: false,
      context_snapshot_semantics: 'frozen-at-entry-finalization',
      missing_values: 'value_status distinguishes not_observed, not_applicable, and below_detection',
    },
  };
}

async function exportJson(db, rawFilters, principal, writable, environment) {
  const sink = optionalSink(writable);
  await inReadSnapshot(db, async function(snapshot) {
    const selection = canonicalExportSelection(rawFilters);
    const summary = await scanEntrySummary(snapshot, selection, principal);
    const catalog = await loadCatalog(snapshot, principal);
    const metadata = exportMetadata(summary, principal, catalog, selection, environment);
    const prefix = {
      schema: 'osi-journal-research-v1',
      research_metadata: metadata,
    };
    const prefixText = JSON.stringify(prefix);
    await writeChunk(sink.writable, prefixText.slice(0, -1) + ',"entries":[');
    const entriesHash = crypto.createHash('sha256');
    const valuesHash = crypto.createHash('sha256');
    entriesHash.update('[');
    valuesHash.update('[');
    let first = true;
    let firstValue = true;
    await forEachEntryPage(snapshot, selection, principal, async function(entries) {
      let chunk = '';
      for (const entry of entries) {
        const serialized = JSON.stringify(researchEntry(entry));
        const separator = first ? '' : ',';
        first = false;
        chunk += separator + serialized;
        entriesHash.update(separator + serialized);
        for (const value of valueRows([entry])) {
          const valueSerialized = JSON.stringify(value);
          const valueSeparator = firstValue ? '' : ',';
          firstValue = false;
          valuesHash.update(valueSeparator + valueSerialized);
        }
      }
      if (chunk) await writeChunk(sink.writable, chunk);
    });
    entriesHash.update(']');
    valuesHash.update(']');
    await writeChunk(sink.writable, '],"record_counts":' + JSON.stringify(metadata.record_counts) +
      ',"checksums":' + JSON.stringify({
      research_metadata_sha256: crypto.createHash('sha256')
        .update(JSON.stringify(metadata), 'utf8')
        .digest('hex'),
      entries_sha256: entriesHash.digest('hex'),
      values_sha256: valuesHash.digest('hex'),
    }) + '}');
    await finishWritable(sink.writable);
  });
  return collectedResult(sink, true);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function updateCrc32(value, buffer) {
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xFF] ^ (value >>> 8);
  return value >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >>> 1),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

function zipStream(writable, generatedAt) {
  const central = [];
  let offset = 0;
  const stamp = dosDateTime(generatedAt);

  async function output(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    await writeChunk(writable, buffer);
    offset += buffer.length;
  }

  async function startMember(memberName) {
    const name = Buffer.from(memberName, 'utf8');
    if (name.length > 255) throw new Error('ZIP member name exceeds 255 UTF-8 bytes');
    const localOffset = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034B50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x08, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt16LE(name.length, 26);
    await output(local);
    await output(name);
    let crc = 0xFFFFFFFF;
    let size = 0;
    const hash = crypto.createHash('sha256');
    let finished = false;
    return {
      async write(chunk) {
        if (finished) throw new Error('ZIP member is already finished');
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
        crc = updateCrc32(crc, buffer);
        size += buffer.length;
        hash.update(buffer);
        await output(buffer);
      },
      async finish() {
        if (finished) throw new Error('ZIP member is already finished');
        finished = true;
        const checksum = (crc ^ 0xFFFFFFFF) >>> 0;
        const descriptor = Buffer.alloc(16);
        descriptor.writeUInt32LE(0x08074B50, 0);
        descriptor.writeUInt32LE(checksum, 4);
        descriptor.writeUInt32LE(size, 8);
        descriptor.writeUInt32LE(size, 12);
        await output(descriptor);
        central.push({ name, localOffset, checksum, size });
        return { name: memberName, size_bytes: size, sha256: hash.digest('hex') };
      },
    };
  }

  async function finish() {
    const centralOffset = offset;
    for (const member of central) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014B50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x08, 8);
      header.writeUInt16LE(0, 10);
      header.writeUInt16LE(stamp.time, 12);
      header.writeUInt16LE(stamp.date, 14);
      header.writeUInt32LE(member.checksum, 16);
      header.writeUInt32LE(member.size, 20);
      header.writeUInt32LE(member.size, 24);
      header.writeUInt16LE(member.name.length, 28);
      header.writeUInt32LE(member.localOffset, 42);
      await output(header);
      await output(member.name);
    }
    const centralSize = offset - centralOffset;
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054B50, 0);
    end.writeUInt16LE(central.length, 8);
    end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(centralOffset, 16);
    await output(end);
    await finishWritable(writable);
  }

  return { startMember, finish };
}

async function exportResearchPackage(db, rawFilters, principal, writable, environment) {
  const sink = optionalSink(writable);
  await inReadSnapshot(db, async function(snapshot) {
    const selection = canonicalExportSelection(rawFilters);
    const summary = await scanEntrySummary(snapshot, selection, principal);
    const catalog = await loadCatalog(snapshot, principal);
    const entryColumns = [
      'contract_version', 'entry_uuid', 'plot_uuid', 'zone_uuid', 'device_eui',
      'season_uuid', 'season_crop', 'season_variety', 'campaign_uuid', 'protocol_code',
      'protocol_version', 'observation_unit_code', 'pass_uuid', 'batch_uuid', 'activity_code',
      'template_code', 'template_version', 'layout_code', 'layout_version', 'catalog_version',
      'occurred_start', 'occurred_end', 'occurred_timezone', 'occurred_utc_offset_minutes',
      'recorded_at', 'origin', 'status', 'voided_at', 'void_reason', 'note', 'context_json',
      'sync_version', 'gateway_device_eui', 'created_at', 'updated_at', 'deleted_at',
    ];
    const valueColumns = [
      'entry_uuid', 'attribute_code', 'group_index', 'value_status', 'entered_value_num',
      'entered_unit_code', 'value_num', 'value_text', 'unit_code',
    ];
    const mappingColumns = [
      'term_code', 'scheme_uri', 'scheme_version', 'mapping_role', 'external_id',
      'external_parent_id', 'mapping_relation', 'source_uri', 'active',
    ];
    async function writeRows(member, columns, rows) {
      let chunk = '';
      for (const row of rows) {
        const line = csvLine(columns, row, false);
        if (chunk && Buffer.byteLength(chunk, 'utf8') + Buffer.byteLength(line, 'utf8') > 64 * 1024) {
          await member.write(chunk);
          chunk = '';
        }
        chunk += line;
      }
      if (chunk) await member.write(chunk);
    }
    const generatedAt = new Date();
    const writer = zipStream(sink.writable, generatedAt);
    const dataMembers = [];

    const entriesMember = await writer.startMember('entries.csv');
    await entriesMember.write(entryColumns.map(function(column) {
      return csvCell(column, false);
    }).join(',') + '\r\n');
    await forEachEntryPage(snapshot, selection, principal, async function(entries) {
      await writeRows(entriesMember, entryColumns, entryRows(entries));
    });
    dataMembers.push(await entriesMember.finish());

    const valuesMember = await writer.startMember('values.csv');
    await valuesMember.write(valueColumns.map(function(column) {
      return csvCell(column, false);
    }).join(',') + '\r\n');
    await forEachEntryPage(snapshot, selection, principal, async function(entries) {
      await writeRows(valuesMember, valueColumns, valueRows(entries));
    });
    dataMembers.push(await valuesMember.finish());

    const mappingsMember = await writer.startMember('vocab_mappings.csv');
    await mappingsMember.write(mappingColumns.map(function(column) {
      return csvCell(column, false);
    }).join(',') + '\r\n');
    await writeRows(mappingsMember, mappingColumns, catalog.mappings || []);
    dataMembers.push(await mappingsMember.finish());

    const metadata = exportMetadata(
      summary,
      principal,
      catalog,
      selection,
      environment,
      generatedAt.toISOString()
    );
    const manifest = {
      schema: 'osi-journal-research-package-v1',
      research_metadata: metadata,
      members: dataMembers,
      record_counts: metadata.record_counts,
      checksums: {
        research_metadata_sha256: crypto.createHash('sha256')
          .update(JSON.stringify(metadata), 'utf8')
          .digest('hex'),
      },
      missing_value_semantics: 'See values.csv value_status; blank values are not assumed observed.',
    };
    const manifestMember = await writer.startMember('manifest.json');
    await manifestMember.write(JSON.stringify(manifest));
    await manifestMember.finish();
    await writer.finish();
  });
  return collectedResult(sink, false);
}

function safeFilename(value, fallback) {
  let normalized = String(value || '').normalize('NFKC')
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/^\.+/, '')
    .trim();
  if (!normalized) normalized = fallback || 'journal-export';
  while (Buffer.byteLength(normalized, 'utf8') > 255) normalized = normalized.slice(0, -1);
  return normalized;
}

function errorResponse(error) {
  const knownStatus = Number(error && error.statusCode);
  const lifecycleStatuses = {
    already_exists: 409,
    stale_version: 409,
    invalid_state: 409,
    duplicate_candidate: 409,
    ownership: 404,
    plot_not_found: 404,
    zone_not_found: 404,
    not_found: 404,
    limit_exceeded: 413,
    batch_too_large: 413,
    validation_failed: 422,
    missing_custom_dependency: 422,
    season_required: 422,
  };
  const code = error && error.code ? error.code : 'internal_error';
  const statusCode = knownStatus || lifecycleStatuses[code] || 500;
  return {
    statusCode,
    payload: {
      error: statusCode === 500 ? 'internal_error' : code,
      message: statusCode === 500 ? 'Journal request failed' : String(error.message || code),
      details: statusCode === 500 ? undefined : nullable(error.details || error.errors),
    },
  };
}

function assertBearerShape(authorization) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) throw unauthorized();
  const parts = authorization.slice(7).trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw unauthorized();
}

function resolveAuthSecret(environment, warn) {
  const configured = String(environment.authTokenSecret || environment.jwtSecret || '').trim();
  if (configured) return configured;
  for (const secretPath of [
    '/data/db/osi_auth_token_secret',
    '/var/lib/node-red/.node-red/osi_auth_token_secret',
  ]) {
    try {
      const readFile = typeof environment.readFile === 'function' ? environment.readFile : fs.readFileSync;
      const value = String(readFile(secretPath, 'utf8') || '').trim();
      if (value) return value;
      warn('[journal-api] auth secret file was empty path=' + secretPath);
    } catch (error) {
      warn('[journal-api] auth secret read failed path=' + secretPath +
        ' code=' + String(error && error.code || 'unknown'));
    }
  }
  throw apiError(503, 'auth_unavailable', 'Journal authentication is unavailable');
}

function requestBody(msg) {
  const contentLength = Number(msg.req && msg.req.headers && msg.req.headers['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    throw apiError(413, 'body_too_large', 'Request body exceeds 256 KiB');
  }
  return msg.req && msg.req.body !== undefined ? msg.req.body : (msg.payload || {});
}

function streamResponse(msg, contentType, extension) {
  const response = msg.res;
  if (!response || typeof response.write !== 'function') {
    throw apiError(500, 'stream_unavailable', 'HTTP streaming response is unavailable');
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', contentType);
  response.setHeader('Access-Control-Allow-Origin', '*');
  response.setHeader(
    'Content-Disposition',
    'attachment; filename="' + safeFilename(
      'journal-' + new Date().toISOString().slice(0, 10) + extension,
      'journal-export' + extension
    ) + '"'
  );
  return response;
}

async function closeFacade(db, warn) {
  if (!db) return;
  try {
    await new Promise(function(resolve, reject) {
      db.close(function(error) {
        if (error) reject(error);
        else resolve();
      });
    });
  } catch (error) {
    warn('[journal-api] database close failed code=' + String(error && error.code || 'unknown'));
  }
}

async function handleHttpRequest(options) {
  const msg = options.msg;
  const environment = options.environment || {};
  const warn = typeof options.warn === 'function' ? options.warn : function() {};
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  };
  const respond = function(statusCode, payload) {
    msg.statusCode = statusCode;
    msg.payload = payload;
    msg.headers = headers;
    return msg;
  };
  const method = String(msg.req && msg.req.method || '').toUpperCase();
  const requestPath = String(msg.req &&
    (msg.req.path || String(msg.req.originalUrl || '').split('?')[0]) || '');
  const authorization = msg.req && msg.req.headers && msg.req.headers.authorization;
  let db = null;
  let streaming = false;
  try {
    assertBearerShape(authorization);
    const token = verifyBearer(authorization, resolveAuthSecret(environment, warn));
    db = new options.Database('/data/db/farming.db');
    const principal = await resolvePrincipal(db, token, {
      deviceEui: environment.deviceEui,
      confidence: environment.deviceEuiConfidence,
      source: environment.deviceEuiSource,
    });
    const query = msg.req && msg.req.query || {};
    const uuid = msg.req && msg.req.params && msg.req.params.uuid;
    if (method === 'GET' && requestPath === '/api/journal/catalog') {
      return respond(200, await loadScopedCatalog(db, principal));
    }
    if (method === 'GET' && requestPath === '/api/journal/entries') {
      return respond(200, await listEntries(db, query, principal));
    }
    if (method === 'POST' && requestPath === '/api/journal/entries') {
      return respond(201, await saveEntry(db, requestBody(msg), principal, { mode: 'create' }));
    }
    if (method === 'PUT' && /^\/api\/journal\/entries\/[^/]+$/.test(requestPath)) {
      return respond(200, await saveEntry(db, requestBody(msg), principal, { mode: 'update', entryUuid: uuid }));
    }
    if (method === 'POST' && /^\/api\/journal\/entries\/[^/]+\/void$/.test(requestPath)) {
      return respond(200, await voidEntry(db, uuid, requestBody(msg), principal));
    }
    if (method === 'POST' && requestPath === '/api/journal/custom-vocab') {
      return respond(201, await upsertCustomVocab(db, requestBody(msg), principal));
    }
    if (method === 'PUT' && /^\/api\/journal\/custom-vocab\/[^/]+$/.test(requestPath)) {
      return respond(200, await upsertCustomVocab(db, requestBody(msg), principal, uuid));
    }
    if (method === 'GET' && requestPath === '/api/journal/plots') {
      return respond(200, await listPlots(db, principal));
    }
    if (method === 'POST' && requestPath === '/api/journal/plots') {
      return respond(201, await upsertPlot(
        db, requestBody(msg), principal, null, { returnExistingZonePlot: true }
      ));
    }
    if (method === 'PUT' && /^\/api\/journal\/plots\/[^/]+$/.test(requestPath)) {
      return respond(200, await upsertPlot(db, requestBody(msg), principal, uuid));
    }
    if (method === 'GET' && requestPath === '/api/journal/plot-groups') {
      return respond(200, await listPlotGroups(db, principal));
    }
    if (method === 'POST' && requestPath === '/api/journal/plot-groups') {
      return respond(201, await upsertPlotGroup(db, requestBody(msg), principal));
    }
    if (method === 'PUT' && /^\/api\/journal\/plot-groups\/[^/]+$/.test(requestPath)) {
      return respond(200, await upsertPlotGroup(db, requestBody(msg), principal, uuid));
    }
    if (method === 'GET' && requestPath === '/api/journal/export.csv') {
      streaming = true;
      await exportWideCsv(db, query, principal, streamResponse(msg, 'text/csv; charset=utf-8', '.csv'));
      return null;
    }
    if (method === 'GET' && requestPath === '/api/journal/export.package') {
      streaming = true;
      await exportResearchPackage(
        db,
        query,
        principal,
        streamResponse(msg, 'application/zip', '.zip'),
        environment
      );
      return null;
    }
    if (method === 'GET' && requestPath === '/api/journal/export.json') {
      streaming = true;
      await exportJson(
        db,
        query,
        principal,
        streamResponse(msg, 'application/json; charset=utf-8', '.json'),
        environment
      );
      return null;
    }
    if (method === 'GET' && requestPath === '/api/journal/export.adapt.json') {
      return respond(501, { error: 'not_implemented', message: 'ADAPT export is not available in Slice 1' });
    }
    return respond(404, { error: 'not_found', message: 'Journal endpoint was not found' });
  } catch (error) {
    if (streaming && msg.res && msg.res.headersSent) {
      warn('[journal-api] streamed request failed code=' + String(error && error.code || 'internal_error') +
        ' status=' + String(error && error.statusCode || 500));
      if (typeof msg.res.destroy === 'function') msg.res.destroy();
      return null;
    }
    const response = errorResponse(error);
    return respond(response.statusCode, response.payload);
  } finally {
    await closeFacade(db, warn);
  }
}

module.exports = {
  errorResponse,
  exportJson,
  exportResearchPackage,
  exportWideCsv,
  handleHttpRequest,
  listEntries,
  listPlotGroups,
  listPlots,
  loadCurrentAggregate,
  loadScopedCatalog,
  resolvePrincipal,
  safeFilename,
  saveEntry,
  upsertCustomVocab,
  upsertPlot,
  upsertPlotGroup,
  verifyBearer,
  voidEntry,
};
