'use strict';
// A1 — local account lifecycle: register, login, "logout", expired/tampered tokens.
//
// Preconditions: none. Works against an empty users table (fresh deploy) and
// against a populated one -- every account it touches is created by this case.
//
// Routes under test (flows.json, Authentication tab):
//   POST /auth/register  -> auth-register-func / auth-db-insert
//   POST /auth/login     -> auth-db-query / auth-process-result
//   GET  /api/me         -> api-me-http (any bearer-gated route would do)

exports.title = 'Accounts: register, login, session, expired + tampered tokens';

const created = [];

exports.run = async (ctx) => {
  const { rest, anonRest, ssh, ev } = ctx;
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  const username = 'osi_a1_' + suffix;
  const password = 'A1pass_' + suffix;

  // --- register -------------------------------------------------------------
  ev.step('register a fresh local account', { username });
  const reg = await anonRest.post('/auth/register', { username, password });
  ctx.expectStatus('POST /auth/register returns 201', reg, 201);
  if (reg.status === 201) created.push(username);

  const row = await ssh.sqlOne(
    "SELECT id, username, password_hash, created_at, auth_mode, role FROM users WHERE username = '" + username + "'"
  );
  ctx.expect('SQLite: users row exists for the new account', !!row, row ? { id: row.id, role: row.role } : null);
  ctx.expect(
    'SQLite: password is bcrypt-hashed, not stored in clear',
    !!row && typeof row.password_hash === 'string' && row.password_hash.startsWith('$2') && !row.password_hash.includes(password),
    row ? { prefix: String(row.password_hash).slice(0, 4) } : null
  );
  ctx.expect('SQLite: created_at is set', !!(row && row.created_at), row ? row.created_at : null);

  // --- register: invalid input ---------------------------------------------
  const dup = await anonRest.post('/auth/register', { username, password });
  ctx.expectStatus('duplicate username is rejected with 400', dup, 400);
  ctx.expect('duplicate rejection names the reason', /exists/i.test(JSON.stringify(dup.body)), dup.body);

  const short = await anonRest.post('/auth/register', { username: username + '_s', password: '12345' });
  ctx.expectStatus('password shorter than 6 chars is rejected with 400', short, 400);

  const noBody = await anonRest.post('/auth/register', { username: '   ', password: 'longenough' });
  ctx.expectStatus('blank username is rejected with 400', noBody, 400);

  const countAfterInvalid = await ssh.sqlScalar(
    "SELECT COUNT(*) AS n FROM users WHERE username LIKE 'osi_a1_" + suffix + "%'"
  );
  ctx.expect('SQLite: rejected registrations created no rows', Number(countAfterInvalid) === 1, { rows: countAfterInvalid });

  // --- login ----------------------------------------------------------------
  const login = await anonRest.post('/auth/login', { username, password });
  ctx.expectStatus('POST /auth/login with correct credentials returns 200', login, 200);
  const token = login.body && login.body.token;
  ctx.expect('login returns a two-part signed token', typeof token === 'string' && token.split('.').length === 2,
    { parts: token ? token.split('.').length : 0 });

  const badPass = await anonRest.post('/auth/login', { username, password: password + 'x' });
  ctx.expectStatus('wrong password returns 401', badPass, 401);
  const unknownUser = await anonRest.post('/auth/login', { username: 'no_such_user_' + suffix, password });
  ctx.expectStatus('unknown username returns 401', unknownUser, 401);
  ctx.expect(
    'wrong-password and unknown-user responses are indistinguishable (no user enumeration)',
    JSON.stringify(badPass.body) === JSON.stringify(unknownUser.body),
    { badPass: badPass.body, unknownUser: unknownUser.body }
  );

  // --- the session the token buys ------------------------------------------
  const me = await rest.get('/api/me', { token });
  ctx.expectStatus('GET /api/me with the fresh token returns 200', me, 200);
  ctx.expect('GET /api/me reports the logged-in username', me.body && me.body.username === username,
    me.body ? { username: me.body.username, role: me.body.role } : null);

  const noToken = await rest.get('/api/me', { token: null });
  ctx.expectStatus('GET /api/me without a token returns 401', noToken, 401);

  const garbage = await rest.get('/api/me', { token: 'not-a-token' });
  ctx.expectStatus('GET /api/me with a malformed token returns 401', garbage, 401);

  const tampered = token.split('.')[0] + '.' + 'A'.repeat(token.split('.')[1].length);
  const tamperedRes = await rest.get('/api/me', { token: tampered });
  ctx.expectStatus('GET /api/me with a tampered signature returns 401', tamperedRes, 401);

  // A token whose payload claims a different user but keeps the original
  // signature must not verify -- this is the "privilege escalation by editing
  // the payload" check.
  const forgedPayload = Buffer.from(JSON.stringify({
    userId: 1, username: 'admin', iat: Date.now(), exp: Date.now() + 3600000,
  })).toString('base64url');
  const forged = forgedPayload + '.' + token.split('.')[1];
  const forgedRes = await rest.get('/api/me', { token: forged });
  ctx.expectStatus('a re-signed-payload forgery returns 401', forgedRes, 401);

  // --- expired token --------------------------------------------------------
  // /auth/login always issues exp = iat + 7d, so an expired token can only be
  // produced by minting one with the gateway's own secret ON the gateway.
  if (row && row.id) {
    const expired = await ssh.mintToken({
      userId: row.id, username, iat: Date.now() - 8 * 24 * 3600 * 1000, exp: Date.now() - 60 * 1000,
    });
    const expiredRes = await rest.get('/api/me', { token: expired });
    ctx.expectStatus('a correctly signed but expired token returns 401', expiredRes, 401);

    const freshMint = await ssh.mintToken({ userId: row.id, username });
    const freshRes = await rest.get('/api/me', { token: freshMint });
    ctx.expectStatus('a freshly minted token with the same secret is accepted (mint path is sound)', freshRes, 200);
  }

  // --- "logout" -------------------------------------------------------------
  // There is no /auth/logout route in flows.json: the GUI logs out by dropping
  // the token client-side. Assert the ACTUAL behaviour so a future server-side
  // revocation shows up as a deliberate change, not a silent one.
  const logoutRoute = await rest.post('/auth/logout', {}, { token });
  ctx.expect('no server-side /auth/logout route exists (client-side logout only)',
    logoutRoute.status === 404 || logoutRoute.status === 405, { status: logoutRoute.status });
  const afterLogout = await rest.get('/api/me', { token });
  ctx.expect('the token still works after a client-side logout (documented: tokens are not revocable)',
    afterLogout.status === 200, { status: afterLogout.status });
  ev.note('No token revocation exists on the edge. A leaked token stays valid for its full 7-day ' +
    'lifetime; "logout" only clears browser state.');

  ev.note('Accounts cannot be deleted through the API (no DELETE /api/users route). ' +
    'Accounts this case creates stay on the gateway: ' + created.join(', '));
};

exports.cleanup = async (ctx) => {
  // Deliberately empty of DB writes: the harness never mutates farming.db
  // directly, and the API has no account-delete route. Record the residue.
  for (const u of created) {
    ctx.ev.cleanupStep('account ' + u, true, 'left in place: no DELETE /api/users route exists');
  }
  created.length = 0;
};
