'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const v2 = require('../tests/silvan/cases/V2-valve-acks');
const { waitForDropPlan } = v2;

const EUI = '0016C001F1000001';
const QUEUE = '2026-05-01 12:00:00';
const record = (at, more = {}) => ({
  at, deveui: EUI, decoded: { kind: 'WEEKDAY_PLAN' }, ...more,
});
function fakeObserver(records) {
  return {
    waitForDownlink: async (predicate, timeoutMs) => {
      assert.equal(timeoutMs, 15000);
      return records.find(predicate) || null;
    },
  };
}
const select = (queuedAt, records, seen = new Set()) =>
  waitForDropPlan(fakeObserver(records), EUI, queuedAt, seen);

test('same-day earlier is rejected and later is selected', async () => {
  const old = record('2026-05-01T11:59:59.999Z');
  const fresh = record('2026-05-01T12:00:00.001Z');
  assert.equal(await select(QUEUE, [old, fresh]), fresh);
});

test('equal instant is not after the queue', async () => {
  const equal = record('2026-05-01T12:00:00.000Z');
  const later = record('2026-05-01T12:00:00.001Z');
  assert.equal(await select(QUEUE, [equal, later]), later);
});

test('explicit offsets compare as the same UTC instants', async () => {
  const before = record('2026-05-01T13:59:59.999+02:00');
  const equal = record('2026-05-01T14:00:00+02:00');
  const later = record('2026-05-01T14:00:00.001+02:00');
  assert.equal(await select(QUEUE, [before, equal, later]), later);
});

test('negative offsets add to local time, including across midnight', async () => {
  const before = record('2026-05-01T09:59:59.999-02:00');
  const equal = record('2026-05-01T10:00:00-02:00');
  const later = record('2026-05-01T10:00:00.001-02:00');
  assert.equal(await select(QUEUE, [before, equal, later]), later);

  const lastDay = record('2026-04-30T21:29:59.999-02:30');
  const midnight = record('2026-04-30T21:30:00-02:30');
  const nextDay = record('2026-04-30T21:30:00.001-02:30');
  assert.equal(await select('2026-05-01 00:00:00', [lastDay, midnight, nextDay]), nextDay);
});

test('SQLite fractions preserve millisecond order', async () => {
  const before = record('2026-05-01T12:00:00.124Z');
  const equal = record('2026-05-01T12:00:00.125Z');
  const later = record('2026-05-01T12:00:00.126Z');
  assert.equal(await select(QUEUE + '.125', [before, equal, later]), later);
});

test('one and two digit fractions preserve the same instant ordering', async () => {
  for (const [fraction, before, after] of [
    ['.1', '.099', '.101'],
    ['.12', '.119', '.121'],
  ]) {
    const base = '2026-05-01T12:00:00';
    const equal = record(base + fraction + 'Z');
    const later = record(base + after + 'Z');
    assert.equal(
      await select(QUEUE + fraction, [record(base + before + 'Z'), equal, later]), later
    );
  }
});

test('records already observed before the edit cannot satisfy the new push', async () => {
  const prior = record('2026-05-01T12:00:00.500Z');
  const fresh = record('2026-05-01T12:00:00.501Z');
  assert.equal(await select(QUEUE, [prior, fresh], new Set([prior])), fresh);
});

test('device and plan kind remain part of the selector', async () => {
  const other = record('2026-05-01T12:00:00.001Z', { deveui: '0016C001F1000002' });
  const wrongKind = record('2026-05-01T12:00:00.001Z', { decoded: { kind: 'CLOCK_SYNC' } });
  const fresh = record('2026-05-01T12:00:00.001Z');
  assert.equal(await select(QUEUE, [other, wrongKind, fresh]), fresh);
});

test('SQLite queue text means UTC in a non-UTC process', async () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = 'Pacific/Honolulu';
    const before = record('2026-05-01T11:59:59.999Z');
    const later = record('2026-05-01T12:00:00.001Z');
    assert.equal(await select(QUEUE, [before, later]), later);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('invalid queue and observer fields reject visibly', async () => {
  const valid = record('2026-05-01T12:00:00.001Z');
  for (const invalid of [undefined, '2026-02-30 12:00:00', QUEUE + '.1234']) {
    await assert.rejects(select(invalid, [valid]), /invalid queue/);
  }
  for (const invalid of [
    undefined, '2026-02-30T12:00:00.000Z', '2026-05-01T12:00:00',
    '2026-05-01T12:00:00+24:00', '2026-05-01T12:00:00.1234Z',
  ]) {
    await assert.rejects(select(QUEUE, [record(invalid), valid]), /invalid observer/);
  }
});

test('minute and second rollover rejects instead of normalizing forward', async () => {
  const valid = record('2026-05-01T12:00:00.001Z');
  for (const invalid of ['2026-05-01 11:60:00', '2026-05-01 11:59:60']) {
    await assert.rejects(select(invalid, [valid]), /invalid queue/);
  }
  for (const invalid of [
    '2026-05-01T12:60:00.000Z', '2026-05-01T12:00:60.000Z', '2026-05-01T12:00:00+00:60',
  ]) {
    await assert.rejects(select(QUEUE, [record(invalid), valid]), /invalid observer/);
  }
});

function delayedObserver(deliveries) {
  const downlinks = [];
  const waiters = [];
  return {
    waitForDownlink(predicate, timeoutMs) {
      assert.equal(timeoutMs, 15000);
      const already = downlinks.find(predicate);
      if (already) return Promise.resolve(already);
      return new Promise((resolve, reject) => {
        const waiter = { match: predicate, resolve };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('offline delayed observer timed out'));
        }, 250);
        deliveries.forEach((entry, index) => setTimeout(() => {
          downlinks.push(entry);
          // Mirror DownlinkObserver._onDownlink: the callback does not catch match errors.
          for (const pending of waiters.slice()) {
            if (pending.match(entry)) {
              waiters.splice(waiters.indexOf(pending), 1);
              clearTimeout(timer);
              pending.resolve(entry);
            }
          }
        }, index + 1));
      });
    },
  };
}

