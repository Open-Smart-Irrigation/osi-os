# Customer gateway deploy runbook

This is the procedure for deploying a branded customer line, `customer/<name>`
in the private repo `Open-Smart-Irrigation/osi-os-customers`, to a live
gateway. It extends the generic flow in
[docs/operations/deploying-over-a-flaky-link.md](deploying-over-a-flaky-link.md)
and [.claude/skills/osi-live-ops-runbook/SKILL.md](../../.claude/skills/osi-live-ops-runbook/SKILL.md)
with the parts that are customer-specific: which checkout to deploy from,
ledger reconciliation for a foreign-numbered gateway, and cloud-before-edge
ordering. Read `AGENTS.md` "Customer branches and the private repo" first for
the branch model this runbook assumes.

Everything below applies to a gateway that has already run a customer line at
least once. A brand-new customer gateway being provisioned for the first time
follows the plain Path B flow in `README.md` against the customer worktree.
`run_schema_migration()` skips entirely on an absent `farming.db`, so there is
no foreign-numbered ledger to reconcile yet.

## 0. Preflight census

Before touching anything, read the gateway's current state. On the Pi:

```sh
sqlite3 /data/db/farming.db "SELECT version, name, checksum, status FROM schema_migrations ORDER BY version;"
```

Record the highest applied version and whether any row's `status` already
reads `repair_required`. This tells you whether reconciliation ran on a prior
deploy (expect none of the rows above 21 to disagree with
`database/migrations/ordered/CHECKSUMS.json`) or is still pending on this one.

## 1. Backup

Pull a consistent copy before any repair or deploy touches the gateway:

```sh
# on the Pi
sqlite3 /data/db/farming.db ".backup /tmp/farming-<name>-<ts>.db"
```

```sh
# from the workstation
mkdir -p ~/osi-backups/<name>-<date>
ssh root@<pi-ip> "cat /tmp/farming-<name>-<ts>.db" > ~/osi-backups/<name>-<date>/farming-<name>-<ts>.db
ssh root@<pi-ip> "sha256sum /tmp/farming-<name>-<ts>.db"
sha256sum ~/osi-backups/<name>-<date>/farming-<name>-<ts>.db
ssh root@<pi-ip> "rm /tmp/farming-<name>-<ts>.db"
```

Compare the two sha256 values by eye before deleting the on-Pi temp file. This
backup is separate from the one `deploy.sh`/`migrate-cli.js` take automatically
during the deploy itself. It exists so a rehearsal (step 2) has a real copy to
work against without risking the live device.

## 2. Rehearsal

Run the whole schema path against the backup on the workstation before running
it against the gateway. This is what turns "the plan says pending is
0026–0053" into a verified fact instead of an inference from git history.

From a worktree of the customer branch (see step 4 for how to create one):

```sh
cp ~/osi-backups/<name>-<date>/farming-<name>-<ts>.db /tmp/rehearse-<name>.db

node scripts/reconcile-ledger-numbering.js /tmp/rehearse-<name>.db \
  --migrations-dir database/migrations/ordered \
  --fixtures-dir scripts/fixtures/lineages \
  --backup-dir /tmp/rehearse-<name>-backups \
  --report
```

Read the report. If it lists rows to remap and nothing refuses, apply it:

```sh
node scripts/reconcile-ledger-numbering.js /tmp/rehearse-<name>.db \
  --migrations-dir database/migrations/ordered \
  --fixtures-dir scripts/fixtures/lineages \
  --backup-dir /tmp/rehearse-<name>-backups \
  --apply

node scripts/migrate-cli.js /tmp/rehearse-<name>.db --backup-dir /tmp/rehearse-<name>-backups
node scripts/verify-head-cli.js /tmp/rehearse-<name>.db
```

A `--report` run that finds nothing to reconcile (a main-numbered gateway, or
one already reconciled) is not a rehearsal failure. It means step 3 on the
real gateway will take the automatic fast path with no reconciliation step at
all.

Then rehearse the boot-node schema init itself, since that runs on every
Node-RED start and is the thing that cascade-deleted `device_data` in the
2026-09-12 Uganda incident when it ran against a schema the flows payload
didn't match yet. `scripts/rehearse-devices-rebuild.js` drives the frozen
`sync-init-fn` body through a real-engine facade shim, mode `existing` skips
its own seeding and runs against whatever schema the given file already has:

```sh
node scripts/rehearse-devices-rebuild.js existing /tmp/rehearse-<name>.db
node scripts/rehearse-devices-rebuild.js existing /tmp/rehearse-<name>.db
node scripts/verify-head-cli.js /tmp/rehearse-<name>.db
sqlite3 /tmp/rehearse-<name>.db "PRAGMA integrity_check;"
```

