# X3 environment and run projection evidence

The facade and run projection are prepared. Both repository flows.json files
remain unchanged; the dispatcher must grant X3 its reservation after X1 and X2.
The exact proposed changes are in
[`adapter-handoff.patch`](../../../scripts/fixtures/x3-zone-env/adapter-handoff.patch).
Cache policy, SQL and authorization decisions remain unchanged. The lead-approved
diagnostic and package-unavailable exceptions are recorded below.

## Baseline and scope

Startup readiness was READY at `ec822b556`: 0 behind, 0 ahead of `origin/main`,
AGENTS.md revision `c63103827`. Before that, the supplied T3 branch reported
MISMATCH (79 behind, 3 ahead). The common brief required a fresh branch from
`origin/main`; the original branch was preserved.

The four entry points are exported by each profile's `osi-zone-env/index.js`.
`http-facade.js` owns the environment orchestration; `run-projection.js` owns
estimated-volume bucketing, today-liters, recent-run querying and response
projection. `deploy.sh` stages both new files. Existing compatibility DDL and
its position in the request remain intact. The request message, dependencies,
clock and diagnostics are passed per invocation; no request data uses flow
context.

The source fixture freezes all four original nodes. Its first capture completed
at `2026-11-20T00:48:08Z`, before the production module files were written. The
characterization commit precedes the extraction commit. The later base update
was only the ChirpStack restore runbook, with no runtime or fixture changes.

## Initial local parity results

All runs below used `osi-heavy --contain --scratch-tmpfs 1G --need-gib 8`.
There are 143 cases, including failure injection at each SQL statement in the
three ordinary DB-owning paths, plus branch-specific failures. The oracle
contains full wire messages, output ports, exact SQL/parameters, HTTP
requests/bodies/timeouts, diagnostics, cache contents and close counts.

| Command or runtime | Result |
|---|---|
| `TZ=UTC node scripts/test-x3-zone-env-parity.js --capture` | PASS: 286 traces, both profiles, pre-extraction bodies |
| Prepared adapters before facade exports existed | RED: exit 1, `loaded.value.environmentSummary is not a function` |
| Node 22.23.1, `--legacy` | PASS: 286 traces |
| Node 22.23.1, `--verify`, UTC | PASS: 286 traces |
| Node 22.23.1, `--verify`, Europe/Zurich | PASS: 286 old/new comparisons |
| Node 20.18.3, `--legacy` and `--verify`, UTC | PASS: 286 traces in each run |
| `osi-zone-env/index.test.js`, Node 22.23.1 | PASS: 54 tests |
| `osi-zone-env/index.test.js`, Node 20.18.3 | PASS: 54 tests |
| `test-x3-zone-env-runtime.js`, Node-RED 3.1.15 / Node 20.18.3 | PASS: 572 traces, before/after × both profiles |
| `test-x3-zone-env-runtime.js`, Node-RED 4.0.9 / Node 20.18.3 | PASS: 572 traces, before/after × both profiles |

Runtime versions came from the feed Makefile, both profiles' image configuration
and Release Runtime Smoke pins. The local image package manifest also reports
Node 20.18.3-r1 and Node-RED 3.1.15-r1. These are software-runtime tests on the
workstation; no hardware or live service was used.

The first fixture attempts failed on missing required seed timestamps. The
first Node-RED attempt failed because the harness read a node before asynchronous
deployment completed; the corrected harness waits for `flows:started`. An early
per-statement SQLite CLI pass on Node 20 was stopped for excessive disk/process
overhead. Its replacement uses a persistent Python in-memory SQLite worker and
passed against the same pre-extraction oracle. None of these corrections changed
production behavior or regenerated the oracle after extraction.

## Initial before and after

Every case has before/after trace hashes and response observations in
[`parity-evidence.json`](../../../scripts/fixtures/x3-zone-env/parity-evidence.json).
All 286 hash pairs match. Complete expected messages and side effects live in
[`expected.json`](../../../scripts/fixtures/x3-zone-env/expected.json).

