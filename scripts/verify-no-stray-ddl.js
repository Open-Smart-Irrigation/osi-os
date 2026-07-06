#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const repoRoot = path.resolve(__dirname, '..');
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

function surfaceTexts(root, relativePath) {
  const filePath = path.join(root, relativePath);
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!relativePath.endsWith('flows.json')) return [{ source: '$file', text: raw }];

  const sources = [];
  collectTextSources(JSON.parse(raw), sources);
  return sources;
}

function hashString(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeSnippet(text, start) {
  const endTokens = ['\n', ';', '"', "'", '`'];
  let end = text.length;
  for (const token of endTokens) {
    const found = text.indexOf(token, start);
    if (found !== -1 && found < end) end = found;
  }
  if (end <= start) end = Math.min(text.length, start + 240);
  return text.slice(start, Math.min(end, start + 240)).replace(/\s+/g, ' ').trim();
}

function canonicalOccurrences(occurrences) {
  return occurrences
    .map((occurrence) => JSON.stringify(occurrence))
    .sort();
}

function countMarkers(textSources) {
  const counts = {};
  const occurrences = [];
  let total = 0;
  for (const [key, pattern] of MARKERS) {
    let markerTotal = 0;
    for (const { source, text } of textSources) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(text)) !== null) {
        markerTotal += 1;
        occurrences.push({
          marker: key,
          source,
          stringHash: hashString(text),
          snippet: normalizeSnippet(text, match.index),
        });
      }
    }
    counts[key] = markerTotal;
    total += markerTotal;
  }
  counts.total = total;
  return { counts, occurrences: canonicalOccurrences(occurrences) };
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
  const differences = [];
  for (const key of [...MARKER_KEYS, 'total']) {
    const expected = baseline[key];
    if (typeof expected !== 'number') {
      differences.push(`${key}: missing baseline`);
    } else if (actual[key] !== expected) {
      const relation = key === 'total' ? (actual[key] > expected ? '>' : '<') : '!=';
      differences.push(`${key}: ${actual[key]} ${relation} ${expected}`);
    }
  }
  if (differences.length > 0) {
    return `${relativePath} differs from baseline (${differences.join(', ')})`;
  }
  return null;
}

function compareOccurrences(relativePath, actual, baseline) {
  if (!Array.isArray(baseline.occurrences)) {
    return `${relativePath} missing occurrence baseline`;
  }
  const expected = canonicalOccurrences(baseline.occurrences);
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index])) {
    return `${relativePath} occurrence set differs from baseline`;
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

    const { counts, occurrences } = countMarkers(surfaceTexts(options.root, relativePath));
    total += counts.total;
    const countFailure = compareCounts(relativePath, counts, expected);
    if (countFailure) failures.push(countFailure);
    const occurrenceFailure = compareOccurrences(relativePath, occurrences, expected);
    if (occurrenceFailure) failures.push(occurrenceFailure);
  }

  for (const relativePath of Object.keys(baseline.files).sort()) {
    if (!surfaceSet.has(relativePath)) {
      failures.push(`DDL baseline contains unscanned file: ${relativePath}`);
    }
  }

  if (total !== baseline.total) {
    failures.push(`total differs from baseline (${total} ${total > baseline.total ? '>' : '<'} ${baseline.total})`);
  }

  return { ok: failures.length === 0, failures, total, baselineTotal: baseline.total };
}

try {
  const result = verify(parseArgs(process.argv.slice(2)));
  if (!result.ok) {
    throw new Error(result.failures.join('; '));
  }
  console.log(`verify-no-stray-ddl: OK (total ${result.total} matches baseline ${result.baselineTotal})`);
  process.exit(0);
} catch (e) {
  console.error(`verify-no-stray-ddl: FAIL — ${e.message}`);
  process.exit(1);
}
