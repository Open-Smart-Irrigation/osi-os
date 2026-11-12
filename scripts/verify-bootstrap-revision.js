#!/usr/bin/env node
'use strict';

// osi-bootstrap runs whichever chirpstack-bootstrap.js copy (deployed in
// /srv/node-red, or the image copy in /usr/share/node-red) declares the
// higher OSI_BOOTSTRAP_REVISION. That rule is only sound while every change
// to the script raises the revision, so a newer copy never loses to an older
// one. This check fails when the script differs from the base ref without a
// higher revision, when the line is missing or malformed, or when an image
// copy differs from scripts/chirpstack-bootstrap.js.
//
// Usage: node scripts/verify-bootstrap-revision.js [--base-ref <ref>] [--root <dir>]
// The base ref defaults to OSI_BOOTSTRAP_BASE_REF, then origin/main. An
// unreadable base ref fails closed.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCRIPT_REL = 'scripts/chirpstack-bootstrap.js';
const IMAGE_COPIES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/chirpstack-bootstrap.js',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/chirpstack-bootstrap.js',
];
// The same pattern the init script's sed uses.
const REVISION_LINE = /^const OSI_BOOTSTRAP_REVISION = ([0-9]+);/m;

function revisionOf(source) {
  const lines = source.split('\n').filter((line) => line.startsWith('const OSI_BOOTSTRAP_REVISION'));
  if (!lines.length) return 0;
  const match = source.match(REVISION_LINE);
  if (lines.length !== 1 || !match) return null;
  return Number(match[1]);
}

function check({ root, baseRef }) {
  const problems = [];
  const current = fs.readFileSync(path.join(root, SCRIPT_REL), 'utf8');
  const revision = revisionOf(current);
  if (revision === null) problems.push(`${SCRIPT_REL}: OSI_BOOTSTRAP_REVISION must be one line "const OSI_BOOTSTRAP_REVISION = <n>;"`);
  else if (revision < 1) problems.push(`${SCRIPT_REL}: OSI_BOOTSTRAP_REVISION is missing`);
  for (const rel of IMAGE_COPIES) {
    const copy = path.join(root, rel);
    if (fs.existsSync(copy) && fs.readFileSync(copy, 'utf8') !== current) {
      problems.push(`${rel} differs from ${SCRIPT_REL}`);
    }
  }
  let base;
  try {
    base = execFileSync('git', ['-C', root, 'show', `${baseRef}:${SCRIPT_REL}`], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = error.stderr ? error.stderr.toString().trim() : error.message;
    problems.push(`base ref unusable, failing closed: cannot read ${SCRIPT_REL} at ${baseRef}: ${stderr}`);
    return problems;
  }
  const baseRevision = revisionOf(base);
  if (base !== current && revision !== null && baseRevision !== null && revision <= baseRevision) {
    problems.push(`${SCRIPT_REL} changed since ${baseRef} but OSI_BOOTSTRAP_REVISION stayed at ${revision} (base ${baseRevision}); raise it`);
  }
  return problems;
}

function main(argv) {
  let root = path.resolve(__dirname, '..');
  let baseRef = process.env.OSI_BOOTSTRAP_BASE_REF || 'origin/main';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--base-ref') baseRef = argv[++i];
    else if (argv[i] === '--root') root = path.resolve(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  const problems = check({ root, baseRef });
  if (problems.length) {
    for (const problem of problems) console.error(`FAIL ${problem}`);
    process.exit(1);
  }
  console.log(`verify-bootstrap-revision: OK (revision ${revisionOf(fs.readFileSync(path.join(root, SCRIPT_REL), 'utf8'))}, base ${baseRef})`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { revisionOf, check };
