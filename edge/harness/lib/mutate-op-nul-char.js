'use strict';
// NUL character in a string: at the end, in the middle and at the start. A
// shipped node that splices a value into SQL text as a quoted literal fails
// at the NUL (SQLite reads the statement as a C string), while a backend that
// binds the value goes on to write or provision. The variants carry: when a
// later step of the scenario echoes the same body value under the same key
// (register, then login with the same username), it gets the same rewrite
// and the rest of the scenario runs, so the value reaches the routes that
// use it. Sql sites get the NUL through char(0) (lib/mutate-sql.js).
const forms = (s) => {
  const out = [['tail', s + '\u0000']];
  if (s.length >= 2) { const i = Math.floor(s.length / 2); out.push(['mid', s.slice(0, i) + '\u0000' + s.slice(i)]); }
  if (s.length >= 1) out.push(['lead', '\u0000' + s]);
  return out;
};
module.exports = {
  name: 'nul-char',
  // Column form: the stored text with char(0) at the end, middle and start.
  column: (site) => (site.affinity === 'TEXT' || site.affinity === 'BLOB' ? [
    { label: 'nul-tail', sql: site.col + ' || char(0)' },
    { label: 'nul-mid', sql: 'substr(' + site.col + ', 1, length(' + site.col + ') / 2) || char(0) || substr(' + site.col + ', length(' + site.col + ') / 2 + 1)' },
    { label: 'nul-lead', sql: 'char(0) || ' + site.col },
  ] : []),
  value: (v) => (typeof v === 'string' ? forms(v).map(([label, value]) => ({ label: 'nul-' + label, value, carry: true })) : []),
  pair: (p) => forms(p.value).map(([label, value]) => ({ label: p.key + '=nul-' + label, pairs: [[p.key, value]] })),
};
