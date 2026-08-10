#!/usr/bin/env node
'use strict';

// Regression coverage for the P0 defect: validate_journal_media_settings()
// failing must never stop start_service() from starting Node-RED. This
// drives the actual caller (start_service), not just the validator, because
// the defect lived in the caller's `|| { ...; return 1; }` handling.
//
// Route: copy node-red.init into a throwaway sandbox, rewrite the absolute
// paths it writes to onto the sandbox prefix, stub uci/logger/procd_*/
// gateway-identity as recording shell functions, source the rewritten init,
// and run start_service() for real.
//
// This file also pins validate_journal_media_settings()'s reason-code table
// (see journal_media_invalid_reason() in node-red.init) by name, code by
// code, so a copy-paste error in that mapping ships loud, not silent.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const INIT_SOURCE = path.join(
  ROOT,
  'feeds/chirpstack-openwrt-feed/apps/node-red/files/node-red.init',
);

const HARNESS_SCRIPT = `
. "$INIT_PATH"

uci() {
  if [ "$1" = "-q" ] && [ "$2" = "get" ]; then
    case "$3" in
      osi-server.cloud.journal_media_root)
        [ -n "$TEST_JOURNAL_MEDIA_ROOT" ] || return 1
        printf '%s\\n' "$TEST_JOURNAL_MEDIA_ROOT"
        return 0
        ;;
      osi-server.cloud.journal_photo_cache_bytes)
        printf '%s\\n' "$TEST_JOURNAL_PHOTO_CACHE_BYTES"
        return 0
        ;;
      osi-server.cloud.journal_min_free_bytes)
        printf '%s\\n' "$TEST_JOURNAL_MIN_FREE_BYTES"
        return 0
        ;;
      *) return 1 ;;
    esac
  fi
  return 1
}

logger() { printf '%s\\n' "$*" >> "$TEST_LOGGER_LOG"; }
gateway_identity_heal() { return 0; }
gateway_identity_resolve() { return 0; }
normalize_gateway_eui() { printf '%s' "$1"; }

procd_open_instance() { printf 'open\\n' >> "$TEST_CALL_LOG"; }
procd_close_instance() { printf 'close\\n' >> "$TEST_CALL_LOG"; }
procd_set_param() {
  if [ "$1" = "env" ]; then
    shift
    : > "$TEST_ENV_LOG"
    for kv in "$@"; do printf '%s\\n' "$kv" >> "$TEST_ENV_LOG"; done
  fi
}

start_service
exit $?
`;

// Copies node-red.init into the sandbox, rewriting the absolute prefixes it
// writes to (/srv, /data, /var/run) onto the sandbox so nothing under test
// ever touches the real filesystem paths a live gateway would use.
function buildSandboxInit(sandboxDir) {
  const original = fs.readFileSync(INIT_SOURCE, 'utf8');
  const rewritten = original
    .split('/srv/').join(sandboxDir + '/srv/')
    .split('/data/').join(sandboxDir + '/data/')
    .split('/var/run/').join(sandboxDir + '/var/run/');
  const initPath = path.join(sandboxDir, 'node-red.init');
  fs.writeFileSync(initPath, rewritten);
  return initPath;
}

// The harness always runs under /bin/sh. On this development host that
// resolves to bash, not the BusyBox ash node-red.init actually ships under
// on a gateway. Checked for a busybox/ash binary to also exercise the real
// target shell (see scripts/test-journal-v2-config.js:22 for the
// pre-existing precedent of using /bin/sh here); neither `busybox` nor
// `ash` is installed on this host, so this only runs under whichever shell
// /bin/sh resolves to. The init's own constructs (case, local, ${var%/*},
// command substitution, [ ] tests) are POSIX-portable and used identically
// elsewhere in this file's already-passing sibling
// scripts/test-journal-v2-config.js, so the real-shell risk is low, but it
// is not eliminated by this test.
function findAshLikeShell() {
  for (const candidate of ['busybox', 'ash']) {
    const probe = spawnSync('which', [candidate], { encoding: 'utf8' });
    if (probe.status === 0 && probe.stdout.trim()) return probe.stdout.trim();
  }
  return null;
}
const ASH_LIKE_SHELL = findAshLikeShell();

