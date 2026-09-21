#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const deploy = fs.readFileSync(path.resolve(__dirname, '..', 'deploy.sh'), 'utf8');

const NODE_RED_ROOT = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red';

// Every osi-journal-adjacent module whose deploy.sh wiring this fence covers.
// osi-command-ledger was extracted out of osi-journal (2026-07-14, field-journal
// review Task 10): the fleet-wide command dedupe/ACK pipeline must not depend on
// osi-journal loading successfully, so it ships as its own fetch_required set.
const FENCED_MODULES = ['osi-journal', 'osi-command-ledger'].map((name) => ({
  name,
  relDir: `${NODE_RED_ROOT}/${name}`,
  dir: path.resolve(__dirname, '..', `${NODE_RED_ROOT}/${name}`),
}));

function indexOf(needle) {
  const idx = deploy.indexOf(needle);
  assert.notEqual(idx, -1, `missing deploy.sh snippet: ${needle}`);
  return idx;
}

// Directory-derived expected file set: package.json + every *.js except *.test.js.
// This is what makes the fence a fence — it is not a hand-maintained list, so a
// new/renamed module file automatically becomes a required deploy.sh target.
function listExpectedModuleFiles(moduleDir) {
  return fs
    .readdirSync(moduleDir)
    .filter((name) => name === 'package.json' || (name.endsWith('.js') && !name.endsWith('.test.js')))
    .sort();
}

function escapeForRegex(filename) {
  // Module filenames only ever contain word chars, '-' and '.'; only '.' is
  // regex-special among those, so that's the only character that needs escaping.
  return filename.replace(/\./g, '\\.');
}

// Builds the same block pattern the original hardcoded assertions used
// (label line + source path line + dest path line, joined by a line
// continuation backslash and one-or-more newlines), parameterized on module
// name + filename so it can be applied to any fenced module's full discovered
// file set instead of a hand-picked list.
function fetchBlockPattern(moduleName, filename) {
  const escaped = escapeForRegex(filename);
  return new RegExp(
    String.raw`fetch_required "${moduleName} ${escaped}" \\\n+\s+"${NODE_RED_ROOT}/${moduleName}/${escaped}" \\\n+\s+"/srv/node-red/${moduleName}/${escaped}"`
  );
}

// Pure function: given deploy.sh source text and the expected file list,
// returns the filenames that do NOT have a matching fetch_required block.
// Kept pure (no fs/module-scope reads) so it can be exercised against doctored
// input in the negative self-test below.
function missingFetches(deploySource, moduleName, fileList) {
  return fileList.filter((filename) => !fetchBlockPattern(moduleName, filename).test(deploySource));
}

for (const mod of FENCED_MODULES) {
  mod.expectedFiles = listExpectedModuleFiles(mod.dir);
}
// Back-compat alias: osi-journal was the only fenced module before Task 10.
const EXPECTED_JOURNAL_FILES = FENCED_MODULES.find((m) => m.name === 'osi-journal').expectedFiles;

test('deploy.sh fetches the tested payload-swap module and verifies same-filesystem atomicity', () => {
  assert.match(deploy, /PAYLOADS_ROOT="\/srv\/node-red\/payloads"/);
  assert.match(deploy, /SWAP_JS="\$TMP_DIR\/deploy-payload-swap\.js"/);
  assert.match(deploy, /fetch "scripts\/deploy-payload-swap\.js" "\$SWAP_JS"/);
  assert.match(deploy, /same_fs_or_die\(\)/);
  assert.match(deploy, /stat -c %d \/srv\/node-red/);
  assert.match(deploy, /stat -c %d "\$PAYLOADS_ROOT"/);
  assert.match(deploy, /typeof out === "boolean"\) process\.exit\(out \? 0 : 1\)/,
    'boolean swap results must propagate false as a nonzero shell status');
});

for (const mod of FENCED_MODULES) {
  test(`deploy.sh ships every ${mod.name} module file required by its package entry point`, () => {
    assert.ok(
      mod.expectedFiles.length > 0,
      `expected to discover at least one file under ${mod.relDir}`
    );

    const missing = missingFetches(deploy, mod.name, mod.expectedFiles);
    assert.deepEqual(
      missing,
      [],
      `deploy.sh is missing fetch_required wiring for ${mod.name} file(s): ${missing.join(', ')}`
    );
  });
}

