# SDI-12 recipe deployment execution report

**Date:** 2026-08-29
**Verifier:** independent Task 7 pass plus live edge deployment checks
**Scope:** commits `5c36eda1` through `57a3c196`, plus final-review synthetic
snapshot `8b4d7298..c5f35e22`

## Result

The local verification gate passed, and the software payload was deployed to the
`agrolink-test-01` edge gateway at `100.121.141.64`. Migration 0049 and the new
runtime/UI payload are live. No SDI-12 layout was saved, no recipe was applied,
and no downlink was enqueued; physical probe replacement and commissioning remain
deferred.

## Reviewed implementation

The reviewed commits are `5c36eda1` (local deployment schema), `0ab000c5` and
`c4f09675` (recipe compiler and wire-frame correction), `9f458139` (queue
access), `30c42381` and `f251fe44` (commissioning and rollback), `db76bea2` and
`0d917961` (flow transport), `a96bd93d` and `57a3c196` (GUI API and apply gate).

I inspected the full feature delta against the approved design. The compiler
accepts only validated layout addresses; Identify uses discovery `?!` or the
validated saved address. The commissioning helper sets confirmed FPort 2
itself, preflights with `listDeviceQueue`, and has no recipe-path
`flushDeviceQueue` call. Partial enqueue retains accepted IDs and reports a
bounded degraded state. Rollback checks its compatible recipe/layout pair and
delays the canonical device mutation until every frame is accepted. The poller
handles stale `queueing` claims and the twelve-hour delivery deadline. SQL values
are bound, API projections omit recipes and queue IDs, null telemetry remains
missing, and the GUI retains prior readings. The migration is additive and
local-only; the frozen boot DDL and edge/cloud sync contracts were not changed.
Maintained bcm2712 and bcm2709 runtime payloads are byte-identical.

The final independent review found that an already-open settings modal did not
prefill a newly discovered SDI-12 address. Task 6 round 2 fixed that component
and its test in the unstaged worktree, using the required RED run followed by 43
focused GREEN tests. The scoped synthetic review of that unstaged component/test
change is `8b4d7298..c5f35e22`; it is identified separately because it is not a
committed feature-range change. The follow-up typecheck, full GUI unit suite,
build, and diff check passed. There are no open review findings. A live
downlink/probe test still has to prove the bench-derived recipe on the target
hardware.

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
| `node scripts/verify-device-integration.js` | PASS, 35 tests. |
| `node scripts/verify-migrations.js` | PASS: 49 migrations; checksum manifest and base immutability OK. |
| `node scripts/verify-seed-replay.js` | PASS: `verify-seed-replay: OK` (about 105 seconds). |
| `node scripts/verify-db-schema-consistency.js` | PASS: all seven bundled databases OK. |
| `node scripts/verify-runtime-schema-parity.js` | PASS: two flows, devices CHECK and trigger parity. |
| `node scripts/verify-helper-registration.js` | PASS: both maintained profiles and helper registry coverage. |
| `node scripts/verify-profile-parity.js` | PASS: `All parity checks passed.` |
| `node scripts/verify-sync-flow.js` | PASS; chained checks completed with profile parity. |
| `node scripts/verify-no-new-silent-catch.js` | PASS: 88 empty catches in each maintained profile, equal to the baseline. |
| `node scripts/verify-flows-size-ratchet.js` | PASS: exact reviewed function-character ceilings held at 1,321,101 characters. |
| `node scripts/verify-communication-contract.js` | PASS. |
| `scripts/check-mqtt-topics.sh` | PASS: no hardcoded MQTT application UUIDs in the three flow copies. |
| `cd web/react-gui && npm run test:unit` | PASS: 128 tsx tests and 1,766 Vitest tests. |
| `cd web/react-gui && npm run build` | PASS: Vite built 1,723 modules in 7.60 seconds. |
| Task 6 round 2: `npm run test:unit:vitest -- src/services/__tests__/api.sdi12.test.ts src/components/farming/__tests__/Sdi12SettingsModal.test.tsx src/components/farming/__tests__/Sdi12SoilCard.test.tsx` | PASS: 43 focused tests after the RED run. |
| Task 6 round 2: `npm run typecheck`, `npm run test:unit`, `npm run build`, and `git diff --check` | PASS. |

