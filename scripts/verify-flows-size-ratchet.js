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

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function jsonPathKey(parts) {
  return JSON.stringify(parts);
}

// JSON.parse silently collapses duplicate object keys and rounds some original numeric
// tokens before callers can inspect them. Scan the raw JSON with a small recursive tokenizer
// first. Strings are decoded with JSON.parse only after their exact escape-aware span is
// found; numbers are retained as raw tokens. No value is read from outside this string.
function analyzeJsonTokens(raw) {
  let offset = 0;
  const duplicates = [];
  const numberTokens = new Map();

  function syntax(message) {
    throw new Error(`${message} at byte ${offset}`);
  }

  function skipWhitespace() {
    while (offset < raw.length && /\s/.test(raw[offset])) offset += 1;
  }

  function readString() {
    if (raw[offset] !== '"') syntax('expected JSON string');
    const start = offset;
    offset += 1;
    let escaped = false;
    while (offset < raw.length) {
      const c = raw[offset];
      offset += 1;
      if (escaped) {
        escaped = false;
      } else if (c === '\\') {
        escaped = true;
      } else if (c === '"') {
        return JSON.parse(raw.slice(start, offset));
      }
    }
    syntax('unterminated JSON string');
  }

  function parseArray(parts) {
    offset += 1;
    skipWhitespace();
    if (raw[offset] === ']') {
      offset += 1;
      return;
    }
    let index = 0;
    while (offset < raw.length) {
      parseValue([...parts, index]);
      index += 1;
      skipWhitespace();
      if (raw[offset] === ']') {
        offset += 1;
        return;
      }
      if (raw[offset] !== ',') syntax('expected comma or array close');
      offset += 1;
      skipWhitespace();
    }
    syntax('unterminated JSON array');
  }

  function parseObject(parts) {
    offset += 1;
    skipWhitespace();
    if (raw[offset] === '}') {
      offset += 1;
      return;
    }
    const seen = new Set();
    while (offset < raw.length) {
      const key = readString();
      if (seen.has(key)) duplicates.push({ parts: [...parts], key });
      seen.add(key);
      skipWhitespace();
      if (raw[offset] !== ':') syntax('expected colon after object key');
      offset += 1;
      parseValue([...parts, key]);
      skipWhitespace();
      if (raw[offset] === '}') {
        offset += 1;
        return;
      }
      if (raw[offset] !== ',') syntax('expected comma or object close');
      offset += 1;
      skipWhitespace();
    }
    syntax('unterminated JSON object');
  }

  function parseValue(parts) {
    skipWhitespace();
    const c = raw[offset];
    if (c === '{') return parseObject(parts);
    if (c === '[') return parseArray(parts);
    if (c === '"') {
      readString();
      return;
    }
    const number = raw.slice(offset).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
    if (number) {
      numberTokens.set(jsonPathKey(parts), number[0]);
      offset += number[0].length;
      return;
    }
    for (const literal of ['true', 'false', 'null']) {
      if (raw.startsWith(literal, offset)) {
        offset += literal.length;
        return;
      }
    }
    syntax('unexpected JSON token');
  }

  parseValue([]);
  skipWhitespace();
  if (offset !== raw.length) syntax('unexpected trailing JSON content');
  return { duplicates, numberTokens };
}

function formatJsonPath(parts) {
  return parts.length ? parts.map((part) => JSON.stringify(part)).join('.') : '<root>';
}

function ceilingValidationError(value, rawToken) {
  if (typeof value !== 'number') return 'value is not a JSON number';
  if (typeof rawToken !== 'string' || !/^(?:0|[1-9]\d*)$/.test(rawToken)) {
    return 'numeric token is not a canonical non-negative integer';
  }
  if (!Number.isSafeInteger(value)) return 'value is outside the safe-integer range';
  return null;
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
  let analysis;
  try {
    analysis = analyzeJsonTokens(raw);
  } catch (e) {
    throw new Error('allowances file ' + allowancesPath + ' is not valid JSON: ' + e.message);
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

  for (const duplicate of analysis.duplicates) {
    errors.push('duplicate object key at ' + formatJsonPath([...duplicate.parts, duplicate.key]));
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
    const maxCharsToken = analysis.numberTokens.get(jsonPathKey(['node_allowances', id, 'max_chars']));
    const maxCharsError = ceilingValidationError(entry.max_chars, maxCharsToken);
    if (maxCharsError) {
      errors.push('node_allowances.' + id + ': max_chars must be an exact canonical non-negative safe integer; ' + maxCharsError + '; got ' + (maxCharsToken || JSON.stringify(entry.max_chars)));
    }
    if (!isNonEmptyString(entry.reason)) {
      errors.push('node_allowances.' + id + ': missing reason');
    }
    const extraKeys = Object.keys(entry).filter((k) => k !== 'max_chars' && k !== 'reason');
    if (extraKeys.length) {
      errors.push('node_allowances.' + id + ': unexpected field(s) ' + extraKeys.join(', '));
    }
    if (!maxCharsError && isNonEmptyString(entry.reason)) {
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
    const maxTotalToken = analysis.numberTokens.get(jsonPathKey(['total_allowance', 'max_total']));
    const maxTotalError = ceilingValidationError(total.max_total, maxTotalToken);
    if (maxTotalError) {
      errors.push('total_allowance: max_total must be an exact canonical non-negative safe integer; ' + maxTotalError + '; got ' + (maxTotalToken || JSON.stringify(total.max_total)));
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
