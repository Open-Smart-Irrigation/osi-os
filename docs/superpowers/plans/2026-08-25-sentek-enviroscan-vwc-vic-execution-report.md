# Sentek EnviroSCAN VWC and VIC execution report

**Date:** 2026-08-26
**Edge:** `/home/phil/Repos/osi-os-agrolink` (`AgroLink`)
**Cloud:** `/home/phil/Repos/osi-server/.worktrees/agrolink` (`feat/journal-cloud-primary`)

## Result

The paired implementation adds a versioned Sentek channel layout with up to ten modules, VWC channels 9–10, and VIC channels 1–10. The edge validates and stores the layout, maps VWC-only and mixed VWC/VIC frames, exposes configured rows in the GUI, and carries the new state through history, export, bootstrap, and outbox sync. The cloud accepts the layout and telemetry without adding a cloud SDI-12 card.

TriSCAN decoding now accepts one strict mixed vector: all configured VWC values in response-position order, followed by VIC values for configured TriSCAN modules in the same order. The installed rail therefore requires exactly eight VWC plus two VIC values. Legacy eight-value VWC-only frames remain quarantined as `sdi12_vic_framing_unverified`; every other count mismatch or invalid VIC rejects the complete soil sample while retaining battery telemetry.

The first live attempt used `LM2!`, `LC1!`, and explicit `LD0!` recipes, which returned no salinity bytes. Bench work on 2026-08-28 established the required command boundaries and DATACUT values. A subsequent LoRaWAN transmission carried eight VWC values followed by two TriSCAN VIC values through the production codec, reassembler, normalizer, writer, SQLite database, and GUI.

## Review corrections made during execution

1. `merge-device-data` queried the new telemetry but initially omitted it from `latest_data`. The response now includes VWC 9–10 and VIC 1–10, with a regression test through the real function-node harness.
2. Generated array entries in `format-devices` and `sync-bootstrap-build` initially lacked JavaScript separators. Both functions now compile, and the device-list SQL prepares against a seeded database.
3. The seed placed the twelve additive telemetry columns before older columns, while migration replay appended them. The seed now uses migration order, restoring fingerprint parity.
4. Malformed stored layout JSON was initially reported as configured. The API now reports `invalid`, the React boundary rejects malformed or duplicate layouts, and the device card displays a visible error.
5. Removing a middle module initially left non-contiguous response positions. Removal now preserves stable channel numbers while closing the response-position gap.
6. Channel-manifest hash and registry expectations were updated after the new entries were reviewed.
7. Exact Node-RED size ceilings were raised only for the five changed functions, with ownership reasons; total embedded JavaScript is pinned at the measured value.

## Edge verification

The following commands passed:

```text
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/index.test.js
node --test scripts/test-sdi12-registration.js
node --test scripts/test-sentek-vwc-vic-schema.js
node scripts/verify-device-integration.js
node scripts/test-contract-schemas.js
node scripts/test-history-helper.js
node scripts/verify-channel-manifest-parity.js
node scripts/verify-history-api-contract.js
node scripts/verify-migrations.js
node scripts/verify-seed-replay.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-runtime-schema-parity.js
node scripts/verify-devices-rebuild-fence.js
node --test scripts/rehearse-devices-rebuild.test.js
node scripts/verify-profile-parity.js
node scripts/verify-sync-flow.js
node scripts/verify-no-new-silent-catch.js
node scripts/verify-flows-size-ratchet.js
scripts/check-mqtt-topics.sh
```

Observed focused totals included 27 normalizer tests, 13 SDI-12 registration tests, two additive-trigger tests, and 33 device-integration tests. Both maintained flow profiles are byte-identical. The flow-size result is `1297389 <= 1297389`; the silent-catch baseline remains 89 in each profile.

The final edge GUI command was:

```text
cd web/react-gui
npm run test:unit
npm run typecheck
npm run build
```

The authoritative final run passed with 128 Node-runner tests and 1,745 Vitest tests. TypeScript emitted no errors, and the production build completed successfully.

## Cloud verification

Focused backend sync tests passed:

```text
./gradlew test \
  --tests org.osi.server.sync.EdgeSyncServiceControlPlaneTest \
  --tests org.osi.server.sync.EdgeSyncServiceBootstrapTest \
  --tests org.osi.server.sync.EdgeSyncServiceDataPlaneTest
```

The cloud frontend passed `npm run test:unit` with 123 Node-runner tests and 719 Vitest tests across 120 files. `npm run build` passed. A final focused API/manifest parity rerun passed 16 tests across three files after the last test-only edit. Backend and frontend channel manifests are byte-identical at SHA-256 `3a44492e41e5c8e986bdce504dcf17a4366ffdf67c2f4952b7bb46e8bbc24dd2`.

