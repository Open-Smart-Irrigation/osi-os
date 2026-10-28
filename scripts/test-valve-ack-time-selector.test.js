'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForDropPlan } = require('../tests/silvan/cases/V2-valve-acks');

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
