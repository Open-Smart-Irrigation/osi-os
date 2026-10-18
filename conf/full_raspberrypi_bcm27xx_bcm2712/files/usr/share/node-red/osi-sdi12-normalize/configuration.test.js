'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const normalize = require('./index');

function configuration(profile = 'METER_TEROS_12', changes = {}) {
  const settings = profile.startsWith('DELTAT_')
    ? { measurement_mode: 'mineral_vwc_percent' }
    : profile === 'TENSIOMARK' ? { source_unit: 'pF', variant: '1', field_order: 'pf_temperature' }
      : { calibration: 'mineral' };
  const depths = profile === 'DELTAT_PR2_4' ? [10, 20, 30, 40]
    : profile === 'DELTAT_PR2_6' ? [10, 20, 30, 40, 60, 100] : [30];
  return { version: 1, profile_id: profile, profile_version: profile === 'TENSIOMARK' ? 3 : 2, address: '1', settings, depths, ...changes };
}

test('candidate resolver exposes canonical channels and remains provisional', () => {
  const result = normalize.resolveConfiguration(configuration());
  assert.equal(result.ok, true);
  assert.equal(result.expected_values, 3);
  assert.deepEqual(result.channels, [
    { key: 'vwc_1', unit: '%', depth_cm: 30, source_index: 0 },
    { key: 'soil_temp_1', unit: '°C', depth_cm: 30, source_index: 1 },
    { key: 'soil_ec_1', unit: 'µS/cm', depth_cm: 30, source_index: 2 },
  ]);
  assert.equal(result.provisional, true);
  assert.equal(result.acquisition_available, false);
  assert.match(result.configuration_hash, /^[a-f0-9]{64}$/);
  assert.match(result.interpretation_hash, /^[a-f0-9]{64}$/);
});

test('each candidate has an exact shape; PR2 suffixes cannot learn a count', () => {
  for (const [id, count, depths] of [
    ['DELTAT_PR2_4', 4, [10, 20, 30, 40]],
    ['DELTAT_PR2_6', 6, [10, 20, 30, 40, 60, 100]],
    ['METER_TEROS_11', 2, [30, 30]],
    ['TENSIOMARK', 2, [30, 30]],
  ]) {
    const result = normalize.resolveConfiguration(configuration(id));
    assert.equal(result.ok, true, id);
    assert.equal(result.expected_values, count, id);
    assert.deepEqual(result.channels.map(c => c.depth_cm), depths, id);
  }
  assert.deepEqual(normalize.resolveConfiguration(configuration('METER_TEROS_11')).channels.map(c => c.key),
    ['vwc_1', 'soil_temp_1']);
  assert.equal(normalize.resolveConfiguration(configuration('DELTAT_PR2_4', { depths: [10, 20, 30] })).ok, false);
});

test('malformed configuration and undeclared fields fail closed', () => {
  const good = configuration();
  for (const input of [null, [], 'x', 1, {}, { ...good, version: '1' },
    { ...good, version: 2 }, { ...good, profile_version: 0 },
    { ...good, profile_version: '1' }, { ...good, profile_id: 'UNKNOWN' },
    { ...good, profile_id: 'toString' }, { ...good, address: '01' },
    { ...good, address: '' }, { ...good, address: 1 },
    { ...good, transform: 'custom' }, { ...good, value_count: 3 },
    { ...good, settings: null }, { ...good, settings: [] },
    { ...good, depths: null }, { ...good, depths: ['30'] },
    { ...good, depths: [0] }, { ...good, depths: [1001] },
    { ...good, depths: [30.5] }, { ...good, depths: [Infinity] },
    { ...good, depths: [30, 40] },
    configuration('DELTAT_PR2_4', { depths: [10, 10, 30, 40] }),
  ]) {
    const result = normalize.resolveConfiguration(input);
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.equal(typeof result.code, 'string');
    assert.equal(result.channels, undefined);
  }
});

