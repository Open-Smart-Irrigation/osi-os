'use strict';

// Lifecycle fixtures exercise the deploy wrapper's real swap_call status path.
// They keep the payload root temporary and use schema head/ledger metadata to
// model the database compatibility proof used before a restart.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const swap = require('./deploy-payload-swap');

const REPO = path.resolve(__dirname, '..');
const DEPLOY = fs.readFileSync(path.join(REPO, 'deploy.sh'), 'utf8');
const SWAP_JS = path.join(REPO, 'scripts', 'deploy-payload-swap.js');

function swapCallFunction() {
  const start = DEPLOY.indexOf('swap_call() {');
  const end = DEPLOY.indexOf('\n}\n\nrun_communication_preflight', start) + 3;
  assert.ok(start >= 0 && end > start, 'deploy.sh swap_call function must remain extractable');
  return DEPLOY.slice(start, end);
}

function fragment(begin, end) {
  const start = DEPLOY.indexOf(begin);
  const finish = DEPLOY.indexOf(end, start);
  assert.ok(start >= 0 && finish > start, `deploy.sh lifecycle markers missing: ${begin} -> ${end}`);
  return DEPLOY.slice(start + begin.length, finish);
}

function nodePathForShell() {
  return process.execPath.replace(/'/g, "'\\''");
}

function runSwap(root, command) {
  const script = `set -eu\nSWAP_ROOT=${JSON.stringify(root)}\nSWAP_JS=${JSON.stringify(SWAP_JS)}\nexport SWAP_ROOT SWAP_JS\n${swapCallFunction()}\n${command}\n`;
  return spawnSync('sh', ['-c', script], { encoding: 'utf8' });
}

function integratedLifecycleScript(root, dbPath, guiRoot) {
  const identity = fragment('# identityd deploy lifecycle begin\n', '# identityd deploy lifecycle end');
  const payload = fragment('# deploy payload lifecycle begin\n', '# deploy payload lifecycle end');
  return `set -eu
SWAP_ROOT=${JSON.stringify(root)}
SWAP_JS=${JSON.stringify(SWAP_JS)}
DB_PATH=${JSON.stringify(dbPath)}
GUI_ROOT=${JSON.stringify(guiRoot)}
TMP_DIR=${JSON.stringify(root)}
migrations_dir=${JSON.stringify(path.join(REPO, 'database/migrations/ordered'))}
NODE_RED_INIT=:
IDENTITYD_LOCK_PATH=${JSON.stringify(path.join(root, 'identityd.lock'))}
SERVICE_STATE_FILE=${JSON.stringify(path.join(root, 'identityd.state'))}
RESTART_LOG=${JSON.stringify(path.join(root, 'restart.log'))}
export SWAP_ROOT SWAP_JS
${swapCallFunction()}
${identity}
${payload}
cleanup() { :; }
restart_node_red() { printf '%s\\n' restart >> "$RESTART_LOG"; return 0; }
node_red_service_state() { echo stopped; }
wait_for_node_red_stop() { return 0; }
identityd_service() {
  case "$1" in
    running) [ "$(cat "$SERVICE_STATE_FILE" 2>/dev/null || echo 0)" = 1 ] ;;
    stop) echo 0 > "$SERVICE_STATE_FILE"; rm -f "$IDENTITYD_LOCK_PATH" ;;
    start) echo 1 > "$SERVICE_STATE_FILE" ;;
    ready) [ "$(cat "$SERVICE_STATE_FILE")" = 1 ] ;;
    *) return 0 ;;
  esac
}
identityd_sleep() { :; }
echo 1 > "$SERVICE_STATE_FILE"
sqlite3 "$DB_PATH" "CREATE TABLE schema_migrations(version INTEGER, checksum TEXT, status TEXT); INSERT INTO schema_migrations VALUES (12, 'old', 'applied');"
mkdir -p ${JSON.stringify(path.join(root, 'src-gui'))}
printf '%s\\n' first > ${JSON.stringify(path.join(root, 'source-flows.json'))}
printf '%s\\n' first > ${JSON.stringify(path.join(root, 'src-gui', 'index.html'))}
swap_call stagePayload first ${JSON.stringify(path.join(root, 'source-flows.json'))} ${JSON.stringify(path.join(root, 'src-gui'))} >/dev/null
swap_call writeCompatibility first 12 12:old >/dev/null
swap_call flipTo first "$GUI_ROOT" >/dev/null
swap_call verifyPair first "$GUI_ROOT" >/dev/null
verify_payload_db_compatibility first
sqlite3 "$DB_PATH" "INSERT INTO schema_migrations VALUES (13, 'new', 'applied');"
if write_payload_compatibility first; then exit 41; fi
if verify_payload_db_compatibility first; then exit 42; fi
quiesce_identityd_for_deploy
PREV_STAMP=first
DEPLOY_STAMP=retry
DB_MIGRATION_COMMITTED=1
node_red_restart_needed=1
if (deploy_exit_handler 23); then exit 43; else rc=$?; fi
[ "$rc" = 23 ]
[ "$(cat "$SERVICE_STATE_FILE")" = 0 ]
DB_MIGRATION_COMMITTED=0
DEPLOY_STAMP=retry-again
node_red_restart_needed=1
if (deploy_exit_handler 17); then exit 44; else rc=$?; fi
[ "$rc" = 17 ]
[ "$(cat "$SERVICE_STATE_FILE")" = 0 ]
[ ! -e "$RESTART_LOG" ]
printf '%s\\n' lifecycle-ok
`;
}

function fakeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-payload-lifecycle-'));
  fs.mkdirSync(path.join(root, 'payloads'), { recursive: true });
  return root;
}

