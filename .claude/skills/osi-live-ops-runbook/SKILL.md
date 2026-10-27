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
has caused real incidents. The one sanctioned exception is the DEVICE_EUI-linked
offline verifier repair in "Live-repair recipes" below — that regenerates a verifier
that is *supposed* to change because the EUI itself was wrong, not a shortcut around
an unknown credential.

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
- `references/repair.md`: Read before any repair on a live gateway: the backup script, fingerprint and ledger recovery, and the repair recipes. Sections: "Pre-repair backup script"; "Stale-fingerprint recovery"; "Foreign-numbered ledger recovery"; "Rehearsing that cutover on a copy"; "Live-repair recipes"; "Stale `.chirpstack.env` overriding runtime identity"; "Credential env-file refusal: exit 74 with `UNSAFE_ENTRY`"; "Changing DEVICE_EUI breaks linked login"; "ChirpStack v4 has no plain REST API"; "Flows fail to load / all routes 404"; "Live valve testing (STREGA)".
- `references/busybox-traps.md`: Read before pasting any command onto a Pi. Sections: "BusyBox / ash traps on the Pi".
- `references/pitfalls-and-maintenance.md`: Read when something looks wrong after a deploy, or to re-verify this skill against the repo. Sections: "Common mistakes"; "Provenance and maintenance".
