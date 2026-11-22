# EB12 export review fixes

This revision addresses N1–N5 from round 2 at `9f589355a`, following the
seven round-1 fixes. Both runtime profiles are byte-identical. Neither
`flows.json` was edited.

Startup after updating from main: READY at `7725a09f2b`, based on `origin/main`
`bda200db62`, behind 0 / ahead 2. AGENTS.md revision: `c63103827f`. Main added
Pi 4 acceptance, codec helpers and atomic Node-RED startup writes; the rebase
was clean, with both existing patches unchanged in `git range-diff`.

## Round-5 finding and fix (head `5a7723ca` → this revision)

Round 5 (Sol): one P1. The discovery subquery applied the exact `strftime`
instant predicate before `LIMIT`, so rows in the lexical date margin that the
predicate rejects took no allowance. A dense margin could force a long indexed
scan with `maxWorkRows: 1` and then succeed without a charge (300,000
one-second CLOVER rows, daily export of 2025-01-05: 40,800 margin rows).

Fix, as Sol suggested: the inner query selects `recorded_at` and the candidate
columns by the lexical index range only (`deveui = ? AND recorded_at >= ? AND
recorded_at < ?`) with `LIMIT remaining+1`, so `COUNT(*)` caps and charges
every lexical candidate. A middle query computes `in_range` from the exact
instant bounds, and the outer `MAX(in_range AND col IS NOT NULL)` decides
presence. Measurement reads are unchanged: they keep the exact predicate and
charge the rows they fetch. Nothing else changed.

New test `discovery charges and caps lexical date-margin rows in both builders`
(per-zone and all-zones; 1,000 CLOVER rows on 2025-01-04, export of
2025-01-05):
- `maxWorkRows: 1`: one query (`LIMIT 2`), `candidate_rows` 2, refused with
  `EXPORT_INPUT_TOO_LARGE`;
- `maxWorkRows: 2000`: succeeds with no rows, `candidate_rows` 1,000 charged,
  `swt_1` presence 0;
- the charge is exact: 999 refuses, 1,000 succeeds.
It fails against the round-5 helper (0/1). The round-4 dense test's SQL pin now
expects the three-level query.

Round-5 checks (local, this revision): source guards 20/20; ordinary suite
(`--max-old-space-size=192`) 34/34; source-v2 68/68; helper `index.test.js`
45/45 and router 76/0 on each profile; export triad and recorded-at formats
108/108; vectors 4/4; `test-history-helper.js` PASS; `verify-sync-flow.js`
rc 0; test inventory, profile parity (helper byte-identical), silent-catch
and doc hygiene OK; reviewer probes 1, 2, 4–9 unchanged (probe9 8/168/8).

Round time: authoring and focused gates 14:19–14:22 UTC, serial `test-history-helper.js` and `verify-sync-flow.js` to 14:43 UTC (about 24 minutes before push). The CI wait is in a PR comment, so the head does not change after CI.

## Round-4 finding and fix (head `ffa7b612` → this revision)

Round 4 (Sol): one P1. Column discovery for card-wide devices ran before the
per-zone budget and the all-zones bucket preflight, was not charged to the
work allowance, and probed every card column regardless of the requested
channels (892 ms on a 300,000-row CLOVER before a 413).

| Part | Fix |
|---|---|
| Filter first | New `exportCandidateChannels` applies the requested-channel filter, LoRain-only rain tips and SWT3 eligibility. Discovery and `exportChannelsForDevice` both start from it, so discovery probes only columns the request can return. |
| Order | Per-zone: range check, budget, windows, output preflight, then discovery. All-zones: every zone is resolved and preflighted first; discovery runs in a second loop. Nightly: unchanged, one local day, no budget. |
| Bound and charge | Discovery is `SELECT COUNT(*), MAX(col IS NOT NULL)… FROM (SELECT cols … LIMIT remaining+1)`, where `remaining` is the shared work allowance in rows and cells. Candidate rows are charged to it, and an overflow refuses with the existing `EXPORT_INPUT_TOO_LARGE`. |
| Preflight | A card-wide device emits measured rows only (round 3), so the output preflight reserves no empty cells for it. Its rows are still charged to the output budget as they are produced. Counting its candidate channels instead would have refused a ten-year daily export of two CLOVERs. |

