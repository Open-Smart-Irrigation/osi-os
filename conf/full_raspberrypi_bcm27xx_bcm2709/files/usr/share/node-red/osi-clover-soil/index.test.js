'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { decodeSoilUplink, deriveVwcPercent } = require('./index');

const codec = {};
vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '../codecs/tektelic_agriculture_decoder.js'), 'utf8'),
  codec,
);

function decode(hex) {
  return decodeSoilUplink({ fPort: 10, bytes: Buffer.from(hex, 'hex') });
}

const noSoil = {
  ok: true,
  frequencyKHz: null,
  voltageMv: null,
  gwcMassRatio: null,
  moistureCategory: null,
  soilTemperatureC: null,
  errors: [],
};

test('TRM v2.1 section 2.2.1 worked moisture examples', () => {
  for (const [hex, frequencyKHz, gwcMassRatio] of [
    ['01040552', 1362, 0.8],
    ['01040562', 1378, 0.5],
    ['01040572', 1394, 0.2],
  ]) {
    assert.deepEqual(decode(hex), { ...noSoil, frequencyKHz, gwcMassRatio }, hex);
  }
});

test('TRM v2.1 section 2.2.2 temperatures match at the vendor precision', () => {
  for (const [hex, voltageMv, expectedCelsius] of [
    ['0202060a', 1546, '-2.0'],
    ['02020160', 352, '46.0'],
    ['020202bc', 700, '23.7'],
    ['020205ad', 1453, '0.0'], // Synthetic near-zero case.
  ]) {
    const result = decode(hex);
    assert.deepEqual(
      { ...result, soilTemperatureC: result.soilTemperatureC.toFixed(1) },
      { ...noSoil, voltageMv, soilTemperatureC: expectedCelsius },
      hex,
    );
  }
  assert.ok(Math.abs(decode('0202060a').soilTemperatureC - (-2.0076153981235)) < 1e-12);
  assert.ok(decode('020205ad').soilTemperatureC > 0, 'retain the unrounded reading');
});

test('Table 4 shared endpoints follow the pinned TEKTELIC codec', () => {
  const convertFrequency = (kHz) => decode('0104' + kHz.toString(16).padStart(4, '0'));
  for (const [frequencyKHz, atBoundary, oneAbove] of [
    [1399, 0.1, 'Dry'],
    [1396, 0.2, 0.1],
    [1391, 0.3, 0.2],
    [1386, 0.4, 0.3],
    [1381, 0.5, 0.4],
    [1376, 0.6, 0.5],
    [1371, 0.7, 0.6],
    [1366, 0.8, 0.7],
    [1361, 0.9, 0.8],
    [1356, 1, 0.9],
    [1351, 1.1, 1],
    [1346, 1.2, 1.1],
    [1341, 'Wet', 1.2],
  ]) {
    for (const [kHz, expected] of [[frequencyKHz, atBoundary], [frequencyKHz + 1, oneAbove]]) {
      assert.deepEqual(convertFrequency(kHz), {
        ...noSoil,
        frequencyKHz: kHz,
        gwcMassRatio: typeof expected === 'number' ? expected : null,
        moistureCategory: typeof expected === 'string' ? expected : null,
      }, String(kHz));
    }
  }
  assert.deepEqual(convertFrequency(1402), { ...noSoil, frequencyKHz: 1402, moistureCategory: 'Dry' });
  assert.deepEqual(convertFrequency(1322), { ...noSoil, frequencyKHz: 1322, moistureCategory: 'Wet' });
});

test('TRM section 2.1 and the shipped codec agree on raw soil field casing and units', () => {
  for (const [hex, frequencyKHz, voltageMv, moisture, temp] of [
    ['01040579020202d5', 1401, 725, 'Dry', '22.6'],
    ['0104056e0202035c09650d570b6700ad0b68a5', 1390, 860, 0.3, '17.0'],
  ]) {
    const input = { fPort: 10, bytes: Array.from(Buffer.from(hex, 'hex')) };
    const shipped = codec.decodeUplink(input);
    const result = decodeSoilUplink(input);
    assert.equal(shipped.errors.length, 0);
    assert.equal(shipped.data.error, undefined);
    assert.equal(shipped.data.input1_frequency, frequencyKHz);
    assert.equal(shipped.data.input2_voltage, voltageMv);
    assert.equal(result.frequencyKHz, shipped.data.input1_frequency);
    assert.equal(result.voltageMv, shipped.data.input2_voltage);
    assert.equal(result.gwcMassRatio ?? result.moistureCategory, moisture);
    assert.equal(result.soilTemperatureC.toFixed(1), temp);
  }
});

