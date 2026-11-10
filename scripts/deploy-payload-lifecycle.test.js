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

function watermarkReceiverHarness(root, source, incomingFlows, incomingGui, receiverSource, receiverTarget, setup = '') {
  const fetchStart = DEPLOY.indexOf('fetch() {');
  const fetchEnd = DEPLOY.indexOf('\n}\n\nfetch_required', fetchStart) + 3;
  const requiredStart = DEPLOY.indexOf('fetch_required() {');
  const requiredEnd = DEPLOY.indexOf('\n}\n\nsame_fs_or_die', requiredStart) + 3;
  const fetchFunctions = DEPLOY.slice(fetchStart, fetchEnd) + '\n' + DEPLOY.slice(requiredStart, requiredEnd);
  return `set -eu
BASE=file://${source}
SWAP_ROOT=${JSON.stringify(root)}
SWAP_JS=${JSON.stringify(SWAP_JS)}
export BASE SWAP_ROOT SWAP_JS
${fetchFunctions}
${swapCallFunction()}
${setup}
swap_call stagePayload incoming ${JSON.stringify(incomingFlows)} ${JSON.stringify(incomingGui)} >/dev/null
fetch_required "osi-watermark-helper package.json" "package.json" ${JSON.stringify(path.join(path.dirname(receiverTarget), 'package.json'))}
fetch_required "osi-watermark-helper commands.js" "commands.js" ${JSON.stringify(receiverTarget)}
cmp ${JSON.stringify(receiverSource)} ${JSON.stringify(receiverTarget)}
swap_call sealModules incoming >/dev/null
swap_call flipTo incoming ${JSON.stringify(path.join(root, 'gui'))} >/dev/null
printf '%s\\n' activated > ${JSON.stringify(path.join(root, 'activation-marker'))}
`;
}

test('the same receiver fetch/stage/flip harness handles present and missing input', () => {
  const runCase = (present) => {
    const root = fakeRoot();
    const source = path.join(root, 'source');
    const sourceGui = path.join(root, 'source-gui');
    const guiRoot = path.join(root, 'gui');
    const receiverSource = path.join(source, 'commands.js');
    // deploy.sh fetches the receiver with the other helper-module files into
    // the staged payload ($MODULE_STAGE); the flip activates it with the flows.
    const receiverTarget = path.join(root, 'payloads', 'incoming', 'modules', 'osi-watermark-helper', 'commands.js');
    const incomingFlows = path.join(root, 'incoming-flows.json');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'package.json'), '{"name":"osi-watermark-helper","main":"index.js"}\n');
    fs.mkdirSync(sourceGui, { recursive: true });
    fs.writeFileSync(path.join(sourceGui, 'index.html'), `<title>${present ? 'incoming' : 'unused'}</title>\n`);
    fs.writeFileSync(incomingFlows, JSON.stringify([{ id: 'incoming-activation' }]) + '\n');
    if (present) fs.writeFileSync(receiverSource, 'required receiver bytes\n');
    if (!present) {
      fs.writeFileSync(path.join(root, 'previous-flows.json'), JSON.stringify([{ id: 'previous-active' }]) + '\n');
      fs.mkdirSync(path.join(root, 'previous-gui'));
      fs.writeFileSync(path.join(root, 'previous-gui', 'index.html'), '<title>previous-active</title>\n');
    }
    const setup = !present ? `
swap_call stagePayload previous ${JSON.stringify(path.join(root, 'previous-flows.json'))} ${JSON.stringify(path.join(root, 'previous-gui'))} >/dev/null
swap_call flipTo previous ${JSON.stringify(guiRoot)} >/dev/null
cp ${JSON.stringify(path.join(root, 'flows.json'))} ${JSON.stringify(path.join(root, 'previous-flows.copy'))}
cp ${JSON.stringify(path.join(guiRoot, 'index.html'))} ${JSON.stringify(path.join(root, 'previous-gui.copy'))}
` : '';
    const script = watermarkReceiverHarness(root, source, incomingFlows, sourceGui, receiverSource, receiverTarget, setup);
    const result = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
    try {
      if (present) {
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(fs.readFileSync(path.join(root, 'activation-marker'), 'utf8'), 'activated\n');
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'flows.json'), 'utf8')), [{ id: 'incoming-activation' }]);
        assert.equal(fs.readFileSync(path.join(root, 'osi-watermark-helper', 'commands.js'), 'utf8'), 'required receiver bytes\n',
          'the receiver is live through the module link once the flows are');
      } else {
        assert.notEqual(result.status, 0, 'missing receiver must stop the identical harness before activation');
        assert.equal(fs.existsSync(path.join(root, 'activation-marker')), false);
        assert.equal(fs.readFileSync(path.join(root, 'flows.json'), 'utf8'), fs.readFileSync(path.join(root, 'previous-flows.copy'), 'utf8'));
        assert.equal(fs.readFileSync(path.join(guiRoot, 'index.html'), 'utf8'), fs.readFileSync(path.join(root, 'previous-gui.copy'), 'utf8'));
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  runCase(true);
  runCase(false);
});

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

