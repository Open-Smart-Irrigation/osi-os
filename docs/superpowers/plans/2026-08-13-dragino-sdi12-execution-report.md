# Dragino SDI-12 execution report

Status: HALTED at Task 18. Tasks 0–17 are committed on branch AgroLink. Task 18 stopped at the first red gate and has no commit. No push, merge, PR, SSH, live gateway access, osicloud.ch access, or remote database access was performed.

Execution date: 2026-08-13
Checkout: /home/phil/Repos/osi-os-agrolink
Branch: AgroLink
Last implementation commit: 60dba9bd
Task 18 blocker: node scripts/verify-sync-contract.js reported:
`FAIL: commands.schema.json enum drift: missing=SET_SDI12_IDENTIFY extra=(none) duplicates=(none)`

This is a plan/repo contract contradiction. The approved Task 10 flow registry contains SET_SDI12_IDENTIFY, but docs/contracts/sync-schema/commands.schema.json does not. The failing command was not caused by the last Task 17 documentation commit, so execution stopped under the hard-stop rule. A schema or paired-contract change was not improvised.

Read-only confirmation: the flow registry contains SET_SDI12_IDENTIFY; the schema enum does not. The extracted registry count was 46 command entries and the schema enum count was 49. The relevant verifier compares these sets at scripts/verify-sync-contract.js lines 352–372.

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
- Deviation: the existing boot rebuild used a positional devices INSERT SELECT. The approved four boot-node additions were appended to that existing shape minimally. The rehearsal runner also needed the sanctioned sdi12-sentinels case to exercise the new columns.

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
- Gates: flow parse/wiring, command-safety, size, parity, MQTT, silent-catch, bare-require, sync, and scoped-access suites.
- TDD evidence: the initial structural run failed with the same unwired gate output 2 assertion and missing handler.
- Final evidence: command-safety and flow gate blocks were green before commit.
- Deviation: none in implementation. The later Task 18 sync-contract failure identifies a separate contract drift: this task’s approved flow registry added SET_SDI12_IDENTIFY, while commands.schema.json was not updated by the plan.

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

## Task 18 halt and remaining work

The Task 18 wrapper ran the commands below sequentially and stopped at verify-sync-contract.js after channel-manifest parity. The explicit verify-live-gateway-identity.js, verify-scoped-access.js, scoped-access suites, frontend Vitest, typecheck, and production build were included in the planned/attempted sequence but were not reached after the contract failure.

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
- Task 18 remains unchecked. This report records a halted execution, not a release-ready result.

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

## Remaining after the captured output

- Resolve the sanctioned `SET_SDI12_IDENTIFY` edge/cloud contract decision and rerun Task 18 from the first command.
- Run the not-reached scoped-access suites, frontend Vitest, TypeScript check, and production build; keep the build last and alone.
- Complete bench capture and the osi-server lockstep gate.