Decision: I bound discovery by the work allowance, not the per-read sentinel.
A 30,000-row sentinel over the whole range would refuse a year of 15-minute
CLOVER data in a daily export, which main serves. With the narrow column list,
the reviewer's dense case now scans only `swt_1`/`swt_wm1`, and the 300,000
candidate rows count against the 5,000,000-row allowance.

New test `dense fallback discovery is filtered, preflighted and bounded in both
builders` (per-zone and all-zones, 1,000 one-minute CLOVER rows):
- an output-preflight refusal issues no `device_data` query;
- with `maxWorkRows: 400`, the only query is discovery over `swt_1, swt_wm1`
  with `LIMIT 401`, using `idx_device_data_deveui_recorded_at`, then a 413;
- with `maxWorkRows: 1500`, the export is refused after discovery charged 1,000
  rows, and with 2,000 it succeeds with two rows.
Against the round-4 helper this test fails (0/1). The projection test now
recognises the discovery query by its `candidate_rows` column.

Round-4 checks (local, this revision):

| Command | Result |
|---|---|
| `scripts/test-history-source-guards.js` | 20/20 |
| `scripts/test-history-export-ordinary.js` (`--max-old-space-size=192`) | 32/32 |
| `scripts/test-history-source-v2.js` | 68/68 |
| helper `index.test.js`, each profile | 45/45 |
| router `index.test.js`, each profile | 76/0 |
| export triad + recorded-at formats (`--max-old-space-size=192`) | 108/108 |
| `scripts/test-history-helper.js` | PASS, rc 0 (final tree) |
| `capture-history-router-vectors.js --verify` | 4/4 |
| `verify-sync-flow.js` (direct, alone) | rc 0, all parity checks passed (1,581 s) |
| `verify-test-inventory`, `verify-profile-parity`, silent-catch, doc hygiene | OK; helper byte-identical across profiles |
| Reviewer probes 1, 2, 4–9 | Same as round 4 (probe9 8/168/8) |

Round time: authoring and focused tests 12:41–12:45 UTC, then serial `test-history-helper.js` and `verify-sync-flow.js` to 13:23 UTC (about 42 minutes before push). The CI wait on the pushed head is recorded in a PR comment, so this file does not change the head after CI.

## Round-3 findings and fixes (head `29c4554d` → this revision)

Startup: the worktree readiness file (mode start, 11:40 UTC) reports
MISMATCH: STALE_BASE and INSTRUCTIONS_STALE for the worktree's original branch
at `1a984f31f`, 17 behind `origin/main` `382c63a91`. Intended: this is a review
fix on the existing PR branch. The branch is checked out in another worktree,
so this revision was built on a local branch at
`origin/fix/eb12-history-export-bounds` (`29c4554d`, 3 behind / 5 ahead of
`origin/main` before this commit) and pushed to that branch with a normal
push; no rebase. AGENTS.md blob `2dd8013b` (last change `c63103827`) matches
base. The stale instruction file is a live-ops skill reference this PR does
not use.

| Finding | Fix |
|---|---|
| R3-1: TEKTELIC_CLOVER soil rows dropped from every export path | `exportChannelsForDevice` now follows the interactive rule (`deviceFamilySupportsChannel`): a device without a type, or whose type has no family for the card, keeps the card-wide list. A new `resolveExportFieldPresence` runs one `MAX(col IS NOT NULL)` scan per such device during scope resolution and narrows its projection to the columns it stored, so ~50 null soil columns do not shrink the per-read sentinel. The nightly writer, per-zone and all-zones paths share it. |
| R3-2: required `migrations` check red (blank `rain_tips_delta` for an ambient-only S2120) | Root cause: blanks keyed on the projection-wide `bucket.sampleCount`. Daily blanks now require that the device stored no row at all that local day (any `device_data` row counts, even one with none of the requested channels), and only for channels its type's family lists. Main's `rain_tips_delta` LoRain-only rule is restored as a second layer. With the rain rule removed, the blank rule alone turns the guard suite green (checked, then reverted). The guard test is unchanged. |

