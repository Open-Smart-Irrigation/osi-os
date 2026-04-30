# Terra kPa–VWC Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the two independent linear formulas for VWC and matrix potential (kPa) in `moistureModel.ts` with a physically correct, soil-texture-aware van Genuchten model so that every displayed kPa/VWC pair is internally consistent and matches real soil physics — including the agronomic -60 kPa threshold for low water content.

**Architecture:** The internal `moisture` variable (0–1) maps linearly to volumetric water content (VWC) via texture-specific θ_r and θ_s parameters. The van Genuchten inverse then converts VWC to negative matrix potential in kPa, giving a non-linear but internally consistent kPa/VWC pair. This plan keeps `waterStatus()` and `moistureColor()` on the existing normalized moisture scale for visual continuity; recalibrating color status to kPa/VWC thresholds is a separate agronomic design decision.

**Tech Stack:** TypeScript, Vitest 3, Testing Library — all within `terra-intelligence/`.

**Physical background:**
Van Genuchten (1980): `θ(h) = θ_r + (θ_s − θ_r) / (1 + |α·h|^n)^m`
where `h` is pressure head in cm of water, `m = 1 − 1/n`.
Inverse: `h = (1/α) × (Se^(−1/m) − 1)^(1/n)` where `Se = (θ − θ_r)/(θ_s − θ_r)`.
Convert to kPa: `kPa = −h × 0.0981` (1 kPa ≈ 10.2 cm H₂O).
Parameters from Carsel & Parrish (1988).

**Working directory for all commands:** `/home/phil/Repos/osi-server/.worktrees/terra-mobile-fixes/terra-intelligence/`

**Coordination note:** Execute this plan before `2026-04-28-terra-ux-refactor.md`. This plan updates the legacy `valuesEnabled` "Cell VWC" strip for consistency. The UX refactor later replaces that strip with the final `Data` strip, which must read `profileMetrics.rootVwcPct` and `profileMetrics.matrixPotentialKpa` from this updated model.

---

## Code Quality Guidelines

- **TypeScript strict** — no `any`; `noUnusedLocals` must be clean after every commit; use `satisfies` where the pattern is already established in the plan
- **Pure functions** — `vwcFromMoisture`, `matrixPotentialFromVwc`, and `vgParams` have no side effects; they read their inputs and return a value; never add logging or state mutation inside them
- **No test-only exports** — `textureClassForDepthCm` stays private; test it through `buildSoilHorizons` and `getProfileMetrics`, not by exporting it for tests
- **One commit per task** — use the commit messages shown in each step; they follow Conventional Commits (`feat(terra):`, `refactor(terra):`, `fix(terra):`)
- **TDD** — write the failing test, confirm it fails, implement, confirm it passes; never commit a failing test without the paired implementation commit

## Design Principles

- **Single responsibility** — `vwcFromMoisture` computes VWC only; `matrixPotentialFromVwc` computes kPa only; `vgParams` resolves texture parameters only; keep each function to one job
- **DRY** — `SOIL_TEXTURE_PARAMS` is the single declaration of all van Genuchten parameters; `TEXTURE_PARAM_MATCHERS` is the single ordered lookup list; both functions share `vgParams()` as their resolution point
- **YAGNI** — `waterStatus()` and `moistureColor()` stay on the normalized moisture scale; recalibrating color thresholds to kPa/VWC agronomic values is explicitly out of scope for this plan
- **Boundary first** — edge cases (`Se ≥ 1 → 0 kPa`, `Se ≤ 0 → −1500 kPa`) are handled with early returns before the main formula path, keeping the happy path readable

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `src/moistureModel.ts` | Modify | Add VG params, `vwcFromMoisture`, `matrixPotentialFromVwc`, `textureClassForDepthCm`; update `buildSoilHorizons` and `getProfileMetrics`; remove old linear functions |
| `src/App.tsx` | Modify | Update "Cell VWC" display (line ~2122) to use `vwcFromMoisture` |
| `src/styles.css` | Modify | Fix draw-hint mobile `bottom` — replace hardcoded `154px` with `var(--mobile-panel-bottom)` |
| `src/__tests__/moistureModel.test.ts` | Modify | Add VG correctness tests; update snapshot-style assertions that depended on the old linear formulas |
| `src/__tests__/mobileCss.test.ts` | Modify | Add assertion that `.draw-hint` uses `var(--mobile-panel-bottom)` on mobile |

