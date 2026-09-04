# Sentek EnviroSCAN ten-channel VWC and VIC implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Extend the paired edge and cloud data contract to represent ten stable Sentek module channels, store VWC and VIC separately, configure channel-to-response-position layouts, and render configured depths without changing the live Dragino recipe before the bench framing is known.

**Architecture:** `devices.sdi12_channel_layout_json` is the canonical versioned Sentek layout. The existing `osi-sdi12-normalize` module owns layout validation and the compatibility depth projection so the Node-RED API and ingest path use one interpretation. Edge SQLite adds the layout plus twelve additive telemetry columns. The edge outbox and cloud mirror accept the new state before an operator activates it. Legacy Sentek devices without a layout keep the existing one-to-eight VWC path. VWC-only canonical layouts map an exact flat vector through explicit response positions. A mixed layout accepts only the exact VWC prefix plus compact TriSCAN VIC suffix; the old VWC-only shape remains quarantined atomically as `sdi12_vic_framing_unverified`.

**Tech stack:** SQLite ordered migrations, Node-RED function nodes, plain Node helper tests, React/TypeScript, Spring Boot/JPA/Flyway, JSON Schema, channel manifests.

**Spec:** `docs/superpowers/specs/2026-08-25-sentek-enviroscan-vwc-vic-design.md` — read first.

## Global constraints

- Edge worktree: `<edge-checkout>`, branch `the source branch`. Cloud worktree: `<cloud-worktree>`, branch `feat/journal-cloud-primary`.
- Preserve the user-owned untracked `node_modules/` on edge and `docs/superpowers/prompts/` on cloud.
- The original no-SSH/downlink constraint was superseded by explicit operator authorization on 2026-08-26. Production `osicloud.ch` access remains out of scope.
- `bcm2712` is canonical. Mirror every maintained runtime payload to `bcm2709`; do not add the new runtime implementation to `bcm2708`. Update all seven committed seed DB copies through the migration/seed workflow because `verify-db-schema-consistency.js` treats them as one schema contract.
- Edit each `flows.json` only with a one-shot Node transformation script after a parse/stringify round-trip assertion. Mirror the result byte-identically. Do not use textual replacement or `apply_patch` on flows.
- Do not widen `sdi12_value_count`, rebuild `devices`, add inline boot columns, restamp fingerprints, replace a live/bundled DB wholesale, or alter the frozen `sync-init-fn` trigger bodies. Migration `0048` is additive and may add migration-owned outbox decorators.
- All SQL values from the settings request are bound parameters. JSON is validated and canonicalized before serialization; no request field is interpolated into SQL.
- Null means missing. Numeric zero remains a measurement. VIC is a separate unitless channel family and is never written to `soil_ec_*`.
- Run tests red before implementation for each behavior. Do not weaken a regression test to make implementation pass.
- Prose files pass `node /home/phil/Repos/osi-os/.claude/skills/anti-slop-writing/slop-check.js <file>`.

## Baseline evidence

- [x] Edge SDI-12 normalizer/reassembler and device-integration tests passed (32 helper tests; 30 integration tests).
- [x] `verify-migrations`, `verify-seed-replay`, and `verify-db-schema-consistency` passed before edits.
- [x] Edge GUI `npm run test:unit` passed: 128 Node-runner tests and 1,739 Vitest tests.
- [x] Cloud compiled and ran 1,638 tests; its only baseline failure is `ArchitectureTest.noNewPackageCycles`, where the ArchUnit frozen-violation store throws `StoreUpdateFailedException`. Preserve this baseline separately from feature regressions and rerun focused suites plus the full test command after implementation.

---

### Task 1: Lock the additive cross-repo contract

**Edge files:**

- `docs/contracts/sync-schema/resources.schema.json`
- `scripts/test-contract-schemas.js`

**Cloud files:**

- `backend/src/test/resources/sync-contract/resources.schema.json`
- `backend/src/main/resources/db/migration/V2026_08_25_001__sentek_channel_layout.sql`
- `backend/src/main/java/org/osi/server/device/Device.java`
- `backend/src/test/java/org/osi/server/sync/EdgeSyncServiceControlPlaneTest.java`
- `backend/src/test/java/org/osi/server/sync/EdgeSyncServiceBootstrapTest.java`