test('walks record widths and leaves absent soil fields null on ambient and KIWI frames', () => {
  assert.deepEqual(decode(''), noSoil);
  assert.deepEqual(decode('00d35a00bd0a0a'), noSoil); // TRM battery example.
  assert.deepEqual(decode('096500000b6700e10b6892'), noSoil); // TRM ambient example.
  assert.deepEqual(decode('0302009d04670200'), noSoil); // TRM KIWI thermistor and OneWire example.
  const kiwi = '050407d0060409c4';
  assert.deepEqual(decode(kiwi), noSoil);
  const shipped = codec.decodeUplink({ fPort: 10, bytes: Array.from(Buffer.from(kiwi, 'hex')) });
  assert.equal(shipped.data.input5_frequency, 2000);
  assert.equal(shipped.data.input6_frequency, 2500);

  // The accelerometer includes soil-like bytes inside its six-byte value.
  assert.deepEqual(decode('020202bc0a7101040202030401040552'), {
    ...noSoil,
    frequencyKHz: 1362,
    voltageMv: 700,
    gwcMassRatio: 0.8,
    soilTemperatureC: decode('020202bc').soilTemperatureC,
  });
});

test('invalid soil values retain raw counts and leave the other channel usable', () => {
  for (const [hex, frequencyKHz] of [
    ['01040529', 1321],
    ['0104057b', 1403],
    ['01040000', 0],
    ['0104ffff', 65535],
  ]) {
    assert.deepEqual(decode(hex), { ...noSoil, frequencyKHz, errors: ['frequency_out_of_range'] });
  }
  assert.deepEqual(decode('0104055202020000'), {
    ...noSoil,
    frequencyKHz: 1362,
    voltageMv: 0,
    gwcMassRatio: 0.8,
    errors: ['zero_voltage'],
  });
  // Table 3 reserves no all-ones sentinel. This asserts the formula at the wire limit.
  const extreme = decode('0104ffff0202ffff');
  assert.equal(extreme.voltageMv, 65535);
  assert.equal(extreme.soilTemperatureC.toFixed(1), '-123.6');
  assert.deepEqual(extreme.errors, ['frequency_out_of_range']);
});

test('malformed frames yield a framing error without publishing a partial result', () => {
  for (const [hex, error] of [
    ['01', 'truncated_header'],
    ['0104', 'truncated_record'],
    ['0202ff', 'truncated_record'],
    ['010405520b67ff', 'truncated_record'],
    ['010405527f7f020202bc', 'unknown_record'],
    ['0104055201040562', 'duplicate_soil_record'],
    ['020202bc02020160', 'duplicate_soil_record'],
  ]) {
    assert.deepEqual(decode(hex), { ok: false, error }, hex);
  }
  for (const bytes of [undefined, '0104', [0x01, 0x04, 0x05, NaN], [Infinity], [256], [-1], [1.5], Array(1)]) {
    assert.deepEqual(decodeSoilUplink({ fPort: 10, bytes }), { ok: false, error: 'invalid_bytes' });
  }
  assert.deepEqual(decodeSoilUplink({ fPort: 100, bytes: [0x01, 0x04, 0x05, 0x52] }), {
    ok: false, error: 'unsupported_fport',
  });
});

test('VWC percent needs an explicit positive dry bulk density in g/cm³', () => {
  const { gwcMassRatio } = decode('0104056e');
  assert.equal(deriveVwcPercent(gwcMassRatio, 1.25), 37.5);
  assert.equal(deriveVwcPercent(0, 1.25), 0);
  for (const density of [undefined, null, 0, -1, NaN, Infinity, '1.25']) {
    assert.equal(deriveVwcPercent(gwcMassRatio, density), null);
  }
  for (const moisture of [undefined, null, 'Dry', 'Wet', -1, NaN, Infinity]) {
    assert.equal(deriveVwcPercent(moisture, 1.25), null);
  }
  assert.equal(deriveVwcPercent(1.2, Number.MAX_VALUE), null);
});
