# History Data Visualization Implementation Trace

Trace recorded on 2026-06-01 for Slice 10 final hardening. Scope is traceability and verification only; no product surface was added in this slice.

| Spec section | Requirement | Repo | Slice | Commit SHA | Tests / verification | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 Objective; 1.2 Accepted implementation decisions | Implement a thematic History/Data Visualization experience without replacing physical-device source data; keep decisions locked before implementation. | osi-os | 0 | d84b2bac, f87f027c, a62f6bb3, 756a950d, 7bd94612, c6fe521e | Plan/spec review; `git log --oneline --reverse --grep=history feat/history-data-visualization`. | Implemented |
| 4.1 Keep physical devices as source data, derive thematic cards | Derive user-facing history cards from existing device rows and events instead of exposing raw physical-device internals directly. | osi-os / osi-server | 1, 3, 4, 7 | osi-os: bebe4026, 68f80ccb, 769f3fbe; osi-server: 8b6b4ad, cf976a7, ebbd44c | Edge `node scripts/verify-history-api-contract.js`; frontend history contract/unit tests; cloud `./gradlew test`. | Implemented |
| 4.2 Static card definition source; gap-analysis section 6 | Keep card definitions static and in-repo; do not introduce a runtime plugin system. | osi-os / osi-server | 1, 5, 6 | osi-os: bebe4026, 4723bdee; osi-server: 8b6b4ad, 4ee6323 | Static card definition tests in edge/cloud frontend unit suites; self-review of `src/history/cardDefinitions.ts`. | Implemented |
| 4.3 Stable card identity | Use stable derived card IDs for zone and gateway cards. | osi-os / osi-server | 1, 2, 4 | osi-os: bebe4026, c12b3068, b0212956; osi-server: 8b6b4ad, b18b460 | Edge helper export checks in `node scripts/verify-sync-flow.js`; cloud `HistoryCardServiceTest` via `./gradlew test`. | Implemented |
| 4.4 Required MVP cards | Provide Soil Profile, Dendro Growth Timeline, Environment Line Chart, Irrigation Event Timeline, and Gateway Status Overview. | osi-os / osi-server | 7 | osi-os: 1bd3dcb6, 18ead303, 33eef1d8, 8ce245d1, d3057d83; osi-server: 3636b0b, f52305f, 6ce62a7, ac55c7a, 29e6bd6 | Edge `npm run test:unit` and cloud `npm run test:unit` include card-frame visualization tests. | Implemented |
| 4.4 Gateway Status Overview product constraint | Gateway CPU/thermal temperature metrics must remain visible in normal Gateway Status Overview. | osi-os / osi-server | 7F | osi-os: 4c8ad13f, 5ef743ff, c6873c8d; osi-server: bf2a63c, be4b772, f3b08e1 | Edge/cloud gateway view tests assert `Temperature` and `61 C` render in the normal overview; self-review confirmed classifier accepts `thermal temp` and `cpu temp` labels. | Implemented |
| 4.5 Card summary API contract; 4.6 Card data API contract; 4.7 Advanced View API contract | Expose history summary/data/advanced APIs with stable range, freshness, aggregation, series, event, calendar, interpretation, and advanced-field shapes. | osi-os / osi-server | 1, 3, 4 | osi-os: bebe4026, 22d3245f, 4e165343, 68f80ccb, 769f3fbe; osi-server: 8b6b4ad, d32455d, 2a64560, cf976a7, d476a5f | Edge `node scripts/verify-history-api-contract.js`; edge/cloud `tests/history-contracts.test.ts`; cloud `HistoryControllerTest` and `HistoryServiceTest`. | Implemented |
| 4.8 Semantic zoom and aggregation; 6.4 Aggregation buckets | Resolve aggregation by range and enforce long-range rollup usage. Edge uses helper-backed aggregation; cloud avoids live JSONB scans for 30D/Season by using typed rollups. | osi-os / osi-server | 2, 3, 4, 7A | osi-os: dd9fe750, 194baa4e, c12b3068, 1b51de7d, aba11891, f640ad57; osi-server: cf976a7, 0f26785, df13a3c, 831cfd9, 58ab3c6, 4a4fbf2 | Edge `node scripts/verify-sync-flow.js` and `node scripts/verify-history-api-contract.js`; cloud `HistoryAggregationServiceTest` and `JdbcHistoryRollupRepositoryTest` via `./gradlew test`. | Implemented |
| 4.9 Calendar mode | Provide card-specific calendar states with theme-specific status vocabulary. | osi-os / osi-server | 1, 8 | osi-os: bebe4026, af732292; osi-server: 8b6b4ad, 86015b8, e4abf4c | Edge `CalendarAndAdvancedViews.test.tsx`; cloud `HistoryCalendarServiceTest` and frontend calendar/advanced tests. | Implemented |
| 4.10 Local rule-based interpretation engine | Provide offline rule explanations from local/backend-owned classification helpers, not frontend-only heuristics. | osi-os / osi-server | 2, 4, 8 | osi-os: c12b3068, b0212956, af732292; osi-server: cf976a7, b18b460, 86015b8 | Edge helper export and SQL-backed tests in `node scripts/verify-sync-flow.js`; cloud `HistoryThresholdClassifierTest`, `HistoryInterpretationService` coverage via `./gradlew test`. | Implemented |
| 4.11 Cloud interpretation extensions | Cloud may extend interpretation using existing prediction/weather capabilities only; no new AI/satellite product surface. | osi-server | 4, 8 | cf976a7, d476a5f, 86015b8, 157b038, 37042bc | Cloud `HistoryCloudExtensionServiceTest`, `HistoryServiceTest`, and frontend advanced-view tests via full verification. | Implemented |
| 4.12 Desktop workspace model; 4.13 Saved workspace schema; 4.14 Learned ordering and pinning schema | Desktop defaults to single-card mode; comparison is stacked/capped; saved workspace and preference state persist required fields. Edge remains local-only/sync-deferred; cloud stores user-scoped records. | osi-os / osi-server | 9 | osi-os: bef5b390, 91c95db7, 47133abd, 408b4570; osi-server: 90396c2, 64ce210, e8250bc | Edge `tests/history-workspace-model.test.ts` and `HistoryShell.test.tsx`; cloud `HistoryWorkspaceServiceTest` and frontend workspace tests. | Implemented |
| 4.15 Overlay policy implementation | Enforce standard overlays versus Advanced-only overlays. | osi-os / osi-server | 1, 8 | osi-os: bebe4026, af732292, 8df17ab7; osi-server: 8b6b4ad, 86015b8, 157b038 | Edge/cloud `advanced-only overlays are rejected outside Advanced View` tests in unit suites. | Implemented |
| 5 Frontend specification | Add shared mobile/desktop history shell, semantic viewport, inspector, card-specific views, and i18n keys. | osi-os / osi-server | 5, 6, 7, 8, 9 | osi-os: 4723bdee, a9b2c281, 9657662d, aba11891, 9d4ed0c9, af732292, bef5b390; osi-server: 4ee6323, 21786c7, 1ab1992, c3fe4c9, 86015b8, 90396c2 | Edge/cloud `npm run test:unit`; edge/cloud `npm run build`. | Implemented |
| 6 Backend specification; 6.10 API behavior and observability | New endpoints must enforce auth/access, validate ranges/aggregation, and record observable behavior. | osi-os / osi-server | 3, 4 | osi-os: 68f80ccb, 769f3fbe, 1fa2e0ff; osi-server: cf976a7, ebbd44c, 0f26785, d476a5f | Edge `verify-history-api-contract` confirms router/helper path and endpoint list; cloud `HistoryControllerTest` and `HistoryServiceTest` via `./gradlew test`. | Implemented |
| 7 Migration plan; 7.3 Backwards compatibility; 7.4 Feature flags | Additive schema and flags; leave legacy dashboard untouched. | osi-os / osi-server | 2, 4, 5, 6 | osi-os: dd9fe750, 1a17f925, 5b8b7344, 4a8cdc54, 4723bdee; osi-server: cf976a7, 21786c7 | Edge `node scripts/verify-db-schema-consistency.js`, `node scripts/verify-sync-flow.js`, frontend flag-gate tests; cloud migration and feature-flag tests via full verification. | Implemented |
| Slice 10 final hardening | Record traceability, verification evidence, and final self-review without adding product surface. | osi-os | 10 | This commit | Commands listed below; both worktrees checked before and after commit. | Implemented |

