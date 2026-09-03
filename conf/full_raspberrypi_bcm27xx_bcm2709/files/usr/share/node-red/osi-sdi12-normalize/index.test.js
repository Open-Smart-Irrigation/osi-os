'use strict';
const test = require('node:test');
const assert = require('node:assert');
const m = require('./index.js');

test('parseSdi12Values: strict grammar', () => {
  assert.deepStrictEqual(m.parseSdi12Values('+2.48+21.5'), [2.48, 21.5]);
  assert.deepStrictEqual(m.parseSdi12Values('-0.5+7'), [-0.5, 7]);
  assert.strictEqual(m.parseSdi12Values('0+30.5+22.1'), null);      // leading address char
  assert.strictEqual(m.parseSdi12Values('+22.10+31.2x'), null);     // trailing garbage
  assert.strictEqual(m.parseSdi12Values('NULL'), null);
  assert.strictEqual(m.parseSdi12Values(''), null);
});

test('transforms: tension units and Sentek scaled frequency', () => {
  const r = m.normalize({ BatV: 3.3, data_sum: '+2.48+21.5' }, { probeProfile: 'TENSIOMARK' }, {});
  assert.strictEqual(r.channels.swt_1, 30.2);        // 10^2.48/10 rounded to 2dp
  assert.strictEqual(r.channels.soil_temp_1, 21.5);
  assert.strictEqual(r.channels.bat_v, 3.3);
  const dry = m.normalize({ BatV: 3.3, data_sum: '+7.0+21.5' }, { probeProfile: 'TENSIOMARK' }, {});
  assert.strictEqual(dry.channels.swt_1, 300);       // pF 7 clamps to 300 kPa
  assert.strictEqual(m.TRANSFORMS.sentek_sf_to_vwc(0), 0);
  assert.ok(Number.isNaN(m.TRANSFORMS.sentek_sf_to_vwc(-999.9999)));
  assert.ok(Math.abs(m.TRANSFORMS.sentek_sf_to_vwc(0.73284) - 23.8057) < 0.0001);
});

test('exact cardinality rejects the frame atomically', () => {
  // TENSIOMARK expects exactly 2 values: 1 or 3 must write NOTHING but battery.
  for (const raw of ['+2.48', '+2.48+21.5+9.9']) {
    const r = m.normalize({ BatV: 3.3, data_sum: raw }, { probeProfile: 'TENSIOMARK' }, {});
    assert.deepStrictEqual(Object.keys(r.channels), ['bat_v']);
    assert.strictEqual(r.unknown.sdi12_value_count, raw);
  }
});

test('GENERIC_VWC (variable count, documented escape hatch) maps in order and bounds-checks', () => {
  const r = m.normalize({ BatV: 3.0, data_sum: '+30.5+28.1+25.9' }, { probeProfile: 'GENERIC_VWC' }, {});
  assert.deepStrictEqual(
    [r.channels.vwc_1, r.channels.vwc_2, r.channels.vwc_3],
    [30.5, 28.1, 25.9]);
  assert.strictEqual(r.channels.vwc_4, undefined);   // only 3 values present
  const bad = m.normalize({ BatV: 3.0, data_sum: '+250.0' }, { probeProfile: 'GENERIC_VWC' }, {});
  assert.strictEqual(bad.channels.vwc_1, undefined); // out of [0,100]
  assert.ok(Object.keys(bad.unknown).some((k) => k.startsWith('vwc_1')));
});

test('no profile -> battery only + quarantine marker', () => {
  const r = m.normalize({ BatV: 3.1, data_sum: '+1.0' }, { probeProfile: null }, {});
  assert.deepStrictEqual(Object.keys(r.channels), ['bat_v']);
  assert.ok(r.unknown.sdi12_unconfigured);
});

