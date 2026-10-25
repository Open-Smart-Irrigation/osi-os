'use strict';
// Test-only raw callback adapter. Never uses osi-db-helper or a shared queue.
const fs=require('node:fs');
const path=require('node:path');
const { DatabaseSync }=require('node:sqlite');
const root=path.resolve(__dirname,'../..');
const control=JSON.parse(fs.readFileSync(path.join(root,'driver-control.json'),'utf8'));
const trace=entry => fs.appendFileSync(path.join(root,'driver-trace.jsonl'),JSON.stringify(entry)+'\n');
class Database {
  constructor(filename,mode,cb) {
    trace({event:'open',mode});
    let error;
    try {
      if (mode!==2 || !fs.statSync(filename).isFile()) throw new Error('invalid open contract');
      if (control.openFailure) throw new Error(control.privateMarker);
      this.native=new DatabaseSync(filename); // Existing file, raw private connection.
    } catch (failure) { error=failure; }
    setImmediate(() => cb(error || null));
  }
  all(sql,params,cb) {
    setImmediate(() => {
      try { cb(null,this.native.prepare(sql).all(...params)); } catch (error) { cb(error); }
    });
  }
  run(sql,params,cb) {
    if (typeof params==='function') { cb=params; params=[]; }
    setImmediate(() => {
      trace({event:'run',sql}); // SQL contains placeholders; parameter values are never recorded.
      try {
        if (control.pragmaFailure && sql==='PRAGMA foreign_keys=ON') throw new Error(control.privateMarker);
        const out=this.native.prepare(sql).run(...(params || []));
        cb.call({changes:Number(out.changes)},null);
      } catch (error) { cb(error); }
    });
  }
  close(cb) {
    let error;
    try {
      const foreignKeys=this.native ? this.native.prepare('PRAGMA foreign_keys').get().foreign_keys : null;
      if (this.native) this.native.close();
      trace({event:'close',foreignKeys});
      if (control.closeFailure) throw new Error(control.privateMarker);
    } catch (failure) { error=failure; }
    setImmediate(() => cb(error || null));
  }
}
module.exports={Database,OPEN_READWRITE:2};
