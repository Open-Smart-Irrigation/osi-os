# React GUI Bug Fix & Quality Improvement Design

**Date:** 2026-04-15
**Scope:** `web/react-gui/src/` — frontend only
**Source:** Code review of osi-os React GUI (April 2026)

---

## Overview

Twelve targeted fixes to the React GUI, grouped into three priority tiers. Tier 1 addresses real bugs that corrupt UX state or crash at runtime. Tier 2 addresses type safety and defensive quality. Tier 3 addresses structural refactors and hygiene. Each tier is independently shippable.

Findings #4 (useMemo zones dependency) from the original review is **not in scope** — on closer inspection, `zones` is used in the early-return guard and removing it from deps would change loading behaviour.

---

## Tier 1 — Bugs

*Target: fix and ship independently. No structural changes.*

### Fix 1 — 401/AuthContext state desync (#2)

**Problem:** The axios response interceptor in `api.ts:60–63` calls `localStorage.removeItem('auth_token')` on 401, but never updates React state. `AuthContext` holds `isAuthenticated: true` in memory until the page is refreshed.

**Fix:**
- In `api.ts` interceptor: dispatch `window.dispatchEvent(new CustomEvent('auth:expired'))` on 401, after clearing localStorage.
- In `AuthContext.tsx`: add a `useEffect` that registers a `window.addEventListener('auth:expired', ...)` listener and calls the context's own `logout()` on fire.
- `logout()` already nulls the React token state, making `isAuthenticated` false. The existing protected-route guard handles the `/login` redirect.
- No new dependencies. No callback threading through the module system.

**Files:** `web/react-gui/src/services/api.ts`, `web/react-gui/src/contexts/AuthContext.tsx`

---

### Fix 2 — KiwiSensorCard destructuring crash (#3)

**Problem:** `KiwiSensorCard.tsx:174` destructures `device.latest_data` directly. For newly registered devices that have not yet sent a LoRa uplink, the backend returns `latest_data: null`. This throws a `TypeError` at render time.

**Fix:**
- Update `Device.latest_data` in `farming.ts` from required (`latest_data: { ... }`) to optional/nullable (`latest_data?: { ... } | null`). This makes the type honest about the runtime contract.
- Fix `KiwiSensorCard.tsx:174`: guard the destructure with `device.latest_data ?? {}`.
- Audit all other `device.latest_data` access sites. `DraginoTempCard` and `SenseCapWeatherCard` already use optional chaining or `?? {}`; they will need minor type annotation updates but no logic changes.

**Files:** `web/react-gui/src/types/farming.ts`, `web/react-gui/src/components/farming/KiwiSensorCard.tsx`, minor updates to `DraginoTempCard.tsx`, `IrrigationZoneCard.tsx`, `environment/SoilTab.tsx`

---

### Fix 3 — Auth console.log cleanup (#1)

**Problem:** `AuthContext.tsx` contains 6 `console.log` calls that emit auth-sensitive information (token prefixes, usernames) in all environments.

**Fix:** Remove all 6 calls (lines 26, 30, 36, 38, 41, 51). No DEV-gating — there is nothing diagnostically valuable in these logs that justifies keeping them even in development.

**Files:** `web/react-gui/src/contexts/AuthContext.tsx`

---

### Fix 4 — Empty else block (#6)

**Problem:** `api.ts:45–46` contains a dead `} else { }` block in the request interceptor.

**Fix:** Delete the empty else block.

**Files:** `web/react-gui/src/services/api.ts`

---

## Tier 2 — Quality

*Target: type safety and defensive correctness. Builds on Tier 1; fixes within this tier are ordered by dependency.*

### Fix 5 — Shared error utility (#5)

**Problem:** `StregaValveCard.tsx:22` defines `getApiMessage(error, fallback)`. All other cards duplicate the same inline pattern with `catch (err: any)`, bypassing TypeScript's type safety.

