# Tensiomark data view implementation plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` for execution and independent review. The user requested plan, review and execution until green.

**Goal:** Make both Tensiomark probes selectable in Data and show soil tension in the existing selected unit throughout their card and history views.

**Architecture:** Keep acquisition and storage in canonical kPa. Project values and unit labels at the frontend presentation boundary through the existing `kpaToPf` conversion. Keep channel keys, series IDs and API requests unchanged. Temperature stays in degrees Celsius.

**Tech stack:** React, TypeScript, Vitest, Java/Spring and Node-RED history helpers.

**Design brief:** The user's instruction is to include Tensiomark metrics in Data and use Settings to switch pF/kPa, with one displayed tension value per probe. This is an extension of the current analysis and history paths. Existing isolated public and private deployment worktrees are retained.

## Verified starting state

The explicit two-probe cloud layout supplies `swt_1`, `swt_2`, `soil_temp_1` and `soil_temp_2` through assigned zones. Independent review found that the edge Data helper still interprets explicit Tensiomark layouts as Sentek and its fallback advertises only the first probe; Task 3 repairs that omission. At the start, the installed node was unassigned, which explained its omission. The operator assigned it to the installation zone during implementation; the assignment is now mirrored on both sides. Its first three field cycles passed raw-frame, conversion, timestamp and four-channel cloud equality checks; subsequent cloud rows have arrived.

Both cards currently print kPa and pF together. Data, SensorMonitor and cloud DeviceDetail currently plot canonical kPa without reading the unit preference. The operator supplied the zone assignment. Installation depths remain unknown; no depth may be invented.

## Constraints

- Preserve canonical values, source pF evidence, sensor recipe and calibration qualification.
- Reuse `useDisplayPreferences` and `kpaToPf`; add no new setting.
- Convert canonical SWT channels and accepted legacy SWT aliases only when their source unit is kPa. Never convert pipe pressure or temperature.
- Preserve missing and non-finite values as gaps. Retain the existing pF floor: 0.1 kPa displays 0 pF. Do not apply the generic 300 kPa card limit to Tensiomark.
- Preserve selected series, saved views, label overrides, server aggregation and API payloads when the preference changes.
- Selected-series CSV follows displayed units and values. Existing full-zone archival exports retain their existing canonical-plus-derived contract.
- Do not add pF channel IDs or duplicate series. Both probes remain distinct with null depth when depth is unknown.
- Public fixtures use invented identifiers. Customer deployment records and operational identifiers stay outside public repositories.

## Review focus

1. A unit toggle while the Data page or monitor is mounted must update values, axes, tooltips, statistics and CSV together.
2. A pF label over a kPa numeric value is a correctness defect. Shared charts must receive transformed points, not just labels.
3. Null readings and a measured pF zero must stay distinguishable.
4. A latest rejected reading must not hide the configured historical channels. Unknown depth must not hide a probe.
5. Catalog inclusion must preserve current authorization and must not add Tensiomark to root-zone irrigation inputs.

## Task 1: Cloud presentation

**Worktree:** `osi-server/.worktrees/tensiomark-field-integration`.

**Files:** `frontend/src/utils/swt.ts`; new `frontend/src/analysis/swtPresentation.ts`; `frontend/src/pages/CrossZoneAnalysisPage.tsx`; `frontend/src/pages/deviceHistoryModel.ts`; `frontend/src/pages/DeviceDetail.tsx`; `frontend/src/components/farming/Sdi12SoilCard.tsx`; `frontend/src/components/farming/SensorMonitor.tsx`; affected tests and `analysis/echartsOptions.ts` for unit-aware tooltip precision.