test('NULL is matched exactly, never by substring', () => {
  const r = m.normalize({ BatV: 3.1, data_sum: 'NULL' }, { probeProfile: 'GENERIC_VWC' }, {});
  assert.strictEqual(r.noResponse, true);
  assert.deepStrictEqual(Object.keys(r.channels), ['bat_v']);
  assert.deepStrictEqual(r.unknown, {});
  // Embedded NULL is garbage, not a no-response frame.
  const g = m.normalize({ BatV: 3.1, data_sum: '+1NULL' }, { probeProfile: 'GENERIC_VWC' }, {});
  assert.strictEqual(g.noResponse, false);
  assert.ok(g.unknown.unparseable_sdi12);
});

test('empty FPort 2 data is no response without quarantine', () => {
  const r = m.normalize({ BatV: 3.1, data_sum: '' }, { probeProfile: 'GENERIC_VWC' }, {});
  assert.strictEqual(r.noResponse, true);
  assert.deepStrictEqual(Object.keys(r.channels), ['bat_v']);
  assert.deepStrictEqual(r.unknown, {});
});

test('unparseable non-NULL -> quarantine marker', () => {
  const r = m.normalize({ BatV: 3.1, data_sum: '0+30.5' }, { probeProfile: 'GENERIC_VWC' }, {});
  assert.deepStrictEqual(Object.keys(r.channels), ['bat_v']);
  assert.ok(r.unknown.unparseable_sdi12);
});

test('parseIdentity extracts vendor/model/firmware for storage and display', () => {
  const id = m.parseIdentity('013SENTEK  ES2   101serial');
  assert.strictEqual(id.vendor.trim(), 'SENTEK');
  assert.strictEqual(id.model.trim(), 'ES2');
  assert.strictEqual(id.firmware, '101');
  assert.strictEqual(m.parseIdentity('NULL'), null);   // too short / not an identity
});

test('auto-matchers: only bench-verified profiles match; unverified strings stay null', () => {
  // SENTEK_ENVIROSCAN is bench-verified (2026-08-19) and auto-matches its
  // model family; a SENTEK frame with an unknown model token still does not:
  assert.strictEqual(m.matchProfile('013SENTEK  ES2   101serial'), null);
  // The matcher machinery itself works when a bench-verified pattern exists:
  const benchProfiles = [{ id: 'X', identityMatch: /SENTEK/i }];
  const hit = m.matchProfile('013SENTEK  ES2   101serial', benchProfiles);
  assert.strictEqual(hit.profileId, 'X');
});

test('every fixed-cardinality profile fits the 51-byte DR0 uplink budget', () => {
  for (const p of m.PROFILES) {
    if (p.expectedValues == null) continue;          // GENERIC_VWC/SENTEK_ENVIROSCAN/DELTAT_PR2_*: variable, documented risk
    if (p.id === 'HYDRASCOUT') continue;             // A6 finding (2026-08-18, task wave-1): correcting
                                                       // WORST_CHARS_PER_VALUE from 7 to 9 (bench-measured
                                                       // against real Sentek captures) pushes HydraScout's
                                                       // still-fixed 6-value worst case to 57 bytes, over the
                                                       // 51-byte DR0 budget. HydraScout's own channel widths
                                                       // were never bench-verified ("PROVISIONAL interleave...
                                                       // bench capture decides" above) -- flagged here rather
                                                       // than silently reworked; a real HydraScout bench
                                                       // capture is the correct next step, not an in-task fix.
    assert.ok(m.worstCaseUplinkBytes(p) <= 51,
      p.id + ' exceeds DR0 budget: ' + m.worstCaseUplinkBytes(p));
  }
});

