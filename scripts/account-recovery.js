#!/usr/bin/env node
'use strict';
// Explicit operator maintenance source; never installed or called on boot.
const fs = require('node:fs');
const { recover } = require('./lib/account-recovery-transaction');
function runtimeModule(name) {
  return require(require.resolve(name,{paths:[__dirname,'/srv/node-red','/usr/share/node-red']}));
}
async function main() {
  if (process.argv.length!==4) throw new Error('expected existing DB and private spec paths');
  const [dbPath,specPath]=process.argv.slice(2);
  if (!fs.lstatSync(dbPath).isFile()) throw new Error('database must already exist as a regular file');
  const stat=fs.lstatSync(specPath);
  if (!stat.isFile() || (stat.mode & 0o777)!==0o600 || (process.getuid && stat.uid!==process.getuid())) throw new Error('spec must be an owned regular mode-0600 file');
  const spec=JSON.parse(fs.readFileSync(specPath,'utf8'));
  if (!spec || !['create','promote','restore','undo-backfill'].includes(spec.action)) throw new Error('invalid spec action');
  let hash;
  if (spec.action==='create') {
    if (process.stdin.isTTY) throw new Error('password requires a protected descriptor');
    const password=fs.readFileSync(0,'utf8').replace(/\r?\n$/,'');
    if (password.length<6 || /[\r\n]/.test(password)) throw new Error('password must be one line of at least six characters');
    hash=runtimeModule('bcryptjs').hashSync(password,10);
  }
  const sqlite=runtimeModule('sqlite3');
  if (typeof sqlite.Database!=='function' || sqlite.OPEN_READWRITE!==2) throw new Error('raw sqlite3 driver required');
  let db, result;
  try {
    await new Promise((resolve,reject) => {
      db=new sqlite.Database(dbPath,sqlite.OPEN_READWRITE,error => error ? reject(error) : resolve());
    });
    await new Promise((resolve,reject) => db.run('PRAGMA busy_timeout=5000',error => error ? reject(error) : resolve()));
    await new Promise((resolve,reject) => db.run('PRAGMA foreign_keys=ON',error => error ? reject(error) : resolve()));
    result=await recover(db,spec,hash);
  } finally {
    if (db) await new Promise((resolve,reject) => db.close(error => error ? reject(error) : resolve()));
  }
  // Print only after close succeeds. Ambiguous failure requires private readback.
  console.log(JSON.stringify(result));
}
if (require.main===module) main().catch(() => {
  console.error('Account recovery refused or failed. Keep containment; inspect private state before retrying.');
  process.exitCode=1;
});