// Issue #603: the helper modules ride in the payload. These fixtures model a
// v0.8.1 gateway (flows+GUI already a payload with recorded compatibility,
// helper modules as real directories under /srv/node-red, node_modules links
// from npm) and run deploy.sh's own module staging block, exit handler and
// rollback helpers against it.
function moduleDeployScript(root, dbPath, guiRoot, scenario) {
  const identity = fragment('# identityd deploy lifecycle begin\n', '# identityd deploy lifecycle end');
  const payload = fragment('# deploy payload lifecycle begin\n', '# deploy payload lifecycle end');
  const staging = fragment('# module payload staging begin\n', '# module payload staging end');
  const nodeInit = path.join(root, 'node-init');
  return `set -eu
SWAP_ROOT=${JSON.stringify(root)}
SWAP_JS=${JSON.stringify(SWAP_JS)}
PAYLOADS_ROOT="$SWAP_ROOT/payloads"
DB_PATH=${JSON.stringify(dbPath)}
GUI_ROOT=${JSON.stringify(guiRoot)}
TMP_DIR=${JSON.stringify(root)}
migrations_dir=${JSON.stringify(path.join(REPO, 'database/migrations/ordered'))}
NODE_RED_INIT=${JSON.stringify(nodeInit)}
IDENTITYD_LOCK_PATH=${JSON.stringify(path.join(root, 'identityd.lock'))}
SERVICE_STATE_FILE=${JSON.stringify(path.join(root, 'identityd.state'))}
NODE_RED_STATE_FILE=${JSON.stringify(path.join(root, 'node-red.state'))}
NODE_RED_LOG=${JSON.stringify(path.join(root, 'node-red.log'))}
NODE_RED_HEALTH_TIMEOUT=1
export SWAP_ROOT SWAP_JS NODE_RED_STATE_FILE NODE_RED_LOG
${swapCallFunction()}
${identity}
${payload}
wait_for_node_red_health() { echo 'OK: rollback Node-RED readiness confirmed' >&2; return 0; }
cleanup() { :; }
restart_node_red() {
  [ "$node_red_restart_needed" = 1 ] || return 0
  "$NODE_RED_INIT" start; node_red_restart_needed=0
}
node_red_service_state() { [ "$(cat "$NODE_RED_STATE_FILE" 2>/dev/null || echo 0)" = 1 ] && echo running || echo stopped; }
wait_for_node_red_stop() { [ "$(cat "$NODE_RED_STATE_FILE")" = 0 ]; }
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
echo "$1" >> "$NODE_RED_LOG"
case "$1" in stop) echo 0 > "$NODE_RED_STATE_FILE" ;; restart|start) echo 1 > "$NODE_RED_STATE_FILE" ;; esac
NODEINIT
chmod 755 "$NODE_RED_INIT"
echo 1 > "$SERVICE_STATE_FILE"
echo 1 > "$NODE_RED_STATE_FILE"
write_module() {
  mkdir -p "$1"
  printf '{"name":"%s","version":"1.0.0","main":"index.js"}\\n' "$(basename "$1")" > "$1/package.json"
  printf 'exports.marker = "%s";\\n' "$2" > "$1/index.js"
}
# The v0.8.1 gateway.
sqlite3 "$DB_PATH" "CREATE TABLE schema_migrations(version INTEGER, checksum TEXT, status TEXT); INSERT INTO schema_migrations VALUES (70, 'v081', 'applied');"
mkdir -p "$SWAP_ROOT/src-old-gui" "$SWAP_ROOT/osi-command-ledger" "$SWAP_ROOT/node_modules"
printf '%s\\n' old > "$SWAP_ROOT/old-flows.json"
printf '%s\\n' old > "$SWAP_ROOT/src-old-gui/index.html"
swap_call stagePayload old "$SWAP_ROOT/old-flows.json" "$SWAP_ROOT/src-old-gui" >/dev/null
swap_call writeCompatibility old 70 70:v081 >/dev/null
swap_call flipTo old "$GUI_ROOT" >/dev/null
write_module "$SWAP_ROOT/osi-a" a@v081
write_module "$SWAP_ROOT/osi-b" b@v081
for module in osi-a osi-b; do ln -s "../$module" "$SWAP_ROOT/node_modules/$module"; done
stage_new_deploy() {
  DEPLOY_STAMP="$1"
  MODULE_STAGE="$PAYLOADS_ROOT/$DEPLOY_STAMP/modules"
  PREV_STAMP="$(swap_call currentStamp || true)"
  mkdir -p "$SWAP_ROOT/src-new-gui"
  printf '%s\\n' new > "$SWAP_ROOT/new-flows.json"
  printf '%s\\n' new > "$SWAP_ROOT/src-new-gui/index.html"
  swap_call stagePayload "$DEPLOY_STAMP" "$SWAP_ROOT/new-flows.json" "$SWAP_ROOT/src-new-gui" >/dev/null
  # What the fetch_required block writes.
  write_module "$MODULE_STAGE/osi-a" "a@$DEPLOY_STAMP"
  write_module "$MODULE_STAGE/osi-b" "b@$DEPLOY_STAMP"
  write_module "$MODULE_STAGE/osi-c" "c@$DEPLOY_STAMP"
${staging}
  # npm install links the new file: dependency.
  [ -L "$SWAP_ROOT/node_modules/osi-c" ] || ln -s ../osi-c "$SWAP_ROOT/node_modules/osi-c"
  PAYLOAD_FLIPPED=0
  DB_MIGRATION_COMMITTED=0
  ROLLBACK_RESTORED=0
  node_red_restart_needed=0
}
# Node-RED stopped for the migration, as run_schema_migration does.
stop_for_migration() { node_red_restart_needed=1; "$NODE_RED_INIT" stop; }
commit_migration() { sqlite3 "$DB_PATH" "INSERT INTO schema_migrations VALUES (78, 'main', 'applied');"; DB_MIGRATION_COMMITTED=1; }
flip_new() { write_payload_compatibility "$DEPLOY_STAMP"; swap_call flipTo "$DEPLOY_STAMP" "$GUI_ROOT" >/dev/null; PAYLOAD_FLIPPED=1; }
quiesce_identityd_for_deploy
${scenario}
`;
}

function runModuleDeploy(scenario) {
  const root = fakeRoot();
  const dbPath = path.join(root, 'farming.db');
  const guiRoot = path.join(root, 'gui');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh
case "$1" in
  *verify-head-cli.js) exit 0 ;;
  *) exec ${nodePathForShell()} "$@" ;;
