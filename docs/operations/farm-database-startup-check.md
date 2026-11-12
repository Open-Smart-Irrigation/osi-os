# Farm database start-up check

Node-RED opens the farm database (`/data/db/farming.db`) through one native SQLite module per process, and checks the file once, read-only, in a child process beside the flows. Both measures came with the fix for NEW-15 (tracking issue #637).

## Why one module

Two copies of the native `sqlite3` addon in one Node-RED process damaged the farm database. The flows' SQLite nodes load the copy inside `node-red-node-sqlite`, and on a factory image `osi-db-helper` loaded a second copy from `/srv/node-red/node_modules/sqlite3`. Each copy carries its own SQLite library with its own table of POSIX locks for the same file. When valve commands and one-time schedules overlapped, the file ended in `database disk image is malformed` on v0.8.0, v0.8.1 and v0.8.2. The image builder showed it on an emulated Pi 5, and `scripts/test-release-sqlite-overlap.js` shows it under Node 20.18.3, the version the image ships. A distribution Node 22 linked against one system `libsqlite3` hid the defect, because both addons then shared one library.

`osi-db-helper/sqlite-driver.js` now takes `sqlite3` from the `node-red-node-sqlite` package that Node-RED actually loaded for its SQLite nodes (found in the module cache at the first connection). On a factory image that is the firmware package; after `npm install` in `/srv/node-red` it can be the package in the user directory, which Node-RED prefers. The real directory `/srv/node-red/node_modules/sqlite3` stays: npm, the seed and the bundle deploy need it, and Node-RED no longer loads it. A process that is not Node-RED (a test or a command-line tool) uses its own `sqlite3`; a separate process with its own library is safe.

## What refuses

`osi-db-helper` refuses every farm connection, with the error code `OSI_SQLITE_REFUSED`, in two cases:

| Health state | Cause |
|---|---|
| `sqlite_driver_unavailable` | Node-RED runs but its SQLite node package is not loaded, more than one is loaded, or its `sqlite3` failed to load. The helper never tries another copy. |
| `sqlite_module_conflict` | More than one `node_sqlite3.node` file is mapped in the process (`/proc/self/maps`, counted by device and inode). Counted at every connection and every health read; once seen it stays latched until Node-RED restarts. |

No addon mapped yet is not a conflict: at `settings.js` time no SQLite module is loaded.

## The file check

`settings.js` starts `osi-db-helper/startup.js` as Node-RED loads. It runs, in a child process beside the flows:

```sh
sqlite3 -readonly /data/db/farming.db "PRAGMA quick_check(1); <count of users, devices, irrigation_zones>"
```

The flows do not wait for it. Until it answers, the state reads `checking`; the verdict replaces it the moment the child finishes, in the stats answer and in the next heartbeat. The check runs once per process. If `settings.js` cannot load the module, it logs `[osi-db-startup] ERROR`, Node-RED still starts, and the helper starts the same check at its first connection, without waiting for it either.

| Status | Health state | Meaning |
|---|---|---|
| `checking` | `database_checking` | The check is still reading. |
| `healthy` | none | `quick_check` answered `ok` and all three core tables exist. |
| `damaged` | `database_damaged` | `quick_check` reported a fault, or SQLite answered "malformed" or "not a database". |
| `missing_core_tables` | `database_missing_core_tables` | The file opens and checks clean but lacks a core table, for example an empty file. |
| `missing` | `database_missing` | No file at the path. |
| `unreadable` | `database_unreadable` | The file exists but cannot be opened or read. |
| `not_checked_timeout` | `database_not_checked` | The check passed its bound and was stopped. |
| `not_checked` | `database_not_checked` | The check could not run: the tool is absent or did not start, or its answer was not one of the above. The reason is in `detail`. |

The verdict is decided by SQLite's message, not its exit code: the same damaged file gives exit 1 with `Error in 3rd command line argument: database disk image is malformed` on sqlite3 3.53.1 and exit 11 with `Error: stepping, database disk image is malformed (11)` on 3.46.1.

**The bound is ten minutes**, from the field figure. `quick_check` reads every page: a 103 MiB file took 1.1 to 1.2 s cold on an emulated Pi 5. The production gateway's SD card copied its 94 MiB database in 18 s, a copy the emulator makes in 1 to 2 s, so it reads 9 to 18 times slower: the check needs 10 to 22 s per 100 MB there, about 50 s to 2 minutes for 500 MB, and ten minutes still gives a verdict on 2.7 to 6 GB. Because the check runs beside the flows, the bound delays nothing; it ends a read that will not finish.

**While the state is `checking`, the gateway works normally.** Farm connections open, valve commands and schedules run on a file not yet checked. That is by design: the check reports and never gated irrigation. The helper's before-open step only counts the native modules and, if `settings.js` did not, starts the check; it never waits for it.

**Reading beside the writers.** The farm database uses write-ahead logging. `quick_check` runs in one read transaction, so it sees one consistent snapshot, the one committed when it started, whatever the writers do meanwhile: a moving file cannot make it report damage. A reader takes no write lock, so writers go on. While the snapshot is held, a checkpoint cannot copy frames written after it into the database or restart the log, so the `-wal` file grows by what the gateway writes during the check. Measured on the farm schema (sqlite3 3.51, one `device_data` insert per commit, its triggers firing): without a reader the log levels off at about 4 MB, the 1000-page autocheckpoint (the image builder saw 4.1 MB on a device); with a reader holding its snapshot it grows by about 22 KB per committed write, 13.5 MB after 600 writes. At one write a second a one-minute check adds about 1.3 MB, and the ten-minute bound caps it at about 13 MB. After the check the log is checkpointed and reused from its start; the file keeps its largest size until a truncating checkpoint (the deploy runs one), because no journal size limit is set. The reader ends with Node-RED: Node-RED's stop and its uncaught-error handler end in `process.exit()`, and the check kills its child then. Only a `SIGKILL` of Node-RED would leave the reader running alone, until its read ends. A file in rollback-journal mode would be different: its readers block writers' commits for the length of the read. The helper switches the file to write-ahead logging at its first connection, and the recovery procedure sets it before a recovered file is used.

The check depends on the `sqlite3` command-line tool. Our images carry it (`sqlite3-cli`, 3.46.1); a stock ChirpStack Gateway OS base has none until the first deploy installs it from the `opkg` feed (3.53.1 when measured). When the tool is absent or does not start, the check reports `not_checked` (`database_not_checked`): never healthy, never a fault.

The check sees damage, not loss: a sound file that lost rows, or a recovered file whose rows did not come back, reads `healthy` as long as the three core tables exist. The check only reports. It does not move, restore, quarantine, delete or write the database, and a damaged file does not stop irrigation. It opens the file read-only: SQLite then reads a write-ahead log left by a power cut without checkpointing it into the file. A read-only open does create files: on a write-ahead-log database without side files it leaves a 32 KB `farming.db-shm` and an empty `farming.db-wal`, as any reader would; on a rollback-journal file it creates nothing. The check only ever reads the live `/data/db/farming.db`, beside which Node-RED keeps those two files anyway. They belong to the live database and are never backups. On a device, after a hard power cut during overlapping valve commands, the check read the file with its 4.1 MB log in 1.6 s and reported `healthy`, and both checks agreed afterwards. What a gateway does by itself with a damaged file is the owner's decision and is not settled; the manual procedure for an operator, applied on the owner's word, is [damaged-farm-database.md](damaged-farm-database.md).

## Where the state shows

- The heartbeat's `health.health_state` carries the database health state. A fault replaces `healthy`, `degraded` and `crash_looping`; `database_checking` and `database_not_checked` replace only `healthy`, so they never hide a crash loop or `degraded`. `Gather Edge Health` publishes it into `edge_health` before its first `await`, and the heartbeat tick reaches `Gather Edge Health` before `Build Heartbeat`, so every heartbeat carries the state as it is at that tick: `checking` at first, the verdict from the tick after it is known. With a refusal no connection is attempted.
- `GET /api/system/stats` (authenticated, as before) has a `database` object: `status`, `detail`, `check_ms`, `timeout_ms`, `driver_mode`, `driver_error` (no module paths), `native_addons`, `module_conflict` and `health_state`.
- The gateway log has one `[osi-db-startup] ERROR` line per fault; for a damaged, missing or unreadable file it names [damaged-farm-database.md](damaged-farm-database.md).
- A fault published while the regular health gather has not finished is laid over the last gathered figures (schema signature, sync counters, disk); a gateway whose file is sound but was not checked keeps sending them, and `degraded` stays `degraded`.

## New settings with old helpers

`deploy.sh` writes `settings.js` before it switches the payload. A deploy that is refused, cut off or rolled back leaves the new `settings.js` with helpers that lack `startup.js`. Every start then logs `[osi-db-startup] ERROR farm database start-up check did not run: Cannot find module '/srv/node-red/osi-db-helper/startup'` and Node-RED runs normally with the old payload. [damaged-farm-database.md](damaged-farm-database.md) describes that state and how to put the old `settings.js` back.

## The old boot tool

`/etc/init.d/osi-db-integrity` is linked as `S90` but never runs. Its init script sets `USE_PROCD=0`, a non-empty value, so `rc.common` replaces its `start()` with procd's `start`, which calls the `start_service` the script does not define. Run by hand, the tool can move the database aside or restore a backup. It stays as it is on purpose: repairing its header would switch on an automatic restore nobody has decided on. `osi-rootfs-resize` has the same header and is also left alone.
