# History Data Visualization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the OSI OS and OSI Cloud (`osi-server`) History and Data Visualization redesign described in `docs/ux/history-data-visualization-redesign-spec.md`.

**Architecture:** Keep physical devices as the storage/sync model and add a derived thematic-card history layer. Edge work stays offline-first with SQLite, Node-RED orchestration, and a bundled `osi-history-helper`; cloud work uses Spring/Flyway/PostgreSQL with typed rollups for long ranges. Frontends add parallel `history` modules and card/workspace UI surfaces while preserving the current dashboards during rollout.

**Tech Stack:** OSI OS: Node-RED flow JSON, SQLite, Vite React, TypeScript, SWR, Recharts, Node helper modules. OSI Cloud (`osi-server`): Spring Boot, Kotlin Gradle build, Flyway, PostgreSQL JSONB plus rollups, Vite React, TypeScript, SWR, Recharts.

---

## Source Documents

Read these before executing any slice:

- `/home/phil/Repos/osi-os/AGENTS.md`
- `/home/phil/Repos/osi-os/docs/ux/history-data-visualization-redesign-spec.md`
- `/home/phil/Repos/osi-os/docs/ux/history-data-visualization-gap-analysis.md`
- `/home/phil/Repos/osi-os/docs/adr/2026-05-28-static-device-plugin-registry.md`
- `/home/phil/Repos/osi-os/architect.yaml`
- `/home/phil/Repos/osi-os/RULES.yaml`
- `/home/phil/Repos/osi-server/AGENTS.md`
- `/home/phil/Repos/osi-server/architect.yaml`
- `/home/phil/Repos/osi-server/RULES.yaml`

Implementation constraints from the spec:

- Do not replace the physical device model.
- Do not introduce a dynamic runtime plugin system.
- Do not move cloud-to-edge commands to MQTT.
- Do not add long-range cloud history by live JSONB scans.
- Do not embed large aggregation/rule logic directly in `flows.json`.
- Do not ship `range=season` without explicit season boundaries.
- Do not ship uncapped comparison mode on OSI OS.
- Keep the legacy dashboards working until the new history experience is explicitly switched over.

## Plan Review Consolidation

The critical implementation-plan review is incorporated as execution constraints:

- Slice 0 must record decisions with explicit `Decision:` markers and defaults; it cannot pass by merely asking questions.
- Slice 1 owns contract fields that downstream slices use: `coverageConfidence`, panel caps, workspace schema version, i18n key constants, and test-runner coverage.
- Edge schema and helper work are split into separate commits.
- `history_channel_rollups` is created only when Slice 0 records that rollup strategy.
- Cloud long-range aggregation must choose a concrete source before Slice 4 starts.
- Runtime feature flags default off when `/api/system/features` fails.
- Component test scope must include `src/components/history/__tests__` before history UI tests are added.
- Visualization work is split by viewport and card type to keep reviewable commits.
- Final verification is scoped to history-relevant scripts and test suites.

## Branching And Commit Protocol

Create the same branch name in both repos before Slice 0:

```bash
cd /home/phil/Repos/osi-os
git status --short --branch
git switch -c feat/history-data-visualization

cd /home/phil/Repos/osi-server
git status --short --branch
git switch -c feat/history-data-visualization
```

Commit rules:

- Every major task gets its own commit.
- Cross-repo work should be committed separately in each repo with matching slice numbers in the commit messages.
- Review fixes must be separate `fix:` commits so reviewers can compare original slice work against the review response.
- Do not squash during implementation. Squashing is a release/PR decision after final review.
- Record the base SHA for each repo before the branch is created:

```bash
cd /home/phil/Repos/osi-os
git rev-parse HEAD

cd /home/phil/Repos/osi-server
git rev-parse HEAD
```

Review rule after every slice:

1. Run that slice's verification commands.
2. Run that slice's spec compliance checklist.
3. Commit the slice.
4. Ask for review using the review prompt in the slice.
5. Apply review findings as one or more `fix:` commits.
6. Re-run the same verification commands.
7. Ask for a second review.
8. Continue only after the second review has no blocking findings.
9. If review 2 still has blockers, make one more fix pass and request review 3.
10. If review 3 still has blockers or the reviewers disagree on architecture, stop the slice and escalate the specific decision to the product owner before doing more implementation.

Quality rule for every slice:

- KISS: keep the smallest useful surface for the slice.
- DRY: do not duplicate thresholds, card definitions, or channel mappings when a single owner is defined.
- SoC: keep backend aggregation, frontend rendering, and rule interpretation separate.
- YAGNI: do not add a dynamic plugin system, generalized chart framework, or workspace sync before the spec requires it.
- LoD: frontend components consume history service responses, not raw device internals.

Rollback rule for every slice:

- Database changes must be additive and idempotent.
- Feature flags must be able to hide incomplete History UI without removing data.
- Removing `osi-history-helper` must not corrupt or delete existing data.
- A failed rollout should leave the legacy dashboard and legacy APIs usable.

## Common Verification Commands

Use the subset that matches the touched repo/files.

OSI OS docs and scripts:

```bash
cd /home/phil/Repos/osi-os
git diff --check
node scripts/verify-sync-flow.js
scripts/check-mqtt-topics.sh
```

OSI OS frontend:

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npm run test:unit
npm run build
```

OSI Cloud frontend:

```bash
cd /home/phil/Repos/osi-server/frontend
npm run test:unit
npm run build
```

OSI Cloud backend:

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test
```

Review prompt template:

```text
Please review Slice N of the History Data Visualization implementation.

Spec sources:
- /home/phil/Repos/osi-os/docs/ux/history-data-visualization-redesign-spec.md
- /home/phil/Repos/osi-os/docs/ux/history-data-visualization-gap-analysis.md
- /home/phil/Repos/osi-os/docs/superpowers/plans/2026-05-31-history-data-visualization-implementation.md

Focus:
- correctness against the slice scope
- backwards compatibility
- offline-first edge behavior
- code quality principles
- test and verification coverage
- spec compliance

Please return blocking findings first, then non-blocking improvements.
```

## Slice 0 - Decision Lock And Branch Preparation

**Purpose:** Resolve blockers that affect API shape, schema, card IDs, and performance before code starts.

**Repos:** `osi-os` docs only. `osi-server` branch exists but receives no commit unless server-local notes are required.

**Context:** The redesign spec intentionally leaves several P1 Grill Me questions. This slice converts them into accepted implementation decisions. No backend or frontend implementation starts before this slice is reviewed.

**Files:**

- Modify: `/home/phil/Repos/osi-os/docs/ux/history-data-visualization-redesign-spec.md`
- Modify: `/home/phil/Repos/osi-os/docs/ux/history-data-visualization-gap-analysis.md`
- Modify: `/home/phil/Repos/osi-os/docs/superpowers/plans/2026-05-31-history-data-visualization-implementation.md` if the slice order changes after review

