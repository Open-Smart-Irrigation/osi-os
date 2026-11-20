# X1 execution report

The module and exact offline adapters are prepared. Neither shipped `flows.json` was changed. Integration remains reserved until the dispatcher grants X1 after EB19; this draft must not merge before that swap, renewed parity checks and the required Sol review of dispatch order, queue state and error paths.

## Startup and source

Startup readiness: READY, HEAD and intended base `origin/main` at `ec822b556`, behind/ahead 0/0, AGENTS revision `c63103827`. The branch was later rebased onto the docs-only main commit `1a984f31f`; module/test code did not change. The stale initial checkout was replaced by a fresh branch from the remote base in this isolated worktree, as the implementer brief requires.

The committed `legacy-nodes.json` and `expected.json` record the baseline tests and outputs from before module generation. Their hashes are pinned in the committed `oracle-pins.json`; checks read those tree files without consulting PR history. Six bodies move into `osi-daily-scheduler`, mirrored across both profiles: query builders in `queries.js`, evaluation in `decision.js`, and auth/validation/save in `schedule-save.js`. The existing UTC-window helper is exported. SWT eligibility SQL remains owned by `osi-scheduler-mean-query`.

The module preserves the existing outputs, including early IRRIGATE/event/update emission despite downstream refusal, UTC-day suppression, server-preferred DENDRO selection and the first-save schedule-event defect. The real seed-schema persistence characterization records schedule event counts `0 → 1 → 2` for first save, edit and disable. Request state stays on `msg.osi.request`.

## Review fix round, 20 November

All seven findings in the first Sol review have fixes on the same branch. Startup resume at the reviewed head was READY at 01:25:52 UTC: intended base `origin/main` at `1a984f31f`, behind/ahead 0/3, AGENTS revision `c63103827`. The reservation queue remains EB2 → EB12 → EB19 → X1. Both shipped flow files and the original `legacy-nodes.json` and `expected.json` are unchanged.

The existing SWT and Chameleon link-ingest suites load each profile's real scheduler while retaining selective mean-helper failure injection and every original assertion. Their staged results are 91/91 and 49/49. The request-context mutation copies carry their matching module roots. Chameleon link-ingest is now part of the prepared CI gate.

The Chameleon verifier uses array-keyed calibration, executes the actual Apply Config loader against SQLite and checks all nine coefficient mappings. It follows the current normalization/writer and history interfaces, checks the current calibration table in every bundled seed, and reaches the staged scheduler query. Its successful output includes `scheduler query reached: daily-scheduler -> scheduler-mean-query`. SWT eligibility SQL remains in the mean-query module.

Legacy authentication and validation replies execute before the scheduler load, including the bearer marker used by the native device-API Catch. Decode Token passes its locally verified auth as a trusted dependency to avoid repeating secret IO. Request data cannot supply that dependency. Only missing/quarantined scheduler loads on otherwise valid HTTP paths have the approved new behavior: a diagnostic and one 503 reply. Native tests assert that no duplicate Catch response follows it. Early failures and quiet drops remain equal to the frozen legacy outputs.

The runtime harness now uses the declared libraries, native Function ports, Complete and Catch nodes, and the actual device-API error formatter. IO and clock doubles sit outside that lifecycle. It compares every port message after event-loop delivery settles. Both Node-RED 3.1.15 and 4.0.9 on Node 20.18.3 pass 482 profile-cases, including 66 Catch deliveries per runtime; frozen native observations replay successfully. Each runtime rejects both a duplicate-send mutant and an extra-port mutant at the parity comparison. The earlier bridge evidence below is historical and is superseded by this native evidence.

Additive, exclusively created fixtures capture 42 branch-asserted cases and 50 real SQLite/reservation sequence traces from the pinned legacy nodes. They cover in-flight snapshots, reassignment, reload/restart, a stored conditional occurrence, queue refusal, UTC/DST boundaries, partial writes, scoped reads, failed saves and interleaved writers. Native fixtures also exercise SQL errors through Catch and all seven real scoped-read failure boundaries. The original oracle is never regenerated.

