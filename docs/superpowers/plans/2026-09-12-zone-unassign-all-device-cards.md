# Zone Unassign on Every Device Card — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The ✕ on a device card inside an irrigation zone detaches the device from that zone and nothing else. Today, on five of the six card types, it deletes the device from the account — history, zone links and ChirpStack registration included — while the confirm dialog claims it only unlinks it. Restore a real "unassign from zone" control on every card, including the SDI-12 card, using one shared mechanism instead of six copies.

**Architecture:** GUI-only. Both backend routes already exist and are correct: `unassign-device-http` (`DELETE /api/irrigation-zones/:id/devices/:deveui`, zone detach) and `delete-device-http` (`DELETE /api/devices/:deveui`, full account unlink). The bug is entirely in the React cards, which call `devicesAPI.remove()` themselves before invoking the caller's `onRemove`. The fix: a shared removal hook plus a shared confirm panel that branch on a `removeContext: 'zone' | 'farm'` prop, which every call site must state explicitly.

**Tech Stack:** React 18 + TypeScript + Vite, react-i18next, vitest + @testing-library/react, node:test (`tsx --test`) for locale-parity tests.

**Spec:** None. The controlling precedent is `StregaValveCard.tsx`, which already implements exactly this pattern (commit `a24cd216e2`, PR #193, review finding C-1, 2026-09-01). This plan generalises that one fix to the rest of the fleet.

**Baseline:** `origin/main` at `0c3bcd9e2`. Every line number below was read from that commit.

---

## Global Constraints

- **No backend change.** No `flows.json` edit, no migration, no seed change, no sync-contract change. If a task appears to need one, stop and re-read the plan.
- **Never run `npm run build`** — a production frontend build OOMs this workstation. Gates are `npm run typecheck` and `npm run test:unit`, both from `web/react-gui/`. CI (`.github/workflows/typecheck.yml`) runs the same two commands and does the build.
- **`STREGA` behaviour must not change at runtime.** Its `handleRemove` is already correct. This plan makes its `removeContext` prop required (a compile-time change only) and does not move it onto the shared hook — see Task 6 and the "Deliberately out of scope" section.
- **Zone detach must never touch device history.** `irrigationZonesAPI.removeDevice` clears the zone link; `device_data` rows stay. Any change that deletes readings on a zone ✕ is a regression, not a fix.
- **Luganda (`lg`) is human-translated on the edge and must never be machine-overwritten.** Existing `lg` strings are left byte-identical. New `lg` values are flagged for a human pass (see Task 3).
- **Every gate is judged by exit code** (`command; echo $?`), never by the last printed line.
- **Commit, do not push, do not deploy.** Rollout is Task 9's note, not this plan's work.

## What already exists (do not rebuild)

Verified against `origin/main` `0c3bcd9e2` before this plan was written:

| Piece | Status |
|---|---|
| `DELETE /api/irrigation-zones/:id/devices/:deveui` (`unassign-device-http`) | shipped, works |
| `DELETE /api/devices/:deveui` (`delete-device-http`) | shipped, works |
| `irrigationZonesAPI.removeDevice` (`web/react-gui/src/services/api.ts:535`) | shipped |
| `devicesAPI.remove` (`web/react-gui/src/services/api.ts:381`) | shipped |
| `IrrigationZoneCard.handleRemoveDevice` — zone-only detach (`IrrigationZoneCard.tsx:136-146`) | shipped, correct |
| `removeContext: 'zone' \| 'farm'` pattern on `StregaValveCard` (`:23`, `:647`, `:725-745`, `:796`) | shipped, correct |
| `IrrigationZoneCard` passes `removeContext="zone"` to the valve card (`:487`) | shipped |
| `stregaValve.removeSubtitleZone` copy in `en`, `de-CH`, `fr`, `it`, `es`, `pt` | shipped (`lg` is **untranslated English** — Task 3) |
| Test precedent `ValveCard.test.tsx:294-...` ("removeContext=\"zone\": confirming remove only calls onRemove") | shipped |
| The five broken cards calling `devicesAPI.remove` unconditionally | **the bug — this plan** |

## The bug, per card (all verified on `origin/main`)

| Card | `handleRemove` | Confirm copy | i18n? |
|---|---|---|---|
| `KiwiSensorCard.tsx` | `:330-340`, unconditional `devicesAPI.remove` at `:334` | `kiwiSensor.removeConfirm` / `.removeSubtitle` | yes |
| `Sdi12SoilCard.tsx` | `:97-107`, unconditional at `:101` | `sdi12Soil.removeConfirm` / `.removeSubtitle` | yes |
| `DraginoTempCard.tsx` | `:146-156`, unconditional at `:150` | **hardcoded English** ("Remove this device?" `:208`) | **no** |
| `SenseCapWeatherCard.tsx` | `:181-191`, unconditional at `:185` | **hardcoded English** ("Remove weather station?") | **no** |
| `LoRainGaugeCard.tsx` | `:100-112`, unconditional at `:104` | **hardcoded English** ("Remove rain gauge?") | **no** |
| `StregaValveCard.tsx` | `:725-745`, **correctly gated** on `removeContext === 'farm'` | `stregaValve.*` + `.removeSubtitleZone` | yes |

The ✕ button itself is gated only on `!readOnly`, never on whether `onRemove` was supplied — so a card with no `onRemove` still deletes the device, it just cannot tell its parent.

### Every card component rendered inside a zone (the complete set)

From the `IrrigationZoneCard.tsx` render body (device grids only):

| Component | Zone-card render | Groups devices of type |
|---|---|---|
| `KiwiSensorCard` | `:459-465` | `KIWI_SENSOR`, `TEKTELIC_CLOVER` |
| `StregaValveCard` | `:483-493` (already `removeContext="zone"`) | `STREGA_VALVE` |
| `DraginoTempCard` | `:511-515` | `DRAGINO_LSN50` |
| `Sdi12SoilCard` | `:534-538` | `DRAGINO_SDI12` |
| `SenseCapWeatherCard` | `:557-564` | `SENSECAP_S2120` |
| `LoRainGaugeCard` | `:582-586` | `AQUASCOPE_LORAIN` |

**The SDI-12 card is on `origin/main`** — `web/react-gui/src/components/farming/Sdi12SoilCard.tsx`, with `Sdi12SettingsModal.tsx`, `__tests__/Sdi12SoilCard.test.tsx`, `__tests__/Sdi12SettingsModal.test.tsx` and `services/__tests__/api.sdi12.test.ts` alongside it. It is not branch-resident; no separate `feat/sdi12` branch is needed. It carries the same unconditional-delete bug as the other three and is additionally the only card the zone renderer does **not** pass `readOnly` to (`:534-538`), so its ✕ is visible to read-only users.

Non-device panels in the same card body — `EnvironmentCard` (`:430`), the water card (`:300`), `ZoneDeviceModal` (`:624`), `ZoneConfigModal`, `AdvancedScheduleDrawer`, `Sdi12SettingsModal` — render no per-device ✕ and are out of scope. Gateway/ChirpStack, field-tester and journal surfaces render no device card inside a zone; they are out of scope too.

### The 'farm' call site

`web/react-gui/src/pages/FarmingDashboard.tsx:293-410`, the "Unassigned Devices" section: `KiwiSensorCard` (`:309`), `StregaValveCard` (`:327`), `DraginoTempCard` (`:348`), `Sdi12SoilCard` (`:366`), `SenseCapWeatherCard` (`:384`), `LoRainGaugeCard` (`:400`). Here the full delete is the intended behaviour — the device is already zone-less. Two defects to fix in passing:

- `SenseCapWeatherCard` at `:384` is given **no `onRemove` at all**, so deleting an unassigned weather station leaves the grid stale until the next poll.
- Neither call site passes `readOnly` to `Sdi12SoilCard`.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `web/react-gui/src/components/farming/useDeviceRemoval.ts` | **new** — the shared hook: context-gated delete, confirm state, error state | 1 |
| `web/react-gui/src/components/farming/DeviceRemoveConfirm.tsx` | **new** — the shared confirm panel and ✕ button labels | 1 |
| `web/react-gui/public/locales/*/devices.json` (7 locales) | **new** `deviceRemoval.*` block; `lg` `stregaValve.removeSubtitleZone` repair | 3 |
| `KiwiSensorCard.tsx`, `Sdi12SoilCard.tsx`, `DraginoTempCard.tsx`, `SenseCapWeatherCard.tsx`, `LoRainGaugeCard.tsx` | adopt the hook + panel, take a required `removeContext` | 2, 4 |
| `components/farming/IrrigationZoneCard.tsx` | pass `removeContext="zone"` to all six cards; pass `readOnly` to the SDI-12 card | 5 |
| `pages/FarmingDashboard.tsx` | pass `removeContext="farm"` to all six cards; add the missing `onRemove`/`readOnly` | 5 |
| `components/farming/StregaValveCard.tsx` | make `removeContext` required (no runtime change) | 6 |
| `components/farming/__tests__/deviceRemovalContext.test.tsx` | **new** — per-card zone/farm behaviour matrix | 7 |
| `components/farming/__tests__/IrrigationZoneCardRemoveContext.test.tsx` | **new** — the zone card renders every type in zone context | 7 |
| `components/farming/__tests__/ValveCard.test.tsx` | keep the C-1 test green under the now-required prop | 6 |
| `web/react-gui/tests/deviceRemovalI18n.test.ts` | **new** — `deviceRemoval.*` key parity across 7 locales | 3 |

---

## Design: one mechanism, not six

Two new files, deliberately split so the logic is testable without a DOM and the markup is shared:

**`useDeviceRemoval.ts`**

```ts
export type DeviceRemoveContext = 'zone' | 'farm';

export function useDeviceRemoval(options: {
  deveui: string;
  removeContext: DeviceRemoveContext;
  onRemove?: () => void;
}): {
  showConfirm: boolean;
  openConfirm: () => void;
  cancelConfirm: () => void;
  isRemoving: boolean;
  error: string | null;
  clearError: () => void;
  confirmRemove: () => Promise<void>;
};
```

`confirmRemove` is the whole contract:

1. `setIsRemoving(true)`, clear the error.
2. **Only when `removeContext === 'farm'`**: `await devicesAPI.remove(deveui)`.
3. `onRemove?.()` — in zone context this is the parent's `handleRemoveDevice`, i.e. `irrigationZonesAPI.removeDevice(zone.id, deveui)`.
4. On throw: `setError(err.response?.data?.message ?? t(context === 'zone' ? 'deviceRemoval.failedZone' : 'deviceRemoval.failedFarm'))` and `setIsRemoving(false)`.
5. On success leave `isRemoving` true and the panel open (matching the shipped cards — the parent unmounts or re-renders the card), except that the zone path also calls `setShowConfirm(false)` so a failed-then-retried detach cannot strand the panel.

**`DeviceRemoveConfirm.tsx`** renders the warn-styled confirm block (same tokens as `KiwiSensorCard.tsx:404-...`) and picks its copy from `removeContext`. It also exports `deviceRemoveButtonLabel(removeContext, isRemoving, t)` so the ✕ button's `aria-label`/`title` say what will happen — and so tests have a stable accessible query.

**Why not four copies of the `if (removeContext === 'farm')` guard:** the STREGA card proves a per-card guard works, and equally proves it does not spread — it shipped on 2026-09-01 and the other five cards still carry the bug three weeks later. One hook plus one panel means the next card type added to the fleet gets the correct behaviour by construction, and one test file covers all of them.

### The default: required, not defaulted

**Decision: `removeContext` is a required prop on all six cards. No default value.** TypeScript then refuses to compile a call site that does not state its intent, and `npm run typecheck` is the verifier — the omission that caused this bug becomes impossible to write. A default of `'zone'` would be the safe runtime fallback, but it silently mislabels the unassigned grid; a default of `'farm'` is exactly today's bug. A compile error beats both.

The cost is that any test rendering a card without the prop fails typecheck; Task 6 and Task 7 fix those call sites explicitly.

### Move UX: evaluated, deferred

`ZoneDeviceModal.tsx:72` refuses to assign a device that already belongs to another zone, with copy `zoneDeviceModal.assignConflict` ("… Unassign it there first."), so unassign-then-assign is currently the only sanctioned move path — which is precisely why the missing unassign control is blocking, not cosmetic.

A "Move to another zone…" selector on the zone ✕ is attractive but is a different change: it needs a zone picker in the confirm panel, a two-call sequence (detach then assign) with partial-failure handling, and a decision about whether the edge should get an atomic move endpoint so a crash between the two calls cannot orphan a device. That is a design question, not a bug fix. **Recommendation: ship the minimal correct unassign now** (this plan), and treat move-UX as optional follow-up Task 10 — with the note that `SenseCapWeatherCard` already has a multi-zone picker (`ZonePickerPanel`, `SenseCapWeatherCard.tsx:207-213`) that is the natural model for it.

---

## Task 1 — Shared hook and confirm panel

- [ ] Create `web/react-gui/src/components/farming/useDeviceRemoval.ts` with the signature and `confirmRemove` semantics above. Import `devicesAPI` from `../../services/api`, `useTranslation('devices')`. No JSX in this file.
- [ ] Create `web/react-gui/src/components/farming/DeviceRemoveConfirm.tsx` exporting:
  - `DeviceRemoveConfirm` — props `{ removeContext, isRemoving, onConfirm, onCancel }`; renders title, subtitle, confirm button (with the spinner markup already used at `KiwiSensorCard.tsx:411-419`) and a Cancel button using `useTranslation('common')`'s `cancel`.
  - `deviceRemoveButtonLabel(removeContext, isRemoving, t)`.
- [ ] Add a comment block in `useDeviceRemoval.ts` naming the regression it prevents: the zone ✕ deleting the device from the account, PR #193 finding C-1 generalised.

**Verification**

```
cd web/react-gui && npm run typecheck; echo $?
```

Expect `0`. No behaviour change is observable yet — nothing imports these files.

## Task 2 — Adopt the hook in the two already-i18n'd cards

- [ ] `KiwiSensorCard.tsx`: add `removeContext: DeviceRemoveContext` to `KiwiSensorCardProps` (`:11-...`), destructure it (`:308`), delete the local `isRemoving`/`showConfirm`/`error`-for-removal state and `handleRemove` (`:324-340`), and drive the ✕ (`:387`) and the confirm block (`:404-...`) from the hook and `DeviceRemoveConfirm`. Keep the card's other `error` usages untouched if any exist; if the removal error shares one `error` state with anything else, keep that state and feed it from `hook.error` rather than merging concerns.
- [ ] `Sdi12SoilCard.tsx`: same, against `:14-20` (props), `:97-107` (`handleRemove`), `:157` (✕), `:180-200` (confirm block). Its removal error lives in its own `removeError` state — replace it with `hook.error`.
- [ ] Leave the now-unused `kiwiSensor.remove*` / `sdi12Soil.remove*` locale keys in place; removing them is cosmetic and touches 7 locale files for no behaviour. Note it as follow-up.

**Verification**

```
cd web/react-gui && npm run typecheck; echo $?
cd web/react-gui && npx vitest run src/components/farming/__tests__/KiwiSensorCard.test.tsx src/components/farming/__tests__/Sdi12SoilCard.test.tsx; echo $?
```

Both `0`. Task 7 adds the tests that actually prove the context gate.

## Task 3 — Copy and i18n

- [ ] Add a `deviceRemoval` block to `web/react-gui/public/locales/en/devices.json` (top level, alongside `kiwiSensor`, `stregaValve`, `sdi12Soil`):

| Key | English |
|---|---|
| `deviceRemoval.titleZone` | `Remove from this zone?` |
| `deviceRemoval.titleFarm` | `Remove this device?` |
| `deviceRemoval.subtitleZone` | `The device stays registered and keeps its history — it only leaves this zone.` |
| `deviceRemoval.subtitleFarm` | `This will unlink the device from your account and delete its stored readings.` |
| `deviceRemoval.confirmZone` | `Yes, unassign` |
| `deviceRemoval.confirmFarm` | `Yes, remove` |
| `deviceRemoval.removingZone` | `Unassigning…` |
| `deviceRemoval.removingFarm` | `Removing…` |
| `deviceRemoval.failedZone` | `Failed to remove device from zone` |
| `deviceRemoval.failedFarm` | `Failed to remove device` |
| `deviceRemoval.buttonZone` | `Unassign from this zone` |
| `deviceRemoval.buttonFarm` | `Remove device` |

  `subtitleZone` is the generalisation of the approved valve wording at `en/devices.json:132`; `failedZone` matches the existing `zone.failedToRemoveDevice` string (`:186`) so operators see one phrase for one failure.
- [ ] Translate the same twelve keys in `de-CH`, `fr`, `it`, `es`, `pt`, following each locale's existing `stregaValve.removeSubtitleZone` phrasing (e.g. de-CH `:…` "Es bleibt registriert und behält seine Pläne — es verlässt nur diese Zone.").
- [ ] `lg`: **do not overwrite any existing `lg` string.** Add the twelve new keys with real Luganda, modelled on the human `lg` strings already present (`kiwiSensor.removeSubtitle` = "Ekyuma kiggyibwako ku akawunti yo."). If the executing worker is not confident in the Luganda, add the key with the best available wording **and list it in the PR body under "needs a human Luganda pass"** — do not leave the key missing (the parity test would fail) and do not paste English.
- [ ] **Pre-existing debt to fix here:** `lg/devices.json`'s `stregaValve.removeSubtitleZone` is still the untranslated English sentence from PR #193. Replace it with Luganda under the same flag-for-review rule.
- [ ] Create `web/react-gui/tests/deviceRemovalI18n.test.ts`, copying the shape of `web/react-gui/tests/devicesI18n.test.ts` exactly (`node:test`, `readDevices(locale)`, `getPath`, the `['en','de-CH','es','fr','it','lg','pt']` loop, `assert.equal(typeof …, 'string')`). Assert all twelve `deviceRemoval.*` keys plus `stregaValve.removeSubtitleZone`.
- [ ] Add one value assertion the parity test cannot give you: in `lg`, `deviceRemoval.subtitleZone` must not equal the `en` value (catches an English paste). Precedent for value-level locale assertions: `src/history/__tests__/historyLocaleValues.test.ts`.

**i18n verifiers that already exist and must stay green** (there is no `scripts/`-level locale linter in this repo — parity is enforced by tests): `web/react-gui/tests/devicesI18n.test.ts`, `tests/zoneDeviceModalI18n.test.ts`, `tests/addDeviceModalLocales.test.ts`, `tests/analysis-locales.test.ts`, `tests/dashboardNetworkI18n.test.ts`, `tests/readOnlyNoticeLocales.test.ts`, `src/history/__tests__/historyLocaleKeys.test.ts`, `src/history/__tests__/historyLocaleValues.test.ts`, `src/journal/__tests__/journalLocales.test.ts`. The `tests/**` ones run under `npm run test:unit:tsx-runner`; the `src/**` ones under vitest.

**Verification**

```
cd web/react-gui && npm run test:unit:tsx-runner; echo $?
cd web/react-gui && for l in en de-CH fr it es pt lg; do python3 -m json.tool "public/locales/$l/devices.json" > /dev/null || echo "BAD $l"; done
```

Exit `0`, no `BAD` lines.

## Task 4 — Adopt the hook in the three non-i18n'd cards

These three currently render hardcoded English. Moving them onto `DeviceRemoveConfirm` translates them as a side effect — intended, and the reason the shared panel is worth building.

- [ ] `DraginoTempCard.tsx`: add required `removeContext`; delete `handleRemove` (`:146-156`) and the hardcoded confirm block (`:207-...`); wire the ✕ (`:186-194`) to `hook.openConfirm` with `deviceRemoveButtonLabel`. Its removal error currently shares the `error` state at `:144` — check whether anything else writes it; if so, keep both and render `hook.error` in the same slot.
- [ ] `SenseCapWeatherCard.tsx`: same, against `:181-191` and `:245-...`. Keep `ZonePickerPanel` and the ⚙ button untouched.
- [ ] `LoRainGaugeCard.tsx`: same, against `:100-112` and `:143-...`. Note this card's `handleRemove` uniquely calls `setShowConfirm(false); setIsRemoving(false)` after success — the hook's zone path already closes the panel; accept the small difference on the farm path and say so in the commit body, or keep it by having the card call `hook.cancelConfirm()` after `confirmRemove` resolves.
- [ ] The LoRain ✕ glyph is a lowercase `x` (`:130`) where every other card uses `✕`. Normalise it to `✕` while you are in the file.

**Verification**

```
cd web/react-gui && npm run typecheck; echo $?
cd web/react-gui && npx vitest run src/components/farming/__tests__/DraginoTempCard.test.tsx src/components/farming/__tests__/SenseCapWeatherCard.test.tsx src/components/farming/__tests__/LoRainGaugeCard.test.tsx; echo $?
```

Both `0`. `LoRainGaugeCard.test.tsx:76` already asserts `onRemove` fires — it must still pass (add `removeContext="farm"` to that render).

## Task 5 — Wire both call sites

- [ ] `IrrigationZoneCard.tsx`: add `removeContext="zone"` to `KiwiSensorCard` (`:459`), `DraginoTempCard` (`:511`), `Sdi12SoilCard` (`:534`), `SenseCapWeatherCard` (`:557`), `LoRainGaugeCard` (`:582`). The valve card at `:487` already has it.
- [ ] `IrrigationZoneCard.tsx:534-538`: pass `readOnly={!canWrite}` to `Sdi12SoilCard`, matching every sibling card.
- [ ] `FarmingDashboard.tsx`: add `removeContext="farm"` to all six unassigned-grid cards (`:309`, `:327`, `:348`, `:366`, `:384`, `:400`).
- [ ] `FarmingDashboard.tsx:384`: add `onRemove={handleUpdate}` to the unassigned `SenseCapWeatherCard` so the grid refreshes after a delete.
- [ ] `FarmingDashboard.tsx:366`: pass `readOnly={!canWrite}` to the unassigned `Sdi12SoilCard`.

**Verification**

```
cd web/react-gui && npm run typecheck; echo $?
cd web/react-gui && grep -c 'removeContext="zone"' src/components/farming/IrrigationZoneCard.tsx
cd web/react-gui && grep -c 'removeContext="farm"' src/pages/FarmingDashboard.tsx
```

Exit `0`; both counts exactly `6`.

## Task 6 — STREGA: required prop, zero runtime change

- [ ] `StregaValveCard.tsx:23`: change `removeContext?: 'zone' | 'farm'` to `removeContext: DeviceRemoveContext`, importing the type from `useDeviceRemoval.ts`.
- [ ] `:647`: drop the `= 'farm'` default.
- [ ] Do **not** move `handleRemove` (`:725-745`) onto the hook. Zero behaviour change is not provable here: the card's `error` state is shared with `handleOpen`'s valve-command errors, its copy keys are the valve-specific `stregaValve.*`, and its confirm panel sits in valve-specific layout. Record it as follow-up Task 11.
- [ ] `__tests__/ValveCard.test.tsx:129` (`renderCard`): add a `removeContext: 'farm'` default in the props spread so every existing test keeps its current behaviour, and confirm the C-1 test at `:294`-onwards still overrides it with `'zone'`.

**Verification**

```
cd web/react-gui && npx vitest run src/components/farming/__tests__/ValveCard.test.tsx; echo $?
cd web/react-gui && git diff -- src/components/farming/StregaValveCard.tsx
```

Tests `0`; the diff must touch only the prop type and the destructuring default — no change inside `handleRemove`.

## Task 7 — Tests

- [ ] Create `src/components/farming/__tests__/deviceRemovalContext.test.tsx`. One `describe.each` over the five adopted cards (name, component, a minimal `device` fixture reusing each card's existing test fixture factory — `makeDevice` in `Sdi12SoilCard.test.tsx:36`, `kiwiDevice` in `KiwiSensorCard.test.tsx`, `lorainDevice` in `LoRainGaugeCard.test.tsx`, `s2120Device` in `SenseCapWeatherCard.test.tsx`, `chameleonDevice` in `DraginoTempCard.test.tsx`). Mock `devicesAPI` with `vi.mock('../../../services/api', …)` the way `ValveCard.test.tsx` does. Two tests per card:
  - `removeContext="zone": confirming remove calls onRemove and never devicesAPI.remove` — click the ✕ by its accessible label, click the confirm button, assert `onRemove` called once and `devicesAPI.remove` **not called**.
  - `removeContext="farm": confirming remove calls devicesAPI.remove then onRemove` — assert both, and assert the order.
- [ ] Add one copy test: in zone context the panel renders `deviceRemoval.subtitleZone`'s text and **not** the word "account"; in farm context the reverse. This is the assertion that keeps the dialog honest — the original defect was copy and behaviour disagreeing.
- [ ] Create `src/components/farming/__tests__/IrrigationZoneCardRemoveContext.test.tsx`, modelled on `IrrigationZoneCardData.test.tsx` for the render harness (providers, `useDisplayPreferences`, API mocks). Render one zone holding one device of each of the six types, expand the device section, and for each card confirm the ✕ → confirm flow calls `irrigationZonesAPI.removeDevice(zone.id, deveui)` and never `devicesAPI.remove`. This is the regression net that catches a future seventh card type wired with the wrong context.
- [ ] `web/react-gui/tests/deviceRemovalI18n.test.ts` from Task 3.

**Verification**

```
cd web/react-gui && npm run test:unit; echo $?
```

Exit `0`. Then prove the tests are load-bearing: temporarily revert one card's guard (make `devicesAPI.remove` unconditional again), re-run, confirm a red test, restore.

## Task 8 — Verification and manual acceptance

**Repo gates (all from `web/react-gui/`):**

```
npm run typecheck; echo $?
npm run test:unit; echo $?
```

Both must exit `0`. **Do not run `npm run build`** — it OOMs this workstation; CI's `typecheck.yml` covers it.

**Grep gates:**

```
# no card may call devicesAPI.remove outside the shared hook, except the STREGA card's own gated call
grep -rn "devicesAPI.remove" src/components/farming/
```

Expect exactly two hits: `useDeviceRemoval.ts` and `StregaValveCard.tsx` (inside its `removeContext === 'farm'` guard).

**Manual on-gateway acceptance — run on Silvan (`100.81.220.8`, demo), never on Uganda:**

1. Deploy the GUI bundle by the manual flow in the deploy guardrails (build GUI in CI or on a machine that can build it; never reseed `/data/db/farming.db`).
2. Record the pre-state for a zoned sensor:
   `sqlite3 /data/db/farming.db "SELECT deveui, user_id, irrigation_zone_id FROM devices WHERE deveui='<EUI>';"` and
   `sqlite3 /data/db/farming.db "SELECT COUNT(*) FROM device_data WHERE deveui='<EUI>';"`
3. In the dashboard, open the zone, expand Devices, press ✕ on that sensor card. Confirm the dialog says the device only leaves this zone. Confirm.
4. Post-state assertions: `irrigation_zone_id` is `NULL`; `user_id` **unchanged**; `device_data` count **unchanged**; the device now appears in the Unassigned Devices grid.
5. Re-assign it via the zone's "Add device" modal — it must assign without the `assignConflict` message.
6. In the Unassigned grid, press ✕ on a genuinely disposable test device. The dialog must say the account/readings wording, and the device must disappear from `devices`.
7. Repeat steps 2-4 for one device of each remaining type present on the gateway (LSN50, SDI-12, S2120, LoRain, STREGA) — at minimum for the SDI-12 card, which is the one this plan was raised for.

## Task 9 — Rollout note (no work, record it)

- [ ] GUI-only: no migration, no `flows.json` change, no schema fingerprint change, no sync-contract change. It ships with the next GUI redeploy — Silvan first, then Uganda.
- [ ] **Until that redeploy, operators must not press ✕ on a device card inside a zone** on any live gateway: on every card except STREGA it deletes the device from the account and its stored readings. The sanctioned workaround in the meantime is to leave the device where it is. Put this sentence in the PR body so whoever schedules the deploy sees it.

## Task 10 — Optional follow-up: move-to-another-zone UX

- [ ] Not in this plan. File an issue: a zone picker in the zone-context confirm panel, an atomic edge move endpoint (or documented compensating logic for a failed second call), and a decision on multi-zone devices (`SenseCapWeatherCard`'s `ZonePickerPanel` already models many-to-many).

## Task 11 — Optional follow-up: STREGA onto the shared hook

- [ ] File an issue to refactor `StregaValveCard.handleRemove` onto `useDeviceRemoval`, which requires first splitting its removal error state from its valve-command error state.

## Task 12 — Cloud parity check (check and report, do not fix)

- [ ] In `/home/phil/Repos/osi-server`, read the cloud's `IrrigationZoneCard.removeDevice.test.tsx` and the cloud sensor cards, and check whether their in-card remove handlers call the device-delete API unconditionally the way the edge's did.
- [ ] If they do, **file an osi-server issue** with the file/line evidence and a pointer to this plan; do not change osi-server code in this plan's branch. Cloud frontend tests run with `npm run test:unit`, not bare `npx vitest run`.

---

## Review checklist (for an adversarial reviewer)

- [ ] Does any card still call `devicesAPI.remove` outside `useDeviceRemoval`? (grep gate, Task 8 — exactly two permitted hits.)
- [ ] Is `removeContext` genuinely required on all six cards, with no default anywhere? A re-introduced `= 'farm'` default silently restores the bug for any future call site.
- [ ] Do all twelve call sites (6 zone + 6 unassigned) pass an explicit context, and is each one correct? A `"farm"` inside `IrrigationZoneCard` is the original defect with extra steps.
- [ ] Does the zone path leave `device_data` untouched? Look for any card that still deletes readings, and for any test that asserts deletion.
- [ ] Does the confirm copy match the action in **both** contexts, in all 7 locales? A dialog that promises "only leaves this zone" while deleting is worse than no dialog.
- [ ] Are any existing `lg` strings modified? Any English text pasted into `lg`? Was `lg`'s `stregaValve.removeSubtitleZone` actually translated, or just moved?
- [ ] Does STREGA's runtime behaviour change at all? The diff on `StregaValveCard.tsx` should be the prop type and the destructuring only.
- [ ] Do the new tests fail when the guard is removed? (Task 7's deliberate-revert step — an assertion nobody can break is not a regression net.)
- [ ] Is `readOnly` now honoured on the SDI-12 card at both call sites?
- [ ] Is the ✕ still rendered for a card with no `onRemove`? If so, in farm context it deletes the device and cannot tell its parent — is every farm-context call site now passing `onRemove`?
- [ ] Did anything outside `web/react-gui/` change? Nothing should have.
- [ ] Was `npm run build` run on this workstation? It must not have been.

## Risks

| Risk | Mitigation |
|---|---|
| A call site is missed and silently defaults to the wrong context | No defaults: `typecheck` fails on an omission (Task 8) |
| Refactoring the three hardcoded-English cards changes their layout | The shared panel copies `KiwiSensorCard`'s existing warn-block markup and tokens verbatim; visual check in Task 8 step 7 |
| `lg` gets English or machine Luganda | Explicit rule in Task 3, a value-level test that `lg` ≠ `en`, and a "needs human Luganda pass" list in the PR body |
| The zone detach succeeds but the grid does not refresh | `onRemove` → `handleRemoveDevice` → `onUpdate()` is the shipped path (`IrrigationZoneCard.tsx:140-141`); the manual script step 4 checks the device moves to the Unassigned grid |
| Operators delete devices on a live gateway before the redeploy lands | Task 9's explicit warning in the PR body |
| The cloud carries the same bug and diverges | Task 12 checks and files, without widening this plan's diff |

## Deliberately out of scope

- Any backend, `flows.json`, schema or sync change.
- Moving `StregaValveCard` onto the shared hook (Task 11).
- Move-to-another-zone UX (Task 10).
- Deleting the now-unused `kiwiSensor.remove*` / `sdi12Soil.remove*` locale keys.
- Fixing the cloud (Task 12 files an issue only).

## Open questions for Phil

1. **Farm-context copy.** Is "This will unlink the device from your account and delete its stored readings." the wording you want? Today `LoRainGaugeCard` and `SenseCapWeatherCard` already say readings are deleted while `KiwiSensorCard` and `Sdi12SoilCard` mention only the account. The proposed shared string is the honest union — confirm before it lands in 7 locales.
2. **Luganda.** Twelve new `deviceRemoval.*` keys plus the existing untranslated `lg` `stregaValve.removeSubtitleZone` need a human Luganda pass. Who does it, and should the plan land with flagged placeholders or block on the translation?
3. **Move UX priority.** Given that `ZoneDeviceModal` forces unassign-then-assign, is a direct "Move to another zone…" worth scheduling right after this, or does working unassign settle it for now?
4. **Deploy order.** Silvan then Uganda, or Uganda first given that its operators are the ones hitting this?