## Verification Evidence

All commands below were run from the Slice 10 worktrees on 2026-06-01.

### OSI OS Edge

- `git diff --check`: passed with exit 0.
- `node scripts/verify-db-schema-consistency.js`: passed; all bundled `farming.db` copies plus `database/farming.db` and `web/react-gui/farming.db` matched expected schema.
- `node scripts/verify-history-api-contract.js`: passed; all zone, gateway, workspace, preference, opened, and feature endpoints route through `osi-history-helper`.
- `node scripts/verify-sync-flow.js`: passed; includes DB/schema checks, history helper export checks, SQL-backed history helper tests, and profile parity.
- `scripts/check-mqtt-topics.sh`: passed; all checked MQTT IN topics use `application/+/device/+/event/up`.
- `cd web/react-gui && timeout 240 npm run test:unit`: passed; TSX runner reported 62/62 passing and Vitest reported 12 files / 51 tests passing. The known unrelated Dragino hang did not occur, so focused fallback checks were not needed.
- `cd web/react-gui && npm run build`: passed; Vite built successfully with only existing Browserslist/bundle-size warnings.

### OSI Cloud / Server

- `cd backend && ./gradlew test`: passed; Gradle reported `BUILD SUCCESSFUL` with tasks up to date. The frontend-toolchain `tsc` blocker did not occur, so targeted backend fallback tests with skipped frontend tasks were not needed.
- `cd frontend && timeout 240 npm run test:unit`: passed; TSX runner reported 44/44 passing and Vitest reported 22 files / 80 tests passing.
- `cd frontend && npm run build`: passed; `tsc && vite build` completed with only the existing bundle-size warning.