esac
`, { mode: 0o755 });
  const result = spawnSync('sh', ['-c', moduleDeployScript(root, dbPath, guiRoot, scenario)], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  const markers = (via = '') => {
    const out = spawnSync(process.execPath, ['-e', `
      const path = require('path'); const out = {};
      for (const name of ['osi-a', 'osi-b', 'osi-c']) {
        try { out[name] = require(path.join(process.argv[1], process.argv[2], name)).marker; }
        catch (error) { out[name] = error.code; }
      }
      process.stdout.write(JSON.stringify(out));
    `, root, via], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  };
  const state = (file) => fs.readFileSync(path.join(root, file), 'utf8').trim();
  const nodeRedLog = () => (fs.existsSync(path.join(root, 'node-red.log')) ? state('node-red.log').split('\n') : []);
  return { root, guiRoot, result, markers, state, nodeRedLog, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('module staging leaves the running modules alone; a successful deploy switches them with flows', () => {
  const run = runModuleDeploy(`
stage_new_deploy new
[ -d "$SWAP_ROOT/osi-a" ] && [ ! -L "$SWAP_ROOT/osi-a" ]
cp "$SWAP_ROOT/osi-a/index.js" "$SWAP_ROOT/a-before-flip.js"
stop_for_migration
commit_migration
flip_new
restart_node_red
swap_call verifyPair new "$GUI_ROOT"
printf '%s\\n' deployed
`);
  try {
    assert.equal(run.result.status, 0, `stdout=${run.result.stdout}\nstderr=${run.result.stderr}`);
    assert.match(run.result.stdout, /OK: captured osi-a into payloads\/old\/modules\/osi-a/);
    assert.match(run.result.stdout, /OK: linked osi-c -> payloads\/new\/modules\/osi-c \(absent before this deploy\)/);
    assert.match(run.result.stdout, /deployed/);
    assert.equal(run.state('a-before-flip.js'), 'exports.marker = "a@v081";', 'the running flows keep their modules until the flip');
    assert.deepEqual(run.markers(), { 'osi-a': 'a@new', 'osi-b': 'b@new', 'osi-c': 'c@new' });
    assert.deepEqual(run.markers('node_modules'), { 'osi-a': 'a@new', 'osi-b': 'b@new', 'osi-c': 'c@new' });
    assert.deepEqual(swap.currentPair(run.root, run.guiRoot), { flows: 'new', gui: 'new', compatible: true });
    assert.deepEqual(run.nodeRedLog(), ['stop', 'start'], 'the switch happens while Node-RED is stopped');
  } finally {
    run.cleanup();
  }
});

test('a failure after the stop and before the migration commit restores flows and modules', () => {
  const run = runModuleDeploy(`
stage_new_deploy new
stop_for_migration
if (deploy_exit_handler 1); then exit 41; else rc=$?; fi
[ "$rc" = 1 ]
swap_call verifyPair old "$GUI_ROOT"
printf '%s\\n' rolled-back
`);
  try {
    assert.equal(run.result.status, 0, `stdout=${run.result.stdout}\nstderr=${run.result.stderr}`);
    assert.match(run.result.stderr, /OK: rollback Node-RED readiness confirmed/);
    assert.deepEqual(run.markers(), { 'osi-a': 'a@v081', 'osi-b': 'b@v081', 'osi-c': 'MODULE_NOT_FOUND' },
      'v0.8.1 flows restart on the v0.8.1 modules; the module new in this release is gone');
    assert.deepEqual(run.markers('node_modules'), { 'osi-a': 'a@v081', 'osi-b': 'b@v081', 'osi-c': 'MODULE_NOT_FOUND' });
    assert.deepEqual(swap.currentPair(run.root, run.guiRoot), { flows: 'old', gui: 'old', compatible: true });
    assert.equal(fs.existsSync(path.join(run.root, 'payloads', 'new')), false, 'the failed payload is discarded');
    assert.equal(run.state('node-red.state'), '1');
    assert.deepEqual(run.nodeRedLog(), ['stop', 'restart']);
  } finally {
    run.cleanup();
  }
});

test('a failure after the migration commit still refuses the old payload and keeps Node-RED stopped', () => {
  for (const flipped of [true, false]) {
    const run = runModuleDeploy(`
stage_new_deploy new
stop_for_migration
commit_migration
${flipped ? 'flip_new' : ': failure between the commit and the flip'}
if (deploy_exit_handler 1); then exit 41; else rc=$?; fi
[ "$rc" = 1 ]
printf '%s\\n' held
`);
    try {
      assert.equal(run.result.status, 0, `stdout=${run.result.stdout}\nstderr=${run.result.stderr}`);
      assert.match(run.result.stderr, /recorded for a different schema head\/ledger/);
      assert.match(run.result.stderr, /keeping Node-RED stopped/);
      assert.equal(run.state('node-red.state'), '0');
      assert.doesNotMatch(run.result.stderr, /rollback Node-RED readiness confirmed/);
      const expected = flipped
        ? { 'osi-a': 'a@new', 'osi-b': 'b@new', 'osi-c': 'c@new' }
        : { 'osi-a': 'a@v081', 'osi-b': 'b@v081', 'osi-c': 'MODULE_NOT_FOUND' };
      assert.deepEqual(run.markers(), expected, 'flows and modules stay one set while held');
      assert.equal(swap.currentStamp(run.root), flipped ? 'new' : 'old');
    } finally {
      run.cleanup();
    }
  }
});

test('the post-flip self-check rollback restores the captured modules', () => {
  const rollback = fragment('    # payload rollback begin\n', '    # payload rollback end');
  const run = runModuleDeploy(`
stage_new_deploy new
stop_for_migration
flip_new
restart_node_red
MIGRATION_RUNNER_AVAILABLE=1
trap 'deploy_exit_handler $?' EXIT
${rollback}
`);
  try {
    assert.equal(run.result.status, 1, `stdout=${run.result.stdout}\nstderr=${run.result.stderr}`);
    assert.match(run.result.stderr, /ROLLED BACK: flows\+GUI -> payloads\/old/);
    assert.deepEqual(run.markers(), { 'osi-a': 'a@v081', 'osi-b': 'b@v081', 'osi-c': 'MODULE_NOT_FOUND' });
    assert.deepEqual(swap.currentPair(run.root, run.guiRoot), { flows: 'old', gui: 'old', compatible: true });
    assert.equal(run.state('node-red.state'), '1');
  } finally {
    run.cleanup();
  }
});

test('reruns after an early failure reuse the capture, repair stale links and refuse changed modules', () => {
  const run = runModuleDeploy(`
