#!/usr/bin/env node
'use strict';
// The archive checksum authenticates transport relative to the operator's
// sidecar. This inventory proves extraction is complete before deploy starts.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MANIFEST = 'bundle-manifest.json';

function inventory(root, relative = '', files = Object.create(null)) {
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    const rel = relative ? `${relative}/${name}` : name;
    if (!/^[a-zA-Z0-9_.\/-]+$/.test(rel) || name === '.' || name === '..') throw new Error(`unsupported file name: ${rel}`);
    const full = path.join(root, rel);
    const stat = fs.lstatSync(full);
    if (stat.isDirectory()) inventory(root, rel, files);
    else if (stat.isFile() && stat.nlink === 1) {
      if (rel !== MANIFEST) files[rel] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    } else throw new Error(`not a regular unlinked file or directory: ${rel}`);
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

function main([mode, root, sourceCommit]) {
  if (!['create', 'verify'].includes(mode) || !root) throw new Error('usage: deploy-bundle-manifest.js create|verify <root> [source-commit]');
  const files = inventory(root);
  const file = path.join(root, MANIFEST);
  if (mode === 'create') {
    if (!sourceCommit || !/^[a-zA-Z0-9_-]+$/.test(sourceCommit)) throw new Error('source commit label required');
    fs.writeFileSync(file, JSON.stringify({ schema: 'osi-deploy-bundle/1', source_commit: sourceCommit, files }, null, 2) + '\n');
    return;
  }
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (manifest.schema !== 'osi-deploy-bundle/1' || typeof manifest.source_commit !== 'string' ||
      !manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== 'object') throw new Error('invalid bundle manifest');
  const expected = manifest.files;
  for (const rel of new Set([...Object.keys(files), ...Object.keys(expected)])) {
    if (!Object.hasOwn(files, rel) || !Object.hasOwn(expected, rel) || files[rel] !== expected[rel]) throw new Error(`bundle manifest mismatch: ${rel}`);
  }
  if (!Object.keys(expected).length) throw new Error('empty bundle manifest');
  console.log(`OK: verified ${Object.keys(files).length} bundle files (source ${manifest.source_commit})`);
}
try { main(process.argv.slice(2)); }
catch (error) { console.error(`ERROR: ${error.message}`); process.exitCode = 1; }
