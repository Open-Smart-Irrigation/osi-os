# Field Journal Slice 2 — Phases 5–6 — MERGE-READINESS

**Date:** 2026-07-19
**Branch:** `design-sync/agrolink` (the kept AgroLink line — **off mainline by design**; do NOT merge to `main`)
**Final HEAD:** `e651ee2b`
**Range reviewed:** `c9eb4e3a..e651ee2b` (18 commits — Tasks 27–34 + review fixes + merges + one CI gate fix)
**Verdict:** ✅ **MERGE-READY** for this branch. Not pushed, not merged, no live gateway touched — a new explicit instruction is required to deploy.

---

## Scope delivered (Tasks 27–34)

| Task | Deliverable | Commit(s) |
|---|---|---|
| 27 | Catalog v2 (P4) via incremental **data** delta migration `0022` (0019 frozen); `parseTemplate` carry-forward guard | `022f8048` |
| 28 | Desktop shell + ScopeRail (`isDesktopBrowser()` branch, 72-plot station = 1 row) | `7aa013c5` |
| 29 | Keyset EntryTable + filter-scoped exports (+ honest scope-limitation notice, shared status-badge, stale export-error) | `02cb8e49`, `448d93f6` |
| 30 | DetailPanel read-back + void-with-reason + full-record correction (+ no-op-wipe & ownership fixes) | `fcfb2324`, `2afcbac2` |
| 31 | Persisted-draft discard contract (edge) + "Needs completion" queue | `dd829fc8` |
| 32 | Layout-transition review sheet finalize gate (+ empty-target silent-drop fix) | `b71a62bb`, `c80cb016` |
| 33 | History-owned journal markers + pure marker lane (+ chart-inset alignment, cap-test tighten) | `1c1a398f`, `78466215` |
| 34 | Locale completion (7 locales) + feed mirror + branding test | `4cff0b5a` |
| — | **CI gate fix**: `test:unit:vitest` now self-discovers all `src` test dirs (had silently excluded `journal/desktop` + `journal/markers`) | `a4431f2f` |
| — | Merges (33→32→31) into the branch | `91c95987`, `f79f7e0e`, `fdcbc0d9` |
| — | Final review fixes G1/G2/G3 (draft completion + Layout copy + product threading) | `5236d9a3`, `e651ee2b` |

## Gate evidence (at `e651ee2b`, independently re-run by the controller)

- **GUI unit:** `npm run test:unit` — tsx-runner **94/94**, vitest **150 files / 1402 tests, 0 failures**.
- **Typecheck:** `npx tsc --noEmit` — clean.
- **Edge (`osi-journal`, `node --test`):** lifecycle **118/118**, api **57/57**, index **106/106** (= 281).
- **Locale parity:** `journalLocales.test.ts` **38/38**; `agrolinkBranding.test.ts` **10/10** (now enforces the `journal.json` mirror).
- **Feed mirror:** all 7 `feeds/.../gui/locales/<locale>/journal.json` **byte-identical** to source.
- **Profile parity:** edge `api.js`/`index.js`/`lifecycle.js`/`index.test.js` + bundled `farming.db` **byte-identical** across bcm2712/bcm2709.
- **Anti-slop:** pass (no tier-1 findings).

## Schema-change-control (Task 27, `0022`)

`0022__journal_catalog_v2.sql` is a **data** migration (`-- risk: data`) — `INSERT`/`UPDATE` into `journal_templates` + `journal_catalog_state` only, **no DDL**; `0019` remains byte-frozen. All 7 bundled DBs regenerated to catalog version 2; seed-replay / migration / DB-consistency / no-stray-DDL / profile-parity gates green (per Task 27 review).

## Correctness highlights — defects the adversarial review caught that green suites missed

