#!/usr/bin/env node
'use strict';
// verify-flows-size-ratchet - refactor-program 1.A2, DD3.
// Git-anchored ratchets over maintained flows.json profiles:
// 1. Existing function nodes (by id) may not grow vs --base-ref.
// 2. A newly-added function node must be <= NEW_NODE_CEILING.
// 3. Per-profile total embedded function JS may only decrease.
// 4. Large new nodes may not re-embed oversized SQL unless loading via osi-lib.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  nodeSizes,
  totalChars,
  isThinNewNode,
  NEW_NODE_CEILING,
  THIN_NODE_FLOOR,
  SQL_LITERAL_MAX,
} = require('./flows-size-scan');

const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_BASE_REF = 'origin/main';
const DEFAULT_SURFACES = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
];
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

function raise(msg) { throw new Error(msg); }

function parseArgs(argv) {
  const o = {
    root: repoRoot,
    gitRoot: null,
    baselinePath: path.join(repoRoot, 'scripts/verify-flows-size-ratchet-baseline.json'),
    surfaces: null,
    baseRef: null,
    writeBaseline: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--root') o.root = path.resolve(argv[++i] || raise('--root requires a path'));
    else if (a === '--git-root') o.gitRoot = path.resolve(argv[++i] || raise('--git-root requires a path'));
    else if (a === '--baseline') o.baselinePath = path.resolve(argv[++i] || raise('--baseline requires a path'));
    else if (a === '--surface') (o.surfaces = o.surfaces || []).push(argv[++i] || raise('--surface requires a path'));
    else if (a === '--base-ref') o.baseRef = argv[++i] || raise('--base-ref requires a ref');
    else if (a === '--write-baseline') o.writeBaseline = true;
    else raise('unknown argument: ' + a);
  }
  if (!o.surfaces) o.surfaces = DEFAULT_SURFACES;
  if (!o.gitRoot) o.gitRoot = o.root;
  if (!o.baseRef) o.baseRef = process.env.OSI_FLOWS_SIZE_BASE_REF || DEFAULT_BASE_REF;
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

function surfaceBase(gitRoot, baseRef, rel) {
  let raw;
  try {
    raw = execFileSync('git', ['-C', gitRoot, 'show', baseRef + ':' + rel], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: GIT_MAX_BUFFER,
    });
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString().trim() : e.message;
    throw new Error('base ref unusable, failing closed: cannot read ' + rel + ' (' + baseRef + '): ' + stderr);
  }
  return parseFlows(raw);
}

function measure(flows) {
  const sizes = nodeSizes(flows);
  return { sizes, total: totalChars(flows) };
}

function checkSurface(rel, headFlows, baseFlows) {
  const failures = [];
  const head = measure(headFlows);
  const base = measure(baseFlows);

  for (const [id, { chars }] of head.sizes) {
    const baseEntry = base.sizes.get(id);
    if (baseEntry) {
      if (chars > baseEntry.chars) {
        failures.push(rel + ': node ' + id + ' grew (' + chars + ' > ' + baseEntry.chars + ' at base)');
      }
    } else {
      if (chars > NEW_NODE_CEILING) {
        failures.push(rel + ': new node ' + id + ' exceeds the ' + NEW_NODE_CEILING + '-char ceiling (' + chars + ')');
      }
      const node = headFlows.find((n) => n && n.id === id);
      const thin = isThinNewNode(node, { floor: THIN_NODE_FLOOR, sqlLiteralMax: SQL_LITERAL_MAX });
      if (!thin.ok) failures.push(rel + ': new node ' + id + ' - ' + thin.reason);
    }
  }
  if (head.total > base.total) {
    failures.push(rel + ': total embedded JS increased (' + head.total + ' > ' + base.total + ' at base)');
  }
  return { failures, headTotal: head.total, baseTotal: base.total };
}

function buildBaseline(root, surfaces) {
  const files = {};
  for (const rel of surfaces) {
    const { sizes, total } = measure(surfaceHead(root, rel));
    files[rel] = { functionNodes: sizes.size, total };
  }
  return {
    version: 1,
    baseRef: DEFAULT_BASE_REF,
    ceilingChars: NEW_NODE_CEILING,
    thinNodeFloorChars: THIN_NODE_FLOOR,
    sqlLiteralMaxChars: SQL_LITERAL_MAX,
    notes: [
      'DOCUMENTATION of the current per-profile function-JS totals, not the enforcement gate.',
      'Enforcement is scripts/verify-flows-size-ratchet.js comparing HEAD against --base-ref',
      '(default origin/main): per-node-id ceilings, per-profile total may only decrease, and',
      'the thin-node heuristic on newly-added node ids. See the script header.',
      'The DD3 charter cites 1,017,468 as the scoreboard start; the real measured baseline at',
      'introduction (main @ 612987d9, 2026-07-08) is 1,039,554 per profile - the earlier figure',
      'was captured before nodes grew. Git-anchoring means the enforced number self-updates.',
    ],
    files,
  };
}

function writeBaselineFile(o) {
  const baseline = buildBaseline(o.root, o.surfaces);
  fs.writeFileSync(o.baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  return baseline;
}

function verifyDocBaseline(o) {
  const baseline = JSON.parse(fs.readFileSync(o.baselinePath, 'utf8'));
  const failures = [];
  const notes = [];
  for (const rel of o.surfaces) {
    const expected = (baseline.files || {})[rel];
    const { total } = measure(surfaceHead(o.root, rel));
    if (!expected) {
      failures.push(rel + ': committed baseline missing this surface');
    } else if (total > expected.total) {
      failures.push(rel + ': HEAD total ' + total + ' exceeds committed baseline ' + expected.total + ' (regenerate with --write-baseline if this growth is intentional and gate 1 allowed it)');
    } else if (total < expected.total) {
      notes.push(rel + ': HEAD total ' + total + ' is below committed baseline ' + expected.total + ' - a shrink not yet reflected in the doc (ok; refresh with --write-baseline when convenient)');
    }
  }
  return { failures, notes };
}

function run() {
  const o = parseArgs(process.argv.slice(2));
  if (o.writeBaseline) {
    const b = writeBaselineFile(o);
    const t = Object.values(b.files).map((f) => f.total).join(', ');
    console.log('verify-flows-size-ratchet: wrote baseline (per-profile totals ' + t + ') to ' + o.baselinePath);
    return;
  }

  const failures = [];
  let headTotal = 0;
  let baseTotal = 0;
  for (const rel of o.surfaces) {
    const head = surfaceHead(o.root, rel);
    const base = surfaceBase(o.gitRoot, o.baseRef, rel);
    const res = checkSurface(rel, head, base);
    failures.push(...res.failures);
    headTotal += res.headTotal;
    baseTotal += res.baseTotal;
    if (!res.failures.length) console.log('OK ' + rel + ' (total ' + res.headTotal + ')');
  }
  if (failures.length) {
    for (const f of failures) console.error('FAIL ' + f);
    process.exit(1);
  }

  const doc = verifyDocBaseline(o);
  for (const n of doc.notes) console.log('NOTE ' + n);
  if (doc.failures.length) {
    for (const f of doc.failures) console.error('FAIL ' + f);
    process.exit(1);
  }

  console.log('verify-flows-size-ratchet: OK (HEAD total ' + headTotal + ' <= ' + o.baseRef + ' total ' + baseTotal + '; committed baseline not exceeded)');
}

if (require.main === module) {
  try { run(); } catch (e) { console.error('verify-flows-size-ratchet: FAIL - ' + e.message); process.exit(1); }
}

module.exports = { checkSurface, measure, buildBaseline };
