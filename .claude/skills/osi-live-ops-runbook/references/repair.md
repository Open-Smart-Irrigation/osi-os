# Live repair

Part of the osi-live-ops-runbook skill; read SKILL.md first.

## ChirpStack helper recovery

When `/opt/chirpstack/backup.sh` or `restore.sh` prints a recovery block, keep
that complete block and rerun it after fixing the reported fault. It checks
the maintenance generation before making service calls, preserves the
original stop-attempt mask. Backup recovery only starts the services that
run attempted to stop, checks their processes, and releases the lock last.
Backup never changes live files and does not compare them with pre-start
hashes: a service start may legitimately checkpoint SQLite and consume WAL.
Restore recovery verifies the original inventory before restart because
restore moves live files. Its unfinished hash record can be completed only
when no live file was moved or replaced; known hashes must still match. If
restore's original main database or Redis dump was absent, recovery leaves
services stopped and releases the verified generation for a restore retry.

An interrupted recovery can leave an empty execution-claim directory. The
printed block acquires the BusyBox `flock` process lock before clearing that
directory with `rmdir`; a live owner causes refusal. After SIGKILL, the
kernel releases the process lock once that execution and its children exit,
so rerunning the same block performs the checked cleanup. A nonempty claim
is retained for inspection, including any recovery files inside it.

Never delete `/srv/backup/.chirpstack-recovery.guard`: the block keeps this
inode in place so concurrent executions use the same kernel lock. Do not
remove the maintenance lock or an execution claim by hand to bypass a
refusal. These checks do not establish power-loss durability.

The helpers require `flock` and refuse before taking a maintenance lock or
stopping services if it is missing. Both OSI board configurations select the
BusyBox FLOCK applet. Stock CGOS 4.10.1 support is unknown: this repository
has no pinned stock build configuration or matching tag. Check that build's
applet list or provide util-linux flock before installing these helpers.
The printed recovery block also refuses a missing flock command.

Both helpers check the ownership token before downtime. Restore also
preallocates its recovery staging and original-hash manifest; backup has no
original-set record. A preflight allocation or write failure leaves services
untouched, releases this run's lock, and instructs the operator to repair
backup storage and rerun the same helper. No recovery block depends on an
unallocated record.

## Pre-repair backup script

The script stops at the first required artifact it cannot secure and prints
`Backup at` only after all of them are in place. A `FATAL` line means there is
no rollback set: do not start the repair. The required set is `farming.db`
(an online `.backup` that passes `integrity_check`, or a raw copy taken with
Node-RED stopped), `flows.json`, `settings.js`, `flows_cred.json` and the GUI
directory. Flows, settings, credentials and GUI contents are copied with `-L`.
The script also checks that the flows, settings and credential backups are
regular files and compares those three files with their sources.

This script gives no rollback copy for a direct `chirpstack.sqlite` edit. Its
only ChirpStack copy is raw, taken while ChirpStack may be writing, and nothing
here shows that copy is consistent. When the repair edits `chirpstack.sqlite`,
change the `NEED_CHIRPSTACK=0` line in the script to `1`; the script then
refuses before it writes anything. Edit the line itself: a value exported in
the shell beforehand is overwritten by it. With `0`, a present
`chirpstack.sqlite` is copied to `chirpstack.sqlite.raw` for reference only.

```sh
# Run on the Pi (ash-compatible)
NEED_CHIRPSTACK=0           # 1 = the repair edits chirpstack.sqlite: refuse
die() { echo "FATAL: $* - do NOT proceed with the repair"; exit 1; }
[ "$NEED_CHIRPSTACK" = 0 ] \
  || die "this script makes no rollback copy for a chirpstack.sqlite edit"
TS=$(date +%Y%m%d-%H%M%S)
LABEL="pre-repair"          # e.g. "pre-eui-fix", "pre-fingerprint-restamp"
BK="/data/db/backups/${LABEL}-${TS}"
mkdir -p "$BK" || die "cannot create $BK"
# Raw copy, ONLY with the writer stopped: a raw copy of farming.db and its
# sidecars taken while Node-RED writes is not a consistent backup.
raw_copy_stopped() {
  /etc/init.d/node-red stop
  trap '/etc/init.d/node-red start' EXIT  # remove if the repair needs it stopped
  i=0; while pgrep -f '[n]ode-red' >/dev/null 2>&1 && [ "$i" -lt 30 ]; do sleep 1; i=$((i + 1)); done
  pgrep -f '[n]ode-red' >/dev/null 2>&1 && die "Node-RED still running - no raw copy"
  cp -a /data/db/farming.db "$BK/farming.db" || die "primary DB backup failed"
  for f in farming.db-wal farming.db-shm farming.db-journal; do
    if [ -e "/data/db/$f" ]; then
      cp -a "/data/db/$f" "$BK/$f" || die "$f copy failed"
    fi
  done
}
if command -v sqlite3 >/dev/null 2>&1; then
  # ONLINE backup via sqlite3 .backup (WAL-consistent while Node-RED writes). The
  # output is one self-contained file: do not copy the live -wal/-shm next to it.
  sqlite3 -cmd ".timeout 5000" /data/db/farming.db ".backup '$BK/farming.db'" || raw_copy_stopped
  # Same check as scripts/pi/backup-pre-deploy.sh: the copy must pass integrity_check.
  INTEG=$(sqlite3 "$BK/farming.db" "PRAGMA integrity_check" 2>&1) || true
  [ "$INTEG" = "ok" ] || die "backup integrity_check failed: $INTEG"
else
  raw_copy_stopped
  echo "WARN: no sqlite3 - integrity unchecked"
fi
# Required files: -L stores the target's bytes, never a link, and a dangling
# link fails the copy. The backup must be a regular file equal to its source.
copy_required() {  # source, destination, name
  cp -aL "$1" "$2" || die "$3 copy failed"
  [ -f "$2" ] && [ ! -L "$2" ] || die "$3 backup is not a regular file"
  cmp -s "$1" "$2" || die "$3 backup differs from its source"
}
# flows.json is a SYMLINK through /srv/node-red/payloads/active into payloads/<stamp>.
copy_required /srv/node-red/flows.json "$BK/flows.json" flows.json
[ -s "$BK/flows.json" ] || die "flows.json backup is empty"
copy_required /srv/node-red/settings.js "$BK/settings.js" settings.js
copy_required /srv/node-red/flows_cred.json "$BK/flows_cred.json" "flows_cred.json (MQTT credentials)"
# The GUI dir is a symlink into payloads/<stamp>; -L also copies the targets of
# links inside it, and a dangling link inside it fails the copy.
[ -d /usr/lib/node-red/gui ] || die "no /usr/lib/node-red/gui directory"
mkdir -p "$BK/gui" || die "cannot create $BK/gui"
cp -aL /usr/lib/node-red/gui/. "$BK/gui/" || die "GUI copy failed"
[ -n "$(ls -A "$BK/gui")" ] || die "GUI backup is empty"
GUI_LINKS=$(find "$BK/gui" -type l) || die "cannot scan the GUI backup"
[ -z "$GUI_LINKS" ] || die "GUI backup still contains symbolic links"
# Optional reference copy, NOT a rollback copy (see above).
if [ -e /srv/chirpstack/chirpstack.sqlite ]; then
  cp -aL /srv/chirpstack/chirpstack.sqlite "$BK/chirpstack.sqlite.raw" \
    || die "chirpstack.sqlite.raw copy failed"
  # With a WAL journal, committed data can sit in the -wal file: keep it too.
  for ext in -wal -shm; do
    [ -e "/srv/chirpstack/chirpstack.sqlite$ext" ] || continue
    cp -aL "/srv/chirpstack/chirpstack.sqlite$ext" "$BK/chirpstack.sqlite.raw$ext" \
      || die "chirpstack.sqlite$ext copy failed"
  done
  echo "NOTE: chirpstack.sqlite.raw is a raw copy, not a rollback copy"
else
  echo "NOTE: no chirpstack.sqlite on this gateway; not copied"
fi
echo "Backup at $BK"
ls -la "$BK"
```

