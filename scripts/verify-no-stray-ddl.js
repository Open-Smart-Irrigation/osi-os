#!/usr/bin/env node
'use strict';

// verify-no-stray-ddl: freezes the amount of ad-hoc DDL embedded in the two
// maintained flows.json profiles and deploy.sh at whatever origin/main
// already carries. Enforcement is git-anchored (origin/main, or --base-ref)
// rather than a self-committed baseline file, so a PR cannot both add DDL
// and "launder" it by regenerating a committed baseline in the same commit
// (that hole is what this script closed after the initial ratchet review).
//
// Comparison is by per-surface, per-marker COUNT, not positional occurrence
// identity, so reordering flows.json nodes or editing unrelated deploy.sh
// comments cannot trip the guard — only a net increase in DDL marker counts
// on a tracked surface can.
//
// Known inherent limits (do not attempt to close these here):
//   - Regex marker scanning cannot see constructed/concatenated DDL strings
//     (e.g. "CREATE" + " TABLE"). This guard is a speed bump, not a proof.
//   - The unmaintained bcm2708 flows profile is out of scope (not scanned).
//   - Secondary scripts invoked BY deploy.sh (if any) are out of scope;
//     only deploy.sh's own text is scanned.
//
// Known current owners of the frozen counts (informational, see the
// committed baseline's "notes" field): the two request-path
// `valve_actuation_expectations` CREATE TABLE occurrences in flows.json
// function nodes, and deploy.sh's `ensure_*` helpers plus the
// analysis_views / chameleon calibration / chameleon_readings DDL blocks.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_BASE_REF = 'origin/main';
const DEFAULT_SURFACES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
  'deploy.sh',
];
const MARKERS = [
  ['createTable', /\bCREATE\s+TABLE\b/gi],
  ['alterTable', /\bALTER\s+TABLE\b/gi],
  ['createUniqueIndex', /\bCREATE\s+UNIQUE\s+INDEX\b/gi],
  ['createIndex', /\bCREATE\s+(?!UNIQUE\s+)INDEX\b/gi],
  ['createTrigger', /\bCREATE\s+TRIGGER\b/gi],
  ['dropTable', /\bDROP\s+TABLE\b/gi],
  ['dropTrigger', /\bDROP\s+TRIGGER\b/gi],
  ['writableSchema', /\bwritable_schema\b/gi],
];
const MARKER_KEYS = MARKERS.map(([key]) => key);

function parseArgs(argv) {
  const options = {
    root: repoRoot,
    gitRoot: null,
    baselinePath: path.join(repoRoot, 'scripts/verify-no-stray-ddl-baseline.json'),
    surfaces: null,
    baseRef: null,
    writeBaseline: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') {
      i += 1;
      if (!argv[i]) throw new Error('--root requires a path');
      options.root = path.resolve(argv[i]);
    } else if (arg === '--git-root') {
      i += 1;
      if (!argv[i]) throw new Error('--git-root requires a path');
      options.gitRoot = path.resolve(argv[i]);
    } else if (arg === '--baseline') {
      i += 1;
      if (!argv[i]) throw new Error('--baseline requires a path');
      options.baselinePath = path.resolve(argv[i]);
    } else if (arg === '--surface') {
      i += 1;
      if (!argv[i]) throw new Error('--surface requires a relative path');
      if (!options.surfaces) options.surfaces = [];
      options.surfaces.push(argv[i]);
    } else if (arg === '--base-ref') {
      i += 1;
      if (!argv[i]) throw new Error('--base-ref requires a ref');
      options.baseRef = argv[i];
    } else if (arg === '--write-baseline') {
      options.writeBaseline = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!options.surfaces) options.surfaces = DEFAULT_SURFACES;
  if (!options.gitRoot) options.gitRoot = options.root;
  if (!options.baseRef) {
    options.baseRef = process.env.OSI_DDL_BASE_REF || DEFAULT_BASE_REF;
  }
  return options;
}

