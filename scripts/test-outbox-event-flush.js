'use strict';

// F128 (zone add/remove propagation latency): the edge used to hand a local zone
// create/delete to the cloud only on the next tick of the 30 s "Flush Sync Outbox"
// inject (sync-outbox-inject, repeat "30"). Measured on Silvan 2026-09-17 over three
// create/delete pairs, the wait between the sync_outbox row's occurred_at and its
// delivered_at was 20.87 s / 27.02 s / 29.38 s on create and 29.65 s / 29.79 s /
// 29.82 s on delete -- i.e. the interval owned ~100 % of the edge->cloud latency
// (the cloud applier then finished within ~130 ms).
//
// The fix is a link pair from the zone mutation routes into a coalescing gate that
// drives the existing flush chain. This file pins BOTH halves:
//   * structure -- the link out/in pair and the gate exist in every shipped profile,
//     are wired into sync-outbox-build, every zone create/delete response node
//     actually taps the link out (otherwise the flush is dead code), and the
//     cloud zone-command applier pings the gate directly from the sync tab;
//   * behaviour -- the gate is bounded: a burst collapses into ONE flush, it never
//     fires more often than MIN_GAP_MS, it uses a single timer (no setInterval, no
//     busy loop), it emits a fresh msg (never the HTTP response msg, which still
//     carries msg.res), and its finalize clears the timer on redeploy.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');
const FLOW_PROFILES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];

const LINK_OUT_ID = 'sync-outbox-flush-link-out-zone';
const LINK_IN_ID = 'sync-outbox-flush-link-in';
const GATE_ID = 'sync-outbox-flush-coalesce';
const FLUSH_BUILD_ID = 'sync-outbox-build';
const ZONE_COMMAND_APPLY_ID = 'zone-command-apply-fn';
const FLUSH_MARK_ID = 'sync-outbox-mark';
const MQTT_ACK_ID = '9d5e3035c3d069c4';
const SYNC_TAB = '93b1537a596e0e6d';
const DEVICE_API_TAB = 'device-api-tab';

// Every node that terminates a zone create/delete on the edge. Both the scoped
// (OSI_SCOPED_ACCESS=1) router response output and the legacy chain's response
// formatter must tap the link out -- Silvan runs with the flag OFF, so a
// scoped-only tap would have shipped a fix that does nothing in the field.
const ZONE_MUTATION_TAPS = [
  ['scoped-zone-create-router', 1],
  ['scoped-zone-delete-router', 1],
  ['post-zone-response', 0],
  ['delete-zone-response', 0],
];

function loadFlows(relativeFlowPath) {
  return JSON.parse(fs.readFileSync(path.join(REPO, relativeFlowPath), 'utf8'));
}

function nodeById(flows, id, profile) {
  const node = flows.find((candidate) => candidate.id === id);
  assert.ok(node, `missing flow node ${id} in ${profile}`);
  return node;
}