stage_new_deploy first
# Failure before the stop: the exit handler discards the staged payload.
if (deploy_exit_handler 1); then exit 41; fi
[ ! -e "$SWAP_ROOT/osi-c" ] && [ ! -L "$SWAP_ROOT/osi-c" ]
[ ! -L "$SWAP_ROOT/osi-a" ]
stage_new_deploy second
# Exit before the exit handler was installed: the payload and its link stay.
[ "$(readlink "$SWAP_ROOT/osi-c")" = payloads/second/modules/osi-c ]
stage_new_deploy third
[ "$(readlink "$SWAP_ROOT/osi-c")" = payloads/third/modules/osi-c ]
printf '// changed in place\\n' >> "$SWAP_ROOT/osi-b/index.js"
if (stage_new_deploy fourth); then exit 42; fi
printf '%s\\n' reruns-ok
`);
  try {
    assert.equal(run.result.status, 0, `stdout=${run.result.stdout}\nstderr=${run.result.stderr}`);
    assert.match(run.result.stdout, /reruns-ok/);
    const captures = run.result.stdout.match(/OK: captured osi-a/g) || [];
    assert.equal(captures.length, 1, 'later attempts reuse the first capture');
    assert.match(run.result.stdout, /OK: relinked osi-c -> payloads\/third\/modules\/osi-c/);
    assert.match(run.result.stderr, /refusing to recapture changed live module osi-b/);
    assert.match(run.result.stderr, /refusing the deploy before anything is stopped/);
    assert.equal(run.state('node-red.state'), '1', 'nothing was stopped');
    assert.deepEqual(run.markers(), { 'osi-a': 'a@v081', 'osi-b': 'b@v081', 'osi-c': 'c@third' });
  } finally {
    run.cleanup();
  }
});

// A sysupgrade keeps /srv (flows.json and the module links) but not the GUI
// link under /usr/lib, so the next deploy takes the legacy capture path and
// its previous payload has no module set of its own.
test('after a sysupgrade the legacy capture keeps the linked modules for a rollback', () => {
  const run = runModuleDeploy(`
stage_new_deploy first
stop_for_migration
commit_migration
flip_new
restart_node_red
rm "$GUI_ROOT"
mkdir -p "$GUI_ROOT"
printf '%s\\n' image > "$GUI_ROOT/index.html"
DEPLOY_STAMP=second
MODULE_STAGE="$PAYLOADS_ROOT/$DEPLOY_STAMP/modules"
swap_call stagePayload "$DEPLOY_STAMP" "$SWAP_ROOT/new-flows.json" "$SWAP_ROOT/src-new-gui" >/dev/null
PREV_STAMP="$(swap_call currentStamp || true)"
PREV_GUI_STAMP="$(swap_call guiStamp "$GUI_ROOT" || true)"
PREV_CAPTURED=0
${fragment('# legacy payload capture begin\n', '# legacy payload capture end').replaceAll('/srv/node-red/flows.json', '$SWAP_ROOT/flows.json')}
[ "$PREV_STAMP" = second-previous ] && [ "$PREV_CAPTURED" = 1 ]
for module in osi-a osi-b osi-c; do write_module "$MODULE_STAGE/$module" "\${module#osi-}@second"; done
${fragment('# module payload staging begin\n', '# module payload staging end')}
[ "$(readlink "$SWAP_ROOT/osi-a")" = payloads/first/modules/osi-a ]
[ "$(readlink "$SWAP_ROOT/osi-c")" = payloads/first/modules/osi-c ]
PAYLOAD_FLIPPED=0
DB_MIGRATION_COMMITTED=0
write_payload_compatibility "$PREV_STAMP"
stop_for_migration
if (deploy_exit_handler 1); then exit 41; else rc=$?; fi
[ "$rc" = 1 ]
printf '%s\\n' sysupgrade-rollback-ok
`);
  try {
    assert.equal(run.result.status, 0, `stdout=${run.result.stdout}\nstderr=${run.result.stderr}`);
    assert.match(run.result.stdout, /sysupgrade-rollback-ok/);
    assert.match(run.result.stdout, /OK: captured existing flows\+GUI pair as payloads\/second-previous/);
    assert.match(run.result.stdout, /OK: captured osi-a into payloads\/second-previous\/modules\/osi-a/);
    assert.doesNotMatch(run.result.stdout, /relinked/, 'no live module moves to the new payload before the stop');
    assert.match(run.result.stderr, /OK: rollback Node-RED readiness confirmed/);
    assert.deepEqual(run.markers(), { 'osi-a': 'a@first', 'osi-b': 'b@first', 'osi-c': 'c@first' },
      'the rollback restarts the deployed flows on the modules they ran with');
    assert.deepEqual(swap.currentPair(run.root, run.guiRoot), { flows: 'second-previous', gui: 'second-previous', compatible: true });
    assert.equal(run.state('node-red.state'), '1');
  } finally {
    run.cleanup();
  }
});

const legacyPreflightFragment = () =>
  fragment('# legacy capture preflight begin\n', '# legacy capture preflight end')
    .replaceAll('/srv/node-red/flows.json', '$SWAP_ROOT/flows.json');

test('after a sysupgrade a stale legacy-capture marker is moved aside and the recapture keeps the linked modules', () => {
  const run = runModuleDeploy(`