- [x] Add failing contract tests for `sdi12_channel_layout_json` and the complete depth-key allowlist (`vwc_1..10`, `soil_vic_1..10`, existing SWT/temp/EC keys retained). Assert unknown keys still fail because the schema remains strict.
- [x] Add failing cloud sync tests proving a device bootstrap/update preserves the canonical layout JSON and does not overwrite it when an older payload omits the field.
- [x] Extend the edge-owned resource schema, then copy it byte-identically to the cloud vendor path.
- [x] Add the cloud Flyway column and JPA field. Extend the control/bootstrap application paths with presence-aware handling; omission means compatibility, explicit null means clear only where the existing contract permits it.
- [x] Run edge contract tests and the focused cloud sync tests. Confirm the two schema files are byte-identical.

### Task 2: Add edge schema, telemetry, and manifest storage

**Files:**

- `database/migrations/ordered/0048__sentek_vwc_vic_channels.sql`
- `database/migrations/ordered/CHECKSUMS.json`
- `database/seed-blank.sql`
- `scripts/verify-db-schema-consistency.js`
- seven committed `farming.db` paths enumerated by that verifier
- `web/react-gui/src/channels/channels.json`
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/edge-channels.json` and maintained mirror
- `backend/src/main/resources/channels.json` and `frontend/src/channels/channels.json` in the cloud worktree
- channel registry/parity tests in both repositories

- [x] First extend schema/manifests tests so they fail for missing `devices.sdi12_channel_layout_json`, `device_data.vwc_9`, `vwc_10`, and `soil_vic_1..10`.
- [x] Write additive migration `0048`: one `TEXT` device column, twelve `REAL` telemetry columns, and migration-owned triggers that decorate the existing device/device-data outbox rows with the new fields. Do not rebuild a table or replace a boot-owned trigger.
- [x] Update the seed schema with the same columns and trigger bodies. Add the migration checksum; do not alter earlier migration checksums.
- [x] Apply the migration to each committed DB copy using the migration runner or explicit SQLite migration workflow, then verify every schema matches the seed contract. Never copy a blank DB over an existing runtime database.
- [x] Add manifest entries with stable keys, VWC unit `%`, VIC label `VIC`, and no conductivity unit. Keep all three edge/cloud manifest copies semantically identical and pass registry parity tests.
- [x] Run migration immutability, seed replay, DB consistency, fingerprint canonicalization, runtime-schema parity, profile parity, and boot-trigger rewrite rehearsals before continuing.

### Task 3: Make layout validation and legacy normalization explicit

**Files:**

- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/index.js`
- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/index.test.js`
- maintained `bcm2709` mirrors
- `scripts/fixtures/device-integration/sdi12/golden-vectors.json`
- `scripts/verify-device-integration.js`

- [x] Add failing pure tests for canonical layout validation: version/address/type checks; one-to-ten sensors; unique channel, response position, and positive depth; contiguous response positions; same-depth VWC/VIC projection for TriSCAN; stable channel 7/8 when channel 9 is inserted at 70 cm.
- [x] Add failing compatibility tests: no layout plus `sdi12_value_count=5` still maps five VWC values even when the old depth JSON is null/stale; a layout makes the legacy count irrelevant.
- [x] Add failing ingestion tests for exact-cardinality VWC-only layouts mapped by `response_position`, ten VWC channels, trailing-value quarantine, and atomic no-soil-write behavior.
- [x] Add a failing test that a layout containing any TriSCAN module yields `sdi12_vic_framing_unverified`, preserves battery if present, and writes no VWC/VIC values. Do not add a successful VIC fixture from invented values.
- [x] Export the focused Sentek layout validator from `osi-sdi12-normalize`; its result must carry the canonical layout, compatibility depth projection, TriSCAN presence, and validation status. Use it from normalization and the settings node.
- [x] Implement the safe paths, mirror the module, and run helper plus end-to-end writer tests.

### Task 4: Wire edge API, ingest, latest-data, sync, history, and export

**Canonical flow file:** `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json` plus maintained mirror.

**Nodes to transform:**

- `sdi12-config-action-fn` — mutually exclusive Sentek `sensors`/`address` versus legacy `depths`/`value_count`; bound transactional update; null legacy count.
- `sdi12-write-fn` and its config query — pass parsed layout to the normalizer and surface quarantine status.
- `format-devices` / `merge-device-data` — return layout/status and latest `vwc_9..10`/`soil_vic_1..10`.
- `sync-bootstrap-build` — include the layout and telemetry fields; leave `sync-init-fn` unchanged and extend outbox payloads through migration-owned decorators.
- history/export query builders that enumerate soil channel columns.

**Tests/files:**

- `scripts/test-sdi12-registration.js`
- `scripts/verify-sync-flow.js`
- `scripts/test-contract-schemas.js`
- `conf/.../osi-history-helper/{index.js,analysis.js}` and tests if present

- [x] Add failing harness tests for valid ten-row save, duplicate rejection, malformed JSON rejection, mutual exclusivity, SQL metacharacters remaining data, same-transaction projection/count clearing/sync-version increment, legacy save compatibility, and GET projection/status.
- [x] Add failing flow/contract tests showing the new fields appear in bootstrap and outbox payloads and the device-data trigger emits all twelve telemetry keys.
- [x] Implement one validated transaction in `sdi12-config-action-fn`. Store canonical JSON only; no dynamic SQL identifiers or values.
- [x] Pass `sdi12_channel_layout_json` through the config query into the normalizer. A malformed stored layout must quarantine visibly, never fall back to positional guessing.
- [x] Extend latest-data, history, and CSV/export allowlists. Keep VWC and VIC separate and attach depths from the compatibility projection.
- [x] Transform canonical `flows.json` once, assert valid JSON/order/size, copy it to the maintained mirror, and run function syntax plus profile-parity gates.

### Task 5: Build the dynamic edge GUI

**Files:**

- `web/react-gui/src/types/farming.ts`
- `web/react-gui/src/services/api.ts`
- `web/react-gui/src/components/farming/Sdi12SettingsModal.tsx`
- `web/react-gui/src/components/farming/Sdi12SoilCard.tsx`
- their existing tests
- locale resources only for new user-visible strings

- [x] Add failing service/type tests for snake-case layout/status and a Sentek request carrying `address` plus `sensors` rather than `value_count`.
- [x] Add failing modal tests for dynamic add/remove up to ten, stable channel identities, explicit response positions, positive unique depths, EnviroSCAN/TriSCAN selection, no Sentek value-count field, legacy migration prompt, and visible activation/framing warning.
- [x] Add failing card tests for configured rows sorted by depth, VWC/VIC side-by-side at TriSCAN depths, em dashes for configured missing readings, unused rows hidden, and observed-key fallback for legacy devices.
- [x] Implement API normalization at the service boundary and narrow layout types. Keep protocol interpretation in the normalizer/API, not duplicated in React.
- [x] Implement the modal and card. Preserve existing behavior for non-Sentek SDI-12 profiles.
- [x] Run focused tests, all edge GUI unit tests, and production build. Run locale parity checks if strings change.

### Task 6: Complete cloud acceptance and frontend contract parity

**Files:**

- `backend/src/main/java/org/osi/server/sync/EdgeSyncService.java`
- `backend/src/main/java/org/osi/server/device/DeviceMutationService.java` only if its existing synced-field copy requires it
- `backend/src/test/java/org/osi/server/sync/EdgeSyncServiceDataPlaneTest.java`
- `frontend/src/types/farming.ts`
- `frontend/src/services/api.ts`
- focused parity tests

- [x] Add failing data-plane tests that accept and retain `vwc_9`, `vwc_10`, and `soil_vic_1..10` in telemetry JSON without coercing VIC to EC.
- [x] Extend device sync/bootstrap serialization for the layout while preserving edge authority and old-edge compatibility.
- [x] Extend cloud TypeScript API/domain types so mirrored devices and telemetry do not silently drop the new fields. Do not add a cloud SDI-12 card, history allowlist, or analysis behavior in this slice.
- [x] Run focused backend sync tests, channel manifest tests, frontend tests/build, then the full Gradle test gate. Classify the known ArchUnit store failure against baseline evidence if it remains the sole failure.

### Task 7: Adversarial verification and deployment handoff

- [x] Review the complete diff for column loss, trigger downgrade, unbound SQL, profile double-processing, hidden missing data, channel renumbering, stale-count fallback, accidental EC reuse, and any invented wire assumptions.
- [x] Run edge minimum gates: helper tests, device integration, SDI-12 registration, contract schemas, migrations/checksum, seed replay, DB consistency, runtime schema parity, fingerprint/boot rewrite rehearsals, profile parity, sync verification, no-silent-catch ratchet, flows size ratchet, MQTT topic check, GUI unit tests, and GUI build.
- [x] Run cloud focused sync/manifest/API tests, frontend tests/build, and full `./gradlew test --no-daemon`.
- [x] Run `git diff --check`, inspect both worktree statuses, and confirm only intended files changed. Run anti-slop checking on the spec, plan, and execution report.
- [x] Write `docs/superpowers/plans/2026-08-25-sentek-enviroscan-vwc-vic-execution-report.md` with exact commands, pass/fail output, the baseline ArchUnit condition, and deferred bench gates.
- [x] Do not label the change deployable if any new failure remains. If green apart from the proven baseline-only ArchUnit store condition, report cloud-first deployment order: cloud acceptance/migration, edge image/runtime, then an operator-controlled layout save after the next bench capture. Pi deployment itself waits for the user in the morning.
