'use strict';

const crypto = require('node:crypto');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;
const EUI = /^[0-9a-f]{16}$/i;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CANONICAL_EUI = /^[0-9A-F]{16}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_SEQUENCE = 9223372036854775807n;
const MAX_SAFE_INTEGER = 9007199254740991;
const USER_ORIGINS = new Set(['cloud-ui', 'edge-ui']);
const FORBIDDEN_TRANSPORT_FIELDS = new Set([
  'blob', 'blob_bytes', 'blob_uuid', 'object_key', 'object_store_path', 'object_store_url',
  'remote_object_key', 'local_path', 'local_relpath', 'credential', 'credentials',
  'access_key', 'secret_key', 'signed_url', 'download_url', 'upload_url', 'url',
]);

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

function fail(message) {
  throw new TypeError('journal V2 semantic validation: ' + message);
}

function object(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field + ' must be an object');
  return value;
}

function assertNoTransportFields(value, path) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoTransportFields(item, `${path}[${index}]`));
    return;
  }
  for (const [key, member] of Object.entries(value)) {
    if (FORBIDDEN_TRANSPORT_FIELDS.has(key)) fail(`${path}.${key} is forbidden transport data`);
    assertNoTransportFields(member, `${path}.${key}`);
  }
}

function assertPayloadHash(value) {
  if (typeof value.payload_sha256 !== 'string' || !SHA256.test(value.payload_sha256)) {
    fail('payload_sha256 must be 64 lowercase hex characters');
  }
}

function assertInteger(value, minimum, maximum, message) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    fail(message + '; expected a safe integer');
  }
}

function assertDeclaredHash(envelope, actual) {
  if (envelope.payload_sha256 !== actual) fail('payload_sha256 mismatch');
}

function assertUuid(value, field) {
  if (typeof value !== 'string' || !CANONICAL_UUID.test(value)) fail(field + ' must be a canonical UUID');
}

function assertTimestamp(value, field) {
  if (typeof value !== 'string' || !CANONICAL_TIMESTAMP.test(value) || !Number.isFinite(Date.parse(value))) {
    fail(field + ' must be a canonical UTC timestamp');
  }
}

function assertEui(value, field) {
  if (typeof value !== 'string' || !CANONICAL_EUI.test(value)) fail(field + ' must be an uppercase EUI64');
}

function assertSortedUnique(items, key, field) {
  let previous = null;
  for (const item of items) {
    const current = key(item);
    if (previous !== null && previous >= current) fail(field + ' must be sorted and unique');
    previous = current;
  }
}

function assertEntryValues(entry) {
  if (!Array.isArray(entry.values)) fail('entry.values must be an array');
  assertSortedUnique(
    entry.values,
    (value) => String(value.group_index).padStart(20, '0') + '\u0000' + value.attribute_code,
    'entry.values'
  );
  for (const value of entry.values) {
    assertInteger(value.group_index, 0, MAX_SAFE_INTEGER, 'entry value group_index must be nonnegative');
    const observed = value.value_status === 'observed';
    const hasNumber = typeof value.value_num === 'number' && Number.isFinite(value.value_num);
    const hasText = typeof value.value_text === 'string';
    if (observed && hasNumber === hasText) fail('observed entry value must contain exactly one numeric or text value');
    if (!observed && (value.value_num !== null || value.value_text !== null)) {
      fail('non-observed entry value must contain null values');
    }
  }
}

function assertEntry(entry) {
  object(entry, 'entry');
  assertUuid(entry.entry_uuid, 'entry.entry_uuid');
  assertInteger(entry.template_version, 1, MAX_SAFE_INTEGER, 'entry template_version must be positive');
  assertInteger(entry.layout_version, 1, MAX_SAFE_INTEGER, 'entry layout_version must be positive');
  assertInteger(entry.catalog_version, 1, MAX_SAFE_INTEGER, 'entry catalog_version must be positive');
  assertInteger(entry.occurred_utc_offset_minutes, -840, 840, 'entry occurred_utc_offset_minutes is out of range');
  assertInteger(entry.sync_version, 0, MAX_SAFE_INTEGER, 'entry sync_version must be nonnegative');
  assertEntryValues(entry);
}

