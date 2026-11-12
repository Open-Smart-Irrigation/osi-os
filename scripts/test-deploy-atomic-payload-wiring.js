#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const deploy = fs.readFileSync(path.resolve(__dirname, '..', 'deploy.sh'), 'utf8');

const NODE_RED_ROOT = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red';

// Helper modules are fetched into the payload deploy.sh stages ($MODULE_STAGE,
// payloads/<stamp>/modules); the command ledger into its own pinned stage.
const MODULE_DESTINATION_ROOTS = {
  'osi-journal': '$MODULE_STAGE',
  'osi-command-ledger': '$COMMAND_LEDGER_STAGE',
};

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
  return filename.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

// Builds the same block pattern the original hardcoded assertions used
// (label line + source path line + dest path line, joined by a line
// continuation backslash and one-or-more newlines), parameterized on module
// name + filename so it can be applied to any fenced module's full discovered
// file set instead of a hand-picked list.
function fetchBlockPattern(moduleName, filename, destinationRoot = MODULE_DESTINATION_ROOTS[moduleName]) {
  assert.ok(destinationRoot, `test setup assumption broken: no destination root for ${moduleName}`);
  const escaped = escapeForRegex(filename);
  const escapedDestination = escapeForRegex(`${destinationRoot}/${moduleName}/${filename}`);
  return new RegExp(
    String.raw`fetch_required "${moduleName} ${escaped}" \\\n+\s+"${NODE_RED_ROOT}/${moduleName}/${escaped}" \\\n+\s+"${escapedDestination}"`
  );
}

// Pure function: given deploy.sh source text and the expected file list,
// returns the filenames that do NOT have a matching fetch_required block.
// Kept pure (no fs/module-scope reads) so it can be exercised against doctored
// input in the negative self-test below.
function missingFetches(deploySource, moduleName, fileList) {
  return fileList.filter((filename) => !fetchBlockPattern(moduleName, filename).test(deploySource));
}

