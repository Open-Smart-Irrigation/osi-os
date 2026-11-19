'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const tool = path.join(__dirname, 'deploy-bundle-manifest.js');

test('manifest verifies exactly the regular files and refuses corruption, extras, missing files and links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-manifest-'));
  const run = mode => spawnSync(process.execPath, [tool, mode, root, 'fixture-commit'], { encoding: 'utf8' });
  try {
    fs.writeFileSync(path.join(root, 'deploy.sh'), 'fixture');
    assert.equal(run('create').status, 0);
    assert.equal(run('verify').status, 0);
    fs.writeFileSync(path.join(root, 'deploy.sh'), 'corrupt');
    assert.notEqual(run('verify').status, 0);
    fs.writeFileSync(path.join(root, 'deploy.sh'), 'fixture');
    fs.writeFileSync(path.join(root, 'extra'), 'extra');
    assert.notEqual(run('verify').status, 0);
    fs.unlinkSync(path.join(root, 'extra'));
    fs.unlinkSync(path.join(root, 'deploy.sh'));
    assert.notEqual(run('verify').status, 0);
    fs.symlinkSync(__filename, path.join(root, 'deploy.sh'));
    assert.notEqual(run('verify').status, 0);
    assert.notEqual(run('create').status, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
