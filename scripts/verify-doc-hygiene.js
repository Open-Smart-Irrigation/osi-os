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
  { id: 'eui64', re: /(?<![0-9A-Fa-f])[0-9A-Fa-f]{16}(?![0-9A-Fa-f])/g, skip: isFakeEui },
  { id: 'eui64', re: /(?<![0-9A-Fa-f:-])(?:[0-9A-Fa-f]{2}[:-]){7}[0-9A-Fa-f]{2}(?![0-9A-Fa-f:-])/g, skip: (m) => isFakeEui(m.replace(/[:-]/g, '')) },
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

// Printed paths never show text matched by a private term.
function maskPath(rel, terms) {
  let out = rel;
  for (const t of terms) out = out.replace(new RegExp(t.re.source, 'gi'), '***');
  return out;
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
    const pathFindings = scanText(rel, patterns).map((f) => ({ line: 0, id: f.id }));
    let stat;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      if (pathFindings.length) byFile.set(rel, { pathFindings, findings: [] });
      continue; // tracked but deleted in the working tree
    }
    if (!stat.isFile()) {
      // symlinks, submodules: content is not read, the path still counts
      if (pathFindings.length) byFile.set(rel, { pathFindings, findings: [] });
      continue;
    }
    const findings = [];
    const buf = fs.readFileSync(abs);
    if (!buf.subarray(0, 8000).includes(0)) findings.push(...scanText(buf.toString('utf8'), patterns));
    scanned += 1;
    if (pathFindings.length || findings.length) byFile.set(rel, { pathFindings, findings });
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
  for (const [file, { pathFindings, findings }] of findingsByFile) {
    const max = allowed.get(file) || 0;
    if (pathFindings.length || findings.length > max) violations.push({ file, pathFindings, findings, max });
  }
  const stale = [];
  for (const e of entries) {
    const actual = (findingsByFile.get(e.path) || { findings: [] }).findings.length;
    if (actual < e.max) stale.push({ file: e.path, max: e.max, actual });
  }
  return { violations, stale };
}

