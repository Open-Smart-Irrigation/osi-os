# EB12 review fixes

This revision addresses the seven findings from the review of `365d290a3`.
Input materialization, encoded CSV bytes and aggregate cells now have separate
limits enforced before retaining the corresponding work. Both runtime profiles
are byte-identical. Neither `flows.json` was edited.

Startup for this revision: READY at `5115b35b7`, based on `origin/main`
`1a984f31f`, behind 0 / ahead 1. AGENTS.md revision: `c63103827`. The branch was
rebased from the reviewed head onto a runbook-only main change before edits.

## Findings and fixes

| Finding | Fix and evidence |
|---|---|
| P1: dense in-range reads can allocate without a bound | Per-source indexed reads use SQL `LIMIT remaining + 1`, with a request-wide ceiling of 30,000 candidate rows and 200,000 selected input cells. Dense, null-heavy and multi-source DB tests assert returned counts, remaining allowances and index query plans without a temporary sort. Output channel/pF expansion is charged before retention. |
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

Every local command below exited 0. SQLite-backed focused checks ran serially
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

Full sync, GUI, migration, smoke and shell suites are CI gates on the new exact
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
