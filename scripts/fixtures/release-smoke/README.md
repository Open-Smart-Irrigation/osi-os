# Release runtime smoke

This suite starts the shipped flows in Node-RED and drives their HTTP API.
A green PR result permits only the exact failures in `known-failures.json`.
It does not permit a release while that list has entries.

From the repository root, with Node 22 and the `sqlite3` CLI installed
(on the maintainer workstation, run suites serially through `osi-heavy` and
set `TMPDIR` to a disk-backed scratch directory):

```bash
npm ci --prefix scripts/fixtures/release-smoke --no-audit --no-fund
node --test --test-concurrency=2 scripts/test-release-smoke-policy.js
node scripts/test-release-smoke.js
node scripts/test-release-smoke.js --release
```

`--strict` is an alias for the release policy and reproduces the failing
release verdict on the withdrawn baseline. The runner prints its evidence
directory: `results.json` contains assertions and observations, `runtime.log`
contains each completed case, and `seed.log` records the seed/migration build.
GitHub retains these logs and the summary as an artifact for seven days.

## What runs

The runner checks the Node-RED version against the image feed Makefile,
then builds a new scratch database with `scripts/build-seed-db.js --out`.
That script calls the repository migration runner's `bootstrapFresh` and
`verifyHead`. It never replaces a bundled database. One Node-RED process
runs at a time (with a two-thread libuv pool), using the native npm `sqlite3` binding and the image settings'
`os`, `fs`, `cp` global names. No `crypto`, `require`, or browser globals are
added to the function sandbox.

