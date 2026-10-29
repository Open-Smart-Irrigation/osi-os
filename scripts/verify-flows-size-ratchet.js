#!/usr/bin/env node
'use strict';
// verify-flows-size-ratchet - refactor-program 1.A2, DD3; fix-only exceptions 2026-10-29.
// Git-anchored ratchets over maintained flows.json profiles, against --base-ref:
// 1. Existing function nodes (by id) may not grow.
// 2. A new function node is wiring: at most NEW_NODE_CEILING chars, and over
//    THIN_NODE_FLOOR it must load its logic through osiLib.require with no large SQL.
// 3. Per-profile total embedded function JS may not increase.
// New features go into tested osi-* modules; there is no growth budget for them.
// The only way past 1-3 is a fix exception in scripts/flows-growth-exceptions.json,
// and only as that file stands at --base-ref: a PR cannot grant itself growth.
// An exception gives absolute per-node ceilings, so it never re-grants once used,
// and only growth in its listed nodes may raise the total. It grants for
// EXCEPTION_WINDOW_DAYS from `granted`; from then on every run fails until the
// profile total is at or below `payback_total`. A merged entry cannot be edited,
// and cannot be deleted before it is paid back. Function code is func plus the
// node's On Start (initialize) and On Stop (finalize) code.
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
const DEFAULT_EXCEPTIONS_REL = 'scripts/flows-growth-exceptions.json';
const EXCEPTION_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;
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
    exceptionsRel: DEFAULT_EXCEPTIONS_REL,
    today: null,
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
    else if (a === '--exceptions') o.exceptionsRel = argv[++i] || raise('--exceptions requires a repo-relative path');
    else if (a === '--today') o.today = argv[++i] || raise('--today requires YYYY-MM-DD');
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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null;
  const ms = Date.parse(value + 'T00:00:00Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

function isoDate(ms) { return new Date(ms).toISOString().slice(0, 10); }

function isCount(v) { return Number.isSafeInteger(v) && v >= 0; }

// Schema errors for one exception entry; [] when well formed.
function exceptionErrors(e) {
  const errs = [];
  const label = 'exception ' + (e && typeof e.id === 'string' ? e.id : '(no id)');
  if (!e || typeof e !== 'object') return [label + ': not an object'];
  if (typeof e.id !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(e.id)) errs.push(label + ': id must be a lowercase slug');
  if (e.kind !== 'fix') errs.push(label + ': kind must be "fix" (features get no exceptions; put them in an osi-* module)');
  if (!Number.isSafeInteger(e.issue) || e.issue <= 0) errs.push(label + ': issue must be the GitHub issue number of the bug');
  if (parseDate(e.granted) === null) errs.push(label + ': granted must be a YYYY-MM-DD date');
  if (typeof e.reason !== 'string' || e.reason.trim() === '') errs.push(label + ': reason must be non-empty');
  if (!e.nodes || typeof e.nodes !== 'object' || Array.isArray(e.nodes) || !Object.keys(e.nodes).length) errs.push(label + ': nodes must map at least one node id to max_chars');
  else for (const [id, max] of Object.entries(e.nodes)) if (!isCount(max)) errs.push(label + ': nodes.' + id + ' must be a non-negative integer');
  if (!isCount(e.payback_total)) errs.push(label + ': payback_total must be a non-negative integer');
  return errs;
}

function parseExceptions(raw, where) {
  let doc;
  try { doc = JSON.parse(raw); } catch (e) { throw new Error(where + ' is not valid JSON: ' + e.message); }
  const list = doc && Array.isArray(doc.exceptions) ? doc.exceptions : null;
  if (!list) throw new Error(where + ' must hold an "exceptions" array');
  const errors = [];
  const ids = new Set();
  for (const e of list) {
    errors.push(...exceptionErrors(e).map((m) => where + ': ' + m));
    if (e && typeof e.id === 'string') {
      if (ids.has(e.id)) errors.push(where + ': duplicate exception id ' + e.id);
      ids.add(e.id);
    }
  }
  return { list, errors };
}

// Exceptions as they stand at the base ref. Only a missing path counts as
// "no exceptions"; any other git failure fails closed.
function baseExceptions(gitRoot, baseRef, rel) {
  let raw;
  try {
    raw = execFileSync('git', ['-C', gitRoot, 'show', baseRef + ':' + rel], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: GIT_MAX_BUFFER,
    });
  } catch (e) {
    const stderr = e.stderr ? e.stderr.toString() : String(e.message);
    if (/does not exist in|exists on disk, but not in/.test(stderr)) return { list: [], errors: [] };
    throw new Error('base ref unusable, failing closed: cannot read ' + rel + ' (' + baseRef + '): ' + stderr.trim());
  }
  return parseExceptions(raw, rel + ' at ' + baseRef);
}