function escapePathPart(value) {
  return String(value).replace(/~/g, '~0').replace(/\//g, '~1');
}

function sourcePath(parts) {
  return `/${parts.map(escapePathPart).join('/')}`;
}

function collectTextSources(value, out, parts = []) {
  if (typeof value === 'string') {
    out.push({ source: sourcePath(parts), text: value });
  } else if (Array.isArray(value)) {
    value.forEach((item, index) => collectTextSources(item, out, [...parts, index]));
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) collectTextSources(item, out, [...parts, key]);
  }
}

function textSourcesFromContent(relativePath, raw) {
  if (!relativePath.endsWith('flows.json')) return [{ source: '$file', text: raw }];
  const sources = [];
  collectTextSources(JSON.parse(raw), sources);
  return sources;
}

function surfaceTexts(root, relativePath) {
  const filePath = path.join(root, relativePath);
  const raw = fs.readFileSync(filePath, 'utf8');
  return textSourcesFromContent(relativePath, raw);
}

function countMarkers(textSources) {
  const counts = {};
  let total = 0;
  for (const [key, pattern] of MARKERS) {
    let markerTotal = 0;
    for (const { text } of textSources) {
      pattern.lastIndex = 0;
      while (pattern.exec(text) !== null) {
        markerTotal += 1;
      }
    }
    counts[key] = markerTotal;
    total += markerTotal;
  }
  counts.total = total;
  return counts;
}

const GIT_MAX_BUFFER = 64 * 1024 * 1024; // flows.json is ~1.2MB; default 1MB maxBuffer overflows.

function gitOutput(gitRoot, args, options = {}) {
  try {
    return execFileSync('git', ['-C', gitRoot, ...args], {
      encoding: options.encoding ?? 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: GIT_MAX_BUFFER,
    });
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString().trim() : e.message;
    throw new Error(`${options.label || 'git command failed'}: ${stderr}`);
  }
}

function countsFromGitRef(gitRoot, baseRef, relativePath) {
  const raw = gitOutput(gitRoot, ['show', `${baseRef}:${relativePath}`], {
    label: `cannot read base surface ${relativePath} (${baseRef})`,
  });
  return countMarkers(textSourcesFromContent(relativePath, raw));
}

function zeroCounts() {
  const counts = {};
  for (const key of MARKER_KEYS) counts[key] = 0;
  counts.total = 0;
  return counts;
}