stage_new_deploy first
stop_for_migration
commit_migration
flip_new
restart_node_red
rm "$GUI_ROOT"
mkdir -p "$GUI_ROOT"
printf '%s\\n' image > "$GUI_ROOT/index.html"
# A marker an earlier failed deploy left behind; its capture was pruned since.
printf '%s\\n' '{"format":1,"stamp":"gone-previous","flows_path":"x","gui_path":"y","flows_sha256":"0","gui_sha256":"0"}' > "$PAYLOADS_ROOT/.legacy-capture.json"
${legacyPreflightFragment()}
[ ! -e "$PAYLOADS_ROOT/.legacy-capture.json" ]
DEPLOY_STAMP=second
MODULE_STAGE="$PAYLOADS_ROOT/$DEPLOY_STAMP/modules"
swap_call stagePayload "$DEPLOY_STAMP" "$SWAP_ROOT/new-flows.json" "$SWAP_ROOT/src-new-gui" >/dev/null
PREV_STAMP="$(swap_call currentStamp || true)"
PREV_GUI_STAMP="$(swap_call guiStamp "$GUI_ROOT" || true)"
PREV_CAPTURED=0
${fragment('# legacy payload capture begin\n', '# legacy payload capture end').replaceAll('/srv/node-red/flows.json', '$SWAP_ROOT/flows.json')}
[ "$PREV_STAMP" = second-previous ] && [ "$PREV_CAPTURED" = 1 ]
for module in osi-a osi-b osi-c; do write_module "$MODULE_STAGE/$module" "\${module#osi-}@second"; done
${fragment('# module payload staging begin\n', '# module payload staging end')}
PAYLOAD_FLIPPED=0
DB_MIGRATION_COMMITTED=0
write_payload_compatibility "$PREV_STAMP"
stop_for_migration
if (deploy_exit_handler 1); then exit 41; else rc=$?; fi
[ "$rc" = 1 ]
printf '%s\\n' stale-marker-rollback-ok
`);
  try {
    assert.equal(run.result.status, 0, `stdout=${run.result.stdout}\nstderr=${run.result.stderr}`);
    assert.match(run.result.stdout, /stale-marker-rollback-ok/);
    assert.match(run.result.stdout, /WARN: stale legacy-capture marker \(payload gone-previous gone\); moved to payloads\/\.legacy-capture\.json\.stale-\d+-\d+; recapturing/);
    assert.match(run.result.stdout, /OK: captured existing flows\+GUI pair as payloads\/second-previous/);
    assert.match(run.result.stdout, /OK: captured osi-a into payloads\/second-previous\/modules\/osi-a/);
    assert.match(run.result.stdout, /OK: captured osi-b into payloads\/second-previous\/modules\/osi-b/);
    assert.deepEqual(run.markers(), { 'osi-a': 'a@first', 'osi-b': 'b@first', 'osi-c': 'c@first' },
      'the rollback restarts the deployed flows on the modules they ran with');
    assert.deepEqual(swap.currentPair(run.root, run.guiRoot), { flows: 'second-previous', gui: 'second-previous', compatible: true });
  } finally {
    run.cleanup();
  }
});

test('a stale marker from a deploy cut off during its switch refuses before any file is replaced', () => {
  const run = runModuleDeploy(`
rm "$GUI_ROOT"
mkdir -p "$GUI_ROOT"
printf '%s\\n' legacy > "$GUI_ROOT/index.html"
mkdir -p "$SWAP_ROOT/src-cut-gui"
printf '%s\\n' cut > "$SWAP_ROOT/cut-flows.json"
printf '%s\\n' cut > "$SWAP_ROOT/src-cut-gui/index.html"
swap_call stagePayload cut "$SWAP_ROOT/cut-flows.json" "$SWAP_ROOT/src-cut-gui" >/dev/null
rm "$SWAP_ROOT/flows.json"
ln -s payloads/cut/flows.json "$SWAP_ROOT/flows.json"
printf '%s\\n' '{"format":1,"stamp":"cut-previous","flows_path":"x","gui_path":"y","flows_sha256":"0","gui_sha256":"0"}' > "$PAYLOADS_ROOT/.legacy-capture.json"
cp "$PAYLOADS_ROOT/.legacy-capture.json" "$SWAP_ROOT/marker-before"
if ( ${legacyPreflightFragment()} ); then exit 41; fi
cmp "$PAYLOADS_ROOT/.legacy-capture.json" "$SWAP_ROOT/marker-before"
printf '%s\\n' half-switched-refused
`);
  try {
    assert.equal(run.result.status, 0, `stdout=${run.result.stdout}\nstderr=${run.result.stderr}`);
    assert.match(run.result.stdout, /half-switched-refused/);
    assert.match(run.result.stderr, /refusing to capture a half-switched state/);
    assert.match(run.result.stderr, /ERROR: the live flows, GUI and helper modules cannot be kept as the rollback target; refusing before any file is replaced/);
  } finally {
    run.cleanup();
  }
});

// One deploy's preflight, payload staging, capture block and module staging,
// as deploy.sh runs them, for the sequences below.
const legacyAttemptFunction = () => `
legacy_attempt() {
  DEPLOY_STAMP="$1"
  MODULE_STAGE="$PAYLOADS_ROOT/$DEPLOY_STAMP/modules"
  PAYLOAD_FLIPPED=0
  DB_MIGRATION_COMMITTED=0
  ROLLBACK_RESTORED=0
  node_red_restart_needed=0
${legacyPreflightFragment()}
  swap_call stagePayload "$DEPLOY_STAMP" "$SWAP_ROOT/new-flows.json" "$SWAP_ROOT/src-new-gui" >/dev/null
  PREV_STAMP="$(swap_call currentStamp || true)"
  PREV_GUI_STAMP="$(swap_call guiStamp "$GUI_ROOT" || true)"
  PREV_CAPTURED=0
${fragment('# legacy payload capture begin\n', '# legacy payload capture end').replaceAll('/srv/node-red/flows.json', '$SWAP_ROOT/flows.json')}
  for module in osi-a osi-b osi-c; do write_module "$MODULE_STAGE/$module" "\${module#osi-}@$DEPLOY_STAMP"; done
${fragment('# module payload staging begin\n', '# module payload staging end')}
}
`;

// PR #618 review: attempt A captures the live set and fails before the stop,
// retry B reuses that capture and loses power after switching flows only, and
// the capture is pruned. The next deploy must not capture B's flows beside the
// GUI and modules they never ran with.
test('a retry cut off during its switch refuses once the capture it reused is gone', () => {
  for (const start of ['regular files', 'sysupgrade']) {
    const setup = start === 'regular files' ? `