**Fix:**
- Move `getApiMessage` to `web/react-gui/src/services/api.ts` as an exported function.
- Update its parameter from `any` to `unknown`.
- Update `StregaValveCard` to import from `api.ts`.
- Update `KiwiSensorCard` and `DraginoTempCard` to use the shared function, replacing inline `err.response?.data?.message || fallback` patterns.
- All catch parameters become `err: unknown`.

**Files:** `web/react-gui/src/services/api.ts`, `web/react-gui/src/components/farming/StregaValveCard.tsx`, `KiwiSensorCard.tsx`, `DraginoTempCard.tsx`

---

### Fix 6 — `.map()` crash guard (#8)

**Problem:** `irrigationZonesAPI.getAll()` and two `dendroAPI` methods call `.map(normalise*)` directly on `response.data`. If Node-RED returns a 200 with unexpected JSON (possible on a restarting device), `.map()` throws.

**Fix:** Wrap each call with an `Array.isArray` guard:
```ts
return Array.isArray(response.data) ? response.data.map(normaliseZone) : [];
```
Three sites in `api.ts`: `irrigationZonesAPI.getAll()` (line 195), and two `dendroAPI` methods (lines 421, 425).

**Files:** `web/react-gui/src/services/api.ts`

---

### Fix 7 — Dual naming fields in types (#9)

**Problem:** `IrrigationSchedule` has both `response_mode?` and `responseMode?`. `IrrigationZone` has 8 pairs of snake_case/camelCase alias fields. The normaliser in `api.ts` already maps all input variants to camelCase on output; the type definitions should reflect the canonical post-normalisation shape.

**Fix:**
- Remove `response_mode` from `IrrigationSchedule`. Keep `responseMode` as the sole canonical field.
- Remove all snake_case alias fields from `IrrigationZone`: `gateway_device_eui`, `phenological_stage`, `crop_type`, `soil_type`, `irrigation_method`, `area_m2`, `irrigation_efficiency_pct`, `scheduling_mode`, `calibration_key`, and `variety_compat`. Keep only the camelCase equivalents.
- The normaliser functions continue to accept both input conventions; only the output type is cleaned up.
- Update any component code that reads snake_case fields directly — a TypeScript compile pass will identify all sites.

**Files:** `web/react-gui/src/types/farming.ts`, `web/react-gui/src/services/api.ts`, any component files flagged by the compiler

---

## Tier 3 — Refactor

*Target: structural improvements and hygiene. Safe to defer or stop after any individual fix.*

### Fix 8 — `useClickOutside` hook (#7)

**Problem:** An identical `useEffect` that listens for `mousedown` on `document` to close a panel is duplicated across `KiwiSensorCard`, `StregaValveCard`, and `DraginoTempCard`. It omits `touchstart`, breaking the close-on-outside-tap behaviour on mobile.

**Fix:**
- Create `web/react-gui/src/hooks/useClickOutside.ts`.
- Hook signature: `useClickOutside(ref: RefObject<HTMLElement | null>, onClose: () => void): void`
- Listens for both `mousedown` and `touchstart` on `document`. Cleans up both listeners on unmount.
- Replace the duplicated `useEffect` in all three ConfigPanel components with a single `useClickOutside(ref, onClose)` call.

**Files:** `web/react-gui/src/hooks/useClickOutside.ts` (new), `KiwiSensorCard.tsx`, `StregaValveCard.tsx`, `DraginoTempCard.tsx`

---

### Fix 9 — Normaliser `any` types (#10)

**Problem:** All five `normalise*` functions in `api.ts` take `any` as their input parameter. Field access on `any` is unchecked — if the backend renames a field, the normaliser silently drops it.

**Fix:** Change input parameters from `any` to `unknown`. Replace direct property access (`z.field`) with safe access (`(z as Record<string, unknown>).field ?? null`). No schema generation. This is a progressive tightening pass — TypeScript will now flag any normaliser that directly accesses properties on its input without a cast.

**Files:** `web/react-gui/src/services/api.ts`

---

### Fix 10 — JSX duplication (#11)

