#!/usr/bin/env node
'use strict';
// Build a one-parent local squash, then test through a transport clone whose
// object store contains only that squash and its main ancestry.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'x3-squash-'));
const env = { ...process.env, TZ: 'UTC', X3_EVIDENCE: '', NODE_OPTIONS: '', X3_REPO_ROOT: '', X3_RENDER_ROOT: '' };
for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_COMMON_DIR', 'GIT_SHALLOW_FILE']) delete env[key];
function run(command, args, cwd = root, inherit = false) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    env,
    stdio: inherit ? 'inherit' : 'pipe',
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, command + ' ' + args.join(' ') + '\n' + (result.stdout || '') + (result.stderr || ''));
  return (result.stdout || '').trim();
}
try {
  run('git', ['diff', '--quiet', 'HEAD']);
  const head = run('git', ['rev-parse', 'HEAD']);
  const common = run('git', ['merge-base', 'HEAD', 'origin/main']);
  // Push builds on main have no PR branch point above main. In that case the
  // source commit's parent is the ancestry base for the same replacement test.
  const base = common === head ? run('git', ['rev-parse', 'HEAD^']) : common;
  run('git', ['merge-base', '--is-ancestor', base, 'origin/main']);
  const forbidden = run('git', ['rev-list', base + '..HEAD']).split('\n').filter(Boolean);
  assert.ok(forbidden.length, 'squash proof needs a source commit above its ancestry base');
  const tree = run('git', ['rev-parse', 'HEAD^{tree}']);
  const squash = run('git', ['-c', 'user.name=X3 Squash Proof', '-c', 'user.email=x3-proof@example.test',
    'commit-tree', tree, '-p', base, '-m', 'Local X3 squash equivalence proof']);
  const source = path.join(scratch, 'source.git');
  const clone = path.join(scratch, 'clone');
  run('git', ['init', '--bare', '--initial-branch=main', source]);
  run('git', ['fetch', '--no-tags', root, base + ':refs/heads/main'], source);
  run('git', ['push', source, squash + ':refs/heads/squash']);
  run('git', ['clone', '--no-local', '--no-hardlinks', '--single-branch', '--branch', 'squash', source, clone]);
  run('git', ['fetch', '--no-tags', 'origin', 'main:refs/remotes/origin/main'], clone);
  assert.equal(run('git', ['rev-parse', 'HEAD^{tree}'], clone), tree);
  assert.equal(run('git', ['rev-parse', 'HEAD^'], clone), base);
  assert.ok(!fs.existsSync(path.join(clone, '.git/objects/info/alternates')), 'no shared object store');
  const refs = run('git', ['for-each-ref', '--format=%(refname)'], clone).split('\n');
  assert.ok(refs.every(ref => ['refs/heads/squash', 'refs/remotes/origin/squash', 'refs/remotes/origin/main'].includes(ref)), 'no PR refs: ' + refs);
  for (const commit of forbidden) {
    const missing = spawnSync('git', ['cat-file', '-e', commit + '^{commit}'], { cwd: clone, encoding: 'utf8', env });
    if (missing.error) throw missing.error;
    assert.notEqual(missing.status, 0, 'PR-only commit object leaked into fresh clone: ' + commit);
  }
  console.log(`X3 fresh clone: source=${head}, main-ancestry base=${base}, squash=${squash}; ${forbidden.length} PR-only commits absent; refs=${refs.join(',')}`);
  run(process.execPath, ['scripts/test-x3-zone-env-parity.js', '--verify'], clone, true);
  run(process.execPath, ['scripts/test-x3-zone-env-additive.js'], clone, true);
  run(process.execPath, ['scripts/verify-x3-zone-env-handoff.js', '--affected'], clone, true);
  console.log('X3 squash proof: PASS (fresh clone, identical committed tree, no PR refs or PR-only objects; parity and staged affected handoff pass)');
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