The Node tests print Node's experimental SQLite warning. GUI commands print
`baseline-browser-mapping` and `caniuse-lite` age notices. Vite also warns that
existing production chunks exceed 500 kB. These are dependency/bundling warnings,
not test or build failures.

## Live software deployment

The operator authorized software deployment before replacing the field probe.
The target resolved gateway EUI `0016C001F116EBF2` from the running concentrator;
the target Dragino device is `A8404135955C327D`.

Before deployment, the gateway stored 2,537 `device_data` rows and migration head
48. Both edge and ChirpStack databases passed `PRAGMA integrity_check`; the edge
database had zero foreign-key violations. A timestamped backup was written to
`/data/db/backups/osi-os-pre-sdi12-recipe-20260829T141452Z`. Its edge database
contains the same 2,537 readings, both copied databases pass integrity checks,
and the backup includes the active flows, Node-RED settings, and 82 GUI files.

Deployment started at `2026-08-29T14:17:09Z` through the guarded `deploy.sh`
download-and-run path. The script preserved `/data/db/farming.db`, applied
migration 0049, flipped `/srv/node-red/flows.json` to
`payloads/20260829T141710Z/flows.json`, passed its local Node-RED and `/gui` health
probe after three seconds, and committed the payload. The deployed GUI index and
both new SDI-12 helper files match the local artifact hashes. All 693 flow nodes
match the deployed source; Node-RED changed only the cloud MQTT broker's `broker`
and `clientid` fields when it resolved runtime configuration.

Post-deployment checks found migration head 49, 232 schema fingerprint rows,
`PRAGMA integrity_check = ok`, zero foreign-key violations, and the same 2,537
historical readings. Node-RED reports `running`; `/gui` returns HTTP 301. The new
profile and Apply routes return HTTP 401 without credentials. Those probes left
`sdi12_recipe_deployments` and `sdi12_identify_attempts` empty for the target
device.

The target device queue remained empty. The one unrelated ChirpStack queue item,
ID `cfcdb7b6-cfbe-4e38-b0b7-34c1124a4868` for device
`A840410000000101`, retained FPort 2, its eight-byte payload length, and its
original creation timestamp. No queue flush ran.

## Deferred evidence and recovery boundary

Physical commissioning has not started. After the operator replaces the field
probe, run address discovery, confirm the returned address against the attached
probe, save the eight-module layout, and Apply once. Then observe queue drain and
two complete matching post-drain uplinks. If queue delivery times out or a reading
quarantines, retain the existing readings and queue evidence; do not guess an
address, shorten the interval, enable continuous power, or repeatedly apply.

## Worktree treatment

`docs/devices/dragino-sdi12.md` was dirty before Task 7. Synthetic baseline
`f1a832e973b9dac86d411494af9a97a917d164c9` captured its prior bytes above real
HEAD `57a3c196`. This task added the recipe-deployment guide material on top of
that file, but leaves the entire overlapping guide change unstaged. Existing
modified and untracked files, including `node_modules/`, were preserved. The
only intended Task 7 commit is this clean execution report.

## Post-deployment field correction, 2026-08-30

The deployed control plane correctly serialized and tracked its queue, but the
recipe compiler's `0xAF` wire encoding was wrong. It placed the complete console
strings, including commas and decimal digits, in the binary values. Dragino's
documented structure instead carries the command text through `!` followed by
three raw parameter bytes; DATACUT carries four raw parameter bytes. This is why
the 15 stored queue IDs drained while commissioning reached three failed
observations and `acquisition_observation_failed`.

Correct compact frames were sent manually to field device
`A8404135955C327D`. They produced complete eight-VWC/two-VIC rows at
`22:16:48Z`, `22:18:36Z`, `22:20:29Z`, `22:30:49Z`, and `22:40:48Z`. The last
two used the intended eight-second power window. The full vector arrived in
three PAYVER 2 segments and was stored atomically. The 1200-second interval
restore frame was then delivered and removed from the queue. A complete row at
`23:01:05Z`, 20 minutes 17 seconds after the preceding row, proved the restored
cadence.

Recipe compiler version 2 now has a regression fixture for Dragino's official
`AT+COMMAND3=0MC!,1,1,1` vector, raw-byte validation for command and cut
parameters, newline suppression, confirmed queue items, and the normal
1200-second interval as its final frame. Both maintained-profile helper suites
pass. Deployment of this correction and two matching post-drain observations
supersede the report's earlier statement that physical commissioning had not
started.

