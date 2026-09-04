'use strict';
const nodeFs = require('node:fs');
const path = require('node:path');
const { WEEKDAY_FPORT_BASE, GEN2_SCHEDULER_FPORT, STATUS_FPORT, CLOCK_FPORT, CLOCK_REQ_FPORT } = require('./plan');

function statusInt(v) { const n = parseInt(String(v == null ? '' : v), 16); return Number.isFinite(n) ? n : null; }

// decoded = the object handed back by the STREGA codec (data.object from ChirpStack, or the
// decodeGen1Fallback() result below). Field names below are verified against the vendor
// decoders, not guessed:
//
// GEN1 (docs/hardware/strega-codecs/ChirpStack-STREGA-CODEC-Decoder-Gen1, mirrored in
// codecs/strega_gen1_decoder.js): the ACK branch (v4_1 === "40") returns one of several shapes
// keyed by conf_p (the echoed downlink fport):
//   conf_p 14..20 (weekday scheduler write) -> { Schl_Port, Schl_status }        (lines 359-376)
//   conf_p 21     (scheduler status write)  -> { Schl_status_Port, Schl_status_ack }  (lines 377-394)
//   conf_p 12|13  (time sync)               -> { RTC_Port, RTC_status }          (lines 341-358)
// `*_status`/`*_ack` are 2-char ASCII-hex strings (e.g. "00"), not numbers.
//
// GEN2 (docs/hardware/strega-codecs/ChirpStack-JS-CODEC-Decoder-STREGA-Gen2-CS4.17-and-up):
// frames with the ACK marker (payload byte 5 charCode === 6, i.e. ACKNum === 6) are decoded at
// lines 154-227. The `switch (ack_port)` there special-cases only port 10 (radio config) and
// port 24 (counter read); every other port -- including 25 (DAYMASK_PLAN/scheduler write), 21
// (SCHEDULER_STATUS) and 12/13 (CLOCK_SYNC) -- falls into the `default` branch (lines 207-226),
// which emits `Ack_Port` (Number, the echoed port) and `Ack_Value` (Number, parseInt(...,16)).
// A periodic (non-ACK) uplink (lines 229-248) omits `Ack_Port` entirely, so its mere presence is
// what marks a decoded object as a Gen2 ACK. There is NO boolean `Ack` field in the real decoder
// output (the Task 3 brief's `Ack: true` placeholder does not exist on the wire and is not used
// here).
function interpretUplink(decoded, fPort, rawBytes) {
  const d = decoded || {};
  const acks = [];
  let generationHint = null;

  const schl = Number(d.Schl_Port);
  if (Number.isInteger(schl) && schl >= WEEKDAY_FPORT_BASE && schl <= WEEKDAY_FPORT_BASE + 6) {
    acks.push({ purpose: 'WEEKDAY_PLAN', fport: schl, weekday: schl - WEEKDAY_FPORT_BASE, status: statusInt(d.Schl_status) });
    generationHint = 'GEN1';
  }
  if (Number(d.Schl_status_Port) === STATUS_FPORT) {
    acks.push({ purpose: 'SCHEDULER_STATUS', fport: STATUS_FPORT, weekday: null, status: statusInt(d.Schl_status_ack) });
    generationHint = generationHint || 'GEN1';
  }
  const rtc = Number(d.RTC_Port);
  if (rtc === CLOCK_FPORT || rtc === CLOCK_REQ_FPORT) {
    acks.push({ purpose: 'CLOCK_SYNC', fport: rtc, weekday: null, status: statusInt(d.RTC_status) });
    generationHint = generationHint || 'GEN1';
  }

  // Fix round 1: `Ack_Port` can legitimately be `NaN` in the real decoder (a truncated/short
  // Gen2 ACK frame with no port bytes -- `parseInt("", 16)` -- see the vendor decoder's
  // `payload.substr(6,2)` when `str_len` is too short) and `NaN` round-trips through JSON as
  // `null`. `Number(null)` is `0` and `Number.isFinite(0)` is true, so a bare `Number.isFinite`
  // guard would misread that as a real "port 0" ACK and falsely promote to GEN2. Require an
  // actual positive integer on the raw field (not coerced) instead.
  if (Number.isInteger(d.Ack_Port) && d.Ack_Port > 0) {
    generationHint = 'GEN2';
    const g2port = d.Ack_Port;
    const status = Number.isFinite(Number(d.Ack_Value)) ? Number(d.Ack_Value) : null;
    if (g2port === GEN2_SCHEDULER_FPORT) acks.push({ purpose: 'DAYMASK_PLAN', fport: g2port, weekday: null, status });
    else if (g2port === STATUS_FPORT) acks.push({ purpose: 'SCHEDULER_STATUS', fport: g2port, weekday: null, status });
    else if (g2port === CLOCK_FPORT || g2port === CLOCK_REQ_FPORT) acks.push({ purpose: 'CLOCK_SYNC', fport: g2port, weekday: null, status });
  }

  // As of the Gen2 device-profile wave, ChirpStack provisions two STREGA profiles
  // (chirpstack-bootstrap.js:451,453): Gen1 wired to strega_gen1_decoder.js, Gen2 wired to
  // strega_gen2_decoder.js. A valve re-pointed onto the Gen2 profile decodes through the real
  // Gen2 codec, so the decoded-object branch above (`Ack_Port`) is reachable on real hardware,
  // not just in theory. This raw-byte fallback stays load-bearing for two cases the
  // decoded-object branch cannot cover: a Gen2 valve still sitting on the Gen1 profile (its
  // Gen1 codec mangles the bytes, so `acks` and `generationHint` both come back empty above),
  // and any uplink where ChirpStack hands back an empty decoded object regardless of profile.
  // Only consulted when the decoded object produced nothing at all, so it can never override a
  // real ACK from either codec.
  if (acks.length === 0 && generationHint === null && rawBytes) {
    const raw = interpretRawGen2Ack(rawBytes);
    if (raw) {
      generationHint = raw.generationHint;
      acks.push(...raw.acks);
    }
  }

  return { acks, generationHint };
}