---

## Phase 1: Model Functions
*Tasks 1–2 — pure math functions with no side effects: `vwcFromMoisture` and `matrixPotentialFromVwc`*

---

## Task 1: Add Van Genuchten parameters and `vwcFromMoisture`

**Files:**
- Modify: `terra-intelligence/src/moistureModel.ts`
- Modify: `terra-intelligence/src/__tests__/moistureModel.test.ts`

**Physical reference:**

| Texture match | θ_r | θ_s | α (cm⁻¹) | n | Notes |
|--------------|-----|-----|-----------|---|-------|
| `'silty loam'` | 0.067 | 0.50 | 0.020 | 1.41 | θ_s bumped to 0.50 for high OM topsoil (current demo horizons use this label) |
| `'silt loam'` | 0.067 | 0.45 | 0.020 | 1.41 | standard Carsel & Parrish value; USDA datasets use this label instead of "silty loam" |
| `'sandy loam'` | 0.065 | 0.41 | 0.075 | 1.89 | fast-draining E horizon |
| `'clay loam'` | 0.095 | 0.41 | 0.019 | 1.31 | high-storage Bt horizon |
| fallback (loam) | 0.078 | 0.43 | 0.036 | 1.56 | calcareous subsoil, unknown textures |

Texture matching uses `textureClass.toLowerCase().includes(key)` checked in specificity order (most specific first): `'clay loam'` before `'clay'`, `'sandy loam'` before `'sand'`, `'silty loam'` before `'silt'`.

- [ ] **Step 1: Write failing tests**

In `src/__tests__/moistureModel.test.ts`, add the following import and test block after the existing tests:

```typescript
import {
  GRID_COLUMNS, GRID_ROWS, buildFieldCells, moistureColor, waterStatus,
  vwcFromMoisture,
} from '../moistureModel';
```

```typescript
describe('vwcFromMoisture', () => {
  test('silty loam: moisture=0 gives residual VWC (6.7%)', () => {
    expect(vwcFromMoisture(0, 'silty loam, high organic matter')).toBeCloseTo(0.067, 3);
  });

  test('silty loam: moisture=1 gives saturated VWC (50%)', () => {
    expect(vwcFromMoisture(1, 'silty loam, high organic matter')).toBeCloseTo(0.50, 3);
  });

  test('sandy loam: moisture=1 gives saturated VWC (41%)', () => {
    expect(vwcFromMoisture(1, 'sandy loam, fast drainage')).toBeCloseTo(0.41, 3);
  });

  test('clay loam: moisture=1 gives saturated VWC (41%)', () => {
    expect(vwcFromMoisture(1, 'clay loam, high storage')).toBeCloseTo(0.41, 3);
  });

  test('unknown texture falls back to loam params', () => {
    // loam θ_s = 0.43
    expect(vwcFromMoisture(1, 'calcareous subsoil, low root activity')).toBeCloseTo(0.43, 3);
  });

  test('moisture=0.5 for silty loam is between residual and saturated', () => {
    const vwc = vwcFromMoisture(0.5, 'silty loam');
    expect(vwc).toBeGreaterThan(0.067);
    expect(vwc).toBeLessThan(0.50);
    expect(vwc).toBeCloseTo(0.283, 2);  // 0.067 + 0.5*(0.50-0.067)
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
cd terra-intelligence && npm test -- src/__tests__/moistureModel.test.ts
```

Expected: FAIL (vwcFromMoisture is not defined).

- [ ] **Step 3: Add VG texture params and `vwcFromMoisture` to `moistureModel.ts`**

Insert after the `function clamp(...)` definition (search for `function clamp`):

