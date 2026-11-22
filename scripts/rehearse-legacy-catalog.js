#!/usr/bin/env node
'use strict';
// Local disposable fixtures only. This script accepts no existing database path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { buildFixture } = require('./fixtures/legacy-devices-catalog');
const { makeFacadeShim } = require('./rehearse-devices-rebuild');
const { computeFingerprints } = require('../lib/osi-migrate/fingerprints');

const ROOT = path.resolve(__dirname, '..');
const FLOW_PATHS = ['bcm2712', 'bcm2709'].map(p =>
  path.join(ROOT, `conf/full_raspberrypi_bcm27xx_${p}/files/usr/share/flows.json`));
const START = '// Self-heal broken FK refs (can be caused by devices table rename migration)';
const END = 'const triggers = [';
// Historical block captured verbatim from origin/main ec822b556. Keep a fixture
// so characterization survives its eventual deletion from the shipped payload.
const LEGACY_SURGERY = fs.readFileSync(path.join(__dirname, 'fixtures/legacy-catalog-surgery.txt'), 'utf8');

function functionText(profile = 0) {
  return JSON.parse(fs.readFileSync(FLOW_PATHS[profile], 'utf8')).find(n => n.id === 'sync-init-fn').func;
}

function surgeryRange(text) {
  const start = text.indexOf(START);
  const end = text.indexOf(END, start);
  assert.ok(start >= 0 && end > start, 'expected unique surgery boundaries in sync-init-fn');
  assert.equal(text.indexOf(START, start + START.length), -1, 'ambiguous surgery boundary');
  return { start, end };
}

// Candidate only: never writes a flows file. This is the exact handoff transform
// rehearsed below. It remains unsafe to deploy until the legacy repair is owned.
function retiredFunction(text) {
  let retired = text;
  if (text.includes(START)) {
    const { start, end } = surgeryRange(text);
    assert.equal(text.slice(start, end), LEGACY_SURGERY, 'legacy surgery changed: review the handoff again');
    retired = text.slice(0, start) + text.slice(end);
  }
  assert.ok(!retired.includes('writable_schema'), 'unrecognized catalog surgery remains');
  return retired.replace(/catch \(_\) \{\}/g,
    "catch (e) { node.warn('sync-init: ' + (e && e.message ? e.message : e)); }");
}

