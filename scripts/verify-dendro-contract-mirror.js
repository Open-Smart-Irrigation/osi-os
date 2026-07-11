'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SOURCE_ROOT = path.join(__dirname, '../docs/contracts/dendro');
const DEFAULT_SERVER_ROOT = path.join(__dirname, '../osi-server');
const MIRROR_RELATIVE_ROOT = 'backend/src/test/resources/contracts/dendro';

function readManifest(sourceRoot) {
  const manifestPath = path.join(sourceRoot, 'MANIFEST.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest || !Array.isArray(manifest.cases)) {
    throw new Error(`${manifestPath} must contain a cases array`);
  }
  return manifest;
}

function expectedRelativeFiles(sourceRoot) {
  const manifest = readManifest(sourceRoot);
  const files = ['MANIFEST.json'];
  for (const caseName of manifest.cases) {
    files.push(`cases/${caseName}.input.json`);
    files.push(`cases/${caseName}.expected.json`);
  }
  return files.sort();
}

function listJsonFiles(root) {
  const files = [];
  function walk(dir, prefix) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, relative);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        files.push(relative);
      }
    }
  }
  walk(root, '');
  return files.sort();
}

function verifyMirror({ sourceRoot = DEFAULT_SOURCE_ROOT, serverRoot = DEFAULT_SERVER_ROOT } = {}) {
  const source = path.resolve(sourceRoot);
  const mirror = path.join(path.resolve(serverRoot), MIRROR_RELATIVE_ROOT);
  const expectedFiles = expectedRelativeFiles(source);
  const expectedSet = new Set(expectedFiles);
  const mirrorFiles = listJsonFiles(mirror);
  const failures = [];

  for (const relative of expectedFiles) {
    const sourceFile = path.join(source, relative);
    const mirrorFile = path.join(mirror, relative);
    if (!fs.existsSync(mirrorFile)) {
      failures.push(`missing mirror: ${relative}`);
      continue;
    }
    const sourceBytes = fs.readFileSync(sourceFile);
    const mirrorBytes = fs.readFileSync(mirrorFile);
    if (!sourceBytes.equals(mirrorBytes)) {
      failures.push(`byte mismatch: ${relative}`);
    }
  }

  for (const relative of mirrorFiles) {
    if (!expectedSet.has(relative)) {
      failures.push(`extra mirror: ${relative}`);
    }
  }

  return failures;
}

function main(argv) {
  const serverRoot = argv[2] || DEFAULT_SERVER_ROOT;
  const failures = verifyMirror({ serverRoot });
  if (failures.length) {
    console.error('Dendro contract mirror is out of sync:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('Dendro contract mirror matches osi-os source fixtures');
}

if (require.main === module) {
  main(process.argv);
}

module.exports = {
  MIRROR_RELATIVE_ROOT,
  verifyMirror,
};