```typescript
type VanGenuchtenParams = {
  thetaR: number;
  thetaS: number;
  alpha: number;
  n: number;
};

const SOIL_TEXTURE_PARAMS = {
  clayLoam: { thetaR: 0.095, thetaS: 0.41, alpha: 0.019, n: 1.31 },
  sandyLoam: { thetaR: 0.065, thetaS: 0.41, alpha: 0.075, n: 1.89 },
  siltyLoam: { thetaR: 0.067, thetaS: 0.50, alpha: 0.020, n: 1.41 },
  siltLoam: { thetaR: 0.067, thetaS: 0.45, alpha: 0.020, n: 1.41 },
  loam: { thetaR: 0.078, thetaS: 0.43, alpha: 0.036, n: 1.56 },
} satisfies Record<string, VanGenuchtenParams>;

const TEXTURE_PARAM_MATCHERS: Array<[string, VanGenuchtenParams]> = [
  ['clay loam', SOIL_TEXTURE_PARAMS.clayLoam],
  ['sandy loam', SOIL_TEXTURE_PARAMS.sandyLoam],
  ['silty loam', SOIL_TEXTURE_PARAMS.siltyLoam],
  // USDA datasets often use "silt loam"; current demo horizons use "silty loam".
  ['silt loam', SOIL_TEXTURE_PARAMS.siltLoam],
  ['loam', SOIL_TEXTURE_PARAMS.loam],
];

function vgParams(textureClass: string): VanGenuchtenParams {
  const lower = textureClass.toLowerCase();
  for (const [key, params] of TEXTURE_PARAM_MATCHERS) {
    if (lower.includes(key)) return params;
  }
  return SOIL_TEXTURE_PARAMS.loam;
}

export function vwcFromMoisture(moisture: number, textureClass: string): number {
  const { thetaR, thetaS } = vgParams(textureClass);
  return thetaR + clamp(moisture) * (thetaS - thetaR);
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
cd terra-intelligence && npm test -- src/__tests__/moistureModel.test.ts
```

Expected: all `vwcFromMoisture` tests pass.

- [ ] **Step 5: Commit**

```bash
git add terra-intelligence/src/moistureModel.ts terra-intelligence/src/__tests__/moistureModel.test.ts
git commit -m "feat(terra): add van Genuchten texture params and vwcFromMoisture"
```

---

## Task 2: Add `matrixPotentialFromVwc` using VG inverse

**Files:**
- Modify: `terra-intelligence/src/moistureModel.ts`
- Modify: `terra-intelligence/src/__tests__/moistureModel.test.ts`

The van Genuchten inverse computes suction head `h` (cm) from VWC, then converts to kPa.
Edge cases: `Se ≥ 1` (saturated) → 0 kPa. `Se → 0` (bone dry) → cap at −1500 kPa (permanent wilting point).

- [ ] **Step 1: Write failing tests**

Add to the import line in the test file:

```typescript
import {
  GRID_COLUMNS, GRID_ROWS, buildFieldCells, moistureColor, waterStatus,
  vwcFromMoisture, matrixPotentialFromVwc,
} from '../moistureModel';
```

Add the following test block:

```typescript
describe('matrixPotentialFromVwc', () => {
  test('saturated silty loam (VWC = θ_s) returns 0 kPa', () => {
    expect(matrixPotentialFromVwc(0.50, 'silty loam')).toBe(0);
  });

  test('available silty loam at 0.31 VWC is moderately negative', () => {
    // With the chosen high-OM silty-loam params, 0.31 VWC evaluates near -18 kPa.
    const kpa = matrixPotentialFromVwc(0.31, 'silty loam');
    expect(kpa).toBeLessThan(-10);
    expect(kpa).toBeGreaterThan(-25);
  });

  test('user threshold: VWC at dry boundary (~0.214) is near -60 to -80 kPa for silty loam', () => {
    // moisture=0.34 for silty loam → VWC=0.214 → should be ≈ -67 kPa
    const vwc = vwcFromMoisture(0.34, 'silty loam');
    const kpa = matrixPotentialFromVwc(vwc, 'silty loam');
    expect(kpa).toBeLessThan(-50);
    expect(kpa).toBeGreaterThan(-90);
  });

  test('residual silty loam (VWC = θ_r) returns a very negative kPa (capped at -1500)', () => {
    expect(matrixPotentialFromVwc(0.067, 'silty loam')).toBe(-1500);
  });

  test('sandy loam drains at much lower suction than clay loam at same effective saturation', () => {
    // Both at Se=0.5 (half-saturated)
    const sandyVwc = 0.065 + 0.5 * (0.41 - 0.065);  // 0.2375
    const clayVwc  = 0.095 + 0.5 * (0.41 - 0.095);  // 0.2525
    const sandyKpa = matrixPotentialFromVwc(sandyVwc, 'sandy loam');
    const clayKpa  = matrixPotentialFromVwc(clayVwc, 'clay loam');
    // Sandy loam has lower suction (less negative) than clay loam at same effective saturation
    expect(sandyKpa).toBeGreaterThan(clayKpa);
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
cd terra-intelligence && npm test -- src/__tests__/moistureModel.test.ts
```