- [x] Add failing pure and rendered tests. Use two configured probes with null depths and values `1.97`, `0.1` kPa plus `13.96`, `14.92` degrees. Assert one displayed unit, pF values `log10(19.7)` and `0`, unchanged temperatures and missing gaps. Change the real preference with `writeDisplayPreferences` inside `act`, without remounting.
- [x] Add `presentSwtCatalog(entries, unit)` and `presentSwtSeries(series, unit)` as immutable projections. Canonicalize legacy aliases with the registry. Only a soil SWT entry with source unit `kPa` is projected; preserve identifiers and all unrelated metadata. Compose with the existing rainfall presentation before building tray, metadata, presets and catalogById. Test a pipe-pressure kPa series as an exclusion.
- [x] Apply projections before displayed series reach charts, correlation and selected CSV; use projected catalog units in the tray and presets. Requests and persisted workspace remain canonical.
- [x] Card formatting calls `formatSwtValue(value, preferences.swtUnit)` after the existing Tensiomark range check. Keep both probe history controls.
- [x] SensorMonitor converts fetched SWT points once for presentation and uses the same projected data for chart, min/max/latest and tooltip. Requests remain canonical SWT fields; keep fetched rows canonical in state and derive presentedData with useMemo over canonical rows, active field/unit and preference. A toggle re-projects the canonical rows without refetching or transforming already projected points. Preserve existing fetch dependencies, including translation where present. Derive reactive unit and decimals from the canonical active series: pF 2 decimals, kPa 1. The existing source unit in props remains canonical.
- [x] Format pF tooltips with two decimals in ECharts timeline, small-multiple and correlation views; keep other units at existing precision. Preserve full projected precision for points, correlation and CSV. Add formatter tests for pF and missing values.
- [x] Extend `buildDeviceHistoryModel(device, history, swtUnit = 'kPa')` and pass the actual preference from DeviceDetail. Group transformed SWT series under the selected unit. Existing callers retain kPa defaults.
- [x] Verify each regression fails on the old implementation, then passes. Run relevant card/history/Data/pF suites, full frontend unit tests and build. Commit only task files.

## Task 2: Edge presentation parity

**Worktree:** `osi-os/.worktrees/tensiomark-field-integration`.

**Files:** matching `web/react-gui/src/analysis/swtPresentation.ts`, `utils/swt.ts`, `pages/CrossZoneAnalysisPage.tsx`, `components/farming/Sdi12SoilCard.tsx`, `components/farming/SensorMonitor.tsx`, `analysis/echartsOptions.ts` and tests. The edge has no cloud DeviceDetail page.

- [x] Reproduce the same preference failures with real preference writes and two explicit probes.
- [x] Apply the same immutable Data projection and card/monitor preference behavior. Reuse domain conversion; retain edge freshness and calibration notes. Require two-decimal pF tooltips in timeline, small multiples and correlation, with formatter tests; retain full point precision.
- [x] Test null, non-finite, zero-floor, high dry Tensiomark values, temperature/pressure exclusions, mixed-unit panels and selected CSV.
- [x] Run focused tests, `npm run typecheck`, full frontend unit tests and build. Commit only task files.

## Task 3: Data catalog availability

The operator supplied the real installation zone while Tasks 1 and 2 proceeded. Depths remain unknown until entered through settings. Cloud assigned Tensiomark policy exists. The edge helper requires a repair in `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-history-helper/device-sources.js` and its bcm2709 mirror.

- [x] Add failing edge device-sources and analysis catalog/series tests using a complete valid two-probe Tensiomark layout, null depths and rejected/empty latest readings. Include invalid layout refusal and unchanged Sentek behavior.
- [x] Validate explicit Tensiomark layout with `validateTensiomarkLayout` from the existing `osi-sdi12-normalize` module (implementation in `usr/share/node-red/osi-sdi12-normalize/tensiomark-live.js`) and expose configured swt_N plus soil_temp_N pairs. Include swt_2 in the supported SDI-12 channel set; preserve valid configured pairs independent of latest state. Mirror the helper byte-for-byte to bcm2709. Do not change root-zone selection.
- [x] Replace or supplement the cloud catalog fixture with a fully valid two-probe layout, null depths, and rejected/empty latest state; prove the four configured channels remain advertised.
- [x] Run helper suites, scripts/test-analysis-device-discovery.js, profile parity and sync verifier on edge; cloud AnalysisCatalogServiceTest and AnalysisSeriesServiceTest.
- [x] Resolve the installed node's catalog omission. A supplied zone is applied through the existing edge-authoritative assignment path. If the operator does not supply a zone, keep the real installation assignment pending and verify the per-device history remains accessible. Unassigned cross-zone analysis would change authorization, series identity, aggregation and retention contracts; it is a separate scope decision, not a null-zone patch. Do not manufacture a zone or silently broaden access.

## Task 4: Review and rollout

- [x] Independent reviewers inspect the plan before implementation and inspect diffs plus rendered tests afterward. Required findings are fixed and rechecked.
- [x] Port generic commits to existing private deployment worktrees, preserving their overlay and Details footer behavior. Repeat affected tests and build there.
- [x] Create fresh backups and immutable release artifacts. Deploy only the already-authorized customer cloud application and paired Pi GUI/runtime, using the established deployment procedures. Preserve sensor history and verify unchanged schema ledgers.
- [x] Verify exact deployed revisions/assets, latest raw-to-canonical-to-cloud correspondence, both probes in the Data catalog and preference behavior. Use the normal signed-in session if available; never mint a user token or reset credentials for verification.
- [x] Record commands, independent verdicts and any remaining external limitation in an execution report. Do not claim live browser verification from fixture tests.