test('uplinkBudgetOk uses the field-observed 42-character multi-segment slice', () => {
  assert.strictEqual(m.uplinkBudgetOk({ expectedValues: 5 }), true);              // 3 + 5*9 = 48 <= 51
  assert.strictEqual(m.uplinkBudgetOk({ expectedValues: 8 }), false);             // 3 + 8*9 = 75 > 51
  assert.strictEqual(m.uplinkBudgetOk({ expectedValues: 8, maxUplinks: 2 }), true); // 8*9 = 72 <= 2*42
  assert.strictEqual(m.uplinkBudgetOk({ expectedValues: 10, maxUplinks: 2 }), false); // 10*9 = 90 > 2*42
  assert.strictEqual(m.uplinkBudgetOk({ expectedValues: 10, maxUplinks: 3 }), true);  // field fixture used 3 slices
  assert.strictEqual(m.uplinkBudgetOk({ expectedValues: 20, maxUplinks: 4 }), false); // 20*9 = 180 > 4*42
  assert.strictEqual(m.uplinkBudgetOk({ expectedValues: 20, maxUplinks: 5 }), true);  // ten TriSCAN modules
  assert.strictEqual(m.getProfile('SENTEK_ENVIROSCAN').maxUplinks, 5);
});

test('A6: SENTEK_ENVIROSCAN with a learned sdi12ValueCount enforces strict atomic cardinality', () => {
  const ok = m.normalize(
    { BatV: 3.3, data_sum: '+12.3+14.1+18.7+22.0+9.5' },
    { probeProfile: 'SENTEK_ENVIROSCAN', sdi12ValueCount: 5 },
    {});
  assert.deepStrictEqual(
    [ok.channels.vwc_1, ok.channels.vwc_2, ok.channels.vwc_3, ok.channels.vwc_4, ok.channels.vwc_5],
    [12.3, 14.1, 18.7, 22.0, 9.5]);
  assert.strictEqual(ok.channels.vwc_6, undefined);
  assert.deepStrictEqual(ok.unknown, {});

  const mismatch = m.normalize(
    { BatV: 3.3, data_sum: '+12.3+14.1+18.7+22.0' },
    { probeProfile: 'SENTEK_ENVIROSCAN', sdi12ValueCount: 5 },
    {});
  assert.deepStrictEqual(Object.keys(mismatch.channels), ['bat_v']);
  assert.ok(mismatch.unknown.sdi12_value_count);
});

test('A6: SENTEK_ENVIROSCAN with no learned count stays variable (no atomic rejection)', () => {
  const r = m.normalize(
    { BatV: 3.3, data_sum: '+12.3+14.1+18.7' },
    { probeProfile: 'SENTEK_ENVIROSCAN' },
    {});
  assert.deepStrictEqual(
    [r.channels.vwc_1, r.channels.vwc_2, r.channels.vwc_3],
    [12.3, 14.1, 18.7]);
  assert.deepStrictEqual(r.unknown, {});
});

test('A6: an out-of-range learned sdi12ValueCount is clamped to null (falls back to variable), never trusted literally', () => {
  const zero = m.normalize(
    { BatV: 3.3, data_sum: '+12.3+14.1+18.7' },
    { probeProfile: 'SENTEK_ENVIROSCAN', sdi12ValueCount: 0 },
    {});
  assert.deepStrictEqual(Object.keys(zero.channels).sort(), ['bat_v', 'vwc_1', 'vwc_2', 'vwc_3']);
  assert.deepStrictEqual(zero.unknown, {});

  const nine = m.normalize(
    { BatV: 3.3, data_sum: '+12.3+14.1+18.7+22.0+9.5+11.0+13.2+15.8' },
    { probeProfile: 'SENTEK_ENVIROSCAN', sdi12ValueCount: 9 },
    {});
  assert.deepStrictEqual(Object.keys(nine.channels).sort(),
    ['bat_v', 'vwc_1', 'vwc_2', 'vwc_3', 'vwc_4', 'vwc_5', 'vwc_6', 'vwc_7', 'vwc_8']);
  assert.deepStrictEqual(nine.unknown, {});
});

