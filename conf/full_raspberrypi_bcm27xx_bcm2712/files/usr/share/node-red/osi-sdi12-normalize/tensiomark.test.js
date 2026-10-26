'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const normalizer = require('./index');

function configuration(order = 'pf_temperature') {
  return { version: 1, profile_id: 'TENSIOMARK', profile_version: 3, address: '2',
    settings: { source_unit: 'pF', variant: '1', field_order: order }, depths: [30] };
}

test('Tensiomark v3 binds source positions and hashes to an explicit rehearsal order', () => {
  const first = normalizer.resolveConfiguration(configuration());
  const second = normalizer.resolveConfiguration(configuration('temperature_pf'));
  for (const [resolved, indexes] of [[first, [0, 1]], [second, [1, 0]]]) {
    assert.equal(resolved.ok, true);
    assert.equal(resolved.provisional, true);
    assert.equal(resolved.acquisition_available, false);
    assert.deepEqual(resolved.channels.map(entry => [entry.key, entry.source_index]),
      [['swt_1', indexes[0]], ['soil_temp_1', indexes[1]]]);
    assert.deepEqual(resolved.interpretation.rules.map(entry => entry.source_index), indexes);
  }
  assert.notEqual(first.interpretation_hash, second.interpretation_hash);
  assert.notEqual(first.configuration_hash, second.configuration_hash);
  assert.equal(first.interpretation_hash, '14949e90c12a53b071ca9699fdc9d880b9aad73c9769992675b347339fadcc67');
  assert.equal(second.interpretation_hash, '81f62d06127add24af5b375a664a4df0a2bf506397ed7dcae22fb814732d1bf3');
  const reordered = configuration();
  reordered.settings = { field_order: 'pf_temperature', variant: '1', source_unit: 'pF' };
  assert.equal(normalizer.resolveConfiguration(reordered).configuration_hash, first.configuration_hash);
});

test('Tensiomark refuses retired versions, unspecified ordering and pressure acquisition', () => {
  for (const version of [1, 2]) {
    const input = configuration();
    input.profile_version = version;
    assert.equal(normalizer.resolveConfiguration(input).code, 'unsupported_profile_version');
  }
  for (const order of [undefined, null, 'auto', 'unknown', 'PF_TEMPERATURE', 0]) {
    const input = configuration();
    if (order === undefined) delete input.settings.field_order;
    else input.settings.field_order = order;
    assert.equal(normalizer.resolveConfiguration(input).ok, false);
  }
  for (const unit of ['hPa', 'mbar', 'kPa']) {
    const input = configuration();
    input.settings.source_unit = unit;
    assert.equal(normalizer.resolveConfiguration(input).code, 'protocol_evidence_required');
  }
});

for (const order of ['pf_temperature', 'temperature_pf']) {
  const raw = (pf, temperature) => (order === 'pf_temperature' ? [pf, temperature] : [temperature, pf])
    .map(value => value < 0 ? String(value) : '+' + value).join('');
  test('Tensiomark ' + order + ' converts pF once without clipping and accepts negative temperature', () => {
    for (const [pf, expected] of [[0, 0.1], [2, 10], [4, 1000], [7, 1000000]]) {
      const output = normalizer.normalizeConfigured({ BatV: 3.3, data_sum: raw(pf, -9.88) }, configuration(order), {});
      assert.equal(output.disposition, 'complete');
      assert.deepEqual(output.channels, { bat_v: 3.3, swt_1: expected, soil_temp_1: -9.88 });
      assert.deepEqual(output.unknown, {});
    }
  });

  test('Tensiomark ' + order + ' quarantines bad vectors with original text and battery', () => {
    for (const data of [raw(-9.88, 20), raw(4, -99.88), raw(4, -99.99), raw(-0.01, 20),
      raw(7.01, 20), raw(300, 20), raw(4, 80.01), raw(4, -40.01), '+4', '+4+20+1',
      '2+4+20', '+NaN+20', raw(4, 20) + 'NULL']) {
      const data_sum = ' ' + data + '\r\n';
      const output = normalizer.normalizeConfigured({ BatV: 3.3, data_sum }, configuration(order), {});
      assert.equal(output.disposition, 'quarantined', data);
      assert.equal(output.noResponse, false);
      assert.deepEqual(output.channels, { bat_v: 3.3 }, data);
      assert.equal(output.unknown.sdi12_tensiomark_raw, data_sum);
      assert.ok(Object.keys(output.unknown).length > 1, 'retain the specific refusal reason');
    }
  });
}

test('Tensiomark candidate refusal retains input even when configuration is invalid', () => {
  const config = configuration();
  delete config.settings.field_order;
  const result = normalizer.normalizeConfigured({ data_sum: '+4+20' }, config, {});
  assert.equal(result.disposition, 'quarantined');
  assert.equal(result.unknown.sdi12_configuration, 'invalid_settings');
  assert.equal(result.unknown.sdi12_tensiomark_raw, '+4+20');
  assert.deepEqual(result.channels, {});
});

test('unqualified legacy Tensiomark never emits soil values, including plausible swapped pairs', () => {
  for (const data_sum of ['+2.48+21.5', '+4+20', '+300+20', '+21.93+4.551', '+2+4',
    '+4+2', '-9.88+20', '+4', '  +4+20\r\n']) {
    const result = normalizer.normalize({ BatV: 3.3, data_sum }, { probeProfile: 'TENSIOMARK' }, {});
    assert.deepEqual(result.channels, { bat_v: 3.3 });
    assert.deepEqual(result.unknown, { sdi12_tensiomark_unqualified: data_sum });
    assert.equal(result.noResponse, false);
  }
  assert.deepEqual(normalizer.resolveLegacyConfiguration({ probeProfile: 'TENSIOMARK' }),
    { ok: false, code: 'protocol_evidence_required' });
});

test('Tensiomark absent replies remain absent rather than measured zero', () => {
  for (const data_sum of ['', '  ', 'NULL']) {
    const decoded = { BatV: 3.3, data_sum };
    for (const result of [normalizer.normalize(decoded, { probeProfile: 'TENSIOMARK' }, {}),
      normalizer.normalizeConfigured(decoded, configuration(), {})]) {
      assert.equal(result.noResponse, true);
      assert.deepEqual(result.channels, { bat_v: 3.3 });
      assert.deepEqual(result.unknown, {});
    }
  }
});
