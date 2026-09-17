#!/usr/bin/env node
'use strict';

// verify-flows-output-arity: statically sweeps every `function`-type node in
// the canonical flows.json for a `return [...]` (or `node.send([...])`) array
// literal whose element count exceeds the node's real output-port count
// (`wires.length` — the array Node-RED's runtime actually indexes into when
// routing a returned/sent array of messages, regardless of the cosmetic
// editor `outputs` field).
//
// Why: F28 (2026-09-17 Silvan harness, run-full2/Z2.md) — `assign-device-update`
// declared `outputs: 1` (one wire) but returned `[null, msg]` on its
// not-found path. Node-RED's Function node sends array element i to
// `this.wires[i]`; index 1 had no wire, so the 404 response was silently
// dropped and `PUT /api/irrigation-zones/:id/devices/:deveui` for an unknown
// DevEUI hung forever (client-side timeout, not a fast failure). No existing
// verifier checked returned-array length against actual wiring.
//
// Scope: bcm2712 only. verify-profile-parity.js (chained from
// verify-sync-flow.js) guarantees the bcm2709 mirror is byte-identical to
// bcm2712, so re-scanning it here would be redundant. bcm2708 is a legacy,
// unmaintained, divergent flows.json out of scope for this and several
// sibling verifiers (see verify-command-safety.js, verify-no-stray-ddl.js).
//
// Method (regex/bracket static analysis, not a real JS parser — no parser
// package is vendored in this repo; see verify-flows-fn-parse.js for the
// same constraint solved via `new Function` instead):
//   1. Find every `return [` / `node.send([` occurrence in a function node's
//      `func` source.
//   2. Walk forward tracking bracket/paren/brace depth, skipping the
//      contents of strings, template literals (with nested `${...}`),
//      line/block comments, and regex literals (heuristic: a `/` starts a
//      regex unless the previous significant token looks like the end of a
//      value expression), to find the matching closing `]` and the
//      top-level (depth-1) comma-separated element boundaries.
//   3. Classify each element as `literal` (a bare string or numeric literal)
//      or `structural` (anything else: `null`, an identifier, a call, an
//      object/array literal, a ternary, ...). An array whose elements are
//      ALL `literal` is a plain data list (e.g. `['swt_1','swt_2','swt_3']`,
//      `[400, 401, 403]`), not a Node-RED multi-output routing array, and is
//      excluded from the arity check — Node-RED message-routing arrays in
//      this codebase always carry at least one `null` placeholder or a
//      message-shaped value.
//   4. Flag any array with at least one `structural` element whose length
//      exceeds the node's `wires.length`.
//
// Known limits (documented, not silently papered over):
//   - A `return [...]` nested inside a helper `function`/arrow declared
//     *inside* the node's `func` (not the top-level async body) is still
//     scanned positionally; the literal/structural split is what keeps this
//     from false-positiving on helper functions that build plain data lists
//     (verified empirically against every current `return [...]` site in
//     the canonical flows.json — see git history for the sweep run this
//     script's addition was based on). A helper that returns a *mixed*
//     literal/structural array feeding some other computation (not node
//     output) is a theoretical false-positive this heuristic cannot rule
//     out; none exist in the current file.
//   - `node.send(...)` calls that build the array across multiple
//     statements (e.g. `const out = []; out.push(x); node.send(out);`) are
//     not tracked — only an array literal written directly at the call site
//     is checked.

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CANONICAL_FLOWS = path.join(
  REPO_ROOT,
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json'
);

function skipWsAndComments(src, i) {
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') {
      i += 2;
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    break;
  }
  return i;
}

const REGEX_PRECEDING_CHARS = new Set([
  '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '\n',
  '+', '-', '*', '%', '<', '>',
]);
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

function looksLikeRegexStart(src, k) {
  let p = k - 1;
  while (p >= 0 && /\s/.test(src[p])) p -= 1;
  if (p < 0) return true;
  const c = src[p];
  if (REGEX_PRECEDING_CHARS.has(c)) return true;
  if (/[A-Za-z0-9_$]/.test(c)) {
    let start = p;
    while (start >= 0 && /[A-Za-z0-9_$]/.test(src[start])) start -= 1;
    const word = src.slice(start + 1, p + 1);
    return REGEX_PRECEDING_KEYWORDS.has(word);
  }
  return false;
}

