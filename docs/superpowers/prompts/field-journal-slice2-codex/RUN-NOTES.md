# Field Journal Slice 2 run notes

Append-only execution log for the accepted Phase 0 and Phase 1-6 plans on `design-sync/agrolink`.

## 2026-07-15T00:00:00+02:00 - Orchestrator initialization

- Worktree: `/home/phil/Repos/osi-os-agrolink`
- Branch: `design-sync/agrolink`
- Starting commit: `d5c5b73d23ff679a288d872fe523145f69d11745`
- The branch and its remote tracking ref matched at startup. The worktree was clean.
- Track A is Phase 0. Track B starts with Phase 1. The tracks may run concurrently until the Phase 3 convergence gate.
- Hard boundaries: no `flows.json`, migrations, live gateways, destructive Git operations, rebase, force-push, or branch deletion.

## 2026-07-16T00:04:43+02:00 - Baseline gates

- Edge: journal API 44/44; both profile module suites 99/99; schema, lifecycle, command-path, sync-contract, bootstrap, and profile-parity gates exited 0.
- GUI: `npx tsc --noEmit` exited 0; `npm run test:unit` passed 557 tests across 98 Vitest files plus 93 tests in the tsx runner; `npm run build` exited 0.
- Existing build warnings: stale Browserslist/baseline-browser data and chunks over 500 kB. These are baseline warnings, not Slice 2 regressions.

## 2026-07-16T00:07:29+02:00 - sol preflight for Phase 0 and Phase 1

- Phase 0: ACCEPT. The test harness executes `database/seed-blank.sql`; the seeded catalog contains 266 vocab rows, 3 templates, 4 layouts, and 10 products. The existing catalog route and owner-scoped loader provide the required additive seam. No schema, migration, or `flows.json` edit is needed.
- Phase 1: MAJOR BLOCKER. The accepted plan's client contract does not match the Slice 1 implementation:
  - `createEntry` and `voidEntry` return `{ entry_uuid, outbox_event_uuid, sync_version }`, not `EntryAggregate`.
  - create requires an explicit `status` of `draft` or `final`; the planned payload omits it.
  - plot reads return `{ plots: [...] }`; plot-group reads return `{ plot_groups: [...] }`.
  - plot-group aggregates expose `members`, not `member_plot_uuids`.
- Decision: hold Track B at the Phase 1 hard stop. Continue the independent Phase 0 track. Do not rewrite the accepted plan or invent an unreviewed API contract.

## 2026-07-16T00:18:08+02:00 - Phase 0 green

- RED: the new catalog test failed with 44/45 passing because the default DTO leaked parsed `labels`. The plan expected the full variant to lack `definition`, but `catalog.js` already parsed labels, constraints, definitions, and composition before `catalogDto` ran.
- Deviation: `catalogDto` now explicitly removes parsed fields for the default lightweight response and exposes them only when `includeDefinitions` is true. It reuses the existing `parsedJson` helper. This satisfies the opt-in contract without adding a duplicate parser.
- Commits:
  - `64da767cfd7336eebf93325f7cde4016db2d7aac` - canonical bcm2712 module and regression test.
  - `5d3c0e76269a06358e1e5d093b020b4547c17090` - byte-identical bcm2709 mirror.
- Orchestrator gates: API 45/45; both profile suites 99/99; lifecycle 108/108; command path 63/63; bootstrap 53/53; schema, sync contract, profile parity, and `git diff --check` exited 0.
- sol post-check: APPROVE after a fresh rerun of the same gates. sol confirmed the deviation is required because `catalog.js` pre-populates the parsed fields.

## 2026-07-16T00:53:58+02:00 - Phase 1 blocker amendment accepted