## Recipe version 2 live deployment, 2026-08-30

Before deploying the correction, the gateway created
`/data/db/backups/osi-os-pre-sentek-recipe-v2-20260830T230447Z`. Both the edge
and ChirpStack backup databases passed `PRAGMA integrity_check`; the backup also
contains the active flows, Node-RED settings and credentials, and GUI files.

The guarded deploy preserved `/data/db/farming.db`, found no pending migration,
and flipped `/srv/node-red/flows.json` to
`payloads/20260830T230518Z/flows.json`. Its local Node-RED and `/gui` health
check passed before the payload was committed. Migration head remained 49,
`PRAGMA integrity_check` returned `ok`, foreign-key check returned no rows, and
all 2,657 pre-deploy history rows remained. The deployed recipe and
commissioning helper SHA-256 hashes match the reviewed branch artifacts.

A confirmed `0100003C` commissioning frame was queued with an otherwise empty
device queue to reduce the delivery interval to 60 seconds. It is a monitored
temporary operation; recipe version 2 ends with `010004B0`, so normal cadence
is restored even when the operator does not send a separate cleanup command.

## TriSCAN VWC semantic correction, 2026-08-30

The first complete field rows exposed a second, independent fault. PConfig had
auto-configured the moisture rows for the TriSCAN modules at 10 and 50 cm with
identity coefficients `A=1`, `B=1`, and `C=0`. Their `aM!` values, about `0.73`
and `0.97`, were normalized scaled frequency rather than VWC percent. The six
EnviroSCAN rows in the same response were already calibrated VWC.

The normalizer now applies Sentek's default moisture relation only to layout
entries marked `TRISCAN`:

```text
SF = 0.1957 * VWC^0.404 + 0.02852
VWC = ((SF - 0.02852) / 0.1957)^(1 / 0.404)
```

EnviroSCAN values and the separate `aM2!` VIC values remain unchanged. Negative
scaled frequency, a derived value above 100%, and a wrong-cardinality mixed
frame still reject atomically. The canonical and mirrored normalizer suites
pass 28 tests each. The 36-case device integration suite includes the exact
three-segment field capture and expects `23.81%` and `48.72%` for its two
TriSCAN positions. It also reassembles and persists a five-segment,
ten-TriSCAN fixture containing all ten VWC and all ten VIC channels.

The live gateway backed up the prior helper, active flows, and an online SQLite
copy at
`/data/db/backups/osi-os-pre-triscan-vwc-20260830T234132Z`. The helper was
backed up again at
`/data/db/backups/osi-os-pre-sentek-maxsegments-20260831T000705Z` before the
five-segment profile limit was deployed. Its final hash is
`49c2692b88df3ab765d5cf713d034fcd586423afa9c02f2a231be5a83b369350`.
Node-RED restarted with port 1880 listening; the live database passed integrity
and foreign-key checks.

The first post-deploy radio row, ID 3404 at `2026-08-30T23:46:38Z`, stored
`23.62, 28.19, 37.42, 41.07, 48.73, 46.21, 38.87, 44.37` percent VWC and VIC
`1615.59, 4243.75`. Its outbox payload contained the same values and was
accepted by the cloud at `23:47:03Z`. ChirpStack then reported an empty device
queue, and the local deployment poller recorded queue drain at `23:47:03Z`.

The first post-drain row, ID 3405 at `2026-08-31T00:06:37Z`, stored
`23.65, 28.19, 37.43, 41.08, 48.73, 46.23, 38.87, 44.37` percent VWC and VIC
`1615.60, 4243.75`. Its outbox event was accepted at `00:07:03Z` with no retry
or rejection, moving the deployment to `observed_once`.

The second post-drain row, ID 3406 at `00:26:37Z`, stored
`23.79, 28.16, 37.43, 41.08, 48.72, 46.23, 38.87, 44.37` percent VWC and VIC
`1611.54, 4243.75`. It moved the deployment to `observed_compatible` with two
successful observations, zero failed observations, and no error code. Its
outbox event was accepted at `00:26:57Z` with zero retries and no rejection.

Rows 3392 through 3403 predate the semantic correction and retain the rounded
scaled-frequency values in `vwc_1` and `vwc_5`. They were not rewritten: the
edge no longer retains their full-precision source strings, and an imprecise
historical estimate would conflict with the append-only, versioned cloud
history contract. New rows are canonical VWC.