**Decisions to record:**

- Card identity strategy: merged cards per theme or per-source cards.
- Deterministic `logical_source_key` derivation.
- Season model: add `zone_seasons` or hide Season until configured.
- Edge helper packaging: existing `/usr/share/node-red/osi-*-helper` pattern or formal Node-RED contrib package.
- Edge rollup strategy: `history_channel_rollups` table or on-the-fly helper aggregation using composite indexes only.
- Cloud long-range aggregation: new typed hourly/daily rollups for measured card channels; existing daily tables are supplemental only.
- Workspace/preference owner identity: edge `users.id` only, edge `users.user_uuid`, linked account UUID, or cloud-only owner.
- Workspace/preference sync: local-only edge MVP or synced.
- OSI OS comparison cap: 4 visible panels, fewer panels, or disabled by default.
- Cloud Gateway Connectivity Timeline: persist heartbeat/status history in MVP or mark unavailable.
- Coverage confidence enum: include `configured`, `derived`, `unknown`, or omit coverage when cadence is unknown.
- i18n key prefix: use `history.card.*`, `history.calendar.*`, `history.interpretation.*`, and `history.workspace.*`, or choose a different prefix.
- Critical alert ordering: critical alerts may override pinned cards or pinned cards always remain first.

Decision defaults if product owner is unreachable:

```text
Decision: card-key strategy = hybrid-zone-merged-except-dendro-per-source
Decision: logical-source-key derivation = zone_uuid + card_type + stable role, with raw DevEUI only inside backend/advanced metadata; Dendro may use an opaque DevEUI-derived hash
Decision: season model = add zone_seasons and hide Season until a zone has active boundaries
Decision: edge helper packaging = existing /usr/share/node-red/osi-*-helper pattern, modeled on osi-dendro-helper
Decision: edge rollup strategy = history_channel_rollups for 30D and Season, raw/composite-index reads for 12h/24h/7D
Decision: cloud long-range aggregation = new typed hourly/daily rollups; existing daily tables are supplemental only
Decision: workspace owner identity = user_id for local access plus owner_user_uuid from users.user_uuid when available; no edge workspace sync in MVP
Decision: workspace preference sync = local-only edge MVP, cloud-owned cloud workspaces
Decision: edge comparison cap = 4 visible panels behind historyComparisonEnabled
Decision: cloud gateway connectivity = unavailable until heartbeat/status history persistence exists
Decision: coverage confidence = configured | derived | unknown
Decision: i18n key prefix = history.*
Decision: critical alert ordering = pinned cards remain first; critical alerts rank first only among unpinned cards
```

Existing cloud daily table inventory:

- `dendro_daily`: dendrometer daily metrics only.
- `zone_daily_environment`: zone-level environmental summary, not a typed raw sensor rollup.
- `zone_daily_recommendations`: recommendation summary, not a telemetry rollup.
- `irrigation_events`: event stream, not a numeric channel rollup.
- Prediction day tables: forecast/model output, not measured telemetry rollups.

Therefore, typed rollups are required for 30D/Season measured card channels in cloud MVP. Existing daily tables may add context but do not replace measured-channel rollups.

**Steps:**

- [ ] Ask the product owner for concrete answers to the decisions above.
- [ ] If the product owner is unavailable, apply the defaults above and record that the default path was used.
- [ ] Edit the redesign spec so each decision is stated as accepted implementation behavior.
- [ ] Edit the gap analysis so blocking questions reflect only remaining unresolved questions.
- [ ] Re-read `docs/adr/2026-05-28-static-device-plugin-registry.md` and confirm the accepted helper/card-definition approach does not imply runtime plugin loading.
- [ ] Add an explicit `Accepted implementation decisions` section to the redesign spec with one `Decision:` line per decision.
- [ ] Run verification:

```bash
cd /home/phil/Repos/osi-os
git diff --check -- docs/ux/history-data-visualization-redesign-spec.md docs/ux/history-data-visualization-gap-analysis.md docs/superpowers/plans/2026-05-31-history-data-visualization-implementation.md
LC_ALL=C rg -n '[^[:ascii:]]' docs/ux/history-data-visualization-redesign-spec.md docs/ux/history-data-visualization-gap-analysis.md docs/superpowers/plans/2026-05-31-history-data-visualization-implementation.md
rg -n 'TO''DO|TB''D|FIX''ME|PLACE''HOLDER' docs/ux/history-data-visualization-redesign-spec.md docs/ux/history-data-visualization-gap-analysis.md docs/superpowers/plans/2026-05-31-history-data-visualization-implementation.md
for marker in \
  'Decision: card-key strategy' \
  'Decision: logical-source-key derivation' \
  'Decision: season model' \
  'Decision: edge helper packaging' \
  'Decision: edge rollup strategy' \
  'Decision: cloud long-range aggregation' \
  'Decision: workspace owner identity' \
  'Decision: workspace preference sync' \
  'Decision: edge comparison cap' \
  'Decision: cloud gateway connectivity' \
  'Decision: coverage confidence' \
  'Decision: i18n key prefix' \
  'Decision: critical alert ordering'
do
  rg -q "^${marker}" docs/ux/history-data-visualization-redesign-spec.md
done
```

Expected:

- `git diff --check` exits 0.
- ASCII scan exits 1 with no matches.
- placeholder scan exits 1 with no matches.
- every decision marker is present in the redesign spec.

**Commit:**

```bash
cd /home/phil/Repos/osi-os
git add docs/ux/history-data-visualization-redesign-spec.md docs/ux/history-data-visualization-gap-analysis.md docs/superpowers/plans/2026-05-31-history-data-visualization-implementation.md
git commit -m "docs: lock history visualization implementation decisions"
```

**Spec compliance checklist:**

- [ ] Spec has no P1 decision that blocks API shape.
- [ ] The card ID strategy is deterministic across edge and cloud.
- [ ] Season behavior is explicit.
- [ ] Edge and cloud rollup strategies are explicit.
- [ ] Workspace owner identity is sync-safe or sync is explicitly deferred.
- [ ] i18n key ownership is explicit before UI slices.
- [ ] Comparison cap is explicit before visualization slices.
- [ ] Review loop is preserved in this plan.

**Mandatory review loop:**

- [ ] Ask for review using the common prompt with `Slice 0`.
- [ ] Commit review fixes with `fix: address history decision review`.
- [ ] Ask for second review before Slice 1.

## Slice 1 - History Contracts, Fixtures, And Static Card Definitions

**Purpose:** Establish shared card/data/workspace response contracts and static card definitions in both frontends without touching production endpoints.

**Repos:** `osi-os`, `osi-server`.

