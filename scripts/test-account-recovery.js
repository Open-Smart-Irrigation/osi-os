'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { fixture, profiles, expected, backfill, rawFacade, bcrypt, populateResources, snapshot } = require('./lib/bootstrap-auth-harness');
const recover = (...args) => require('./lib/account-recovery-transaction').recover(...args);
const password = () => crypto.randomBytes(15).toString('hex');
async function adminLogin(f,name,credential) {
  const login = await f.login(name,credential);
  assert.equal(login.statusCode,200);
  assert.equal((await f.account(login.payload.token)).statusCode,200);
}
async function publicClosed(f) {
  const before = f.users();
  const out = await f.register('new-public-name',password(),true);
  assert.equal(out.statusCode,403); assert.ok(!out.payload.token && !out.payload.success);
  assert.deepEqual(f.users(),before);
}
for (const profile of profiles) {
  for (const disabled of [false,true]) for (const version of [1,2]) {
    test(`${profile}: R1 aliases and quote-bearing bound names, disabled=${disabled}, verifier=${version}`, async () => {
      const f = fixture(profile);
      try {
        const alias = "linked'alias";
        const linked = f.seed('linked-row','researcher',disabled ? '2026-01-01' : null,{ alias,version });
        populateResources(f,linked.row);
        f.db.exec('UPDATE scoped_access_emit SET enabled=1 WHERE id=1');
        const before = snapshot(f);
        assert.equal((await f.login(alias,linked.password,!disabled)).statusCode,200);
        const newPassword = password(), hash = bcrypt.hashSync(newPassword,4);
        // Alias goes first: the pre-R1 tool incorrectly commits this insertion.
        for (const name of [alias,linked.row.username]) {
          await assert.rejects(recover(f.raw,{action:'create',username:name},hash),/login name is reserved/);
          assert.deepEqual(snapshot(f),before);
        }
        const recoveryName = "recovery'operator";
        await recover(f.raw,{action:'create',username:recoveryName},hash);
        const after = snapshot(f);
        assert.deepEqual(after.users.slice(0,before.users.length),before.users);
        for (const key of Object.keys(before).filter(k => !['users','sync_outbox','sqlite_sequence'].includes(k))) assert.deepEqual(after[key],before[key]);
        assert.equal((await f.login(alias,linked.password,!disabled)).statusCode,200);
        assert.equal((await f.login(alias,newPassword,!disabled)).statusCode,401);
        if (disabled) assert.equal((await f.login(alias,linked.password,true)).statusCode,403);
        await adminLogin(f,recoveryName,newPassword);
        assert.equal(after.sync_outbox.length,before.sync_outbox.length+1);
        assert.equal(JSON.parse(after.sync_outbox.at(-1).payload_json).username,recoveryName);
        await publicClosed(f);
      } finally { await f.cleanup(); }
    });
  }
  for (const action of ['promote','create']) for (const emit of [0,1]) {
    test(`${profile}: R2 post-write ${action} rollback and reacquisition, emit=${emit}`, async () => {
      const f = fixture(profile);
      try {
        const selected = f.seed('selected','viewer');
        populateResources(f,selected.row);
        f.db.prepare('UPDATE scoped_access_emit SET enabled=? WHERE id=1').run(emit);
        const before = snapshot(f), credential=password(), hash=bcrypt.hashSync(credential,4);
        const spec = action==='promote' ? {action,expected:expected(selected.row)} : {action,username:'recovery'};
        let writes=0, injected=false;
        const faulty = {
          run(sql,params,cb) {
            f.raw.run(sql,params,function(error) {
              if (!error && /^(UPDATE users SET|INSERT INTO users)/.test(sql)) writes++;
              cb.call(this,error);
            });
          },
          all(sql,params,cb) {
            if (writes && /^SELECT \* FROM users WHERE/.test(sql)) {
              const written=snapshot(f);
              assert.equal(written.users.length,before.users.length+(action==='create' ? 1 : 0));
              if (action==='promote') assert.equal(written.users[0].sync_version,selected.row.sync_version+1);
              assert.equal(written.sync_outbox.length,before.sync_outbox.length+emit);
              injected=true; cb(new Error('injected post-write readback failure')); return;
            }
            f.raw.all(sql,params,cb);
          }
        };
        await assert.rejects(recover(faulty,spec,hash),/post-write readback failure/);
        assert.equal(writes,1); assert.equal(injected,true);
        assert.deepEqual(snapshot(f),before,'rollback must include timestamps, versions, triggers and sequence');
        await recover(f.raw,spec,hash); // Must acquire a new BEGIN IMMEDIATE after rollback.
        await adminLogin(f,action==='promote' ? selected.row.username : 'recovery',action==='promote' ? selected.password : credential);
        await publicClosed(f);
      } finally { await f.cleanup(); }
    });
  }
  test(`${profile}: R2 two connections contend before selection and release after refusal`, async () => {
    const f = fixture(profile);
    const competitor = new DatabaseSync(f.dbPath);
    try {
      competitor.exec('PRAGMA busy_timeout=0'); f.db.exec('PRAGMA busy_timeout=0');
      const selected=f.seed('selected','viewer'); populateResources(f,selected.row);
      const before=snapshot(f);
      let release, entered;
      const gate=new Promise(resolve => { release=resolve; });
      const begun=new Promise(resolve => { entered=resolve; });
      const held={
        run: f.raw.run,
        all(sql,params,cb) {
          if (sql==='SELECT * FROM users ORDER BY id') { entered(); gate.then(() => f.raw.all(sql,params,cb)); }
          else f.raw.all(sql,params,cb);
        }
      };
      const repair=recover(held,{action:'promote',expected:expected(selected.row)});
      await begun; // BEGIN IMMEDIATE succeeded, before selection is returned.
      let locked;
      try {
        assert.throws(() => competitor.prepare('UPDATE users SET sync_version=sync_version+1 WHERE id=?').run(selected.row.id),/locked|busy/i);
        assert.deepEqual(snapshot(f),before);
      } catch (error) { locked=error; } finally { release(); }
      await repair; if (locked) throw locked;
      const promoted=f.users()[0];
      competitor.exec('BEGIN IMMEDIATE');
      try {
        const after=snapshot(f);
        await assert.rejects(recover(f.raw,{action:'create',username:'contending-recovery'},bcrypt.hashSync(password(),4)),/locked|busy/i);
        assert.deepEqual(snapshot(f),after);
      } finally { competitor.exec('ROLLBACK'); }
      await recover(f.raw,{action:'create',username:'after-lock'},bcrypt.hashSync(password(),4));
      assert.equal(f.users().length,2);
      assert.equal(f.users()[0].sync_version,promoted.sync_version);
    } finally { competitor.close(); await f.cleanup(); }
  });
  for (const state of ['only-disabled-admin','all-disabled-nonadmins','unsuitable-no-admin']) {
    test(`${profile}: R2 actual no-usable-admin recovery: ${state}`, async () => {
      const f=fixture(profile);
      try {
        const selected=f.seed('original',state==='only-disabled-admin' ? 'admin' : 'viewer',state==='unsuitable-no-admin' ? null : '2026-01-01',{alias:'original-linked',version:2});
        if (state==='all-disabled-nonadmins') f.seed('another','researcher','2026-01-01');
        if (state==='unsuitable-no-admin') f.db.prepare('UPDATE users SET server_offline_verifier=? WHERE id=?').run('unusable-synthetic-verifier',selected.row.id);
        populateResources(f,selected.row);
        const before=snapshot(f);
        assert.equal(f.users().filter(row => row.role==='admin' && row.disabled_at===null).length,0);
        await publicClosed(f);
        const credential=password();
        if (state==='only-disabled-admin') {
          await recover(f.raw,{action:'restore',expected:expected(selected.row)});
          await adminLogin(f,'original-linked',selected.password);
          const row=f.users()[0];
          assert.deepEqual(row,{...selected.row,disabled_at:null,updated_at:row.updated_at,sync_version:selected.row.sync_version+1});
        } else {
          await recover(f.raw,{action:'create',username:'named-recovery'},bcrypt.hashSync(credential,4));
          assert.deepEqual(f.users().slice(0,before.users.length),before.users);
          await adminLogin(f,'named-recovery',credential);
        }
        const after=snapshot(f);
        for (const key of Object.keys(before).filter(k => !['users','sync_outbox','sqlite_sequence'].includes(k))) assert.deepEqual(after[key],before[key]);
        await publicClosed(f);
      } finally { await f.cleanup(); }
    });
  }
  test(`${profile}: R2 actual 0045 promotion and selected correction with last-admin refusal`, async () => {
    const f=fixture(profile,{backfillPending:true});
    try {
      const unintended=f.seed('lowest','viewer',null,{alias:'lowest-cloud',version:1});
      const intended=f.seed('intended','researcher'); populateResources(f,unintended.row);
      const resources=snapshot(f);
      f.db.exec(backfill); // Once in this separate pending-backfill fixture.
      const promoted=f.users()[0]; assert.equal(promoted.role,'admin');
      const before=snapshot(f);
      const spec={action:'undo-backfill',expected:expected(promoted),originalRole:unintended.row.role};
      await assert.rejects(recover(f.raw,spec),/another enabled admin/);
      assert.deepEqual(snapshot(f),before);
      await recover(f.raw,{action:'promote',expected:expected(intended.row)});
      await recover(f.raw,spec);
      assert.equal(f.users()[0].role,'viewer');
      assert.equal(f.users()[0].sync_version,promoted.sync_version+1);
      assert.equal((await f.login('lowest-cloud',unintended.password)).statusCode,200);
      await adminLogin(f,'intended',intended.password);
      const after=snapshot(f);
      for (const key of Object.keys(resources).filter(k => !['users','sync_outbox','sqlite_sequence'].includes(k))) assert.deepEqual(after[key],resources[key]);
      await publicClosed(f);
    } finally { await f.cleanup(); }
  });
}
