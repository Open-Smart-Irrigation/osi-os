'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { loadTerms, scanText, judge, isFakeEui, maskPath } = require('./verify-doc-hygiene');

const SCRIPT = path.join(__dirname, 'verify-doc-hygiene.js');

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-hygiene-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  execFileSync('git', ['add', '-A'], { cwd: root });
  return root;
}

function run(root, args, terms) {
  const env = { ...process.env };
  delete env.OSI_DOC_HYGIENE_TERMS;
  if (terms !== undefined) env.OSI_DOC_HYGIENE_TERMS = terms;
  const r = spawnSync(process.execPath, [SCRIPT, `--root=${root}`, ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: r.stdout + r.stderr };
}

test('loadTerms ignores blank lines and comments and numbers the rest', () => {
  const terms = loadTerms('# header\n\nzebrafarm\n  quagga-?hill  \n');
  assert.deepEqual(terms.map((t) => t.id), ['term #1', 'term #2']);
});

test('loadTerms rejects an invalid pattern without echoing it', () => {
  assert.throws(() => loadTerms('ok\n(unclosed'), (err) => {
    assert.match(err.message, /term #2 is not a valid pattern/);
    assert.doesNotMatch(err.message, /unclosed/);
    return true;
  });
});

test('loadTerms rejects a pattern that matches the empty string', () => {
  assert.throws(() => loadTerms('a*'), /term #1 matches the empty string/);
});

test('scanText finds a term case-insensitively and with a regex variant', () => {
  const terms = loadTerms('zebrafarm\nquagga-?hill');
  const found = scanText('line one\nvisit ZebraFarm today\nQuagga-Hill and quaggahill\n', terms);
  assert.deepEqual(found, [
    { line: 2, id: 'term #1' },
    { line: 3, id: 'term #2' },
    { line: 3, id: 'term #2' },
  ]);
});

test('isFakeEui accepts the documented example values and rejects real-looking ones', () => {
  assert.equal(isFakeEui('0016C001F1000001'), true);
  assert.equal(isFakeEui('a840410000000001'), true);
  assert.equal(isFakeEui('0011223344556677'), true);
  assert.equal(isFakeEui('AA00000000000001'), true);
  assert.equal(isFakeEui('1234567890123456'), true);
  assert.equal(isFakeEui('0016C001F1A7B3D9'), false);
  assert.equal(isFakeEui('A84041B2C3D4E5F6'), false);
});

test('built-in patterns flag a real-looking EUI and a tailnet address only', () => {
  const root = repo({
    'docs/a.md': 'gw 0016C001F1A7B3D9\nexample 0016C001F1000001\naddr 100.93.12.7\nok 100.x.y.z 10.0.0.1 100.128.0.1\n',
  });
  const r = run(root, []);
  assert.equal(r.code, 1);
  assert.match(r.out, /docs\/a\.md:1: eui64/);
  assert.match(r.out, /docs\/a\.md:3: cgnat-address/);
  assert.doesNotMatch(r.out, /docs\/a\.md:2:/);
  assert.doesNotMatch(r.out, /docs\/a\.md:4:/);
});

test('never prints the term or the matched text', () => {
  const root = repo({ 'README.md': 'Installed at ZebraFarm last week.\n' });
  const r = run(root, ['--require-terms'], 'zebrafarm');
  assert.equal(r.code, 1);
  assert.match(r.out, /README\.md:1: term #1/);
  assert.doesNotMatch(r.out, /zebrafarm/i);
});

test('--require-terms fails when the list is empty', () => {
  const root = repo({ 'README.md': 'clean\n' });
  assert.equal(run(root, ['--require-terms']).code, 2);
  assert.equal(run(root, ['--require-terms'], '  \n# only a comment\n').code, 2);
});

test('without the list it runs built-in patterns and says so', () => {
  const root = repo({ 'README.md': 'clean\n' });
  const r = run(root, []);
  assert.equal(r.code, 0);
  assert.match(r.out, /name list not supplied, built-in patterns only/);
});

test('flags a name in a file path', () => {
  const root = repo({ 'docs/zebrafarm-notes.md': 'clean content\n' });
  const r = run(root, ['--require-terms'], 'zebrafarm');
  assert.equal(r.code, 1);
  assert.match(r.out, /docs\/\*\*\*-notes\.md: path: term #1/);
  assert.doesNotMatch(r.out, /zebrafarm/i);
});

test('maskPath replaces private term matches only', () => {
  const terms = loadTerms('zebrafarm');
  assert.equal(maskPath('docs/ZebraFarm-notes.md', terms), 'docs/***-notes.md');
});

test('a content finding in a file whose path carries a term prints the masked path only', () => {
  const root = repo({ 'docs/zebrafarm-notes.md': 'visit zebrafarm\n' });
  const r = run(root, ['--require-terms'], 'zebrafarm');
  assert.equal(r.code, 1);
  assert.match(r.out, /docs\/\*\*\*-notes\.md:1: term #1/);
  assert.doesNotMatch(r.out, /zebrafarm/i);
});

test('an allowlist entry cannot excuse a path finding', () => {
  const root = repo({
    'docs/zebrafarm-notes.md': 'clean\n',
    'scripts/verify-doc-hygiene-allowlist.json': JSON.stringify({ entries: [{ path: 'docs/zebrafarm-notes.md', max: 1, reason: 'x', issue: 1 }] }),
  });
  const r = run(root, ['--require-terms'], 'zebrafarm');
  assert.equal(r.code, 1);
  assert.doesNotMatch(r.out, /zebrafarm/i);
});

test('--write-baseline refuses while a path carries a term and writes nothing', () => {
  const root = repo({ 'docs/zebrafarm-notes.md': 'clean\n' });
  const r = run(root, ['--require-terms', '--write-baseline', '--issue=42'], 'zebrafarm');
  assert.equal(r.code, 1);
  assert.match(r.out, /docs\/\*\*\*-notes\.md: path: term #1/);
  assert.match(r.out, /cannot write a baseline while 1 paths carry a listed term/);
  assert.doesNotMatch(r.out, /zebrafarm/i);
  assert.equal(fs.existsSync(path.join(root, 'scripts/verify-doc-hygiene-allowlist.json')), false);
});

test('a tracked symlink whose name carries a term is reported as a path finding', () => {
  const root = repo({ 'README.md': 'clean\n' });
  fs.symlinkSync('../README.md', path.join(root, 'docs-link'));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.symlinkSync('../README.md', path.join(root, 'docs/zebrafarm-link.md'));
  execFileSync('git', ['add', '-A'], { cwd: root });
  const r = run(root, ['--require-terms'], 'zebrafarm');
  assert.equal(r.code, 1);
  assert.match(r.out, /docs\/\*\*\*-link\.md: path: term #1/);
  assert.doesNotMatch(r.out, /zebrafarm/i);
});

test('eui64 covers prefixed, 0x, colon, bare and lowercase forms and spares examples and hashes', () => {
  const root = repo({
    'docs/bad.md': 'a gw_0016C001F1A7B3D9\nb 0x0016C001F1A7B3D9\nc 00:16:C0:01:F1:A7:B3:D9\nd 0016C001F1A7B3D9\ne 0016c001f1a7b3d9\n',
    'docs/ok.md': [
      '0016C001F1000001', 'gw_0016C001F1000001', '00:16:C0:01:F1:00:00:01',
      'a'.repeat(0) + 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      'da39a3ee5e6b4b0d3255bfef95601890afd80709', '',
    ].join('\n'),
  });
  const r = run(root, []);
  assert.equal(r.code, 1);
  for (const n of [1, 2, 3, 4, 5]) assert.match(r.out, new RegExp(`docs/bad\\.md:${n}: eui64`));
  assert.doesNotMatch(r.out, /docs\/ok\.md/);
});

test('ignores files outside the scope', () => {
  const root = repo({ 'scripts/x.js': '// zebrafarm\n', 'docs/ok.md': 'clean\n' });
  assert.equal(run(root, ['--require-terms'], 'zebrafarm').code, 0);
});

test('skips symlinks and binary files', () => {
  const root = repo({ 'docs/ok.md': 'clean\n', '.claude/skills/s/SKILL.md': 'clean\n', 'scripts/secret.txt': 'zebrafarm\n' });
  fs.writeFileSync(path.join(root, 'docs/blob.bin'), Buffer.from([0x7a, 0x00, 0x7a, 0x65, 0x62, 0x72, 0x61, 0x66, 0x61, 0x72, 0x6d]));
  fs.mkdirSync(path.join(root, '.github'));
  fs.symlinkSync('../scripts/secret.txt', path.join(root, '.github/link.md'));
  execFileSync('git', ['add', '-A'], { cwd: root });
  const r = run(root, ['--require-terms'], 'zebrafarm');
  assert.equal(r.code, 0, r.out);
});

test('--stdin scans supplied text such as commit messages and prints no match', () => {
  const root = repo({ 'README.md': 'clean\n' });
  const env = { ...process.env, OSI_DOC_HYGIENE_TERMS: 'zebrafarm' };
  const args = [SCRIPT, `--root=${root}`, '--stdin', '--require-terms'];
  const bad = spawnSync(process.execPath, args, { env, input: 'fix: deploy\n\nTested at ZebraFarm.\n', encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /stdin:3: term #1/);
  assert.doesNotMatch(bad.stdout + bad.stderr, /zebrafarm/i);
  const good = spawnSync(process.execPath, args, { env, input: 'fix: deploy to the reference gateway\n', encoding: 'utf8' });
  assert.equal(good.status, 0);
});

test('judge allows up to max, flags more, reports stale, and never excuses path findings', () => {
  const f = (n, p = 0) => ({ pathFindings: Array.from({ length: p }, () => ({ line: 0, id: 'term #1' })), findings: Array.from({ length: n }, (_, i) => ({ line: i + 1, id: 'term #1' })) });
  const findings = new Map([['docs/a.md', f(2)], ['docs/b.md', f(1)]]);
  const within = judge(findings, [{ path: 'docs/a.md', max: 2 }, { path: 'docs/b.md', max: 1 }]);
  assert.deepEqual(within, { violations: [], stale: [] });
  const over = judge(findings, [{ path: 'docs/a.md', max: 1 }, { path: 'docs/b.md', max: 1 }]);
  assert.equal(over.violations.length, 1);
  assert.equal(over.violations[0].file, 'docs/a.md');
  const stale = judge(findings, [{ path: 'docs/a.md', max: 2 }, { path: 'docs/b.md', max: 4 }, { path: 'docs/gone.md', max: 1 }]);
  assert.deepEqual(stale.stale.map((s) => s.file), ['docs/b.md', 'docs/gone.md']);
  const pathOnly = judge(new Map([['docs/c.md', f(0, 1)]]), [{ path: 'docs/c.md', max: 5 }]);
  assert.equal(pathOnly.violations.length, 1);
});

test('fails on a stale allowlist entry', () => {
  const root = repo({
    'docs/a.md': 'clean now\n',
    'scripts/verify-doc-hygiene-allowlist.json': JSON.stringify({ entries: [{ path: 'docs/a.md', max: 3, reason: 'pinned by a test', issue: 1 }] }),
  });
  const r = run(root, ['--require-terms'], 'zebrafarm');
  assert.equal(r.code, 1);
  assert.match(r.out, /docs\/a\.md: allowlist max 3 but only 0 found, lower it/);
});

test('rejects an allowlist entry without reason or issue', () => {
  const root = repo({
    'docs/a.md': 'zebrafarm\n',
    'scripts/verify-doc-hygiene-allowlist.json': JSON.stringify({ entries: [{ path: 'docs/a.md', max: 1 }] }),
  });
  assert.equal(run(root, ['--require-terms'], 'zebrafarm').code, 2);
});

test('--write-baseline records every current finding and a second run passes', () => {
  const root = repo({ 'docs/a.md': 'zebrafarm and zebrafarm\n', 'docs/b.md': 'clean\n' });
  assert.equal(run(root, ['--require-terms', '--write-baseline', '--issue=42'], 'zebrafarm').code, 0);
  const written = JSON.parse(fs.readFileSync(path.join(root, 'scripts/verify-doc-hygiene-allowlist.json'), 'utf8'));
  assert.deepEqual(written.entries, [{ path: 'docs/a.md', max: 2, reason: 'baseline, removed by the documentation run', issue: 42 }]);
  assert.equal(run(root, ['--require-terms'], 'zebrafarm').code, 0);
});

test('without the name list, entries counting private matches are not stale', () => {
  const root = repo({
    'docs/a.md': 'zebrafarm and zebrafarm, gateway A840410ABCDEF123\n',
    'scripts/verify-doc-hygiene-allowlist.json': JSON.stringify({ entries: [{ path: 'docs/a.md', max: 3, reason: 'pinned by a test', issue: 1 }] }),
  });
  const r = run(root, []);
  assert.equal(r.code, 0);
  assert.match(r.out, /OK \(\d+ files scanned, built-in patterns only; allowlist staleness not checked\)/);
});

test('with the name list the same repo passes', () => {
  const root = repo({
    'docs/a.md': 'zebrafarm and zebrafarm, gateway A840410ABCDEF123\n',
    'scripts/verify-doc-hygiene-allowlist.json': JSON.stringify({ entries: [{ path: 'docs/a.md', max: 3, reason: 'pinned by a test', issue: 1 }] }),
  });
  assert.equal(run(root, ['--require-terms'], 'zebrafarm').code, 0);
});

test('without the name list, an over-limit built-in count still fails', () => {
  const root = repo({
    'docs/a.md': 'A840410ABCDEF123 and B1C2D3E4F5061728\n',
    'scripts/verify-doc-hygiene-allowlist.json': JSON.stringify({ entries: [{ path: 'docs/a.md', max: 1, reason: 'pinned by a test', issue: 1 }] }),
  });
  assert.equal(run(root, []).code, 1);
});

// ---- --stdin-diff: added lines of a commit range, from real `git log -p` output ----

const { SCOPE } = require('./verify-doc-hygiene');

const HISTORY_ENV = (() => {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key];
  delete env.OSI_DOC_HYGIENE_TERMS;
  env.GIT_CONFIG_GLOBAL = os.devNull;
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
})();

function g(root, ...args) {
  return execFileSync('git', args, { cwd: root, env: HISTORY_ENV, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function historyRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-hygiene-diff-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  g(root, 'init', '-q', '-b', 'main');
  g(root, 'config', 'user.name', 'Test User');
  g(root, 'config', 'user.email', 'test@example.invalid');
  g(root, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, 'README.md'), 'clean\n');
  g(root, 'add', '-A');
  g(root, 'commit', '-q', '-m', 'initial');
  return { root, base: g(root, 'rev-parse', 'HEAD') };
}

// files: { rel: string | Buffer | null }, null deletes the file.
function commitFiles(root, files, message = 'change') {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, rel);
    if (content === null) {
      fs.rmSync(abs);
    } else {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
  }
  g(root, 'add', '-A');
  g(root, 'commit', '-q', '-m', message);
  return g(root, 'rev-parse', 'HEAD');
}

// The same `git log -p` the pre-push hook runs (pass hook = false for the
// plain form without --text and remerge diffs).
function diffOf(root, range, gitConfig = ['-c', 'core.quotePath=false'], hook = true) {
  const extra = hook ? ['--text', '--diff-merges=remerge'] : [];
  return g(root, ...gitConfig, '-c', 'log.showRoot=true', '-c', 'log.showSignature=false', 'log', '-p', ...extra,
    '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/',
    '--format=commit %H', ...[].concat(range), '--', ...SCOPE);
}

function runDiff(root, input, terms = 'zebrafarm') {
  const env = { ...HISTORY_ENV };
  if (terms !== undefined) env.OSI_DOC_HYGIENE_TERMS = terms;
  const r = spawnSync(process.execPath, [SCRIPT, `--root=${root}`, '--stdin-diff', '--require-terms'], { env, input, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('SCOPE is exported for the pre-push hook', () => {
  assert.deepEqual(SCOPE, ['README.md', 'AGENTS.md', 'CLAUDE.md', 'CHANGELOG.md', 'docs', '.claude/skills', '.github', 'analysis']);
});

test('--stdin-diff reports a name added in one commit and removed in the next, for the adding commit', (t) => {
  const { root, base } = historyRepo(t);
  const a = commitFiles(root, { 'docs/a.md': 'intro\nvisit ZebraFarm today\n' });
  const b = commitFiles(root, { 'docs/a.md': 'intro\nvisit the reference farm today\n' });
  const r = runDiff(root, diffOf(root, `${base}..HEAD`));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`^${a.slice(0, 7)} docs/a\\.md: added line: term #1$`, 'm'));
  assert.doesNotMatch(r.out, new RegExp(b.slice(0, 7)));
  assert.match(r.out, /verify-doc-hygiene: FAIL \(1 findings in added lines of the supplied commits\)/);
  assert.doesNotMatch(r.out, /zebra/i);
  assert.doesNotMatch(r.out, /visit/);
});

test('--stdin-diff reports built-in identifiers in added lines too', (t) => {
  const { root, base } = historyRepo(t);
  const a = commitFiles(root, { 'docs/a.md': 'gw 0016C001F1A7B3D9\n' });
  commitFiles(root, { 'docs/a.md': 'gw 0016C001F1000001\n' });
  const r = runDiff(root, diffOf(root, `${base}..HEAD`));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`^${a.slice(0, 7)} docs/a\\.md: added line: eui64$`, 'm'));
});

test('--stdin-diff skips files that have an allowlist entry in --root', (t) => {
  const { root, base } = historyRepo(t);
  commitFiles(root, {
    'docs/a.md': 'one zebrafarm mention\n',
    'scripts/verify-doc-hygiene-allowlist.json': JSON.stringify({ entries: [{ path: 'docs/a.md', max: 1, reason: 'test', issue: 1 }] }),
  });
  const r = runDiff(root, diffOf(root, `${base}..HEAD`));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /verify-doc-hygiene: OK \(supplied commits\)/);
});

test('--stdin-diff reports a file that was added and deleted again', (t) => {
  const { root, base } = historyRepo(t);
  const a = commitFiles(root, { 'docs/tmp.md': 'zebrafarm\n' });
  commitFiles(root, { 'docs/tmp.md': null });
  const r = runDiff(root, diffOf(root, `${base}..HEAD`));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`^${a.slice(0, 7)} docs/tmp\\.md: added line: term #1$`, 'm'));
  assert.doesNotMatch(r.out, /zebra/i);
});

test('--stdin-diff reports a path that carries a term, masked', (t) => {
  const { root, base } = historyRepo(t);
  const a = commitFiles(root, { 'docs/zebrafarm-notes.md': 'clean\n' });
  const r = runDiff(root, diffOf(root, `${base}..HEAD`));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`^${a.slice(0, 7)} docs/\\*\\*\\*-notes\\.md: path: term #1$`, 'm'));
  assert.doesNotMatch(r.out, /zebra/i);
});

test('--stdin-diff reads quoted paths and masks them', (t) => {
  const { root, base } = historyRepo(t);
  const a = commitFiles(root, { 'docs/zebrafarm "q" ü.md': 'visit zebrafarm\n' });
  // default core.quotePath: the path is C-quoted with octal escapes
  const r = runDiff(root, diffOf(root, `${base}..HEAD`, []));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`^${a.slice(0, 7)} docs/\\*\\*\\* "q" ü\\.md: path: term #1$`, 'm'));
  assert.match(r.out, new RegExp(`^${a.slice(0, 7)} docs/\\*\\*\\* "q" ü\\.md: added line: term #1$`, 'm'));
  assert.doesNotMatch(r.out, /zebra/i);
});

test('--stdin-diff treats an added line that looks like a diff header as content', (t) => {
  const { root, base } = historyRepo(t);
  const a = commitFiles(root, { 'docs/a.md': 'first\n++ b/zebrafarm\n' });
  const r = runDiff(root, diffOf(root, `${base}..HEAD`));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`^${a.slice(0, 7)} docs/a\\.md: added line: term #1$`, 'm'));
});

