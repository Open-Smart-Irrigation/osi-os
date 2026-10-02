#!/usr/bin/env node
'use strict';
// Scans documentation, guidance and skill files for customer and gateway
// identities. The name list is private: it arrives in OSI_DOC_HYGIENE_TERMS
// (one case-insensitive regular expression per line) and is never printed,
// and neither is the text it matched.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SCOPE = ['README.md', 'AGENTS.md', 'CLAUDE.md', 'CHANGELOG.md', 'docs', '.claude/skills', '.github', 'analysis'];
const ALLOWLIST_FILE = 'scripts/verify-doc-hygiene-allowlist.json';
const BASELINE_REASON = 'baseline, removed by the documentation run';

// Example identifiers that public text may use.
const FAKE_EUIS = new Set(['0011223344556677', '0102030405060708']);
const FAKE_EUI_RANGES = [/^0016C001F10000[0-9A-F]{2}$/, /^A8404100000000[0-9A-F]{2}$/];

function isFakeEui(token) {
  const t = token.toUpperCase();
  if (/^\d+$/.test(t)) return true; // decimal numbers such as timestamps
  if (FAKE_EUIS.has(t)) return true;
  if (FAKE_EUI_RANGES.some((re) => re.test(t))) return true;
  return new Set(t).size <= 4;
}

const BUILTIN = [
  { id: 'eui64', re: /\b[0-9A-Fa-f]{16}\b/g, skip: isFakeEui },
  { id: 'cgnat-address', re: /\b100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/g, skip: () => false },
];

function loadTerms(raw) {
  const lines = String(raw || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return lines.map((source, i) => {
    const id = `term #${i + 1}`;
    let probe;
    try {
      probe = new RegExp(source, 'i');
    } catch {
      throw new Error(`${id} is not a valid pattern`);
    }
    if (probe.test('')) throw new Error(`${id} matches the empty string`);
    return { id, re: new RegExp(source, 'gi'), skip: () => false };
  });
}

function scanText(text, patterns) {
  const findings = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    for (const p of patterns) {
      for (const m of lines[i].matchAll(p.re)) {
        if (!p.skip(m[0])) findings.push({ line: i + 1, id: p.id });
      }
    }
  }
  return findings;
}

function listFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...SCOPE], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter(Boolean);
}

function scanRepo(root, patterns) {
  const byFile = new Map();
  let scanned = 0;
  for (const rel of listFiles(root)) {
    const abs = path.join(root, rel);
    let stat;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      continue; // tracked but deleted in the working tree
    }
    if (!stat.isFile()) continue; // symlinks, submodules
    const findings = scanText(rel, patterns).map((f) => ({ line: 0, id: f.id }));
    const buf = fs.readFileSync(abs);
    if (!buf.subarray(0, 8000).includes(0)) findings.push(...scanText(buf.toString('utf8'), patterns));
    scanned += 1;
    if (findings.length) byFile.set(rel, findings);
  }
  return { byFile, scanned };
}

function loadAllowlist(root) {
  const file = path.join(root, ALLOWLIST_FILE);
  if (!fs.existsSync(file)) return [];
  const entries = JSON.parse(fs.readFileSync(file, 'utf8')).entries || [];
  for (const e of entries) {
    if (!e.path || !Number.isInteger(e.max) || e.max < 1 || !e.reason || !Number.isInteger(e.issue)) {
      throw new Error(`allowlist entry for ${e.path || '(no path)'} needs path, max >= 1, reason and issue`);
    }
  }
  return entries;
}

function judge(findingsByFile, entries) {
  const allowed = new Map(entries.map((e) => [e.path, e.max]));
  const violations = [];
  for (const [file, findings] of findingsByFile) {
    const max = allowed.get(file) || 0;
    if (findings.length > max) violations.push({ file, findings, max });
  }
  const stale = [];
  for (const e of entries) {
    const actual = (findingsByFile.get(e.path) || []).length;
    if (actual < e.max) stale.push({ file: e.path, max: e.max, actual });
  }
  return { violations, stale };
}

function option(argv, name) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

function main(argv, env) {
  const root = path.resolve(option(argv, 'root') || path.join(__dirname, '..'));
  const raw = env.OSI_DOC_HYGIENE_TERMS || '';
  let terms;
  try {
    terms = loadTerms(raw);
  } catch (err) {
    console.error(`verify-doc-hygiene: ${err.message}`);
    return 2;
  }
  if (!terms.length) {
    if (argv.includes('--require-terms')) {
      console.error('verify-doc-hygiene: OSI_DOC_HYGIENE_TERMS is required but empty');
      return 2;
    }
    console.log('verify-doc-hygiene: name list not supplied, built-in patterns only');
  }

  if (argv.includes('--stdin')) {
    const findings = scanText(fs.readFileSync(0, 'utf8'), [...BUILTIN, ...terms]);
    for (const f of findings) console.error(`stdin:${f.line}: ${f.id}`);
    if (findings.length) {
      console.error(`verify-doc-hygiene: FAIL (${findings.length} findings in the supplied text)`);
      return 1;
    }
    console.log('verify-doc-hygiene: OK (supplied text)');
    return 0;
  }

  const { byFile, scanned } = scanRepo(root, [...BUILTIN, ...terms]);

  if (argv.includes('--write-baseline')) {
    const issue = Number(option(argv, 'issue'));
    if (!Number.isInteger(issue) || issue < 1) {
      console.error('verify-doc-hygiene: --write-baseline needs --issue=<number>');
      return 2;
    }
    const entries = [...byFile.keys()].sort().map((file) => ({ path: file, max: byFile.get(file).length, reason: BASELINE_REASON, issue }));
    fs.mkdirSync(path.dirname(path.join(root, ALLOWLIST_FILE)), { recursive: true });
    fs.writeFileSync(path.join(root, ALLOWLIST_FILE), `${JSON.stringify({ entries }, null, 2)}\n`);
    console.log(`verify-doc-hygiene: baseline written (${entries.length} files)`);
    return 0;
  }

  let entries;
  try {
    entries = loadAllowlist(root);
  } catch (err) {
    console.error(`verify-doc-hygiene: ${err.message}`);
    return 2;
  }
  const { violations, stale } = judge(byFile, entries);
  for (const v of violations) {
    for (const f of v.findings) {
      console.error(f.line === 0 ? `${v.file}: path: ${f.id}` : `${v.file}:${f.line}: ${f.id}`);
    }
    if (v.max) console.error(`${v.file}: ${v.findings.length} findings, allowlist max ${v.max}`);
  }
  for (const s of stale) {
    console.error(`${s.file}: allowlist max ${s.max} but only ${s.actual} found, lower it`);
  }
  if (violations.length || stale.length) {
    console.error(`verify-doc-hygiene: FAIL (${violations.length} files over their limit, ${stale.length} stale allowlist entries)`);
    return 1;
  }
  const allowedCount = entries.reduce((sum, e) => sum + e.max, 0);
  console.log(`verify-doc-hygiene: OK (${scanned} files scanned, ${allowedCount} allowlisted findings in ${entries.length} files)`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2), process.env));

module.exports = { loadTerms, scanText, judge, isFakeEui, main };
