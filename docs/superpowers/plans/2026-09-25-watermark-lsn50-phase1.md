# WATERMARK on the LSN50, Phase 1 (edge) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The edge decodes Dragino LSN50 WATERMARK profile 3 frames (FPort 11), converts them to kPa with an edge-authored calibration and the measured DS18B20 soil temperature, stores raw readings, and shows two probes inside the existing LSN50 card. There is no sync and no scheduler change.

**Architecture:**
- **Logic lives in one new helper module**, `osi-watermark-helper`, with three files:
  - `conversion.js` is pure: frame parsing, the joint resistance/offset solve, IRROMETER 200SS tension.
  - `calibration.js` is the calibration store: validation, optimistic concurrency, tombstone, dry-run preview, first-calibration backfill.
  - `ingest.js` writes one uplink as one `device_data` row plus one `watermark_readings` row, in one transaction.
- **Flow nodes stay thin** (the size ratchet caps new nodes at 4096 chars):
  - `lsn50-decode-fn` hands FPort 11 frames to a new `watermark-ingest-fn` before its timestamp parsing and its stock raw fallback run.
  - One route handler serves `GET` / `PUT` / `DELETE /api/devices/:deveui/watermark/calibration`. It carries the inline flag-off auth prelude, so it has a reviewed size ceiling.
  - The device list gains one JSON column: the WATERMARK reading of the device's latest observation.
  - The scheduler query gets a phase 1 interlock that excludes every WATERMARK observation.
- **GUI:** a node-neutral `WatermarkProbeSection` inside `DraginoTempCard`, and a calibration section in `DraginoSettingsModal`.

**Tech Stack:** Node-RED function nodes (Node 22), SQLite (`node:sqlite` in tests), the `osi-db-helper` facade, React + TypeScript + Vitest, react-i18next.

**Spec:** `docs/superpowers/specs/2026-09-25-watermark-lsn50-design.md` (read §2 decisions, §4 frame, §5 conversion, §6 phase 1, §11 tests).

## Global Constraints

- Branch `feat/watermark-lsn50`, worktree `<worktree>`, based on `origin/main` `c5bc18314`. Never push; never merge; never touch a gateway.
- Code names are fully qualified `watermark_*` / `WATERMARK_*` (`watermark_calibrations`, `watermark_readings`, `osi-watermark-helper`), never a bare `watermark` identifier (spec D3). GUI labels say "WATERMARK".
- `conversion_version` = `wm-lsn50-p3-v1`.
- Calibration limits: pull-ups and pull-downs 25 000–65 000 Ω; series 0–500 Ω.
- kPa only from a measured DS18B20 temperature: source 2, bit 2 clear, not `-32768`, 0–50 °C (spec D9).
- `device_data.bat_v` stays null for profile 3 rows (D10). `ext_temperature_c` = measured DS18B20 regardless of `temp_enabled`.
- FPort 2 behaviour (stock LSN50, Chameleon V1/V2) must stay byte-identical.
- **Scheduler:** the only change is the phase 1 interlock (Task 6). It stops WATERMARK observations from reaching the scheduler even if the device still has `chameleon_enabled = 1`, including backfilled rows. Phase 3 replaces it with the explicit enable.
- No sync triggers, no contract change, no osi-server change in this phase.
- **Auth:** with `OSI_SCOPED_ACCESS` unset, no code path may reach `osiLib.require('scope')` (`scripts/verify-auth-flag-off-hermetic.js`, in CI). In scoped mode, writes trust `scoped-device-config-guard`, which has already verified bearer, role and device access; the owner filter `devices.user_id` applies only in legacy mode. Reads in scoped mode are account-wide (the `s2120-zones-get-fn` pattern).
- **Size ratchet:** allowances are evaluated **per profile**, not summed across the two mirrors. Measure each profile's growth, new nodes included, and write the per-profile figure.
- The migration is `0061` (written as `0060`; renumbered at integration because the RAK10701 field tester owns `0060`). Do not edit the frozen boot node `sync-init-fn`. Do not add a `devices` column.
- **Flows editing:** load `.claude/skills/osi-flows-json-editing/SKILL.md` before the first flows task.
  - Edit `flows.json` with a Node script: `JSON.parse`, mutate, `JSON.stringify(flows, null, 2) + '\n'`.
  - Prove a no-op roundtrip byte-identical first.
  - Apply the same mutation to `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`. Both profiles must stay byte-identical (`node scripts/verify-profile-parity.js`).
- **Pi 4 mirror:** every file created or changed under `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/` (helper, codec) or `…/etc/uci-defaults/98_osi_node_red_seed` is copied byte-for-byte to the `bcm2709` tree in the same commit.
- **Frontend:** never run two builds at once (the workstation OOMs). Run `npm run build` once, in the last task.
- Commit after every task with a conventional message. Do not amend.

## Review Focus

Inputs and failure modes the spec implies but no task would otherwise test. Each has a test in the owning task.

1. **A stock or Chameleon uplink on FPort 2 after this change**, which should be unchanged: same `formattedData`, and nothing reaches `watermark-ingest-fn`. Owner: Task 5.
2. **An FPort 11 uplink with an unparseable `data.time`.** Today `new Date(x).toISOString()` throws there and the frame is dropped. A WATERMARK frame should still be ingested, with the device writer's clamped time in both rows. Owner: Task 5 (flow) and Task 3 (helper).
3. **A profile 3 frame from a DevEUI that has no `devices` row**, where ingest should skip it cleanly: no rows (`device_data` has a foreign key to `devices`), no throw, `reason: 'unknown_device'`, and calibration answers 404. Owner: Task 3.
4. **A board swapped from WATERMARK back to Chameleon firmware** (or any later non-WATERMARK observation), where the device list should report no WATERMARK data, so no card section appears and no old WATERMARK fault hides a healthy Chameleon channel. Owner: Task 8.
5. **A calibration write by a viewer, by another user in legacy mode, or by an assigned researcher in scoped mode**, where the first two should get 403 or 404 and change nothing, and the researcher should succeed. Owner: Task 7 (guard → handler chain) and Task 3 (store access).

---

