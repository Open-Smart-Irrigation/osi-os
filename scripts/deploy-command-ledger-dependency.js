#!/usr/bin/env node
'use strict';

// The ledger is loaded by Node-RED at process start and requires the binding
// next to it.  This installer deliberately has no network or repo knowledge:
// deploy.sh fetches it into its private temporary directory, verifies this
// file's pinned digest, then gives it already-fetched candidate files.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const FILES = {
  packageJson: ['osi-command-ledger', 'package.json'],
  ledgerIndex: ['osi-command-ledger', 'index.js'],
  bindingCanonicalization: ['osi-watermark-binding', 'canonicalization.js'],
};

function filePath(root, parts) {
  return path.join(root, ...parts);
}

function assertRegularFile(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    throw new Error(`${label} missing: ${file} (${error.code || error.message})`);
  }
  if (!stat.isFile()) throw new Error(`${label} is not a regular file: ${file}`);
}

function assertDirectoryOrMissing(directory, label) {
  let stat;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error(`${label} cannot be inspected: ${error.message}`);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory: ${directory}`);
  }
}

function assertNonSymlinkTarget(file, label) {
  try {
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${file}`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function validateLayout(stageDir, liveRoot) {
  assertDirectoryOrMissing(stageDir, 'staging root');
  assertDirectoryOrMissing(liveRoot, 'live root');
  if (!fs.existsSync(stageDir) || !fs.existsSync(liveRoot)) {
    throw new Error('staging and live roots must exist as directories');
  }
  const stageDevice = fs.statSync(stageDir).dev;
  const liveDevice = fs.statSync(liveRoot).dev;
  if (stageDevice !== liveDevice) {
    throw new Error('staging and live roots must be on the same filesystem');
  }
  for (const directory of ['osi-command-ledger', 'osi-watermark-binding']) {
    assertDirectoryOrMissing(path.join(stageDir, directory), `staged ${directory} directory`);
    assertDirectoryOrMissing(path.join(liveRoot, directory), `live ${directory} directory`);
  }
  for (const parts of Object.values(FILES)) {
    assertNonSymlinkTarget(filePath(liveRoot, parts), `live ${parts.join('/')}`);
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function validateHashes(stageDir, expectedHashes) {
  for (const [key, parts] of Object.entries(FILES)) {
    const file = filePath(stageDir, parts);
    assertRegularFile(file, `staged ${key}`);
    const expected = expectedHashes && expectedHashes[key];
    if (!/^[0-9a-f]{64}$/i.test(String(expected || ''))) {
      throw new Error(`missing trusted SHA-256 pin for ${key}`);
    }
    const actual = sha256(file);
    if (actual !== String(expected).toLowerCase()) {
      throw new Error(`SHA-256 checksum mismatch for ${key}: expected ${expected}, got ${actual}`);
    }
  }
}

function validatePackage(stageDir) {
  const packageFile = filePath(stageDir, FILES.packageJson);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  } catch (error) {
    throw new Error(`ledger package.json is invalid: ${error.message}`);
  }
  if (manifest.main !== 'index.js') {
    throw new Error(`ledger package main contract failed: expected index.js, got ${manifest.main}`);
  }
}

function validateSyntax(stageDir) {
  for (const [key, parts] of Object.entries(FILES)) {
    if (!key.endsWith('Index') && key !== 'bindingCanonicalization') continue;
    const file = filePath(stageDir, parts);
    try {
      cp.execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (error) {
      throw new Error(`staged ${key} syntax validation failed: ${error.stderr?.toString() || error.message}`);
    }
  }
}

function freshRequire(root, label) {
  const probe = [
    'const ledger = require(process.argv[1]);',
    "if (!ledger || typeof ledger.deduplicatePendingCommand !== 'function' || typeof ledger.queueCommandAck !== 'function') process.exit(42);",
  ].join('\n');
  try {
    cp.execFileSync(process.execPath, ['-e', probe, filePath(root, ['osi-command-ledger'])], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`${label} fresh-process load failed: ${error.stderr?.toString() || error.message}`);
  }
}

function validateCandidate(stageDir) {
  freshRequire(stageDir, 'staged candidate');
}

function validateOldLedgerWithCandidateBinding(liveRoot, stageDir) {
  const oldLedger = filePath(liveRoot, ['osi-command-ledger']);
  if (!fs.existsSync(oldLedger)) return;
  const compatibility = path.join(stageDir, '.compatibility-old-ledger');
  fs.mkdirSync(path.join(compatibility, 'osi-command-ledger'), { recursive: true });
  fs.mkdirSync(path.join(compatibility, 'osi-watermark-binding'), { recursive: true });
  fs.copyFileSync(filePath(oldLedger, ['package.json']), filePath(compatibility, ['osi-command-ledger', 'package.json']));
  fs.copyFileSync(filePath(oldLedger, ['index.js']), filePath(compatibility, ['osi-command-ledger', 'index.js']));
  fs.copyFileSync(filePath(stageDir, FILES.bindingCanonicalization), filePath(compatibility, FILES.bindingCanonicalization));
  freshRequire(compatibility, 'installed-old-ledger plus candidate-binding');
}

function checkpoint(options, name) {
  if (options.checkpoint !== name) return;
  if (options.checkpointMarker) fs.writeFileSync(options.checkpointMarker, name);
  // SIGSTOP is deterministic and lets the harness kill the process at the
  // exact boundary; no polling or timing assumptions are involved.
  fs.writeSync(1, `CHECKPOINT ${name}\n`);
  process.kill(process.pid, 'SIGSTOP');
}

function defaultRename(from, to) {
  fs.renameSync(from, to);
}

function install(options) {
  if (!options || typeof options !== 'object') throw new Error('installer options are required');
  if (!options.stageDir || !options.liveRoot) throw new Error('stage and live roots are required');
  const stageDir = path.resolve(String(options.stageDir || ''));
  const liveRoot = path.resolve(String(options.liveRoot || ''));
  if (!stageDir || !liveRoot || stageDir === liveRoot) throw new Error('stage and live roots must be distinct');

  validateLayout(stageDir, liveRoot);
  validateHashes(stageDir, options.expectedHashes);
  validatePackage(stageDir);
  validateSyntax(stageDir);
  validateCandidate(stageDir);
  validateOldLedgerWithCandidateBinding(liveRoot, stageDir);
  checkpoint(options, 'after-staging');

  // Deploys stage the candidate while the previous payload and database are
  // still live.  Keep the old ledger pair active until migration 0068 has
  // committed: the new index classifies WATERMARK's legacy soil-depth shape
  // as protected and writes 0068-only columns, while an interrupted deploy
  // must remain restartable against the pre-0068 database and flows.
  if (options.deferActivation === true) {
    return { activated: false, staged: true };
  }

  const rename = options.rename || defaultRename;
  const bindingFrom = filePath(stageDir, FILES.bindingCanonicalization);
  const bindingTo = filePath(liveRoot, FILES.bindingCanonicalization);
  const packageFrom = filePath(stageDir, FILES.packageJson);
  const packageTo = filePath(liveRoot, FILES.packageJson);
  const ledgerFrom = filePath(stageDir, FILES.ledgerIndex);
  const ledgerTo = filePath(liveRoot, FILES.ledgerIndex);
  fs.mkdirSync(path.dirname(bindingTo), { recursive: true });
  fs.mkdirSync(path.dirname(packageTo), { recursive: true });
  fs.mkdirSync(path.dirname(ledgerTo), { recursive: true });

  // The old ledger has already been proven to load with the candidate binding,
  // so this first rename leaves a runnable intermediate pair.  Neither live
  // file is renamed away or copied in place: rename(2) replaces one pathname
  // atomically on the same /srv/node-red filesystem.
  rename(bindingFrom, bindingTo);
  checkpoint(options, 'after-binding');
  // The package contract was validated independently; with the old index still
  // present, this intermediate state remains loadable.  The final index then
  // sees the candidate binding and package metadata.
  rename(packageFrom, packageTo);
  rename(ledgerFrom, ledgerTo);
  freshRequire(liveRoot, 'activated ledger');
  return { activated: true };
}

if (require.main === module) {
  if (process.argv[2] !== '--install') {
    console.error('usage: deploy-command-ledger-dependency.js --install <json-options>');
    process.exit(2);
  }
  try {
    install(JSON.parse(process.argv[3]));
  } catch (error) {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  }
}

module.exports = { install, sha256 };