1. **T32 Critical** — plot→plot switch (through PlotPicker's forced empty selection) silently dropped user-entered values via the new gate's own `undefined`-target branch. Fixed (`fieldHiddenForEmptyTarget` + `lastRealDiffContextRef` carry); pinned by a `[plotA]→[]→[plotB]` test.
2. **T30 Critical** — a no-op "Save correction" (no field edited) submitted an empty value set, which the edge applied as a destructive `DELETE`+re-`INSERT` **wiping the whole record** and propagating to cloud. Fixed (`initialCorrectionSeed` + `state.visible` ownership); pinned.
3. **G1/G3** — desktop draft completion was non-functional (Close-only panel; then product-activity drafts stuck invalid). Fixed: `DraftResumePanel` **Complete** finalizes via `createEntry` **POST** → `promoteDraftInTransaction` (never PUT), with `catalog.products` threaded. Pinned by finalize + product-draft tests.
4. **CI gate** — the vitest gate silently excluded the entire desktop workspace + markers suites; fixed so "green" is trustworthy.

## Accepted residual risks / documented limitations (from the final whole-branch review)

- **G2 (fixed):** transition-sheet copy now says "Layout" (was "growing setting"), matching the §6.2 rename; translations are good-faith.
- **T30 DST limitation:** correcting an occurrence whose start/end straddle a DST change can be rejected with `invalid_utc_offset` (schema stores a single UTC-offset column). Not a regression; document for support.
- **T33 follow-ups:** details bottom sheet lacks a focus-trap; markers sit ~4px off on the 2 dendro chart views only (YAxis width 48 vs 52 — a pre-existing chart-config inconsistency). Cosmetic.
- **T31 future:** when draft photo attachments land, `discardDraft` must also delete on-disk blobs (FK CASCADE removes the row, not the file).
- **Luganda (`lg`):** all journal translations are good-faith, not native-reviewed (project-tracked; native review is product-owner handled). Reviewer term-list at `docs/i18n-review/`.
- Minor a11y/label polish deferred (T28 legend/aria-label wording; T29 page-local sort cue + voided-badge theme token).

## Deployment prerequisites (when a deploy is later authorized)

- Apply the journal catalog **v2 data migration** (`0022`) on the target via the normal schema-delivery path; the 7 bundled `farming.db` copies are already at catalog version 2.
- Composition guardrail still stands: land the deferred product-composition migration (`0023`+, Agroscope reference values + ≥1 mineral product) **before** any real fertilisation is logged on a deployed image (compositions are immutable after first use).
- No `flows.json` change in this range; ChirpStack reprovision on restart is unaffected.
- **NOT done here (require explicit instruction):** push, PR/merge to `main`, any live-gateway action, Playwright browser-acceptance run (Task 35's browser step is outstanding — see below).

## Live verification (kaba100 demo Pi, 2026-07-20) — DONE, and it caught a real bug

The branch was deployed to the **kaba100** demo gateway (`100.93.68.86`) via the runbook
reverse-tunnel flow and browser-verified with Playwright over http (screenshots outside the repo at
`/home/phil/playwright-osi/agrolink-slice2/`). HEAD verified: `6b13e8ac`.

- **Deploy:** clean (`[migrate] applied: [22]` first time, no-op after; self-check PASSED; `farming.db`
  preserved — 159,844 device_data rows; new GUI bundle; `catalog_version=2`; `farmer_quick` v1+v2
  both active; export.csv 401). No divergence — kaba100 was at migration head 0021 with checksums
  identical to the branch, so only `0022` applied.
- **Render:** desktop 3-pane workspace + mobile capture flow render correctly at 1440 / 320 / 360;
  **horizontal overflow 0 and console errors 0 at every viewport.**
- **End-to-end data:** real journal entries created and read back live — table row → detail read-back
  (all recorded values) → Correct/void actions, all working against the live backend.

### BUG FOUND + FIXED by the live verify (unit suite could not catch it)
- **`crypto.randomUUID` crash on insecure origin** (commit `319ca405`). The capture flow called
  `crypto.randomUUID()` with no fallback in 4 shipped files (JournalCaptureFlow entry_uuid, PlotForm
  plot_uuid, PlotPicker group, useCaptureDraft). `crypto.randomUUID` exists **only in secure
  contexts**; gateways serve the GUI over plain `http://<pi-ip>:1880`, so it is `undefined` and
  logging an activity / creating a plot threw and crashed to a blank screen. jsdom provides it, so
  all 1400+ unit tests were green. **Predates Slice 2** (Slice 1 capture code) — a latent production
  crash for the whole journal capture feature in the field. Fixed with `src/utils/uuid.ts`
  `randomUuid()` (uses `crypto.randomUUID` when present, else a canonical v4 from
  `crypto.getRandomValues`, else Math.random) wired to all 4 sites, +4 unit tests. Verified live: a
  real entry saved with a fallback-generated UUID.

### New feature added on request (this session): desktop "Log activity"
- Commits `27f2bced` (feature) + `6b13e8ac` (review fix). The desktop workspace was review/manage
  only (no capture button); added a "Log activity" button that opens the existing `JournalCaptureFlow`
  in an accessible modal (role=dialog, aria-modal, backdrop, Escape, focus-trap, focus-return), owns
  the post-save table refresh, and selects the new entry. Opus-reviewed; Important-1 fixed (every
  modal-dismiss path — Escape/backdrop included — now refreshes the table). Full suite green
  (**vitest 1417 + node:test 94, tsc, build**). Verified live: desktop Log activity → modal capture →
  "Saved on farm gateway" → entry appears in the table (journal_entries went 0→1→2 on kaba100).

### Residual (not done)
- Wider Playwright coverage of draft resume/discard, layout-transition review, and marker densities
  was not scripted (marker/draft data not seeded on the demo Pi); those paths are covered by the unit
  suite. Desktop-capture Minor #2 (Escape ignores the flow's `closeLocked`/nested-view state) left as
  a documented code comment. Two irrigation **test entries** remain on kaba100 (`cf32ea0a`,
  `a2084b27`) and kaba100 now shows **AgroLink/Agroscope branding** — both revertable on request
  (remove entries via void/discard; redeploy mainline to restore branding).

## Outstanding (needs a new instruction)

- Push / PR / merge to `main` (branch stays off-mainline by design), any **production** gateway
  action, and restoring kaba100 to mainline branding / removing the test entries — all await an
  explicit instruction.
