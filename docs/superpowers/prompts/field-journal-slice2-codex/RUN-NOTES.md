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