The script checks copy-command completion, compares the flows, settings and
credential files with their sources, and requires those three backups to be
regular files rather than links. It also requires nonempty flows and GUI copies
and a GUI tree without symbolic links. It does not compare each GUI file with
its source. The farming database follows the backup and integrity-check
branches above; `chirpstack.sqlite.raw` remains an unqualified reference copy.

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

## Foreign-numbered ledger recovery

`AGENTS.md` ("Live-deploy safety rules") keeps the rule lines; this section holds
the long form that moved out of it on 2026-10-22 and carries the same authority.

A gateway that ran one of the two customer lines (one valve-focused, one not) has
`schema_migrations` rows numbered under that branch's own scheme, which can collide
with main's numbering (e.g. v22 is `journal_catalog_v2` on the non-valve customer
line, `valve_control` on main) — `applyPending` correctly refuses on the checksum
mismatch (`repair_required`), and `deploy.sh` aborts before the payload flip, but
the device is then wedged with no forward path.

`node scripts/reconcile-ledger-numbering.js <db> --report` (dry run; add `--apply`
plus `--backup-dir` to act) is the ONLY sanctioned recovery: it proves, row by row,
that a foreign-numbered ledger entry's content is exactly what some main migration
already delivers — either byte-identical, or identical after stripping the leading
`-- NNNN:` header comment and structurally proving equal schema effect via
`scripts/semantic-schema-compare.js` — before rewriting that row's
`version`/`name`/`checksum` to match main. It refuses on any unproven, unknown, or
ambiguous row and touches nothing when it refuses.

`deploy.sh`'s `run_schema_migration()` calls it automatically (between the ledger
inspection and `migrate-cli.js`) whenever any applied ledger row above version 21
has a checksum that disagrees with main's `CHECKSUMS.json`; a main-numbered
gateway's checksums already agree there and never triggers it.

`--clear-repair-required` is the narrower, separate recovery for a row already
stuck `repair_required` whose checksum, at its own current version, already matches
main (e.g. a prior reconcile run committed the remap but crashed before the status
flip) — it never clears a row whose checksum still disagrees. Never hand-edit
`schema_migrations` outside these two sanctioned tools.

### A deploy cut after the renumber (#759)

The reconcile commits on its own, before the first migration. After it, the
ledger is out of order: a gateway whose old line shipped main's 0084 as its
own 81 holds `…,80,84` while 81 to 83 are still pending. What a cut leaves:

| Cut | What the gateway does | Next step |
|---|---|---|
| Signal (SSH drop, Ctrl-C, TERM) or a refusal before the first migration commits, including during the reconcile itself | the previous payload runs again. A cut while the reconcile itself runs also prints `NOTE: the ledger numbering reconciliation renumbered ledger rows only`; after it, the deploy reports the usual return to the payload it found | run the 0.9 deploy again |
| Power cut before the first migration commits | the old payload starts, state `unverified` (`recorded for schema 81, the database is at schema 84`) | run the 0.9 deploy again |
| Power cut after a migration committed, before the last | the old payload starts `unverified` ("cut during its migration"), or the boot holds when a stamped new body would be undone by the old boot node | run the 0.9 deploy again |
| Signal after a migration committed | held, Node-RED stopped (as on an in-order ledger) | run the 0.9 deploy again |
| Cut after the last migration | the boot switches forward to the new payload | run the 0.9 deploy again for the owed health check |

A migration committed without its fingerprint stamp is drift the retry
explains itself: the runner rebuilds the reference from the applied set
(reference of the contiguous prefix, plus the out-of-order versions), finds the
live schema equal to it, restamps and continues. It refuses instead when an
out-of-order migration touches an object a lower migration also touches
(`ran out of version order and touches …`): the reference cannot follow the
order the gateway ran them in. For 0.9 no such pair exists. On the first retry that
reference chain is built on the gateway and takes minutes (211 s for the 0.9
chain on a 16-core workstation, longer on a Pi). Do not interrupt it.

**Answer a failed 0.9 deploy with the 0.9 deploy, never with an older
release.** The older line's own `migrate-cli` sees its 81 missing (it is now
84), runs it again, fails on the trigger that already exists, and leaves a
`failed` row 81 beside the applied 84. Every later main deploy's reconcile then
refuses (`version slot 84 is claimed by 2 ledger rows`), and no sanctioned tool
clears a `failed` row.

Restamp by hand only when the deploy at hand still refuses with `schema drift
detected before applying migrations` on such a gateway: a deploy tree from
before this fix, or drift the runner could not explain. Confirm the live schema
first, on a copy, with a deploy tree that contains the fix:

1. Take the pre-repair backup ("Pre-repair backup script" above) and pull its
   `farming.db` to the operator machine.
