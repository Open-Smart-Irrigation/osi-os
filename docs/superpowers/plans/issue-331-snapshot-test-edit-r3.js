#!/usr/bin/env node
'use strict';

// Issue #331 R3 test-first step. Run once from the root of the clean, P-based
// osi-os implementation checkout, before the flow editor:
//   node docs/superpowers/plans/issue-331-snapshot-test-edit-r3.js
// It replaces scripts/test-valve-actuation-bootstrap.js with the reviewed target
// committed beside this file. It writes nothing unless the current test file is
// the P version and the target matches its reviewed hash. This file is a review
// artifact until the plan's execution stage.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = fs.realpathSync(process.cwd());
const planDir = path.join(root, 'docs/superpowers/plans');
const testPath = path.join(root, 'scripts/test-valve-actuation-bootstrap.js');
const targetPath = path.join(planDir, 'issue-331-snapshot-test-target-r3.js');
// SHA-256 of the P blob 10b8cb6bfb7dbcfa266b6a2ce58c5518d5f553b5.
const preImageSha256 = 'f4224bb6e6c3282bc5d7b26c0379971b47570a65e7901a787329799fa999deb8';
const targetSha256 = '66bcc1cd5bc7f69260a7af6a5384f4e220a5e32a52ffcadbdb611d008011ab6d';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

assert.equal(fs.realpathSync(__dirname), planDir, 'run the committed editor from the repo root that contains it');

const before = fs.readFileSync(testPath);
assert.equal(sha256(before), preImageSha256, 'pre-image must be the P snapshot test');
const target = fs.readFileSync(targetPath);
assert.equal(sha256(target), targetSha256, 'target must be the reviewed R3 test');

fs.writeFileSync(testPath, target);

const after = fs.readFileSync(testPath);
assert.equal(Buffer.compare(after, target), 0, 'written test equals the reviewed target');
assert.equal(sha256(after), targetSha256, 'post-image hash');
console.log(`issue-331 test editor: scripts/test-valve-actuation-bootstrap.js ${preImageSha256} -> ${targetSha256}`);
