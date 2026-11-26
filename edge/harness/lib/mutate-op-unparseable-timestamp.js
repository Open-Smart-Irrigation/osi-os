'use strict';
// A stored timestamp that Date.parse cannot read. Node-RED compares
// Date.parse results, so NaN makes every "is it due" test false (workers.js
// runClockTick: `now - NaN >= period` and `NaN && …`), while a backend whose
// parser falls back to the zero time treats the row as never stamped and
// acts on it. Sql sites only: a literal written into a column whose name ends
// in _at and that Date.parse reads today.
module.exports = {
  name: 'unparseable-timestamp',
  // Column form: every stored value of an _at column becomes 'garbage'.
  column: (site) => (/_at$/i.test(String(site.name)) ? [{ label: 'garbage', sql: "'garbage'" }] : []),
  value: (v, site) => (site.container === 'sql' && /_at$/i.test(String(site.column))
    && typeof v === 'string' && Number.isFinite(Date.parse(v))
    ? [{ label: 'garbage', value: 'garbage' }]
    : []),
};
