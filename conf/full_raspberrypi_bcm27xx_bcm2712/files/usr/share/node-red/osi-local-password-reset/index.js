'use strict';
// osi-local-password-reset: local password handling. Two entry points:
// verifyLocalLogin for local sign-in (see the section near the end), and
// resetLocalPassword, the admin password reset behind
// POST /api/users/:uuid/password-reset (#521). The admin account router
// (scoped-admin-account-router) checks the scoped-access flag, the bearer
// token and the actor's admin role, then calls resetLocalPassword and answers
// with the returned status and payload.
//
// A linked account (auth_mode='server') signs in with its linked credential,
// never password_hash, so a local reset cannot change its login. Refuse it;
// reset only local accounts. Unknown modes fail closed.
//
// Every dependency is passed in by the caller: db is the router's osi-db-helper
// handle, scope the single osi-scope-helper instance the router loads through
// osi-lib, bcrypt the router's bcryptjs, node the function node (for
// node.warn). This module loads no other module itself; local sign-in opens
// the farming database through the caller's osiLib.

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

// ---------------------------------------------------------------------------
// Local sign-in (POST /auth/login, node auth-process-result).
//
// verifyLocalLogin checks the password of a local account (any auth_mode other
// than 'server'; the node keeps the linked branch). A bcrypt value is compared
// with bcrypt only. A stored value that is not yet bcrypt is compared as
// stored, and on a match it is replaced by a bcrypt hash at the registration
// cost before the node issues the token. When that write fails the sign-in
// still succeeds (a gateway that cannot write must not lock anyone out),
// node.warn reports it, and the next sign-in tries again.
//
// The first local account (users.id 1) on a value that is not yet bcrypt must
// choose a new password. The rehash stores a pending-change record in
// app_settings in the same transaction, so the requirement survives the
// rehash. The sign-in still returns a token; the payload carries
// passwordChangeRequired and the GUI asks for a new password before it opens
// the session. The GUI sends the new password with the next sign-in request
// (newPassword); it is honoured only while the record is pending, only after
// the current password verified, and only for an account that may sign in.
//
// The farming database is opened through the caller's osiLib
// ('osi-db-helper') only when a read or write is needed, and closed again.

const LOCAL_HASH_COST = 10;
const MIN_PASSWORD_LENGTH = 6;
// bcrypt reads only the first 72 bytes of its input.
const MAX_PASSWORD_BYTES = 72;
const FIRST_ACCOUNT_ID = 1;
const CHANGE_KEY_PREFIX = 'local_password_change_required:';
const FARMING_DB = '/data/db/farming.db';
// Token claim for a session that must set a new password first. settings.js
// (httpNodeMiddleware) refuses every HTTP route for such a token except
// GET /api/me and POST /auth/login, answering 403 password_change_required.
const TOKEN_CLAIM = 'mustChangePassword';

function openFarmingDb(osiLib) {
  const load = osiLib.require('osi-db-helper');
  if (!load.ok) throw new Error('osi-db-helper unavailable: ' + load.error);
  return new load.value.Database(FARMING_DB);
}

function isBcryptValue(value) {
  return typeof value === 'string' && value.startsWith('$2');
}

function storedValueMatches(stored, password, crypto) {
  if (typeof stored !== 'string' || typeof password !== 'string') return false;
  const digest = (value) => crypto.createHash('sha256').update(value, 'utf8').digest();
  return crypto.timingSafeEqual(digest(stored), digest(password)) && stored === password;
}

function errorText(error) {
  return String(error && error.message ? error.message : error);
}

function changeKey(userId) {
  return CHANGE_KEY_PREFIX + String(userId);
}

async function changeIsPending(db, userId) {
  const row = await db.get('SELECT 1 AS pending FROM app_settings WHERE key=? LIMIT 1', [changeKey(userId)]);
  return !!(row && row.pending);
}

async function changedRows(tx) {
  const counted = await tx.get('SELECT changes() AS n');
  return counted ? Number(counted.n) : NaN;
}

function newPasswordProblem(newPassword, password, stored, bcrypt) {
  if (typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH) {
    return { code: 'password_too_short', message: 'Password must be at least 6 characters' };
  }
  if (Buffer.byteLength(newPassword, 'utf8') > MAX_PASSWORD_BYTES) {
    return { code: 'password_too_long', message: 'Password must be at most 72 bytes' };
  }
  // bcrypt reads only the first 72 bytes, so a bcrypt value is also compared
  // with the candidate itself, not only with the submitted current password.
  if (newPassword === password || (isBcryptValue(stored) && bcrypt.compareSync(newPassword, stored))) {
    return { code: 'password_unchanged', message: 'Choose a password that differs from the current one' };
  }
  return null;
}

async function storeNewPassword(db, options) {
  const { user, bcrypt, newPassword, now } = options;
  const passwordHash = bcrypt.hashSync(newPassword, LOCAL_HASH_COST);
  await db.transaction(async function(tx) {
    await tx.run(
      "UPDATE users SET password_hash=?,updated_at=?,sync_version=sync_version+1 WHERE id=? AND auth_mode<>'server' AND password_hash=?",
      [passwordHash, now, user.id, user.password_hash]
    );
    const n = await changedRows(tx);
    if (n === 0) {
      // The stored value changed after this request read it: the password
      // this request verified is no longer current.
      throw Object.assign(new Error('password change matched 0 rows'), { staleCredential: true });
    }
    if (n !== 1) throw new Error('password change matched ' + String(n) + ' rows');
    await tx.run('DELETE FROM app_settings WHERE key=?', [changeKey(user.id)]);
  });
}

