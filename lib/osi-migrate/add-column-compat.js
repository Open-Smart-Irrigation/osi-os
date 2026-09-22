'use strict';

const { normalizeSqlClause } = require('./sql-normalize');

const IDENT = '(?:[A-Za-z_][A-Za-z0-9_$]*|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\\[[^\\]]*\\])';
const ADD_COLUMN_RE = new RegExp(`^\\s*ALTER\\s+TABLE\\s+(${IDENT})\\s+ADD\\s+COLUMN\\s+(${IDENT})(?:\\s+(.+?))?\\s*;?\\s*$`, 'is');
const CLAUSE_WORDS = new Set(['constraint', 'primary', 'not', 'null', 'unique', 'check', 'default', 'collate', 'references', 'generated', 'as']);
const UNSUPPORTED_CLAUSES = new Set(['constraint', 'unique', 'check', 'collate', 'references', 'generated', 'as']);

function quoteIdent(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function stripComments(sql) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < sql.length) {
    const c = sql[i];
    if (quote) {
      out += c;
      if (c === quote) {
        if (sql[i + 1] === quote) { out += sql[i + 1]; i += 2; continue; }
        quote = null;
      }
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '[') {
      const end = sql.indexOf(']', i + 1);
      if (end < 0) throw new Error('malformed SQL: unterminated bracketed identifier');
      out += sql.slice(i, end + 1); i = end + 1; continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += ' ';
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) throw new Error('malformed SQL: unterminated block comment');
      out += ' '; i = end + 2; continue;
    }
    out += c; i += 1;
  }
  if (quote === "'") throw new Error('malformed SQL: unterminated string literal');
  return out;
}

function hasSingleOuterParentheses(source) {
  if (source[0] !== '(' || source[source.length - 1] !== ')') return false;
  let depth = 0;
  let quote = null;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === quote) {
        if (source[i + 1] === quote) i += 1;
        else quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0 && i !== source.length - 1) return false;
    }
    if (depth < 0) return false;
  }
  return depth === 0 && quote === null;
}

function normalizeDefaultClause(value) {
  let source = String(value).trim();
  while (hasSingleOuterParentheses(source)) source = source.slice(1, -1).trim();
  let out = '';
  let pendingSpace = false;
  let quote = null;
  const punctuation = new Set(['(', ')', ',', ';', '=', '<', '>', '+', '-', '*', '/', '|', '.']);
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      out += c;
      if (c === quote) {
        if (source[i + 1] === quote) { out += source[i + 1]; i += 1; }
        else quote = null;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      if (pendingSpace && out && !punctuation.has(out[out.length - 1])) out += ' ';
      pendingSpace = false;
      quote = c;
      out += c;
    } else if (/\s/.test(c)) {
      pendingSpace = true;
    } else {
      if (pendingSpace && out && !punctuation.has(out[out.length - 1]) && !punctuation.has(c)) out += ' ';
      pendingSpace = false;
      out += c.toLowerCase();
    }
  }
  if (quote) throw new Error('malformed DEFAULT: unterminated quote');
  return out;
}

function unquoteIdent(value) {
  const text = value.trim();
  if (text[0] === '"') return text.slice(1, -1).replace(/""/g, '"');
  if (text[0] === '`') return text.slice(1, -1).replace(/``/g, '`');
  if (text[0] === '[') return text.slice(1, -1).replace(/\]\]/g, ']');
  return text;
}

function scanTopLevelWords(source) {
  const words = [];
  let i = 0;
  let depth = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c; i += 1;
      while (i < source.length) {
        if (source[i] === quote) {
          if (source[i + 1] === quote) { i += 2; continue; }
          i += 1; break;
        }
        i += 1;
      }
      continue;
    }
    if (c === '[') { const end = source.indexOf(']', i + 1); if (end < 0) throw new Error('malformed SQL: unterminated identifier'); i = end + 1; continue; }
    if (c === '(') { depth += 1; i += 1; continue; }
    if (c === ')') { depth -= 1; if (depth < 0) throw new Error('malformed SQL: unbalanced parentheses'); i += 1; continue; }
    if (/[A-Za-z_]/.test(c)) {
      const start = i; i += 1;
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) i += 1;
      words.push({ word: source.slice(start, i).toLowerCase(), start, end: i, depth });
      continue;
    }
    i += 1;
  }
  if (depth !== 0) throw new Error('malformed SQL: unbalanced parentheses');
  return words;
}