- Authority change: the user authorized plan fixes and enhancements when code reality blocks execution, with no further approval pause.
- The plan now matches the Slice 1 wire contract: explicit draft/final write status, pinned template/layout versions, local occurrence fields, semantic value inputs, draft/final receipt variants, wrapped plot/group collections, and `members` for plot groups.
- The amendment adds `src/services/__tests__` to `test:unit:vitest`; targeted tests alone are not accepted as the phase gate.
- sol found and the amendment corrected two additional blockers: Vitest module mocks now use `vi.hoisted`, and draft receipts no longer require an outbox event UUID.
- sol re-check: ACCEPT. Phase 1 may resume from Task 1.

## 2026-07-16T01:02:37+02:00 - Phase 1 Task 1 complete

- `f71cb1585c525355a1fc7ecd413fb09675ebe0a5` adds the Slice 1 GUI wire types. The worker completed the live filter set with `entry_uuid` and `zone_uuid`, which the earlier plan snippet omitted.
- sol spec review: APPROVE.
- sol quality review found that catalog row types omitted `catalog_errors`, the edge signal for malformed JSON replaced with an empty object.
- `a088b162ab5f248fa18edc1fc558c521e52ea1b8` adds required `catalog_errors` fields to vocab, definition, and product rows.
- sol re-review: APPROVE. Orchestrator `npx tsc --noEmit` and `git diff --check` exited 0.

## 2026-07-16T01:20:28+02:00 - Phase 1 Tasks 2 and 3 complete

- `210ca963ce55f337bda251334880af4555776013` exports the existing configured Axios instance. No second auth or interceptor boundary was introduced.
- `e1e1640df9fd83d933ac1407ae82b94f10bd526f` adds the typed journal client and its initial six contract tests. The full unit command now discovers service tests.
- sol's specification review approved the routes, payloads, receipts, collection envelopes, and unavailable helper. Its separate quality review found a lifecycle blocker: the client lacked PUT, so POST-created drafts could not be promoted because POST is create-only.
- The plan was amended under the user's blocker authority. RED then failed with 6/7 passing because `journalApi.updateEntry` did not exist.
- `15331ea41c48b028e74c453f4372515d6d8ad4c7` adds the typed, UUID-encoded PUT client and the version-zero draft-promotion contract test. Targeted GREEN is 7/7; the worker's full gate is 93/93 tsx tests and 564/564 Vitest tests across 99 files. TypeScript and `git diff --check` exit 0.
- The Phase 2 plan now keeps 404/501 capability absence separate from transient or server errors, gives operational failures a retry path, isolates SWR caches in hook tests, and adds every new test directory to the normal unit runner.

## 2026-07-16T01:32:54+02:00 - Phase 2 preflight amendments

- sol blocked the first Phase 2 draft because entry-list errors could appear as empty data, Tasks 4 and 6 both owned `package.json`, only English had journal keys, Task 7 lacked complete executable page code, and rows exposed raw plot UUIDs with browser-timezone dates.
- The amended plan adds retryable entry and plot hooks, distinct page error states, a seven-locale key-parity test, complete page and page-test code, plot/activity filters, human plot labels, and occurrence-timezone formatting.
- `620b161a53a0e7bb0efe4467a3d4c077a7839243` is the package-only prep commit that registers both Phase 2 test directories before parallel work. Its full unit gate passed 93/93 tsx tests and 564/564 Vitest tests across 99 files.

## 2026-07-16T01:48:32+02:00 - Phase 2 Tasks 4-6 implemented

- `833b4b7de982d77846a0e7739a9b1055e0932afb` adds the catalog capability hook. The original SWR test seam surfaced caught mock rejections after assertions; a directly awaited `loadJournalCatalog` now verifies 404/501 classification, while a resolved-null loader verifies hook state. Targeted tests pass 4/4; sol approved both specification and quality.
- `2d7e0cf1bff302265f5487689a5265ea4d89e373` contains the authorized union of Tasks 5 and 6: retryable entry/plot hooks, localized entry row, seven source locale files, and locale parity coverage.
- Concurrency deviation: the Task 6 worker staged its ten paths while the Task 5 worker committed four paths, so the shared Git index produced one fourteen-file commit with the Task 5 subject. Both workers stopped immediately. The commit was not rewritten because the mission forbids destructive Git; a read-only audit confirmed that it contains only the two authorized scopes.
- RED evidence: Task 5 had two unresolved hook modules; Task 6 had an unresolved row component and missing non-English locale resources. Targeted GREEN is 6/6 for Task 5 and 14/14 for Task 6. The stabilized full gate passed 93/93 tsx tests and 588/588 Vitest tests across 104 files; TypeScript and `git diff --check` exited 0.
- Orchestrator targeted recheck: all five Phase 2 hook/row/locale suites pass 24/24; TypeScript and `git diff --check` exit 0.

