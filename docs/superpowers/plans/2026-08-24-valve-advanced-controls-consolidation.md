# Valve Advanced Controls Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End the two-surface duplication in osi-os#171 without losing the six advanced STREGA commands, by moving them to a clearly separated service view and giving the daily surface the five things the legacy card does better.

**Architecture:** Frontend-only for Tasks 1–3. A new `ValveServiceDialog` carries the six `stregaAPI` commands; the Valve control panel gains delete, EUI, never-seen and pending disclosures plus an open confirmation; `StregaValveCard`'s control surface is then removed from the daily path. Task 4 is a flows-level enrichment of an existing `actuator_log` write — the only task touching the edge, and it needs no migration.

**Tech Stack:** React + TypeScript (`web/react-gui`), existing `stregaAPI` clients, `osi-valve-control` module (Task 4 only), SQLite migration (Task 4 only).

**Spec:** [docs/superpowers/specs/2026-08-24-valve-advanced-controls-consolidation-design.md](../specs/2026-08-24-valve-advanced-controls-consolidation-design.md) — read §4 first. **RULED 2026-08-24** (independent review + operator acceptance):
**E1** service view — **as a subordinate dialog of the panel only**, no independent entry point, rendering no valve state the panel does not provide (the "third surface" objection dissolves only under that condition).
**E2** **persist nothing new** — the action is already written to `actuator_log`; only the percentage is dropped. Task 4 enriches that one write. No migration, and the `0024` collision disappears.
**E3** document the split, including the **third** capability source: inference from the device *name*.
**E4** closed (one-shot, default 100%). **E5** inherited unchanged.

## Global Constraints

- **E4 is ANSWERED (operator, 2026-08-24): `SET_PARTIAL_OPENING` is a ONE-TIME action and the default opening is always 100%.** Partial opening is therefore safe to ship alongside the scheduler — a scheduled `OPEN_FOR_DURATION` always runs fully open and a 40% flush does not leak into later windows. Build all six commands in Task 1.
- **E2 ruled: persist nothing new.** Every advanced STREGA command already writes an `actuator_log` row (builder `cdbaa3891d40d7a1` emits `_log_ctx`; node `5c45136f382d501c` inserts it) — it just records `action` as the bare string `SET_PARTIAL_OPENING` and drops the percentage. Task 4 adds the percentage to that existing write. **No migration, no new table.** `valve_actuation_expectations` is the wrong home (it drives a reconciliation state machine expecting a close, which a one-shot position command has none) and `osi-command-ledger` is the wrong home (it is the cloud pending-command pipeline, not a local action journal).
- **Aperture can never be read back.** Neither decoder reports position; `current_state` is binary. Any aperture the GUI shows is *what was last commanded*, and — since the action is one-shot — describes a past action, not a present position. Copy says "Open once to 40%" / "40% opening sent 14:02"; never "40% open" (an observation we cannot make) and never "Set opening to 40%" (a lasting position the valve does not hold).
- **Do not delete `StregaValveCard` in this plan.** Task 3 removes its *control* surface from the daily path only. Deleting the component is a separate decision once the service view has proven itself in the field.
- **Keep the motorized gate and its copy.** `stregaValve.motorizedLocked` ("Set the valve model to motorized to unlock partial opening and flushing commands") is good, discoverable copy — carry it over rather than re-writing it.
- All new user-facing strings go in **all seven** locales (`en, fr, de-CH, es, it, lg, pt`).
- Frontend builds OOM this workstation — never run two concurrently.
- Commit per task. Do not push without being asked.

---

### Task 1: `ValveServiceDialog` — the six advanced commands

**Files:**
- Create: `web/react-gui/src/components/farming/valves/ValveServiceDialog.tsx`
- Create: `web/react-gui/src/components/farming/valves/__tests__/ValveServiceDialog.test.tsx`
- Modify: `web/react-gui/public/locales/*/valves.json` (7)

**Interfaces:**
- Consumes: `stregaAPI` (`services/api.ts:781-813`) unchanged — do not alter the clients or endpoints.
- Produces: `<ValveServiceDialog valve={...} open onClose onChanged />`, mirroring `ValveSettingsDialog`'s props so Task 2 can mount it the same way.

- [ ] **Step 1: Write the failing test**

Cover the shape, not the styling:

