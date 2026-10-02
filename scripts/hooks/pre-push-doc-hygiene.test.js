'use strict';
// Tests for the pre-push guard. Every test builds throwaway repositories under
// os.tmpdir() and lets git itself run the hook through a real `git push` to a
// local bare repository whose path matches the public repository's URL.
//
// PRE_PUSH_HOOK_SHELL=/path/to/sh runs the hook with that interpreter instead
// of its #!/bin/sh line (used to check the script under dash or BusyBox ash).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, 'pre-push-doc-hygiene.sh');
const SCANNER = path.join(__dirname, '..', 'verify-doc-hygiene.js');
const TERM = 'zebrafarm';
const PRIVATE_MSG = /the commit contains private document folders \(docs\/policy\)/;
// The hook names a ref by the short id of its commit, never by its name.
const L = (sha) => `${sha.slice(0, 7)} \\(ref name withheld\\)`;
const NO_LIST_MSG = /pre-push: osi\.docHygieneTermsFile is not set or not readable; refusing to push to the public repository/;

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  delete env.OSI_DOC_HYGIENE_TERMS;
  env.GIT_CONFIG_GLOBAL = os.devNull;
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

const ENV = cleanEnv();

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, env: ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function tryGitEnv(cwd, env, ...args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function write(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function installHook(work) {
  let text = fs.readFileSync(HOOK, 'utf8');
  const shell = process.env.PRE_PUSH_HOOK_SHELL;
  if (shell) text = text.replace(/^#![^\n]*/, `#!${shell}`);
  const target = path.join(work, '.git', 'hooks', 'pre-push');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
  fs.chmodSync(target, 0o755);
}

// Builds a public and a customers bare remote, a working repository with the
// hook installed, and an initial commit on main that both remotes and the
// remote-tracking refs know about (pushed with --no-verify).
function setup(t, { scanner = true, terms = true } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-push-hygiene-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const org = path.join(tmp, 'Open-Smart-Irrigation');
  const pub = path.join(org, 'osi-os.git');
  const cust = path.join(org, 'osi-os-customers.git');
  const work = path.join(tmp, 'work');
  fs.mkdirSync(org, { recursive: true });
  git(tmp, 'init', '-q', '--bare', '-b', 'main', pub);
  git(tmp, 'init', '-q', '--bare', '-b', 'main', cust);
  git(tmp, 'init', '-q', '-b', 'main', work);
  git(work, 'config', 'user.name', 'Test User');
  git(work, 'config', 'user.email', 'test@example.invalid');
  git(work, 'config', 'commit.gpgsign', 'false');
  git(work, 'config', 'tag.gpgsign', 'false');
  git(work, 'remote', 'add', 'public', pub);
  git(work, 'remote', 'add', 'customers', cust);
  const termsFile = path.join(tmp, 'names.txt');
  fs.writeFileSync(termsFile, `${TERM}\n`);
  if (terms) git(work, 'config', 'osi.docHygieneTermsFile', termsFile);
  installHook(work);
  write(work, 'README.md', '# test repository\n');
  if (scanner) write(work, 'scripts/verify-doc-hygiene.js', fs.readFileSync(SCANNER, 'utf8'));
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'initial commit');
  git(work, 'push', '-q', '--no-verify', 'public', 'main');
  git(work, 'push', '-q', '--no-verify', 'customers', 'main');
  return { tmp, org, pub, cust, work, termsFile };
}

function commit(work, files, message = 'change') {
  for (const [rel, content] of Object.entries(files)) write(work, rel, content);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', message);
  return git(work, 'rev-parse', 'HEAD');
}

function push(work, ...args) {
  return tryGit(work, 'push', ...args);
}

function remoteHas(bare, ref) {
  return tryGit(bare, 'rev-parse', '--verify', '--quiet', ref).code === 0;
}

function assertNoTerm(out) {
  assert.doesNotMatch(out, /zebra/i, 'output must never show the name');
}

test('1. a clean commit pushes to the public remote', (t) => {
  const s = setup(t);
  const sha = commit(s.work, { 'docs/ok.md': 'nothing to see\n' });
  const r = push(s.work, 'public', 'main');
  assert.equal(r.code, 0, r.out);
  assert.equal(git(s.pub, 'rev-parse', 'refs/heads/main'), sha);
});

test('2. a document with a listed name is rejected without showing the name', (t) => {
  const s = setup(t);
  git(s.work, 'checkout', '-q', '-b', 'feature');
  commit(s.work, { 'docs/a.md': 'Visit ZebraFarm today\n' });
  const r = push(s.work, 'public', 'feature');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /docs\/a\.md:1: term #1/);
  assertNoTerm(r.out);
  assert.equal(remoteHas(s.pub, 'refs/heads/feature'), false);
});

test('3. a commit message with a listed name is rejected', (t) => {
  const s = setup(t);
  git(s.work, 'checkout', '-q', '-b', 'feature');
  commit(s.work, { 'docs/ok.md': 'clean\n' }, `notes from the ${TERM} visit`);
  const r = push(s.work, 'public', 'feature');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /stdin:1: term #1/);
  assertNoTerm(r.out);
  assert.equal(remoteHas(s.pub, 'refs/heads/feature'), false);
});

test('4. private document folders are refused without a name list and without a scanner', (t) => {
  const s = setup(t, { scanner: false, terms: false });
  git(s.work, 'checkout', '-q', '-b', 'private');
  const sha = commit(s.work, { 'docs/policy/x.txt': 'private\n' });
  const r = push(s.work, 'public', 'private');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`pre-push: refusing to push ${L(sha)}: the commit contains private document folders \\(docs/policy\\)`));
  assert.equal(remoteHas(s.pub, 'refs/heads/private'), false);
});

