# A gateway with a damaged farm database

This is the operator procedure for a gateway whose farm database (`/data/db/farming.db`) is damaged, whether the start-up check or a refused deploy says so. Most of these files were damaged by NEW-15 (#637): on factory images up to v0.8.2, overlapping valve commands left the file malformed. Nothing here runs by itself. Apply it to a gateway only on the owner's word, in one session, from step 1 to the end.

Figures marked `<builder: …>` are measurements the image builder has not yet delivered. Every command is for BusyBox `ash` on the gateway, run as root. Write the session's output into a log you keep.

## Requirements

- **A release that contains both #651 (this fix) and #636.** Until #636 is in a release, a second deploy on a gateway that already had one deploy of v0.8.2 or later stops at `--- Conditional irrigation NTP clock hook ---` with `ERROR: could not record existing clock hook mode` (NEW-27). Do not start this procedure before that release exists.
- Shell access to the gateway, and the deploy method the gateway normally gets: the tunnel from `README.md`, or the bundle from `docs/operations/deploying-over-a-flaky-link.md`.
- Free space on `/data` for at least twice the database's size (step 2).
- The `sqlite3` command-line tool. Our images carry it (`sqlite3-cli`); a stock ChirpStack Gateway OS base has none until the first deploy installs it from the `opkg` feed, in whatever version the feed offers. Check with `sqlite3 -version`. Neither gateway build can run `.recover`; option (b) runs on a workstation (see (b)).

## 1. How to tell

### On a gateway with the fixed release

The start-up check reads the file once, read-only, beside the flows (the state reads `checking` until it answers). A damaged file gives:

- in the gateway log (`logread`), once per start:
  `[osi-db-startup] ERROR farm database start-up check: damaged (<SQLite's first message>); reported only, nothing was changed; see docs/operations/damaged-farm-database.md`
- in `GET /api/system/stats` (logged in): `"database": {"status": "damaged", "health_state": "database_damaged", …}`
- in the heartbeat the cloud receives, from the first tick after the verdict: `"health": {"health_state": "database_damaged", …}`

`database_missing`, `database_unreadable` and `database_missing_core_tables` in the same places also lead here. `database_checking` and `database_not_checked` do not: the check is still reading, or passed its ten-minute bound, or could not run, and the file may be sound. For those, see `farm-database-startup-check.md`.

### On a gateway still on v0.8.x

No check exists there. The signs are in the log only. On the damaged file the one-time scheduler fails every minute, and nothing else says so:

```
[error] [function:Fire due one-time opens] valve-once dispatch failed: SQLITE_CORRUPT: database disk image is malformed
[warn] [function:Fire due one-time opens] [valve-control] one-time dispatch failed for <schedule uuid>: SQLITE_CORRUPT: database disk image is malformed
[error] [function:Observe valve-fired opens + trigger backfill] valve-observe: SQLITE_CORRUPT: database disk image is malformed
```

Look with: `logread | grep -E 'SQLITE_CORRUPT|malformed|osi-db-startup'`

### How a damaged gateway behaves

Measured on a device with two pages of a 103 MiB file overwritten, under the fixed release: the gateway kept answering. The GUI, login, the valve list, zones and schedules answered, and a valve CLOSE was accepted. Requests that read a damaged table fail: there, the device list answered `500 {"error":"device-api failed","message":"Error: SQLITE_CORRUPT: database disk image is malformed"}`. The error line came at every start and the stats answer read `"status":"damaged"`, also after a reboot. Nothing was moved, renamed, restored or deleted. Which requests fail depends on which pages are damaged.

### Files beside the database

| File | What it is | A backup? |
|---|---|---|
| `/data/db/farming.db` | the live database | no |
| `/data/db/farming.db-wal`, `/data/db/farming.db-shm` | the live database's write-ahead log and its index; any read, also the start-up check's, creates them if missing | **never** |
| `/data/db/farming.db.bak-<time>` | a copy taken by a migration | yes |
| `/data/db/backups/<name>/farming.db` | pre-repair and pre-deploy copies | yes |
| `/data/backups/migrate/farming.db.premigrate-<time>` | a copy taken by a deploy before migrating | yes |

A name ending in `-wal`, `-shm` or `-journal` is never a backup, whatever it starts with. Opening a backup read-only with `sqlite3` would create such files beside it, so step 4(a) checks backups on a work copy.

### A deploy refused on a damaged file

Before its migration, `deploy.sh` stops Node-RED, checkpoints the file and checks it. A damaged file ends the deploy with exit 1 and one of three lines, measured on a device as the second:

```
ERROR: failed to checkpoint /data/db/farming.db before migration
ERROR: failed to run integrity_check on /data/db/farming.db before migration
ERROR: /data/db/farming.db integrity_check failed before migration: <first lines of the check>
```

On the measured device the line before it was SQLite's own `Error in 2nd command line argument: database disk image is malformed`, and the deploy then printed `OK: rollback Node-RED readiness confirmed after 1s`. With the fixed release each of the three lines is followed by `See docs/operations/damaged-farm-database.md (osi-os repository) before deploying again.`

### What a refused deploy leaves on the gateway

From the order of `deploy.sh` (the database check is in the migration step, after the files below are written) and the device run:

- **Already replaced, with no copy kept:** `/srv/node-red/settings.js`, `/etc/init.d/node-red`, `/etc/init.d/osi-identityd` and its `uci-defaults` script, the identity helper and daemon under `/usr/libexec`, `/srv/node-red/chirpstack-bootstrap.js`, `/etc/init.d/osi-bootstrap` and the NTP clock hook. `npm install` has run in `/srv/node-red`, which also installs the release's `node-red-node-sqlite` there.
- **Staged, not active:** the new flows, GUI and helpers in `/srv/node-red/payloads/<new stamp>/`.
- **Running:** the old payload and its old helpers, including the two-copy code on a factory image. It is restarted by the deploy and again after every reboot.
- **No backup:** the deploy made none. The migration backup comes after the check.
- **The file:** the deploy's `PRAGMA wal_checkpoint(TRUNCATE)` ran before the check. If it succeeded, the write-ahead log was copied into the damaged file and emptied.
- **One line per start:** the new `settings.js` looks for a helper the old payload does not have:
  `[osi-db-startup] ERROR farm database start-up check did not run: Cannot find module '/srv/node-red/osi-db-helper/startup'`
  Node-RED starts normally after it.

An interrupted deploy, or a rollback to an older payload, leaves the same pair (a new `settings.js` with old helpers) and the same line. Step 2 puts the old `settings.js` back from the operator's copy.

## 2. First: copy the database and its side files, before any deploy

Do this before anything else on a gateway whose file may be damaged, and above all before any deploy is tried on it. The deploy checkpoints the live file before its integrity check: on a damaged file, `PRAGMA wal_checkpoint(TRUNCATE)` writes the write-ahead log into the damaged file and removes the log, and only then does the integrity check refuse. The rows still in the log and the file as the damage left it are then gone, and the deploy takes no copy of its own.

Until step 6 is done, send valve commands one at a time, several seconds apart, and do not save several schedules at once (the interim advice of #637).

1. If a valve was opened without a duration, close it from the GUI now. A STREGA valve closes on its own after a timed open, with or without Node-RED; a valve opened without a duration closes only on a CLOSE command.
2. **Stop Node-RED**, the only writer of the farm database, and keep it stopped for the rest of the procedure:

   ```sh
   /etc/init.d/node-red stop
   i=0; while pgrep -f '[n]ode-red' >/dev/null 2>&1 && [ "$i" -lt 30 ]; do sleep 1; i=$((i + 1)); done
   pgrep -f '[n]ode-red' >/dev/null 2>&1 && echo "STOP: Node-RED still running" || echo "Node-RED stopped"
   ```

   It must print `Node-RED stopped`. While it is stopped: no schedule fires; no manual command can be sent; sensor readings arriving meanwhile are not stored; timed opens already sent still close on the valve's own timer. Do not reboot during the procedure: Node-RED starts again at boot. If the gateway reboots, run this step again.
3. **Copy the database with all its side files in one go**, then the configuration files the deploy would overwrite without a copy, into a new directory on the same filesystem (outside `/data/db/backups`: this is not a backup to restore from):

   ```sh
   df -k /data
   ls -l /data/db/farming.db*
   TS=$(date +%Y%m%d-%H%M%S)
   BK=/data/db/damaged-$TS
   mkdir "$BK" && echo "$BK" > /tmp/osi-damaged-backup-dir
   cp -a /data/db/farming.db /data/db/farming.db-* "$BK"/
   cp -aL /srv/node-red/settings.js "$BK/settings.js"
   cp -aL /etc/init.d/node-red "$BK/node-red.init"
   cp -aL /srv/node-red/flows.json "$BK/flows.json"
   cp -aL /srv/node-red/flows_cred.json "$BK/flows_cred.json"
   ```

   `df -k` must show free space of at least twice the database's size. If `ls` shows no `-wal`, `-shm` or `-journal`, the glob copies nothing for them, and that is right.
4. **See that the copy is complete:** compare every copied database file with its original, byte for byte, and keep the checksums:

   ```sh
   BK=$(cat /tmp/osi-damaged-backup-dir)
   for f in /data/db/farming.db /data/db/farming.db-*; do
     [ -e "$f" ] && { cmp "$f" "$BK/$(basename "$f")" && echo "same: $(basename "$f")"; }
   done
   ( cd "$BK" && sha256sum farming.db* > SHA256SUMS && cat SHA256SUMS )
   ```

   Every file beside the database must print `same`. Node-RED is stopped, so nothing changes between the copy and the comparison.

   If a deploy was already refused on this gateway, `settings.js` and the init script are already the new release's. Get the old `settings.js` from the tag the gateway ran (`git show v0.8.0:feeds/chirpstack-openwrt-feed/apps/node-red/files/settings.js` on a workstation) and copy it to the gateway as `$BK/settings.js.old`.

Why this method:

- The repository's rule is never to copy the database and its `-wal` and `-shm` separately while Node-RED runs; with Node-RED stopped, one raw copy of all of them is consistent. The normal online copy, `sqlite3 … ".backup"`, reads every page through SQLite and stops at the first damaged page with `database disk image is malformed`.
- Do not open the original with `sqlite3` without `-readonly` before this copy exists. The last read-write connection to close checkpoints the write-ahead log into the damaged file and deletes it, which is what the deploy's checkpoint does.

### To undo a refused upgrade and leave it there

If the owner decides to stop after a refused deploy, put the old `settings.js` back. The new init script can stay: the device ran the old payload under it after a reboot.

```sh
BK=$(cat /tmp/osi-damaged-backup-dir)
F="$BK/settings.js"; [ -f "$BK/settings.js.old" ] && F="$BK/settings.js.old"
cp -a "$F" /srv/node-red/settings.js && /etc/init.d/node-red restart
```

The gateway then runs exactly as before the deploy, on the damaged file and with the two-copy code. The scheduler keeps failing every minute.

## 3. Look at the copy

Read the copy, never the original, and change nothing:

```sh
BK=$(cat /tmp/osi-damaged-backup-dir)
sqlite3 -readonly "$BK/farming.db" "PRAGMA quick_check(10);"
sqlite3 -readonly "$BK/farming.db" "SELECT max(version) FROM schema_migrations;"
```

Write both answers into the session log. If `quick_check` answers `ok` here, the file is sound and the signs had another cause: stop and ask (look at `dmesg | grep -i error` for the SD card).

## 4. Choose one way, with the owner

### (a) Restore the newest sound backup, on the gateway

Nothing leaves the gateway. Try this first.

Backups can be in three places: `/data/db/backups/*/farming.db` (pre-repair and pre-deploy copies), `/data/db/farming.db.bak-*` (beside the database, from migrations) and `/data/backups/migrate/farming.db.premigrate-*` (from deploys that migrated). List them, newest first, and check each without changing it:

```sh
backups() { ls -t /data/db/backups/*/farming.db /data/db/farming.db.bak-* /data/backups/migrate/farming.db.premigrate-* 2>/dev/null | grep -v -e '-wal$' -e '-shm$' -e '-journal$'; }
backups | xargs ls -l
W=/data/db/check-work-$(date +%Y%m%d-%H%M%S)
for b in $(backups); do
  mkdir "$W" && cp -a "$b" "$W/c.db"
  echo "== $b"
  sqlite3 -readonly "$W/c.db" "PRAGMA integrity_check;" | head -3
  sqlite3 -readonly "$W/c.db" "SELECT max(version) FROM schema_migrations;"
  rm -r "$W"
done
```

Each backup is checked on a copy in `$W`, which is removed after it, so nothing is created beside the backup itself. A `.bak-` or `.premigrate-` file is one self-contained file; it needs no side file.

Take the newest one that answers `ok`. Put it in place with Node-RED stopped:

```sh
B=<the backup you chose>
cp -a "$B" /data/db/farming.db.restore && \
  rm -f /data/db/farming.db-wal /data/db/farming.db-shm /data/db/farming.db-journal && \
  mv /data/db/farming.db.restore /data/db/farming.db
sqlite3 -readonly /data/db/farming.db "PRAGMA integrity_check;"
```

**Lost:** everything written after that backup. That is sensor readings, valve runs and their records, schedule, zone and device changes, user and password changes, and the sync state: undelivered outbox events and sync versions are rolled back. The cloud keeps what the gateway sent it before the backup's time and after it, up to the damage. It does not send readings or history back to the gateway. Pending cloud commands not yet acknowledged arrive again. On a gateway linked to the cloud, stop and ask before restoring: a rolled-back sync state may be refused by the cloud.

### (b) Recover off the gateway and copy back

Neither gateway build of `sqlite3` can recover: our images' 3.46.1 and the stock base's 3.53.1 both answer `.recover` with `sql error: no such table: sqlite_dbpage (1)` and exit 1. They were built without the page table `.recover` needs. Recovery therefore runs on a workstation, and a copy of the farm's database leaves the gateway. That copy is the farm's production data. These rules apply to it:

1. Only with the owner's explicit approval, for this gateway, given before the copy is taken.
2. The operator the owner names runs it, on that operator's own machine. No one else receives the file.
3. Nobody reads rows. The operator looks at table names, row counts and the results of the checks below, nothing else.
4. The file is not sent to any third party or hosted service, and not stored in any shared folder.
5. Every copy off the gateway (the damaged copy, the recovered file, the work files) is deleted the same day, and none enters a backup.

**The tool on the workstation.** `sqlite3` 3.29.0 or later, built with the page table. Check it before the copy is taken:

```sh
sqlite3 -version
sqlite3 :memory: "PRAGMA compile_options;" | grep -i dbpage
```

The second command must print `ENABLE_DBPAGE_VTAB`. Two files damaged by the overlapping round were recovered with 3.51.2.

**Copy off.** From the workstation, with Node-RED still stopped on the gateway (`<gateway>` is its address, `$BK` the directory from step 2):

```sh
mkdir -m 700 recover-work && cd recover-work
scp 'root@<gateway>:<BK>/farming.db*' .
sha256sum farming.db*
```

The checksums must match `SHA256SUMS` in `$BK` (step 2).

**Recover from a second copy, and test that it worked.** `.recover` opens its input read-write, so it works on `../recover-src`, never on the copy whose checksums were just checked. A failed `.recover` still writes a few hundred bytes of SQL (a bare transaction frame). Loading that output gives an empty database, and an empty database passes `quick_check` and `integrity_check`. Two passing checks therefore prove nothing here. Test the exit status, then compare the tables and their row counts:

```sh
mkdir -m 700 ../recover-src && cp farming.db* ../recover-src/
sqlite3 ../recover-src/farming.db ".recover" > recover.sql
echo "recover exit: $?"
sqlite3 recovered.db < recover.sql
echo "load exit: $?"
```

Both exits must be `0`. Then, for each table, the row count in the recovered file against what can still be read from the damaged copy and against the last good backup (if one exists; from step 4(a)):

```sh
for t in $(sqlite3 recovered.db "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name;"); do
  r=$(sqlite3 recovered.db "SELECT count(*) FROM \"$t\";")
  d=$(sqlite3 -readonly farming.db "SELECT count(*) FROM \"$t\";" 2>&1)
  echo "$t recovered=$r damaged=$d"
done
```

The recovered file must have the same tables as the damaged copy's `sqlite_master`. No table may have fewer rows than the damaged copy still shows, with two exceptions: a table whose damaged count is an error, and `actuator_log`, the valve log, which may come back empty. Any other shortfall: stop. A recovered file whose counts fall well below the last backup's has not recovered either: stop.

Measured on two files damaged by the overlapping round (workstation, sqlite3 3.51.2), not a rule: both came back complete in schema (103 tables, 107 indexes, 64 triggers, 1 view) and in their users, devices, zones, readings (280,528 in the larger file), run records and schedules, at migration head 70, with no `lost_and_found` table. In both the valve log came back empty (2 rows and 39 rows lost), because its table was the damaged one. The larger file (106 MB) took 22 s; its `.recover` SQL was 584 MB, so the workstation needs free space of about six times the file.

**Set write-ahead mode.** A recovered file uses a rollback journal; the gateway uses write-ahead logging:

```sh
sqlite3 recovered.db "PRAGMA journal_mode=WAL;"
sqlite3 recovered.db "PRAGMA journal_mode;"
```

The second command must print `wal`. Then run `PRAGMA integrity_check;` once more; it must answer `ok`.

**Ledger and schema.** `SELECT max(version) FROM schema_migrations;` on the recovered file must give the damaged copy's version from step 3. For the schema fingerprints, run the release's own check on a throwaway copy (it may restamp the copy it is given), from a checkout of the osi-os tag the gateway runs:

```sh
cp recovered.db verify-copy.db
node <osi-os checkout>/scripts/verify-head-cli.js verify-copy.db
echo "verify exit: $?"
```

Exit `0` is required. The file that goes back is `recovered.db`, not `verify-copy.db`. The deploy in step 6 checks the schema again on the gateway and refuses on any difference.

**Copy back and clean up**, with Node-RED stopped on the gateway:

```sh
scp recovered.db 'root@<gateway>:/data/db/farming.db.restore'
```

On the gateway:

```sh
rm -f /data/db/farming.db-wal /data/db/farming.db-shm /data/db/farming.db-journal && \
  mv /data/db/farming.db.restore /data/db/farming.db
sqlite3 -readonly /data/db/farming.db "PRAGMA integrity_check; PRAGMA journal_mode;"
```

It must print `ok` and `wal`. On the workstation, the same day: `cd .. && rm -rf recover-work recover-src`.

If any test above fails, do not repair the recovered file by hand: fall back to (a) or (c), delete the workstation copies the same day.

### (c) Neither gives a sound file

The history on this gateway cannot be saved. Readings and runs that reached the cloud stay there. Save the configuration that can still be read, to re-enter it:

```sh
BK=$(cat /tmp/osi-damaged-backup-dir)
for t in users irrigation_zones devices valve_schedules; do
  sqlite3 -readonly -cmd ".mode insert $t" "$BK/farming.db" "SELECT * FROM $t;" > "$BK/config-$t.sql" 2>"$BK/config-$t.err"
  echo "$t: $(wc -l < "$BK/config-$t.sql") rows, errors: $(wc -c < "$BK/config-$t.err") bytes"
done
```

The devices are also registered in ChirpStack, which keeps its own database. Then move the damaged file aside so the deploy seeds a new, empty one:

```sh
mkdir -p /data/db/replaced && mv /data/db/farming.db* /data/db/replaced/
```

Zones, devices and schedules are then entered again in the GUI. The saved `config-*.sql` files are a record to read from, not files to load.

## 5. Before the deploy

```sh
sqlite3 -readonly /data/db/farming.db "PRAGMA integrity_check;"
```

This must answer `ok` (after (a) or (b)), or the file must be absent (after (c)). Node-RED stays stopped.

## 6. Put the fixed release on, in the same session

A repaired file under the old two-copy code can be damaged again, so the release goes on now. Run the deploy the way this gateway gets it (tunnel or bundle). On a sound file the output passes the point where it stopped before:

```
--- Stop Node-RED for schema migration ---
OK
```

then the migration lines, `--- Flip payload + local health self-check + auto-rollback (5.3 / DD10) ---`, and exit 0. On a gateway with no file (after (c)) the deploy seeds a new one.

Then confirm the end state:

```sh
logread | grep osi-db-startup
```

The line must be absent. In `GET /api/system/stats` the `database` object must read `"status": "healthy"`, `"native_addons": 1` and `"health_state": null`, and the next heartbeat must not report a `database_` or `sqlite_` state. If the deploy refuses again, stop and ask.

## What the start-up check cannot see

The check sees damage, not loss. A file that is sound but empty, or that lost rows, passes it: a recovered file whose rows did not come back reports `healthy` as long as the three core tables exist. Only `.recover`'s exit status and the row counts in (b) guard against that.

## What this does not cover

Stop and ask when:

- a backup or a recovered file has a different migration version than the damaged one;
- `dmesg` shows I/O errors on the SD card or disk: the card is failing, and restoring onto it will not hold;
- ChirpStack's own database is damaged;
- `/data` has less free space than step 3 needs;
- the gateway is linked to the cloud and (a) is chosen;
- any command here prints something other than what this document says it prints.

Known limit: the gateways carry no `sqlite3` that can recover, so recovery always means the farm's database leaves the gateway, under the rules in (b).
