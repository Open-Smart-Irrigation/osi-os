---
name: osi-live-ops-runbook
description: Use when deploying OSI OS to a live or previously provisioned Raspberry Pi gateway, repairing a live Pi's Node-RED/ChirpStack/database state, taking a pre-repair backup, recovering from schema fingerprint drift, SSHing into a live gateway, restarting Node-RED on a farm device, testing STREGA valves on live hardware, or judging whether an operation is safe against a running farm or the production cloud host.
---

# OSI Live Ops Runbook

## Overview

This skill is the procedure for touching a **live** OSI OS gateway: a Raspberry Pi
running at a real farm with an irreplaceable `/data/db/farming.db`. It covers the
deploy flow, backup-before-repair, post-deploy verification, known BusyBox/ash traps,
and a set of concrete live-repair recipes. It does not cover how to design a schema
migration, how to edit `flows.json` internals, or agronomy semantics — see "When NOT
to use" below.

Every rule here traces back to `AGENTS.md` ("Live-deploy safety rules", "Production
cloud access") and `docs/engineering-playbook.md` §1 (Prime directives). If anything
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

`deploy.sh` (repo root) contains this literal comment at the top:

```
# Safety invariant: this script must never overwrite /data/db/farming.db.
# The edge database is live user data and osi-os is the operational source of
# truth. The bundled seed database is only copied when the target DB is absent.
```

The actual guard, in `seed_db_if_missing()`:

1. If `/data/db/farming.db` already exists → **SKIP**, log "existing live database
   preserved", return success. Nothing is written.
2. Else if any SQLite sidecar file exists (`farming.db-wal`, `farming.db-shm`,
   `farming.db-journal`) but the main file is absent → **ERROR and refuse**, exit
   non-zero. This is the "DB file missing but the journal isn't" state — it usually
   means something went wrong (mid-crash, mid-copy, a bad manual `rm`), and seeding
   over it would silently discard whatever the sidecars were protecting.
3. Only when the target is truly absent **and** no sidecars exist does it fetch the
   profile-matched seed DB, integrity-check it (`PRAGMA integrity_check` via
   `sqlite3` if available), re-check the target is still absent (race guard), then
   `mv` the seed into place.

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

```sh
# Run on the Pi (ash-compatible)
TS=$(date +%Y%m%d-%H%M%S)
LABEL="pre-repair"          # e.g. "pre-eui-fix", "pre-fingerprint-restamp"
BK="/data/db/backups/${LABEL}-${TS}"
mkdir -p "$BK"
cp -a /data/db/farming.db "$BK/farming.db" 2>/dev/null || true
cp -a /data/db/farming.db-wal "$BK/farming.db-wal" 2>/dev/null || true
cp -a /data/db/farming.db-shm "$BK/farming.db-shm" 2>/dev/null || true
cp -a /srv/node-red/flows.json "$BK/flows.json"
cp -a /srv/node-red/settings.js "$BK/settings.js"
mkdir -p "$BK/gui"
cp -a /usr/lib/node-red/gui/. "$BK/gui/" 2>/dev/null || true
echo "Backup at $BK"
ls -la "$BK"
```

This matches `AGENTS.md` "Live-deploy safety rules": a timestamped backup under
`/data/db/backups/osi-os-<timestamp>` covering `/data/db/`, `/srv/node-red/`
(`flows.json`, `settings.js`), and `/usr/lib/node-red/gui/`. Use a descriptive label
prefix instead of the literal `osi-os-` if it helps you find the right backup later
— what matters is that it is timestamped and covers those three areas.

### 3. Production-cloud access gate

`osicloud.ch` is the production OSI Server. Per `AGENTS.md` "Production cloud
access":

- Treat any SSH access to that host — including through a local alias or an
  already-loaded SSH key — as restricted production access.
- Do not connect to it, inspect its files, read its environment, copy secrets from
  it, or run commands there **unless the user explicitly asks for production /
  `osicloud.ch` access in the current turn.**
- A working SSH key or a successful `ssh` connectivity check is **not** consent.
- Ambiguous phrasing like "the other server" is not enough — clarify with the user,
  or default to the test host `server.opensmartirrigation.org` instead.

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

## Quick reference

| Task | Command |
|---|---|
| Build GUI | `cd web/react-gui && npm run build` |
| Bundle GUI | `tar czf react_gui.tar.gz -C web/react-gui/build .` |
| Serve repo root | `python3 -m http.server 9876 --bind 127.0.0.1` |
| Deploy over reverse tunnel | see "Deploy runbook" step 4 below |
| Restart Node-RED | `/etc/init.d/node-red restart` |
| Free a leaked local port | `pkill -9 -f 'http.server 9876'` |
| SSH to a gateway | `ssh -i ~/.ssh/<key> -o IdentitiesOnly=yes root@<pi-ip>` |
| Filter SSH banner noise | pipe through `grep -v "post-quantum\|store now"` |
| Re-baseline a drifted fingerprint | `node scripts/restamp-fingerprints.js /data/db/farming.db` (on-Pi path) |

---

## Deploy runbook (reverse-tunnel flow)

This is the standard way to push a new build to a live gateway without exposing the
Pi to the internet or needing a registry. Numbered, copy-pasteable, run from your
dev workstation unless noted.

1. **Build the GUI.**
   ```bash
   cd web/react-gui && npm run build
   ```

2. **Bundle it.** `react_gui.tar.gz` at the repo root is disposable — `deploy.sh`
   fetches it by that exact name (see the "React GUI" step in deploy.sh) and nothing
   else references it after the deploy completes.
   ```bash
   cd /path/to/osi-os
   tar czf react_gui.tar.gz -C web/react-gui/build .
   ```

3. **Serve the repo root locally**, bound to loopback only:
   ```bash
   python3 -m http.server 9876 --bind 127.0.0.1
   ```
   Port 9876 must be free before this step. If a previous run leaked a server:
   ```bash
   pkill -9 -f 'http.server 9876'
   ```

4. **Open a reverse tunnel and run the deploy script on the Pi**, downloading first
   instead of piping into `sh`:
   ```bash
   ssh -R 9876:localhost:9876 root@<pi-ip> \
     'curl -fsSL http://localhost:9876/deploy.sh -o /tmp/osi-os-deploy.sh && sh /tmp/osi-os-deploy.sh; rc=$?; rm -f /tmp/osi-os-deploy.sh; exit "$rc"'
   ```
   **Why download-then-run instead of `curl ... | sh`:** in a pipe, the shell's exit
   status is the last command's (`sh`'s), not `curl`'s. If `curl` 404s (local
   `http.server` already exited, tunnel dropped), `sh` gets empty stdin, exits 0, and
   the pipeline reports success — a deploy that fetched nothing can print "Deploy
   complete" and exit 0. Same failure class as `git push | tail -1` hiding a failed
   push behind `tail`'s exit code (engineering playbook §1). Download-then-run makes
   `curl`'s failure set `$rc`, so a 404'd deploy fails loudly over the SSH exit code.
   `deploy.sh`'s own header comment still shows the shorter piped form as a
   convenience one-liner — prefer the hardened form above for anything you need to
   trust.

