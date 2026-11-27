'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { withRadioFaults } = require('../chirpstack-standin');
const { compare } = require('../lib/compare');

test('radio fault affects one matching RPC and losing the injected failure breaks parity', (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || process.cwd(), 'radio-fault-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'armed.json');
  const target = 'A840410000000001';
  const calls = [];
  const normal = (_, callback) => callback(null, {});
  const handlers = withRadioFaults({
    get: normal, update: normal, getKeys: normal, createKeys: normal, updateKeys: normal,
  }, calls, file);
  const invoke = (rpc, eui) => {
    let result;
    handlers[rpc]({ request: { getDevEui: () => eui } }, (error) => { result = error; });
    return result;
  };
  const fault = { rpc: 'getKeys', eui: target, code: 7, details: 'synthetic denial' };
  fs.writeFileSync(file, JSON.stringify({ id: 'denial', faults: [fault] }));
  assert.equal(invoke('getKeys', 'A840410000000002'), null);
  assert.equal(invoke('get', target), null);
  assert.deepEqual(invoke('getKeys', target), { code: 7, details: 'synthetic denial' });
  assert.equal(invoke('getKeys', target), null);
  assert.deepEqual(calls, [{ fn: 'getKeys', eui: target, injectedFault: { code: 7, details: 'synthetic denial' } }]);

  const cassette = { steps: [{ id: 'denial', kind: 'http', radio: calls }] };
  assert.equal(compare(cassette, cassette).pass, true);
  const withoutFault = { steps: [{ id: 'denial', kind: 'http', radio: [{ fn: 'getKeys', eui: target }] }] };
  assert.equal(compare(cassette, withoutFault).pass, false);
});

test('queue failures leave the queue intact and match the nested enqueue EUI', (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || process.cwd(), 'radio-fault-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'armed.json');
  const eui = 'A840410000000001';
  const frame = { getDevEui: () => eui.toLowerCase(), getFPort: () => 25, getData_asU8: () => Buffer.from('80', 'hex') };
  const calls = [];
  const queue = [frame];
  const handlers = withRadioFaults({
    flushQueue: (_, callback) => { queue.length = 0; callback(null); },
    enqueue: (call, callback) => { queue.push(call.request.getQueueItem()); callback(null); },
  }, calls, file);
  const failure = { code: 7, details: 'synthetic denial' };
  fs.writeFileSync(file, JSON.stringify({ id: 'denial', faults: ['flushQueue', 'enqueue'].map((rpc) => ({ rpc, eui, ...failure })) }));
  const flush = { request: { getDevEui: () => eui.toLowerCase() } };
  const enqueue = { request: { getQueueItem: () => frame } };
  handlers.flushQueue(flush, (err) => assert.deepEqual(err, failure));
  handlers.enqueue(enqueue, (err) => assert.deepEqual(err, failure));
  assert.deepEqual(queue, [frame]);
  assert.deepEqual(calls, [
    { fn: 'flush', eui, injectedFault: failure },
    { fn: 'enqueue', eui, port: 25, hex: '80', injectedFault: failure },
  ]);
  const cassette = { steps: [{ id: 'denial', kind: 'timer', radio: calls }] };
  assert.equal(compare(cassette, { steps: [{ id: 'denial', kind: 'timer', radio: [] }] }).pass, false);
  handlers.flushQueue(flush, (err) => assert.equal(err, null));
  assert.deepEqual(queue, []);
  handlers.enqueue(enqueue, (err) => assert.equal(err, null));
  assert.deepEqual(queue, [frame]);
});
