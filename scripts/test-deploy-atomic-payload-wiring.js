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
