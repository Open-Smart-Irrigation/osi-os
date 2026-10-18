#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const edgeRoot = path.resolve(__dirname, '..');
const cloudRoot = process.env.HISTORY_SOURCE_CLOUD_ROOT
  ? path.resolve(process.env.HISTORY_SOURCE_CLOUD_ROOT)
  : path.resolve(edgeRoot, '../../../osi-server/.worktrees/source-preserving-history');
const edgeFixtureRoot = path.join(edgeRoot, 'docs/contracts/history-source-v2');
const cloudFixtureRoot = path.join(cloudRoot, 'backend/src/test/resources/history-source-v2');
const manifest = JSON.parse(fs.readFileSync(path.join(edgeFixtureRoot, 'MANIFEST.json'), 'utf8'));

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

for (const relativePath of manifest.files) {
  const edgePath = path.join(edgeFixtureRoot, relativePath);
  const cloudPath = path.join(cloudFixtureRoot, relativePath);
  assert.equal(fs.existsSync(edgePath), true, `edge fixture exists: ${relativePath}`);
  assert.equal(fs.existsSync(cloudPath), true, `cloud fixture exists: ${relativePath}`);
  assert.equal(sha256(cloudPath), sha256(edgePath), `fixture bytes match: ${relativePath}`);
}

console.log(`history-source-v2 fixture parity PASS (${manifest.files.length} files)`);
