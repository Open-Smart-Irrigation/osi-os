# Bovey cloud full-parity program plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Phases 2-5 are scope contracts: each one gets its own task-level plan (superpowers:writing-plans) before execution.

**Goal:** Rebuild the osi-server cloud valve surface so a Bovey operator can do everything from the cloud that the osi-os `Valve-focused` edge dashboard offers: open/cancel, schedule editing, scheduler pause/skip, valve settings, service commands, live actuation state, and honest irrigation history.

**Architecture:** The edge stays authoritative and the sync contract's transport invariants are unchanged: every cloud write becomes a pending command the gateway polls over REST (30 s cadence) and acknowledges over MQTT; every cloud display mirrors edge-applied state, with a visible pending window in between. Parity is reached by (a) wiring the cloud to the four schedule command appliers the edge already ships in `osi-valve-control/cloud-commands.js`, (b) adding one new edge command (cancel), and (c) syncing three edge-only data families to the cloud: `valve_settings`, actuation expectations, and plan-push state.

**Tech Stack:** Spring Boot + Flyway + Postgres (cloud backend), React + TypeScript + SWR + i18next (cloud frontend), Node-RED function nodes + `osi-valve-control` CommonJS modules + SQLite (edge), JSON-schema sync contract in `docs/contracts/sync-schema/`.

**Spec:** `docs/superpowers/specs/2026-08-19-valve-control-design.md` (edge valve control) plus the C1-C5 ruling record in commit `a98c6817`. Phase 0 updates that record: this program overturns the read-only ruling. The 2026-08-25 independent review (this session) is the parity evidence base.

## Global constraints

- Edge is authoritative for valve state and schedules; cloud-originated edits are pending until the edge applies them and syncs back. No optimistic writes into cloud mirror tables.
- REST polling is the only cloud-to-edge command path; MQTT stays edge-to-cloud only.
- Contract files under `docs/contracts/sync-schema/` are canonical in osi-os; osi-server mirrors must match byte-for-byte. New command/resource types are additive to v1, never in-place semantic edits.
- Paired branches, lockstep merge: edge work continues on `Valve-focused` (osi-os), cloud work on `feat/bovey-cloud-parity` (osi-server). Each PR names its pair and the verification commands run.
- Never send a bare `CLOSE` to a STREGA valve in normal operation; ending a run early is a cancel (queue flush + expectation `CANCELLED`). The explicit-close manual override lives only in the settings dialog behind a two-step confirm.
- Commanded state must never render as observed state. Pending commands get pending affordances (badge, ghost row); only edge-synced state fills status fields.
- No user renaming (sync JWT subject = username). No vite build on this workstation (OOM); reviewers do not build. Cloud deploys as git bundle + compose to the `agro-link.ch` box.
- Weekday convention: STREGA mask bit0 = Sunday; display order Monday-first. Every weekday caps at 4 compiled windows; conflicts are validated on the edge.
- All new user-visible strings ship in all 7 locales (en, de-CH, fr, it, es, pt, lg); FR uses vous-form and feminine agreement for *la vanne* ("Ouverte"/"Fermée").

## Decision log

Confirmed by Phil 2026-08-25: "the cloud should be fully functional" — the C-series read-only ruling and the valve_settings edge-only ruling are overturned. Remaining decisions, with recommendations; OPEN items need a yes/no before their phase starts:

- **D1 (decided): write path.** The cloud gains full valve write capability via pending commands. `StregaValveCard`'s bare OPEN/CLOSE buttons are removed in Phase 1 (they are dead today: the edge registry rejects `VALVE_COMMAND` without a duration).
- **D2 (recommended): history source.** Phase 4 syncs edge actuation history (`valve_actuation_expectations` projections, with trigger, volumes, cancel reason) and drives the cloud panel from it, including backfill via cursor. The 2026-08-25 `valve_state_transitions` log keeps recording as a cross-check but stops being the panel's source. The no-backfill ruling dies with the don't-touch-the-edge constraint that produced it.
- **D3 (recommended): edit-latency honesty.** A cloud edit shows "sending to gateway" until the command ACK arrives (worst case ~30 s poll + apply). A rejected edit (e.g. `plan_conflict`) surfaces the ACK error in place; it never silently reverts. The existing `useDownlinkAction` pending/confirm pattern is extended with command-status polling (Task 1.1).
- **D4 (recommended): sync transport for new state.** `valve_settings`, actuation expectations, and push state travel as new resource/event types in the existing outbox stream, added to `events.schema.json` and `resources.schema.json`. New SQLite triggers on the edge go through osi-schema-change-control as ordered migrations (0025+).
- **D5 (OPEN): schedule editing conflict UX.** Edge-side validation is the only validation that counts (one code path, per `cloud-commands.js`). The cloud dialog mirrors the edge's input bounds client-side for fast feedback, but a conflict that only the compiled plan reveals arrives asynchronously via ACK. Accept up-to-30 s conflict feedback, or add a cloud-side dry-run endpoint later? Recommendation: accept the latency for this program; revisit only if Bovey complains.
- **D6 (OPEN): service commands from cloud.** Partial-opening, flushing, magnet, interval, model already work cloud-side. Keep them, add pre-send confirms (Phase 1), and port the edge `ValveServiceDialog` layout in Phase 5. Recommendation: yes.