test('4b. private document folders are refused with the full configuration too', (t) => {
  const s = setup(t);
  git(s.work, 'checkout', '-q', '-b', 'private');
  commit(s.work, { 'docs/customers/y.md': 'private\n' });
  const r = push(s.work, 'public', 'private');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /private document folders \(docs\/customers\)/);
  assert.equal(remoteHas(s.pub, 'refs/heads/private'), false);
});

test('5. the same commit pushes to the customers remote', (t) => {
  const s = setup(t, { scanner: false, terms: false });
  git(s.work, 'checkout', '-q', '-b', 'private');
  const sha = commit(s.work, { 'docs/policy/x.txt': 'private\n', 'docs/b.md': `${TERM}\n` }, `${TERM} notes`);
  const r = push(s.work, 'customers', 'private');
  assert.equal(r.code, 0, r.out);
  assert.equal(git(s.cust, 'rev-parse', 'refs/heads/private'), sha);
});

test('6. without osi.docHygieneTermsFile a clean push to the public remote is rejected', (t) => {
  const s = setup(t, { terms: false });
  commit(s.work, { 'docs/ok.md': 'clean\n' });
  const r = push(s.work, 'public', 'main');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, NO_LIST_MSG);
});

test('6b. an unreadable name list path is rejected the same way', (t) => {
  const s = setup(t);
  git(s.work, 'config', 'osi.docHygieneTermsFile', path.join(s.tmp, 'missing.txt'));
  commit(s.work, { 'docs/ok.md': 'clean\n' });
  const r = push(s.work, 'public', 'main');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, NO_LIST_MSG);
});

test('7. a dirty working tree does not matter, the pushed commit is scanned', (t) => {
  const s = setup(t);
  const sha = commit(s.work, { 'docs/ok.md': 'clean\n' });
  write(s.work, 'docs/dirty.md', `${TERM}\n`);
  write(s.work, 'README.md', `# ${TERM}\n`);
  const r = push(s.work, 'public', 'main');
  assert.equal(r.code, 0, r.out);
  assert.equal(git(s.pub, 'rev-parse', 'refs/heads/main'), sha);
});

