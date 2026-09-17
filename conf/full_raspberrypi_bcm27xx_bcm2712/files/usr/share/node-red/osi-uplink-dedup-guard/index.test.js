'use strict';
// Red-first tests for F83 (edge main uplink ingest has no idempotency: an
// MQTT QoS-1 redelivery or ChirpStack retry of the SAME uplink produces a
// second device_data row -- reproduced live on Silvan, T16f harness C1,
// PR #270 body "36/37: duplicate delivery is not deduplicated at ingest").
//
// This module is the bounded in-memory LRU idempotency guard shared by every
// flows.json decode function that writes to device_data (KIWI/CLOVER "Process
// Data", "Process STREGA", S2120, LoRain, LSN50, UC512, SDI12). No schema
// change: this is a process-lifetime cache, not a durable UNIQUE constraint --
// a Node-RED restart clears it, same as any other in-memory dedup.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createGuard, buildDedupKey, DEFAULT_MAX_ENTRIES, DEFAULT_TTL_MS } = require('./index.js');

describe('osi-uplink-dedup-guard: buildDedupKey', () => {
  it('keys on deduplicationId alone when present, ignoring fCnt/time entirely', () => {
    const a = buildDedupKey({ deduplicationId: 'dedup-1', devEui: 'AA', fCnt: 5, receivedAtMs: 0 });
    const b = buildDedupKey({ deduplicationId: 'dedup-1', devEui: 'AA', fCnt: 999, receivedAtMs: 999999999 });
    assert.equal(a, b);
  });

  it('two different deduplicationIds never collide, even with identical devEui/fCnt', () => {
    const a = buildDedupKey({ deduplicationId: 'dedup-1', devEui: 'AA', fCnt: 5, receivedAtMs: 0 });
    const b = buildDedupKey({ deduplicationId: 'dedup-2', devEui: 'AA', fCnt: 5, receivedAtMs: 0 });
    assert.notEqual(a, b);
  });

  it('falls back to (devEui, fCnt, time-bucket) when deduplicationId is absent', () => {
    const a = buildDedupKey({ devEui: 'aa11', fCnt: 7, receivedAtMs: 1000, bucketMs: 60000 });
    const b = buildDedupKey({ devEui: 'AA11', fCnt: 7, receivedAtMs: 2000, bucketMs: 60000 });
    assert.equal(a, b, 'devEui is case-normalized and the two timestamps land in the same bucket');
  });

  it('fallback key differs once the fallback bucket boundary is crossed', () => {
    const a = buildDedupKey({ devEui: 'AA', fCnt: 7, receivedAtMs: 0, bucketMs: 60000 });
    const b = buildDedupKey({ devEui: 'AA', fCnt: 7, receivedAtMs: 120000, bucketMs: 60000 });
    assert.notEqual(a, b);
  });

  it('returns null (unkeyable, caller must not drop) when both deduplicationId and fCnt are missing', () => {
    assert.equal(buildDedupKey({ devEui: 'AA' }), null);
  });
});