test('settings bind documented interpretation, with firmware reserved for future observed evidence', () => {
  for (const settings of [
    {}, { calibration: 'soilless', firmware: '3.00' },
    { calibration: 'mineral', firmware: '2.99' },
    { calibration: 'mineral', firmware: '3.0' },
    { calibration: 'mineral', firmware: 300 },
    { calibration: 'mineral', firmware: '03.00' },
    { calibration: 'mineral', firmware: '99.99' },
    { calibration: 'mineral', firmware: '3.00' },
    { calibration: 'mineral', firmware: '3.00', scale: 100 },
  ]) assert.equal(normalize.resolveConfiguration(configuration('METER_TEROS_12', { settings })).ok, false);
  assert.equal(normalize.resolveConfiguration(configuration('METER_TEROS_12', {
    settings: { calibration: 'mineral' },
  })).ok, true);
  assert.equal(normalize.resolveConfiguration(configuration('TENSIOMARK', {
    settings: { source_unit: 'hPa', variant: '1' },
  })).code, 'protocol_evidence_required');
  for (const variant of ['2', '3']) assert.equal(normalize.resolveConfiguration(configuration('TENSIOMARK', {
    settings: { source_unit: 'pF', variant },
  })).code, 'protocol_evidence_required');
  assert.equal(normalize.resolveConfiguration(configuration('TENSIOMARK', {
    settings: { source_unit: 'pF' },
  })).ok, false);
  assert.equal(normalize.resolveConfiguration(configuration('TENSIOMARK', {
    settings: { source_unit: 'auto' },
  })).ok, false);
  assert.equal(normalize.resolveConfiguration(configuration('DELTAT_PR2_4', {
    settings: { measurement_mode: 'permittivity' },
  })).ok, false);
  assert.equal(normalize.resolveConfiguration(configuration('HYDRASCOUT')).code, 'protocol_evidence_required');
  assert.equal(normalize.resolveConfiguration(configuration(undefined, { profile_version: 1 })).code,
    'unsupported_profile_version');
});

test('canonical hashing ignores object key order but includes every interpretation setting', () => {
  const input = configuration();
  const result = normalize.resolveConfiguration(input);
  const reordered = { depths: [30], address: '1', profile_version: 2,
    settings: { calibration: 'mineral' }, profile_id: 'METER_TEROS_12', version: 1 };
  assert.equal(normalize.resolveConfiguration(reordered).configuration_hash, result.configuration_hash);
  for (const changed of [configuration('METER_TEROS_11'), configuration(undefined, { address: 'A' }),
    configuration(undefined, { depths: [40] })]) {
    assert.notEqual(normalize.resolveConfiguration(changed).configuration_hash, result.configuration_hash);
  }
  for (const changed of [configuration(undefined, { address: 'A' }), configuration(undefined, { depths: [40] })]) {
    assert.equal(normalize.resolveConfiguration(changed).interpretation_hash, result.interpretation_hash);
  }
  result.configuration.settings.calibration = 'changed';
  result.channels[0].unit = 'wrong';
  result.configuration.depths[0] = 99;
  result.interpretation.rules[0].range[0] = 999;
  assert.deepEqual(input, configuration());
  assert.equal(normalize.resolveConfiguration(input).channels[0].unit, '%');
  assert.equal(normalize.resolveConfiguration(input).configuration.depths[0], 30);
  assert.equal(normalize.resolveConfiguration(input).interpretation.rules[0].range[0], 0);
  assert.equal(sample('+3000+20+0').disposition, 'complete');
});

test('profile-version digest pins require a new version for changes to interpretation rules', () => {
  // Compatibility contract: retain these pins. New rules need a new version,
  // never an updated hash under an existing profile/version.
  const pins = {
    DELTAT_PR2_4: '708c551a881e18b0eb2f1bea9c7d3e1afe8cbf10bd879b0e389d4ace11e91dad',
    DELTAT_PR2_6: '294aa5d5392893b5472a372ddbbf1c03cf9562e6377b2a5bb4cb005485692851',
    METER_TEROS_11: '3f90b82a0c125bca6552137e78ba7a7f75a3d1660b2308c95bd5d6cb2ed7ca6e',
    METER_TEROS_12: '3d926c9ebe462173174dcebde26e93fa51eabcc918c81002db9e42b737470c72',
    TENSIOMARK: '14949e90c12a53b071ca9699fdc9d880b9aad73c9769992675b347339fadcc67',
  };
  for (const [profile, expected] of Object.entries(pins)) {
    const result = normalize.resolveConfiguration(configuration(profile));
    assert.equal(result.interpretation.profile_version, profile === 'TENSIOMARK' ? 3 : 2);
    assert.equal(result.interpretation_hash, expected, profile + '/' + result.interpretation.profile_version + ' changed: bump version');
    assert.equal(result.interpretation_hash,
      crypto.createHash('sha256').update(JSON.stringify(result.interpretation)).digest('hex'));
    assert.equal(result.configuration_hash, crypto.createHash('sha256')
      .update(JSON.stringify({ configuration: result.configuration, interpretation_hash: expected })).digest('hex'));
  }
});

