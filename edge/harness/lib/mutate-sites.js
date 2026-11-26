'use strict';
// Input sites of one scenario step and the step rewritten for one mutant.
// Value sites (an operator's value(v, site)): JSON body leaves, uplink payload
// leaves, the literals a sql step writes, and the leaves of JSON text inside
// those literals. Pair sites (pair(p, site)): query parameters and
// urlencoded form fields.
const { findWrittenLiterals, sqlLiteral } = require('./mutate-sql');

const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

function leaves(v, path = [], out = []) {
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v);
    for (const k of keys) leaves(v[k], [...path, Array.isArray(v) ? Number(k) : k], out);
  } else out.push({ path, value: v });
  return out;
}
function setAt(root, path, value) {
  if (!path.length) return value;
  const out = clone(root);
  let o = out;
  for (let i = 0; i < path.length - 1; i++) o = o[path[i]];
  o[path[path.length - 1]] = value;
  return out;
}
const pathText = (path) => path.map((k) => (typeof k === 'number' ? '[' + k + ']' : '.' + k)).join('').replace(/^\./, '');

function decode(s) { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s; } }
function parsePairs(raw) {
  return raw.split('&').filter((p) => p !== '').map((piece) => {
    const eq = piece.indexOf('=');
    const rawKey = eq === -1 ? piece : piece.slice(0, eq), rawValue = eq === -1 ? null : piece.slice(eq + 1);
    const key = decode(rawKey), value = rawValue === null ? '' : decode(rawValue);
    const b = key.indexOf('[');
    return { piece, key, value, base: b > 0 ? key.slice(0, b) : key };
  });
}
const encodePair = ([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v);
function replacePair(pairs, i, replacement) {
  return [...pairs.slice(0, i).map((p) => p.piece), ...replacement.map(encodePair), ...pairs.slice(i + 1).map((p) => p.piece)].join('&');
}

const isForm = (http) => /x-www-form-urlencoded/i.test(Object.entries(http.headers || {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] || '');

// Every site of a step: { kind: 'value'|'pair', container, label, ..., build(newValueOrPairs) -> step }.
function sitesOf(step, columnsOf) {
  const sites = [];
  if (step.http) {
    const h = step.http;
    const q = h.path.indexOf('?');
    if (q !== -1) {
      const pairs = parsePairs(h.path.slice(q + 1));
      pairs.forEach((p, i) => sites.push({ kind: 'pair', container: 'query', label: 'query.' + p.key, pair: p,
        build: (rep) => ({ ...step, http: { ...h, path: h.path.slice(0, q + 1) + replacePair(pairs, i, rep) } }) }));
    }
    if (typeof h.rawBody === 'string' && isForm(h)) {
      const pairs = parsePairs(h.rawBody);
      pairs.forEach((p, i) => sites.push({ kind: 'pair', container: 'form', label: 'form.' + p.key, pair: p,
        build: (rep) => ({ ...step, http: { ...h, rawBody: replacePair(pairs, i, rep) } }) }));
    }
    let body = h.body, raw = false;
    if (body === undefined && typeof h.rawBody === 'string' && !isForm(h)) { try { body = JSON.parse(h.rawBody); raw = true; } catch { body = undefined; } }
    if (body !== null && typeof body === 'object') {
      for (const l of leaves(body)) {
        sites.push({ kind: 'value', container: 'body', label: 'body.' + pathText(l.path), value: l.value, path: l.path,
          build: (v) => { const b = setAt(body, l.path, v); return { ...step, http: raw ? { ...h, rawBody: JSON.stringify(b) } : { ...h, body: b } }; } });
      }
    }
  }
  const uplinks = step.uplink ? [[step.uplink, null]] : (step.uplinks || []).map((u, i) => [u, i]);
  for (const [u, index] of uplinks) {
    if (u.payload === null || typeof u.payload !== 'object') continue;
    for (const l of leaves(u.payload)) {
      const prefix = index === null ? 'uplink.payload.' : 'uplinks[' + index + '].payload.';
      sites.push({ kind: 'value', container: 'uplink', label: prefix + pathText(l.path), value: l.value,
        build: (v) => {
          const nu = { ...u, payload: setAt(u.payload, l.path, v) };
          if (index === null) return { ...step, uplink: nu };
          const list = step.uplinks.slice(); list[index] = nu; return { ...step, uplinks: list };
        } });
    }
  }
  // A column step (inventory-mutate.js): `UPDATE t SET c = c WHERE 0`, a
  // no-op in the control; an operator's column(site) gives SQL expressions of
  // the stored value, so the mutant rewrites whatever the column holds.
  if (step.column && typeof step.column === 'object') {
    const { table, column, affinity, where } = step.column;
    const q = (x) => '"' + String(x).replace(/"/g, '""') + '"';
    const conds = [...(where ? ['(' + where + ')'] : [])];
    const clause = (v) => { const c = v.all ? conds : [...conds, q(column) + ' IS NOT NULL']; return c.length ? ' WHERE ' + c.join(' AND ') : ''; };
    sites.push({ kind: 'column', container: 'sql-column', label: 'column.' + table + '.' + column, column: table + '.' + column, name: column, affinity,
      col: q(column), build: (v) => ({ ...step, sql: 'UPDATE ' + q(table) + ' SET ' + q(column) + ' = ' + v.sql + clause(v) + ';' }) });
    return sites;
  }
  if (typeof step.sql === 'string') {
    const counts = {};
    for (const lit of findWrittenLiterals(step.sql, columnsOf)) {
      const name = lit.table + '.' + lit.column;
      counts[name] = (counts[name] || 0) + 1;
      const label = 'sql.' + name + '#' + counts[name];
      const splice = (text) => ({ ...step, sql: step.sql.slice(0, lit.start) + text + step.sql.slice(lit.end) });
      sites.push({ kind: 'value', container: 'sql', label, value: lit.value, integerColumn: lit.integerColumn, affinity: lit.affinity, column: name,
        build: (v) => splice(sqlLiteral(v)) });
      if (typeof lit.value === 'string' && /^\s*[[{]/.test(lit.value)) {
        let json; try { json = JSON.parse(lit.value); } catch { json = undefined; }
        if (json !== null && typeof json === 'object') {
          for (const l of leaves(json)) {
            sites.push({ kind: 'value', container: 'sql-json', label: label + '$' + pathText(l.path), value: l.value, column: name,
              build: (v) => splice(sqlLiteral(JSON.stringify(setAt(json, l.path, v)))) });
          }
        }
      }
    }
  }
  return sites;
}

// A carried body value: the later steps with a body leaf under the same key
// and with the same value get the mutated value too. Returns the rewritten
// rest of the scenario, or null when no later step echoes the value.
function carriedRest(scenario, stepIndex, site, value) {
  const key = site.path[site.path.length - 1];
  let echoed = false;
  const rest = scenario.steps.slice(stepIndex + 1).map((step) => {
    const body = step.http && step.http.body;
    if (body === null || typeof body !== 'object') return step;
    let next = body;
    for (const l of leaves(body)) {
      if (l.path.length && l.path[l.path.length - 1] === key && l.value === site.value) { next = setAt(next, l.path, value); echoed = true; }
    }
    return next === body ? step : { ...step, http: { ...step.http, body: next } };
  });
  return echoed ? rest : null;
}

// A carried stored key (variant carry: 'key'): every quoted sql literal equal
// to the original key, in the mutated step and in later sql steps, and every
// later http path segment equal to it, takes the mutated key, so the device
// rows that name it stay joined. Returns the rewritten step and rest.
function carriedKey(scenario, stepIndex, step, original, value) {
  const from = sqlLiteral(original), to = sqlLiteral(value);
  const sql = (text) => (typeof text === 'string' ? text.split(from).join(to) : text);
  const mutated = { ...step, sql: sql(step.sql) };
  let echoed = false;
  const rest = scenario.steps.slice(stepIndex + 1).map((later) => {
    let next = later;
    if (typeof later.sql === 'string' && later.sql.includes(from)) { next = { ...next, sql: sql(later.sql) }; echoed = true; }
    if (later.http && typeof later.http.path === 'string') {
      const [pathname, query] = later.http.path.split(/\?(.*)/s);
      const segments = pathname.split('/');
      if (segments.includes(original)) {
        const path = segments.map((x) => (x === original ? encodeURIComponent(value) : x)).join('/') + (query !== undefined ? '?' + query : '');
        next = { ...next, http: { ...next.http, path } }; echoed = true;
      }
    }
    return next;
  });
  return { step: mutated, rest: echoed ? rest : null };
}

// A scenario date token ({{datetime:-1h}}, lib/run.js) is expanded at run
// time. A variant must keep every token of the original value verbatim:
// a case flip or a NUL inside the token leaves text the expander refuses
// (an ERROR on both sides), and a BLOB of the token's bytes is not the
// value's bytes.
const DATE_TOKEN = /\{\{(?:date|datetime|epochms):[^}]*\}\}/g;
function keepsDateTokens(original, variant) {
  const tokens = typeof original === 'string' ? original.match(DATE_TOKEN) : null;
  if (!tokens) return true;
  const text = typeof variant === 'string' ? variant : JSON.stringify(variant === undefined ? null : variant);
  return tokens.every((t) => text.includes(t));
}

// Mutants of a whole scenario, in step order. Ids are stable across heads:
// scenario/step/site/operator/variant. A mutant with `rest` (a carried value)
// runs the rewritten rest of the scenario after its step. `keep(site, step,
// stepIndex)` drops sites before any mutant is built (a step with hundreds of
// uplinks has tens of thousands of mutants otherwise).
function mutantsOf(scenario, operators, { columnsOf = () => [], keep = null } = {}) {
  const out = [];
  const seen = new Set();
  scenario.steps.forEach((step, stepIndex) => {
    for (const site of sitesOf(step, columnsOf)) {
      if (keep && !keep(site, step, stepIndex)) continue;
      for (const op of operators) {
        const variants = site.kind === 'pair' ? (op.pair ? op.pair(site.pair, site) : [])
          : site.kind === 'column' ? (op.column ? op.column(site) : [])
            : (op.value ? op.value(site.value, site) : []);
        for (const v of variants) {
          if (site.kind === 'pair' ? !keepsDateTokens(site.pair && site.pair.value, v.pairs)
            : site.kind !== 'column' && !keepsDateTokens(site.value, v.value)) continue;
          let mutated = site.build(site.kind === 'pair' ? v.pairs : site.kind === 'column' ? v : v.value);
          let rest = v.carry === true && site.container === 'body' ? carriedRest(scenario, stepIndex, site, v.value) : null;
          if (v.carry === 'key' && site.container === 'sql') ({ step: mutated, rest } = carriedKey(scenario, stepIndex, step, site.value, v.value));
          if (JSON.stringify(mutated) === JSON.stringify(step)) continue;
          // A carried key reaches the same mutant from each site that names it.
          const shape = op.name + '/' + v.label + '/' + JSON.stringify([mutated, rest]);
          if (v.carry === 'key' && seen.has(shape)) continue;
          seen.add(shape);
          const m = { id: [scenario.name, step.id, site.label, op.name, v.label].join('/'), stepIndex, stepId: step.id,
            site: site.label, container: site.container, operator: op.name, variant: v.label, step: mutated };
          if (rest) m.rest = rest;
          out.push(m);
        }
      }
    }
  });
  return out;
}

module.exports = { sitesOf, mutantsOf, parsePairs, leaves, keepsDateTokens };