### Task 1: Conversion core and helper registration

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/package.json`
- Create: `…/osi-watermark-helper/conversion.js`
- Create: `…/osi-watermark-helper/index.js`
- Test: `…/osi-watermark-helper/conversion.test.js`
- Modify: `…/node-red/package.json`, `…/node-red/package-lock.json`, `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/98_osi_node_red_seed`, `deploy.sh`, `…/node-red/osi-lib/index.js`, `…/node-red/osi-lib/index.test.js`, `.github/workflows/migrations.yml`
- Mirror: the same paths under `conf/full_raspberrypi_bcm27xx_bcm2709/`

(`…/node-red` = `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red`.)

**Interfaces:**
- Produces (from `conversion.js`, re-exported by `index.js`):
  - constants `CONVERSION_VERSION` (string) and `CALIBRATION_LIMITS` (`{pull:{min,max}, series:{min,max}}`);
  - `tensionFromResistance(ohm:number, soilTempC:number|null) → {kpa:number|null, status:string}`;
  - `tensionUpperBound(ohm:number, soilTempC:number) → number|null`: the largest tension any resistance in [0, ohm] can have. It covers the relation's drop at the 8 kΩ segment edge, and is used for `kpa_upper_bound`;
  - `parseProfile3(bytes:ArrayLike<number>) → {ok:true, frame} | {ok:false, reason}`, where `frame` = `{tag, profile, supply_mv, soil_temp_c, soil_temp_source, ds18b20_failed, die_temp_c, die_temp_valid, status_byte, probes:[{flags, fwd_early, fwd, rev_early, rev} ×2]}`;
  - `resistanceFromCodes(fwd, rev, {pullup, pulldown, seriesFwd, seriesRev}, supplyMv) → {r_fwd, r_rev, r, offset_mv}`;
  - `convertChannel(probe, cal|null, temperature, supplyMv)`;
  - `convertFrame(frame, calibrationRow|null) → {conversion_version, calibration_sync_version, soil_temp_for_conversion_c, channels:[ch,ch]}`, where `ch` = `{flags, fwd_early, fwd, rev_early, rev, r_fwd, r_rev, r_solved, offset_mv, r_upper_bound, kpa_upper_bound, status, kpa}`;
  - `channelCalibration(row, n)`.
- The calibration row uses the column names `pullup_N_ohm`, `pulldown_N_ohm`, `series_fwd_N_ohm`, `series_rev_N_ohm` (N = 1, 2), plus `sync_version` and `deleted_at`.

- [ ] **Step 1: Write the failing test.** Create `…/osi-watermark-helper/conversion.test.js` with exactly:

```js
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
  it('resistor sweep recovers the meter values within 0.3 %', () => {
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
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/conversion.test.js`
Expected: FAIL, `Cannot find module './conversion'`.

- [ ] **Step 3: Implement.** Create `conversion.js`:

```js
'use strict';

// WATERMARK 200SS conversion. Two layers:
//  - node-neutral: tensionFromResistance (any 200SS, any node type)
//  - LSN50 profile 3 front end: parseProfile3, resistanceFromCodes, convertFrame
// Spec: docs/superpowers/specs/2026-09-25-watermark-lsn50-design.md sections 4-5.

var CONVERSION_VERSION = 'wm-lsn50-p3-v1';
var FRAME_BYTES = 27;
var FRAME_TAG = 0xA2;
var FRAME_PROFILE = 3;
var ADC_FULL = 4095;
var INVALID_CODE = 0xFFFF;
var TEMP_UNKNOWN = -32768;
var FLAG_UNSETTLED = 0x04;
var FLAGS_UNTRUSTED = 0x1B; // ADC 0x01, timing 0x02, setup 0x08, charge imbalance 0x10
var FLAGS_RESERVED = 0xC0;
var OPEN_FWD_MIN = 4087;
var OPEN_REV_MAX = 8;
var SHORT_BELOW_OHM = 300;
var SATURATED_MAX_OHM = 550;
var SOURCE_DS18B20 = 2;

var CALIBRATION_LIMITS = {
  pull: { min: 25000, max: 65000 },
  series: { min: 0, max: 500 }
};

function tensionFromResistance(ohm, soilTempC) {
  if (typeof ohm !== 'number' || !isFinite(ohm)) return { kpa: null, status: 'invalid_sample' };
  if (typeof soilTempC !== 'number' || !isFinite(soilTempC)) return { kpa: null, status: 'temperature_missing' };
  if (soilTempC < 0 || soilTempC > 50) return { kpa: null, status: 'temperature_out_of_range' };
  if (ohm < SHORT_BELOW_OHM) return { kpa: null, status: 'short' };
  if (ohm <= SATURATED_MAX_OHM) return { kpa: 0, status: 'saturated' };
  var r = ohm / 1000;
  var td = 1 + 0.018 * (soilTempC - 24);
  var kpa;
  // IRROMETER 200SS (Shock et al. 1998), 1 kPa = 1 centibar, positive tension.
  if (ohm <= 1000) kpa = (23.156 * r - 12.736) * td;
  else if (ohm <= 8000) kpa = (3.213 * r + 4.093) / (1 - 0.009733 * r - 0.01205 * soilTempC);
  else kpa = 2.246 + 5.239 * r * td + 0.06756 * r * r * td * td;
  if (!(kpa >= 0 && kpa <= 200)) return { kpa: null, status: 'outside_200ss_range' };
  return { kpa: Math.round(kpa * 10) / 10, status: 'ok' };
}

// Largest tension any resistance in [0, ohm] can have. The 200SS relation is
// not monotonic across its 8 kOhm segment boundary at warm temperatures (at
// 50 C it drops from 93 to 73 kPa there), so the tension at the bound alone
// can understate it. Null when the bound itself is outside the sensor range.
function tensionUpperBound(ohm, soilTempC) {
  var atBound = tensionFromResistance(ohm, soilTempC).kpa;
  if (atBound === null) return null;
  if (ohm <= 8000) return atBound;
  var atSegmentEdge = tensionFromResistance(8000, soilTempC).kpa;
  return atSegmentEdge !== null && atSegmentEdge > atBound ? atSegmentEdge : atBound;
}

function word(b, i) { return (b[i] << 8) | b[i + 1]; }
function int16(v) { return v & 0x8000 ? v - 0x10000 : v; }

function parseProbe(b, offset) {
  return {
    flags: b[offset],
    fwd_early: word(b, offset + 1), fwd: word(b, offset + 3),
    rev_early: word(b, offset + 5), rev: word(b, offset + 7)
  };
}

function parseProfile3(bytes) {
  if (!bytes || bytes.length !== FRAME_BYTES) return { ok: false, reason: 'length' };
  var b = bytes;
  if (b[0] !== FRAME_TAG) return { ok: false, reason: 'tag' };
  if (b[1] !== FRAME_PROFILE) return { ok: false, reason: 'profile' };
  var status = b[8];
  if (status & 0xF0) return { ok: false, reason: 'reserved_status_bits' };
  if ((status & 0x03) === 0x03) return { ok: false, reason: 'reserved_source' };
  if ((b[9] & FLAGS_RESERVED) || (b[18] & FLAGS_RESERVED)) return { ok: false, reason: 'reserved_flag_bits' };
  var soil = int16(word(b, 4));
  var die = int16(word(b, 6));
  return {
    ok: true,
    frame: {
      tag: b[0], profile: b[1], supply_mv: word(b, 2),
      soil_temp_c: soil === TEMP_UNKNOWN ? null : soil / 100,
      soil_temp_source: status & 0x03,
      ds18b20_failed: (status & 0x04) !== 0,
      die_temp_c: die === TEMP_UNKNOWN ? null : die / 100,
      die_temp_valid: (status & 0x08) === 0,
      status_byte: status,
      probes: [parseProbe(b, 9), parseProbe(b, 18)]
    }
  };
}

// Measured soil temperature usable for conversion, or a status saying why not.
function conversionTemperature(frame) {
  var t = frame.soil_temp_c;
  if (frame.soil_temp_source !== SOURCE_DS18B20 || frame.ds18b20_failed || t === null) {
    return { value: null, status: 'temperature_missing' };
  }
  if (t < 0 || t > 50) return { value: null, status: 'temperature_out_of_range' };
  return { value: t, status: null };
}

function channelCalibration(row, channel) {
  if (!row || row.deleted_at) return null;
  var n = channel;
  var cal = {
    pullup: Number(row['pullup_' + n + '_ohm']),
    pulldown: Number(row['pulldown_' + n + '_ohm']),
    seriesFwd: Number(row['series_fwd_' + n + '_ohm']),
    seriesRev: Number(row['series_rev_' + n + '_ohm'])
  };
  return validChannelCalibration(cal) ? cal : null;
}

function inRange(v, lim) { return typeof v === 'number' && isFinite(v) && v >= lim.min && v <= lim.max; }

function validChannelCalibration(cal) {
  return inRange(cal.pullup, CALIBRATION_LIMITS.pull) && inRange(cal.pulldown, CALIBRATION_LIMITS.pull) &&
    inRange(cal.seriesFwd, CALIBRATION_LIMITS.series) && inRange(cal.seriesRev, CALIBRATION_LIMITS.series);
}

// Joint solve for probe resistance R and electrode offset e (spec 5.1).
// With a code at its rail the same expression is an upper bound on R.
function resistanceFromCodes(fwd, rev, cal, supplyMv) {
  var xf = fwd / ADC_FULL;
  var xr = rev / ADC_FULL;
  var af = (1 - xf) / cal.pullup;
  var ar = xr / cal.pulldown;
  var r = (xf + 1 - xr - af * cal.seriesFwd - ar * cal.seriesRev) / (af + ar);
  var e = xf - af * (r + cal.seriesFwd);
  return {
    r_fwd: xf < 1 ? cal.pullup * xf / (1 - xf) - cal.seriesFwd : null,
    r_rev: xr > 0 ? cal.pulldown * (1 - xr) / xr - cal.seriesRev : null,
    r: r,
    offset_mv: typeof supplyMv === 'number' && supplyMv > 0 ? e * supplyMv : null
  };
}

function roundTo(v, decimals) {
  if (v === null || v === undefined) return null;
  var f = Math.pow(10, decimals);
  return Math.round(v * f) / f;
}

function emptyChannel(status, probe) {
  return {
    flags: probe.flags, fwd_early: probe.fwd_early, fwd: probe.fwd, rev_early: probe.rev_early, rev: probe.rev,
    r_fwd: null, r_rev: null, r_solved: null, offset_mv: null, r_upper_bound: null, kpa_upper_bound: null,
    status: status, kpa: null
  };
}

function convertChannel(probe, cal, temperature, supplyMv) {
  var codes = [probe.fwd_early, probe.fwd, probe.rev_early, probe.rev];
  if ((probe.flags & FLAGS_UNTRUSTED) || codes.indexOf(INVALID_CODE) !== -1 ||
      codes.some(function (c) { return c > ADC_FULL; })) {
    return emptyChannel('invalid_sample', probe);
  }
  if (probe.fwd >= OPEN_FWD_MIN || probe.rev <= OPEN_REV_MAX) return emptyChannel('open', probe);
  if (!cal) return emptyChannel('calibration_required', probe);

  var out = emptyChannel(null, probe);
  var solved = resistanceFromCodes(probe.fwd, probe.rev, cal, supplyMv);
  out.r_fwd = roundTo(solved.r_fwd, 0);
  out.r_rev = roundTo(solved.r_rev, 0);
  out.offset_mv = roundTo(solved.offset_mv, 1);

  var clipped = probe.rev === ADC_FULL || probe.fwd === 0;
  if (clipped) {
    out.r_upper_bound = roundTo(solved.r, 0);
    if (solved.r < SHORT_BELOW_OHM) { out.status = 'short_suspected'; return out; }
    if (solved.r > SATURATED_MAX_OHM) {
      out.status = 'wet_offset_clipped';
      if (temperature.value !== null) out.kpa_upper_bound = tensionUpperBound(solved.r, temperature.value);
      return out;
    }
    // Bound within the saturated band: fall through as a saturated reading.
  } else {
    out.r_solved = roundTo(solved.r, 0);
    if (solved.r < SHORT_BELOW_OHM) { out.status = 'short'; return out; }
    if ((probe.flags & FLAG_UNSETTLED) && solved.r > SATURATED_MAX_OHM) { out.status = 'unsettled'; return out; }
  }
  if (temperature.value === null) { out.status = temperature.status; return out; }
  var t = tensionFromResistance(clipped ? SATURATED_MAX_OHM : solved.r, temperature.value);
  out.status = t.status;
  out.kpa = t.kpa;
  return out;
}

function convertFrame(frame, calibrationRow) {
  var temperature = conversionTemperature(frame);
  var channels = [1, 2].map(function (n) {
    return convertChannel(frame.probes[n - 1], channelCalibration(calibrationRow, n), temperature, frame.supply_mv);
  });
  return {
    conversion_version: CONVERSION_VERSION,
    calibration_sync_version: calibrationRow && !calibrationRow.deleted_at ? calibrationRow.sync_version : null,
    soil_temp_for_conversion_c: temperature.value,
    channels: channels
  };
}

module.exports = {
  CONVERSION_VERSION: CONVERSION_VERSION,
  CALIBRATION_LIMITS: CALIBRATION_LIMITS,
  tensionFromResistance: tensionFromResistance,
  tensionUpperBound: tensionUpperBound,
  parseProfile3: parseProfile3,
  resistanceFromCodes: resistanceFromCodes,
  convertChannel: convertChannel,
  convertFrame: convertFrame,
  channelCalibration: channelCalibration
};
```

Create `package.json`:

```json
{
  "name": "osi-watermark-helper",
  "version": "1.0.0",
  "private": true,
  "main": "index.js"
}
```

Create `index.js`. For now it re-exports only the conversion module; Task 3 extends it.

```js
'use strict';

const conversion = require('./conversion');

module.exports = Object.assign({}, conversion);
```

- [ ] **Step 4: Run the test and watch it pass.** Same command as Step 2. Expected: `# pass 27`, `# fail 0`.

- [ ] **Step 5: Register the helper.** Follow the pattern of `osi-lsn50-normalize` at every site:

  1. **`…/node-red/package.json`:** add `"osi-watermark-helper": "file:osi-watermark-helper"` to `dependencies`, in alphabetical position.
  2. **`…/node-red/package-lock.json`:** add three entries, each mirroring its `osi-lsn50-normalize` sibling:
     - under `packages[""].dependencies`: `"osi-watermark-helper": "file:osi-watermark-helper"`;
     - under `packages`: `"node_modules/osi-watermark-helper": { "resolved": "osi-watermark-helper", "link": true }`;
     - under `packages`: `"osi-watermark-helper": { "version": "1.0.0" }`.
  3. **`conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/98_osi_node_red_seed`:** append `osi-watermark-helper` to the `for module in …; do` list.
  4. **`deploy.sh`:** next to the `osi-lsn50-normalize` fetch lines, add one `fetch_required` per module file. Later tasks add `calibration.js` and `ingest.js`.
     ```sh
     fetch_required "osi-watermark-helper package.json" \
       "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/package.json" \
       "/srv/node-red/osi-watermark-helper/package.json"
     fetch_required "osi-watermark-helper index.js" \
       "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/index.js" \
       "/srv/node-red/osi-watermark-helper/index.js"
     fetch_required "osi-watermark-helper conversion.js" \
       "conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/conversion.js" \
       "/srv/node-red/osi-watermark-helper/conversion.js"
     ```
  5. **`…/node-red/osi-lib/index.js`:** add `'watermark-helper': 'osi-watermark-helper'` to `NAME_TO_PATH`, and add `'watermark-helper'` to the sorted key list asserted in `…/osi-lib/index.test.js`.
  6. **`.github/workflows/migrations.yml`:** next to the other helper test lines, add:
     `- run: node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/conversion.test.js`
  7. **Pi 4 mirror:** copy the new directory and every changed file under `conf/full_raspberrypi_bcm27xx_bcm2712/` to the same path under `conf/full_raspberrypi_bcm27xx_bcm2709/`.

- [ ] **Step 6: Run the registration verifiers.**

```bash
node scripts/verify-helper-registration.js
node scripts/verify-module-file-deploy-coverage.js
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-lib/index.test.js
node scripts/verify-profile-parity.js
```
Expected: every one exits 0.

- [ ] **Step 7: Commit.**

```bash
git add -A conf deploy.sh .github/workflows/migrations.yml
git commit -m "feat(edge): osi-watermark-helper conversion core for LSN50 WATERMARK profile 3"
```

---

### Task 2: Schema — migration 0061, seed, bundled DBs

**Files:**
- Create: `database/migrations/ordered/0061__watermark_lsn50.sql`
- Modify: `database/migrations/ordered/CHECKSUMS.json`, `database/seed-blank.sql`, and the 7 bundled `farming.db` files (listed in `scripts/seed-db-paths.js`, written by `scripts/build-seed-db.js`)
- Modify: `scripts/verify-db-schema-consistency.js`, `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js`, `scripts/reconcile-ledger-numbering.test.js`

**Interfaces:**
- Produces the tables `watermark_calibrations` and `watermark_readings` exactly as below. Tasks 3, 6, 8 and 9 rely on these column names.
- `watermark_readings.device_data_id` is the exact `device_data.id` of the observation. There is no foreign key, so a later `device_data` retention step cannot fail ingest. Backfill, the scheduler interlock and the device-list join all use it, never `(deveui, recorded_at)`: `device_data` has no UNIQUE on that pair.

- [ ] **Step 1: Write the migration** `database/migrations/ordered/0061__watermark_lsn50.sql`:

```sql
-- risk: additive
-- 0061: WATERMARK 200SS on the Dragino LSN50 (profile 3, FPort 11), phase 1.
-- Edge-local calibration and raw readings; no sync triggers in this phase.

CREATE TABLE watermark_calibrations (
  deveui              TEXT PRIMARY KEY,
  pullup_1_ohm        REAL NOT NULL CHECK (pullup_1_ohm BETWEEN 25000 AND 65000),
  pulldown_1_ohm      REAL NOT NULL CHECK (pulldown_1_ohm BETWEEN 25000 AND 65000),
  series_fwd_1_ohm    REAL NOT NULL CHECK (series_fwd_1_ohm BETWEEN 0 AND 500),
  series_rev_1_ohm    REAL NOT NULL CHECK (series_rev_1_ohm BETWEEN 0 AND 500),
  pullup_2_ohm        REAL NOT NULL CHECK (pullup_2_ohm BETWEEN 25000 AND 65000),
  pulldown_2_ohm      REAL NOT NULL CHECK (pulldown_2_ohm BETWEEN 25000 AND 65000),
  series_fwd_2_ohm    REAL NOT NULL CHECK (series_fwd_2_ohm BETWEEN 0 AND 500),
  series_rev_2_ohm    REAL NOT NULL CHECK (series_rev_2_ohm BETWEEN 0 AND 500),
  measured_at         TEXT,
  method              TEXT,
  worst_residual_pct  REAL,
  notes               TEXT,
  sync_version        INTEGER NOT NULL DEFAULT 1,
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at          TEXT,
  FOREIGN KEY (deveui) REFERENCES devices(deveui) ON DELETE CASCADE
);

CREATE TABLE watermark_readings (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  deveui                   TEXT NOT NULL,
  recorded_at              TEXT NOT NULL,
  f_cnt                    INTEGER,
  device_data_id           INTEGER,
  payload_hex              TEXT NOT NULL,
  frame_status             TEXT NOT NULL CHECK (frame_status IN ('accepted','frame_rejected')),
  reject_reason            TEXT,
  tag                      INTEGER,
  profile                  INTEGER,
  supply_mv                INTEGER,
  soil_temp_c              REAL,
  soil_temp_source         INTEGER,
  die_temp_c               REAL,
  status_byte              INTEGER,
  ch1_flags                INTEGER,
  ch1_fwd_early            INTEGER,
  ch1_fwd                  INTEGER,
  ch1_rev_early            INTEGER,
  ch1_rev                  INTEGER,
  ch1_r_fwd                REAL,
  ch1_r_rev                REAL,
  ch1_r_solved             REAL,
  ch1_offset_mv            REAL,
  ch1_r_upper_bound        REAL,
  ch1_kpa_upper_bound      REAL,
  ch1_status               TEXT,
  ch1_kpa                  REAL,
  ch2_flags                INTEGER,
  ch2_fwd_early            INTEGER,
  ch2_fwd                  INTEGER,
  ch2_rev_early            INTEGER,
  ch2_rev                  INTEGER,
  ch2_r_fwd                REAL,
  ch2_r_rev                REAL,
  ch2_r_solved             REAL,
  ch2_offset_mv            REAL,
  ch2_r_upper_bound        REAL,
  ch2_kpa_upper_bound      REAL,
  ch2_status               TEXT,
  ch2_kpa                  REAL,
  calibration_sync_version INTEGER,
  conversion_version       TEXT NOT NULL,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_watermark_readings_deveui_time ON watermark_readings(deveui, recorded_at);
CREATE INDEX idx_watermark_readings_device_data ON watermark_readings(device_data_id);
```

- [ ] **Step 2: Add the checksum.**

```bash
node -e 'const crypto=require("crypto"),fs=require("fs");const dir="database/migrations/ordered/";const file="0061__watermark_lsn50.sql";
const manifest=JSON.parse(fs.readFileSync(dir+"CHECKSUMS.json","utf8"));
manifest[file]=crypto.createHash("sha256").update(fs.readFileSync(dir+file)).digest("hex");
fs.writeFileSync(dir+"CHECKSUMS.json",JSON.stringify(manifest,null,2)+"\n");'
```

- [ ] **Step 3: Mirror the DDL into `database/seed-blank.sql`.** Place the two `CREATE TABLE` statements and both `CREATE INDEX` statements directly after the `chameleon_readings` block (its indexes end near `idx_chameleon_readings_array_id`). The DDL must be normalized-identical to the migration; copy it verbatim without the `-- risk` header.

- [ ] **Step 4: Extend the hard-coded migration lists.** In `lib/osi-migrate/__tests__/runner-preexisting-add-column-real.test.js`:
  - replace `through 0060` with `through 0061`;
  - append `61` to the applied list `[22, 23, 24, 25, 30, 54, 55, 56, 57, 58, 59, 60]`.

  In `scripts/reconcile-ledger-numbering.test.js`, append `61` to every list ending in `…, 59, 60]`. Precedent: commit `72e25b5ca`, which appended `59` to the same lists.

- [ ] **Step 5: Add both tables to `schemaContract`** in `scripts/verify-db-schema-consistency.js`, next to `chameleon_readings`. Use the exact column lists from Step 1.
  - Add `idx_watermark_readings_deveui_time` and `idx_watermark_readings_device_data` to `requiredIndexes`.
  - Add no trigger fragments.

- [ ] **Step 6: Rebuild the bundled DBs.**

```bash
node scripts/build-seed-db.js
```
Expected: it writes all 7 `farming.db` copies and reports `verifyHead` OK.

- [ ] **Step 7: Run the schema verifiers.**

```bash
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-seed-db-ledger.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-devices-rebuild-fence.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-sqlite-cli-limits.js
node scripts/verify-profile-parity.js
node --test lib/osi-migrate/__tests__/*.test.js
node --test scripts/reconcile-ledger-numbering.test.js
```
Expected: all exit 0. `verify-seed-replay` prints `verify-seed-replay: OK`.

- [ ] **Step 8: Commit.**

```bash
git add -A database scripts lib conf web/react-gui/farming.db
git commit -m "feat(schema): migration 0061 watermark_calibrations + watermark_readings (edge-local)"
```

---

### Task 3: Calibration store and ingest

**Files:**
- Create: `…/osi-watermark-helper/calibration.js`, `…/osi-watermark-helper/ingest.js`
- Modify: `…/osi-watermark-helper/index.js`, `deploy.sh`, `.github/workflows/migrations.yml`
- Test: `…/osi-watermark-helper/store.test.js`
- Mirror: `bcm2709`

**Interfaces:**
- Consumes: Task 1 `conversion.*`; Task 2 tables.
- Produces (re-exported by `index.js`):
  - `validateCalibrationBody(body) → {values, meta, dryRun, expectedSyncVersion}`;
  - `getCalibration(db, {deveui, userId, scoped}) → {deveui, sync_version, calibration|null}`;
  - `saveCalibration(db, {deveui, userId, scoped, body})`:
    - with `body.dry_run === true` → `{deveui, dry_run:true, preview:{recorded_at, channels}|null}`;
    - otherwise → `{deveui, sync_version, calibration, backfilled}`;
  - `deleteCalibration(db, {deveui, userId, scoped, expectedSyncVersion}) → {deveui, sync_version, calibration:null}`;
  - access rule: `scoped === true` → the device only has to exist, be an LSN50 and not be deleted (the caller has already authorized it); otherwise `userId` must be a number (else 401) and own the device (else 404);
  - `backfillPending(tx, deveui, calibrationRow) → number`;
  - `ingestProfile3(db, {deveui, recordedAt, payloadB64, fCnt}, {clampRecordedAt, writeDeviceData(tx, normalizeResult)}) → {accepted, reason?, recordedAt, statuses?}`, where `reason` is a `parseProfile3` reason or `'unknown_device'`.
- Errors are `Error` objects carrying `statusCode` (400/401/404/409), `code` (`unauthorized`, `invalid_body`, `invalid_calibration`, `invalid_expected_sync_version`, `invalid_deveui`, `device_not_found`, `calibration_not_found`, `stale_sync_version`), and optionally `field` and `currentSyncVersion`.
- `db` is the `osi-db-helper` facade: `get`, `all` and `run` return promises, `run` resolves `undefined`, and `transaction(fn)` passes `fn` a scope with the same methods.

- [ ] **Step 1: Write the failing test** `…/osi-watermark-helper/store.test.js`:

```js
'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const NR = path.join(__dirname, '..');
const REPO_ROOT = path.resolve(NR, '../../../../../..');
const SEED_SQL = path.join(REPO_ROOT, 'database', 'seed-blank.sql');
const MIGRATION_SQL = path.join(REPO_ROOT, 'database/migrations/ordered/0061__watermark_lsn50.sql');
const writer = require(path.join(NR, 'osi-device-writer'));
const manifest = JSON.parse(fs.readFileSync(path.join(NR, 'edge-channels.json'), 'utf8'));
const wm = require('.');

const DEVEUI = 'A84041A171000001';
const USER_ID = 1;
const CAL = {
  pullup_1_ohm: 41670, pulldown_1_ohm: 41260, series_fwd_1_ohm: 130, series_rev_1_ohm: 112,
  pullup_2_ohm: 42530, pulldown_2_ohm: 42070, series_fwd_2_ohm: 46, series_rev_2_ohm: 27
};

// osi-db-helper facade shape over node:sqlite: get/all/run promise-returning,
// run() resolves undefined, transaction() gives a scope with the same methods.
function facade(native) {
  const scope = {
    get: async (sql, p) => native.prepare(sql).get(...(p || [])),
    all: async (sql, p) => native.prepare(sql).all(...(p || [])),
    run: async (sql, p) => { native.prepare(sql).run(...(p || [])); return undefined; }
  };
  return Object.assign({}, scope, {
    async transaction(fn) {
      native.exec('BEGIN IMMEDIATE');
      try { const r = await fn(scope); native.exec('COMMIT'); return r; }
      catch (e) { native.exec('ROLLBACK'); throw e; }
    }
  });
}

function freshDb() {
  const native = new DatabaseSync(':memory:');
  native.exec(fs.readFileSync(SEED_SQL, 'utf8'));
  if (!native.prepare("SELECT name FROM sqlite_master WHERE name = 'watermark_readings'").get()) {
    native.exec(fs.readFileSync(MIGRATION_SQL, 'utf8'));
  }
  const now = new Date().toISOString();
  native.prepare("INSERT INTO users (id, username, password_hash, created_at) VALUES (?, 'phil', 'x', ?)").run(USER_ID, now);
  native.prepare("INSERT INTO devices (deveui, name, type_id, user_id, created_at, updated_at) VALUES (?, 'Watermark 1+2', 'DRAGINO_LSN50', ?, ?, ?)").run(DEVEUI, USER_ID, now, now);
  writer.resetColumnCache();
  return { native, db: facade(native) };
}

const w = (v) => [(v >> 8) & 255, v & 255];
function frameB64(p1, p2, { soil = 1988, source = 2 } = {}) {
  return Buffer.from([0xA2, 3, ...w(3300), ...w(soil & 0xffff), ...w(2146), source, 0x20,
    ...w(p1[0]), ...w(p1[0]), ...w(p1[1]), ...w(p1[1]), 0x20,
    ...w(p2[0]), ...w(p2[0]), ...w(p2[1]), ...w(p2[1])]).toString('base64');
}
const deps = {
  clampRecordedAt: writer.clampRecordedAt,
  writeDeviceData: (tx, nr) => writer.writeDeviceData(tx, manifest, nr, { deveui: DEVEUI }, {})
};
function ingestAt(db, iso, payloadB64) {
  return wm.ingestProfile3(db, { deveui: DEVEUI, recordedAt: iso, payloadB64, fCnt: 7 }, deps);
}
const T1 = new Date(Date.now() - 3600e3).toISOString();
const T2 = new Date(Date.now() - 1800e3).toISOString();

describe('ingestProfile3', () => {
  let ctx;
  beforeEach(() => { ctx = freshDb(); });

  it('writes device_data and a raw row; kPa waits for calibration', async () => {
    const res = await ingestAt(ctx.db, T1, frameB64([800, 3291], [71, 4058]));
    assert.equal(res.accepted, true);
    const dd = ctx.native.prepare('SELECT swt_1, swt_2, ext_temperature_c, bat_v FROM device_data WHERE deveui = ?').get(DEVEUI);
    assert.deepEqual({ ...dd }, { swt_1: null, swt_2: null, ext_temperature_c: 19.88, bat_v: null });
    const wr = ctx.native.prepare('SELECT frame_status, ch1_status, ch2_status, supply_mv, recorded_at FROM watermark_readings').get();
    assert.deepEqual({ ...wr }, { frame_status: 'accepted', ch1_status: 'calibration_required', ch2_status: 'calibration_required', supply_mv: 3300, recorded_at: T1 });
  });

  it('converts with a live calibration', async () => {
    await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 0 } });
    await ingestAt(ctx.db, T2, frameB64([800, 3291], [71, 4058]));
    const dd = ctx.native.prepare('SELECT swt_1, swt_2 FROM device_data WHERE deveui = ?').get(DEVEUI);
    assert.deepEqual({ ...dd }, { swt_1: 56.4, swt_2: 0 });
    const wr = ctx.native.prepare('SELECT ch1_r_solved, ch2_status, calibration_sync_version, conversion_version FROM watermark_readings').get();
    assert.deepEqual({ ...wr }, { ch1_r_solved: 9977, ch2_status: 'saturated', calibration_sync_version: 1, conversion_version: 'wm-lsn50-p3-v1' });
  });

  it('keeps a rejected frame as raw only', async () => {
    const bad = Buffer.from(frameB64([800, 3291], [71, 4058]), 'base64'); bad[1] = 2;
    const res = await ingestAt(ctx.db, T1, bad.toString('base64'));
    assert.deepEqual([res.accepted, res.reason], [false, 'profile']);
    assert.equal(ctx.native.prepare('SELECT COUNT(*) AS n FROM device_data').get().n, 0);
    assert.equal(ctx.native.prepare("SELECT frame_status FROM watermark_readings").get().frame_status, 'frame_rejected');
  });

  it('no kPa from the firmware constant temperature', async () => {
    await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 0 } });
    await ingestAt(ctx.db, T1, frameB64([800, 3291], [71, 4058], { soil: 1250, source: 1 }));
    const dd = ctx.native.prepare('SELECT swt_1, ext_temperature_c FROM device_data').get();
    assert.deepEqual({ ...dd }, { swt_1: null, ext_temperature_c: null });
    assert.equal(ctx.native.prepare('SELECT ch1_status FROM watermark_readings').get().ch1_status, 'temperature_missing');
  });
});

describe('review fixes (external review 2026-09-26)', () => {
  let ctx;
  beforeEach(() => { ctx = freshDb(); });

  it('records the exact device_data id of each observation', async () => {
    await ingestAt(ctx.db, T1, frameB64([800, 3291], [71, 4058]));
    const dd = ctx.native.prepare('SELECT id FROM device_data').get();
    const wr = ctx.native.prepare('SELECT device_data_id FROM watermark_readings').get();
    assert.equal(wr.device_data_id, dd.id);
  });

  it('backfill updates by row id, not by timestamp', async () => {
    ctx.native.prepare('INSERT INTO device_data (deveui, recorded_at) VALUES (?, ?)').run(DEVEUI, T1);
    await ingestAt(ctx.db, T1, frameB64([800, 3291], [4093, 2]));
    await ingestAt(ctx.db, T1, frameB64([108, 3987], [4093, 2]));
    await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 0 } });
    const rows = ctx.native.prepare('SELECT swt_1 FROM device_data WHERE deveui = ? ORDER BY id').all(DEVEUI).map((r) => r.swt_1);
    assert.deepEqual(rows, [null, 56.4, 9.7]);
  });

  it('scoped mode trusts the guard: an assigned non-owner can write', async () => {
    const saved = await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: 2, scoped: true, body: { ...CAL, expected_sync_version: 0 } });
    assert.equal(saved.sync_version, 1);
    const got = await wm.getCalibration(ctx.db, { deveui: DEVEUI, scoped: true });
    assert.equal(got.sync_version, 1);
  });

  it('legacy mode needs the owner and an authenticated user', async () => {
    await assert.rejects(wm.getCalibration(ctx.db, { deveui: DEVEUI, userId: 2 }), (e) => e.statusCode === 404);
    await assert.rejects(wm.getCalibration(ctx.db, { deveui: DEVEUI }), (e) => e.statusCode === 401);
  });
});

describe('calibration store', () => {
  let ctx;
  beforeEach(() => { ctx = freshDb(); });

  it('first save backfills waiting readings only', async () => {
    await ingestAt(ctx.db, T1, frameB64([800, 3291], [276, 4095]));
    const saved = await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 0 } });
    assert.deepEqual([saved.sync_version, saved.backfilled], [1, 1]);
    const dd = ctx.native.prepare('SELECT swt_1, swt_2 FROM device_data').get();
    assert.deepEqual({ ...dd }, { swt_1: 56.4, swt_2: null });
    const wr = ctx.native.prepare('SELECT ch1_status, ch2_status, ch2_r_upper_bound, ch2_kpa_upper_bound FROM watermark_readings').get();
    assert.deepEqual({ ...wr }, { ch1_status: 'ok', ch2_status: 'wet_offset_clipped', ch2_r_upper_bound: 1439, ch2_kpa_upper_bound: 11.7 });
  });

  it('recalibration never rewrites converted readings', async () => {
    await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 0 } });
    await ingestAt(ctx.db, T1, frameB64([800, 3291], [71, 4058]));
    const second = await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, pullup_1_ohm: 50000, expected_sync_version: 1 } });
    assert.equal(second.backfilled, 0);
    assert.equal(ctx.native.prepare('SELECT swt_1 FROM device_data').get().swt_1, 56.4);
  });

  it('rejects a stale version with 409 and keeps the newer row', async () => {
    await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 0 } });
    await assert.rejects(
      wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, pullup_1_ohm: 30000, expected_sync_version: 0 } }),
      (e) => e.statusCode === 409 && e.code === 'stale_sync_version' && e.currentSyncVersion === 1
    );
    assert.equal(ctx.native.prepare('SELECT pullup_1_ohm FROM watermark_calibrations').get().pullup_1_ohm, 41670);
  });

  it('refuses out-of-range values and foreign devices', async () => {
    await assert.rejects(wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, series_rev_2_ohm: 501, expected_sync_version: 0 } }),
      (e) => e.statusCode === 400 && e.field === 'series_rev_2_ohm');
    await assert.rejects(wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: 2, body: { ...CAL, expected_sync_version: 0 } }),
      (e) => e.statusCode === 404);
  });

  it('delete writes a tombstone; later frames wait for calibration again', async () => {
    await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 0 } });
    const del = await wm.deleteCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, expectedSyncVersion: '1' });
    assert.equal(del.sync_version, 2);
    const got = await wm.getCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID });
    assert.deepEqual([got.sync_version, got.calibration], [2, null]);
    await ingestAt(ctx.db, T2, frameB64([800, 3291], [71, 4058]));
    assert.equal(ctx.native.prepare('SELECT ch1_status FROM watermark_readings').get().ch1_status, 'calibration_required');
    const again = await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, expected_sync_version: 2 } });
    assert.deepEqual([again.sync_version, again.backfilled], [3, 1]);
  });

  it('dry run previews the latest frame and saves nothing', async () => {
    await ingestAt(ctx.db, T1, frameB64([800, 3291], [71, 4058]));
    const res = await wm.saveCalibration(ctx.db, { deveui: DEVEUI, userId: USER_ID, body: { ...CAL, dry_run: true } });
    assert.equal(res.preview.channels[0].r_solved, 9977);
    assert.equal(res.preview.channels[1].status, 'saturated');
    assert.equal(ctx.native.prepare('SELECT COUNT(*) AS n FROM watermark_calibrations').get().n, 0);
    assert.equal(ctx.native.prepare('SELECT swt_1 FROM device_data').get().swt_1, null);
  });
});
```

Append these three tests inside `describe('ingestProfile3', …)`. They cover Review Focus items 2 and 3.

```js
  it('clamps a garbage timestamp identically in both rows', async () => {
    const res = await ingestAt(ctx.db, 'not-a-date', frameB64([800, 3291], [71, 4058]));
    const dd = ctx.native.prepare('SELECT recorded_at FROM device_data').get().recorded_at;
    const wr = ctx.native.prepare('SELECT recorded_at FROM watermark_readings').get().recorded_at;
    assert.equal(dd, wr);
    assert.equal(res.recordedAt, dd);
  });

  it('skips a DevEUI with no devices row cleanly; calibration refuses it', async () => {
    const res = await wm.ingestProfile3(ctx.db, { deveui: 'A840410000000001', recordedAt: T1, payloadB64: frameB64([800, 3291], [71, 4058]) }, {
      clampRecordedAt: writer.clampRecordedAt,
      writeDeviceData: (tx, nr) => writer.writeDeviceData(tx, manifest, nr, { deveui: 'A840410000000001' }, {})
    });
    assert.deepEqual([res.accepted, res.reason], [false, 'unknown_device']);
    assert.equal(ctx.native.prepare('SELECT COUNT(*) AS n FROM device_data').get().n, 0);
    assert.equal(ctx.native.prepare('SELECT COUNT(*) AS n FROM watermark_readings').get().n, 0);
    await assert.rejects(
      wm.saveCalibration(ctx.db, { deveui: 'A840410000000001', userId: USER_ID, body: { ...CAL, expected_sync_version: 0 } }),
      (e) => e.statusCode === 404
    );
  });

  it('rejects a malformed DevEUI in the store', async () => {
    await assert.rejects(wm.getCalibration(ctx.db, { deveui: 'xyz', userId: USER_ID }), (e) => e.statusCode === 400);
  });
```

- [ ] **Step 2: Run it and watch it fail.**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/store.test.js`
Expected: FAIL, `wm.ingestProfile3 is not a function`.

- [ ] **Step 3: Implement.** Create `calibration.js`:

```js
'use strict';

// Edge-authored WATERMARK calibration: validation, optimistic-concurrency
// writes, tombstone deletes, dry-run preview, first-calibration backfill.
// `db` is the osi-db-helper facade (get/all/run/transaction; run() returns
// undefined). Spec section 6, "Calibration writer" and "Backfill".

const conversion = require('./conversion');

const VALUE_FIELDS = [
  'pullup_1_ohm', 'pulldown_1_ohm', 'series_fwd_1_ohm', 'series_rev_1_ohm',
  'pullup_2_ohm', 'pulldown_2_ohm', 'series_fwd_2_ohm', 'series_rev_2_ohm'
];
const META_FIELDS = ['measured_at', 'method', 'worst_residual_pct', 'notes'];
const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

function httpError(statusCode, code, message, extra) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  if (extra) Object.assign(error, extra);
  return error;
}

function limitFor(field) {
  return field.indexOf('series_') === 0 ? conversion.CALIBRATION_LIMITS.series : conversion.CALIBRATION_LIMITS.pull;
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

function parseExpectedVersion(value) {
  const n = toNumber(value);
  if (!Number.isInteger(n) || n < 0) {
    throw httpError(400, 'invalid_expected_sync_version', 'expected_sync_version must be a non-negative integer');
  }
  return n;
}

function validateCalibrationBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw httpError(400, 'invalid_body', 'Request body must be a JSON object');
  }
  const values = {};
  for (const field of VALUE_FIELDS) {
    const n = toNumber(body[field]);
    const lim = limitFor(field);
    if (!Number.isFinite(n) || n < lim.min || n > lim.max) {
      throw httpError(400, 'invalid_calibration', field + ' must be between ' + lim.min + ' and ' + lim.max + ' ohm', { field });
    }
    values[field] = n;
  }
  const meta = { measured_at: null, method: null, worst_residual_pct: null, notes: null };
  if (body.measured_at != null && body.measured_at !== '') {
    if (!Number.isFinite(Date.parse(String(body.measured_at)))) {
      throw httpError(400, 'invalid_calibration', 'measured_at must be an ISO date', { field: 'measured_at' });
    }
    meta.measured_at = new Date(Date.parse(String(body.measured_at))).toISOString();
  }
  if (body.method != null && body.method !== '') {
    meta.method = String(body.method).slice(0, 64);
  }
  if (body.worst_residual_pct != null && body.worst_residual_pct !== '') {
    const r = toNumber(body.worst_residual_pct);
    if (!Number.isFinite(r) || r < 0 || r > 100) {
      throw httpError(400, 'invalid_calibration', 'worst_residual_pct must be between 0 and 100', { field: 'worst_residual_pct' });
    }
    meta.worst_residual_pct = r;
  }
  if (body.notes != null && body.notes !== '') {
    meta.notes = String(body.notes).slice(0, 500);
  }
  const dryRun = body.dry_run === true;
  const expectedSyncVersion = dryRun ? null : parseExpectedVersion(body.expected_sync_version);
  return { values, meta, dryRun, expectedSyncVersion };
}

