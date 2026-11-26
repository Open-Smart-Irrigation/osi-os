# Boot runner: sync-init-fn inventory

For 1.0 the Go backend does not port the frozen boot node "Sync Init Schema +
Triggers" (`sync-init-fn`, AGENTS.md "Boot-DDL freeze"). The image runs the
node's body unchanged under Node, once per boot, before the Go runtime starts.
`run-sync-init.js` does that. This file lists what the body does, what it needs
from Node-RED and how the runner supplies each dependency, and the parity
evidence that the runner leaves the same database as a Node-RED boot.

## Files

| File | Role |
| --- | --- |
| `gen-sync-init.js` | Build step. Lifts the node from both profiles' `flows.json`, checks the body hash against `sync-init.pin` and every property that changes behaviour without changing the body, and writes `sync-init-fn.generated.json`. `--check` is the CI gate. |
| `sync-init.pin` | SHA-256 of the body (UTF-8 bytes of the decoded `func` string). |
| `sync-init-fn.generated.json` | The body the runner executes, with its source line numbers. Generated; never edited. |
| `run-sync-init.js` | The runner. |
| `db-compare.js`, `parity.js` | Workstation parity check against the Node-RED oracle. |
| `../harness/test/boot-runner.test.js` | Pin, refusal and fresh-seed parity tests. |

CI step: `node edge/boot/gen-sync-init.js --check` (Node 20 or newer). The test
file needs Node 22.5 or newer for `node:sqlite` and the release-smoke Node for
the runner: `node --test edge/harness/test/boot-runner.test.js`.

## Line references

`flows.json` stores the body as one JSON string, so a `flows.json` line number
locates the node and "body line N" counts lines inside the decoded body
(line 1 is `return (async()=>{`). In the canonical profile
`conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`, the node
starts at line 6290 and its `func` is line 6294. Its inject (`sync-init-inject`,
once, 1 s after start) is line 6265. The bcm2709 profile has the same lines and
the same body (checked by `gen-sync-init.js`).

## What the body does

The body opens the shared farm connection through `osi-db-helper`
(body line 2) and reads `DEVICE_EUI` (body lines 5-6). An EUI that is not
16 hex digits after trimming and upper-casing becomes SQL `NULL`. Then it runs
four phases in order. Phase 1 runs while the previous boot's triggers are still
installed; its data updates fire those old trigger definitions (seen in the
`synth-needs-backfill` source below, where zone updates queue outbox rows).

### Phase 1: statement list (body lines 64-216)

150 statements run one at a time; every error is swallowed (`catch (_) {}`,
body line 216). On every database of a real lineage (the fresh seeds, the
census databases, their head-migrated copies), all 93 `ADD COLUMN` statements
failed with "duplicate column name", including the unbooted 0.7.0 factory
seed. AGENTS.md says 81 of the 93 are redundant with the seed; this
measurement found all 93 present on every source. The `linked_users` insert
failed with "no such table" on every source except
`synth-legacy-linked-users`. Only `synth-missing-objects` made phase-1 DDL
take effect: four `ADD COLUMN`s (`users.edge_originated` and the three
`sync_history_cursors` shadow columns), two tables with their indexes and
`idx_sync_outbox_pending`. The runner logs the counts per class.

