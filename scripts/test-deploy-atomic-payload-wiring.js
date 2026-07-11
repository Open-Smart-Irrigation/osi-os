#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const deploy = fs.readFileSync(path.resolve(__dirname, '..', 'deploy.sh'), 'utf8');

function indexOf(needle) {
  const idx = deploy.indexOf(needle);
  assert.notEqual(idx, -1, `missing deploy.sh snippet: ${needle}`);
  return idx;
}

test('deploy.sh fetches the tested payload-swap module and verifies same-filesystem atomicity', () => {
  assert.match(deploy, /PAYLOADS_ROOT="\/srv\/node-red\/payloads"/);
  assert.match(deploy, /SWAP_JS="\$TMP_DIR\/deploy-payload-swap\.js"/);
  assert.match(deploy, /fetch "scripts\/deploy-payload-swap\.js" "\$SWAP_JS"/);
  assert.match(deploy, /same_fs_or_die\(\)/);
  assert.match(deploy, /stat -c %d \/srv\/node-red/);
  assert.match(deploy, /stat -c %d "\$PAYLOADS_ROOT"/);
});

test('deploy.sh stages flows before migration and flips only after migration succeeds', () => {
  const stageIdx = indexOf('swap_call stagePayload "$DEPLOY_STAMP" "$STAGED_FLOWS"');
  const migrationIdx = indexOf('run_schema_migration || exit 1');
  const flipIdx = indexOf('swap_call flipTo "$DEPLOY_STAMP"');

  assert.ok(stageIdx < migrationIdx, 'flows payload must be staged before schema migration');
  assert.ok(migrationIdx < flipIdx, 'flows symlink must flip only after schema migration succeeds');
  assert.doesNotMatch(
    deploy,
    /fetch_required "flows\.json"[\s\S]*"\/srv\/node-red\/flows\.json"/,
    'deploy must not write flows.json in place'
  );
});

test('deploy.sh captures the previous payload before flip and rolls back to it on failed local self-check', () => {
  const prevIdx = indexOf('PREV_STAMP="$(swap_call currentStamp || true)"');
  const flipIdx = indexOf('swap_call flipTo "$DEPLOY_STAMP"');
  const rollbackIdx = indexOf('swap_call flipTo "$PREV_STAMP"');
  const restartIdx = deploy.indexOf('/etc/init.d/node-red restart || true', rollbackIdx);

  assert.ok(prevIdx < flipIdx, 'previous payload must be captured before the new flip');
  assert.ok(flipIdx < rollbackIdx, 'rollback must happen only after the new payload was tried');
  assert.notEqual(restartIdx, -1, 'rollback must restart Node-RED after flipping back');
  assert.match(deploy, /AUTO-ROLLING-BACK the flows payload/);
  assert.match(deploy, /committed DB migration is NOT auto-undone/);
});

test('deploy.sh uses a local self-check on the Pi and leaves cloud canary gate to the operator', () => {
  assert.match(deploy, /pgrep -f 'node-red'/);
  assert.match(deploy, /http:\/\/127\.0\.0\.1:1880\/gui/);
  assert.match(deploy, /local health self-check PASSED/);
  assert.match(deploy, /deploy-canary-gate\.js from your operator machine/);
  assert.doesNotMatch(deploy, /OSI_ADMIN_TOKEN/, 'gateway deploy must not require cloud admin credentials');
});

test('deploy.sh prunes retained payloads only after the flipped payload passes the local self-check', () => {
  const passIdx = indexOf('if [ "$PROBE_OK" = "0" ]; then');
  const pruneIdx = indexOf('swap_call prunePayloads "$PAYLOAD_KEEP_N"');
  const rollbackIdx = indexOf('swap_call flipTo "$PREV_STAMP"');

  assert.ok(passIdx < pruneIdx, 'prune must be inside the passing post-check branch');
  assert.ok(pruneIdx < rollbackIdx, 'rollback branch must still have the retained previous payload');
});
