'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const normalizer = require('./index');

const layout = {
  version: 1,
  kind: 'tensiomark',
  source_unit: 'pF',
  field_order: 'temperature_pf',
  qualification: 'bench_observed',
  sensors: [
    { address: '1', channel: 1, identity: '111TENSIOMARK_2Vh_10A00001', depth_cm: null, calibration_range: 'unverified' },
    { address: '4', channel: 2, identity: '411TENSIOMARK_2Vh_10A00002', depth_cm: null, calibration_range: 'unverified' }
  ]
};

function normalize(data_sum) {
  return normalizer.normalize({ BatV: 3.606, data_sum },
    { probeProfile: 'TENSIOMARK', sdi12ChannelLayout: layout },
    { recordedAt: '2026-10-15T13:54:04.426Z' });
}

test('strict Tensiomark layout is canonicalized, hashed, and keeps null depths', () => {
  const reversedSensors = { ...layout, sensors: layout.sensors.slice().reverse() };
  const first = normalizer.validateTensiomarkLayout(layout);
  const second = normalizer.validateTensiomarkLayout(reversedSensors);
  assert.equal(first.ok, true);
  assert.equal(first.configurationHash, second.configurationHash);
  assert.deepEqual(first.depths, {});
  assert.deepEqual(first.layout.sensors.map(sensor => sensor.channel), [1, 2]);
  assert.equal(first.configurationHash, '7ffe454085ba7aa8c6c56918f74b8a3904ce685165454c235d922e69ed93c869');
});

test('addressed Tensiomark maps temperature/pF by address without rounding', () => {
  const r = normalize('1+16.11+0.000\r\n4+18.25+5.359\r\n');
  assert.deepEqual(r.channels, {
    bat_v: 3.606, soil_temp_1: 16.11, swt_1: 0.1,
    soil_temp_2: 18.25, swt_2: 10 ** 5.359 / 10
  });
  assert.deepEqual(r.nativePf, { swt_1: '+0.000', swt_2: '+5.359' });
  assert.deepEqual(r.unknown, {});
  assert.equal(r.tensiomarkObservation.disposition, 'accepted');
  assert.equal(r.tensiomarkObservation.rawResponse, '1+16.11+0.000\r\n4+18.25+5.359\r\n');
  assert.deepEqual(r.tensiomarkObservation.nativePf, { swt_1: '+0.000', swt_2: '+5.359' });

  const reversed = normalize('4+18.25+5.359\r\n1+16.11+0.000\r\n');
  assert.deepEqual(reversed.channels, r.channels);
});

test('configured Tensiomark refuses malformed, unknown, duplicate, missing, and invalid batches atomically', () => {
  const cases = [
    ['1+16.11+0.000\n4+18.25+5.359\n', 'rejected_framing'],
    ['1+16.11+0.000\r\n4+18.25+5.359', 'rejected_framing'],
    ['1+16.11+0.000+7\r\n4+18.25+5.359\r\n', 'rejected_framing'],
    ['1+16.11+0.000\r\n1+18.25+5.359\r\n', 'rejected_addresses'],
    ['1+16.11+0.000\r\n2+18.25+5.359\r\n', 'rejected_addresses'],
    ['1+16.11+0.000\r\n', 'rejected_addresses'],
    ['1-9.88-0.010\r\n4+18.25+5.359\r\n', 'rejected_values'],
    ['1-99.88+0.000\r\n4+18.25+5.359\r\n', 'rejected_values'],
  ];
  for (const [raw, disposition] of cases) {
    const r = normalize(raw);
    assert.deepEqual(r.channels, { bat_v: 3.606 }, raw);
    assert.deepEqual(r.unknown, {}, raw);
    assert.equal(r.tensiomarkObservation.disposition, disposition, raw);
    assert.equal(r.tensiomarkObservation.rawResponse, raw, raw);
  }
});

test('configured Tensiomark accepts -9.88 C and uses explicit-layout only', () => {
  const r = normalize('1-9.88+0.000\r\n4+18.25+5.359\r\n');
  assert.equal(r.channels.soil_temp_1, -9.88);
  assert.equal(r.channels.swt_1, 0.1);
  assert.deepEqual(r.nativePf, { swt_1: '+0.000', swt_2: '+5.359' });

  const legacy = normalizer.normalize(
    { BatV: 3.606, data_sum: '1+16.11+0.000\r\n4+18.25+5.359\r\n' },
    { probeProfile: 'TENSIOMARK' }, {});
  assert.deepEqual(legacy.channels, { bat_v: 3.606 });
  assert.ok(legacy.unknown.sdi12_tensiomark_unqualified);
});

test('configured empty and NULL replies retain exact rejection evidence', () => {
  for (const raw of ['', 'NULL', ' \r\n ', '\t']) {
    const result = normalize(raw);
    assert.ok(result.tensiomarkObservation, 'configured failures require provenance');
    assert.equal(result.tensiomarkObservation.disposition, 'rejected_framing');
    assert.equal(result.tensiomarkObservation.rawResponse, raw);
    assert.deepEqual(result.channels, {bat_v:3.606});
  }
});
test('depth projection serializes identically regardless of sensor input order', () => {
  const withDepths = {...layout,sensors:layout.sensors.map((sensor,i)=>({...sensor,depth_cm:(i+1)*20}))};
  const reversed = {...withDepths,sensors:withDepths.sensors.slice().reverse()};
  assert.equal(JSON.stringify(normalizer.validateTensiomarkLayout(withDepths).depths),JSON.stringify(normalizer.validateTensiomarkLayout(reversed).depths));
});