test('--stdin-diff passes a clean range', (t) => {
  const { root, base } = historyRepo(t);
  commitFiles(root, { 'docs/a.md': 'the reference gateway\n' });
  commitFiles(root, { 'docs/a.md': null, 'docs/b.md': 'a customer gateway\n' });
  const r = runDiff(root, diffOf(root, `${base}..HEAD`));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /verify-doc-hygiene: OK \(supplied commits\)/);
});

test('--stdin-diff copes with binary files and mode-only changes', (t) => {
  const { root, base } = historyRepo(t);
  commitFiles(root, { 'docs/blob.bin': Buffer.from([0x7a, 0x00, 0x7a, 0x65, 0x62, 0x72, 0x61]), 'docs/x.md': 'clean\n' });
  g(root, 'update-index', '--chmod=+x', 'docs/x.md');
  g(root, 'commit', '-q', '-m', 'mode only');
  commitFiles(root, { 'docs/blob.bin': Buffer.from([0x00, 0x01, 0x02]) });
  const input = diffOf(root, `${base}..HEAD`, undefined, false);
  assert.match(input, /Binary files/);
  assert.match(input, /new mode/);
  const r = runDiff(root, input);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /verify-doc-hygiene: OK \(supplied commits\)/);
  const asText = diffOf(root, `${base}..HEAD`);
  assert.doesNotMatch(asText, /Binary files/);
  const t2 = runDiff(root, asText);
  assert.equal(t2.code, 0, t2.out);
});

