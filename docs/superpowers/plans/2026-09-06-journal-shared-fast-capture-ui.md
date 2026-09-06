# Journal Shared Fast Capture UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the reduced cloud Journal modal with the edge interaction model, make capture fast and spacious, and preserve authority-specific features honestly.

**Architecture:** Shared pure modules and copy-adapted capture components depend on a typed `JournalCaptureAdapter`; they do not call transports. Edge local, cloud gateway-backed, and cloud-primary adapters supply authority behavior and capability flags. A container-responsive shell presents the same sequential/two-pane/three-pane workflow on both products.

**Tech Stack:** React, TypeScript, Vite, Vitest, Testing Library, i18next, CSS/container queries, axe-compatible accessibility tests.

**Spec:** [Journal Edge/Cloud Parity and Fast Capture](../specs/2026-09-06-journal-edge-cloud-parity-and-fast-capture-design.md), especially §§3.1, 3.3, 3.5, 4.1, 4.2, 4.6, 5, 7 and 9.1.

## Global Constraints

- Edge `JournalCaptureFlow` is the behavioral reference, not a visual file copied without tests.
- Keep explicit provenance for copy-adapted modules according to existing cloud conventions.
- Cloud-primary keeps attachments/conflict resolution; gateway-backed capture has neither attachments nor optimistic canonical saves.
- Default both products to `farmer_quick`; normalize legacy `research_observation` to `full_record`.
- Keep grey Journal background with white fields and Data-tab typography/tokens. Do not restore the Status selector, duplicate headers, dashboard/refresh controls, or Export research package button.
- Capture code is lazy-loaded. Partial data failures have local retry states and do not blank the page.
- All strings use the Journal namespace in every shipped locale.
- Test behavior first, including keyboard, reflow, focus, and deterministic activation ceilings.

---

### Task 1: Define and prove the adapter boundary

**Files:**
- Add shared adapter types and contract tests in edge `web/react-gui/src/journal/` and cloud `frontend/src/journal/` using the existing provenance convention.
- Modify edge `services/journalApi.ts` and cloud journal service/types.
- Modify capture hooks only after adapter contract tests fail.

**Interface:** `JournalCaptureAdapter` supplies plot/group listing and revalidation, optional resource creation, draft load/save/discard, single/atomic batch save, duplicate lookup/navigation, crop-cycle lookup/correction, recents/carry-forward, receipt lookup, and explicit capability flags.

- [ ] Write one semantic fixture suite and run it against edge-local, cloud gateway-backed, and cloud-primary fake adapters.
- [ ] Assert authority boundaries: no edge-owned plot mutation from cloud-primary, no draft/per-keystroke edge command, no attachment capability gateway-backed, and no confirmed receipt for pending commands.
- [ ] Implement typed result/error unions for partial loading, validation, pending/rejected/unknown receipt, and stale-scope outcomes. Avoid booleans that erase state.
- [ ] Refactor edge capture transport calls behind its local adapter without changing behavior. Run existing edge capture tests.
- [ ] Implement cloud adapters over normalized service functions and backend contracts from the first two plans.
- [ ] Commit edge/cloud adapter slices as `refactor: isolate journal capture authority`.

### Task 2: Port the full capture behavior and fix template preference

**Files:**
- Modify edge `web/react-gui/src/components/journal/capture/JournalCaptureFlow.tsx` and its component/helper tests.
- Replace/rework cloud `frontend/src/components/journal/capture/JournalCaptureModal.tsx` with copy-adapted shared capture components.
- Modify cloud `frontend/src/journal/entryPayload.ts` and tests.
- Port/refactor Where components (`PlotPicker`, `StationGrid`, `PlotGroupChips`), activity picker, details, review, duplicate, draft, cycle, batch, and confirmation components.

