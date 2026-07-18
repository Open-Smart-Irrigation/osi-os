'use strict';
// Tests for the absolute-ceiling flow-size ratchet (refactor-program A0 commit 3).
// The ratchet no longer diffs against a moving git base-ref: every function node
// carries a committed, reviewed absolute `max_chars` ceiling, and each profile
// carries a committed absolute `max_total`. Both are hard maximums measured directly
// against the current tree - no git, no baseline doc, no deltas.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const script = path.join(__dirname, 'verify-flows-size-ratchet.js');
const SURFACE = 'flows.json';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flows-size-ratchet-'));
}
function writeFlows(dir, nodes) {
  fs.writeFileSync(path.join(dir, SURFACE), JSON.stringify(nodes, null, 2) + '\n');
}
function writeAllowancesRaw(dir, raw) {
  fs.writeFileSync(path.join(dir, 'allowances.json'), raw);
}
function writeAllowances(dir, allowances) {
  writeAllowancesRaw(dir, JSON.stringify(allowances, null, 2) + '\n');
}
function run(dir, extraArgs = []) {
  return spawnSync(process.execPath, [
    script, '--root', dir, '--allowances', path.join(dir, 'allowances.json'),
    '--surface', SURFACE, ...extraArgs,
  ], { cwd: dir, encoding: 'utf8' });
}

const fn = (id, func, extra = {}) => ({ id, type: 'function', name: id, func, ...extra });

// A tiny fixture flow with exact per-node coverage.
function fixtureNodes(ownedFunc) {
  return [fn('unowned', 'return msg;'), fn('owned', ownedFunc)];
}

function exactAllowances(ownedChars, total, overrides = {}) {
  return {
    node_allowances: {
      unowned: {
        max_chars: 'return msg;'.length,
        reason: 'test: exact measured ceiling',
        ...overrides.unowned,
      },
      owned: { max_chars: ownedChars, reason: 'test: exact measured ceiling', ...overrides.owned },
    },
    total_allowance: { max_total: total, reason: 'test: exact measured total ceiling', ...overrides.total },
  };
}

function rawAllowancesWithNumericTokens(maxCharsToken, maxTotalToken) {
  return '{"node_allowances":{'
    + '"unowned":{"max_chars":11,"reason":"test: exact measured ceiling"},'
    + `"owned":{"max_chars":${maxCharsToken},"reason":"test: exact measured ceiling"}`
    + `},"total_allowance":{"max_total":${maxTotalToken},"reason":"test: exact measured total ceiling"}}`;
}

test('PASS at the exact measured baseline (zero headroom on both node and total ceilings)', () => {
  const dir = tmpDir();
  const nodes = fixtureNodes('x'.repeat(200));
  writeFlows(dir, nodes);
  const total = nodes.reduce((sum, n) => sum + n.func.length, 0);
  writeAllowances(dir, exactAllowances(200, total));
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /verify-flows-size-ratchet: OK/);
});

test('PASS with exact coverage for an empty function at max_chars zero', () => {
  const dir = tmpDir();
  writeFlows(dir, [fn('empty', '')]);
  writeAllowances(dir, {
    node_allowances: {
      empty: { max_chars: 0, reason: 'test: exact empty-function ceiling' },
    },
    total_allowance: { max_total: 0, reason: 'test: exact empty-flow total ceiling' },
  });

  const r = run(dir);
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /verify-flows-size-ratchet: OK/);
});

test('FAIL when an owned node exceeds its committed max_chars by a single byte, PASS again once the ceiling is updated', () => {
  const dir = tmpDir();
  const nodes = fixtureNodes('x'.repeat(201)); // one byte over the 200 ceiling below
  writeFlows(dir, nodes);
  // Generous total headroom so only the per-node ceiling is exercised.
  writeAllowances(dir, exactAllowances(200, 100000));
  const over = run(dir);
  assert.notEqual(over.status, 0, over.stdout);
  assert.match(over.stderr, /node owned/);
  assert.match(over.stderr, /201/);
  assert.match(over.stderr, /200/);

  // Bump the committed ceiling by exactly the amount needed - now it must pass.
  writeAllowances(dir, exactAllowances(201, 100000));
  const fixed = run(dir);
  assert.equal(fixed.status, 0, fixed.stderr || fixed.stdout);
});

