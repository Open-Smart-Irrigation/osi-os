# Deploy

Part of the osi-live-ops-runbook skill; read SKILL.md first.

## How `seed_db_if_missing()` guards the live database

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

## Quick reference

| Task | Command |
|---|---|
| Build GUI | `cd web/react-gui && npm run build` |
| Bundle GUI | `tar czf react_gui.tar.gz -C web/react-gui/build .` |
| Serve repo root | `python3 -m http.server 9876 --bind 127.0.0.1` |
| Deploy over reverse tunnel | see "Deploy runbook" step 4 below |
| Restart Node-RED (repairs only; never as part of a deploy, `deploy.sh` restarts it itself) | `/etc/init.d/node-red restart` |
| Show active flows payload | `ls -l /srv/node-red/flows.json` (symlink into `payloads/<stamp>`) |
| Cloud canary verdict after deploy | `OSI_ADMIN_TOKEN=<admin JWT> node scripts/deploy-canary-gate.js --eui <EUI> --since <deploy-start ISO8601>` from the operator machine (full invocation: `docs/operations/deploy-canary-gate-runbook.md`; see step 5) |
| Free a leaked local port | `pkill -9 -f 'http.server 9876'` |
| SSH to a gateway | `ssh -i ~/.ssh/<key> -o IdentitiesOnly=yes root@<pi-ip>` |
| Filter SSH banner noise | pipe through `grep -v -e 'post-quantum' -e 'store now'` (portable; BusyBox grep lacks BRE alternation) |
| Re-baseline a drifted fingerprint | `node scripts/restamp-fingerprints.js /data/db/farming.db` (on-Pi path) |

---

## Deploy runbook (reverse-tunnel flow)

