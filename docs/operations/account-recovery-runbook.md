# Local accounts, scoped enablement and recovery

Public registration creates an account only while `users` is empty. With scoped access on, that first account is an admin; with it off, the default role is researcher. Every existing account closes public registration, including disabled or linked accounts and rows with incomplete identity metadata. A missing admin never reopens it.

First setup requires a trusted commissioning network. Emptiness does not prove ownership. Never delete accounts, empty the table, restore an empty database or replace `/data/db/farming.db` to recover access.

## Use an available administrator

If only the browser session was lost, sign in again as the existing enabled administrator. With scoped access enabled, use Users administration or its authenticated API to create further accounts, promote a verified account, or restore an individually verified account whose disable reason has been resolved. These routes preserve the last enabled administrator.

`POST /api/users/:uuid/password-reset` is suitable only for a local account. It updates `password_hash`; linked authentication reads separate server verifier/hash fields. A 200 response for a linked account does not establish a working new linked credential; the endpoint defect is tracked in [#521](https://github.com/Open-Smart-Irrigation/osi-os/issues/521). Keep the linked account's auth mode and verifier intact. Recover that credential through the established identity-specific cloud process under separate authority; gateway administration can use a named local recovery admin. Relinking and identity changes are outside this procedure.

## Session compromise

Password reset, Node-RED restart and disable/reset/re-enable do not revoke an issued bearer token. In scoped mode disabling blocks the account's freshly checked admin route, but re-enabling permits the same unexpired token again. Tokens normally expire seven days after issuance. Flag-off endpoints and cached guards have different enforcement; this is not proof that disabling revokes every token consumer.

For suspected compromise keep the affected account disabled, retain network containment, and recover administration with a different verified account. Do not re-enable it as a revocation step. Session revocation is tracked in [#520](https://github.com/Open-Smart-Irrigation/osi-os/issues/520) and requires a separate change across token consumers. This procedure does not prescribe signing-key rotation.

## Prepare an existing gateway for scoped access

This is a trusted operator maintenance procedure, not an application bootstrap bypass. It causes telemetry and scheduling downtime. Run it only in a separately authorized maintenance window after rehearsing on a disposable copy and qualifying the deployed sqlite3 driver on an isolated test gateway.

1. The gateway owner or delegated operator selects the intended administrator through operational records and a trusted communication channel. Record the reason, account identity and credential custodian privately. Neither the lowest id, a matching cloud name, a researcher token nor the first login proves authority. If the identity cannot be established, retain the closed state.
2. Restrict untrusted access to the entire product listener, every proxy and alternate network path before any flag change, upgrade or privilege repair. The restriction must survive service restarts, payload rollback and supervisor activity. Stop Node-RED and account for identityd/bootstrap restart requests. Account for pending cloud scoped-user commands; the flag does not pause their application. Do not depend on a cloud recovery bypass.
3. Take and verify the WAL-consistent database and runtime/configuration backups required by the [live-operations skill](../../.claude/skills/osi-live-ops-runbook/SKILL.md). Use a private timestamped directory under `/data/db/backups/`. Do not copy live WAL/SHM files separately. Verify backup integrity and retain the active flow, settings, credential file and GUI contents privately. No backup is authorization to replace a provisioned database.
4. Inspect migration status and all admin rows. If 0045 is already applied, never rerun it. If it is pending, preserve the pre-upgrade account identities, roles and versions privately before the existing migration chain runs. Historical 0045 promotes the lowest enabled id only if no admin row exists, including linked identities; a disabled admin blocks it, and all-disabled non-admins leave no admin. This is a historical data backfill, not verified ownership. Leave its SQL/checksum unchanged.
5. Finish a required upgrade under containment. Deployment may start the paired payload automatically after migrations; failure or rollback may restart a retained payload. Do not depend on a pause between migration and service start. Stop the service again, inspect the actually active payload and post-upgrade accounts, then apply only the selected repair below. If an unintended admin was created by 0045, establish the intended enabled admin first and undo only that proven migration-created promotion using its recorded original role. Never demote pre-existing legitimate admins. If this cannot be verified, defer scoped enablement.

The procedure prevents public takeover during supervised enablement. It does not guarantee that an unattended upgrade never performs 0045's historical promotion. A stronger guarantee needs a separate migration/deployment design. Previously created attacker accounts require incident review; this fix does not remove them.

## Guarded operator repair

Use the reviewed `scripts/account-recovery.js` and adjacent `scripts/lib/account-recovery-transaction.js` from the fixed revision. They are maintenance source files, not a boot hook, public endpoint or automatically installed service. Stage both files together privately on the authorized gateway. The tool requires an existing regular database file and an operator-owned regular mode-0600 spec; symlinks are refused. A missing database is refused before loading a driver, so the tool cannot create that database or its sidecars. It resolves raw `sqlite3` and `bcryptjs` from the script directory, then `/srv/node-red` and `/usr/share/node-red`. It uses a private raw connection with `OPEN_READWRITE`, never the shared queued facade. It adds no dependency or configuration flag.

Inspect only non-secret selection fields while the service is stopped:

```sh
sqlite3 -readonly /data/db/farming.db 'SELECT id,user_uuid,username,server_username,auth_mode,role,disabled_at,sync_version FROM users ORDER BY id;'
sqlite3 -readonly /data/db/farming.db 'SELECT version,name,status FROM schema_migrations ORDER BY version;'
```

Create a mode-0600 JSON specification in the private maintenance directory. Copy the selected row's exact values, preserving JSON null for an enabled account. The shape below is an example for a synthetic account; the operator must use the independently verified row and record, rather than infer values:

```json
{
  "action": "promote",
  "expected": {
    "id": 1,
    "user_uuid": "123e4567-e89b-42d3-a456-426614174000",
    "username": "verified-operator",
    "auth_mode": "local",
    "role": "researcher",
    "disabled_at": null,
    "sync_version": 1
  }
}
```

`promote` accepts an enabled researcher/viewer with usable, trusted credentials and sessions. It changes only role, timestamp and version. Existing tokens for that identity gain the new role too. Missing UUIDs or nonpositive/unknown versions require separate identity repair; the tool refuses them.

`restore` uses the same complete expected identity with `role` admin and the exact existing `disabled_at` string. Use it only after resolving the reason that one account was disabled and verifying credential/session safety. It clears that disabled timestamp, updates the mutation timestamp and increments the version. It never restores all disabled accounts.

`undo-backfill` uses the current complete expected identity and an additional `originalRole` of researcher or viewer from the pre-upgrade record. Use it only for a proven, unintended 0045 promotion. It refuses unless another enabled admin exists. This is a deliberately selected account mutation, never broad demotion SQL.

Run the chosen specification from the directory that contains the staged `scripts/` folder, so that `scripts/account-recovery.js` resolves:

```sh
node scripts/account-recovery.js /data/db/farming.db /root/osi-account-maintenance/spec.json </dev/null
```

The raw sqlite3 transaction uses `BEGIN IMMEDIATE`, bound identity/version predicates, exactly-one-row assertions and full readback. Any mismatch rolls back. It preserves other accounts, credentials, cloud associations, ownership and grants. Timestamp/version changes use normal USER triggers: with `scoped_access_emit.enabled=1` the role/enabled-state event carries the incremented version; with the shipped gate off the mutation stays local. Do not change the emit gate during recovery or claim every repair automatically syncs. Password-hash-only updates are not covered by the role trigger's column list.

### Create a named local recovery administrator

Choose this path when no usable admin credential remains or restoration cannot establish safe sessions. Keep public registration closed. Select a new login name and a designated credential custodian. The name must be unused in both `username` and `server_username`, including disabled accounts; the tool checks both inside its write transaction. A linked alias is reserved even when its row has a different local username. Quote-bearing names are bound as data; never interpolate them into SQL. The spec is `{"action":"create","username":"recovery-operator"}` with a locally chosen, individually managed name. The tool generates a new UUID and inserts a local enabled admin with `edge_originated=1`, `sync_version=1` and a fresh bcrypt credential. It preserves every existing account.

Create a private password file using a terminal with echo disabled. Do not put the password in arguments, shell history, logs or reports:

```sh
umask 077
mkdir -p /root/osi-account-maintenance
saved_tty=$(stty -g) || exit 1
trap 'stty "$saved_tty"' EXIT HUP INT TERM
stty -echo
IFS= read -r recovery_password
stty "$saved_tty"
trap - EXIT HUP INT TERM
printf '%s\n' "$recovery_password" > /root/osi-account-maintenance/password
unset recovery_password
node scripts/account-recovery.js /data/db/farming.db /root/osi-account-maintenance/spec.json < /root/osi-account-maintenance/password
recovery_status=$?
rm -f /root/osi-account-maintenance/password
[ "$recovery_status" -eq 0 ] || exit "$recovery_status"
```

On success the CLI exits 0 and prints only id, user_uuid, username, auth_mode, role, disabled_at and sync_version as one JSON object after closing the connection. It prints no password, hash, linked alias or cloud fields. On refusal/failure it exits 1, prints no success object and emits a fixed generic error. A close failure can follow a committed transaction, so a failure status never licenses a blind retry. Retain the specification and non-secret result privately. On failure or interrupted output, inspect committed state before retrying; never blindly repeat promotion/version increments or create another recovery account. Keep the new admin as an explicitly managed account, or disable it through the authenticated API after verifying another enabled administrator. Do not delete it or transfer resource ownership to it. Record the credential custodian and account disposition.

## Resume and verify under containment

For scoped operation use the existing durable setting, then start the fixed payload under containment:

```sh
uci set osi-server.cloud.scoped_access_enabled=1
uci commit osi-server
/etc/init.d/node-red start
```

Verify the running process has effective `OSI_SCOPED_ACCESS=1` using a targeted environment-key inspection that does not print other keys. Verify the active `auth-db-insert` has `WHERE NOT EXISTS (SELECT 1 FROM users)` in both branches. Using the product UI or a private API client, sign in with the selected credential and confirm `GET /api/users` succeeds. Make a valid unauthenticated registration attempt with a new synthetic username: require 403, no token/success and unchanged account count. Confirm selected role/enabled state, original account preservation, resource ownership, history and normal telemetry/scheduling service before removing containment. Keep failures contained; switching scoped access off is not a rollback for an established multi-user hub.

With scoped access off, public registration still permits only the first account and Users administration is unavailable. Use the same guarded insertion and private-password steps above with a specification such as `{"action":"create","username":"additional-local","role":"researcher"}` to add another local researcher while retaining flag-off operation. Its login sees only its owned zones and devices; this does not recover another account or confer ownership. The former interpolated SQL/hash-shell recipe is retired. Do not use a recovery admin as an ownership-transfer shortcut.