5. **Restart Node-RED** on the Pi (this step is inside the SSH session, or a second
   SSH call):
   ```bash
   /etc/init.d/node-red restart
   ```
   ChirpStack reprovisioning happens automatically — `osi-bootstrap`
   (`conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap`, `START=99`)
   runs on every boot, checks a stamp file (`/etc/osi-bootstrap.done` plus a
   `CHIRPSTACK_APP_SENSORS=` line in `/srv/node-red/.chirpstack.env`), and only
   re-runs `chirpstack-bootstrap.js` when that stamp is invalid or ChirpStack's
   gRPC port isn't answering yet. No manual bootstrap step is needed after a normal
   restart on an already-provisioned gateway. Manual re-provision, if ever needed:
   ```bash
   node /usr/share/node-red/chirpstack-bootstrap.js
   ```

### What `deploy.sh` actually does end-to-end

Reading straight through the script, in order:

1. Detects the Pi model from `/proc/device-tree/model` to pick the matching seed DB
   profile (`bcm2712` for Pi 5, `bcm2709` for Pi 4/400/3/2, `bcm2708` for Pi Zero/1;
   unknown models fall back to `bcm2712`, the canonical source-of-truth profile).
2. Runs a **communication preflight**: fetches `flows.json` for all three hardware
   profiles plus the Node-RED init script, `settings.js`, `chirpstack-bootstrap.js`,
   and the diagnose script into a temp dir, fails loudly if any fetched artifact is
   empty, then runs `verify-communication-contract.js` against them before touching
   anything live.
3. Deploys `settings.js`, the Node-RED init script, the gateway identity helper
   (both `chmod 755`), removes a legacy GPS sidecar service if present, deploys
   `flows.json`.
4. Runs `seed_db_if_missing` — the guarded, non-destructive DB step above.
5. Deploys the Node-RED runtime `package.json`/`package-lock.json`, every helper
   module (`osi-chirpstack-helper`, `osi-db-helper`, `osi-dendro-helper`,
   `osi-history-helper`, `osi-chameleon-helper`, `osi-cloud-http`), the bootstrap
   script, and the four device codecs (STREGA, LSN50, S2120, LoRain).