test('missingFetches fence self-test: a doctored deploy.sh missing one fetch block is caught', () => {
  // Prove the fence actually closes: remove exactly one real fetch_required
  // block from a copy of deploy.sh's content and confirm missingFetches
  // reports that exact filename (not zero, not the wrong one, not everything).
  const targetFile = 'catalog.js';
  assert.ok(
    EXPECTED_JOURNAL_FILES.includes(targetFile),
    `test setup assumption broken: ${targetFile} is no longer among discovered osi-journal files`
  );

  const pattern = fetchBlockPattern('osi-journal', targetFile);
  assert.match(deploy, pattern, `expected real deploy.sh to already contain a fetch block for ${targetFile}`);

  const doctoredDeploy = deploy.replace(pattern, '');
  assert.notEqual(doctoredDeploy, deploy, 'doctoring must actually remove the fetch block from the copy');

  const missing = missingFetches(doctoredDeploy, 'osi-journal', EXPECTED_JOURNAL_FILES);
  assert.deepEqual(
    missing,
    [targetFile],
    'doctored deploy.sh (one fetch block removed) must report exactly the removed filename'
  );
});

test('deploy.sh stages flows before migration and flips only after migration succeeds', () => {
  const stageIdx = indexOf('swap_call stagePayload "$DEPLOY_STAMP" "$STAGED_FLOWS"');
  const migrationIdx = indexOf('run_schema_migration || exit 1');
  // Two `swap_call flipTo "$DEPLOY_STAMP"` sites exist since issue #222 / F4:
  // one inside run_schema_migration() itself (defined earlier in the file,
  // textually before this call site, but only EXECUTED after a successful
  // migrate-cli — covered by test-deploy-migration-wiring.js's own ordering
  // test) and this top-level one in the "Flip payload + local health
  // self-check" block, which only runs once run_schema_migration || exit 1
  // has already returned successfully. Look for the top-level occurrence
  // specifically (the first one at/after migrationIdx).
  const flipIdx = deploy.indexOf('swap_call flipTo "$DEPLOY_STAMP"', migrationIdx);

  assert.ok(stageIdx < migrationIdx, 'flows payload must be staged before schema migration');
  assert.ok(migrationIdx < flipIdx, 'the top-level flip must run only after run_schema_migration returns');
  assert.doesNotMatch(
    deploy,
    /fetch_required "flows\.json"[\s\S]*"\/srv\/node-red\/flows\.json"/,
    'deploy must not write flows.json in place'
  );
});

test('deploy.sh stages the GUI into the same payload before migration and activates the pair', () => {
  const guiFetchIdx = indexOf('fetch "react_gui.tar.gz" "$TMP_DIR/react_gui.tar.gz"');
  const guiExtractIdx = indexOf('tar xzf "$TMP_DIR/react_gui.tar.gz" -C "$STAGED_GUI"');
  const stageIdx = indexOf('swap_call stagePayload "$DEPLOY_STAMP" "$STAGED_FLOWS" "$STAGED_GUI"');
  const migrationIdx = indexOf('run_schema_migration || exit 1');
  const migrateIdx = indexOf('if node "$TMP_DIR/scripts/migrate-cli.js" "$DB_PATH"');
  const pairFlipIdx = indexOf('swap_call flipTo "$DEPLOY_STAMP" "$GUI_ROOT"');
  const restartIdx = deploy.indexOf('if ! restart_node_red; then', migrateIdx);

  assert.ok(guiFetchIdx < stageIdx, 'GUI must be fetched before payload staging');
  assert.ok(guiExtractIdx < stageIdx, 'GUI must be unpacked into staging before payload staging');
  assert.ok(stageIdx < migrationIdx, 'both payload halves must be staged before schema migration');
  assert.match(deploy, /captureExisting "\$PREV_STAMP" "\/srv\/node-red\/flows\.json" "\$GUI_ROOT"/,
    'a pre-existing in-place payload must be captured before activation');
  assert.ok(migrateIdx < pairFlipIdx, `paired activation follows migration (${migrateIdx} < ${pairFlipIdx})`);
  assert.ok(pairFlipIdx < restartIdx, `paired activation precedes restart (${pairFlipIdx} < ${restartIdx})`);
  assert.match(deploy, /GUI_ROOT="\/usr\/lib\/node-red\/gui"/);
  assert.doesNotMatch(deploy, /tar xzf "\$TMP_DIR\/react_gui\.tar\.gz" -C \/usr\/lib\/node-red\/gui\//,
    'GUI must not be extracted into the live directory after the health gate');
});