## Execution ledger

| Tasks | Shared contract | Check |
|---|---|---|
| 1 and 2 | SWT presentation only; same conversion and selected CSV behavior | Separate repositories and independent files; canonical APIs unchanged. |
| 1 and 3 | Catalog entry IDs and source units | Presentation consumes current IDs and canonical kPa. Assignment uses operator-supplied metadata; no virtual zone or changed catalog identity. |
| 1, 2 and 4 | Public-to-private port | Preserve customer overlays; rebuild from exact reviewed commits. |

Ruling: Proceed with the authorized implementation and independent reviews without another approval round. Resolve operator metadata separately; unit-display work does not depend on it.

Baseline: cloud selected frontend suites passed 23 tests; edge selected frontend suites passed 54 tests before implementation. Browser bootstrap failed because the supported native bridge is unavailable; rendered tests and asset verification remain available.

Review: Sol required an edge catalog repair, canonical-state monitor projection and pF tooltip precision. All three were incorporated before implementation. The production cloud is excluded; the continuing authorization is for the existing customer deployment only.

Plan review verdict: GREEN after the required amendments and exact file/dependency corrections (independent Sol review).


## Task 5: Tensiomark depth settings (operator-requested extension)

The cloud card has no depth settings button. The edge already provides a gear and a Tensiomark commissioning form. The existing generic cloud depth endpoint and protected command exclude DRAGINO_SDI12; merely exposing the endpoint would fail. Updating the depth map alone would also leave the explicit sensor layout stale.

Design: extend the existing protected depth command for validated explicit Tensiomark layouts only. Keep the depth-only request shape and derive the changed layout from the edge's current row inside the existing base-version transaction. Never accept a replacement identity/address/calibration layout from this depth editor. The mirrored generic depth map and sensor depth_cm values change in one UPDATE with one sync-version increment. Both keys for a probe (swt_N and soil_temp_N) must be equal or both absent. Absent means unknown; invalid, extra and mismatched keys are refused. Preserve sensor identities, addresses, channels, calibration qualification and the acquisition recipe. Existing generic device behavior remains unchanged; unconfigured or other SDI-12 profiles remain unsupported.

- [x] Cloud: add a Tensiomark depth settings button and form to Sdi12SoilCard. One integer field per configured sensor, labelled by probe/channel and address; optional depth in cm, 1..1000, blank = unknown. Reuse existing device capability, scope and read-only gates, protected soil-depth API, pending notice and refresh behavior. Do not display queued values as confirmed. Include pending/error state and unknown-depth text in existing translations.
- [x] Cloud backend: conditionally authorize a valid Tensiomark device through the protected depth command. Validate exact configured channel pairs before queueing, preserving the existing version, ownership, capability and delivery-fence checks. Do not broaden unsupported SDI-12 profiles. Add service/authorizer and controller regression tests.
- [x] Edge: share a Tensiomark depth projection/validation helper between protected command apply and local depth HTTP update. Validate the stored layout, derive the new layout, and update both JSON columns atomically. Retain the existing protected command ledger, scope checks, stale-version rejection and replay behavior. The local full commissioning modal continues to use its existing validated save path.
- [x] Verify the existing device event/snapshot carries both changed fields to the cloud. Add a regression covering cloud mirror convergence and pending completion; change transport contracts only if evidence shows a gap.
- [x] Test two depths, clearing to unknown, one unknown probe, conflicting pairs, extra keys, invalid layout, unauthorized and stale updates, exact replay, rollback, identity preservation and new observation configuration hash. Rendered UI tests cover opening from the card, request payload, queued versus confirmed, error, read-only and unsupported capability.
- [x] Independent review before implementation and after changes. Deploy the supporting edge before enabling the cloud editor; older edge versions reject this device type. Re-run appropriate runtime/contract, backend, frontend and build checks. Do not set real installation depths without operator values.

Task 5 plan review: independent Sol GREEN. Only validated explicit layouts are editable; each configured pair is equal or both absent, including an empty map for all unknown. Existing layout outbox decoration and cloud mirror avoid a new sync contract. Supporting edge is deployed before the cloud editor.

Completion: all five tasks passed their required checks. Supporting edge and customer cloud releases were deployed and independently verified. See [the execution report](2026-10-16-tensiomark-data-view-execution-report.md) for evidence and the live-browser limitation.
