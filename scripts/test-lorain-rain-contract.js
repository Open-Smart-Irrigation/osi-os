'use strict';
// Replays the LoRain rain fixtures (scripts/fixtures/lorain-rain) through the
// shipped codec and checks them against the truth table in
// docs/contracts/rainfall/lorain.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const DIR = path.join(ROOT, 'scripts/fixtures/lorain-rain');
const CONTRACT = fs.readFileSync(path.join(ROOT, 'docs/contracts/rainfall/lorain.md'), 'utf8');
const codecPath = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/codecs/aquascope_lorain_decoder.js');

const TRUTH_ROWS = 16;
const BASES = ['protocol_verified', 'reception_gap', 'unknown'];
const KINDS = ['ordinary', 'heartbeat_zero', 'button', 'alarm', 'config', 'status'];
const REASONS = [null, 'received_only', 'frame_gap', 'session_reset', 'duplicate', 'alarm_event', 'overlap_unqualified',
  'config_change', 'config_mismatch', 'invalid_tips', 'boundary_allocation', 'ongoing', 'identity_conflict',
  'build_unpinned', 'multi_block'];
// Block lengths after the command byte, as the codec reads them.
const BLOCK_LEN = { 0x03: 3, 0x04: 3, 0x06: 3, 0x0a: 4, 0x0b: 4, 0x12: 3 };
// Reference configuration (contract, "Reference configuration"): 900 s wakes, heartbeat every 16 wakes.
const REFERENCE = { conf_interval: 900, conf_heartbeat: 16 };
const GRID_TOLERANCE_S = 60;

function decoder() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(codecPath, 'utf8'), sandbox, { filename: codecPath });
  return sandbox.decodeUplink;
}
const decodeUplink = decoder();
const fixtures = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).sort()
  .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8')) }));

function decoded(frame) {
  if (frame.object) return frame.object;
  const result = decodeUplink({ fPort: frame.fPort, bytes: Buffer.from(frame.bytesHex, 'hex') });
  assert.equal(result.errors.length, 0, 'codec errors: ' + result.errors.join('; '));
  assert.equal(result.warnings.length, 0, 'codec warnings: ' + result.warnings.join('; '));
  return result.data;
}

// Every `06 81` rain block in the payload. The codec keeps only the last one (row T16).
function rainBlocks(frame) {
  if (!frame.bytesHex) return null;
  const bytes = Buffer.from(frame.bytesHex, 'hex');
  const blocks = [];
  for (let i = 0; i < bytes.length;) {
    const len = BLOCK_LEN[bytes[i]];
    assert.ok(len, `unknown block 0x${bytes[i].toString(16)} in ${frame.bytesHex}`);
    if (bytes[i] === 0x06 && bytes[i + 1] === 0x81) blocks.push(bytes.readUInt16BE(i + 2));
    i += 1 + len;
  }
  return blocks;
}

const validTips = (tips) => Number.isInteger(tips) && tips >= 0;
const seconds = (frame) => Date.parse(frame.time) / 1000;
const offGrid = (delta, interval) => Math.abs(delta - Math.round(delta / interval) * interval);

test('every truth row T1..T14 has a fixture and a contract row', () => {
  for (let i = 1; i <= TRUTH_ROWS; i += 1) {
    const id = 'T' + i;
    assert.ok(fixtures.some((f) => f.truthRows.includes(id)), `fixture for ${id}`);
    assert.match(CONTRACT, new RegExp('\\|\\s*`?' + id + '`?\\s*\\|'), `contract row ${id}`);
  }
});

test('the pinned vendor revision and the promotion rule are stated', () => {
  assert.match(CONTRACT, /04ac8e3b67d7be54976a2f463e935a03cdbbab64/);
  assert.match(CONTRACT, /Interval basis \(installed revision unknown\)/);
  assert.match(CONTRACT, /Interval basis \(pinned revision proven installed\)/);
  assert.match(CONTRACT, /move from the "installed revision unknown" column to the "pinned revision proven installed" column automatically/);
});

