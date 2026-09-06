# Journal Scope and Catalog Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make station/group scopes, final-entry validation, farm-wide capture, and machinery relevance identical on edge and cloud.

**Architecture:** The edge catalog generator remains the source of truth. It emits immutable v11 definitions and normative fixtures consumed by edge validators and vendored by cloud tests. Entry listing and CSV/JSON export share one normalized scope predicate per authority. Cloud-primary plot snapshots provide the same picker data without granting cloud plot mutation authority.

**Tech Stack:** Node.js, Node-RED runtime modules, SQLite, React/TypeScript, Spring Boot/JPA, Flyway, JUnit 5, Vitest.

**Spec:** [Journal Edge/Cloud Parity and Fast Capture](../specs/2026-09-06-journal-edge-cloud-parity-and-fast-capture-design.md), especially §§3.2, 3.4, 4.3, 4.4, 4.6, 6, 9 and Appendix A.

## Global Constraints

- Work only in the existing edge and cloud integration worktrees. Preserve unrelated changes.
- Read each repository's `AGENTS.md`, `architect.yaml`, and `RULES.yaml` before TypeScript edits.
- Use `apply_patch` for hand edits. Generate catalog/database artifacts only through repository scripts.
- Keep bcm2712 and bcm2709 runtime payloads byte-identical.
- Add new immutable catalog definitions; never mutate a published layout/template version.
- Unknown and forbidden scopes must share external `scope_not_found` behavior. Never fall back to an unfiltered list/export.
- A group scope means current membership. Resolved group membership remains frozen.
- `/export.package` remains API-only. Do not add its GUI control or a general Status selector.
- Use failing focused tests before implementation, then run the listed repository gates.

---

### Task 1: One normalized edge scope contract

**Files:**
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/api.js`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/index.test.js`
- Mirror both under `conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/node-red/osi-journal/`
- Modify: `scripts/test-journal-api.js`

**Interfaces:**
- Input query permits at most one of `plot_uuid`, `station_code`, `group_uuid`.
- `station_code`: NFKC, trimmed, case-sensitive, at most 240 UTF-8 bytes.
- `group_uuid`: canonical UUID.
- Stable failures: `conflicting_scope_filters` (400), `scope_not_found` (404).

- [ ] Add failing tests for conflicting filters, invalid UUID/oversized station, unknown and unauthorized scopes, page 1/later-page filtering, current group membership, and resolved-group membership.
- [ ] Add CSV and JSON export tests proving their entry UUID sets equal the corresponding paginated list selection. Assert unknown scope never exports all entries.
- [ ] Run `node scripts/test-journal-api.js` and record the expected failures caused by `normalizeEntryFilters` accepting only `plot_uuid`.
- [ ] Extend `normalizeEntryFilters`, resolve the scope only after owner/gateway authorization, and pass the same normalized selection through `listEntriesInSnapshot`, `exportWideCsv`, and `exportJson`.
- [ ] Keep the public 404 body byte-identical for unknown and inaccessible scope; log any forbidden diagnostic only in the existing safe internal channel.
- [ ] Mirror changed runtime files, then run `node scripts/test-journal-api.js` and `node scripts/verify-profile-parity.js`.
- [ ] Commit the edge slice as `fix: apply journal station and group scopes`.

### Task 2: Equivalent cloud scopes and workspace plot snapshots

**Files:**
- Modify: `/home/phil/Repos/osi-server/.worktrees/integrate-agrolink-analysis-cloud/backend/src/main/java/org/osi/server/journal/JournalController.java`
- Modify: `/home/phil/Repos/osi-server/.worktrees/integrate-agrolink-analysis-cloud/backend/src/main/java/org/osi/server/journal/JournalQueryService.java`
- Modify: `/home/phil/Repos/osi-server/.worktrees/integrate-agrolink-analysis-cloud/backend/src/main/java/org/osi/server/journal/JournalExportService.java`
- Modify: `/home/phil/Repos/osi-server/.worktrees/integrate-agrolink-analysis-cloud/backend/src/main/java/org/osi/server/journal/v2/JournalV2Controller.java`
- Modify: `/home/phil/Repos/osi-server/.worktrees/integrate-agrolink-analysis-cloud/backend/src/main/java/org/osi/server/journal/v2/JournalReferenceService.java`
- Modify: `/home/phil/Repos/osi-server/.worktrees/integrate-agrolink-analysis-cloud/backend/src/main/java/org/osi/server/journal/v2/JournalV2View.java`
- Modify: `backend/src/test/java/org/osi/server/journal/{JournalControllerTest.java,JournalQueryServiceTest.java,JournalExportServiceTest.java}`
- Modify: `backend/src/test/java/org/osi/server/journal/v2/{JournalReferenceServiceTest.java,JournalV2ControllerTest.java}`
- Modify cloud frontend journal service/types only after the backend contract is green.

**Interfaces:**
- Gateway-backed list/export accepts the exact edge scope contract.
- Cloud-primary endpoint lists active `journal_plot_snapshots` scoped to the authenticated workspace and returns plot UUID/name, station code, layout code/version/settings, group memberships, and authority metadata needed by the picker.
- Snapshot listing is read-only.

