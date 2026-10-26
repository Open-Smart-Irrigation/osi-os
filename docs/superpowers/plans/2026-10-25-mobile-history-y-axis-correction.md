# Mobile history y-axis correction implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make accepted soil-water-tension values above 100 kPa visible in the mobile history chart.

**Architecture:** `MobileTensionHistory` must select the existing `ChartHost` automatic y-range mode, as `MobileSoilHistory` already does. Keep the adapter, API contracts, source limits, feature gates and performance budgets unchanged; the cloud receives the canonical edge package through the existing vendor sync.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, uPlot 1.6.32.

**Spec:** `docs/superpowers/plans/2026-10-24-mobile-history-real-data-slice-1.md`; root reproduction `/tmp/mobile-history-y-axis-review.mjs`.

## Global constraints

- Change one product prop: pass `yRange="auto"` from `MobileTensionHistory` to `ChartHost`.
- Do not change adapter range math, response normalization, APIs, flags, limits, benchmarks or chart geometry.
- Preserve null as unavailable and zero as a valid measured value.
- Edge remains canonical; cloud vendor bytes and provenance must be regenerated from the final edge commit.

## Review focus

- Accepted 150–151 kPa values reach the adapter with automatic range selection.
- The component test must fail before the prop change because the adapter options omit `yRange`, rather than passing through an isolated helper.
- Root also checks real-shell all-zero and all-null datasets, preserving measured zero and the empty-range recovery action.
- The real mobile shell/uPlot check must show the high-valued series, without a standalone harness manually supplying `auto`.
- Cloud resync must alter only canonical vendor bytes and the origin manifest; its lockfile and application code remain unchanged.

---

### Task 1: Select automatic range in the canonical mobile shell

**Files:**
- Modify: `web/history-uplot-core/src/mobile/MobileTensionHistory.tsx:350`
- Test: `web/history-uplot-core/tests/mobileTensionHistory.test.tsx`

**Interfaces:**
- Consumes: `ChartHostProps.yRange?: 'fixed-0-100' | 'auto'` and the existing `MountAdapter` fourth argument, `ChartRenderOptions`.
- Produces: every `MobileTensionHistory` mount calls its adapter with `options.yRange === 'auto'`.

- [x] **Step 1: Add the failing component regression**

  Add a test named `passes accepted high tension values to an auto-ranged chart`. Its load response contains finite accepted points/buckets at 150 and 151 kPa. Supply a spy `mountAdapter`, wait until its `setData` receives those values, and assert the adapter's fourth mount argument contains `{ yRange: 'auto' }`.

- [x] **Step 2: Prove the regression is red**

  Run from `web/history-uplot-core`:

  ```bash
  npm test -- mobileTensionHistory.test.tsx -t "passes accepted high tension values to an auto-ranged chart"
  ```

  Expected: FAIL because the mount options contain `yRange: undefined`; the high values must already reach `setData`.

- [x] **Step 3: Apply the minimal shell fix**

  Add `yRange="auto"` to the existing `ChartHost` in `MobileTensionHistory.tsx`. Do not change `ChartHost`, `mountUplot`, `autoYRange` or their defaults.

- [x] **Step 4: Verify the focused and canonical package gates**

  ```bash
  npm test -- mobileTensionHistory.test.tsx
  npm test
  npm run build
  ```

  Expected: the new regression and the complete canonical package pass. Review the existing adapter range coverage for null, zero and high finite values; add no duplicate adapter test unless that coverage is absent.

- [x] **Step 5: Verify the real shell rendering**

  Root runs the mobile route with accepted 150–151 kPa fixture data through the real shell and uPlot adapter. Record that the plotted y range includes both values and that the series is visible. The evidence must rely on the shell prop; do not pass `auto` manually in the browser harness.

- [x] **Step 6: Commit the edge correction**

  Commit only the component, its regression and this reviewed plan/report material after the focused and required host gates pass.

### Task 2: Resync the canonical package to cloud

**Files:**
- Modify: `frontend/vendor/history-uplot-core/src/mobile/MobileTensionHistory.tsx`
- Modify: `frontend/vendor/history-uplot-core/tests/mobileTensionHistory.test.tsx`
- Modify: `frontend/vendor/history-uplot-core-origin.json`

**Interfaces:**
- Consumes: the final edge correction commit from Task 1.
- Produces: a cloud vendor tree byte-identical to that edge package and a manifest pinned to its exact commit and hashes.

- [x] **Step 1: Run the existing vendor sync from the final edge commit**

  Use the repository's tracked sync command. Do not hand-edit vendored source or the manifest. Confirm `frontend/package-lock.json`, cloud application source, backend source and workflows are unchanged.

- [x] **Step 2: Verify provenance and behavior**

  Run both source and manifest verifier modes, the vendored focused test, canonical vendor tests/build, cloud host typecheck/build and the relevant real-shell browser case. Root verifies the cloud host with Node 20/npm 10, reruns both production mobile browser matrices for the changed chart rendering, and checks hosted PR gates. Do not repeat unrelated full backend suites or the unchanged prototype benchmark for this one-prop correction; their recorded source and fixtures are unchanged.

- [x] **Step 3: Commit and push cloud second**

  Commit the mechanical vendor resync and evidence after byte parity and all required gates pass. Preserve the established edge-first merge order and do not merge or deploy from this plan.

## Execution status

Both corrections are committed and pushed. Edge source commit `a86b01f6e96a5c7e3d11b2bad69b77410fee67f3` is pinned by cloud commit `be7dfea39867508a03a0fc57d53ea3881ca464f7`. Local verification passed; hosted checks were inspected and remain a merge gate. Cloud jobs could not start because of the GitHub account payment/spending-limit restriction. No merge or deployment was performed.
