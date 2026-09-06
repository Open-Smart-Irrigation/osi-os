'use strict';
const crypto = require('node:crypto');
const { normalizeSqlClause } = require('./sql-normalize');

const NORMALIZER_VERSION = 3;
// The one prior scheme any live gateway could have been stamped under. Used
// only by runner.js's osi-os#153 compatibility check (see there) to prove a
// stored-vs-live mismatch is nothing but this version bump, not real drift.
const PREVIOUS_NORMALIZER_VERSION = 2;

function hash(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

// v2 (legacy, pre osi-os#153 fix): collapse whitespace only, preserve case
// entirely. Kept ONLY so the runner can recompute "what would this live
// schema have hashed to under the old rules" for the backward-compat check
// described in runner.js — never used to stamp new fingerprints.
function normalizeSqlV2(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim();
}

// Literal-aware SQL comment stripper, run BEFORE normalizeSqlClause. Needed
// because normalizeSqlClause is not comment-aware: a `--` line comment whose
// text happens to contain an odd number of apostrophes (e.g. "-- Silvan's
// fallback") flips normalizeSqlClause's own string-literal tracking for
// everything after it, corrupting normalization of the rest of the object
// (Fable review pair J on c28ebcbf). This does its OWN minimal single-quote
// tracking (mirroring sql-normalize.js's '' escape handling) so it never
// strips a `--` or `/*` that is actually inside a string literal, and it
// deliberately does NOT live in sql-normalize.js — that module also backs
// issue #107's schema_sig comparison, and changing its semantics here would
// change that too. `--` requires the two dashes to be adjacent: `x - -y`
// (double unary minus, real SQL) is left untouched; only `x--y` / `x -- y`
// is a comment (Fable pair E). Each stripped comment is replaced with a
// single space so token separation survives (e.g. `x--c\ny` -> `x \ny`,
// still collapses to one boundary under normalizeSqlClause).
function stripSqlComments(sql) {
  const src = String(sql === null || sql === undefined ? '' : sql);
  let out = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === ch) {
          if (src[j + 1] === ch) { j += 2; continue; } // doubled-quote escape survives verbatim
          j += 1;
          break;
        }
        j += 1;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    if (ch === '[') {
      const end = src.indexOf(']', i + 1);
      if (end !== -1) { out += src.slice(i, end + 1); i = end + 1; continue; }
    }
    if (ch === '-' && src[i + 1] === '-') {
      let j = i + 2;
      while (j < src.length && src[j] !== '\n') j += 1;
      out += ' ';
      i = j; // leave the '\n' itself (if any) for the next loop iteration
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const j = end === -1 ? src.length : end + 2;
      out += ' ';
      i = j;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// Recursive balanced-paren scan for `coalesce(<args>)` calls (text is
// already spacing-normalized, so "coalesce(" is always contiguous and
// lowercase, and there is no space before a closing paren). Every one of
// sync-init-fn's ~22 gateway-EUI interpolation sites (verified by evaluating
// the boot node's real `triggers` array — see
// fingerprints-gateway-eui.test.js) is a top-level
// `coalesce(<...gateway_device_eui...>, <literal-EUI-or-null>)`: if the
// argument list mentions gateway_device_eui and its trailing top-level
// argument is either the bare keyword `null` or a quoted 16-hex-char
// literal, that trailing argument is canonicalized to the fixed placeholder
// '<gateway_eui>' — collapsing the migration/seed-baked fallback literal,
// every fleet gateway's own real EUI, and the not-yet-configured NULL case
// into one value.
//
// Deliberately narrow: this does NOT touch a 16-hex literal anywhere else
// (a bare 16-hex literal outside this exact coalesce/gateway_device_eui
// shape — e.g. `NEW.deveui <> '0016C001F11766E7'` — is a real, semantically
// significant value and must keep fingerprinting distinctly; Fable review
// pair on c28ebcbf caught a prior version of this function's sibling global
// regex collapsing exactly that case).
//
// Recursive: `inner` is canonicalized BEFORE checking the outer call's own
// trailing argument, so a nested
// `coalesce(x, coalesce(NEW.gateway_device_eui, NULL))` still canonicalizes
// the inner call's own null/literal (Fable review pair I) even though the
// outer call's trailing argument is that whole nested expression, not a
// bare null/literal itself.
function canonicalizeGatewayEuiCoalesce(text) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const idx = text.indexOf('coalesce(', i);
    if (idx === -1) { out += text.slice(i); break; }
    out += text.slice(i, idx);
    const openParen = idx + 'coalesce'.length; // index of '('
    let depth = 0;
    let j = openParen;
    for (; j < text.length; j += 1) {
      if (text[j] === '(') depth += 1;
      else if (text[j] === ')') {
        depth -= 1;
        if (depth === 0) { j += 1; break; }
      }
    }
    let inner = text.slice(openParen + 1, j - 1);
    inner = canonicalizeGatewayEuiCoalesce(inner); // recurse into any nested coalesce(...) first
    if (inner.includes('gateway_device_eui') && /(^|,)(null|'[0-9a-f]{16}')$/i.test(inner)) {
      inner = inner.replace(/(^|,)(null|'[0-9a-f]{16}')$/i, (m, p1) => `${p1}'<gateway_eui>'`);
    }
    out += `coalesce(${inner})`;
    i = j;
  }
  return out;
}

