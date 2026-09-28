'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const c = require('./conversion');

// Bench calibration, node E605002000000001, 2026-09-25 (spec section 11).
const CAL = {
  pullup_1_ohm: 41670, pulldown_1_ohm: 41260, series_fwd_1_ohm: 130, series_rev_1_ohm: 112,
  pullup_2_ohm: 42530, pulldown_2_ohm: 42070, series_fwd_2_ohm: 46, series_rev_2_ohm: 27,
  sync_version: 3
};
// Firmware golden frame (LoRa_STM32 watermark/tests/test_core.c).
const GOLDEN = Buffer.from('A2030CE404E209290220080008000800080021FFFFFFFF08000800', 'hex');

const w = (v) => [(v >> 8) & 255, v & 255];
function frame(p1, p2, { soil = 1988, status = 2, flags1 = 0x20, flags2 = 0x20 } = {}) {
  return [0xA2, 3, ...w(3300), ...w(soil & 0xffff), ...w(2146), status,
    flags1, ...w(p1[0]), ...w(p1[0]), ...w(p1[1]), ...w(p1[1]),
    flags2, ...w(p2[0]), ...w(p2[0]), ...w(p2[1]), ...w(p2[1])];
}
function convert(p1, p2, opts, cal = CAL) {
  const parsed = c.parseProfile3(frame(p1, p2, opts));
  assert.equal(parsed.ok, true, parsed.reason);
  return c.convertFrame(parsed.frame, cal).channels;
}
const pick = (ch) => ({ status: ch.status, r: ch.r_solved, bound: ch.r_upper_bound, kpa: ch.kpa, kpaBound: ch.kpa_upper_bound });

describe('parseProfile3', () => {
  it('decodes the firmware golden frame', () => {
    const p = c.parseProfile3(GOLDEN);
    assert.equal(p.ok, true);
    assert.deepEqual(
      { supply: p.frame.supply_mv, soil: p.frame.soil_temp_c, die: p.frame.die_temp_c, source: p.frame.soil_temp_source },
      { supply: 3300, soil: 12.5, die: 23.45, source: 2 }
    );
    assert.deepEqual(p.frame.probes[0], { flags: 0x20, fwd_early: 2048, fwd: 2048, rev_early: 2048, rev: 2048 });
    assert.deepEqual(p.frame.probes[1], { flags: 0x21, fwd_early: 0xFFFF, fwd: 0xFFFF, rev_early: 2048, rev: 2048 });
  });

  for (const [name, mutate, reason] of [
    ['short frame', (b) => b.slice(0, 26), 'length'],
    ['long frame', (b) => [...b, 0], 'length'],
    ['wrong tag', (b) => { b[0] = 0xA1; return b; }, 'tag'],
    ['old profile 2', (b) => { b[1] = 2; return b; }, 'profile'],
    ['reserved status bit', (b) => { b[8] |= 0x10; return b; }, 'reserved_status_bits'],
    ['reserved source 3', (b) => { b[8] = 0x03; return b; }, 'reserved_source'],
    ['reserved flag bit on probe 2', (b) => { b[18] |= 0x40; return b; }, 'reserved_flag_bits']
  ]) {
    it('rejects ' + name, () => {
      assert.deepEqual(c.parseProfile3(mutate([...GOLDEN])), { ok: false, reason });
    });
  }

  it('rejects missing input', () => {
    assert.deepEqual(c.parseProfile3(null), { ok: false, reason: 'length' });
  });
});

describe('convertFrame with the bench calibration (spec section 11)', () => {
  it('open probes', () => {
    assert.deepEqual(convert([4093, 2], [4093, 2]).map((ch) => ch.status), ['open', 'open']);
  });
  it('wire shorts', () => {
    const [a, b] = convert([12, 4085], [4, 4093]);
    assert.deepEqual([pick(a), pick(b)], [
      { status: 'short', r: -9, bound: null, kpa: null, kpaBound: null },
      { status: 'short', r: -5, bound: null, kpa: null, kpaBound: null }
    ]);
  });
  it('resistor sweep recovers the meter values within 0.6 %', () => {
    const cases = [[[108, 3987], [99, 3999], 1002, 995], [[800, 3291], [781, 3308], 9977, 9979], [[1716, 2369], [1694, 2391], 29938, 29958]];
    for (const [p1, p2, r1, r2] of cases) {
      const [a, b] = convert(p1, p2);
      assert.deepEqual([a.r_solved, b.r_solved], [r1, r2]);
      assert.ok(Math.abs(a.offset_mv) <= 1 && Math.abs(b.offset_mv) <= 1);
    }
  });
  it('tension at 19.88 C (IRROMETER 200SS)', () => {
    const [a] = convert([800, 3291], [4093, 2]);
    assert.deepEqual(pick(a), { status: 'ok', r: 9977, bound: null, kpa: 56.4, kpaBound: null });
  });
  it('WM2 in water is saturated at 0 kPa with a small offset', () => {
    const [, b] = convert([4093, 2], [71, 4058]);
    assert.deepEqual(pick(b), { status: 'saturated', r: 529, bound: null, kpa: 0, kpaBound: null });
    assert.equal(b.offset_mv, 13.4);
  });
  it('WM1 in water: reverse clipped -> wet with an upper bound', () => {
    const [a] = convert([276, 4095], [4093, 2]);
    assert.deepEqual(pick(a), { status: 'wet_offset_clipped', r: null, bound: 1325, kpa: null, kpaBound: 11.2 });
    assert.ok(a.offset_mv >= 110);
  });
  it('WM1 swapped: forward clipped at 0 is a wet probe, not a short', () => {
    const [a] = convert([0, 3826], [4093, 2]);
    assert.deepEqual(pick(a), { status: 'wet_offset_clipped', r: null, bound: 1287, kpa: null, kpaBound: 11 });
  });
  it('clipped with a bound inside the saturated band reads 0 kPa', () => {
    const [a] = convert([110, 4095], [4093, 2]);
    assert.equal(a.status, 'saturated');
    assert.equal(a.kpa, 0);
    assert.ok(a.r_upper_bound <= 550 && a.r_upper_bound >= 300);
  });
  it('clipped with a bound below 300 ohm is a suspected short', () => {
    const [a] = convert([5, 4095], [4093, 2]);
    assert.equal(a.status, 'short_suspected');
    assert.equal(a.kpa, null);
  });
});