for (const profile of FLOW_PROFILES) {
  const flows = loadFlows(profile);

  test(`[${profile}] link out lives on the device API tab and targets the sync tab link in`, () => {
    const linkOut = nodeById(flows, LINK_OUT_ID, profile);
    assert.equal(linkOut.type, 'link out');
    assert.equal(linkOut.z, DEVICE_API_TAB);
    assert.equal(linkOut.mode, 'link');
    assert.deepEqual(linkOut.links, [LINK_IN_ID]);
    assert.deepEqual(linkOut.wires, []);
  });

  test(`[${profile}] link in feeds the coalescing gate, which feeds the existing flush chain`, () => {
    const linkIn = nodeById(flows, LINK_IN_ID, profile);
    assert.equal(linkIn.type, 'link in');
    assert.equal(linkIn.z, SYNC_TAB);
    assert.deepEqual(linkIn.links, [LINK_OUT_ID]);
    assert.deepEqual(linkIn.wires, [[GATE_ID]]);

    const gate = nodeById(flows, GATE_ID, profile);
    assert.equal(gate.type, 'function');
    assert.equal(gate.z, SYNC_TAB);
    assert.equal(gate.outputs, 1);
    assert.deepEqual(gate.wires, [[FLUSH_BUILD_ID]]);
  });

  test(`[${profile}] every zone create/delete response taps the link out`, () => {
    for (const [nodeId, outputIndex] of ZONE_MUTATION_TAPS) {
      const node = nodeById(flows, nodeId, profile);
      const wires = (node.wires || [])[outputIndex] || [];
      assert.ok(
        wires.includes(LINK_OUT_ID),
        `${nodeId} output ${outputIndex} must wire to ${LINK_OUT_ID} in ${profile}; got ${JSON.stringify(wires)}`,
      );
    }
  });

  test(`[${profile}] applying a cloud zone command also pings the gate`, () => {
    // A zone added or removed from the cloud is applied by "Apply Zone Command",
    // whose UPDATE fires the same sync_outbox trigger as a local edit. Without
    // this tap the echo that retires the cloud's pending badge still waited for
    // the 30 s inject: measured 25.018 s and 24.988 s on Silvan 2026-09-17.
    // The node lives on the sync tab, so it reaches the gate directly -- no link
    // pair needed, and the link out stays a Device Management tab concern.
    const node = nodeById(flows, ZONE_COMMAND_APPLY_ID, profile);
    assert.deepEqual(
      node.wires,
      [[ 'weather-zones-command-apply-fn' ], [ MQTT_ACK_ID, GATE_ID ]],
      `${ZONE_COMMAND_APPLY_ID} must keep its pass-through and ack wiring and add the gate in ${profile}`,
    );
    assert.equal(node.outputs, 2, 'the tap must not change the node output count');
  });

  test(`[${profile}] the periodic flush inject is kept as the safety net`, () => {
    // The event-driven path is an accelerator, not a replacement: if a ping is
    // ever lost (restart mid-request, an outbox row written by a trigger on a
    // path with no tap), the 30 s interval still drains the outbox.
    const inject = nodeById(flows, 'sync-outbox-inject', profile);
    assert.equal(inject.repeat, '30');
    assert.deepEqual(inject.wires, [[FLUSH_BUILD_ID]]);
  });

  test(`[${profile}] only one outbox flush may be in flight across both triggers`, () => {
    // F134. The event-driven gate and the 30 s inject are independent entry points into
    // the same flush chain, and the chain neither claims rows nor tracked a flush in
    // progress, so both could POST the same undelivered rows. Measured on Silvan after
    // the gate shipped: 11 sync_outbox rows carrying delivered_at AND rejected_at at
    // once, none before it shipped. The lease lives in "Build Edge Event Batch" so the
    // inject path is covered by the same guard, not just the gate.
    const build = nodeById(flows, FLUSH_BUILD_ID, profile);
    assert.match(build.func, /outboxFlushInFlightAt/,
      'the builder must take a flush lease');
    assert.match(build.func, /outboxFlushFollowUp/,
      'a trigger arriving mid-flush must record a follow-up instead of being dropped');

    const mark = nodeById(flows, FLUSH_MARK_ID, profile);
    assert.match(mark.func, /outboxFlushInFlightAt/, 'the chain end must release the lease');
    assert.deepEqual(mark.wires, [[GATE_ID]],
      'the chain end must be able to drive exactly one follow-up flush through the gate');
  });

  test(`[${profile}] a terminal outbox row can never be marked twice`, () => {
    // The same overlap left rows with both delivered_at and rejected_at set, because
    // neither UPDATE excluded rows another flush had already settled. First terminal
    // write wins; a late duplicate response cannot overwrite it.
    const mark = nodeById(flows, FLUSH_MARK_ID, profile);
    // Each UPDATE is one line of JS string concatenation, so match to end of line
    // rather than to the next quote.
    const updates = mark.func.match(/UPDATE sync_outbox SET (?:delivered_at|rejected_at)[^\n]*/g) || [];
    assert.equal(updates.length, 2, `expected the delivered and rejected updates, got ${updates.length}`);
    for (const sql of updates) {
      assert.match(sql, /delivered_at IS NULL/, `missing delivered guard in: ${sql}`);
      assert.match(sql, /rejected_at IS NULL/, `missing rejected guard in: ${sql}`);
    }
  });

  test(`[${profile}] the gate uses a single timer and no polling primitive`, () => {
    const gate = nodeById(flows, GATE_ID, profile);
    assert.equal(typeof gate.func, 'string');
    assert.equal(typeof gate.finalize, 'string');
    assert.ok(!/setInterval/.test(gate.func), 'gate must not poll with setInterval');
    assert.ok(!/while\s*\(/.test(gate.func), 'gate must not busy-loop');
    assert.ok(/clearTimeout/.test(gate.finalize), 'finalize must clear the pending timer');
  });
}

// --- behaviour -------------------------------------------------------------

function makeHarness(startMs) {
  const timers = [];
  const sent = [];
  const store = new Map();
  let clockMs = startMs;
  const sandbox = {
    flow: {
      get: (key) => store.get(key),
      set: (key, value) => { store.set(key, value); },
    },
    node: {
      send: (msg) => { sent.push(msg); },
      warn: () => {},
      error: () => {},
    },
    setTimeout: (fn, delay) => {
      const handle = { fn, delay, cleared: false };
      timers.push(handle);
      return handle;
    },
    clearTimeout: (handle) => { if (handle) handle.cleared = true; },
    Date: { now: () => clockMs },
    Number,
    Math,
    JSON,
  };
  return {
    sandbox,
    timers,
    sent,
    advance(ms) { clockMs += ms; },
    fire(handle) {
      assert.ok(!handle.cleared, 'timer was cleared');
      handle.fn();
    },
  };
}

function runGateBody(source, harness, msg) {
  harness.sandbox.msg = msg;
  const script = new vm.Script(`(function () {\n${source}\n})()`, { filename: `${GATE_ID}.js` });
  return script.runInNewContext(harness.sandbox, { timeout: 1000 });
}

const canonicalGate = (() => {
  const flows = loadFlows(FLOW_PROFILES[0]);
  return nodeById(flows, GATE_ID, FLOW_PROFILES[0]);
})();

test('a single ping schedules one flush and sends nothing synchronously', () => {
  const harness = makeHarness(1_000_000);
  const result = runGateBody(canonicalGate.func, harness, { payload: 'ping' });
  assert.equal(result, null, 'gate must swallow the ping and send later');
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.timers.length, 1);
  harness.fire(harness.timers[0]);
  assert.equal(harness.sent.length, 1);
});

