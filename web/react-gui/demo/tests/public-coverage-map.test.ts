import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {test} from 'node:test';

type CoverageMap = {schema: string; rows: Array<{trace_id: string; source_title: string; model_tests: string[]; browser_test: string | null; coverage_note: string}>};

test('retired empty browser placeholders retain their trace IDs and substantive model-test pointers', () => {
  const root = resolve(import.meta.dirname, '../..');
  const map = JSON.parse(readFileSync(resolve(import.meta.dirname, '../public-coverage-map.json'), 'utf8')) as CoverageMap;
  assert.equal(map.schema, 'osi-public-simulator-coverage-map/1');
  assert.equal(map.rows.length, 151);
  assert.equal(new Set(map.rows.map(row => `${row.trace_id}\u0000${row.source_title}`)).size, map.rows.length);
  for (const row of map.rows) {
    assert.match(row.trace_id, /^(?:[A-Z]{2}\d{2}|C\d+(?:-C\d+)?)$/);
    assert.ok(row.model_tests.length > 0);
    for (const file of [...row.model_tests, ...(row.browser_test ? [row.browser_test] : [])]) {
      assert.ok(existsSync(resolve(root, file)), `${row.trace_id} points to missing coverage file ${file}`);
    }
    assert.match(row.coverage_note, /does not imply this inventory row was exercised in UI/);
  }
  for (const file of ['actions.spec.ts', 'plans.spec.ts', 'triggers.spec.ts']) {
    assert.equal(existsSync(resolve(import.meta.dirname, 'public', file)), false, `${file} contained only empty skipped scaffolds`);
  }
});
