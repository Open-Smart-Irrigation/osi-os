'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { revisionOf, check } = require('./verify-bootstrap-revision');

const COPIES = [
  'scripts/chirpstack-bootstrap.js',
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/chirpstack-bootstrap.js',
];

function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function repo(t, source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-revision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.invalid');
  git(root, 'config', 'user.name', 'test');
  write(root, source);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'tag', 'base');
  return root;
}

function write(root, source, copies = COPIES) {
  for (const rel of copies) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), source);
  }
}

const v = (n, body = '') => `'use strict';\nconst OSI_BOOTSTRAP_REVISION = ${n};\n${body}`;

test('revisionOf reads the line the init script reads, 0 without it, null when malformed', () => {
  assert.equal(revisionOf(v(7)), 7);
  assert.equal(revisionOf("'use strict';\n"), 0);
  assert.equal(revisionOf("const OSI_BOOTSTRAP_REVISION = '7';\n"), null);
  assert.equal(revisionOf(v(1) + v(2)), null);
});

// The range the shell can compare, shared with osi-bootstrap and deploy.sh.
test('revisionOf accepts 1 to 999999, digits only, no leading zero', () => {
  assert.equal(revisionOf(v(1)), 1);
  assert.equal(revisionOf(v(999999)), 999999);
  for (const bad of ['0', '1000000', '999999999999999999999999999999', '0002', '-1', '1e3', '1.5', ' 7']) {
    assert.equal(revisionOf(`const OSI_BOOTSTRAP_REVISION = ${bad};\n`), null, bad);
  }
  assert.equal(revisionOf('const OSI_BOOTSTRAP_REVISION = 2; // newer\n'), null, 'a trailing comment');
});

test('an oversized revision fails the check, also when it is higher than the base', (t) => {
  const root = repo(t, v(3, 'a();\n'));
  write(root, v('999999999999999999999999999999', 'b();\n'));
  assert.match(check({ root, baseRef: 'base' }).join('\n'), /from 1 to 999999, digits only, no leading zero/);
  write(root, v(999999, 'b();\n'));
  assert.deepEqual(check({ root, baseRef: 'base' }), []);
  write(root, v(1000000, 'c();\n'));
  assert.match(check({ root, baseRef: 'base' }).join('\n'), /from 1 to 999999/);
});

test('a change to the script without a higher revision fails; with one it passes', (t) => {
  const root = repo(t, v(3, 'a();\n'));
  assert.deepEqual(check({ root, baseRef: 'base' }), []);
  write(root, v(3, 'b();\n'));
  assert.match(check({ root, baseRef: 'base' }).join('\n'), /changed since base but OSI_BOOTSTRAP_REVISION stayed at 3/);
  write(root, v(4, 'b();\n'));
  assert.deepEqual(check({ root, baseRef: 'base' }), []);
});

test('the first revision passes against a base without the line, and the line cannot be dropped', (t) => {
  const root = repo(t, "'use strict';\na();\n");
  write(root, v(1, 'a();\n'));
  assert.deepEqual(check({ root, baseRef: 'base' }), []);
  write(root, "'use strict';\nb();\n");
  assert.match(check({ root, baseRef: 'base' }).join('\n'), /OSI_BOOTSTRAP_REVISION is missing/);
});

test('an image copy that differs from scripts/ fails, and an unreadable base ref fails closed', (t) => {
  const root = repo(t, v(1));
  write(root, v(2), [COPIES[0], COPIES[1]]);
  assert.match(check({ root, baseRef: 'base' }).join('\n'), /bcm2709.*differs from scripts\/chirpstack-bootstrap.js/);
  assert.match(check({ root, baseRef: 'no-such-ref' }).join('\n'), /base ref unusable, failing closed/);
});

test('the repository script carries a revision the init script can read', () => {
  const source = fs.readFileSync(path.join(__dirname, 'chirpstack-bootstrap.js'), 'utf8');
  assert.ok(revisionOf(source) >= 1);
});
