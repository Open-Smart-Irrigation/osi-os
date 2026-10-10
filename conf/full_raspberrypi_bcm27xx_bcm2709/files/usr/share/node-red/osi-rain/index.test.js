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

test('zoneDayWindow: invalid or padded timezones', () => {
  assert.deepEqual(R.zoneDayWindow('2026-10-08T22:30:00.000Z', 'Mars/Olympus'),
    { date: '2026-10-08', startIso: '2026-10-08T00:00:00.000Z', endIso: '2026-10-09T00:00:00.000Z' });
  assert.equal(R.zoneDayWindow('2026-10-08T22:30:00.000Z', ' Europe/Zurich').date, '2026-10-09');
  assert.equal(R.zoneDayWindow('2026-10-08T22:30:00.000Z', null).date, '2026-10-08');
});

test('zoneDayWindow agrees with osi-history-helper.startOfLocalDayMs on DST dates', () => {
  const H = require(path.join(NODE_RED, 'osi-history-helper/index.js'));
  const zones = ['Europe/Zurich', 'America/Santiago', 'America/Sao_Paulo', 'Asia/Beirut', 'Pacific/Auckland', 'Africa/Kampala', 'UTC'];
  const instants = ['2026-03-29T00:30:00Z', '2026-03-29T01:30:00Z', '2026-03-29T23:59:00Z', '2026-10-25T00:30:00Z',
    '2026-10-25T01:30:00Z', '2026-10-25T23:30:00Z', '2026-04-05T03:30:00Z', '2026-09-06T04:30:00Z', '2026-09-27T14:00:00Z'];
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
