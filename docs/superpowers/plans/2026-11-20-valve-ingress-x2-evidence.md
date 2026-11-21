# X2 extraction evidence

X2 retains thirteen `osi-valve-control` ingress exports and puts their implementation in an independent `osi-command-ingress` package. The proposed Function adapters load that independent package. Non-valve routing, early authentication and refusals, accepted-response formatting and run-log shaping therefore do not enter the valve package. The existing declared `osi-lib` binding also carries a generated, lazy fallback image of those same entry implementations. It requires no optional package or extra file. An absent or quarantined ingress package executes that image, preserving the same contract. The valve index loads X2 compatibility exports lazily, so existing valve exports remain available independently. Direct X2 compatibility calls also execute the bundled implementations without importing the optional package. The loader file is 104,145 bytes per profile; the fallback compiles only on first use. Physical dispatch, queue ownership, ACK workers and cancellation logic remain unchanged.

Neither maintained `flows.json` is edited. X1 comes first; X2 still has no reservation. The five reviewed `osiLib` additions remain exactly one named binding each, with all other libraries unchanged.

The frozen source is ec822b556. The original task started READY there, behind 0/ahead 0, with AGENTS.md revision c63103827; the preparation base later advanced to 1a984f31f for a runbook-only change. The first fix round resumed reviewed head 3825a576 against that intended base. Sol r3 follow-up rebased the branch onto main bda200db6, retaining its atomic flow writer and emulator gates. Post-rebase readiness is READY, behind 0/ahead 5, with the same AGENTS.md revision.

## Preserved behavior and approved exceptions

The 554-case frozen corpus and its 1,108 hashes are untouched. Each case compares the frozen node, the shipped node and the proposed adapter on both profiles, including ordered dependency effects, exact SQL/JSON strings, error markers and HTTP handle identity. The renderer also accepts a fully applied, verified adapter set, so the same comparison runs after application.

Only two behavior differences are authorized: six formerly empty catches now emit contextual warnings while retaining their fallback and operation order; a failed or quarantined valve load on a path that needs it returns 503. The original oracle retains its original warnings and statuses. Comparators remove only the six named diagnostic additions and normalize the specific valve-unavailable 503 back to its legacy 500 for comparison. Source tests pin all other executable text.

| Path | Result retained by the extraction |
| --- | --- |
| REGISTER_DEVICE, linked auth, force-sync | Original routing port; no valve lookup |
| SDI-12 identify | Original ports 1 and 6 and SUCCESS ACK |
| Fan and reboot | Original ACKs and OS operation order; reboot callback runs after the ACK is observed |
| Missing bearer | Native thrown 401 and MISSING_BEARER marker, except cancel's original returned refusal |
| Cancel validation and ownership | Original 400/404/409/403, device lookup and DB close before any valve lookup |
| Ownership and builder refusal | Original 401 and 404 before any valve lookup |
| Advanced formatter and run-log builder | Original 202 after the upstream state update, and exact INSERT message, even with a failed valve package |
| Manual command acceptance | Deferred 202 after transport acceptance; top-level request/response handles retained |
| Definite enqueue refusal | 422; no success log or target-state write |
| Preflight or uncertain transport | 503 with the existing uncertainty fields and reservation behavior |
| Conditional open cancelled after possible handoff | 409, handed_off; queue flushed, collateral reported, unresolved reservation remains and refuses another reservation as valve_busy |
| Ordinary cancel queue-read failure | Legacy full flush and 200; target marked CANCELLED |
| Ordinary cancel flush failure or timeout | Legacy 500; target remains PENDING_OBSERVATION |
| Conditional cancel flush failure or timeout | 503, uncertain; target remains PENDING_OBSERVATION |
| Ordinary collateral requeue failure | Legacy 200 with transport_uncertain false; lost item diagnosed, target CANCELLED, setting no longer queued |
| Close callback reports an error | Legacy callback error remains ignored; a thrown close error now also emits the approved diagnostic |

Unknown command types still return null; malformed cloud JSON still throws. These legacy cases remain pinned. Every recognized non-valve command keeps its output or ACK when valve loading fails. No physical CLOSE was added to cancellation. K3 PR #697 supplies case names only.

## Review-fix coverage

Real-loader tests compile the shipped `osi-lib` loader and independently remove command ingress, valve control or scope, then exercise first-failure and quarantine states on both profiles. All 554 frozen cases run for each dependency and state. An isolated valve-package copy proves that every existing export remains loadable without ingress, and that the index never imports X2 compatibility modules eagerly. Tests assert that pure ingress never consults the valve loader. The fallback image is generated from the entry sources and checked byte for byte in CI.

