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

test('transforms: pf_to_kpa and hpa_to_kpa with swt clamp', () => {
  const r = m.normalize({ BatV: 3.3, data_sum: '+2.48+21.5' }, { probeProfile: 'TENSIOMARK' }, {});
  assert.strictEqual(r.channels.swt_1, 30.2);        // 10^2.48/10 rounded to 2dp
  assert.strictEqual(r.channels.soil_temp_1, 21.5);
  assert.strictEqual(r.channels.bat_v, 3.3);
  const dry = m.normalize({ BatV: 3.3, data_sum: '+7.0+21.5' }, { probeProfile: 'TENSIOMARK' }, {});
  assert.strictEqual(dry.channels.swt_1, 300);       // pF 7 clamps to 300 kPa
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