function assertProduct(product, resource) {
  object(product, 'product');
  assertInteger(product.active, 0, 1, 'product active must be zero or one');
  assertInteger(product.sync_version, 1, MAX_SAFE_INTEGER, 'product sync_version must be positive');
  if (resource && product.product_uuid !== resource.product_uuid) fail('product resource identity mismatch');
  if (resource && product.sync_version !== resource.base_version + 1) fail('product sync_version must equal base_version + 1');
}

function mappingKey(mapping) {
  return mapping.scheme_uri + '\u0000' + mapping.mapping_role + '\u0000' + mapping.external_id;
}

function assertCustomVocabulary(vocab, resource) {
  object(vocab, 'custom_vocab');
  assertInteger(vocab.active, 0, 1, 'custom vocabulary active must be zero or one');
  assertInteger(vocab.sort_order, -MAX_SAFE_INTEGER, MAX_SAFE_INTEGER, 'custom vocabulary sort_order is out of range');
  assertInteger(vocab.sync_version, 1, MAX_SAFE_INTEGER, 'custom vocabulary sync_version must be positive');
  if (resource && vocab.custom_field_uuid !== resource.custom_field_uuid) fail('custom vocabulary resource identity mismatch');
  if (vocab.code !== 'custom.' + vocab.custom_field_uuid) fail('custom vocabulary code must derive from custom_field_uuid');
  if (resource && vocab.sync_version !== resource.base_version + 1) fail('custom vocabulary sync_version must equal base_version + 1');
  if (!Array.isArray(vocab.mappings)) fail('custom vocabulary mappings must be an array');
  assertSortedUnique(vocab.mappings, mappingKey, 'custom vocabulary mappings');
  for (const mapping of vocab.mappings) {
    assertInteger(mapping.active, 0, 1, 'custom vocabulary mapping active must be zero or one');
    if (mapping.term_code !== vocab.code) fail('custom vocabulary mapping term_code mismatch');
  }
}

function assertPlot(plot, resource) {
  object(plot, 'plot');
  assertInteger(plot.active, 0, 1, 'plot active must be zero or one');
  assertInteger(plot.sync_version, 0, MAX_SAFE_INTEGER, 'plot sync_version must be nonnegative');
  const settings = object(plot.settings, 'plot settings');
  assertInteger(settings.sync_version, 0, MAX_SAFE_INTEGER, 'plot settings sync_version must be nonnegative');
  if (resource && plot.plot_uuid !== resource.plot_uuid) fail('plot resource identity mismatch');
  if (resource && plot.gateway_device_eui !== resource.gateway_device_eui) fail('plot gateway identity mismatch');
  if (resource && plot.sync_version !== resource.projection_version) fail('plot projection_version mismatch');
}