## Self-Review Checklist

- Thresholds remain helper/backend-owned: edge classification lives in `osi-history-helper`; cloud classification lives in `HistoryThresholdClassifier` and consumers. Frontends only render statuses/overlays.
- Card definitions remain static in repo-owned `src/history/cardDefinitions.ts`; no runtime plugin registry was added.
- Cloud long-range aggregation uses typed rollups for 30D/Season and rejects raw/15m long-range requests; live JSONB extraction is limited to short visible ranges and maintenance backfill paths.
- Edge history APIs route through `osi-history-helper` and SQLite helper/rollup logic, not standalone embedded visualization code paths.
- New endpoints have auth/access behavior: edge verifies bearer auth before history routes and checks zone/gateway ownership; cloud uses authenticated user resolution and service-layer zone/gateway ownership checks covered by controller/service tests.
- Frontend cards consume history APIs and contract types; raw physical-device internals are not rendered in normal card views.
- Legacy dashboard files were not edited in Slice 10 and existing full frontend tests/build passed.
- Workspaces/preferences are local edge tables and cloud user-scoped records; cross-device sync remains deferred per Slice 0.
- Panel caps are enforced by `maxPanelsByPlatform` and covered by workspace/shell tests.
- Farmer-facing strings use history i18n keys and locale files; contract tests cover emitted advanced-field/workspace labels.
- No Diagnostics Card was added. Advanced diagnostics remain an Advanced View panel only.
- Gateway CPU/thermal temperatures remain visible in normal Gateway Status Overview on edge and cloud; tests assert the normal overview renders `Temperature` with the sample `61 C` value.
