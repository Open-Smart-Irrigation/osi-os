'use strict';
// ASCII case flip: every ASCII letter of a string swaps case. Node-RED
// compares many keys through UPPER() or toUpperCase() and many others
// exactly; a backend that picks the other comparison for one of them then
// matches a row Node-RED does not (or misses one it matches). Only strings
// with an ASCII letter fit. A stored 16-hex key in a sql step carries like
// malformed-valve-eui; the valve key columns themselves are left to
// malformed-valve-eui's `lower` variant, which is the same rewrite. Body
// values carry into later steps that echo them (as nul-char).
const { columns: VALVE_KEY_COLUMNS } = require('./mutate-op-malformed-valve-eui');
const KEY = /^[0-9A-F]{16}$/i;
const flip = (s) => s.replace(/[A-Za-z]/g, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
// SQL has no per-letter swap: the column form lower-cases an all-upper value
// and upper-cases any other.
module.exports = {
  name: 'case-flip',
  column: (site) => (site.affinity === 'TEXT' || site.affinity === 'BLOB'
    ? [{ label: 'flip', sql: 'CASE WHEN ' + site.col + ' = upper(' + site.col + ') THEN lower(' + site.col + ') ELSE upper(' + site.col + ') END' }]
    : []),
  value: (v, site) => {
    if (typeof v !== 'string' || !/[A-Za-z]/.test(v)) return [];
    const sql = site && site.container === 'sql';
    if (sql && KEY.test(v) && VALVE_KEY_COLUMNS.has(String(site.column).toLowerCase())) return [];
    const carry = sql ? (KEY.test(v) ? 'key' : undefined) : true;
    return [carry ? { label: 'flip', value: flip(v), carry } : { label: 'flip', value: flip(v) }];
  },
  pair: (p) => (/[A-Za-z]/.test(p.value) ? [{ label: p.key + '=flip', pairs: [[p.key, flip(p.value)]] }] : []),
  flip,
};