The additive fixture has 22 cases per profile: snake-case and absent ACK metadata, missing gateway identity, VALVE_COMMAND minute fallbacks, interval defaults and explicit wire fields, numeric LSN50 mode, JWT_SECRET-only auth on all eight handlers, absent builder actor/zone, scope-resolver warnings, missing/non-numeric/null fan speed and callback-delivered close errors. Each has branch assertions as well as a frozen output hash. Capture validates the pinned source and uses a separate, write-once file. For first capture only, the additive file may be absent; the computed bytes must match its committed SHA-256 before exclusive creation. Other oracle inputs remain required. The old oracle-overwrite option is rejected. Every environment-selected evidence writer reserves a descriptor with exclusive creation before running and never reopens the pathname. Negative controls target each oracle through every writer, plus a symlink and a pathname-replacement race.

Another 28 tests compare the immediate predecessor's frozen ingress with the proposed adapters over the shipped database and real valve/scope helpers. They record every SQL operation and result, queue RPC, node output, outbox row, run-log row and ACK in order. Scenarios cover all five command lanes, duplicate uplinks, restart while observed running, cancellation during reservation, downstream run-log INSERT failure, actual queue-read/flush/timeout/requeue failures, a scoped device lookup failure after successful access, and close callback errors. SQLite clock and random functions are deterministic. The separate UC512 dispatch tests remain in the existing safety lane.

The native matrix runs unwrapped Function bodies with their declared libraries on Node 20.18.3 and Node-RED 3.1.15/4.0.9. It observes native completion, Catch delivery, diagnostics and both receivers on every output port. IO doubles sit behind the declared bindings. A native extra-port mutant and a thrown-auth-error-to-returned-reply mutant must fail in each runtime. The returned-auth mutant first proves exactly one 401 per receiver on the second output and zero Catch deliveries. The native comparison also executes the fallback through the actual loader after a missing ingress lookup and subsequent quarantine. Reboot callbacks advance only after the SUCCESS ACK reaches the receivers. Native-generated message IDs are deterministic; only phase labels and incidental stack frames are removed from native comparisons.

Auth discovery follows verified adapters into the exact entry implementation and retains all eight X2 handlers per profile: 200 total handlers. Configured-secret and filesystem variants remain. Extracted entries use a sticky scope sentinel, including when the code catches it; an internal mutation proves detection on both profiles. Existing inline handlers retain their previous sentinel classification.

## Handoff and staged CI

The manifest permits only `func` and the five approved `libs` appends. The independent renderer validates the manifest, full node contract and source hash, refuses partial application, and is idempotent on the exact rendered set. Oracle inputs are pinned by committed content digests; the handoff reads the main-ancestry base bda200db6. No validator needs PR-only history. A fresh transport clone of a local squash-equivalent commit contains no PR head object or refs and runs parity plus handoff validation before and after application. A checked-in binary Git patch must equal its canonical diff byte for byte. The application command first applies the patch to a temporary index and compares every receipt file before changing the target. Any Git diagnostic fails, even with exit status zero. The disposable staged tree then checks actual forward, reverse and reapplication bytes, including both baseline files; it never writes renderer results over a failed application. The binary patch retains its required final blank separator. A path-specific Git attribute permits that separator.

The patch includes the silent-catch baseline update from 65 to 59 per profile. Its receipt also records the DDL recount: 694, unchanged. These are staged with the flow replacement, never applied to the reserved files in this checkout. `node scripts/apply-valve-ingress-x2-adapters.js` validates the handoff without writing it. After X1 and the reservation, refresh the handoff against the approved base; the current whole-file pins deliberately refuse unrelated base drift.

The staged workflow checks the exact PR head, applies both proposed flow files in a disposable clone, then runs parity, the existing SDI-12, conditional-writer, request-context and missing-module HTTP checks. Their command, wire, isolation-mutant and encoder-visit assertions remain. Full sync, migrations, smoke and shell suites are GitHub CI gates on the exact head, per the CTO rule; none was queued locally in this fix round. New tests are registered in the X2 workflow, including both runtime negative controls. The deploy staging list and both profile package registrations include the independent ingress package; activation and SHA pins are unchanged.

## Local verification before Sol r2