| Body lines | Trigger condition | Effect |
| --- | --- | --- |
| 65-75 | column absent | `users` + 11 columns (`user_uuid`, cloud/auth-sync fields, `edge_originated`) |
| 76 | `user_uuid` NULL or `''` | `users.user_uuid` = random 32-hex (`randomblob(16)`) |
| 77 | verifier version NULL | `users.server_offline_verifier_version` = 0 |
| 78-79 | `auth_mode='server'` and status empty | `users.last_auth_sync_status` = `up_to_date` (verifier v1+ present) or `repair_required` (verifier missing) |
| 80 | index absent | unique index `idx_users_user_uuid` |
| 81-88 | column absent | `irrigation_zones` + 8 columns |
| 89 | `zone_uuid` NULL or `''` | random 32-hex `zone_uuid` |
| 90 | `gateway_device_eui` NULL or `''` | set to `DEVICE_EUI` (or NULL when the EUI is invalid) |
| 91-93 | `sync_version` 0/NULL; mode or flag NULL | `sync_version`=1, `scheduling_mode`='local', `prediction_card_enabled`=0 |
| 94 | index absent | unique index `idx_irrigation_zones_zone_uuid` |
| 95-117 | column absent | `devices` + 23 columns (sync, STREGA model, rain/flow, probe depths, dendrometer, Chameleon) |
| 118-120 | empty EUI; `sync_version` 0; flag NULL | `devices.gateway_device_eui`=`DEVICE_EUI`, `sync_version`=1, `soil_moisture_probe_depths_configured`=0 |
| 121-124 | new dendrometer ratio columns NULL, legacy ones set | copy between `dendro_ratio_zero/span` and `dendro_ratio_at_retracted/extended` (direction-aware), then mirror back |
| 125 | legacy 4-part baseline signature and both new ratios set | clear the dendrometer baseline fields, `dendro_baseline_pending`=1 |
| 126-131 | column absent; values 0/NULL | `irrigation_schedules` + 4 columns; `sync_version`=1; `response_mode`='proportional' |
| 132-146 | table/index/column absent | `sync_outbox`, `sync_inbox`, `applied_commands` (+6 columns, 2 indexes), `command_ack_outbox` (+2 indexes), `sync_cursor` |
| 147-148 | absent | `irrigation_events.event_uuid`; table `sync_link_state` |
| 149 | `sync_link_state` has no `cloud` row and a legacy `linked_users` table has an active row | insert the `cloud` link row (`updated_at` = `linked_at` or now). No seed or migration creates `linked_users`; it failed on all real-lineage sources and ran only in `synth-legacy-linked-users` |
| 150 | `event_uuid` empty and a gateway EUI is known (zone, else link row) | `irrigation_events.event_uuid` = `irrig-<EUI>-<id as 15 digits>` |
| 151 | index absent | unique index `idx_irrigation_events_event_uuid` |
| 152-163 | absent | `sync_history_cursors` (+3 columns), `sync_history_dirty_keys`, `sync_history_segments`, `sync_history_quarantine`, `zone_shared_environment` (+2 indexes), `gateway_locations` (+1 index) |
| 164-205 | absent | 27 `device_data` `ADD COLUMN` statements (`bat_pct` twice); `dendrometer_readings` (create, index, +7 columns); `chameleon_readings` (create, 2 indexes, +3 columns) |
| 206-214 | absent | `irrigation_events` (create, index), `idx_sync_outbox_pending`, `weather_station_zones` (+ index), 4 `devices` indexes |

### Phase 2: guarded `devices` rebuild (body lines 218-264)

Trigger: a `devices` table exists and the set of types in its
`CHECK(type_id IN (...))` differs from the nine required types (a missing
table is left alone). Effect: `PRAGMA foreign_keys=OFF` and
`legacy_alter_table=ON`, then one helper transaction (`BEGIN IMMEDIATE`) that
drops a stale `devices_new`, creates it from `DEVICES_COLUMNS` (body lines
12-63), refuses when the live table has a column the list does not know,
copies every row with a plain `INSERT` (absent columns take defaults, renamed
dendrometer columns are coalesced), swaps the tables and recreates the four
indexes. Success sets the node status `devices CHECK upgraded`. Any failure
rolls back, leaves `devices` intact and calls `node.error`. Both pragmas are
restored in a `finally`. The rebuild ran on every 0.7.0-lineage source and on
`synth-narrowed-check`; `synth-unknown-column` took the refusal path.

### Phase 3: foreign-key self-heal (body lines 266-279)

Trigger: a table definition mentions `devices_old`. Effect: with
`writable_schema=ON`, rewrites `REFERENCES devices_old` / `"devices_old"` to
`REFERENCES devices` in `sqlite_master`, bumps `schema_version` and warns
`Self-healed FK refs for: <tables>`. A failure warns `FK self-heal failed`.
Deploy and migration preflights now refuse `devices_old` catalogs (AGENTS.md),
so only `synth-fk-devices-old` reached this branch.

