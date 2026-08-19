'use strict';
// osi-sdi12-reassemble — pure per-device state machine for Dragino AT+DATAUP=1
// multi-segment SDI-12 uplinks (payload version 2). Spec:
// docs/superpowers/specs/2026-08-19-sdi12-multi-segment-uplinks-design.md
// No Node-RED, no I/O: the caller persists `state` (flow context) and passes
// nowMs so the window is testable.

var WINDOW_MS = 600000; // 10 min: >> Dragino inter-segment spacing, < 20 min TDC
var MAX_COUNT = 15;      // Dragino: at most 15 segments / 1500 bytes

function validate(segment) {
  if (!segment || typeof segment !== 'object') throw new Error('segment required');
  var c = segment.count, i = segment.index;
  if (!Number.isInteger(c) || c < 1 || c > MAX_COUNT) throw new Error('bad count ' + c);
  if (!Number.isInteger(i) || i < 0) throw new Error('bad index ' + i);
  if (typeof segment.ascii !== 'string') throw new Error('ascii must be a string');
  if (!Number.isFinite(segment.nowMs)) throw new Error('nowMs required');
}

function emit(segment, ascii) {
  return {
    BatV: segment.batV,
    EXTI_Trigger: segment.extiTrigger,
    Payver: 2,
    data_sum: ascii,
    Node_type: 'SDI12',
    recordedAt: segment.recordedAt || null
  };
}

function seenIndices(buf) {
  return Object.keys(buf.segments).map(Number).sort(function (a, b) { return a - b; });
}

function quarantineFor(buf) {
  return { channel: 'sdi12_segments_incomplete', raw: buf.count + ':[' + seenIndices(buf).join(',') + ']' };
}

function startBuffer(state, deveui, segment) {
  state[deveui] = { count: segment.count, firstAtMs: segment.nowMs, segments: {} };
  state[deveui].segments[segment.index] = segment;
  return state[deveui];
}

function step(state, deveui, segment) {
  validate(segment);
  if (segment.count === 1) {
    delete state[deveui]; // a device back on single-frame must not keep an orphan buffer
    return { action: 'passthrough', message: emit(segment, segment.ascii), status: 'passthrough' };
  }
  var buf = state[deveui];
  var resetReason = null;
  if (buf) {
    if (buf.count !== segment.count) resetReason = 'count';
    else if (segment.index >= buf.count) resetReason = 'range';
    else if (buf.segments[segment.index]) resetReason = 'duplicate';
    else if (segment.nowMs - buf.firstAtMs > WINDOW_MS) resetReason = 'window';
  } else if (segment.index >= segment.count) {
    // first segment we see is already out of range: nothing to reset, just refuse
    return { action: 'reset', quarantine: { channel: 'sdi12_segments_incomplete', raw: segment.count + ':[]' }, status: 'reset range' };
  }
  if (resetReason) {
    var q = quarantineFor(buf);
    delete state[deveui];
    if (segment.index < segment.count) startBuffer(state, deveui, segment);
    return { action: 'reset', quarantine: q, status: 'reset ' + resetReason };
  }
  if (!buf) buf = startBuffer(state, deveui, segment);
  else buf.segments[segment.index] = segment;

  var seen = seenIndices(buf);
  if (seen.length < buf.count) {
    return { action: 'buffered', status: 'seg ' + seen.length + '/' + buf.count };
  }
  var ascii = seen.map(function (i) { return buf.segments[i].ascii; }).join('');
  var last = buf.segments[buf.count - 1];
  delete state[deveui];
  return { action: 'complete', message: emit(last, ascii), status: 'complete ' + buf.count };
}

module.exports = { step: step, WINDOW_MS: WINDOW_MS, MAX_COUNT: MAX_COUNT };