describe('clip bound and rail boundaries (external review 2026-09-26)', () => {
  it('the tension bound covers the 8 kOhm segment drop at warm temperatures', () => {
    const [a] = convert([1411, 4095], [4093, 2], { soil: 5000 });
    assert.deepEqual(pick(a), { status: 'wet_offset_clipped', r: null, bound: 8502, kpa: null, kpaBound: 93.2 });
    assert.equal(c.tensionFromResistance(8502, 50).kpa, 78.2);
    assert.equal(c.tensionUpperBound(8502, 50), 93.2);
    assert.equal(c.tensionUpperBound(1325, 19.88), 11.2);
    assert.equal(c.tensionUpperBound(250000, 20), null);
  });
  it('one code below the rail gives an exact value continuous with the rail bound', () => {
    const [atRail] = convert([276, 4095], [4093, 2]);
    const [belowRail] = convert([276, 4094], [4093, 2]);
    assert.deepEqual(pick(belowRail), { status: 'ok', r: 1331, bound: null, kpa: 11.2, kpaBound: null });
    assert.equal(atRail.kpa_upper_bound, belowRail.kpa);
    const [fwdAboveRail] = convert([1, 3826], [4093, 2]);
    assert.deepEqual(pick(fwdAboveRail), { status: 'ok', r: 1293, bound: null, kpa: 11, kpaBound: null });
  });
});

describe('flags, calibration and temperature', () => {
  it('untrusted flags and invalid samples', () => {
    for (const f of [0x21, 0x22, 0x28, 0x30]) {
      assert.equal(convert([800, 3291], [4093, 2], { flags1: f })[0].status, 'invalid_sample');
    }
    const golden = c.convertFrame(c.parseProfile3(GOLDEN).frame, CAL).channels[1];
    assert.equal(golden.status, 'invalid_sample');
  });
  it('unsettled keeps resistance, withholds kPa unless saturated', () => {
    const [a, b] = convert([800, 3291], [71, 4058], { flags1: 0x24, flags2: 0x24 });
    assert.deepEqual([a.status, a.r_solved, a.kpa], ['unsettled', 9977, null]);
    assert.deepEqual([b.status, b.kpa], ['saturated', 0]);
  });
  it('no calibration, deleted calibration, invalid calibration', () => {
    assert.equal(convert([800, 3291], [4093, 2], {}, null)[0].status, 'calibration_required');
    assert.equal(convert([800, 3291], [4093, 2], {}, { ...CAL, deleted_at: '2026-09-25T00:00:00Z' })[0].status, 'calibration_required');
    assert.equal(convert([800, 3291], [4093, 2], {}, { ...CAL, pullup_1_ohm: 1000 })[0].status, 'calibration_required');
  });
  it('provenance comes from the status bits, not the value', () => {
    assert.equal(convert([800, 3291], [4093, 2], { soil: 1250, status: 1 })[0].status, 'temperature_missing');
    const measured = convert([800, 3291], [4093, 2], { soil: 1250, status: 2 })[0];
    assert.equal(measured.status, 'ok');
    assert.equal(measured.kpa, 47.9);
  });
  it('failed DS18B20, sentinel and out-of-range temperature', () => {
    assert.equal(convert([800, 3291], [4093, 2], { status: 0x06 })[0].status, 'temperature_missing');
    assert.equal(convert([800, 3291], [4093, 2], { soil: -32768 })[0].status, 'temperature_missing');
    assert.equal(convert([800, 3291], [4093, 2], { soil: 5100 })[0].status, 'temperature_out_of_range');
    assert.equal(convert([800, 3291], [4093, 2], { soil: -100 })[0].status, 'temperature_out_of_range');
  });
  it('records calibration and conversion versions', () => {
    const r = c.convertFrame(c.parseProfile3(frame([800, 3291], [4093, 2])).frame, CAL);
    assert.deepEqual([r.calibration_sync_version, r.conversion_version], [3, 'wm-lsn50-p3-v1']);
  });
});

describe('tensionFromResistance (node-neutral)', () => {
  it('bands and range', () => {
    assert.deepEqual(c.tensionFromResistance(299, 20), { kpa: null, status: 'short' });
    assert.deepEqual(c.tensionFromResistance(550, 20), { kpa: 0, status: 'saturated' });
    assert.deepEqual(c.tensionFromResistance(10000, 20), { kpa: 56.7, status: 'ok' });
    assert.deepEqual(c.tensionFromResistance(80000, 20), { kpa: null, status: 'outside_200ss_range' });
    assert.deepEqual(c.tensionFromResistance(10000, null), { kpa: null, status: 'temperature_missing' });
  });
});
