'use strict';
// osi-uplink-dedup-guard -- bounded, in-memory idempotency check for the
// ChirpStack uplink ingest path (F83, 2026-09-17 overnight stabilization).
//
// Problem: republishing the same uplink (same DevEUI + fCnt + ChirpStack
// deduplicationId) on application/+/device/+/event/up produces a second
// device_data row. In production this happens on MQTT QoS-1 redelivery after
// a Node-RED/mosquitto reconnect, and on a ChirpStack retry -- reproduced
// live on Silvan (T16f harness C1, PR #270 body: "36/37: duplicate delivery
// is not deduplicated at ingest"). Double rows double-count rain/volumes and
// downstream rollups.
//
// This is deliberately NOT a durable fix: no schema change tonight (a UNIQUE
// index on device_data would need one, and is a separate, reviewed change).
// This module is a process-lifetime LRU-ish cache -- it resets on every
// Node-RED restart, exactly like the rest of in-memory flow state.
//
// Two known coverage limits (see also the PR body):
//   - Process-lifetime only: a Node-RED restart empties the cache, so a
//     redelivery that happens to straddle a restart is not caught. That is
//     the same limitation every other in-memory flow cache in this repo has.
//   - 10-minute TTL (default): a redelivery arriving more than DEFAULT_TTL_MS
//     after the original is not caught either. Both limits are the reason
//     this is explicitly NOT a substitute for a durable UNIQUE constraint.
// The "MQTT IN (Radio Observations)" -> radio-capture-fn ingest path (a
// separate, non-device_data radio-observations table) is out of scope.
//
// Keying:
//   - Prefer ChirpStack's own `deduplicationId` when present. ChirpStack
//     mints a fresh one per genuinely distinct uplink event, INCLUDING the
//     first uplink after a device rejoin, so keying on it is always safe:
//     two different deduplicationIds are never collapsed, regardless of
//     devEui/fCnt, and a redelivery (same physical event, republished)
//     always carries the SAME deduplicationId.
//   - Fall back to (devEui, fCnt, time-bucket) only when deduplicationId is
//     absent. fCnt ALONE is not safe across a rejoin (LoRaWAN resets a
//     device's own frame counter on rejoin), so the fallback also buckets
//     the local receipt time into fixed windows (default: the same size as
//     the cache's own TTL) -- two uplinks sharing a devEui+fCnt but more
//     than one bucket apart in wall-clock receipt time are never treated as
//     the same event.
//   - Every key is namespaced by an optional `source` (e.g. 'kiwi', 'strega',
//     's2120', 'lorain', 'lsn50', 'uc512', 'sdi12'). All 10 `mqtt in` nodes
//     in flows.json share the identical wildcard topic
//     (application/+/device/+/event/up) and ChirpStack profile-name fallback
//     matching is not exclusive (e.g. a profile literally named
//     "Dragino SDI-12 Soil Node" matches both the LSN50 and SDI12 name
//     checks), so two different decoders can legitimately be offered the
//     SAME physical uplink. Without a source prefix, whichever decoder's
//     osiLib.require('uplink-dedup') call happened to run first would
//     "claim" the shared key and silently starve the other decoder's own,
//     otherwise-legitimate write. Namespacing keeps each decoder's dedup
//     bookkeeping fully independent (F83-V2).
//
// This module is loaded once per Node-RED process via osiLib.require
// ('uplink-dedup') from every flows.json decode function that writes to
// device_data (KIWI/CLOVER "Process Data", "Process STREGA", S2120, LoRain,
// LSN50, UC512, SDI12). Node's own require() cache means every call site
// shares the SAME underlying guard instance -- exactly one LRU per gateway,
// not one per node.
//
// Fail-open, defense in depth (F83-V1): a dedup check is an optimization, not
// a correctness requirement for the write path -- an uplink dropped by a
// broken guard is a WORSE outcome (real telemetry silently lost) than an
// occasional missed duplicate (the original F83 bug this module fixes). So
// every public entry point here refuses to throw: hostile/malformed identity
// fields (e.g. a JSON-constructible object like
// { toString: 'x', valueOf: 'y' }, which makes String()/Number() throw
// TypeError per the ToPrimitive spec algorithm) are rejected by typeof
// checks before any conversion is attempted, AND the whole call is wrapped
// in try/catch as a second, independent layer -- so a defect this module's
// author did not anticipate still fails open instead of failing closed.
// Call sites additionally verify `typeof value.isDuplicateUplink ===
// 'function'` before calling, in case osi-lib's loader ever hands back a
// shape-drifted module (e.g. `{ value: {} }`).

