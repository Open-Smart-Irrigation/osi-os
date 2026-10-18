# Adversarial review: Tensiomark field-integration plan

**Verdict: REVISE BEFORE EXECUTION.** The spec is coherent, but the 84-line plan is not executable to the repository's zero-placeholder standard and leaves four safety-critical seams unresolved: provenance linkage, automatic wildcard identification, discriminated GUI handling, and current-cloud SDI-12 channel policy. Do not start implementation or live registration from this version.

Review basis: edge worktree `1631d4f79` (base `f13007320`), current fetched `osi-server/origin/main` `113696c1`, the repository playbook, and the actual normalizer, Node-RED flows, persistence helpers, React consumers, sync schema, and cloud analysis/history policy. No production network access was used.

## Required fixes

### 1. Replace placeholders with exact implementation steps and tests

Affected plan: `docs/superpowers/plans/2026-10-15-tensiomark-field-integration.md` Tasks 1–4, especially lines 33, 50, 54, 63, 65, 69, 75 and 80.

The plan contains `...`, “as needed”, “relevant verifiers”, and “actual blockers found by read-only assessment”. It does not name every changed file, show the implementation seam, state the expected failing assertion, or give runnable commands. This conflicts with the engineering playbook and `superpowers:writing-plans` requirements. Rewrite each task with exact files, test names, expected red/green result, implementation behavior, and complete commands. Split edge, cloud, and live operations into separately reviewable commits/checkpoints. Pin both repository revisions in the plan.

### 2. Make the live Tensiomark grammar and qualification mechanically exact

Affected files:

- `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/tensiomark-live.js` and mirror
- `.../osi-sdi12-normalize/tensiomark-live.test.js` and mirror
- `.../osi-sdi12-normalize/index.js` and mirror

The spec correctly treats pF-to-kPa as a unit conversion while calibration remains unverified. The plan must preserve that distinction: activation requires every explicit layout discriminator, including `qualification:"bench_observed"` and each sensor's `calibration_range:"unverified"`; neither `_2` nor identity suffixes may select a calibration. Canonical `swt_N` is allowed because `10 ** pF / 10` is the selected unit conversion, with the qualification retained in the layout and observation snapshot.

Define the record grammar, rather than saying “signed decimal”: exact address character followed immediately by two explicitly signed finite decimal tokens, exact delimiter rules, and terminal CRLF for every record, with no LF-only, missing final CRLF, leading/trailing whitespace, exponent, integer-only, extra-line, or embedded-NUL acceptance unless the spec is deliberately changed. Canonicalize the validated layout in channel order, serialize with one specified property order, and compute SHA-256 over those UTF-8 bytes. Pin a digest fixture.

Tests must separately prove: reversed records map by address; missing/duplicate/unknown address rejects the entire soil batch; `pF=0` becomes `0.1`; `pF=-9.88` rejects; temperature `-9.88` succeeds; temperature `-99.88` rejects; values above 300 kPa are retained; invalid layout never activates the parser; the exact original text survives every parse refusal. Keep the existing offline v3 API unchanged.

### 3. Design provenance as a linked atomic record, not two uncorrelated inserts

Affected files:

- new `database/migrations/ordered/0074__tensiomark_observations.sql` (renumber at execution if 0074 is occupied)
- `database/seed-blank.sql` and both generated bundled DBs
- `scripts/verify-db-schema-consistency.js`
- `conf/.../node-red/osi-device-writer/index.js` or a new focused Tensiomark ingest helper, plus bcm2709 mirror
- both `flows.json`
- new runtime/migration tests
- `docs/operations/edge-history-retention.md`

The proposed table has no `device_data_id`. `device_data` has no unique `(deveui, recorded_at)` key, and `writeDeviceData` returns no inserted row id, so the stored evidence cannot prove which canonical row it explains. Add nullable `device_data_id INTEGER REFERENCES device_data(id) ON DELETE SET NULL` and `idx_tensiomark_observations_device_data`. Return the inserted id from the writer without breaking callers, or make a focused helper insert the classified canonical row and retrieve `last_insert_rowid()` within the same transaction. Link every accepted observation and every rejected-frame battery-only row.

Specify transaction behavior in both directions: observation failure rolls back `device_data`; canonical insertion failure rolls back the observation. Use one clamped `recorded_at` for both rows. Define stable disposition codes and the exact `normalized_json` shape for accepted and rejected batches. Add a `CHECK` for disposition values and migration header `-- risk: additive`. Choose the retention policy now; the smallest v1 policy is indefinite local retention with no pruning, documented explicitly.