test('a burst of zone mutations collapses into exactly one flush', () => {
  const harness = makeHarness(2_000_000);
  for (let i = 0; i < 6; i += 1) {
    runGateBody(canonicalGate.func, harness, { payload: `ping-${i}` });
    harness.advance(5);
  }
  assert.equal(harness.timers.length, 1, 'a burst must not schedule one timer per mutation');
  harness.fire(harness.timers[0]);
  assert.equal(harness.sent.length, 1, 'a burst must produce exactly one POST');
});

test('back-to-back flushes are rate bounded by a minimum gap', () => {
  const harness = makeHarness(3_000_000);
  runGateBody(canonicalGate.func, harness, { payload: 'first' });
  harness.fire(harness.timers[0]);
  assert.equal(harness.sent.length, 1);

  // Second mutation immediately after the first flush: the gate must not fire
  // again straight away, it must wait out the remaining minimum gap.
  runGateBody(canonicalGate.func, harness, { payload: 'second' });
  assert.equal(harness.timers.length, 2);
  assert.ok(
    harness.timers[1].delay >= 500,
    `second flush must be spaced out; got ${harness.timers[1].delay} ms`,
  );
  // ...and still fast enough to beat the 30 s interval it replaces.
  assert.ok(
    harness.timers[1].delay <= 5000,
    `second flush must still be well under the 30 s interval; got ${harness.timers[1].delay} ms`,
  );
});

