#!/usr/bin/env node
'use strict';
// verify-flows-size-ratchet - refactor-program A0 (repair commit 3).
//
// Absolute-ceiling ratchet over maintained flows.json profiles. Earlier versions of this
// script compared HEAD against a moving --base-ref (default origin/main) using deltas
// recorded in the allowances file. That was a false green: once origin/main itself
// advanced to include an allowed change, the delta-vs-base comparison stopped meaning
// anything (base already contained the growth), so the ratchet silently stopped
// enforcing what its own committed allowances claimed to bound. See
// docs/superpowers/plans/2026-07-15-refactor-repair-program.md, Task A0.
//
// The fix: every ceiling is a committed, reviewed ABSOLUTE maximum, not a delta.
//   1. Every function node must have an allowances entry and may not exceed its
//      committed max_chars, ever - regardless of git history.
//   2. Each maintained profile's total embedded function JS may not exceed the
//      committed max_total.
// Missing or unused allowances fail closed, so the measured node-id set and committed
// allowance-id set are exact equals. Raising a ceiling is a reviewed, explicit edit to
// the allowances file - there is no --write-baseline/--baseline autoregeneration path.
const fs = require('node:fs');
const path = require('node:path');
const { nodeSizes, totalChars } = require('./flows-size-scan');

const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_SURFACES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];

function raise(msg) { throw new Error(msg); }

function parseArgs(argv) {
  const o = {
    root: repoRoot,
    allowancesPath: path.join(repoRoot, 'scripts/verify-flows-size-ratchet-allowances.json'),
    surfaces: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root') o.root = path.resolve(argv[++i] || raise('--root requires a path'));
    else if (a === '--surface') (o.surfaces = o.surfaces || []).push(argv[++i] || raise('--surface requires a path'));
    else if (a === '--allowances') o.allowancesPath = path.resolve(argv[++i] || raise('--allowances requires a path'));
    else raise('unknown argument: ' + a);
  }
  if (!o.surfaces) o.surfaces = DEFAULT_SURFACES;
  return o;
}

function parseFlows(raw) {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('flows.json is not a JSON array');
  return parsed;
}

function surfaceHead(root, rel) {
  return parseFlows(fs.readFileSync(path.join(root, rel), 'utf8'));
}

