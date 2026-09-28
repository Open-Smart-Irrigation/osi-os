'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeFieldTesterReply, haversineMetres, classifyUplinkFrame } = require('./fieldtester.js');

test('encodes RSSI with the +200 offset and distance in 250 m steps', () => {
  const buf = encodeFieldTesterReply({
    fCnt: 4,
    devicePosition: { latitude: 46.5, longitude: 6.5 },
    receivers: [
      { rssi_dbm: -93, position: { latitude: 46.5045, longitude: 6.5 } },   // ~500 m
      { rssi_dbm: -40, position: { latitude: 46.5, longitude: 6.5 } }       // ~0 m, clamps to 250
    ]
  });
  assert.equal(buf.length, 6);
  assert.equal(buf[0], 4);          // fCnt & 0xFF
  assert.equal(buf[1], 107);        // -93 + 200
  assert.equal(buf[2], 160);        // -40 + 200
  assert.equal(buf[3], 1);          // nearest 250 m step, clamped up from 0
  assert.equal(buf[4], 2);          // ~500 m
  assert.equal(buf[5], 2);          // two receivers
});

test('reports distance as invalid when the gateway position is unknown', () => {
  const buf = encodeFieldTesterReply({ fCnt: 260, devicePosition: { latitude: 46.5, longitude: 6.5 },
    receivers: [{ rssi_dbm: -100, position: null }] });
  assert.equal(buf[0], 4);          // 260 & 0xFF (the old `% 255` arithmetic gave 5)
  assert.equal(buf[3], 0);          // zero means invalid to the device
  assert.equal(buf[4], 0);
  assert.equal(buf[5], 1);
});

test('the sequence byte matches ChirpStack fCnt modulo 256, not 255, at and past the divergence point', () => {
  // RAK's reference server computes `sequence_id & 0xFF` (server/server.js,
  // ftdProcess()), not `fCnt % 255`. The two arithmetics agree everywhere
  // below 255 and diverge from fCnt 255 onward -- a ten-second-interval walk
  // reaches fCnt 255 in about 42 minutes without a rejoin.
  const at255 = encodeFieldTesterReply({ fCnt: 255, devicePosition: { latitude: 46.5, longitude: 6.5 },
    receivers: [{ rssi_dbm: -90, position: null }] });
  assert.equal(at255[0], 255);      // 255 & 0xFF = 255; `% 255` would have wrapped this to 0
  const at256 = encodeFieldTesterReply({ fCnt: 256, devicePosition: { latitude: 46.5, longitude: 6.5 },
    receivers: [{ rssi_dbm: -90, position: null }] });
  assert.equal(at256[0], 0);        // 256 & 0xFF = 0; `% 255` would have given 1
});

test('caps distance at 32 km and clamps RSSI into one byte', () => {
  const buf = encodeFieldTesterReply({ fCnt: 1, devicePosition: { latitude: 46.5, longitude: 6.5 },
    receivers: [{ rssi_dbm: -210, position: { latitude: 47.5, longitude: 6.5 } }] });  // ~111 km
  assert.equal(buf[1], 0);          // clamped, never negative
  assert.equal(buf[4], 128);        // 32000 / 250
});

test('returns null when nothing received the uplink', () => {
  assert.equal(encodeFieldTesterReply({ fCnt: 1, devicePosition: null, receivers: [] }), null);
});

// Supplementary boundary cases not covered by the brief's four tests above.

test('clamps RSSI on the upper side too, never wrapping past 255', () => {
  const buf = encodeFieldTesterReply({ fCnt: 1, devicePosition: { latitude: 46.5, longitude: 6.5 },
    receivers: [{ rssi_dbm: 100, position: null }] });
  assert.equal(buf[1], 255);        // 100 + 200 = 300, clamped down, never wraps to 44
  assert.equal(buf[2], 255);
});

test('zeros distance when the device position itself is unknown, even though the receiver has one', () => {
  const buf = encodeFieldTesterReply({ fCnt: 1, devicePosition: null,
    receivers: [{ rssi_dbm: -80, position: { latitude: 46.5, longitude: 6.5 } }] });
  assert.equal(buf[1], 120);        // -80 + 200, signal strength still reported
  assert.equal(buf[2], 120);
  assert.equal(buf[3], 0);          // no device position to measure distance from
  assert.equal(buf[4], 0);
  assert.equal(buf[5], 1);
});