## Parity gap inventory

From the 2026-08-25 review (edge inventory vs cloud branch). "Phase" is where the gap closes.

| Edge surface | Cloud today | Phase |
|---|---|---|
| Open for duration (dialog, 1-255 min, chips) | Dead bare OPEN button, silently dropped by edge | 1 |
| Cancel a queued/running open | Absent | 1 |
| Schedule CRUD + enable/disable (weekly + one-time) | Read-only list | 1 |
| Scheduler pause / resume / skip today | Absent | 1 |
| Re-send plan to valve | Absent | 1 |
| Timed action (service) | Sent without duration field, dropped by edge | 1 |
| Pre-send confirm on water-moving commands | Post-send acknowledgement only | 1 |
| Generation, flow rate + source, default open minutes | Absent (`valve_settings` not synced) | 2 |
| Liters estimate in open/schedule dialogs | Absent (needs flow rate) | 2 |
| Manual-override explicit close (settings dialog) | Bare CLOSE button on card (wrong place, dead) | 2 |
| Glyph 5-state (pending/open/closing/failed), countdown, progress ring | OPEN/CLOSED/unknown only | 3 |
| Plan-delivery badges (queued/acked/failed per weekday) | Absent | 3 |
| Stale-state and never-seen handling on tile | Partial (last-seen line) | 3 |
| Outcomes panel: status, trigger, volumes, mm depth, cancel reason | Transition-log pairing, no triggers, no volumes | 4 |
| Enclosure temp/humidity (Gen1) | In `sensor_data`, unrendered | 2 (display) |
| All-valves schedule overview panel | Per-card lists only | 5 |
| Full `valves.json` i18n key set, FR fixes | 38-key subset; FR gender + browser-locale dates | 1 (new keys) / 5 (sweep) |

## Phase map

Each phase lands green gates on both repos and is independently shippable to bovey.cloud.

- **Phase 0 — contract and spec deltas.** Update the spec's decision record; add `CANCEL_VALVE_ACTUATION` to `commands.schema.json`; enumerate Phase 2-4 schema additions as a contract RFC section. Gate: `node scripts/test-contract-schemas.js`, `node scripts/verify-sync-contract.js`, mirror byte-compare.
- **Phase 1 — command plane** (detailed below). Cloud drives schedules, scheduler status, plan resend, timed opens, cancel. Edge adds only the cancel applier. Gate: edge `node --test conf/.../osi-valve-control/`, cloud `./gradlew test -x buildTerraIntelligenceFrontend`, `npx tsc --noEmit`, `npm run test:unit`.
- **Phase 2 — valve settings parity.** Edge→cloud sync of `valve_settings` (new event type + ordered migration for the outbox trigger), cloud `valve_settings` mirror table (Flyway), `UPSERT_VALVE_SETTINGS` command + edge applier in `cloud-commands.js`, ported `ValveSettingsDialog` (generation, flow rate + source, default minutes, manual-override close), liters estimates, enclosure climate display gated "not measured on Gen2".
- **Phase 3 — live actuation and plan delivery.** Sync active expectation + `recentStaleState` + push-state summary; port `ValveTile`/`ValveControlPanel` (glyph states, 1 Hz countdown while open, progress ring, `planIncomplete` line, per-weekday push badges in the schedule dialog).
- **Phase 4 — history parity.** Actuation-history sync with backfill cursor; port `IrrigationOutcomesPanel` (8 statuses, trigger chips incl. `service_action`, volume + mm depth, advanced row); demote `RecentIrrigationsPanel` to fallback or retire it.
- **Phase 5 — full-surface polish.** `ValveScheduleOverview` port, `ValveServiceDialog` layout port, i18n sweep (7 locales, FR review fixes, locale-aware dates in `valveCardHelpers.ts`), whole-rendered-surface frontend-designer review (standing rule from feedback_agrolink_design_cohesion), demo checklist, lockstep merge + bundle deploy.