The script reads `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
for the `sync-init-fn` body; the profile parity invariant (`AGENTS.md`) makes
that identical to the bcm2709 copy that actually ships to a Pi 4 gateway like
`bovey-rp4-01`, so this rehearsal covers both profiles by construction. Each
invocation prints a JSON result with `rowsPreserved`, `telemetryPreserved`,
and `aborted` — a passing rehearsal has `rowsPreserved: true`,
`telemetryPreserved: true`, `aborted: false` on both runs. Run it twice, not
once — the boot node runs on every restart, and a fence that only holds on
the first pass is not fenced. Compare row counts
and per-table checksums between the pre-rehearsal backup and the rehearsed
copy for every table that should be untouched by a schema-only migration
(`device_data`, `chameleon_readings`, `sync_outbox`, and any customer-specific
tables). Bovey's 2026-09-16 rehearsal went from ledger 25 to 56, left every
row count and content checksum unchanged, and closed with `PRAGMA
foreign_keys` reporting 1. Anything short of that — a smaller row count, a
changed checksum, `foreign_keys` reporting 0 at close — is a stop, not a
judgment call.

## 3. Deploy the cloud side first

A main-lineage edge deploying against an older customer cloud sends sync ops
the cloud does not recognize; the cloud answers `unknown_op`, records the
event in its inbox and dead-letter tables, and there is no way to requeue it
later; a resend gets `DUPLICATE` instead (the osi-server #105 failure class).
Deploy or upgrade the customer's cloud instance before touching the edge
gateway, or accept in writing that the edge will run ahead of a cloud that
cannot process everything it sends.

The cloud side of a customer deploy is an osi-server operation; follow that
repo's own deploy path for the customer's cloud project.

## 4. Build the GUI from the customer worktree

Deploy FROM a worktree of `customers/customer/<name>` (the private
`osi-os-customers` repo, added as the `customers` remote on the osi-os
checkout). Never deploy from a customer ref that happens to sit on the public
`origin` remote, and never from the primary osi-os checkout itself.
Deploying from the wrong checkout ships the wrong branding, or worse, ships a
payload built from a customer branch onto a gateway whose cloud counterpart
expects the generic product.

```sh
git remote add customers git@github.com:Open-Smart-Irrigation/osi-os-customers.git  # first time only
git fetch customers
git worktree add ../osi-os-<name>-deploy customers/customer/<name>
cd ../osi-os-<name>-deploy/web/react-gui
npm ci
npm run build
cd ..
tar czf react_gui.tar.gz -C web/react-gui/build .
```

Only one React build at a time on the workstation; a second concurrent build
OOMs it (see `AGENTS.md` "Conventions" / the frontend build memory-pressure
note).

## 5. Deploy

Serve the customer worktree's repo root and run `deploy.sh` over the reverse
tunnel exactly as the live-ops runbook's "Deploy runbook" section describes:

```sh
python3 -m http.server 9876 --bind 127.0.0.1
# second terminal:
ssh -R 9876:localhost:9876 root@<pi-ip> \
  'curl -fsSL http://127.0.0.1:9876/deploy.sh -o /tmp/osi-os-deploy.sh && sh /tmp/osi-os-deploy.sh; rc=$?; rm -f /tmp/osi-os-deploy.sh; exit "$rc"'
```

On a foreign-numbered ledger, `run_schema_migration()` now reconciles
automatically: since PR #242 (main `fdc0a6ba7`), the probe compares every
applied ledger row above 0021 against
`database/migrations/ordered/CHECKSUMS.json` and runs
`scripts/reconcile-ledger-numbering.js` the moment it finds a mismatch. Before
#242 the probe compared only the lowest applied row above 21, which let a
lineage whose earliest foreign-numbered rows happen to be byte-identical to
main's own migrations at those numbers (Bovey's 0022–0024) slip past
undetected; the mismatch only surfaced at 0025, where a header-comment-only
difference in the checksum tripped `repair_required` with no automatic
recovery. Nothing in this step changes because of that fix — it is why the
step no longer needs a manual reconciliation call at all on a gateway deployed
after #242 landed.

**If the automatic probe does not run reconciliation and the deploy still
reports `repair_required`** (a customer line predating #242, or a case the
probe's ordered scan does not reach), fall back to the explicit sequence —
the same commands rehearsed in step 2, run for real against
`/data/db/farming.db` with a fresh backup directory:

```sh
node scripts/reconcile-ledger-numbering.js /data/db/farming.db \
  --migrations-dir database/migrations/ordered \
  --fixtures-dir scripts/fixtures/lineages \
  --backup-dir <dir> \
  --report

node scripts/reconcile-ledger-numbering.js /data/db/farming.db \
  --migrations-dir database/migrations/ordered \
  --fixtures-dir scripts/fixtures/lineages \
  --backup-dir <dir> \
  --apply