2. On the copy: `sqlite3 copy.db 'PRAGMA integrity_check'` prints `ok`, and
   `sqlite3 copy.db "SELECT version, status, app_version FROM schema_migrations WHERE version > 78 ORDER BY version"`
   shows the renumbered row (`reconcile-ledger-numbering`) and the committed
   main rows, no `failed` or `repair_required` row.
3. On the copy: `node scripts/migrate-cli.js copy.db --backup-dir <scratch> --migrations-dir database/migrations/ordered`,
   then `node scripts/verify-head-cli.js copy.db`. Both succeed only when the
   live schema equals what its applied migrations make when run in version
   order, as `scripts/semantic-schema-compare.js` compares schemas (column
   position is not compared), apart from the triggers the boot node rewrites.

If step 3 succeeds, deploy that tree to the gateway; it repeats the same check
and needs no restamp. If you must keep the older tree, step 3's success is the
confirmation `node scripts/restamp-fingerprints.js /data/db/farming.db` needs
("Stale-fingerprint recovery" above), followed by the deploy again. If step 3
refuses, the schema differs from that version-order reference, or the order
check above refused; either way the copy does not prove the schema. A correct
database can refuse here when the order the gateway ran its migrations in
matters. Do not restamp: a restamp would record an unproven schema as the
baseline. Stop and escalate with the copy.

### Rehearsing that cutover on a copy

`node scripts/rehearse-ledger-cutover.js --db <pulled copy> --work <scratch directory>`
runs, on a copy only, the same chain deploy.sh runs for such a gateway (reconcile
`--report`, `--apply`, `migrate-cli.js`, `verify-head-cli.js`), then the
devices-rebuild rehearsal twice, the shipped boot node with the gateway's EUI,
`integrity_check`/`foreign_key_check`, a schema comparison against `seed-blank.sql`,
and per-table row counts and content hashes before and after; a second pass on the
result must change nothing. Row changes the migrations make by design are listed in
its `EXPECTED_CHANGES`; any other change fails. It refuses paths under `/data/db`
and a non-empty `--work` it did not create, and writes
`<work>/rehearsal-report.json` with every step's result and duration.

---

## Live-repair recipes

### Stale `.chirpstack.env` overriding runtime identity

`/srv/node-red/.chirpstack.env` can carry a stale `DEVICE_EUI*` value that overrides
the runtime identity even after UCI has been corrected. During an identity repair,
remove or regenerate this file so the helper/UCI path (canonical, uppercase EUI)
is what actually takes effect. **Save a copy first**: the same file carries the
`CHIRPSTACK_APP_*`/`CHIRPSTACK_PROFILE_*` values, and `CHIRPSTACK_PROFILE_LORAIN`
reaches the Node-RED runtime ONLY through this file (`node-red.init` does not
export it from UCI) — a regenerated env missing it silently breaks LoRain ingest
until the ChirpStack bootstrap rewrites the file. Full flag semantics and where
this file's other variables come from: `osi-config-and-flags`.

### Credential env-file refusal: exit 74 with `UNSAFE_ENTRY`

`chirpstack-bootstrap.js` exits `74` and prints `Credential env-file operation
failed {...}` on stderr when it refuses a credential file; `deploy.sh` stops with
the same status. On first boot `osi-bootstrap` logs only `bootstrap failed, will
retry next boot` (`logread -e osi-bootstrap`). The JSON diagnostic went to the
init script's stderr and is not in `logread`, and every later boot fails the
same way.