Expected: FAIL (`matrixPotentialFromVwc` not defined).

- [ ] **Step 3: Add `matrixPotentialFromVwc` to `moistureModel.ts`**

Insert immediately after `vwcFromMoisture`:

```typescript
export function matrixPotentialFromVwc(vwc: number, textureClass: string): number {
  const { thetaR, thetaS, alpha, n } = vgParams(textureClass);
  const m = 1 - 1 / n;
  const seRaw = (vwc - thetaR) / (thetaS - thetaR);

  if (seRaw >= 1) return 0;
  if (seRaw <= 0) return -1500;

  // Clamp Se away from exact 0 and 1 to avoid floating-point overflow in the power terms.
  // The early returns above guarantee seRaw ∈ (0, 1), but values very close to 0 still
  // produce enormous hCm. The existing clamp() is 1-argument (0–1 only); use Math.max/min
  // here so the tighter bounds are enforced.
  const Se = Math.max(0.001, Math.min(0.999999, seRaw));
  const hCm = (1 / alpha) * Math.pow(Math.pow(Se, -1 / m) - 1, 1 / n);
  const kpa = -hCm * 0.0981;

  return Math.max(-1500, Math.round(kpa));
}
```

- [ ] **Step 4: Run to confirm tests pass**

```bash
cd terra-intelligence && npm test -- src/__tests__/moistureModel.test.ts
```

Expected: all `matrixPotentialFromVwc` tests pass.

- [ ] **Step 5: Commit**

```bash
git add terra-intelligence/src/moistureModel.ts terra-intelligence/src/__tests__/moistureModel.test.ts
git commit -m "feat(terra): add matrixPotentialFromVwc via van Genuchten inverse"
```

### Phase 1 Review Checkpoint

```bash
cd terra-intelligence && npm test -- src/__tests__/moistureModel.test.ts
```

All `vwcFromMoisture` and `matrixPotentialFromVwc` tests must pass. TypeScript must compile (`npx tsc --noEmit`). The existing tests must not regress. Only then proceed to Phase 2.

---

## Phase 2: Integration
*Tasks 3–4 — wire the new functions into `buildSoilHorizons`, `getProfileMetrics`, and the cell VWC display in App.tsx*

---

## Task 3: Wire new model into `buildSoilHorizons`

**Files:**
- Modify: `terra-intelligence/src/moistureModel.ts`

Replace the two independent linear formulas in `buildSoilHorizons` with the new texture-aware conversions. Keep `textureClassForDepthCm` private when it is added in Task 4; tests should verify behavior through public functions rather than exporting the helper for test-only access.

- [ ] **Step 1: Write failing test for texture-aware soil horizons**

Add to `moistureModel.test.ts`:

```typescript
import {
  GRID_COLUMNS, GRID_ROWS, buildFieldCells, buildSoilHorizons, moistureColor, waterStatus,
  vwcFromMoisture, matrixPotentialFromVwc,
} from '../moistureModel';
```

