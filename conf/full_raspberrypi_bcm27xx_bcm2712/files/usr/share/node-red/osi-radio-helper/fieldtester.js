'use strict';

// RAK10701 reply, fPort 2, six bytes: sequence id (ID & 0xFF), min RSSI + 200,
// max RSSI + 200, min distance / 250 m, max distance / 250 m, gateway count.
// RAK's own reference server computes this as `sequence_id & 0xFF`, not modulo
// 255 (field-tester-server/server/server.js, ftdProcess()) -- the two diverge
// from fCnt 255 onward, which a ten-second walk reaches in ~42 minutes.
// The device reads a zero distance as invalid, so an unknown gateway position
// sends zero rather than a guess.
const STEP_M = 250;
const MAX_STEPS = 128;            // 32 km

// Which uplinks are field-test frames at all, gated exactly like RAK's own
// reference server (field-tester-server/server/server.js). ftdProcess() there
// says it plainly: "Filter wrong messages by length":
//   if (( 1 == port) && (bytes.length != 10)) return null;
//   if ((11 == port) && (bytes.length != 11)) return null;
// and parser_cs34() (the ChirpStack-shaped parser -- the one that matches our
// own msg.payload.fPort/msg.payload.data envelope) gates the port itself first:
//   var port = msg.payload.fPort;
//   if ((port != 1) && (port != 11)) return null;
// The two ports are not symmetric: fPort 1 (standard, 10-byte payload) replies
// on fPort 2 with a 6-byte buffer; fPort 11 (extended, 11-byte payload) replies
// on fPort 12 with an 8-byte buffer (ftdProcess()'s two `if (1 == port)` /
// `else if (11 == port)` branches build different-length buffers).
//
// Before this gate existed, radio-capture-fn answered ANY uplink from the
// field-tester application regardless of port. fPort 0 is the LoRaWAN
// MAC-command port, not an application port -- replying to one triggered
// another MAC-layer frame from the device, which triggered another reply,
// forever, at SF12 (2026-09-22 rehearsal capture, radio.db 16:22:11 onward).
//
// Scope decision: only the standard fPort-1 frame is implemented. It is the
// only shape the RAK10701 fleet has ever transmitted (confirmed by the
// rehearsal capture and by CHIRPSTACK_PROFILE_RAK10701's own frame format),
// and the extended fPort-11 reply (different port, different length) cannot
// be bench-tested against real hardware before this fix ships. An extended
// uplink is therefore REJECTED explicitly -- classifyUplinkFrame returns a
// distinct 'extended-not-implemented' tag rather than silently folding it
// into the same 'not-field-test' bucket as fPort 0, so a caller can log the
// rejection instead of dropping a genuine field-test frame without a trace.
const STANDARD_PORT = 1;
const STANDARD_LEN = 10;
const EXTENDED_PORT = 11;

function classifyUplinkFrame(fPort, byteLength) {
  if (fPort === STANDARD_PORT) return byteLength === STANDARD_LEN ? 'standard' : 'not-field-test';
  if (fPort === EXTENDED_PORT) return 'extended-not-implemented';
  return 'not-field-test';
}

function haversineMetres(a, b) {
  if (!a || !b) return null;
  const toRad = deg => deg * Math.PI / 180;
  const dLat = toRad(b.latitude - a.latitude), dLon = toRad(b.longitude - a.longitude);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(s)));
}

function steps(metres) {
  if (metres == null || !Number.isFinite(metres)) return 0;
  return Math.max(1, Math.min(MAX_STEPS, Math.round(metres / STEP_M) || 1));
}

function byteRssi(dbm) {
  if (dbm == null || !Number.isFinite(dbm)) return 0;
  return Math.max(0, Math.min(255, Math.round(dbm) + 200));
}

function encodeFieldTesterReply({ fCnt, receivers, devicePosition }) {
  const seen = Array.isArray(receivers) ? receivers : [];
  if (!seen.length) return null;
  const rssis = seen.map(r => r && r.rssi_dbm).filter(v => v != null && Number.isFinite(v));
  const distances = seen
    .map(r => haversineMetres(devicePosition, r && r.position))
    .filter(v => v != null && Number.isFinite(v));
  const buf = Buffer.alloc(6);
  buf[0] = Number(fCnt || 0) & 0xFF;
  buf[1] = byteRssi(rssis.length ? Math.min(...rssis) : null);
  buf[2] = byteRssi(rssis.length ? Math.max(...rssis) : null);
  buf[3] = distances.length ? steps(Math.min(...distances)) : 0;
  buf[4] = distances.length ? steps(Math.max(...distances)) : 0;
  buf[5] = Math.min(255, seen.length);
  return buf;
}

module.exports = { encodeFieldTesterReply, haversineMetres, classifyUplinkFrame, STANDARD_PORT, STANDARD_LEN, EXTENDED_PORT };