### Phase 4: triggers (body lines 280-342)

60 statements: 30 `DROP TRIGGER IF EXISTS`, then 30 `CREATE TRIGGER`, each
failure warned as `Sync init SQL failed`. The 30 triggers keep sync state:
UUID and default fills on insert into `users`, `irrigation_zones`,
`irrigation_schedules`, `devices`, `irrigation_events`; outbox events on
updates of zones, schedules, devices and `gateway_locations`; data-plane
outbox rows on inserts into `device_data`, `dendrometer_readings`,
`chameleon_readings`, `irrigation_events`, `zone_daily_environment`,
`dendrometer_daily`, `zone_daily_recommendations`; history dirty keys on
updates of `device_data`, `chameleon_readings`, `dendrometer_readings` and on
writes to the three daily tables. Every outbox trigger is gated on
`sync_link_state` (`peer_node='cloud' AND linked=1`). On a fresh seed this
phase rewrites 24 trigger texts that `seed-blank.sql` spells with different
whitespace, and the helper's pragmas turn `journal_mode` from `delete` to
`wal`.

The body then calls `close()` (a no-op in the helper), logs
`sync-init: schema init complete` and sets the status `sync ready`. An error
that escapes the phases is caught at body line 347 as `Sync init failed: ...`.

## Other start-up nodes that touch the database

Only nodes that run at Node-RED start are listed; HTTP and MQTT handlers run
on requests. "Once-only" nodes fire one time per start; the rest also repeat
and are runtime jobs.

| Node (flows.json line) | Kind | Database effect | In the runner? |
| --- | --- | --- | --- |
| `sync-init-inject` → `sync-init-fn` (6265, 6290) | once, 1 s | everything above | yes |
| `Init DB` inject → function "Enable foreign keys" → SQLite node, Scheduler tab (2586, 2615, 2635) | once, 1 s | `PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000` on the SQLite node's own connection; connection-local, nothing persists | no: the Go connection sets its own pragmas |
| second `Init DB` inject → function "Check foreign keys" → SQLite node, Scheduler tab (2721, 2668, 2688) | once, 1 s | reads `PRAGMA foreign_keys` | no |
| `crash-loop-startup-inject` → `crash-loop-register-fn` (3827, 3848) | once, 0.5 s | none: `osi-health-helper` writes a crash counter file | no: crash-loop reporting belongs to the Go runtime |
| `cmd-type-registry-trigger` → `cmd-type-registry` (9710, 9363) | once, 0.1 s | none (in-memory registry) | no |
| `al-link-finalize` On Start code (8865) | at start | only when `/data/db/osi-account-link-config.json` exists: finishes a half-done account-link configuration transaction in `farming.db` (`osi-installation-helper` `recoverAccountConfigOnStart`) | no: it is part of the account-link state machine, coupled to the link journal, UCI and restart publication; the Go account-link port has to own it. Not exercised here (no journal file in any run) |
| `settings.js` start-up check and `refreshSessionsOnce` | at start | none: read-only `quick_check` child; `sqlite3` CLI reads, then marker and session-secret files | no |
| `dendro-daily-inject` → `dendro-compute-fn` (5524, 5543) | once at 30 s, then daily cron | daily dendrometer analytics writes | no: runtime job |
| `gateway-health-sample-tick` → `gateway-health-persist-fn` (9614, 9639) | 5 s, every 60 s | gateway health rows | no: runtime job |
| sync injects: bootstrap, outbox, history, manifest, pending commands, token refresh (6312-6930) | 8-60 s, then repeat | outbox delivery marks, cursors, pending-command and calibration writes | no: runtime jobs |
| valve, conditional-irrigation, weather, SDI-12, STREGA reconciliation, journal replication ticks (12692-15870) | 10-90 s, then repeat | write through `osi-*` modules; not traced statement by statement here | no: runtime jobs |
| simulation injects (3340, 5889) | on disabled tabs | none | no |

The oracle pauses every inject after its first 2.5 s, so a parity run boots
`sync-init-fn` and the 0.1-1 s once-only nodes above. Across all 23 sources
their database effect equals the runner's: none of them wrote to
`farming.db`.

