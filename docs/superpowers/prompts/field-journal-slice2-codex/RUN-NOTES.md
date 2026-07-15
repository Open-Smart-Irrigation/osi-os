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
