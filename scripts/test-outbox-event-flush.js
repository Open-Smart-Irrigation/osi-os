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
//     are wired into sync-outbox-build, and every zone create/delete response node
//     actually taps the link out (otherwise the flush is dead code);
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

  test(`[${profile}] the periodic flush inject is kept as the safety net`, () => {
    // The event-driven path is an accelerator, not a replacement: if a ping is
    // ever lost (restart mid-request, an outbox row written by a trigger on a
    // path with no tap), the 30 s interval still drains the outbox.
    const inject = nodeById(flows, 'sync-outbox-inject', profile);
    assert.equal(inject.repeat, '30');
    assert.deepEqual(inject.wires, [[FLUSH_BUILD_ID]]);
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

test('both shipped profiles carry a byte-identical gate', () => {
  const [a, b] = FLOW_PROFILES.map((profile) => nodeById(loadFlows(profile), GATE_ID, profile));
  assert.equal(a.func, b.func);
  assert.equal(a.finalize, b.finalize);
});
