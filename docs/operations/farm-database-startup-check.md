# Farm database start-up check

Node-RED opens the farm database (`/data/db/farming.db`) through one native SQLite module per process, and checks the file once, read-only, before the flows start. Both measures came with the fix for NEW-15 (tracking issue #637).

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

`settings.js` runs `osi-db-helper/startup.js` before Node-RED starts the flows:

```sh
sqlite3 -readonly /data/db/farming.db "PRAGMA quick_check(1); <count of users, devices, irrigation_zones>"
```

The check runs once per process in a separate `sqlite3` process, bounded at 10 s with a monotonic timer and `SIGKILL`; the wall clock plays no part, because it can read decades off in the first seconds of a boot. If `settings.js` cannot load the module, it logs `[osi-db-startup] ERROR`, Node-RED still starts, and the helper runs the same check before its first connection.

The check depends on the `sqlite3` command-line tool. Our images carry it (`sqlite3-cli` in the image configuration); a stock ChirpStack Gateway OS base has none until the first deploy installs it from the `opkg` feed. When the tool is absent or does not start, the check reports `not_checked` (`database_not_checked`): never healthy, never a fault.

| Status | Health state | Meaning |
|---|---|---|
| `healthy` | none | `quick_check` answered `ok` and all three core tables exist. |
| `damaged` | `database_damaged` | `quick_check` reported a fault, or SQLite answered "malformed" or "not a database". |
| `missing_core_tables` | `database_missing_core_tables` | The file opens and checks clean but lacks a core table, for example an empty file. |
| `missing` | `database_missing` | No file at the path. |
| `unreadable` | `database_unreadable` | The file exists but cannot be opened or read. |
| `not_checked_timeout` | `database_not_checked` | The check took longer than 10 s. Never reported as healthy. |
| `not_checked` | `database_not_checked` | The check could not finish for another reason, for example a lock or a missing `sqlite3` CLI. |

The check sees damage, not loss: a sound file that lost rows, or a recovered file whose rows did not come back, reads `healthy` as long as the three core tables exist. The check only reports. It does not move, restore, quarantine, delete or write the database, and a damaged file does not stop irrigation. It opens the file read-only: SQLite then reads a write-ahead log left by a power cut without checkpointing it into the file, and may create or rebuild the shared-memory index (`-shm`), as any reader does. What a gateway does by itself with a damaged file is the owner's decision and is not settled; the manual procedure for an operator, applied on the owner's word, is [damaged-farm-database.md](damaged-farm-database.md).

The bound follows two measurements. `quick_check` reads every page: about 15 ms for a 2 MB file, about 240 ms for a 300 MB file from a warm cache, 29 s for the same file from a cold cache on the measuring workstation. The check delays Node-RED's start by up to 10 s. After a payload switch `deploy.sh` waits up to 45 s (`NODE_RED_INIT_TIMEOUT`) for schema initialisation and then 30 s (`NODE_RED_HEALTH_TIMEOUT`) for health before it rolls back; after a deploy the cache is warm. At a cold boot a database much larger than about 100 MB can end as `not_checked_timeout`.

## Where the state shows

- The heartbeat's `health.health_state` carries the database health state. A fault (every state except `database_not_checked`) replaces `healthy`, `degraded` and `crash_looping`; `database_not_checked` replaces only `healthy`, so a large file that timed out never hides a crash loop. `Gather Edge Health` publishes it into `edge_health` before its first `await`, and the heartbeat tick reaches `Gather Edge Health` before `Build Heartbeat`, so the first heartbeat after a start already carries it. With a refusal no connection is attempted.
- `GET /api/system/stats` (authenticated, as before) has a `database` object: `status`, `detail`, `check_ms`, `timeout_ms`, `driver_mode`, `driver_error` (no module paths), `native_addons`, `module_conflict` and `health_state`.
- The gateway log has one `[osi-db-startup] ERROR` line per fault; for a damaged, missing or unreadable file it names [damaged-farm-database.md](damaged-farm-database.md).
- A fault published while the regular health gather has not finished is laid over the last gathered figures (schema signature, sync counters, disk); a gateway whose file is sound but was not checked keeps sending them, and `degraded` stays `degraded`.

## New settings with old helpers

`deploy.sh` writes `settings.js` before it switches the payload. A deploy that is refused, cut off or rolled back leaves the new `settings.js` with helpers that lack `startup.js`. Every start then logs `[osi-db-startup] ERROR farm database start-up check did not run: Cannot find module '/srv/node-red/osi-db-helper/startup'` and Node-RED runs normally with the old payload. [damaged-farm-database.md](damaged-farm-database.md) describes that state and how to put the old `settings.js` back.

## The old boot tool

`/etc/init.d/osi-db-integrity` is linked as `S90` but never runs. Its init script sets `USE_PROCD=0`, a non-empty value, so `rc.common` replaces its `start()` with procd's `start`, which calls the `start_service` the script does not define. Run by hand, the tool can move the database aside or restore a backup. It stays as it is on purpose: repairing its header would switch on an automatic restore nobody has decided on. `osi-rootfs-resize` has the same header and is also left alone.