```tsx
// - renders the four always-available controls: uplink interval, timed action,
//   magnet mode, valve model
// - partial opening and flushing are DISABLED with the motorizedLocked copy when
//   strega_model is not MOTORIZED, and enabled when it is
// - each control calls its stregaAPI client exactly once with the typed payload
// - a failed call surfaces an error and does NOT claim success
// - the three water-moving actions (partial opening, timed action, flushing)
//   require a confirmation step; one tap must not move water. Mirrors the rule
//   Task 2 applies to daily Open — review found Task 1 omitted it, which would
//   have made the service dialog laxer than the daily surface.
// - the dialog dismisses via an X in the header (house pattern, see
//   ValveSettingsDialog) and has no Cancel button
```

- [ ] **Step 2: Run it, watch it fail** — `npx vitest run src/components/farming/valves/__tests__/ValveServiceDialog.test.tsx`

- [ ] **Step 3: Build the dialog**

Copy `ValveSettingsDialog.tsx` as the structural template — header with `×` and `aria-label={tc('close')}`, footer with the action alone, 44 px targets, `var(--…)` tokens only. Group the controls so the destructive-ish ones are visually separate from the informational ones.

Build all six. E4 is answered, so partial opening carries no scheduler
interaction risk. Keep the motorized gate on partial opening and flushing.

The copy must not imply a lasting position: this is a one-shot action and the
valve returns to 100%. "Open once to 40%" is honest; "Set opening to 40%" is
not.

- [ ] **Step 4: Add locale keys to all seven locales**

Reuse the existing `stregaValve.*` strings where they already say the right thing (`motorizedNote`, `motorizedLocked`) rather than minting near-duplicates.

- [ ] **Step 5: Run tests + typecheck, then commit**

```bash
npm run typecheck && npx vitest run src/components/farming/valves/
git commit -am "feat(valve-gui): service dialog carrying the advanced STREGA commands"
```

---

### Task 2: Bring the five #171 items onto the daily surface

**Files:**
- Modify: `web/react-gui/src/components/farming/valves/ValveTile.tsx`
- Modify: `web/react-gui/src/components/farming/valves/ValveControlPanel.tsx`
- Modify: `web/react-gui/src/components/farming/valves/__tests__/ValveTile.test.tsx`
- Modify: `web/react-gui/public/locales/*/valves.json` (7)

**Interfaces:**
- Consumes: `ValveSummary` (already carries `deviceEui`, `lastUplinkAt`, `activeActuation`, `pushState`).
- Produces: a service-view entry point for Task 1's dialog.

These are #171's original acceptance criteria, verbatim:

- [ ] **Step 1: Failing tests for all five**

```tsx
// 1. the device EUI is shown (legacy-only today)
// 2. a valve that has never reported renders a "never seen" disclosure —
//    lastUplinkAt === null must NOT render as "closed and fine"
// 3. a commanded-but-unconfirmed open says so ("waiting for valve uplink"),
//    matching the honesty the legacy card already has
// 4. Open asks for confirmation — one tap must not move water
// 5. delete is reachable, and is NOT adjacent to Open
```

Item 5 deserves care: on the legacy card, delete sits beside a control that opens water on one tap. Do not reproduce that adjacency.

- [ ] **Step 2: Run, fail, implement, run** — standard loop.

- [ ] **Step 3: Add the service-view entry point**

A low-prominence affordance (overflow menu or a "Service" link in the settings dialog), not a primary button.

- [ ] **Step 4: Commit**

---

### Task 3: Retire the legacy control surface

**Files:**
- Modify: `web/react-gui/src/components/farming/StregaValveCard.tsx`
- Modify: its call sites (`IrrigationZoneCard.tsx`, the Unassigned Devices view)
- Modify: `web/react-gui/src/components/farming/__tests__/` as needed

- [ ] **Step 1: Verify the survivor is complete first**

Do not start this task until Tasks 1 and 2 are merged and every item in spec §6 is demonstrably true. **Removing the legacy controls before the replacement carries them is the exact failure this plan exists to prevent.**

Write the check as a test, not a promise: assert that every `stregaAPI` method still has a reachable caller in the surviving tree.

- [ ] **Step 2: Remove the control surface, keep identity/diagnostics**

