#!/usr/bin/env node
'use strict';
// Apply the actual handoff in a disposable committed checkout. Never edit the
// worktree that is waiting for the flows reservation (X1/X2 staging pattern).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { HANDOFF_FILES, FLOW_PATHS, BASELINES, handoffState } = require('./x3-zone-env-adapters');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'x3-integration-'));
const clone = path.join(scratch, 'repo');
const original = new Map(HANDOFF_FILES.map(relative => [relative, fs.readFileSync(path.join(root, relative), 'utf8')]));
const env = { ...process.env, NODE_OPTIONS: '', X3_REPO_ROOT: '', X3_RENDER_ROOT: '', X3_EVIDENCE: '', TZ: 'UTC' };
function command(executable, args, cwd = clone, inherit = false, extraEnv = {}) {
  const result = spawnSync(executable, args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024, stdio: inherit ? 'inherit' : 'pipe' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, executable + ' ' + args.join(' ') + '\n' + (result.stdout || '') + (result.stderr || ''));
  return result.stdout || '';
}
function node(args, extraEnv) { return command(process.execPath, args, clone, true, extraEnv); }
function rejected(label) {
  const result = spawnSync(process.execPath, ['scripts/verify-x3-zone-env-handoff.js', '--check-only'], { cwd: clone, env, encoding: 'utf8' });
  assert.equal(result.status, 1, label + ' must fail');
  assert.match(result.stderr, /partial|stale|unreviewed|differs from renderer/, label);
}
try {
  const state = handoffState();
  command('git', ['clone', '--shared', '--no-checkout', '--single-branch', '--no-tags', '--quiet', root, clone], root);
  command('git', ['checkout', '--detach', '--quiet', 'HEAD']);
  // Local qualification includes working changes; CI uses its exact committed head.
  const paths = command('git', ['ls-files', '-co', '--exclude-standard', '-z'], root).split('\0').filter(Boolean);
  for (const relative of paths) {
    const from = path.join(root, relative), to = path.join(clone, relative);
    if (!fs.existsSync(from)) { fs.rmSync(to, { recursive: true, force: true }); continue; }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) { fs.rmSync(to, { force: true }); fs.symlinkSync(fs.readlinkSync(from), to); }
    else if (stat.isFile()) fs.copyFileSync(from, to);
  }
  command('git', ['update-ref', 'refs/remotes/origin/main', command('git', ['rev-parse', 'origin/main'], root).trim()]);
  const patch = 'scripts/fixtures/x3-zone-env/adapter-handoff.patch';
  if (state === 'legacy') {
    const submitted = fs.readFileSync(path.join(clone, patch), 'utf8');
    fs.writeFileSync(path.join(clone, patch), submitted + '\n'); rejected('stale patch');
    fs.writeFileSync(path.join(clone, patch), submitted);
    command('git', ['apply', '--check', patch]);
    command('git', ['apply', patch]);
  }
  const applied = new Map(HANDOFF_FILES.map(relative => [relative, fs.readFileSync(path.join(clone, relative), 'utf8')]));
  const { renderHandoff } = require(path.join(clone, 'scripts/x3-zone-env-adapters'));
  const rendered = renderHandoff(path.join(scratch, 'idempotence'));
  for (const [relative, text] of applied) assert.equal(fs.readFileSync(path.join(rendered, relative), 'utf8'), text, 'integrated renderer must be idempotent: ' + relative);
  // Partial-state controls must also run when this test starts on main with
  // the handoff already installed, without depending on legacy checkout bytes.
  const frozen = require('./fixtures/x3-zone-env/legacy-nodes.json');
  const relative = FLOW_PATHS[0];
  const nodes = JSON.parse(applied.get(relative));
  fs.writeFileSync(path.join(clone, relative), JSON.stringify(nodes.map(n => frozen.find(old => old.id === n.id) || n), null, 2) + '\n');
  rejected('half-profile partial swap');
  fs.writeFileSync(path.join(clone, relative), applied.get(relative));
  nodes[nodes.findIndex(n => n.id === frozen[0].id)] = frozen[0];
  fs.writeFileSync(path.join(clone, relative), JSON.stringify(nodes, null, 2) + '\n');
  rejected('single-node partial swap');
  fs.writeFileSync(path.join(clone, relative), applied.get(relative));
  for (const relative of BASELINES) {
    const stale = JSON.parse(applied.get(relative));
    if (relative === BASELINES[0]) Object.values(stale.profiles)[0].silentCatchCount++;
    else { stale.files[FLOW_PATHS[0]].total++; stale.total++; }
    fs.writeFileSync(path.join(clone, relative), JSON.stringify(stale, null, 2) + '\n');
    rejected('stale baseline partial swap ' + relative);
    fs.writeFileSync(path.join(clone, relative), applied.get(relative));
  }
  // The installed CI dependencies are reusable; no fixture/runtime source comes
  // from a PR ref. The separate squash leg uses an independent object store.
  for (const relative of ['node_modules', 'scripts/node_modules']) if (fs.existsSync(path.join(root, relative))) {
    fs.mkdirSync(path.dirname(path.join(clone, relative)), { recursive: true });
    fs.symlinkSync(path.join(root, relative), path.join(clone, relative), 'dir');
  }
  command('git', ['add', '-A']);
  command('git', ['-c', 'user.name=X3 Integration Proof', '-c', 'user.email=x3-proof@example.test', 'commit', '--allow-empty', '-m', 'Local applied X3 handoff candidate']);
  console.log('X3 applied candidate: committed adapters and recounts; partial controls rejected; legacy patch freshness checked when applicable');
  if (process.argv.includes('--runtime-only')) {
    node(['scripts/verify-x3-zone-env-handoff.js', '--runtime-only']);
  } else {
    node(['scripts/verify-x3-zone-env-handoff.js', ...(process.argv.includes('--full') ? [] : ['--affected'])]);
    node(['scripts/test-x3-zone-env-parity.js', '--verify'], { TZ: 'Europe/Zurich' });
    node(['scripts/test-x3-zone-env-additive.js'], { TZ: 'Europe/Zurich' });
    node(['scripts/test-x3-zone-env-squash.js']);
  }
  console.log('X3 integration: PASS (actual patch applied; post-swap gates and partial-swap controls; reservation worktree unchanged)');
} finally {
  for (const [relative, text] of original) assert.equal(fs.readFileSync(path.join(root, relative), 'utf8'), text, 'reservation worktree changed: ' + relative);
  fs.rmSync(scratch, { recursive: true, force: true });
}