function headExceptions(root, rel) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) return { list: [], errors: [] };
  return parseExceptions(fs.readFileSync(file, 'utf8'), rel);
}

// The working-tree file is only validated; its new entries take effect once
// merged. A merged entry may not change, and may not be deleted until every
// profile total is at or below its payback_total.
function headExceptionErrors(rel, head, base, todayMs, baseTotals, headTotals) {
  const errors = [...head.errors];
  const baseById = new Map(base.list.map((e) => [e.id, e]));
  const headIds = new Set(head.list.map((e) => e && e.id));
  const minBase = Math.min(...baseTotals);
  const maxHead = Math.max(...headTotals);
  for (const e of head.list) {
    if (!e || typeof e.id !== 'string') continue;
    const prior = baseById.get(e.id);
    if (prior) {
      if (JSON.stringify(prior) !== JSON.stringify(e)) errors.push(rel + ': exception ' + e.id + ' changed after it was granted; add a new entry instead');
      continue;
    }
    if (parseDate(e.granted) !== null && parseDate(e.granted) > todayMs) {
      errors.push(rel + ': exception ' + e.id + ' is granted in the future (' + e.granted + ')');
    }
    if (isCount(e.payback_total) && e.payback_total > minBase) {
      errors.push(rel + ': exception ' + e.id + ' payback_total ' + e.payback_total + ' is above the current total ' + minBase + '; set it to the total before the fix');
    }
  }
  for (const e of base.list) {
    if (!e || headIds.has(e.id)) continue;
    if (maxHead > e.payback_total) {
      errors.push(rel + ': exception ' + e.id + ' cannot be deleted before it is paid back (total ' + maxHead + ' > ' + e.payback_total + ')');
    }
  }
  return errors;
}

function isActive(e, todayMs) {
  const g = parseDate(e.granted);
  return g !== null && todayMs >= g && todayMs < g + EXCEPTION_WINDOW_DAYS * DAY_MS;
}

function activeExceptions(list, todayMs) {
  return list.filter((e) => isActive(e, todayMs));
}

function checkSurface(rel, headFlows, baseFlows, active) {
  const failures = [];
  const head = measure(headFlows);
  const base = measure(baseFlows);
  const exceptions = active || [];
  const nodeCeiling = (id) => {
    let max = null;
    for (const e of exceptions) if (Object.prototype.hasOwnProperty.call(e.nodes, id)) max = Math.max(max === null ? 0 : max, e.nodes[id]);
    return max;
  };
  const grown = {};
  let excepted = 0; // growth that active fix exceptions cover; only it may raise the total

  for (const [id, { chars }] of head.sizes) {
    const baseEntry = base.sizes.get(id);
    const baseChars = baseEntry ? baseEntry.chars : 0;
    const ceiling = nodeCeiling(id);
    if (ceiling !== null) {
      if (chars > baseChars && chars > ceiling) {
        failures.push(rel + ': ' + (baseEntry ? 'node ' + id + ' grew (' + chars + ' > ' + baseChars + ' at base; ' : 'new node ' + id + ' (' + chars + ' chars; ')
          + 'fix exception ceiling ' + ceiling + ')');
        grown[id] = chars;
      } else {
        excepted += Math.max(0, chars - baseChars);
      }
    } else if (baseEntry) {
      if (chars > baseChars) {
        failures.push(rel + ': node ' + id + ' grew (' + chars + ' > ' + baseChars + ' at base)');
        grown[id] = chars;
      }
    } else {
      if (chars > NEW_NODE_CEILING) {
        failures.push(rel + ': new node ' + id + ' exceeds the ' + NEW_NODE_CEILING + '-char ceiling (' + chars + ')');
        grown[id] = chars;
      }
      const node = headFlows.find((n) => n && n.id === id);
      const thin = isThinNewNode(node, { floor: THIN_NODE_FLOOR, sqlLiteralMax: SQL_LITERAL_MAX });
      if (!thin.ok) {
        failures.push(rel + ': new node ' + id + ' - ' + thin.reason);
        grown[id] = chars;
      }
    }
  }
  const totalCeiling = base.total + excepted;
  const totalFailed = head.total > totalCeiling;
  if (totalFailed) {
    failures.push(rel + ': total embedded JS increased (' + head.total + ' > ' + base.total + ' at base'
      + (excepted ? ' + ' + excepted + ' covered by fix exceptions' : '') + ')');
  }
  const suggestion = (failures.length && (totalFailed || Object.keys(grown).length))
    ? { nodes: grown, payback_total: base.total } : null;
  return { failures, headTotal: head.total, baseTotal: base.total, totalCeiling, suggestion };
}

