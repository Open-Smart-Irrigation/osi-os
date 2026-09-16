'use strict';
// Behavioral proof for deploy.sh's post-restart boot-node init log check
// (PR #242 verifier fix 2, YELLOW should-fix).
//
// The original single-shot check ran `logread | grep -q "devices rebuild
// ABORTED"` the instant the /gui reachability loop broke. /gui is served by
// Node-RED's static-file route as soon as the HTTP listener binds -- before
// flows finish deploying -- while sync-init-fn (the boot node that can log
// the abort, and now also logs a positive completion marker on success) is
// only triggered by an inject node with a 1s onceDelay and then runs a long
// async sqlite exec() sequence before it can reach either branch. The
// single immediate grep could observe neither line yet and would silently
// report PROBE_OK=0 (commit) regardless of what the boot node was about to
// decide.
//
// This test does not reimplement the poll's decision logic in JS. It
// extracts the ACTUAL shell fragment out of deploy.sh (between its own
// "# init log check begin/end" markers) and runs it with a real POSIX shell,
// stubbing only `logread` and `sleep` so the test is hermetic and fast
// (no real logread available in this environment, and no real waiting).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const DEPLOY = fs.readFileSync(path.join(REPO, 'deploy.sh'), 'utf8');

function extractInitLogCheckFragment() {
  const beginMatch = /^[ \t]*# init log check begin[ \t]*$/m.exec(DEPLOY);
  const endMatch = /^[ \t]*# init log check end[ \t]*$/m.exec(DEPLOY);
  assert.ok(beginMatch, 'deploy.sh is missing the "# init log check begin" marker');
  assert.ok(endMatch, 'deploy.sh is missing the "# init log check end" marker');
  assert.ok(endMatch.index > beginMatch.index, 'the init log check begin marker must precede its end marker');
  const fragmentStart = DEPLOY.indexOf('\n', beginMatch.index) + 1;
  return DEPLOY.slice(fragmentStart, endMatch.index);
}

// Builds a stub bin/ directory containing fake `logread` and `sleep`
// executables and returns its path. `sleep` is a no-op so the test runs
// instantly regardless of NODE_RED_INIT_TIMEOUT. `logread` counts its own
// invocations (via LOGREAD_CALL_COUNTER_FILE) and, on the call number named
// by LOGREAD_MARKER_AT_CALL / LOGREAD_ABORT_AT_CALL, emits the matching
// line -- otherwise it emits an unrelated log line, exactly like a real
// logread ring buffer would between the mark and the line of interest.
function buildStubBinDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-init-log-check-'));
  fs.writeFileSync(
    path.join(dir, 'sleep'),
    '#!/bin/sh\nexit 0\n',
    { mode: 0o755 }
  );
  fs.writeFileSync(
    path.join(dir, 'logread'),
    [
      '#!/bin/sh',
      'n=0',
      '[ -f "$LOGREAD_CALL_COUNTER_FILE" ] && n="$(cat "$LOGREAD_CALL_COUNTER_FILE")"',
      'n=$((n + 1))',
      'echo "$n" > "$LOGREAD_CALL_COUNTER_FILE"',
      'if [ -n "$LOGREAD_MARKER_AT_CALL" ] && [ "$n" = "$LOGREAD_MARKER_AT_CALL" ]; then',
      '    echo "Sep 16 00:00:00 gw node-red[1]: sync-init: schema init complete"',
      'elif [ -n "$LOGREAD_ABORT_AT_CALL" ] && [ "$n" = "$LOGREAD_ABORT_AT_CALL" ]; then',
      '    echo "Sep 16 00:00:00 gw node-red[1]: devices rebuild ABORTED (devices left intact): boom"',
      'else',
      '    echo "Sep 16 00:00:00 gw node-red[1]: unrelated log line"',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  return dir;
}

// Runs the extracted fragment with PROBE_OK=0 and NODE_RED_LOG_MARK=0
// pre-set, the stub bin/ directory prepended to PATH, and the given
// scenario env vars. Returns { probeOk, stdout, stderr }.
function runFragment(scenarioEnv) {
  const fragment = extractInitLogCheckFragment();
  const stubDir = buildStubBinDir();
  const counterFile = path.join(stubDir, 'call-counter');
  const script = `PROBE_OK=0\nNODE_RED_LOG_MARK=0\n${fragment}\nprintf 'PROBE_OK=%s\\n' "$PROBE_OK"\n`;
  const result = spawnSync('sh', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      LOGREAD_CALL_COUNTER_FILE: counterFile,
      LOGREAD_MARKER_AT_CALL: '',
      LOGREAD_ABORT_AT_CALL: '',
      ...scenarioEnv,
    },
  });
  assert.equal(result.status, 0, `init log check fragment exited nonzero (${result.status}): stderr=${result.stderr}`);
  const match = /PROBE_OK=(.*)/.exec(result.stdout);
  assert.ok(match, `init log check fragment did not print PROBE_OK: stdout=${JSON.stringify(result.stdout)}`);
  return { probeOk: match[1].trim(), stdout: result.stdout, stderr: result.stderr };
}

