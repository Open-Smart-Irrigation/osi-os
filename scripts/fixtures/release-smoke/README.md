# Release runtime smoke

This suite starts the shipped flows in Node-RED and drives their HTTP API.
A green PR result permits only the exact failures in `known-failures.json`.
It does not permit a release while either deployed runtime's list has entries.

From the repository root, with the Node version pinned in the workflow
and the `sqlite3` CLI installed (run suites serially through the campaign's
resource wrapper and set `TMPDIR` to your assigned scratch directory):

```bash
npm ci --prefix scripts/fixtures/release-smoke --no-audit --no-fund
node --test --test-concurrency=2 scripts/test-release-smoke-policy.js
node scripts/test-release-smoke-controls.js
node scripts/test-release-smoke.js
npm ci --prefix scripts/fixtures/release-smoke-stock --omit=dev --no-audit --no-fund
node scripts/test-release-smoke.js --runtime=stock
node scripts/test-release-smoke-controls.js --runtime=stock
node scripts/test-release-smoke.js --release
```

`--strict` is an alias for the release policy and reproduces the failing
release verdict on the withdrawn baseline. The runner prints its evidence
directory: `results.json` contains assertions and observations, `runtime.log`
contains each completed case, and `seed.log` records the seed/migration build.
GitHub retains these logs and the summary as an artifact for seven days.

## Two deployed runtimes

The shared version declarations are the three workflow-level `OSI_SMOKE_*_VERSION`
keys in `.github/workflows/release-smoke.yml`. Both jobs and the runner read them.
The runner checks the selected Node-RED manifest, lock and installed version
against its key, and checks the process Node version before starting.

The default image job remains `release-runtime-smoke` (Node-RED 3.1.15).
`release-stock-runtime-smoke` adds Node-RED 4.0.9 under the same Node 20.18.3
without changing the ruleset. Its separate firmware fixture contains no
SQLite package. Before network fencing, the runner copies the shipped user
manifest, lock and local helpers into its fresh user directory and runs the
same `npm install --omit=dev --no-fund --no-audit` as `deploy.sh`. It rejects
any changed locked version or added unlocked package. On the measured clean
install this resolves SQLite node 1.1.1 and sqlite3 5.1.7; npm honors the lock.
Every runtime run repeats that install and records its log.

Both layouts record resolved package versions and the actual mapped native
addon in `results.json`. The stock run requires that one addon to reside in
its user directory, with no firmware SQLite. The field-tester package is
installed from the deploy lock but excluded from palette discovery because
the suite uses the same outer field-tester stand-in in both runtimes.
No product function, helper, wiring or function sandbox is replaced.

The [211-case comparison](../release-smoke-stock/baseline-23bfda61e.md) on main baseline
`23bfda61e` reports 200 passes and the same 11 exact known failures on each
runtime, with no differing case or failure signature. Runs took 27.5 seconds
(image) and 28.2 seconds (stock), excluding dependency installation and seed
construction. The stock list is `../release-smoke-stock/known-failures.json`; its findings
and exact symptoms match the image list at that baseline.

| Flow dependency | Image fixture | Stock user install |
| --- | --- | --- |
| SQLite node / sqlite3 | 1.1.1 / 5.1.7 | 1.1.1 / 5.1.7 |
| ChirpStack API / gRPC | 4.12.1 / 1.14.3 | 4.12.1 / 1.14.3 |
| bcryptjs / google-protobuf | 3.0.3 / 3.21.4 | 3.0.3 / 3.21.4 |
| protobufjs / proto-loader | 7.6.6 / 0.8.1 | 7.5.4 / 0.8.0 |
| Node-RED MQTT node's client | 4.3.7 | 5.7.0 |
| Node-RED HTTP node's got | 12.6.0 | 12.6.1 |

The HTTP parser (1.20.3), cronosjs (1.7.1) and WebSocket module (7.5.10)
resolve identically. The ChirpStack API 4.12.1 client against the stock
base's ChirpStack 4.16.2 server remains a builder/device compatibility
question; these tests use the local DeviceService stand-in.