test('malformed delayed observer timestamp rejects through the selector promise', async () => {
  const invalid = record('not-an-instant');
  const valid = record('2026-05-01T12:00:00.001Z');
  await assert.rejects(
    waitForDropPlan(delayedObserver([invalid, valid]), EUI, QUEUE, new Set()),
    /invalid observer/
  );
});

test('valid delayed observer record resolves through the selector promise', async () => {
  const valid = record('2026-05-01T12:00:00.001Z');
  assert.equal(
    await waitForDropPlan(delayedObserver([valid]), EUI, QUEUE, new Set()), valid
  );
});

// Drives the case's run() with offline stand-ins for every ctx service, so the
// drop step's prior-record snapshot is checked against the schedule edit order.
function fakeRunContext(runDir) {
  const downlinks = [];
  const events = [];
  const expectations = new Map();
  let dropEdited = false;
  const plan = (at, fPort, bytesHex) => {
    const downlink = record(at, { fPort, bytesHex });
    downlinks.push(downlink);
    return downlink;
  };
  const fresh = { at: '2026-05-01T12:00:01.000Z', fPort: 14, bytesHex: 'FRESH' };
  const observer = {
    get downlinks() {
      events.push(dropEdited ? 'snapshot-after-drop-edit' : 'snapshot-before-drop-edit');
      return downlinks.slice();
    },
    downlinksFor: (eui) => downlinks.filter((d) => d.deveui === eui),
    waitForDownlink: async (predicate, timeoutMs) => {
      assert.equal(timeoutMs, 15000);
      return downlinks.find(predicate) || null;
    },
    setBehaviour() {},
    answer() {},
    uplinksSent: [],
  };
  const rest = {
    post: async (route) => {
      if (route === '/api/irrigation-zones') return { status: 201, body: { id: 7 } };
      // Seen before the drop edit, yet later than the drop cutoff: only the snapshot excludes it.
      plan('2026-05-01T12:00:00.500Z', 15, 'PRIOR');
      return { status: 201, body: { schedule_uuid: 'sched-1' } };
    },
    put: async (route, body) => {
      if (body && String(body.label).startsWith('drop ')) {
        events.push('drop-edit');
        dropEdited = true;
        plan(fresh.at, fresh.fPort, fresh.bytesHex);
      }
      return { status: route.includes('/strega/timed-action') ? 202 : 200, body: {} };
    },
    get: async () => ({ status: 200, body: { valves: [] } }),
    del: async () => ({ status: 200 }),
  };
  const ctx = {
    rest, observer, runDir,
    ssh: {
      sql: async () => [{ fport: 15, state: 'QUEUED', ack_status: null, queued_at: QUEUE }],
      sqlOne: async () => null,
    },
    ev: { note() {}, artifact() {}, cleanupStep() {} },
    U: { stregaGen1WeekdayAck: () => ({}) },
    profiles: {},
    freshDeveui: () => EUI,
    createSimDevice: async () => ({ status: 201 }),
    deleteSimDevice: async () => {},
    deleteZone: async () => {},
    publishActuatorUplink() {},
    expect: (label, ok, detail) => expectations.set(label, { ok, detail }),
    expectStatus() {},
    until: async (probe) => {
      const value = await probe();
      if (!value) throw new Error('offline until: no value');
      return value;
    },
    sleep: async () => {},
  };
  return { ctx, events, expectations, fresh };
}

test('drop step snapshots prior downlinks before the schedule edit', async () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-ack-selector-'));
  const { ctx, events, expectations, fresh } = fakeRunContext(runDir);
  try {
    await v2.run(ctx);
    await v2.cleanup(ctx);
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
  assert.deepEqual(events, ['snapshot-before-drop-edit', 'drop-edit']);
  const emitted = expectations.get('a plan downlink is still emitted when the valve is silent');
  assert.deepEqual(emitted, { ok: true, detail: { fPort: fresh.fPort, hex: fresh.bytesHex } });
});