// An exception grants growth for EXCEPTION_WINDOW_DAYS from `granted`. From
// then on the profile total must be at or below payback_total. Entries stay in
// force (from the base ref) until paid back; deletion before payback is refused.
function checkPayback(rel, headTotal, list, todayMs) {
  const failures = [];
  const notes = [];
  for (const e of list) {
    const g = parseDate(e.granted);
    if (g === null) continue;
    const due = g + EXCEPTION_WINDOW_DAYS * DAY_MS;
    if (todayMs < g) {
      notes.push(rel + ': fix exception ' + e.id + ' is not active until ' + e.granted);
    } else if (todayMs < due) {
      notes.push(rel + ': fix exception ' + e.id + ' is active through ' + isoDate(due - DAY_MS)
        + '; from ' + isoDate(due) + ' the total must be at or below ' + e.payback_total + ' (now ' + headTotal + ')');
    } else if (headTotal <= e.payback_total) {
      notes.push(rel + ': fix exception ' + e.id + ' is paid back (total ' + headTotal + ' <= ' + e.payback_total + '); delete the entry');
    } else {
      failures.push(rel + ': fix exception ' + e.id + ' (issue #' + e.issue + ', granted ' + e.granted + ') is overdue: total ' + headTotal
        + ' must be back at or below ' + e.payback_total + ' (extract ' + (headTotal - e.payback_total) + ' chars into a module)');
    }
  }
  return { failures, notes };
}

function suggestionText(suggestion, today) {
  const entry = {
    id: 'fix-<issue>-<slug>',
    kind: 'fix',
    issue: 0,
    granted: today,
    reason: '<the bug, and why the fix cannot go into a module first>',
    nodes: suggestion.nodes,
    payback_total: suggestion.payback_total,
  };
  return 'Features get no exceptions: move the logic into an osi-* module and load it with osiLib.require.\n'
    + 'For a bug fix that must touch the flow, merge this entry into ' + DEFAULT_EXCEPTIONS_REL
    + ' in a separate PR first, then rebase this one (the gate reads the file from the base ref):\n'
    + JSON.stringify(entry, null, 2);
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
      '(default origin/main): no node grows, per-profile total may not increase, new nodes are',
      'thin wiring, and only fix exceptions at the base ref lift that. See the script header.',
      'The DD3 charter cites 1,017,468 as the scoreboard start; plan-write measured 1,039,554.',
      'The real measured baseline at introduction (origin/main @ 5e04b8a2, 2026-07-10) is',
      '1,064,794 per profile after #117. Git-anchoring means the enforced number self-updates.',
    ],
    files,
  };
}

function writeBaselineFile(o) {
  const baseline = buildBaseline(o.root, o.surfaces);
  fs.writeFileSync(o.baselinePath, JSON.stringify(baseline, null, 2) + '\n');
  return baseline;
}

