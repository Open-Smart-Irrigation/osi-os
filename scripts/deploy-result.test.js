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
      ['hold', 1, 'DEPLOY_HOLD_SERVICES=1', 1],
      ['hold', 1, 'identityd_deploy_state=fatal_hold', 1],
      ['refused', 0, '', 1],
      ['refused', 7, '', 7],
      ['failed', 1, 'PAYLOAD_FLIPPED=1', 1],
      ['failed', 1, 'DEPLOY_ACTIVATION_ATTEMPTED=1; PAYLOAD_FLIPPED=0', 1],
      ['hold', 1, 'DEPLOY_OUTCOME_HOLD=1', 1],
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
      assert.match(record, verdict === 'success' ? /^reason=.*health self-check passed/m : /^reason=.*fixture migration or health failure/m);
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
${outcome}
${lifecycle}
${early}
cleanup() { :; }
restore_identityd_prior_state() { :; }
hold_identityd_stopped() { :; }
hold_node_red_stopped() { :; }
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