**Context:** This slice gives both frontends and backends a stable vocabulary: card type, view mode, range, aggregation, availability, freshness, calendar states, advanced field availability, and workspace schema. It deliberately keeps physical device protocol mapping out of UI components.

**OSI OS files:**

- Create: `/home/phil/Repos/osi-os/web/react-gui/src/history/types.ts`
- Create: `/home/phil/Repos/osi-os/web/react-gui/src/history/cardDefinitions.ts`
- Create: `/home/phil/Repos/osi-os/web/react-gui/src/history/overlayPolicy.ts`
- Create: `/home/phil/Repos/osi-os/web/react-gui/src/history/rangeModel.ts`
- Create: `/home/phil/Repos/osi-os/web/react-gui/src/history/platformLimits.ts`
- Create: `/home/phil/Repos/osi-os/web/react-gui/src/history/i18nKeys.ts`
- Create: `/home/phil/Repos/osi-os/web/react-gui/tests/history-contracts.test.ts`
- Create: `/home/phil/Repos/osi-os/web/react-gui/tests/fixtures/history-card-response.json`
- Modify: `/home/phil/Repos/osi-os/web/react-gui/package.json`

**OSI Cloud files:**

- Create: `/home/phil/Repos/osi-server/frontend/src/history/types.ts`
- Create: `/home/phil/Repos/osi-server/frontend/src/history/cardDefinitions.ts`
- Create: `/home/phil/Repos/osi-server/frontend/src/history/overlayPolicy.ts`
- Create: `/home/phil/Repos/osi-server/frontend/src/history/rangeModel.ts`
- Create: `/home/phil/Repos/osi-server/frontend/src/history/platformLimits.ts`
- Create: `/home/phil/Repos/osi-server/frontend/src/history/i18nKeys.ts`
- Create: `/home/phil/Repos/osi-server/frontend/tests/history-contracts.test.ts`
- Create: `/home/phil/Repos/osi-server/frontend/tests/fixtures/history-card-response.json`

**Required contract content:**

- `HistoryCardType`: `soil`, `dendro`, `environment`, `irrigation`, `gateway`.
- `HistoryViewMode`: card-specific values from the spec.
- `HistoryRangeLabel`: `12h`, `24h`, `7d`, `30d`, `season`, `custom`.
- `HistoryAggregationLevel`: `auto`, `raw`, `15m`, `hourly`, `daily`, `weekly`.
- `HistorySyncState`: `local`, `synced`, `stale`, `degraded`, `unknown`.
- `AdvancedFieldAvailability`: `collected`, `not_collected_at_time`, `unknown_now`, `unsupported`.
- `CoverageConfidence`: `configured`, `derived`, `unknown`.
- `WorkspaceSchemaVersion`: `1`.
- `maxPanelsByPlatform`: edge value from Slice 0, cloud value from Slice 0 or default 8.
- `HistoryI18nKeys`: constants with the Slice 0 prefix, including card titles, calendar state labels, interpretation text, and workspace labels.
- `HistoryCardSummary`, `HistoryCardDataResponse`, `HistoryWorkspace`.
- Static definitions for Soil, Dendro, Environment, Irrigation, Gateway.
- Shared JSON fixtures for representative card summary and card data responses.

**Steps:**

- [ ] Write contract tests that assert every card has a default view included in its `views`.
- [ ] Write contract tests that assert no non-Advanced card definition allows advanced-only overlays.
- [ ] Write contract tests that assert `gateway` is hub-scoped and the other MVP cards are zone-scoped.
- [ ] Write contract tests that assert `coverageConfidence`, `WorkspaceSchemaVersion`, `maxPanelsByPlatform`, and i18n key constants exist.
- [ ] Write fixture tests in both repos that parse the same representative response shapes.
- [ ] Add matching TypeScript types in both repos.
- [ ] Add static card definitions in both repos.
- [ ] Add range-to-default-aggregation helpers in both repos.
- [ ] Add overlay policy helpers in both repos.
- [ ] Update edge `package.json` so `npm run test:unit:vitest` includes `src/components/history/__tests__` before Slice 5 adds component tests. Recommended script: `vitest run src/components/farming/__tests__ src/components/history/__tests__`.
- [ ] Do not change cloud `test:unit` unless needed; it already runs `vitest run --environment jsdom --dir src`.
- [ ] Run OSI OS frontend tests:

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npm run test:unit
```

- [ ] Run OSI Cloud frontend tests:

```bash
cd /home/phil/Repos/osi-server/frontend
npm run test:unit
```

**Commits:**

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src/history web/react-gui/tests web/react-gui/package.json
git commit -m "feat(history): add edge history contracts"

cd /home/phil/Repos/osi-server
git add frontend/src/history frontend/tests/history-contracts.test.ts
git commit -m "feat(history): add cloud history contracts"
```

**Spec compliance checklist:**

- [ ] Card definitions are static in-repo definitions.
- [ ] There is no dynamic plugin loader.
- [ ] View modes are card-specific.
- [ ] Advanced-only overlays are excluded from normal modes.
- [ ] Gateway is hub-scoped.
- [ ] Types match the spec fields, including `syncState`, `timezone`, limits, and advanced field availability.
- [ ] `coverageConfidence`, workspace schema version, i18n keys, and panel caps are defined before downstream slices use them.
- [ ] Edge history component tests will be included by `npm run test:unit`.

**Mandatory review loop:**

- [ ] Ask for review using the common prompt with `Slice 1`.
- [ ] Commit fixes in each affected repo with `fix(history): address contract review`.
- [ ] Ask for second review before Slice 2.

## Slice 2 - Edge Storage, Indexes, Helper Module, And Rollup Foundation

**Purpose:** Add the local database and helper foundation required for performant offline aggregation and interpretation.

**Repo:** `osi-os`.

**Context:** The edge cannot rely on long raw scans over TEXT timestamps. This slice adds additive schema, indexes, and a helper module without changing farmer-facing UI. Slice 2 has two commits: 2A for schema/indexes, 2B for helper/runtime packaging.

**Files:**

- Modify: `/home/phil/Repos/osi-os/database/seed-blank.sql`
- Create: `/home/phil/Repos/osi-os/database/migrations/<date>-history-data-visualization-foundation.sql`
- Modify: `/home/phil/Repos/osi-os/scripts/repair-pi-schema.js`
- Modify: `/home/phil/Repos/osi-os/scripts/verify-db-schema-consistency.js`
- Create: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/package.json`
- Create: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js`
- Mirror: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/package.json`
- Mirror: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js`
- Create: `/home/phil/Repos/osi-os/scripts/test-history-helper.js`

**Schema additions:**

- `zone_seasons`
- `history_channel_rollups`
- `history_card_preferences`
- `history_workspaces`
- `idx_device_data_deveui_recorded_at`
- any missing card-history composite index identified during implementation

**Helper responsibilities:**

