# Conditional irrigation execution report

Execution started 2026-10-17. Software checks completed 2026-10-20; production activation remains disabled pending physical qualification.

User selected Luna implementers and Sol reviewers for every slice. Work is isolated
on feat/conditional-irrigation in both repos. No production access, push or deployment.

## Bases

- Edge: f130073205aa26abaa5d71097b354df39e9fe753.
- Server: 113696c1bcdb27747a8fe62c1158dcdf0168695f.
- Both recorded bases matched fetched origin/main at execution start. Integration
  now includes edge `55b3d4b7bb48d0779234a03dca27468d935d34db` and server
  `b53df7ad8339241f03386cce5d8b07786ceb7433`. All four edge verifier pins use
  that edge commit. Earlier evidence retains its historical base. Task10 checks
  upstream compatibility again.
- Specification and plan carried into edge commit 50719945c.

## Progress

| Slice | Status |
|---|---|
| A: SWT presets/help | Complete; Sol spec and quality reviews pass. |
| B: inactive policy infrastructure | Runtime, conversion, command delivery, observations/history, policy API, worker and paired replication accepted. Final backend, module and contract checks pass. |
| C: activation/conversion | Editors, browser behavior and packaging pass. Production activation remains disabled pending hardware qualification. |

The original dirty checkouts were left in place. Worktrees are
/home/phil/Repos/osi-os/.worktrees/conditional-irrigation and
/home/phil/Repos/osi-server/.worktrees/conditional-irrigation.

## Validation so far

Both frontend typechecks and builds passed before their implementation changes.
Initial full Vitest runs were stopped with exit143 because their concurrency
caused shared-host memory pressure. Repeats with maxWorkers=2 passed: edge249 files,
2718 tests; cloud263 passed files and2561 tests, plus1 skipped file/2 skipped tests.
Those runs overlapped the worker's edits and are diagnostic evidence, not proof of
the final commit or a wholly untouched baseline. Final checks follow the fixes.

All eight runtime baseline checks passed at migration head 0073: migration
validation, seed replay, runtime schema parity, database schema consistency,
seed ledger, profile parity, sync flows, and valve schedule sync triggers. Logs are under /tmp/irrigation-edge-baseline,
/tmp/irrigation-server-baseline and /tmp/irrigation-edge-runtime-baseline.

The unchanged backend baseline passed: `./gradlew test --no-daemon --max-workers=2
-x buildFrontend -x buildTerraIntelligenceFrontend` completed in 7m 43s. Its XML
results contain 5,000 tests, zero failures/errors and two skips across 583 files.
The same backend suite then passed under a temporary, checksum-verified Java 21
toolchain in 7m 6s, again with 5,000 tests and two skips. These runs exclude frontend
packaging. Logs: /tmp/irrigation-server-backend-baseline.

At edge222ae0114 and cloud846a971e, exact-commit full frontend checks passed.
Edge:236 TSX tests and2,733 Vitest tests across252 files. Cloud: the full TSX
suite and2,578 Vitest tests across268 passed files, with one file/two tests skipped.
Both builds passed; the worker's typechecks passed on the same revisions. Logs:
/tmp/irrigation-slice-a-final-edge and /tmp/irrigation-slice-a-final-server.
The later primitive fixes passed amended-code suites (edge32 tests, cloud17),
both typechecks and final builds. Test-only hover corrections then passed three
tests in each repo. Sol approved both spec compliance and quality at edge5c2329b48
and cloud1d930dcd. These final test edits do not change the built application.

Java21 `./gradlew bootJar --no-daemon --max-workers=2` passed, including Terra dist
and JAR verification. This local packaging run deliberately used an empty map token
and TERRA_REQUIRE_MAP=0; it does not qualify a map-enabled published release.
Logs: /tmp/irrigation-slice-a-packaging.

The existing valve module baseline passed all 282 tests.

Task2 condition/evidence code is accepted at edge a21ee7ddf after Sol review.
Focused suites passed29 tests per profile; subsequent timestamp/downgrade fixes
passed25 affected tests, and the per-channel fault amendment passed15 affected tests.
Flow syntax, profile parity, sync-flow and silent-catch gates passed. No policy API
or activation path is wired yet.

Task3a schema/storage is accepted at edge3ad0731bf after three scoped Sol fix
reviews. Final store tests pass30/30 across both profiles. The fixes preserve
immutable decisions and acceptance markers, grant dispatch only once, and restrict
expiry to supported pre-acceptance evidence. Replication remains in Task7/0075.