Rough scale: Phase 1 is the largest single phase (10 tasks below). Phases 2-4 are each comparable to the original Phase B branch (~1.5-4 k lines including tests). Phase 5 is mostly review and locale work.

---

## Phase 0 tasks

### Task 0.1: Record the overturned rulings

**Files:**
- Modify: `docs/superpowers/specs/2026-08-19-valve-control-design.md` (osi-os, `Valve-focused` branch) — append a dated decision entry.

- [ ] **Step 1:** Append under the C-series record: date 2026-08-25, operator decision "cloud fully functional", C-series read-only ruling and valve_settings edge-only ruling overturned, superseded by this plan (link this file). Keep the original rulings in place with a strikethrough-free "superseded 2026-08-25" note; history stays legible.
- [ ] **Step 2:** Commit: `docs(spec): record the 2026-08-25 full-parity decision; C-series read-only ruling superseded`

### Task 0.2: Add CANCEL_VALVE_ACTUATION to the command contract

**Files:**
- Modify: `docs/contracts/sync-schema/commands.schema.json` (osi-os) — enum + per-type schema.
- Mirror: the byte-identical copy in osi-server if one exists (`grep -rl commands.schema.json /home/phil/Repos/osi-server` before assuming).

**Interfaces:**
- Produces: command type `CANCEL_VALVE_ACTUATION` with required `device_eui` (16-hex uppercase, same pattern the four schedule commands use) and optional `reason` (string, default `operator_cancel`). Tasks 1.4 and 1.5 depend on these exact field names.

- [ ] **Step 1:** Add `"CANCEL_VALVE_ACTUATION"` to the `command_type` enum (near line 68) and an `if/then` block modeled on the `SET_VALVE_SCHEDULER_STATUS` block (line 299): require `device_eui`, allow `reason`.
- [ ] **Step 2:** Run: `node scripts/test-contract-schemas.js && node scripts/verify-sync-contract.js`; expect both exit 0.
- [ ] **Step 3:** If a server mirror exists, copy the file byte-for-byte and verify with `sha256sum` on both.
- [ ] **Step 4:** Commit (both repos if mirrored): `feat(contract): CANCEL_VALVE_ACTUATION command type`

---

## Phase 1 tasks — command plane

Repo key: **[cloud]** = `/home/phil/Repos/osi-server/.worktrees/bovey-cloud-parity`, **[edge]** = `/home/phil/Repos/osi-os/.claude/worktrees/valve-focused`.

### Task 1.1 [cloud]: command-status read endpoint

The async honesty model (D3) needs the frontend to see a command's ACK result. No such endpoint exists today (`DeviceCommand` has `status`, `ackStatus`, `ackDetail`; nothing serves them).

**Files:**
- Create: `backend/src/main/java/org/osi/server/command/CommandStatusController.java`
- Test: `backend/src/test/java/org/osi/server/command/CommandStatusControllerTest.java`

**Interfaces:**
- Produces: `GET /api/v1/commands/{id}` → `{ "commandId": long, "status": "PENDING|SENT|ACKNOWLEDGED|FAILED", "ackStatus": string|null, "ackDetail": string|null }`. 404 for a command whose issuing user is not the caller. Tasks 1.6-1.8 poll this.