- Validate card IDs.
- Derive card availability from zone/device rows.
- Classify soil, dendro, environment, irrigation, and gateway status.
- Derive expected cadence from configured interval or 7-day median sample delta.
- Aggregate raw rows into `raw`, `15m`, `hourly`, `daily`, and `weekly` shapes.
- Return `coverageConfidence`: `configured`, `derived`, or `unknown`.
- Return deterministic interpretation rule output.

Helper packaging precedent:

- Follow `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-dendro-helper/`.
- Keep a local `package.json` and `index.js`.
- Load from Node-RED function-node `libs`, matching existing helper usage.
- Mirror byte-for-byte into the bcm2709 runtime payload.

Performance verification target:

- 30D single-card aggregation should be planned for p95 under 1.5 s.
- Season single-card aggregation should be planned for p95 under 2.5 s.
- `history_channel_rollups` is required before enabling 30D or Season on edge.

**Steps:**

### Task 2A - Edge schema, indexes, repair, and explain verification

- [ ] Add schema tables and indexes to `seed-blank.sql`.
- [ ] Add an idempotent migration and repair path.
- [ ] Update schema consistency verification for the new tables and indexes.
- [ ] Add an EXPLAIN QUERY PLAN check to the schema verifier for a worst-case card query shape: `deveui IN (...) AND recorded_at BETWEEN ...`.
- [ ] Ensure the EXPLAIN check confirms use of `idx_device_data_deveui_recorded_at`.
- [ ] Run schema verification:

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-db-schema-consistency.js
```

Expected: exits 0 and reports the composite index expected by the history query.

- [ ] Commit schema work:

```bash
cd /home/phil/Repos/osi-os
git add database scripts/repair-pi-schema.js scripts/verify-db-schema-consistency.js
git commit -m "feat(history): add edge history schema"
```

### Task 2B - Edge helper module and SQLite-backed helper tests

- [ ] Write `scripts/test-history-helper.js` covering status classification, cadence fallback, coverage unknown behavior, aggregation bucket output, and SQL-backed aggregation against an in-memory SQLite database.
- [ ] The helper test must load the canonical schema from `database/seed-blank.sql` into `:memory:` and insert fixture rows before running aggregation assertions.
- [ ] Run the helper test before implementation and confirm it fails because the helper does not exist:

```bash
cd /home/phil/Repos/osi-os
node scripts/test-history-helper.js
```

Expected: exits non-zero with module not found or missing export.

- [ ] Add the edge helper module under the bcm2712 profile.
- [ ] Mirror the helper module to the bcm2709 profile.
- [ ] Run helper tests:

```bash
cd /home/phil/Repos/osi-os
node scripts/test-history-helper.js
```

- [ ] Confirm the helper files are mirrored:

```bash
cd /home/phil/Repos/osi-os
diff -u \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/index.js
diff -u \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/package.json \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper/package.json
```

- [ ] Run edge verification:

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-sync-flow.js
```

**Commit helper work:**

```bash
cd /home/phil/Repos/osi-os
git add scripts/test-history-helper.js conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-history-helper
git commit -m "feat(history): add edge history helper"
```

**Spec compliance checklist:**

- [ ] Schema changes are additive.
- [ ] No provisioned Pi database replacement is introduced.
- [ ] Composite indexes exist for card range queries.
- [ ] EXPLAIN QUERY PLAN verifies the composite index is used.
- [ ] Helper is mirrored across runtime profiles.
- [ ] Helper logic is tested outside Node-RED and against the canonical SQLite schema.
- [ ] `flows.json` is not expanded with large aggregation code in this slice.
- [ ] Rollup table creation matches the Slice 0 edge rollup decision.
- [ ] Rollback contract is documented: additive DB changes remain harmless if history flags are off.

**Mandatory review loop:**

- [ ] Ask for review using the common prompt with `Slice 2`.
- [ ] Commit fixes with `fix(history): address edge foundation review`.
- [ ] Ask for second review before Slice 3.

## Slice 3 - Edge History REST APIs

**Purpose:** Expose edge card summary, card data, Advanced View, preference, and workspace APIs through Node-RED while delegating business logic to `osi-history-helper`.

**Repo:** `osi-os`.

**Context:** Existing APIs are device-field oriented. This slice adds zone-card endpoints without removing legacy endpoints.

Flow-edit constraint:

- `flows.json` is large and single-line in the runtime payload. Keep this slice's flow changes to endpoint orchestration and helper calls.
- Do not add calendar/interpretation business logic in this slice; Slice 8 extends the helper after this API baseline is stable.

**Files:**

- Modify: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json`
- Mirror: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json`
- Modify: `/home/phil/Repos/osi-os/conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js` if API orchestration needs new helper functions
- Modify: `/home/phil/Repos/osi-os/scripts/verify-sync-flow.js`
- Create: `/home/phil/Repos/osi-os/scripts/verify-history-api-contract.js`

Use the correct profile path during implementation: `conf/full_raspberrypi_bcm27xx_bcm2712/...`.

**Endpoints:**

- `GET /api/history/zones/:zoneId/cards`
- `GET /api/history/zones/:zoneId/cards/:cardId/data`
- `GET /api/history/zones/:zoneId/cards/:cardId/advanced`
- `GET /api/history/gateways/:gatewayEui/cards`
- `GET /api/history/gateways/:gatewayEui/cards/:cardId/data`
- `GET /api/history/gateways/:gatewayEui/cards/:cardId/advanced`
- `GET /api/history/workspaces`
- `POST /api/history/workspaces`
- `PUT /api/history/workspaces/:id`
- `DELETE /api/history/workspaces/:id`
- `PUT /api/history/zones/:zoneId/cards/:cardId/preferences`
- `POST /api/history/zones/:zoneId/cards/:cardId/opened`
- `GET /api/system/features`

**API behavior:**

- Use existing JWT verification and zone ownership patterns from neighboring Node-RED endpoints.
- Return 200 with empty data for known cards with no readings in range.
- Return 400 for unsupported range/view/aggregation.
- Return 404 for inaccessible or unknown zones/cards.
- Include `limits`, `freshness`, `timezone`, and `syncState`.
- Keep edge workspaces local-only unless Slice 0 selected sync.

Feature flag response:

```json
{
  "generatedAt": "2026-05-31T10:00:00Z",
  "features": {
    "historyUxEnabled": false,
    "historyComparisonEnabled": false,
    "historyWorkspacesEnabled": false,
    "historyAdvancedOverlaysEnabled": false,
    "historyCloudAiEnabled": false
  }
}
```

Frontend failure contract:

- If `/api/system/features` fails or times out, the UI must default all history flags to false and leave the legacy dashboard usable.
- The History route may show a retryable unavailable state, but it must not block first paint of the legacy dashboard.

**Steps:**

