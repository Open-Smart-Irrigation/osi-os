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
          check: { enum: ['scenario', 'policy_evaluate', 'deadline', 'cancel_http', 'uc512_codec', 'occurrences', 'command_schema', 'fixed_schedule', 'conditional_schedule_schema', 'once_tick', 'intent_states'] },
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
const validateConditionalSchedule = ajv.compile({ $ref: policySchema.$id + '#/definitions/ScheduleEdit' });

const modules = path.join(root, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const { evaluateCondition } = require(path.join(modules, 'osi-irrigation-policy/evaluate'));
const { occurrencesBetween } = require(path.join(modules, 'osi-irrigation-policy/occurrences'));
const { confirmationDeadline, runOnceTick } = require(path.join(modules, 'osi-valve-control/workers'));
const { validateScheduleInput } = require(path.join(modules, 'osi-valve-control/plan'));
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

async function runBaseline(c) {
  const i = c.input;
  switch (c.check) {
    case 'policy_evaluate': return evaluateCondition(i.condition, i.evidence, i.dueAt, i.windowMinutes);
    case 'deadline': return confirmationDeadline(i);
    case 'cancel_http': return cancelHttpResponse(i.result, i.deveui);
    case 'occurrences': return { due_at: occurrencesBetween(i.schedule, i.from, i.to).map((row) => row.dueAt) };
    case 'command_schema': return { schema_valid: Boolean(validateCommand(i.envelope)) };
    case 'conditional_schedule_schema': return { schema_valid: Boolean(validateConditionalSchedule(i)) };
    case 'fixed_schedule': return validateScheduleInput(i);
    case 'intent_states': {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(':memory:');
      try {
        db.exec(fs.readFileSync(path.join(root, 'database/migrations/ordered/0057__valve_once_dispatch_intents.sql'), 'utf8'));
        const accepted = [];
        const rejected = [];
        for (const state of i.states) {
          try {
            db.prepare('INSERT INTO valve_once_dispatch_intents(schedule_uuid,device_eui,command_id,state) VALUES (?,?,?,?)')
              .run('schedule-' + state, '0016C001F1000001', 'command-' + state, state);
            accepted.push(state);
          } catch (error) {
            assert.match(error.message, /CHECK constraint failed/, c.id + ': unexpected database error');
            rejected.push(state);
          }
        }
        return { accepted, rejected };
      } finally { db.close(); }
    }
    case 'once_tick': {
      // Execute the production worker with the repo's fixture-owned seed copy.
      // The result comes from stored rows, rather than a second grace algorithm.
      const { tempDb, FIXTURE_EUI } = require(path.join(modules, 'osi-valve-control/test-helpers'));
      const store = require(path.join(modules, 'osi-valve-control/store'));
      const f = await tempDb();
      try {
        const uuid = 'k3-' + c.id;
        await store.insertSchedule(f.db, { schedule_uuid: uuid, device_eui: FIXTURE_EUI,
          kind: 'ONCE', fire_at: i.fire_at, duration_minutes: 2, timezone: 'UTC', enabled: 1 });
        const now = Date.parse(i.fire_at) + i.elapsed_ms;
        assert.ok(['accepted', 'lost_reply'].includes(i.enqueue_outcome), c.id + ': explicit transport result required');
        let calls = 0;
        const result = await runOnceTick({ db: f.db, now: new Date(now),
          enqueueNow: () => now, queueReadNow: () => now, trustedContext: { runtimeNow: () => now }, warn() {},
          transport: {
            async getDeviceQueue() { return []; },
            async enqueueDownlink() {
              calls += 1;
              if (i.enqueue_outcome === 'lost_reply') throw new Error('fixture lost reply');
              return { id: 'k3-queue-1' };
            },
          },
        });
        const row = await f.db.get('SELECT s.once_state, i.state AS intent_state FROM valve_schedules s JOIN valve_once_dispatch_intents i ON i.schedule_uuid=s.schedule_uuid WHERE s.schedule_uuid=?', [uuid]);
        return { ...row, schedule_settlement: row.once_state === 'FIRED' ? 'fired' : row.once_state === 'SKIPPED' ? 'missed' : 'pending',
          new_physical_enqueues: calls, fired_results: result.fired.length, transport_failures: result.transportFailures.length };
      } finally { f.cleanup(); }
    }
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
// K1 R1 (K3 S7): after the requester loses the zone grant (a demotion to viewer
// counts, CTO 23 Nov), is disabled or is deleted, only a command accepted before that point may continue, and only as
// a stop (pause, cancel, or confirmed CLOSE-only override). It never opens,
// stays with the original actor, notes the revocation, is ACKed and shown as
// applied, and proves no physical closure. Everything else after revocation is
// refused with no enqueue.
const revocationNotes = {
  revoke_zone_grant: 'grant_lost', demote_to_viewer: 'demoted_to_viewer', disable_requester: 'disabled', delete_requester: 'deleted',
};
function isStopContinuation(context) {
  if (context.return_position === 'OPEN') return false;
  if (['PAUSE_IRRIGATION_POLICY', 'CANCEL_VALVE_ACTUATION'].includes(context.command_type)) return true;
  return context.command_type === 'CLOSE' && context.confirmed_override === true && context.effect === 'CLOSE_ONLY';
}
function validateRevocation(c) {
  const events = (c.input && c.input.events) || [];
  const revokeAt = events.findIndex((event) => revocationNotes[event.type]);
  if (revokeAt < 0) return;
  const e = c.expected;
  const context = c.input.context || {};
  const acceptedBefore = context.authorized_at_queue === true
    && events.slice(0, revokeAt).some((event) => event.type === 'cloud_accept');
  if (isStopContinuation(context) && acceptedBefore) {
    assert.equal(e.edge_admission, 'accepted', c.id + ': accepted stop must continue after revocation (R1)');
    assert.equal(e.open_enqueues, 0, c.id + ': stop continuation cannot open');
    assert.equal(e.attributed_actor, 'original_requester', c.id + ': stop stays with the original actor');
    assert.equal(e.revocation_noted, revocationNotes[events[revokeAt].type], c.id + ': revocation must be noted');
    assert.notEqual(e.physical_closed, true, c.id + ': a stop does not prove closure');
    assert.equal(e.ack, 'APPLIED', c.id + ': ACK must show the stop applied');
    assert.equal(e.after_both && e.after_both.ui, 'stop_applied', c.id + ': UI must show the stop applied');
    if (context.command_type === 'PAUSE_IRRIGATION_POLICY') {
      assert.equal(e.confirmed_enabled, false, c.id + ': a continued pause must leave the policy disabled');
    }
  } else {
    assert.equal(e.edge_admission, 'refused', c.id + ': only an accepted stop continues after revocation (R1)');
    assert.equal(e.physical_enqueues, 0, c.id + ': refusal after revocation cannot enqueue');
  }
}
function validateSemantics(c) {
  const e = c.expected;
  if (e.observation !== undefined) assert.ok(observationStates.has(e.observation), c.id + ': invalid observation');
  if (e.admission === 'refused' || e.edge_admission === 'refused') {
    for (const field of ['new_physical_enqueues', 'physical_enqueues', 'open_enqueues']) {
      if (e[field] !== undefined) assert.equal(e[field], 0, c.id + ': refusal cannot enqueue');
    }
  }
  validateRevocation(c);
  if (['handed_off', 'uncertain', 'already_running'].includes(e.cancel_outcome)) {
    assert.notEqual(e.physically_closed, true, c.id + ': cancel cannot prove closure');
  }
  if (c.basis === 'proposed') assert.ok(c.decision, c.id + ': proposed interface needs a decision');
  const context = c.input && c.input.context;
  const condition = context && (context.condition || (context.envelope && context.envelope.condition));
  if (condition && condition.kind === 'DENDRO' && condition.response_mode === 'proportional') {
    for (const field of ['dispatches', 'physical_enqueues']) {
      if (e[field] !== undefined) assert.equal(e[field], 0, c.id + ': proportional cannot water');
    }
    if (c.input.events.some((event) => ['cloud_activate', 'local_activation', 'resume', 'edge_apply'].includes(event.type))) {
      assert.ok(e.activation_allowed === false || e.admission === 'refused' || e.edge_admission === 'refused',
        c.id + ': proportional activation must be refused');
    }
  }
}

assert.equal(manifest.contract, 'valve-command/v1');
assert.equal(manifest.status, 'edge_lead_signed_with_exceptions');
assert.equal(manifest.signed_at, '2026-11-20');
assert.deepEqual(manifest.decision_status, {
  S1: 'signed', S2: 'signed', S3: 'deferred_to_1.1', S4: 'open_CL1', S5: 'signed',
  S6: 'CTO_ruled_fixed_only_0.9_1.0', S7: 'closed_by_K1_R1', S8: 'R8_decided_activation_receipts_open',
});
assert.equal(manifest.proportional_policy_field_count, null);
assert.equal(manifest.proportional_policy_field_count_status, 'unknown_pending_named_hosts');
assert.deepEqual(manifest.deferred_packages, ['EB21', 'GX2']);
assert.equal(manifest.physical_qualification, false, 'fixtures cannot qualify production activation');
assert.deepEqual(manifest.decisions, ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8']);
assert.equal(manifest.fixtures.length, 6);
assert.equal(new Set(manifest.fixtures.map((entry) => entry.path)).size, manifest.fixtures.length);
assert.deepEqual(fs.readdirSync(path.join(directory, 'fixtures')).sort(),
  manifest.fixtures.map((entry) => path.basename(entry.path)).sort(), 'manifest must list every fixture');

async function main() {
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
        assertProjection(await runBaseline(c), c.expected, id);
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
  // R1 negative controls: a timed close with an OPEN return accepted after
  // revocation, and a continued pause that opens, is credited to the zone owner
  // and claims proven closure, must both fail.
  const cloud = suites.find((s) => s.suite === 'cloud-activation');
  const timedClose = structuredClone(cloud.cases.find((c) => c.id === 'timed-close-with-open-return-after-revoke-refused'));
  Object.assign(timedClose.expected, { edge_admission: 'accepted', physical_enqueues: 1 });
  assert.throws(() => validateSemantics(timedClose), /R1|enqueue/);
  const pause = structuredClone(cloud.cases.find((c) => c.id === 'queued-pause-after-grant-loss-applies'));
  Object.assign(pause.expected, { open_enqueues: 1, attributed_actor: 'zone_owner', physical_closed: true });
  assert.throws(() => validateSemantics(pause), /cannot open|original actor|closure/);
  const reenabled = structuredClone(cloud.cases.find((c) => c.id === 'queued-pause-after-grant-loss-applies'));
  reenabled.expected.confirmed_enabled = true;
  assert.throws(() => validateSemantics(reenabled), /leave the policy disabled/);
  const swt = suites.find((s) => s.suite === 'policy').cases.find((c) => c.id === 'swt-equality-waters');
  const actualSwt = await runBaseline(swt);
  assert.throws(() => assertProjection(actualSwt, { ...swt.expected, value: 31 }, 'negative'), /negative.value/);

  console.log(`verify-valve-command-fixtures: OK (${ids.size} cases; ${executed} baseline vectors executed; ${scenarios} consumer scenarios validated; 9 negative controls)`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