- [ ] **Step 1:** Write the failing test: issuing user gets 200 with status fields; a different user gets 404; unknown id gets 404. Follow the MockMvc + repository-seeding style of `ValveControllerTest`.
- [ ] **Step 2:** Run: `./gradlew test --tests CommandStatusControllerTest -x buildTerraIntelligenceFrontend`; expect FAIL (404 route).
- [ ] **Step 3:** Implement the controller: load via `commandRepository.findById`, compare `command.getIssuedBy()` (check the actual field name on `DeviceCommand` first; if commands lack an issuing-user column, scope by the gateway's `claimedBy` instead and note it in the javadoc).
- [ ] **Step 4:** Re-run the test; expect PASS. Commit: `feat(commands): owner-scoped command status read`

### Task 1.2 [cloud]: valve schedule write endpoints

**Files:**
- Create: `backend/src/main/java/org/osi/server/valve/ValveCommandController.java` (keep `ValveController` read-only; the split mirrors edge `api.js` vs `cloud-commands.js`)
- Test: `backend/src/test/java/org/osi/server/valve/ValveCommandControllerTest.java`

**Interfaces:**
- Consumes: `commandService.issueGatewayCommand(gateway, type, params, user, aggregateType, aggregateKey, …)` exactly as `DeviceController.sendCommand` (line ~139) does; `gatewayForDevice(device)` for gateway resolution; ownership check identical to `ValveController.getValveSchedules`.
- Produces:
  - `POST /api/v1/valves/{eui}/schedules` body `{kind, label?, weekdaysMask?, startTime?, fireAt?, durationMinutes, enabled}` → issues `UPSERT_VALVE_SCHEDULE` with a server-generated `schedule_uuid` (UUID v4), returns `{commandId, scheduleUuid, status: "PENDING"}`
  - `PUT /api/v1/valves/{eui}/schedules/{scheduleUuid}` same body → `UPSERT_VALVE_SCHEDULE` with the given uuid
  - `DELETE /api/v1/valves/{eui}/schedules/{scheduleUuid}` → `DELETE_VALVE_SCHEDULE`
  - `POST /api/v1/valves/{eui}/plan/resend` → `RESEND_VALVE_PLAN`
  - `POST /api/v1/valves/{eui}/scheduler-status` body `{status: "ACTIVE"|"SKIP_TODAY"|"DEACTIVATED"}` → `SET_VALVE_SCHEDULER_STATUS`

  Command params use the contract's snake_case field names (`device_eui`, `schedule_uuid`, `weekdays_mask`, `start_time`, `fire_at`, `duration_minutes`) — the edge appliers read exactly these (see `cloud-commands.js:21-22`). Do not send `timezone`; the edge fills it from the zone.
- [ ] **Step 1:** Failing tests: happy path per endpoint asserts a `DeviceCommand` row with the right type and params; non-owner → 404; non-valve device → 409; validation bounds mirror edge `plan.js` (`durationMinutes` 1-1439 WEEKLY / 1-255 ONCE, `weekdaysMask` 1-127, `startTime` `HH:MM`, `fireAt` ISO-8601 UTC) → 400 with a field-naming error body.
- [ ] **Step 2:** Run: `./gradlew test --tests ValveCommandControllerTest -x buildTerraIntelligenceFrontend`; expect FAIL.
- [ ] **Step 3:** Implement; validation lives in small package-private static methods so the test can hit edge cases directly.
- [ ] **Step 4:** Re-run; PASS. Commit: `feat(valves): cloud schedule write endpoints issuing edge pending commands`

### Task 1.3 [cloud]: open-for-duration and cancel endpoints; fix timed action

**Files:**
- Modify: `backend/src/main/java/org/osi/server/valve/ValveCommandController.java` (add two routes)
- Modify: `backend/src/main/java/org/osi/server/device/DeviceController.java:707-756` (`setStregaTimedAction`)
- Test: extend `ValveCommandControllerTest`; extend the existing DeviceController strega tests.

**Interfaces:**
- Produces: `POST /api/v1/valves/{eui}/open` body `{durationMinutes: 1-255}` → `OPEN_FOR_DURATION` with `duration_seconds = durationMinutes * 60`; `POST /api/v1/valves/{eui}/cancel` body `{reason?}` → `CANCEL_VALVE_ACTUATION`. Both return `{commandId, status: "PENDING"}`.

- [ ] **Step 1:** Failing tests: open with duration 0 or 256 → 400; open with 5 → command params contain `duration_seconds: 300` (this satisfies the edge reject gate, `requires_duration`); cancel → `CANCEL_VALVE_ACTUATION` with `reason` defaulted to `operator_cancel`.
- [ ] **Step 2:** Failing test for timed action: params must now include `duration_seconds` computed as `amount * (unit==seconds?1 : unit==minutes?60 : 3600)` alongside the existing `payloadHex` — today's params carry no duration and the edge drops the command.
- [ ] **Step 3:** Run targeted tests — FAIL. Implement. Re-run — PASS.
- [ ] **Step 4:** Commit: `fix(valves): duration-bearing open/cancel/timed-action commands the edge accepts`

### Task 1.4 [edge]: cancel applier

The cancel logic today lives only in the flows.json HTTP node for `/api/v1/valves/:deveui/cancel` (ChirpStack queue flush + newest active `valve_actuation_expectations` row → `CANCELLED`). One code path, two entry points, same as the schedule appliers.

**Files:**
- Create: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/cancel.js` (extract the core: `cancelActuation({db, deviceEui, reason, flushQueue, now})`)
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/cloud-commands.js` (add `CANCEL_VALVE_ACTUATION: applyCancelValveActuation` to `APPLIERS`)
- Modify: flows.json cancel route node — delegate to `cancel.js` (follow osi-flows-json-editing for the edit; function-node-body-only)
- Modify: flows.json `cmd-type-registry` + `reject-indefinite-open` fallback: `CANCEL_VALVE_ACTUATION: { dispatch: 'valve_cancel', actuator: false, requires_duration: false }`
- Test: `conf/.../osi-valve-control/cancel.test.js`, extend `cloud-commands.test.js`
- Mirror: bcm2709 flows.json if that target carries the same nodes (check first; the review only touched bcm2712).

**Interfaces:**
- Consumes: contract fields from Task 0.2 (`device_eui`, `reason`).
- Produces: applier result `{ok, error?, downlinks: []}` matching the other appliers, so the "Valve Cloud Command Bridge" ACK path needs no change.

- [ ] **Step 1:** Failing tests: cancel with an active `PENDING_OBSERVATION` expectation marks it `CANCELLED` with the reason and calls `flushQueue` once; cancel with no active expectation returns `{ok: true}` idempotently (replays must be harmless); non-valve EUI → `{ok: false, error: 'not_a_valve'}`.
- [ ] **Step 2:** Run: `node --test conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-valve-control/`; expect the new tests to FAIL.
- [ ] **Step 3:** Implement `cancel.js`, wire the applier, update the two flows.json nodes and deploy.sh's shipped-file list if `cancel.js` is new to it (the `95e4324d` guard should catch the class; verify).
- [ ] **Step 4:** Re-run node tests plus `node scripts/verify-sync-op-parity.js`; PASS. Commit: `feat(valves): CANCEL_VALVE_ACTUATION applier sharing the REST cancel path`

### Task 1.5 [cloud]: ACK plumbing check for the new commands

- [ ] **Step 1:** Extend `EdgeSyncService`/command-ack tests with one case per new command type asserting `applyAck` lands `ACKNOWLEDGED`/`FAILED` with `ackDetail` preserved (the edge returns `plan_conflict` etc. in the ACK detail; Task 1.7's UI copy keys off it). If the generic path already covers this, the test still pins it.
- [ ] **Step 2:** Run, fix if red, commit: `test(sync): pin ACK detail passthrough for valve command types`

### Task 1.6 [cloud]: frontend command client and pending-tracking hook

**Files:**
- Modify: `frontend/src/services/api.ts` — extend `valvesAPI` with `createSchedule`, `updateSchedule`, `deleteSchedule`, `resendPlan`, `setSchedulerStatus`, `openForDuration`, `cancel`, plus `commandsAPI.getStatus(commandId)`.
- Create: `frontend/src/hooks/useValveCommand.ts`
- Test: `frontend/tests/useValveCommand.test.ts`

**Interfaces:**
- Produces: `useValveCommand<T>()` → `{ status: 'idle'|'sending'|'awaitingGateway'|'applied'|'rejected', errorDetail: string|null, submit(fn: () => Promise<{commandId}>): Promise<void>, reset() }`. `awaitingGateway` polls `commandsAPI.getStatus` every 5 s, stops on `ACKNOWLEDGED` (→ `applied`, then triggers the caller's SWR revalidation) or `FAILED` (→ `rejected`, `errorDetail` = ackDetail), gives up after 3 min → `rejected` with a timeout detail. This is D3's honesty model; every Phase 1 UI change consumes it.

- [ ] **Step 1:** Failing tests with a mocked `commandsAPI`: ACK success path, ACK failure path carrying detail, timeout path.
- [ ] **Step 2:** Run `npm run test:unit -- useValveCommand`; FAIL, then implement, then PASS.
- [ ] **Step 3:** Commit: `feat(valves): pending-command tracking hook with ACK-detail surfacing`

### Task 1.7 [cloud]: schedule dialog port

**Files:**
- Create: `frontend/src/components/farming/valves/ValveScheduleDialog.tsx` — port from edge `web/react-gui/src/components/farming/valves/ValveScheduleDialog.tsx`, minus the compiled-week push badges (Phase 3) and liters preview (Phase 2).
- Modify: `frontend/src/components/farming/valves/CloudValveCard.tsx` — "Edit schedules" button opening the dialog.
- Test: `frontend/src/components/farming/valves/__tests__/ValveScheduleDialog.test.tsx` + pure helpers into `valveCardHelpers.ts` with `frontend/tests/` coverage.

**Interfaces:**
- Consumes: `valvesAPI` write methods and `useValveCommand` (Task 1.6); `weekdaysFromMask`, `sortWeekdaysForDisplay`, `windowEnd` (already ported in `valveState.ts`); the edge's DST-safe `zonedTimeToUtcIso` two-pass conversion (port it into `valveCardHelpers.ts` verbatim with its tests).
- Produces: schedule rows render a pending badge while `awaitingGateway`; a `rejected` state maps `plan_conflict` detail onto the edge's conflict copy keys (`conflictTooMany`, `conflictOverlap`, `conflictInvalidStart`, `conflictGeneric`).

- [ ] **Step 1:** Failing component tests: create flows to `awaitingGateway` then `applied` on mocked ACK; `plan_conflict` renders conflict copy and keeps the form values; the synced list (SWR revalidate) is the only thing that adds the row (no optimistic insert).
- [ ] **Step 2:** Implement, keeping every string in the `valves` namespace (new keys in all 7 locales; copy the edge locale values as the starting point).
- [ ] **Step 3:** `npx tsc --noEmit && npm run test:unit`; PASS. Commit: `feat(valves): cloud schedule editing over pending commands`

### Task 1.8 [cloud]: replace the dead card controls

**Files:**
- Modify: `frontend/src/components/farming/StregaValveCard.tsx` — remove the bare OPEN/CLOSE grid (lines ~788-812); add "Open…" (dialog) + "Cancel" buttons.
- Create: `frontend/src/components/farming/valves/ValveOpenDialog.tsx` — port from edge, duration 1-255 with 15/30/60 chips, closes-at preview in the valve's zone timezone when known; liters chip omitted until Phase 2.
- Modify: the three water-moving service commands (`applyTimedAction`, partial, flushing) gain an inline pre-send confirm (port the edge's `confirmTitle`/`confirmBody`/`confirmButton` pattern from `ValveServiceDialog`).
- Test: extend `frontend/tests/stregaValveCard.test.ts` + new `frontend/tests/valveOpenDialog.test.ts`.

- [ ] **Step 1:** Failing tests: no element issues a durationless valve command anywhere in the card; open dialog submit calls `valvesAPI.openForDuration(eui, minutes)`; timed action submit is gated behind an explicit confirm click.
- [ ] **Step 2:** Implement. Cancel button renders only while the synced state or a tracked command suggests a run may be active; when unknown, it stays visible but idempotent (Task 1.4 made cancel a safe no-op).
- [ ] **Step 3:** Gates: `npx tsc --noEmit && npm run test:unit`. Commit: `fix(valves): duration-bearing open + cancel replace the dead OPEN/CLOSE buttons`

### Task 1.9: locale additions for Phase 1

- [ ] **Step 1:** Add every new key to all 7 `frontend/public/locales/*/valves.json`; start FR from the edge's FR `valves.json`, applying the review fixes (Ouverte/Fermée, "Dernier signal il y a …" phrasing). Keep key-set parity exact; the audit script from the 2026-08-25 review run is the checker.
- [ ] **Step 2:** `npm run test:unit` (i18n key tests); PASS. Commit: `i18n(valves): phase-1 write-surface strings, 7 locales`

### Task 1.10: phase gate and lockstep push

- [ ] **Step 1 [edge]:** `node --test conf/.../osi-valve-control/ && node scripts/verify-sync-contract.js && node scripts/test-contract-schemas.js && node scripts/verify-sync-op-parity.js && node scripts/verify-sync-flow.js`; all exit 0.
- [ ] **Step 2 [cloud]:** `./gradlew cleanTest test -x buildTerraIntelligenceFrontend && cd frontend && npx tsc --noEmit && npm run test:unit`; green (channels.parity SHA drift stays the one known red).
- [ ] **Step 3:** Paired commits pushed on both branches; each commit message names its pair. End-to-end verification against the live gateway (schedule created on cloud appears on the edge screen and back) happens at deploy time under osi-live-ops-runbook, not from this workstation.

---

## Phase 2-4 scope contracts

Each phase starts with its own superpowers:writing-plans pass; these contracts fix scope, interfaces, and gates so those plans argue from here.

**Phase 2 — valve settings.** Contract: `resources.schema.json` gains a `valve_settings` resource (strega_generation, flow_rate_lpm, flow_rate_source, default_open_minutes, scheduler_status, skip_today_date, sync_version); `events.schema.json` gains `VALVE_SETTINGS_UPSERTED`; `commands.schema.json` gains `UPSERT_VALVE_SETTINGS`. Edge: ordered migration (0025+, via osi-schema-change-control) adding the outbox trigger on `valve_settings`, applier in `cloud-commands.js` writing through `store.upsertSettings`. Cloud: Flyway `valve_settings` mirror, `EdgeSyncService` applier, settings fields joined into `ValveResponse`, ported `ValveSettingsDialog` including the two-step manual-override close (issuing the contract's existing `CLOSE` command type, which the edge registry already dispatches as `strega_explicit_close`). Gate additions: `node scripts/verify-migrations.js` family, seed replay, runtime-schema parity.

**Phase 3 — runtime state.** Contract: `VALVE_ACTUATION_CHANGED` event carrying the active expectation projection (expectation_id, reconciliation_state, commanded_at, expected_close_at, duration_seconds, trigger, recent_stale_state) and a push-state summary (queued/acked/failed counts, per-weekday latest state for GEN1). Edge: outbox enqueues on expectation insert/update and push-ledger transitions (migration for triggers; the reconciler already centralizes state changes). Cloud: projection table or JSONB column on `valve_settings`-adjacent mirror, `ValveTile` port with `deriveValveGlyphState` (the edge file is the reference; the cloud already carries `ValveGlyphState` in `valveState.ts`), 1 Hz ticker only while open/pending, countdown from `expected_close_at` (clock skew note: render from server-relative offset). Latency statement rendered honestly: MQTT keeps `current_state` fresh; expectation sync adds ≤ one sync cycle.

**Phase 4 — history.** Contract: `VALVE_ACTUATION_ARCHIVED` events (terminal expectations with status, trigger, cancel_reason, estimated_gross_liters, volume_source) plus a `sync_cursor` stream for backfill of historical `valve_actuation_expectations`. Cloud: `valve_actuations` table, `GET /api/v1/valves/recent-actuations` mirroring the edge response shape, `IrrigationOutcomesPanel` port (8 statuses, trigger chips, mm depth needs zone `areaM2` + efficiency which the cloud zone mirror already carries — verify before planning), `RecentIrrigationsPanel` retired or kept behind a fallback flag when a gateway predates the archive events. `valve_state_transitions` recording continues untouched.

**Phase 5 — polish.** `ValveScheduleOverview` port; `ValveServiceDialog` layout parity; locale-aware dates (`Intl.DateTimeFormat(i18n.resolvedLanguage, …)` in `valveCardHelpers.ts:82,92`); the review's copy list (badge label, heading case, once-fallback key, `centralHubs` FR); full i18n key-parity audit re-run; frontend-designer review of the whole rendered cloud surface; demo checklist (gateway MQTT link verified per the 2026-08-25 review F2 procedure: UCI `osi-server.cloud.mqtt_broker_url` present or re-link, fresh last-seen, one end-to-end schedule round-trip).

## Program-wide verification

Every phase's execution report cites command output, not summaries (osi-verification-commands). Standing set: the four sync verifiers (edge), `node --test` on `osi-valve-control`, gradle `cleanTest test` (never trust `UP-TO-DATE`), `tsc --noEmit`, `npm run test:unit` on both frontends, and the i18n key-parity script. Cross-repo: mirror byte-compare on every contract file touched. Deploys follow osi-live-ops-runbook; the cloud deploys from a git bundle to the `agro-link.ch` box; the gateway deploy never reseeds `/data/db/farming.db`.