Fixture setup and assertions use that same native SQLite binding asynchronously.
Do not load `node:sqlite` into the runtime process: two SQLite libraries keep
separate lock bookkeeping and can interfere with POSIX locks
([SQLite's explanation](https://www.sqlite.org/howtocorrupt.html#multiple_copies_of_sqlite_linked_into_the_same_application)).
The hosted runner exposed that mistake in the initial harness; the final
integrity case checks the database after all scenarios.

The flow file, function bodies, wires, inject schedules and helper files are
copied unchanged. The suite checks their bytes again after execution. Before
boot it also compares both maintained image profiles, including every file
under `usr/share/node-red`, rather than only a hardcoded helper list.

Outer boundaries are local:

- The real ChirpStack helper calls a gRPC DeviceService stand-in. It records
  enqueue bytes, ports and expiry, and implements queue reads and flushes.
- A local MQTT broker carries synthetic LoRaWAN reports through the shipped
  MQTT input nodes. Radio event adapters pass through decoded events; the
  field-tester adapter drops events because field testing is outside this suite.
- The same broker is the cloud MQTT stand-in. The database is unlinked; this
  suite does not exercise authenticated cloud sync or pending cloud commands.
- Image filesystem paths map into the scratch directory. The NTP marker
  represents this boot, or is deliberately absent. Shell operations are refused.
  Outbound sockets and DNS beyond loopback are refused and fail a case.

HTTP mutations use a token obtained through registration and login. SQL sets
up discovered/claimed devices and isolates prerequisites when a broken save
route would otherwise prevent testing the scheduler. SQL also translates
synthetic persisted timestamps together to represent three days without a
valve report. Weekly plan tests move the pending-edit timestamp past debounce
and fire the shipped clock worker. The runtime clock and product code stay
unchanged. These are accelerated persistence scenarios, not elapsed-time or
hardware qualification tests.

## Assertions

| Cases | A defect is present when |
|---|---|
| Login and populated device, zone and valve lists | Registration/login fails, a saved fixture is absent from its list, or a read reaches the radio. |
| Eight accepted valve commands | HTTP is not 202, the stored action is wrong/missing, or the exact port/frame differs. Each command uses a fresh motorized valve. |
| Eight refused commands and invalid opens | A sensor is accepted as a valve, an invalid open is accepted, or refusal changes the device/log or sends a frame. |
| Open, OPEN report, CLOSED report, open again | Reports do not update state/settle the stored expectation, another open fails, or the second frame is missing. |
| Lost reports, with and without the NTP marker | A three-day-old unresolved command still prevents a later open or its stored expectation. |
| Reports without the NTP marker | CLOSED remains OPEN, close evidence is absent, or the next open is blocked. |
| Timed close and flushing, followed by an open | A CLOSED report after three days still leaves the later open fenced. |
| Safety close without the NTP marker | The close fails, is not stored/sent, or carries a queue expiry. |
| Assign/remove device, delete device/zone | The route fails or the requested assignment, unclaim or tombstone is absent. No radio frame is expected. |
| Weekly save/change/delete | HTTP or stored rows disagree, or any of the seven complete daily plan frames and status frame differs. Deletion must send empty plans. |
| Threshold scheduler tick | Saving fails, a fresh 60 kPa reading against 30 kPa does not produce a stored irrigation and 15-minute open, or the history route fails. |
| Every enabled HTTP route without a token | The request hangs, returns 5xx/success on a protected route, mutates devices/zones/schedules, or reaches ChirpStack. |
| Startup | A function node logs an error, another node logs an unlisted error, or flows wait for missing node types. |

`GET /api/catalog` and `GET /api/system/features` are intentionally public;
OPTIONS may return a CORS success or a bounded client error. Empty login and
registration requests must return client errors. These exceptions are explicit.
The eight valve schedule/settings routes are included in the unauthenticated
sweep (F-15); arbitrary internal exceptions are not injected into their code.
The suite does not prove a catch boundary for every possible future throw.

## Failure policy

The three totals are `passed`, `failed`, and `known-to-fail`. An unlisted
failure, an additional assertion failure, a changed HTTP status/error or radio
frame, a missing listed case, and an unexpectedly passing listed case all
produce exit 1. Harness/setup exceptions produce exit 2 and cannot be listed.
Each listed case must name exactly one finding. The policy's own tests
exercise these branches. Volatile timestamps and queue
UUIDs do not define a failure signature; HTTP status/error, stored state and
radio bytes do.

When a fix merges, run the suite and remove or narrow only the corresponding
entries after inspecting the observations. Do not regenerate the list from
all failures. New defects need a finding ID (`NEW-n`) and a reproducing case.
The baseline list below was reviewed against the withdrawn release findings;
no additional product defect was identified by this suite.

The exact new check name for the main branch ruleset is
`release-runtime-smoke` (workflow: `Release Runtime Smoke`). Adding that name
is a maintainer action. This change does not edit the ruleset or rename an
existing required check. Manual workflow dispatches and `v*` tag runs enforce
the empty-list gate after the suite; the release procedure also runs
`node scripts/test-release-smoke.js --release` before tagging or publishing.

## Known to fail on the baseline

On payload baseline `88f6e84bb`, strict mode reports 199 passed, 0 unexpected
failures and 9 known failing cases, then exits 1. The original list had 26
entries. The untouched-list run proved 17 cases now pass before those entries
were removed; six other entries lost their obsolete HTTP-timeout allowances.
See [the per-case mapping and stage-1 assessment](baseline-mapping-88f6e84bb.md)
for each merged fix, the single finding behind every remaining case, and the
assertions that need changing or strengthening for stage 1. Scenario assertions
are unchanged in this update.

The checked-in output is `baseline-88f6e84bb.txt`. Each line below names one
remaining case; the JSON file carries its exact signatures.

- F-14: `startup-node-errors`.

- F-1: `open-no-report-open-later`.

- F-2: `no-clock-open-report-close-open`.

- F-1: `no-clock-open-no-report-open-later`.

- F-4: `open-after:close-duration`.

- F-4: `open-after:timed-close`.

- F-4: `open-after:flushing`.

- F-13: `no-token:POST /api/account-link`.

- F-13: `no-token:POST /api/sync/force`.