// Classify one top-level array element's raw (trimmed) source text.
function classifyElement(raw) {
  const t = raw.trim();
  if (t === '') return 'empty';
  if (/^-?\d+(\.\d+)?$/.test(t)) return 'literal';
  if (/^'(?:[^'\\]|\\.)*'$/.test(t)) return 'literal';
  if (/^"(?:[^"\\]|\\.)*"$/.test(t)) return 'literal';
  return 'structural';
}

// Scan `src` for every occurrence of `prefixRe` immediately followed (after
// whitespace/comments) by `[`, and return the parsed array info for each
// balanced occurrence found.
function scanBracketedArrays(src, prefixRe) {
  const n = src.length;
  const results = [];
  let m;
  prefixRe.lastIndex = 0;
  while ((m = prefixRe.exec(src))) {
    const afterKeyword = m.index + m[0].length;
    const j = skipWsAndComments(src, afterKeyword);
    if (src[j] !== '[') { prefixRe.lastIndex = afterKeyword; continue; }

    const start = j;
    let depth = 0;
    let k = j;
    let balanced = false;
    let elementStart = j + 1;
    const elements = [];

    while (k < n) {
      const c = src[k];
      if (c === '[') { depth += 1; k += 1; continue; }
      if (c === ']') {
        depth -= 1;
        k += 1;
        if (depth === 0) {
          elements.push(src.slice(elementStart, k - 1));
          balanced = true;
          break;
        }
        continue;
      }
      if (c === '(' || c === '{') { depth += 1; k += 1; continue; }
      if (c === ')' || c === '}') { depth -= 1; k += 1; continue; }
      if (c === '"' || c === "'") {
        const quote = c;
        k += 1;
        while (k < n && src[k] !== quote) {
          if (src[k] === '\\') k += 1;
          k += 1;
        }
        k += 1;
        continue;
      }
      if (c === '`') {
        k += 1;
        while (k < n) {
          if (src[k] === '\\') { k += 2; continue; }
          if (src[k] === '`') { k += 1; break; }
          if (src[k] === '$' && src[k + 1] === '{') {
            k += 2;
            let braceDepth = 1;
            while (k < n && braceDepth > 0) {
              if (src[k] === '{') braceDepth += 1;
              else if (src[k] === '}') braceDepth -= 1;
              else if (src[k] === '"' || src[k] === "'") {
                const q = src[k];
                k += 1;
                while (k < n && src[k] !== q) { if (src[k] === '\\') k += 1; k += 1; }
              }
              k += 1;
            }
            continue;
          }
          k += 1;
        }
        continue;
      }
      if (c === '/' && src[k + 1] === '/') {
        k += 2;
        while (k < n && src[k] !== '\n') k += 1;
        continue;
      }
      if (c === '/' && src[k + 1] === '*') {
        k += 2;
        while (k < n && !(src[k] === '*' && src[k + 1] === '/')) k += 1;
        k += 2;
        continue;
      }
      if (c === '/' && looksLikeRegexStart(src, k)) {
        k += 1;
        let inClass = false;
        while (k < n) {
          if (src[k] === '\\') { k += 2; continue; }
          if (src[k] === '[') { inClass = true; k += 1; continue; }
          if (src[k] === ']') { inClass = false; k += 1; continue; }
          if (src[k] === '/' && !inClass) { k += 1; break; }
          k += 1;
        }
        while (k < n && /[a-z]/i.test(src[k])) k += 1;
        continue;
      }
      if (c === ',' && depth === 1) {
        elements.push(src.slice(elementStart, k));
        elementStart = k + 1;
        k += 1;
        continue;
      }
      k += 1;
    }

    if (!balanced) {
      results.push({ start, length: null, balanced: false, snippet: src.slice(start, Math.min(k, start + 60)) });
      prefixRe.lastIndex = afterKeyword;
      continue;
    }

    let elems = elements
      .map((e) => e.trim())
      .filter((e, idx, arr) => !(e === '' && idx === arr.length - 1 && arr.length > 0));
    if (elems.length === 1 && elems[0] === '') elems = [];

    const classes = elems.map(classifyElement);
    const allLiteral = elems.length > 0 && classes.every((c) => c === 'literal');

    results.push({
      start,
      length: elems.length,
      balanced: true,
      allLiteral,
      snippet: src.slice(start, Math.min(k, start + 70)).replace(/\s+/g, ' '),
    });
    prefixRe.lastIndex = k;
  }
  return results;
}