Migration, fresh/upgrade/customer-numbering rehearsals, schema/history checks and
all seven seed databases passed at head0074. Later store-only fixes did not change
that schema. The original tests-first red output was not captured; subsequent
fix rounds recorded real failing regressions before the source fixes.

Task3b clock/calendar is accepted at edge ee96048cf after Sol spec and quality
review. The final paired policy suite passes120 tests, including clock rejection
persistence and recovery, UTC timestamp parsing, DST occurrence resolution, exact
midnight budgets and schedule feasibility bounds. Hook, shell syntax and profile
parity checks pass. Save validation checks a400-day resolved horizon; runtime must
recheck actual bounds before dispatch. Task6 still owns runtime clock-gate wiring
and first-hook installation. The real BusyBox callback remains a hardware gate.

Task4a dispatch core is accepted at edge2038d298b after Sol spec and quality review.
The final paired dispatch suite passes104 tests. Covered behavior includes one-shot
claims for every owner, immutable conditional expiry/effective duration, durable
flush capture and attempt recovery, positive ACK/observation settlement, and daily
accounting in the current policy timezone. Separate-process SQLite contention,
helper/model/store and mirror checks passed on the corresponding amended code.
No live caller is wired by this slice; Task4b must bind encoded frames to persisted
command duration and integrate every STREGA writer. Task6 applies authority, clock
trust and policy limits through the reviewed transaction interfaces.

Task4b writer integration is accepted at c4c2a38c2 after five scoped fix rounds.
Sol passed spec compliance and code quality with no remaining required findings.
Every STREGA writer uses the shared queue boundary. The actual flow-wrapper tests
cover local/cloud responses, accepted-only logging, numeric cloud ACK delivery,
simulation authorization, exact advanced durations, enqueue/flush serialization,
and crash recovery through the generic command deduplicator. Proven pre-acceptance
rejection retains a terminal result; ambiguous or conflicting acceptance evidence
retains UNKNOWN transport and a supported retryable cloud result without a resend.
The final ledger suite passes64 tests per profile. Actual wrapper, writer inventory,
transport, profile parity and pinned sync-flow checks pass; the unchanged paired
valve suite passed690 tests on the corresponding writer integration revision.
Task4 remains incomplete until the effect/lifetime work below is reviewed.

A separate review found that accepted configuration/CLOSE commands currently lack
a positive settlement path and can block later timed opens indefinitely. Task4
needs an explicit resolution before conversion starts. Task4c now separates command
effects from transport audit: non-actuating settings stop blocking, permanent CLOSE
can quiesce only its own owner, and timed commands gain qualified finite horizons.
The revised contract uses the same delivery-aware allowance for manual, ONCE and
conditional opens, with a hardware margin between queue cutoff and physical deadline.
Sol accepted the core at `3d3346e18` after three fix rounds. All required and minor
findings are closed. The fixes enforce persisted-frame validation, owner observation
ordering, one trusted clock instant, immutable anchors and conservative accounting.
The final focused suite passes 16 tests per profile; combined valve/policy suites
pass 429 per profile. Live-writer integration follows as a separate reviewed task.
Queue absence or a successful
flush remains insufficient proof of non-delivery; transport uncertainty and historical
daily charge survive finite release.

Task4c2 started from `b34151fee` and is accepted below. It integrates the core with the
actual encoder, one-time scheduler and explicit CLOSED telemetry. The reviewed
contract now makes timed opens wait for current-boot clock trust, including manual
opens. Safe CLOSE can use an explicit unbounded variant while time is untrusted;
it cannot gain finite release later or erase an existing deadline. Its per-owner
observation proof and the residual risk of a delayed CLOSE remain explicit in §7.1.

The changed command ledger also invalidates deploy.sh's checked-in ledger hash.
That is feature-stack debt, not a failing untouched-origin gate. Task6 must refresh
the final candidate hash and pass the paired dependency deployment test before this
branch can be described as deployable.

The standalone flow-size ratchet failed on ten nodes after Task4b. Task4c2
resolved that feature-stack debt by extracting tested wrappers into the valve module,
without increasing allowances or changing the pinned base. The final gate reports
3,218,414 total embedded characters versus 3,309,074 at the base. The full sync
verifier does not run this standalone check; it was run explicitly.

Task4c2 live integration is accepted at `bc97e9286` after three scoped fix rounds.
Sol passed spec compliance and code quality with no remaining findings. The fixes
ensure a fresh runtime clock at the sole claim, preserve explicit queue expiry,
require actual attempt evidence for CLOSE settlement, resume unclaimed commands
without resending attempts, and finalize ONCE results and audits once across live
facade instances. Actual OPEN wrapper coverage was restored.

