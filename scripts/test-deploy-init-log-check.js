'use strict';
// Behavioral proof for deploy.sh's judgement of a Node-RED start
// (check_node_red_start, used by the deploy's own health check and by the
// owed check of a retry).
//
// /gui answers as soon as Node-RED's HTTP listener binds, before the flows
// run, and the boot node can refuse its devices-CHECK rebuild and carry on
// (it logs "devices rebuild ABORTED"). So the check waits for the boot
// node's completion line as well as /gui (PR #242).
//
// The start's log lines are the lines after a marker the deploy writes with
// logger just before the start. logread's ring is 128 KiB and evicts, so a
// line count taken before the start can point past it, and the completion
// line of a healthy start can be missed. Not seen is not failed: only an
// observed failure (an error line of the start, the service not running,
// /gui not answering) fails the start. A healthy start whose completion line
// cannot be seen is "unverified"; it keeps running.
//
// The test runs deploy.sh's own shell text (between its markers) with a real
// POSIX shell. logger and logread are stubs over one log file; logread can
// return the whole log, nothing, the log with the start scrolled out, or the
// last lines of a full ring, or be absent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const DEPLOY = fs.readFileSync(path.join(REPO, 'deploy.sh'), 'utf8');

function fragment(name) {
  const begin = new RegExp(`^[ \\t]*# ${name} begin[ \\t]*$`, 'm').exec(DEPLOY);
  const end = new RegExp(`^[ \\t]*# ${name} end[ \\t]*$`, 'm').exec(DEPLOY);
  assert.ok(begin && end && end.index > begin.index, `deploy.sh is missing the "# ${name} begin/end" markers`);
  return DEPLOY.slice(DEPLOY.indexOf('\n', begin.index) + 1, end.index);
}

const made = [];
process.on('exit', () => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

// logread modes: whole | empty | rotated (the start scrolled out: only lines
// written after the start's last line) | ring (the last 3 lines) | absent.
function stubs(dir, logreadMode) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const write = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  write('sleep', 'exit 0');
  write('logger', 'shift 2; printf "Nov 12 12:00:00 gw osi-deploy: %s\\n" "$*" >> "$LOG"');
  write('wget', 'exit "${GUI_RC:-0}"');
  const reads = {
    whole: 'cat "$LOG"',
    empty: 'exit 0',
    rotated: 'printf "%s\\n" "Nov 12 12:05:00 gw kernel: later line"',
    ring: 'tail -n 3 "$LOG"',
  };
  if (logreadMode !== 'absent') write('logread', reads[logreadMode]);
  // Only the shell's own needs beside the stubs: no system logread or logger.
  for (const tool of ['cat', 'tail', 'awk', 'grep', 'head', 'printf']) {
    const found = ['/usr/bin', '/bin'].map((d) => path.join(d, tool)).find((f) => fs.existsSync(f));
    if (found && !fs.existsSync(path.join(bin, tool))) fs.symlinkSync(found, path.join(bin, tool));
  }
  return bin;
}

// The start's own lines, written to the log after the marker.
function startLines({ complete = true, failure = null, flood = 0, lateFailure = null }) {
  const lines = ['node-red[42]: Welcome to Node-RED'];
  for (let i = 0; i < flood; i += 1) lines.push(`node-red[42]: [info] flood line ${i}`);
  if (failure) lines.push(`node-red[42]: ${failure}`);
  if (complete) lines.push('node-red[42]: sync-init: schema init complete');
  if (lateFailure) lines.push(`node-red[42]: ${lateFailure}`);
  lines.push('node-red[42]: [info] Started flows');
  return lines.map((l) => `Nov 12 12:00:01 gw ${l}`).join('\n') + '\n';
}

