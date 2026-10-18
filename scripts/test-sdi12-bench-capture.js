'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCaptureTemplate, inspectCapture } = require('./lib/sdi12-bench-capture');
const benchCaptures = require('./fixtures/device-integration/sdi12/bench-captures.json');

const CONFIGURATIONS = Object.freeze({
  DELTAT_PR2_4: { version: 1, profile_id: 'DELTAT_PR2_4', profile_version: 2, address: 'a', settings: { measurement_mode: 'mineral_vwc_percent' }, depths: [10, 20, 30, 40] },
  DELTAT_PR2_6: { version: 1, profile_id: 'DELTAT_PR2_6', profile_version: 2, address: 'a', settings: { measurement_mode: 'mineral_vwc_percent' }, depths: [10, 20, 30, 40, 60, 100] },
  METER_TEROS_11: { version: 1, profile_id: 'METER_TEROS_11', profile_version: 2, address: '1', settings: { calibration: 'mineral' }, depths: [30] },
  METER_TEROS_12: { version: 1, profile_id: 'METER_TEROS_12', profile_version: 2, address: '1', settings: { calibration: 'mineral' }, depths: [30] },
  TENSIOMARK: { version: 1, profile_id: 'TENSIOMARK', profile_version: 3, address: '2', settings: { source_unit: 'pF', variant: '1', field_order: 'pf_temperature' }, depths: [30] },
});

function recipeInput(profile, changes) {
  return {
    configuration: structuredClone(CONFIGURATIONS[profile]), command_family: 'M', supply_v: 12,
    power_mode: 'switched', interval_seconds: profile === 'TENSIOMARK' ? 900 : 1200,
    converter: { battery_mv: 3300, interrupt: false, payver: 1, max_slots: 8, max_payload_bytes: 255 },
    exchange: null,
    ...(changes || {}),
  };
}

function assertFlags(result) {
  assert.equal(result.hardware_verified, false);
  assert.equal(result.configuration_verified, false);
  assert.equal(result.acquisition_available, false);
  assert.equal(result.eligible, false);
  assert.equal(result.recipe_deployable, false);
}

function completeSerial(overrides) {
  return {
    version: 1,
    evidence: 'synthetic',
    scope: 'serial',
    capture_id: 'synthetic-pr2-four',
    captured_at: '2026-10-05T12:00:00.000Z',
    setup: { sensor_label: 'PR2 demonstration probe', converter_model: null, converter_firmware: null, converter_settings_text: null },
    recipe_input: recipeInput('DELTAT_PR2_4', {
      exchange: {
        command: 'aM3!', response: 'a0014\r\n', blocks: [
          { command: 'aD0!', response: 'a+1+2\r\n' }, { command: 'aD1!', response: 'a+3+4\r\n' },
        ],
      },
    }),
    discovery: [
      { command: 'aI!', response_bytes: [255] },
      { command: 'aXRM3S1!', response_bytes: [1] },
      { command: 'aXRM3S2!', response_bytes: [2] },
      { command: 'aXRM3S3!', response_bytes: [3] },
      { command: 'aXRM3S4!', response_bytes: [4] },
    ],
    timing: { measurement_started_ms: 0, announcement_received_ms: 1000, data_requested_ms: [2000, 2000], since_previous_start_ms: null, power_on_ms: 0 },
    radio: null,
    ...(overrides || {}),
  };
}

function radioFrame(bytes, changes) {
  return {
    received_at: '2026-10-05T12:00:01.000Z', dev_eui: '0016C001F1000001', session_ref: 'synthetic-session', fcnt_up: 9,
    frame: { fport: 2, bytes, configuration: { dataup: 0, payver: 1, alldatamod: 1, datacut: 'none', dataconv: 'none', ext: [0, 0, 0] } },
    bindings: [{ slot: 3, response_command: 'aD1!' }, { slot: 1, response_command: 'aM3!' }, { slot: 2, response_command: 'aD0!' }],
    ...(changes || {}),
  };
}

const PR2_RADIO_BYTES = [0, 0, 1,
  0xf1, 7, 97, 48, 48, 49, 52, 13, 10,
  0xf2, 7, 97, 43, 49, 43, 50, 13, 10,
  0xf3, 7, 97, 43, 51, 43, 52, 13, 10];