test('init log check: positive completion marker observed at t=6s keeps the payload healthy', () => {
  // 2s poll step, 4th logread call lands at elapsed=6s (calls at 0/2/4/6).
  const { probeOk, stdout } = runFragment({
    NODE_RED_INIT_TIMEOUT: '8',
    LOGREAD_MARKER_AT_CALL: '4',
  });
  assert.equal(probeOk, '0', 'PROBE_OK must stay 0 (healthy) once the positive completion marker is observed');
  assert.match(stdout, /OK: boot node confirmed 'sync-init: schema init complete' after 6s/, 'must report the elapsed time at which the marker was observed');
});

test('init log check: "devices rebuild ABORTED" observed at t=6s fails the probe (Uganda cascade-delete guard)', () => {
  const { probeOk, stderr } = runFragment({
    NODE_RED_INIT_TIMEOUT: '8',
    LOGREAD_ABORT_AT_CALL: '4',
  });
  assert.equal(probeOk, '1', 'PROBE_OK must flip to 1 (unhealthy) when the boot node logs an aborted rebuild');
  assert.match(stderr, /ALERT:.*devices rebuild ABORTED/, 'must print the ALERT line naming the abort');
});

test('init log check: neither line observed within the timeout fails closed (does not commit an unconfirmed boot)', () => {
  // NODE_RED_INIT_TIMEOUT=6 -> exactly 3 logread calls (elapsed 0/2/4), all
  // returning the unrelated line; the loop exits before a 4th check at t=6.
  const { probeOk, stderr } = runFragment({
    NODE_RED_INIT_TIMEOUT: '6',
  });
  assert.equal(probeOk, '1', 'PROBE_OK must fail closed to 1 when the window elapses with no confirmation either way');
  assert.match(stderr, /WARN:.*schema initialization could not be confirmed/, 'must print a WARN explaining the unconfirmed boot, distinct from the ALERT/abort case');
});

test('init log check: an already-unhealthy probe (PROBE_OK=1 from the /gui reachability loop) is left alone', () => {
  const fragment = extractInitLogCheckFragment();
  const stubDir = buildStubBinDir();
  const counterFile = path.join(stubDir, 'call-counter');
  const script = `PROBE_OK=1\nNODE_RED_LOG_MARK=0\n${fragment}\nprintf 'PROBE_OK=%s\\n' "$PROBE_OK"\n`;
  const result = spawnSync('sh', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${stubDir}:${process.env.PATH}`,
      LOGREAD_CALL_COUNTER_FILE: counterFile,
      LOGREAD_MARKER_AT_CALL: '',
      LOGREAD_ABORT_AT_CALL: '',
      NODE_RED_INIT_TIMEOUT: '6',
    },
  });
  assert.equal(result.status, 0);
  const match = /PROBE_OK=(.*)/.exec(result.stdout);
  assert.equal(match && match[1].trim(), '1', 'the poll must not run (and must not flip PROBE_OK back to 0) when /gui was never reachable in the first place');
  assert.ok(!fs.existsSync(counterFile), 'logread must never be invoked when PROBE_OK is already 1 entering this block');
});