6. Runs `npm install --omit=dev --no-fund --no-audit` in `/srv/node-red`, exiting
   non-zero on failure.
7. Runs a fixed sequence of **idempotent, additive schema-repair steps** against the
   live DB if it exists: dendrometer calibration columns, zone irrigation
   calibration table, `analysis_views` table, the Chameleon SWT column/table set,
   and the gateway-health tables (this last one executes the actual ordered-
   migration SQL file and refuses to apply it unless its header line is exactly
   `-- risk: additive`). Each step swallows only `duplicate column name` errors or
   uses `CREATE TABLE IF NOT EXISTS`, and verifies its own postcondition before
   printing `OK`. None of these run if `/data/db/farming.db` doesn't exist yet (they
   SKIP — a brand-new Pi ends up at exactly the bundled seed schema, not
   seed-plus-repairs). The general migration model these are instances of — risk
   classes, the runner, fingerprint stamping — is `osi-schema-change-control`'s
   territory; this script predates and coexists with that runner for these specific
   historical repairs.
8. Fixes mosquitto file ownership/permissions if mosquitto is installed.
9. Deploys the React GUI: fetches `react_gui.tar.gz`, wipes
   `/usr/lib/node-red/gui/` (including dotfiles), extracts the new bundle in place.
10. Prints next-step reminders (restart Node-RED, open `/gui`, bootstrap note).

**When `deploy.sh` refuses to proceed:** missing/empty preflight artifact,
integrity-check failure on the seed DB, `farming.db` absent but WAL/SHM/journal
sidecars present, `npm install` failing, a gateway-health migration file whose
header isn't `-- risk: additive`, or any schema-repair postcondition check failing.
All `exit 1` rather than continuing partially.

---

## Post-deploy verification checklist

Run these after every live deploy. Each has an expected "healthy" output — treat any
deviation as a signal to stop and investigate before telling the operator it's done.

| Check | Command | Expected |
|---|---|---|
| `farming.db` preserved | `sqlite3 /data/db/farming.db "SELECT COUNT(*) FROM device_data;"` before/after | Same or larger count, never smaller or zero after a non-empty prior count |
| Fresh telemetry | `sqlite3 /data/db/farming.db "SELECT deveui, recorded_at FROM device_data ORDER BY recorded_at DESC LIMIT 5;"` | Timestamps within the last few minutes (gateway-dependent uplink cadence) |
| GUI bundle rotated | `ls /usr/lib/node-red/gui/assets/` | New `index-<hash>.js` filename different from the pre-deploy listing (Vite content-hashes build output; `web/react-gui/vite.config.js` sets `base: '/gui/'`) |
| Node-RED up | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:1880/gui` | `301` (redirect into the SPA route) |
| Zone CSV export route auth-gated | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:1880/api/history/zones/1/export.csv` | `401` — this route (`GET /api/history/zones/:zoneId/export.csv` in `flows.json`, tab `history-api-tab`) requires a Bearer token via `verifyBearer`; `401` without a token means the route loaded and is enforcing auth correctly. `404`/`500` means the route or its router function failed to load — treat as broken, not healthy. |
| ChirpStack profile env vars present | `grep -E 'CHIRPSTACK_PROFILE_(RAK10701|S2120)' /srv/node-red/.chirpstack.env` (path/semantics) | Both present. Flag semantics and full variable list: `osi-config-and-flags`. |
| Gateway health samples fresh | `sqlite3 /data/db/farming.db "SELECT gateway_device_eui, sampled_at FROM gateway_health_samples ORDER BY sampled_at DESC LIMIT 3;"` | Rows within the last ~60 s (the 60 s heartbeat inject also persists this table; schema at `database/migrations/ordered/0002__gateway_health.sql`) |

Use `127.0.0.1`, not `localhost`, for every on-Pi curl (see BusyBox traps below).

---

## Stale-fingerprint recovery

`scripts/restamp-fingerprints.js` re-baselines `schema_object_fingerprints` to
whatever the live schema currently is:

```bash
node scripts/restamp-fingerprints.js /data/db/farming.db
```