rm "$SWAP_ROOT/flows.json" "$GUI_ROOT"
printf '%s\\n' legacy > "$SWAP_ROOT/flows.json"
` : `
stage_new_deploy first
stop_for_migration
commit_migration
flip_new
restart_node_red
rm "$GUI_ROOT"
`;
    const run = runModuleDeploy(`
${setup}
mkdir -p "$GUI_ROOT"
printf '%s\\n' image > "$GUI_ROOT/index.html"
mkdir -p "$SWAP_ROOT/src-new-gui"
printf '%s\\n' new > "$SWAP_ROOT/new-flows.json"
printf '%s\\n' new > "$SWAP_ROOT/src-new-gui/index.html"
${legacyAttemptFunction()}
legacy_attempt attempt-a
[ "$PREV_STAMP" = attempt-a-previous ] && [ "$PREV_CAPTURED" = 1 ]
# Attempt A fails before the stop; its exit handler discards payloads/attempt-a.
if (deploy_exit_handler 1); then exit 41; fi
legacy_attempt attempt-b
[ "$PREV_STAMP" = attempt-a-previous ] && [ "$PREV_CAPTURED" = 0 ]
stop_for_migration
# Power lost inside flipTo('attempt-b'): flows switched, the GUI and modules not.
if [ -L "$SWAP_ROOT/flows.json" ]; then rm "$SWAP_ROOT/flows.json"; else mv "$SWAP_ROOT/flows.json" "$SWAP_ROOT/flows.json.osi-old-1-1"; fi
ln -s payloads/attempt-b/flows.json "$SWAP_ROOT/flows.json"
# The capture attempt A wrote is pruned, by a deploy.sh that does not know the marker.
rm -rf "$PAYLOADS_ROOT/attempt-a-previous"
cp "$PAYLOADS_ROOT/.legacy-capture.json" "$SWAP_ROOT/marker-before"
if (legacy_attempt attempt-c); then exit 42; fi
cmp "$PAYLOADS_ROOT/.legacy-capture.json" "$SWAP_ROOT/marker-before"
[ ! -e "$PAYLOADS_ROOT/attempt-c" ] && [ ! -e "$PAYLOADS_ROOT/attempt-c-previous" ]
for aside in "$PAYLOADS_ROOT"/.legacy-capture.json.stale-*; do [ ! -e "$aside" ] || exit 43; done
printf '%s\\n' retry-half-switch-refused
`);
    try {
      assert.equal(run.result.status, 0, `${start}: stdout=${run.result.stdout}\nstderr=${run.result.stderr}`);
      assert.match(run.result.stdout, /retry-half-switch-refused/);
      assert.match(run.result.stdout, /OK: reused immutable legacy flows\+GUI capture payloads\/attempt-a-previous/,
        `${start}: retry B reused the capture attempt A wrote`);
      const stray = start === 'regular files' ? 'osi-a, osi-b' : 'osi-a, osi-b, osi-c';
      assert.match(run.result.stderr, new RegExp(`the live flows point into payloads/attempt-b, but its helper modules ${stray} are not linked into it; refusing to capture a half-switched state`), start);
      assert.match(run.result.stderr, /ERROR: the live flows, GUI and helper modules cannot be kept as the rollback target; refusing before any file is replaced/);
      assert.doesNotMatch(run.result.stdout, /stale legacy-capture marker/, `${start}: the marker stays for the operator`);
    } finally {
      run.cleanup();
    }
  }
});

// No marker is involved when the cut-off deploy started from a paired payload:
// flows already point into the new payload, the GUI still into the old one.
test('a paired deploy cut off between its flows and GUI switch refuses without a marker', () => {
  const run = runModuleDeploy(`
stage_new_deploy cut
stop_for_migration
# Power lost inside flipTo('cut'): flows switched, the GUI and modules not.
rm "$SWAP_ROOT/flows.json"
ln -s payloads/cut/flows.json "$SWAP_ROOT/flows.json"
[ ! -e "$PAYLOADS_ROOT/.legacy-capture.json" ]
if ( ${legacyPreflightFragment()} ); then exit 41; fi
printf '%s\\n' paired-half-switch-refused
`);
  try {
    assert.equal(run.result.status, 0, `stdout=${run.result.stdout}\nstderr=${run.result.stderr}`);
    assert.match(run.result.stdout, /paired-half-switch-refused/);
    assert.match(run.result.stderr, /the live flows point into payloads\/cut but the GUI into payloads\/old; refusing to capture a half-switched state/);
    assert.match(run.result.stderr, /ERROR: the live flows, GUI and helper modules cannot be kept as the rollback target; refusing before any file is replaced/);
  } finally {
    run.cleanup();
  }
});

// PR #618 re-review: a deploy that fails before the stop writes captured
// entries into the previous payload's modules.json (captureModules) and
// changes no live file. A sysupgrade then replaces the GUI link with the image
// GUI and copies the image's helpers over the real directories. That
// bookkeeping must not block the next deploy, whether the image is the same or
// another one, with or without a stale marker.
test('a deploy that failed before the stop and a sysupgrade do not block the retry', () => {
  for (const image of ['v081', 'image2']) {
    for (const marker of ['none', 'stale']) {
      const label = `${image === 'v081' ? 'same image' : 'other image'}, ${marker} marker`;
      const run = runModuleDeploy(`