## 2026-07-16T02:02:42+02:00 - Phase 2 green

- `d373951d127c64627374a8a3e13a8f6bb7690a26` replaces the placeholder with the final-only reading surface, plot/activity filters, timeline loading/empty states, separate unavailable and operational-error cards, retry-both behavior for entry/plot failures, and the neutral Log activity control.
- RED: the timeline module was missing and six page tests failed against the placeholder. GREEN: page/timeline 9/9, source-locale parity 6/6, and all Phase 2 suites 33/33.
- Full gates: 93/93 tsx tests, 597/597 Vitest tests across 106 files, TypeScript exit 0, production build exit 0, anti-slop no tier-1 findings, and `git diff --check` clean.
- sol specification and quality reviews: APPROVE. sol confirmed final-only limit-50 queries, filters, human plot labels, capability/error separation, retry behavior, neutral CTA styling, and seven-locale parity.
- Orchestrator repeated the full unit, TypeScript, build, whitespace, and clean-worktree gates. Phase 2 is accepted.

## 2026-07-16T02:17:05+02:00 - Phase 3 executable decomposition accepted

- The first sol preflight blocked partial template/layout handling, flat and incorrectly ranked activity choices, fixed-only units, caller-authoritative carry-forward fences, incomplete draft/duplicate behavior, browser-timezone precedence for zone shortcuts, and unnamed test ownership.
- The amended tasks now cover every shipped definition and dependency shape, typed activity/dependent-choice leaves with paged season derivation, exact canonical-plus-entered numeric rows, cursor-paged stored-draft carry-forward, explicit template/farm-layout choices, warn-once duplicate UX, typed zone UUID/timezone normalization, exact test paths, and a zone-CTA-inclusive five-tap gate.
- A second review caught and closed the last two details: numeric rows omit generic `value` and submit canonical `value_num` beside entered audit facts; Task 13 owns deterministic paged season/common and no-history fallback inputs.
- sol final preflight: ACCEPT. Anti-slop reports no tier-1 findings and `git diff --check` is clean. Phase 3 may begin at Task 8.

## 2026-07-16T02:55:00+02:00 - Phase 3 Task 8 complete

- `e3644ccd` adds the browser-safe catalog model, template engine, unit conversion, activity-leaf derivation, DST occurrence resolver, complete write DTO, and the single shared Phase 3 locale tree.
- Execution deviation: the first broad worker attempt stalled without changing files. Task 8 was split into disjoint 8A catalog/template and 8B occurrence/API/locale scopes; neither worker staged, and the orchestrator integrated one exact 17-file commit. This avoided another shared-index race.
- Initial RED was five missing/contract suites. Review-driven RED added 14 fail-closed predicate/constraint/fixture cases, two empty unit-metadata cases, and two inactive/deleted activity cases.
- sol specification review required edge-parity predicate domains, numeric metadata validation, canonical generated fixtures, typed `carry_forward`, and non-empty unit facts. The final specification verdict is APPROVE. The separate quality review required inactive/deleted activity filtering and a string-only dependent-choice type; final quality verdict is APPROVE.
- Canonical tests compile `journal-catalog-core.js` with the real Agroscope catalog and exercise the generated REST DTO and cascade. Final gates: Task 8 focused 59/59, full unit 93/93 tsx plus 643/643 Vitest across 109 files, TypeScript clean, anti-slop no tier-1 findings, and `git diff --check` clean.

