# Source-preserving history execution record

The local repair keeps each measurement trace attached to one physical device and channel through raw storage reads, retained rollups, API serialization and charts. It uses existing stores without schema, ingestion, calibration, retention or sync changes. Independent review and final verification are complete.

The revised design is recorded in [the implementation plan](../plans/2026-10-18-source-preserving-history.md), and the wire contract in [history-source-v2](../../contracts/history-source-v2/README.md).

## Delivery

| Branch | Implementation revision | Status |
| --- | --- | --- |
| Main edge `fix/source-preserving-history` | `a6c0a59b5` (runtime `63671f2b6`) | Reviewed and verified |
| Main cloud `fix/source-preserving-history` | `80ff08b1d` (client `17a3f29cb`) | Reviewed and verified |
| Edge preview `fix/source-preserving-history-preview` | `58980c971` | Reviewed and verified |
| Cloud preview `fix/source-preserving-history-preview` | `01ba4e93d` | Reviewed and verified |

All branches are local. No push, merge, deployment, production access or live gateway verification is recorded. The preview clients consume the corrected main backend; their older backend divergence is excluded from this repair.

## Behavior verified

The five-observation synthetic fixture produces separate A and B series. A keeps its middle 15-minute null gap; B keeps all three high readings. Raw values remain exact. Edge aggregates retain their existing three-decimal rounding, with a 0.0005 kPa test tolerance. Raw asynchronous observations remain connected within their own source, while tooltips show only observations present at the hovered timestamp. Explicit nulls retain their availability explanation.

Cloud retained hourly, daily and weekly grids distinguish absent rows from persisted zero-sample markers. Weekly reconstruction weights means by sample count and reports noncomposable or incomplete statistics explicitly. Candidate selection prefers fuller retained evidence, then coverage, then write time. Edge recovery shares its raw scan budget across missing buckets and the live tail. Selected and all-source mixed-device requests both read source-keyed retained rows.

Fresh empty authorized scopes fail closed before a pooled or unscoped query. A root-card contributor already returned to the viewer remains selectable even when claimed by a member; other device-access policies remain unchanged. Source selection is validated against the current scope.

Interactive requests retain the 30,000-row raw limit and 2,000-point-per-series limit, with a new 30,000-point total response limit. Both retained and raw-derived aggregate grids are checked before reads and allocation. Raw output is counted before projection. Rejection retains authorized descriptors, returns no partial traces and uses top-level availability reasons. Clients offer source/shorter-range recovery for raw-scan overflow and source/coarser aggregation for point-budget overflow.

Legacy edge device-history requests remain device-specific beyond 24 hours. An actual 30,001-row HTTP fixture returns 413 for both 24-hour and 48-hour requests, rather than a successful empty array.

## Verification

| Check | Evidence |
| --- | --- |
| Final cloud backend | 5,036 tests, zero failures/errors, two skips at `80ff08b1d` |
| Cloud architecture | Five tests passed at the same backend revision |
| Edge runtime | Both-profile source and HTTP guards, router tests, required flow/sync gates and payload parity passed at `63671f2b6`; final test-only `a6c0a59b5` passed five shipped HTTP/SQLite tests, including retained-prefix recovery and live-tail overflow |
| Main edge frontend | Full suite: 236 TSX and 2,729 Vitest tests passed at `381170f8c`; final affected tests: 80 passed; final profile tests: six passed; typecheck and build passed at `63671f2b6` |
| Main cloud frontend | Full suite: 169 TSX and 2,574 Vitest tests passed, two skips at `f29f90be9`; final affected tests: 17 passed; locale gate: 14 passed; typecheck and build passed through `17a3f29cb` |
| Actual API boundaries | Shipped edge HTTP function with SQLite; cloud repository, scope, service and controller with PostgreSQL |
| Built main clients | Raw and 15-minute plots at mobile and desktop widths on both hosts; 12 budget-recovery action cases passed |
| Cloud packaging | Boot JAR and normal Terra verification passed; all 106 current frontend files and 303 Terra files match the final JAR bytes at `80ff08b1d` |
| Final edge preview | 228 TSX and 2,616 Vitest tests passed; fresh installed-source parity, typecheck and enabled build passed |
| Final cloud preview | 170 TSX and 2,484 Vitest tests passed, two skips; fresh installed-source parity, typecheck and enabled build passed |
| Shared uPlot package | 66 tests and build passed in each copy; source/tests match; shorter-prefetch regression also passes alone |
| Built preview clients | 20/20 browser cases passed, plus actual edge A/B-to-C recovery and missing-identity rejection on both desktop hosts |
| Final combined review | All seven Important findings resolved; scoped specification and code-quality verdicts GREEN, no new issues |

