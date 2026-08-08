#!/usr/bin/env node
'use strict';

// V2 acceptance is intentionally separate from the V1 event/command contract.
// This focused guard validates the closed V2 envelopes without widening V1.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/contracts/sync-schema/journal-v2.schema.json'), 'utf8'));
const canonicalizer = require(path.join(ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal-replication/canonicalization'));
const { contractValidationErrors, schemaStructureErrors } = require('./test-contract-schemas');

const UUID = '12345678-1234-4234-8234-123456789abc';
const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HASH = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const AT = '2026-08-08T10:11:12.123Z';

function keysExactly(value, expected) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function canonicalUuid(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

function canonicalTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value));
}

function validCandidate(candidate, mode) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
  if (mode === 'void') return keysExactly(candidate, ['deleted_at', 'void_reason']) &&
    canonicalTimestamp(candidate.deleted_at) && typeof candidate.void_reason === 'string' && candidate.void_reason.length > 0;
  return keysExactly(candidate, ['entry']) && candidate.entry && typeof candidate.entry === 'object' && !Array.isArray(candidate.entry);
}

function validateMutation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const common = ['mutation_uuid', 'workspace_uuid', 'operation', 'resource', 'candidate', 'payload_sha256', 'origin', 'recorded_at'];
  if (!keysExactly(value, common) || !canonicalUuid(value.mutation_uuid) || !canonicalUuid(value.workspace_uuid) ||
    !canonicalTimestamp(value.recorded_at) || !/^[0-9a-f]{64}$/.test(value.payload_sha256) ||
    !['cloud-ui', 'edge-ui', 'edge-worker'].includes(value.origin)) return false;
  const op = value.operation;
  if (!['ENTRY_CREATE', 'ENTRY_CORRECT', 'ENTRY_VOID', 'PRODUCT_UPSERT', 'CUSTOM_VOCAB_UPSERT', 'PLOT_SNAPSHOT', 'CUTOVER_BARRIER_RECEIPT'].includes(op)) return false;
  if (op === 'ENTRY_CREATE') return value.origin !== 'edge-worker' && keysExactly(value.resource, ['entry_uuid', 'base_version']) && canonicalUuid(value.resource.entry_uuid) && value.resource.base_version === 0 && validCandidate(value.candidate, 'entry');
  if (op === 'ENTRY_CORRECT') return value.origin !== 'edge-worker' && keysExactly(value.resource, ['entry_uuid', 'base_version']) && canonicalUuid(value.resource.entry_uuid) && Number.isInteger(value.resource.base_version) && value.resource.base_version > 0 && validCandidate(value.candidate, 'entry');
  if (op === 'ENTRY_VOID') return value.origin !== 'edge-worker' && keysExactly(value.resource, ['entry_uuid', 'base_version']) && canonicalUuid(value.resource.entry_uuid) && Number.isInteger(value.resource.base_version) && value.resource.base_version > 0 && validCandidate(value.candidate, 'void');
  if (op === 'PRODUCT_UPSERT') return keysExactly(value.resource, ['product_uuid', 'base_version']) && canonicalUuid(value.resource.product_uuid) && Number.isInteger(value.resource.base_version) && value.resource.base_version >= 0 && validCandidate(value.candidate, 'entry');
  if (op === 'CUSTOM_VOCAB_UPSERT') return keysExactly(value.resource, ['vocabulary_uuid', 'base_version']) && canonicalUuid(value.resource.vocabulary_uuid) && Number.isInteger(value.resource.base_version) && value.resource.base_version >= 0 && validCandidate(value.candidate, 'entry');
  return value.origin === 'edge-worker' && keysExactly(value.resource, ['gateway_device_eui', 'base_version']) && /^[0-9A-F]{16}$/.test(value.resource.gateway_device_eui) && value.resource.base_version === 0 && validCandidate(value.candidate, 'entry');
}

function schemaValid(value) {
  return schemaStructureErrors(schema).length === 0 && contractValidationErrors(schema, value, schema).length === 0;
}

function validateReplication(value) {
  return keysExactly(value, ['sequence', 'workspace_uuid', 'kind', 'payload', 'payload_sha256', 'recorded_at']) &&
    /^(0|[1-9][0-9]*)$/.test(value.sequence) && canonicalUuid(value.workspace_uuid) &&
    ['ENTRY_HEAD', 'ENTRY_CONFLICT', 'PLOT_SNAPSHOT', 'REFERENCE_DATA', 'CROP_CYCLE_PROJECTION', 'ATTACHMENT_DESCRIPTOR', 'AUTHORITY_STATE'].includes(value.kind) &&
    value.payload && typeof value.payload === 'object' && !Array.isArray(value.payload) &&
    /^[0-9a-f]{64}$/.test(value.payload_sha256) && canonicalTimestamp(value.recorded_at) &&
    (value.kind !== 'ATTACHMENT_DESCRIPTOR' || (!('blob' in value.payload) && !('url' in value.payload) && !('object_store_url' in value.payload)));
}