Comparing both `10-function.js` files finds no removed, renamed or added
top-level sandbox name or function wrapper binding. The 4.0.9 code wraps
`RED.util.getSetting` to bind the requesting node; no shipped function uses
that method. The allowed-name list in `verify-flows-sandbox.js` therefore
needs no change. Node-RED 4 also replaces `util.isArray` with `Array.isArray`;
that does not add a function global.

`--strict`, `--release` and the release-list gate refuse any nonempty list
across **both** runtimes, even if the selected runtime's own list is empty.
A tag run is red while the stock list has entries. Ordinary PR/branch runs
permit only each runtime's exact listed failures. Releases must wait for
both jobs on the release commit and on the tag; an optional ruleset check
is not a release waiver. A missing or unreadable runtime list fails closed.

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
copied unchanged in ordinary runs. The suite checks their bytes again after execution.
After the first 2.5 seconds of normal boot initialization, the harness pauses
inject timer handles. Before the final checks it fires every enabled inject
once through the real inject node, including delayed, repeat-only, cron-only
and manual injects. Each must deliver to all its loaded wired targets. It
waits for function completions, observed native SQLite callbacks and 250 ms
without message activity, with a 15-second bound per inject. A timeout is an
infrastructure failure. `results.json` records every inject and recipient.
This covers one invocation against these fixtures; it does not prove all
future timer callbacks, scheduled wall-clock ordering or every data branch.

Node-RED hooks record every catch-node delivery before the catch flow can
turn it into a warning. Exact expected refusals in `expected-refusals.json`
name the scenario, source node, source type and full message. Other caught
errors fail the final check, apart from the exact F-7 scheduler errors that
are already asserted by their own case. Every error-level log is also
checked after the sweep, whether or not its node is a function. Before
boot it also compares both maintained image profiles, including every file
under `usr/share/node-red`, rather than only a hardcoded helper list.

The fixture lock supplies third-party modules rather than the image's
vendored dependency tree. The direct versions agree for SQLite, bcryptjs,
gRPC, ChirpStack API and protobuf; transitive versions can differ (for
example protobufjs 7.6.6 here versus 7.5.4 in the baseline image, and
proto-loader 0.8.1 versus 0.8.0). Scratch helper dependencies are discovered
from directories rather than the shipped package manifest. Runtime module
installation is disabled; GUI static serving and provisioned credential
encryption are not exercised. Matching flow/helper bytes and the Node-RED
version does not establish image dependency, packaging or native ABI parity.

Outer boundaries are local:

- The real ChirpStack helper calls a gRPC DeviceService stand-in. It records
  enqueue bytes, ports and expiry, and implements queue reads and flushes.
- A local MQTT broker carries synthetic LoRaWAN reports through the shipped
  MQTT input nodes. Radio event adapters pass through decoded events; the
  field-tester adapter drops events because field testing is outside this suite.
- A loopback OpenAgri HTTP stand-in supplies 24 synthetic weather hours
  (5.4 mm rain and weather VPD) to the dendrometer transport case.
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
| Lost reports, with and without the NTP marker | A later open is refused: after three days, or at once with no ageing, report or monitor tick (a third open too). The valve's complete call list at the radio stand-in differs from one expiry-free `2/4101` per open with no flush, or the records are not one per commanded open with its own command id and 60 seconds. |
| Reports without the NTP marker | The last accepted report is not shown (OPEN, then CLOSED), the next open is refused, a record without a command exists although the reports belong to one open, the first open does not carry both reports as untrusted evidence, or it has an observed time or a completed state. A third open after the marker returns must be accepted and leave the earlier records as they are. |
| Timed close and flushing, followed by an open | The open is refused: after three days and a CLOSED report, or at once behind the service command. The call list differs from the service frame followed by one expiry-free `2/4101` with no flush between, or the open has no record of its own. |
| Safety close without the NTP marker | The close fails, is not stored/sent, or carries a queue expiry. |
| Assign/remove device, delete device/zone | The route fails or the requested assignment, unclaim or tombstone is absent. No radio frame is expected. |
| Weekly save/change/delete | HTTP or stored rows disagree, or any of the seven complete daily plan frames and status frame differs. Deletion must send empty plans. |
| Threshold scheduler tick with a competing writer | Saving fails, the exact 15-minute frame is absent, either irrigation event or last-triggered timestamp is missing, a write reports an error, or the history route fails. One native SQLite transaction holds the writer lock until both old SQLite nodes report BUSY or 2.5 seconds elapse, then releases it once. Product writes are never retried. |
| Every enabled HTTP route without a token | The request hangs, returns 5xx/success on a protected route, mutates devices/zones/schedules, or reaches ChirpStack. |
| Boot and enabled inject sweep | An inject misses its targets, flows do not settle, an unlisted caught error or error-level log appears, or flows wait for missing node types. |
| Dendrometer weather transport | The populated dendro zone logs a weather warning or does not persist the synthetic provider rain and VPD source. |

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
exercise these branches. The two serial runtime negative controls prepend an
undeclared identifier to the scratch copy of a 35-second handler and to a
handler on a catch-all tab. Each must exit 1 specifically through the
corresponding error check; failing only an HTTP or byte-integrity assertion
does not satisfy the control. Volatile timestamps and queue
UUIDs do not define a failure signature; HTTP status/error, stored state and
radio bytes do.