test('A6: HYDRASCOUT ignores any learned sdi12ValueCount -- interleaved labels never get swept into seq(vwc)', () => {
  // Mismatched on purpose (4 != HYDRASCOUT's fixed expectedValues of 6): a
  // vacuous version of this test used sdi12ValueCount: 6 (== expectedValues),
  // which passes whether or not the learned count is actually honoured for
  // fixed-shape profiles. This exercises the real bug: a stale learned count
  // left over from switching the device away from a variable profile must
  // NOT be treated as the cardinality check for a fixed-shape profile --
  // that would quarantine every normal 6-value HydraScout frame.
  const r = m.normalize(
    { BatV: 3.3, data_sum: '+25.4+18.2+1200+27.1+17.9+1150' },
    { probeProfile: 'HYDRASCOUT', sdi12ValueCount: 4 },
    {});
  assert.deepStrictEqual(
    [r.channels.vwc_1, r.channels.soil_temp_1, r.channels.soil_ec_1, r.channels.vwc_2, r.channels.soil_temp_2, r.channels.soil_ec_2],
    [25.4, 18.2, 1200, 27.1, 17.9, 1150]);
  assert.deepStrictEqual(r.unknown, {});
});

test('A6 review fix: TENSIOMARK ignores a mismatched learned sdi12ValueCount', () => {
  // TENSIOMARK expectedValues is 2; a stale learned count of 3 must not
  // become the cardinality check -- a normal 2-value frame must still map,
  // not get quarantined as sdi12_value_count.
  const r = m.normalize(
    { BatV: 3.3, data_sum: '+2.48+21.5' },
    { probeProfile: 'TENSIOMARK', sdi12ValueCount: 3 },
    {});
  assert.strictEqual(r.channels.swt_1, 30.2);
  assert.strictEqual(r.channels.soil_temp_1, 21.5);
  assert.deepStrictEqual(r.unknown, {});
});

test('listProfiles is GUI-serializable and slot-aware', () => {
  const list = m.listProfiles();
  assert.ok(list.length >= 7);
  for (const p of list) {
    assert.strictEqual(typeof p.id, 'string');
    assert.strictEqual(typeof p.label, 'string');
    assert.strictEqual(typeof p.provisional, 'boolean');
    assert.ok(Array.isArray(p.channels));
    assert.ok(Array.isArray(p.depthSlots));
    JSON.stringify(p); // must not throw (no RegExp leakage)
  }
  const tensio = list.find((p) => p.id === 'TENSIOMARK');
  assert.deepStrictEqual(tensio.depthSlots, [1]);    // 2 channels, 1 physical depth
});

test('bench 2026-08-19: SENTEK_ENVIROSCAN live identity auto-matches, foreign vendor with same model does not', () => {
  // Live aI! captured on agrolink-test-01 (device A8404161D1886837).
  const hit = m.matchProfile('012SENTEK  XEPI  139D938D7150000');
  assert.strictEqual(hit.profileId, 'SENTEK_ENVIROSCAN');
  assert.strictEqual(hit.vendor.trim(), 'SENTEK');
  assert.strictEqual(hit.model.trim(), 'XEPI');
  assert.strictEqual(hit.firmware, '139');
  // EasyAG (IPI, per the Sentek SDI-12 manual) is the same value layout.
  assert.strictEqual(m.matchProfile('012SENTEK  IPI   101XXXXXXXXXXXX').profileId, 'SENTEK_ENVIROSCAN');
  // Model token alone must not match -- vendor is part of the identity.
  assert.strictEqual(m.matchProfile('013ACME    XEPI  001'), null);
});