test('--stdin-diff skips an added line with a NUL and still scans the next line of the file', (t) => {
  const { root, base } = historyRepo(t);
  const a = commitFiles(root, { 'docs/mixed.md': Buffer.from('zebrafarm\u0000blob\nsecond zebrafarm\n', 'utf8') });
  const input = diffOf(root, `${base}..HEAD`);
  assert.match(input, /\u0000/);
  const r = runDiff(root, input);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL \(1 findings in added lines/);
  assert.match(r.out, new RegExp(`^${a.slice(0, 7)} docs/mixed\\.md: added line: term #1$`, 'm'));
});

// Two branches change the same line; the merge resolves the conflict.
function conflictMerge(root, resolution) {
  commitFiles(root, { 'docs/a.md': 'base line\n' });
  g(root, 'checkout', '-q', '-b', 'side');
  commitFiles(root, { 'docs/a.md': 'side zebrafarm line\n' });
  g(root, 'checkout', '-q', 'main');
  commitFiles(root, { 'docs/a.md': 'main zebrafarm line\n' });
  const r = spawnSync('git', ['merge', '-q', '--no-edit', 'side'], { cwd: root, env: HISTORY_ENV, encoding: 'utf8' });
  assert.notEqual(r.status, 0, 'the merge must conflict');
  fs.writeFileSync(path.join(root, 'docs/a.md'), resolution);
  g(root, 'add', 'docs/a.md');
  g(root, 'commit', '-q', '--no-edit');
  return g(root, 'rev-parse', 'HEAD');
}