// Scoped mode: the caller (scoped-device-config-guard for writes, the
// account-wide read check for GET) has already authorized this device, so no
// owner filter here -- an assigned researcher is not the owner. Legacy mode:
// the device must belong to the authenticated user.
async function assertAccessibleLsn50(db, deveui, access) {
  const scoped = access && access.scoped === true;
  if (!scoped && !Number.isFinite(Number(access && access.userId))) {
    throw httpError(401, 'unauthorized', 'Unauthorized');
  }
  const row = await db.get(
    "SELECT deveui FROM devices WHERE UPPER(deveui) = ? AND type_id = 'DRAGINO_LSN50' AND deleted_at IS NULL" +
      (scoped ? '' : ' AND user_id = ?'),
    scoped ? [deveui] : [deveui, Number(access.userId)]
  );
  if (!row) throw httpError(404, 'device_not_found', 'Device not found');
  return row.deveui;
}

function publicCalibration(row) {
  if (!row || row.deleted_at) return null;
  const out = {};
  for (const f of VALUE_FIELDS.concat(META_FIELDS)) out[f] = row[f] == null ? null : row[f];
  out.updated_at = row.updated_at;
  return out;
}

async function readRow(db, deveui) {
  return db.get('SELECT * FROM watermark_calibrations WHERE deveui = ?', [deveui]);
}

// GET: live calibration (or null) plus the version a writer must quote.
async function getCalibration(db, { deveui, userId, scoped }) {
  const key = await assertAccessibleLsn50(db, normalizeDeveui(deveui), { userId, scoped });
  const row = await readRow(db, key);
  return { deveui: key, sync_version: row ? row.sync_version : 0, calibration: publicCalibration(row) };
}

