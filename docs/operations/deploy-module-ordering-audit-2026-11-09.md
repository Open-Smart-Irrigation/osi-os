# deploy.sh helper-module ordering audit (2026-11-09)

Verdict: running the v0.8.1 flows on the main helper modules is unsafe for a
v0.8.1 gateway upgraded to this release. Every mixed state that this upgrade
can actually reach leaves the database at migration head 70. At that head the
new `osi-valve-control` throws `no such column` on the clock tick, the
observe tick, STREGA ACK handling and plan compiles, and due one-time opens do
not fire. The new `osi-journal` cannot build the context for a zone plot
entry. The v0.8.1 modules pass the same calls on the same database. The normal
deploy path is safe: the flows and modules change together across one Node-RED
stop, and during the copy window the running process keeps the module code it
already loaded.

Audited at `origin/main` `e674aafc7` against tag `v0.8.1` (`5e20911a6`, 88
commits earlier). Open PRs #588 and #573 were checked for module changes; they
do not change the verdict (section 3.6). Line numbers refer to `deploy.sh` at
`e674aafc7`.

## 1. Mechanism

### 1.1 What deploy.sh writes, in order

| Step | Lines | Writes | Node-RED |
|---|---|---|---|
| Early fetches | 1905-1958 | `settings.js`, init scripts, identity helpers, `chirpstack-bootstrap.js` in place | running, old flows |
| Staged payload | 1969-2012 | `osi-watermark-helper/commands.js` in place (deliberate, see 1.4); flows and GUI into `payloads/<stamp>/`, activation deferred | running |
| Module block | 2016-2701 | 166 files in place: 154 files across 44 `osi-*` directories, `package.json`, `package-lock.json`, `edge-channels.json`, 9 codecs | running |
| Command ledger | 2260 (`stage_command_ledger_dependency`) | staged only, not live | running |
| ChirpStack repairs, `npm install` | 2703-2805 | `node_modules` in place | running |
| `install_deploy_exit_trap` | 2807 | arms `deploy_exit_handler` | running |
| `run_schema_migration` | 1575-1888 | stops Node-RED (1664), migrates, then `activate_command_ledger_dependency` and `swap_call flipTo "$DEPLOY_STAMP"` (1856), restarts | stopped, then new flows |
| Final activation | 2869-2890 | `flipTo` only when the migration step did not flip (no live DB, or no migration path) | restarted |
| Self-check and rollback | 2983-3036 | `flipTo "$PREV_STAMP"` | restarted on old flows |

The module block writes straight to `/srv/node-red/<module>/` through
`fetch_required`. The modules are not part of the payload directory.

Of the other in-place writes, `settings.js`, `node-red.init`, the identity
helpers and init scripts, the codecs and `edge-channels.json` are
byte-identical between v0.8.1 and main. `chirpstack-bootstrap.js` changed, but
`deploy.sh` and `osi-bootstrap` run it; no flow loads it. For this upgrade the
helper modules are the only in-place files whose change reaches the old flows.

### 1.2 What activation switches

`flipTo()` in `scripts/deploy-payload-swap.js` switches two symlinks:
`/srv/node-red/flows.json` and the GUI root. `stagePayload()` copies only
`flows.json` and the GUI tree into `payloads/<stamp>/`. No module directory is
staged, linked or recorded, so activation never touches them.

### 1.3 What rollback restores

Three places switch back to the previous payload, and all three restore only
the flows and GUI pair:

- the self-check rollback block (2983-3036);
- `restart_previous_payload()` (1346), called from `deploy_exit_handler()` on
  a failure after Node-RED was stopped;
- `cleanup_failed_first_payload()` (1386), for a first deploy, which deactivates
  and leaves Node-RED stopped.

After any of them the new module files remain in `/srv/node-red/`.

### 1.4 Precedents inside the same script

The WATERMARK command-ledger pair (`osi-command-ledger/index.js`,
`package.json`, `osi-watermark-binding/canonicalization.js`) already follows the
safe pattern. `stage_command_ledger_dependency()` stages it,
`keep_command_ledger_copy()` keeps the live copy, and
`activate_command_ledger_dependency()` moves it into place only after the
migration commits. The comment there gives the reason: the old flows must not
restart against a ledger that expects a newer schema. The self-check rollback
does not put the previous ledger back, but for this upgrade that branch is
refused (section 2.1).

