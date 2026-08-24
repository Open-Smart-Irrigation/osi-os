# Valve Advanced Controls Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** End the two-surface duplication in osi-os#171 without losing the six advanced STREGA commands, by moving them to a clearly separated service view and giving the daily surface the five things the legacy card does better.

**Architecture:** Frontend-only for Tasks 1–3. A new `ValveServiceDialog` carries the six `stregaAPI` commands; the Valve control panel gains delete, EUI, never-seen and pending disclosures plus an open confirmation; `StregaValveCard`'s control surface is then removed from the daily path. Task 4 (commanded aperture persistence) is the only task that touches the edge, and it is **gated on decision E2**.

**Tech Stack:** React + TypeScript (`web/react-gui`), existing `stregaAPI` clients, `osi-valve-control` module (Task 4 only), SQLite migration (Task 4 only).

**Spec:** [docs/superpowers/specs/2026-08-24-valve-advanced-controls-consolidation-design.md](../specs/2026-08-24-valve-advanced-controls-consolidation-design.md) — read §4 first. This plan assumes the **recommended** answers: E1=(ii) separate service view, E2=(b) persist commanded value with honest labelling, E3=document the split, E4=**blocking unknown**, E5=inherited unchanged.

## Global Constraints

- **E4 is ANSWERED (operator, 2026-08-24): `SET_PARTIAL_OPENING` is a ONE-TIME action and the default opening is always 100%.** Partial opening is therefore safe to ship alongside the scheduler — a scheduled `OPEN_FOR_DURATION` always runs fully open and a 40% flush does not leak into later windows. Build all six commands in Task 1.
- **That answer changed Task 4's shape.** Because the resting position is always 100%, there is no persistent aperture to store; a `current_aperture` column would model a state that does not exist. Task 4 is now about recording the one-shot *event*, if anything — and "persist nothing" became a defensible option. It stays gated on E2.
- **Aperture can never be read back.** Neither decoder reports position; `current_state` is binary. Any aperture the GUI shows is *what we last commanded*. Copy must say "set to 40%", never "40% open". Rendering a commanded value as an observation violates the repo's missing-data rule.
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

### Task 4: Persist commanded aperture — **BLOCKED on E2 and E4**

Do not start without a ruling on both. Recorded here so the shape is agreed, not so it gets built by default.

**Files (under E2 answer (b), `valve_actuation_expectations` variant):**
- Create: `database/migrations/ordered/00NN__valve_commanded_aperture.sql`
- Modify: `osi-valve-control/store.js` + bcm2709 mirror
- Modify: `ValveServiceDialog.tsx`, `ValveTile.tsx`

- [ ] **Step 1: Record the ruling in the spec before coding.** If E2 chose the cheap `valve_settings` column instead, this task is a different, smaller shape — re-plan it rather than adapting.
- [ ] **Step 2: Migration** — take the next free number; `0024` is claimed by the Phase B parity plan, so coordinate if both land in the same release.
- [ ] **Step 3: Write-side** — record the commanded percentage as an event when the command is queued, never on ACK (the ACK confirms receipt, not position). Do not write it to any field that reads as current state.
- [ ] **Step 4: Read-side** — surface it as *commanded*. A test must assert the copy does not read as an observation.
- [ ] **Step 5: Mirror to bcm2709, `verify-profile-parity.js`, commit.**

---

### Task 5: Documentation

- [ ] **Step 1: Document the capability-flag split** (spec §3b) wherever device capability is described — `devices.strega_model` governs mechanics (partial opening, flushing); `valve_settings.strega_generation` governs scheduler encoding. Note they are independent and a GEN2 motorized valve is valid.
- [ ] **Step 2: Send the remaining vendor question** — Phase A §13, whether SV2 firmware can report its scheduler over LoRaWAN after a Bluetooth edit. (E4 is answered: partial opening is one-shot, default 100%.) Also document that answer wherever partial opening is described.
- [ ] **Step 3: Update #171** with what shipped and what remains.

---

## Self-review notes

- **Spec coverage:** §5 "in scope" maps to Tasks 1, 2, 4, 5; the retirement to Task 3; §6 verification is Task 3 Step 1's gate.
- **Deliberate omission:** deleting `StregaValveCard` outright. Task 3 removes controls only.
- **Ordering hazard:** Task 3 must not precede Tasks 1–2. This is stated twice on purpose.
- **Cross-plan collision:** migration number `0024` is claimed by the Phase B plan. Whichever lands second takes the next number.
