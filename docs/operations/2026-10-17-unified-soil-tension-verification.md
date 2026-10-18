# Unified soil tension verification — 2026-10-17

## Scope and result

The implementation treats finite canonical SWT values as the same soil tension signal across KIWI, Tensiomark and LSN50 WATERMARK. The ordinary cards, zone summaries, history and irrigation use kPa; the display preference selects kPa or pF. Raw measurements and diagnostic provenance remain available. Missing and invalid readings stay unavailable.

This report covers repository implementation only. No gateway or cloud deployment, production SSH access or live historical correction was performed. The new repair tool was exercised on synthetic SQLite databases. Browser verification could not run because the session's browser bridge was unavailable.

Edge implementation: `783a12371`, with repair commits `a4f3c6007` and `0f26b90f4`. The paired cloud implementation ends at `73301b29`, on the same `feat/tensiomark-field-integration` branch in its repository.

## Edge verification

All commands below exited 0 unless explicitly described as an intermediate failure. Commands run from the edge worktree; GUI commands run from `web/react-gui`.

| Check | Evidence |
| --- | --- |
| GUI Vitest: `npm run test:unit:vitest -- --maxWorkers=2` | 251 files, 2,784 tests passed |
| GUI TSX runner: `npm run test:unit:tsx-runner` (first phase of `npm run test:unit`) | 236 tests passed |
| `npm run typecheck` | TypeScript exited 0 |
| `npm run build` | 1,800 modules transformed; built successfully |
| WATERMARK helper tests plus contact payload and unified scheduler tests | 97 tests passed |
| `node scripts/test-watermark-ingest-flow.js` | 14 cases passed |
| `node --test scripts/test-history-all-zones-export.js` | 41 tests passed, both Pi profiles |
| Native pF precision, Tensiomark contract/runtime and both WATERMARK repair suites | 64 tests passed |
| Paired pF fixture after example-identifier cleanup | 7 precision tests passed |
| `node scripts/verify-sync-flow.js` | Sync verification and all profile parity checks passed |
| Flow parsing, wiring, size, silent-catch, stray-DDL and bare-require guards | All exited 0 |
| MQTT topic, communication contract, WATERMARK codec and codec robustness checks | All exited 0 |
| Documentation prose lint and built-in documentation hygiene patterns | Passed; private name list not available |
| `git diff --check` | No whitespace errors |

The full GUI run initially found two tests using 301 kPa as an invalid fixture. Those tests now use 1,000,001 kPa, outside the approved common domain, and the final complete run passed. The export suite also contained old expectations for four-decimal pF and a pF floor at zero. The updated tests verify full-precision positive conversion and no finite pF row for zero kPa.

Documentation hygiene initially failed on an existing synthetic identifier outside the documented example range. The paired edge/cloud observation fixture now uses a permitted example identifier, with regenerated canonical columns and hash. The scanner then passed without broadening its allowlist.

An unrestricted initial GUI run was stopped during resource contention and replaced with the bounded run above. Existing npm-version, Browserslist-age and bundle-size warnings remain. They did not fail the final type check or build.

## Independent review

The implementation plan received an independent Sol review before execution. Required changes included canonical WATERMARK irrigation participation, common numerical limits, sensor-family depth provenance and a guarded historical correction path.

Astra reviewed the edge implementation and independently reran 110 card/zone tests after fixes. Review is green. The fixes retain the Wet indicator at zero kPa in pF mode and remove electrical diagnostics from the ordinary WATERMARK card.

Sol reviewed the repair tool. After fixes for duplicate links, locked candidate reporting, exact pending-event keys, sync trigger requirements and stored conversion-version provenance, review is green. Independent repair tests passed 10/10 and backup tests passed 16/16.

## Cloud verification

The cloud frontend full command `npm run test:unit -- --maxWorkers=2` exited 0: 199 TSX tests and 2,589 Vitest tests passed; two existing Vitest tests were skipped. The final `npm run build` (TypeScript plus Vite) also exited 0. After the final placeholder-color change, 56 focused card/zone tests passed; Sol independently verified 83 focused SWT/card/zone tests.

The backend selection covers 12 classes: `SoilSourcePolicyTest`, `RootZoneHistoryScopePostgresIT`, `SoilTensionPfTest`, `TensiomarkObservationPostgresIT`, `TensiomarkObservationHistoryTest`, `EdgeHistoryIngestTransactionIT`, `TerraDeviceAnchorServiceTest`, `TerraDeviceAnchorWriteServiceTest`, `TerraDeviceAnchorPayloadsTest`, `TerraDeviceAnchorControllerTest`, `TerraDeviceAnchorConcurrencyIT`, and `TerraZonePersistenceRepositoryIT`. Command: `JAVA_HOME=/usr/lib/jvm/java-17-openjdk ./gradlew test --no-daemon --max-workers=2 -x buildFrontend -x buildTerraIntelligenceFrontend`, with one `--tests` selector per class above. Frontend build tasks are excluded from this backend run because the affected GUI is verified separately and Terra frontend code did not change.

Final backend result: **111 tests passed across all 12 selected classes, zero failures, errors or skips; Gradle exited 0**. The final Terra service suite includes 23 tests, including the ordinary WATERMARK and stable KIWI inventory regressions.

The correction regression first mirrors a null SWT row, corrects that same history key, and reads 42.5 kPa through the real root-history manifest and query. The PostgreSQL observation test verifies the paired native-pF fixture and its canonical hash. Root history scope tests cover configured Tensiomark and per-device temperature channels.

Sol's final semantic review is green after fixes for common-domain filtering, zero/pF water-state colors, active sensor-family depth precedence, exact configured Tensiomark channels, and WATERMARK Terra inventory. A final regression preserves the existing KIWI physical inventory and its fingerprint when a latest reading omits one or more channels.

The initial unrestricted backend run was interrupted during resource contention; it is not counted as a pass. A later concurrent targeted run collided while writing test reports. The final selection above runs serially in one Gradle invocation. The entire backend suite and architecture suite were not completed; the stated backend result applies only to these 12 affected classes.

## Rollout boundary

See [the operator notes](unified-soil-tension.md). New ingestion publishes finite clipped estimates under conversion version `wm-lsn50-p3-v3`. Historical rows require the explicit dry-run/apply tool after deployment and sync verification. Corrections use existing dirty-key history reconciliation, preserving raw electrical data and original conversion versions. Old rollups outside automatic refresh windows require a separate backfill.
