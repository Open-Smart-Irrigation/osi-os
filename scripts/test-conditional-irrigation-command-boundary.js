#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('usage: node scripts/test-conditional-irrigation-command-boundary.js <pending-boundary.json>');
  process.exit(2);
}

const root = path.join(__dirname, '..');
const schema = JSON.parse(fs.readFileSync(path.join(root, 'docs/contracts/sync-schema/conditional-irrigation-v1.schema.json'), 'utf8'));
const commands = JSON.parse(fs.readFileSync(path.join(root, 'docs/contracts/sync-schema/commands.schema.json'), 'utf8'));
const resources = JSON.parse(fs.readFileSync(path.join(root, 'docs/contracts/sync-schema/resources.schema.json'), 'utf8'));
let Ajv;
let addFormats;
try {
  Ajv = require('ajv');
  addFormats = require('ajv-formats');
} catch (error) {
  console.error(`service-boundary AJV is required; run npm ci --ignore-scripts --prefix scripts: ${error.message}`);
  process.exit(2);
}

const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(resources, resources.$id || 'resources.schema.json');
ajv.addSchema(schema, schema.$id);
ajv.addSchema(schema, 'https://contracts.opensmartirrigation.org/sync-schema/conditional-irrigation-v1.schema.json');
const commandCheck = ajv.compile(commands);
const boundary = JSON.parse(fs.readFileSync(path.resolve(inputPath), 'utf8'));
assert.ok(Array.isArray(boundary.commands), 'production boundary must contain commands');

// CommandService adds these transport-only values to the persisted payload. The
// pending-command response carries their authoritative equivalents as sibling
// fields; the edge flattening step does the same projection before dispatch.
const transportOnly = new Set(['effect_key', 'commandType', 'command_type']);
function canonicalEnvelope(entry) {
  const pending = entry && entry.pending;
  assert.ok(pending && typeof pending === 'object', 'pending response is required');
  assert.equal(typeof pending.eventUuid, 'string', 'pending eventUuid is required');
  assert.equal(typeof pending.commandType, 'string', 'pending commandType is required');
  assert.equal(typeof pending.createdAt, 'string', 'pending createdAt is required');
  assert.ok(pending.payload && typeof pending.payload === 'object' && !Array.isArray(pending.payload),
    'pending payload must be an object');
  assert.equal(typeof entry.actor_user_uuid, 'string', 'persisted command actor is required');

  const payload = { ...pending.payload };
  for (const key of transportOnly) delete payload[key];
  assert.equal(payload.command_id, undefined, 'service payload must not invent a second command id');
  const requestedAt = new Date(pending.createdAt);
  assert.equal(Number.isNaN(requestedAt.getTime()), false, 'pending createdAt must be an ISO timestamp');
  return {
    ...payload,
    command_id: pending.eventUuid,
    command_type: pending.commandType,
    actor_user_uuid: entry.actor_user_uuid,
    // Java Instant may carry nanoseconds in the pending response; the canonical
    // UTC command wire is millisecond precision after JSON boundary encoding.
    requested_at: requestedAt.toISOString()
  };
}

const expectedTypes = [
  'UPSERT_IRRIGATION_POLICY',
  'UPSERT_IRRIGATION_POLICY',
  'UPSERT_IRRIGATION_POLICY',
  'PAUSE_IRRIGATION_POLICY',
  'RETRY_IRRIGATION_VALVE'
];
assert.deepEqual(boundary.commands.map(entry => entry.pending && entry.pending.commandType), expectedTypes,
  'production lifecycle must cover create, full update, partial update, pause and retry');

const envelopes = boundary.commands.map(canonicalEnvelope);
for (const [index, envelope] of envelopes.entries()) {
  assert.equal(commandCheck(envelope), true,
    `persisted pending command ${index} (${envelope.command_type}) is not AJV-valid: ${JSON.stringify(commandCheck.errors)}`);
}

const create = envelopes[0];
const fullUpdate = envelopes[1];
const partialUpdate = envelopes[2];
assert.equal(create.expected_policy_version, null, 'production create keeps null policy version');
assert.equal(create.schedules[0].expected_sync_version, null, 'production schedule create keeps null version');
assert.equal(fullUpdate.expected_policy_version, 1, 'production full update carries policy base version');
assert.equal(fullUpdate.schedules[0].expected_sync_version, 1, 'production full update carries schedule base version');
assert.deepEqual(Object.keys(partialUpdate.schedules[0]).sort(),
  ['duration_minutes', 'expected_sync_version', 'schedule_uuid'].sort(),
  'production partial schedule edit remains sparse at the wire boundary');
assert.equal(partialUpdate.expected_policy_version, 2, 'production partial update carries policy base version');
assert.equal(partialUpdate.schedules[0].expected_sync_version, 2, 'production partial update carries schedule base version');

console.log(`test-conditional-irrigation-command-boundary: OK (${envelopes.length} persisted pending commands through production boundary and AJV)`);