Decisions:
- Card-wide fallback plus a presence scan, not a new CLOVER soil family.
  `describeDeviceSource` also feeds Analysis (`analysis.js` returns no soil
  channels for CLOVER by design), so a family entry would change another
  surface. The CLOVER flow writes `swt_wm1/2` and `swt_1/2`; the vendor soil
  module (#709) is not wired yet, and card-wide keeps whatever it writes later.
- Devices without a type or family emit no blank rows (main's rule). Typed
  devices with a family keep the round-2 empty-day blanks.
- The presence scan is not charged to the work budget: it fetches one row per
  device and holds nothing in memory. It runs after the range refusal in all
  three callers (per-zone, all-zones, nightly), never inside the scope
  resolver, so an over-range request reads no `device_data` before its 413
  (new traced test).

Red then green (both profiles):
- Old helper (`29c4554d`) with the new tests: ordinary suite 22/28, failing
  the projection test, the new CLOVER test (probe9) and the new blank-rule
  test; source guards 18/20. New helper: ordinary 30/30, source guards 20/20.
- The over-range test fails against a helper that scans inside the resolver
  (0/1) and passes on this revision.
- Reviewer probes against this tree, same results as round 3: probe1 all OK
  (730/1098/1656/4308/246/18), probe2 nightly 36 records / 4,220 bytes and
  past-8-MiB write OK, probe4 112/224/480/240, probe5 4 rows, probe5b blanks on
  the empty day only, probe6 DST/Apia/encodings/BOM 1, probe7 6 cells/day,
  probe8 dense sources refused at 30,001 under 192 MiB, probe9 8/168/8.
- `plan-0.9/glm-702/probe9.js` against this tree: daily 8, raw 168, all-zones
  8, as main.
- `scripts/test-history-export-ordinary.js` projection test: CLOVER's row
  fetch now selects only `swt_1/swt_wm1/swt_2/swt_wm2`. The old `permitted=0`
  pin for CLOVER, which encoded the drop, now expects the two SWT channels.

Round-3 checks (local, this revision):

| Command | Result |
|---|---|
| `node scripts/test-history-source-guards.js` | 20/20 (both profiles) |
| `node --max-old-space-size=192 --test --test-concurrency=1 scripts/test-history-export-ordinary.js` | 30/30 |
| `node --test scripts/test-history-source-v2.js` | 68/68 |
| `node --test osi-history-helper/index.test.js` (both profiles) | 45/45 each |
| `node osi-history-router/index.test.js` (both profiles) | 76/0 each |
| export triad + `test-history-recorded-at-formats.js` (`--max-old-space-size=192`) | 108/108 |
| `scripts/test-history-helper.js` | PASS, rc 0 (996 s; final tree) |
| `scripts/capture-history-router-vectors.js --verify` | 4/4 routes PASS; golden vector unchanged |
| `node scripts/verify-test-inventory.js` | OK (1024 files) |
| `node scripts/verify-profile-parity.js` | all passed; helper and router `cmp`-identical across profiles |
| `node scripts/verify-sync-flow.js` | rc 0, all parity checks passed (1,045 s; run directly, alone) |
| `node scripts/verify-doc-hygiene.js` | OK |
| `verify-no-new-silent-catch`, `verify-history-api-contract`, `git diff --check` | baseline 65/314; OK; clean |

Not run locally: osi-heavy and full CI suites (the gate-904491b1 proof chain
had no PROOF_END, so osi-heavy stayed free for it). CI on the pushed head is
the gate.

Round time: about 50 minutes: authoring and focused tests 11:40–12:00 UTC, then serial `test-history-helper.js` (17 min) and `verify-sync-flow.js` (17 min) to 12:28 UTC. CI wait is in the PR comment after push.

## Round-2 findings and fixes

| Finding | Fix |
|---|---|
| N1: ordinary exports hit a request-sized memory allowance | Filter projections and preflight cells by each device's declared family. Keep 30,000 rows / 200,000 fields per source-window, and use separate request work ceilings of 5,000,000 rows / 40,000,000 cells. Reuse date-margin rows between adjacent windows; the SQL lower bound advances past the previous read. |
| N2: impossible daily blank channels | Emit only supported channels. A sampled day keeps main's measured rows; a wholly empty day gets blanks for supported channels, with no pF invented for a missing value. |
| N3: nightly files stop at 8 MiB | Request budgets are installed only by HTTP builders. Nightly raw/hourly output and daily history have no request caps. Stream complete old CSV records to an atomic daily replacement; raw/hourly updates finish first. |
| N4: heap option rejected by inventory | Recognize positive `--max-old-space-size=<n>` and test collection of direct node test files; malformed values remain rejected. |
| N5: forced index makes exports brittle | Remove `INDEXED BY`. Assert the normal DB uses the composite index without a temporary sort, and the same export works when that index is absent. |

The work ceiling is sized from reporting cadence and the permitted daily range:
four five-minute sources over 3,660 dates produce 4,216,320 samples. Five million
rows leaves margin; forty million fields allows their five selected tension and
legacy-alias fields. This is a data-derived work bound, not measured Pi latency.
No gateway or live host was used.

The new DB acceptance cases cover four sensors / 14 days (Analysis default),
four sensors / 92 days, a three-sensor season, one sensor / year, and a five-minute
Chameleon / four months, all channels. Separate cases pin one charge per margin
row, request-work overflow, unsupported fields and natural/fallback query plans.
Nightly fixtures rewrite more than 8 MiB and 200,000 records, write raw/hourly
files above 8 MiB despite lowered request options, and preserve raw/hourly files
when old daily history has malformed quoting.

The new acceptance file runs in the dedicated History Router workflow under
192 MiB old space, separately from the long migration job. Test inventory
recognizes that invocation. The existing golden CSV fixture now excludes twelve
SWT3/pF rows from a KIWI without Chameleon; its other 72 rows match CI output
byte for byte. The mixed-device helper fixture preserves all three SWT1 values
and expects SWT3 only from Chameleon, rather than an unsupported SDI-12 layout.

The existing dense/null-heavy per-read sentinels and cross-source work checks
remain. The latter now lower `maxWorkRows`, rather than the per-read ceiling.
The LoRain fixture now omits rate channels its declared family cannot report;
interval totals and latest counters stay pinned.

## Round-2 verification

The targeted inventory regression was red before the parser fix (exit 1, one
failed test). After the fix it passed: `# tests 1`, `# pass 1`, `# fail 0`.

`node scripts/verify-test-inventory.js` now exits 0:
`verify-test-inventory: OK (1024 test files: 841 run by workflow steps, 11 run through a listed runner, 172 excluded with a reason; 344 steps in 16 workflows)`.
Profile parity and the history API contract pass. `git diff --check` passes.

First exact-head CI at `77ad28c54e` passed test inventory and exposed two old
fixture assumptions: KIWI without Chameleon and SDI-12 both expected unsupported
SWT3. Those pins are corrected as described above; full CI must qualify the
follow-up head.

The focused SQLite/CSV red-then-green run is queued through `osi-heavy`, with
192 MiB old space and serial test files. A live firmware build has held the
single slot since 08:53 UTC, so these tests have not started yet. The red run
uses a saved pre-fix helper; the green run uses this checkout. Results will be
recorded before handoff if the slot becomes available. No full local suite was
queued. Exact-head GitHub CI is the gate for the full suites.

## Round-1 fixes and prior-head evidence


| Finding | Fix and evidence |
|---|---|
| P1: dense in-range reads can allocate without a bound | Per-source indexed reads use SQL `LIMIT remaining + 1`, with per-read ceilings of 30,000 candidate rows and 200,000 selected input cells plus a separate request-work ceiling. Dense, null-heavy and multi-source DB tests assert returned counts, remaining allowances and index query plans without a temporary sort. Output channel/pF expansion is charged before retention. |
| P2: labels can defeat row-only memory estimates | An 8 MiB ceiling counts actual escaped UTF-8, BOM, header and newlines. Checks precede retention of rows or serialized chunks; serializers independently enforce the same ceiling. |
| P2: late all-zone preflight | Resolve every authorized scope and preflight the combined aggregate budget before the first measurement query. An over-budget two-zone fixture asserts zero such queries. |
| P2: fractional-DST hourly undercount | Sum rounded-up bucket counts for the actual month windows and reuse those windows when aggregating. Two empty sources across Lord Howe's half-hour changes accept exactly 20,548 potential cells and refuse one fewer. |
| P2: stable reasons on the wire | Define range, output, input, byte and busy codes in `EXPORT_REASON_CODES`. The portable route and shared `historyExportErrorResponse` formatter preserve codes; busy retains `Retry-After: 30`. Real HTTP fixtures pin JSON refusals without an attachment. |
| P3: skipped local date borrows preceding data | Map an absent local date to the next existing boundary. A skipped-day-only request is empty, with no measurement query, for every granularity and both builders. The spanning range retains only existing days. |
| P3: multiline daily rewrite corruption | Read complete quoted CSV records, preserve escaped fields and numeric tokens, and replace by zone-local timestamp date. A BOM-less historical file with quoted newlines survives two rewrites without stray rows or duplicate BOMs. |

The input cell allowance counts selected SQL fields, including legacy aliases.
Indexed lexical date margins also consume work before exact instant filtering.
The reader therefore bounds sparse selections and dense candidates outside the
exact instant interval. Overflow is an error, never a partial successful export.

The output budget counts a raw reading's full expansion before keeping any row.
Aggregate output yields small channel/pF groups into the same checked retention
path. A byte ceiling supplements the existing 200,000-row/cell ceiling. The
inclusive day limits remain 92 raw, 730 hourly and 3,660 daily days.

## Red and green evidence

Before implementation, all 26 initial review cases failed on both profiles.
The separate accepted-wide-label/one-over qualification also failed 2/2: the old
implementation accepted the file exceeding the proposed byte ceiling. Tests now
cover the same defects with bounded SQL results and explicit refusal codes.

Older tests were updated where the intended contract changes: a 30,001-sample
month now refuses with `EXPORT_INPUT_TOO_LARGE`; the large accepted fixture uses
a 30-day selected-channel export within all independent limits. Its later-zone
assertion checks measurement reads rather than the newly required metadata
preflight. Monthly query assertions now inspect indexed lexical date margins.
The existing measured CSV hashes were retained.

The local commands below passed on the previous round-1 head, not this revision. SQLite-backed focused checks ran serially
under `osi-heavy wait --contain --scratch-tmpfs 1G --need-gib 8`.

| Command | Observed result |
|---|---|
| `node --max-old-space-size=192 --test --test-concurrency=1 scripts/test-history-export-review.js scripts/test-history-export-bounds.js scripts/test-history-all-zones-export.js` | `# tests 81`, `# pass 81`, `# fail 0` |
| `node --test --test-concurrency=1 --test-name-pattern='export' scripts/test-history-recorded-at-formats.js scripts/test-history-source-v2.js` | 18 tests, 18 pass, 0 fail |
| `node --max-old-space-size=192 --test --test-name-pattern='accepted maximum-width' scripts/test-history-export-review.js` | 2 tests, 2 pass, 0 fail |
| `node --test --test-name-pattern='toCsv\|zone export\|javaDoubleText\|javaPlainDecimalText' conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.test.js` | 6 tests, 6 pass, 0 fail |
| `node conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-router/index.test.js` | 76 passed, 0 failed |
| `node scripts/verify-profile-parity.js` | `All parity checks passed.` |
| `node scripts/verify-history-api-contract.js` | `verify-history-api-contract: OK` |
| `node scripts/verify-no-new-silent-catch.js` | OK; 65 empty catches per profile, unchanged |
| `node scripts/flows-bare-require-scan.js` | Exit 0 |
| `node scripts/verify-doc-hygiene.js` | OK; built-in patterns only |
| `node .claude/skills/anti-slop-writing/slop-check.js execution-report.md docs/operations/history-csv-exports.md` | PASS, no tier-1 findings |
| `git diff --check` | Exit 0 |

The accepted wide-label fixture produced 9,310 rows and 8,388,408 UTF-8 bytes,
200 bytes below the 8 MiB ceiling. One additional sample was refused. Both
profiles passed with `--max-old-space-size=192`. Observed peak process RSS was
137,064 KiB for the first profile and 158,952 KiB after the second; these are host
fixture measurements, not target-Pi or Excel qualification.

Full sync, GUI, migration, smoke and shell suites are CI gates on each exact
head. They were not queued locally in this revision. CI results for the previous
reviewed SHA do not qualify this revision; the PR body records the new head and
its CI state after push.

## Remaining reserved work

The detailed handoff is in
[History CSV export bounds and encoding](docs/operations/history-csv-exports.md).
After EB2 and a reservation grant, load the same `osiLib` router singleton for
the per-zone build, send its serialized CSV, and forward the shared error
formatter's status, payload and headers. Update the old helper-call contract
assertions and test simultaneous requests through the shipped flow.

The current portable route emits stable codes. The shipped per-zone route still
needs code/header forwarding and the shared slot. Its focused HTTP fixture uses
a prepared adapter; it does not claim that reserved wiring has landed. The GUI
batch must reuse Blob error decoding and map the module's codes to i18n strings.
No GUI, locale, schema, deploy pin or server file changed. No live host was used.
