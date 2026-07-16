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
