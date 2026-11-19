#!/usr/bin/env node
'use strict';

// K3 fixture validation only. Scenario vectors are consumer acceptance inputs;
// validating their shape does not claim their future implementations pass.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--fixtures-dir'),
  'usage: node scripts/verify-valve-command-fixtures.js [--fixtures-dir <contract-directory>]');
const directory = args.length ? path.resolve(args[1]) : path.join(root, 'docs/contracts/valve-command');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const manifest = read(path.join(directory, 'MANIFEST.json'));
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);

const object = { type: 'object', minProperties: 1 };
const validateSuite = ajv.compile({
  type: 'object', additionalProperties: false,
  required: ['contract_version', 'suite', 'consumers', 'cases'],
  properties: {
    contract_version: { const: 1 }, suite: { type: 'string', minLength: 1 },
    consumers: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', minLength: 1 } },
    cases: {
      type: 'array', minItems: 1, items: {
        type: 'object', additionalProperties: false,
        required: ['id', 'basis', 'check', 'input', 'expected'],
        properties: {
          id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]+$' },
          basis: { enum: ['baseline', 'requirement', 'proposed'] },
          check: { enum: ['scenario', 'policy_evaluate', 'deadline', 'cancel_http', 'uc512_codec', 'occurrences', 'command_schema'] },
          input: { type: 'object' }, expected: object,
          decision: { enum: manifest.decisions },
        },
        allOf: [
          { if: { properties: { basis: { const: 'proposed' } } }, then: { required: ['decision'] } },
          { if: { properties: { check: { const: 'scenario' } } }, then: {
            properties: { input: { required: ['context', 'events'], additionalProperties: false, properties: {
              context: { type: 'object' }, events: { type: 'array', minItems: 1, items: {
                type: 'object', required: ['type'], properties: { type: { type: 'string', minLength: 1 } },
              } },
            } } },
          } },
        ],
      },
    },
  },
});

const syncDir = path.join(root, 'docs/contracts/sync-schema');
const resources = read(path.join(syncDir, 'resources.schema.json'));
const policySchema = read(path.join(syncDir, 'conditional-irrigation-v1.schema.json'));
ajv.addSchema(resources, resources.$id);
ajv.addSchema(policySchema, policySchema.$id);
ajv.addSchema(policySchema, 'https://contracts.opensmartirrigation.org/sync-schema/conditional-irrigation-v1.schema.json');
const validateCommand = ajv.compile(read(path.join(syncDir, 'commands.schema.json')));

const modules = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const { evaluateCondition } = require(path.join(modules, 'osi-irrigation-policy/evaluate'));
const { occurrencesBetween } = require(path.join(modules, 'osi-irrigation-policy/occurrences'));
const { confirmationDeadline } = require(path.join(modules, 'osi-valve-control/workers'));
const { cancelHttpResponse } = require(path.join(modules, 'osi-valve-control/cancel'));
const { encodeValveTask } = require(path.join(modules, 'codecs/milesight_uc512_decoder'));

// Omitted properties are unconstrained. Explicit null and array length/order
// are assertions, so a consumer cannot drop collateral or invent observations.
function assertProjection(actual, expected, label) {
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), label + ' must be an array');
    assert.equal(actual.length, expected.length, label + ' length');
    expected.forEach((value, i) => assertProjection(actual[i], value, `${label}[${i}]`));
  } else if (expected !== null && typeof expected === 'object') {
    assert.ok(actual !== null && typeof actual === 'object', label + ' must be an object');
    for (const [key, value] of Object.entries(expected)) {
      assert.ok(Object.hasOwn(actual, key), label + '.' + key + ' is missing');
      assertProjection(actual[key], value, label + '.' + key);
    }
  } else assert.deepEqual(actual, expected, label);
}

function runBaseline(c) {
  const i = c.input;
  switch (c.check) {
    case 'policy_evaluate': return evaluateCondition(i.condition, i.evidence, i.dueAt, i.windowMinutes);
    case 'deadline': return confirmationDeadline(i);
    case 'cancel_http': return cancelHttpResponse(i.result, i.deveui);
    case 'occurrences': return { due_at: occurrencesBetween(i.schedule, i.from, i.to).map((row) => row.dueAt) };
    case 'command_schema': return { schema_valid: Boolean(validateCommand(i.envelope)) };
    case 'uc512_codec': {
      if (c.expected.error_pattern) {
        assert.throws(() => encodeValveTask(i), new RegExp(c.expected.error_pattern), c.id);
        return c.expected;
      }
      return { bytes: encodeValveTask(i) };
    }
    default: throw new Error('no executable adapter for ' + c.check);
  }
}