The full cloud command is:

```text
cd backend
./gradlew test --no-daemon
```

The branch baseline failed only `ArchitectureTest.noNewPackageCycles` because ArchUnit throws `StoreUpdateFailedException` while updating its frozen-violation store. The authoritative final run completed 1,639 tests with one failure and one skip; the sole failure was that same baseline ArchUnit condition. The Sentek-focused control-plane, bootstrap, and data-plane suites passed.

## Final review status

No feature-introduced test failure remains. `git diff --check` passed in both worktrees, the maintained edge runtime mirrors are byte-identical, and the paired sync-contract and channel-manifest files match.

Cloud acceptance was deployed first, followed by the edge implementation. The complete cloud backend gate remains baseline-red for the proven ArchUnit freeze-store condition. Live VIC acceptance closed on 2026-08-28 with a complete ten-value LoRaWAN vector and two consecutive stored rows.

## Live edge deployment

The pre-deploy backup is `/data/db/backups/pre-sentek-triscan-20260826-065537`.
Its SQLite integrity check passed before deployment. The first deploy attempt
stopped before migration because two temporary MQTT capture processes included
`node-red` in their command line and tripped the conservative process-stop
gate. The deploy script restarted Node-RED and restored the identity supervisor.
Migration head remained 47.

After removing those two capture helpers, the guarded retry succeeded:

- Migration 48 applied at `2026-08-26T08:17:08.324Z`.
- `/data/db/farming.db` remained in place and passed `PRAGMA integrity_check`.
- Existing `device_data` history remained present; 2,246 rows were counted
  immediately after deployment.
- `/srv/node-red/flows.json` points to payload `20260826T081637Z`.
- Node-RED and `/gui` passed the deploy script's local health probe.
- The deployed normalizer SHA-256 matches the branch artifact byte for byte.
- The installed eight-module layout was saved as sync version 8 and emitted a
  `DEVICE_FLAGS_UPDATED` outbox event with VIC only at channels 1 and 5. The
  event was delivered at `2026-08-26T08:18:02.453Z` without retry or rejection.
- A live-runtime synthetic call mapped `soil_vic_1=201.78` and
  `soil_vic_5=216.7` with no unknown channels.

The Dragino recipe queue was flushed and rebuilt through the authenticated
local ChirpStack gRPC API. Its order was temporary 60-second cadence, a
60-second 12 V window, clear owned slots, four command/cut pairs, `PAYVER=2`,
then `DATAUP=1`. After the first command was transmitted, an old asynchronous
publish appended a duplicate clear-slots command after `DATAUP=1`. The queue
was flushed and rebuilt with only the 12 legitimate remaining commands before
the next device uplink. No duplicate returned.

The device consumed the commissioning sequence from frame counter 84 through
98. The requested 60-second cadence produced effective intervals ranging from
about one to four minutes while the long SDI-12 slots were installed. Frame 97
proved that `PAYVER=2` applied. Frames 98 and 99 used the segmented envelope but
contained one empty segment: `SegCount=1`, `SegIndex=0`, and no SDI-12 bytes.
The latest row therefore contains battery voltage 3.486 V and null VWC/VIC
channels. This is a live probe-acquisition failure, not a parser acceptance.

After frame 98 established the empty production result, the 1200-second cadence
restore was queued. Frame 99 opened its Class A receive window at
`2026-08-26T09:28:06Z`; the gateway scheduled and acknowledged the restore
downlink, and the authoritative ChirpStack queue became empty. Node-RED and
`/gui` remained healthy, migration 48 remained applied, `device_data` reached
2,261 rows without history loss, and `PRAGMA integrity_check` returned `ok`.
Frame 100 arrived at `2026-08-26T09:52:22Z`, 24 minutes 16 seconds after frame
99. This confirms the 1200-second TDC restore; the additional time matches the
configured SDI-12 waits and retries. Frame 100 was also an empty segment and
raised the preserved `device_data` row count to 2,262.

## Live bench closure on 2026-08-28

The successful node was `A84041E3EC611C56`, using Sentek address `0`, `PAYVER=2`,
and `DATAUP=1`. The working recipe was:

```text
AT+COMMAND1=0M!,1,1,2
AT+COMMAND2=0D1!,0,0,2
AT+COMMAND3=0D2!,0,0,2
AT+COMMAND4=0M2!,1,1,2
AT+DATACUT1=30,2,2~28
AT+DATACUT2=30,2,2~28
AT+DATACUT3=21,2,2~19
AT+DATACUT4=21,2,2~19
```