## 2026-07-16T10:37:32+02:00 - Phase 3 Tasks 9 and 10 complete after session recovery

- The interrupted parent session and its Task 9/10 worker transcripts were recovered. The controller preserved the eight untracked files and resumed from the pending Task 10 rerun; completed phases were not replayed.
- `b6f6d227` adds the transparent activity picker. Initial focused GREEN was 10/10. Quality review then required Unicode-preserving locale-aware search, focus management across guided Browse/Back transitions, stale-prefix reconciliation, real keyboard coverage, and removal of the test-only data marker. The review-driven regressions failed before the fixes; final focused coverage is 13/13. Specification and quality reviews both APPROVE.
- `753977b6` adds catalog-driven numeric, product, nutrient-repeat, and dynamic field controls. The initial 16-test suite grew to 23 tests after specification and quality review found non-discriminating unit fixtures, missing required/error associations, stale numeric validity, lost min/max reasons, duplicate repeat identities, an unrecoverable inactive product, and locale-insensitive sorting. Each correction had focused RED evidence before implementation. Final specification and quality reviews APPROVE.
- The controller was the only Git writer. Task 9 and Task 10 were staged and committed from explicit path lists, avoiding the earlier shared-index race.
- Final combined gate: 93/93 tsx-runner tests, 679/679 Vitest tests across 113 files, Task 9 focused 13/13, Task 10 focused 23/23, TypeScript clean, and cached whitespace checks clean. A non-blocking Task 8 option-dependency boundary note remains for later catalog-engine work; Task 10 did not duplicate that policy.

## 2026-07-16T11:55:30+02:00 - Phase 3 Task 12 complete; Task 11 hard stop

- `cb9d943c` adds the stable draft queue and honest save states. Review-driven RED covered draft/final serialization, queued edits, authoritative final receipts, callback failures, unmount during requests and callbacks, repeated Finish, capability disable during debounce, StrictMode UUID lifetime, and async retry rejection. Final focused coverage is 32/32; specification and quality reviews APPROVE.
- Task 11 completed three focused correction cycles. Its suites grew from 23 to 65 and then 93 tests, covering malformed rows, exact-draft uniqueness, deterministic cross-page selection, protected treatment fields, confirmed-value invalidation, user-ready previews, idempotent confirmation, and bounded pagination.
- HARD STOP: the final Task 11 quality re-review still found one Important defect. `carryForward.ts` classifies every `attr.amount_*` code as protected, which suppresses shipped non-protection fields such as `attr.amount_operation_depth` and `attr.amount_duration_area` when a template declares them. The missing regression must prove a declared non-protected `attr.amount_*` value remains in `automaticValues`, then replace the prefix rule with an explicit activity-appropriate protected-code set.
- The hard stop follows the mission's three-attempt limit. The four Task 11 files remain untracked and uncommitted; no Task 13 integration began.
- Independent combined gate at the stop point: 93/93 tsx-runner tests, 804/804 Vitest tests across 117 files, Task 11 focused 93/93, Task 12 focused 32/32, and TypeScript clean. Passing tests do not override the unresolved Task 11 review defect.

## 2026-07-16T12:15:56+02:00 - Task 11 hard stop cleared under blocker-correction authority

- The user authorized corrections of heavy blockers beyond the original three-attempt cap. The additional Task 11 cycle stayed limited to the unresolved `attr.amount_*` classification defect.
- RED: the focused regression failed because `attr.amount_operation_depth` and `attr.amount_duration_area` were missing from `automaticValues`. The fix removed the broad prefix heuristic while retaining the explicit protected-code set for product, authorization, target, dose/basis, amount/rate, treated area, and waiting period.
- `abdb8004` commits the approved season-safe carry-forward implementation. Sol re-ran 93/93 focused tests and found no regression in runtime validation, label resolution, deterministic and bounded pagination, idempotent confirmation, candidate replacement invalidation, incomplete-preview safety, or dismissibility.
- Post-fix combined gate: 93/93 tsx-runner tests, 804/804 Vitest tests across 117 files, Task 11 focused 93/93, and TypeScript clean. The recorded Task 11 hard stop is closed; Phase 3 may continue at Task 13.