// NEW-27: without stat(1), the one-filesystem precondition of the switch is
// still checked, and a path whose filesystem cannot be read refuses.
test('same_fs_or_die checks the filesystem without stat and refuses what it cannot read', () => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  const start = indexOf('same_fs_or_die() {');
  const fn = deploy.slice(start, deploy.indexOf('\n}\n', start) + 3);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-same-fs-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const run = (a, b) => spawnSync('/bin/sh', ['-c', `${fn}\nsame_fs_or_die "$1" "$2"\necho same`, 'sh', a, b],
    { encoding: 'utf8', env: { PATH: bin } });
  try {
    fs.mkdirSync(path.join(dir, 'payloads'));
    const same = run(dir, path.join(dir, 'payloads'));
    assert.equal(same.status, 0, same.stderr);
    assert.match(same.stdout, /same/);
    const missing = run(dir, path.join(dir, 'absent'));
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /could not read the filesystem/);
    if (fs.existsSync('/proc/self') && fs.statSync('/proc/self').dev !== fs.statSync(dir).dev) {
      const other = run(dir, '/proc/self');
      assert.equal(other.status, 1);
      assert.match(other.stderr, /different filesystem/);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

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
  assert.match(deploy, /^same_fs_or_die \/srv\/node-red "\$PAYLOADS_ROOT"$/m);
  assert.doesNotMatch(deploy, /^[^#\n]*\bstat -c/m, 'the gateways have no stat(1) (NEW-27)');
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

test('module destination fence rejects live, wrong-stage, and cross-module destinations', () => {
  const cases = [
    {
      moduleName: 'osi-command-ledger',
      filename: 'index.js',
      badDestination: '/srv/node-red/osi-command-ledger/index.js',
    },
    {
      moduleName: 'osi-command-ledger',
      filename: 'index.js',
      badDestination: '$COMMAND_LEDGER_STAGE_WRONG/osi-command-ledger/index.js',
    },
    {
      moduleName: 'osi-journal',
      filename: 'index.js',
      badDestination: '$COMMAND_LEDGER_STAGE/osi-journal/index.js',
    },
    {
      moduleName: 'osi-journal',
      filename: 'index.js',
      badDestination: '/srv/node-red/osi-journal/index.js',
    },
  ];

  for (const { moduleName, filename, badDestination } of cases) {
    const expectedDestination = `${MODULE_DESTINATION_ROOTS[moduleName]}/${moduleName}/${filename}`;
    const doctoredDeploy = deploy.replace(`"${expectedDestination}"`, `"${badDestination}"`);
    assert.notEqual(doctoredDeploy, deploy, `test setup assumption broken: ${expectedDestination} not found`);
    assert.deepEqual(
      missingFetches(doctoredDeploy, moduleName, [filename]),
      [filename],
      `${moduleName} must reject destination ${badDestination}`
    );
  }
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
  const rollbackStart = indexOf('# payload rollback begin');
  const rollbackIdx = deploy.indexOf('swap_call flipTo "$PREV_STAMP"', rollbackStart);
  const restartIdx = deploy.indexOf('"$NODE_RED_INIT" restart', rollbackIdx);
  const discardIdx = deploy.indexOf('discardPayload "$DEPLOY_STAMP"', rollbackStart);

  assert.ok(prevIdx < flipIdx, 'previous payload must be captured before the new flip');
  assert.ok(flipIdx < rollbackIdx, 'rollback must happen only after the new payload was tried');
  assert.notEqual(restartIdx, -1, 'rollback must restart Node-RED after flipping back');
  assert.ok(restartIdx < discardIdx, 'failed activated payload must be discarded after rollback restart');
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
  const rollbackStart = indexOf('# payload rollback begin');
  const rollbackIdx = deploy.indexOf('swap_call flipTo "$PREV_STAMP"', rollbackStart);

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

test('the legacy-capture decision runs before deploy.sh replaces any live file', () => {
  const mainStart = deploy.indexOf('echo "=== OSI OS Deploy ==="');
  const nativePreflight = deploy.indexOf('run_native_sqlite3_preflight || exit 1', mainStart);
  const swapFetch = deploy.indexOf('fetch "scripts/deploy-payload-swap.js" "$SWAP_JS"', mainStart);
  const preflight = deploy.indexOf('swap_call legacyCapturePreflight "/srv/node-red/flows.json" "$GUI_ROOT"', mainStart);
  const settings = deploy.indexOf('fetch_required "Node-RED settings.js"', mainStart);
  assert.ok(mainStart !== -1 && nativePreflight > mainStart, 'native sqlite3 preflight runs first');
  assert.ok(swapFetch > nativePreflight, 'the swap helper is fetched after the native sqlite3 preflight');
  assert.ok(preflight > swapFetch, 'the legacy-capture preflight needs the swap helper');
  assert.ok(settings > preflight, 'the legacy-capture preflight runs before settings.js is replaced');
  assert.equal(deploy.slice(mainStart, preflight).includes('fetch_required "'), false,
    'no live file is fetched before the legacy-capture preflight');
  assert.equal(deploy.split('fetch "scripts/deploy-payload-swap.js"').length - 1, 1, 'the swap helper is fetched once');
});

test('post-flip restart decision uses the pre-activation state', () => {
  assert.match(deploy, /PAYLOAD_WAS_FLIPPED="\$PAYLOAD_FLIPPED"/);
  assert.match(deploy, /if \[ "\$PAYLOAD_WAS_FLIPPED" != "1" \]; then/);
});

// Issue #603: a module written into /srv/node-red before the payload flip
// changes what the previous flows load, and no rollback restored it.
const { LIVE_MODULES, LIVE_ENTRIES } = require('./deploy-payload-swap');
const MODULE_FETCH = new RegExp(String.raw`fetch_required "[^"]*" \\\n\s+"${NODE_RED_ROOT}/(osi-[a-z0-9-]+)/([^"]+)" \\\n\s+"([^"]+)"`, 'g');

function moduleFetches(source) {
  return [...source.matchAll(MODULE_FETCH)].map(([, name, file, destination]) => ({ name, file, destination }));
}

test('deploy.sh fetches every helper module into the staged payload, never into /srv/node-red', () => {
  assert.match(deploy, /^MODULE_STAGE="\$PAYLOADS_ROOT\/\$DEPLOY_STAMP\/modules"$/m);
  const fetches = moduleFetches(deploy);
  const staged = fetches.filter(({ name }) => !LIVE_MODULES.includes(name));
  assert.ok(staged.length > 100, `expected the full module block, parsed ${staged.length}`);
  const wrong = staged.filter(({ name, file, destination }) => destination !== `$MODULE_STAGE/${name}/${file}`);
  assert.deepEqual(wrong, [], 'every helper-module fetch must land in $MODULE_STAGE/<module>/<file>');
  assert.doesNotMatch(deploy, /"\/srv\/node-red\/osi-/, 'no osi-* module file may be written in place');
  for (const name of LIVE_MODULES) {
    assert.ok(fetches.filter((f) => f.name === name).every((f) => f.destination.startsWith('$COMMAND_LEDGER_STAGE/')),
      `${name} stays on the command-ledger staging path`);
  }
  // The fence catches a doctored in-place destination.
  const doctored = deploy.replace('"$MODULE_STAGE/osi-valve-control/index.js"', '"/srv/node-red/osi-valve-control/index.js"');
  assert.notEqual(doctored, deploy);
  assert.deepEqual(moduleFetches(doctored).filter(({ name, file, destination }) =>
    !LIVE_MODULES.includes(name) && destination !== `$MODULE_STAGE/${name}/${file}`).map((f) => f.name), ['osi-valve-control']);
});

test('deploy.sh seals, captures and links helper modules before npm install and the Node-RED stop', () => {
  const prevIdx = indexOf('PREV_STAMP="$(swap_call currentStamp || true)"');
  const lastModuleFetch = Math.max(...[...deploy.matchAll(MODULE_FETCH)]
    .filter((m) => m[3].startsWith('$MODULE_STAGE/')).map((m) => m.index));
  const begin = indexOf('# module payload staging begin');
  const sealIdx = indexOf('swap_call sealModules "$DEPLOY_STAMP"');
  const captureIdx = indexOf('swap_call captureModules "$PREV_STAMP" "$DEPLOY_STAMP"');
  const linkIdx = indexOf('swap_call linkNewModules "$DEPLOY_STAMP" "${PREV_STAMP:-}"');
  const end = indexOf('# module payload staging end');
  const npmIdx = indexOf('npm install --omit=dev --no-fund --no-audit');
  const migrationIdx = indexOf('run_schema_migration || exit 1');
  assert.ok(prevIdx < lastModuleFetch && lastModuleFetch < begin, 'the previous payload is known before the module block ends');
  assert.ok(begin < sealIdx && sealIdx < captureIdx && captureIdx < linkIdx && linkIdx < end,
    'seal, then capture into the previous payload, then link new modules');
  assert.ok(end < npmIdx && npmIdx < migrationIdx, 'npm install needs every file: dependency, before the stop');
});

test('deploy-time ChirpStack provisioning loads the helper staged with the new payload', () => {
  for (const marker of ['--repair-soil-profiles; then', 'CHIRPSTACK_API_KEY="$cs_api_key"']) {
    const idx = indexOf(marker);
    const line = deploy.slice(deploy.lastIndexOf('\n', idx) + 1, deploy.indexOf('\n', idx));
    assert.match(line, /OSI_CHIRPSTACK_HELPER="\$MODULE_STAGE\/osi-chirpstack-helper" node \/srv\/node-red\/chirpstack-bootstrap\.js/, line);
  }
  for (const copy of ['scripts', `${NODE_RED_ROOT}`, NODE_RED_ROOT.replace('bcm2712', 'bcm2709')]) {
    const bootstrap = fs.readFileSync(path.resolve(__dirname, '..', copy, 'chirpstack-bootstrap.js'), 'utf8');
    assert.match(bootstrap, /if \(process\.env\.OSI_CHIRPSTACK_HELPER\) \{\n\s+return require\(path\.resolve\(process\.env\.OSI_CHIRPSTACK_HELPER\)\);/, copy);
  }
});

// A payload module resolves require('../<name>') and __dirname-relative
// '../<name>' paths from its real path inside payloads/<stamp>/modules/, so
// <name> must be staged with it or be one of the live entries each payload
// links back to (the command-ledger pair, codecs/, edge-channels.json).
test('every parent-relative path in a helper module resolves inside the payload module set', () => {
  const staged = new Set(moduleFetches(deploy).map(({ name }) => name).filter((name) => !LIVE_MODULES.includes(name)));
  const root = path.resolve(__dirname, '..', NODE_RED_ROOT);
  const unresolved = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(file); continue; }
      if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js') || entry.name === 'test-helpers.js') continue;
      const source = fs.readFileSync(file, 'utf8');
      for (const [, sibling] of source.matchAll(/['"`]\.\.\/([^'"`/]+)/g)) {
        if (!staged.has(sibling) && !LIVE_ENTRIES.includes(sibling)) unresolved.push(`${path.relative(root, file)} -> ${sibling}`);
      }
    }
  };
  for (const name of staged) walk(path.join(root, name));
  assert.ok(staged.has('osi-journal') && staged.has('osi-valve-control'));
  assert.deepEqual(unresolved, []);
  for (const entry of LIVE_ENTRIES.filter((name) => !LIVE_MODULES.includes(name))) {
    assert.match(deploy, new RegExp(`"/srv/node-red/${entry.replace('.', '\\.')}[/"]`), `${entry} must still be written in place`);
  }
});

// The image seed runs on first boot and again after a sysupgrade. It must not
// replace a module a deploy linked into its payload, or the deployed flows
// would boot on the image's modules.
test('the image seed leaves payload-linked helper modules alone and seeds the rest', () => {
  const os = require('node:os');
  const { spawnSync } = require('node:child_process');
  const seeds = ['bcm2712', 'bcm2709'].map((profile) => fs.readFileSync(path.resolve(__dirname, '..',
    `conf/full_raspberrypi_bcm27xx_${profile}/files/etc/uci-defaults/98_osi_node_red_seed`), 'utf8'));
  assert.equal(seeds[0], seeds[1], 'both profiles ship the same seed');
  const loop = seeds[0].match(/^for module in [^\n]+; do\n[\s\S]*?\ndone\n/m);
  assert.ok(loop, 'seed module loop must stay extractable');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-seed-modules-'));
  try {
    const src = path.join(root, 'usr-share');
    const dst = path.join(root, 'srv');
    for (const name of ['osi-lib', 'osi-journal', 'osi-rain']) {
      fs.mkdirSync(path.join(src, name), { recursive: true });
      fs.writeFileSync(path.join(src, name, 'index.js'), `// ${name} image\n`);
    }
    fs.mkdirSync(path.join(dst, 'payloads', 'S', 'modules', 'osi-lib'), { recursive: true });
    fs.writeFileSync(path.join(dst, 'payloads', 'S', 'modules', 'osi-lib', 'index.js'), '// osi-lib deployed\n');
    fs.symlinkSync(path.join('payloads', 'S', 'modules', 'osi-lib'), path.join(dst, 'osi-lib'));
    fs.mkdirSync(path.join(dst, 'node_modules'));
    fs.symlinkSync(path.join('..', 'osi-lib'), path.join(dst, 'node_modules', 'osi-lib'));
    fs.mkdirSync(path.join(dst, 'osi-journal'));
    fs.writeFileSync(path.join(dst, 'osi-journal', 'index.js'), '// osi-journal stale\n');
    const result = spawnSync('sh', ['-c', `set -eu\nSEED_COPY=1\nSRC=${JSON.stringify(src)}\nDST=${JSON.stringify(dst)}\n${loop[0]}`], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readlinkSync(path.join(dst, 'osi-lib')), path.join('payloads', 'S', 'modules', 'osi-lib'));
    assert.equal(fs.readlinkSync(path.join(dst, 'node_modules', 'osi-lib')), path.join('..', 'osi-lib'));
    assert.equal(fs.readFileSync(path.join(dst, 'osi-lib', 'index.js'), 'utf8'), '// osi-lib deployed\n');
    assert.equal(fs.readFileSync(path.join(dst, 'osi-journal', 'index.js'), 'utf8'), '// osi-journal image\n');
    assert.equal(fs.readFileSync(path.join(dst, 'node_modules', 'osi-rain', 'index.js'), 'utf8'), '// osi-rain image\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