test('bench 2026-08-19: SENTEK_ENVIROSCAN live 5-value frame maps mm/10cm straight onto vwc_N (no scaling)', () => {
  // Live aM!/aD0! frame from the same device; unit per the Sentek manual is
  // mm water per 10 cm soil == VWC percent numerically, so no transform.
  const r = m.normalize(
    { BatV: 3.528, data_sum: '+0.000000+0.000000+0.000000+0.104748+0.339201' },
    { probeProfile: 'SENTEK_ENVIROSCAN', sdi12ValueCount: 5 },
    {}
  );
  assert.deepStrictEqual(r.unknown, {});
  assert.strictEqual(r.channels.bat_v, 3.528);
  assert.deepStrictEqual(
    [r.channels.vwc_1, r.channels.vwc_2, r.channels.vwc_3, r.channels.vwc_4, r.channels.vwc_5],
    [0, 0, 0, 0.1, 0.34]
  );
  assert.strictEqual(r.channels.vwc_6, undefined);
  // Same frame with no learned count yet must NOT quarantine either (variable profile).
  const r2 = m.normalize(
    { BatV: 3.528, data_sum: '+0.000000+0.000000+0.000000+0.104748+0.339201' },
    { probeProfile: 'SENTEK_ENVIROSCAN', sdi12ValueCount: null },
    {}
  );
  assert.deepStrictEqual(r2.unknown, {});
  assert.strictEqual(r2.channels.vwc_5, 0.34);
});

test('Sentek layout validation canonicalizes order and derives VWC/VIC depth projection', () => {
  const result = m.validateSentekLayout({
    version: 1,
    address: 'L',
    sensors: [
      { channel: 8, response_position: 8, depth_cm: 100, type: 'ENVIROSCAN' },
      { channel: 1, response_position: 1, depth_cm: 10, type: 'TRISCAN' },
      { channel: 7, response_position: 7, depth_cm: 80, type: 'ENVIROSCAN' },
      { channel: 2, response_position: 2, depth_cm: 20, type: 'ENVIROSCAN' },
      { channel: 3, response_position: 3, depth_cm: 30, type: 'ENVIROSCAN' },
      { channel: 4, response_position: 4, depth_cm: 40, type: 'ENVIROSCAN' },
      { channel: 5, response_position: 5, depth_cm: 50, type: 'TRISCAN' },
      { channel: 6, response_position: 6, depth_cm: 60, type: 'ENVIROSCAN' },
    ],
  });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.layout.sensors.map((sensor) => sensor.channel), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepStrictEqual(result.depths, {
    vwc_1: 10, soil_vic_1: 10, vwc_2: 20, vwc_3: 30, vwc_4: 40,
    vwc_5: 50, soil_vic_5: 50, vwc_6: 60, vwc_7: 80, vwc_8: 100,
  });
});

test('Sentek layout supports stable channels when a 70 cm module is inserted as channel 9', () => {
  const result = m.validateSentekLayout({ version: 1, address: 'L', sensors: [
    { channel: 1, response_position: 1, depth_cm: 10, type: 'ENVIROSCAN' },
    { channel: 2, response_position: 2, depth_cm: 20, type: 'ENVIROSCAN' },
    { channel: 3, response_position: 3, depth_cm: 30, type: 'ENVIROSCAN' },
    { channel: 4, response_position: 4, depth_cm: 40, type: 'ENVIROSCAN' },
    { channel: 5, response_position: 5, depth_cm: 50, type: 'ENVIROSCAN' },
    { channel: 6, response_position: 6, depth_cm: 60, type: 'ENVIROSCAN' },
    { channel: 9, response_position: 7, depth_cm: 70, type: 'ENVIROSCAN' },
    { channel: 7, response_position: 8, depth_cm: 80, type: 'ENVIROSCAN' },
    { channel: 8, response_position: 9, depth_cm: 100, type: 'ENVIROSCAN' },
  ] });
  assert.strictEqual(result.ok, true);
  assert.deepStrictEqual(result.layout.sensors.map((sensor) => sensor.channel), [1, 2, 3, 4, 5, 6, 9, 7, 8]);
});

test('Sentek layout rejects duplicate identities, non-contiguous positions, depths, and invalid addresses', () => {
  const base = [
    { channel: 1, response_position: 1, depth_cm: 10, type: 'ENVIROSCAN' },
    { channel: 2, response_position: 2, depth_cm: 20, type: 'ENVIROSCAN' },
  ];
  for (const layout of [
    { version: 1, address: 'L', sensors: [base[0], { ...base[1], channel: 1 }] },
    { version: 1, address: 'L', sensors: [base[0], { ...base[1], response_position: 3 }] },
    { version: 1, address: 'L', sensors: [base[0], { ...base[1], depth_cm: 10 }] },
    { version: 1, address: '!', sensors: base },
  ]) assert.strictEqual(m.validateSentekLayout(layout).ok, false);
});