mkdir -p "$SWAP_ROOT/src-new-gui"
printf '%s\\n' new > "$SWAP_ROOT/new-flows.json"
printf '%s\\n' new > "$SWAP_ROOT/src-new-gui/index.html"
${legacyAttemptFunction()}
legacy_attempt early
[ "$PREV_STAMP" = old ] && [ "$PREV_CAPTURED" = 0 ]
# The deploy fails before the stop; its exit handler discards payloads/early.
if (deploy_exit_handler 1); then exit 41; fi
[ ! -e "$PAYLOADS_ROOT/early" ] && [ -f "$PAYLOADS_ROOT/old/modules.json" ]
# Sysupgrade: the image GUI replaces the GUI link, the image seed copies its
# helpers over the real directories.
rm "$GUI_ROOT"
mkdir -p "$GUI_ROOT"
printf '%s\\n' image > "$GUI_ROOT/index.html"
write_module "$SWAP_ROOT/osi-a" a@${image}
write_module "$SWAP_ROOT/osi-b" b@${image}
${marker === 'stale' ? `printf '%s\\n' '{"format":1,"stamp":"gone-previous","flows_path":"x","gui_path":"y","flows_sha256":"0","gui_sha256":"0"}' > "$PAYLOADS_ROOT/.legacy-capture.json"` : ''}
legacy_attempt retry
[ "$PREV_STAMP" = retry-previous ] && [ "$PREV_CAPTURED" = 1 ]
write_payload_compatibility "$PREV_STAMP"
stop_for_migration
# The retry fails behind the stop; the exit handler restarts the capture.
if (deploy_exit_handler 1); then exit 42; else rc=$?; fi
[ "$rc" = 1 ]
printf '%s\\n' retry-after-sysupgrade-ok
`);
      try {
        assert.equal(run.result.status, 0, `${label}: stdout=${run.result.stdout}\nstderr=${run.result.stderr}`);
        assert.match(run.result.stdout, /retry-after-sysupgrade-ok/, label);
        assert.match(run.result.stdout, /OK: captured osi-a into payloads\/old\/modules\/osi-a/, `${label}: the early deploy wrote the bookkeeping`);
        const manifest = JSON.parse(fs.readFileSync(path.join(run.root, 'payloads', 'old', 'modules.json'), 'utf8'));
        assert.deepEqual(Object.keys(manifest.captured).sort(), ['osi-a', 'osi-b'], label);
        if (marker === 'stale') assert.match(run.result.stdout, /WARN: stale legacy-capture marker \(payload gone-previous gone\)/, label);
        assert.match(run.result.stdout, /OK: captured existing flows\+GUI pair as payloads\/retry-previous/, label);
        assert.match(run.result.stdout, /OK: captured osi-a into payloads\/retry-previous\/modules\/osi-a/, label);
        assert.doesNotMatch(run.result.stderr, /refusing/, label);
        assert.deepEqual(run.markers(), { 'osi-a': `a@${image}`, 'osi-b': `b@${image}`, 'osi-c': 'MODULE_NOT_FOUND' },
          `${label}: the restart runs the flows on the helpers they ran with before the retry`);
        assert.deepEqual(swap.currentPair(run.root, run.guiRoot), { flows: 'retry-previous', gui: 'retry-previous', compatible: true }, label);
        assert.deepEqual(run.nodeRedLog(), ['stop', 'restart'], `${label}: the early failure stopped nothing`);
      } finally {
        run.cleanup();
      }
    }
  }
});

// A gateway on a v0.8.1 or v0.7.0 layout meets this deploy.sh: the first
// deploy keeps what ran as its rollback target, and a failure behind the stop
// restarts exactly that.
test('a v0.8.1 or v0.7.0 gateway meeting this deploy.sh keeps what ran as the rollback target', () => {
  const starts = {
    'v0.8.1': { setup: '', prev: 'old', captured: 0, helpers: 'v081' },
    'v0.8.1 after a sysupgrade': { setup: `
rm "$GUI_ROOT"
mkdir -p "$GUI_ROOT"
printf '%s\\n' image > "$GUI_ROOT/index.html"
`, prev: 'first-previous', captured: 1, helpers: 'v081' },
    'v0.7.0': { setup: `
rm "$SWAP_ROOT/flows.json" "$GUI_ROOT"
rm -rf "$PAYLOADS_ROOT/old"
printf '%s\\n' v070 > "$SWAP_ROOT/o070-flows.json"
swap_call stagePayload o070 "$SWAP_ROOT/o070-flows.json" >/dev/null
ln -s payloads/o070/flows.json "$SWAP_ROOT/flows.json"
mkdir -p "$GUI_ROOT"
printf '%s\\n' v070 > "$GUI_ROOT/index.html"
write_module "$SWAP_ROOT/osi-a" a@v070
write_module "$SWAP_ROOT/osi-b" b@v070
`, prev: 'first-previous', captured: 1, helpers: 'v070' },
  };
  for (const [start, { setup, prev, captured, helpers }] of Object.entries(starts)) {
    const run = runModuleDeploy(`
${setup}
mkdir -p "$SWAP_ROOT/src-new-gui"
printf '%s\\n' new > "$SWAP_ROOT/new-flows.json"
printf '%s\\n' new > "$SWAP_ROOT/src-new-gui/index.html"
${legacyAttemptFunction()}
legacy_attempt first
[ "$PREV_STAMP" = ${prev} ] && [ "$PREV_CAPTURED" = ${captured} ]
[ "$PREV_CAPTURED" = 0 ] || write_payload_compatibility "$PREV_STAMP"
stop_for_migration
if (deploy_exit_handler 1); then exit 41; else rc=$?; fi
[ "$rc" = 1 ]
printf '%s\\n' first-meeting-rollback-ok
`);
    try {
      assert.equal(run.result.status, 0, `${start}: stdout=${run.result.stdout}\nstderr=${run.result.stderr}`);
      assert.match(run.result.stdout, /first-meeting-rollback-ok/, start);
      assert.match(run.result.stdout, new RegExp(`OK: captured osi-a into payloads/${prev}/modules/osi-a`), start);
      assert.doesNotMatch(run.result.stdout, /stale legacy-capture marker/, start);
      assert.deepEqual(run.markers(), { 'osi-a': `a@${helpers}`, 'osi-b': `b@${helpers}`, 'osi-c': 'MODULE_NOT_FOUND' }, start);
      assert.deepEqual(swap.currentPair(run.root, run.guiRoot), { flows: prev, gui: prev, compatible: true }, start);
    } finally {
      run.cleanup();
    }
  }
});

// A v0.7.0 deploy.sh after a pair deploy switches flows into a flows-only
// payload and writes the GUI and the helpers in place, through the GUI link.
// Flows and GUI then link into different payloads without any switch being
// cut, and the next deploy keeps that set as its rollback target.
test('a v0.7.0 deploy.sh run after a pair deploy does not block the next deploy', () => {
  const run = runModuleDeploy(`
