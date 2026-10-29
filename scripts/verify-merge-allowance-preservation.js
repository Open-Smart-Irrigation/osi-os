#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const ALLOWANCE_PATH = 'scripts/verify-flows-size-ratchet-allowances.json';
const SECTION_NAMES = ['node_allowances', 'new_node_ceilings', 'total_allowance'];
const TOTAL_KEY = 'total_allowance';

class CliError extends Error {}

function fail(message) {
  throw new CliError(message);
}

function parseArgs(argv) {
  const values = { repo: path.resolve(__dirname, '..') };
  const names = new Set(['--repo', '--left-ref', '--right-ref', '--dispositions']);
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const name = argv[i];
    if (!names.has(name)) fail(`unknown argument: ${name}`);
    if (seen.has(name)) fail(`duplicate argument: ${name}`);
    if (i + 1 >= argv.length) fail(`missing value for ${name}`);
    seen.add(name);
    values[name.slice(2)] = argv[i + 1];
    i += 1;
  }
  for (const required of ['left-ref', 'right-ref']) {
    if (typeof values[required] !== 'string' || values[required].length === 0) {
      fail(`required argument missing: --${required}`);
    }
  }
  values.repo = path.resolve(values.repo);
  if (values.dispositions) values.dispositions = path.resolve(values.dispositions);
  return values;
}

function git(repo, args, label) {
  const result = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    fail(`${label}${detail ? `: ${detail}` : ''}`);
  }
  return result.stdout;
}

function resolveCommit(repo, ref, side) {
  if (typeof ref !== 'string' || ref.length === 0 || ref.includes('\0')) fail(`${side} ref is invalid`);
  const resolved = git(repo, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], `cannot resolve ${side} ref`)
    .trim();
  if (!/^[0-9a-f]{40,64}$/i.test(resolved)) fail(`${side} ref did not resolve to a full commit SHA`);
  return resolved.toLowerCase();
}

function parseJson(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(`${label} is invalid JSON: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be a JSON object`);
  return value;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonemptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateAllowance(value, label) {
  const allowedTop = new Set(['_comment', ...SECTION_NAMES]);
  for (const key of Object.keys(value)) {
    if (!allowedTop.has(key)) fail(`${label} has unexpected top-level key ${JSON.stringify(key)}`);
  }
  for (const section of SECTION_NAMES) {
    if (!Object.hasOwn(value, section)) fail(`${label} is missing required section ${section}`);
  }

  for (const section of ['node_allowances', 'new_node_ceilings']) {
    const entries = value[section];
    if (!isRecord(entries)) fail(`${label} section ${section} must be a keyed object`);
    for (const [key, item] of Object.entries(entries)) {
      if (!key || !isRecord(item)) fail(`${label} section ${section} entry ${JSON.stringify(key)} must be an object`);
      const numberField = section === 'node_allowances' ? 'delta' : 'max_chars';
      if (!Number.isFinite(item[numberField]) || item[numberField] < 0) {
        fail(`${label} section ${section} entry ${JSON.stringify(key)} needs a nonnegative ${numberField}`);
      }
      if (!nonemptyString(item.reason)) fail(`${label} section ${section} entry ${JSON.stringify(key)} needs a nonempty reason`);
    }
  }

  const total = value.total_allowance;
  if (!isRecord(total)) fail(`${label} section total_allowance must be one record`);
  if (!nonemptyString(total.provenance)) fail(`${label} total_allowance needs nonempty provenance`);
  if (!Number.isFinite(total.delta) || total.delta < 0) fail(`${label} total_allowance needs a nonnegative delta`);
  if (!nonemptyString(total.reason)) fail(`${label} total_allowance needs a nonempty reason`);
}

function loadParentAllowance(repo, sha, side) {
  const text = git(repo, ['show', `${sha}:${ALLOWANCE_PATH}`], `cannot read ${side} allowance blob`);
  const value = parseJson(Buffer.from(text, 'utf8'), `${side} parent allowance at ${sha}`);
  validateAllowance(value, `${side} parent allowance at ${sha}`);
  return value;
}

function readResultAllowance(repo) {
  const file = path.join(repo, ALLOWANCE_PATH);
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    fail(`cannot read result allowance file ${file}: ${error.message}`);
  }
  const value = parseJson(bytes, `result allowance file ${file}`);
  validateAllowance(value, `result allowance file ${file}`);
  return { bytes, value };
}

function sectionEntries(value, section) {
  if (section === TOTAL_KEY) return [[TOTAL_KEY, value.total_allowance]];
  return Object.entries(value[section]);
}

function decisionId(decision) {
  return JSON.stringify([decision.parent, decision.section, decision.key]);
}