const quote = s => '"' + s.replace(/"/g, '""') + '"';
function snapshot(db, tables) {
  return Object.fromEntries(tables.map(t => [t, db.prepare(`SELECT * FROM ${quote(t)} ORDER BY rowid`).all()]));
}
function pragmas(db) {
  return Object.fromEntries(['foreign_keys', 'legacy_alter_table', 'writable_schema', 'schema_version']
    .map(p => [p, db.prepare(`PRAGMA ${p}`).get()[p]]));
}
async function fingerprints(db) {
  return computeFingerprints({ all: async sql => db.prepare(sql).all() });
}
function foreignKeyCheck(db) {
  try { return { rows: db.prepare('PRAGMA foreign_key_check').all(), error: null }; }
  catch (e) { return { rows: [], error: e.message }; }
}
function writeProbe(db) {
  db.exec('SAVEPOINT eb19_write_probe');
  try {
    db.exec("INSERT INTO device_data(deveui,recorded_at,swt_1) VALUES ('FFFF000000000001','2026-01-02T00:00:00.000Z',19.125)");
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    db.exec('ROLLBACK TO eb19_write_probe; RELEASE eb19_write_probe');
  }
}

async function rehearse({ shape = 'quoted', mode = 'legacy', wholeBoot = false, fault = null, profile = 0 } = {}) {
  assert.ok(['legacy', 'retired'].includes(mode), `unknown mode: ${mode}`);
  assert.ok([null, 'catalog-update', 'schema-bump', 'legacy-on', 'transaction-open',
    'copy', 'rename', 'before-commit'].includes(fault), `unknown fault: ${fault}`);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-eb19-'));
  const dbPath = path.join(scratch, 'fixture.db');
  let inspect;
  let facade;
  let closed = false;
  try {
    inspect = new DatabaseSync(dbPath);
    const children = buildFixture(inspect, shape);
    const tables = ['devices', ...children, ...(shape === 'literal-only' ? ['legacy_note'] : [])];
    const before = snapshot(inspect, tables);
    const beforeFps = await fingerprints(inspect);
    const matched = inspect.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%devices_old%' ORDER BY name").all().map(r => r.name);
    const beforePragmas = pragmas(inspect);
    const triggerRefs = () => inspect.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND sql LIKE '%devices_old%' ORDER BY name").all().map(r => r.name);
    const triggerRefsBefore = triggerRefs();
    // The rebuild fixture narrows the CHECK before this point. Faults below
    // exercise its error exits without changing the function under rehearsal.
    const text = functionText(profile);
    const retired = retiredFunction(text);
    assert.ok(retired.includes(END), 'missing trigger handoff boundary');
    const candidate = mode === 'retired' ? retired : text.includes(START) ? text : text.replace(END, LEGACY_SURGERY + END);
    const body = wholeBoot ? candidate : mode === 'retired' ? '' : LEGACY_SURGERY;
    facade = makeFacadeShim(dbPath);
    await facade.run('PRAGMA foreign_keys=ON');
    const warnings = [], errors = [], statements = [];
    let exitPragmas;
    const invoke = (target, method, sql, cb) => {
      statements.push(sql);
      if ((fault === 'catalog-update' && /^UPDATE sqlite_master/.test(sql)) ||
          (fault === 'schema-bump' && /^PRAGMA schema_version=/.test(sql)) ||
          (fault === 'legacy-on' && sql === 'PRAGMA legacy_alter_table=ON') ||
          (fault === 'rename' && sql === 'ALTER TABLE devices_new RENAME TO devices') ||
          (fault === 'copy' && /^INSERT INTO devices_new/.test(sql))) {
        const e = new Error(`injected ${fault} failure`);
        if (typeof cb === 'function') { process.nextTick(() => cb(e)); return; }
        return Promise.reject(e);
      }
      return target[method](sql, cb);
    };
    const wrapScope = target => Object.fromEntries(['run', 'exec', 'all', 'get']
      .map(method => [method, (sql, cb) => invoke(target, method, sql, cb)]));
    const wrapped = {
      ...wrapScope(facade),
      async transaction(executor) {
        if (fault === 'transaction-open') throw new Error('injected transaction-open failure');
        return facade.transaction(async t => {
          const result = await executor(wrapScope(t));
          if (fault === 'before-commit') throw new Error('injected before-commit failure');
          return result;
        });
      },
      async close(cb) {
        exitPragmas = Object.fromEntries(await Promise.all(
          ['foreign_keys', 'legacy_alter_table', 'writable_schema', 'schema_version']
            .map(async p => [p, (await facade.get(`PRAGMA ${p}`))[p]])));
        facade.close(cb);
        closed = true;
      },
    };
    const node = { warn: m => warnings.push(String(m)), error: m => errors.push(String(m)), status() {}, log() {} };
    if (wholeBoot) {
      const osiDb = { Database: function () { return wrapped; } };
      await new Function('osiDb', 'env', 'node', 'msg', body)(osiDb, { get: () => '' }, node, {});
    } else {
      await new Function('_db', 'exec', 'node', `return (async()=>{${body}\n})()`)(wrapped, sql => wrapped.run(sql), node);
    }
    if (!closed) await wrapped.close();
    const after = snapshot(inspect, tables);
    const afterFps = await fingerprints(inspect);
    const check = foreignKeyCheck(inspect);
    const pending = inspect.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%devices_old%' ORDER BY name").all().map(r => r.name);
    const result = {
      shape, mode, wholeBoot, fault, profile, children, matched, pending,
      counts: Object.fromEntries(tables.map(t => [t, [before[t].length, after[t].length]])),
      rowsPreserved: JSON.stringify(before) === JSON.stringify(after),
      fingerprintsChanged: JSON.stringify(beforeFps) !== JSON.stringify(afterFps),
      beforePragmas, exitPragmas, foreignKeyCheck: check, writeProbe: writeProbe(inspect),
      integrityCheck: inspect.prepare('PRAGMA integrity_check').all().map(row => ({ ...row })), warnings, errors,
      triggerRefsBefore, triggerRefsAfter: triggerRefs(),
      legacyNoteDdl: shape === 'literal-only' ? inspect.prepare("SELECT sql FROM sqlite_master WHERE name='legacy_note'").get().sql : null,
      catalogWrites: statements.filter(sql => /writable_schema|UPDATE sqlite_master|schema_version=/.test(sql)),
    };
    result.dataAndFkChecksPassed = result.rowsPreserved && result.writeProbe.ok && !check.error && check.rows.length === 0 &&
      exitPragmas.foreign_keys === 1 && exitPragmas.writable_schema === 0 && errors.length === 0;
    return result;
  } finally {
    if (facade && !closed) facade.close();
    if (inspect) inspect.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const [shape = 'quoted', mode = 'legacy', scope = 'block', fault] = process.argv.slice(2);
  if (!['block', 'boot'].includes(scope)) throw new Error('scope must be block or boot');
  rehearse({ shape, mode, wholeBoot: scope === 'boot', fault: fault || null }).then(result => {
    console.log(JSON.stringify(result));
    process.exitCode = result.dataAndFkChecksPassed ? 0 : 1;
  }).catch(e => { console.error(e); process.exitCode = 1; });
}

module.exports = { rehearse, functionText, retiredFunction, FLOW_PATHS };