**Only run this when both are true:**
- `applyPending`/`verifyHead` (the migration runner's own checks) report fingerprint
  drift specifically because of a crash between a migration's commit and its
  fingerprint stamp — not because the schema is actually wrong.
- You (or the operator) have independently confirmed the live schema is correct for
  the intended migration state.

The script refuses to run against a nonexistent path (it deliberately does not let
`sqlite3` silently create-and-restamp an empty DB at a typo'd path). It has no other
guard: it does not verify the schema is correct itself, it only re-stamps whatever
is there. That judgment call is the operator's, not the script's.

This is the **only** sanctioned way to overwrite the fingerprint baseline. Never
hand-edit rows in `schema_object_fingerprints` directly. After running it, run
`verifyHead` again and confirm `ok:true` before considering the drift resolved. The
migration model this fingerprint mechanism belongs to (what a "commit" vs "stamp"
step is, what drift means structurally) is `osi-schema-change-control`'s territory.

---

## BusyBox / ash traps on the Pi

The Pi image runs BusyBox `ash`, not `bash`. These are field-verified operator
knowledge (label: operator-procedure, not independently re-derivable from this repo
alone):

- **No bash.** Don't use `[[ ]]`, arrays, `local` in places bash allows but POSIX
  doesn't, or bashisms in any one-liner you paste onto the Pi. Stick to POSIX `sh`/
  `ash` syntax, as `deploy.sh` itself does (`#!/bin/sh`, `set -eu`).
- **Case conversion:** use `tr 'abcdef' 'ABCDEF'`, not `tr '[:lower:]' '[:upper:]'`
  — the POSIX character-class form is unreliable on this image. This is also called
  out in `AGENTS.md` under "Conventions".
- **`localhost` resolves to IPv6 `::1` first** under the minimal `wget`/resolver on
  this image, which often has nothing listening on `::1`. Always target `127.0.0.1`
  explicitly in on-Pi curl/wget calls, including in the verification checklist
  above and in the reverse-tunnel deploy command.
- **The SSH "post-quantum" banner is harmless.** Every SSH connection to these
  gateways prints a post-quantum key exchange notice from the server side. Filter it
  out of scripted output rather than treating it as an error:
  ```bash
  ssh ... 2>&1 | grep -v "post-quantum\|store now"
  ```

---

## Live-repair recipes

### Stale `.chirpstack.env` overriding runtime identity

`/srv/node-red/.chirpstack.env` can carry a stale `DEVICE_EUI*` value that overrides
the runtime identity even after UCI has been corrected. During an identity repair,
remove or regenerate this file so the helper/UCI path (canonical, uppercase EUI)
is what actually takes effect. Full flag semantics and where this file's other
variables come from: `osi-config-and-flags`.

### Changing DEVICE_EUI breaks linked login

The offline verifier is `bcrypt(password::DEVICE_EUI)` (see `AGENTS.md` "Security").
If the EUI changes (fixing a wrong one, replacing hardware), every stored verifier
for that gateway stops matching and logins fail. Repair sequence:

1. Fix the UCI value:
   ```bash
   uci set osi-server.cloud.device_eui='<CORRECT_EUI_UPPERCASE>'
   uci commit osi-server
   ```
2. Regenerate the verifier on the Pi with `bcryptjs` (placeholders `<password>` /
   `<eui>` — uppercase EUI, same delimiter):
   ```bash
   node -e "const b=require('/srv/node-red/node_modules/bcryptjs'); console.log(b.hashSync('<password>::<eui>', 10))"
   ```
3. Write the new hash into the DB:
   ```bash
   sqlite3 /data/db/farming.db "UPDATE users SET server_offline_verifier = '<hash>' WHERE username = '<username>';"
   ```
4. Restart Node-RED, then have the operator unlink and re-link the cloud account so
   a fresh sync token issues for the corrected EUI.

Also check `irrigation_zones` rows created before the fix — a sync trigger applies a
`COALESCE(gateway_device_eui, <fallback>)` only on `INSERT`, so already-existing zone
rows keep whatever EUI they were created with and need an explicit `UPDATE`.

### ChirpStack v4 has no plain REST API

ChirpStack v4.x is gRPC-web only; `curl http://127.0.0.1:8080/api/...` 404s
regardless of payload. To inspect or change ChirpStack config on a live Pi:

- **Read:** `sqlite3 /srv/chirpstack/chirpstack.sqlite "SELECT ...;"`
- **Write:** stop ChirpStack first (the DB is locked while it runs), modify via
  `sqlite3`, then start it again:
  ```bash
  /etc/init.d/chirpstack stop
  sqlite3 /srv/chirpstack/chirpstack.sqlite "UPDATE ... ;"
  /etc/init.d/chirpstack start
  ```

### Flows fail to load / all routes 404

`functionExternalModules: true` is set in `settings.js` (confirmed at
`feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js`). If a function
node's `libs` array references a helper module (e.g. `osi-db-helper`) not declared
in `/srv/node-red/package.json`, Node-RED tries to `npm install` it, fails (not a
published package), and refuses to load **all** flows — every route returns 404
with nothing obviously wrong in standard logs. Fix: ensure `package.json` declares
it as a `file:` dependency, e.g.:
```json
"osi-db-helper": "file:osi-db-helper"
```
`deploy.sh` deploys this file itself, so this mostly bites hand-edited or
partially-deployed Pis. To see the real error, run Node-RED in the foreground:
```bash
node-red --userDir /srv/node-red
```
Triage tables for narrowing down *which* symptom you're looking at belong to
`osi-debugging-playbook`; this recipe is specifically the "declared helper module
missing from package.json" root cause.

### Live valve testing (STREGA)

STREGA valves accept `OPEN_FOR_DURATION` only in normal operation; the valve closes
itself when the commanded duration elapses. There is no safe bare `CLOSE` in this
model — the reconciliation monitor (`strega-reconciliation-monitor` in `flows.json`)
explicitly does not emit a CLOSE downlink on timer elapse, "STREGA self-closes" per
its own comment.

- Never send a bare `CLOSE` command during testing or debugging.
- Use short durations (60 s) when reproducing a valve-open bug; let it auto-close.
- Operator-driven cancellation of an in-progress duration is a real, separate path:
  ```bash
  curl -X POST http://127.0.0.1:1880/api/v1/valves/<deveui>/cancel
  ```
  (confirmed route: `POST /api/v1/valves/:deveui/cancel`, node
  `cancel-valve-http-in` in `flows.json`, tab `device-api-tab`). Reserve this for
  genuine operator cancel intent, not as test cleanup.

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

## Common mistakes

- Running `curl ... | sh` for the deploy step instead of download-then-run, then
  trusting a printed "Deploy complete" without checking the actual SSH/curl exit
  code — a 404'd fetch can still exit the pipeline at 0.
- Treating `export.csv` returning `401` as a failure. It is the healthy state for an
  unauthenticated request; `404`/`500` is the actual failure signal.
- `scp`-ing any `farming.db` onto a Pi that has ever been provisioned — there is no
  scenario in normal operations where this is correct.
- Using `localhost` in an on-Pi curl/wget call and getting a confusing connection
  refusal that's actually an IPv6 resolution artifact, not a dead service.
- Sending a bare `CLOSE` to a STREGA valve "to be safe" — it is not part of the
  supported command set; use a short `OPEN_FOR_DURATION` or the cancel endpoint.
- Resetting a password or token to get unblocked instead of asking the operator.
- Treating a loaded SSH key or working `ssh` check against `osicloud.ch` as
  permission to proceed there.
- Hand-editing `schema_object_fingerprints` instead of using
  `restamp-fingerprints.js`, or running that script without first confirming the
  live schema is actually correct.
- Forgetting `ensure_*_schema` steps in `deploy.sh` only run when `farming.db`
  already exists — on a brand-new Pi they SKIP, so a fresh gateway ends up exactly
  at the bundled seed schema, not at seed-plus-repairs.

---

## Provenance and maintenance

Re-verify these if this skill feels stale (the deploy flow and safety rules change
rarely, but do change):

- Seeding guard logic: `grep -n "seed_db_if_missing" -A 25 deploy.sh` (repo root).
- Download-then-run tunnel command still matches practice: check the current
  operator wrapper behavior contract (not in this repo) or re-derive from
  `deploy.sh`'s own header comment plus this skill's rationale.
- `osi-bootstrap` stamp/START logic:
  `cat conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap`.
- `export.csv` route + auth gate: `grep -n "export.csv" -A2` and
  `grep -n "function verifyBearer" -A15` against
  `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`.
- STREGA cancel route: `grep -n "valves/:deveui/cancel"` against the same
  `flows.json`.
- `restamp-fingerprints.js` behavior: `sed -n '1,30p' scripts/restamp-fingerprints.js`.
- Gateway-health table/migration: `sed -n '1,10p' database/migrations/ordered/0002__gateway_health.sql`.
- package.json helper declarations: `grep -n "file:" conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/package.json`.
- `functionExternalModules` flag: `grep -n functionExternalModules feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js`.
- Prime directives / asymmetry framing: `sed -n '13,32p' docs/engineering-playbook.md`.
- Production-cloud gate wording: `sed -n '/Production cloud access/,/^---/p' AGENTS.md`.
- Cross-check this file still matches `AGENTS.md` "Live-deploy safety rules" verbatim
  intent — if that section is edited, this skill's Prime Safety Rules section needs
  a matching pass.