function loadReceipt(file, leftSha, rightSha, resultBytes) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    fail(`cannot read dispositions file ${file}: ${error.message}`);
  }
  const receipt = parseJson(bytes, `dispositions file ${file}`);
  const expectedKeys = ['left', 'right', 'resultSha256', 'decisions'];
  if (Object.keys(receipt).length !== expectedKeys.length || expectedKeys.some((key) => !Object.hasOwn(receipt, key))) {
    fail('dispositions file must contain exactly left, right, resultSha256, and decisions');
  }
  if (receipt.left !== leftSha) fail(`dispositions left SHA does not match resolved parent ${leftSha}`);
  if (receipt.right !== rightSha) fail(`dispositions right SHA does not match resolved parent ${rightSha}`);
  if (typeof receipt.resultSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.resultSha256)) {
    fail('dispositions resultSha256 must be a lowercase SHA-256 hex digest');
  }
  const resultSha256 = crypto.createHash('sha256').update(resultBytes).digest('hex');
  if (receipt.resultSha256 !== resultSha256) fail(`dispositions resultSha256 does not match result file digest ${resultSha256}`);
  if (!Array.isArray(receipt.decisions)) fail('dispositions decisions must be an array');

  const seen = new Set();
  for (const [index, decision] of receipt.decisions.entries()) {
    if (!isRecord(decision)) fail(`dispositions decision ${index + 1} must be an object`);
    const decisionKeys = ['parent', 'section', 'key', 'reason'];
    if (Object.keys(decision).length !== decisionKeys.length || decisionKeys.some((key) => !Object.hasOwn(decision, key))) {
      fail(`dispositions decision ${index + 1} must contain exactly parent, section, key, and reason`);
    }
    if (!['left', 'right'].includes(decision.parent)) fail(`dispositions decision ${index + 1} has invalid parent`);
    if (!SECTION_NAMES.includes(decision.section)) fail(`dispositions decision ${index + 1} has invalid section`);
    if (typeof decision.key !== 'string' || decision.key.length === 0) fail(`dispositions decision ${index + 1} has invalid key`);
    if (!nonemptyString(decision.reason)) fail(`dispositions decision ${index + 1} needs a nonempty reason`);
    const id = decisionId(decision);
    if (seen.has(id)) fail(`duplicate disposition decision for ${decision.parent} ${decision.section} ${decision.key}`);
    seen.add(id);
  }
  return receipt;
}

function describe(value) {
  return value === undefined ? '<missing>' : JSON.stringify(value);
}

function main(argv) {
  const options = parseArgs(argv);
  const leftSha = resolveCommit(options.repo, options['left-ref'], 'left');
  const rightSha = resolveCommit(options.repo, options['right-ref'], 'right');
  const parents = {
    left: loadParentAllowance(options.repo, leftSha, 'left'),
    right: loadParentAllowance(options.repo, rightSha, 'right'),
  };
  const result = readResultAllowance(options.repo);
  const unmatched = [];

  for (const parent of ['left', 'right']) {
    for (const section of SECTION_NAMES) {
      const parentEntries = sectionEntries(parents[parent], section);
      const resultEntries = new Map(sectionEntries(result.value, section));
      for (const [key, oldValue] of parentEntries) {
        const resultValue = resultEntries.get(key);
        if (!isDeepStrictEqual(oldValue, resultValue)) {
          unmatched.push({ parent, parentSha: parent === 'left' ? leftSha : rightSha, section, key, oldValue, resultValue });
        }
      }
    }
  }

  let receipt = null;
  if (options.dispositions) receipt = loadReceipt(options.dispositions, leftSha, rightSha, result.bytes);
  const unmatchedById = new Map(unmatched.map((entry) => [decisionId(entry), entry]));
  const accepted = new Map();
  if (receipt) {
    for (const decision of receipt.decisions) {
      const id = decisionId(decision);
      const match = unmatchedById.get(id);
      if (!match) fail(`stale or extra disposition for ${decision.parent} ${decision.section} ${decision.key}`);
      accepted.set(id, { ...match, reason: decision.reason });
    }
  }

  const unresolved = unmatched.filter((entry) => !accepted.has(decisionId(entry)));
  for (const entry of unresolved) {
    console.error(`unmatched ${entry.parent} ${entry.section} ${entry.key} parentSha=${entry.parentSha}: old=${describe(entry.oldValue)} result=${describe(entry.resultValue)}`);
  }
  if (unresolved.length > 0) {
    console.error(`verify-merge-allowance-preservation: FAIL (${unresolved.length} unmatched parent entr${unresolved.length === 1 ? 'y' : 'ies'} need dispositions)`);
    return 1;
  }

  for (const entry of accepted.values()) {
    console.log(`accepted ${entry.parent} ${entry.section} ${entry.key} parentSha=${entry.parentSha}: old=${describe(entry.oldValue)} result=${describe(entry.resultValue)} reason=${JSON.stringify(entry.reason)}`);
  }
  console.log(`verify-merge-allowance-preservation: OK (both parents checked; ${unmatched.length} explicit disposition${unmatched.length === 1 ? '' : 's'})`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  console.error(`verify-merge-allowance-preservation: ERROR: ${error.message}`);
  process.exitCode = 1;
}