When a fix merges, run the suite and remove or narrow only the corresponding
entries after inspecting the observations. Do not regenerate the list from
all failures. New defects need a finding ID (`NEW-n`) and a reproducing case.
The baseline list below was reviewed against the withdrawn release findings;
the expanded sweep additionally reproduces the already tracked NEW-1, and
the controlled writer lock reproduces F-7.

The exact new check name for the main branch ruleset is
`release-runtime-smoke` (workflow: `Release Runtime Smoke`). Adding that name
is a maintainer action. This change does not edit the ruleset or rename an
existing required check. Manual workflow dispatches and `v*` tag runs enforce
the empty-list gate after the suite; the release procedure also runs
`node scripts/test-release-smoke.js --release` before tagging or publishing.
A manual strict hosted run of both runtime jobs must succeed on the exact release merge SHA
before tag creation, and the tag's own run must succeed before image builds;
see [the release procedure](../../../docs/versioning-workflow.md).

## Known to fail on the baseline

On payload baseline `88f6e84bb`, strict mode reports 200 passed, 0 unexpected
failures and 11 known failing cases, then exits 1. The original list had 26
entries. The untouched-list run proved 17 cases now pass before those entries
were removed; six other entries lost their obsolete HTTP-timeout allowances.
The council follow-up adds a deterministic competing-writer scheduler case
under F-7 and reaches the existing NEW-1 in a populated dendrometer weather
case, expanding the list from 9 to 11 without a new finding ID.
See [the per-case mapping and stage-1 assessment](baseline-mapping-88f6e84bb.md)
for each merged fix, the single finding behind every remaining case, and the
assertions that need changing or strengthening for stage 1.

The checked-in output of that baseline is `baseline-88f6e84bb.txt`.

The valve fix (valve control as in v0.8.1, #648) removed the six F-1, F-2 and
F-4 cases from the list, changed their assertions and added five cases that
retry at once. With it, strict mode reports 211 passed, 0 unexpected failures
and 5 known failing cases, then exits 1; that output is
`after-valve-fix-648.txt`, and the mapping document says what each changed
case asserts. Each line below names one remaining case; the JSON file carries
its exact signatures.

- F-14: `startup-node-errors`.

- F-13: `no-token:POST /api/account-link`.

- F-13: `no-token:POST /api/sync/force`.

- F-7: `scheduler-irrigates`.

- NEW-1: `dendro-weather-transport`.

## What a green run does not show

Ordinary PR/branch green permits the exact listed defects. Strict green does
not qualify hardware, radio delivery, images or first boot, native ABI,
authenticated cloud sync, provisioned credentials, real provider services,
hardware clock/reboot behavior, conditional-owner transitions or authenticated
cancel. Most API routes are tested only for unauthenticated refusal. Arbitrary
internal exceptions (F-15) and every future timer/data path remain outside
this suite. The comparison of valve control with v0.8.1, sequence by sequence,
is `scripts/test-valve-v081-equivalence.js`; this suite shows the same
decisions through the real runtime for eleven valve cases only. Two opens sent
at once are both accepted here, as the owner decided; the suite does not show
what the valve then does.
