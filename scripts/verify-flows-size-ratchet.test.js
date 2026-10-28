'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const script = path.join(__dirname, 'verify-flows-size-ratchet.js');
const SURFACE = 'flows.json';
const SURFACE_ARGS = ['--surface', SURFACE];

function git(dir, args) { return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }); }
function writeFlows(dir, nodes) {
  fs.writeFileSync(path.join(dir, SURFACE), JSON.stringify(nodes, null, 2) + '\n');
}
const TODAY = '2026-10-29';
function writeExceptions(dir, exceptions) {
  fs.writeFileSync(path.join(dir, 'exceptions.json'), JSON.stringify({ exceptions }, null, 2) + '\n');
}
function initRepo(nodes, exceptions) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flows-size-ratchet-'));
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@e.com']);
  git(dir, ['config', 'user.name', 'T']);
  writeFlows(dir, nodes);
  if (exceptions) writeExceptions(dir, exceptions);
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}
function run(dir, extra = []) {
  return spawnSync(process.execPath, [
    script, '--root', dir, '--git-root', dir, '--base-ref', 'HEAD',
    '--baseline', path.join(dir, 'baseline.json'),
    '--exceptions', 'exceptions.json', '--today', TODAY,
    ...SURFACE_ARGS, ...extra,
  ], { cwd: dir, encoding: 'utf8' });
}
function writeBaseline(dir) {
  execFileSync(process.execPath, [
    script, '--root', dir, '--git-root', dir, '--base-ref', 'HEAD',
    '--baseline', path.join(dir, 'baseline.json'), ...SURFACE_ARGS, '--write-baseline',
  ], { cwd: dir });
}
const fn = (id, func, extra = {}) => ({ id, type: 'function', name: id, func, ...extra });
const BASE = [fn('keep', 'return msg;'), fn('shrinkme', 'x'.repeat(200))];

test('PASS when HEAD == base', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /verify-flows-size-ratchet: OK/);
});

test('PASS when an existing node shrinks and the total drops (no baseline regen needed)', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  writeFlows(dir, [fn('keep', 'return msg;'), fn('shrinkme', 'x'.repeat(50))]);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /below committed baseline/);
});

test('FAIL when an existing node grows', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  writeFlows(dir, [fn('keep', 'return msg;'), fn('shrinkme', 'x'.repeat(400))]);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /node shrinkme grew/);
});

test('FAIL when the per-profile total increases', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  writeFlows(dir, [...BASE, fn('newsmall', 'return 1;')]);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /total embedded JS increased/);
});

test('FAIL when a NEW node exceeds the 1536 ceiling', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  writeFlows(dir, [fn('keep', 'return msg;'), fn('shrinkme', 'y'.repeat(1)), fn('toobig', 'z'.repeat(5000))]);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /new node toobig exceeds/);
});

test('FAIL when a NEW node over 400 chars does not load via osiLib (thin-node rule)', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  writeFlows(dir, [fn('keep', 'return msg;'), fn('shrinkme', 'y'.repeat(1)), fn('logic', 'x'.repeat(401))]);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /new node logic - new node over 400 chars must load its logic through osiLib.require/);
});

test('PASS when a NEW wiring node loads via osiLib.require and stays under the ceiling', () => {
  const dir = initRepo([fn('keep', 'return msg;'), fn('shrinkme', 'x'.repeat(2000))]); writeBaseline(dir);
  writeFlows(dir, [fn('keep', 'return msg;'), fn('shrinkme', 'y'.repeat(1)),
    fn('adapter', "const h=osiLib.require('x');\n" + 'k'.repeat(1000), { libs: [{ var: 'osiLib', module: 'osi-lib' }] })]);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('FAIL when a NEW node loads via osiLib.require but exceeds the ceiling', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  writeFlows(dir, [fn('keep', 'return msg;'), fn('shrinkme', 'y'.repeat(1)),
    fn('adapter', "const h=osiLib.require('x');\n" + 'k'.repeat(4097),
      { libs: [{ var: 'osiLib', module: 'osi-lib' }] })]);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /new node adapter exceeds the 1536-char ceiling/);
  assert.doesNotMatch(r.stderr, /oversized SQL literal/);
});

test('PASS when the exceptions file is absent and a small NEW node is offset by a shrink', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  // shrinkme shrinks enough to offset the tiny new node, so the total-chars gate
  // also passes; this isolates the new-node code path from the allowances file
  // that never gets written in this test.
  writeFlows(dir, [fn('keep', 'return msg;'), fn('shrinkme', 'y'.repeat(1)), fn('smallnew', 'return 1;')]);
  const r = spawnSync(process.execPath, [
    script, '--root', dir, '--git-root', dir, '--base-ref', 'HEAD',
    '--baseline', path.join(dir, 'baseline.json'),
    '--exceptions', 'nonexistent.json', '--today', TODAY,
    ...SURFACE_ARGS,
  ], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('fails closed when --base-ref is unreachable', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  const r = spawnSync(process.execPath, [
    script, '--root', dir, '--git-root', dir,
    '--base-ref', 'refs/remotes/origin/does-not-exist',
    '--baseline', path.join(dir, 'baseline.json'), ...SURFACE_ARGS,
  ], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /failing closed/);
});

test('gate 2: FAILS when HEAD total EXCEEDS the committed baseline (unrecorded growth)', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  const bp = path.join(dir, 'baseline.json');
  const doctored = JSON.parse(fs.readFileSync(bp, 'utf8'));
  doctored.files[SURFACE].total = 1;
  fs.writeFileSync(bp, JSON.stringify(doctored, null, 2) + '\n');
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /exceeds committed baseline/);
});

