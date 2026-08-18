'use strict';
// Tests for the lstat/entry-type/symlink-target hashing change in verify-profile-parity.js
// (refactor-program A0 repair commit 3). Before this change, hashPath used fs.statSync,
// which follows symlinks: a symlink standing in for a canonical file with matching
// resolved content was indistinguishable from the real file, and a broken symlink
// silently looked "missing" instead of being compared. The fixed hashPath uses fs.lstatSync,
// encodes the entry type (file/dir/symlink) into the hash, and for a symlink hashes the
// raw target text without ever following it or allowing it to resolve outside the
// repository root.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const modPath = require.resolve('./verify-profile-parity.js');

function loadHashPath() {
  delete require.cache[modPath];
  const mod = require(modPath);
  assert.equal(typeof mod.hashPath, 'function', 'verify-profile-parity.js must export hashPath for testing');
  return mod.hashPath;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'profile-parity-'));
}

// spec: { 'rel/path': { type: 'file', content } | { type: 'dir' } | { type: 'symlink', target } }
function buildTree(root, spec) {
  for (const [rel, entry] of Object.entries(spec)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (entry.type === 'file') fs.writeFileSync(abs, entry.content);
    else if (entry.type === 'dir') fs.mkdirSync(abs, { recursive: true });
    else if (entry.type === 'symlink') fs.symlinkSync(entry.target, abs);
    else throw new Error('unknown fixture entry type: ' + entry.type);
  }
}

test('identical trees (including a matching in-tree symlink) hash equal', () => {
  const hashPath = loadHashPath();
  const root = tmpDir();
  buildTree(root, {
    'a/real.txt': { type: 'file', content: 'hello' },
    'a/link.txt': { type: 'symlink', target: 'real.txt' },
    'b/real.txt': { type: 'file', content: 'hello' },
    'b/link.txt': { type: 'symlink', target: 'real.txt' },
  });
  assert.equal(hashPath(path.join(root, 'a'), root), hashPath(path.join(root, 'b'), root));
});

test('link-to-file substitution: a symlink must not hash equal to a regular file with the same resolved content', () => {
  const hashPath = loadHashPath();
  const root = tmpDir();
  buildTree(root, {
    'a/real.txt': { type: 'file', content: 'hello' },
    'a/thing.txt': { type: 'file', content: 'hello' },
    'b/real.txt': { type: 'file', content: 'hello' },
    'b/thing.txt': { type: 'symlink', target: 'real.txt' },
  });
  assert.notEqual(hashPath(path.join(root, 'a'), root), hashPath(path.join(root, 'b'), root),
    'a symlink must not be indistinguishable from a regular file with the same resolved content');
});

test('alternate-target link: two symlinks pointing at different valid targets must not hash equal', () => {
  const hashPath = loadHashPath();
  const root = tmpDir();
  buildTree(root, {
    'a/one.txt': { type: 'file', content: 'one' },
    'a/two.txt': { type: 'file', content: 'two' },
    'a/link.txt': { type: 'symlink', target: 'one.txt' },
    'b/one.txt': { type: 'file', content: 'one' },
    'b/two.txt': { type: 'file', content: 'two' },
    'b/link.txt': { type: 'symlink', target: 'two.txt' },
  });
  assert.notEqual(hashPath(path.join(root, 'a'), root), hashPath(path.join(root, 'b'), root));
});

test('broken link: a symlink whose immediate target is absent is rejected without reading through it', () => {
  const hashPath = loadHashPath();
  const root = tmpDir();
  buildTree(root, {
    'a/link.txt': { type: 'symlink', target: 'missing.txt' },
  });
  assert.throws(() => hashPath(path.join(root, 'a', 'link.txt'), root), /target.*missing/i);
});

test('identical raw targets cannot hide a missing mirror target when the source target is valid', () => {
  const hashPath = loadHashPath();
  const root = tmpDir();
  buildTree(root, {
    'source/target.txt': { type: 'file', content: 'canonical' },
    'source/link.txt': { type: 'symlink', target: 'target.txt' },
    'mirror/link.txt': { type: 'symlink', target: 'target.txt' },
  });
  assert.doesNotThrow(() => hashPath(path.join(root, 'source', 'link.txt'), root));
  assert.throws(() => hashPath(path.join(root, 'mirror', 'link.txt'), root), /target.*missing/i);
});

test('escaping link: a relative symlink target that resolves outside the repository root is rejected', () => {
  const hashPath = loadHashPath();
  const root = tmpDir();
  buildTree(root, { 'a/link.txt': { type: 'symlink', target: '../../../../../../../etc/passwd' } });
  assert.throws(() => hashPath(path.join(root, 'a', 'link.txt'), root), /escape/i);
});

test('escaping link: an absolute-path symlink target is rejected', () => {
  const hashPath = loadHashPath();
  const root = tmpDir();
  buildTree(root, { 'a/link.txt': { type: 'symlink', target: '/etc/passwd' } });
  assert.throws(() => hashPath(path.join(root, 'a', 'link.txt'), root), /escape/i);
});