function normalizeDeveui(deveui) {
  const key = String(deveui || '').trim().toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(key)) throw httpError(400, 'invalid_deveui', 'Invalid device EUI');
  return key;
}

async function latestAcceptedReading(db, deveui) {
  return db.get(
    "SELECT recorded_at, payload_hex FROM watermark_readings WHERE deveui = ? AND frame_status = 'accepted' ORDER BY recorded_at DESC, id DESC LIMIT 1",
    [deveui]
  );
}

function convertStored(payloadHex, calibrationRow) {
  const parsed = conversion.parseProfile3(Buffer.from(String(payloadHex || ''), 'hex'));
  return parsed.ok ? conversion.convertFrame(parsed.frame, calibrationRow) : null;
}

async function saveCalibration(db, { deveui, userId, scoped, body }) {
  const key = normalizeDeveui(deveui);
  const input = validateCalibrationBody(body);
  if (input.dryRun) {
    await assertAccessibleLsn50(db, key, { userId, scoped });
    const latest = await latestAcceptedReading(db, key);
    const converted = latest ? convertStored(latest.payload_hex, Object.assign({ sync_version: null }, input.values)) : null;
    return { deveui: key, dry_run: true, preview: converted ? { recorded_at: latest.recorded_at, channels: converted.channels } : null };
  }
  return db.transaction(async (tx) => {
    await assertAccessibleLsn50(tx, key, { userId, scoped });
    const current = await readRow(tx, key);
    const currentVersion = current ? current.sync_version : 0;
    if (input.expectedSyncVersion !== currentVersion) {
      throw httpError(409, 'stale_sync_version', 'Calibration changed since it was loaded', { currentSyncVersion: currentVersion });
    }
    const cols = VALUE_FIELDS.concat(META_FIELDS);
    const vals = cols.map((c) => (c in input.values ? input.values[c] : input.meta[c]));
    await tx.run(
      'INSERT INTO watermark_calibrations (deveui, ' + cols.join(', ') + ', sync_version, updated_at, deleted_at) ' +
      'VALUES (?, ' + cols.map(() => '?').join(', ') + ', ?, ' + NOW_SQL + ', NULL) ' +
      'ON CONFLICT(deveui) DO UPDATE SET ' + cols.map((c) => c + ' = excluded.' + c).join(', ') +
      ', sync_version = excluded.sync_version, updated_at = excluded.updated_at, deleted_at = NULL',
      [key].concat(vals, [currentVersion + 1])
    );
    const row = await readRow(tx, key);
    const backfilled = await backfillPending(tx, key, row);
    return { deveui: key, sync_version: row.sync_version, calibration: publicCalibration(row), backfilled };
  });
}

async function deleteCalibration(db, { deveui, userId, scoped, expectedSyncVersion }) {
  const key = normalizeDeveui(deveui);
  const expected = parseExpectedVersion(expectedSyncVersion);
  return db.transaction(async (tx) => {
    await assertAccessibleLsn50(tx, key, { userId, scoped });
    const current = await readRow(tx, key);
    if (!current || current.deleted_at) throw httpError(404, 'calibration_not_found', 'No calibration to delete');
    if (current.sync_version !== expected) {
      throw httpError(409, 'stale_sync_version', 'Calibration changed since it was loaded', { currentSyncVersion: current.sync_version });
    }
    await tx.run(
      'UPDATE watermark_calibrations SET deleted_at = ' + NOW_SQL + ', updated_at = ' + NOW_SQL +
      ', sync_version = sync_version + 1 WHERE deveui = ?',
      [key]
    );
    return { deveui: key, sync_version: current.sync_version + 1, calibration: null };
  });
}

const CHANNEL_RESULT_COLUMNS = ['r_fwd', 'r_rev', 'r_solved', 'offset_mv', 'r_upper_bound', 'kpa_upper_bound', 'status', 'kpa'];

// Convert readings that were waiting for a first calibration. Only channels
// whose stored status is 'calibration_required' change; device_data is
// updated in place by row id, and the dirty-history trigger carries the correction to
// the cloud (spec section 3). Readings that already have kPa are never touched.
async function backfillPending(tx, deveui, calibrationRow) {
  const rows = await tx.all(
    "SELECT id, device_data_id, payload_hex, ch1_status, ch2_status FROM watermark_readings " +
    "WHERE deveui = ? AND frame_status = 'accepted' AND (ch1_status = 'calibration_required' OR ch2_status = 'calibration_required') " +
    'ORDER BY recorded_at, id',
    [deveui]
  );
  let converted = 0;
  for (const row of rows) {
    const result = convertStored(row.payload_hex, calibrationRow);
    if (!result) continue;
    for (const n of [1, 2]) {
      if (row['ch' + n + '_status'] !== 'calibration_required') continue;
      const ch = result.channels[n - 1];
      await tx.run(
        'UPDATE watermark_readings SET ' + CHANNEL_RESULT_COLUMNS.map((c) => 'ch' + n + '_' + c + ' = ?').join(', ') +
        ', calibration_sync_version = ?, conversion_version = ? WHERE id = ?',
        CHANNEL_RESULT_COLUMNS.map((c) => ch[c]).concat([result.calibration_sync_version, result.conversion_version, row.id])
      );
      // By row id: device_data has no UNIQUE(deveui, recorded_at), so a
      // timestamp match could hit another observation.
      if (ch.kpa !== null && row.device_data_id !== null) {
        await tx.run(
          'UPDATE device_data SET swt_' + n + ' = ? WHERE id = ? AND deveui = ? AND swt_' + n + ' IS NULL',
          [ch.kpa, row.device_data_id, deveui]
        );
      }
    }
    converted += 1;
  }
  return converted;
}

module.exports = {
  VALUE_FIELDS,
  validateCalibrationBody,
  getCalibration,
  saveCalibration,
  deleteCalibration,
  backfillPending,
  CHANNEL_RESULT_COLUMNS
};
```

Create `ingest.js`:

```js
'use strict';

// One profile 3 uplink -> one device_data row + one watermark_readings row,
// in one transaction. A rejected frame writes only a raw row. Spec section 6,
// "Ingest" and "Writes".

const conversion = require('./conversion');
const { CHANNEL_RESULT_COLUMNS } = require('./calibration');

const PROBE_CODE_COLUMNS = ['flags', 'fwd_early', 'fwd', 'rev_early', 'rev'];

function measuredSoilTemperature(frame) {
  return frame.soil_temp_source === 2 && !frame.ds18b20_failed ? frame.soil_temp_c : null;
}

function readingRow(base, frame, result) {
  const row = Object.assign({}, base, {
    frame_status: 'accepted', reject_reason: null,
    tag: frame.tag, profile: frame.profile, supply_mv: frame.supply_mv,
    soil_temp_c: frame.soil_temp_c, soil_temp_source: frame.soil_temp_source,
    die_temp_c: frame.die_temp_c, status_byte: frame.status_byte,
    calibration_sync_version: result.calibration_sync_version,
    conversion_version: result.conversion_version
  });
  [1, 2].forEach((n) => {
    const ch = result.channels[n - 1];
    PROBE_CODE_COLUMNS.forEach((c) => { row['ch' + n + '_' + c] = ch[c]; });
    CHANNEL_RESULT_COLUMNS.forEach((c) => { row['ch' + n + '_' + c] = ch[c]; });
  });
  return row;
}

async function insertRow(tx, row) {
  const cols = Object.keys(row);
  await tx.run(
    'INSERT INTO watermark_readings (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')',
    cols.map((c) => row[c])
  );
}

// deps.clampRecordedAt: osi-device-writer's clampRecordedAt.
// deps.writeDeviceData(tx, normalizeResult): writes the device_data row on tx.
async function ingestProfile3(db, input, deps) {
  const deveui = String(input.deveui || '').trim().toUpperCase();
  const bytes = Buffer.from(String(input.payloadB64 || ''), 'base64');
  const recordedAt = deps.clampRecordedAt(input.recordedAt).recordedAt;
  const fCnt = Number.isInteger(input.fCnt) ? input.fCnt : null;
  const base = { deveui, recorded_at: recordedAt, f_cnt: fCnt, device_data_id: null, payload_hex: bytes.toString('hex') };
  const parsed = conversion.parseProfile3(bytes);
  return db.transaction(async (tx) => {
    // device_data has a foreign key to devices: a frame from a DevEUI that is
    // not registered in OSI is skipped, not half-written.
    const device = await tx.get('SELECT 1 AS known FROM devices WHERE UPPER(deveui) = ? AND deleted_at IS NULL', [deveui]);
    if (!device) return { accepted: false, reason: 'unknown_device', recordedAt };
    if (!parsed.ok) {
      await insertRow(tx, Object.assign({}, base, {
        frame_status: 'frame_rejected', reject_reason: parsed.reason,
        conversion_version: conversion.CONVERSION_VERSION
      }));
      return { accepted: false, reason: parsed.reason, recordedAt };
    }
    const calibration = await tx.get(
      'SELECT * FROM watermark_calibrations WHERE deveui = ? AND deleted_at IS NULL', [deveui]
    );
    const result = conversion.convertFrame(parsed.frame, calibration || null);
    const written = await deps.writeDeviceData(tx, {
      recordedAt,
      channels: {
        swt_1: result.channels[0].kpa,
        swt_2: result.channels[1].kpa,
        ext_temperature_c: measuredSoilTemperature(parsed.frame)
      },
      unknown: {}
    });
    // Same connection, same transaction, and the writer's INSERT is its last
    // statement: last_insert_rowid() is this observation's device_data id.
    const idRow = written && written.inserted ? await tx.get('SELECT last_insert_rowid() AS id') : null;
    await insertRow(tx, Object.assign(readingRow(base, parsed.frame, result), { device_data_id: idRow ? idRow.id : null }));
    return { accepted: true, recordedAt, statuses: result.channels.map((c) => c.status) };
  });
}

module.exports = { ingestProfile3 };
```

Replace `index.js` with:

```js
'use strict';

const conversion = require('./conversion');
const calibration = require('./calibration');
const ingest = require('./ingest');

module.exports = Object.assign({}, conversion, calibration, ingest);
```

- [ ] **Step 4: Run the tests and watch them pass.**

Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/store.test.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/conversion.test.js`
Expected: all pass (17 store tests, 27 conversion tests).

- [ ] **Step 5: Register the new files.**
  - `deploy.sh`: add `fetch_required` lines for `calibration.js` and `ingest.js`, in the Task 1 format.
  - `.github/workflows/migrations.yml`: add `- run: node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/store.test.js`.
  - Mirror the helper directory to `bcm2709`.

  Run:
  ```bash
  node scripts/verify-module-file-deploy-coverage.js
  node scripts/verify-helper-registration.js
  node scripts/verify-profile-parity.js
  ```
  Expected: all exit 0.

- [ ] **Step 6: Commit.**

```bash
git add -A conf deploy.sh .github/workflows/migrations.yml
git commit -m "feat(edge): WATERMARK calibration store (versioned, tombstone, preview, backfill) and profile 3 ingest"
```

---

### Task 4: Codec FPort 11 branch

**Files:**
- Modify: `…/node-red/codecs/dragino_lsn50_decoder.js` (and its `bcm2709` mirror)
- Create: `scripts/verify-lsn50-watermark-codec.js`
- Modify: `.github/workflows/codecs.yml`

**Interfaces:**
- Consumes: Task 1 `parseProfile3`.
- Produces: `decodeUplink({fPort:11, bytes})`, which returns one of:
  - `.data = {Node_type:'LSN50_WATERMARK', Watermark_Profile:3, Supply_mV, Soil_Temp_C, Soil_Temp_Source, DS18B20_Failed, Die_Temp_C, Die_Temp_Valid, Probe_1, Probe_2}`;
  - `{Watermark_Error: reason}`.

  This output is only for ChirpStack's event view: the edge ignores `data.object` for FPort 11.

- [ ] **Step 1: Write the failing verifier** `scripts/verify-lsn50-watermark-codec.js`:

```js
#!/usr/bin/env node
'use strict';
// Pins the shared LSN50 codec's FPort 11 branch (ChirpStack event view) to the
// edge parser in osi-watermark-helper: same raw fields for accepted frames,
// same reasons for rejected ones. FPort 2 (stock + Chameleon) is pinned by
// verify-lsn50-chameleon-codec.js and must stay untouched.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const NR = path.join(__dirname, '..', 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(NR, 'codecs/dragino_lsn50_decoder.js'), 'utf8'), sandbox);
const { parseProfile3 } = require(path.join(NR, 'osi-watermark-helper/conversion.js'));

const GOLDEN = [...Buffer.from('A2030CE404E209290220080008000800080021FFFFFFFF08000800', 'hex')];
const w = (v) => [(v >> 8) & 255, v & 255];
const bench = (p1, p2, soil, status) => [0xA2, 3, ...w(3300), ...w(soil & 0xffff), ...w(2146), status,
  0x20, ...w(p1[0]), ...w(p1[0]), ...w(p1[1]), ...w(p1[1]),
  0x24, ...w(p2[0]), ...w(p2[0]), ...w(p2[1]), ...w(p2[1])];

const accepted = [GOLDEN, bench([276, 4095], [71, 4058], 1988, 2), bench([0, 3826], [4093, 2], -32768, 0x05)];
for (const bytes of accepted) {
  const out = sandbox.decodeUplink({ fPort: 11, bytes }).data;
  const p = parseProfile3(bytes).frame;
  assert.equal(out.Watermark_Profile, 3);
  assert.equal(out.Supply_mV, p.supply_mv);
  assert.equal(out.Soil_Temp_C, p.soil_temp_c === null ? 'NULL' : p.soil_temp_c);
  assert.equal(out.Soil_Temp_Source, p.soil_temp_source);
  assert.equal(out.DS18B20_Failed, p.ds18b20_failed ? 1 : 0);
  assert.equal(out.Die_Temp_C, p.die_temp_c === null ? 'NULL' : p.die_temp_c);
  assert.deepEqual({ ...out.Probe_1 }, p.probes[0]);
  assert.deepEqual({ ...out.Probe_2 }, p.probes[1]);
}

const rejected = [
  [GOLDEN.slice(0, 26), 'length'],
  [[0xA1, ...GOLDEN.slice(1)], 'tag'],
  [[0xA2, 2, ...GOLDEN.slice(2)], 'profile'],
  [GOLDEN.map((b, i) => (i === 8 ? b | 0x10 : b)), 'reserved_status_bits'],
  [GOLDEN.map((b, i) => (i === 8 ? 0x03 : b)), 'reserved_source'],
  [GOLDEN.map((b, i) => (i === 18 ? b | 0x80 : b)), 'reserved_flag_bits']
];
for (const [bytes, reason] of rejected) {
  assert.deepEqual({ ...sandbox.decodeUplink({ fPort: 11, bytes }).data }, { Watermark_Error: reason });
  assert.deepEqual(parseProfile3(bytes), { ok: false, reason });
}

// Profile 3 bytes on FPort 2 must still take the stock path (no WATERMARK fields).
const onPort2 = sandbox.decodeUplink({ fPort: 2, bytes: GOLDEN }).data || {};
assert.equal(onPort2.Watermark_Profile, undefined);

console.log('verify-lsn50-watermark-codec: OK (' + accepted.length + ' accepted, ' + rejected.length + ' rejected)');
```

- [ ] **Step 2: Run it and watch it fail.** Run: `node scripts/verify-lsn50-watermark-codec.js`. Expected: FAIL, an `AssertionError` on `Watermark_Profile` (`undefined !== 3`).

