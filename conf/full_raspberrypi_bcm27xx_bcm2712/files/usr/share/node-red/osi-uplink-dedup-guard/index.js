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
//
// This module is loaded once per Node-RED process via osiLib.require
// ('uplink-dedup') from every flows.json decode function that writes to
// device_data (KIWI/CLOVER "Process Data", "Process STREGA", S2120, LoRain,
// LSN50, UC512, SDI12). Node's own require() cache means every call site
// shares the SAME underlying guard instance -- exactly one LRU per gateway,
// not one per node.

const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Pure function: given uplink identity fields, decide the cache key. Never
// touches any cache state, so it is trivially unit-testable on its own.
function buildDedupKey({ deduplicationId, devEui, fCnt, receivedAtMs, bucketMs } = {}) {
  const dedupId = deduplicationId != null ? String(deduplicationId).trim() : '';
  if (dedupId) return 'D:' + dedupId;

  const eui = devEui != null ? String(devEui).trim().toUpperCase() : '';
  const fCntNumber = Number(fCnt);
  if (!eui || fCnt === null || fCnt === undefined || !Number.isFinite(fCntNumber)) {
    // Not enough identity to dedup safely. Returning null tells the caller
    // to treat this as never-a-duplicate -- an occasional extra row is far
    // safer than silently dropping telemetry we cannot positively identify.
    return null;
  }
  const bucketSize = (Number.isFinite(bucketMs) && bucketMs > 0) ? bucketMs : DEFAULT_TTL_MS;
  const now = Number.isFinite(receivedAtMs) ? receivedAtMs : Date.now();
  const bucket = Math.floor(now / bucketSize);
  return 'F:' + eui + ':' + fCntNumber + ':' + bucket;
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

  function isDuplicateUplink({ deduplicationId, devEui, fCnt, receivedAtMs, bucketMs } = {}) {
    const key = buildDedupKey({ deduplicationId, devEui, fCnt, receivedAtMs, bucketMs });
    return checkAndRecord(key, receivedAtMs);
  }

  function size() {
    return seen.size;
  }

  function reset() {
    seen.clear();
  }

  return { checkAndRecord, isDuplicateUplink, size, reset, maxEntries, ttlMs };
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
  _defaultGuard: defaultGuard, // test-only escape hatch
  DEFAULT_MAX_ENTRIES,
  DEFAULT_TTL_MS,
};
