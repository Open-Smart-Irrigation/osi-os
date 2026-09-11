#!/usr/bin/env node
'use strict';

// Derives the exhaustive list of repo-relative paths that deploy.sh requests
// via fetch()/fetch_required() from $BASE while running on a gateway.
//
// This is a static parser, not a live run of deploy.sh: deploy.sh mutates
// real system paths (/srv, /etc, /data) starting at its very first line, so
// executing it on a workstation to observe its fetch calls is unsafe. Instead
// this module walks the same three shapes deploy.sh's fetch call-sites take:
//
//   1. Fully literal:      fetch_required "label" "path/to/file" "dest"
//   2. Static loop:        for script in a b c; do fetch_required "..." "scripts/$script" "..."
//   3. Content-driven loop: for migration in $(node -e '...manifest keys...'); do
//                             fetch_required "..." "database/migrations/ordered/$migration" "..."
//
// To guard against silent drift, computeFetchList() also asserts that the
// number of literal-looking call sites it parsed plus the loop-expanded
// entries accounts for every occurrence of the `fetch` / `fetch_required`
// tokens in deploy.sh (see countCallSiteTokens). If a future deploy.sh edit
// adds a call shape this parser doesn't understand, that assertion fails
// loudly instead of the bundle silently missing a file.

const fs = require('node:fs');
const path = require('node:path');

const QSTR = '"((?:\\\\.|[^"\\\\])*)"';
// Optional backslash-newline continuation (with following indentation) between args.
const SEP = '[ \\t]*(?:\\\\\\r?\\n[ \\t]*)?';

function stripEscapes(value) {
  return value.replace(/\\(.)/g, '$1');
}

function findForLoopList(deployText, varName) {
  // Loop bodies come in two shapes in deploy.sh: a multi-line
  // backslash-continued list ("do" on its own line) and a single-line list
  // ("...; do"). Accept either terminator.
  const re = new RegExp(`for\\s+${varName}\\s+in([\\s\\S]*?)(?:;\\s*do\\b|\\n[ \\t]*do\\b)`);
  const m = re.exec(deployText);
  if (!m) {
    throw new Error(`could not find "for ${varName} in ... do" loop in deploy.sh`);
  }
  return m[1]
    .split(/\\\r?\n|\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function findLineageFixtures(repoRoot, lineage) {
  const checksumsPath = path.join(repoRoot, 'scripts/fixtures/lineages', lineage, 'CHECKSUMS.json');
  const manifest = JSON.parse(fs.readFileSync(checksumsPath, 'utf8'));
  return Object.keys(manifest).sort();
}

function findSeedDbCandidates(deployText) {
  const fnMatch = /detect_seed_db_rel\(\)\s*\{([\s\S]*?)\n\}/.exec(deployText);
  if (!fnMatch) {
    throw new Error('could not find detect_seed_db_rel() in deploy.sh');
  }
  const body = fnMatch[1];
  const paths = [];
  const echoRe = /echo\s+"([^"]+)"/g;
  let m;
  while ((m = echoRe.exec(body))) {
    paths.push(m[1]);
  }
  if (paths.length === 0) {
    throw new Error('detect_seed_db_rel() yielded no candidate seed DB paths');
  }
  return paths;
}

function findMigrationFiles(repoRoot) {
  const checksumsPath = path.join(repoRoot, 'database/migrations/ordered/CHECKSUMS.json');
  const manifest = JSON.parse(fs.readFileSync(checksumsPath, 'utf8'));
  return Object.keys(manifest)
    .sort()
    .map((name) => `database/migrations/ordered/${name}`);
}

// Extracts every `fetch "src" "dest"` and `fetch_required "label" "src" "dest"`
// call site, in source order, along with whether the src argument is a plain
// literal or contains a shell variable reference (needs loop expansion).
function extractCallSites(deployText) {
  const fetchRequiredRe = new RegExp(`\\bfetch_required\\b${SEP}${QSTR}${SEP}${QSTR}${SEP}${QSTR}`, 'g');
  const fetchRe = new RegExp(`\\bfetch\\b${SEP}${QSTR}${SEP}${QSTR}`, 'g');

  const sites = [];

  let m;
  while ((m = fetchRequiredRe.exec(deployText))) {
    sites.push({ kind: 'fetch_required', index: m.index, src: stripEscapes(m[2]) });
  }
  while ((m = fetchRe.exec(deployText))) {
    // Skip matches that are actually the start of a fetch_required call
    // (fetch_required contains the substring "fetch" only at a non-word
    // boundary, so \b already excludes it; nothing further to do here).
    sites.push({ kind: 'fetch', index: m.index, src: stripEscapes(m[1]) });
  }

  sites.sort((a, b) => a.index - b.index);
  return sites;
}