| Observation | Before | After |
|---|---|---|
| Measured dry rain, measured liters, estimated liters | `0, 12, 15` | `0, 12, 15` |
| No rain samples | `rainTodayMm: null` | `rainTodayMm: null` |
| Today-liters, usable zeros | `{"liters":0,"source":"unknown"}` | `{"liters":0,"source":"unknown"}` |
| Today-liters, only null estimates | `{"liters":null,"source":"none"}` | `{"liters":null,"source":"none"}` |
| Certified dry rain | `0`, coverage `complete` | `0`, coverage `complete` |
| Recent-run projection helper unavailable | port 2, `503`, `Valve projection unavailable` | port 2, `503`, `Valve projection unavailable` |
| Environment close throws | `500`, two close attempts | `500`, two close attempts |

The last row is a legacy exception to the one-close rule: ordinary response
branches close once; a constructor failure acquires no handle; a throwing close
is retried by the environment catch. The extraction preserves that exception.
The source difference between today-liters (largest per-source total) and
zone-local history (sum of eligible estimates) also remains. Known weather and
soil-depth outcomes are retained for EB15 and EB11b; EB9 owns event-source changes.

## Flows handoff and CI gate

Run `node scripts/x3-zone-env-adapters.js /absolute/external/scratch` to regenerate
the exact patch. The utility checks the source bodies and JSON roundtrip and
refuses a scratch path resolving into this checkout. An intervening X1/X2 change
to an X3 body requires re-characterization before integration.

All IDs, wires and output arities stay fixed. The only libs change is adding
`{"var":"osiLib","module":"osi-lib"}` to `get-actuations-response`, explicitly
approved by Phil. `zone-env-fn`, `strega-today-liters-fn` and
`get-actuations-query` retain their existing bindings without additions/removals.
The adapter source total falls from 57,553 to 8,266 characters per profile.
Today-liters retains its original authorization preflight so its early replies
precede the new facade dependency.

The CTO's updated gate rule moved full suites to GitHub CI on the exact head
SHA. The queued local full-gate wrapper was cancelled before it ran.
`verify-x3-zone-env-handoff.js` is registered in the Sync Flow Verifier workflow.
It runs the full verifier on a read overlay of the proposed flows and explicitly
calls `flows-bare-require-scan.js`'s exported scanner on both profiles, with a
negative control. The scanner file has no standalone CLI check, so merely
running that file would not prove anything. CI must show both passes; this report
does not claim a local full-suite result. Runtime parity is also registered in
both release smoke jobs, and Node parity in the sync workflow.

The PR remains draft. Full CI and independent review, followed by a granted
reservation, adapter integration and parity rerun, are still merge requirements.

## Time record

Reconstructed active time, rounded to 0.05 hours: characterization and focused
testing **0.65 h**, module preparation **0.05 h**, adapter patch and handoff
**0.15 h**, reservation window **0.00 h**. No reservation was held. These are
approximate session measurements, not a stopwatch benchmark: work overlapped
shared-lane queuing. Wall time from initial readiness to the final runtime pass
was 1.33 h (`23:43:33Z` to `01:03:14Z`), including queue waits and the superseded
slow fixture pass. Do not interpret that envelope as focused engineering cost.

## Lead review correction round

UTC start: **2026-11-20T01:16:18Z**. The round addresses the seven findings in
the Sol review at `d63ec14a`. Resume readiness was READY at that head, with
`origin/main` at `1a984f31`: 0 behind, 3 ahead; AGENTS.md revision `c63103827`.
The original four oracle/evidence blobs remain
immutable, pinned by `original-sha256.json`.