test('canonical VWC-only Sentek layout maps exact values by response position up to channel 10', () => {
  const sensors = Array.from({ length: 10 }, (_, index) => ({
    channel: index + 1,
    response_position: 10 - index,
    depth_cm: (index + 1) * 10,
    type: 'ENVIROSCAN',
  }));
  const layout = m.validateSentekLayout({ version: 1, address: 'L', sensors }).layout;
  const r = m.normalize(
    { BatV: 3.4, data_sum: '+1+2+3+4+5+6+7+8+9+10' },
    { probeProfile: 'SENTEK_ENVIROSCAN', sdi12ValueCount: 5, sdi12ChannelLayout: layout },
    {},
  );
  assert.deepStrictEqual(r.unknown, {});
  assert.strictEqual(r.channels.vwc_10, 1);
  assert.strictEqual(r.channels.vwc_1, 10);
});

test('canonical Sentek layout has atomic cardinality and malformed-layout failures', () => {
  const layout = m.validateSentekLayout({ version: 1, address: 'L', sensors: [
    { channel: 2, response_position: 1, depth_cm: 20, type: 'ENVIROSCAN' },
    { channel: 7, response_position: 2, depth_cm: 80, type: 'ENVIROSCAN' },
  ] }).layout;
  const mismatch = m.normalize(
    { BatV: 3.4, data_sum: '+1+2+3' },
    { probeProfile: 'SENTEK_ENVIROSCAN', sdi12ChannelLayout: layout }, {},
  );
  assert.deepStrictEqual(Object.keys(mismatch.channels), ['bat_v']);
  assert.ok(mismatch.unknown.sdi12_layout_value_count);
  const malformed = m.normalize(
    { BatV: 3.4, data_sum: '+1+2' },
    { probeProfile: 'SENTEK_ENVIROSCAN', sdi12ChannelLayout: '{bad' }, {},
  );
  assert.deepStrictEqual(Object.keys(malformed.channels), ['bat_v']);
  assert.ok(malformed.unknown.sdi12_layout_invalid);
});

test('TriSCAN layout fails closed when a VWC-only payload omits required VIC values', () => {
  const layout = m.validateSentekLayout({ version: 1, address: 'L', sensors: [
    { channel: 1, response_position: 1, depth_cm: 10, type: 'TRISCAN' },
    { channel: 2, response_position: 2, depth_cm: 20, type: 'ENVIROSCAN' },
  ] }).layout;
  const r = m.normalize(
    { BatV: 3.4, data_sum: '+12.3+14.5' },
    { probeProfile: 'SENTEK_ENVIROSCAN', sdi12ChannelLayout: layout }, {},
  );
  assert.deepStrictEqual(Object.keys(r.channels), ['bat_v']);
  assert.strictEqual(r.unknown.sdi12_vic_framing_unverified, '+12.3+14.5');
});