printf '%s\\n' v070 > "$SWAP_ROOT/o070-flows.json"
swap_call stagePayload o070 "$SWAP_ROOT/o070-flows.json" >/dev/null
rm "$SWAP_ROOT/flows.json"
ln -s payloads/o070/flows.json "$SWAP_ROOT/flows.json"
printf '%s\\n' v070 > "$GUI_ROOT/index.html"
write_module "$SWAP_ROOT/osi-a" a@v070
write_module "$SWAP_ROOT/osi-b" b@v070
[ "$(swap_call guiStamp "$GUI_ROOT")" = old ]
mkdir -p "$SWAP_ROOT/src-new-gui"
printf '%s\\n' new > "$SWAP_ROOT/new-flows.json"
printf '%s\\n' new > "$SWAP_ROOT/src-new-gui/index.html"
${legacyAttemptFunction()}
legacy_attempt first
[ "$PREV_STAMP" = first-previous ] && [ "$PREV_CAPTURED" = 1 ]
write_payload_compatibility "$PREV_STAMP"
stop_for_migration
if (deploy_exit_handler 1); then exit 41; else rc=$?; fi
[ "$rc" = 1 ]
printf '%s\\n' v070-after-pair-ok
`);
  try {
    assert.equal(run.result.status, 0, `stdout=${run.result.stdout}\nstderr=${run.result.stderr}`);
    assert.match(run.result.stdout, /v070-after-pair-ok/);
    assert.match(run.result.stdout, /OK: captured existing flows\+GUI pair as payloads\/first-previous/);
    assert.deepEqual(run.markers(), { 'osi-a': 'a@v070', 'osi-b': 'b@v070', 'osi-c': 'MODULE_NOT_FOUND' });
    assert.deepEqual(swap.currentPair(run.root, run.guiRoot), { flows: 'first-previous', gui: 'first-previous', compatible: true });
    assert.equal(fs.readFileSync(path.join(run.guiRoot, 'index.html'), 'utf8'), 'v070\n', 'the restart serves the GUI that ran');
  } finally {
    run.cleanup();
  }
});

// Stages the real module files the way deploy.sh fetches them, flips, and
// requires every staged entry point and file through /srv/node-red/<module>
// and node_modules/<module>. Each must load exactly as it does from the repo
// tree; a '../<name>' that misses inside payloads/<stamp>/modules/ shows up
// here as MODULE_NOT_FOUND.
test('every shipped helper module loads through the payload links as it does from the repo', () => {
  const NODE_RED = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red';
  const root = fakeRoot();
  try {
    const fetch = new RegExp(String.raw`"${NODE_RED}/([^"]+)" \\\n\s+"([^"]+)"`, 'g');
    for (const [, rel, destination] of DEPLOY.matchAll(fetch)) {
      let target = null;
      if (destination.startsWith('$MODULE_STAGE/')) target = path.join(root, 'payloads', 'S', 'modules', destination.slice('$MODULE_STAGE/'.length));
      else if (destination.startsWith('$COMMAND_LEDGER_STAGE/')) target = path.join(root, destination.slice('$COMMAND_LEDGER_STAGE/'.length));
      else if (destination.startsWith('/srv/node-red/')) target = path.join(root, destination.slice('/srv/node-red/'.length));
      if (!target) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(REPO, NODE_RED, rel), target);
    }
    swap.stagePayload(root, 'S', flows(root, 'S'));
    const names = swap.sealModules(root, 'S');
    swap.flipTo(root, 'S');
    fs.mkdirSync(path.join(root, 'node_modules'));
    for (const entry of fs.readdirSync(path.join(REPO, NODE_RED, 'node_modules'))) {
      if (!entry.startsWith('osi-')) fs.symlinkSync(fs.realpathSync(path.join(REPO, NODE_RED, 'node_modules', entry)), path.join(root, 'node_modules', entry));
    }
    for (const name of names) fs.symlinkSync(path.join('..', name), path.join(root, 'node_modules', name));
    const entries = [];
    for (const name of names) {
      entries.push(name);
      for (const file of fs.readdirSync(path.join(root, 'payloads', 'S', 'modules', name))) {
        if (file.endsWith('.js') || file.endsWith('.json')) entries.push(path.join(name, file));
      }
    }
    const loadAll = (base, list = entries) => {
      const result = spawnSync(process.execPath, ['-e', `
        const path = require('path'); const out = {};
        for (const entry of JSON.parse(process.argv[2])) {
          try { require(path.join(process.argv[1], entry)); out[entry] = 'ok'; }
          catch (error) { out[entry] = (error.code || 'error') + ': ' + String(error.message).split('\\n')[0]; }
        }
        process.stdout.write(JSON.stringify(out));
        process.exit(0);
      `, base, JSON.stringify(list)], { encoding: 'utf8', env: { ...process.env, OSI_LIB_BASE: base } });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const staged = loadAll(root);
    const viaNodeModules = loadAll(path.join(root, 'node_modules'), names);
    const repo = loadAll(path.join(REPO, NODE_RED));
    assert.ok(names.length >= 44 && entries.length > 150, `staged ${names.length} modules, ${entries.length} entries`);
    assert.ok(names.includes('osi-journal') && names.includes('osi-sdi12-normalize'));
    const differ = entries.filter((entry) => staged[entry] !== repo[entry]).map((entry) => `${entry}: ${staged[entry]} (repo: ${repo[entry]})`)
      .concat(names.filter((name) => viaNodeModules[name] !== repo[name]).map((name) => `node_modules/${name}: ${viaNodeModules[name]} (repo: ${repo[name]})`));
    assert.deepEqual(differ, []);
    assert.ok(Object.values(repo).filter((value) => value === 'ok').length > 150, 'the comparison must exercise loadable modules');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
