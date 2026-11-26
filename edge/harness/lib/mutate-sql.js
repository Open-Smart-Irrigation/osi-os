'use strict';
// Finds the literal values a scenario's sql setup step writes into a column:
//   INSERT INTO t(cols) VALUES (...),(...)   each whole-literal value
//   INSERT INTO t(cols) SELECT a, 'b', ...   each whole-literal select item
//   UPDATE t SET col = 'v', ...              each whole-literal assignment
// A literal nested in an expression (strftime('%Y', 'now'), json_set paths,
// WHERE clauses) is not a written value and is skipped.

function tokenize(sql) {
  const re = /(\s+)|(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*')|("(?:[^"]|"")*"|`[^`]*`|\[[^\]]*\])|(\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|\.\d+(?:[eE][-+]?\d+)?)|([A-Za-z_][A-Za-z0-9_$]*)|([\s\S])/g;
  const out = [];
  let m;
  while ((m = re.exec(sql))) {
    const type = m[1] ? 'ws' : m[2] ? 'comment' : m[3] ? 'string' : m[4] ? 'qident' : m[5] ? 'number' : m[6] ? 'ident' : 'punct';
    out.push({ type, text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

const sig = (t) => t.type !== 'ws' && t.type !== 'comment';
const kw = (t, w) => t && t.type === 'ident' && t.text.toUpperCase() === w;
const ident = (t) => (t.type === 'qident' ? t.text.slice(1, -1).replace(/""/g, '"') : t.text);

// Splits significant tokens [from, to) by top-level commas.
function splitTop(toks, from, to) {
  const parts = [];
  let depth = 0, cur = [];
  for (let i = from; i < to; i++) {
    const t = toks[i];
    if (t.text === '(') depth++;
    if (t.text === ')') depth--;
    if (depth === 0 && t.text === ',') { parts.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) parts.push(cur);
  return parts;
}

// A whole-literal expression: 'x', 12, -1.5, or NULL is not a literal.
function literalOf(part) {
  if (part.length === 1 && (part[0].type === 'string' || part[0].type === 'number')) return { tokens: part };
  if (part.length === 2 && part[0].text === '-' && part[1].type === 'number') return { tokens: part };
  return null;
}

function literalValue(lit) {
  const t = lit.tokens;
  if (t[0].type === 'string') return t[0].text.slice(1, -1).replace(/''/g, "'");
  return Number((t.length === 2 ? '-' : '') + t[t.length - 1].text);
}

function matchClose(toks, i) {
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    if (toks[j].text === '(') depth++;
    if (toks[j].text === ')' && --depth === 0) return j;
  }
  return -1;
}

// SQLite's column affinity rules (datatype3.html section 3.1), in order.
function affinityOf(type) {
  const t = String(type || '').toUpperCase();
  if (t.includes('INT')) return 'INTEGER';
  if (/CHAR|CLOB|TEXT/.test(t)) return 'TEXT';
  if (t === '' || t.includes('BLOB')) return 'BLOB';
  if (/REAL|FLOA|DOUB/.test(t)) return 'REAL';
  return 'NUMERIC';
}

// columnsOf(table) -> [{name, type}] for an INSERT without a column list and
// for column affinity. Returns [{table, column, start, end, value}].
function findWrittenLiterals(sql, columnsOf = () => []) {
  const all = tokenize(sql).filter(sig);
  const statements = [];
  let cur = [];
  for (const t of all) { if (t.text === ';') { if (cur.length) statements.push(cur); cur = []; } else cur.push(t); }
  if (cur.length) statements.push(cur);
  const sites = [];
  const push = (table, column, lit) => {
    const type = ((columnsOf(table).find((c) => c.name.toLowerCase() === String(column).toLowerCase()) || {}).type || '').toUpperCase();
    sites.push({ table, column, start: lit.tokens[0].start, end: lit.tokens[lit.tokens.length - 1].end,
      value: literalValue(lit), integerColumn: /INT/.test(type), columnType: type, affinity: affinityOf(type) });
  };
  for (const s of statements) {
    let i = 0;
    if (kw(s[0], 'INSERT') || kw(s[0], 'REPLACE')) {
      while (i < s.length && !kw(s[i], 'INTO')) i++;
      const table = s[i + 1] && ident(s[i + 1]);
      i += 2;
      let cols = null;
      if (s[i] && s[i].text === '(') {
        const close = matchClose(s, i);
        cols = splitTop(s, i + 1, close).map((p) => ident(p[0]));
        i = close + 1;
      }
      if (!cols) cols = columnsOf(table).map((c) => c.name);
      if (kw(s[i], 'VALUES')) {
        i++;
        while (i < s.length && s[i].text === '(') {
          const close = matchClose(s, i);
          splitTop(s, i + 1, close).forEach((part, k) => { const lit = literalOf(part); if (lit && cols[k]) push(table, cols[k], lit); });
          i = close + 1;
          if (s[i] && s[i].text === ',') i++; else break;
        }
      } else if (kw(s[i], 'SELECT')) {
        let end = i + 1, depth = 0;
        for (; end < s.length; end++) {
          if (s[end].text === '(') depth++;
          if (s[end].text === ')') depth--;
          if (depth === 0 && (kw(s[end], 'FROM') || kw(s[end], 'WHERE') || kw(s[end], 'UNION'))) break;
        }
        splitTop(s, i + 1, end).forEach((part, k) => { const lit = literalOf(part); if (lit && cols[k]) push(table, cols[k], lit); });
      }
    } else if (kw(s[0], 'UPDATE')) {
      i = 1;
      if (kw(s[i], 'OR')) i += 2;
      const table = ident(s[i]);
      while (i < s.length && !kw(s[i], 'SET')) i++;
      let end = i + 1, depth = 0;
      for (; end < s.length; end++) {
        if (s[end].text === '(') depth++;
        if (s[end].text === ')') depth--;
        if (depth === 0 && (kw(s[end], 'WHERE') || kw(s[end], 'FROM') || kw(s[end], 'RETURNING'))) break;
      }
      for (const part of splitTop(s, i + 1, end)) {
        if (part.length >= 3 && part[1].text === '=') { const lit = literalOf(part.slice(2)); if (lit) push(table, ident(part[0]), lit); }
      }
    }
  }
  return sites;
}

// SQL text for a JavaScript value written in place of a literal.
function sqlLiteral(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (v === null) return 'NULL';
  // A Buffer is stored as a BLOB with the same bytes (blob-text).
  if (Buffer.isBuffer(v)) return "X'" + v.toString('hex').toUpperCase() + "'";
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const quoted = (t) => "'" + t.replace(/'/g, "''") + "'";
  // A raw NUL would end the harness's own statement; char(0) stores it.
  if (s.includes('\u0000')) return '(' + s.split('\u0000').map(quoted).join(" || char(0) || ") + ')';
  return quoted(s);
}

module.exports = { tokenize, findWrittenLiterals, sqlLiteral, affinityOf };