Configured-Tensiomark parse refusals must not also enter the capped `ingest_quarantine`. Today `osi-device-writer` dead-letters every `unknown` normalizer value. Return Tensiomark refusal/evidence separately and call the writer with only retained battery channels and an empty `unknown`, or bypass that dead-letter seam in the focused helper. Legacy unconfigured Tensiomark behavior stays quarantined. Pass ChirpStack's original base64 payload from the gate alongside `decoded.data_sum`; do not reconstruct bytes from text.

Keep the existing commissioning observer outside the new transaction to avoid nested DB use. Test accepted, rejected, observation-insert failure, canonical-insert failure, exact FK linkage, no successful/rejected configured row in `ingest_quarantine`, and raw survival after quarantine eviction.

### 4. Separate Tensiomark configuration from Sentek recipe deployment

Affected files:

- `conf/.../node-red/osi-sdi12-commissioning/index.js` and mirror
- both `flows.json`
- `scripts/test-sdi12-recipe-flow.js`
- `scripts/test-sdi12-registration.js`
- new focused configuration tests

`saveSentekLayout` compiles a converter recipe and creates/updates `sdi12_recipe_deployments`; it cannot be reused for Tensiomark. Add a distinct `saveTensiomarkLayout` that validates the new layout and atomically updates `sdi12_probe_profile`, layout JSON, the derived depth map, status, timestamp, and `sync_version` only when content changes. Derive both `swt_N` and `soil_temp_N` depth keys when depth is non-null; omit both for null. Do not create or modify a desired recipe and do not send a downlink. Reject while an active recipe deployment exists, then clear stale identify-attempt state after a successful save.

The generic non-Sentek config path currently clears `sdi12_channel_layout_json`; branch to the Tensiomark save before it. Test exact-key rejection, mixed Sentek/Tensiomark fields, idempotent resave, active deployment rejection, null-depth projection, list/readback, outbox event content, bootstrap/force-sync content, and no MQTT output.

### 5. Remove the registration-to-wildcard race and fail closed on stale identity replies

Affected files:

- Node-RED nodes `sdi12-post-reg-hook-fn`, `sdi12-write-fn`, `sdi12-identify-action-fn`, `sdi12-identify-trigger-fn`, and `sdi12-identify-fn` in both `flows.json`
- `scripts/test-sdi12-registration.js`
- `scripts/test-sdi12-recipe-flow.js`

“Send no identification request for already configured layouts” is insufficient. Current registration deliberately invokes `sdi12-post-reg-hook-fn`, which queues wildcard `?!` before the separate configuration route can save a layout. If the node is offline, that request remains queued for its fresh join. Remove the post-registration auto-identify trigger and retain first-uplink identification for unconfigured Sentek devices. Before first-uplink triggering, require layout to be absent. A Tensiomark must be registered while unpowered, configured through the explicit route, and only then allowed to join.

All three identify stages must discriminate layout kind. A configured Tensiomark identify action should return a stable 409 reason and queue nothing. A discovery or identity response already in flight must re-read current device state and, if a Tensiomark layout is now stored, neither change profile/status/identity/layout nor enqueue the next address command; clear/close the stale attempt. Test both the direct action and the save-between-request-and-reply race. Do not reduce two configured addresses to one `addressI!` request.

### 6. Enumerate every edge GUI consumer and use a discriminated union

Affected edge files:

- `web/react-gui/src/types/farming.ts`
- `web/react-gui/src/services/api.ts`
- `web/react-gui/src/components/farming/Sdi12SettingsModal.tsx`
- `web/react-gui/src/components/farming/Sdi12SoilCard.tsx`
- their focused tests and i18n strings

These are concrete blockers, not files to discover during implementation. The type currently permits only `SentekChannelLayout`; API normalization drops every non-Sentek layout; the modal reads `.address` and Sentek sensor fields from every layout; the card sorts nullable depths and renders only VWC/VIC. Add `kind` discrimination without changing accepted legacy Sentek JSON, normalize both parsed objects and JSON strings, and narrow before accessing variant fields. Render Tensiomark `swt_N` and `soil_temp_N` together by configured channel/address, preserve null depth, values above 300 kPa, battery, and existing history actions. Tests must cover both variants so Sentek behavior cannot regress.

### 7. Update the current cloud gaps only; preserve the existing root-zone boundary

Assess and implement against `osi-server/origin/main` `113696c1`, not the 42-commit-behind local checkout. Current cloud already persists arbitrary layout JSONB and already has `SoilDevicePolicy.perDeviceChannels` specifically for per-device SDI-12 catalog/series/export/rollups while excluding SDI-12 from root-zone contributors. Do not redesign that path and do not add `DRAGINO_SDI12` to `isSoilSourceDevice`.

Required cloud files:

