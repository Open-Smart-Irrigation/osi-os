# AgroLink GUI Parity — Slice S4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the history-and-analysis gap between the cloud GUI and the edge GUI along the three axes the maintainer named — the theme-blind colour debt in `components/history/**` and `components/analysis/**`, server-side journal entry filtering and pagination, and history depth plus CSV export parity — while giving the calendar/severity colour surface the categorical token palette it has never had on either side, so the migration ports a real source of truth instead of copying hardcoded hexes across.

**Architecture:** The cloud's history and analysis *backend* is already at near-complete route parity with the edge (reading 1) — 15 matching routes, a byte-identical CSV header, and paired pF rows already implemented. The gap is almost entirely in the frontend and in three specific server behaviours. So S4 is: (a) extend canonical `ui-core/tokens.css` with a categorical history-state palette whose light values are the **edge's own installed Tailwind v4 OKLCH values, copied verbatim**, so the edge's light rendering is unchanged, the cloud's converges onto it, and the dark theme stops being unreadable (reading 5, maintainer re-ruling M11); (b) tokenise the four edge files the 2026-08-06 designer batch deliberately skipped, making the edge a real source of truth for the state colours; (c) port those classes plus the already-tokenised edge chrome across to the cloud's 22 history/analysis files; (d) port the edge's keyset-cursor journal list to Postgres; (e) fix three verified history-depth/export divergences. Every cloud mutation still rides the existing versioned-command and sync layer; S4 adds no sync event, command type or aggregate.

**Tech Stack:** React 18, TypeScript, Vite 5, Vitest + `tsx --test` runners, SWR 2, Spring Boot 3 + JUnit 5/Mockito + Flyway + JDBC (cloud backend), Node 22 + POSIX `sh` (vendor verifiers).

**The two GUIs are on different Tailwind majors, and this is load-bearing for T1.** Verified at the heads below:

| | Tailwind | entry | palette |
|---|---|---|---|
| edge `web/react-gui` | **4.1.18** (`node_modules/tailwindcss/package.json`), `@tailwindcss/postcss` | `src/index.css:1` `@import "tailwindcss";` (+ `@config "../tailwind.config.js"` at `:4`) | **OKLCH** — `node_modules/tailwindcss/theme.css` declares `--color-amber-50: oklch(98.7% 0.022 95.277)` etc.; the built bundle `build/assets/index-o6cmG1pF.css` carries the same `oklch()` literals |
| cloud `frontend` | **3.4.19** (`^3.4.4`) | `presets` | v3 **hex** — `#FFFBEB`, `#451A03`, … |

So "the hex both GUIs render today" is not a thing that exists: the cloud renders those hexes and the edge does not. Reading 5 resolves which side absorbs the shift.

**Working directories (both checkouts are on branch `AgroLink`):**
- Edge (canonical): `/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep`, HEAD `7d37af9f`, pushed, clean. GUI at `web/react-gui/`.
- Cloud (vendored): `/home/phil/Repos/osi-server/.worktrees/agrolink`, HEAD `33521768`, pushed, clean. GUI at `frontend/`, backend at `backend/`.
- Never touch `/home/phil/Repos/osi-server/.worktrees/terra-rehaul-*`, `/home/phil/Repos/osi-os/.worktrees/firmware-image-builder`, or `/home/phil/Repos/osi-os/.worktrees/playbook-lessons`.

**Why S4 touches the edge, exactly (constraint 12).** S3 was cloud-only apart from `scripts/`, `docs/` and `.github/workflows/`. S4 touches three edge files and no more:

| Edge file | Task | Why it is unavoidable |
|---|---|---|
| `web/react-gui/src/ui-core/tokens.css` | T1 | D2: `ui-core` is **canonical in osi-os**. Any token addition is structurally an edge change. There is no cloud-first path. |
| `web/react-gui/tests/uiCoreTokens.test.ts` | T1 | The contrast/shape guard for the tokens added in the same commit. |
| `web/react-gui/src/components/history/visualizations/HistoryMonthCalendarView.tsx` | T2 | This file **is** the definition of the calendar state palette; the cloud's `CalendarView.tsx` is a copy-adapted descendant of it (reading 4). Adding tokens to the canonical repo that no canonical file consumes, while the vendored copy consumes them, inverts D2 and is exactly the two-definitions drift §1.4 of the playbook forbids. Its light rendering is **unchanged for all nine `--cal-*` tones** because T1's light values are this file's own v4 OKLCH values copied verbatim; the only two of its twenty rows that move are the two neutral rows, both declared with measurements in T2 Step 2 (reading 5, reading 6). |

Three further edge files (`visualizations/IrrigationEventTimelineView.tsx`, `visualizations/GatewayStatusOverviewView.tsx`, `InterpretationList.tsx`) are tokenised in T2 for the same reason — each is the definition of a severity triad the cloud twin copies. Two edge-only files with palette debt and **no cloud twin** (`components/history/mobile/HistoryExportSheet.tsx`, `mobile/HistoryInspectorSheet.tsx`, one utility each) are deliberately **not** touched and are ledgered in T11: they are an edge defect with no parity consequence, and they belong to the edge's own designer-review follow-up. No `flows.json`, no `osi-journal/*.js`, no edge runtime backend file, no edge page.

---

## Global Constraints

Copied from `docs/superpowers/specs/2026-08-04-agrolink-gui-parity-design.md` and the standing S1/S2/S3 constraints. Every task's requirements implicitly include this section.

- S4 scope row: "History and analysis — Gateway and zone history cards, drill-down routes, CSV export with paired pF rows, cross-zone analysis." **Drill-down routes and the six missing visualizations are formally carved out into S4b** — see "Deferred to S4b" at the foot of this document. That carve-out is a scope decision with a stated rationale, not a silence.
- "The edge stays canonical for farm state. Every cloud mutation rides the existing versioned-command and sync layer; **this program adds no new sync surface**." S4 adds no sync event, no command type and no aggregate. The journal pagination work (T7/T8) is a **read** path only.
- `ui-core` is a **closed 8-primitive set** (`Banner`, `Button`, `Chip`, `EmptyState`, `FormField`+`INPUT_CLASS`, `Modal`, `Surface`, `TableShell`). S4 adds **zero** new primitives. It adds **CSS custom properties to `tokens.css`**, which is a different surface: the spec calls `tokens.css` "the single source of CSS custom properties", and three tokens (`--info-*`, `--on-primary`, `--field-border`) were added on 2026-08-06 without touching the primitive count. Reading 5 states why the addition is nevertheless a maintainer-ratifiable decision and not an implementer's call.
- "`ui-core` canonical in osi-os, byte-mirrored to osi-server, CI-gated both sides" (D2). **Same-task re-vendor**: a ui-core change lands in osi-os and is re-vendored to osi-server *in that same task*, never split across tasks, and both `scripts/verify-ui-core-vendor.sh` must stay green in both directions.
- "This program works on the `AgroLink` branches only and does not modify Terra files."
- D3: one linked gateway means no selector anywhere; multiple are switched on Settings.
- D4: capability-gated rendering; older gateways get an explicit "not available on this gateway" state, never a broken page.
- **D5, fail-closed:** unknown / missing / unparseable ⇒ deny. `readOnly` / `canWrite` are REQUIRED props with **no default**, so an unthreaded mount is a `tsc` error. S3 shipped three separate fail-opens of the same shape (an ungated toggle that was the only control its field type rendered; an open form surviving revoked authority; a reference-panel form with no re-derived gate). **Every task in this plan that adds or moves a mutating handler must enumerate that handler and state its gate.** T7 and T8 carry an explicit per-handler sweep step. T2–T6, T9 and T10 add **zero** mutating handlers — each states that and the reviewer must verify it from the diff, not from the claim.
- **Ownership is ALWAYS identity comparison, NEVER `gatewayRole == null`** — a null role means the OWNER account. Shipped twice in S2. S4 introduces **no** ownership-gated affordance: nothing in history, analysis or the journal *list* path is owner-gated on the backend. Should any task find itself needing one, the test is `canonical.owner_user_uuid === activeGateway.localUserUuid`, never a role-shaped inference.
- **Tailwind v3.4 cannot alpha-modify `var()` colors.** `bg-[var(--x)]/60` compiles to ZERO CSS. Use `bg-[color-mix(in_srgb,var(--X)_60%,transparent)]`. Guard `noInertTokenAlpha.test.ts` exists in **both** repos (edge `web/react-gui/tests/`, cloud `frontend/tests/`) and must stay green. This bites twice in S4: `bg-white/70` (×2) and `bg-black/25` (×1) are in the migration surface and a naive token swap makes both inert.
- **Background tokens never in `text-` / `placeholder-` / `caret-` / `decoration-` / `fill-` / `stroke-` utilities.** Guard `errorTokenMisuse.test.ts`, both repos. A `*-bg` token is a pale wash; foregrounds use the paired `-text`/`-fg` token. **New in S4:** the `--cal-*` tones follow the same discipline — `--cal-<tone>-bg` is a fill, `--cal-<tone>-text` a foreground, `--cal-<tone>-border` a border and **never a text colour**, `--cal-<tone>-solid` a saturated fill for dots/markers/chips and **never a text colour either** (reading 6 gives the measured reason for both).
- **STANDING RULE — never justify a colour-only indicator with "`aria-hidden` + a label in the DOM ⇒ WCAG 1.4.1 satisfied."** That sentence appeared in this plan, was copied into T2's brief and its commit body, and is **false as a blanket**. It conflates two different guarantees: **1.4.1 forbids colour as the only *visual* means of conveying information, and an `aria-label` is not a visual means.** It satisfies a screen-reader user and does exactly nothing for a sighted farmer in bright sun. The maintainer ruled on this on 2026-08-06 after T2, and the ruling binds every remaining task.

  **Ask it per consumer, never per token: does a SIGHTED user have a non-colour carrier at this render site?** The two consumers T2 touched answer differently, which is the whole point:
  - `IrrigationEventTimelineView.tsx:297` renders its severity dot beside a **visible** text chip at `:307-309`. Colour is redundant. The argument holds — and this is where T2's emerald 3.67→2.46 and sky 4.02→2.71 sub-3:1 crossings live, which is why they were ruled acceptable.
  - `HistoryMonthCalendarView.tsx:149`'s marker text exists **only** inside `dayAriaLabel`. Colour is the sole visual carrier. The argument does **not** hold. S4 ships it solely because `-solid` is the verbatim `-500` and those dots are byte-stable: pre-existing, carried forward knowingly, ledgered in T11, **not blessed.** Any later task that changes a calendar marker dot re-opens it and needs a fresh maintainer ruling.

  T3–T6 and T10 touch many colour-coded indicators — severity dots, legend swatches, status chips, calendar markers — and the shortcut will be tempting because it reads as settled. **A task that ships a sub-3:1 indicator must name its consumer, quote the visible carrier's source line, or say plainly that there isn't one.** Tokenising a value does not make it correct; it gives it a name.

- **STANDING RULE — how task briefs are derived from this plan. Phase 1 hit both of these; phase 2 must not.** T1's and T2's briefs carried six wrong instructions between them, all caught and reported by implementers rather than force-fitted (which is the behaviour this plan wants). Two were systematic:
  1. **Every command in a brief is run once against the real toolchain before it is written into a step.** T1 Step 4's environment-variable names were wrong for **both** vendor verifiers and would have exited 2 (the real names are `OSI_SERVER_ROOT` + optional `CANONICAL_UI_CORE_ROOT` on the osi-os side, `EDGE_UI_CORE_ROOT` + optional `VENDOR_UI_CORE_ROOT` on the osi-server side; both scripts `diff -ru` the whole `ui-core` directory, so the real check is broader than the snippet implied). T1 Step 5's grep assumed no space after the colon, but the cloud's Tailwind 3.4.19 emits `--cal-warn-bg: oklch(...)` with a colon-space and a stripped leading zero, so the grep matched nothing on a build that was in fact correct. **A command that has never been executed is a guess with a shell prompt in front of it.** This applies to greps, verifier invocations and expected-output claims alike.
  2. **Every `file:line` citation is re-verified against the current file at dispatch time.** Earlier tasks shift lines. A T2 fix brief cited the severity chip at `:304-306`; the implementer checked the file, found `:307-309`, and wrote the correct one into a permanent commit. **Re-derive citations with a `grep -n` or `sed -n` at brief-writing time and paste the output**, rather than copying a line number out of this plan or an earlier brief. The counts and inventories in the "Reference: the migration surface, measured" section below carry the same expiry — they were measured at cloud `33521768` and must be re-measured, not re-quoted.

- **`oklch()` values inside custom properties are legal in Tailwind v3.4 arbitrary values, and the browser floor is stated.** T1's light values are `oklch(...)` strings. Tailwind never parses them: `bg-[var(--cal-warn-bg)]` compiles to `background-color: var(--cal-warn-bg)` and the *browser* substitutes the property text at paint. Confirm this from the generated CSS in T1 Step 5 rather than assuming it. Browser floor for `oklch()`: **Chrome/Edge 111+, Safari 15.4+, Firefox 113+** — all shipped 2022–2023, and the edge already ships `oklch()` in `build/assets/index-o6cmG1pF.css` today, so this floor is already the gateway GUI's floor. One caveat that bites in the fallback map: `color-mix(in srgb, <oklch color> N%, transparent)` converts the OKLCH argument to sRGB before mixing, so a colour-mixed `--cal-*` loses the wide-gamut rendering the plain token keeps. Nothing in S4 colour-mixes a `--cal-*` token; if a port needs to, say so and measure it.
- **`pageShellTokens.test.ts` scans all of `src` in both repos** as of edge `a47d3ec5` / cloud `a47d3ec5`. Reading 7 corrects the brief on this guard: it checks **viewport-claiming shells only**, its allowlist lives on the **edge side only** and contains **two verified scanner false positives, not offenders**. S4 must not add to it. S4's colour work is *not* covered by it at all, which is why T6 adds a second, component-scoped guard.
- **7-locale key-set equality** (`en`, `de-CH`, `fr`, `it`, `es`, `pt`, `lg`), `lg` machine-draft pending the human-native gate, for every new string. Cloud locales live in `frontend/public/locales/<locale>/<ns>.json` — **not** in `frontend/src/i18n/config.ts` (an S3 orchestrator got this wrong). History/analysis strings are in `history.json`.
- **Every changed foreground/background pair states its contrast ratio in BOTH themes.** Reference ratios recomputed from `ui-core/tokens.css` at edge head `7d37af9f` (light / dark):

  | pair | light | dark |
  |---|---|---|
  | `--text` on `--bg` | 16.48 | 17.21 |
  | `--text` on `--card` | 17.85 | 14.28 |
  | `--text` on `--surface` | 15.16 | 15.85 |
  | `--text-secondary` on `--bg` | 9.56 | 11.30 |
  | `--text-secondary` on `--card` | 10.35 | 9.38 |
  | `--text-secondary` on `--surface` | 8.79 | 10.41 |
  | `--text-tertiary` on `--bg` | **5.57** | 6.80 |
  | `--text-tertiary` on `--card` | **6.03** | 5.65 |
  | `--text-tertiary` on `--surface` | **5.12** | 6.27 |
  | `--on-primary` on `--primary` | 5.17 | 10.39 |
  | `--primary` on `--card` | 5.17 | 8.28 |
  | `--warn-text` on `--warn-bg` | 6.37 | 11.02 |
  | `--success-text` on `--success-bg` | 8.30 | 11.35 |
  | `--info-text` on `--info-bg` | 8.49 | 11.66 |
  | `--error-text` on `--error-bg` | 8.20 | 8.20 |

  **The card-only restriction on `--text-tertiary` is lifted.** It was `4.39 light` on `--bg` in S3; after the 2026-08-06 darkening (`#64748B` → `#576474`) it is 5.57 / 6.03 / 5.12 on bg / card / surface and clears AA on all three. This is what makes the `text-slate-500` → `text-[var(--text-tertiary)]` leg of the migration legal.

  **Tokens that must never carry text**, measured: `--warn-border` on `--warn-bg` 1.93 light, `--info-border` on `--info-bg` 3.01 light, `--success-border` on `--success-bg` 3.00 light, `--danger-fg` on `--error-bg` 3.95 light / 3.62 dark. Borders only.
  **Tokens that must never carry text on `--card`**: `--soil-dry` 3.76 light, `--soil-wet` 3.68 light. (`--soil-moist` was darkened to 5.02 on 2026-08-06; the other two were not. Ledgered in T11.)
- **No new untranslated literal** may enter a component S4 writes.
- **Matrix rule:** rows flip toward `parity` "only after a real side-by-side walkthrough against the edge GUI running on `agrolink-test-01`". **That walkthrough has not happened.** No row this plan touches flips to `parity`. **And a walkthrough is not the only thing standing between S4 and the spec's S4 row** — the drill-down carve-out is ~35 undelivered files — so the two history/analysis rows end at `partial — S4 delivered colour/depth only; drill-down NOT delivered (S4b)` rather than at a status that skims as done-pending-a-formality, and both they and the ledger carry the literal sentence *"Completing S4 does not close the spec's S4 row."* The remaining touched rows end at `partial (pending walkthrough)`. All get a dated provenance line. T11 Step 1 is where this is written, and the matrix's own walkthrough-evidence caveat is reproduced in T11's ledger.
- **Every task states its expected suite delta, and T12 asserts the total.** A task that adds tests names how many node-runner and how many Vitest tests it adds, so a silently-skipped spec shows up as a wrong count rather than a green run. S3 proved this catches force-fitting: a T6 implementer was handed a wrong target (79), measured the real baseline (71), refused to force-fit and reported it.
- **Suite baselines, measured on this machine 2026-08-06 at edge `7d37af9f` / cloud `33521768`, all green:**

  | | node-runner | Vitest | Vitest files | build |
  |---|---|---|---|---|
  | edge `web/react-gui` | **111** | **1689** | **169** | not re-run (no edge src change until T2) |
  | cloud `frontend` | **97** | **566** | **110** | green (`tsc && vite build`, exit 0) |

  Commands: `cd <gui> && npm run test:unit` (cloud = `tsx --test tests/**/*.test.ts tests/**/*.test.tsx && vitest run --environment jsdom --dir src`; edge = `npm run test:unit:tsx-runner && npm run test:unit:vitest`). Cloud build: `cd frontend && npm run build`. Cloud backend filtered suite baseline at this head: **276 tests / 48 classes**, 0 failures.
- **Push ordering** (inherited from S3 T3 and still binding): the cloud's `backend-ci.yml` gates read canonical artifacts from the osi-os `AgroLink` ref. **Push the edge before the cloud.** T1 makes this newly load-bearing again — the cloud's re-vendored `tokens.css` will not match until the edge commit is on the remote.

---

## Plan-level readings

Each states an ambiguity in the brief or the spec and its resolution, with the evidence that settled it. Every one was checked against the code at the heads named above.

**1. The cloud history/analysis BACKEND is already at route parity; "history depth and CSV export parity" is three specific defects, not a port.** Verified: `backend/src/main/java/org/osi/server/history/HistoryController.java:38` maps `/api/v1/history` and exposes the same 15 routes the edge serves under `/api/history` (zone + gateway `cards`, `cards/{id}/data`, `/advanced`, `/preferences`, `/opened`, `workspaces` CRUD, `export.csv` ×2, rollups); `analysis/AnalysisController.java:28` matches the edge's four analysis routes. `HistoryCsvWriter.java:7-9`'s `HEADER` is **byte-identical** to the edge's `TIDY_CSV_COLUMNS` (`osi-history-helper/index.js:1696`), and `HistoryExportService.java:190-205` already emits the paired pF row (`seriesLabel + " (pF)"`, `channelKey + "_pf"`, unit `"pF"`, `log10(value*10)` rounded to 4) with the same `swt_`-prefix + `kPa`-unit predicate as the edge's `isSwtKpaChannel`. **CSV export parity is therefore already achieved except for the range caps.** The three real divergences S4 fixes are named in readings 8, 9 and 10. Everything else about the history backend is left alone.