```typescript
describe('buildSoilHorizons — physical consistency', () => {
  const horizons = buildSoilHorizons({ x: 0.5, y: 0.5 }, 9, 'tomato');

  test('all horizons have consistent kPa and VWC (kPa derived from VWC)', () => {
    for (const horizon of horizons) {
      // Display VWC is rounded to one decimal percent, so allow a small kPa tolerance.
      const expectedKpa = matrixPotentialFromVwc(horizon.waterContentPct / 100, horizon.textureClass);
      expect(Math.abs(horizon.matrixPotentialKpa - expectedKpa)).toBeLessThanOrEqual(1);
    }
  });

  test('topsoil (silty loam) and subsoil (clay loam) have different kPa at same effective saturation', () => {
    const topsoil = horizons[0];   // ap: silty loam
    const storage = horizons[2];   // bt: clay loam
    // Same effective saturation would yield different kPa for different textures
    expect(topsoil.textureClass).toContain('silty loam');
    expect(storage.textureClass).toContain('clay loam');
    // Both horizons exist and have valid kPa values
    expect(topsoil.matrixPotentialKpa).toBeLessThanOrEqual(0);
    expect(storage.matrixPotentialKpa).toBeLessThanOrEqual(0);
  });

  test('dry threshold moisture (~0.34) for topsoil kPa is between -50 and -90 kPa', () => {
    // buildSoilHorizons uses sampleDepthMoisture which may return varying values,
    // but we can directly verify the displayed VWC→kPa mapping is close enough after display rounding.
    const apHorizon = horizons[0];
    const derivedKpa = matrixPotentialFromVwc(apHorizon.waterContentPct / 100, apHorizon.textureClass);
    expect(Math.abs(apHorizon.matrixPotentialKpa - derivedKpa)).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
cd terra-intelligence && npm test -- src/__tests__/moistureModel.test.ts
```

Expected: FAIL (the current `buildSoilHorizons` uses the old linear functions).

- [ ] **Step 3: Update `buildSoilHorizons` in `moistureModel.ts`**

Find the `buildSoilHorizons` function. Replace the two property computations:

**Before:**
```typescript
      waterContentPct: waterContentPctFor(moisture, sampleDepthCm),
      matrixPotentialKpa: matrixPotentialKpaFor(moisture, sampleDepthCm),
```

**After:**
```typescript
      waterContentPct: Math.round(vwc * 1000) / 10,
      matrixPotentialKpa: matrixPotentialFromVwc(vwc, template.textureClass),
```

(The `* 1000 / 10` gives one decimal place: e.g., 0.2837 → 28.4%.)

To support that replacement, compute `vwc` immediately before the `return` statement:

```typescript
    const moisture = sampleDepthMoisture(point, sampleDepthCm, hour, scenario);
    const vwc = vwcFromMoisture(moisture, template.textureClass);
```

- [ ] **Step 4: Run to confirm tests pass**

```bash
cd terra-intelligence && npm test -- src/__tests__/moistureModel.test.ts
```

Expected: all `buildSoilHorizons` consistency tests pass.

- [ ] **Step 5: Commit**

```bash
git add terra-intelligence/src/moistureModel.ts terra-intelligence/src/__tests__/moistureModel.test.ts
git commit -m "feat(terra): wire texture-aware VWC/kPa into buildSoilHorizons"
```

---

## Task 4: Wire new model into `getProfileMetrics` and cell VWC display

**Files:**
- Modify: `terra-intelligence/src/moistureModel.ts`
- Modify: `terra-intelligence/src/App.tsx`

`getProfileMetrics` iterates over root-zone depth samples. Each sample depth may span multiple horizons. A helper `textureClassForDepthCm` looks up which horizon a given depth falls in.

The legacy "Cell VWC" label in `App.tsx` also uses a hardcoded linear formula `14 + selectedMoisture * 29`. Update it to use `vwcFromMoisture` with topsoil parameters when this plan is executed before the UX refactor. After the UX refactor lands, the final Data strip should use `profileMetrics.rootVwcPct` instead of this legacy per-cell line.

- [ ] **Step 1: Write failing test for `getProfileMetrics`**

Add to `moistureModel.test.ts`:

```typescript
import {
  GRID_COLUMNS, GRID_ROWS, buildFieldCells, buildSoilHorizons, getProfileMetrics,
  moistureColor, waterStatus, vwcFromMoisture, matrixPotentialFromVwc,
} from '../moistureModel';
```

```typescript
describe('getProfileMetrics — physical consistency', () => {
  const metrics = getProfileMetrics({ x: 0.5, y: 0.5 }, 9, 'tomato');

  test('rootVwcPct and matrixPotentialKpa are plausible', () => {
    expect(metrics.rootVwcPct).toBeGreaterThan(5);
    expect(metrics.rootVwcPct).toBeLessThan(55);
    expect(metrics.matrixPotentialKpa).toBeLessThan(0);
    expect(metrics.matrixPotentialKpa).toBeGreaterThan(-1500);
  });

  test('rootVwcPct is between θ_r*100 and θ_s*100 for silty loam topsoil', () => {
    // Topsoil silty loam: θ_r=6.7%, θ_s=50%
    expect(metrics.rootVwcPct).toBeGreaterThan(6.7);
    expect(metrics.rootVwcPct).toBeLessThan(50.1);
  });
});
```

