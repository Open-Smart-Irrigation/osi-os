'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const deploy = fs.readFileSync(path.join(__dirname, '../deploy.sh'), 'utf8');

test('deploy reports the final lifecycle verdict, including rollback and an unverified start', () => {
  const begin = deploy.indexOf('# deploy outcome begin\n');
  const end = deploy.indexOf('# deploy outcome end', begin);
  assert.ok(begin >= 0 && end > begin, 'structured deploy outcome function is present');
  const block = deploy.slice(begin, end);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-result-'));
  try {
    const cases = [
      ['success', 0, 'DEPLOY_COMPLETED=1; PROBE_OK=0', 0],
      ['unverified', 0, 'DEPLOY_COMPLETED=1; PROBE_OK=unverified', 3],
      ['auto-rollback', 1, 'ROLLBACK_RESTORED=1', 1],
      ['hold', 1, 'DEPLOY_HOLD_SERVICES=1; DEPLOY_SERVICE_STATE=stopped; DEPLOY_IDENTITYD_STATE=stopped', 1],
      ['hold', 1, 'identityd_deploy_state=fatal_hold; DEPLOY_SERVICE_STATE=stopped; DEPLOY_IDENTITYD_STATE=stopped', 1],
      ['refused', 0, '', 1],
      ['refused', 7, '', 7],
      ['failed', 1, 'PAYLOAD_FLIPPED=1', 1],
      ['failed', 1, 'DEPLOY_ACTIVATION_ATTEMPTED=1; PAYLOAD_FLIPPED=0', 1],
      ['hold', 1, 'DEPLOY_OUTCOME_HOLD=1; DEPLOY_SERVICE_STATE=stopped; DEPLOY_IDENTITYD_STATE=stopped', 1],
      ['incomplete-recovery', 1, 'DEPLOY_RECOVERY_INCOMPLETE=1; DEPLOY_SERVICE_STATE=stopped', 1],
    ];
    for (const [verdict, status, setup, expectedCode] of cases) {
      const result = path.join(dir, 'result');
      const run = spawnSync('sh', ['-c', `${block}\nDEPLOY_STAMP=candidate\nNODE_RED_START_REASON='fixture migration or health failure'\n${setup}\nwrite_deploy_outcome ${status}`], {
        encoding: 'utf8', env: { ...process.env, DEPLOY_OUTCOME_FILE: result, SWAP_ROOT: dir },
      });
      assert.equal(run.status, 0, run.stderr);
      const record = fs.readFileSync(result, 'utf8');
      assert.match(record, new RegExp(`^verdict=${verdict}$`, 'm'));
      assert.match(record, new RegExp(`^exit_code=${expectedCode}$`, 'm'));
      assert.match(record, /^deploy_exit_code=\d+$/m);
      assert.match(record, /^payload_stamp=candidate$/m);
      assert.match(record, /^reason_code=[a-z_]+$/m);
      assert.doesNotMatch(record, /fixture migration or health failure/);
      assert.equal(fs.statSync(result).mode & 0o777, 0o600);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('the real exit handler publishes after migration recovery and the early trap publishes refusal', () => {
  const outcome = deploy.slice(deploy.indexOf('# deploy outcome begin'), deploy.indexOf('# deploy outcome end'));
  const lifecycle = deploy.slice(deploy.indexOf('# identityd deploy lifecycle begin'), deploy.indexOf('# identityd deploy lifecycle end'));
  const early = deploy.slice(deploy.indexOf('early_deploy_exit() {'), deploy.indexOf('\ncleanup() {'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-exit-result-'));
  try {
    for (const [verdict, setup, invoke] of [
      ['auto-rollback', 'DB_MIGRATION_COMMITTED=1; restart_previous_payload() { ROLLBACK_RESTORED=1; }', 'deploy_exit_handler 1'],
      ['hold', 'DB_MIGRATION_COMMITTED=1; restart_previous_payload() { return 1; }', 'deploy_exit_handler 1'],
      ['refused', '', 'early_deploy_exit 7'],
    ]) {
      const result = path.join(dir, 'result');
      const script = `set -eu
DB_PATH='${path.join(dir, 'farming.db')}'
${outcome}
${lifecycle}
${early}
cleanup() { :; }
restore_identityd_prior_state() { :; }
hold_identityd_stopped() { DEPLOY_IDENTITYD_STATE=stopped; }
hold_node_red_stopped() { DEPLOY_SERVICE_STATE=stopped; }
record_deploy_hold() { :; }
swap_call() { :; }
PREV_STAMP=old
DEPLOY_STAMP=candidate
${setup}
${invoke}
`;
      const run = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, SWAP_ROOT: dir, DEPLOY_OUTCOME_FILE: result } });
      assert.equal(run.status, verdict === 'refused' ? 7 : 1, run.stderr);
      assert.match(fs.readFileSync(result, 'utf8'), new RegExp(`^verdict=${verdict}$`, 'm'));
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('native receipt excludes synthetic sensitive reasons and log diagnostics', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-native-privacy-'));
  try {
    const result = path.join(dir, 'result');
    const log = path.join(dir, 'deploy.log');
    const sensitive = '0016C001F1000001 https://user:password@example.invalid/private';
    fs.writeFileSync(log, `ERROR: ${sensitive}\n`);
    const block = deploy.slice(deploy.indexOf('# deploy outcome begin'), deploy.indexOf('# deploy outcome end'));
    const run = spawnSync('sh', ['-c', `${block}\nDEPLOY_HOLD_SERVICES=1; DEPLOY_SERVICE_STATE=stopped; DEPLOY_IDENTITYD_STATE=stopped\nNODE_RED_START_REASON='${sensitive}'\nwrite_deploy_outcome 1`], { encoding: 'utf8', env: { ...process.env, SWAP_ROOT: dir, DEPLOY_LOGFILE: log, DEPLOY_OUTCOME_FILE: result } });
    assert.equal(run.status, 0, run.stderr);
    const receipt = fs.readFileSync(result, 'utf8');
    assert.doesNotMatch(receipt, /0016C001F1000001|password|https:/);
    assert.match(receipt, /^reason_code=services_held$/m);
    assert.equal(fs.statSync(result).mode & 0o777, 0o600);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const signal of ['TERM', 'HUP']) for (const failure of ['identityd', 'stop', 'published-boot']) {
  test(`${signal} through the real EXIT handler reports ${failure} from completed recovery attempts`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-recovery-proof-'));
    try {
      const result = path.join(dir, 'result');
      const outcome = deploy.slice(deploy.indexOf('# deploy outcome begin'), deploy.indexOf('# deploy outcome end'));
      const lifecycle = deploy.slice(deploy.indexOf('# identityd deploy lifecycle begin'), deploy.indexOf('# identityd deploy lifecycle end'));
      const payload = deploy.slice(deploy.indexOf('# deploy payload lifecycle begin'), deploy.indexOf('# deploy payload lifecycle end'));
      const publisher = deploy.slice(deploy.indexOf('publish_boot_file() {'), deploy.indexOf('\npublish_bootstrap_receipt()'));
      const init = path.join(dir, 'init'); fs.writeFileSync(init, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const stage = path.join(dir, 'staged.js'); fs.writeFileSync(stage, 'module.exports = true;\n');
      const setup = failure === 'identityd' ? `DB_MIGRATION_COMMITTED=1
restart_previous_payload() { ROLLBACK_RESTORED=1; DEPLOY_SERVICE_STATE=running; }
identityd_deploy_state=restore_running
wait_for_identityd_ready() { return 1; }` : failure === 'stop' ? `DB_MIGRATION_COMMITTED=1
restart_previous_payload() { return 1; }
wait_for_node_red_stop() { return 1; }` : `DB_MIGRATION_COMMITTED=0
PAYLOAD_FLIPPED=0
publish_boot_file '${stage}' '${path.join(dir, 'live.js')}' 644`;
      const script = `set -eu
SWAP_ROOT='${dir}'
DB_PATH='${path.join(dir, 'farming.db')}'
${outcome}
${lifecycle}
${payload}
${publisher}
cleanup() { :; }
swap_call() { :; }
record_deploy_hold() { DEPLOY_OUTCOME_HOLD=1; }
restart_node_red() { return 0; }
quiesce_identityd_instance() { return 0; }
identityd_service() { return 1; }
NODE_RED_INIT='${init}'
PREV_STAMP=old
DEPLOY_STAMP=candidate
PAYLOAD_FLIPPED=1
node_red_restart_needed=0
${setup}
install_deploy_exit_trap
kill -${signal} "$$"
exit 99
`;
      const run = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, DEPLOY_OUTCOME_FILE: result } });
      assert.equal(run.status, signal === 'TERM' ? 143 : 129, run.stderr);
      const record = fs.readFileSync(result, 'utf8');
      assert.match(record, new RegExp(`^verdict=${failure === 'published-boot' ? 'failed' : 'incomplete-recovery'}$`, 'm'));
      if (failure === 'identityd') { assert.match(record, /^service_state=running$/m); assert.match(record, /^identityd_state=unknown$/m); }
      if (failure === 'stop') { assert.match(record, /^service_state=unknown$/m); assert.match(record, /^identityd_state=stopped$/m); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('a successful final identityd restore supersedes an earlier failed attempt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-final-restore-'));
  try {
    const outcome = deploy.slice(deploy.indexOf('# deploy outcome begin'), deploy.indexOf('# deploy outcome end'));
    const lifecycle = deploy.slice(deploy.indexOf('# identityd deploy lifecycle begin'), deploy.indexOf('# identityd deploy lifecycle end'));
    const result = path.join(dir, 'result');
    const script = `set -eu
DB_PATH='${path.join(dir, 'farming.db')}'
${outcome}
${lifecycle}
cleanup() { :; }
restore_count=0
restore_identityd_prior_state() { restore_count=$((restore_count + 1)); [ "$restore_count" -gt 1 ] || return 1; DEPLOY_IDENTITYD_STATE=running; }
ROLLBACK_RESTORED=1
DEPLOY_SERVICE_STATE=running
DEPLOY_STAMP=attempt
PREV_STAMP=old
deploy_exit_handler 1
`;
    const run = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, SWAP_ROOT: dir, DEPLOY_OUTCOME_FILE: result } });
    assert.equal(run.status, 1, run.stderr);
    const receipt = fs.readFileSync(result, 'utf8');
    assert.match(receipt, /^verdict=auto-rollback$/m);
    assert.match(receipt, /^identityd_state=running$/m);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// Merge with main's EB19 writer hold: the exit handler's recovery-hold branch
// must publish a receipt too, `hold` with both stops proven at the hold.
for (const [status, waitResult, verdict] of [[0, 0, 'hold'], [1, 0, 'hold'], [0, 1, 'incomplete-recovery']]) {
  test(`a recovery hold through the real exit handler (status ${status}, stop proof ${waitResult ? 'fails' : 'holds'}) reports ${verdict}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-recovery-hold-'));
    try {
      const result = path.join(dir, 'result');
      const db = path.join(dir, 'farming.db');
      fs.writeFileSync(`${db}.osi-recovery`, '');
      const fn = name => { const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm').exec(deploy); assert.ok(m, name); return m[0]; };
      const outcome = deploy.slice(deploy.indexOf('# deploy outcome begin'), deploy.indexOf('# deploy outcome end'));
      const lifecycle = deploy.slice(deploy.indexOf('# identityd deploy lifecycle begin'), deploy.indexOf('# identityd deploy lifecycle end'));
      const payload = deploy.slice(deploy.indexOf('# deploy payload lifecycle begin'), deploy.indexOf('# deploy payload lifecycle end'));
      const init = path.join(dir, 'init'); fs.writeFileSync(init, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const script = `set -eu
DB_PATH='${db}'
SWAP_ROOT='${dir}'
NODE_RED_INIT='${init}'
${outcome}
${fn('recovery_hold_present')}
${lifecycle}
${payload}
cleanup() { :; }
swap_call() { :; }
wait_for_node_red_stop() { return ${waitResult}; }
quiesce_identityd_instance() { return 0; }
DEPLOY_STAMP=candidate
DEPLOY_COMPLETED=1
PROBE_OK=0
DEPLOY_SERVICE_STATE=running
DEPLOY_IDENTITYD_STATE=running
deploy_exit_handler ${status}
`;
      const run = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, DEPLOY_OUTCOME_FILE: result } });
      assert.equal(run.status, status, run.stderr);
      const record = fs.readFileSync(result, 'utf8');
      assert.match(record, new RegExp(`^verdict=${verdict}$`, 'm'), run.stderr);
      assert.match(record, /^exit_code=1$/m);
      if (verdict === 'hold') { assert.match(record, /^service_state=stopped$/m); assert.match(record, /^identityd_state=stopped$/m); }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

// PR #706 review (owed health check): a failed return to the retained
// fallback after the owed check stopped Node-RED or switched the payload is
// an incomplete recovery, never a refusal before activation.
for (const [failure, verdict] of [['flip', 'incomplete-recovery'], ['verify', 'incomplete-recovery'], ['restart', 'incomplete-recovery'], ['stop', 'incomplete-recovery'], ['none', 'refused']]) {
  test(`owed health check fallback with ${failure} failure reports ${verdict}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-owed-fallback-'));
    try {
      const result = path.join(dir, 'result');
      const fn = name => { const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm').exec(deploy); assert.ok(m, name); return m[0]; };
      const outcome = deploy.slice(deploy.indexOf('# deploy outcome begin'), deploy.indexOf('# deploy outcome end'));
      const payload = deploy.slice(deploy.indexOf('# deploy payload lifecycle begin'), deploy.indexOf('# deploy payload lifecycle end'));
      const owed = deploy.slice(deploy.indexOf('# owed health check begin'), deploy.indexOf('# owed health check end'));
      assert.match(owed, /run_owed_health_check/);
      const init = path.join(dir, 'init'); fs.writeFileSync(init, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const script = `set -eu
DB_PATH='${path.join(dir, 'farming.db')}'
SWAP_ROOT='${dir}'
GUI_ROOT='${path.join(dir, 'gui')}'
NODE_RED_INIT='${init}'
${outcome}
${fn('early_deploy_exit')}
${payload}
cleanup() { :; }
recovery_hold_present() { return 1; }
schema_compatibility_metadata() { echo '83|main'; }
run_owed_health_check() { NODE_RED_START_VERDICT=failed; NODE_RED_START_REASON=fixture; return 1; }
wait_for_node_red_stop() { [ '${failure}' != stop ]; }
swap_call() {
    case "$1" in
        owedCheckPlan) echo 'owed|0|fallback|restore' ;;
        flipTo) [ '${failure}' != flip ] ;;
        verifyPair) [ '${failure}' != verify ] ;;
        *) : ;;
    esac
}
repair_health_start() { [ '${failure}' != restart ]; }
DEPLOY_STAMP=candidate
trap 'early_deploy_exit $?' EXIT
${owed}
# A later refusal, before anything else changes.
exit 7
`;
      const run = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, DEPLOY_OUTCOME_FILE: result } });
      assert.equal(run.status, failure === 'none' ? 7 : 1, run.stderr);
      const record = fs.readFileSync(result, 'utf8');
      assert.match(record, new RegExp(`^verdict=${verdict}$`, 'm'), run.stderr + record);
      if (verdict !== 'refused') assert.match(record, /^reason_code=recovery_incomplete$/m);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

// CodeRabbit review: with a held health start, the stop proofs run before
// the receipt is written, and cleanup does not repeat them afterwards.
for (const exitPath of ['recovery-hold', 'early-exit']) for (const quiesceOk of [true, false]) {
  test(`${exitPath} with a held health start publishes the receipt after its only stop proofs (identityd proof ${quiesceOk ? 'holds' : 'fails'})`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-held-proof-order-'));
    try {
      const result = path.join(dir, 'result');
      const db = path.join(dir, 'farming.db');
      if (exitPath === 'recovery-hold') fs.writeFileSync(`${db}.osi-recovery`, '');
      const fn = name => { const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n`, 'm').exec(deploy); assert.ok(m, name); return m[0]; };
      const outcome = deploy.slice(deploy.indexOf('# deploy outcome begin'), deploy.indexOf('# deploy outcome end'));
      const lifecycle = deploy.slice(deploy.indexOf('# identityd deploy lifecycle begin'), deploy.indexOf('# identityd deploy lifecycle end'));
      const payload = deploy.slice(deploy.indexOf('# deploy payload lifecycle begin'), deploy.indexOf('# deploy payload lifecycle end'));
      const proofs = path.join(dir, 'proofs');
      const init = path.join(dir, 'init'); fs.writeFileSync(init, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      const script = `set -eu
DB_PATH='${db}'
SWAP_ROOT='${dir}'
NODE_RED_INIT='${init}'
TMP_DIR='${path.join(dir, 'tmp')}'
COMMAND_LEDGER_STAGE='${path.join(dir, 'stage')}'
${outcome}
${fn('recovery_hold_present')}
${lifecycle}
${payload}
${fn('early_deploy_exit')}
${fn('cleanup')}
release_deploy_lock() { :; }
swap_call() { :; }
# The first proof of each service passes; a repeat would fail.
wait_for_node_red_stop() { echo node-red >> '${proofs}'; [ "$(grep -c node-red '${proofs}')" = 1 ]; }
quiesce_identityd_instance() { echo identityd >> '${proofs}'; [ ${quiesceOk ? 1 : 0} = 1 ] && [ "$(grep -c identityd '${proofs}')" = 1 ]; }
HELD_HEALTH_STARTED=1
DEPLOY_STAMP=candidate
${exitPath === 'recovery-hold' ? 'deploy_exit_handler 1' : 'trap \'early_deploy_exit $?\' EXIT\nexit 7'}
`;
      const run = spawnSync('sh', ['-c', script], { encoding: 'utf8', env: { ...process.env, DEPLOY_OUTCOME_FILE: result } });
      assert.equal(run.status, exitPath === 'recovery-hold' ? 1 : 7, run.stderr);
      assert.deepEqual(fs.readFileSync(proofs, 'utf8').trim().split('\n'), ['node-red', 'identityd'], 'each proof runs once');
      const record = fs.readFileSync(result, 'utf8');
      const verdict = !quiesceOk ? 'incomplete-recovery' : exitPath === 'recovery-hold' ? 'hold' : 'refused';
      assert.match(record, new RegExp(`^verdict=${verdict}$`, 'm'), run.stderr + record);
      assert.match(record, new RegExp(`^identityd_state=${quiesceOk ? 'stopped' : 'unknown'}$`, 'm'));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