function parseDefinition(definition) {
  const source = stripComments(definition).trim();
  if (!source) throw new Error('malformed ADD COLUMN: missing column definition');
  const words = scanTopLevelWords(source);
  const top = words.filter((w) => w.depth === 0);
  if (!top.length) throw new Error('malformed ADD COLUMN: missing column definition');
  const firstClause = top.findIndex((w) => CLAUSE_WORDS.has(w.word));
  const typeEnd = firstClause < 0 ? source.length : top[firstClause].start;
  const type = normalizeSqlClause(source.slice(0, typeEnd)).trim();
  const defaultWords = top.filter((w) => w.word === 'default');
  if (defaultWords.length > 1) throw new Error('ambiguous ADD COLUMN: multiple DEFAULT clauses');
  let hasDefault = defaultWords.length === 1;
  let defaultValue = null;
  if (hasDefault) {
    const start = defaultWords[0].end;
    const afterDefault = top.filter((w) => w.start >= start);
    const leadingNull = afterDefault[0] && afterDefault[0].word === 'null'
      && source.slice(start, afterDefault[0].start).trim() === '';
    const next = afterDefault.find((w, index) => (!leadingNull || index > 0) && CLAUSE_WORDS.has(w.word));
    const raw = source.slice(start, next ? next.start : source.length).trim();
    if (!raw) throw new Error('malformed ADD COLUMN: DEFAULT has no expression');
    defaultValue = normalizeDefaultClause(raw);
  }
  const hasNotNull = top.some((w, i) => w.word === 'not' && top[i + 1] && top[i + 1].word === 'null');
  const hasPrimaryKey = top.some((w, i) => w.word === 'primary' && top[i + 1] && top[i + 1].word === 'key');
  const hasNull = top.some((w, i) => w.word === 'null' && (!top[i - 1] || top[i - 1].word !== 'not'));
  const unsupported = top.some((w) => UNSUPPORTED_CLAUSES.has(w.word));
  return { type, hasDefault, defaultValue, notNull: hasNotNull && !hasNull, primaryKey: hasPrimaryKey, unsupported };
}

function scanAddColumnStatement(statement) {
  if (splitTopLevelSqlStatements(String(statement)).length !== 1) {
    throw new Error('ambiguous ADD COLUMN statement');
  }
  const source = stripComments(String(statement)).trim();
  const match = ADD_COLUMN_RE.exec(source);
  if (!match) {
    if (/^alter\s+table\b/i.test(source)) throw new Error('malformed ADD COLUMN statement');
    throw new Error('ambiguous ADD COLUMN statement');
  }
  if (!match[3] || !match[3].trim()) throw new Error('malformed ADD COLUMN: missing column definition');
  const table = unquoteIdent(match[1]);
  const column = unquoteIdent(match[2]);
  const definition = parseDefinition(match[3]);
  return { table, column, ...definition };
}