- [ ] Write `scripts/verify-history-api-contract.js` to inspect `flows.json` for the required endpoint URLs and helper `libs` usage.
- [ ] Run the verifier before endpoint creation and confirm it fails.
- [ ] Add a Node-RED History tab with minimal orchestration nodes.
- [ ] Use `osi-history-helper` through function-node `libs`.
- [ ] Add lightweight endpoint timing logs for card summary/data/advanced endpoints, including selected aggregation level and whether data came from raw rows or rollups.
- [ ] Keep `scripts/verify-history-api-contract.js` as the owner of history endpoint checks.
- [ ] Chain `scripts/verify-history-api-contract.js` from `scripts/verify-sync-flow.js` as a sub-step, matching the existing parity-check chaining pattern.
- [ ] Mirror `flows.json` to the bcm2709 profile.
- [ ] Run a normalized payload parity diff after mirroring:

```bash
cd /home/phil/Repos/osi-os
diff -u \
  <(jq -S . conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json) \
  <(jq -S . conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json)
```

Expected: no diff.

- [ ] Run verification:

```bash
cd /home/phil/Repos/osi-os
node scripts/verify-history-api-contract.js
node scripts/verify-sync-flow.js
scripts/check-mqtt-topics.sh
```

**Commit:**

```bash
cd /home/phil/Repos/osi-os
git add conf scripts
git commit -m "feat(history): expose edge history APIs"
```

**Spec compliance checklist:**

- [ ] REST remains the only cloud-to-edge command path.
- [ ] MQTT subscriptions are unchanged.
- [ ] New endpoints do not remove legacy history endpoints.
- [ ] Node-RED functions orchestrate helper calls instead of carrying large aggregation/rule blocks.
- [ ] API errors and empty states match the spec.
- [ ] Feature flags are runtime-readable through `/api/system/features`.
- [ ] Feature flag failure defaults to off.
- [ ] History endpoint timing and aggregation-source observability exists.
- [ ] `verify-sync-flow.js` chains the history verifier but does not absorb history-specific checks.

**Mandatory review loop:**

- [ ] Ask for review using the common prompt with `Slice 3`.
- [ ] Commit fixes with `fix(history): address edge API review`.
- [ ] Ask for second review before Slice 4.

## Slice 4 - Cloud Storage, Rollups, And Backend History APIs

**Purpose:** Add cloud-side persistence and Spring APIs matching the edge contract, with long-range data served from the Slice 0 cloud aggregation decision.

**Repo:** `osi-server`.

**Context:** Cloud telemetry lives in `sensor_data.data_json` JSONB. Long-range history must not repeatedly extract JSONB fields live for 30D, Season, or multi-season views. The backend uses Java application classes today; use `.java` files in the new `org.osi.server.history` package unless the surrounding package has a stronger local Kotlin precedent.

Performance verification target:

- Cloud 30D/Season single-card data should be planned for p95 under 750 ms from typed rollups.
- Cloud comparison workspace data should be planned for p95 under 1.5 s within the panel cap.
- If those targets cannot be met, keep the affected range/view behind a feature flag.

**Files:**

- Create: `/home/phil/Repos/osi-server/backend/src/main/resources/db/migration/V<next>__history_data_visualization_rollups.sql`
- Create: `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/history/HistoryController.java`
- Create: `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/history/HistoryService.java`
- Create: `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/history/HistoryCardService.java`
- Create: `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/history/HistoryAggregationService.java`
- Create: `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/history/HistoryInterpretationService.java`
- Create: `/home/phil/Repos/osi-server/backend/src/main/java/org/osi/server/history/dto/*`
- Create: `/home/phil/Repos/osi-server/backend/src/test/java/org/osi/server/history/*`

**Schema additions:**

- `zone_seasons`
- `history_card_preferences`
- `history_workspaces`
- typed hourly/daily rollup table for measured card channels
- gateway heartbeat/status history is deferred in MVP because Slice 0 selected `cloud gateway connectivity = unavailable until heartbeat/status history persistence exists`

**Steps:**

- [ ] Write controller/service tests for card summary, card data empty range, unsupported view, and workspace authorization.
- [ ] Write aggregation tests proving 30D/Season calls do not use raw live JSONB scans.
- [ ] Add a backend test that fails if `HistoryAggregationService` calls a raw `sensor_data.data_json` extraction query for a range longer than 7 days.
- [ ] Before writing the migration, copy the Slice 0 cloud aggregation decision into the migration description or service class documentation.
- [ ] Add Flyway migration.
- [ ] Add DTOs matching frontend contracts from Slice 1.
- [ ] Add `HistoryCardService` for derived thematic cards.
- [ ] Add `HistoryAggregationService` using typed hourly/daily rollups for 30D/Season. Do not label `zone_daily_environment` or `zone_daily_recommendations` as raw sensor rollups; they are supplemental summaries only.
- [ ] Add `HistoryInterpretationService` for local-rule-compatible cloud explanations.
- [ ] Add `HistoryController` endpoints under `/api/v1/history`.
- [ ] Add Spring observability for card endpoint timing, aggregation level, raw-vs-rollup source, and truncation events. Use the existing logging/MeterRegistry pattern in the backend if present.
- [ ] Run backend verification:

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test
```

**Commit:**

```bash
cd /home/phil/Repos/osi-server
git add backend/src/main/resources/db/migration backend/src/main/java/org/osi/server/history backend/src/test/java/org/osi/server/history
git commit -m "feat(history): add cloud history APIs"
```

**Spec compliance checklist:**

- [ ] Long-range cloud history does not depend on live JSONB extraction.
- [ ] Existing daily tables are used only as supplemental context and do not replace measured-channel rollups.
- [ ] API contract matches edge response fields.
- [ ] Workspace authorization uses cloud farm/zone access checks.
- [ ] Cloud workspaces use stable user identity.
- [ ] Gateway Connectivity Timeline behavior matches Slice 0 decision.
- [ ] Existing prediction endpoints are not broken.
- [ ] Timing and aggregation-source observability exists for history endpoints.
- [ ] Rollback contract is documented: Flyway changes are additive and history UI can be disabled by feature flag.

**Mandatory review loop:**

- [ ] Ask for review using the common prompt with `Slice 4`.
- [ ] Commit fixes with `fix(history): address cloud API review`.
- [ ] Ask for second review before Slice 5.

## Slice 5 - OSI OS Frontend History Shell

**Purpose:** Add the edge frontend route, feature flag loading, card discovery, and basic mobile/desktop shell without complex visualization behavior.

**Repo:** `osi-os`.

**Context:** The current edge dashboard remains the default until feature flags enable the new history UX. This slice should make card summaries visible and navigable but not yet implement every card-specific visualization.

**Files:**

- Create: `/home/phil/Repos/osi-os/web/react-gui/src/pages/HistoryDashboard.tsx`
- Create: `/home/phil/Repos/osi-os/web/react-gui/src/components/history/HistoryMobileShell.tsx`
- Create: `/home/phil/Repos/osi-os/web/react-gui/src/components/history/HistoryDesktopShell.tsx`
- Create: `/home/phil/Repos/osi-os/web/react-gui/src/components/history/ThematicCardCarousel.tsx`
- Create: `/home/phil/Repos/osi-os/web/react-gui/src/components/history/HistorySidebar.tsx`
- Create: `/home/phil/Repos/osi-os/web/react-gui/src/components/history/HistoryCardFrame.tsx`
- Create: `/home/phil/Repos/osi-os/web/react-gui/src/history/useHistoryCards.ts`
- Create: `/home/phil/Repos/osi-os/web/react-gui/src/history/useFeatureFlags.ts`
- Modify: `/home/phil/Repos/osi-os/web/react-gui/src/services/api.ts`
- Modify: `/home/phil/Repos/osi-os/web/react-gui/package.json` only if Slice 1 did not already widen `test:unit:vitest`
- Modify: route/navigation files found during implementation
- Create tests under `/home/phil/Repos/osi-os/web/react-gui/src/components/history/__tests__/`

**Steps:**

- [ ] Write component tests for feature flag gating and card list rendering.
- [ ] Confirm `npm run test:unit` runs `src/components/history/__tests__`. If Slice 1 did not update the script, update `test:unit:vitest` now to include `src/components/history/__tests__`.
- [ ] Add `historyAPI` methods to `services/api.ts`.
- [ ] Add `useFeatureFlags` backed by `/api/system/features`.
- [ ] Implement feature flag boot behavior: first paint does not wait for flags; history features default off until the flag response returns; failed flag requests keep history off and expose a retry state.
- [ ] Add `useHistoryCards` backed by `/api/history/zones/:zoneId/cards`.
- [ ] Add mobile card carousel with pinned-first ordering from API metadata.
- [ ] Add desktop shell with sidebar, toolbar area, center empty state, and inspector placeholder.
- [ ] Add route entry without removing `FarmingDashboard`.
- [ ] Run edge frontend verification:

```bash
cd /home/phil/Repos/osi-os/web/react-gui
npm run test:unit
npm run build
```

**Commit:**

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src web/react-gui/tests
git commit -m "feat(history): add edge history shell"
```