- [ ] **Step 3: Implement.** The codec is ES5: `var`, `function` and `==` only, no arrows, no `const`.
  - Insert this function immediately before `function Decode(fPort, bytes, variables) {`:

    ```js
// WATERMARK profile 3 (FPort 11): raw fields only, for ChirpStack's event view.
// The edge decodes these bytes itself (osi-watermark-helper parseProfile3);
// scripts/verify-lsn50-watermark-codec.js pins the two to the same answers.
function decodeWatermarkProfile3(bytes) {
  if (!bytes || bytes.length != 27) return { Watermark_Error: "length" };
  if (bytes[0] != 0xA2) return { Watermark_Error: "tag" };
  if (bytes[1] != 3) return { Watermark_Error: "profile" };
  var status = bytes[8];
  if (status & 0xF0) return { Watermark_Error: "reserved_status_bits" };
  if ((status & 0x03) == 0x03) return { Watermark_Error: "reserved_source" };
  if ((bytes[9] & 0xC0) || (bytes[18] & 0xC0)) return { Watermark_Error: "reserved_flag_bits" };
  var soil = readInt16BE(bytes, 4);
  var die = readInt16BE(bytes, 6);
  function probe(o) {
    return {
      flags: bytes[o],
      fwd_early: readUInt16BE(bytes, o + 1),
      fwd: readUInt16BE(bytes, o + 3),
      rev_early: readUInt16BE(bytes, o + 5),
      rev: readUInt16BE(bytes, o + 7)
    };
  }
  return {
    Node_type: "LSN50_WATERMARK",
    Watermark_Profile: 3,
    Supply_mV: readUInt16BE(bytes, 2),
    Soil_Temp_C: soil == -32768 ? "NULL" : soil / 100,
    Soil_Temp_Source: status & 0x03,
    DS18B20_Failed: (status & 0x04) ? 1 : 0,
    Die_Temp_C: die == -32768 ? "NULL" : die / 100,
    Die_Temp_Valid: (status & 0x08) ? 0 : 1,
    Probe_1: probe(9),
    Probe_2: probe(18)
  };
}
    ```

  - Inside `Decode`, after the closing brace of the `else if(fPort==5)` block and before the final `}` of `Decode`, add:

    ```js

      else if(fPort==11)
      {
        return decodeWatermarkProfile3(bytes);
      }
    ```

  - Copy the codec to the `bcm2709` path.
  - Add `- run: node scripts/verify-lsn50-watermark-codec.js` to `.github/workflows/codecs.yml`, after `verify-lsn50-chameleon-codec`.

- [ ] **Step 4: Run all codec verifiers.**

```bash
node scripts/verify-lsn50-watermark-codec.js
node scripts/verify-lsn50-chameleon-codec.js
node scripts/verify-codec-robustness.js
node scripts/verify-profile-parity.js
```
Expected:
- `verify-lsn50-watermark-codec: OK (3 accepted, 6 rejected)`.
- The other three pass unchanged. The FPort 99 robustness snapshot must stay `{ data: undefined }`.

- [ ] **Step 5: Commit.**

```bash
git add -A conf scripts/verify-lsn50-watermark-codec.js .github/workflows/codecs.yml
git commit -m "feat(codec): LSN50 FPort 11 WATERMARK profile 3 raw branch, pinned to the edge parser"
```

---

### Task 5: Ingest wiring in flows (dispatch before timestamp parsing and the raw fallback)

