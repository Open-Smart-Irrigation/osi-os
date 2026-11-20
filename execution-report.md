# EB12 implementation evidence

EB12 adds bounded per-zone history CSV generation, a shared export slot and the
Excel UTF-8 BOM. The draft remains blocked on the dispatcher's flows reservation
for the per-zone slot and `Retry-After` wiring. No flow or GUI file was edited.

Startup: READY, base and HEAD `ec822b556`, behind 0 / ahead 0; AGENTS.md revision
`c63103827`. The initial inherited checkout was MISMATCH (79 behind / 3 ahead),
so implementation started on a fresh branch from `origin/main`, as required by
the common brief. Branch: `fix/eb12-history-export-bounds`.

## Red evidence

Before implementation, the new bounds suite failed on both profiles because
`maxRows: 1` did not reject the per-zone export, and because the second local
DST day lacked its expected null-valued channel row (4 failures). Separate
checks failed because the shared slot was not exported and because the CSV
fixture lacked the three BOM bytes. The first test-fixture attempt also failed
on required setup timestamps; those setup errors were corrected before the
behavior red run.

After implementation, the all-zones suite initially reported four byte mismatch
failures in assertions that still expected BOM-free headers. Only those header
expectations changed. The new behavior tests passed on both profiles in that run. Broader history
checks then identified six pinned-byte assertions and two month-row assertions
affected by the BOM and explicit missing days. The measured-row hashes were
retained: comparisons remove the BOM and the new blank daily cells. The month
fixture still requires all 21 measured days and now also requires 9 blank days.

## Implementation

The existing inclusive limits remain 92 raw days, 730 hourly days and 3,660 daily
days. Both public builders now enforce 200,000 output rows. Aggregate exports
also check potential source/channel/bucket cells, including empty buckets and
pF expansion, before reading a zone's history. This budget accumulates across
zones and cannot be raised through options.

The month-at-a-time aggregate reader limits each daily skeleton to 31 days per
source window. A three-channel SWT sensor reserves 21,960 cells over 3,660 days;
nine fit under 200,000 and ten do not. Extreme historical ranges return 413.
Exact range boundaries and budget accumulation have dedicated tests.

Daily exports emit blank missing values per source/channel, preserving measured
zero and each zone's local day through DST. No requested depth is replaced by
another depth. Existing kPa/pF precision and formula escaping remain covered.

All history CSV serializers and generated daily files write one BOM. The golden
CSV response differs only by that prefix. A compatibility fixture checks quoted
Unicode text, formulas, zero and missing values through UTF-8 bytes, the GUI's
blob-wrapping operation and Python's `utf-8-sig` CSV reader. Old daily files gain
a single BOM on rewrite; repeated writes do not add another.

## Consumer audit

The read-only server checkout at `460c424be` has no history-CSV importer. Its
history sync uses structured payloads; its `HistoryCsvWriter` is an exporter.
Provider-weather CSV parsers and Flyway-ledger scripts consume other inputs.
The edge GUI downloads these files as blobs without parsing the header. Its
source is unchanged. The in-repo all-zones test parser strips one leading BOM.
Cloud-generated CSV changes belong to the cloud export package.

## Checks

Every command below exited 0 on the final code. The export suites reported
51/51 passing tests; the broader history suites reported 120/120. The constrained
heap run reported 10/10, and the HTTP response suite reported 2/2.

| Command | Result / observed pass signal |
|---|---|
| `node --test --test-concurrency=1 scripts/test-history-export-bounds.js scripts/test-history-all-zones-export.js` | PASS; `# tests 51`, `# pass 51`, `# fail 0` |
| `node scripts/test-history-helper.js` | PASS; ends `OK runRollupJob populates hourly and daily rollups for a zone` |
| `node conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.test.js` | PASS; 45 tests, 0 failures |
| `node conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-router/index.test.js` | PASS; `76 passed, 0 failed` |
| `node scripts/capture-history-router-vectors.js --verify` | PASS; `[verify] 4/4 routes passed.` |
| `node scripts/verify-history-api-contract.js` | PASS; `verify-history-api-contract: OK` |
| `node --test --test-concurrency=1 scripts/test-history-recorded-at-formats.js scripts/test-history-source-guards.js scripts/test-history-source-v2.js scripts/test-history-router-soil-projection.js` | PASS; 120 tests, 0 failures |
| `node scripts/verify-sync-flow.js` | PASS; `Sync flow verification passed`, ending `All parity checks passed.` |
| `node --test scripts/test-history-response-headers.js` | PASS; 2 tests, 0 failures, real Node-RED HTTP CSV bytes on both profiles |
| `node --max-old-space-size=192 --test scripts/test-history-export-bounds.js` | PASS; 10 tests, 0 failures, including 1900-to-present rejection |
| `node scripts/verify-profile-parity.js` | PASS; `All parity checks passed.` |
| `node scripts/verify-no-new-silent-catch.js` | PASS; 65 empty catches per profile, unchanged baseline |
| `node scripts/verify-doc-hygiene.js` | PASS; built-in patterns only, no private name list supplied |
| `node scripts/verify-agents-size.js` | PASS; 28,648 bytes, below 30,720 |
| `node .claude/skills/anti-slop-writing/slop-check.js execution-report.md docs/operations/history-csv-exports.md` | PASS; no tier-1 findings |
| `git diff --cached --check` | PASS; no whitespace errors |

All SQLite-heavy suites and the full sync gate run sequentially under
`osi-heavy wait --contain --scratch-tmpfs 1G --need-gib 8`. No live host,
gateway or cloud was accessed. No schema, deployment pin or sync transport
contract changed.

## Flows handoff

[History CSV export bounds and encoding](docs/operations/history-csv-exports.md)
contains the exact node and wiring handoff. `history-api-router-fn` must call
`HR.buildZoneExportCsv` and send its `csv`, then forward error headers through
`respond`. Its existing `HR` module binding already loads `osi-history-router`.
Until that lands, per-zone bounds and BOM apply, but its HTTP route has no slot
or `Retry-After`. The dispatcher supplies the reservation and subsequent Sol
review; this implementer does not mark ready, request review or merge.