test('legacy PR2 preserves learned count and missing depths, with no profile rewrite', () => {
  const input = { probeProfile: 'DELTAT_PR2_4', sdi12ValueCount: 5, depths: { vwc_1: 12 } };
  const before = JSON.stringify(input);
  const result = normalize.resolveLegacyConfiguration(input);
  assert.equal(result.ok, true);
  assert.equal(result.legacy, true);
  assert.equal(result.profile_version, 0);
  assert.equal(result.expected_values, 5);
  assert.deepEqual(result.channels.map(c => c.key), ['vwc_1', 'vwc_2', 'vwc_3', 'vwc_4', 'vwc_5']);
  assert.deepEqual(result.channels.map(c => c.depth_cm), [12, null, null, null, null]);
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(normalize.normalize({ data_sum: '+1+2+3+4+5' }, input, {}).channels,
    { vwc_1: 1, vwc_2: 2, vwc_3: 3, vwc_4: 4, vwc_5: 5 });
  const fallback = normalize.resolveLegacyConfiguration({ probeProfile: 'DELTAT_PR2_6', sdi12ValueCount: 9 });
  assert.equal(fallback.expected_values, null);
  assert.equal(fallback.channels.length, 8);
});

test('legacy Sentek adapter follows canonical response positions and compact VIC group', () => {
  const input = { probeProfile: 'SENTEK_ENVIROSCAN', sdi12ChannelLayout: { version: 1, address: 'L', sensors: [
    { channel: 5, response_position: 2, depth_cm: 50, type: 'TRISCAN' },
    { channel: 3, response_position: 1, depth_cm: 20, type: 'ENVIROSCAN' },
  ] } };
  const result = normalize.resolveLegacyConfiguration(input);
  assert.equal(result.ok, true);
  assert.equal(result.expected_values, 3);
  assert.deepEqual(result.channels.map(c => [c.key, c.depth_cm, c.source_index]), [
    ['vwc_3', 20, 0], ['vwc_5', 50, 1], ['soil_vic_5', 50, 2],
  ]);
  assert.equal(normalize.resolveLegacyConfiguration({ ...input, sdi12ChannelLayout: '{}' }).ok, false);
  const stringLayout = { ...input, sdi12ChannelLayout: JSON.stringify(input.sdi12ChannelLayout) };
  assert.deepEqual(normalize.resolveLegacyConfiguration(stringLayout), result);
});

test('legacy fixed profiles ignore stale learned counts and retain old normalization', () => {
  for (const [profile, count] of [['HYDRASCOUT', 6]]) {
    const result = normalize.resolveLegacyConfiguration({ probeProfile: profile, sdi12ValueCount: 7 });
    assert.equal(result.ok, true);
    assert.equal(result.expected_values, count);
    assert.equal(result.channels.length, count);
  }
  assert.equal(normalize.resolveLegacyConfiguration({ probeProfile: 'TENSIOMARK' }).code, 'protocol_evidence_required');
  for (const input of [null, {}, { probeProfile: 'missing' }]) {
    assert.equal(normalize.resolveLegacyConfiguration(input).ok, false);
  }
});