const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Only ever convert values we already know are safe to convert. Never call
// String()/Number() on an arbitrary value: a JSON-constructible object like
// { toString: 'x', valueOf: 'y' } has non-callable toString/valueOf
// properties, so ToPrimitive's OrdinaryToPrimitive algorithm finds no usable
// conversion and throws "TypeError: Cannot convert object to primitive
// value" -- a real uplink payload can carry exactly this shape (it is valid
// JSON), so a malformed or hostile field must never reach String()/Number().
function safeIdentityString(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function safeFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const n = Number(value); // Number() on a string never throws, unlike on an object
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// Pure function: given uplink identity fields, decide the cache key. Never
// touches any cache state, so it is trivially unit-testable on its own, and
// never throws regardless of input shape (see the fail-open note above).
function buildDedupKey({ source, deduplicationId, devEui, fCnt, receivedAtMs, bucketMs } = {}) {
  const prefix = (typeof source === 'string' && source) ? source + ':' : '';

  const dedupIdRaw = safeIdentityString(deduplicationId);
  const dedupId = dedupIdRaw != null ? dedupIdRaw.trim() : '';
  if (dedupId) return prefix + 'D:' + dedupId;

  const euiRaw = safeIdentityString(devEui);
  const eui = euiRaw != null ? euiRaw.trim().toUpperCase() : '';
  const fCntNumber = safeFiniteNumber(fCnt);
  if (!eui || fCntNumber === null) {
    // Not enough identity to dedup safely. Returning null tells the caller
    // to treat this as never-a-duplicate -- an occasional extra row is far
    // safer than silently dropping telemetry we cannot positively identify.
    return null;
  }
  const bucketSize = (typeof bucketMs === 'number' && Number.isFinite(bucketMs) && bucketMs > 0)
    ? bucketMs
    : DEFAULT_TTL_MS;
  const now = (typeof receivedAtMs === 'number' && Number.isFinite(receivedAtMs)) ? receivedAtMs : Date.now();
  const bucket = Math.floor(now / bucketSize);
  return prefix + 'F:' + eui + ':' + fCntNumber + ':' + bucket;
}

// A bounded, TTL-evicting cache of "keys already seen". Insertion order in a
// Map matches recency here because callers only ever pass a monotonically
// nondecreasing receivedAtMs (Date.now() in production), so the standard
// "prune from the front until a still-fresh entry is hit" pattern is valid.
function createGuard(options) {
  const maxEntries = (options && Number.isFinite(options.maxEntries) && options.maxEntries > 0)
    ? Math.floor(options.maxEntries)
    : DEFAULT_MAX_ENTRIES;
  const ttlMs = (options && Number.isFinite(options.ttlMs) && options.ttlMs > 0)
    ? options.ttlMs
    : DEFAULT_TTL_MS;

  const seen = new Map(); // key -> insertedAtMs, oldest-first

  function pruneExpired(nowMs) {
    for (const [key, insertedAtMs] of seen) {
      if (nowMs - insertedAtMs > ttlMs) {
        seen.delete(key);
      } else {
        break; // everything after this is at least as fresh
      }
    }
  }

  function pruneOverCapacity() {
    while (seen.size > maxEntries) {
      const oldestKey = seen.keys().next().value;
      seen.delete(oldestKey);
    }
  }

  // Returns true when `key` was already recorded within the TTL window (a
  // duplicate: the caller must drop this delivery). Returns false and
  // records the key otherwise (including when key is null -- an unkeyable
  // input is never a duplicate and is never recorded, since there is
  // nothing meaningful to record).
  function checkAndRecord(key, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    pruneExpired(now);
    if (key == null) return false;
    if (seen.has(key)) return true;
    seen.set(key, now);
    pruneOverCapacity();
    return false;
  }

  // Fail-open (F83-V1): identity extraction is already hardened
  // (buildDedupKey never throws), but this try/catch is a deliberate second,
  // independent layer -- if a future change to buildDedupKey, checkAndRecord,
  // or the Map operations above ever introduces a throw this author did not
  // anticipate, a duplicate uplink must still never be dropped as though it
  // were a fresh one, but a device_data write must also never be blocked by
  // this optimization failing. Returning false here means "not a duplicate",
  // i.e. the write proceeds -- exactly the same safe default as an unkeyable
  // input.
  function isDuplicateUplink(identity) {
    try {
      const { source, deduplicationId, devEui, fCnt, receivedAtMs, bucketMs } = identity || {};
      const key = buildDedupKey({ source, deduplicationId, devEui, fCnt, receivedAtMs, bucketMs });
      return checkAndRecord(key, receivedAtMs);
    } catch (_e) {
      return false;
    }
  }

  function size() {
    return seen.size;
  }

  function reset() {
    seen.clear();
  }

  return { checkAndRecord, isDuplicateUplink, size, reset, maxEntries, ttlMs };
}

// F83-V4: a dropped duplicate must be observable at the pinned "info" log
// level (a bare node.debug() is invisible there), but a redelivery storm
// must not flood the log either. Rate-limits to at most one node.warn() per
// `key` per `windowMs`, backed by Node-RED's own per-node `context` store
// (the same context.get/context.set pattern already used by
// osi-device-writer's SDI12 dead-letter warning) so the rate limit survives
// across messages the way the dedup cache itself does. Never throws: an
// observability helper must never be able to block the write path it is
// reporting on.
function warnOncePerWindow(node, context, key, nowMs, windowMs, message) {
  try {
    if (!node || typeof node.warn !== 'function' || !context || typeof context.get !== 'function'
      || typeof context.set !== 'function') {
      return;
    }
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const window = (Number.isFinite(windowMs) && windowMs > 0) ? windowMs : DEFAULT_TTL_MS;
    const last = Number(context.get(key) || 0);
    if (Number.isFinite(last) && last > 0 && now - last < window) return;
    context.set(key, now);
    node.warn(message);
  } catch (_e) {
    // best-effort observability only; never let it throw
  }
}

// One shared instance per Node-RED process. Flow function nodes reach it
// exclusively through osiLib.require('uplink-dedup') -> module.exports below,
// never by constructing their own guard (that would defeat cross-decoder
// sharing). Tests exercise isolated behavior via createGuard() instead.
const defaultGuard = createGuard();

module.exports = {
  createGuard,
  buildDedupKey,
  isDuplicateUplink: defaultGuard.isDuplicateUplink,
  size: defaultGuard.size,
  warnOncePerWindow,
  _defaultGuard: defaultGuard, // test-only escape hatch
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
};