- [ ] Confirm the current owners remain `JournalController`/`JournalQueryService`/`JournalExportService` for gateway reads and `JournalV2Controller`/`JournalReferenceService`/`JournalV2View` for workspace references. Stop and update this plan if ownership has moved.
- [ ] Add MockMvc/service failures for mutual exclusion, normalization, authorization-before-resolution, current group membership, later pages, CSV/JSON equality, and non-enumerating 404s.
- [ ] Add workspace snapshot-list tests for authorized workspace, foreign workspace, inactive/deleted plot, station ordering, ST72/ST12 fixture counts, and absence of mutation routes.
- [ ] Implement one typed scope value object used by query and both convenient exports; do not duplicate controller string parsing.
- [ ] Implement the workspace-scoped plot snapshot projection and controller response with deterministic station/name/UUID ordering.
- [ ] Extend the frontend service normalization boundary and types. Add contract tests for exact URL parameters and normalized response shape.
- [ ] Run targeted JUnit tests, then commit as `fix: expose journal scopes and workspace plots`.

### Task 3: Generate immutable catalog v11 and its normative matrix

**Files:**
- Modify: `scripts/generate-journal-catalog.js`
- Modify: `scripts/journal-catalog-core.js`
- Modify: `scripts/test-journal-catalog-generator.js`
- Modify: `scripts/test-journal-schema.js`
- Add: `database/migrations/ordered/0051__journal_catalog_v11.sql`; `0050__journal_v2_plot_group_snapshot.sql` was added by the prerequisite cloud-primary group-projection slice. Immediately before generation, recheck that `0050` is still the ordered head and update the plan if another migration has landed.
- Modify generated seed/bundled database artifacts only with existing generator/apply scripts.
- Add/update the generated requirement fixture at the repository's existing catalog fixture location.

**Interfaces:**
- Export `FINAL_REQUIREMENT_MATRIX_V11` covering all 16 activity codes and all 25 `agroscope.operation.*` leaves from Appendix A.
- Active layouts declare exactly one of `available_device_codes` or `availability_mode: all_compatible`.
- Seed `farm_wide@1`, allowing only `equipment_maintenance` and `general_observation`, with no plot/zone/season/context-producing fields.

- [ ] Add generator tests that enumerate all matrix keys and fail on a missing/extra activity or leaf.
- [ ] Add failing positive/negative/empty intersection fixtures for global operation compatibility × layout availability × active device choices. Include retained inactive/historical values for review-only behavior.
- [ ] Add failing validation that every active capture layout has an availability declaration and that no emitted dependency lies outside the computed intersection.
- [ ] Add farm-wide fixtures proving only its two activities resolve and that context output is empty.
- [ ] Implement the exported matrix and canonical global compatibility relation in generator-owned data, then generate new versioned template/layout rows. Set the initial Lysimeter revision to explicit `availability_mode: all_compatible`.
- [ ] Generate the migration and catalog fixtures. Apply the repository's catalog/seed scripts; never hand-edit SQLite blobs.
- [ ] Run `node scripts/test-journal-catalog-generator.js`, `node scripts/test-journal-schema.js`, and `node scripts/verify-db-schema-consistency.js`.
- [ ] Commit as `feat: publish balanced journal catalog definitions`.

### Task 4: Enforce v11 validation and Not observed semantics

**Files:**
- Modify edge validation modules selected from `conf/.../osi-journal/{catalog.js,definition.js,lifecycle.js,unit-family.js,units.js}` and their tests.
- Mirror changed runtime files to bcm2709.
- Modify cloud catalog/mutation validation services and focused JUnit tests.
- Modify edge/cloud pure frontend catalog/template helpers and component tests.

**Interfaces:**
- Final validation consumes the generated matrix; clients do not invent requiredness.
- `not_observed` can satisfy only Appendix A numeric families.
- Status-only row has null value fields but retained semantic attribute and required unit metadata.
- Direct Not observed applies only for one remaining semantic attribute and one unit; otherwise the user must choose meaning and unit. Nutrient rate always requires nutrient unit.

- [ ] Add byte-identical edge/cloud fixture tests for every activity and leaf, each required-any alternative, allowed/disallowed missing status, empty observation, empty maintenance, and farm-wide restrictions.
- [ ] Add stale-client tests rejecting incompatible operation/device pairs server-side while retaining historic incompatible values on read/review.
- [ ] Add UI/payload tests for direct single-choice missing, semantic chooser, multiple-unit chooser, nutrient unit, Review rendering, reversal with Enter value, and multi-plot capture.
- [ ] Implement validator consumption of the generated matrix and dependency intersection on edge, then mirror it.
- [ ] Vendor the generated fixtures through the existing cloud contract provenance mechanism and implement equivalent cloud-primary validation; gateway-backed cloud commands remain subject to edge canonical validation.
- [ ] Implement the semantic Not observed control in shared pure/component code without putting any required control in collapsed More details.
- [ ] Run focused edge Node tests, cloud JUnit tests, both frontend tests, profile parity, and contract-vendor verification.
- [ ] Commit edge and cloud changes separately with `fix: enforce journal capture semantics`.

### Task 5: Independent scope/catalog verification

- [ ] Run edge minimum gates from spec §9.3 that touch schema/catalog/profile/frontend.
- [ ] Run cloud focused journal tests plus `./gradlew test` after later plans are integrated.
- [ ] Compare generated matrix fixtures byte-for-byte across repositories.
- [ ] Verify `git diff --check`, inspect both repository statuses, and record commit SHAs before starting command/receipt work.
