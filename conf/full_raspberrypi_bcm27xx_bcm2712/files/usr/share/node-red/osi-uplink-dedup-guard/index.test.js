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
const { createGuard, buildDedupKey, warnOncePerWindow, DEFAULT_MAX_ENTRIES, DEFAULT_TTL_MS } = require('./index.js');

// A JSON-constructible object whose toString/valueOf properties are plain
// strings, not functions. ToPrimitive's OrdinaryToPrimitive algorithm tries
// each method name in turn, skips non-callable properties, and throws
// "TypeError: Cannot convert object to primitive value" once it runs out of
// candidates -- so String(HOSTILE_IDENTITY) and Number(HOSTILE_IDENTITY) both
// throw. A real uplink payload can legally carry exactly this shape (valid
// JSON has no notion of "function"), so this is not a contrived attack --
// it is a plausible malformed/hostile field (F83-V1).
const HOSTILE_IDENTITY = { toString: 'x', valueOf: 'y' };

describe('osi-uplink-dedup-guard: hostile-input reproducer sanity check', () => {
  it('confirms the reproducer: plain String()/Number() on the hostile identity object throws TypeError '
    + '(so a naive buildDedupKey implementation using them would too)', () => {
    assert.throws(() => String(HOSTILE_IDENTITY), TypeError);
    assert.throws(() => Number(HOSTILE_IDENTITY), TypeError);
  });
});