The full valve/policy suites passed 448 tests per profile at the second fix. The
final worker-only patch passed 44 worker tests per profile, including the two-facade
regression, plus actual OPEN wrappers and pinned sync, size, parse, parity,
silent-catch, identity, communication, MQTT, DDL and migration checks. This closes
Task4. Schedule conversion, the policy API/due worker, cloud compatibility and the
remaining UI/integration work are still ahead.

Task5a initial conversion implementation is at `8f14bdefe`, based at `76e38ccc4`.
Both profiles passed386 valve tests and63 policy tests; writer guards and actual
wrapper integration also passed. The initial red evidence was only a missing test
file, not a behavioral regression. Sol initially found two Critical and nine Important defects. Three correction rounds
have closed the revision/writer races, unrelated-owner bypass, flush audit loss,
atomic ACK/readiness and scoped-transaction defects. The latest review at `a93076b76`
has zero Critical and three Important findings: terminal ACK failures still request
automatic recovery, matching-profile fixed generation promotion is missed, and the
actual-caller coverage needs those distinctions. A fresh Luna worker is implementing
round4 from `3c8f5d404`. Conversion remains unaccepted.

The separate flow-wiring verifier repair is accepted at `9981ffa35`: Sol passed
specification and quality review with no findings after two correction rounds.
The verifier now follows the actual exported helper, rejects comment-only matches
and requires the trigger at the top level of the dispatch command. Mutation checks
and the flow-wiring gate pass; the actual wrapper suite passed4 tests.

Task5b observation attribution follows conversion acceptance. Its corrected preflight uses
an explicit report watermark rather than generic device update timestamps.
Observed valve-fired and unexplained runs must enter the automatic daily budget
once; unknown duration blocks candidate local days its possible interval can touch.
A linked fresh CLOSED report bounds the latest end, so an ended previous-day run
does not block every future day. These are implementation
requirements, not behavior already supplied by the current command-only query.
The observation module must check the real runtime clock before persisting positive
endpoints. It will ship through two reviewed parts: core/accounting first, then the
actual ingest, ACK and recovery integration. Neither part alone completes Task5b.

## Implementation decisions

Normal daily DENDRO analysis will capture unfiltered evidence. Old cached rows
without it remain UNKNOWN until the next normal calculation; conversion never
replays stateful analytics. This may delay the first DENDRO check.

Sol's transport preflight found that MQTT publication cannot order ChirpStack queue
acceptance against gRPC flush. The revised contract sends all STREGA writes through
awaited gRPC under the device writer guard. The initial core expires conditional
opens; Task4c extends expiry to ordinary/ONCE timed opens and permanent CLOSE.
It also records every flush owner, including opaque cancellation-rebuild entries.
This broadens the ordinary-valve transport regression surface and retains the
existing bench gates. The scoped documentary follow-up accepted this correction.

Pending link attempts use a separate nullable field on sync_link_state so background
capability requests cannot replace the policy-mutation fence. The existing row owns
both lifetimes; no extra peer table is needed.

Commissioned generic VWC is eligible only after explicit manual configuration with
a valid channel count. Provisional named mappings remain unavailable. This trusts
the same explicit mapping used by current telemetry, with selected-channel and
valid-sample checks applied again for irrigation.

New Luganda keys follow the repository's English fallback pending human translation.

The server link response arrives after claims and credentials have been committed.
Task7 therefore adds a capability-guarded link route for live policies, plus a local
link-attempt fence against concurrent policy changes. There is no fallback to the
legacy route after an unsupported result. This adds an endpoint and recovery tests;
policy-free gateways retain existing linking behavior.

The same receiver check is required on event and bootstrap delivery. A server
rollback can invalidate a previously cached capability without changing its URL.
Task7 now uses guarded delivery routes for ordinary sync and force sync; an
unsupported receiver leaves events pending and cannot store a conditional schedule
as an ordinary schedule. These two endpoints remain to be implemented.

The clock hook preserves a last-good synchronization marker when NTP peer replies
stop. BusyBox unsync does not change the clock. Runtime checks reject boot changes
and wall-clock discontinuities; this lets an already-synchronized gateway continue
offline within the same boot. Only a valid stratum callback may write a new marker.

ChirpStack4.12.1 queue deletion cannot prove a frame was never submitted to radio.
Task4 therefore keeps accepted commands UNKNOWN after a flush, including items
listed as nonpending. Cancellation will report uncertain plan/configuration entries
instead of automatically rebuilding them from that snapshot. This is a deliberate
change to queue recovery; physical timed closing and cancellation remain available.