test('creates detached incomplete templates with the exact discovered command order for every profile', () => {
  const cases = [
    ['DELTAT_PR2_4', ['aI!', 'aXRM3S1!', 'aXRM3S2!', 'aXRM3S3!', 'aXRM3S4!']],
    ['DELTAT_PR2_6', ['aI!', 'aXRM3S1!', 'aXRM3S2!', 'aXRM3S3!', 'aXRM3S4!', 'aXRM3S5!', 'aXRM3S6!']],
    ['METER_TEROS_11', ['1I!']], ['METER_TEROS_12', ['1I!']], ['TENSIOMARK', ['2I!']],
  ];
  for (const [profile, commands] of cases) {
    const supplied = recipeInput(profile);
    const result = createCaptureTemplate(supplied);
    assert.equal(result.ok, true, profile);
    assert.equal(result.disposition, 'template');
    assert.deepEqual(result.capture.discovery, commands.map(command => ({ command, response_bytes: null })));
    assert.deepEqual(result.capture.timing, { measurement_started_ms: null, announcement_received_ms: null,
      data_requested_ms: [], since_previous_start_ms: null, power_on_ms: null });
    assert.equal(result.capture.recipe_input.exchange, null);
    assertFlags(result);
    supplied.configuration.address = 'z';
    assert.equal(result.capture.recipe_input.configuration.address, CONFIGURATIONS[profile].address);
    result.capture.recipe_input.configuration.address = 'y';
    assert.equal(supplied.configuration.address, 'z');
  }
});

test('refuses non-plan and Hydra template inputs without changing their preview refusal', () => {
  const nonPlan = createCaptureTemplate(recipeInput('METER_TEROS_11', {
    exchange: { command: '1M!', response: '10002\r\n', blocks: [{ command: '1D0!', response: '1+1+2\r\n' }] },
  }));
  assert.equal(nonPlan.code, 'template_requires_plan');
  const hydra = createCaptureTemplate(recipeInput('METER_TEROS_11', {
    configuration: { ...CONFIGURATIONS.METER_TEROS_11, profile_id: 'HYDRASCOUT' },
  }));
  assert.equal(hydra.code, 'protocol_evidence_required');
  assertFlags(nonPlan); assertFlags(hydra);
});

test('keeps a complete synthetic serial record internally consistent without qualifying it', () => {
  const supplied = completeSerial();
  const result = inspectCapture(supplied);
  assert.equal(result.ok, true);
  assert.equal(result.disposition, 'consistent');
  assert.equal(result.evidence, 'synthetic');
  assert.equal(result.qualification, 'not_assessed');
  assert.equal(result.timing_verified, false);
  assert.equal(result.bindings_verified, false);
  assert.deepEqual(result.capture.discovery[0].response_bytes, [255]);
  assert.ok(result.unresolved.includes('identity_and_readback_semantics'));
  assert.ok(result.unresolved.includes('cross_observation_freshness'));
  assert.ok(result.unresolved.includes('previous_start_unknown'));
  assertFlags(result);
  supplied.discovery[0].response_bytes[0] = 0;
  supplied.recipe_input.exchange.blocks[0].response = 'a+9+9\r\n';
  assert.deepEqual(result.capture.discovery[0].response_bytes, [255]);
  assert.equal(result.capture.recipe_input.exchange.blocks[0].response, 'a+1+2\r\n');
});

test('rejects malformed capture metadata without echoing the malformed record', () => {
  const malformed = completeSerial({ captured_at: '2026-02-30T12:00:00.000Z' });
  const result = inspectCapture(malformed);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_capture');
  assert.equal(result.capture, undefined);
  assertFlags(result);
});

test('bounds deeply nested JSON recipe input without throwing while retaining public flags', () => {
  const record = structuredClone(benchCaptures[0].input);
  record.recipe_input = JSON.parse('['.repeat(5000) + '0' + ']'.repeat(5000));
  const result = inspectCapture(record);
  assert.equal(result.ok, false);
  assert.equal(result.disposition, 'invalid');
  assert.equal(result.code, 'invalid_capture');
  assert.equal(result.capture, undefined);
  assertFlags(result);
});

test('rejects sparse arrays and reports exact UTC rather than normalizing malformed values', () => {
  const sparseDiscovery = completeSerial();
  delete sparseDiscovery.discovery[2];
  const sparseResult = inspectCapture(sparseDiscovery);
  assert.equal(sparseResult.code, 'invalid_capture');
  assert.equal(sparseResult.capture, undefined);
  const nonUtc = inspectCapture(completeSerial({ captured_at: '2026-10-05T12:00:00Z' }));
  assert.equal(nonUtc.code, 'invalid_capture');
  assertFlags(sparseResult); assertFlags(nonUtc);
});

