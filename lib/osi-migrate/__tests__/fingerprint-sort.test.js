'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { sortFps } = require('../runner');

test('sortFps matches SQL ORDER BY object_type, object_name (BINARY), not localeCompare', () => {
  const input = [
    { object_type: 'table', object_name: 'a_b', fingerprint: '1' },
    { object_type: 'table', object_name: 'aB', fingerprint: '2' },
    { object_type: 'index', object_name: 'z', fingerprint: '3' },
  ];
  const got = sortFps(input).map((x) => `${x.object_type}/${x.object_name}`);
  // BINARY: 'index' < 'table'; within table, 'aB' (B=0x42) < 'a_b' (_=0x5f).
  assert.deepStrictEqual(got, ['index/z', 'table/aB', 'table/a_b']);
});