**Files:**
- Modify: both `flows.json` profiles. Nodes involved:
  - `lsn50-decode-fn` (early FPort 11 dispatch; wires fan out);
  - `lsn50-config-query-fn` (drop WATERMARK messages);
  - new node `watermark-ingest-fn`.
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`, `scripts/verify-osi-lib-db-caller-binding.js`
- Create: `scripts/test-watermark-ingest-flow.js`
- Modify: `.github/workflows/verify-sync-flow.yml`

**Interfaces:**
- Consumes: Task 3 `ingestProfile3`; `osi-device-writer` `{writeDeviceData, clampRecordedAt}`; `/srv/node-red/edge-channels.json`.
- Produces: for FPort 11, `msg.formattedData` = `{isWatermark:true, devEui, timestamp, rawPayloadB64, fCnt}`, where `timestamp` is the **raw** `data.time` (or `null`); the helper clamps it. The stock raw fallback and the stock `toISOString()` never run for FPort 11.

- [ ] **Step 1: Load the flows-editing skill** (`.claude/skills/osi-flows-json-editing/SKILL.md`). Write the roundtrip script in your scratchpad and prove a no-op roundtrip is byte-identical on both profiles.

- [ ] **Step 2: Write the failing flow test** `scripts/test-watermark-ingest-flow.js`. It uses `scripts/lib/flow-node-harness.js`; read its exports first, and follow how `scripts/verify-sync-flow.js:1246-1285` executes `lsn50-decode-fn`. Build the in-memory DB for (d) and (e) from `database/seed-blank.sql`, reusing the sqlite3-adapter pattern from `…/osi-device-writer/facade-contract.test.js`. Seed a `users` row and a `DRAGINO_LSN50` `devices` row for the DevEUI first, as `store.test.js` `freshDb()` does. Cover:
  - **(a)** A ChirpStack uplink with `fPort: 11`, a 27-byte profile 3 `data` (base64), `time: '2026-09-25T10:00:00Z'`, and a `deviceInfo` passing the LSN50 profile gate (`deviceProfileName: 'OSI Dragino LSN50'`). Decode yields exactly `{isWatermark:true, devEui, timestamp:'2026-09-25T10:00:00Z', rawPayloadB64, fCnt}`, and the stubbed `dendro.decodeRawAdcPayload` is never called.
  - **(b)** The Chameleon V1 and V2 golden frames and the stock MOD3 frame from `scripts/verify-lsn50-chameleon-codec.js`, on `fPort: 2`, with `data.object` from running the codec. For each, decode's `formattedData` deep-equals what `origin/main`'s `lsn50-decode-fn` produces for the same input (Review Focus 1). Load the base node with `git show origin/main:<flows path>`.
  - **(c)** `lsn50-config-query-fn` returns `null` for `{formattedData:{isWatermark:true, devEui:'A840…'}}`.
  - **(d)** `watermark-ingest-fn` returns `null` for a non-WATERMARK message. For a WATERMARK message, with `osiLib.require('watermark-helper')` and `('device-writer')` resolved to the real modules and `osiDb.Database` backed by the in-memory DB, it writes one `device_data` row and one `watermark_readings` row, and the raw row's `device_data_id` equals the `device_data.id`.
  - **(e)** Review Focus 2: an FPort 11 uplink with `time: 'not-a-date'` goes through decode **and** ingest. It produces exactly one `device_data` row and one `watermark_readings` row with the same, valid, clamped `recorded_at`.

  Run: `node scripts/test-watermark-ingest-flow.js`. Expected: FAIL (the node is missing and there's no dispatch).

- [ ] **Step 3: Mutate the flows.** In both profiles:

  1. **`lsn50-decode-fn`:** insert this block immediately **before** the line
     `const timestamp = data.time ? new Date(data.time).toISOString() : new Date().toISOString();`
     It sits after the profile gate and the F83 dedup, and before timestamp parsing (which throws on an invalid date) and before any raw decode.
     ```js
         // WATERMARK profile 3 (FPort 11): its own path (watermark-ingest-fn).
         // Must return before timestamp parsing (throws on a bad date; the
         // helper clamps instead) and before the stock raw fallback, which
         // misreads these bytes.
         if (Number(data.fPort) === 11) {
             msg.formattedData = {
                 isWatermark: true,
                 devEui: devEui,
                 timestamp: data.time || null,
                 rawPayloadB64: data.data || null,
                 fCnt: Number.isInteger(Number(data.fCnt)) ? Number(data.fCnt) : null
             };
             node.status({ fill: 'blue', shape: 'dot', text: devEui + ' WATERMARK' });
             return msg;
         }
     ```
     Set its `wires` to `[["lsn50-config-query-fn", "watermark-ingest-fn"]]`.
  2. **`lsn50-config-query-fn`:** insert as the first line:
     ```js
     if (msg.formattedData && msg.formattedData.isWatermark === true) return null;
     ```
  3. **Add the new function node** on tab `lsn50-tab`, positioned below `lsn50-decode-fn`: `id: "watermark-ingest-fn"`, `name: "WATERMARK Ingest"`, `outputs: 0`, `wires: []`, `libs: [{"var":"osiDb","module":"osi-db-helper"},{"var":"osiLib","module":"osi-lib"}]`, and `func`:
     ```js
     return (async () => {
     const d = msg.formattedData;
     if (!d || d.isWatermark !== true) return null;
     const helperRes = osiLib.require('watermark-helper');
     if (!helperRes.ok) { node.warn('watermark-helper quarantined: ' + helperRes.error); return null; }
     const writerRes = osiLib.require('device-writer');
     if (!writerRes.ok) { node.warn('device-writer quarantined: ' + writerRes.error); return null; }
     let manifest;
     try { manifest = JSON.parse(global.get('fs').readFileSync('/srv/node-red/edge-channels.json', 'utf8')); }
     catch (e) { node.error('edge-channels.json load failed: ' + e.message); return null; }
     const db = new osiDb.Database('/data/db/farming.db');
     try {
       const res = await helperRes.value.ingestProfile3(db, {
         deveui: d.devEui, recordedAt: d.timestamp, payloadB64: d.rawPayloadB64, fCnt: d.fCnt
       }, {
         clampRecordedAt: writerRes.value.clampRecordedAt,
         writeDeviceData: async (tx, normalizeResult) =>
           await writerRes.value.writeDeviceData(tx, manifest, normalizeResult, { deveui: d.devEui }, { node })
       });
       node.status(res.accepted
         ? { fill: 'green', shape: 'dot', text: d.devEui + ' ' + res.statuses.join('/') }
         : { fill: 'yellow', shape: 'ring', text: d.devEui + ' skipped: ' + res.reason });
       if (!res.accepted) node.warn('WATERMARK frame from ' + d.devEui + ' not stored: ' + res.reason);
     } catch (e) {
       node.error('WATERMARK ingest failed for ' + d.devEui + ': ' + e.message);
     } finally {
       await new Promise((resolve) => db.close(() => resolve()));
     }
     return null;
     })();
     ```
     The writer callback really is awaited, and it contains the literal `await writerRes.value.writeDeviceData(` that `verify-osi-lib-db-caller-binding.js` pins. `db.close()` in `finally` satisfies the `test-flows-wiring.js` close audit; on the shared facade it is a no-op.

- [ ] **Step 4: Update the ratchet and binding pins.**
  - **Measure the growth.** Run `node scripts/verify-flows-size-ratchet.js`. It reports each profile's growth of `lsn50-decode-fn` and `lsn50-config-query-fn`.
  - **Allowance entries.** Add `node_allowances` entries for both nodes with the exact measured **per-profile** deltas. Raise `total_allowance.delta` by the measured per-profile total growth, **including the new node**. Each `reason` states "WATERMARK phase 1 (spec 2026-09-25): FPort 11 dispatch before the raw fallback" and the measured numbers, in the style of the existing entries.
  - **The new node** must measure ≤ 4096 chars. If it doesn't, move code into the helper, not into a ceiling entry.
  - **Binding pins.** In `scripts/verify-osi-lib-db-caller-binding.js`, add `'watermark-ingest-fn'` to `reviewedCallerNodeIds`, with a comment: "WATERMARK profile 3 ingest; writes device_data through the helper's transaction scope via an awaited callback".
  - **CI.** Add `- run: node scripts/test-watermark-ingest-flow.js` to `.github/workflows/verify-sync-flow.yml`.

- [ ] **Step 5: Run the flow gates.**

```bash
node scripts/test-watermark-ingest-flow.js
node scripts/verify-flows-size-ratchet.js
node scripts/verify-osi-lib-db-caller-binding.js
node scripts/flows-bare-require-scan.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-flows-output-arity.js
node scripts/test-flows-wiring.js
node scripts/verify-lsn50-chameleon-persistence.js
node scripts/verify-lsn50-chameleon-swt.js
node scripts/verify-sync-flow.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-profile-parity.js
```
Expected: all exit 0.

- [ ] **Step 6: Commit.**

```bash
git add -A conf scripts .github/workflows/verify-sync-flow.yml
git commit -m "feat(flows): route LSN50 FPort 11 to WATERMARK ingest before timestamp parsing and the raw fallback"
```

---

### Task 6: Scheduler interlock for phase 1

**Files:**
- Modify: both `flows.json` profiles: the scheduler query node `d0b2b1c1a937e16d`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`; append to `scripts/test-watermark-ingest-flow.js`

**Interfaces:**
- Consumes: `watermark_readings.device_data_id` (Task 2).
- Produces: every scheduler metric (`SWT_1`, `SWT_2`, `SWT_3`, `SWT_AVG` and the legacy aliases) ignores `device_data` rows that are WATERMARK observations, whatever the device flags say. `DENDRO` is unaffected.

- [ ] **Step 1: Write the failing test.** Append to `scripts/test-watermark-ingest-flow.js`:
  - Execute node `d0b2b1c1a937e16d` for a zone row `{zone_id: <Z>, trigger_metric: 'SWT_1'}` and run its `msg.topic` against the in-memory DB. The zone holds a `DRAGINO_LSN50` device with `chameleon_enabled = 1` and two `device_data` rows in the last hour:
    - row A: `swt_1 = 60`, with a matching `watermark_readings` row (`device_data_id` = A's id);
    - row B: `swt_1 = 30`, a Chameleon observation with no WATERMARK row.
  - Assert `n_points = 1` and `mean_kpa = 30`. The WATERMARK row, including a backfilled one, is excluded, and the Chameleon row still counts.
  - Repeat for `SWT_AVG`.

  Run it; expected: FAIL (`n_points = 2`).

- [ ] **Step 2: Mutate the flows.** In `d0b2b1c1a937e16d`, in the SWT query's `WHERE` clause, add a line directly after `AND ${expr} IS NOT NULL`:
  ```js
      AND NOT EXISTS (SELECT 1 FROM watermark_readings wr WHERE wr.device_data_id = dd.id)
  ```
  with a comment line above the SQL builder:
  ```js
  // WATERMARK phase 1 interlock: WATERMARK observations never drive irrigation
  // until phase 3's explicit enable (spec 2026-09-25 section 8).
  ```
  Apply it in both profiles.

- [ ] **Step 3: Ratchet.** Add a per-profile `node_allowances` entry for `d0b2b1c1a937e16d` and raise `total_allowance` by the measured per-profile growth.

- [ ] **Step 4: Run the gates.**

```bash
node scripts/test-watermark-ingest-flow.js
node scripts/verify-flows-size-ratchet.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-sync-flow.js
node scripts/test-flows-wiring.js
node scripts/verify-profile-parity.js
```
Expected: all exit 0.

- [ ] **Step 5: Commit.**

```bash
git add -A conf scripts
git commit -m "feat(scheduler): phase 1 interlock -- WATERMARK observations never drive irrigation"
```

---

### Task 7: Calibration HTTP route

**Files:**
- Modify: both `flows.json` profiles. Changes:
  - new `watermark-cal-get-http`, `watermark-cal-put-http` and `watermark-cal-delete-http`;
  - one new handler `watermark-cal-fn`;
  - `scoped-device-config-guard` (`routeTable`, `outputs`, `wires`).
- Modify: `scripts/test-scoped-access-writes.js` (`DEVICE_CONFIG_ROUTES`, the IB1 `wires[25]` index), `scripts/verify-sync-flow.js` (`requiredHttpRoutes`), `scripts/verify-flows-size-ratchet-allowances.json` (`node_allowances` for the guard, `new_node_ceilings` for the handler, `total_allowance`)
- Create: `scripts/test-watermark-calibration-routes.js`
- Modify: `.github/workflows/verify-sync-flow.yml`

**Interfaces:**
- Consumes: Task 3 `getCalibration` / `saveCalibration` / `deleteCalibration` with `{deveui, userId, scoped}`.
- Produces HTTP:
  - `GET /api/devices/:deveui/watermark/calibration` → 200 `{deveui, sync_version, calibration|null}`.
  - `PUT` same path:
    - body = the 8 values + optional `measured_at`, `method`, `worst_residual_pct`, `notes`, plus `expected_sync_version` or `dry_run:true`;
    - returns 200 with the `saveCalibration` result.
  - `DELETE` same path `?expected_sync_version=N` → 200 `{deveui, sync_version, calibration:null}`.
  - Errors → `{status: e.statusCode}`, body `{message, code, field, current_sync_version}`.
- Auth, following the existing patterns:
  - **Flag off:** every method verifies the bearer inline and filters on `user_id`. `osiLib.require('scope')` must not be reachable.
  - **Scoped, `PUT` / `DELETE`:** they arrive through `scoped-device-config-guard`, which has already verified bearer, role (`canMutate`) and device access, so the handler neither re-verifies nor filters on owner (the `sdi12-config-auth-fn` handoff).
  - **Scoped, `GET`:** verify the bearer, then `scope.assertEnabledAccount`, then an account-wide device lookup (the `s2120-zones-get-fn` pattern).

- [ ] **Step 1: Write the failing route test** `scripts/test-watermark-calibration-routes.js`. Use the same harness as Task 5 and the same in-memory DB, with users A (owner, researcher), B (other researcher) and V (viewer). Copy `signToken` / `scopedRequest` and the scope-helper setup from `scripts/test-scoped-access-writes.js`. Run each request through the **whole chain**: http-in → (`scoped-device-config-guard` for `PUT`/`DELETE`) → `watermark-cal-fn`. Cover:
  - **Flag off:**
    - (a) `GET` by A → 200 `{sync_version:0, calibration:null}`;
    - (b) `PUT` by A with `expected_sync_version:0` → 200 `sync_version:1`;
    - (c) the same `PUT` again → 409, `code:'stale_sync_version'`, `current_sync_version:1`;
    - (d) `PUT` `dry_run:true` → 200 `dry_run:true`, DB unchanged;
    - (e) `DELETE ?expected_sync_version=1` → 200 `sync_version:2`;
    - (f) `PUT` by B for A's device → 404;
    - (g) no bearer → 401.
  - **Scoped (`OSI_SCOPED_ACCESS=1`):**
    - (h) B assigned to the device's zone: `PUT` → 200 (Review Focus 5);
    - (i) V: `PUT` → 403 from the guard, DB unchanged;
    - (j) B: `GET` → 200.

  Run it; expected: FAIL (nodes missing).

- [ ] **Step 2: Add the nodes.** Place them on tab `device-api-tab`, after the Chameleon depth nodes.
  - **`watermark-cal-get-http`:** `type:"http in"`, `method:"get"`, `url:"/api/devices/:deveui/watermark/calibration"`; wires → `watermark-cal-fn`.
  - **`watermark-cal-put-http`:** `method:"put"`, same `url`; wires → `scoped-device-config-guard`.
  - **`watermark-cal-delete-http`:** `method:"delete"`, same `url`; wires → `scoped-device-config-guard`.
  - **`watermark-cal-fn`:** `name: "WATERMARK Calibration"`, `outputs:1`, `wires:[["device-response"]]`, `libs:[{"var":"crypto","module":"crypto"},{"var":"osiDb","module":"osi-db-helper"},{"var":"osiLib","module":"osi-lib"}]`.
    - Its `func` starts with the **auth prelude copied verbatim** from `s2120-zones-get-fn`: everything from `return (async () => {` up to, not including, `let db = null;`. That is the flag-gated `getAuthSecret()`, `toB64u` / `fromB64u` and `verifyBearer`.
    - In the prelude, replace every `sourceId: 's2120-zones-get-fn'` and `'s2120-zones-get-fn auth secret …'` string with `watermark-cal-fn`.
    - After the prelude, the body:
    ```js
    let db = null;
    const closeDb = () => db ? new Promise((resolve) => db.close(() => resolve())) : Promise.resolve();
    const respond = (status, payload) => { msg.statusCode = status; msg.payload = payload; return msg; };
    try {
      const method = String(msg.req && msg.req.method || '').toUpperCase();
      const scopedOn = String(env.get('OSI_SCOPED_ACCESS') || '') === '1';
      // Scoped writes arrive through scoped-device-config-guard, which has
      // already verified bearer, role and device access (sdi12 handoff).
      const auth = scopedOn && method !== 'GET' ? null : verifyBearer(msg.req.headers.authorization);
      const helperRes = osiLib.require('watermark-helper');
      if (!helperRes.ok) throw Object.assign(new Error('WATERMARK helper unavailable'), { statusCode: 500 });
      db = new osiDb.Database('/data/db/farming.db');
      if (scopedOn && method === 'GET') {
        const scopeLoad = osiLib.require('scope');
        if (!scopeLoad.ok) throw Object.assign(new Error('scope resolver unavailable'), { statusCode: 500 });
        const scopeUser = await db.get('SELECT user_uuid FROM users WHERE id = ?', [auth.userId]);
        // Write-only scoping (W1/P5): reads are account-wide.
        await scopeLoad.value.assertEnabledAccount(db, scopeUser && scopeUser.user_uuid, { scopedMode: true });
      }
      const access = { deveui: msg.req.params.deveui, userId: auth ? auth.userId : null, scoped: scopedOn };
      const wm = helperRes.value;
      const result = method === 'GET'
        ? await wm.getCalibration(db, access)
        : method === 'DELETE'
          ? await wm.deleteCalibration(db, Object.assign(access, { expectedSyncVersion: msg.req.query && msg.req.query.expected_sync_version }))
          : await wm.saveCalibration(db, Object.assign(access, { body: msg.payload }));
      await closeDb();
      return respond(200, result);
    } catch (e) {
      try { await closeDb(); } catch (_) {}
      return respond(e.statusCode || 500, {
        message: e.message || 'WATERMARK calibration failed',
        code: e.code || null,
        field: e.field || null,
        current_sync_version: e.currentSyncVersion === undefined ? null : e.currentSyncVersion
      });
    }
    })();
    ```
  - **`scoped-device-config-guard`:**
    - append `{"method":"PUT","suffix":"/watermark/calibration","index":25}` and `{"method":"DELETE","suffix":"/watermark/calibration","index":26}` to `routeTable`;
    - replace `wires` with the old wires 0–24, then `["watermark-cal-fn"]`, `["watermark-cal-fn"]`, then the old error wire (`["device-response"]`), making 28 wires;
    - set `outputs` to `28`.
  - **OPTIONS:** check whether the existing device routes have per-route `OPTIONS` http-in nodes: `grep -n '"method": "options"' flows.json`. If `/api/devices/:deveui/chameleon/depth` has one, add the matching one for the new path, wired the same way.

- [ ] **Step 3: Update the gates.**
  - **`scripts/test-scoped-access-writes.js`:**
    - append `['PUT', '/watermark/calibration']` and `['DELETE', '/watermark/calibration']` to `DEVICE_CONFIG_ROUTES`;
    - change `guard.wires[25]` (the IB1 denial wire) to `guard.wires[27]`.
  - **`scripts/verify-sync-flow.js`:** add `'/api/devices/:deveui/watermark/calibration'` to `requiredHttpRoutes`.
  - **Size ratchet:**
    - measure the guard's per-profile growth and add a `node_allowances` entry;
    - measure `watermark-cal-fn` and add a `new_node_ceilings` entry `{max_chars: <measured>, reason}`. The reason says the node carries the inline flag-off auth prelude that `verify-auth-flag-off-hermetic.js` requires (about 3.7 KB), which alone exceeds the 4096 ceiling with any handler body, following `sdi12-config-auth-fn` and `device-rename-fn`;
    - raise `total_allowance` by the per-profile total.
  - **CI:** add `- run: node scripts/test-watermark-calibration-routes.js` to `.github/workflows/verify-sync-flow.yml`.

- [ ] **Step 4: Run the gates.**

```bash
node scripts/test-watermark-calibration-routes.js
node --test scripts/test-scoped-access-writes.js
node scripts/verify-scoped-access.js
node scripts/verify-auth-flag-off-hermetic.js
node --test scripts/verify-auth-flag-off-hermetic.test.js
node scripts/verify-sync-flow.js
node scripts/verify-flows-size-ratchet.js
node scripts/verify-flows-output-arity.js
node scripts/test-flows-wiring.js
node scripts/verify-profile-parity.js
```
Expected: all exit 0.

- [ ] **Step 5: Commit.**

```bash
git add -A conf scripts .github/workflows/verify-sync-flow.yml
git commit -m "feat(api): WATERMARK calibration GET/PUT/DELETE (versioned, dry-run preview, scoped handoff, flag-off hermetic)"
```

---

### Task 8: WATERMARK reading of the latest observation in the device list

**Files:**
- Modify: both `flows.json` profiles: nodes `format-devices` and `merge-device-data`
- Modify: `scripts/verify-flows-size-ratchet-allowances.json`; append to `scripts/test-watermark-ingest-flow.js`

**Interfaces:**
- Produces: `latest_data.watermark` for each device in `GET /api/devices`. It is `null` unless the device's **latest** `device_data` row is a WATERMARK observation. Otherwise it is:
  `{recorded_at, supply_mv, soil_temp_c, soil_temp_source, die_temp_c, channels:[{status, kpa, kpa_upper_bound, r_solved, r_upper_bound, offset_mv} ×2]}`
  from the `watermark_readings` row whose `device_data_id` is that latest row's id.

- [ ] **Step 1: Write the failing test.** Append to `scripts/test-watermark-ingest-flow.js` a case that runs `format-devices` for three devices, executes the SQL it builds (`msg.topic`) against the in-memory DB, and then runs `merge-device-data` on the result:
  - **device A:** latest observation is WATERMARK → `latest_data.watermark` is an object and `channels[1].status === 'saturated'`;
  - **device B:** only a `frame_rejected` raw row and an older stock row → `watermark` is `null` (Review Focus 4);
  - **device C:** a WATERMARK observation followed by a newer Chameleon observation (a board swap) → `watermark` is `null`, so no old WATERMARK fault reaches the zone summary (Review Focus 4).

  Run it; expected: FAIL.

- [ ] **Step 2: Mutate the flows.**
  - **`format-devices`:** insert these lines into the SELECT list immediately before `'  ch.id AS chameleon_reading_id,',`:
    ```js
      "  (SELECT json_object('recorded_at', wr.recorded_at, 'supply_mv', wr.supply_mv, 'soil_temp_c', wr.soil_temp_c,",
      "     'soil_temp_source', wr.soil_temp_source, 'die_temp_c', wr.die_temp_c, 'channels', json_array(",
      "       json_object('status', wr.ch1_status, 'kpa', wr.ch1_kpa, 'kpa_upper_bound', wr.ch1_kpa_upper_bound,",
      "         'r_solved', wr.ch1_r_solved, 'r_upper_bound', wr.ch1_r_upper_bound, 'offset_mv', wr.ch1_offset_mv),",
      "       json_object('status', wr.ch2_status, 'kpa', wr.ch2_kpa, 'kpa_upper_bound', wr.ch2_kpa_upper_bound,",
      "         'r_solved', wr.ch2_r_solved, 'r_upper_bound', wr.ch2_r_upper_bound, 'offset_mv', wr.ch2_offset_mv)))",
      "   FROM watermark_readings wr WHERE wr.device_data_id = dd.id LIMIT 1) AS watermark_latest_json,",
    ```
    `dd` is already the latest `device_data` row per device.
  - **`merge-device-data`:** in the `dataMap` object, after `chameleon_array_id: d.chameleon_array_id,`, add:
    `watermark_latest_json: d.watermark_latest_json,`
    In the `latest_data` object built per device, after the Chameleon fields, add:
    `watermark: latest.watermark_latest_json ? JSON.parse(latest.watermark_latest_json) : null,`
    Read the node's existing `parseJsonObject` helper first. If it returns `null` for invalid JSON, use it instead of `JSON.parse`; if it returns `{}` for null input, keep the ternary.

- [ ] **Step 3: Ratchet.** Measure both nodes' per-profile growth and add or extend their `node_allowances` entries (`merge-device-data` already has one; add the delta to it and update its `reason`). Raise `total_allowance`.

- [ ] **Step 4: Run the gates.**

```bash
node scripts/test-watermark-ingest-flow.js
node scripts/verify-flows-size-ratchet.js
node scripts/verify-sqlite-cli-limits.js
node scripts/verify-sync-flow.js
node scripts/test-flows-wiring.js
node scripts/verify-profile-parity.js
```
Expected: all exit 0.

- [ ] **Step 5: Commit.**

```bash
git add -A conf scripts
git commit -m "feat(api): device list carries the WATERMARK reading of the latest observation"
```

---

### Task 9: GUI types, API client and the WATERMARK probe section in the LSN50 card

**Files:**
- Modify: `web/react-gui/src/types/farming.ts`, `web/react-gui/src/services/api.ts`, `web/react-gui/src/components/farming/DraginoTempCard.tsx`
- Create: `web/react-gui/src/components/farming/shared/WatermarkProbeSection.tsx`
- Test: `web/react-gui/src/components/farming/__tests__/WatermarkProbeSection.test.tsx`; extend `…/__tests__/DraginoTempCard.test.tsx`
- Modify: `web/react-gui/public/locales/en/devices.json` (the other locales come in Task 11)

**Interfaces:**
- Consumes: Task 8 `latest_data.watermark`; Task 7 route.
- Produces:
  - types `WatermarkChannelStatus`, `WatermarkChannelLatest`, `WatermarkLatest`, `WatermarkCalibrationValues`, `WatermarkCalibration`, `WatermarkCalibrationState`, `WatermarkPreviewChannel`;
  - `lsn50API.getWatermarkCalibration(deveui)`, `.saveWatermarkCalibration(deveui, values, expectedSyncVersion)`, `.previewWatermarkCalibration(deveui, values)`, `.deleteWatermarkCalibration(deveui, expectedSyncVersion)`;
  - the component `WatermarkProbeSection` with props below;
  - i18n group `devices:watermark.*`.

- [ ] **Step 1: Add the types** to `web/react-gui/src/types/farming.ts`, above `interface Device`:

```ts
export type WatermarkChannelStatus =
  | 'ok' | 'saturated' | 'wet_offset_clipped' | 'short' | 'short_suspected' | 'open'
  | 'unsettled' | 'invalid_sample' | 'calibration_required' | 'temperature_missing'
  | 'temperature_out_of_range' | 'outside_200ss_range';

export interface WatermarkChannelLatest {
  status: WatermarkChannelStatus | null;
  kpa: number | null;
  kpa_upper_bound: number | null;
  r_solved: number | null;
  r_upper_bound: number | null;
  offset_mv: number | null;
}

export interface WatermarkLatest {
  recorded_at: string;
  supply_mv: number | null;
  soil_temp_c: number | null;
  soil_temp_source: number | null;
  die_temp_c: number | null;
  channels: [WatermarkChannelLatest, WatermarkChannelLatest];
}

export interface WatermarkCalibrationValues {
  pullup_1_ohm: number;
  pulldown_1_ohm: number;
  series_fwd_1_ohm: number;
  series_rev_1_ohm: number;
  pullup_2_ohm: number;
  pulldown_2_ohm: number;
  series_fwd_2_ohm: number;
  series_rev_2_ohm: number;
}

export interface WatermarkCalibration extends WatermarkCalibrationValues {
  measured_at: string | null;
  method: string | null;
  worst_residual_pct: number | null;
  notes: string | null;
  updated_at: string;
}

export interface WatermarkCalibrationState {
  deveui: string;
  sync_version: number;
  calibration: WatermarkCalibration | null;
}

export interface WatermarkPreviewChannel extends WatermarkChannelLatest {
  r_fwd: number | null;
  r_rev: number | null;
}
```

and inside `latest_data` (after the Chameleon fields): `watermark?: WatermarkLatest | null;`.

- [ ] **Step 2: Add the API client** to `lsn50API` in `web/react-gui/src/services/api.ts`, after `setChameleonDepth`. Add the new types to that file's type import.

```ts
  getWatermarkCalibration: async (deveui: string): Promise<WatermarkCalibrationState> => {
    const res = await api.get(`/api/devices/${deveui}/watermark/calibration`);
    return res.data;
  },
  saveWatermarkCalibration: async (
    deveui: string,
    values: WatermarkCalibrationValues & { measured_at?: string | null; method?: string | null; notes?: string | null },
    expectedSyncVersion: number,
  ): Promise<WatermarkCalibrationState & { backfilled: number }> => {
    const res = await api.put(`/api/devices/${deveui}/watermark/calibration`, { ...values, expected_sync_version: expectedSyncVersion });
    return res.data;
  },
  previewWatermarkCalibration: async (
    deveui: string,
    values: WatermarkCalibrationValues,
  ): Promise<{ preview: { recorded_at: string; channels: WatermarkPreviewChannel[] } | null }> => {
    const res = await api.put(`/api/devices/${deveui}/watermark/calibration`, { ...values, dry_run: true });
    return res.data;
  },
  deleteWatermarkCalibration: async (deveui: string, expectedSyncVersion: number): Promise<WatermarkCalibrationState> => {
    const res = await api.delete(`/api/devices/${deveui}/watermark/calibration`, { params: { expected_sync_version: expectedSyncVersion } });
    return res.data;
  },
```

- [ ] **Step 3: Add the English strings** as a new top-level group `watermark` in `web/react-gui/public/locales/en/devices.json`:

```json
"watermark": {
  "sectionTitle": "WATERMARK soil tension",
  "probe": "Probe {{n}}",
  "depthUnset": "Depth unset",
  "wet": "Wet",
  "wetUpTo": "≤ {{value}}",
  "resistance": "Resistance {{value}}",
  "resistanceUpTo": "Resistance ≤ {{value}}",
  "offset": "Offset {{value}} mV",
  "soilTemp": "Soil {{value}} °C",
  "soilTempNotMeasured": "Soil temperature not measured",
  "dieTemp": "Board {{value}} °C",
  "supply": "Supply {{value}} V",
  "status": {
    "ok": "OK",
    "saturated": "Saturated",
    "wet_offset_clipped": "Reading clipped: tension at most the value shown",
    "short": "Short circuit",
    "short_suspected": "Possible short circuit",
    "open": "Dry beyond range or disconnected",
    "unsettled": "Reading not settled",
    "invalid_sample": "Invalid sample",
    "calibration_required": "Calibration needed",
    "temperature_missing": "No soil temperature",
    "temperature_out_of_range": "Soil temperature out of range",
    "outside_200ss_range": "Outside the sensor's range"
  },
  "depths": {
    "title": "Probe depths",
    "depth": "Probe {{n}} depth (cm)",
    "save": "Save depths",
    "saved": "Depths saved."
  },
  "calibration": {
    "title": "WATERMARK calibration",
    "description": "Pull and series resistances per channel, from the bench resistor sweep. Readings convert to kPa once these are saved.",
    "channel": "Channel {{n}}",
    "pullup": "Pull-up (Ω)",
    "pulldown": "Pull-down (Ω)",
    "seriesFwd": "Series, forward (Ω)",
    "seriesRev": "Series, reverse (Ω)",
    "preview": "Preview",
    "save": "Save calibration",
    "delete": "Delete calibration",
    "confirmDelete": "Delete this calibration? New readings will wait for a calibration again.",
    "previewEmpty": "No WATERMARK reading yet to preview.",
    "previewResult": "Latest reading: probe 1 {{p1}}, probe 2 {{p2}}",
    "saved": "Calibration saved. {{count}} waiting readings converted.",
    "deleted": "Calibration deleted.",
    "conflict": "The calibration changed elsewhere. The current values are loaded; check them and save again.",
    "invalidField": "Check {{field}}: out of range.",
    "loadFailed": "Could not load the calibration."
  }
}
```

- [ ] **Step 4: Write the failing component test** `web/react-gui/src/components/farming/__tests__/WatermarkProbeSection.test.tsx`:

```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { WatermarkProbeSection } from '../shared/WatermarkProbeSection';
import type { WatermarkChannelLatest } from '../../../types/farming';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const labels: Record<string, string> = { 'history.soil.state.wet': 'Wet', 'history.soil.state.moist': 'Moist', 'history.soil.state.dry': 'Dry' };
      if (labels[key]) return labels[key];
      return opts ? `${key}:${JSON.stringify(opts)}` : key;
    },
  }),
}));

const ch = (over: Partial<WatermarkChannelLatest>): WatermarkChannelLatest => ({
  status: 'ok', kpa: null, kpa_upper_bound: null, r_solved: null, r_upper_bound: null, offset_mv: null, ...over,
});
const base = { isCurrent: true, swtUnit: 'kPa' as const, soilTempC: 19.9, soilTempMeasured: true, dieTempC: 21.5, supplyMv: 3300 };

describe('WatermarkProbeSection', () => {
  it('shows kPa with the shared soil status colour', () => {
    render(<WatermarkProbeSection {...base} probes={[
      { key: 'swt_1', label: 'Probe 1', depthLabel: '20 cm', channel: ch({ kpa: 56.4, r_solved: 9977, offset_mv: 0.6 }) },
    ]} />);
    expect(screen.getByText('56.4 kPa')).toBeInTheDocument();
    expect(screen.getByText('Dry')).toBeInTheDocument();
  });

  it('colours a clipped probe wet only when its tension bound is itself wet', () => {
    render(<WatermarkProbeSection {...base} probes={[
      { key: 'swt_1', label: 'Probe 1', depthLabel: null, channel: ch({ status: 'wet_offset_clipped', kpa_upper_bound: 11.2, r_upper_bound: 1325, offset_mv: 114.9 }) },
    ]} />);
    expect(screen.getByText(/watermark\.wetUpTo/)).toBeInTheDocument();
    expect(screen.getByText('Wet')).toBeInTheDocument();
  });

  it('shows a clipped probe with a high bound as a bound, without colour', () => {
    render(<WatermarkProbeSection {...base} probes={[
      { key: 'swt_1', label: 'Probe 1', depthLabel: null, channel: ch({ status: 'wet_offset_clipped', kpa_upper_bound: 93.2, r_upper_bound: 8502 }) },
    ]} />);
    expect(screen.getByText(/watermark\.wetUpTo/)).toBeInTheDocument();
    expect(screen.queryByText('Wet')).not.toBeInTheDocument();
    expect(screen.queryByText('Dry')).not.toBeInTheDocument();
  });

  it('shows no colour for a stale reading or a probe without kPa', () => {
    render(<WatermarkProbeSection {...base} isCurrent={false} probes={[
      { key: 'swt_1', label: 'Probe 1', depthLabel: null, channel: ch({ kpa: 56.4 }) },
      { key: 'swt_2', label: 'Probe 2', depthLabel: null, channel: ch({ status: 'calibration_required', r_solved: null }) },
    ]} />);
    expect(screen.queryByText('Dry')).not.toBeInTheDocument();
    expect(screen.getByText(/watermark\.status\.calibration_required/)).toBeInTheDocument();
  });

  it('says supply, never battery', () => {
    render(<WatermarkProbeSection {...base} probes={[]} />);
    expect(screen.getByText(/watermark\.supply/)).toBeInTheDocument();
  });
});
```

Run: `cd web/react-gui && npx vitest run src/components/farming/__tests__/WatermarkProbeSection.test.tsx`. Expected: FAIL (module missing). Use `npm run test:unit` for the full suite; a bare `npx vitest run` on the whole project is wrong here.

- [ ] **Step 5: Implement** `web/react-gui/src/components/farming/shared/WatermarkProbeSection.tsx`:

```tsx
import { useTranslation } from 'react-i18next';
import type { WatermarkChannelLatest } from '../../../types/farming';
import { classifySwtWaterStatus, formatSwtCardValue, type SwtUnit } from '../../../utils/swt';
import { SwtStatusIndicator } from './SwtStatusIndicator';

// Node-neutral view of IRROMETER WATERMARK 200SS probes. The LSN50 card uses it
// now; the KIWI card can embed it later (spec D5). Physics stays on the edge:
// this component only formats what the helper computed.
export interface WatermarkProbeView {
  key: string;
  label: string;
  depthLabel: string | null;
  channel: WatermarkChannelLatest | null;
}

interface WatermarkProbeSectionProps {
  probes: WatermarkProbeView[];
  isCurrent: boolean;
  swtUnit: SwtUnit;
  soilTempC: number | null;
  soilTempMeasured: boolean;
  dieTempC: number | null;
  supplyMv: number | null;
  onOpenHistory?: (key: string) => void;
}

function formatOhm(value: number): string {
  if (value >= 10000) return `${(value / 1000).toFixed(0)} kΩ`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)} kΩ`;
  return `${Math.round(value)} Ω`;
}

// A clipped probe is only known to be at most kpa_upper_bound. It is certainly
// wet only when that bound itself classifies as wet; otherwise no colour.
function clippedWaterStatus(bound: number | null) {
  return bound != null && classifySwtWaterStatus(bound) === 'wet' ? 'wet' : null;
}

export function WatermarkProbeSection({
  probes, isCurrent, swtUnit, soilTempC, soilTempMeasured, dieTempC, supplyMv, onOpenHistory,
}: WatermarkProbeSectionProps) {
  const { t } = useTranslation('devices');
  return (
    <div className="grid grid-cols-1 gap-2">
      {probes.map(({ key, label, depthLabel, channel }) => {
        const clipped = channel?.status === 'wet_offset_clipped';
        const kpa = channel?.kpa ?? null;
        const bound = channel?.kpa_upper_bound ?? null;
        const value = kpa !== null
          ? formatSwtCardValue(kpa, swtUnit)
          : clipped && bound !== null
            ? t('watermark.wetUpTo', { value: formatSwtCardValue(bound, swtUnit) })
            : null;
        const waterStatus = !isCurrent ? null : kpa !== null ? classifySwtWaterStatus(kpa) : clipped ? clippedWaterStatus(bound) : null;
        const details: string[] = [];
        if (channel?.r_solved != null) details.push(t('watermark.resistance', { value: formatOhm(channel.r_solved) }));
        else if (channel?.r_upper_bound != null) details.push(t('watermark.resistanceUpTo', { value: formatOhm(channel.r_upper_bound) }));
        if (channel?.offset_mv != null) details.push(t('watermark.offset', { value: channel.offset_mv.toFixed(0) }));
        return (
          <button
            key={key}
            type="button"
            disabled={!onOpenHistory}
            onClick={() => onOpenHistory?.(key)}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-left"
          >
            <span>
              <span className="block text-sm font-semibold text-[var(--text)]">{label}</span>
              <span className="block text-xs text-[var(--text-tertiary)]">{depthLabel || t('watermark.depthUnset')}</span>
              {channel?.status && channel.status !== 'ok' && (
                <span className="block text-xs text-[var(--text-secondary)]">{t(`watermark.status.${channel.status}`)}</span>
              )}
              {details.length > 0 && <span className="block text-xs text-[var(--text-tertiary)]">{details.join(' · ')}</span>}
            </span>
            <span className="flex flex-wrap items-center justify-end gap-2">
              <span className="text-lg font-bold tabular-nums text-[var(--text)]">{value ?? '—'}</span>
              <SwtStatusIndicator status={waterStatus} />
            </span>
          </button>
        );
      })}
      <p className="text-xs text-[var(--text-tertiary)]">
        {[
          soilTempMeasured && soilTempC != null ? t('watermark.soilTemp', { value: soilTempC.toFixed(1) }) : t('watermark.soilTempNotMeasured'),
          dieTempC != null ? t('watermark.dieTemp', { value: dieTempC.toFixed(1) }) : null,
          supplyMv != null ? t('watermark.supply', { value: (supplyMv / 1000).toFixed(2) }) : null,
        ].filter(Boolean).join(' · ')}
      </p>
    </div>
  );
}
```

Run the Step 4 test; expected: PASS. If `formatSwtCardValue(56.4, 'kPa')` renders differently from `'56.4 kPa'`, read its implementation in `utils/swt.ts` and fix the test's expected string to the real format. Do not change the formatter.

- [ ] **Step 6: Integrate into `DraginoTempCard.tsx`.**
  - Import `WatermarkProbeSection`.
  - Next to the Chameleon constants (around line 138), add:
    ```tsx
      const watermark = data?.watermark ?? null;
      const watermarkDepths = device.soil_moisture_probe_depths_json ?? {};
    ```
  - Immediately after the Chameleon `{chameleonEnabled && (…)}` block, add the section below. Freshness comes from the WATERMARK observation's own `recorded_at`.
    ```tsx
            {watermark && (
              <div className="rounded-lg bg-[var(--card)] p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">{t('watermark.sectionTitle')}</p>
                <WatermarkProbeSection
                  isCurrent={isSensorObservationFresh(watermark.recorded_at)}
                  swtUnit={swtUnit}
                  soilTempC={watermark.soil_temp_c}
                  soilTempMeasured={watermark.soil_temp_source === 2}
                  dieTempC={watermark.die_temp_c}
                  supplyMv={watermark.supply_mv}
                  probes={[1, 2].map((n) => ({
                    key: `swt_${n}`,
                    label: t('watermark.probe', { n }),
                    depthLabel: formatDepthLabel(watermarkDepths[`swt_${n}`]),
                    channel: watermark.channels[n - 1] ?? null,
                  }))}
                  onOpenHistory={(field) => setSensorMonitor({
                    field, initialField: field, label: t('watermark.probe', { n: field === 'swt_1' ? 1 : 2 }),
                    unit: 'kPa', color: field === 'swt_1' ? '#0f766e' : '#2563eb', decimals: 1,
                    seriesOptions: [1, 2].map((n) => ({ field: `swt_${n}`, label: t('watermark.probe', { n }), unit: 'kPa', color: n === 1 ? '#0f766e' : '#2563eb', decimals: 1 })),
                  })}
                />
              </div>
            )}
    ```
    (`t` is the card's existing `useTranslation('devices')` binding.)
  - **Card test.** Append to `__tests__/DraginoTempCard.test.tsx`:
    - a device with `latest_data.watermark` (channels `[{status:'ok', kpa:56.4, …}, {status:'saturated', kpa:0, …}]`, `recorded_at: FRESH`) renders `watermark.sectionTitle` and the values;
    - a device without `watermark` does not.
    - The existing `react-i18next` mock returns keys, so assert on keys.

- [ ] **Step 7: Run the checks.**

```bash
cd web/react-gui
npx vitest run src/components/farming/__tests__/WatermarkProbeSection.test.tsx src/components/farming/__tests__/DraginoTempCard.test.tsx
npm run typecheck
```
Expected: both pass.

- [ ] **Step 8: Commit.**

```bash
git add -A web/react-gui/src web/react-gui/public/locales/en/devices.json
git commit -m "feat(gui): WATERMARK probe section inside the LSN50 card, on the shared soil status colours"
```

---

### Task 10: Calibration and depth settings, and the zone summary

**Files:**
- Create: `web/react-gui/src/components/farming/WatermarkCalibrationSection.tsx`, `web/react-gui/src/components/farming/WatermarkDepthSection.tsx`
- Modify: `web/react-gui/src/components/farming/DraginoSettingsModal.tsx`, `web/react-gui/src/utils/zoneSoil.ts`
- Test: `web/react-gui/tests/watermarkCalibration.test.ts` (tsx runner, `node:test`, in the style of `tests/draginoSettings.test.ts`); extend `web/react-gui/src/utils/__tests__/zoneSoil.test.ts`

**Interfaces:**
- Consumes: Task 9 API client and types; the existing `deviceMetadataAPI.setSoilMoistureDepths(deveui, soilMoistureProbeDepths)` (`services/api.ts:1023-1033`).
- Produces:
  - the components `WatermarkCalibrationSection({device, onUpdate})` and `WatermarkDepthSection({device, onUpdate})`;
  - `zoneSoil` counts WATERMARK LSN50s as tension sensors and drops faulted WATERMARK channels.

- [ ] **Step 1: Write the failing zone-summary tests.** Append to `src/utils/__tests__/zoneSoil.test.ts`, following the file's device-fixture style and the existing open-channel Chameleon cases near lines 306 and 353-356:
  - An LSN50 with `chameleon_enabled: 0`, a fresh `last_seen`, `latest_data: { swt_1: 30, swt_2: null, watermark: { …, channels: [{ status: 'ok', kpa: 30, … }, { status: 'open', kpa: null, … }] } }` counts as a tension sensor: the zone summary includes 30 kPa.
  - With that one valid channel, the summary's invalid-reading flag stays `false`, matching the existing semantics that the Chameleon case at line 306 pins.
  - When **every** WATERMARK channel is faulted (`open` and `short`), the flag is `true`, as it is for an all-open Chameleon device.
  - An LSN50 with neither Chameleon nor `watermark` still does not count.

  Run: `cd web/react-gui && npx vitest run src/utils/__tests__/zoneSoil.test.ts`. Expected: FAIL on the first new case.

- [ ] **Step 2: Implement in `zoneSoil.ts`.**
  - Change `isTensionSensor`:
    ```ts
    function isTensionSensor(device: Pick<Device, 'type_id' | 'chameleon_enabled' | 'sdi12_probe_profile' | 'latest_data'>): boolean {
      if (device.type_id === 'KIWI_SENSOR' || device.type_id === 'TEKTELIC_CLOVER') return true;
      if (device.type_id === 'DRAGINO_LSN50') return device.chameleon_enabled === 1 || device.latest_data?.watermark != null;
      return device.type_id === 'DRAGINO_SDI12' && device.sdi12_probe_profile === 'TENSIOMARK';
    }
    ```
  - Add the fault rule next to `chameleonChannelFaulted`. `latest_data.watermark` only exists when the latest observation is a WATERMARK one (Task 8), so a fault never outlives a board swap.
    ```ts
    const WATERMARK_FAULT_STATUSES = new Set(['open', 'short', 'short_suspected', 'invalid_sample']);

    /** A WATERMARK channel whose latest reading is electrically faulty is an invalid reading, not a dry soil. */
    function watermarkChannelFaulted(device: Device, channel: SoilChannel): boolean {
      if (device.type_id !== 'DRAGINO_LSN50') return false;
      const channels = device.latest_data?.watermark?.channels;
      if (!channels) return false;
      const index = channel === 'swt_1' ? 0 : channel === 'swt_2' ? 1 : -1;
      const status = index >= 0 ? channels[index]?.status : null;
      return status != null && WATERMARK_FAULT_STATUSES.has(status);
    }
    ```
  - In `summarizeTension`, change
    `const faulted = chameleonChannelFaulted(device, channel);`
    to
    `const faulted = chameleonChannelFaulted(device, channel) || watermarkChannelFaulted(device, channel);`.

  Rerun Step 1's command; expected: PASS.

- [ ] **Step 3: Write the failing settings test** `web/react-gui/tests/watermarkCalibration.test.ts`. Follow `tests/draginoSettings.test.ts` exactly: JSDOM setup, `renderToStaticMarkup` or act-based render, and API mocking by reassigning `lsn50API` and `deviceMetadataAPI` methods and restoring them afterwards. Cover:
  - **(a)** It loads with `getWatermarkCalibration` → `{sync_version:0, calibration:null}` and renders eight empty inputs and a disabled Save.
  - **(b)** After filling valid values and clicking Preview, `previewWatermarkCalibration` is called with numbers, not strings, and the per-probe result renders.
  - **(c)** Save calls `saveWatermarkCalibration(deveui, values, 0)`, then calls `onUpdate`.
  - **(d)** A 409 from save shows `watermark.calibration.conflict` and reloads via `getWatermarkCalibration`.
  - **(e)** A 400 with `field: 'series_rev_2_ohm'` shows `watermark.calibration.invalidField`.
  - **(f)** `WatermarkDepthSection` with `soil_moisture_probe_depths_json: {swt_1: 20}`:
    - shows 20 and an empty probe 2;
    - on save with probe 2 = 40, calls `deviceMetadataAPI.setSoilMoistureDepths(deveui, { swt_1: 20, swt_2: 40 })` and keeps every other key already present in the device's JSON.

  Run: `cd web/react-gui && npx tsx --test tests/watermarkCalibration.test.ts`. Expected: FAIL (modules missing).

- [ ] **Step 4: Implement** `web/react-gui/src/components/farming/WatermarkCalibrationSection.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isAxiosError } from 'axios';
import { lsn50API } from '../../services/api';
import type { Device, WatermarkCalibrationValues, WatermarkPreviewChannel } from '../../types/farming';

