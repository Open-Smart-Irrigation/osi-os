---
name: osi-live-ops-runbook
description: Use before deploying to, repairing, backing up, SSHing into, or restarting services on a live or previously provisioned gateway, testing valves on hardware, or judging whether an operation is safe against a farm, production cloud, or customer instance.
---

# OSI Live Ops Runbook

## Overview

This skill is the procedure for touching a **live** OSI OS gateway: a Raspberry Pi
running at a real farm with an irreplaceable `/data/db/farming.db`. It covers the
deploy flow, backup-before-repair, post-deploy verification, known BusyBox/ash traps,
and a set of concrete live-repair recipes. It does not cover how to design a schema
migration, how to edit `flows.json` internals, or agronomy semantics — see "When NOT
to use" below.

Every rule here traces back to `AGENTS.md` ("Live-deploy safety rules", "Host
access gate") and `docs/engineering-playbook.md` §1 (Prime directives). If anything
in this skill ever conflicts with those files, the repo files win — re-read them.

## When to use / When NOT to use

Use this skill when the task involves a **live or previously provisioned** Pi
gateway: deploying a build, restarting services, inspecting or repairing
`farming.db`, recovering from a crash mid-migration, or SSHing into a gateway at all.

Route elsewhere when the task is actually about:

| Task | Use instead |
|---|---|
| Diagnosing a symptom on a live system (which log, which query, which experiment) | `osi-debugging-playbook` |
| Editing `flows.json` node logic, adding a route, changing a function node | `osi-flows-json-editing` |
| Designing a schema migration, understanding the migration risk classes, seed/bundled-DB parity | `osi-schema-change-control` |
| Agronomy meaning of SWT/VWC/dendrometer values, sensor decoding semantics | `osi-agronomy-sensors-reference` |
| UCI option names, env var / feature-flag semantics, what a flag does | `osi-config-and-flags` |

This skill assumes those siblings for anything beyond "how do I safely get bits onto
a live Pi and confirm it didn't break the farm." Do not duplicate their content here;
follow the pointers inline.

---

## Prime safety rules (read first)

### 1. Never overwrite or reseed `farming.db` on a live Pi

The seeding guard in `deploy.sh` that enforces this, `seed_db_if_missing()`, is described in `references/deploy.md`, "How `seed_db_if_missing()` guards the live database".

**Why the seed ships stamped** (moved from `AGENTS.md` on 2026-10-22; same
authority): the bundled seed ships already stamped at the migration head (a full
`schema_migrations` ledger plus `schema_object_fingerprints`, built by
`scripts/build-seed-db.js` via `bootstrapFresh`), so the `run_schema_migration()`
that follows the seed has nothing pending and finishes in seconds. A seed without
that ledger sends every fresh install into `baseline-existing-db.js`'s 1..head
reference-chain rebuild instead, which takes over ten minutes on a 16-core
workstation and is not a viable deploy step on a Pi.

Rationale (from `docs/engineering-playbook.md` §1): **a wrong chart annoys someone;
a wiped `farming.db` destroys months of irreplaceable field data.** The asymmetry is
absolute — treat every farming.db as one-way-destructible.

**Forbidden, no exceptions:**
```bash
# NEVER do this against a live or previously provisioned Pi:
scp .../db/farming.db root@<pi-ip>:/data/db/farming.db
```
This bypasses every guard above and unconditionally destroys the live database. If
you find yourself about to run an `scp`/`cp` whose destination is
`/data/db/farming.db` on anything that has ever been provisioned, stop.

Schema changes on a live Pi go through migrations or idempotent repair SQL — never
through replacing the file. The migration model itself (risk classes, the runner,
fingerprint stamping mechanics) lives in `osi-schema-change-control`; this skill only
covers the live-ops side (backup, verification, stale-fingerprint recovery).

### 2. Backup before any risky repair

Before hand-repairing schema, editing rows directly, or touching ChirpStack's
SQLite config on a live Pi, take a timestamped backup. BusyBox `ash` has no `bash`,
so keep this POSIX:

The backup script is in `references/repair.md`, "Pre-repair backup script".

This matches `AGENTS.md` "Live-deploy safety rules": a timestamped directory under
`/data/db/backups/` holding the `.backup` copy of `farming.db`, the dereferenced
`flows.json`, `settings.js`, `flows_cred.json` and `/usr/lib/node-red/gui/`. Use a
descriptive label prefix instead of the literal `osi-os-` if it helps you find the
right backup later; what matters is the timestamp, the `.backup` method and the
integrity check.

The pre-repair script supplies no consistent rollback copy for a direct
`chirpstack.sqlite` edit and refuses with `NEED_CHIRPSTACK=1`. Its optional raw
copy cannot authorize that write. See `references/repair.md`, "ChirpStack v4 has
no plain REST API"; this runbook supplies no reviewed ChirpStack rollback
procedure.

### 3. Host access gate

Per `AGENTS.md` "Host access gate", the gated hosts are the production OSI Server
(`osicloud.ch`) and every customer-hosted cloud instance. The private operations
docs list the customer hosts; this repo never names them.

- Before any SSH session, file inspection, environment read, secret copy or command
  on a gated host, **the user must name that host in the current turn.**
- A loaded key, a local alias or a successful `ssh` probe is **not** consent.
- Ambiguous phrasing like "the other server" is not enough. Clarify with the user,
  or default to the test host `server.opensmartirrigation.org` instead.
- The test host can carry production gateway data (noted 2026-10-22); treat
  data-changing operations there as production-affecting.

This gate is about the cloud counterpart, not the edge gateways — but it governs the
same class of decision this skill is otherwise all about, so it is repeated here as
a hard stop before any cross-system live-ops session.

### 4. Never reset credentials to unblock yourself

If a login, verifier, or API token is blocking you on a live system, **ask the
operator** rather than resetting or overwriting the credential. Resetting a password
or regenerating a secret to get past a block destroys the original credential and
has caused real incidents. The linked-login offline verifier has no exception:
account link and cloud auth sync are its supported writers, and this runbook has
no manual procedure for it, even when the EUI itself was wrong.

When an EUI change may affect linked login, read `references/repair.md`,
"Changing DEVICE_EUI and linked offline login". It explains how the stored
version selects the subject, gives a read-only inspection and stops for the
operator instead of rewriting a verifier. It is not an EUI transition procedure.

### 5. Deploy prerequisites and stop conditions

The [migration source and SSH prerequisites](../../../docs/operations/migration-manifest-trust.md#required-deployment-prerequisites) are mandatory: select and protect a stable source, authenticate the host/user, own the loopback listener and forwarding port, and confirm forwarding succeeded.

**Read the deploy verdict — do not restart by hand.** There is nothing left for you to restart on a normal deploy.

   Restarting Node-RED by hand right after a green deploy doesn't make it any
   safer — it only obscures which restart (migration, flip, or yours) produced
   the state you're looking at. If something looks wrong, re-read the deploy
   output before touching the service.

On a failing post-flip self-check (`references/deploy.md`, "Deploy runbook (reverse-tunnel flow)", step 5):

   On a failing self-check it instead prints:
   ```text
   ALERT: local health self-check FAILED - AUTO-ROLLING-BACK the flows payload and paired GUI
   ROLLED BACK: flows+GUI -> payloads/<prev>; Node-RED restarted on last-known-good pair
   NOTE: any committed DB migration is NOT auto-undone (DD10); restore is an operator call via 1.B1 backup.
   NOTE: run deploy-canary-gate.js from your operator machine for the full cloud verdict.
   ```
   and exits 1. The flows+GUI pair rolls back automatically; a schema migration
   that already committed earlier in this same deploy does **not** roll back
   with it (DD10) — restoring it is an operator decision, from the backup
   `migrate-cli.js` took under `/data/backups/migrate` (or `$MIGRATE_BACKUP_DIR`
   if set), not something the script undoes for you. Before it restarts on the
   previous pair it proves Node-RED is stopped and the retained payload fits the
   database, and a refusal at any of those points prints an `ERROR` and leaves
   Node-RED stopped (exit 1). If there is no previous payload to roll back to
   (e.g. the very first deploy), it prints
   `ERROR: no previous payload to roll back to; first-deploy payload was removed and Node-RED remains stopped.`
   and exits 1 — treat that as a stop, with the service down.

In the migration step (`references/deploy.md`, "What `deploy.sh` actually does end-to-end", step 8): Node-RED is restarted on success and on an ordinary migration failure; the one exception is `migrate-cli.js` exiting 3 (backup-restore integrity failure), which deliberately leaves Node-RED stopped for the operator.

**When `deploy.sh` refuses to proceed:** a missing/empty communication-preflight
artifact or a failed `verify-communication-contract.js` run; `/srv/node-red/payloads`
on a different filesystem than `/srv/node-red` (the symlink flip can't be atomic);
integrity-check failure on the seed DB; `farming.db` absent while WAL/SHM/journal
sidecars are present; `npm install` failing; the `sqlite3` CLI unavailable and not
installable via `opkg`; Node-RED failing to stop within 30s before a migration;
a pre-migration checkpoint/integrity-check failure; a migration failure (Node-RED
is restarted before the script exits — except `migrate-cli.js` exit code 3, a
backup-restore integrity failure, which leaves Node-RED stopped); a failed
download or verification of the migration runner, an uncreatable migration
backup directory, or an unreadable database size (refused before Node-RED is
stopped); a failed ledger-reconciliation download or probe (the previous
payload is restarted); a failed command-ledger staging run (before anything is
stopped); a failed command-ledger activation after the migration (see below);
and a failed post-flip self-check, which either auto-rolls back the flows+GUI
pair and exits 1, or — when there is no previous payload — removes the
first-deploy payload, leaves Node-RED stopped, and exits 1 with an `ERROR`. All of these are hard aborts (`exit 1`), not partial continues.

After a failed command-ledger activation (`references/deploy.md`, "Failed command-ledger activation"), the fourth outcome is a hold:

- otherwise: Node-RED and identityd are held **stopped**, as in the script's
  other holds. Nothing is disabled, so a reboot or a manual start runs the
  previous payload beside these files. `/srv/node-red/.osi-command-ledger-hold`
  records the reason, the time and the copy.

Way out: re-run the deploy. If it fails again, the load error printed by the
installer or the probe names the cause.

The post-deploy verification checklist is in `references/deploy.md`, "Post-deploy verification checklist":

Run these after every live deploy. Each has an expected "healthy" output — treat any
deviation as a signal to stop and investigate before telling the operator it's done.

### 6. Bootstrap invocation and credential-file recovery

   ChirpStack reprovisioning happens automatically — `osi-bootstrap`
   (`conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap`, `START=99`)
   runs on every boot, checks a stamp file (`/etc/osi-bootstrap.done` plus a
   `CHIRPSTACK_APP_SENSORS=` line in `/srv/node-red/.chirpstack.env`), and only
   re-runs `chirpstack-bootstrap.js` when that stamp is invalid or ChirpStack's
   gRPC port isn't answering yet. No manual bootstrap step is needed after a normal
   restart on an already-provisioned gateway. Never run `chirpstack-bootstrap.js`
   directly: it writes no stamp, so the service runs it again at the next boot,
   mints a second API key and rewrites `.chirpstack.env`. Provision a gateway
   that is not provisioned yet with `/etc/init.d/osi-bootstrap start`. Manual
   re-provision, if ever needed (reuses the existing API key; the env file keeps
   only the `CHIRPSTACK_*` keys):
   ```bash
   rm -f /etc/osi-bootstrap.done && CHIRPSTACK_API_KEY="$(sed -n 's/^CHIRPSTACK_API_KEY=//p' /srv/node-red/.chirpstack.env | head -1)" /etc/init.d/osi-bootstrap start
   ```

   **One exception: the Kiwi/Clover profile repair.** `deploy.sh` runs it
   itself; rerun it by hand only when the deploy printed its WARN, and only as
   this exact command:
   ```bash
   node /srv/node-red/chirpstack-bootstrap.js --repair-soil-profiles
   ```
   Add `--repoint-clover-device=<DevEUI>` (repeatable) to move a Clover
   registered before the repair off the field-tester profile.
   - Only the `/srv/node-red/` copy, which this deploy installed. Never
     `/usr/share/node-red/chirpstack-bootstrap.js`: an image built before the
     repair existed ignores the flag and runs a full provisioning pass (second
     API key, env file rewritten without operator lines, the Clover alias back).
   - Only with `--repair-soil-profiles` (or `--repoint-clover-device`). With
     either flag the script never runs the full pass: it fails instead.
   - `deploy.sh` pins every bootstrap invocation to
     `/srv/node-red/.chirpstack.env`, secures that file before provisioning,
     and stops on credential filesystem status `74` (recovery for
     `UNSAFE_ENTRY`: "Credential env-file refusal" under Live-repair recipes).
     The CLI's `ENV_FILE` override is for direct use only. Updated and replaced files are
     root-owned mode `0600`; the Gen2 backup keeps exact source bytes and an
     existing backup is retained. Text repair requires lossless UTF-8.

"Credential env-file refusal" is `references/repair.md`, "Credential env-file refusal: exit 74 with `UNSAFE_ENTRY`". Its fail-closed steps:

No writer means the `74` came from somewhere else; stop.

3. Delete nothing unless all of these hold for the entry with two links:
   it is a regular file (`-rw-------`, owner root); its link count is exactly
   2; exactly one staging directory exists for that entry
   (`..chirpstack.env.tmp-*` for `.chirpstack.env`,
   `..chirpstack.env.pre-gen2.tmp-*` for `.chirpstack.env.pre-gen2`); and that
   directory holds only `env`, with the same inode number as the entry. A
   symlink, a directory, a link count above 2, or a second link outside a
   staging directory is not an interrupted publication: leave the gateway
   refusing and escalate. When the checks hold, remove the staging link and
   its directory, never a globbed `rm -rf`:
   ```sh
   D=/srv/node-red/..chirpstack.env.tmp-XXXXXX   # the directory found in step 2
   rm "$D/env" && rmdir "$D"
   ls -li /srv/node-red/.chirpstack.env          # link count back to 1
   node "$S" --secure-env-file; echo "exit=$?"   # exit=0
   ```
   The published file and its bytes stay in place; only the second name goes.

From `references/repair.md` (same section):

A staging directory that is empty, or whose `env` has link count 1, comes from
an interruption before publication or after a rename. It does not block later
runs, and the writer leaves its contents root-owned mode `0600` inside a mode
`0700` directory. An unpublished `env` from a first-boot run can hold the only
copy of the key that run created, so keep it until the gateway provisions
cleanly, then remove it the same way.

---

## SSH access pattern

Key-based root SSH to gateways over the operator's VPN/tailnet is the standard
access path:

```bash
ssh -i ~/.ssh/<key> -o IdentitiesOnly=yes root@<pi-ip>
```

Live device inventory (which hostnames/IPs correspond to which farm, which key to
use where) lives in the operator's private notes, not in this repo or this skill —
do not hardcode gateway hostnames, Tailscale IPs, EUIs, or cloud usernames anywhere
in runbooks, docs, or scripts.

---

## References

- `references/deploy.md`: Read before pushing a build to a gateway, when reading a deploy verdict, or when `deploy.sh` refuses to proceed. Sections: "How `seed_db_if_missing()` guards the live database"; "Quick reference"; "Deploy runbook (reverse-tunnel flow)"; "What `deploy.sh` actually does end-to-end"; "Private branch deployments"; "Post-deploy verification checklist".
- `references/repair.md`: Read before any repair on a live gateway: the backup script, fingerprint and ledger recovery, and the repair recipes. Sections: "Pre-repair backup script"; "Stale-fingerprint recovery"; "Foreign-numbered ledger recovery"; "Rehearsing that cutover on a copy"; "Live-repair recipes"; "Stale `.chirpstack.env` overriding runtime identity"; "Credential env-file refusal: exit 74 with `UNSAFE_ENTRY`"; "Changing DEVICE_EUI and linked offline login"; "ChirpStack v4 has no plain REST API"; "Flows fail to load / all routes 404"; "Live valve testing (STREGA)".
- `references/busybox-traps.md`: Read before pasting any command onto a Pi. Sections: "BusyBox / ash traps on the Pi".
- `references/pitfalls-and-maintenance.md`: Read when something looks wrong after a deploy, or to re-verify this skill against the repo. Sections: "Common mistakes"; "Provenance and maintenance".
