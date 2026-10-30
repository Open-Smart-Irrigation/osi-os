# Issue #356: durable Chameleon diagnostic link and legacy threshold scheduler eligibility (plan r4)

## Status

Source-only amendment for review; not approved. Producing it ran no product code, test, editor, materializer, probe, checker, install, fetch, checkout, ref change, commit or wrapper. Every outcome below is a forecast and is UNRUN. The author is Opus, in the writer role.

This report stands alone. It replaces plans r1 to r3 as the text the committed packet carries. The earlier plans, their resources, the reviews and all r1 captures stay unchanged in the campaign directory as history. The design accepted in the r3 source review is kept. This revision fixes the four required corrections of that review, records the parent's migration allocation, and adds three verifier dependencies the author found while fixing them.

Next: a fresh independent Sol source review. After acceptance comes the parent-owned plan-only commit (stage M), then the three-provider council on that commit. This revision between review rounds is not a council round.

## Current-main rebinding (2026-10-29)

This section governs the execution binding. The Status paragraphs above, the stage M section and the r3 response tables record the P-based history and stay as written.

Plan commit `M` is `1b5de43a1d5e0fcf0ce7588a0c9cc937893a909a` (parent P, tree `ac9983ce7eebe0a558fec2c670b6665bb074aded`). Council round 1 on `M`: Sol APPROVE 9/10 and Claude Fable APPROVE 9/10, no required finding. The third member, OpenCode Go DeepSeek V4 Pro, has not voted (provider quota). The user's instruction of 2026-10-29 lets Opus author and Sol verify in the interim. That is no full three-provider council, and a risk-class merge still needs the maintainer.