const FIELDS: Array<{ key: keyof WatermarkCalibrationValues; label: 'pullup' | 'pulldown' | 'seriesFwd' | 'seriesRev'; channel: 1 | 2 }> = [
  { key: 'pullup_1_ohm', label: 'pullup', channel: 1 },
  { key: 'pulldown_1_ohm', label: 'pulldown', channel: 1 },
  { key: 'series_fwd_1_ohm', label: 'seriesFwd', channel: 1 },
  { key: 'series_rev_1_ohm', label: 'seriesRev', channel: 1 },
  { key: 'pullup_2_ohm', label: 'pullup', channel: 2 },
  { key: 'pulldown_2_ohm', label: 'pulldown', channel: 2 },
  { key: 'series_fwd_2_ohm', label: 'seriesFwd', channel: 2 },
  { key: 'series_rev_2_ohm', label: 'seriesRev', channel: 2 },
];

type Draft = Record<keyof WatermarkCalibrationValues, string>;
const EMPTY: Draft = Object.fromEntries(FIELDS.map((f) => [f.key, ''])) as Draft;

function toValues(draft: Draft): WatermarkCalibrationValues | null {
  const out: Partial<WatermarkCalibrationValues> = {};
  for (const f of FIELDS) {
    const n = Number(draft[f.key]);
    if (draft[f.key].trim() === '' || !Number.isFinite(n)) return null;
    out[f.key] = n;
  }
  return out as WatermarkCalibrationValues;
}

