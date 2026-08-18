'use strict';
// Mutation controls for the A0 repair-program size-ownership split (commit 3):
// scripts/verify-live-gateway-identity.js no longer owns any numeric flow-size ceiling
// (max_chars/max_total) - that belongs entirely to scripts/verify-flows-size-ratchet.js.
// The identity verifier still owns the identity-specific allowance *reason* text and the
// *membership* of each identity-grown node in the allowances file.
//
// verify-live-gateway-identity.js reads dozens of repository-relative paths (deploy.sh,
// openwrt config, feeds, both profiles' flows.json, ...), so testing a mutation against it
// needs a full, disposable copy of the repository tree rather than a hand-built fixture.
// A `git worktree` gives that cheaply (checkout-only, no full copy) and is torn down after
// each test.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const ALLOWANCES_REL = 'scripts/verify-flows-size-ratchet-allowances.json';
const FLOWS_RELS = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];

// `git stash create` builds a commit object snapshotting the current working tree
// (tracked modifications and the index) WITHOUT touching the stash list, HEAD, or the
// index - safe to call from a test. It falls back to HEAD when the tree is clean (e.g.
// this file is run again after the surrounding change has been committed).
function snapshotRef() {
  const out = execFileSync('git', ['-C', repoRoot, 'stash', 'create'], { encoding: 'utf8' }).trim();
  return out || 'HEAD';
}

function withWorktree(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-ownership-'));
  fs.rmSync(dir, { recursive: true, force: true });
  execFileSync('git', ['-C', repoRoot, 'worktree', 'add', '--quiet', '--detach', dir, snapshotRef()], { stdio: 'pipe' });
  try {
    return fn(dir);
  } finally {
    try {
      execFileSync('git', ['-C', repoRoot, 'worktree', 'remove', '--force', dir], { stdio: 'pipe' });
    } catch {
      fs.rmSync(dir, { recursive: true, force: true });
      try { execFileSync('git', ['-C', repoRoot, 'worktree', 'prune'], { stdio: 'pipe' }); } catch { /* best effort */ }
    }
  }
}

function readAllowances(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, ALLOWANCES_REL), 'utf8'));
}
function writeAllowances(dir, allowances) {
  fs.writeFileSync(path.join(dir, ALLOWANCES_REL), JSON.stringify(allowances, null, 2) + '\n');
}
function runIdentityVerifier(dir) {
  return spawnSync(process.execPath, [path.join(dir, 'scripts/verify-live-gateway-identity.js')], {
    cwd: dir, encoding: 'utf8',
  });
}
function runRatchet(dir) {
  return spawnSync(process.execPath, [path.join(dir, 'scripts/verify-flows-size-ratchet.js')], {
    cwd: dir, encoding: 'utf8',
  });
}

test('sanity: an unmutated worktree passes both the identity verifier and the general ratchet', () => {
  withWorktree((dir) => {
    const identity = runIdentityVerifier(dir);
    assert.equal(identity.status, 0, identity.stderr || identity.stdout);
    const ratchet = runRatchet(dir);
    assert.equal(ratchet.status, 0, ratchet.stderr || ratchet.stdout);
  });
});

test('mutation control: removing an identity-owned allowances entry fails verify-live-gateway-identity.js', () => {
  withWorktree((dir) => {
    const allowances = readAllowances(dir);
    assert.ok(allowances.node_allowances['sync-bootstrap-build'], 'fixture precondition: entry must exist before deletion');
    delete allowances.node_allowances['sync-bootstrap-build'];
    writeAllowances(dir, allowances);
    const r = runIdentityVerifier(dir);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /sync-bootstrap-build/);
    assert.match(r.stderr, /owned allowances entry/);
  });
});

test('mutation control: altering a merged identity reason (dropping its marker text) fails verify-live-gateway-identity.js', () => {
  withWorktree((dir) => {
    const allowances = readAllowances(dir);
    assert.match(allowances.node_allowances['sync-bootstrap-build'].reason, /live identity restart sentinel \(Option C Slice 1\)/,
      'fixture precondition: reason must carry the identity marker before mutation');
    allowances.node_allowances['sync-bootstrap-build'].reason = 'unrelated growth, no identity marker here';
    writeAllowances(dir, allowances);
    const r = runIdentityVerifier(dir);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /sync-bootstrap-build/);
  });
});

test('mutation control: altering the sys-stats-fn identity reason fails verify-live-gateway-identity.js', () => {
  withWorktree((dir) => {
    const allowances = readAllowances(dir);
    allowances.node_allowances['sys-stats-fn'].reason = 'unrelated growth, no identity marker here';
    writeAllowances(dir, allowances);
    const r = runIdentityVerifier(dir);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /sys-stats-fn/);
  });
});

test('mutation control: appending one byte to an identity-owned node without a ceiling update fails the general ratchet, not identity (ownership split)', () => {
  withWorktree((dir) => {
    for (const rel of FLOWS_RELS) {
      const flowsPath = path.join(dir, rel);
      const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
      const node = flows.find((n) => n && n.id === 'sync-bootstrap-build');
      assert.ok(node, `fixture precondition: sync-bootstrap-build must exist in ${rel}`);
      node.func += ' ';
      fs.writeFileSync(flowsPath, JSON.stringify(flows, null, 2) + '\n');
    }

    const ratchet = runRatchet(dir);
    assert.notEqual(ratchet.status, 0, ratchet.stdout);
    assert.match(ratchet.stderr, /sync-bootstrap-build/);
    assert.match(ratchet.stderr, /exceeding its committed ceiling/);

    // The identity verifier does not own sizes any more: it still passes because the
    // allowances entry and its identity reason are untouched by this mutation.
    const identity = runIdentityVerifier(dir);
    assert.equal(identity.status, 0, identity.stderr || identity.stdout);
  });
});

test('the identity verifier no longer asserts any specific numeric ceiling or the global max_total/reason', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'scripts/verify-live-gateway-identity.js'), 'utf8');
  assert.doesNotMatch(source, /sizeAllowances\s*\.\s*total_allowance/,
    'identity verifier must not read sizeAllowances.total_allowance any more (general ratchet owns it)');
  assert.doesNotMatch(source, /\.delta\s*===/,
    'identity verifier must not assert the retired delta field');
  assert.doesNotMatch(source, /max_total\s*:/,
    "identity verifier must not assert the general ratchet's max_total value");
});
