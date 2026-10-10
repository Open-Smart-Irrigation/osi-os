'use strict';
// osi-rain: LoRain frame classification against the contract truth table
// (docs/contracts/rainfall/lorain.md) and its replay fixtures
// (scripts/fixtures/lorain-rain), plus the zone-day window and identity helpers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const R = require('./index.js');

const ROOT = path.resolve(__dirname, '../../../../../../..');
const FIXTURE_DIR = path.join(ROOT, 'scripts/fixtures/lorain-rain');
const CONTRACT = path.join(ROOT, 'docs/contracts/rainfall/lorain.md');
const NODE_RED = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const CODEC = path.join(NODE_RED, 'codecs/aquascope_lorain_decoder.js');

// The fixtures carry no 0x0A block before their first frame; promotion needs a
// recorded build date, so the test records one and pins exactly that pair.
const TEST_BUILD = '241015';
const TEST_PINNED = [{ fPort: 2, buildDate: TEST_BUILD }];

function codec() {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(CODEC, 'utf8'), sandbox, { filename: CODEC });
  return sandbox.decodeUplink;
}
const decodeUplink = codec();
const fixtures = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json')).sort()
  .map((f) => ({ file: f, ...JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')) }));

function chainFrames(fixture) {
  return fixture.frames.map((frame) => {
    const data = frame.bytesHex ? Buffer.from(frame.bytesHex, 'hex').toString('base64') : undefined;
    const object = frame.object || decodeUplink({ fPort: frame.fPort, bytes: Buffer.from(frame.bytesHex, 'hex') }).data;
    return R.loRainChainFrame({
      deveui: 'A840410000000001', eventId: frame.deduplicationId, devAddr: frame.devAddr, fCnt: frame.fCnt,
      time: frame.time, fPort: frame.fPort, data, object,
    });
  });
}
const receivedOnlyConfig = (fixture) => ({
  confInterval: fixture.config.conf_interval, confHeartbeatWakes: fixture.config.conf_heartbeat, fPort: null, buildDate: null,
});
const promotedConfig = (fixture) => ({
  confInterval: fixture.promotedConfig.conf_interval, confHeartbeatWakes: fixture.promotedConfig.conf_heartbeat,
  fPort: fixture.promotedConfig.fPort, buildDate: TEST_BUILD,
});

for (const fixture of fixtures) {
  test(`${fixture.file}: received-only classification matches the fixture`, () => {
    const result = R.assessLoRainChain(chainFrames(fixture), {
      config: receivedOnlyConfig(fixture), pinnedBuilds: TEST_PINNED, firstFrameContinuous: true,
    });
    for (const exp of fixture.expect.observations) {
      const got = result.observations[exp.frameIndex];
      const where = `frame ${exp.frameIndex}`;
      assert.equal(got.frameKind, exp.frame_kind, `${where}: frame_kind`);
      assert.deepEqual(got.tips, exp.tips, `${where}: tips`);
      assert.equal(got.amountMm, exp.amount_mm, `${where}: amount_mm`);
      assert.equal(got.counted, exp.counted, `${where}: counted`);
      assert.equal(got.intervalBasis, exp.interval_basis, `${where}: interval_basis`);
      if (!['duplicate', 'identity_conflict'].includes(got.reason)) {
        assert.equal(got.counted, got.status === 'accepted', `${where}: counted <=> status accepted`);
      }
    }
  });

  test(`${fixture.file}: promoted classification matches the fixture`, () => {
    const result = R.assessLoRainChain(chainFrames(fixture), {
      config: promotedConfig(fixture), pinnedBuilds: TEST_PINNED, firstFrameContinuous: true,
    });
    for (const exp of fixture.expect.observations) {
      const got = result.observations[exp.frameIndex];
      const where = `frame ${exp.frameIndex}`;
      assert.equal(got.intervalBasis, exp.interval_basis_promoted, `${where}: interval_basis_promoted`);
      assert.equal(got.reason, exp.reason, `${where}: reason`);
      assert.equal(got.counted, exp.counted, `${where}: counted`);
      assert.equal(got.frameKind, exp.frame_kind, `${where}: frame_kind`);
      if (got.intervalBasis === 'protocol_verified') {
        assert.equal(Date.parse(got.measuredEnd) - Date.parse(got.measuredStart) > 0, true, `${where}: verified bounds`);
      } else {
        assert.equal(got.measuredStart, null, `${where}: no bounds without a verified interval`);
      }
    }
    for (const span of fixture.expect.spans) {
      const got = result.spans.find((s) => s.fromIndex === span.fromFrameIndex && s.toIndex === span.toFrameIndex);
      assert.ok(got, `span ${span.fromFrameIndex}->${span.toFrameIndex} computed`);
      assert.equal(got.state, span.state, `span ${span.fromFrameIndex}->${span.toFrameIndex}: state`);
      assert.equal(got.reason, span.reason, `span ${span.fromFrameIndex}->${span.toFrameIndex}: reason`);
    }
  });
}

test('T15: no frame on an unpinned port is promoted or yields a dry span', () => {
  for (const fixture of fixtures) {
    const frames = chainFrames(fixture).map((f) => ({ ...f, fPort: 10 }));
    const result = R.assessLoRainChain(frames, { config: promotedConfig(fixture), pinnedBuilds: TEST_PINNED, firstFrameContinuous: true });
    assert.ok(result.observations.every((o) => o.intervalBasis !== 'protocol_verified'), fixture.file);
    assert.ok(result.spans.every((s) => s.state !== 'dry'), fixture.file);
  }
});

test('the shipped pinned set is empty, so no installed gauge is promoted today (D8)', () => {
  assert.deepEqual(R.PINNED_LORAIN_BUILDS, []);
  const t01 = fixtures.find((f) => f.id === 'wet-ordinary');
  const result = R.assessLoRainChain(chainFrames(t01), { config: promotedConfig(t01), firstFrameContinuous: true });
  assert.ok(result.observations.every((o) => o.intervalBasis === 'unknown'));
  assert.ok(result.observations.every((o) => o.reasons.includes('build_unpinned')));
});

test('a build date that changes after a rejoin ends promotion until a new configuration reply', () => {
  const t07 = fixtures.find((f) => f.id === 'rejoin-fcnt-reuse');
  const frames = chainFrames(t07);
  frames[2] = { ...frames[2], facts: { ...frames[2].facts, buildDate: '250101' } };
  const pinned = TEST_PINNED.concat([{ fPort: 2, buildDate: '250101' }]);
  const result = R.assessLoRainChain(frames, { config: promotedConfig(t07), pinnedBuilds: pinned, firstFrameContinuous: true });
  assert.equal(result.observations[3].intervalBasis, 'unknown');
  assert.ok(result.observations[3].reasons.includes('received_only'));
});

test('T12: invalid tip counts are rejected measurements with diagnostic evidence', () => {
  const cases = [
    { rain_tips_delta: -1 }, { rain_tips_delta: 1.5 }, { rain_tips_delta: '2' },
    { rain_tips_delta: null, rainlevel: null }, { rain_tips_delta: NaN }, { rain_tips_delta: Infinity },
  ];
  for (const object of cases) {
    const got = R.classifyLoRainFrame(object, { confInterval: null, confHeartbeatWakes: null, fPort: 2, buildDate: null });
    assert.equal(got.status, 'rejected_invalid', JSON.stringify(object));
    assert.equal(got.amountMm, null);
    assert.ok(got.reasons.includes('invalid_tips'));
    assert.equal(got.frameKind, 'ordinary');
    assert.equal(got.intervalBasis, 'unknown');
  }
});

test('classifyLoRainFrame: kinds, amounts and the second argument as a port number', () => {
  const wet = R.classifyLoRainFrame({ rain_tips_delta: 3, rainlevel: 3, rain_mm_delta: 1.5 }, 2);
  assert.deepEqual({ k: wet.frameKind, t: wet.tips, a: wet.amountMm, s: wet.status }, { k: 'ordinary', t: 3, a: 1.5, s: 'accepted' });
  assert.equal(wet.intervalBasis, 'unknown', 'a single frame never proves continuity');
  const zero = R.classifyLoRainFrame({ rain_tips_delta: 0, ambient_temperature: 18.4, bat_v: 3.3, uptime_days: 5 }, 2);
  assert.equal(zero.frameKind, 'heartbeat_zero');
  assert.equal(zero.amountMm, 0);
  const alarm = R.classifyLoRainFrame({ alarm_status: 1, alarm_type: 3, alarm_value: 90 }, 2);
  assert.deepEqual({ k: alarm.frameKind, s: alarm.status, a: alarm.amountMm }, { k: 'alarm', s: 'not_additive', a: null });
  assert.ok(alarm.reasons.includes('alarm_event'));
  const config = R.classifyLoRainFrame({ conf_interval: 900, conf_heartbeat: 16 }, 2);
  assert.deepEqual({ k: config.frameKind, s: config.status }, { k: 'config', s: 'not_additive' });
  const status = R.classifyLoRainFrame({ hw_version: 5, fw_version: 241015, bat_v: 3.3 }, 2);
  assert.deepEqual({ k: status.frameKind, s: status.status }, { k: 'status', s: 'not_additive' });
  const multi = R.classifyLoRainFrame({ rain_tips_delta: 1 }, 2, { rainBlocks: [3, 1] });
  assert.deepEqual({ t: multi.tips, a: multi.amountMm }, { t: 4, a: 2 });
  assert.ok(multi.reasons.includes('multi_block'));
});

test('payloadRainBlocks reads every 06 81 block from the payload bytes (T16)', () => {
  const hex = '06030005060100b8068100031221000a06030005060100b8068100011221000a';
  assert.deepEqual(R.payloadRainBlocks(Buffer.from(hex, 'hex').toString('base64')), [3, 1]);
  assert.deepEqual(R.payloadRainBlocks(Buffer.from('0b0103005a', 'hex').toString('base64')), []);
  assert.equal(R.payloadRainBlocks(Buffer.from('ff00', 'hex').toString('base64')), null, 'unknown layout falls back to the codec');
  assert.equal(R.payloadRainBlocks(undefined), null);
});

test('zoneDayWindow: 25-hour autumn day in the zone timezone', () => {
  assert.deepEqual(R.zoneDayWindow('2026-10-24T23:15:00.000Z', 'Europe/Zurich'),
    { date: '2026-10-25', startIso: '2026-10-24T22:00:00.000Z', endIso: '2026-10-25T23:00:00.000Z' });
});

test('zoneDayWindow: 23-hour spring day in the zone timezone', () => {
  assert.deepEqual(R.zoneDayWindow('2026-03-29T10:00:00.000Z', 'Europe/Zurich'),
    { date: '2026-03-29', startIso: '2026-03-28T23:00:00.000Z', endIso: '2026-03-29T22:00:00.000Z' });
});

test('zoneDayWindow: a day that starts at 01:00 because DST begins at midnight (Cairo)', () => {
  assert.deepEqual(R.zoneDayWindow('2026-04-24T12:00:00.000Z', 'Africa/Cairo'),
    { date: '2026-04-24', startIso: '2026-04-23T22:00:00.000Z', endIso: '2026-04-24T21:00:00.000Z' });
});

test('zoneDayWindow: invalid or padded timezones', () => {
  assert.deepEqual(R.zoneDayWindow('2026-10-08T22:30:00.000Z', 'Mars/Olympus'),
    { date: '2026-10-08', startIso: '2026-10-08T00:00:00.000Z', endIso: '2026-10-09T00:00:00.000Z' });
  assert.equal(R.zoneDayWindow('2026-10-08T22:30:00.000Z', ' Europe/Zurich').date, '2026-10-09');
  assert.equal(R.zoneDayWindow('2026-10-08T22:30:00.000Z', null).date, '2026-10-08');
});

test('zoneDayWindow agrees with osi-history-helper.startOfLocalDayMs on DST dates', () => {
  const H = require(path.join(NODE_RED, 'osi-history-helper/index.js'));
  // Africa/Cairo begins DST at local midnight (2026-04-24), so that local date starts at 01:00.
  const zones = ['Europe/Zurich', 'America/Santiago', 'America/Sao_Paulo', 'Asia/Beirut', 'Africa/Cairo', 'Pacific/Auckland', 'Africa/Kampala', 'UTC'];
  const instants = ['2026-03-29T00:30:00Z', '2026-03-29T01:30:00Z', '2026-03-29T23:59:00Z', '2026-10-25T00:30:00Z',
    '2026-10-25T01:30:00Z', '2026-10-25T23:30:00Z', '2026-04-05T03:30:00Z', '2026-09-06T04:30:00Z', '2026-09-27T14:00:00Z',
    '2026-04-23T21:59:00Z', '2026-04-23T22:30:00Z', '2026-04-24T12:00:00Z'];
  for (const tz of zones) {
    for (const iso of instants) {
      const win = R.zoneDayWindow(iso, tz);
      assert.equal(win.startIso, new Date(H.startOfLocalDayMs(Date.parse(iso), tz)).toISOString(), `${tz} ${iso} start`);
      assert.ok(Date.parse(win.startIso) <= Date.parse(iso) && Date.parse(iso) < Date.parse(win.endIso), `${tz} ${iso} inside`);
      const next = new Date(H.startOfLocalDayMs(Date.parse(win.endIso), tz)).toISOString();
      assert.equal(win.endIso, next, `${tz} ${iso} end is the next day's start`);
    }
  }
});

test('payloadDigest: bytes when present, else canonical JSON of the object', () => {
  const a = R.payloadDigest({ fPort: 2, data: 'BgMABQ==' });
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, require('node:crypto').createHash('sha256').update('2:BgMABQ==').digest('hex'));
  assert.notEqual(a, R.payloadDigest({ fPort: 10, data: 'BgMABQ==' }));
  assert.equal(R.payloadDigest({ fPort: 2, object: { b: 1, a: { d: 2, c: 3 } } }),
    R.payloadDigest({ fPort: 2, object: { a: { c: 3, d: 2 }, b: 1 } }));
});

test('observationIdentity: device, event, session, time', () => {
  const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
  const id = R.observationIdentity({ deveui: 'a840410000000001', eventId: 'e-1', devAddr: '01000001', fCnt: 7,
    time: '2026-10-08T10:00:00.123456789+00:00', fPort: 2, data: 'BgMABQ==' }, { nowMs });
  assert.deepEqual({ ...id, digest: undefined }, { deveui: 'A840410000000001', eventId: 'e-1', devAddr: '01000001', fCnt: 7,
    receivedAt: '2026-10-08T10:00:00.123Z', digest: undefined });
  const bare = R.observationIdentity({ deveui: 'A840410000000001', time: '2099-01-01T00:00:00Z', fPort: 2, object: {} }, { nowMs });
  assert.deepEqual([bare.eventId, bare.devAddr, bare.fCnt, bare.receivedAt], [null, null, null, '2026-10-08T12:00:00.000Z']);
});

test('the received time clamp matches osi-device-writer.clampRecordedAt', () => {
  const W = require(path.join(NODE_RED, 'osi-device-writer/index.js'));
  const nowMs = Date.parse('2026-10-08T12:00:00.000Z');
  for (const raw of [undefined, null, '', 'garbage', '2023-12-31T23:59:59Z', '2026-10-08 10:00:00', '2026-10-08T12:59:00Z',
    '2026-10-08T13:00:01Z', '2026-10-08T10:00:00.123456789+00:00']) {
    assert.equal(R.clampReceivedAt(raw, nowMs), W.clampRecordedAt(raw, nowMs).recordedAt, String(raw));
  }
});

test('configuration query: the FPort-2 form equals the contract bytes; other ports have no form', () => {
  const expected = '000000000000000000000402040404030a00';
  const contract = fs.readFileSync(CONTRACT, 'utf8');
  assert.ok(contract.includes('`' + expected + '`'), 'the contract documents this form');
  assert.equal(R.loRainConfigQueryBytes(2).toString('hex'), expected);
  assert.equal(R.loRainConfigQueryBytes(2).length, 18);
  assert.equal(R.loRainConfigQueryBytes(2)[17], 0x00, 'mandatory trailing 00');
  assert.ok(!R.loRainConfigQueryBytes(2).includes(0x14), 'command 14 is never sent');
  assert.equal(R.loRainConfigQueryBytes(10), null, 'the FPort-10 build has no documented form');
  const msg = R.buildLoRainConfigQueryDownlink({ applicationId: 'app-1', deveui: 'A840410000000001', fPort: 2 });
  assert.deepEqual(msg, {
    topic: 'application/app-1/device/a840410000000001/command/down',
    payload: { devEui: 'a840410000000001', confirmed: false, fPort: 2, data: Buffer.from(expected, 'hex').toString('base64') },
  });
  assert.equal(R.buildLoRainConfigQueryDownlink({ applicationId: 'app-1', deveui: 'A840410000000001', fPort: 10 }), null);
  assert.equal(R.buildLoRainConfigQueryDownlink({ applicationId: '', deveui: 'A840410000000001', fPort: 2 }), null);
});

test('constants', () => {
  assert.equal(R.RAIN_POLICY_VERSION, 1);
  assert.equal(R.LORAIN_MM_PER_TIP, 0.5);
});

// ---------------------------------------------------------------------------
// SenseCAP S2120 (contract of the merged S2120 rain fix: 4213 is cumulative
// rainfall in mm and the only counter; 4113 is rain intensity in mm/h; firmware
// without 4213 integrates intensity / 6 only over a 600 s +/- 60 s interval).
// Expectations copied from scripts/test-s2120-rain-ingest.js; the test names
// cited in each case are the cases there.
// ---------------------------------------------------------------------------

const S2120_CODEC = path.join(NODE_RED, 'codecs/sensecap_s2120_decoder.js');
function s2120Codec() {
  const sandbox = { Buffer, console: { log() {} } };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(S2120_CODEC, 'utf8'), sandbox, { filename: S2120_CODEC });
  return sandbox.decodeUplink;
}
const decodeS2120 = s2120Codec();
const hex = (value, width) => Math.round(value).toString(16).toUpperCase().padStart(width, '0');
const s2120Intensity = (frameId, mmH) => frameId + '0156' + hex(mmH * 1000, 8) + '2703';
const s2120Cumulative = (mm) => '4C000B' + hex(mm * 1000, 8);
const s2120Object = (rawHex) => decodeS2120({ fPort: 5, bytes: [...Buffer.from(rawHex, 'hex')] }).data;

test('parseS2120Measurements: 4113 is intensity, 4213 cumulative (vendor example; "codec emits 4113 as intensity and 4213 as cumulative rainfall")', () => {
  const m = R.parseS2120Measurements(s2120Object('4B0156000000FE27034C000B000006F2'));
  assert.equal(m.rainMmPerHour, 0.254);
  assert.equal(m.rainGaugeCumulativeMm, 1.778);
  assert.equal(m.measurements['4113'], 0.254);
});

test('parseS2120Measurements: both message shapes, pressure in hPa, gust only from 4191, battery from 4103 or Battery(%)', () => {
  const group = [
    { measurementId: 4097, measurementValue: 18.2 }, { measurementId: 4098, measurementValue: 66.1 },
    { measurementId: 4099, measurementValue: 1234 }, { measurementId: 4101, measurementValue: 100870 },
    { measurementId: 4104, measurementValue: 182.4 }, { measurementId: 4105, measurementValue: 3.2 },
    { measurementId: 4190, measurementValue: 2.7 }, { measurementId: 4191, measurementValue: 7.6 },
    { measurementId: 4213, measurementValue: 12.4 }, { 'Battery(%)': 84 },
  ];
  for (const object of [{ messages: [group] }, { data: { messages: [group] } }]) {
    const m = R.parseS2120Measurements(object);
    assert.equal(m.ambientTemperature, 18.2);
    assert.equal(m.relativeHumidity, 66.1);
    assert.equal(m.lightLux, 1234);
    assert.ok(Math.abs(m.barometricPressureHpa - 1008.7) < 1e-9);
    assert.equal(m.windDirectionDeg, 182.4);
    assert.equal(m.windSpeedMps, 3.2);
    assert.equal(m.uvIndex, 2.7);
    assert.equal(m.windGustMps, 7.6, 'never the 4213 rain accumulation');
    assert.equal(m.rainGaugeCumulativeMm, 12.4);
    assert.equal(m.rainMmPerHour, null);
    assert.equal(m.batPct, 84);
  }
  assert.equal(R.parseS2120Measurements({ messages: [[{ measurementId: 4103, measurementValue: 55 }, { 'Battery(%)': 84 }]] }).batPct, 55);
  assert.equal(R.parseS2120Measurements({ messages: [[{ measurementId: 4101, measurementValue: 1008.7 }]] }).barometricPressureHpa, 1008.7);
  const empty = R.parseS2120Measurements(undefined);
  assert.equal(empty.rainGaugeCumulativeMm, null);
  assert.equal(empty.rainMmPerHour, null);
  assert.equal(R.parseS2120Measurements({ messages: [[{ measurementId: 4213, measurementValue: 'n/a' }]] }).rainGaugeCumulativeMm, null);
});

test('deriveS2120Counter A22: steady intensity, 4213 1.778 -> 2.032 gives 0.254 mm ("review reproduction: steady 4113 with rising 4213")', () => {
  const steady = R.parseS2120Measurements(s2120Object(s2120Intensity('4B', 0.254) + s2120Cumulative(2.032)));
  assert.equal(steady.rainMmPerHour, 0.254);
  assert.deepEqual(R.deriveS2120Counter(1.778, steady.rainGaugeCumulativeMm), { deltaMm: 0.254, status: 'ok' });
  assert.deepEqual(R.deriveS2120Counter(3, 3.254), { deltaMm: 0.254, status: 'ok' }, '"a drop in intensity is not a counter reset"');
  assert.deepEqual(R.deriveS2120Counter(12, 12), { deltaMm: 0, status: 'ok' }, '"a dry counter interval is a valid zero"');
});

test('deriveS2120Counter A23: reset 100 -> 2 -> 2.4 ("a falling 4213 is a counter reset and becomes the new baseline")', () => {
  assert.deepEqual(R.deriveS2120Counter(100, 2), { deltaMm: null, status: 'counter_reset' });
  assert.deepEqual(R.deriveS2120Counter(2, 2.4), { deltaMm: 0.4, status: 'ok' });
  assert.deepEqual(R.deriveS2120Counter(5, 0.254), { deltaMm: null, status: 'counter_reset' });
  assert.deepEqual(R.deriveS2120Counter(0.254, 0.508), { deltaMm: 0.254, status: 'ok' });
});

test('deriveS2120Counter: baseline, first sample, invalid interval, absent counter', () => {
  assert.deepEqual(R.deriveS2120Counter(null, 1.778, { hasBaseline: false }), { deltaMm: null, status: 'cumulative_baseline' },
    '"the first 4213 row of a device is its counter baseline"');
  assert.deepEqual(R.deriveS2120Counter(0.254, 150, { hasBaseline: false }), { deltaMm: null, status: 'cumulative_baseline' },
    '"upgrade: rows written under the old interpretation are never a counter baseline"');
  assert.deepEqual(R.deriveS2120Counter(null, 1.778), { deltaMm: null, status: 'first_sample' });
  assert.deepEqual(R.deriveS2120Counter(1, 2, { intervalSeconds: null }), { deltaMm: null, status: 'invalid_interval' });
  assert.deepEqual(R.deriveS2120Counter(1, 2, { intervalSeconds: 600 }), { deltaMm: 1, status: 'ok' });
  assert.deepEqual(R.deriveS2120Counter(1, null), { deltaMm: null, status: 'no_rain_sensor' });
});

test('deriveS2120Legacy: firmware without 4213 integrates intensity / 6 only over 600 s +/- 60 s', () => {
  assert.deepEqual(R.deriveS2120Legacy(0, { hasPrevious: false }), { deltaMm: null, status: 'first_sample' },
    '"legacy firmware, 10-minute cadence": cadence unknown until a previous uplink exists');
  assert.deepEqual(R.deriveS2120Legacy(1.524, { hasPrevious: true, intervalSeconds: 600 }), { deltaMm: 0.254, status: 'ok' });
  assert.deepEqual(R.deriveS2120Legacy(3.048, { hasPrevious: true, intervalSeconds: 640 }), { deltaMm: 0.508, status: 'ok' },
    '"small timing jitter within the tolerance still integrates"');
  assert.deepEqual(R.deriveS2120Legacy(1.524, { hasPrevious: true, intervalSeconds: 1200 }), { deltaMm: null, status: 'intensity_only' },
    '"lost uplink: the amount stays unknown"');
  assert.deepEqual(R.deriveS2120Legacy(1.524, { hasPrevious: true, intervalSeconds: 300 }), { deltaMm: null, status: 'intensity_only' },
    '"5-minute cadence: overlapping windows are not integrated"');
  assert.deepEqual(R.deriveS2120Legacy(1.524, { hasPrevious: true, intervalSeconds: 660 }), { deltaMm: 0.254, status: 'ok' },
    '"legacy tolerance boundary: 660 s integrates"');
  assert.deepEqual(R.deriveS2120Legacy(1.524, { hasPrevious: true, intervalSeconds: 661 }), { deltaMm: null, status: 'intensity_only' },
    '"661 s does not"');
  assert.deepEqual(R.deriveS2120Legacy(1.524, { hasBaseline: true, hasPrevious: true, intervalSeconds: 600 }), { deltaMm: null, status: 'intensity_only' },
    '"a counter device never integrates an intensity-only uplink"');
  assert.deepEqual(R.deriveS2120Legacy(1.524, { hasPrevious: true, intervalSeconds: null }), { deltaMm: null, status: 'invalid_interval' });
  const legacy = R.parseS2120Measurements(s2120Object(s2120Intensity('02', 1.524)));
  assert.equal(legacy.rainGaugeCumulativeMm, null, 'a rate is never stored as a counter');
  assert.equal(legacy.rainMmPerHour, 1.524);
});

// ---------------------------------------------------------------------------
// Zone-day projection (docs/contracts/rainfall/zone-day-projection.md)
// ---------------------------------------------------------------------------

test('resolver flags abbreviation and invalid', () => {
  assert.deepEqual(R.resolveTimezone('Europe/Zurich'), { timezone: 'Europe/Zurich', basis: 'zone' });
  assert.deepEqual(R.resolveTimezone('CET'), { timezone: 'CET', basis: 'abbreviation' });
  assert.deepEqual(R.resolveTimezone('Mars/Olympus'), { timezone: 'UTC', basis: 'invalid' });
  assert.deepEqual(R.resolveTimezone(''), { timezone: 'UTC', basis: 'unassigned_default' });
  assert.deepEqual(R.resolveTimezone(null), { timezone: 'UTC', basis: 'unassigned_default' });
  assert.deepEqual(R.resolveTimezone('UTC'), { timezone: 'UTC', basis: 'zone' });
  assert.deepEqual(R.resolveTimezone(' Europe/Zurich '), { timezone: 'Europe/Zurich', basis: 'zone' });
  // A zone row resolves through its timezone column.
  assert.deepEqual(R.resolveTimezone({ id: 1, timezone: 'CET' }), { timezone: 'CET', basis: 'abbreviation' });
  assert.deepEqual(R.resolveTimezone({ id: 1 }), { timezone: 'UTC', basis: 'unassigned_default' });
});

test('dst-25h-day and 23h day windows', () => {
  assert.deepEqual(R.zoneDayWindow('2026-10-25T12:00:00Z', 'Europe/Zurich'), { date: '2026-10-25', startIso: '2026-10-24T22:00:00.000Z', endIso: '2026-10-25T23:00:00.000Z' });
  assert.deepEqual(R.zoneDayWindow('2026-03-29T12:00:00Z', 'Europe/Zurich'), { date: '2026-03-29', startIso: '2026-03-28T23:00:00.000Z', endIso: '2026-03-29T22:00:00.000Z' });
});

// assessInstrumentDay: one farm day of one instrument (window = Zurich 2026-10-08).
const ZRH_0810 = { startIso: '2026-10-07T22:00:00.000Z', endIso: '2026-10-08T22:00:00.000Z' };
const ZRH_0809 = { startIso: '2026-10-08T22:00:00.000Z', endIso: '2026-10-09T22:00:00.000Z' };
const ADDR = '01020304';
// A LoRain chain of promoted frames: each frame covers the 900 s before it.
function loRainChain(specs, { devAddr = ADDR, startFCnt = 10 } = {}) {
  let fCnt = startFCnt;
  return specs.map((s) => {
    const [time, tips, extra = {}] = s;
    const endMs = Date.parse(time);
    const frame = {
      receivedAt: new Date(endMs).toISOString(), tips, amountMm: tips === null ? null : tips * 0.5, deltaMm: null, cumulativeMm: null,
      status: 'accepted', frameKind: tips ? 'ordinary' : 'heartbeat_zero', intervalBasis: 'protocol_verified',
      measuredStart: new Date(endMs - 900000).toISOString(), measuredEnd: new Date(endMs).toISOString(),
      devAddr, fCnt, reasons: [],
    };
    fCnt = (extra.fCnt !== undefined ? extra.fCnt : fCnt) + 1;
    return { ...frame, ...extra };
  });
}
// A cumulative register: each frame's delta covers the time since the previous frame.
function counterChain(specs) {
  let prev = null;
  return specs.map(([time, deltaMm, extra = {}]) => {
    const frame = {
      receivedAt: new Date(Date.parse(time)).toISOString(), tips: null, amountMm: deltaMm, deltaMm, cumulativeMm: null,
      status: deltaMm === null ? 'not_additive' : 'accepted', frameKind: 'counter',
      intervalBasis: deltaMm === null || !prev ? 'unknown' : 'protocol_verified',
      measuredStart: deltaMm === null || !prev ? null : prev, measuredEnd: deltaMm === null || !prev ? null : new Date(Date.parse(time)).toISOString(),
      devAddr: null, fCnt: null, reasons: [],
    };
    prev = frame.receivedAt;
    return { ...frame, ...extra };
  });
}
const DRY_DAY = [
  ['2026-10-07T20:00:00Z', 0], ['2026-10-08T00:00:00Z', 0], ['2026-10-08T04:00:00Z', 0], ['2026-10-08T08:00:00Z', 0],
  ['2026-10-08T12:00:00Z', 0], ['2026-10-08T16:00:00Z', 0], ['2026-10-08T20:00:00Z', 0], ['2026-10-09T00:00:00Z', 0],
];
const assessDay = (frames, extra = {}) => R.assessInstrumentDay({ kind: 'interval', frames, window: ZRH_0810, cutoffIso: null, promoted: true, timezoneBasis: 'zone', ...extra });

test('assessInstrumentDay: a verified dry day is complete with 0 mm; rain inside it is its amount', () => {
  const dry = assessDay(loRainChain(DRY_DAY));
  assert.equal(dry.coverage, 'complete');
  assert.equal(dry.amountMm, 0);
  assert.deepEqual(dry.reasons, []);
  assert.equal(dry.receivedMm, 0);
  const wet = assessDay(loRainChain([...DRY_DAY.slice(0, 4), ['2026-10-08T10:00:00Z', 3], ['2026-10-08T10:15:00Z', 2], ...DRY_DAY.slice(4)]));
  assert.equal(wet.coverage, 'complete');
  assert.equal(wet.amountMm, 2.5);
  assert.equal(wet.receivedMm, 2.5);
  assert.equal(wet.acceptedCount, 8);
});

test('assessInstrumentDay: a single heartbeat with no frames around it is partial with frame_gap, not a dry day', () => {
  const r = assessDay(loRainChain([['2026-10-08T12:00:00Z', 0]]));
  assert.equal(r.coverage, 'partial');
  assert.ok(r.reasons.includes('frame_gap'));
  assert.equal(r.amountMm, null);
  assert.equal(r.receivedMm, 0);
});

test('assessInstrumentDay: an interval crossing midnight with tips is boundary_allocation on both days (A13)', () => {
  const frames = loRainChain([...DRY_DAY.slice(0, 7), ['2026-10-08T22:05:00Z', 2], ['2026-10-09T02:05:00Z', 0], ['2026-10-09T06:05:00Z', 0],
    ['2026-10-09T10:05:00Z', 0], ['2026-10-09T14:05:00Z', 0], ['2026-10-09T18:05:00Z', 0], ['2026-10-09T22:05:00Z', 0]]);
  const day1 = assessDay(frames);
  assert.equal(day1.coverage, 'unknown');
  assert.ok(day1.reasons.includes('boundary_allocation'));
  assert.equal(day1.amountMm, null);
  assert.equal(day1.receivedMm, 0, 'the straddling frame is received on the next day');
  const day2 = assessDay(frames, { window: ZRH_0809 });
  assert.equal(day2.coverage, 'unknown');
  assert.ok(day2.reasons.includes('boundary_allocation'));
  assert.equal(day2.receivedMm, 1, 'received in this period, not a measured day total');
  // A zero window across midnight splits exactly (zero on both sides).
  const zero = assessDay(loRainChain([...DRY_DAY.slice(0, 7), ['2026-10-08T22:05:00Z', 0], ['2026-10-09T02:05:00Z', 0]]));
  assert.equal(zero.coverage, 'complete');
  assert.equal(zero.amountMm, 0);
});

test('assessInstrumentDay: a frame received exactly at midnight belongs to the day its window measured', () => {
  const frames = loRainChain([...DRY_DAY.slice(0, 7), ['2026-10-08T22:00:00Z', 4], ['2026-10-09T02:00:00Z', 0]]);
  const day1 = assessDay(frames);
  assert.equal(day1.coverage, 'complete');
  assert.equal(day1.amountMm, 2, 'measured 21:45-22:00Z, inside the day');
  assert.equal(day1.receivedMm, 0, 'received on the next day');
  const day2 = assessDay(frames, { window: ZRH_0809 });
  assert.equal(day2.receivedMm, 2);
  assert.equal(day2.amountMm, null, 'day 2 has no frame after its end yet');
});

test('assessInstrumentDay: button overlap and a configuration change mid-day are unknown (A9)', () => {
  const overlap = loRainChain([...DRY_DAY.slice(0, 4), ['2026-10-08T10:07:00Z', 2, { status: 'overlap_unqualified', amountMm: null, frameKind: 'button', intervalBasis: 'unknown', measuredStart: null, measuredEnd: null, reasons: ['overlap_unqualified'] }],
    ['2026-10-08T10:15:00Z', 2, { intervalBasis: 'unknown', measuredStart: null, measuredEnd: null, reasons: ['overlap_unqualified'] }], ...DRY_DAY.slice(4)]);
  const r1 = assessDay(overlap);
  assert.equal(r1.coverage, 'unknown');
  assert.ok(r1.reasons.includes('overlap_unqualified'));
  const config = loRainChain([...DRY_DAY.slice(0, 4), ['2026-10-08T09:00:00Z', null, { status: 'not_additive', amountMm: null, frameKind: 'config', intervalBasis: 'unknown', measuredStart: null, measuredEnd: null, reasons: ['config_change'] }],
    ['2026-10-08T09:30:00Z', 0, { intervalBasis: 'unknown', measuredStart: null, measuredEnd: null, reasons: ['config_change'] }], ...DRY_DAY.slice(4)]);
  const r2 = assessDay(config);
  assert.equal(r2.coverage, 'unknown');
  assert.ok(r2.reasons.includes('config_change'));
});

test('assessInstrumentDay: fCnt gap is partial frame_gap, session reset partial session_reset, unpromoted unknown received_only (D9)', () => {
  const gap = loRainChain(DRY_DAY.map((s, i) => (i === 4 ? [s[0], s[1], { fCnt: 20 }] : s)));
  const r1 = assessDay(gap);
  assert.equal(r1.coverage, 'partial');
  assert.deepEqual(r1.reasons, ['frame_gap']);
  assert.equal(r1.amountMm, null);
  const reset = loRainChain(DRY_DAY.map((s, i) => (i === 4 ? [s[0], s[1], { fCnt: 0 }] : s)));
  const r2 = assessDay(reset);
  assert.equal(r2.coverage, 'partial');
  assert.deepEqual(r2.reasons, ['session_reset']);
  const moved = loRainChain(DRY_DAY).map((f, i) => (i >= 5 ? { ...f, devAddr: '0a0b0c0d' } : f));
  assert.deepEqual(assessDay(moved).reasons, ['session_reset']);
  const unpromoted = assessDay(loRainChain(DRY_DAY), { promoted: false });
  assert.equal(unpromoted.coverage, 'unknown');
  assert.deepEqual(unpromoted.reasons, ['received_only']);
  assert.equal(unpromoted.amountMm, null);
  assert.equal(unpromoted.receivedMm, 0);
  const unpinned = loRainChain(DRY_DAY).map((f) => ({ ...f, intervalBasis: 'unknown', measuredStart: null, measuredEnd: null, reasons: ['build_unpinned', 'received_only'] }));
  const r3 = assessDay(unpinned, { promoted: undefined });
  assert.equal(r3.coverage, 'unknown');
  assert.deepEqual(r3.reasons, ['received_only', 'build_unpinned']);
  // unknown wins over partial
  const both = assessDay(loRainChain(DRY_DAY.map((s, i) => (i === 4 ? [s[0], s[1], { fCnt: 20 }] : s))), { promoted: false });
  assert.equal(both.coverage, 'unknown');
  assert.deepEqual(both.reasons, ['received_only', 'frame_gap']);
});

test('assessInstrumentDay: an outage crossing midnight leaves both days not complete (A28)', () => {
  const frames = loRainChain([...DRY_DAY.slice(0, 7), ['2026-10-09T06:00:00Z', 6, { fCnt: 40 }], ['2026-10-09T10:00:00Z', 0],
    ['2026-10-09T14:00:00Z', 0], ['2026-10-09T18:00:00Z', 0], ['2026-10-09T22:00:00Z', 0]]);
  const day1 = assessDay(frames);
  const day2 = assessDay(frames, { window: ZRH_0809 });
  assert.notEqual(day1.coverage, 'complete');
  assert.notEqual(day2.coverage, 'complete');
  assert.equal(day2.receivedMm, 3, 'the amount stays as an interval observation');
});

test('assessInstrumentDay: a partial day and the complete next day are assessed independently (A16)', () => {
  const frames = loRainChain([['2026-10-08T12:00:00Z', 0], ['2026-10-08T16:00:00Z', 0], ['2026-10-08T20:00:00Z', 0],
    ['2026-10-09T00:00:00Z', 0], ['2026-10-09T04:00:00Z', 0], ['2026-10-09T08:00:00Z', 2], ['2026-10-09T12:00:00Z', 0],
    ['2026-10-09T16:00:00Z', 0], ['2026-10-09T20:00:00Z', 0], ['2026-10-10T00:00:00Z', 0]]);
  assert.equal(assessDay(frames).coverage, 'partial');
  const day2 = assessDay(frames, { window: ZRH_0809 });
  assert.equal(day2.coverage, 'complete');
  assert.equal(day2.amountMm, 1);
});

test('assessInstrumentDay: cumulative register complete with zero straddling deltas; a reset inside is partial counter_reset', () => {
  const spec = [['2026-10-07T21:50:00Z', 0], ['2026-10-07T22:10:00Z', 0], ['2026-10-08T06:00:00Z', 1.2], ['2026-10-08T12:00:00Z', 0.4],
    ['2026-10-08T21:50:00Z', 0], ['2026-10-08T22:10:00Z', 0]];
  const ok = R.assessInstrumentDay({ kind: 'cumulative', frames: counterChain(spec), window: ZRH_0810, cutoffIso: null, timezoneBasis: 'zone' });
  assert.equal(ok.coverage, 'complete');
  assert.equal(ok.amountMm, 1.6);
  const straddle = R.assessInstrumentDay({ kind: 'cumulative', frames: counterChain(spec.map((s, i) => (i === 1 ? [s[0], 0.2] : s))), window: ZRH_0810, cutoffIso: null });
  assert.equal(straddle.coverage, 'unknown');
  assert.ok(straddle.reasons.includes('boundary_allocation'));
  const reset = counterChain(spec);
  reset[3] = { ...reset[3], status: 'not_additive', amountMm: null, deltaMm: null, intervalBasis: 'unknown', measuredStart: null, measuredEnd: null, reasons: ['counter_reset'] };
  const r = R.assessInstrumentDay({ kind: 'cumulative', frames: reset, window: ZRH_0810, cutoffIso: null });
  assert.equal(r.coverage, 'partial');
  assert.deepEqual(r.reasons, ['counter_reset']);
  const late = counterChain(spec);
  late.splice(3, 0, { ...late[3], receivedAt: '2026-10-08T11:00:00.000Z', status: 'not_additive', amountMm: null, deltaMm: null, intervalBasis: 'unknown', measuredStart: null, measuredEnd: null, reasons: ['late_counter_frame', 'out_of_order'] });
  assert.equal(R.assessInstrumentDay({ kind: 'cumulative', frames: late, window: ZRH_0810, cutoffIso: null }).coverage, 'unknown');
});

test('assessInstrumentDay: today against its cutoff is at best complete_so_far with ongoing', () => {
  const frames = loRainChain(DRY_DAY.slice(0, 4).concat([['2026-10-08T10:00:00Z', 1]]));
  const r = assessDay(frames, { cutoffIso: '2026-10-08T10:00:00.000Z' });
  assert.equal(r.coverage, 'complete_so_far');
  assert.deepEqual(r.reasons, ['ongoing']);
  assert.equal(r.amountMm, 0.5);
  assert.equal(r.receivedMm, 0.5);
  assert.equal(r.observedCutoff, '2026-10-08T10:00:00.000Z');
  const unpromoted = assessDay(frames, { cutoffIso: '2026-10-08T10:00:00.000Z', promoted: false });
  assert.equal(unpromoted.coverage, 'unknown');
  assert.deepEqual(unpromoted.reasons, ['received_only', 'ongoing']);
});

test('assessInstrumentDay: an invalid zone timezone never certifies; an abbreviation is flagged only', () => {
  assert.equal(assessDay(loRainChain(DRY_DAY), { timezoneBasis: 'invalid' }).coverage, 'unknown');
  assert.ok(assessDay(loRainChain(DRY_DAY), { timezoneBasis: 'invalid' }).reasons.includes('timezone_invalid'));
  const abbr = assessDay(loRainChain(DRY_DAY), { timezoneBasis: 'abbreviation' });
  assert.equal(abbr.coverage, 'complete');
  assert.deepEqual(abbr.reasons, ['timezone_abbreviation']);
});

test('assessInstrumentDay: no evidence at all is unknown with no amount', () => {
  const r = assessDay([]);
  assert.equal(r.coverage, 'unknown');
  assert.equal(r.amountMm, null);
  assert.equal(r.receivedMm, null);
});
