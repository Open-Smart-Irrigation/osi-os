# SDI-12 recipe deployment execution report

**Date:** 2026-08-29
**Verifier:** independent Task 7 pass
**Scope:** commits `5c36eda1` through `57a3c196`

## Result

The local verification gate passed. This is not a deployment approval: bench and
live-gateway evidence remain deferred, and no Pi or production host was accessed.

## Reviewed implementation

The reviewed commits are `5c36eda1` (local deployment schema), `0ab000c5` and
`c4f09675` (recipe compiler and wire-frame correction), `9f458139` (queue
access), `30c42381` and `f251fe44` (commissioning and rollback), `db76bea2` and
`0d917961` (flow transport), `a96bd93d` and `57a3c196` (GUI API and apply gate).

I inspected the full feature delta against the approved design. The compiler
accepts only validated layout addresses; Identify uses discovery `?!` or the
validated saved address. The commissioning helper sets unconfirmed FPort 2
itself, preflights with `listDeviceQueue`, and has no recipe-path
`flushDeviceQueue` call. Partial enqueue retains accepted IDs and reports a
bounded degraded state. Rollback checks its compatible recipe/layout pair and
delays the canonical device mutation until every frame is accepted. The poller
handles stale `queueing` claims and the twelve-hour delivery deadline. SQL values
are bound, API projections omit recipes and queue IDs, null telemetry remains
missing, and the GUI retains prior readings. The migration is additive and
local-only; the frozen boot DDL and edge/cloud sync contracts were not changed.
Maintained bcm2712 and bcm2709 runtime payloads are byte-identical.

No new defect was found by this review. The test suite provides direct coverage
for the hazard cases above; a live downlink/probe test still has to prove the
bench-derived recipe on the target hardware.

## Verification

All commands ran from `/home/phil/Repos/osi-os-agrolink` unless stated otherwise.

| Command | Result |
|---|---|
| `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-recipe/index.test.js` | PASS, 9 tests; includes all 2,046 type masks. |
| `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-commissioning/index.test.js` | PASS, 31 tests. |
| `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-chirpstack-helper/index.test.js` | PASS. |
| `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/index.test.js` | PASS, 27 tests. |
| `node scripts/test-sdi12-recipe-schema.js` | PASS: `test-sdi12-recipe-schema: OK`. |
| `node scripts/test-sdi12-recipe-flow.js` | PASS, 26 tests. |
| `node scripts/test-sdi12-registration.js` | PASS, 17 tests. |
| `node scripts/verify-device-integration.js` | PASS, 34 tests. |
| `node scripts/verify-migrations.js` | PASS: 49 migrations; checksum manifest and base immutability OK. |
| `node scripts/verify-seed-replay.js` | PASS: `verify-seed-replay: OK` (about 105 seconds). |
| `node scripts/verify-db-schema-consistency.js` | PASS: all seven bundled databases OK. |
| `node scripts/verify-runtime-schema-parity.js` | PASS: two flows, devices CHECK and trigger parity. |
| `node scripts/verify-helper-registration.js` | PASS: both maintained profiles and helper registry coverage. |
| `node scripts/verify-profile-parity.js` | PASS: `All parity checks passed.` |
| `node scripts/verify-sync-flow.js` | PASS; chained checks completed with profile parity. |
| `node scripts/verify-no-new-silent-catch.js` | PASS: 88 empty catches in each maintained profile, equal to the baseline. |
| `node scripts/verify-flows-size-ratchet.js` | PASS: exact reviewed ceilings held at 1,321,101 bytes. |
| `node scripts/verify-communication-contract.js` | PASS. |
| `scripts/check-mqtt-topics.sh` | PASS: no hardcoded MQTT application UUIDs in the three flow copies. |
| `cd web/react-gui && npm run test:unit` | PASS: 128 tsx tests and 1,762 Vitest tests. |
| `cd web/react-gui && npm run build` | PASS: Vite built 1,723 modules in 7.60 seconds. |

The Node tests print Node's experimental SQLite warning. GUI commands print
`baseline-browser-mapping` and `caniuse-lite` age notices. Vite also warns that
existing production chunks exceed 500 kB. These are dependency/bundling warnings,
not test or build failures.

## Deferred evidence and recovery boundary

No deployment occurred. Before a live apply, the operator must confirm the
physical probe and saved layout, take the prescribed Pi backup, apply migration
0049 with Node-RED stopped, then observe queue drain and two complete matching
post-drain uplinks. If queue delivery times out or a reading quarantines, retain
the existing readings and queue evidence; do not guess an address, shorten the
interval, enable continuous power, or repeatedly apply.

## Worktree treatment

`docs/devices/dragino-sdi12.md` was dirty before Task 7. Synthetic baseline
`f1a832e973b9dac86d411494af9a97a917d164c9` captured its prior bytes above real
HEAD `57a3c196`. This task added the recipe-deployment guide material on top of
that file, but leaves the entire overlapping guide change unstaged. Existing
modified and untracked files, including `node_modules/`, were preserved. The
only intended Task 7 commit is this clean execution report.