test('8. a pushed branch other than the checked-out one is scanned', (t) => {
  const s = setup(t);
  git(s.work, 'checkout', '-q', '-b', 'other');
  commit(s.work, { 'docs/a.md': `${TERM}\n` });
  git(s.work, 'checkout', '-q', 'main');
  const r = push(s.work, 'public', 'other');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /docs\/a\.md:1: term #1/);
  assertNoTerm(r.out);
  assert.equal(remoteHas(s.pub, 'refs/heads/other'), false);
});

test('9. deleting a remote branch is allowed', (t) => {
  const s = setup(t);
  git(s.work, 'push', '-q', '--no-verify', 'public', 'main:refs/heads/gone');
  assert.equal(remoteHas(s.pub, 'refs/heads/gone'), true);
  const r = push(s.work, 'public', ':gone');
  assert.equal(r.code, 0, r.out);
  assert.equal(remoteHas(s.pub, 'refs/heads/gone'), false);
});

test('10. without a scanner in the commit or on the remote main the scan is skipped', (t) => {
  const s = setup(t, { scanner: false });
  const sha = commit(s.work, { 'docs/ok.md': 'clean\n' });
  const r = push(s.work, 'public', 'main');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`pre-push: no hygiene scanner in ${L(sha)} or on public/main; file and message scan skipped`));
  assert.equal(git(s.pub, 'rev-parse', 'refs/heads/main'), sha);
});

test('10b. a commit without a scanner uses the scanner on the remote main', (t) => {
  const s = setup(t);
  git(s.work, 'checkout', '-q', '-b', 'feature');
  git(s.work, 'rm', '-q', 'scripts/verify-doc-hygiene.js');
  const sha = commit(s.work, { 'docs/a.md': `${TERM}\n` });
  const r = push(s.work, 'public', 'feature');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /docs\/a\.md:1: term #1/);
  assert.match(r.out, new RegExp(`pre-push: ${L(sha)} has no hygiene baseline of its own; merge or rebase onto public/main and push again`));
  assert.equal(remoteHas(s.pub, 'refs/heads/feature'), false);
});

test('11. an allowlisted finding passes', (t) => {
  const s = setup(t);
  const allow = { entries: [{ path: 'docs/a.md', max: 1, reason: 'test fixture', issue: 1 }] };
  const sha = commit(s.work, {
    'docs/a.md': `one ${TERM} mention\n`,
    'scripts/verify-doc-hygiene-allowlist.json': `${JSON.stringify(allow, null, 2)}\n`,
  });
  const r = push(s.work, 'public', 'main');
  assert.equal(r.code, 0, r.out);
  assert.equal(git(s.pub, 'rev-parse', 'refs/heads/main'), sha);
});

test('12. several refs in one push: a bad second ref blocks the whole push', (t) => {
  const s = setup(t);
  git(s.work, 'checkout', '-q', '-b', 'good');
  const good = commit(s.work, { 'docs/ok.md': 'clean\n' });
  git(s.work, 'checkout', '-q', '-b', 'zz-bad');
  const bad = commit(s.work, { 'docs/a.md': `${TERM}\n` });
  const r = push(s.work, 'public', 'good', 'zz-bad');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`refusing to push ${L(bad)}: its documents failed the hygiene scan`));
  assert.doesNotMatch(r.out, new RegExp(`refusing to push ${L(good)}`));
  assert.equal(remoteHas(s.pub, 'refs/heads/good'), false);
  assert.equal(remoteHas(s.pub, 'refs/heads/zz-bad'), false);
});

