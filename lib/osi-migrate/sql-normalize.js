'use strict';
// Shared SQL-clause normalization for semantic schema comparison.
// Option B Stage 0 (issue #88) - spec section C:
//   docs/superpowers/specs/2026-07-07-option-b-stage0-canonicalization-design.md
// This module is also the seam for issue #107's schema_sig CHECK-blindness fix:
// import normalizeSqlClause there; do not re-derive normalization rules.
//
// Rules:
//  1. Whitespace runs outside string literals collapse to one space; spaces
//     adjacent to punctuation/operators are dropped entirely.
//  2. Identifier quote styles fold to bare: "id" == `id` == [id] == id.
//  3. Everything lowercases except single-quoted string literals ('A' != 'a'),
//     matching lib/osi-migrate/fingerprints.js normalizeSql case preservation.
//  4. IN (...) list reordering is not attempted.

const PUNCT = new Set(['(', ')', ',', ';', '=', '<', '>', '+', '-', '*', '/', '|', '.']);

function normalizeSqlClause(text) {
  const src = String(text === null || text === undefined ? '' : text);
  let out = '';
  let pendingSpace = false;
  const emit = (piece, lower) => {
    if (piece === '') return;
    if (pendingSpace) {
      const last = out[out.length - 1];
      if (out !== '' && !PUNCT.has(last) && !PUNCT.has(piece[0])) out += ' ';
      pendingSpace = false;
    }
    out += lower ? piece.toLowerCase() : piece;
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "'") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "'") {
          if (src[j + 1] === "'") { j += 2; continue; }
          j += 1;
          break;
        }
        j += 1;
      }
      emit(src.slice(i, j), false);
      i = j;
      continue;
    }
    if (ch === '"' || ch === '`') {
      let j = i + 1;
      let ident = '';
      while (j < src.length) {
        if (src[j] === ch) {
          if (src[j + 1] === ch) { ident += ch; j += 2; continue; }
          j += 1;
          break;
        }
        ident += src[j];
        j += 1;
      }
      emit(ident, true);
      i = j;
      continue;
    }
    if (ch === '[') {
      const end = src.indexOf(']', i + 1);
      if (end !== -1) {
        emit(src.slice(i + 1, end), true);
        i = end + 1;
        continue;
      }
    }
    if (/\s/.test(ch)) { pendingSpace = true; i += 1; continue; }
    emit(ch, true);
    i += 1;
  }
  return out;
}

module.exports = { normalizeSqlClause };