## 2026-07-16T15:35:24+02:00 - Independent pre-Task 13 findings adjudicated

- Read `REVIEW-FINDINGS.md` before the Task 13 commit boundary and applied only R1. The `include=definitions` edge test now requires a non-empty template definition and a non-empty English template label; `node scripts/test-journal-api.js` passes 45/45.
- R2 required no code change. Carry-forward remains definition-driven through `declaredCarryForward`; no `full_record` fallback list was added in the GUI.
- N1 and N2 remain out of scope as directed. No migration, product-composition seed, or catalog-label translation was created or changed, and neither item was treated as a hard stop.

## 2026-07-16T16:53:19+02:00 - Phase 3 Task 13 ready for external review

- `7343540d` commits the independent-review R1 assertion and its adjudication note. R2 remained definition-driven; out-of-scope N1 and N2 were not changed.
- `52cc8637` commits the confirm-by-reading flow: paged plot/season/farm shortlists, generic and preselected capture paths, explicit layout/template choices, shared full-form validation, stable draft carry-forward, strict occurrence handling, confirmation tokens, duplicate decisions, and honest final-save states.
- Heavy-blocker corrections extended the Task 13 seam into `EntryForm` and `occurrence` so transitions and automatic/repeat merges use one validator, and shortlist plus duplicate handling share one strict API-instant parser. No template-specific carry-forward fallback was added.
- Final independent reviews found no Critical, Important, or Minor findings. Controller gates pass 84/84 focused occurrence/shortlist/flow tests, 124/124 capture tests, 93/93 tsx-runner tests, 887/887 Vitest tests across 120 files, TypeScript, production build, anti-slop, and whitespace checks. React `act(...)` warnings are zero. Build output retains only the existing stale browser-data and large-chunk advisories.
- Task 13 is ready for the external reviewer. Task 14 has not started.

## 2026-07-16T19:28:09+02:00 - Phase 3 Task 14 implementation committed; browser evidence blocked

- External review commit `52977a9d` accepted Task 13 before Task 14 proceeded. Its F5 token-grid deviation remains untouched, and N1/N2 remain out of scope.
- `6ede2ff2` commits the Task 14 integration: dashboard and zone-card capture entry points, typed zone UUID/timezone/crop normalization, query-driven capture lifecycle, exact-entry reopening, authoritative timeline revalidation, 56 px primary controls, focus restoration, and one main landmark.
- The five-activation regression uses a real zone-card link and the real capture flow. It asserts one final PUT, canonical `attr.crop`, a distinct definition-declared `attr.method` carry-forward, the gateway receipt, and wrapping containers. The path passed five consecutive isolated runs.
- Review found that zone crop labels were being sent as choice values. Mapped labels now resolve to one active `attr.crop` child code; broad or unmatched labels remain `season_crop` context and are not emitted as invalid choices. Mapped values seed the full-record crop control before validation.
- The localhost-only preview now requires its injected bearer token, enforces known-route methods, uses the edge 256 KiB body limit, recovers from malformed JSON, validates entry filters and UUIDs, and runs final payloads through the shipped edge validator. Its suite passes 7/7 against the current build.
- Both final independent quality reviews report no Critical, Important, or Minor findings. Final controller gates pass 93/93 tsx-runner tests, 921/921 Vitest tests across 121 files, TypeScript, the 1,669-module production build, the 7/7 preview suite, and whitespace checks. Build output retains only the existing stale browser-data and large-chunk advisories.
- The required 320x568 and 360x640 screenshots and browser keyboard pass are not collected. Two in-app browser attempts stopped before navigation because the privileged native-pipe bridge reported that `browser-client` is not trusted. This is an environment evidence blocker; Task 14 must not be marked phase-gate complete or used to advance the phase until that browser evidence is collected.