test('missing exceptions file is treated as zero exceptions', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  writeFlows(dir, [fn('keep', 'return msg;'), fn('shrinkme', 'x'.repeat(400))]);
  const r = spawnSync(process.execPath, [
    script, '--root', dir, '--git-root', dir, '--base-ref', 'HEAD',
    '--baseline', path.join(dir, 'baseline.json'),
    '--exceptions', 'nonexistent.json', '--today', TODAY,
    ...SURFACE_ARGS,
  ], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /node shrinkme grew/);
});

// Fix exceptions. BASE totals 211 chars (11 + 200).
const fixEntry = (over = {}) => ({
  id: 'fix-1-shrinkme', kind: 'fix', issue: 1, granted: TODAY, reason: 'test bug',
  nodes: { shrinkme: 300 }, total_max: 311, payback_total: 211, ...over,
});
const GROWN = [fn('keep', 'return msg;'), fn('shrinkme', 'x'.repeat(300))];

test('exception: an entry at the base ref lets a fix grow a node up to its ceiling', () => {
  const dir = initRepo(BASE, [fixEntry()]); writeBaseline(dir);
  writeFlows(dir, GROWN);
  const r = run(dir, ['--baseline', path.join(dir, 'baseline.json')]);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /fix exception fix-1-shrinkme is active until 2026-11-12/);
});

test('exception: growth past the ceiling still fails', () => {
  const dir = initRepo(BASE, [fixEntry()]); writeBaseline(dir);
  writeFlows(dir, [fn('keep', 'return msg;'), fn('shrinkme', 'x'.repeat(301))]);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /node shrinkme grew \(301 > 200 at base; fix exception ceiling 300\)/);
});

test('exception: an entry only in the working tree grants nothing and the failure prints the entry to land first', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  writeFlows(dir, GROWN);
  writeExceptions(dir, [fixEntry()]);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /node shrinkme grew \(300 > 200 at base\)/);
  assert.match(r.stderr, /in a separate PR first/);
  assert.match(r.stderr, /"shrinkme": 300/);
  assert.match(r.stderr, /"payback_total": 211/);
});

test('exception: a well-formed new entry in the working tree passes validation', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  writeExceptions(dir, [fixEntry()]);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('exception: kind other than fix is rejected', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  writeExceptions(dir, [fixEntry({ kind: 'feature' })]);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /kind must be "fix"/);
});

test('exception: missing issue, reason or payback_total above total_max is rejected', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  writeExceptions(dir, [fixEntry({ issue: 0, reason: ' ', payback_total: 400 })]);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /issue must be/);
  assert.match(r.stderr, /reason must be non-empty/);
  assert.match(r.stderr, /payback_total must not exceed total_max/);
});

test('exception: a granted date in the future is rejected', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  writeExceptions(dir, [fixEntry({ granted: '2026-11-30' })]);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /granted in the future/);
});

test('exception: an entry edited after it merged is rejected', () => {
  const dir = initRepo(BASE, [fixEntry()]); writeBaseline(dir);
  writeExceptions(dir, [fixEntry({ total_max: 5000 })]);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /changed after it was granted/);
});

test('exception: after 14 days an entry grants nothing', () => {
  const dir = initRepo(BASE, [fixEntry({ granted: '2026-10-14' })]); writeBaseline(dir);
  writeFlows(dir, GROWN);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /node shrinkme grew \(300 > 200 at base\)/);
});

test('exception: an overdue entry fails every run until paid back, even if the PR deletes it', () => {
  const dir = initRepo(GROWN, [fixEntry({ granted: '2026-10-14' })]); writeBaseline(dir);
  writeExceptions(dir, []);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /fix exception fix-1-shrinkme \(issue #1, granted 2026-10-14\) is overdue: total 311 must be back at or below 211 \(extract 100 chars/);
});

test('exception: paying back clears the overdue entry and asks for its deletion', () => {
  const dir = initRepo(GROWN, [fixEntry({ granted: '2026-10-14' })]); writeBaseline(dir);
  writeFlows(dir, [fn('keep', 'return msg;'), fn('shrinkme', 'x'.repeat(150))]);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /is paid back \(total 161 <= 211\); delete the entry/);
});

test('exception: a node listed in an active entry may be added above the new-node rules', () => {
  const dir = initRepo(BASE, [fixEntry({ nodes: { hotfix: 2000 }, total_max: 2300 })]); writeBaseline(dir);
  writeFlows(dir, [...BASE, fn('hotfix', 'h'.repeat(2000))]);
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr || r.stdout);
});

test('exception: an invalid exceptions file at the base ref fails closed', () => {
  const dir = initRepo(BASE); writeBaseline(dir);
  fs.writeFileSync(path.join(dir, 'exceptions.json'), '{"exceptions": [{"id": "x"}]}');
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'bad exceptions']);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /exceptions\.json at HEAD: exception x: kind must be "fix"/);
});

test('accepts the committed shipped baseline against origin/main', () => {
  assert.equal(fs.existsSync(path.join(repoRoot, 'scripts/verify-flows-size-ratchet-baseline.json')), true,
    'baseline must be committed');
  const r = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /verify-flows-size-ratchet: OK/);
});