Per #171 option 1. The card keeps EUI, model, last-seen and any read-only diagnostics; it loses the OPEN button, the delete ✕ and the advanced command forms.

- [ ] **Step 3: Confirm the original symptom is gone**

The #171 evidence was one valve showing `Closed` on the tile and `CLOSED + Open queued` on the card simultaneously. Assert one valve now yields exactly one control surface.

- [ ] **Step 4: Commit**

---

### Task 4: Stop dropping the percentage from the `actuator_log` write

**Files:**
- Modify (via one-shot script): both `flows.json` profiles — the STREGA downlink builder `cdbaa3891d40d7a1`, and the insert node `5c45136f382d501c` only if the destination column needs it

**No migration.** E2 ruled persist-nothing-new: the record already exists and is merely lossy. The builder computes a good label (`'PARTIAL OPEN 40%'`, `'FLUSH 40% -> OPEN'`) and then emits `action` as the bare command string, discarding the number.

- [ ] **Step 1: Write the failing test**

```
// SET_PARTIAL_OPENING at 40% produces a log context carrying the percentage;
// SET_FLUSHING likewise, including its return position.
// Assert on the emitted context, NOT on the label string — the label is display
// text and may be reworded or translated.
```

- [ ] **Step 2: Run, fail, implement.** Carry `percentage` (and `returnPosition`) in the `_log_ctx`. Check where `actuator_log` can hold it **before** adding anything — if an existing JSON/detail column fits, use it rather than proposing a column.

- [ ] **Step 3: Roundtrip guard, mirror both profiles, gates, commit.**

---

### Task 4b: Decide what an observed partial open looks like to the farmer

**A real interaction review surfaced, not a nicety.** A partial open physically opens the valve, but `write-strega-expectation` classifies `SET_STREGA_PARTIAL_OPENING` as `actuator: false`, so no expectation is written. The observe worker (`osi-valve-control/workers.js:83-118`) then files the resulting OPEN uplink as `trigger='unexplained'` with a 24-hour watch — so a routine service action appears in Recent irrigations as an **unexplained open**, the same label a Bluetooth-opened valve produced on the bench.

- [ ] **Step 1: Choose and record the treatment** — either write an expectation with a service-specific trigger value, or accept `unexplained` and document why.
- [ ] **Step 2: If a new trigger value is chosen**, round-trip it through the trigger chip's i18n like the existing values, and reconcile with Package A Task 6's `reason` vocabulary if that lands first.
- [ ] **Step 3: Test that a service action is not counted as irrigation** — a 40% flush must not appear as a watering event.

---

### Task 5: Documentation

- [ ] **Step 1: Document the capability-flag split** (spec §3b) — `devices.strega_model` governs mechanics (partial opening, flushing); `valve_settings.strega_generation` governs scheduler encoding; they are independent and a GEN2 motorized valve is valid.

  Include the **third** source review found: `getRecognizedStregaModel` (`StregaValveCard.tsx:44-51`) infers `MOTORIZED` when the device *name* contains "motor", and `STANDARD` from "solenoid"/"lite"/"standard". Capability is therefore partly derived from a free-text field a user can rename at any time. Document it; do not silently rely on it.

  Record the **merge-direction constraint** D4 creates: `strega_model` already syncs (it is in the device outbox payload and the bootstrap devices query) while `strega_generation` does not — so a future merge must land on a synced surface (`devices`) or wait for `valve_settings` to gain sync columns. Merging "into `valve_settings`" would silently REMOVE valve capability from the cloud.
- [ ] **Step 2: Send the remaining vendor question** — Phase A §13, whether SV2 firmware can report its scheduler over LoRaWAN after a Bluetooth edit. (E4 is answered: partial opening is one-shot, default 100%.) Also document that answer wherever partial opening is described.
- [ ] **Step 3: Update #171** with what shipped and what remains.

---

## Self-review notes

- **Spec coverage:** §5 "in scope" maps to Tasks 1, 2, 4, 5; the retirement to Task 3; §6 verification is Task 3 Step 1's gate.
- **Deliberate omission:** deleting `StregaValveCard` outright. Task 3 removes controls only.
- **Ordering hazard:** Task 3 must not precede Tasks 1–2. This is stated twice on purpose.
- **Cross-plan collision:** migration number `0024` is claimed by the Phase B plan. Whichever lands second takes the next number.