## 2026-07-17T00:30:32+02:00 - Task 14 F6 fixed; F7 product-question hard stop

- The earlier Task 14 browser blocker is resolved. The external reviewer completed the required checks at 320x568 and 360x640. The shared AppHeader follow-up was already fixed in `46c3082e`; it is not reopened here.
- `d84d4b2d` fixes F6. An explicit editable form crop wins over zone and activity defaults; a zone crop still seeds paths with no crop control; and clearing the optional crop leaves it cleared. Generic optional-choice validation now permits empty optional values while required fields and non-empty invalid choices remain protected. Exact final-payload regressions cover edited, cleared, quick, and activity-collision paths. Sol's final verdict is APPROVED.
- Final controller GUI evidence at `d84d4b2d` is 94/94 TSX tests, 939/939 Vitest tests across 122 files, a green typecheck, and a green production build. The only build output warnings are the inherited browser-data and large-chunk warnings.
- F7 was measured independently against the shipped `open_field` layout. It has four required minimum fields: `attr.block_bed_row`, `attr.treated_area`, `attr.cover_type`, and `attr.denominator`. `farmer_quick` carry-forward prefills none of them. Luna and Sol each measured 9 genuine activations using this exact sequence: zone CTA; Irrigation; Next; Block/bed/row; Treated area 100 m²; Cover type Crop cover; Denominator Per area; Next; Finish. Each run rendered `Saved on farm gateway`, made exactly one final `updateEntry`, and included all four values. Temporary probes were removed, and the repository was clean at `d84d4b2d`.
- Nine activations exceed the `<=5` SLA. F7 is therefore the specified product-question hard stop. Task 14 remains NOT READY, and the Phase 3 gate is closed. Phase 4 must not start while the Phase 3 gate is closed. No catalog, migration, N1/N2, or F5 changes were made. Before work resumes, the product owner must decide whether to revise the SLA, the default layout, or the carry-forward minimum-field policy; no option is selected here.
- History Wave 2 translation work completed and was committed as `af513608`. It covers six 414-key locales with exact source/feed mirrors, value-level allowlists, placeholder checks, and no `ß` in de-CH. Sol approved after the guard corrections. `journal.json` feed mirroring remains deferred to Slice 2 Phase 6.

## 2026-07-17T02:32:11+02:00 - F7 decision patch clears product hard stop

- The product owner accepted the recommended two-tier activation target on 2026-07-17. The current shipped, uncached `open_field` path runs from the zone CTA through the rendered `Saved on farm gateway` receipt and takes `<=9` primary-control activations.
- `<=5` is conditional and future only: an approved safe-default policy must supply every required field. The current release has no such policy. No catalog, migration, carry-forward, F5, N1, or N2 behavior changed.
- Commit `4aa0af04` pins the exact shipped `farmer_quick@1` and `open_field@1` definitions, four initially empty required controls, nine real event-recorded activations, one status-final update, the exact unique four required values, mapped crop, gateway receipt, wrapping containers, and one main landmark.
- Mutation evidence is credible RED. GREEN is focused SLA 1/1, `JournalPage` 23/23, controller full 94/94 TSX and 939/939 Vitest across 122 files, typecheck, anti-slop, and `git diff --check`. Luna's earlier report did not itself run the build; after commit `4aa0af04`, the controller independently ran the production build on that exact tree, with Vite transforming 1,669 modules and exiting 0.
- Luna implementation and Sol specification reviews are PASS. Quality is APPROVED with no findings.
- The F7 product-question hard stop is cleared. Task 14 is READY FOR EXTERNAL RE-REVIEW, but it is not externally accepted. Phase 4 must not start until external reviewer acceptance closes Phase 3.
- Pre-existing `attr.method` issue: shipped definition-driven carry-forward maps it, but current form pruning prevents retention in the final payload. This is a separate production TDD follow-up and did not block this decision patch.