The lead approved two explicit parity exceptions. Six formerly empty catches
now warn with the compatibility SQL or provider/close context; expected duplicate
columns are distinguished from unexpected SQL errors. Their fallback, SQL order,
close attempts and replies remain unchanged. The comparator permits only those
six warning prefixes and compares every remaining field strictly. Additional
cases pin each provider warning, expected/unexpected compatibility failures and
the throwing-close warning.

The second exception is a missing or quarantined zone-env package returning 503
with a diagnostic after all legacy early replies. Today-liters keeps its exact
bearer verification, validation and process-midnight calculation before loading
the facade. The query keeps its empty-user 401 before loading. Additive fixtures
record the frozen legacy reply and assert the approved 503 independently.

The handoff now includes both recounted baseline files. On this candidate each
profile has 59 silent catches and 330 DDL markers (28 CREATE TABLE, 202 ALTER
TABLE, 26 CREATE INDEX; other categories unchanged). Active flow/baseline files
are untouched. The overlay presents the proposed baseline pair only with the
proposed flow pair. A compatibility test compares all 16 environment statements
and the query statement to the frozen trace in exact order, and an upgrade
fixture exercises first successful compatibility creation.

The staged gate also runs the Task 5b2 projection tests through the real facade,
the rain caller guard and its awaited-delegation controls, and the flag-off
auth discovery and sentinel tests. Discovery follows reviewed adapters into the
real module. Both secret variants and caught sentinel failures are exercised.
Native runtime checks retain declared libs, native send and native error routing;
completion drains every output and Catch delivery. Duplicate-send and two-port
controls must fail cardinality independently of the plain Node harness.

Additional fixture capture is exclusive-create, requires frozen source nodes,
and never writes the original oracle. Cases assert their intended signatures,
transport, SQL/schema effects, cache/source selection or date boundary. Release
jobs run UTC and Europe/Zurich. The checked-in patch must equal the renderer and
produce the same bytes when applied to an external scratch tree.

The reviewed staged candidate was red on the 65/347 flow baselines, both Task
5b2 tests and the rain caller check. The corrected staged affected runner exits
0. Its output includes `verify-osi-lib-db-caller-binding: OK`, both 2/2
projection tests, 12/12 caller-guard tests and 14/14 hermetic-auth tests. The
hermetic summary retains 200 auth/scope-gated node instances across both
profiles. The explicit bare-require scan reports both staged profiles clean and
rejects its negative control.

| Correction-round check | Result |
|---|---|
| Original parity, UTC, Node 22.23.1 | PASS: 286 traces; original blobs unchanged |
| Additive capture from frozen source, UTC | PASS: 134 branch-asserted cases across both profiles |
| Additive parity, UTC and Europe/Zurich, Node 22.23.1 | PASS: 134 cases per timezone |
| `verify-x3-zone-env-handoff.js --affected` | PASS: patch/renderer/application equality, recounts, projection/rain/auth and revision guards |
| Node-RED 3.1.15 / Node 20.18.3, UTC and Europe/Zurich | PASS: 840 native traces per timezone and cardinality/Catch controls |
| Node-RED 4.0.9 / Node 20.18.3, UTC and Europe/Zurich | PASS: 840 native traces per timezone and cardinality/Catch controls |

An initial staged invocation found no external `patch` program on the host;
patch application now uses Git with an exact path whitelist. An initial native
cardinality assertion represented a thrown two-output node as one absent
return. It now checks each physical output independently; both native mutation
controls reject the extra delivery. These were harness corrections.

The local staged runner excludes only the full `verify-sync-flow.js` command.
GitHub CI runs that command against both committed and staged flows, including
the bare-require ratchet. Full migrations, smoke and shell-fixture jobs remain
exact-head CI gates. The new focused checks are registered in the sync workflow
and both release runtime jobs; test inventory includes the indirect native
runner.

Final focused batch: exit 0. The module has 54/54 passes on each Node
version; original parity in Europe/Zurich has 286 passes and additive parity
has 134. `verify-test-inventory: OK` reports 1,012 test files (832 direct,
9 indirect, 171 excluded). Documentation hygiene passes its built-in patterns
(the private name list was not supplied), prose check passes and diff checks
are clean. The original blobs, reserved flows and active baseline files have
no changes.