`origin/main` then moved to `B` = `bd1afcd248616653e1962081c8c9e3d7b19d650f` (17 commits, #541 to #568). `M`'s E0 fence requires `FETCH_HEAD` = P, so `M` cannot execute on current main as written. This rebinding commit, `M1`, has parent `B` and carries the same packet:

- the nine resource files are byte-identical to `M` (same blob ids), so the editors, proposals and proposed tests are the ones the round-1 votes reviewed;
- `scripts/verify-doc-hygiene-allowlist.json` is byte-identical to `M`'s, because `B` did not change that file;
- only this plan text changes: this section and the execution bindings below.

Correction after review: Sol's source review of `M1` (`43ee9d90b9133ce773ac6882abe3f022082952ea`, 2026-10-29) accepted it with two bounded corrections, complete input accounting and explicit commit identities. `M1c` replaces `M1` as the plan-only head. It has the sole parent `B`, the same nine packet blobs and allowlist blob, and amends only this plan text: the accounting below, command correction 1, E1's comparison base, the identities in C1.9, C3.10 and C4.4, and the head that E0 binds. `M1` stays as a historical object. The execution report records `M1c`'s id; E0 binds that id, never `M1`'s.

The packet's product/editor/harness inputs are unchanged; changed gate inputs are accounted for below. Equality is by `git rev-parse` of P and `B` objects:

| Input | P to `B` |
| --- | --- |
| both `flows.json` profiles, every verifier and test the editors anchor on or edit (the nine blobs in "Binding", plus `verify-runtime-schema-parity.js`, `verify-db-schema-consistency.js`, `verify-lsn50-chameleon-persistence.js`, `test-unified-soil-tension-scheduler.js`, `verify-flows-size-ratchet-baseline.json`) | identical |
| measurement and harness code (`flows-size-scan.js`, `verify-no-new-silent-catch.js`, `verify-flows-size-ratchet.js`, `scripts/lib/`, `scripts/fixtures/`) | identical |
| `lib/` and `database/` trees (migration runner, ordered migrations, `CHECKSUMS.json`, seed SQL, calibration seed), the seven bundled `farming.db`, `seed-db-paths.js`, `build-seed-db.js`, `apply-chameleon-calibration-seed.js` | identical; migration head still `0077`, 77 SQL files, no `0078__` |
| `.github/workflows/verify-sync-flow.yml`, `docs/operations/unified-soil-tension.md`, the playbook, `.claude/skills/` | identical |
| `node-red` helper trees of both profiles | only `osi-valve-control/api.test.js` and `store.test.js` changed, with one blob each across both profiles; no helper module changed. No #356 editor or test loads them; profile parity reads them (below) |
| `AGENTS.md` | one added rule for integration merges (below) |
| `verify-test-inventory.json`, `test-inventory.yml`, `migrations.yml`, `typecheck.yml` | changed: inventory count is 921 at `B` (915 at P) |
| `verify-doc-hygiene.js` | scope adds one GUI test file; patterns and allowlist rules unchanged |
| new or changed tests and checkers (`verify-migrations.test.js`, `test-apply-chameleon-calibration-seed.js`, `verify-merge-allowance-preservation.js` and its test, reconcile-ledger tests, `test-owned-scratch.js`) | none is required or spawned by an editor or a proposed test; the gates that read two of them are listed below |

Changed gate inputs. Sol's review of `M1` compared the whole tree: 74 paths changed from P to `B` and 17,838 are identical. Its campaign receipt `issue-356-current-base-sol-review-r1/whole-tree-delta.json` lists every changed path with its P and `B` blobs, and `whole-tree-P-to-B.diff` holds the complete delta. These changed paths are read by a gate below:

| Changed input | Reader | Disposition |
| --- | --- | --- |
| `web/react-gui/src/components/farming/IrrigationZoneCard.tsx`, blob `a7d2aa007e18a28a81efa8f2be6867216cfe23e` to `d5afbfa2a24f978649053296a1755e7b7cba555f` | `verify-sync-flow.js` line 78 reads it for source needles | The diff adds only `canWrite={canWrite}` to the rain banner. The verifier's seven positive needles still occur once each and its two exclusions stay absent, so its assertions are unchanged. The sync-flow run at E1 and the gate run confirm it. |
| `osi-valve-control/api.test.js` (blob `19976944f16fdc8bf47a1a34886aa98fdae46aec`) and `store.test.js` (`acd60dc7da4d775870ae177f6d75053b78c339d3`), both profiles | `verify-profile-parity.js` hashes every file under `files/usr/share/node-red`, tests included, directly and chained from `verify-sync-flow.js` | Both profiles carry the same blobs, so the parity forecast stands. The API test's new GUI JSON fixture is a dependency of that test in CI; parity hashes the text and does not load it. |
| every workflow (`migrations.yml`, `test-inventory.yml` and `typecheck.yml` changed), `verify-test-inventory.json`, `web/react-gui/package.json`, the new `web/react-gui/playwright.device-registration.config.ts`, the sources of listed indirect runners and the tracked test-name set | `verify-test-inventory.js` | 915 at P, 921 at `B`; the two installed tests give 923 (C4.3). The browser config names a new spec, the package supplies its command and `typecheck.yml` invokes it. This is collection evidence, not a browser run. |
| `verify-doc-hygiene.js` and the changed documents and workflows it scans | the hygiene gates | The scope adds `ValveCard.test.tsx`; patterns and allowlist semantics are unchanged. Built-in patterns only; the maintainers' private term list is not modelled. |
| `scripts/verify-migrations.test.js` | schema gate | It copies the committed ordered directory and requires `checksum manifest OK`; 0078's manifest entry is part of that copy. That case no longer proves base immutability, so the direct `B`-pinned `verify-migrations.js` stays required. |
| `scripts/test-apply-chameleon-calibration-seed.js` | schema gate | It runs its writer and SQLite children only in copied sandboxes and checks calibration rows, overlap preservation, the seven paths and source-image custody. The additive link table changes none of those rows; the candidate run stays required. |
| `scripts/verify-sync-op-parity.js` | no #356 gate | One migration-number comment changes, 0065 to 0067; no executable change. |

The remaining changed documents, operations scripts, analyzer, ledger-recovery tests, field harness and GUI bodies are covered by that manifest. Tracked names, hygiene and CI may read them, but none is a runtime or harness source that an editor or focused #356 test loads. `verify-command-safety.js` reads seven GUI control and type files, all unchanged from P to `B`. Every gate below stays required.

Every measured number in this plan therefore holds at `B`: the four base and two dependency function hashes, 1617501 per profile, committed baseline 1616019, standing total delta 47589, 80 empty catches, the anchors and the 0077 head. The editors already take the base as an argument and check it, so they need no change; only their printed short base id becomes `bd1afcd24`.

Command corrections carried by this rebinding:

1. The active E0 fetch is `git fetch --no-tags --refmap= origin main`, so only the checkout's own `FETCH_HEAD` moves and no shared remote-tracking ref changes.
2. The E0 fence is `FETCH_HEAD` = `B`. If main moves past `B`, execution stops for another reconciliation. No later main is accepted without one, and the fence is not relaxed.
3. Base-ref variables and editor base arguments use `B` (identical results to P for the inputs above, and correct for any check that reads the whole tree).
4. Inventory: the C4.3 count is two above `B`, 923.
5. Schema gates add `node --test scripts/verify-migrations.test.js`, which since #562 copies the committed ordered directory and requires `checksum manifest OK` (0078 extends that manifest).

Integration merges: `B`'s `AGENTS.md` requires a both-parent reconciliation after any integration merge, including `node scripts/verify-merge-allowance-preservation.js --left-ref HEAD^1 --right-ref HEAD^2`, with a SHA-bound, measured disposition for each unmatched allowance entry. This recipe performs no merge and no rebase. If a later integration merge of this branch is ever made, that rule applies in full. #356 replaces two consumed node entries and resets the total delta, so each of those changes needs its own disposition there.

Open composition, not consumed here: #521 (draft PR 569, unmerged) adds a router allowance and retires a spent ceiling; the #443 replacement plan is in review. Both touch the allowance, catch-baseline and verifier files that #356 also edits. #356's total reset is computed only against `B`'s allowance file, and the ratchets phase refuses unless that file still equals `B`, so it cannot erase another merged allowance. Whichever branch reaches main second recomputes its own growth on the new base. #302 (native recovery, reviewed head not on main) touches deploy and seed paths. If it merges first, `B` is stale and E0 stops.

## Governing decisions

The user's decisions of 2026-10-28 (campaign file `user-decisions-20261028-1850.json`) govern and are not reopened:

1. The legacy threshold scheduler needs a durable row link between a canonical Chameleon reading and its diagnostic, written from the same uplink event. Every unlinked reading is excluded, including one whose device and timestamp pair is unique. No timestamp backfill, nearest or latest matching, or inferred historical proof creates a link.
2. A Chameleon value counts for the scheduler only inside inclusive 0..300 kPa. The Water card keeps its shared 0..1,000,000 kPa domain. KIWI, CLOVER and SDI-12 are not capped at 300.
3. #355 owns how finite out-of-range values are displayed; the Water card domain does not change.
4. The council uses OpenCode Go DeepSeek V4 Pro in place of Gemini Argon. Three independent providers are required.
5. Independent Sol verification is the final review of new Opus-authored work. No extra final Opus round applies. The three-provider council remains.

## Binding

| Item | Value |
| --- | --- |
| Base P | `f6682ef6d0d90355bded9789fb4d423136ab02bb`, read as Git objects only |
| Execution base B | `bd1afcd248616653e1962081c8c9e3d7b19d650f`, current main fetched 2026-10-29; see "Current-main rebinding". E0 requires a fresh `FETCH_HEAD` equal to it, otherwise stop |
| `B` `AGENTS.md` blob | `846790170e70766b5ba6527804ee56c627d1931d`; the playbook blob is unchanged |
| Migration head at P | `0077__conditional_irrigation_sync.sql`, unchanged at `B` |
| Migration version | `0078` |
| Allocation record | campaign `ledger.json` `migration_coordination`, 2026-10-28T20:13:58Z: slot 0078 reserved for #356 on P; the earlier #377 reservation of 0078 is retired for future execution, its artifact and receipts untouched |
| P `AGENTS.md` blob | `13829e45f5ada2c2da621802eb38219c83e5de38` |
| P playbook blob | `8d235f5ec034a2f2e277b8abab0d46807ef4b150` |
| Both `flows.json` profiles at P | blob `9e981742777a6e53f13d56d86ae87c0b3e844788` |
| `scripts/verify-sync-flow.js` at P | blob `7cbe4b055b5fb6b451e88bd167c269cfde656785` |
| `scripts/verify-live-gateway-identity.js` at P | blob `21b6310091692148cf1b13d9793a8358ab081a84` |
| `scripts/test-watermark-ingest-flow.js` at P | blob `8052324385a26df4090875b95381c3fd0ed45534` |
| `scripts/verify-lsn50-chameleon-swt.js` at P | blob `2c6256afcc1d1448518299dc331d48b4dcf41826` |
| `scripts/test-conditional-irrigation-integration.js` at P (read-only) | blob `36f1e8bbcb01d31d6851e39cf58db1d53eac7884` |
| `scripts/verify-flows-size-ratchet-allowances.json` at P | blob `c8714418f66f6ebe69fe045a479f3168fa024286` |
| `scripts/fixtures/silent-catch-baseline.json` at P | blob `d6fca668da9aefa5955f68694319c0b007373193` |
| Author checkout | `t3/issue-356-durable-link-r4` at `5b7f3a4a2c39445c61409193a883f20d8f50be38`, clean, never advanced |

The allocation was made on P. The ledger's conditions were that a fresh fetch still shows P with head 0077 before materialization, that the committed plan binds 0078 before the council, and that every gate stays required. Main has since moved to `B` with head still 0077; the parent re-records 0078 for #356 on `B` before execution. If main moves past `B`, execution stops for the parent to reconcile. It does not rebase, merge, pick 0079 or leave a gap. `verify-migrations.js` requires contiguous versions (lines 218-219 at P); both the materializer and the schema phase of the repository editor check that 0078 is the next contiguous version at their checkout and refuse otherwise.

## Provenance

These campaign files are history. They are not part of the committed packet, and nothing after stage M reads them:

- plan r1 `issue-356-bounded-fix-plan-r1.md`; the BASE oracle reports `issue-356-oracle-prepare-r1.md`, `issue-356-oracle-execute-r1.md` and `issue-356-evidence-review-r1.md` with their captures;
- plan r2 `issue-356-durable-link-plan-r2.md` (SHA-256 `f60346229acfb1a7769a328d1e8ef2e68d86730f69cda21c364f20a132b3dab0`) and its review `issue-356-durable-link-plan-review-r2.md`;
- plan r3 `issue-356-durable-link-plan-r3.md` (SHA-256 `a92377a83956f9d52f1956193baad3e2e117368eccbd59c6c0dae91f94b768e1`) and its review `issue-356-durable-link-plan-review-r3.md` (SHA-256 `fc9834712b03b79c563767fdc6ed6c3c2eddeb121d70719ccbbd77d65f4fdf76`).

The r1 oracle's fourteen eligibility failures and twenty passing controls remain as recorded. They cover the legacy query and decision functions on synthetic stored rows only: no radio delivery, valve movement or normal ingest producing those rows.

The campaign-only materializer is `materialize-plan-packet.cjs` in the r4 resource directory, SHA-256 `ea5a1c64d35ddbd048a47e07f66502328c8684fe4d13966952aae5ef0f7e3940`. It writes the packet and is not part of it. This report carries no hash of itself; the parent supplies the reviewed SHA-256 to the materializer, and the plan commit's own id, parent and tree bind the packet after stage M.

## Response to the r3 source review

| # | Sol r3 finding | Response | Where |
| --- | --- | --- | --- |
| 1 | P1: both test helpers read `payload.action`; the decision node returns `{ payload: cmd }` with `cmd.data.action` (lines 392-407, 438) | Both helpers now assert `payload.type === 'actuator_command'`, `payload.device.devEui` equal to the zone valve, `payload.data.action === 'OPEN_FOR_DURATION'`, `payload.data.reason === 'scheduler_threshold'`, and the `'IRRIGATE', 'scheduler_threshold'` event row. The no-command assertions are unchanged. Product envelope untouched. Forecasts are reconciled, and the r3 error is kept as history under "Test inventories and forecasts". | both proposed tests; forecasts |
| 2 | P2: stage M packet depended on uncommitted r2 prose; broken link to the campaign-only materializer | This report carries every applicable design, failure and acceptance section itself. Superseded r2 decision options and the final-Opus gate are dropped. The materializer is named in plain text with its hash, never linked. It now refuses any link that does not resolve to a packet resource. | whole report; "Provenance"; materializer |
| 3 | P2: identity verifier pins catches at 80 (lines 1119-1121) and total delta at 47589 (lines 1662-1664) | New editor phase `identity-pins` moves both strict-equality pins to the measured values (77 and 6830 at P) with anchored edits and a rationale comment each. It re-measures both at HEAD and B and refuses on drift, or when the file differs from B. No other identity guard changes. A forecast RED between the ratchet and pin phases shows the coupling. The direct identity run and the chained sync-flow run are both gates. | `apply-repo-edits.cjs` `identity-pins`; C3.6-C3.8 |
| 4 | P2: `verify-sync-flow.js` lines 2866-2868 pin `COALESCE(dd.swt_3, NULL)` and the old `CASE` count | Editor phase `verifiers` replaces only those two assertions. Channel 3 is checked through its selection, raw read, eligibility and the eligible-channel denominator. It keeps the device predicate line and adds the link, same-device diagnostic, clean-row, domain and WATERMARK guards plus one exclusion of timestamp association. Every needle is checked against the edited body before writing. No SQL comment is added to the product. | `apply-repo-edits.cjs` `verifiers`; C3.3-C3.4 |
| - | Stale allocation blocker text in r3 | Replaced by the parent record: 0078 on P, fail-closed on drift. | "Binding" |
| - | Ratchet phase checked only lengths for untouched nodes, but r3 claimed "unchanged" | The shared measurement now requires every untouched function body to be byte-identical to B; the four owned nodes must grow by exactly the planned amounts. The flow editor's own post-write check compares node content as before. | `apply-repo-edits.cjs` `measure()` |

Three dependencies found by the author while fixing findings 3 and 4. Each would have made a planned gate fail or a WATERMARK guard misreport:

| # | Finding | Response |
| --- | --- | --- |
| A | `scripts/test-watermark-ingest-flow.js` (CI step `node scripts/test-watermark-ingest-flow.js`). Cases (f) for `SWT_1` and `SWT_AVG` and (f2) expect an unlinked Chameleon row to count, which the user's decision 1 now excludes. Case (g) matches the interlock line with a four-space indent and freezes the SWT topic against `BASE_REF`. The r3 candidate fails all four (forecast `FAIL: 4 of 15`). | Phase `verifiers` gives each scheduler fixture row a clean diagnostic linked by id. The interlock alone then keeps the WATERMARK rows out, and the Chameleon row still counts. The interlock constant takes the new ten-space indent, so the literal count stays exact. Case (g) compares only DENDRO while `BASE_REF` predates the rewrite, and freezes every metric again once `BASE_REF` carries the link. Every assertion of the interlock itself is kept. |
| B | `scripts/verify-lsn50-chameleon-swt.js` line 141 pins `COALESCE(dd.swt_3, NULL)`. Line 75 calls `chameleon.calibrationFromDeviceRow`, which P's helper does not export (exports at helper lines 66-72). A real base run is therefore expected to stop at line 75 before line 141. Source evidence only, not an observed RED. The verifier is not in CI. | Phase `verifiers` replaces only line 141 with the denominator check, so #356 adds no second failure reason. The helper-export mismatch is not repaired. Its base disposition is recorded separately at E1. |
| C | `scripts/test-conditional-irrigation-integration.js` executes the query node in `runLegacySchedulerTick`. | Read-only. Every legacy schedule in that test uses `trigger_metric` `DENDRO`, whose branch #356 leaves byte-identical. It is listed as an adjacent gate with a pass forecast. |

## Retained responses to the r2 review

| r2 finding | Resolution carried here |
| --- | --- |
| 1: timestamp backfill could give a linked row another event's value | Linked rows take values only from their own linked diagnostic; unlinked pre-link rows keep a history fill by id and are never linked. "Calibration backfill" |
| 2: diagnostic and link not isolated from manual transactions | One scoped `db.transaction` holds the diagnostic insert and the link; the backfill is one scoped transaction. "Shared-connection isolation" |
| 3: wrong-case trigger fragments | Exact lowercase fragments keyed by trigger and index name. `apply-repo-edits.cjs` `schema` |
| 4: no real diagnostic or link failure test | Ingest cases 8 and 9 use injected SQLite ABORT triggers after the real canonical writer; cases 10-12 cover interleaving, refusal and id reuse. |
| 5: plan not committed before council | Stage M, now self-contained. |
| 6: gates and exact accounting | Boot-DDL interpolation, trigger-body parity and staged inventory gates; exact per-node and total accounting; the identity pins and sync-flow guards above. |
| 7: conditional worker reachability and scope | Disposition below; claims say "legacy threshold scheduler". |

## Source facts

All at P, read from Git objects. Flow references mean the decoded `func` in `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`; the bcm2709 mirror is the same blob.

### Ingest writes the two rows separately

The LSN50 tab runs `Decode LSN50` -> `Build Config Query` -> `Read Device Config` -> `Apply Config` -> `LSN50 Normalize + Write` (`460e0bfd95f89e67`) -> `Aggregate Zone Rain/Flow` -> `Insert Chameleon Reading` (`chameleon-readings-insert-fn`) -> `Build Dendrometer Readings INSERT`.

- `Apply Config` computes canonical SWT with `chameleon.buildChameleonSwtMetrics`, which returns null channels for I2C, timeout or a channel's open flag, and null for a missing calibration. The converter clamps to 0..300 (`osi-chameleon-helper`, `MAX_KPA = 300`).
- `LSN50 Normalize + Write` runs `osiDb.transaction` and calls `osi-device-writer.writeDeviceData`, which inserts with `INSERT ... RETURNING id` through the scope's `get` and returns `{ inserted: true, deviceDataId }`. The node discards that id at P. On error it logs `LSN50 write failed` and returns `null`, so nothing downstream runs.
- `Insert Chameleon Reading` inserts into `chameleon_readings` with `db.run` outside any transaction and swallows its close error with an empty catch. An insert failure logs and passes the message on; the canonical row is already committed.
- `osi-db-helper` holds one shared connection with `PRAGMA foreign_keys=ON`. Its promise `run` returns `undefined`, so it exposes no last insert id. `get` runs through `all`, which is why `RETURNING id` works on every LSN50, UC512 and SDI-12 write today.

### Timestamps cannot associate the rows even in normal ingest

`device-writer.clampRecordedAt` replaces a timestamp before 2024-01-01 or more than one hour ahead with the current time. `Insert Chameleon Reading` stores `d.timestamp` unchanged. For a clamped uplink the two `recorded_at` values differ. Only a row-id link can associate them.

### V2 diagnostics store NULL I2C and timeout

The V2 codec emits `Chameleon_Data_Invalid` but no I2C or timeout field; the insert writes `null` for both (`verify-lsn50-chameleon-persistence.js` pins "v2 i2c_missing remains NULL when not sent"). A flag is a fault only when it equals 1, as `zoneSoil.ts` checks it.

### `chameleon_readings` row shape is part of the history payload

`osi-history-sync-helper` reads `SELECT * FROM chameleon_readings` and sends the row as `payload`. A new column there would add a field to every history upload, and a later `UPDATE` would fire `trg_sync_chameleon_readings_dirty_au` and queue a history correction.

### Shared connection and its transactions

- `osi-db-helper/index.js` queues every `run`, `get` and `all` as its own item on the shared connection (lines 129-148, 164-179). `transaction()` is one queue item (205-226). Its `BEGIN IMMEDIATE` runs before the `try`, so a failed BEGIN throws without issuing `ROLLBACK`. A failed executor or COMMIT issues `ROLLBACK` and rethrows. The scope's `get`, `all` and `run` call the connection directly (79-94), so no other node's statement runs between them.
- Besides `calibration-persist` and `calibration-local-backfill`, these nodes call `run('BEGIN IMMEDIATE')` through the facade: `chameleon-refresh-persist`, `chameleon-depth-save`, `sync-bootstrap-build`, `sync-bootstrap-mark`, `sync-outbox-build`, `sync-outbox-mark`, `sync-pending-build`, `sync-force-build`, `scoped-zone-create-router`, `scoped-weather-zone-assign-router`. While one holds its transaction, a queued `db.transaction` from any writer fails at BEGIN. `LSN50 Normalize + Write` already uses `db.transaction`, so an uplink in such a window already fails today with `LSN50 write failed`. `chameleon-refresh-persist` has no `ROLLBACK` on its error path.
- `chameleon_readings` uses `INTEGER PRIMARY KEY AUTOINCREMENT`. A rolled-back insert also rolls back its `sqlite_sequence` update, so the next insert receives the same id. After a committed delete, ids are not reused.

### Calibration chain and backfill

- Wiring: `sync-pending-inject` -> `calibration-missing-query` -> `calibration-batch-fetch` (`9443f279758ee186`) -> `calibration-persist` (`51c0ae3799c97131`) -> `calibration-local-backfill` (`d20948dd9120a3d2`), each the only target of the one before. Persist sets `msg.calibrated` after its own COMMIT.
- At P the backfill selects through `cr.deveui = dd.deveui AND cr.recorded_at = dd.recorded_at` and updates `WHERE deveui = ? AND recorded_at = ?`. Two linked rows sharing a timestamp each receive every candidate's update and end with the last candidate's values. Its manual `BEGIN IMMEDIATE` issues `ROLLBACK` on any error, including a failed BEGIN, which ends another node's open transaction.
- `trg_sync_device_data_dirty_au` (seed lines 2897-2923) fires on any `device_data` update while the cloud link is active and upserts `sync_history_dirty_keys` with key `DEVICE_DATA|<gateway>|<NEW.id>` and `change_kind = 'correction'`. An update by id takes that correction path. No `DEVICE_DATA_APPENDED` event is involved.
- `resistanceOhmsToKpa` (helper lines 35-47) computes `a*ln(kOhm) + b*kOhm + c`, clamped to 0..300 and rounded to two decimals. With `a=0, b=1, c=0`, 20,000 Ohm gives exactly 20 kPa; the tests use that.

### Legacy threshold scheduler and the decision node

- Inject `Schedule time` fires at cron `00 06 * * *`, plus a manual inject. `Build zones query (enabled schedules)` skips zones with a live `irrigation_policies` row.
- The decision node `5f0d2b7e9b9b1b3a` builds `cmd = { type: "actuator_command", device: { devEui: valveDevEui, zone_id }, data: { action: "OPEN_FOR_DURATION", reason: "scheduler_threshold", ... } }` (lines 392-407) and returns `[{ payload: cmd, _systemActuation: true, _stregaInternalSource: "scheduler" }, { topic: insertSql }, { topic: updateSql }]` (line 438). `insertSql` logs `'IRRIGATE', 'scheduler_threshold'`. With `n_points <= 0` it logs `SKIP`/`no_data_last_hour`, emits no command and does not advance `last_triggered_at`. The flow-node harness returns that array unchanged.

### Conditional irrigation (#515)

- `observations.js` lines 47-56 (`chameleonEligibility`) admit a Chameleon source from its latest `chameleon_readings` row at or before the due time and its six fault flags. Lines 157-162 read every `device_data` row in the window without a per-row diagnostic. `normalizedSamples` (line 125) keeps one sample per timestamp, the highest id. This is a latest-diagnostic association with timestamp deduplication.
- `evaluate.js` lines 6-8 accept SWT through 1,000,000, so an unlinked or 301 kPa Chameleon sample can reach evaluation and audit.
- `conditional-due-tick` calls `runDue({ db, transport })` without a qualification provider. Worker lines 592-607 evaluate evidence, then check qualification before reservation and dispatch. `osi-valve-control/effects.js` lines 119-132 return `qualification_unavailable` without a provider. Normal production dispatch stops there.

### Retention, deletion and precedents

No runtime node deletes `device_data` or `chameleon_readings`; removals come only from `ON DELETE CASCADE` on `devices`, which the boot rebuild fences with `foreign_keys=OFF`. Precedents: WATERMARK ingest (`osi-watermark-helper/ingest.js`) writes `device_data` and `watermark_readings` in one transaction with `device_data_id`; the Tensiomark migration `0074` uses `device_data_id ... REFERENCES device_data(id)`; `test-lsn50-counter-concurrency.js` drives shipped LSN50 nodes through the real facade with a `node:sqlite` adapter; `test-conditional-irrigation-sync-schema.js` replays a prefix corpus with the migration runner. The new tests follow these.

## Design

### Link schema: a separate edge-local table

[Migration proposal](issue-356-chameleon-reading-links/chameleon-reading-links.sql), risk class `additive`, installed as `database/migrations/ordered/0078__chameleon_reading_links.sql`:

- `chameleon_reading_id INTEGER PRIMARY KEY REFERENCES chameleon_readings(id) ON DELETE CASCADE`
- `device_data_id INTEGER NOT NULL REFERENCES device_data(id) ON DELETE CASCADE`, unique through `ux_chameleon_reading_links_device_data`
- `linked_at` default timestamp, for post-deploy inspection
- `trg_chameleon_reading_links_identity_bi` refuses a row unless both parents exist and share `deveui`, also with foreign keys off
- `trg_chameleon_reading_links_immutable_bu` refuses every update

Result: at most one diagnostic per canonical row and one canonical row per diagnostic, of one device, written once. The migration creates objects only; it reads, links, rewrites and deletes no existing row.

| Concern | Column on `chameleon_readings` | Separate table (chosen) |
| --- | --- | --- |
| History payload | `SELECT *` adds a field to every upload; paired cloud review | unchanged |
| Later writes | an `UPDATE` queues a history correction | no sync triggers |
| Uniqueness | needs a partial unique index; `ADD COLUMN` cannot declare `UNIQUE` | primary key plus unique index |
| Parent delete | `ON DELETE SET NULL` is an `UPDATE` that fires the dirty trigger | `CASCADE` removes only the link |

Deleting a canonical row removes its link and keeps the diagnostic. Deleting a diagnostic removes the link and leaves the canonical row unlinked, so the scheduler stops using it. A future rebuild of `device_data` or `chameleon_readings` must keep the established fence (`foreign_keys=OFF`, `legacy_alter_table=ON` across the rename); `tensiomark_observations` and `rain_observations` already depend on it.

The two triggers go into `MIGRATION_OWNED_TRIGGERS` in `verify-runtime-schema-parity.js`, never into `sync-init-fn`.

### Ingest ownership and the id handoff

| Write | Owner | Transaction | On failure |
| --- | --- | --- | --- |
| `device_data` row | `LSN50 Normalize + Write`, unchanged | its existing `osiDb.transaction` | rollback, `node.error`, message dropped; no diagnostic, no link (P behaviour) |
| expose the id | same node, two added lines after commit: a comment and `d.deviceDataId = result.writeResult.inserted ? result.writeResult.deviceDataId : null;` | none needed | not reached |
| diagnostic and link | `Insert Chameleon Reading` | one scoped `db.transaction`: `t.get('INSERT ... RETURNING id')`, then `t.run('INSERT INTO chameleon_reading_links ...')` | see the table below |

The id travels on `msg.formattedData`, which `Decode LSN50` builds per uplink and `Aggregate Zone Rain/Flow` passes through, so concurrent uplinks cannot swap ids. [Proposed `Insert Chameleon Reading` body](issue-356-chameleon-reading-links/insert-chameleon-reading.func.js): the 29-column insert text up to `calibration_status) VALUES (...)` is unchanged apart from the `RETURNING id` suffix. Every string that `verify-sync-flow.js` and `verify-lsn50-chameleon-persistence.js` pin in this node remains. The empty close catch becomes `node.warn`.

### Shared-connection isolation

| Event | Diagnostic | Link | Canonical row | Report |
| --- | --- | --- | --- | --- |
| Normal, id present | committed | committed in the same transaction | linked | none |
| No `deviceDataId` | committed | none | n/a | `node.warn ... stays unlinked` |
| Link refused (trigger, unique, foreign key) | committed | none; the statement is rolled back and caught inside the transaction | unlinked, excluded | `node.error Chameleon link failed for reading <id> and device_data <id>: ...` |
| Diagnostic insert fails | rolled back | none | kept, unlinked, excluded | `node.error Chameleon persistence failed: ...` |
| Another node holds a manual transaction | not written; BEGIN fails and no `ROLLBACK` is issued | none | kept, unlinked, excluded | `node.error Chameleon persistence failed: ... transaction within a transaction` |
| COMMIT fails, or an error rolls back the whole transaction | rolled back | none | kept, unlinked, excluded | `node.error Chameleon persistence failed: ...` |

The returned id never leaves the transaction before its link commits, so no rollback by another node can free that id for a different reading while a link to it is pending. That closes the wrong-event schedule from the r2 review.

The tradeoff is explicit. While another node holds a manual transaction, the diagnostic is now lost with a visible error; at P it would have joined that transaction and committed or rolled back with it. The canonical row survives and the scheduler ignores it. The canonical writer already fails in the same window today. Retrying is rejected: the facade offers no way to wait for another node's transaction, and an unscoped fallback would bring back the wrong-link hazard.

Putting all three writes into the canonical transaction stays rejected: a diagnostic or trigger failure would discard a valid canonical measurement, and the MOD9 rain transaction would hold its lock longer.

The backfill is converted to one scoped transaction as well. At P its failed-BEGIN `ROLLBACK` can end another node's transaction; rewriting that node for #356 while keeping the pattern would leave the hazard in a node this change vouches for. `calibration-persist` is not edited: its manual transaction can only make the scoped transactions fail closed as shown above.

### Legacy threshold scheduler eligibility

[Proposed `Build mean query (last hour, all datapoints)` body](issue-356-chameleon-reading-links/scheduler-mean-query.func.js). The DENDRO branch, zone and type predicates, WATERMARK anti-join, ISO one-hour cutoff, output column names and metric aliases are unchanged. The query uses nested subqueries, not `WITH`: no shipped `msg.topic` query uses a CTE.

| Rule | Applies to | Effect |
| --- | --- | --- |
| Durable link | `DRAGINO_LSN50` rows of a Chameleon-enabled device | a row counts only through `chameleon_reading_links`, joined to a diagnostic with `cr.deveui = dd.deveui` |
| Row fault | linked diagnostic | `i2c_missing`, `timeout` or `data_invalid` equal to 1 drops the row; NULL is not a fault |
| Channel fault | linked diagnostic | `chN_open = 1` drops channel N only |
| Type | all sources | value must be SQLite `integer` or `real`; TEXT and BLOB are dropped |
| Chameleon domain | LSN50 | inclusive 0..300 kPa |
| Shared domain | KIWI, CLOVER, SDI-12 | inclusive 0..1,000,000 kPa; a measured zero counts |
| Alias | channels 1 and 2 | `COALESCE(canonical, legacy)` picks the value first; an invalid canonical value does not fall back |
| `SWT_AVG` | per row | mean of the row's eligible channels in REAL arithmetic, then rows weighted equally |
| No data | zone | `COUNT(row_value) = 0` gives `n_points = 0` and `mean_kpa = NULL`; the unchanged decision node logs `SKIP`/`no_data_last_hour` and sends no command |

`data_invalid = 1` adds nothing to the I2C and timeout checks for V1 frames and is the only whole-row fault for V2. Normal ingest already yields null SWT for those frames. `temp_fault`, `id_fault`, `comp_pending` and `calibration_status` are not used, as in the Water card.

### Preserved behaviour

One-hour window; rows averaged before the zone mean; threshold comparison, duration, debounce and clock-jump suppression in the unchanged decision node; the DENDRO branch; the WATERMARK anti-join for every linked frame, including a Chameleon-linked row; measured zero; canonical-before-alias precedence; no data means no command.

### Calibration backfill

[Proposed `calibration-local-backfill` body](issue-356-chameleon-reading-links/calibration-local-backfill.func.js). The whole node runs as one scoped `db.transaction`.

| Path | Selection | Update |
| --- | --- | --- |
| Linked | `chameleon_reading_links l JOIN device_data dd ON dd.id = l.device_data_id JOIN chameleon_readings cr ON cr.id = l.chameleon_reading_id AND cr.deveui = dd.deveui`, for this `array_id`, all three canonical channels null | `UPDATE device_data SET swt_1 = ?, swt_2 = ?, swt_3 = ? WHERE id = ?` with the row's own diagnostic |
| Unlinked, pre-link history | device and time join as at P, plus `NOT EXISTS` a link for `dd.id` and for `cr.id`, ordered `dd.id, cr.id` | same, by id; no link is created |

- A linked row only receives values computed from the diagnostic its own uplink wrote; a linked diagnostic never fills another row.
- The common reachable case is a new array whose first uplinks arrive before its calibration. Those rows are linked and null. Excluding linked rows altogether would leave them null for good, because the backfill runs once per calibration arrival and later uplinks are calibrated at ingest. That would lose valid history, so it is rejected.
- Unlinked rows keep P's history fill, now by id; the scheduler excludes them regardless. When two unlinked diagnostics share one unlinked row's device and timestamp, the row ends with the higher diagnostic id's values (P took the last candidate in unspecified order). This is history only; it grants no scheduler eligibility and overwrites no populated row.
- Both paths require all three canonical channels to be null, as at P, so a partially populated row is never overwritten.
- The backfill still computes channels whose open flag is set, as at P. The scheduler drops those channels through the link; display policy is not #356's.
- Every update fires the existing correction trigger keyed by `NEW.id`. No append event is emitted.

### Historical rows

Every Chameleon row written before the new ingest path is unlinked and stays excluded. The one-hour window confines this to the time around deployment. The first linked uplink after deploy restores eligibility. Because the legacy run fires at 06:00, a deploy within the hour before 06:00 can make that day's run skip a Chameleon-only zone with `no_data_last_hour` if no linked uplink arrived in time.

### Display difference

The Water card is unchanged. It reads each device's newest diagnostic by `deveui`, checks I2C, timeout and channel-open flags, and accepts 0..1,000,000 kPa. The scheduler checks each row's own linked diagnostic, adds `data_invalid` and applies 300 kPa to Chameleon. A stored Chameleon 301 kPa can show on the card as a valid number while the scheduler ignores it; #355 changes only how such values are labelled. The card's channel choice (#305) and the scheduler's per-row mean were already different statistics.

### Conditional irrigation (#515)

#356 stays bounded to the legacy threshold scheduler. The conditional worker can evaluate and audit with its latest-diagnostic association, but normal production dispatch stops at `qualification_unavailable`. No flag is enabled or proposed, and the worker is not edited. Per-sample linking in the worker is a separate prerequisite to any qualification or activation of conditional irrigation; the parent tracks it. Activating conditional control with the current association would need its own risk decision, which is neither requested nor inferred here.

### Sync contract

No sync table, outbox trigger, history definition or bootstrap query changes. `chameleon_reading_links` is not added to `osi-history-sync-helper`, so the cloud never sees it, and `chameleon_readings` keeps its 31 columns (pinned by the schema test). Backfill updates take the existing history-correction path. No paired osi-server change is needed; the cloud does not run the edge scheduler.

### Coordination

- #305 owns which channel or mean the live card leads with; no card code changes here.
- #165 owns the valve tile and dialog. The farmer-visible effect of #356 is that a schedule which would have opened on an unlinked, faulted or out-of-domain value records `SKIP`/`no_data_last_hour` and no valve opens.
- #515's conditional worker is untouched (above).
- #377's storage migration must re-plan on a corpus that contains 0078; that is the parent's ledger condition, not this plan's.

## Failure-mode matrix

| Condition | Stored outcome | Legacy scheduler | Test |
| --- | --- | --- | --- |
| No diagnostic for a Chameleon row | unlinked | excluded | scheduler "an unlinked Chameleon value" |
| Diagnostic with the same device and timestamp, not linked | unlinked | excluded | scheduler "a unique same-timestamp diagnostic" |
| Newer clean diagnostic, older row unlinked | unlinked | excluded | scheduler "a newer clean diagnostic" |
| Older faulted row and newer clean row, each linked | both linked | clean row only | scheduler "judged by its own diagnostic" |
| Two canonical rows with one timestamp | each linked to its own diagnostic | per link | ingest 2; scheduler "duplicate canonical timestamps" |
| Clamped canonical timestamp | linked by id | eligible if clean | ingest 3 |
| Missing `deviceDataId` | diagnostic kept, unlinked, warning | excluded | ingest 4 |
| Cross-device link | refused by the identity trigger, diagnostic kept, error | excluded | ingest 5; schema "cross-device or dangling" |
| Second link to one row or one diagnostic | refused (unique) | n/a | schema "once each way" |
| Link update | refused | n/a | schema "immutable" |
| Canonical write fails | nothing downstream | n/a | ingest 7 |
| Diagnostic insert fails after a normal canonical write | canonical value kept; no diagnostic, no link; error | excluded, no command | ingest 8 |
| Same-device link refused | both rows kept; no link; error | excluded, no command | ingest 9 |
| Another node rolls back between queued writes | no wrong link; refused diagnostic reported; a later uplink links its own rows | per own link | ingest 10 |
| Diagnostic queued during another node's transaction | not written; that transaction is not ended by this node | excluded | ingest 11 |
| Rolled-back insert id | reused by the next insert (characterization) | n/a | ingest 12 |
| Two linked same-timestamp rows, calibration arrives later | each filled from its own diagnostic by id; correction dirty keys; no append event | each row's own value | ingest 13, 16 |
| Unlinked pre-link row with a unique same-timestamp diagnostic | history value filled by id; no link | excluded | ingest 14 |
| Unlinked row sharing a timestamp with a linked diagnostic | not filled | excluded | ingest 15 |
| Canonical row deleted | link removed, diagnostic kept | n/a | schema "deleting either parent" |
| Diagnostic deleted | link removed, row unlinked | excluded | same |
| Migration applied to a gateway with history | no row read, linked or changed | history excluded | schema upgrade and runner tests |
| Flows rolled back to a pre-link payload | link table stays; new rows unlinked | old flow ignores the link; excluded after re-upgrade | not tested; follows `deploy.sh` rules |
| Flows deployed without the migration | query fails with "no such table" for every SWT zone, no command | fail-closed for all SWT zones | prevented by `deploy.sh` ordering; see "Offline proof" |
| WATERMARK row, with or without a clean Chameleon link | stored | excluded by the interlock | scheduler WATERMARK case; WATERMARK flow cases (f), (f2) |

## Ownership and collisions

Claim in `ledger.json` before stage M:

| Surface | Change | Known collision |
| --- | --- | --- |
| `docs/superpowers/plans/2026-10-28-issue-356-chameleon-reading-links.md`, `docs/superpowers/plans/issue-356-chameleon-reading-links/` | new (stage M) | none |
| `scripts/verify-doc-hygiene-allowlist.json` | exact entries for packet files (stage M) | any docs PR adding entries |
| `database/migrations/ordered/0078__chameleon_reading_links.sql`, `CHECKSUMS.json` | new, one entry | #377 must re-plan after #356 (ledger) |
| `database/seed-blank.sql`, the 7 bundled `farming.db` | append; regenerate | any schema branch |
| flows `d0b2b1c1a937e16d`, `chameleon-readings-insert-fn`, `460e0bfd95f89e67`, `d20948dd9120a3d2`, both profiles | replace / replace / two lines / replace | the editor refuses on drift |
| `scripts/verify-runtime-schema-parity.js`, `scripts/verify-db-schema-consistency.js` | anchored entries | schema branches |
| `scripts/verify-lsn50-chameleon-persistence.js` | fake transaction, link case | none |
| `scripts/verify-sync-flow.js` | lines 2866-2868 replaced by the query guard block | most flow PRs edit this file; anchors refuse on drift |
| `scripts/verify-live-gateway-identity.js` | catch pin and total pin, with comments | every flow PR that moves either pin |
| `scripts/test-watermark-ingest-flow.js` | fixture links, interlock constant, case (g) transition rule | WATERMARK work |
| `scripts/verify-lsn50-chameleon-swt.js` | line 141 only | any repair of its helper-export mismatch |
| `scripts/fixtures/silent-catch-baseline.json` | 80 -> 77 | any flow PR changing catches |
| `scripts/verify-flows-size-ratchet-allowances.json` | four node entries; total delta set exactly | every flow PR; the reset removes standing headroom |
| `scripts/test-unified-soil-tension-scheduler.js` | replace | none |
| `scripts/test-chameleon-reading-links-schema.js`, `scripts/test-chameleon-reading-link-ingest.js` | new | none |
| `.github/workflows/verify-sync-flow.yml` | two paths in the soil-tension step | any branch editing that step |
| `docs/operations/unified-soil-tension.md` | one paragraph | none |

Read-only dependencies pinned by `apply-flow-edits.cjs --check`: the decision node `5f0d2b7e9b9b1b3a` and `calibration-persist`. Also read-only: `calibration-batch-fetch`, `Build zones query (enabled schedules)`, `lsn50-zone-agg-fn`, `osi-db-helper`, `osi-device-writer`, `osi-chameleon-helper`, `osi-lsn50-normalize`, `osi-rain`, `osi-history-sync-helper`, `osi-irrigation-policy`, `scripts/lib/flow-node-harness.js`, `scripts/flows-size-scan.js`, `scripts/verify-no-new-silent-catch.js`, `scripts/test-conditional-irrigation-integration.js`, `lib/osi-migrate`.

Not touched: `sync-init-fn` (boot-DDL freeze), `Apply Config`, `Decode LSN50`, the decision node, `calibration-persist`, `chameleon-refresh-persist`, every sync node, the conditional worker, GUI (#305, #355, #165), cloud, `deploy.sh`.

## Stage M: plan-only packet before council and product work

Variables, used literally below:

```sh
C=/home/phil/projects/osi-release-campaign-2026-10-25
P=f6682ef6d0d90355bded9789fb4d423136ab02bb
R4=$C/reports/issue-356-durable-link-plan-r4
R4SHA=<SHA-256 of this report, recorded by the parent with the accepted Sol review>
WT=<the materializer's own clean isolated osi-os checkout; every command runs with it as working directory>
V=0078
PKT=docs/superpowers/plans/issue-356-chameleon-reading-links
```

Before every command: UTC time before 2026-11-01T22:30Z; fresh schema-2 `pressure.json` with `launch_allowed=true` and no latch; `MemAvailable` at least 8 GiB; sampler PID/PGID/SID `2956759` with start ticks `13452935`; the four activation hashes. Each executable step is exactly one `python3 "$C/run-heavy.py" COMMAND ARGS`, serial. Record direct, controller and wrapper exits separately and keep every failed attempt. Read-only `git rev-parse`, `git ls-tree`, `git log` and `git diff --name-status` may run directly.

M0. Parent-owned preconditions: an accepted fresh Sol review of this exact report and its ten resource hashes, with `R4SHA` recorded; `ledger.migration_coordination` still reserves 0078 for #356 on P; ledger claims for the surfaces above; an admitted heavy lane.

M1. `python3 "$C/run-heavy.py" git -C "$WT" status --porcelain=v1 --branch`: only the branch line.

M2. `python3 "$C/run-heavy.py" git -C "$WT" fetch --no-tags origin main`: exit 0. Then directly `git -C "$WT" rev-parse FETCH_HEAD`, recorded as `B`. `B` must equal `P`. Otherwise stop and report to the parent; do not rebase, merge or choose another version.

M3. Directly `git -C "$WT" ls-tree -r --name-only "$P" -- database/migrations/ordered/`: among the `.sql` entries the highest version is 0077 and no `0078__` file exists.

M4. `python3 "$C/run-heavy.py" git -C "$WT" switch --create issue-356-chameleon-reading-links "$P"`: exit 0.

M5. `python3 "$C/run-heavy.py" sha256sum "$R4/materialize-plan-packet.cjs"`: must equal the hash under "Provenance".

M6. `python3 "$C/run-heavy.py" node "$R4/materialize-plan-packet.cjs" "$C/reports/issue-356-durable-link-plan-r4.md" "$R4" "$V" "$R4SHA" "$P"`. Expected: `materialize-plan-packet: V=0078, base f6682ef6d0d90355bded9789fb4d423136ab02bb, <n> resource links rewritten`, one `sha256 ... findings N` line per written file, the allowlist hash and `materialize-plan-packet: OK`. It refuses on any hash mismatch, a HEAD other than P, a dirty checkout, a non-contiguous or used `V`, a missing binding row, a link outside the packet, an existing packet path or allowlist entry. Forecast findings per file: `apply-flow-edits.cjs` 11, `apply-repo-edits.cjs` 12, `proposed-test-chameleon-reading-link-ingest.js` 8, `proposed-test-unified-soil-tension-scheduler.js` 2, the plan as listed under "Report-owned resources", all other packet files 0.

M7. `python3 "$C/run-heavy.py" git -C "$WT" add -- docs/superpowers/plans/2026-10-28-issue-356-chameleon-reading-links.md "$PKT" scripts/verify-doc-hygiene-allowlist.json`

M8. Packet gates, one wrapper call each:
- `node scripts/verify-doc-hygiene.js`: `verify-doc-hygiene: OK (...)`.
- `node scripts/verify-test-inventory.js`: `verify-test-inventory: OK (...)` with the same test-file count as at P; packet tests are named `proposed-test-*` and are not inventoried.
- `node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/plans/2026-10-28-issue-356-chameleon-reading-links.md`: exit 0.
- `git -C "$WT" diff --cached --check`: exit 0, no output.
- `node "$PKT/apply-flow-edits.cjs" "$PKT" --check`: `apply-flow-edits: pins OK, nothing written`.

M9. `python3 "$C/run-heavy.py" git -C "$WT" commit -m "docs: plan issue 356 durable Chameleon reading link" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`: exit 0. Then `python3 "$C/run-heavy.py" bash -o pipefail -c 'git -C "$1" log -1 --format=%B | node "$1/scripts/verify-doc-hygiene.js" --stdin' _ "$WT"`: OK.

M10. Record directly: `git -C "$WT" rev-parse HEAD HEAD^ HEAD^{tree}` (HEAD^ equals P); `git -C "$WT" diff --name-status "$P" HEAD` lists exactly eleven changed paths: ten added (the plan and nine packet files) and one modified (the existing allowlist); `git -C "$WT" ls-tree -r HEAD -- docs/superpowers/plans/2026-10-28-issue-356-chameleon-reading-links.md "$PKT"` gives the blob ids; `git -C "$WT" status --porcelain` is empty. This commit is `M`.

The council reviewed commit `M`, which records version 0078 and base P. Execution now starts from the rebinding commit `M1` on its own branch (see "Current-main rebinding"), so the PR carries the plan. From here on no step reads a campaign file except the wrapper.

## Execution recipe (from M1c, under the interim authorization)

Same variables as stage M, plus `B=bd1afcd248616653e1962081c8c9e3d7b19d650f` and `M1c`, the corrected rebinding commit (see "Current-main rebinding"). Base-ref verifiers and the editors' base argument are pinned to `B` with `env` or an explicit argument, so a moved `origin/main` cannot change them. All outcomes are UNRUN forecasts.

**E0. Custody.** Directly: `git -C "$WT" rev-parse HEAD HEAD^` gives `M1c` (the id the execution report records) and `B`; `git -C "$WT" status --porcelain` is empty. `python3 "$C/run-heavy.py" git -C "$WT" fetch --no-tags --refmap= origin main`, then directly `git -C "$WT" rev-parse FETCH_HEAD`: must equal `B`, otherwise stop and report. Directly `git -C "$WT" ls-tree -r --name-only HEAD -- database/migrations/ordered/`: highest `.sql` version 0077, no `0078__`. `python3 "$C/run-heavy.py" sha256sum "$PKT"/*`: each value equals the manifest. `python3 "$C/run-heavy.py" node "$PKT/apply-flow-edits.cjs" "$PKT" --check`: pins OK.

**E1. Base dispositions at M1c** (product files equal `B`, byte-identical to P). One wrapper call each; record exit and signal:
1. `env OSI_FLOWS_SIZE_BASE_REF="$B" OSI_DDL_BASE_REF="$B" OSI_MIGRATIONS_BASE_REF="$B" OSI_IDENTITY_BASE_REF="$B" node scripts/verify-sync-flow.js`: exit 0; `Sync flow verification passed`, `Live gateway identity verification passed.`, `All parity checks passed.`
2. `env OSI_IDENTITY_BASE_REF="$B" node scripts/verify-live-gateway-identity.js`: exit 0; `Live gateway identity verification passed.`
3. `env OSI_FLOWS_SIZE_BASE_REF="$B" node scripts/test-watermark-ingest-flow.js`: exit 0; `PASS: 15 WATERMARK ingest flow cases`.
4. `node --test scripts/test-unified-soil-tension-scheduler.js` (`B`'s version, the same blob as P's): exit 0; record its counts.
5. `node scripts/verify-lsn50-chameleon-persistence.js`: `LSN50 Chameleon persistence checks passed`.
6. `node --test scripts/test-lsn50-counter-concurrency.js`: exit 0.
7. `node --test scripts/test-conditional-irrigation-integration.js`: exit 0.
8. `env OSI_FLOWS_SIZE_BASE_REF="$B" node scripts/verify-flows-size-ratchet.js`: exit 0.
9. `node scripts/verify-no-new-silent-catch.js`: `verify-no-new-silent-catch: OK`, 80 for both profiles.
10. `node scripts/verify-lsn50-chameleon-swt.js`: source-suspected red-on-base, a `TypeError` that `chameleon.calibrationFromDeviceRow` is not a function (line 75; the helper and verifier are the same blobs at `B`). Not an observed result. Its assertions at lines 70-74 run first and were not evaluated; a failure there is a different base failure.

Any red among 1-9 is red-on-base: stop and report. Item 10 runs under the parent's recorded bounded disposition (2026-10-28T21:29:38Z), not a waiver. Keep the complete base attempt and the complete candidate attempt, each with its exact commit and direct, controller and wrapper exits. A base failure other than that `TypeError` stops for a new disposition. If item 10 exits 0 at base, the candidate must exit 0. A candidate that repeats the same early exception has not run line 141, and it qualifies neither the helper nor the full LSN50 path. The new query, ingest, persistence and scheduler tests and the full sync-flow run must pass on their own, and `B..HEAD` must leave the helper unchanged and change only line 141 of this verifier. No helper export, restored calibration default, suppressed assertion or weakened actuator gate is part of #356. CI does not run this verifier.

**C1. Schema, test first.**
1. `python3 "$C/run-heavy.py" install -m 0644 "$PKT/proposed-test-chameleon-reading-links-schema.js" scripts/test-chameleon-reading-links-schema.js`
2. `python3 "$C/run-heavy.py" node --test scripts/test-chameleon-reading-links-schema.js`: exit 1; `# tests 8`, `# pass 0`, `# fail 8`. Each failure is the missing migration file, a missing table or an empty `table_info`.
3. `python3 "$C/run-heavy.py" node "$PKT/apply-repo-edits.cjs" "$PKT" schema "$V"`: five `wrote` lines (migration, `CHECKSUMS.json`, seed, both verifiers) and `apply-repo-edits schema: OK`.
4. `python3 "$C/run-heavy.py" sqlite3 -readonly conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db "SELECT COUNT(*) FROM chameleon_calibrations"`: record N0.
5. `python3 "$C/run-heavy.py" node scripts/build-seed-db.js`: `build-seed-db: OK (7 image(s), ...)`.
6. If N0 > 0: `python3 "$C/run-heavy.py" node scripts/apply-chameleon-calibration-seed.js`, then repeat step 4 and require N0. If N0 = 0, record the skip.
7. Rerun step 2: exit 0; `# pass 8`, `# fail 0`.
8. Schema gates, one wrapper call each: `env OSI_MIGRATIONS_BASE_REF="$B" node scripts/verify-migrations.js` (exit 0 with its OK line; no exact string required); `node scripts/verify-seed-replay.js` (`verify-seed-replay: OK`); `node scripts/verify-runtime-schema-parity.js` (`verify-runtime-schema-parity: OK (2 flows: ...)`); `node scripts/verify-db-schema-consistency.js` (seven `OK` lines, then `DB schema consistency verification passed`); `node scripts/verify-seed-db-ledger.js` (`verify-seed-db-ledger: OK (7 images stamped at migration head 78)`; the verifier prints the head as a number, and the migration file and version binding stay `0078`); `node scripts/verify-boot-ddl-interpolation.js` (`verify-boot-ddl-interpolation: OK`); `node scripts/verify-trigger-body-parity.js` (`verify-trigger-body-parity: OK`); `node scripts/verify-sqlite-cli-limits.js` (`verify-sqlite-cli-limits: OK`).
9. `python3 "$C/run-heavy.py" git -C "$WT" add -- database/migrations/ordered/0078__chameleon_reading_links.sql database/migrations/ordered/CHECKSUMS.json database/seed-blank.sql conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db database/farming.db web/react-gui/farming.db scripts/verify-runtime-schema-parity.js scripts/verify-db-schema-consistency.js scripts/test-chameleon-reading-links-schema.js`, then `python3 "$C/run-heavy.py" git -C "$WT" -c user.name=Project-OSI -c user.email=philippe.hess@opensmartirrigation.org commit -m "fix: add the durable Chameleon diagnostic link table" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.

**C2. RED at the C1 state** (link table present, every flow node at `B`). No commit.
1. `python3 "$C/run-heavy.py" install -m 0644 "$PKT/proposed-test-chameleon-reading-link-ingest.js" scripts/test-chameleon-reading-link-ingest.js`; `python3 "$C/run-heavy.py" node --test scripts/test-chameleon-reading-link-ingest.js`: exit 1; `# tests 33`, `# pass 5`, `# fail 28`. Passing: per profile case 7 (failed canonical write) and case 12 (id reuse), plus the parity test.
2. `python3 "$C/run-heavy.py" install -m 0644 "$PKT/proposed-test-unified-soil-tension-scheduler.js" scripts/test-unified-soil-tension-scheduler.js`; `python3 "$C/run-heavy.py" node --test scripts/test-unified-soil-tension-scheduler.js`: exit 1; `# tests 85`, `# pass 43`, `# fail 42`.
3. `python3 "$C/run-heavy.py" node "$PKT/apply-repo-edits.cjs" "$PKT" persistence`: one `wrote` line and OK. `python3 "$C/run-heavy.py" node scripts/verify-lsn50-chameleon-persistence.js`: exit 1 with `insert links its diagnostic to the uplink device_data row: expected to find INSERT INTO chameleon_reading_links`.
4. Every failure must be one of: an eligibility admission, a missing id or link, a value from another event, a missing visible error, or a diagnostic that joined another transaction (see "Test inventories"). A setup error, a harness exception or a failure on a control listed as passing stops execution for a report.

**C3. Flow edits, verifier updates, ratchets, GREEN.**
1. `python3 "$C/run-heavy.py" node "$PKT/apply-flow-edits.cjs" "$PKT"`: four lines `d0b2b1c1a937e16d 2425 -> 4596 chars (+2171)`, `chameleon-readings-insert-fn 3384 -> 5395 chars (+2011)`, `460e0bfd95f89e67 9835 -> 10007 chars (+172)`, `d20948dd9120a3d2 2242 -> 3236 chars (+994)`, then `wrote both profiles, sha256 <recorded>`.
2. RED records, one wrapper call each:
   - `env OSI_FLOWS_SIZE_BASE_REF="$B" node scripts/verify-flows-size-ratchet.js`: exit 1 with six `FAIL` node lines (per profile: `d0b2b1c1a937e16d` 4596 > 2425 + 231 allowance, `chameleon-readings-insert-fn` 5395 > 3384, `d20948dd9120a3d2` 3236 > 2242) and none for `460e0bfd95f89e67`, whose consumed +5967 entry still admits +172.
   - `node scripts/verify-no-new-silent-catch.js`: exit 1; `verify-no-new-silent-catch: FAIL`, then `- bcm2712: live silent catch count 77 is below baseline 80; update the baseline downward in this commit` and the same for bcm2709.
   - `env OSI_FLOWS_SIZE_BASE_REF="$B" OSI_DDL_BASE_REF="$B" OSI_MIGRATIONS_BASE_REF="$B" OSI_IDENTITY_BASE_REF="$B" node scripts/verify-sync-flow.js`: exit 1 with `FAIL: d0b2b1c1a937e16d missing scheduler can evaluate Chameleon SWT channel 3`, `FAIL: d0b2b1c1a937e16d missing scheduler SWT average counts Chameleon channel 3 only when present` and `FAILED: sync flow verification (exit 1) - see FAIL lines above`. The chained identity and parity verifiers still pass here.
   - `env OSI_FLOWS_SIZE_BASE_REF="$B" node scripts/test-watermark-ingest-flow.js`: exit 1; `not ok` for both (f) cases, (f2) and (g); `FAIL: 4 of 15 WATERMARK ingest flow case(s) failed`.
3. `python3 "$C/run-heavy.py" node "$PKT/apply-repo-edits.cjs" "$PKT" verifiers "$B"`: three `wrote` lines (`scripts/verify-sync-flow.js`, `scripts/verify-lsn50-chameleon-swt.js`, `scripts/test-watermark-ingest-flow.js`) and OK. It refuses unless the edited query body carries every new guard needle, lacks the excluded one and holds the new interlock line once, and unless each of the three files still equals its `B` version.
4. Rerun the sync-flow and WATERMARK commands of step 2: sync flow exit 0 with the three pass lines of E1.1; WATERMARK `PASS: 15 WATERMARK ingest flow cases`.
5. `python3 "$C/run-heavy.py" node "$PKT/apply-repo-edits.cjs" "$PKT" ratchets "$B"`: two `wrote` lines and OK. It refuses unless every untouched function body is byte-identical to `B`, the four owned nodes grew by exactly the amounts in step 1, the live empty-catch count is `B`'s minus 3, and both JSON files still equal their `B` versions.
6. Rerun step 2's ratchet: `OK <profile> (total 1622849)` twice and `verify-flows-size-ratchet: OK (HEAD total 3245698 <= <B> total 3235002; committed baseline not exceeded)`. Rerun the silent-catch check: `verify-no-new-silent-catch: OK`, 77 for both profiles. Then `env OSI_IDENTITY_BASE_REF="$B" node scripts/verify-live-gateway-identity.js`: exit 1 with `FAIL silent-catch baseline must be 80 for both maintained profiles`, `FAIL size total allowance: expected exact cumulative delta 47589` and `2 live gateway identity verification failure(s)`.
7. `python3 "$C/run-heavy.py" node "$PKT/apply-repo-edits.cjs" "$PKT" identity-pins "$B"`: one `wrote` line and OK. It re-measures at HEAD and `B` and refuses unless the JSON files carry 77 and 6830, the identity file still equals its `B` version, and both `B` pins read 80 and 47589.
8. Rerun the identity command: exit 0 with `OK silent-catch baseline records 77 for both maintained profiles`, `OK size total allowance: exact delta 6830` and `Live gateway identity verification passed.` Rerun the sync-flow command: exit 0 with the three pass lines.
9. GREEN: `node --test scripts/test-chameleon-reading-link-ingest.js` exit 0, `# pass 33`; `node --test scripts/test-unified-soil-tension-scheduler.js` exit 0, `# pass 85`; `node scripts/verify-lsn50-chameleon-persistence.js` prints `LSN50 Chameleon persistence checks passed`.
10. `python3 "$C/run-heavy.py" git -C "$WT" add -- conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json scripts/test-chameleon-reading-link-ingest.js scripts/test-unified-soil-tension-scheduler.js scripts/verify-lsn50-chameleon-persistence.js scripts/verify-flows-size-ratchet-allowances.json scripts/fixtures/silent-catch-baseline.json scripts/verify-sync-flow.js scripts/verify-live-gateway-identity.js scripts/test-watermark-ingest-flow.js scripts/verify-lsn50-chameleon-swt.js`, then `python3 "$C/run-heavy.py" git -C "$WT" -c user.name=Project-OSI -c user.email=philippe.hess@opensmartirrigation.org commit -m "fix: link Chameleon diagnostics to their own uplink for the legacy scheduler" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.

If the flow editor fails after writing (a post-write check), both profiles are dirty. Stop; `python3 "$C/run-heavy.py" git -C "$WT" checkout -- conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json` is the only allowed cleanup, recorded, before a report. Every repository-editor phase writes nothing when it refuses.

**C4. Docs and CI.**
1. `python3 "$C/run-heavy.py" node "$PKT/apply-repo-edits.cjs" "$PKT" docs-ci`: two `wrote` lines and OK.
2. `python3 "$C/run-heavy.py" git -C "$WT" add -- docs/operations/unified-soil-tension.md .github/workflows/verify-sync-flow.yml`.
3. `python3 "$C/run-heavy.py" node scripts/verify-test-inventory.js`: OK, test-file count two above `B`: 923, from 921 at `B` (the scheduler test is replaced, not added). It reads tracked paths, so it runs after the `git add`.
4. `python3 "$C/run-heavy.py" git -C "$WT" -c user.name=Project-OSI -c user.email=philippe.hess@opensmartirrigation.org commit -m "docs: describe the durable Chameleon link in the soil-tension guide" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"`.

The doc paragraph, inserted after the existing scheduler paragraph:

> The legacy threshold scheduler counts a Chameleon-enabled LSN50 observation only through its `chameleon_reading_links` row. Ingest writes that row from the row ids of the same uplink, in the same transaction as the diagnostic. Rows stored before the link existed stay out of the legacy scheduler, even when a diagnostic shares their device and timestamp; calibration backfill still fills their history values by row id but never links them. The linked diagnostic removes the whole row on an I2C, timeout or data-invalid flag, and one channel on its open flag. Each channel must be a finite number inside its source's range: 0 through 300 kPa for Chameleon, the converter's output range, and 0 through 1,000,000 kPa for KIWI, CLOVER and SDI-12. The Water card keeps the shared display domain, so a stored Chameleon value above 300 kPa can appear on the card while the scheduler ignores it. With no eligible value in the last hour the scheduler logs `no_data_last_hour` and sends no command. Conditional irrigation (`osi-irrigation-policy`) does not use the link yet: it checks a Chameleon source against its latest diagnostic. Its production qualification stays off, and per-sample linking is a tracked prerequisite for qualifying it.

## Gates (exact candidate head, non-author)

Each through its own wrapper call, exit 0 with the stated signal. Base-ref verifiers carry all four base variables pinned to `B`.

- Focused: `node --test scripts/test-chameleon-reading-links-schema.js scripts/test-chameleon-reading-link-ingest.js scripts/test-unified-soil-tension-scheduler.js` (`# tests 126`, `# pass 126`, `# fail 0`); `node scripts/verify-lsn50-chameleon-persistence.js`.
- Schema: the eight C1.8 commands; `node --test scripts/verify-migrations.test.js` (copies the committed ordered directory and requires `checksum manifest OK`); `node --test "lib/osi-migrate/__tests__/*.test.js"`; `node scripts/test-journal-schema.js` (bundled DBs changed); `node --test scripts/test-apply-chameleon-calibration-seed.js`; `env OSI_FLOWS_SIZE_BASE_REF="$B" OSI_DDL_BASE_REF="$B" OSI_MIGRATIONS_BASE_REF="$B" OSI_IDENTITY_BASE_REF="$B" node scripts/verify-no-stray-ddl.js` (`verify-no-stray-ddl: OK (...)`; no new DDL in flows or `deploy.sh`).
- Flow: `node scripts/verify-profile-parity.js` (`All parity checks passed.`); `env OSI_FLOWS_SIZE_BASE_REF="$B" OSI_DDL_BASE_REF="$B" OSI_MIGRATIONS_BASE_REF="$B" OSI_IDENTITY_BASE_REF="$B" node scripts/verify-sync-flow.js` (`Sync flow verification passed`, chained `Live gateway identity verification passed.` and `All parity checks passed.`); `env OSI_IDENTITY_BASE_REF="$B" node scripts/verify-live-gateway-identity.js` (`Live gateway identity verification passed.`, run directly as well as chained); `node scripts/verify-no-new-silent-catch.js` (OK, 77 both); `node scripts/test-flows-wiring.js` (`PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed`); `node scripts/verify-flows-fn-parse.js` (`verify-flows-fn-parse: OK`); `env OSI_FLOWS_SIZE_BASE_REF="$B" node scripts/verify-flows-size-ratchet.js` (the C3.6 lines); `node scripts/flows-bare-require-scan.js`; `node scripts/verify-command-safety.js`; `node scripts/verify-osi-lib-db-caller-binding.js` (`verify-osi-lib-db-caller-binding: OK`).
- Inventory: `node scripts/verify-test-inventory.js` (`verify-test-inventory: OK (...)`).
- Adjacent regressions: `node --test scripts/test-lsn50-counter-concurrency.js` (MOD9 rain transaction); `env OSI_FLOWS_SIZE_BASE_REF="$B" node scripts/test-watermark-ingest-flow.js` (`PASS: 15 WATERMARK ingest flow cases`); `node --test scripts/test-scheduler-clock-jump.js`; `node --test scripts/test-conditional-irrigation-integration.js` (DENDRO-only legacy fixtures); `node scripts/verify-lsn50-chameleon-swt.js` under the E1 disposition above: a repeated `calibrationFromDeviceRow` failure at the candidate is the recorded baseline issue and qualifies nothing beyond it; any other candidate failure, or a candidate failure after a base pass, stops.
- Hygiene: `node scripts/verify-doc-hygiene.js`; `git diff --check "$B"..HEAD`; `node .claude/skills/anti-slop-writing/slop-check.js docs/operations/unified-soil-tension.md`; commit-message hygiene through `--stdin` for each commit.
- Preserved and not reopened: the seven bundled DB copies, seed ledger and fingerprints, migration prefix and checksum manifest, journal schema, MOD9 counter path and WATERMARK interlock all keep their gates above.
- Not applicable, with reason: MQTT topic check (no MQTT node); devices-rebuild fence and rehearsal (`sync-init-fn` untouched; an additive child table is not a `devices` rebuild); GUI unit and build (no GUI change); cloud gates (no server change).

Verifier probes beyond the tests: a diagnostic with `ch1_open = 1.0` stored as REAL; a soft-deleted device's linked row, recorded as a characterization of the existing lack of a deleted-device predicate, not a new policy; an `SWT_WM2` zone mixing linked and unlinked rows; a cross-device link under `PRAGMA foreign_keys=OFF`.

## Size and ratchet accounting

Measured from P's bodies and the proposal files as JavaScript string length, which `flows-size-scan.js` uses:

| Node | P | Proposed | Delta | Existing allowance |
| --- | --- | --- | --- | --- |
| `d0b2b1c1a937e16d` | 2425 | 4596 | +2171 | +231, consumed (its recorded HEAD is 2425) |
| `chameleon-readings-insert-fn` | 3384 | 5395 | +2011 | none |
| `460e0bfd95f89e67` | 9835 | 10007 | +172 | +5967, consumed (recorded HEAD 8797) |
| `d20948dd9120a3d2` | 2242 | 3236 | +994 | none |
| Total, per profile | 1617501 | 1622849 | +5348 | standing delta 47589 |

`B` measures the same: its flows, allowance, baseline and catch files are the P blobs.

The ratchets phase replaces both consumed node entries and adds two, each with the exact base -> HEAD measurement in its reason (run with `B`, it names `bd1afcd24`; the values equal P's). The committed baseline is 1616019; 1616019 + 47589 = 1663608 already leaves 46107 unused at P and at `B`, and absorbing +5348 into it would rely on historical headroom. The phase instead sets the total delta to 1622849 - 1616019 = 6830, which also covers the base-ref growth of 5348, and appends the measurement to `total_allowance.provenance`. The baseline file and `total_allowance.reason` are unchanged; the identity verifier's `reason` substring checks keep passing. The reset removes the standing headroom; a branch that relied on it accounts for its own growth when it rebases. That is a coordination item for the parent.

Empty catches: `Insert Chameleon Reading` loses one (`close`), the backfill two (`ROLLBACK`, `close`); persist keeps its two. 80 -> 77 per profile.

Identity pins, written by `identity-pins` with the measured values:

- catches: comment `77: issue #356 durable Chameleon diagnostic link -- ... 80 -> 77.` above `expectCondition(... === 77 && ... === 77, 'silent-catch baseline records 77 for both maintained profiles', 'silent-catch baseline must be 77 for both maintained profiles')`;
- total: comment `6830: issue #356 ... measured on bd1afcd24: 1617501 -> HEAD 1622849 = +5348 ... exactly 1622849 - 1616019 = 6830, not 47589 + 5348 ...` above `expectCondition(sizeAllowances.total_allowance?.delta === 6830, 'size total allowance: exact delta 6830', 'size total allowance: expected exact delta 6830')`.

Strict equality stays. The allowance-reason substring checks, the per-node `expectedGrowth` checks, the protected-function hashes and every other identity guard are untouched; none names an owned node.

## Test inventories and forecasts

All UNRUN. "RED" is the forecast at C2, "GREEN" at C3.

Schema test: 8 tests. C1.2 8 fail; C1.7 8 pass.

Ingest test, 16 cases per profile plus one parity test, 33 in all:

| # | Case | RED cause at C2 |
| --- | --- | --- |
| 1 | one uplink, one row, one diagnostic, one link | no `deviceDataId`, no link |
| 2 | two same-timestamp uplinks link their own rows | no links |
| 3 | clamped timestamp links by id | no link |
| 4 | diagnostic without id stays unlinked | no `stays unlinked` warning |
| 5 | cross-device link refused | no `deviceDataId` on the other uplink |
| 6 | non-Chameleon uplink | no `deviceDataId` |
| 7 | failed canonical write sends nothing | passes (control) |
| 8 | diagnostic INSERT fails after canonical write | P's scheduler counts the unlinked 80 kPa row and opens |
| 9 | same-device link refused | no `Chameleon link failed` error; P's scheduler opens |
| 10 | another node's rollback between queued writes | no link for B; no refusal reported |
| 11 | diagnostic queued during another node's transaction | P's diagnostic joins and commits with that transaction |
| 12 | rolled-back AUTOINCREMENT id is reused | passes (characterization) |
| 13 | backfill: two linked same-timestamp rows | both rows get one diagnostic's values |
| 14 | backfill: unlinked unique pre-link pair | value filled (as wanted) but P's scheduler counts it |
| 15 | backfill: linked diagnostic and a second unlinked row | P fills the second row from the linked diagnostic |
| 16 | end-to-end: uplinks before calibration, then arrival | no links |
| - | both profiles ship the same four bodies | passes |

RED 28 fail, 5 pass. GREEN 33 pass. Cases 13 and 16 end with the corrected open-command assertion; at C2 they fail earlier, so the RED count does not depend on it.

Scheduler test: 41 cases per profile, plus a per-profile static guard and one parity test, 85 in all.

- RED at C2, 20 cases per profile: unlinked; unique same-timestamp diagnostic; newer clean diagnostic; judged by its own diagnostic; duplicate canonical timestamps; I2C; timeout; V2 data-invalid; channel 2 open on `SWT_2`; channel 2 open on `SWT_AVG`; channel 3 open; channel 1 open; Chameleon 301; negative KIWI; KIWI above 1,000,000; infinite; non-numeric; BLOB; all-invalid row; invalid canonical alias. Plus the static guard: 21 failing tests per profile.
- Controls passing at C2, 21 cases per profile: the three-source cases for `SWT_1`, `SWT_2` and `SWT_AVG`; WATERMARK-linked row; missing channels and old rows; clean linked Chameleon; clean V2; channel 2 open keeps channel 1; Chameleon 300; Chameleon zero; KIWI, SDI-12 and CLOVER 301; KIWI 1,000,000; legacy alias fill; `SWT_AVG` row weighting; `SWT_1` row weighting; fractional row mean (REAL columns at P give 41.5); `SWT_WM1`; `SWT_WM2`; no rows.
- Eleven of those controls open a valve (`SWT_2` three-source, clean linked, clean V2, Chameleon 300, the three 301 cases, KIWI 1,000,000, both row-weighting cases, `SWT_WM2`). They assert the real envelope: type, valve, action, reason and the `IRRIGATE` event.

RED 42 fail, 43 pass. GREEN 85 pass.

Persistence verifier: RED at C2.3 on the new static assertion; GREEN at C3.9.

WATERMARK flow test: E1 `PASS: 15`; after C3.1 `FAIL: 4 of 15`; after C3.3 `PASS: 15`.

Focused total at the candidate head: 8 + 33 + 85 = 126.

Forecast history. The r3 helpers read `payload.action`, which the decision node never sets. Sol's r3 review deduced from source that, assuming no other fixture error, the r3 candidate would have given scheduler 63 pass and 22 fail and ingest 29 pass and 4 fail, not 85/0 and 33/0, and that the r3 scheduler RED would have been 21 pass and 64 fail, not 43/42. Those were deductions; no run of r3 exists. The r3 WATERMARK flow forecast was missing; source shows four failures it did not list.

## Offline proof versus image, deploy and field acceptance

The offline evidence above is Node 22 with `node:sqlite` behind the real `osi-db-helper` facade: schema constraints, runner upgrade, ingest linking through the shipped node bodies, the scoped transaction under interleaving and refusal, the backfill, and the scheduler query and decision on the seeded schema. It does not cover:

- Gateway Node 20.18.3 with the native `sqlite3` binding (#343, selected and unqualified): the facade's queue and `BEGIN IMMEDIATE` behaviour under that binding. This plan adds no SQLite feature beyond what shipped writers use (`RETURNING`, triggers, unique indexes), but no Node 20 or native-binding qualification follows.
- An OpenWrt image build, the deploy runner on a Pi, or a real database lineage. `deploy.sh` runs `run_schema_migration()` before the payload flip and checks a retained payload's recorded schema head before rolling back to it; that is existing behaviour, read from source and not re-verified here.
- Radio uplinks, ChirpStack, transport, valve movement or any farm.

Field acceptance, if the maintainer schedules it: after deploy, confirm `SELECT COUNT(*) FROM chameleon_reading_links WHERE linked_at >= <deploy time>` grows with Chameleon uplinks; that no `Chameleon link failed` or `stays unlinked` lines appear in the Node-RED log; count `Chameleon persistence failed: ... transaction within a transaction` lines, each a diagnostic lost while another node held a manual transaction; and that a linked row exists before the next 06:00 run. Avoid deploying in the hour before the gateway's local 06:00. No production or fleet access is authorized in this campaign.

## Review gates

1. Fresh independent Sol source review of this report and its ten resources.
2. Parent binding and stage M plan-only commit.
3. Three-provider council on commit `M`: Sol (Codex), Claude Fable and OpenCode Go DeepSeek V4 Pro, at most five full rounds, actual approvals of that exact commit. Round 1: Sol and Claude approve; the DeepSeek vote is missing (quota) and stays visible.
4. Independent Sol review of the rebinding commit `M1`: the P to `B` input equality, the unchanged packet blobs and the plan text diff `M..M1`.
5. Wrapped, test-first execution from `M1c` (the corrected `M1`) under the user's interim Opus/Sol authorization of 2026-10-29, stopping on any divergence from the forecasts. This is no full council approval.
6. Independent Sol verification at the exact candidate head: every gate, a hunk-by-hunk diff `B..HEAD` against this plan, the probes. This is the final review; no extra Opus round applies.
7. Draft PR only after those, with plan, reviews and evidence. No merge by an agent; a risk-class merge needs the maintainer.

Findings are REQUIRED or OPTIONAL. Routine command, pin or wording corrections do not open a new approval round. At the council cap, unresolved work gets a blocker report.

## Follow-ups for the parent to track

These are not filed by this plan, and no claim is made that they are filed.

1. Manual transactions on the shared connection: the ten nodes under "Shared connection and its transactions" plus `calibration-persist` hold `BEGIN IMMEDIATE` across awaited facade calls. Other nodes' single statements run inside those transactions; every writer's `db.transaction` fails during them; persist's failed-BEGIN `ROLLBACK` can end another node's transaction; `chameleon-refresh-persist` leaves its transaction open on error. Source-supported, not reproduced. #356 removes the pattern only from the backfill it rewrites.
2. Conditional worker per-sample Chameleon association: prerequisite to qualifying or activating conditional irrigation.
3. `verify-lsn50-chameleon-swt.js` calls a helper export that neither P nor `B` has. Disposition at E1; repair is separate.

## Remaining blockers and open questions

- No blocker in the plan text. Execution depends on the parent's 0078 record on `B`, its claim update and a fresh fetch still at `B`.
- Parent coordination: the shared-file claims, the total-delta reset's effect on other open flow branches, #377's re-plan after 0078, and the E1 disposition for `verify-lsn50-chameleon-swt.js`.
- For the reviewer: case (g) of the WATERMARK flow test now skips SWT text equality only while `BASE_REF` predates the link and freezes every metric again afterwards. The alternative is a frozen literal of each SWT topic in that test, which would duplicate the scheduler test's assertions. No user decision is needed either way.
- Not done and out of scope: cleaning stale node allowances for nodes #356 does not touch.

## Limitations

- Every test, both editors and the materializer are complete proposals that have never run. The RED records at C1 to C3 exist to catch their errors before a product edit is trusted.
- The hygiene finding counts in M6 and every measured number assume P. They hold at `B`, whose inputs are the same blobs; the editors refuse otherwise.
- The materializer re-implements `verify-doc-hygiene.js`'s built-in patterns only to size allowlist entries. The real verifier in M8 is the gate, and maintainers' private term list is not modelled.
- The new WATERMARK fixture diagnostics carry only the six flag columns; they model a clean linked diagnostic, not a decoded frame.
- Prose checking of this report is deferred as instructed; M8 runs it on the committed plan.

## Report-owned resources

The nine packet files are copied byte for byte into `docs/superpowers/plans/issue-356-chameleon-reading-links/` at stage M.

| File | SHA-256 | Since r3 |
| --- | --- | --- |
| [chameleon-reading-links.sql](issue-356-chameleon-reading-links/chameleon-reading-links.sql) | `fd3aa7872f9bdda436a386d0a040543b76bf393c459b73f1c9c158fa706743fa` | unchanged |
| [scheduler-mean-query.func.js](issue-356-chameleon-reading-links/scheduler-mean-query.func.js) | `88b03650f2299116e516f41bada379935c0692e3011e49b7b22fbc659f26a54c` | unchanged |
| [insert-chameleon-reading.func.js](issue-356-chameleon-reading-links/insert-chameleon-reading.func.js) | `f61363e4215be437ab5abfb470d1096236dd60dddae5434775a6a30e324b95d1` | unchanged |
| [calibration-local-backfill.func.js](issue-356-chameleon-reading-links/calibration-local-backfill.func.js) | `555f008c4f209f6f87c8332c7a757d157d5528e1b9614c099c8509f825080f8a` | unchanged |
| [apply-flow-edits.cjs](issue-356-chameleon-reading-links/apply-flow-edits.cjs) | `19e43b85929fbf701908f9efb4442775fa6506d15b702c2565f75ab5940884c9` | unchanged; its header still reads "plan r3" |
| [apply-repo-edits.cjs](issue-356-chameleon-reading-links/apply-repo-edits.cjs) | `e3d957707f7d60f41960165c2ea9bb7d30de82fdb06872c511956f068c9714ed` | changed |
| [proposed-test-chameleon-reading-links-schema.js](issue-356-chameleon-reading-links/proposed-test-chameleon-reading-links-schema.js) | `4c14b8fe110e1fe42d9048e4ad4247bc98920c3a2588fa2df7efa61dc7927eda` | unchanged |
| [proposed-test-chameleon-reading-link-ingest.js](issue-356-chameleon-reading-links/proposed-test-chameleon-reading-link-ingest.js) | `231c91aeae6d74d929abaef039f43fb87b227cbb3836d598f56df00222d56044` | changed |
| [proposed-test-unified-soil-tension-scheduler.js](issue-356-chameleon-reading-links/proposed-test-unified-soil-tension-scheduler.js) | `0f4df776f9b88d6a72da1a386c57123a836fb458d617553908132cb8cae95cd5` | changed |

Campaign-only, not copied and not linked: `materialize-plan-packet.cjs`, SHA-256 `ea5a1c64d35ddbd048a47e07f66502328c8684fe4d13966952aae5ef0f7e3940`, changed.

Forecast doc-hygiene findings for this plan at M6: 20, all sixteen-digit hex Node-RED node ids. Link rewriting does not change the count.

## Process record

- Resource checks were read-only, at 20:25Z, 20:37Z and 20:43Z: `pressure.json` schema 2, `launch_allowed=true`, no latch, sampler PID/PGID/SID `2956759`, start ticks `13452935` matching `/proc/2956759/stat`; `MemAvailable` 14.5, 13.0 and 13.5 GiB; swap 8/8 GiB, telemetry only. At 20:43Z the four installed hashes matched `resource-ram-policy-activation.json`. Deviation: not every shell invocation was preceded by its own full preflight, and the activation hashes were first compared at 20:43Z.
- Reads were direct: `git rev-parse`, `git show` and `git grep` of P objects, `grep`, `sed`, `awk` and `cat` of campaign files. Two `node -e` invocations parsed an extracted P `flows.json` copy to print decision-node lines and node names; no flow function was evaluated. Deviation: P blobs (`flows.json`, four verifier files) and two text-counting Python scripts were written as scratch files under `/tmp` directly, not through the wrapper. `python3 -I` ran only those scripts, for anchor counts against P text and doc-hygiene pattern counts on proposal text. No product code, test, editor, materializer, verifier or checker ran.
- Deviation, retained: at about 20:50Z one hashing command also carried `node .claude/skills/anti-slop-writing/slop-check.js` with stderr discarded and output cut by `head -0`, run from the campaign `reports/` directory. No `.claude` directory exists there or at the campaign root, so the path did not resolve and no checker code ran. Its own exit was not captured. The prose check of this report stays deferred.
- Exit codes: every shell invocation returned 0 overall. One invocation's first `cat` of a mis-pathed decisions file failed inside a sequence whose final command succeeded; the file was then read from the campaign root. No test, controller or wrapper exit exists; all are UNRUN.
- Mutations: the new report and the new resource directory only. The SHA-256 of all 36 earlier #356 files (r1 to r3 reports, reviews, resources and captures) was snapshotted before writing and compared at 20:49Z: identical. No ref, fetch, checkout, product file, ledger, PLAN, public write, PR action, live or cloud access, delegation, advisor or paid fallback.
- Campaign cutoffs stand: no new heavy work from 2026-11-01T22:30:00Z; final hand-off by 22:59:00Z.

## Next deliverable

Independent Sol review of `M1`, then the execution recipe above from `M1c`. The earlier text of this section asked for the r4 source review, which is done.