**Problem:** Remove device confirm UI, "last seen" display, and ConfigPanel shell are duplicated across `KiwiSensorCard`, `StregaValveCard`, and `DraginoTempCard`.

**Fix:** Create `web/react-gui/src/components/farming/shared/`:

| Component | Props | Replaces |
|-----------|-------|---------|
| `RemoveDeviceConfirm.tsx` | `onConfirm`, `onCancel`, `isRemoving`, `error` | Inline remove/confirm pattern in all three cards |
| `LastSeen.tsx` | `lastSeen: string \| null \| undefined` | Inline "X minutes ago" calculation and display |
| `ConfigPanelShell.tsx` | `onClose`, `children` | Positioned wrapper div + `useClickOutside` call |

Update all three device cards to use the shared components. Device-specific ConfigPanel content remains in each card file.

**Files:** 3 new files in `shared/`, updates to `KiwiSensorCard.tsx`, `StregaValveCard.tsx`, `DraginoTempCard.tsx`

---

### Fix 11 — i18n gaps (#12)

**Problem:** Specific hardcoded strings in the review are not going through `useTranslation`.

**Fix:** Audit exactly the strings identified in the review:
- `☁ OSI Server` — `FarmingDashboard.tsx`
- "Delay irrigation", "Irrigate today" — `IrrigationZoneCard.tsx`
- "Dendro active", "Dragino LSN50 Nodes" — dendro section

For each: check the relevant i18n namespace JSON for an existing key; add missing keys; replace the hardcoded string with `t('key')`. Scope is limited to these strings only — no broad i18n audit.

**Files:** `FarmingDashboard.tsx`, `IrrigationZoneCard.tsx`, `web/react-gui/public/locales/{locale}/dashboard.json` and `devices.json` for all 7 locales (en, de-CH, fr, es, it, lg, pt)

---

### Fix 12 — TypeScript snake_case/camelCase cleanup (#13)

**Problem:** After Fix 7 removes snake_case alias fields from the types, any component that was reading those fields directly will fail to compile.

**Fix:** Run a TypeScript compile pass. Update all flagged access sites to use the camelCase equivalents. This is primarily a verification step — Fix 7 does the structural change; this fix resolves any remaining access sites the compiler surfaces.

**Files:** Any component files flagged by `tsc` after Fix 7

---

## Implementation Order Summary

| # | Fix | Tier | Files |
|---|-----|------|-------|
| 1 | 401/AuthContext desync | 1 | `api.ts`, `AuthContext.tsx` |
| 2 | KiwiSensorCard crash + type | 1 | `farming.ts`, `KiwiSensorCard.tsx`, minor others |
| 3 | Auth console.log cleanup | 1 | `AuthContext.tsx` |
| 4 | Empty else block | 1 | `api.ts` |
| 5 | Shared error utility | 2 | `api.ts`, 3 card files |
| 6 | `.map()` crash guard | 2 | `api.ts` |
| 7 | Dual naming fields in types | 2 | `farming.ts`, `api.ts`, component files |
| 8 | `useClickOutside` hook | 3 | `hooks/useClickOutside.ts`, 3 card files |
| 9 | Normaliser `any` types | 3 | `api.ts` |
| 10 | JSX duplication | 3 | 3 new shared files, 3 card files |
| 11 | i18n gaps | 3 | `FarmingDashboard.tsx`, `IrrigationZoneCard.tsx`, i18n JSON |
| 12 | Type snake_case cleanup | 3 | Component files flagged by `tsc` |

---

## Constraints

- No changes to Node-RED flows (`flows.json`) — all fixes are frontend-only.
- No new npm dependencies — `useClickOutside` is a plain React hook, not a library import.
- Each tier is independently deployable. Stop after Tier 1 or Tier 2 if time is short.
- Fix 12 cannot begin until Fix 7 is complete (it depends on the type changes).
- Fix 10 should follow Fix 8 (ConfigPanelShell uses `useClickOutside`).