**Spec compliance checklist:**

- [ ] Physical DevEUI is not shown in normal history cards.
- [ ] No generic Diagnostics Card exists.
- [ ] View mode controls are card-local.
- [ ] Feature flag path works at runtime.
- [ ] Current dashboard remains reachable.
- [ ] Mobile shell uses carousel navigation; desktop shell uses sidebar layout.

**Mandatory review loop:**

- [ ] Ask for review using the common prompt with `Slice 5`.
- [ ] Commit fixes with `fix(history): address edge shell review`.
- [ ] Ask for second review before Slice 6.

## Slice 6 - OSI Cloud Frontend History Shell

**Purpose:** Add the cloud frontend route and shell matching the edge contract, optimized for desktop-first analysis while preserving current cloud dashboard behavior.

**Repo:** `osi-server`.

**Context:** Cloud should use the same core model as edge but add desktop analysis affordances. This slice mirrors the shell and service contract from Slice 5 with cloud API paths.

**Files:**

- Create: `/home/phil/Repos/osi-server/frontend/src/pages/HistoryDashboard.tsx`
- Create: `/home/phil/Repos/osi-server/frontend/src/components/history/HistoryDesktopShell.tsx`
- Create: `/home/phil/Repos/osi-server/frontend/src/components/history/HistoryMobileShell.tsx`
- Create: `/home/phil/Repos/osi-server/frontend/src/components/history/HistorySidebar.tsx`
- Create: `/home/phil/Repos/osi-server/frontend/src/components/history/HistoryCardFrame.tsx`
- Create: `/home/phil/Repos/osi-server/frontend/src/history/useHistoryCards.ts`
- Create: `/home/phil/Repos/osi-server/frontend/src/history/useFeatureFlags.ts`
- Modify: `/home/phil/Repos/osi-server/frontend/src/services/api.ts`
- Modify: route/navigation files found during implementation
- Create tests under `/home/phil/Repos/osi-server/frontend/src/components/history/__tests__/`

**Steps:**

- [ ] Write tests for `/api/v1/history` service path usage.
- [ ] Add `historyAPI` methods to cloud `services/api.ts`.
- [ ] Add feature flag loading from the cloud feature endpoint selected in Slice 4.
- [ ] Add desktop shell with farm/hub/zone tree area, pinned cards, available cards, and saved workspaces area.
- [ ] Add mobile shell for parity with edge.
- [ ] Keep the existing cloud dashboard route intact.
- [ ] Run cloud frontend verification:

```bash
cd /home/phil/Repos/osi-server/frontend
npm run test:unit
npm run build
```

**Commit:**

```bash
cd /home/phil/Repos/osi-server
git add frontend/src frontend/tests
git commit -m "feat(history): add cloud history shell"
```

**Spec compliance checklist:**

- [ ] Desktop default is single-card mode.
- [ ] Comparison is entered only by adding cards.
- [ ] Existing `Dashboard.tsx` remains compatible.
- [ ] Prediction/Terra UI is not duplicated into this shell yet.
- [ ] Cloud API paths use `/api/v1/history`.

**Mandatory review loop:**

- [ ] Ask for review using the common prompt with `Slice 6`.
- [ ] Commit fixes with `fix(history): address cloud shell review`.
- [ ] Ask for second review before Slice 7.

## Slice 7 - Time Viewport, Semantic Zoom, And Core Visualizations

**Purpose:** Add the shared time viewport controller and MVP card visualizations for Soil, Dendro, Environment, Irrigation, and Gateway in both frontends.

**Repos:** `osi-os`, `osi-server`.

**Context:** This slice adds real visualization behavior. It keeps rendering components card-specific and keeps aggregation truth sourced from backend responses. Slice 7 is intentionally multi-commit so each visualization can be reviewed independently if a card-specific issue appears.

**Files in each frontend:**

- Create: `src/history/useTimeViewport.ts`
- Create: `src/history/useHistoryCardData.ts`
- Create: `src/components/history/visualizations/SoilProfileView.tsx`
- Create: `src/components/history/visualizations/DendroGrowthTimelineView.tsx`
- Create: `src/components/history/visualizations/EnvironmentLineChartView.tsx`
- Create: `src/components/history/visualizations/IrrigationEventTimelineView.tsx`
- Create: `src/components/history/visualizations/GatewayStatusOverviewView.tsx`
- Create: `src/components/history/TimelineBrush.tsx`
- Create: visualization tests under `src/components/history/visualizations/__tests__/`

**Steps:**