Auth discovery retains all 200 handler instances across the staged pair. The guard loads the real scheduler with the scope sentinel for both secret variants. Request-context checks scan the wrapper and delegated function together. Wrapper and module mutants must fail both guards. CI also compares the checked-in patch with the renderer and verifies frozen source hashes plus exclusive oracle creation.

The staged baseline receipt records 65 silent catches and 347 DDL markers in each profile. The extracted modules contain zero empty catches; no silent catch was moved. The approved parity exception requires a visible diagnostic if one is encountered during integration. The missing/quarantined-load warning and 503 are the only new behavior used in this round. Schedule persistence remains separate from decision evaluation; UTC-day suppression and the early IRRIGATE event remain characterized.

Current focused results, timestamps, exit codes and pass signals are in [fix-results.json](fix-results.json). Full migration, sync, smoke and shell gates run only in GitHub CI on the pushed head. No local full suite ran in this round. A focused wrapper with an incorrectly constructed future loader command was cancelled before that command ran; the corrected explicit 12-test loader selection passed.

## Initial extraction evidence

The final focused results are in [results.json](results.json). The baseline and extraction sequence, including the initial Node-RED fixture error and its successful rerun, are in [phases.json](phases.json).

| Check | Result |
|---|---|
| Characterization before extraction | 378 cases across both profiles passed |
| Node 22.23.1 parity | 378 cases passed; baseline = shipped = module = prepared adapter |
| Node 20.18.3 parity | 378 cases passed with the same assertions |
| Node-RED 3.1.15 on Node 20.18.3 | 1,134 comparisons passed, both profiles |
| Node-RED 4.0.9 on Node 20.18.3 | 1,134 comparisons passed, both profiles |
| Clock tests | 3 passed; exported helper plus shipped/prepared adapter behavior |
| Loader module tests | 12 passed across both profiles |
| Negative control | Exit 1 as expected when command duration is changed by one minute |

The runtime pins come from `.github/workflows/release-smoke.yml`: Node 20.18.3, image Node-RED 3.1.15 and stock Node-RED 4.0.9. The feed's Node-RED Makefile pins 3.1.15; both image configs enable Node and Node-RED. Local runtime runs used x64 binaries and synthetic dependencies, not hardware or a gateway database.

All output positions, exact SQL/payload text, message mutations, dependency effects, diagnostics and error names/messages/status fields are compared with a fixed clock. Error stack source locations are excluded. [outputs-side-by-side.json](../../../../scripts/fixtures/daily-scheduler/evidence/outputs-side-by-side.json) shows literal before/after records for eight representative cases on each profile; the complete frozen records are in `scripts/fixtures/daily-scheduler/expected.json`.

The Node-RED fixture initially omitted coordinates and read nodes before startup completed. Adding coordinates and awaiting `flows:started` fixed that fixture. No scheduler behavior changed to make the tests pass.

## CI gate

Under the CTO rule of 20 November, full suites run in GitHub CI on the exact PR head. The queued local full-suite wrapper was cancelled before it ran. Only focused X1 characterization, parity, clock and loader tests ran locally.

The new tests are registered in the migrations and release-smoke workflows. CI also exercises prepared adapters through a test-only read substitution, including the existing authorization/interleaving/SWT/DENDRO tests and flow/source guards. This substitution never writes either reserved file. Existing source guards follow the exported entry points; their assertions remain in place. Full sync, migration, smoke and shell-fixture results remain a CI gate, not a local claim.

## Flows handoff

[flows-handoff.patch](../../../../scripts/fixtures/daily-scheduler/evidence/flows-handoff.patch) is the exact review patch for both profiles. Generate scratch copies with:

```sh
node scripts/prepare-daily-scheduler-adapters.js --output-dir /path/to/review-directory
```

After the reservation is granted, apply the JSON mutation using the skill's one-shot parse/mutate/serialize procedure. The patch is a review artifact. The preparation script checks round trips, profile equality, original source and wiring before preparing changes. A changed target body requires re-characterization.

