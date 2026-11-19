'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rehearse, functionText, retiredFunction } = require('./rehearse-legacy-catalog');

// These characterize the unsafe base and reject deletion alone. They do not
// claim that a migration or runtime fix has shipped. See the EB19 stop report.
function assertPreserved(r) {
  assert.equal(r.rowsPreserved, true, JSON.stringify(r));
  assert.ok(r.children.length >= 13, 'all direct devices FK children must have witnesses');
  for (const [table, counts] of Object.entries(r.counts)) {
    assert.deepEqual(counts, [2, 2], `${table}: every row and column must survive`);
  }
  assert.equal(r.exitPragmas.foreign_keys, 1, 'check the same connection, before close');
  assert.equal(r.exitPragmas.legacy_alter_table, 0);
  assert.deepEqual(r.integrityCheck, [{ integrity_check: 'ok' }]);
}

test('both profiles carry the same function and the candidate removes only surgery and silent catches', () => {
  assert.equal(functionText(0), functionText(1));
  const candidate = retiredFunction(functionText());
  assert.doesNotMatch(candidate, /writable_schema|UPDATE sqlite_master|PRAGMA schema_version=/);
  assert.doesNotMatch(candidate, /catch \(_\) \{\}/);
  assert.ok(candidate.length <= functionText().length, 'the handoff must never grow sync-init-fn');
  assert.equal(retiredFunction(candidate), candidate, 'the suite must survive applying the handoff');
  assert.doesNotThrow(() => new Function('osiDb', 'env', 'node', 'msg', candidate));
});

test('healthy populated catalog: both full boot variants preserve all device children', async () => {
  for (const mode of ['legacy', 'retired']) {
    const r = await rehearse({ shape: 'healthy', mode, wholeBoot: true });
    assertPreserved(r);
    assert.equal(r.dataAndFkChecksPassed, true, JSON.stringify(r));
    assert.equal(r.writeProbe.ok, true);
    assert.deepEqual(r.catalogWrites, []);
  }
});

for (const shape of ['quoted', 'unquoted']) {
  test(`${shape}: legacy surgery repairs populated FKs but changes sealed table fingerprints`, async () => {
    const r = await rehearse({ shape });
    assertPreserved(r);
    assert.equal(r.dataAndFkChecksPassed, true, JSON.stringify(r));
    assert.ok(r.matched.length >= 13);
    assert.deepEqual(r.pending, []);
    assert.equal(r.fingerprintsChanged, true);
    assert.equal(r.catalogWrites.length, 4);
    assert.equal(r.exitPragmas.schema_version, r.beforePragmas.schema_version + 1);
  });
  test(`${shape}: retirement alone leaves every populated child FK broken after full boot`, async () => {
    const r = await rehearse({ shape, mode: 'retired', wholeBoot: true });
    assertPreserved(r);
    assert.equal(r.dataAndFkChecksPassed, false);
    assert.match(r.writeProbe.error, /devices_old/);
    assert.ok(r.foreignKeyCheck.error || r.foreignKeyCheck.rows.length >= 26, JSON.stringify(r));
    assert.deepEqual(r.catalogWrites, []);
    assert.deepEqual(r.pending, r.matched);
  });
}

for (const shape of ['bracketed', 'lowercase']) {
  test(`${shape}: LIKE probe fires but the literal REPLACE does not repair valid SQL spellings`, async () => {
    const r = await rehearse({ shape });
    assertPreserved(r);
    assert.equal(r.dataAndFkChecksPassed, false);
    assert.deepEqual(r.pending, r.matched);
    assert.ok(r.warnings.some(w => /Self-healed/.test(w)), 'the success warning is misleading');
    assert.equal(r.fingerprintsChanged, false);
    assert.equal(r.exitPragmas.schema_version, r.beforePragmas.schema_version + 1);
  });
}

test('broad text matching also mutates a DEFAULT literal unrelated to any FK', async () => {
  const r = await rehearse({ shape: 'literal-only' });
  assert.equal(r.rowsPreserved, true, 'existing stored values survive, but future defaults change');
  assert.deepEqual(r.matched, ['legacy_note']);
  assert.equal(r.fingerprintsChanged, true);
  assert.match(r.legacyNoteDdl, /DEFAULT 'REFERENCES devices'/);
  assert.equal(r.exitPragmas.foreign_keys, 1);
});

test('actual unfenced historical rename produces populated damage; surgery leaves trigger references behind', async () => {
  const r = await rehearse({ shape: 'rename-damage' });
  assertPreserved(r);
  assert.ok(r.matched.length >= 13);
  assert.deepEqual(r.pending, []);
  assert.equal(r.fingerprintsChanged, true);
  assert.ok(r.triggerRefsBefore.length > 0);
  assert.deepEqual(r.triggerRefsAfter, r.triggerRefsBefore, 'table surgery does not repair trigger bodies');
});

for (const fault of ['catalog-update', 'schema-bump']) {
  test(`legacy surgery ${fault} failure is visible but has no atomic rollback/finally fence`, async () => {
    const r = await rehearse({ fault });
    assertPreserved(r);
    assert.ok(r.warnings.some(w => w.includes(`injected ${fault}`)));
    if (fault === 'catalog-update') {
      assert.equal(r.exitPragmas.writable_schema, 1, 'existing safety defect: OFF is skipped on error');
      assert.deepEqual(r.pending, r.matched);
      assert.equal(r.dataAndFkChecksPassed, false);
    } else {
      assert.equal(r.exitPragmas.writable_schema, 0);
      assert.equal(r.fingerprintsChanged, true, 'the catalog UPDATE already committed');
      assert.equal(r.exitPragmas.schema_version, r.beforePragmas.schema_version);
    }
  });
}

for (const fault of [null, 'legacy-on', 'transaction-open', 'copy', 'rename', 'before-commit']) {
  test(`full boot retirement candidate: FK restored after rebuild ${fault || 'success'}`, async () => {
    const r = await rehearse({ shape: 'rebuild', mode: 'retired', wholeBoot: true, fault });
    assertPreserved(r);
    assert.equal(r.exitPragmas.writable_schema, 0);
    assert.deepEqual(r.foreignKeyCheck, { rows: [], error: null });
    if (fault) assert.ok(r.errors.some(e => /rebuild ABORTED/.test(e)), JSON.stringify(r));
    else assert.equal(r.dataAndFkChecksPassed, true, JSON.stringify(r));
  });
}