test('a backwards clock step cannot stall the gate', () => {
  // An NTP correction can move Date.now() behind the recorded lastAt. Without a
  // clamp the gate would wait out the whole jump before flushing again.
  const harness = makeHarness(3_500_000);
  runGateBody(canonicalGate.func, harness, { payload: 'first' });
  harness.fire(harness.timers[0]);
  harness.advance(-3_600_000);

  runGateBody(canonicalGate.func, harness, { payload: 'after-step-back' });
  assert.equal(harness.timers.length, 2);
  assert.ok(
    harness.timers[1].delay <= 750,
    `wait must stay bounded after a clock step; got ${harness.timers[1].delay} ms`,
  );
  harness.fire(harness.timers[1]);
  assert.equal(harness.sent.length, 2);
});

test('the flush msg is fresh and never carries the HTTP response object', () => {
  const harness = makeHarness(4_000_000);
  const res = { _isResponse: true };
  runGateBody(canonicalGate.func, harness, { payload: { id: 1 }, res, statusCode: 201 });
  harness.fire(harness.timers[0]);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0].res, undefined, 'must not forward msg.res into the sync chain');
  assert.equal(harness.sent[0].statusCode, undefined);
});

test('finalize clears a pending timer so a redeploy cannot leak it', () => {
  const harness = makeHarness(5_000_000);
  runGateBody(canonicalGate.func, harness, { payload: 'ping' });
  assert.equal(harness.timers.length, 1);
  const script = new vm.Script(`(function () {\n${canonicalGate.finalize}\n})()`, {
    filename: `${GATE_ID}.finalize.js`,
  });
  script.runInNewContext(harness.sandbox, { timeout: 1000 });
  assert.equal(harness.timers[0].cleared, true);
});

// --- behaviour: the flush lease, run against the shipped builder source ----

const canonicalBuild = (() => {
  const flows = loadFlows(FLOW_PROFILES[0]);
  return nodeById(flows, FLUSH_BUILD_ID, FLOW_PROFILES[0]);
})();

const OUTBOX_ROWS = [
  { event_uuid: 'e1', aggregate_type: 'ZONE', aggregate_key: 'z1', op: 'ZONE_UPSERTED', payload_json: '{"zone_uuid":"z1"}', sync_version: 1, occurred_at: '2026-09-17T14:00:00.000Z' },
  { event_uuid: 'e2', aggregate_type: 'ZONE', aggregate_key: 'z2', op: 'ZONE_UPSERTED', payload_json: '{"zone_uuid":"z2"}', sync_version: 1, occurred_at: '2026-09-17T14:00:01.000Z' },
];

function fakeDate(nowMs) {
  const RealDate = Date;
  function FakeDate(...args) {
    return args.length ? new RealDate(...args) : new RealDate(nowMs);
  }
  FakeDate.now = () => nowMs;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;
  return FakeDate;
}

function buildHarness(store, nowMs, outboxRows = OUTBOX_ROWS) {
  const warnings = [];
  const queries = [];
  function rowsFor(sql) {
    queries.push(sql);
    if (/FROM users/.test(sql)) {
      return [{ id: 1, server_url: 'https://cloud.example', server_sync_token: 'tok' }];
    }
    if (/FROM sync_outbox/.test(sql)) return outboxRows;
    return [];
  }
  class Database {
    all(sql, params, cb) {
      const done = typeof params === 'function' ? params : cb;
      done(null, rowsFor(String(sql)));
    }
    run(sql, params, cb) {
      const done = typeof params === 'function' ? params : cb;
      if (done) done(null);
    }
    close(cb) { if (cb) cb(null); }
  }
  return {
    warnings,
    queries,
    sandbox: {
      osiDb: { Database },
      env: { get: (key) => ({ DEVICE_EUI: '0016C001F11715E2', DEVICE_EUI_CONFIDENCE: 'authoritative' }[key]) },
      flow: { get: (k) => store.get(k), set: (k, v) => { store.set(k, v); } },
      global: { get: (k) => (k === 'fs' ? { existsSync: () => false, readFileSync: () => '{}' } : undefined) },
      node: { warn: (m) => warnings.push(String(m)), error: (m) => warnings.push(String(m)), log: () => {} },
      Date: fakeDate(nowMs),
      JSON, Number, Math, String, Object, Array, Boolean, Promise, Set, Map, isFinite, parseInt, parseFloat, RegExp, Error,
      console: { log: () => {}, warn: () => {}, error: () => {} },
    },
  };
}