## 2026-07-17T09:46:08+02:00 - Phase 4 sequencing authorization and contract correction

- The user reports that Task 14 is externally approved. Broader Phase 3 remains in review, and the user explicitly authorizes Phase 4 to begin now. This narrow sequencing authorization does not mark Phase 3 complete, waive later findings, or permit Phase 3-owned work to be treated as accepted.
- Fresh GUI baseline: 94/94 TSX-runner tests and 939/939 Vitest tests pass.
- Phase 4 preflight corrected the stale sketch. Shipped Slice 1 uses one atomic `POST /api/journal/entries` with `plot_uuids`; the edge generates `batch_uuid`, returns N independent receipts, caps the batch at 100 plots, and performs plural duplicate preflight. `duplicate_guard_ack_entry_uuids` is batch-only. Batch drafts and `PUT` batches are rejected. The path does not use N client calls or a client-generated UUID.
- The Phase 4 plan preserves single-plot draft promotion and keeps Phase 3 status separate from Phase 4 sequencing.
- Concurrent commit `bbb85004` recorded ongoing Phase 3 review findings. Those findings remain Phase 3-owned and are not waived. Task 21 must re-read the current Phase 3 section of `REVIEW-FINDINGS` before capture integration, keep P1/P2/P3 with their Phase 3 owners, and adapt to any landed fix without overwriting it.

## 2026-07-17T10:36:46+02:00 - Phase 4 plan corrected after two Sol specification reviews

- Two independent Sol specification reviews returned `CHANGES REQUIRED`. The plan now forbids `status`, `plot_uuid`, and `zone_uuid` in the shared batch fields while requiring final status; places the multiline singular-ack `@ts-expect-error` directly above the offending property; separates Vitest RED from typecheck evidence; and asserts both forbidden UUID fields are absent from the batch wire payload.
- Range Apply and Enter now parse against each station's source-number set and replace only that station's selected UUIDs. The plan adds visible parser, heterogeneous-layout, and 100-plot-cap failures, removes impossible JSDOM claims about real viewport overflow and browser Tab traversal, and moves those checks to Task 25 browser acceptance at 320x568 and 360x640.
- Group creation and editing now use exact `JournalPlotGroupWritePayload` callbacks. New groups use a random UUID, base version zero, sorted members, and `resolved: false`; active edits preserve the existing identity, version, label, resolution state, and sorted members. The exact `{ error: 'heterogeneous_group', message, details: null }` response shape is visible.
- Task 21 now reaches plot create/update through mounted `PlotForm` controls and group create/edit through hook callbacks, uses a dedicated batch builder that omits both `plot_uuid` and `zone_uuid`, and records mock request evidence for CRUD, harvest resolution, batch receipt, and plural duplicate retry. The mock harness proves GUI wiring and envelopes, not edge atomicity. All preview test references use `scripts/test-task14-journal-preview.js`.
- Timeline adjudication accepted hydrating complete batch membership by `batch_uuid` with the 100-entry hard cap, defensive cursor pagination, loading, error, and retry states. Invented correction/void callbacks were rejected and deferred to the Phase 5 detail workspace; child `entry_uuid`, `status`, and `sync_version` identity remain preserved for future per-entry actions, with no apply-to-all or mutation fan-out.
- Task 24 now requires all Task 15–23 user-facing keys, including PlotForm fields/actions, plot and group create/edit controls, parser/API errors, loading/retry copy, batch states, and active-group edit copy, with direct component-key existence tests. Phase 3 remains in review; no Phase 3 finding was waived.
- Re-review correction: Task 15 now consumes every invalid compile fixture with `void` statements, keeps each `@ts-expect-error` beside its forbidden property, and uses one shell `cd` for separate RED commands so evidence isolates forbidden-property checks.
- Re-review correction: Task 19 now uses `resolved_at`, derives payload `resolved` from `group.resolved_at !== null`, asserts active edits send `false`, and renders the exact Axios `response.data` error envelope visibly.
- Re-review correction: Task 23 now owns `JournalPage.tsx` and `JournalPage.test.tsx`, wires `journalApi.listEntries` (or a typed adapter) into `JournalTimeline`, includes the page test in RED/GREEN, and commits eight exact files.