The full backend command was `./gradlew test archTest --continue -x buildFrontend -x buildTerraIntelligenceFrontend --no-daemon --max-workers=2`. Frontend builds were verified separately. Packaging used `./gradlew bootJar -x buildFrontend -x buildTerraIntelligenceFrontend --no-daemon --max-workers=2` after those builds; the normal release-token and Terra artifact checks remained enabled. Terra used its supported local map-unavailable mode.

The 12 browser recovery cases cover source, shorter-range and coarser actions across both hosts and viewports. They verify the next request; source recovery also restores a finite plot from a captured narrowed backend response. Shorter/coarser cases continue serving the rejection fixture and therefore prove request changes, not server recovery for those exact browser requests. Ordinary `no_data` has component-test evidence. Auxiliary auth, farm and card routes are synthetic; these are consumer-fixture checks, not live API end-to-end tests.

An earlier full cloud run failed one unchanged soil-profile worker test; its isolated rerun and subsequent full runs passed. The cause of that intermittent result was not established. A cloud translation failure during client review was corrected and its focused gate passed.

## Capacity and compatibility

On the development host, the actual edge HTTP retained response expanded 64 sources into 384,000 points: 143 MB JSON and about 1,013 MiB additional heap. At the adopted 30,000-point limit, the response was about 11 MB with a 75 MiB heap increase. After correction, six-source and sixteen-source oversized requests returned unavailable in 21–25 ms; selecting one source returned 6,000 finite retained points in 128–147 ms. Heap deltas are not peak measurements.

Component browser probes rendered 30,000 continuous points without per-point markers. Isolated observations separated by explicit null remain visible. These desktop measurements do not qualify Pi 4 or fleet performance.

Historical traces use current authorized membership, names and depths. No assignment-history ledger was added. The API marker is a series-identity contract, not a new storage version. Updated clients require it; a tab still running an older bundle needs a reload. Saved old-bundle probes confirm that old clients can omit or misclassify the new series even without a page error. Rolling back the binary restores its known cross-device mixing behavior.

## Review decisions and remaining boundaries

The whole-change review found seven defects. Three concern main backend behavior: partial edge payloads after mixed retained/recovery overflow, omitted member-claimed contributors in aggregate root exports, and ineligible plain-LSN50 profile values. Four concern preview integration: recovery selection not updating its host, omitted unnamed desktop sources, missing identity/cache guards in legacy hooks, and daily min/max charts without physical-source attribution. The consolidated correction resolves all seven. The final scoped review is GREEN for specification and code quality, with no new issues.

Luna workers implemented sequential tasks; Sol reviewed each committed task and the combined change. Raw/retained identity, empty scope, root-source selection, shared edge recovery budgets, total point expansion, actual-wire recovery, tooltip timestamps, duplicate labels and locale failures were corrected during review.

The combined review recorded two observations: the pre-existing summary-card unavailable state can fall through to ordinary empty-chart copy, and the mounted duplicate-source test exercises only one label-to-request mapping despite rendering both labels and separately testing reorder. Neither was introduced by the last correction. The final reviewer classified both as evidence limits or pre-existing behavior, without a confirmed new defect.

The private evidence ledger is retained locally; published fixtures use synthetic identities. Intended release-branch inclusion, external consumers, live retained-history availability and a deployment canary still require verification before rollout.

## Preview verification details

The preview test dependencies were refreshed in both host applications after each shared-package correction. Installing inside the shared package alone does not update the hosts' copied file dependency. Root detected stale host copies in an earlier run, retained those logs as superseded evidence, and reran the affected checks only after proving installed-source parity. The final host installs used `npm ci`; installed shared-package source matched its intended copy. Typechecks and builds with `VITE_HISTORY_UPLOT_SOIL_ENABLED=true` passed, followed by both full host suites with two Vitest workers. Earlier hook changes also passed the direct real-Chromium foreground/prefetch/gesture probe.