test('FAIL on the growing node ceiling when another covered node shrinks and max_total is unchanged', () => {
  const dir = tmpDir();
  const nodes = [fn('growing', 'x'.repeat(101)), fn('shrinking', 'y'.repeat(99))];
  writeFlows(dir, nodes);
  writeAllowances(dir, {
    node_allowances: {
      growing: { max_chars: 100, reason: 'test: growing node baseline' },
      shrinking: { max_chars: 100, reason: 'test: shrinking node baseline' },
    },
    total_allowance: { max_total: 200, reason: 'test: aggregate remains at baseline' },
  });

  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /node growing is 101 chars, exceeding its committed ceiling of 100 \(\+1\)/);
  assert.doesNotMatch(r.stderr, /missing a committed ceiling/);
  assert.doesNotMatch(r.stderr, /node shrinking/);
  assert.doesNotMatch(r.stderr, /total embedded JS/);
});

test('FAIL when a new small function node has no explicit ceiling despite max_total headroom', () => {
  const dir = tmpDir();
  const nodes = [...fixtureNodes('x'.repeat(200)), fn('new-small', 'return 1;')];
  writeFlows(dir, nodes);
  writeAllowances(dir, exactAllowances(200, 100000));

  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /new-small/);
  assert.match(r.stderr, /missing.*ceiling|ceiling.*missing/);
});

test('FAIL when an existing measured function node is omitted from node_allowances', () => {
  const dir = tmpDir();
  const nodes = fixtureNodes('x'.repeat(200));
  writeFlows(dir, nodes);
  writeAllowances(dir, {
    node_allowances: {
      owned: { max_chars: 200, reason: 'test: owned node baseline' },
    },
    total_allowance: {
      max_total: nodes.reduce((sum, node) => sum + node.func.length, 0),
      reason: 'test: exact measured total ceiling',
    },
  });

  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /unowned/);
  assert.match(r.stderr, /missing.*ceiling|ceiling.*missing/);
});

test('max_total is enforced independently of any per-node ceiling', () => {
  const dir = tmpDir();
  // Both nodes stay within their ceilings, but the profile total exceeds max_total.
  const nodes = [fn('unowned', 'y'.repeat(500)), fn('owned', 'x'.repeat(50))];
  writeFlows(dir, nodes);
  const allowances = exactAllowances(1000, 500, { unowned: { max_chars: 500 } });
  writeAllowances(dir, allowances); // node ceilings generous; total too tight
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /total embedded JS/);
  assert.doesNotMatch(r.stderr, /node owned/);

  allowances.total_allowance.max_total = 550;
  writeAllowances(dir, allowances);
  const fixed = run(dir);
  assert.equal(fixed.status, 0, fixed.stderr || fixed.stdout);
});

test('FAIL closed on a stale delta-schema allowances file (node_allowances[*].delta)', () => {
  const dir = tmpDir();
  writeFlows(dir, fixtureNodes('x'.repeat(200)));
  writeAllowances(dir, {
    node_allowances: { owned: { delta: 100, reason: 'stale delta schema' } },
    total_allowance: { delta: 100, reason: 'stale delta schema' },
  });
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /delta/);
});

test('FAIL closed on a stale delta field on total_allowance even when node_allowances is migrated', () => {
  const dir = tmpDir();
  writeFlows(dir, fixtureNodes('x'.repeat(200)));
  writeAllowances(dir, {
    node_allowances: { owned: { max_chars: 200, reason: 'migrated' } },
    total_allowance: { delta: 100, reason: 'not migrated' },
  });
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /delta/);
});