test('--stdin-diff on a remerge diff scans the resolution, not the conflict markers or the sides', (t) => {
  const { root } = historyRepo(t);
  const merge = conflictMerge(root, 'resolved line\n');
  const input = diffOf(root, ['-1', merge]);
  assert.match(input, /^-<{7}/m);
  assert.match(input, /^-.*zebrafarm/m);
  const r = runDiff(root, input);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /verify-doc-hygiene: OK \(supplied commits\)/);
});

test('--stdin-diff on a remerge diff reports a name the resolution adds', (t) => {
  const { root } = historyRepo(t);
  const merge = conflictMerge(root, 'resolved line for ZebraFarm\n');
  const r = runDiff(root, diffOf(root, ['-1', merge]));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`^${merge.slice(0, 7)} docs/a\\.md: added line: term #1$`, 'm'));
  assert.match(r.out, /FAIL \(1 findings in added lines/);
  assert.doesNotMatch(r.out, /zebra/i);
});

test('--stdin-diff with --require-terms and an empty list is a configuration error', (t) => {
  const { root, base } = historyRepo(t);
  commitFiles(root, { 'docs/a.md': 'clean\n' });
  assert.equal(runDiff(root, diffOf(root, `${base}..HEAD`), '').code, 2);
});

test('--stdin-diff reads a path with spaces (git appends a tab to it) and matches it to the allowlist', (t) => {
  const { root, base } = historyRepo(t);
  const a = commitFiles(root, { 'docs/zebrafarm notes.md': 'visit zebrafarm\n', 'docs/old notes.md': 'zebrafarm\n',
    'scripts/verify-doc-hygiene-allowlist.json': JSON.stringify({ entries: [{ path: 'docs/old notes.md', max: 1, reason: 'test', issue: 1 }] }) });
  const r = runDiff(root, diffOf(root, `${base}..HEAD`));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, new RegExp(`^${a.slice(0, 7)} docs/\\*\\*\\* notes\\.md: added line: term #1$`, 'm'));
  assert.doesNotMatch(r.out, /old notes/);
  assert.match(r.out, /FAIL \(2 findings/);
});