describe('osi-uplink-dedup-guard: createGuard / isDuplicateUplink', () => {
  it('the SAME uplink republished verbatim (same deduplicationId, same fCnt) is a duplicate on the 2nd delivery', () => {
    const guard = createGuard();
    const uplink = { deduplicationId: 'evt-1', devEui: 'AA:BB', fCnt: 42, receivedAtMs: 1000 };
    assert.equal(guard.isDuplicateUplink(uplink), false, 'first delivery must NOT be treated as a duplicate');
    assert.equal(guard.isDuplicateUplink({ ...uplink, receivedAtMs: 1500 }), true,
      'redelivery of the identical envelope (same dedup id) a moment later must be dropped');
  });

  it('a genuinely different fCnt on the same device is never treated as a duplicate', () => {
    const guard = createGuard();
    const first = { deduplicationId: 'evt-1', devEui: 'AA:BB', fCnt: 42, receivedAtMs: 1000 };
    const second = { deduplicationId: 'evt-2', devEui: 'AA:BB', fCnt: 43, receivedAtMs: 1500 };
    assert.equal(guard.isDuplicateUplink(first), false);
    assert.equal(guard.isDuplicateUplink(second), false, 'a new reading must always be written');
  });

  it('the SAME fCnt reused after a rejoin (a different deduplicationId, well past the bucket window) is NOT a duplicate', () => {
    const guard = createGuard({ ttlMs: 60000 });
    const beforeRejoin = { deduplicationId: 'session-1-evt', devEui: 'AA:BB', fCnt: 3, receivedAtMs: 0 };
    // A rejoin resets the device's own frame counter, so a post-rejoin uplink
    // can legitimately carry the SAME fCnt as a pre-rejoin one. ChirpStack
    // always mints a fresh deduplicationId per delivered event (including
    // after a rejoin), so the primary key path must never fall through to an
    // fCnt comparison when deduplicationId is present on both sides.
    const afterRejoin = { deduplicationId: 'session-2-evt', devEui: 'AA:BB', fCnt: 3, receivedAtMs: 5 * 60000 };
    assert.equal(guard.isDuplicateUplink(beforeRejoin), false);
    assert.equal(guard.isDuplicateUplink(afterRejoin), false,
      'a different deduplicationId must always win over a coincidentally-matching fCnt');
  });

  it('fallback path: the SAME fCnt with NO deduplicationId, more than one bucket apart, is NOT a duplicate '
    + '(covers legacy/replay uplinks that never carry a deduplicationId, incl. a rejoin case)', () => {
    const guard = createGuard({ ttlMs: 60000 });
    const beforeRejoin = { devEui: 'CC:DD', fCnt: 0, receivedAtMs: 0 };
    const afterRejoin = { devEui: 'CC:DD', fCnt: 0, receivedAtMs: 5 * 60000 };
    assert.equal(guard.isDuplicateUplink(beforeRejoin), false);
    assert.equal(guard.isDuplicateUplink(afterRejoin), false);
  });

  it('fallback path: the SAME fCnt with NO deduplicationId inside the SAME bucket IS a duplicate', () => {
    const guard = createGuard({ ttlMs: 60000 });
    const first = { devEui: 'CC:DD', fCnt: 0, receivedAtMs: 0 };
    const redelivered = { devEui: 'CC:DD', fCnt: 0, receivedAtMs: 500 };
    assert.equal(guard.isDuplicateUplink(first), false);
    assert.equal(guard.isDuplicateUplink(redelivered), true);
  });

  it('an unkeyable uplink (no deduplicationId AND no usable fCnt) is never treated as a duplicate', () => {
    const guard = createGuard();
    assert.equal(guard.isDuplicateUplink({ devEui: 'AA' }), false);
    assert.equal(guard.isDuplicateUplink({ devEui: 'AA' }), false, 'still not a duplicate the 2nd time - never keyed');
  });

  it('is bounded: entries beyond maxEntries are evicted oldest-first', () => {
    const guard = createGuard({ maxEntries: 3, ttlMs: 10 * 60000 });
    guard.isDuplicateUplink({ deduplicationId: 'k1', receivedAtMs: 0 });
    guard.isDuplicateUplink({ deduplicationId: 'k2', receivedAtMs: 1 });
    guard.isDuplicateUplink({ deduplicationId: 'k3', receivedAtMs: 2 });
    assert.equal(guard.size(), 3);
    // A 4th distinct key pushes the cache over its cap; the oldest (k1) must
    // be evicted, so a redelivery of k1 now reads as a brand-new event.
    guard.isDuplicateUplink({ deduplicationId: 'k4', receivedAtMs: 3 });
    assert.equal(guard.size(), 3);
    assert.equal(guard.isDuplicateUplink({ deduplicationId: 'k1', receivedAtMs: 4 }), false,
      'k1 was evicted once the cache exceeded its bound, so it reads as new again');
    assert.equal(guard.isDuplicateUplink({ deduplicationId: 'k4', receivedAtMs: 5 }), true,
      'k4 is still resident and must still be caught as a duplicate');
  });

  it('is time-bounded: an entry older than ttlMs is evicted even under the entry cap', () => {
    const guard = createGuard({ maxEntries: 2000, ttlMs: 1000 });
    guard.isDuplicateUplink({ deduplicationId: 'stale-1', receivedAtMs: 0 });
    assert.equal(guard.isDuplicateUplink({ deduplicationId: 'stale-1', receivedAtMs: 5000 }), false,
      'more than ttlMs later, the same key must no longer read as a duplicate');
  });

  it('defaults match the brief: 2000 entries / 10 minutes', () => {
    assert.equal(DEFAULT_MAX_ENTRIES, 2000);
    assert.equal(DEFAULT_TTL_MS, 10 * 60 * 1000);
    const guard = createGuard();
    assert.equal(guard.maxEntries, 2000);
    assert.equal(guard.ttlMs, 10 * 60 * 1000);
  });

  it('reset() clears all recorded keys', () => {
    const guard = createGuard();
    guard.isDuplicateUplink({ deduplicationId: 'k1', receivedAtMs: 0 });
    assert.equal(guard.size(), 1);
    guard.reset();
    assert.equal(guard.size(), 0);
    assert.equal(guard.isDuplicateUplink({ deduplicationId: 'k1', receivedAtMs: 1 }), false);
  });
});

describe('osi-uplink-dedup-guard: module-level default singleton', () => {
  it('exports a shared default guard so every osiLib.require(\'uplink-dedup\') call site '
    + 'in flows.json (a different function node, same Node-RED process) sees the same cache', () => {
    const mod = require('./index.js');
    assert.equal(typeof mod.isDuplicateUplink, 'function');
    mod._defaultGuard.reset();
    const uplink = { deduplicationId: 'shared-evt-1', devEui: 'EE', fCnt: 1, receivedAtMs: 0 };
    assert.equal(mod.isDuplicateUplink(uplink), false);
    assert.equal(mod.isDuplicateUplink({ ...uplink, receivedAtMs: 10 }), true);
    mod._defaultGuard.reset();
  });
});
