#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '..', 'docs/contracts/sync-schema/conditional-irrigation-v1.schema.json');
const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
const commands = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs/contracts/sync-schema/commands.schema.json'), 'utf8'));
const resources = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'docs/contracts/sync-schema/resources.schema.json'), 'utf8'));
let Ajv, addFormats;
try {
  Ajv = require('ajv');
  addFormats = require('ajv-formats');
} catch (error) {
  console.error(`test-conditional-irrigation-contract: AJV is required; run npm ci --prefix scripts (or set NODE_PATH). ${error.message}`);
  process.exit(2);
}
const ajv = new Ajv({strict: false, allErrors: true});
addFormats(ajv);
ajv.addSchema(resources, resources.$id || 'resources.schema.json');
ajv.addSchema(schema, schema.$id);
// commands.schema.json uses its own contracts host for relative refs; register the
// same immutable schema under that URI so the vendor copy is validated exactly.
ajv.addSchema(schema, 'https://contracts.opensmartirrigation.org/sync-schema/conditional-irrigation-v1.schema.json');
const commandCheck = ajv.compile(commands);
assert.equal(schema.$schema, 'http://json-schema.org/draft-07/schema#');
for (const name of ['Policy','Schedule','Runtime','LastResult','ValveRuntime','Decision','Condition','DeliverySettings','Evidence']) assert.ok(schema.definitions[name], `missing definition ${name}`);

const fixtures = schema['x-golden-fixtures'];
assert.equal(fixtures.condition_kpa_29_9.threshold_kpa, 29.9);
assert.equal(fixtures.condition_vwc_zero.threshold_percent, 0);
assert.equal(fixtures.condition_dendro_local.minimum_stress, 'moderate');
assert.equal(fixtures.runtime_last_result_skipped.decision_reason, 'clock_untrusted');
const conditionCheck = ajv.compile({$ref: schema.$id + '#/definitions/Condition'});
const policyCheck = ajv.compile({$ref: schema.$id + '#/definitions/Policy'});
const runtimeCheck = ajv.compile({$ref: schema.$id + '#/definitions/Runtime'});
const valveRuntimeCheck = ajv.compile({$ref: schema.$id + '#/definitions/ValveRuntime'});
const decisionCheck = ajv.compile({$ref: schema.$id + '#/definitions/Decision'});
const lastResultCheck = ajv.compile({$ref: schema.$id + '#/definitions/LastResult'});
const evidenceCheck = ajv.compile({$ref: schema.$id + '#/definitions/Evidence'});
for (const [name, check, value] of [
  ['condition_kpa_29_9', conditionCheck, fixtures.condition_kpa_29_9],
  ['condition_vwc_zero', conditionCheck, fixtures.condition_vwc_zero],
  ['condition_dendro_local', conditionCheck, fixtures.condition_dendro_local],
  ['runtime_last_result_skipped', lastResultCheck, fixtures.runtime_last_result_skipped],
  ['evidence_skipped', evidenceCheck, fixtures.evidence_skipped],
  ['runtime_full', runtimeCheck, fixtures.runtime_full],
  ['valve_runtime_full', valveRuntimeCheck, fixtures.valve_runtime_full],
  ['decision_full', decisionCheck, fixtures.decision_full],
  ['tombstone', policyCheck, fixtures.tombstone],
  ['policy_wire_enabled_one', policyCheck, fixtures.policy_wire_enabled_one]
]) assert.equal(check(value), true, name + ': AJV ' + JSON.stringify(check.errors));
const rawCondition = {...fixtures.condition_kpa_29_9, sources:[{...fixtures.condition_kpa_29_9.sources[0], raw_transport:{queue_id:'secret'}}]};
assert.equal(conditionCheck(rawCondition), false, 'nested raw condition fields must be rejected');
const rawSource = {...fixtures.condition_kpa_29_9, sources:[{device_eui:'A840410000000001',channel:'swt_1',raw_field:true}]};
assert.equal(conditionCheck(rawSource), false, 'raw source fields must be rejected');
function canonical(value, context = []) {
  if (Array.isArray(value)) { const normalized=value.map(e=>canonical(e,context)); const setOrder=context.some(k=>['sources','eligible_sources','SWT','VWC','DENDRO'].includes(k)); return setOrder ? normalized.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))) : normalized; }
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k],[...context,k])]));
  return value;
}
const first={condition:fixtures.condition_kpa_29_9,source_choices:{SWT:[{device_eui:'A840410000000001',channel:'swt_1'}]},rows:[{id:1},{id:2}]};
const second={source_choices:{SWT:[{device_eui:'A840410000000001',channel:'swt_1'}]},condition:{...fixtures.condition_kpa_29_9,sources:[...fixtures.condition_kpa_29_9.sources].reverse()},rows:[{id:1},{id:2}]};
assert.deepEqual(canonical(first),canonical(second));
assert.notDeepEqual(canonical({rows:[{id:'A'},{id:'B'}]}),canonical({rows:[{id:'B'},{id:'A'}]}));
for (const [name, definition] of [['runtime_full','Runtime'],['valve_runtime_full','ValveRuntime'],['decision_full','Decision'],['evidence_skipped','Evidence'],['condition_kpa_29_9','Condition']]) {
  const check = ajv.compile({$ref: `${schema.$id}#/definitions/${definition}`});
  assert.equal(check(fixtures[name]), true, `${name}: AJV ${JSON.stringify(check.errors)}`);
}
const runtimeValidationCases = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'docs/contracts/sync-schema/conditional-irrigation-runtime-validation-cases.json'),
  'utf8'
)).cases;
function applyFixturePatches(value, patches = []) {
  const result = structuredClone(value);
  for (const patch of patches) {
    let target = result;
    for (const segment of patch.path.slice(0, -1)) target = target[segment];
    target[patch.path.at(-1)] = structuredClone(patch.value);
  }
  return result;
}
for (const candidate of runtimeValidationCases) {
  const check = ajv.compile({$ref: `${schema.$id}#/definitions/${candidate.definition}`});
  const value = applyFixturePatches(fixtures[candidate.fixture], candidate.patches);
  assert.equal(Boolean(check(value)), candidate.expected,
    `${candidate.name}: AJV ${JSON.stringify(check.errors)}`);
}
const commandBase = {
  command_id: '12345678-1234-4234-8234-123456789abc',
  policy_uuid: '22345678-1234-4234-8234-123456789abc',
  zone_uuid: '32345678-1234-4234-8234-123456789abc',
  gateway_device_eui: 'A840410000000001', actor_user_uuid: '42345678-1234-4234-8234-123456789abc',
  requested_at: '2026-10-20T00:00:00.000Z', request_id: '52345678-1234-4234-8234-123456789abc'
};
const envelopes = [
  {...commandBase, command_type: 'UPSERT_IRRIGATION_POLICY', expected_policy_version: null,
    condition: fixtures.condition_kpa_29_9, timezone: 'UTC', enabled: true, observation_window_minutes: 60,
    min_interval_minutes: 15, max_daily_minutes: 120, delivery_settings: {}, schedules: [{
      schedule_uuid: '62345678-1234-4234-8234-123456789abc', device_eui: 'A840410000000002', kind: 'WEEKLY',
      weekdays_mask: 127, start_time: '06:00', duration_minutes: 30, enabled: true, detach: false, execution: 'conditional', expected_sync_version: null
    }]},
  {...commandBase, command_type: 'PAUSE_IRRIGATION_POLICY', expected_policy_version: 1},
  {...commandBase, command_type: 'RETRY_IRRIGATION_VALVE', device_eui: 'A840410000000002'}
];
for (const envelope of envelopes) assert.equal(commandCheck(envelope), true, `command ${envelope.command_type}: ${JSON.stringify(commandCheck.errors)}`);
const partial = {...commandBase, command_type: 'UPSERT_IRRIGATION_POLICY', expected_policy_version: 2, policy_uuid: commandBase.policy_uuid, schedules: [{schedule_uuid: '62345678-1234-4234-8234-123456789abc', expected_sync_version: 4, duration_minutes: 30}]};
assert.equal(commandCheck(partial), true, 'partial existing policy/schedule edit must validate');
const fullUpdate = {...commandBase, command_type: 'UPSERT_IRRIGATION_POLICY', expected_policy_version: 2,
  policy_uuid: commandBase.policy_uuid, schedules: [fixtures.schedule_full_update]};