for (const fixture of fixtures) {
  test(`${fixture.file}: decoded amounts match the expectation`, () => {
    assert.equal(fixture.expect.observations.length, fixture.frames.length, 'one observation per frame');
    const seen = new Set();
    const seenSlots = new Map();
    assert.deepEqual(fixture.promotedConfig, { conf_interval: 900, conf_heartbeat: 16, fPort: 2 }, 'promotedConfig');
    for (const exp of fixture.expect.observations) {
      const frame = fixture.frames[exp.frameIndex];
      const object = decoded(frame);
      const codecTips = object.rain_tips_delta === undefined ? null : object.rain_tips_delta;
      const blocks = rainBlocks(frame);
      let tips = codecTips;
      if (blocks && blocks.length > 1) {
        tips = blocks.reduce((a, b) => a + b, 0);
        assert.equal(codecTips, exp.codec_tips, 'T16: the current codec keeps only the last rain block');
        assert.equal(exp.reason, 'multi_block', 'T16: a multi-block frame is not certified');
      } else if (blocks) {
        assert.equal(codecTips, blocks.length ? blocks[0] : null, 'codec tips match the payload');
      }
      assert.deepEqual(tips, exp.tips, `frame ${exp.frameIndex}: tips`);
      if (exp.counted) {
        assert.ok(validTips(tips), `frame ${exp.frameIndex}: a counted amount has a non-negative integer tip count`);
        if (!blocks || blocks.length <= 1) assert.equal(object.rain_mm_delta, exp.amount_mm);
        assert.equal(exp.amount_mm, exp.tips * 0.5, 'amount = tips x 0.5 mm');
      } else {
        assert.equal(exp.amount_mm, null, `frame ${exp.frameIndex}: no amount when not counted`);
      }
      if (!validTips(tips) && tips !== null) {
        assert.equal(exp.counted, false, 'T12: an invalid tip count is rejected');
        assert.equal(exp.reason, 'invalid_tips');
      }
      if (exp.frame_kind === 'alarm' || exp.frame_kind === 'button') {
        assert.equal(exp.counted, false, `T8/T10: ${exp.frame_kind} frames carry no additive amount`);
      }
      if (exp.frame_kind === 'heartbeat_zero') assert.equal(tips, 0, 'a heartbeat carries zero tips');
      const slot = frame.devAddr + '/' + frame.fCnt;
      if (seen.has(frame.deduplicationId)) {
        assert.equal(exp.counted, false, 'T5: a repeated deduplicationId is not counted again');
        assert.equal(exp.reason, 'duplicate');
      } else if (seenSlots.has(slot)) {
        const same = seenSlots.get(slot) === String(frame.bytesHex);
        assert.equal(exp.counted, false, 'T5: a repeated session and fCnt is not counted again');
        assert.equal(exp.reason, same ? 'duplicate' : 'identity_conflict', 'T5: equal payload = duplicate, different = conflict');
      }
      seen.add(frame.deduplicationId);
      if (!seenSlots.has(slot)) seenSlots.set(slot, String(frame.bytesHex));
      if (frame.fPort !== fixture.promotedConfig.fPort) {
        assert.notEqual(exp.interval_basis_promoted, 'protocol_verified', 'T15: an unpinned port is never promoted');
        if (!['duplicate', 'identity_conflict'].includes(exp.reason)) assert.equal(exp.reason, 'build_unpinned', 'T15');
      }
      for (const key of ['fw_version', 'alarm_value', 'conf_interval', 'conf_heartbeat']) {
        if (exp[key] !== undefined) assert.equal(object[key], exp[key], `frame ${exp.frameIndex}: ${key}`);
      }
      assert.ok(KINDS.includes(exp.frame_kind), 'frame_kind');
      assert.ok(BASES.includes(exp.interval_basis), 'interval_basis');
      assert.ok(BASES.includes(exp.interval_basis_promoted), 'interval_basis_promoted');
      assert.ok(REASONS.includes(exp.reason), `reason ${exp.reason}`);
      if (fixture.config.firmwareRevision === 'unknown') {
        assert.notEqual(exp.interval_basis, 'protocol_verified', 'unknown firmware never yields a verified interval');
      }
      // After promotion a counted observation is certified exactly when no reason code holds it back.
      // A duplicate inherits the first delivery's basis.
      if (exp.reason !== null && exp.reason !== 'duplicate') {
        assert.notEqual(exp.interval_basis_promoted, 'protocol_verified', `frame ${exp.frameIndex}: ${exp.reason} is not verified`);
      }
      if (exp.reason === null && exp.counted) {
        assert.equal(exp.interval_basis_promoted, 'protocol_verified', `frame ${exp.frameIndex}: promoted and certified`);
      }
    }
  });

  test(`${fixture.file}: silent spans follow fCnt continuity`, () => {
    const byIndex = new Map(fixture.expect.observations.map((o) => [o.frameIndex, o]));
    for (const span of fixture.expect.spans) {
      const from = fixture.frames[span.fromFrameIndex];
      const to = fixture.frames[span.toFrameIndex];
      const sameSession = from.devAddr === to.devAddr && to.fCnt > from.fCnt;
      if (span.state === 'dry') {
        assert.equal(span.reason, null);
        assert.ok(sameSession && to.fCnt === from.fCnt + 1, 'T13: a dry span needs consecutive fCnt in one session');
        assert.equal(from.fPort, fixture.promotedConfig.fPort, 'T15: no dry span on an unpinned port');
        const limit = REFERENCE.conf_heartbeat * REFERENCE.conf_interval + GRID_TOLERANCE_S;
        assert.ok(seconds(to) - seconds(from) <= limit, 'T13: a dry span is bounded by the heartbeat period');
      } else {
        assert.equal(span.state, 'unknown');
        if (span.reason === 'frame_gap') assert.ok(sameSession && to.fCnt > from.fCnt + 1, 'T14: frame_gap needs a missing fCnt');
        else if (span.reason === 'session_reset') assert.ok(!sameSession, 'T7: session_reset needs a new session');
        else if (span.reason === 'config_change') assert.ok(decoded(to).conf_interval !== undefined, 'T11: the later frame reports a new configuration');
        else if (span.reason === 'build_unpinned') assert.notEqual(to.fPort, fixture.promotedConfig.fPort, 'T15: the port is unpinned');
        else if (span.reason === 'multi_block') assert.ok(rainBlocks(to).length > 1, 'T16: the later frame carries several rain blocks');
        else assert.fail(`unexpected span reason ${span.reason}`);
      }
    }
    // Every fCnt gap inside a session is declared as an unknown span (T4, T14).
    const sessions = new Map();
    fixture.frames.forEach((frame, index) => {
      if (!sessions.has(frame.devAddr)) sessions.set(frame.devAddr, []);
      const list = sessions.get(frame.devAddr);
      if (!list.some((f) => f.frame.fCnt === frame.fCnt)) list.push({ frame, index });
    });
    for (const list of sessions.values()) {
      list.sort((a, b) => a.frame.fCnt - b.frame.fCnt);
      for (let i = 1; i < list.length; i += 1) {
        if (list[i].frame.fCnt - list[i - 1].frame.fCnt > 1) {
          assert.ok(fixture.expect.spans.some((s) => s.fromFrameIndex === list[i - 1].index && s.toFrameIndex === list[i].index
            && s.state === 'unknown' && s.reason === 'frame_gap'), `fCnt gap before ${list[i].frame.fCnt} is declared`);
          assert.equal(byIndex.get(list[i].index).interval_basis_promoted, 'unknown', 'the frame after a gap is not verified');
        }
      }
    }
  });

  test(`${fixture.file}: loop frames sit on the wake grid, button frames do not`, () => {
    const sessions = new Map();
    fixture.expect.observations.forEach((exp) => {
      const frame = fixture.frames[exp.frameIndex];
      if (exp.reason === 'duplicate' || exp.reason === 'identity_conflict' || frame.object) return;
      if (!sessions.has(frame.devAddr)) sessions.set(frame.devAddr, []);
      sessions.get(frame.devAddr).push({ frame, exp });
    });
    for (const list of sessions.values()) {
      list.sort((a, b) => a.frame.fCnt - b.frame.fCnt);
      let interval = fixture.config.conf_interval || REFERENCE.conf_interval;
      let previousLoop = null;
      let previousExp = null;
      let pairPending = false;
      for (const { frame, exp } of list) {
        if (exp.frame_kind === 'alarm') continue;
        if (previousLoop) {
          const delta = seconds(frame) - seconds(previousLoop);
          if (exp.frame_kind === 'button') {
            assert.ok(offGrid(delta, interval) > GRID_TOLERANCE_S, 'T10: a button report lies off the wake grid');
            continue;
          }
          if (delta < interval - GRID_TOLERANCE_S) {
            // Two rain frames in one wake slot (T10): neither additive, the next loop frame not certified.
            for (const e of [previousExp, exp]) {
              assert.equal(e.reason, 'overlap_unqualified', `fCnt ${frame.fCnt}: same-slot pair`);
              assert.equal(e.counted, false, `fCnt ${frame.fCnt}: same-slot frames are not additive`);
            }
            pairPending = true;
            continue;
          }
          assert.ok(offGrid(delta, interval) <= GRID_TOLERANCE_S, `fCnt ${frame.fCnt}: on the ${interval} s wake grid`);
          if (pairPending) {
            assert.equal(exp.reason, 'overlap_unqualified', 'T10: the loop frame after a same-slot pair is not certified');
            pairPending = false;
          }
        }
        previousLoop = frame;
        previousExp = exp;
        const conf = decoded(frame).conf_interval;
        if (conf !== undefined) interval = conf;
      }
    }
  });
}

test('identifiers are synthetic', () => {
  for (const fixture of fixtures) {
    for (const frame of fixture.frames) {
      assert.match(frame.deduplicationId, /^00000000-0000-4000-8000-0000000000\d\d$/);
      assert.match(frame.devAddr, /^0[0-9]0000\d\d$/);
    }
  }
});
