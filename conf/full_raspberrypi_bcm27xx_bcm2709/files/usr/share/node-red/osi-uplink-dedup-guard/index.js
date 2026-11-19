'use strict';
// Bounded in-memory duplicate hints and durable network identity builders.
// createGuard() and the default singleton are process-local: restart or TTL
// expiry forgets them. Canonical writers additionally persist the key from
// durable.js under a partial unique index (migration 0081). A database row,
// rather than this pre-write hint, proves an uplink was committed.
// Radio capture and transactional rain ingest use their own durable identities.
//
// Keying:
//   - Prefer ChirpStack's own `deduplicationId` when present. ChirpStack
//     mints a fresh one per genuinely distinct uplink event, INCLUDING the
//     first uplink after a device rejoin, so keying on it is always safe:
//     two different deduplicationIds are never collapsed, regardless of
//     devEui/fCnt, and a redelivery (same physical event, republished)
//     always carries the SAME deduplicationId.
//   - Fall back to the same original network timestamp/frame identity used
//     by durable.js. Receipt time controls cache expiry only. Without a usable
//     network identity, fail open instead of suppressing a new reading.
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

// Both guards use eventKey; the memory map additionally scopes by device,
// just as the database's (deveui,uplink_key) unique index does.
function buildDedupKey(identity = {}) {
  try {
    const event = identity.event || identity;
    const source = typeof identity.source === 'string' && identity.source ? identity.source : 'uplink';
    const euiRaw = safeIdentityString(identity.devEui ?? event.deviceInfo?.devEui);
    const eui = euiRaw == null ? '' : euiRaw.trim().toUpperCase();
    if (!eui && !(typeof event.deduplicationId === 'string' && event.deduplicationId.trim())) return null;
    const key = require('./durable').eventKey(source, event);
    return key ? eui + ':' + key : null;
  } catch (_error) { return null; }
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
      const key = buildDedupKey(identity);
      return checkAndRecord(key, identity && identity.receivedAtMs);
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
  ...require('./durable'),
  createGuard,
  buildDedupKey,
  isDuplicateUplink: defaultGuard.isDuplicateUplink,
  size: defaultGuard.size,
  warnOncePerWindow,
  _defaultGuard: defaultGuard, // test-only escape hatch
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
};