function flows(root, marker) {
  const source = path.join(root, `flows-${marker}.json`);
  fs.writeFileSync(source, JSON.stringify([{ marker }]) + '\n');
  return source;
}

function gui(root, marker) {
  const source = path.join(root, `gui-${marker}`);
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'index.html'), `<title>${marker}</title>\n`);
  return source;
}

test('successful first deploy activates and proves one compatible pair', () => {
  const root = fakeRoot();
  const guiRoot = path.join(root, 'gui');
  try {
    swap.stagePayload(root, 'first', flows(root, 'first'), gui(root, 'first'));
    swap.writeCompatibility(root, 'first', '12', '1:a,12:b');
    const result = runSwap(root, 'swap_call flipTo first "$SWAP_ROOT/gui"\nswap_call verifyPair first "$SWAP_ROOT/gui"\nswap_call verifyCompatibility first 12 "1:a,12:b"');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(swap.currentPair(root, guiRoot), { flows: 'first', gui: 'first', compatible: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('activation failure leaves the prior pair and cleanup removes the first payload', () => {
  const root = fakeRoot();
  const guiRoot = path.join(root, 'gui');
  try {
    swap.stagePayload(root, 'first', flows(root, 'first'), gui(root, 'first'));
    fs.writeFileSync(path.join(root, 'blocked'), 'file');
    const failed = runSwap(root, 'swap_call flipTo first "$SWAP_ROOT/blocked/gui"');
    assert.notEqual(failed.status, 0, 'false activation must fail through swap_call');
    runSwap(root, 'swap_call deactivate first "$SWAP_ROOT/blocked/gui" || true\nswap_call discardPayload first');
    assert.equal(swap.currentPair(root, guiRoot), null);
    assert.equal(fs.existsSync(path.join(root, 'payloads', 'first')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('retained regular flows and GUI are captured as one rollback pair', () => {
  const root = fakeRoot();
  const guiRoot = path.join(root, 'gui');
  const flowsPath = path.join(root, 'flows.json');
  try {
    fs.writeFileSync(flowsPath, JSON.stringify([{ marker: 'legacy' }]) + '\n');
    fs.mkdirSync(guiRoot);
    fs.writeFileSync(path.join(guiRoot, 'index.html'), '<title>legacy</title>\n');
    swap.captureExisting(root, 'legacy', flowsPath, guiRoot);
    swap.writeCompatibility(root, 'legacy', '12', '1:a,12:b');
    const result = runSwap(root, 'swap_call flipTo legacy "$SWAP_ROOT/gui"\nswap_call verifyPair legacy "$SWAP_ROOT/gui"\nswap_call verifyCompatibility legacy 12 "1:a,12:b"');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(swap.currentPair(root, guiRoot), { flows: 'legacy', gui: 'legacy', compatible: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('incompatible retained payload refuses restart after the DB head changes', () => {
  const root = fakeRoot();
  try {
    swap.stagePayload(root, 'old', flows(root, 'old'), gui(root, 'old'));
    swap.writeCompatibility(root, 'old', '12', '1:a,12:b');
    const result = runSwap(root, 'if swap_call verifyCompatibility old 13 "1:a,12:b,13:c"; then\n  echo RESTART\nelse\n  echo STOPPED\n  exit 1\nfi');
    assert.equal(result.status, 1);
    assert.match(result.stdout, /STOPPED/);
    assert.doesNotMatch(result.stdout, /RESTART/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('integrated lifecycle executes real compatibility, retry, and dual-service hold decisions', () => {
  const root = fakeRoot();
  const dbPath = path.join(root, 'farming.db');
  const guiRoot = path.join(root, 'gui');
  fs.mkdirSync(guiRoot);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
case "$1" in
  *verify-head-cli.js) exit 0 ;;
  *) exec ${nodePathForShell()} "$@" ;;
esac
`, { mode: 0o755 });
  const result = spawnSync('sh', ['-c', integratedLifecycleScript(root, dbPath, guiRoot)], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  try {
    assert.equal(result.status, 0, `integrated lifecycle failed: stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stdout, /lifecycle-ok/);
    assert.equal(fs.readFileSync(path.join(root, 'identityd.state'), 'utf8').trim(), '0');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function rollbackLifecycleScript(root, dbPath, guiRoot) {
  const identity = fragment('# identityd deploy lifecycle begin\n', '# identityd deploy lifecycle end');
  const payload = fragment('# deploy payload lifecycle begin\n', '# deploy payload lifecycle end');
  const rollback = fragment('    # payload rollback begin\n', '    # payload rollback end');
  const nodeInit = path.join(root, 'node-init');
  return `set -eu
SWAP_ROOT=${JSON.stringify(root)}
SWAP_JS=${JSON.stringify(SWAP_JS)}
DB_PATH=${JSON.stringify(dbPath)}
GUI_ROOT=${JSON.stringify(guiRoot)}
TMP_DIR=${JSON.stringify(root)}
migrations_dir=${JSON.stringify(path.join(REPO, 'database/migrations/ordered'))}
NODE_RED_INIT=${JSON.stringify(nodeInit)}
IDENTITYD_LOCK_PATH=${JSON.stringify(path.join(root, 'identityd.lock'))}
SERVICE_STATE_FILE=${JSON.stringify(path.join(root, 'identityd.state'))}
NODE_RED_STATE_FILE=${JSON.stringify(path.join(root, 'node-red.state'))}
ROLLBACK_READINESS_LOG=${JSON.stringify(path.join(root, 'rollback-readiness.log'))}
NODE_RED_HEALTH_TIMEOUT=1
export SWAP_ROOT SWAP_JS NODE_RED_STATE_FILE
${swapCallFunction()}
${identity}
${payload}
wait_for_node_red_health() { printf '%s\\n' ready >> "$ROLLBACK_READINESS_LOG"; echo 'OK: rollback Node-RED readiness confirmed' >&2; return 0; }
cleanup() { :; }
restart_node_red() { return 0; }
node_red_service_state() { [ "$(cat "$NODE_RED_STATE_FILE" 2>/dev/null || echo 0)" = 1 ] && echo running || echo stopped; }
wait_for_node_red_stop() { echo 0 > "$NODE_RED_STATE_FILE"; return 0; }
identityd_service() {
  case "$1" in
    running) [ "$(cat "$SERVICE_STATE_FILE" 2>/dev/null || echo 0)" = 1 ] ;;
    stop) echo 0 > "$SERVICE_STATE_FILE"; rm -f "$IDENTITYD_LOCK_PATH" ;;
    start) echo 1 > "$SERVICE_STATE_FILE" ;;
    ready) [ "$(cat "$SERVICE_STATE_FILE" 2>/dev/null || echo 0)" = 1 ] ;;
    *) return 0 ;;
  esac
}
identityd_sleep() { :; }
cat > "$NODE_RED_INIT" <<'NODEINIT'
#!/bin/sh
case "$1" in stop) echo 0 > "$NODE_RED_STATE_FILE" ;; restart|start) echo 1 > "$NODE_RED_STATE_FILE" ;; esac
NODEINIT
chmod 755 "$NODE_RED_INIT"
echo 1 > "$SERVICE_STATE_FILE"
echo 1 > "$NODE_RED_STATE_FILE"
sqlite3 "$DB_PATH" "CREATE TABLE schema_migrations(version INTEGER, checksum TEXT, status TEXT); INSERT INTO schema_migrations VALUES (13, 'new', 'applied');"
mkdir -p ${JSON.stringify(path.join(root, 'src-good-gui'))} ${JSON.stringify(path.join(root, 'src-new-gui'))}
printf '%s\\n' good > ${JSON.stringify(path.join(root, 'good-flows.json'))}
printf '%s\\n' new > ${JSON.stringify(path.join(root, 'new-flows.json'))}
printf '%s\\n' good > ${JSON.stringify(path.join(root, 'src-good-gui', 'index.html'))}
printf '%s\\n' new > ${JSON.stringify(path.join(root, 'src-new-gui', 'index.html'))}
swap_call stagePayload good ${JSON.stringify(path.join(root, 'good-flows.json'))} ${JSON.stringify(path.join(root, 'src-good-gui'))} >/dev/null
swap_call stagePayload new ${JSON.stringify(path.join(root, 'new-flows.json'))} ${JSON.stringify(path.join(root, 'src-new-gui'))} >/dev/null
swap_call writeCompatibility good 13 13:new >/dev/null
swap_call writeCompatibility new 13 13:new >/dev/null
swap_call flipTo new "$GUI_ROOT" >/dev/null
swap_call verifyPair new "$GUI_ROOT" >/dev/null
quiesce_identityd_for_deploy
PREV_STAMP=good
DEPLOY_STAMP=new
PAYLOAD_FLIPPED=1
DB_MIGRATION_COMMITTED=1
node_red_restart_needed=0
ROLLBACK_RESTORED=0
PROBE_OK=1
trap 'deploy_exit_handler $?' EXIT
${rollback}
`;
}

test('verified rollback survives EXIT while preserving restored services and deploy failure status', () => {
  const root = fakeRoot();
  const dbPath = path.join(root, 'farming.db');
  const guiRoot = path.join(root, 'gui');
  fs.mkdirSync(guiRoot);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
case "$1" in
  *verify-head-cli.js) exit 0 ;;
  *) exec ${nodePathForShell()} "$@" ;;
esac
`, { mode: 0o755 });
  const result = spawnSync('sh', ['-c', rollbackLifecycleScript(root, dbPath, guiRoot)], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  try {
    assert.equal(result.status, 1, `rollback lifecycle unexpectedly succeeded: stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stderr, /preserving the verified rollback pair/);
    assert.match(result.stderr, /rollback Node-RED readiness confirmed/);
    assert.equal(fs.readFileSync(path.join(root, 'rollback-readiness.log'), 'utf8').trim(), 'ready');
    assert.equal(fs.readFileSync(path.join(root, 'identityd.state'), 'utf8').trim(), '1');
    assert.equal(fs.readFileSync(path.join(root, 'node-red.state'), 'utf8').trim(), '1');
    assert.equal(fs.existsSync(path.join(root, 'payloads', 'new')), false,
      'failed activated payload must be discarded after rollback');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function legacyRetryLifecycleScript(root, dbPath, guiRoot) {
  const capture = fragment('# legacy payload capture begin\n', '# legacy payload capture end')
    .replaceAll('/srv/node-red/flows.json', JSON.stringify(path.join(root, 'flows.json')));
  const payload = fragment('# deploy payload lifecycle begin\n', '# deploy payload lifecycle end');
  return `set -eu
SWAP_ROOT=${JSON.stringify(root)}
SWAP_JS=${JSON.stringify(SWAP_JS)}
DB_PATH=${JSON.stringify(dbPath)}
GUI_ROOT=${JSON.stringify(guiRoot)}
TMP_DIR=${JSON.stringify(root)}
migrations_dir=${JSON.stringify(path.join(REPO, 'database/migrations/ordered'))}
export SWAP_ROOT SWAP_JS
${swapCallFunction()}
${payload}
mkdir -p "$GUI_ROOT"
printf '%s\\n' legacy > ${JSON.stringify(path.join(root, 'flows.json'))}
printf '%s\\n' legacy > ${JSON.stringify(path.join(root, 'gui', 'index.html'))}
sqlite3 "$DB_PATH" "CREATE TABLE schema_migrations(version INTEGER, checksum TEXT, status TEXT); INSERT INTO schema_migrations VALUES (12, 'old', 'applied');"
DEPLOY_STAMP=first
PREV_STAMP=
PREV_GUI_STAMP=
PREV_CAPTURED=0
${capture}
[ "$PREV_STAMP" = first-previous ]
write_payload_compatibility "$PREV_STAMP"
sqlite3 "$DB_PATH" "INSERT INTO schema_migrations VALUES (13, 'new', 'applied');"
DEPLOY_STAMP=second
PREV_STAMP=
PREV_GUI_STAMP=
PREV_CAPTURED=0
${capture}
[ "$PREV_STAMP" = first-previous ]
if write_payload_compatibility "$PREV_STAMP"; then
  echo 'legacy payload was restamped after committed migration' >&2
  exit 61
fi
printf '%s\\n' legacy-retry-refused
`;
}

test('failed legacy deploy retry reuses original capture and refuses restamping after migration', () => {
  const root = fakeRoot();
  const dbPath = path.join(root, 'farming.db');
  const guiRoot = path.join(root, 'gui');
  const result = spawnSync('sh', ['-c', legacyRetryLifecycleScript(root, dbPath, guiRoot)], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  try {
    assert.equal(result.status, 0, `legacy retry lifecycle failed: stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stdout, /legacy-retry-refused/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function retainedFallbackVerificationScript(root, dbPath, guiRoot) {
  const payload = fragment('# deploy payload lifecycle begin\n', '# deploy payload lifecycle end');
  return `set -eu
SWAP_ROOT=${JSON.stringify(root)}
SWAP_JS=${JSON.stringify(SWAP_JS)}
DB_PATH=${JSON.stringify(dbPath)}
GUI_ROOT=${JSON.stringify(guiRoot)}
TMP_DIR=${JSON.stringify(root)}
export SWAP_ROOT SWAP_JS
${swapCallFunction()}
${payload}
mkdir -p ${JSON.stringify(path.join(root, 'src-gui'))}
printf '%s\\n' old > ${JSON.stringify(path.join(root, 'source-flows.json'))}
printf '%s\\n' old > ${JSON.stringify(path.join(root, 'src-gui', 'index.html'))}
sqlite3 "$DB_PATH" "CREATE TABLE schema_migrations(version INTEGER, checksum TEXT, status TEXT); INSERT INTO schema_migrations VALUES (12, 'old', 'applied');"
swap_call stagePayload old ${JSON.stringify(path.join(root, 'source-flows.json'))} ${JSON.stringify(path.join(root, 'src-gui'))} >/dev/null
swap_call writeCompatibility old 12 12:old >/dev/null
swap_call flipTo old "$GUI_ROOT" >/dev/null
verify_payload_db_compatibility old retained
printf '%s\\n' retained-fallback-proven
`;
}

test('recoverable old-schema fallback verifies saved metadata without incoming migrations', () => {
  const root = fakeRoot();
  const dbPath = path.join(root, 'farming.db');
  const guiRoot = path.join(root, 'gui');
  fs.mkdirSync(guiRoot);
  const result = spawnSync('sh', ['-c', retainedFallbackVerificationScript(root, dbPath, guiRoot)], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  try {
    assert.equal(result.status, 0, `retained fallback verification failed: stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stdout, /retained-fallback-proven/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function noOpMigrationFailureScript(root, dbPath, guiRoot) {
  const payload = fragment('# deploy payload lifecycle begin\n', '# deploy payload lifecycle end');
  const restart = path.join(root, 'node-init');
  return `set -eu
SWAP_ROOT=${JSON.stringify(root)}
SWAP_JS=${JSON.stringify(SWAP_JS)}
DB_PATH=${JSON.stringify(dbPath)}
GUI_ROOT=${JSON.stringify(guiRoot)}
TMP_DIR=${JSON.stringify(root)}
NODE_RED_INIT=${JSON.stringify(restart)}
NODE_RED_HEALTH_TIMEOUT=1
export SWAP_ROOT SWAP_JS
${swapCallFunction()}
${payload}
cleanup() { :; }
wait_for_node_red_health() { echo ready > ${JSON.stringify(path.join(root, 'ready'))}; return 0; }
cat > "$NODE_RED_INIT" <<'NODEINIT'
#!/bin/sh
echo restart > ${JSON.stringify(path.join(root, 'restart'))}
NODEINIT
chmod 755 "$NODE_RED_INIT"
mkdir -p ${JSON.stringify(path.join(root, 'src-gui'))}
printf '%s\\n' old > ${JSON.stringify(path.join(root, 'old-flows.json'))}
printf '%s\\n' new > ${JSON.stringify(path.join(root, 'new-flows.json'))}
printf '%s\\n' old > ${JSON.stringify(path.join(root, 'src-gui', 'index.html'))}
swap_call stagePayload old ${JSON.stringify(path.join(root, 'old-flows.json'))} ${JSON.stringify(path.join(root, 'src-gui'))} >/dev/null
swap_call stagePayload new ${JSON.stringify(path.join(root, 'new-flows.json'))} ${JSON.stringify(path.join(root, 'src-gui'))} >/dev/null
sqlite3 "$DB_PATH" "CREATE TABLE schema_migrations(version INTEGER, checksum TEXT, status TEXT); INSERT INTO schema_migrations VALUES (12, 'old', 'applied');"
swap_call writeCompatibility old 12 12:old >/dev/null
swap_call writeCompatibility new 12 12:old >/dev/null
swap_call flipTo new "$GUI_ROOT" >/dev/null
PREV_STAMP=old
DEPLOY_STAMP=new
PAYLOAD_FLIPPED=1
node_red_restart_needed=1
restart_previous_payload
[ "$(swap_call currentStamp)" = old ]
[ -f ${JSON.stringify(path.join(root, 'ready'))} ]
printf '%s\\n' no-op-fallback-proven
`;
}

test('failure after a no-op migration restores and restarts the previous compatible pair', () => {
  const root = fakeRoot();
  const dbPath = path.join(root, 'farming.db');
  const guiRoot = path.join(root, 'gui');
  fs.mkdirSync(guiRoot);
  const result = spawnSync('sh', ['-c', noOpMigrationFailureScript(root, dbPath, guiRoot)], {
    encoding: 'utf8',
    env: { ...process.env },
  });
  try {
    assert.equal(result.status, 0, `no-op fallback failed: stdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.match(result.stdout, /no-op-fallback-proven/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