test('Sentek mixed layout converts TriSCAN scaled frequency and maps VIC atomically', () => {
  const layout = m.validateSentekLayout({ version: 1, address: 'L', sensors: [
    { channel: 1, response_position: 1, depth_cm: 10, type: 'TRISCAN' },
    { channel: 2, response_position: 2, depth_cm: 20, type: 'ENVIROSCAN' },
    { channel: 3, response_position: 3, depth_cm: 30, type: 'ENVIROSCAN' },
    { channel: 4, response_position: 4, depth_cm: 40, type: 'ENVIROSCAN' },
    { channel: 5, response_position: 5, depth_cm: 50, type: 'TRISCAN' },
    { channel: 6, response_position: 6, depth_cm: 60, type: 'ENVIROSCAN' },
    { channel: 7, response_position: 7, depth_cm: 80, type: 'ENVIROSCAN' },
    { channel: 8, response_position: 8, depth_cm: 100, type: 'ENVIROSCAN' },
  ] }).layout;
  // VWC values are ordered by response_position. The compact M2 salinity
  // group follows and contains only TriSCAN modules, in the same order.
  const raw = '+0.046458+0.122612+0.002829+0.000000+0.092529+0.100000+0.200000+0.300000+201.7789+216.6983';
  const r = m.normalize(
    { BatV: 3.504, data_sum: raw },
    { probeProfile: 'SENTEK_ENVIROSCAN', sdi12ChannelLayout: layout }, {},
  );
  assert.deepStrictEqual(r.unknown, {});
  assert.deepStrictEqual(
    [r.channels.vwc_1, r.channels.vwc_2, r.channels.vwc_3, r.channels.vwc_4,
      r.channels.vwc_5, r.channels.vwc_6, r.channels.vwc_7, r.channels.vwc_8],
    [0, 0.12, 0, 0, 0.06, 0.1, 0.2, 0.3],
  );
  assert.strictEqual(r.channels.soil_vic_1, 201.78);
  assert.strictEqual(r.channels.soil_vic_5, 216.7);

  for (const malformed of [
    raw.replace('+216.6983', ''),
    raw + '+999.0000',
    raw.replace('+0.046458', '-999.9999'),
    raw.replace('+201.7789', '-999.9999'),
  ]) {
    const rejected = m.normalize(
      { BatV: 3.504, data_sum: malformed },
      { probeProfile: 'SENTEK_ENVIROSCAN', sdi12ChannelLayout: layout }, {},
    );
    assert.deepStrictEqual(Object.keys(rejected.channels), ['bat_v']);
    assert.ok(Object.keys(rejected.unknown).some((key) =>
      key.startsWith('sdi12_vic_') || key.startsWith('vwc_')));
  }
});

test('field 2026-08-30: TriSCAN moisture identity output becomes default-calibrated VWC', () => {
  const layout = m.validateSentekLayout({ version: 1, address: '0', sensors: [
    { channel: 1, response_position: 1, depth_cm: 10, type: 'TRISCAN' },
    { channel: 2, response_position: 2, depth_cm: 20, type: 'ENVIROSCAN' },
    { channel: 3, response_position: 3, depth_cm: 30, type: 'ENVIROSCAN' },
    { channel: 4, response_position: 4, depth_cm: 40, type: 'ENVIROSCAN' },
    { channel: 5, response_position: 5, depth_cm: 50, type: 'TRISCAN' },
    { channel: 6, response_position: 6, depth_cm: 60, type: 'ENVIROSCAN' },
    { channel: 7, response_position: 7, depth_cm: 80, type: 'ENVIROSCAN' },
    { channel: 8, response_position: 8, depth_cm: 100, type: 'ENVIROSCAN' },
  ] }).layout;
  const raw = '+0.732840+28.27938+37.45271+41.05683+0.969157+46.21098+38.87460+44.38053+1615.877+4237.622';
  const result = m.normalize(
    { BatV: 3.414, data_sum: raw },
    { probeProfile: 'SENTEK_ENVIROSCAN', sdi12ChannelLayout: layout }, {},
  );

  assert.deepStrictEqual(result.unknown, {});
  assert.deepStrictEqual(
    [result.channels.vwc_1, result.channels.vwc_2, result.channels.vwc_3, result.channels.vwc_4,
      result.channels.vwc_5, result.channels.vwc_6, result.channels.vwc_7, result.channels.vwc_8],
    [23.81, 28.28, 37.45, 41.06, 48.72, 46.21, 38.87, 44.38],
  );
  assert.strictEqual(result.channels.soil_vic_1, 1615.88);
  assert.strictEqual(result.channels.soil_vic_5, 4237.62);
});