UTC stop: **2026-11-20T01:58:25Z**. Correction-round wall time: **0:42:07**
(0.70 h), including installation/osi-heavy queue waits and serial verification.
This is an elapsed cost record; active subparts were not separately timed in
this review round. Reservation-window cost remains **0.00 h**. Publication and
GitHub CI wait follow this stop; their exact-head state is reported with the PR.

## Squash and package-load correction

Implementation UTC start: **2026-11-20T11:15:39Z**, following the lead's
squash-survival addition. The saved startup-readiness file is from the original
replaced checkout and reports MISMATCH. This continuation deliberately retains
`c217b8384` on the same review branch, based on main-ancestry commit `1a984f31`
(0 behind, 4 ahead of that intended base). AGENTS.md revision is `c63103827`;
current main has advanced. No checkout repair or reserved flow edit is needed.

The executable X3 oracle and handoff paths already read committed fixture files;
none reads a PR-only commit. The existing workflow's bootstrap baseline is in
main ancestry. Historical review SHAs in this report are provenance, not inputs
to a check. A new squash test constructs a local one-parent commit with the
candidate tree and main-ancestry parent, pushes only that history into a private
bare repository, then clones it through Git's transport. It checks every PR-only
commit object is absent, checks the tree and parent, rejects unexpected refs or
object alternates, and runs original/additive parity plus the staged affected
handoff in that fresh clone. CI runs the same test.

The evidence writer now uses exclusive creation. An existing destination is
rejected before parity starts, and the final atomic write uses `wx` to close the
race after that check. Tests cover ordinary files, hard links, symbolic links,
dangling links and `X3_EVIDENCE` aimed at the original oracle. Additive capture
already uses exclusive creation; the original capture blobs remain untouched.

The zone-env index defers the two extraction modules until a caller requests a
new entry point. The real osi-lib loader is tested with each dependency made to
throw: legacy helper calls and a second package load must still succeed without
quarantine. Adapters guard lazy entry-point resolution and keep the existing 503
reply and diagnostic, with legacy early replies still preceding that resolution.

The dependency/error regression test was RED before the lazy-loading change:
2 tests passed and 6 failed (both dependencies in both profiles, plus both
adapter error-path tests). The corrected focused batch exits 0: 8/8 packaging
tests, 54/54 module tests, 286 original and 134 additive comparisons in each
process timezone, and the staged affected handoff. Inventory reports 1,014 files
with 834 direct runners. Hygiene and prose checks pass. The regenerated adapters
total 8,266 characters per profile; the only libs addition remains the approved
osiLib binding on `get-actuations-response`.

The combined proof/runtime batch exits 0. Its fresh-clone receipt reports
`5 PR-only commits absent` and exactly these refs: `refs/heads/squash`,
`refs/remotes/origin/main`, `refs/remotes/origin/squash`. The clone has the same
committed implementation tree and a single parent at main-ancestry base
`1a984f31`. It has no object alternates. Original parity (286 comparisons),
additive parity (134 comparisons) and `verify-x3-zone-env-handoff.js --affected`
all pass inside that clone. The script obtains its source and base dynamically;
no PR commit is an oracle or handoff input.

| Additional final check | Result |
|---|---|
| Fresh local squash-equivalent clone, UTC / Node 22.23.1 | PASS: parity and staged affected handoff, with PR-only objects and refs absent |
| Node 20.18.3 module and packaging tests | PASS: 62/62 (54 existing module tests plus 8 packaging tests) |
| Node-RED 3.1.15 / Node 20.18.3, UTC and Europe/Zurich | PASS: 840 native traces per timezone and cardinality/Catch controls |
| Node-RED 4.0.9 / Node 20.18.3, UTC and Europe/Zurich | PASS: 840 native traces per timezone and cardinality/Catch controls |