function splitTopLevelSqlStatements(sql) {
  const out = [];
  let start = 0; let depth = 0; let quote = null; let lineComment = false; let blockComment = false;
  let trigger = false; let triggerDepth = 0; let caseDepth = 0; let words = [];
  const flushWord = (word) => {
    if (!word) return;
    words.push(word.toLowerCase());
    if (words.length <= 4 && words.includes('trigger')) trigger = true;
    if (trigger && word.toLowerCase() === 'begin') triggerDepth += 1;
    if (trigger && word.toLowerCase() === 'case' && triggerDepth > 0) caseDepth += 1;
    if (trigger && word.toLowerCase() === 'end' && caseDepth > 0) caseDepth -= 1;
    else if (trigger && word.toLowerCase() === 'end' && triggerDepth > 0) triggerDepth -= 1;
  };
  let word = '';
  const flush = (end) => {
    if (word) { flushWord(word); word = ''; }
    const text = sql.slice(start, end);
    if (text.trim()) out.push(text);
    start = end; words = []; trigger = false; triggerDepth = 0; caseDepth = 0;
  };
  for (let i = 0; i < sql.length; i += 1) {
    const c = sql[i];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && sql[i + 1] === '/') { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (c === quote) { if (sql[i + 1] === quote) { i += 1; } else quote = null; }
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') { if (word) { flushWord(word); word = ''; } lineComment = true; continue; }
    if (c === '/' && sql[i + 1] === '*') { if (word) { flushWord(word); word = ''; } blockComment = true; i += 1; continue; }
    if (c === "'" || c === '"' || c === '`') { if (word) { flushWord(word); word = ''; } quote = c; continue; }
    if (c === '[') { if (word) { flushWord(word); word = ''; } const end = sql.indexOf(']', i + 1); if (end < 0) throw new Error('malformed SQL: unterminated identifier'); i = end; continue; }
    if (/[A-Za-z0-9_$]/.test(c)) { word += c; continue; }
    if (word) { flushWord(word); word = ''; }
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth < 0) throw new Error('malformed SQL: unbalanced parentheses'); }
    else if (c === ';' && depth === 0 && (!trigger || triggerDepth === 0)) flush(i + 1);
  }
  if (word) flushWord(word);
  if (quote) throw new Error('malformed SQL: unterminated quote');
  if (blockComment) throw new Error('malformed SQL: unterminated comment');
  if (depth !== 0 || triggerDepth !== 0 || caseDepth !== 0) throw new Error('malformed SQL: unbalanced statement');
  const tail = sql.slice(start);
  if (stripComments(tail).trim()) out.push(tail);
  return out;
}

async function rewriteAdditiveMigration(runner, sql) {
  const statements = splitTopLevelSqlStatements(sql);
  const kept = [];
  for (const statement of statements) {
    const withoutComments = stripComments(statement).trim();
    if (!/^alter\s+table\b/i.test(withoutComments)) { kept.push(statement); continue; }
    const spec = scanAddColumnStatement(statement);
    const rows = await runner.all(`PRAGMA table_xinfo(${quoteIdent(spec.table)})`);
    const existing = rows.find((row) => String(row.name).toLowerCase() === spec.column.toLowerCase());
    if (!existing) { kept.push(statement); continue; }
    if (spec.unsupported) throw new Error(`existing column ${spec.table}.${spec.column} has unsupported ADD COLUMN constraints; refusing compatibility skip`);
    if (Number(existing.hidden || 0) !== 0) throw new Error(`existing column ${spec.table}.${spec.column} has conflicting visible metadata`);
    const actualType = normalizeSqlClause(existing.type || '');
    const actualDefault = existing.dflt_value === null || existing.dflt_value === undefined ? null : normalizeDefaultClause(existing.dflt_value);
    if (actualType !== spec.type || (spec.hasDefault ? actualDefault !== spec.defaultValue : actualDefault !== null)
      || Number(existing.notnull || 0) !== (spec.notNull ? 1 : 0)
      || Number(existing.pk || 0) !== (spec.primaryKey ? 1 : 0)) {
      throw new Error(`existing column ${spec.table}.${spec.column} conflicts with ADD COLUMN definition (type/default/nullability/primary-key metadata)`);
    }
    console.error(`[migrate] skipping compatible pre-existing ADD COLUMN ${spec.table}.${spec.column}`);
    // Matching duplicate is intentionally omitted; all other original SQL remains intact.
  }
  return kept.join('');
}

module.exports = { splitTopLevelSqlStatements, scanAddColumnStatement, rewriteAdditiveMigration };