// Runs the marker, the simulated start and the check. state: running |
// stopped | unreadable. Returns { verdict, reason, probe, stdout, stderr }.
function judge({ logread = 'whole', start = {}, state = 'running', gui = 0, before = '', block = 'check' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-start-check-'));
  made.push(dir);
  const log = path.join(dir, 'log');
  fs.writeFileSync(log, before);
  const startFile = path.join(dir, 'start');
  fs.writeFileSync(startFile, startLines(start));
  const run = block === 'check'
    ? 'check_node_red_start 6 2\nprintf "VERDICT=%s\\nREASON=%s\\n" "$NODE_RED_START_VERDICT" "$NODE_RED_START_REASON"'
    : `PROBE_OK=1\n${fragment('init log check')}\nprintf "VERDICT=%s\\nPROBE_OK=%s\\n" "$NODE_RED_START_VERDICT" "$PROBE_OK"`;
  const script = `set -eu
DEPLOY_STAMP=new
NODE_RED_LOG_MARK=""
node_red_service_state() {
  case "$NODE_STATE" in unreadable) return 1 ;; *) printf '%s\\n' "$NODE_STATE" ;; esac
}
${fragment('node-red health wait')}
${fragment('node-red start check')}
mark_node_red_log
cat "$START" >> "$LOG"
${run}
`;
  const result = spawnSync('/bin/sh', ['-c', script], {
    encoding: 'utf8',
    env: { PATH: stubs(dir, logread), LOG: log, START: startFile, NODE_STATE: state, GUI_RC: String(gui), NODE_RED_INIT_TIMEOUT: '6', NODE_RED_HEALTH_TIMEOUT: '2' },
  });
  assert.equal(result.status, 0, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  const get = (key) => ((new RegExp(`^${key}=(.*)$`, 'm').exec(result.stdout) || [])[1] || '').trim();
  return { verdict: get('VERDICT'), reason: get('REASON'), probe: get('PROBE_OK'), stdout: result.stdout, stderr: result.stderr };
}

test('a healthy start with its completion line after the marker is healthy', () => {
  const r = judge({});
  assert.equal(r.verdict, 'healthy', r.reason);
});

test('an abort from an earlier boot, before the marker, does not count', () => {
  const r = judge({ before: 'Nov 12 11:00:00 gw node-red[7]: devices rebuild ABORTED (devices left intact): old\n' });
  assert.equal(r.verdict, 'healthy', r.reason);
});

// The four logs of the ruling, each on a healthy start: none fails.
for (const [name, logread, start] of [
  ['an empty log', 'empty', {}],
  ['a rotated log with the start scrolled out', 'rotated', {}],
  ['a full ring that evicted the marker', 'ring', { flood: 40 }],
  ['no logread', 'absent', {}],
]) {
  test(`a healthy start with ${name} is unverified, never failed`, () => {
    const r = judge({ logread, start });
    assert.equal(r.verdict, 'unverified', r.reason);
    assert.match(r.reason, /no failure was observed/);
  });
}

// Before this change the check counted lines by position and failed closed
// on "not seen"; the ring case is the one Fable's blocker named.
test('a healthy start on a full ring is not judged by line position', () => {
  const r = judge({ logread: 'ring', start: { flood: 40 }, before: 'x\n'.repeat(200) });
  assert.notEqual(r.verdict, 'failed', r.reason);
});

// Observed failures: each of them fails the start.
for (const line of [
  'devices rebuild ABORTED (devices left intact): boom',
  '[red] Uncaught Exception:',
  '[error] Failed to start server:',
  '[warn] Error loading flows: Error: bad',
]) {
  test(`the start logging "${line}" fails it`, () => {
    const r = judge({ start: { failure: line, complete: false } });
    assert.equal(r.verdict, 'failed');
    assert.match(r.reason, /the start logged/);
  });
}

test('a failure line after the completion line still fails the start', () => {
  const r = judge({ start: { lateFailure: '[red] Uncaught Exception:' } });
  assert.equal(r.verdict, 'failed', r.reason);
});

test('the service not running fails the start, whatever the log shows', () => {
  for (const logread of ['whole', 'empty', 'absent']) {
    const r = judge({ logread, state: 'stopped', gui: 1 });
    assert.equal(r.verdict, 'failed', `${logread}: ${r.reason}`);
    assert.match(r.reason, /not running/);
  }
});

test('/gui not answering with the service running fails the start', () => {
  const r = judge({ gui: 1 });
  assert.equal(r.verdict, 'failed');
  assert.match(r.reason, /\/gui did not answer/);
});

test('an unreadable service state is not a failure: /gui decides', () => {
  assert.equal(judge({ state: 'unreadable' }).verdict, 'unverified');
  assert.equal(judge({ state: 'unreadable', gui: 1 }).verdict, 'failed');
});

test('the deploy maps the verdicts: healthy commits, unverified keeps running, failed rolls back', () => {
  assert.equal(judge({ block: 'deploy' }).probe, '0');
  assert.equal(judge({ block: 'deploy', logread: 'absent' }).probe, 'unverified');
  assert.equal(judge({ block: 'deploy', gui: 1 }).probe, '1');
});
