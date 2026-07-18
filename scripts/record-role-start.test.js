'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const recorder = require('./record-role-start');
const roleState = require('./current-role-state');

test('role-start recorder publishes one immutable lifecycle event per invocation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-role-events-'));
  fs.chmodSync(root, 0o700);
  const generationRoot = path.join(root, 'generations');
  const bootId = '11111111-1111-4111-8111-111111111111';
  assert.throws(() => roleState.roleGeneration('node-red', bootId, generationRoot), /authority is unavailable/);
  assert.deepEqual(recorder.main(['node-red'], { bootId, generationRoot }), {
    ok: true, role: 'node-red', bootId,
  });
  assert.equal(roleState.roleGeneration('node-red', bootId, generationRoot), 1);
  recorder.main(['node-red'], { bootId, generationRoot });
  assert.equal(roleState.roleGeneration('node-red', bootId, generationRoot), 2);
});

test('role-start recorder accepts only one closed managed role argument', () => {
  assert.throws(() => recorder.main([]), /usage/);
  assert.throws(() => recorder.main(['node-red', 'extra']), /usage/);
  assert.throws(() => recorder.main(['unmanaged'], {
    bootId: '11111111-1111-4111-8111-111111111111',
    generationRoot: path.join(os.tmpdir(), 'unused-role-root'),
  }), /unknown managed role/);
});