async function rehashStoredValue(db, options) {
  const { user, bcrypt, password, now, markChange } = options;
  const passwordHash = bcrypt.hashSync(password, LOCAL_HASH_COST);
  await db.transaction(async function(tx) {
    await tx.run(
      "UPDATE users SET password_hash=?,updated_at=? WHERE id=? AND auth_mode<>'server' AND password_hash=?",
      [passwordHash, now, user.id, user.password_hash]
    );
    const n = await changedRows(tx);
    if (n !== 1) throw new Error('rehash matched ' + String(n) + ' rows');
    if (markChange) {
      await tx.run(
        'INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at',
        [changeKey(user.id), JSON.stringify({ since: now }), now]
      );
    }
  });
}

// Resolves to { valid: false } or { valid: true, response }, where response
// holds the extra login payload fields (empty for an ordinary sign-in). It
// never rejects: a comparison that throws (a password that is not a string)
// counts as a mismatch. canSignIn false (the caller refuses the account, e.g.
// a disabled account in scoped mode) verifies the password and writes nothing.
async function verifyLocalLogin(options) {
  const { user, password, newPassword, bcrypt, crypto, node, now, osiLib } = options;
  const canSignIn = options.canSignIn !== false;
  const warn = (message) => node.warn('local sign-in: ' + message);
  const stored = user && user.password_hash;
  const bcryptStored = isBcryptValue(stored);
  let valid = false;
  try {
    valid = bcryptStored ? bcrypt.compareSync(password, stored) : storedValueMatches(stored, password, crypto);
  } catch (error) {
    warn('password comparison failed: ' + errorText(error));
  }
  if (!valid) return { valid: false };
  if (!canSignIn) return { valid: true, response: {} };

  const firstAccount = Number(user.id) === FIRST_ACCOUNT_ID;
  if (bcryptStored && !firstAccount) return { valid: true, response: {} };

  let db = null;
  try {
    db = openFarmingDb(osiLib);
  } catch (error) {
    warn('database unavailable: ' + errorText(error));
  }
  try {
    let required = firstAccount && !bcryptStored;
    // known: the requirement was detected at this sign-in or read from its
    // record. Only a known requirement restricts the token (TOKEN_CLAIM).
    let known = required;
    if (firstAccount && bcryptStored) {
      // A record that cannot be read counts as pending for the response, so
      // the GUI asks again; the token stays unrestricted, because a gateway
      // that cannot read the record may not be able to store a new password.
      required = true;
      if (db) {
        try {
          required = await changeIsPending(db, user.id);
          known = required;
        } catch (error) {
          warn('pending password change could not be read; asking for a new password: ' + errorText(error));
        }
      } else {
        warn('pending password change could not be read; asking for a new password');
      }
    }
    const response = {};
    if (required && newPassword !== undefined && newPassword !== null && newPassword !== '') {
      const problem = newPasswordProblem(newPassword, password, stored, bcrypt);
      if (problem) {
        response.passwordChange = 'rejected';
        response.passwordChangeError = problem.code;
        response.passwordChangeMessage = problem.message;
      } else if (db) {
        try {
          await storeNewPassword(db, { user, bcrypt, newPassword, now });
          return { valid: true, response: { passwordChange: 'changed' } };
        } catch (error) {
          warn('new password could not be stored for user ' + String(user.id) + ': ' + errorText(error));
          if (error && error.staleCredential) return { valid: false };
          response.passwordChange = 'failed';
        }
      } else {
        response.passwordChange = 'failed';
      }
    }
    if (!bcryptStored) {
      if (Buffer.byteLength(String(password), 'utf8') > MAX_PASSWORD_BYTES) {
        // bcrypt would keep only the first 72 bytes of this password; the
        // stored value stays as it is until the password is replaced.
        warn('rehash skipped for user ' + String(user.id) + ': password longer than ' + MAX_PASSWORD_BYTES + ' bytes');
      } else if (!db) {
        warn('rehash skipped for user ' + String(user.id) + '; it is retried at the next sign-in');
      } else {
        try {
          await rehashStoredValue(db, { user, bcrypt, password, now, markChange: firstAccount });
        } catch (error) {
          warn('rehash failed for user ' + String(user.id) + '; it is retried at the next sign-in: ' + errorText(error));
        }
      }
    }
    if (required) response.passwordChangeRequired = true;
    return known ? { valid: true, response, claims: { [TOKEN_CLAIM]: true } } : { valid: true, response };
  } finally {
    if (db) {
      try {
        await db.close();
      } catch (error) {
        warn('database close failed: ' + errorText(error));
      }
    }
  }
}

module.exports = {
  signInType,
  resetLocalPassword,
  isBcryptValue,
  verifyLocalLogin,
  LOCAL_HASH_COST,
  CHANGE_KEY_PREFIX,
  FARMING_DB,
  MAX_PASSWORD_BYTES,
  TOKEN_CLAIM,
};