function measure(flows) {
  return { sizes: nodeSizes(flows), total: totalChars(flows) };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Ceilings must be exact non-negative integers: no strings, no wildcards ("*", "~4096"),
// no rounded/fractional approximations. A ceiling is a reviewed exact number or nothing.
function isStrictNonNegativeInt(v) {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

// JSON.parse silently collapses duplicate object keys (last write wins), which would let
// a duplicate node id in the allowances file quietly widen or shadow a committed ceiling.
// Brace-match the node_allowances span in the raw text and scan it for repeated keys.
function extractObjectSpan(raw, key) {
  const marker = new RegExp('"' + key + '"\\s*:\\s*\\{');
  const m = marker.exec(raw);
  if (!m) return null;
  let depth = 0;
  let start = -1;
  for (let i = m.index; i < raw.length; i += 1) {
    const c = raw[i];
    if (c === '{') {
      if (depth === 0) start = i + 1;
      depth += 1;
    } else if (c === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i);
    }
  }
  return null;
}

function findDuplicateNodeAllowanceKeys(raw) {
  const span = extractObjectSpan(raw, 'node_allowances');
  if (span === null) return [];
  const keys = [...span.matchAll(/"([^"]+)"\s*:\s*\{/g)].map((m) => m[1]);
  const seen = new Set();
  const duplicates = new Set();
  for (const k of keys) {
    if (seen.has(k)) duplicates.add(k);
    seen.add(k);
  }
  return [...duplicates];
}

// Loads and strictly validates the allowances file against the absolute-ceiling schema.
// Any structural problem fails closed here, before any size is ever compared, so a single
// malformed entry cannot silently widen or bypass the ratchet.
function loadAllowances(allowancesPath) {
  let raw;
  try {
    raw = fs.readFileSync(allowancesPath, 'utf8');
  } catch (e) {
    throw new Error('cannot read allowances file ' + allowancesPath + ': ' + e.message);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('allowances file ' + allowancesPath + ' is not valid JSON: ' + e.message);
  }

  const errors = [];
  if (!isPlainObject(parsed)) {
    throw new Error('allowances file ' + allowancesPath + ' must be a JSON object');
  }

  for (const dup of findDuplicateNodeAllowanceKeys(raw)) {
    errors.push('node_allowances contains a duplicate key: ' + dup);
  }

  const rawNodeAllowances = parsed.node_allowances;
  if (!isPlainObject(rawNodeAllowances)) {
    errors.push('node_allowances must be an object');
  }
  const node = {};
  for (const [id, entry] of Object.entries(rawNodeAllowances || {})) {
    if (!isPlainObject(entry)) {
      errors.push('node_allowances.' + id + ': entry must be an object with max_chars and reason');
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(entry, 'delta')) {
      errors.push('node_allowances.' + id + ': stale delta field found; migrate this entry to max_chars (absolute ceiling, not a base-ref delta)');
    }
    if (!isStrictNonNegativeInt(entry.max_chars)) {
      errors.push('node_allowances.' + id + ': max_chars must be an exact non-negative integer (no rounding/wildcards); got ' + JSON.stringify(entry.max_chars));
    }
    if (!isNonEmptyString(entry.reason)) {
      errors.push('node_allowances.' + id + ': missing reason');
    }
    const extraKeys = Object.keys(entry).filter((k) => k !== 'max_chars' && k !== 'reason');
    if (extraKeys.length) {
      errors.push('node_allowances.' + id + ': unexpected field(s) ' + extraKeys.join(', '));
    }
    if (isStrictNonNegativeInt(entry.max_chars) && isNonEmptyString(entry.reason)) {
      node[id] = { max_chars: entry.max_chars, reason: entry.reason };
    }
  }

  const total = parsed.total_allowance;
  let maxTotal = null;
  if (!isPlainObject(total)) {
    errors.push('total_allowance must be an object with max_total and reason');
  } else {
    if (Object.prototype.hasOwnProperty.call(total, 'delta')) {
      errors.push('total_allowance: stale delta field found; migrate to max_total (absolute ceiling, not a base-ref delta)');
    }
    if (!isStrictNonNegativeInt(total.max_total)) {
      errors.push('total_allowance: max_total must be an exact non-negative integer (no rounding/wildcards); got ' + JSON.stringify(total.max_total));
    } else {
      maxTotal = total.max_total;
    }
    if (!isNonEmptyString(total.reason)) {
      errors.push('total_allowance: missing reason');
    }
    const extraKeys = Object.keys(total).filter((k) => k !== 'max_total' && k !== 'reason');
    if (extraKeys.length) {
      errors.push('total_allowance: unexpected field(s) ' + extraKeys.join(', '));
    }
  }

  if (errors.length) {
    throw new Error('invalid allowances file ' + allowancesPath + ':\n  ' + errors.join('\n  '));
  }

  return { node, maxTotal };
}

function checkSurface(rel, flows, allowances) {
  const failures = [];
  const { sizes, total } = measure(flows);
  for (const id of sizes.keys()) {
    if (!Object.prototype.hasOwnProperty.call(allowances.node, id)) {
      failures.push(rel + ': function node ' + id + ' is missing a committed ceiling; add an explicit node_allowances entry with its exact reviewed max_chars and reason');
    }
  }
  for (const [id, entry] of Object.entries(allowances.node)) {
    if (!sizes.has(id)) {
      failures.push(rel + ': allowances entry for node ' + id + ' is unused (no such function node exists in this surface); remove the stale entry');
      continue;
    }
    const found = sizes.get(id);
    if (found.chars > entry.max_chars) {
      failures.push(rel + ': node ' + id + ' is ' + found.chars + ' chars, exceeding its committed ceiling of ' + entry.max_chars + ' (+' + (found.chars - entry.max_chars) + '); update the committed max_chars if this growth was reviewed');
    }
  }
  if (total > allowances.maxTotal) {
    failures.push(rel + ': total embedded JS is ' + total + ' chars, exceeding the committed max_total of ' + allowances.maxTotal + ' (+' + (total - allowances.maxTotal) + '); update the committed max_total if this growth was reviewed');
  }
  return { failures, total };
}

function run() {
  const o = parseArgs(process.argv.slice(2));
  const allowances = loadAllowances(o.allowancesPath);
  const failures = [];
  for (const rel of o.surfaces) {
    const flows = surfaceHead(o.root, rel);
    const res = checkSurface(rel, flows, allowances);
    failures.push(...res.failures);
    if (!res.failures.length) console.log('OK ' + rel + ' (total ' + res.total + ' <= max_total ' + allowances.maxTotal + ')');
  }
  if (failures.length) {
    for (const f of failures) console.error('FAIL ' + f);
    process.exit(1);
  }
  console.log('verify-flows-size-ratchet: OK (exact node coverage and all max_chars/max_total ceilings held)');
}

if (require.main === module) {
  try { run(); } catch (e) { console.error('verify-flows-size-ratchet: FAIL - ' + e.message); process.exit(1); }
}

module.exports = { checkSurface, measure, loadAllowances, parseFlows };