test('FAIL closed on an allowance entry for a node id that does not exist (unused entry)', () => {
  const dir = tmpDir();
  writeFlows(dir, fixtureNodes('x'.repeat(200)));
  const total = 200 + 'return msg;'.length;
  const allowances = exactAllowances(200, total);
  allowances.node_allowances['ghost-node-id'] = { max_chars: 4096, reason: 'no longer exists' };
  writeAllowances(dir, allowances);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /ghost-node-id/);
  assert.match(r.stderr, /unused|does not exist/);
});

test('FAIL closed on a real duplicate key after a brace and escaped key-like text inside a reason string', () => {
  const dir = tmpDir();
  writeFlows(dir, fixtureNodes('x'.repeat(200)));
  writeAllowancesRaw(dir, `{
    "node_allowances": {
      "unowned": {"max_chars": 11, "reason": "test: exact measured ceiling"},
      "owned": {"max_chars": 1, "reason": "contains } and escaped key-like text: \\"owned\\":"},
      "owned": {"max_chars": 200, "reason": "last duplicate must never win"}
    },
    "total_allowance": {"max_total": 211, "reason": "test: exact measured total ceiling"}
  }`);
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /duplicate.*owned/i);
});

test('FAIL closed on duplicate keys at the root and inside allowance entry and total objects', () => {
  const valid = rawAllowancesWithNumericTokens('200', '211');
  const fixtures = [
    valid.replace(
      ',"total_allowance":',
      ',"total_allowance":{"max_total":1,"reason":"shadowed root value"},"total_allowance":',
    ),
    valid.replace('"owned":{"max_chars":200', '"owned":{"max_chars":1,"max_chars":200'),
    valid.replace('"max_total":211', '"max_total":1,"max_total":211'),
  ];
  for (const raw of fixtures) {
    const dir = tmpDir();
    writeFlows(dir, fixtureNodes('x'.repeat(200)));
    writeAllowancesRaw(dir, raw);
    const r = run(dir);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /duplicate/i);
  }
});

test('FAIL closed on a node_allowances entry missing a reason', () => {
  const dir = tmpDir();
  writeFlows(dir, fixtureNodes('x'.repeat(200)));
  writeAllowances(dir, {
    node_allowances: { owned: { max_chars: 200 } },
    total_allowance: { max_total: 100000, reason: 'ok' },
  });
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /reason/);
});

test('FAIL closed on a total_allowance missing a reason', () => {
  const dir = tmpDir();
  writeFlows(dir, fixtureNodes('x'.repeat(200)));
  writeAllowances(dir, {
    node_allowances: { owned: { max_chars: 200, reason: 'ok' } },
    total_allowance: { max_total: 100000 },
  });
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
  assert.match(r.stderr, /reason/);
});

for (const [label, badValue] of [
  ['a string ceiling', '4096'],
  ['an approximate/wildcard-marked ceiling', '~4096'],
  ['a wildcard ceiling', '*'],
  ['a non-integer (rounded/fractional) ceiling', 200.5],
  ['a negative ceiling', -1],
]) {
  test('FAIL closed on ' + label + ' for a node_allowances entry', () => {
    const dir = tmpDir();
    writeFlows(dir, fixtureNodes('x'.repeat(200)));
    writeAllowances(dir, {
      node_allowances: { owned: { max_chars: badValue, reason: 'ok' } },
      total_allowance: { max_total: 100000, reason: 'ok' },
    });
    const r = run(dir);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /max_chars/);
  });

  test('FAIL closed on ' + label + ' for total_allowance.max_total', () => {
    const dir = tmpDir();
    writeFlows(dir, fixtureNodes('x'.repeat(200)));
    writeAllowances(dir, {
      node_allowances: { owned: { max_chars: 200, reason: 'ok' } },
      total_allowance: { max_total: badValue, reason: 'ok' },
    });
    const r = run(dir);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /max_total/);
  });
}

