'use strict';
// A TEXT value stored as a BLOB with the same bytes. node-sqlite3 hands
// Node-RED a Buffer, which String() decodes but which fails a typeof check, a
// strict equality and a regular expression test differently from the text;
// SQLite compares a BLOB unequal to every TEXT value, so `WHERE col = 'x'`
// misses the row while `CAST(col AS TEXT) = 'x'` finds it. A Go scan into a
// string reads the bytes as text. Sql sites only (lib/mutate-sql.js writes
// X'hex'); no carry, so only the one literal changes.
module.exports = {
  name: 'blob-text',
  column: (site) => (site.affinity === 'TEXT' || site.affinity === 'BLOB'
    ? [{ label: 'blob', sql: 'CASE WHEN typeof(' + site.col + ") = 'text' THEN CAST(" + site.col + ' AS BLOB) ELSE ' + site.col + ' END' }]
    : []),
  value: (v, site) => (site && site.container === 'sql' && typeof v === 'string'
    ? [{ label: 'blob', value: Buffer.from(v, 'utf8') }]
    : []),
};