function isAsciiDigit(byte) { return byte >= 0x30 && byte <= 0x39; }
function isAsciiHexChar(byte) {
  return (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
}
function parseAsciiHexPair(hiByte, loByte) {
  if (!isAsciiHexChar(hiByte) || !isAsciiHexChar(loByte)) return null;
  const n = parseInt(String.fromCharCode(hiByte) + String.fromCharCode(loByte), 16);
  return Number.isFinite(n) ? n : null;
}

// Raw-byte Gen2 ACK detection, used only as a fallback when the codec-decoded object yielded no
// acks and no generation hint (see the call site above). Per
// docs/hardware/strega-codecs/ChirpStack-JS-CODEC-Decoder-STREGA-Gen2-CS4.17-and-up: `payload =
// String.fromCharCode.apply(null, bytes)` reads the raw bytes directly as char codes (unlike
// Gen1, which hex-decodes an ASCII sub-string first), so:
//   bytes[0..2] : 3 ASCII hex-digit characters -> battery, `parseInt(payload.substr(0,3), 16)`
//   bytes[3..4] : 2 ASCII hex-digit characters -> status
//   bytes[5]    : the literal byte 0x06 (ASCII "ACK" control code) -- `ACKStr.charCodeAt(0) ===
//                 6` -- marks the frame as an ACK; a Gen1 ACK frame carries '@' (0x40) at this
//                 same offset instead (see ack.test.js), so this cannot false-positive on Gen1.
//   bytes[6..7] : 2 ASCII hex-digit characters -> echoed port, `parseInt(payload.substr(6,2),
//                 16)` (e.g. "19" -> 0x19 -> decimal 25, matching how the Gen1 decoder also
//                 encodes the fport as an ASCII-hex pair)
//   bytes[8..9] : 2 ASCII hex-digit characters -> ack value (only present/meaningful for ports
//                 outside the decoder's special-cased 1/10/13/24 branches; 12/21/25 all use it)
// Verified end-to-end by round-tripping a hand-built frame through the real Gen2 decoder script
// (see task-3-report.md fix-round-1 section for the captured output).
function interpretRawGen2Ack(rawBytes) {
  if (!rawBytes || rawBytes.length <= 5) return null;
  if (rawBytes[5] !== 0x06) return null;
  if (!isAsciiDigit(rawBytes[0]) || !isAsciiDigit(rawBytes[1]) || !isAsciiDigit(rawBytes[2])) return null;

  const acks = [];
  if (rawBytes.length >= 8) {
    const port = parseAsciiHexPair(rawBytes[6], rawBytes[7]);
    if (Number.isInteger(port) && port > 0) {
      const status = rawBytes.length >= 10 ? parseAsciiHexPair(rawBytes[8], rawBytes[9]) : null;
      if (port === GEN2_SCHEDULER_FPORT) acks.push({ purpose: 'DAYMASK_PLAN', fport: port, weekday: null, status });
      else if (port === STATUS_FPORT) acks.push({ purpose: 'SCHEDULER_STATUS', fport: port, weekday: null, status });
      else if (port === CLOCK_FPORT || port === CLOCK_REQ_FPORT) acks.push({ purpose: 'CLOCK_SYNC', fport: port, weekday: null, status });
    }
  }
  return { generationHint: 'GEN2', acks };
}

// Mirrors the `decodeStregaFallback` helper inside the flows.json "Process STREGA" function node
// (id strega-process-fn): used when ChirpStack hands us an uplink with an empty `object` (codec
// not applied yet, or bypassed). `fsModule` is injected (the flow node uses Node-RED's
// `global.get('fs')`; here it is passed in directly) so this stays testable without a Node-RED
// runtime. Never throws: any failure (missing codec file, bad base64, decoder exception) is
// logged and swallowed, returning null so callers can fall back to raw telemetry handling.
function readCodecSource(fsModule) {
  const primaryPath = '/srv/node-red/codecs/strega_gen1_decoder.js';
  const fallbackPath = path.resolve(__dirname, '../codecs/strega_gen1_decoder.js');
  try {
    return fsModule.readFileSync(primaryPath, 'utf8');
  } catch (_primaryErr) {
    return fsModule.readFileSync(fallbackPath, 'utf8');
  }
}

function decodeGen1Fallback(fsModule, base64Data, fPort) {
  const fsm = fsModule || nodeFs;
  if (!base64Data) return null;
  try {
    const codecSource = String(readCodecSource(fsm) || '');
    if (!codecSource) return null;
    const bytes = Array.from(Buffer.from(String(base64Data), 'base64'));
    // Copied verbatim from strega-process-fn's decodeStregaFallback (flows.json) -- do not
    // retype this wrapping, it is what makes the vendor decoder's top-level `var`/`function`
    // declarations resolve inside the sandboxed Function body.
    const decode = new Function('Buffer', 'bytes', 'fPort', codecSource + '\nreturn typeof decodeUplink === "function" ? decodeUplink({ fPort: fPort, bytes: bytes, variables: {} }).data : null;');
    return decode(Buffer, bytes, Number(fPort || 0));
  } catch (err) {
    console.warn('[osi-valve-control] decodeGen1Fallback failed: ' + (err && err.message));
    return null;
  }
}

module.exports = { interpretUplink, decodeGen1Fallback };
