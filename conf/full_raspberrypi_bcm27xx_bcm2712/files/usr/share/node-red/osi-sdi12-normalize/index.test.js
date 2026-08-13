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

test('v1 ships no auto-matchers; matchProfile works only with bench-enabled patterns', () => {
  // Every shipped profile is provisional with identityMatch null:
  assert.strictEqual(m.matchProfile('013SENTEK  ES2   101serial'), null);
  // The matcher machinery itself works when a bench-verified pattern exists:
  const benchProfiles = [{ id: 'X', identityMatch: /SENTEK/i }];
  const hit = m.matchProfile('013SENTEK  ES2   101serial', benchProfiles);
  assert.strictEqual(hit.profileId, 'X');
});

test('every fixed-cardinality profile fits the 51-byte DR0 uplink budget', () => {
  for (const p of m.PROFILES) {
    if (p.expectedValues == null) continue;          // GENERIC_VWC: variable, documented risk
    assert.ok(m.worstCaseUplinkBytes(p) <= 51,
      p.id + ' exceeds DR0 budget: ' + m.worstCaseUplinkBytes(p));
  }
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
