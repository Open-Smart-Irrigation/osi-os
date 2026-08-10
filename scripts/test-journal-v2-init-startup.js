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

function runStartService(t, overrides = {}) {
  const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-init-'));
  t.after(() => {
    // Cleanup may need to reopen anything we deliberately locked down
    // (e.g. the uncreatable-parent test) before recursive removal works.
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

for (const [label, makeRoot] of [
  ['media root is a symlink', (t) => {
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-real-'));
    const link = real + '-link';
    fs.symlinkSync(real, link, 'dir');
    t.after(() => { fs.rmSync(link, { force: true }); fs.rmSync(real, { recursive: true, force: true }); });
    return { mediaRoot: link };
  }],
  ['media root cannot be created (unwritable parent)', (t) => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-parent-'));
    fs.chmodSync(parent, 0o500);
    t.after(() => { fs.chmodSync(parent, 0o700); fs.rmSync(parent, { recursive: true, force: true }); });
    return { mediaRoot: path.join(parent, 'journal-media') };
  }],
]) {
  test('start_service() stays up when ' + label, (t) => {
    const overrides = makeRoot(t);
    const { result, loggerOutput, calls, envLines } = runStartService(t, overrides);

    assert.equal(result.status, 0, 'start_service() exit status: ' + result.stderr);
    assert.ok(calls.includes('open'), 'procd_open_instance was not reached: ' + calls.join(','));
    assert.match(loggerOutput, /journal media root '.*' failed validation \(reason=/);
    assert.doesNotMatch(loggerOutput, /refusing Node-RED startup/);
    assert.equal(envValue(envLines, 'JOURNAL_REPLICATION_DISABLE'), '1');
    assert.equal(envValue(envLines, 'JOURNAL_MEDIA_ROOT'), '', 'bogus media root leaked into the exported env');
  });
}

test('start_service() stays up when journal byte limits are invalid', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-journal-bytes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { result, loggerOutput, calls, envLines } = runStartService(t, {
    mediaRoot: root,
    photoCacheBytes: '0',
  });

  assert.equal(result.status, 0, 'start_service() exit status: ' + result.stderr);
  assert.ok(calls.includes('open'), 'procd_open_instance was not reached: ' + calls.join(','));
  assert.match(loggerOutput, /journal media root '.*' failed validation \(reason=byte_limits_invalid\)/);
  assert.doesNotMatch(loggerOutput, /refusing Node-RED startup/);
  assert.equal(envValue(envLines, 'JOURNAL_REPLICATION_DISABLE'), '1');
  assert.equal(envValue(envLines, 'JOURNAL_MEDIA_ROOT'), '');
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