test('computes min/max distance from only the receivers with a known position', () => {
  const buf = encodeFieldTesterReply({
    fCnt: 2,
    devicePosition: { latitude: 46.5, longitude: 6.5 },
    receivers: [
      { rssi_dbm: -93, position: { latitude: 46.5045, longitude: 6.5 } },   // ~500 m, only known position
      { rssi_dbm: -70, position: null }                                     // no GPS on this gateway
    ]
  });
  assert.equal(buf[3], 2);          // min and max both come from the single known-position receiver
  assert.equal(buf[4], 2);
  assert.equal(buf[5], 2);          // both receivers still counted
});

// --- Port/length gate (2026-09-22 rehearsal loop): classifyUplinkFrame ---
// RAK's own reference server (field-tester-server/server/server.js) only treats
// fPort 1 (10-byte payload) and fPort 11 (11-byte payload) as field-test frames,
// and rejects everything else by length before it will build a reply at all --
// see the block comment above classifyUplinkFrame for the exact vendor quotes.
test('a genuine standard field-test frame (fPort 1, 10 bytes) classifies as standard', () => {
  assert.equal(classifyUplinkFrame(1, 10), 'standard');
});
test('fPort 0 -- the LoRaWAN MAC-command port -- is never a field-test frame', () => {
  // This is the exact port the rehearsal loop ran on: the RAK10701 emits MAC-layer
  // frames on fPort 0 a few seconds after a downlink, and our capture flow used to
  // answer them too, provoking the next one forever at SF12.
  assert.equal(classifyUplinkFrame(0, 0), 'not-field-test');
  assert.equal(classifyUplinkFrame(0, 10), 'not-field-test');
});
test('a wrong-length fPort-1 frame is rejected the same as the vendor: "Filter wrong messages by length"', () => {
  assert.equal(classifyUplinkFrame(1, 9), 'not-field-test');
  assert.equal(classifyUplinkFrame(1, 11), 'not-field-test');
  assert.equal(classifyUplinkFrame(1, 0), 'not-field-test');
});
test('an extended-format frame (fPort 11, 11 bytes) is recognized and explicitly rejected, not silently dropped', () => {
  // Scope decision: the extended reply (fPort 12, 8-byte buffer -- a different port
  // AND a different length than the standard reply) cannot be bench-tested against
  // real hardware before the demo, so it is rejected on purpose. The distinct tag
  // proves this is a deliberate rejection, not the same bucket as "not a field-test
  // frame at all" (fPort 0, wrong length, or any other port).
  assert.equal(classifyUplinkFrame(11, 11), 'extended-not-implemented');
  assert.notEqual(classifyUplinkFrame(11, 11), classifyUplinkFrame(0, 0));
});
test('a wrong-length fPort-11 frame is still tagged extended-not-implemented, not silently dropped as not-field-test', () => {
  // The vendor would itself reject this by length (ftdProcess: bytes.length != 11 ->
  // null), but since we do not implement the extended format at all, any fPort-11
  // uplink -- right length or not -- should surface as the same explicit rejection
  // rather than disappearing into the generic not-field-test bucket.
  assert.equal(classifyUplinkFrame(11, 5), 'extended-not-implemented');
});
test('any other application port is not a field-test frame', () => {
  assert.equal(classifyUplinkFrame(2, 6), 'not-field-test');
  assert.equal(classifyUplinkFrame(12, 8), 'not-field-test');
  assert.equal(classifyUplinkFrame(99, 10), 'not-field-test');
});

test('a non-finite distance does not poison the valid ones', () => {
  // haversineMetres only returns null for a missing (falsy) endpoint; a truthy
  // position object with a non-numeric coordinate instead produces NaN, which
  // survives a plain `!= null` filter and would drag Math.min/Math.max to NaN,
  // zeroing both distance bytes even though a well-formed receiver is present.
  const buf = encodeFieldTesterReply({
    fCnt: 3,
    devicePosition: { latitude: 46.5, longitude: 6.5 },
    receivers: [
      { rssi_dbm: -93, position: { latitude: 46.5045, longitude: 6.5 } },        // ~500 m, valid
      { rssi_dbm: -70, position: { latitude: 'not-a-number', longitude: 6.5 } }  // malformed, yields NaN
    ]
  });
  assert.equal(buf[3], 2);          // the one valid distance, not zeroed by the malformed entry
  assert.equal(buf[4], 2);
  assert.equal(buf[5], 2);          // both receivers still counted for gateway count
});