function validateMutationStructure(envelope) {
  object(envelope, 'mutation envelope');
  assertNoTransportFields(envelope, '$');
  assertPayloadHash(envelope);
  assertUuid(envelope.mutation_uuid, 'mutation_uuid');
  assertUuid(envelope.workspace_uuid, 'workspace_uuid');
  assertTimestamp(envelope.recorded_at, 'recorded_at');
  const resource = object(envelope.resource, 'resource');
  const candidate = object(envelope.candidate, 'candidate');
  switch (envelope.operation) {
    case 'ENTRY_CREATE':
    case 'ENTRY_CORRECT': {
      assertUuid(resource.entry_uuid, 'resource.entry_uuid');
      if (envelope.operation === 'ENTRY_CREATE' && resource.base_version !== 0) fail('ENTRY_CREATE base_version must be zero');
      if (envelope.operation === 'ENTRY_CORRECT') {
        assertInteger(resource.base_version, 1, MAX_SAFE_INTEGER, 'ENTRY_CORRECT base_version must be positive');
      }
      if (!USER_ORIGINS.has(envelope.origin)) fail('entry mutation origin must be cloud-ui or edge-ui');
      const entry = object(candidate.entry, 'candidate.entry');
      assertEntry(entry);
      if (entry.entry_uuid !== resource.entry_uuid) fail('entry resource identity mismatch');
      if (entry.origin !== envelope.origin) fail('entry origin must match the envelope');
      if (entry.recorded_at !== envelope.recorded_at) fail('entry recorded_at must match the envelope');
      if (entry.status !== 'final') fail('create and correction candidates must be final');
      const expected = envelope.operation === 'ENTRY_CREATE' ? 1 : resource.base_version + 1;
      if (entry.sync_version !== expected) fail('entry sync_version must be the next version');
      break;
    }
    case 'ENTRY_VOID':
      assertUuid(resource.entry_uuid, 'resource.entry_uuid');
      assertInteger(resource.base_version, 1, MAX_SAFE_INTEGER, 'ENTRY_VOID base_version must be positive');
      if (!USER_ORIGINS.has(envelope.origin)) fail('entry mutation origin must be cloud-ui or edge-ui');
      break;
    case 'PRODUCT_UPSERT':
      assertUuid(resource.product_uuid, 'resource.product_uuid');
      assertInteger(resource.base_version, 0, MAX_SAFE_INTEGER, 'product base_version must be nonnegative');
      if (!USER_ORIGINS.has(envelope.origin)) fail('reference mutation origin must be cloud-ui or edge-ui');
      assertProduct(candidate.product, resource);
      break;
    case 'CUSTOM_VOCAB_UPSERT':
      assertUuid(resource.custom_field_uuid, 'resource.custom_field_uuid');
      assertInteger(resource.base_version, 0, MAX_SAFE_INTEGER, 'custom vocabulary base_version must be nonnegative');
      if (!USER_ORIGINS.has(envelope.origin)) fail('reference mutation origin must be cloud-ui or edge-ui');
      assertCustomVocabulary(candidate.custom_vocab, resource);
      break;
    case 'PLOT_SNAPSHOT':
      assertEui(resource.gateway_device_eui, 'resource.gateway_device_eui');
      assertUuid(resource.plot_uuid, 'resource.plot_uuid');
      assertInteger(resource.projection_version, 1, MAX_SAFE_INTEGER, 'plot projection_version must be positive');
      if (envelope.origin !== 'edge-worker') fail('plot snapshot origin must be edge-worker');
      assertPlot(candidate.plot, resource);
      break;
    case 'CUTOVER_BARRIER_RECEIPT': {
      assertEui(resource.gateway_device_eui, 'resource.gateway_device_eui');
      assertUuid(resource.barrier_uuid, 'resource.barrier_uuid');
      if (envelope.origin !== 'edge-worker') fail('cutover receipt origin must be edge-worker');
      const pending = candidate.exact_pending_v1_event_uuids_sorted;
      if (!Array.isArray(pending)) fail('pending V1 UUID set must be an array');
      assertSortedUnique(pending, (uuid) => uuid, 'pending V1 UUID set');
      if (candidate.pending_set_sha256 !== sha256(pending)) fail('pending_set_sha256 mismatch');
      break;
    }
    default:
      fail('unknown mutation operation');
  }
  return true;
}

function assertSequence(sequence) {
  if (typeof sequence !== 'string' || !/^[1-9][0-9]*$/.test(sequence)) fail('sequence must be a positive decimal string');
  if (BigInt(sequence) > MAX_SEQUENCE) fail('sequence exceeds signed BIGINT');
}

function assertCropCycle(cycle) {
  object(cycle, 'crop cycle projection');
  assertInteger(cycle.sync_version, 0, MAX_SAFE_INTEGER, 'crop cycle sync_version must be nonnegative');
  if (!Array.isArray(cycle.plots)) fail('crop cycle plots must be an array');
  assertSortedUnique(cycle.plots, (plot) => plot.plot_uuid, 'crop cycle plots');
  for (const plot of cycle.plots) {
    if (plot.cycle_uuid !== cycle.cycle_uuid) fail('crop cycle plot identity mismatch');
    const open = plot.ends_on === null;
    const allCloseFieldsNull = plot.closed_by_entry_uuid === null && plot.close_reason === null;
    const allCloseFieldsPopulated = plot.closed_by_entry_uuid !== null && plot.close_reason !== null;
    if ((open && !allCloseFieldsNull) || (!open && !allCloseFieldsPopulated)) {
      fail('crop cycle close fields must be all null or all populated');
    }
  }
}