Sol's Task6 preflight found that nested valve locks retain only the innermost EUI:
A -> B -> A waits on itself. Atomic multi-valve policy edits will acquire the full
sorted affected set before opening SQLite, then revalidate membership and versions.
Membership expansion rolls back and releases before retrying. Each post-commit
sender reacquires one valve and rechecks its revision and live conflicts. This is
planned Task6 work; it does not change the current Task4c2 scope.

## Current handoff

Task5b1 is accepted at `f3b48843983f7fe7f5e59572a1594ce0c7cae6ba` after
three scoped fix rounds. Sol reports spec compliance PASS, quality Approved and
zero open findings. Both required guards carried from Task5a are now closed:
missing required clear rows cause no transport work, and fixed-transition recovery
rejects changes to schedules or the resolved clock timezone.

The core preserves physical-run identity, attributes observations through strict
owner evidence, requires persisted incident closure and incident-specific retry
ACKs, and keeps unknown-duration accounting conservative. Verification includes
386 valve tests and63 policy tests per profile,21 focused core cases,31 review
regressions and35 Gen2 cases. The last fix changed only the horizon-boundary test.
The independent schema rehearsal completed with exit0 and its final OK line,
covering upgrade preservation, fresh install, compatible columns and customer
numbering. Earlier short timeouts were insufficient for the fresh migration run;
no schema or test-harness repair was needed.

Task5b2 is accepted at `aa3269b57` after three scoped fix rounds. Sol reports
spec compliance and quality PASS with zero open findings. The live path preserves
untrusted timestamps, projects explicit OPEN conservatively and recovers only an
unambiguous legacy run. Unsupported legacy rows remain unchanged. Verification
includes151 focused tests and395 valve tests per profile; the final independent
review also passed19 observation cases and the candidate-boundary probe.

Task5b3 is accepted at `4e73584fc` after four scoped fix rounds. Sol reports
spec compliance PASS, quality Approved and zero open findings. Archive, bootstrap
and durable history use the same replication population; local dirty keys finish
without retries, and valve cursors normalize without rewinding progress. Validated
legacy compatibility rows retain their cloud identity through adoption and repair.
The independent final focused suite passes18 cases across both profiles. Earlier
runtime changes passed paired runtime, bootstrap and touched flow/sync gates.

Task5 is complete. Task6a is accepted at `33beca291` after three fix rounds.
Sol reports spec compliance PASS, quality PASS and zero open findings. Final API
suites pass33 cases per profile; the last runtime revision passed493 combined
policy/valve tests per profile, decoded routes with20 transport calls per profile,
and the touched repository gates. Earlier delivery checks passed the module bundle,
clock-hook installer and47 command-ledger rollback cases.

The API now uses fresh mutation authority after writer waits, versioned schedule
edits, atomic clock-bound revalidation and real post-commit transport. Tests prove
opposite-order two-valve transactions and isolated future bounds beyond the first
lookup page. Source bounds use the accepted timestamp parser over indexed pages of
at most256 rows. Total lookup work remains linear in history: Sol measured356ms
for a full API edit with100,000 source rows on the workstation. That is not a Pi
latency qualification. Empty due ticks must not repeat those scans.

A bounded preflight also reproduced a stale write-clock gap in future-only
activation. Enabled saves require trusted time, while paused drafts and pause
remain possible without it. Task6b1 is accepted at `c65452a71` after three fix
rounds. Sol reports specification PASS, quality PASS and zero findings. Final
worker suites pass44 tests per profile; the runtime at `7f6f09ad9` passed539
combined policy/valve tests per profile and actual tick/route plus touched pinned
gates. Durable discovery now survives newer audit checkpoints and policy removal;
accepted transport recovery never enqueues again. The final test-only fix proves
a RESERVED owner behind a saved/reopened06:20 checkpoint resumes once before
expiry or becomes EXPIRED with zero sends afterward.

Task6b2a is accepted at `3ad96d669` after one fix round. Sol approved
specification and quality with zero remaining findings. It adds lifecycle-clear
transport, explicit resend, shared claim fencing and schedule/generation
invalidation. Scheduler ACTIVE checks and local ownership checks now occur under
the valve writer. Failed clear commands require explicit resend and a new revision.
The final affected suites pass178 tests per profile, including19 lifecycle tests;
the earlier implementation passed555 combined policy/valve tests per profile.
The writer inventory and full sync verifier pass with the correct pinned base.