test('13. pushing by URL without .git or with a trailing slash is guarded', (t) => {
  const s = setup(t);
  git(s.work, 'checkout', '-q', '-b', 'feature');
  commit(s.work, { 'docs/a.md': `${TERM}\n` });
  for (const url of [path.join(s.org, 'osi-os'), `${s.pub}/`]) {
    const r = push(s.work, url, 'HEAD:refs/heads/by-url');
    assert.notEqual(r.code, 0, `${url}: ${r.out}`);
    assert.match(r.out, /docs\/a\.md:1: term #1/);
  }
  assert.equal(remoteHas(s.pub, 'refs/heads/by-url'), false);
});

test('14. a detached HEAD pushed to a new branch is scanned', (t) => {
  const s = setup(t);
  const sha = commit(s.work, { 'docs/a.md': `${TERM}\n` });
  git(s.work, 'checkout', '-q', '--detach', 'HEAD');
  const r = push(s.work, 'public', 'HEAD:refs/heads/x');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /docs\/a\.md:1: term #1/);
  assert.match(r.out, new RegExp(`refusing to push ${L(sha)}: its documents failed the hygiene scan`));
  assert.equal(remoteHas(s.pub, 'refs/heads/x'), false);
});

test('15. an annotated tag on a bad commit is scanned', (t) => {
  const s = setup(t);
  git(s.work, 'checkout', '-q', '-b', 'tagged');
  commit(s.work, { 'docs/a.md': `${TERM}\n` });
  git(s.work, 'tag', '-a', '-m', 'release', 'v9.9.9');
  git(s.work, 'checkout', '-q', 'main');
  const r = push(s.work, 'public', 'v9.9.9');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /docs\/a\.md:1: term #1/);
  assert.equal(remoteHas(s.pub, 'refs/tags/v9.9.9'), false);
});

test('16. an empty name list blocks the push', (t) => {
  const s = setup(t);
  fs.writeFileSync(s.termsFile, '');
  commit(s.work, { 'docs/ok.md': 'clean\n' });
  const r = push(s.work, 'public', 'main');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /OSI_DOC_HYGIENE_TERMS is required but empty/);
});

test('17. a new commit whose own tree holds a private folder is refused, even if a later one removes it', (t) => {
  const s = setup(t);
  git(s.work, 'checkout', '-q', '-b', 'laundered');
  const added = commit(s.work, { 'docs/policy/x.txt': 'private\n' });
  git(s.work, 'rm', '-q', '-r', 'docs/policy');
  git(s.work, 'commit', '-q', '-m', 'remove the folder again');
  const tip = git(s.work, 'rev-parse', 'HEAD');
  const r = push(s.work, 'public', 'laundered');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`pre-push: refusing to push ${L(tip)}: its history contains private document folders \\(commit ${added}\\)`));
  assert.equal(remoteHas(s.pub, 'refs/heads/laundered'), false);
});

test('17b. a clean-up commit that only removes a private folder already on the remote is accepted', (t) => {
  const s = setup(t);
  commit(s.work, { 'docs/archive/old.md': 'old notes\n' });
  git(s.work, 'push', '-q', '--no-verify', 'public', 'main');
  git(s.work, 'rm', '-q', '-r', 'docs/archive');
  git(s.work, 'commit', '-q', '-m', 'move the archive out');
  const sha = git(s.work, 'rev-parse', 'HEAD');
  const r = push(s.work, 'public', 'main');
  assert.equal(r.code, 0, r.out);
  assert.equal(git(s.pub, 'rev-parse', 'refs/heads/main'), sha);
});

test('18. export-ignore attributes cannot hide a file from the scan', (t) => {
  const s = setup(t);
  git(s.work, 'checkout', '-q', '-b', 'hidden');
  const sha = commit(s.work, { '.gitattributes': 'docs/a.md export-ignore\n', 'docs/a.md': `${TERM}\n` });
  const r = push(s.work, 'public', 'hidden');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`refusing to push ${L(sha)}: the export has 1 of 2 files`));
  assert.equal(remoteHas(s.pub, 'refs/heads/hidden'), false);
});

test('19. a remote named like the public one but pointing elsewhere is not guarded', (t) => {
  const s = setup(t, { terms: false });
  git(s.work, 'remote', 'set-url', 'public', s.cust);
  commit(s.work, { 'docs/policy/x.txt': 'private\n' });
  const r = push(s.work, 'public', 'main');
  assert.equal(r.code, 0, r.out);
});

// A directory with links to the named tools only, for runs without node.
function toolDir(tmp, tools) {
  const dir = path.join(tmp, 'bin');
  fs.mkdirSync(dir, { recursive: true });
  for (const tool of tools) {
    const found = (process.env.PATH || '').split(path.delimiter)
      .map((d) => path.join(d, tool))
      .find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return true; } catch { return false; } });
    assert.ok(found, `${tool} not found on PATH`);
    fs.symlinkSync(found, path.join(dir, tool));
  }
  return dir;
}

