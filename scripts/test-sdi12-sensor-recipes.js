'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { previewRecipe } = require('./lib/sdi12-sensor-recipes');

const CONFIGURATIONS = {
  DELTAT_PR2_4: { version: 1, profile_id: 'DELTAT_PR2_4', profile_version: 2, address: 'a',
    settings: { measurement_mode: 'mineral_vwc_percent' }, depths: [10, 20, 30, 40] },
  DELTAT_PR2_6: { version: 1, profile_id: 'DELTAT_PR2_6', profile_version: 2, address: 'a',
    settings: { measurement_mode: 'mineral_vwc_percent' }, depths: [10, 20, 30, 40, 60, 100] },
  METER_TEROS_11: { version: 1, profile_id: 'METER_TEROS_11', profile_version: 2, address: '1',
    settings: { calibration: 'mineral' }, depths: [30] },
  METER_TEROS_12: { version: 1, profile_id: 'METER_TEROS_12', profile_version: 2, address: '1',
    settings: { calibration: 'mineral' }, depths: [30] },
  TENSIOMARK: { version: 1, profile_id: 'TENSIOMARK', profile_version: 3, address: '2',
    settings: { source_unit: 'pF', variant: '1', field_order: 'pf_temperature' }, depths: [30] },
};

function input(profileId, changes) {
  return {
    configuration: structuredClone(CONFIGURATIONS[profileId]), command_family: 'M', supply_v: 12,
    power_mode: 'switched', interval_seconds: 1200,
    converter: { battery_mv: 3300, interrupt: false, payver: 1, max_slots: 8, max_payload_bytes: 255 },
    exchange: null,
    ...(changes || {}),
  };
}

function assertFlags(result) {
  assert.equal(result.hardware_verified, false);
  assert.equal(result.acquisition_available, false);
  assert.equal(result.eligible, false);
  assert.equal(result.configuration_verified, false);
  assert.equal(result.recipe_deployable, false);
}

function exchange(command, response, blocks) { return { command, response, blocks }; }
function block(address, index, response) { return { command: `${address}D${index}!`, response }; }
function crcReply(address, body) {
  let crc = 0;
  for (const character of address + body) {
    crc ^= character.charCodeAt(0);
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? ((crc >>> 1) ^ 0xa001) : (crc >>> 1);
  }
  return address + body + String.fromCharCode(0x40 | (crc >>> 12),
    0x40 | ((crc >>> 6) & 63), 0x40 | (crc & 63)) + '\r\n';
}

test('plans exact source-backed commands and readbacks for each supported profile', () => {
  const cases = [
    ['DELTAT_PR2_4', 'aM3!', 4, ['aI!', 'aXRM3S1!', 'aXRM3S2!', 'aXRM3S3!', 'aXRM3S4!']],
    ['DELTAT_PR2_6', 'aC3!', 6, ['aI!', 'aXRM3S1!', 'aXRM3S2!', 'aXRM3S3!', 'aXRM3S4!', 'aXRM3S5!', 'aXRM3S6!'], { command_family: 'C' }],
    ['METER_TEROS_11', '1MC!', 2, ['1I!'], { command_family: 'MC' }],
    ['METER_TEROS_12', '1M!', 3, ['1I!']],
    ['TENSIOMARK', '2M!', 2, ['2I!'], { interval_seconds: 900 }],
  ];
  for (const [profile, command, count, discovery, changes] of cases) {
    const result = previewRecipe(input(profile, changes));
    assert.equal(result.ok, true, profile);
    assert.equal(result.disposition, 'planned');
    assert.equal(result.recipe.measurement.command, command);
    assert.deepEqual(result.recipe.measurement.bytes, Array.from(Buffer.from(command, 'ascii')));
    assert.equal(result.recipe.expected_values, count);
    assert.deepEqual(result.recipe.discovery.map(item => item.command), discovery);
    assert.deepEqual(result.recipe.discovery.map(item => item.bytes), discovery.map(value => Array.from(Buffer.from(value, 'ascii'))));
    assert.deepEqual(result.recipe.retrieval.commands, Array.from({ length: 10 }, (_, index) =>
      `${result.recipe.configuration.address}D${index}!`));
    assert.equal(result.recipe.retrieval.max_successful_data_blocks, count);
    assert.equal(result.recipe.fixed_converter_recipe, null);
    assert.equal(result.recipe.power_window_ms, null);
    assertFlags(result);
  }
});