The scoped-access script still has16 failures also present at this slice's base.
A focused preflight traced them to a missing harness module alias and assertions
against the old direct-writer boundary. The next integration slice must exercise
the actual authorization/transport chain and restore the full script to green.
Thirty feature tests also lack CI inventory coverage; Task10 must register them.
These results do not establish a green whole branch.

Fresh origins are edge `55b3d4b7b` and server `b53df7ad8`. Edge main now owns
migrations0074 and0075, so integration immediately after6b2a acceptance will move
the unshipped conditional migration to0076 and reserve0077 for conditional sync.
It must preserve expiry handling for radio and conditional commands, history
filters, module delivery and current SWT source compatibility. Task6b2b then
integrates the shared atomic lifecycle service across local/cloud adapters.
Task6 remains incomplete.

## Upstream integration verification

Local merge commits are edge `f1f0bdde53947eceb39040c55f503d12ef5b225f`
and server `0de74928fe8cf10094c390c2a0ddd60f47a55b4b`. Edge compatibility
changes are in `86afd172b3325153afa55339322191df55360389`. Main migrations
0074 and 0075 retain their original bytes. The feature migration is now 0076;
0077 is reserved for conditional sync. All seven seeds have a 76-entry ledger.

Independent verification passed: edge frontend 114 tests, typecheck and build;
server frontend 35 tests and build; 24 targeted backend tests, Flyway ordering
and contract vendoring. The schema rehearsal passed in 310.62 seconds, covering
0073-to-final, main 0075-to-0076, compatible columns, fresh databases and customer
numbering. Additional radio, transport, history, Tensiomark, scheduler and deployment
checks passed. These results do not replace the final whole-branch verification.

Sol found three required fixes: Date input validation accepted a branded object,
the scoped authorization harness changed device identity before transport and
omitted enqueue counts, and the module loader test omitted the new policy module.
The fixes are committed at `1c2c41e9a4b3702e9fb27f9312a0af5a6e3418f1`.
Sol accepted specification and quality with no remaining findings. Independent
reruns passed: scoped authorization 101/101, helper 48/48, loader 6/6. Integration
is complete. The lifecycle adapters are now accepted as recorded below. Cloud
replication, policy UI, browser scenarios and final release verification remain.

## Lifecycle routes accepted

Task6b2b is complete at `20c370d4a5e68a79ff207760fe3210358c2afa7e` after two
fix rounds. Runtime changes are in `5ac8258b5`, `e05515a84` and `25f5cacbc`;
the final commit expands the actual route tests. Sol approved specification and
quality with no remaining findings.

Local and cloud lifecycle commands now share the valve-writer and transaction
boundary. Stale cloud versions cannot overwrite newer state. Removing a source
pauses its policy; assigning an incoming source preserves the destination policy.
A retired policy-attached valve gets a durable clear request even after moving,
while a replacement schedule prevents an old clear from taking over. Managed
legacy writes require an explicit disabled value, and exact replays preserve
canonical state and clear revisions.

Independent verification passed: 28 route tests covering both Pi profiles,
101 scoped authorization tests, 567 policy/valve tests per profile, command ACK
postconditions, full sync verification and all four gates pinned to `55b3d4b7b`.
Profile parity passed. The command-ledger deployment rehearsal passed; no deployment
was performed. Replay fixtures assert unchanged policy, schedule, device, clear
and push state, zero enqueue calls, and one durable ACK and ledger row.

Task6 is complete. Task7 adds cloud mirrors and capability-guarded replication;
the policy editors and final integration/browser gates follow it.

## Cloud implementation and review evidence

Task7a passed review after four fix rounds. The first candidate at edge `8cdae174a` and server
`05bce6e88` passed the seven contract and migration-order checks. Its broader
backend run had 222 passes and four failures caused by missing test dependencies.
Sol found three critical, nine important and one minor issue covering command
replay, strict contracts, runtime ingestion, freshness, pagination and legacy writes.