function runHook(s, args, input, env = ENV) {
  const hook = path.join(s.work, '.git', 'hooks', 'pre-push');
  const r = spawnSync(hook, args, { cwd: s.work, env, input, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

test('20. a malformed ref line refuses the push; other URLs are not inspected', (t) => {
  const s = setup(t);
  const sha = git(s.work, 'rev-parse', 'HEAD');
  const zero = '0'.repeat(40);
  for (const line of ['garbage\n', `refs/heads/main ${sha} refs/heads/main\n`, `refs/heads/main ${sha} refs/heads/main ${zero} extra\n`]) {
    const r = runHook(s, ['public', s.pub], line);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /pre-push: unexpected ref line from git; refusing to push/);
  }
  assert.equal(runHook(s, ['customers', s.cust], 'garbage\n').code, 0);
  const noName = runHook(s, ['', s.pub], `refs/heads/main ${sha} refs/heads/main ${zero}\n`);
  assert.equal(noName.code, 1, noName.out);
  assert.match(noName.out, /pre-push: git passed no remote name; refusing to push/);
});

test('21. a missing node refuses the push when a scanner is present', (t) => {
  const s = setup(t);
  commit(s.work, { 'docs/ok.md': 'clean\n' });
  const tools = ['git', 'sh', 'mktemp', 'cat', 'tr', 'rm', 'tar', 'grep', 'wc', 'mkdir'];
  const env = { ...ENV, PATH: toolDir(s.tmp, tools) };
  const r = tryGitEnv(s.work, env, 'push', 'public', 'main');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /pre-push: node is not installed; refusing to push to the public repository/);
  assert.notEqual(git(s.pub, 'rev-parse', 'refs/heads/main'), git(s.work, 'rev-parse', 'HEAD'));
});

test('22. a failing mktemp refuses the push', (t) => {
  const s = setup(t);
  commit(s.work, { 'docs/ok.md': 'clean\n' });
  const env = { ...ENV, TMPDIR: path.join(s.tmp, 'no', 'such', 'dir') };
  const r = tryGitEnv(s.work, env, 'push', 'public', 'main');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /pre-push: cannot create a temporary directory; refusing to push/);
});

test('23. a name added in one new commit and removed in the next is refused (intermediate content)', (t) => {
  const s = setup(t);
  git(s.work, 'checkout', '-q', '-b', 'p1');
  commit(s.work, { 'docs/a.md': `visit ${TERM}\n` });
  const tip = commit(s.work, { 'docs/a.md': 'visit the reference farm\n' });
  const r = push(s.work, 'public', 'p1');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /docs\/a\.md: added line: term #1/);
  assert.match(r.out, new RegExp(`pre-push: a commit in ${L(tip)} adds a listed term or identifier that a later commit removes or keeps; squash or rewrite those commits before pushing`));
  assertNoTerm(r.out);
  assert.equal(remoteHas(s.pub, 'refs/heads/p1'), false);
});

test('24. without a scanner in the commit, a push by URL is refused', (t) => {
  const s = setup(t);
  git(s.work, 'checkout', '-q', '-b', 'probe');
  git(s.work, 'rm', '-q', 'scripts/verify-doc-hygiene.js');
  const sha = commit(s.work, { 'docs/a.md': `${TERM}\n` });
  const r = push(s.work, s.pub, 'HEAD:refs/heads/probe');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`pre-push: cannot find a hygiene scanner for ${L(sha)}; fetch .*osi-os\\.git first`));
  assertNoTerm(r.out);
  assert.equal(remoteHas(s.pub, 'refs/heads/probe'), false);
});

