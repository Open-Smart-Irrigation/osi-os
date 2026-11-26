#!/usr/bin/env node
'use strict';
// Verifier for the dispatch-boundary contract between the Node-RED backend and
// the Go port: edge/contracts/dispatch-inventory.json.
//
//   node edge/harness/verify-dispatch-inventory.js             per-row summary; exit 1 on any failure
//   node edge/harness/verify-dispatch-inventory.js --markdown  print edge/contracts/DISPATCH-INVENTORY.md
//   node edge/harness/verify-dispatch-inventory.js --write-markdown
//   node edge/harness/verify-dispatch-inventory.js --fix-lines rewrite line numbers of anchors that moved
//   node edge/harness/verify-dispatch-inventory.js --scan      entry points and the effects they reach
//
// A failure is any of: a check with go null, probe null or status "open"; a
// file, line or excerpt that does not resolve; a probe file or step id that
// does not exist; a Go entry point that reaches an effect sink with no
// inventory entry for that effect; an inventory entry the scan cannot match.
const fs = require('node:fs'), path = require('node:path');
const { scan, SINK_EFFECTS } = require('./lib/dispatch-scan');

const ROOT = path.resolve(__dirname, '../..');
const INVENTORY = 'edge/contracts/dispatch-inventory.json';
const MARKDOWN = 'edge/contracts/DISPATCH-INVENTORY.md';
const SCHEMA = 'database/seed-blank.sql';
const KINDS = ['http', 'timer', 'uplink', 'startup', 'shared'];

function repoIO(root = ROOT) {
  return {
    read: (p) => fs.readFileSync(path.join(root, p), 'utf8'),
    exists: (p) => fs.existsSync(path.join(root, p)) && fs.statSync(path.join(root, p)).isFile(),
    goFiles: () => {
      const out = [];
      (function walk(d) {
        for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
          const p = path.posix.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (p.endsWith('.go') && !p.endsWith('_test.go')) out.push(p);
        }
      })('edge/go');
      return out.sort();
    },
  };
}

