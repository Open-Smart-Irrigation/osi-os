'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const cliPath = path.join(__dirname, 'sync-protocol-capability-cli.js');
const cli = require('./sync-protocol-capability-cli');

function dummy(verb) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-skeleton-'));
  const out = [verb];
  let n = 0;
  for (const [flag, kind] of Object.entries(cli.VERB_FLAGS[verb])) {
    out.push(flag);
    if (kind === 'path') out.push(path.join(d, `p-${++n}`));
    else if (kind === 'generation') out.push('0');
    else if (kind === 'sha256') out.push('a'.repeat(64));
    else if (kind === 'sha256OrAbsent') out.push('absent');
    else if (kind === 'pathOrNotApplicable') out.push('not-applicable');
    else out.push('x');
  }
  return out;
}

test('pins the full source-plan verb surface while A0 implements no runtime protocol authority', () => {
  assert.deepEqual(Object.keys(cli.VERB_FLAGS), [
    'initialize-factory-zero', 'initialize', 'status', 'record-v2-disposition',
    'prepare-disposition-restore', 'invalidate-v2-disposition', 'prepare-database-restore',
    'complete-database-restore-reconciliation', 'prepare-integrity-recovery',
    'complete-integrity-recovery', 'authorize-reset',
  ]);
  for (const verb of Object.keys(cli.VERB_FLAGS)) {
    const r = cp.spawnSync(process.execPath, [cliPath, ...dummy(verb)], { encoding: 'utf8' });
    assert.notEqual(r.status, 0, verb);
    assert.match(r.stderr, /NOT_IMPLEMENTED_IN_THIS_SLICE/, verb);
  }
});

test('unknown, duplicate, missing, relative path, and positional argv fail before dispatch', () => {
  for (const args of [[], ['nope'], ['status', '--root', '/x', '--root', '/y'],
    ['status', '--root', 'relative'], ['status', 'positional']]) {
    assert.notEqual(cp.spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' }).status, 0);
  }
});
