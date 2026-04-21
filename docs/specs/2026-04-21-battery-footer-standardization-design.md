# Battery Footer Standardization Design

**Date:** 2026-04-21
**Scope:** `osi-os/web/react-gui/src/` and `osi-server/frontend/src/`
**Related issue:** `osi-os` issue #51

---

## Overview

Standardize the device-card footer in both `osi-os` and `osi-server` so every card shows the same bottom-right status treatment:

- `battery percentage · last seen` when a valid uplink battery percentage exists
- `last seen` only when no valid battery percentage exists

This feature also fixes the current `osi-server` S2120 bug where the existing battery footer renders `0%` instead of the real mirrored value.

The implementation must use the real uplink battery-percentage field (`bat_pct`) only. It must not derive fake percentages from battery voltage (`bat_v`).

---

## Current State

### `osi-os`

- `bat_pct` is already carried through the edge path for SenseCAP S2120.
- The S2120 flow decodes battery percentage from the Seeed uplink payload and stores it as `bat_pct`.
- `web/react-gui/src/components/farming/SenseCapWeatherCard.tsx` already shows `bat_pct` in the footer.
- Other current cards do not use a shared footer battery pattern.
- Existing non-S2120 battery UI is mostly voltage-based (`bat_v`) inside the card body.

### `osi-server`

- `frontend/src/services/api.ts` already maps `currentState['bat_pct']` into `latest_data.bat_pct`.
- `frontend/src/components/farming/SenseCapWeatherCard.tsx` already attempts to render `raw.bat_pct` in the footer.
- Other current cards still use last-seen-only footers and keep battery details in the card body.
- The reported S2120 `0%` symptom indicates the cloud UI needs stricter shared battery-percent normalization and rendering rules.

### Important distinction

In the current branches, `bat_pct` is clearly wired for S2120. Other currently implemented device paths mostly expose `bat_v`, not `bat_pct`. The feature must therefore be capability-based:

- show footer battery percentage only for cards whose latest uplink data actually contains a valid `bat_pct`
- do nothing for cards that only have battery voltage

This keeps the UI ready for future devices that later add `bat_pct` without requiring another design change.

---

## Goals

1. Make footer behavior consistent across all device cards in both repos.
2. Fix the `osi-server` S2120 footer so it no longer shows a bogus `0%`.
3. Ensure devices without battery percentage do not display fake or derived values.
4. Preserve existing `bat_v` displays and history affordances where they already exist.

---

## Non-Goals

- No conversion from `bat_v` to percentage.
- No backend schema redesign.
- No broad device-card shell refactor beyond what is needed for a shared footer treatment.
- No speculative support for device types whose decoders do not yet emit `bat_pct`.

---

## Proposed Approach

### 1. Add a shared battery-percent helper in each frontend

Create a small shared helper per repo that:

- reads the candidate battery percentage from the normalized/latest device payload
- converts it to a number safely
- accepts only finite values in the valid display range
- returns a normalized integer percentage for rendering, or `null` when invalid

Validation rules:

- reject `null`, `undefined`, empty strings, and `NaN`
- reject values below `0` or above `100`
- allow `0` only when it is a real value from the payload, not from fallback coercion
- round for display only after validation

The key point is to stop footer code from doing ad hoc `Number(...)` coercion inline.

### 2. Standardize footer rendering across all cards

Every device card in both repos should render the same footer shape:

- left side: keep existing contextual footer content when present
- right side: `battery icon + percent + separator + last seen` when valid `bat_pct` exists
- otherwise right side: just `last seen`

This applies to:

- `KiwiSensorCard`
- `StregaValveCard`
- `Dragino` card
- `SenseCapWeatherCard`
- any other current card that renders a bottom status/footer row

For cards that currently only render a last-seen strip, convert that strip to the shared footer pattern instead of adding a second footer.

### 3. Keep voltage-based battery UI separate

Cards that already show battery voltage in the body should continue to do so. Footer battery percentage is an additional capability, not a replacement for voltage-specific diagnostics.

This means:

- `bat_pct` drives the footer
- `bat_v` continues to drive any voltage tile/history UI

### 4. Fix `osi-server` S2120 through the shared path

Do not patch S2120 with a one-off conditional. Instead:

- have S2120 use the same shared battery helper as every other card
- read from the already mirrored/normalized battery field
- render nothing when the value is invalid or absent

This resolves the current bug and prevents the same class of bug on future devices.

---

## Data Rules

### Canonical display field

- `bat_pct` is the canonical battery-percentage field for footer rendering.

### Acceptable sources

- `osi-os`: `device.latest_data.bat_pct`
- `osi-server`: normalized `latest_data.bat_pct` and, where a card still reads raw state directly, the same helper should accept the normalized source used by that card

### Rejected sources

- derived percentages from `bat_v`
- hardcoded defaults
- coercion-based fallbacks that turn missing values into `0`

---

## UI Rules

### Footer content

When valid battery percent exists:

`🔋 {percent}% · {last seen label}`

When battery percent is absent/invalid:

`{last seen label}`

### Layout

- Use the existing bottom footer row for each card.
- Avoid creating duplicate last-seen displays.
- Keep the footer compact and consistent with the current visual language.

### Missing data behavior

- If a device has never been seen, keep the existing “never seen” behavior.
- If a device has no valid `bat_pct`, render no battery icon and no placeholder percentage.

---

## Testing

### `osi-os`

- Add or update tests for the battery-percent helper if a frontend test harness already exists for utility code.
- Extend `scripts/verify-sync-flow.js` only if needed to cover any new durable edge assumptions.
- Build verification: `cd web/react-gui && npm run build`

### `osi-server`

- Add tests around the normalization/rendering path so missing or invalid values do not become `0%`.
- Prefer focused tests on:
  - API normalization of `bat_pct`
  - shared battery helper behavior
  - S2120/footer rendering with valid, missing, and invalid percent values

### Manual verification

- Check one card with real `bat_pct` data.
- Check one card with only `bat_v`.
- Check one card with no battery information.

---

## Risks And Mitigations

### Risk: duplicate or inconsistent footer markup

**Mitigation:** use a shared helper and keep the footer pattern mechanically similar across cards.

### Risk: missing values render as `0%`

**Mitigation:** validate before rounding or formatting; never rely on `Number(value)` alone in JSX.

### Risk: future devices add `bat_pct` but only one repo shows it

**Mitigation:** make both repos follow the same rule now: any valid `bat_pct` should appear in the standardized footer.

---

## Implementation Summary

1. Add a battery-percent normalization helper in `osi-os` and `osi-server`.
2. Update all device cards in both repos to use the standardized footer pattern.
3. Keep `bat_v` body displays unchanged.
4. Add focused tests for normalization/rendering.
5. Verify both frontends build successfully.