**2. The colour-migration surface is 509 utilities across 22 files, not ~430 across ~19.** Measured at cloud `33521768` with `/\b(?:bg|text|border|ring|divide|from|to)-(?:\[#hex\]|<palette>-\d{2,3}|white|black)\b/` over `frontend/src/components/{history,analysis}/**`. The brief's per-file numbers agree for `CalendarView.tsx` (67), `HistoryCardFrame.tsx` (54), `GatewayStatusOverviewView.tsx` (38) and `CorrelationPanel.tsx` (27), and disagree for `HistorySidebar.tsx` (47, not 45), `AnalysisControls.tsx` (35, not 33) and `HistoryDesktopShell.tsx` (28, not 29 — cloud commit `f4f90585` lowered it after the brief was written). The three files the brief's file count appears to omit are in `components/history/visualizations/` (5 files, 119 utilities total). **72 distinct utilities** (re-counted at this head with `… | sort -u | wc -l`; the brief's 73 was one high); the neutral half (slate + white/black) is 371 of the 509 and the chromatic half is 138. Full breakdown in the reference table below. Any executor who measures a different number must report it rather than force-fit — the count is the drift detector for this migration, exactly as suite deltas are for the rest of the plan.

**3. The brief's central premise — "the edge's line-for-line twins are already correctly tokenised, port the edge's classes across" — is TRUE for the chrome and FALSE for the state colours, and this is why T1/T2 exist.** Measured on the same regex over the edge's `components/{history,analysis}/**`: the edge has **111 palette utilities across 7 files**, all of them in *data-state* colour maps:

  | edge file | hits | cloud twin | cloud hits |
  |---|---|---|---|
  | `history/visualizations/HistoryMonthCalendarView.tsx` | 64 | `history/CalendarView.tsx` | 67 |
  | `history/visualizations/IrrigationEventTimelineView.tsx` | 18 | same name | 29 |
  | `history/InterpretationList.tsx` | 9 | same name | 13 |
  | `history/visualizations/DendroStressEventsView.tsx` | 9 | *(no cloud twin — S4b)* | — |
  | `history/visualizations/GatewayStatusOverviewView.tsx` | 9 | same name | 38 |
  | `history/mobile/HistoryExportSheet.tsx` | 1 | *(no twin; cloud's is top-level and unrelated)* | — |
  | `history/mobile/HistoryInspectorSheet.tsx` | 1 | *(no cloud twin — S4b)* | — |

  Every other edge history/analysis file — including `HistoryCardFrame`, `HistorySidebar`, `HistoryDesktopShell`, `HistoryMobileShell`, `AdvancedViewPanel`, `TimelineBrush`, and **all nine** `components/analysis/*` — is at **zero**. That is recent: edge commit `79fcecbc` ("add `--on-primary` token pair") on 2026-08-06 tokenised `AnalysisControls.tsx`, `AnalysisViewsMenu.tsx`, `HistoryCardFrame.tsx`, `HistoryDesktopShell.tsx`, `desktop/*` and `mobile/*` — and deliberately stopped at the data-state maps, because **no token existed for them**. So the brief is right about *where the designer batch reached* and the gap is precisely the place it could not reach. T1 supplies the missing tokens, T2 applies them to the four edge definitions, and only then does "port the edge's classes" become a complete instruction rather than a 100-utility-shaped hole.

**4. The cloud's calendar state map has silently COLLAPSED four of the edge's severity distinctions — a functional parity defect hiding inside the colour work.** Compared `web/react-gui/src/components/history/visualizations/HistoryMonthCalendarView.tsx:44-64` against `frontend/src/components/history/CalendarView.tsx:17-38`, both 20-entry `Record<HistoryCalendarState, string>`:

  | state | edge | cloud | consequence |
  |---|---|---|---|
  | `high_shrinkage_stress` | `red-300/50/950` | `amber-400/50/950` | on the **dendro** card the severe state now renders the same amber as the mild one |
  | `incomplete_night_recovery` | `orange-300/50/950` | `amber-400/50/950` | same card, same collapse |
  | `possible_ineffective_irrigation` | `orange-300/50/950` | `amber-400/50/950` | on the **irrigation** card, indistinguishable from `high_irrigation_frequency` |
  | `high_irrigation_frequency` | `amber-300/50/950` | `amber-400/50/950` | as above |
  | `mixed` | `purple-300/50/950` | `violet-300/50/950` | cosmetic today; T3 converges the cloud onto the edge's purple (`--cal-mixed-*`), which is one of the cloud's light-theme shifts, not a no-op |
  | `no_data` | **`border-[var(--border)] bg-[var(--surface)] text-[var(--text-tertiary)] opacity-70`** | `border-slate-300 bg-white text-slate-500` | the edge already tokenised this one row |

  On the cloud's dendro calendar a farmer cannot tell severe shrinkage stress from reduced growth. T3 restores the edge's distinctions **as part of** the token migration rather than tokenising the degraded map — which is the difference between a colour task and a parity task, and is why T3 is not mechanical.

**5. The `--cal-*` categorical palette: what it is, why it is not a ninth primitive, why the four existing semantic tones cannot do the job, and which side absorbs the light-theme shift.** The edge's 20 calendar states use **nine** distinct hues (amber, emerald, sky, purple, red, orange, cyan, blue, violet) plus a tokenised `no_data`. `ui-core` has four semantic wash triads (`--warn-*`, `--success-*`, `--info-*`, `--error-*`/`--danger-fg`). Mapping nine onto four collapses states *within a single card type*, which is worse than the defect reading 4 describes:
  - **environment** card states are `normal`(emerald) / `heat_stress`(red) / `cold_stress`(sky) / `high_humidity`(cyan) / `rain_day`(blue) / `no_data` — three cool hues that would all become `--info-*`;
  - **soil** needs a home for `mixed`(purple) and **irrigation** for `manual_override`(violet), neither of which is warn/success/info/error;
  - **dendro** needs `reduced_growth`(amber) and `incomplete_night_recovery`(orange) to differ.

  Per-card-type state sets verified at `frontend/src/history/cardDefinitions.ts:24, 48-54, 77, 95-101, 123` and the edge's `:24, 48-54, 77, 95-101, 123` (the only difference: cloud's soil declares `mixed`, edge's does not).

  **Resolution: add nine `--cal-<tone>-{bg,text,border,solid}` quads to `tokens.css`. The light values are the EDGE's installed Tailwind v4 `oklch(...)` strings, copied verbatim.**

  **Which side absorbs the shift — maintainer re-ruling M11, 2026-08-06.** The first version of this reading said the light values would be "byte-equal to what both GUIs render today". That premise was false and is retracted. The two GUIs are on different Tailwind majors (see Tech Stack): the edge is `tailwindcss@4.1.18` with `@import "tailwindcss"` and an **OKLCH** palette, the cloud is `3.4.19` with the v3 **hex** palette. The hexes this plan originally listed are the v3 ones — so byte-equality would have held on the **cloud** and not on the **edge**, the inverse of the claim, and the "rejected alternative" below was rejected on a ground that no longer distinguishes the options.

  The maintainer's ruling: **keep the edge pixel-stable and take the shift on the cloud.** Rationale, recorded so it is not re-litigated: the edge is the canonical side and it is deployed to live farm gateways (Silvan, kaba100, Uganda); the cloud is the mirror and this very slice is repainting all 22 of its history/analysis files anyway, so a small shift there costs nothing, while a shift on the edge would be an unrequested visual change to a production farm surface made as a side effect of a colour-debt cleanup.

  **And copy the `oklch(...)` strings verbatim rather than converting them to sRGB hex.** In sRGB the two palettes are already very close — the nine `-50` washes round-trip to *exactly* the v3 hex (`oklch(98.7% 0.022 95.277)` → `#FFFBEB`), and the `-950`/`-300` shades differ by a handful of RGB units. But `oklch()` addresses colours **outside sRGB**, so on a P3 / wide-gamut display (every recent iPad and phone the farm GUI is used on) the edge renders the OKLCH colour and an sRGB hex conversion would render a visibly duller one. Verbatim copying is what makes "the edge is unchanged" true on those displays too, not just on sRGB.

  Four consequences follow, all deliberate:
  1. **The edge's light rendering is unchanged**, because the values are its own, in its own colour space. The two neutral calendar rows (`no_irrigation`, `no_data`) do move — they use the chrome tokens, not `--cal-*` — and are declared with measurements in T2 Step 2.
  2. **The cloud's light rendering shifts from the v3 hex palette onto the edge's v4 palette.** That is the intended convergence, not a side effect: the whole point of S4's colour work is that the two GUIs stop having two definitions of the same colour. The shift is small in sRGB (washes identical, text/border a few units) and larger on P3.
  3. **Dark theme becomes readable** where today it renders a `#FFFBEB` cell on a `#101413` page. Measured in reading 6.
  4. **The semantic chrome tones are not overloaded.** A 20-state categorical heatmap and a four-tone chrome vocabulary are different systems; conflating them means a future change to `--warn-bg` (a banner colour) silently repaints the dendro calendar. `--soil-wet/-moist/-dry` + their `-bg` pairs are the existing precedent for domain data colours living in `tokens.css` alongside the semantic set.

  **Rejected alternative:** reuse `--warn/--success/--error/--info` for the five hues that match (amber→warn, emerald→success, red→error, and the two cool blues sky+blue→info) and add only four new tones. Rejected on two grounds that survive the re-ruling. (i) **It reintroduces the reading-4 defect by design.** Five hues onto four semantic tones means two of them share, and the two that share are sky and blue — i.e. `cold_stress` and `rain_day`, both **environment**-card states, so a farmer looking at one calendar could not tell a cold snap from a rainy day. That is the exact class of within-card collapse this reading exists to prevent. (ii) It couples two vocabularies that change for different reasons — a banner-colour tweak would repaint the dendro calendar. The old ground for rejection ("it moves light colour on the production edge for five of nine tones") is **withdrawn**: under M11 it would have moved the *cloud*, which is now acceptable, so it can no longer carry the decision and ground (i) does the work instead.

  **This is a token addition, not a primitive addition.** The closed set of eight is a set of React components; `tokens.css` is separately described by the spec as "the single source of CSS custom properties", and three properties were added to it on 2026-08-06 (`--info-*`, `--on-primary`, `--field-border`) with no primitive-count change. It is nevertheless a **design decision about a shared, byte-mirrored surface**, so T1 Step 0 requires the maintainer to **re-ratify the corrected OKLCH-derived values and the corrected contrast table** before any code lands. The design itself is already ratified (M11); what Step 0 gates is the corrected numbers.

**6. The `--cal-*` values, measured in both themes from the OKLCH-derived colours — and the one inherited AA failure a naive port would import.**

  **Light values are the edge's installed Tailwind v4 `oklch(...)` strings, copied verbatim** from `/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui/node_modules/tailwindcss/theme.css`: `-50` → `bg`, `-950` → `text`, `-300` → `border`, `-500` → `solid`. The same literals appear in the shipped bundle `web/react-gui/build/assets/index-o6cmG1pF.css`, which is the second, independent place to read them from. **Dark values are hex and are new** — nothing ships a readable dark calendar today, so there is no stability constraint on that side.

  **Every figure below was recomputed from the OKLCH values**, by the standard OKLCH → OKLab → linear-sRGB → sRGB conversion, then WCAG 2.x relative luminance on the sRGB result. The figures published in the first version of this reading (12.88–14.76 light) were computed against the v3 hexes and are superseded; the corrected light figures happen to land within ±0.08 of them, because in sRGB the two palettes are very close, but they are now derived from the values the plan actually ships.

  **The light column was corrected again on 2026-08-06, post-T1.** The values printed here before that were off by up to 0.07 against what T1 actually shipped. Every light figure in this reading is now **measured from the committed `web/react-gui/src/ui-core/tokens.css`** using the same conversion path as `uiCoreTokens.test.ts`, cross-checked twice (T1's task reviewer, then the plan amendment pass). Six tones moved: warn 14.47→**14.46**, good 14.41→**14.36**, alert 14.74→**14.76**, humid 12.89→**12.86**, water 13.58→**13.51**, violet 13.89→**13.92**. Dark figures were verified unchanged. **Any figure quoted downstream must come from this table or from a fresh measurement, never from a task brief that predates this correction.**

  **A note on which rounding path a figure came from, because two live in this plan.** The `oklch()` float path (what the guards compute, what this table publishes) and the 8-bit-hex path (recomputing from the sRGB hexes in the "sRGB of those" column) disagree in the second decimal — e.g. `--cal-warn-solid` on `--card` is **2.15** on the float path and **2.13** on the hex path; the same colour, two roundings. No conclusion in this plan turns on the difference, but a figure and its path must travel together, and the guard's path is the float path.

  | tone | light bg / text / border / solid — verbatim v4 OKLCH | sRGB of those | dark bg / text / border (solid = border) | text-on-bg L / D | states |
  |---|---|---|---|---|---|
  | `warn` | `oklch(98.7% .022 95.277)` / `oklch(27.9% .077 45.635)` / `oklch(87.9% .169 91.605)` / `oklch(76.9% .188 70.08)` | `#FFFBEB` `#461901` `#FFD230` `#FE9A00` | `#3A2B0B` / `#FDE68A` / `#F59E0B` | **14.46 / 11.02** | dry_stress, reduced_growth, high_irrigation_frequency |
  | `good` | `oklch(97.9% .021 166.113)` / `oklch(26.2% .051 172.552)` / `oklch(84.5% .143 164.978)` / `oklch(69.6% .17 162.48)` | `#ECFDF5` `#002C22` `#5EE9B5` `#00BC7D` | `#123326` / `#BBF7D0` / `#22C55E` | **14.36 / 11.35** | optimal, normal_growth, normal |
  | `cool` | `oklch(97.7% .013 236.62)` / `oklch(29.3% .066 243.157)` / `oklch(82.8% .111 230.318)` / `oklch(68.5% .169 237.323)` | `#F0F9FF` `#052F4A` `#74D4FF` `#00A6F4` | `#0C2A3A` / `#BAE6FD` / `#38BDF8` | **13.03 / 11.24** | wet_excess, cold_stress |
  | `bad` | `oklch(97.1% .013 17.38)` / `oklch(25.8% .092 26.042)` / `oklch(80.8% .114 19.571)` / `oklch(63.7% .237 25.331)` | `#FEF2F2` `#460809` `#FFA2A2` `#FB2C36` | `#3B1717` / `#FECACA` / `#F87171` | **14.78 / 10.99** | high_shrinkage_stress, heat_stress, offline |
  | `alert` | `oklch(98% .016 73.684)` / `oklch(26.6% .079 36.259)` / `oklch(83.7% .128 66.29)` / `oklch(70.5% .213 47.604)` | `#FFF7ED` `#441306` `#FFB86A` `#FF6900` | `#3A1F07` / `#FED7AA` / `#FB923C` | **14.76 / 11.25** | incomplete_night_recovery, possible_ineffective_irrigation |
  | `humid` | `oklch(98.4% .019 200.873)` / `oklch(30.2% .056 229.695)` / `oklch(86.5% .127 207.078)` / `oklch(71.5% .143 215.221)` | `#ECFEFF` `#053345` `#53EAFD` `#00B8DB` | `#0B2E33` / `#A5F3FC` / `#22D3EE` | **12.86 / 11.58** | high_humidity |
  | `water` | `oklch(97% .014 254.604)` / `oklch(28.2% .091 267.935)` / `oklch(80.9% .105 251.813)` / `oklch(62.3% .214 259.815)` | `#EFF6FF` `#162456` `#8EC5FF` `#2B7FFF` | `#172B48` / `#BFDBFE` / `#60A5FA` | **13.51 / 10.02** | rain_day, irrigation_event |
  | `mixed` | `oklch(97.7% .014 308.299)` / `oklch(29.1% .149 302.717)` / `oklch(82.7% .119 306.383)` / `oklch(62.7% .265 303.9)` | `#FAF5FF` `#3C0366` `#DAB2FF` `#AD46FF` | `#2E1B47` / `#E9D5FF` / `#C084FC` | **14.01 / 11.31** | mixed (soil) |
  | `violet` | `oklch(96.9% .016 293.756)` / `oklch(28.3% .141 291.089)` / `oklch(81.1% .111 293.571)` / `oklch(60.6% .25 292.717)` | `#F5F3FF` `#2F0D68` `#C4B4FF` `#8E51FF` | `#251C46` / `#DDD6FE` / `#A78BFA` | **13.92 / 11.34** | manual_override (irrigation) |

  All nine clear AAA for body text in both themes (light **12.86–14.78**, dark 10.02–11.58).

  **`-border` measured against its own wash:** light **1.39–1.76**, dark **5.60–8.00** (corrected post-T1: the light max is `bad` 1.76, not 1.75; the dark min is `water` 5.60, not 5.58). The low light figure is what the edge renders today (it is `-300` on `-50`, the same pair), is not a regression, and is acceptable because state is carried on three simultaneous channels — the wash, the text colour, and the translated summary label rendered inside the cell — so nothing depends on colour alone (WCAG 1.4.1). It is also why `-border` may never carry text; the guards in T1/T2/T6 enforce that.

  **`-solid` is the fourth part, and it exists so the migration has an honest answer for saturated `-500`/`-600` fills** (marker dots, legend swatches, chip fills) instead of lightening them onto `-border`. Light `-solid` is verbatim `-500`, so a marker dot that renders `-500` on the edge today keeps the exact colour it has. (A dot that renders `-600` today does **not** — see the non-identity warning at the fallback map.) Measured from the committed `tokens.css`, light: `-solid` against its own `-bg` wash **2.07–4.01**, against `--card` **2.15–4.40**.

  **FIVE of the nine fall below 3:1 against `--card` in light, not six, and the minimum is 2.15, not 2.13.** Both figures were wrong in every version of this reading before 2026-08-06 and both were quoted forward into T1's brief; T1's reviewer cross-checked three ways (naive per-channel clip 2.1454, CSS Color 4 chroma-reduction 2.1455, Tailwind v3's `#F59E0B` 2.1477) and the plan amendment pass reproduced it a fourth time from the committed file. Per-tone, light `-solid` on `--card`:

  | tone | vs `--card` | | tone | vs `--card` |
  |---|---|---|---|---|
  | `warn` | **2.15 fails 3:1** | | `alert` | **2.89 fails 3:1** |
  | `humid` | **2.36 fails 3:1** | | `water` | 3.76 clears |
  | `good` | **2.46 fails 3:1** | | `bad` | 3.82 clears |
  | `cool` | **2.71 fails 3:1** | | `mixed` | 4.12 clears |
  | | | | `violet` | 4.40 clears |

  `water` is the tone that clears and was previously miscounted as a failure. **2.13 is a real number** — it is this same `warn` value recomputed from the 8-bit hex `#FE9A00` instead of the `oklch()` literal — but it is not the minimum of this table and must not be quoted as one.

  **This is what ships today and is unchanged by tokenising it**, but "unchanged" is not "compliant": 1.4.11 is not met in light for those five tones, this is ledgered as a known pre-existing defect (T11) and routed to the next designer review, and **the 1.4.1 mitigation is per-consumer, not per-token** — see the standing rule in Global Constraints. Dark `-solid` takes the same hex as dark `-border` (a different role, the same value: on the dark theme the tone wash and `--card` are close enough in luminance that one saturated shade serves both).

  **Dark `-solid` against dark `--card` is 5.57–8.53 across all NINE tones** — `bad` 5.57 at the bottom, `humid` 8.53 at the top — comfortably over the 3:1 that WCAG 1.4.11 asks of a non-text indicator. **That envelope describes the palette, never a file.** Any given consumer uses a subset and its true range is narrower: the edge calendar's five toned marker dots, for instance, span **5.57–7.19**, because `humid` is not among them. A brief that quotes 5.57–8.53 for a file is mislabelling the palette range as a measurement of that file — it happened once already (T2's brief) and was caught by the implementer. **Give per-tone figures, or the subset's true measured range. Never the nine-tone envelope as if it described a file.** Per tone, dark `-solid` on `--card`: warn 7.17, good 6.76, cool 7.19, bad 5.57, alert 6.81, humid 8.53, water 6.06, mixed 5.83, violet 5.66.

  **`mixed` and `violet` are kept as two tones, not collapsed.** The first version of this reading collapsed them and justified it as "they never co-render". That answered confusability and not hue change: the edge renders `manual_override` as `violet-*` (`HistoryMonthCalendarView.tsx:62`) and so does the cloud (`CalendarView.tsx:34`), so a collapse onto purple would have moved a light colour on **both** sides — including the edge, which M11 forbids. A ninth tone costs eight custom properties and keeps the edge stable, so it wins outright.

  **`mixed`'s DARK triad is retuned from violet to purple** (`#2A1E4A`/`#DDD6FE`/`#A78BFA` → `#2E1B47`/`#E9D5FF`/`#C084FC`, measured 11.31 text-on-bg, 5.83 border-on-bg). The originally-designed dark triad for `mixed` was built from violet hexes while its light value is purple; with `violet` now its own tone that would have shipped two near-identical dark tones and one tone that is purple in light and violet in dark. Dark values are new either way, so nothing ships differently — this is a correction the ninth tone forces, not a change of a rendered colour.

  **The inherited AA failure:** the edge's already-tokenised `no_data` row carries `opacity-70`, which blends both the `--surface` fill and the `--text-tertiary` glyphs toward the page behind them. Effective rendered contrast is **2.78:1 light / 3.76:1 dark** — a fail in both themes. A literal "port the edge's classes" instruction would import it. T2 drops `opacity-70` and relies on `--text-tertiary` on `--surface` (5.12 / 6.27) to read as muted, which it does without the multiplier. The edge's own instance is fixed in T2 because T2 already owns that line.

  **What actually changes on the cloud, per tone** — the shift M11 accepts, so a reviewer can see its size rather than take "small" on trust. sRGB before (v3) → after (v4-derived):

  | tone | bg | text | border |
  |---|---|---|---|
  | `warn` | `#FFFBEB` → `#FFFBEB` *(identical)* | `#451A03` → `#461901` | `#FCD34D` → `#FFD230` |
  | `good` | `#ECFDF5` → `#ECFDF5` *(identical)* | `#022C22` → `#002C22` | `#6EE7B7` → `#5EE9B5` |
  | `cool` | `#F0F9FF` → `#F0F9FF` *(identical)* | `#082F49` → `#052F4A` | `#7DD3FC` → `#74D4FF` |
  | `bad` | `#FEF2F2` → `#FEF2F2` *(identical)* | `#450A0A` → `#460809` | `#FCA5A5` → `#FFA2A2` |
  | `alert` | `#FFF7ED` → `#FFF7ED` *(identical)* | `#431407` → `#441306` | `#FDBA74` → `#FFB86A` |
  | `humid` | `#ECFEFF` → `#ECFEFF` *(identical)* | `#083344` → `#053345` | `#67E8F9` → `#53EAFD` |
  | `water` | `#EFF6FF` → `#EFF6FF` *(identical)* | `#172554` → `#162456` | `#93C5FD` → `#8EC5FF` |
  | `mixed` | `#FAF5FF` → `#FAF5FF` *(identical)* | `#3B0764` → `#3C0366` | `#D8B4FE` → `#DAB2FF` |
  | `violet` | `#F5F3FF` → `#F5F3FF` *(identical)* | `#2E1065` → `#2F0D68` | `#C4B5FD` → `#C4B4FF` |

  All nine washes — the pixels that dominate a calendar cell — are byte-identical in sRGB. Text and border move by 1–20 units per channel. On a P3 display all of them move, by more, because the token now addresses colours outside sRGB. That is the convergence, stated with its size.

**7. The brief's description of `pageShellTokens.test.ts` needs three corrections, and the guard does not cover S4's surface at all.** Read at edge `7d37af9f` (`web/react-gui/tests/pageShellTokens.test.ts`) and cloud `33521768` (`frontend/tests/pageShellTokens.test.ts`):
  - Both now walk `../src` (widened by edge `a47d3ec5`), correct as briefed.
  - The guard's predicate is `/\b(min-h-screen|h-screen)\b|min-h-\[calc\(|h-\[100dvh\]/` — it inspects **only class strings that claim the viewport**. Ordinary component colours are entirely outside it.
  - The **cloud file has no allowlist at all**; it asserts `deepEqual(offenders, [])`. The allowlist exists only in the **edge** file (`KNOWN_SHELL_GUARD_FALSE_POSITIVES`, 2 entries) and both entries are **verified scanner artifacts, not offenders**: `pages/Login.tsx`'s `.login-scene` is a dedicated theme-aware CSS class in `index.css`, and `pages/HistoryCardDetailPage.tsx:753`'s shell carries `bg-[var(--bg)]` in a static prefix while the fragment scanner matches the conditional suffix in isolation. The instruction "your migration should remove entries from that allowlist" therefore has nothing to act on: removing either entry would make the guard fail on a file that is correct. **S4 neither adds to nor removes from it**, and T6 says so in a comment so the next reader does not re-litigate it.
  - Because the guard misses components entirely, T6 adds `frontend/tests/historyAnalysisTokens.test.ts` — a component-scoped guard over `src/components/{history,analysis}/**` that is the actual regression fence for this migration and the thing that makes the 509→0 claim durable.

**8. History depth, defect 1: the cloud advertises a `season` range on zones that have no season; the edge strips it.** Edge `osi-history-router/index.js:143-148`:
  ```js
  function supportedRangesForCard(config, scopeContext) {
    const ranges = (config.supportedRanges || []).map(function(value) { return String(value); });
    if (ranges.indexOf('season') === -1) return ranges;
    if (scopeContext && scopeContext.activeSeason) return ranges;
    return ranges.filter(function(range) { return range !== 'season'; });
  }
  ```
  Cloud `backend/.../history/HistoryCardService.java:50, 64, 78, 126` hardcodes `List.of("12h", "24h", "7d", "30d", "season")` on all four zone card types unconditionally. The user gets a Season button that, when pressed, returns an `unavailable` response with `season_not_configured`. Fixing the advertisement — not the response — is the edge-matching fix.

**9. History depth, defect 2: `range=season` on the ADVANCED path silently substitutes a 90-day window.** `HistoryService.java` has two range resolvers and only one of them knows about seasons. `resolveRange` (`:756-768`, used by the zone card-data path at `:226`) correctly returns `RangeBounds(now, now, false)` when `activeSeasonBounds` is null, which the caller turns into an `unavailable` response carrying `season_not_configured` (`:228-243`). But `explicitOrDefaultBounds` (`:675-679`, used by the **zone advanced** path at `:327` and the **gateway advanced** path at `:352`) goes straight to `defaultDuration(range)`, whose `case "season" -> Duration.ofDays(90)` (`:801`) hands back ninety days labelled "season", with no season lookup and no unavailability signal. This is a plausible-default substitution for an absent measurement — playbook §1.3, the same class as the `-42 kPa` and `rootVwcPct ?? 24` fallbacks. **Not verified:** whether any shipped client currently requests `range=season` on the advanced route; the defect is in the server contract either way.

**10. History depth, defect 3: the cloud export has no range cap where the edge has two.** Edge `osi-history-helper/index.js:1729-1740`:
  ```js
  const maxDays = scope.granularity === 'raw' ? 92 : (scope.granularity === 'hourly' ? 730 : null);
  if (maxDays !== null && days > maxDays) { /* 413 RANGE_TOO_LARGE, suggestion: 'choose a coarser granularity' */ }
  ```
  Cloud `HistoryExportService.parseRequest` (`:227-245`) validates the date order and the granularity enum and nothing else; the only backstop is a post-hoc row cap (`:83-84` → `HistoryExportError.rowCap()`, 413). Row caps and day caps fail differently: a sparse two-year raw export passes the row cap and produces a file the edge would have refused, and the operator gets no "choose a coarser granularity" steer until after the query has run. **`daily` is uncapped on both sides** — that is the edge's behaviour and must be preserved, not "improved".

**11. Server-side journal filtering and pagination: the cloud has no cursor precedent anywhere, so the edge's trio is ported, not invented.** Verified: `grep -rn "nextCursor\|next_cursor\|hasMore\|has_more"` over `backend/src/main/java/org/osi/server` returns **zero hits**; no controller returns a `Page<...>`. The repo's settled convention is a clamped limit with no cursor (`SyncDeadLetterAdminController.java:27-38`, `SyncHealthController.java:22`, `EdgeSyncController.java:132,139`, all `Math.max(1, Math.min(limit, N))`). The edge's keyset implementation is correct and directly portable: `ORDER BY occurred_start DESC, entry_uuid ASC` with the seek predicate `(occurred_start < ? OR (occurred_start = ? AND entry_uuid > ?))`, a base64url `[occurred_start, entry_uuid, filterHash]` cursor, and `filterHash` a sha256 over the normalized filters with `cursor` and `limit` excluded so a page-size change does not invalidate an outstanding cursor (`osi-journal/api.js:466-489, 561-580`). **The cloud's existing sort key is already `occurred_start DESC, entry_uuid`** (`JournalQueryService` `Table.forKind`), so the cursor shape drops straight in.

**12. What the cloud mirror can and cannot filter on — this bounds T7 and must not be papered over.** Edge `journal_entries` has 43 columns; `journal_entries_mirror` has 12 (`V2026_07_23_002__journal_mirrors.sql:4-17`). Of the edge's twelve `ENTRY_FILTERS`:
  - **Portable as column predicates (7 fields, 6 offered):** `plot_uuid`, `zone_uuid`, `activity_code`, `status`, `occurred_from`/`occurred_to` — plus `entry_uuid`, which T7 deliberately does **not** offer as a list filter because `GET …/entries/{entryUuid}` already covers single-entry lookup and a one-row list is not a page.
  - **Present only inside `aggregate_json`, therefore unindexed (6):** `campaign_uuid`, `protocol_code`, `protocol_version`, `observation_unit_code`, `batch_uuid`, `pass_uuid`.
  - **`status` has a hard three-value ceiling.** The mirror's `CHECK (status IN ('final','voided'))` plus `JournalMirrorService.java:36-43` mean `draft` never reaches the cloud. The cloud's existing `'all' | 'final' | 'voided'` type is already the correct ceiling; porting the edge's four-valued `['draft','final','voided','all']` would be wrong. **Note the default differs:** the edge defaults `status` to `'final'`; the cloud UI defaults to `'all'`. T7 keeps the cloud's `'all'` default and states why (a cloud user browsing a mirror expects to see voided entries they voided; the edge's `'final'` default is a capture-device convention).
  - **`zone_uuid` differs in kind, not availability.** The edge resolves `zone_uuid` → numeric `zone_id` and filters on that (`api.js:536-549`); the mirror has no `zone_id` at all, so the cloud filters on `zone_uuid` directly. Same result, simpler path.

  **T7 therefore offers exactly the six column-backed filters and no others**, and records the six JSON-only ones as a named deferral rather than shipping an unindexed `aggregate_json->>'…'` scan whose cost grows with the mirror.

**13. Two cloud client-side behaviours cannot be reproduced server-side and are deliberately kept on the client.** (a) `sortEntries` (`EntryTable.tsx:85-109`) offers four sort keys, three of which (`activity`, `plot`, `status`) sort on **display labels resolved through the catalog model and the active locale** — the server has no locale and no catalog model, so a server sort on those columns would order differently from what the user reads. (b) `filters.search` matches `note` (a JSON-only field) and `activity_code`. **Resolution:** T7/T8 move *filtering and paging* to the server and keep *sorting within the fetched page* and *free-text search within the fetched page* on the client — which is exactly what the edge does (`EntryTable.tsx:112, 127` sorts and pass-groups the loaded page only, with the consequence documented at `:140-149`). The cloud's four-way client sort therefore becomes a within-page sort, matching the edge. This is a **visible behaviour change** (sorting by Activity no longer reorders across pages) and T8 must surface it in the UI, not just in the plan.

**14. The date-filter semantics differ between the two sides and T7 must pick one deliberately.** Cloud `filterEntries` compares `occurred_start.slice(0,10)` lexicographically against a `yyyy-mm-dd` string, inclusive at both ends and implicitly UTC-dated. The edge compares full ISO instants (`occurred_from`/`occurred_to` validated by `Date.parse`). A naive port changes which entries the `occurredTo` bound includes on its last day: today `occurredTo = '2026-08-06'` includes everything on the 6th; an instant comparison against `2026-08-06T00:00:00Z` excludes almost all of it. **Resolution: keep the cloud's inclusive-day semantics** and have the client expand the bounds to instants before sending (`occurred_from = <date>T00:00:00Z`, `occurred_to = <date>T23:59:59.999Z`), so the wire contract matches the edge's instant filter while the rendered behaviour is unchanged. T7 pins this with a boundary test on both ends — playbook §3, "boundaries are exact complements".

**15. `AnalysisControls` is functionally behind the edge as well as visually, and the two are fixed in one commit.** Diffing `web/react-gui/src/components/analysis/AnalysisControls.tsx` (203 l) against `frontend/src/components/analysis/AnalysisControls.tsx` (173 l): the cloud dropped the `range?: AnalysisRange` prop, the `isoToDatetimeLocal` helper, and the `useEffect` that repopulates the custom-range inputs from the active range — so a custom range is forgotten on every remount and the two date inputs come back empty while the range chip still reads "custom". It also relaxed the validity test from `customFromMs < customToMs` to `<=`, accepting a zero-length range the edge rejects. Since this file is also 35 of the 509 colour utilities, **its colour migration and its functional restoration land in the same task (T10)** rather than touching one file twice for two reviewers. This is the one place where the maintainer's "the colour migration touches the same files as the functional work" is literally true; everywhere else in S4 the two sets are disjoint (reading 16).

**16. The ordering decision: the colour migration lands FIRST, but the premise that it collides with the functional work is false for all but one file.** File sets:
  - Colour migration: `frontend/src/components/history/**` (13 files), `frontend/src/components/analysis/**` (9 files).
  - Journal pagination (T7/T8): `backend/.../journal/**`, `frontend/src/services/api.ts`, `frontend/src/pages/JournalPage.tsx`, `frontend/src/components/journal/workspace/**`.
  - History depth (T9): `backend/.../history/**` only.
  - Analysis restoration (T10): `frontend/src/components/analysis/AnalysisControls.tsx`.

  The intersection of the colour set with T7/T8/T9 is **empty**. The intersection with T10 is **one file**. So "land colour first to avoid rebase pain" and "land it last to avoid bloating functional diffs" are both answering a question that mostly does not arise. The real reasons to put it first are different and they hold:
  1. **T1's token addition is a two-repo, CI-gated, byte-mirrored change with a push-ordering constraint.** It is the highest-risk-of-blocking item in the slice. Landing it first means a T1 problem costs the slice one task, not eleven.
  2. **T2 must precede T3**, and T3 must precede any claim that the cloud calendar matches the edge — because until T2 runs, there is no tokenised edge twin of the calendar to port from (reading 3). The whole "port the edge's classes" workflow the maintainer asked for is only *available* after T2.
  3. **The mechanical tasks are the cheapest to review and the easiest to run in parallel**, so front-loading them gets four tasks of the slice to a reviewable state while the harder backend work is still being written.
  4. **Where the two genuinely do collide (AnalysisControls), they are merged into one task** rather than sequenced. Touching a file twice for two reviewers is the failure mode both orderings were trying to avoid, and merging is strictly better than either.

**17. Nothing in S4 is owner-gated, and only T7/T8 add mutating handlers.** The journal *list* path has no owner rule (the one journal path that does — plot-group mutation under the backend's C9 `owner_user_uuid` check — lives in `JournalReferencePanel`, which S4 does not touch). History and analysis reads are gated by `ownedGateway`/`ownedZone` on the server and carry no client-side write affordance. T2–T6, T9 and T11 add **zero** interactive controls of any kind. T8 adds exactly one new interactive control (a plot selector in `ScopeRail`), which is a **filter**, not a mutation, and therefore needs no `canWrite` gate — but T8 Step 6 still runs the full trap-4 sweep over the touched components and records the enumeration, because S3 shipped three fail-opens by assuming a control was inert.

**18. Deliberately NOT in this plan, per the maintainer.** The **denial-philosophy convergence** (edge denials are silent; the cloud explains with pills, banners and a remediation `EmptyState`, and the edge has no `scope_denied` renderer at all) is deferred until after the walkthrough — noted in T11's matrix ledger, not planned. The **fingerprint-drift root fix** (osi-os#153) and the **live valve gate** have their own cycles and are not referenced by any task here.

**19. The task dependency graph, stated so parallelism is a decision rather than an accident (M13).** Twelve tasks, five chains:

```
T1 ──> T2 ──> T3 ──┐
              T4 ──┼──> T6 ──> T10 ──┐
              T5 ──┘                 │
T7 ──> T8 ────────────────────────────┼──> T11 ──> T12
T9 ───────────────────────────────────┘
```

  - **T1 → T2 → {T3, T4, T5}**: T2 cannot run before T1's tokens exist; T3/T4/T5 port class strings T2 produces.
  - **{T3, T4, T5} → T6**: T6's guard counts offenders across the whole surface, so its expected offender figure only holds once T3–T5 have landed (T6 Step 1 says so).
  - **T6 → T10**: T10 takes T6's guard to zero and deletes its `PENDING_S4_T10` skip-list entry.
  - **T7 → T8**: T8 consumes T7's endpoint. This pair is independent of the whole colour chain (reading 16: the file sets do not intersect).
  - **T9** is independent of everything: `backend/.../history/**` only.
  - **T11** needs every preceding task's outcome to ledger it; **T12** verifies the totals.
  - T3, T4 and T5 may run **in parallel with each other** and with T7/T9. T4 and T5 do not depend on T3.

  **T3, T4 and T5 must not depend on T2's *commit body*.** T2 Step 6 asks for the replacement list in the commit message, and nothing verifies that list is complete or correct — a commit body is not a checked artifact, and no step re-derives it. The porting instruction for T3/T4/T5 is therefore: **read the T2-modified edge file itself** (the four paths are in T2's Files list) and take the class string off the element. The commit body is a convenience index into that diff, not the source of truth. Each of T3/T4/T5 says so at its porting step.

---

## Reference: the migration surface, measured

Cloud `frontend/src/components/{history,analysis}/**`, 509 utilities / 22 files, at cloud `33521768`. The "edge twin" column is what an executor ports from; `—` means no tokenised twin exists and the fallback map below applies.

| cloud file | hits | edge twin at `7d37af9f` | task |
|---|---|---|---|
| `history/CalendarView.tsx` | 67 | `history/visualizations/HistoryMonthCalendarView.tsx` **after T2** | T3 |
| `history/HistoryCardFrame.tsx` | 54 | same name, tokenised (`79fcecbc`) | T4 |
| `history/HistorySidebar.tsx` | 47 | same name, tokenised | T4 |
| `history/visualizations/GatewayStatusOverviewView.tsx` | 38 | same name, **after T2** | T5 |
| `analysis/AnalysisControls.tsx` | 35 | same name, tokenised (`79fcecbc`) | **T10** (merged with its functional fix) |
| `history/visualizations/IrrigationEventTimelineView.tsx` | 29 | same name, **after T2** | T5 |
| `history/HistoryDesktopShell.tsx` | 28 | same name, tokenised (`79fcecbc`) | T4 |
| `analysis/CorrelationPanel.tsx` | 27 | same name, tokenised | T6 |
| `history/visualizations/DendroGrowthTimelineView.tsx` | 26 | same name, tokenised | T5 |
| `analysis/AnalysisSeriesTray.tsx` | 24 | same name, tokenised | T6 |
| `history/HistoryMobileShell.tsx` | 21 | same name, tokenised | T4 |
| `analysis/AnalysisViewsMenu.tsx` | 16 | same name, tokenised (`79fcecbc`) | T6 |
| `history/AdvancedViewPanel.tsx` | 15 | same name, tokenised | T4 |
| `history/InterpretationList.tsx` | 13 | same name, **after T2** | T4 |
| `history/visualizations/EnvironmentLineChartView.tsx` | 13 | same name, tokenised | T5 |
| `history/visualizations/SoilProfileView.tsx` | 13 | same name, tokenised | T5 |
| `analysis/AnalysisExportMenu.tsx` | 12 | same name, tokenised | T6 |
| `analysis/MetricAcrossZonesPicker.tsx` | 10 | same name, tokenised | T6 |
| `history/HistoryExportSheet.tsx` | 8 | `history/mobile/HistoryExportSheet.tsx` (1 hit; near-twin, not line-for-line) | T4 |
| `history/TimelineBrush.tsx` | 6 | same name, tokenised | T4 |
| `analysis/AnalysisChartLegend.tsx` | 5 | same name, tokenised | T6 |
| `analysis/AnalysisChartPanel.tsx` | 2 | same name, tokenised | T6 |

**Fallback map** — for cloud lines with no edge counterpart (the cloud files are larger than their twins: `HistoryDesktopShell` is 494 lines vs the edge's 259). Apply the edge's class string when one exists; otherwise apply this.

**These rows are not identity mappings either**, and they are the majority of the migration — 371 of the 509 utilities are neutral. `bg-slate-50` and `bg-slate-100` both collapse onto one `--surface`; `text-slate-500` and `text-slate-400` both collapse onto one `--text-tertiary`; `border-slate-100`, `-200` and `-300` all collapse onto one `--border`. Every collapse repaints one of the two sources. The neutral shifts are small and none of them crosses a contrast floor (that is why they were not itemised for T2), but the same rule applies: **a task reports what it measured, not that it followed the table.** The one neutral row with a stated measurement is `bg-slate-400` → `--text-disabled`, below.

| Tailwind utility | replacement | note |
|---|---|---|
| `bg-white` | `bg-[var(--card)]` | |
| `bg-white/70` | `bg-[color-mix(in_srgb,var(--card)_70%,transparent)]` | **never** `bg-[var(--card)]/70` — inert |
| `bg-black/25` | `bg-[color-mix(in_srgb,var(--overlay)_25%,transparent)]` | same rule. **Deliberate hue change:** `--overlay` is `#334155` light / `#050807` dark, not black, so the light-theme scrim goes from neutral black to a slate-blue cast. Accepted because `--overlay` is the enforced idiom for scrims across both GUIs and a second black-scrim definition is exactly the two-definitions drift §1.4 forbids. Say so in the commit; do not present it as a no-op. |
| `bg-slate-50`, `bg-slate-100` | `bg-[var(--surface)]` | |
| `bg-slate-200` | `bg-[var(--secondary-bg)]` | |
| `bg-slate-300` | `bg-[var(--border)]` | used as a rule/track fill |
| `bg-slate-700`, `bg-slate-800`, `bg-slate-900` | `bg-[var(--primary)]` | active segmented-control fill; pair with `text-[var(--on-primary)]` |
| `text-white` **on a `--primary` fill** | `text-[var(--on-primary)]` | 5.17 L / 10.39 D |
| `text-white` **on a `--cal-*` dot** | keep the dot decorative; if a label, use the tone's `-text` | per-case, state the measurement |
| `text-slate-950`, `text-slate-900` | `text-[var(--text)]` | |
| `text-slate-800`, `text-slate-700`, `text-slate-600` | `text-[var(--text-secondary)]` | |
| `text-slate-500`, `text-slate-400` | `text-[var(--text-tertiary)]` | legal on bg/card/surface since `7d37af9f` |
| `border-slate-100`, `-200`, `-300` | `border-[var(--border)]` | |
| `border-slate-500` | `border-[var(--field-border)]` | |
| `divide-slate-200`, `divide-slate-300` | `divide-[var(--border)]` | |
| `focus-visible:ring-slate-*` | `focus-visible:ring-[var(--focus)]` | |
| decorative `ring-slate-*` | `ring-[var(--border)]` | |

**Chromatic fallback map — hue AND shade.** 138 of the 509 utilities are chromatic and they use eleven different shades, so a one-line "amber-* → `--cal-warn-*`" rule is not a rule: it leaves twelve subagents each inventing an answer, and it maps `bg-emerald-600` (a solid marker fill) onto `--cal-good-bg` (a near-white wash), rendering an invisible dot. Two axes.

> ### ⚠ THESE ROWS ARE NOT IDENTITY MAPPINGS. READ THIS BEFORE USING EITHER TABLE.
>
> A `--cal-<tone>-<part>` token holds **exactly one shade per part**: `-bg` is `-50`, `-border` is `-300`, `-solid` is `-500`, `-text` is `-950`. The shade axis below sorts eleven source shades into those four buckets. **Whenever a source shade is not the exact shade its target part holds, the rendered colour changes** — and the direction is dictated by this map, not chosen at the call site. "Mapped per the table" is therefore **not** a statement that nothing moved; on most rows it is a statement that something did.
>
> This is not hypothetical. T2 applied this map to four edge files whose brief, commit body and report all claimed "three visual changes and no others". The reviewer measured **13 more**, every one produced by a non-identity row. **T3–T6 port the same shapes to the cloud** — `bg-emerald-600`, `ring-emerald-500`, `text-*-900` and their siblings are all present there — so the identical defect recurs unless each task hunts for it deliberately.
>
> **The three known non-identity classes, with T2's measurements:**
>
> | class | direction | T2's measured effect (light theme, vs `--card` `#FFFFFF`) | risk |
> |---|---|---|---|
> | **`-600` → `-solid` (`-500`)** | **lightens** | red `#E7000B`→`#FB2C36` **4.76→3.82**; emerald `#009966`→`#00BC7D` **3.67→2.46**; sky `#0084D1`→`#00A6F4` **4.02→2.71** | **Emerald and sky CROSS from above 3:1 to below it.** The most dangerous row in the map. |
> | **`-700`/`-800`/`-900` → `-text` (`-950`)** | **darkens** | amber `#7B3306`→`#461901` 8.77→14.46; red `#82181A`→`#460809` 9.21→14.78; emerald `#004F3B`→`#002C22` 9.19→14.36 | Safe — contrast only rises. Still a visual change and still must be declared. |
> | **`-100` ring → `-bg` (`-50`)** | **pales** | four halos paled by 1.078 / 1.125 / 1.081 / 1.082 | Negligible, but T2 shipped it undeclared. Declare it. |
>
> Identity rows, i.e. the only ones a task may call a pure rename: **`-50`→`-bg`, `-300`→`-border`, `-500`→`-solid`, `-950`→`-text`.** Everything else moves. `-200`/`-400`→`-border` also moves (darkens / lightens onto `-300`) but was not exercised on the edge, so it carries no measured example yet — measure it when you hit it.
>
> **Requirement, binding on T3, T4, T5 and T6.** Do not report "mapped per the table". **Enumerate your own non-identity hits by `file:line`, measure each one, and publish the before/after ratio** for anything that lands on a `--card` or wash background. A task that reports zero non-identity hits must show the grep that establishes it. This is an explicit verification item in each of those tasks, not a footnote.
>
> **Measured inventory of the cloud's non-identity hits**, taken at cloud `33521768` for this amendment, so no task starts from zero. Re-derive it at dispatch — earlier tasks do not move these lines, but the file may have:
>
> | task | `-600` → `-solid` (lightens) | `-700`/`-800`/`-900` → `-text` (darkens) | `-100` → `-bg` (pales) | `-200`/`-400` → `-border` |
> |---|---|---|---|---|
> | **T3** `CalendarView` | — | — | — | `border-amber-400` ×4 (`:24,:25,:33,:34`) — T3 replaces these rows outright |
> | **T4** chrome (8 files) | `border-emerald-600` ×3 (`HistoryMobileShell:145`, `HistoryCardFrame:218`, `HistorySidebar:35`); `bg-emerald-600` (`TimelineBrush:102`) | 9: `AdvancedViewPanel:57`, `HistoryCardFrame:154,:218,:275`, `HistorySidebar:190,:226`, `HistoryDesktopShell:392,:400,:491` | — | `border-red-200` ×3, `border-amber-200` ×2 |
> | **T5** visualizations | **`bg-red-600`/`bg-emerald-600`/`bg-sky-600` at `IrrigationEventTimelineView:193-195`** | 9: `GatewayStatusOverviewView:227-229`, `IrrigationEventTimelineView:185-187`, `DendroGrowthTimelineView:199-201` | `ring-amber-100`/`red`/`emerald`/`sky` at `IrrigationEventTimelineView:192-195` | — |
> | **T6** analysis | `text-red-600` (`AnalysisViewsMenu:68`) — **see the foreground override below**; `text-teal-600` (`AnalysisSeriesTray:137`) — no tone, port the edge's class | — | — | — |
> | **T10** | — | `text-amber-700` (`AnalysisControls:168`) | — | — |
>
> **T5's three dots at `IrrigationEventTimelineView:193-195` are the exact same three T2 measured on the edge**, in the cloud's line-for-line twin. Porting them will reproduce the emerald 3.67→2.46 and sky 4.02→2.71 crossings verbatim. The maintainer ruled those acceptable **on the edge** because that consumer renders a **visible** severity text chip beside the dot. Verified for this amendment: the cloud twin renders the same chip at `IrrigationEventTimelineView.tsx:301` with the dot `aria-hidden` at `:288-291`, so the ruling does transfer **for this consumer**. **T5 must re-confirm that from the file rather than from this sentence, and must check every other dot it touches separately** — the mitigation is per-consumer, not per-token (see the 1.4.1 standing rule in Global Constraints).
>
> **Foreground override — the shade axis does not win on a `text-`/`fill-`/`stroke-` utility.** `text-red-600` maps by shade to `-solid`, which would produce `text-[var(--cal-bad-solid)]` — banned by the naming contract and caught by T6's own third guard test. **A foreground utility always takes `-text`, whatever its source shade.** `text-red-600` → `text-[var(--cal-bad-text)]`, reading `bad` text-on-bg **14.78 L / 10.99 D**. (An earlier version of this plan's prose stated that outcome but placed the utility in `InterpretationList`; it is in `analysis/AnalysisViewsMenu.tsx:68`, a `hover:text-red-600` on a delete button, and the cloud's `InterpretationList` is already at `-950`/`-300`/`-50` throughout, i.e. fully identity-mapping.)

**Axis 1, hue → tone.** **Not an identity mapping in combination with axis 2 — see the warning above.**

| hue | tone |
|---|---|
| amber | `warn` |
| emerald | `good` |
| sky | `cool` |
| red | `bad` |
| orange | `alert` |
| cyan | `humid` |
| blue | `water` |
| purple | `mixed` |
| violet | `violet` |
| teal | **no tone.** Port the edge's class (all 3 hits are in `AnalysisSeriesTray`, whose edge twin is tokenised). A fallback guess is not acceptable — see T6 Step 2. |

**Axis 2, shade → part.** **The "identity?" column is the whole point of this table: four of the eleven source shades are renames and the other seven repaint. Read the warning above before applying a single row.**

| shade | part | identity? | rationale |
|---|---|---|---|
| `-50` | `-bg` | **yes** | `-bg` **is** `-50`. Pure rename. |
| `-100` | `-bg` | **no — pales** | a `-100` wash used as a ring/halo drops to the `-50` value. Measured on the edge: 1.078–1.125× paler. |
| `-200` | `-border` | **no — darkens** | onto `-300`. Not exercised on the edge; measure when you hit it. |
| `-300` | `-border` | **yes** | `-border` **is** `-300`. Pure rename. |
| `-400` | `-border` | **no — lightens** | onto `-300`. The cloud's `border-amber-400` (4 hits) is a hairline; T3 replaces those four severity rows outright, so the shift is subsumed by the reading-4 fix. |
| `-500` | `-solid` | **yes** | `-solid` **is** `-500`. Pure rename. Covers `ring-emerald-500`, `bg-amber-500`. |
| `-600` | `-solid` | **no — LIGHTENS, and this is the dangerous row** | **saturated fills and strokes**: marker dots, legend swatches, chip fills. A `-600` source lightens onto `-500`. T2 measured emerald 3.67→**2.46** and sky 4.02→**2.71**, both crossing below the 3:1 floor for a graphical object. **Measure every `-600` hit against its real background and state the before/after.** |
| `-700`, `-800`, `-900` | `-text` | **no — darkens** | onto `-950`. Contrast only rises, so nothing can fail a check it passes today — but it is still a visual change and still declared. |
| `-950` | `-text` | **yes** | `-text` **is** `-950`. Pure rename. |

**Foreground utilities override the shade axis:** `text-`, `fill-`, `stroke-`, `placeholder-`, `caret-` and `decoration-` always take `-text`, whatever the source shade. `-border` and `-solid` may never carry a foreground — the naming contract says so, T2's `historyStateTokens.test.ts` enforces it on the edge and T6's `historyAnalysisTokens.test.ts` enforces it on the cloud. Without this override the map sends `text-red-600` to `-solid` and the port fails its own guard.

Two further consequences to note rather than discover:
- **`-700`/`-800`/`-900` all land on the tone's `-950`-derived `-text`.** The cloud has 19 such utilities (enumerated per task in the warning above): `text-amber-700`(1), `text-amber-800`(2), `text-amber-900`(4), `text-emerald-800`(1), `text-emerald-900`(3), `text-red-800`(1), `text-red-900`(6), plus `text-red-600`(1) arriving here by the foreground override. Every one gains contrast.
- **`ring-*-100` halos** (`ring-amber-100`, `ring-red-100`, `ring-emerald-100`, `ring-sky-100`, 1 each at `IrrigationEventTimelineView:192-195`) map to `-bg`, not `-border`: a `-100` ring is a pale halo, i.e. a fill used as a ring. This does **not** trip `errorTokenMisuse`, which fences `text|placeholder|caret|decoration|fill|stroke` only — confirm by re-running the guard, do not assume. It **does** pale the halo; declare it.

**Neutral chromatic-adjacent cases with no tone:**

| utility | replacement | note |
|---|---|---|
| `bg-slate-400` (marker dots for `sensor_gap` / `data_gap`) | `bg-[var(--text-disabled)]` | The only light pixel in T2 that is not byte-stable. Edge renders v4 `slate-400` = `#90A1B9`; `--text-disabled` light is `#94A3B8`. Luminance 0.3492 → 0.3595, a ratio of **1.03:1** between the two — below the perceptual threshold on a 6 px `aria-hidden` dot. Against `--card` the dot measures **2.56 L / 3.10 D** — below 3:1 in light. **Do not justify that with the `aria-hidden`-plus-label blanket** (see the 1.4.1 standing rule in Global Constraints): on the edge calendar the gap marker's label lives only in `dayAriaLabel`, so for a sighted user the dot's colour is the sole visual carrier and the blanket is false there. What actually licenses shipping it is narrower: the shift is 1.03:1, i.e. the dot is **as (non-)compliant after as before**, so S4 makes nothing worse. Pre-existing, carried forward knowingly, ledgered in T11. On the **cloud** calendar the same dot is rendered by T3 Step 3 beside a **visible** `markerLabel`, so that consumer does have a non-colour visual carrier — a per-consumer difference, stated because the token is the same on both sides. |
| `text-slate-900` in the calendar's `no_irrigation` row | `text-[var(--text)]` on `bg-[var(--surface)]` | A real light change on both sides, declared with measurements in T2 Step 2. |

---

## File map

| File | Repo / area | Task |
|---|---|---|
| `web/react-gui/src/ui-core/tokens.css`, `web/react-gui/tests/uiCoreTokens.test.ts` | osi-os (canonical) | T1 |
| `frontend/src/ui-core/tokens.css` (re-vendored), `frontend/tests/uiCoreTokensAdoption.test.ts` | osi-server | T1 |
| `web/react-gui/src/components/history/visualizations/{HistoryMonthCalendarView,IrrigationEventTimelineView,GatewayStatusOverviewView}.tsx`, `web/react-gui/src/components/history/InterpretationList.tsx`, `web/react-gui/tests/historyStateTokens.test.ts` (new) | osi-os | T2 |
| `frontend/src/components/history/CalendarView.tsx` + `src/components/history/__tests__/` | osi-server | T3 |
| `frontend/src/components/history/{HistoryCardFrame,HistorySidebar,HistoryDesktopShell,HistoryMobileShell,AdvancedViewPanel,InterpretationList,TimelineBrush,HistoryExportSheet}.tsx` | osi-server | T4 |
| `frontend/src/components/history/visualizations/*.tsx` (5) | osi-server | T5 |
| `frontend/src/components/analysis/*.tsx` (7, not `AnalysisControls`/`EChart`), `frontend/tests/historyAnalysisTokens.test.ts` (new) | osi-server | T6 |
| `backend/src/main/java/org/osi/server/journal/{JournalController,JournalQueryService,JournalCursor,JournalEntryFilters,JournalEntryPage}.java`, `backend/src/main/resources/db/migration/V2026_08_06_001__journal_entries_mirror_filter_index.sql` (**conditional** — dropped if T7 Step 5's `EXPLAIN` shows the planner ignores it), backend tests | osi-server | T7 |
| `frontend/src/services/api.ts`, `frontend/src/pages/JournalPage.tsx`, `frontend/src/components/journal/workspace/{EntryTable,ScopeRail}.tsx`, 7× `journal.json` | osi-server | T8 |
| `backend/src/main/java/org/osi/server/history/{ZoneSeasonLookup (new),HistoryCardService,HistoryService,HistoryExportService,HistoryExportError}.java` + `HistoryCardServiceTest`, `HistoryServiceTest` (incl. 12 `soilCard` call sites), `HistoryExportServiceTest` | osi-server | T9 |
| `frontend/src/components/analysis/AnalysisControls.tsx`, `frontend/src/pages/CrossZoneAnalysisPage.tsx`, `src/components/analysis/__tests__/`, and the skip-list deletion in `frontend/tests/historyAnalysisTokens.test.ts` (created by T6) | osi-server | T10 |
| `docs/superpowers/plans/agrolink-gui-parity-matrix.md` | osi-os | T11 |
| (verification only) | both | T12 |

---

### Task 1: `ui-core` gains the categorical history-state palette (canonical edge + same-task re-vendor)

Readings 5 and 6. Nine `--cal-<tone>-{bg,text,border,solid}` quads. **Light values are the edge's installed Tailwind v4 `oklch(...)` strings, copied verbatim** (so the edge's rendering is unchanged, including on P3 displays); dark values are new hexes. This is the only task that may edit `tokens.css`, and it re-vendors in the same commit pair (D2).

**Files:**
- Modify: `web/react-gui/src/ui-core/tokens.css` (osi-os, canonical)
- Modify: `web/react-gui/tests/uiCoreTokens.test.ts` (osi-os)
- Modify: `frontend/src/ui-core/tokens.css` (osi-server, byte copy)
- Modify: `frontend/tests/uiCoreTokensAdoption.test.ts` (osi-server)

**Interfaces:**
- Produces: **36 new CSS custom properties per theme, 72 in total** (9 tones × 4 parts × 2 themes), consumed by T2 (edge) and T3–T6 (cloud). Naming contract: `--cal-<tone>-bg` is a pale wash fill, `--cal-<tone>-text` a foreground, `--cal-<tone>-border` a border and **never** a text colour, `--cal-<tone>-solid` a saturated fill/stroke for dots, swatches and rings and **never** a text colour. Tones, in this exact order: `warn`, `good`, `cool`, `bad`, `alert`, `humid`, `water`, `mixed`, `violet`.

- [ ] **Step 0: Get the corrected numbers re-ratified before writing code**

The **design** — nine tones, four parts, edge-verbatim light values, cloud absorbs the shift — is already ratified (maintainer re-ruling M11, recorded in reading 5). This step is **not** a request to re-open it and must not stall on one.

What Step 0 gates is the corrected arithmetic. Present exactly three things and stop until answered:
1. **reading 6's corrected contrast table**, recomputed from the OKLCH values rather than the withdrawn v3 hexes;
2. **the ninth tone** (`violet`) and the retune of `mixed`'s dark triad from violet to purple that it forces;
3. **the fourth part** (`-solid`) and its measured figures, including the **five** light `-solid`-on-`--card` pairs that sit below 3:1 (`warn` 2.15, `humid` 2.36, `good` 2.46, `cool` 2.71, `alert` 2.89; `water` 3.76 clears) and why that is what ships today. **Step 0 closed on 2026-08-06 with "six" and "2.13" in front of the maintainer; both were wrong and are corrected in reading 6. The ratification stands — the design did not turn on those two figures — but neither number may be re-quoted.**

If the maintainer changes a tone or a value, update reading 6's table **and every measurement derived from it** before proceeding — do not carry a stale ratio into T2. If the maintainer does not respond, this step blocks T1 and nothing else; T7 and T9 are independent (reading 19) and can proceed.

- [ ] **Step 1: Write the failing token guard**

`web/react-gui/tests/uiCoreTokens.test.ts` is 45 lines / 4 tests at this head. It has **no** contrast maths, no `contrastRatio`, no `luminance` and no `TOKENS_PATH` — `grep -rn 'contrastRatio\|luminance\|TOKENS_PATH'` over `tests/` in **both** repos returns zero hits. Its path constant is `tokensPath`, lowercase. So there is nothing to lift; the arithmetic below is supplied inline and is the first copy of it in the repo.

The helper must accept **both** value shapes, because after M11 the light block holds `oklch(...)` and the dark block holds `#RRGGBB`. It converts OKLCH → OKLab → linear sRGB → sRGB and then applies the WCAG 2.x relative-luminance formula to the sRGB result. That is the same path a browser takes to rasterise the token on an sRGB display, so the number the guard reports is the number a contrast checker reports.

Append to `web/react-gui/tests/uiCoreTokens.test.ts`:

```ts
// The categorical history-state palette (S4 T1). Distinct from the four chrome
// semantic tones on purpose: a 20-state calendar heatmap and a 4-tone banner
// vocabulary are different systems, and conflating them means a change to
// --warn-bg silently repaints the dendro calendar. Precedent: --soil-*.
const CAL_TONES = [
  'warn', 'good', 'cool', 'bad', 'alert', 'humid', 'water', 'mixed', 'violet',
] as const;
const CAL_PARTS = ['bg', 'text', 'border', 'solid'] as const;

// Light values are verbatim Tailwind v4 oklch() strings (M11); dark values are
// hex. Both shapes must resolve to sRGB for a WCAG ratio, so parse both.
function srgbOf(value: string): [number, number, number] {
  const hex = /^#([0-9a-fA-F]{6})$/.exec(value.trim());
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255) as [number, number, number];
  }
  const ok = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value.trim());
  assert.ok(ok, `unparseable colour: ${value}`);
  const L = ok![2] === '%' ? Number(ok![1]) / 100 : Number(ok![1]);
  const C = Number(ok![3]);
  const hRad = (Number(ok![4]) * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
  ];
  // Gamut-clip then encode, which is what a browser does on an sRGB display.
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  const encode = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  return lin.map((c) => clamp(encode(clamp(c)))) as [number, number, number];
}

function luminance(value: string): number {
  const [r, g, b] = srgbOf(value).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function blocks(css: string): { name: string; css: string }[] {
  const split = css.indexOf("html[data-theme='dark']");
  return [
    { name: 'light', css: css.slice(css.indexOf(':root'), split) },
    { name: 'dark', css: css.slice(split) },
  ];
}

function value(block: string, name: string): string {
  const match = new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6}|oklch\\([^)]*\\));`).exec(block);
  assert.ok(match, `${name} must be a hex or an oklch() literal in this block`);
  return match![1];
}

test('every --cal tone declares bg/text/border/solid in BOTH themes', () => {
  const css = fs.readFileSync(tokensPath, 'utf8');
  const missing: string[] = [];
  for (const block of blocks(css)) {
    for (const tone of CAL_TONES) {
      for (const part of CAL_PARTS) {
        const decl = `--cal-${tone}-${part}:`;
        if (!block.css.includes(decl)) missing.push(`${block.name} ${decl}`);
      }
    }
  }
  assert.deepEqual(missing, []);
});

// Sanity-check the conversion itself against a value read out of the edge's own
// installed palette, so a broken helper cannot silently pass the ratio test.
test('the oklch helper agrees with the known sRGB of amber-50', () => {
  assert.equal(contrastRatio('oklch(98.7% 0.022 95.277)', '#FFFBEB').toFixed(3), '1.000');
});

test('every --cal tone clears AA for its own text on its own bg, both themes', () => {
  const css = fs.readFileSync(tokensPath, 'utf8');
  const failures: string[] = [];
  for (const block of blocks(css)) {
    for (const tone of CAL_TONES) {
      const ratio = contrastRatio(
        value(block.css, `--cal-${tone}-text`),
        value(block.css, `--cal-${tone}-bg`),
      );
      if (ratio < 4.5) failures.push(`${block.name} --cal-${tone}: ${ratio.toFixed(2)}`);
    }
  }
  assert.deepEqual(failures, []);
});

// The light values must be the edge's own Tailwind v4 palette verbatim (M11):
// an sRGB hex conversion would render differently on a P3 display, which is
// the whole reason the ruling says "verbatim".
test('light --cal values are oklch() literals, dark values are hex', () => {
  const css = fs.readFileSync(tokensPath, 'utf8');
  const [light, dark] = blocks(css);
  for (const tone of CAL_TONES) {
    for (const part of CAL_PARTS) {
      assert.match(value(light.css, `--cal-${tone}-${part}`), /^oklch\(/, `light --cal-${tone}-${part}`);
      assert.match(value(dark.css, `--cal-${tone}-${part}`), /^#[0-9A-F]{6}$/, `dark --cal-${tone}-${part}`);
    }
  }
});
```

Run:
```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npx tsx --test tests/uiCoreTokens.test.ts
```
Expected: 4 tests FAIL is wrong — expect **3 fail, 1 pass**. The declaration test fails with **72 entries** in `missing` (9 tones × 4 parts × 2 themes); the AA test and the literal-shape test fail inside `value()` with `--cal-warn-text must be a hex or an oklch() literal in this block`; the helper sanity check **passes**, because it does not read the file. A sanity check that also fails means the conversion is wrong — fix that before adding tokens, or every ratio below is unverified.

**Note for the existing test at `:31`** (`every cloud-sheet variable and the glass set exist`): it asserts `${name}: #` for a fixed list of chrome token names. `--cal-*` is not in that list, so adding `oklch()` values does not touch it. Confirm that by running the file, not by reading this sentence.

- [ ] **Step 2: Add the tokens to canonical `tokens.css`**

**First, re-read the light values out of the edge's own installed palette** rather than trusting the block below. Both of these are canonical sources and they must agree:

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
grep -nE '^\s*--color-(amber|emerald|sky|red|orange|cyan|blue|purple|violet)-(50|300|500|950):' \
  node_modules/tailwindcss/theme.css
grep -oE 'oklch\([0-9.]+% [0-9.]+ [0-9.]+\)' build/assets/index-o6cmG1pF.css | sort -u | head -40
```
If any value differs from the block below, the installed Tailwind moved since this plan was written: **report the real values, update reading 6's table and re-measure every ratio** before continuing. Do not silently ship the plan's copy.

In `web/react-gui/src/ui-core/tokens.css`, inside `:root`, immediately after the `--soil-*` block and before `--toggle-on`:

```css
  /* Categorical history-state palette (S4 T1, maintainer ruling M11).
     LIGHT values are the edge's own installed Tailwind v4 palette, copied
     VERBATIM from node_modules/tailwindcss/theme.css: -50 -> bg, -950 -> text,
     -300 -> border, -500 -> solid. Verbatim, not converted to sRGB hex: these
     oklch() colours render outside sRGB, so a hex conversion would shift every
     one of them on a P3 display. The edge is therefore pixel-unchanged; the
     cloud (Tailwind 3.4, v3 hex palette) converges onto these values, which is
     the intended convergence and is measured in reading 6.
     DARK values are new hex — nothing shipped a readable dark calendar.
     bg = wash fill, text = foreground, border = border and NEVER text,
     solid = saturated dot/swatch/ring fill and NEVER text. */
  --cal-warn-bg: oklch(98.7% 0.022 95.277);
  --cal-warn-text: oklch(27.9% 0.077 45.635);
  --cal-warn-border: oklch(87.9% 0.169 91.605);
  --cal-warn-solid: oklch(76.9% 0.188 70.08);
  --cal-good-bg: oklch(97.9% 0.021 166.113);
  --cal-good-text: oklch(26.2% 0.051 172.552);
  --cal-good-border: oklch(84.5% 0.143 164.978);
  --cal-good-solid: oklch(69.6% 0.17 162.48);
  --cal-cool-bg: oklch(97.7% 0.013 236.62);
  --cal-cool-text: oklch(29.3% 0.066 243.157);
  --cal-cool-border: oklch(82.8% 0.111 230.318);
  --cal-cool-solid: oklch(68.5% 0.169 237.323);
  --cal-bad-bg: oklch(97.1% 0.013 17.38);
  --cal-bad-text: oklch(25.8% 0.092 26.042);
  --cal-bad-border: oklch(80.8% 0.114 19.571);
  --cal-bad-solid: oklch(63.7% 0.237 25.331);
  --cal-alert-bg: oklch(98% 0.016 73.684);
  --cal-alert-text: oklch(26.6% 0.079 36.259);
  --cal-alert-border: oklch(83.7% 0.128 66.29);
  --cal-alert-solid: oklch(70.5% 0.213 47.604);
  --cal-humid-bg: oklch(98.4% 0.019 200.873);
  --cal-humid-text: oklch(30.2% 0.056 229.695);
  --cal-humid-border: oklch(86.5% 0.127 207.078);
  --cal-humid-solid: oklch(71.5% 0.143 215.221);
  --cal-water-bg: oklch(97% 0.014 254.604);
  --cal-water-text: oklch(28.2% 0.091 267.935);
  --cal-water-border: oklch(80.9% 0.105 251.813);
  --cal-water-solid: oklch(62.3% 0.214 259.815);
  --cal-mixed-bg: oklch(97.7% 0.014 308.299);
  --cal-mixed-text: oklch(29.1% 0.149 302.717);
  --cal-mixed-border: oklch(82.7% 0.119 306.383);
  --cal-mixed-solid: oklch(62.7% 0.265 303.9);
  --cal-violet-bg: oklch(96.9% 0.016 293.756);
  --cal-violet-text: oklch(28.3% 0.141 291.089);
  --cal-violet-border: oklch(81.1% 0.111 293.571);
  --cal-violet-solid: oklch(60.6% 0.25 292.717);
```

and inside `html[data-theme='dark']`, at the same relative position:

```css
  /* Dark: new values, no stability constraint. -solid repeats -border on
     purpose — in dark theme the tone wash and --card are close enough in
     luminance that one saturated shade serves both roles (5.57-8.53 against
     --card across all NINE tones - that is the palette's envelope, never a
     figure for any one file or consumer; reading 6 gives it per tone). The two
     tokens stay separate because their LIGHT values differ (-300 vs -500) and
     consumers pick by role, not by value. */
  --cal-warn-bg: #3A2B0B;
  --cal-warn-text: #FDE68A;
  --cal-warn-border: #F59E0B;
  --cal-warn-solid: #F59E0B;
  --cal-good-bg: #123326;
  --cal-good-text: #BBF7D0;
  --cal-good-border: #22C55E;
  --cal-good-solid: #22C55E;
  --cal-cool-bg: #0C2A3A;
  --cal-cool-text: #BAE6FD;
  --cal-cool-border: #38BDF8;
  --cal-cool-solid: #38BDF8;
  --cal-bad-bg: #3B1717;
  --cal-bad-text: #FECACA;
  --cal-bad-border: #F87171;
  --cal-bad-solid: #F87171;
  --cal-alert-bg: #3A1F07;
  --cal-alert-text: #FED7AA;
  --cal-alert-border: #FB923C;
  --cal-alert-solid: #FB923C;
  --cal-humid-bg: #0B2E33;
  --cal-humid-text: #A5F3FC;
  --cal-humid-border: #22D3EE;
  --cal-humid-solid: #22D3EE;
  --cal-water-bg: #172B48;
  --cal-water-text: #BFDBFE;
  --cal-water-border: #60A5FA;
  --cal-water-solid: #60A5FA;
  --cal-mixed-bg: #2E1B47;
  --cal-mixed-text: #E9D5FF;
  --cal-mixed-border: #C084FC;
  --cal-mixed-solid: #C084FC;
  --cal-violet-bg: #251C46;
  --cal-violet-text: #DDD6FE;
  --cal-violet-border: #A78BFA;
  --cal-violet-solid: #A78BFA;
```

**Measured text-on-bg, light / dark**, re-measured from the committed `tokens.css` post-T1 (the light figures printed here before 2026-08-06 were off by up to 0.07): warn **14.46 / 11.02**, good **14.36 / 11.35**, cool **13.03 / 11.24**, bad **14.78 / 10.99**, alert **14.76 / 11.25**, humid **12.86 / 11.58**, water **13.51 / 10.02**, mixed **14.01 / 11.31**, violet **13.92 / 11.34**. All nine AAA in both themes. Border-on-own-wash **1.39–1.76 light / 5.60–8.00 dark** (borders only, never text). Solid-on-`--card` **2.15–4.40 light** — **five** of nine below 3:1, not six; `water` 3.76 clears — **/ 5.57–8.53 dark, which is the NINE-TONE envelope and describes no single file** (reading 6 gives both per tone). The dots are decorative and `aria-hidden`, but see the 1.4.1 standing rule in Global Constraints: that is not on its own a sufficient justification.

- [ ] **Step 3: Run the edge guard and the edge suite**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npx tsx --test tests/uiCoreTokens.test.ts
npm run test:unit
```
Expected: the four new tests PASS; node-runner **115** (111 + 4); Vitest **1689 across 169 files, unchanged** (no edge `.tsx` changed yet). A Vitest change here means something other than `tokens.css` moved — STOP and report.

Then confirm the claim in the Global Constraints that a `var()` holding an `oklch()` literal survives Tailwind's arbitrary-value pipeline — **confirm it from generated CSS, do not assume it**:

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npm run build
grep -o 'background-color:var(--cal-warn-bg)' build/assets/*.css
grep -o -- '--cal-warn-bg:oklch([^)]*)' build/assets/*.css
```
Expected once T2 has a consumer: the first grep matches (Tailwind emitted the `var()` reference untouched) and the second shows the property carrying its `oklch()` text. Before T2 there is no consumer, so only the second grep matches — that is enough to prove the property survives the build; re-run the first in T2 Step 5. The cloud repeats this check in T3 Step 5 against Tailwind **3.4.19**, which is the version the ruling actually depends on.

- [ ] **Step 4: Re-vendor to osi-server IN THIS TASK (D2)**

```bash
cp /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui/src/ui-core/tokens.css \
   /home/phil/Repos/osi-server/.worktrees/agrolink/frontend/src/ui-core/tokens.css
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
OSI_SERVER_ROOT=/home/phil/Repos/osi-server/.worktrees/agrolink sh scripts/verify-ui-core-vendor.sh

cd /home/phil/Repos/osi-server/.worktrees/agrolink
EDGE_UI_CORE_ROOT=/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep sh scripts/verify-ui-core-vendor.sh
```
**The two scripts take DIFFERENT variable names and both are the checkout root, not the `ui-core` directory.** osi-os side: `OSI_SERVER_ROOT` (required) + `CANONICAL_UI_CORE_ROOT` (optional override). osi-server side: `EDGE_UI_CORE_ROOT` (required) + `VENDOR_UI_CORE_ROOT` (optional). An earlier draft of this step named `EDGE_UI_CORE_ROOT`/`SERVER_UI_CORE_ROOT` from the osi-os side and would have exited 2; the T1 implementer caught it. Both scripts `diff -ru` the **whole** `ui-core` directory, so the check is broader than a `tokens.css` comparison. Expected: `verify-ui-core-vendor: OK` and exit 0, both directions — verified working with exactly these invocations on 2026-08-06.

- [ ] **Step 5: Mirror the guard on the cloud side**

Append the same four tests to `frontend/tests/uiCoreTokensAdoption.test.ts`, reading that file first and reusing its existing path constant and imports (it has no contrast helper either — the `srgbOf`/`luminance`/`contrastRatio` trio is copied from the edge file verbatim, which is correct here: `tokens.css` is byte-mirrored and so is its guard). Run:
```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx tsx --test tests/uiCoreTokensAdoption.test.ts
npm run test:unit && npm run build
```
Expected: node-runner **101** (97 + 4); Vitest **566 across 110 files, unchanged**; build exit 0.

**Then prove the ruling on the version that depends on it.** The cloud is Tailwind **3.4.19**, and every `--cal-*` consumer T3–T6 writes is a v3 arbitrary value (`bg-[var(--cal-warn-bg)]`). Before T3 there is no consumer, so check only that the property text survives the v3 build:
```bash
grep -o -- '--cal-warn-bg:oklch([^)]*)' dist/assets/*.css
```
Expected: one match per built stylesheet. T3 Step 5 adds the consumer-side check. If the property is mangled or dropped, **STOP** — the whole M11 design rests on it.

Expected suite delta for T1: edge **+4 node-runner, 0 Vitest**; cloud **+4 node-runner, 0 Vitest, 0 files**.

- [ ] **Step 6: Commit both repos (edge first)**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add web/react-gui/src/ui-core/tokens.css web/react-gui/tests/uiCoreTokens.test.ts
git commit -m "feat(ui-core): categorical history-state palette from the edge's v4 OKLCH values (S4 T1)"

cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/ui-core/tokens.css frontend/tests/uiCoreTokensAdoption.test.ts
git commit -m "chore: re-vendor ui-core tokens after the --cal-* palette (S4 T1)"
```

---

### Task 2: Edge, tokenise the four state-colour definitions the designer batch skipped

Reading 3. These four files are the *definitions* the cloud twins copy; until they consume T1's tokens, "port the edge's classes" is an incomplete instruction. **This is the last edge change in the slice.**

**What changes visually on the edge, exhaustively.** T1's light values are these files' own Tailwind v4 OKLCH values, so every `--cal-*` substitution is a rename, not a repaint — the nine tones and the marker `-solid` fills render exactly as they do today, in the same colour space, on sRGB and on P3 alike. **Three things do move**, all of them off the `--cal-*` palette and all declared with measurements at the step that makes them: the calendar's `no_irrigation` row (Step 2), the calendar's `no_data` row losing `opacity-70` (Step 2, an AA fix), and the two gap marker dots (Step 3, a 1.03:1 shift). Nothing else. The reviewer checks this by confirming every other changed class string maps a `<hue>-<shade>` to the tone/part the reference table assigns it.

**Files:**
- Modify: `web/react-gui/src/components/history/visualizations/HistoryMonthCalendarView.tsx` (64 utilities)
- Modify: `web/react-gui/src/components/history/visualizations/IrrigationEventTimelineView.tsx` (18)
- Modify: `web/react-gui/src/components/history/visualizations/GatewayStatusOverviewView.tsx` (9)
- Modify: `web/react-gui/src/components/history/InterpretationList.tsx` (9)
- Add (test): `web/react-gui/tests/historyStateTokens.test.ts`

**Interfaces:**
- Consumes: T1's `--cal-<tone>-{bg,text,border,solid}`.
- Produces: the exact class strings T3, T4 and T5 port to the cloud. **The four modified files are the interface**; T3–T5 read them directly (reading 19). Every replacement is *also* recorded in the commit message body as `<file>:<line> <old> -> <new>`, as a convenience index into the diff — but nothing verifies that list, so no downstream task may treat it as authoritative.

- [ ] **Step 1: Write the failing guard**

Create `web/react-gui/tests/historyStateTokens.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The four files that define the history state-colour vocabulary. Their cloud
// twins port these exact class strings (S4 T3/T4/T5), so a hardcoded palette
// utility here is not a local defect — it is a defect the cloud inherits.
const DEFINITION_FILES = [
  'components/history/visualizations/HistoryMonthCalendarView.tsx',
  'components/history/visualizations/IrrigationEventTimelineView.tsx',
  'components/history/visualizations/GatewayStatusOverviewView.tsx',
  'components/history/InterpretationList.tsx',
];

const PALETTE =
  'slate|gray|grey|zinc|neutral|stone|amber|emerald|red|blue|orange|yellow|lime|green|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose';
const HARDCODED = new RegExp(
  `\\b(?:bg|text|border|ring|divide|from|to)-(?:\\[#[0-9a-fA-F]{3,8}\\]|(?:${PALETTE})-\\d{2,3}|white|black)\\b`,
  'g',
);

test('the history state-colour definitions use tokens, not palette literals', () => {
  const srcRoot = path.resolve(import.meta.dirname, '../src');
  const offenders: string[] = [];
  for (const rel of DEFINITION_FILES) {
    const source = fs.readFileSync(path.join(srcRoot, rel), 'utf8');
    for (const hit of source.match(HARDCODED) ?? []) offenders.push(`${rel}: ${hit}`);
  }
  assert.deepEqual(offenders, []);
});

// A *-border token is a border. Measured against its own wash it is 1.39–1.74
// in light theme, so it can never carry text or an icon glyph.
test('no --cal-*-border token appears in a foreground utility', () => {
  const srcRoot = path.resolve(import.meta.dirname, '../src');
  const offenders: string[] = [];
  const misuse = /(?:text|placeholder|caret|decoration|fill|stroke)-\[var\(--cal-[a-z]+-(?:border|solid)\)\]/;
  for (const rel of DEFINITION_FILES) {
    const source = fs.readFileSync(path.join(srcRoot, rel), 'utf8');
    if (misuse.test(source)) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});
```

Run:
```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npx tsx --test tests/historyStateTokens.test.ts
```
Expected: FAIL, first test only, with **exactly 100 offender strings** (64 + 18 + 9 + 9). A different total means the files moved since this plan was written — report the real number, do not adjust the plan silently.

**State what this guard does NOT cover, in the file, so nobody reads it as an edge-wide fence (L2).** `DEFINITION_FILES` is four paths. Reading 3 found palette hits in **seven** edge history/analysis files; the other three — `visualizations/DendroStressEventsView.tsx` (9 hits), `mobile/HistoryExportSheet.tsx` (1), `mobile/HistoryInspectorSheet.tsx` (1) — are deliberately out of scope, so **11 offenders survive this task and this guard by design**. Put that sentence and the count in a comment above `DEFINITION_FILES`; **T11 ledger item 6** carries the same three files. (The comment as committed at `1b3c9d6e` says "item 3", a stale number from an earlier ledger ordering; the correct item is 6. Harmless in a comment, but do not propagate it.)

- [ ] **Step 2: Rewrite `HistoryMonthCalendarView.tsx`'s `stateTone` map**

Replace lines **44-65** — `const stateTone` opens at `:44` and the closing `};` is at `:65`. (An earlier draft said 44-64, which drops the closing brace and leaves a syntax error.) Verify before editing:
```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
sed -n '44p;65p' src/components/history/visualizations/HistoryMonthCalendarView.tsx
```
Expected: `const stateTone: Record<HistoryCalendarState, string> = {` and `};`.

```tsx
const stateTone: Record<HistoryCalendarState, string> = {
  dry_stress: 'border-[var(--cal-warn-border)] bg-[var(--cal-warn-bg)] text-[var(--cal-warn-text)]',
  optimal: 'border-[var(--cal-good-border)] bg-[var(--cal-good-bg)] text-[var(--cal-good-text)]',
  wet_excess: 'border-[var(--cal-cool-border)] bg-[var(--cal-cool-bg)] text-[var(--cal-cool-text)]',
  mixed: 'border-[var(--cal-mixed-border)] bg-[var(--cal-mixed-bg)] text-[var(--cal-mixed-text)]',
  normal_growth: 'border-[var(--cal-good-border)] bg-[var(--cal-good-bg)] text-[var(--cal-good-text)]',
  reduced_growth: 'border-[var(--cal-warn-border)] bg-[var(--cal-warn-bg)] text-[var(--cal-warn-text)]',
  high_shrinkage_stress: 'border-[var(--cal-bad-border)] bg-[var(--cal-bad-bg)] text-[var(--cal-bad-text)]',
  incomplete_night_recovery: 'border-[var(--cal-alert-border)] bg-[var(--cal-alert-bg)] text-[var(--cal-alert-text)]',
  normal: 'border-[var(--cal-good-border)] bg-[var(--cal-good-bg)] text-[var(--cal-good-text)]',
  heat_stress: 'border-[var(--cal-bad-border)] bg-[var(--cal-bad-bg)] text-[var(--cal-bad-text)]',
  cold_stress: 'border-[var(--cal-cool-border)] bg-[var(--cal-cool-bg)] text-[var(--cal-cool-text)]',
  high_humidity: 'border-[var(--cal-humid-border)] bg-[var(--cal-humid-bg)] text-[var(--cal-humid-text)]',
  rain_day: 'border-[var(--cal-water-border)] bg-[var(--cal-water-bg)] text-[var(--cal-water-text)]',
  no_irrigation: 'border-[var(--border)] bg-[var(--surface)] text-[var(--text)]',
  irrigation_event: 'border-[var(--cal-water-border)] bg-[var(--cal-water-bg)] text-[var(--cal-water-text)]',
  high_irrigation_frequency: 'border-[var(--cal-warn-border)] bg-[var(--cal-warn-bg)] text-[var(--cal-warn-text)]',
  possible_ineffective_irrigation: 'border-[var(--cal-alert-border)] bg-[var(--cal-alert-bg)] text-[var(--cal-alert-text)]',
  manual_override: 'border-[var(--cal-violet-border)] bg-[var(--cal-violet-bg)] text-[var(--cal-violet-text)]',
  offline: 'border-[var(--cal-bad-border)] bg-[var(--cal-bad-bg)] text-[var(--cal-bad-text)]',
  no_data: 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-tertiary)]',
};
```

All eighteen chromatic rows are pure renames onto this file's own colours — the nine `--cal-*` tones carry the verbatim v4 OKLCH values these very lines already resolve to. Only the two neutral rows move. **`manual_override` stays violet** — it maps to the ninth tone `--cal-violet-*`, not to `--cal-mixed-*` (purple). Reading 6 withdrew the purple/violet collapse: the edge renders `violet-*` here and so does the cloud, so collapsing would have moved a light colour on both sides, which M11 forbids for the edge.

Two deliberate deviations from a pure mechanical swap, both required, and these two are **the only rows whose edge light rendering changes**:
- `no_irrigation` was `border-slate-300 bg-slate-50 text-slate-900`, which measures **17.04** as rendered today (v4 `slate-900` `#0F172B` on v4 `slate-50` `#F8FAFC`). The token form is `--text` on `--surface` = **15.16 L / 15.85 D**. The wash goes from near-white to the grey `--surface` (`#E8EDF2`), which is a visible change and is the point: an "ordinary, nothing-happened" calendar cell must use the page's own neutral surface, not a second definition of one. Still AAA.
- `no_data` **drops `opacity-70`**. Reading 6: with the multiplier the cell renders at **2.78:1 light / 3.76:1 dark**, an AA failure in both themes. Without it, `--text-tertiary` on `--surface` is **5.12 / 6.27** and still reads as the muted cell it is meant to be. This is a fix, not a port — say so in the commit message.

- [ ] **Step 3: Rewrite the same file's `markerTone` map**

Replace lines **67-75** (`const markerTone` at `:67`, closing `};` at `:75` — verify with `sed -n '67p;75p' …` as in Step 2) with:

```tsx
const markerTone: Record<string, string> = {
  irrigation: 'bg-[var(--cal-water-solid)]',
  irrigation_event: 'bg-[var(--cal-water-solid)]',
  rain: 'bg-[var(--cal-cool-solid)]',
  heat_event: 'bg-[var(--cal-bad-solid)]',
  sensor_gap: 'bg-[var(--text-disabled)]',
  data_gap: 'bg-[var(--text-disabled)]',
  manual_override: 'bg-[var(--cal-violet-solid)]',
};
```

**Five of the seven dots are byte-stable and two move a hair; say which, do not present the whole map as a no-op.** The map today is `bg-blue-500`, `bg-sky-500`, `bg-red-500`, `bg-violet-500` and `bg-slate-400`. `--cal-<tone>-solid` **is** the tone's verbatim v4 `-500`, so `irrigation`, `irrigation_event`, `rain`, `heat_event` and `manual_override` render the identical colour in light theme (this is exactly why reading 6 added the fourth `-solid` part — an earlier draft mapped these onto `-border`, i.e. the `-300` shade, which would have washed out every marker dot on the calendar while claiming to change nothing).

`sensor_gap` and `data_gap` have **no tone** — they are neutral, and `bg-slate-400` has no `--cal-*` home. They go to `--text-disabled`: v4 `slate-400` is `#90A1B9`, `--text-disabled` light is `#94A3B8`, a **1.03:1** ratio between the two, i.e. below the perceptual threshold on a 6 px dot. Against `--card` the dot measures **2.56 L / 3.10 D**.

**Two corrections to the justification, both maintainer-ruled 2026-08-06 — do not restore the earlier wording, and do not reuse it as precedent elsewhere in the migration.**

*Numeric.* "the five toned dots measure 5.57–8.53" against dark `--card` is a **mislabel**: 5.57–8.53 is the range across all **nine** tones (bookended by `bad` 5.57 and `humid` 8.53). This file's toned dots are a subset and do not span it — their measured range is **5.57–7.19**, because `humid` is not among them. State the per-tone figures for the tones this file actually uses, or state the subset's true range — never quote the nine-tone envelope as if it described a file. Reading 6 now carries both the envelope and the per-tone breakdown, and the rule against mislabelling one as the other.

*Reasoning.* **This is now a standing rule binding on every task — see Global Constraints, which is where it lives; the paragraph below is the case that produced it.** "All seven are `aria-hidden` and paired with a translated label in the DOM, so nothing is conveyed by colour alone (WCAG 1.4.1)" **conflates two different guarantees.** 1.4.1 forbids colour as the only **visual** means of conveying information; an `aria-label` is not a visual means, so it satisfies a screen-reader user and does nothing for a sighted one. The two consumers differ and must be reasoned about separately:

- `IrrigationEventTimelineView.tsx:297` renders its severity dot beside a **visible** text chip (`:307-309`). Colour is redundant there. The 1.4.1 argument holds, and this is where T2's emerald/sky sub-3:1 crossings live — hence they are acceptable.
- `HistoryMonthCalendarView.tsx:149` has **no visible** label; the marker text exists only inside `dayAriaLabel`. For a sighted farmer the dot's colour *is* the sole visual carrier, so the 1.4.1 argument does **not** hold here.

S4 does not make the calendar case worse — `-solid` is the verbatim `-500`, so those dots are byte-stable — and that is the only reason it may ship. It is **pre-existing, carried forward knowingly, and ledgered** (T11), not blessed. Tokenising a value does not make it correct; it gives it a name. Any later task that changes a calendar marker dot re-opens this and needs a fresh ruling.

- [ ] **Step 4: Sweep the remaining hits in the same file, then the other three**

The file has 64 hits; Steps 2-3 cover the two maps. Find the rest with the **same palette alternation the guard uses** — the narrower hue list an earlier draft carried here would miss `gray|grey|neutral|stone|yellow|lime|green|indigo|fuchsia|pink|rose`, so a stray `text-gray-500` would survive the sweep and then fail the guard in Step 5 with no locating output:

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
PALETTE='slate|gray|grey|zinc|neutral|stone|amber|emerald|red|blue|orange|yellow|lime|green|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose'
grep -nE "\\b(bg|text|border|ring|divide|from|to)-(\\[#[0-9a-fA-F]{3,8}\\]|($PALETTE)-[0-9]{2,3}|white|black)\\b" \
  src/components/history/visualizations/HistoryMonthCalendarView.tsx \
  src/components/history/visualizations/IrrigationEventTimelineView.tsx \
  src/components/history/visualizations/GatewayStatusOverviewView.tsx \
  src/components/history/InterpretationList.tsx
```
To **count** rather than locate, use `grep -oE … | wc -l`. **Never `grep -c`**: `-c` counts matching *lines* and overrides `-o`, so `grep -coE` silently under-reports every line that carries two utilities — which is most JSX class strings.

Apply the chromatic fallback map (hue **and** shade) from the reference section. `IrrigationEventTimelineView.tsx:186-196`, `GatewayStatusOverviewView.tsx:228-230` and `InterpretationList.tsx:12-14` are all severity triads of the same amber/red/emerald shape — map them to `--cal-warn-*`, `--cal-bad-*`, `--cal-good-*`, picking the **part** by shade. `IrrigationEventTimelineView.tsx:316`'s `bg-white` becomes `bg-[var(--card)]`; its `ring-amber-100`/`ring-red-100`/`ring-emerald-100`/`ring-sky-100` halos become `ring-[var(--cal-<tone>-bg)]` (a `-100` wash used as a ring is a fill, not a foreground — this does not trip `errorTokenMisuse`, which fences `text|placeholder|caret|decoration|fill|stroke` only; confirm by re-running the guard).

- [ ] **Step 5: Run the edge guards and the full edge suite**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npx tsx --test tests/historyStateTokens.test.ts
npx tsx --test tests/noInertTokenAlpha.test.ts tests/errorTokenMisuse.test.ts tests/pageShellTokens.test.ts
npm run test:unit
```
Expected: all guards PASS; node-runner **117** (115 after T1, plus the two tests in the one file Step 1 added); Vitest **1689 across 169 files** — the edge has component tests for `HistoryMonthCalendarView` (`src/components/history/__tests__/HistoryMonthCalendarView.test.tsx`) and for the calendar views generally. **If any of those tests assert on a palette class string, they fail here.** Read the failure and update the assertion to the token string in the same commit; do NOT weaken an assertion to make it pass, and report any test whose failure is about behaviour rather than a class name.

State the measured node-runner number. If it is 116, one of the two tests did not register — that is exactly the drift this rule exists to catch, so investigate rather than accepting a green run.

Also re-run T1 Step 3's consumer-side build check, which only became meaningful now that a file consumes the tokens:
```bash
npm run build && grep -o 'background-color:var(--cal-warn-bg)' build/assets/*.css
```
Expected: at least one match. Zero means Tailwind v4 dropped the arbitrary value and the whole `--cal-*` design is unproven — STOP.

Expected suite delta for T2: edge **+2 node-runner** (one new file), **0 Vitest net**.

**Why 0 Vitest net, stated so a green run with the wrong number is caught (L4).** This task adds no spec file and no `it(...)`. It *does* change class strings that existing specs assert on, so the expected work is **editing assertions inside existing tests**, one line for one line. A **+N** here means an executor added a test that was not planned (name it and say why); a **−N** means an assertion was deleted rather than updated, which is the failure mode the rule exists to catch. Either way, report the number rather than adjusting the target.

- [ ] **Step 6: Commit, with the replacement list in the body**

**The template below shipped a claim that was measurably false and it is kept only as the record of what T2 committed.** "Three visual changes on the edge, all deliberate, and there are no others" was disproven by T2's reviewer: the shade→part map produced **13 more** — six `-900`→`-950` darkenings, four ring palings and three marker-dot lightenings, two of which cross below 3:1. The commit body was corrected in T2's fix round 1. **Do not reuse this template's "and there are no others" shape in any later commit** without the non-identity enumeration the fallback map now mandates.

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add web/react-gui/src/components/history web/react-gui/tests/historyStateTokens.test.ts
git commit -F - <<'MSG'
fix(gui): tokenise the four history state-colour definitions (S4 T2)

The nine --cal-* tones carry these files' OWN Tailwind v4 oklch() values
(maintainer ruling M11), so every toned substitution is a rename and the
light rendering of those rows is unchanged, on sRGB and on P3 alike. Dark
theme goes from unreadable to AA/AAA. It is the CLOUD that converges onto
these values in T3-T6, shifting off its v3 hex palette; see reading 6 for
the per-tone size of that shift.

Three visual changes on the edge, all deliberate, and there are no others:
- no_irrigation moves from slate-900-on-slate-50 (17.04) to --text on
  --surface (15.16 L / 15.85 D): an ordinary cell now uses the page's own
  neutral surface instead of a second definition of one.
- no_data drops opacity-70 (measured 2.78:1 light / 3.76:1 dark with it,
  5.12 / 6.27 without) - an inherited AA failure, fixed rather than ported.
- the sensor_gap / data_gap marker dots move from slate-400 to
  --text-disabled, a 1.03:1 shift on a 6px aria-hidden dot. The other five
  dots use --cal-<tone>-solid, which IS the verbatim -500 they render today.

manual_override stays violet (--cal-violet-*), not purple: the earlier
purple/violet collapse was withdrawn because it moved a light colour on both
sides.

Replacements (an index into this diff, NOT the source of truth for T3/T4/T5 —
those tasks read the files themselves, see reading 19):
<paste the full <file>:<line> <old> -> <new> list here>
MSG
```

---

### Task 3: Cloud `CalendarView` — port T2's classes AND restore the four collapsed severity states

Reading 4. This task is not mechanical: the cloud's `stateTone` has silently merged four of the edge's distinctions, and tokenising the merged map would preserve the defect.

**Files:**
- Modify: `frontend/src/components/history/CalendarView.tsx` (67 utilities)
- Add (test): `frontend/src/components/history/__tests__/CalendarViewStateTones.test.tsx`

**Interfaces:**
- Consumes: T1's tokens and **the four edge files T2 modified** — read them, do not read T2's commit body as an authority (reading 19).
- Produces: nothing other tasks import.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/components/history/__tests__/CalendarViewStateTones.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { stateTone } from '../CalendarView';

// The cloud's map had silently merged four of the edge's severity distinctions
// (S4 reading 4): high_shrinkage_stress and incomplete_night_recovery both
// rendered amber-400 where the edge renders red and orange, so on the dendro
// calendar the severe state was indistinguishable from the mild one.
describe('CalendarView stateTone', () => {
  it('uses only --cal-* / neutral tokens, never a palette literal', () => {
    for (const [state, classes] of Object.entries(stateTone)) {
      expect(classes, state).not.toMatch(
        /\b(?:bg|text|border)-(?:\[#|(?:slate|amber|emerald|red|blue|orange|sky|cyan|violet|purple)-\d)/,
      );
    }
  });

  // NOTE what this does and does not catch. It compares tone STRINGS for
  // inequality, so it catches the reading-4 defect exactly (two states sharing
  // one entry) and nothing else: it cannot tell whether two different token
  // sets resolve to two distinguishable colours, and it would pass if two tones
  // were assigned near-identical values. The colour distinctness itself is
  // carried by reading 6's measured table and by the walkthrough, not here.
  it('assigns a distinct tone string to every state within a card type', () => {
    // Per-card-type state sets, read from the CLOUD's
    // frontend/src/history/cardDefinitions.ts:24, 48-54, 77, 95-101, 123 --
    // NOT the edge's. The two differ in exactly one place: the cloud's soil
    // card declares `mixed` and the edge's does not, so `mixed` is an
    // ORPHANED state on the edge (present in HistoryCalendarState and in
    // stateTone, reachable from no edge card). Ledgered in T11 item 1.
    const byCard: Record<string, string[]> = {
      soil: ['dry_stress', 'optimal', 'wet_excess', 'mixed', 'no_data'],
      dendro: ['normal_growth', 'reduced_growth', 'high_shrinkage_stress', 'incomplete_night_recovery', 'no_data'],
      environment: ['normal', 'heat_stress', 'cold_stress', 'high_humidity', 'rain_day', 'no_data'],
      irrigation: ['no_irrigation', 'irrigation_event', 'high_irrigation_frequency', 'possible_ineffective_irrigation', 'manual_override'],
      gateway: ['normal', 'offline', 'no_data'],
    };
    for (const [card, states] of Object.entries(byCard)) {
      const tones = states.map((state) => stateTone[state as keyof typeof stateTone]);
      expect(new Set(tones).size, `${card} collapses two states onto one tone`).toBe(states.length);
    }
  });

  it('matches the edge severity assignment for the four states the cloud had merged', () => {
    expect(stateTone.high_shrinkage_stress).toContain('--cal-bad-');
    expect(stateTone.incomplete_night_recovery).toContain('--cal-alert-');
    expect(stateTone.possible_ineffective_irrigation).toContain('--cal-alert-');
    expect(stateTone.high_irrigation_frequency).toContain('--cal-warn-');
  });

  // The purple/violet collapse was withdrawn (reading 6): manual_override is
  // violet on BOTH sides today, so collapsing it onto --cal-mixed- would have
  // moved a light colour on the edge, which M11 forbids.
  it('keeps manual_override on the violet tone and mixed on purple', () => {
    expect(stateTone.manual_override).toContain('--cal-violet-');
    expect(stateTone.mixed).toContain('--cal-mixed-');
  });
});
```

`stateTone` is currently a module-private const — export it in Step 2. Run:
```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx vitest run --environment jsdom src/components/history/__tests__/CalendarViewStateTones.test.tsx
```
Expected: FAIL at the import (`stateTone` is not exported). After exporting it **without changing the values**, all four fail, each for its own reason: test 1 on the first state it reaches (every one of the twenty cloud entries carries a `border-<hue>-<digit>` literal, so the loop trips immediately); test 2 on `dendro` (4 non-`no_data` states, 3 distinct tone strings) and `irrigation` (5 states, 4 distinct); test 3 on all four assertions; test 4 on both. Confirm each failure message before writing Step 2 — a suite that fails only at the import has proved nothing about the map.

- [ ] **Step 2: Export `stateTone` and replace it with T2's map**

`frontend/src/components/history/CalendarView.tsx:17` becomes `export const stateTone: Record<HistoryCalendarState, string> = {` and the twenty entries become **byte-identical to the edge's map after T2**. Copy them out of `web/react-gui/src/components/history/visualizations/HistoryMonthCalendarView.tsx:44-65` at the T2 commit, do not retype and do not copy from the commit message. Verify byte-identity afterwards:
```bash
diff <(sed -n '/^const stateTone/,/^};/p' \
        /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui/src/components/history/visualizations/HistoryMonthCalendarView.tsx) \
     <(sed -n '/^export const stateTone/,/^};/p' \
        /home/phil/Repos/osi-server/.worktrees/agrolink/frontend/src/components/history/CalendarView.tsx)
```
Expected: a single hunk differing only in the `export ` keyword on the opening line. Anything else is a transcription error.

- [ ] **Step 3: Add the `markerTone` dots the cloud never had**

The cloud renders markers as `<li>` text labels (`CalendarView.tsx:109-115`) where the edge renders coloured dots plus labels. Port the edge's `markerTone` map byte-identically — read it from `HistoryMonthCalendarView.tsx:67-75` after T2 — and render the dot before the label:

```tsx
{Array.isArray(day.markers) && day.markers.length > 0 && (
  <ul className="mt-1 space-y-0.5">
    {day.markers.map((marker, index) => {
      const key = typeof marker === 'string' ? marker : marker.labelKey;
      return (
        <li key={`${key}-${index}`} className="flex items-center gap-1 text-xs font-medium">
          <span
            className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${markerTone[key] ?? 'bg-[var(--text-disabled)]'}`}
            aria-hidden
          />
          {markerLabel(t, marker, cardType)}
        </li>
      );
    })}
  </ul>
)}
```
The dot is `aria-hidden` and the translated label is the accessible name, so no information is colour-only.

- [ ] **Step 4: Sweep the file's remaining hits**

67 total; Steps 2-3 cover the two maps. Apply the chromatic fallback map (hue **and** shade) to the rest. Verify with `-oE … | wc -l`, never `-cE` (`-c` counts lines and overrides `-o`):
```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
PALETTE='slate|gray|grey|zinc|neutral|stone|amber|emerald|red|blue|orange|yellow|lime|green|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose'
grep -oE "\\b(bg|text|border|ring|divide|from|to)-(\\[#[0-9a-fA-F]{3,8}\\]|($PALETTE)-[0-9]{2,3}|white|black)\\b" \
  src/components/history/CalendarView.tsx | wc -l
```
Expected: **0**.

- [ ] **Step 5: Run the tests**

**MANDATORY VERIFICATION ITEM — enumerate and measure this task's non-identity map hits.** Not a footnote and not satisfiable by "mapped per the table". See the ⚠ warning at the chromatic fallback map: the shade→part rows repaint whenever the source shade is not the shade the target part holds, and T2 shipped 13 such changes while its brief, commit body and report all said there were none. Produce, in the execution report and the commit body:
1. the grep that locates every non-identity source shade in this task's files, re-run now rather than copied from the plan:
```bash
PALETTE='amber|emerald|red|blue|orange|cyan|sky|violet|purple|teal|yellow|lime|green|indigo|fuchsia|pink|rose'
grep -rnoE "\\b(bg|text|border|ring|divide|from|to)-($PALETTE)-(100|200|400|600|700|800|900)\\b" src/components/history/CalendarView.tsx
```
2. one line per hit: `file:line  <old> -> <new>  <before ratio> -> <after ratio>` against the background it actually renders on;
3. for any hit that ends below **3:1**, the per-consumer 1.4.1 answer required by the Global Constraints standing rule — name the visible non-colour carrier and its source line, or say there isn't one and stop for a ruling.

An empty enumeration is a legitimate result **only** with the grep output that establishes it.


```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx vitest run --environment jsdom src/components/history
npm run test:unit && npm run build
```
Expected: the four new tests PASS; existing history component tests stay green (read any failure — if one asserts on a palette class, update the assertion in this commit and say so; if one asserts on behaviour, STOP). Cloud node-runner **101** unchanged from T1; Vitest **570 across 111 files**.

**Prove the M11 mechanism on Tailwind 3.4.19**, which is the version the ruling depends on and the first task with a cloud consumer of the tokens:
```bash
npm run build
grep -o 'background-color:var(--cal-warn-bg)' dist/assets/*.css
grep -o -- '--cal-warn-bg:oklch([^)]*)' dist/assets/*.css
```
Expected: both match. The first shows v3 compiled `bg-[var(--cal-warn-bg)]` to a bare `var()` reference (it never parses the property's value, so the `oklch()` inside is invisible to it); the second shows the property still carrying its `oklch()` text. If either is empty, **STOP** — the light values cannot be OKLCH on the cloud and the ruling needs re-opening, not a workaround.

Expected suite delta for T3: cloud **0 node-runner, +4 Vitest, +1 Vitest file**.

- [ ] **Step 6: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/components/history/CalendarView.tsx frontend/src/components/history/__tests__/CalendarViewStateTones.test.tsx
git commit -m "fix: cloud calendar tokens + restore the four merged severity states (S4 T3)"
```

**No mutating handler is added or moved by this task.** The reviewer verifies this from the diff: `CalendarView` takes no callback props and renders no interactive element.

---

### Task 4: Cloud history chrome — port the already-tokenised edge twins

Eight files, 192 utilities. Every one of these has an edge twin at zero palette hits (six from the 2026-08-06 designer batch, `InterpretationList` from T2), so the instruction is **port the edge's class string for the corresponding element**; the fallback map applies only to cloud-only lines.

**Files:**
- Modify: `frontend/src/components/history/{HistoryCardFrame,HistorySidebar,HistoryDesktopShell,HistoryMobileShell,AdvancedViewPanel,InterpretationList,TimelineBrush,HistoryExportSheet}.tsx`

**Interfaces:** none; class strings only. **Zero mutating handlers added or moved** — the reviewer verifies this by confirming the diff contains no new `on[A-Z]` prop, no new `useState` setter call site, and no change to any existing handler body.

- [ ] **Step 1: Establish the per-file baseline count**

**Use `grep -oE … | wc -l`. Not `grep -coE`:** `-c` counts matching *lines* and silently overrides `-o`, so every class string carrying two utilities is counted once and the whole table under-reports.

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend/src
PALETTE='slate|gray|grey|zinc|neutral|stone|amber|emerald|red|blue|orange|yellow|lime|green|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose'
for f in HistoryCardFrame HistorySidebar HistoryDesktopShell HistoryMobileShell AdvancedViewPanel InterpretationList TimelineBrush HistoryExportSheet; do
  printf '%-24s %s\n' "$f" "$(grep -oE "\\b(bg|text|border|ring|divide|from|to)-(\\[#[0-9a-fA-F]{3,8}\\]|($PALETTE)-[0-9]{2,3}|white|black)\\b" components/history/$f.tsx | wc -l)"
done
```
Expected: `HistoryCardFrame 54`, `HistorySidebar 47`, `HistoryDesktopShell 28`, `HistoryMobileShell 21`, `AdvancedViewPanel 15`, `InterpretationList 13`, `TimelineBrush 6`, `HistoryExportSheet 8` — 192 total. Any file whose count differs from the plan is drift: report the real number, do not force-fit.

- [ ] **Step 2: Port file by file, diffing against the edge twin first**

For each file, before editing:
```bash
diff -u /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui/src/components/history/<F>.tsx \
        /home/phil/Repos/osi-server/.worktrees/agrolink/frontend/src/components/history/<F>.tsx
```
These are **near-twins, not byte-copies** — the cloud files are larger (`HistoryDesktopShell` 494 vs 259, `HistoryCardFrame` 334 vs 214, `HistorySidebar` 269 vs 238). Where the diff shows the same element on both sides, take the edge's class string verbatim. Where the cloud has an element the edge does not, apply the fallback map. Do not restructure, do not rename, do not "improve" markup — this task changes class strings and nothing else.

`InterpretationList.tsx` is the one file whose edge twin only becomes tokenised in T2; read its severity triad out of `web/react-gui/src/components/history/InterpretationList.tsx:12-14` after T2 has landed, not out of T2's commit message (reading 19).

`HistoryExportSheet.tsx` has no line-for-line edge twin (the edge's is `components/history/mobile/HistoryExportSheet.tsx`, a different composition). Use the fallback map throughout and say so in the commit message.

- [ ] **Step 3: Verify zero remaining, and no inert alpha**

**MANDATORY VERIFICATION ITEM — enumerate and measure this task's non-identity map hits.** Not a footnote and not satisfiable by "mapped per the table". See the ⚠ warning at the chromatic fallback map: the shade→part rows repaint whenever the source shade is not the shade the target part holds, and T2 shipped 13 such changes while its brief, commit body and report all said there were none. Produce, in the execution report and the commit body:
1. the grep that locates every non-identity source shade in this task's files, re-run now rather than copied from the plan:
```bash
PALETTE='amber|emerald|red|blue|orange|cyan|sky|violet|purple|teal|yellow|lime|green|indigo|fuchsia|pink|rose'
grep -rnoE "\\b(bg|text|border|ring|divide|from|to)-($PALETTE)-(100|200|400|600|700|800|900)\\b" src/components/history/{HistoryCardFrame,HistorySidebar,HistoryDesktopShell,HistoryMobileShell,AdvancedViewPanel,InterpretationList,TimelineBrush,HistoryExportSheet}.tsx
```
2. one line per hit: `file:line  <old> -> <new>  <before ratio> -> <after ratio>` against the background it actually renders on;
3. for any hit that ends below **3:1**, the per-consumer 1.4.1 answer required by the Global Constraints standing rule — name the visible non-colour carrier and its source line, or say there isn't one and stop for a ruling.

An empty enumeration is a legitimate result **only** with the grep output that establishes it.


```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
PALETTE='slate|gray|grey|zinc|neutral|stone|amber|emerald|red|blue|orange|yellow|lime|green|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose'
for f in HistoryCardFrame HistorySidebar HistoryDesktopShell HistoryMobileShell AdvancedViewPanel InterpretationList TimelineBrush HistoryExportSheet; do
  printf '%-24s %s\n' "$f" "$(grep -oE "\\b(bg|text|border|ring|divide|from|to)-(\\[#[0-9a-fA-F]{3,8}\\]|($PALETTE)-[0-9]{2,3}|white|black)\\b" src/components/history/$f.tsx | wc -l)"
done
npx tsx --test tests/noInertTokenAlpha.test.ts tests/errorTokenMisuse.test.ts tests/pageShellTokens.test.ts
```
Expected: all eight report **0**; all three guards PASS. `HistoryMobileShell.tsx:81` contains a `min-h-screen` shell, so `pageShellTokens` is live on it — **and it is already correct at this head**: the class string reads `min-h-screen bg-[var(--bg)] p-4 md:hidden`. Leave it alone. This file's 21 hits are in the header and card chrome below it (`border-slate-200 bg-white`, `text-slate-950`, `text-slate-500`, …), not in the shell. If a port changes `:81`, that is a regression, not the task.

- [ ] **Step 4: Run the suites**

```bash
npm run test:unit && npm run build
```
Expected: node-runner **101**, Vitest **570 across 111 files**, both unchanged from T3; build exit 0. (If T4 runs in parallel with T3 rather than after it — reading 19 allows that — the Vitest baseline is **566 / 110** instead; state which ordering you ran.) The cloud has component tests for `HistoryCardFrame` (six variants) and `TimelineBrush` — if one asserts on a palette class, update the assertion here and name it in the commit; if one asserts on behaviour, STOP.

Expected suite delta for T4: **0 / 0 / 0.** A task that changes 192 class strings and moves no counter is exactly right; a moved counter means something other than a class string changed.

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/components/history
git commit -m "fix: port the edge's tokenised classes onto the cloud history chrome (S4 T4, 192 utilities)"
```

---

### Task 5: Cloud history visualizations — port the edge twins

Five files, 119 utilities. `GatewayStatusOverviewView` and `IrrigationEventTimelineView` take their severity triads from T2; the other three have edge twins already at zero.

**Files:**
- Modify: `frontend/src/components/history/visualizations/{GatewayStatusOverviewView,IrrigationEventTimelineView,DendroGrowthTimelineView,EnvironmentLineChartView,SoilProfileView}.tsx`

**Interfaces:** none. **Zero mutating handlers added or moved**, verified from the diff as in T4.

- [ ] **Step 1: Baseline counts**

Same command shape as T4 Step 1 over `components/history/visualizations/` — **`grep -oE … | wc -l`, never `grep -coE`**. Expected: `GatewayStatusOverviewView 38`, `IrrigationEventTimelineView 29`, `DendroGrowthTimelineView 26`, `EnvironmentLineChartView 13`, `SoilProfileView 13` — 119 total.

- [ ] **Step 2: Port, diffing against the edge twin first**

`diff -u` each against `web/react-gui/src/components/history/visualizations/<F>.tsx`. Diff sizes at this head: `GatewayStatusOverviewView` 67 changed lines, `IrrigationEventTimelineView` 29, `DendroGrowthTimelineView` 152, `EnvironmentLineChartView` 152, `SoilProfileView` 96 — so the last three are substantially diverged and the fallback map will do most of the work there.

**One judgement call, stated so it is not made silently.** `SoilProfileView` is the natural consumer of the `--soil-wet/-moist/-dry` tokens, and the edge's calendar carries a `soilCalendarBackgroundByTone` map (`HistoryMonthCalendarView.tsx:77-81` — verify with `sed -n '77p;81p' …`; an earlier draft said 76-80) using `var(--soil-*-bg)` that the cloud dropped entirely. **Do not** use `--soil-dry` or `--soil-wet` as a *text* colour on `--card`: measured **3.76** and **3.68** in light theme, both AA failures. (`--soil-moist` was darkened to 5.02 on 2026-08-06; the other two were not — ledgered in T11.) They are fills and indicator strokes only. If a soil tone must label something, use `--text` on the `-bg` wash.

- [ ] **Step 3: Verify zero remaining and run the guards**

**MANDATORY VERIFICATION ITEM — enumerate and measure this task's non-identity map hits.** Not a footnote and not satisfiable by "mapped per the table". See the ⚠ warning at the chromatic fallback map: the shade→part rows repaint whenever the source shade is not the shade the target part holds, and T2 shipped 13 such changes while its brief, commit body and report all said there were none. Produce, in the execution report and the commit body:
1. the grep that locates every non-identity source shade in this task's files, re-run now rather than copied from the plan:
```bash
PALETTE='amber|emerald|red|blue|orange|cyan|sky|violet|purple|teal|yellow|lime|green|indigo|fuchsia|pink|rose'
grep -rnoE "\\b(bg|text|border|ring|divide|from|to)-($PALETTE)-(100|200|400|600|700|800|900)\\b" src/components/history/visualizations/*.tsx
```
2. one line per hit: `file:line  <old> -> <new>  <before ratio> -> <after ratio>` against the background it actually renders on;
3. for any hit that ends below **3:1**, the per-consumer 1.4.1 answer required by the Global Constraints standing rule — name the visible non-colour carrier and its source line, or say there isn't one and stop for a ruling.

An empty enumeration is a legitimate result **only** with the grep output that establishes it.


Same commands as T4 Step 3, over `components/history/visualizations/`. Expected all five at **0**, all three guards PASS.

- [ ] **Step 4: Run the suites**

```bash
npm run test:unit && npm run build
```
Expected: node-runner **101**, Vitest **570 / 111**, build exit 0 (or **566 / 110** if T5 ran before T3 — state which). **Expected suite delta for T5: 0 / 0 / 0.**

The cloud has **no test at all** for any of these five components (verified: `frontend/src/components/history/__tests__/` contains no visualization spec, while the edge has six). That is a real coverage hole and it is **not** closed here — closing it means writing five new component suites, which belongs with the six missing visualizations in S4b. Ledgered in T11.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/history/visualizations
git commit -m "fix: port the edge's tokenised classes onto the cloud history visualizations (S4 T5, 119 utilities)"
```

---

### Task 6: Cloud analysis components + the durable component-scoped guard

Seven files, 96 utilities (`AnalysisControls` is T10's; `EChart.tsx` is byte-identical to the edge and has zero hits). All seven edge twins are at zero and the diffs are small — `AnalysisChartPanel` 6 changed lines, `AnalysisChartLegend` 10, `MetricAcrossZonesPicker` 12, `AnalysisExportMenu` 15, `CorrelationPanel` 36, `AnalysisSeriesTray` 43, `AnalysisViewsMenu` 38 — so this is the most nearly mechanical task in the slice. It also carries the guard that makes the whole migration durable.

**Files:**
- Modify: `frontend/src/components/analysis/{AnalysisChartLegend,AnalysisChartPanel,AnalysisExportMenu,AnalysisSeriesTray,AnalysisViewsMenu,CorrelationPanel,MetricAcrossZonesPicker}.tsx`
- Add (test): `frontend/tests/historyAnalysisTokens.test.ts`

**Interfaces:**
- Produces: `historyAnalysisTokens.test.ts`, the regression fence for T3–T6 and T10. T10 must keep it green.

- [ ] **Step 1: Write the guard, scoped to the whole migration surface**

Create `frontend/tests/historyAnalysisTokens.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// Files whose migration lands in a LATER task. This list is mandatory, not a
// fallback: the cloud's `test:unit` is
//   tsx --test tests/**/*.test.ts tests/**/*.test.tsx && vitest run --dir src
// so a red node-runner short-circuits the `&&` and Vitest never runs at all.
// A deliberately-red guard here would therefore break T8's and T9's
// done-conditions as well as T6's, not just this file's. S4 T10 deletes this
// list and the constant with it.
const PENDING_S4_T10 = ['components/analysis/AnalysisControls.tsx'];

// pageShellTokens.test.ts guards viewport-claiming SHELLS only — its predicate
// is /min-h-screen|h-screen|min-h-\[calc\(|h-\[100dvh\]/ — so every ordinary
// component colour escapes it. That is the half of the maintainer's cohesion
// finding S3 left open (matrix ledger, 2026-08-06). This guard closes it for
// the history/analysis surface S4 migrated: 509 palette utilities across 22
// files at cloud 33521768, 0 after S4. It is deliberately NOT the edge's
// pageShellTokens allowlist — that list holds two verified scanner false
// positives and S4 neither adds to nor removes from it.
const ROOTS = ['components/history', 'components/analysis'];

const PALETTE =
  'slate|gray|grey|zinc|neutral|stone|amber|emerald|red|blue|orange|yellow|lime|green|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose';
const HARDCODED = new RegExp(
  `\\b(?:bg|text|border|ring|divide|from|via|to|fill|stroke|placeholder|caret|decoration|outline|accent|shadow)-` +
    `(?:\\[#[0-9a-fA-F]{3,8}\\]|(?:${PALETTE})-\\d{2,3}(?:\\/\\d{1,3})?|white(?:\\/\\d{1,3})?|black(?:\\/\\d{1,3})?)\\b`,
  'g',
);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...walk(full));
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test('history and analysis components carry no hardcoded palette utility', () => {
  const srcRoot = path.resolve(import.meta.dirname, '../src');
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(path.join(srcRoot, root))) {
      const rel = path.relative(srcRoot, file);
      if (PENDING_S4_T10.includes(rel)) continue;
      for (const hit of fs.readFileSync(file, 'utf8').match(HARDCODED) ?? []) {
        offenders.push(`${rel}: ${hit}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

// The skip-list must never outlive its task: a stale entry silently exempts a
// file forever. This fails the moment T10 tokenises AnalysisControls, which is
// the prompt to delete both the entry and this test (S4 T10 Step 5).
test('every PENDING_S4_T10 entry still has something to skip', () => {
  const srcRoot = path.resolve(import.meta.dirname, '../src');
  const stale = PENDING_S4_T10.filter(
    (rel) => !(fs.readFileSync(path.join(srcRoot, rel), 'utf8').match(HARDCODED) ?? []).length,
  );
  assert.deepEqual(stale, [], 'delete the entry and this test');
});

// A --cal-*-border measures 1.39-1.76 against its own wash in light theme and
// a --cal-*-solid 2.07-4.01, so neither can carry text. Sibling of
// errorTokenMisuse's *-bg rule. This one is NOT skip-listed: AnalysisControls
// has no --cal-* usage until T10, so it cannot offend here.
test('no --cal-*-border or --cal-*-solid token is used as a foreground colour', () => {
  const srcRoot = path.resolve(import.meta.dirname, '../src');
  const misuse = /(?:text|placeholder|caret|decoration|fill|stroke)-\[var\(--cal-[a-z]+-(?:border|solid)\)\]/;
  const offenders: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(path.join(srcRoot, root))) {
      if (misuse.test(fs.readFileSync(file, 'utf8'))) offenders.push(path.relative(srcRoot, file));
    }
  }
  assert.deepEqual(offenders, []);
});
```

Run:
```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx tsx --test tests/historyAnalysisTokens.test.ts
```
Expected: FAIL, first test only, with **96 offenders** — this task's seven files. `AnalysisControls.tsx`'s 35 are excluded by `PENDING_S4_T10`, so they do not appear. If T3/T4/T5 have not landed, the number is higher; run this after them (reading 19). If it is already 0, something is wrong with the walker — verify it non-vacuously before believing it.

**T10 is the task that takes this guard to zero and deletes the skip-list.** Note that explicitly in the commit so nobody "fixes" `AnalysisControls` here and collides with T10.

**Why a skip-list and not a deliberately-red guard.** The cloud's `test:unit` is `tsx --test … && vitest run …`. A red node-runner short-circuits the `&&`, so Vitest **never executes** — which means a red guard left on the branch does not just fail T6, it makes T8's "+N Vitest" and T9's frontend `0 / 0 / 0` unverifiable, and any run of `npm run test:unit` between T6 and T10 reports a false picture. The skip-list keeps the whole pipeline green and honest, and the companion `PENDING_S4_T10 entry still has something to skip` test makes the exemption self-expiring. **This is mandatory, not a fallback to reach for if T10 slips.**

- [ ] **Step 2: Port the seven files**

`diff -u` each against `web/react-gui/src/components/analysis/<F>.tsx` and take the edge's class strings. Two specific cases:
- `AnalysisSeriesTray.tsx:121` `border-teal-300 bg-teal-50 text-slate-900` and `:137` `text-teal-600` — the edge's twin is tokenised; read what it uses and port it. These are the only three teal utilities in the surface and there is no `--cal-` teal tone, so a fallback-map guess is not acceptable here.
- Segmented-control active fills (`bg-slate-900 text-white`) become `bg-[var(--primary)] text-[var(--on-primary)]`, which is verbatim what the edge's `AnalysisControls.tsx` does after `79fcecbc`. Measured 5.17 L / 10.39 D.

- [ ] **Step 3: Verify the guard reaches zero, and that the exemption is the only reason**

**MANDATORY VERIFICATION ITEM — enumerate and measure this task's non-identity map hits.** Not a footnote and not satisfiable by "mapped per the table". See the ⚠ warning at the chromatic fallback map: the shade→part rows repaint whenever the source shade is not the shade the target part holds, and T2 shipped 13 such changes while its brief, commit body and report all said there were none. Produce, in the execution report and the commit body:
1. the grep that locates every non-identity source shade in this task's files, re-run now rather than copied from the plan:
```bash
PALETTE='amber|emerald|red|blue|orange|cyan|sky|violet|purple|teal|yellow|lime|green|indigo|fuchsia|pink|rose'
grep -rnoE "\\b(bg|text|border|ring|divide|from|to)-($PALETTE)-(100|200|400|600|700|800|900)\\b" src/components/analysis/*.tsx   # AnalysisControls.tsx is T10's; its text-amber-700 is not this task's hit
```
2. one line per hit: `file:line  <old> -> <new>  <before ratio> -> <after ratio>` against the background it actually renders on;
3. for any hit that ends below **3:1**, the per-consumer 1.4.1 answer required by the Global Constraints standing rule — name the visible non-colour carrier and its source line, or say there isn't one and stop for a ruling.

An empty enumeration is a legitimate result **only** with the grep output that establishes it.


```bash
npx tsx --test tests/historyAnalysisTokens.test.ts
PALETTE='slate|gray|grey|zinc|neutral|stone|amber|emerald|red|blue|orange|yellow|lime|green|teal|cyan|sky|indigo|violet|purple|fuchsia|pink|rose'
grep -oE "\\b(bg|text|border|ring|divide|from|to)-(\\[#[0-9a-fA-F]{3,8}\\]|($PALETTE)-[0-9]{2,3}|white|black)\\b" \
  src/components/analysis/AnalysisControls.tsx | wc -l
```
Expected: the guard's three tests all **PASS**, and the grep reports **exactly 35** — the whole remaining debt is in the one skip-listed file. Any offender the guard reports in another file is an incomplete port. A grep result other than 35 is drift: report it.

- [ ] **Step 4: Run the suites**

```bash
npm run test:unit && npm run build
```
Expected: node-runner **104** green (101 after T1, +3 from this file); Vitest **570 / 111** green; build exit 0. Because the guard is green, `test:unit`'s `&&` does not short-circuit and the Vitest half actually runs — confirm both halves reported, not just the first.

The cloud has nine analysis component tests (`src/components/analysis/__tests__/`); update any palette-class assertion here, STOP on any behavioural failure.

Expected suite delta for T6: cloud **+3 node-runner** (one new file: the palette guard, the stale-skip check, the foreground fence), **0 Vitest**. T10 removes one of the three.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/analysis frontend/tests/historyAnalysisTokens.test.ts
git commit -m "fix: port the edge's tokenised classes onto the cloud analysis components (S4 T6, 96 utilities)"
```

---

### Task 7: Cloud backend — keyset pagination and column-backed filters on the journal entry list

Readings 11–14. Port the edge's cursor trio to Postgres; offer exactly the six column-backed filters; keep the response envelope additive so T8 can adopt it without a flag day.

**Files:**
- Modify: `backend/src/main/java/org/osi/server/journal/JournalController.java`
- Modify: `backend/src/main/java/org/osi/server/journal/JournalQueryService.java`
- Add: `backend/src/main/java/org/osi/server/journal/JournalEntryFilters.java`
- Add: `backend/src/main/java/org/osi/server/journal/JournalCursor.java`
- Add: `backend/src/main/java/org/osi/server/journal/JournalEntryPage.java`
- Add (**conditional** — kept only if Step 5's `EXPLAIN` shows the planner uses it): `backend/src/main/resources/db/migration/V2026_08_06_001__journal_entries_mirror_filter_index.sql`
- Add (test): `backend/src/test/java/org/osi/server/journal/JournalCursorTest.java`
- Modify (test): `backend/src/test/java/org/osi/server/journal/JournalControllerTest.java`

**Interfaces:**
- Produces, consumed by T8:
  - **A new endpoint, `GET /api/v1/journal/gateways/{gatewayEui}/entries/page`**, returning `JournalEntryPage`: `{"entries": [...], "nextCursor": "<base64url>|null"}`. Query params: `plotUuid`, `zoneUuid`, `activityCode`, `status` (`all` | `final` | `voided`, default `all`), `occurredFrom`, `occurredTo` (ISO instants), `limit` (default 50, clamped 1..100), `cursor`.
  - **The existing `GET …/entries` is untouched** and keeps returning the bare `List<JournalView.Resource>`. An earlier draft made `/entries` return one of two shapes depending on whether "any new param is present" — that has **no presence mechanism**: `status` defaults to `all` and `limit` defaults to 50, so "was `status` supplied?" is unanswerable from the bound value, and a client sending `?status=all` would get a different *shape* from a client sending nothing while requesting the identical data. A second path removes the ambiguity entirely, costs one `@GetMapping`, and lets `listEntries` keep its contract for every existing caller.
  - `JournalCursor.encode(Instant occurredStart, String entryUuid, String filterHash) -> String` and `JournalCursor.decode(String raw, String expectedFilterHash) -> JournalCursor` (throws `ResponseStatusException(400, "invalid_cursor")`).
  - `JournalEntryFilters` is a record of **eight** components — the six filters, plus `limit`, plus `cursor`. `hash()` covers **exactly the six filters**; `limit` and `cursor` are both excluded (reading 11).

- [ ] **Step 1: Write the failing cursor test**

Create `backend/src/test/java/org/osi/server/journal/JournalCursorTest.java`:

```java
package org.osi.server.journal;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.springframework.web.server.ResponseStatusException;

class JournalCursorTest {

    private static final String HASH = "a".repeat(64);

    @Test
    void roundTripsTheSeekKey() {
        Instant occurred = Instant.parse("2026-08-06T11:22:33.444Z");
        JournalCursor decoded = JournalCursor.decode(
                JournalCursor.encode(occurred, "3f2a1b4c-0000-4000-8000-000000000001", HASH), HASH);
        assertThat(decoded.occurredStart()).isEqualTo(occurred);
        assertThat(decoded.entryUuid()).isEqualTo("3f2a1b4c-0000-4000-8000-000000000001");
    }

    // The edge binds the cursor to the filter set so a filter change cannot
    // silently resume mid-list under different predicates (api.js:466-489).
    @Test
    void rejectsACursorMintedUnderDifferentFilters() {
        String cursor = JournalCursor.encode(Instant.EPOCH, "3f2a1b4c-0000-4000-8000-000000000001", HASH);
        assertThatThrownBy(() -> JournalCursor.decode(cursor, "b".repeat(64)))
                .isInstanceOf(ResponseStatusException.class)
                .hasMessageContaining("invalid_cursor");
    }

    @Test
    void rejectsGarbage() {
        for (String raw : new String[] {"", "!!!", "eyJub3QiOiJhbiBhcnJheSJ9"}) {
            assertThatThrownBy(() -> JournalCursor.decode(raw, HASH))
                    .isInstanceOf(ResponseStatusException.class);
        }
    }

    // JournalEntryFilters.of takes EIGHT arguments: the six filters, then
    // limit, then cursor. hash() covers exactly the six filters.
    // limit is excluded so changing page size does not invalidate an
    // outstanding cursor (edge filterHash, api.js:466-472).
    @Test
    void limitDoesNotChangeTheFilterHash() {
        JournalEntryFilters fifty = JournalEntryFilters.of(null, null, null, "all", null, null, 50, null);
        JournalEntryFilters hundred = JournalEntryFilters.of(null, null, null, "all", null, null, 100, null);
        assertThat(fifty.hash()).isEqualTo(hundred.hash());
    }

    // THE ONE THAT MATTERS. cursor must be excluded from the hash too, and for
    // a sharper reason than limit: page 1 mints its nextCursor under a hash
    // computed with cursor == null, and page 2 arrives WITH that cursor. If
    // cursor were a hashed component the recomputed hash would differ, decode
    // would reject its own cursor, and EVERY second page would 400. No test
    // above catches this because they all pass a null cursor.
    @Test
    void cursorDoesNotChangeTheFilterHash() {
        JournalEntryFilters page1 = JournalEntryFilters.of("plot-1", null, null, "final", null, null, 50, null);
        JournalEntryFilters page2 = JournalEntryFilters.of(
                "plot-1", null, null, "final", null, null, 50,
                JournalCursor.encode(Instant.EPOCH, "3f2a1b4c-0000-4000-8000-000000000001", page1.hash()));
        assertThat(page2.hash()).isEqualTo(page1.hash());
        // and therefore the round trip actually works:
        assertThat(JournalCursor.decode(page2.cursor(), page2.hash()).entryUuid())
                .isEqualTo("3f2a1b4c-0000-4000-8000-000000000001");
    }

    @Test
    void anyOtherFilterChangesTheHash() {
        JournalEntryFilters base = JournalEntryFilters.of(null, null, null, "all", null, null, 50, null);
        assertThat(JournalEntryFilters.of("plot-1", null, null, "all", null, null, 50, null).hash())
                .isNotEqualTo(base.hash());
        assertThat(JournalEntryFilters.of(null, null, null, "final", null, null, 50, null).hash())
                .isNotEqualTo(base.hash());
    }
}
```

Run:
```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend
./gradlew test --tests 'org.osi.server.journal.JournalCursorTest'
```
Expected: FAIL to compile — `JournalCursor` and `JournalEntryFilters` do not exist.

- [ ] **Step 2: Write `JournalEntryFilters` and `JournalCursor`**

`JournalEntryFilters` is a record of **eight** components in this declared order:

```java
public record JournalEntryFilters(
        String plotUuid,
        String zoneUuid,
        String activityCode,
        String status,
        Instant occurredFrom,
        Instant occurredTo,
        int limit,
        String cursor) { … }
```

`of(...)` takes the same eight and normalizes: trim-to-null on every string, lowercase `status` with a default of `"all"` and rejection of anything outside `{all, final, voided}` (400, reason `invalid_filter`; reading 12 — `draft` is not a value the mirror can hold), UUID canonicalization on `plotUuid`/`zoneUuid` mirroring the edge's `canonicalUuid`, `Instant.parse` on the two timestamps with a 400 on failure, and `limit` clamped with `Math.max(1, Math.min(limit, 100))` — the repo's settled idiom, copied from `SyncDeadLetterAdminController.java:32`.

**`hash()` covers exactly the first six components.** `limit` and `cursor` are both excluded, and the exclusion of `cursor` is load-bearing rather than cosmetic: the hash's job is to bind a cursor to the predicate set it was minted under, so it must be computable *identically* on the request that mints it (no cursor) and on the request that presents it (cursor set). Include `cursor` and the endpoint 400s on every page after the first. Write the exclusion as an explicit list of six field reads, not as "all fields except the last two" — a future ninth component must then be a deliberate decision rather than a silent inclusion.

`JournalCursor` is a record `(Instant occurredStart, String entryUuid)` with `encode` writing `Base64.getUrlEncoder().withoutPadding()` over the JSON array `["<iso>","<uuid>","<hash>"]` and `decode` reversing it, checking array length 3, both first elements are strings, and element 2 equals `expectedFilterHash` — the same three-element, hash-bound shape as the edge, so a cursor is not portable across filter sets.

- [ ] **Step 3: Run the cursor test**

```bash
./gradlew test --tests 'org.osi.server.journal.JournalCursorTest'
```
Expected: **6 tests, 0 failures.**

- [ ] **Step 4: Write the failing query test, then extend `JournalQueryService`**

Add to `JournalControllerTest.java`:
- a test asserting that a filtered call produces the seek predicate and the limit, and that `nextCursor` is non-null exactly when the overfetch probe fires;
- **an end-to-end second page**: seed `limit + 1` entries, call `/entries/page`, take the returned `nextCursor`, call again with it **and the identical filter set**, and assert the second call returns 200 with the remaining rows and no overlap with page 1. This is the case the unit tests structurally cannot reach — all of them mint and decode a cursor in the same breath — and it is the one that goes red if `cursor` ever creeps into `hash()`;
- **a D5 fail-closed case (M12), two lines of assertion:** a user granted plot A requests `plotUuid=<plot B, not granted>` and gets an **empty page with a null cursor**, not plot B's entries and not a 500. The visibility predicate in `scopedQuery` already ANDs the grant set, so the filter can only ever narrow within it — but "the existing predicate covers it" is exactly the reasoning that shipped three S3 fail-opens, so assert it rather than reason it.

Then extend `JournalQueryService`.

**Step 4a — refactor `scopedQuery` so the ORDER BY is appended by the caller.** Today `scopedQuery` (`:87-128`) ends with `sql.append(" ORDER BY ").append(table.orderBy());`. Delete that line and push it to **both** existing callers — there are two, not one:

| caller | line | what it becomes |
|---|---|---|
| `list(...)` | the `jdbc.query` at `:38` | `query.sql() + " ORDER BY " + table.orderBy()` |
| `find(...)` | the `scopedQuery` call at `:50`, `jdbc.query` at `:56` | same append. `find` selects by primary key and takes `.findFirst()`, so the order is not observable — **which is exactly why it must be written explicitly**: silently dropping an ORDER BY from a method whose behaviour does not change today is how a later `find` that returns more than one row acquires a nondeterministic result. |

This is a pure refactor with no behaviour change; run `./gradlew test` before going further and confirm the backend total is unchanged at 276. Doing it this way rather than string-surgery on a finished statement is the difference between a splice that survives the next `scopedQuery` edit and one that silently produces `... ORDER BY x AND status = ?`.

**Step 4b — add the paged overload:**

```java
@Transactional(readOnly = true)
public JournalEntryPage listEntries(
        GatewayScope scope, boolean includeDeleted, JournalEntryFilters filters) {
    Table table = Table.forKind(JournalResourceKind.ENTRY);
    Query scoped = scopedQuery(table, scope, includeDeleted, null, true);

    StringBuilder sql = new StringBuilder(scoped.sql());
    List<Object> params = new ArrayList<>(scoped.params());

    if (filters.plotUuid() != null)     { sql.append(" AND plot_uuid = ?");      params.add(filters.plotUuid()); }
    if (filters.zoneUuid() != null)     { sql.append(" AND zone_uuid = ?");      params.add(filters.zoneUuid()); }
    if (filters.activityCode() != null) { sql.append(" AND activity_code = ?");  params.add(filters.activityCode()); }
    if (!"all".equals(filters.status())){ sql.append(" AND status = ?");         params.add(filters.status()); }
    // OffsetDateTime at UTC, not Timestamp.from: java.sql.Timestamp is
    // rendered through the JVM default zone by the driver, so the same Instant
    // binds to a different wall time on a machine that is not on UTC and the
    // boundary tests below pass or fail depending on the runner's TZ.
    if (filters.occurredFrom() != null) { sql.append(" AND occurred_start >= ?"); params.add(OffsetDateTime.ofInstant(filters.occurredFrom(), ZoneOffset.UTC)); }
    if (filters.occurredTo() != null)   { sql.append(" AND occurred_start <= ?"); params.add(OffsetDateTime.ofInstant(filters.occurredTo(), ZoneOffset.UTC)); }

    JournalCursor cursor = filters.cursor() == null
            ? null
            : JournalCursor.decode(filters.cursor(), filters.hash());
    if (cursor != null) {
        // Exactly complements ORDER BY occurred_start DESC, entry_uuid ASC.
        sql.append(" AND (occurred_start < ? OR (occurred_start = ? AND entry_uuid > ?))");
        params.add(OffsetDateTime.ofInstant(cursor.occurredStart(), ZoneOffset.UTC));
        params.add(OffsetDateTime.ofInstant(cursor.occurredStart(), ZoneOffset.UTC));
        params.add(cursor.entryUuid());
    }

    sql.append(" ORDER BY ").append(table.orderBy()).append(" LIMIT ?");
    params.add(filters.limit() + 1); // overfetch probe, as the edge does

    List<EntryRow> rows = jdbc.query(
            sql.toString(),
            (resultSet, rowNumber) -> new EntryRow(
                    decode(resultSet.getString(1)),
                    resultSet.getTimestamp("occurred_start").toInstant(),
                    resultSet.getString("entry_uuid")),
            params.toArray());

    boolean hasMore = rows.size() > filters.limit();
    if (hasMore) rows = rows.subList(0, filters.limit());
    EntryRow last = rows.isEmpty() ? null : rows.get(rows.size() - 1);
    String nextCursor = hasMore && last != null
            ? JournalCursor.encode(last.occurredStart(), last.entryUuid(), filters.hash())
            : null;
    return new JournalEntryPage(rows.stream().map(EntryRow::aggregate).toList(), nextCursor);
}

private record EntryRow(Map<String, Object> aggregate, Instant occurredStart, String entryUuid) {}
```

**Note the projection dependency:** `scopedProjection` currently selects `aggregate_json::text` alone, so `resultSet.getString("occurred_start")` would throw. The paged overload needs `occurred_start` and `entry_uuid` in the SELECT list as well. Extend `scopedProjection` (or add a paged variant) to append `, occurred_start, entry_uuid` — and confirm by reading it that the redaction path for `PLOT_GROUP` is unaffected, since that kind never reaches this overload.

**Further implementation constraints, all load-bearing:**
- The seek predicate is `(occurred_start < ? OR (occurred_start = ? AND entry_uuid > ?))`, matching `ORDER BY occurred_start DESC, entry_uuid` exactly — the edge's tiebreak direction, and the reason the order is total (`entry_uuid` is the mirror's primary key).
- Fetch `limit + 1` and pop the extra as the has-more probe, as the edge does (`api.js:571-580`). Do not use `COUNT(*)`.
- **Reading 14, the date boundary:** the wire params are instants. `occurredFrom` is `occurred_start >= ?` and `occurredTo` is `occurred_start <= ?` — both inclusive, exactly complementing the client's day expansion. Write a test for each bound with an entry exactly on it.
- Do **not** touch the existing `list(...)` overload; the four other resource kinds and the unfiltered entry call keep using it.

- [ ] **Step 5: Add the covering index**

Create `backend/src/main/resources/db/migration/V2026_08_06_001__journal_entries_mirror_filter_index.sql`:

```sql
-- S4 T7. The list predicate is
--   gateway_eui = ? AND (owner_user_uuid = ? OR plot_uuid IN (...))
--     AND deleted_at IS NULL [AND status = ?] [AND activity_code = ?]
--   ORDER BY occurred_start DESC, entry_uuid
-- The two indexes from V2026_07_23_002 lead with (owner_user_uuid, gateway_eui)
-- and (gateway_eui, plot_uuid) and neither carries status or activity_code, so
-- a status- or activity-filtered page falls back to a filter-after-scan.
CREATE INDEX IF NOT EXISTS idx_journal_entries_mirror_gateway_status_time
    ON journal_entries_mirror (gateway_eui, status, occurred_start DESC, entry_uuid)
    WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_journal_entries_mirror_gateway_activity_time
    ON journal_entries_mirror (gateway_eui, activity_code, occurred_start DESC, entry_uuid)
    WHERE deleted_at IS NULL;
```

Both mirror the edge's partial-index shape (`0018__field_journal.sql:51-61`), which the cloud's two existing indexes do not (they have no `WHERE deleted_at IS NULL`).

**These indexes are unlikely to be used as written, and this step must settle that rather than assume it.** The visibility predicate is `gateway_eui = ? AND (owner_user_uuid = ? OR plot_uuid IN (…))`. A planner cannot satisfy an **OR across two columns** from a composite that leads with `gateway_eui, status`: it will either bitmap-OR the two existing `V2026_07_23_002` indexes or seq-scan, and in both cases the new composites contribute nothing. So:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT aggregate_json::text, occurred_start, entry_uuid
FROM journal_entries_mirror
WHERE gateway_eui = '0016C001F11715E2'
  AND (owner_user_uuid = '…' OR plot_uuid IN ('…'))
  AND deleted_at IS NULL
  AND status = 'final'
ORDER BY occurred_start DESC, entry_uuid
LIMIT 51;
```

Run it against a seeded Postgres (the Testcontainers instance the IT below spins up is fine) **with and without** the migration applied, and record both plans in the execution report. Then take one of two outcomes, explicitly:
- **The planner uses them** → keep the migration, paste the `Index Scan` line as evidence.
- **The planner ignores them** (the expected result) → **drop the migration from this task** and ledger the finding in T11 instead: "the entry-list predicate ORs `owner_user_uuid` against `plot_uuid`, which no single composite can serve; making status/activity filters indexable needs either a rewritten visibility predicate (UNION of the two arms) or a plot-scoped partial index per grant, decided against the real mirror size." Shipping two unused indexes is not free — they cost write amplification on every mirror upsert and they read as "this is handled" to the next person.

If the migration stays, verify it actually applies against a real Postgres — the S3 T4 ledger records that the filtered suites use Hibernate `ddl-auto` and therefore never run Flyway:
```bash
./gradlew test --tests 'org.osi.server.testsupport.FlywayMigrationIT'
```
Expected: BUILD SUCCESSFUL. Testcontainers needs `api.version=1.44` in `~/.docker-java.properties`; if it is absent the run fails on Docker API negotiation, not on the migration.

If the migration is dropped, remove `V2026_08_06_001__journal_entries_mirror_filter_index.sql` from this task's Files list and from T12 Step 5's expected cloud diff, and say so in the commit.

- [ ] **Step 6: Wire the controller and sweep the handlers**

Add `JournalController.entriesPage`, a new `@GetMapping("/entries/page")` taking the eight params and returning `JournalEntryPage`. **`JournalController.entries` (`:40-41`) is not modified** — it keeps its signature and its bare-array return.

**Fail-closed check, D5:** `entriesPage` resolves its scope through the *same* `JournalAccessService.require(user, eui, false)` call `entries` uses, before any filter is applied; the filters then narrow inside the already-scoped query. No new authority decision is introduced and no mutating handler is added. The M12 test in Step 4 asserts the narrowing cannot widen. Enumerate the module's mutating handlers in the commit body and confirm each is unchanged: `upsert` (per kind, `@PostMapping`/`@PutMapping` at `:107` and `:120`), `voidEntry` (`:215`). That enumeration is the trap-4 sweep and the reviewer re-derives it from the diff.

**One thing this task must NOT do:** the existing `desiredState` lookup is per-resource (`JournalController.java:318-331`), an N+1 that a paged endpoint makes cheaper by accident but does not fix. Leave it. Fixing it is a separate change with its own test, and folding it in here would make the pagination diff unreviewable. Ledger it in T11.

- [ ] **Step 7: Run the backend suite**

```bash
./gradlew test
```
Expected: **276 + 6 + 7 = 289** tests, 0 failures. State the measured total. Baseline is 276 tests / 48 classes.

Expected suite delta for T7: cloud backend **+13 JUnit**, an exact number rather than a range —
- 6 in `JournalCursorTest`: round trip, wrong-hash rejection, garbage, limit-not-hashed, **cursor-not-hashed**, other-filters-hashed;
- 7 in `JournalControllerTest`: seek predicate + limit, `nextCursor` present when the overfetch probe fires, `nextCursor` null on the last page, the end-to-end second page, `occurredFrom` boundary, `occurredTo` boundary, the D5 not-granted-plot case.

The D5 case is its own `@Test`, not two assertions folded into an existing one, so the count is deterministic. Cloud frontend **0 / 0 / 0**.

- [ ] **Step 8: Commit**

```bash
git add backend/src/main/java/org/osi/server/journal backend/src/main/resources/db/migration backend/src/test/java/org/osi/server/journal
git commit -m "feat: server-side journal entry filtering and keyset pagination (S4 T7)"
```

---

### Task 8: Cloud frontend — consume the cursor, add the plot filter, surface the sort change

Readings 13 and 14. The client stops fetching the whole mirror. Two S3 minors close here: the inert `filters.plotUuid` gets a control, and the "we page client-side" header comment becomes false and must be rewritten.

**Files:**
- Modify: `frontend/src/services/api.ts` (the `listJournalResources` / `listEntries` pair at `:1590-1618`)
- Modify: `frontend/src/pages/JournalPage.tsx`
- Modify: `frontend/src/components/journal/workspace/EntryTable.tsx`
- Modify: `frontend/src/components/journal/workspace/ScopeRail.tsx`
- Modify: `frontend/public/locales/{en,de-CH,fr,it,es,pt,lg}/journal.json`

**Interfaces:**
- Consumes: T7's `GET …/entries/page`, its `JournalEntryPage` envelope and its eight query params.
- Produces: `journalApi.listEntryPage(gatewayEui, filters, cursor) -> Promise<{ entries: JournalResource[]; nextCursor: string | null }>`. The existing `listEntries(gatewayEui, includeDeleted)` stays, unchanged, hitting the unchanged `…/entries`, for any caller that wants the whole list.
- `ScopeRailProps` gains `plots: readonly JournalResource[]` (Step 4).

- [ ] **Step 1: Write the failing service test**

Add to `frontend/src/services/__tests__/api.journal.test.ts` a case asserting that `listEntryPage` sends `plotUuid`, `activityCode`, `status`, `occurredFrom`, `occurredTo`, `limit` and `cursor` as query params, that the day filters are expanded to instants (`occurredFrom: '2026-08-01'` → `2026-08-01T00:00:00.000Z`, `occurredTo: '2026-08-06'` → `2026-08-06T23:59:59.999Z`), and that a `''` filter is omitted from the request rather than sent empty. Reading 14 is the reason the expansion is asserted on both ends: the `occurredTo` end is where a naive port loses a whole day of entries.

- [ ] **Step 2: Implement the service function**

Mirror `listJournalResources`'s shape (`api.ts:1590-1600`) — same `journalBase(gatewayEui)`, but the path is `${journalBase(gatewayEui)}/entries/page` and the mapping is `normaliseJournalResource` over `response.data.entries` with `response.data.nextCursor` carried through. Build the params object by omitting empty values.

- [ ] **Step 3: Move `EntryTable` from client paging to server paging**

`EntryTable.tsx` today filters, sorts and slices in the component (`:138-156`, `ENTRY_PAGE_SIZE = 50`). Replace the slice with a cursor history stack, copying the edge's proven reducer shape (`web/react-gui/src/components/journal/desktop/entryTablePagination.ts:15-63`):

```ts
export interface PaginationState {
  filtersKey: string | null;
  cursor: string | null;
  history: (string | null)[];
}
```
Every action carries `filtersKey` and is a no-op when it does not match, so a filter change can never send a stale, hash-bound cursor to T7's `decode` (which would 400). Port that behaviour and its reason, not just its code.

**Keep `sortEntries` and the `search` needle client-side, over the fetched page only** — reading 13. Both now operate on 50 rows instead of the whole mirror, which is the edge's behaviour (`web/react-gui/src/components/journal/desktop/EntryTable.tsx:112, 127`, with the consequence documented at `:140-149`).

**Rewrite TWO stale header comments, both of which this commit falsifies.**
- `EntryTable.tsx:1-7`: "there is no server-side keyset pagination here — the cloud list endpoint returns the gateway's full entry set in one call (journalAPI.listEntries), so paging is a pure client-side slice over an already-loaded array."
- `ScopeRail.tsx:1-7`: "the cloud list endpoint (journalAPI.listEntries) takes no scope argument, it always returns the gateway's full entry set, and this rail only ever narrows that set client-side via `filters`."

Replace both with what is now true, including the within-page sort **and search** caveats. A comment that describes the previous architecture is worse than no comment: the next reader trusts it.

- [ ] **Step 4: Add the plot control to `ScopeRail`, closing the inert-state minor**

`filters.plotUuid` is honored by `filterEntries` (`EntryTable.tsx:63`) and set by nothing — `ScopeRail` renders five controls (search, activity, status, dateFrom, dateTo) and no plot selector. Add a sixth, a `<select>` with an "All plots" option mapping to `''`.

**`ScopeRail` does not currently receive the plots list and the prop must be threaded.** `ScopeRailProps` at `ScopeRail.tsx:15-23` declares exactly `filters`, `onFiltersChange`, `activities`. `JournalPage` holds `plots` in state (`:112`) and already passes it to three other children (`:282`, `:300`, `:346`) but **not** to `ScopeRail` (`:277`). So:
1. add `plots: readonly JournalResource[]` to `ScopeRailProps` — **required, not optional**, so a caller that forgets it is a `tsc` error rather than a rail that silently renders an empty plot list;
2. destructure it in the component signature;
3. pass `plots={plots}` at `JournalPage.tsx:277`;
4. label each option the way the table already does — `EntryTable.tsx:129-131` builds its plot labels as `name || plot_code || plot_uuid`. Reuse that expression rather than inventing a second labelling rule (§1.4).

New locale keys, all seven locales, `lg` machine-draft:

```
workspace.filters.plot        "Plot"
workspace.filters.plotAll     "All plots"
```

**This is a filter, not a mutation** (reading 17) — it needs no `canWrite` gate, and `ScopeRail` correctly takes none today. Say so in the commit body so the next reviewer does not read the absence as an omission.

- [ ] **Step 5: Surface BOTH scope changes in the UI — sort and search**

Two client-side behaviours narrow from "the whole mirror" to "this page", and **both** are silent behaviour regressions of the §1.3 shape if unannounced. An earlier draft covered only the first.

**(a) Sort.** Sorting by Activity, Plot or Status now reorders **within the current page**, not across the whole list. The edge has the same limitation and shows a note. Add one translated line under the table when the sort key is not `occurred` **and** `nextCursor` is non-null:

```
workspace.sortWithinPage  "Sorted within this page. Other pages are ordered by date."
```

**(b) Search.** `filterEntries` (`EntryTable.tsx:76-80`) matches the needle against `note` and `activity_code` across every loaded entry. `note` lives only inside `aggregate_json` on the mirror (reading 12), so it **cannot** move server-side without an unindexed JSON scan — which means after this commit, typing "fungicide" searches 50 rows instead of the gateway's whole journal. A user whose match is on page 3 gets an empty table and concludes the entry does not exist. That is likelier than the mis-ordered-column case and has the same shape.

The chosen remedy, stated so it is a decision and not a default: **keep the search client-side and announce its scope**, with the same trigger as the sort note (`nextCursor` is non-null) and independent of the sort key, because a search on page 1 of many is already misleading whatever the sort is:

```
workspace.searchWithinPage  "Searching this page only. Use the filters above to narrow the whole journal."
```

Rejected: disabling the search box beyond page 1 (it works fine on a single-page result and disabling a control the user is mid-typing in is worse than a caption); pushing it server-side (it would silently stop matching `note`, i.e. trade a visible limitation for an invisible one).

**Four new locale keys in total** — `workspace.filters.plot`, `workspace.filters.plotAll`, `workspace.sortWithinPage`, `workspace.searchWithinPage` — in all seven locales, `lg` machine-draft.

- [ ] **Step 6: Mutating-handler sweep (D5)**

Enumerate every handler in the two touched components and state its class in the commit body. Expected enumeration at this head: `EntryTable` — sort (`:171`), select (`:213`), page next/previous (`:259`, `:267`); `ScopeRail` — five filter setters (`:37`, `:46`, `:62`, `:80`, `:89`) plus the new plot setter. **All view-state; none writes.** The single write path on this page, "Log activity", is conditionally rendered behind `canCapture = canWriteJournal(...)` at `JournalPage.tsx:254-256` and this task does not touch it. The reviewer re-derives the list from the diff rather than accepting it.

- [ ] **Step 7: Run the suites**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npm run test:unit && npm run build
```
Expected: node-runner **104**, unchanged from T6 — including `frontend/tests/journalCaptureLocales.test.ts`, which is the guard that actually covers this surface. **There is no `journalLocales.test.ts`**; the file is `journalCaptureLocales.test.ts` and it collects keys from every source file under `src/components/journal/**` (excluding `__tests__`) plus `src/pages/JournalPage.tsx`, so `ScopeRail`'s and `EntryTable`'s four new keys are inside its scope automatically. It must show every locale gaining exactly **4** keys and all seven ending at the same total.

Because T6's guard is green (skip-listed, not red), `npm run test:unit`'s `&&` does not short-circuit and the Vitest half genuinely runs. Confirm both halves reported.

`JournalPage.test.tsx` and `EntryTable`'s specs will need their fetch stubs reshaped to the envelope — reshape the stub, never the assertion.

Expected suite delta for T8: cloud **0 node-runner**, **+8 Vitest**, **0 new Vitest files** (every case lands in an existing spec). The eight, named so a wrong total is diagnosable rather than a range:
1. `listEntryPage` sends the six filters + `limit` + `cursor` as query params;
2. an empty-string filter is omitted from the request, not sent empty;
3. `occurredFrom: '2026-08-01'` → `2026-08-01T00:00:00.000Z`;
4. `occurredTo: '2026-08-06'` → `2026-08-06T23:59:59.999Z`;
5. the pagination reducer ignores an action whose `filtersKey` does not match;
6. the plot `<select>` sets `filters.plotUuid` and "All plots" clears it;
7. the sort note renders only when the sort key is not `occurred` **and** `nextCursor` is non-null;
8. the search note renders whenever `nextCursor` is non-null.

Cloud Vitest total after T8: **578 / 111**. State the measured number.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/services/api.ts frontend/src/pages/JournalPage.tsx frontend/src/components/journal/workspace frontend/public/locales
git commit -m "feat: journal list pages and filters on the server (S4 T8, closes the inert plotUuid filter)"
```

---

### Task 9: Cloud backend — the three history depth and export divergences

Readings 8, 9, 10. Three independent fixes in one task because each is a handful of lines in the same package and none is separately reviewable in a useful way.

**Files:**
- Add: `backend/src/main/java/org/osi/server/history/ZoneSeasonLookup.java` (the seam, see Step 2)
- Modify: `backend/src/main/java/org/osi/server/history/HistoryCardService.java`
- Modify: `backend/src/main/java/org/osi/server/history/HistoryService.java`
- Modify: `backend/src/main/java/org/osi/server/history/HistoryExportService.java`
- Modify: `backend/src/main/java/org/osi/server/history/HistoryExportError.java`
- Modify (test): `backend/src/test/java/org/osi/server/history/HistoryCardServiceTest.java` (a), `HistoryServiceTest.java` (b), `HistoryExportServiceTest.java` (c) — all three exist at this head; do not create parallel classes.
- Modify (test, mechanical): `HistoryServiceTest.java`'s **12** `HistoryCardService.soilCard(...)` call sites (the signature changes in Step 2). `AnalysisCatalogServiceTest.java` has its *own private* `soilCard(String)` helper at `:61` that does not call the static — it is **not** affected; verify that before touching it.

**Interfaces:**
- New `@Service ZoneSeasonLookup` — the single owner of "does this zone have an active season, and what are its bounds". Injected into both `HistoryService` and `HistoryCardService`.
- `HistoryCardService.soilCard` gains a `supportedRanges` parameter (Step 2).
- `HistoryExportError.rangeTooLarge(int days, int maxDays)` is added alongside the existing `rowCap()`.

- [ ] **Step 1: Write the three failing tests**

(a) **Season advertisement.** Add to `HistoryCardServiceTest.java`. Edge reference: `osi-history-router/index.js:143-148`.

```java
@Test
void hidesTheSeasonRangeOnAZoneWithNoActiveSeason() {
    // The edge filters 'season' out of supportedRanges when the zone has no
    // active season, so the button never appears. The cloud hardcoded it at
    // four sites and answered season_not_configured after the click.
    for (HistoryCardSummary card : service.findZoneCards(zoneWithoutSeason(), USER_ID)) {
        assertThat(card.supportedRanges()).doesNotContain("season");
    }
}

@Test
void offersTheSeasonRangeOnAZoneWithAnActiveSeason() {
    for (HistoryCardSummary card : service.findZoneCards(zoneWithActiveSeason(), USER_ID)) {
        assertThat(card.supportedRanges()).contains("season");
    }
}
```
Adapt `findZoneCards`, `USER_ID` and the two zone fixtures to the class's real idiom — read it first. If the class has no season-bearing fixture, the seam it needs is whatever `hasActiveSeason` (Step 2) queries; stub that, not the database.

(b) **Season on the advanced path.** Add to `HistoryServiceTest.java`. Assert on the returned bounds, never on a log line.

**The outcome is chosen here, not left open, and the mechanism already exists.** `HistoryAdvancedResponse` (`history/dto/HistoryAdvancedResponse.java:5-16`) is a 9-component record whose last component is `HistoryCardAvailability availability` — the same type `HistoryService` already uses at `:463` to say `new HistoryCardAvailability(false, List.of("heartbeat_history_unavailable"))`. It has no `unavailable(...)` *factory* (that lives on the different type `HistoryCardDataResponse`, `:229`), but it does not need one: **the chosen outcome is a 200 carrying `availability = new HistoryCardAvailability(false, List.of("season_not_configured"))` and a zero-width range**, matching the card-data path's vocabulary exactly.

That matters for the test, because routing `range=season` through `resolveRange` without setting `availability` produces `RangeBounds(now, now, false)` — a **zero-width window labelled "season"**, which is a *worse* silent default than the 90 days it replaces, and which `isNotEqualTo(90L)` happily passes. So assert the outcome positively:

```java
@Test
void reportsSeasonNotConfiguredOnTheAdvancedPathInsteadOfSubstitutingNinetyDays() {
    // HistoryService has two range resolvers. resolveRange (used by the card
    // DATA path) correctly signals season_not_configured; explicitOrDefaultBounds
    // (used by the zone ADVANCED path at :327) went straight to
    // defaultDuration("season") = 90 days, labelled "season", with no lookup and
    // no unavailability signal. Playbook §1.3: missing data must look missing.
    HistoryAdvancedResponse response =
            service.getZoneAdvanced(user(), ZONE_WITHOUT_SEASON_ID, CARD_ID, "season", null, null, null, "auto");

    assertThat(response.availability().available()).isFalse();
    assertThat(response.availability().reasons()).contains("season_not_configured");
    // and the range is not a plausible-looking substitute either way
    long spanDays = Duration.between(response.from(), response.to()).toDays();
    assertThat(spanDays)
            .as("a zone with no season must not be handed a silent 90-day window")
            .isNotEqualTo(90L);
}

@Test
void stillResolvesTheRealSeasonOnTheAdvancedPathWhenOneIsConfigured() {
    HistoryAdvancedResponse response =
            service.getZoneAdvanced(user(), ZONE_WITH_SEASON_ID, CARD_ID, "season", null, null, null, "auto");
    assertThat(response.availability().available()).isTrue();
    assertThat(response.from()).isEqualTo(SEASON_START);
}
```
Adapt the accessor names (`from()`/`to()`, and `HistoryCardAvailability`'s two component names), the argument list to `getZoneAdvanced`'s real signature, and the fixtures to the class's idiom — read all three before writing. The second test is what stops the fix from turning every advanced season request into an unavailability.

(c) **Export range cap.** Add to `HistoryExportServiceTest.java` — read the class first and reuse its existing fixture/builder idiom rather than introducing parallel fixtures (the S3 T5 ledger records a brief that invented fixture names the file did not have):

```java
@ParameterizedTest
@CsvSource({
    // granularity, span in days, expect413
    "raw,     92,   false",   // the edge's exact boundary, must still pass
    "raw,     93,   true",
    "hourly,  730,  false",
    "hourly,  731,  true",
    "daily,   3650, false",   // daily is UNCAPPED on the edge; do not "improve" this
})
void enforcesTheEdgesExportRangeCaps(String granularity, int spanDays, boolean expect413) {
    LocalDate from = LocalDate.of(2026, 1, 1);
    LocalDate to = from.plusDays(spanDays - 1); // inclusive span, as the edge counts it
    ThrowingCallable call = () -> service.exportZone(user(), ZONE_ID, from.toString(), to.toString(), granularity, null);
    if (expect413) {
        assertThatThrownBy(call)
                .isInstanceOf(HistoryExportError.class)
                .satisfies(error -> assertThat(((HistoryExportError) error).statusCode()).isEqualTo(413))
                .satisfies(error -> assertThat(((HistoryExportError) error).suggestion()).contains("coarser granularity"));
    } else {
        assertThatCode(call).doesNotThrowAnyException();
    }
}
```

Edge reference: `osi-history-helper/index.js:1729-1740`. The day count is `floor((end - start) / 86400000) + 1`, **inclusive of both endpoints** — the `spanDays - 1` in the fixture is what makes "92" mean 92 counted days and not 93. Copy the edge's `exportSpanDays` arithmetic exactly rather than re-deriving it; an off-by-one makes the 92-day case pass for the wrong reason (playbook §3, "boundaries are exact complements"). Adapt `service.exportZone(...)`'s real signature and the `user()`/`ZONE_ID` fixtures to what the class already has — if it has none, use its existing inline-literal idiom rather than adding constants.

Run each of (a), (b), (c) and confirm it fails **for the stated reason** before writing any fix. A test that fails on a missing fixture rather than on the defect has proved nothing.

- [ ] **Step 2: Fix the season advertisement**

`HistoryCardService.java:50, 64, 78, 126` each hardcode `List.of("12h", "24h", "7d", "30d", "season")`. Replace with a single helper applied at all four sites:

```java
private static final List<String> ZONE_RANGES = List.of("12h", "24h", "7d", "30d", "season");

private List<String> supportedRangesForZone(IrrigationZone zone) {
    return seasonLookup.hasActiveSeason(zone)
            ? ZONE_RANGES
            : ZONE_RANGES.stream().filter(range -> !"season".equals(range)).toList();
}
```

**"Extract `activeSeasonBounds` into `HistoryCardService`" is a circular bean dependency — do not do it.** `HistoryService` already injects `HistoryCardService` (`HistoryService.java:53`), so making `HistoryCardService` depend on `HistoryService` fails Spring context startup. Introduce a third component instead:

```java
@Service
@RequiredArgsConstructor
public class ZoneSeasonLookup {
    private final NamedParameterJdbcTemplate jdbcTemplate;   // nullable, as HistoryService treats it
    public record SeasonBounds(Instant start, Instant end) {}
    public Optional<SeasonBounds> activeSeason(IrrigationZone zone) { … }
    public boolean hasActiveSeason(IrrigationZone zone) { return activeSeason(zone).isPresent(); }
}
```
Move the body of `HistoryService.activeSeasonBounds` (`:770-793`) into `activeSeason` **verbatim**, including the `jdbcTemplate == null` guard, the `zone_seasons … active = TRUE ORDER BY starts_on DESC LIMIT 1` query, the `plusDays(1)` end-exclusive convention and the `catch (RuntimeException) -> empty` fallback. `zoneTimezone(zone)` moves with it or becomes a parameter — read `HistoryService` and pick, but do not leave two copies. `HistoryService.activeSeasonBounds` becomes a two-line adapter from `SeasonBounds` to its own `RangeBounds`; `HistoryCardService` gains `private final ZoneSeasonLookup seasonLookup`. **One source of truth per fact** (playbook §1.4): two independent "is there a season" predicates will drift.

**`soilCard` is `static` and takes no zone** (`HistoryCardService.java:117`), so `supportedRangesForZone` cannot reach it from inside. **Give it a `List<String> supportedRanges` parameter** rather than de-staticing it — it stays a pure factory, which is what the 12 test call sites rely on:

```java
static HistoryCardSummary soilCard(String cardId, boolean available, List<String> reasons, List<String> supportedRanges)
```
Call sites to update: **13** — the one production site at `:39` (passing `supportedRangesForZone(zone)`) and **12** in `HistoryServiceTest.java` (`:75, 97, 123, 168, 188, 212, 234, 257, 279, 372, 559, 601`, all `HistoryCardService.soilCard(`). Verify the count before editing:
```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend
grep -rn 'HistoryCardService\.soilCard(\|[^.]\bsoilCard(' src/main src/test | grep -v 'private HistoryCardSummary soilCard'
```
`AnalysisCatalogServiceTest.java:61` defines its own unrelated `private HistoryCardSummary soilCard(String zoneUuid)` and is **not** a call site of the static — leave it alone. The other three card factories (`dendro`, `environment`, `irrigation`) are built inline via `card(...)` at `:41`, `:56`, `:70`-ish and take their range list positionally, so they need only the argument swapped.

- [ ] **Step 3: Fix the advanced-path season substitution**

Route the zone advanced path through the season-aware resolver **and set the availability field** — routing alone swaps a plausible 90-day window for a plausible zero-width one, which is not a fix.

`explicitOrDefaultBounds(range, from, to)` (`:675-679`) gains the zone and delegates to `resolveRange` when `range` is `season`. `resolveRange` returns `RangeBounds(now, now, false)` when there is no season; that third component (`false`) is the "resolved?" flag the card-data path already reads at `:228-243` to build its unavailable response. The advanced path reads the same flag and, when it is false, constructs its `HistoryAdvancedResponse` with `availability = new HistoryCardAvailability(false, List.of("season_not_configured"))` — the same reason string, the same vocabulary, one code path's worth of divergence removed rather than added. Do **not** invent a 400: the card-data path answers 200-with-availability for exactly this condition, and two different HTTP answers to one condition is the divergence this task exists to close.

The **gateway** advanced path at `:352` keeps `explicitOrDefaultBounds` unchanged because gateway cards do not advertise `season` at all (`cardDefinitions.ts:112`) — **and the request is rejected upstream by `validateViewAndRange` (`:661-664`) before it can reach `defaultDuration`, so the gateway path has no defect.** Verify that claim by reading `validateViewAndRange` rather than trusting this sentence; if it does not in fact reject `season` for gateway cards, the gateway path needs the same treatment and this step grows — report that rather than patching it silently.

With both zone paths season-aware, `defaultDuration`'s `case "season" -> Duration.ofDays(90)` becomes unreachable. **Delete it** — a dead branch that silently substitutes ninety days is exactly the thing that will be reintroduced by a future caller. If deleting it makes a test fail, that test is exercising the defect; read it before touching it.

- [ ] **Step 4: Add the export range cap**

In `HistoryExportService.parseRequest` (`:227-245`), after the granularity check and before constructing the `ExportRequest`:

```java
long days = ChronoUnit.DAYS.between(fromDate, toDate) + 1;
Integer maxDays = switch (normalizedGranularity) {
    case "raw" -> 92;
    case "hourly" -> 730;
    default -> null; // daily is uncapped on the edge too
};
if (maxDays != null && days > maxDays) {
    throw HistoryExportError.rangeTooLarge((int) days, maxDays);
}
```

and in `HistoryExportError`:

```java
public static HistoryExportError rangeTooLarge(int days, int maxDays) {
    return new HistoryExportError(
            413,
            "range too large for this granularity (" + days + " days, max " + maxDays + ")",
            "Choose a coarser granularity.");
}
```
413 and the "choose a coarser granularity" suggestion both match the edge's `RANGE_TOO_LARGE`. The row cap stays — it catches the dense-data case the day cap does not.

- [ ] **Step 5: Run the backend suite**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend
./gradlew test
```
Expected: **289 (after T7) + 9 = 298**, 0 failures. State the measured total. If T9 runs before T7 — reading 19 allows it — the expected total is **276 + 9 = 285**; say which ordering you ran.

Expected suite delta for T9: cloud backend **+9 JUnit**, an exact number:
- 2 season-advertisement (`hidesTheSeasonRangeOnAZoneWithNoActiveSeason`, `offersTheSeasonRangeOnAZoneWithAnActiveSeason`);
- 2 advanced-path (`reportsSeasonNotConfiguredOnTheAdvancedPathInsteadOfSubstitutingNinetyDays`, `stillResolvesTheRealSeasonOnTheAdvancedPathWhenOneIsConfigured`);
- 5 export-cap boundary (the `@CsvSource` rows count as five).

The 13 `soilCard` call-site updates and the `ZoneSeasonLookup` extraction add **zero** tests — they are mechanical, and a moved counter there means something else changed. Frontend **0 / 0 / 0**.

- [ ] **Step 6: Commit**

```bash
git add backend/src/main/java/org/osi/server/history backend/src/test/java/org/osi/server/history
git commit -m "fix: season advertisement, season-on-advanced 90-day substitution, export range caps (S4 T9)"
```

---

### Task 10: `AnalysisControls` — restore the custom range and finish the colour migration

Reading 15. One file, two concerns, one commit, because touching it twice for two reviewers is the exact failure mode the ordering decision exists to avoid. This task takes T6's guard to zero.

**Files:**
- Modify: `frontend/src/components/analysis/AnalysisControls.tsx` (35 utilities + the functional gap)
- Modify: `frontend/src/pages/CrossZoneAnalysisPage.tsx` (to pass the restored `range` prop)
- Modify (test): `frontend/src/components/analysis/__tests__/AnalysisControls.test.tsx`

**Interfaces:**
- Produces: `AnalysisControlsProps` regains `range?: AnalysisRange`. `CrossZoneAnalysisPage` must pass it; the prop stays optional so no other caller breaks.

- [ ] **Step 1: Write the failing tests**

Three cases, each targeting a verified divergence:

```tsx
it('repopulates the custom range inputs from the active range on mount', () => {
  render(<AnalysisControls {...base} rangeLabel="custom"
    range={{ label: 'custom', from: '2026-08-01T06:00:00.000Z', to: '2026-08-03T18:00:00.000Z' }} />);
  expect((screen.getByLabelText(/from/i) as HTMLInputElement).value).not.toBe('');
  expect((screen.getByLabelText(/to/i) as HTMLInputElement).value).not.toBe('');
});

it('rejects a zero-length custom range', async () => {
  // The edge tests customFromMs < customToMs; the cloud relaxed it to <=,
  // so an identical from/to was accepted and produced an empty chart.
  render(<AnalysisControls {...base} rangeLabel="custom" onRangeChange={onRangeChange} />);
  await userEvent.type(screen.getByLabelText(/from/i), '2026-08-01T06:00');
  await userEvent.type(screen.getByLabelText(/to/i), '2026-08-01T06:00');
  expect(screen.getByRole('button', { name: /apply/i })).toBeDisabled();
});

it('paints the active segment with tokens, not slate-900', () => {
  const { container } = render(<AnalysisControls {...base} mode="timeline" />);
  expect(container.innerHTML).not.toMatch(/bg-slate-900|text-white\b/);
});
```
Adapt the accessible names to what the component actually renders — read it first; do not invent labels. Run and confirm each fails for its own reason.

- [ ] **Step 2: Restore the three functional pieces**

Port from `web/react-gui/src/components/analysis/AnalysisControls.tsx` verbatim: the `range?: AnalysisRange` prop, the `isoToDatetimeLocal` helper (edge `:26-43`), the `useEffect` that repopulates on `[rangeLabel, range?.label, range?.from, range?.to]` (edge `:70-76`), and the `customFromMs < customToMs` strictness. These are byte-portable — the two files' surrounding code is close enough that a diff-driven port is safe, and a re-derivation is not.

- [ ] **Step 3: Port the file's 35 colour utilities**

The edge twin is tokenised as of `79fcecbc`; take its class strings. The headline pair is the segmented button:
```tsx
const segBtn = (active: boolean) => [
  'px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] focus-visible:ring-inset',
  active ? 'bg-[var(--primary)] text-[var(--on-primary)]' : 'bg-[var(--card)] text-[var(--text-secondary)] hover:bg-[var(--secondary-bg)]',
].join(' ');
```
Contrast: `--on-primary` on `--primary` **5.17 L / 10.39 D**; `--text-secondary` on `--card` **10.35 / 9.38**.

- [ ] **Step 4: Pass the prop from the page**

`CrossZoneAnalysisPage.tsx` mounts `AnalysisControls`; add `range={...}` from whatever the page already holds as the active range. If the page does not hold one, STOP and report — do not synthesize a range object to satisfy the prop.

- [ ] **Step 5: Delete the skip-list, take the guard to zero, run everything**

The order matters. First tokenise the file (Steps 2-3), then **delete both** `PENDING_S4_T10` and the `every PENDING_S4_T10 entry still has something to skip` test from `frontend/tests/historyAnalysisTokens.test.ts`, along with the `if (PENDING_S4_T10.includes(rel)) continue;` line and the comment block above the constant. If you tokenise without deleting, the stale-skip test goes red and tells you so — that is its job.

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
grep -n 'PENDING_S4_T10' tests/historyAnalysisTokens.test.ts   # must print nothing
npx tsx --test tests/historyAnalysisTokens.test.ts
npm run test:unit && npm run build
```
Expected: `grep` silent; the guard's **two remaining tests PASS with 0 offenders across all 22 files** — the 509→0 claim, now enforced with no exemptions. Cloud node-runner **103** (104 after T6, minus the deleted stale-skip test), Vitest **581 / 111**, build exit 0. State the measured totals.

Expected suite delta for T10: cloud **−1 node-runner** (the skip-list's self-expiry test, deleted with the skip-list), **+3 Vitest**, **0 new files**.

**Zero mutating handlers added.** `onRangeChange` / `onModeChange` / `onLayoutChange` / `onToggle` are pre-existing view-state callbacks on an analysis workspace that writes nothing to the gateway; the reviewer confirms from the diff that no new callback prop appears.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/components/analysis/AnalysisControls.tsx frontend/src/pages/CrossZoneAnalysisPage.tsx frontend/src/components/analysis/__tests__
git commit -m "fix: restore the analysis custom range and finish the colour migration (S4 T10)"
```

---

### Task 11: Update the GUI-parity matrix (S4 rows and ledger)

**Files:**
- Modify: `docs/superpowers/plans/agrolink-gui-parity-matrix.md` (osi-os)

**Interfaces:** none.

- [ ] **Step 1: Edit only the rows S4 touched, and only their dates**

Rows to edit: **History dashboard**, **Cross-zone analysis**, **Analysis route**, **Journal entry table**, and the two `ui-core` platform rows. Do **not** bulk-refresh dates; an untouched row keeping its old date is the signal that it still needs a look (the matrix says so in its own header).

**No row flips to `parity`**, and no row may end at a status a skim reads as "done pending a formality". `partial (pending walkthrough)` is such a status: it asserts that a walkthrough is the *only* remaining blocker, when in fact roughly **35 files of drill-down are not delivered at all** (see "Deferred to S4b"). Two blockers, and the bigger one is not the walkthrough.

The two history/analysis rows therefore end at exactly:

```
partial — S4 delivered colour/depth only; drill-down NOT delivered (S4b)
```

with provenance `2026-08-06 verified (S4)` — or the real date of execution — **and this literal sentence in the row's notes cell:**

> Completing S4 does not close the spec's S4 row.

The **Journal entry table** row and the two `ui-core` platform rows are not affected by the S4b carve-out; they end at `partial (pending walkthrough)` as before. The matrix's own walkthrough-evidence caveat (double-downlink and MQTT-broker hardcode) still applies to any evidence gathered before those two edge fixes are deployed, and is reproduced in the ledger.

- [ ] **Step 2: Add the S4 ledger section**

Append `### S4 additions (history and analysis slice, 2026-08-06)` carrying, at minimum, every item below, **in this order**. Each must name the file and the mechanism, not just the symptom.

The carve-out leads. It is the single most consequential thing in this section and it must not be item 11 of 11, where a reader who stops after three bullets never reaches it.

1. **S4b — drill-down is NOT delivered.** Open the ledger with the literal sentence *"Completing S4 does not close the spec's S4 row."* Then the full inventory from "Deferred to S4b" at the foot of the S4 plan: no `HistoryCardDetailPage` on the cloud at all (edge: 851 lines), two unregistered card-detail routes, six of eleven visualizations missing plus `chartAxis.ts`, the edge-only `components/history/{desktop,mobile}/` subtrees (13 files), `HistoryCardVisualization.tsx`, `ThematicCardCarousel.tsx`, `useJournalMarkers.ts`, eleven edge-only history model modules, `sourceKey` absent end to end (no `@RequestParam`, no `HistoryCardSourceDevice`, no `HistorySourceFilter`/`HistorySourcePopover`), `HistorySeries.depthCm` deleted, and `AnalysisRoute.tsx`'s desktop-only gate absent. ~35 files. **This is why the two history/analysis rows read `partial — S4 delivered colour/depth only; drill-down NOT delivered (S4b)` and not `partial (pending walkthrough)`.** S4b is not scheduled; it is dated and located here so it is a follow-up and not a silence.
2. **The cloud calendar had merged four of the edge's severity states** (reading 4) — fixed in T3; record the four and the fact that the cloud's `cardDefinitions.ts` declares a `mixed` soil state the edge does not, which makes `mixed` an **orphaned state on the edge** (present in `HistoryCalendarState` and in `stateTone`, reachable from no edge card).
3. **The two GUIs are on different Tailwind majors** — edge `4.1.18` (OKLCH palette), cloud `3.4.19` (v3 hex). T1 resolved the resulting colour-space question by maintainer ruling M11: `--cal-*` light values are the **edge's** v4 `oklch()` strings verbatim, so the edge is pixel-stable (including on P3) and the cloud converges onto them. Record the ruling, the per-tone shift table from reading 6, and the fact that **the divergence itself is unclosed**: the two repos will keep drifting on every palette-shaped decision until one of them moves major, and `verify-ui-core-vendor` does not and cannot detect it.
4. **SIXTEEN edge light-theme changes shipped in T2, not three.** Record both groups and the reason the count was wrong, because the same map is what T3–T6 applied to the cloud.
   - **Three declared and deliberate:** the calendar's `no_irrigation` row (17.04 → 15.16), `no_data` dropping `opacity-70` (an AA fix, 2.78 → 5.12 light), and the `sensor_gap`/`data_gap` marker dots moving `slate-400` → `--text-disabled` (a 1.03:1 shift).
   - **Thirteen undeclared, found by T2's reviewer**, all produced by the shade→part fallback map's **non-identity** rows: six `-900`→`-950` text darkenings (amber 8.77→14.46, red 9.21→14.78, emerald 9.19→14.36 — safe, contrast rises), four `ring-*-100`→`-bg` halo palings (1.078–1.125×), and three `-600`→`-500` marker-dot lightenings at `IrrigationEventTimelineView.tsx:194-196`: red 4.76→3.82 (still clears), **emerald 3.67→2.46** and **sky 4.02→2.71** (both now **below the 3:1** WCAG 1.4.11 floor for a graphical object).
   - **Maintainer ruling, 2026-08-06: acceptable to land**, because that consumer renders a **visible** severity text chip at `:307-309`, so colour is redundant there. **Consumer-specific, not token-wide.** The calendar marker dot at `HistoryMonthCalendarView.tsx:149` has no visible label and ships only because it is byte-stable.
   - **Root cause worth carrying forward:** the plan documented the map's `-900`→`-text` darkening as a *cloud* consequence only and never mentioned the `-600`→`-500` lightening at all, so "mapped per the table" read as "nothing moved". The map now carries an explicit non-identity warning and T3–T6 each carry a mandatory enumeration step. Record that this was a **plan defect caught by an implementer and a reviewer**, not an execution defect.

4b. **`--cal-<tone>-solid` on `--card` fails 3:1 in light for five of the nine tones** — `warn` 2.15, `humid` 2.36, `good` 2.46, `cool` 2.71, `alert` 2.89; `water` 3.76, `bad` 3.82, `mixed` 4.12, `violet` 4.40 clear. These are the verbatim Tailwind `-500` values the edge already shipped, so this is **status quo carried forward, not a regression S4 introduces** — but tokenising a value does not make it correct, it gives it a name. **Route to the next designer review together with item 4's three T2 lightenings**, since both are facts about the same token family and must not be discoverable only by reading two different commit messages. Dark `-solid` is fine (5.57–8.53 across the nine tones, all well over 3:1).
5. **`--soil-dry` (3.76 light) and `--soil-wet` (3.68 light) fail AA as text on `--card`.** `--soil-moist` was darkened to 5.02 on 2026-08-06; the other two were not. Fill/indicator tokens only. Route to the frontend-designer review with the white-on-primary and liquid-red items already there.
6. **Three edge-only files keep palette debt and were deliberately not touched:** `web/react-gui/src/components/history/mobile/{HistoryExportSheet,HistoryInspectorSheet}.tsx` (one utility each) and `visualizations/DendroStressEventsView.tsx` (9), which has no cloud twin — **11 offenders in total, surviving `historyStateTokens.test.ts` by design**, since that guard's `DEFINITION_FILES` is the four files T2 owns. Edge defect, no parity consequence, belongs to the edge's own `src/components` theme-blind audit (already a required designer-review input per the S3 ledger).
7. **The cloud has zero tests for all five history visualizations** it ships, where the edge has six. Not closed by S4; belongs with S4b.
8. **Six of the edge's twelve journal `ENTRY_FILTERS` are JSON-only on the mirror** (`campaign_uuid`, `protocol_code`, `protocol_version`, `observation_unit_code`, `batch_uuid`, `pass_uuid`) and were deliberately not offered by T7: filtering them means `aggregate_json->>'…'` with no index. Fix shape if ever needed: expression indexes or GIN, decided against the real mirror size.
9. **Free-text journal search narrowed from the whole mirror to the current page** in T8, because its `note` needle is a JSON-only field. Announced in the UI (`workspace.searchWithinPage`), not fixed. Closing it properly means either indexing `aggregate_json->>'note'` or mirroring `note` as a column.
10. **Whether the T7 filter indexes are usable at all.** The entry-list visibility predicate ORs `owner_user_uuid` against `plot_uuid`, which no single composite can serve, so the two `V2026_08_06_001` indexes may never be chosen. Record the `EXPLAIN` plans T7 Step 5 captured and whichever outcome it took (kept with evidence, or dropped). If dropped, record the fix shape: a UNION-of-arms rewrite of the visibility predicate, or per-grant partial indexes, decided against the real mirror size.
11. **`JournalController.desiredState` is an N+1 per listed entry** (`:318-331`); T7 made each page cheaper without fixing it. Named, not fixed.
12. **`pageShellTokens.test.ts`'s allowlist is edge-only and holds two verified scanner false positives, not offenders** (reading 7). S4 neither added to nor removed from it. Record this so the next slice does not inherit the brief's misreading.
13. **The `noInertTokenAlpha` and `errorTokenMisuse` regexes still miss uppercase/digit token names and `outline-`/`accent-` utilities** (carried forward from the S3 ledger, still true, still unclosed). Note that neither fences the new `--cal-*-solid` part either; `historyAnalysisTokens.test.ts` does, but only over `components/{history,analysis}`.
14. **The cloud's history advanced payload uses snake_case field keys where the edge uses camelCase** (`history-contracts.test.ts` differs on both sides: edge 16 camelCase keys, cloud 26 snake_case). Verified in the two test files; **not** verified against the runtime DTOs. A real contract question for whoever next touches the advanced view.
15. **The denial-philosophy convergence remains deferred** by maintainer decision until after the walkthrough. Note it; do not plan it.
16. **The walkthrough-evidence caveat still stands**: the matrix's own note that double-downlink and MQTT-broker-hardcode fixes must be deployed before walkthrough evidence counts, reproduced verbatim so the next reader does not have to find it.

- [ ] **Step 3: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add docs/superpowers/plans/agrolink-gui-parity-matrix.md
git commit -m "docs: matrix S4 rows — colour/depth delivered, drill-down carved out to S4b"
```

---

### Task 12: Full cross-repo verification sweep

**Files:** none modified except a report.

- [ ] **Step 1: Both suites, both repos, fresh**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui && npm run test:unit
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend && npm run test:unit && npm run build
cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend && ./gradlew test
```

- [ ] **Step 2: Assert the totals against the arithmetic**

| | baseline | + | expected |
|---|---|---|---|
| edge node-runner | 111 | T1 +4, T2 +2 | **117** |
| edge Vitest | 1689 | 0 net | **1689** across **169** files |
| cloud node-runner | 97 | T1 +4, T6 +3, T10 −1 | **103** |
| cloud Vitest | 566 | T3 +4, T8 +8, T10 +3 | **581** across **111** files |
| cloud backend | 276 | T7 +13, T9 +9 | **298** across 48+ classes |

Every figure is exact; there are no ranges left in this table, and no task's stated delta is a range either. A total **lower** than expected means a test was skipped or deleted — STOP and find it. A total **higher** than expected is not automatically fine either: name every extra test and why it exists. S3's T12 hit exactly this and reported the discrepancy rather than adjusting the table, which is the correct behaviour.

The one deliberate **negative** delta is T10's `−1`: T6 ships a self-expiring `PENDING_S4_T10` skip-list plus a test that fails once the skip is stale, and T10 deletes both. If the cloud node-runner reads **104** at T12, the skip-list is still on the branch — check `grep -n PENDING_S4_T10 frontend/tests/historyAnalysisTokens.test.ts` before anything else.

- [ ] **Step 3: ui-core byte parity, both directions**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
OSI_SERVER_ROOT=/home/phil/Repos/osi-server/.worktrees/agrolink sh scripts/verify-ui-core-vendor.sh
sh scripts/verify-ui-core-vendor.test.sh
cd /home/phil/Repos/osi-server/.worktrees/agrolink
EDGE_UI_CORE_ROOT=/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep sh scripts/verify-ui-core-vendor.sh
sh scripts/verify-ui-core-vendor.test.sh
diff /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui/src/ui-core/tokens.css \
     /home/phil/Repos/osi-server/.worktrees/agrolink/frontend/src/ui-core/tokens.css
```
Expected: `verify-ui-core-vendor: OK` from both directions (each script requires a **different** env var — `OSI_SERVER_ROOT` from the osi-os side, `EDGE_UI_CORE_ROOT` from the osi-server side, both pointing at the *other* checkout's root, see T1 Step 4) and the `diff` is empty.

- [ ] **Step 4: The migration reached zero, and the guards are non-vacuous**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx tsx --test tests/historyAnalysisTokens.test.ts tests/noInertTokenAlpha.test.ts tests/errorTokenMisuse.test.ts tests/pageShellTokens.test.ts
```
Then **mutation-test** `historyAnalysisTokens.test.ts`: temporarily insert `className="bg-slate-100"` into one migrated file, confirm the guard goes red naming that file, revert, confirm green. A guard that has never been seen to fail is not a guard. Do the same for the edge's `historyStateTokens.test.ts`.

- [ ] **Step 5: Scope audit — no unintended edge change**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git diff --name-only 7d37af9f..HEAD
```
Expected exactly: `web/react-gui/src/ui-core/tokens.css`, `web/react-gui/tests/uiCoreTokens.test.ts`, `web/react-gui/tests/historyStateTokens.test.ts`, the four T2 component files, `docs/superpowers/plans/agrolink-gui-parity-matrix.md`, and this plan document. **Anything else — any `flows.json`, any `osi-journal/*.js`, any `conf/` path, any edge page — is a scope breach: STOP and report.**

**This plan document is untracked at `7d37af9f` and will therefore NOT appear in `git diff --name-only` unless it has been committed.** Check first and act accordingly:
```bash
git status --porcelain -- docs/superpowers/plans/2026-08-06-agrolink-gui-parity-s4.md
```
`??` means untracked — commit it (`git add` + `git commit -m "docs: S4 implementation plan"`) at the start of T1 or the end of T11, and only then does the nine-path expectation above hold. If it is still untracked at T12, the expected list is **eight** paths, not nine, and the plan document must be reported as uncommitted rather than quietly omitted.

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git diff --name-only 33521768..HEAD
```
Expected: only paths in the T3–T10 file map.

- [ ] **Step 6: Push — edge first, then cloud**

The cloud's `backend-ci.yml` gates read canonical artifacts from the osi-os `AgroLink` ref, and T1 re-vendored `tokens.css`, so the cloud's copy will not match until the edge commit is on the remote. Verify the constraint still holds before relying on it, then push in this order:

- [ ] Re-read the gate rather than assuming it from S3:
```bash
grep -n 'AgroLink\|osi-os\|actions/checkout' /home/phil/Repos/osi-server/.worktrees/agrolink/.github/workflows/backend-ci.yml
```
State in the report what you found.

- [ ] **Push the EDGE first:**
```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git status -sb && git log --oneline 7d37af9f..HEAD
git push origin HEAD:AgroLink
```

- [ ] **Then the CLOUD:**
```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git status -sb && git log --oneline 33521768..HEAD
git push origin HEAD:AgroLink
```

- [ ] Confirm both remotes advanced and the cloud's CI run went green **after** the edge push, not before it. A cloud run that started first and passed proves nothing about the vendored tokens.

- [ ] **Step 7: Write the report**

Root cause per fix, deliberate tradeoffs, every measured number, and the full list of items ledgered rather than fixed. The report is the PR body.

---

## Deferred to S4b, with the rationale

The spec's S4 row names "drill-down routes" and the walkthrough will compare "history and analysis at edge depth". A verified inventory of what that means:

- **No `HistoryCardDetailPage` exists on the cloud at all** (edge: 851 lines). The cloud's `App.tsx` registers `/history`, `/history/zones/:zoneId` and `/analysis`; the edge additionally registers `/history/zones/:zoneId/cards/:cardId` and `/history/gateways/:gatewayEui/cards/:cardId`.
- **Six of eleven visualizations are missing**: `SoilLineChartView`, `SoilIrrigationResponseView`, `DendroLineChartView`, `DendroStressEventsView`, `DailyMinMaxView`, `HistoryMonthCalendarView` — plus `chartAxis.ts`.
- **Edge-only shell subtrees**: `components/history/desktop/` (3 files), `components/history/mobile/` (10 files), `HistoryCardVisualization.tsx` (232 l), `ThematicCardCarousel.tsx` (92 l), `useJournalMarkers.ts`.
- **Eleven edge-only history model modules**: `calendarMonth`, `desktopHistory`, `gestureModel`, `historyViewport`, `soilStatus`, `sourceLabels`, `useChartMouseInteractions`, `useHoverCapable`, `useIsDesktop`, `useOrientation`, `useVisualizationGestures`.
- **`sourceKey` is absent end to end** — no `@RequestParam` on `HistoryController`, `HistoryCardDataRequest.sourceKey` and the whole `HistoryCardSourceDevice` interface deleted from the cloud's `history/types.ts`, and no `HistorySourceFilter`/`HistorySourcePopover`. Restoring source filtering needs the backend param, the type, and two components.
- **`HistorySeries.depthCm` deleted** from the cloud's types, so soil depth cannot be labelled.
- **`AnalysisRoute.tsx`'s desktop-only gate is absent** — mobile users reach the analysis page instead of being redirected to `/history` (already recorded in the matrix as a corrected `partial`).
- **Zero cloud tests for any visualization** (see T11 ledger **item 7**).

That is roughly 35 files and several thousand lines, and it is a coherent, separately shippable subsystem: it delivers the drill-down experience and nothing else. Bundling it with a 509-utility mechanical colour migration and a backend pagination port would produce a diff no reviewer can hold in their head, and the `writing-plans` scope rule says to split at exactly this seam — each plan should produce working, testable software on its own. **S4 as planned does**: after T12 the cloud's history and analysis surfaces are theme-correct in both themes, the journal list pages on the server, and three server-side depth/export divergences are closed. S4b then delivers drill-down at edge depth against a stable, tokenised base.

S4b is not scheduled here. It is recorded in the matrix as **ledger item 1** — the first thing in the S4 section, not the last — with this scope, so it is a dated, located follow-up and not a silence. And because the S4 row's status must not read as done pending a formality, T11 Step 1 gives the two history/analysis rows the status `partial — S4 delivered colour/depth only; drill-down NOT delivered (S4b)` and the literal sentence **"Completing S4 does not close the spec's S4 row."**