The reassembled payload was:

```text
+0.027675+0.002684+0.000303+0.000190+0.042583+0.003221+0.006823+0.011044+204.9202+208.4880
```

Rows recorded at `2026-08-28T17:23:45.199017464Z` and
`2026-08-28T17:25:25.691808833Z` stored `vwc_1=0.03`, `vwc_5=0.04`,
`soil_vic_1=204.92`, and `soil_vic_5=208.49`. The remaining low VWC values
matched the probe's above-ground bench condition. The GUI displayed eight
depth rows and placed VIC beside VWC at 10 cm and 50 cm. The later field review
showed that `0.03` and `0.04` were the TriSCAN modules' scaled-frequency values,
not percent VWC; the semantic correction is recorded below.

The exact two-segment payload is now an end-to-end golden vector in
`scripts/fixtures/device-integration/sdi12/golden-vectors.json`.

## Residual hardware boundaries

The field node now proves the saved address, eight-module recipe, 8-second
power window, 20-minute cadence, and repeated edge-to-cloud delivery. Software
coverage compiles every one- through ten-module EnviroSCAN/TriSCAN combination
and persists a worst-case five-segment, ten-TriSCAN vector. A physical
ten-module rail still needs its own payload and power-timing capture before it
inherits the field node's 8-second setting. Removing or failing a middle module
also remains a bench test because its effect on Sentek response positions has
not been observed.

## Field closure and compiler correction, 2026-08-30

The installed eight-module probe was re-tested on field Dragino
`A8404135955C327D`. The probe identity, saved address `0`, response order, and
two TriSCAN positions matched the lab fixture. Complete eight-VWC/two-VIC rows
were stored repeatedly, including two measurements with the switched 12 V
window reduced from 45 seconds to eight seconds. The latest two proof rows were
recorded at `22:30:49Z` and `22:40:48Z` with battery voltage 3.414 V. Both rows
contained every configured channel; the second stored VIC values 1627.09 and
4237.62 at 10 and 50 cm. A further complete row at `23:01:05Z`, 20 minutes 17
seconds after the previous row, proved the 1200-second reporting interval.

This test corrected the prior hardware-fault hypothesis. The original recipe
compiler copied full console values such as `0M!,1,1,2` and `30,2,2~28` into
the `0xAF` payload as ASCII. Dragino's binary frame stores the command through
`!` as ASCII but stores the three command settings and four DATACUT settings as
raw bytes. Queue drain therefore proved delivery without proving a valid slot
configuration. Manual compact binary frames restored acquisition immediately.

The field converter split the 90-character ten-value vector across three
42-character PAYVER 2 slices, not two. The normalizer budget and Sentek profile
allow five slices so the supported ten-TriSCAN worst case can carry ten VWC and
ten VIC values. Recipe version 2 also sends `A500` to suppress
inserted newlines, uses confirmed downlinks, and ends with `010004B0` to restore
the 1200-second interval. The exact evidence, frames, calibration counts, and
future diagnostic order are recorded in
`docs/operations/sentek-dragino-sdi12-commissioning-2026-08-31.md`.

## TriSCAN moisture correction and recipe version 2 deployment

PConfig had stored `A=1`, `B=1`, and `C=0` for the two legacy TriSCAN moisture
rows. Their field values of about `0.73` and `0.97` were therefore normalized
scaled frequency. Treating them as percent VWC created the near-zero readings
shown by the first field GUI. The normalizer now applies Sentek's default
moisture curve only to configured TriSCAN positions. The exact field fixture
maps them to about `23.81%` and `48.72%`; the six EnviroSCAN values and two VIC
values are unchanged.

Recipe version 2 and the corrected normalizer are deployed on the field
gateway. The first corrected live row at `2026-08-30T23:46:38Z` stored
`vwc_1=23.62`, `vwc_5=48.73`, `soil_vic_1=1615.59`, and
`soil_vic_5=4243.75`, along with all six EnviroSCAN VWC values. The cloud
accepted its matching outbox event at `23:47:03Z`. ChirpStack's queue was empty
and the deployment poller recorded drain at the same time. The first post-drain
row at `00:06:37Z` repeated all eight VWC and both VIC values, synced without a
retry or rejection, and moved commissioning to `observed_once`. The second row
at `00:26:37Z` also contained the complete profile, moved commissioning to
`observed_compatible`, and was accepted by the cloud at `00:26:57Z` with zero
retries and no rejection. The field node is therefore Active at the normal
20-minute cadence.