test('uses resolver refusal codes and rejects invalid outer input without coercion', () => {
  const cases = [
    [{ ...input('METER_TEROS_11'), configuration: { ...CONFIGURATIONS.METER_TEROS_11, profile_id: 'HYDRASCOUT' } }, 'protocol_evidence_required'],
    [input('METER_TEROS_11', { configuration: { ...CONFIGURATIONS.METER_TEROS_11, settings: { calibration: 'organic' } } }), 'invalid_settings'],
    [input('METER_TEROS_11', { command_family: 'C' }), 'unsupported_sensor_command'],
    [input('TENSIOMARK', { interval_seconds: 899 }), 'measurement_interval_too_short'],
    [input('METER_TEROS_11', { supply_v: 3.99 }), 'unsupported_supply_voltage'],
    [input('METER_TEROS_11', { supply_v: '12' }), 'invalid_input'],
    [input('METER_TEROS_11', { converter: { battery_mv: 3300, interrupt: false, payver: 1, max_slots: 8 } }), 'invalid_input'],
    [(() => { const value = input('METER_TEROS_11'); delete value.exchange; return value; })(), 'invalid_input'],
    [null, 'invalid_input'],
  ];
  for (const [value, code] of cases) {
    const result = previewRecipe(value);
    assert.equal(result.ok, false);
    assert.equal(result.disposition, 'invalid');
    assert.equal(result.code, code);
    assertFlags(result);
  }
});

test('applies profile supply, interval, and startup restrictions before planning', () => {
  for (const [profile, low, high] of [['DELTAT_PR2_4', 7.2, 16], ['METER_TEROS_11', 4, 15], ['TENSIOMARK', 7, 14]]) {
    assert.equal(previewRecipe(input(profile, { supply_v: low, interval_seconds: profile === 'TENSIOMARK' ? 900 : 1200 })).ok, true);
    assert.equal(previewRecipe(input(profile, { supply_v: high, interval_seconds: profile === 'TENSIOMARK' ? 900 : 1200 })).ok, true);
    assert.equal(previewRecipe(input(profile, { supply_v: low - 0.01, interval_seconds: profile === 'TENSIOMARK' ? 900 : 1200 })).code,
      'unsupported_supply_voltage');
  }
  assert.equal(previewRecipe(input('METER_TEROS_11', { configuration: { ...CONFIGURATIONS.METER_TEROS_11, address: '0' } })).code,
    'startup_string_requires_handling');
  const continuous = previewRecipe(input('METER_TEROS_11', { configuration: { ...CONFIGURATIONS.METER_TEROS_11, address: '0' }, power_mode: 'continuous' }));
  assert.equal(continuous.ok, true);
  assert.ok(continuous.recipe.unresolved.includes('initial_startup_handling'));
});

test('reports independently calculated width-nine capacity bounds without refusing narrow layouts', () => {
  const pr2 = previewRecipe(input('DELTAT_PR2_6', { converter: { battery_mv: 3300, interrupt: false, payver: 1, max_slots: 6, max_payload_bytes: 80 } }));
  assert.equal(pr2.ok, true);
  assert.deepEqual(pr2.recipe.capacity, {
    assumption: 'hypothetical_signed_token_width_9', packed_data_blocks: 2, max_successful_data_blocks: 6,
    packed_slots: 3, max_slots: 7, packed_payload_bytes: 76, max_payload_bytes: 96,
    packed_payload_fits: true, max_payload_fits: false, max_slots_fit: false,
    actual_layout_known: false, regional_budget_verified: false,
  });
  assert.equal(previewRecipe(input('METER_TEROS_12', { converter: { battery_mv: 3300, interrupt: false, payver: 1, max_slots: 4, max_payload_bytes: 44 } })).recipe.capacity.packed_payload_fits, true);
  assert.equal(previewRecipe(input('METER_TEROS_12', { converter: { battery_mv: 3300, interrupt: false, payver: 1, max_slots: 4, max_payload_bytes: 43 } })).recipe.capacity.packed_payload_fits, false);
});

test('simulates a complete raw PR2 exchange through wrapper bytes without normalization', () => {
  const supplied = input('DELTAT_PR2_4', { exchange: exchange('aM3!', 'a0014\r\n', [
    block('a', 0, 'a+1+2\r\n'), block('a', 1, 'a+3+4\r\n'),
  ]) });
  const result = previewRecipe(supplied);
  assert.equal(result.ok, true);
  assert.equal(result.disposition, 'simulated');
  assert.deepEqual(result.simulation.protocol.values, [1, 2, 3, 4]);
  assert.equal(result.simulation.payload.ok, true);
  assert.equal(result.simulation.roundtrip.ok, true);
  assert.equal(result.simulation.evidence, 'modelled_from_supplied_exchange');
  assert.equal(result.simulation.timing_verified, false);
  assert.equal('channels' in result, false);
  assert.deepEqual(supplied.exchange.blocks[0], block('a', 0, 'a+1+2\r\n'));
  assertFlags(result);
});