test('legacy generic descriptors match the channels actually written for every learned count', () => {
  for (let count = 1; count <= 8; count++) {
    const input = { probeProfile: 'GENERIC_VWC', sdi12ValueCount: count };
    const descriptor = normalize.resolveLegacyConfiguration(input);
    const actual = normalize.normalize({ data_sum: '+10'.repeat(count) }, input, {});
    assert.deepEqual(descriptor.channels.map(c => c.key), Object.keys(actual.channels));
    assert.equal(descriptor.expected_values, count);
  }
  for (const count of [undefined, 0, 9, 3.5, '3']) {
    const descriptor = normalize.resolveLegacyConfiguration({ probeProfile: 'GENERIC_VWC', sdi12ValueCount: count });
    assert.equal(descriptor.expected_values, null);
    assert.equal(descriptor.channels.length, 8);
  }
});

test('legacy generic depth metadata preserves the save route domain independently of candidate depths', () => {
  const result = normalize.resolveLegacyConfiguration({ probeProfile: 'GENERIC_VWC', sdi12ValueCount: 8,
    depths: { vwc_1: 0, vwc_2: 12.5, vwc_3: 500, vwc_4: -1, vwc_5: 500.1, vwc_6: '30', vwc_7: Infinity } });
  assert.deepEqual(result.channels.map(c => c.depth_cm), [0, 12.5, 500, null, null, null, null, null]);
  const sentek = normalize.resolveLegacyConfiguration({ probeProfile: 'SENTEK_ENVIROSCAN',
    sdi12ChannelLayout: { version: 1, address: 'L', sensors: [
      { channel: 1, response_position: 1, depth_cm: 600, type: 'ENVIROSCAN' },
    ] } });
  assert.equal(sentek.channels[0].depth_cm, 600);
});

function sample(raw, config = configuration()) {
  return normalize.normalizeConfigured({ data_sum: raw, BatV: 3.3 }, config,
    { recordedAt: '2026-10-03T10:00:00Z' });
}

test('TEROS calibrated ADC counts become mineral VWC once, with signed temperature and real EC zero', () => {
  const result = sample('+3000-10+0');
  assert.deepEqual(result.channels, { bat_v: 3.3, vwc_1: 46.81, soil_temp_1: -10, soil_ec_1: 0 });
  assert.equal(result.disposition, 'complete');
  assert.deepEqual(result.unknown, {});
  assert.equal(result.recordedAt, '2026-10-03T10:00:00Z');
  assert.equal(result.configuration_hash, normalize.resolveConfiguration(configuration()).configuration_hash);
  const teros11 = sample('+2000-40', configuration('METER_TEROS_11'));
  assert.deepEqual(teros11.channels, { bat_v: 3.3, vwc_1: 8.02, soil_temp_1: -40 });
  assert.equal(teros11.channels.soil_ec_1, undefined);
});

test('PR2 candidate variants accept exactly their percent channels including zero', () => {
  for (const [id, raw, expected] of [
    ['DELTAT_PR2_4', '+0+20+30+100', { vwc_1: 0, vwc_2: 20, vwc_3: 30, vwc_4: 100 }],
    ['DELTAT_PR2_6', '+0+20+30+40+50+60', { vwc_1: 0, vwc_2: 20, vwc_3: 30, vwc_4: 40, vwc_5: 50, vwc_6: 60 }],
  ]) {
    assert.deepEqual(sample(raw, configuration(id)).channels, { bat_v: 3.3, ...expected });
    assert.equal(sample(raw + '+7', configuration(id)).disposition, 'quarantined');
  }
});

test('Tensiomark variant 1 pF and temperature retain the documented range without clipping', () => {
  for (const [raw, expected] of [['+0+20', 0.1], ['+2.48+20', 30.2], ['+4+20', 1000], ['+7+20', 1000000]]) {
    const result = sample(raw, configuration('TENSIOMARK'));
    assert.equal(result.disposition, 'complete');
    assert.equal(result.channels.swt_1, expected);
  }
  const hpa = sample('+2.5+20', configuration('TENSIOMARK', { settings: { source_unit: 'hPa', variant: '1' } }));
  assert.equal(hpa.unknown.sdi12_configuration, 'protocol_evidence_required');
  assert.deepEqual(hpa.channels, { bat_v: 3.3 });
  for (const temp of [-40, 80]) {
    const result = sample('+4' + (temp < 0 ? temp : '+' + temp), configuration('TENSIOMARK'));
    assert.equal(result.disposition, 'complete');
    assert.equal(result.channels.soil_temp_1, temp);
  }
});