test('deploy.sh captures the previous payload before flip and rolls back to it on failed local self-check', () => {
  const migrationIdx = indexOf('run_schema_migration || exit 1');
  const prevIdx = indexOf('PREV_STAMP="$(swap_call currentStamp || true)"');
  const flipIdx = deploy.indexOf('swap_call flipTo "$DEPLOY_STAMP"', migrationIdx);
  const rollbackIdx = indexOf('swap_call flipTo "$PREV_STAMP"');
  const restartIdx = deploy.indexOf('"$NODE_RED_INIT" restart', rollbackIdx);

  assert.ok(prevIdx < flipIdx, 'previous payload must be captured before the new flip');
  assert.ok(flipIdx < rollbackIdx, 'rollback must happen only after the new payload was tried');
  assert.notEqual(restartIdx, -1, 'rollback must restart Node-RED after flipping back');
  assert.match(deploy, /AUTO-ROLLING-BACK the flows payload/);
  assert.match(deploy, /committed DB migration is NOT auto-undone/);
  assert.match(deploy, /verify_payload_db_compatibility "\$PREV_STAMP"/);
  assert.match(deploy, /swap_call flipTo "\$PREV_STAMP" "\$GUI_ROOT"/);
  assert.match(deploy, /discardPayload "\$DEPLOY_STAMP"/);
});

test('schema-init completion is required before the bounded /gui health gate', () => {
  const initBegin = indexOf('# init log check begin');
  const healthCall = indexOf('if wait_for_node_red_health "$NODE_RED_HEALTH_TIMEOUT"; then');
  const initResult = deploy.indexOf('sync-init: schema init complete', initBegin);
  assert.ok(initBegin < initResult && initResult < healthCall,
    'schema-init completion must be checked before /gui readiness');
  const healthHelper = deploy.slice(deploy.indexOf('wait_for_node_red_health() {'), healthCall);
  assert.ok(healthHelper.indexOf('node_red_state="$(node_red_service_state)"') < healthHelper.indexOf('127.0.0.1:1880/gui'),
    'the health helper proves named service state before /gui');
  assert.match(deploy, /NODE_RED_HEALTH_TIMEOUT:-30/);
  assert.match(deploy, /sleep 1/);
});

test('deploy.sh uses a local self-check on the Pi and leaves cloud canary gate to the operator', () => {
  assert.match(deploy, /node_red_service_state/);
  assert.doesNotMatch(deploy, /pgrep\s+-f\s+['"]node-red['"]/, 'health must use the named procd service, not command-line matches');
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

test('deploy exit cleanup runs only for failed first deployments', () => {
  const exitStart = indexOf('deploy_exit_handler() {');
  const exitEnd = indexOf('install_deploy_exit_trap() {');
  const exitHandler = deploy.slice(exitStart, exitEnd);
  const statusGate = exitHandler.search(/if .*\$exit_status.*-ne 0/);
  const cleanupCall = exitHandler.indexOf('cleanup_failed_first_payload');
  assert.ok(statusGate >= 0 && statusGate < cleanupCall, 'successful first deploys must not clean up their active payload');
  assert.match(exitHandler, /DB_MIGRATION_COMMITTED/);
});

test('rollback stops and proves Node-RED stopped before compatibility or link activation', () => {
  const rollbackIdx = deploy.lastIndexOf('if [ -n "${PREV_STAMP:-}" ]; then');
  assert.notEqual(rollbackIdx, -1, 'health rollback branch must exist');
  const stopIdx = deploy.indexOf('hold_node_red_stopped', rollbackIdx);
  const compatibilityIdx = deploy.indexOf('verify_payload_db_compatibility', rollbackIdx);
  const flipIdx = deploy.indexOf('swap_call flipTo "$PREV_STAMP"', rollbackIdx);
  assert.ok(rollbackIdx < stopIdx && stopIdx < compatibilityIdx && compatibilityIdx < flipIdx,
    'rollback must stop/prove service state before compatibility proof and activation');
});

test('verified rollback is preserved through the EXIT handler while returning deploy failure', () => {
  assert.match(deploy, /ROLLBACK_RESTORED=1/);
  assert.match(deploy, /preserving the verified rollback pair while returning deploy failure/);
  assert.match(deploy, /if \[ "\$\{ROLLBACK_RESTORED:-0\}" = "1" \] && \[ "\$exit_status" -ne 0 \]/);
});

test('legacy regular payload capture persists evidence across retries', () => {
  assert.match(deploy, /legacyCaptureStamp/);
  assert.match(deploy, /refusing recapture/);
  assert.match(deploy, /PREV_CAPTURED=0/);
});

test('missing legacy GUI skips retained capture so the staged pair can activate', () => {
  assert.match(deploy, /\[ ! -d "\$GUI_ROOT" \][\s\S]*skipping retained-pair capture/);
  assert.match(deploy, /\[ -f \/srv\/node-red\/flows\.json \] && \[ -d "\$GUI_ROOT" \]/);
});

test('post-flip restart decision uses the pre-activation state', () => {
  assert.match(deploy, /PAYLOAD_WAS_FLIPPED="\$PAYLOAD_FLIPPED"/);
  assert.match(deploy, /if \[ "\$PAYLOAD_WAS_FLIPPED" != "1" \]; then/);
});