function runStartService(t, overrides = {}) {
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-init-'));
  t.after(() => {
    // Cleanup may need to reopen anything we deliberately locked down
    // before recursive removal works.
    try { fs.chmodSync(sandboxDir, 0o700); } catch (_) {}
    fs.rmSync(sandboxDir, { recursive: true, force: true });
  });
  const initPath = buildSandboxInit(sandboxDir);
  const harnessPath = path.join(sandboxDir, 'harness.sh');
  fs.writeFileSync(harnessPath, HARNESS_SCRIPT);
  const loggerLog = path.join(sandboxDir, 'logger.log');
  const callLog = path.join(sandboxDir, 'calls.log');
  const envLog = path.join(sandboxDir, 'env.log');
  fs.writeFileSync(loggerLog, '');
  fs.writeFileSync(callLog, '');
  fs.writeFileSync(envLog, '');

  const result = spawnSync('/bin/sh', [harnessPath], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      INIT_PATH: initPath,
      TEST_JOURNAL_MEDIA_ROOT: overrides.mediaRoot || '',
      TEST_JOURNAL_PHOTO_CACHE_BYTES: overrides.photoCacheBytes || '4294967296',
      TEST_JOURNAL_MIN_FREE_BYTES: overrides.minFreeBytes || '4294967296',
      TEST_LOGGER_LOG: loggerLog,
      TEST_CALL_LOG: callLog,
      TEST_ENV_LOG: envLog,
    }),
  });

  const loggerOutput = fs.readFileSync(loggerLog, 'utf8');
  const calls = fs.readFileSync(callLog, 'utf8').split('\n').filter(Boolean);
  const envLines = fs.readFileSync(envLog, 'utf8').split('\n').filter(Boolean);
  return { result, sandboxDir, loggerOutput, calls, envLines };
}

function envValue(envLines, key) {
  const prefix = key + '=';
  const line = envLines.find((entry) => entry.startsWith(prefix));
  return line === undefined ? undefined : line.slice(prefix.length);
}

function assertStaysUp(t, overrides, reasonToken) {
  const { result, loggerOutput, calls, envLines } = runStartService(t, overrides);
  assert.equal(result.status, 0, 'start_service() exit status: ' + result.stderr);
  assert.ok(calls.includes('open'), 'procd_open_instance was not reached: ' + calls.join(','));
  assert.doesNotMatch(loggerOutput, /refusing Node-RED startup/);
  // Pins the exact reason token this scenario must produce, not just "some
  // reason" -- a copy-paste error in journal_media_invalid_reason() (the
  // exact defect class finding 1 fixed) must fail this assertion by name.
  assert.match(
    loggerOutput,
    new RegExp("journal media root '.*' failed validation \\(reason=" + reasonToken + '\\)'),
    'expected reason=' + reasonToken + ' in: ' + loggerOutput,
  );
  assert.equal(envValue(envLines, 'JOURNAL_REPLICATION_DISABLE'), '1');
  assert.equal(envValue(envLines, 'JOURNAL_MEDIA_ROOT'), '', 'bogus media root leaked into the exported env');
}

// Every code/token pair below is independently reachable through
// start_service() from outside (no permission-bit tricks that root would
// bypass -- see the mkdir case), so each gets its own full-caller test.
// Code 9 (root_unresolvable) is deliberately excluded from this table: it
// guards a TOCTOU race between the preceding `-d`/`-L` checks and the
// `realpath` call on the line below them (the directory is real, passes
// `-d` and `-L`, then stops resolving before `realpath` runs) and cannot be
// constructed from static filesystem state -- reproducing it would require
// racing a rename/removal against the shell's own execution, which is not
// worth the flakiness it would add. Code 9's token is still pinned exactly
// like every other code by the direct-mapping test below.
test('start_service() stays up when media root is a symlink', (t) => {
  const real = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-real-'));
  const link = real + '-link';
  fs.symlinkSync(real, link, 'dir');
  t.after(() => { fs.rmSync(link, { force: true }); fs.rmSync(real, { recursive: true, force: true }); });
  assertStaysUp(t, { mediaRoot: link }, 'root_is_symlink');
});

test('start_service() stays up when media root cannot be created because its parent is not a directory (root-proof: mkdir fails structurally, not on a permission bit root would bypass)', (t) => {
  // A regular file cannot contain a subdirectory for anyone, including
  // uid 0 -- unlike a chmod-0500 parent, this is not a permission check
  // root's mkdir(2) override would sail through, so this scenario is
  // root-proof by construction rather than by detecting or skipping under
  // root. It still lands on the same `mkdir "$configured_root" || return 7`
  // line as a real read-only/full-parent failure would.
  const parentFile = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-parent-'));
  fs.rmSync(parentFile, { recursive: true, force: true });
  fs.writeFileSync(parentFile, '');
  t.after(() => fs.rmSync(parentFile, { force: true }));
  assertStaysUp(t, { mediaRoot: path.join(parentFile, 'journal-media') }, 'root_uncreatable');
});