That earlier matrix proved requests and plots but did not assert mobile selector ownership. Whole-change review found the omission. A strengthened browser check reproduced the mismatch in both hosts: a narrowed A request rendered while edge still selected A and B and cloud still selected All sources. The final 20-case matrix passes with visible-selector assertions on both mobile hosts. An extra actual-page case starts with A/B selected, recovers to C, and verifies C is the only selected and plotted source. Both desktop clients reject a response missing identity v2 with an explicit update error and no chart.

The uPlot regression uses a failure control from the initial preview implementation: isolated low-source observations produced zero colored pixels in the expected plot region. The corrected marker mapping produced 32 pixels. A separate 30,000-point component probe rendered in about 50 ms after fixture delivery with roughly 17 MB sampled browser heap. These are synthetic desktop measurements, not a controlled speed comparison or a fleet performance claim.

The final main cloud JAR SHA-256 is `b260f571353d797a2f5e7772fe3fd11ca2d55dbe0662405d96d7295ead50b57f`.

Mounted recovery tests use real wrappers and shared core under synthetic controlling parents. The actual-page browser cases verify the real parent wiring. Independent gates also caught and corrected a profile-ID compatibility regression and a TypeScript error in a new test fixture before completion.

## Decisions made during execution

- Contract fixtures and focused failing tests were added first; broader cases were added with their owning tasks. This kept the cross-language test work bounded. The risk was missing a case; the acceptance matrix and reviews tracked those gaps.
- The private evidence ledger and all four isolated branches are retained. Only synthetic fixtures and scrubbed documentation are committed. The cost is local scratch storage; deleting it would lose the review evidence the user previously could not find.
- Luna workers implement sequentially, with Sol reviewing committed changes. Luna remained the implementation model in later correction rounds, as requested, rather than following the skill's default model escalation. The tradeoff is potentially more correction rounds.
- The cloud main branch needed a reachable soil line chart and a validated source selector. Correcting backend series alone would leave the visible bug unresolved. These additions increased frontend and authorization test scope.
- Identity version 2 is asserted at the real HTTP/service boundary. Test glue cannot fabricate it. This costs integration-test setup and catches serialization omissions.
- Preview changes stay on separate branches based on the existing preview tips. They consume corrected main-backend responses; their obsolete backend is not deployed or copied into main. This preserves unrelated work but requires deliberate release-branch composition later.
- Explicit null grids apply to retained hourly and daily history as well as weekly history. Previously sparse long requests may reach the point budget sooner; explicit recovery handles that cost without presenting gaps as continuity.
- Edge reconstruction uses one shared 30,000-row budget across recovery and live reads. Covered rows within a recovery scan envelope still count. Some formerly slow requests become unavailable until narrowed. Legacy device history returns HTTP 413 on overflow instead of a misleading successful empty array.
- Root-card source selection and export use exact authorized root-manifest membership for the claimant exception. Non-root claimant restrictions remain. A broader exception would change access policy, so the exception is limited and regression tested.
- Interactive responses have a 30,000-point total cap alongside the existing 2,000-per-series and 30,000-raw-row limits. Measured response expansion justified the cap. Oversized requests require narrowing; storage, maintenance and CSV limits remain unchanged.
- A load-bearing cloud preflight defect discovered after the task's correction limit was carried into integration acceptance. Leaving it open would invalidate the client capacity contract. The cost was one additional bounded backend correction and review.
- Cloud saved soil-profile views are sanitized on restoration because that host does not support them. Deliberate current-session selection remains honest about the unsupported view. This avoids restoring a saved unusable default without adding a new profile implementation.
- Completion means reviewed local branches with recorded verification. No merge, push, deployment or live qualification is implied or performed, and no integration permission menu is required for the authorized work.

- Mobile recovery updates the host selector when one is present; standalone core use retains its own source-selection fallback. This keeps one source owner. A host that fails to apply its callback would not recover, so mounted-host and browser checks cover that boundary.