`osi-watermark-helper/commands.js` is written in place at 1972, before the
payload is staged, on purpose: the staged flows advertise capabilities that
depend on it.

### 1.5 The flaky-link path

`scripts/deploy-bundle.sh` packs every file `deploy.sh` fetches
(`scripts/deploy-fetch-list.js`) plus `deploy.sh` itself.
`scripts/deploy-offline.sh` serves the extracted bundle on loopback and runs
the same `deploy.sh` under `setsid`. `scripts/deploy-push-bundle.sh` uploads the
bundle and launches `deploy-offline.sh`. None of the three writes to
`/srv/node-red/`; the ordering is identical on both paths.

### 1.6 Partial module tree on a fetch failure

`deploy.sh` runs under `set -eu`. A `fetch_required` failure in the middle of
the module block exits while only the `cleanup` trap is armed (the exit
handler is installed at 2807). A module can be left with a new `index.js` and an
old sibling file. The header of `scripts/verify-module-file-deploy-coverage.js`
records what that does: a `require('./<sibling>')` that throws fails the whole
module load.

## 2. When old flows meet new modules on a v0.8.1 upgrade

### 2.1 The post-flip rollback branch is refused for this upgrade

v0.8.1 is at migration head 70. Main adds `0071` to `0078` (seven additive,
`0078__clear_lorain_legacy_rain_rate.sql` is `data`). On a v0.8.1 gateway the
migration therefore always commits before the flip. The previous payload's
`compatibility.json` records head 70 (`write_payload_compatibility()`; the
v0.8.1 `deploy.sh` already wrote it). After the commit, both the self-check
rollback block and `restart_previous_payload()` call
`verify_payload_db_compatibility()`, and `verifyCompatibility()` compares the
recorded head and ledger with the database. Head 78 against 70 fails, so the
script refuses the rollback and holds Node-RED stopped. The hypothesised case
(self-check fails, rollback, old flows on new modules) does not occur on this
upgrade.

A release with no new migrations does reach that branch, and then nothing
refuses it.

### 2.2 The reachable mixed states

| Path | Trigger | Database | Result |
|---|---|---|---|
| (a) copy window | any deploy, from line 2016 until the stop at 1664 (fetches, ChirpStack repairs with 20 s gRPC deadlines, `npm install`, runner fetch) | head 70 | old flows run module code cached at startup; a module loaded for the first time in this window, or retried after `osi-lib`'s 30 s cooldown, loads the new files |
| (b) failure before the stop | any exit between 2016 and 1664: a failed fetch, ChirpStack bootstrap exit, `materialize_native_sqlite3`, `npm install`, `install_irrigation_clock_hook`, `quiesce_identityd_for_deploy`, or the early returns in `run_schema_migration` (runner fetch, backup directory, disk preflight, missing retained compatibility) | head 70 | Node-RED keeps running cached old code; the next restart (reboot, power loss, crash respawn) loads the new modules under the old flows |
| (c) failure after the stop, before the commit | any `return 1` in `run_schema_migration` between 1664 and the commit flag: stop wait (1684), `checkpoint_live_db` (1688, 1778), ledger reads (1701, 1707), reconcile probe (1745, 1749), `fetch_reconciliation_assets` (1756), reconciliation apply (1765), `repair-sync-outbox-v2.js` (1771), `baseline-existing-db.js` (1774), `migrate-cli.js` failure | head 70 (`migrate-cli.js` restores the byte image, because `0078` is `data` and forces a backup) | `deploy_exit_handler()` calls `restart_previous_payload()`; compatibility matches at head 70; the script restarts Node-RED on the old flows with the new modules and prints `OK: rollback Node-RED readiness confirmed` |

Path (c) needs any one post-stop preflight to fail, not only a migration. The
readiness probe after it, `wait_for_node_red_health()`, checks the service
state and `/gui` reachability, so it reports the gateway healthy while valve
control fails. A parse failure of the migrate output (1784-1802) happens after
the commit but before the flag is set; `restart_previous_payload()` then finds
head 78, refuses, and holds Node-RED stopped, which is not a mixed state.