test('start_service() stays up when journal byte limits are invalid', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-bytes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assertStaysUp(t, { mediaRoot: root, photoCacheBytes: '0' }, 'byte_limits_invalid');
});

test('start_service() stays up when the configured media root is not absolute', (t) => {
  assertStaysUp(t, { mediaRoot: 'relative/journal-media' }, 'root_not_absolute');
});

test('start_service() stays up when the configured media root is not an exact canonical spelling (trailing slash)', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-canon-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assertStaysUp(t, { mediaRoot: root + '/' }, 'root_not_canonical');
});

test("start_service() stays up when the media root's parent cannot be resolved", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-noparent-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  // GNU realpath tolerates exactly one missing trailing component (its
  // usual "resolve where a not-yet-created leaf will land" mode), so a
  // single missing directory here would realpath fine and instead fail at
  // mkdir (ENOENT, code 7) one level down -- not the parent-realpath path
  // this test targets. Two missing levels between an existing base and the
  // configured root's parent makes realpath itself fail on the parent.
  const missingParent = path.join(base, 'missing-1', 'missing-2');
  assertStaysUp(t, { mediaRoot: path.join(missingParent, 'journal-media') }, 'root_parent_unresolvable');
});

test('start_service() stays up when the configured media root exists but is not a directory', (t) => {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-notdir-')), 'journal-media');
  fs.writeFileSync(root, '');
  t.after(() => fs.rmSync(path.dirname(root), { recursive: true, force: true }));
  assertStaysUp(t, { mediaRoot: root }, 'root_not_a_directory');
});

test('start_service() keeps the journal worker enabled and exports the canonical root when validation succeeds', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-ok-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { result, loggerOutput, calls, envLines } = runStartService(t, { mediaRoot: root });

  assert.equal(result.status, 0, 'start_service() exit status: ' + result.stderr);
  assert.ok(calls.includes('open'), 'procd_open_instance was not reached: ' + calls.join(','));
  assert.doesNotMatch(loggerOutput, /failed validation/);
  assert.equal(envValue(envLines, 'JOURNAL_REPLICATION_DISABLE'), '0');
  assert.equal(envValue(envLines, 'JOURNAL_MEDIA_ROOT'), fs.realpathSync(root));
});

// Direct-mapping coverage: pins every code -> token pair in
// journal_media_invalid_reason(), including code 9 (root_unresolvable),
// which is not exercised through start_service() above (see the comment
// above the symlink test). This is what actually catches finding 1's
// defect class: a wrong or transposed token for any single code, reachable
// through start_service() or not.
test('journal_media_invalid_reason() maps every known code to its exact, distinct token', () => {
  const expected = {
    2: 'byte_limits_invalid',
    3: 'root_not_absolute',
    4: 'root_not_canonical',
    5: 'root_is_symlink',
    6: 'root_parent_unresolvable',
    7: 'root_uncreatable',
    8: 'root_not_a_directory',
    9: 'root_unresolvable',
    42: 'root_invalid', // unknown code falls back to the generic token
  };
  const tokens = new Set();
  for (const [code, token] of Object.entries(expected)) {
    const result = spawnSync('/bin/sh', [
      '-c',
      '. "$1"; journal_media_invalid_reason "$2"',
      'journal-reason-test', INIT_SOURCE, code,
    ], { encoding: 'utf8' });
    assert.equal(result.status, 0, 'code ' + code + ': ' + result.stderr);
    assert.equal(result.stdout.trim(), token, 'code ' + code + ' mapped to the wrong token');
    tokens.add(result.stdout.trim());
  }
  // Every known (non-fallback) code must map to a *distinct* token -- this
  // is exactly what would silently break if two branches were transposed.
  const knownTokenCount = Object.keys(expected).length - 1; // exclude the fallback case
  assert.equal(tokens.size - 1, knownTokenCount, 'two or more known codes collapsed onto the same token');
});

if (!ASH_LIKE_SHELL) {
  test('busybox/ash shell-parity note', () => {
    // Documented per review finding 5: neither `busybox` nor `ash` exists
    // on this host, so the harness above cannot also be run under the real
    // target shell here. Not faked -- left as a known gap.
    assert.ok(true, 'busybox/ash not found on this host; harness runs under /bin/sh only');
  });
}