function scanFunctionNode(node) {
  const src = node.func;
  const wiresLen = Array.isArray(node.wires) ? node.wires.length : 0;
  const findings = [];
  const arrayGroups = [
    { re: /\breturn\b/g, label: 'return' },
    { re: /\bnode\.send\s*\(/g, label: 'node.send(' },
  ];
  for (const group of arrayGroups) {
    for (const a of scanBracketedArrays(src, group.re)) {
      if (!a.balanced) {
        findings.push({ kind: 'unbalanced', label: group.label, snippet: a.snippet });
        continue;
      }
      if (a.allLiteral) continue;
      if (a.length > wiresLen) {
        findings.push({
          kind: 'arity',
          label: group.label,
          wiresLen,
          arrayLength: a.length,
          snippet: a.snippet,
        });
      }
    }
  }
  return findings;
}

function checkFlows(flows) {
  const arityFailures = [];
  const unbalancedWarnings = [];
  let functionNodes = 0;
  let sourcesChecked = 0;
  for (const node of flows) {
    if (!node || node.type !== 'function' || typeof node.func !== 'string' || !node.func.trim()) continue;
    functionNodes += 1;
    sourcesChecked += 1;
    for (const finding of scanFunctionNode(node)) {
      if (finding.kind === 'unbalanced') {
        unbalancedWarnings.push({ id: node.id, name: node.name || '(unnamed)', ...finding });
      } else {
        arityFailures.push({ id: node.id, name: node.name || '(unnamed)', ...finding });
      }
    }
  }
  return { arityFailures, unbalancedWarnings, functionNodes, sourcesChecked };
}

function run() {
  if (!fs.existsSync(CANONICAL_FLOWS)) {
    console.error('verify-flows-output-arity: FAIL - canonical flows.json not found at ' + CANONICAL_FLOWS);
    process.exit(1);
  }
  const rel = path.relative(REPO_ROOT, CANONICAL_FLOWS);
  const raw = fs.readFileSync(CANONICAL_FLOWS, 'utf8');
  const flows = JSON.parse(raw);
  if (!Array.isArray(flows)) {
    console.error('verify-flows-output-arity: FAIL - ' + rel + ' is not a JSON array');
    process.exit(1);
  }

  const { arityFailures, unbalancedWarnings, functionNodes, sourcesChecked } = checkFlows(flows);

  for (const w of unbalancedWarnings) {
    console.warn(
      'WARN ' + rel + ': node ' + w.id + ' ("' + w.name + '") has an unbalanced ' +
      w.label + ' array this scanner could not fully parse: ' + w.snippet
    );
  }

  if (arityFailures.length) {
    console.error('FAIL: ' + arityFailures.length + ' flow output-arity regression(s):');
    for (const f of arityFailures) {
      console.error(
        '  - ' + f.name + ' [' + f.id + ']: ' + f.label + ' array has ' + f.arrayLength +
        ' element(s) but the node only has ' + f.wiresLen + ' wired output(s) -- ' + f.snippet
      );
    }
    console.error('verify-flows-output-arity: FAIL');
    process.exit(1);
  }

  console.log(
    'OK ' + rel + ' (' + functionNodes + ' function nodes, ' + sourcesChecked +
    ' sources scanned, 0 output-arity regressions)'
  );
  console.log('verify-flows-output-arity: OK');
}

module.exports = { checkFlows, scanBracketedArrays, classifyElement };

if (require.main === module) {
  try {
    run();
  } catch (e) {
    console.error('verify-flows-output-arity: FAIL - ' + (e && e.message ? e.message : e));
    process.exit(1);
  }
}