const observationStates = new Set(['unobserved', 'observed_running', 'observed_complete',
  'observed_closed', 'stale_no_observation', 'stale_open_observed']);
function validateSemantics(c) {
  const e = c.expected;
  if (e.observation !== undefined) assert.ok(observationStates.has(e.observation), c.id + ': invalid observation');
  if (e.admission === 'refused' && e.new_physical_enqueues !== undefined) {
    assert.equal(e.new_physical_enqueues, 0, c.id + ': refusal cannot enqueue');
  }
  if (['handed_off', 'uncertain', 'already_running'].includes(e.cancel_outcome)) {
    assert.notEqual(e.physically_closed, true, c.id + ': cancel cannot prove closure');
  }
  if (c.basis === 'proposed') assert.ok(c.decision, c.id + ': proposed interface needs a decision');
}

assert.equal(manifest.contract, 'valve-command/v1');
assert.equal(manifest.status, 'draft_edge_lead_signoff_required');
assert.equal(manifest.physical_qualification, false, 'fixtures cannot qualify production activation');
assert.deepEqual(manifest.decisions, ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']);
assert.equal(manifest.fixtures.length, 6);
assert.equal(new Set(manifest.fixtures.map((entry) => entry.path)).size, manifest.fixtures.length);
assert.deepEqual(fs.readdirSync(path.join(directory, 'fixtures')).sort(),
  manifest.fixtures.map((entry) => path.basename(entry.path)).sort(), 'manifest must list every fixture');

const ids = new Set();
let executed = 0;
let scenarios = 0;
const suites = [];
for (const entry of manifest.fixtures) {
  assert.match(entry.path, /^fixtures\/[a-z-]+\.json$/);
  const suite = read(path.join(directory, entry.path));
  assert.equal(validateSuite(suite), true, entry.path + ': ' + JSON.stringify(validateSuite.errors));
  assert.equal(entry.path, `fixtures/${suite.suite}.json`);
  assert.equal(suite.cases.length, entry.cases, entry.path + ': stale manifest count');
  assert.deepEqual(suite.consumers, entry.consumers, entry.path + ': consumers disagree');
  for (const c of suite.cases) {
    const id = suite.suite + '/' + c.id;
    assert.ok(!ids.has(id), 'duplicate fixture ' + id);
    ids.add(id);
    validateSemantics(c);
    if (c.check === 'scenario') scenarios += 1;
    else {
      assert.equal(c.basis, 'baseline', id + ': executable checks must describe baseline behavior');
      assertProjection(runBaseline(c), c.expected, id);
      executed += 1;
    }
  }
  suites.push(suite);
}

// Negative controls prove the checker catches damaged fixtures and an incorrect
// expected result, rather than accepting anything parseable as JSON.
const damagedShape = structuredClone(suites[0]);
delete damagedShape.cases[0].expected;
assert.equal(validateSuite(damagedShape), false, 'missing expected must be rejected');
const damagedDecision = structuredClone(suites[0]);
damagedDecision.cases[0].basis = 'proposed';
delete damagedDecision.cases[0].decision;
assert.equal(validateSuite(damagedDecision), false, 'unapproved interface needs a decision');
assert.throws(() => validateSemantics({ id: 'bad', expected: { observation: 'delivered' } }), /invalid observation/);
assert.throws(() => validateSemantics({ id: 'bad', expected: { admission: 'refused', new_physical_enqueues: 1 } }), /refusal cannot enqueue/);
assert.throws(() => assertProjection({ collateral: [] }, { collateral: [{ owner_id: 'other' }] }, 'negative'), /length/);
const swt = suites.find((s) => s.suite === 'policy').cases.find((c) => c.id === 'swt-equality-waters');
assert.throws(() => assertProjection(runBaseline(swt), { ...swt.expected, value: 31 }, 'negative'), /negative.value/);

console.log(`verify-valve-command-fixtures: OK (${ids.size} cases; ${executed} baseline vectors executed; ${scenarios} consumer scenarios validated; 6 negative controls)`);
