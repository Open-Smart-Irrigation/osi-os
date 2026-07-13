# Task 13 execution report

Task 13 adds a repeatable 10,000-entry performance fixture and two additive indexes required by the plot-first D10 query shapes. Work started from `b7aaffc21265c37dad8527a68a9ca4f0de057182`.

## TDD evidence

The first run used the pre-Task-13 schema. The fixture inserted exactly 10,000 final entries and 150,000 observed numeric values, 15 per entry, before running any plan or performance assertion.

`node scripts/test-journal-perf-fixture.js` failed for the two stale zone-keyed access paths:

| Query | Initial plan |
|---|---|
| Zone and occurrence range | `SEARCH e USING INDEX idx_journal_entries_zone_time (zone_id=? AND occurred_start>? AND occurred_start<?)` |
| Plot duplicate guard | `SCAN journal_entries USING INDEX idx_journal_entries_zone_time`; temporary B-tree for absolute-distance order |
| Plot sticky layout | `SEARCH journal_entries USING INDEX idx_journal_entries_sticky (author_principal_uuid=?)`; temporary B-tree for order |
| Gateway and occurrence range | `SEARCH e USING INDEX idx_journal_entries_gateway_time (gateway_device_eui=? AND occurred_start>? AND occurred_start<?)` |

The same RED run completed the behavior measurements before returning exit 1. A warmed, real `osiJournal.api.listEntries` second keyset page returned 50 rows with a 21.440 ms maximum across five samples. A real `exportWideCsv` call streamed all entries through a counting sink: 10,001 CRLF records, 7,854,972 bytes, 201 writes, 689.610 ms, and 31.910 MiB maximum sampled RSS growth. It did not collect the CSV in memory.

The failure confirmed that the original Task 1 indexes used `zone_id` where D10 and the lifecycle query use `plot_uuid`. No existing migration was edited. `0017__journal_plot_lookup_indexes.sql` adds these partial indexes:

- `idx_journal_entries_plot_duplicate (plot_uuid, activity_code, occurred_start, entry_uuid)` for final, non-deleted entries.
- `idx_journal_entries_plot_sticky (author_principal_uuid, plot_uuid, recorded_at DESC, entry_uuid)` for final, non-deleted entries.

The existing zone and gateway indexes remain because the API still supports those range filters. The old zone-keyed duplicate and sticky indexes also remain; removing them would turn an additive fix into destructive migration work without a Slice 1 requirement.

## Final fixture result

The final run passed with these plans:

| Query | Final plan |
|---|---|
| Zone and occurrence range | `SEARCH e USING INDEX idx_journal_entries_zone_time (zone_id=? AND occurred_start>? AND occurred_start<?)` |
| Plot duplicate guard | `SEARCH journal_entries USING INDEX idx_journal_entries_plot_duplicate (plot_uuid=? AND activity_code=? AND occurred_start>? AND occurred_start<?)` |
| Plot sticky layout | `SEARCH journal_entries USING INDEX idx_journal_entries_plot_sticky (author_principal_uuid=? AND plot_uuid=?)` |
| Gateway and occurrence range | `SEARCH e USING INDEX idx_journal_entries_gateway_time (gateway_device_eui=? AND occurred_start>? AND occurred_start<?)` |

The duplicate guard still reports a temporary B-tree for `ORDER BY ABS(julianday(...))`. That sort is required by the shipped lifecycle query; row access now searches the bounded plot, activity, and occurrence range through the intended index.

Final measured behavior:

- Fixture counts: 10,000 final entries; 150,000 observed numeric values; minimum and maximum 15 values per entry.
- Keyset page: 50 rows; samples 20.394, 19.026, 23.353, 20.859, and 22.070 ms; maximum 23.353 ms against the 100 ms limit.
- Streamed CSV: 10,001 CRLF records; 7,854,972 bytes; 201 writes; 782.576 ms; 30.043 MiB sampled RSS growth against the 64 MiB limit.

The list test obtains a real cursor, warms that exact second-page query once, and checks the slowest of five measured calls. The CSV test is not pre-run. It samples RSS before, during, and after sink writes and uses a 5 ms monitor without invoking garbage collection.

## Change-control registration

The additive migration is registered in `database/migrations/ordered/CHECKSUMS.json` with SHA-256 `517b78538b000c363e5729ed2716994523787ef826fb0b2819f4c3beae796cf4`. Identical index DDL is present in `database/seed-blank.sql` and all seven bundled `farming.db` files. `scripts/verify-db-schema-consistency.js` now pins both index names, column order, and partial predicates.

No flow file, boot DDL, deploy script, or pre-existing ordered migration changed. The maintained full-profile database payloads were restored to byte parity by copying the updated bcm2712 database to the bcm2709 mirror after applying the migration to the other database copies.

## Verification

| Command | Result |
|---|---|
| `node scripts/test-journal-perf-fixture.js` | PASS; counts, plans, timing, record count, and RSS limit above |
| `OSI_MIGRATIONS_BASE_REF=69f7a9f2 node scripts/verify-migrations.js` | PASS; 17 migrations, manifest and base immutability valid |
| `node scripts/verify-seed-replay.js` | `verify-seed-replay: OK` |
| `node scripts/verify-db-schema-consistency.js` | PASS for all seven database copies |
| `node scripts/verify-runtime-schema-parity.js` | PASS for both flow profiles |
| `node scripts/verify-no-stray-ddl.js` | PASS; marker total remains 702 |
| `node --test scripts/test-deploy-migration-wiring.js` | PASS, 6 tests |
| `node scripts/verify-profile-parity.js` | `All parity checks passed.` |
| `node scripts/test-journal-schema.js` | PASS; catalog semantics, replay, and seven-DB data parity |
| Both maintained `osi-journal/index.test.js` suites | PASS |
| `node --test scripts/test-journal-api.js` | PASS, 22 tests |
| `node scripts/test-journal-lifecycle.js` | PASS, 92 tests |
| `node scripts/verify-sync-flow.js` | `Sync flow verification passed`; final profile parity passed |
| `node --test lib/osi-migrate/__tests__/*.test.js` | PASS, 60 tests |
