#!/usr/bin/env node
// Issue #356 one-shot flows.json editor (plan r3). Run from the repo root of
// the implementation checkout, through the campaign heavy wrapper:
//   node <packet-dir>/apply-flow-edits.cjs <packet-dir>           # edit
//   node <packet-dir>/apply-flow-edits.cjs <packet-dir> --check   # pins only, writes nothing
// It edits four function nodes in the canonical bcm2712 flows.json and writes
// the same bytes to the bcm2709 mirror. Before writing it refuses unless both
// profiles round-trip byte-identically, are byte-identical to each other, each
// touched node's func matches the pinned base f6682ef6 by SHA-256, and each
// proposal file matches its pinned SHA-256. After writing it re-reads both
// files and refuses unless they round-trip, are identical, carry the expected
// four bodies and leave every other node unchanged.
'use strict';
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = process.cwd();
const PACKET_DIR = path.resolve(process.argv[2] || '');
const CHECK_ONLY = process.argv[3] === '--check';
const CANONICAL = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json');
const MIRROR = path.join(REPO_ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json');

// SHA-256 of each node's func string (UTF-8) at
// f6682ef6d0d90355bded9789fb4d423136ab02bb, identical in both profiles. If the
// implementation base changed one of these nodes, the editor refuses: re-plan
// against the new body instead of editing these values.
const BASE_FUNC_SHA256 = {
  d0b2b1c1a937e16d: 'c0e4fdef1c4a3917517aa81e4d741801ac3a9d5f4417960e5253f15081971bca',
  'chameleon-readings-insert-fn': 'f27d1bd88b9acb3be357b0eb5d7167bf8b4bcd862cf9e248a05e58693f15f515',
  '460e0bfd95f89e67': 'c5cdded4e470ae56a9c32a13385d08409c6f4f02ad3f741ec0038dfb2084e9e9',
  d20948dd9120a3d2: '809c0172a1039d1f13b8ef38313b72a5a01ff5b50cccca4882c275a4112d0bf4',
};

// Nodes the tests drive but #356 does not edit: the legacy decision node and
// calibration-persist. A changed body invalidates the test forecasts.
const DEPENDENCY_FUNC_SHA256 = {
  '5f0d2b7e9b9b1b3a': '76aa49bc93318897ebf82e800de70f8daacd7f30a5d0f4229c7abb66fca96896',
  '51c0ae3799c97131': 'bef6c800ff9c8d59dbb25608f3d2c915400b5b51ad7ead2f52077272459e8816',
};

// Proposal files: SHA-256 of the file bytes (body plus one trailing newline).
const PROPOSALS = {
  d0b2b1c1a937e16d: { file: 'scheduler-mean-query.func.js', sha256: '88b03650f2299116e516f41bada379935c0692e3011e49b7b22fbc659f26a54c' },
  'chameleon-readings-insert-fn': { file: 'insert-chameleon-reading.func.js', sha256: 'f61363e4215be437ab5abfb470d1096236dd60dddae5434775a6a30e324b95d1' },
  d20948dd9120a3d2: { file: 'calibration-local-backfill.func.js', sha256: '555f008c4f209f6f87c8332c7a757d157d5528e1b9614c099c8509f825080f8a' },
};

// Expected func after the edit: SHA-256 and verify-flows-size-ratchet length
// (JavaScript string length) per node.
const EXPECTED = {
  d0b2b1c1a937e16d: { sha256: 'e2d5864fed525951e0808323e177c69893cce9e068b631bf42495784ecc63cc6', baseChars: 2425, chars: 4596 },
  'chameleon-readings-insert-fn': { sha256: '168f26491a1ecde672ec4e789bf12313c41481136c76aed916e53f2a21298490', baseChars: 3384, chars: 5395 },
  '460e0bfd95f89e67': { sha256: '1cc092d2b32ed75f9ec3117dfe2f66fa9ba4455d382d3c16776ba4db3b6354a5', baseChars: 9835, chars: 10007 },
  d20948dd9120a3d2: { sha256: '72e2059409898c013477e0026f7237c4bfe794e9281378b276f564de50f39b97', baseChars: 2242, chars: 3236 },
};

const NORMALIZE_ANCHOR = '    if (result.rainObservation) d.rainObservationId = result.rainObservation.id;\n';
const NORMALIZE_INSERT =
  '    // Issue #356: Insert Chameleon Reading links its diagnostic to this row id.\n' +
  '    d.deviceDataId = result.writeResult.inserted ? result.writeResult.deviceDataId : null;\n';

function sha256(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function serialize(flows) { return Buffer.from(JSON.stringify(flows, null, 2) + '\n', 'utf8'); }
function fail(message) { console.error('apply-flow-edits: ' + message); process.exit(2); }

function loadGuarded(filePath) {
  const original = fs.readFileSync(filePath);
  const parsed = JSON.parse(original.toString('utf8'));
  if (!Array.isArray(parsed)) fail(filePath + ' is not a JSON array');
  if (Buffer.compare(original, serialize(parsed)) !== 0) fail('roundtrip guard failed for ' + filePath);
  return { original, parsed };
}

function proposalBody(id) {
  const { file, sha256: expected } = PROPOSALS[id];
  const raw = fs.readFileSync(path.join(PACKET_DIR, file));
  if (sha256(raw) !== expected) fail(file + ' differs from its pinned SHA-256');
  const text = raw.toString('utf8');
  if (!text.endsWith('\n') || text.endsWith('\n\n')) fail(file + ' must end with exactly one newline');
  return text.slice(0, -1);
}

function functionNode(flows, id) {
  const matches = flows.filter((n) => n && n.id === id);
  if (matches.length !== 1 || matches[0].type !== 'function' || typeof matches[0].func !== 'string') {
    fail('expected one function node ' + id);
  }
  return matches[0];
}

const canonical = loadGuarded(CANONICAL);
const mirror = loadGuarded(MIRROR);
if (Buffer.compare(canonical.original, mirror.original) !== 0) fail('profiles differ before the edit');
const before = JSON.parse(canonical.original.toString('utf8'));
const flows = canonical.parsed;

for (const id of Object.keys(BASE_FUNC_SHA256)) {
  if (sha256(functionNode(flows, id).func) !== BASE_FUNC_SHA256[id]) fail('node ' + id + ' func differs from the pinned base');
}
for (const id of Object.keys(DEPENDENCY_FUNC_SHA256)) {
  if (sha256(functionNode(flows, id).func) !== DEPENDENCY_FUNC_SHA256[id]) fail('dependency node ' + id + ' func differs from the pinned base');
}
for (const id of Object.keys(PROPOSALS)) proposalBody(id);
if (CHECK_ONLY) {
  console.log('apply-flow-edits: pins OK, nothing written');
  process.exit(0);
}

for (const id of Object.keys(PROPOSALS)) functionNode(flows, id).func = proposalBody(id);
const write = functionNode(flows, '460e0bfd95f89e67');
const anchorCount = write.func.split(NORMALIZE_ANCHOR).length - 1;
if (anchorCount !== 1) fail('LSN50 Normalize + Write anchor found ' + anchorCount + ' times');
write.func = write.func.replace(NORMALIZE_ANCHOR, NORMALIZE_ANCHOR + NORMALIZE_INSERT);

for (const [id, want] of Object.entries(EXPECTED)) {
  const func = functionNode(flows, id).func;
  if (sha256(func) !== want.sha256 || func.length !== want.chars) fail('node ' + id + ' does not match the expected edited body');
}

const out = serialize(flows);
fs.writeFileSync(CANONICAL, out);
fs.writeFileSync(MIRROR, out);

// Post-write checks on the bytes actually on disk.
const afterCanonical = loadGuarded(CANONICAL);
const afterMirror = loadGuarded(MIRROR);
if (Buffer.compare(afterCanonical.original, out) !== 0) fail('canonical profile on disk differs from the written bytes');
if (Buffer.compare(afterMirror.original, out) !== 0) fail('mirror profile on disk differs from the written bytes');
const after = afterCanonical.parsed;
if (after.length !== before.length) fail('node count changed');
for (let i = 0; i < before.length; i += 1) {
  const id = before[i] && before[i].id;
  if (!after[i] || after[i].id !== id) fail('node order changed at index ' + i);
  if (Object.prototype.hasOwnProperty.call(EXPECTED, id)) {
    const { func: oldFunc, ...oldRest } = before[i];
    const { func: newFunc, ...newRest } = after[i];
    if (JSON.stringify(oldRest) !== JSON.stringify(newRest)) fail('node ' + id + ' changed outside func');
    if (sha256(newFunc) !== EXPECTED[id].sha256) fail('node ' + id + ' func on disk is not the expected body');
  } else if (JSON.stringify(before[i]) !== JSON.stringify(after[i])) {
    fail('untouched node ' + id + ' changed');
  }
}

for (const [id, want] of Object.entries(EXPECTED)) {
  console.log('apply-flow-edits: ' + id + ' ' + want.baseChars + ' -> ' + want.chars + ' chars (+' + (want.chars - want.baseChars) + ')');
}
console.log('apply-flow-edits: wrote both profiles, sha256 ' + sha256(out));
