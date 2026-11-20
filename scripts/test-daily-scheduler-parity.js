#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const { functionSource, inlineForMutation } = require('./flow-function-source');
const fs = require('node:fs');
const path = require('node:path');
const { cases } = require('./lib/daily-scheduler-cases');
const { persistence } = require('./lib/daily-scheduler-persistence');
const { ROOT, PROFILES, execute } = require('./lib/daily-scheduler-harness');
const FIXTURE = path.join(__dirname, 'fixtures/daily-scheduler');
const legacy = require('./fixtures/daily-scheduler/legacy-nodes.json');
const adapterFile = path.join(FIXTURE, 'adapters.json');
async function main() {
  const record = process.argv.includes('--record');
  if (record) assert.ok(!fs.existsSync(path.join(ROOT, 'conf', PROFILES[0], 'files/usr/share/node-red/osi-daily-scheduler')), 'baseline recording must precede extraction');
  assert.equal(new Set(cases().map(c => c.name)).size, cases().length, 'case names must be unique');
  const expected = record ? {} : require('./fixtures/daily-scheduler/expected.json');
  let comparisons = 0;
  for (const profile of PROFILES) {
    const flows = JSON.parse(fs.readFileSync(path.join(ROOT, 'conf', profile, 'files/usr/share/flows.json')));
    const staged = fs.existsSync(adapterFile) ? require(adapterFile) : null;
    const saved = await persistence(legacy, profile);
    if(record) expected.$persistence = saved;
    else assert.deepStrictEqual(saved, expected.$persistence, 'frozen persistence');
    assert.deepStrictEqual(await persistence(flows, profile), saved, 'shipped persistence');
    if(staged) assert.deepStrictEqual(await persistence(staged, profile), saved, 'adapter persistence');
    assert.deepStrictEqual(saved.map(row => row.events.length), [0, 1, 2], 'NEW-9 first save emits no event; edit and disable do');
    if (staged) for (const adapter of staged) {
      const unavailable = await execute(adapter.func, { msg: { payload: 'unchanged' }, failure: 'daily-load' }, profile);
      assert.equal(unavailable.result, null, adapter.name + ' fails closed');
      assert.equal(unavailable.trace.length, 1);
      assert.equal(unavailable.trace[0][0], 'error');
      assert.match(unavailable.trace[0][1], /daily-scheduler unavailable/);
      assert.deepStrictEqual(unavailable.msg, { payload: 'unchanged' });
    }
    for (const c of cases()) {
      const original = legacy.find(n => n.id === c.id);
      const before = await execute(original.func, c, profile);
      if (record) expected[c.name] = before;
      else assert.deepStrictEqual(before, expected[c.name], profile + ' frozen baseline ' + c.name);
      const current = flows.find(n => n.id === c.id);
      const after = await execute(current.func, c, profile);
      assert.deepStrictEqual(after, before, profile + ' shipped ' + c.name);
      if (staged) {
        const adapter = staged.find(n => n.id === c.id);
        const moduleRoot = path.join(ROOT, 'conf', profile, 'files/usr/share/node-red');
        assert.ok(functionSource(adapter, moduleRoot).includes('function '));
        if (['verifyZoneOwnership', 'buildUpsert'].includes(adapter.entry)) {
          const inlined = inlineForMutation(adapter, moduleRoot);
          assert.deepStrictEqual(await execute(inlined.func, c, profile), before, profile + ' request mutant source ' + c.name);
        }
        assert.deepStrictEqual(adapter.wires, current.wires);
        assert.equal(adapter.outputs, current.outputs);
        for (const lib of current.libs) assert.ok(adapter.libs.some(x => x.var === lib.var && x.module === lib.module));
        assert.deepStrictEqual(await execute(adapter.func, c, profile), before, profile + ' adapter ' + c.name);
        const mod = require(path.join(ROOT, 'conf', profile, 'files/usr/share/node-red/osi-daily-scheduler'));
        const direct = await execute('', c, profile, (msg, deps) => {
          const value = mod[adapter.entry](msg, deps);
          if (process.argv.includes('--negative-control') && c.name === 'swt-mean-30') value[0].payload.data.duration_minutes++;
          return value;
        });
        assert.deepStrictEqual(direct, before, profile + ' module ' + c.name);
      }
      comparisons++;
    }
  }
  if(record) fs.writeFileSync(path.join(FIXTURE, 'expected.json'), JSON.stringify(expected, null, 2) + '\n');
  // EB9 will change this expectation: a refused command already has event/update outputs.
  const fired = expected['swt-mean-30'].result;
  assert.equal(fired[0].payload.data.action, 'OPEN_FOR_DURATION');
  assert.match(fired[1].topic, /'IRRIGATE'/);
  assert.match(fired[2].topic, /last_triggered_at/);
  for (const metric of ['swt', 'dendro']) {
    const refusal = expected['downstream-refusal-' + metric].downstream;
    assert.equal(refusal[0][1].accepted, false);
    assert.equal(refusal[1][0], 'event-write');
    assert.match(refusal[1][1], /'IRRIGATE'/);
    assert.equal(refusal[2][0], 'schedule-write');
  }
  assert.equal(expected['upsert-version-undefined-enabled-1'].msg.osi.applied.sync_version, 1);
  console.log(`daily-scheduler parity: OK (${comparisons} cases across both profiles; ${stagedLabel()})`);
}
function stagedLabel() { return fs.existsSync(adapterFile) ? 'legacy = shipped = module = staged adapter' : 'legacy = shipped; baseline recorded before extraction'; }
main().catch(e => { console.error(e); process.exitCode = 1; });
