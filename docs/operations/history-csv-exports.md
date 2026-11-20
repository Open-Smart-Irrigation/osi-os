# History CSV export bounds and encoding

History CSVs start with the UTF-8 BOM (`EF BB BF`). This includes the per-zone
and all-zones downloads and the generated raw, hourly and daily files. Column
names, formula escaping and numeric precision are unchanged. A machine reader
must remove one leading U+FEFF before parsing the header; Python readers can use
`encoding='utf-8-sig'`, which also accepts older files without a BOM.

## Bounds

Both HTTP exports accept at most 92 inclusive calendar days for raw data, 730
for hourly data and 3,660 for daily data. These existing limits are retained:
aggregate exports read one local calendar month per source at a time, so the
daily bucket skeleton holds at most 31 days per source window. Issue #437's
1900-to-present request is rejected with HTTP 413 before history is read.

The row ceiling is 200,000 per response, including derived pF rows. Aggregate
exports also reserve a budget for every source/channel/bucket combination,
including empty buckets and potential pF rows, before reading that zone's
history. The same ceiling applies across all zones together. A caller can lower
the budget but cannot raise it. A 3,660-day daily export of three SWT channels
reserves 21,960 cells per sensor, allowing nine such sensors within the ceiling.
The tenth is refused. Sparse input cannot bypass this check.

A range refusal uses `RANGE_TOO_LARGE`; a row or bucket refusal uses
`EXPORT_TOO_LARGE`. Both have status 413 and a suggestion to shorten the range,
choose a coarser granularity or select fewer channels, as applicable.

Daily buckets follow each zone's local calendar, including 23- and 25-hour DST
days. A missing channel is a blank daily value. A measured zero remains zero;
exports never fill a missing depth with a different depth or a mean. pF is
derived after aggregating canonical kPa and remains undefined at zero.

## Shared export slot

`osi-history-router.withHistoryExportSlot(build)` admits one export and rejects
another immediately with status 429, `Retry-After: 30` and an explanatory
message. It releases in `finally` after success or failure. A disconnect does
not release the slot while the build still runs. The all-zones handler uses it;
`osi-history-router.buildZoneExportCsv` provides the corresponding per-zone
build and serialization under the same slot.

The per-zone flow still needs the handoff below. Until that wiring lands, the
per-zone route receives the bounds and BOM through its existing helper calls,
but does not acquire the slot or forward `Retry-After`.

## Flows handoff

EB12 does not hold the flows reservation and changes neither profile's
`flows.json`. When the reservation is granted, update `history-api-router-fn`
in both profiles:

1. Keep the current authentication and zone-scope checks. Replace
   `osiHistory.buildZoneExportCsv(db, options)` with
   `HR.buildZoneExportCsv(db, options)`, and pass `result.csv` to `respondCsv`
   instead of calling `osiHistory.toCsv` again. `HR` is already declared in
   this node's `libs` as `osi-history-router`; no new module binding is needed.
   If converting that binding to the registry, its loader is
   `osiLib.require('history-router')`; check `ok` before using `value`.
2. Let `respond(statusCode, payload, headers)` assign
   `msg.headers = { ...RESPONSE_HEADERS, ...headers }`, and pass `error.headers`
   as its third argument in the outer catch. This preserves `Retry-After`.
3. Keep `history-zone-export-csv-http` and
   `history-all-zones-export-csv-http` wired to their current handlers. No HTTP
   route, scope policy or `libs` addition is required.
4. Verify function parsing, the size ratchet, profile parity, history API
   contract, HTTP response headers and the shared-slot tests. Include an HTTP
   test of simultaneous per-zone/per-zone and per-zone/all-zones requests.

## Consumer audit and fixtures

The local `osi-server` checkout at `460c424be` has no history-CSV import path.
Its history controller writes CSV through `HistoryCsvWriter`; history sync
consumes structured data rather than these files. CSV readers for provider
weather and Flyway ledgers consume unrelated formats. No server file was edited.
Cloud history CSV encoding changes belong to the cloud export package.

The GUI's `downloadHistoryCsv` in `web/react-gui/src/services/api.ts` requests a
blob and wraps it in another blob for download. It does not parse the header.
The byte-preservation fixture exercises that operation. GUI source is reserved
for its batch writers and is unchanged.

Repository export checks that parse the first header strip the leading BOM.
The history-router CSV golden vector now expects it; only those three prefix
bytes change. `scripts/fixtures/history-export-utf8.csv` pins accented labels,
quoted commas and quotes, formula protection, zero and a blank value. The bounds
suite also reads it with Python's BOM-aware CSV parser and verifies repeated
writes of old and new daily files carry exactly one BOM.