The first fix round is committed at edge `4ee03742f` and server `0864e664b`.
Independent verification passed all 546 selected backend tests with no failures,
errors or skips, plus all seven contract, vendor and migration-order checks.
The backend selection includes protected command delivery and ACKs, database
pagination, bootstrap, desired-state convergence and Flyway migrations. Both
worktrees remained clean at the recorded commits. Sol resolved seven findings
but found six still open: protected command delivery and replay, contract shapes,
zone ownership, tombstone visibility, request validation and legacy identifiers.
The second fix round is committed at edge `176c4da548` and server `9218fd40ff`.
Independent verification passed 561 backend tests with zero failures, errors or
skips, all seven paired contract/vendor/Flyway gates and a fresh mandatory AJV
install. Sol still found six open findings. Successful retry ACKs settle the action
but do not clear the delivery fence's unresolved query. Poll and ACK paths omit
current zone ownership checks; completed replay still consults mutable policy and
schedule state. Schema fixtures disagree with numeric edge enabled values and
partial edits, while Java accepts malformed nested summaries. Source validation,
foreign schedule identity and immutable policy-zone association also need fixes.
Original tombstones are fixed; stale legacy-time preview metadata must now be
nulled in the cloud read DTO while retaining the stored dated evidence.

An independent AJV probe reproduced five failures in twelve cases: numeric policy
values 0/1 and two valid partial edits are rejected, while a pause without its
expected version is accepted. The third fix round requires real SQL fence checks,
completed replay after replacement, and shared valid/invalid fixtures through AJV
and production Java ingestion. Task7b starts after the corrected cloud
implementation passes review.


The third fix round is committed at edge `43edd7e494` and server `fb76236745`.
Independent verification passed 580 backend tests with zero failures, errors or
skips in 73.17 seconds. All seven paired contract/vendor/Flyway gates and the
original 12 schema probes passed. Sol accepted the retry fences, current ownership
checks, completed replay, timezone projection, foreign schedule validation and
immutable policy-zone association.

Round 3 left C2 and I1 open. An identical-input 78-case comparison passed AJV but found
Java accepting an empty SWT evidence source list. Sol also reproduced rejection of
a valid full schedule update because both `oneOf` branches matched, and found that
request validation could retain numeric strings and noncanonical enum values in
commands. A fresh Luna worker completed round 4 with shared-schema runtime
validation, separate create/update branches and typed wire values before persistence.

## Cloud checkpoint accepted

Task7a is accepted at edge `bf0ee2d0e16e6e158f5b1b713f57c7ef8709f063` and
server `90766a389d8ddf5010af82d461ba00f1945e5c8e`. Sol returned specification
GREEN and quality GREEN with no remaining scoped findings or induced breakage.
C2 and I1 are closed; previously accepted command and ownership findings stayed closed.

The server now validates runtime projections with the canonical Draft-07 schema,
packaged under its main resources and checked against the edge copy. The pinned
validator is `com.networknt:json-schema-validator:2.0.4`. Full schedule updates
match one schema branch. Accepted request values reach persistence with the required
JSON types and canonical UUIDs. A shared 25-case matrix covers malformed SWT/VWC
sources, nested dendrometer sources and timestamp/type constraints. CI validates
five real persisted commands from the PostgreSQL service through the edge AJV gate.

Independent verification used Java 21 and the unchanged clean commit pair:

| Check | Result |
| --- | --- |
| Expanded backend regression selection | 587 tests, zero failures, errors or skips; exit 0 in 71.09 seconds |
| Five edge contract gates | All exit 0 |
| Vendor and Flyway checks, including both self-tests | All exit 0 |
| Original adversarial command/schema probes | 12/12 passed |
| Real persisted create, full update, partial update, pause and retry payloads | 5/5 passed AJV |
| Frozen runtime corpus, actual AJV | 78/78 passed |
| Same corpus using only the production JAR classes and dependencies | 78/78 passed |
| Production JAR schema | Exactly one copy, byte-identical to edge; test fixtures absent |

The schema SHA-256 is
`299077c6c9a2ef5198643606cfd6b35d7f2ee346a0fb4b12608395869dac4928`.
Evidence is retained in this plan's workspace under
`evidence/task-7a/root-fix4-expanded.json`, `root-fix4/manifest.json`,
`root-fix4-paired/manifest.json`, `root-fix4-runtime-ajv.log`, and
`root-fix4-packaged/manifest.json`. The scoped review is `task-7a-fix4-review.md`.
The packaged probe replaces the earlier private-method comparison while preserving
all 78 inputs and expected outcomes. No test-resource classpath supplied its schema.

Task7b1 now adds the edge replication core and migration 0077. Task7b2 will wire
actual link, delivery and command adapters before capability advertisement is complete.
The GUI and end-to-end gates follow those checkpoints.

## Edge replication core checkpoint

Task 7b1 is accepted at edge `72a4488f59bf2201be436989e05a57240b73e676` and
server `8c3dc80419086f819b4ff832deb5c2c72ac03620`. Sol returned specification
PASS and quality PASS with no remaining important or critical findings. This is
an internal checkpoint: it does not advertise the capability or enable deployment.
Task 7b2 still owns the shipped link, delivery, command and publication adapters.