test('escaping link: a nested escape inside a directory tree is rejected even from a directory-level call', () => {
  const hashPath = loadHashPath();
  const root = tmpDir();
  buildTree(root, { 'a/sub/link.txt': { type: 'symlink', target: '../../../outside.txt' } });
  assert.throws(() => hashPath(path.join(root, 'a'), root), /escape/i);
});

test('escaping link: an intermediate symlink cannot redirect an in-root target path outside the trusted root', () => {
  const hashPath = loadHashPath();
  const root = tmpDir();
  const outside = tmpDir();
  buildTree(outside, { secret: { type: 'file', content: 'outside' } });
  buildTree(root, {
    jump: { type: 'symlink', target: outside },
    link: { type: 'symlink', target: 'jump/secret' },
  });
  assert.throws(() => hashPath(path.join(root, 'link'), root), /intermediate.*symlink/i);
});

test('final-target symlink: link -> jump is rejected when jump points outside the trusted root', () => {
  const hashPath = loadHashPath();
  const root = tmpDir();
  const outside = tmpDir();
  buildTree(root, {
    jump: { type: 'symlink', target: outside },
    link: { type: 'symlink', target: 'jump' },
  });
  assert.throws(() => hashPath(path.join(root, 'link'), root), /final.*target.*symlink/i);
});

test('final-target symlink: link -> jump is rejected when jump points to a missing target', () => {
  const hashPath = loadHashPath();
  const root = tmpDir();
  buildTree(root, {
    jump: { type: 'symlink', target: 'missing' },
    link: { type: 'symlink', target: 'jump' },
  });
  assert.throws(() => hashPath(path.join(root, 'link'), root), /final.*target.*symlink/i);
});

test('final-target symlink: a -> b and b -> a cycle is rejected without following either link', () => {
  const hashPath = loadHashPath();
  const root = tmpDir();
  buildTree(root, {
    a: { type: 'symlink', target: 'b' },
    b: { type: 'symlink', target: 'a' },
  });
  assert.throws(() => hashPath(path.join(root, 'a'), root), /final.*target.*symlink/i);
});

test('final-target special type is rejected when a FIFO can be constructed safely', (t) => {
  const hashPath = loadHashPath();
  const root = tmpDir();
  const fifo = path.join(root, 'special');
  const made = spawnSync('mkfifo', [fifo], { encoding: 'utf8' });
  if (made.error || made.status !== 0) {
    t.skip('mkfifo is unavailable in this environment');
    return;
  }
  fs.symlinkSync('special', path.join(root, 'link'));
  assert.throws(() => hashPath(path.join(root, 'link'), root), /unsupported.*final.*target/i);
});

test('ordinary final targets remain valid when they are an in-root regular file or directory', () => {
  const hashPath = loadHashPath();
  const root = tmpDir();
  buildTree(root, {
    'target-file': { type: 'file', content: 'inside' },
    'target-directory': { type: 'dir' },
    'file-link': { type: 'symlink', target: 'target-file' },
    'directory-link': { type: 'symlink', target: 'target-directory' },
  });
  assert.doesNotThrow(() => hashPath(path.join(root, 'file-link'), root));
  assert.doesNotThrow(() => hashPath(path.join(root, 'directory-link'), root));
});

test('an ordinary multi-component target stays valid when every in-root intermediate is a directory', () => {
  const hashPath = loadHashPath();
  const root = tmpDir();
  buildTree(root, {
    'safe/nested/secret': { type: 'file', content: 'inside' },
    link: { type: 'symlink', target: 'safe/nested/secret' },
  });
  assert.doesNotThrow(() => hashPath(path.join(root, 'link'), root));
});

test('a relative symlink target that stays within the repository root is accepted', () => {
  const hashPath = loadHashPath();
  const root = tmpDir();
  buildTree(root, {
    'a/real.txt': { type: 'file', content: 'hello' },
    'a/sub/link.txt': { type: 'symlink', target: '../real.txt' },
  });
  assert.doesNotThrow(() => hashPath(path.join(root, 'a'), root));
});

test('a missing path still returns null (pre-existing behavior preserved)', () => {
  const hashPath = loadHashPath();
  const root = tmpDir();
  assert.equal(hashPath(path.join(root, 'does-not-exist'), root), null);
});

test('regular files and directories still hash by content, unaffected by the lstat change', () => {
  const hashPath = loadHashPath();
  const root = tmpDir();
  buildTree(root, {
    'a/x.txt': { type: 'file', content: 'same' },
    'b/x.txt': { type: 'file', content: 'same' },
    'c/x.txt': { type: 'file', content: 'different' },
  });
  assert.equal(hashPath(path.join(root, 'a'), root), hashPath(path.join(root, 'b'), root));
  assert.notEqual(hashPath(path.join(root, 'a'), root), hashPath(path.join(root, 'c'), root));
});

test('requiring the module for its exports does not execute the CLI scan against the real repository', () => {
  // If require() ran the top-level CLI scan (as it did before the require.main guard was
  // added), a real-repo drift would call process.exit() and take this whole test run down.
  // Requiring it twice more here (on top of every test above) with the process still alive
  // is itself the proof.
  assert.equal(typeof loadHashPath(), 'function');
});