for (const [label, token] of [
  ['an unsafe integer token', '9007199254740993'],
  ['a fractional token that JSON.parse rounds to an integer', '4500000000000000.1'],
]) {
  test('FAIL closed on ' + label + ' for a node_allowances entry', () => {
    const dir = tmpDir();
    writeFlows(dir, fixtureNodes('x'.repeat(200)));
    writeAllowancesRaw(dir, rawAllowancesWithNumericTokens(token, '100000'));
    const r = run(dir);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /max_chars/);
  });

  test('FAIL closed on ' + label + ' for total_allowance.max_total', () => {
    const dir = tmpDir();
    writeFlows(dir, fixtureNodes('x'.repeat(200)));
    writeAllowancesRaw(dir, rawAllowancesWithNumericTokens('200', token));
    const r = run(dir);
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /max_total/);
  });
}

test('FAIL closed when the allowances file is missing entirely (no implicit zero-allowance fallback)', () => {
  const dir = tmpDir();
  writeFlows(dir, fixtureNodes('x'.repeat(200)));
  const r = spawnSync(process.execPath, [
    script, '--root', dir, '--allowances', path.join(dir, 'nonexistent.json'), '--surface', SURFACE,
  ], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(r.status, 0, r.stdout);
});

test('FAIL closed on an unparsable (non-JSON) allowances file', () => {
  const dir = tmpDir();
  writeFlows(dir, fixtureNodes('x'.repeat(200)));
  writeAllowancesRaw(dir, '{ not valid json');
  const r = run(dir);
  assert.notEqual(r.status, 0, r.stdout);
});

test('the shipped allowances exactly cover both real flows.json surfaces, and the real script passes against the real repo', () => {
  const r = spawnSync(process.execPath, [script], { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /verify-flows-size-ratchet: OK/);
});

test('the committed allowances file contains no legacy delta fields anywhere', () => {
  const raw = fs.readFileSync(path.join(repoRoot, 'scripts/verify-flows-size-ratchet-allowances.json'), 'utf8');
  assert.doesNotMatch(raw, /"delta"\s*:/);
});

test('the committed allowances reasons describe ownership without legacy delta language', () => {
  const allowances = JSON.parse(fs.readFileSync(
    path.join(repoRoot, 'scripts/verify-flows-size-ratchet-allowances.json'),
    'utf8',
  ));
  const reasons = [
    ...Object.values(allowances.node_allowances).map((entry) => entry.reason),
    allowances.total_allowance.reason,
  ];
  assert.equal(reasons.some((reason) => /\bdelta\b/i.test(reason)), false);
});

test('the stale baseline doc file no longer exists', () => {
  assert.equal(fs.existsSync(path.join(repoRoot, 'scripts/verify-flows-size-ratchet-baseline.json')), false,
    'scripts/verify-flows-size-ratchet-baseline.json must be deleted (git rm) as part of the absolute-ceiling migration');
});

test('the rewritten script rejects every removed baseline/delta CLI flag as an unknown argument', () => {
  const dir = tmpDir();
  writeFlows(dir, fixtureNodes('x'.repeat(200)));
  const total = 200 + 'return msg;'.length;
  writeAllowances(dir, exactAllowances(200, total));
  for (const removedFlag of ['--baseline', '--write-baseline', '--base-ref', '--git-root']) {
    const r = run(dir, [removedFlag, 'x']);
    assert.notEqual(r.status, 0, `${removedFlag} must no longer be accepted: ${r.stdout}`);
    assert.match(r.stderr, /unknown argument/);
  }
  // --write-baseline takes no value argument; exercise it standalone too.
  const standalone = run(dir, ['--write-baseline']);
  assert.notEqual(standalone.status, 0, standalone.stdout);
  assert.match(standalone.stderr, /unknown argument/);
});

test('the module no longer exports the removed baseline-authoring functions', () => {
  delete require.cache[require.resolve('./verify-flows-size-ratchet.js')];
  const mod = require('./verify-flows-size-ratchet.js');
  assert.equal(mod.buildBaseline, undefined);
  assert.equal(mod.verifyDocBaseline, undefined);
});