The command ledger stays at the v0.8.1 version on all three paths, because its
activation waits for the commit.

## 3. Compatibility audit, v0.8.1 to main

### 3.1 Method

1. Loaded every non-test `.js` file in each `osi-*` directory of both trees and
   recorded each export's name, arity and a hash of its source.
2. Parsed every function node in the v0.8.1 `flows.json`: `libs` bindings,
   `osiLib.require('<name>')` resolved through the v0.8.1 `osi-lib` registry,
   and the member names used on each binding.
3. Intersected the two. For members whose body changed, read the diff; for
   modules whose new code references schema objects from `0071` to `0078`, ran
   the new and the old module against copies of the v0.8.1 seed database
   (`usr/share/db/farming.db` at `v0.8.1`, head 70), using the argument shapes
   from the v0.8.1 function nodes. The main seed (head 78) is the control.

### 3.2 API surface

No module directory was removed or renamed. Four were added: `osi-irrigation-policy`,
`osi-local-password-reset`, `osi-matric-potential` and `osi-rain`. The v0.8.1
flows reference none of them. Third-party npm dependencies are unchanged;
`package.json` only adds the four `file:` entries. `osi-lib` only adds registry
names (`history-helper`, `local-password-reset`, `rain`,
`osi-irrigation-policy`).

No member that the v0.8.1 flows call was removed. Signature changes on called
members:

| Module | Member | Change | Effect on v0.8.1 calls |
|---|---|---|---|
| `osi-zone-env` | `buildDisplayStatus` | 7 to 8 parameters, new trailing `fallbackReasonCode` | old calls pass 7; the code is `undefined` |
| `osi-valve-control` | `store.ackPush` | 7 to 8 parameters | internal to the module; flows do not call it |
| `osi-valve-control` | `push.compileAndQueue` | arity 1 to 0 (options default) | same options object accepted; fails on schema, see 3.3 |
| `osi-chirpstack-helper` | client `enqueueDownlink` | optional `expiresAt` | not called by the v0.8.1 flows |