// Unquotes a path as git prints it when it contains special characters:
// "docs/a \"b\" \303\274.md" (C escapes, octal bytes). Unquoted paths pass through.
function unquoteGitPath(text) {
  if (!text.startsWith('"')) return text;
  const bytes = [];
  const simple = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  for (let i = 1; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"') break;
    if (ch !== '\\') {
      const cp = text.codePointAt(i);
      bytes.push(...Buffer.from(String.fromCodePoint(cp), 'utf8'));
      if (cp > 0xffff) i += 1;
      continue;
    }
    const next = text[i + 1];
    if (next === undefined) break;
    if (/[0-7]/.test(next)) {
      const oct = text.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0];
      bytes.push(parseInt(oct, 8) & 0xff);
      i += oct.length;
    } else {
      bytes.push(next in simple ? simple[next] : next.charCodeAt(0));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// Path of a `diff --git a/P b/P` header (renames are off, so both sides match).
function diffHeaderPath(rest) {
  // a quoted a-path ends at its first unescaped quote
  if (rest.startsWith('"')) return unquoteGitPath(rest).replace(/^a\//, '');
  const half = (rest.length - 1) / 2;
  return rest.slice(2, half);
}

// Scans the lines that commits add, from
// `git log -p --text --diff-merges=remerge --no-renames --format='commit %H' <range> -- <scope>`
// output. In a remerge diff the conflict markers and both sides are removed
// lines; only the resolution's added lines are scanned.
// Files with an allowlist entry are skipped: the tip scan governs their count.
function scanDiff(text, patterns, allowed) {
  const findings = [];
  let sha = null;
  let file = null;
  let deleted = false;
  let inHeader = false;
  let inHunk = false;
  const finishHeader = () => {
    if (inHeader && file !== null && !deleted && !allowed.has(file)) {
      for (const f of scanText(file, patterns)) findings.push({ sha, file, kind: 'path', id: f.id });
    }
    inHeader = false;
  };
  for (const line of text.split('\n')) {
    // git cannot remerge an octopus merge and says so in the stream; its
    // lines would go unscanned, so the whole input is unusable.
    if (line.startsWith('diff: warning: Skipping remerge-diff')) {
      throw new Error('the supplied log skipped a merge diff; cannot scan');
    }
    if (/^commit [0-9a-f]{40,64}$/.test(line)) {
      finishHeader();
      sha = line.slice(7);
      file = null;
      inHunk = false;
    } else if (line.startsWith('diff --git ')) {
      finishHeader();
      file = diffHeaderPath(line.slice('diff --git '.length));
      deleted = false;
      inHeader = true;
      inHunk = false;
    } else if (inHeader) {
      if (line.startsWith('deleted file mode') || line === '+++ /dev/null') {
        deleted = true;
      } else if (line.startsWith('+++ ')) {
        // git appends a tab to an unquoted name that contains a space
        file = unquoteGitPath(line.slice(4).replace(/\t$/, '')).replace(/^b\//, '');
      } else if (line.startsWith('@@')) {
        finishHeader();
        inHunk = true;
      }
    } else if (inHunk && line.startsWith('+') && !line.includes('\u0000') && file !== null && !deleted && !allowed.has(file)) {
      // A line with a NUL is binary content, which the tip scan skips as well.
      for (const f of scanText(line.slice(1), patterns)) findings.push({ sha, file, kind: 'added line', id: f.id });
    }
  }
  finishHeader();
  return findings;
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

  if (argv.includes('--stdin-diff')) {
    let entries;
    try {
      entries = loadAllowlist(root);
    } catch (err) {
      console.error(`verify-doc-hygiene: ${err.message}`);
      return 2;
    }
    const allowed = new Set(entries.map((e) => e.path));
    let findings;
    try {
      findings = scanDiff(fs.readFileSync(0, 'utf8'), [...BUILTIN, ...terms], allowed);
    } catch (err) {
      console.error(`verify-doc-hygiene: ${err.message}`);
      return 2;
    }
    for (const f of findings) {
      console.error(`${(f.sha || '(none)').slice(0, 7)} ${maskPath(f.file, terms)}: ${f.kind}: ${f.id}`);
    }
    if (findings.length) {
      console.error(`verify-doc-hygiene: FAIL (${findings.length} findings in added lines of the supplied commits)`);
      return 1;
    }
    console.log('verify-doc-hygiene: OK (supplied commits)');
    return 0;
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
    const named = [...byFile.keys()].sort().filter((file) => byFile.get(file).pathFindings.length);
    if (named.length) {
      for (const file of named) {
        for (const f of byFile.get(file).pathFindings) console.error(`${maskPath(file, terms)}: path: ${f.id}`);
      }
      console.error(`verify-doc-hygiene: cannot write a baseline while ${named.length} paths carry a listed term; rename or remove them first`);
      return 1;
    }
    const entries = [...byFile.keys()].sort().map((file) => ({ path: file, max: byFile.get(file).findings.length, reason: BASELINE_REASON, issue }));
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
  const judged = judge(byFile, entries);
  const violations = judged.violations;
  // Without the name list the private matches are invisible, so a count that
  // includes them would look stale; staleness is only checked with the list.
  const stale = terms.length ? judged.stale : [];
  for (const v of violations) {
    const shown = maskPath(v.file, terms);
    for (const f of v.pathFindings) console.error(`${shown}: path: ${f.id}`);
    for (const f of v.findings) console.error(`${shown}:${f.line}: ${f.id}`);
    if (v.max) console.error(`${shown}: ${v.findings.length} findings, allowlist max ${v.max}`);
  }
  for (const s of stale) {
    console.error(`${maskPath(s.file, terms)}: allowlist max ${s.max} but only ${s.actual} found, lower it`);
  }
  if (violations.length || stale.length) {
    console.error(`verify-doc-hygiene: FAIL (${violations.length} files over their limit, ${stale.length} stale allowlist entries)`);
    return 1;
  }
  const allowedCount = entries.reduce((sum, e) => sum + e.max, 0);
  if (!terms.length) {
    console.log(`verify-doc-hygiene: OK (${scanned} files scanned, built-in patterns only; allowlist staleness not checked)`);
    return 0;
  }
  console.log(`verify-doc-hygiene: OK (${scanned} files scanned, ${allowedCount} allowlisted findings in ${entries.length} files)`);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2), process.env));

module.exports = { SCOPE, loadTerms, scanText, scanDiff, unquoteGitPath, judge, isFakeEui, maskPath, main };
