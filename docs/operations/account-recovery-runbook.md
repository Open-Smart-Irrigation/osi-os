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
