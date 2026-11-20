#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ROOT, PROFILES } = require('./lib/daily-scheduler-harness');
const { createExclusive, writeExclusive, verifyFrozen, sha, fixture } = require('./lib/daily-scheduler-oracles');

test('evidence creation refuses existing files and symlinks without modifying the target', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x1-exclusive-'));
  try {
    const target = path.join(dir, 'expected.json');
    const bytes = fs.readFileSync(path.join(fixture, 'expected.json'));
    writeExclusive(target, bytes);
    const link = path.join(dir, 'redirect.json');
    fs.symlinkSync(target, link);
    for (const output of [target, link]) {
      assert.throws(() => writeExclusive(output, 'replacement'), { code: 'EEXIST' });
      assert.throws(() => createExclusive(output, { replacement: true }), { code: 'EEXIST' });
      assert.deepStrictEqual(fs.readFileSync(target), bytes);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('capture flags and inherited output variables cannot overwrite committed oracles', () => {
  const files = ['expected.json', 'additional-expected.json', 'sequence-expected.json'];
  const before = files.map(file => sha(fs.readFileSync(path.join(fixture, file))));
  for (const [script, flag] of [
    ['test-daily-scheduler-parity.js', '--record'],
    ['test-daily-scheduler-additional.js', '--capture'],
    ['test-daily-scheduler-sequences.js', '--capture'],
  ]) {
    const run = spawnSync(process.execPath, [path.join(__dirname, script), flag], {
      cwd: ROOT, encoding: 'utf8',
      env: { ...process.env, OSI_X1_EVIDENCE: path.join(fixture, 'expected.json'), OSI_X1_OUTPUT: path.join(fixture, 'expected.json') },
    });
    assert.ifError(run.error);
    assert.equal(run.status, 1, script + ' capture refuses an existing oracle');
    assert.match(run.stderr, /oracle already exists|oracle is write-once/);
  }
  assert.deepStrictEqual(files.map(file => sha(fs.readFileSync(path.join(fixture, file)))), before);
  verifyFrozen();
});

test('scratch adapter generation creates outputs exclusively', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x1-preparer-'));
  const script = path.join(__dirname, 'prepare-daily-scheduler-adapters.js');
  try {
    const first = spawnSync(process.execPath, [script, '--output-dir', dir], { encoding: 'utf8' });
    assert.ifError(first.error); assert.equal(first.status, 0, first.stderr);
    const files = PROFILES.map(profile => path.join(dir, 'conf', profile, 'files/usr/share/flows.json'));
    const before = files.map(file => sha(fs.readFileSync(file)));
    const again = spawnSync(process.execPath, [script, '--output-dir', dir], { encoding: 'utf8' });
    assert.ifError(again.error); assert.equal(again.status, 1); assert.match(again.stderr, /EEXIST/);
    assert.deepStrictEqual(files.map(file => sha(fs.readFileSync(file))), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

function loadProbe(profile, fault, eager = false) {
  const root = path.join(ROOT, 'conf', profile, 'files/usr/share/node-red');
  return spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const path = require('node:path');
    const Module = require('node:module');
    const root = process.argv[1], fault = process.argv[2], eager = process.argv[3] === 'true';
    process.env.OSI_LIB_BASE = root;
    const load = Module._load;
    let failures = 0;
    Module._load = function(request, parent, isMain) {
      const resolved = Module._resolveFilename(request, parent);
      if (resolved === path.join(root, fault)) {
        failures++;
        throw new Error('synthetic extraction dependency failure');
      }
      // Negative control: reproduce an existing package eagerly importing
      // the new adapter package while its dependency is unavailable.
      if (eager && resolved === path.join(root, 'osi-scheduler-mean-query/index.js')) {
        load.call(this, path.join(root, 'osi-daily-scheduler'), parent, false);
      }
      return load.call(this, request, parent, isMain);
    };
    const loader = require(path.join(root, 'osi-lib'));
    if (fault.startsWith('osi-daily-scheduler/')) {
      const mean = loader.require('scheduler-mean-query');
      assert.equal(mean.ok, true, 'existing scheduler-mean-query stays available');
      assert.equal(failures, 0, 'existing package never attempts extraction dependencies');
      assert.equal(loader.require('scope').ok, true, 'existing scope stays available');
      const broken = loader.require('daily-scheduler');
      assert.equal(broken.ok, false); assert.match(broken.error, /synthetic extraction dependency failure/);
      assert.equal(failures, 1);
      assert.equal(loader.require('daily-scheduler').quarantined, true);
      assert.strictEqual(loader.require('scheduler-mean-query').value, mean.value);
      assert.equal(loader.require('scope').ok, true);
    } else {
      const daily = loader.require('daily-scheduler');
      assert.equal(daily.ok, true, 'scheduler package loads without its optional runtime helper');
      assert.equal(failures, 0, 'no eager mean-helper import from the package index');
      const errors = [];
      const output = daily.value.buildMeanQuery({ payload: { zone_id: 1, trigger_metric: 'SWT_1' } }, {
        osiLib: loader, node: { error(message) { errors.push(message); } },
      });
      assert.equal(output, null); assert.equal(failures, 1); assert.equal(errors.length, 1);
      assert.match(errors[0], /synthetic extraction dependency failure/);
      assert.equal(loader.require('scope').ok, true);
    }
  `, root, fault, String(eager)], { cwd: ROOT, encoding: 'utf8' });
}

for (const profile of PROFILES) {
  test(profile + ': extraction dependency failure is isolated from existing packages', () => {
    for (const fault of ['osi-daily-scheduler/schedule-save.js', 'osi-scheduler-mean-query/index.js']) {
      const run = loadProbe(profile, fault);
      assert.ifError(run.error); assert.equal(run.status, 0, run.stderr);
    }
    const mutant = loadProbe(profile, 'osi-daily-scheduler/schedule-save.js', true);
    assert.ifError(mutant.error); assert.equal(mutant.status, 1);
    assert.match(mutant.stderr, /existing scheduler-mean-query stays available/);
  });
}
