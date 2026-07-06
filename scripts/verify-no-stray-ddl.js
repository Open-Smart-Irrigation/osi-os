#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_SURFACES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
  'deploy.sh',
];
const MARKERS = [
  ['createTable', /\bCREATE\s+TABLE\b/gi],
  ['alterTable', /\bALTER\s+TABLE\b/gi],
  ['writableSchema', /\bwritable_schema\b/gi],
];

function parseArgs(argv) {
  const options = {
    root: repoRoot,
    baselinePath: path.join(repoRoot, 'scripts/verify-no-stray-ddl-baseline.json'),
    surfaces: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      i += 1;
      if (!argv[i]) throw new Error('--root requires a path');
      options.root = path.resolve(argv[i]);
    } else if (arg === '--baseline') {
      i += 1;
      if (!argv[i]) throw new Error('--baseline requires a path');
      options.baselinePath = path.resolve(argv[i]);
    } else if (arg === '--surface') {
      i += 1;
      if (!argv[i]) throw new Error('--surface requires a relative path');
      if (!options.surfaces) options.surfaces = [];
      options.surfaces.push(argv[i]);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!options.surfaces) options.surfaces = DEFAULT_SURFACES;
  return options;
}

function collectStrings(value, out) {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
}

function surfaceText(root, relativePath) {
  const filePath = path.join(root, relativePath);
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!relativePath.endsWith('flows.json')) return raw;

  const strings = [];
  collectStrings(JSON.parse(raw), strings);
  return strings.join('\n');
}

function countMarkers(text) {
  const counts = {};
  let total = 0;
  for (const [key, pattern] of MARKERS) {
    const matches = text.match(pattern) || [];
    counts[key] = matches.length;
    total += matches.length;
  }
  counts.total = total;
  return counts;
}

function readBaseline(baselinePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw new Error(`DDL baseline missing: ${baselinePath}`);
    }
    throw new Error(`DDL baseline is invalid JSON: ${e.message}`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('DDL baseline must be a JSON object');
  }
  if (!parsed.files || Array.isArray(parsed.files) || typeof parsed.files !== 'object') {
    throw new Error('DDL baseline must contain a files object');
  }
  if (typeof parsed.total !== 'number') {
    throw new Error('DDL baseline must contain a numeric total');
  }
  return parsed;
}

function compareCounts(relativePath, actual, baseline) {
  const over = [];
  for (const key of ['createTable', 'alterTable', 'writableSchema', 'total']) {
    const allowed = baseline[key];
    if (typeof allowed !== 'number') {
      over.push(`${key}: missing baseline`);
    } else if (actual[key] > allowed) {
      over.push(`${key}: ${actual[key]} > ${allowed}`);
    }
  }
  if (over.length > 0) {
    return `${relativePath} exceeds baseline (${over.join(', ')})`;
  }
  return null;
}

function verify(options) {
  const baseline = readBaseline(options.baselinePath);
  const surfaceSet = new Set(options.surfaces);
  const failures = [];
  let total = 0;

  for (const relativePath of options.surfaces) {
    const expected = baseline.files[relativePath];
    if (!expected) {
      failures.push(`${relativePath} has no DDL baseline entry`);
      continue;
    }

    const counts = countMarkers(surfaceText(options.root, relativePath));
    total += counts.total;
    const failure = compareCounts(relativePath, counts, expected);
    if (failure) failures.push(failure);
  }

  for (const relativePath of Object.keys(baseline.files).sort()) {
    if (!surfaceSet.has(relativePath)) {
      failures.push(`DDL baseline contains unscanned file: ${relativePath}`);
    }
  }

  if (total > baseline.total) {
    failures.push(`total exceeds baseline (${total} > ${baseline.total})`);
  }

  return { ok: failures.length === 0, failures, total, baselineTotal: baseline.total };
}

try {
  const result = verify(parseArgs(process.argv.slice(2)));
  if (!result.ok) {
    throw new Error(result.failures.join('; '));
  }
  console.log(`verify-no-stray-ddl: OK (total ${result.total} <= baseline ${result.baselineTotal})`);
  process.exit(0);
} catch (e) {
  console.error(`verify-no-stray-ddl: FAIL — ${e.message}`);
  process.exit(1);
}