The next publication commit records these results only. CI repeats the squash
proof on the published head. Full local suites were not queued, and the reserved
flows, active baselines and all frozen oracle blobs remain unchanged.

UTC stop: **2026-11-20T11:38:32Z**. Implementation and focused-verification wall
time from the recorded start is **0:22:53** (0.38 h), including osi-heavy queue
waits, the fresh clone and serial runtime verification. Active subparts were not
separately timed. Reservation cost remains **0.00 h**; publication and GitHub CI
follow this stop.

## Sol round 2 correction

UTC start: **2026-11-21T11:27:30Z**. The branch was rebased onto current main
`bda200db62`, including #714, #716, #732 and #734. Resume readiness reports READY
at `e5d97571c`, zero behind and six ahead, with AGENTS.md revision `c63103827f`.
The stale startup JSON was retained by the launcher; the fresh readiness output
is the record for this continuation.

The handoff now validates one complete legacy or integrated state. Every X3
node must match its full frozen or approved adapter metadata, both baselines
must match fresh counts, and the provenance note must occur exactly once after
the swap. Mixed profiles/nodes or stale baselines fail. Patch equality and
application checks remain required before the swap. After the swap the verifier
runs the same gates directly against committed adapters and recounts. Rendering
the integrated state is idempotent. The shared DDL counter exports use X2's
`require.main` guard and export pattern verbatim.

A new disposable committed-checkout test follows X2's staging pattern. It applies
the actual patch, rejects stale-patch and partial-swap mutations, then reruns the
post-swap verifier, non-UTC parity and an independent squash clone. CI also runs
the full verifier on that applied candidate. Both release-runtime jobs run their
X3 native leg against the applied candidate, including UTC and Europe/Zurich.
The reservation worktree's flows and active baselines are never written.

The four provider warning sites log a fixed provider/operation prefix followed
only by a bounded status and reason. Raw error text stays internal to preserve
legacy fallback, cache/SQL order and replies. Synthetic authentication bodies,
malformed responses and network errors test that secret markers reach the
transport but never warnings. Query loader failures now require the exact
`[null, message]` pair, status 503 and payload; native checks require `[0, 1]`
cardinality and the exact message. Wrong-success-port mutations must fail both.

Qualification status at this implementation checkpoint: syntax, inventory and
built-in documentation hygiene pass. The review supplies the three failing
reproducers. A separate local red probe was cancelled before execution; the
single consolidated focused qualification job is queued in osi-heavy behind the
Pi 5 firmware build holding the slot since `08:53:18Z`. No local parity or native
pass is claimed for this round until that job runs. Full suites stay in exact-head
GitHub CI, and no permission escalation or permission request was used.

The first CI candidate exposed a shallow-checkout assumption in the new runtime
staging test: `origin/main` was unavailable. Both release jobs now fetch full
ancestry. Their applied-handoff native legs passed on `ae34d85c33`. The earlier
sync candidate `7bb16c43a1` also passed the actual applied handoff's full verifier,
non-UTC parity and independent squash proof, with all 18 response-marker/port
tests passing in both states. These are CI observations, not local passes.
Partial-state mutation controls now run even when the test starts integrated,
so main keeps testing those controls after the slot.

Publication checkpoint UTC stop: **2026-11-21T12:16:20Z**. Elapsed from the recorded
start: **0:48:50** (0.81 h), including the shared-slot wait and CI triage.
Reservation-window cost is **0.00 h**. Mandatory local qualification remains
blocked/queued behind the other firmware job; this is not a completed local
verification record. Its one queued wrapper runs the focused pre/post checks,
Node 20 module tests and both native runtimes serially, and records its starting
head to reject a changing checkout. Scratch is retained for that queued job.
No other job was cancelled or changed. The final publication commit records
this checkpoint only; exact-head CI and renewed review remain merge gates.