### Task 7A - Viewport, brush, aggregation badge, and data hook

- [ ] Write tests for range-to-aggregation mapping.
- [ ] Write tests that mouse wheel inside timeline changes viewport and outside timeline does not.
- [ ] Write tests that double tap/double click resets to card default range.
- [ ] Add `useHistoryCardData` keyed by zone, card, view, range, aggregation, and overlays.
- [ ] Add `TimelineBrush`.
- [ ] Add aggregation badge using the backend-reported aggregation level.
- [ ] Add a `maxPanelsByPlatform` import from Slice 1 contract files so later comparison work cannot ignore the cap.
- [ ] Run edge and cloud frontend tests.
- [ ] Commit viewport work in each repo:

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src web/react-gui/tests
git commit -m "feat(history): add edge time viewport"

cd /home/phil/Repos/osi-server
git add frontend/src frontend/tests
git commit -m "feat(history): add cloud time viewport"
```

### Task 7B - Soil Profile

- [ ] Implement Soil Profile using depth-aware profile data.
- [ ] Run edge and cloud frontend tests.
- [ ] Commit Soil Profile in each repo:

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src web/react-gui/tests
git commit -m "feat(history): add edge soil profile view"

cd /home/phil/Repos/osi-server
git add frontend/src frontend/tests
git commit -m "feat(history): add cloud soil profile view"
```

### Task 7C - Dendro Growth Timeline

- [ ] Implement Dendro Growth Timeline using growth/shrinkage series and event markers.
- [ ] Run edge and cloud frontend tests.
- [ ] Commit Dendro Growth Timeline in each repo:

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src web/react-gui/tests
git commit -m "feat(history): add edge dendro growth timeline"

cd /home/phil/Repos/osi-server
git add frontend/src frontend/tests
git commit -m "feat(history): add cloud dendro growth timeline"
```

### Task 7D - Environment Line Chart

- [ ] Implement Environment Line Chart with clear units.
- [ ] Run edge and cloud frontend tests.
- [ ] Commit Environment Line Chart in each repo:

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src web/react-gui/tests
git commit -m "feat(history): add edge environment line chart"

cd /home/phil/Repos/osi-server
git add frontend/src frontend/tests
git commit -m "feat(history): add cloud environment line chart"
```

### Task 7E - Irrigation Event Timeline

- [ ] Implement Irrigation Event Timeline with event markers and response windows.
- [ ] Run edge and cloud frontend tests.
- [ ] Commit Irrigation Event Timeline in each repo:

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src web/react-gui/tests
git commit -m "feat(history): add edge irrigation event timeline"

cd /home/phil/Repos/osi-server
git add frontend/src frontend/tests
git commit -m "feat(history): add cloud irrigation event timeline"
```

### Task 7F - Gateway Status Overview

- [ ] Implement Gateway Status Overview.
- [ ] Run edge frontend verification.
- [ ] Run cloud frontend verification.
- [ ] Commit Gateway Status Overview in each repo:

```bash
cd /home/phil/Repos/osi-os
git add web/react-gui/src web/react-gui/tests
git commit -m "feat(history): add edge gateway status view"

cd /home/phil/Repos/osi-server
git add frontend/src frontend/tests
git commit -m "feat(history): add cloud gateway status view"
```

**Spec compliance checklist:**

- [ ] Zoom changes representation through requested aggregation; UI does not fake aggregation labels.
- [ ] Soil default view is Soil Profile.
- [ ] Dendro default view is Growth Timeline.
- [ ] Environment default view is Line Chart.
- [ ] Irrigation default view is Event Timeline.
- [ ] Gateway has Status Overview.
- [ ] Swipe/pan/zoom target boundaries are explicit.
- [ ] Recharts usage remains contained behind visualization components.

**Mandatory review loop:**

- [ ] Ask for review using the common prompt with `Slice 7`.
- [ ] Commit fixes with `fix(history): address visualization review`.
- [ ] Ask for second review before Slice 8.

## Slice 8 - Calendar, Interpretation, And Advanced View

**Purpose:** Add theme-specific calendar views, local rule-based explanations, cloud extension fields, and Advanced View diagnostics.

**Repos:** `osi-os`, `osi-server`.

**Context:** Calendar and interpretation must use shared backend threshold classifiers. Frontends render states and localized text; they must not reimplement agronomic classification.

**Edge files:**

- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/index.js`
- Mirror helper changes to bcm2709.
- Modify: `web/react-gui/src/components/history/*`
- Add tests for calendar/advanced rendering.

**Cloud files:**

- Modify: `backend/src/main/java/org/osi/server/history/HistoryInterpretationService.java`
- Modify: `backend/src/main/java/org/osi/server/history/HistoryAggregationService.java`
- Modify: `frontend/src/components/history/*`
- Add backend and frontend tests.

**Steps:**

- [ ] Add helper tests for Soil, Dendro, Environment, and Irrigation calendar states.
- [ ] Add backend tests for Advanced View availability values: `collected`, `not_collected_at_time`, `unknown_now`, `unsupported`.
- [ ] Add locale values for the i18n keys defined in Slice 1: card titles, calendar state labels, workspace labels, and interpretation text.
- [ ] Implement backend calendar state output using threshold classifiers.
- [ ] Implement backend interpretation output with evidence references.
- [ ] Implement Advanced View API rendering without showing diagnostics in normal card UI.
- [ ] Add cloud-only interpretation extension slots for prediction/weather fields available from existing services.
- [ ] Run edge helper/API/frontend verification.
- [ ] Run cloud backend/frontend verification.

**Commits:**

```bash
cd /home/phil/Repos/osi-os
git add conf web/react-gui scripts
git commit -m "feat(history): add edge calendar and advanced views"

cd /home/phil/Repos/osi-server
git add backend frontend
git commit -m "feat(history): add cloud calendar and advanced views"
```

**Spec compliance checklist:**

- [ ] Calendar cells use zone timezone.
- [ ] Threshold classification has a backend owner.
- [ ] Interpretation source is `local-rule` on edge.
- [ ] Advanced View exposes DevEUI and diagnostics only inside Advanced View.
- [ ] Old rows can distinguish unavailable diagnostics from collected null values.
- [ ] i18n files own farmer-facing labels and explanations.

**Mandatory review loop:**

- [ ] Ask for review using the common prompt with `Slice 8`.
- [ ] Commit fixes with `fix(history): address calendar and advanced review`.
- [ ] Ask for second review before Slice 9.

## Slice 9 - Preferences, Workspaces, Learned Ordering, And Comparison

**Purpose:** Add persistent card pinning, learned ordering, saved workspaces, and capped comparison mode.

**Repos:** `osi-os`, `osi-server`.

**Context:** Edge preferences/workspaces are local-only unless Slice 0 selected sync. Comparison is stacked panels with shared x-axis and must enforce the panel caps from the spec.