The [migration source and SSH prerequisites](../../../../docs/operations/migration-manifest-trust.md#required-deployment-prerequisites) are mandatory: select and protect a stable source, authenticate the host/user, own the loopback listener and forwarding port, and confirm forwarding succeeded.

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
   ssh -o ExitOnForwardFailure=yes -R 9876:localhost:9876 root@<pi-ip> \
     'curl -fsSL http://127.0.0.1:9876/deploy.sh -o /tmp/osi-os-deploy.sh && sh /tmp/osi-os-deploy.sh; rc=$?; rm -f /tmp/osi-os-deploy.sh; exit "$rc"'
   ```
   **Why download-then-run instead of `curl ... | sh`:** in a pipe, the shell's exit
   status is the last command's (`sh`'s), not `curl`'s. If `curl` 404s (local
   `http.server` already exited, tunnel dropped), `sh` gets empty stdin, exits 0, and
   the pipeline reports success — a deploy that fetched nothing can print "Deploy
   complete" and exit 0. Same failure class as `git push | tail -1` hiding a failed
   push behind `tail`'s exit code (engineering playbook §1). Download-then-run makes
   `curl`'s failure set `$rc`, so a 404'd deploy fails loudly over the SSH exit code.
   `deploy.sh`'s own header comment shows the same download-then-run form.

5. **Read the deploy verdict — do not restart by hand.** `deploy.sh` already
   restarts Node-RED itself, up to twice: once around the schema-migration step
   **only when a live `/data/db/farming.db` exists** (`run_schema_migration`
   stops it, migrates, then activates the staged flows+GUI pair
   (`--- Activate paired flows+GUI payload before Node-RED restart ---`,
   `OK: activated flows+GUI payloads/<stamp>`) before it starts Node-RED again,
   so a restart never runs old flows on a migrated schema; on a fresh Pi the
   migration step SKIPs, so this restart does not happen), and once in the
   health block (`--- Flip payload + local health self-check + auto-rollback (5.3 / DD10) ---`):
   it flips the pair if the migration step has not already, and restarts
   Node-RED unless it already did. The flip always switches flows.json and the
   GUI directory together.
   There is nothing left for you to restart on a normal deploy.

   On a passing post-flip self-check the script prints, in order:
   ```text
   OK: boot node confirmed 'sync-init: schema init complete' after <n>s
   OK: local health self-check PASSED (Node-RED service running, /gui reachable after <n>s)
   OK: committing payload <stamp>
   ```
   and prunes old payload directories down to `PAYLOAD_KEEP_N` (default 5).

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

   Restarting Node-RED by hand right after a green deploy doesn't make it any
   safer — it only obscures which restart (migration, flip, or yours) produced
   the state you're looking at. If something looks wrong, re-read the deploy
   output before touching the service.

   The local self-check only proves Node-RED came up and `/gui` answered on
   *this* Pi. For the cloud-side verdict — whether the gateway is actually
   delivering healthy heartbeats to osi-server after the deploy — run, from
   your operator machine (not the Pi). It requires an admin token in the
   environment plus the gateway EUI and the deploy-start timestamp — a bare
   invocation exits `2` (usage error), not a verdict:
   ```bash
   export OSI_ADMIN_TOKEN=<admin JWT>
   node scripts/deploy-canary-gate.js \
     --eui <GATEWAY_EUI> \
     --since <ISO8601 deploy-start timestamp> \
     [--expect-schema-sig <sig>]   # for schema-changing deploys
   ```
   Exit `0` = pass, `1` = fail (read stderr reasons), `2` = usage/auth/transport
   error (treat as fail). Defaults when their flags are omitted: 5 consecutive
   healthy heartbeats (`--consecutive`), 60 s poll interval (`--interval`),
   900 s overall timeout (`--timeout`), `minDiskFreePct` 10. Full procedure:
   `docs/operations/deploy-canary-gate-runbook.md`.

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
   - Deploy updates `/srv/node-red/` but does not replace the image's ROM
     `/usr/share/node-red/` writer. `osi-bootstrap` continues to prefer that
     ROM file whenever it exists; only a new image supplies an updated ROM copy.
   - What it touches: the Tektelic codec on a Kiwi or Clover profile that has
     none (a codec already there is left alone), a new `OSI CLOVER Sensor`
     profile when CLOVER is unset or aliased, the `chirpstack_profile_clover`
     UCI key, the `CHIRPSTACK_PROFILE_CLOVER` env line, and the profile of each
     DevEUI you name. It reuses the existing API key and writes nothing once
     all is correct. Node-RED needs a restart to pick up a new Clover id; after
     a standalone run, request it with
     `/usr/libexec/osi-identityd.sh request-restart chirpstack_bootstrap 60`.

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
3. Reads the release version from `96_osi_server_config` and records the current
   `osi-server.cloud.firmware_version`. Deploys `settings.js`, the Node-RED init
   script, and the gateway identity helper (the latter two `chmod 755`), installs
   `osi-bootstrap` and enables it when it is not enabled (this also re-enables a
   service an operator disabled, and is not undone on rollback; when this deploy
   enables it on a gateway whose env file is already provisioned, it writes
   `/etc/osi-bootstrap.done`), removes a legacy GPS sidecar service if
   present, then fetches the deploy-payload-swap helper
   (`scripts/deploy-payload-swap.js`) and hard-aborts if `/srv/node-red/payloads`
   is on a different filesystem than `/srv/node-red` — the symlink flip in step
   10 must be atomic, and a cross-filesystem rename can't guarantee that.
4. Stages `flows.json` as a new payload directory,
   `/srv/node-red/payloads/<stamp>` (a UTC timestamp like `20260719T120000Z`),
   via `stagePayload`. The flip that makes this payload live is deferred until
   after the schema-migration step; the previous stamp (if any) is recorded so
   a failed flip can be rolled back to it.
5. Runs `seed_db_if_missing` — the guarded, non-destructive DB step above.
6. Deploys the Node-RED runtime `package.json`/`package-lock.json`,
   the full helper-module set (every `fetch_required "<name> package.json"` in
   `deploy.sh`; list them with
   `grep -o 'fetch_required "[^"]*package.json"' deploy.sh`), `edge-channels.json`,
   the `chirpstack-bootstrap.js` bootstrap script, every file under `codecs/`
   that `deploy.sh` names (list them with `grep -o 'codecs/[a-z0-9_]*\.js' deploy.sh | sort -u`),
   and the partner-institute uplink transform (`agroscope_uplink_transform.js`, an
   edge→cloud forwarding transform, not a device decoder).
7. Runs `npm install --omit=dev --no-fund --no-audit` in `/srv/node-red`, exiting
   non-zero on failure.
8. Runs `run_schema_migration()`: **SKIPs entirely** if `/data/db/farming.db`
   doesn't exist yet (a brand-new Pi ends up at exactly the bundled seed
   schema, not seed-plus-migrations). Otherwise it ensures the `sqlite3` CLI is
   present (attempting `opkg install sqlite3-cli` if missing); fetches
   `database/migrations/ordered/CHECKSUMS.json`, every ordered migration file
   it names, the helper scripts (`baseline-existing-db.js`,
   `repair-sync-outbox-v2.js`, `migrate-cli.js`, `semantic-schema-compare.js`,
   `restamp-fingerprints.js`, `verify-head-cli.js`,
   `verify-runtime-schema-parity.js`) and the `lib/osi-migrate` runner
   modules, then refuses, before Node-RED is touched, unless every migration
   matches its `CHECKSUMS.json` SHA-256, no unnamed `.sql` sits beside them,
   and every runner file is non-empty and parses; stops Node-RED and waits up to 30s
   for the process to exit, refusing to proceed if it doesn't; WAL-checkpoints
   the DB and runs `PRAGMA integrity_check`; if the `schema_migrations` ledger
   has zero rows, runs the sync-outbox v2 repair then `baseline-existing-db.js`
   first; then runs `migrate-cli.js --backup-dir /data/backups/migrate`
   (override via `MIGRATE_BACKUP_DIR`). Node-RED is restarted on success and on
   an ordinary migration failure; the one exception is `migrate-cli.js` exiting
   3 (backup-restore integrity failure), which deliberately leaves Node-RED
   stopped for the operator. The runner mechanics this step delivers — risk
   classes, checksums, fingerprint stamping — are `osi-schema-change-control`'s
   territory; this section only covers what `deploy.sh` does mechanically to
   fetch and invoke them.
9. Fixes mosquitto file ownership/permissions if mosquitto is installed.
10. Flips the payload live (`flipTo(<new stamp>)`: flows.json and the GUI
    directory together; skipped when the migration step already activated it),
    writes the new `firmware_version` to UCI (every switch back to the previous
    payload puts the old value back first), restarts Node-RED unless the
    migration step did, then probes `http://127.0.0.1:1880/gui` with
    `wget --spider` and requires the boot node's
    `sync-init: schema init complete` line from this restart (5.3 / DD10).
    On pass: prints `OK: local health self-check PASSED …` then
    `OK: committing payload <stamp>` and prunes old payload directories to
    `PAYLOAD_KEEP_N` (default 5). On fail: prints
    `ALERT: local health self-check FAILED - AUTO-ROLLING-BACK the flows payload and paired GUI`,
    flips back to the previous stamp (flows and GUI together), restarts
    Node-RED on the last-known-good pair, prints
    `ROLLED BACK: flows+GUI -> payloads/<prev>; Node-RED restarted on last-known-good pair`,
    notes that a committed DB migration is **not** auto-undone (DD10 — see
    step 8) and that `deploy-canary-gate.js` gives the full cloud verdict, then
    exits 1. If there is no previous payload to roll back to, it removes the
    first-deploy payload, leaves Node-RED stopped, prints an `ERROR`, and
    exits 1.
11. The React GUI is not a separate step after the flip. Earlier,
    `--- flows.json + React GUI (staged payload; activation deferred to migration) ---`
    fetches `react_gui.tar.gz`, extracts it into a staging directory and stages
    it with flows.json as one payload (`OK: staged paired payloads/<stamp> …`),
    and captures the existing flows+GUI pair as the rollback target
    (`OK: captured existing flows+GUI pair as payloads/<prev>`). Nothing under
    `/usr/lib/node-red/gui/` is wiped in place: the flip in step 10 swaps the
    whole pair, so the `/gui` probe exercises the new GUI bundle together with
    the new flows. It still proves only that Node-RED served the route, not that
    the SPA works in a browser.
12. Prints the final summary: `=== Deploy complete. ===`, the payload path
    annotated "(flipped + local health self-checked)", a rollback note
    (automatic for payload failure; committed DB migration restore is the 1.B1
    operator path, not automatic), and the ChirpStack reprovisioning reminder.

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

**Failed command-ledger activation.** At staging, before anything is stopped,
`deploy.sh` copies the live `osi-command-ledger/{package.json,index.js}` and
`osi-watermark-binding/canonicalization.js` to
`/srv/node-red/.osi-command-ledger-previous.<stamp>`. The file `absent` in that
directory lists the files that did not exist. If the copy fails, the deploy stops
there. A successful deploy removes the copy; a failed one keeps it.

If the activation fails, the script lists each live file as previous,
candidate, absent or unknown, then decides:
- no ledger file is in place, as before the deploy (a gateway that never had
  one): the deploy's usual failure path runs, which restarts the previous
  payload when the database allows it;
- the live pair loads in a fresh process: the same failure path runs;
- it does not load: the kept state is restored. Absent files are restored too:
  candidate files that did not exist before are moved to `<copy>/failed`. If
  the result has no ledger files, or loads, the same failure path runs;
- otherwise: Node-RED and identityd are held **stopped**, as in the script's
  other holds. Nothing is disabled, so a reboot or a manual start runs the
  previous payload beside these files. `/srv/node-red/.osi-command-ledger-hold`
  records the reason, the time and the copy.

Every later deploy reads the marker before its first fetch:
- if the live pair loads, it clears the marker and says so;
- if not, it prints a `WARNING` and carries on; an activation whose pair
  loads clears the marker.

Way out: re-run the deploy. If it fails again, the load error printed by the
installer or the probe names the cause.

### Private branch deployments

Deployments from private product branches use the same migration and payload
safety gates as the public product. Complete schema migration and any ledger
reconciliation before flipping the payload, and deploy compatible cloud and
edge versions in that order.

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
| ChirpStack profile env vars present | `grep -e 'CHIRPSTACK_PROFILE_RAK10701' -e 'CHIRPSTACK_PROFILE_S2120' /srv/node-red/.chirpstack.env` (path/semantics; pipe-free form keeps this table row rendering) | Both present. Flag semantics and full variable list: `osi-config-and-flags`. |
| Gateway health samples fresh | `sqlite3 /data/db/farming.db "SELECT gateway_device_eui, sampled_at FROM gateway_health_samples ORDER BY sampled_at DESC LIMIT 3;"` | Rows within the last ~60 s (the 60 s heartbeat inject also persists this table; schema at `database/migrations/ordered/0002__gateway_health.sql`) |

Use `127.0.0.1`, not `localhost`, for every on-Pi curl (see BusyBox traps below).

---
