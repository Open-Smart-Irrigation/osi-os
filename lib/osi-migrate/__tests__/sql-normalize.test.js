'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSqlClause } = require('../sql-normalize');

test('lowercases keywords/identifiers, collapses whitespace, strips operator spacing', () => {
  assert.equal(
    normalizeSqlClause('CHECK  (Is_Default   IN\n\t(0, 1))'),
    'check(is_default in(0,1))'
  );
});

test('folds all identifier quote styles to bare', () => {
  const want = 'check(is_default in(0,1))';
  assert.equal(normalizeSqlClause('CHECK ("Is_Default" IN (0,1))'), want);
  assert.equal(normalizeSqlClause('CHECK (`Is_Default` IN (0,1))'), want);
  assert.equal(normalizeSqlClause('CHECK ([Is_Default] IN (0,1))'), want);
  assert.equal(normalizeSqlClause('CHECK (is_default IN (0,1))'), want);
});

test('preserves string literal case and internal spacing', () => {
  assert.equal(normalizeSqlClause("DEFAULT 'X  y'"), "default 'X  y'");
  assert.equal(normalizeSqlClause("m IN ('SWT_AVG', 'DENDRO')"), "m in('SWT_AVG','DENDRO')");
});

test('doubled-quote escapes survive in literals and identifiers', () => {
  assert.equal(normalizeSqlClause("DEFAULT 'it''s'"), "default 'it''s'");
  assert.equal(normalizeSqlClause('CHECK ("we""ird" > 0)'), 'check(we"ird>0)');
});

test('operator spacing is insignificant', () => {
  assert.equal(normalizeSqlClause('CHECK (v > 0)'), normalizeSqlClause('check(v>0)'));
});

test('null/undefined normalize to empty string', () => {
  assert.equal(normalizeSqlClause(null), '');
  assert.equal(normalizeSqlClause(undefined), '');
});
