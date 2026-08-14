# AgroLink fix wave execution report

Date: 2026-08-13

Scope completed: Phases 1–3 and the Phase 4 repository tasks E11, C7, X12, and C8. No push, deployment, live gateway access, or production cloud access was performed.

## Completed work

The requested review fixes are committed on the isolated edge and cloud worktrees.

| Area | Result |
| --- | --- |
| E1 | Add-device type registration is now driven by the selected catalog value. Both `AddDeviceModal` and `ZoneDeviceModal` initialize `selectedType` to `''`, await the rendered `DRAGINO_LSN50` option in the happy path, and block submit while the catalog is loading or no type is selected. Both have the pending-catalog API-call regression test. `AddDeviceModal` now has its own test file. |
| E3–E5 | Cloud-assigned devices remain visible; gateway card preferences use the admin gate; scoped `REGISTER_DEVICE` zone behavior is isolated from flag-off behavior. |
| E6–E10 | Device assignment preserves existing zone identity, admin navigation and journal reads remain available, `showAdmin` is pinned against flag-off regressions, and AppKey labels are translated in all seven locales. |
| E11 | Same-zone device assignment is idempotent (`202` with the existing device); cross-zone assignment remains `409`. The modal tablist is keyboard accessible, and history loading no longer waits on scope resolution. Stale scoped-access migration generators were removed after confirming no references remained. |
| C1–C6 | Cloud assignment, gateway membership, localization, zone device actions, bootstrap resources, complete zone device responses, and conflict responses are covered by the corresponding commits and tests. |
| C7 | Dead cloud APIs were removed, resolve-then-catch callers use `tryResolve`, and an incorrect read-only transaction annotation was removed. The requested ArchUnit `+4552` counter was not present in the current verifier or history, so no invented baseline entry was added. |
| D1 | Absent telemetry and journal resources bootstrap instead of being rejected. The implementation passes the authenticated gateway EUI through `EdgeSyncService` into `DeviceService.upsertFromHeartbeat`, because the existing resolver did not pass that argument. |
| X1–X7 | Factory provenance, journal authorization and principal binding, ChirpStack key validation and claimed-EUI fencing, legacy ledger expiry handling, and the seven sync event operations were completed. |
| X8–X12 | Auth errors now return bounded HTTP responses, the shared persisted auth-secret resolver is used consistently, linked login falls back safely for placeholder EUIs, registration verification state reaches ACKs, journal catalog/write principals are scoped correctly, CI discovery is expanded, and ledger/replication contracts plus guarded SQL replacements are documented and tested. |

The E1 AddDeviceModal extension is scope, not a deviation. The task goal is that the submitted type is the user's selection. A submit during the catalog-loading window that sends an arbitrary default violates that goal in the same way as submitting `catalog[0]`; the guard and both-modal tests therefore belong to E1.

## Commits

Edge follow-up commits:

- `d2e81bd6` — auth and scoped-access review gaps
- `81689b5b` — scoped modal interaction gaps
- `f412a2da` — scoped journal catalog principals
- `0867f5f5` — replication and ledger compatibility documentation
- `c0a60430` — expanded edge CI review coverage
- `1e949114` — completed migration generator cleanup
- `b01ba7e7` — preserved cloud C8 artifacts

The earlier task commits remain in the same branch, including `8fc83874` for E1 and the E3–E10, X1–X7, and D1 commits listed in the task history.

Cloud follow-up commits:

- `c0c21a1b` — C7 cloud cleanup seams
- `67040c28` — cloud-side sync contract documentation

The cloud worktree's pre-existing untracked `docs/superpowers/prompts/` directory was not staged or removed.

## Verification

Edge:

- `npm run test:unit`: 128 TSX tests and 1,721 Vitest tests passed.
- `npm run typecheck`: passed.
- `npm run build`: passed.
- Sync-flow, function parsing, scoped-access, size-ratchet, profile-parity, and silent-catch verifiers: passed.
- Journal worker, auth isolation, journal API, and scoped-write suites: passed (4, 5, 69, and 68 tests respectively).
- Both profile scope-helper suites: 38 tests passed.
- Both profile ChirpStack helper suites: 88 passed and 16 expected flow tests skipped in the normal invocation; the eight flow tests were also run with `OSI_EXPECT_FLOW_RED=1` and passed.
- YAML parsing and `git diff --check`: passed.

Cloud:

- Targeted C7 backend tests passed.
- Frontend `npm run test:unit`: 122 Node tests and 715 Vitest tests passed.
- The final full Gradle sweep ran 1,610 tests: 1,609 passed, 1 failed, 1 skipped, and 0 errors. The sole failure is the pre-existing frozen ArchUnit `ArchitectureTest.noNewPackageCycles` / `StoreUpdateFailedException` baseline failure.
- `DeviceMutationServiceTransactionIT`, `ScopedAccessMigrationIT`, and `IrrigationConfigMigrationIT` all ran with zero skips.
- Raw Gradle XML results and the HTML report are preserved at [the C8 artifacts](artifacts/2026-08-13-cloud-test-report/).

The cloud branch-wide untouched-suite check reports historical edits to `DeviceMutationServiceTest`, `ZoneMutationServiceTest`, and `JournalAccessServiceTest` from earlier feature commits. C7 did not modify those files; their changes adapt tests to APIs introduced before this cleanup. Rewriting or discarding those earlier changes was not safe.

## Deferred

Phase L, D2, D8, and the walkthrough/deploy-day work remain deferred. They require live gateway availability, deployment sequencing, or explicit production access. No firmware/image build or live database repair was run.