function countCallSiteTokens(deployText) {
  // Every real call site starts the line (after indentation) with `fetch(`
  // or `fetch_required(` followed immediately (mod whitespace/continuation)
  // by a quote. Function *definitions* (`fetch() {`, `fetch_required() {`)
  // are excluded because '(' follows, not a quote.
  const re = /\b(fetch_required|fetch)\b[ \t]*(?:\\\r?\n[ \t]*)?"/g;
  let count = 0;
  while (re.exec(deployText)) count += 1;
  return count;
}

function computeFetchList(repoRoot) {
  const deployPath = path.join(repoRoot, 'deploy.sh');
  const deployText = fs.readFileSync(deployPath, 'utf8');

  const sites = extractCallSites(deployText);
  const expectedTokenCount = countCallSiteTokens(deployText);
  if (sites.length !== expectedTokenCount) {
    throw new Error(
      `deploy-fetch-list parser drift: found ${expectedTokenCount} fetch/fetch_required ` +
        `call-site tokens in deploy.sh but only parsed ${sites.length} of them. ` +
        'A call shape this parser does not understand was likely added to deploy.sh.'
    );
  }

  const scriptLoopFiles = findForLoopList(deployText, 'script');
  const moduleLoopFiles = findForLoopList(deployText, 'module');
  const lineageLoopNames = findForLoopList(deployText, 'lineage');
  const seedDbCandidates = findSeedDbCandidates(deployText);
  const migrationFiles = findMigrationFiles(repoRoot);

  const paths = new Set();
  const skipped = [];

  for (const site of sites) {
    const { src } = site;
    if (src === '$src') {
      // Internal plumbing: fetch_required() delegates to fetch("$src","$dest").
      // Not an independent path; the outer fetch_required call already
      // contributed its literal src.
      continue;
    }
    if (src === '$SEED_DB_REL') {
      for (const candidate of seedDbCandidates) paths.add(candidate);
      continue;
    }
    if (src === 'scripts/$script') {
      for (const script of scriptLoopFiles) paths.add(`scripts/${script}`);
      continue;
    }
    if (src === 'lib/osi-migrate/$module') {
      for (const module_ of moduleLoopFiles) paths.add(`lib/osi-migrate/${module_}`);
      continue;
    }
    if (src === 'database/migrations/ordered/$migration') {
      for (const migrationPath of migrationFiles) paths.add(migrationPath);
      continue;
    }
    if (src === 'scripts/fixtures/lineages/$lineage/CHECKSUMS.json') {
      for (const lineage of lineageLoopNames) {
        paths.add(`scripts/fixtures/lineages/${lineage}/CHECKSUMS.json`);
      }
      continue;
    }
    if (src === 'scripts/fixtures/lineages/$lineage/$fixture') {
      for (const lineage of lineageLoopNames) {
        for (const fixture of findLineageFixtures(repoRoot, lineage)) {
          paths.add(`scripts/fixtures/lineages/${lineage}/${fixture}`);
        }
      }
      continue;
    }
    if (src.includes('$')) {
      skipped.push(src);
      continue;
    }
    paths.add(src);
  }

  if (skipped.length > 0) {
    throw new Error(
      `deploy-fetch-list parser drift: unrecognized variable-driven src argument(s) in deploy.sh: ` +
        skipped.join(', ') +
        '. Teach computeFetchList() how to expand this new dynamic fetch before shipping.'
    );
  }

  return Array.from(paths).sort();
}

module.exports = { computeFetchList, extractCallSites, countCallSiteTokens };

if (require.main === module) {
  const repoRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..');
  const list = computeFetchList(repoRoot);
  for (const p of list) console.log(p);
}
