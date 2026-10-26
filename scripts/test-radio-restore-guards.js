'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
// node:sqlite-backed stand-in for the native `sqlite3` addon (#392): lets this
// test run where the addon is not built. Scoped via Module._load to
// osi-db-helper's own require('sqlite3') only.
const Module = require('node:module');
const { DatabaseSync } = require('node:sqlite');
function sqlite3Adapter() {
  class Database {
    constructor(filename, mode, callback) {
      if (typeof mode === 'function') { callback = mode; mode = undefined; }
      this.native = new DatabaseSync(filename, { readOnly: mode === 1 });
      queueMicrotask(() => callback && callback.call(this, null));
    }
    all(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      callback = callback || (() => {});
      try { callback.call(this, null, this.native.prepare(sql).all(...(params || []))); } catch (error) { callback.call(this, error); }
    }
    get(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      callback = callback || (() => {});
      try { callback.call(this, null, this.native.prepare(sql).get(...(params || []))); } catch (error) { callback.call(this, error); }
    }
    run(sql, params, callback) {
      if (typeof params === 'function') { callback = params; params = []; }
      callback = callback || (() => {});
      try { const result = this.native.prepare(sql).run(...(params || [])); callback.call({ changes: Number(result.changes) }, null); } catch (error) { callback.call(this, error); }
    }
    exec(sql, callback) {
      callback = callback || (() => {});
      try { this.native.exec(sql); callback.call(this, null); } catch (error) { callback.call(this, error); }
    }
    close(callback) {
      callback = callback || (() => {});
      try { this.native.close(); callback.call(this, null); } catch (error) { callback.call(this, error); }
    }
  }
  return { Database, OPEN_READONLY: 1, OPEN_READWRITE: 2, OPEN_CREATE: 4 };
}
const RADIO_HELPER_DIR = path.resolve(__dirname, '../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-radio-helper');
const DB_HELPER_PATH = require.resolve('osi-db-helper', { paths: [RADIO_HELPER_DIR] });
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'sqlite3' && parent && parent.filename === DB_HELPER_PATH) return sqlite3Adapter();
  return originalLoad.call(this, request, parent, isMain);
};
const {createRadioStore}=require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-radio-helper');
const dbHelper=require('../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper');
const installation='00000000-0000-4000-8000-000000000001';
const gateway='0011223344556677';
for(const suffix of ['-wal','-shm','-journal']) test('orphaned '+suffix+' refuses first initialization without opening or marking',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'osi-radio-orphan-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const dbPath=path.join(dir,'radio.db');fs.writeFileSync(dbPath+suffix,'orphan');
 const farmingDb={get:async sql=>sql.includes('installation_identity')?{installation_uuid:installation,recovery_state:'ACTIVE'}:undefined,transaction:()=>assert.fail('must not create marker')};
 const store=createRadioStore({dbPath,installationUuid:installation,gatewayEui:gateway,farmingDb,dbFactory:()=>assert.fail('must not open SQLite')});
 await assert.rejects(store.status,/orphaned radio sidecars/);assert.equal(fs.existsSync(dbPath),false);
});
test('independent facade cannot create second farming database queue',()=>{
 assert.throws(()=>dbHelper.open('/data/db/farming.db'),/not approved/);
});
