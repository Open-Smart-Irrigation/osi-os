# History CSV export bounds and encoding

History CSVs start with one UTF-8 BOM (`EF BB BF`). This includes per-zone and
all-zones downloads and generated raw, hourly and daily files. Column names,
formula escaping and numeric precision are unchanged. A machine reader must
remove the leading U+FEFF before parsing the header; Python's `utf-8-sig` reader
accepts both new files and older files without a BOM.

## Independent limits

Both HTTP exports accept at most 92 inclusive calendar days for raw data, 730
for hourly data and 3,660 for daily data. Every request must also fit each of
these ceilings:

| Resource | Ceiling | Charged work |
|---|---:|---|
| Per-read input rows | 30,000 | One source-window's SQL candidates plus carried date-margin rows, including nulls |
| Per-read input cells | 200,000 | Those candidates multiplied by the device's selected SQL fields, including legacy aliases |
| Request input work | 5,000,000 rows / 40,000,000 cells | Newly fetched candidates across every source, card and zone; margin rows count once per source-window sequence |
| Output rows / aggregate cells | 200,000 | Actual output expansion, plus preflight of empty source/channel/bucket cells and potential pF |
| CSV bytes | 8 MiB | Actual encoded UTF-8, including BOM, header, CSV escaping and newlines |

Options can lower these limits for tests or smaller callers; they cannot raise
them. Output and request work share a budget across the response. Input memory
is bounded per read, so a year of daily aggregates does not exhaust a single
month's memory allowance. Each projection and empty-cell preflight uses the
channels declared for that device type, with SWT3 eligibility preserved. Known
types without a family for a card contribute no channels to that card.

The work ceiling comes from the supported date range and observed reporting
cadence: four five-minute sources over all 3,660 daily dates require 4,216,320
samples. Five million allows those rows and outer date margins; forty million
cells accommodates their five tension/legacy-alias fields with headroom. These
are work ceilings, not a target-Pi latency guarantee. An LSN50 with three SWT
channels reserves 21,960 potential daily/pF cells over 3,660 days; output bytes
and other request limits can still refuse it. Sensor count alone does not
predict export capacity.

Raw exports read one physical source at a time; aggregate exports read one
local calendar month per source. SQLite chooses the access plan. On a normal
DB the `(deveui, recorded_at)` index satisfies the source/range predicate and
`ORDER BY recorded_at, id` without a temporary sort. A missing index permits a
slower correct read. SQL applies `LIMIT remaining + 1`; the extra row is an
overflow sentinel and produces 413. The allowance is the smaller of remaining
per-read memory and request work, divided by selected field width for the cell
limits. Null-heavy input consumes the same budget as valued input. Nothing is
silently truncated.

Indexed lexical date bounds include margins for older timestamp encodings.
Those candidates consume request work before exact instant filtering in JS.
Adjacent windows carry their boundary candidates forward and advance the SQL
lower bound past the previous read. The same margin rows are neither fetched
nor charged again. Only the adjacent margin remains live between windows.
Aggregation uses these bounded reads directly rather than the interactive
history reader's optional rollup/raw-limit behavior.

All authorized aggregate scopes are resolved and preflighted before the first
measurement query. Preflight and aggregation reuse the same month windows.
Hourly cell counts sum each window's rounded-up bucket count, including
half-hour DST changes such as `Australia/Lord_Howe`.

Output rows and derived pF are charged before retaining an expansion. Byte
charges use the actual escaped line encoding before retaining row objects or
serialized output. Serializers also enforce the byte ceiling themselves.
Refusals remain whole JSON responses; no partial CSV attachment is sent. The
accepted maximum-width fixture approaches 8 MiB under a 192 MiB Node heap;
this is a host qualification, not a measurement on target hardware.

## Local days and stored CSV records

Daily buckets follow each zone's local calendar. An empty day emits blank
values only for channels that device type supports. A day with observations
emits its measured channels, as on main; it gains no fabricated blank channels.
Measured zero remains zero, and another depth never fills a missing depth. pF is derived after aggregating canonical kPa and stays undefined at zero.

An absent civil date maps to the next existing local boundary. For example,
`Pacific/Apia`'s skipped 2011-12-30 is an empty interval on every export path.
It produces no measurement reads or rows. A spanning range exports the existing
days without borrowing the preceding day's data.

