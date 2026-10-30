'use strict';
// Pure scan primitives for the flows.json size ratchet (refactor-program 1.A2, DD3).
// Kept requireable with no CLI side effects so tests can import it.

const NEW_NODE_CEILING = 1536;
const THIN_NODE_FLOOR = 400;
const SQL_LITERAL_MAX = 400;

const SQL_KEYWORD = /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|CREATE\s+INDEX|CREATE\s+TRIGGER)\b/i;
const STRING_LITERAL = /`(?:\\[\s\S]|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g;

function isFunctionNode(node) {
  return node && node.type === 'function' && typeof node.func === 'string';
}

// Code Node-RED runs for a function node: the body plus its On Start and On Stop code.
function codeChars(node) {
  return node.func.length
    + (typeof node.initialize === 'string' ? node.initialize.length : 0)
    + (typeof node.finalize === 'string' ? node.finalize.length : 0);
}

function nodeSizes(flows) {
  const sizes = new Map();
  for (const node of flows) {
    if (!isFunctionNode(node)) continue;
    sizes.set(node.id, { name: node.name || node.id, chars: codeChars(node) });
  }
  return sizes;
}

function totalChars(flows) {
  let total = 0;
  for (const node of flows) {
    if (!isFunctionNode(node)) continue;
    total += codeChars(node);
  }
  return total;
}

function allCode(node) {
  return [node.func, node.initialize, node.finalize].filter((c) => typeof c === 'string').join('\n');
}

function loadsViaOsiLib(node) {
  const declaresLib = Array.isArray(node.libs)
    && node.libs.some((l) => l && l.var === 'osiLib' && l.module === 'osi-lib');
  const callsRequire = /osiLib\.require\s*\(/.test(allCode(node));
  return declaresLib && callsRequire;
}

function hasOversizedSqlLiteral(func, sqlLiteralMax) {
  for (const m of func.matchAll(STRING_LITERAL)) {
    const literal = m[0];
    if (literal.length >= sqlLiteralMax && SQL_KEYWORD.test(literal)) return true;
  }
  return false;
}

// A new function node is wiring: up to `floor` chars of free-standing code, or
// a node that loads its logic through osiLib.require and embeds no large SQL.
// Feature logic belongs in a tested osi-* module, not in flows.json.
function isThinNewNode(node, { floor, sqlLiteralMax }) {
  const func = allCode(node);
  if (func.length <= floor) return { ok: true };
  if (!loadsViaOsiLib(node)) {
    return {
      ok: false,
      reason: 'new node over ' + floor + ' chars must load its logic through osiLib.require (put the logic in an osi-* module)',
    };
  }
  if (hasOversizedSqlLiteral(func, sqlLiteralMax)) {
    return {
      ok: false,
      reason: 'oversized SQL literal (>=' + sqlLiteralMax + ' chars) in a new node; move the query into the module it loads',
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