function emptyBaselineFileEntry() {
  return { ...zeroCounts() };
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

function countsDiffer(actual, expected) {
  for (const key of [...MARKER_KEYS, 'total']) {
    if (typeof expected[key] !== 'number' || actual[key] !== expected[key]) return true;
  }
  return false;
}

function describeCountDifferences(actual, expected) {
  const differences = [];
  for (const key of [...MARKER_KEYS, 'total']) {
    const expectedValue = expected[key];
    if (typeof expectedValue !== 'number') {
      differences.push(`${key}: missing baseline`);
    } else if (actual[key] !== expectedValue) {
      const relation = actual[key] > expectedValue ? '>' : '<';
      differences.push(`${key}: ${actual[key]} ${relation} ${expectedValue}`);
    }
  }
  return differences;
}

function buildBaseline(root, surfaces, baseRef, notes) {
  const files = {};
  let total = 0;
  for (const relativePath of surfaces) {
    const counts = countMarkers(surfaceTexts(root, relativePath));
    files[relativePath] = counts;
    total += counts.total;
  }
  return {
    version: 3,
    baseRef,
    markers: [
      'CREATE TABLE',
      'ALTER TABLE',
      'CREATE UNIQUE INDEX',
      'CREATE INDEX',
      'CREATE TRIGGER',
      'DROP TABLE',
      'DROP TRIGGER',
      'writable_schema',
    ],
    notes,
    files,
    total,
  };
}

const BASELINE_NOTES = [
  'This file is DOCUMENTATION of today\'s known DDL owners, not the enforcement gate.',
  'The enforcement gate is scripts/verify-no-stray-ddl.js comparing HEAD counts against',
  '--base-ref (default origin/main) per surface/marker; see the script header.',
  'Known owners of the current counts: the two request-path CREATE TABLE',
  'valve_actuation_expectations occurrences in flows.json function nodes; deploy.sh',
  'ensure_* helpers, analysis_views, chameleon calibration, and chameleon_readings DDL.',
];

function verifyAgainstBase(options) {
  const failures = [];
  let headTotal = 0;
  let baseTotal = 0;

  for (const relativePath of options.surfaces) {
    const headCounts = countMarkers(surfaceTexts(options.root, relativePath));
    let baseCounts;
    try {
      baseCounts = countsFromGitRef(options.gitRoot, options.baseRef, relativePath);
    } catch (e) {
      // Fail closed: an unreachable base ref must never be treated as "no DDL".
      throw new Error(`base ref unusable, failing closed: ${e.message}`);
    }
    headTotal += headCounts.total;
    baseTotal += baseCounts.total;

    for (const key of MARKER_KEYS) {
      if (headCounts[key] > baseCounts[key]) {
        failures.push(
          `${relativePath}: ${key} increased vs ${options.baseRef} (${headCounts[key]} > ${baseCounts[key]})`
        );
      }
    }
  }

  if (headTotal > baseTotal) {
    failures.push(`total DDL markers increased vs ${options.baseRef} (${headTotal} > ${baseTotal})`);
  }

  return { ok: failures.length === 0, failures, headTotal, baseTotal };
}

function verifyAgainstDocBaseline(options) {
  const baseline = readBaseline(options.baselinePath);
  const surfaceSet = new Set(options.surfaces);
  const failures = [];
  let total = 0;

  for (const relativePath of options.surfaces) {
    const expected = baseline.files[relativePath] || emptyBaselineFileEntry();
    const actual = countMarkers(surfaceTexts(options.root, relativePath));
    total += actual.total;
    if (countsDiffer(actual, expected)) {
      const differences = describeCountDifferences(actual, expected);
      failures.push(`${relativePath} committed baseline is stale (${differences.join(', ')})`);
    }
  }

  for (const relativePath of Object.keys(baseline.files).sort()) {
    if (!surfaceSet.has(relativePath)) {
      failures.push(`DDL baseline contains unscanned file: ${relativePath}`);
    }
  }

  if (total !== baseline.total) {
    failures.push(
      `committed baseline total is stale (${total} ${total > baseline.total ? '>' : '<'} ${baseline.total})`
    );
  }

  return { ok: failures.length === 0, failures, total, baselineTotal: baseline.total };
}

function writeBaseline(options) {
  const baseline = buildBaseline(options.root, options.surfaces, options.baseRef, BASELINE_NOTES);
  fs.writeFileSync(options.baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  return baseline;
}

try {
  const options = parseArgs(process.argv.slice(2));

  if (options.writeBaseline) {
    const baseline = writeBaseline(options);
    console.log(`verify-no-stray-ddl: wrote baseline (total ${baseline.total}) to ${options.baselinePath}`);
    process.exit(0);
  }

  // Gate 1 (the real enforcement): HEAD must not exceed base-ref counts.
  // This cannot be self-certified because base-ref is a git ref, not a
  // committed file this PR could also edit.
  const baseResult = verifyAgainstBase(options);
  if (!baseResult.ok) {
    throw new Error(baseResult.failures.join('; '));
  }

  // Gate 2 (documentation honesty, low stakes): the committed baseline doc
  // must match HEAD's actual counts, so it stays useful for offline/local
  // reading. This does NOT gate on its own — see gate 1 above.
  const docResult = verifyAgainstDocBaseline(options);
  if (!docResult.ok) {
    throw new Error(docResult.failures.join('; '));
  }

  console.log(
    `verify-no-stray-ddl: OK (HEAD total ${baseResult.headTotal} <= ${options.baseRef} total ${baseResult.baseTotal}; ` +
      `committed baseline matches HEAD total ${docResult.total})`
  );
  process.exit(0);
} catch (e) {
  console.error(`verify-no-stray-ddl: FAIL — ${e.message}`);
  process.exit(1);
}
