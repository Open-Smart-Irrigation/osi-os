# Task 7 implementer report

Task 7 adds migration 0068 and enables edge-owned WATERMARK calibration events. The migration keeps `watermark_readings` local, retains calibration tombstones, and extends the terminal command ledger with trusted binding fields.

## RED

- `node --test scripts/rehearse-watermark-cloud-parity-migration.test.js` failed because `0068__watermark_cloud_parity.sql` was absent.
- The ledger tests failed because `applied_commands.binding_hash` and the other trusted fields were absent.

## GREEN

- Migration rehearsal: 3 tests passed. It verifies calibration-only triggers, one uppercase gateway/device-bound upsert, raw-reading isolation, full tombstone payload, and retained tombstone row.
- `osi-command-ledger/index.test.js`: 32 tests passed. It verifies exact command-ID precedence, same binding/intent effect-key replay, six binding/intent conflict cases, payload-derived hashes, and trusted terminal-column persistence.
- `node scripts/verify-runtime-schema-parity.js`: passed.
- `node scripts/verify-trigger-body-parity.js`: passed.
- `node scripts/verify-db-schema-consistency.js`: passed for all seven images.
- `node scripts/verify-seed-replay.js`: passed.
- `node scripts/verify-seed-db-ledger.js`: passed, all seven images at migration head 68 with 273 fingerprints.
- `node scripts/verify-profile-parity.js`: passed.
- `node scripts/verify-sync-op-parity.js`: passed. WATERMARK calibration ops are SQL-owned and no longer edge-deferred.
- `node scripts/verify-sync-flow.js`: passed.
- `git diff --check`: passed.

## Migration and seed evidence

`0068__watermark_cloud_parity.sql` adds eight nullable ledger columns and `idx_applied_commands_protected_effect`. The insert/update calibration triggers emit `WATERMARK_CALIBRATION_UPSERTED` or `WATERMARK_CALIBRATION_DELETED`; no trigger references `watermark_readings`. The seed builder regenerated all seven images through the ordered migration runner; no database file was edited by hand.

The bcm2709 and bcm2712 command-ledger helpers and tests are byte-identical.

## Concerns

The protected helper accepts the signed pending-command payload as the trusted source when a caller does not provide precomputed hashes. A future command-application caller should pass `protected_context` when its authoritative binding and intent hashes are already available; the current pending-command flow remains unchanged and WATERMARK command staging remains deferred.
