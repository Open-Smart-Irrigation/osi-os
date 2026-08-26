# Sentek EnviroSCAN VWC and VIC execution report

**Date:** 2026-08-26
**Edge:** `/home/phil/Repos/osi-os-agrolink` (`AgroLink`)
**Cloud:** `/home/phil/Repos/osi-server/.worktrees/agrolink` (`feat/journal-cloud-primary`)

## Result

The paired implementation adds a versioned Sentek channel layout with up to ten modules, VWC channels 9–10, and VIC channels 1–10. The edge validates and stores the layout, maps verified VWC-only frames, exposes configured rows in the GUI, and carries the new state through history, export, bootstrap, and outbox sync. The cloud accepts the layout and telemetry without adding a cloud SDI-12 card.

TriSCAN decoding now accepts one strict mixed vector: all configured VWC values in response-position order, followed by VIC values for configured TriSCAN modules in the same order. The installed rail therefore requires exactly eight VWC plus two VIC values. Legacy eight-value VWC-only frames remain quarantined as `sdi12_vic_framing_unverified`; every other count mismatch or invalid VIC rejects the complete soil sample while retaining battery telemetry.

The live Pi and its LoRaWAN queue were used with operator authorization. Diagnostic `LM2!`, `LC1!`, and explicit `LD0!` recipes returned no salinity bytes; Dragino raw framing reported `F1 00`. The software mapping fixture combines VWC values captured over LoRaWAN with the two VIC values observed in Sentek Probe Configuration Utility. It proves the codec, reassembler, normalizer, writer, SQLite, sync, and GUI path, but is not a successful live combined-radio capture.

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

Cloud acceptance was deployed first, followed by the edge implementation. The complete cloud backend gate remains baseline-red for the proven ArchUnit freeze-store condition. Live VIC acceptance remains open because the installed Dragino/Sentek path has not emitted the required ten-value vector.

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

## Deferred bench and deployment gates

- Obtain a non-empty salinity response from the installed probe and capture the complete eight-VWC/two-VIC vector.
- Resolve whether the empty salinity response is caused by probe configuration or the Dragino 12 V rail. Sentek documents a 200 mA startup requirement while Dragino rates its 12 V output at 100 mA.
- Prove the ten-module polling recipe and payload segmentation at the intended EU868 data rates.
- Keep the 12 V window at the deployed 60 seconds unless electrical testing
  proves a shorter window reliable.