describe('osi-uplink-dedup-guard: buildDedupKey', () => {
  it('never throws on a hostile deduplicationId, devEui, or fCnt (F83-V1) -- treats each as unusable identity', () => {
    assert.doesNotThrow(() => buildDedupKey({ deduplicationId: HOSTILE_IDENTITY, devEui: 'AA', fCnt: 1 }));
    assert.doesNotThrow(() => buildDedupKey({ deduplicationId: null, devEui: HOSTILE_IDENTITY, fCnt: 1 }));
    assert.doesNotThrow(() => buildDedupKey({ deduplicationId: null, devEui: 'AA', fCnt: HOSTILE_IDENTITY }));
    // A hostile deduplicationId with no usable fallback identity must produce
    // the same "unkeyable" null a missing field would -- never a duplicate.
    assert.equal(buildDedupKey({ deduplicationId: HOSTILE_IDENTITY, devEui: 'AA', fCnt: HOSTILE_IDENTITY }), null);
  });

  it('does not treat a hostile deduplicationId as a real dedup id (falls through to the fCnt fallback instead)', () => {
    const withHostileDedupId = buildDedupKey({ deduplicationId: HOSTILE_IDENTITY, devEui: 'AA', fCnt: 1, receivedAtMs: 0 });
    const withNoDedupId = buildDedupKey({ devEui: 'AA', fCnt: 1, receivedAtMs: 0 });
    assert.equal(withHostileDedupId, withNoDedupId, 'a hostile/unusable deduplicationId must fall back exactly like a missing one');
  });

  it('an array, a boolean, and a bare object devEui are all treated as unusable identity, never converted', () => {
    assert.equal(buildDedupKey({ devEui: [1, 2, 3], fCnt: 1 }), null);
    assert.equal(buildDedupKey({ devEui: true, fCnt: 1 }), null);
    assert.equal(buildDedupKey({ devEui: {}, fCnt: 1 }), null);
  });

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

  // F83-V2: all 10 mqtt-in nodes in flows.json share the identical wildcard
  // topic, and ChirpStack profile-name fallback matching is not mutually
  // exclusive (e.g. a profile literally named "Dragino SDI-12 Soil Node"
  // matches both the LSN50 and SDI12 name checks), so two different decoders
  // can legitimately be offered the SAME physical uplink. Without a source
  // prefix, whichever decoder's dedup check ran first would "claim" the
  // shared key and silently starve the other, otherwise-legitimate decoder.
  it('namespaces the key by source: identical deduplicationId under two different sources never collides', () => {
    const a = buildDedupKey({ source: 'lsn50', deduplicationId: 'evt-1', devEui: 'AA', fCnt: 5 });
    const b = buildDedupKey({ source: 'sdi12', deduplicationId: 'evt-1', devEui: 'AA', fCnt: 5 });
    assert.notEqual(a, b);
  });

  it('namespaces the fallback key by source too: identical devEui/fCnt/bucket under two different sources never collides', () => {
    const a = buildDedupKey({ source: 'lsn50', devEui: 'AA', fCnt: 5, receivedAtMs: 0, bucketMs: 60000 });
    const b = buildDedupKey({ source: 'sdi12', devEui: 'AA', fCnt: 5, receivedAtMs: 0, bucketMs: 60000 });
    assert.notEqual(a, b);
  });

  it('the same source with the same identity still collides (namespacing narrows, never fully isolates a real redelivery)', () => {
    const a = buildDedupKey({ source: 'lsn50', deduplicationId: 'evt-1', devEui: 'AA', fCnt: 5 });
    const b = buildDedupKey({ source: 'lsn50', deduplicationId: 'evt-1', devEui: 'AA', fCnt: 5 });
    assert.equal(a, b);
  });

  it('a missing/non-string source behaves exactly like no source given (no accidental prefix leakage)', () => {
    const noSource = buildDedupKey({ deduplicationId: 'evt-1' });
    const undefinedSource = buildDedupKey({ source: undefined, deduplicationId: 'evt-1' });
    const nonStringSource = buildDedupKey({ source: 42, deduplicationId: 'evt-1' });
    assert.equal(noSource, undefinedSource);
    assert.equal(noSource, nonStringSource);
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

  // F83-V6 (load-bearing): the FIRST version of this test put the two events
  // 5 minutes apart, which is also more than one 60s fallback bucket apart --
  // so it kept passing even under a hypothetical regression that deleted the
  // "prefer deduplicationId" branch entirely and always fell back to
  // (devEui, fCnt, bucket). That mutation would NOT have been caught. This
  // version places the two events 100ms apart, well INSIDE the same fallback
  // bucket (ttlMs/bucketMs = 60000ms): if deduplicationId were ever ignored,
  // both events would collapse onto the identical fallback key
  // ('F:AA:BB:3:<bucket 0>') and the second call would wrongly return true.
  it('the SAME fCnt reused after a rejoin (a different deduplicationId, inside the same fallback bucket) is NOT a duplicate', () => {
    const guard = createGuard({ ttlMs: 60000 });
    const beforeRejoin = { deduplicationId: 'session-1-evt', devEui: 'AA:BB', fCnt: 3, receivedAtMs: 0 };
    // A rejoin resets the device's own frame counter, so a post-rejoin uplink
    // can legitimately carry the SAME fCnt as a pre-rejoin one, arriving only
    // moments later. ChirpStack always mints a fresh deduplicationId per
    // delivered event (including after a rejoin), so the primary key path
    // must never fall through to an fCnt/bucket comparison when
    // deduplicationId is present on both sides -- regardless of how close in
    // time the two events are.
    const afterRejoin = { deduplicationId: 'session-2-evt', devEui: 'AA:BB', fCnt: 3, receivedAtMs: 100 };
    assert.equal(guard.isDuplicateUplink(beforeRejoin), false);
    assert.equal(guard.isDuplicateUplink(afterRejoin), false,
      'a different deduplicationId must always win over a coincidentally-matching fCnt, even within the same fallback bucket');
  });

  it('(sanity check on the load-bearing claim above) the same scenario WOULD collide via the fallback path alone '
    + '-- proving the deduplicationId branch, not the bucket, is what keeps it apart', () => {
    const guard = createGuard({ ttlMs: 60000 });
    const beforeRejoin = { devEui: 'AA:BB', fCnt: 3, receivedAtMs: 0 }; // no deduplicationId -> fallback path
    const afterRejoin = { devEui: 'AA:BB', fCnt: 3, receivedAtMs: 100 };
    assert.equal(guard.isDuplicateUplink(beforeRejoin), false);
    assert.equal(guard.isDuplicateUplink(afterRejoin), true,
      'without a deduplicationId, the same devEui+fCnt 100ms apart IS a duplicate under the fallback path -- ' +
      'confirming the previous test only passes because deduplicationId is actually consulted');
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

  // F83-V1: isDuplicateUplink itself is a second, independent fail-open layer
  // on top of buildDedupKey's own typeof guards -- even a defect this
  // author did not anticipate must still resolve to "not a duplicate", never
  // to a thrown exception that could abort the caller's write path.
  it('isDuplicateUplink never throws for a hostile identity object, and treats it as never-a-duplicate (F83-V1)', () => {
    // Each assertion uses its own fresh guard: the hostile deduplicationId
    // falls back to a real (devEui, fCnt, bucket) key (see the buildDedupKey
    // test above), so checking the SAME identity twice on one guard would
    // correctly report a duplicate on the second call -- that would defeat
    // the point of this test, which is "never throws", not "never repeats".
    assert.doesNotThrow(() => createGuard().isDuplicateUplink({ deduplicationId: HOSTILE_IDENTITY, devEui: 'AA', fCnt: 1 }));
    assert.equal(createGuard().isDuplicateUplink({ deduplicationId: HOSTILE_IDENTITY, devEui: 'AA', fCnt: 1 }), false);
    assert.doesNotThrow(() => createGuard().isDuplicateUplink(null));
    assert.doesNotThrow(() => createGuard().isDuplicateUplink(undefined));
    assert.doesNotThrow(() => createGuard().isDuplicateUplink('not-an-object'));
    assert.equal(createGuard().isDuplicateUplink(null), false);
    assert.equal(createGuard().isDuplicateUplink(undefined), false);
  });

  it('isDuplicateUplink survives an identity object engineered to defeat the typeof guards themselves '
    + '(a Proxy whose property access throws) -- proving the try/catch inside isDuplicateUplink is a real, '
    + 'independent second layer, not merely redundant with buildDedupKey\'s own typeof checks', () => {
    const guard = createGuard();
    const throwingProxy = new Proxy({}, {
      get() { throw new Error('boom: any property access throws'); },
    });
    assert.doesNotThrow(() => guard.isDuplicateUplink(throwingProxy));
    assert.equal(guard.isDuplicateUplink(throwingProxy), false);
  });
});

describe('osi-uplink-dedup-guard: warnOncePerWindow (F83-V4 observability)', () => {
  function makeContextStub() {
    const store = new Map();
    return { get: (k) => store.get(k), set: (k, v) => store.set(k, v) };
  }

  // Timestamps below start at a realistic epoch-scale value (never 0):
  // context.get() returning the falsy number 0 is indistinguishable from
  // "never warned" under the `Number(context.get(key) || 0)` idiom this
  // helper shares with osi-device-writer's SDI12 dead-letter warning -- a
  // real Date.now() is never 0, so this only matters for test timestamps.
  const T0 = 1700000000000;

  it('calls node.warn on the first drop for a key, and suppresses further calls inside the window', () => {
    const warns = [];
    const node = { warn: (msg) => warns.push(msg) };
    const context = makeContextStub();
    warnOncePerWindow(node, context, 'k1', T0, 10000, 'first drop');
    warnOncePerWindow(node, context, 'k1', T0 + 5000, 10000, 'second drop (suppressed)');
    assert.deepEqual(warns, ['first drop']);
  });

  it('warns again once the window has elapsed', () => {
    const warns = [];
    const node = { warn: (msg) => warns.push(msg) };
    const context = makeContextStub();
    warnOncePerWindow(node, context, 'k1', T0, 10000, 'first drop');
    warnOncePerWindow(node, context, 'k1', T0 + 10001, 10000, 'third drop (window elapsed)');
    assert.deepEqual(warns, ['first drop', 'third drop (window elapsed)']);
  });

  it('different keys (e.g. different devEuis) are rate-limited independently', () => {
    const warns = [];
    const node = { warn: (msg) => warns.push(msg) };
    const context = makeContextStub();
    warnOncePerWindow(node, context, 'deviceA', T0, 10000, 'A drop');
    warnOncePerWindow(node, context, 'deviceB', T0, 10000, 'B drop');
    assert.deepEqual(warns, ['A drop', 'B drop']);
  });

  it('never throws, even given a malformed node/context (an observability helper must never block the caller)', () => {
    assert.doesNotThrow(() => warnOncePerWindow(null, null, 'k1', T0, 10000, 'msg'));
    assert.doesNotThrow(() => warnOncePerWindow({}, {}, 'k1', T0, 10000, 'msg'));
    assert.doesNotThrow(() => warnOncePerWindow(
      { warn: () => { throw new Error('node.warn is broken'); } },
      makeContextStub(),
      'k1', T0, 10000, 'msg'
    ));
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
