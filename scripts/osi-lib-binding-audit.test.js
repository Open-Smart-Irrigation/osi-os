'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const auditModule = require('./osi-lib-binding-audit');

const bindings = {
  db: { variable: 'osiDb', module: 'osi-db-helper' },
  journal: { variable: 'osiJournal', module: 'osi-journal' },
  ledger: { variable: 'osiCommandLedger', module: 'osi-command-ledger' },
};
const expectedById = {
  'journal-api-router-fn': [bindings.db, bindings.journal],
  'command-dedupe-dispatch': [bindings.db, bindings.journal, bindings.ledger],
  'journal-command-apply-fn': [bindings.db, bindings.journal],
  'command-ack-queue-rest': [bindings.db, bindings.ledger],
};
const exactLibs = [{ var: 'osiLib', module: 'osi-lib' }];
const flowsPath = path.resolve(
  __dirname,
  '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
);
const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
const approvedNodes = Object.fromEntries(Object.keys(expectedById).map((id) => [
  id,
  flows.find((node) => node.id === id),
]));

function audit(node, expectedBindings = expectedById[node.id]) {
  return auditModule.auditOsiLibBindings(node, expectedBindings);
}

function syntheticRouter(func, libs = exactLibs) {
  return { id: 'journal-api-router-fn', func, libs };
}

const validTwoHelperSource = [
  "const dbLoad = osiLib.require('osi-db-helper');",
  "const journalLoad = osiLib.require('osi-journal');",
  'if (!dbLoad.ok || !journalLoad.ok) {',
  "  node.error('helpers unavailable', msg);",
  '  return null;',
  '}',
  'const osiDb = dbLoad.value;',
  'const osiJournal = journalLoad.value;',
  'return osiJournal.handleHttpRequest({ Database: osiDb.Database });',
].join('\n');

test('exports one pinned policy for each approved Task 9 node', () => {
  assert.equal(typeof auditModule.auditOsiLibBindings, 'function');
  assert.equal(typeof auditModule.hasExactOsiLibOnly, 'function');
  assert.deepEqual(
    Object.keys(auditModule.TASK9_OSI_LIB_NODE_POLICIES || {}).sort(),
    Object.keys(expectedById).sort(),
  );
});

test('accepts the four complete approved function-node surfaces', () => {
  for (const [id, node] of Object.entries(approvedNodes)) {
    assert.ok(node, `missing approved node ${id}`);
    assert.deepEqual(audit(node), { ok: true, errors: [] }, id);
  }
});

test('requires the exact osiLib-only function-node declaration', () => {
  const node = approvedNodes['journal-api-router-fn'];
  for (const libs of [
    [{ var: 'osiLib', module: 'wrong-module' }],
    [...exactLibs, { var: 'osiDb', module: 'osi-db-helper' }],
    [{ var: 'osiLib', module: 'osi-lib', config: 'spoof' }],
  ]) {
    assert.equal(audit({ ...node, libs }).ok, false);
  }
});

test('rejects any unreviewed function-source drift, including ignored text', () => {
  const node = approvedNodes['journal-api-router-fn'];
  assert.equal(audit({ ...node, func: node.func + '\n// unreviewed drift' }).ok, false);
});

test('requires the exact approved helper set and rejects unknown node ids', () => {
  const node = approvedNodes['command-dedupe-dispatch'];
  assert.equal(audit(node, [bindings.db]).ok, false);
  assert.equal(audit({ ...node, id: 'unapproved-journal-node' }, expectedById[node.id]).ok, false);
});

test('rejects helper use hidden in template interpolation before the guard', () => {
  const source = "const premature = `${osiDb.Database('/data/db/farming.db')}`;\n" + validTwoHelperSource;
  assert.equal(audit(syntheticRouter(source)).ok, false);
});

test('rejects a fake terminating guard inside a regular-expression literal', () => {
  const source = [
    "const dbLoad = osiLib.require('osi-db-helper');",
    "const journalLoad = osiLib.require('osi-journal');",
    'const fakeGuard = /if (!dbLoad.ok || !journalLoad.ok) { return null; }/;',
    'const osiDb = dbLoad.value;',
    'const osiJournal = journalLoad.value;',
    'return osiJournal.handleHttpRequest({ Database: osiDb.Database });',
  ].join('\n');
  assert.equal(audit(syntheticRouter(source)).ok, false);
});

test('rejects nested helper bindings followed by out-of-scope helper use', () => {
  const source = [
    'function loadHelpers() {',
    validTwoHelperSource,
    '}',
    'return osiJournal.handleHttpRequest({ Database: osiDb.Database });',
  ].join('\n');
  assert.equal(audit(syntheticRouter(source)).ok, false);
});

test('rejects conditional helper bindings followed by out-of-scope helper use', () => {
  const source = [
    'if (msg.loadHelpers) {',
    validTwoHelperSource,
    '}',
    'return osiJournal.handleHttpRequest({ Database: osiDb.Database });',
  ].join('\n');
  assert.equal(audit(syntheticRouter(source)).ok, false);
});

test('rejects a loader module substitution on an approved node', () => {
  const node = approvedNodes['journal-api-router-fn'];
  assert.equal(audit({ ...node, func: node.func.replace('osi-db-helper', 'osi-journal') }).ok, false);
});