test('reports missing capture evidence and serial-versus-radio scope violations after retaining valid structure', () => {
  const incomplete = inspectCapture(completeSerial({ capture_id: null, captured_at: null,
    setup: { sensor_label: null, converter_model: null, converter_firmware: null, converter_settings_text: null },
    discovery: completeSerial().discovery.map(item => ({ ...item, response_bytes: null })),
    recipe_input: recipeInput('DELTAT_PR2_4'),
    timing: { measurement_started_ms: null, announcement_received_ms: null, data_requested_ms: [], since_previous_start_ms: null, power_on_ms: null },
  }));
  assert.equal(incomplete.code, 'capture_incomplete');
  assert.deepEqual(incomplete.missing, ['capture_id', 'captured_at', 'setup.sensor_label', 'discovery[0].response_bytes',
    'discovery[1].response_bytes', 'discovery[2].response_bytes', 'discovery[3].response_bytes', 'discovery[4].response_bytes',
    'exchange', 'timing.measurement_started_ms', 'timing.announcement_received_ms']);
  assert.equal(incomplete.capture.recipe_input.exchange, null);
  const wrongScope = inspectCapture(completeSerial({ radio: radioFrame(PR2_RADIO_BYTES) }));
  assert.equal(wrongScope.code, 'scope_radio_mismatch');
  assertFlags(incomplete); assertFlags(wrongScope);
});

test('rejects known timing contradictions before incomplete or malformed transcript diagnostics', () => {
  const malformedCrc = completeSerial({
    recipe_input: recipeInput('METER_TEROS_11', { command_family: 'MC', exchange: {
      command: '1MC!', response: '10102\r\n', blocks: [{ command: '1D0!', response: '1+8\r\n' }],
    } }),
    discovery: [{ command: '1I!', response_bytes: [1] }],
    timing: { measurement_started_ms: 0, announcement_received_ms: 1000, data_requested_ms: [10999], since_previous_start_ms: null, power_on_ms: null },
  });
  const early = inspectCapture(malformedCrc);
  assert.equal(early.code, 'announced_wait_not_observed');
  assert.equal(early.preview.code, 'invalid_crc');

  const beforeStart = inspectCapture(completeSerial({ timing: { measurement_started_ms: 100, announcement_received_ms: null,
    data_requested_ms: [99, null], since_previous_start_ms: null, power_on_ms: null } }));
  assert.equal(beforeStart.code, 'timing_order_invalid');

  const descending = inspectCapture(completeSerial({ timing: { measurement_started_ms: 0, announcement_received_ms: 0,
    data_requested_ms: [2000, null], since_previous_start_ms: null, power_on_ms: null },
    recipe_input: recipeInput('DELTAT_PR2_4', { exchange: { command: 'aM3!', response: 'a0014\r\n', blocks: [{ command: 'aD0!', response: 'a+1+2\r\n' }, { command: 'aD1!', response: 'a+3+4\r\n' }] } }),
  }));
  assert.equal(descending.code, 'capture_incomplete');
  const decreasing = inspectCapture(completeSerial({ timing: { measurement_started_ms: 0, announcement_received_ms: 0,
    data_requested_ms: [2000, null, 1000], since_previous_start_ms: null, power_on_ms: null },
    recipe_input: recipeInput('DELTAT_PR2_4', { exchange: { command: 'aM3!', response: 'a0014\r\n', blocks: [{ command: 'aD0!', response: 'a+1+2\r\n' }, { command: 'aD1!', response: 'a+3+4\r\n' }, { command: 'aD2!', response: 'a+5+6\r\n' }] } }),
  }));
  assert.equal(decreasing.code, 'timing_order_invalid');
  assertFlags(early); assertFlags(beforeStart); assertFlags(decreasing);
});

test('uses a valid announcement wait when a later block is structurally malformed', () => {
  const record = structuredClone(benchCaptures.find(item => item.name === 'teros-twelve-serial').input);
  record.recipe_input.exchange.blocks = [null];
  record.timing.data_requested_ms = [21099];
  const result = inspectCapture(record);
  assert.equal(result.code, 'announced_wait_not_observed');
  assert.equal(result.preview.code, 'invalid_block');
  const mismatch = structuredClone(record);
  mismatch.timing.data_requested_ms = [];
  const mismatchResult = inspectCapture(mismatch);
  assert.equal(mismatchResult.code, 'timing_blocks_mismatch');
  assert.equal(mismatchResult.preview.code, 'invalid_block');
  assertFlags(result);
  assertFlags(mismatchResult);
});