## 2026-07-17T10:57:22+02:00 - Authoritative Task 14 status and remaining quality corrections

- The earlier 09:46 entry recorded relayed Task 14 approval from the user's report. Commit `923b76b6` now supplies the authoritative written acceptance in `docs/superpowers/prompts/field-journal-slice2-codex/REVIEW-FINDINGS.md` under `# Task 14 external re-review — ACCEPTED (2026-07-17)`. Broader Phase 3 remains separately in review; the early Phase 4 sequencing authorization does not close that review.
- Cardinality ownership is explicit: Task 15 keeps `CreateFinalBatchPayload.plot_uuids` as `string[]` and covers only compile-time wire shape plus exact service pass-through. Task 21's `buildFinalBatchPayload` validates 1–100 unique plot UUIDs, sorts valid UUIDs, returns the exact `invalid_batch`, `batch_too_large`, and `duplicate_plot` error envelopes, and makes no POST after a rejected build.
- Numeric station extraction is deterministic: use `plot_code` when it contains exactly one positive integer token, otherwise try `name`; reject ambiguous multi-number text. Same-station source-number collisions move every colliding plot to `namedFallbackPlots`, retain all plots, and leave `gridPlots` unique. Task 19 maps ranges only through unique `gridPlots`.
- Harvest sequencing is separated: Task 21 may test generic plot-group PUT wire support for `resolved: true`, but it does not claim to prove the HarvestGroupNudge UI. Task 22 owns the nudge tests, preview evidence, and `scripts/test-task14-journal-preview.js` scope; Task 25 remains the final browser acceptance gate.
- Complete batch membership uses `status: 'all'` in Task 23 hydration callbacks, filters, interfaces, tests, and implementation. Batch creation remains final-only, while hydration retains voided children and preserves each child's actual status and identity.

## 2026-07-17T11:02:00+02:00 - Final scope clarification for the Phase 4 correction

- The earlier 10:36 plan note used “harvest resolution” in the Task 21 preview summary. That wording is superseded by this append-only correction: Task 21 covers generic plot-group `PUT` wire support, including `resolved: true`; Task 22 owns the HarvestGroupNudge tests and `scripts/test-task14-journal-preview.js` evidence, with a six-file commit scope. Task 25 remains the final browser gate.

## 2026-07-17T12:00:00+02:00 - Superseding Task 22 documentation correction

- Task 22 now owns seven files, adding `web/react-gui/src/components/journal/__tests__/capture/JournalCaptureFlow.test.tsx`. That React test drives the visible post-save `HarvestGroupNudge` and asserts the group-hook callback, exact `resolved: true` payload, and success/error behavior.
- `scripts/test-task14-journal-preview.js` is HTTP-only for Task 22: it records the exact generic UUID-encoded plot-group `PUT` request/response envelope with `resolved: true`. It does not claim visible React UI coverage; Task 25 retains real browser wiring acceptance.

## 2026-07-17T11:09:42+02:00 - Timestamp correction

- The 12:00 header was a timestamp-entry error; its content remains valid, and this correction was recorded at the actual time.

## 2026-07-17T11:11:19+02:00 - Final Phase 4 documentation review outcome

- Two independent Sol specification reviewers approved corrected Tasks 15–20 and 21–25.
- The separate Sol quality reviewer initially required five quality corrections and one Task 22 test-authority correction. Luna corrected all six; the final Sol quality verdict is `APPROVED`.
- The Phase 4 plan is ready to commit, and Task 15 may begin.
- Broader Phase 3 remains separately in review; no finding was waived.