function describeChannel(ch: WatermarkPreviewChannel | undefined, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (!ch) return '—';
  if (ch.kpa != null) return `${ch.kpa} kPa`;
  if (ch.status === 'wet_offset_clipped' && ch.kpa_upper_bound != null) return t('watermark.wetUpTo', { value: `${ch.kpa_upper_bound} kPa` });
  return ch.status ? t(`watermark.status.${ch.status}`) : '—';
}

export function WatermarkCalibrationSection({ device, onUpdate }: { device: Device; onUpdate?: () => void }) {
  const { t } = useTranslation('devices');
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [syncVersion, setSyncVersion] = useState<number | null>(null);
  const [hasCalibration, setHasCalibration] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const state = await lsn50API.getWatermarkCalibration(device.deveui);
      setSyncVersion(state.sync_version);
      setHasCalibration(state.calibration !== null);
      setDraft(state.calibration
        ? (Object.fromEntries(FIELDS.map((f) => [f.key, String(state.calibration![f.key])])) as Draft)
        : EMPTY);
    } catch {
      setMessage(t('watermark.calibration.loadFailed'));
    }
  }, [device.deveui, t]);

  useEffect(() => { void load(); }, [load]);

  const handleError = async (error: unknown) => {
    if (isAxiosError(error) && error.response?.status === 409) {
      setMessage(t('watermark.calibration.conflict'));
      await load();
      return;
    }
    if (isAxiosError(error) && error.response?.status === 400 && error.response.data?.field) {
      setMessage(t('watermark.calibration.invalidField', { field: error.response.data.field }));
      return;
    }
    setMessage(isAxiosError(error) ? String(error.response?.data?.message ?? error.message) : String(error));
  };

  const values = toValues(draft);

  const onPreview = async () => {
    if (!values) return;
    setBusy(true); setMessage(null);
    try {
      const res = await lsn50API.previewWatermarkCalibration(device.deveui, values);
      setPreview(res.preview
        ? t('watermark.calibration.previewResult', { p1: describeChannel(res.preview.channels[0], t), p2: describeChannel(res.preview.channels[1], t) })
        : t('watermark.calibration.previewEmpty'));
    } catch (error) { await handleError(error); } finally { setBusy(false); }
  };

  const onSave = async () => {
    if (!values || syncVersion === null) return;
    setBusy(true); setMessage(null);
    try {
      const res = await lsn50API.saveWatermarkCalibration(device.deveui, values, syncVersion);
      setSyncVersion(res.sync_version);
      setHasCalibration(true);
      setMessage(t('watermark.calibration.saved', { count: res.backfilled }));
      onUpdate?.();
    } catch (error) { await handleError(error); } finally { setBusy(false); }
  };

  const onDelete = async () => {
    if (syncVersion === null || !window.confirm(t('watermark.calibration.confirmDelete'))) return;
    setBusy(true); setMessage(null);
    try {
      const res = await lsn50API.deleteWatermarkCalibration(device.deveui, syncVersion);
      setSyncVersion(res.sync_version);
      setHasCalibration(false);
      setDraft(EMPTY);
      setMessage(t('watermark.calibration.deleted'));
      onUpdate?.();
    } catch (error) { await handleError(error); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      {[1, 2].map((channel) => (
        <fieldset key={channel} className="grid grid-cols-2 gap-2">
          <legend className="col-span-2 text-xs font-semibold text-[var(--text-secondary)]">{t('watermark.calibration.channel', { n: channel })}</legend>
          {FIELDS.filter((f) => f.channel === channel).map((f) => (
            <label key={f.key} className="text-xs text-[var(--text-secondary)]">
              {t(`watermark.calibration.${f.label}`)}
              <input
                name={f.key}
                inputMode="decimal"
                value={draft[f.key]}
                onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)]"
              />
            </label>
          ))}
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy || !values} onClick={onPreview} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm">{t('watermark.calibration.preview')}</button>
        <button type="button" disabled={busy || !values || syncVersion === null} onClick={onSave} className="rounded-md bg-[var(--primary)] px-3 py-1.5 text-sm text-[var(--primary-contrast)]">{t('watermark.calibration.save')}</button>
        {hasCalibration && (
          <button type="button" disabled={busy} onClick={onDelete} className="rounded-md border border-[var(--error-border)] px-3 py-1.5 text-sm text-[var(--error-text)]">{t('watermark.calibration.delete')}</button>
        )}
      </div>
      {preview && <p className="text-xs text-[var(--text-secondary)]">{preview}</p>}
      {message && <p className="text-xs text-[var(--text-secondary)]">{message}</p>}
    </div>
  );
}
```

Before relying on them, check that the CSS tokens used here (`--primary`, `--primary-contrast`, `--error-border`) exist, with `grep -rn "\-\-primary-contrast\|\-\-error-border" web/react-gui/src/index.css`. Replace any that don't with the ones `DraginoChameleonSwtSection.tsx` uses for its primary and destructive buttons.

Then implement `web/react-gui/src/components/farming/WatermarkDepthSection.tsx`:

```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { deviceMetadataAPI } from '../../services/api';
import type { Device } from '../../types/farming';

// Probe depths use the existing generic soil_moisture_probe_depths_json
// mechanism (spec section 6), keyed swt_1 / swt_2 like KIWI's.
export function WatermarkDepthSection({ device, onUpdate }: { device: Device; onUpdate?: () => void }) {
  const { t } = useTranslation('devices');
  const current = device.soil_moisture_probe_depths_json ?? {};
  const [depths, setDepths] = useState<Record<'swt_1' | 'swt_2', string>>({
    swt_1: current.swt_1 != null ? String(current.swt_1) : '',
    swt_2: current.swt_2 != null ? String(current.swt_2) : '',
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const onSave = async () => {
    const next: Record<string, number> = { ...current };
    for (const key of ['swt_1', 'swt_2'] as const) {
      const raw = depths[key].trim();
      if (raw === '') delete next[key];
      else next[key] = Number(raw);
    }
    setBusy(true); setMessage(null);
    try {
      await deviceMetadataAPI.setSoilMoistureDepths(device.deveui, next);
      setMessage(t('watermark.depths.saved'));
      onUpdate?.();
    } catch (error) {
      setMessage(String((error as { response?: { data?: { message?: string } } })?.response?.data?.message ?? error));
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2">
        {(['swt_1', 'swt_2'] as const).map((key, i) => (
          <label key={key} className="text-xs text-[var(--text-secondary)]">
            {t('watermark.depths.depth', { n: i + 1 })}
            <input
              name={`depth_${key}`}
              inputMode="numeric"
              value={depths[key]}
              onChange={(e) => setDepths((d) => ({ ...d, [key]: e.target.value }))}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-sm text-[var(--text)]"
            />
          </label>
        ))}
      </div>
      <button type="button" disabled={busy} onClick={onSave} className="rounded-md border border-[var(--border)] px-3 py-1.5 text-sm">{t('watermark.depths.save')}</button>
      {message && <p className="text-xs text-[var(--text-secondary)]">{message}</p>}
    </div>
  );
}
```

Check `deviceMetadataAPI.setSoilMoistureDepths`'s exact signature at `services/api.ts:1023-1033` and match it. The edge validates depths as whole centimetres, 1–1000 (`put-soil-depth-fn`), and its 400 message is shown as-is.

- [ ] **Step 5: Mount both in `DraginoSettingsModal.tsx`.** Place them after the "Chameleon SWT" `SettingsSection` and before "Dendrometer calibration":

```tsx
          {device.latest_data?.watermark != null && (
            <>
              <SettingsSection title={t('watermark.depths.title')} className="mt-3">
                <WatermarkDepthSection device={device} onUpdate={onUpdate} />
              </SettingsSection>
              <SettingsSection
                title={t('watermark.calibration.title')}
                description={t('watermark.calibration.description')}
                className="mt-3"
              >
                <WatermarkCalibrationSection device={device} onUpdate={onUpdate} />
              </SettingsSection>
            </>
          )}
```

If the modal has no `t` binding yet, add `const { t } = useTranslation('devices');`.

- [ ] **Step 6: Run the checks.**

```bash
cd web/react-gui
npx tsx --test tests/watermarkCalibration.test.ts tests/draginoSettings.test.ts
npx vitest run src/utils/__tests__/zoneSoil.test.ts
npm run typecheck
```
Expected: all pass.

- [ ] **Step 7: Commit.**

```bash
git add -A web/react-gui/src web/react-gui/tests
git commit -m "feat(gui): WATERMARK calibration (preview, conflicts) and probe depths; zone summary counts WATERMARK probes"
```

---

### Task 11: Locales, docs and the full gate sweep

**Files:**
- Modify: `web/react-gui/public/locales/{de-CH,fr,it,es,pt,lg}/devices.json`, `docs/i18n/pending-luganda-translations.md`, `AGENTS.md`
- Create: `web/react-gui/tests/watermarkLocales.test.ts`

**Interfaces:**
- Consumes: the English `watermark` group from Task 9.

- [ ] **Step 1: Write the failing locale test** `web/react-gui/tests/watermarkLocales.test.ts`, copying `tests/renameLocales.test.ts`. Change it so it:
  - collects every leaf key under `devices.json` → `watermark`;
  - asserts every key exists in all 7 locales, with identical `{{placeholders}}`;
  - asserts the five European locales differ from `en` for every key except those in an `IDENTICAL_OK` set: `watermark.status.ok`, `watermark.wetUpTo`, and `watermark.calibration.pullup`, `pulldown`, `seriesFwd`, `seriesRev` (units, symbols and "OK" may legitimately match);
  - asserts `lg` is byte-identical to `en` for every key in `PENDING_HUMAN_LUGANDA` (all watermark keys).

  Run: `cd web/react-gui && npx tsx --test tests/watermarkLocales.test.ts`. Expected: FAIL (keys missing).

- [ ] **Step 2: Add the translations.**
  - Translate the English `watermark` group into `de-CH` (Swiss spelling: "ss", never "ß"), `fr`, `it`, `es` and `pt`, keeping every `{{placeholder}}` verbatim.
  - Keep "WATERMARK" untranslated; it is the product name.
  - Copy the English group unchanged into `lg`.
  - Add a section to `docs/i18n/pending-luganda-translations.md` in the existing per-feature format:
    `## \`devices.json\` — WATERMARK soil tension`, with a `| Keys | Reason |` row naming `watermark.*`, and a line saying it is tracked in `web/react-gui/tests/watermarkLocales.test.ts` (`PENDING_HUMAN_LUGANDA`).

  Rerun Step 1's command; expected: PASS.

- [ ] **Step 3: Correct the stale backfill guidance in `AGENTS.md`** (spec §3). The line near 146 tells you to enqueue corrected `DEVICE_DATA_APPENDED` events after historical `device_data` updates. Replace that sentence with:

  > Historical repairs that UPDATE `device_data` rows are carried by the `trg_sync_device_data_dirty_au` trigger → `sync_history_dirty_keys` → history correction phase. Do not enqueue explicit `DEVICE_DATA_APPENDED` events for them: every such event has `sync_version` 0, and the cloud rejects a changed payload at an equal version as `equal_version_payload_conflict`. Update by row `id`: `device_data` has no UNIQUE(deveui, recorded_at).

  Then check whether `.claude/skills/osi-sync-contract-awareness/SKILL.md` "Trigger Gotcha" repeats the stale advice (`grep -n "DEVICE_DATA_APPENDED" .claude/skills/osi-sync-contract-awareness/SKILL.md`), and apply the same correction there.

- [ ] **Step 4: Run the full edge gate sweep** from the worktree root:

```bash
for f in conversion store; do node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-watermark-helper/$f.test.js || exit 1; done
node scripts/verify-lsn50-watermark-codec.js && node scripts/verify-lsn50-chameleon-codec.js && node scripts/verify-codec-robustness.js
node scripts/test-watermark-ingest-flow.js && node scripts/test-watermark-calibration-routes.js
node scripts/verify-migrations.js && node scripts/verify-seed-replay.js && node scripts/verify-seed-db-ledger.js
node scripts/verify-db-schema-consistency.js && node scripts/verify-runtime-schema-parity.js && node scripts/verify-no-stray-ddl.js
node scripts/verify-helper-registration.js && node scripts/verify-module-file-deploy-coverage.js && node scripts/verify-osi-lib-db-caller-binding.js
node scripts/verify-flows-size-ratchet.js && node scripts/verify-flows-fn-parse.js && node scripts/verify-flows-output-arity.js
node scripts/verify-scoped-access.js && node --test scripts/test-scoped-access-writes.js && node scripts/test-flows-wiring.js
node scripts/verify-auth-flag-off-hermetic.js && node --test scripts/verify-auth-flag-off-hermetic.test.js
node scripts/verify-sync-flow.js && node scripts/verify-profile-parity.js
node --test lib/osi-migrate/__tests__/*.test.js && node --test scripts/reconcile-ledger-numbering.test.js
```
Expected: every command exits 0. Report the real output of any failure; do not pipe through `tail`.

- [ ] **Step 5: Run the GUI suite, then build once.** Only one frontend build at a time on this workstation.

```bash
cd web/react-gui && npm run test:unit && npm run typecheck && npm run build
```
Expected: all pass.

- [ ] **Step 6: Commit.**

```bash
git add -A web/react-gui/public/locales web/react-gui/tests docs/i18n/pending-luganda-translations.md AGENTS.md .claude/skills/osi-sync-contract-awareness/SKILL.md
git commit -m "feat(i18n): WATERMARK strings in all locales (lg pending human); docs: correct stale device_data backfill guidance"
```

---

## Phase 3 bench questions recorded here (not tasks)

- Clip detection uses only the exact rail codes 0 and 4095. The review confirmed the values are continuous across the rail (code 4094 gives 1331 Ω / 11.2 kPa; 4095 gives a bound of 1325 Ω / 11.2 kPa), so nothing honest is hidden. Whether the real ADC saturates exactly at the rail, and what a clipped *and* unsettled sample means, needs bench evidence from the dry-down run.
- The acceptance envelope for unsettled readings (spec §5.2) is set by that same dry-down run.