| Node | Entry point | Outputs |
|---|---|---:|
| Build zones query (enabled schedules) | `buildZonesQuery` | 1 |
| Build mean query (last hour, all datapoints) | `buildMeanQuery` | 1 |
| Decide + build actuator cmd + build DB logs | `decide` | 3 |
| Decode Token | `decodeToken` | 2 |
| Verify Zone Ownership | `verifyZoneOwnership` | 2 |
| Build UPSERT | `buildUpsert` | 2 |

IDs and wiring are unchanged. Existing libs are retained; the four nodes without an osi-lib binding gain only that binding. This is necessary for the proposal's guarded loader call. [reserved-flow-hashes.json](reserved-flow-hashes.json) records the unchanged source hashes against the base.

## Timing

Measurements use UTC wall time. Characterization/preparation began at 23:43:56 on 19 November; successful baseline capture began at 00:58:05 on 20 November. That window was 1.2358 hours, dominated by shared-slot queueing. Module/adapter generator preparation overlapped that wait between 23:49:13 and 23:51:17 (0.0344 hours).

| Required part | Directly timed execution (hours) |
|---|---:|
| Characterization | 0.000254 for the successful baseline; final focused test durations are in results.json |
| Module | 0.000028 for extraction, after the baseline commit |
| Adapter patch | 0.000063 for scratch-profile preparation, plus patch serialization |
| Reservation window | 0 hours; not granted |

These command durations are not exclusive authoring hours. Initial module and adapter preparation were interleaved and were not separately stopwatch-logged; an exclusive four-part authoring split cannot be reconstructed reliably. The overlap is reported rather than inventing that split. Review fixes and actual reservation occupancy must be appended by the dispatcher before using X1 as a complete engineering-cost estimate.

## Fix-round time record

All times are UTC on 20 November 2026. The round began at 01:25:43. Code-fix and focused-gate windows overlap; they must not be added as exclusive author hours. Failed calibration-verifier attempts and native-control marker repair are included in these windows. The reservation cost remains zero.

| Sub-step | Start UTC | Stop UTC | Wall hours |
|---|---|---|---:|
| fix | 01:28:50 | 02:06:19 | 0.624722 |
| local-gates | 01:43:48 | 02:06:19 | 0.375278 |

The completed handoff-preparation, push and CI-observation windows, exact head, final round stop and total measured hours are appended after push in the lead's execution receipt: `/home/phil/builds/osi-v082-fix-20261112/reviews/705-x1-fix-execution-report.md`. That receipt accompanies the PR handoff; it avoids changing the head merely to record its post-push timing.

## Squash portability and evidence boundaries

The follow-up audit removes PR-commit provenance references from this report. Frozen-source verification reads committed fixtures and their tree-resident hash pins. Parity and the handoff renderer have no dependency on PR history. The only Git command in the handoff check applies the committed patch to scratch files.

All X1 artifact writers now create files exclusively, including the native harness child's output and the scratch adapter preparer. Native result names include the profile to avoid reusing an output path. Existing oracle bytes remain fixed. Five focused boundary tests cover existing files, symlink targets, repeated preparation and capture flags with inherited output variables. The native control also attempts to replace a copy of the original oracle and requires EEXIST with unchanged bytes.

The real per-profile loader remains available when the extraction package has a broken dependency. Existing mean-query and scope packages still load; an eager-import mutant must fail. Conversely, a broken mean-query helper is loaded only when evaluation needs it, leaving the scheduler package and unrelated packages available. No existing package index eagerly imports an extraction adapter. These checks are registered in migrations CI, and the native overwrite control runs in both pinned runtime jobs.

The fresh-clone proof constructs a local commit with the candidate tree and a main-ancestry parent, then clones only its squash branch through Git's transport with no PR refs or object alternates. It checks that every PR-only commit object is absent, then runs original and additive parity, SQLite sequence parity, handoff and evidence/dependency boundary tests from that clone. Its commit identifiers, exact commands, results and measured follow-up windows are recorded after the run in `/home/phil/builds/osi-v082-fix-20261112/reviews/705-x1-portability-execution-report.md`.
