const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const CLI = path.join(__dirname, 'verify-merge-allowance-preservation.js');
const ALLOWANCE_PATH = 'scripts/verify-flows-size-ratchet-allowances.json';
const SECTIONS = ['node_allowances', 'new_node_ceilings', 'total_allowance'];

function allowance({ nodes = {}, ceilings = {}, totalDelta = 10, comment = 'fixture' } = {}) {
  return {
    _comment: comment,
    node_allowances: nodes,
    new_node_ceilings: ceilings,
    total_allowance: {
      provenance: `fixture total provenance ${totalDelta}`,
      delta: totalDelta,
      reason: `measured total ${totalDelta}`,
    },
  };
}

function git(repo, args, { expect = 0 } = {}) {
  const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
  assert.equal(result.status, expect, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function writeAllowance(repo, value) {
  const file = path.join(repo, ALLOWANCE_PATH);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, text);
  return Buffer.from(text);
}

function withRepo(t, { left, right, result }) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-allowance-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.name', 'Allowance Test']);
  git(repo, ['config', 'user.email', 'allowance-test@example.invalid']);
  writeAllowance(repo, allowance());
  git(repo, ['add', ALLOWANCE_PATH]);
  git(repo, ['commit', '-qm', 'base']);
  const base = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['branch', 'left', base]);
  git(repo, ['branch', 'right', base]);

  git(repo, ['checkout', '-q', 'left']);
  writeAllowance(repo, typeof left === 'string' ? left : { ...left, _comment: 'left parent fixture' });
  git(repo, ['add', ALLOWANCE_PATH]);
  git(repo, ['commit', '-qm', 'left']);
  const leftSha = git(repo, ['rev-parse', 'HEAD']);

  git(repo, ['checkout', '-q', 'right']);
  writeAllowance(repo, typeof right === 'string' ? right : { ...right, _comment: 'right parent fixture' });
  git(repo, ['add', ALLOWANCE_PATH]);
  git(repo, ['commit', '-qm', 'right']);
  const rightSha = git(repo, ['rev-parse', 'HEAD']);

  git(repo, ['checkout', '-q', 'left']);
  writeAllowance(repo, typeof result === 'string' ? result : { ...result, _comment: 'result fixture' });
  git(repo, ['add', ALLOWANCE_PATH]);
  const tree = git(repo, ['write-tree']);
  const mergeSha = git(repo, ['commit-tree', tree, '-p', leftSha, '-p', rightSha, '-m', 'synthetic completed merge']);
  git(repo, ['reset', '--hard', '-q', mergeSha]);
  return { repo, leftSha, rightSha, mergeSha, resultBytes: fs.readFileSync(path.join(repo, ALLOWANCE_PATH)) };
}