One cause has a known repair. The writer creates a missing file by `link()`ing
a flushed staging copy into place and then `unlink()`ing the staging name. A
crash or power cut between the two leaves the published file complete but with
a second link in its staging directory:
`/srv/node-red/..chirpstack.env.tmp-XXXXXX/env` (first-boot provisioning of
`.chirpstack.env`) or `/srv/node-red/..chirpstack.env.pre-gen2.tmp-XXXXXX/env`
(the deploy's first Gen2 recovery backup). The writer refuses any credential
file with more than one link, so the refusal repeats until the leftover is gone.

1. Reproduce the diagnostic with the file-only check. It reads and narrows
   the two env files and makes no ChirpStack call. Pick a writer that supports
   the flag: an older image's ROM copy ignores unknown flags and runs a full
   provisioning pass.
   ```sh
   S=
   for f in /usr/share/node-red/chirpstack-bootstrap.js /srv/node-red/chirpstack-bootstrap.js; do
     if [ -z "$S" ] && [ -f "$f" ] && grep -q -- '--secure-env-file' "$f"; then S="$f"; fi
   done
   echo "writer: ${S:-none}"
   [ -n "$S" ] && node "$S" --secure-env-file; echo "exit=$?"
   ```
   No writer means the `74` came from somewhere else; stop. This recipe
   applies when the diagnostic reads `"reason":"UNSAFE_ENTRY"`; current
   writers add `"linkCount":2,"stagingLeftover":true` for this case. Other
   reasons have other causes: `ROOT_REQUIRED` (not run as root),
   `SNAPSHOT_CHANGED` (a concurrent writer), `OS_ERROR` with an `osCode` such
   as `ENOSPC` or `EROFS` (fix the filesystem, then rerun).
2. Inspect both credential entries and every staging directory. In `ls -li`
   output the first column is the inode number and the third the link count.
   ```sh
   ls -lid /srv/node-red/.chirpstack.env /srv/node-red/.chirpstack.env.pre-gen2
   ls -lid /srv/node-red/..chirpstack.env*.tmp-*
   ls -lia /srv/node-red/..chirpstack.env*.tmp-*/
   ```
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
4. Rerun the step that failed. After a deploy, rerun `deploy.sh`. After a
   first-boot failure, `.chirpstack.env` already holds the API key the failed
   run created; pass it in so the rerun does not create a second key (#181):
   ```sh
   rm -f /etc/osi-bootstrap.done && CHIRPSTACK_API_KEY="$(sed -n 's/^CHIRPSTACK_API_KEY=//p' /srv/node-red/.chirpstack.env | head -1)" /etc/init.d/osi-bootstrap start
   ```

A staging directory that is empty, or whose `env` has link count 1, comes from
an interruption before publication or after a rename. It does not block later
runs, and the writer leaves its contents root-owned mode `0600` inside a mode
`0700` directory. An unpublished `env` from a first-boot run can hold the only
copy of the key that run created, so keep it until the gateway provisions
cleanly, then remove it the same way.

### Legacy device foreign-key repair

Deploy and migration preflights refuse exact `devices_old` tokens in tables,
triggers, indexes and views, including ambiguous literals/comments. A missing
main file with any WAL, SHM, journal or repair lock is recovery evidence, never
a fresh install. Keep it intact. The check applies no database repair or
migration; SQLite may create/rebuild the WAL index (`-shm`). Earlier deploy
phases may have installed packages or staged files. Field count: **unknown**.

Use the complete reviewed checkout, including `scripts/lib/`, `lib/osi-migrate/`
and the approved `database/` corpus. The repair uses the shipped SQLite CLI on
Node 20.18.3, with one persistent CLI connection per transaction; it needs no
`node:sqlite` or extra native binding. Both profile configurations ship the CLI and use the BusyBox defaults with
mkfifo enabled.
Prove the local CLI, FIFO transport, FK introspection and lossless integer
transport before stopping services. A missing capability refuses before downtime.

The supported repair is the shipped schema with legacy FK-reference damage,
including mixed quoted, unquoted, bracketed and lowercase references. Unknown
objects (including unrecognized views), older schemas, divergent ledgers, any
surviving old parent and orphaned data refuse. There is no migration or 0083.
Never restart the old healer to bypass a refusal.

1. Obtain authorization for the named gateway and verify the reviewed checkout.
   Check recovery availability, then take a strict online backup while services
   are still running. Use a timestamped directory under an existing private
   backup parent:

   ```sh
   node scripts/repair-legacy-device-fk.js --check-runtime
   BK=/data/db/backups/osi-os-$(date +%Y%m%d-%H%M%S)
   node scripts/repair-legacy-device-fk.js /data/db/farming.db --backup-online --backup-dir "$BK"
   ```

   This EB19 path requires an existing main database, successful SQLite `.backup`
   and `integrity_check` returning `ok`. It copies flows, settings, credentials
   and GUI into the same backup set and fsyncs it. It never falls back to raw
   database copying, stops a service or arms an automatic restart trap. Do not
   substitute the generic pre-repair backup script here. Any failure retains the
   partial backup and receipt, exits nonzero and requires investigation before
   proceeding; a printed directory alone is not backup acceptance.

2. The gateway must already have the `node-red` and `osi-identityd` init scripts.
   Images without identityd need a separately qualified recovery; never bypass
   preparation. Make the stopped-writer state survive a reboot **before**
   stopping services:

   ```sh
   node scripts/repair-legacy-device-fk.js /data/db/farming.db --prepare-offline
   /etc/init.d/osi-identityd stop
   /etc/init.d/node-red stop
   ubus call service list '{"name":"osi-identityd"}'
   ubus call service list '{"name":"node-red"}'
   ```

   Preparation durably records both services' prior enablement under
   `/data/db/farming.db.osi-recovery/`, disables autostart through
   the installed init scripts, fsyncs the rc.d directory and verifies no start
   link remains. This covers the old software already installed: its boot entry
   is no longer selected by OpenWrt rcS. Pending first-boot scripts that could
   enable these services refuse preparation. Preparation does not stop them.
   An incomplete preparation retains its receipt for investigation; do not guess
   prior enablement or delete the hold. This is the same recovery marker that
   boot integrity, factory seeding and deployment honor. A generic integrity
   recovery marker is not an EB19 receipt and cannot authorize this repair.
   Historical EB19 lock or writer-hold names also refuse and require receipt
   inspection. Apply on the gateway rechecks the durable
   hold as well as procd and open file handles. Stop other writers too. A separate
   privileged actor must not start or enable services during recovery.

3. With all writers stopped, checkpoint and close SQLite normally:

   ```sh
   sqlite3 /data/db/farming.db 'PRAGMA wal_checkpoint(TRUNCATE);'
   ls -l /data/db/farming.db /data/db/farming.db-wal /data/db/farming.db-shm /data/db/farming.db-journal
   ```

   Missing sidecars are expected. If any remains, investigate; never delete it
   to pass a gate. For physical damage, use the damaged-database runbook before
   checkpointing. Set persistent scratch and allow at least four database sizes
   for working pages, independent originals and backups, plus filesystem margin:

   ```sh
   WORK=/data/db/backups/legacy-device-fk-work-$(date +%Y%m%d-%H%M%S)
   mkdir -m 700 "$WORK"
   export TMPDIR="$WORK"
   df -h /data/db "$TMPDIR"
   node scripts/repair-legacy-device-fk.js /data/db/farming.db --report
   ```

   Report rebuilds only disposable scratch and checks data eligibility, including
   FKs, before accepting a shape. It changes no source data. An orphan refuses
   and rolls the scratch transaction back. Do not treat shape recognition alone
   as proof that the data can be repaired.

4. If report returns `dataEligible:true`, apply with a new persistent backup set:

   ```sh
   REPAIR_BK=/data/db/backups/legacy-device-fk-$(date +%Y%m%d-%H%M%S)
   node scripts/repair-legacy-device-fk.js /data/db/farming.db --apply --writers-stopped --backup-dir "$REPAIR_BK"
   ```

   Rebuilds run on a private copy with FK fencing. FK checks must pass inside
   the transaction before COMMIT and again afterwards. Complete row, column,
   rowid and sequence witnesses must match. Existing computed fingerprints are
   refreshed on the proven copy; ledger rows remain unchanged. Before atomic
   publication, the tool fsyncs the verified candidate and backup and preserves
   an **independent copy** at `original.db`, with a durable receipt. It never
   hard-links the source to retained evidence. Keep the writer hold in place.

5. Verify the database, then deploy the reviewed retirement payload and complete
   its acceptance checks. Deployment preserves the hold and suppresses identityd
   enablement, including the pending UCI default. It permits a bounded Node-RED
   health start only after checking the installed retirement flow and the repaired
   database. A compatible older payload containing the surgery cannot restart.
   A recovery hold defers owed health checks until the new checker and init are
   installed, so a first deployment never uses an old checker for that proof.
   After the check, or on any deploy failure, both writers remain stopped; reboot
   cannot undo the hold. Only after a successful deploy, release the hold from
   a complete checkout at the **same revision as the retirement deploy**. A
   mismatched checkout refuses safely and leaves the hold in place:

   ```sh
   sqlite3 -readonly /data/db/farming.db 'PRAGMA integrity_check; PRAGMA foreign_key_check;'
   node scripts/repair-legacy-device-fk.js /data/db/farming.db --report
   # Run the reviewed deploy and its acceptance checks here.
   node scripts/repair-legacy-device-fk.js /data/db/farming.db --release-hold
   ```

   Expect `ok`, no FK rows and `needed:false`. Release refuses an incomplete
   repair lock, an installed flow still containing the boot surgery, failed
   integrity/FK checks or an unverified ledger/fingerprint head. It restores
   exactly the recorded service enablement and archives the hold receipt. It
   consumes only the reviewed pending identityd enable script so it cannot later
   override a service that was originally disabled. An unknown script refuses.
   Release does not start services. Start the required services explicitly after
   release, repeat the health check, and leave originally disabled services
   disabled. Keep all backups and
   receipts through acceptance. Do not bypass a remaining schema refusal.

An interrupted repair retains `/data/db/farming.db.legacy-device-fk-repair.lock`.
Its `stage` file names the receipt and private evidence directory. **Keep the
writer hold and services stopped across reboot.** Do not rerun report against a
locked source: inspect the receipt directly. Before publication the path retains
original bytes; after it, the path contains the original or verified candidate.
Caught errors before the durable published receipt attempt restoration from an
independent copy, retaining both versions. Errors after that boundary retain the
verified replacement and exit nonzero for inspection.

Compare the receipt's phase, original/candidate hashes and actual file hashes.
Verify integrity and FKs on a candidate before choosing it. An absent receipt,
different hashes or ambiguous paths require escalation. Have the recovery state
reviewed and authorize its disposition before clearing a stale lock. Never patch
`sqlite_master`, enable `writable_schema`, drop an old parent, install a seed,
hand-stamp fingerprints or force deploy past a refusal. A missing main file with
sidecars or a lock is not permission to create one.

### Changing DEVICE_EUI and linked offline login

Only accounts with `auth_mode = 'server'` (linked to the cloud) use the offline
verifier. A local account compares its password against its own
`password_hash`, and the EUI does not affect it. For a linked account,
`auth-process-result` in `flows.json` decides as follows:

- **A stored verifier.** When `server_offline_verifier` is not blank, the node
  builds a subject with `verifierSubject` in
  `osi-installation-helper/index.js` and compares it against that bcrypt hash.
  The stored `server_offline_verifier_version` selects the subject; missing,
  NULL or 0 is read as 1.
  - **Version 2 and higher:** `password::<installation UUID>`. The UUID comes
    from the gateway's single `installation_identity` row (the login query
    selects it with `singleton_id = 1`; it is not a `users` column). It is
    trimmed and lowercased and must have the version-4 UUID shape. A change of
    EUI alone does not change this subject.
  - **Below 2:** `password::<EUI>`. The EUI is the first valid value of, in
    order, `LINK_GATEWAY_DEVICE_EUI` (from UCI
    `osi-server.cloud.link_gateway_device_eui`), the `gateway_device_eui`
    inside the stored sync token, and `DEVICE_EUI`. Valid means 16 hex digits
    after separators are removed and the value is uppercased, other than
    `0101010101010101`, or a 12-digit MAC, which is expanded with `FFFE` in
    the middle. The subject follows that effective EUI, so a login fails when
    the effective EUI no longer matches the EUI the cloud hashed. While an
    earlier source holds a valid EUI, a different `DEVICE_EUI` does not change
    the subject.
- **The subject cannot be built.** A version 2 row whose installation UUID is
  missing or malformed, or a version 1 row with no valid EUI from any of the
  three sources, makes `verifierSubject` throw. The node logs a warning and
  falls back to `server_password_hash`: the login succeeds only if that column
  holds a hash that matches the password. Account link (`al-link-finalize`)
  and an applied `SYNC_LINKED_AUTH` (`cs-reg-cloud-fn`) set that column to
  NULL, so rows they wrote are refused. A row neither writer has updated, for
  example because every later auth sync was ignored as stale or already
  applied, can still hold a usable hash.
- **A valid subject that does not match the stored verifier.** The login is
  refused. This case has no fallback.
- **No stored verifier** (NULL or blank): the node checks
  `server_password_hash` directly, with the same rule as the fallback above.

The cloud computes the verifier and the gateway stores it. Account link
(`al-link-handle-auth`, then `al-link-finalize`) and the `SYNC_LINKED_AUTH`
command (`cs-reg-cloud-fn`, for example after a cloud password change) store
the cloud's `offlineVerifier` and `offlineVerifierVersion`. In osi-server,
`LocalSyncService` issues version 2, bound to the installation UUID, when the
link request reports `installation_recovery_v1`, and version 1, bound to the
gateway EUI, otherwise. A password change through `LinkedGatewaySyncService`
issues `max(current, 2) + 1` for an installation-bound account and 1 for an
EUI-bound one. The version is therefore both the subject selector and an
ordering counter. `cs-reg-cloud-fn` ignores an incoming version below the
stored one (`STALE_IGNORED`), leaves an equal version with the same hash
alone (`ALREADY_APPLIED`), and stores the incoming hash for an equal version
with a different hash or for a higher version.

**This runbook has no manual procedure for a linked offline verifier.** Its
supported writers are account link and cloud auth sync. Do not construct a
linked verifier yourself, and do not overwrite `server_offline_verifier` or
`server_offline_verifier_version` as a repair. A hand-written subject or
version that differs from what the login expects refuses the login. A
hand-written version above the one the cloud issues next makes
`cs-reg-cloud-fn` ignore that later cloud update as stale. A password typed
into a command line lands in process arguments and can land in shell history.
None of this concerns a local account's own `password_hash`.

To see which case applies, inspect read-only. These queries print no password,
hash or token:

```sh
sqlite3 /data/db/farming.db "SELECT username, server_username, server_offline_verifier_version, COALESCE(TRIM(server_offline_verifier), '') <> '' AS has_verifier, server_password_hash IS NOT NULL AS has_fallback_hash FROM users WHERE auth_mode = 'server';"
sqlite3 /data/db/farming.db "SELECT installation_uuid FROM installation_identity WHERE singleton_id = 1;"
```

This section explains linked login. It is not an EUI transition procedure and
does not tell you to set `osi-server.cloud.device_eui`, restart Node-RED or
rewrite `irrigation_zones` rows. Live gateway identity belongs to
`osi-identityd`, which resolves, repairs and re-resolves the identity,
persists it, checks the durable readback and owns the coordinated Node-RED
restart: `docs/sync/gateway-identity-convergence.md`, and for the configuration
side `osi-config-and-flags` (`references/uci-and-identity.md`). Setting one UCI
key does not decide the effective identity, because the resolver takes the
concentrator runtime and configuration and the linked value before the
persisted `cloud.device_eui`.

If a linked login fails, stop and ask the operator (SKILL.md, "Never reset
credentials to unblock yourself"). Unlink and re-link is an account operation,
not a credential shortcut: `al-unlink-db` returns the account to local mode and
clears the stored verifier, its version and the sync token, so it needs the
operator's consent.

### Stop an unlinked gateway reporting to the cloud

Use this on a gateway whose firmware predates the #766 fix (0.8.4 and
earlier, and 0.9 builds without it). On those gateways an unlink
(`DELETE /api/account-link`, the GUI's disconnect button) clears UCI
`osi-server.cloud.mqtt_password`, but the gateway keeps reporting:

- MQTT: `node-red.init` writes the "OSI Cloud Broker" credentials into
  `/srv/node-red/flows_cred.json` when a password is set and never removes
  them. With the broker settings empty it falls back to the default cloud
  broker, and the node connects with the old credentials. A restart or a
  reboot changes nothing.
- REST: unlink clears only the calling account's row in `users`. If a second
  local account was linked, the sync nodes keep posting to the cloud with
  that row's token.

From the fix on, unlink clears every account row, the gateway refuses cloud
sync requests and MQTT messages while unlinked, and `node-red.init` removes
the credentials and exports the broker's auto-connect as off. Updating the
gateway is the lasting repair; this procedure is the manual fallback.

**Check first** (read-only; prints no secret):

```sh
uci -q get osi-server.cloud.mqtt_password >/dev/null && echo "STOP: mqtt_password is set (still linked?)" || echo "mqtt_password absent"
node -e 'const fs=require("fs"); const c=JSON.parse(fs.readFileSync("/srv/node-red/flows_cred.json","utf8")); if (Object.prototype.hasOwnProperty.call(c,"$")) { console.log("STOP: flows_cred.json is encrypted; this procedure cannot read it"); process.exit(1); } const id=JSON.parse(fs.readFileSync("/srv/node-red/flows.json","utf8")).find(n=>n.name==="OSI Cloud Broker").id; console.log("cloud broker entry:", c[id] ? "present" : "absent", "| other entries:", Object.keys(c).filter(k=>k!==id).length)'
sqlite3 -readonly /data/db/farming.db "SELECT username FROM users WHERE server_url IS NOT NULL OR server_sync_token IS NOT NULL OR auth_mode <> 'local'"
logread | grep "OSI Cloud Broker" | tail -2
```

Go on only if the account page (or `GET /api/account-link/status`) shows the
gateway unlinked and `mqtt_password` is absent. Step 2 applies when the
cloud broker entry is present. Step 3 applies when the `users` query lists an
account. Other credential entries (another broker's) stay as they are.

A `STOP: flows_cred.json is encrypted` line means Node-RED saved the file
with a credential key, which happens only after a deploy from the Node-RED
editor (field repair). This procedure does not handle that file; escalate.

1. Take the pre-repair backup (script above). It copies `flows_cred.json`,
   which holds the old device password: delete the backup once step 5 has
   passed.

2. Remove only the cloud broker entry. The script refuses an encrypted file,
   then writes a temporary file in the same directory with mode 0600, flushes
   it and renames it over the original, so a power cut leaves the old or the
   new file, never a partial one:

   ```sh
   node -e '
     const fs = require("fs"), path = require("path");
     const file = fs.realpathSync("/srv/node-red/flows_cred.json");
     const creds = JSON.parse(fs.readFileSync(file, "utf8"));
     if (Object.prototype.hasOwnProperty.call(creds, "$")) { console.log("STOP: flows_cred.json is encrypted; nothing changed"); process.exit(1); }
     const id = JSON.parse(fs.readFileSync("/srv/node-red/flows.json", "utf8")).find(n => n.name === "OSI Cloud Broker").id;
     if (!creds[id]) { console.log("no cloud broker entry; nothing to do"); process.exit(0); }
     delete creds[id];
     const tmp = file + ".unlink-" + process.pid;
     const fd = fs.openSync(tmp, "wx", 0o600);
     fs.writeSync(fd, JSON.stringify(creds)); fs.fsyncSync(fd); fs.closeSync(fd);
     fs.renameSync(tmp, file);
     const dir = fs.openSync(path.dirname(file), "r"); fs.fsyncSync(dir); fs.closeSync(dir);
     console.log("cloud broker entry removed; remaining entries:", Object.keys(creds).length);
   '
   ```

3. For each account the `users` query listed, the farmer signs in as that
   account on the gateway's account page and presses the disconnect button.
   That is the shipped unlink: it clears the account's link and its
   linked-login data through the supported writer. This runbook has no
   manual procedure for the offline verifier (rule 4), so do not clear these
   rows by hand. The account then signs in with its local password.

4. Restart Node-RED so it drops the connection: `/etc/init.d/node-red restart`.

5. Verify:
   - On the gateway: `ls -l /srv/node-red/flows_cred.json` shows
     `-rw-------` root. The "Check first" listing shows the cloud broker
     entry absent, and the `users` query lists no account.
     `logread | grep "OSI Cloud Broker" | tail -3` shows no new
     `Connected to broker` after the restart.
   - In the cloud, as the account the gateway was linked to: the gateway's
     "last seen" stops advancing within two minutes of the restart. Watch it
     for 10 minutes.

Expected after the restart: the broker node keeps trying about every 15 s and
logs `Connection failed to broker` each time (about 40 lines in 10 minutes)
until the gateway is linked again or updated to firmware with the fix.

Undo: restore `flows_cred.json` from the backup, then restart Node-RED.
Linking the gateway again from the account page writes fresh credentials and
link fields either way.

The cloud still lists the gateway under the account after this procedure.
To remove it there, unlink it in the cloud as well.

Tested so far: steps 1, 2, 4 and 5 on a 0.8.4 test board (23 Nov 2026), where
"last seen" stayed put for the 10 minutes after the restart and a reboot
before step 2 had not stopped the reporting. Step 3 uses the shipped unlink.

### ChirpStack v4 has no plain REST API

ChirpStack v4.x is gRPC-web only; `curl http://127.0.0.1:8080/api/...` 404s
regardless of payload. To inspect or change ChirpStack config on a live Pi:

- **Read:** `sqlite3 /srv/chirpstack/chirpstack.sqlite "SELECT ...;"`
- **Write:** the pre-repair backup script above makes no rollback copy for this
  write and refuses with `NEED_CHIRPSTACK=1`. This runbook has no reviewed
  procedure for one, so do not start a write on the strength of that backup.
  The mechanics: stop ChirpStack first (the DB is locked while it runs), modify
  via `sqlite3`, then start it again:
  ```bash
  /etc/init.d/chirpstack stop
  sqlite3 /srv/chirpstack/chirpstack.sqlite "UPDATE ... ;"
  /etc/init.d/chirpstack start
  ```

### ChirpStack journal after a package upgrade

Run `sh scripts/pi/chirpstack-sqlite-wal.sh --check` (read-only) to see the
gateway's journal state and configured pragmas. An `opkg` upgrade to a
`chirpstack` package whose init lacks the locally added pragmas replaces
`/etc/init.d/chirpstack` and silently drops the 5 s busy wait; the database
stays WAL. The current OSI feed init already carries these pragmas. After
an upgrade, re-run `--check`, then `--apply` if it reports missing pragmas.

Backup, restore and the one-shot share `/srv/backup/.chirpstack-maintenance.lock`.
Restore reports every retained `.pre-restore-*` original. After verified success
it keeps only the newest generation; incomplete recovery keeps all generations
and the lock. Printed recovery commands can be rerun after a partial failure and
release the lock only after a checked restart. Use the phase-specific recovery
action printed for a stale one-shot lock; helper-only recovery never stops
ChirpStack. A successful new backup archives legacy flat files under
`/srv/backup/chirpstack-legacy-*` so released downgrade helpers cannot copy stale
data over the live files.

### ChirpStack backup and restore helpers (LuCI buttons)

`/opt/chirpstack/backup.sh` and `restore.sh` run from the LuCI backup and restore
buttons. Read their whole output, not only the last line: a run can print
several outcome lines (`OK: ...`, `ERROR: ...`, `ROLLED BACK: ...`,
`RECOVERY: ...`, `ERROR: ROLLBACK INCOMPLETE`), and a later line can change what
an earlier one means.

- **A reported failure means the outcome is unconfirmed, not that nothing
  changed.** A `ROLLED BACK: ...` line confirms that the original files are
  back only if no later line reports `original live set unverified` or
  `ROLLBACK INCOMPLETE`; the helper verifies them before it restarts the
  services.
- **An `ERROR:` without `ROLLED BACK:`** can follow a restore that already
  replaced the live files and restarted both services, when the final cleanup
  (temporary sets or the maintenance lock) fails. Check which data ChirpStack
  and Redis are serving before you act on it.
- **`RECOVERY: original inventory verified; services remain stopped`:** the
  original files are in place and unchanged. The helper does not probe the
  services before printing this, so check that ChirpStack and Redis are both
  stopped, then retry `restore.sh`.
- **After `ROLLBACK INCOMPLETE`,** the helper does not start the services, but a
  failed stop can leave one running. Check that both ChirpStack and Redis are
  stopped before you touch any live file, then follow the printed recovery steps
  exactly before you start anything.
- **v0.8.3 limit:** a restore that fails before it moves the first live file
  restarts ChirpStack and Redis on the files they had before the attempt,
  without first verifying them. Later helpers verify them first; one remaining
  case (a failed restart that checkpoints the WAL) is tracked in #693.

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

### Native sqlite3 rollback folders block deploy or the seed

`deploy.sh` and the first-boot seed (`/etc/uci-defaults/98_osi_node_red_seed`)
both replace the Node.js `sqlite3` module (not the `sqlite3` CLI) at
`/srv/node-red/node_modules/sqlite3` by moving the old entry into a rollback
folder first. Each tool recovers only its own folder, and only in states it can
prove. Anything else is kept and refused on every run until an operator clears
it:

- `deploy.sh` stops before its first write with `ERROR: seed sqlite3 rollback
  present`, `ERROR: unowned sqlite3 rollback entry`, `ERROR: ambiguous sqlite3
  rollback entry`, `ERROR: sqlite3 rollback owner metadata is incomplete beside
  an owned final`, or a message ending in `preserving both` or `preserving both
  for inspection`.
- The seed exits 1 at boot. OpenWrt deletes a uci-defaults script only when
  it exits 0, so `/etc/uci-defaults/98_osi_node_red_seed` still present after
  boot means the seed refused or asked for a retry. A retry clears on the next
  boot; a refusal repeats. The seed copies the image's `osi-*` helpers,
  codecs, `edge-channels.json` and `node_modules` once per image install, at
  its first boot, and records that in `/etc/osi-node-red-seed.copied`; while
  that file exists, the later runs copy nothing, so a deploy made between two
  refusing boots keeps what it installed.

Both tools print `STATE: <kind> <path>` lines for the paths involved, where
`<kind>` is `symlink`, `directory`, `file`, `fifo`, `other` or `absent`.

| Path under `/srv/node-red/node_modules/` | Written by | Holds |
|---|---|---|
| `sqlite3` | both | The module Node-RED loads |
| `.osi-sqlite3-rollback.XXXXXX/` | deploy | `.owner` (`osi-sqlite3-deploy-v2`), `original` (the entry that was at `sqlite3`) |
| `.osi-sqlite3-seed-rollback.XXXXXX/` | seed | `.owner` (`osi-sqlite3-seed-v2`), `.candidate-id`, `original` |
| `.osi-sqlite3-stage.XXXXXX/`, `.osi-sqlite3-seed-stage.XXXXXX/` | deploy, seed | A staged copy; the tool's next run removes it |
| `sqlite3/.osi-sqlite3-candidate-owner` | both | The rollback folder path this candidate belongs to |
| `sqlite3/original` | both | The old module, nested here when a restore found `sqlite3` occupied |

Back up every entry before removing any of them. `cp -a` keeps symlinks as
symlinks:

```sh
NM=/srv/node-red/node_modules
BK=/data/db/backups/osi-os-$(date +%Y%m%d-%H%M%S)/sqlite3-modules
mkdir -p "$BK"
for e in "$NM/sqlite3" "$NM"/.osi-sqlite3-*; do
  [ -e "$e" ] || [ -L "$e" ] || continue
  cp -a "$e" "$BK"/ || { echo "FATAL: backup of $e failed; stop here"; break; }
done
ls -la "$BK"; ls -la "$NM"/.osi-sqlite3-*/ "$NM/sqlite3/"
```

Then check each candidate module: the final path, every `<rollback>/original`,
`sqlite3/original` when present, and the firmware module at
`/usr/lib/node/node-red/node_modules/node-red-node-sqlite/node_modules/sqlite3`.
A candidate is healthy when its version equals the pin and it opens `:memory:`:

```sh
node -p 'require("/usr/share/node-red/package-lock.json").packages["node_modules/sqlite3"].version'  # image pin (seed)
node -p 'require("/srv/node-red/package-lock.json").packages["node_modules/sqlite3"].version'        # last deployed pin
check() { node -p 'require(process.argv[1] + "/package.json").version' "$1" &&
  node -e 'const s = require(process.argv[1]); new s.Database(":memory:", e => { if (e) { console.error(e.message); process.exit(1); } console.log("opens :memory:"); });' "$1"; }
check "$NM/sqlite3"
```

Two power-loss windows end in a refusal even when nothing else went wrong.
Recognise them on disk:

- Deploy cleanup cut after it removed `.owner` and before it removed the
  folder. Deploy stops with `ERROR: sqlite3 rollback owner metadata is
  incomplete beside an owned final`. An empty `.osi-sqlite3-rollback.XXXXXX/`
  sits beside a `sqlite3/` whose marker names that folder. Deploy verified that
  `sqlite3` before the cleanup started; if `check "$NM/sqlite3"` passes, follow
  step 1 below. The seed clears its own form of this state without help.

  ```sh
  ls -A "$NM"/.osi-sqlite3-rollback.*/            # prints nothing
  cat "$NM/sqlite3/.osi-sqlite3-candidate-owner"  # prints that folder's path
  ```

- Removal of a failed candidate cut short. `sqlite3/` is a partial copy
  without its marker, beside a rollback folder that still holds `.owner` and
  `original` (the seed's also `.candidate-id`). Deploy stops with `ERROR:
  sqlite3 final path is not owned by rollback <folder>; preserving both`; the
  seed with `ERROR: unowned final sqlite3 beside retained seed original`.
  `check "$NM/sqlite3"` fails; run `check` on `<folder>/original` and on the
  firmware module to choose between steps 2 and 3.

  ```sh
  ls -A "$NM/sqlite3"                    # no .osi-sqlite3-candidate-owner
  ls -A "$NM"/.osi-sqlite3-*rollback.*/  # .owner and original
  ```

Pick exactly one of these, in this order:

1. The final path is healthy and has no `original` entry. Keep it. Remove the
   rollback and stage folders and the marker:
   `rm -rf "$NM"/.osi-sqlite3-rollback.* "$NM"/.osi-sqlite3-seed-rollback.* "$NM"/.osi-sqlite3-stage.* "$NM"/.osi-sqlite3-seed-stage.*; rm -f "$NM/sqlite3/.osi-sqlite3-candidate-owner"`.
2. The final path is not healthy, or holds `original`, and the firmware module
   is healthy. Remove the same folders and `"$NM/sqlite3"`, then run the
   deploy straight away: its materialisation copies the firmware module into
   place before npm runs. Until then a Node-RED restart has no database
   driver.
3. The firmware module is missing or broken. Put a healthy retained original
   at the final path with `mv` inside `node_modules`, so the checked directory
   moves intact. First move the final path aside to a dot name that neither
   tool scans and npm ignores, then move the original in from where it is:

   ```sh
   [ -e "$NM/sqlite3" ] || [ -L "$NM/sqlite3" ] && mv "$NM/sqlite3" "$NM/.osi-hold-sqlite3"
   mv "$NM/.osi-hold-sqlite3/original" "$NM/sqlite3"      # original was nested in the final path
   # or: mv "$NM/.osi-sqlite3-rollback.XXXXXX/original" "$NM/sqlite3"       # deploy rollback
   # or: mv "$NM/.osi-sqlite3-seed-rollback.XXXXXX/original" "$NM/sqlite3"  # seed rollback
   ```

   Then remove the remaining folders as in step 1 and run the deploy. Remove
   `$NM/.osi-hold-sqlite3` after the deploy prints `OK: require('sqlite3')
   resolves`. If no candidate is healthy, stop: the gateway needs an image
   whose firmware module loads.

Never leave `sqlite3` as a symlink to a retained copy, and never put a version
other than the pin there: npm retires a symlinked `sqlite3` and reinstalls an
off-pin one, which fails on 32-bit ARM with musl where no prebuilt exists.

After clearing, run the deploy. If the seed was refusing, it runs again at the
next boot, finishes its `sqlite3` step, removes `/etc/osi-node-red-seed.copied`
and leaves the deployed helpers, codecs and `edge-channels.json` alone. Do not
delete that file while the seed is still refusing: the next boot would copy
the image over the deployed files. The seed accepts a `sqlite3` that matches
the image pin and opens `:memory:` before it reads the firmware module, so
after step 3 it stops refusing even on an image whose firmware module is
broken.

### Boot stops at the tailscale cleanup

Symptom: after a reboot, SSH and LuCI on the LAN answer, but ChirpStack and
Node-RED never start, `/gui/` is not served, and the serial console shows no
login prompt. `logread` ends at `S80tailscale` lines: `Program starting` for
`tailscaled --cleanup`, and no `flushing log.`

Cause: the gateway runs the tailscale 1.80.3-r1 package init without the OSI
copy, which runs `tailscaled --cleanup` before the daemon with no time limit.
A cleanup that does not return holds every later boot service.

Recovery over LAN SSH, in one line:

```sh
kill -9 $(pgrep -f 'tailscaled --cleanu[p]')
```

The boot then continues with the next `rc.d` script. The bracket keeps the
pattern from matching the shell that runs the line. `pgrep` is part of the
image's BusyBox. Where it is missing, `ps` gives the same pid:

```sh
kill -9 $(ps w | awk '/[t]ailscaled --cleanu[p]/ {print $1}')
```

A cleanup that survives `kill -9` is stuck in the kernel; only a power cycle
ends it.

Afterwards deploy a release that ships the OSI tailscale init (see
`references/deploy.md`, step 12). `readlink /etc/rc.d/S99tailscale` then prints
`../init.d/tailscale`.

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
