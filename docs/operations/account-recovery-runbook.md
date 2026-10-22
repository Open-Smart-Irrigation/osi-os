# Local account recovery

Use this procedure when an administrator resets a local user's password or suspects that the user's current session token must be revoked.

## Revoke an existing session

Password reset alone does not revoke a token already issued by the gateway. Tokens are signed locally and remain accepted until their seven-day expiry. To revoke the old token:

1. Sign in as an enabled administrator.
2. Disable the affected account in the Users administration page, or call `PUT /api/users/:uuid/disabled` with `{ "disabled": true }`.
3. Reset the password with `POST /api/users/:uuid/password-reset`.
4. Re-enable the account with `PUT /api/users/:uuid/disabled` and `{ "disabled": false }` only after the new password has been delivered to the user.
5. Ask the user to sign in again. The previous token may still be usable on gateways running with scoped access disabled; treat it as revoked operationally only after the account has been disabled and re-enabled through the supported administration path.

Do not edit `users.password_hash` directly on a running gateway. The admin API applies the account guards, writes the bcrypt password hash, and emits the normal account-change sync event.

## If the administrator session is lost

Use the live-operations backup and recovery procedure before any database repair. Do not replace `/data/db/farming.db` or remove rows to force a login. If no enabled administrator remains, stop and escalate for an operator-approved recovery; the last-enabled-admin guard is intentional.

This is the supported revocation path until a per-user token epoch is introduced. A token epoch would require a schema migration and coordinated changes to every bearer-token verifier.

## Add a second local account with scoped access off

Since osi-os#468, `POST /auth/register` creates an account only while the gateway has none. With scoped access on, an administrator creates further accounts in the Users administration page. With scoped access off there is no route for it, so an operator adds the account on the gateway itself:

1. Take a backup first, as the live-operations procedure describes, for example `sqlite3 /data/db/farming.db ".backup '/data/db/farming.db.pre-add-user-$(date -u +%Y%m%dT%H%M%SZ)'"`. If the `sqlite3` command is not available on the gateway, stop and escalate.
2. Hash the new password with the bcrypt library Node-RED already uses. The command reads the password from standard input, so it stays out of the shell history; type it, press Enter, then Ctrl-D. The terminal shows what you type.

   ```sh
   HASH="$(node -e "const b=require(require.resolve('bcryptjs',{paths:['/srv/node-red','/usr/share/node-red']}));let s='';process.stdin.on('data',d=>s+=d).on('end',()=>process.stdout.write(b.hashSync(s.replace(/\r?\n$/,''),10)))")"
   ```

3. Insert the account. Choose a username without quotes or spaces:

   ```sh
   sqlite3 /data/db/farming.db "INSERT INTO users (username, password_hash, created_at) VALUES ('NEW_USERNAME', '$HASH', strftime('%Y-%m-%dT%H:%M:%fZ','now'));"
   ```

   This is the statement the registration route ran before osi-os#468, so the database triggers run as they do for a registered account: the account gets a `user_uuid`, and a cloud-linked gateway queues the normal account sync event. Node-RED does not need a restart.
4. Check the row with `sqlite3 /data/db/farming.db "SELECT id, username, role, auth_mode FROM users ORDER BY id;"`, then sign in with the new account in the dashboard.

With scoped access off, each account sees only the zones and devices it created or claimed. A new account does not take over another account's zones or devices, so this recipe does not recover a forgotten password. For that case there is no supported reset path with scoped access off: escalate for an operator-approved recovery, as for a lost administrator session above.

Rehearse the recipe on a test gateway before you use it on a farm gateway.