test('retains protocol diagnostics with profile-count and zero-count precedence', () => {
  const zero = previewRecipe(input('TENSIOMARK', { interval_seconds: 900,
    exchange: exchange('2M!', '20000\r\n', []) }));
  assert.equal(zero.ok, false);
  assert.equal(zero.code, 'profile_count_mismatch');
  assert.equal(zero.simulation.protocol.code, 'no_values');
  assert.equal(zero.simulation.protocol.disposition, 'no_values');

  const incomplete = previewRecipe(input('METER_TEROS_12', { exchange: exchange('1M!', '10003\r\n', [block('1', 0, '1+1\r\n')]) }));
  assert.equal(incomplete.ok, false);
  assert.equal(incomplete.disposition, 'incomplete');
  assert.equal(incomplete.code, 'incomplete_data');
  assert.equal(incomplete.simulation.payload, undefined);

  const mismatch = previewRecipe(input('DELTAT_PR2_4', { exchange: exchange('aM3!', 'a0013\r\n', [block('a', 0, 'a+1+2+3\r\n')]) }));
  assert.equal(mismatch.code, 'profile_count_mismatch');
  assert.equal(mismatch.simulation.protocol.ok, true);
  assertFlags(zero); assertFlags(incomplete); assertFlags(mismatch);
});

test('reports an announced wait above the requested interval before incomplete transcript status', () => {
  const result = previewRecipe(input('METER_TEROS_12', {
    interval_seconds: 11,
    exchange: exchange('1M!', '10123\r\n', [block('1', 0, '1+1\r\n')]),
  }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'interval_below_announced_wait');
  assert.equal(result.simulation.protocol.code, 'incomplete_data');
  assertFlags(result);
});

test('refuses mismatched commands, announced waits, slot budgets, and payload budgets without truncation', () => {
  const base = input('METER_TEROS_11', { command_family: 'MC', exchange: exchange('1MC!', '10122\r\n', [block('1', 0, crcReply('1', '+4+20'))]) });
  assert.equal(previewRecipe({ ...base, exchange: { ...base.exchange, command: '1M!' } }).code, 'recipe_command_mismatch');
  assert.equal(previewRecipe({ ...base, interval_seconds: 11 }).code, 'interval_below_announced_wait');
  assert.equal(previewRecipe({ ...base, converter: { ...base.converter, max_slots: 1 } }).code, 'command_slot_budget_exceeded');
  const payload = previewRecipe({ ...base, converter: { ...base.converter, max_payload_bytes: 1 } });
  assert.equal(payload.code, 'invalid_input');
  const tooSmall = previewRecipe({ ...base, converter: { ...base.converter, max_payload_bytes: 3 } });
  assert.equal(tooSmall.code, 'payload_budget_exceeded');
  assert.equal(tooSmall.simulation.payload.required_bytes > 3, true);
});

test('preserves DEL in complete CRC raw replies and retains no normalized field ordering for Tensiomark', () => {
  const first = crcReply('1', '+808');
  const teros = previewRecipe(input('METER_TEROS_11', { command_family: 'MC', exchange: exchange('1MC!', '10012\r\n', [
    block('1', 0, first), block('1', 1, crcReply('1', '+20')),
  ]) }));
  assert.equal(teros.ok, true);
  assert.ok(first.includes('\x7f'));
  assert.deepEqual(teros.simulation.protocol.tokens, ['+808', '+20']);
  assert.ok(teros.simulation.payload.bytes.includes(0x7f));
  const tensi = previewRecipe(input('TENSIOMARK', { interval_seconds: 900, exchange: exchange('2M!', '20002\r\n', [block('2', 0, '2+4+20\r\n')]) }));
  assert.equal(tensi.ok, true);
  assert.equal(tensi.simulation.protocol.values.length, 2);
  assert.equal(tensi.simulation.channels, undefined);
  assertFlags(teros); assertFlags(tensi);
});

test('structurally simulates TEROS sentinel tokens without applying candidate normalization', () => {
  const result = previewRecipe(input('METER_TEROS_11', {
    exchange: exchange('1M!', '10002\r\n', [block('1', 0, '1-9999+20\r\n')]),
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.simulation.protocol.tokens, ['-9999', '+20']);
  assert.equal(result.simulation.channels, undefined);
  assert.equal(result.simulation.normalized, undefined);
  assertFlags(result);
});