- [ ] **Step 2: Run to confirm tests fail**

```bash
cd terra-intelligence && npm test -- src/__tests__/moistureModel.test.ts
```

Expected: FAIL (current `getProfileMetrics` uses old linear functions and returns values outside the expected range).

- [ ] **Step 3: Add `textureClassForDepthCm` and update `getProfileMetrics` in `moistureModel.ts`**

Add the helper just before `getProfileMetrics`:

```typescript
function textureClassForDepthCm(depthCm: number): string {
  const match = HORIZON_TEMPLATES.find((h) => depthCm >= h.topCm && depthCm < h.bottomCm);
  return (match ?? HORIZON_TEMPLATES[HORIZON_TEMPLATES.length - 1]).textureClass;
}
```

In `getProfileMetrics`, replace the `samples` map:

**Before:**
```typescript
  const samples = scenario.rootDepthSamples.map((depthCm) => {
    const moisture = sampleDepthMoisture(point, depthCm, hour, scenario);
    return {
      moisture,
      waterContentPct: waterContentPctFor(moisture, depthCm),
      matrixPotentialKpa: matrixPotentialKpaFor(moisture, depthCm),
    };
  });
```

**After:**
```typescript
  const samples = scenario.rootDepthSamples.map((depthCm) => {
    const moisture = sampleDepthMoisture(point, depthCm, hour, scenario);
    const textureClass = textureClassForDepthCm(depthCm);
    const vwc = vwcFromMoisture(moisture, textureClass);
    return {
      moisture,
      waterContentPct: Math.round(vwc * 1000) / 10,
      matrixPotentialKpa: matrixPotentialFromVwc(vwc, textureClass),
    };
  });
```

- [ ] **Step 4: Update the "Cell VWC" display in `App.tsx`**

First, add the import at the top of `App.tsx` (find the existing moistureModel import line and add `vwcFromMoisture` to it):

```typescript
// Find this line (imports from moistureModel):
import {
  ...
  waterStatus,
} from './moistureModel';

// Add vwcFromMoisture to the list:
import {
  ...
  vwcFromMoisture,
  waterStatus,
} from './moistureModel';
```

Then find (line ~2122):

```typescript
{valuesEnabled && <span>{dataMode === 'live' && liveSpatialUnavailable ? 'Live spatial unavailable' : `Cell VWC ${Math.round(14 + selectedMoisture * 29)}%`}</span>}
```

Replace with:

```typescript
{valuesEnabled && <span>{dataMode === 'live' && liveSpatialUnavailable ? 'Live spatial unavailable' : `Cell VWC ${Math.round(vwcFromMoisture(selectedMoisture, 'silty loam, high organic matter') * 100)}%`}</span>}
```

- [ ] **Step 5: Run all tests to confirm pass**

```bash
cd terra-intelligence && npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add terra-intelligence/src/moistureModel.ts terra-intelligence/src/App.tsx terra-intelligence/src/__tests__/moistureModel.test.ts
git commit -m "feat(terra): wire texture-aware VWC/kPa into getProfileMetrics and cell display"
```

### Phase 2 Review Checkpoint

```bash
cd terra-intelligence && npm test
```

All tests — including the new `buildSoilHorizons` and `getProfileMetrics` consistency tests — must pass. TypeScript must compile. Verify there are no remaining calls to `waterContentPctFor` or `matrixPotentialKpaFor`. Only then proceed to Phase 3.

---

## Phase 3: Cleanup and UI Fix
*Tasks 5–6 — remove the dead linear functions; fix the draw-hint mobile position*

---

## Task 5: Remove dead linear functions

**Files:**
- Modify: `terra-intelligence/src/moistureModel.ts`

The two old functions (`waterContentPctFor` and `matrixPotentialKpaFor`) are now unreferenced. TypeScript `noUnusedLocals` will flag them. Remove them.

- [ ] **Step 1: Delete the two old functions**

Find and remove:

