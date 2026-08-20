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
function interpretUplink(decoded, fPort) {
  const d = decoded || {};
  const acks = [];
  let generationHint = null;

  const schl = Number(d.Schl_Port);
  if (schl >= WEEKDAY_FPORT_BASE && schl <= WEEKDAY_FPORT_BASE + 6) {
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

  const g2port = Number(d.Ack_Port);
  if (Number.isFinite(g2port)) {
    generationHint = 'GEN2';
    const status = Number.isFinite(Number(d.Ack_Value)) ? Number(d.Ack_Value) : null;
    if (g2port === GEN2_SCHEDULER_FPORT) acks.push({ purpose: 'DAYMASK_PLAN', fport: g2port, weekday: null, status });
    else if (g2port === STATUS_FPORT) acks.push({ purpose: 'SCHEDULER_STATUS', fport: g2port, weekday: null, status });
    else if (g2port === CLOCK_FPORT || g2port === CLOCK_REQ_FPORT) acks.push({ purpose: 'CLOCK_SYNC', fport: g2port, weekday: null, status });
  }

  return { acks, generationHint };
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