`osi-valve-control` `store.listQueued` and `store.lastPushHashes` were removed;
the v0.8.1 flows do not call either. One behaviour change comes from the
registry: the v0.8.1 flows call `osiLib.require('history-helper')`, which fails
under the v0.8.1 `osi-lib` (the #564 bug). Under the new `osi-lib` it resolves,
and the two members used (`parseRecordedAtMs`, `resolveDeviceTimezones`) exist.

### 3.3 Schema dependence

The API is compatible; the schema is not. These new modules reference objects
that `0071` to `0078` create, with no table or column presence check:

| Module (loaded by v0.8.1 flows) | Objects | Guarded? |
|---|---|---|
| `osi-valve-control` | `transport_json` (0076), `condition_policy_uuid` (0076), `conditional_control_json` (0076), `irrigation_policies`, `irrigation_occurrences` (0076) | no |
| `osi-journal` (`context.js`) | `zone_rain_source` (0072) | no |
| `osi-history-sync-helper` | `valve_actuation_expectations.transport_json` (0076), new table entry `tensiomark_observations` (0074) | no |
| `osi-sdi12-commissioning` (`tensiomark.js`) | `tensiomark_observations` (0074) | no; reached only for a Tensiomark layout |
| `osi-history-helper` | `rain_instrument_days` (0072) | yes, `instrumentDays()` returns `[]` on `no such table` |
| `osi-zone-env` | `rain_policy_version`, `rain_coverage`, `rain_received_mm` (0072) | yes, pure functions; a null `rain_policy_version` takes the legacy branch |

### 3.4 Empirical results

`osi-valve-control`, one GEN1 STREGA valve, one weekly schedule, one one-time
open due a minute ago:

| Call (v0.8.1 node) | v0.8.1 module, head 70 | main module, head 70 | main module, head 78 |
|---|---|---|---|
| `store.getSettings` (Valve ACK ledger) | ok | ok | ok |
| `push.compileAndQueue` (Valve ACK ledger) | ok | throws `no such column: conditional_control_json` | ok |
| `runHousekeeping` (Valve clock sync) | ok | ok, warns `pending clears unreadable: no such column: conditional_control_json` | ok |
| `runClockTick` (Valve clock sync) | ok | throws `no such column: transport_json` | ok |
| `runOnceTick` (Fire due one-time opens) | ok, 1 open emitted, row `FIRED` | ok, 0 opens emitted, `one-time dispatch failed ... no such column: vae.transport_json`, row stays `PENDING` | ok, 1 open emitted |
| `runObserveTick` (Observe valve-fired opens) | ok | throws `no such column: conditional_control_json` | ok |
| `runTriggerBackfill` | ok | ok | ok |
| `handleUplink` (Valve ACK ledger) | ok | throws `no such column: conditional_control_json` | ok |
| `emitRuntimeChanged` (Write STREGA Expectation) | ok | ok | ok |
| `clearValveOnUnclaim` | ok | ok | ok |

The failure is fail-closed for actuation: no downlink is emitted for the
one-time open, and the row stays `PENDING`, so it would fire late once the
schema matches. The STREGA keeps running its own on-device weekly plan, but
the edge cannot push plan changes, record ACKs or observe valve-fired opens.

`osi-journal` `buildContext()` for a zone: the v0.8.1 module succeeds at head
70; the main module fails with `no such table: zone_rain_source` at head 70 and
succeeds at head 78. `generatedContextJson()` in `lifecycle.js` calls it inside
the entry transaction, so saving a journal entry on a zone plot fails.

`osi-history-sync-helper`: every SQL statement the v0.8.1 `Build History Batch`
and ACK nodes request was prepared against each schema. At head 70 the main
helper fails for `valve_actuation_expectations` (`no such column:
vae.transport_json`) and for `tensiomark_observations` (`no such table`), which
the old flow now iterates because it takes the table list from
`helper.tableNames()`. The other eight tables prepare as under v0.8.1. The old
node writes `history_sync_last_table` before it queries, so table rotation
continues; those two tables stop syncing and log an error each round.

### 3.5 Modules named in the review

| Module | v0.8.1 to main | Old-flow exposure |
|---|---|---|
| `osi-irrigation-policy` | new | not referenced by v0.8.1 flows |
| `osi-local-password-reset` | new (#521, changed by #569) | not referenced by v0.8.1 flows |
| `osi-chameleon-helper` | byte-identical | none |
| `osi-module-defaults` | byte-identical | none |
| `osi-scope-helper` | additive: `DRAGINO_SDI12` in the soil-depth set, a concurrent-invalidation fix in `resolveScope`, `assertAuthenticatedRole` reads `role` and `disabled_at` (present since 0033); same return shapes | compatible |
| `osi-lib` | registry additions only | compatible; `history-helper` now resolves |
| `osi-valve-control` | schema-dependent rewrite (#572 and earlier) | breaks at head 70 (3.4) |
| `osi-history-sync-helper` | new tables and columns | two tables fail at head 70 (3.4) |
| `osi-journal` | `context.js` joins `zone_rain_source` | zone plot entries fail at head 70 (3.4) |
| `osi-command-ledger` | additive exports | not live before the commit (1.4) |

### 3.6 Open PRs

#588 (head `310174cdc`) changes only `osi-irrigation-policy` among the modules,
which the v0.8.1 flows do not load. #573 (head `04243f9be`) changes flows and
adds additive migration `0079`; it changes no module. With #573 merged, the
upgrade still commits migrations before the flip, so section 2.1 still holds.

### 3.7 Not exercised

`handleHttpRequest` for the valve API needs a signed token and was not run.
`applyCloudCommand` was called but stopped at payload validation, so its
database path was not reached. `osi-sdi12-normalize` and
`osi-sdi12-commissioning` were not run with a Tensiomark layout. The window
analysis in 2.2 (a) relies on `osi-lib` caching successful loads and on the
v0.8.1 `osi-valve-control` having no lazy `require()`; both were read, not
measured on a gateway.

## 4. Fix sketch

Both variants have to deal with two constraints:

- `npm install` runs before the stop, and it needs every `file:` dependency
  directory to exist. A module that is new in the release must be on disk
  before that step. Writing only absent module directories in place is safe,
  because old flows cannot reference a module that did not exist.
- Payloads from earlier deploys have no module copy. The first deploy with the
  fix has to capture the live module directories as part of the retained pair,
  with the same immutability evidence that `captureExisting()` and
  `legacyCaptureStamp()` use for flows and GUI.

### Variant A: modules inside the payload

Stage module files into `payloads/<stamp>/modules/<module>/` and make
`/srv/node-red/<module>` a symlink. `flipTo()` switches the module links
together with flows and GUI; the rollback block, `restart_previous_payload()`
and `cleanup_failed_first_payload()` get the same switch for free.
`node_modules/<module>` already points at `../<module>`, so it follows the link.

Touches `stagePayload()`, `flipTo()` (with restore of already-switched links
on a partial failure), `captureExisting()`, `verifyPair()`, `discardPayload()`
and `prunePayloads()` in `scripts/deploy-payload-swap.js`; in `deploy.sh`, the
destination of 154 `fetch_required` calls (mechanical) and the legacy-capture
block at 1991-2009. `atomicSymlink()` already converts a real directory into a
link with a backup. Each retained payload grows by the module tree (3.0 MB of
runtime files at main, 5.4 MB if test files are staged too), times
`PAYLOAD_KEEP_N=5`.

### Variant B: generalise the command-ledger pattern

Fetch modules into `$TMP_DIR/modules`, keep a copy of the live module tree,
and activate after the commit, beside `activate_command_ledger_dependency()`
and before the flip. Restore the kept copy in the self-check rollback block,
in `restart_previous_payload()`, and in the exit handler before any restart on
the previous payload. This needs no change to the payload format, but it adds
copy and restore steps to three failure paths that already carry several holds
and refusals.

### Recommendation and size

Variant A, because it ties modules to the existing pair proof instead of
adding a second restore mechanism. Estimate: 150 to 250 lines of
implementation across `deploy-payload-swap.js` and `deploy.sh`, plus tests,
several hundred lines in total. Tests that must follow:
`scripts/deploy-payload-swap.test.js`, `scripts/deploy-payload-lifecycle.test.js`,
`scripts/test-deploy-atomic-payload-wiring.js`,
`scripts/test-deploy-migration-wiring.js`,
`scripts/verify-module-file-deploy-coverage.js` (it expects
`/srv/node-red/<module>/` destinations), `scripts/deploy-fetch-list.test.js`,
`scripts/deploy-corpus.test.js`, `scripts/deploy-bundle.test.sh` and
`scripts/deploy-offline.test.sh`. None of the existing suites covers module
activation or rollback today. The change is a deploy-path risk class and
belongs in the plan-first loop of `docs/engineering-playbook.md` §2. It was not
implemented in this audit; the `COMMAND_LEDGER_*_SHA256` pins are untouched.

## 5. Release readiness

The normal path is safe for v0.8.1 to this release: migration, module set and
flows meet after one stop. The risk sits on failed deploys. Until the fix lands,
an operator who sees a v0.8.1 gateway end a deploy with `OK: rollback Node-RED
readiness confirmed` and exit 1, or any exit 1 before `--- Stop Node-RED for
schema migration ---`, should re-run the deploy rather than leave the gateway
on the previous payload. A note to that effect in `osi-live-ops-runbook`
(`references/deploy.md`) is the short-term mitigation.

## Appendix: reproduction

Extract both trees and seeds (outside `/tmp` if its quota is tight):

```sh
P=conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share
mkdir -p old new
git archive v0.8.1 "$P/node-red" "$P/flows.json" | tar x -C old --exclude="$P/node-red/node_modules"
git archive origin/main "$P/node-red" "$P/flows.json" | tar x -C new --exclude="$P/node-red/node_modules"
git show "v0.8.1:$P/db/farming.db" > seed-v081.db
git show "origin/main:$P/db/farming.db" > seed-main.db
node vc-old-schema.js "old/$P/node-red/osi-valve-control" seed-v081.db
node vc-old-schema.js "new/$P/node-red/osi-valve-control" seed-v081.db
node vc-old-schema.js "new/$P/node-red/osi-valve-control" seed-main.db
```

`vc-old-schema.js` (condensed; the journal and history-sync checks follow the
same pattern with `buildContext()` and `db.prepare()` on each helper query):

```js
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { DatabaseSync } = require('node:sqlite');
const [vcDir, seed] = process.argv.slice(2).map((p) => path.resolve(p));
const facade = (raw) => ({
  get: (s, p) => Promise.resolve(raw.prepare(s).get(...(p || []))),
  all: (s, p) => Promise.resolve(raw.prepare(s).all(...(p || []))),
  run: (s, p) => { const r = raw.prepare(s).run(...(p || [])); return Promise.resolve({ changes: Number(r.changes), lastID: Number(r.lastInsertRowid) }); },
  async transaction(fn) {
    raw.exec('BEGIN IMMEDIATE');
    try { const out = await fn(facade(raw)); raw.exec('COMMIT'); return out; }
    catch (e) { try { raw.exec('ROLLBACK'); } catch (_) { /* rolled back */ } throw e; }
  },
  close: (cb) => { if (cb) cb(); },
});
const EUI = '0016C001F1000001';
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vc-'));
  fs.copyFileSync(seed, path.join(dir, 'f.db'));
  const raw = new DatabaseSync(path.join(dir, 'f.db'));
  const db = facade(raw);
  raw.exec("INSERT INTO users(id, username, password_hash, created_at) VALUES (1,'t','x',datetime('now'))");
  raw.exec(`INSERT INTO devices(deveui, name, type_id, user_id, created_at, updated_at) VALUES ('${EUI}','Valve A','STREGA_VALVE',1,datetime('now'),datetime('now'))`);
  raw.exec(`INSERT INTO valve_settings(device_eui, strega_generation, updated_at) VALUES ('${EUI}','GEN1',datetime('now'))`);
  raw.exec(`INSERT INTO valve_schedules(schedule_uuid, device_eui, kind, label, weekdays_mask, start_time, duration_minutes, timezone, enabled) VALUES ('11111111-1111-4111-8111-111111111111','${EUI}','WEEKLY','w',127,'06:00',10,'UTC',1)`);
  raw.exec(`INSERT INTO valve_schedules(schedule_uuid, device_eui, kind, label, fire_at, duration_minutes, timezone, enabled, once_state) VALUES ('22222222-2222-4222-8222-222222222222','${EUI}','ONCE','o',strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'),5,'UTC',1,'PENDING')`);
  const VC = require(vcDir);
  const warn = (m) => console.log('  warn: ' + m);
  const now = new Date();
  const emitted = [];
  const calls = {
    getSettings: () => VC.store.getSettings(db, EUI),
    compileAndQueue: () => VC.push.compileAndQueue({ db, deviceEui: EUI, appId: 'app', force: true, now, flushQueue: async () => ({ statusCode: 200 }), warn }),
    runHousekeeping: () => VC.runHousekeeping({ db, now, appId: 'app', warn }),
    runClockTick: () => VC.runClockTick({ db, now, appId: 'app', warn }),
    runOnceTick: () => VC.runOnceTick({ db, now, warn, onError: (e) => warn(e.message), emit: (f) => emitted.push(f) }),
    runObserveTick: () => VC.runObserveTick({ db, now, warn }),
    runTriggerBackfill: () => VC.runTriggerBackfill({ db, warn }),
    handleUplink: () => VC.handleUplink({ db, deviceEui: EUI, decoded: { Schl_Port: 14, Schl_status_Port: 1 }, fPort: 14, rawBytes: null, receivedAt: now.toISOString(), warn }),
    emitRuntimeChanged: () => VC.emitRuntimeChanged(db, EUI, warn),
    clearValveOnUnclaim: () => VC.clearValveOnUnclaim({ db, deviceEui: EUI, appId: 'app', flushQueue: null, warn }),
  };
  for (const [name, fn] of Object.entries(calls)) {
    try { await fn(); console.log('OK    ' + name); }
    catch (e) { console.log('THROW ' + name + ': ' + e.message); }
  }
  console.log('one-time opens emitted: ' + emitted.length);
  console.log(JSON.stringify(raw.prepare("SELECT once_state FROM valve_schedules WHERE kind='ONCE'").get()));
  raw.close();
  fs.rmSync(dir, { recursive: true, force: true });
})();
```
