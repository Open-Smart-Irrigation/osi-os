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

// Balanced-paren scan for `coalesce(<args>)` calls (text is already
// spacing-normalized, so "coalesce(" is always contiguous and lowercase, and
// there is no space before a closing paren). If the argument list mentions
// gateway_device_eui and its trailing top-level argument is the bare keyword
// `null`, canonicalize that null the same way rule (a) below canonicalizes an
// explicit EUI literal in the same position. This is what sync-init-fn emits
// for a gateway whose DEVICE_EUI is not yet configured:
//   const gatewaySql = /^[0-9A-F]{16}$/.test(gateway)
//     ? "'" + gateway.replace(/'/g, "''") + "'" : 'NULL';
// and every one of its ~20 interpolation sites is `coalesce(<...gateway_device_eui...>, ` + gatewaySql + `)`
// (verified by grep across the boot node source — no nested coalesce shares
// that argument list), so a single non-recursive balanced scan is sufficient.
function canonicalizeGatewayEuiNullCoalesce(text) {
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
    const inner = text.slice(openParen + 1, j - 1);
    if (inner.includes('gateway_device_eui') && /(^|,)null$/.test(inner)) {
      out += `coalesce(${inner.replace(/null$/, "'<gateway_eui>'")})`;
    } else {
      out += text.slice(idx, j);
    }
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
// causes further false drift. Two rules, applied in order:
//   1. Token-spacing/case/quote-style normalization, delegated to the shared
//      `normalizeSqlClause` (./sql-normalize.js) — the same canonicalizer
//      issue #107's schema_sig CHECK-blindness fix uses (see the comment at
//      the top of that module), so there is exactly one "what counts as the
//      same SQL" definition in this codebase, not a second hand-rolled one
//      here. It never touches the contents of single-quoted string literals
//      (besides folding '' escapes), so e.g. 'DEVICE_FLAGS_UPDATED' still
//      fingerprints differently from 'DEVICE_FLAGS_UPDATE'.
//   2. Gateway-EUI blindness, applied to the already-normalized text:
//      a. any quoted 16-hex-char literal -> the fixed placeholder
//         '<gateway_eui>' (regex is case-insensitive on the hex digits).
//         Verified empirically that seed-blank.sql contains exactly one such
//         literal anywhere in the file (the Silvan fallback baked into 0046/
//         0047), so this cannot collide with an unrelated 16-hex-char value.
//      b. a bare NULL in the same argument position (rule b of
//         canonicalizeGatewayEuiNullCoalesce above) — the unset-DEVICE_EUI
//         case, so a fresh image before first boot config still fingerprints
//         identically to a configured one.
//   This generalizes scripts/verify-trigger-body-parity.js's rule 1 (which
//   substitutes two specific literals — a fixture EUI and the Silvan
//   fallback — because that verifier only ever compares those two known
//   sources). A fingerprint has to be blind to every fleet gateway's own real
//   EUI, which cannot be enumerated in advance, so this uses a hex-shaped
//   regex over the class of value instead of a literal list; the *intent*
//   (treat the migration fallback and a gateway's live substitution as the
//   one sanctioned difference) is the same rule, not a second one.
function normalizeSqlV3(sql) {
  let text = normalizeSqlClause(sql);
  text = text.replace(/'[0-9a-f]{16}'/gi, "'<gateway_eui>'"); // rule 2a
  text = canonicalizeGatewayEuiNullCoalesce(text); // rule 2b
  return text;
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
  canonicalizeGatewayEuiNullCoalesce,
};
