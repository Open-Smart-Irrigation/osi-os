# Live gateway identity convergence

How a running gateway switches to a new identity. It moved out of `AGENTS.md`
on 2026-10-22; `AGENTS.md` keeps the fail-closed rule and the two "do not"
rules, and this page carries the same authority. Configuration side
(`DEVICE_EUI` resolution and precedence): the `osi-config-and-flags` skill.

`osi-identityd` is the procd-supervised owner of live gateway identity after
boot. It sources `/usr/libexec/osi-gateway-identity.sh`, writes the observed
identity cache at `/var/run/osi-gateway-identity.json`, and writes transition
state at `/var/run/osi-identity-restart.json`. The cache phases are
`provisional`, `active`, `healing`, and `restart_pending`.

Node-RED still uses one boot-time `DEVICE_EUI*` environment snapshot. During a
live identity transition, link and sync builders read only the restart
sentinel and fail closed; they do not substitute the cache's candidate EUI. The
daemon heals UCI through the shared `resolve -> repair -> resolve -> persist`
helper path, validates durable readback, warns for 60 seconds, then restarts
Node-RED with `/etc/init.d/node-red restart`. That restart switches `DEVICE_EUI`,
MQTT credentials/client ID, sync triggers, link requests, and sync requests
together.

`osi-bootstrap`, account link, and account unlink publish restart requests under
`/var/run/osi-node-red-restart-requests/` instead of restarting Node-RED
directly. `/api/system/stats` exposes only
`restartPending: { restartAt, reason } | null`; target EUIs and monotonic
deadline fields remain private. Do not route identity transitions through the
GUI `/api/system/reboot` route, and do not edit `sync-init-fn` or any
`runGatewayMigrationPreflight` body as part of this path.

Account-link and disconnect also pause sync builders while an account operation
is active or `/data/db/osi-account-link-config.json` exists. This private recovery
journal coordinates the MQTT UCI options with the SQLite account/peer transaction;
it carries credentials and must remain mode 0600. The installation helper flushes
the journal before writing UCI, then flushes the committed database and WAL. Both
normal finalization and recovery retain this receipt until the daemon-owned
restart request has been atomically published. A failed local transaction restores
the old configuration. After an interruption, recovery compares the committed
account and peer with the journal and either completes the new configuration or
restores the old one. A stamped committed receipt whose context has changed stays
blocked for operator disposition.

The account finalizer retries recovery on Node-RED startup. Before another link or
disconnect, the installation helper also retries outstanding publication. A retry
of the same committed link returns its saved result through local success wiring,
without authenticating with the cloud again; a disconnect retry completes without
repeating its database writes. A different requested operation first publishes
the earlier obligation and asks the caller to retry after the scheduled restart.

An unreadable journal, failed restore or failed request publication leaves the
receipt in place and keeps identity-sensitive transport blocked. Thin guards
before every cloud MQTT output use the same predicate as REST/history builders;
ChirpStack downlinks and MQTT broker settings are unchanged. Successful
publication removes the receipt; the identity daemon then owns the restart using
the existing `account_link`/10-second or `account_unlink`/2-second three-field
request contract. The identity sentinel still blocks linking and finalization,
including when it appears while cloud authentication is in flight.