test('enforces observed Tensiomark interval rather than requested recipe interval', () => {
  const result = inspectCapture(completeSerial({
    recipe_input: recipeInput('TENSIOMARK', { exchange: { command: '2M!', response: '20002\r\n', blocks: [{ command: '2D0!', response: '2+4+20\r\n' }] } }),
    discovery: [{ command: '2I!', response_bytes: [1] }],
    timing: { measurement_started_ms: 0, announcement_received_ms: 0, data_requested_ms: [0], since_previous_start_ms: 899999, power_on_ms: null },
  }));
  assert.equal(result.code, 'measurement_interval_not_observed');
  assertFlags(result);
});

test('checks radio frame budgets, payver and byte-exact wire-order exchange evidence', () => {
  const record = completeSerial({ scope: 'radio', setup: { sensor_label: 'PR2 demonstration probe', converter_model: 'converter', converter_firmware: '1.0', converter_settings_text: 'all data' }, radio: radioFrame(PR2_RADIO_BYTES) });
  const result = inspectCapture(record);
  assert.equal(result.ok, true);
  assert.equal(result.disposition, 'consistent');
  assert.equal(result.radio_check.ok, true);
  assertFlags(result);

  const altered = inspectCapture({ ...record, radio: radioFrame([0, 0, 1,
    0xf1, 7, 97, 48, 48, 49, 52, 13, 10,
    0xf2, 7, 97, 43, 49, 43, 50, 13, 10,
    0xf3, 9, 97, 43, 51, 46, 48, 43, 52, 13, 10]) });
  assert.equal(altered.code, 'radio_exchange_mismatch');
  const payver = inspectCapture({ ...record, radio: radioFrame([0, 0, 2, ...PR2_RADIO_BYTES.slice(3)], {
    frame: { fport: 2, bytes: [0, 0, 2, ...PR2_RADIO_BYTES.slice(3)], configuration: { dataup: 0, payver: 2, alldatamod: 1, datacut: 'none', dataconv: 'none', ext: [0, 0, 0] } },
  }) });
  assert.equal(payver.code, 'radio_payver_mismatch');
  const payload = inspectCapture({ ...record, recipe_input: recipeInput('DELTAT_PR2_4', { converter: { battery_mv: 3300, interrupt: false, payver: 1, max_slots: 8, max_payload_bytes: 20 }, exchange: record.recipe_input.exchange }) });
  assert.equal(payload.code, 'radio_payload_budget_exceeded');
  const slots = inspectCapture({ ...record, recipe_input: recipeInput('DELTAT_PR2_4', { converter: { battery_mv: 3300, interrupt: false, payver: 1, max_slots: 2, max_payload_bytes: 255 }, exchange: record.recipe_input.exchange }) });
  assert.equal(slots.code, 'radio_slot_budget_exceeded');
});

test('keeps malformed radio diagnostics distinct from malformed outer metadata and preserves CRC DEL bytes', () => {
  const base = completeSerial({ scope: 'radio', setup: { sensor_label: 'TEROS', converter_model: 'converter', converter_firmware: '1.0', converter_settings_text: 'all data' },
    recipe_input: recipeInput('METER_TEROS_11', { command_family: 'MC', exchange: { command: '1MC!', response: '10012\r\n', blocks: [{ command: '1D0!', response: '1+808C\x7f`\r\n' }, { command: '1D1!', response: '1+20HAk\r\n' }] } }),
    discovery: [{ command: '1I!', response_bytes: [1] }], timing: { measurement_started_ms: 0, announcement_received_ms: 0, data_requested_ms: [1000, 1000], since_previous_start_ms: null, power_on_ms: null },
  });
  const malformedFrame = inspectCapture({ ...base, radio: radioFrame({ not: 'a frame' }) });
  assert.equal(malformedFrame.code, 'radio_not_complete');
  assert.equal(malformedFrame.radio_check.code, 'wrapper_not_complete');
  const malformedBinding = inspectCapture({ ...base, radio: radioFrame([0, 0, 1, 0xf1, 7, 49, 48, 48, 49, 50, 13, 10], { bindings: [{}] }) });
  assert.equal(malformedBinding.code, 'radio_not_complete');
  const outer = inspectCapture({ ...base, radio: { ...radioFrame([], { bindings: [] }), dev_eui: 'not-an-eui' } });
  assert.equal(outer.code, 'invalid_capture');
  assert.equal(outer.capture, undefined);
  assert.ok(malformedFrame.capture.recipe_input.exchange.blocks[0].response.includes('\x7f'));
  assertFlags(malformedFrame); assertFlags(malformedBinding); assertFlags(outer);
});