function mutation(operation, resource, candidate, origin = 'cloud-ui') {
  const value = { mutation_uuid: UUID, workspace_uuid: WORKSPACE, operation, resource, candidate, origin, recorded_at: AT };
  return { ...value, payload_sha256: canonicalizer.hashMutation(value) };
}

const entry = { entry: { entry_uuid: UUID, note: 'irrigation completed' } };
const fixtures = [
  mutation('ENTRY_CREATE', { entry_uuid: UUID, base_version: 0 }, entry),
  mutation('ENTRY_CORRECT', { entry_uuid: UUID, base_version: 1 }, entry),
  mutation('ENTRY_VOID', { entry_uuid: UUID, base_version: 1 }, { deleted_at: AT, void_reason: 'duplicate' }),
  mutation('PRODUCT_UPSERT', { product_uuid: UUID, base_version: 0 }, entry),
  mutation('CUSTOM_VOCAB_UPSERT', { vocabulary_uuid: UUID, base_version: 0 }, entry),
  mutation('PLOT_SNAPSHOT', { gateway_device_eui: '0016C001F11715E2', base_version: 0 }, entry, 'edge-worker'),
  mutation('CUTOVER_BARRIER_RECEIPT', { gateway_device_eui: '0016C001F11715E2', base_version: 0 }, entry, 'edge-worker'),
];

for (const fixture of fixtures) {
  assert.ok(validateMutation(fixture), `${fixture.operation} must validate`);
  assert.ok(schemaValid(fixture), `${fixture.operation} must validate against journal-v2.schema.json`);
  assert.equal(canonicalizer.hashMutation(fixture), fixture.payload_sha256, `${fixture.operation} hash must use the canonicalizer`);
}

const conflictReplication = { sequence: '42', workspace_uuid: WORKSPACE, kind: 'ENTRY_CONFLICT', payload: { entry_uuid: UUID, reason: 'base-version-mismatch' }, payload_sha256: HASH, recorded_at: AT };
const attachmentReplication = { sequence: '43', workspace_uuid: WORKSPACE, kind: 'ATTACHMENT_DESCRIPTOR', payload: { attachment_uuid: UUID, sha256: HASH, byte_length: 12, media_type: 'image/jpeg' }, payload_sha256: HASH, recorded_at: AT };
assert.ok(validateReplication(conflictReplication));
assert.ok(schemaValid(conflictReplication), 'conflict replication must validate against journal-v2.schema.json');
assert.ok(validateReplication(attachmentReplication));
assert.ok(schemaValid(attachmentReplication), 'attachment descriptor must validate against journal-v2.schema.json');

const invalid = (fixture, message) => {
  assert.equal(validateMutation(fixture), false, message);
  assert.notEqual(contractValidationErrors(schema, fixture, schema).length, 0, `${message} against journal-v2.schema.json`);
};
invalid({ ...fixtures[0], mutation_uuid: 'not-a-uuid' }, 'non-UUID mutation id must reject');
invalid(mutation('PRODUCT_UPSERT', { entry_uuid: UUID, base_version: 0 }, entry), 'entry UUID on product mutation must reject');
invalid(mutation('ENTRY_CREATE', { entry_uuid: UUID, base_version: 1 }, entry), 'create with nonzero base must reject');
invalid(mutation('ENTRY_CORRECT', { entry_uuid: UUID, base_version: 0 }, entry), 'correction with zero base must reject');
invalid(mutation('ENTRY_VOID', { entry_uuid: UUID, base_version: 0 }, { deleted_at: AT, void_reason: 'duplicate' }), 'void with zero base must reject');
invalid(mutation('UNKNOWN', { entry_uuid: UUID, base_version: 0 }, entry), 'unknown operation must reject');
invalid({ ...fixtures[0], payload_sha256: 'abcd' }, 'wrong payload hash length must reject');
const blobAttachment = { sequence: '44', workspace_uuid: WORKSPACE, kind: 'ATTACHMENT_DESCRIPTOR', payload: { attachment_uuid: UUID, url: 's3://private/blob' }, payload_sha256: HASH, recorded_at: AT };
assert.equal(validateReplication(blobAttachment), false, 'attachment blob URL must reject');
assert.notEqual(contractValidationErrors(schema, blobAttachment, schema).length, 0, 'attachment blob URL must reject against journal-v2.schema.json');

const v1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/contracts/sync-schema/events.schema.json'), 'utf8'));
assert.equal(v1.properties.op.enum.includes('ENTRY_CREATE'), false, 'V1 event operations must not accept V2 mutations');
assert.notEqual(contractValidationErrors(v1, fixtures[0], v1).length, 0, 'V1 event envelope must reject a V2 mutation');
assert.equal(schema.title, 'Field Journal V2 Replication Contract', 'schema identity must be stable');
console.log('PASS: journal v2 contract checks pass');