node scripts/migrate-cli.js /data/db/farming.db --backup-dir <dir>
node scripts/verify-head-cli.js /data/db/farming.db
```

Stop Node-RED first (`/etc/init.d/node-red stop`) — reconciliation and
migration both need `writersStopped=true`, the same contract
`migrate-cli.js`'s own callers enforce.

**Never flip the payload by hand before migration succeeds.** If the new
flows payload becomes live while the ledger is still foreign-numbered, main's
boot node runs `sync-init-fn`'s guarded `devices` rebuild against a schema
that does not yet have the columns the next migration adds, and the rebuild
fails with `duplicate column name` on every later deploy attempt — reproduced
against a Bovey copy during this work. Let `deploy.sh` control the flip; it
already defers the flip until after `run_schema_migration()` returns and only
restarts Node-RED once the reconciled/migrated schema and the new flows
payload are both in place together (the ordering rule from the 2026-09-12
Uganda incident, documented in `docs/operations/deploying-over-a-flaky-link.md`).

Read the deploy verdict as the live-ops runbook describes. `deploy.sh` now
also polls `logread` after the restart, for up to `NODE_RED_INIT_TIMEOUT`
(default 45 s), for either `sync-init: schema init complete` (commits the
payload) or `devices rebuild ABORTED` (rolls back); if neither line appears
within the window it fails closed and rolls back rather than guessing.

## 6. Post-deploy checks

Run the standard checklist from the live-ops runbook (`farming.db` preserved,
fresh telemetry, `/gui` returns 301, `export.csv` returns 401, ledger head via
`verify-head-cli.js`), plus the branding-specific checks a generic deploy has
no reason to run:

| Check | Command | Expected |
|---|---|---|
| Ledger head | `node scripts/verify-head-cli.js /data/db/farming.db` | `{"ok":true,...}`, exit 0 |
| GUI tarball hash | `ls /usr/lib/node-red/gui/assets/` before/after | New `index-<hash>.js` filename |
| Branding smoke | open the login page in a browser | Shows the customer's name; no "OSI OS" string, no version number, no "Alpha" tag anywhere on the page |
| Telemetry | `sqlite3 /data/db/farming.db "SELECT deveui, recorded_at FROM device_data ORDER BY recorded_at DESC LIMIT 5;"` | Timestamps within the last few minutes |

## 7. Hardening

Customer sites must not skip these; test gateways may. None of them are part
of the deploy itself — do them once, as a separate pass, immediately after a
customer gateway first goes live.

- Set a root password and disable dropbear password authentication. The image
  ships root with a blank password and password auth enabled by default.
- Confirm `httpAdminRoot: false` is in effect (it is the default since #241) —
  this closes the Node-RED editor and its `/flows`, `/settings`, `/nodes`
  admin routes. Re-enabling it for field repair is a deliberate, temporary
  operator action on the deployed `settings.js`, not a config toggle; close it
  again before leaving the gateway.
- Rotate the shipped AP passphrase. `99_config_chirpstack_ap` ships
  `opensmartirrigation` on a network that sits in the LAN firewall zone. A
  per-device passphrase is a planned change, not yet built.
- Restrict the Tailscale ACL to the operators who need this gateway.
- Verify port 1880 is not reachable from any network the customer does not
  control.

## Rollback

- **Flows/GUI:** flip `/srv/node-red/payloads/<stamp>` back to the previous
  stamp. `deploy.sh` does this automatically on a failed post-flip self-check;
  do it manually only if you need to revert a payload that already committed.
- **Database:** restore from the pre-migration backup `deploy.sh`/
  `migrate-cli.js` took (`/data/backups/migrate` by default, or
  `$MIGRATE_BACKUP_DIR`) or from the step-1 backup in `~/osi-backups/`. Never
  reseed by copying a bundled `farming.db` onto the device.
- **Cloud:** revert to the previous image tag for that customer's compose
  project.

## Worked example: Bovey (`bovey-rp4-01`, Pi 4)

Ledger before this line first ran: 25 rows in Bovey's own numbering, 0022–0024
byte-identical to main's migrations at those same version numbers, 0025
differing from main's `0025` only by a header comment. Backup path pattern:
`~/osi-backups/bovey-rp4-01-2026-09-16/`.

Rehearsal (step 2) against a restored copy: reconciliation classified
0022–0024 as already matching main's checksums at those same version numbers
(no-op) and remapped 0025's header-comment-only mismatch to main's identity
for that version; `migrate-cli.js` then carried the ledger from 25 to 56, and
`verify-head-cli.js` reported `ok:true` at the end. Row counts and per-table
content checksums for `device_data`, `chameleon_readings`, and `sync_outbox`
were unchanged before and after; the final `PRAGMA foreign_keys` check
reported 1.

`bovey-rp4-01` runs the bcm2709 profile (Pi 4/400/3/2 universal image).
`deploy.sh`'s post-flip self-check window (`NODE_RED_HEALTH_TIMEOUT`) is 30 s
by default on every profile, not the 5 s a passing mention in older notes
suggests — a Pi 4's slower cold boot is a reason to watch this check closely
on `bovey-rp4-01`, not a reason the window itself differs by profile.
