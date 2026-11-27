'use strict';
// Bracket index on query and form keys. qs keeps indexes up to arrayLimit
// (20 for Express's query parser) as array slots and turns larger indexes and
// non-numeric segments into object keys.
const INDEXES = ['0', '20', '21', 'a'];
module.exports = {
  name: 'bracket-index',
  pair: (p) => INDEXES.map((i) => [p.base + '[' + i + ']', p.value])
    .filter(([k]) => k !== p.key)
    .map(([k, v]) => ({ label: k + '=v', pairs: [[k, v]] })),
};