function invoke(fixture, extra = []) {
  const args = [
    CLI,
    '--repo', fixture.repo,
    '--left-ref', fixture.leftSha,
    '--right-ref', fixture.rightSha,
    ...extra,
  ];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { ...result, output: `${result.stdout || ''}${result.stderr || ''}`, args };
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function receipt(fixture, decisions) {
  return {
    left: fixture.leftSha,
    right: fixture.rightSha,
    resultSha256: sha256(fixture.resultBytes),
    decisions,
  };
}

function writeReceipt(fixture, value) {
  const file = path.join(fixture.repo, 'receipt.json');
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

function decision(parent, section, key, reason = 'Measured both maintained profiles; the prior allowance is no longer needed.') {
  return { parent, section, key, reason };
}

test('retains additions made on either parent', (t) => {
  const left = allowance({ nodes: { left_only: { delta: 3, reason: 'left reason' } } });
  const right = allowance({ ceilings: { right_only: { max_chars: 120, reason: 'right reason' } } });
  const fixture = withRepo(t, { left, right, result: allowance({
    nodes: left.node_allowances,
    ceilings: right.new_node_ceilings,
  }) });
  const run = invoke(fixture);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /verify-merge-allowance-preservation: OK/);
});

test('rejects an accidentally lost right-parent entry', (t) => {
  const left = allowance();
  const right = allowance({ nodes: { right_only: { delta: 7, reason: 'right reason' } } });
  const fixture = withRepo(t, { left, right, result: allowance() });
  const run = invoke(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.output, /right node_allowances right_only/);
});

test('rejects a lost right-parent total_allowance change', (t) => {
  const left = allowance({ totalDelta: 10 });
  const right = allowance({ totalDelta: 25 });
  const fixture = withRepo(t, { left, right, result: left });
  const run = invoke(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.output, /unmatched right total_allowance total_allowance/);
  assert.match(run.output, /"delta":25/);
  assert.match(run.output, /result=.*"delta":10/);
});

test('requires exact measured dispositions for deletion and reduction', (t) => {
  const parent = allowance({
    nodes: { obsolete: { delta: 8, reason: 'old measured exemption' } },
    ceilings: { bounded: { max_chars: 200, reason: 'old measured ceiling' } },
  });
  const reduced = allowance({
    ceilings: { bounded: { max_chars: 150, reason: 're-measured ceiling' } },
  });
  const fixture = withRepo(t, { left: parent, right: parent, result: reduced });
  const missing = invoke(fixture);
  assert.notEqual(missing.status, 0);
  assert.match(missing.output, /left node_allowances obsolete/);
  assert.match(missing.output, /right new_node_ceilings bounded/);

  const decisions = [
    decision('left', 'node_allowances', 'obsolete'),
    decision('right', 'node_allowances', 'obsolete'),
    decision('left', 'new_node_ceilings', 'bounded'),
    decision('right', 'new_node_ceilings', 'bounded'),
  ];
  const receiptPath = writeReceipt(fixture, receipt(fixture, decisions));
  const accepted = invoke(fixture, ['--dispositions', receiptPath]);
  assert.equal(accepted.status, 0, accepted.output);
  assert.match(accepted.output, /accepted left node_allowances obsolete/);
  assert.match(accepted.output, /accepted right new_node_ceilings bounded/);
});

test('rejects same-key parent collisions unless the changed parent entry is decided', (t) => {
  const left = allowance({ nodes: { shared: { delta: 4, reason: 'left reason' } } });
  const right = allowance({ nodes: { shared: { delta: 9, reason: 'right reason' } } });
  const fixture = withRepo(t, { left, right, result: left });
  const run = invoke(fixture);
  assert.notEqual(run.status, 0);
  assert.match(run.output, /right node_allowances shared/);
});

test('rejects invalid refs, invalid JSON, and missing allowance sections', (t) => {
  const base = allowance();
  const fixture = withRepo(t, { left: base, right: base, result: base });
  const invalidRef = spawnSync(process.execPath, [CLI, '--repo', fixture.repo, '--left-ref', '--bad', '--right-ref', fixture.rightSha], { encoding: 'utf8' });
  assert.notEqual(invalidRef.status, 0);
  assert.match(`${invalidRef.stdout}${invalidRef.stderr}`, /left ref|invalid ref|resolve/i);

  const invalidParent = withRepo(t, { left: '{bad json', right: base, result: base });
  const parentRun = invoke(invalidParent);
  assert.notEqual(parentRun.status, 0);
  assert.match(parentRun.output, /invalid JSON|parse/i);

  const missingSection = withRepo(t, { left: base, right: base, result: { _comment: 'missing' } });
  const resultRun = invoke(missingSection);
  assert.notEqual(resultRun.status, 0);
  assert.match(resultRun.output, /node_allowances|missing section/i);
});

test('binds receipts to both parent SHAs and the raw result-file digest', (t) => {
  const parent = allowance({ nodes: { obsolete: { delta: 8, reason: 'old' } } });
  const fixture = withRepo(t, { left: parent, right: parent, result: allowance() });
  const decisions = [decision('left', 'node_allowances', 'obsolete'), decision('right', 'node_allowances', 'obsolete')];

  const wrongParent = receipt(fixture, decisions);
  wrongParent.left = '0'.repeat(40);
  const parentPath = writeReceipt(fixture, wrongParent);
  const parentRun = invoke(fixture, ['--dispositions', parentPath]);
  assert.notEqual(parentRun.status, 0);
  assert.match(parentRun.output, /left.*(SHA|sha|match|bind)/i);

  const wrongDigest = receipt(fixture, decisions);
  wrongDigest.resultSha256 = '0'.repeat(64);
  const digestPath = writeReceipt(fixture, wrongDigest);
  const digestRun = invoke(fixture, ['--dispositions', digestPath]);
  assert.notEqual(digestRun.status, 0);
  assert.match(digestRun.output, /resultSha256|digest|hash/i);
});

test('rejects a disposition receipt bound to the wrong right-parent SHA', (t) => {
  const parent = allowance({ nodes: { obsolete: { delta: 8, reason: 'old' } } });
  const fixture = withRepo(t, { left: parent, right: parent, result: allowance() });
  const decisions = [
    decision('left', 'node_allowances', 'obsolete'),
    decision('right', 'node_allowances', 'obsolete'),
  ];
  const wrongRight = receipt(fixture, decisions);
  wrongRight.right = '0'.repeat(40);
  const run = invoke(fixture, ['--dispositions', writeReceipt(fixture, wrongRight)]);
  assert.notEqual(run.status, 0);
  assert.match(run.output, /dispositions right SHA does not match/);
});

test('rejects a disposition with a blank decision reason', (t) => {
  const parent = allowance({ nodes: { obsolete: { delta: 8, reason: 'old' } } });
  const fixture = withRepo(t, { left: parent, right: parent, result: allowance() });
  const decisions = [
    decision('left', 'node_allowances', 'obsolete', '   '),
    decision('right', 'node_allowances', 'obsolete'),
  ];
  const run = invoke(fixture, ['--dispositions', writeReceipt(fixture, receipt(fixture, decisions))]);
  assert.notEqual(run.status, 0);
  assert.match(run.output, /decision 1 needs a nonempty reason/);
});

test('rejects duplicate, stale, extra, and malformed disposition decisions', (t) => {
  const parent = allowance({ nodes: { obsolete: { delta: 8, reason: 'old' } } });
  const fixture = withRepo(t, { left: parent, right: parent, result: allowance() });
  const valid = [decision('left', 'node_allowances', 'obsolete'), decision('right', 'node_allowances', 'obsolete')];

  const duplicate = receipt(fixture, [...valid, valid[0]]);
  const duplicateRun = invoke(fixture, ['--dispositions', writeReceipt(fixture, duplicate)]);
  assert.notEqual(duplicateRun.status, 0);
  assert.match(duplicateRun.output, /duplicate/i);

  const extra = receipt(fixture, [...valid, decision('left', 'new_node_ceilings', 'never_present')]);
  const extraRun = invoke(fixture, ['--dispositions', writeReceipt(fixture, extra)]);
  assert.notEqual(extraRun.status, 0);
  assert.match(extraRun.output, /extra|stale|unmatched/i);

  const stale = receipt(fixture, [decision('left', 'node_allowances', 'obsolete')]);
  const staleRun = invoke(fixture, ['--dispositions', writeReceipt(fixture, stale)]);
  assert.notEqual(staleRun.status, 0);
  assert.match(staleRun.output, /right node_allowances obsolete|missing disposition/i);

  const malformed = path.join(fixture.repo, 'receipt.json');
  fs.writeFileSync(malformed, '{not json');
  const malformedRun = invoke(fixture, ['--dispositions', malformed]);
  assert.notEqual(malformedRun.status, 0);
  assert.match(malformedRun.output, /invalid JSON|parse/i);
});