## Node-RED dependencies and how the runner supplies them

No dependency needed a change to the body. The table is the result of the
item-(b) check: every row is supplied with the semantics Node-RED gives it.

| Dependency | Under Node-RED 3.1.15 | Runner |
| --- | --- | --- |
| Function wrapper | `10-function.js` wraps the body in `async function(msg,__send__,__done__)` with a `node` object and runs it in `vm.createContext` | the same wrapper text, byte for byte, in a `vm` context with the same sandbox names (`console`, `util`, `Buffer`, `Date`, `RED`, `__node__`, `context`, `flow`, `global`, `env`, timers, `promisify`, the lib variable) |
| `msg` | inject message: `payload` = timestamp, `topic` = `''` | the same; the body never reads it |
| `env.get('DEVICE_EUI')` | `RED.util.getSetting`: `NR_*` names, flow env, `global-config` env, then `process.env` (no `envVarExcludes` in `settings.js`) | the same chain. The tab and `global-config` carry no env and the node is in no group; `gen-sync-init.js` fails if that changes. `DEVICE_EUI` comes from the process environment, which `settings.js` never fills for identity keys; the init that starts the runner must export the value `node-red.init` derives (`osi-edge` already derives it the same way) |
| `node.log/warn/error/status` | Node-RED log and editor status | one stderr line each, `[sync-init-runner] LEVEL [function:Sync Init Schema + Triggers] ...`; `error` and unknown warnings set the exit status |
| `node.send`, outputs | one output, no wires: a send reaches nobody | recorded, delivered to nobody |
| `context`, `flow`, `global`, `RED.util`, `node.on` | context store, runtime utilities | not used by the body; the runner throws if reached (the pin keeps the body from reaching them) |
| timers | sandbox `setTimeout`/`setInterval` wrappers | same wrappers; the body uses none (the helper uses Node timers for its transaction retry) |
| `libs: osiDb = osi-db-helper` | `RED.import`: refused unless the user-directory `package.json` lists it, then dynamic `import()` of `<userDir>/node_modules/osi-db-helper`, value `lib.default \|\| lib` | the same listing check and the same import, from `OSI_BOOT_NODE_RED_DIR` (default `/srv/node-red`) |
| Helper connection settings | one shared connection: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=5000`, `wal_autocheckpoint=1000`; one operation queue; `transaction()` = `BEGIN IMMEDIATE` with nested-begin retry; `close()` a no-op | the real helper, unchanged, so the same settings and queue |
| SQLite driver | the helper takes the `sqlite3` of the `node-red-node-sqlite` package Node-RED loaded (NEW-15) | the `sqlite3` that `node-red-node-sqlite` resolves, user directory first, then `/usr/lib/node/node-red/node_modules`; `OSI_BOOT_SQLITE_NODE_DIR` overrides. The helper runs in its standalone mode and receives that module; the runner logs the addon path and refuses a second addon |
| Database path | body hardcodes `/data/db/farming.db` | the driver opens `OSI_BOOT_DB` when asked for that path and refuses any other path. It drops `OPEN_CREATE`, so a missing file is never created (the runner also refuses a missing or empty file before starting) |
| Start-up integrity check | `settings.js` starts a read-only `quick_check` child; the helper starts it in Node-RED mode | not run (standalone mode skips it); the database is not written by it |
| async/await, Promise return | Node-RED awaits the returned promise and passes a rejection to `done(err)` | awaited; a rejection is a node error |
| Process end | the connection stays open while Node-RED runs | the runner closes the helper's native connection after the body ends, so SQLite checkpoints the WAL |

### Visibility of failures

Exit 0 means the body finished, logged its completion line, called no
`node.error` and warned only `Self-healed FK refs`. Exit 1 covers a node
error, a missing completion line, an unknown warning, and any statement that
failed with a storage-class SQLite error (busy, locked, I/O, full, read-only,
corrupt, cannot open), even when the body swallowed it. Exit 2 means the
runner did not start: pin mismatch, missing or relative database path,
helper or driver not found. Every statement the body swallows is observed in
the driver callback without changing it; "duplicate column name" is counted,
any other class is logged with the statement head. `OSI_BOOT_REPORT` writes
the per-statement record as JSON.

## Parity

`parity.js` boots each source three times on copies: twice under the T1
oracle (`edge/harness/oracle-node-red.js`, release-smoke runtime, Node 20.18.3,
SQLite 3.44.2) and once with the runner on the same Node and the same SQLite
addon. Oracle A against oracle B is the floor (cells written from
`randomblob()` or `'now'`). The runner must differ from oracle A only inside
that floor, with the same storage class and length there, and must exit 0
exactly when the oracle's node logged no error. The comparison covers every
`sqlite_master` row byte for byte, every row and cell of every table
(`typeof()` and `quote()`), `user_version`, `application_id`, `journal_mode`,
`integrity_check` and `foreign_key_check`.

Results on the workstation (24 November 2026), diff counts per source:

| Source | Origin | Floor (A-B) | Runner vs A | Residual | Branches |
| --- | --- | --- | --- | --- | --- |
| fresh-head | `build-seed-db.js` at this commit | 0 | 0 | 0 | none |
| bundled-head | bundled `usr/share/db/farming.db` | 0 | 0 | 0 | none |
| seed-v0.8.0 | v0.8.0 seed, unbooted (equal to the v0.8.0 test-fixture image seed) | 0 | 0 | 0 | none |
| seed-v0.7.0-image | 0.7.0 factory image seed, unbooted | 0 | 0 | 0 | rebuild |
| booted-pop-0.7.0 / 0.8.0 / 0.8.3 | typeof census recipe: release seed, synthetic population, own boot node | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | rebuild on 0.7.0 |
| private-line-synthetic | the census's private-line synthetic database (ledger 76) | 0 | 0 | 0 | none |
| gen-v0.7.0 / 0.8.0 / 0.8.1 / 0.8.3 | census generator: each release's flows driven through its routes | 0 each | 0 each | 0 each | rebuild on 0.7.0 |
| cassette-fixture | a T1 cassette `fixture.db` (booted by this node) | 0 | 0 | 0 | none |
| headmig-* (4) | booted-pop-0.8.0, booted-pop-0.8.3, gen-v0.8.3, private-line migrated to head with `migrate-cli.js` | 0 each | 0 each | 0 each | none |
| synth-narrowed-check | booted-pop-0.8.3 with two types removed from the `devices` CHECK | 0 | 0 | 0 | rebuild |
| synth-unknown-column | as above plus an unknown `devices` column | 0 | 0 | 0 | rebuild refused; runner exit 1, oracle logs the same error |
| synth-fk-devices-old | booted-pop-0.8.3 with two FKs pointing at `devices_old` | 0 | 0 | 0 | FK self-heal |
| synth-needs-backfill | booted-pop-0.8.3 with UUIDs, gateway EUIs and event UUIDs cleared, cloud link on | 57 | 57 | 0 | UUID fills, outbox rows from old triggers |
| synth-legacy-linked-users | as above, no link row, a legacy `linked_users` row | 13 | 13 | 0 | body line 149 |
| synth-missing-objects | booted-pop-0.8.3 without `sync_history_cursors`, `zone_shared_environment`, `idx_sync_outbox_pending` and `users.edge_originated` | 0 | 0 | 0 | phase-1 DDL takes effect |

Every source also matched on `sqlite_master` root pages, and on every source
the oracle and the runner mapped the same `node_sqlite3.node` and reported
SQLite 3.44.2. The booted-pop, private-line and gen databases are copies of
the typeof census run's outputs (same recipe, verified input hashes there),
not re-created for this run. The test-fixture
image seed is byte-identical to `seed-v0.8.0` and was not run twice.

## Measurement

Workstation (x86-64), runner on a copy of a 195 MB synthetic database
(`headmig-booted-pop-0.8.3` with 700,000 extra `device_data` rows, cloud link
on), five runs: 155-189 ms runner wall time (170-210 ms for the whole
process under `/usr/bin/time`) and 60.1-61.1 MiB peak RSS. The copy had just
been written, so the page cache was warm. Size barely matters because no
statement scans `device_data`: the `ADD COLUMN`s on it are already applied and
every data repair touches the small tables. On the 2 MB sources the runner
took 89-263 ms at the same RSS.

Pi 5 command for the lead. It copies the live database with SQLite's online
backup through a read-only connection, runs the runner against the copy under
`/tmp` and deletes the copy on every exit path. `/tmp` is tmpfs on the image, so the I/O part of
the figure is optimistic. Copy `edge/boot/run-sync-init.js`,
`gen-sync-init.js`, `sync-init.pin` and `sync-init-fn.generated.json` to
`/tmp/osi-boot-runner/` first.

```sh
sh -c '
D=/tmp/osi-boot-runner
DB="$D/farming-copy.db"
case "$DB" in /tmp/*) ;; *) echo "refusing: copy must live under /tmp"; exit 1;; esac
trap "rm -f \"$DB\" \"$DB-wal\" \"$DB-shm\"" EXIT
sqlite3 -readonly /data/db/farming.db ".backup '"'"'$DB'"'"'" || exit 1
EUI="$(uci -q get osi-server.cloud.device_eui | tr abcdef ABCDEF)"
rc=0
OSI_BOOT_DB="$DB" DEVICE_EUI="$EUI" OSI_BOOT_NODE_RED_DIR=/srv/node-red \
  OSI_BOOT_REPORT="$D/report.json" node "$D/run-sync-init.js" || rc=$?
echo "exit=$rc"
grep -o "\"wall_ms\": [0-9]*\|\"max_rss_kib\": [0-9]*\|\"sqlite_version\": \"[^\"]*\"" "$D/report.json"
'
```

The runner's own `done` line also prints `wall_ms` and `maxrss_kib`; BusyBox
has no `time -v`. Its `start` line names the sqlite3 addon it loaded, to be
compared with the one Node-RED loads on the same board.

## Packaging needs

The image needs these files and tools:

- Node.js (`node` on PATH), BusyBox `timeout` with signal selection, and `flock`.
- In `/usr/libexec/osi-boot/`, install `run-sync-init.js`, `gen-sync-init.js`,
  `sync-init.pin`, and `sync-init-fn.generated.json` together.
- Keep `/srv/node-red/package.json` with its `osi-db-helper` dependency and
  `/srv/node-red/node_modules/osi-db-helper`.
- Keep `node-red-node-sqlite` in `/srv/node-red/node_modules` or
  `/usr/lib/node/node-red/node_modules`, with the native `node_sqlite3.node`
  addon built for the image's architecture and Node runtime.

## Init order and switch-back

`osi-edge` checks the backend choice, the Node-RED process guards, and the
database recovery holds. It resolves the gateway EUI using the identity helper
and the existing UCI fallback, then runs the boot runner once before registering
the Go service with procd. A procd respawn of the Go process skips this step.
The runner gets `/data/db/farming.db` and `/srv/node-red`. Its timeout defaults
to 30 seconds. Set `osi-server.cloud.edge_boot_timeout_seconds` to a decimal
integer from 1 through 99999 seconds, without leading zeros, to override it.

The init sends runner output to syslog under `osi-edge-boot`. Exit 0 or 1
permits Go startup. A refusal, crash or timeout blocks startup and leaves a
one-line reason in syslog and `/var/run/osi-edge-boot.failed`. A detached
worker waits for the init command to exit, then calls
`osi-backend use node-red --reason boot-runner`. The switch command serializes
the choice change, stops Go and waits for its process and boot runner lock
before starting Node-RED. The saved Node-RED choice survives reboot. If
Node-RED fails to start, the worker logs the failure and exits.

`osi-backend status` shows the UTC failure record from
`/data/osi-backend/fallback.log`. A successful operator switch to edge moves
the log to `fallback.log.previous`, replacing the previous archive.

## Not covered

- A boot of the assembled OpenWrt image on Pi hardware.
- `al-link-finalize`'s start-up recovery (needs an account-link journal file).
- The 216-case release-smoke suite database (the heavy-job lane was held).
- The stock Node-RED 4.0.9 runtime; parity ran on the image runtime (3.1.15).
- Databases from the field: only synthetic sources were used.