assert.equal(commandCheck(fullUpdate), true, 'full existing schedule edit must validate');
const createWithoutExpectedVersion = structuredClone(envelopes[0]);
delete createWithoutExpectedVersion.schedules[0].expected_sync_version;
assert.equal(commandCheck(createWithoutExpectedVersion), false, 'schedule creation must carry an explicit null expected version');
const sparseNullUpdate = structuredClone(fullUpdate);
sparseNullUpdate.schedules[0] = {
  schedule_uuid: fullUpdate.schedules[0].schedule_uuid,
  expected_sync_version: null,
  duration_minutes: 30
};
assert.equal(commandCheck(sparseNullUpdate), false,
  'a null schedule version is a create marker and still requires complete schedule fields');
const nullVersionPause = {...commandBase, command_type: 'PAUSE_IRRIGATION_POLICY', expected_policy_version: null};
assert.equal(commandCheck(nullVersionPause), true,
  `a stop-path PAUSE may carry a null policy version (pause the current version): ${JSON.stringify(commandCheck.errors)}`);
const pauseWithoutVersion = {...commandBase, command_type: 'PAUSE_IRRIGATION_POLICY'};
assert.equal(commandCheck(pauseWithoutVersion), false, 'PAUSE still requires an explicit expected_policy_version (integer or null)');
assert.equal(commandCheck({...nullVersionPause, expected_policy_version: -1}), false, 'a negative PAUSE policy version is rejected');
assert.equal(commandCheck({...nullVersionPause, expected_policy_version: '1'}), false, 'a string PAUSE policy version is rejected');
const malformed = {...envelopes[0], request_id: 'not-a-uuid'};
assert.equal(commandCheck(malformed), false, 'malformed request_id must be rejected by AJV');
console.log('test-conditional-irrigation-contract: OK (Draft-07 AJV positive/negative typed resources and UPSERT/PAUSE/RETRY envelopes, canonical sets, tombstone, nested raw-field rejection)');
