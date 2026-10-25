'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const ROOT = process.cwd();
const NR = path.join(ROOT, 'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red');
const { executeFunction } = require(path.join(ROOT, 'scripts/lib/scoped-access-harness'));
const bcrypt = require(path.join(NR, 'node_modules/bcryptjs'));
const installation = require(path.join(NR, 'osi-installation-helper'));
const scope = require(path.join(NR, 'osi-scope-helper'));
const profiles = ['bcm2712', 'bcm2709'];
const flowFile = profile => path.join(ROOT, `conf/full_raspberrypi_bcm27xx_${profile}/files/usr/share/flows.json`);
const backfill = fs.readFileSync(path.join(ROOT, 'database/migrations/ordered/0045__scoped_access_backfill.sql'), 'utf8');
const expectedFields = ['id','user_uuid','username','auth_mode','role','disabled_at','sync_version'];
const expected = row => Object.fromEntries(expectedFields.map(field => [field, row[field]]));
function rawFacade(native) {
  return {
    all(sql, params, cb) { try { cb(null, native.prepare(sql).all(...params)); } catch (error) { cb(error); } },
    run(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      try { const out = native.prepare(sql).run(...(params || [])); cb.call({ changes: Number(out.changes) }, null); }
      catch (error) { cb(error); }
    }
  };
}
function fixture(profile = 'bcm2712', { backfillPending = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osi-519-'));
  const dbPath = path.join(dir, 'fixture.db');
  const db = new DatabaseSync(dbPath);
  db.exec(fs.readFileSync(path.join(ROOT, 'database/seed-blank.sql'), 'utf8'));
  if (!backfillPending) db.exec(backfill); // Models empty-install ordering; never replay after signup.
  const installationUuid = crypto.randomUUID();
  const gateway = '0016C001F1000001';
  db.prepare('INSERT INTO installation_identity(singleton_id,installation_uuid,current_gateway_device_eui,created_at,updated_at) VALUES(1,?,?,?,?)')
    .run(installationUuid,gateway,'2026-01-01','2026-01-01');
  const flows = JSON.parse(fs.readFileSync(flowFile(profile), 'utf8'));
  const control = { hold: false, pending: [], callbacks: [], fail: false, missingChanges: false, opened: 0, closed: 0 };
  const nativeHandles = [];
  const helperPath = path.join(NR, 'osi-db-helper/index.js');
  class Driver {
    constructor(_name, mode, cb) {
      if (typeof mode === 'function') cb = mode;
      this.native = new DatabaseSync(dbPath);
      nativeHandles.push(this.native);
      control.opened++;
      setImmediate(() => cb && cb(null));
    }
    all(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      setImmediate(() => {
        try { cb(null, this.native.prepare(sql).all(...(params || []))); }
        catch (error) { cb(error); }
      });
    }
    run(sql, params, cb) {
      if (typeof params === 'function') { cb = params; params = []; }
      const insert = /^INSERT INTO users/.test(sql);
      const execute = () => setImmediate(() => {
        if (insert && control.fail) return cb(new Error('injected SQLITE_BUSY'));
        try {
          const result = this.native.prepare(sql).run(...(params || []));
          if (insert) control.callbacks.push(Number(result.changes));
          cb.call(insert && control.missingChanges ? {} : { changes: Number(result.changes) }, null);
        } catch (error) { cb(error); }
      });
      if (insert && control.hold) control.pending.push(execute);
      else execute();
    }
    close(cb) { this.native.close(); control.closed++; setImmediate(() => cb && cb(null)); }
  }
  const original = Module._load;
  Module._load = function(name, parent, isMain) {
    if (name === 'sqlite3' && parent && parent.filename === helperPath) return { Database: Driver, OPEN_READONLY: 1 };
    return original.call(this, name, parent, isMain);
  };
  let helper;
  try { delete require.cache[require.resolve(helperPath)]; helper = require(helperPath); }
  finally { Module._load = original; }
  const flowState = {};
  const secret = crypto.randomBytes(32).toString('hex');
  const env = on => ({ AUTH_TOKEN_SECRET: secret, DEVICE_EUI: gateway, LINK_GATEWAY_DEVICE_EUI: gateway, OSI_SCOPED_ACCESS: on ? '1' : '0' });
  const node = id => { const n = flows.find(n => n.id === id); assert.ok(n, id); return n; };
  async function invoke(id, msg, on, overrides = {}) {
    const out = await executeFunction(node(id), {
      msg, db, flowState, env: env(on), osiLibModules: { installation, scope },
      libOverrides: { osiDb: helper, ...overrides }
    });
    Object.assign(flowState, out.flowState);
    return out.result;
  }
  const users = () => db.prepare('SELECT * FROM users ORDER BY id').all().map(row => ({ ...row }));
  const seed = (name, role = 'researcher', disabled = null, linked = false) => {
    const password = crypto.randomBytes(12).toString('hex');
    const hash = bcrypt.hashSync(password, 4);
    const link = linked === true ? { version:2, alias:name + '-cloud' } : linked;
    const version = link ? link.version : 0;
    const verifier = link ? bcrypt.hashSync(installation.verifierSubject(password,version,installationUuid,gateway),4) : null;
    db.prepare('INSERT INTO users(username,password_hash,created_at,user_uuid,role,disabled_at,auth_mode,server_username,server_offline_verifier,server_offline_verifier_version,server_password_hash,cloud_user_id,server_url,server_sync_token,server_sync_token_expires_at,server_linked_at,last_auth_sync_at,last_auth_sync_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(name, link ? 'unused-local' : hash, '2026-01-01', crypto.randomUUID(), role, disabled,
        link ? 'server' : 'local', link ? link.alias : null, verifier, version, null,
        link ? 101 : null, link ? 'https://cloud.example.invalid' : null,
        link ? 'synthetic-sync-token-' + crypto.randomUUID() : null, link ? 9999999999999 : null,
        link ? '2026-01-01' : null, link ? '2026-01-01' : null, link ? 'ok' : null);
    return { row: users().at(-1), password };
  };
  async function prepare(name, password, on) {
    let msg = { req: { headers: {}, method: 'POST', path: '/auth/register' }, payload: { username: name, password } };
    for (const id of ['auth-register-func', 'auth-db-query', 'auth-process-result']) {
      const [next, refusal] = await invoke(id, msg, on);
      if (refusal) return { refusal };
      assert.ok(next, id); msg = next;
    }
    return { msg };
  }
  async function finish(prepared, on, overrides) {
    if (prepared.refusal) return prepared.refusal;
    const [next, refusal] = await invoke('auth-db-insert', prepared.msg, on, overrides);
    if (refusal) return refusal;
    assert.ok(next);
    return invoke('auth-insert-complete', next, on);
  }
  async function dispatch(kind, name, password, on) {
    let entry = node(`auth-${kind}-http`);
    assert.equal(entry.method, 'post'); assert.equal(entry.url, `/auth/${kind}`);
    let id = entry.wires[0][0];
    let msg = { req: { headers: {}, method: 'POST', path: entry.url }, payload: { username: name, password } };
    for (let hop = 0; hop < 10; hop++) {
      const current = node(id);
      if (current.type === 'http response') return msg;
      assert.equal(current.type, 'function');
      const result = await invoke(id, msg, on);
      let port = 0;
      if (Array.isArray(result)) {
        const active = result.map((value,index) => value ? index : -1).filter(index => index >= 0);
        assert.equal(active.length, 1); port = active[0]; msg = result[port];
      } else msg = result;
      assert.ok(msg); assert.equal(current.wires[port].length, 1);
      id = current.wires[port][0];
    }
    assert.fail('auth route exceeded hop limit');
  }
  async function register(name, password, on) { return dispatch('register', name, password, on); }
  async function login(name, password, on = true) { return dispatch('login', name, password, on); }
  async function account(token, method = 'GET', suffix = '', body = {}) {
    const parts = suffix.split('/');
    return invoke('scoped-admin-account-router', { req: {
      headers: token ? { authorization: `Bearer ${token}` } : {}, method,
      path: '/api/users' + suffix, params: { uuid: parts[1] }, body
    } }, true);
  }
  async function cleanup() {
    assert.equal(control.pending.length, 0, 'held driver write was not released');
    // osi-db-helper facade.close is deliberately a no-op; close its test backing handles.
    for (const native of nativeHandles) native.close();
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
  return { db, dir, dbPath, node, control, users, seed, invoke, prepare, finish, register, login, account, cleanup, raw: rawFacade(db) };
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('expected queue boundary was not reached');
}
module.exports = { fixture, rawFacade, profiles, flowFile, backfill, expected, until, bcrypt };

function populateResources(f, owner) {
  f.db.prepare('INSERT INTO irrigation_zones(name,user_id,zone_uuid) VALUES(?,?,?)').run('retained-zone',owner.id,'retained-zone');
  f.db.prepare('INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('A840410000000001','retained-device','DRAGINO_LSN50',owner.id,'2026-01-01','2026-01-01');
  f.db.prepare('INSERT INTO device_data(deveui,recorded_at,ambient_temperature) VALUES(?,?,?)').run('A840410000000001','2026-01-01',17);
  f.db.prepare('INSERT INTO user_zone_assignments(assignment_uuid,user_uuid,zone_uuid,created_at) VALUES(?,?,?,?)').run('retained-zone-grant',owner.user_uuid,'retained-zone','2026-01-01');
  f.db.prepare('INSERT INTO journal_plots(plot_uuid,plot_code,name,owner_user_uuid,zone_uuid) VALUES(?,?,?,?,?)').run('retained-plot','P1','retained plot',owner.user_uuid,'retained-zone');
  f.db.prepare('INSERT INTO user_plot_assignments(assignment_uuid,user_uuid,plot_uuid,created_at) VALUES(?,?,?,?)').run('retained-plot-grant',owner.user_uuid,'retained-plot','2026-01-01');
}
function snapshot(f) {
  const names = ['users','irrigation_zones','devices','device_data','user_zone_assignments','journal_plots','user_plot_assignments','scoped_access_emit','sync_outbox','installation_identity','sqlite_sequence'];
  return Object.fromEntries(names.map(name => [name, JSON.parse(JSON.stringify(f.db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()))]));
}
module.exports.populateResources = populateResources;
module.exports.snapshot = snapshot;