- [ ] Add a cross-repo template fixture proving every preference/support combination resolves identically and that no preference defaults cloud to `full_record`.
- [ ] Add behavior tests for station/group/plot selection, range/all station selection, mixed-layout rejection, activity shortlist/search/browse fallback, drafts, carry-forward provenance agreement, duplicate review, cycle choice/split/remove, tank mix, batch confirmation, and final receipt.
- [ ] Change `resolveCaptureDefinitions` to the shared order `farmer_quick` → `full_record` → `research_observation`; remove cloud's full-record pin.
- [ ] Port shared pure modules first, then components in small test-backed commits. Preserve explicit cloud-only extension slots instead of branching the shared flow.
- [ ] Remove the six-item reference discovery cap; compact summary can retain examples, but View all opens the shared station/group/plot browser with ST72 and ST12 sections.
- [ ] Add Drafts / Needs completion and Waiting for farm trays with visible counts, resume/discard/receipt actions, and no general Status filter.
- [ ] Commit as `feat: align cloud journal capture with edge`.

### Task 3: Build the responsive desktop capture shell

**Files:**
- Modify shared/copy-adapted capture shell components and Journal workspace styles.
- Modify `web/react-gui/src/components/journal/JournalWorkspace.tsx` and cloud `frontend/src/pages/JournalPage.tsx` only as needed to provide the 1600px content container.
- Add geometry tests and visual fixtures in each frontend's existing test locations.

- [ ] Add failing geometry tests at content widths 1024, 1280, 1440, and 1600px plus 200% zoom/reflow.
- [ ] Assert below 1100px is the ordered Where → Activity → Details → Review flow; 1100–1399px is main + 320px sticky Review; at least 1400px is 280–340px Where + at least 520px main + 320px Review.
- [ ] Implement container-query layout bounded by the application 1600px maximum and usable viewport height. Keep Save/Close reachable and prevent sticky overlap/horizontal overflow.
- [ ] Place only blocking fields and populated safe defaults in the open form. Put optional groups under More details in the specified order; never collapse required controls.
- [ ] Keep grey workspace background, white fields/cards, and Data-tab font/color tokens on edge and cloud while preserving the already-approved background.
- [ ] Run geometry and screenshot checks at each fixture and commit as `feat: use full workspace for journal capture`.

### Task 4: Accessibility, resilience, and speed contract

**Files:**
- Modify capture grids, validation summary, disclosure, tray, and autosave/receipt announcement components.
- Add unit/component accessibility and activation-path tests.
- Modify locale JSON files in every shipped locale; run anti-slop checks for changed GUI copy.

- [ ] Add roving-tab tests: one Tab stop per plot/activity grid, arrows move active card, station range precedes plot grid.
- [ ] Add validation tests that render a linked error summary, open a collapsed optional group when targeted, and focus the first invalid control.
- [ ] Add `aria-live` tests for autosave, range counts, pending/applied/rejected receipts, retry results, and suppression of unchanged repeats.
- [ ] Add Escape/Close tests for volatile unsaved confirmation, durable-draft direct close, and focus restoration to the actual invoker with Journal heading fallback.
- [ ] Add local retry states for catalog, plot hierarchy, shortlist, recents, drafts, and groups. Assert a failed secondary request is not rendered as an empty authoritative list.
- [ ] Lazy-load capture-only code and cache catalog/plot hierarchy by version with invalidation after relevant mutation/sync.
- [ ] Pin the three activation paths from spec §7.1 at desktop/phone ceilings. Keep occurrence time prefilled and untouched; one valid carry-forward card takes one consequential confirmation.
- [ ] Run automated accessibility checks and all frontend unit/build gates. Record deterministic counts; do not claim human p75 without the required field-worker/research-technician pilot.
- [ ] Commit as `fix: polish journal capture accessibility and speed`.

### Task 5: Cross-repository drift prevention

- [ ] Extend existing provenance tests to every copied pure module and shared capture component.
- [ ] Add semantic parity fixtures for template resolution, field derivation, filters, adapter results, and receipt rendering.
- [ ] Run both suites with one intentional fixture mutation to prove drift detection, then restore it and rerun green.
- [ ] Run `git diff --check`, both frontend `npm run test:unit`, and both `npm run build`.
- [ ] Record edge/cloud commit SHAs and any explicitly unsupported capability before rollout integration.
