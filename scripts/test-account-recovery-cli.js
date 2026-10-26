'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const { spawnSync }=require('node:child_process');
const { fixture,expected,bcrypt,populateResources,snapshot }=require('./lib/bootstrap-auth-harness');
const ROOT=process.cwd();
const FAIL='Account recovery refused or failed. Keep containment; inspect private state before retrying.';
const resultFields=['id','user_uuid','username','auth_mode','role','disabled_at','sync_version'];
async function using(fn) {
  const f=fixture();
  try {
    const selected=f.seed('selected','viewer',null,{alias:'selected-alias',version:2});
    populateResources(f,selected.row);
    f.db.exec('UPDATE scoped_access_emit SET enabled=1 WHERE id=1');
    const dir=path.join(f.dir,'cli','scripts');
    fs.mkdirSync(path.join(dir,'lib'),{recursive:true});
    for (const name of ['account-recovery.js','lib/account-recovery-transaction.js']) {
      const source=fs.readFileSync(path.join(ROOT,'scripts',name));
      fs.writeFileSync(path.join(dir,name),source);
      assert.ok(source.equals(fs.readFileSync(path.join(dir,name))));
    }
    for (const name of ['sqlite3','bcryptjs']) fs.mkdirSync(path.join(dir,'node_modules',name),{recursive:true});
    fs.copyFileSync(path.join(ROOT,'scripts/fixtures/account-recovery/sqlite3.cjs'),path.join(dir,'node_modules/sqlite3/index.js'));
    const bcryptPath=path.join(ROOT,'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/node_modules/bcryptjs');
    fs.writeFileSync(path.join(dir,'node_modules/bcryptjs/index.js'),'module.exports=require('+JSON.stringify(bcryptPath)+');\n');
    const specPath=path.join(dir,'spec.json'), inputPath=path.join(dir,'password'), tracePath=path.join(dir,'driver-trace.jsonl');
    const privatePassword='synthetic-private-'+crypto.randomBytes(12).toString('hex');
    const marker='synthetic-driver-private-'+crypto.randomBytes(8).toString('hex');
    const specification={action:'promote',expected:expected(selected.row)};
    let passwordHashes=[];
    function call({spec=specification,rawSpec,mode=0o600,input='',control={},dbPath=f.dbPath,specFile=specPath}={}) {
      fs.writeFileSync(specPath,rawSpec===undefined ? JSON.stringify(spec) : rawSpec,{mode:0o600});
      fs.chmodSync(specPath,mode);
      fs.writeFileSync(path.join(dir,'driver-control.json'),JSON.stringify({privateMarker:marker,...control}));
      fs.writeFileSync(tracePath,'');
      fs.writeFileSync(inputPath,input,{mode:0o600});
      const descriptor=fs.openSync(inputPath,'r');
      let out;
      try {
        out=spawnSync(process.execPath,['--no-warnings','--require',path.join(ROOT,'scripts/fixtures/account-recovery/resolve.cjs'),path.join(dir,'account-recovery.js'),dbPath,specFile],{
          cwd:path.dirname(dir),env:{...process.env,NODE_OPTIONS:''},stdio:[descriptor,'pipe','pipe'],encoding:'utf8',timeout:10000,maxBuffer:1024*1024
        });
      } finally { fs.closeSync(descriptor); fs.rmSync(inputPath,{force:true}); }
      assert.ifError(out.error); assert.equal(out.signal,null);
      const output=out.stdout+out.stderr;
      const secrets=[privatePassword,marker,...passwordHashes,...f.users().flatMap(row => [row.password_hash,row.server_password_hash,row.server_offline_verifier,row.server_sync_token])].filter(Boolean);
      for (const value of secrets) assert.equal(output.includes(value),false,'CLI leaked fixture credential data');
      assert.doesNotMatch(output,/password_hash|server_password_hash|server_offline_verifier|server_sync_token|cloud_user_id|server_username|server_url|server_linked_at/);
      if (input.trim()) assert.equal(output.includes(input.trim()),false);
      assert.doesNotMatch(output,/\$2[aby]\$/);
      const trace=fs.readFileSync(tracePath,'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
      return {...out,trace};
    }
    function failure(out) { assert.equal(out.status,1); assert.equal(out.stdout,''); assert.equal(out.stderr.trim(),FAIL); }
    function success(out) {
      assert.equal(out.status,0); assert.equal(out.stderr,'');
      const result=JSON.parse(out.stdout);
      assert.deepEqual(Object.keys(result),resultFields);
      assert.deepEqual(result,Object.fromEntries(resultFields.map(field => [field,f.users().find(row => row.id===result.id)[field]])));
      assert.equal(out.trace.filter(row => row.event==='open').length,1);
      assert.equal(out.trace.find(row => row.event==='open').mode,2);
      assert.equal(out.trace.filter(row => row.event==='close').length,1);
      assert.equal(out.trace.find(row => row.event==='close').foreignKeys,1);
      assert.ok(out.trace.some(row => row.event==='run' && row.sql==='BEGIN IMMEDIATE'));
      return result;
    }
    passwordHashes.push(bcrypt.hashSync(privatePassword,4));
    await fn({f,selected,dir,specPath,privatePassword,call,failure,success,specification});
  } finally { await f.cleanup(); }
}
test('R3 missing DB refuses without DB or sidecars or driver resolution',() => using(async c => {
  const missing=path.join(c.f.dir,'missing.db');
  c.failure(c.call({dbPath:missing}));
  for (const suffix of ['','-wal','-shm','-journal']) assert.equal(fs.existsSync(missing+suffix),false);
  assert.deepEqual(c.call({dbPath:missing}).trace,[]);
}));
test('R3 spec permissions must be exactly 0600',() => using(async c => {
  const before=snapshot(c.f);
  for (const mode of [0o644,0o666,0o400]) { const out=c.call({mode}); c.failure(out); assert.deepEqual(out.trace,[]); assert.deepEqual(snapshot(c.f),before); }
}));
test('R3 malformed JSON refuses before driver open',() => using(async c => {
  const before=snapshot(c.f),out=c.call({rawSpec:'{broken'}); c.failure(out); assert.deepEqual(out.trace,[]); assert.deepEqual(snapshot(c.f),before);
}));
test('R3 stale spec closes raw connection and a second valid operation succeeds',() => using(async c => {
  const before=snapshot(c.f);
  const out=c.call({spec:{action:'promote',expected:{...expected(c.selected.row),sync_version:999}}});
  c.failure(out); assert.equal(out.trace.filter(row => row.event==='close').length,1); assert.deepEqual(snapshot(c.f),before);
  c.success(c.call());
}));
for (const [label,input] of [['missing',''],['short','short'],['multiline','valid-first-line\nsecond-line']]) {
  test(`R3 ${label} password refuses without driver open`,() => using(async c => {
    const before=snapshot(c.f),out=c.call({spec:{action:'create',username:'recovery'},input});
    c.failure(out); assert.deepEqual(out.trace,[]); assert.deepEqual(snapshot(c.f),before);
  }));
}
test('R3 successful promotion uses exact CLI, raw driver resolution and limited projection',() => using(async c => {
  const before=snapshot(c.f),result=c.success(c.call());
  assert.equal(result.role,'admin'); assert.equal(result.sync_version,c.selected.row.sync_version+1);
  const after=snapshot(c.f);
  for (const key of Object.keys(before).filter(k => !['users','sync_outbox'].includes(k))) assert.deepEqual(after[key],before[key]);
  for (const key of Object.keys(c.selected.row).filter(k => !['role','updated_at','sync_version'].includes(k))) assert.equal(after.users[0][key],c.selected.row[key]);
  const login=await c.f.login('selected-alias',c.selected.password);
  assert.equal(login.statusCode,200); assert.equal((await c.f.account(login.payload.token)).statusCode,200);
}));
test('R3 successful creation with quote-bearing name preserves original linked login',() => using(async c => {
  const before=snapshot(c.f);
  const name="new'operator",result=c.success(c.call({spec:{action:'create',username:name},input:c.privatePassword+'\n'}));
  assert.equal(result.username,name); assert.equal(result.role,'admin');
  const after=snapshot(c.f); assert.deepEqual(after.users.slice(0,1),before.users);
  for (const key of Object.keys(before).filter(k => !['users','sync_outbox','sqlite_sequence'].includes(k))) assert.deepEqual(after[key],before[key]);
  assert.equal((await c.f.login('selected-alias',c.selected.password)).statusCode,200);
  const login=await c.f.login(name,c.privatePassword);
  assert.equal(login.statusCode,200); assert.equal((await c.f.account(login.payload.token)).statusCode,200);
}));
for (const controlName of ['sqliteMissing','bcryptMissing','openFailure','pragmaFailure']) {
  test(`R3 ${controlName} is private, cleaned up and recoverable`,() => using(async c => {
    const before=snapshot(c.f);
    const create=controlName==='bcryptMissing';
    const options=create ? {spec:{action:'create',username:'recovery'},input:c.privatePassword+'\n'} : {};
    const out=c.call({...options,control:{[controlName]:true}});
    c.failure(out); assert.deepEqual(snapshot(c.f),before);
    if (['openFailure','pragmaFailure'].includes(controlName)) assert.equal(out.trace.filter(row => row.event==='close').length,1);
    c.success(c.call(options));
  }));
}
test('R3 close failure with committed mutation reports no success and requires readback',() => using(async c => {
  c.failure(c.call({control:{closeFailure:true}}));
  assert.equal(c.f.users()[0].role,'admin');
  c.failure(c.call()); // Original identity version is stale; never blindly retry.
  c.success(c.call({spec:{action:'create',username:'after-close'},input:c.privatePassword+'\n'}));
  assert.equal(c.f.users().length,2);
}));
test('R3 invalid action refuses before driver access',() => using(async c => {
  const before=snapshot(c.f),out=c.call({spec:{action:'unknown'}}); c.failure(out); assert.deepEqual(out.trace,[]); assert.deepEqual(snapshot(c.f),before);
}));
test('R3 symlink spec refuses without opening a driver',() => using(async c => {
  const link=path.join(c.dir,'spec-link.json'); fs.symlinkSync(c.specPath,link);
  const before=snapshot(c.f),out=c.call({specFile:link}); c.failure(out); assert.deepEqual(out.trace,[]); assert.deepEqual(snapshot(c.f),before);
}));
