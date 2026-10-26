'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Raw sqlite3 handle, exclusively owned by the maintenance process.
// Caller supplies the reviewed identity snapshot, never a public request.
async function recover(db, spec, passwordHash) {
  const all = (sql, params = []) => new Promise((resolve, reject) =>
    db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows.map(row => ({ ...row })))));
  const run = (sql, params = []) => new Promise((resolve, reject) =>
    db.run(sql, params, function(error) {
      if (error) reject(error);
      else resolve(this && this.changes);
    }));
  const one = async (sql, params) => {
    assert.equal(await run(sql, params), 1, 'expected exactly one changed account');
  };
  const fields = ['id', 'user_uuid', 'username', 'auth_mode', 'role', 'disabled_at', 'sync_version'];
  const exact = 'id=? AND user_uuid=? AND username=? AND auth_mode=? AND role=? AND disabled_at IS ? AND sync_version=?';
  const now = new Date().toISOString();
  await run('BEGIN IMMEDIATE');
  try {
    const before = await all('SELECT * FROM users ORDER BY id');
    let afterRow;
    if (spec.action === 'create') {
      assert.equal(typeof spec.username, 'string');
      assert.ok(spec.username.trim() && spec.username === spec.username.trim());
      assert.match(passwordHash || '', /^\$2[aby]\$/);
      const reserved = await all('SELECT id FROM users WHERE username=? OR server_username=? LIMIT 1', [spec.username, spec.username]);
      assert.equal(reserved.length, 0, 'login name is reserved by an existing account');
      const role = spec.role === undefined ? 'admin' : spec.role;
      assert.ok(['admin','researcher','viewer'].includes(role));
      const uuid = crypto.randomUUID();
      await one('INSERT INTO users (username,password_hash,created_at,updated_at,user_uuid,auth_mode,role,disabled_at,edge_originated,sync_version) VALUES(?,?,?,?,?,\'local\',?,NULL,1,1)',
        [spec.username, passwordHash, now, now, uuid, role]);
      [afterRow] = await all('SELECT * FROM users WHERE user_uuid=?', [uuid]);
      assert.ok(afterRow && afterRow.role === role && afterRow.disabled_at === null);
      assert.equal(afterRow.password_hash, passwordHash);
      assert.equal(afterRow.auth_mode, 'local');
      assert.equal(afterRow.sync_version, 1);
      assert.equal(afterRow.edge_originated, 1);
    } else {
      assert.ok(['promote', 'restore', 'undo-backfill'].includes(spec.action), 'unknown action');
      const expected = spec.expected;
      assert.ok(expected && fields.every(field => Object.hasOwn(expected, field)), 'incomplete identity snapshot');
      assert.ok(typeof expected.username === 'string' && expected.username.trim());
      assert.ok(['local','server'].includes(expected.auth_mode));
      assert.ok(Number.isSafeInteger(expected.id) && expected.id > 0);
      assert.ok(typeof expected.user_uuid === 'string' && expected.user_uuid.trim());
      assert.ok(Number.isSafeInteger(expected.sync_version) && expected.sync_version > 0);
      const selected = before.find(row => row.id === expected.id);
      assert.ok(selected, 'selected account missing');
      for (const field of fields) assert.equal(selected[field], expected[field], `stale identity field ${field}`);
      let role = selected.role;
      let disabled = selected.disabled_at;
      if (spec.action === 'promote') {
        assert.equal(disabled, null, 'disabled accounts require investigation');
        assert.ok(['researcher', 'viewer'].includes(role));
        role = 'admin';
      } else if (spec.action === 'restore') {
        assert.equal(role, 'admin');
        assert.ok(typeof disabled === 'string' && disabled.length > 0);
        disabled = null;
      } else {
        // Only an independently reviewed, migration-created promotion.
        assert.equal(role, 'admin');
        assert.ok(['researcher', 'viewer'].includes(spec.originalRole));
        assert.ok(before.some(row => row.id !== selected.id && row.role === 'admin' && row.disabled_at === null), 'verify another enabled admin first');
        role = spec.originalRole;
      }
      await one('UPDATE users SET role=?,disabled_at=?,updated_at=?,sync_version=sync_version+1 WHERE ' + exact,
        [role, disabled, now, ...fields.map(field => expected[field])]);
      [afterRow] = await all('SELECT * FROM users WHERE id=?', [selected.id]);
      assert.deepEqual(afterRow, { ...selected, role, disabled_at: disabled, updated_at: now, sync_version: selected.sync_version + 1 });
    }
    const after = await all('SELECT * FROM users ORDER BY id');
    assert.deepEqual(after.filter(row => row.id !== afterRow.id), before.filter(row => row.id !== afterRow.id), 'unselected account changed');
    assert.equal(after.length, before.length + (spec.action === 'create' ? 1 : 0));
    await run('COMMIT');
    return Object.fromEntries(fields.map(field => [field, afterRow[field]]));
  } catch (error) {
    try { await run('ROLLBACK'); } catch (rollbackError) { error.rollbackError = rollbackError; }
    throw error;
  }
}
module.exports = { recover };