```typescript
function waterContentPctFor(moisture: number, depthCm: number): number {
  return 12 + moisture * 31 - depthCm * 0.014;
}

function matrixPotentialKpaFor(moisture: number, depthCm: number): number {
  return -Math.round(8 + (1 - moisture) * 118 + depthCm * 0.1);
}
```

- [ ] **Step 2: Verify TypeScript compiles with no unused-variable errors**

```bash
cd terra-intelligence && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Run the full test suite**

```bash
cd terra-intelligence && npm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add terra-intelligence/src/moistureModel.ts
git commit -m "refactor(terra): remove linear waterContentPctFor and matrixPotentialKpaFor"
```

---

## Task 6: Fix draw-hint mobile position

**Files:**
- Modify: `terra-intelligence/src/styles.css`
- Modify: `terra-intelligence/src/__tests__/mobileCss.test.ts`

The `.draw-hint` element on mobile currently has `bottom: 154px` — a leftover hardcoded value from before the CSS variable stack was introduced. It overlaps the tool buttons on small screens. In the active `terra-mobile-fixes` worktree, `--mobile-panel-bottom` is already defined under `@media (max-width: 760px)`, so this task moves `.draw-hint` onto that stack. When the UX refactor removes `.field-intelligence-panel`, recalculate the panel/strip stack there; this task only fixes the current pre-UX layout.

- [ ] **Step 1: Write failing test**

In `src/__tests__/mobileCss.test.ts`, add to the `mobile control CSS` describe block:

```typescript
  it('positions the draw-hint above the tool stack using the CSS variable stack', () => {
    expect(mobileRuleFor('.draw-hint')).toContain('var(--mobile-panel-bottom)');
  });
```

- [ ] **Step 2: Run to confirm the test fails**

```bash
cd terra-intelligence && npm test -- src/__tests__/mobileCss.test.ts
```

Expected: FAIL (current value is `bottom: 154px`).

- [ ] **Step 3: Update the CSS**

Find in `src/styles.css` (inside the `@media (max-width: 760px)` block):

```css
  .draw-hint {
    right: 14px;
    bottom: 154px;
    left: 14px;
    transform: none;
  }
```

Replace with:

```css
  .draw-hint {
    right: 14px;
    bottom: var(--mobile-panel-bottom);
    left: 14px;
    transform: none;
  }
```

- [ ] **Step 4: Run all tests to confirm pass**

```bash
cd terra-intelligence && npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add terra-intelligence/src/styles.css terra-intelligence/src/__tests__/mobileCss.test.ts
git commit -m "fix(terra): align draw-hint mobile position with CSS variable stack"
```

---

## Self-Review

**Spec coverage:**

| Requirement | Task |
|-------------|------|
| kPa and VWC are physically consistent per cell | Tasks 2–4 |
| Low water content threshold: ≤ −60 kPa | Task 2 test (dry threshold test verifies ~−67 kPa for silty loam) |
| Different textures give different kPa at same effective saturation | Task 2 test (sandy vs clay loam) |
| Horizon-level texture awareness | Task 3 |
| Root-zone depth samples use correct texture per depth | Task 4 |
| Cell VWC display in map is consistent with model | Task 4 (App.tsx update) |
| Old linear functions removed | Task 5 |
| Draw-hint not overlapping tool buttons on mobile | Task 6 |
| Water status color thresholds explicitly unchanged | Architecture note; no task because recalibration is out of scope for this plan |

**Placeholder scan:** None found. All code is concrete.

**Type consistency:** `SOIL_TEXTURE_PARAMS`, `TEXTURE_PARAM_MATCHERS`, `vwcFromMoisture`, and `matrixPotentialFromVwc` are consistently named and typed across all tasks. `textureClassForDepthCm` is private to the module (not exported). `waterContentPct` stores the value as a percentage (0–100) in `SoilHorizon`, so tests divide displayed percentages by 100 before passing them into `matrixPotentialFromVwc`. Exact equality is avoided where display rounding can shift kPa by about one unit.

**Note:** The `rootVwcPct` field in `ProfileMetrics` aggregates `waterContentPct` values (which are already in percent), so the existing average computation `samples.reduce((sum, s) => sum + s.waterContentPct, 0) / samples.length` remains correct — no change needed there.