test('retains DATAUP fragments and unsupported converter settings as bounded radio diagnostics', () => {
  const record = completeSerial({ scope: 'radio', setup: { sensor_label: 'PR2', converter_model: 'converter', converter_firmware: '1.0', converter_settings_text: 'all data' } });
  const fragment = inspectCapture({ ...record, radio: radioFrame([0, 0, 1, 1, 0], {
    frame: { fport: 2, bytes: [0, 0, 1, 1, 0], configuration: { dataup: 1, payver: 1, alldatamod: 1, datacut: 'none', dataconv: 'none', ext: [0, 0, 0] } },
  }) });
  assert.equal(fragment.code, 'radio_not_complete');
  assert.equal(fragment.radio_check.wrapper.code, 'fragment_requires_reassembly');
  const transformed = inspectCapture({ ...record, radio: radioFrame(PR2_RADIO_BYTES, {
    frame: { fport: 2, bytes: PR2_RADIO_BYTES, configuration: { dataup: 0, payver: 1, alldatamod: 1, datacut: 'none', dataconv: 'configured', ext: [0, 0, 0] } },
  }) });
  assert.equal(transformed.code, 'radio_not_complete');
  assert.equal(transformed.radio_check.wrapper.code, 'unsupported_configuration');
  assert.deepEqual(fragment.capture.radio.frame.bytes, [0, 0, 1, 1, 0]);
  assertFlags(fragment); assertFlags(transformed);
});

test('retains partial and aborted transcript results after otherwise complete capture evidence', () => {
  const partial = inspectCapture(completeSerial({
    recipe_input: recipeInput('METER_TEROS_12', { exchange: { command: '1M!', response: '10003\r\n', blocks: [{ command: '1D0!', response: '1+1\r\n' }] } }),
    discovery: [{ command: '1I!', response_bytes: [1] }],
    timing: { measurement_started_ms: 0, announcement_received_ms: 0, data_requested_ms: [0], since_previous_start_ms: null, power_on_ms: null },
  }));
  assert.equal(partial.disposition, 'incomplete');
  assert.equal(partial.code, 'incomplete_data');
  const aborted = inspectCapture(completeSerial({
    recipe_input: recipeInput('TENSIOMARK', { exchange: { command: '2M!', response: '20002\r\n', blocks: [{ command: '2D0!', response: '2\r\n' }] } }),
    discovery: [{ command: '2I!', response_bytes: [1] }],
    timing: { measurement_started_ms: 0, announcement_received_ms: 0, data_requested_ms: [0], since_previous_start_ms: 900000, power_on_ms: null },
  }));
  assert.equal(aborted.disposition, 'aborted');
  assert.equal(aborted.code, 'measurement_aborted');
  assertFlags(partial); assertFlags(aborted);
});

test('keeps bench and radio timestamps as unqualified operator assertions', () => {
  const bench = inspectCapture(completeSerial({ evidence: 'bench' }));
  assert.equal(bench.ok, true);
  assert.equal(bench.evidence, 'bench');
  assert.equal(bench.qualification, 'not_assessed');
  const radioEarly = inspectCapture(completeSerial({ scope: 'radio', setup: { sensor_label: 'PR2', converter_model: 'converter', converter_firmware: '1.0', converter_settings_text: 'all data' },
    radio: radioFrame(PR2_RADIO_BYTES, { received_at: '2026-10-05T11:59:59.999Z' }) }));
  assert.equal(radioEarly.code, 'radio_time_order_invalid');
  assertFlags(bench); assertFlags(radioEarly);
});

test('gives discovery mismatch precedence over timing and preview errors', () => {
  const result = inspectCapture(completeSerial({
    discovery: [{ command: 'aXRM3S1!', response_bytes: [1] }],
    timing: { measurement_started_ms: 2, announcement_received_ms: 1, data_requested_ms: [0], since_previous_start_ms: null, power_on_ms: null },
  }));
  assert.equal(result.code, 'discovery_commands_mismatch');
  assertFlags(result);
});

test('preserves an unknown radio session as missing evidence without inventing a reference', () => {
  const capture = structuredClone(benchCaptures.find(item => item.name === 'pr2-six-radio').input);
  capture.radio.session_ref = null;
  const result = inspectCapture(capture);
  assert.equal(result.code, 'capture_incomplete');
  assert.equal(result.disposition, 'incomplete');
  assert.deepEqual(result.missing, ['radio.session_ref']);
  assert.equal(result.capture.radio.session_ref, null);
  assert.equal(result.radio_check.ok, true);
  assertFlags(result);
});
