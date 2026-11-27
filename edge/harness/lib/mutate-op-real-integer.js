'use strict';
// REAL in an INTEGER column: SQLite stores 126.5 as REAL under INTEGER affinity,
// a value no shipped writer produces for these columns.
module.exports = {
  name: 'real-in-integer',
  value: (v, site) => (site.container === 'sql' && site.integerColumn && typeof v === 'number' && Number.isInteger(v)
    ? [{ label: '126.5', value: 126.5 }] : []),
};
