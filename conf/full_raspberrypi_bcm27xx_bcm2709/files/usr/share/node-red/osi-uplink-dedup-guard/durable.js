'use strict';
const { createHash } = require('node:crypto');

// Use network event identity, never local receipt time or fCnt alone: frame
// counters restart on rejoin. Hashing bounds the index entry and keeps the
// source namespace independent for overlapping decoder profile fallbacks.
function buildEventKey(source, envelope) {
  if (typeof source !== 'string' || !source || !envelope || typeof envelope !== 'object') return null;
  const id = envelope.deduplicationId;
  let identity;
  if (typeof id === 'string' && id.trim()) identity = ['id', id.trim()];
  else if (Number.isInteger(envelope.fCnt) && envelope.fCnt >= 0
      && typeof envelope.time === 'string' && envelope.time.trim()
      && Number.isFinite(Date.parse(envelope.time))) {
    // Keep the original timestamp precision; milliseconds could collapse two events.
    identity = ['frame', envelope.devAddr || null, envelope.fCnt, envelope.fPort ?? null, envelope.time];
  } else return null;
  return createHash('sha256').update(JSON.stringify([source, identity])).digest('hex');
}

// Identity is optional. Malformed input must not suppress real telemetry.
function eventKey(source, envelope) {
  try { return buildEventKey(source, envelope); } catch (_error) { return null; }
}

function sdi12Key(info) {
  const frames = info && info.frames;
  if (!Array.isArray(frames) || !frames.length) return null;
  const keys = frames.map(frame => eventKey('sdi12', frame && frame.event));
  if (keys.some(key => !key)) return null;
  return createHash('sha256').update(JSON.stringify([...new Set(keys)].sort())).digest('hex');
}

module.exports = { eventKey, sdi12Key };