| Check | Fix-round result |
| --- | --- |
| Frozen VM comparison, including staged rerun | 554 cases x 2 profiles passed |
| Additive legacy comparison | 22 branch-asserted cases x 2 profiles passed |
| Focused staged integration tests | 880 passed, 0 failed before expanding real-loader coverage |
| Expanded real-loader and capture controls | 2,219 passed, including all 2,216 missing/quarantined comparisons |
| Staged entry-point tests | 16 passed, 0 failed |
| Valve and loader module tests | 947 passed, 0 failed |
| Existing safety, HTTP and release-equivalence regressions | 282 passed, 0 failed with proposed adapters |
| Native Function/Catch matrix and both negative controls | 576 cases x 2 profiles on both pinned runtimes; see retained logs |
| Adapter/patch and write-once controls | Passed in the staged gate |
| Profile parity and helper registration | Passed |
| Deployment shell syntax | Passed |

The first pushed fix head, 0cc95180b, passed GitHub sync, migrations, smoke and shell gates. Its extraction workflow failed before staged execution because Fedora and Ubuntu Git builds compressed identical binary delta data differently. Binary patch payloads now use deterministic stored DEFLATE blocks; a cross-compression control and forward/reverse application pass. No payload file changed in this CI follow-up.

The review supplies the initial red evidence. Local development also caught and corrected missing staged guard dependencies, native harness startup/binding errors, a native-generated error-message ID difference and incorrect expectations about legacy cancellation replies. Negative controls remain checked in and run in CI.

Logs and side-by-side traces are retained under `/home/phil/builds/osi-v082-fix-20261112/plan-0.9/evidence-X2/`: `round2-staged.log`, `round2-modules.log`, `round2-regressions.log`, `round2-stateful.json`, `round2-additive.json` and `round2-native-{image,stock}.{log,json}`. CI uploads its own traces. These are local software fixtures; no gateway or live valve was accessed. This implementation child leaves the draft for the lead's exact-head CI gate and independent review.

## Original preparation time


These are measured elapsed windows from timestamped work and gate artifacts. Preparation was interleaved, and admission waits are included, so the rows overlap and must not be added as focused engineering hours. A separate active-hour split was not captured.

| Part | UTC window | Elapsed hours |
| --- | --- | ---: |
| Characterization and runtime parity | 19 Nov 23:44 to 20 Nov 01:03:18 | 1.32 |
| Module preparation through its test result | 19 Nov 23:52:21 to 20 Nov 01:04:18 | 1.20 |
| Adapter preparation through HTTP parity | 19 Nov 23:53:08 to 20 Nov 01:04:51 | 1.20 |
| Flows reservation | Not granted or used | 0.00 |

The total preparation/validation window was 1.35 hours. Module files were generated at 00:58:02 after the corrected pre-extraction baseline passed; the first new-entry gates completed at 00:58:03. This preparation does not measure exclusive flows occupancy or validate the proposed reservation-duration estimate.



## Review fix-round timing

Round start: 2026-11-20T01:26:15Z. Round stop: 2026-11-20T08:38:55Z.

| Sub-step | UTC start | UTC stop | Hours |
| --- | --- | --- | ---: |
| Independent ingress, early replies and diagnostics | 2026-11-20T01:28:06Z | 2026-11-20T01:37:13Z | 0.1519 |
| Renderer, patch and staged CI guard integration | 2026-11-20T01:37:13Z | 2026-11-20T01:59:49Z | 0.3767 |
| Native Function lifecycle and additive stateful characterization | 2026-11-20T01:59:49Z | 2026-11-20T02:10:00Z | 0.1697 |
| Focused staged verification, module regressions and handoff evidence | 2026-11-20T02:10:00Z | 2026-11-20T02:17:14Z | 0.1206 |
| Publication and blocking tool return | 2026-11-20T02:17:14Z | 2026-11-20T08:35:22Z | 6.3022 |
| CI binary patch portability fix and focused verification | 2026-11-20T08:35:22Z | 2026-11-20T08:38:55Z | 0.0592 |

Total fix-round elapsed time: 7.2111 hours, including 6.3022 hours for publication and a blocking tool return. The command reported 22,599.148 seconds of wall time; that interval is not engineering work. Excluding the publication/tool-return window, the measured implementation and verification windows total 0.9089 hours. The first implementation stop and push were at 02:17 UTC; the CI follow-up began at 08:35:22 UTC. Reservation time remains 0.0000 hours.

## Sol r2 fix-round timing

Round start: 2026-11-20T11:14:17Z. Round stop: 2026-11-20T11:45:39Z.

| Sub-step | UTC start | UTC stop | Hours |
| --- | --- | --- | ---: |
| Review and startup | 2026-11-20T11:14:17Z | 2026-11-20T11:15:40Z | 0.0231 |
| Dependency fallback, squash and evidence fixes, including admission wait | 2026-11-20T11:15:40Z | 2026-11-20T11:24:43Z | 0.1508 |
| Focused validation and handoff | 2026-11-20T11:24:43Z | 2026-11-20T11:45:39Z | 0.3489 |