function validateReplicationStructure(envelope) {
  object(envelope, 'replication envelope');
  assertNoTransportFields(envelope, '$');
  assertPayloadHash(envelope);
  assertSequence(envelope.sequence);
  assertUuid(envelope.workspace_uuid, 'workspace_uuid');
  assertTimestamp(envelope.recorded_at, 'recorded_at');
  const payload = object(envelope.payload, 'payload');
  switch (envelope.kind) {
    case 'ENTRY_HEAD':
      assertEntry(payload.entry);
      if (payload.entry_head_uuid !== payload.entry.entry_uuid) fail('entry head identity mismatch');
      break;
    case 'ENTRY_CONFLICT':
      assertEntry(payload.current_entry);
      assertEntry(payload.candidate_entry);
      assertInteger(payload.base_version, 1, MAX_SAFE_INTEGER, 'conflict base_version must be positive');
      assertInteger(payload.current_version, 1, MAX_SAFE_INTEGER, 'conflict current_version must be positive');
      if (payload.current_entry.entry_uuid !== payload.entry_head_uuid ||
          payload.candidate_entry.entry_uuid !== payload.entry_head_uuid) fail('entry conflict identity mismatch');
      if (payload.current_entry.sync_version !== payload.current_version) fail('current conflict version mismatch');
      if (payload.candidate_entry.sync_version !== payload.base_version + 1) fail('candidate conflict version mismatch');
      if (payload.current_version <= payload.base_version) fail('conflict current_version must exceed base_version');
      break;
    case 'PLOT_SNAPSHOT':
      assertInteger(payload.projection_version, 1, MAX_SAFE_INTEGER, 'plot projection_version must be positive');
      assertPlot(payload.plot, {
        plot_uuid: payload.plot.plot_uuid,
        gateway_device_eui: payload.gateway_device_eui,
        projection_version: payload.projection_version,
      });
      break;
    case 'REFERENCE_DATA':
      if (payload.product) assertProduct(payload.product);
      else if (payload.custom_vocab) assertCustomVocabulary(payload.custom_vocab);
      else fail('reference payload must contain product or custom_vocab');
      break;
    case 'CROP_CYCLE_PROJECTION':
      assertCropCycle(payload);
      break;
    case 'ATTACHMENT_DESCRIPTOR':
      assertInteger(payload.size_bytes, 0, MAX_SAFE_INTEGER, 'attachment size_bytes must be nonnegative');
      assertInteger(payload.sync_version, 0, MAX_SAFE_INTEGER, 'attachment sync_version must be nonnegative');
      break;
    case 'AUTHORITY_STATE':
      break;
    default:
      fail('unknown replication kind');
  }
  return true;
}

function validateReplicationBatch(envelopes) {
  if (!Array.isArray(envelopes)) fail('replication batch must be an array');
  let previous = null;
  let workspace = null;
  for (const envelope of envelopes) {
    validateReplication(envelope);
    if (workspace !== null && workspace !== envelope.workspace_uuid) fail('replication batch must contain one workspace');
    workspace = envelope.workspace_uuid;
    const sequence = BigInt(envelope.sequence);
    if (previous !== null && sequence <= previous) fail('replication sequences must be numerically ascending');
    previous = sequence;
  }
  return true;
}

function mutationHash(envelope) {
  const { payload_sha256, ...hashInput } = envelope;
  return sha256(hashInput);
}

function replicationHash(envelope) {
  return sha256(envelope.payload);
}

function validateMutation(envelope) {
  validateMutationStructure(envelope);
  assertDeclaredHash(envelope, mutationHash(envelope));
  return true;
}

function validateReplication(envelope) {
  validateReplicationStructure(envelope);
  assertDeclaredHash(envelope, replicationHash(envelope));
  return true;
}

function hashMutation(envelope) {
  validateMutationStructure(envelope);
  return mutationHash(envelope);
}

function hashReplication(envelope) {
  validateReplicationStructure(envelope);
  return replicationHash(envelope);
}

module.exports = {
  canonicalize,
  sha256,
  validateMutation,
  validateReplication,
  validateReplicationBatch,
  hashMutation,
  hashReplication,
};