test('25. without a scanner in the commit and without the remote-tracking main, a push by name is refused', (t) => {
  const s = setup(t);
  git(s.work, 'checkout', '-q', '-b', 'probe');
  git(s.work, 'rm', '-q', 'scripts/verify-doc-hygiene.js');
  const sha = commit(s.work, { 'docs/a.md': `${TERM}\n` });
  git(s.work, 'update-ref', '-d', 'refs/remotes/public/main');
  const r = push(s.work, 'public', 'probe');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`pre-push: cannot find a hygiene scanner for ${L(sha)}; fetch public first`));
  assert.equal(remoteHas(s.pub, 'refs/heads/probe'), false);
});

test('26. the fallback scanner uses the allowlist of the remote main as well', (t) => {
  const s = setup(t);
  const allow = { entries: [{ path: 'docs/a.md', max: 1, reason: 'test fixture', issue: 1 }] };
  commit(s.work, {
    'docs/a.md': `one ${TERM} mention\n`,
    'scripts/verify-doc-hygiene-allowlist.json': `${JSON.stringify(allow, null, 2)}\n`,
  });
  git(s.work, 'push', '-q', '--no-verify', 'public', 'main');
  git(s.work, 'checkout', '-q', '-b', 'slim');
  git(s.work, 'rm', '-q', 'scripts/verify-doc-hygiene.js', 'scripts/verify-doc-hygiene-allowlist.json');
  const sha = commit(s.work, { 'docs/b.md': 'clean\n' });
  const r = push(s.work, 'public', 'slim');
  assert.equal(r.code, 0, r.out);
  assert.equal(git(s.pub, 'rev-parse', 'refs/heads/slim'), sha);
});

test('27. a scanner without the --stdin-diff mode refuses the push', (t) => {
  const s = setup(t);
  git(s.work, 'checkout', '-q', '-b', 'old-scanner');
  const sha = commit(s.work, { 'scripts/verify-doc-hygiene.js': "console.log('verify-doc-hygiene: OK (old)');\n", 'docs/ok.md': 'clean\n' });
  const r = push(s.work, 'public', 'old-scanner');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`pre-push: the hygiene scanner for ${L(sha)} has no --stdin-diff mode; refusing to push`));
  assert.equal(remoteHas(s.pub, 'refs/heads/old-scanner'), false);
});

test('28. a pushed ref name that carries a name is refused', (t) => {
  const s = setup(t);
  commit(s.work, { 'docs/ok.md': 'clean\n' });
  const r = push(s.work, 'public', `HEAD:refs/heads/customer/${TERM}`);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /stdin:\d+: term #1/);
  assertNoTerm(r.out);
  assert.equal(remoteHas(s.pub, `refs/heads/customer/${TERM}`), false);
});

test('29. the hook exports exactly the scanner scope plus the allowlist', () => {
  const { SCOPE } = require('../verify-doc-hygiene');
  const text = fs.readFileSync(HOOK, 'utf8');
  const scope = text.match(/^SCOPE_PATHS='([^']*)'$/m);
  assert.ok(scope, 'SCOPE_PATHS definition not found');
  assert.deepEqual(scope[1].split(/\s+/).filter(Boolean), SCOPE);
  const allow = text.match(/^ALLOWLIST_PATH=(\S+)$/m);
  assert.ok(allow, 'ALLOWLIST_PATH definition not found');
  assert.equal(allow[1], 'scripts/verify-doc-hygiene-allowlist.json');
});

test('30. a -diff attribute in the pushed branch cannot hide an intermediate name (E5a)', (t) => {
  const s = setup(t);
  git(s.work, 'checkout', '-q', '-b', 'e5a');
  commit(s.work, { '.gitattributes': 'docs/** -diff\n' });
  commit(s.work, { 'docs/a.md': `visit ${TERM}\n` });
  commit(s.work, { 'docs/a.md': 'visit the reference farm\n' });
  const r = push(s.work, 'public', 'e5a');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /docs\/a\.md: added line: term #1/);
  assertNoTerm(r.out);
  assert.equal(remoteHas(s.pub, 'refs/heads/e5a'), false);
});