// "path:12" or "path:12-15".
function parseRef(ref) {
  const m = /^([^:#\s]+):(\d+)(?:-(\d+))?$/.exec(ref || '');
  if (!m) return null;
  const start = Number(m[2]), end = m[3] ? Number(m[3]) : start;
  return { file: m[1], start, end: Math.max(start, end) };
}

function makeLines(io) {
  const cache = new Map();
  return (file) => {
    if (!cache.has(file)) cache.set(file, io.exists(file) ? io.read(file).split('\n') : null);
    return cache.get(file);
  };
}

// Resolve one reference and its excerpt. Returns {ok, problem, movedTo}.
function checkRef(lines, ref, excerpt, label) {
  if (ref == null) return { ok: false, problem: `${label} is null` };
  const r = parseRef(ref);
  if (!r) return { ok: false, problem: `${label} "${ref}" is not path:line or path:start-end` };
  const ls = lines(r.file);
  if (!ls) return { ok: false, problem: `${label} file ${r.file} does not exist` };
  if (r.end > ls.length) return { ok: false, problem: `${label} ${ref}: file has only ${ls.length} lines` };
  if (!excerpt) return { ok: false, problem: `${label} ${ref} has no excerpt to re-find it by` };
  // Search the whole text, so an excerpt may span lines (joined by "\n").
  const text = ls.join('\n');
  const hits = [];
  for (let at = text.indexOf(excerpt); at !== -1; at = text.indexOf(excerpt, at + 1)) hits.push(text.slice(0, at).split('\n').length);
  if (!hits.length) return { ok: false, problem: `${label} ${ref}: excerpt ${JSON.stringify(excerpt)} not found in ${r.file}` };
  if (hits.length > 1) return { ok: false, problem: `${label} ${ref}: excerpt ${JSON.stringify(excerpt)} occurs ${hits.length} times in ${r.file} (lines ${hits.slice(0, 5).join(', ')}); make it unique` };
  const at = hits[0];
  if (at !== r.start) {
    if (at > r.start && at <= r.end) return { ok: false, problem: `${label} ${ref}: excerpt is on line ${at}; it must be on the first line of the range`, movedTo: at };
    return { ok: false, problem: `${label} ${ref}: excerpt is now at line ${at} (run --fix-lines)`, movedTo: at };
  }
  return { ok: true };
}

function checkProbe(io, probe) {
  if (probe == null) return 'probe is null';
  const m = /^(edge\/harness\/scenarios\/[^#]+\.json)#(.+)$/.exec(probe);
  if (!m) return `probe "${probe}" is not edge/harness/scenarios/<file>.json#<step-id>`;
  if (!io.exists(m[1])) return `probe file ${m[1]} does not exist`;
  let sc;
  try { sc = JSON.parse(io.read(m[1])); } catch (e) { return `probe file ${m[1]} is not JSON: ${e.message}`; }
  if (!Array.isArray(sc.steps) || !sc.steps.some((s) => s && s.id === m[2])) return `probe step "${m[2]}" not in ${m[1]}`;
  return null;
}

const entryKey = (kind, name) => `${kind} ${name}`;

function verify({ inventory, io, canary = true }) {
  const lines = makeLines(io);
  const failures = [];
  const rows = [];
  const fixes = [];
  const fail = (where, problem) => failures.push({ where, problem });
  if (!inventory || !Array.isArray(inventory.entries)) {
    fail('inventory', 'no entries array');
    return { rows, failures, fixes, scanResult: null, counts: { entries: 0, checks: 0, ok: 0, open: 0 } };
  }
  const shared = inventory.entries.filter((e) => e.entry && e.entry.kind === 'shared').map((e) => e.entry.name);
  const goFiles = io.goFiles();
  const scanResult = scan(goFiles.map((f) => ({ file: f, text: io.read(f) })), io.read(SCHEMA), shared, { canary });
  for (const p of scanResult.problems) fail('scan', p);

  const scanned = new Map(scanResult.entries.map((e) => [entryKey(e.kind, e.name), e]));
  const covered = new Map();
  const ids = new Set(), checkIds = new Set();
  let checks = 0, ok = 0, open = 0;

  for (const [i, e] of inventory.entries.entries()) {
    const where = e.id || `entries[${i}]`;
    const row = { id: where, entry: e.entry || {}, effects: e.effects || [], reportRows: e.rows || [], checks: [], problems: [] };
    rows.push(row);
    const bad = (p) => { row.problems.push(p); fail(where, p); };
    if (!e.id) bad('entry has no id');
    else if (ids.has(e.id)) bad(`duplicate entry id ${e.id}`);
    ids.add(e.id);
    const en = e.entry || {};
    if (!KINDS.includes(en.kind)) bad(`entry.kind ${JSON.stringify(en.kind)} is not one of ${KINDS.join('|')}`);
    if (!en.name) bad('entry.name is empty');
    if (!Array.isArray(e.effects) || !e.effects.length) bad('effects is empty');
    const er = checkRef(lines, en.go, en.goExcerpt, 'entry.go');
    if (!er.ok) { bad(er.problem); if (er.movedTo) fixes.push({ obj: en, field: 'go', to: er.movedTo }); }
    // Scan pairing: every Go-backed entry must be one the scan found.
    const names = [en.name, ...(en.aliases || [])];
    const goBacked = en.go && /\.go:/.test(en.go);
    for (const n of names) {
      const s = scanned.get(entryKey(en.kind, n));
      if (s) {
        const set = covered.get(s) || new Set();
        (e.effects || []).forEach((x) => set.add(x));
        covered.set(s, set);
        if (goBacked && parseRef(en.go) && s.go && parseRef(en.go).file !== parseRef(s.go).file) bad(`entry.go is in ${parseRef(en.go).file}, the scan finds ${en.kind} ${n} handled in ${s.go}`);
      } else if (goBacked) {
        bad(`no Go ${en.kind} entry point "${n}" found by the scan (renamed or removed?)`);
      }
    }
    if (!Array.isArray(e.checks) || !e.checks.length) bad('entry has no checks');
    for (const [j, c] of (e.checks || []).entries()) {
      checks++;
      const cw = `${where}/${c.id || 'checks[' + j + ']'}`;
      const cr = { id: c.id, row: c.row, what: c.what, status: c.status, problems: [] };
      row.checks.push(cr);
      const cbad = (p) => { cr.problems.push(p); fail(cw, p); };
      if (!c.id) cbad('check has no id');
      else if (checkIds.has(`${where}/${c.id}`)) cbad(`duplicate check id ${c.id}`);
      checkIds.add(`${where}/${c.id}`);
      if (!c.what) cbad('check has no "what"');
      if (!['ok', 'open'].includes(c.status)) cbad(`status ${JSON.stringify(c.status)} is not "ok" or "open"`);
      if (c.status === 'open') { open++; cbad(`status open${c.finding ? ' (' + c.finding + ')' : ''}`); } else if (c.status === 'ok') ok++;
      if (!Number.isInteger(c.order)) cbad('order is not an integer');
      const jr = checkRef(lines, c.js, c.jsExcerpt, 'js');
      if (!jr.ok) { cbad(jr.problem); if (jr.movedTo) fixes.push({ obj: c, field: 'js', to: jr.movedTo }); }
      if (c.go === null) cbad('go is null: no Go counterpart yet');
      else {
        const gr = checkRef(lines, c.go, c.goExcerpt, 'go');
        if (!gr.ok) { cbad(gr.problem); if (gr.movedTo) fixes.push({ obj: c, field: 'go', to: gr.movedTo }); }
      }
      for (const [k, ref] of (c.refs || []).entries()) {
        const rr = checkRef(lines, ref.at, ref.excerpt, `refs[${k}]`);
        if (!rr.ok) { cbad(rr.problem); if (rr.movedTo) fixes.push({ obj: ref, field: 'at', to: rr.movedTo }); }
      }
      const pp = checkProbe(io, c.probe);
      if (pp) cbad(pp);
    }
  }

  // Coverage: every effect a Go entry point reaches needs an inventory entry.
  const missing = [];
  for (const s of scanResult.entries) {
    const have = covered.get(s) || new Set();
    for (const [effect, how] of Object.entries(s.effects)) {
      if (!have.has(effect)) {
        missing.push({ kind: s.kind, name: s.name, effect, how });
        fail(`${s.kind} ${s.name}`, `reaches ${effect} (${how.sink} at ${how.at}, via ${how.chain.join(' > ')}) but no inventory entry lists it`);
      }
    }
    // Canary: a claimed sink effect the scan cannot reach means the row or the scan is stale.
    for (const effect of have) {
      if (SINK_EFFECTS.includes(effect) && !s.effects[effect]) fail(`${s.kind} ${s.name}`, `inventory lists effect ${effect}, but the scan finds no path from ${s.handler} to a ${effect} sink`);
    }
  }
  return { rows, failures, fixes, missing, scanResult, counts: { entries: inventory.entries.length, checks, ok, open } };
}

// An excerpt sits on the first line of its range, so a moved anchor moves the
// whole range by the same distance.
function applyFixes(fixes) {
  for (const f of fixes) {
    const r = parseRef(f.obj[f.field]);
    const span = r.end - r.start;
    f.obj[f.field] = span ? `${r.file}:${f.to}-${f.to + span}` : `${r.file}:${f.to}`;
  }
}

// ---- Output ---------------------------------------------------------------

function summary(result) {
  const out = [];
  const { counts } = result;
  for (const row of result.rows) {
    const o = row.checks.filter((c) => c.status === 'ok').length, op = row.checks.filter((c) => c.status === 'open').length;
    const bad = row.problems.length || row.checks.some((c) => c.problems.length);
    out.push(`${bad ? 'FAIL' : 'ok  '} ${row.id.padEnd(30)} ${(row.entry.kind || '?').padEnd(7)} ${row.entry.name || '?'} -> ${row.effects.join(',')}  [${o} ok / ${op} open]`);
    for (const p of row.problems) out.push(`       ! ${p}`);
    for (const c of row.checks) for (const p of c.problems) out.push(`       ! ${c.id}${c.row ? ' (report row ' + c.row + ')' : ''}: ${p}`);
  }
  const other = result.failures.filter((f) => f.where === 'scan' || / /.test(f.where) && !result.rows.some((r) => f.where === r.id || f.where.startsWith(r.id + '/')));
  if (other.length) {
    out.push('', 'Entry points and scan:');
    for (const f of other) out.push(`  ! ${f.where}: ${f.problem}`);
  }
  out.push('', `${counts.entries} entries, ${counts.checks} checks: ${counts.ok} ok, ${counts.open} open; ${result.missing ? result.missing.length : 0} reached effect(s) without an entry; ${result.failures.length} failure(s).`);
  return out.join('\n');
}

const mdCell = (s) => String(s == null ? '—' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const short = (ref) => (ref ? ref.replace(/^conf\/full_raspberrypi_bcm27xx_bcm2712\/files\/usr\/share\/node-red\//, 'NR/').replace(/^conf\/full_raspberrypi_bcm27xx_bcm2712\/files\/usr\/share\/flows\.json/, 'flows.json').replace(/^edge\/go\/cmd\/osi-edge\//, 'GO/') : null);
const probeShort = (p) => (p ? p.replace(/^edge\/harness\/scenarios\//, '') : null);

function markdown(inventory, result) {
  const L = [];
  const { counts } = result;
  L.push('# Dispatch inventory: where the Go port may send, publish or write');
  L.push('');
  L.push('Generated from `edge/contracts/dispatch-inventory.json` by `node edge/harness/verify-dispatch-inventory.js --write-markdown`. Do not edit this file by hand; edit the JSON and regenerate.');
  L.push('');
  L.push('The Go port must never send, publish or write where the shipped Node-RED backend does not (CHARTER §1.4). Each entry below is one Go entry point and the effects it ends in. Each check is a test Node-RED makes before the effect, with its JavaScript line, the Go line that makes the same test, and a scenario step that exercises it on both backends.');
  L.push('');
  L.push('## Rules');
  L.push('');
  for (const r of inventory.rules || []) L.push(`${r}`), L.push('');
  L.push('## How a reviewer uses it');
  L.push('');
  for (const r of inventory.reviewerSteps || []) L.push(`- ${r}`);
  L.push('');
  L.push('## Keeping line numbers current');
  L.push('');
  for (const r of inventory.updateProcedure || []) L.push(`- ${r}`);
  L.push('');
  L.push('## Running the probes');
  L.push('');
  for (const r of inventory.probeNotes || []) L.push(`- ${r}`);
  L.push('');
  if ((inventory.probeEvidence || []).length) {
    L.push('## What the probes recorded');
    L.push('');
    L.push('Node-RED oracle recordings at the inventory\'s `checkedAt` commit; cassettes are not committed.');
    L.push('');
    for (const r of inventory.probeEvidence) L.push(`- ${r}`);
    L.push('');
  }
  L.push('## Effect sinks the verifier scans for');
  L.push('');
  for (const r of inventory.sinkNotes || []) L.push(`- ${r}`);
  L.push('');
  L.push('## Status');
  L.push('');
  L.push(`${counts.entries} entries, ${counts.checks} checks: ${counts.ok} ok, ${counts.open} open. A check is open when Go has no counterpart yet (go is null) or the probe is missing; the verifier fails until every check is ok.`);
  L.push('');
  const openChecks = [];
  for (const e of inventory.entries) for (const c of e.checks || []) if (c.status === 'open') openChecks.push([e, c]);
  if (openChecks.length) {
    L.push('| Entry | Check | Finding | Note |');
    L.push('|---|---|---|---|');
    for (const [e, c] of openChecks) L.push(`| ${mdCell(e.id)} | ${mdCell(c.id)} | ${mdCell(c.finding)} | ${mdCell(c.note)} |`);
    L.push('');
  }
  L.push('## Entries');
  L.push('');
  L.push('Paths: `NR/` is `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/`, `flows.json` is `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`, `GO/` is `edge/go/cmd/osi-edge/`, probes are under `edge/harness/scenarios/`. "Row" is the row number in the 24 Nov dispatch review.');
  L.push('');
  L.push('| Entry | Kind | Name | Go | Effects | Checks |');
  L.push('|---|---|---|---|---|---|');
  for (const e of inventory.entries) {
    const o = (e.checks || []).filter((c) => c.status === 'ok').length, op = (e.checks || []).filter((c) => c.status === 'open').length;
    const names = [e.entry.name, ...(e.entry.aliases || [])].map((n) => '`' + n + '`').join(', ');
    L.push(`| [${e.id}](#${e.id}) | ${e.entry.kind} | ${mdCell(names)} | \`${short(e.entry.go)}\` | ${e.effects.join(', ')} | ${o} ok / ${op} open |`);
  }
  L.push('');
  for (const e of inventory.entries) {
    L.push(`### ${e.id}`);
    L.push('');
    const names = [e.entry.name, ...(e.entry.aliases || [])].map((n) => '`' + n + '`').join(', ');
    L.push(`${e.entry.kind} ${names}, Go \`${short(e.entry.go)}\`. Effects: ${e.effects.join(', ')}.${e.boundary ? ' ' + e.boundary : ''}`);
    L.push('');
    L.push('| # | Row | Check | JS | Go | Probe | Status |');
    L.push('|---|---|---|---|---|---|---|');
    for (const c of e.checks || []) {
      const st = c.status === 'open' ? `**open**${c.finding ? ' (' + c.finding + ')' : ''}` : 'ok';
      L.push(`| ${c.order} | ${mdCell(c.row)} | ${mdCell(c.what)}${c.note ? ' *' + mdCell(c.note) + '*' : ''} | \`${mdCell(short(c.js))}\` | ${c.go ? '`' + mdCell(short(c.go)) + '`' : '**none**'} | ${c.probe ? '`' + mdCell(probeShort(c.probe)) + '`' : '**none**'} | ${st} |`);
    }
    L.push('');
  }
  return L.join('\n');
}

function scanText(result) {
  const out = [];
  for (const e of result.scanResult.entries) {
    out.push(`${e.kind} ${e.name}  [${e.recv ? '(' + e.recv + ').' : ''}${e.handler} ${e.go || '?'}]`);
    for (const v of e.sites || []) out.push(`    ${v.effect}: ${v.sink} at ${v.at} via ${v.chain.join(' > ')}`);
    for (const [k, v] of Object.entries(e.viaShared || {})) out.push(`    shared ${k} via ${v.join(' > ')}`);
  }
  return out.join('\n');
}

function main(argv) {
  const io = repoIO();
  const inventory = JSON.parse(io.read(INVENTORY));
  const result = verify({ inventory, io });
  if (argv.includes('--scan')) { console.log(scanText(result)); return 0; }
  if (argv.includes('--fix-lines')) {
    applyFixes(result.fixes);
    fs.writeFileSync(path.join(ROOT, INVENTORY), JSON.stringify(inventory, null, 2) + '\n');
    console.log(`rewrote ${result.fixes.length} reference(s) in ${INVENTORY}`);
    return 0;
  }
  if (argv.includes('--markdown')) { process.stdout.write(markdown(inventory, result) + '\n'); return 0; }
  if (argv.includes('--write-markdown')) {
    fs.writeFileSync(path.join(ROOT, MARKDOWN), markdown(inventory, result) + '\n');
    console.log('wrote ' + MARKDOWN);
    return 0;
  }
  console.log(summary(result));
  return result.failures.length ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { verify, markdown, summary, parseRef, checkRef, repoIO, applyFixes, INVENTORY, MARKDOWN };