test('isolated PR2 and TEROS VWC range failures retain valid channels with partial diagnostics', () => {
  for (const raw of ['+1780+20+0', '+0+20+0', '+4000+20+0']) {
    const result = sample(raw);
    assert.equal(result.disposition, 'partial');
    assert.deepEqual(result.channels, { bat_v: 3.3, soil_temp_1: 20, soil_ec_1: 0 });
    assert.ok(Object.hasOwn(result.unknown, 'vwc_1:out_of_range'));
  }
  for (let position = 0; position < 4; position++) {
    const values = [20, 30, 40, 50];
    values[position] = -7;
    const result = sample(values.map(v => v < 0 ? String(v) : '+' + v).join(''), configuration('DELTAT_PR2_4'));
    assert.equal(result.disposition, 'partial');
    assert.equal(result.channels['vwc_' + (position + 1)], undefined);
    assert.equal(Object.keys(result.channels).length, 4);
    assert.equal(result.unknown['vwc_' + (position + 1) + ':out_of_range'], -7);
  }
  assert.equal(sample('-1-2-3-4', configuration('DELTAT_PR2_4')).disposition, 'quarantined');
});

test('candidate validation rejects whole vectors before any plausible channel is released', () => {
  const cases = [
    [configuration(), '+3000+61+0'], [configuration(), '+3000-41+0'],
    [configuration(), '+3000+20-1'], [configuration(), '+3000+20+20001'],
    [configuration(), '+1780-9999+0'], [configuration(), '-9999+61+0'],
    [configuration(), '+1780+20-9992'], [configuration(), '+1780+20-9991'],
    [configuration(), '+1780+61+0'], [configuration(), '+1780+20-1'],
    [configuration(), '+3000+20'], [configuration(), '+3000+20+0+1'],
    [configuration(), '0+3000+20+0'], [configuration(), '+3000+20NULL+0'],
    [configuration('TENSIOMARK'), '-9999+20'], [configuration('TENSIOMARK'), '+7.01+20'],
    [configuration('TENSIOMARK'), '-0.01+20'], [configuration('TENSIOMARK'), '+4+80.01'],
    [configuration('TENSIOMARK'), '+4-40.01'],
    [configuration('TENSIOMARK'), '+' + '9'.repeat(400) + '+20'],
    [configuration('DELTAT_PR2_4'), '+20+30+' + '9'.repeat(400) + '+40'],
  ];
  for (const sentinel of [-9999, -9992, -9991]) {
    for (let position = 0; position < 3; position++) {
      const values = [3000, 20, 0];
      values[position] = sentinel;
      cases.push([configuration(), values.map(value => value < 0 ? String(value) : '+' + value).join('')]);
    }
  }
  for (const [config, raw] of cases) {
    const result = sample(raw, config);
    assert.equal(result.disposition, 'quarantined', raw);
    assert.deepEqual(result.channels, { bat_v: 3.3 }, raw);
    assert.ok(Object.keys(result.unknown).length > 0, raw);
    assert.equal(result.noResponse, false, raw);
  }
});

test('configuration errors are visible even without a response; no-response is not a measured zero', () => {
  for (const raw of ['', '  ', 'NULL']) {
    const result = sample(raw);
    assert.equal(result.disposition, 'no_response');
    assert.equal(result.noResponse, true);
    assert.deepEqual(result.channels, { bat_v: 3.3 });
    assert.deepEqual(result.unknown, {});
    const bad = sample(raw, configuration('UNKNOWN'));
    assert.equal(bad.disposition, 'quarantined');
    assert.equal(bad.configuration_hash, null);
    assert.equal(bad.unknown.sdi12_configuration, 'unknown_profile');
  }
  const noBattery = normalize.normalizeConfigured({ data_sum: '+3000+20+0', BatV: NaN }, configuration(), {});
  assert.equal(noBattery.channels.bat_v, undefined);
});