The core stores peer support against the current account, server, gateway and
installation, rejects stale responses, and keeps background sync separate from
account-link attempts. Policy and lifecycle writers share the link fence. Runtime
projections and their supported-peer events commit atomically; stable revisions
and tombstones survive retirement, reassignment and outbox pruning. DENDRO decision
summaries contain derived analysis fields without raw analysis or invented sensor
identities. The shared schema permits null aggregate DENDRO identities while
retaining strict validation for soil sensors and non-null EUIs.

Migration 0077 adds the local projection cache and owns the policy and schedule
sync triggers. The historical migrations are unchanged. All seven bundled databases
are at ledger 77 with 296 fingerprints. The0077 checksum is
`e37e715cdf60d66903377046db44ce3feea1ed80805dbed067b0a84b54b3e34c`.
The paired schema checksum is
`fee17d2ab5d1e0d9c9369c8e99f28bddb39ad391dc632e572213d5084d0bea0d`.

Independent evidence on the clean pair:

| Check | Result |
| --- | --- |
| Policy and valve module suites | 598 tests per Pi profile, zero failures or skips |
| Actual UTC process replication suite | 23/23 passed; normal runs also covered Europe/Zurich and invalid timezone handling |
| Edge contract gates | All five passed |
| Expanded Java 21 backend suite | 587 tests, zero failures, errors or skips; 94.21 seconds |
| Shared runtime validation | 89/89 passed AJV and the production-JAR-only validator |
| Production schema packaging | One canonical schema, byte-identical to edge; test fixtures absent |
| Paired vendor/Flyway self-tests and live checks | All passed |
| Command/schema probes and actual persisted command boundary | 12/12 and 5/5 passed |
| Full sync, route, ACK, profile and verifier-base checks | Passed except the inherited silent-catch ratchet described below |
| Schema, seed and migration rehearsals | All 12 checks passed, including fresh 0077, 0076 upgrade, compatible table and customer numbering |

The silent-catch verifier remains red at 81 against baseline 80. Root reproduced
81 at the pinned upstream base, at the7b1 parent and at this candidate; 7b1 does
not edit flows. Task 7b2 explicitly owns the repair without raising the baseline,
and combinedTask 7b acceptance requires that gate to pass. This checkpoint is
not a claim that all feature or release gates are green.

Evidence remains in `evidence/task-7b1/`: `root-behavior/manifest.json`,
`root-core/manifest.json`, `root-flow/manifest.json`, `root-final-expanded.json`,
`root-final-paired/manifest.json`, `root-final-packaged/manifest.json`,
`root-final-89-ajv.log` and `root-utc-replication.log`. The final review is
`task-7b1-review.md`. Hardware tests remain not run and production qualification
remains false.

## Final software verification

All required software checks pass. The final code checkpoints are edge
`89b6ff9b63579600636d0af1ac953df7f7c380db` and cloud
`ad506b008b32a2a72cdbfa790f97e5600279f36c`. Both feature worktrees are preserved
for the next agent. Optional refactoring is deferred; nothing was pushed, merged
into a shared branch, deployed, or tested against production.

| Check | Independent result |
|---|---|
| Full Java 21 backend suite | 5,114 tests, zero failures/errors, two skips; 528.44 seconds. Backend sources stayed unchanged. |
| Final edge modules | 725 tests passed per Raspberry Pi profile. |
| Flow, contract and deployment checks | All prior failures closed; full sync, identity, contract staging, deploy coverage, command safety, radio history and inventory pass. |
| Paired contracts | Vendor and Flyway checks/self-tests, schema probes and fresh PostgreSQL-produced command export validation all pass. |
| Full frontend suites | Edge 2,864 Vitest tests plus TSX runner; cloud 2,721 Vitest tests plus TSX runner, two skipped tests. Later editor, preset and layout changes passed their affected suites. |
| Real-route browsers | 44 checks per app, zero failures, skips or flaky results. Root rerun: edge 76.94 seconds, cloud 66.27 seconds; frontend hashes stayed unchanged. |
| Final packaging | Edge typecheck/build pass. Cloud `./gradlew build --no-daemon --max-workers=2 -x test` passes, including frontend packaging and Terra dist/JAR checks; the separate full backend test run supplies test evidence. |
| CI registration | Final test inventory and inventory/runner self-tests pass with both browser configs and specs tracked. |

