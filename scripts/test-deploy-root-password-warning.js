'use strict';
// NEW-24: deploy.sh warns, in plain words, when root has no password (a stock
// base accepts root over SSH with no password at first boot). It is a
// warning, not a refusal; it writes nothing and never prints the password
// field. Fixture shadow files only; the entries are made up.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const DEPLOY = fs.readFileSync(path.join(__dirname, '..', 'deploy.sh'), 'utf8');
const fn = /^warn_root_password\(\) \{\n[\s\S]*?\n\}\n/m.exec(DEPLOY)[0];

function run(shadow) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-root-pw-'));
  try {
    const file = path.join(dir, 'shadow');
    fs.writeFileSync(file, shadow);
    const before = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const r = spawnSync('sh', ['-c', `set -eu\nSHADOW_FILE=${JSON.stringify(file)}\n${fn}\nwarn_root_password\necho after`], { encoding: 'utf8' });
    const after = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    assert.deepEqual(fs.readdirSync(dir), ['shadow'], 'nothing written beside it');
    assert.equal(after, before, 'the shadow file is unchanged');
    return r;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('root with an empty password field: a plain warning naming the README step, and the deploy carries on', () => {
  const r = run('root::0:0:99999:7:::\ndaemon:*:0:0:99999:7:::\n');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /after/);
  assert.match(r.stderr, /WARN: root has no password on this gateway: .*Set one now with 'passwd' \(README, Path B, Step 1\)\./);
});

test('root with a password: no warning, and the field is never printed', () => {
  const hash = '$1$madeupsa$aBcDeFgHiJkLmNoPqRsTu0';
  const r = run(`root:${hash}:20000:0:99999:7:::\n`);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.doesNotMatch(r.stdout + r.stderr, /madeupsa/);
});

test('a locked root or an unreadable shadow file: no warning, no failure', () => {
  assert.equal(run('root:!:20000:0:99999:7:::\n').stderr, '');
  const r = spawnSync('sh', ['-c', `set -eu\nSHADOW_FILE=/nonexistent/shadow\n${fn}\nwarn_root_password\necho after`], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
});
