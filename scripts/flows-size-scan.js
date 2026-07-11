'use strict';
// Pure scan primitives for the flows.json size ratchet (refactor-program 1.A2, DD3).
// Kept requireable with no CLI side effects so tests can import it.

const NEW_NODE_CEILING = 4096;
const THIN_NODE_FLOOR = 4096;
const SQL_LITERAL_MAX = 400;

const SQL_KEYWORD = /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+INDEX|CREATE\s+TRIGGER)\b/i;
const STRING_LITERAL = /`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g;

function isFunctionNode(node) {
  return node && node.type === 'function' && typeof node.func === 'string';
}

function nodeSizes(flows) {
  const sizes = new Map();
  for (const node of flows) {
    if (!isFunctionNode(node)) continue;
    sizes.set(node.id, { name: node.name || node.id, chars: node.func.length });
  }
  return sizes;
}

function totalChars(flows) {
  let total = 0;
  for (const node of flows) {
    if (!isFunctionNode(node)) continue;
    total += node.func.length;
  }
  return total;
}

function loadsViaOsiLib(node) {
  const declaresLib = Array.isArray(node.libs)
    && node.libs.some((l) => l && l.var === 'osiLib' && l.module === 'osi-lib');
  const callsRequire = /osiLib\.require\s*\(/.test(node.func);
  return declaresLib && callsRequire;
}

function hasOversizedSqlLiteral(func, sqlLiteralMax) {
  for (const m of func.matchAll(STRING_LITERAL)) {
    const literal = m[0];
    if (literal.length >= sqlLiteralMax && SQL_KEYWORD.test(literal)) return true;
  }
  return false;
}

function isThinNewNode(node, { floor, sqlLiteralMax }) {
  const func = String(node.func || '');
  if (func.length <= floor) return { ok: true };
  if (loadsViaOsiLib(node)) return { ok: true };
  if (hasOversizedSqlLiteral(func, sqlLiteralMax)) {
    return {
      ok: false,
      reason: 'oversized SQL literal (>=' + sqlLiteralMax + ' chars) in a large new node that does not load via osiLib.require',
    };
  }
  return { ok: true };
}

module.exports = {
  nodeSizes,
  totalChars,
  isThinNewNode,
  loadsViaOsiLib,
  hasOversizedSqlLiteral,
  NEW_NODE_CEILING,
  THIN_NODE_FLOOR,
  SQL_LITERAL_MAX,
};
