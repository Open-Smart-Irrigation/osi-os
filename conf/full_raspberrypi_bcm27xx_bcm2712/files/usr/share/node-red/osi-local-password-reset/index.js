'use strict';
// osi-local-password-reset: the admin password reset behind
// POST /api/users/:uuid/password-reset (#521). The admin account router
// (scoped-admin-account-router) checks the scoped-access flag, the bearer
// token and the actor's admin role, then calls resetLocalPassword and answers
// with the returned status and payload.
//
// A linked account (auth_mode='server') signs in with its linked credential,
// never password_hash, so a local reset cannot change its login. Refuse it;
// reset only local accounts. Unknown modes fail closed.
//
// Every dependency is passed in by the router: db is the router's osi-db-helper
// handle, scope the single osi-scope-helper instance the router loads through
// osi-lib, bcrypt the router's bcryptjs, node the function node (for
// node.warn). This module loads no other module.

const targetModeSql = 'SELECT auth_mode FROM users WHERE user_uuid=? LIMIT 1';

function answer(statusCode, payload) {
  return { statusCode, payload };
}

function signInType(row) {
  if (!row) return 'missing';
  return row.auth_mode === 'local' || row.auth_mode === 'server' ? row.auth_mode : 'unknown';
}

function refuse(type) {
  if (type === 'missing') return answer(404, { message: 'User not found' });
  if (type === 'server') {
    return answer(409, {
      code: 'linked_account_password_reset_unsupported',
      message: 'This account uses linked sign-in. Its password cannot be reset on this gateway. ' +
        'Ask the linked-identity administrator for the approved recovery process.'
    });
  }
  return answer(500, { message: 'The account sign-in type is not recognized. The password was not changed.' });
}

// Resolves to { statusCode, payload }, except for two errors it throws for
// the router's outer catch, which answers { message } with their statusCode:
// a password shorter than 6 characters (400, before any database read), and
// an authorization refusal raised inside the write transaction (401 or 403,
// only when the ROLLBACK succeeded).
async function resetLocalPassword(options) {
  const { db, scope, bcrypt, auth, actor, userUuid, body, now, node } = options;
  const password = String(body.password || body.temporary_password || '');
  if (password.length < 6) {
    throw Object.assign(new Error('Password must be at least 6 characters'), { statusCode: 400 });
  }
  let outcome;
  try {
    // Read-only preflight: refuse without hashing; it grants no write.
    const preflight = signInType(await db.get(targetModeSql, [userUuid]));
    if (preflight !== 'local') return refuse(preflight);
    const passwordHash = bcrypt.hashSync(password, 10);
    // Short write transaction after hashing. Re-check the actor and the
    // target on the transaction connection only (tx), never the queued db.
    outcome = await db.transaction(async function(tx) {
      const current = await tx.get(
        'SELECT user_uuid FROM users WHERE id=? AND username=? LIMIT 1',
        [auth.userId, auth.username]
      );
      if (!current || current.user_uuid !== actor.user_uuid) {
        throw Object.assign(new Error('Unauthorized'), { statusCode: 401 });
      }
      await scope.assertFreshRole(tx, actor.user_uuid, 'admin', { scopedMode: true });
      const target = signInType(await tx.get(targetModeSql, [userUuid]));
      if (target !== 'local') return target;
      await tx.run(
        "UPDATE users SET password_hash=?,updated_at=?,sync_version=sync_version+1 WHERE user_uuid=? AND auth_mode='local'",
        [passwordHash, now, userUuid]
      );
      const counted = await tx.get('SELECT changes() AS n');
      const n = counted ? counted.n : undefined;
      if (n === 1) return 'reset';
      if (n === 0) {
        const after = signInType(await tx.get(targetModeSql, [userUuid]));
        if (after === 'missing' || after === 'server') return after;
      }
      throw new Error('password reset matched ' + String(n) + ' rows');
    });
  } catch (resetError) {
    // A failed ROLLBACK leaves the transaction state unknown, so it outranks
    // an authorization refusal raised inside the transaction.
    const rollbackError = resetError && resetError.rollbackError;
    if (!rollbackError && resetError && (resetError.statusCode === 401 || resetError.statusCode === 403)) throw resetError;
    node.warn('admin account API password reset failed: ' +
      String(resetError && resetError.message ? resetError.message : resetError) +
      (rollbackError ? ' (rollback also failed: ' +
        String(rollbackError.message ? rollbackError.message : rollbackError) + ')' : ''));
    return answer(500, { message: 'The password reset could not be completed. Reload the user list before trying again.' });
  }
  if (outcome !== 'reset') return refuse(outcome);
  return answer(200, { success: true });
}

module.exports = {
  signInType,
  resetLocalPassword,
};
