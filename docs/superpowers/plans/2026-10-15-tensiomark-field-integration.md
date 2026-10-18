# Tensiomark field integration implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Execute the reviewed tasks and record exact verification evidence.

**Goal:** Register the bench-tested two-sensor node on a customer gateway and prepare its complete edge-to-cloud data path.

**Architecture:** A strict Tensiomark layout activates addressed parsing in the existing normalizer. An additive local observation table preserves interpretation evidence alongside canonical data; existing REST sync carries canonical channels and layout metadata.

**Tech stack:** Node.js, Node-RED, SQLite migrations, React/TypeScript, existing Java cloud services.

**Spec:** `docs/superpowers/specs/2026-10-15-tensiomark-field-integration.md`

## Global constraints

- Hardware identities, network addresses and secrets remain outside the public repository; fixtures use synthetic identities.
- Canonical SWT is positive kPa, `10 ** pF / 10`, with no 300 kPa clamp.
- Runtime activation requires an explicit bench-observed Tensiomark layout; calibrated range stays unverified.
- Both Pi runtime profiles remain byte-identical. No boot-DDL edits, database replacement, hardware reset, automatic irrigation assignment or concurrent sensor heating commands.
- Preserve the tested 20-minute sequential converter recipe. Configuration saves do not send downlinks.
- Record null depths until the operator supplies actual installation depths.
- Keep shared contracts byte-identical with the paired server branch. Never connect to production cloud without the required explicit authorization.

## Review focus

1. Swapped packet order must map by address; duplicate, unknown or missing address rejects all soil values.
2. pF zero must produce 0.1 kPa; malformed/error readings must never become wet soil.
3. Saved multi-address layout must survive list APIs, frontend normalization, sync and identity replies.
4. Raw-evidence write failure must roll back canonical writes; successful raw data must survive quarantine eviction.
5. Registration must preserve gateway ownership, existing records, node keys and live radio-session boundaries.

## Task 1: Pure runtime layout and addressed normalizer

Files: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/{tensiomark-live.js,tensiomark-live.test.js,index.js}`, mirrored under bcm2709; `deploy.sh` and `scripts/verify-profile-parity.js` explicit file lists.

Interfaces: export `validateTensiomarkLayout(input)` returning `{ok,layout,depths,configurationHash}` or `{ok:false,error}`; `normalizeTensiomark(decoded,layout,meta)` returns existing normalize shape plus `tensiomarkObservation` containing raw, configuration hash/snapshot, disposition and channels. Expose validator through normalizer index. Existing `normalize` delegates only for TENSIOMARK with an explicit valid layout; legacy no-layout stays quarantined.

- [ ] Add failing tests using the spec's layout and this captured-shape input:

```js
const r = normalize({BatV:3.606, data_sum:'1+16.11+0.000\r\n4+18.25+5.359\r\n'},
 {probeProfile:'TENSIOMARK',sdi12ChannelLayout:layout}, {recordedAt:'2026-10-15T13:54:04.426Z'});