Browser coverage includes seven locales, light/dark themes, 320/390/1440 widths,
zone and valve entry points, keyboard/touch help, 44-pixel targets, stable selection
and form position, and the Moist-only Recommended text. It also checks actual
threshold/timing edits, pending versus rejected actions, conversion failures and
old-peer handling. Root inspected final mobile dark German and desktop English
screenshots, plus the corrected French 320-pixel layout. The last app fixes keep
SWT text readable in dark mode and allow the cloud schedule button to fit narrow
French and Italian layouts.

Sol accepted the remaining command/link, edge editor, cloud editor, color and
layout corrections. Final Task 9b, Task 10a and integrated software reviews each
pass specification and quality review with no open software blocker. Their
records are `task-9b-final-review.md`, `task-10a-review.md` and `final-review.md`
in the execution workspace. The backend lazy-actor and recovery-fixture failures,
terminal policy-save replay status, timezone edits, and stale link-attempt fence
all have passing regression evidence. Failed attempts remain preserved alongside
the later passing logs.

Evidence is under `.superpowers/sdd/2026-10-13-conditional-irrigation/evidence/`:
`task-10/root-full-server-6fcc`, `root-final-a61f`, `root-final-identity`,
`root-final-corrected-gates`, `root-final-paired`, `root-terminal-replay`,
`root-final-edge-build`, `root-final-server-build-0810`, `root-final-browsers`, and
`root-final-inventory`. Each runner records commands and exits; source-sensitive
runs include before/after hashes. Final browser JSON and screenshots are retained.
The prose checker passes for this report and the operations guide.

The unchanged-schema schedule-sync rehearsal and all seed/migration gates passed
earlier in the stack. Integration harness `266485312` passed all 23 tests and its
Sol review. The activation-history probe completed enabled DENDRO edits with
10,000 and 100,000 source rows in 145.59 ms and 391.46 ms on a Ryzen 7 5800H
workstation, at most 256 rows per page. These test-provider measurements do not
qualify Pi latency. Final local packaging used an empty map token and
`TERRA_REQUIRE_MAP=0`; it does not qualify a map-enabled published release.

Both origins were refreshed during finalization and matched the integrated bases
above. The operating procedure and remaining physical evidence are in
[Conditional irrigation](../../operations/conditional-irrigation.md).

## Qualification limits

No physical valve, queue-expiry bench, NTP hook, or delivery-latency qualification
has run. Slice A has no hardware gate. Conditional activation requires all software
gates plus the Gen1/Gen2 clear-program, delayed-ACK, queue/clock/power-loss and
latency checks specified in the plan. A passing ACK ledger cannot prove physical
program identity; that protocol limitation remains explicit.

The shared STREGA transport also changes ordinary manual, schedule, cancel and
unclaim paths. Disabling conditional activation does not undo those transport
changes. Their software regressions and physical transport qualification belong
to the release evidence; only the separate SWT preset slice is hardware-independent.

## Release gates

| Gate | Current evidence | Required before activation |
|---|---|---|
| SWT preset UI | Accepted; final tests, builds and paired browser checks pass | No hardware gate for the standalone preset slice |
| Condition evidence and storage | Accepted; module, integration, migration and history rehearsals pass | No remaining software gate in this slice |
| Clock and schedule feasibility | Core and runtime integration accepted; software checks pass | Real NTP/reboot qualification |
| Command dispatch and conversion | Dispatch, API/worker, conversion and observation/history integration accepted; final module and integration checks pass | Physical transport qualification |
| Cloud compatibility | Core and shipped adapters accepted; final backend, contracts and packaging pass | No remaining software gate in this slice |
| Policy UI and browser behavior | Both editors accepted; unit/build checks and 88 real-route browser checks pass; CI registration verified | No remaining software gate in this slice |
| Gen1 and Gen2 physical behavior | Not run | All Gen1 weekdays cleared; Gen2 one-byte clear accepted; delayed ACK behavior |
| Delivery and recovery bench | Not run | Expiry/offline uplinks, flush/send race, power loss and actual NTP hook events |
| Delivery latency | Not run | At least20 opens per generation, worst uplink phase and queue contention; p95/max/count and runtime versions |
| Finite command release | Core and live integration implemented and reviewed; hardware qualification absent | Qualified selection-to-open and selection-to-final-CLOSED bounds, lost endpoints and close-only behavior |
| Qualification identity | No reliable deployed firmware identity or production registry exists | Match captured qualification to reliable current identity; default false, reject revoked/mismatched bounds |

Software slices used Luna implementation and Sol review. Passing
software checks alone will not enable conditional dispatch. The production
qualification provider must remain false until the physical evidence is available.
