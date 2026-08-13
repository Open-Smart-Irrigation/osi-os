# Dragino SDI-12 execution report

Status: COMPLETE through Tasks 0–18 and the post-review fix wave. Tasks 0–18 and four review-fix implementation commits are committed on branch AgroLink. No push, merge, PR, SSH, live gateway access, osicloud.ch access, or remote database access was performed.

Execution date: 2026-08-13
Checkout: /home/phil/Repos/osi-os-agrolink
Branch: AgroLink
Last implementation commit: 2cda6ae8
Historical Task 18 halt: node scripts/verify-sync-contract.js reported:
`FAIL: commands.schema.json enum drift: missing=SET_SDI12_IDENTIFY extra=(none) duplicates=(none)`

This is a plan/repo contract contradiction. The approved Task 10 flow registry contains SET_SDI12_IDENTIFY, but docs/contracts/sync-schema/commands.schema.json does not. The failing command was not caused by the last Task 17 documentation commit, so execution stopped under the hard-stop rule. A schema or paired-contract change was not improvised.

Read-only confirmation: the flow registry contains SET_SDI12_IDENTIFY; the schema enum does not. The extracted registry count was 46 command entries and the schema enum count was 49. The relevant verifier compares these sets at scripts/verify-sync-contract.js lines 352–372.

## Review-fix wave (post-review; plan task ledger unchanged)

The review ledger was read in full before this wave. These changes implement IB1–IB3, IS1–IS4, and IN1–IN7. No Task 0–18 checkbox was changed. The standing invariants remained active: both flow profiles were mirrored from bcm2712 to bcm2709, new nodes stayed before the journal-v2 worker cluster, and no protected-node hash was changed.

### Review commit 1 — IB1

- Commit: `853c1b35` (`fix(sdi12): realign config scope wires and cover denial`).
- Changes: both `scoped-device-config-guard` wire arrays now keep indices 0–23 byte-identical to Task 11 (`38965af3`), route index 24 to `sdi12-config-auth-fn`, route index 25 to `device-response`, and remove the unreachable 27th entry. `scripts/test-scoped-access-writes.js` covers a denied PUT that must not mutate `sdi12_probe_profile`, and an authorized PUT that must persist the new profile.
- IB1 wire evidence from the pre-task-12 comparison: `pre-task12 wires length=25`; `pre error index24=["device-response"]`; current `wires length=26`; current `index24=["sdi12-config-auth-fn"]`; current `index25=["device-response"]`; the printed index 0–23 lists were identical.
- TDD evidence before the fix: `node --test scripts/test-scoped-access-writes.js` reported the new denial regression with actual `TENSIOMARK`, expected `GENERIC_VWC`, `44 pass`, `1 fail`. After the fix: `45 tests`, `45 pass`, `0 fail`.
- Gate evidence: `node scripts/verify-profile-parity.js` → `All parity checks passed.`; `node scripts/verify-scoped-access.js` → `verify-scoped-access: OK`; flow parse, wiring, size, silent-catch, bare-require, no-stray-DDL, MQTT, sync-flow, and all scoped command/read/write suites were green.

### Review commit 2 — IB2 + IS4

- Commit: `9894db7e` (`fix(sdi12): plumb probe state through device cards`).
- Changes: `merge-device-data` now copies `sdi12_probe_profile`, `sdi12_probe_status`, `sdi12_identity`, and `updated_at`; the SDI-12 zone card receives `onRemove={() => handleRemoveDevice(device.deveui)}`; the soil-card test asserts the `unmatched` status chip.
- Gate evidence: focused `Sdi12SoilCard` test → `Test Files 1 passed (1)`, `Tests 3 passed (3)`; TypeScript exited 0; profile parity, size, parse, scoped-access, identity, and sync-flow gates were green.
- Minimal repository/API deviation: the existing `Sdi12SoilCard` prop type did not declare `onRemove`, so the approved parent wiring required the optional prop declaration. The card remains behaviorally unchanged; the parent now matches the sibling-section removal contract.

### Review commit 3 — IB3

- Commit: `09b806ea` (`fix(sdi12): remove dead SDI-12 telemetry fields`).
- Changes: both `Build Telemetry` copies retain the `DRAGINO_SDI12` profile mapping and `bat_v`, while removing the 24 permanently null `vwc_*`, `soil_temp_*`, and `soil_ec_*` reads. The spec sync section records: `SDI-12 channel values reach the cloud solely through DEVICE_DATA_APPENDED (the sync-outbox trigger); the MQTT Build Telemetry path intentionally does not carry them.`
- Gate evidence: both profile parity, size, function-parse, identity, sync-flow, and anti-slop checks were green; `verify-flows-size-ratchet` measured total `1304846 <= 1306598` after the removal.
- Deviation recorded by design: `DEVICE_DATA_APPENDED` is the sole cloud carrier for SDI-12 channel values; the verified sync-outbox trigger remains the correct path.

### Review commit 4 — IS1, IS2, IS3, IS4 follow-through, and nits

- Commit: `2cda6ae8` (`fix(sdi12): close review findings and refresh evidence`).
- IS1: the no-depths config branch now reads the existing depth JSON with a bound `deveui` parameter, retains only channels in the selected profile, and writes the resulting map and configured flag with bound parameters. The regression test initially failed with stale `vwc_1: 40` retained, `45 pass`, `1 fail`; after the fix the scoped-write suite reported `46 tests`, `46 pass`, `0 fail`.
- IS2: dead-letter warnings use a per-device `context.get`/`context.set` timestamp and a ten-minute cooldown; the yellow status remains emitted for every affected write.
- IS3: `HistoryCardDetailPage` now sends `DRAGINO_SDI12` soil source context to the registry branch. IS4’s zone-card removal callback was included in Review commit 2 and remains present in both maintained frontend paths.
- IN1/IN2/IN4/IN6/IN7: the modal omits `depths` when unchanged; SDI-12 profile-scope diagnostics are relabeled; the normalizer documents the provisional `WORST_CHARS_PER_VALUE = 7` assumption and the bench-verification requirement; the duplicate device-integration workflow run was removed; empty FPort 2 data is no-response without quarantine. The pre-fix modal test reported a received `depths: {"1":30}` where omission was expected; the post-fix focused suite reported `Test Files 1 passed (1)`, `Tests 3 passed (3)`. The pre-fix normalizer run reported `22 pass`, `2 fail`; the mirrored post-fix run reported `24 pass`, `0 fail`.
- IN3/IN5: this report corrects the boot-node count from four to five and records that later ratchet/hash maintenance was process follow-up; the atomic schema artifact itself remained one commit.
- Gate evidence: the final battery below includes the complete outputs. `node scripts/verify-live-gateway-identity.js` passed explicitly. No protected-node hash change was made after the approved Task 4 re-pin; any new mismatch would have remained a hard stop.

### Review-wave documentation

- The report update and review ledger are committed together in the follow-up documentation commit after the final battery. The implementation commit hashes above are exact; this wave does not check off any plan task.

## Task ledger

### Task 0 — Branch preparation

- Commit: bb898c97.
- Gates: git fast-forward; node scripts/verify-profile-parity.js; node scripts/verify-migrations.js.
- Evidence: `All parity checks passed.`; `verify-migrations: OK`.
- Deviations: none.

### Task 1 — Codec

- Commit: 1c47306e.
- Gates: node scripts/verify-sdi12-codec.js; node scripts/verify-codec-robustness.js; node scripts/verify-profile-parity.js.
- Evidence: `verify-sdi12-codec: PASS`; `Codec robustness verification passed`; `All parity checks passed.`
- Deviations: none.

### Task 2 — osi-sdi12-normalize module

- Commit: d2ad9cc6.
- Gates: the module’s node:test suite, profile/parity checks, and the Task 2 registry/parser checks.
- Evidence: the task gate was green before commit; the Task 18 run includes the same shipped module in the device-integration chain, which passed all 20 integration tests before the halt.
- Deviations: none.

### Task 3 — Channel manifest

- Commit: 4f70030b.
- Gates: node scripts/verify-channel-manifest-parity.js; profile parity; manifest and helper tests.
- Evidence: `Channel manifest parity verification passed`.
- Deviation: the plan named the history helper index but the verifier also required osi-history-helper/analysis.js. The minimal mirrored update was required by the verifier’s content coverage check.

### Task 4 — Atomic schema slice

- Commit: 6d8dae60. Parts A+B+C landed as one atomic commit.
- Gates: node scripts/verify-runtime-schema-parity.js; node scripts/verify-profile-parity.js; node scripts/verify-devices-rebuild-fence.js; node --test scripts/rehearse-devices-rebuild.test.js; seed/schema checks.
- Evidence: `verify-runtime-schema-parity: OK (2 flows: devices CHECK + runtime trigger parity)`; `verify-devices-rebuild-fence: OK (2 flows)`; rehearsal `# tests 5`, `# pass 5`, `# fail 0`.
- Deviation: the existing boot rebuild used a positional devices INSERT SELECT. The five approved schema-slice literal changes (three devices rebuild literals, the telemetry trigger payload, and the devices outbox profile gate) were appended to that existing shape minimally. The rehearsal runner also needed the sanctioned sdi12-sentinels case to exercise the new columns.

### Task 5 — Merged into Task 4 Part B

- Commit: 6d8dae60, per the plan’s explicit merge.
- Gates: covered by Task 4’s atomic schema gate block.
- Evidence: same Task 4 gate output.
- Deviations: none beyond the Task 4 note.

### Task 6 — Merged into Task 4 Part C

- Commit: 6d8dae60, per the plan’s explicit merge.
- Gates: covered by Task 4’s atomic schema gate block.
- Evidence: same Task 4 gate output.
- Deviations: none beyond the Task 4 note.

### Task 7 — Sync contract schema

- Commit: 268c9133.
- Gates: sync contract schema checks, helper/seed/parity checks.
- Evidence: task gates were green before commit.
- Deviations: none.

### Task 8 — ChirpStack provisioning

- Commit: 484fb6a1.
- Gates: provisioning/codec checks; helper registration; profile parity.
- Evidence: task gates were green before commit.
- Deviations: none.

### Approved Task 4 protected-node maintenance

- Standalone commit: 4cc9a678.
- Procedure evidence: sync-init-fn at 4f70030b had SHA-256 2ecba63b87c0389c9f1273267346101d861d5a076abe1410ec496111fe502263 and 74,217 characters. The current approved Task 4 text had SHA-256 2168cd5a1c5db035404ea73bc3677b2846ce580b6c512932b207ef0380a6f222 and 75,227 characters.
- Diff summary: REQUIRED_TYPES append; DEVICES_NEW_DDL extension; DEVICES_COPY_SQL extension; trg_dp_device_data_outbox_ai 24-field payload; and the Task 4-authorized SDI-12 devices outbox profile WHEN/payload pair.
- Evidence: the approved delta was reviewed before re-pinning. No later protected-node hash change was made.

### Task 9 — Ingest flow tab

- Commit: 38b9255d.
- Gates: bash scripts/check-mqtt-topics.sh; node scripts/flows-bare-require-scan.js; node scripts/verify-no-new-silent-catch.js; node scripts/verify-flows-size-ratchet.js; node scripts/verify-no-stray-ddl.js; node scripts/verify-profile-parity.js; plus flow parse, wiring, sync, and scoped-access gates.
- TDD evidence: the initial structural run failed with `AssertionError [ERR_ASSERTION]: expected SDI-12 gate output 2 to be wired`, actual 0, expected 1, exit 1.
- Final evidence: `verify-no-new-silent-catch: OK`; both profiles reported 164 empty catches against baseline 164; profile parity and flow gates were green.
- Deviations: none. All new nodes were placed before the journal-v2 worker cluster.

### Task 10 — Auto-identification

- Commit: 16b26429.
- Contract amendment commit: a2162460.
- Gates: flow parse/wiring, command-safety, size, parity, MQTT, silent-catch, bare-require, sync, and scoped-access suites.
- TDD evidence: the initial structural run failed with the same unwired gate output 2 assertion and missing handler.
- Final evidence: command-safety and flow gate blocks were green before commit.
- Deviation: the plan omitted the contract half of the approved command registration. The Task 18 halt exposed the drift: the flow registry contained SET_SDI12_IDENTIFY while commands.schema.json did not. The sanctioned amendment added the enum entry, then the verifier additionally required SET_SDI12_IDENTIFY in sync-contract-golden.json `commandTypes.accepted` and `cloudIssuerEnabled`; no payload definition was required. Fresh outputs were `verify-command-safety: OK` and `verify-sync-contract: OK`.

### Task 11 — Registration surfaces

- Commit: 38965af3.
- Gates: catalog/registration flow checks, command-safety, parity, size, sync, and scoped-access suites.
- TDD evidence: `AssertionError [ERR_ASSERTION]: catalog missing DRAGINO_SDI12`, exit 1.
- Ratchet evidence: the temporary unrelated catch cleanup correctly caused `live silent catch count 162 is below baseline 164`; that cleanup was reverted, preserving the maintained baseline.
- Final evidence: the full task gate block was green.
- Deviations: the plan’s sanctioned repair also restored the missing shipped AQUASCOPE_LORAIN and MILESIGHT_UC512 registration entries.

### Task 12 — Config API endpoints, amended and re-executed

- Commit: 6cc469e2.
- Initial halt evidence: `verify-scoped-access: FAIL` reported GET /api/sdi12/probe-profiles had no scope call in both profiles.
- Plan defect and amendment: the original Task 12 GET was public/static, but the scoped-access ratchet rejects new endpoints without a scope call and the Phase-A PUBLIC_ALLOWLIST is not valid for new endpoints. The amended plan made the GET session-scoped per the device-catalog precedent. The first Task 12 flow and allowance changes were reverted before re-execution.
- Minimal content deviation: the repository has no literal /api/devices/catalog chain. The shipped equivalent is GET /api/catalog through catalog-authenticated-read-guard; its function, libs, and rejection responses were cloned verbatim.
- Final evidence: the rebuilt GET scope chain, compliant PUT chain, profile parity, flow gates, `verify-scoped-access: OK`, and all three scoped-access suites were green. No sdi12 endpoint was added to PUBLIC_ALLOWLIST. New nodes remain before the journal-v2 cluster.

### Task 13 — Device type, latest data/export, soil card

- Commit: 22a6e0a4.
- Gates: flow size/parity/parse/wiring/sync/scoped-access; channel manifest parity; frontend typecheck and farming/channel tests.
- TDD evidence: the first card test failed to resolve Sdi12SoilCard; after implementation, the targeted suite reported `Test Files 1 passed (1)`, `Tests 2 passed (2)`.
- Final evidence: the frontend farming/channel suite reported `Test Files 21 passed (21)`, `Tests 88 passed (88)`; typecheck exited 0; flow and parity markers were green.
- Deviations: none. Existing downstream scope calls were preserved.

### Task 14 — Settings modal, dashboard wiring, history eligibility

- Commit: 4c67b566.
- Gates: modal, farming/channel, history, typecheck, helper/router tests, channel parity, and profile parity.
- TDD evidence: the first modal test failed to resolve Sdi12SettingsModal.
- Regression evidence: the first full component/channel run had 1 failure and 87/88 tests passed because the generic cardChannels default changed when the manifest expanded.
- Minimal correction: DRAGINO_SDI12 explicitly returns its 24 supported channels while legacy generic soil defaults remain unchanged. Final history output was `Test Files 38 passed (38)`, `Tests 260 passed (260)`; farming/channel output was `Test Files 21 passed (21)`, `Tests 88 passed (88)`; focused registry output was `Test Files 1 passed (1)`, `Tests 6 passed (6)`.

### Task 15 — Device-integration golden vectors

- Commit: f471545f.
- Gates: node scripts/verify-device-integration.js and CI workflow wiring.
- TDD evidence: the pre-implementation contract check failed because the SDI-12 fixture was absent, exit 1.
- Final evidence: the runner reported `# tests 20`, `# pass 20`, `# fail 0`; the SDI-12 suite covered all five vectors, including battery-only NULL, unparseable address, and atomic cardinality mismatch.
- Deviation: SQLite returned null-prototype rows in the quarantine assertion; the test harness mapped the selected fields to plain objects. Product behavior matched the vectors.

### Task 16 — Scheduler zone mean

- Commit: 8068e974.
- Gates: flow-editing roundtrip/parity, size, MQTT, parse/wiring, sync, and scoped-access suites.
- Content relocation evidence: the stated node ID was absent, but content search found d0b2b1c1a937e16d, “Build mean query (last hour, all datapoints)”, with the exact COALESCE query.
- TDD evidence: the pre-edit assertion failed because the scheduler type filter did not contain DRAGINO_SDI12, exit 1.
- Ratchet evidence: the approved filter grew the node and total by exactly 17 characters; the allowance was updated from 2,177 to 2,194 and total 1,306,387 to 1,306,404. The rerun reported `verify-flows-size-ratchet: OK` and all scoped suites passed.
- Final evidence: both flow roundtrips were byte-identical and `All parity checks passed.`

### Task 17 — Documentation

- Commit: 60dba9bd.
- Gates: node .claude/skills/anti-slop-writing/slop-check.js docs/devices/dragino-sdi12.md; combined check also included AGENTS.md.
- Evidence: `slop-check: PASS (no tier-1 findings)`. The combined run emitted only a tier-2 em-dash density warning for the pre-existing large AGENTS.md.
- Deviations: none. The guide labels recipe, identity, and profile-layout facts unverified until bench capture.

## Prior Task 18 halt (resolved)

The initial Task 18 wrapper ran the commands below sequentially and stopped at verify-sync-contract.js after channel-manifest parity. This historical halt is retained as evidence; the contract amendment and complete rerun are recorded below.

Task 18 command sequence:

```text
node scripts/verify-sdi12-codec.js
node scripts/verify-codec-robustness.js
node scripts/verify-lsn50-chameleon-codec.js
node scripts/verify-device-integration.js
node scripts/verify-helper-registration.js
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-devices-rebuild-fence.js
node --test scripts/rehearse-devices-rebuild.test.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-channel-manifest-parity.js
node scripts/verify-sync-contract.js
node scripts/verify-command-safety.js
node scripts/verify-communication-contract.js
node scripts/verify-no-stray-ddl.js
node scripts/verify-no-new-silent-catch.js
node scripts/flows-bare-require-scan.js
node scripts/verify-flows-size-ratchet.js
node scripts/test-flows-wiring.js
node scripts/verify-flows-fn-parse.js
node scripts/verify-trigger-body-parity.js
node scripts/verify-boot-ddl-interpolation.js
bash scripts/check-mqtt-topics.sh
node scripts/verify-profile-parity.js
node scripts/verify-live-gateway-identity.js
node scripts/verify-sync-flow.js
node scripts/verify-scoped-access.js
node scripts/test-scoped-access-command-path.js
node scripts/test-scoped-access-reads.js
node scripts/test-scoped-access-writes.js
(cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize && node --test)
```

The remaining work is:

- Resolve the sanctioned contract decision for SET_SDI12_IDENTIFY across the edge registry and commands.schema.json, with osi-server lockstep review. No schema or cloud-side change was made.
- Re-run the complete Task 18 battery from the first command after that decision. Task 18 must still receive its own commit if fixes are required.
- Run the frontend Vitest suite, TypeScript check, and production build; the build must remain last and alone.
- Complete the bench phase: capture each real probe’s raw SDI-12 response, finalize AT recipes, identity matchers, units, and golden vectors.
- Complete the osi-server lockstep gate for the sync-contract change.
- At the time of this captured halt, Task 18 was unchecked. The sanctioned contract amendment and final battery below resolve that halt.

## Full Task 18 gate-battery output

```text
verify-sdi12-codec: PASS
Codec robustness verification passed
LSN50 Chameleon codec checks passed
(node:3829954) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
TAP version 13
# Subtest: UC512 round-trip: codec → normalizer → writer → DB
    # Subtest: round-trip: battery + both valves closed
    ok 1 - round-trip: battery + both valves closed
      ---
      duration_ms: 29.763081
      type: 'test'
      ...
    # Subtest: round-trip: battery + valve 1 open + pulse counters
    ok 2 - round-trip: battery + valve 1 open + pulse counters
      ---
      duration_ms: 28.2596
      type: 'test'
      ...
    # Subtest: round-trip: full telemetry with pressure + GPIOs
    ok 3 - round-trip: full telemetry with pressure + GPIOs
      ---
      duration_ms: 27.669648
      type: 'test'
      ...
    # Subtest: round-trip: valve task response — success
    ok 4 - round-trip: valve task response — success
      ---
      duration_ms: 27.44846
      type: 'test'
      ...
    1..4
ok 1 - UC512 round-trip: codec → normalizer → writer → DB
  ---
  duration_ms: 114.159849
  type: 'suite'
  ...
# Subtest: SDI-12 round-trip: codec → profile normalizer → writer → DB
    # Subtest: round-trip: Tensiomark tension and temperature
    ok 1 - round-trip: Tensiomark tension and temperature
      ---
      duration_ms: 28.865616
      type: 'test'
      ...
    # Subtest: round-trip: generic VWC three values
    ok 2 - round-trip: generic VWC three values
      ---
      duration_ms: 27.529057
      type: 'test'
      ...
    # Subtest: round-trip: generic VWC no response
    ok 3 - round-trip: generic VWC no response
      ---
      duration_ms: 27.673
      type: 'test'
      ...
    # Subtest: round-trip: generic VWC address digit is unparseable
    ok 4 - round-trip: generic VWC address digit is unparseable
      ---
      duration_ms: 27.801929
      type: 'test'
      ...
    # Subtest: round-trip: Tensiomark cardinality mismatch is atomic
    ok 5 - round-trip: Tensiomark cardinality mismatch is atomic
      ---
      duration_ms: 30.252531
      type: 'test'
      ...
    1..5
ok 2 - SDI-12 round-trip: codec → profile normalizer → writer → DB
  ---
  duration_ms: 142.633164
  type: 'suite'
  ...
# Subtest: LSN50 round-trip: normalizer → writer → DB (default mode)
    # Subtest: default mode soil/dendro uplink
    ok 1 - default mode soil/dendro uplink
      ---
      duration_ms: 30.123254
      type: 'test'
      ...
    # Subtest: mode 9 rain/flow uplink
    ok 2 - mode 9 rain/flow uplink
      ---
      duration_ms: 31.18324
      type: 'test'
      ...
    1..2
ok 3 - LSN50 round-trip: normalizer → writer → DB (default mode)
  ---
  duration_ms: 61.477327
  type: 'suite'
  ...
# Subtest: LSN50 round-trip: production-shaped fixtures with both mode key sets present
    # Subtest: default mode with undefined inactive MOD9 placeholders produces zero dead letters
    ok 1 - default mode with undefined inactive MOD9 placeholders produces zero dead letters
      ---
      duration_ms: 29.346755
      type: 'test'
      ...
    # Subtest: MOD9 with undefined inactive default placeholders produces zero dead letters
    ok 2 - MOD9 with undefined inactive default placeholders produces zero dead letters
      ---
      duration_ms: 30.295134
      type: 'test'
      ...
    # Subtest: default mode with null inactive MOD9 placeholders produces zero dead letters
    ok 3 - default mode with null inactive MOD9 placeholders produces zero dead letters
      ---
      duration_ms: 28.085834
      type: 'test'
      ...
    # Subtest: MOD9 with null inactive default placeholders produces zero dead letters
    ok 4 - MOD9 with null inactive default placeholders produces zero dead letters
      ---
      duration_ms: 29.499987
      type: 'test'
      ...
    # Subtest: a populated MOD9-only field on a default-mode uplink produces exactly one unknown_channel row
    ok 5 - a populated MOD9-only field on a default-mode uplink produces exactly one unknown_channel row
      ---
      duration_ms: 29.108175
      type: 'test'
      ...
    # Subtest: a populated default-only field on a MOD9 uplink produces exactly one unknown_channel row
    ok 6 - a populated default-only field on a MOD9 uplink produces exactly one unknown_channel row
      ---
      duration_ms: 28.791793
      type: 'test'
      ...
    # Subtest: a populated field outside both shipped maps produces exactly one unknown_channel row
    ok 7 - a populated field outside both shipped maps produces exactly one unknown_channel row
      ---
      duration_ms: 28.878816
      type: 'test'
      ...
    1..7
ok 4 - LSN50 round-trip: production-shaped fixtures with both mode key sets present
  ---
  duration_ms: 204.413183
  type: 'suite'
  ...
# Subtest: LSN50 normalizer coverage parity with old SQL path
    # Subtest: default mode produces exactly the columns the old SQL wrote
    ok 1 - default mode produces exactly the columns the old SQL wrote
      ---
      duration_ms: 0.230477
      type: 'test'
      ...
    # Subtest: mode 9 produces exactly the columns the old SQL wrote
    ok 2 - mode 9 produces exactly the columns the old SQL wrote
      ---
      duration_ms: 0.138356
      type: 'test'
      ...
    1..2
ok 5 - LSN50 normalizer coverage parity with old SQL path
  ---
  duration_ms: 0.493781
  type: 'suite'
  ...
1..5
# tests 20
# suites 5
# pass 20
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 544.55869
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-chameleon-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-chirpstack-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-cloud-http
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-command-ledger
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-db-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-dendro-analytics
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-dendro-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-device-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-device-writer
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-health-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-history-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-history-router
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-history-sync-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-installation-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-irrigation-config-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-journal
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-journal-replication
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-lib
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-lsn50-normalize
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-scope-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-scoped-access-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-sdi12-normalize
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-uc512-normalize
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-zone-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-zone-env
OK [conf/full_raspberrypi_bcm27xx_bcm2712] codec NAME_TO_PATH entries
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-chameleon-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-chirpstack-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-cloud-http
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-command-ledger
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-db-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-dendro-analytics
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-dendro-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-device-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-device-writer
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-health-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-history-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-history-router
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-history-sync-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-installation-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-irrigation-config-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-journal
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-journal-replication
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-lib
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-lsn50-normalize
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-scope-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-scoped-access-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-sdi12-normalize
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-uc512-normalize
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-zone-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-zone-env
OK [conf/full_raspberrypi_bcm27xx_bcm2709] codec NAME_TO_PATH entries
All helper-registration checks passed.
verify-migrations: OK (46 migrations, checksum manifest OK, base immutability OK)
verify-seed-replay: OK
verify-runtime-schema-parity: OK (2 flows: devices CHECK + runtime trigger parity)
verify-devices-rebuild-fence: OK (2 flows)
TAP version 13
# (node:3847464) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# (node:3847485) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# (node:3847510) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# (node:3847523) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# (node:3847534) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: healthy DB: guard SKIPS the rebuild, rows preserved
ok 1 - healthy DB: guard SKIPS the rebuild, rows preserved
  ---
  duration_ms: 165.414348
  type: 'test'
  ...
# Subtest: a row the target CHECK rejects is NEVER silently dropped, and the abort is surfaced
ok 2 - a row the target CHECK rejects is NEVER silently dropped, and the abort is surfaced
  ---
  duration_ms: 199.471452
  type: 'test'
  ...
# Subtest: legit upgrade: rebuild succeeds, rows preserved, CHECK gains AQUASCOPE_LORAIN
ok 3 - legit upgrade: rebuild succeeds, rows preserved, CHECK gains AQUASCOPE_LORAIN
  ---
  duration_ms: 205.852382
  type: 'test'
  ...
# Subtest: SDI-12 sentinels survive the rebuild with all three columns present
ok 4 - SDI-12 sentinels survive the rebuild with all three columns present
  ---
  duration_ms: 208.000289
  type: 'test'
  ...
# Subtest: extra drifted type: set-equality guard rebuilds and converges the CHECK (drops the extra), rows preserved
ok 5 - extra drifted type: set-equality guard rebuilds and converges the CHECK (drops the extra), rows preserved
  ---
  duration_ms: 210.230676
  type: 'test'
  ...
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1042.861174
OK conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
OK database/farming.db
OK web/react-gui/farming.db
DB schema consistency verification passed
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js channelsForCard id coverage is covered by channels manifest keys/legacyAliases (46 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js channelsForCard field coverage is covered by channels manifest keys/legacyAliases (46 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js ALLOWED_DEVICE_DATA_CHANNELS coverage is covered by channels manifest keys/legacyAliases (75 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js VALID_EXPORT_CHANNEL_KEYS exactly matches channels manifest (58 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js LEGACY_CHANNEL_ALIASES exactly matches channels manifest (5 aliases)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.js CHANNELS exactly matches active analysis channels manifest metadata (58 channels)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js channelsForCard id coverage is covered by channels manifest keys/legacyAliases (46 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js channelsForCard field coverage is covered by channels manifest keys/legacyAliases (46 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js ALLOWED_DEVICE_DATA_CHANNELS coverage is covered by channels manifest keys/legacyAliases (75 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js VALID_EXPORT_CHANNEL_KEYS exactly matches channels manifest (58 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js LEGACY_CHANNEL_ALIASES exactly matches channels manifest (5 aliases)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/analysis.js CHANNELS exactly matches active analysis channels manifest metadata (58 channels)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/edge-channels.json exactly matches channels.json edge projection (73 entries)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/edge-channels.json exactly matches channels.json edge projection (73 entries)
Channel manifest parity verification passed
FAIL: commands.schema.json enum drift: missing=SET_SDI12_IDENTIFY extra=(none) duplicates=(none)

```

## Remaining after the captured output (historical, resolved below)

- Resolve the sanctioned `SET_SDI12_IDENTIFY` edge/cloud contract decision and rerun Task 18 from the first command.
- Run the not-reached scoped-access suites, frontend Vitest, TypeScript check, and production build; keep the build last and alone.
- Complete bench capture and the osi-server lockstep gate.

## Task 18 final completion

- Contract amendment: added SET_SDI12_IDENTIFY to the commands schema enum and, because the verifier demanded exact golden-list parity, to sync-contract-golden.json accepted/cloudIssuerEnabled lists. No payload definition was required.
- Final gate run: all commands below ran sequentially from the first Task 18 command. The frontend Vitest suite, TypeScript check, and production build were separate commands; the build was last and alone.
- Evidence: 172 frontend test files and 1,705 tests passed; TypeScript exited 0; the production build transformed 1,723 modules and completed successfully in 7.50s. Scoped-access suites passed 5, 29, and 44 tests; the SDI-12 helper suite passed 11 tests.
- Commit: 3dd73a70 (report and checked-off Task 18 plan step).

### Full final Task 18 gate-battery output

```text
+
$ node scripts/verify-sdi12-codec.js
verify-sdi12-codec: PASS

$ node scripts/verify-codec-robustness.js
Codec robustness verification passed

$ node scripts/verify-lsn50-chameleon-codec.js
LSN50 Chameleon codec checks passed

$ node scripts/verify-device-integration.js
(node:3875966) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
TAP version 13
# Subtest: UC512 round-trip: codec → normalizer → writer → DB
    # Subtest: round-trip: battery + both valves closed
    ok 1 - round-trip: battery + both valves closed
      ---
      duration_ms: 30.915252
      type: 'test'
      ...
    # Subtest: round-trip: battery + valve 1 open + pulse counters
    ok 2 - round-trip: battery + valve 1 open + pulse counters
      ---
      duration_ms: 30.901983
      type: 'test'
      ...
    # Subtest: round-trip: full telemetry with pressure + GPIOs
    ok 3 - round-trip: full telemetry with pressure + GPIOs
      ---
      duration_ms: 29.867146
      type: 'test'
      ...
    # Subtest: round-trip: valve task response — success
    ok 4 - round-trip: valve task response — success
      ---
      duration_ms: 28.850608
      type: 'test'
      ...
    1..4
ok 1 - UC512 round-trip: codec → normalizer → writer → DB
  ---
  duration_ms: 121.548663
  type: 'suite'
  ...
# Subtest: SDI-12 round-trip: codec → profile normalizer → writer → DB
    # Subtest: round-trip: Tensiomark tension and temperature
    ok 1 - round-trip: Tensiomark tension and temperature
      ---
      duration_ms: 29.252125
      type: 'test'
      ...
    # Subtest: round-trip: generic VWC three values
    ok 2 - round-trip: generic VWC three values
      ---
      duration_ms: 27.865709
      type: 'test'
      ...
    # Subtest: round-trip: generic VWC no response
    ok 3 - round-trip: generic VWC no response
      ---
      duration_ms: 29.184658
      type: 'test'
      ...
    # Subtest: round-trip: generic VWC address digit is unparseable
    ok 4 - round-trip: generic VWC address digit is unparseable
      ---
      duration_ms: 29.8698
      type: 'test'
      ...
    # Subtest: round-trip: Tensiomark cardinality mismatch is atomic
    ok 5 - round-trip: Tensiomark cardinality mismatch is atomic
      ---
      duration_ms: 30.200009
      type: 'test'
      ...
    1..5
ok 2 - SDI-12 round-trip: codec → profile normalizer → writer → DB
  ---
  duration_ms: 146.899113
  type: 'suite'
  ...
# Subtest: LSN50 round-trip: normalizer → writer → DB (default mode)
    # Subtest: default mode soil/dendro uplink
    ok 1 - default mode soil/dendro uplink
      ---
      duration_ms: 30.637982
      type: 'test'
      ...
    # Subtest: mode 9 rain/flow uplink
    ok 2 - mode 9 rain/flow uplink
      ---
      duration_ms: 27.753334
      type: 'test'
      ...
    1..2
ok 3 - LSN50 round-trip: normalizer → writer → DB (default mode)
  ---
  duration_ms: 58.587919
  type: 'suite'
  ...
# Subtest: LSN50 round-trip: production-shaped fixtures with both mode key sets present
    # Subtest: default mode with undefined inactive MOD9 placeholders produces zero dead letters
    ok 1 - default mode with undefined inactive MOD9 placeholders produces zero dead letters
      ---
      duration_ms: 29.603216
      type: 'test'
      ...
    # Subtest: MOD9 with undefined inactive default placeholders produces zero dead letters
    ok 2 - MOD9 with undefined inactive default placeholders produces zero dead letters
      ---
      duration_ms: 28.815687
      type: 'test'
      ...
    # Subtest: default mode with null inactive MOD9 placeholders produces zero dead letters
    ok 3 - default mode with null inactive MOD9 placeholders produces zero dead letters
      ---
      duration_ms: 29.054055
      type: 'test'
      ...
    # Subtest: MOD9 with null inactive default placeholders produces zero dead letters
    ok 4 - MOD9 with null inactive default placeholders produces zero dead letters
      ---
      duration_ms: 28.980582
      type: 'test'
      ...
    # Subtest: a populated MOD9-only field on a default-mode uplink produces exactly one unknown_channel row
    ok 5 - a populated MOD9-only field on a default-mode uplink produces exactly one unknown_channel row
      ---
      duration_ms: 28.562583
      type: 'test'
      ...
    # Subtest: a populated default-only field on a MOD9 uplink produces exactly one unknown_channel row
    ok 6 - a populated default-only field on a MOD9 uplink produces exactly one unknown_channel row
      ---
      duration_ms: 27.868502
      type: 'test'
      ...
    # Subtest: a populated field outside both shipped maps produces exactly one unknown_channel row
    ok 7 - a populated field outside both shipped maps produces exactly one unknown_channel row
      ---
      duration_ms: 27.286096
      type: 'test'
      ...
    1..7
ok 4 - LSN50 round-trip: production-shaped fixtures with both mode key sets present
  ---
  duration_ms: 200.55548
  type: 'suite'
  ...
# Subtest: LSN50 normalizer coverage parity with old SQL path
    # Subtest: default mode produces exactly the columns the old SQL wrote
    ok 1 - default mode produces exactly the columns the old SQL wrote
      ---
      duration_ms: 0.303879
      type: 'test'
      ...
    # Subtest: mode 9 produces exactly the columns the old SQL wrote
    ok 2 - mode 9 produces exactly the columns the old SQL wrote
      ---
      duration_ms: 0.184102
      type: 'test'
      ...
    1..2
ok 5 - LSN50 normalizer coverage parity with old SQL path
  ---
  duration_ms: 0.618652
  type: 'suite'
  ...
1..5
# tests 20
# suites 5
# pass 20
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 553.421503

$ node scripts/verify-helper-registration.js
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-chameleon-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-chirpstack-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-cloud-http
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-command-ledger
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-db-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-dendro-analytics
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-dendro-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-device-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-device-writer
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-health-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-history-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-history-router
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-history-sync-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-installation-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-irrigation-config-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-journal
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-journal-replication
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-lib
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-lsn50-normalize
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-scope-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-scoped-access-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-sdi12-normalize
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-uc512-normalize
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-zone-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-zone-env
OK [conf/full_raspberrypi_bcm27xx_bcm2712] codec NAME_TO_PATH entries
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-chameleon-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-chirpstack-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-cloud-http
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-command-ledger
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-db-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-dendro-analytics
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-dendro-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-device-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-device-writer
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-health-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-history-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-history-router
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-history-sync-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-installation-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-irrigation-config-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-journal
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-journal-replication
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-lib
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-lsn50-normalize
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-scope-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-scoped-access-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-sdi12-normalize
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-uc512-normalize
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-zone-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-zone-env
OK [conf/full_raspberrypi_bcm27xx_bcm2709] codec NAME_TO_PATH entries
All helper-registration checks passed.

$ node scripts/verify-migrations.js
verify-migrations: OK (46 migrations, checksum manifest OK, base immutability OK)

$ node scripts/verify-seed-replay.js
verify-seed-replay: OK

$ node scripts/verify-runtime-schema-parity.js
verify-runtime-schema-parity: OK (2 flows: devices CHECK + runtime trigger parity)

$ node scripts/verify-devices-rebuild-fence.js
verify-devices-rebuild-fence: OK (2 flows)

$ node --test scripts/rehearse-devices-rebuild.test.js
TAP version 13
# (node:3893989) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# (node:3893998) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# (node:3894013) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# (node:3894024) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# (node:3894046) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: healthy DB: guard SKIPS the rebuild, rows preserved
ok 1 - healthy DB: guard SKIPS the rebuild, rows preserved
  ---
  duration_ms: 160.270321
  type: 'test'
  ...
# Subtest: a row the target CHECK rejects is NEVER silently dropped, and the abort is surfaced
ok 2 - a row the target CHECK rejects is NEVER silently dropped, and the abort is surfaced
  ---
  duration_ms: 187.151825
  type: 'test'
  ...
# Subtest: legit upgrade: rebuild succeeds, rows preserved, CHECK gains AQUASCOPE_LORAIN
ok 3 - legit upgrade: rebuild succeeds, rows preserved, CHECK gains AQUASCOPE_LORAIN
  ---
  duration_ms: 208.810189
  type: 'test'
  ...
# Subtest: SDI-12 sentinels survive the rebuild with all three columns present
ok 4 - SDI-12 sentinels survive the rebuild with all three columns present
  ---
  duration_ms: 209.962358
  type: 'test'
  ...
# Subtest: extra drifted type: set-equality guard rebuilds and converges the CHECK (drops the extra), rows preserved
ok 5 - extra drifted type: set-equality guard rebuilds and converges the CHECK (drops the extra), rows preserved
  ---
  duration_ms: 211.561791
  type: 'test'
  ...
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1032.919108

$ node scripts/verify-db-schema-consistency.js
OK conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
OK database/farming.db
OK web/react-gui/farming.db
DB schema consistency verification passed

$ node scripts/verify-channel-manifest-parity.js
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js channelsForCard id coverage is covered by channels manifest keys/legacyAliases (46 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js channelsForCard field coverage is covered by channels manifest keys/legacyAliases (46 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js ALLOWED_DEVICE_DATA_CHANNELS coverage is covered by channels manifest keys/legacyAliases (75 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js VALID_EXPORT_CHANNEL_KEYS exactly matches channels manifest (58 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js LEGACY_CHANNEL_ALIASES exactly matches channels manifest (5 aliases)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.js CHANNELS exactly matches active analysis channels manifest metadata (58 channels)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js channelsForCard id coverage is covered by channels manifest keys/legacyAliases (46 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js channelsForCard field coverage is covered by channels manifest keys/legacyAliases (46 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js ALLOWED_DEVICE_DATA_CHANNELS coverage is covered by channels manifest keys/legacyAliases (75 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js VALID_EXPORT_CHANNEL_KEYS exactly matches channels manifest (58 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js LEGACY_CHANNEL_ALIASES exactly matches channels manifest (5 aliases)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/analysis.js CHANNELS exactly matches active analysis channels manifest metadata (58 channels)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/edge-channels.json exactly matches channels.json edge projection (73 entries)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/edge-channels.json exactly matches channels.json edge projection (73 entries)
Channel manifest parity verification passed

$ node scripts/verify-sync-contract.js
  ok command enum = registry 46 + routed 4 + staged 0
  ok journal, scoped-access, and zone semantic bindings are exact and machine-readable
  ok golden operations, ACK results, and capability rollout metadata
  ok commands.schema.json is present and valid JSON
  ok events.schema.json is present and valid JSON
  ok resources.schema.json is present and valid JSON
  ok sync-contract-golden.json is present and valid JSON
  ok journal-v2.schema.json is present and valid JSON
  ok journal-v2-golden.json is present and valid JSON
  ok canonicalization-v2.md is present
verify-sync-contract: OK

$ node scripts/verify-command-safety.js
  ok valve_actuation_expectations has required columns
  ok zone_irrigation_calibration has required columns
  ok conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db has STREGA safety tables
  ok valve_actuation_expectations has required columns
  ok zone_irrigation_calibration has required columns
  ok conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db has STREGA safety tables
  ok valve_actuation_expectations has required columns
  ok zone_irrigation_calibration has required columns
  ok conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db has STREGA safety tables
  ok valve_actuation_expectations has required columns
  ok zone_irrigation_calibration has required columns
  ok conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db has STREGA safety tables
  ok valve_actuation_expectations has required columns
  ok zone_irrigation_calibration has required columns
  ok conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db has STREGA safety tables
  ok valve_actuation_expectations has required columns
  ok zone_irrigation_calibration has required columns
  ok database/farming.db has STREGA safety tables
  ok valve_actuation_expectations has required columns
  ok zone_irrigation_calibration has required columns
  ok web/react-gui/farming.db has STREGA safety tables
  ok Indefinite-open rejection node present
  ok REST valve endpoint rejects indefinite OPEN and accepts duration_seconds
  ok Route Command handles duration-bound valve registry commands
  ok Write-expectation node present and references required fields
  ok STREGA reconciliation monitor present with required state transitions
  ok Explicit cancel path flushes queue without a CLOSE downlink
  ok ChirpStack queue flush uses DeviceService.FlushQueue gRPC
  ok frontend valve controls are duration-bound and report cancel results
  ok "Reject Indefinite Open" fallback consistent with primary (46/46 keys, all actuator keys present)
  ok "Write STREGA Expectation" fallback consistent with primary (46/46 keys, all actuator keys present)
  ok Command Type Registry checked against 2 fallback(s) (46 primary entries)
  ok All actuator commands are duration-bounded or in the close allowlist
  ok Bare OPEN is not in the command-type registry
verify-command-safety: OK

$ node scripts/verify-communication-contract.js
Communication contract verification passed

$ node scripts/verify-no-stray-ddl.js
verify-no-stray-ddl: OK (HEAD total 702 <= origin/main total 702; committed baseline matches HEAD total 702)

$ node scripts/verify-no-new-silent-catch.js
verify-no-new-silent-catch: OK
- bcm2712: 164 empty catches across 287 function nodes (baseline 164)
- bcm2709: 164 empty catches across 287 function nodes (baseline 164)

$ node scripts/flows-bare-require-scan.js

$ node scripts/verify-flows-size-ratchet.js
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json (total 1306404 <= max_total 1306404)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json (total 1306404 <= max_total 1306404)
verify-flows-size-ratchet: OK (exact node coverage and all max_chars/max_total ceilings held)

$ node scripts/test-flows-wiring.js
OK  journal bootstrap behavior harness
OK  journal catch → error link out
OK  Field requests: GET /api/improvement-requests present
OK  Field requests: GET /api/improvement-requests/diagnostics-preview present
OK  Field requests: POST /api/improvement-requests present
OK  Field requests: intake router declares osiDb and closes DB
OK  Field requests: intake router validates revised public request contract
OK  Field requests: support-delivery 5 minute tick present
OK  Field requests: support-delivery-worker declares osiDb, posts unauthenticated support payloads, and retries with backoff
OK  Field requests: pending commands split status updates away from actuator path
OK  Field requests: status apply updates improvement_requests and queues ACK
OK  C5: from-scheduler/manual → write-strega-expectation
OK  C5b: Route Command output 0 reaches write-strega-expectation only via link-out (no double-invoke)
OK  C5: write-strega-expectation → Build STREGA downlink
OK  H2: STALE_OPEN_OBSERVED present in reconciliation monitor
OK  L1: write-strega-expectation has hardcoded fallback
OK  L1: reject-indefinite-open has hardcoded fallback
OK  M8: strega-today-liters-http-in present
OK  M8: strega-today-liters-fn present
OK  M8: strega-today-liters-http-out present
OK  osiDb.Database: every opening node closes it
OK  ChirpStack provisioning clients: every opening node hoists one client and closes it
OK  function node helper globals all declare matching libs entries
OK  settings modules: bulk schedule-disable endpoint present
OK  journal helper failure paths return exact fail-closed outputs
OK  Field requests: support-delivery-worker accepts result/status terminal response matrix
PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed

$ node scripts/verify-flows-fn-parse.js
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json (287 function nodes, 287 sources parsed)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json (287 function nodes, 287 sources parsed)
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json (64 function nodes, 64 sources parsed)
verify-flows-fn-parse: OK

$ node scripts/verify-trigger-body-parity.js
OK /home/phil/Repos/osi-os-agrolink/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json (all boot-managed trigger bodies match seed-blank.sql after canonicalization)
OK /home/phil/Repos/osi-os-agrolink/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json (all boot-managed trigger bodies match seed-blank.sql after canonicalization)
verify-trigger-body-parity: OK
(node:3895724) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)

$ node scripts/verify-boot-ddl-interpolation.js
OK /home/phil/Repos/osi-os-agrolink/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json (60 boot statements; no gatewaySql leak; versioned outbox triggers pass NEW.sync_version)
OK /home/phil/Repos/osi-os-agrolink/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json (60 boot statements; no gatewaySql leak; versioned outbox triggers pass NEW.sync_version)
verify-boot-ddl-interpolation: OK
(node:3895734) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)

$ bash scripts/check-mqtt-topics.sh
OK: conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json — no UUID patterns in MQTT IN topics
OK: conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json — no UUID patterns in MQTT IN topics
OK: conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json — no UUID patterns in MQTT IN topics

$ node scripts/verify-profile-parity.js

=== conf/full_raspberrypi_bcm27xx_bcm2709 ===
OK:   files/etc/board.d/02_network
OK:   files/etc/config
OK:   files/etc/init.d/osi-rootfs-resize
OK:   files/etc/init.d/osi-bootstrap
OK:   files/etc/init.d/osi-identityd
OK:   files/etc/nginx
OK:   files/etc/redis.conf
OK:   files/etc/sysupgrade.conf
OK:   files/etc/uci-defaults/90_osi_rootfs_grow
OK:   files/etc/uci-defaults/94_osi_identityd_enable
OK:   files/etc/uci-defaults/95_osi_bootstrap_enable
OK:   files/etc/uci-defaults/96_osi_server_config
OK:   files/etc/uci-defaults/97_osi_db_seed
OK:   files/etc/uci-defaults/98_osi_node_red_seed
OK:   files/etc/uci-defaults/99_config_chirpstack_ap
OK:   files/etc/uci-defaults/99_set_hostname
OK:   files/etc/uci-defaults/99_set_sx1301_gateway_id
OK:   files/etc/uci-defaults/99_tailscale_init
OK:   files/usr/libexec/osi-gateway-identity.sh
OK:   files/usr/libexec/osi-identityd.sh
OK:   files/usr/share/db
OK:   files/usr/share/flows.json
OK:   files/usr/share/node-red
OK:   absent: files/etc/uci-defaults/01_update_rc_local_20241118
OK:   absent: files/etc/uci-defaults/99_set_chirpstack_mqtt_forwarder_global_config
OK:   absent: files/etc/uci-defaults/99_set_chirpstack_udp_forwarder_global_config
OK:   absent: files/usr/share/schema.sql
OK:   absent: files/usr/share/sensor_data.db

All parity checks passed.

$ node scripts/verify-live-gateway-identity.js
OK openwrt/osi-os.config: build includes jsonfilter
OK jsonfilter Makefile: pinned OpenWrt source declares jsonfilter
OK jsonfilter Makefile: pins the reviewed jsonfilter source revision
OK jsonfilter Makefile: package installs /usr/bin/jsonfilter
OK procd Makefile: pins the reviewed procd rcS snapshot semantics
OK OpenWrt boot init: creates the daemon run directory before applying uci-defaults
OK OpenWrt boot init: retains a failed uci-default for the next boot
OK scripts/verify-sync-flow.js: sync verification chains the live identity verifier
OK scripts/test-identityd-service-lifecycle.sh: mode 755
OK Node-RED init: STOP=99
OK conf/full_raspberrypi_bcm27xx_bcm2712/.config: profile image includes jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service starts before Node-RED and bootstrap
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service stops before Node-RED STOP=99
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: STOP=98 precedes Node-RED STOP=99
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service uses procd
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service launches the identity daemon
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service is supervised with respawn
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service exposes one readiness contract
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: ready requires procd running and the daemon-owned live lock
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: defaults to a same-boot start
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: records whether rcS already queued the service before enabling it
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: uci-defaults enables the service and remains retryable on failure
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: starts the service on the same factory boot and verifies a fresh live lock owner with a bounded retry
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: checks the rcS snapshot, enables, starts conditionally, then verifies readiness
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: has exactly one enable and one conditional start call
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: has exactly one post-start readiness check
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap requests a coordinated restart
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap proves a live consumer immediately before publishing its restart request
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap removes its stamp when restart coordination fails
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap logs restart-request retry behavior
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap does not restart Node-RED directly
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon parses JSON with jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon owns the lock-readiness predicate
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: readiness requires the atomic symlink lock and its canonical live PID owner
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon CLI exposes readiness
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon validates nullable JSON field types with jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon bounds shell arithmetic inputs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon reads a monotonic clock
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: sentinel carries a monotonic deadline
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: queued delay begins when the daemon consumes the request
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: restart countdown uses the monotonic deadline
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: restart eligibility uses the monotonic clock
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: cache and request readers each reject non-canonical JSON
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: sentinel reader rejects non-canonical JSON
OK conf/full_raspberrypi_bcm27xx_bcm2709/.config: profile image includes jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service starts before Node-RED and bootstrap
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service stops before Node-RED STOP=99
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: STOP=98 precedes Node-RED STOP=99
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service uses procd
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service launches the identity daemon
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service is supervised with respawn
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service exposes one readiness contract
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: ready requires procd running and the daemon-owned live lock
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: defaults to a same-boot start
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: records whether rcS already queued the service before enabling it
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: uci-defaults enables the service and remains retryable on failure
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: starts the service on the same factory boot and verifies a fresh live lock owner with a bounded retry
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: checks the rcS snapshot, enables, starts conditionally, then verifies readiness
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: has exactly one enable and one conditional start call
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: has exactly one post-start readiness check
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: bootstrap requests a coordinated restart
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: bootstrap proves a live consumer immediately before publishing its restart request
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: bootstrap removes its stamp when restart coordination fails
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: bootstrap logs restart-request retry behavior
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: bootstrap does not restart Node-RED directly
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon parses JSON with jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon owns the lock-readiness predicate
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: readiness requires the atomic symlink lock and its canonical live PID owner
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon CLI exposes readiness
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon validates nullable JSON field types with jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon bounds shell arithmetic inputs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon reads a monotonic clock
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: sentinel carries a monotonic deadline
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: queued delay begins when the daemon consumes the request
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: restart countdown uses the monotonic deadline
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: restart eligibility uses the monotonic clock
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: cache and request readers each reject non-canonical JSON
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: sentinel reader rejects non-canonical JSON
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: byte-identical mirror
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: byte-identical mirror
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: byte-identical mirror
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: byte-identical mirror
OK scripts/verify-profile-parity.js: CANONICAL_PAYLOAD includes files/usr/libexec/osi-identityd.sh
OK scripts/verify-profile-parity.js: CANONICAL_PAYLOAD includes files/etc/init.d/osi-identityd
OK scripts/verify-profile-parity.js: CANONICAL_PAYLOAD includes files/etc/uci-defaults/94_osi_identityd_enable
OK deploy.sh: fetches the identity daemon
OK deploy.sh: installs the identity daemon
OK deploy.sh: marks the identity daemon executable
OK deploy.sh: fetches the identity service
OK deploy.sh: installs the identity service
OK deploy.sh: marks the identity service executable
OK deploy.sh: fetches the service enable script
OK deploy.sh: installs the service enable script
OK deploy.sh: marks the service enable script executable
OK deploy.sh: fetches the coordinated bootstrap service
OK deploy.sh: installs the coordinated bootstrap service
OK deploy.sh: marks the bootstrap service executable
OK deploy.sh: uses the installed identityd service through the lifecycle fence
OK deploy.sh: enables identityd during live deploy
OK deploy.sh: starts a fresh identityd during live deploy
OK deploy.sh: checks the shared readiness contract during live deploy
OK deploy.sh: does not restart an unquiesced identityd instance
OK deploy.sh: identityd activation follows gateway identity helper installation
OK deploy.sh: identityd activation follows identity daemon installation
OK deploy.sh: identityd activation follows flows payload staging
OK deploy.sh: identityd activation follows flows payload activation
OK deploy.sh: identityd activation follows GUI extraction
OK deploy.sh: uses a bounded shared readiness loop
OK deploy.sh: treats broken symlink locks as present
OK deploy.sh: waits for both procd absence and lock absence
OK deploy.sh: never deletes the daemon ownership lock
OK deploy.sh: preserves queued restart requests while quiesced
OK deploy.sh: preserves the restart sentinel while quiesced
OK deploy.sh: installs restoration and proves quiescence before the sole migration call
OK deploy.sh: has one lifecycle-fenced migration call
OK deploy.sh: catastrophic migration failure explicitly holds both services stopped
OK deploy.sh: EXIT restoration handles Node-RED before identityd and preserves failure status
OK deploy.sh: uses one EXIT cleanup path with signal-specific exit status
OK deploy.sh: final activation starts only after the quiescence gap and waits for readiness
OK deploy.sh: final readiness follows identityd enable/start
OK deploy.sh: disarms restoration only after final readiness succeeds
OK deploy.sh: preserves the missing-DB sidecar guard
OK deploy.sh: retains the direct Node-RED restart immediately after the live payload flip and its existing log
OK deploy.sh: retains the rollback restart
OK deploy.sh: only payload flip and rollback directly restart Node-RED
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json: flow document is an array
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: preserves its absent libs property
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not use require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: restartState reads are allowlisted to reason and restartAt
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field phase
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field restartAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field restartNotBeforeUptime
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field targetDeviceEui
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field target_device_eui
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field requestedAt
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field confidence
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field version
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: missing restart sentinel returns restartPending null
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: valid restart sentinel exposes only restartAt and reason
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: unauthenticated stats omit private and internal sentinel fields
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: missing sentinel reason uses the reviewed public fallback
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: no-deadline healing state exposes a blocked public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: an expired pending deadline remains visible until daemon cleanup
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: invalid JSON exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: array shape exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: non-string deadline exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: unreadable restart sentinel exposes an unreadable public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: hwmon directory failure keeps the fan fallback and warns with context
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: fan probe failures retain the fallback and warn for each probed path
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: expected ENOENT and ENOTDIR fan absence stays quiet with the existing fallback
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: a persistent unexpected fan failure warns once per path and signature
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: a changed unexpected fan failure warns again
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: successful fan-probe recovery resets warning deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: remembered fan failure signatures are bounded
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: successful hwmon listing prunes disappeared children and keeps current deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: disappeared hwmon path warns when it recurs while the current path remains deduplicated
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: hwmon hotplug churn keeps the complete failure map at or below 32 entries
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: successful hwmon listing prunes disappeared children and retains identical current deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: a pruned hwmon path warns when it recurs while the retained path stays deduplicated
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: an evicted hwmon path warns when it recurs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: failure-map cap still applies when hwmon listing cannot prune stale children
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json: only system stats and the seven identity gates read the restart sentinel
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: selects the outer error source from the caught error marker, not stale flow state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: drops command ACK work while restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: exposes the boolean restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: clears the password and returns the second/error output with status 503
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: uses the approved fs global
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: publishes into the daemon request directory
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: publishes the exact three-field request contract
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: requires the Node-RED message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: bounds filesystem error detail returned to the operator
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: measures the UTF-8 message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: bounds the filename key before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: encodes msg._msgid into a path-safe deterministic key
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: keys the deterministic final path by the safe message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: uses a unique temporary suffix for retry-safe publication
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: publishes atomically through a unique temporary file
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: reports the scheduled restart
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: has separate success and error outputs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: failure reaches only the HTTP response
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: keeps libs empty
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: does not use /etc/init.d/node-red
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: creates the private request directory with mode 0700
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: writes one temporary file and renames it once
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: hostile msg._msgid is deterministically encoded inside the request directory
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: unique temporary path is renamed to the deterministic final path
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: temporary request uses mode 0600 and exclusive creation
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: final JSON has exactly reason, delaySeconds, and requestedAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: successful publication uses only the success output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: distinct msg._msgid values produce distinct final paths
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: retries keep a deterministic final path and use a fresh temporary suffix
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: missing msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: empty msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: missing fs fails through only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: mkdir failure stops before publication and uses only the bounded error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: ENOSPC fails closed, cleans up, and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: rename failure cleans up and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: very long msg._msgid fails before filename construction
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: uses the approved fs global
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: publishes into the daemon request directory
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: publishes the exact three-field request contract
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: requires the Node-RED message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: bounds filesystem error detail returned to the operator
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: measures the UTF-8 message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: bounds the filename key before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: encodes msg._msgid into a path-safe deterministic key
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: keys the deterministic final path by the safe message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: uses a unique temporary suffix for retry-safe publication
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: publishes atomically through a unique temporary file
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: reports the scheduled restart
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: has separate success and error outputs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: failure reaches only the HTTP response
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: keeps libs empty
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: does not use /etc/init.d/node-red
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: creates the private request directory with mode 0700
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: writes one temporary file and renames it once
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: hostile msg._msgid is deterministically encoded inside the request directory
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: unique temporary path is renamed to the deterministic final path
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: temporary request uses mode 0600 and exclusive creation
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: final JSON has exactly reason, delaySeconds, and requestedAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: successful publication uses only the success output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: distinct msg._msgid values produce distinct final paths
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: retries keep a deterministic final path and use a fresh temporary suffix
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: missing msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: empty msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: missing fs fails through only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: mkdir failure stops before publication and uses only the bounded error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: ENOSPC fails closed, cleans up, and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: rename failure cleans up and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: very long msg._msgid fails before filename construction
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-validate: protected function is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-init-fn: protected function is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json: flow document is an array
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: preserves its absent libs property
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not use require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: restartState reads are allowlisted to reason and restartAt
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field phase
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field restartAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field restartNotBeforeUptime
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field targetDeviceEui
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field target_device_eui
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field requestedAt
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field confidence
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field version
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: missing restart sentinel returns restartPending null
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: valid restart sentinel exposes only restartAt and reason
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: unauthenticated stats omit private and internal sentinel fields
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: missing sentinel reason uses the reviewed public fallback
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: no-deadline healing state exposes a blocked public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: an expired pending deadline remains visible until daemon cleanup
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: invalid JSON exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: array shape exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: non-string deadline exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: unreadable restart sentinel exposes an unreadable public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: hwmon directory failure keeps the fan fallback and warns with context
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: fan probe failures retain the fallback and warn for each probed path
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: expected ENOENT and ENOTDIR fan absence stays quiet with the existing fallback
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: a persistent unexpected fan failure warns once per path and signature
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: a changed unexpected fan failure warns again
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: successful fan-probe recovery resets warning deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: remembered fan failure signatures are bounded
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: successful hwmon listing prunes disappeared children and keeps current deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: disappeared hwmon path warns when it recurs while the current path remains deduplicated
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: hwmon hotplug churn keeps the complete failure map at or below 32 entries
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: successful hwmon listing prunes disappeared children and retains identical current deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: a pruned hwmon path warns when it recurs while the retained path stays deduplicated
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: an evicted hwmon path warns when it recurs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: failure-map cap still applies when hwmon listing cannot prune stale children
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json: only system stats and the seven identity gates read the restart sentinel
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: selects the outer error source from the caught error marker, not stale flow state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: drops command ACK work while restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: exposes the boolean restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: clears the password and returns the second/error output with status 503
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: uses the approved fs global
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: publishes into the daemon request directory
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: publishes the exact three-field request contract
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: requires the Node-RED message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: bounds filesystem error detail returned to the operator
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: measures the UTF-8 message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: bounds the filename key before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: encodes msg._msgid into a path-safe deterministic key
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: keys the deterministic final path by the safe message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: uses a unique temporary suffix for retry-safe publication
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: publishes atomically through a unique temporary file
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: reports the scheduled restart
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: has separate success and error outputs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: failure reaches only the HTTP response
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: keeps libs empty
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: does not use /etc/init.d/node-red
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: creates the private request directory with mode 0700
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: writes one temporary file and renames it once
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: hostile msg._msgid is deterministically encoded inside the request directory
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: unique temporary path is renamed to the deterministic final path
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: temporary request uses mode 0600 and exclusive creation
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: final JSON has exactly reason, delaySeconds, and requestedAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: successful publication uses only the success output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: distinct msg._msgid values produce distinct final paths
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: retries keep a deterministic final path and use a fresh temporary suffix
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: missing msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: empty msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: missing fs fails through only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: mkdir failure stops before publication and uses only the bounded error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: ENOSPC fails closed, cleans up, and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: rename failure cleans up and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: very long msg._msgid fails before filename construction
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: uses the approved fs global
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: publishes into the daemon request directory
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: publishes the exact three-field request contract
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: requires the Node-RED message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: bounds filesystem error detail returned to the operator
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: measures the UTF-8 message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: bounds the filename key before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: encodes msg._msgid into a path-safe deterministic key
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: keys the deterministic final path by the safe message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: uses a unique temporary suffix for retry-safe publication
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: publishes atomically through a unique temporary file
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: reports the scheduled restart
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: has separate success and error outputs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: failure reaches only the HTTP response
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: keeps libs empty
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: does not use /etc/init.d/node-red
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: creates the private request directory with mode 0700
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: writes one temporary file and renames it once
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: hostile msg._msgid is deterministically encoded inside the request directory
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: unique temporary path is renamed to the deterministic final path
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: temporary request uses mode 0600 and exclusive creation
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: final JSON has exactly reason, delaySeconds, and requestedAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: successful publication uses only the success output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: distinct msg._msgid values produce distinct final paths
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: retries keep a deterministic final path and use a fresh temporary suffix
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: missing msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: empty msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: missing fs fails through only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: mkdir failure stops before publication and uses only the bounded error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: ENOSPC fails closed, cleans up, and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: rename failure cleans up and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: very long msg._msgid fails before filename construction
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-validate: protected function is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-init-fn: protected function is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json: byte-identical flow mirror
OK silent-catch baseline records 164 for both maintained profiles
OK silent-catch baseline: records the PR #149 compensation cleanup
OK silent-catch baseline: records the scoped-access auth cleanup
OK silent-catch baseline: records the scoped-access shared-read cleanup
OK size allowance sync-bootstrap-build: owned entry present
OK size allowance sync-bootstrap-build: declares Task 4 growth
OK size allowance sync-outbox-build: owned entry present
OK size allowance sync-outbox-build: declares Task 4 growth
OK size allowance sync-pending-build: owned entry present
OK size allowance sync-pending-build: declares Task 4 growth
OK size allowance sync-force-build: owned entry present
OK size allowance sync-force-build: declares Task 4 growth
OK size allowance command-ack-build-batch: owned entry present
OK size allowance command-ack-build-batch: declares Task 4 growth
OK size allowance sync-state-build: owned entry present
OK size allowance sync-state-build: declares Task 4 growth
OK size allowance al-link-build-req: owned entry present
OK size allowance al-link-build-req: declares Task 4 growth
OK size allowance al-link-restart-node-red: owned entry present
OK size allowance al-link-restart-node-red: declares Task 4 growth
OK size allowance al-unlink-restart-node-red: owned entry present
OK size allowance al-unlink-restart-node-red: declares Task 4 growth
OK size allowance sys-stats-fn: owned entry present
OK size allowance sys-stats-fn: declares Task 5 growth
OK scripts/test-identityd-service-lifecycle.sh: --- Quiesce gateway identity supervisor before schema migration ---
OK
--- Restore gateway identity supervisor after interrupted deploy ---
OK
--- Quiesce gateway identity supervisor before schema migration ---
OK
--- Restore gateway identity supervisor after interrupted deploy ---
OK: identityd restored to stopped state
--- Quiesce gateway identity supervisor before schema migration ---
OK
--- Quiesce gateway identity supervisor before schema migration ---
--- Quiesce gateway identity supervisor before schema migration ---
OK
--- Restore gateway identity supervisor after interrupted deploy ---
OK
--- Quiesce gateway identity supervisor before schema migration ---
OK
--- Restore gateway identity supervisor after interrupted deploy ---
PASS: identityd deploy lifecycle and readiness
Live gateway identity verification passed.

$ node scripts/verify-sync-flow.js
Communication contract verification passed
OK conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
OK database/farming.db
OK web/react-gui/farming.db
DB schema consistency verification passed
OK sync history schema fresh seed
OK durable history schema fresh seed
OK durable history schema ordered migration
OK sync history schema base seed + history migration
OK sync history schema
OK sync history worker helper
device-data-null-and-real.hashInput={"hashVersion":1,"tableName":"device_data","historyKey":"DEVICE_DATA|0016C001F11715E2|123","columns":[["id","INTEGER","123"],["deveui","TEXT","A84041CAFECAFE01"],["recorded_at","TIMESTAMP","2026-06-28T10:00:00.000Z"],["swt_1","REAL","3ff0000000000000"],["swt_2","REAL",null],["dendro_valid","BOOLEAN",true]]}
json-sorted-keys.hashInput={"hashVersion":1,"tableName":"zone_daily_recommendations","historyKey":"ZONE_RECOMMENDATION|zone-uuid-1|2026-06-28","columns":[["zone_uuid","TEXT","zone-uuid-1"],["date","TEXT","2026-06-28"],["recommendation_json","JSON","{\"a\":1,\"b\":null}"]]}
device-data-negative-zero-and-false.hashInput={"hashVersion":1,"tableName":"device_data","historyKey":"DEVICE_DATA|0016C001F11715E2|124","columns":[["id","INTEGER","124"],["deveui","TEXT","A84041CAFECAFE01"],["recorded_at","TIMESTAMP","2026-06-28T10:05:00.000Z"],["swt_1","REAL","0000000000000000"],["swt_2","REAL","0000000000000000"],["dendro_valid","BOOLEAN",false]]}
device-data-large-integer-string.hashInput={"hashVersion":1,"tableName":"device_data","historyKey":"DEVICE_DATA|0016C001F11715E2|9007199254740993","columns":[["id","INTEGER","9007199254740993"],["deveui","TEXT","A84041CAFECAFE01"],["recorded_at","TIMESTAMP","2026-06-28T10:10:00.000Z"],["swt_1","REAL",null],["swt_2","REAL",null],["dendro_valid","BOOLEAN",true]]}
chameleon-reading-booleans-and-counters.hashInput={"hashVersion":1,"tableName":"chameleon_readings","historyKey":"CHAMELEON_READING|0016C001F11715E2|77","columns":[["id","INTEGER","77"],["deveui","TEXT","A84041CAFECAFE01"],["recorded_at","TIMESTAMP","2026-06-28T11:00:00.000Z"],["payload_version","INTEGER","3"],["status_flags","INTEGER","5"],["data_invalid","BOOLEAN",false],["comp_pending","BOOLEAN",true],["f_port","INTEGER","2"],["f_cnt","INTEGER","42"],["calibration_status","TEXT","calibrated"]]}
dendrometer-reading-real-and-flags.hashInput={"hashVersion":1,"tableName":"dendrometer_readings","historyKey":"DENDRO_READING|0016C001F11715E2|88","columns":[["id","INTEGER","88"],["deveui","TEXT","A84041CAFECAFE01"],["recorded_at","TIMESTAMP","2026-06-28T11:05:00.000Z"],["position_um","REAL","40938a0000000000"],["is_valid","BOOLEAN",true],["is_outlier","BOOLEAN",false],["dendro_saturated","BOOLEAN",true]]}
dendrometer-daily-null-real.hashInput={"hashVersion":1,"tableName":"dendrometer_daily","historyKey":"DENDRO_DAILY|0016C001F11715E2|2026-06-28","columns":[["deveui","TEXT","A84041CAFECAFE01"],["date","TEXT","2026-06-28"],["mds_um","REAL",null],["twd_um","REAL","c028800000000000"],["stress_level","TEXT","moderate"],["computed_at","TIMESTAMP","2026-06-29T00:00:00.000Z"]]}
zone-environment-rain-and-flow.hashInput={"hashVersion":1,"tableName":"zone_daily_environment","historyKey":"ZONE_ENVIRONMENT|zone-uuid-1|2026-06-28","columns":[["zone_uuid","TEXT","zone-uuid-1"],["date","TEXT","2026-06-28"],["rainfall_mm","REAL","400e000000000000"],["flow_liters","REAL","405e000000000000"],["rain_source","TEXT","aquascope_lorain"],["computed_at","TIMESTAMP","2026-06-29T00:05:00.000Z"]]}
irrigation-event-json-payload.hashInput={"hashVersion":1,"tableName":"irrigation_events","historyKey":"IRRIGATION_EVENT|irrig-0016C001F11715E2-000000000000123","columns":[["event_uuid","TEXT","irrig-0016C001F11715E2-000000000000123"],["created_at","TIMESTAMP","2026-06-28T11:10:00.000Z"],["action","TEXT","OPEN"],["reason","TEXT","schedule"],["aggregate_kpa","REAL","4032800000000000"],["threshold_kpa","REAL","4034000000000000"],["duration_minutes","INTEGER","15"],["valve_deveui","TEXT","A84041VALVE0001"],["payload_json","JSON","{\"a\":[3,1],\"z\":2}"]]}
fixtureSetSha256=cbd70d0c2791f3a7bd7fcf17998914bcc55f97d4226411ab853e041a3d388828
OK GET /api/history/zones/:zoneId/cards uses osi-history-helper via "History API Router"
OK GET /api/history/zones/:zoneId/export.csv uses osi-history-helper via "History API Router"
OK GET /api/history/export.csv uses osi-history-helper via "History API Router"
OK GET /api/history/zones/:zoneId/cards/:cardId/data uses osi-history-helper via "History API Router"
OK GET /api/history/zones/:zoneId/cards/:cardId/advanced uses osi-history-helper via "History API Router"
OK GET /api/history/gateways/:gatewayEui/cards uses osi-history-helper via "History API Router"
OK GET /api/history/gateways/:gatewayEui/cards/:cardId/data uses osi-history-helper via "History API Router"
OK GET /api/history/gateways/:gatewayEui/cards/:cardId/advanced uses osi-history-helper via "History API Router"
OK GET /api/history/workspaces uses osi-history-helper via "History API Router"
OK POST /api/history/workspaces uses osi-history-helper via "History API Router"
OK PUT /api/history/workspaces/:id uses osi-history-helper via "History API Router"
OK DELETE /api/history/workspaces/:id uses osi-history-helper via "History API Router"
OK PUT /api/history/zones/:zoneId/cards/:cardId/preferences uses osi-history-helper via "History API Router"
OK POST /api/history/zones/:zoneId/cards/:cardId/opened uses osi-history-helper via "History API Router"
OK PUT /api/history/gateways/:gatewayEui/cards/:cardId/preferences uses osi-history-helper via "History API Router"
OK POST /api/history/gateways/:gatewayEui/cards/:cardId/opened uses osi-history-helper via "History API Router"
OK POST /api/history/rollups/run uses osi-history-helper via "History Rollup Tick"
OK GET /api/system/features uses osi-history-helper via "History API Router"
OK GET /api/analysis/channels uses osi-history-helper via "Analysis API Router"
OK POST /api/analysis/series uses osi-history-helper via "Analysis API Router"
OK GET /api/analysis/views uses osi-history-helper via "Analysis API Router"
OK POST /api/analysis/views uses osi-history-helper via "Analysis API Router"
OK DELETE /api/analysis/views/:id uses osi-history-helper via "Analysis API Router"
verify-history-api-contract: OK
TAP version 13
# Subtest: analysis contract accepts the maintained scoped router
ok 1 - analysis contract accepts the maintained scoped router
  ---
  duration_ms: 11.539641
  type: 'test'
  ...
# Subtest: analysis contract rejects removal of zone-scope propagation
ok 2 - analysis contract rejects removal of zone-scope propagation
  ---
  duration_ms: 7.537185
  type: 'test'
  ...
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 74.25251
verify-scoped-access: OK (ratchet only; behavioral matrix is the correctness gate)
TAP version 13
# Subtest: prepare emits the exact pinned protocol command without mutation authority
ok 1 - prepare emits the exact pinned protocol command without mutation authority
  ---
  duration_ms: 8.600517
  type: 'test'
  ...
# Subtest: prepare rejects the live farming database path
ok 2 - prepare rejects the live farming database path
  ---
  duration_ms: 4.029763
  type: 'test'
  ...
# Subtest: prepare rejects a symlinked downloaded database
ok 3 - prepare rejects a symlinked downloaded database
  ---
  duration_ms: 4.057002
  type: 'test'
  ...
# Subtest: prepare rejects wrong installation, gateway, and database hash
ok 4 - prepare rejects wrong installation, gateway, and database hash
  ---
  duration_ms: 11.767673
  type: 'test'
  ...
# Subtest: prepare rejects an incomplete future protocol invocation
ok 5 - prepare rejects an incomplete future protocol invocation
  ---
  duration_ms: 5.980776
  type: 'test'
  ...
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 94.814368
  ok Command Type Registry node present with required entries
OK shared STREGA ingest node renamed to Local Device Uplinks
OK shared STREGA ingest topic remains application/+/device/+/event/up
OK chirpstack-bootstrap.js preserves the shared STREGA ingest topic
OK no direct sqlite database opens remain in flows.json
OK osi-db-helper nodes consistently use the osiDb alias
OK osi-lib binding audit adversarial fixtures pass
OK journal replay generators reject shape drift
OK journal v2 flow migration roundtrip and isolation guards pass
OK journal v2 startup media configuration guards pass
OK journal v2 durable worker behavior passes
OK mock osiDb run returns a thenable without a callback
OK route /api/account-link
OK route /api/account-link/status
OK route /api/sync/state
OK route /api/sync/force
OK route /api/valve/:deveui/cancel
OK route /api/devices/:deveui/lsn50/mode
OK route /api/devices/:deveui/lsn50/interval
OK route /api/devices/:deveui/lsn50/interrupt-mode
OK route /api/devices/:deveui/lsn50/5v-warmup
OK route /api/devices/:deveui/kiwi/interval
OK route /api/devices/:deveui/kiwi/temperature-humidity/enable
OK route /api/devices/:deveui/soil-moisture-depths
OK route /api/devices/:deveui/strega/interval
OK route /api/devices/:deveui/strega/model
OK route /api/devices/:deveui/strega/timed-action
OK route /api/devices/:deveui/strega/magnet
OK route /api/devices/:deveui/strega/partial-opening
OK route /api/devices/:deveui/strega/flushing
OK route /api/devices/:deveui/chameleon
OK route /api/devices/:deveui/chameleon/refresh-calibration
OK route /api/devices/:deveui/chameleon/depth
OK route /api/devices/:deveui/dendro-config
OK route /api/devices/:deveui/dendro-baseline/reset
OK route /api/devices/:deveui/zone-assignments
OK route /api/gateway/location
OK route /api/gateways/:gatewayEui/location
OK route /api/irrigation-zones/:zone_id/environment-summary
OK route /api/irrigation-zones/:id/calibration
OK route /api/irrigation/recent-actuations
OK compile Validate & decode token
OK compile Build server auth request
OK compile Handle server auth response
OK compile Finalize linked account state
OK compile Persist MQTT Broker Config
OK compile Rollback MQTT Broker Config
OK compile Schedule Link Restart
OK compile Clear link flow state
OK compile Clear MQTT Broker Config
OK compile Decode token & build UPDATE
OK compile Clear linked account state
OK compile Restore MQTT Broker Config
OK compile Schedule Unlink Restart
OK compile Set Download Headers
OK compile Daily Dendrometer Analytics
OK compile Sync Init Schema + Triggers
OK compile Build Cloud Bootstrap
OK compile Mark Bootstrap Synced
OK compile Build Edge Event Batch
OK compile Mark Synced Events Delivered
OK compile Build Pending Command Pull
OK compile Deduplicate Pending Command
OK compile Queue REST Command ACK
OK compile Build Command ACK Batch
OK compile Mark Command ACKs Delivered
OK compile Prune Sync Outbox
OK compile Build Sync State
OK compile Replay Pending Commands
OK compile Apply Work Request Status
OK compile Improvement Requests API Router
OK compile support-delivery-worker
OK compile Build Sync Token Refresh
OK compile Store Refreshed Sync Token
OK compile Run Force Sync
OK compile Auth + Parse LSN50 Mode
OK compile Auth + Parse LSN50 Interval
OK compile Authorize + Fanout LSN50 Mode
OK compile Authorize + Fanout LSN50 Interval
OK compile Format LSN50 Mode Response
OK compile Format LSN50 Interval Response
OK compile Auth + Parse LSN50 Interrupt
OK compile Auth + Parse LSN50 5V Warmup
OK compile Authorize + Fanout LSN50 Advanced
OK compile Format LSN50 Advanced Response
OK compile Auth + Parse Kiwi Interval
OK compile Authorize + Fanout Kiwi Interval
OK compile Format Kiwi Interval Response
OK compile Auth + Parse Kiwi Temp/Humidity
OK compile Authorize + Fanout Kiwi Temp/Humidity
OK compile Format Kiwi Temp/Humidity Response
OK compile Auth + Save Soil Moisture Depths
OK compile Auth + Parse STREGA Interval
OK compile Authorize + Fanout STREGA Interval
OK compile Format STREGA Interval Response
OK compile Auth + Parse STREGA Model
OK compile Auth + Parse STREGA Timed Action
OK compile Auth + Parse STREGA Magnet
OK compile Auth + Parse STREGA Partial Opening
OK compile Auth + Parse STREGA Flushing
OK compile Authorize + Fanout STREGA Advanced
OK compile Format STREGA Advanced Response
OK compile Cancel STREGA Actuation
OK compile Auth + Set Chameleon Enabled
OK compile Auth + Parse Dendro Config
OK compile Format Dendro Config Response
OK compile Return Device API HTTP 500
OK compile CS Register (cloud cmd)
OK compile Build Special Command ACK
OK compile Build LSN50 mode downlink
OK compile Process STREGA
OK compile Persist STREGA Uplink
OK compile Process S2120
OK compile Aggregate Zone Rain
OK compile Process LoRain
OK compile Build LoRain SQL INSERT
OK compile Aggregate LoRain Zone Rain
OK compile Insert Chameleon Reading
OK compile Get Zone Assignments
OK compile Auth + Set Zone Assignments
OK compile Auth + Query Gateway Location
OK compile Format Gateway Location Response
OK compile Get Zone Environment Summary
OK compile Save Zone Irrigation Calibration
OK compile 9b3afb405207302e (Build SQL INSERT)
OK compile 5f0d2b7e9b9b1b3a (Decide + build actuator cmd + build DB logs)
OK every function node that uses a guarded module has it bound
OK no function node bare-requires a non-builtin module
OK History Rollup Tick calls the helper rollup job
OK History API Router builds the zone CSV export via the helper
OK bootstrap repeat 21600
OK refresh repeat 3600
OK bootstrap includes sensorData
OK bootstrap includes dendroReadings
OK bootstrap includes chameleonReadings
OK bootstrap includes dendroDaily
OK bootstrap includes zoneRecommendations
OK bootstrap includes zoneEnvironments
OK bootstrap includes gatewayLocations
OK bootstrap includes irrigationEvents
OK bootstrap includes irrigationCalibrations
OK Validate & decode token uses decoded local auth
OK Validate & decode token supports a private-target maintenance override
OK Validate & decode token accepts the runtime private-target override flag
OK Validate & decode token accepts the legacy runtime private-target override flag
OK Validate & decode token accepts the persisted UCI private-target override flag
OK Validate & decode token uses the canonical runtime gateway identity
OK Validate & decode token reads runtime gateway identity confidence
OK Validate & decode token stores resolved gateway identity metadata in link flow state
OK Validate & decode token stores resolved gateway identity confidence in link flow state
OK Validate & decode token blocks account linking while gateway identity remains provisional
OK Validate & decode token removed ad hoc ChirpStack log gateway probing
OK Validate & decode token removed ad hoc concentratord gateway probing
OK Validate & decode token removed ad hoc UCI gateway probing
OK Validate & decode token removed ad hoc MAC-derived gateway probing
OK Handle server auth response maps remote auth failures away from 401
OK Handle server auth response requires sync token on successful link
OK Handle server auth response requires offline verifier on successful link
OK Handle server auth response requires MQTT password on successful link
OK Handle server auth response requires MQTT broker URL on successful link
OK Handle server auth response accepts MQTT credentials from local-sync
OK Handle server auth response stores MQTT password from local-sync
OK Handle server auth response stores MQTT broker URL from local-sync
OK Handle server auth response uses a runtime-compatible MQTT URL parser
OK Handle server auth response falls back to regex host extraction when URL is unavailable
OK Handle server auth response removed a direct MQTT broker URL constructor check that can fail on older runtimes
OK Handle server auth response removed direct linked-account DB mutation
OK Build server auth request sends local device claims in the authenticated local-sync request
OK Build server auth request loads local device claims before cloud linking
OK Build server auth request fails locally when no canonical gateway EUI is available
OK Build server auth request fails linking while gateway identity remains provisional
OK Build server auth request sends the local user UUID for linked-auth targeting
OK Build server auth request sends the local username snapshot for linked-auth targeting
OK Build server auth request sends the edge build version during local-sync
OK Build server auth request advertises linked-auth sync capabilities during local-sync
OK Build server auth request advertises the linked-auth sync capability
OK Build server auth request advertises the force-edge-sync capability
OK Build server auth request advertises the versioned zone desired-state capability
OK Build server auth request advertises the irrigation-config desired-state capability
OK Build server auth request advertises the protected device desired-state capability
OK Build server auth request advertises the weather-station zone desired-state capability
OK Handle server auth response accepts claimed device results directly from local-sync
OK Handle server auth response requires and stores the offline verifier version from local-sync
OK Decode token & build query loads linked-auth verifier metadata for account-link status
OK Format status response reports linked-auth package validity in account-link status
OK Format status response reports linked-auth repair requirements in account-link status
OK Format status response downgrades stale linked-auth state in account-link status
OK Build Sync State returns the last mirrored sync event timestamp
OK Build Sync State returns a DB health block in sync state
OK Build Sync State returns SQLite journal mode in sync state
OK Build Sync State returns quick-check status in sync state
OK Build Sync State returns helper DB errors in sync state
OK Build Sync State keeps DB close handling safe when auth fails before DB open
OK Build Sync State preserves auth error status codes in sync state responses
OK Build Sync State returns a bounded 401 response for unauthenticated sync state requests
OK Build Sync State reports linked-auth package validity in sync state
OK Build Sync State reports linked-auth repair requirements in sync state
OK Build Sync State excludes terminal rejected outbox events from pending outbox count
OK Build Sync State reports gateway migration candidate sources in sync state
OK Build Sync State reports rejected gateway migration candidates in sync state
OK Finalize linked account state commits linked-account DB state only after MQTT persistence
OK Finalize linked account state finalizes linked auth mode explicitly
OK Finalize linked account state persists the synced offline verifier version locally
OK Finalize linked account state marks linked auth as up to date after local-sync finalization
OK Finalize linked account state can stop before reporting link success
OK Finalize linked account state persists sync_link_state on successful account link
OK Finalize linked account state linked account state normalizes gateway EUI
OK Finalize linked account state sets account_linked flow flag on successful account link
OK Clear linked account state marks sync_link_state unlinked during unlink
OK Clear linked account state clears sync_link_state linked flag during unlink
OK Clear linked account state unlink clears sync_link_state server URL
OK Clear linked account state unlink clears sync_link_state gateway identity
OK Clear linked account state clears account_linked flow flag during unlink
OK Set Download Headers keeps database download disabled
OK Lookup Auth User prefers local username matches
OK Process Result rejects ambiguous linked logins
OK Process Result uses a persisted local auth secret
OK Process Result uses the linked gateway identity captured at account-link time
OK Process Result falls back to the gateway encoded into the sync token
OK Process Result uses canonical runtime gateway identity only as a last resort
OK Process Result removed ad hoc ChirpStack log gateway probing during linked login
OK Process Result removed ad hoc concentratord gateway probing during linked login
OK Process Result removed ad hoc UCI gateway probing during linked login
OK Process Result removed ad hoc MAC-derived gateway probing during linked login
OK Route Command normalizes valve commands from either deviceEui or devEui
OK Route Command routes normalized valve commands to the STREGA actuator path
OK Route Command routes linked-auth sync commands through the special command handler
OK Route Command routes force-edge-sync commands through the special command handler
OK CS Register Device uses shared ChirpStack provisioning helper
OK CS Register Device provisions devices through gRPC helper
OK CS Register Device removed legacy ChirpStack REST device endpoint
OK CS Register (cloud cmd) uses shared ChirpStack provisioning helper
OK CS Register (cloud cmd) provisions cloud-triggered devices through gRPC helper
OK CS Register (cloud cmd) removed legacy ChirpStack REST device endpoint
OK CS Register (cloud cmd) handles linked-auth sync commands
OK CS Register (cloud cmd) handles force-edge-sync commands
OK CS Register (cloud cmd) targets linked-auth sync by local user UUID first
OK CS Register (cloud cmd) acknowledges stale linked-auth versions without downgrading local auth
OK CS Register (cloud cmd) treats duplicate linked-auth commands as idempotent
OK CS Register (cloud cmd) stores the linked-auth verifier version locally
OK CS Register (cloud cmd) tracks linked-auth apply status locally
OK CS Register (cloud cmd) reports queued force-sync requests in the special-command ACK state
OK CS Register (cloud cmd) preserves cloud SenseCAP registration mapping
OK CS Register (cloud cmd) maps cloud SenseCAP registration to the SenseCAP ChirpStack profile
OK Build Special Command ACK formats special command acknowledgments from structured state
OK Build Special Command ACK includes linked-auth apply outcomes in the ACK payload
OK Build Special Command ACK includes force-sync queue state in the ACK payload
OK Sync Init Schema + Triggers emits dendro daily outbox rows from dendrometer_daily
OK Sync Init Schema + Triggers updates dendro daily outbox rows from dendrometer_daily
OK sync-init-fn guards + fail-closes the devices rebuild (transaction, live-CHECK guard, FK fence in finally)
OK Sync Init Schema + Triggers emits linked cloud usernames in device outbox events
OK Sync Init Schema + Triggers adds the STREGA model metadata column
OK Sync Init Schema + Triggers mirrors STREGA current state changes into device outbox events
OK Sync Init Schema + Triggers mirrors STREGA target state changes into device outbox events
OK Sync Init Schema + Triggers mirrors STREGA model changes into device outbox events
OK Sync Init Schema + Triggers creates the gateway GPS mirror table
OK Sync Init Schema + Triggers creates the gateway GPS insert trigger
OK Sync Init Schema + Triggers emits gateway GPS sync events
OK Sync Init Schema + Triggers adds shared zone area config
OK Sync Init Schema + Triggers adds shared irrigation efficiency config
OK Sync Init Schema + Triggers adds the synced prediction-card flag to zones
OK Sync Init Schema + Triggers adds the linked-auth verifier version column to users
OK Sync Init Schema + Triggers adds the linked-auth last-sync timestamp column to users
OK Sync Init Schema + Triggers adds the linked-auth status column to users
OK Sync Init Schema + Triggers adds the linked-auth error column to users
OK Sync Init Schema + Triggers backfills linked server users with an up-to-date auth status
OK Sync Init Schema + Triggers marks invalid linked-auth packages for repair during sync init
OK Sync Init Schema + Triggers uses a canonical gateway-or-NULL SQL fallback during sync init
OK Sync Init Schema + Triggers adds normalized rain telemetry storage
OK Sync Init Schema + Triggers adds normalized flow telemetry storage
OK Sync Init Schema + Triggers adds STREGA battery percentage storage
OK Sync Init Schema + Triggers mirrors zone area changes into zone sync events
OK Sync Init Schema + Triggers mirrors irrigation efficiency changes into zone sync events
OK Sync Init Schema + Triggers mirrors prediction-card changes into zone sync events
OK Sync Init Schema + Triggers queues outbox events when the prediction-card flag changes
OK Sync Init Schema + Triggers creates sync link state table at runtime
OK Sync Init Schema + Triggers backfills stable irrigation event UUIDs at runtime
OK Sync Init Schema + Triggers creates stable irrigation event UUID trigger at runtime
OK seed-blank.sql irrigation events have stable sync identity
OK seed-blank.sql fresh DBs create stable irrigation event UUIDs
OK seed-blank.sql defines trg_sync_zones_outbox_au
OK seed-blank.sql trg_sync_zones_outbox_au cloud link gate
OK Sync Init Schema + Triggers trg_sync_zones_outbox_au cloud link gate
OK seed-blank.sql defines trg_sync_devices_outbox_au
OK seed-blank.sql trg_sync_devices_outbox_au cloud link gate
OK Sync Init Schema + Triggers trg_sync_devices_outbox_au cloud link gate
OK seed-blank.sql defines trg_sync_schedules_outbox_au
OK seed-blank.sql trg_sync_schedules_outbox_au cloud link gate
OK Sync Init Schema + Triggers trg_sync_schedules_outbox_au cloud link gate
OK seed-blank.sql defines trg_gateway_locations_outbox_ai
OK seed-blank.sql trg_gateway_locations_outbox_ai cloud link gate
OK Sync Init Schema + Triggers trg_gateway_locations_outbox_ai cloud link gate
OK seed-blank.sql defines trg_gateway_locations_outbox_au
OK seed-blank.sql trg_gateway_locations_outbox_au cloud link gate
OK Sync Init Schema + Triggers trg_gateway_locations_outbox_au cloud link gate
OK seed-blank.sql link-gates sync triggers
OK Sync Init Schema + Triggers creates trg_dp_device_data_outbox_ai at runtime
OK seed-blank.sql defines trg_dp_device_data_outbox_ai
OK seed-blank.sql trg_dp_device_data_outbox_ai cloud link gate
OK Sync Init Schema + Triggers trg_dp_device_data_outbox_ai cloud link gate
OK Sync Init Schema + Triggers creates trg_dp_chameleon_readings_outbox_ai at runtime
OK seed-blank.sql defines trg_dp_chameleon_readings_outbox_ai
OK seed-blank.sql trg_dp_chameleon_readings_outbox_ai cloud link gate
OK Sync Init Schema + Triggers trg_dp_chameleon_readings_outbox_ai cloud link gate
OK Sync Init Schema + Triggers creates trg_dp_dendro_readings_outbox_ai at runtime
OK seed-blank.sql defines trg_dp_dendro_readings_outbox_ai
OK seed-blank.sql trg_dp_dendro_readings_outbox_ai cloud link gate
OK Sync Init Schema + Triggers trg_dp_dendro_readings_outbox_ai cloud link gate
OK Sync Init Schema + Triggers creates trg_dp_dendro_daily_outbox_ai at runtime
OK seed-blank.sql defines trg_dp_dendro_daily_outbox_ai
OK seed-blank.sql trg_dp_dendro_daily_outbox_ai cloud link gate
OK Sync Init Schema + Triggers trg_dp_dendro_daily_outbox_ai cloud link gate
OK Sync Init Schema + Triggers creates trg_dp_dendro_daily_outbox_au at runtime
OK seed-blank.sql defines trg_dp_dendro_daily_outbox_au
OK seed-blank.sql trg_dp_dendro_daily_outbox_au cloud link gate
OK Sync Init Schema + Triggers trg_dp_dendro_daily_outbox_au cloud link gate
OK Sync Init Schema + Triggers creates trg_dp_irrigation_events_outbox_ai at runtime
OK seed-blank.sql defines trg_dp_irrigation_events_outbox_ai
OK seed-blank.sql trg_dp_irrigation_events_outbox_ai cloud link gate
OK Sync Init Schema + Triggers trg_dp_irrigation_events_outbox_ai cloud link gate
OK Sync Init Schema + Triggers creates trg_dp_irrigation_events_outbox_au_event_uuid at runtime
OK seed-blank.sql defines trg_dp_irrigation_events_outbox_au_event_uuid
OK seed-blank.sql trg_dp_irrigation_events_outbox_au_event_uuid cloud link gate
OK Sync Init Schema + Triggers trg_dp_irrigation_events_outbox_au_event_uuid cloud link gate
OK Sync Init Schema + Triggers creates trg_dp_zone_env_outbox_ai at runtime
OK seed-blank.sql defines trg_dp_zone_env_outbox_ai
OK seed-blank.sql trg_dp_zone_env_outbox_ai cloud link gate
OK Sync Init Schema + Triggers trg_dp_zone_env_outbox_ai cloud link gate
OK Sync Init Schema + Triggers creates trg_dp_zone_env_outbox_au at runtime
OK seed-blank.sql defines trg_dp_zone_env_outbox_au
OK seed-blank.sql trg_dp_zone_env_outbox_au cloud link gate
OK Sync Init Schema + Triggers trg_dp_zone_env_outbox_au cloud link gate
OK Sync Init Schema + Triggers creates trg_dp_zone_recs_outbox_ai at runtime
OK seed-blank.sql defines trg_dp_zone_recs_outbox_ai
OK seed-blank.sql trg_dp_zone_recs_outbox_ai cloud link gate
OK Sync Init Schema + Triggers trg_dp_zone_recs_outbox_ai cloud link gate
OK Sync Init Schema + Triggers creates trg_dp_zone_recs_outbox_au at runtime
OK seed-blank.sql defines trg_dp_zone_recs_outbox_au
OK seed-blank.sql trg_dp_zone_recs_outbox_au cloud link gate
OK Sync Init Schema + Triggers trg_dp_zone_recs_outbox_au cloud link gate
OK Sync Init Schema + Triggers creates trg_sync_device_data_dirty_au at runtime
OK seed-blank.sql defines trg_sync_device_data_dirty_au
OK Sync Init Schema + Triggers creates trg_sync_chameleon_readings_dirty_au at runtime
OK seed-blank.sql defines trg_sync_chameleon_readings_dirty_au
OK Sync Init Schema + Triggers creates trg_sync_dendro_readings_dirty_au at runtime
OK seed-blank.sql defines trg_sync_dendro_readings_dirty_au
OK Sync Init Schema + Triggers creates trg_sync_zone_env_dirty_ai at runtime
OK seed-blank.sql defines trg_sync_zone_env_dirty_ai
OK Sync Init Schema + Triggers creates trg_sync_zone_env_dirty_au at runtime
OK seed-blank.sql defines trg_sync_zone_env_dirty_au
OK Sync Init Schema + Triggers creates trg_sync_zone_recs_dirty_ai at runtime
OK seed-blank.sql defines trg_sync_zone_recs_dirty_ai
OK Sync Init Schema + Triggers creates trg_sync_zone_recs_dirty_au at runtime
OK seed-blank.sql defines trg_sync_zone_recs_dirty_au
OK Sync Init Schema + Triggers creates trg_sync_dendro_daily_dirty_ai at runtime
OK seed-blank.sql defines trg_sync_dendro_daily_dirty_ai
OK Sync Init Schema + Triggers creates trg_sync_dendro_daily_dirty_au at runtime
OK seed-blank.sql defines trg_sync_dendro_daily_dirty_au
OK Sync Init Schema + Triggers records history dirty keys at runtime
OK Sync Init Schema + Triggers adds shadow cursor id progress at runtime
OK Sync Init Schema + Triggers adds shadow cursor key progress at runtime
OK Sync Init Schema + Triggers adds shadow cursor error state at runtime
OK Sync Init Schema + Triggers fails closed when irrigation UUID generation lacks a gateway identity
OK Sync Init Schema + Triggers removed random irrigation UUID fallback
OK Sync Init Schema + Triggers trg_dp_irrigation_events_outbox_ai mirrors stable irrigation event UUIDs in outbox payloads
OK Sync Init Schema + Triggers ignores deleted devices when mirroring device-data zone bindings into the outbox
OK Sync Init Schema + Triggers ignores deleted devices when mirroring device-data gateway bindings into the outbox
OK Sync Init Schema + Triggers ignores deleted zones when mirroring zone environment rows into the outbox
OK Sync Init Schema + Triggers ignores deleted zones when mirroring zone environment gateway bindings into the outbox
OK Sync Init Schema + Triggers ignores deleted zones when mirroring irrigation events into the outbox
OK Sync Init Schema + Triggers ignores deleted zones when mirroring irrigation event gateway bindings into the outbox
OK Build History Batch loads history sync helper via osi-lib
OK Mark History Batch ACK marks history batches via the osi-lib-loaded helper
OK Build History Batch records helper-load failure into sync_state
OK Mark History Batch ACK records helper-load failure into sync_state
OK Build History Batch runs each history table in shadow mode first
OK Build History Batch uses the complete durable history table registry
OK Build History Batch rotates history tables fairly
OK Build History Batch uses history hash v1
OK Build History Batch posts history batches to the v1 history endpoint
OK Build History Batch history batch fails closed without sync token
OK Build History Batch history batch stops before unauthenticated post
OK Build History Batch removed malformed trailing slash normalizer in history sync builder
OK Build History Batch uses registry-owned bounded history queries
OK Build History Batch honors history cursor retry backoff before building a batch
OK Build History Batch uses shadow ACK progress while shadowing
OK Build History Batch hashes and validates rows through the shared helper
OK Build History Batch captures raw backfill high-water mark
OK Build History Batch captures natural-key backfill high-water marks
OK Build History Batch drains correction and repair dirty keys
OK POST History Batch uses the shared IPv4 cloud HTTP helper for history batches
OK Mark History Batch ACK keeps shadow cursor progress separate from durable progress
OK Mark History Batch ACK uses helper gate before applying durable history ACKs
OK Mark History Batch ACK durable ACK requires confirmed server mirror writes
OK Mark History Batch ACK history batch marker handles explicit ACK before raw trigger removal
OK Mark History Batch ACK stores shadow ACK id separately from durable ACKs
OK Mark History Batch ACK stores shadow ACK key separately from durable ACKs
OK Mark History Batch ACK reports shadow ACK errors without confirming durable mirror writes
OK Mark History Batch ACK recomputes bounded parity segments after durable ACKs
OK Mark History Batch ACK persists the zero-tombstone history contract
OK Build History Manifest builds history manifests from cached segments
OK Build History Manifest uses a real newline separator for history manifest SQL
OK Build History Manifest removed does not use a literal backslash-n separator for history manifest SQL
OK Build History Manifest posts history manifests to the v1 manifest endpoint
OK Build History Manifest history manifest fails closed without sync token
OK Build History Manifest history manifest builder skips empty manifest posts
OK Build History Manifest history manifest stops before unauthenticated post
OK Mark History Manifest ACK turns manifest mismatches into repair work
OK Mark History Manifest ACK persists requested history repairs
OK Mark History Manifest ACK removed never treats manifests as deletion instructions
OK seed-blank.sql raw correction dirty-key trigger exists before raw trigger removal
OK Sync Init Schema + Triggers removed malformed literal gateway fallback SQL in sync triggers
OK Sync Init Schema + Triggers removed double-quoted gatewaySql fallback fragments in sync init SQL
OK Build Cloud Bootstrap derives gateway migration candidates only from structural lineage
OK Build Edge Event Batch derives gateway migration candidates only from structural lineage
OK Build Pending Command Pull derives gateway migration candidates only from structural lineage
OK Run Force Sync derives gateway migration candidates only from structural lineage
OK Build Cloud Bootstrap stores gateway migration candidate source diagnostics
OK Build Edge Event Batch stores gateway migration candidate source diagnostics
OK Build Pending Command Pull stores gateway migration candidate source diagnostics
OK Run Force Sync stores gateway migration candidate source diagnostics
OK Build Cloud Bootstrap stores rejected gateway migration candidates
OK Build Edge Event Batch stores rejected gateway migration candidates
OK Build Pending Command Pull stores rejected gateway migration candidates
OK Run Force Sync stores rejected gateway migration candidates
OK Build Cloud Bootstrap removed pending outbox rows as gateway migration candidates
OK Build Edge Event Batch removed pending outbox rows as gateway migration candidates
OK Build Pending Command Pull removed pending outbox rows as gateway migration candidates
OK Run Force Sync removed pending outbox rows as gateway migration candidates
OK Build Cloud Bootstrap uses linked cloud usernames in bootstrap device snapshots
OK Build Cloud Bootstrap uses linked cloud usernames in bootstrap zone snapshots
OK Build Cloud Bootstrap includes STREGA model metadata in bootstrap device snapshots
OK Build Cloud Bootstrap includes STREGA current state in bootstrap device snapshots
OK Build Cloud Bootstrap includes STREGA target state in bootstrap device snapshots
OK Build Cloud Bootstrap includes observed LSN50 mode in bootstrap sensor data
OK Build Cloud Bootstrap includes dendrometer reference voltage in bootstrap sensor data
OK Build Cloud Bootstrap includes dendrometer ratio in bootstrap sensor data
OK Build Cloud Bootstrap includes the selected dendrometer path in bootstrap sensor data
OK Build Cloud Bootstrap includes baseline-relative stem change in bootstrap sensor data
OK Build Cloud Bootstrap includes zone area in bootstrap snapshots
OK Build Cloud Bootstrap includes zone irrigation efficiency in bootstrap snapshots
OK Build Cloud Bootstrap includes the prediction-card flag in bootstrap snapshots
OK Build Cloud Bootstrap includes normalized rain telemetry in bootstrap sensor data
OK Build Cloud Bootstrap includes normalized flow telemetry in bootstrap sensor data
OK Build Cloud Bootstrap synthesizes stable irrigation event UUIDs for bootstrap snapshots
OK Build Cloud Bootstrap includes gateway GPS state in bootstrap payloads
OK Build Cloud Bootstrap includes installation gateway history during bootstrap migration
OK Build Cloud Bootstrap includes the stable installation identity in bootstrap metadata
OK Build Cloud Bootstrap advertises the installation recovery capability in bootstrap metadata
OK Build Cloud Bootstrap includes the edge build version in bootstrap gateway metadata
OK Build Cloud Bootstrap includes sync capabilities in bootstrap gateway metadata
OK Build Cloud Bootstrap includes the versioned zone desired-state capability in bootstrap metadata
OK Build Cloud Bootstrap includes the protected device desired-state capability in bootstrap metadata
OK Build Cloud Bootstrap includes the weather-station zone desired-state capability in bootstrap metadata
OK Build Cloud Bootstrap runs local gateway migration preflight before bootstrap sync
OK Build Cloud Bootstrap pauses normal sync while a gateway migration repair bootstrap is pending
OK Build Cloud Bootstrap rewrites active zone gateway bindings during local migration
OK Build Cloud Bootstrap rewrites active device gateway bindings during local migration
OK Build Cloud Bootstrap rewrites undelivered sync outbox rows during local migration
OK Build Cloud Bootstrap surfaces rejected migration candidates in bootstrap migration state
OK Mark Bootstrap Synced recognizes successful cloud-side gateway migration responses
OK Mark Bootstrap Synced resumes normal sync after repair bootstrap succeeds
OK Build Edge Event Batch suppresses event delivery while gateway migration is paused
OK Build Edge Event Batch opts edge event delivery into sync protocol v2
OK Build Edge Event Batch excludes terminal rejected outbox events from normal delivery batches
OK Mark Synced Events Delivered marks delivered only for terminal protocol-v2 event results
OK Mark Synced Events Delivered parses per-event protocol-v2 result statuses
OK Mark Synced Events Delivered tracks rejected protocol-v2 event results separately from delivered results
OK Mark Synced Events Delivered stores rejected protocol-v2 event reasons in sync_outbox
OK Mark Synced Events Delivered marks rejected protocol-v2 event results without setting delivered_at
OK Run Force Sync tracks rejected force-sync event results separately from delivered results
OK Run Force Sync stores rejected force-sync event reasons in sync_outbox
OK Run Force Sync marks rejected force-sync event results without setting delivered_at
OK Run Force Sync excludes terminal rejected outbox events from force-sync delivery batches
OK Build Pending Command Pull suppresses pending-command polling while gateway migration is paused
OK Build Pending Command Pull opts pending-command polling into command lease protocol v2
OK Replay Pending Commands accepts protocol-v2 pending-command envelopes
OK Replay Pending Commands preserves command lease expiry in queued command payloads
OK Sync Init Schema + Triggers creates the edge command replay ledger during sync init
OK Sync Init Schema + Triggers creates the canonical applied_commands.result_detail column
OK Sync Init Schema + Triggers creates/applies applied_commands retry accounting columns
OK Sync Init Schema + Triggers creates/applies applied_commands ACK retry timestamp column
OK Sync Init Schema + Triggers creates the durable edge command ACK outbox during sync init
OK Deduplicate Pending Command delegates exact stored-result replay before dispatch via the shared command ledger
OK Deduplicate Pending Command fails closed when replay-ledger lookup is unavailable
OK command-dedupe-dispatch classifies the protected command type before mandatory and optional helper loading
OK command-dedupe-dispatch keeps DB and ledger mandatory for every protected command
OK command-dedupe-dispatch surfaces unavailable optional journal replay hooks
OK command-dedupe-dispatch passes only non-terminal commands to effect dispatch
OK command-dedupe-dispatch removed keeps terminal and replay ACKs in the durable REST outbox
OK command-dedupe-dispatch exposes only the normal effect output
OK journal-command-apply-fn passes non-journal commands toward legacy dispatch before loading journal helpers
OK scoped-access-command-apply-fn passes protected scoped-access commands through the transactional helper
OK scoped-access-command-apply-fn fails closed when scoped-access helpers are unavailable
OK scoped-access-command-apply-fn closes the scoped-access command database handle
OK zone-command-apply-fn passes protected zone commands through the transactional helper
OK zone-command-apply-fn fails closed when zone helpers are unavailable
OK zone-command-apply-fn invalidates cached scope after an applied zone mutation
OK zone-command-apply-fn closes the zone command database handle
OK irrigation-config-command-apply-fn routes only protected irrigation-config commands through the transactional helper
OK irrigation-config-command-apply-fn fails closed when irrigation-config helpers are unavailable
OK irrigation-config-command-apply-fn closes the irrigation-config command database handle
OK device-command-apply-fn routes only protected device commands through the transactional helper
OK device-command-apply-fn fails closed when protected device helpers are unavailable
OK device-command-apply-fn invalidates cached scope after an applied protected device mutation
OK device-command-apply-fn closes the protected device command database handle
OK d7e5c762c820aa16 increments the schedule aggregate version for local writes
OK d7e5c762c820aa16 persists the independent schedule aggregate version
OK d7e5c762c820aa16 removed parent-zone version mutation from local schedule writes
OK zone-calibration-fn loads the calibration aggregate version for local writes
OK zone-calibration-fn distinguishes a missing calibration row from one already at version 0
OK zone-calibration-fn increments the independent calibration aggregate version
OK zone-calibration-fn persists local calibration desired state without marking it cloud-applied
OK zone-calibration-fn binds local calibration write parameters
OK zone-calibration-fn removed parent-zone version mutation from local calibration writes
OK osi-command-ledger/index.js looks up exact command IDs before payload validation
OK osi-command-ledger/index.js checks physical-action expiry before effect dispatch
OK osi-command-ledger/index.js treats equality at the expiry boundary as terminal
OK osi-command-ledger/index.js persists pre-dispatch expiry decisions through the command ledger
OK osi-journal/commands.js reconstructs ACK facts from canonical replay-ledger detail
OK osi-scoped-access-commands/index.js applies scoped-access mutations and terminal ACK persistence in one transaction
OK osi-scoped-access-commands/index.js rejects stale scoped-access commands with a terminal conflict
OK osi-scoped-access-commands/index.js protects the final enabled gateway admin
OK osi-scoped-access-commands/index.js invalidates cached scope after an applied mutation
OK osi-zone-commands/index.js applies zone mutations and terminal ACK persistence in one transaction
OK osi-zone-commands/index.js rejects protected zone payload shape drift
OK osi-zone-commands/index.js pins the protected zone aggregate contract version
OK osi-zone-commands/index.js rejects stale zone commands with a terminal conflict
OK osi-zone-commands/index.js detaches devices before tombstoning a zone
OK osi-zone-commands/index.js persists the terminal zone ACK atomically with the mutation
OK osi-irrigation-config-commands/index.js applies irrigation config and its terminal ACK in one transaction
OK osi-irrigation-config-commands/index.js requires consecutive irrigation config versions
OK osi-irrigation-config-commands/index.js registers protected calibration desired state
OK osi-irrigation-config-commands/index.js persists irrigation config ACKs atomically
OK osi-device-commands/index.js applies protected device state and its terminal ACK in one transaction
OK osi-device-commands/index.js requires consecutive protected device versions
OK osi-device-commands/index.js updates the canonical device aggregate
OK osi-device-commands/index.js persists protected device ACKs atomically
OK osi-device-commands/index.js removed runtime valve observations from protected device writes
OK osi-device-commands/index.js removed runtime valve targets from protected device writes
OK osi-device-commands/weather.js replaces weather assignments and persists the terminal ACK in one transaction
OK osi-device-commands/weather.js rejects weather assignment commands for other device families
OK osi-device-commands/weather.js replaces the complete weather assignment set
OK osi-device-commands/weather.js persists weather assignment ACKs atomically
OK s2120-zones-put-auth-fn uses the versioned aggregate helper for local weather assignment writes
OK s2120-zones-put-auth-fn returns the weather assignment aggregate version
OK Queue REST Command ACK delegates atomic terminal ledger and ACK queueing via the shared command ledger
OK osi-command-ledger/index.js never rewrites an existing terminal command result
OK osi-command-ledger/index.js queues durable REST command ACKs in the shared transaction helper
OK Queue REST Command ACK removed legacy applied_commands.detail insert column
OK Queue REST Command ACK removed terminal ledger rewrite SQL
OK Build Command ACK Batch posts queued command ACKs to the sync REST endpoint
OK Build Command ACK Batch opts REST command ACKs into sync protocol v2
OK Mark Command ACKs Delivered marks REST command ACK rows delivered only after a successful response
OK command-ack-mark-delivered requires an eligible integer HTTP 200 before evaluating any per-entry ACK result
OK command-ack-mark-delivered delivers a command ACK outbox row only for a single unambiguous accepted-terminal result
OK command-ack-mark-delivered resolves the server business commandId to local outbox row ids via the build-batch correlation map, not the row PKs directly
OK command-ack-mark-delivered falls back to id-as-commandId only when no correlation metadata is present, preserving the pre-fix per-entry contract
OK command-ack-build-batch detects conflicting local ACK rows for the same commandId by canonical payload equality
OK command-ack-build-batch carries local outbox row correlation for collapsed duplicate ACKs
OK command-ack-build-batch withholds delivery and warns on conflicting local ACK rows without leaking lease tokens
OK sync-pending-split routes WORK_REQUEST_STATUS before the actuator replay guard
OK sync-pending-split has separate normal/status outputs
OK sync-pending-split routes WORK_REQUEST_STATUS to status apply
OK work-request-status-apply declares osiDb for local improvement_requests status updates
OK work-request-status-apply updates improvement request cloud status fields
OK work-request-status-apply records the cloud status timestamp
OK work-request-status-apply queues WORK_REQUEST_STATUS ACKs through the durable ACK queue
OK work-request-status-apply guards a replay of the same commandId against the shipped applied_commands ledger before re-UPDATE-ing improvement_requests
OK work-request-status-apply rebuilds and returns the original terminal ACK verbatim on replay, using the stored applied_at instead of call-time now, without mutating the request again
OK work-request-status-apply writes the applied_commands dedup marker in the same shape osi-command-ledger.queueCommandAck writes, so a replayed ack downstream is byte-for-byte unchanged
OK sync-pending-split gates lastPendingCommandPollSuccessAt on an explicit integer 2xx predicate, never a truthy/0/string statusCode
OK reject-indefinite-open produces a durable REJECTED_PERMANENT ack instead of silently dropping a permanently-invalid command
OK reject-indefinite-open routes every permanent-rejection path (indefinite OPEN, unknown type, missing duration) through the durable ACK output
OK reject-indefinite-open removed WORK_REQUEST_STATUS actuator/downlink handling
OK command-dedupe-dispatch removed WORK_REQUEST_STATUS actuator/downlink handling
OK 934bf2bc19a8ce22 removed WORK_REQUEST_STATUS actuator/downlink handling
OK cdbaa3891d40d7a1 removed WORK_REQUEST_STATUS actuator/downlink handling
OK write-strega-expectation removed WORK_REQUEST_STATUS actuator/downlink handling
OK cmd-type-registry removed WORK_REQUEST_SUBMITTED actuator/downlink handling
OK reject-indefinite-open removed WORK_REQUEST_SUBMITTED actuator/downlink handling
OK command-dedupe-dispatch removed WORK_REQUEST_SUBMITTED actuator/downlink handling
OK 934bf2bc19a8ce22 removed WORK_REQUEST_SUBMITTED actuator/downlink handling
OK cdbaa3891d40d7a1 removed WORK_REQUEST_SUBMITTED actuator/downlink handling
OK write-strega-expectation removed WORK_REQUEST_SUBMITTED actuator/downlink handling
OK e73a11a2a36aab22 does not subscribe to WORK_REQUEST_SUBMITTED over MQTT
OK e382bbf0dde572b1 does not subscribe to WORK_REQUEST_SUBMITTED over MQTT
OK 983d2de5486eeb4d does not subscribe to WORK_REQUEST_SUBMITTED over MQTT
OK lsn50-mqtt-in does not subscribe to WORK_REQUEST_SUBMITTED over MQTT
OK s2120-mqtt-in does not subscribe to WORK_REQUEST_SUBMITTED over MQTT
OK lorain-mqtt-in does not subscribe to WORK_REQUEST_SUBMITTED over MQTT
OK c571729fb2943059 does not subscribe to WORK_REQUEST_SUBMITTED over MQTT
OK sdi12-mqtt-in does not subscribe to WORK_REQUEST_SUBMITTED over MQTT
OK improvement-requests-api-router declares osiDb for field request intake
OK improvement-requests-api-router declares crypto for verifyBearer
OK improvement-requests-api-router contains the local HMAC bearer verifier
OK improvement-requests-api-router requires explicit public consent
OK improvement-requests-api-router rejects request bodies at or above 65536 bytes
OK improvement-requests-api-router validates title length 3-80
OK improvement-requests-api-router validates description length 10-4000
OK improvement-requests-api-router generates a 32-byte status secret
OK improvement-requests-api-router hashes the status secret before storage
OK improvement-requests-api-router stores the status secret hash
OK improvement-requests-api-router returns the one-time status secret
OK improvement-requests-api-router stores optional contact email
OK improvement-requests-api-router defines the diagnostics JSON byte cap
OK improvement-requests-api-router stores capped diagnostics JSON
OK improvement-requests-api-router includes GUI version in diagnostics
OK improvement-requests-api-router summarizes sync_state diagnostics
OK improvement-requests-api-router prefers flow gateway_health diagnostics
OK improvement-requests-api-router falls back to global edge_health diagnostics
OK improvement-requests-api-router redacts bearer tokens from user text
OK improvement-requests-api-router redacts password/credential patterns from user text
OK improvement-requests-api-router redacts JWT-like strings from user text
OK improvement-requests-api-router redacts AppKey-like 32-hex strings from user text
OK improvement-requests-api-router redacts email patterns from user text
OK improvement-requests-api-router redacts 16-hex EUI patterns from user text
OK improvement-requests-api-router uses fixed [REDACTED] replacement for user text
OK improvement-requests-api-router honors diagnostics consent before collecting private diagnostics
OK improvement-requests-api-router builds private diagnostics only when diagnostics consent is granted
OK improvement-requests-api-router stores empty diagnostics when diagnostics consent is declined
OK improvement-requests-api-router builds a display-redacted diagnostics preview
OK improvement-requests-api-router returns the display-redacted diagnostics preview payload
OK improvement-requests-api-router redacts raw gateway EUI in diagnostics preview
OK improvement-requests-api-router inserts local field requests
OK improvement-requests-api-router persists optional contact email separately from redacted request text
OK improvement-requests-api-router rejects invalid contact_email before insert
OK improvement-requests-api-router documents trigger-emitted WORK_REQUEST_SUBMITTED intake contract
OK support-delivery-tick support delivery has a scheduled inject node
OK support-delivery-tick support delivery tick routes to worker
OK support-delivery-tick runs every 300 seconds / 300000 ms
OK support-delivery-worker support delivery worker is a function node
OK support-delivery-worker declares osiDb for queued improvement request reads
OK support-delivery-worker uses shared IPv4 HTTP client
OK support-delivery-worker scans queued improvement requests past backed-off rows
OK support-delivery-worker loads the matching WORK_REQUEST_SUBMITTED outbox payload
OK support-delivery-worker posts to the support edge work-request endpoint
OK support-delivery-worker posts through shared IPv4 HTTP helper
OK support-delivery-worker resolves support server URL from sync_state first
OK support-delivery-worker resolves support server URL from OSI_CLOUD_SERVER_URL second
OK support-delivery-worker falls back to the default support server URL
OK support-delivery-worker sends no Authorization header
OK support-delivery-worker removed support delivery Authorization header transmission
OK support-delivery-worker accepts result or status as terminal support response state
OK support-delivery-worker loads retry state from flow context
OK support-delivery-worker persists retry state to flow context
OK support-delivery-worker implements bounded exponential backoff
OK support-delivery-worker caps missing outbox retry state
OK support-delivery-worker marks stale missing outbox payloads terminal
OK support-delivery-worker tracks attempted rows separately from skipped backoff rows
OK support-delivery-worker prevents backed-off rows from consuming the delivery tick
OK support-delivery-worker marks accepted or duplicate work requests submitted
OK support-delivery-worker marks terminally rejected work requests rejected
OK support-delivery-worker retries on 404 instead of permanently rejecting
OK support-delivery-worker guards cloud_status update against clobbering fresher statuses
OK support-delivery-worker closes the delivery worker database handle
OK seed-blank.sql improvement request trigger exists
OK seed-blank.sql improvement request trigger emits WORK_REQUEST_SUBMITTED
OK seed-blank.sql improvement request trigger emits WORK_REQUEST aggregate type
OK cmd-type-registry allows cloud zone-detach commands through the pending-command guard
OK cmd-type-registry allows cloud device-unclaim commands through the pending-command guard
OK Reject Indefinite Open fallback command registry allows zone-detach commands before startup registry loads
OK Reject Indefinite Open fallback command registry allows device-unclaim commands before startup registry loads
OK Build UPDATE SQL accepts schema-shaped device_eui payloads for device-scoped SQL commands
OK sync-pending-split routes pending cloud commands through the indefinite-open guard before the replay ledger
OK sync-force-build routes force-sync replayed commands through the indefinite-open guard before the replay ledger
OK reject-indefinite-open routes guarded cloud commands through the replay ledger
OK reject-indefinite-open routes permanent rejection ACKs around the command deduper and into the durable ACK queue
OK command-dedupe-dispatch routes non-duplicates through the journal-aware command applier
OK journal-command-apply-fn preserves the legacy output while routing non-journal commands onward
OK journal-command-apply-fn routes non-journal commands through scoped-access handling
OK scoped-access-command-apply-fn routes non-access commands through protected zone handling
OK scoped-access-command-apply-fn publishes atomically persisted scoped-access ACKs
OK zone-command-apply-fn routes non-zone commands through protected irrigation-config handling
OK zone-command-apply-fn publishes atomically persisted zone ACKs
OK irrigation-config-command-apply-fn routes non-irrigation commands through protected device handling
OK irrigation-config-command-apply-fn publishes atomically persisted irrigation-config ACKs
OK device-command-apply-fn falls through legacy device commands to the existing router
OK device-command-apply-fn publishes atomically persisted protected device ACKs
OK c8628cffe45f64f7 routes STREGA command ACKs through the durable ACK queue
OK cs-reg-cloud-ack-fn routes special command ACKs through the durable ACK queue
OK lsn50-mode-ack-link-in routes LSN50 command ACKs through the durable ACK queue
OK command-ack-queue-rest preserves MQTT command ACK telemetry after durable queueing
OK has a scheduled sync outbox retention tick
OK sync outbox retention runs daily at 02:00
OK Prune Sync Outbox uses a configurable sync outbox retention window
OK Prune Sync Outbox prunes delivered sync outbox rows
OK Prune Sync Outbox does not prune pending sync outbox rows
OK Prune Sync Outbox attempts a WAL checkpoint after deleting old outbox rows
OK outbox-retention-tick runs the sync outbox retention function
OK Run Force Sync uses sync protocol v2 for manual force-sync outbox and command polling
OK Run Force Sync manual force-sync marks only terminal protocol-v2 event results delivered
OK Run Force Sync manual force-sync accepts protocol-v2 pending-command envelopes
OK Build Sync State returns gateway identity diagnostics in sync state
OK Build Sync State reports pending gateway migration state in sync state
OK Build Sync State reports last gateway migration result in sync state
OK Build Cloud Bootstrap loads bootstrap sensor history before reordering it
OK Build Cloud Bootstrap replays bootstrap sensor history oldest-to-newest
OK Build Cloud Bootstrap loads bootstrap dendro history before reordering it
OK Build Cloud Bootstrap replays bootstrap dendro history oldest-to-newest
OK Build Cloud Bootstrap normalizes malformed edge timestamps before bootstrap sync
OK Build Cloud Bootstrap normalizes zone tombstone timestamps before bootstrap sync
OK Build Cloud Bootstrap exports the prediction-card flag in bootstrap payloads
OK Build Cloud Bootstrap normalizes device tombstone timestamps before bootstrap sync
OK Build Cloud Bootstrap normalizes schedule timestamps before bootstrap sync
OK Build Cloud Bootstrap loads irrigation calibration desired state for bootstrap sync
OK Build Cloud Bootstrap includes irrigation calibration desired state in bootstrap payloads
OK Build Cloud Bootstrap includes the irrigation-config desired-state capability in bootstrap metadata
OK Build Cloud Bootstrap ignores deleted devices when exporting bootstrap sensor history
OK Build Cloud Bootstrap ignores deleted devices when exporting bootstrap dendro history
OK Build Cloud Bootstrap ignores deleted zones when exporting bootstrap history
OK Mark Bootstrap Synced preserves server ProblemDetail details for bootstrap errors
OK al-link-handle-auth persists MQTT credentials after successful account linking
OK al-link-store-mqtt finalizes linked-account state only after MQTT config persistence
OK al-link-finalize formats a success response only after linked-account finalization
OK al-link-finalize rolls back MQTT credentials when linked-account finalization fails
OK al-link-success schedules restart only after link success is fully prepared
OK al-link-restart-node-red triggers an immediate bootstrap only after scheduling the link restart
OK al-link-restart-node-red clears transient link state only after successful link restart scheduling
OK al-link-build-claim removed the legacy claim-bulk account-link request path
OK al-link-server-claim removed the legacy claim-bulk account-link HTTP request path
OK al-link-handle-claim removed the legacy claim-bulk response handler
OK al-link-db-update removed the legacy pre-MQTT link finalization query
OK sync-bootstrap-account-link-in routes post-link bootstrap triggers into the bootstrap builder
OK al-unlink-func clears MQTT credentials only after unlink auth succeeds
OK al-unlink-clear-mqtt clears linked account state only after MQTT credentials are removed
OK al-unlink-db restores MQTT credentials when unlink database cleanup fails
OK al-unlink-format schedules restart only after unlink state is cleared successfully
OK al-unlink-restart-node-red clears transient link state only after successful unlink restart scheduling
OK Persist MQTT Broker Config writes the MQTT password into UCI after linking
OK Persist MQTT Broker Config persists the linked gateway identity into UCI after linking
OK Persist MQTT Broker Config fails linking when MQTT credentials are incomplete
OK Persist MQTT Broker Config backs up prior MQTT config before persisting linked credentials
OK Persist MQTT Broker Config falls back to regex host extraction when URL is unavailable
OK Persist MQTT Broker Config removed Node-RED restart while link persistence is still in flight
OK al-link-handle-auth clears transient link state when server auth fails
OK al-link-store-mqtt clears transient link state when MQTT persistence fails
OK Clear MQTT Broker Config clears the MQTT password from UCI after unlinking
OK Clear MQTT Broker Config clears the linked gateway identity from UCI after unlinking
OK Clear MQTT Broker Config backs up prior MQTT config before unlink cleanup
OK Clear MQTT Broker Config removed Node-RED restart while unlink cleanup is still in flight
OK Rollback MQTT Broker Config restores prior MQTT config when link finalization fails
OK Restore MQTT Broker Config restores prior MQTT config when unlink finalization fails
OK Schedule Link Restart requests a daemon-owned restart only after successful link completion
OK Schedule Link Restart uses the account-link restart contract
OK Schedule Link Restart removed does not restart Node-RED directly
OK Schedule Unlink Restart requests a daemon-owned restart only after successful unlink completion
OK Schedule Unlink Restart uses the account-unlink restart contract
OK Schedule Unlink Restart removed does not restart Node-RED directly
OK al-link-server-auth uses function node for IPv4 cloud REST
OK al-link-server-auth imports the IPv4 cloud REST helper
OK al-link-server-auth calls requestJsonIpv4
OK al-link-server-auth preserves IPv4 request failures as message payloads
OK sync-bootstrap-http uses function node for IPv4 cloud REST
OK sync-bootstrap-http imports the IPv4 cloud REST helper
OK sync-bootstrap-http calls requestJsonIpv4
OK sync-bootstrap-http preserves IPv4 request failures as message payloads
OK sync-outbox-http uses function node for IPv4 cloud REST
OK sync-outbox-http imports the IPv4 cloud REST helper
OK sync-outbox-http calls requestJsonIpv4
OK sync-outbox-http preserves IPv4 request failures as message payloads
OK sync-pending-http uses function node for IPv4 cloud REST
OK sync-pending-http imports the IPv4 cloud REST helper
OK sync-pending-http calls requestJsonIpv4
OK sync-pending-http preserves IPv4 request failures as message payloads
OK sync-refresh-http uses function node for IPv4 cloud REST
OK sync-refresh-http imports the IPv4 cloud REST helper
OK sync-refresh-http calls requestJsonIpv4
OK sync-refresh-http preserves IPv4 request failures as message payloads
OK Run Force Sync uses the shared IPv4 cloud REST helper
OK sync-force-build imports the IPv4 helper for manual force sync
OK Run Force Sync uses linked cloud usernames in force-sync device snapshots
OK Run Force Sync uses linked cloud usernames in force-sync zone snapshots
OK Run Force Sync includes STREGA model metadata in force-sync device snapshots
OK Run Force Sync includes STREGA current state in force-sync device snapshots
OK Run Force Sync includes STREGA target state in force-sync device snapshots
OK Run Force Sync includes observed LSN50 mode in force-sync sensor data
OK Run Force Sync includes dendrometer reference voltage in force-sync sensor data
OK Run Force Sync includes dendrometer ratio in force-sync sensor data
OK Run Force Sync includes the selected dendrometer path in force-sync sensor data
OK Run Force Sync includes baseline-relative stem change in force-sync sensor data
OK Run Force Sync includes zone area in force-sync snapshots
OK Run Force Sync includes zone irrigation efficiency in force-sync snapshots
OK Run Force Sync includes the prediction-card flag in force-sync snapshots
OK Run Force Sync includes normalized rain telemetry in force-sync sensor data
OK Run Force Sync includes normalized flow telemetry in force-sync sensor data
OK Run Force Sync synthesizes stable irrigation event UUIDs for forced bootstrap snapshots
OK Run Force Sync includes gateway GPS state in forced sync payloads
OK Run Force Sync includes the edge build version in forced bootstrap gateway metadata
OK Run Force Sync includes sync capabilities in forced bootstrap gateway metadata
OK Run Force Sync includes the versioned zone desired-state capability in forced bootstrap metadata
OK Run Force Sync includes the irrigation-config desired-state capability in forced bootstrap metadata
OK Run Force Sync includes the protected device desired-state capability in forced bootstrap metadata
OK Run Force Sync includes the weather-station zone desired-state capability in forced bootstrap metadata
OK Run Force Sync loads force-sync sensor history before reordering it
OK Run Force Sync replays force-sync sensor history oldest-to-newest
OK Run Force Sync loads force-sync dendro history before reordering it
OK Run Force Sync replays force-sync dendro history oldest-to-newest
OK Run Force Sync normalizes malformed edge timestamps before forced bootstrap sync
OK Run Force Sync normalizes zone tombstone timestamps before forced bootstrap sync
OK Run Force Sync exports the prediction-card flag in forced bootstrap payloads
OK Run Force Sync normalizes device tombstone timestamps before forced bootstrap sync
OK Run Force Sync normalizes schedule timestamps before forced bootstrap sync
OK Run Force Sync loads irrigation calibration desired state for force sync
OK Run Force Sync includes irrigation calibration desired state in force-sync payloads
OK Run Force Sync ignores deleted devices when exporting force-sync sensor history
OK Run Force Sync ignores deleted devices when exporting force-sync dendro history
OK Run Force Sync ignores deleted zones when exporting force-sync history
OK Run Force Sync preserves server ProblemDetail details in force-sync bootstrap errors
OK Run Force Sync initializes pending-command apply semantics in force-sync summary
OK Run Force Sync marks force-sync pending commands as applying after the HTTP response
OK Run Force Sync reports force-sync pending-command apply phase explicitly
OK Run Force Sync supports internally queued force-sync sweeps from cloud commands
OK Run Force Sync filters pending commands before queueing them locally
OK Run Force Sync prevents force-edge-sync commands from recursing through pending-command replay
OK Run Force Sync surfaces rejected migration candidates in force-sync migration state
OK Daily Dendrometer Analytics uses calibration-aware recovery threshold
OK Daily Dendrometer Analytics uses absolute night TWD in recovery verification
OK Daily Dendrometer Analytics uses the exact previous-three-day recovery window
OK Daily Dendrometer Analytics downgrades stress on high-VPD good-recovery days
OK Daily Dendrometer Analytics upgrades stress on low-VPD poor-recovery days
OK Daily Dendrometer Analytics computes rolling SD-VPD correlation
OK Daily Dendrometer Analytics flags SD-VPD decoupling against the baseline
OK Daily Dendrometer Analytics requires completed baselines for recovery verification pass checks
OK Daily Dendrometer Analytics requires strong MDS recovery before ending verification
OK Daily Dendrometer Analytics stores VPD override diagnostics in recommendation_json
OK Daily Dendrometer Analytics stores SD-VPD diagnostics in recommendation_json
OK Get Zone Recommendations returns recommendation_json from the zone recommendation query
OK Get Zone Recommendations exposes recommendation_json in the local recommendations API
OK Daily Dendrometer Analytics supports configurable OpenAgri history search radius for edge analytics
OK Get Zone Environment Summary creates a local weather cache table for environment summaries
OK Get Zone Environment Summary supports configurable current-weather cache TTL
OK Get Zone Environment Summary supports configurable forecast cache TTL
OK Get Zone Environment Summary uses imported HTTP clients inside the Node-RED function runtime
OK osi-zone-env/index.js prioritizes local sensor climate over online weather for agronomic metrics
OK Get Zone Environment Summary falls back to mirrored gateway coordinates when a zone has no explicit location
OK Get Zone Environment Summary uses daily zone environment totals for water summary
OK Get Zone Environment Summary sums STREGA expectation liters separately from measured flow meter totals
OK Get Zone Environment Summary buckets STREGA estimated liters by zone-local date
OK Get Zone Environment Summary excludes cancelled STREGA expectations from estimated irrigation totals
OK Get Zone Environment Summary removed UTC date slicing for STREGA estimated liters
OK Get Zone Environment Summary returns measured flow-meter liters under an honest field name
OK Get Zone Environment Summary returns estimated valve-time liters under an honest field name
OK Get Zone Environment Summary computes effective mm for measured irrigation separately
OK Get Zone Environment Summary computes effective mm for estimated irrigation separately
OK Get Zone Environment Summary preserves local measured/estimated irrigation split when shared server water is displayed
OK Get Zone Environment Summary returns the irrigation-split overlay instead of raw shared server water
OK Save Zone Irrigation Calibration upserts zone irrigation calibration through the local API
OK Save Zone Irrigation Calibration writes the measured flow rate to the calibration table
OK Save Zone Irrigation Calibration writes the operator-entered measurement method to the calibration table
OK Save Zone Irrigation Calibration removed NOT NULL measured flow rate in runtime calibration create table
OK Save Zone Irrigation Calibration removed NOT NULL measurement method in runtime calibration create table
OK Save Zone Irrigation Calibration removed NOT NULL measured-at timestamp in runtime calibration create table
OK Save Zone Irrigation Calibration removed NOT NULL created-at timestamp in runtime calibration create table
OK Save Zone Irrigation Calibration removed NOT NULL updated-at timestamp in runtime calibration create table
OK deploy.sh runs the ordered migration runner during deploy
OK deploy.sh fetches ordered migration files from the manifest during deploy
OK deploy.sh fetches the deploy-time migration CLI
OK deploy.sh fetches the semantic baseline tool for first-run devices
OK deploy.sh fetches the pre-baseline sync_outbox repair
OK deploy.sh deploys the weather-station assignment command helper
OK deploy.sh removed inline zone irrigation calibration DDL in deploy.sh
OK deploy.sh removed inline nullable measured flow rate deploy repair
OK deploy.sh removed inline nullable measurement method deploy repair
OK deploy.sh removed inline nullable measured-at deploy repair
OK deploy.sh removed inline nullable created-at deploy repair
OK deploy.sh removed inline nullable updated-at deploy repair
OK runtime zone_irrigation_calibration DDL columns match the nullable contract
OK api.ts adds a shared client helper for zone irrigation calibration
OK api.ts targets the local zone irrigation calibration endpoint
OK farming.ts types measured irrigation separately from estimated irrigation
OK farming.ts types estimated irrigation separately from measured irrigation
OK WaterTab.tsx removed legacy mixed irrigation fallback under the measured label
OK WaterTab.tsx removed legacy daily mixed irrigation fallback under the measured label
OK IrrigationZoneCard.tsx removed legacy mixed irrigation fallback under the measured label
OK Get Zone Environment Summary builds a dedicated water summary block
OK Get Zone Environment Summary falls back instead of throwing when weather providers fail
OK Get Zone Environment Summary wraps online weather section construction
OK Get Zone Environment Summary wraps forecast section construction
OK osi-zone-env/index.js returns the frontend daily forecast high-temperature field
OK osi-zone-env/index.js returns the frontend daily forecast low-temperature field
OK osi-zone-env/index.js returns the frontend daily forecast rain-probability field
OK osi-zone-env/index.js returns the frontend hourly forecast temperature field
OK Get Zone Environment Summary exposes zone area in water summary
OK Get Zone Environment Summary reports water sensor health and warnings
OK Build Telemetry publishes observed LSN50 mode in edge telemetry
OK Build Telemetry converts Kiwi watermark frequency telemetry to kPa for cloud mirroring
OK Build Telemetry gates LSN50-only telemetry fields by profile
OK Build Telemetry avoids assigning LSN50 mode codes to Kiwi telemetry
OK Build Telemetry skips valve uplinks in sensor telemetry mirroring
OK Build Telemetry applies sentinel-aware STREGA environmental normalization in cloud telemetry
OK Build Telemetry skips unknown no-data uplinks instead of defaulting them to Kiwi
OK Build Telemetry loads local dendrometer config before telemetry conversion
OK Build Telemetry reuses shared raw LSN50 ADC decoding in telemetry mirroring
OK Build Telemetry reuses shared dendrometer path selection in telemetry mirroring
OK Build Telemetry reuses shared dendrometer delta handling in telemetry mirroring
OK Build Telemetry publishes baseline-relative stem change in live MQTT telemetry
OK Build Telemetry removed dropping STREGA telemetry from cloud MQTT mirroring
OK Build Telemetry includes the gateway transport identity in cloud telemetry payloads
OK 81c98fb07344a787 uses env-backed Kiwi profile routing
OK 81c98fb07344a787 uses env-backed Clover profile routing
OK strega-process-fn derives STREGA profile routing on the dedicated edge path
OK strega-process-fn falls back to the managed STREGA codec when ChirpStack has no decoded object
OK strega-process-fn normalizes Gen1 STREGA battery values for local storage
OK strega-process-fn drops the FFFF/FFFF sentinel environmental pair in local storage
OK strega-process-fn maps the Gen1 STREGA valve bit into local OPEN/CLOSED state
OK Decode LSN50 uses the shared raw LSN50 ADC decoder
OK Decode LSN50 reads ADC_CH1V from decoded MOD3 payloads
OK Decode LSN50 reads ADC_CH4V when present without using it for dendrometer conversion
OK Decode LSN50 decodes observed LSN50 mode from shared raw uplink parsing
OK Decode LSN50 filters uplinks to the env-backed LSN50 profile
OK Decode LSN50 normalizes Chameleon payload version from decoder output
OK Decode LSN50 normalizes Chameleon compensated resistance fields
OK Decode LSN50 keeps the raw LoRaWAN payload base64 for Chameleon replay
OK dragino_lsn50_decoder.js ships Chameleon V2 frame detection
OK dragino_lsn50_decoder.js ships simplified Chameleon V2 status handling
OK Apply Config stores observed or configured LSN50 mode on ingest
OK Apply Config derives Chameleon SWT metrics without bypassing dendrometer logic
OK Apply Config stores derived SWT1 in formattedData
OK Apply Config keeps dendrometer enablement as the persistence gate after Chameleon derivation
OK Apply Config removed the old dedicated Chameleon bypass branch
OK Apply Config surfaces Chameleon status in node status text
OK Apply Config loads the last persisted MOD9 sample before computing deltas
OK Apply Config computes elapsed seconds between MOD9 uplinks
OK Apply Config treats counter decreases as resets instead of inflating deltas
OK Apply Config guards MOD9 deltas against duplicate and out-of-order uplinks
OK Apply Config derives a rain rate from the elapsed interval
OK Apply Config derives a flow rate from the elapsed interval
OK Apply Config derives normalized rain per 10 minutes
OK Apply Config derives normalized flow per 10 minutes
OK Apply Config derives running daily rain and flow totals from persisted counters
OK Apply Config uses the shared dual-path dendrometer conversion helper
OK Apply Config stores which dendrometer conversion path was applied
OK Apply Config stores the derived dendrometer ratio
OK Apply Config tracks missing ratio calibration without emitting NaN values
OK Apply Config resets dendrometer deltas when path or calibration changes
OK Apply Config derives a baseline-relative stem change signal for the basic card and monitor
OK Apply Config stores the baseline-relative stem change alongside mechanical position
OK Apply Config clears the pending-baseline flag when a new valid stem-change baseline is persisted
OK lsn50-config-query-fn keeps LSN50 config SELECT valid before the Chameleon calibration-status subquery
OK Insert Chameleon Reading persists decoded Chameleon readings locally
OK Insert Chameleon Reading passes non-Chameleon LSN50 payloads downstream
OK Build Cloud Bootstrap loads bootstrap Chameleon history before reordering it
OK Build Cloud Bootstrap replays bootstrap Chameleon history oldest-to-newest
OK Build Cloud Bootstrap includes Chameleon data_invalid in bootstrap readings
OK Build Cloud Bootstrap loads Chameleon readings from the diagnostic table during bootstrap
OK Run Force Sync loads force-sync Chameleon history before reordering it
OK Run Force Sync replays force-sync Chameleon history oldest-to-newest
OK Run Force Sync includes Chameleon data_invalid in force-sync readings
OK Build Dendrometer Readings INSERT removed the old Chameleon dendrometer insert skip
OK lsn50-decode-fn imports osi-dendro-helper in Decode LSN50
OK lsn50-apply-config imports osi-dendro-helper in Apply Config
OK lsn50-apply-config imports osi-chameleon-helper in Apply Config
OK lsn50-apply-config loads Chameleon calibration through the async SQLite helper in Apply Config
OK lsn50-apply-config removed does not call the synchronous Chameleon calibration helper with osi-db-helper
OK chameleon-readings-insert-fn imports osi-db-helper in Insert Chameleon Reading
OK chameleon-readings-insert-fn persists Chameleon calibration_status when inserting readings
OK lsn50-zone-agg-fn routes LSN50 flow through Chameleon insert
OK chameleon-readings-insert-fn passes Chameleon insert output to dendrometer insert
OK 8809bb5239dfb3d4 imports osi-dendro-helper in Build Telemetry
OK strega-sql-fn serializes STREGA persistence through one helper-scoped transaction
OK strega-sql-fn issues parameterized statements inside the transaction scope
OK strega-sql-fn persists STREGA telemetry into device_data with parameters
OK strega-sql-fn conditionally updates the canonical local STREGA valve state on uplink
OK strega-sql-fn stores decoded STREGA telemetry in local device_data columns
OK strega-sql-fn returns the observed local STREGA valve state
OK strega-reconciliation-monitor reads canonical STREGA valve state from devices
OK strega-reconciliation-monitor uses device_data only to find the latest observation timestamp
OK strega-reconciliation-monitor uses the newest matching uplink timestamp for reconciliation
OK strega-reconciliation-monitor removed the old invalid device_data.current_state observer query
OK strega-sql-fn removed the old manual transaction opener inside the function node
OK strega-sql-fn removed the old manual transaction committer inside the function node
OK strega-sql-fn removed the old manual rollback branch inside the function node
OK strega-sql-fn opens the local STREGA database directly
OK strega-sql-fn removed the old multi-await transaction entrypoint
OK strega-sql-fn removed the old multi-await commit call
OK strega-sql-fn removed the old multi-await rollback call
OK strega-sql-fn removed the old multi-statement sqlite topic builder
OK strega-sql-fn removed passive STREGA uplinks from touching target_state
OK 093d7832e89c4027 removed old LSN50 Shadow Compare (DD8 cleanup; not restored -- proves normalizer coverage, not writer execution)
OK 460e0bfd95f89e67 loads normalizer via osi-lib
OK 460e0bfd95f89e67 loads device-writer via osi-lib
OK 460e0bfd95f89e67 reads edge manifest for column mapping
OK 460e0bfd95f89e67 opens the local database for LSN50 writes
OK 460e0bfd95f89e67 loads normalizer and writer via quarantine-safe loader
OK LSN50 writer retains primary and legacy fallback outputs
OK 460e0bfd95f89e67 awaits the asynchronous writer contract
OK 6b28e0d879808dd9 UC512 awaits the asynchronous writer contract
OK lsn50-fallback-marker-fn records every LSN50 fallback before the legacy insert
OK lsn50-fallback-marker-fn LSN50 fallback marker function node exists
OK lsn50-fallback-marker-sqlite LSN50 fallback marker SQLite node exists
OK lsn50-fallback-evict-fn LSN50 fallback evict function node exists
OK lsn50-fallback-evict-sqlite LSN50 fallback evict SQLite node exists
OK lsn50-sql-fn restored legacy LSN50 Build SQL INSERT node exists
OK lsn50-sqlite restored legacy LSN50 Sensor DB Insert node exists
OK 460e0bfd95f89e67 routes writer failures through observable fallback
OK lsn50-fallback-marker-fn writes the fallback quarantine marker row before eviction
OK lsn50-fallback-marker-sqlite evicts quarantine rows to the writer cap after marking
OK lsn50-fallback-evict-fn applies the quarantine eviction cap
OK lsn50-fallback-evict-sqlite reaches the restored legacy SQL builder only after marker + eviction
OK lsn50-sql-fn restored legacy SQL builder feeds the restored legacy insert
OK lsn50-sqlite restored legacy insert rejoins zone aggregation like primary output 1
OK lsn50-sql-fn removed removes the historical shadow-compare wire from the restored legacy SQL builder
OK lsn50-fallback-evict-fn LIMIT matches osi-device-writer QUARANTINE_CAP (temporary legacy path cannot load the writer constant when module loading itself caused the fallback)
OK every writeDeviceData( call site (3) across maintained function nodes is awaited
OK 96_osi_server_config LSN50 writer kill switch UCI default is absent-only (never resets an operator override)
OK 96_osi_server_config LSN50 writer kill switch defaults new images to disabled (0)
OK node-red.init node-red.init resolves the LSN50 writer kill switch from UCI
OK node-red.init node-red.init exports LSN50_WRITER_DISABLE into the Node-RED process env
OK lsn50-zone-agg-fn bins MOD9 zone totals by uplink timestamp instead of processing time
OK lsn50-zone-agg-fn only aggregates valid rain deltas into zone totals
OK lsn50-zone-agg-fn only aggregates valid flow deltas into zone totals
OK format-devices returns observed LSN50 mode in GET /api/devices
OK format-devices returns dendrometer CH1 voltage in GET /api/devices
OK format-devices returns dendrometer ratio in GET /api/devices
OK format-devices returns the active dendrometer conversion path in GET /api/devices
OK format-devices returns raw dendrometer position in GET /api/devices
OK format-devices returns baseline-relative stem change in GET /api/devices
OK format-devices returns dendrometer saturation state in GET /api/devices
OK format-devices returns dendrometer saturation side in GET /api/devices
OK format-devices returns canonical SWT channel 1 with legacy Kiwi fallback in GET /api/devices
OK format-devices returns canonical SWT channel 2 with legacy Kiwi fallback in GET /api/devices
OK format-devices returns Chameleon SWT channel 3 in GET /api/devices
OK format-devices returns latest Chameleon reading row id in GET /api/devices
OK format-devices returns latest Chameleon raw payload in GET /api/devices
OK format-devices returns latest Chameleon payload version in GET /api/devices
OK format-devices returns latest Chameleon status flags in GET /api/devices
OK format-devices returns latest Chameleon board temperature in GET /api/devices
OK format-devices returns latest Chameleon I2C-missing flag in GET /api/devices
OK format-devices returns latest Chameleon timeout flag in GET /api/devices
OK format-devices returns latest Chameleon temp-fault flag in GET /api/devices
OK format-devices returns latest Chameleon ID-fault flag in GET /api/devices
OK format-devices returns latest Chameleon channel-open flag in GET /api/devices
OK format-devices returns latest Chameleon channel 2 open flag in GET /api/devices
OK format-devices returns latest Chameleon channel 3 open flag in GET /api/devices
OK format-devices returns latest Chameleon compensated resistance in GET /api/devices
OK format-devices returns latest Chameleon channel 2 compensated resistance in GET /api/devices
OK format-devices returns latest Chameleon channel 3 compensated resistance in GET /api/devices
OK format-devices returns latest Chameleon raw resistance in GET /api/devices
OK format-devices returns latest Chameleon channel 2 raw resistance in GET /api/devices
OK format-devices returns latest Chameleon channel 3 raw resistance in GET /api/devices
OK format-devices returns latest Chameleon array id in GET /api/devices
OK format-devices joins latest Chameleon readings in GET /api/devices
OK format-devices filters GET /api/devices latest-data lookup to canonical uppercase DevEUIs
OK format-devices avoids invalid SQL when no canonical DevEUIs are available
OK format-devices uses a no-row latest-data query for empty device lookups
OK format-devices sets a sqlite topic before returning an empty device list
OK format-devices sets a sqlite topic before returning an all-invalid DevEUI list
OK format-devices keeps GET /api/devices device rows on the request message
OK format-devices removed request-scoped GET /api/devices rows in flow context
OK format-devices selects the latest Chameleon reading by timestamp
OK format-devices breaks same-timestamp Chameleon ties by row id
OK format-devices returns interval-aware rain rate in GET /api/devices
OK format-devices returns interval-aware flow rate in GET /api/devices
OK format-devices returns normalized rain telemetry in GET /api/devices
OK format-devices returns normalized flow telemetry in GET /api/devices
OK format-devices returns elapsed counter interval in GET /api/devices
OK format-devices returns S2120 pressure in GET /api/devices
OK format-devices returns S2120 wind speed in GET /api/devices
OK format-devices returns S2120 wind direction in GET /api/devices
OK format-devices returns S2120 wind gust in GET /api/devices
OK format-devices returns S2120 UV in GET /api/devices
OK format-devices returns S2120 cumulative rain in GET /api/devices
OK format-devices returns S2120 battery in GET /api/devices
OK merge-device-data returns configured LSN50 mode in GET /api/devices
OK merge-device-data reads GET /api/devices device rows from the request message
OK merge-device-data removed request-scoped GET /api/devices rows from flow context
OK merge-device-data returns the explicit legacy dendrometer override in GET /api/devices
OK merge-device-data returns dendrometer stroke calibration in GET /api/devices
OK merge-device-data returns dendrometer retracted-ratio calibration in GET /api/devices
OK merge-device-data returns dendrometer extended-ratio calibration in GET /api/devices
OK merge-device-data returns the pending-baseline flag in GET /api/devices
OK merge-device-data returns Chameleon enabled config in GET /api/devices
OK merge-device-data returns Chameleon SWT depth config in GET /api/devices
OK merge-device-data removed merge-device-data no longer returns chameleon_swt1_a
OK merge-device-data removed merge-device-data no longer returns chameleon_swt1_b
OK merge-device-data removed merge-device-data no longer returns chameleon_swt1_c
OK merge-device-data merges Chameleon SWT channel 1 into GET /api/devices
OK merge-device-data maps latest Chameleon reading row id from SQL results
OK merge-device-data maps latest Chameleon raw payload from SQL results
OK merge-device-data merges latest Chameleon reading row id into GET /api/devices
OK merge-device-data merges latest Chameleon raw payload into GET /api/devices
OK merge-device-data merges latest Chameleon payload version into GET /api/devices
OK merge-device-data merges latest Chameleon status flags into GET /api/devices
OK merge-device-data merges latest Chameleon board temperature into GET /api/devices
OK merge-device-data merges latest Chameleon I2C-missing flag into GET /api/devices
OK merge-device-data merges latest Chameleon timeout flag into GET /api/devices
OK merge-device-data merges latest Chameleon temp-fault flag into GET /api/devices
OK merge-device-data merges latest Chameleon ID-fault flag into GET /api/devices
OK merge-device-data merges latest Chameleon channel-open flag into GET /api/devices
OK merge-device-data merges latest Chameleon channel 2 open flag into GET /api/devices
OK merge-device-data merges latest Chameleon channel 3 open flag into GET /api/devices
OK merge-device-data merges latest Chameleon channel 1 resistance into GET /api/devices
OK merge-device-data merges latest Chameleon channel 2 resistance into GET /api/devices
OK merge-device-data merges latest Chameleon raw resistance into GET /api/devices
OK merge-device-data merges latest Chameleon channel 2 raw resistance into GET /api/devices
OK merge-device-data merges latest Chameleon channel 3 raw resistance into GET /api/devices
OK merge-device-data merges latest Chameleon array id into GET /api/devices
OK merge-device-data merges latest Chameleon channel 3 resistance into GET /api/devices
OK merge-device-data merges dendrometer ratio into GET /api/devices
OK merge-device-data merges dendrometer path metadata into GET /api/devices
OK merge-device-data merges raw dendrometer position into GET /api/devices
OK merge-device-data merges baseline-relative stem change into GET /api/devices
OK merge-device-data merges dendrometer saturation into GET /api/devices
OK merge-device-data merges dendrometer saturation-side metadata into GET /api/devices
OK merge-device-data returns stored STREGA model metadata in GET /api/devices
OK merge-device-data merges interval-aware rain rate into GET /api/devices
OK merge-device-data merges interval-aware flow rate into GET /api/devices
OK merge-device-data merges normalized rain telemetry into GET /api/devices
OK merge-device-data merges normalized flow telemetry into GET /api/devices
OK merge-device-data merges elapsed counter interval into GET /api/devices
OK merge-device-data merges S2120 pressure into GET /api/devices
OK merge-device-data merges S2120 wind speed into GET /api/devices
OK merge-device-data merges S2120 wind direction into GET /api/devices
OK merge-device-data merges S2120 wind gust into GET /api/devices
OK merge-device-data merges S2120 UV into GET /api/devices
OK merge-device-data merges S2120 cumulative rain into GET /api/devices
OK merge-device-data merges S2120 battery into GET /api/devices
OK s2120-process-fn accepts live decoded S2120 message shape
OK s2120-process-fn accepts nested decoded S2120 message shape
OK s2120-process-fn uses current S2120 pressure ID
OK s2120-process-fn uses the Seeed cumulative-rain measurement ID
OK s2120-process-fn uses current and legacy S2120 wind-gust IDs
OK s2120-process-fn uses the decoded S2120 battery-percent field
OK s2120-process-fn skips duplicate S2120 rain-counter uplinks
OK s2120-process-fn skips out-of-order S2120 rain-counter uplinks
OK s2120-process-fn detects S2120 rain-counter resets
OK s2120-process-fn skips S2120 rain deltas when the interval is invalid
OK s2120-process-fn computes normalized S2120 rain telemetry per 10 minutes
OK s2120-process-fn stores the elapsed S2120 counter interval in seconds
OK s2120-rain-agg-fn prefers explicit S2120 weather station zone assignments
OK s2120-rain-agg-fn falls back when S2120 weather station zone assignments are absent
OK s2120-rain-agg-fn uses legacy S2120 irrigation zone fallback
OK s2120-rain-agg-fn seeds S2120 zone totals from device daily rain
OK s2120-rain-agg-fn keeps S2120 zone totals caught up with device daily rain
OK s2120-process-fn imports osi-db-helper as osiDb
OK s2120-rain-agg-fn imports osi-db-helper as osiDb
OK LoRain MQTT input uses application/+/device/+/event/up
OK catalog-response exposes LoRain in the device catalog
OK post-devices-insert maps local LoRain registration to the LoRain ChirpStack profile
OK post-devices-insert sets the Aqua-Scope LoRain JoinEUI for local registration
OK cs-reg-cloud-fn maps cloud LoRain registration to the LoRain ChirpStack profile
OK cs-reg-cloud-fn sets the Aqua-Scope LoRain JoinEUI for cloud registration
OK cs-reg-cloud-fn keeps cloud SenseCAP registration support while adding LoRain
OK lorain-process-fn filters LoRain uplinks by profile ID
OK lorain-process-fn guards LoRain uplinks by local device type
OK lorain-process-fn skips duplicate or out-of-order LoRain interval rain
OK lorain-process-fn computes normalized LoRain rain telemetry per 10 minutes
OK lorain-sql-fn persists LoRain tip deltas
OK lorain-rain-agg-fn labels LoRain zone rainfall source
OK lorain-process-fn imports osi-db-helper as osiDb
OK lorain-rain-agg-fn imports osi-db-helper as osiDb
OK merge-device-data imports osi-db-helper as osiDb for S2120 enrichment
OK s2120-zones-get-fn imports crypto for auth verification
OK s2120-zones-get-fn imports osi-db-helper as osiDb
OK s2120-zones-put-auth-fn imports crypto for auth verification
OK s2120-zones-put-auth-fn imports osi-db-helper as osiDb
OK put-soil-depth-fn imports crypto for soil-depth auth verification
OK put-soil-depth-fn imports osi-db-helper for soil-depth persistence
OK sensor-history-fn routes legacy sensor history through the history helper rollup path
OK sensor-history-fn passes the requested legacy field to the helper
OK sensor-history-fn preserves owner scoping for legacy sensor history and delegates scoped access separately
OK sensor-history-fn uses osi-db-helper for legacy sensor history
OK sensor-history-fn uses osi-history-helper for legacy sensor history
OK sensor-history-fn imports crypto for legacy sensor history auth verification
OK fn_build_sensor_sql_params exports canonical SWT1 with legacy Kiwi fallback
OK fn_build_sensor_sql_params exports canonical SWT2 with legacy Kiwi fallback
OK put-chameleon-enabled-auth-fn imports crypto for Chameleon enabled auth verification
OK put-chameleon-enabled-auth-fn uses osi-db-helper for Chameleon enabled persistence
OK put-chameleon-enabled-auth-fn validates Chameleon enabled payload without broad coercion
OK put-chameleon-enabled-auth-fn rejects missing or invalid Chameleon enabled values
OK put-chameleon-enabled-auth-fn returns a 400 for invalid Chameleon enabled values
OK put-chameleon-enabled-auth-fn limits Chameleon enabled updates to LSN50 devices
OK put-chameleon-enabled-auth-fn bumps devices.sync_version on Chameleon enable toggle so trg_sync_devices_outbox_au emits an increasing-version DEVICE event (issue #5; matches dendro_enabled/temp_enabled/rain_gauge_enabled/flow_meter_enabled precedent, avoids the equal-version-payload-conflict class fixed for issue #10)
OK dendro-ref-tree-fn bumps devices.sync_version on reference-tree toggle so trg_sync_devices_outbox_au emits an increasing-version DEVICE event (issue #15; matches dendro_enabled/temp_enabled/rain_gauge_enabled/flow_meter_enabled/chameleon_enabled precedent, avoids the equal-version-payload-conflict class fixed for issue #10)
OK 8b93fa005d78e25f chameleon-depth-auth uses HMAC verifyBearer — not global.get(authCheck)
OK 8b93fa005d78e25f removed chameleon-depth-auth does not call the dead authCheck global
OK 8b93fa005d78e25f imports crypto for Chameleon depth auth verification
OK 8b93fa005d78e25f chameleon-depth-auth carries authenticated user context forward
OK 44e7d74ff3668e01 chameleon-refresh-auth uses HMAC verifyBearer — not global.get(authCheck)
OK 44e7d74ff3668e01 removed chameleon-refresh-auth does not call the dead authCheck global
OK 44e7d74ff3668e01 imports crypto for Chameleon refresh auth verification
OK 44e7d74ff3668e01 chameleon-refresh-auth carries authenticated user context forward
OK cc34104ef33b76fd chameleon-refresh-query limits array lookup to the authenticated user
OK cc34104ef33b76fd chameleon-refresh-query ignores deleted devices
OK bf93cd55db0eb57f chameleon-depth-save bumps sync_version to trigger the outbox on depth changes
OK bf93cd55db0eb57f chameleon-depth-save validates direct API depth values
OK bf93cd55db0eb57f chameleon-depth-save accepts numeric JSON depth values explicitly
OK bf93cd55db0eb57f chameleon-depth-save only coerces non-empty numeric strings
OK bf93cd55db0eb57f chameleon-depth-save rejects non-finite direct API depth values
OK bf93cd55db0eb57f chameleon-depth-save normalizes route DevEUI before persistence
OK bf93cd55db0eb57f chameleon-depth-save ignores deleted devices
OK bf93cd55db0eb57f chameleon-depth-save limits depth updates to the authenticated user
OK bf93cd55db0eb57f chameleon-depth-save returns 404 when no device row was updated
OK bf93cd55db0eb57f chameleon-depth-save reports missing devices honestly
OK d0b2b1c1a937e16d scheduler can evaluate Chameleon SWT channel 3
OK d0b2b1c1a937e16d scheduler includes Chameleon-enabled LSN50 devices
OK d0b2b1c1a937e16d scheduler SWT average counts Chameleon channel 3 only when present
OK dendro-history-fn routes legacy dendro history through the history helper rollup path
OK dendro-history-fn preserves dendrometer history response shape through helper dendro mode
OK dendro-history-fn preserves owner scoping for legacy dendro history and delegates scoped access separately
OK dendro-history-fn uses osi-db-helper for legacy dendro history
OK dendro-history-fn uses osi-history-helper for legacy dendro history
OK dendro-history-fn imports crypto for legacy dendro history auth verification
OK dendro-history-format formats dendrometer CH1 history for the GUI
OK dendro-history-format formats dendrometer ratio history for the GUI
OK dendro-history-format formats dendrometer path history for the GUI
OK dendro-history-format formats baseline-relative stem change history for the GUI
OK dendro-raw-fn keeps raw dendrometer CH0 history backward compatible
OK dendro-raw-fn returns raw dendrometer CH1 readings
OK dendro-raw-fn returns raw dendrometer ratios
OK dendro-raw-fn returns raw dendrometer path metadata
OK dendro-raw-fn merges calibrated and raw-only dendrometer readings
OK dendro-raw-fn reads raw-only dendrometer history from device_data
OK dendro-raw-fn keeps raw-only dendrometer readings uncalibrated
OK dendro-raw-fn defaults raw-only dendrometer validity when device_data omits it
OK dendro-raw-fn limits synthetic raw dendrometer rows to uncalibrated samples
OK dendro-readings-insert-fn stores raw dendrometer debug fields in dendrometer_readings
OK put-dendro-config-auth-fn imports osi-db-helper for dendrometer config persistence
OK put-dendro-config-auth-fn ignores deleted devices when saving dendrometer config
OK put-dendro-config-auth-fn returns 404 for missing dendrometer-config devices
OK put-dendro-config-auth-fn marks the dendrometer baseline as pending when calibration changes
OK device-api catch node exists
OK device-api catch node type
OK device-api catch node tab
OK device-api catch node catches the whole tab
OK device-api-catch routes uncaught device-api errors into the HTTP 500 formatter
OK device-api-http500 maps recognized auth failures to 401 and defaults all other device-api failures to 500 (issue #9)
OK device-api-http500 bounds the 500 response to a generic message and never echoes the caught error
OK device-api-http500 formats uncaught device-api failures with the generic error code
OK device-api-http500 returns uncaught device-api failures through the shared response node
OK Format Dendro Config Response returns canonical dendrometer config fields
OK Format Dendro Config Response keeps legacy dendrometer inversion config for compatibility
OK post-dendro-baseline-reset-auth-fn clears the stored dendrometer baseline position
OK post-dendro-baseline-reset-auth-fn clears the stored dendrometer baseline mode
OK post-dendro-baseline-reset-auth-fn clears the stored dendrometer baseline calibration signature
OK post-dendro-baseline-reset-auth-fn marks the dendrometer baseline as pending after a manual reset
OK api.ts adds a shared client helper for dendrometer baseline resets
OK api.ts targets the local dendrometer baseline reset endpoint from the shared client helper
OK api.ts adds a shared client helper for Chameleon enablement
OK api.ts targets the local Chameleon enablement endpoint from the shared client helper
OK api.ts removed retired the per-device Chameleon coefficient client helper
OK api.ts types dendrometer history position as nullable
OK api.ts normalizes baseline-relative stem change for dendrometer history
OK api.ts removed coercing missing dendrometer history position to zero
OK api.ts removed coercing missing raw dendrometer position to zero
OK farming.ts allows synthetic raw dendrometer rows without numeric ids
OK farming.ts allows raw-only dendrometer rows to omit calibrated position
OK farming.ts types the latest stem-change signal on device payloads
OK farming.ts types the device-level baseline-pending flag
OK farming.ts types Chameleon SWT channel 3 on latest device payloads
OK farming.ts types Chameleon raw payload on latest device payloads
OK farming.ts types device-level Chameleon enablement flag
OK api.ts types the dendrometer history stem-change signal
OK farming.ts types latest_data.swt_1
OK farming.ts types latest_data.swt_2
OK farming.ts types latest_data.swt_3
OK farming.ts types latest_data.chameleon_reading_id
OK farming.ts types latest_data.chameleon_payload_b64
OK farming.ts types latest_data.chameleon_payload_version
OK farming.ts types latest_data.chameleon_status_flags
OK farming.ts types latest_data.chameleon_i2c_missing
OK farming.ts types latest_data.chameleon_timeout
OK farming.ts types latest_data.chameleon_temp_fault
OK farming.ts types latest_data.chameleon_id_fault
OK farming.ts types latest_data.chameleon_ch1_open
OK farming.ts types latest_data.chameleon_ch2_open
OK farming.ts types latest_data.chameleon_ch3_open
OK farming.ts types latest_data.chameleon_temp_c
OK farming.ts types latest_data.chameleon_r1_ohm_comp
OK farming.ts types latest_data.chameleon_r2_ohm_comp
OK farming.ts types latest_data.chameleon_r3_ohm_comp
OK farming.ts types latest_data.chameleon_r1_ohm_raw
OK farming.ts types latest_data.chameleon_r2_ohm_raw
OK farming.ts types latest_data.chameleon_r3_ohm_raw
OK farming.ts types latest_data.chameleon_array_id
OK farming.ts types top-level Device.chameleon_enabled
OK farming.ts types top-level Device.chameleon_swt1_depth_cm
OK farming.ts types top-level Device.chameleon_swt2_depth_cm
OK farming.ts types top-level Device.chameleon_swt3_depth_cm
OK api.ts types setChameleonDepth payload.chameleonSwt1DepthCm
OK api.ts types setChameleonDepth payload.chameleonSwt2DepthCm
OK api.ts types setChameleonDepth payload.chameleonSwt3DepthCm
OK DendrometerMonitor.tsx labels the basic monitor around the comparable stem-change signal
OK DendrometerMonitor.tsx renders mechanical engineering values beneath the stem-change graph
OK DendrometerMonitor.tsx shows absolute mechanical position below the graph instead of as the headline graph metric
OK DendrometerMonitor.tsx keeps the basic monitor informative when comparable stem change is not ready yet
OK farming/dendrometer/DendrometerMonitor.tsx explains raw-only dendrometer rows in the 24h drawer
OK farming/dendrometer/DendrometerMonitor.tsx shows CH1 and ratio debug values only for ratio-mode 24h readings
OK DraginoTempCard.tsx shows stem change as the only primary dendrometer signal on the device card
OK DraginoTempCard.tsx removed removes the old absolute-position headline from the device card
OK DraginoTempCard.tsx renders the baseline-relative stem change signal on the device card
OK DraginoTempCard.tsx suppresses stale stem-change values when the device is awaiting a new baseline
OK DraginoTempCard.tsx keeps the dendrometer card visible while the next valid uplink establishes a new baseline
OK DraginoTempCard.tsx renders Chameleon SWT on the LSN50 card
OK DraginoTempCard.tsx opens history for Chameleon SWT3
OK DraginoTempCard.tsx removed removes generic ADC card when dendrometer is disabled
OK DraginoTempCard.tsx keeps Chameleon SWT formatting null-safe through the shared formatter
OK DraginoTempCard.tsx surfaces invalid Chameleon sample state on the LSN50 card
OK DraginoTempCard.tsx treats Chameleon missing and timeout flags as invalid samples
OK DraginoDendroCalibrationSection.tsx shows ratio in the dendrometer calibration section instead of on the device card
OK DraginoSettingsModal.tsx adds dendrometer calibration controls to the LSN50 advanced settings
OK DraginoSettingsModal.tsx imports the Chameleon SWT calibration section
OK DraginoSettingsModal.tsx adds Chameleon SWT to the LSN50 sensor toggle list
OK DraginoSettingsModal.tsx labels the Chameleon SWT sensor toggle
OK DraginoSettingsModal.tsx wires the Chameleon SWT toggle to the local API
OK DraginoSettingsModal.tsx uses a per-sensor LSN50 mode gate
OK DraginoSettingsModal.tsx requires MOD3 for Chameleon SWT enablement
OK DraginoSettingsModal.tsx requires MOD9 for rain and flow counters
OK DraginoSettingsModal.tsx surfaces a clear MOD3 guard message for Chameleon enablement
OK DraginoSettingsModal.tsx warns before switching away from modes required by enabled sensors
OK DraginoSettingsModal.tsx documents the non-exclusive dendrometer and Chameleon MOD3 mode path
OK DraginoSettingsModal.tsx keeps the MOD1 temperature warning path separate from strict mode gates
OK DraginoSettingsModal.tsx warns before switching temperature-enabled LSN50 devices away from MOD1
OK DraginoSettingsModal.tsx renders a dedicated Chameleon SWT settings section
OK DraginoSettingsModal.tsx renders the Chameleon SWT calibration component in the settings modal
OK DraginoDendroCalibrationSection.tsx uses canonical retracted-ratio calibration wording in the advanced settings
OK DraginoDendroCalibrationSection.tsx uses canonical extended-ratio calibration wording in the advanced settings
OK DraginoDendroCalibrationSection.tsx allows capturing the live ratio into calibration endpoints
OK DraginoDendroCalibrationSection.tsx saves dendrometer calibration through the dedicated local API
OK DraginoDendroCalibrationSection.tsx adds a manual baseline reset action for legacy dendrometers
OK DraginoDendroCalibrationSection.tsx wires the manual baseline reset action to the local API
OK DraginoDendroCalibrationSection.tsx exposes the legacy dendrometer override in the advanced settings
OK DraginoChameleonSwtSection.tsx wires the manual refresh button to the edge endpoint
OK DraginoChameleonSwtSection.tsx persists install depth via the depth-only save endpoint
OK DraginoChameleonSwtSection.tsx removed retired the per-device coefficient save flow
OK DraginoChameleonSwtSection.tsx removed retired the workbook-default restore UI
OK swt.ts uses canonical SWT1 with legacy Kiwi fallback in shared GUI SWT utilities
OK swt.ts uses canonical SWT2 with legacy Kiwi fallback in shared GUI SWT utilities
OK IrrigationZoneCard.tsx computes Soil now from canonical SWT values across sensor families
OK IrrigationZoneCard.tsx removed prevents Soil now from reading only legacy Kiwi SWT values
OK SoilTab.tsx computes soil environment SWT from canonical sensor-family-neutral values
OK KiwiSensorCard.tsx uses canonical SWT1 for Kiwi live display and history
OK KiwiSensorCard.tsx uses canonical SWT2 for Kiwi live display and history
OK KiwiSensorCard.tsx stores Kiwi SWT1 depth metadata under the canonical key
OK ScheduleSection.tsx saves new SWT schedules with canonical metric names
OK Dragino settings components removed removes the ratio inversion toggle from the advanced settings
OK SenseCapWeatherCard.tsx opens a dedicated wind monitor from the S2120 card
OK SenseCapWeatherCard.tsx shows normalized rain history options on the S2120 card
OK SenseCapWeatherCard.tsx renders human-readable rain-counter state on the S2120 card
OK SenseCapWeatherCard.tsx uses shared wind-direction formatting on the S2120 card
OK farming.ts types Aqua-Scope LoRain as a supported device
OK LoRainGaugeCard.tsx renders LoRain interval rainfall
OK LoRainGaugeCard.tsx shows normalized LoRain rain-rate history options
OK LoRainGaugeCard.tsx removes LoRain devices through the existing device API
OK FarmingDashboard.tsx groups unassigned LoRain gauges
OK FarmingDashboard.tsx renders unassigned LoRain gauges
OK IrrigationZoneCard.tsx groups assigned LoRain gauges
OK IrrigationZoneCard.tsx renders assigned LoRain gauges
OK LocalTab.tsx styles LoRain devices in local environment breakdowns
OK WindMonitor.tsx loads wind-speed history in the dedicated S2120 wind monitor
OK WindMonitor.tsx loads wind-gust history in the dedicated S2120 wind monitor
OK WindMonitor.tsx loads wind-direction history in the dedicated S2120 wind monitor
OK wind.ts ships shared wind-direction formatting helpers
OK OnlineTab.tsx reuses shared wind-direction helpers in the online environment tab
OK WeatherTab.tsx reuses shared wind-direction helpers in the weather forecast tab
OK merge-device-data removed updated_at fallback for last_seen in GET /api/devices
OK Auth + Query Gateway Location queries gateway GPS state from the local mirror table
OK Format Gateway Location Response returns a no-fix fallback for linked gateways
OK Route Command routes SET_LSN50_MODE gateway commands
OK Route Command routes SET_LSN50_INTERVAL gateway commands
OK Route Command routes SET_LSN50_INTERRUPT_MODE gateway commands
OK Route Command routes SET_LSN50_5V_WARMUP gateway commands
OK Route Command routes SET_KIWI_INTERVAL gateway commands
OK Route Command routes ENABLE_KIWI_TEMP_HUMIDITY gateway commands
OK Route Command routes synced Kiwi soil depth commands through the shared update path
OK Route Command routes SET_STREGA_INTERVAL gateway commands
OK Route Command routes SET_STREGA_MODEL gateway commands
OK Route Command routes SET_STREGA_TIMED_ACTION gateway commands
OK Route Command routes SET_STREGA_MAGNET_MODE gateway commands
OK Route Command routes SET_STREGA_PARTIAL_OPENING gateway commands
OK Route Command routes SET_STREGA_FLUSHING gateway commands
OK Build UPDATE SQL updates the local configured LSN50 mode for synced commands
OK Build UPDATE SQL upserts shared zone area from sync commands
OK Build UPDATE SQL upserts the prediction-card flag from sync commands
OK Build UPDATE SQL applies zone area updates from control-plane sync
OK Build UPDATE SQL applies irrigation efficiency updates from control-plane sync
OK Build UPDATE SQL applies prediction-card updates from control-plane sync
OK Build UPDATE SQL accepts synced LSN50 interval commands on the gateway
OK Build UPDATE SQL accepts synced LSN50 interrupt mode commands on the gateway
OK Build UPDATE SQL accepts synced LSN50 5V warm-up commands on the gateway
OK Build UPDATE SQL accepts synced Kiwi interval commands on the gateway
OK Build UPDATE SQL accepts synced Kiwi temperature and humidity enable commands on the gateway
OK Build UPDATE SQL accepts synced Kiwi soil depth updates on the gateway
OK Build UPDATE SQL updates mirrored Kiwi soil depth metadata on the gateway
OK Sync Init Schema + Triggers creates the device outbox trigger for mirrored device changes
OK Sync Init Schema + Triggers queues device outbox events when Kiwi soil depth JSON changes locally
OK Sync Init Schema + Triggers queues device outbox events when Kiwi soil depth readiness changes locally
OK Sync Init Schema + Triggers mirrors Kiwi soil depth JSON in device outbox payloads
OK Sync Init Schema + Triggers mirrors Kiwi soil depth readiness in device outbox payloads
OK Sync Init Schema + Triggers queues device outbox events when Chameleon SWT1 depth changes locally
OK Sync Init Schema + Triggers queues device outbox events when Chameleon SWT2 depth changes locally
OK Sync Init Schema + Triggers queues device outbox events when Chameleon SWT3 depth changes locally
OK Sync Init Schema + Triggers mirrors Chameleon SWT1 depth in device outbox payloads
OK Sync Init Schema + Triggers mirrors Chameleon SWT2 depth in device outbox payloads
OK Sync Init Schema + Triggers mirrors Chameleon SWT3 depth in device outbox payloads
OK Auth + Save Soil Moisture Depths stores Kiwi soil depth JSON through the local edge endpoint
OK Auth + Save Soil Moisture Depths marks Kiwi soil depths as configured through the local edge endpoint
OK put-dendro-format returns the resulting device version from local dendrometer flag writes
OK put-temp-format returns the resulting device version from local temperature flag writes
OK put-rain-gauge-resp-fn returns the resulting device version from rain-gauge flag writes
OK put-flow-meter-resp-fn returns the resulting device version from flow-meter flag writes
OK dendro-ref-tree-fn returns the resulting device version from reference-tree writes
OK put-chameleon-enabled-auth-fn returns the resulting device version from Chameleon flag writes
OK bf93cd55db0eb57f returns the resulting device version from Chameleon depth writes
OK post-devices-response returns the resulting device version from local name and claim writes
OK assign-device-response returns the resulting device version from local assignment writes
OK unassign-device-response returns the resulting device version from local unassignment writes
OK Auth + Save Soil Moisture Depths removed soil-depth error forwarding into the tab-wide HTTP catch path
OK Build UPDATE SQL accepts synced STREGA interval commands on the gateway
OK Build UPDATE SQL accepts synced STREGA model updates on the gateway
OK Build UPDATE SQL accepts synced STREGA timed actions on the gateway
OK Build UPDATE SQL accepts synced STREGA magnet mode commands on the gateway
OK Build UPDATE SQL accepts synced STREGA partial opening commands on the gateway
OK Build UPDATE SQL accepts synced STREGA flushing commands on the gateway
OK Build Schedule ACK skips duplicate generic ACKs for direct LSN50 interrupt-mode downlinks
OK Build Schedule ACK skips duplicate generic ACKs for direct LSN50 5V warm-up downlinks
OK Build Schedule ACK skips duplicate generic ACKs for direct STREGA timed downlinks
OK Build Schedule ACK skips duplicate generic ACKs for direct STREGA magnet downlinks
OK Build Schedule ACK skips duplicate generic ACKs for direct STREGA partial-opening downlinks
OK Build Schedule ACK skips duplicate generic ACKs for direct STREGA flushing downlinks
OK Sync Init Schema + Triggers adds LSN50 mode columns to device_data
OK Sync Init Schema + Triggers adds the device-level legacy dendrometer override
OK Sync Init Schema + Triggers adds the device-level dendrometer stroke calibration
OK Sync Init Schema + Triggers adds the device-level dendrometer ratio zero calibration
OK Sync Init Schema + Triggers adds the device-level dendrometer ratio span calibration
OK Sync Init Schema + Triggers adds the canonical retracted-ratio dendrometer calibration column
OK Sync Init Schema + Triggers adds the canonical extended-ratio dendrometer calibration column
OK Sync Init Schema + Triggers preserves canonical dendrometer ratio columns when rebuilding the devices table
OK Sync Init Schema + Triggers copies canonical dendrometer ratios through the devices table rebuild
OK Sync Init Schema + Triggers adds a persisted edge baseline for comparable stem-change signals
OK Sync Init Schema + Triggers tracks which conversion path the stem-change baseline was captured with
OK Sync Init Schema + Triggers tracks calibration changes that should reset the stem-change baseline
OK Sync Init Schema + Triggers adds a persisted pending-baseline flag on devices
OK Sync Init Schema + Triggers preserves the pending-baseline flag when rebuilding the devices table
OK Sync Init Schema + Triggers adds the device-level dendrometer inversion flag
OK Sync Init Schema + Triggers backfills canonical retracted-ratio calibration from legacy dendrometer fields
OK Sync Init Schema + Triggers backfills canonical extended-ratio calibration from legacy dendrometer fields
OK Sync Init Schema + Triggers adds CH1 dendrometer telemetry storage
OK Sync Init Schema + Triggers adds ratio dendrometer telemetry storage
OK Sync Init Schema + Triggers adds dendrometer path storage
OK Sync Init Schema + Triggers adds baseline-relative stem-change storage to device_data
OK Sync Init Schema + Triggers adds STREGA battery percentage storage
OK Sync Init Schema + Triggers adds backward-compatible CH0 storage to dendrometer_readings
OK Sync Init Schema + Triggers adds CH1 storage to dendrometer_readings
OK Sync Init Schema + Triggers adds ratio storage to dendrometer_readings
OK Sync Init Schema + Triggers adds path metadata storage to dendrometer_readings
OK Auth + Parse LSN50 Mode validates supported LSN50 modes on the local API
OK Auth + Parse LSN50 Interval validates LSN50 uplink interval minutes on the local API
OK Auth + Parse LSN50 Interrupt validates LSN50 interrupt-mode values on the local API
OK Auth + Parse LSN50 5V Warmup validates LSN50 5V warm-up values on the local API
OK Auth + Parse Kiwi Interval validates Kiwi uplink interval minutes on the local API
OK Auth + Parse Kiwi Temp/Humidity builds the Kiwi ambient temperature and humidity enable payload
OK Auth + Parse Kiwi Temp/Humidity removed default Kiwi temp/humidity 15-minute fallback
OK Auth + Parse Kiwi Temp/Humidity removed implicit Kiwi temp/humidity interval default
OK Auth + Parse STREGA Interval validates STREGA uplink interval minutes on the local API
OK Auth + Parse STREGA Interval validates opened-box STREGA interval minutes on the local API
OK Auth + Parse STREGA Model validates STREGA model selection on the local API
OK Auth + Parse STREGA Timed Action validates STREGA timed actions on the local API
OK Auth + Parse STREGA Magnet validates STREGA magnet mode changes on the local API
OK Auth + Parse STREGA Partial Opening validates STREGA partial opening on the local API
OK Auth + Parse STREGA Flushing validates STREGA flushing on the local API
OK Auth + Parse Dendro Config parses the explicit legacy dendrometer override
OK Auth + Parse Dendro Config parses dendrometer stroke calibration
OK Auth + Parse Dendro Config parses dendrometer retracted-ratio calibration
OK Auth + Parse Dendro Config parses dendrometer extended-ratio calibration
OK Auth + Parse Dendro Config accepts canonical retracted-ratio config fields
OK Auth + Parse Dendro Config accepts canonical extended-ratio config fields
OK Auth + Parse Dendro Config keeps compatibility with legacy ratio-zero config fields
OK Auth + Parse Dendro Config keeps compatibility with legacy ratio-span config fields
OK Auth + Parse Dendro Config rejects empty dendrometer config updates
OK Authorize + Fanout LSN50 Mode fans out validated local LSN50 mode changes into the shared command path
OK Authorize + Fanout LSN50 Interval fans out validated local LSN50 interval changes into the shared command path
OK Authorize + Fanout LSN50 Advanced fans out validated local LSN50 interrupt-mode changes into the shared command path
OK Authorize + Fanout LSN50 Advanced fans out validated local LSN50 5V warm-up changes into the shared command path
OK Authorize + Fanout Kiwi Interval fans out validated local Kiwi interval changes into the shared command path
OK Authorize + Fanout Kiwi Temp/Humidity fans out validated local Kiwi ambient sensor enable changes into the shared command path
OK Authorize + Fanout STREGA Interval fans out validated local STREGA interval changes into the shared actuator path
OK Authorize + Fanout STREGA Interval fans out validated STREGA tamper flags into the shared actuator path
OK Authorize + Fanout STREGA Advanced fans out validated local STREGA timed actions into the shared actuator path
OK Authorize + Fanout STREGA Advanced fans out validated local STREGA magnet commands into the shared actuator path
OK Authorize + Fanout STREGA Advanced fans out validated local STREGA partial opening into the shared actuator path
OK Authorize + Fanout STREGA Advanced fans out validated local STREGA flushing into the shared actuator path
OK Authorize + Fanout STREGA Advanced gates motorized-only STREGA partial opening locally
OK Authorize + Fanout STREGA Advanced gates motorized-only STREGA flushing locally
OK Authorize + Fanout LSN50 Mode removed local LSN50 mode last-seen mutation
OK Authorize + Fanout LSN50 Interval removed local LSN50 interval last-seen mutation
OK Authorize + Fanout Kiwi Interval removed local Kiwi interval last-seen mutation
OK Authorize + Fanout Kiwi Temp/Humidity removed local Kiwi temp/humidity last-seen mutation
OK Authorize + Fanout STREGA Interval removed local STREGA interval last-seen mutation
OK Format LSN50 Mode Response returns explicit confirmation-waiting state from the local API
OK Format LSN50 Interval Response returns queued state from the local LSN50 interval API
OK Format LSN50 Advanced Response returns queued state from the local LSN50 advanced APIs
OK Format Kiwi Interval Response returns queued state from the local Kiwi interval API
OK Format Kiwi Temp/Humidity Response returns queued state from the local Kiwi ambient enable API
OK Format STREGA Interval Response returns queued state from the local STREGA interval API
OK Format STREGA Interval Response returns tamper status from the local STREGA interval API
OK Format STREGA Advanced Response returns immediate confirmation from the local STREGA model API
OK Format STREGA Advanced Response returns queued state from the local STREGA downlink APIs
OK Build LSN50 mode downlink builds Dragino interval downlinks
OK Build LSN50 mode downlink builds Dragino interrupt-mode downlinks
OK Build LSN50 mode downlink builds Dragino 5V warm-up downlinks
OK Build LSN50 mode downlink builds Kiwi interval downlinks
OK Build LSN50 mode downlink builds Kiwi ambient temperature and humidity enable downlinks
OK Build LSN50 mode downlink encodes Dragino TDC interval bytes
OK Build LSN50 mode downlink encodes Dragino interrupt-mode bytes
OK Build LSN50 mode downlink encodes Dragino 5V warm-up bytes
OK Build LSN50 mode downlink encodes Kiwi interval register writes
OK Build LSN50 mode downlink encodes Kiwi ambient temperature and humidity enable bytes
OK Build STREGA downlink + emit log ctx supports STREGA interval downlinks
OK Build STREGA downlink + emit log ctx encodes STREGA interval bytes with tamper control on FPort 11
OK Build STREGA downlink + emit log ctx supports STREGA timed-action downlinks
OK Build STREGA downlink + emit log ctx supports STREGA magnet-mode downlinks
OK Build STREGA downlink + emit log ctx supports STREGA partial-opening downlinks
OK Build STREGA downlink + emit log ctx supports STREGA flushing downlinks
OK Build STREGA downlink + emit log ctx includes the actual STREGA valve DevEUI in direct command ACK payloads
OK Build STREGA downlink + emit log ctx includes the gateway transport identity in direct STREGA command ACK payloads
OK Build Status + ACK includes the actual STREGA valve DevEUI in cloud status payloads
OK Build Status + ACK includes the gateway transport identity in cloud status payloads
OK Build Status + ACK defaults manual STREGA valve ACK payloads to the cloud command type
OK Cancel STREGA Actuation uses shared ChirpStack helper configuration
OK Cancel STREGA Actuation flushes the ChirpStack device queue
OK Cancel STREGA Actuation marks active actuation expectations CANCELLED
OK Cancel STREGA Actuation updates only the latest active expectation
OK Cancel STREGA Actuation removed bare CLOSE downlink emission from cancel path
OK Cancel STREGA Actuation removed actuator fanout from cancel path
OK System Stats uses findFanControl helper for dual-path fan discovery
OK System Stats tries hwmon path first
OK System Stats identifies pwmfan hwmon device by name
OK System Stats falls back to raw PWM sysfs when hwmon absent
OK System Stats fan defaults to unavailable when neither path found
OK node-red.init uses the shared gateway identity helper
OK node-red.init heals and persists canonical gateway identity through the shared helper
OK node-red.init logs the exact gateway identity heal failure
OK node-red.init resolves the best available identity after a heal failure
OK node-red.init removed direct best-effort concentratord repair during startup
OK node-red.init removed direct best-effort identity persistence during startup
OK node-red.init defines a startup helper to canonicalize gateway identities before exporting them
OK node-red.init normalizes the runtime gateway identity to uppercase before using it for MQTT credentials
OK node-red.init normalizes the linked gateway identity to uppercase before exporting it
OK node-red.init exports the derived gateway EUI into the Node-RED runtime environment
OK node-red.init exports gateway identity confidence into the Node-RED runtime environment
OK node-red.init exports the linked gateway identity into the Node-RED runtime environment
OK node-red.init exports the private-target override into the Node-RED runtime environment
OK 96_osi_server_config uses the shared gateway identity helper for first-boot seeding
OK 96_osi_server_config resolves the canonical gateway identity during UCI seeding
OK 96_osi_server_config persists canonical gateway identity during UCI seeding
OK 96_osi_server_config stores the identity source in UCI
OK 96_osi_server_config stores the identity confidence in UCI
OK 96_osi_server_config initializes linked gateway identity metadata in UCI
OK 96_osi_server_config defaults the private-target override to disabled
OK chirpstack-bootstrap.js uses the shared gateway identity helper during one-shot bootstrap detection
OK chirpstack-bootstrap.js reads gateway identity via the shared helper during one-shot bootstrap detection
OK chirpstack-bootstrap.js removed persisting a stale gateway identity into .chirpstack.env when Node-RED already injects the canonical runtime value
OK chirpstack-bootstrap.js protects runtime gateway identity keys from env-file overrides
OK chirpstack-bootstrap.js protects DEVICE_EUI from env-file overrides
OK chirpstack-bootstrap.js protects DEVICE_EUI_SOURCE from env-file overrides
OK chirpstack-bootstrap.js protects DEVICE_EUI_CONFIDENCE from env-file overrides
OK chirpstack-bootstrap.js protects DEVICE_EUI_LAST_VERIFIED_AT from env-file overrides
OK chirpstack-bootstrap.js protects LINK_GATEWAY_DEVICE_EUI from env-file overrides
OK chirpstack-bootstrap.js keeps init-provided identity env values when the env file is stale
OK chirpstack-bootstrap.js allows overriding the LSN50 decoder path during bootstrap
OK chirpstack-bootstrap.js allows overriding the STREGA decoder path during bootstrap
OK chirpstack-bootstrap.js tracks the shipped STREGA decoder path in bootstrap config
OK chirpstack-bootstrap.js loads the shipped STREGA decoder during bootstrap
OK chirpstack-bootstrap.js creates or repairs the OSI STREGA profile with a payload codec
OK chirpstack-bootstrap.js tracks the shipped LSN50 decoder path in bootstrap config
OK chirpstack-bootstrap.js loads the shipped LSN50 decoder during bootstrap
OK chirpstack-bootstrap.js creates or repairs the OSI LSN50 profile with a payload codec
OK chirpstack-bootstrap.js allows overriding the LoRain profile name during bootstrap
OK chirpstack-bootstrap.js allows overriding the LoRain decoder path during bootstrap
OK chirpstack-bootstrap.js tracks the shipped LoRain decoder path in bootstrap config
OK chirpstack-bootstrap.js loads the shipped LoRain decoder during bootstrap
OK chirpstack-bootstrap.js creates or repairs the OSI LoRain profile with a payload codec
OK chirpstack-bootstrap.js writes the LoRain ChirpStack profile ID for Node-RED
OK chirpstack-bootstrap.js persists the LoRain profile ID to UCI
OK chirpstack-bootstrap.js closes the provisioning client in a finally after both success and provisioning failure
OK chirpstack-bootstrap.js closes the sole ChirpStack provisioning client during bootstrap cleanup
OK deploy.sh runs communication validation before deploy artifacts are copied
OK deploy.sh uses the focused communication contract verifier during deploy preflight
OK deploy.sh fetches the required communication diagnostic during deploy preflight
OK deploy.sh prints a clear deploy preflight section
OK deploy.sh deploys the Node-RED init script to live devices
OK deploy.sh deploys the shared gateway identity helper to live devices
OK deploy.sh deploys the osi-dendro-helper package manifest to live devices
OK deploy.sh deploys the osi-dendro-helper runtime helper to live devices
OK deploy.sh deploys the osi-history-helper package manifest to live devices
OK deploy.sh deploys the osi-history-helper runtime helper to live devices
OK deploy.sh deploys the shipped STREGA ChirpStack decoder to live devices
OK deploy.sh deploys the shipped LSN50 ChirpStack decoder to live devices
OK deploy.sh deploys the shipped LoRain ChirpStack decoder to live devices
OK deploy.sh removes stale hashed GUI assets AND locale files before extracting the rebuilt React bundle (loop covers assets/, locales/, index.html, dotfiles)
OK deploy.sh keeps the deployed Node-RED init script executable
OK deploy.sh defines the deploy-time schema migration runner
OK deploy.sh provisions sqlite3-cli before running migrations
OK deploy.sh verifies Node-RED has stopped before migrating
OK deploy.sh removed inline dendrometer retracted-ratio deploy repair
OK deploy.sh removed inline dendrometer extended-ratio deploy repair
OK deploy.sh removed inline dendrometer retracted-ratio deploy backfill
OK deploy.sh removed inline dendrometer extended-ratio deploy backfill
OK deploy.sh stops the retired gateway GPS sidecar during deploy
OK deploy.sh disables the retired gateway GPS sidecar during deploy
OK deploy.sh removes the retired gateway GPS sidecar files during deploy
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_ratio_at_retracted in the bundled devices schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_ratio_at_extended in the bundled devices schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_force_legacy in the bundled devices schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_baseline_pending in the bundled devices schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes device_mode in the bundled devices schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes adc_ch1v in the bundled device_data schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_ratio in the bundled device_data schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_mode_used in the bundled device_data schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_stem_change_um in the bundled device_data schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_position_raw_mm in the bundled device_data schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_saturated in the bundled device_data schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_saturation_side in the bundled device_data schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes the bundled applied_commands replay ledger schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes the bundled command_ack_outbox schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes dendro_ratio_at_retracted in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes dendro_ratio_at_extended in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes dendro_force_legacy in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes dendro_baseline_pending in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes device_mode in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes adc_ch1v in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes dendro_ratio in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes dendro_mode_used in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes dendro_stem_change_um in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes dendro_position_raw_mm in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes dendro_saturated in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes dendro_saturation_side in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes the bundled applied_commands replay ledger schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes the bundled command_ack_outbox schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes dendro_ratio_at_retracted in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes dendro_ratio_at_extended in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes dendro_force_legacy in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes dendro_baseline_pending in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes device_mode in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes adc_ch1v in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes dendro_ratio in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes dendro_mode_used in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes dendro_stem_change_um in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes dendro_position_raw_mm in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes dendro_saturated in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes dendro_saturation_side in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes the bundled applied_commands replay ledger schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes the bundled command_ack_outbox schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_ratio_at_retracted in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_ratio_at_extended in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_force_legacy in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_baseline_pending in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes device_mode in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes adc_ch1v in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_ratio in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_mode_used in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_stem_change_um in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_position_raw_mm in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_saturated in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_saturation_side in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes the bundled applied_commands replay ledger schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes the bundled command_ack_outbox schema
OK database/farming.db includes dendro_ratio_at_retracted in the bundled devices schema
OK database/farming.db includes dendro_ratio_at_extended in the bundled devices schema
OK database/farming.db includes dendro_force_legacy in the bundled devices schema
OK database/farming.db includes dendro_baseline_pending in the bundled devices schema
OK database/farming.db includes device_mode in the bundled devices schema
OK database/farming.db includes adc_ch1v in the bundled device_data schema
OK database/farming.db includes dendro_ratio in the bundled device_data schema
OK database/farming.db includes dendro_mode_used in the bundled device_data schema
OK database/farming.db includes dendro_stem_change_um in the bundled device_data schema
OK database/farming.db includes dendro_position_raw_mm in the bundled device_data schema
OK database/farming.db includes dendro_saturated in the bundled device_data schema
OK database/farming.db includes dendro_saturation_side in the bundled device_data schema
OK database/farming.db includes the bundled applied_commands replay ledger schema
OK database/farming.db includes the bundled command_ack_outbox schema
OK web/react-gui/farming.db includes dendro_ratio_at_retracted in the bundled devices schema
OK web/react-gui/farming.db includes dendro_ratio_at_extended in the bundled devices schema
OK web/react-gui/farming.db includes dendro_force_legacy in the bundled devices schema
OK web/react-gui/farming.db includes dendro_baseline_pending in the bundled devices schema
OK web/react-gui/farming.db includes device_mode in the bundled devices schema
OK web/react-gui/farming.db includes adc_ch1v in the bundled device_data schema
OK web/react-gui/farming.db includes dendro_ratio in the bundled device_data schema
OK web/react-gui/farming.db includes dendro_mode_used in the bundled device_data schema
OK web/react-gui/farming.db includes dendro_stem_change_um in the bundled device_data schema
OK web/react-gui/farming.db includes dendro_position_raw_mm in the bundled device_data schema
OK web/react-gui/farming.db includes dendro_saturated in the bundled device_data schema
OK web/react-gui/farming.db includes dendro_saturation_side in the bundled device_data schema
OK web/react-gui/farming.db includes the bundled applied_commands replay ledger schema
OK web/react-gui/farming.db includes the bundled command_ack_outbox schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes bat_pct in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes bat_pct in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes bat_pct in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes bat_pct in the bundled device_data schema
OK database/farming.db includes bat_pct in the bundled device_data schema
OK web/react-gui/farming.db includes bat_pct in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes adc_ch0v in the bundled dendrometer_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes adc_ch1v in the bundled dendrometer_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_ratio in the bundled dendrometer_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_mode_used in the bundled dendrometer_readings schema
OK database/farming.db includes adc_ch0v in the bundled dendrometer_readings schema
OK database/farming.db includes adc_ch1v in the bundled dendrometer_readings schema
OK database/farming.db includes dendro_ratio in the bundled dendrometer_readings schema
OK database/farming.db includes dendro_mode_used in the bundled dendrometer_readings schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes chameleon_enabled in the bundled devices schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes chameleon_swt1_depth_cm in the bundled devices schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes swt_1 in the bundled device_data schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes data_invalid in the bundled chameleon_readings schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes payload_b64 in the bundled chameleon_readings schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes r1_ohm_comp in the bundled chameleon_readings schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes f_cnt in the bundled chameleon_readings schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes idx_chameleon_readings_deveui_time
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes idx_chameleon_readings_array_id
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes chameleon_enabled in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes chameleon_swt1_depth_cm in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes swt_1 in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes data_invalid in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes payload_b64 in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes r1_ohm_comp in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes f_cnt in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes idx_chameleon_readings_deveui_time
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes idx_chameleon_readings_array_id
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes chameleon_enabled in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes chameleon_swt1_depth_cm in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes swt_1 in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes data_invalid in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes payload_b64 in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes r1_ohm_comp in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes f_cnt in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes idx_chameleon_readings_deveui_time
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes idx_chameleon_readings_array_id
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes chameleon_enabled in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes chameleon_swt1_depth_cm in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes swt_1 in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes data_invalid in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes payload_b64 in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes r1_ohm_comp in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes f_cnt in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes idx_chameleon_readings_deveui_time
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes idx_chameleon_readings_array_id
OK database/farming.db includes chameleon_enabled in the bundled devices schema
OK database/farming.db includes chameleon_swt1_depth_cm in the bundled devices schema
OK database/farming.db includes swt_1 in the bundled device_data schema
OK database/farming.db includes data_invalid in the bundled chameleon_readings schema
OK database/farming.db includes payload_b64 in the bundled chameleon_readings schema
OK database/farming.db includes r1_ohm_comp in the bundled chameleon_readings schema
OK database/farming.db includes f_cnt in the bundled chameleon_readings schema
OK database/farming.db includes idx_chameleon_readings_deveui_time
OK database/farming.db includes idx_chameleon_readings_array_id
OK web/react-gui/farming.db includes chameleon_enabled in the bundled devices schema
OK web/react-gui/farming.db includes chameleon_swt1_depth_cm in the bundled devices schema
OK web/react-gui/farming.db includes swt_1 in the bundled device_data schema
OK web/react-gui/farming.db includes data_invalid in the bundled chameleon_readings schema
OK web/react-gui/farming.db includes payload_b64 in the bundled chameleon_readings schema
OK web/react-gui/farming.db includes r1_ohm_comp in the bundled chameleon_readings schema
OK web/react-gui/farming.db includes f_cnt in the bundled chameleon_readings schema
OK web/react-gui/farming.db includes idx_chameleon_readings_deveui_time
OK web/react-gui/farming.db includes idx_chameleon_readings_array_id
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes applied_commands.attempt_count for WS3 retry
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes applied_commands.last_error for WS3 retry
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes applied_commands.last_ack_attempt_at for WS3 ACK outbox
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes applied_commands.expires_at for WS3 expiry
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes command_ack_outbox table for WS3 ACK flush
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes command_ack_outbox.delivered_at for selective delivery tracking
OK database/farming.db includes applied_commands.attempt_count for WS3 retry
OK database/farming.db includes applied_commands.last_error for WS3 retry
OK database/farming.db includes applied_commands.last_ack_attempt_at for WS3 ACK outbox
OK database/farming.db includes applied_commands.expires_at for WS3 expiry
OK database/farming.db includes command_ack_outbox table for WS3 ACK flush
OK database/farming.db includes command_ack_outbox.delivered_at for selective delivery tracking
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes irrigation_schedules table
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes sync_outbox.rejected_at (WS2)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes sync_outbox.rejection_reason (WS2)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes sync_outbox.last_retryable_failure_at (WS2)
OK database/farming.db includes irrigation_schedules table
OK database/farming.db includes sync_outbox.rejected_at (WS2)
OK database/farming.db includes sync_outbox.rejection_reason (WS2)
OK database/farming.db includes sync_outbox.last_retryable_failure_at (WS2)
OK 96_osi_server_config 96_osi_server_config seeds firmware_version 0.7.0
OK node-red.init node-red.init fallback version is 0.7.0
OK flows.json heartbeat fallback version is 0.7.0
OK 97_osi_db_seed uci-defaults script present
OK 97_osi_db_seed 97_osi_db_seed seeds from /usr/share/db/farming.db
OK 97_osi_db_seed 97_osi_db_seed seeds to /data/db/farming.db
OK 97_osi_db_seed 97_osi_db_seed skips seed when target DB exists
OK 97_osi_db_seed removed 97_osi_db_seed must not force-overwrite existing DB
OK 98_osi_node_red_seed uci-defaults script present
OK 98_osi_node_red_seed seeds Node-RED package manifest before runtime startup
OK 98_osi_node_red_seed seeds Node-RED package lock before runtime startup
OK 98_osi_node_red_seed seeds local helper package directories for file dependencies
OK 98_osi_node_red_seed seeds local helper packages into runtime node_modules
OK 98_osi_node_red_seed replaces stale helper copies in both package locations
OK 98_osi_node_red_seed seeds the history helper package directory
OK install-osi-os.sh present
OK database/seed-blank.sql present
OK seed-blank.sql seed-blank.sql defines irrigation_schedules table
OK seed-blank.sql seed-blank.sql includes sync_outbox.rejected_at (WS2)
OK seed-blank.sql seed-blank.sql includes applied_commands table (WS3)
OK seed-blank.sql seed-blank.sql includes chameleon_readings table
OK seed-blank.sql seed-blank.sql includes valve_actuation_expectations table (WS1)
OK osi-gateway-identity.sh defines the shared canonical gateway resolver
OK osi-gateway-identity.sh derives the active concentratord chipset before probing static gateway identifiers
OK osi-gateway-identity.sh reads the active concentratord chipset from UCI
OK osi-gateway-identity.sh limits static UCI gateway-id probing to the active chipset
OK osi-gateway-identity.sh limits TOML gateway-id probing to the active chipset
OK osi-gateway-identity.sh defines startup self-healing for active concentratord gateway-id state
OK osi-gateway-identity.sh defines the exact resolve-repair-resolve-persist heal order
OK osi-gateway-identity.sh dispatches the heal command and emits the resolved shell fields
OK gateway identity helper focused test
OK osi-gateway-identity.sh marks live ChirpStack-derived gateway identities as authoritative
OK osi-gateway-identity.sh marks previously verified gateway identities as persisted
OK osi-gateway-identity.sh marks MAC-derived gateway identities as provisional
OK osi-gateway-identity.sh uses an explicit hex-only uppercase conversion that works on BusyBox
OK osi-gateway-identity.sh runs gateway detection in a non-login shell so banner output cannot poison detection
OK osi-gateway-identity.sh prefers runtime concentratord gateway identity when available
OK osi-gateway-identity.sh downgrades MAC-derived concentratord IDs away from authoritative confidence
OK osi-gateway-identity.sh falls back across known interfaces for provisional MAC-derived identity
OK osi-gateway-identity.sh removed hard-coded sx1302 fallback outside active-chipset-aware resolution
OK osi-gateway-identity.sh removed hard-coded sx1301 fallback outside active-chipset-aware resolution
OK osi-gateway-identity.sh removed blank-chipset TOML fallback outside active-chipset-aware resolution
OK 99_set_sx1301_gateway_id uses the shared gateway identity helper for first-boot concentratord seeding
OK 99_set_sx1301_gateway_id seeds only the active LoRa concentratord section
OK 99_set_sx1301_gateway_id keeps a single MAC-derived fallback path for first-boot concentratord seeding
OK 99_set_sx1301_gateway_id removed hard-coded sx1302 seeding outside active-chipset-aware logic
OK 99_set_sx1301_gateway_id removed hard-coded sx1301 seeding outside active-chipset-aware logic
OK bcm2712 ships rootfs grow uci-default
OK bcm2709 ships rootfs grow uci-default
OK bcm2712 ships rootfs resize init
OK bcm2709 ships rootfs resize init
OK 90_osi_rootfs_grow uses parted for in-place partition growth
OK 90_osi_rootfs_grow does not re-partition while filesystem resize is pending
OK 90_osi_rootfs_grow grows the root partition to the end of the disk
OK osi-rootfs-resize runs filesystem resize before Node-RED startup
OK osi-rootfs-resize grows the mounted filesystem after reboot
OK full_raspberrypi_bcm27xx_bcm2712 full_raspberrypi_bcm27xx_bcm2712 includes parted for rootfs grow
OK full_raspberrypi_bcm27xx_bcm2712 full_raspberrypi_bcm27xx_bcm2712 includes resize2fs for rootfs grow
OK full_raspberrypi_bcm27xx_bcm2712 full_raspberrypi_bcm27xx_bcm2712 includes kmod-hwmon-pwmfan for fan thermal control
OK full_raspberrypi_bcm27xx_bcm2709 full_raspberrypi_bcm27xx_bcm2709 includes parted for rootfs grow
OK full_raspberrypi_bcm27xx_bcm2709 full_raspberrypi_bcm27xx_bcm2709 includes resize2fs for rootfs grow
OK boot-config.patch boot config enables Pi 5 cooling fan hardware (rp1_pwm1 + cooling_fan DT nodes)
OK osi-bootstrap init script present
OK chirpstack init START priority
OK node-red init START priority
OK osi-bootstrap init START priority
OK OpenWrt START/name startup order for first-boot provisioning
OK overlay chirpstack-bootstrap.js present
OK overlay chirpstack-bootstrap.js matches scripts/chirpstack-bootstrap.js byte-for-byte
OK osi-bootstrap init script defines stamp validity check
OK osi-bootstrap init script uses the canonical stamp file path
OK osi-bootstrap init script checks env file existence
OK osi-bootstrap init script validates env file contains valid app UUIDs
OK osi-bootstrap init script prefers the ROM bootstrap script
OK osi-bootstrap init script keeps the live-deploy bootstrap fallback
OK osi-bootstrap init script retries instead of marking done when bootstrap script is missing
OK osi-bootstrap removed missing-script success path
OK osi-bootstrap init script waits for ChirpStack gRPC via curl
OK osi-bootstrap init script retries gRPC health check up to 24 times
OK osi-bootstrap init script treats stamp write as part of successful provisioning
OK osi-bootstrap init script tracks successful first-boot provisioning
OK osi-bootstrap init script gates the restart request on successful provisioning
OK osi-bootstrap init script requests a coordinated restart after successful provisioning
OK osi-bootstrap removed direct Node-RED restart after provisioning
OK osi-bootstrap init script logs all events with the correct tag
OK osi-bootstrap does not set a shutdown priority (one-shot)
OK osi-bootstrap uci-defaults activation script present
OK 95_osi_bootstrap_enable activation script enables the osi-bootstrap init on first boot
OK sysupgrade.conf present
OK sysupgrade.conf sysupgrade.conf preserves the osi-bootstrap stamp file
OK removed insecure auth fallback osi-os-default-auth-secret
OK removed insecure auth fallback env.get('CHIRPSTACK_API_KEY')
OK package.json includes @chirpstack/chirpstack-api
OK package.json includes @grpc/grpc-js
OK package.json includes @rakwireless/field-tester-server
OK package.json includes bcryptjs
OK package.json includes node-red-node-sqlite
OK package.json includes osi-chirpstack-helper
OK package.json includes osi-db-helper
OK package.json includes osi-dendro-helper
OK package.json includes osi-history-helper
OK package.json includes sqlite3
OK osi-cloud-http helper exists
OK osi-cloud-http/index.js forces IPv4 DNS/address selection
OK osi-cloud-http/index.js exports requestJsonIpv4
OK osi-cloud-http/index.js sets a bounded cloud REST timeout
OK osi-cloud-http/index.js parses JSON responses
OK osi-cloud-http/index.js rejects aborted response streams
OK osi-cloud-http/index.js rejects response stream errors
OK osi-cloud-http/index.js rejects incomplete response stream closes
OK osi-cloud-http/index.js guards cloud REST requests against double settlement
OK osi-cloud-http/package.json declares the helper package name
OK node-red/package.json installs the helper package as a local dependency
OK node-red/package.json installs the history helper package as a local dependency
OK node-red/node_modules/osi-chameleon-helper is a tracked local-helper symlink
OK node-red/node_modules/osi-chirpstack-helper is a tracked local-helper symlink
OK node-red/node_modules/osi-cloud-http is a tracked local-helper symlink
OK node-red/node_modules/osi-db-helper is a tracked local-helper symlink
OK node-red/node_modules/osi-dendro-helper is a tracked local-helper symlink
OK node-red/node_modules/osi-history-helper is a tracked local-helper symlink
OK osi-chirpstack-helper/index.js adds profile reads so bootstrap can inspect existing ChirpStack codecs
OK osi-chirpstack-helper/index.js adds profile updates so bootstrap can repair codec-less ChirpStack profiles
OK osi-chirpstack-helper/index.js flushes device queues with the ChirpStack gRPC request type
OK osi-chirpstack-helper/index.js flushes device queues through DeviceService.FlushQueue
OK osi-chirpstack-helper/index.js removed REST device queue path
OK osi-chirpstack-helper/index.js removed REST device queue DELETE
OK osi-chirpstack-helper/index.js removed REST queue-flush error handling
OK osi-chirpstack-helper/index.js checks the aggregate ownership fence before compensation
OK osi-chirpstack-helper/index.js returns a non-enumerable guarded compensation boundary to registration callers
OK helper exports createClient
OK helper exports createProvisioningClientFromEnv
OK helper exports normalizeApiUrl
OK cs-register-device-fn declares the sole ChirpStack client outside the try block
OK cs-register-device-fn assigns the client inside the try block
OK cs-register-device-fn creates exactly one ChirpStack client: no second cleanup client
OK cs-register-device-fn removed the retired second cleanup client
OK cs-register-device-fn removed the retired deviceCreated field
OK cs-register-device-fn removed the retired numeric grpcStatus field
OK cs-register-device-fn removed the retired error.details field
OK cs-register-device-fn uses guarded helper compensation after any post-provisioning local save failure
OK cs-register-device-fn reads the new normalized error.code instead of numeric grpcStatus
OK cs-register-device-fn surfaces the full reconciliation result (deviceAction/keysAction/keysVerified/verifiedApplicationId/verifiedDeviceProfileId) as local registration evidence
OK cs-register-device-fn closes the ChirpStack client and the local DB in a single finally on every path, surfacing an unexpected close() throw via node.warn
OK cs-reg-cloud-fn declares the sole ChirpStack client outside the try block for REGISTER_DEVICE
OK cs-reg-cloud-fn assigns the client inside the try block
OK cs-reg-cloud-fn creates exactly one ChirpStack client: no second cleanup client
OK cs-reg-cloud-fn removed the retired deviceCreated field
OK cs-reg-cloud-fn removed the retired numeric grpcStatus field
OK cs-reg-cloud-fn removed the retired error.details field
OK cs-reg-cloud-fn uses guarded helper compensation after any post-provisioning local save failure
OK cs-reg-cloud-fn reads the new normalized error.code instead of numeric grpcStatus
OK cs-reg-cloud-fn preserves the exact success ACK shape (commit/ACK path unchanged)
OK cs-reg-cloud-fn closes the ChirpStack client and the local DB in a single finally on every REGISTER_DEVICE path, surfacing an unexpected close() throw via node.warn
OK cs-reg-cloud-ack-fn forwards the normalized error.code instead of the retired grpcStatus
OK cs-reg-cloud-ack-fn removed the retired grpcStatus field
OK post-devices-response forwards the whole reconciliation result (deviceAction/keysAction/keysVerified/verifiedApplicationId/verifiedDeviceProfileId) to API callers
OK post-devices-response removed the retired deviceCreated field
OK cancel-strega-actuation-fn declares the sole ChirpStack client outside the try block
OK cancel-strega-actuation-fn removed the client must be hoisted (not const-declared) so the finally can close it
OK cancel-strega-actuation-fn creates exactly one ChirpStack client: no second cleanup client
OK cancel-strega-actuation-fn closes both the ChirpStack client and the local DB in a single finally that runs on every path
OK cancel-strega-actuation-fn surfaces bounded close() cleanup failures via node.warn without leaking key/token sentinels
OK cancel-strega-actuation-fn surfaces an unexpected close() throw via a fixed, secret-free node.warn message
OK strega_gen1_decoder.js ships the STREGA ChirpStack decoder entry point
OK strega_gen1_decoder.js ships the vendor Gen1 STREGA decoder implementation
OK dragino_lsn50_decoder.js ships the LSN50 ChirpStack decoder entry point
OK dragino_lsn50_decoder.js ships the working MOD3 decoder path from the live LSN50 profile
OK dragino_lsn50_decoder.js ships the working LSN50 CH1 decoder logic
OK aquascope_lorain_decoder.js ships the LoRain ChirpStack decoder entry point
OK aquascope_lorain_decoder.js normalizes LoRain tips to millimeters
OK aquascope_lorain_decoder.js accepts current LoRain FPort 10 and legacy FPort 2 only
OK osi-db-helper/index.js exposes the helper-scoped transaction primitive
OK DB helper source present despite missing local runtime deps: Cannot find module 'sqlite3'
Require stack:
- /home/phil/Repos/osi-os-agrolink/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js
- /home/phil/Repos/osi-os-agrolink/scripts/verify-sync-flow.js
OK DB helper source includes Database
OK DB helper source includes getHealth
OK DB helper source includes quickCheck
OK osi-db-helper/index.js exposes the queued helper transaction primitive
OK history helper exports normalizeDeveui
OK history helper exports analysisSeriesId
OK history helper exports buildAnalysisCatalog
OK history helper exports resolveAnalysisSeries
OK history helper exports listAnalysisViews
OK history helper exports saveAnalysisView
OK history helper exports deriveCardId
OK history helper exports deriveCardsForZone
OK history helper exports deriveGatewayCard
OK history helper exports resolveAggregation
OK history helper exports classifySoilStatus
OK history helper exports classifyEnvironmentStatus
OK history helper exports classifyDendroStatus
OK history helper exports classifyIrrigationStatus
OK history helper exports classifyGatewayStatus
OK history helper exports deriveExpectedCadenceSeconds
OK history helper exports startOfLocalDayMs
OK history helper exports computeRollupBuckets
OK history helper exports upsertRollups
OK history helper exports runRollupJob
OK history helper exports resolveDeviceFieldRollupKey
OK history helper exports legacySensorHistory
OK history helper exports buildZoneExportCsv
OK history helper exports toCsv
OK history helper exports writeZoneCsv
OK history helper exports rotateZoneCsv
OK history helper exports aggregateRows
OK history helper exports aggregateDeviceData
OK history helper exports buildAdvancedMetadataPlaceholder
OK history helper exports buildCalendar
OK history helper exports buildLocalInterpretations
OK SQL-backed history helper tests pass
OK edge channel ids match canonical manifest
OK history-api-router-fn logs per-phase timing for history endpoint performance triage
OK history-api-router-fn defines a phase timing helper for single execution phases
OK history-api-router-fn defines a phase timing helper for repeated helper calls
OK history-api-router-fn formats phase timing in history API logs
OK history-api-router-fn tracks latest device row lookup timing
OK history-api-router-fn tracks latest Chameleon row lookup timing
OK history-api-router-fn tracks aggregation helper timing
OK history-api-router-fn defines a version marker for the history schema guard
OK history-api-router-fn caches the history schema guard version in Node-RED global context
OK history-api-router-fn stores the applied history schema guard version
OK history-api-router-fn uses deterministic time-first latest device row lookup
OK history-api-router-fn uses deterministic time-first latest Chameleon row lookup
OK history-api-router-fn removed latest device row MAX(id) lookup
OK history-api-router-fn removed latest Chameleon row MAX(id) lookup
OK osi-history-router/index.js uses the farmer-facing Soil Moisture card title
OK osi-history-router/index.js removed old Soil - Root Zone card title
OK osi-history-router/index.js centralizes soil channel depth lookup for history views
OK osi-history-router/index.js adds depth metadata to soil line series
OK dendro helper exports decodeRawAdcPayload
OK dendro helper exports detectDendroModeUsed
OK dendro helper exports calculateDendroRatio
OK dendro helper exports calculateRatioDendroPositionMm
OK dendro helper exports calculateRatioDendroPositionRawMm
OK dendro helper exports buildDendroDerivedMetrics
OK dendro helper exports computeDendroDeltaMm
OK dendro helper exports computeDendroStemChangeUm
OK dendro helper decodes ADC_CH0V from raw MOD3 payloads
OK dendro helper decodes ADC_CH1V from raw MOD3 payloads
OK dendro helper decodes ADC_CH4V from raw MOD3 payloads
OK dendro helper decodes MOD3 mode from raw payloads
OK dendro helper still decodes ADC_CH0V from legacy raw payloads
OK dendro helper ignores raw CH1 fallback data outside MOD3
OK dendro helper ignores raw CH4 fallback data outside MOD3
OK dendro helper preserves the observed legacy mode from raw payloads
OK legacy dendrometer path remains active outside MOD3
OK legacy dendrometer path does not expose a ratio
OK legacy dendrometer path preserves raw single-ADC conversion
OK legacy dendrometer path preserves single-ADC conversion
OK legacy dendrometer path is not flagged as saturated
OK legacy dendrometer path has no saturation side
OK MOD3 dendrometer path switches to ratio mode when CH0 and CH1 are valid
OK ratio dendrometer path exposes the raw ratio
OK ratio dendrometer path converts raw calibrated displacement
OK ratio dendrometer path converts calibrated displacement
OK in-range ratio dendrometer samples are not flagged as saturated
OK in-range ratio dendrometer samples have no saturation side
OK near-zero CH1 falls back to the legacy dendrometer path
OK near-zero CH1 does not leak a ratio through the legacy fallback
OK near-zero CH1 preserves legacy dendrometer comparability
OK below-range ratio samples preserve negative raw displacement
OK below-range ratio samples keep a clamped compatibility position
OK below-range ratio samples are flagged as saturated
OK below-range ratio samples report low-side saturation
OK above-range ratio samples preserve over-stroke raw displacement
OK above-range ratio samples keep a clamped compatibility position
OK above-range ratio samples are flagged as saturated
OK above-range ratio samples report high-side saturation
OK ratio mode still activates without calibration values
OK ratio mode still exposes raw ratios when calibration is missing
OK ratio mode does not synthesize raw displacement when calibration is missing
OK ratio mode does not synthesize calibrated displacement when calibration is missing
OK ratio mode flags missing calibration cleanly
OK dendrometer delta resets when the conversion path changes
OK dendrometer delta resets when calibration changes
OK the first valid calibrated dendrometer reading establishes a zero stem-change baseline
OK the first valid calibrated dendrometer reading becomes the persisted baseline position
OK stem change is reported in micrometers relative to the device baseline
OK stem change resets to zero when the conversion path changes
OK 062a0f9bf66d9789 heartbeat payload includes fan_available field
OK 062a0f9bf66d9789 heartbeat tries hwmon path first
OK 062a0f9bf66d9789 heartbeat falls back to raw PWM when hwmon absent
OK Fan Control uses findFanControl helper for dual-path fan discovery
OK Fan Control prefers hwmon sysfs when available
OK Fan Control sets hwmon fan control mode when driver is loaded
OK Fan Control speed=0 switches to thermal auto mode via hwmon
OK Fan Control falls back to raw PWM sysfs when hwmon absent
OK 934bf2bc19a8ce22 SET_FAN tries hwmon path first
OK 934bf2bc19a8ce22 SET_FAN sets hwmon fan control mode when driver is loaded
OK 934bf2bc19a8ce22 SET_FAN speed=0 switches to thermal auto mode via hwmon
OK 934bf2bc19a8ce22 SET_FAN falls back to raw PWM sysfs when hwmon absent
(node:3895857) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
OK sensor-data CSV export doubles raw quotes and quotes comma-containing fields
OK sensor-data CSV export neutralizes spreadsheet formulas
OK Kiwi legacy simulator payloads without deviceInfo are accepted
OK Kiwi legacy simulator input frequencies are mapped to Watermark readings
OK LSN50 object temperature is not overwritten by null raw decode temperature
OK LSN50_WRITER_DISABLE=1 returns only output 2 with stage forced_flag
OK LSN50_WRITER_DISABLE=1 never calls the writer
OK lsn50-fallback-marker-fn rejects an unknown/missing fallback stage without writing SQL
OK legacy dendrometer SQL keeps adc_v while adding CH0/CH1/ratio debug columns
OK legacy dendrometer SQL preserves adc_v and adc_ch0v semantics for historical rows
OK MOD3 dendrometer SQL persists CH1, ratio, and ratio-mode metadata
OK LoRain branch rejects non-LoRain profiles
OK LoRain SQL insert persists normalized rain telemetry
OK LoRain SQL insert includes battery, rain-rate values, and status
OK S2120 SQL insert persists normalized rain telemetry and interval length
OK S2120 SQL insert includes the computed rain-rate values and status
OK mock osiDb run forwards SQL to queryHandler.run
OK mock osiDb run rejects promise-style callers when queryHandler.run fails
OK STREGA telemetry fixture preserves the raw battery value
OK STREGA telemetry fixture preserves the normalized battery percent
OK STREGA telemetry fixture drops the sentinel ambient temperature
OK STREGA telemetry fixture drops the sentinel relative humidity
OK STREGA telemetry fixture preserves the valve state
OK mock osiDb run reports errors to callback-style callers
OK mock osiDb run does not reject callback-style callers after invoking the callback
OK LSN50 normalizer_load failure returns only output 2 with the exact stage/code
OK LSN50 normalizer_load failure calls node.error once with the fixed code
OK LSN50 normalizer_load failure reaches the shared Record Error counter exactly once
OK UC512 normalizer_load failure emits no success output
OK UC512 normalizer_load failure calls node.error once with the fixed code NORMALIZER_LOAD_FAILED
OK UC512 normalizer_load failure sets red node status
OK UC512 normalizer_load failure reaches the shared Record Error counter exactly once
OK field-test CSV export doubles raw quotes and quotes comma-containing fields
OK field-test CSV export neutralizes spreadsheet formulas
OK lsn50-fallback-marker-fn rejects a missing fallback stage without writing SQL
OK LoRain negative rain fixture marks invalid rain
OK LoRain negative rain fixture does not persist a negative rain delta
OK LoRain negative rain fixture does not emit a zone-rain update
OK STREGA process fixture preserves the raw battery value
OK STREGA process fixture preserves the normalized battery percent
OK STREGA process fixture drops the sentinel ambient temperature
OK STREGA process fixture drops the sentinel relative humidity
OK STREGA process fixture preserves the valve state
OK LSN50 success+close-failure calls the writer exactly once (no duplicate insert)
OK LSN50 success+close-failure preserves output 1 (the single inserted row) and never enters legacy fallback
OK LSN50 success+close-failure does not tag the message with a fallback stage
OK LSN50 success+close-failure calls node.error exactly once with the fixed DB_CLOSE_FAILED code
OK LSN50 success+close-failure reaches the shared Record Error counter exactly once
OK lsn50-fallback-marker-fn builds the literal writer_fallback insert with the uppercased deveui and stage
OK lsn50-fallback-marker-fn marks the fallback channel as __writer__
OK real LSN50 node assembly (mode 1, undefined inactive placeholders) produces zero ingest_quarantine rows
OK real LSN50 node assembly (mode 1, undefined inactive placeholders) returns only output 1
OK real LSN50 node assembly (mode 1, undefined inactive placeholders) inserts a device_data row
OK LoRain zone aggregate writes source aquascope_lorain
OK LoRain zone aggregate adds deltas while honoring device daily total
OK LSN50 writer_load failure returns only output 2 with the exact stage/code
OK LSN50 writer_load failure reaches the shared Record Error counter exactly once
OK UC512 writer_load failure emits no success output
OK UC512 writer_load failure calls node.error once with the fixed code WRITER_LOAD_FAILED
OK UC512 writer_load failure sets red node status
OK UC512 writer_load failure reaches the shared Record Error counter exactly once
OK LSN50_WRITER_DISABLE='0' is not truthy and still reaches the writer
OK LSN50_WRITER_DISABLE='0' returns only output 1
OK lsn50-fallback-evict-fn emits the writer-matching ingest_quarantine eviction cap (LIMIT 1000)
OK LoRain duplicate fixture skips duplicate timestamps
OK LoRain duplicate fixture does not emit a duplicate rain delta
OK LoRain duplicate fixture does not emit a zone-rain update
OK LSN50 manifest_load failure returns only output 2 with the exact stage/code
OK LSN50 manifest_load secret-sentinel error text never reaches the returned message or Node-RED logs
OK LSN50 manifest_load failure reaches the shared Record Error counter exactly once
OK UC512 identity_missing failure emits no success output
OK UC512 identity_missing failure calls node.error once with the fixed code IDENTITY_MISSING
OK UC512 identity_missing failure sets red node status
OK UC512 identity_missing failure reaches the shared Record Error counter exactly once
OK LSN50 writer-failure+close-failure retains the writer_run fallback stage exactly once
OK LSN50 writer-failure+close-failure calls node.error exactly twice (writer_run once, DB_CLOSE_FAILED once)
OK LSN50 writer-failure+close-failure records the writer error before the cleanup error, each with its own fixed code
OK real LSN50 node assembly (mode 1, null inactive placeholders) produces zero ingest_quarantine rows
OK real LSN50 node assembly (mode 1, null inactive placeholders) returns only output 1
OK real LSN50 node assembly (mode 1, null inactive placeholders) inserts a device_data row
OK LoRain first interval sample is valid rain
OK LoRain fixture preserves interval rain delta
OK LoRain fixture preserves tip count
OK LoRain first interval sample does not fabricate elapsed seconds
OK LoRain first interval sample does not fabricate a rate
OK LoRain fixture accumulates local-day rain totals
OK LoRain first interval sample emits zone-rain update
OK LoRain raw rainlevel fixture converts 0.5 mm steps to millimeters
OK LoRain raw rainlevel fixture uses raw rainlevel as tip count
OK LoRain normalized rain_mm_delta wins over disagreeing raw rainlevel fallback
OK LoRain disagreeing-source fixture still uses raw rainlevel as fallback tip count
OK LoRain interval fixture marks valid rain
OK LoRain interval fixture computes hourly rain rate
OK LoRain interval fixture computes normalized rain per 10 minutes
OK LoRain interval fixture stores elapsed seconds
OK LoRain interval fixture emits zone-rain update
OK S2120 fixture maps measurement 4113 to cumulative rain
OK S2120 fixture maps measurement 4213 to wind gust
OK S2120 fixture maps measurement 4103 to battery percent
OK S2120 fixture normalizes pressure to hPa
OK S2120 fixture marks the first rain sample without fabricating a delta
OK S2120 first-sample fixture leaves the normalized rain rate empty
OK S2120 first-sample fixture does not emit a zone-rain update
OK S2120 fixture marks increasing cumulative rain as valid
OK S2120 fixture computes rain deltas from cumulative rain
OK S2120 fixture computes hourly rain rate from elapsed time
OK S2120 fixture computes normalized rain per 10 minutes
OK S2120 fixture accumulates local-day rain totals
OK S2120 fixture stores the elapsed rain-counter interval in seconds
OK S2120 fixture emits valid rain deltas to the zone aggregation path
OK S2120 fixture skips duplicate timestamps
OK S2120 duplicate fixture does not emit a duplicate rain delta
OK S2120 duplicate fixture does not emit a zone-rain update
OK LSN50 normalize_run failure returns only output 2 with the exact stage/code
OK LSN50 normalize_run secret-sentinel error text never reaches the returned message or Node-RED logs
OK LSN50 normalize_run failure reaches the shared Record Error counter exactly once
OK UC512 manifest_load failure emits no success output
OK UC512 manifest_load failure calls node.error once with the fixed code MANIFEST_LOAD_FAILED
OK UC512 manifest_load failure sets red node status
OK UC512 manifest_load failure reaches the shared Record Error counter exactly once
OK LSN50 db_open failure returns only output 2 with the exact stage/code
OK LSN50 db_open secret-sentinel error text never reaches the returned message or Node-RED logs
OK LSN50 db_open failure reaches the shared Record Error counter exactly once
OK UC512 normalize_run failure emits no success output
OK UC512 normalize_run failure calls node.error once with the fixed code NORMALIZE_RUN_FAILED
OK UC512 normalize_run failure sets red node status
OK UC512 normalize_run failure reaches the shared Record Error counter exactly once
OK real LSN50 node assembly (mode 9, undefined inactive placeholders) produces zero ingest_quarantine rows
OK real LSN50 node assembly (mode 9, undefined inactive placeholders) returns only output 1
OK real LSN50 node assembly (mode 9, undefined inactive placeholders) inserts a device_data row
OK UC512 db_open failure emits no success output
OK UC512 db_open failure calls node.error once with the fixed code DB_OPEN_FAILED
OK UC512 db_open failure sets red node status
OK UC512 db_open failure reaches the shared Record Error counter exactly once
OK LSN50 writer_run rejection returns only output 2 (the original msg) with the exact stage/code
OK LSN50 writer_run rejection passes the original msg object to node.error
OK LSN50 writer_run secret-sentinel error text never reaches the returned message or Node-RED logs
OK LSN50 writer_run rejection reaches the shared Record Error counter exactly once
OK real LSN50 node assembly (mode 9, null inactive placeholders) produces zero ingest_quarantine rows
OK real LSN50 node assembly (mode 9, null inactive placeholders) returns only output 1
OK real LSN50 node assembly (mode 9, null inactive placeholders) inserts a device_data row
OK LSN50 writer_run secret-sentinel error text never reaches the fallback marker SQL
OK UC512 writer_run rejection reports the error instead of claiming success
OK UC512 writer_run rejection passes the original msg to node.error
OK UC512 writer_run secret-sentinel error text never reaches Node-RED logs
OK UC512 writer_run rejection reaches the shared Record Error counter exactly once
OK UC512 success+close-failure still returns the message (write itself succeeded)
OK UC512 db_close failure calls node.error once with the fixed DB_CLOSE_FAILED code
OK UC512 db_close failure reaches the shared Record Error counter exactly once
OK DB helper transaction commits inner queued writes
OK DB helper transaction surfaces a real fake DB operation failure
OK DB helper transaction rolls back writes after a fake DB operation failure
OK DB helper queue accepts a write queued before the failed transaction settled
OK DB helper preserves committed rows and excludes the failed write after queue recovery
OK LSN50 success path awaits the writer promise (flag observed set before the node returned)
OK LSN50 success path returns only output 1
Sync flow verification passed
OK openwrt/osi-os.config: build includes jsonfilter
OK jsonfilter Makefile: pinned OpenWrt source declares jsonfilter
OK jsonfilter Makefile: pins the reviewed jsonfilter source revision
OK jsonfilter Makefile: package installs /usr/bin/jsonfilter
OK procd Makefile: pins the reviewed procd rcS snapshot semantics
OK OpenWrt boot init: creates the daemon run directory before applying uci-defaults
OK OpenWrt boot init: retains a failed uci-default for the next boot
OK scripts/verify-sync-flow.js: sync verification chains the live identity verifier
OK scripts/test-identityd-service-lifecycle.sh: mode 755
OK Node-RED init: STOP=99
OK conf/full_raspberrypi_bcm27xx_bcm2712/.config: profile image includes jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service starts before Node-RED and bootstrap
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service stops before Node-RED STOP=99
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: STOP=98 precedes Node-RED STOP=99
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service uses procd
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service launches the identity daemon
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service is supervised with respawn
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service exposes one readiness contract
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: ready requires procd running and the daemon-owned live lock
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: defaults to a same-boot start
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: records whether rcS already queued the service before enabling it
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: uci-defaults enables the service and remains retryable on failure
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: starts the service on the same factory boot and verifies a fresh live lock owner with a bounded retry
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: checks the rcS snapshot, enables, starts conditionally, then verifies readiness
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: has exactly one enable and one conditional start call
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: has exactly one post-start readiness check
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap requests a coordinated restart
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap proves a live consumer immediately before publishing its restart request
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap removes its stamp when restart coordination fails
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap logs restart-request retry behavior
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap does not restart Node-RED directly
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon parses JSON with jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon owns the lock-readiness predicate
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: readiness requires the atomic symlink lock and its canonical live PID owner
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon CLI exposes readiness
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon validates nullable JSON field types with jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon bounds shell arithmetic inputs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon reads a monotonic clock
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: sentinel carries a monotonic deadline
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: queued delay begins when the daemon consumes the request
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: restart countdown uses the monotonic deadline
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: restart eligibility uses the monotonic clock
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: cache and request readers each reject non-canonical JSON
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: sentinel reader rejects non-canonical JSON
OK conf/full_raspberrypi_bcm27xx_bcm2709/.config: profile image includes jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service starts before Node-RED and bootstrap
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service stops before Node-RED STOP=99
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: STOP=98 precedes Node-RED STOP=99
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service uses procd
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service launches the identity daemon
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service is supervised with respawn
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service exposes one readiness contract
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: ready requires procd running and the daemon-owned live lock
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: defaults to a same-boot start
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: records whether rcS already queued the service before enabling it
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: uci-defaults enables the service and remains retryable on failure
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: starts the service on the same factory boot and verifies a fresh live lock owner with a bounded retry
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: checks the rcS snapshot, enables, starts conditionally, then verifies readiness
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: has exactly one enable and one conditional start call
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: has exactly one post-start readiness check
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: bootstrap requests a coordinated restart
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: bootstrap proves a live consumer immediately before publishing its restart request
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: bootstrap removes its stamp when restart coordination fails
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: bootstrap logs restart-request retry behavior
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: bootstrap does not restart Node-RED directly
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon parses JSON with jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon owns the lock-readiness predicate
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: readiness requires the atomic symlink lock and its canonical live PID owner
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon CLI exposes readiness
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon validates nullable JSON field types with jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon bounds shell arithmetic inputs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon reads a monotonic clock
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: sentinel carries a monotonic deadline
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: queued delay begins when the daemon consumes the request
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: restart countdown uses the monotonic deadline
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: restart eligibility uses the monotonic clock
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: cache and request readers each reject non-canonical JSON
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: sentinel reader rejects non-canonical JSON
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: byte-identical mirror
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: byte-identical mirror
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: byte-identical mirror
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: byte-identical mirror
OK scripts/verify-profile-parity.js: CANONICAL_PAYLOAD includes files/usr/libexec/osi-identityd.sh
OK scripts/verify-profile-parity.js: CANONICAL_PAYLOAD includes files/etc/init.d/osi-identityd
OK scripts/verify-profile-parity.js: CANONICAL_PAYLOAD includes files/etc/uci-defaults/94_osi_identityd_enable
OK deploy.sh: fetches the identity daemon
OK deploy.sh: installs the identity daemon
OK deploy.sh: marks the identity daemon executable
OK deploy.sh: fetches the identity service
OK deploy.sh: installs the identity service
OK deploy.sh: marks the identity service executable
OK deploy.sh: fetches the service enable script
OK deploy.sh: installs the service enable script
OK deploy.sh: marks the service enable script executable
OK deploy.sh: fetches the coordinated bootstrap service
OK deploy.sh: installs the coordinated bootstrap service
OK deploy.sh: marks the bootstrap service executable
OK deploy.sh: uses the installed identityd service through the lifecycle fence
OK deploy.sh: enables identityd during live deploy
OK deploy.sh: starts a fresh identityd during live deploy
OK deploy.sh: checks the shared readiness contract during live deploy
OK deploy.sh: does not restart an unquiesced identityd instance
OK deploy.sh: identityd activation follows gateway identity helper installation
OK deploy.sh: identityd activation follows identity daemon installation
OK deploy.sh: identityd activation follows flows payload staging
OK deploy.sh: identityd activation follows flows payload activation
OK deploy.sh: identityd activation follows GUI extraction
OK deploy.sh: uses a bounded shared readiness loop
OK deploy.sh: treats broken symlink locks as present
OK deploy.sh: waits for both procd absence and lock absence
OK deploy.sh: never deletes the daemon ownership lock
OK deploy.sh: preserves queued restart requests while quiesced
OK deploy.sh: preserves the restart sentinel while quiesced
OK deploy.sh: installs restoration and proves quiescence before the sole migration call
OK deploy.sh: has one lifecycle-fenced migration call
OK deploy.sh: catastrophic migration failure explicitly holds both services stopped
OK deploy.sh: EXIT restoration handles Node-RED before identityd and preserves failure status
OK deploy.sh: uses one EXIT cleanup path with signal-specific exit status
OK deploy.sh: final activation starts only after the quiescence gap and waits for readiness
OK deploy.sh: final readiness follows identityd enable/start
OK deploy.sh: disarms restoration only after final readiness succeeds
OK deploy.sh: preserves the missing-DB sidecar guard
OK deploy.sh: retains the direct Node-RED restart immediately after the live payload flip and its existing log
OK deploy.sh: retains the rollback restart
OK deploy.sh: only payload flip and rollback directly restart Node-RED
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json: flow document is an array
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: preserves its absent libs property
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not use require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: restartState reads are allowlisted to reason and restartAt
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field phase
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field restartAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field restartNotBeforeUptime
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field targetDeviceEui
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field target_device_eui
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field requestedAt
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field confidence
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field version
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: missing restart sentinel returns restartPending null
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: valid restart sentinel exposes only restartAt and reason
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: unauthenticated stats omit private and internal sentinel fields
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: missing sentinel reason uses the reviewed public fallback
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: no-deadline healing state exposes a blocked public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: an expired pending deadline remains visible until daemon cleanup
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: invalid JSON exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: array shape exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: non-string deadline exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: unreadable restart sentinel exposes an unreadable public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: hwmon directory failure keeps the fan fallback and warns with context
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: fan probe failures retain the fallback and warn for each probed path
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: expected ENOENT and ENOTDIR fan absence stays quiet with the existing fallback
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: a persistent unexpected fan failure warns once per path and signature
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: a changed unexpected fan failure warns again
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: successful fan-probe recovery resets warning deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: remembered fan failure signatures are bounded
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: successful hwmon listing prunes disappeared children and keeps current deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: disappeared hwmon path warns when it recurs while the current path remains deduplicated
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: hwmon hotplug churn keeps the complete failure map at or below 32 entries
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: successful hwmon listing prunes disappeared children and retains identical current deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: a pruned hwmon path warns when it recurs while the retained path stays deduplicated
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: an evicted hwmon path warns when it recurs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: failure-map cap still applies when hwmon listing cannot prune stale children
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json: only system stats and the seven identity gates read the restart sentinel
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: selects the outer error source from the caught error marker, not stale flow state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: drops command ACK work while restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: exposes the boolean restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: clears the password and returns the second/error output with status 503
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: uses the approved fs global
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: publishes into the daemon request directory
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: publishes the exact three-field request contract
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: requires the Node-RED message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: bounds filesystem error detail returned to the operator
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: measures the UTF-8 message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: bounds the filename key before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: encodes msg._msgid into a path-safe deterministic key
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: keys the deterministic final path by the safe message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: uses a unique temporary suffix for retry-safe publication
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: publishes atomically through a unique temporary file
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: reports the scheduled restart
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: has separate success and error outputs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: failure reaches only the HTTP response
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: keeps libs empty
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: does not use /etc/init.d/node-red
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: creates the private request directory with mode 0700
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: writes one temporary file and renames it once
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: hostile msg._msgid is deterministically encoded inside the request directory
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: unique temporary path is renamed to the deterministic final path
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: temporary request uses mode 0600 and exclusive creation
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: final JSON has exactly reason, delaySeconds, and requestedAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: successful publication uses only the success output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: distinct msg._msgid values produce distinct final paths
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: retries keep a deterministic final path and use a fresh temporary suffix
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: missing msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: empty msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: missing fs fails through only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: mkdir failure stops before publication and uses only the bounded error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: ENOSPC fails closed, cleans up, and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: rename failure cleans up and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: very long msg._msgid fails before filename construction
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: uses the approved fs global
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: publishes into the daemon request directory
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: publishes the exact three-field request contract
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: requires the Node-RED message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: bounds filesystem error detail returned to the operator
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: measures the UTF-8 message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: bounds the filename key before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: encodes msg._msgid into a path-safe deterministic key
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: keys the deterministic final path by the safe message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: uses a unique temporary suffix for retry-safe publication
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: publishes atomically through a unique temporary file
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: reports the scheduled restart
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: has separate success and error outputs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: failure reaches only the HTTP response
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: keeps libs empty
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: does not use /etc/init.d/node-red
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: creates the private request directory with mode 0700
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: writes one temporary file and renames it once
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: hostile msg._msgid is deterministically encoded inside the request directory
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: unique temporary path is renamed to the deterministic final path
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: temporary request uses mode 0600 and exclusive creation
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: final JSON has exactly reason, delaySeconds, and requestedAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: successful publication uses only the success output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: distinct msg._msgid values produce distinct final paths
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: retries keep a deterministic final path and use a fresh temporary suffix
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: missing msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: empty msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: missing fs fails through only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: mkdir failure stops before publication and uses only the bounded error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: ENOSPC fails closed, cleans up, and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: rename failure cleans up and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: very long msg._msgid fails before filename construction
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-validate: protected function is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-init-fn: protected function is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json: flow document is an array
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: preserves its absent libs property
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not use require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: restartState reads are allowlisted to reason and restartAt
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field phase
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field restartAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field restartNotBeforeUptime
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field targetDeviceEui
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field target_device_eui
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field requestedAt
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field confidence
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field version
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: missing restart sentinel returns restartPending null
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: valid restart sentinel exposes only restartAt and reason
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: unauthenticated stats omit private and internal sentinel fields
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: missing sentinel reason uses the reviewed public fallback
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: no-deadline healing state exposes a blocked public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: an expired pending deadline remains visible until daemon cleanup
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: invalid JSON exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: array shape exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: non-string deadline exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: unreadable restart sentinel exposes an unreadable public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: hwmon directory failure keeps the fan fallback and warns with context
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: fan probe failures retain the fallback and warn for each probed path
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: expected ENOENT and ENOTDIR fan absence stays quiet with the existing fallback
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: a persistent unexpected fan failure warns once per path and signature
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: a changed unexpected fan failure warns again
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: successful fan-probe recovery resets warning deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: remembered fan failure signatures are bounded
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: successful hwmon listing prunes disappeared children and keeps current deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: disappeared hwmon path warns when it recurs while the current path remains deduplicated
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: hwmon hotplug churn keeps the complete failure map at or below 32 entries
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: successful hwmon listing prunes disappeared children and retains identical current deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: a pruned hwmon path warns when it recurs while the retained path stays deduplicated
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: an evicted hwmon path warns when it recurs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: failure-map cap still applies when hwmon listing cannot prune stale children
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json: only system stats and the seven identity gates read the restart sentinel
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: selects the outer error source from the caught error marker, not stale flow state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: drops command ACK work while restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: exposes the boolean restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: clears the password and returns the second/error output with status 503
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: uses the approved fs global
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: publishes into the daemon request directory
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: publishes the exact three-field request contract
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: requires the Node-RED message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: bounds filesystem error detail returned to the operator
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: measures the UTF-8 message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: bounds the filename key before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: encodes msg._msgid into a path-safe deterministic key
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: keys the deterministic final path by the safe message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: uses a unique temporary suffix for retry-safe publication
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: publishes atomically through a unique temporary file
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: reports the scheduled restart
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: has separate success and error outputs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: failure reaches only the HTTP response
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: keeps libs empty
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: does not use /etc/init.d/node-red
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: creates the private request directory with mode 0700
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: writes one temporary file and renames it once
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: hostile msg._msgid is deterministically encoded inside the request directory
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: unique temporary path is renamed to the deterministic final path
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: temporary request uses mode 0600 and exclusive creation
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: final JSON has exactly reason, delaySeconds, and requestedAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: successful publication uses only the success output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: distinct msg._msgid values produce distinct final paths
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: retries keep a deterministic final path and use a fresh temporary suffix
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: missing msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: empty msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: missing fs fails through only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: mkdir failure stops before publication and uses only the bounded error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: ENOSPC fails closed, cleans up, and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: rename failure cleans up and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: very long msg._msgid fails before filename construction
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: uses the approved fs global
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: publishes into the daemon request directory
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: publishes the exact three-field request contract
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: requires the Node-RED message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: bounds filesystem error detail returned to the operator
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: measures the UTF-8 message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: bounds the filename key before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: encodes msg._msgid into a path-safe deterministic key
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: keys the deterministic final path by the safe message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: uses a unique temporary suffix for retry-safe publication
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: publishes atomically through a unique temporary file
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: reports the scheduled restart
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: has separate success and error outputs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: failure reaches only the HTTP response
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: keeps libs empty
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: does not use /etc/init.d/node-red
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: creates the private request directory with mode 0700
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: writes one temporary file and renames it once
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: hostile msg._msgid is deterministically encoded inside the request directory
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: unique temporary path is renamed to the deterministic final path
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: temporary request uses mode 0600 and exclusive creation
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: final JSON has exactly reason, delaySeconds, and requestedAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: successful publication uses only the success output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: distinct msg._msgid values produce distinct final paths
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: retries keep a deterministic final path and use a fresh temporary suffix
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: missing msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: empty msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: missing fs fails through only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: mkdir failure stops before publication and uses only the bounded error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: ENOSPC fails closed, cleans up, and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: rename failure cleans up and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: very long msg._msgid fails before filename construction
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-validate: protected function is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-init-fn: protected function is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json: byte-identical flow mirror
OK silent-catch baseline records 164 for both maintained profiles
OK silent-catch baseline: records the PR #149 compensation cleanup
OK silent-catch baseline: records the scoped-access auth cleanup
OK silent-catch baseline: records the scoped-access shared-read cleanup
OK size allowance sync-bootstrap-build: owned entry present
OK size allowance sync-bootstrap-build: declares Task 4 growth
OK size allowance sync-outbox-build: owned entry present
OK size allowance sync-outbox-build: declares Task 4 growth
OK size allowance sync-pending-build: owned entry present
OK size allowance sync-pending-build: declares Task 4 growth
OK size allowance sync-force-build: owned entry present
OK size allowance sync-force-build: declares Task 4 growth
OK size allowance command-ack-build-batch: owned entry present
OK size allowance command-ack-build-batch: declares Task 4 growth
OK size allowance sync-state-build: owned entry present
OK size allowance sync-state-build: declares Task 4 growth
OK size allowance al-link-build-req: owned entry present
OK size allowance al-link-build-req: declares Task 4 growth
OK size allowance al-link-restart-node-red: owned entry present
OK size allowance al-link-restart-node-red: declares Task 4 growth
OK size allowance al-unlink-restart-node-red: owned entry present
OK size allowance al-unlink-restart-node-red: declares Task 4 growth
OK size allowance sys-stats-fn: owned entry present
OK size allowance sys-stats-fn: declares Task 5 growth
OK scripts/test-identityd-service-lifecycle.sh: --- Quiesce gateway identity supervisor before schema migration ---
OK
--- Restore gateway identity supervisor after interrupted deploy ---
OK
--- Quiesce gateway identity supervisor before schema migration ---
OK
--- Restore gateway identity supervisor after interrupted deploy ---
OK: identityd restored to stopped state
--- Quiesce gateway identity supervisor before schema migration ---
OK
--- Quiesce gateway identity supervisor before schema migration ---
--- Quiesce gateway identity supervisor before schema migration ---
OK
--- Restore gateway identity supervisor after interrupted deploy ---
OK
--- Quiesce gateway identity supervisor before schema migration ---
OK
--- Restore gateway identity supervisor after interrupted deploy ---
PASS: identityd deploy lifecycle and readiness
Live gateway identity verification passed.

=== conf/full_raspberrypi_bcm27xx_bcm2709 ===
OK:   files/etc/board.d/02_network
OK:   files/etc/config
OK:   files/etc/init.d/osi-rootfs-resize
OK:   files/etc/init.d/osi-bootstrap
OK:   files/etc/init.d/osi-identityd
OK:   files/etc/nginx
OK:   files/etc/redis.conf
OK:   files/etc/sysupgrade.conf
OK:   files/etc/uci-defaults/90_osi_rootfs_grow
OK:   files/etc/uci-defaults/94_osi_identityd_enable
OK:   files/etc/uci-defaults/95_osi_bootstrap_enable
OK:   files/etc/uci-defaults/96_osi_server_config
OK:   files/etc/uci-defaults/97_osi_db_seed
OK:   files/etc/uci-defaults/98_osi_node_red_seed
OK:   files/etc/uci-defaults/99_config_chirpstack_ap
OK:   files/etc/uci-defaults/99_set_hostname
OK:   files/etc/uci-defaults/99_set_sx1301_gateway_id
OK:   files/etc/uci-defaults/99_tailscale_init
OK:   files/usr/libexec/osi-gateway-identity.sh
OK:   files/usr/libexec/osi-identityd.sh
OK:   files/usr/share/db
OK:   files/usr/share/flows.json
OK:   files/usr/share/node-red
OK:   absent: files/etc/uci-defaults/01_update_rc_local_20241118
OK:   absent: files/etc/uci-defaults/99_set_chirpstack_mqtt_forwarder_global_config
OK:   absent: files/etc/uci-defaults/99_set_chirpstack_udp_forwarder_global_config
OK:   absent: files/usr/share/schema.sql
OK:   absent: files/usr/share/sensor_data.db

All parity checks passed.

$ node scripts/verify-scoped-access.js
verify-scoped-access: OK (ratchet only; behavioral matrix is the correctness gate)

$ node scripts/test-scoped-access-command-path.js
(node:3898725) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
TAP version 13
# Subtest: scoped user apply is atomic, replayable, and invalidates the scope cache
ok 1 - scoped user apply is atomic, replayable, and invalidates the scope cache
  ---
  duration_ms: 17.773101
  type: 'test'
  ...
# Subtest: stale base and last-admin mutation return terminal conflicts without changing rows
ok 2 - stale base and last-admin mutation return terminal conflicts without changing rows
  ---
  duration_ms: 3.6969
  type: 'test'
  ...
# Subtest: grant lifecycle applies and tombstones with exact version checks
ok 3 - grant lifecycle applies and tombstones with exact version checks
  ---
  duration_ms: 3.618818
  type: 'test'
  ...
# Subtest: credential ACK and ledger result never contain the password hash
ok 4 - credential ACK and ledger result never contain the password hash
  ---
  duration_ms: 3.279041
  type: 'test'
  ...
# Subtest: malformed effect binding fails closed before mutation
ok 5 - malformed effect binding fails closed before mutation
  ---
  duration_ms: 3.126438
  type: 'test'
  ...
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 39.385859

$ node scripts/test-scoped-access-reads.js
(node:3898735) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
TAP version 13
# Subtest: immutable token subject prevents /api/me from following a reused username
ok 1 - immutable token subject prevents /api/me from following a reused username
  ---
  duration_ms: 50.933672
  type: 'test'
  ...
# Subtest: immutable token subject blocks username reuse across scoped shared reads
ok 2 - immutable token subject blocks username reuse across scoped shared reads
  ---
  duration_ms: 133.123904
  type: 'test'
  ...
# Subtest: immutable token subject blocks username reuse in sensor export and history
ok 3 - immutable token subject blocks username reuse in sensor export and history
  ---
  duration_ms: 67.745899
  type: 'test'
  ...
# Subtest: F2: a researcher can read a granted zone environment summary
ok 4 - F2: a researcher can read a granted zone environment summary
  ---
  duration_ms: 52.364926
  type: 'test'
  ...
# Subtest: F2: a viewer receives 404 for a foreign zone environment summary
ok 5 - F2: a viewer receives 404 for a foreign zone environment summary
  ---
  duration_ms: 42.52005
  type: 'test'
  ...
# Subtest: F2: recommendations honor granted-zone reads and hide foreign zones
ok 6 - F2: recommendations honor granted-zone reads and hide foreign zones
  ---
  duration_ms: 69.95679
  type: 'test'
  ...
# Subtest: F1: scoped lists use owned-plus-granted zones and keep weather shared
ok 7 - F1: scoped lists use owned-plus-granted zones and keep weather shared
  ---
  duration_ms: 42.223784
  type: 'test'
  ...
# Subtest: F1: admin has no scope bypass and flag-off behavior remains owner-only
ok 8 - F1: admin has no scope bypass and flag-off behavior remains owner-only
  ---
  duration_ms: 41.331983
  type: 'test'
  ...
# Subtest: E4: a disabled account is denied before the weather-device OR-branch can be reached
ok 9 - E4: a disabled account is denied before the weather-device OR-branch can be reached
  ---
  duration_ms: 36.909712
  type: 'test'
  ...
# Subtest: F3: device reads allow grants and shared weather, and hide foreign devices
ok 10 - F3: device reads allow grants and shared weather, and hide foreign devices
  ---
  duration_ms: 112.671487
  type: 'test'
  ...
# Subtest: F3: scoped today-liters hides a foreign valve
ok 11 - F3: scoped today-liters hides a foreign valve
  ---
  duration_ms: 37.09521
  type: 'test'
  ...
# Subtest: F3: sensor export filters scoped rows and keeps flag-off behavior
ok 12 - F3: sensor export filters scoped rows and keeps flag-off behavior
  ---
  duration_ms: 69.354341
  type: 'test'
  ...
# Subtest: F3: today-liters remains callable without auth while the flag is off
ok 13 - F3: today-liters remains callable without auth while the flag is off
  ---
  duration_ms: 37.228607
  type: 'test'
  ...
# Subtest: F4: history zone reads allow owned and granted zones but hide foreign zones
ok 14 - F4: history zone reads allow owned and granted zones but hide foreign zones
  ---
  duration_ms: 109.677398
  type: 'test'
  ...
# Subtest: F4: account-wide history export contains only visible zones
ok 15 - F4: account-wide history export contains only visible zones
  ---
  duration_ms: 40.689584
  type: 'test'
  ...
# Subtest: F4b: gateway history is admin-only while scoped access is enabled
ok 16 - F4b: gateway history is admin-only while scoped access is enabled
  ---
  duration_ms: 72.736048
  type: 'test'
  ...
# Subtest: F4b: workspace rows remain owner-only in scoped mode
ok 17 - F4b: workspace rows remain owner-only in scoped mode
  ---
  duration_ms: 35.927745
  type: 'test'
  ...
# Subtest: F4: flag-off history behavior remains owner-only
ok 18 - F4: flag-off history behavior remains owner-only
  ---
  duration_ms: 37.535209
  type: 'test'
  ...
# Subtest: F6: every diagnostic and gateway read rejects non-admin accounts
ok 19 - F6: every diagnostic and gateway read rejects non-admin accounts
  ---
  duration_ms: 326.603049
  type: 'test'
  ...
# Subtest: F6: every diagnostic and gateway read rejects a disabled admin
ok 20 - F6: every diagnostic and gateway read rejects a disabled admin
  ---
  duration_ms: 324.940271
  type: 'test'
  ...
# Subtest: F6: enabled admins pass every route guard
ok 21 - F6: enabled admins pass every route guard
  ---
  duration_ms: 317.894488
  type: 'test'
  ...
# Subtest: F6: database download remains disabled after the admin guard
ok 22 - F6: database download remains disabled after the admin guard
  ---
  duration_ms: 32.768342
  type: 'test'
  ...
# Subtest: F7: catalog is available to every enabled authenticated role
ok 23 - F7: catalog is available to every enabled authenticated role
  ---
  duration_ms: 41.191602
  type: 'test'
  ...
# Subtest: F7: analysis channels include grants and exclude foreign zones
ok 24 - F7: analysis channels include grants and exclude foreign zones
  ---
  duration_ms: 45.805098
  type: 'test'
  ...
# Subtest: F7: analysis series cannot resolve a selector from a foreign zone
ok 25 - F7: analysis series cannot resolve a selector from a foreign zone
  ---
  duration_ms: 42.243269
  type: 'test'
  ...
# Subtest: F7: analysis views remain per-user and drop foreign selectors
ok 26 - F7: analysis views remain per-user and drop foreign selectors
  ---
  duration_ms: 45.876335
  type: 'test'
  ...
# Subtest: F7: analysis view deletion cannot cross user ownership
ok 27 - F7: analysis view deletion cannot cross user ownership
  ---
  duration_ms: 43.330207
  type: 'test'
  ...
# Subtest: F7: recent actuations use owned-plus-granted zone visibility
ok 28 - F7: recent actuations use owned-plus-granted zone visibility
  ---
  duration_ms: 34.960236
  type: 'test'
  ...
# Subtest: F6: flag-off field-test and system-stat routes remain unauthenticated
ok 29 - F6: flag-off field-test and system-stat routes remain unauthenticated
  ---
  duration_ms: 71.393701
  type: 'test'
  ...
1..29
# tests 29
# suites 0
# pass 29
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2436.733524

$ node scripts/test-scoped-access-writes.js
(node:3898805) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
TAP version 13
# Subtest: W1: valve boundary allows in-scope researchers and records the actor
ok 1 - W1: valve boundary allows in-scope researchers and records the actor
  ---
  duration_ms: 44.125977
  type: 'test'
  ...
# Subtest: W1: valve boundary hides foreign devices and rejects viewers or disabled users
ok 2 - W1: valve boundary hides foreign devices and rejects viewers or disabled users
  ---
  duration_ms: 44.684426
  type: 'test'
  ...
# Subtest: W1: enqueue rechecks fresh scope and records applied-command originator
ok 3 - W1: enqueue rechecks fresh scope and records applied-command originator
  ---
  duration_ms: 34.135971
  type: 'test'
  ...
# Subtest: W1: revocation immediately stops enqueue before physical effect
ok 4 - W1: revocation immediately stops enqueue before physical effect
  ---
  duration_ms: 35.002002
  type: 'test'
  ...
# Subtest: R4: a role-denied actor (real zone access, non-mutating role) also gets a terminal ack
ok 5 - R4: a role-denied actor (real zone access, non-mutating role) also gets a terminal ack
  ---
  duration_ms: 33.789559
  type: 'test'
  ...
# Subtest: X1: a transient scope-helper infra error is not treated as a scope decision
ok 6 - X1: a transient scope-helper infra error is not treated as a scope decision
  ---
  duration_ms: 32.476406
  type: 'test'
  ...
# Subtest: X2: a granted researcher actuates a timed STREGA action with the actor propagated
ok 7 - X2: a granted researcher actuates a timed STREGA action with the actor propagated
  ---
  duration_ms: 45.639225
  type: 'test'
  ...
# Subtest: X2: a revoked claimer is HTTP-denied with no actuator message
ok 8 - X2: a revoked claimer is HTTP-denied with no actuator message
  ---
  duration_ms: 34.153501
  type: 'test'
  ...
# Subtest: X2: a viewer-role owner is HTTP-denied with no actuator message
ok 9 - X2: a viewer-role owner is HTTP-denied with no actuator message
  ---
  duration_ms: 36.774569
  type: 'test'
  ...
# Subtest: X2: flag-off preserves the legacy bearer-only behavior
ok 10 - X2: flag-off preserves the legacy bearer-only behavior
  ---
  duration_ms: 42.092203
  type: 'test'
  ...
# Subtest: X2: the actor comes only from the verified bearer identity, never from the request body
ok 11 - X2: the actor comes only from the verified bearer identity, never from the request body
  ---
  duration_ms: 43.159515
  type: 'test'
  ...
# Subtest: E3: a scoped physical command without an actor is rejected fail-closed and never actuates
ok 12 - E3: a scoped physical command without an actor is rejected fail-closed and never actuates
  ---
  duration_ms: 36.306773
  type: 'test'
  ...
# Subtest: E3: a scoped actor with view-only zone access cannot actuate a valve
ok 13 - E3: a scoped actor with view-only zone access cannot actuate a valve
  ---
  duration_ms: 35.595791
  type: 'test'
  ...
# Subtest: E3: flag-off preserves the legacy no-actor-required behavior
ok 14 - E3: flag-off preserves the legacy no-actor-required behavior
  ---
  duration_ms: 34.331526
  type: 'test'
  ...
# Subtest: R3: an actor-less, duration-less command is rejected by the actor gate, not passed through
ok 15 - R3: an actor-less, duration-less command is rejected by the actor gate, not passed through
  ---
  duration_ms: 34.600205
  type: 'test'
  ...
# Subtest: R3: an authorized actor with an invalid/missing duration is rejected under scope, not passed through
ok 16 - R3: an authorized actor with an invalid/missing duration is rejected under scope, not passed through
  ---
  duration_ms: 33.479534
  type: 'test'
  ...
# Subtest: R3: flag-off keeps the legacy invalid-duration pass-through behavior
ok 17 - R3: flag-off keeps the legacy invalid-duration pass-through behavior
  ---
  duration_ms: 32.467886
  type: 'test'
  ...
# Subtest: R1: a cloud command with actor_user_uuid only in the payload crosses Route Command intact and enforces scope
ok 18 - R1: a cloud command with actor_user_uuid only in the payload crosses Route Command intact and enforces scope
  ---
  duration_ms: 61.144375
  type: 'test'
  ...
# Subtest: R2: a genuine scheduler dispatch (real message-level marker) actuates under scope with no actor
ok 19 - R2: a genuine scheduler dispatch (real message-level marker) actuates under scope with no actor
  ---
  duration_ms: 38.266096
  type: 'test'
  ...
# Subtest: R2: a payload/body-embedded system-actuation claim is never honored, only the true message-level flag
ok 20 - R2: a payload/body-embedded system-actuation claim is never honored, only the true message-level flag
  ---
  duration_ms: 33.73655
  type: 'test'
  ...
# Subtest: W2: schedule mutation allows grants, hides foreign zones, and rejects viewers
ok 21 - W2: schedule mutation allows grants, hides foreign zones, and rejects viewers
  ---
  duration_ms: 48.908558
  type: 'test'
  ...
# Subtest: W2: disable-all updates only researcher scope and rejects viewers
ok 22 - W2: disable-all updates only researcher scope and rejects viewers
  ---
  duration_ms: 42.741306
  type: 'test'
  ...
# Subtest: E8: disable-all scopes an admin to owned-plus-granted zones like every other write surface
ok 23 - E8: disable-all scopes an admin to owned-plus-granted zones like every other write surface
  ---
  duration_ms: 38.698343
  type: 'test'
  ...
# Subtest: W2: scheduler query counts enabled scope holders and disables an empty zone
ok 24 - W2: scheduler query counts enabled scope holders and disables an empty zone
  ---
  duration_ms: 37.588847
  type: 'test'
  ...
# Subtest: W3: scoped zone creation atomically grants the creator
ok 25 - W3: scoped zone creation atomically grants the creator
  ---
  duration_ms: 42.467319
  type: 'test'
  ...
# Subtest: W3: sole-scope-holder delete tombstones grants and preserves detached plots
ok 26 - W3: sole-scope-holder delete tombstones grants and preserves detached plots
  ---
  duration_ms: 34.582325
  type: 'test'
  ...
# Subtest: W3: researcher cannot delete a multi-holder zone; admin can
ok 27 - W3: researcher cannot delete a multi-holder zone; admin can
  ---
  duration_ms: 41.793632
  type: 'test'
  ...
# Subtest: W4: scoped claims require an accessible target zone except for admins
ok 28 - W4: scoped claims require an accessible target zone except for admins
  ---
  duration_ms: 57.623544
  type: 'test'
  ...
# Subtest: W4: a foreign existing device is hidden before claim or reassignment
ok 29 - W4: a foreign existing device is hidden before claim or reassignment
  ---
  duration_ms: 42.063917
  type: 'test'
  ...
# Subtest: W4: assignment and removal fresh-check both the device and zone
ok 30 - W4: assignment and removal fresh-check both the device and zone
  ---
  duration_ms: 44.78409
  type: 'test'
  ...
# Subtest: W4: device delete and weather-zone replacement enforce fresh scope
ok 31 - W4: device delete and weather-zone replacement enforce fresh scope
  ---
  duration_ms: 50.910415
  type: 'test'
  ...
# Subtest: W5: every device-config route fresh-checks write scope
ok 32 - W5: every device-config route fresh-checks write scope
  ---
  duration_ms: 446.691873
  type: 'test'
  ...
# Subtest: W5: flag-off device-config routing preserves each legacy branch
ok 33 - W5: flag-off device-config routing preserves each legacy branch
  ---
  duration_ms: 145.478451
  type: 'test'
  ...
# Subtest: W7: every zone-config route fresh-checks scope and records the actor
ok 34 - W7: every zone-config route fresh-checks scope and records the actor
  ---
  duration_ms: 98.972708
  type: 'test'
  ...
# Subtest: W7: a grantee reaches the legacy zone write as the resource owner
ok 35 - W7: a grantee reaches the legacy zone write as the resource owner
  ---
  duration_ms: 41.434229
  type: 'test'
  ...
# Subtest: W8: admin account CRUD omits hashes and protects the last enabled admin
ok 36 - W8: admin account CRUD omits hashes and protects the last enabled admin
  ---
  duration_ms: 207.616246
  type: 'test'
  ...
# Subtest: W8: serialized admin disable attempts leave at least one enabled admin
ok 37 - W8: serialized admin disable attempts leave at least one enabled admin
  ---
  duration_ms: 115.626325
  type: 'test'
  ...
# Subtest: W8: zone and plot grants invalidate into the next resolved scope
ok 38 - W8: zone and plot grants invalidate into the next resolved scope
  ---
  duration_ms: 58.80358
  type: 'test'
  ...
# Subtest: E7: a missing zone_uuid on a grant POST is a 400, not a stringified-undefined 404
ok 39 - E7: a missing zone_uuid on a grant POST is a 400, not a stringified-undefined 404
  ---
  duration_ms: 48.870914
  type: 'test'
  ...
# Subtest: W8: every account and grant endpoint rejects non-admins
ok 40 - W8: every account and grant endpoint rejects non-admins
  ---
  duration_ms: 84.231688
  type: 'test'
  ...
# Subtest: W9: every system write allows only a fresh enabled admin
ok 41 - W9: every system write allows only a fresh enabled admin
  ---
  duration_ms: 176.37554
  type: 'test'
  ...
# Subtest: W9: flag-off system writes preserve every legacy branch
ok 42 - W9: flag-off system writes preserve every legacy branch
  ---
  duration_ms: 61.635568
  type: 'test'
  ...
# Subtest: W10: local irrigation config writes version only their own aggregate
ok 43 - W10: local irrigation config writes version only their own aggregate
  ---
  duration_ms: 11.366924
  type: 'test'
  ...
# Subtest: E6: an unrecognized role fails closed on every mutation gate while reads stay scope-governed
ok 44 - E6: an unrecognized role fails closed on every mutation gate while reads stay scope-governed
  ---
  duration_ms: 271.559714
  type: 'test'
  ...
1..44
# tests 44
# suites 0
# pass 44
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3046.49438

$ (cd conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize && node --test)
TAP version 13
# Subtest: parseSdi12Values: strict grammar
ok 1 - parseSdi12Values: strict grammar
  ---
  duration_ms: 1.478956
  type: 'test'
  ...
# Subtest: transforms: pf_to_kpa and hpa_to_kpa with swt clamp
ok 2 - transforms: pf_to_kpa and hpa_to_kpa with swt clamp
  ---
  duration_ms: 0.405008
  type: 'test'
  ...
# Subtest: exact cardinality rejects the frame atomically
ok 3 - exact cardinality rejects the frame atomically
  ---
  duration_ms: 0.22426
  type: 'test'
  ...
# Subtest: GENERIC_VWC (variable count, documented escape hatch) maps in order and bounds-checks
ok 4 - GENERIC_VWC (variable count, documented escape hatch) maps in order and bounds-checks
  ---
  duration_ms: 0.262184
  type: 'test'
  ...
# Subtest: no profile -> battery only + quarantine marker
ok 5 - no profile -> battery only + quarantine marker
  ---
  duration_ms: 0.241162
  type: 'test'
  ...
# Subtest: NULL is matched exactly, never by substring
ok 6 - NULL is matched exactly, never by substring
  ---
  duration_ms: 0.165803
  type: 'test'
  ...
# Subtest: unparseable non-NULL -> quarantine marker
ok 7 - unparseable non-NULL -> quarantine marker
  ---
  duration_ms: 0.17558
  type: 'test'
  ...
# Subtest: parseIdentity extracts vendor/model/firmware for storage and display
ok 8 - parseIdentity extracts vendor/model/firmware for storage and display
  ---
  duration_ms: 0.148832
  type: 'test'
  ...
# Subtest: v1 ships no auto-matchers; matchProfile works only with bench-enabled patterns
ok 9 - v1 ships no auto-matchers; matchProfile works only with bench-enabled patterns
  ---
  duration_ms: 0.394323
  type: 'test'
  ...
# Subtest: every fixed-cardinality profile fits the 51-byte DR0 uplink budget
ok 10 - every fixed-cardinality profile fits the 51-byte DR0 uplink budget
  ---
  duration_ms: 0.376863
  type: 'test'
  ...
# Subtest: listProfiles is GUI-serializable and slot-aware
ok 11 - listProfiles is GUI-serializable and slot-aware
  ---
  duration_ms: 0.354863
  type: 'test'
  ...
1..11
# tests 11
# suites 0
# pass 11
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 67.176833

$ (cd web/react-gui && npx vitest run)
npm notice run open-smart-irrigation@1.0.0 npx
npm notice run 'vitest' run

 RUN  v4.1.6 /home/phil/Repos/osi-os-agrolink/web/react-gui

[baseline-browser-mapping] The data in this module is over two months old.  To ensure accurate Baseline data, please update: `npm i baseline-browser-mapping@latest -D`
Browserslist: browsers data (caniuse-lite) is 9 months old. Please run:
  npx update-browserslist-db@latest
  Why you should do it regularly: https://github.com/browserslist/update-db#readme

 Test Files  172 passed (172)
      Tests  1705 passed (1705)
   Start at  21:02:35
   Duration  39.45s (transform 31.83s, setup 0ms, import 97.23s, tests 144.89s, environment 280.05s)


$ (cd web/react-gui && npx tsc --noEmit -p .)
npm notice run open-smart-irrigation@1.0.0 npx
npm notice run 'tsc' --noEmit -p .

$ (cd web/react-gui && npm run build)
npm notice run open-smart-irrigation@1.0.0 build
npm notice run vite build
vite v5.4.21 building for production...
transforming...
[baseline-browser-mapping] The data in this module is over two months old.  To ensure accurate Baseline data, please update: `npm i baseline-browser-mapping@latest -D`
Browserslist: browsers data (caniuse-lite) is 9 months old. Please run:
  npx update-browserslist-db@latest
  Why you should do it regularly: https://github.com/browserslist/update-db#readme
✓ 1723 modules transformed.
rendering chunks...
computing gzip size...
build/index.html                                     0.46 kB │ gzip:   0.31 kB
build/assets/balken-horizontal-it-Ou2XHCRY.png      19.33 kB
build/assets/balken-horizontal-de-CqhCszv6.png      19.91 kB
build/assets/balken-horizontal-en-D-ArRzMS.png      20.30 kB
build/assets/balken-horizontal-fr-7SkApz9y.png      23.99 kB
build/assets/noto-sans-latin-var-BYSzYMf3.woff2     35.82 kB
build/assets/logo-it-hoch-vq__SgqK.png              60.63 kB
build/assets/logo-fr-hoch-DAKzGB1G.png              60.94 kB
build/assets/logo-de-hoch-BsxN59gE.png              62.34 kB
build/assets/logo-en-hoch-CBGkz__h.png              69.81 kB
build/assets/index-Dh_YEGLS.css                     73.37 kB │ gzip:  15.14 kB
build/assets/AnalysisRoute-E3_wzfzH.js               0.69 kB │ gzip:   0.44 kB
build/assets/WindRoseChart-rKZGgxT6.js               1.60 kB │ gzip:   0.85 kB
build/assets/EChart-BhlUxSGB.js                      1.68 kB │ gzip:   0.86 kB
build/assets/browser-ponyfill-CCqcwiNE.js           10.26 kB │ gzip:   3.52 kB
build/assets/CrossZoneAnalysisPage-MzSfjcb-.js      38.31 kB │ gzip:  11.88 kB
build/assets/analysis-echarts-DOTAK0kg.js        1,036.20 kB │ gzip: 346.36 kB
build/assets/index-CWG51jV2.js                   1,553.56 kB │ gzip: 414.88 kB

(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
✓ built in 7.50s
```

## Honest remainder

- Bench phase remains: real SDI-12 probe captures, profile finalization, identity matcher decisions, and golden vectors are still unverified hardware work.
- osi-server lockstep remains a merge gate: the paired server contract/type/channel/history changes must land and pass together.
- No push, merge, PR, deployment, SSH, live Pi, osicloud.ch, or remote database work was performed.

## Final Task 18 gate-battery output after the review wave

The complete sequential output below is from the final review-wave worktree. The seed-replay verifier took approximately two minutes and completed with `verify-seed-replay: OK`; the frontend Vitest run and production build were isolated, and the build was last.

```text

$ node scripts/verify-sdi12-codec.js
verify-sdi12-codec: PASS

$ node scripts/verify-codec-robustness.js
Codec robustness verification passed

$ node scripts/verify-lsn50-chameleon-codec.js
LSN50 Chameleon codec checks passed

$ node scripts/verify-device-integration.js
(node:4038811) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
TAP version 13
# Subtest: UC512 round-trip: codec → normalizer → writer → DB
    # Subtest: round-trip: battery + both valves closed
    ok 1 - round-trip: battery + both valves closed
      ---
      duration_ms: 32.000001
      type: 'test'
      ...
    # Subtest: round-trip: battery + valve 1 open + pulse counters
    ok 2 - round-trip: battery + valve 1 open + pulse counters
      ---
      duration_ms: 28.148753
      type: 'test'
      ...
    # Subtest: round-trip: full telemetry with pressure + GPIOs
    ok 3 - round-trip: full telemetry with pressure + GPIOs
      ---
      duration_ms: 27.67111
      type: 'test'
      ...
    # Subtest: round-trip: valve task response — success
    ok 4 - round-trip: valve task response — success
      ---
      duration_ms: 27.017538
      type: 'test'
      ...
    1..4
ok 1 - UC512 round-trip: codec → normalizer → writer → DB
  ---
  duration_ms: 115.839552
  type: 'suite'
  ...
# Subtest: SDI-12 round-trip: codec → profile normalizer → writer → DB
    # Subtest: round-trip: Tensiomark tension and temperature
    ok 1 - round-trip: Tensiomark tension and temperature
      ---
      duration_ms: 28.231864
      type: 'test'
      ...
    # Subtest: round-trip: generic VWC three values
    ok 2 - round-trip: generic VWC three values
      ---
      duration_ms: 27.177124
      type: 'test'
      ...
    # Subtest: round-trip: generic VWC no response
    ok 3 - round-trip: generic VWC no response
      ---
      duration_ms: 27.308635
      type: 'test'
      ...
    # Subtest: round-trip: generic VWC address digit is unparseable
    ok 4 - round-trip: generic VWC address digit is unparseable
      ---
      duration_ms: 27.55231
      type: 'test'
      ...
    # Subtest: round-trip: Tensiomark cardinality mismatch is atomic
    ok 5 - round-trip: Tensiomark cardinality mismatch is atomic
      ---
      duration_ms: 27.25381
      type: 'test'
      ...
    1..5
ok 2 - SDI-12 round-trip: codec → profile normalizer → writer → DB
  ---
  duration_ms: 138.024225
  type: 'suite'
  ...
# Subtest: LSN50 round-trip: normalizer → writer → DB (default mode)
    # Subtest: default mode soil/dendro uplink
    ok 1 - default mode soil/dendro uplink
      ---
      duration_ms: 28.14575
      type: 'test'
      ...
    # Subtest: mode 9 rain/flow uplink
    ok 2 - mode 9 rain/flow uplink
      ---
      duration_ms: 27.116293
      type: 'test'
      ...
    1..2
ok 3 - LSN50 round-trip: normalizer → writer → DB (default mode)
  ---
  duration_ms: 55.42135
  type: 'suite'
  ...
# Subtest: LSN50 round-trip: production-shaped fixtures with both mode key sets present
    # Subtest: default mode with undefined inactive MOD9 placeholders produces zero dead letters
    ok 1 - default mode with undefined inactive MOD9 placeholders produces zero dead letters
      ---
      duration_ms: 27.355708
      type: 'test'
      ...
    # Subtest: MOD9 with undefined inactive default placeholders produces zero dead letters
    ok 2 - MOD9 with undefined inactive default placeholders produces zero dead letters
      ---
      duration_ms: 27.554546
      type: 'test'
      ...
    # Subtest: default mode with null inactive MOD9 placeholders produces zero dead letters
    ok 3 - default mode with null inactive MOD9 placeholders produces zero dead letters
      ---
      duration_ms: 26.8275
      type: 'test'
      ...
    # Subtest: MOD9 with null inactive default placeholders produces zero dead letters
    ok 4 - MOD9 with null inactive default placeholders produces zero dead letters
      ---
      duration_ms: 26.922833
      type: 'test'
      ...
    # Subtest: a populated MOD9-only field on a default-mode uplink produces exactly one unknown_channel row
    ok 5 - a populated MOD9-only field on a default-mode uplink produces exactly one unknown_channel row
      ---
      duration_ms: 27.502165
      type: 'test'
      ...
    # Subtest: a populated default-only field on a MOD9 uplink produces exactly one unknown_channel row
    ok 6 - a populated default-only field on a MOD9 uplink produces exactly one unknown_channel row
      ---
      duration_ms: 30.018539
      type: 'test'
      ...
    # Subtest: a populated field outside both shipped maps produces exactly one unknown_channel row
    ok 7 - a populated field outside both shipped maps produces exactly one unknown_channel row
      ---
      duration_ms: 29.381659
      type: 'test'
      ...
    1..7
ok 4 - LSN50 round-trip: production-shaped fixtures with both mode key sets present
  ---
  duration_ms: 195.91844
  type: 'suite'
  ...
# Subtest: LSN50 normalizer coverage parity with old SQL path
    # Subtest: default mode produces exactly the columns the old SQL wrote
    ok 1 - default mode produces exactly the columns the old SQL wrote
      ---
      duration_ms: 0.23327
      type: 'test'
      ...
    # Subtest: mode 9 produces exactly the columns the old SQL wrote
    ok 2 - mode 9 produces exactly the columns the old SQL wrote
      ---
      duration_ms: 0.14911
      type: 'test'
      ...
    1..2
ok 5 - LSN50 normalizer coverage parity with old SQL path
  ---
  duration_ms: 0.498665
  type: 'suite'
  ...
1..5
# tests 20
# suites 5
# pass 20
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 530.376042

$ node scripts/verify-helper-registration.js
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-chameleon-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-chirpstack-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-cloud-http
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-command-ledger
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-db-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-dendro-analytics
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-dendro-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-device-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-device-writer
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-health-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-history-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-history-router
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-history-sync-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-installation-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-irrigation-config-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-journal
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-journal-replication
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-lib
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-lsn50-normalize
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-scope-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-scoped-access-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-sdi12-normalize
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-uc512-normalize
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-zone-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2712] osi-zone-env
OK [conf/full_raspberrypi_bcm27xx_bcm2712] codec NAME_TO_PATH entries
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-chameleon-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-chirpstack-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-cloud-http
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-command-ledger
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-db-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-dendro-analytics
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-dendro-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-device-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-device-writer
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-health-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-history-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-history-router
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-history-sync-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-installation-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-irrigation-config-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-journal
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-journal-replication
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-lib
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-lsn50-normalize
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-scope-helper
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-scoped-access-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-sdi12-normalize
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-uc512-normalize
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-zone-commands
OK [conf/full_raspberrypi_bcm27xx_bcm2709] osi-zone-env
OK [conf/full_raspberrypi_bcm27xx_bcm2709] codec NAME_TO_PATH entries
All helper-registration checks passed.

$ node scripts/verify-migrations.js
verify-migrations: OK (46 migrations, checksum manifest OK, base immutability OK)

$ node scripts/verify-seed-replay.js
verify-seed-replay: OK

$ node scripts/verify-runtime-schema-parity.js
verify-runtime-schema-parity: OK (2 flows: devices CHECK + runtime trigger parity)

$ node scripts/verify-devices-rebuild-fence.js
verify-devices-rebuild-fence: OK (2 flows)

$ node --test scripts/rehearse-devices-rebuild.test.js
TAP version 13
# (node:4116942) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# (node:4116951) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# (node:4116975) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# (node:4116987) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# (node:4116998) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: healthy DB: guard SKIPS the rebuild, rows preserved
ok 1 - healthy DB: guard SKIPS the rebuild, rows preserved
  ---
  duration_ms: 173.344262
  type: 'test'
  ...
# Subtest: a row the target CHECK rejects is NEVER silently dropped, and the abort is surfaced
ok 2 - a row the target CHECK rejects is NEVER silently dropped, and the abort is surfaced
  ---
  duration_ms: 200.807316
  type: 'test'
  ...
# Subtest: legit upgrade: rebuild succeeds, rows preserved, CHECK gains AQUASCOPE_LORAIN
ok 3 - legit upgrade: rebuild succeeds, rows preserved, CHECK gains AQUASCOPE_LORAIN
  ---
  duration_ms: 213.958673
  type: 'test'
  ...
# Subtest: SDI-12 sentinels survive the rebuild with all three columns present
ok 4 - SDI-12 sentinels survive the rebuild with all three columns present
  ---
  duration_ms: 212.352327
  type: 'test'
  ...
# Subtest: extra drifted type: set-equality guard rebuilds and converges the CHECK (drops the extra), rows preserved
ok 5 - extra drifted type: set-equality guard rebuilds and converges the CHECK (drops the extra), rows preserved
  ---
  duration_ms: 228.261499
  type: 'test'
  ...
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 1087.04111

$ node scripts/verify-db-schema-consistency.js
OK conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
OK database/farming.db
OK web/react-gui/farming.db
DB schema consistency verification passed

$ node scripts/verify-channel-manifest-parity.js
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js channelsForCard id coverage is covered by channels manifest keys/legacyAliases (46 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js channelsForCard field coverage is covered by channels manifest keys/legacyAliases (46 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js ALLOWED_DEVICE_DATA_CHANNELS coverage is covered by channels manifest keys/legacyAliases (75 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js VALID_EXPORT_CHANNEL_KEYS exactly matches channels manifest (58 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js LEGACY_CHANNEL_ALIASES exactly matches channels manifest (5 aliases)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/analysis.js CHANNELS exactly matches active analysis channels manifest metadata (58 channels)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js channelsForCard id coverage is covered by channels manifest keys/legacyAliases (46 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js channelsForCard field coverage is covered by channels manifest keys/legacyAliases (46 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js ALLOWED_DEVICE_DATA_CHANNELS coverage is covered by channels manifest keys/legacyAliases (75 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js VALID_EXPORT_CHANNEL_KEYS exactly matches channels manifest (58 ids)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js LEGACY_CHANNEL_ALIASES exactly matches channels manifest (5 aliases)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/analysis.js CHANNELS exactly matches active analysis channels manifest metadata (58 channels)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/edge-channels.json exactly matches channels.json edge projection (73 entries)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/edge-channels.json exactly matches channels.json edge projection (73 entries)
Channel manifest parity verification passed

$ node scripts/verify-sync-contract.js
  ok command enum = registry 46 + routed 4 + staged 0
  ok journal, scoped-access, and zone semantic bindings are exact and machine-readable
  ok golden operations, ACK results, and capability rollout metadata
  ok commands.schema.json is present and valid JSON
  ok events.schema.json is present and valid JSON
  ok resources.schema.json is present and valid JSON
  ok sync-contract-golden.json is present and valid JSON
  ok journal-v2.schema.json is present and valid JSON
  ok journal-v2-golden.json is present and valid JSON
  ok canonicalization-v2.md is present
verify-sync-contract: OK

$ node scripts/verify-command-safety.js
  ok valve_actuation_expectations has required columns
  ok zone_irrigation_calibration has required columns
  ok conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db has STREGA safety tables
  ok valve_actuation_expectations has required columns
  ok zone_irrigation_calibration has required columns
  ok conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db has STREGA safety tables
  ok valve_actuation_expectations has required columns
  ok zone_irrigation_calibration has required columns
  ok conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db has STREGA safety tables
  ok valve_actuation_expectations has required columns
  ok zone_irrigation_calibration has required columns
  ok conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db has STREGA safety tables
  ok valve_actuation_expectations has required columns
  ok zone_irrigation_calibration has required columns
  ok conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db has STREGA safety tables
  ok valve_actuation_expectations has required columns
  ok zone_irrigation_calibration has required columns
  ok database/farming.db has STREGA safety tables
  ok valve_actuation_expectations has required columns
  ok zone_irrigation_calibration has required columns
  ok web/react-gui/farming.db has STREGA safety tables
  ok Indefinite-open rejection node present
  ok REST valve endpoint rejects indefinite OPEN and accepts duration_seconds
  ok Route Command handles duration-bound valve registry commands
  ok Write-expectation node present and references required fields
  ok STREGA reconciliation monitor present with required state transitions
  ok Explicit cancel path flushes queue without a CLOSE downlink
  ok ChirpStack queue flush uses DeviceService.FlushQueue gRPC
  ok frontend valve controls are duration-bound and report cancel results
  ok "Reject Indefinite Open" fallback consistent with primary (46/46 keys, all actuator keys present)
  ok "Write STREGA Expectation" fallback consistent with primary (46/46 keys, all actuator keys present)
  ok Command Type Registry checked against 2 fallback(s) (46 primary entries)
  ok All actuator commands are duration-bounded or in the close allowlist
  ok Bare OPEN is not in the command-type registry
verify-command-safety: OK

$ node scripts/verify-communication-contract.js
Communication contract verification passed

$ node scripts/verify-no-stray-ddl.js
verify-no-stray-ddl: OK (HEAD total 702 <= origin/main total 702; committed baseline matches HEAD total 702)

$ node scripts/verify-no-new-silent-catch.js
verify-no-new-silent-catch: OK
- bcm2712: 164 empty catches across 287 function nodes (baseline 164)
- bcm2709: 164 empty catches across 287 function nodes (baseline 164)

$ node scripts/flows-bare-require-scan.js

$ node scripts/verify-flows-size-ratchet.js
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json (total 1306301 <= max_total 1306598)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json (total 1306301 <= max_total 1306598)
verify-flows-size-ratchet: OK (exact node coverage and all max_chars/max_total ceilings held)

$ node scripts/test-flows-wiring.js
OK  journal bootstrap behavior harness
OK  journal catch → error link out
OK  Field requests: GET /api/improvement-requests present
OK  Field requests: GET /api/improvement-requests/diagnostics-preview present
OK  Field requests: POST /api/improvement-requests present
OK  Field requests: intake router declares osiDb and closes DB
OK  Field requests: intake router validates revised public request contract
OK  Field requests: support-delivery 5 minute tick present
OK  Field requests: support-delivery-worker declares osiDb, posts unauthenticated support payloads, and retries with backoff
OK  Field requests: pending commands split status updates away from actuator path
OK  Field requests: status apply updates improvement_requests and queues ACK
OK  C5: from-scheduler/manual → write-strega-expectation
OK  C5b: Route Command output 0 reaches write-strega-expectation only via link-out (no double-invoke)
OK  C5: write-strega-expectation → Build STREGA downlink
OK  H2: STALE_OPEN_OBSERVED present in reconciliation monitor
OK  L1: write-strega-expectation has hardcoded fallback
OK  L1: reject-indefinite-open has hardcoded fallback
OK  M8: strega-today-liters-http-in present
OK  M8: strega-today-liters-fn present
OK  M8: strega-today-liters-http-out present
OK  osiDb.Database: every opening node closes it
OK  ChirpStack provisioning clients: every opening node hoists one client and closes it
OK  function node helper globals all declare matching libs entries
OK  settings modules: bulk schedule-disable endpoint present
OK  journal helper failure paths return exact fail-closed outputs
OK  Field requests: support-delivery-worker accepts result/status terminal response matrix
PASS: STREGA wiring + osiDb close + WS2/WS3 wiring guards all passed

$ node scripts/verify-flows-fn-parse.js
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json (287 function nodes, 287 sources parsed)
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json (287 function nodes, 287 sources parsed)
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json (64 function nodes, 64 sources parsed)
verify-flows-fn-parse: OK

$ node scripts/verify-trigger-body-parity.js
OK /home/phil/Repos/osi-os-agrolink/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json (all boot-managed trigger bodies match seed-blank.sql after canonicalization)
OK /home/phil/Repos/osi-os-agrolink/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json (all boot-managed trigger bodies match seed-blank.sql after canonicalization)
verify-trigger-body-parity: OK
(node:4118668) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)

$ node scripts/verify-boot-ddl-interpolation.js
OK /home/phil/Repos/osi-os-agrolink/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json (60 boot statements; no gatewaySql leak; versioned outbox triggers pass NEW.sync_version)
OK /home/phil/Repos/osi-os-agrolink/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json (60 boot statements; no gatewaySql leak; versioned outbox triggers pass NEW.sync_version)
verify-boot-ddl-interpolation: OK
(node:4118678) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)

$ bash scripts/check-mqtt-topics.sh
OK: conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json — no UUID patterns in MQTT IN topics
OK: conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json — no UUID patterns in MQTT IN topics
OK: conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/flows.json — no UUID patterns in MQTT IN topics

$ node scripts/verify-profile-parity.js

=== conf/full_raspberrypi_bcm27xx_bcm2709 ===
OK:   files/etc/board.d/02_network
OK:   files/etc/config
OK:   files/etc/init.d/osi-rootfs-resize
OK:   files/etc/init.d/osi-bootstrap
OK:   files/etc/init.d/osi-identityd
OK:   files/etc/nginx
OK:   files/etc/redis.conf
OK:   files/etc/sysupgrade.conf
OK:   files/etc/uci-defaults/90_osi_rootfs_grow
OK:   files/etc/uci-defaults/94_osi_identityd_enable
OK:   files/etc/uci-defaults/95_osi_bootstrap_enable
OK:   files/etc/uci-defaults/96_osi_server_config
OK:   files/etc/uci-defaults/97_osi_db_seed
OK:   files/etc/uci-defaults/98_osi_node_red_seed
OK:   files/etc/uci-defaults/99_config_chirpstack_ap
OK:   files/etc/uci-defaults/99_set_hostname
OK:   files/etc/uci-defaults/99_set_sx1301_gateway_id
OK:   files/etc/uci-defaults/99_tailscale_init
OK:   files/usr/libexec/osi-gateway-identity.sh
OK:   files/usr/libexec/osi-identityd.sh
OK:   files/usr/share/db
OK:   files/usr/share/flows.json
OK:   files/usr/share/node-red
OK:   absent: files/etc/uci-defaults/01_update_rc_local_20241118
OK:   absent: files/etc/uci-defaults/99_set_chirpstack_mqtt_forwarder_global_config
OK:   absent: files/etc/uci-defaults/99_set_chirpstack_udp_forwarder_global_config
OK:   absent: files/usr/share/schema.sql
OK:   absent: files/usr/share/sensor_data.db

All parity checks passed.

$ node scripts/verify-live-gateway-identity.js
OK openwrt/osi-os.config: build includes jsonfilter
OK jsonfilter Makefile: pinned OpenWrt source declares jsonfilter
OK jsonfilter Makefile: pins the reviewed jsonfilter source revision
OK jsonfilter Makefile: package installs /usr/bin/jsonfilter
OK procd Makefile: pins the reviewed procd rcS snapshot semantics
OK OpenWrt boot init: creates the daemon run directory before applying uci-defaults
OK OpenWrt boot init: retains a failed uci-default for the next boot
OK scripts/verify-sync-flow.js: sync verification chains the live identity verifier
OK scripts/test-identityd-service-lifecycle.sh: mode 755
OK Node-RED init: STOP=99
OK conf/full_raspberrypi_bcm27xx_bcm2712/.config: profile image includes jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service starts before Node-RED and bootstrap
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service stops before Node-RED STOP=99
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: STOP=98 precedes Node-RED STOP=99
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service uses procd
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service launches the identity daemon
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service is supervised with respawn
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service exposes one readiness contract
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: ready requires procd running and the daemon-owned live lock
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: defaults to a same-boot start
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: records whether rcS already queued the service before enabling it
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: uci-defaults enables the service and remains retryable on failure
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: starts the service on the same factory boot and verifies a fresh live lock owner with a bounded retry
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: checks the rcS snapshot, enables, starts conditionally, then verifies readiness
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: has exactly one enable and one conditional start call
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: has exactly one post-start readiness check
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap requests a coordinated restart
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap proves a live consumer immediately before publishing its restart request
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap removes its stamp when restart coordination fails
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap logs restart-request retry behavior
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap does not restart Node-RED directly
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon parses JSON with jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon owns the lock-readiness predicate
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: readiness requires the atomic symlink lock and its canonical live PID owner
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon CLI exposes readiness
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon validates nullable JSON field types with jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon bounds shell arithmetic inputs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon reads a monotonic clock
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: sentinel carries a monotonic deadline
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: queued delay begins when the daemon consumes the request
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: restart countdown uses the monotonic deadline
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: restart eligibility uses the monotonic clock
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: cache and request readers each reject non-canonical JSON
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: sentinel reader rejects non-canonical JSON
OK conf/full_raspberrypi_bcm27xx_bcm2709/.config: profile image includes jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service starts before Node-RED and bootstrap
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service stops before Node-RED STOP=99
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: STOP=98 precedes Node-RED STOP=99
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service uses procd
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service launches the identity daemon
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service is supervised with respawn
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service exposes one readiness contract
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: ready requires procd running and the daemon-owned live lock
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: defaults to a same-boot start
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: records whether rcS already queued the service before enabling it
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: uci-defaults enables the service and remains retryable on failure
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: starts the service on the same factory boot and verifies a fresh live lock owner with a bounded retry
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: checks the rcS snapshot, enables, starts conditionally, then verifies readiness
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: has exactly one enable and one conditional start call
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: has exactly one post-start readiness check
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: bootstrap requests a coordinated restart
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: bootstrap proves a live consumer immediately before publishing its restart request
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: bootstrap removes its stamp when restart coordination fails
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: bootstrap logs restart-request retry behavior
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: bootstrap does not restart Node-RED directly
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon parses JSON with jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon owns the lock-readiness predicate
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: readiness requires the atomic symlink lock and its canonical live PID owner
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon CLI exposes readiness
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon validates nullable JSON field types with jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon bounds shell arithmetic inputs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon reads a monotonic clock
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: sentinel carries a monotonic deadline
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: queued delay begins when the daemon consumes the request
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: restart countdown uses the monotonic deadline
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: restart eligibility uses the monotonic clock
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: cache and request readers each reject non-canonical JSON
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: sentinel reader rejects non-canonical JSON
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: byte-identical mirror
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: byte-identical mirror
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: byte-identical mirror
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: byte-identical mirror
OK scripts/verify-profile-parity.js: CANONICAL_PAYLOAD includes files/usr/libexec/osi-identityd.sh
OK scripts/verify-profile-parity.js: CANONICAL_PAYLOAD includes files/etc/init.d/osi-identityd
OK scripts/verify-profile-parity.js: CANONICAL_PAYLOAD includes files/etc/uci-defaults/94_osi_identityd_enable
OK deploy.sh: fetches the identity daemon
OK deploy.sh: installs the identity daemon
OK deploy.sh: marks the identity daemon executable
OK deploy.sh: fetches the identity service
OK deploy.sh: installs the identity service
OK deploy.sh: marks the identity service executable
OK deploy.sh: fetches the service enable script
OK deploy.sh: installs the service enable script
OK deploy.sh: marks the service enable script executable
OK deploy.sh: fetches the coordinated bootstrap service
OK deploy.sh: installs the coordinated bootstrap service
OK deploy.sh: marks the bootstrap service executable
OK deploy.sh: uses the installed identityd service through the lifecycle fence
OK deploy.sh: enables identityd during live deploy
OK deploy.sh: starts a fresh identityd during live deploy
OK deploy.sh: checks the shared readiness contract during live deploy
OK deploy.sh: does not restart an unquiesced identityd instance
OK deploy.sh: identityd activation follows gateway identity helper installation
OK deploy.sh: identityd activation follows identity daemon installation
OK deploy.sh: identityd activation follows flows payload staging
OK deploy.sh: identityd activation follows flows payload activation
OK deploy.sh: identityd activation follows GUI extraction
OK deploy.sh: uses a bounded shared readiness loop
OK deploy.sh: treats broken symlink locks as present
OK deploy.sh: waits for both procd absence and lock absence
OK deploy.sh: never deletes the daemon ownership lock
OK deploy.sh: preserves queued restart requests while quiesced
OK deploy.sh: preserves the restart sentinel while quiesced
OK deploy.sh: installs restoration and proves quiescence before the sole migration call
OK deploy.sh: has one lifecycle-fenced migration call
OK deploy.sh: catastrophic migration failure explicitly holds both services stopped
OK deploy.sh: EXIT restoration handles Node-RED before identityd and preserves failure status
OK deploy.sh: uses one EXIT cleanup path with signal-specific exit status
OK deploy.sh: final activation starts only after the quiescence gap and waits for readiness
OK deploy.sh: final readiness follows identityd enable/start
OK deploy.sh: disarms restoration only after final readiness succeeds
OK deploy.sh: preserves the missing-DB sidecar guard
OK deploy.sh: retains the direct Node-RED restart immediately after the live payload flip and its existing log
OK deploy.sh: retains the rollback restart
OK deploy.sh: only payload flip and rollback directly restart Node-RED
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json: flow document is an array
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: preserves its absent libs property
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not use require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: restartState reads are allowlisted to reason and restartAt
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field phase
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field restartAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field restartNotBeforeUptime
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field targetDeviceEui
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field target_device_eui
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field requestedAt
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field confidence
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field version
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: missing restart sentinel returns restartPending null
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: valid restart sentinel exposes only restartAt and reason
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: unauthenticated stats omit private and internal sentinel fields
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: missing sentinel reason uses the reviewed public fallback
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: no-deadline healing state exposes a blocked public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: an expired pending deadline remains visible until daemon cleanup
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: invalid JSON exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: array shape exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: non-string deadline exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: unreadable restart sentinel exposes an unreadable public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: hwmon directory failure keeps the fan fallback and warns with context
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: fan probe failures retain the fallback and warn for each probed path
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: expected ENOENT and ENOTDIR fan absence stays quiet with the existing fallback
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: a persistent unexpected fan failure warns once per path and signature
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: a changed unexpected fan failure warns again
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: successful fan-probe recovery resets warning deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: remembered fan failure signatures are bounded
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: successful hwmon listing prunes disappeared children and keeps current deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: disappeared hwmon path warns when it recurs while the current path remains deduplicated
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: hwmon hotplug churn keeps the complete failure map at or below 32 entries
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: successful hwmon listing prunes disappeared children and retains identical current deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: a pruned hwmon path warns when it recurs while the retained path stays deduplicated
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: an evicted hwmon path warns when it recurs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: failure-map cap still applies when hwmon listing cannot prune stale children
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json: only system stats and the seven identity gates read the restart sentinel
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: selects the outer error source from the caught error marker, not stale flow state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: drops command ACK work while restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: exposes the boolean restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: clears the password and returns the second/error output with status 503
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: uses the approved fs global
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: publishes into the daemon request directory
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: publishes the exact three-field request contract
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: requires the Node-RED message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: bounds filesystem error detail returned to the operator
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: measures the UTF-8 message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: bounds the filename key before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: encodes msg._msgid into a path-safe deterministic key
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: keys the deterministic final path by the safe message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: uses a unique temporary suffix for retry-safe publication
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: publishes atomically through a unique temporary file
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: reports the scheduled restart
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: has separate success and error outputs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: failure reaches only the HTTP response
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: keeps libs empty
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: does not use /etc/init.d/node-red
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: creates the private request directory with mode 0700
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: writes one temporary file and renames it once
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: hostile msg._msgid is deterministically encoded inside the request directory
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: unique temporary path is renamed to the deterministic final path
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: temporary request uses mode 0600 and exclusive creation
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: final JSON has exactly reason, delaySeconds, and requestedAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: successful publication uses only the success output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: distinct msg._msgid values produce distinct final paths
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: retries keep a deterministic final path and use a fresh temporary suffix
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: missing msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: empty msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: missing fs fails through only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: mkdir failure stops before publication and uses only the bounded error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: ENOSPC fails closed, cleans up, and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: rename failure cleans up and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: very long msg._msgid fails before filename construction
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: uses the approved fs global
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: publishes into the daemon request directory
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: publishes the exact three-field request contract
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: requires the Node-RED message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: bounds filesystem error detail returned to the operator
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: measures the UTF-8 message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: bounds the filename key before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: encodes msg._msgid into a path-safe deterministic key
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: keys the deterministic final path by the safe message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: uses a unique temporary suffix for retry-safe publication
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: publishes atomically through a unique temporary file
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: reports the scheduled restart
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: has separate success and error outputs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: failure reaches only the HTTP response
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: keeps libs empty
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: does not use /etc/init.d/node-red
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: creates the private request directory with mode 0700
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: writes one temporary file and renames it once
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: hostile msg._msgid is deterministically encoded inside the request directory
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: unique temporary path is renamed to the deterministic final path
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: temporary request uses mode 0600 and exclusive creation
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: final JSON has exactly reason, delaySeconds, and requestedAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: successful publication uses only the success output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: distinct msg._msgid values produce distinct final paths
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: retries keep a deterministic final path and use a fresh temporary suffix
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: missing msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: empty msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: missing fs fails through only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: mkdir failure stops before publication and uses only the bounded error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: ENOSPC fails closed, cleans up, and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: rename failure cleans up and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: very long msg._msgid fails before filename construction
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-validate: protected function is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-init-fn: protected function is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json: flow document is an array
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: preserves its absent libs property
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not use require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: restartState reads are allowlisted to reason and restartAt
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field phase
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field restartAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field restartNotBeforeUptime
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field targetDeviceEui
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field target_device_eui
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field requestedAt
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field confidence
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field version
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: missing restart sentinel returns restartPending null
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: valid restart sentinel exposes only restartAt and reason
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: unauthenticated stats omit private and internal sentinel fields
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: missing sentinel reason uses the reviewed public fallback
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: no-deadline healing state exposes a blocked public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: an expired pending deadline remains visible until daemon cleanup
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: invalid JSON exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: array shape exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: non-string deadline exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: unreadable restart sentinel exposes an unreadable public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: hwmon directory failure keeps the fan fallback and warns with context
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: fan probe failures retain the fallback and warn for each probed path
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: expected ENOENT and ENOTDIR fan absence stays quiet with the existing fallback
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: a persistent unexpected fan failure warns once per path and signature
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: a changed unexpected fan failure warns again
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: successful fan-probe recovery resets warning deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: remembered fan failure signatures are bounded
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: successful hwmon listing prunes disappeared children and keeps current deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: disappeared hwmon path warns when it recurs while the current path remains deduplicated
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: hwmon hotplug churn keeps the complete failure map at or below 32 entries
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: successful hwmon listing prunes disappeared children and retains identical current deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: a pruned hwmon path warns when it recurs while the retained path stays deduplicated
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: an evicted hwmon path warns when it recurs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: failure-map cap still applies when hwmon listing cannot prune stale children
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json: only system stats and the seven identity gates read the restart sentinel
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: selects the outer error source from the caught error marker, not stale flow state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: drops command ACK work while restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: exposes the boolean restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: clears the password and returns the second/error output with status 503
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: uses the approved fs global
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: publishes into the daemon request directory
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: publishes the exact three-field request contract
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: requires the Node-RED message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: bounds filesystem error detail returned to the operator
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: measures the UTF-8 message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: bounds the filename key before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: encodes msg._msgid into a path-safe deterministic key
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: keys the deterministic final path by the safe message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: uses a unique temporary suffix for retry-safe publication
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: publishes atomically through a unique temporary file
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: reports the scheduled restart
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: has separate success and error outputs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: failure reaches only the HTTP response
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: keeps libs empty
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: does not use /etc/init.d/node-red
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: creates the private request directory with mode 0700
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: writes one temporary file and renames it once
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: hostile msg._msgid is deterministically encoded inside the request directory
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: unique temporary path is renamed to the deterministic final path
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: temporary request uses mode 0600 and exclusive creation
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: final JSON has exactly reason, delaySeconds, and requestedAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: successful publication uses only the success output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: distinct msg._msgid values produce distinct final paths
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: retries keep a deterministic final path and use a fresh temporary suffix
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: missing msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: empty msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: missing fs fails through only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: mkdir failure stops before publication and uses only the bounded error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: ENOSPC fails closed, cleans up, and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: rename failure cleans up and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: very long msg._msgid fails before filename construction
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: uses the approved fs global
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: publishes into the daemon request directory
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: publishes the exact three-field request contract
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: requires the Node-RED message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: bounds filesystem error detail returned to the operator
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: measures the UTF-8 message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: bounds the filename key before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: encodes msg._msgid into a path-safe deterministic key
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: keys the deterministic final path by the safe message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: uses a unique temporary suffix for retry-safe publication
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: publishes atomically through a unique temporary file
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: reports the scheduled restart
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: has separate success and error outputs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: failure reaches only the HTTP response
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: keeps libs empty
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: does not use /etc/init.d/node-red
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: creates the private request directory with mode 0700
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: writes one temporary file and renames it once
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: hostile msg._msgid is deterministically encoded inside the request directory
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: unique temporary path is renamed to the deterministic final path
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: temporary request uses mode 0600 and exclusive creation
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: final JSON has exactly reason, delaySeconds, and requestedAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: successful publication uses only the success output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: distinct msg._msgid values produce distinct final paths
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: retries keep a deterministic final path and use a fresh temporary suffix
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: missing msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: empty msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: missing fs fails through only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: mkdir failure stops before publication and uses only the bounded error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: ENOSPC fails closed, cleans up, and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: rename failure cleans up and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: very long msg._msgid fails before filename construction
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-validate: protected function is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-init-fn: protected function is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json: byte-identical flow mirror
OK silent-catch baseline records 164 for both maintained profiles
OK silent-catch baseline: records the PR #149 compensation cleanup
OK silent-catch baseline: records the scoped-access auth cleanup
OK silent-catch baseline: records the scoped-access shared-read cleanup
OK size allowance sync-bootstrap-build: owned entry present
OK size allowance sync-bootstrap-build: declares Task 4 growth
OK size allowance sync-outbox-build: owned entry present
OK size allowance sync-outbox-build: declares Task 4 growth
OK size allowance sync-pending-build: owned entry present
OK size allowance sync-pending-build: declares Task 4 growth
OK size allowance sync-force-build: owned entry present
OK size allowance sync-force-build: declares Task 4 growth
OK size allowance command-ack-build-batch: owned entry present
OK size allowance command-ack-build-batch: declares Task 4 growth
OK size allowance sync-state-build: owned entry present
OK size allowance sync-state-build: declares Task 4 growth
OK size allowance al-link-build-req: owned entry present
OK size allowance al-link-build-req: declares Task 4 growth
OK size allowance al-link-restart-node-red: owned entry present
OK size allowance al-link-restart-node-red: declares Task 4 growth
OK size allowance al-unlink-restart-node-red: owned entry present
OK size allowance al-unlink-restart-node-red: declares Task 4 growth
OK size allowance sys-stats-fn: owned entry present
OK size allowance sys-stats-fn: declares Task 5 growth
OK scripts/test-identityd-service-lifecycle.sh: --- Quiesce gateway identity supervisor before schema migration ---
OK
--- Restore gateway identity supervisor after interrupted deploy ---
OK
--- Quiesce gateway identity supervisor before schema migration ---
OK
--- Restore gateway identity supervisor after interrupted deploy ---
OK: identityd restored to stopped state
--- Quiesce gateway identity supervisor before schema migration ---
OK
--- Quiesce gateway identity supervisor before schema migration ---
--- Quiesce gateway identity supervisor before schema migration ---
OK
--- Restore gateway identity supervisor after interrupted deploy ---
OK
--- Quiesce gateway identity supervisor before schema migration ---
OK
--- Restore gateway identity supervisor after interrupted deploy ---
PASS: identityd deploy lifecycle and readiness
Live gateway identity verification passed.

$ node scripts/verify-sync-flow.js
Communication contract verification passed
OK conf/base_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db
OK database/farming.db
OK web/react-gui/farming.db
DB schema consistency verification passed
OK sync history schema fresh seed
OK durable history schema fresh seed
OK durable history schema ordered migration
OK sync history schema base seed + history migration
OK sync history schema
OK sync history worker helper
device-data-null-and-real.hashInput={"hashVersion":1,"tableName":"device_data","historyKey":"DEVICE_DATA|0016C001F11715E2|123","columns":[["id","INTEGER","123"],["deveui","TEXT","A84041CAFECAFE01"],["recorded_at","TIMESTAMP","2026-06-28T10:00:00.000Z"],["swt_1","REAL","3ff0000000000000"],["swt_2","REAL",null],["dendro_valid","BOOLEAN",true]]}
json-sorted-keys.hashInput={"hashVersion":1,"tableName":"zone_daily_recommendations","historyKey":"ZONE_RECOMMENDATION|zone-uuid-1|2026-06-28","columns":[["zone_uuid","TEXT","zone-uuid-1"],["date","TEXT","2026-06-28"],["recommendation_json","JSON","{\"a\":1,\"b\":null}"]]}
device-data-negative-zero-and-false.hashInput={"hashVersion":1,"tableName":"device_data","historyKey":"DEVICE_DATA|0016C001F11715E2|124","columns":[["id","INTEGER","124"],["deveui","TEXT","A84041CAFECAFE01"],["recorded_at","TIMESTAMP","2026-06-28T10:05:00.000Z"],["swt_1","REAL","0000000000000000"],["swt_2","REAL","0000000000000000"],["dendro_valid","BOOLEAN",false]]}
device-data-large-integer-string.hashInput={"hashVersion":1,"tableName":"device_data","historyKey":"DEVICE_DATA|0016C001F11715E2|9007199254740993","columns":[["id","INTEGER","9007199254740993"],["deveui","TEXT","A84041CAFECAFE01"],["recorded_at","TIMESTAMP","2026-06-28T10:10:00.000Z"],["swt_1","REAL",null],["swt_2","REAL",null],["dendro_valid","BOOLEAN",true]]}
chameleon-reading-booleans-and-counters.hashInput={"hashVersion":1,"tableName":"chameleon_readings","historyKey":"CHAMELEON_READING|0016C001F11715E2|77","columns":[["id","INTEGER","77"],["deveui","TEXT","A84041CAFECAFE01"],["recorded_at","TIMESTAMP","2026-06-28T11:00:00.000Z"],["payload_version","INTEGER","3"],["status_flags","INTEGER","5"],["data_invalid","BOOLEAN",false],["comp_pending","BOOLEAN",true],["f_port","INTEGER","2"],["f_cnt","INTEGER","42"],["calibration_status","TEXT","calibrated"]]}
dendrometer-reading-real-and-flags.hashInput={"hashVersion":1,"tableName":"dendrometer_readings","historyKey":"DENDRO_READING|0016C001F11715E2|88","columns":[["id","INTEGER","88"],["deveui","TEXT","A84041CAFECAFE01"],["recorded_at","TIMESTAMP","2026-06-28T11:05:00.000Z"],["position_um","REAL","40938a0000000000"],["is_valid","BOOLEAN",true],["is_outlier","BOOLEAN",false],["dendro_saturated","BOOLEAN",true]]}
dendrometer-daily-null-real.hashInput={"hashVersion":1,"tableName":"dendrometer_daily","historyKey":"DENDRO_DAILY|0016C001F11715E2|2026-06-28","columns":[["deveui","TEXT","A84041CAFECAFE01"],["date","TEXT","2026-06-28"],["mds_um","REAL",null],["twd_um","REAL","c028800000000000"],["stress_level","TEXT","moderate"],["computed_at","TIMESTAMP","2026-06-29T00:00:00.000Z"]]}
zone-environment-rain-and-flow.hashInput={"hashVersion":1,"tableName":"zone_daily_environment","historyKey":"ZONE_ENVIRONMENT|zone-uuid-1|2026-06-28","columns":[["zone_uuid","TEXT","zone-uuid-1"],["date","TEXT","2026-06-28"],["rainfall_mm","REAL","400e000000000000"],["flow_liters","REAL","405e000000000000"],["rain_source","TEXT","aquascope_lorain"],["computed_at","TIMESTAMP","2026-06-29T00:05:00.000Z"]]}
irrigation-event-json-payload.hashInput={"hashVersion":1,"tableName":"irrigation_events","historyKey":"IRRIGATION_EVENT|irrig-0016C001F11715E2-000000000000123","columns":[["event_uuid","TEXT","irrig-0016C001F11715E2-000000000000123"],["created_at","TIMESTAMP","2026-06-28T11:10:00.000Z"],["action","TEXT","OPEN"],["reason","TEXT","schedule"],["aggregate_kpa","REAL","4032800000000000"],["threshold_kpa","REAL","4034000000000000"],["duration_minutes","INTEGER","15"],["valve_deveui","TEXT","A84041VALVE0001"],["payload_json","JSON","{\"a\":[3,1],\"z\":2}"]]}
fixtureSetSha256=cbd70d0c2791f3a7bd7fcf17998914bcc55f97d4226411ab853e041a3d388828
OK GET /api/history/zones/:zoneId/cards uses osi-history-helper via "History API Router"
OK GET /api/history/zones/:zoneId/export.csv uses osi-history-helper via "History API Router"
OK GET /api/history/export.csv uses osi-history-helper via "History API Router"
OK GET /api/history/zones/:zoneId/cards/:cardId/data uses osi-history-helper via "History API Router"
OK GET /api/history/zones/:zoneId/cards/:cardId/advanced uses osi-history-helper via "History API Router"
OK GET /api/history/gateways/:gatewayEui/cards uses osi-history-helper via "History API Router"
OK GET /api/history/gateways/:gatewayEui/cards/:cardId/data uses osi-history-helper via "History API Router"
OK GET /api/history/gateways/:gatewayEui/cards/:cardId/advanced uses osi-history-helper via "History API Router"
OK GET /api/history/workspaces uses osi-history-helper via "History API Router"
OK POST /api/history/workspaces uses osi-history-helper via "History API Router"
OK PUT /api/history/workspaces/:id uses osi-history-helper via "History API Router"
OK DELETE /api/history/workspaces/:id uses osi-history-helper via "History API Router"
OK PUT /api/history/zones/:zoneId/cards/:cardId/preferences uses osi-history-helper via "History API Router"
OK POST /api/history/zones/:zoneId/cards/:cardId/opened uses osi-history-helper via "History API Router"
OK PUT /api/history/gateways/:gatewayEui/cards/:cardId/preferences uses osi-history-helper via "History API Router"
OK POST /api/history/gateways/:gatewayEui/cards/:cardId/opened uses osi-history-helper via "History API Router"
OK POST /api/history/rollups/run uses osi-history-helper via "History Rollup Tick"
OK GET /api/system/features uses osi-history-helper via "History API Router"
OK GET /api/analysis/channels uses osi-history-helper via "Analysis API Router"
OK POST /api/analysis/series uses osi-history-helper via "Analysis API Router"
OK GET /api/analysis/views uses osi-history-helper via "Analysis API Router"
OK POST /api/analysis/views uses osi-history-helper via "Analysis API Router"
OK DELETE /api/analysis/views/:id uses osi-history-helper via "Analysis API Router"
verify-history-api-contract: OK
TAP version 13
# Subtest: analysis contract accepts the maintained scoped router
ok 1 - analysis contract accepts the maintained scoped router
  ---
  duration_ms: 13.10142
  type: 'test'
  ...
# Subtest: analysis contract rejects removal of zone-scope propagation
ok 2 - analysis contract rejects removal of zone-scope propagation
  ---
  duration_ms: 8.714702
  type: 'test'
  ...
1..2
# tests 2
# suites 0
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 88.301628
verify-scoped-access: OK (ratchet only; behavioral matrix is the correctness gate)
TAP version 13
# Subtest: prepare emits the exact pinned protocol command without mutation authority
ok 1 - prepare emits the exact pinned protocol command without mutation authority
  ---
  duration_ms: 10.318602
  type: 'test'
  ...
# Subtest: prepare rejects the live farming database path
ok 2 - prepare rejects the live farming database path
  ---
  duration_ms: 4.642197
  type: 'test'
  ...
# Subtest: prepare rejects a symlinked downloaded database
ok 3 - prepare rejects a symlinked downloaded database
  ---
  duration_ms: 4.252135
  type: 'test'
  ...
# Subtest: prepare rejects wrong installation, gateway, and database hash
ok 4 - prepare rejects wrong installation, gateway, and database hash
  ---
  duration_ms: 13.313598
  type: 'test'
  ...
# Subtest: prepare rejects an incomplete future protocol invocation
ok 5 - prepare rejects an incomplete future protocol invocation
  ---
  duration_ms: 5.367218
  type: 'test'
  ...
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 109.87212
  ok Command Type Registry node present with required entries
OK shared STREGA ingest node renamed to Local Device Uplinks
OK shared STREGA ingest topic remains application/+/device/+/event/up
OK chirpstack-bootstrap.js preserves the shared STREGA ingest topic
OK no direct sqlite database opens remain in flows.json
OK osi-db-helper nodes consistently use the osiDb alias
OK osi-lib binding audit adversarial fixtures pass
OK journal replay generators reject shape drift
OK journal v2 flow migration roundtrip and isolation guards pass
OK journal v2 startup media configuration guards pass
OK journal v2 durable worker behavior passes
OK mock osiDb run returns a thenable without a callback
OK route /api/account-link
OK route /api/account-link/status
OK route /api/sync/state
OK route /api/sync/force
OK route /api/valve/:deveui/cancel
OK route /api/devices/:deveui/lsn50/mode
OK route /api/devices/:deveui/lsn50/interval
OK route /api/devices/:deveui/lsn50/interrupt-mode
OK route /api/devices/:deveui/lsn50/5v-warmup
OK route /api/devices/:deveui/kiwi/interval
OK route /api/devices/:deveui/kiwi/temperature-humidity/enable
OK route /api/devices/:deveui/soil-moisture-depths
OK route /api/devices/:deveui/strega/interval
OK route /api/devices/:deveui/strega/model
OK route /api/devices/:deveui/strega/timed-action
OK route /api/devices/:deveui/strega/magnet
OK route /api/devices/:deveui/strega/partial-opening
OK route /api/devices/:deveui/strega/flushing
OK route /api/devices/:deveui/chameleon
OK route /api/devices/:deveui/chameleon/refresh-calibration
OK route /api/devices/:deveui/chameleon/depth
OK route /api/devices/:deveui/dendro-config
OK route /api/devices/:deveui/dendro-baseline/reset
OK route /api/devices/:deveui/zone-assignments
OK route /api/gateway/location
OK route /api/gateways/:gatewayEui/location
OK route /api/irrigation-zones/:zone_id/environment-summary
OK route /api/irrigation-zones/:id/calibration
OK route /api/irrigation/recent-actuations
OK compile Validate & decode token
OK compile Build server auth request
OK compile Handle server auth response
OK compile Finalize linked account state
OK compile Persist MQTT Broker Config
OK compile Rollback MQTT Broker Config
OK compile Schedule Link Restart
OK compile Clear link flow state
OK compile Clear MQTT Broker Config
OK compile Decode token & build UPDATE
OK compile Clear linked account state
OK compile Restore MQTT Broker Config
OK compile Schedule Unlink Restart
OK compile Set Download Headers
OK compile Daily Dendrometer Analytics
OK compile Sync Init Schema + Triggers
OK compile Build Cloud Bootstrap
OK compile Mark Bootstrap Synced
OK compile Build Edge Event Batch
OK compile Mark Synced Events Delivered
OK compile Build Pending Command Pull
OK compile Deduplicate Pending Command
OK compile Queue REST Command ACK
OK compile Build Command ACK Batch
OK compile Mark Command ACKs Delivered
OK compile Prune Sync Outbox
OK compile Build Sync State
OK compile Replay Pending Commands
OK compile Apply Work Request Status
OK compile Improvement Requests API Router
OK compile support-delivery-worker
OK compile Build Sync Token Refresh
OK compile Store Refreshed Sync Token
OK compile Run Force Sync
OK compile Auth + Parse LSN50 Mode
OK compile Auth + Parse LSN50 Interval
OK compile Authorize + Fanout LSN50 Mode
OK compile Authorize + Fanout LSN50 Interval
OK compile Format LSN50 Mode Response
OK compile Format LSN50 Interval Response
OK compile Auth + Parse LSN50 Interrupt
OK compile Auth + Parse LSN50 5V Warmup
OK compile Authorize + Fanout LSN50 Advanced
OK compile Format LSN50 Advanced Response
OK compile Auth + Parse Kiwi Interval
OK compile Authorize + Fanout Kiwi Interval
OK compile Format Kiwi Interval Response
OK compile Auth + Parse Kiwi Temp/Humidity
OK compile Authorize + Fanout Kiwi Temp/Humidity
OK compile Format Kiwi Temp/Humidity Response
OK compile Auth + Save Soil Moisture Depths
OK compile Auth + Parse STREGA Interval
OK compile Authorize + Fanout STREGA Interval
OK compile Format STREGA Interval Response
OK compile Auth + Parse STREGA Model
OK compile Auth + Parse STREGA Timed Action
OK compile Auth + Parse STREGA Magnet
OK compile Auth + Parse STREGA Partial Opening
OK compile Auth + Parse STREGA Flushing
OK compile Authorize + Fanout STREGA Advanced
OK compile Format STREGA Advanced Response
OK compile Cancel STREGA Actuation
OK compile Auth + Set Chameleon Enabled
OK compile Auth + Parse Dendro Config
OK compile Format Dendro Config Response
OK compile Return Device API HTTP 500
OK compile CS Register (cloud cmd)
OK compile Build Special Command ACK
OK compile Build LSN50 mode downlink
OK compile Process STREGA
OK compile Persist STREGA Uplink
OK compile Process S2120
OK compile Aggregate Zone Rain
OK compile Process LoRain
OK compile Build LoRain SQL INSERT
OK compile Aggregate LoRain Zone Rain
OK compile Insert Chameleon Reading
OK compile Get Zone Assignments
OK compile Auth + Set Zone Assignments
OK compile Auth + Query Gateway Location
OK compile Format Gateway Location Response
OK compile Get Zone Environment Summary
OK compile Save Zone Irrigation Calibration
OK compile 9b3afb405207302e (Build SQL INSERT)
OK compile 5f0d2b7e9b9b1b3a (Decide + build actuator cmd + build DB logs)
OK every function node that uses a guarded module has it bound
OK no function node bare-requires a non-builtin module
OK History Rollup Tick calls the helper rollup job
OK History API Router builds the zone CSV export via the helper
OK bootstrap repeat 21600
OK refresh repeat 3600
OK bootstrap includes sensorData
OK bootstrap includes dendroReadings
OK bootstrap includes chameleonReadings
OK bootstrap includes dendroDaily
OK bootstrap includes zoneRecommendations
OK bootstrap includes zoneEnvironments
OK bootstrap includes gatewayLocations
OK bootstrap includes irrigationEvents
OK bootstrap includes irrigationCalibrations
OK Validate & decode token uses decoded local auth
OK Validate & decode token supports a private-target maintenance override
OK Validate & decode token accepts the runtime private-target override flag
OK Validate & decode token accepts the legacy runtime private-target override flag
OK Validate & decode token accepts the persisted UCI private-target override flag
OK Validate & decode token uses the canonical runtime gateway identity
OK Validate & decode token reads runtime gateway identity confidence
OK Validate & decode token stores resolved gateway identity metadata in link flow state
OK Validate & decode token stores resolved gateway identity confidence in link flow state
OK Validate & decode token blocks account linking while gateway identity remains provisional
OK Validate & decode token removed ad hoc ChirpStack log gateway probing
OK Validate & decode token removed ad hoc concentratord gateway probing
OK Validate & decode token removed ad hoc UCI gateway probing
OK Validate & decode token removed ad hoc MAC-derived gateway probing
OK Handle server auth response maps remote auth failures away from 401
OK Handle server auth response requires sync token on successful link
OK Handle server auth response requires offline verifier on successful link
OK Handle server auth response requires MQTT password on successful link
OK Handle server auth response requires MQTT broker URL on successful link
OK Handle server auth response accepts MQTT credentials from local-sync
OK Handle server auth response stores MQTT password from local-sync
OK Handle server auth response stores MQTT broker URL from local-sync
OK Handle server auth response uses a runtime-compatible MQTT URL parser
OK Handle server auth response falls back to regex host extraction when URL is unavailable
OK Handle server auth response removed a direct MQTT broker URL constructor check that can fail on older runtimes
OK Handle server auth response removed direct linked-account DB mutation
OK Build server auth request sends local device claims in the authenticated local-sync request
OK Build server auth request loads local device claims before cloud linking
OK Build server auth request fails locally when no canonical gateway EUI is available
OK Build server auth request fails linking while gateway identity remains provisional
OK Build server auth request sends the local user UUID for linked-auth targeting
OK Build server auth request sends the local username snapshot for linked-auth targeting
OK Build server auth request sends the edge build version during local-sync
OK Build server auth request advertises linked-auth sync capabilities during local-sync
OK Build server auth request advertises the linked-auth sync capability
OK Build server auth request advertises the force-edge-sync capability
OK Build server auth request advertises the versioned zone desired-state capability
OK Build server auth request advertises the irrigation-config desired-state capability
OK Build server auth request advertises the protected device desired-state capability
OK Build server auth request advertises the weather-station zone desired-state capability
OK Handle server auth response accepts claimed device results directly from local-sync
OK Handle server auth response requires and stores the offline verifier version from local-sync
OK Decode token & build query loads linked-auth verifier metadata for account-link status
OK Format status response reports linked-auth package validity in account-link status
OK Format status response reports linked-auth repair requirements in account-link status
OK Format status response downgrades stale linked-auth state in account-link status
OK Build Sync State returns the last mirrored sync event timestamp
OK Build Sync State returns a DB health block in sync state
OK Build Sync State returns SQLite journal mode in sync state
OK Build Sync State returns quick-check status in sync state
OK Build Sync State returns helper DB errors in sync state
OK Build Sync State keeps DB close handling safe when auth fails before DB open
OK Build Sync State preserves auth error status codes in sync state responses
OK Build Sync State returns a bounded 401 response for unauthenticated sync state requests
OK Build Sync State reports linked-auth package validity in sync state
OK Build Sync State reports linked-auth repair requirements in sync state
OK Build Sync State excludes terminal rejected outbox events from pending outbox count
OK Build Sync State reports gateway migration candidate sources in sync state
OK Build Sync State reports rejected gateway migration candidates in sync state
OK Finalize linked account state commits linked-account DB state only after MQTT persistence
OK Finalize linked account state finalizes linked auth mode explicitly
OK Finalize linked account state persists the synced offline verifier version locally
OK Finalize linked account state marks linked auth as up to date after local-sync finalization
OK Finalize linked account state can stop before reporting link success
OK Finalize linked account state persists sync_link_state on successful account link
OK Finalize linked account state linked account state normalizes gateway EUI
OK Finalize linked account state sets account_linked flow flag on successful account link
OK Clear linked account state marks sync_link_state unlinked during unlink
OK Clear linked account state clears sync_link_state linked flag during unlink
OK Clear linked account state unlink clears sync_link_state server URL
OK Clear linked account state unlink clears sync_link_state gateway identity
OK Clear linked account state clears account_linked flow flag during unlink
OK Set Download Headers keeps database download disabled
OK Lookup Auth User prefers local username matches
OK Process Result rejects ambiguous linked logins
OK Process Result uses a persisted local auth secret
OK Process Result uses the linked gateway identity captured at account-link time
OK Process Result falls back to the gateway encoded into the sync token
OK Process Result uses canonical runtime gateway identity only as a last resort
OK Process Result removed ad hoc ChirpStack log gateway probing during linked login
OK Process Result removed ad hoc concentratord gateway probing during linked login
OK Process Result removed ad hoc UCI gateway probing during linked login
OK Process Result removed ad hoc MAC-derived gateway probing during linked login
OK Route Command normalizes valve commands from either deviceEui or devEui
OK Route Command routes normalized valve commands to the STREGA actuator path
OK Route Command routes linked-auth sync commands through the special command handler
OK Route Command routes force-edge-sync commands through the special command handler
OK CS Register Device uses shared ChirpStack provisioning helper
OK CS Register Device provisions devices through gRPC helper
OK CS Register Device removed legacy ChirpStack REST device endpoint
OK CS Register (cloud cmd) uses shared ChirpStack provisioning helper
OK CS Register (cloud cmd) provisions cloud-triggered devices through gRPC helper
OK CS Register (cloud cmd) removed legacy ChirpStack REST device endpoint
OK CS Register (cloud cmd) handles linked-auth sync commands
OK CS Register (cloud cmd) handles force-edge-sync commands
OK CS Register (cloud cmd) targets linked-auth sync by local user UUID first
OK CS Register (cloud cmd) acknowledges stale linked-auth versions without downgrading local auth
OK CS Register (cloud cmd) treats duplicate linked-auth commands as idempotent
OK CS Register (cloud cmd) stores the linked-auth verifier version locally
OK CS Register (cloud cmd) tracks linked-auth apply status locally
OK CS Register (cloud cmd) reports queued force-sync requests in the special-command ACK state
OK CS Register (cloud cmd) preserves cloud SenseCAP registration mapping
OK CS Register (cloud cmd) maps cloud SenseCAP registration to the SenseCAP ChirpStack profile
OK Build Special Command ACK formats special command acknowledgments from structured state
OK Build Special Command ACK includes linked-auth apply outcomes in the ACK payload
OK Build Special Command ACK includes force-sync queue state in the ACK payload
OK Sync Init Schema + Triggers emits dendro daily outbox rows from dendrometer_daily
OK Sync Init Schema + Triggers updates dendro daily outbox rows from dendrometer_daily
OK sync-init-fn guards + fail-closes the devices rebuild (transaction, live-CHECK guard, FK fence in finally)
OK Sync Init Schema + Triggers emits linked cloud usernames in device outbox events
OK Sync Init Schema + Triggers adds the STREGA model metadata column
OK Sync Init Schema + Triggers mirrors STREGA current state changes into device outbox events
OK Sync Init Schema + Triggers mirrors STREGA target state changes into device outbox events
OK Sync Init Schema + Triggers mirrors STREGA model changes into device outbox events
OK Sync Init Schema + Triggers creates the gateway GPS mirror table
OK Sync Init Schema + Triggers creates the gateway GPS insert trigger
OK Sync Init Schema + Triggers emits gateway GPS sync events
OK Sync Init Schema + Triggers adds shared zone area config
OK Sync Init Schema + Triggers adds shared irrigation efficiency config
OK Sync Init Schema + Triggers adds the synced prediction-card flag to zones
OK Sync Init Schema + Triggers adds the linked-auth verifier version column to users
OK Sync Init Schema + Triggers adds the linked-auth last-sync timestamp column to users
OK Sync Init Schema + Triggers adds the linked-auth status column to users
OK Sync Init Schema + Triggers adds the linked-auth error column to users
OK Sync Init Schema + Triggers backfills linked server users with an up-to-date auth status
OK Sync Init Schema + Triggers marks invalid linked-auth packages for repair during sync init
OK Sync Init Schema + Triggers uses a canonical gateway-or-NULL SQL fallback during sync init
OK Sync Init Schema + Triggers adds normalized rain telemetry storage
OK Sync Init Schema + Triggers adds normalized flow telemetry storage
OK Sync Init Schema + Triggers adds STREGA battery percentage storage
OK Sync Init Schema + Triggers mirrors zone area changes into zone sync events
OK Sync Init Schema + Triggers mirrors irrigation efficiency changes into zone sync events
OK Sync Init Schema + Triggers mirrors prediction-card changes into zone sync events
OK Sync Init Schema + Triggers queues outbox events when the prediction-card flag changes
OK Sync Init Schema + Triggers creates sync link state table at runtime
OK Sync Init Schema + Triggers backfills stable irrigation event UUIDs at runtime
OK Sync Init Schema + Triggers creates stable irrigation event UUID trigger at runtime
OK seed-blank.sql irrigation events have stable sync identity
OK seed-blank.sql fresh DBs create stable irrigation event UUIDs
OK seed-blank.sql defines trg_sync_zones_outbox_au
OK seed-blank.sql trg_sync_zones_outbox_au cloud link gate
OK Sync Init Schema + Triggers trg_sync_zones_outbox_au cloud link gate
OK seed-blank.sql defines trg_sync_devices_outbox_au
OK seed-blank.sql trg_sync_devices_outbox_au cloud link gate
OK Sync Init Schema + Triggers trg_sync_devices_outbox_au cloud link gate
OK seed-blank.sql defines trg_sync_schedules_outbox_au
OK seed-blank.sql trg_sync_schedules_outbox_au cloud link gate
OK Sync Init Schema + Triggers trg_sync_schedules_outbox_au cloud link gate
OK seed-blank.sql defines trg_gateway_locations_outbox_ai
OK seed-blank.sql trg_gateway_locations_outbox_ai cloud link gate
OK Sync Init Schema + Triggers trg_gateway_locations_outbox_ai cloud link gate
OK seed-blank.sql defines trg_gateway_locations_outbox_au
OK seed-blank.sql trg_gateway_locations_outbox_au cloud link gate
OK Sync Init Schema + Triggers trg_gateway_locations_outbox_au cloud link gate
OK seed-blank.sql link-gates sync triggers
OK Sync Init Schema + Triggers creates trg_dp_device_data_outbox_ai at runtime
OK seed-blank.sql defines trg_dp_device_data_outbox_ai
OK seed-blank.sql trg_dp_device_data_outbox_ai cloud link gate
OK Sync Init Schema + Triggers trg_dp_device_data_outbox_ai cloud link gate
OK Sync Init Schema + Triggers creates trg_dp_chameleon_readings_outbox_ai at runtime
OK seed-blank.sql defines trg_dp_chameleon_readings_outbox_ai
OK seed-blank.sql trg_dp_chameleon_readings_outbox_ai cloud link gate
OK Sync Init Schema + Triggers trg_dp_chameleon_readings_outbox_ai cloud link gate
OK Sync Init Schema + Triggers creates trg_dp_dendro_readings_outbox_ai at runtime
OK seed-blank.sql defines trg_dp_dendro_readings_outbox_ai
OK seed-blank.sql trg_dp_dendro_readings_outbox_ai cloud link gate
OK Sync Init Schema + Triggers trg_dp_dendro_readings_outbox_ai cloud link gate
OK Sync Init Schema + Triggers creates trg_dp_dendro_daily_outbox_ai at runtime
OK seed-blank.sql defines trg_dp_dendro_daily_outbox_ai
OK seed-blank.sql trg_dp_dendro_daily_outbox_ai cloud link gate
OK Sync Init Schema + Triggers trg_dp_dendro_daily_outbox_ai cloud link gate
OK Sync Init Schema + Triggers creates trg_dp_dendro_daily_outbox_au at runtime
OK seed-blank.sql defines trg_dp_dendro_daily_outbox_au
OK seed-blank.sql trg_dp_dendro_daily_outbox_au cloud link gate
OK Sync Init Schema + Triggers trg_dp_dendro_daily_outbox_au cloud link gate
OK Sync Init Schema + Triggers creates trg_dp_irrigation_events_outbox_ai at runtime
OK seed-blank.sql defines trg_dp_irrigation_events_outbox_ai
OK seed-blank.sql trg_dp_irrigation_events_outbox_ai cloud link gate
OK Sync Init Schema + Triggers trg_dp_irrigation_events_outbox_ai cloud link gate
OK Sync Init Schema + Triggers creates trg_dp_irrigation_events_outbox_au_event_uuid at runtime
OK seed-blank.sql defines trg_dp_irrigation_events_outbox_au_event_uuid
OK seed-blank.sql trg_dp_irrigation_events_outbox_au_event_uuid cloud link gate
OK Sync Init Schema + Triggers trg_dp_irrigation_events_outbox_au_event_uuid cloud link gate
OK Sync Init Schema + Triggers creates trg_dp_zone_env_outbox_ai at runtime
OK seed-blank.sql defines trg_dp_zone_env_outbox_ai
OK seed-blank.sql trg_dp_zone_env_outbox_ai cloud link gate
OK Sync Init Schema + Triggers trg_dp_zone_env_outbox_ai cloud link gate
OK Sync Init Schema + Triggers creates trg_dp_zone_env_outbox_au at runtime
OK seed-blank.sql defines trg_dp_zone_env_outbox_au
OK seed-blank.sql trg_dp_zone_env_outbox_au cloud link gate
OK Sync Init Schema + Triggers trg_dp_zone_env_outbox_au cloud link gate
OK Sync Init Schema + Triggers creates trg_dp_zone_recs_outbox_ai at runtime
OK seed-blank.sql defines trg_dp_zone_recs_outbox_ai
OK seed-blank.sql trg_dp_zone_recs_outbox_ai cloud link gate
OK Sync Init Schema + Triggers trg_dp_zone_recs_outbox_ai cloud link gate
OK Sync Init Schema + Triggers creates trg_dp_zone_recs_outbox_au at runtime
OK seed-blank.sql defines trg_dp_zone_recs_outbox_au
OK seed-blank.sql trg_dp_zone_recs_outbox_au cloud link gate
OK Sync Init Schema + Triggers trg_dp_zone_recs_outbox_au cloud link gate
OK Sync Init Schema + Triggers creates trg_sync_device_data_dirty_au at runtime
OK seed-blank.sql defines trg_sync_device_data_dirty_au
OK Sync Init Schema + Triggers creates trg_sync_chameleon_readings_dirty_au at runtime
OK seed-blank.sql defines trg_sync_chameleon_readings_dirty_au
OK Sync Init Schema + Triggers creates trg_sync_dendro_readings_dirty_au at runtime
OK seed-blank.sql defines trg_sync_dendro_readings_dirty_au
OK Sync Init Schema + Triggers creates trg_sync_zone_env_dirty_ai at runtime
OK seed-blank.sql defines trg_sync_zone_env_dirty_ai
OK Sync Init Schema + Triggers creates trg_sync_zone_env_dirty_au at runtime
OK seed-blank.sql defines trg_sync_zone_env_dirty_au
OK Sync Init Schema + Triggers creates trg_sync_zone_recs_dirty_ai at runtime
OK seed-blank.sql defines trg_sync_zone_recs_dirty_ai
OK Sync Init Schema + Triggers creates trg_sync_zone_recs_dirty_au at runtime
OK seed-blank.sql defines trg_sync_zone_recs_dirty_au
OK Sync Init Schema + Triggers creates trg_sync_dendro_daily_dirty_ai at runtime
OK seed-blank.sql defines trg_sync_dendro_daily_dirty_ai
OK Sync Init Schema + Triggers creates trg_sync_dendro_daily_dirty_au at runtime
OK seed-blank.sql defines trg_sync_dendro_daily_dirty_au
OK Sync Init Schema + Triggers records history dirty keys at runtime
OK Sync Init Schema + Triggers adds shadow cursor id progress at runtime
OK Sync Init Schema + Triggers adds shadow cursor key progress at runtime
OK Sync Init Schema + Triggers adds shadow cursor error state at runtime
OK Sync Init Schema + Triggers fails closed when irrigation UUID generation lacks a gateway identity
OK Sync Init Schema + Triggers removed random irrigation UUID fallback
OK Sync Init Schema + Triggers trg_dp_irrigation_events_outbox_ai mirrors stable irrigation event UUIDs in outbox payloads
OK Sync Init Schema + Triggers ignores deleted devices when mirroring device-data zone bindings into the outbox
OK Sync Init Schema + Triggers ignores deleted devices when mirroring device-data gateway bindings into the outbox
OK Sync Init Schema + Triggers ignores deleted zones when mirroring zone environment rows into the outbox
OK Sync Init Schema + Triggers ignores deleted zones when mirroring zone environment gateway bindings into the outbox
OK Sync Init Schema + Triggers ignores deleted zones when mirroring irrigation events into the outbox
OK Sync Init Schema + Triggers ignores deleted zones when mirroring irrigation event gateway bindings into the outbox
OK Build History Batch loads history sync helper via osi-lib
OK Mark History Batch ACK marks history batches via the osi-lib-loaded helper
OK Build History Batch records helper-load failure into sync_state
OK Mark History Batch ACK records helper-load failure into sync_state
OK Build History Batch runs each history table in shadow mode first
OK Build History Batch uses the complete durable history table registry
OK Build History Batch rotates history tables fairly
OK Build History Batch uses history hash v1
OK Build History Batch posts history batches to the v1 history endpoint
OK Build History Batch history batch fails closed without sync token
OK Build History Batch history batch stops before unauthenticated post
OK Build History Batch removed malformed trailing slash normalizer in history sync builder
OK Build History Batch uses registry-owned bounded history queries
OK Build History Batch honors history cursor retry backoff before building a batch
OK Build History Batch uses shadow ACK progress while shadowing
OK Build History Batch hashes and validates rows through the shared helper
OK Build History Batch captures raw backfill high-water mark
OK Build History Batch captures natural-key backfill high-water marks
OK Build History Batch drains correction and repair dirty keys
OK POST History Batch uses the shared IPv4 cloud HTTP helper for history batches
OK Mark History Batch ACK keeps shadow cursor progress separate from durable progress
OK Mark History Batch ACK uses helper gate before applying durable history ACKs
OK Mark History Batch ACK durable ACK requires confirmed server mirror writes
OK Mark History Batch ACK history batch marker handles explicit ACK before raw trigger removal
OK Mark History Batch ACK stores shadow ACK id separately from durable ACKs
OK Mark History Batch ACK stores shadow ACK key separately from durable ACKs
OK Mark History Batch ACK reports shadow ACK errors without confirming durable mirror writes
OK Mark History Batch ACK recomputes bounded parity segments after durable ACKs
OK Mark History Batch ACK persists the zero-tombstone history contract
OK Build History Manifest builds history manifests from cached segments
OK Build History Manifest uses a real newline separator for history manifest SQL
OK Build History Manifest removed does not use a literal backslash-n separator for history manifest SQL
OK Build History Manifest posts history manifests to the v1 manifest endpoint
OK Build History Manifest history manifest fails closed without sync token
OK Build History Manifest history manifest builder skips empty manifest posts
OK Build History Manifest history manifest stops before unauthenticated post
OK Mark History Manifest ACK turns manifest mismatches into repair work
OK Mark History Manifest ACK persists requested history repairs
OK Mark History Manifest ACK removed never treats manifests as deletion instructions
OK seed-blank.sql raw correction dirty-key trigger exists before raw trigger removal
OK Sync Init Schema + Triggers removed malformed literal gateway fallback SQL in sync triggers
OK Sync Init Schema + Triggers removed double-quoted gatewaySql fallback fragments in sync init SQL
OK Build Cloud Bootstrap derives gateway migration candidates only from structural lineage
OK Build Edge Event Batch derives gateway migration candidates only from structural lineage
OK Build Pending Command Pull derives gateway migration candidates only from structural lineage
OK Run Force Sync derives gateway migration candidates only from structural lineage
OK Build Cloud Bootstrap stores gateway migration candidate source diagnostics
OK Build Edge Event Batch stores gateway migration candidate source diagnostics
OK Build Pending Command Pull stores gateway migration candidate source diagnostics
OK Run Force Sync stores gateway migration candidate source diagnostics
OK Build Cloud Bootstrap stores rejected gateway migration candidates
OK Build Edge Event Batch stores rejected gateway migration candidates
OK Build Pending Command Pull stores rejected gateway migration candidates
OK Run Force Sync stores rejected gateway migration candidates
OK Build Cloud Bootstrap removed pending outbox rows as gateway migration candidates
OK Build Edge Event Batch removed pending outbox rows as gateway migration candidates
OK Build Pending Command Pull removed pending outbox rows as gateway migration candidates
OK Run Force Sync removed pending outbox rows as gateway migration candidates
OK Build Cloud Bootstrap uses linked cloud usernames in bootstrap device snapshots
OK Build Cloud Bootstrap uses linked cloud usernames in bootstrap zone snapshots
OK Build Cloud Bootstrap includes STREGA model metadata in bootstrap device snapshots
OK Build Cloud Bootstrap includes STREGA current state in bootstrap device snapshots
OK Build Cloud Bootstrap includes STREGA target state in bootstrap device snapshots
OK Build Cloud Bootstrap includes observed LSN50 mode in bootstrap sensor data
OK Build Cloud Bootstrap includes dendrometer reference voltage in bootstrap sensor data
OK Build Cloud Bootstrap includes dendrometer ratio in bootstrap sensor data
OK Build Cloud Bootstrap includes the selected dendrometer path in bootstrap sensor data
OK Build Cloud Bootstrap includes baseline-relative stem change in bootstrap sensor data
OK Build Cloud Bootstrap includes zone area in bootstrap snapshots
OK Build Cloud Bootstrap includes zone irrigation efficiency in bootstrap snapshots
OK Build Cloud Bootstrap includes the prediction-card flag in bootstrap snapshots
OK Build Cloud Bootstrap includes normalized rain telemetry in bootstrap sensor data
OK Build Cloud Bootstrap includes normalized flow telemetry in bootstrap sensor data
OK Build Cloud Bootstrap synthesizes stable irrigation event UUIDs for bootstrap snapshots
OK Build Cloud Bootstrap includes gateway GPS state in bootstrap payloads
OK Build Cloud Bootstrap includes installation gateway history during bootstrap migration
OK Build Cloud Bootstrap includes the stable installation identity in bootstrap metadata
OK Build Cloud Bootstrap advertises the installation recovery capability in bootstrap metadata
OK Build Cloud Bootstrap includes the edge build version in bootstrap gateway metadata
OK Build Cloud Bootstrap includes sync capabilities in bootstrap gateway metadata
OK Build Cloud Bootstrap includes the versioned zone desired-state capability in bootstrap metadata
OK Build Cloud Bootstrap includes the protected device desired-state capability in bootstrap metadata
OK Build Cloud Bootstrap includes the weather-station zone desired-state capability in bootstrap metadata
OK Build Cloud Bootstrap runs local gateway migration preflight before bootstrap sync
OK Build Cloud Bootstrap pauses normal sync while a gateway migration repair bootstrap is pending
OK Build Cloud Bootstrap rewrites active zone gateway bindings during local migration
OK Build Cloud Bootstrap rewrites active device gateway bindings during local migration
OK Build Cloud Bootstrap rewrites undelivered sync outbox rows during local migration
OK Build Cloud Bootstrap surfaces rejected migration candidates in bootstrap migration state
OK Mark Bootstrap Synced recognizes successful cloud-side gateway migration responses
OK Mark Bootstrap Synced resumes normal sync after repair bootstrap succeeds
OK Build Edge Event Batch suppresses event delivery while gateway migration is paused
OK Build Edge Event Batch opts edge event delivery into sync protocol v2
OK Build Edge Event Batch excludes terminal rejected outbox events from normal delivery batches
OK Mark Synced Events Delivered marks delivered only for terminal protocol-v2 event results
OK Mark Synced Events Delivered parses per-event protocol-v2 result statuses
OK Mark Synced Events Delivered tracks rejected protocol-v2 event results separately from delivered results
OK Mark Synced Events Delivered stores rejected protocol-v2 event reasons in sync_outbox
OK Mark Synced Events Delivered marks rejected protocol-v2 event results without setting delivered_at
OK Run Force Sync tracks rejected force-sync event results separately from delivered results
OK Run Force Sync stores rejected force-sync event reasons in sync_outbox
OK Run Force Sync marks rejected force-sync event results without setting delivered_at
OK Run Force Sync excludes terminal rejected outbox events from force-sync delivery batches
OK Build Pending Command Pull suppresses pending-command polling while gateway migration is paused
OK Build Pending Command Pull opts pending-command polling into command lease protocol v2
OK Replay Pending Commands accepts protocol-v2 pending-command envelopes
OK Replay Pending Commands preserves command lease expiry in queued command payloads
OK Sync Init Schema + Triggers creates the edge command replay ledger during sync init
OK Sync Init Schema + Triggers creates the canonical applied_commands.result_detail column
OK Sync Init Schema + Triggers creates/applies applied_commands retry accounting columns
OK Sync Init Schema + Triggers creates/applies applied_commands ACK retry timestamp column
OK Sync Init Schema + Triggers creates the durable edge command ACK outbox during sync init
OK Deduplicate Pending Command delegates exact stored-result replay before dispatch via the shared command ledger
OK Deduplicate Pending Command fails closed when replay-ledger lookup is unavailable
OK command-dedupe-dispatch classifies the protected command type before mandatory and optional helper loading
OK command-dedupe-dispatch keeps DB and ledger mandatory for every protected command
OK command-dedupe-dispatch surfaces unavailable optional journal replay hooks
OK command-dedupe-dispatch passes only non-terminal commands to effect dispatch
OK command-dedupe-dispatch removed keeps terminal and replay ACKs in the durable REST outbox
OK command-dedupe-dispatch exposes only the normal effect output
OK journal-command-apply-fn passes non-journal commands toward legacy dispatch before loading journal helpers
OK scoped-access-command-apply-fn passes protected scoped-access commands through the transactional helper
OK scoped-access-command-apply-fn fails closed when scoped-access helpers are unavailable
OK scoped-access-command-apply-fn closes the scoped-access command database handle
OK zone-command-apply-fn passes protected zone commands through the transactional helper
OK zone-command-apply-fn fails closed when zone helpers are unavailable
OK zone-command-apply-fn invalidates cached scope after an applied zone mutation
OK zone-command-apply-fn closes the zone command database handle
OK irrigation-config-command-apply-fn routes only protected irrigation-config commands through the transactional helper
OK irrigation-config-command-apply-fn fails closed when irrigation-config helpers are unavailable
OK irrigation-config-command-apply-fn closes the irrigation-config command database handle
OK device-command-apply-fn routes only protected device commands through the transactional helper
OK device-command-apply-fn fails closed when protected device helpers are unavailable
OK device-command-apply-fn invalidates cached scope after an applied protected device mutation
OK device-command-apply-fn closes the protected device command database handle
OK d7e5c762c820aa16 increments the schedule aggregate version for local writes
OK d7e5c762c820aa16 persists the independent schedule aggregate version
OK d7e5c762c820aa16 removed parent-zone version mutation from local schedule writes
OK zone-calibration-fn loads the calibration aggregate version for local writes
OK zone-calibration-fn distinguishes a missing calibration row from one already at version 0
OK zone-calibration-fn increments the independent calibration aggregate version
OK zone-calibration-fn persists local calibration desired state without marking it cloud-applied
OK zone-calibration-fn binds local calibration write parameters
OK zone-calibration-fn removed parent-zone version mutation from local calibration writes
OK osi-command-ledger/index.js looks up exact command IDs before payload validation
OK osi-command-ledger/index.js checks physical-action expiry before effect dispatch
OK osi-command-ledger/index.js treats equality at the expiry boundary as terminal
OK osi-command-ledger/index.js persists pre-dispatch expiry decisions through the command ledger
OK osi-journal/commands.js reconstructs ACK facts from canonical replay-ledger detail
OK osi-scoped-access-commands/index.js applies scoped-access mutations and terminal ACK persistence in one transaction
OK osi-scoped-access-commands/index.js rejects stale scoped-access commands with a terminal conflict
OK osi-scoped-access-commands/index.js protects the final enabled gateway admin
OK osi-scoped-access-commands/index.js invalidates cached scope after an applied mutation
OK osi-zone-commands/index.js applies zone mutations and terminal ACK persistence in one transaction
OK osi-zone-commands/index.js rejects protected zone payload shape drift
OK osi-zone-commands/index.js pins the protected zone aggregate contract version
OK osi-zone-commands/index.js rejects stale zone commands with a terminal conflict
OK osi-zone-commands/index.js detaches devices before tombstoning a zone
OK osi-zone-commands/index.js persists the terminal zone ACK atomically with the mutation
OK osi-irrigation-config-commands/index.js applies irrigation config and its terminal ACK in one transaction
OK osi-irrigation-config-commands/index.js requires consecutive irrigation config versions
OK osi-irrigation-config-commands/index.js registers protected calibration desired state
OK osi-irrigation-config-commands/index.js persists irrigation config ACKs atomically
OK osi-device-commands/index.js applies protected device state and its terminal ACK in one transaction
OK osi-device-commands/index.js requires consecutive protected device versions
OK osi-device-commands/index.js updates the canonical device aggregate
OK osi-device-commands/index.js persists protected device ACKs atomically
OK osi-device-commands/index.js removed runtime valve observations from protected device writes
OK osi-device-commands/index.js removed runtime valve targets from protected device writes
OK osi-device-commands/weather.js replaces weather assignments and persists the terminal ACK in one transaction
OK osi-device-commands/weather.js rejects weather assignment commands for other device families
OK osi-device-commands/weather.js replaces the complete weather assignment set
OK osi-device-commands/weather.js persists weather assignment ACKs atomically
OK s2120-zones-put-auth-fn uses the versioned aggregate helper for local weather assignment writes
OK s2120-zones-put-auth-fn returns the weather assignment aggregate version
OK Queue REST Command ACK delegates atomic terminal ledger and ACK queueing via the shared command ledger
OK osi-command-ledger/index.js never rewrites an existing terminal command result
OK osi-command-ledger/index.js queues durable REST command ACKs in the shared transaction helper
OK Queue REST Command ACK removed legacy applied_commands.detail insert column
OK Queue REST Command ACK removed terminal ledger rewrite SQL
OK Build Command ACK Batch posts queued command ACKs to the sync REST endpoint
OK Build Command ACK Batch opts REST command ACKs into sync protocol v2
OK Mark Command ACKs Delivered marks REST command ACK rows delivered only after a successful response
OK command-ack-mark-delivered requires an eligible integer HTTP 200 before evaluating any per-entry ACK result
OK command-ack-mark-delivered delivers a command ACK outbox row only for a single unambiguous accepted-terminal result
OK command-ack-mark-delivered resolves the server business commandId to local outbox row ids via the build-batch correlation map, not the row PKs directly
OK command-ack-mark-delivered falls back to id-as-commandId only when no correlation metadata is present, preserving the pre-fix per-entry contract
OK command-ack-build-batch detects conflicting local ACK rows for the same commandId by canonical payload equality
OK command-ack-build-batch carries local outbox row correlation for collapsed duplicate ACKs
OK command-ack-build-batch withholds delivery and warns on conflicting local ACK rows without leaking lease tokens
OK sync-pending-split routes WORK_REQUEST_STATUS before the actuator replay guard
OK sync-pending-split has separate normal/status outputs
OK sync-pending-split routes WORK_REQUEST_STATUS to status apply
OK work-request-status-apply declares osiDb for local improvement_requests status updates
OK work-request-status-apply updates improvement request cloud status fields
OK work-request-status-apply records the cloud status timestamp
OK work-request-status-apply queues WORK_REQUEST_STATUS ACKs through the durable ACK queue
OK work-request-status-apply guards a replay of the same commandId against the shipped applied_commands ledger before re-UPDATE-ing improvement_requests
OK work-request-status-apply rebuilds and returns the original terminal ACK verbatim on replay, using the stored applied_at instead of call-time now, without mutating the request again
OK work-request-status-apply writes the applied_commands dedup marker in the same shape osi-command-ledger.queueCommandAck writes, so a replayed ack downstream is byte-for-byte unchanged
OK sync-pending-split gates lastPendingCommandPollSuccessAt on an explicit integer 2xx predicate, never a truthy/0/string statusCode
OK reject-indefinite-open produces a durable REJECTED_PERMANENT ack instead of silently dropping a permanently-invalid command
OK reject-indefinite-open routes every permanent-rejection path (indefinite OPEN, unknown type, missing duration) through the durable ACK output
OK reject-indefinite-open removed WORK_REQUEST_STATUS actuator/downlink handling
OK command-dedupe-dispatch removed WORK_REQUEST_STATUS actuator/downlink handling
OK 934bf2bc19a8ce22 removed WORK_REQUEST_STATUS actuator/downlink handling
OK cdbaa3891d40d7a1 removed WORK_REQUEST_STATUS actuator/downlink handling
OK write-strega-expectation removed WORK_REQUEST_STATUS actuator/downlink handling
OK cmd-type-registry removed WORK_REQUEST_SUBMITTED actuator/downlink handling
OK reject-indefinite-open removed WORK_REQUEST_SUBMITTED actuator/downlink handling
OK command-dedupe-dispatch removed WORK_REQUEST_SUBMITTED actuator/downlink handling
OK 934bf2bc19a8ce22 removed WORK_REQUEST_SUBMITTED actuator/downlink handling
OK cdbaa3891d40d7a1 removed WORK_REQUEST_SUBMITTED actuator/downlink handling
OK write-strega-expectation removed WORK_REQUEST_SUBMITTED actuator/downlink handling
OK e73a11a2a36aab22 does not subscribe to WORK_REQUEST_SUBMITTED over MQTT
OK e382bbf0dde572b1 does not subscribe to WORK_REQUEST_SUBMITTED over MQTT
OK 983d2de5486eeb4d does not subscribe to WORK_REQUEST_SUBMITTED over MQTT
OK lsn50-mqtt-in does not subscribe to WORK_REQUEST_SUBMITTED over MQTT
OK s2120-mqtt-in does not subscribe to WORK_REQUEST_SUBMITTED over MQTT
OK lorain-mqtt-in does not subscribe to WORK_REQUEST_SUBMITTED over MQTT
OK c571729fb2943059 does not subscribe to WORK_REQUEST_SUBMITTED over MQTT
OK sdi12-mqtt-in does not subscribe to WORK_REQUEST_SUBMITTED over MQTT
OK improvement-requests-api-router declares osiDb for field request intake
OK improvement-requests-api-router declares crypto for verifyBearer
OK improvement-requests-api-router contains the local HMAC bearer verifier
OK improvement-requests-api-router requires explicit public consent
OK improvement-requests-api-router rejects request bodies at or above 65536 bytes
OK improvement-requests-api-router validates title length 3-80
OK improvement-requests-api-router validates description length 10-4000
OK improvement-requests-api-router generates a 32-byte status secret
OK improvement-requests-api-router hashes the status secret before storage
OK improvement-requests-api-router stores the status secret hash
OK improvement-requests-api-router returns the one-time status secret
OK improvement-requests-api-router stores optional contact email
OK improvement-requests-api-router defines the diagnostics JSON byte cap
OK improvement-requests-api-router stores capped diagnostics JSON
OK improvement-requests-api-router includes GUI version in diagnostics
OK improvement-requests-api-router summarizes sync_state diagnostics
OK improvement-requests-api-router prefers flow gateway_health diagnostics
OK improvement-requests-api-router falls back to global edge_health diagnostics
OK improvement-requests-api-router redacts bearer tokens from user text
OK improvement-requests-api-router redacts password/credential patterns from user text
OK improvement-requests-api-router redacts JWT-like strings from user text
OK improvement-requests-api-router redacts AppKey-like 32-hex strings from user text
OK improvement-requests-api-router redacts email patterns from user text
OK improvement-requests-api-router redacts 16-hex EUI patterns from user text
OK improvement-requests-api-router uses fixed [REDACTED] replacement for user text
OK improvement-requests-api-router honors diagnostics consent before collecting private diagnostics
OK improvement-requests-api-router builds private diagnostics only when diagnostics consent is granted
OK improvement-requests-api-router stores empty diagnostics when diagnostics consent is declined
OK improvement-requests-api-router builds a display-redacted diagnostics preview
OK improvement-requests-api-router returns the display-redacted diagnostics preview payload
OK improvement-requests-api-router redacts raw gateway EUI in diagnostics preview
OK improvement-requests-api-router inserts local field requests
OK improvement-requests-api-router persists optional contact email separately from redacted request text
OK improvement-requests-api-router rejects invalid contact_email before insert
OK improvement-requests-api-router documents trigger-emitted WORK_REQUEST_SUBMITTED intake contract
OK support-delivery-tick support delivery has a scheduled inject node
OK support-delivery-tick support delivery tick routes to worker
OK support-delivery-tick runs every 300 seconds / 300000 ms
OK support-delivery-worker support delivery worker is a function node
OK support-delivery-worker declares osiDb for queued improvement request reads
OK support-delivery-worker uses shared IPv4 HTTP client
OK support-delivery-worker scans queued improvement requests past backed-off rows
OK support-delivery-worker loads the matching WORK_REQUEST_SUBMITTED outbox payload
OK support-delivery-worker posts to the support edge work-request endpoint
OK support-delivery-worker posts through shared IPv4 HTTP helper
OK support-delivery-worker resolves support server URL from sync_state first
OK support-delivery-worker resolves support server URL from OSI_CLOUD_SERVER_URL second
OK support-delivery-worker falls back to the default support server URL
OK support-delivery-worker sends no Authorization header
OK support-delivery-worker removed support delivery Authorization header transmission
OK support-delivery-worker accepts result or status as terminal support response state
OK support-delivery-worker loads retry state from flow context
OK support-delivery-worker persists retry state to flow context
OK support-delivery-worker implements bounded exponential backoff
OK support-delivery-worker caps missing outbox retry state
OK support-delivery-worker marks stale missing outbox payloads terminal
OK support-delivery-worker tracks attempted rows separately from skipped backoff rows
OK support-delivery-worker prevents backed-off rows from consuming the delivery tick
OK support-delivery-worker marks accepted or duplicate work requests submitted
OK support-delivery-worker marks terminally rejected work requests rejected
OK support-delivery-worker retries on 404 instead of permanently rejecting
OK support-delivery-worker guards cloud_status update against clobbering fresher statuses
OK support-delivery-worker closes the delivery worker database handle
OK seed-blank.sql improvement request trigger exists
OK seed-blank.sql improvement request trigger emits WORK_REQUEST_SUBMITTED
OK seed-blank.sql improvement request trigger emits WORK_REQUEST aggregate type
OK cmd-type-registry allows cloud zone-detach commands through the pending-command guard
OK cmd-type-registry allows cloud device-unclaim commands through the pending-command guard
OK Reject Indefinite Open fallback command registry allows zone-detach commands before startup registry loads
OK Reject Indefinite Open fallback command registry allows device-unclaim commands before startup registry loads
OK Build UPDATE SQL accepts schema-shaped device_eui payloads for device-scoped SQL commands
OK sync-pending-split routes pending cloud commands through the indefinite-open guard before the replay ledger
OK sync-force-build routes force-sync replayed commands through the indefinite-open guard before the replay ledger
OK reject-indefinite-open routes guarded cloud commands through the replay ledger
OK reject-indefinite-open routes permanent rejection ACKs around the command deduper and into the durable ACK queue
OK command-dedupe-dispatch routes non-duplicates through the journal-aware command applier
OK journal-command-apply-fn preserves the legacy output while routing non-journal commands onward
OK journal-command-apply-fn routes non-journal commands through scoped-access handling
OK scoped-access-command-apply-fn routes non-access commands through protected zone handling
OK scoped-access-command-apply-fn publishes atomically persisted scoped-access ACKs
OK zone-command-apply-fn routes non-zone commands through protected irrigation-config handling
OK zone-command-apply-fn publishes atomically persisted zone ACKs
OK irrigation-config-command-apply-fn routes non-irrigation commands through protected device handling
OK irrigation-config-command-apply-fn publishes atomically persisted irrigation-config ACKs
OK device-command-apply-fn falls through legacy device commands to the existing router
OK device-command-apply-fn publishes atomically persisted protected device ACKs
OK c8628cffe45f64f7 routes STREGA command ACKs through the durable ACK queue
OK cs-reg-cloud-ack-fn routes special command ACKs through the durable ACK queue
OK lsn50-mode-ack-link-in routes LSN50 command ACKs through the durable ACK queue
OK command-ack-queue-rest preserves MQTT command ACK telemetry after durable queueing
OK has a scheduled sync outbox retention tick
OK sync outbox retention runs daily at 02:00
OK Prune Sync Outbox uses a configurable sync outbox retention window
OK Prune Sync Outbox prunes delivered sync outbox rows
OK Prune Sync Outbox does not prune pending sync outbox rows
OK Prune Sync Outbox attempts a WAL checkpoint after deleting old outbox rows
OK outbox-retention-tick runs the sync outbox retention function
OK Run Force Sync uses sync protocol v2 for manual force-sync outbox and command polling
OK Run Force Sync manual force-sync marks only terminal protocol-v2 event results delivered
OK Run Force Sync manual force-sync accepts protocol-v2 pending-command envelopes
OK Build Sync State returns gateway identity diagnostics in sync state
OK Build Sync State reports pending gateway migration state in sync state
OK Build Sync State reports last gateway migration result in sync state
OK Build Cloud Bootstrap loads bootstrap sensor history before reordering it
OK Build Cloud Bootstrap replays bootstrap sensor history oldest-to-newest
OK Build Cloud Bootstrap loads bootstrap dendro history before reordering it
OK Build Cloud Bootstrap replays bootstrap dendro history oldest-to-newest
OK Build Cloud Bootstrap normalizes malformed edge timestamps before bootstrap sync
OK Build Cloud Bootstrap normalizes zone tombstone timestamps before bootstrap sync
OK Build Cloud Bootstrap exports the prediction-card flag in bootstrap payloads
OK Build Cloud Bootstrap normalizes device tombstone timestamps before bootstrap sync
OK Build Cloud Bootstrap normalizes schedule timestamps before bootstrap sync
OK Build Cloud Bootstrap loads irrigation calibration desired state for bootstrap sync
OK Build Cloud Bootstrap includes irrigation calibration desired state in bootstrap payloads
OK Build Cloud Bootstrap includes the irrigation-config desired-state capability in bootstrap metadata
OK Build Cloud Bootstrap ignores deleted devices when exporting bootstrap sensor history
OK Build Cloud Bootstrap ignores deleted devices when exporting bootstrap dendro history
OK Build Cloud Bootstrap ignores deleted zones when exporting bootstrap history
OK Mark Bootstrap Synced preserves server ProblemDetail details for bootstrap errors
OK al-link-handle-auth persists MQTT credentials after successful account linking
OK al-link-store-mqtt finalizes linked-account state only after MQTT config persistence
OK al-link-finalize formats a success response only after linked-account finalization
OK al-link-finalize rolls back MQTT credentials when linked-account finalization fails
OK al-link-success schedules restart only after link success is fully prepared
OK al-link-restart-node-red triggers an immediate bootstrap only after scheduling the link restart
OK al-link-restart-node-red clears transient link state only after successful link restart scheduling
OK al-link-build-claim removed the legacy claim-bulk account-link request path
OK al-link-server-claim removed the legacy claim-bulk account-link HTTP request path
OK al-link-handle-claim removed the legacy claim-bulk response handler
OK al-link-db-update removed the legacy pre-MQTT link finalization query
OK sync-bootstrap-account-link-in routes post-link bootstrap triggers into the bootstrap builder
OK al-unlink-func clears MQTT credentials only after unlink auth succeeds
OK al-unlink-clear-mqtt clears linked account state only after MQTT credentials are removed
OK al-unlink-db restores MQTT credentials when unlink database cleanup fails
OK al-unlink-format schedules restart only after unlink state is cleared successfully
OK al-unlink-restart-node-red clears transient link state only after successful unlink restart scheduling
OK Persist MQTT Broker Config writes the MQTT password into UCI after linking
OK Persist MQTT Broker Config persists the linked gateway identity into UCI after linking
OK Persist MQTT Broker Config fails linking when MQTT credentials are incomplete
OK Persist MQTT Broker Config backs up prior MQTT config before persisting linked credentials
OK Persist MQTT Broker Config falls back to regex host extraction when URL is unavailable
OK Persist MQTT Broker Config removed Node-RED restart while link persistence is still in flight
OK al-link-handle-auth clears transient link state when server auth fails
OK al-link-store-mqtt clears transient link state when MQTT persistence fails
OK Clear MQTT Broker Config clears the MQTT password from UCI after unlinking
OK Clear MQTT Broker Config clears the linked gateway identity from UCI after unlinking
OK Clear MQTT Broker Config backs up prior MQTT config before unlink cleanup
OK Clear MQTT Broker Config removed Node-RED restart while unlink cleanup is still in flight
OK Rollback MQTT Broker Config restores prior MQTT config when link finalization fails
OK Restore MQTT Broker Config restores prior MQTT config when unlink finalization fails
OK Schedule Link Restart requests a daemon-owned restart only after successful link completion
OK Schedule Link Restart uses the account-link restart contract
OK Schedule Link Restart removed does not restart Node-RED directly
OK Schedule Unlink Restart requests a daemon-owned restart only after successful unlink completion
OK Schedule Unlink Restart uses the account-unlink restart contract
OK Schedule Unlink Restart removed does not restart Node-RED directly
OK al-link-server-auth uses function node for IPv4 cloud REST
OK al-link-server-auth imports the IPv4 cloud REST helper
OK al-link-server-auth calls requestJsonIpv4
OK al-link-server-auth preserves IPv4 request failures as message payloads
OK sync-bootstrap-http uses function node for IPv4 cloud REST
OK sync-bootstrap-http imports the IPv4 cloud REST helper
OK sync-bootstrap-http calls requestJsonIpv4
OK sync-bootstrap-http preserves IPv4 request failures as message payloads
OK sync-outbox-http uses function node for IPv4 cloud REST
OK sync-outbox-http imports the IPv4 cloud REST helper
OK sync-outbox-http calls requestJsonIpv4
OK sync-outbox-http preserves IPv4 request failures as message payloads
OK sync-pending-http uses function node for IPv4 cloud REST
OK sync-pending-http imports the IPv4 cloud REST helper
OK sync-pending-http calls requestJsonIpv4
OK sync-pending-http preserves IPv4 request failures as message payloads
OK sync-refresh-http uses function node for IPv4 cloud REST
OK sync-refresh-http imports the IPv4 cloud REST helper
OK sync-refresh-http calls requestJsonIpv4
OK sync-refresh-http preserves IPv4 request failures as message payloads
OK Run Force Sync uses the shared IPv4 cloud REST helper
OK sync-force-build imports the IPv4 helper for manual force sync
OK Run Force Sync uses linked cloud usernames in force-sync device snapshots
OK Run Force Sync uses linked cloud usernames in force-sync zone snapshots
OK Run Force Sync includes STREGA model metadata in force-sync device snapshots
OK Run Force Sync includes STREGA current state in force-sync device snapshots
OK Run Force Sync includes STREGA target state in force-sync device snapshots
OK Run Force Sync includes observed LSN50 mode in force-sync sensor data
OK Run Force Sync includes dendrometer reference voltage in force-sync sensor data
OK Run Force Sync includes dendrometer ratio in force-sync sensor data
OK Run Force Sync includes the selected dendrometer path in force-sync sensor data
OK Run Force Sync includes baseline-relative stem change in force-sync sensor data
OK Run Force Sync includes zone area in force-sync snapshots
OK Run Force Sync includes zone irrigation efficiency in force-sync snapshots
OK Run Force Sync includes the prediction-card flag in force-sync snapshots
OK Run Force Sync includes normalized rain telemetry in force-sync sensor data
OK Run Force Sync includes normalized flow telemetry in force-sync sensor data
OK Run Force Sync synthesizes stable irrigation event UUIDs for forced bootstrap snapshots
OK Run Force Sync includes gateway GPS state in forced sync payloads
OK Run Force Sync includes the edge build version in forced bootstrap gateway metadata
OK Run Force Sync includes sync capabilities in forced bootstrap gateway metadata
OK Run Force Sync includes the versioned zone desired-state capability in forced bootstrap metadata
OK Run Force Sync includes the irrigation-config desired-state capability in forced bootstrap metadata
OK Run Force Sync includes the protected device desired-state capability in forced bootstrap metadata
OK Run Force Sync includes the weather-station zone desired-state capability in forced bootstrap metadata
OK Run Force Sync loads force-sync sensor history before reordering it
OK Run Force Sync replays force-sync sensor history oldest-to-newest
OK Run Force Sync loads force-sync dendro history before reordering it
OK Run Force Sync replays force-sync dendro history oldest-to-newest
OK Run Force Sync normalizes malformed edge timestamps before forced bootstrap sync
OK Run Force Sync normalizes zone tombstone timestamps before forced bootstrap sync
OK Run Force Sync exports the prediction-card flag in forced bootstrap payloads
OK Run Force Sync normalizes device tombstone timestamps before forced bootstrap sync
OK Run Force Sync normalizes schedule timestamps before forced bootstrap sync
OK Run Force Sync loads irrigation calibration desired state for force sync
OK Run Force Sync includes irrigation calibration desired state in force-sync payloads
OK Run Force Sync ignores deleted devices when exporting force-sync sensor history
OK Run Force Sync ignores deleted devices when exporting force-sync dendro history
OK Run Force Sync ignores deleted zones when exporting force-sync history
OK Run Force Sync preserves server ProblemDetail details in force-sync bootstrap errors
OK Run Force Sync initializes pending-command apply semantics in force-sync summary
OK Run Force Sync marks force-sync pending commands as applying after the HTTP response
OK Run Force Sync reports force-sync pending-command apply phase explicitly
OK Run Force Sync supports internally queued force-sync sweeps from cloud commands
OK Run Force Sync filters pending commands before queueing them locally
OK Run Force Sync prevents force-edge-sync commands from recursing through pending-command replay
OK Run Force Sync surfaces rejected migration candidates in force-sync migration state
OK Daily Dendrometer Analytics uses calibration-aware recovery threshold
OK Daily Dendrometer Analytics uses absolute night TWD in recovery verification
OK Daily Dendrometer Analytics uses the exact previous-three-day recovery window
OK Daily Dendrometer Analytics downgrades stress on high-VPD good-recovery days
OK Daily Dendrometer Analytics upgrades stress on low-VPD poor-recovery days
OK Daily Dendrometer Analytics computes rolling SD-VPD correlation
OK Daily Dendrometer Analytics flags SD-VPD decoupling against the baseline
OK Daily Dendrometer Analytics requires completed baselines for recovery verification pass checks
OK Daily Dendrometer Analytics requires strong MDS recovery before ending verification
OK Daily Dendrometer Analytics stores VPD override diagnostics in recommendation_json
OK Daily Dendrometer Analytics stores SD-VPD diagnostics in recommendation_json
OK Get Zone Recommendations returns recommendation_json from the zone recommendation query
OK Get Zone Recommendations exposes recommendation_json in the local recommendations API
OK Daily Dendrometer Analytics supports configurable OpenAgri history search radius for edge analytics
OK Get Zone Environment Summary creates a local weather cache table for environment summaries
OK Get Zone Environment Summary supports configurable current-weather cache TTL
OK Get Zone Environment Summary supports configurable forecast cache TTL
OK Get Zone Environment Summary uses imported HTTP clients inside the Node-RED function runtime
OK osi-zone-env/index.js prioritizes local sensor climate over online weather for agronomic metrics
OK Get Zone Environment Summary falls back to mirrored gateway coordinates when a zone has no explicit location
OK Get Zone Environment Summary uses daily zone environment totals for water summary
OK Get Zone Environment Summary sums STREGA expectation liters separately from measured flow meter totals
OK Get Zone Environment Summary buckets STREGA estimated liters by zone-local date
OK Get Zone Environment Summary excludes cancelled STREGA expectations from estimated irrigation totals
OK Get Zone Environment Summary removed UTC date slicing for STREGA estimated liters
OK Get Zone Environment Summary returns measured flow-meter liters under an honest field name
OK Get Zone Environment Summary returns estimated valve-time liters under an honest field name
OK Get Zone Environment Summary computes effective mm for measured irrigation separately
OK Get Zone Environment Summary computes effective mm for estimated irrigation separately
OK Get Zone Environment Summary preserves local measured/estimated irrigation split when shared server water is displayed
OK Get Zone Environment Summary returns the irrigation-split overlay instead of raw shared server water
OK Save Zone Irrigation Calibration upserts zone irrigation calibration through the local API
OK Save Zone Irrigation Calibration writes the measured flow rate to the calibration table
OK Save Zone Irrigation Calibration writes the operator-entered measurement method to the calibration table
OK Save Zone Irrigation Calibration removed NOT NULL measured flow rate in runtime calibration create table
OK Save Zone Irrigation Calibration removed NOT NULL measurement method in runtime calibration create table
OK Save Zone Irrigation Calibration removed NOT NULL measured-at timestamp in runtime calibration create table
OK Save Zone Irrigation Calibration removed NOT NULL created-at timestamp in runtime calibration create table
OK Save Zone Irrigation Calibration removed NOT NULL updated-at timestamp in runtime calibration create table
OK deploy.sh runs the ordered migration runner during deploy
OK deploy.sh fetches ordered migration files from the manifest during deploy
OK deploy.sh fetches the deploy-time migration CLI
OK deploy.sh fetches the semantic baseline tool for first-run devices
OK deploy.sh fetches the pre-baseline sync_outbox repair
OK deploy.sh deploys the weather-station assignment command helper
OK deploy.sh removed inline zone irrigation calibration DDL in deploy.sh
OK deploy.sh removed inline nullable measured flow rate deploy repair
OK deploy.sh removed inline nullable measurement method deploy repair
OK deploy.sh removed inline nullable measured-at deploy repair
OK deploy.sh removed inline nullable created-at deploy repair
OK deploy.sh removed inline nullable updated-at deploy repair
OK runtime zone_irrigation_calibration DDL columns match the nullable contract
OK api.ts adds a shared client helper for zone irrigation calibration
OK api.ts targets the local zone irrigation calibration endpoint
OK farming.ts types measured irrigation separately from estimated irrigation
OK farming.ts types estimated irrigation separately from measured irrigation
OK WaterTab.tsx removed legacy mixed irrigation fallback under the measured label
OK WaterTab.tsx removed legacy daily mixed irrigation fallback under the measured label
OK IrrigationZoneCard.tsx removed legacy mixed irrigation fallback under the measured label
OK Get Zone Environment Summary builds a dedicated water summary block
OK Get Zone Environment Summary falls back instead of throwing when weather providers fail
OK Get Zone Environment Summary wraps online weather section construction
OK Get Zone Environment Summary wraps forecast section construction
OK osi-zone-env/index.js returns the frontend daily forecast high-temperature field
OK osi-zone-env/index.js returns the frontend daily forecast low-temperature field
OK osi-zone-env/index.js returns the frontend daily forecast rain-probability field
OK osi-zone-env/index.js returns the frontend hourly forecast temperature field
OK Get Zone Environment Summary exposes zone area in water summary
OK Get Zone Environment Summary reports water sensor health and warnings
OK Build Telemetry publishes observed LSN50 mode in edge telemetry
OK Build Telemetry converts Kiwi watermark frequency telemetry to kPa for cloud mirroring
OK Build Telemetry gates LSN50-only telemetry fields by profile
OK Build Telemetry avoids assigning LSN50 mode codes to Kiwi telemetry
OK Build Telemetry skips valve uplinks in sensor telemetry mirroring
OK Build Telemetry applies sentinel-aware STREGA environmental normalization in cloud telemetry
OK Build Telemetry skips unknown no-data uplinks instead of defaulting them to Kiwi
OK Build Telemetry loads local dendrometer config before telemetry conversion
OK Build Telemetry reuses shared raw LSN50 ADC decoding in telemetry mirroring
OK Build Telemetry reuses shared dendrometer path selection in telemetry mirroring
OK Build Telemetry reuses shared dendrometer delta handling in telemetry mirroring
OK Build Telemetry publishes baseline-relative stem change in live MQTT telemetry
OK Build Telemetry removed dropping STREGA telemetry from cloud MQTT mirroring
OK Build Telemetry includes the gateway transport identity in cloud telemetry payloads
OK 81c98fb07344a787 uses env-backed Kiwi profile routing
OK 81c98fb07344a787 uses env-backed Clover profile routing
OK strega-process-fn derives STREGA profile routing on the dedicated edge path
OK strega-process-fn falls back to the managed STREGA codec when ChirpStack has no decoded object
OK strega-process-fn normalizes Gen1 STREGA battery values for local storage
OK strega-process-fn drops the FFFF/FFFF sentinel environmental pair in local storage
OK strega-process-fn maps the Gen1 STREGA valve bit into local OPEN/CLOSED state
OK Decode LSN50 uses the shared raw LSN50 ADC decoder
OK Decode LSN50 reads ADC_CH1V from decoded MOD3 payloads
OK Decode LSN50 reads ADC_CH4V when present without using it for dendrometer conversion
OK Decode LSN50 decodes observed LSN50 mode from shared raw uplink parsing
OK Decode LSN50 filters uplinks to the env-backed LSN50 profile
OK Decode LSN50 normalizes Chameleon payload version from decoder output
OK Decode LSN50 normalizes Chameleon compensated resistance fields
OK Decode LSN50 keeps the raw LoRaWAN payload base64 for Chameleon replay
OK dragino_lsn50_decoder.js ships Chameleon V2 frame detection
OK dragino_lsn50_decoder.js ships simplified Chameleon V2 status handling
OK Apply Config stores observed or configured LSN50 mode on ingest
OK Apply Config derives Chameleon SWT metrics without bypassing dendrometer logic
OK Apply Config stores derived SWT1 in formattedData
OK Apply Config keeps dendrometer enablement as the persistence gate after Chameleon derivation
OK Apply Config removed the old dedicated Chameleon bypass branch
OK Apply Config surfaces Chameleon status in node status text
OK Apply Config loads the last persisted MOD9 sample before computing deltas
OK Apply Config computes elapsed seconds between MOD9 uplinks
OK Apply Config treats counter decreases as resets instead of inflating deltas
OK Apply Config guards MOD9 deltas against duplicate and out-of-order uplinks
OK Apply Config derives a rain rate from the elapsed interval
OK Apply Config derives a flow rate from the elapsed interval
OK Apply Config derives normalized rain per 10 minutes
OK Apply Config derives normalized flow per 10 minutes
OK Apply Config derives running daily rain and flow totals from persisted counters
OK Apply Config uses the shared dual-path dendrometer conversion helper
OK Apply Config stores which dendrometer conversion path was applied
OK Apply Config stores the derived dendrometer ratio
OK Apply Config tracks missing ratio calibration without emitting NaN values
OK Apply Config resets dendrometer deltas when path or calibration changes
OK Apply Config derives a baseline-relative stem change signal for the basic card and monitor
OK Apply Config stores the baseline-relative stem change alongside mechanical position
OK Apply Config clears the pending-baseline flag when a new valid stem-change baseline is persisted
OK lsn50-config-query-fn keeps LSN50 config SELECT valid before the Chameleon calibration-status subquery
OK Insert Chameleon Reading persists decoded Chameleon readings locally
OK Insert Chameleon Reading passes non-Chameleon LSN50 payloads downstream
OK Build Cloud Bootstrap loads bootstrap Chameleon history before reordering it
OK Build Cloud Bootstrap replays bootstrap Chameleon history oldest-to-newest
OK Build Cloud Bootstrap includes Chameleon data_invalid in bootstrap readings
OK Build Cloud Bootstrap loads Chameleon readings from the diagnostic table during bootstrap
OK Run Force Sync loads force-sync Chameleon history before reordering it
OK Run Force Sync replays force-sync Chameleon history oldest-to-newest
OK Run Force Sync includes Chameleon data_invalid in force-sync readings
OK Build Dendrometer Readings INSERT removed the old Chameleon dendrometer insert skip
OK lsn50-decode-fn imports osi-dendro-helper in Decode LSN50
OK lsn50-apply-config imports osi-dendro-helper in Apply Config
OK lsn50-apply-config imports osi-chameleon-helper in Apply Config
OK lsn50-apply-config loads Chameleon calibration through the async SQLite helper in Apply Config
OK lsn50-apply-config removed does not call the synchronous Chameleon calibration helper with osi-db-helper
OK chameleon-readings-insert-fn imports osi-db-helper in Insert Chameleon Reading
OK chameleon-readings-insert-fn persists Chameleon calibration_status when inserting readings
OK lsn50-zone-agg-fn routes LSN50 flow through Chameleon insert
OK chameleon-readings-insert-fn passes Chameleon insert output to dendrometer insert
OK 8809bb5239dfb3d4 imports osi-dendro-helper in Build Telemetry
OK strega-sql-fn serializes STREGA persistence through one helper-scoped transaction
OK strega-sql-fn issues parameterized statements inside the transaction scope
OK strega-sql-fn persists STREGA telemetry into device_data with parameters
OK strega-sql-fn conditionally updates the canonical local STREGA valve state on uplink
OK strega-sql-fn stores decoded STREGA telemetry in local device_data columns
OK strega-sql-fn returns the observed local STREGA valve state
OK strega-reconciliation-monitor reads canonical STREGA valve state from devices
OK strega-reconciliation-monitor uses device_data only to find the latest observation timestamp
OK strega-reconciliation-monitor uses the newest matching uplink timestamp for reconciliation
OK strega-reconciliation-monitor removed the old invalid device_data.current_state observer query
OK strega-sql-fn removed the old manual transaction opener inside the function node
OK strega-sql-fn removed the old manual transaction committer inside the function node
OK strega-sql-fn removed the old manual rollback branch inside the function node
OK strega-sql-fn opens the local STREGA database directly
OK strega-sql-fn removed the old multi-await transaction entrypoint
OK strega-sql-fn removed the old multi-await commit call
OK strega-sql-fn removed the old multi-await rollback call
OK strega-sql-fn removed the old multi-statement sqlite topic builder
OK strega-sql-fn removed passive STREGA uplinks from touching target_state
OK 093d7832e89c4027 removed old LSN50 Shadow Compare (DD8 cleanup; not restored -- proves normalizer coverage, not writer execution)
OK 460e0bfd95f89e67 loads normalizer via osi-lib
OK 460e0bfd95f89e67 loads device-writer via osi-lib
OK 460e0bfd95f89e67 reads edge manifest for column mapping
OK 460e0bfd95f89e67 opens the local database for LSN50 writes
OK 460e0bfd95f89e67 loads normalizer and writer via quarantine-safe loader
OK LSN50 writer retains primary and legacy fallback outputs
OK 460e0bfd95f89e67 awaits the asynchronous writer contract
OK 6b28e0d879808dd9 UC512 awaits the asynchronous writer contract
OK lsn50-fallback-marker-fn records every LSN50 fallback before the legacy insert
OK lsn50-fallback-marker-fn LSN50 fallback marker function node exists
OK lsn50-fallback-marker-sqlite LSN50 fallback marker SQLite node exists
OK lsn50-fallback-evict-fn LSN50 fallback evict function node exists
OK lsn50-fallback-evict-sqlite LSN50 fallback evict SQLite node exists
OK lsn50-sql-fn restored legacy LSN50 Build SQL INSERT node exists
OK lsn50-sqlite restored legacy LSN50 Sensor DB Insert node exists
OK 460e0bfd95f89e67 routes writer failures through observable fallback
OK lsn50-fallback-marker-fn writes the fallback quarantine marker row before eviction
OK lsn50-fallback-marker-sqlite evicts quarantine rows to the writer cap after marking
OK lsn50-fallback-evict-fn applies the quarantine eviction cap
OK lsn50-fallback-evict-sqlite reaches the restored legacy SQL builder only after marker + eviction
OK lsn50-sql-fn restored legacy SQL builder feeds the restored legacy insert
OK lsn50-sqlite restored legacy insert rejoins zone aggregation like primary output 1
OK lsn50-sql-fn removed removes the historical shadow-compare wire from the restored legacy SQL builder
OK lsn50-fallback-evict-fn LIMIT matches osi-device-writer QUARANTINE_CAP (temporary legacy path cannot load the writer constant when module loading itself caused the fallback)
OK every writeDeviceData( call site (3) across maintained function nodes is awaited
OK 96_osi_server_config LSN50 writer kill switch UCI default is absent-only (never resets an operator override)
OK 96_osi_server_config LSN50 writer kill switch defaults new images to disabled (0)
OK node-red.init node-red.init resolves the LSN50 writer kill switch from UCI
OK node-red.init node-red.init exports LSN50_WRITER_DISABLE into the Node-RED process env
OK lsn50-zone-agg-fn bins MOD9 zone totals by uplink timestamp instead of processing time
OK lsn50-zone-agg-fn only aggregates valid rain deltas into zone totals
OK lsn50-zone-agg-fn only aggregates valid flow deltas into zone totals
OK format-devices returns observed LSN50 mode in GET /api/devices
OK format-devices returns dendrometer CH1 voltage in GET /api/devices
OK format-devices returns dendrometer ratio in GET /api/devices
OK format-devices returns the active dendrometer conversion path in GET /api/devices
OK format-devices returns raw dendrometer position in GET /api/devices
OK format-devices returns baseline-relative stem change in GET /api/devices
OK format-devices returns dendrometer saturation state in GET /api/devices
OK format-devices returns dendrometer saturation side in GET /api/devices
OK format-devices returns canonical SWT channel 1 with legacy Kiwi fallback in GET /api/devices
OK format-devices returns canonical SWT channel 2 with legacy Kiwi fallback in GET /api/devices
OK format-devices returns Chameleon SWT channel 3 in GET /api/devices
OK format-devices returns latest Chameleon reading row id in GET /api/devices
OK format-devices returns latest Chameleon raw payload in GET /api/devices
OK format-devices returns latest Chameleon payload version in GET /api/devices
OK format-devices returns latest Chameleon status flags in GET /api/devices
OK format-devices returns latest Chameleon board temperature in GET /api/devices
OK format-devices returns latest Chameleon I2C-missing flag in GET /api/devices
OK format-devices returns latest Chameleon timeout flag in GET /api/devices
OK format-devices returns latest Chameleon temp-fault flag in GET /api/devices
OK format-devices returns latest Chameleon ID-fault flag in GET /api/devices
OK format-devices returns latest Chameleon channel-open flag in GET /api/devices
OK format-devices returns latest Chameleon channel 2 open flag in GET /api/devices
OK format-devices returns latest Chameleon channel 3 open flag in GET /api/devices
OK format-devices returns latest Chameleon compensated resistance in GET /api/devices
OK format-devices returns latest Chameleon channel 2 compensated resistance in GET /api/devices
OK format-devices returns latest Chameleon channel 3 compensated resistance in GET /api/devices
OK format-devices returns latest Chameleon raw resistance in GET /api/devices
OK format-devices returns latest Chameleon channel 2 raw resistance in GET /api/devices
OK format-devices returns latest Chameleon channel 3 raw resistance in GET /api/devices
OK format-devices returns latest Chameleon array id in GET /api/devices
OK format-devices joins latest Chameleon readings in GET /api/devices
OK format-devices filters GET /api/devices latest-data lookup to canonical uppercase DevEUIs
OK format-devices avoids invalid SQL when no canonical DevEUIs are available
OK format-devices uses a no-row latest-data query for empty device lookups
OK format-devices sets a sqlite topic before returning an empty device list
OK format-devices sets a sqlite topic before returning an all-invalid DevEUI list
OK format-devices keeps GET /api/devices device rows on the request message
OK format-devices removed request-scoped GET /api/devices rows in flow context
OK format-devices selects the latest Chameleon reading by timestamp
OK format-devices breaks same-timestamp Chameleon ties by row id
OK format-devices returns interval-aware rain rate in GET /api/devices
OK format-devices returns interval-aware flow rate in GET /api/devices
OK format-devices returns normalized rain telemetry in GET /api/devices
OK format-devices returns normalized flow telemetry in GET /api/devices
OK format-devices returns elapsed counter interval in GET /api/devices
OK format-devices returns S2120 pressure in GET /api/devices
OK format-devices returns S2120 wind speed in GET /api/devices
OK format-devices returns S2120 wind direction in GET /api/devices
OK format-devices returns S2120 wind gust in GET /api/devices
OK format-devices returns S2120 UV in GET /api/devices
OK format-devices returns S2120 cumulative rain in GET /api/devices
OK format-devices returns S2120 battery in GET /api/devices
OK merge-device-data returns configured LSN50 mode in GET /api/devices
OK merge-device-data reads GET /api/devices device rows from the request message
OK merge-device-data removed request-scoped GET /api/devices rows from flow context
OK merge-device-data returns the explicit legacy dendrometer override in GET /api/devices
OK merge-device-data returns dendrometer stroke calibration in GET /api/devices
OK merge-device-data returns dendrometer retracted-ratio calibration in GET /api/devices
OK merge-device-data returns dendrometer extended-ratio calibration in GET /api/devices
OK merge-device-data returns the pending-baseline flag in GET /api/devices
OK merge-device-data returns Chameleon enabled config in GET /api/devices
OK merge-device-data returns Chameleon SWT depth config in GET /api/devices
OK merge-device-data removed merge-device-data no longer returns chameleon_swt1_a
OK merge-device-data removed merge-device-data no longer returns chameleon_swt1_b
OK merge-device-data removed merge-device-data no longer returns chameleon_swt1_c
OK merge-device-data merges Chameleon SWT channel 1 into GET /api/devices
OK merge-device-data maps latest Chameleon reading row id from SQL results
OK merge-device-data maps latest Chameleon raw payload from SQL results
OK merge-device-data merges latest Chameleon reading row id into GET /api/devices
OK merge-device-data merges latest Chameleon raw payload into GET /api/devices
OK merge-device-data merges latest Chameleon payload version into GET /api/devices
OK merge-device-data merges latest Chameleon status flags into GET /api/devices
OK merge-device-data merges latest Chameleon board temperature into GET /api/devices
OK merge-device-data merges latest Chameleon I2C-missing flag into GET /api/devices
OK merge-device-data merges latest Chameleon timeout flag into GET /api/devices
OK merge-device-data merges latest Chameleon temp-fault flag into GET /api/devices
OK merge-device-data merges latest Chameleon ID-fault flag into GET /api/devices
OK merge-device-data merges latest Chameleon channel-open flag into GET /api/devices
OK merge-device-data merges latest Chameleon channel 2 open flag into GET /api/devices
OK merge-device-data merges latest Chameleon channel 3 open flag into GET /api/devices
OK merge-device-data merges latest Chameleon channel 1 resistance into GET /api/devices
OK merge-device-data merges latest Chameleon channel 2 resistance into GET /api/devices
OK merge-device-data merges latest Chameleon raw resistance into GET /api/devices
OK merge-device-data merges latest Chameleon channel 2 raw resistance into GET /api/devices
OK merge-device-data merges latest Chameleon channel 3 raw resistance into GET /api/devices
OK merge-device-data merges latest Chameleon array id into GET /api/devices
OK merge-device-data merges latest Chameleon channel 3 resistance into GET /api/devices
OK merge-device-data merges dendrometer ratio into GET /api/devices
OK merge-device-data merges dendrometer path metadata into GET /api/devices
OK merge-device-data merges raw dendrometer position into GET /api/devices
OK merge-device-data merges baseline-relative stem change into GET /api/devices
OK merge-device-data merges dendrometer saturation into GET /api/devices
OK merge-device-data merges dendrometer saturation-side metadata into GET /api/devices
OK merge-device-data returns stored STREGA model metadata in GET /api/devices
OK merge-device-data merges interval-aware rain rate into GET /api/devices
OK merge-device-data merges interval-aware flow rate into GET /api/devices
OK merge-device-data merges normalized rain telemetry into GET /api/devices
OK merge-device-data merges normalized flow telemetry into GET /api/devices
OK merge-device-data merges elapsed counter interval into GET /api/devices
OK merge-device-data merges S2120 pressure into GET /api/devices
OK merge-device-data merges S2120 wind speed into GET /api/devices
OK merge-device-data merges S2120 wind direction into GET /api/devices
OK merge-device-data merges S2120 wind gust into GET /api/devices
OK merge-device-data merges S2120 UV into GET /api/devices
OK merge-device-data merges S2120 cumulative rain into GET /api/devices
OK merge-device-data merges S2120 battery into GET /api/devices
OK s2120-process-fn accepts live decoded S2120 message shape
OK s2120-process-fn accepts nested decoded S2120 message shape
OK s2120-process-fn uses current S2120 pressure ID
OK s2120-process-fn uses the Seeed cumulative-rain measurement ID
OK s2120-process-fn uses current and legacy S2120 wind-gust IDs
OK s2120-process-fn uses the decoded S2120 battery-percent field
OK s2120-process-fn skips duplicate S2120 rain-counter uplinks
OK s2120-process-fn skips out-of-order S2120 rain-counter uplinks
OK s2120-process-fn detects S2120 rain-counter resets
OK s2120-process-fn skips S2120 rain deltas when the interval is invalid
OK s2120-process-fn computes normalized S2120 rain telemetry per 10 minutes
OK s2120-process-fn stores the elapsed S2120 counter interval in seconds
OK s2120-rain-agg-fn prefers explicit S2120 weather station zone assignments
OK s2120-rain-agg-fn falls back when S2120 weather station zone assignments are absent
OK s2120-rain-agg-fn uses legacy S2120 irrigation zone fallback
OK s2120-rain-agg-fn seeds S2120 zone totals from device daily rain
OK s2120-rain-agg-fn keeps S2120 zone totals caught up with device daily rain
OK s2120-process-fn imports osi-db-helper as osiDb
OK s2120-rain-agg-fn imports osi-db-helper as osiDb
OK LoRain MQTT input uses application/+/device/+/event/up
OK catalog-response exposes LoRain in the device catalog
OK post-devices-insert maps local LoRain registration to the LoRain ChirpStack profile
OK post-devices-insert sets the Aqua-Scope LoRain JoinEUI for local registration
OK cs-reg-cloud-fn maps cloud LoRain registration to the LoRain ChirpStack profile
OK cs-reg-cloud-fn sets the Aqua-Scope LoRain JoinEUI for cloud registration
OK cs-reg-cloud-fn keeps cloud SenseCAP registration support while adding LoRain
OK lorain-process-fn filters LoRain uplinks by profile ID
OK lorain-process-fn guards LoRain uplinks by local device type
OK lorain-process-fn skips duplicate or out-of-order LoRain interval rain
OK lorain-process-fn computes normalized LoRain rain telemetry per 10 minutes
OK lorain-sql-fn persists LoRain tip deltas
OK lorain-rain-agg-fn labels LoRain zone rainfall source
OK lorain-process-fn imports osi-db-helper as osiDb
OK lorain-rain-agg-fn imports osi-db-helper as osiDb
OK merge-device-data imports osi-db-helper as osiDb for S2120 enrichment
OK s2120-zones-get-fn imports crypto for auth verification
OK s2120-zones-get-fn imports osi-db-helper as osiDb
OK s2120-zones-put-auth-fn imports crypto for auth verification
OK s2120-zones-put-auth-fn imports osi-db-helper as osiDb
OK put-soil-depth-fn imports crypto for soil-depth auth verification
OK put-soil-depth-fn imports osi-db-helper for soil-depth persistence
OK sensor-history-fn routes legacy sensor history through the history helper rollup path
OK sensor-history-fn passes the requested legacy field to the helper
OK sensor-history-fn preserves owner scoping for legacy sensor history and delegates scoped access separately
OK sensor-history-fn uses osi-db-helper for legacy sensor history
OK sensor-history-fn uses osi-history-helper for legacy sensor history
OK sensor-history-fn imports crypto for legacy sensor history auth verification
OK fn_build_sensor_sql_params exports canonical SWT1 with legacy Kiwi fallback
OK fn_build_sensor_sql_params exports canonical SWT2 with legacy Kiwi fallback
OK put-chameleon-enabled-auth-fn imports crypto for Chameleon enabled auth verification
OK put-chameleon-enabled-auth-fn uses osi-db-helper for Chameleon enabled persistence
OK put-chameleon-enabled-auth-fn validates Chameleon enabled payload without broad coercion
OK put-chameleon-enabled-auth-fn rejects missing or invalid Chameleon enabled values
OK put-chameleon-enabled-auth-fn returns a 400 for invalid Chameleon enabled values
OK put-chameleon-enabled-auth-fn limits Chameleon enabled updates to LSN50 devices
OK put-chameleon-enabled-auth-fn bumps devices.sync_version on Chameleon enable toggle so trg_sync_devices_outbox_au emits an increasing-version DEVICE event (issue #5; matches dendro_enabled/temp_enabled/rain_gauge_enabled/flow_meter_enabled precedent, avoids the equal-version-payload-conflict class fixed for issue #10)
OK dendro-ref-tree-fn bumps devices.sync_version on reference-tree toggle so trg_sync_devices_outbox_au emits an increasing-version DEVICE event (issue #15; matches dendro_enabled/temp_enabled/rain_gauge_enabled/flow_meter_enabled/chameleon_enabled precedent, avoids the equal-version-payload-conflict class fixed for issue #10)
OK 8b93fa005d78e25f chameleon-depth-auth uses HMAC verifyBearer — not global.get(authCheck)
OK 8b93fa005d78e25f removed chameleon-depth-auth does not call the dead authCheck global
OK 8b93fa005d78e25f imports crypto for Chameleon depth auth verification
OK 8b93fa005d78e25f chameleon-depth-auth carries authenticated user context forward
OK 44e7d74ff3668e01 chameleon-refresh-auth uses HMAC verifyBearer — not global.get(authCheck)
OK 44e7d74ff3668e01 removed chameleon-refresh-auth does not call the dead authCheck global
OK 44e7d74ff3668e01 imports crypto for Chameleon refresh auth verification
OK 44e7d74ff3668e01 chameleon-refresh-auth carries authenticated user context forward
OK cc34104ef33b76fd chameleon-refresh-query limits array lookup to the authenticated user
OK cc34104ef33b76fd chameleon-refresh-query ignores deleted devices
OK bf93cd55db0eb57f chameleon-depth-save bumps sync_version to trigger the outbox on depth changes
OK bf93cd55db0eb57f chameleon-depth-save validates direct API depth values
OK bf93cd55db0eb57f chameleon-depth-save accepts numeric JSON depth values explicitly
OK bf93cd55db0eb57f chameleon-depth-save only coerces non-empty numeric strings
OK bf93cd55db0eb57f chameleon-depth-save rejects non-finite direct API depth values
OK bf93cd55db0eb57f chameleon-depth-save normalizes route DevEUI before persistence
OK bf93cd55db0eb57f chameleon-depth-save ignores deleted devices
OK bf93cd55db0eb57f chameleon-depth-save limits depth updates to the authenticated user
OK bf93cd55db0eb57f chameleon-depth-save returns 404 when no device row was updated
OK bf93cd55db0eb57f chameleon-depth-save reports missing devices honestly
OK d0b2b1c1a937e16d scheduler can evaluate Chameleon SWT channel 3
OK d0b2b1c1a937e16d scheduler includes Chameleon-enabled LSN50 devices
OK d0b2b1c1a937e16d scheduler SWT average counts Chameleon channel 3 only when present
OK dendro-history-fn routes legacy dendro history through the history helper rollup path
OK dendro-history-fn preserves dendrometer history response shape through helper dendro mode
OK dendro-history-fn preserves owner scoping for legacy dendro history and delegates scoped access separately
OK dendro-history-fn uses osi-db-helper for legacy dendro history
OK dendro-history-fn uses osi-history-helper for legacy dendro history
OK dendro-history-fn imports crypto for legacy dendro history auth verification
OK dendro-history-format formats dendrometer CH1 history for the GUI
OK dendro-history-format formats dendrometer ratio history for the GUI
OK dendro-history-format formats dendrometer path history for the GUI
OK dendro-history-format formats baseline-relative stem change history for the GUI
OK dendro-raw-fn keeps raw dendrometer CH0 history backward compatible
OK dendro-raw-fn returns raw dendrometer CH1 readings
OK dendro-raw-fn returns raw dendrometer ratios
OK dendro-raw-fn returns raw dendrometer path metadata
OK dendro-raw-fn merges calibrated and raw-only dendrometer readings
OK dendro-raw-fn reads raw-only dendrometer history from device_data
OK dendro-raw-fn keeps raw-only dendrometer readings uncalibrated
OK dendro-raw-fn defaults raw-only dendrometer validity when device_data omits it
OK dendro-raw-fn limits synthetic raw dendrometer rows to uncalibrated samples
OK dendro-readings-insert-fn stores raw dendrometer debug fields in dendrometer_readings
OK put-dendro-config-auth-fn imports osi-db-helper for dendrometer config persistence
OK put-dendro-config-auth-fn ignores deleted devices when saving dendrometer config
OK put-dendro-config-auth-fn returns 404 for missing dendrometer-config devices
OK put-dendro-config-auth-fn marks the dendrometer baseline as pending when calibration changes
OK device-api catch node exists
OK device-api catch node type
OK device-api catch node tab
OK device-api catch node catches the whole tab
OK device-api-catch routes uncaught device-api errors into the HTTP 500 formatter
OK device-api-http500 maps recognized auth failures to 401 and defaults all other device-api failures to 500 (issue #9)
OK device-api-http500 bounds the 500 response to a generic message and never echoes the caught error
OK device-api-http500 formats uncaught device-api failures with the generic error code
OK device-api-http500 returns uncaught device-api failures through the shared response node
OK Format Dendro Config Response returns canonical dendrometer config fields
OK Format Dendro Config Response keeps legacy dendrometer inversion config for compatibility
OK post-dendro-baseline-reset-auth-fn clears the stored dendrometer baseline position
OK post-dendro-baseline-reset-auth-fn clears the stored dendrometer baseline mode
OK post-dendro-baseline-reset-auth-fn clears the stored dendrometer baseline calibration signature
OK post-dendro-baseline-reset-auth-fn marks the dendrometer baseline as pending after a manual reset
OK api.ts adds a shared client helper for dendrometer baseline resets
OK api.ts targets the local dendrometer baseline reset endpoint from the shared client helper
OK api.ts adds a shared client helper for Chameleon enablement
OK api.ts targets the local Chameleon enablement endpoint from the shared client helper
OK api.ts removed retired the per-device Chameleon coefficient client helper
OK api.ts types dendrometer history position as nullable
OK api.ts normalizes baseline-relative stem change for dendrometer history
OK api.ts removed coercing missing dendrometer history position to zero
OK api.ts removed coercing missing raw dendrometer position to zero
OK farming.ts allows synthetic raw dendrometer rows without numeric ids
OK farming.ts allows raw-only dendrometer rows to omit calibrated position
OK farming.ts types the latest stem-change signal on device payloads
OK farming.ts types the device-level baseline-pending flag
OK farming.ts types Chameleon SWT channel 3 on latest device payloads
OK farming.ts types Chameleon raw payload on latest device payloads
OK farming.ts types device-level Chameleon enablement flag
OK api.ts types the dendrometer history stem-change signal
OK farming.ts types latest_data.swt_1
OK farming.ts types latest_data.swt_2
OK farming.ts types latest_data.swt_3
OK farming.ts types latest_data.chameleon_reading_id
OK farming.ts types latest_data.chameleon_payload_b64
OK farming.ts types latest_data.chameleon_payload_version
OK farming.ts types latest_data.chameleon_status_flags
OK farming.ts types latest_data.chameleon_i2c_missing
OK farming.ts types latest_data.chameleon_timeout
OK farming.ts types latest_data.chameleon_temp_fault
OK farming.ts types latest_data.chameleon_id_fault
OK farming.ts types latest_data.chameleon_ch1_open
OK farming.ts types latest_data.chameleon_ch2_open
OK farming.ts types latest_data.chameleon_ch3_open
OK farming.ts types latest_data.chameleon_temp_c
OK farming.ts types latest_data.chameleon_r1_ohm_comp
OK farming.ts types latest_data.chameleon_r2_ohm_comp
OK farming.ts types latest_data.chameleon_r3_ohm_comp
OK farming.ts types latest_data.chameleon_r1_ohm_raw
OK farming.ts types latest_data.chameleon_r2_ohm_raw
OK farming.ts types latest_data.chameleon_r3_ohm_raw
OK farming.ts types latest_data.chameleon_array_id
OK farming.ts types top-level Device.chameleon_enabled
OK farming.ts types top-level Device.chameleon_swt1_depth_cm
OK farming.ts types top-level Device.chameleon_swt2_depth_cm
OK farming.ts types top-level Device.chameleon_swt3_depth_cm
OK api.ts types setChameleonDepth payload.chameleonSwt1DepthCm
OK api.ts types setChameleonDepth payload.chameleonSwt2DepthCm
OK api.ts types setChameleonDepth payload.chameleonSwt3DepthCm
OK DendrometerMonitor.tsx labels the basic monitor around the comparable stem-change signal
OK DendrometerMonitor.tsx renders mechanical engineering values beneath the stem-change graph
OK DendrometerMonitor.tsx shows absolute mechanical position below the graph instead of as the headline graph metric
OK DendrometerMonitor.tsx keeps the basic monitor informative when comparable stem change is not ready yet
OK farming/dendrometer/DendrometerMonitor.tsx explains raw-only dendrometer rows in the 24h drawer
OK farming/dendrometer/DendrometerMonitor.tsx shows CH1 and ratio debug values only for ratio-mode 24h readings
OK DraginoTempCard.tsx shows stem change as the only primary dendrometer signal on the device card
OK DraginoTempCard.tsx removed removes the old absolute-position headline from the device card
OK DraginoTempCard.tsx renders the baseline-relative stem change signal on the device card
OK DraginoTempCard.tsx suppresses stale stem-change values when the device is awaiting a new baseline
OK DraginoTempCard.tsx keeps the dendrometer card visible while the next valid uplink establishes a new baseline
OK DraginoTempCard.tsx renders Chameleon SWT on the LSN50 card
OK DraginoTempCard.tsx opens history for Chameleon SWT3
OK DraginoTempCard.tsx removed removes generic ADC card when dendrometer is disabled
OK DraginoTempCard.tsx keeps Chameleon SWT formatting null-safe through the shared formatter
OK DraginoTempCard.tsx surfaces invalid Chameleon sample state on the LSN50 card
OK DraginoTempCard.tsx treats Chameleon missing and timeout flags as invalid samples
OK DraginoDendroCalibrationSection.tsx shows ratio in the dendrometer calibration section instead of on the device card
OK DraginoSettingsModal.tsx adds dendrometer calibration controls to the LSN50 advanced settings
OK DraginoSettingsModal.tsx imports the Chameleon SWT calibration section
OK DraginoSettingsModal.tsx adds Chameleon SWT to the LSN50 sensor toggle list
OK DraginoSettingsModal.tsx labels the Chameleon SWT sensor toggle
OK DraginoSettingsModal.tsx wires the Chameleon SWT toggle to the local API
OK DraginoSettingsModal.tsx uses a per-sensor LSN50 mode gate
OK DraginoSettingsModal.tsx requires MOD3 for Chameleon SWT enablement
OK DraginoSettingsModal.tsx requires MOD9 for rain and flow counters
OK DraginoSettingsModal.tsx surfaces a clear MOD3 guard message for Chameleon enablement
OK DraginoSettingsModal.tsx warns before switching away from modes required by enabled sensors
OK DraginoSettingsModal.tsx documents the non-exclusive dendrometer and Chameleon MOD3 mode path
OK DraginoSettingsModal.tsx keeps the MOD1 temperature warning path separate from strict mode gates
OK DraginoSettingsModal.tsx warns before switching temperature-enabled LSN50 devices away from MOD1
OK DraginoSettingsModal.tsx renders a dedicated Chameleon SWT settings section
OK DraginoSettingsModal.tsx renders the Chameleon SWT calibration component in the settings modal
OK DraginoDendroCalibrationSection.tsx uses canonical retracted-ratio calibration wording in the advanced settings
OK DraginoDendroCalibrationSection.tsx uses canonical extended-ratio calibration wording in the advanced settings
OK DraginoDendroCalibrationSection.tsx allows capturing the live ratio into calibration endpoints
OK DraginoDendroCalibrationSection.tsx saves dendrometer calibration through the dedicated local API
OK DraginoDendroCalibrationSection.tsx adds a manual baseline reset action for legacy dendrometers
OK DraginoDendroCalibrationSection.tsx wires the manual baseline reset action to the local API
OK DraginoDendroCalibrationSection.tsx exposes the legacy dendrometer override in the advanced settings
OK DraginoChameleonSwtSection.tsx wires the manual refresh button to the edge endpoint
OK DraginoChameleonSwtSection.tsx persists install depth via the depth-only save endpoint
OK DraginoChameleonSwtSection.tsx removed retired the per-device coefficient save flow
OK DraginoChameleonSwtSection.tsx removed retired the workbook-default restore UI
OK swt.ts uses canonical SWT1 with legacy Kiwi fallback in shared GUI SWT utilities
OK swt.ts uses canonical SWT2 with legacy Kiwi fallback in shared GUI SWT utilities
OK IrrigationZoneCard.tsx computes Soil now from canonical SWT values across sensor families
OK IrrigationZoneCard.tsx removed prevents Soil now from reading only legacy Kiwi SWT values
OK SoilTab.tsx computes soil environment SWT from canonical sensor-family-neutral values
OK KiwiSensorCard.tsx uses canonical SWT1 for Kiwi live display and history
OK KiwiSensorCard.tsx uses canonical SWT2 for Kiwi live display and history
OK KiwiSensorCard.tsx stores Kiwi SWT1 depth metadata under the canonical key
OK ScheduleSection.tsx saves new SWT schedules with canonical metric names
OK Dragino settings components removed removes the ratio inversion toggle from the advanced settings
OK SenseCapWeatherCard.tsx opens a dedicated wind monitor from the S2120 card
OK SenseCapWeatherCard.tsx shows normalized rain history options on the S2120 card
OK SenseCapWeatherCard.tsx renders human-readable rain-counter state on the S2120 card
OK SenseCapWeatherCard.tsx uses shared wind-direction formatting on the S2120 card
OK farming.ts types Aqua-Scope LoRain as a supported device
OK LoRainGaugeCard.tsx renders LoRain interval rainfall
OK LoRainGaugeCard.tsx shows normalized LoRain rain-rate history options
OK LoRainGaugeCard.tsx removes LoRain devices through the existing device API
OK FarmingDashboard.tsx groups unassigned LoRain gauges
OK FarmingDashboard.tsx renders unassigned LoRain gauges
OK IrrigationZoneCard.tsx groups assigned LoRain gauges
OK IrrigationZoneCard.tsx renders assigned LoRain gauges
OK LocalTab.tsx styles LoRain devices in local environment breakdowns
OK WindMonitor.tsx loads wind-speed history in the dedicated S2120 wind monitor
OK WindMonitor.tsx loads wind-gust history in the dedicated S2120 wind monitor
OK WindMonitor.tsx loads wind-direction history in the dedicated S2120 wind monitor
OK wind.ts ships shared wind-direction formatting helpers
OK OnlineTab.tsx reuses shared wind-direction helpers in the online environment tab
OK WeatherTab.tsx reuses shared wind-direction helpers in the weather forecast tab
OK merge-device-data returns device updated_at in GET /api/devices
OK Auth + Query Gateway Location queries gateway GPS state from the local mirror table
OK Format Gateway Location Response returns a no-fix fallback for linked gateways
OK Route Command routes SET_LSN50_MODE gateway commands
OK Route Command routes SET_LSN50_INTERVAL gateway commands
OK Route Command routes SET_LSN50_INTERRUPT_MODE gateway commands
OK Route Command routes SET_LSN50_5V_WARMUP gateway commands
OK Route Command routes SET_KIWI_INTERVAL gateway commands
OK Route Command routes ENABLE_KIWI_TEMP_HUMIDITY gateway commands
OK Route Command routes synced Kiwi soil depth commands through the shared update path
OK Route Command routes SET_STREGA_INTERVAL gateway commands
OK Route Command routes SET_STREGA_MODEL gateway commands
OK Route Command routes SET_STREGA_TIMED_ACTION gateway commands
OK Route Command routes SET_STREGA_MAGNET_MODE gateway commands
OK Route Command routes SET_STREGA_PARTIAL_OPENING gateway commands
OK Route Command routes SET_STREGA_FLUSHING gateway commands
OK Build UPDATE SQL updates the local configured LSN50 mode for synced commands
OK Build UPDATE SQL upserts shared zone area from sync commands
OK Build UPDATE SQL upserts the prediction-card flag from sync commands
OK Build UPDATE SQL applies zone area updates from control-plane sync
OK Build UPDATE SQL applies irrigation efficiency updates from control-plane sync
OK Build UPDATE SQL applies prediction-card updates from control-plane sync
OK Build UPDATE SQL accepts synced LSN50 interval commands on the gateway
OK Build UPDATE SQL accepts synced LSN50 interrupt mode commands on the gateway
OK Build UPDATE SQL accepts synced LSN50 5V warm-up commands on the gateway
OK Build UPDATE SQL accepts synced Kiwi interval commands on the gateway
OK Build UPDATE SQL accepts synced Kiwi temperature and humidity enable commands on the gateway
OK Build UPDATE SQL accepts synced Kiwi soil depth updates on the gateway
OK Build UPDATE SQL updates mirrored Kiwi soil depth metadata on the gateway
OK Sync Init Schema + Triggers creates the device outbox trigger for mirrored device changes
OK Sync Init Schema + Triggers queues device outbox events when Kiwi soil depth JSON changes locally
OK Sync Init Schema + Triggers queues device outbox events when Kiwi soil depth readiness changes locally
OK Sync Init Schema + Triggers mirrors Kiwi soil depth JSON in device outbox payloads
OK Sync Init Schema + Triggers mirrors Kiwi soil depth readiness in device outbox payloads
OK Sync Init Schema + Triggers queues device outbox events when Chameleon SWT1 depth changes locally
OK Sync Init Schema + Triggers queues device outbox events when Chameleon SWT2 depth changes locally
OK Sync Init Schema + Triggers queues device outbox events when Chameleon SWT3 depth changes locally
OK Sync Init Schema + Triggers mirrors Chameleon SWT1 depth in device outbox payloads
OK Sync Init Schema + Triggers mirrors Chameleon SWT2 depth in device outbox payloads
OK Sync Init Schema + Triggers mirrors Chameleon SWT3 depth in device outbox payloads
OK Auth + Save Soil Moisture Depths stores Kiwi soil depth JSON through the local edge endpoint
OK Auth + Save Soil Moisture Depths marks Kiwi soil depths as configured through the local edge endpoint
OK put-dendro-format returns the resulting device version from local dendrometer flag writes
OK put-temp-format returns the resulting device version from local temperature flag writes
OK put-rain-gauge-resp-fn returns the resulting device version from rain-gauge flag writes
OK put-flow-meter-resp-fn returns the resulting device version from flow-meter flag writes
OK dendro-ref-tree-fn returns the resulting device version from reference-tree writes
OK put-chameleon-enabled-auth-fn returns the resulting device version from Chameleon flag writes
OK bf93cd55db0eb57f returns the resulting device version from Chameleon depth writes
OK post-devices-response returns the resulting device version from local name and claim writes
OK assign-device-response returns the resulting device version from local assignment writes
OK unassign-device-response returns the resulting device version from local unassignment writes
OK Auth + Save Soil Moisture Depths removed soil-depth error forwarding into the tab-wide HTTP catch path
OK Build UPDATE SQL accepts synced STREGA interval commands on the gateway
OK Build UPDATE SQL accepts synced STREGA model updates on the gateway
OK Build UPDATE SQL accepts synced STREGA timed actions on the gateway
OK Build UPDATE SQL accepts synced STREGA magnet mode commands on the gateway
OK Build UPDATE SQL accepts synced STREGA partial opening commands on the gateway
OK Build UPDATE SQL accepts synced STREGA flushing commands on the gateway
OK Build Schedule ACK skips duplicate generic ACKs for direct LSN50 interrupt-mode downlinks
OK Build Schedule ACK skips duplicate generic ACKs for direct LSN50 5V warm-up downlinks
OK Build Schedule ACK skips duplicate generic ACKs for direct STREGA timed downlinks
OK Build Schedule ACK skips duplicate generic ACKs for direct STREGA magnet downlinks
OK Build Schedule ACK skips duplicate generic ACKs for direct STREGA partial-opening downlinks
OK Build Schedule ACK skips duplicate generic ACKs for direct STREGA flushing downlinks
OK Sync Init Schema + Triggers adds LSN50 mode columns to device_data
OK Sync Init Schema + Triggers adds the device-level legacy dendrometer override
OK Sync Init Schema + Triggers adds the device-level dendrometer stroke calibration
OK Sync Init Schema + Triggers adds the device-level dendrometer ratio zero calibration
OK Sync Init Schema + Triggers adds the device-level dendrometer ratio span calibration
OK Sync Init Schema + Triggers adds the canonical retracted-ratio dendrometer calibration column
OK Sync Init Schema + Triggers adds the canonical extended-ratio dendrometer calibration column
OK Sync Init Schema + Triggers preserves canonical dendrometer ratio columns when rebuilding the devices table
OK Sync Init Schema + Triggers copies canonical dendrometer ratios through the devices table rebuild
OK Sync Init Schema + Triggers adds a persisted edge baseline for comparable stem-change signals
OK Sync Init Schema + Triggers tracks which conversion path the stem-change baseline was captured with
OK Sync Init Schema + Triggers tracks calibration changes that should reset the stem-change baseline
OK Sync Init Schema + Triggers adds a persisted pending-baseline flag on devices
OK Sync Init Schema + Triggers preserves the pending-baseline flag when rebuilding the devices table
OK Sync Init Schema + Triggers adds the device-level dendrometer inversion flag
OK Sync Init Schema + Triggers backfills canonical retracted-ratio calibration from legacy dendrometer fields
OK Sync Init Schema + Triggers backfills canonical extended-ratio calibration from legacy dendrometer fields
OK Sync Init Schema + Triggers adds CH1 dendrometer telemetry storage
OK Sync Init Schema + Triggers adds ratio dendrometer telemetry storage
OK Sync Init Schema + Triggers adds dendrometer path storage
OK Sync Init Schema + Triggers adds baseline-relative stem-change storage to device_data
OK Sync Init Schema + Triggers adds STREGA battery percentage storage
OK Sync Init Schema + Triggers adds backward-compatible CH0 storage to dendrometer_readings
OK Sync Init Schema + Triggers adds CH1 storage to dendrometer_readings
OK Sync Init Schema + Triggers adds ratio storage to dendrometer_readings
OK Sync Init Schema + Triggers adds path metadata storage to dendrometer_readings
OK Auth + Parse LSN50 Mode validates supported LSN50 modes on the local API
OK Auth + Parse LSN50 Interval validates LSN50 uplink interval minutes on the local API
OK Auth + Parse LSN50 Interrupt validates LSN50 interrupt-mode values on the local API
OK Auth + Parse LSN50 5V Warmup validates LSN50 5V warm-up values on the local API
OK Auth + Parse Kiwi Interval validates Kiwi uplink interval minutes on the local API
OK Auth + Parse Kiwi Temp/Humidity builds the Kiwi ambient temperature and humidity enable payload
OK Auth + Parse Kiwi Temp/Humidity removed default Kiwi temp/humidity 15-minute fallback
OK Auth + Parse Kiwi Temp/Humidity removed implicit Kiwi temp/humidity interval default
OK Auth + Parse STREGA Interval validates STREGA uplink interval minutes on the local API
OK Auth + Parse STREGA Interval validates opened-box STREGA interval minutes on the local API
OK Auth + Parse STREGA Model validates STREGA model selection on the local API
OK Auth + Parse STREGA Timed Action validates STREGA timed actions on the local API
OK Auth + Parse STREGA Magnet validates STREGA magnet mode changes on the local API
OK Auth + Parse STREGA Partial Opening validates STREGA partial opening on the local API
OK Auth + Parse STREGA Flushing validates STREGA flushing on the local API
OK Auth + Parse Dendro Config parses the explicit legacy dendrometer override
OK Auth + Parse Dendro Config parses dendrometer stroke calibration
OK Auth + Parse Dendro Config parses dendrometer retracted-ratio calibration
OK Auth + Parse Dendro Config parses dendrometer extended-ratio calibration
OK Auth + Parse Dendro Config accepts canonical retracted-ratio config fields
OK Auth + Parse Dendro Config accepts canonical extended-ratio config fields
OK Auth + Parse Dendro Config keeps compatibility with legacy ratio-zero config fields
OK Auth + Parse Dendro Config keeps compatibility with legacy ratio-span config fields
OK Auth + Parse Dendro Config rejects empty dendrometer config updates
OK Authorize + Fanout LSN50 Mode fans out validated local LSN50 mode changes into the shared command path
OK Authorize + Fanout LSN50 Interval fans out validated local LSN50 interval changes into the shared command path
OK Authorize + Fanout LSN50 Advanced fans out validated local LSN50 interrupt-mode changes into the shared command path
OK Authorize + Fanout LSN50 Advanced fans out validated local LSN50 5V warm-up changes into the shared command path
OK Authorize + Fanout Kiwi Interval fans out validated local Kiwi interval changes into the shared command path
OK Authorize + Fanout Kiwi Temp/Humidity fans out validated local Kiwi ambient sensor enable changes into the shared command path
OK Authorize + Fanout STREGA Interval fans out validated local STREGA interval changes into the shared actuator path
OK Authorize + Fanout STREGA Interval fans out validated STREGA tamper flags into the shared actuator path
OK Authorize + Fanout STREGA Advanced fans out validated local STREGA timed actions into the shared actuator path
OK Authorize + Fanout STREGA Advanced fans out validated local STREGA magnet commands into the shared actuator path
OK Authorize + Fanout STREGA Advanced fans out validated local STREGA partial opening into the shared actuator path
OK Authorize + Fanout STREGA Advanced fans out validated local STREGA flushing into the shared actuator path
OK Authorize + Fanout STREGA Advanced gates motorized-only STREGA partial opening locally
OK Authorize + Fanout STREGA Advanced gates motorized-only STREGA flushing locally
OK Authorize + Fanout LSN50 Mode removed local LSN50 mode last-seen mutation
OK Authorize + Fanout LSN50 Interval removed local LSN50 interval last-seen mutation
OK Authorize + Fanout Kiwi Interval removed local Kiwi interval last-seen mutation
OK Authorize + Fanout Kiwi Temp/Humidity removed local Kiwi temp/humidity last-seen mutation
OK Authorize + Fanout STREGA Interval removed local STREGA interval last-seen mutation
OK Format LSN50 Mode Response returns explicit confirmation-waiting state from the local API
OK Format LSN50 Interval Response returns queued state from the local LSN50 interval API
OK Format LSN50 Advanced Response returns queued state from the local LSN50 advanced APIs
OK Format Kiwi Interval Response returns queued state from the local Kiwi interval API
OK Format Kiwi Temp/Humidity Response returns queued state from the local Kiwi ambient enable API
OK Format STREGA Interval Response returns queued state from the local STREGA interval API
OK Format STREGA Interval Response returns tamper status from the local STREGA interval API
OK Format STREGA Advanced Response returns immediate confirmation from the local STREGA model API
OK Format STREGA Advanced Response returns queued state from the local STREGA downlink APIs
OK Build LSN50 mode downlink builds Dragino interval downlinks
OK Build LSN50 mode downlink builds Dragino interrupt-mode downlinks
OK Build LSN50 mode downlink builds Dragino 5V warm-up downlinks
OK Build LSN50 mode downlink builds Kiwi interval downlinks
OK Build LSN50 mode downlink builds Kiwi ambient temperature and humidity enable downlinks
OK Build LSN50 mode downlink encodes Dragino TDC interval bytes
OK Build LSN50 mode downlink encodes Dragino interrupt-mode bytes
OK Build LSN50 mode downlink encodes Dragino 5V warm-up bytes
OK Build LSN50 mode downlink encodes Kiwi interval register writes
OK Build LSN50 mode downlink encodes Kiwi ambient temperature and humidity enable bytes
OK Build STREGA downlink + emit log ctx supports STREGA interval downlinks
OK Build STREGA downlink + emit log ctx encodes STREGA interval bytes with tamper control on FPort 11
OK Build STREGA downlink + emit log ctx supports STREGA timed-action downlinks
OK Build STREGA downlink + emit log ctx supports STREGA magnet-mode downlinks
OK Build STREGA downlink + emit log ctx supports STREGA partial-opening downlinks
OK Build STREGA downlink + emit log ctx supports STREGA flushing downlinks
OK Build STREGA downlink + emit log ctx includes the actual STREGA valve DevEUI in direct command ACK payloads
OK Build STREGA downlink + emit log ctx includes the gateway transport identity in direct STREGA command ACK payloads
OK Build Status + ACK includes the actual STREGA valve DevEUI in cloud status payloads
OK Build Status + ACK includes the gateway transport identity in cloud status payloads
OK Build Status + ACK defaults manual STREGA valve ACK payloads to the cloud command type
OK Cancel STREGA Actuation uses shared ChirpStack helper configuration
OK Cancel STREGA Actuation flushes the ChirpStack device queue
OK Cancel STREGA Actuation marks active actuation expectations CANCELLED
OK Cancel STREGA Actuation updates only the latest active expectation
OK Cancel STREGA Actuation removed bare CLOSE downlink emission from cancel path
OK Cancel STREGA Actuation removed actuator fanout from cancel path
OK System Stats uses findFanControl helper for dual-path fan discovery
OK System Stats tries hwmon path first
OK System Stats identifies pwmfan hwmon device by name
OK System Stats falls back to raw PWM sysfs when hwmon absent
OK System Stats fan defaults to unavailable when neither path found
OK node-red.init uses the shared gateway identity helper
OK node-red.init heals and persists canonical gateway identity through the shared helper
OK node-red.init logs the exact gateway identity heal failure
OK node-red.init resolves the best available identity after a heal failure
OK node-red.init removed direct best-effort concentratord repair during startup
OK node-red.init removed direct best-effort identity persistence during startup
OK node-red.init defines a startup helper to canonicalize gateway identities before exporting them
OK node-red.init normalizes the runtime gateway identity to uppercase before using it for MQTT credentials
OK node-red.init normalizes the linked gateway identity to uppercase before exporting it
OK node-red.init exports the derived gateway EUI into the Node-RED runtime environment
OK node-red.init exports gateway identity confidence into the Node-RED runtime environment
OK node-red.init exports the linked gateway identity into the Node-RED runtime environment
OK node-red.init exports the private-target override into the Node-RED runtime environment
OK 96_osi_server_config uses the shared gateway identity helper for first-boot seeding
OK 96_osi_server_config resolves the canonical gateway identity during UCI seeding
OK 96_osi_server_config persists canonical gateway identity during UCI seeding
OK 96_osi_server_config stores the identity source in UCI
OK 96_osi_server_config stores the identity confidence in UCI
OK 96_osi_server_config initializes linked gateway identity metadata in UCI
OK 96_osi_server_config defaults the private-target override to disabled
OK chirpstack-bootstrap.js uses the shared gateway identity helper during one-shot bootstrap detection
OK chirpstack-bootstrap.js reads gateway identity via the shared helper during one-shot bootstrap detection
OK chirpstack-bootstrap.js removed persisting a stale gateway identity into .chirpstack.env when Node-RED already injects the canonical runtime value
OK chirpstack-bootstrap.js protects runtime gateway identity keys from env-file overrides
OK chirpstack-bootstrap.js protects DEVICE_EUI from env-file overrides
OK chirpstack-bootstrap.js protects DEVICE_EUI_SOURCE from env-file overrides
OK chirpstack-bootstrap.js protects DEVICE_EUI_CONFIDENCE from env-file overrides
OK chirpstack-bootstrap.js protects DEVICE_EUI_LAST_VERIFIED_AT from env-file overrides
OK chirpstack-bootstrap.js protects LINK_GATEWAY_DEVICE_EUI from env-file overrides
OK chirpstack-bootstrap.js keeps init-provided identity env values when the env file is stale
OK chirpstack-bootstrap.js allows overriding the LSN50 decoder path during bootstrap
OK chirpstack-bootstrap.js allows overriding the STREGA decoder path during bootstrap
OK chirpstack-bootstrap.js tracks the shipped STREGA decoder path in bootstrap config
OK chirpstack-bootstrap.js loads the shipped STREGA decoder during bootstrap
OK chirpstack-bootstrap.js creates or repairs the OSI STREGA profile with a payload codec
OK chirpstack-bootstrap.js tracks the shipped LSN50 decoder path in bootstrap config
OK chirpstack-bootstrap.js loads the shipped LSN50 decoder during bootstrap
OK chirpstack-bootstrap.js creates or repairs the OSI LSN50 profile with a payload codec
OK chirpstack-bootstrap.js allows overriding the LoRain profile name during bootstrap
OK chirpstack-bootstrap.js allows overriding the LoRain decoder path during bootstrap
OK chirpstack-bootstrap.js tracks the shipped LoRain decoder path in bootstrap config
OK chirpstack-bootstrap.js loads the shipped LoRain decoder during bootstrap
OK chirpstack-bootstrap.js creates or repairs the OSI LoRain profile with a payload codec
OK chirpstack-bootstrap.js writes the LoRain ChirpStack profile ID for Node-RED
OK chirpstack-bootstrap.js persists the LoRain profile ID to UCI
OK chirpstack-bootstrap.js closes the provisioning client in a finally after both success and provisioning failure
OK chirpstack-bootstrap.js closes the sole ChirpStack provisioning client during bootstrap cleanup
OK deploy.sh runs communication validation before deploy artifacts are copied
OK deploy.sh uses the focused communication contract verifier during deploy preflight
OK deploy.sh fetches the required communication diagnostic during deploy preflight
OK deploy.sh prints a clear deploy preflight section
OK deploy.sh deploys the Node-RED init script to live devices
OK deploy.sh deploys the shared gateway identity helper to live devices
OK deploy.sh deploys the osi-dendro-helper package manifest to live devices
OK deploy.sh deploys the osi-dendro-helper runtime helper to live devices
OK deploy.sh deploys the osi-history-helper package manifest to live devices
OK deploy.sh deploys the osi-history-helper runtime helper to live devices
OK deploy.sh deploys the shipped STREGA ChirpStack decoder to live devices
OK deploy.sh deploys the shipped LSN50 ChirpStack decoder to live devices
OK deploy.sh deploys the shipped LoRain ChirpStack decoder to live devices
OK deploy.sh removes stale hashed GUI assets AND locale files before extracting the rebuilt React bundle (loop covers assets/, locales/, index.html, dotfiles)
OK deploy.sh keeps the deployed Node-RED init script executable
OK deploy.sh defines the deploy-time schema migration runner
OK deploy.sh provisions sqlite3-cli before running migrations
OK deploy.sh verifies Node-RED has stopped before migrating
OK deploy.sh removed inline dendrometer retracted-ratio deploy repair
OK deploy.sh removed inline dendrometer extended-ratio deploy repair
OK deploy.sh removed inline dendrometer retracted-ratio deploy backfill
OK deploy.sh removed inline dendrometer extended-ratio deploy backfill
OK deploy.sh stops the retired gateway GPS sidecar during deploy
OK deploy.sh disables the retired gateway GPS sidecar during deploy
OK deploy.sh removes the retired gateway GPS sidecar files during deploy
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_ratio_at_retracted in the bundled devices schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_ratio_at_extended in the bundled devices schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_force_legacy in the bundled devices schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_baseline_pending in the bundled devices schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes device_mode in the bundled devices schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes adc_ch1v in the bundled device_data schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_ratio in the bundled device_data schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_mode_used in the bundled device_data schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_stem_change_um in the bundled device_data schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_position_raw_mm in the bundled device_data schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_saturated in the bundled device_data schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_saturation_side in the bundled device_data schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes the bundled applied_commands replay ledger schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes the bundled command_ack_outbox schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes dendro_ratio_at_retracted in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes dendro_ratio_at_extended in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes dendro_force_legacy in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes dendro_baseline_pending in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes device_mode in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes adc_ch1v in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes dendro_ratio in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes dendro_mode_used in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes dendro_stem_change_um in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes dendro_position_raw_mm in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes dendro_saturated in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes dendro_saturation_side in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes the bundled applied_commands replay ledger schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes the bundled command_ack_outbox schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes dendro_ratio_at_retracted in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes dendro_ratio_at_extended in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes dendro_force_legacy in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes dendro_baseline_pending in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes device_mode in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes adc_ch1v in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes dendro_ratio in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes dendro_mode_used in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes dendro_stem_change_um in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes dendro_position_raw_mm in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes dendro_saturated in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes dendro_saturation_side in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes the bundled applied_commands replay ledger schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes the bundled command_ack_outbox schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_ratio_at_retracted in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_ratio_at_extended in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_force_legacy in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_baseline_pending in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes device_mode in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes adc_ch1v in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_ratio in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_mode_used in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_stem_change_um in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_position_raw_mm in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_saturated in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_saturation_side in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes the bundled applied_commands replay ledger schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes the bundled command_ack_outbox schema
OK database/farming.db includes dendro_ratio_at_retracted in the bundled devices schema
OK database/farming.db includes dendro_ratio_at_extended in the bundled devices schema
OK database/farming.db includes dendro_force_legacy in the bundled devices schema
OK database/farming.db includes dendro_baseline_pending in the bundled devices schema
OK database/farming.db includes device_mode in the bundled devices schema
OK database/farming.db includes adc_ch1v in the bundled device_data schema
OK database/farming.db includes dendro_ratio in the bundled device_data schema
OK database/farming.db includes dendro_mode_used in the bundled device_data schema
OK database/farming.db includes dendro_stem_change_um in the bundled device_data schema
OK database/farming.db includes dendro_position_raw_mm in the bundled device_data schema
OK database/farming.db includes dendro_saturated in the bundled device_data schema
OK database/farming.db includes dendro_saturation_side in the bundled device_data schema
OK database/farming.db includes the bundled applied_commands replay ledger schema
OK database/farming.db includes the bundled command_ack_outbox schema
OK web/react-gui/farming.db includes dendro_ratio_at_retracted in the bundled devices schema
OK web/react-gui/farming.db includes dendro_ratio_at_extended in the bundled devices schema
OK web/react-gui/farming.db includes dendro_force_legacy in the bundled devices schema
OK web/react-gui/farming.db includes dendro_baseline_pending in the bundled devices schema
OK web/react-gui/farming.db includes device_mode in the bundled devices schema
OK web/react-gui/farming.db includes adc_ch1v in the bundled device_data schema
OK web/react-gui/farming.db includes dendro_ratio in the bundled device_data schema
OK web/react-gui/farming.db includes dendro_mode_used in the bundled device_data schema
OK web/react-gui/farming.db includes dendro_stem_change_um in the bundled device_data schema
OK web/react-gui/farming.db includes dendro_position_raw_mm in the bundled device_data schema
OK web/react-gui/farming.db includes dendro_saturated in the bundled device_data schema
OK web/react-gui/farming.db includes dendro_saturation_side in the bundled device_data schema
OK web/react-gui/farming.db includes the bundled applied_commands replay ledger schema
OK web/react-gui/farming.db includes the bundled command_ack_outbox schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes bat_pct in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes bat_pct in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes bat_pct in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes bat_pct in the bundled device_data schema
OK database/farming.db includes bat_pct in the bundled device_data schema
OK web/react-gui/farming.db includes bat_pct in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes adc_ch0v in the bundled dendrometer_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes adc_ch1v in the bundled dendrometer_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_ratio in the bundled dendrometer_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes dendro_mode_used in the bundled dendrometer_readings schema
OK database/farming.db includes adc_ch0v in the bundled dendrometer_readings schema
OK database/farming.db includes adc_ch1v in the bundled dendrometer_readings schema
OK database/farming.db includes dendro_ratio in the bundled dendrometer_readings schema
OK database/farming.db includes dendro_mode_used in the bundled dendrometer_readings schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes chameleon_enabled in the bundled devices schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes chameleon_swt1_depth_cm in the bundled devices schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes swt_1 in the bundled device_data schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes data_invalid in the bundled chameleon_readings schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes payload_b64 in the bundled chameleon_readings schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes r1_ohm_comp in the bundled chameleon_readings schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes f_cnt in the bundled chameleon_readings schema
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes idx_chameleon_readings_deveui_time
OK conf/base_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes idx_chameleon_readings_array_id
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes chameleon_enabled in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes chameleon_swt1_depth_cm in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes swt_1 in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes data_invalid in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes payload_b64 in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes r1_ohm_comp in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes f_cnt in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes idx_chameleon_readings_deveui_time
OK conf/full_raspberrypi_bcm27xx_bcm2708/files/usr/share/db/farming.db includes idx_chameleon_readings_array_id
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes chameleon_enabled in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes chameleon_swt1_depth_cm in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes swt_1 in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes data_invalid in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes payload_b64 in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes r1_ohm_comp in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes f_cnt in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes idx_chameleon_readings_deveui_time
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/db/farming.db includes idx_chameleon_readings_array_id
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes chameleon_enabled in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes chameleon_swt1_depth_cm in the bundled devices schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes swt_1 in the bundled device_data schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes data_invalid in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes payload_b64 in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes r1_ohm_comp in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes f_cnt in the bundled chameleon_readings schema
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes idx_chameleon_readings_deveui_time
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes idx_chameleon_readings_array_id
OK database/farming.db includes chameleon_enabled in the bundled devices schema
OK database/farming.db includes chameleon_swt1_depth_cm in the bundled devices schema
OK database/farming.db includes swt_1 in the bundled device_data schema
OK database/farming.db includes data_invalid in the bundled chameleon_readings schema
OK database/farming.db includes payload_b64 in the bundled chameleon_readings schema
OK database/farming.db includes r1_ohm_comp in the bundled chameleon_readings schema
OK database/farming.db includes f_cnt in the bundled chameleon_readings schema
OK database/farming.db includes idx_chameleon_readings_deveui_time
OK database/farming.db includes idx_chameleon_readings_array_id
OK web/react-gui/farming.db includes chameleon_enabled in the bundled devices schema
OK web/react-gui/farming.db includes chameleon_swt1_depth_cm in the bundled devices schema
OK web/react-gui/farming.db includes swt_1 in the bundled device_data schema
OK web/react-gui/farming.db includes data_invalid in the bundled chameleon_readings schema
OK web/react-gui/farming.db includes payload_b64 in the bundled chameleon_readings schema
OK web/react-gui/farming.db includes r1_ohm_comp in the bundled chameleon_readings schema
OK web/react-gui/farming.db includes f_cnt in the bundled chameleon_readings schema
OK web/react-gui/farming.db includes idx_chameleon_readings_deveui_time
OK web/react-gui/farming.db includes idx_chameleon_readings_array_id
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes applied_commands.attempt_count for WS3 retry
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes applied_commands.last_error for WS3 retry
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes applied_commands.last_ack_attempt_at for WS3 ACK outbox
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes applied_commands.expires_at for WS3 expiry
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes command_ack_outbox table for WS3 ACK flush
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes command_ack_outbox.delivered_at for selective delivery tracking
OK database/farming.db includes applied_commands.attempt_count for WS3 retry
OK database/farming.db includes applied_commands.last_error for WS3 retry
OK database/farming.db includes applied_commands.last_ack_attempt_at for WS3 ACK outbox
OK database/farming.db includes applied_commands.expires_at for WS3 expiry
OK database/farming.db includes command_ack_outbox table for WS3 ACK flush
OK database/farming.db includes command_ack_outbox.delivered_at for selective delivery tracking
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes irrigation_schedules table
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes sync_outbox.rejected_at (WS2)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes sync_outbox.rejection_reason (WS2)
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/db/farming.db includes sync_outbox.last_retryable_failure_at (WS2)
OK database/farming.db includes irrigation_schedules table
OK database/farming.db includes sync_outbox.rejected_at (WS2)
OK database/farming.db includes sync_outbox.rejection_reason (WS2)
OK database/farming.db includes sync_outbox.last_retryable_failure_at (WS2)
OK 96_osi_server_config 96_osi_server_config seeds firmware_version 0.7.0
OK node-red.init node-red.init fallback version is 0.7.0
OK flows.json heartbeat fallback version is 0.7.0
OK 97_osi_db_seed uci-defaults script present
OK 97_osi_db_seed 97_osi_db_seed seeds from /usr/share/db/farming.db
OK 97_osi_db_seed 97_osi_db_seed seeds to /data/db/farming.db
OK 97_osi_db_seed 97_osi_db_seed skips seed when target DB exists
OK 97_osi_db_seed removed 97_osi_db_seed must not force-overwrite existing DB
OK 98_osi_node_red_seed uci-defaults script present
OK 98_osi_node_red_seed seeds Node-RED package manifest before runtime startup
OK 98_osi_node_red_seed seeds Node-RED package lock before runtime startup
OK 98_osi_node_red_seed seeds local helper package directories for file dependencies
OK 98_osi_node_red_seed seeds local helper packages into runtime node_modules
OK 98_osi_node_red_seed replaces stale helper copies in both package locations
OK 98_osi_node_red_seed seeds the history helper package directory
OK install-osi-os.sh present
OK database/seed-blank.sql present
OK seed-blank.sql seed-blank.sql defines irrigation_schedules table
OK seed-blank.sql seed-blank.sql includes sync_outbox.rejected_at (WS2)
OK seed-blank.sql seed-blank.sql includes applied_commands table (WS3)
OK seed-blank.sql seed-blank.sql includes chameleon_readings table
OK seed-blank.sql seed-blank.sql includes valve_actuation_expectations table (WS1)
OK osi-gateway-identity.sh defines the shared canonical gateway resolver
OK osi-gateway-identity.sh derives the active concentratord chipset before probing static gateway identifiers
OK osi-gateway-identity.sh reads the active concentratord chipset from UCI
OK osi-gateway-identity.sh limits static UCI gateway-id probing to the active chipset
OK osi-gateway-identity.sh limits TOML gateway-id probing to the active chipset
OK osi-gateway-identity.sh defines startup self-healing for active concentratord gateway-id state
OK osi-gateway-identity.sh defines the exact resolve-repair-resolve-persist heal order
OK osi-gateway-identity.sh dispatches the heal command and emits the resolved shell fields
OK gateway identity helper focused test
OK osi-gateway-identity.sh marks live ChirpStack-derived gateway identities as authoritative
OK osi-gateway-identity.sh marks previously verified gateway identities as persisted
OK osi-gateway-identity.sh marks MAC-derived gateway identities as provisional
OK osi-gateway-identity.sh uses an explicit hex-only uppercase conversion that works on BusyBox
OK osi-gateway-identity.sh runs gateway detection in a non-login shell so banner output cannot poison detection
OK osi-gateway-identity.sh prefers runtime concentratord gateway identity when available
OK osi-gateway-identity.sh downgrades MAC-derived concentratord IDs away from authoritative confidence
OK osi-gateway-identity.sh falls back across known interfaces for provisional MAC-derived identity
OK osi-gateway-identity.sh removed hard-coded sx1302 fallback outside active-chipset-aware resolution
OK osi-gateway-identity.sh removed hard-coded sx1301 fallback outside active-chipset-aware resolution
OK osi-gateway-identity.sh removed blank-chipset TOML fallback outside active-chipset-aware resolution
OK 99_set_sx1301_gateway_id uses the shared gateway identity helper for first-boot concentratord seeding
OK 99_set_sx1301_gateway_id seeds only the active LoRa concentratord section
OK 99_set_sx1301_gateway_id keeps a single MAC-derived fallback path for first-boot concentratord seeding
OK 99_set_sx1301_gateway_id removed hard-coded sx1302 seeding outside active-chipset-aware logic
OK 99_set_sx1301_gateway_id removed hard-coded sx1301 seeding outside active-chipset-aware logic
OK bcm2712 ships rootfs grow uci-default
OK bcm2709 ships rootfs grow uci-default
OK bcm2712 ships rootfs resize init
OK bcm2709 ships rootfs resize init
OK 90_osi_rootfs_grow uses parted for in-place partition growth
OK 90_osi_rootfs_grow does not re-partition while filesystem resize is pending
OK 90_osi_rootfs_grow grows the root partition to the end of the disk
OK osi-rootfs-resize runs filesystem resize before Node-RED startup
OK osi-rootfs-resize grows the mounted filesystem after reboot
OK full_raspberrypi_bcm27xx_bcm2712 full_raspberrypi_bcm27xx_bcm2712 includes parted for rootfs grow
OK full_raspberrypi_bcm27xx_bcm2712 full_raspberrypi_bcm27xx_bcm2712 includes resize2fs for rootfs grow
OK full_raspberrypi_bcm27xx_bcm2712 full_raspberrypi_bcm27xx_bcm2712 includes kmod-hwmon-pwmfan for fan thermal control
OK full_raspberrypi_bcm27xx_bcm2709 full_raspberrypi_bcm27xx_bcm2709 includes parted for rootfs grow
OK full_raspberrypi_bcm27xx_bcm2709 full_raspberrypi_bcm27xx_bcm2709 includes resize2fs for rootfs grow
OK boot-config.patch boot config enables Pi 5 cooling fan hardware (rp1_pwm1 + cooling_fan DT nodes)
OK osi-bootstrap init script present
OK chirpstack init START priority
OK node-red init START priority
OK osi-bootstrap init START priority
OK OpenWrt START/name startup order for first-boot provisioning
OK overlay chirpstack-bootstrap.js present
OK overlay chirpstack-bootstrap.js matches scripts/chirpstack-bootstrap.js byte-for-byte
OK osi-bootstrap init script defines stamp validity check
OK osi-bootstrap init script uses the canonical stamp file path
OK osi-bootstrap init script checks env file existence
OK osi-bootstrap init script validates env file contains valid app UUIDs
OK osi-bootstrap init script prefers the ROM bootstrap script
OK osi-bootstrap init script keeps the live-deploy bootstrap fallback
OK osi-bootstrap init script retries instead of marking done when bootstrap script is missing
OK osi-bootstrap removed missing-script success path
OK osi-bootstrap init script waits for ChirpStack gRPC via curl
OK osi-bootstrap init script retries gRPC health check up to 24 times
OK osi-bootstrap init script treats stamp write as part of successful provisioning
OK osi-bootstrap init script tracks successful first-boot provisioning
OK osi-bootstrap init script gates the restart request on successful provisioning
OK osi-bootstrap init script requests a coordinated restart after successful provisioning
OK osi-bootstrap removed direct Node-RED restart after provisioning
OK osi-bootstrap init script logs all events with the correct tag
OK osi-bootstrap does not set a shutdown priority (one-shot)
OK osi-bootstrap uci-defaults activation script present
OK 95_osi_bootstrap_enable activation script enables the osi-bootstrap init on first boot
OK sysupgrade.conf present
OK sysupgrade.conf sysupgrade.conf preserves the osi-bootstrap stamp file
OK removed insecure auth fallback osi-os-default-auth-secret
OK removed insecure auth fallback env.get('CHIRPSTACK_API_KEY')
OK package.json includes @chirpstack/chirpstack-api
OK package.json includes @grpc/grpc-js
OK package.json includes @rakwireless/field-tester-server
OK package.json includes bcryptjs
OK package.json includes node-red-node-sqlite
OK package.json includes osi-chirpstack-helper
OK package.json includes osi-db-helper
OK package.json includes osi-dendro-helper
OK package.json includes osi-history-helper
OK package.json includes sqlite3
OK osi-cloud-http helper exists
OK osi-cloud-http/index.js forces IPv4 DNS/address selection
OK osi-cloud-http/index.js exports requestJsonIpv4
OK osi-cloud-http/index.js sets a bounded cloud REST timeout
OK osi-cloud-http/index.js parses JSON responses
OK osi-cloud-http/index.js rejects aborted response streams
OK osi-cloud-http/index.js rejects response stream errors
OK osi-cloud-http/index.js rejects incomplete response stream closes
OK osi-cloud-http/index.js guards cloud REST requests against double settlement
OK osi-cloud-http/package.json declares the helper package name
OK node-red/package.json installs the helper package as a local dependency
OK node-red/package.json installs the history helper package as a local dependency
OK node-red/node_modules/osi-chameleon-helper is a tracked local-helper symlink
OK node-red/node_modules/osi-chirpstack-helper is a tracked local-helper symlink
OK node-red/node_modules/osi-cloud-http is a tracked local-helper symlink
OK node-red/node_modules/osi-db-helper is a tracked local-helper symlink
OK node-red/node_modules/osi-dendro-helper is a tracked local-helper symlink
OK node-red/node_modules/osi-history-helper is a tracked local-helper symlink
OK osi-chirpstack-helper/index.js adds profile reads so bootstrap can inspect existing ChirpStack codecs
OK osi-chirpstack-helper/index.js adds profile updates so bootstrap can repair codec-less ChirpStack profiles
OK osi-chirpstack-helper/index.js flushes device queues with the ChirpStack gRPC request type
OK osi-chirpstack-helper/index.js flushes device queues through DeviceService.FlushQueue
OK osi-chirpstack-helper/index.js removed REST device queue path
OK osi-chirpstack-helper/index.js removed REST device queue DELETE
OK osi-chirpstack-helper/index.js removed REST queue-flush error handling
OK osi-chirpstack-helper/index.js checks the aggregate ownership fence before compensation
OK osi-chirpstack-helper/index.js returns a non-enumerable guarded compensation boundary to registration callers
OK helper exports createClient
OK helper exports createProvisioningClientFromEnv
OK helper exports normalizeApiUrl
OK cs-register-device-fn declares the sole ChirpStack client outside the try block
OK cs-register-device-fn assigns the client inside the try block
OK cs-register-device-fn creates exactly one ChirpStack client: no second cleanup client
OK cs-register-device-fn removed the retired second cleanup client
OK cs-register-device-fn removed the retired deviceCreated field
OK cs-register-device-fn removed the retired numeric grpcStatus field
OK cs-register-device-fn removed the retired error.details field
OK cs-register-device-fn uses guarded helper compensation after any post-provisioning local save failure
OK cs-register-device-fn reads the new normalized error.code instead of numeric grpcStatus
OK cs-register-device-fn surfaces the full reconciliation result (deviceAction/keysAction/keysVerified/verifiedApplicationId/verifiedDeviceProfileId) as local registration evidence
OK cs-register-device-fn closes the ChirpStack client and the local DB in a single finally on every path, surfacing an unexpected close() throw via node.warn
OK cs-reg-cloud-fn declares the sole ChirpStack client outside the try block for REGISTER_DEVICE
OK cs-reg-cloud-fn assigns the client inside the try block
OK cs-reg-cloud-fn creates exactly one ChirpStack client: no second cleanup client
OK cs-reg-cloud-fn removed the retired deviceCreated field
OK cs-reg-cloud-fn removed the retired numeric grpcStatus field
OK cs-reg-cloud-fn removed the retired error.details field
OK cs-reg-cloud-fn uses guarded helper compensation after any post-provisioning local save failure
OK cs-reg-cloud-fn reads the new normalized error.code instead of numeric grpcStatus
OK cs-reg-cloud-fn preserves the exact success ACK shape (commit/ACK path unchanged)
OK cs-reg-cloud-fn closes the ChirpStack client and the local DB in a single finally on every REGISTER_DEVICE path, surfacing an unexpected close() throw via node.warn
OK cs-reg-cloud-ack-fn forwards the normalized error.code instead of the retired grpcStatus
OK cs-reg-cloud-ack-fn removed the retired grpcStatus field
OK post-devices-response forwards the whole reconciliation result (deviceAction/keysAction/keysVerified/verifiedApplicationId/verifiedDeviceProfileId) to API callers
OK post-devices-response removed the retired deviceCreated field
OK cancel-strega-actuation-fn declares the sole ChirpStack client outside the try block
OK cancel-strega-actuation-fn removed the client must be hoisted (not const-declared) so the finally can close it
OK cancel-strega-actuation-fn creates exactly one ChirpStack client: no second cleanup client
OK cancel-strega-actuation-fn closes both the ChirpStack client and the local DB in a single finally that runs on every path
OK cancel-strega-actuation-fn surfaces bounded close() cleanup failures via node.warn without leaking key/token sentinels
OK cancel-strega-actuation-fn surfaces an unexpected close() throw via a fixed, secret-free node.warn message
OK strega_gen1_decoder.js ships the STREGA ChirpStack decoder entry point
OK strega_gen1_decoder.js ships the vendor Gen1 STREGA decoder implementation
OK dragino_lsn50_decoder.js ships the LSN50 ChirpStack decoder entry point
OK dragino_lsn50_decoder.js ships the working MOD3 decoder path from the live LSN50 profile
OK dragino_lsn50_decoder.js ships the working LSN50 CH1 decoder logic
OK aquascope_lorain_decoder.js ships the LoRain ChirpStack decoder entry point
OK aquascope_lorain_decoder.js normalizes LoRain tips to millimeters
OK aquascope_lorain_decoder.js accepts current LoRain FPort 10 and legacy FPort 2 only
OK osi-db-helper/index.js exposes the helper-scoped transaction primitive
OK DB helper source present despite missing local runtime deps: Cannot find module 'sqlite3'
Require stack:
- /home/phil/Repos/osi-os-agrolink/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-db-helper/index.js
- /home/phil/Repos/osi-os-agrolink/scripts/verify-sync-flow.js
OK DB helper source includes Database
OK DB helper source includes getHealth
OK DB helper source includes quickCheck
OK osi-db-helper/index.js exposes the queued helper transaction primitive
OK history helper exports normalizeDeveui
OK history helper exports analysisSeriesId
OK history helper exports buildAnalysisCatalog
OK history helper exports resolveAnalysisSeries
OK history helper exports listAnalysisViews
OK history helper exports saveAnalysisView
OK history helper exports deriveCardId
OK history helper exports deriveCardsForZone
OK history helper exports deriveGatewayCard
OK history helper exports resolveAggregation
OK history helper exports classifySoilStatus
OK history helper exports classifyEnvironmentStatus
OK history helper exports classifyDendroStatus
OK history helper exports classifyIrrigationStatus
OK history helper exports classifyGatewayStatus
OK history helper exports deriveExpectedCadenceSeconds
OK history helper exports startOfLocalDayMs
OK history helper exports computeRollupBuckets
OK history helper exports upsertRollups
OK history helper exports runRollupJob
OK history helper exports resolveDeviceFieldRollupKey
OK history helper exports legacySensorHistory
OK history helper exports buildZoneExportCsv
OK history helper exports toCsv
OK history helper exports writeZoneCsv
OK history helper exports rotateZoneCsv
OK history helper exports aggregateRows
OK history helper exports aggregateDeviceData
OK history helper exports buildAdvancedMetadataPlaceholder
OK history helper exports buildCalendar
OK history helper exports buildLocalInterpretations
OK SQL-backed history helper tests pass
OK edge channel ids match canonical manifest
OK history-api-router-fn logs per-phase timing for history endpoint performance triage
OK history-api-router-fn defines a phase timing helper for single execution phases
OK history-api-router-fn defines a phase timing helper for repeated helper calls
OK history-api-router-fn formats phase timing in history API logs
OK history-api-router-fn tracks latest device row lookup timing
OK history-api-router-fn tracks latest Chameleon row lookup timing
OK history-api-router-fn tracks aggregation helper timing
OK history-api-router-fn defines a version marker for the history schema guard
OK history-api-router-fn caches the history schema guard version in Node-RED global context
OK history-api-router-fn stores the applied history schema guard version
OK history-api-router-fn uses deterministic time-first latest device row lookup
OK history-api-router-fn uses deterministic time-first latest Chameleon row lookup
OK history-api-router-fn removed latest device row MAX(id) lookup
OK history-api-router-fn removed latest Chameleon row MAX(id) lookup
OK osi-history-router/index.js uses the farmer-facing Soil Moisture card title
OK osi-history-router/index.js removed old Soil - Root Zone card title
OK osi-history-router/index.js centralizes soil channel depth lookup for history views
OK osi-history-router/index.js adds depth metadata to soil line series
OK dendro helper exports decodeRawAdcPayload
OK dendro helper exports detectDendroModeUsed
OK dendro helper exports calculateDendroRatio
OK dendro helper exports calculateRatioDendroPositionMm
OK dendro helper exports calculateRatioDendroPositionRawMm
OK dendro helper exports buildDendroDerivedMetrics
OK dendro helper exports computeDendroDeltaMm
OK dendro helper exports computeDendroStemChangeUm
OK dendro helper decodes ADC_CH0V from raw MOD3 payloads
OK dendro helper decodes ADC_CH1V from raw MOD3 payloads
OK dendro helper decodes ADC_CH4V from raw MOD3 payloads
OK dendro helper decodes MOD3 mode from raw payloads
OK dendro helper still decodes ADC_CH0V from legacy raw payloads
OK dendro helper ignores raw CH1 fallback data outside MOD3
OK dendro helper ignores raw CH4 fallback data outside MOD3
OK dendro helper preserves the observed legacy mode from raw payloads
OK legacy dendrometer path remains active outside MOD3
OK legacy dendrometer path does not expose a ratio
OK legacy dendrometer path preserves raw single-ADC conversion
OK legacy dendrometer path preserves single-ADC conversion
OK legacy dendrometer path is not flagged as saturated
OK legacy dendrometer path has no saturation side
OK MOD3 dendrometer path switches to ratio mode when CH0 and CH1 are valid
OK ratio dendrometer path exposes the raw ratio
OK ratio dendrometer path converts raw calibrated displacement
OK ratio dendrometer path converts calibrated displacement
OK in-range ratio dendrometer samples are not flagged as saturated
OK in-range ratio dendrometer samples have no saturation side
OK near-zero CH1 falls back to the legacy dendrometer path
OK near-zero CH1 does not leak a ratio through the legacy fallback
OK near-zero CH1 preserves legacy dendrometer comparability
OK below-range ratio samples preserve negative raw displacement
OK below-range ratio samples keep a clamped compatibility position
OK below-range ratio samples are flagged as saturated
OK below-range ratio samples report low-side saturation
OK above-range ratio samples preserve over-stroke raw displacement
OK above-range ratio samples keep a clamped compatibility position
OK above-range ratio samples are flagged as saturated
OK above-range ratio samples report high-side saturation
OK ratio mode still activates without calibration values
OK ratio mode still exposes raw ratios when calibration is missing
OK ratio mode does not synthesize raw displacement when calibration is missing
OK ratio mode does not synthesize calibrated displacement when calibration is missing
OK ratio mode flags missing calibration cleanly
OK dendrometer delta resets when the conversion path changes
OK dendrometer delta resets when calibration changes
OK the first valid calibrated dendrometer reading establishes a zero stem-change baseline
OK the first valid calibrated dendrometer reading becomes the persisted baseline position
OK stem change is reported in micrometers relative to the device baseline
OK stem change resets to zero when the conversion path changes
OK 062a0f9bf66d9789 heartbeat payload includes fan_available field
OK 062a0f9bf66d9789 heartbeat tries hwmon path first
OK 062a0f9bf66d9789 heartbeat falls back to raw PWM when hwmon absent
OK Fan Control uses findFanControl helper for dual-path fan discovery
OK Fan Control prefers hwmon sysfs when available
OK Fan Control sets hwmon fan control mode when driver is loaded
OK Fan Control speed=0 switches to thermal auto mode via hwmon
OK Fan Control falls back to raw PWM sysfs when hwmon absent
OK 934bf2bc19a8ce22 SET_FAN tries hwmon path first
OK 934bf2bc19a8ce22 SET_FAN sets hwmon fan control mode when driver is loaded
OK 934bf2bc19a8ce22 SET_FAN speed=0 switches to thermal auto mode via hwmon
OK 934bf2bc19a8ce22 SET_FAN falls back to raw PWM sysfs when hwmon absent
(node:4118814) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
OK sensor-data CSV export doubles raw quotes and quotes comma-containing fields
OK sensor-data CSV export neutralizes spreadsheet formulas
OK Kiwi legacy simulator payloads without deviceInfo are accepted
OK Kiwi legacy simulator input frequencies are mapped to Watermark readings
OK LSN50 object temperature is not overwritten by null raw decode temperature
OK LSN50_WRITER_DISABLE=1 returns only output 2 with stage forced_flag
OK LSN50_WRITER_DISABLE=1 never calls the writer
OK lsn50-fallback-marker-fn rejects an unknown/missing fallback stage without writing SQL
OK legacy dendrometer SQL keeps adc_v while adding CH0/CH1/ratio debug columns
OK legacy dendrometer SQL preserves adc_v and adc_ch0v semantics for historical rows
OK MOD3 dendrometer SQL persists CH1, ratio, and ratio-mode metadata
OK LoRain branch rejects non-LoRain profiles
OK LoRain SQL insert persists normalized rain telemetry
OK LoRain SQL insert includes battery, rain-rate values, and status
OK S2120 SQL insert persists normalized rain telemetry and interval length
OK S2120 SQL insert includes the computed rain-rate values and status
OK mock osiDb run forwards SQL to queryHandler.run
OK mock osiDb run rejects promise-style callers when queryHandler.run fails
OK STREGA telemetry fixture preserves the raw battery value
OK STREGA telemetry fixture preserves the normalized battery percent
OK STREGA telemetry fixture drops the sentinel ambient temperature
OK STREGA telemetry fixture drops the sentinel relative humidity
OK STREGA telemetry fixture preserves the valve state
OK mock osiDb run reports errors to callback-style callers
OK mock osiDb run does not reject callback-style callers after invoking the callback
OK LSN50 normalizer_load failure returns only output 2 with the exact stage/code
OK LSN50 normalizer_load failure calls node.error once with the fixed code
OK LSN50 normalizer_load failure reaches the shared Record Error counter exactly once
OK UC512 normalizer_load failure emits no success output
OK UC512 normalizer_load failure calls node.error once with the fixed code NORMALIZER_LOAD_FAILED
OK UC512 normalizer_load failure sets red node status
OK UC512 normalizer_load failure reaches the shared Record Error counter exactly once
OK field-test CSV export doubles raw quotes and quotes comma-containing fields
OK field-test CSV export neutralizes spreadsheet formulas
OK lsn50-fallback-marker-fn rejects a missing fallback stage without writing SQL
OK LoRain negative rain fixture marks invalid rain
OK LoRain negative rain fixture does not persist a negative rain delta
OK LoRain negative rain fixture does not emit a zone-rain update
OK STREGA process fixture preserves the raw battery value
OK STREGA process fixture preserves the normalized battery percent
OK STREGA process fixture drops the sentinel ambient temperature
OK STREGA process fixture drops the sentinel relative humidity
OK STREGA process fixture preserves the valve state
OK LSN50 success+close-failure calls the writer exactly once (no duplicate insert)
OK LSN50 success+close-failure preserves output 1 (the single inserted row) and never enters legacy fallback
OK LSN50 success+close-failure does not tag the message with a fallback stage
OK LSN50 success+close-failure calls node.error exactly once with the fixed DB_CLOSE_FAILED code
OK LSN50 success+close-failure reaches the shared Record Error counter exactly once
OK lsn50-fallback-marker-fn builds the literal writer_fallback insert with the uppercased deveui and stage
OK lsn50-fallback-marker-fn marks the fallback channel as __writer__
OK real LSN50 node assembly (mode 1, undefined inactive placeholders) produces zero ingest_quarantine rows
OK real LSN50 node assembly (mode 1, undefined inactive placeholders) returns only output 1
OK real LSN50 node assembly (mode 1, undefined inactive placeholders) inserts a device_data row
OK LoRain zone aggregate writes source aquascope_lorain
OK LoRain zone aggregate adds deltas while honoring device daily total
OK LSN50 writer_load failure returns only output 2 with the exact stage/code
OK LSN50 writer_load failure reaches the shared Record Error counter exactly once
OK UC512 writer_load failure emits no success output
OK UC512 writer_load failure calls node.error once with the fixed code WRITER_LOAD_FAILED
OK UC512 writer_load failure sets red node status
OK UC512 writer_load failure reaches the shared Record Error counter exactly once
OK LSN50_WRITER_DISABLE='0' is not truthy and still reaches the writer
OK LSN50_WRITER_DISABLE='0' returns only output 1
OK lsn50-fallback-evict-fn emits the writer-matching ingest_quarantine eviction cap (LIMIT 1000)
OK LoRain duplicate fixture skips duplicate timestamps
OK LoRain duplicate fixture does not emit a duplicate rain delta
OK LoRain duplicate fixture does not emit a zone-rain update
OK LSN50 manifest_load failure returns only output 2 with the exact stage/code
OK LSN50 manifest_load secret-sentinel error text never reaches the returned message or Node-RED logs
OK LSN50 manifest_load failure reaches the shared Record Error counter exactly once
OK UC512 identity_missing failure emits no success output
OK UC512 identity_missing failure calls node.error once with the fixed code IDENTITY_MISSING
OK UC512 identity_missing failure sets red node status
OK UC512 identity_missing failure reaches the shared Record Error counter exactly once
OK LSN50 writer-failure+close-failure retains the writer_run fallback stage exactly once
OK LSN50 writer-failure+close-failure calls node.error exactly twice (writer_run once, DB_CLOSE_FAILED once)
OK LSN50 writer-failure+close-failure records the writer error before the cleanup error, each with its own fixed code
OK real LSN50 node assembly (mode 1, null inactive placeholders) produces zero ingest_quarantine rows
OK real LSN50 node assembly (mode 1, null inactive placeholders) returns only output 1
OK real LSN50 node assembly (mode 1, null inactive placeholders) inserts a device_data row
OK LoRain first interval sample is valid rain
OK LoRain fixture preserves interval rain delta
OK LoRain fixture preserves tip count
OK LoRain first interval sample does not fabricate elapsed seconds
OK LoRain first interval sample does not fabricate a rate
OK LoRain fixture accumulates local-day rain totals
OK LoRain first interval sample emits zone-rain update
OK LoRain raw rainlevel fixture converts 0.5 mm steps to millimeters
OK LoRain raw rainlevel fixture uses raw rainlevel as tip count
OK LoRain normalized rain_mm_delta wins over disagreeing raw rainlevel fallback
OK LoRain disagreeing-source fixture still uses raw rainlevel as fallback tip count
OK LoRain interval fixture marks valid rain
OK LoRain interval fixture computes hourly rain rate
OK LoRain interval fixture computes normalized rain per 10 minutes
OK LoRain interval fixture stores elapsed seconds
OK LoRain interval fixture emits zone-rain update
OK S2120 fixture maps measurement 4113 to cumulative rain
OK S2120 fixture maps measurement 4213 to wind gust
OK S2120 fixture maps measurement 4103 to battery percent
OK S2120 fixture normalizes pressure to hPa
OK S2120 fixture marks the first rain sample without fabricating a delta
OK S2120 first-sample fixture leaves the normalized rain rate empty
OK S2120 first-sample fixture does not emit a zone-rain update
OK S2120 fixture marks increasing cumulative rain as valid
OK S2120 fixture computes rain deltas from cumulative rain
OK S2120 fixture computes hourly rain rate from elapsed time
OK S2120 fixture computes normalized rain per 10 minutes
OK S2120 fixture accumulates local-day rain totals
OK S2120 fixture stores the elapsed rain-counter interval in seconds
OK S2120 fixture emits valid rain deltas to the zone aggregation path
OK S2120 fixture skips duplicate timestamps
OK S2120 duplicate fixture does not emit a duplicate rain delta
OK S2120 duplicate fixture does not emit a zone-rain update
OK LSN50 normalize_run failure returns only output 2 with the exact stage/code
OK LSN50 normalize_run secret-sentinel error text never reaches the returned message or Node-RED logs
OK LSN50 normalize_run failure reaches the shared Record Error counter exactly once
OK UC512 manifest_load failure emits no success output
OK UC512 manifest_load failure calls node.error once with the fixed code MANIFEST_LOAD_FAILED
OK UC512 manifest_load failure sets red node status
OK UC512 manifest_load failure reaches the shared Record Error counter exactly once
OK LSN50 db_open failure returns only output 2 with the exact stage/code
OK LSN50 db_open secret-sentinel error text never reaches the returned message or Node-RED logs
OK LSN50 db_open failure reaches the shared Record Error counter exactly once
OK UC512 normalize_run failure emits no success output
OK UC512 normalize_run failure calls node.error once with the fixed code NORMALIZE_RUN_FAILED
OK UC512 normalize_run failure sets red node status
OK UC512 normalize_run failure reaches the shared Record Error counter exactly once
OK real LSN50 node assembly (mode 9, undefined inactive placeholders) produces zero ingest_quarantine rows
OK real LSN50 node assembly (mode 9, undefined inactive placeholders) returns only output 1
OK real LSN50 node assembly (mode 9, undefined inactive placeholders) inserts a device_data row
OK UC512 db_open failure emits no success output
OK UC512 db_open failure calls node.error once with the fixed code DB_OPEN_FAILED
OK UC512 db_open failure sets red node status
OK UC512 db_open failure reaches the shared Record Error counter exactly once
OK LSN50 writer_run rejection returns only output 2 (the original msg) with the exact stage/code
OK LSN50 writer_run rejection passes the original msg object to node.error
OK LSN50 writer_run secret-sentinel error text never reaches the returned message or Node-RED logs
OK LSN50 writer_run rejection reaches the shared Record Error counter exactly once
OK real LSN50 node assembly (mode 9, null inactive placeholders) produces zero ingest_quarantine rows
OK real LSN50 node assembly (mode 9, null inactive placeholders) returns only output 1
OK real LSN50 node assembly (mode 9, null inactive placeholders) inserts a device_data row
OK LSN50 writer_run secret-sentinel error text never reaches the fallback marker SQL
OK UC512 writer_run rejection reports the error instead of claiming success
OK UC512 writer_run rejection passes the original msg to node.error
OK UC512 writer_run secret-sentinel error text never reaches Node-RED logs
OK UC512 writer_run rejection reaches the shared Record Error counter exactly once
OK UC512 success+close-failure still returns the message (write itself succeeded)
OK UC512 db_close failure calls node.error once with the fixed DB_CLOSE_FAILED code
OK UC512 db_close failure reaches the shared Record Error counter exactly once
OK DB helper transaction commits inner queued writes
OK DB helper transaction surfaces a real fake DB operation failure
OK DB helper transaction rolls back writes after a fake DB operation failure
OK DB helper queue accepts a write queued before the failed transaction settled
OK DB helper preserves committed rows and excludes the failed write after queue recovery
OK LSN50 success path awaits the writer promise (flag observed set before the node returned)
OK LSN50 success path returns only output 1
Sync flow verification passed
OK openwrt/osi-os.config: build includes jsonfilter
OK jsonfilter Makefile: pinned OpenWrt source declares jsonfilter
OK jsonfilter Makefile: pins the reviewed jsonfilter source revision
OK jsonfilter Makefile: package installs /usr/bin/jsonfilter
OK procd Makefile: pins the reviewed procd rcS snapshot semantics
OK OpenWrt boot init: creates the daemon run directory before applying uci-defaults
OK OpenWrt boot init: retains a failed uci-default for the next boot
OK scripts/verify-sync-flow.js: sync verification chains the live identity verifier
OK scripts/test-identityd-service-lifecycle.sh: mode 755
OK Node-RED init: STOP=99
OK conf/full_raspberrypi_bcm27xx_bcm2712/.config: profile image includes jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service starts before Node-RED and bootstrap
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service stops before Node-RED STOP=99
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: STOP=98 precedes Node-RED STOP=99
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service uses procd
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service launches the identity daemon
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service is supervised with respawn
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: service exposes one readiness contract
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-identityd: ready requires procd running and the daemon-owned live lock
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: defaults to a same-boot start
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: records whether rcS already queued the service before enabling it
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: uci-defaults enables the service and remains retryable on failure
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: starts the service on the same factory boot and verifies a fresh live lock owner with a bounded retry
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: checks the rcS snapshot, enables, starts conditionally, then verifies readiness
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: has exactly one enable and one conditional start call
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/94_osi_identityd_enable: has exactly one post-start readiness check
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap requests a coordinated restart
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap proves a live consumer immediately before publishing its restart request
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap removes its stamp when restart coordination fails
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap logs restart-request retry behavior
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/init.d/osi-bootstrap: bootstrap does not restart Node-RED directly
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon parses JSON with jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon owns the lock-readiness predicate
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: readiness requires the atomic symlink lock and its canonical live PID owner
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon CLI exposes readiness
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon validates nullable JSON field types with jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon bounds shell arithmetic inputs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: daemon reads a monotonic clock
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: sentinel carries a monotonic deadline
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: queued delay begins when the daemon consumes the request
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: restart countdown uses the monotonic deadline
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: restart eligibility uses the monotonic clock
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: cache and request readers each reject non-canonical JSON
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/libexec/osi-identityd.sh: sentinel reader rejects non-canonical JSON
OK conf/full_raspberrypi_bcm27xx_bcm2709/.config: profile image includes jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: mode 755
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service starts before Node-RED and bootstrap
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service stops before Node-RED STOP=99
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: STOP=98 precedes Node-RED STOP=99
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service uses procd
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service launches the identity daemon
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service is supervised with respawn
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: service exposes one readiness contract
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: ready requires procd running and the daemon-owned live lock
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: defaults to a same-boot start
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: records whether rcS already queued the service before enabling it
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: uci-defaults enables the service and remains retryable on failure
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: starts the service on the same factory boot and verifies a fresh live lock owner with a bounded retry
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: checks the rcS snapshot, enables, starts conditionally, then verifies readiness
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: has exactly one enable and one conditional start call
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: has exactly one post-start readiness check
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: bootstrap requests a coordinated restart
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: bootstrap proves a live consumer immediately before publishing its restart request
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: bootstrap removes its stamp when restart coordination fails
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: bootstrap logs restart-request retry behavior
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: bootstrap does not restart Node-RED directly
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon parses JSON with jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon owns the lock-readiness predicate
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: readiness requires the atomic symlink lock and its canonical live PID owner
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon CLI exposes readiness
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon validates nullable JSON field types with jsonfilter
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon bounds shell arithmetic inputs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: daemon reads a monotonic clock
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: sentinel carries a monotonic deadline
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: queued delay begins when the daemon consumes the request
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: restart countdown uses the monotonic deadline
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: restart eligibility uses the monotonic clock
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: cache and request readers each reject non-canonical JSON
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: sentinel reader rejects non-canonical JSON
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/libexec/osi-identityd.sh: byte-identical mirror
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-bootstrap: byte-identical mirror
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/init.d/osi-identityd: byte-identical mirror
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/94_osi_identityd_enable: byte-identical mirror
OK scripts/verify-profile-parity.js: CANONICAL_PAYLOAD includes files/usr/libexec/osi-identityd.sh
OK scripts/verify-profile-parity.js: CANONICAL_PAYLOAD includes files/etc/init.d/osi-identityd
OK scripts/verify-profile-parity.js: CANONICAL_PAYLOAD includes files/etc/uci-defaults/94_osi_identityd_enable
OK deploy.sh: fetches the identity daemon
OK deploy.sh: installs the identity daemon
OK deploy.sh: marks the identity daemon executable
OK deploy.sh: fetches the identity service
OK deploy.sh: installs the identity service
OK deploy.sh: marks the identity service executable
OK deploy.sh: fetches the service enable script
OK deploy.sh: installs the service enable script
OK deploy.sh: marks the service enable script executable
OK deploy.sh: fetches the coordinated bootstrap service
OK deploy.sh: installs the coordinated bootstrap service
OK deploy.sh: marks the bootstrap service executable
OK deploy.sh: uses the installed identityd service through the lifecycle fence
OK deploy.sh: enables identityd during live deploy
OK deploy.sh: starts a fresh identityd during live deploy
OK deploy.sh: checks the shared readiness contract during live deploy
OK deploy.sh: does not restart an unquiesced identityd instance
OK deploy.sh: identityd activation follows gateway identity helper installation
OK deploy.sh: identityd activation follows identity daemon installation
OK deploy.sh: identityd activation follows flows payload staging
OK deploy.sh: identityd activation follows flows payload activation
OK deploy.sh: identityd activation follows GUI extraction
OK deploy.sh: uses a bounded shared readiness loop
OK deploy.sh: treats broken symlink locks as present
OK deploy.sh: waits for both procd absence and lock absence
OK deploy.sh: never deletes the daemon ownership lock
OK deploy.sh: preserves queued restart requests while quiesced
OK deploy.sh: preserves the restart sentinel while quiesced
OK deploy.sh: installs restoration and proves quiescence before the sole migration call
OK deploy.sh: has one lifecycle-fenced migration call
OK deploy.sh: catastrophic migration failure explicitly holds both services stopped
OK deploy.sh: EXIT restoration handles Node-RED before identityd and preserves failure status
OK deploy.sh: uses one EXIT cleanup path with signal-specific exit status
OK deploy.sh: final activation starts only after the quiescence gap and waits for readiness
OK deploy.sh: final readiness follows identityd enable/start
OK deploy.sh: disarms restoration only after final readiness succeeds
OK deploy.sh: preserves the missing-DB sidecar guard
OK deploy.sh: retains the direct Node-RED restart immediately after the live payload flip and its existing log
OK deploy.sh: retains the rollback restart
OK deploy.sh: only payload flip and rollback directly restart Node-RED
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json: flow document is an array
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: preserves its absent libs property
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not use require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: restartState reads are allowlisted to reason and restartAt
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field phase
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field restartAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field restartNotBeforeUptime
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field targetDeviceEui
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field target_device_eui
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field requestedAt
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field confidence
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field version
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: missing restart sentinel returns restartPending null
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: valid restart sentinel exposes only restartAt and reason
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: unauthenticated stats omit private and internal sentinel fields
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: missing sentinel reason uses the reviewed public fallback
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: no-deadline healing state exposes a blocked public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: an expired pending deadline remains visible until daemon cleanup
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: invalid JSON exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: array shape exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: non-string deadline exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: unreadable restart sentinel exposes an unreadable public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: hwmon directory failure keeps the fan fallback and warns with context
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: fan probe failures retain the fallback and warn for each probed path
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: expected ENOENT and ENOTDIR fan absence stays quiet with the existing fallback
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: a persistent unexpected fan failure warns once per path and signature
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: a changed unexpected fan failure warns again
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: successful fan-probe recovery resets warning deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: remembered fan failure signatures are bounded
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: successful hwmon listing prunes disappeared children and keeps current deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: disappeared hwmon path warns when it recurs while the current path remains deduplicated
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: hwmon hotplug churn keeps the complete failure map at or below 32 entries
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: successful hwmon listing prunes disappeared children and retains identical current deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: a pruned hwmon path warns when it recurs while the retained path stays deduplicated
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: an evicted hwmon path warns when it recurs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sys-stats-fn: failure-map cap still applies when hwmon listing cannot prune stale children
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json: only system stats and the seven identity gates read the restart sentinel
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: selects the outer error source from the caught error marker, not stale flow state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:command-ack-build-batch: drops command ACK work while restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-state-build: exposes the boolean restart state
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-build-req: clears the password and returns the second/error output with status 503
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: uses the approved fs global
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: publishes into the daemon request directory
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: publishes the exact three-field request contract
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: requires the Node-RED message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: bounds filesystem error detail returned to the operator
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: measures the UTF-8 message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: bounds the filename key before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: encodes msg._msgid into a path-safe deterministic key
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: keys the deterministic final path by the safe message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: uses a unique temporary suffix for retry-safe publication
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: publishes atomically through a unique temporary file
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: reports the scheduled restart
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: has separate success and error outputs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: failure reaches only the HTTP response
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: keeps libs empty
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: does not use /etc/init.d/node-red
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: creates the private request directory with mode 0700
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: writes one temporary file and renames it once
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: hostile msg._msgid is deterministically encoded inside the request directory
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: unique temporary path is renamed to the deterministic final path
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: temporary request uses mode 0600 and exclusive creation
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: final JSON has exactly reason, delaySeconds, and requestedAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: successful publication uses only the success output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: distinct msg._msgid values produce distinct final paths
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: retries keep a deterministic final path and use a fresh temporary suffix
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: missing msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: empty msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: missing fs fails through only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: mkdir failure stops before publication and uses only the bounded error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: ENOSPC fails closed, cleans up, and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: rename failure cleans up and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-restart-node-red: very long msg._msgid fails before filename construction
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: uses the approved fs global
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: publishes into the daemon request directory
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: publishes the exact three-field request contract
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: requires the Node-RED message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: bounds filesystem error detail returned to the operator
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: measures the UTF-8 message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: bounds the filename key before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: encodes msg._msgid into a path-safe deterministic key
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: keys the deterministic final path by the safe message identity
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: uses a unique temporary suffix for retry-safe publication
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: publishes atomically through a unique temporary file
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: reports the scheduled restart
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: has separate success and error outputs
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: failure reaches only the HTTP response
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: keeps libs empty
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: does not use /etc/init.d/node-red
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: creates the private request directory with mode 0700
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: writes one temporary file and renames it once
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: hostile msg._msgid is deterministically encoded inside the request directory
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: unique temporary path is renamed to the deterministic final path
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: temporary request uses mode 0600 and exclusive creation
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: final JSON has exactly reason, delaySeconds, and requestedAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: successful publication uses only the success output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: distinct msg._msgid values produce distinct final paths
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: retries keep a deterministic final path and use a fresh temporary suffix
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: missing msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: empty msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: missing fs fails through only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: mkdir failure stops before publication and uses only the bounded error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: ENOSPC fails closed, cleans up, and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: rename failure cleans up and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-unlink-restart-node-red: very long msg._msgid fails before filename construction
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:al-link-validate: protected function is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-init-fn: protected function is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-bootstrap-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-outbox-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-pending-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json:sync-force-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json: flow document is an array
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: preserves its absent libs property
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not use require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: restartState reads are allowlisted to reason and restartAt
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field phase
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field restartAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field restartNotBeforeUptime
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field targetDeviceEui
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field target_device_eui
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field requestedAt
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field confidence
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: does not reference private sentinel field version
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: missing restart sentinel returns restartPending null
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: valid restart sentinel exposes only restartAt and reason
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: unauthenticated stats omit private and internal sentinel fields
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: missing sentinel reason uses the reviewed public fallback
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: no-deadline healing state exposes a blocked public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: an expired pending deadline remains visible until daemon cleanup
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: invalid JSON exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: array shape exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: non-string deadline exposes a malformed public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: unreadable restart sentinel exposes an unreadable public restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: hwmon directory failure keeps the fan fallback and warns with context
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: fan probe failures retain the fallback and warn for each probed path
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: expected ENOENT and ENOTDIR fan absence stays quiet with the existing fallback
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: a persistent unexpected fan failure warns once per path and signature
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: a changed unexpected fan failure warns again
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: successful fan-probe recovery resets warning deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: remembered fan failure signatures are bounded
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: successful hwmon listing prunes disappeared children and keeps current deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: disappeared hwmon path warns when it recurs while the current path remains deduplicated
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: hwmon hotplug churn keeps the complete failure map at or below 32 entries
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: successful hwmon listing prunes disappeared children and retains identical current deduplication
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: a pruned hwmon path warns when it recurs while the retained path stays deduplicated
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: an evicted hwmon path warns when it recurs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sys-stats-fn: failure-map cap still applies when hwmon listing cannot prune stale children
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json: only system stats and the seven identity gates read the restart sentinel
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: contains the exact fail-closed local restart reader
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: preserves its reviewed libs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: does not use bare require(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: blocks before reading the boot identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: records the existing gateway-identity error source
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: throws a marked status 503 while the identity restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: selects the outer error source from the caught error marker, not stale flow state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:command-ack-build-batch: drops command ACK work while restart is pending
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-state-build: exposes the boolean restart state
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-build-req: clears the password and returns the second/error output with status 503
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: uses the approved fs global
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: publishes into the daemon request directory
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: publishes the exact three-field request contract
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: requires the Node-RED message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: bounds filesystem error detail returned to the operator
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: measures the UTF-8 message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: bounds the filename key before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: encodes msg._msgid into a path-safe deterministic key
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: keys the deterministic final path by the safe message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: uses a unique temporary suffix for retry-safe publication
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: publishes atomically through a unique temporary file
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: reports the scheduled restart
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: has separate success and error outputs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: failure reaches only the HTTP response
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: keeps libs empty
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: does not use /etc/init.d/node-red
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: creates the private request directory with mode 0700
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: writes one temporary file and renames it once
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: hostile msg._msgid is deterministically encoded inside the request directory
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: unique temporary path is renamed to the deterministic final path
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: temporary request uses mode 0600 and exclusive creation
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: final JSON has exactly reason, delaySeconds, and requestedAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: successful publication uses only the success output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: distinct msg._msgid values produce distinct final paths
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: retries keep a deterministic final path and use a fresh temporary suffix
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: missing msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: empty msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: missing fs fails through only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: mkdir failure stops before publication and uses only the bounded error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: ENOSPC fails closed, cleans up, and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: rename failure cleans up and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-restart-node-red: very long msg._msgid fails before filename construction
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: uses the approved fs global
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: publishes into the daemon request directory
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: publishes the exact three-field request contract
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: requires the Node-RED message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: bounds filesystem error detail returned to the operator
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: measures the UTF-8 message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: bounds the filename key before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: encodes msg._msgid into a path-safe deterministic key
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: keys the deterministic final path by the safe message identity
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: uses a unique temporary suffix for retry-safe publication
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: publishes atomically through a unique temporary file
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: reports the scheduled restart
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: has separate success and error outputs
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: failure reaches only the HTTP response
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: keeps libs empty
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: does not use global.get('cp')
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: does not use spawn(
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: does not use /etc/init.d/node-red
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: creates the private request directory with mode 0700
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: writes one temporary file and renames it once
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: hostile msg._msgid is deterministically encoded inside the request directory
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: unique temporary path is renamed to the deterministic final path
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: temporary request uses mode 0600 and exclusive creation
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: final JSON has exactly reason, delaySeconds, and requestedAtEpoch
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: successful publication uses only the success output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: distinct msg._msgid values produce distinct final paths
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: retries keep a deterministic final path and use a fresh temporary suffix
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: missing msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: empty msg._msgid fails visibly before filesystem access
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: missing fs fails through only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: mkdir failure stops before publication and uses only the bounded error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: ENOSPC fails closed, cleans up, and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: rename failure cleans up and uses only the error output
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-unlink-restart-node-red: very long msg._msgid fails before filename construction
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:al-link-validate: protected function is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-init-fn: protected function is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-bootstrap-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-outbox-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-pending-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json:sync-force-build: runGatewayMigrationPreflight is byte-identical to its pre-edit snapshot
OK conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json: byte-identical flow mirror
OK silent-catch baseline records 164 for both maintained profiles
OK silent-catch baseline: records the PR #149 compensation cleanup
OK silent-catch baseline: records the scoped-access auth cleanup
OK silent-catch baseline: records the scoped-access shared-read cleanup
OK size allowance sync-bootstrap-build: owned entry present
OK size allowance sync-bootstrap-build: declares Task 4 growth
OK size allowance sync-outbox-build: owned entry present
OK size allowance sync-outbox-build: declares Task 4 growth
OK size allowance sync-pending-build: owned entry present
OK size allowance sync-pending-build: declares Task 4 growth
OK size allowance sync-force-build: owned entry present
OK size allowance sync-force-build: declares Task 4 growth
OK size allowance command-ack-build-batch: owned entry present
OK size allowance command-ack-build-batch: declares Task 4 growth
OK size allowance sync-state-build: owned entry present
OK size allowance sync-state-build: declares Task 4 growth
OK size allowance al-link-build-req: owned entry present
OK size allowance al-link-build-req: declares Task 4 growth
OK size allowance al-link-restart-node-red: owned entry present
OK size allowance al-link-restart-node-red: declares Task 4 growth
OK size allowance al-unlink-restart-node-red: owned entry present
OK size allowance al-unlink-restart-node-red: declares Task 4 growth
OK size allowance sys-stats-fn: owned entry present
OK size allowance sys-stats-fn: declares Task 5 growth
OK scripts/test-identityd-service-lifecycle.sh: --- Quiesce gateway identity supervisor before schema migration ---
OK
--- Restore gateway identity supervisor after interrupted deploy ---
OK
--- Quiesce gateway identity supervisor before schema migration ---
OK
--- Restore gateway identity supervisor after interrupted deploy ---
OK: identityd restored to stopped state
--- Quiesce gateway identity supervisor before schema migration ---
OK
--- Quiesce gateway identity supervisor before schema migration ---
--- Quiesce gateway identity supervisor before schema migration ---
OK
--- Restore gateway identity supervisor after interrupted deploy ---
OK
--- Quiesce gateway identity supervisor before schema migration ---
OK
--- Restore gateway identity supervisor after interrupted deploy ---
PASS: identityd deploy lifecycle and readiness
Live gateway identity verification passed.

=== conf/full_raspberrypi_bcm27xx_bcm2709 ===
OK:   files/etc/board.d/02_network
OK:   files/etc/config
OK:   files/etc/init.d/osi-rootfs-resize
OK:   files/etc/init.d/osi-bootstrap
OK:   files/etc/init.d/osi-identityd
OK:   files/etc/nginx
OK:   files/etc/redis.conf
OK:   files/etc/sysupgrade.conf
OK:   files/etc/uci-defaults/90_osi_rootfs_grow
OK:   files/etc/uci-defaults/94_osi_identityd_enable
OK:   files/etc/uci-defaults/95_osi_bootstrap_enable
OK:   files/etc/uci-defaults/96_osi_server_config
OK:   files/etc/uci-defaults/97_osi_db_seed
OK:   files/etc/uci-defaults/98_osi_node_red_seed
OK:   files/etc/uci-defaults/99_config_chirpstack_ap
OK:   files/etc/uci-defaults/99_set_hostname
OK:   files/etc/uci-defaults/99_set_sx1301_gateway_id
OK:   files/etc/uci-defaults/99_tailscale_init
OK:   files/usr/libexec/osi-gateway-identity.sh
OK:   files/usr/libexec/osi-identityd.sh
OK:   files/usr/share/db
OK:   files/usr/share/flows.json
OK:   files/usr/share/node-red
OK:   absent: files/etc/uci-defaults/01_update_rc_local_20241118
OK:   absent: files/etc/uci-defaults/99_set_chirpstack_mqtt_forwarder_global_config
OK:   absent: files/etc/uci-defaults/99_set_chirpstack_udp_forwarder_global_config
OK:   absent: files/usr/share/schema.sql
OK:   absent: files/usr/share/sensor_data.db

All parity checks passed.

$ node scripts/verify-scoped-access.js
verify-scoped-access: OK (ratchet only; behavioral matrix is the correctness gate)

$ node scripts/test-scoped-access-command-path.js
(node:4121959) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
TAP version 13
# Subtest: scoped user apply is atomic, replayable, and invalidates the scope cache
ok 1 - scoped user apply is atomic, replayable, and invalidates the scope cache
  ---
  duration_ms: 18.39754
  type: 'test'
  ...
# Subtest: stale base and last-admin mutation return terminal conflicts without changing rows
ok 2 - stale base and last-admin mutation return terminal conflicts without changing rows
  ---
  duration_ms: 4.229227
  type: 'test'
  ...
# Subtest: grant lifecycle applies and tombstones with exact version checks
ok 3 - grant lifecycle applies and tombstones with exact version checks
  ---
  duration_ms: 3.589483
  type: 'test'
  ...
# Subtest: credential ACK and ledger result never contain the password hash
ok 4 - credential ACK and ledger result never contain the password hash
  ---
  duration_ms: 3.293426
  type: 'test'
  ...
# Subtest: malformed effect binding fails closed before mutation
ok 5 - malformed effect binding fails closed before mutation
  ---
  duration_ms: 3.182728
  type: 'test'
  ...
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 40.805147

$ node scripts/test-scoped-access-reads.js
(node:4121969) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
TAP version 13
# Subtest: immutable token subject prevents /api/me from following a reused username
ok 1 - immutable token subject prevents /api/me from following a reused username
  ---
  duration_ms: 53.620079
  type: 'test'
  ...
# Subtest: immutable token subject blocks username reuse across scoped shared reads
ok 2 - immutable token subject blocks username reuse across scoped shared reads
  ---
  duration_ms: 145.488911
  type: 'test'
  ...
# Subtest: immutable token subject blocks username reuse in sensor export and history
ok 3 - immutable token subject blocks username reuse in sensor export and history
  ---
  duration_ms: 74.58421
  type: 'test'
  ...
# Subtest: F2: a researcher can read a granted zone environment summary
ok 4 - F2: a researcher can read a granted zone environment summary
  ---
  duration_ms: 49.196972
  type: 'test'
  ...
# Subtest: F2: a viewer receives 404 for a foreign zone environment summary
ok 5 - F2: a viewer receives 404 for a foreign zone environment summary
  ---
  duration_ms: 34.58929
  type: 'test'
  ...
# Subtest: F2: recommendations honor granted-zone reads and hide foreign zones
ok 6 - F2: recommendations honor granted-zone reads and hide foreign zones
  ---
  duration_ms: 62.443593
  type: 'test'
  ...
# Subtest: F1: scoped lists use owned-plus-granted zones and keep weather shared
ok 7 - F1: scoped lists use owned-plus-granted zones and keep weather shared
  ---
  duration_ms: 40.809407
  type: 'test'
  ...
# Subtest: F1: admin has no scope bypass and flag-off behavior remains owner-only
ok 8 - F1: admin has no scope bypass and flag-off behavior remains owner-only
  ---
  duration_ms: 42.61012
  type: 'test'
  ...
# Subtest: E4: a disabled account is denied before the weather-device OR-branch can be reached
ok 9 - E4: a disabled account is denied before the weather-device OR-branch can be reached
  ---
  duration_ms: 37.305409
  type: 'test'
  ...
# Subtest: F3: device reads allow grants and shared weather, and hide foreign devices
ok 10 - F3: device reads allow grants and shared weather, and hide foreign devices
  ---
  duration_ms: 108.480954
  type: 'test'
  ...
# Subtest: F3: scoped today-liters hides a foreign valve
ok 11 - F3: scoped today-liters hides a foreign valve
  ---
  duration_ms: 39.010161
  type: 'test'
  ...
# Subtest: F3: sensor export filters scoped rows and keeps flag-off behavior
ok 12 - F3: sensor export filters scoped rows and keeps flag-off behavior
  ---
  duration_ms: 71.915023
  type: 'test'
  ...
# Subtest: F3: today-liters remains callable without auth while the flag is off
ok 13 - F3: today-liters remains callable without auth while the flag is off
  ---
  duration_ms: 37.102102
  type: 'test'
  ...
# Subtest: F4: history zone reads allow owned and granted zones but hide foreign zones
ok 14 - F4: history zone reads allow owned and granted zones but hide foreign zones
  ---
  duration_ms: 111.712921
  type: 'test'
  ...
# Subtest: F4: account-wide history export contains only visible zones
ok 15 - F4: account-wide history export contains only visible zones
  ---
  duration_ms: 41.973099
  type: 'test'
  ...
# Subtest: F4b: gateway history is admin-only while scoped access is enabled
ok 16 - F4b: gateway history is admin-only while scoped access is enabled
  ---
  duration_ms: 72.233079
  type: 'test'
  ...
# Subtest: F4b: workspace rows remain owner-only in scoped mode
ok 17 - F4b: workspace rows remain owner-only in scoped mode
  ---
  duration_ms: 37.478475
  type: 'test'
  ...
# Subtest: F4: flag-off history behavior remains owner-only
ok 18 - F4: flag-off history behavior remains owner-only
  ---
  duration_ms: 36.565024
  type: 'test'
  ...
# Subtest: F6: every diagnostic and gateway read rejects non-admin accounts
ok 19 - F6: every diagnostic and gateway read rejects non-admin accounts
  ---
  duration_ms: 327.313348
  type: 'test'
  ...
# Subtest: F6: every diagnostic and gateway read rejects a disabled admin
ok 20 - F6: every diagnostic and gateway read rejects a disabled admin
  ---
  duration_ms: 319.123503
  type: 'test'
  ...
# Subtest: F6: enabled admins pass every route guard
ok 21 - F6: enabled admins pass every route guard
  ---
  duration_ms: 316.449637
  type: 'test'
  ...
# Subtest: F6: database download remains disabled after the admin guard
ok 22 - F6: database download remains disabled after the admin guard
  ---
  duration_ms: 36.023686
  type: 'test'
  ...
# Subtest: F7: catalog is available to every enabled authenticated role
ok 23 - F7: catalog is available to every enabled authenticated role
  ---
  duration_ms: 43.306366
  type: 'test'
  ...
# Subtest: F7: analysis channels include grants and exclude foreign zones
ok 24 - F7: analysis channels include grants and exclude foreign zones
  ---
  duration_ms: 43.672962
  type: 'test'
  ...
# Subtest: F7: analysis series cannot resolve a selector from a foreign zone
ok 25 - F7: analysis series cannot resolve a selector from a foreign zone
  ---
  duration_ms: 42.792824
  type: 'test'
  ...
# Subtest: F7: analysis views remain per-user and drop foreign selectors
ok 26 - F7: analysis views remain per-user and drop foreign selectors
  ---
  duration_ms: 42.366026
  type: 'test'
  ...
# Subtest: F7: analysis view deletion cannot cross user ownership
ok 27 - F7: analysis view deletion cannot cross user ownership
  ---
  duration_ms: 41.125647
  type: 'test'
  ...
# Subtest: F7: recent actuations use owned-plus-granted zone visibility
ok 28 - F7: recent actuations use owned-plus-granted zone visibility
  ---
  duration_ms: 35.891058
  type: 'test'
  ...
# Subtest: F6: flag-off field-test and system-stat routes remain unauthenticated
ok 29 - F6: flag-off field-test and system-stat routes remain unauthenticated
  ---
  duration_ms: 73.664053
  type: 'test'
  ...
1..29
# tests 29
# suites 0
# pass 29
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2438.75712

$ node scripts/test-scoped-access-writes.js
(node:4122031) ExperimentalWarning: SQLite is an experimental feature and might change at any time
(Use `node --trace-warnings ...` to show where the warning was created)
TAP version 13
# Subtest: W1: valve boundary allows in-scope researchers and records the actor
ok 1 - W1: valve boundary allows in-scope researchers and records the actor
  ---
  duration_ms: 45.617478
  type: 'test'
  ...
# Subtest: W1: valve boundary hides foreign devices and rejects viewers or disabled users
ok 2 - W1: valve boundary hides foreign devices and rejects viewers or disabled users
  ---
  duration_ms: 45.258075
  type: 'test'
  ...
# Subtest: W1: enqueue rechecks fresh scope and records applied-command originator
ok 3 - W1: enqueue rechecks fresh scope and records applied-command originator
  ---
  duration_ms: 34.285132
  type: 'test'
  ...
# Subtest: W1: revocation immediately stops enqueue before physical effect
ok 4 - W1: revocation immediately stops enqueue before physical effect
  ---
  duration_ms: 34.242179
  type: 'test'
  ...
# Subtest: R4: a role-denied actor (real zone access, non-mutating role) also gets a terminal ack
ok 5 - R4: a role-denied actor (real zone access, non-mutating role) also gets a terminal ack
  ---
  duration_ms: 33.323141
  type: 'test'
  ...
# Subtest: X1: a transient scope-helper infra error is not treated as a scope decision
ok 6 - X1: a transient scope-helper infra error is not treated as a scope decision
  ---
  duration_ms: 32.43525
  type: 'test'
  ...
# Subtest: X2: a granted researcher actuates a timed STREGA action with the actor propagated
ok 7 - X2: a granted researcher actuates a timed STREGA action with the actor propagated
  ---
  duration_ms: 45.124958
  type: 'test'
  ...
# Subtest: X2: a revoked claimer is HTTP-denied with no actuator message
ok 8 - X2: a revoked claimer is HTTP-denied with no actuator message
  ---
  duration_ms: 33.552219
  type: 'test'
  ...
# Subtest: X2: a viewer-role owner is HTTP-denied with no actuator message
ok 9 - X2: a viewer-role owner is HTTP-denied with no actuator message
  ---
  duration_ms: 32.638418
  type: 'test'
  ...
# Subtest: X2: flag-off preserves the legacy bearer-only behavior
ok 10 - X2: flag-off preserves the legacy bearer-only behavior
  ---
  duration_ms: 37.67857
  type: 'test'
  ...
# Subtest: X2: the actor comes only from the verified bearer identity, never from the request body
ok 11 - X2: the actor comes only from the verified bearer identity, never from the request body
  ---
  duration_ms: 39.250833
  type: 'test'
  ...
# Subtest: E3: a scoped physical command without an actor is rejected fail-closed and never actuates
ok 12 - E3: a scoped physical command without an actor is rejected fail-closed and never actuates
  ---
  duration_ms: 33.800085
  type: 'test'
  ...
# Subtest: E3: a scoped actor with view-only zone access cannot actuate a valve
ok 13 - E3: a scoped actor with view-only zone access cannot actuate a valve
  ---
  duration_ms: 33.819081
  type: 'test'
  ...
# Subtest: E3: flag-off preserves the legacy no-actor-required behavior
ok 14 - E3: flag-off preserves the legacy no-actor-required behavior
  ---
  duration_ms: 34.767804
  type: 'test'
  ...
# Subtest: R3: an actor-less, duration-less command is rejected by the actor gate, not passed through
ok 15 - R3: an actor-less, duration-less command is rejected by the actor gate, not passed through
  ---
  duration_ms: 36.699468
  type: 'test'
  ...
# Subtest: R3: an authorized actor with an invalid/missing duration is rejected under scope, not passed through
ok 16 - R3: an authorized actor with an invalid/missing duration is rejected under scope, not passed through
  ---
  duration_ms: 37.573739
  type: 'test'
  ...
# Subtest: R3: flag-off keeps the legacy invalid-duration pass-through behavior
ok 17 - R3: flag-off keeps the legacy invalid-duration pass-through behavior
  ---
  duration_ms: 36.829652
  type: 'test'
  ...
# Subtest: R1: a cloud command with actor_user_uuid only in the payload crosses Route Command intact and enforces scope
ok 18 - R1: a cloud command with actor_user_uuid only in the payload crosses Route Command intact and enforces scope
  ---
  duration_ms: 63.296911
  type: 'test'
  ...
# Subtest: R2: a genuine scheduler dispatch (real message-level marker) actuates under scope with no actor
ok 19 - R2: a genuine scheduler dispatch (real message-level marker) actuates under scope with no actor
  ---
  duration_ms: 37.987687
  type: 'test'
  ...
# Subtest: R2: a payload/body-embedded system-actuation claim is never honored, only the true message-level flag
ok 20 - R2: a payload/body-embedded system-actuation claim is never honored, only the true message-level flag
  ---
  duration_ms: 34.056821
  type: 'test'
  ...
# Subtest: W2: schedule mutation allows grants, hides foreign zones, and rejects viewers
ok 21 - W2: schedule mutation allows grants, hides foreign zones, and rejects viewers
  ---
  duration_ms: 45.790474
  type: 'test'
  ...
# Subtest: W2: disable-all updates only researcher scope and rejects viewers
ok 22 - W2: disable-all updates only researcher scope and rejects viewers
  ---
  duration_ms: 42.641269
  type: 'test'
  ...
# Subtest: E8: disable-all scopes an admin to owned-plus-granted zones like every other write surface
ok 23 - E8: disable-all scopes an admin to owned-plus-granted zones like every other write surface
  ---
  duration_ms: 35.149765
  type: 'test'
  ...
# Subtest: W2: scheduler query counts enabled scope holders and disables an empty zone
ok 24 - W2: scheduler query counts enabled scope holders and disables an empty zone
  ---
  duration_ms: 43.089928
  type: 'test'
  ...
# Subtest: W3: scoped zone creation atomically grants the creator
ok 25 - W3: scoped zone creation atomically grants the creator
  ---
  duration_ms: 41.592116
  type: 'test'
  ...
# Subtest: W3: sole-scope-holder delete tombstones grants and preserves detached plots
ok 26 - W3: sole-scope-holder delete tombstones grants and preserves detached plots
  ---
  duration_ms: 34.961542
  type: 'test'
  ...
# Subtest: W3: researcher cannot delete a multi-holder zone; admin can
ok 27 - W3: researcher cannot delete a multi-holder zone; admin can
  ---
  duration_ms: 43.1289
  type: 'test'
  ...
# Subtest: W4: scoped claims require an accessible target zone except for admins
ok 28 - W4: scoped claims require an accessible target zone except for admins
  ---
  duration_ms: 57.191333
  type: 'test'
  ...
# Subtest: W4: a foreign existing device is hidden before claim or reassignment
ok 29 - W4: a foreign existing device is hidden before claim or reassignment
  ---
  duration_ms: 44.775263
  type: 'test'
  ...
# Subtest: W4: assignment and removal fresh-check both the device and zone
ok 30 - W4: assignment and removal fresh-check both the device and zone
  ---
  duration_ms: 45.529478
  type: 'test'
  ...
# Subtest: W4: device delete and weather-zone replacement enforce fresh scope
ok 31 - W4: device delete and weather-zone replacement enforce fresh scope
  ---
  duration_ms: 46.784173
  type: 'test'
  ...
# Subtest: W5: every device-config route fresh-checks write scope
ok 32 - W5: every device-config route fresh-checks write scope
  ---
  duration_ms: 450.478951
  type: 'test'
  ...
# Subtest: IB1: denied SDI-12 config cannot write, authorized config does write
ok 33 - IB1: denied SDI-12 config cannot write, authorized config does write
  ---
  duration_ms: 45.751851
  type: 'test'
  ...
# Subtest: W5: flag-off device-config routing preserves each legacy branch
ok 34 - W5: flag-off device-config routing preserves each legacy branch
  ---
  duration_ms: 149.03188
  type: 'test'
  ...
# Subtest: IS1: SDI-12 profile change without depths clears stale channel keys
ok 35 - IS1: SDI-12 profile change without depths clears stale channel keys
  ---
  duration_ms: 37.729904
  type: 'test'
  ...
# Subtest: W7: every zone-config route fresh-checks scope and records the actor
ok 36 - W7: every zone-config route fresh-checks scope and records the actor
  ---
  duration_ms: 111.316154
  type: 'test'
  ...
# Subtest: W7: a grantee reaches the legacy zone write as the resource owner
ok 37 - W7: a grantee reaches the legacy zone write as the resource owner
  ---
  duration_ms: 42.531409
  type: 'test'
  ...
# Subtest: W8: admin account CRUD omits hashes and protects the last enabled admin
ok 38 - W8: admin account CRUD omits hashes and protects the last enabled admin
  ---
  duration_ms: 209.161847
  type: 'test'
  ...
# Subtest: W8: serialized admin disable attempts leave at least one enabled admin
ok 39 - W8: serialized admin disable attempts leave at least one enabled admin
  ---
  duration_ms: 113.066581
  type: 'test'
  ...
# Subtest: W8: zone and plot grants invalidate into the next resolved scope
ok 40 - W8: zone and plot grants invalidate into the next resolved scope
  ---
  duration_ms: 55.195415
  type: 'test'
  ...
# Subtest: E7: a missing zone_uuid on a grant POST is a 400, not a stringified-undefined 404
ok 41 - E7: a missing zone_uuid on a grant POST is a 400, not a stringified-undefined 404
  ---
  duration_ms: 48.726035
  type: 'test'
  ...
# Subtest: W8: every account and grant endpoint rejects non-admins
ok 42 - W8: every account and grant endpoint rejects non-admins
  ---
  duration_ms: 79.962392
  type: 'test'
  ...
# Subtest: W9: every system write allows only a fresh enabled admin
ok 43 - W9: every system write allows only a fresh enabled admin
  ---
  duration_ms: 170.390543
  type: 'test'
  ...
# Subtest: W9: flag-off system writes preserve every legacy branch
ok 44 - W9: flag-off system writes preserve every legacy branch
  ---
  duration_ms: 64.298503
  type: 'test'
  ...
# Subtest: W10: local irrigation config writes version only their own aggregate
ok 45 - W10: local irrigation config writes version only their own aggregate
  ---
  duration_ms: 10.741979
  type: 'test'
  ...
# Subtest: E6: an unrecognized role fails closed on every mutation gate while reads stay scope-governed
ok 46 - E6: an unrecognized role fails closed on every mutation gate while reads stay scope-governed
  ---
  duration_ms: 257.823139
  type: 'test'
  ...
1..46
# tests 46
# suites 0
# pass 46
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 3115.398288

$ node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/index.test.js
TAP version 13
# Subtest: parseSdi12Values: strict grammar
ok 1 - parseSdi12Values: strict grammar
  ---
  duration_ms: 1.514225
  type: 'test'
  ...
# Subtest: transforms: pf_to_kpa and hpa_to_kpa with swt clamp
ok 2 - transforms: pf_to_kpa and hpa_to_kpa with swt clamp
  ---
  duration_ms: 0.405497
  type: 'test'
  ...
# Subtest: exact cardinality rejects the frame atomically
ok 3 - exact cardinality rejects the frame atomically
  ---
  duration_ms: 0.222094
  type: 'test'
  ...
# Subtest: GENERIC_VWC (variable count, documented escape hatch) maps in order and bounds-checks
ok 4 - GENERIC_VWC (variable count, documented escape hatch) maps in order and bounds-checks
  ---
  duration_ms: 0.952423
  type: 'test'
  ...
# Subtest: no profile -> battery only + quarantine marker
ok 5 - no profile -> battery only + quarantine marker
  ---
  duration_ms: 0.23711
  type: 'test'
  ...
# Subtest: NULL is matched exactly, never by substring
ok 6 - NULL is matched exactly, never by substring
  ---
  duration_ms: 0.150438
  type: 'test'
  ...
# Subtest: empty FPort 2 data is no response without quarantine
ok 7 - empty FPort 2 data is no response without quarantine
  ---
  duration_ms: 0.196183
  type: 'test'
  ...
# Subtest: unparseable non-NULL -> quarantine marker
ok 8 - unparseable non-NULL -> quarantine marker
  ---
  duration_ms: 0.130044
  type: 'test'
  ...
# Subtest: parseIdentity extracts vendor/model/firmware for storage and display
ok 9 - parseIdentity extracts vendor/model/firmware for storage and display
  ---
  duration_ms: 0.326437
  type: 'test'
  ...
# Subtest: v1 ships no auto-matchers; matchProfile works only with bench-enabled patterns
ok 10 - v1 ships no auto-matchers; matchProfile works only with bench-enabled patterns
  ---
  duration_ms: 0.450126
  type: 'test'
  ...
# Subtest: every fixed-cardinality profile fits the 51-byte DR0 uplink budget
ok 11 - every fixed-cardinality profile fits the 51-byte DR0 uplink budget
  ---
  duration_ms: 0.200653
  type: 'test'
  ...
# Subtest: listProfiles is GUI-serializable and slot-aware
ok 12 - listProfiles is GUI-serializable and slot-aware
  ---
  duration_ms: 0.284323
  type: 'test'
  ...
1..12
# tests 12
# suites 0
# pass 12
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 61.528465

$ node --test conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-sdi12-normalize/index.test.js
TAP version 13
# Subtest: parseSdi12Values: strict grammar
ok 1 - parseSdi12Values: strict grammar
  ---
  duration_ms: 1.519323
  type: 'test'
  ...
# Subtest: transforms: pf_to_kpa and hpa_to_kpa with swt clamp
ok 2 - transforms: pf_to_kpa and hpa_to_kpa with swt clamp
  ---
  duration_ms: 0.397885
  type: 'test'
  ...
# Subtest: exact cardinality rejects the frame atomically
ok 3 - exact cardinality rejects the frame atomically
  ---
  duration_ms: 0.219371
  type: 'test'
  ...
# Subtest: GENERIC_VWC (variable count, documented escape hatch) maps in order and bounds-checks
ok 4 - GENERIC_VWC (variable count, documented escape hatch) maps in order and bounds-checks
  ---
  duration_ms: 0.909052
  type: 'test'
  ...
# Subtest: no profile -> battery only + quarantine marker
ok 5 - no profile -> battery only + quarantine marker
  ---
  duration_ms: 0.247936
  type: 'test'
  ...
# Subtest: NULL is matched exactly, never by substring
ok 6 - NULL is matched exactly, never by substring
  ---
  duration_ms: 0.148761
  type: 'test'
  ...
# Subtest: empty FPort 2 data is no response without quarantine
ok 7 - empty FPort 2 data is no response without quarantine
  ---
  duration_ms: 0.18459
  type: 'test'
  ...
# Subtest: unparseable non-NULL -> quarantine marker
ok 8 - unparseable non-NULL -> quarantine marker
  ---
  duration_ms: 0.129485
  type: 'test'
  ...
# Subtest: parseIdentity extracts vendor/model/firmware for storage and display
ok 9 - parseIdentity extracts vendor/model/firmware for storage and display
  ---
  duration_ms: 0.323434
  type: 'test'
  ...
# Subtest: v1 ships no auto-matchers; matchProfile works only with bench-enabled patterns
ok 10 - v1 ships no auto-matchers; matchProfile works only with bench-enabled patterns
  ---
  duration_ms: 0.431688
  type: 'test'
  ...
# Subtest: every fixed-cardinality profile fits the 51-byte DR0 uplink budget
ok 11 - every fixed-cardinality profile fits the 51-byte DR0 uplink budget
  ---
  duration_ms: 0.197022
  type: 'test'
  ...
# Subtest: listProfiles is GUI-serializable and slot-aware
ok 12 - listProfiles is GUI-serializable and slot-aware
  ---
  duration_ms: 0.282508
  type: 'test'
  ...
1..12
# tests 12
# suites 0
# pass 12
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 64.13256

$ node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-device-writer/index.test.js
TAP version 13
# (node:4122147) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: osi-device-writer
    # Subtest: exposes no prepare member on the async facade passed to the writer
    ok 1 - exposes no prepare member on the async facade passed to the writer
      ---
      duration_ms: 29.036503
      type: 'test'
      ...
    # Subtest: inserts known channels through the shipped async database contract
    ok 2 - inserts known channels through the shipped async database contract
      ---
      duration_ms: 30.613515
      type: 'test'
      ...
    # Subtest: dead-letters unknown channels
    ok 3 - dead-letters unknown channels
      ---
      duration_ms: 27.246966
      type: 'test'
      ...
    # Subtest: dead-letters server-only channels (edgeField null)
    ok 4 - dead-letters server-only channels (edgeField null)
      ---
      duration_ms: 27.542533
      type: 'test'
      ...
    # Subtest: dead-letters unmapped channels
    ok 5 - dead-letters unmapped channels
      ---
      duration_ms: 26.782312
      type: 'test'
      ...
    # Subtest: clamps implausible timestamps
    ok 6 - clamps implausible timestamps
      ---
      duration_ms: 26.455875
      type: 'test'
      ...
    # Subtest: shadow mode returns row without INSERT
    ok 7 - shadow mode returns row without INSERT
      ---
      duration_ms: 25.849096
      type: 'test'
      ...
    # Subtest: handles SQL-hostile values via parameterization
    ok 8 - handles SQL-hostile values via parameterization
      ---
      duration_ms: 27.139619
      type: 'test'
      ...
    # Subtest: rejects empty deveui
    ok 9 - rejects empty deveui
      ---
      duration_ms: 26.033406
      type: 'test'
      ...
    # Subtest: hard schema-mismatch behavior (fail-closed)
        # Subtest: rejects with DEVICE_DATA_SCHEMA_MISMATCH and inserts no partial row
        ok 1 - rejects with DEVICE_DATA_SCHEMA_MISMATCH and inserts no partial row
          ---
          duration_ms: 27.264146
          type: 'test'
          ...
        # Subtest: never reports inserted: true for a schema-mismatched call
        ok 2 - never reports inserted: true for a schema-mismatched call
          ---
          duration_ms: 28.439083
          type: 'test'
          ...
        # Subtest: invalidates the module-global column cache and permits a retry after in-place repair
        ok 3 - invalidates the module-global column cache and permits a retry after in-place repair
          ---
          duration_ms: 30.84909
          type: 'test'
          ...
        1..3
    ok 10 - hard schema-mismatch behavior (fail-closed)
      ---
      duration_ms: 86.849841
      type: 'suite'
      ...
    1..10
ok 1 - osi-device-writer
  ---
  duration_ms: 335.096999
  type: 'suite'
  ...
# Subtest: clampRecordedAt
    # Subtest: passes through valid timestamps
    ok 1 - passes through valid timestamps
      ---
      duration_ms: 0.17146
      type: 'test'
      ...
    # Subtest: clamps timestamps before floor
    ok 2 - clamps timestamps before floor
      ---
      duration_ms: 0.095333
      type: 'test'
      ...
    # Subtest: clamps timestamps too far in the future
    ok 3 - clamps timestamps too far in the future
      ---
      duration_ms: 0.099943
      type: 'test'
      ...
    # Subtest: returns nowIso for null/undefined/empty
    ok 4 - returns nowIso for null/undefined/empty
      ---
      duration_ms: 0.103086
      type: 'test'
      ...
    1..4
ok 2 - clampRecordedAt
  ---
  duration_ms: 0.613973
  type: 'suite'
  ...
1..2
# tests 16
# suites 3
# pass 16
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 402.954673

$ node --test conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-device-writer/index.test.js
TAP version 13
# (node:4122164) ExperimentalWarning: SQLite is an experimental feature and might change at any time
# (Use `node --trace-warnings ...` to show where the warning was created)
# Subtest: osi-device-writer
    # Subtest: exposes no prepare member on the async facade passed to the writer
    ok 1 - exposes no prepare member on the async facade passed to the writer
      ---
      duration_ms: 29.437391
      type: 'test'
      ...
    # Subtest: inserts known channels through the shipped async database contract
    ok 2 - inserts known channels through the shipped async database contract
      ---
      duration_ms: 27.285098
      type: 'test'
      ...
    # Subtest: dead-letters unknown channels
    ok 3 - dead-letters unknown channels
      ---
      duration_ms: 26.101712
      type: 'test'
      ...
    # Subtest: dead-letters server-only channels (edgeField null)
    ok 4 - dead-letters server-only channels (edgeField null)
      ---
      duration_ms: 25.849445
      type: 'test'
      ...
    # Subtest: dead-letters unmapped channels
    ok 5 - dead-letters unmapped channels
      ---
      duration_ms: 26.977169
      type: 'test'
      ...
    # Subtest: clamps implausible timestamps
    ok 6 - clamps implausible timestamps
      ---
      duration_ms: 26.306415
      type: 'test'
      ...
    # Subtest: shadow mode returns row without INSERT
    ok 7 - shadow mode returns row without INSERT
      ---
      duration_ms: 25.681967
      type: 'test'
      ...
    # Subtest: handles SQL-hostile values via parameterization
    ok 8 - handles SQL-hostile values via parameterization
      ---
      duration_ms: 26.271075
      type: 'test'
      ...
    # Subtest: rejects empty deveui
    ok 9 - rejects empty deveui
      ---
      duration_ms: 26.569786
      type: 'test'
      ...
    # Subtest: hard schema-mismatch behavior (fail-closed)
        # Subtest: rejects with DEVICE_DATA_SCHEMA_MISMATCH and inserts no partial row
        ok 1 - rejects with DEVICE_DATA_SCHEMA_MISMATCH and inserts no partial row
          ---
          duration_ms: 26.758846
          type: 'test'
          ...
        # Subtest: never reports inserted: true for a schema-mismatched call
        ok 2 - never reports inserted: true for a schema-mismatched call
          ---
          duration_ms: 26.040181
          type: 'test'
          ...
        # Subtest: invalidates the module-global column cache and permits a retry after in-place repair
        ok 3 - invalidates the module-global column cache and permits a retry after in-place repair
          ---
          duration_ms: 29.657042
          type: 'test'
          ...
        1..3
    ok 10 - hard schema-mismatch behavior (fail-closed)
      ---
      duration_ms: 82.717764
      type: 'suite'
      ...
    1..10
ok 1 - osi-device-writer
  ---
  duration_ms: 324.70646
  type: 'suite'
  ...
# Subtest: clampRecordedAt
    # Subtest: passes through valid timestamps
    ok 1 - passes through valid timestamps
      ---
      duration_ms: 0.149251
      type: 'test'
      ...
    # Subtest: clamps timestamps before floor
    ok 2 - clamps timestamps before floor
      ---
      duration_ms: 0.095821
      type: 'test'
      ...
    # Subtest: clamps timestamps too far in the future
    ok 3 - clamps timestamps too far in the future
      ---
      duration_ms: 0.09205
      type: 'test'
      ...
    # Subtest: returns nowIso for null/undefined/empty
    ok 4 - returns nowIso for null/undefined/empty
      ---
      duration_ms: 0.10113
      type: 'test'
      ...
    1..4
ok 2 - clampRecordedAt
  ---
  duration_ms: 0.592392
  type: 'suite'
  ...
1..2
# tests 16
# suites 3
# pass 16
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 393.331828

$ node .claude/skills/anti-slop-writing/slop-check.js docs/superpowers/plans/2026-08-13-dragino-sdi12-execution-report.md docs/superpowers/plans/2026-08-13-dragino-sdi12-implementation-review.md
tier2 docs/superpowers/plans/2026-08-13-dragino-sdi12-execution-report.md:28: "robustness"
tier2 docs/superpowers/plans/2026-08-13-dragino-sdi12-implementation-review.md: em-dash density 26.8/1000 words (19 in 708; budget 8)
slop-check: PASS (no tier-1 findings)

$ bash -c test "$(rg -l "verify-device-integration" .github/workflows | wc -l)" -eq 1 && rg -n "verify-device-integration" .github/workflows
.github/workflows/codecs.yml:25:      - run: node scripts/verify-device-integration.js

$ bash -c node -e "const fs=require(\"fs\"); for (const p of [\"conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json\",\"conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json\"]){const b=fs.readFileSync(p,\"utf8\"); const f=JSON.parse(b); if(JSON.stringify(f,null,2)+\"\\n\"!==b) throw new Error(p+\": non-canonical JSON\");} console.log(\"flows JSON roundtrip: byte-identical\");"
flows JSON roundtrip: byte-identical

CORE BATTERY COMPLETE

$ (cd web/react-gui && npx vitest run)
npm notice run open-smart-irrigation@1.0.0 npx
npm notice run 'vitest' run

 RUN  v4.1.6 /home/phil/Repos/osi-os-agrolink/web/react-gui

[baseline-browser-mapping] The data in this module is over two months old.  To ensure accurate Baseline data, please update: `npm i baseline-browser-mapping@latest -D`
Browserslist: browsers data (caniuse-lite) is 9 months old. Please run:
  npx update-browserslist-db@latest
  Why you should do it regularly: https://github.com/browserslist/update-db#readme

 Test Files  172 passed (172)
      Tests  1707 passed (1707)
   Start at  22:09:00
   Duration  39.64s (transform 33.69s, setup 0ms, import 96.67s, tests 138.06s, environment 285.52s)


FRONTEND VITEST COMPLETE

$ (cd web/react-gui && npx tsc --noEmit -p .)
npm notice run open-smart-irrigation@1.0.0 npx
npm notice run 'tsc' --noEmit -p .

FRONTEND TYPESCRIPT COMPLETE

$ (cd web/react-gui && npm run build)
npm notice run open-smart-irrigation@1.0.0 build
npm notice run vite build
vite v5.4.21 building for production...
transforming...
[baseline-browser-mapping] The data in this module is over two months old.  To ensure accurate Baseline data, please update: `npm i baseline-browser-mapping@latest -D`
Browserslist: browsers data (caniuse-lite) is 9 months old. Please run:
  npx update-browserslist-db@latest
  Why you should do it regularly: https://github.com/browserslist/update-db#readme
✓ 1723 modules transformed.
rendering chunks...
computing gzip size...
build/index.html                                     0.46 kB │ gzip:   0.30 kB
build/assets/balken-horizontal-it-Ou2XHCRY.png      19.33 kB
build/assets/balken-horizontal-de-CqhCszv6.png      19.91 kB
build/assets/balken-horizontal-en-D-ArRzMS.png      20.30 kB
build/assets/balken-horizontal-fr-7SkApz9y.png      23.99 kB
build/assets/noto-sans-latin-var-BYSzYMf3.woff2     35.82 kB
build/assets/logo-it-hoch-vq__SgqK.png              60.63 kB
build/assets/logo-fr-hoch-DAKzGB1G.png              60.94 kB
build/assets/logo-de-hoch-BsxN59gE.png              62.34 kB
build/assets/logo-en-hoch-CBGkz__h.png              69.81 kB
build/assets/index-Dh_YEGLS.css                     73.37 kB │ gzip:  15.14 kB
build/assets/AnalysisRoute-B412vJHR.js               0.69 kB │ gzip:   0.43 kB
build/assets/WindRoseChart-DVUHC44h.js               1.60 kB │ gzip:   0.84 kB
build/assets/EChart-CpI6gt2s.js                      1.68 kB │ gzip:   0.86 kB
build/assets/browser-ponyfill-BeLxO4fO.js           10.26 kB │ gzip:   3.52 kB
build/assets/CrossZoneAnalysisPage-Ck9KxNuF.js      38.31 kB │ gzip:  11.88 kB
build/assets/analysis-echarts-DOTAK0kg.js        1,036.20 kB │ gzip: 346.36 kB
build/assets/index-B9BBvRMF.js                   1,553.77 kB │ gzip: 414.96 kB

(!) Some chunks are larger than 500 kB after minification. Consider:
- Using dynamic import() to code-split the application
- Use build.rollupOptions.output.manualChunks to improve chunking: https://rollupjs.org/configuration-options/#output-manualchunks
- Adjust chunk size limit for this warning via build.chunkSizeWarningLimit.
✓ built in 7.85s

FRONTEND BUILD COMPLETE
```

## Honest remainder

- Bench phase remains: capture each real probe’s raw SDI-12 response, finalize AT recipes, identity matchers, units, and golden vectors, and verify the provisional uplink-width assumption.
- osi-server lockstep remains a merge gate: the paired server contract/type/channel/history changes must land and pass together.
- No push, merge, PR, deployment, SSH, live Pi, osicloud.ch, or remote database work was performed.