- `backend/src/main/java/org/osi/server/device/SoilDevicePolicy.java`
- focused policy/catalog/series/export/rollup tests (`SoilSourcePolicyTest`, `AnalysisCatalogServiceTest`, and existing history/export suites)
- `frontend/src/types/farming.ts`
- `frontend/src/services/api.ts`
- `frontend/src/components/farming/Sdi12SoilCard.tsx`
- `frontend/src/pages/deviceHistoryModel.ts`
- focused frontend tests
- `backend/src/test/resources/sync-contract/resources.schema.json`

The real backend gap is `SDI12_SERIES_CHANNELS`: it includes VWC, VIC, temperature and EC but omits `swt_1`/`swt_2`. Add only the numbered Tensiomark SWT channels to the per-device allowlist, relying on measured state or configured depth to select them. Prove they appear in per-device catalog, series, export and rollups, and prove the SDI-12 device still does not alter the root-zone manifest/source key.

The cloud frontend remains Sentek-only: it drops the layout, renders only VWC/VIC, and `deviceHistoryModel` derives only VWC/VIC candidates. Add the same discriminated union and Tensiomark rendering/history behavior as edge. `normaliseDevice` must project `soil_temp_1`/`soil_temp_2` (and retain existing `swt_1`/`swt_2`) into `latest_data`.

Extend the authoritative edge schema with an exact `TensiomarkChannelLayout` member and mirror that exact file into the paired server test resource after both branches are based correctly. JSON Schema cannot enforce unique address/channel values with `uniqueItems`; retain runtime uniqueness tests. No cloud DB migration, new measurement event, or cloud pF conversion is needed.

### 8. Make live registration and handover a concrete, ordered runbook

Affected plan Task 4 and the private execution report.

Name the supported route (`POST /api/devices`) and exact non-secret body shape with `type_id=DRAGINO_SDI12`; verify target gateway identity, intended owner, and absence/compatibility of an existing DevEUI before mutation. Capture AppKey without command-line arguments, stdout, logs, shell history, fixtures, or the public report. The supported provisioner may use only DevEUI/AppKey and the target Sensors application/SDI-12 profile; do not export/import activations, session keys, frame counters, or another server's device session.

Order the field work: protected backup; migration rehearsal on a copy; compatible cloud deployment first if required; edge deployment; register the unpowered node; save/read back the explicit private two-address layout; prove no queued wildcard/single-address identify request; then power/join. Verify fresh join, one real addressed uplink, raw observation/FK link, canonical battery plus four soil channels, device API/card/history, outbox acknowledgement, and cloud catalog/series/export. Production `osicloud.ch` access remains a separate explicit authorization boundary; do not claim cloud observation if only edge sync submission was verified.

## Optional improvements

- Add an operator-only observation inspection endpoint later. It is not required for the field integration if SQL/private operational evidence is sufficient.
- A generic SDI-12 plugin registry or broad commissioning refactor is out of scope; keep the new code focused on the discriminated layout and ingest transaction.
- Bound raw response and payload sizes at the helper boundary to prevent accidental oversized local rows, provided the cap is documented and comfortably exceeds the protocol maximum.

# Tensiomark plan re-review

**Verdict: one REQUIRED correction remains before implementation starts.** The revised binding requirements resolve the original parser, provenance transaction, wildcard-identification, GUI discrimination, and SDI-12/root-zone policy blockers.

## Remaining blocker: cloud card temperature history is still unreachable

The reviewed requirements say the cloud `Sdi12SoilCard` will render paired SWT/temperature values with existing history actions, but its exact cloud file list omits two required current-baseline seams:

- `backend/src/main/java/org/osi/server/device/DeviceController.java`
- `backend/src/test/java/org/osi/server/device/DeviceControllerSensorHistoryFieldsTest.java`
- `frontend/src/components/farming/shared/cardHistory.ts`
- `frontend/src/components/farming/__tests__/cardHistorySeries.test.ts`

At cloud `origin/main` `113696c1`, `DeviceController.ALLOWED_SENSOR_FIELDS` accepts `swt_1..3`, VWC and VIC but not `soil_temp_1/2`. `SensorMonitor` calls `/api/v1/devices/{eui}/sensor-history`, so a temperature history button would receive HTTP 400. The shared `CARD_HISTORY_SERIES_KEYS` likewise contains VWC/VIC and SWT but no `soil_temp_N`; `Sdi12SoilCard` gates generated buttons through `isHistorySeriesKey`, so temperature may render without a reachable history action.

Add `soil_temp_1` and `soil_temp_2` to both allowlists (or all existing edge-backed `soil_temp_1..8` if maintaining the established SDI-12 family policy), update the controller parameterized test and card-history parity test, and include those files/tests in the binding cloud section. Keep `soil_ec` out unless the UI actually offers it.

After that small amendment, implementation can start. No other REQUIRED blocker was found in this pass.

Disposition: the remaining cloud temperature history allowlist and registry corrections are now in the binding plan. Implementation may proceed under the review verdict.
