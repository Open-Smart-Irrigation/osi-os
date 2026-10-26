#!/usr/bin/env node
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { fixture, profiles, flowFile, backfill, expected, until, bcrypt } = require('./lib/bootstrap-auth-harness');
const recover = (...args) => require('./lib/account-recovery-transaction').recover(...args);
const password = () => crypto.randomBytes(12).toString('hex');
function closed(response, status = 403) {
  assert.equal(response.statusCode, status);
  assert.ok(!response.payload.token);
  assert.ok(!response.payload.success);
}
async function using(profile, fn) { const f = fixture(profile); try { await fn(f); } finally { await f.cleanup(); } }

test('maintained profiles and auth wiring match', () => {
  assert.equal(fs.readFileSync(flowFile(profiles[0]), 'utf8'), fs.readFileSync(flowFile(profiles[1]), 'utf8'));
  const flows = JSON.parse(fs.readFileSync(flowFile(profiles[0]), 'utf8'));
  const nodes = new Map(flows.map(n => [n.id, n]));
  for (const [id, target] of [
    ['auth-register-http','auth-register-func'], ['auth-register-func','auth-db-query'],
    ['auth-db-query','auth-process-result'], ['auth-process-result','auth-db-insert'],
    ['auth-db-insert','auth-insert-complete'], ['auth-insert-complete','auth-response']
  ]) assert.ok(nodes.get(id).wires[0].includes(target), `${id} -> ${target}`);
  assert.deepEqual(nodes.get('auth-db-insert').wires, [['auth-insert-complete'], ['auth-response']]);
  assert.equal(nodes.get('auth-register-http').url, '/auth/register');
  assert.equal(nodes.get('auth-register-http').method, 'post');
});
for (const profile of profiles) {
  test(`${profile}: #519 empty migration, flag-off owner, flag-on peer refused, operator continuation`, () => using(profile, async f => {
    const ownerPassword = password();
    assert.equal((await f.register('owner', ownerPassword, false)).statusCode, 201);
    const before = f.users();
    assert.equal(before[0].role, 'researcher');
    closed(await f.register('peer', password(), true));
    assert.deepEqual(f.users(), before);
    closed(await f.login('peer', password()), 401);
    const ownerLogin = await f.login('owner', ownerPassword);
    assert.equal((await f.account(ownerLogin.payload.token)).statusCode, 403);
    await recover(f.raw, { action: 'promote', expected: expected(before[0]) });
    assert.equal(f.users()[0].role, 'admin');
    assert.equal((await f.login('owner', ownerPassword)).statusCode, 200);
    assert.equal((await f.account(ownerLogin.payload.token)).statusCode, 200);
    closed(await f.register('later-peer', password(), true));
  }));
  for (const on of [false, true]) {
    test(`${profile}: empty bootstrap, scoped=${on}`, () => using(profile, async f => {
      const credential = password();
      assert.equal((await f.register('first', credential, on)).statusCode, 201);
      assert.equal(f.users().length, 1);
      assert.equal(f.users()[0].role, on ? 'admin' : 'researcher');
      assert.equal((await f.login('first', credential, on)).statusCode, 200);
      closed(await f.register('second', password(), on));
      assert.equal(f.users().length, 1);
    }));
    for (const state of ['researcher','viewer','disabled-researcher','disabled-admin','admin','multiple','linked','missing-uuid']) {
      test(`${profile}: every account closes bootstrap: ${state}, scoped=${on}`, () => using(profile, async f => {
        const role = state.includes('admin') ? 'admin' : state === 'viewer' ? 'viewer' : 'researcher';
        f.seed('existing', role, state.startsWith('disabled') ? '2026-01-01' : null, state === 'linked');
        if (state === 'multiple') f.seed('another', 'viewer');
        if (state === 'missing-uuid') f.db.exec('UPDATE users SET user_uuid=NULL');
        const before = f.users();
        closed(await f.register('new-public-user', password(), on));
        assert.deepEqual(f.users(), before);
      }));
    }
    for (const sameName of [false, true]) {
      test(`${profile}: queued concurrent credential race, scoped=${on}, sameName=${sameName}`, () => using(profile, async f => {
        const firstPassword = password(), secondPassword = password();
        // Both requests pass username lookup before either INSERT is admitted.
        const first = await f.prepare('racer', firstPassword, on);
        const second = await f.prepare(sameName ? 'racer' : 'other', secondPassword, on);
        assert.ok(first.msg && second.msg);
        assert.equal(first.msg.userInsert.username, 'racer');
        assert.equal(second.msg.userInsert.username, sameName ? 'racer' : 'other');
        assert.ok(bcrypt.compareSync(firstPassword, first.msg.userInsert.passwordHash));
        assert.ok(!bcrypt.compareSync(secondPassword, first.msg.userInsert.passwordHash));
        f.control.hold = true;
        const a = f.finish(first, on);
        await until(() => f.control.pending.length === 1);
        const b = f.finish(second, on);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(f.control.pending.length, 1, 'real facade must serialize driver writes');
        f.control.pending.shift()();
        await until(() => f.control.pending.length === 1);
        f.control.pending.shift()();
        const [winner, loser] = await Promise.all([a,b]);
        assert.equal(winner.statusCode, 201); closed(loser);
        assert.deepEqual(f.control.callbacks, [1,0]);
        assert.equal(f.users().length, 1);
        assert.equal(f.users()[0].username, 'racer');
        assert.equal((await f.login('racer', firstPassword, on)).statusCode, 200);
        closed(await f.login(sameName ? 'racer' : 'other', secondPassword, on), 401);
      }));
    }
    test(`${profile}: trusted insert between lookup and write, scoped=${on}`, () => using(profile, async f => {
      const request = await f.prepare('public', password(), on);
      f.seed('trusted', 'viewer');
      const before = f.users();
      closed(await f.finish(request, on));
      assert.deepEqual(f.users(), before);
    }));
    test(`${profile}: DB failure does not bootstrap, scoped=${on}`, () => using(profile, async f => {
      const request = await f.prepare('public', password(), on);
      f.control.fail = true;
      closed(await f.finish(request, on), 500);
      assert.equal(f.users().length, 0);
      f.control.fail = false;
      f.db.exec('DROP TABLE users');
      closed(await f.register('public-without-schema', password(), on), 500);
      assert.equal(f.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='users'").get().n, 0);
    }));
    test(`${profile}: unknown row-change metadata never claims success, scoped=${on}`, () => using(profile, async f => {
      f.seed('existing');
      const request = await f.prepare('public', password(), on);
      const before = f.users(); f.control.missingChanges = true;
      closed(await f.finish(request, on));
      assert.deepEqual(f.users(), before);
    }));
  }
  test(`${profile}: unavailable insert helper fails without success`, () => using(profile, async f => {
    const request = await f.prepare('public', password(), true);
    await assert.rejects(f.finish(request, true, { osiDb: undefined }));
    assert.equal(f.users().length, 0);
  }));
  test(`${profile}: one-time backfill before/after account creation, disabled and linked cases`, async () => {
    const cases = [
      { rows: [['owner','researcher',null,false]], roles: ['admin'] },
      { rows: [['disabled','researcher','2026-01-01',false],['linked','viewer',null,true]], roles: ['researcher','admin'] },
      { rows: [['disabled-admin','admin','2026-01-01',false],['enabled','researcher',null,false]], roles: ['admin','researcher'] },
      { rows: [['disabled','researcher','2026-01-01',false]], roles: ['researcher'] },
      { rows: [['existing-admin','admin',null,false],['researcher','researcher',null,false]], roles: ['admin','researcher'] }
    ];
    for (const scenario of cases) {
      // All schema is present (0044-equivalent); 0045 has NOT run in this fixture.
      const f = fixture(profile, { backfillPending: true });
      try {
        for (const args of scenario.rows) f.seed(...args);
        f.db.exec(backfill); // Exactly once, after the legacy accounts exist.
        assert.deepEqual(f.users().map(row => row.role), scenario.roles);
        const before = f.users();
        closed(await f.register('peer', password(), true));
        assert.deepEqual(f.users(), before);
      } finally { await f.cleanup(); }
    }
  });
  for (const emit of [0,1]) {
    test(`${profile}: operator transactions preserve accounts, history, grants and emit semantics, emit=${emit}`, () => using(profile, async f => {
      const selected = f.seed('selected', 'viewer', null, true);
      const other = f.seed('other');
      f.db.prepare('INSERT INTO irrigation_zones(name,user_id,zone_uuid) VALUES(?,?,?)').run('fixture-zone', selected.row.id, 'fixture-zone');
      f.db.prepare('INSERT INTO user_zone_assignments(assignment_uuid,user_uuid,zone_uuid,created_at) VALUES(?,?,?,?)').run('fixture-grant', other.row.user_uuid, 'fixture-zone', '2026-01-01');
      f.db.prepare('INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run('A840410000000001','fixture-device','DRAGINO_LSN50',selected.row.id,'2026-01-01','2026-01-01');
      f.db.prepare('INSERT INTO device_data(deveui,recorded_at,ambient_temperature) VALUES(?,?,?)')
        .run('A840410000000001','2026-01-01',17);
      const resources = () => JSON.stringify(['irrigation_zones','devices','device_data','user_zone_assignments','journal_plots','user_plot_assignments'].map(table => f.db.prepare(`SELECT * FROM ${table}`).all()));
      f.db.prepare('INSERT INTO journal_plots(plot_uuid,plot_code,name,owner_user_uuid,zone_uuid) VALUES(?,?,?,?,?)').run('fixture-plot','P1','fixture plot',selected.row.user_uuid,'fixture-zone');
      f.db.prepare('INSERT INTO user_plot_assignments(assignment_uuid,user_uuid,plot_uuid,created_at) VALUES(?,?,?,?)').run('fixture-plot-grant',other.row.user_uuid,'fixture-plot','2026-01-01');
      const beforeResources = resources();
      f.db.prepare('UPDATE scoped_access_emit SET enabled=? WHERE id=1').run(emit);
      f.db.exec('DELETE FROM sync_outbox');
      const before = f.users();
      const base = expected(selected.row);
      const wrong = { id: 999, user_uuid: crypto.randomUUID(), username: 'wrong-name', auth_mode: 'local', role: 'researcher', disabled_at: '2026-01-01', sync_version: 99 };
      for (const key of Object.keys(wrong)) {
        const bad = { ...base, [key]: wrong[key] };
        await assert.rejects(recover(f.raw, { action: 'promote', expected: bad }));
        assert.deepEqual(f.users(), before);
        assert.equal(f.db.prepare('SELECT COUNT(*) n FROM sync_outbox').get().n, 0);
      }
      await recover(f.raw, { action: 'promote', expected: expected(selected.row) });
      const promoted = f.users()[0];
      for (const key of Object.keys(selected.row).filter(k => !['role','updated_at','sync_version'].includes(k))) assert.equal(promoted[key], selected.row[key]);
      assert.equal(promoted.sync_version, selected.row.sync_version + 1);
      const events = f.db.prepare("SELECT * FROM sync_outbox WHERE aggregate_type='USER'").all();
      assert.equal(events.length, emit);
      if (emit) {
        const payload = JSON.parse(events[0].payload_json);
        assert.equal(payload.role, 'admin'); assert.equal(payload.disabled_at, null);
        assert.equal(payload.sync_version, promoted.sync_version);
        assert.equal(events[0].sync_version, promoted.sync_version);
        assert.equal(events[0].aggregate_key, promoted.user_uuid);
      }
      assert.equal((await f.account((await f.login('selected', selected.password)).payload.token)).statusCode, 200);
      const recoveryPassword = password();
      await recover(f.raw, { action: 'create', username: 'recovery-operator' }, bcrypt.hashSync(recoveryPassword, 4));
      assert.deepEqual(f.users().slice(0,2), [promoted, other.row]);
      assert.equal(resources(), beforeResources);
      assert.equal(f.db.prepare('SELECT enabled FROM scoped_access_emit WHERE id=1').get().enabled, emit);
      const recoveryToken = (await f.login('recovery-operator', recoveryPassword)).payload.token;
      assert.equal((await f.account(recoveryToken)).statusCode, 200);
      const allEvents = f.db.prepare("SELECT sync_version,payload_json FROM sync_outbox WHERE aggregate_type='USER' ORDER BY rowid").all();
      assert.equal(allEvents.length, 2 * emit);
      if (emit) { assert.equal(allEvents[1].sync_version,1); assert.equal(JSON.parse(allEvents[1].payload_json).role,'admin'); }
      closed(await f.register('public-after-recovery', password(), true));
      const afterRecovery = f.users();
      await assert.rejects(recover(f.raw, { action: 'create', username: 'recovery-operator' }, bcrypt.hashSync(password(),4)));
      assert.deepEqual(f.users(), afterRecovery);
      assert.equal((await f.account(recoveryToken,'PUT','/' + promoted.user_uuid + '/disabled',{ disabled:true })).statusCode,200);
      const disabled = f.users()[0];
      await recover(f.raw, { action: 'restore', expected: expected(disabled) });
      assert.equal(f.users()[0].disabled_at, null);
      await recover(f.raw, { action: 'undo-backfill', expected: expected(f.users()[0]), originalRole: 'viewer' });
      assert.equal(f.users()[0].role, 'viewer');
      assert.equal(resources(), beforeResources);
    }));
  }
}