The review's four findings supply the red evidence. This round keeps both reserved flows and the four oracle inputs byte-identical. No full local suite was queued; the local gate contains parity, characterization and module tests. Main advanced during this round and GitHub reported merge conflicts. The reviewed base is deliberately retained pending X1 integration. The X2 workflow also runs on pushes to this task branch so its exact-head staging gate can run while the PR is conflicted; the other full PR suites still await base integration; all three base-sensitive staged verifier refs are pinned to 1a984f31f, as AGENTS.md requires for a stack. Startup was WARN for NO_FAST_CHECK at 58643ee63, behind 0/ahead 3 against intended base 1a984f31f, with AGENTS.md revision c63103827.

Sol r2 follow-up checks passed locally: 6,652 dependency-failure/export tests, including direct compatibility calls without ingress; 7,142 staged integration assertions plus 16 entry-point tests; and 947 module tests. Both pinned native runtimes passed 576 cases per profile against the primary and real missing/quarantined-ingress fallback. The extra-port and corrected returned-auth controls were rejected after their required assertions. The squash-only clone passed before/after parity and handoff checks and contained only squash/main-ancestry commit objects. Evidence-path controls cover all four writers, every oracle file, symlink aliases, duplicate writes and a pathname-replacement race. Logs use the r3 prefix in the evidence directory.

This round elapsed 0.5228 hours, including shared osi-heavy admission waits. Exclusive engineering time was not measured. Flows reservation time remains 0.0000 hours.


## Sol r3 fixes and rebase

Both remaining findings are fixed in the handoff tooling. A raw cached-patch regression checks all four receipt files and the complete index tree after reverse application. Truncated and omitted-baseline controls exercise both working-tree and cached application; refusal must leave both targets unchanged. The first-capture regression deletes only the additive fixture in a disposable tree, recreates its exact committed bytes, rejects a second capture and refuses altered case records before creating a file. These tests run in the existing X2 CI handoff suite, including after staged application. The review records the original corrupt-binary-patch and ENOENT failures; they are the red evidence for this round.

Rebasing retained main PRs #714, #716, #732 and #734. The conflicts were confined to module registration lists and loader tests; both Clover and command ingress remain registered. Range comparison shows no lost X2 behavior. Both flow files, all seven bundled DB images, migration files and baseline/allowance files match main. The four original oracle inputs and their digest pins match the reviewed head. The patch and receipt now reference reachable main bda200db6, and obsolete stacked-base workflow overrides are removed. X1 still precedes X2; no reservation was used.

Local static checks passed: profile parity, helper registration, canonical handoff validation, generated fallback comparison, JavaScript parse checks, deployment shell syntax and diff whitespace. The first lookup used an incorrect verifier filename; rerunning the actual `verify-helper-registration.js` passed. No test success is inferred from that failed lookup.

The focused local wrapper waited from 11:32:17 to 11:39:09 UTC without admission, behind two firmware builds, and was cancelled before running. Its proposed red/green, parity and module commands therefore produced no local results. The required frozen parity, squash-only validation and both pinned native matrices passed on GitHub at code head e90277512a; the staged characterization step was still running when evidence was recorded. Full sync, migrations, smoke and shell fixtures remain exact-head CI gates. No full local suite was queued, and the cancelled wrapper leaves no delayed test run.

Logs: `r4-static.log` in the evidence directory. GitHub retains its own test results and traces; the final report identifies the publication head and its CI snapshot. Prior-round pass counts above describe those earlier heads, not a local rerun in this round.

## Sol r3 fix-round timing

Round start: 2026-11-21T11:24:25Z. Round stop: 2026-11-21T11:40:26Z.

| Sub-step | UTC start | UTC stop | Hours |
| --- | --- | --- | ---: |
| Review, rebase and implementation | 2026-11-21T11:24:25Z | 2026-11-21T11:37:05Z | 0.2111 |
| First publication and static verification | 2026-11-21T11:37:05Z | 2026-11-21T11:38:41Z | 0.0267 |
| CI snapshot and evidence handoff | 2026-11-21T11:38:41Z | 2026-11-21T11:40:26Z | 0.0292 |

This round elapsed 0.2669 hours through the implementation/evidence stop, including the unadmitted local test wait. Final documentation publication follows this stop. Exclusive engineering time was not measured. Flows reservation time remains 0.0000 hours.