Ordering behavior:

- Use the Slice 0 critical alert decision.
- Default behavior is pinned cards first; critical alerts rank first among unpinned cards only.
- Do not re-decide ordering behavior in this slice.

**Files in each frontend:**

- Create or modify: `src/history/useWorkspaceState.ts`
- Create: `src/components/history/WorkspaceManager.tsx`
- Create: `src/components/history/ComparisonWorkspace.tsx`
- Create: `src/components/history/SynchronizedPanelStack.tsx`
- Create: `src/components/history/RightInspector.tsx`
- Modify: history service APIs
- Add tests for pinning, learned ordering, workspace migration, missing card handling, and panel cap.

**Backend files:**

- Edge: Node-RED history workspace/preference endpoints and helper support.
- Cloud: Spring workspace/preference services and repository tests.

**Steps:**

- [ ] Write tests for pinned-first ordering.
- [ ] Write tests for open-count/last-opened updates.
- [ ] Write tests for workspace schema migration.
- [ ] Write tests for dangling card IDs rendering as unavailable panels.
- [ ] Write tests for edge panel cap and cloud panel cap.
- [ ] Implement preference endpoints and frontend calls.
- [ ] Implement workspace CRUD and frontend manager.
- [ ] Implement stacked comparison with synchronized x-axis.
- [ ] Implement right inspector selected timestamp summary.
- [ ] Add performance warning when panel cap would be exceeded.
- [ ] Import panel caps from the Slice 1 `maxPanelsByPlatform` contract. Do not hardcode separate cap values in components.
- [ ] Run all touched repo verification commands.

**Commits:**

```bash
cd /home/phil/Repos/osi-os
git add conf web/react-gui scripts database
git commit -m "feat(history): add edge workspaces and comparison"

cd /home/phil/Repos/osi-server
git add backend frontend
git commit -m "feat(history): add cloud workspaces and comparison"
```

**Spec compliance checklist:**

- [ ] Pinned cards are first.
- [ ] Critical alert ordering matches the Slice 0 decision.
- [ ] New cards appear after high-use cards.
- [ ] Workspaces persist selected cards, panel order, collapsed state, date range, aggregation, view modes, overlays, inspector state, pinned status, and comparison layout.
- [ ] Comparison panels are stacked by default.
- [ ] Crosshair/inspector synchronization works across visible panels.
- [ ] Panel caps are enforced.

**Mandatory review loop:**

- [ ] Ask for review using the common prompt with `Slice 9`.
- [ ] Commit fixes with `fix(history): address workspace and comparison review`.
- [ ] Ask for second review before Slice 10.

## Slice 10 - Final Hardening, Spec Traceability, And Cross-Repo Verification

**Purpose:** Prove the implementation matches the written spec and prepare both branches for PR review.

**Repos:** `osi-os`, `osi-server`.

**Context:** This slice does not add new product surface unless a gap is found. It closes the loop: spec traceability, quality review, browser validation notes, and full verification.

**Files:**

- Modify: `/home/phil/Repos/osi-os/docs/ux/history-data-visualization-redesign-spec.md` if implementation decisions changed.
- Modify: `/home/phil/Repos/osi-os/docs/ux/history-data-visualization-gap-analysis.md` if gaps are closed or deferred.
- Create: `/home/phil/Repos/osi-os/docs/ux/history-data-visualization-implementation-trace.md`
- Modify: release or verification docs only if commands changed.

**Steps:**

- [ ] Create an implementation trace table mapping every spec section to commits and tests.
- [ ] Use this implementation trace schema:

```markdown
| Spec section | Requirement | Repo | Slice | Commit SHA | Tests / verification | Status |
| --- | --- | --- | --- | --- | --- | --- |
```

- [ ] Run OSI OS full verification:

```bash
cd /home/phil/Repos/osi-os
git diff --check
node scripts/verify-db-schema-consistency.js
node scripts/verify-history-api-contract.js
node scripts/verify-sync-flow.js
scripts/check-mqtt-topics.sh
cd web/react-gui
npm run test:unit
npm run build
```

- [ ] Run OSI Cloud full verification:

```bash
cd /home/phil/Repos/osi-server/backend
./gradlew test

cd /home/phil/Repos/osi-server/frontend
npm run test:unit
npm run build
```

- [ ] Run code-quality self-review:

```text
Check:
- Are thresholds owned in one backend/helper path?
- Are card definitions static and not runtime plugins?
- Is long-range cloud aggregation served without live JSONB scans?
- Is edge aggregation delegated to helper/rollups rather than embedded flow code?
- Does every new endpoint have auth/access behavior?
- Does every frontend card consume history API responses rather than raw physical device internals?
- Does the legacy dashboard still work?
- Are workspaces/preferences local-only or synced according to Slice 0?
- Are panel caps enforced?
- Are i18n keys used for farmer-facing strings?
```

- [ ] Record verification outputs in the implementation trace.
- [ ] Check both repos for uncommitted changes.

**Commits:**

```bash
cd /home/phil/Repos/osi-os
git add docs
git commit -m "docs(history): add implementation trace"

cd /home/phil/Repos/osi-server
git status --short --branch
```

If final hardening changes code in either repo, commit with:

```bash
git commit -m "fix(history): address final verification findings"
```

**Spec compliance checklist:**

- [ ] Every required MVP card exists.
- [ ] No Diagnostics Card exists.
- [ ] Card-specific view modes are implemented.
- [ ] Mobile-first controls exist with fallbacks for browser gesture conflicts.
- [ ] Desktop single-card mode is default.
- [ ] Comparison mode is stacked and capped.
- [ ] Calendar states are theme-specific.
- [ ] Local rule explanations work offline.
- [ ] Cloud extensions use existing prediction/weather capabilities without inventing AI/satellite services that do not exist.
- [ ] Saved workspaces persist the required fields.
- [ ] Overlay policy enforces standard vs Advanced-only overlays.

**Mandatory review loop:**

- [ ] Ask for final cross-repo review using the common prompt with `Slice 10`.
- [ ] Commit fixes with `fix(history): address final review`.
- [ ] Ask for second final review.
- [ ] Only after second final review, prepare PR descriptions for both repos.

## PR Preparation Notes

Use separate PRs:

- `osi-os`: edge backend, edge frontend, docs, verification scripts.
- `osi-server`: cloud backend, cloud frontend, cloud migrations.

Each PR description should include:

- Branch name.
- Base SHA for each repo.
- Slice commits included.
- Spec sections implemented.
- Known deferred scope.
- Verification commands and results.
- Review cycle summary.

Do not merge either PR until both are reviewed for cross-repo contract compatibility.

Preferred merge policy:

- Keep implementation commits during review.
- After both PRs are approved, squash-merge each PR if repository policy allows it, using the PR description to preserve slice-level traceability.