async function runBuild(store, nowMs, outboxRows) {
  const harness = buildHarness(store, nowMs, outboxRows);
  harness.sandbox.msg = { payload: nowMs };
  const script = new vm.Script(`(async function () {\n${canonicalBuild.func}\n})()`, {
    filename: `${FLUSH_BUILD_ID}.js`,
  });
  const out = await script.runInNewContext(harness.sandbox, { timeout: 5000 });
  return { out, harness };
}

test('two overlapping triggers POST each outbox row once, not twice', async () => {
  const store = new Map();

  const first = await runBuild(store, 1_000_000);
  assert.ok(first.out, `the first flush must build a POST; warnings: ${first.harness.warnings.join(' | ')}`);
  assert.deepEqual(first.out._syncEventIds, ['e1', 'e2']);

  // The 30 s inject fires while that POST is still in flight (the chain end has not
  // run, so the lease is still held). It must not re-send the same rows.
  const second = await runBuild(store, 1_000_120);
  assert.equal(second.out, null, 'the second overlapping trigger must not build a second POST');
  assert.equal(second.harness.queries.some((sql) => /FROM sync_outbox/.test(sql)), false,
    'the skipped flush must not even re-read the outbox');
  assert.equal(store.get('outboxFlushFollowUp'), true,
    'the skipped trigger must be recorded as a follow-up, not silently dropped');
});

test('two builds dispatched in the same turn still POST once (V-294)', async () => {
  // The lease has to be claimed in the same synchronous turn as the check. Claiming it
  // after the cloud-target lookup and the outbox SELECT leaves a window where the inject
  // timer and the gate timer, both due in one event-loop turn, each pass the check before
  // either writes. Both callers here begin their synchronous prefix before either resolves
  // an await, which is exactly that window.
  const store = new Map();
  const first = runBuild(store, 5_000_000);
  const second = runBuild(store, 5_000_000);
  const [a, b] = await Promise.all([first, second]);

  const posts = [a.out, b.out].filter(Boolean);
  assert.equal(posts.length, 1, 'exactly one of two same-turn builds may POST');
  assert.deepEqual(posts[0]._syncEventIds, ['e1', 'e2']);
  assert.equal(store.get('outboxFlushFollowUp'), true,
    'the loser must arm exactly one follow-up rather than be dropped');
});

test('a flush with nothing to send releases the lease instead of holding it for 120 s', async () => {
  const store = new Map();
  const empty = await runBuild(store, 6_000_000, []);
  assert.equal(empty.out, null, 'an empty outbox produces no POST');
  assert.ok(!store.get('outboxFlushInFlightAt'),
    'an early return must not leave the lease held, or the next 120 s of flushes are skipped');

  // ...and the very next trigger can therefore flush normally.
  const next = await runBuild(store, 6_000_050);
  assert.ok(next.out, 'the following trigger must not be blocked by the empty flush');
});

test('the flush lease is released by the chain end, and a stale lease cannot wedge the chain', async () => {
  const store = new Map();
  await runBuild(store, 2_000_000);
  assert.ok(store.get('outboxFlushInFlightAt'), 'a flush in progress holds the lease');

  // Chain end ran: lease released, next trigger proceeds.
  store.set('outboxFlushInFlightAt', 0);
  const afterRelease = await runBuild(store, 2_000_050);
  assert.ok(afterRelease.out, 'once the lease is released the next trigger flushes');

  // Chain end never ran (process died mid-POST): the lease must expire, not wedge.
  const wedged = new Map([['outboxFlushInFlightAt', 3_000_000]]);
  const blocked = await runBuild(wedged, 3_000_100);
  assert.equal(blocked.out, null, 'a fresh lease still blocks');
  const expired = await runBuild(wedged, 3_000_000 + 120_000);
  assert.ok(expired.out, 'a stale lease must expire so the chain recovers on its own');
});

test('both shipped profiles carry a byte-identical gate', () => {
  const [a, b] = FLOW_PROFILES.map((profile) => nodeById(loadFlows(profile), GATE_ID, profile));
  assert.equal(a.func, b.func);
  assert.equal(a.finalize, b.finalize);
});