Daily rewrites split complete CSV records, preserving quoted embedded CR/LF,
escaped quotes and existing numeric tokens. Replacement uses the timestamp's
zone-local date, including UTC timestamps on the preceding calendar date.
The nightly writers have no HTTP row, input or byte budgets. Raw and hourly
files are written independently before daily processing. Daily history is
rewritten through a UTF-8 record stream and atomically renamed, without loading
the whole file or refusing it at 8 MiB. A malformed old daily file leaves that
file intact and does not undo the raw/hourly updates. Legacy BOM-less files gain
one BOM.

## Stable refusal codes and shared slot

`osi-history-helper.EXPORT_REASON_CODES` and `osi-history-router.EXPORT_REASON_CODES`
define the same contract. Existing English messages and suggestions remain for
older consumers; the GUI batch maps `payload.code` to locale keys.

| Wire `code` | HTTP status | Meaning |
|---|---:|---|
| `RANGE_TOO_LARGE` | 413 | Inclusive day limit exceeded |
| `EXPORT_TOO_LARGE` | 413 | Output rows or aggregate cells exceed the budget |
| `EXPORT_INPUT_TOO_LARGE` | 413 | SQL input row/cell work exceeded |
| `EXPORT_BYTES_TOO_LARGE` | 413 | Encoded CSV byte ceiling exceeded |
| `EXPORT_BUSY` | 429 | Another export holds the process slot; `Retry-After: 30` |

`withHistoryExportSlot(build)` admits one export and rejects the next immediately.
It releases in `finally` after success or failure. A disconnect does not release
it while the build still runs. The portable all-zones handler uses it;
`buildZoneExportCsv` provides the per-zone build and serialization under that
same module slot. `historyExportErrorResponse(error)` formats the JSON status,
code, message, suggestion and headers for both adapters.

The current portable route forwards codes. The shipped per-zone flow still
needs the reserved handoff below; until then it has bounds and BOM but lacks
the shared slot, stable wire code and `Retry-After` forwarding.

## Flows and GUI handoff

EB12 changes neither profile's `flows.json`. After EB2, when the dispatcher
grants the reservation, update `history-api-router-fn` in both profiles:

1. Keep authentication and zone-scope checks. Load the shared singleton with
   `const historyExports = osiLib.require('history-router');`, check `ok` and
   fail closed on a missing module. This is the same lookup as the portable
   flow. Use `historyExports.value.buildZoneExportCsv(db, options)` and send
   `result.csv`, keeping serialization inside the slot.
2. Use `HR.historyExportErrorResponse(error)` in the outer catch and forward its
   `statusCode`, `payload` and `headers` onto the Node-RED message. The formatter
   preserves CORS, JSON media type, `code` and busy `Retry-After`; it adds no
   CSV attachment header. `HR` is already declared in this node's `libs`.
3. Keep HTTP nodes `history-zone-export-csv-http` and
   `history-all-zones-export-csv-http` wired to their current handlers. Update
   the contract verifier's old helper-call and in-flow serialization assertions.
4. Pin refused HTTP responses and simultaneous per-zone/per-zone and
   per-zone/all-zones requests through the shipped flow. Run parse, size and
   parity gates. The focused module tests exercise a prepared per-zone adapter;
   they do not stand in for those deferred shipped-flow checks.

The GUI batch must reuse the Blob error decoder for per-zone downloads, retain
`code` in the decoded error and map the codes above to i18n keys. It must preserve
status and suggestion for old responses without a code. EB12 changes no GUI or
locale file.

## Consumers and fixtures

The read-only server audit at `460c424be` found no history-CSV importer. Its
history controller writes CSV; sync consumes structured data. Provider-weather
CSV readers and Flyway scripts consume other formats. No server file changed.
Cloud-generated CSV changes belong to the cloud export package.

The GUI download wraps the response Blob without parsing its header. The UTF-8
fixture pins Unicode, quoted delimiters, formula protection, zero and blank
values. Python's CSV reader verifies daily multiline rewrites. Measured-value
hashes remain pinned after accounting for the BOM and explicit missing cells.