// v3 (current) — fixes osi-os#153: the migration/seed-baked gateway-EUI
// fallback literal and the boot node's live DEVICE_EUI substitution otherwise
// fingerprint as "drifted" on every gateway except the one whose real EUI
// happens to equal the baked fallback, and even at that one gateway,
// hand-formatted spacing in the migration/seed SQL (`peer_node = 'cloud'`)
// vs. the boot node's compact JS template literals (`peer_node='cloud'`)
// causes further false drift. Three steps, applied in order:
//   1. Strip SQL comments (stripSqlComments above) — must run first, on the
//      raw text, because normalizeSqlClause is not comment-aware.
//   2. Token-spacing/case/quote-style normalization, delegated to the shared
//      `normalizeSqlClause` (./sql-normalize.js) — the same canonicalizer
//      issue #107's schema_sig CHECK-blindness fix uses (see the comment at
//      the top of that module), so there is exactly one "what counts as the
//      same SQL" definition in this codebase, not a second hand-rolled one
//      here. It never touches the contents of single-quoted string literals
//      (it recognizes '' as a doubled-quote escape so the literal's end is
//      found correctly, but does not fold or otherwise rewrite that escape
//      sequence — the escaped text passes through byte-for-byte), so e.g.
//      'DEVICE_FLAGS_UPDATED' still fingerprints differently from
//      'DEVICE_FLAGS_UPDATE'.
//   3. Gateway-EUI blindness (canonicalizeGatewayEuiCoalesce above), scoped
//      to exactly the top-level `coalesce(<...gateway_device_eui...>,
//      <null-or-16-hex-literal>)` shape sync-init-fn actually interpolates
//      into — not a global sweep over every 16-hex literal in the text (an
//      earlier version of this function did that and Fable review caught it
//      collapsing unrelated real values, e.g. a `deveui <> '<16-hex>'`
//      comparison, into the same placeholder).
//   This generalizes scripts/verify-trigger-body-parity.js's rule 1 (which
//   substitutes two specific literals — a fixture EUI and the Silvan
//   fallback — because that verifier only ever compares those two known
//   sources). A fingerprint has to be blind to every fleet gateway's own real
//   EUI, which cannot be enumerated in advance, so this matches the class of
//   value (null-or-16-hex) at the one call shape it can legitimately appear
//   in for this purpose, instead of a literal list.
function normalizeSqlV3(sql) {
  const text = normalizeSqlClause(stripSqlComments(sql));
  return canonicalizeGatewayEuiCoalesce(text);
}

const NORMALIZERS = {
  [PREVIOUS_NORMALIZER_VERSION]: normalizeSqlV2,
  [NORMALIZER_VERSION]: normalizeSqlV3,
};

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// { normalizerVersion } lets runner.js recompute fingerprints under a prior
// scheme for the osi-os#153 compatibility check; omit it for normal use.
async function computeFingerprints(runner, { normalizerVersion = NORMALIZER_VERSION } = {}) {
  const normalizeSql = NORMALIZERS[normalizerVersion];
  if (!normalizeSql) throw new Error(`computeFingerprints: unknown normalizerVersion ${normalizerVersion}`);
  const tag = { normalizer: normalizerVersion };
  const out = [];

  // master DDL captures what PRAGMA omits: table CHECK constraints, partial-index WHERE, defaults.
  const master = await runner.all(
    "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY type, name");
  const ddl = {};
  for (const m of master) ddl[`${m.type}|${m.name}`] = normalizeSql(m.sql);

  for (const { name } of master.filter((m) => m.type === 'table')) {
    const quotedName = quoteIdent(name);
    const columns = await runner.all(`PRAGMA table_xinfo(${quotedName})`);
    const fks = await runner.all(`PRAGMA foreign_key_list(${quotedName})`);
    const indexes = await runner.all(`PRAGMA index_list(${quotedName})`);
    const indexCols = {};
    for (const idx of indexes) indexCols[idx.name] = await runner.all(`PRAGMA index_xinfo(${quoteIdent(idx.name)})`);
    out.push({ object_type: 'table', object_name: name,
      fingerprint: hash({ tag, columns, fks, indexes, indexCols, ddl: ddl[`table|${name}`] }) });
  }
  for (const { name } of master.filter((m) => m.type === 'index')) {
    out.push({ object_type: 'index', object_name: name,
      fingerprint: hash({ tag, ddl: ddl[`index|${name}`] }) });
  }
  for (const { name } of master.filter((m) => m.type === 'trigger')) {
    out.push({ object_type: 'trigger', object_name: name,
      fingerprint: hash({ tag, body: ddl[`trigger|${name}`] }) });
  }
  return out;
}

module.exports = {
  computeFingerprints,
  NORMALIZER_VERSION,
  PREVIOUS_NORMALIZER_VERSION,
  quoteIdent,
  normalizeSqlV3,
  stripSqlComments,
  canonicalizeGatewayEuiCoalesce,
};