assert.equal(r.channels.swt_1, 0.1);
assert.equal(r.channels.soil_temp_1, 16.11);
assert.equal(r.channels.swt_2, Math.round((10**5.359/10)*100)/100);
assert.equal(r.channels.soil_temp_2, 18.25);
```

- [ ] Add reversal, missing/duplicate/unknown address, malformed framing, extra field, -9.88 pF, -99.88 C, valid -9.88 C, unknown settings and null-depth cases. Verify failure before implementation.
- [ ] Implement strict validation and parsing from the spec; canonicalize sorted layout before SHA-256 hashing. Preserve full raw text on every refusal. Do not route through the old SWT clamp.
- [ ] Run `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/*.test.js` and the normalizer's existing tests; mirror files and commit only this task's files.

## Task 2: Durable observations, configuration route and live ingest

Files: new `database/migrations/ordered/0074__tensiomark_observations.sql`, `database/seed-blank.sql`, generated bundled DBs and migration checksums; existing `osi-sdi12-commissioning` helper with focused `tensiomark.js`/`config-handler.js` and `write-handler.js` modules; both `flows.json`; `scripts/test-tensiomark-runtime.js`, `scripts/verify-db-schema-consistency.js`, `scripts/verify-profile-parity.js`, `scripts/verify-module-file-deploy-coverage.js`.

Interfaces: `saveTensiomarkLayout(db,{deveui,layout})` saves validated layout and derived depths through the existing config route. `writeTensiomarkObservation(db,manifest,result,meta,options)` runs raw observation plus existing device-writer inside `db.transaction`, returning the ordinary writer result. Source timestamp must be clamped once consistently.

Observation schema: integer primary key; nullable device_data_id INTEGER REFERENCES device_data(id) ON DELETE SET NULL; deveui text not null; recorded_at text not null; received_at text not null; raw_response text not null; payload_base64 nullable; configuration_hash nullable; configuration_json nullable; disposition text not null; normalized_json text not null. Indexes `(deveui, recorded_at)` and `(device_data_id)`. Use no delete cascade to the mutable device registry. Retain observations indefinitely in v1; no pruning. Document this in `docs/operations/edge-history-retention.md`.

- [ ] Add failing flow-harness tests for save/readback, authorization unchanged, ingestion of all four channels, missing address refusal and transactional rollback on observation/canonical write failure.
- [ ] Extend config input as `{probe_profile:'TENSIOMARK',tensiomark_layout:layout}`. Reject mixed legacy/Sentek fields. Save interpretation and depth map together; bump sync_version only on actual change. Preserve no-downlink semantics and reject changes while a recipe deployment is active.
- [ ] Add migration and seed definition, regenerate via `node scripts/build-seed-db.js`; never mutate bundled DBs by hand. Use migration-runner tests for fresh and upgraded databases.
- [ ] Extract existing oversized SDI config/write flow bodies to helper modules to meet flow-size ratchet; keep auth/wiring intact. Guard identity/discovery paths so configured multi-address layouts cannot be replaced by wildcard discovery or a single identity response. Remove post-registration automatic identification entirely. First-uplink discovery remains only for unconfigured Sentek devices; every action, trigger and response re-reads current layout and refuses configured Tensiomark with stable reason `tensiomark_layout_configured`.
- [ ] Persist raw observation and canonical row atomically for configured Tensiomarks; retain unqualified failures. Pass original payload bytes from the gate if present. Leave other profiles on existing behavior.
- [ ] Run runtime harness, `verify-device-integration.js`, `test-sdi12-registration.js`, `test-sdi12-recipe-flow.js`, codec and schema/parity checks. Commit task files with evidence.

## Task 3: Reachable GUI and cloud contract

Files: `web/react-gui/src/types/farming.ts`, `services/api.ts`, `components/farming/Sdi12SettingsModal.tsx`, `Sdi12SoilCard.tsx` and focused tests; `docs/contracts/sync-schema/resources.schema.json` plus paired server mirror; the exact paired-server files listed in the reviewed execution requirements below.

- [ ] Add `TensiomarkChannelLayout` and `Sdi12ChannelLayout` union without changing the existing Sentek type. Narrow every existing Sentek-only consumer.
- [ ] Add failing API/UI tests for two address/identity/depth rows, null depth, strict explicit interpretation, rejected duplicates, populated card rows and history controls. Saved configuration must survive JSON string/object forms and list response projection.
- [ ] Add a Tensiomark settings panel with explicit pF/temperature-order bench confirmation and unverified-range note, saving through Task 2's route. Do not offer unit-changing sensor commands or claim calibration verification.
- [ ] Extend resource schema with discriminated layout member; preserve Sentek schema. Verify mirrored schema byte equality and Java persistence/serialization for both channels and layout. No new measurement event type or cloud-side pF conversion.
- [ ] Run focused Vitest/API tests, TypeScript/build, contract validators and the server tests listed below. Keep changes in separate repo commits; record deployment order for any cloud compatibility dependency.

## Task 4: Independent verification and gateway handover

- [ ] Independent reviewer verifies Tasks 1–3 against the spec and re-runs focused gates. Resolve critical/important findings before live software activation.
- [ ] Identify the customer gateway from inventory/operator reply, inspect live schema and software, and take protected consistent backups. Fetch this device's OTAA keys from the bench registration without tool-output disclosure; provision through supported helper/API, verifying device identity/application/profile and ownership. Do not copy the active session.
- [ ] Prepare a deploy bundle and rehearse migrations on a protected copy of the live DB. Deploy with existing rollback/health machinery only when reviewed build is green and cloud compatibility is established.
- [ ] Configure addresses 1→channel1 and 4→channel2 using private real identities, source pF and observed order. Preserve null installation depth until reported. Avoid re-running wildcard auto-identification.
- [ ] Verify fresh radio join/uplink at the field target, raw observation, canonical four-channel row, device API output and sync acknowledgment/cloud availability. Bench-fixture replay into a scratch DB is separate from live proof; never inject it as a field reading.
- [ ] Save private operational readbacks and public generic execution report. Distinguish prepared code, registered device, deployed software and observed cloud data. Record missing external evidence explicitly without pretending completion.

## Reviewed execution requirements (supersede the initial task summaries)

Baselines: edge `1631d4f79` (current main `f13007320` plus reviewed preparation); cloud `113696c1bcdb27747a8fe62c1158dcdf0168695f`. Sol independently reviewed the first draft; the requirements below resolve its four blockers. The review is recorded in `docs/superpowers/plans/2026-10-15-tensiomark-plan-review.md`.

### Parser and canonical layout

Use record grammar `^[0-9A-Za-z][+-][0-9]+\.[0-9]+[+-][0-9]+\.[0-9]+\r\n$` for each record. Every record must end in CRLF. Reject LF-only, missing final delimiter, whitespace, exponent, integer-only, NUL and extra fields. Reject missing, duplicate or unconfigured addresses as a whole soil batch. Layout requires every discriminator shown in the spec, including `qualification: bench_observed` and `calibration_range: unverified`; require identity address followed by `11TENSIOMARK_2Vh_10A` and exactly five decimal digits. Sort sensors by channel. Serialize top-level properties in spec order and sensor properties in spec order using `JSON.stringify`, and hash its UTF-8 bytes with SHA-256. Pin one synthetic digest fixture.

`normalizeTensiomark` preserves battery and returns evidence separately from `unknown`, which is empty for configured Tensiomark refusals. Evidence disposition is one of `accepted`, `rejected_framing`, `rejected_addresses`, `rejected_values`. `normalized_json` stores `{channels: <retained canonical channels>, disposition: <same code>}`. Invalid configuration does not activate this parser and retains legacy quarantine behavior. Evidence always preserves original response text. One clamped timestamp is shared by the canonical row and observation.

Test red then green through `normalize`: wet pF zero produces 0.1 kPa; dry pF 5.359 produces an unclipped value; reversed address order retains channel assignment; all framing/address/value refusals retain original raw text and battery; -9.88 C is valid and -9.88 pF / -99.88 C reject. All legacy offline tests stay green.

### Atomic persistence and configuration

Migration `0074__tensiomark_observations.sql` includes `-- risk: additive`, the nullable device-data FK and index, and a CHECK over the four dispositions. Add the table to seed schema and schema verifier table inventory. Regenerate bundled seeds with `node scripts/build-seed-db.js`. Include a focused fresh/upgrade test `scripts/test-tensiomark-schema.js` and document indefinite retention. The existing `osi-device-writer/index.js` must return inserted row id as an additive result property; ordinary callers stay unchanged. The focused observation helper wraps writer insertion and observation insertion in one transaction and uses that exact id. Roll back both directions on failures. Configured refusals write battery-only canonical data plus linked evidence, without capped quarantine. Existing commissioning observation runs after the transaction.

Add `tensiomark.js`, `config-handler.js`, `write-handler.js` inside existing `osi-sdi12-commissioning` package. Extract the existing config and write flow bodies into these helpers, keep authentication and wires intact, and add all helper files to `deploy.sh`. Modify exact nodes `sdi12-gate-fn`, `sdi12-config-action-fn`, `sdi12-write-fn`, `sdi12-post-reg-hook-fn`, `sdi12-identify-action-fn`, `sdi12-identify-trigger-fn`, `sdi12-identify-fn`. Gate forwards original ChirpStack `data` base64. Read current layout at identity action/trigger/reply and suppress stale discovery without modifying interpretation. Post-registration hook returns null; first-uplink discovery requires no layout and Sentek profile. Configured manual identification returns 409 with reason `tensiomark_layout_configured` and no MQTT output.

`scripts/test-tensiomark-runtime.js` tests save/readback, authentication, exact body keys and mixed-field refusal, unchanged sync version on identical resave, active Sentek deployment rejection, null-depth omission, configured depths for both SWT/temp, outbox/snapshot metadata, accepted and rejected FK linkage, rollback on either insert failing, raw survival after quarantine eviction, original base64 capture, no downlinks, and save-between-discovery-and-reply protection. Update old registration test that expected immediate discovery to expect no output. Keep `scripts/test-sdi12-recipe-flow.js` Sentek behavior passing.

### Edge and cloud interface files

Edge GUI files are the four listed in Task 3 plus their existing `__tests__` suites and locale files used by the modal/card. Add `TensiomarkChannelLayout`, preserve the legacy Sentek type, and define `Sdi12ChannelLayout` as their union. API normalization accepts object and JSON text, preserves null depths, and refuses malformed Tensiomark. Narrow every Sentek-only consumer by layout kind. Show mapped address/channel SWT and temperature, values above 300, battery and existing history action. Settings require explicit bench-observed pF/order confirmation and explain calibration remains unverified. Saving interpretation sends only the existing config HTTP request.

Extend `docs/contracts/sync-schema/resources.schema.json` with exact `TensiomarkChannelLayout` and mirror to server `backend/src/test/resources/sync-contract/resources.schema.json`. Runtime still checks address/channel uniqueness; JSON Schema uniqueItems cannot do so.

Cloud files: `backend/src/main/java/org/osi/server/device/SoilDevicePolicy.java` adds only `swt_1`, `swt_2` to SDI12 per-device series channels; `backend/src/main/java/org/osi/server/analysis/AnalysisCatalogService.java` reads Tensiomark channel/depth for SWT/temp labels. Test `SoilSourcePolicyTest`, `AnalysisCatalogServiceTest` and history/export/rollup suites covering the existing per-device path. Assert SDI12 remains excluded from root-zone source keys. No cloud DB migration, generic history redesign or new pF helper. Also add `soil_temp_1` and `soil_temp_2` to `backend/src/main/java/org/osi/server/device/DeviceController.java` ALLOWED_SENSOR_FIELDS and extend `DeviceControllerSensorHistoryFieldsTest.java`; otherwise SensorMonitor temperature requests return 400.

Cloud frontend files: `frontend/src/types/farming.ts`, `frontend/src/services/api.ts`, `frontend/src/components/farming/Sdi12SoilCard.tsx`, `frontend/src/pages/deviceHistoryModel.ts` and focused tests. Preserve layout union, project soil_temp_1/2 into latest_data, render paired SWT/temp and include these in device history discovery. Extend `frontend/src/components/farming/shared/cardHistory.ts` with soil_temp_1/2 and `cardHistorySeries.test.ts` so temperature history buttons are reachable. Existing JSONB persistence, DTO and sync layout passthrough stay unchanged; test roundtrip using existing sync tests.

### Commands and expected evidence

Run from edge worktree (each command must exit zero):

```sh
node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-sdi12-normalize/*.test.js
node --test scripts/test-tensiomark-runtime.js scripts/test-tensiomark-schema.js scripts/test-sdi12-registration.js scripts/test-sdi12-recipe-flow.js
node scripts/verify-device-integration.js
node scripts/verify-sdi12-codec.js
node scripts/verify-db-schema-consistency.js
node scripts/verify-seed-db-ledger.js
node scripts/verify-profile-parity.js
node scripts/verify-module-file-deploy-coverage.js
node --test scripts/test-contract-schemas.js
node scripts/verify-communication-contract.js
node scripts/verify-sync-flow.js
```

Run edge GUI `npm run typecheck`, `npm run test:unit`, `npm run build` from `web/react-gui`. Run server backend `./gradlew test` from `backend` and server frontend `npm run test:unit`, `npm run build` from `frontend`. Preserve logs, report pre-existing failures separately and do not weaken gates. Independent Astra reviewer verifies actual diff and reruns targeted tests before deployment.

### Live runbook

Read-only census verifies gateway EUI, owner id, active private customer payload, schema ledger, sync target and absence/compatibility of the node. Save facts privately. Choose deployment payload only after comparing existing customer overlays; do not overwrite customer behavior with public main blindly. Take consistent protected SQLite backups plus complete Node-RED configuration and GUI before mutations. Rehearse ordered migrations on the protected backup with the chosen deploy runner; stop on any unreconciled ledger or fingerprint mismatch. Cloud compatibility/deployment precedes new edge activation when required.

Registration route: `POST /api/devices` with `{deveui:<node EUI>,name:<display name>,type_id:"DRAGINO_SDI12",appkey:<OTAA key>}` under the existing owner authorization, subject to validating the live handler's field names. Transport the single node's AppKey only through protected files/stdin, never stdout, argv or public fixtures. Preserve all session state by not importing any: only provision target Sensors application and SDI12 profile plus root OTAA key. Do not register while the node can uplink until the no-discovery fix is active. Save the explicit two-address layout with null depths, read it back, verify empty identify queue, then let the operator perform a fresh join.

Verification requires fresh target join, real addressed packet, linked raw observation and canonical row, four soil channels plus battery, device API/card/history, edge outbox acknowledgement and observed cloud catalog/series/export. Scratch fixture replay proves code only. Keep registration, deployment and live observation statuses distinct. Production osicloud.ch access needs explicit current-turn authorization under AGENTS.md; prepare and test code without claiming that access. A missing external prerequisite is recorded with its exact remaining action, while independent work continues.