function verifyDocBaseline(o, ceilings) {
  const baseline = JSON.parse(fs.readFileSync(o.baselinePath, 'utf8'));
  const failures = [];
  const notes = [];
  for (const rel of o.surfaces) {
    const expected = (baseline.files || {})[rel];
    const { total } = measure(surfaceHead(o.root, rel));
    if (!expected) {
      failures.push(rel + ': committed baseline missing this surface');
    } else if (total > Math.max(expected.total, (ceilings && ceilings[rel]) || 0)) {
      failures.push(rel + ': HEAD total ' + total + ' exceeds committed baseline ' + expected.total + ' (regenerate with --write-baseline)');
    } else if (total < expected.total) {
      notes.push(rel + ': HEAD total ' + total + ' is below committed baseline ' + expected.total + ' - a shrink not yet reflected in the doc (ok; refresh with --write-baseline when convenient)');
    }
  }
  return { failures, notes };
}

// "Today" for the exception window: the later of the HEAD and base-ref commit
// times, as a UTC date. Deterministic for a given pair of commits; a CI re-run
// against a newer base moves forward with it.
function gateDate(gitRoot, baseRef) {
  const ct = (ref) => {
    try {
      return Number(execFileSync('git', ['-C', gitRoot, 'log', '-1', '--format=%ct', ref], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }).trim()) * 1000;
    } catch {
      return 0;
    }
  };
  const ms = Math.max(ct('HEAD'), ct(baseRef));
  return isoDate(ms || Date.now());
}

function run() {
  const o = parseArgs(process.argv.slice(2));
  if (o.writeBaseline) {
    const b = writeBaselineFile(o);
    const t = Object.values(b.files).map((f) => f.total).join(', ');
    console.log('verify-flows-size-ratchet: wrote baseline (per-profile totals ' + t + ') to ' + o.baselinePath);
    return;
  }

  const today = o.today || gateDate(o.gitRoot, o.baseRef);
  const todayMs = parseDate(today);
  if (todayMs === null) raise('--today must be YYYY-MM-DD, got ' + today);
  const base = baseExceptions(o.gitRoot, o.baseRef, o.exceptionsRel);
  const head = headExceptions(o.root, o.exceptionsRel);
  const valid = base.errors.length ? [] : base.list;
  const active = activeExceptions(valid, todayMs);
  const failures = [...base.errors];
  const notes = [];
  const ceilings = {};
  const baseTotals = [];
  const headTotals = [];
  let suggestion = null;
  for (const rel of o.surfaces) {
    const headFlows = surfaceHead(o.root, rel);
    const baseFlows = surfaceBase(o.gitRoot, o.baseRef, rel);
    const res = checkSurface(rel, headFlows, baseFlows, active);
    const payback = checkPayback(rel, res.headTotal, valid, todayMs);
    failures.push(...res.failures, ...payback.failures);
    notes.push(...payback.notes);
    if (res.suggestion && !suggestion) suggestion = res.suggestion;
    if (res.totalCeiling > res.baseTotal) ceilings[rel] = res.totalCeiling; // growth a fix exception covers
    baseTotals.push(res.baseTotal);
    headTotals.push(res.headTotal);
    if (!res.failures.length && !payback.failures.length) console.log('OK ' + rel + ' (total ' + res.headTotal + ')');
  }
  failures.push(...headExceptionErrors(o.exceptionsRel, head, base, todayMs, baseTotals, headTotals));
  for (const n of notes) console.log('NOTE ' + n);
  if (failures.length) {
    for (const f of failures) console.error('FAIL ' + f);
    if (suggestion) console.error(suggestionText(suggestion, today));
    process.exit(1);
  }

  const doc = verifyDocBaseline(o, ceilings);
  for (const n of doc.notes) console.log('NOTE ' + n);
  if (doc.failures.length) {
    for (const f of doc.failures) console.error('FAIL ' + f);
    process.exit(1);
  }

  const headSum = headTotals.reduce((a, b) => a + b, 0);
  const baseSum = baseTotals.reduce((a, b) => a + b, 0);
  console.log('verify-flows-size-ratchet: OK (HEAD total ' + headSum + ', ' + o.baseRef + ' total ' + baseSum
    + (headSum > baseSum ? ', growth covered by fix exceptions' : '') + '; committed baseline not exceeded)');
}

if (require.main === module) {
  try { run(); } catch (e) { console.error('verify-flows-size-ratchet: FAIL - ' + e.message); process.exit(1); }
}

module.exports = { checkSurface, checkPayback, measure, buildBaseline, parseExceptions, exceptionErrors, activeExceptions, EXCEPTION_WINDOW_DAYS };