test('31. a binary attribute in .git/info/attributes cannot hide an intermediate name (E5b)', (t) => {
  const s = setup(t);
  fs.mkdirSync(path.join(s.work, '.git', 'info'), { recursive: true });
  fs.writeFileSync(path.join(s.work, '.git', 'info', 'attributes'), 'docs/** binary\n');
  git(s.work, 'checkout', '-q', '-b', 'e5b');
  commit(s.work, { 'docs/a.md': `visit ${TERM}\n` });
  commit(s.work, { 'docs/a.md': 'visit the reference farm\n' });
  const r = push(s.work, 'public', 'e5b');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /docs\/a\.md: added line: term #1/);
  assertNoTerm(r.out);
  assert.equal(remoteHas(s.pub, 'refs/heads/e5b'), false);
});

test('32. a name added only while resolving a merge conflict is refused (E4)', (t) => {
  const s = setup(t);
  commit(s.work, { 'docs/a.md': 'base line\n' });
  git(s.work, 'push', '-q', '--no-verify', 'public', 'main');
  git(s.work, 'checkout', '-q', '-b', 'side');
  commit(s.work, { 'docs/a.md': 'side line\n' });
  git(s.work, 'checkout', '-q', '-b', 'e4', 'main');
  commit(s.work, { 'docs/a.md': 'main line\n' });
  assert.notEqual(tryGit(s.work, 'merge', '-q', '--no-edit', 'side').code, 0, 'the merge must conflict');
  write(s.work, 'docs/a.md', `merged line for ${TERM}\n`);
  git(s.work, 'add', 'docs/a.md');
  git(s.work, 'commit', '-q', '--no-edit');
  const merge = git(s.work, 'rev-parse', 'HEAD');
  commit(s.work, { 'docs/a.md': 'merged line\n' });
  const r = push(s.work, 'public', 'e4');
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`${merge.slice(0, 7)} docs/a\\.md: added line: term #1`));
  assertNoTerm(r.out);
  assert.equal(remoteHas(s.pub, 'refs/heads/e4'), false);
});

test('33. a git without --diff-merges=remerge refuses the push', (t) => {
  const s = setup(t);
  const sha = commit(s.work, { 'docs/ok.md': 'clean\n' });
  const realGit = (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, 'git'))
    .find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return true; } catch { return false; } });
  const bin = path.join(s.tmp, 'oldgit');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'git'), [
    '#!/bin/sh',
    'for a in "$@"; do',
    '  case $a in --diff-merges=remerge) echo "fatal: unknown value for --diff-merges: remerge" >&2; exit 128 ;; esac',
    'done',
    `exec '${realGit}' "$@"`,
    '',
  ].join('\n'));
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  const zero = '0'.repeat(40);
  const env = { ...ENV, PATH: `${bin}${path.delimiter}${process.env.PATH}` };
  const r = runHook(s, ['public', s.pub], `refs/heads/main ${sha} refs/heads/main ${zero}\n`, env);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /pre-push: git 2\.36 or newer is required for the added-lines scan \(--diff-merges=remerge\); refusing to push/);
});

test('34. a branch whose name carries a name is refused without printing it anywhere', (t) => {
  const s = setup(t);
  git(s.work, 'checkout', '-q', '-b', `customer/${TERM}`);
  commit(s.work, { 'docs/ok.md': 'clean\n' });
  const r = push(s.work, 'public', `customer/${TERM}`);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /stdin:\d+: term #1/);
  assert.match(r.out, /\(ref name withheld\): a commit message or the pushed ref name failed the hygiene scan/);
  assertNoTerm(r.out);
  assert.equal(remoteHas(s.pub, `refs/heads/customer/${TERM}`), false);
});

test('35. a refused tripwire push on a branch whose name carries a name does not print it', (t) => {
  const s = setup(t, { scanner: false, terms: false });
  git(s.work, 'checkout', '-q', '-b', `${TERM}-private`);
  commit(s.work, { 'docs/policy/x.txt': 'private\n' });
  const r = push(s.work, 'public', `${TERM}-private`);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /private document folders \(docs\/policy\)/);
  assertNoTerm(r.out);
});
