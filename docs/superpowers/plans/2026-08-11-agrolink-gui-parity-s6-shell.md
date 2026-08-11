# AgroLink GUI Parity — Slice S6, the app shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the cloud app a shell — primary navigation, tokenised chrome, a brand mark and no URL-only routes — so that a user who logs in can *see* the four slices that already shipped, and fix the three edge defects that make its own permission and capability model invisible. This is deliberately not a feature slice: it delivers the frame every previous slice's work sits inside.

**Architecture:** The maintainer opened the deployed cloud app after four feature slices shipped and asked *"I thought we are done with the gui parity? It looks like the very beginning. Not even the tabs are implemented?"* He was right, and the root cause is structural: the spec's slice table (S0–S5) is organised **by feature** — zones, devices, journal, history — so navigation, which is not a feature, was never any slice's deliverable. The cloud is consequently a star: `Dashboard` is the only page that renders links to more than one sibling, and three routes have no in-app link at all. So S6 is: (a) port the edge's `AppHeader` tab-pill pattern onto the four cloud parity pages, consuming the `glass-tabs`/`glass-tab` CSS that **already ships unused** in the cloud's byte-mirrored `primitives.css`; (b) de-orphan the three URL-only routes and close the two desktop/mobile reachability holes; (c) replace four hardcoded palette colours and three page-header gradients in the cloud's chrome with the tokens and the glass material the cloud already carries; (d) give the logged-in cloud app the Agroscope brand *mark* it lacks (the *word* already ships everywhere — reading 13); (e) fix three edge defects — Settings is hidden wholesale from read-only users so a granted viewer cannot reach the language switcher, `/support-requests` redirects into that same wall, eighteen sites hide controls with no explanation, and per-feature capability gaps render as silence where D4 asks for a stated reason; (f) a small `ui-core` batch (translucent modal scrim, `color-scheme`, and one real 3.25:1 contrast defect with a guard — **not** the token nudge the brief asked for, see reading 10); (g) correct the matrix's journal rows first, cheaply, because they predate the cloud-primary rebuild.

**Tech Stack:** React 18, TypeScript, Vite 5, Vitest + `tsx --test` runners, react-router-dom 6, react-i18next, SWR 2, Spring Boot 3 + JUnit 5 (cloud backend — S6 touches it in **no** task), Node 22 + POSIX `sh` (vendor verifiers).

**This slice is a new row in the spec's slice table, and that omission is the bug.** `docs/superpowers/specs/2026-08-04-agrolink-gui-parity-design.md`'s slice table runs S0–S5 and every row names a feature area. No row owns chrome, navigation or reachability, which is exactly why four slices could each close their own row while the assembled product still reads as "the very beginning". S6 adds that row. It is numbered **S6** because `S4b` (drill-down) and `S5` (scoped-access administration) are already named and this plan must not squat on either identifier — **not** because it runs after them. It should run next; see "Deferred, with the rationale" for why S4b and S5 stay where they are.

**Working directories — the branch model changed since S4 and every S4-era command is now wrong (reading 2):**

| | path | branch | HEAD at planning | state |
|---|---|---|---|---|
| Edge (canonical) | `/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep` | `feat/journal-cloud-primary` | `d2851111` | clean, **1 commit unpushed** |
| Cloud (vendored) | `/home/phil/Repos/osi-server/.worktrees/agrolink` | `feat/journal-cloud-primary` | `d091af2f` | **1 commit unpushed**, one untracked dir (`docs/superpowers/prompts/`) |

- `AgroLink` on both sides is the **deployed rollback point** and is 15 commits (edge) / 23 commits (cloud) *behind* these heads. **Never commit to it, never push to it, never `git push origin HEAD:AgroLink`** — the S4 plan's Step 6 does exactly that and must not be copied.
- Never touch `AgroLink` in either repo, nor `.worktrees/{terra-rehaul-*,firmware-image-builder,playbook-lessons,theme-kimi,theme-deepseek}`.
- Both worktrees have an unpushed commit at planning time. Push them (to `feat/journal-cloud-primary`, not `AgroLink`) or record their hashes before T1, or every "expected exactly these paths" scope audit in T12 will be reading a dirty baseline.

**Why S6 touches the edge, exactly.** Four tasks touch edge files, and no others:

| Edge path | Task | Why it is unavoidable |
|---|---|---|
| `web/react-gui/src/ui-core/{Modal.tsx,tokens.css}` + `__tests__` + `tests/uiCoreTokens.test.ts` | T2 | D2: `ui-core` is **canonical in osi-os**. Every ui-core change is structurally an edge change; there is no cloud-first path. Re-vendored to the cloud in the same task. |
| `web/react-gui/src/{App.tsx,components/DashboardHeader.tsx,components/WritableOnly.tsx,pages/SettingsPage.tsx,pages/{JournalPage,HistoryDashboard,CrossZoneAnalysisPage}.tsx}` + locales | T7 | Maintainer decision 4. Read-only users keep Settings. The gate is on the edge; it cannot be fixed from the cloud. |
| `web/react-gui/src/{components/ReadOnlyNotice.tsx (new),pages/*,components/farming/*}` + locales | T8 | Maintainer decision 3(c). The eighteen silent-hiding sites are edge files. |
| `web/react-gui/src/components/farming/*` + locales | T9 | Maintainer decision 3(b). The edge's per-feature capability silences — **not** a wholesale D4 violation; reading 6 corrects the brief and narrows this task. |

No `flows.json`, no `conf/` path, no `osi-journal/*.js`, no edge runtime backend file, no migration, no seed DB. **S6 touches the cloud backend in zero tasks** — every cloud change is under `frontend/`.

---

## Global Constraints

Copied from `docs/superpowers/specs/2026-08-04-agrolink-gui-parity-design.md`, the maintainer's seven S6 decisions, and the standing S1–S4 constraints. Every task's requirements implicitly include this section.

- **`ui-core` is a CLOSED 8-primitive set** (`Banner`, `Button`, `Chip`, `EmptyState`, `FormField`+`INPUT_CLASS`, `Modal`, `Surface`, `TableShell`). S6 modifies `Modal` and adds **zero** new primitives. Verified at both heads: `ls` on each ui-core directory returns exactly those 8 `.tsx` files plus `index.ts`, `primitives.css`, `tailwind-preset.js`, `tokens.css`, `__tests__/`, and `index.ts` exports exactly those 8 components and their types. **The cloud's new header is a page-level component, not a ninth primitive** — the spec's admission rule is "a primitive is admitted to `ui-core` only when both GUIs use it", and the edge's `AppHeader` is edge-local today for the same reason.
- **`ui-core` canonical in osi-os, byte-mirrored to osi-server, CI-gated both directions** (D2). **Same-task re-vendor:** a ui-core change lands in osi-os and is re-vendored to osi-server *in that same task*, never split across tasks, and `scripts/verify-ui-core-vendor.sh` must be green in **both** directions before the task's final commit. Verified: the two directories are byte-identical right now (`diff -r` empty, exit 0), and the verifier `diff -ru`s the **whole** `ui-core` directory — so `primitives.css`, `tokens.css` and `tailwind-preset.js` are all inside the gated set, not just the primitives.
- **The two CI vendor gates are DORMANT on this branch and pinned to a stale ref (reading 2). Local verifier runs are the only real gate in S6.** Edge `.github/workflows/ui-core.yml` triggers on `AgroLink` only; cloud `.github/workflows/backend-ci.yml` triggers on `main`/`master` only and checks out osi-os at `ref: AgroLink` (`backend-ci.yml:20,34`). Neither fires on a push to `feat/journal-cloud-primary`. **Do not report "CI green" as evidence of vendor parity in this slice** — run both scripts locally, both directions, and paste the output.
- **Tailwind majors differ and this is load-bearing.** Edge `tailwindcss` **4.1.18** (`package.json: ^4.1.18`); cloud **3.4.19** resolved (`package.json: ^3.4.4` — quote the *resolved* version, not the range). **Tailwind v3.4 cannot alpha-modify a `var()` colour**: `bg-[var(--x)]/60` compiles to **ZERO CSS**. Use `bg-[color-mix(in_srgb,var(--X)_60%,transparent)]`. This is an established pattern, not a novel one — `color-mix(in_srgb,…)` already has 15+ call sites in cloud `frontend/src` (e.g. `PendingStateNotice.tsx:98,112`, `HistoryDesktopShell.tsx:491`, `Login.tsx:64,79`) and 4 on the edge. Guard `noInertTokenAlpha.test.ts` exists in **both** repos (`web/react-gui/tests/`, `frontend/tests/`) and must stay green.
- **Background tokens never in `text-` / `fill-` / `stroke-` / `placeholder-` / `caret-` / `decoration-` utilities.** A `*-bg` token is a pale wash; foregrounds use the paired `-text`/`-fg` token. Guard `errorTokenMisuse.test.ts`, both repos.
- **The three guard tests scan the WHOLE `src` tree, not `src/pages`** — `noInertTokenAlpha.test.ts`, `errorTokenMisuse.test.ts` and `pageShellTokens.test.ts` all resolve `srcRoot`/`pagesRoot` to `../src` and recurse. `pageShellTokens`'s variable is *named* `pagesRoot` and that name is a lie. The S3 ledger's claim that one of them "scans only `src/pages`, so every component escapes it entirely" is **wrong** and must not be re-quoted (reading 15). What `pageShellTokens` actually narrows on is the *class string* — it only inspects viewport-claiming shells (`min-h-screen`, `h-screen`, `min-h-[calc(`, `h-[100dvh]`).
- **`--cal-*` is a calendar-state palette.** Never for chrome, navigation or branding. S6 consumes **zero** `--cal-*` tokens; every task states that and a reviewer verifies it from the diff.
- **Same-theme contrast for every changed pair, measured against the surface the element ACTUALLY renders on.** Walk the parent chain; do not assume `--card`. A cross-theme figure is meaningless — that mistake was made on this project and produced a recommendation for a failing colour. Floors: **4.5:1** body text, **3:1** large text and non-text boundaries. Reference ratios, recomputed from `ui-core/tokens.css` at edge `d2851111` (light / dark):

  | pair | light | dark |
  |---|---|---|
  | `--text` on `--bg` | 16.48 | 17.21 |
  | `--text` on `--card` | 17.85 | 14.28 |
  | `--text-secondary` on `--bg` | 9.56 | 11.30 |
  | `--text-tertiary` on `--bg` | 5.57 | 6.80 |
  | `--text-tertiary` on `--card` | 6.03 | 5.65 |
  | `--header-text` on `--header-bg` | 20.50 | 15.85 |
  | `--header-subtext` on `--header-bg` | 7.58 | 10.41 |
  | `--text-tertiary` on `--header-bg` (inactive tab label) | 6.03 | 6.27 |
  | `--on-primary` on `--primary` | 5.17 | 10.39 |
  | `--info-text` on `--info-bg` | 8.49 | 11.66 |
  | `--warn-text` on `--warn-bg` | 6.37 | 11.02 |
  | `--error-text` on `--error-bg` | 8.20 | 8.20 |
  | `--danger-fg` on `--bg` | **4.46 — the T2 nudge** | 6.71 |
  | `--danger-fg` on `--card` | 4.83 | 5.57 |

  **Tokens that must never carry text**, measured: `--warn-border` on `--warn-bg` 1.93 light, `--info-border` on `--info-bg` 3.01 light, `--success-border` on `--success-bg` 3.00 light. Borders only.
- **7-locale key-set equality** (`en`, `de-CH`, `fr`, `it`, `es`, `pt`, `lg`) for every new string, both repos. Locale files live in `<gui>/public/locales/<locale>/<ns>.json` — **not** in `src/i18n/config.ts` (an S3 orchestrator got this wrong). **There is no global key-equality test on either side** (reading 20): the edge has four *scoped* ones (`historyLocaleKeys`, `journalLocales`, `analysis-locales`, `devicesI18n`) and `dashboard.json`, `settings.json`, `support.json` and `common.json`'s chrome subtree are covered by **none** of them. Every task that adds a key to an unguarded namespace **must add the guard in the same task**; a key added to an unguarded namespace is a key nothing can prove exists in seven locales.
- **`lg` is Luganda and gates the Uganda deployment.** Mark any `lg` string you are not confident in as a machine draft pending the human-native gate. Do not present it as final. Do not use a curly apostrophe in `lg` — every existing `lg` string uses a straight one, and S3 shipped exactly one violation.
- **No new untranslated literal** may enter a component S6 writes. Note that the edge's own `AppHeader.tsx:137-138` ships two hardcoded English admin labels (`'Manage users'`, `'Access grants'`); S6 does not fix them (out of scope, ledgered in T11) but **must not copy them into the cloud**.
- **D3:** one linked gateway means no selector anywhere; multiple are switched on Settings. S6 adds no gateway chrome.
- **D4:** capability-gated rendering; older gateways get an explicit "not available on this gateway" state, never silence. **T9 fixes the edge's violation of this. The cloud already implements the pattern (reading 8) and is the source to port FROM.**
- **D5, fail-closed:** unknown / missing / unparseable ⇒ deny. `readOnly` / `canWrite` are REQUIRED props with **no default**, so an unthreaded mount is a `tsc` error. S3 shipped three separate fail-opens of the same shape. **T7 is the one task in this plan that deliberately makes a surface MORE reachable, so it is the one place where "fail-closed" and the requirement pull against each other** — T7 Step 0 states the rule that resolves it: *reachability of a read-safe display preference is not a write authority*, and every control T7 exposes must be provably non-mutating. T7 carries a per-control enumeration step; T3–T6 and T8–T10 add **zero** mutating handlers and each states that.
- **Ownership is ALWAYS identity comparison, NEVER `gatewayRole == null`** — a null role means the OWNER account. Shipped wrong twice in S2. S6 introduces no ownership-gated affordance.
- **Distinction by label, never by colour identity (maintainer decision 2).** There is to be **no separate admin colour identity**. The purple/emerald/slate/teal palette is removed and nothing replaces it — the pages are told apart by their headings.
- **Do not touch decision 3(a).** A card absent because no such device is connected is **correct and deliberate**. A clean interface showing only what applies to this farm is the intended design. No task in this plan may add an "no dendrometer connected" placeholder, and a reviewer who asks for one is asking for a regression.
- **Explain once per surface, not per control (maintainer decision 3(c)).** Eighteen inline notices would be clutter and would fight 3(a). T8 ships **one** notice per page, not one per hidden control.
- **Every task states its expected suite delta, and T12 asserts the total.** A task that adds tests names how many node-runner and how many Vitest tests it adds, so a silently-skipped spec shows up as a wrong count rather than a green run.
- **Suite baselines, measured on this machine 2026-08-11 at edge `d2851111` / cloud `d091af2f`. All four suites green, both builds exit 0:**

  | | node-runner | Vitest | Vitest files | build |
  |---|---|---|---|---|
  | edge `web/react-gui` | **117** | **1690** | **169** | exit 0 (`vite build`, 7.3s) |
  | cloud `frontend` | **110** (2 suites) | **697** | **116** | exit 0 (`tsc && vite build`, 23s) |
  | cloud `backend` | — | **1542 executed** (1543 total, 1 skipped), 0 failures | 276 classes | — |

  **The cloud frontend numbers in the S6 brief (105 / 700 / 117) are stale — use 110 / 697 / 116.** Commands:
  ```bash
  cd <edge>/web/react-gui && npm run test:unit:tsx-runner   # 117
  cd <edge>/web/react-gui && npm run test:unit:vitest       # 1690 in 169 files
  cd <cloud>/frontend && npm run test:unit                  # 110 node-runner THEN 697 vitest
  cd <cloud>/frontend && npm run build                      # tsc && vite build
  ```
  The cloud has **no separate script** for its two runners — `test:unit` chains them with `&&`. To run only the node half, invoke it through `npm` (not a bare shell glob): this repo's `tests/` contains no `.test.tsx` files, so `tsx --test 'tests/**/*.test.tsx'` **errors under fish/zsh** with "no matches found" while succeeding under `npm run`, which shells out through `/bin/sh`. The 1 skipped backend test is `journal.v2.JournalScannerBridgeIT` (Testcontainers-gated) and is skipped at baseline — not a regression.
- **Gradle hazards, if any task ever needs the backend (none in S6 does).** `gradlew` lives in `backend/`, **not** the repo root. `./gradlew test --tests …` prints `BUILD SUCCESSFUL` with `:test UP-TO-DATE` and runs **zero** tests — always `./gradlew cleanTest test`, and read the real counts out of the XML rather than the console:
  ```bash
  cd backend && grep -oh 'tests="[0-9]*" skipped="[0-9]*" failures="[0-9]*" errors="[0-9]*"' build/test-results/test/*.xml \
    | awk -F'"' '{t+=$2;s+=$4;f+=$6;e+=$8} END {print "tests",t,"skipped",s,"failures",f,"errors",e}'
  ```
- **Verification hazards, all seen on this project.** `$?` after a pipe captures the **last** command — use a bare invocation or `${PIPESTATUS[0]}`. `grep -c` overrides `-o` and counts **lines**, not occurrences — use `grep -o … | wc -l` for occurrences and `grep -rl … | wc -l` for files. A local build can pass while the Docker build fails, because the Docker context is `frontend/` only and `tsconfig` includes `src` — **nothing under `src/` may import across the repo boundary**. Two edge journal scripts print `PASS:` not `# pass`, so grepping for the latter returns empty — check exit codes. **A check that cannot fail is not a check:** every new test must be proven red before it is proven green, and every new guard must be mutation-tested (insert a real offender, watch it go red, revert).
- **Every `file:line` citation is re-verified against the current file at dispatch time.** Earlier tasks shift lines. Re-derive with `grep -n`/`sed -n` and paste the output rather than copying a number out of this plan. The counts in "Reference: the shell surface, measured" carry the same expiry — they were measured at the heads above.
- **Every command in a task brief is run once against the real toolchain before it is written into the brief.** A command that has never been executed is a guess with a shell prompt in front of it. S4's T1 shipped two briefs with wrong env-var names and a grep that matched nothing on a correct build.
- **Matrix rule:** rows flip toward `parity` "only after a real side-by-side walkthrough against the edge GUI running on `agrolink-test-01`". **That walkthrough still has not happened.** No row this plan touches flips to `parity`. The matrix's own walkthrough-evidence caveat (the double-downlink defect and the MQTT-broker hardcode) still stands and is reproduced in T11.
- **Push ordering: EDGE first, then CLOUD.** T2 re-vendors ui-core, and while the cloud CI gate is dormant on this branch (above), the ordering still matters for any future PR to `main` and costs nothing. Push to `feat/journal-cloud-primary` on both sides.

---

## Plan-level readings

Each states an ambiguity in the S6 brief or the spec and its resolution, with the evidence that settled it. Every one was checked against the code at edge `d2851111` / cloud `d091af2f`. **Eight of the brief's claims turned out to be wrong or materially imprecise; readings 3, 5, 6, 7, 8, 9, 10 and 16 record which, because a plan built on them would have shipped work that was already done, or fixed a defect that does not exist.**

**1. Navigation was never any slice's deliverable, and that is a property of the spec, not an execution failure.** The spec's slice table (`2026-08-04-agrolink-gui-parity-design.md:99-107`) runs S0–S5: `ui-core`+`GatewayProvider`; zones/schedules/calibration; devices+valves; field journal; history+analysis; scoped-access administration. Every row names a **feature area**. No row names chrome, navigation, reachability or branding, and the verification section (`:112-126`) checks "per-slice unit suites and production builds" plus a per-slice walkthrough — a per-slice walkthrough cannot see that the *assembly* of four slices has no way to move between them, because each walkthrough compares one surface. So four slices could each honestly close their own row while the product reads as "the very beginning". **Resolution: S6 is a new row in that table, and T10 writes it into the matrix.** The corollary binds future slices: a slice table organised by feature needs one row that owns the frame, and it should be the first row, not the sixth.

**2. Every S4-era git command in this program is now wrong, and both ui-core CI gates are dormant AND pinned to a ref that ui-core has already moved past.** S4 worked on branch `AgroLink` and its T12 Step 6 says `git push origin HEAD:AgroLink`. Work now happens on `feat/journal-cloud-primary` in both repos, and `AgroLink` is the **deployed rollback point**: edge `feat/journal-cloud-primary` is 15 commits ahead of `origin/AgroLink` and 0 behind (`git rev-list --left-right --count origin/AgroLink...HEAD` → `0 15`); cloud is `0 23`. Copying S4's push command would push 15 unreviewed commits onto the live deploy branch. Worse, the vendor gates:
  - edge `.github/workflows/ui-core.yml` triggers on `push`/`pull_request` for branch **`AgroLink` only**;
  - cloud `.github/workflows/backend-ci.yml` triggers on **`main`/`master` only** (`:3-5`) and checks out osi-os at **`ref: AgroLink`** for both the sync-contract gate (`:20`) and the ui-core gate (`:34`).

  So a push to `feat/journal-cloud-primary` fires **neither**, and if one ever did fire it would compare the cloud's vendored `ui-core` against osi-os `AgroLink` — which is already stale: `git diff --stat origin/AgroLink..HEAD -- web/react-gui/src/ui-core/` shows `Modal.tsx` and `__tests__/feedback.test.tsx` already changed by commit `68e4af3c` ("fix(ui-core): make Modal scrollable and viewport-bounded"). **T2 changes `Modal.tsx` again, deepening a divergence the gate cannot see.** Resolution: (a) the local verifier, run in both directions with explicit env vars, is the gate for S6 and T11 pastes its output; (b) the pinned-ref problem is **ledgered, not fixed** — repointing a CI ref used by three gates across two repos is a release-engineering decision with a blast radius beyond a GUI slice, and it becomes urgent only when this branch is proposed for merge. T10 records it as the first ledger item so it cannot be discovered by surprise at merge time.

**3. "The cloud is a star topology and all 13 other routed pages are cul-de-sacs with nothing but a back-to-dashboard link" — the diagnosis is right, the second half is wrong, and the correction does not weaken the case.** `App.tsx` registers **17** routes (`grep -c 'path=' src/App.tsx` → 17): `/login`, `/register`, 14 authenticated pages, and a `*` catch-all redirecting to `/dashboard`. So "Dashboard + 13 others" is exactly right. But **5 of the 13 do link a sibling**: `/journal` → `/account` (`JournalPage.tsx:588`), `/settings` → `/support-requests` (`SettingsPage.tsx:267-272`), `/admin/users` → `/admin/devices` (`AdminUsers.tsx:88-90`), `/admin/devices` → `/admin/users` (`AdminDevices.tsx:86-88`), `/admin/work-requests` → `/admin/devices` (`AdminWorkRequests.tsx:116-118`). The other 8 link only `/dashboard`. **Why this does not soften the finding:** those 5 links are *lateral within an area* (admin↔admin, settings→support) — not one of them reaches a **parity surface**. There is no path from `/journal` to `/history`, from `/history` to `/analysis`, or from any of the three back to each other without going through `/dashboard`. The defect is the absence of **primary navigation**, and the accurate statement of it is: *the four parity surfaces (`/dashboard`, `/history`, `/analysis`, `/journal`) form a star centred on `/dashboard`, and three routes have no in-app link at all.* T3 fixes the star; T5 fixes the three. Use this wording, not "13 cul-de-sacs".

**4. There is no shared app shell in the cloud, so mounting the tab bar is a four-page change — and that matches the edge, which does the same thing.** Verified: no `Layout`/`AppShell`/`PageLayout` wraps routed pages; `App.tsx:32-148` puts each page directly inside `PrivateRoute`/`AdminRoute` with no chrome slot. Every page renders its own `<header>` inline. Only `Dashboard` delegates, to `DashboardHeader`, which no other page reuses. The edge is structurally identical: `AppHeader` is mounted **per page** at `FarmingDashboard.tsx:153` (via `DashboardHeader`), `HistoryDashboard.tsx:413`, `JournalPage.tsx:237` and `CrossZoneAnalysisPage.tsx:173`. **Resolution: port the edge's structure exactly — a cloud `components/AppHeader.tsx` owning crown + glass chrome + tabs + Settings + Account, and rewrite `components/DashboardHeader.tsx` into a thin wrapper that passes the Add/Admin menus into `AppHeader`'s `actions` slot**, which is precisely what edge `DashboardHeader.tsx:33-53` does. Rejected alternative: introduce a routed layout element (`<Route element={<Shell/>}>` with `<Outlet/>`). It is the better React idiom and it is **rejected for this slice**: it would restructure all 14 routes in a slice whose reviewable claim is "navigation now exists", it has no edge counterpart so it would create a *new* structural divergence while closing a visual one, and D7's freedom is at page-composition level, not router level. Ledger it as a follow-up if a fifth parity page ever appears.

**5. Maintainer decision 6 is ALREADY IMPLEMENTED, everywhere, and is dropped from S6's scope.** The brief asks to "add an `info` tone to `Banner` (and `Chip` if it shares the union)" because "loading states currently render as warnings". All three premises are stale:
  - `ui-core/Banner.tsx:3` already declares `export type BannerTone = 'warn' | 'error' | 'success' | 'info';` with `info: 'border-[var(--info-border)] bg-[var(--info-bg)] text-[var(--info-text)]'` at `:9`.
  - `ui-core/Chip.tsx:3` already declares `export type ChipTone = 'neutral' | 'success' | 'warn' | 'error' | 'info';` with the same mapping at `:10`. **The two unions are separate, independently exported types** (`index.ts`), not one shared union — so the brief's conditional never applies, and `ChipTone` carries a `neutral` member `BannerTone` lacks.
  - The call-site migration is also done. It landed together, in commit **`1364b891`** ("fix(ui-core): add info tone, stop spending warn on loading states", 2026-08-06), already vendored to both repos. Cloud `JournalCaptureModal.tsx:94-96` and `JournalPage.tsx:134-136` both map `'loading' → 'info'` and everything else to `'warn'`; `EntryAttachmentsPanel.tsx:77-91` maps in-flight `'uploading'/'selected' → 'info'` with a comment stating the reasoning. Every surviving `tone="warn"` is a genuine denial or a flagged conflict; every surviving `tone="error"` is a genuine error.
  - On the **edge** there is nothing to migrate either: exactly **one** `<Banner>` mount exists in the whole edge GUI (`ScopeStatusBanner.tsx:12`, `tone="error"`), **zero** `<Chip>` mounts, and **zero** `tone="warn"` occurrences outside tests.

  **Resolution: no task implements decision 6. T10 records it as verified-already-done with the commit hash**, so nobody re-opens it. `--info-bg/-text/-border` are confirmed present in both themes (`tokens.css:41-43` light, `:142-144` dark) and `--info-text` on `--info-bg` measures 8.49 light / 11.66 dark.

**6. Maintainer decision 3(b) rests on "the edge has ZERO such states and therefore violates its own spec" — the edge has some, and the real gap is narrower and needs naming precisely so T9 fixes a real thing.** The edge does ship explicit capability-denial states: `components/analysis/AnalysisSeriesTray.tsx:55-56` returns `'analysis.tray.reason.unsupported'` when `availability === 'unsupported'` and renders it at `:135`, with copy at `public/locales/en/common.json:44` (`"unsupported": "Unsupported"`); the type is `AnalysisAvailabilityValue = 'available' | 'unsupported'` (`src/analysis/types.ts:1`); and `public/locales/en/journal.json:324` carries `"unsupported": "This activity is not available for the selected layout"`. **What is genuinely absent on the edge is a *gateway*-capability state** — the D4 sentence is about "the selected gateway's capability handshake" and "older gateways", and the edge has no analogue because a gateway GUI runs *on* its gateway and never asks a remote one what it supports. **So the honest framing is not "the edge violates D4" but "D4 is a cloud-shaped decision, and the edge's version of it is per-feature availability, which exists in two places and is missing everywhere else."** T9 is scoped to that: the edge's *device- and layout-capability* silences, using the two existing states as the in-repo precedent for copy and shape. The cloud's own D4 implementations (reading 8's zone domain and journal domain) are the design reference, not a byte source.

**7. The silent-hiding audit is 18 sites, not 19 — and there is a second, larger class the brief does not count.** Measured on the edge, excluding tests:
  - `<CanWrite>` wrapper (`components/CanWrite.tsx`) real usages: **1**, not 2 — only `pages/JournalPage.tsx:332-341`, wrapping the "Log activity" button.
  - inline `canWrite\s*&&`: **exactly 17** — `components/farming/IrrigationZoneCard.tsx:208,240,375,408,570,586,595,602`; `components/journal/desktop/JournalWorkspace.tsx:375`; `components/journal/desktop/DetailPanel.tsx:432`; `pages/FarmingDashboard.tsx:152,186,355,361`; `pages/JournalPage.tsx:237`; `pages/HistoryDashboard.tsx:413`; `pages/CrossZoneAnalysisPage.tsx:173`.
  - **Total 18.** All 18 are the brief's category (a): hide with no explanation (return `null`, omit the element, or hold a modal's `isOpen` false).
  - **Not counted by the brief and worth more than a footnote:** 10 further sites pass `readOnly={!canWrite}` into a card or form (`IrrigationZoneCard.tsx`, `FarmingDashboard.tsx`), which *disables* controls with no explanatory text — a user sees a greyed control and is told nothing. Plus `DashboardHeader.tsx:41` hides the whole Add menu via `canWrite ? (…) : undefined`, which is functionally a 19th hide but is not an inline `&&`.
  - **`canWrite` and `showSettings`/`showAdmin` overlap, and the arithmetic here is exact because T8's drift detector depends on it:** **three** of the 17 are `showSettings={canWrite && !scopeLoading}` (`JournalPage.tsx:237`, `HistoryDashboard.tsx:413`, `CrossZoneAnalysisPage.tsx:173`) and those are the only three T7 deletes, so **T7 and T8 must not both claim them.** T7 owns the Settings gate; T8 owns the remaining page-content hides — **14** of them, not 13. Two near-misses that must not be miscounted into the three: `DashboardHeader.tsx:39` is `showSettings={canWrite}` with **no `&&`**, so T7 deletes it but it was never one of the 17; and `FarmingDashboard.tsx:152` is `canWrite={canWrite && !scopeLoading}` — a prop pass that feeds the Add-menu gating (`DashboardHeader.tsx:41` `actions={canWrite ? … }`) and **survives T7 untouched**.
  - **Zero explanations confirmed.** `grep -rniE "read.?only access|view.?only|you (do not|don't) have (permission|write|edit)"` over edge `src` (non-test) and `public/locales/en/*.json` returns **no hits**. `ScopeStatusBanner` only surfaces `scope.loadError` on an API failure, which is a different thing.

**8. Maintainer decision 4's file:line is wrong, the language-switcher premise is wrong, and the conclusion is still correct — which is why T7 survives.** The brief cites "`AppHeader.tsx:54` `showSettings=canWrite`". `AppHeader.tsx:54` is `showSettings = true,` — a **default parameter**, the opposite of a gate. The real gates are four call sites: `components/DashboardHeader.tsx:39` (`showSettings={canWrite}`) and `pages/{JournalPage.tsx:237,HistoryDashboard.tsx:413,CrossZoneAnalysisPage.tsx:173}` (`showSettings={canWrite && !scopeLoading}`). `WritableOnly.tsx` redirects at **line 9** (`if (!canWrite) return <Navigate to="/" replace />;`, with `if (loading) return null;` at `:8`), not line 10, and it wraps **exactly one route**: `App.tsx:69`, `/settings`. And the language switcher is **not** only in Settings — `LanguageSwitcher` is mounted in **4** places: `pages/SettingsPage.tsx:371`, `pages/Login.tsx:113`, `pages/Register.tsx:64`, `components/history/mobile/HistoryMobileHeader.tsx:39`.
  **The conclusion holds anyway, and precisely:** `HistoryMobileHeader` carries `lg:hidden` (`:15`), and neither `AppHeader` nor `DashboardHeader` renders a switcher. So for an **authenticated, desktop, read-only** user, every switcher is unreachable — Login and Register are pre-auth, and the mobile history header is display-hidden. That user cannot select Luganda, which gates a Uganda deployment. **Resolution: T7 is justified on the desktop-read-only case as stated above and must say so in its own words rather than repeating "the switcher lives only in Settings", which is false.** Note the cloud already solved this differently: `DashboardHeader.tsx:71` puts `LanguageSwitcher` in the header. T7 deliberately does **not** copy that (it would add chrome to a header T3 is simultaneously restructuring); it makes Settings reachable instead, which is what decision 4 asks for and also fixes theme and units.

**9. "The material already ships — this is substitution, not design" is TRUE and load-bearing; all three of its supporting numbers are wrong.** The substance survives intact, so decision 2 stands as written, but no task brief may quote these figures:
  - **"`btn-liquid` is defined 23 times."** The literal substring occurs 23 times in `primitives.css`, but `btn-liquid` is a **prefix of `btn-liquid-red`**, so the count conflates two distinct classes across selector lists, `::after`, `:hover`, `:active`, `:disabled` and two accessibility fallback blocks (`prefers-reduced-transparency`, `prefers-reduced-motion`). It is not one class defined 23 times.
  - **"used only 4 times."** The 4 literal occurrences outside `primitives.css` are: `ui-core/Button.tsx:11-12` (the variant→class map itself, i.e. the *definition* of the consumer API) and two test assertions. The real application call sites go through `<Button variant="liquid-red">` — **3 of them**, all `liquid-red` (`DetailPanel.tsx:334`, `EntryAttachmentsPanel.tsx:344,355`). **`variant="liquid"`, the plain glass variant T3 and T4 need, has ZERO consumers in the cloud today** — which is a stronger version of the brief's point, not a weaker one.
  - **"`--brand-red` is defined and used ZERO times."** It is defined at `tokens.css:24` (light) and `:126` (dark) as `#E30613`, and it **is used** — `primitives.css:153` (`background: var(--brand-red)` in the `.btn-liquid-red` reduced-transparency fallback), `:165` (`box-shadow: inset 0 0 0 1px var(--brand-red)` in the `.glass-tab[aria-current='page']` fallback) and `tailwind-preset.js:33` (`'brand-red': 'var(--brand-red)'`). Five occurrences, all inside `ui-core/`. The accurate claim: **used only inside ui-core's own fallback CSS and preset, never referenced by app page or component code on either side.**
  - **A real finding the brief missed:** the active tab's Agroscope-red specular ring is **hardcoded** — `primitives.css:138-139` uses `rgba(227, 6, 19, 0.35)` and `rgba(227, 6, 19, 0.18)` literally, where `#E30613` *is* `--brand-red`. So the one place the brand red is visible in normal rendering does not go through the token, while the fallback nobody sees does. S6 does **not** fix it: `primitives.css` is byte-mirrored and a token substitution there changes the edge's rendered chrome, so it needs the same ratification a token change needs, for zero user-visible gain. Ledgered in T10.

**10. The `--danger-fg` nudge fixes a pairing that does not occur in the product, and there is a real 3.25:1 defect two lines away. The token does not change.** Measured: light `--danger-fg` `#DC2626` on light `--bg` `#F4F6F8` = **4.458** — so the brief's 4.46 is exactly right. But the constraint that matters is *the surface the element actually renders on*, and a parent-chain walk of **all 9** live `text-[var(--danger-fg)]` sites on the edge (the cloud has **zero** live ones — its 3 grep hits are two test assertions and a comment) puts every one of them on `--card` `#FFFFFF` = **4.829, which passes**:
  - `components/farming/SystemPanel.tsx:236` sets `bg-[var(--card)]` on the very element carrying the text; single mount, `pages/FarmingDashboard.tsx:342`.
  - all 8 `components/journal/desktop/DetailPanel.tsx` sites (`:460,651,656,661,855,860,1057,1082`) sit inside the `<aside className="… bg-[var(--card)] …">` at `:330`; the intervening `<form>`s set only `border-[var(--border)]`, so they are transparent. Single mount, `JournalWorkspace.tsx:367`, no `Modal`/`Surface` wrapper (neither is imported by that file).

  Darkening the token would therefore move a **production farm GUI**'s rendering — the same class of unrequested visual change maintainer ruling M11 refused in S4 — to fix nothing. **Resolution: `--danger-fg` is unchanged. T2 instead (a) records the three failing pairings as a constraint and fences them with a guard, and (b) fixes the one real defect the walk found:** `SystemPanel.tsx:236` swaps its own background to `--border` `#CBD5E1` on hover while keeping `text-[var(--danger-fg)]`, which renders at **3.253** — a genuine failing state of a real control, and a *same-class-string* pairing a static guard can actually catch. Reference figures for the guard: `--danger-fg` on `--bg` 4.458, on `--surface` `#E8EDF2` 4.100, on `--error-bg` `#FEE2E2` 3.953, on `--border` 3.253 — all fail 4.5:1; all clear 3:1, so `--danger-fg` remains legitimate as a **border** on every one of them, which is exactly how `Banner.tsx:7` and `Chip.tsx:9` use it.

**11. What the logged-in cloud app is missing is the brand MARK, not the brand WORD — and porting the edge's mark puts two different Agroscope marks in one session, which needs a ruling.** The brief warns that "a prior claim that the cloud contains zero AgroLink references was false"; it is false, and generously so. Already shipping **inside the logged-in cloud app**: `DashboardHeader.tsx:31`'s `<h1>{t('title')}</h1>` resolves to the literal `"AgroLink"` from `public/locales/*/dashboard.json`; `HistoryDashboard.tsx:148` renders `AgroLink` as an eyebrow; `JournalPage.tsx:504` renders `AgroLink · {t('eyebrow')}`; `Account.tsx:181` names it in body copy; `devices.json:45`'s `cloudLocalHint` names it; `GatewayContext.tsx:6` keys localStorage `'agrolink.active-gateway.v1.'`; and **`tests/agrolinkBranding.test.ts` already asserts a set of these**. What does **not** ship post-login is any image or SVG mark — `DashboardHeader.tsx` and `Dashboard.tsx` contain zero `<img>` and zero inline SVG. The Agroscope Swiss-cross (`src/assets/agroscope/swiss-cross.jpg`) appears only on `Login.tsx:38-40`.
  The edge's module is **not** a generic "crown/branding module": `src/branding/agrolink.ts` resolves the licensed **Agroscope Balken** partner lockup, in 4 locale variants (`balken-horizontal-{en,de,fr,it}.png`, 19–24 KB each; `de/fr/it` matched by prefix, everything else including `es`/`pt`/`lg` falling back to `en` via `resolveAgroscopeAssetLocale:52-58`), rendered as `<img className="balken-crown">` at `AppHeader.tsx:83`. `.balken-crown` is **pixel-tuned CSS in `src/index.css:29-101`** — not in `ui-core`, so not vendor-gated — with a `margin-left: max(16px, calc(50% - 784px))` rule that hard-codes the edge's `max-w-[1600px]` content column, a `.login-scene` variant, and a `<640px` override. `.font-brand` (`index.css:103`) asks for Noto Sans. The cloud's `src/index.css` is **16 lines** and has none of it, has no `src/branding/`, and ships only `swiss-cross.jpg`. `AGROSCOPE_ASSETS` also carries 4 `logo-*-hoch.png` (60–70 KB) that **nothing consumes** on the edge (`grep '\.logoHoch\b'` → definition only).
  **Two real problems, one of them since answered.** (i) **D6 tension:** the spec excludes the cloud login from visual parity and keeps its Swiss-cross badge; porting the Balken makes the logged-in app show a *different* Agroscope mark from the login screen the user just left, so "match the promise the login screen makes" cuts against the port. **The product owner ruled on this before execution: "copy the edge" — the Balken is ported, the login badge is left alone.** That was this reading's recommended default, so T6 Step 0(i) is a record, not a gate. (ii) The cloud content column is `max-w-7xl` (`DashboardHeader.tsx:28`), not `max-w-[1600px]`, so the edge's alignment arithmetic is **wrong by construction** in the cloud and must be re-derived, not copied — that half is still work, because nobody can answer arithmetic for the implementer. **So T6's shape:** port the Balken crown, copy only the 4 `balken-horizontal-*.png`, skip `logoHoch` entirely, re-derive the margin for the cloud's own column, confirm the licensed-asset copy in one sentence of the report, and route the two-mark *relationship* to the designer review (which happens alongside T6, not before it).

**12. `glass-tabs`/`glass-tab` really does ship unused in the cloud and really is consumed by the edge — the one claim in the CSS group that is exactly right.** Zero consumers in cloud `frontend/src` outside `primitives.css`; consumed by edge `AppHeader.tsx:93` (`"glass-tabs inline-flex gap-1 p-1"`) and `:99` (`` `glass-tab px-5 py-2 text-[15px] font-semibold …` ``). One imprecision: the cited range `primitives.css:107-163` undershoots — `.glass-tabs` is `:107-116`, `.glass-tab` `:117-143`, and the `.glass-tab[aria-current='page']` reduced-transparency fallback runs to **`:166`**. The styling hook for the active pill is the attribute selector `.glass-tab[aria-current='page']` (`:134`), which means **`aria-current` is not decoration here — it is what draws the active state.** A port that sets a class instead of `aria-current` renders no active tab at all. T3's test asserts `aria-current` for that reason, not only for accessibility.

**13. `dashboard.json` is one of the namespaces with no cross-locale key test, and T3 adds keys to it.** Cloud locales: `public/locales/{de-CH,en,es,fr,it,lg,pt}/`, **10** namespaces each (`admin, auth, common, dashboard, deviceDetail, devices, history, journal, settings, support`). Edge: same 7 locales, **9** namespaces (`accountLink, auth, common, dashboard, devices, history, journal, settings, support`). **Neither side has a global key-equality test.** Cloud coverage: `journalLocales.test.ts` (full deep equality, `journal.json`), `settingsLocales.test.ts` (full equality for `settings.json` top level + `support.json` deep, but `dashboard.json` gets only a single sentinel check on `accountMenu.settings`), `analysisLocales.test.ts` (only `common.json`'s `analysis` subtree), plus five hand-picked-key presence tests. `admin.json`, `auth.json`, `deviceDetail.json` and `history.json` have **zero** cross-locale checks. **Resolution: T3 adds `tabs.zones`/`tabs.data`/`tabs.journal` to `dashboard.json` in 7 locales AND ships `dashboardLocales.test.ts` with full deep key equality for that namespace in the same task**, because the global constraint "7-locale key-set equality for every new string" is otherwise unenforceable exactly where this slice writes.

**14. The matrix's journal rows are stale, but not in the three ways the brief names — two of the three named claims are still accurate, and correcting the wrong thing would be worse than leaving it.** The brief says "the cloud-primary rebuild has overwritten the matrix's S3-era journal rows (single-plot, no photos, client-side paging), so those rows are stale". Verified against current HEADs:
  - **"single-plot only" — STILL ACCURATE.** `JournalCaptureModal.tsx:175` is `const [plotUuid, setPlotUuid] = useState('')` — one `<select>`, singular state, in **both** the V1 and the cloud-primary branch of the same modal. No multi-plot control exists.
  - **"client-side paging" — STILL ACCURATE, and the new path is worse.** V1 `JournalController.java:40-50` still takes only `includeDeleted`. The new `JournalV2Controller.java:52-59` `GET /api/v2/journal/workspaces/{workspaceUuid}/entries` takes **zero** query params. `EntryTable.tsx:17,132-170` still pages client-side over `ENTRY_PAGE_SIZE = 50`; its diff since S3 adds only two badge props.
  - **"no photos" — STALE, narrowly.** Photos exist, but only for `authority_state = 'cloud_primary'` workspaces, behind server flag `journal.v2.cloud-issuer-enabled`, via `JournalAttachmentController`/`JournalAttachmentService` + `S3JournalBlobStore` + a scanner sidecar. The V1 gateway-scoped capture path still has no photo UI.
  - **The rebuild is additive, not an overwrite.** It is a parallel V2 system (`backend/.../journal/v2/`, ~24 files, mounted at `/api/v2/journal/workspaces/...`) beside an untouched V1. `DetailPanel.tsx` is byte-unchanged and is **not used at all** for cloud-primary entries — `JournalPage.tsx:661-709` renders it only when `!cloudPrimary` and renders `EntryAttachmentsPanel` instead otherwise, so **correct/copy/void do not exist for cloud-primary entries**.
  **Resolution: T1 still runs first and is still cheap, but its justification changes** — the risk is not "we might rebuild what shipped", it is that the rows describe a single journal where there are now two with different capabilities, and the "no server-side filter/sort/paging" ledger bullet cites only the V1 endpoint when the V2 one is barer. T1 corrects the V1/V2 fork, the DetailPanel gap and the custom-vocab bullet, and **explicitly re-affirms single-plot and client-side paging with a fresh date** rather than deleting them.

**15. The S3 ledger's claim that a guard "scans only `src/pages`, so every component escapes it entirely" is wrong, and S6 must not inherit it.** All three guards resolve their root to `../src` and recurse the whole tree: `noInertTokenAlpha.test.ts` (both repos, `.ts`/`.tsx`, regex `/(?:bg|text|border|ring)-\[var\(--[a-z-]+\)\]\/\d+/`), `errorTokenMisuse.test.ts` (both repos, `.ts`/`.tsx`/`.css`), and `pageShellTokens.test.ts` (both repos). `pageShellTokens`'s root variable is *named* `pagesRoot` and that name is what the ledger appears to have read; the value is `path.resolve(import.meta.dirname, '../src')`. What it narrows on is the **class string**, matching only viewport-claiming shells (`min-h-screen`, `h-screen`, `min-h-[calc(`, `h-[100dvh]`) — which concentrates its findings in page files as a side effect, not as a scope. Consequence for S6: T3–T6 are already covered by all three guards, so a theme-blind class in the new header will be caught; and the still-open widening item in the S3 ledger is about **regex strength** (uppercase/digit token names, `outline-`/`accent-`/`divide-` utilities, multi-line template literals), not directory scope.

**16. Only ONE of the two external theme migrations exists.** The brief's out-of-scope note says "two external-model migrations of exactly this already exist on branches `theme/deepseek-migration` and `theme/kimi-migration`, so check those before anyone re-does the work". Verified: `theme/deepseek-migration` is `d646fc89` ("feat: migrate 47 files from hardcoded Tailwind palette to CSS custom-property theme tokens", **48 files, 365 insertions / 365 deletions**) on top of `74f40662`. `theme/kimi-migration` is **`74f40662` itself** — deepseek's parent, an ancestor of deepseek, with **zero** unique commits (`git log theme/deepseek-migration..theme/kimi-migration` empty) and an **empty diff** against `origin/AgroLink`. The Kimi migration was either never committed or was discarded; the branch is a label on the baseline. **Whoever picks up the theme-blind sweep has one prior attempt to review, not two, and should not spend time looking for the second.** Ledgered in T10.

**17. The cloud frontend suite baseline in the brief is stale; the other two are exact.** Measured this session at the stated heads: edge **117 node-runner / 1690 Vitest / 169 files** (brief: 117/1690/169 — exact); cloud frontend **110 node-runner (2 suites) / 697 Vitest / 116 files** (brief: 105/700/117 — **all three wrong**); cloud backend **1543 total, 1 skipped ⇒ 1542 executed, 0 failures, 276 classes** (brief: 1542/0 — exact, and the brief's number already excludes the skip). Both production builds exit 0. Nothing is red at baseline. The 1 skip is `journal.v2.JournalScannerBridgeIT`, Testcontainers-gated, skipped at baseline and therefore not a regression.

**18. The two reachability holes, stated exactly, because both are asymmetric and neither is a simple missing link.** The brief says `/analysis` is "desktop-and-flag-only with no mobile redirect gate" and `/history/zones/:id` is "mobile-only", concluding "desktop users have no path to zone history cards at all". All of that is confirmed, with one precision that changes what T5 must build:
  - **The gate is on the LINK, never on the ROUTE.** `PrivateRoute` checks only `isAuthenticated`. `CrossZoneAnalysisPage.tsx` contains zero references to `useFeatureFlags`, `historyUxEnabled`, `isDesktopBrowser` or `Navigate`. The desktop+flag condition lives at `Dashboard.tsx:40` (`const showDesktopData = flags.historyUxEnabled && isDesktopBrowser();`) and only decides whether `DashboardHeader.tsx:55-62` renders the `/analysis` link. So a mobile user who types the URL gets the full desktop page. The edge, by contrast, gates the **route**: `pages/AnalysisRoute.tsx:10-12` is `if (!isDesktopBrowser()) { return <Navigate to="/history" replace />; }`. T5 ports the route gate.
  - **`/history/zones/:zoneId`'s only in-app link is mobile-gated:** `components/farming/IrrigationZoneCard.tsx:261-267`, `{!isDesktopBrowser() && flags.historyUxEnabled && (<Link to={`/history/zones/${zone.id}`}>…`. Nothing else links it, including `HistoryDashboard` itself. So desktop has no path — confirmed. **T5 removes both conditions, not just the device one:** T3 Step 0 establishes that `historyUxEnabled` is hardcoded `true` server-side and can only read `false` when the features endpoint errors, so the flag condition does not express an operator preference — it deletes the link in the failure mode.
  - **`isDesktopBrowser` fails OPEN to desktop.** The edge helper (`src/utils/isDesktopBrowser.ts`) tests `navigator.userAgentData.mobile`, falls back to a UA regex, and returns `true` when detection is impossible. So an undetectable client is treated as desktop and, once T5 lands the route gate, keeps `/analysis` rather than being bounced to `/history`. That is the safer failure for this pair and is called out so a reviewer does not read it as a fail-open bug.

---

## Reference: the shell surface, measured

Measured at edge `d2851111` / cloud `d091af2f`. **Re-measure rather than re-quote** — these are the drift detectors for S6 exactly as suite deltas are for the rest of the plan.

### Cloud routes and their in-app inbound links

| Route | Component | Inbound in-app links | S6 |
|---|---|---|---|
| `/dashboard` | `Dashboard` | catch-all `*`, and every page's "back" link | T3 mounts tabs |
| `/history` | `HistoryDashboard` | **ZERO** | T3 (Data tab, mobile) + T5 |
| `/history/zones/:zoneId` | `HistoryDashboard` | 1, mobile-gated (`IrrigationZoneCard.tsx:261-267`) | T5 (desktop path) |
| `/analysis` | `CrossZoneAnalysisPage` (lazy) | 1, desktop+flag-gated (`DashboardHeader.tsx:55-62`) | T3 (Data tab, desktop) + T5 (route gate) |
| `/journal` | `JournalPage` | 1 (`DashboardHeader.tsx:63-68`) | T3 (Journal tab) |
| `/account` | `Account` | 1 (Account menu `:78`) | — |
| `/settings` | `SettingsPage` | 1 (Account menu `:79`) | — |
| `/support-requests` | `SupportRequestsPage` | 2 (Account menu `:80`, `SettingsPage.tsx:267`) | — |
| `/gateway-access` | `GatewayAccessAdminPage` | 1 (Account menu `:81`) | T4 (gradient) |
| `/devices/:deviceEui` | `DeviceDetail` | **ZERO** | T5 (link from device cards) |
| `/admin/users` | `AdminUsers` | 1 (Admin menu `:41`) | T4 (gradient) |
| `/admin/devices` | `AdminDevices` | 1 (Admin menu `:42`) | T4 (gradient) |
| `/admin/work-requests` | `AdminWorkRequests` | 1 (Admin menu `:43`) | T4 (gradient) |
| `/admin/prediction` | `AdminPrediction` | **not in the Admin menu**; 1 conditional link from `components/farming/prediction/PredictionCard.tsx:542-549` (`/admin/prediction?zoneId=…`, gated `isAdmin`), reached via `IrrigationZoneCard.tsx:456` on Dashboard | T5 (Admin menu) + T4 (gradient) |

**Correction to the brief:** `/admin/prediction` is *not* reachable only by typing a URL — `PredictionCard` links it. It is absent from the **Admin menu**, which is the claim T5 fixes.

### Cloud hardcoded chrome palette (decision 2)

| Site | Class | Belongs to | Task |
|---|---|---|---|
| `DashboardHeader.tsx:39` | `bg-purple-600 hover:bg-purple-700 text-white` | Admin menu trigger | T4 |
| `DashboardHeader.tsx:58` | `bg-emerald-700 hover:bg-emerald-800 text-white` | Data link | **T3 deletes it** (superseded by the Data tab) |
| `DashboardHeader.tsx:65` | `bg-teal-700 hover:bg-teal-800 text-white` | Journal link | **T3 deletes it** (superseded by the Journal tab) |
| `DashboardHeader.tsx:76` | `bg-slate-900 hover:bg-slate-800 text-white` | Account menu trigger | T4 |
| `pages/admin/AdminUsers.tsx:84` | `bg-gradient-to-r from-purple-700 to-purple-600` | page header | T4 |
| `pages/admin/AdminDevices.tsx:81` | `bg-gradient-to-r from-purple-700 to-purple-600` | page header | T4 |
| `pages/admin/AdminWorkRequests.tsx:112` | `bg-gradient-to-r from-purple-700 to-purple-600` | page header | T4 |
| `pages/admin/AdminPrediction.tsx:653` | `bg-gradient-to-r from-slate-900 via-slate-800 to-slate-700` | page header | T4 |
| `pages/GatewayAccessAdminPage.tsx:399` | `border-b border-emerald-900/20 bg-gradient-to-r from-emerald-950 to-emerald-800` | page header | T4 |

**The brief lists the four `DashboardHeader` colours in a different order than the file does.** Its ordering reads as line 39 = emerald/Data; the file has line 39 = purple/Admin. The *set* is right. Re-derive from the file.

### Edge silent-hiding inventory (reading 7)

| Kind | Count | Sites | Task |
|---|---|---|---|
| `<CanWrite>` wrapper | 1 | `pages/JournalPage.tsx:332-341` | T8 |
| inline `canWrite &&`, Settings gate | 3 | `pages/{JournalPage.tsx:237,HistoryDashboard.tsx:413,CrossZoneAnalysisPage.tsx:173}` — all three `showSettings={canWrite && !scopeLoading}` | **T7** |
| inline `canWrite &&`, page content | **14** | `IrrigationZoneCard.tsx:208,240,375,408,570,586,595,602`; `JournalWorkspace.tsx:375`; `DetailPanel.tsx:432`; `FarmingDashboard.tsx:152,186,355,361` | T8 |
| `showSettings={canWrite}`, **no `&&`** | 1 | `DashboardHeader.tsx:39` — T7 deletes it, but it is **not** one of the 17 and must not be subtracted from T8's count | T7 |
| `readOnly={!canWrite}` disable-without-explanation | 10 | `IrrigationZoneCard.tsx`, `FarmingDashboard.tsx` | T8 covers by page-level notice; individual controls unchanged |
| explanations of any kind | **0** | — | T8 |

---

## File map

| File | Repo / area | Task |
|---|---|---|
| `docs/superpowers/plans/agrolink-gui-parity-matrix.md` (journal rows + journal ledger bullets) | osi-os | T1 |
| `web/react-gui/src/ui-core/{Modal.tsx,tokens.css}`, `web/react-gui/src/ui-core/__tests__/feedback.test.tsx`, `web/react-gui/tests/uiCoreTokens.test.ts`, `web/react-gui/tests/dangerFgPairing.test.ts` (new), `web/react-gui/src/components/farming/SystemPanel.tsx` | osi-os (canonical) | T2 |
| `frontend/src/ui-core/{Modal.tsx,tokens.css}` (re-vendored), `frontend/src/ui-core/__tests__/feedback.test.tsx` (re-vendored), `frontend/tests/dangerFgPairing.test.ts` (new) | osi-server | T2 |
| `frontend/src/components/AppHeader.tsx` (new), `frontend/src/components/DashboardHeader.tsx` (rewritten as a wrapper), `frontend/src/pages/{Dashboard,HistoryDashboard,CrossZoneAnalysisPage,JournalPage}.tsx` (`Dashboard.tsx` is edited too — it passes `showDesktopData`, which T3 removes from `DashboardHeaderProps`, so `tsc` forces it), 7× `public/locales/*/dashboard.json`, `frontend/tests/dashboardLocales.test.ts` (new), `frontend/src/components/__tests__/AppHeader.test.tsx` (new) | osi-server | T3 |
| `frontend/src/components/DashboardHeader.tsx`, `frontend/src/pages/admin/{AdminUsers,AdminDevices,AdminWorkRequests,AdminPrediction}.tsx`, `frontend/src/pages/GatewayAccessAdminPage.tsx`, `frontend/tests/chromeTokens.test.ts` (new) | osi-server | T4 |
| `frontend/src/App.tsx`, `frontend/src/pages/AnalysisRoute.tsx` (new), `frontend/src/components/DashboardHeader.tsx`, `frontend/src/components/farming/{IrrigationZoneCard,deviceRegistry}.tsx` (+ the device card that owns the link), 7× `dashboard.json`/`devices.json`, `frontend/src/pages/__tests__/`, `frontend/tests/routeReachability.test.ts` (new) | osi-server | T5 |
| `frontend/src/branding/agrolink.ts` (new), `frontend/src/assets/agroscope/balken-horizontal-{en,de,fr,it}.png` (new), `frontend/src/assets/agroscope/README.md`, `frontend/src/index.css`, `frontend/src/components/AppHeader.tsx`, `frontend/tests/agrolinkBranding.test.ts` | osi-server | T6 |
| `web/react-gui/src/components/ReadOnlyNotice.tsx` (**new — T7 creates it, T8 consumes it**), `web/react-gui/src/App.tsx`, `web/react-gui/src/components/{DashboardHeader,WritableOnly}.tsx`, `web/react-gui/src/pages/{SettingsPage,JournalPage,HistoryDashboard,CrossZoneAnalysisPage}.tsx`, 7× `public/locales/*/{settings,common}.json`, `web/react-gui/tests/{settingsReadSafe,readOnlyNoticeLocales}.test.ts` (new) | osi-os | T7 |
| `web/react-gui/src/pages/{FarmingDashboard,JournalPage,HistoryDashboard}.tsx`, component tests | osi-os | T8 |
| `web/react-gui/src/components/farming/*` (the capability-silent cards), 7× `public/locales/*/devices.json`, `web/react-gui/tests/capabilityStateLocales.test.ts` (new), component tests | osi-os | T9 |
| `docs/superpowers/plans/agrolink-gui-parity-matrix.md` (S6 rows + ledger) | osi-os | T10 |
| (verification only) | both | T11 |

---

### Task 1: Correct the matrix's journal rows against the V1/V2 fork

Reading 14. Cheapest task in the plan and it runs first, so that no later task plans journal work from a description of a journal that no longer exists alone. **Two of the three claims the brief calls stale are still true and must be re-affirmed with a fresh date, not deleted** — re-dating an accurate row is the mechanism that distinguishes "checked today" from "never checked", which is the whole point of this document's provenance rule.

**Files:**
- Modify: `docs/superpowers/plans/agrolink-gui-parity-matrix.md` (osi-os)

**Interfaces:** none. No code, no tests, no suite delta.

- [ ] **Step 1: Re-verify each claim yourself before editing a single row**

Do not take reading 14 on trust; it expires. Run these and paste the output into the task report:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
grep -n 'plotUuid' frontend/src/components/journal/capture/JournalCaptureModal.tsx | head
grep -n 'ENTRY_PAGE_SIZE\|activePage' frontend/src/components/journal/workspace/EntryTable.tsx | head
grep -n 'RequestParam\|GetMapping' backend/src/main/java/org/osi/server/journal/JournalController.java | head -20
grep -n 'RequestParam\|GetMapping' backend/src/main/java/org/osi/server/journal/v2/JournalV2Controller.java | head -20
grep -rn 'cloudPrimary' frontend/src/pages/JournalPage.tsx | head -20
ls backend/src/main/java/org/osi/server/journal/v2/
```

Expected: a single `plotUuid` state (single-plot **still true**); `ENTRY_PAGE_SIZE`/`activePage` client-side paging (**still true**); `JournalController` taking only `includeDeleted`; `JournalV2Controller`'s entries endpoint taking **no** query params; `JournalPage` branching on `cloudPrimary`; a populated `v2/` package. **If any expectation fails, report it and correct this task's edits accordingly — do not force-fit the row text below.**

- [ ] **Step 2: Rewrite the five journal rows**

Edit **only** these rows, and only their own provenance dates (the matrix header forbids a bulk date refresh; an untouched row keeping its old date is the signal it still needs a look):

1. **Field journal** — replace the S3 description with the fork. The row must state: the cloud journal is now **two** systems, a V1 gateway-scoped path (`/api/v1/journal/gateways/{eui}/…`, unchanged since S3) and a V2 workspace path (`/api/v2/journal/workspaces/{uuid}/…`, `authority_state ∈ {legacy, blocked, cloud_primary}`), selected per workspace and gated for *new* cloud-primary workspaces by server flag `journal.v2.cloud-issuer-enabled` (fails closed). `JournalPage.tsx` branches its whole data flow on `cloudPrimary` and adds a workspace selector/creator and a conflict-resolution section.
2. **Journal entry table** — keep the columns/sort/pager text (**still accurate**), add that rows now carry conflict and stuck-photo badges (`conflictedEntryUuids`, `failedAttachmentEntryUuids`), populated only for cloud-primary workspaces.
3. **Journal capture flow** — keep "the edge's 2905-line flow is deliberately NOT ported" (**still accurate**), and add that `JournalCaptureModal` has grown photo-upload state, cloud-primary validation and workspace/actor plumbing. **Keep "single-plot only" and mark it re-verified**, citing `JournalCaptureModal.tsx:175`.
4. **Journal detail panel** — add the split: `DetailPanel.tsx` is byte-unchanged **and is not used at all for cloud-primary entries** (`JournalPage.tsx:661-709` renders it only when `!cloudPrimary`, `EntryAttachmentsPanel` otherwise), so **correct / copy / void do not exist for cloud-primary entries** — a photo view/retry/remove surface is all there is. This is the single most consequential correction in T1: the row currently promises a capability the new path does not have.
5. **Journal catalog delivery (v10)** — re-affirm unchanged, with a fresh date. Evidence: `git diff --stat` over `backend/src/main/resources/journal-catalog` and `docs/contracts/journal-catalog` between the S4 head and current HEAD is empty.

- [ ] **Step 3: Correct three ledger bullets**

- **"Cloud journal list has no server-side filter, sort or paging"** — extend to cite **both** endpoints: V1 takes only `includeDeleted`; the new V2 entries endpoint takes **zero** params. Note the V2 path is barer than the one the bullet was written about.
- **"Cloud capture cannot see custom vocab or farm products"** — split it. Still true for the V1 gateway-scoped path. **Not** true for cloud-primary workspaces: `JournalV2Controller`'s catalog endpoint merges `referenceService.products(...)` and `referenceService.customVocabulary(...)` from new workspace-owned tables (`journal_products_v2`, `journal_custom_vocab_v2`) — a different mechanism from the `journal_vocab_mirror` the bullet describes, not a fix of it.
- **"Nothing server-side stops a cloud client from minting a catalog orphan"** — extend: `JournalRevisionService` (V2) validates structurally via `canonicalizer.validateEntry`/`validateAgainstLatestPlot` but performs **no** catalog lookup, so V2 has the identical gap. Two systems, one unclosed hole.

- [ ] **Step 4: Record what could not be determined statically**

Add, verbatim, so the next reader does not mistake code-reading for behaviour-checking:

> Not verified without a running instance: whether `journal.v2.cloud-issuer-enabled` is on for any live gateway, and therefore whether any user can currently reach the V2 photo or conflict surfaces at all. No end-to-end confirmation of photo upload or conflict resolution exists — the evidence above is static code only.

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add docs/superpowers/plans/agrolink-gui-parity-matrix.md
git commit -m "docs: matrix journal rows — the V1/V2 fork, and what the fork does not carry"
```

**Expected suite delta: 0 / 0.** No code changes.

---

### Task 2: `ui-core` batch — translucent modal scrim, `color-scheme`, and the real `--danger-fg` defect

Maintainer decision 5, the `color-scheme` item from decision F, and reading 10. **This task does NOT change `--danger-fg`**; reading 10 shows the brief's 4.46-on-`--bg` pairing does not occur in either product, and darkening a shared token would move a production farm GUI to fix nothing. It fixes the 3.253:1 defect the surface walk actually found and fences the failing pairings with a guard. `ui-core` is canonical in osi-os and re-vendored to osi-server **in this same task** (D2).

**Files:**
- Modify: `web/react-gui/src/ui-core/Modal.tsx` (osi-os, canonical)
- Modify: `web/react-gui/src/ui-core/tokens.css` (osi-os, canonical)
- Modify: `web/react-gui/src/ui-core/__tests__/feedback.test.tsx` (osi-os)
- Modify: `web/react-gui/tests/uiCoreTokens.test.ts` (osi-os)
- Create: `web/react-gui/tests/dangerFgPairing.test.ts` (osi-os)
- Modify: `web/react-gui/src/components/farming/SystemPanel.tsx` (osi-os)
- Modify: `frontend/src/ui-core/{Modal.tsx,tokens.css}`, `frontend/src/ui-core/__tests__/feedback.test.tsx` (osi-server, byte copies)
- Create: `frontend/tests/dangerFgPairing.test.ts` (osi-server)

**Interfaces:**
- Produces: `Modal`'s public props are **unchanged** (`isOpen`, `title`, `onClose`, `closeLabel?`, `children`) — only its overlay class changes, so no call site in either repo needs editing. Adds the `color-scheme` declaration to both theme blocks of `tokens.css`, consumed implicitly by all **23** native date/time inputs across the two GUIs (edge 7, cloud 16). Adds one guard consumed by no code.
- Consumes: nothing from earlier tasks. T2 is independent of T1 and could run first; it is second only because T1 is cheaper.

- [ ] **Step 1: Write the failing tests**

Three separate assertions, in the two files they belong to.

**(a)** In `web/react-gui/src/ui-core/__tests__/feedback.test.tsx`, assert the scrim is translucent. Read the file first and match its existing import and render helpers rather than assuming them:

```tsx
it('dims with a translucent scrim so the dialog does not erase its context', () => {
  const { container } = render(
    <Modal isOpen title="T" onClose={() => {}}>body</Modal>,
  );
  const scrim = container.querySelector('.fixed.inset-0');
  assert.ok(scrim, 'the overlay element must exist');
  // v3.4 cannot alpha-modify a var() colour, so the translucency must be a
  // color-mix, not `bg-[var(--overlay)]/70` — which compiles to zero CSS.
  expect(scrim!.className).toContain('color-mix(in_srgb,var(--overlay)_70%,transparent)');
  expect(scrim!.className).not.toContain('bg-[var(--overlay)]');
});
```

**A stronger verification pattern already exists on the cloud side — read it before writing (a).** `frontend/tests/modalBackdropDims.test.ts` compiles the real `ui-core/tailwind-preset.js` through PostCSS/Tailwind and asserts that each of three backdrop class strings produces an actual `background-color: color-mix(in srgb, var(--overlay) 70%, transparent)` declaration — it proves the utility **compiles**, which the `toContain` assertion above cannot. Its three sites (`GatewayCard.tsx:254`, `IrrigationZoneCard.tsx:509`, `PredictionConfigModal.tsx:204`) are the `--overlay` 70% precedent this step aligns to, so that file is *also* the evidence that 70% is already a shipped, guarded number here. Reuse its compile-through-PostCSS shape if you want a real proof rather than a string match; **do not edit `modalBackdropDims.test.ts` itself** — it is not in this task's file list and touching it would show up as a scope breach in T11 Step 6.

**(b)** Append to `web/react-gui/tests/uiCoreTokens.test.ts` (its path constant is `tokensPath`, lowercase — confirm by reading the file, do not assume `TOKENS_PATH`):

```ts
test('both theme blocks declare color-scheme so native date pickers match the theme', () => {
  const css = fs.readFileSync(tokensPath, 'utf8');
  const split = css.indexOf("html[data-theme='dark']");
  assert.ok(split > 0, 'the dark block must exist');
  assert.match(css.slice(0, split), /color-scheme:\s*light;/);
  assert.match(css.slice(split), /color-scheme:\s*dark;/);
});
```

**(c)** Create `web/react-gui/tests/dangerFgPairing.test.ts`. This is the guard, and it is the one that must be proven to fail on real code.

**The guard has to be variant-aware, and that is not a refinement — a naive version flags this task's own fix.** Step 3(c) corrects `SystemPanel.tsx:236` by swapping *both* the background and the text inside the same `hover:` variant (`hover:bg-[var(--error-bg)] hover:text-[var(--error-text)]`). A guard that asks only "does this class string contain a forbidden `bg-[var(…)]` **and** `text-[var(--danger-fg)]`" matches `bg-\[var\(--error-bg\)\]` inside `hover:bg-[var(--error-bg)]`, cannot see that the same variant also swapped the text, and so reports the *corrected* line as an offender. A guard with a known false positive on the very line it was written for gets disabled or worked around, so it is built variant-aware from the start:

1. Split the class string on whitespace into tokens.
2. For each token, separate any variant prefix from the utility, splitting on `:` **only where the colon occurs before the first `[`** — arbitrary values like `bg-[color-mix(in_srgb,var(--overlay)_70%,transparent)]` must not be torn apart. No prefix means the base variant.
3. Group the tokens by variant.
4. For each variant *p*, compute the **effective** background (*p*'s own `bg-` if it has one, else the base variant's) and the **effective** text colour (*p*'s own `text-` if it has one, else the base variant's).
5. Flag only a variant whose effective background is in `FORBIDDEN_BG` **and** whose effective text is `--danger-fg`.

The rejected alternative was `hover:opacity-90`, the idiom the edge's existing `tests/errorButtonHover.test.ts` already sanctions for destructive-button hovers. It is rejected here because it fades the whole row including its borders — a different visual result that would need its own measurement — not because it is unsupported.

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// --danger-fg (#DC2626 light) clears 4.5:1 only on --card (4.83). Measured
// against every other surface it could land on it FAILS as body text:
//   --bg      #F4F6F8  4.458
//   --surface #E8EDF2  4.100
//   --error-bg #FEE2E2 3.953
//   --border  #CBD5E1  3.253   <- SystemPanel's hover state before S6 T2
// All four clear 3:1, so --danger-fg stays legal as a BORDER on all of them
// (that is exactly how Banner.tsx:7 and Chip.tsx:9 use it). This guard fences
// the text case, PER VARIANT: a state variant may not end up with an effective
// background from that list while its effective text colour is --danger-fg.
// Per-variant is the whole point — `hover:bg-[var(--error-bg)]` paired with
// `hover:text-[var(--error-text)]` is CORRECT and must not be flagged, while
// `hover:bg-[var(--error-bg)]` on its own inherits the base --danger-fg text
// and must be.
const FORBIDDEN_BG = ['--bg', '--surface', '--error-bg', '--border'];
const DANGER = '--danger-fg';
const srcRoot = path.resolve(import.meta.dirname, '../src');

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : files(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

// Extract each quoted/backticked class-string-shaped literal, so a multi-line
// template literal is inspected as ONE string rather than line by line — the
// same-line weakness the S3 ledger records for errorTokenMisuse.
function classStrings(source: string): string[] {
  return [...source.matchAll(/(["'`])((?:[^\\]|\\.)*?)\1/gs)]
    .map((m) => m[2])
    .filter((s) => s.includes('-[var(--'));
}

/**
 * Split `hover:text-[var(--x)]` into { variant: 'hover', utility:
 * 'text-[var(--x)]' }. Only a colon BEFORE the first `[` separates a variant,
 * so arbitrary values keep their own colons: `bg-[color-mix(in_srgb,…)]` and
 * `text-[var(--x)]` stay whole. Stacked variants (`dark:hover:…`) come back as
 * one composite variant key, which is what we want — `dark:hover` is its own
 * rendering state and must be resolved as one.
 */
function splitVariant(token: string): { variant: string; utility: string } {
  const bracket = token.indexOf('[');
  const limit = bracket === -1 ? token.length : bracket;
  const lastColon = token.lastIndexOf(':', limit - 1);
  if (lastColon === -1) return { variant: '', utility: token };
  return { variant: token.slice(0, lastColon), utility: token.slice(lastColon + 1) };
}

const tokenOf = (utility: string, prefix: 'bg' | 'text'): string | undefined =>
  new RegExp(`^${prefix}-\\[var\\((--[a-z-]+)\\)\\]$`).exec(utility)?.[1];

/** Variants of `cls` whose EFFECTIVE bg/text pair fails. Empty means legal. */
function failingVariants(cls: string): string[] {
  const byVariant = new Map<string, { bg?: string; text?: string }>();
  for (const token of cls.split(/\s+/).filter(Boolean)) {
    const { variant, utility } = splitVariant(token);
    const bg = tokenOf(utility, 'bg');
    const text = tokenOf(utility, 'text');
    if (!bg && !text) continue;
    const entry = byVariant.get(variant) ?? {};
    if (bg) entry.bg = bg;
    if (text) entry.text = text;
    byVariant.set(variant, entry);
  }
  const base = byVariant.get('') ?? {};
  const failing: string[] = [];
  for (const [variant, entry] of byVariant) {
    const bg = entry.bg ?? base.bg;
    const text = entry.text ?? base.text;
    if (bg && text === DANGER && FORBIDDEN_BG.includes(bg)) failing.push(variant || 'base');
  }
  return failing;
}

test('no element pairs text-[var(--danger-fg)] with a background it fails AA on', () => {
  // Table cases first, so the resolver itself is proven in both directions
  // before it is pointed at the tree. Without these the guard could be
  // silently over- or under-matching and still report zero offenders.
  // Kept as assertions inside this one test() — NOT extra test() calls — so
  // the suite delta stays +1 per repo and T11's arithmetic holds.
  assert.deepEqual(
    failingVariants('bg-[var(--card)] hover:bg-[var(--border)] text-[var(--danger-fg)]'),
    ['hover'],
    'a hover bg swap that leaves the base danger text in place must be flagged',
  );
  assert.deepEqual(
    failingVariants(
      'bg-[var(--card)] hover:bg-[var(--error-bg)] text-[var(--danger-fg)] hover:text-[var(--error-text)]',
    ),
    [],
    'swapping bg AND text in the same variant is the correct fix and must NOT be flagged',
  );
  assert.deepEqual(
    failingVariants('bg-[var(--surface)] text-[var(--danger-fg)]'),
    ['base'],
    'a base-variant failing pair must be flagged',
  );
  assert.deepEqual(
    failingVariants('border border-[var(--border)] text-[var(--danger-fg)]'),
    [],
    'a border token is not a background — --danger-fg clears 3:1 on all four',
  );
  assert.deepEqual(
    failingVariants(
      'bg-[color-mix(in_srgb,var(--overlay)_70%,transparent)] text-[var(--danger-fg)]',
    ),
    [],
    'an arbitrary value containing colons must not be split into a bogus variant',
  );

  const offenders: string[] = [];
  for (const file of files(srcRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const cls of classStrings(source)) {
      if (!cls.includes(`text-[var(${DANGER})]`)) continue;
      for (const variant of failingVariants(cls)) {
        offenders.push(`${path.relative(srcRoot, file)}: ${variant} variant pairs text-[var(${DANGER})] with a failing background`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
```

- [ ] **Step 2: Run all three and confirm they fail, for the right reasons**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npx tsx --test tests/uiCoreTokens.test.ts tests/dangerFgPairing.test.ts
npx vitest run src/ui-core/__tests__/feedback.test.tsx
```
Expected, precisely:
- `uiCoreTokens.test.ts` — the new `color-scheme` test FAILS on the light assertion (`color-scheme` appears nowhere in either repo; the only matches for the string anywhere are `matchMedia('(prefers-color-scheme: dark)')` in `utils/displayPreferences.ts` and `main.jsx`, which are JS media queries, not the CSS property). Every pre-existing test in the file PASSES.
- `dangerFgPairing.test.ts` — the five table assertions PASS (they are pure-function cases and do not depend on the tree), then the tree scan FAILS with **exactly one** offender: `components/farming/SystemPanel.tsx: hover variant …`. The current class string at `:236` is `bg-[var(--card)] hover:bg-[var(--border)] text-[var(--danger-fg)] …` with **no `hover:text-`**, so the `hover` variant's effective text falls back to the base `--danger-fg` over `--border` — 3.253, the real defect. **If it reports zero, the guard is vacuous — stop and fix the extractor before continuing.** If it reports more than one, the extra sites are real findings: report them and fix them in this task. The 8 `DetailPanel.tsx` sites (`:460,651,656,661,855,860,1057,1082`) must **not** appear: verified, none of their class strings carries a `bg-` utility at all (`:460` has `border-[var(--border)]`, which is a border, not a background; the other seven are bare `<p>` text classes), so they have no effective background and are correctly unflagged.
- `feedback.test.tsx` — the new scrim test FAILS on `toContain('color-mix…')`.

- [ ] **Step 3: Make the three changes**

**(a)** `web/react-gui/src/ui-core/Modal.tsx:14` — replace the opaque scrim. `--overlay` is a solid hex (`#334155` light, `#050807` dark), so `bg-[var(--overlay)]` erases the page behind every dialog:

```tsx
    <div className="fixed inset-0 bg-[color-mix(in_srgb,var(--overlay)_70%,transparent)] flex items-center justify-center z-50 p-4">
```

**70%, not 60%, and the reason is that 70% is already the shipped number for this exact mechanism.** Cloud `frontend/tests/modalBackdropDims.test.ts` compile-tests three backdrops (`GatewayCard.tsx:254`, `IrrigationZoneCard.tsx:509`, `PredictionConfigModal.tsx:204`) that already use `bg-[color-mix(in_srgb,var(--overlay)_70%,transparent)]` — same token, same `color-mix` mechanism, and already fenced by a guard. Those are the only **token-based, theme-aware** scrims in either repo. The eight hand-rolled `bg-black/50` scrims (edge `ZoneConfigModal.tsx:267`, `DraginoSettingsModal.tsx:375`, `JournalWorkspace.tsx:178`, `LayoutTransitionReviewSheet.tsx:85`; cloud `AssignDeviceModal.tsx:54`, `ClaimGatewayModal.tsx:45`, `DownlinkConfirmModal.tsx:25`, `ZoneConfigModal.tsx:397`) are the legacy theme-blind sites this primitive exists to replace, so they are not the number to converge on. Picking 70% means every scrim in the program lands on one value; picking 60% would leave three already-guarded ones disagreeing with the primitive. `--overlay`'s theme-awareness is what `black/50` lacks and is the reason for the token in the first place. **Underscores, not spaces**, inside the arbitrary value — Tailwind converts `_` to a space, and a literal space would break the class. `color-mix(in_srgb,…)` is already proven in this codebase at 15+ cloud call sites and 4 edge ones, so this is not a new mechanism.

**(b)** `web/react-gui/src/ui-core/tokens.css` — add one declaration to each theme block. Put it as the **first** declaration in each block, with this comment:

```css
  /* Tell the UA which theme its own widgets should render in. Without this,
     every native date/time picker paints its glyphs dark-on-dark over a token
     surface in the dark theme — 23 inputs across the two GUIs (edge 7, cloud
     16). This is a UA-widget hint, not a colour: it changes no token value and
     no rendered class, so the edge's own light rendering is untouched. */
  color-scheme: light;
```
and in `html[data-theme='dark']`, the same comment reference plus `color-scheme: dark;`.

**Verify the theme mechanism before trusting this.** `tokens.css` keys dark off `html[data-theme='dark']`, so `color-scheme` follows the explicit attribute, not `prefers-color-scheme`. If the app also supports a "system" setting that leaves the attribute unset, the light value applies and native pickers stay light on a dark OS — **state which behaviour you found in `utils/displayPreferences.ts` in the task report**, and if `data-theme` is left unset in system mode, add the `@media (prefers-color-scheme: dark)` companion in the same commit rather than shipping a half fix.

**(c)** `web/react-gui/src/components/farming/SystemPanel.tsx:236` — the hover background is the defect, not the text colour. The element currently reads `bg-[var(--card)] hover:bg-[var(--border)] text-[var(--danger-fg)] …`: at rest it is 4.829 (passes), on hover it becomes 3.253 (fails). Replace the hover fill with the danger wash, which is the semantically correct hover for a destructive control and measures **3.953** for the text — still under 4.5, so **also** darken the text to `--error-text` on hover, which measures **8.20** on `--error-bg`:

```tsx
className="bg-[var(--card)] hover:bg-[var(--error-bg)] text-[var(--danger-fg)] hover:text-[var(--error-text)] font-semibold px-4 py-2 rounded-lg text-sm transition-colors"
```
Re-derive the line number with `grep -n 'danger-fg' src/components/farming/SystemPanel.tsx` before editing; T2 is the first task to touch this file but the plan's citation still expires. Confirm from the file that this element is the destructive control it appears to be (single mount, `pages/FarmingDashboard.tsx:342`) and say so in the report; if it is not destructive, the wash is wrong and you should instead keep `--card` on hover and change only the shade.

- [ ] **Step 4: Run the three tests again**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npx tsx --test tests/uiCoreTokens.test.ts tests/dangerFgPairing.test.ts
npx vitest run src/ui-core/__tests__/feedback.test.tsx
```
Expected: all PASS — and specifically, `dangerFgPairing` goes green **because the guard is variant-aware**, not because the offender was removed. Step 3(c)'s corrected class string still contains `bg-[var(--error-bg)]` (inside `hover:`) and still contains `text-[var(--danger-fg)]` (in the base variant); a naive substring guard would report it as an offender and this step's "all PASS" would be false. What makes it legal is that the `hover` variant supplies its own `hover:text-[var(--error-text)]`, so that variant's effective pair is `--error-text` on `--error-bg` = 8.20. **Say this in the report**, because "the guard I wrote does not flag the fix I wrote" is a claim a reviewer should see reasoning for, and Step 5's first mutation is its proof.

- [ ] **Step 5: Mutation-test the guard — a check that has never failed is not a check**

Three mutations, in this order. Paste the red and green output for each.

1. **Delete only `hover:text-[var(--error-text)]`** from the corrected `SystemPanel.tsx:236` class string, leaving `hover:bg-[var(--error-bg)]` in place. `dangerFgPairing` must go **red naming the `hover` variant of `SystemPanel.tsx`** — the `hover` bg is forbidden and its text now falls back to the base `--danger-fg`. Restore, confirm green. **This is the mutation that matters:** it is red iff the guard resolves variants, and green iff the guard also honours a same-variant text swap, so one revert cycle proves both directions of the behaviour Step 4 depends on.
2. **Add `bg-[var(--surface)]`** to one of the `DetailPanel.tsx` danger-text `<p>` class strings. Must go red naming that file's `base` variant. Revert, confirm green.
3. The five table assertions in the test are themselves the false-positive proof and run on every invocation — if any of them is deleted to make a run pass, that is a process failure, not a fix.

Then do the same revert cycle for the `color-scheme` test by temporarily deleting the dark declaration.

- [ ] **Step 6: Re-vendor to osi-server in this same task, and verify both directions**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
cp web/react-gui/src/ui-core/Modal.tsx  /home/phil/Repos/osi-server/.worktrees/agrolink/frontend/src/ui-core/Modal.tsx
cp web/react-gui/src/ui-core/tokens.css /home/phil/Repos/osi-server/.worktrees/agrolink/frontend/src/ui-core/tokens.css
cp web/react-gui/src/ui-core/__tests__/feedback.test.tsx /home/phil/Repos/osi-server/.worktrees/agrolink/frontend/src/ui-core/__tests__/feedback.test.tsx
cp web/react-gui/tests/dangerFgPairing.test.ts /home/phil/Repos/osi-server/.worktrees/agrolink/frontend/tests/dangerFgPairing.test.ts
```

Then run **both** verifiers. **Each takes a different env var** — this exact mistake cost S4's T1 a wrong brief, so run them rather than trusting the names:

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
OSI_SERVER_ROOT=/home/phil/Repos/osi-server/.worktrees/agrolink sh scripts/verify-ui-core-vendor.sh
sh scripts/verify-ui-core-vendor.test.sh
cd /home/phil/Repos/osi-server/.worktrees/agrolink
EDGE_UI_CORE_ROOT=/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep sh scripts/verify-ui-core-vendor.sh
sh scripts/verify-ui-core-vendor.test.sh
diff -r /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui/src/ui-core \
        /home/phil/Repos/osi-server/.worktrees/agrolink/frontend/src/ui-core
```
Expected: `verify-ui-core-vendor: OK` from both directions and an empty `diff -r`. **If an env-var name is rejected, read the script and report the real name** — do not guess a third. Remember these gates do **not** run in CI on this branch (reading 2), so this local run is the only evidence that exists.

- [ ] **Step 7: Cloud suites, including the guard on the cloud's own tree**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx tsx --test tests/dangerFgPairing.test.ts
npm run test:unit && npm run build
```
Expected: the cloud guard PASSES with **zero** offenders from the tree scan on the first run — the cloud has no live `text-[var(--danger-fg)]` site (its 3 grep hits are two test assertions in `components/journal/workspace/__tests__/DetailPanel.test.tsx:536,559` and a comment at `DetailPanel.tsx:325`). The **tree scan** is therefore vacuous on this side, and that is acceptable only because it was proven red on the edge in Step 2 — say so explicitly rather than presenting a green run as evidence. The five table assertions are **not** vacuous anywhere: they exercise the resolver directly and would fail in either repo if the variant logic broke, which is the one part of this guard that is genuinely tested on the cloud side.

Watch for the scrim change in the cloud Vitest run: any snapshot or class assertion that hardcoded `bg-[var(--overlay)]` will now fail. That is a **correct** failure; update the assertion, do not revert the scrim.

- [ ] **Step 8: Commit both repos**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add web/react-gui/src/ui-core web/react-gui/tests/uiCoreTokens.test.ts \
        web/react-gui/tests/dangerFgPairing.test.ts web/react-gui/src/components/farming/SystemPanel.tsx
git commit -m "fix(ui-core): translucent modal scrim, color-scheme for native pickers, fence --danger-fg pairings"

cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/ui-core frontend/tests/dangerFgPairing.test.ts
git commit -m "chore(ui-core): re-vendor translucent scrim + color-scheme, add --danger-fg pairing guard"
```

**Expected suite delta: edge node-runner +2** (1 `color-scheme`, 1 `dangerFgPairing`), **edge Vitest +1** (the scrim test), **cloud node-runner +1** (`dangerFgPairing`), **cloud Vitest +1** — the re-vendored `feedback.test.tsx` adds the same scrim test to the cloud. Restated for T11: edge 117→119 node / 1690→1691 Vitest; cloud 110→111 node / 697→698 Vitest. Note `dangerFgPairing.test.ts` is **one** `test()` in each repo even though it carries five table assertions plus the tree scan — the assertions are inside the test, not subtests, which is why the delta is +1 and not +6.

---

### Task 3: Cloud primary navigation — port the edge's `AppHeader` tab pill

Scope A, and the reason this slice exists. Readings 3, 4, 12, 13. **Consume the `glass-tabs`/`glass-tab` CSS that already ships unused in the cloud's byte-mirrored `primitives.css`** — this task writes **no CSS** and adds **no ninth ui-core primitive**. `AppHeader` is a page-level component, mounted per page, exactly as on the edge (reading 4).

**Files:**
- Create: `frontend/src/components/AppHeader.tsx`
- Create: `frontend/src/components/__tests__/AppHeader.test.tsx`
- Create: `frontend/tests/dashboardLocales.test.ts`
- Rewrite: `frontend/src/components/DashboardHeader.tsx` (into a thin `AppHeader` wrapper)
- Modify: `frontend/src/pages/{HistoryDashboard,CrossZoneAnalysisPage,JournalPage}.tsx` (mount `AppHeader`)
- Modify: `frontend/src/pages/Dashboard.tsx` — **not optional.** Step 5 drops `showDesktopData` from `DashboardHeaderProps`, and `Dashboard.tsx:170` passes it (computed at `:40`), so `tsc` in `npm run build` forces this edit. The plan-level file map already lists it; it is named here so a scope audit does not read the edit as a breach.
- Modify: 7× `frontend/public/locales/*/dashboard.json`

**Interfaces:**
- Produces: `export const AppHeader: React.FC<AppHeaderProps>` and `export { LIQUID_BUTTON, LIQUID_MENU_TRIGGER }` from `frontend/src/components/AppHeader.tsx`. `AppHeaderProps` = `{ title: string; activeTab?: 'zones' | 'data' | 'journal'; onLogout: () => void; actions?: React.ReactNode; showSettings?: boolean; }`. **T4 consumes `LIQUID_MENU_TRIGGER`** for the Admin and Account triggers. **T6 adds the crown to this file.** **T5 adds the `/admin/prediction` entry to the Admin menu that this task moves into the `actions` slot.**
- Consumes: nothing from T1/T2.

- [ ] **Step 0: RESOLVED — `historyUxEnabled` is hardcoded `true` server-side, so option 1 stands and there is nothing to ask**

**This was written as a blocking gate on a false premise, and the premise has been corrected. Do not stall here.** The gate assumed `historyUxEnabled` is operator-controlled and defaults to `false`. It is neither:

- `backend/src/main/java/org/osi/server/config/SystemFeatureController.java:24-32` returns `new SystemFeatureFlags(true, true, true, false, false, journalV2CloudIssuerEnabled)`. `historyUxEnabled` is the **first positional field** of the record (`:35-41`) and it is a **hardcoded `true`**. The only `@Value`-driven flag in the six is `journal.v2.cloud-issuer-enabled` (`:19`).
- The `false` this step originally cited is the **frontend fallback**, not the server's answer: `frontend/src/history/useFeatureFlags.ts:13` sets `defaultHistoryFeatureFlags.historyUxEnabled = false`, and `:41` returns those defaults **only when SWR reports `error`**. So `flags.historyUxEnabled` is `false` in exactly one situation: `/api/v1/system/features` failed.

**Recorded resolution: option 1 — the Data tab is always rendered and targets by device only** (`isDesktopBrowser() ? '/analysis' : '/history'`), exact edge parity, which was already this step's recommended default. Options 2 and 3 were premised on an operator being able to switch the surface off; nobody can, short of the endpoint breaking. Build option 1 and move on.

**Still do the `curl`, but for a different reason** — it is evidence about *what the maintainer currently sees*, not about this branch's behaviour, because `agro-link.ch` is deployed from the older `AgroLink` branch:
```bash
curl -s https://agro-link.ch/api/v1/system/features | head -c 400
```
If the endpoint needs auth, say so and move on; it does not gate the build. Report the value alongside the note that the deployed instance is not this branch.

**The real hazard here is a navigation one and it is worth stating in the report:** because the flag is only ever `false` when the features endpoint errors, any navigation still conditioned on it disappears precisely in the failure mode — a fail-closed *link*, which is not the same thing as fail-closed *authority*. That is why T5 Step 3 drops the flag condition from the zone-history link rather than keeping it.

- [ ] **Step 1: Write the failing component test**

Create `frontend/src/components/__tests__/AppHeader.test.tsx`. Mock `isDesktopBrowser` so both branches are exercised — the desktop/mobile split is the one behaviour a reviewer cannot eyeball. **Also mock `react-i18next` with a key→string map, following the existing `src/components/__tests__/DashboardHeader.test.tsx:9-33`** (read it and reuse its shape; it also mocks `LanguageSwitcher`). The map must include `tabs.ariaLabel`, because Step 4's `<nav>` label is a translated string, not a literal — see Step 3.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AppHeader } from '../AppHeader';

vi.mock('../../utils/isDesktopBrowser', () => ({ isDesktopBrowser: vi.fn() }));
import { isDesktopBrowser } from '../../utils/isDesktopBrowser';

function renderAt(path: string, activeTab?: 'zones' | 'data' | 'journal') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppHeader title="T" activeTab={activeTab} onLogout={() => {}} />
    </MemoryRouter>,
  );
}

describe('AppHeader', () => {
  beforeEach(() => vi.mocked(isDesktopBrowser).mockReturnValue(true));

  // The landmark's accessible name comes from t('tabs.ariaLabel') — a
  // translated key, not a literal, because the global constraint forbids a new
  // untranslated string in a component S6 writes. Query the resolved value the
  // i18n mock returns, and assert it is not the raw key, or a missing
  // translation would sail through as a passing test.
  it('renders the three primary tabs inside a named nav landmark', () => {
    renderAt('/dashboard', 'zones');
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(nav).toBeTruthy();
    expect(nav.getAttribute('aria-label')).not.toBe('tabs.ariaLabel');
    expect(nav.querySelectorAll('a').length).toBe(3);
  });

  // aria-current is not decoration: primitives.css:134 styles the active pill
  // with the attribute selector .glass-tab[aria-current='page']. Without it
  // there is no active state rendered at all.
  it('marks exactly one tab aria-current="page" and styles it via the attribute', () => {
    const { container } = renderAt('/journal', 'journal');
    const current = container.querySelectorAll('[aria-current="page"]');
    expect(current.length).toBe(1);
    expect(current[0].textContent).toBeTruthy();
    expect(current[0].className).toContain('glass-tab');
  });

  it('consumes the glass material rather than re-styling it', () => {
    const { container } = renderAt('/dashboard', 'zones');
    expect(container.querySelector('.glass-tabs')).toBeTruthy();
    expect(container.querySelectorAll('.glass-tab').length).toBe(3);
    expect(container.querySelector('header')!.className).toContain('glass-chrome');
  });

  it('points Data at /analysis on desktop and /history on mobile', () => {
    vi.mocked(isDesktopBrowser).mockReturnValue(true);
    const desktop = renderAt('/dashboard', 'zones');
    expect(desktop.container.querySelector('a[href="/analysis"]')).toBeTruthy();
    desktop.unmount();

    vi.mocked(isDesktopBrowser).mockReturnValue(false);
    const mobile = renderAt('/dashboard', 'zones');
    expect(mobile.container.querySelector('a[href="/history"]')).toBeTruthy();
    expect(mobile.container.querySelector('a[href="/analysis"]')).toBeNull();
  });

  // The Data tab must read as active on BOTH of its destinations, or a user on
  // /history sees no active tab and cannot tell where they are.
  it('marks Data active on /history and on /analysis without an activeTab prop', () => {
    for (const path of ['/history', '/analysis', '/history/zones/7']) {
      const { container, unmount } = renderAt(path);
      const current = container.querySelectorAll('[aria-current="page"]');
      expect(current.length, `one active tab at ${path}`).toBe(1);
      unmount();
    }
  });
});
```

- [ ] **Step 2: Run it and confirm it fails for the right reason**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx vitest run src/components/__tests__/AppHeader.test.tsx
```
Expected: FAIL at import — `Failed to resolve import "../AppHeader"`. Not an assertion failure; the module does not exist yet. If it fails any other way, read the error before writing code.

- [ ] **Step 3: Add the seven-locale tab labels and the guard that makes them enforceable**

Reading 13: `dashboard.json` has **no** cross-locale key test — `settingsLocales.test.ts` checks a single sentinel key in it. So the keys and their guard land together, or the global 7-locale constraint is unenforceable exactly where this task writes.

Add a `tabs` object to all 7 `frontend/public/locales/<locale>/dashboard.json`, matching the edge's key shape (`tabs.zones`/`tabs.data`/`tabs.journal`) so the two GUIs stay diffable, **plus a fourth key `tabs.ariaLabel` that the edge does not have.** Read the edge's own values first and reuse them verbatim for the three it does have — they are already human-reviewed:
```bash
for l in en de-CH fr it es pt lg; do echo "== $l"; \
  python3 -c "import json,sys;d=json.load(open('/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui/public/locales/$l/dashboard.json'));print(d.get('tabs'))"; done
```
Use exactly what that prints (measured at planning time, `en` = `{"zones": "Zones", "data": "Data", "journal": "Journal"}`). **Do not invent translations the edge already has.** If a locale's `tabs` is missing on the edge, report it — that is an edge defect this task surfaces, not something to paper over.

**`tabs.ariaLabel` is the one value this task must originate, and it must be translated rather than ledgered.** Step 4's `<nav>` needs an accessible name; the edge hardcodes the English literal `"Primary"` at `AppHeader.tsx:92`, and copying it would put a **new untranslated literal into a component S6 writes**, which the global constraints forbid and which this plan already refuses to do for the edge's two admin labels. So: `tabs.ariaLabel` = `"Primary"` in `en` (the edge's own wording, so the two headers stay diffable — screen readers append the landmark role, so "Primary" reads as "Primary navigation"), with proper `de-CH`/`fr`/`it`/`es`/`pt` translations. It lands inside the `tabs` object, so T3's new `dashboardLocales.test.ts` deep-equality guard covers it automatically — **no exception is ledgered for it.**

For any value you must originate, `lg` is Luganda and gates Uganda: mark it a machine draft pending the human-native gate, and use a **straight** apostrophe (every other `lg` string does; S3 shipped exactly one curly-apostrophe violation).

Then delete the now-dead `data` and `journal` top-level keys — but only after proving they are dead:
```bash
grep -rn "t('data')\|t(\"data\")\|t('journal')\|t(\"journal\")" src/ | grep -v __tests__
```
Expected after Step 5: no hits. **If there are hits, leave the keys and ledger them** rather than breaking a call site.

Create `frontend/tests/dashboardLocales.test.ts` with full deep leaf-key equality across all 7 locales. Model it on the existing `src/journal/__tests__/journalLocales.test.ts:19-32`, which already does exactly this for `journal.json` — read it and reuse its traversal rather than writing a third one:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const LOCALES = ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg'] as const;
const dir = path.resolve(import.meta.dirname, '../public/locales');

function leaves(value: unknown, prefix = ''): string[] {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
  }
  return [prefix];
}

const load = (l: string) => JSON.parse(fs.readFileSync(path.join(dir, l, 'dashboard.json'), 'utf8'));

test('dashboard.json has an identical leaf-key set in all 7 locales', () => {
  const base = leaves(load('en')).sort();
  for (const locale of LOCALES.filter((l) => l !== 'en')) {
    assert.deepEqual(leaves(load(locale)).sort(), base, `dashboard.json key drift in ${locale}`);
  }
});

test('every dashboard.json value is a non-empty string', () => {
  for (const locale of LOCALES) {
    const flat = JSON.stringify(load(locale));
    assert.ok(!/:\s*""/.test(flat), `empty dashboard.json value in ${locale}`);
  }
});

test('the three tab labels and the nav landmark label exist in all 7 locales', () => {
  for (const locale of LOCALES) {
    const d = load(locale);
    for (const key of ['zones', 'data', 'journal', 'ariaLabel']) {
      assert.equal(typeof d.tabs?.[key], 'string', `tabs.${key} missing in ${locale}`);
      assert.ok(d.tabs[key].length > 0, `tabs.${key} empty in ${locale}`);
    }
  }
});
```

Run it **before** editing the locale files to prove it fails (`tabs.zones missing in en`), then after, to prove it passes. Then mutation-test it: delete `tabs.data` from `fr/dashboard.json`, watch it go red naming `fr`, restore.

- [ ] **Step 4: Create `frontend/src/components/AppHeader.tsx`**

Mirrors edge `components/AppHeader.tsx` with four deliberate, stated deviations. **No crown yet — T6 adds it**, so this task's diff is reviewable as "navigation" alone.

```tsx
import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { HeaderMenu } from './HeaderMenu';
import { LanguageSwitcher } from './LanguageSwitcher';
import { isDesktopBrowser } from '../utils/isDesktopBrowser';

type TabKey = 'zones' | 'data' | 'journal';

interface AppHeaderProps {
  /** Page title. Rendered sr-only; the tab pill carries the visible wayfinding. */
  title: string;
  /** Which primary tab is active on this page, if any. Pathname is the fallback. */
  activeTab?: TabKey;
  onLogout: () => void;
  /**
   * Page-specific primary actions, rendered left of the always-present
   * Language, Settings and Account controls. Dashboard passes its Add and
   * Admin menus here. Each child should carry `btn-liquid` for material
   * consistency.
   */
  actions?: React.ReactNode;
  showSettings?: boolean;
}

/* Phones carry up to three of these next to the tab pill, so they run compact
   below `sm` and reach full size once there is room. py-2.5 + text-base still
   measures 44px, the touch minimum. Copied from the edge so the two headers
   size identically. */
const LIQUID_SIZING = 'px-3 py-2.5 text-base sm:px-6 sm:py-3 sm:text-lg';
const LIQUID_BUTTON = `btn-liquid rounded-lg text-center font-bold text-[var(--text)] ${LIQUID_SIZING}`;
const LIQUID_MENU_TRIGGER = `btn-liquid text-[var(--text)] font-bold ${LIQUID_SIZING}`;

/**
 * Shared top-level chrome for the AgroLink cloud app: the sticky liquid-glass
 * header and the floating-glass primary tab bar (Zones · Data · Journal).
 * Ported from the edge's AppHeader (S6 T3); the `glass-chrome`/`glass-tabs`/
 * `glass-tab` classes are the byte-mirrored ui-core `primitives.css` material,
 * consumed here for the first time on this side.
 *
 * The Data tab routes to the desktop analysis workspace or the mobile history
 * view depending on the device — the two are one destination, matching edge
 * AppHeader.tsx:61.
 *
 * Deviations from the edge, all deliberate (D7):
 *  - The crown is added by S6 T6, not here.
 *  - A LanguageSwitcher sits in this header. The edge has none and reaches the
 *    switcher through Settings, which is exactly the defect S6 T7 fixes on that
 *    side; the cloud already had it here and removing it would regress.
 *  - The Account menu carries the cloud's five account surfaces, not the edge's
 *    two — the cloud simply has more of them.
 *  - Admin stays a separate menu (supplied via `actions`) rather than folding
 *    into Account as on the edge: after T5 it holds four items, and a nine-item
 *    Account menu is worse than two labelled triggers. Per maintainer decision
 *    2 it carries no colour identity of its own; the label distinguishes it.
 */
export const AppHeader: React.FC<AppHeaderProps> = ({
  title,
  activeTab,
  onLogout,
  actions,
  showSettings = true,
}) => {
  const { t } = useTranslation('dashboard');
  const { pathname } = useLocation();

  const dataTarget = isDesktopBrowser() ? '/analysis' : '/history';
  const dataActive =
    activeTab === 'data' ||
    pathname.startsWith('/history') ||
    pathname.startsWith('/analysis');

  const tabs: Array<{ key: TabKey; label: string; to: string; active: boolean }> = [
    { key: 'zones', label: t('tabs.zones'), to: '/dashboard', active: activeTab === 'zones' || pathname === '/dashboard' },
    { key: 'data', label: t('tabs.data'), to: dataTarget, active: dataActive },
    { key: 'journal', label: t('tabs.journal'), to: '/journal', active: activeTab === 'journal' || pathname.startsWith('/journal') },
  ];

  return (
    <header className="glass-chrome sticky top-0 z-30 border-b border-[var(--border)]">
      <div className="max-w-7xl mx-auto px-4 py-3">
        <h1 className="sr-only">{title}</h1>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          {/* Primary navigation on its own floating glass pill. The active
              lozenge is drawn by primitives.css:134's
              .glass-tab[aria-current='page'] selector — aria-current is the
              styling hook here, not just an a11y attribute.
              The landmark label goes through i18n: the edge hardcodes the
              English "Primary" (AppHeader.tsx:92) and copying that would add a
              new untranslated literal, which S6's constraints forbid. */}
          <nav aria-label={t('tabs.ariaLabel')}>
            <div className="glass-tabs inline-flex gap-1 p-1">
              {tabs.map((tab) => (
                <Link
                  key={tab.key}
                  to={tab.to}
                  aria-current={tab.active ? 'page' : undefined}
                  className={`glass-tab px-5 py-2 text-[15px] font-semibold ${
                    tab.active
                      ? 'text-[var(--header-text)]'
                      : 'text-[var(--text-tertiary)] hover:text-[var(--header-text)]'
                  }`}
                >
                  {tab.label}
                </Link>
              ))}
            </div>
          </nav>

          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
            {actions}

            <LanguageSwitcher triggerClassName={LIQUID_MENU_TRIGGER} />

            {/* Icon-only on phones: the translated label is the widest thing in
                this row ("Einstellungen") and spelling it out pushes Account
                onto a third line in every non-English locale. The accessible
                name stays the full label at every width. */}
            {showSettings && (
              <Link
                to="/settings"
                aria-label={t('accountMenu.settings')}
                className={`${LIQUID_BUTTON} inline-flex items-center justify-center`}
              >
                <span aria-hidden="true" className="sm:hidden">⚙</span>
                <span className="hidden sm:inline">{t('accountMenu.settings')}</span>
              </Link>
            )}

            <HeaderMenu
              label={t('account')}
              triggerClassName={LIQUID_MENU_TRIGGER}
              items={[
                { key: 'manage', label: t('accountMenu.manage'), to: '/account' },
                { key: 'support-requests', label: t('accountMenu.supportRequests'), to: '/support-requests' },
                { key: 'gateway-access', label: t('accountMenu.gatewayAccess'), to: '/gateway-access' },
                { key: 'logout', label: t('logout'), onSelect: onLogout },
              ]}
            />
          </div>
        </div>
      </div>
    </header>
  );
};

export { LIQUID_BUTTON, LIQUID_MENU_TRIGGER };
```

Two things to verify against the real files rather than trusting this block:
- **`LanguageSwitcher`'s prop name.** The current call is `DashboardHeader.tsx:71` `<LanguageSwitcher triggerClassName="px-6 py-3 text-lg w-full sm:w-auto justify-center" />`. Read the component and confirm `triggerClassName` is the whole styling surface; if it composes rather than replaces, adjust so the trigger ends up on `btn-liquid` and not double-styled.
- **The Settings label key.** The edge uses `t('settings:entryPoint')`. Check whether cloud `settings.json` has `entryPoint`; if it does, use `settings:entryPoint` for key-parity with the edge and add `settings` to `useTranslation`. If it does not, `dashboard:accountMenu.settings` (used above) already exists in all 7 locales — say in the report which you used and why.
- **`settings` was removed from the Account menu** because the header now has a dedicated Settings control. Confirm no test asserted `accountMenu.settings` as a *menu item* — `settingsLocales.test.ts` checks the locale key exists, which is still true since the Settings link uses it.

- [ ] **Step 5: Rewrite `DashboardHeader.tsx` as a thin wrapper, and mount `AppHeader` on the other three pages**

`DashboardHeader` keeps its existing props so `Dashboard.tsx` needs no change beyond what it already passes, and delegates all shared structure. This is edge `DashboardHeader.tsx:33-53`'s shape:

```tsx
import React from 'react';
import { useTranslation } from 'react-i18next';
import { HeaderMenu } from './HeaderMenu';
import { AppHeader, LIQUID_MENU_TRIGGER } from './AppHeader';

interface DashboardHeaderProps {
  username: string | null;
  isSuperAdmin: boolean;
  canMutate: boolean;
  canAddDevice: boolean;
  onAddZone: () => void;
  onAddDevice: () => void;
  onLogout: () => void;
}

/**
 * Zones page chrome. Delegates the glass header and the primary tabs to
 * AppHeader and supplies the Dashboard's own Add and Admin menus as page
 * actions. `showDesktopData` is gone: the Data destination is now a primary
 * tab owned by AppHeader, so the page no longer decides whether it exists.
 */
export const DashboardHeader: React.FC<DashboardHeaderProps> = ({
  username, isSuperAdmin, canMutate, canAddDevice, onAddZone, onAddDevice, onLogout,
}) => {
  const { t } = useTranslation('dashboard');
  const addMenuItems = [
    ...(canMutate ? [{ key: 'zone', label: t('addMenu.zone'), onSelect: onAddZone }] : []),
    ...(canAddDevice ? [{ key: 'device', label: t('addMenu.device'), onSelect: onAddDevice }] : []),
  ];
  return (
    <AppHeader
      title={t('title')}
      activeTab="zones"
      onLogout={onLogout}
      actions={
        <>
          {isSuperAdmin && (
            <HeaderMenu
              label={t('admin')}
              triggerClassName={LIQUID_MENU_TRIGGER}
              items={[
                { key: 'users', label: t('adminMenu.users'), to: '/admin/users' },
                { key: 'devices', label: t('adminMenu.devices'), to: '/admin/devices' },
                { key: 'work-requests', label: t('adminMenu.workRequests'), to: '/admin/work-requests' },
              ]}
            />
          )}
          {addMenuItems.length > 0 && (
            <HeaderMenu label={t('add')} triggerClassName={LIQUID_MENU_TRIGGER} items={addMenuItems} />
          )}
        </>
      }
    />
  );
};
```

**`username` is now unused** — it was only feeding the `t('welcome', { username })` line the sr-only `<h1>` replaces. Keep it in the props (Dashboard passes it, and removing it is churn in a task about navigation) and mark it with the same comment shape the edge uses at `AppHeader.tsx:15-17` (*"accepted for call-site compatibility; the header no longer shows a greeting"*), **or** remove it and update `Dashboard.tsx` — either is fine, but a silently-unused prop with no comment is not. Note `showDesktopData` **is** removed, so `Dashboard.tsx:40`'s `showDesktopData` computation becomes dead — delete it and the now-unused `useFeatureFlags`/`isDesktopBrowser` imports **only if nothing else in that file uses them** (`IrrigationZoneCard` receives flags too — check before deleting).

Then mount `AppHeader` on the other three pages, replacing each page's hand-rolled `<header>`:

| Page | `activeTab` | `title` |
|---|---|---|
| `pages/HistoryDashboard.tsx` | `"data"` | its existing history heading |
| `pages/CrossZoneAnalysisPage.tsx` | `"data"` | its existing analysis heading |
| `pages/JournalPage.tsx` | `"journal"` | its existing journal heading |

For each: **keep the page's existing visible heading and eyebrow** (`HistoryDashboard.tsx:148` and `JournalPage.tsx:504` render the `AgroLink` eyebrow — reading 11; those are the in-app brand word and must survive), keep its "back to dashboard" link **for now** (T5 decides its fate), and remove only the bespoke header chrome the tab bar replaces. Each page passes its own `onLogout`; read how each currently obtains it rather than assuming a shared hook.

- [ ] **Step 6: Run the tests, then the full suites**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx vitest run src/components/__tests__/AppHeader.test.tsx
npx tsx --test tests/dashboardLocales.test.ts
npm run test:unit && npm run build
```
Expected: the two new files PASS. **Existing page tests will fail where they asserted the old header** — every such failure must be triaged individually and reported as either (i) a correct failure of an assertion about deleted chrome, updated in this task, or (ii) a real regression. Do not blanket-update. `npm run build` runs `tsc` first, so a missed prop threading surfaces as a type error, not a runtime surprise.

- [ ] **Step 7: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/components/AppHeader.tsx frontend/src/components/DashboardHeader.tsx \
        frontend/src/components/__tests__/AppHeader.test.tsx frontend/tests/dashboardLocales.test.ts \
        frontend/src/pages frontend/public/locales
git commit -m "feat(gui): primary navigation — port the edge's glass tab pill onto the four parity pages"
```

**Expected suite delta: cloud node-runner +3** (`dashboardLocales.test.ts`), **cloud Vitest +5** (`AppHeader.test.tsx`), **plus whatever existing page tests are updated — net 0 from those, and any net change must be named in the report.** Running total after T3: cloud 114 node / 703 Vitest.

---

### Task 4: Cloud chrome onto tokens — delete the colour identities

Scope C, maintainer decision 2. Readings 9 and 12. **T3 already removed two of the four `DashboardHeader` colours** by replacing the Data and Journal links with tabs; this task closes the remaining two triggers and the five page-header gradients. **There is to be no separate admin colour identity** — nothing replaces purple. The pages are distinguished by their headings.

**Files:**
- Modify: `frontend/src/components/DashboardHeader.tsx` (Admin + Account triggers — note T3 already routed both through `LIQUID_MENU_TRIGGER`; verify and finish)
- Modify: `frontend/src/pages/admin/{AdminUsers,AdminDevices,AdminWorkRequests,AdminPrediction}.tsx`
- Modify: `frontend/src/pages/GatewayAccessAdminPage.tsx`
- Create: `frontend/tests/chromeTokens.test.ts`

**Interfaces:**
- Consumes: `LIQUID_MENU_TRIGGER` from T3's `AppHeader.tsx`.
- Produces: nothing consumed by later tasks. **Adds zero mutating handlers** — this is a class-string task. A reviewer must verify that from the diff, not from this sentence.

- [ ] **Step 1: Re-measure the surface — the plan's inventory expires**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
grep -rn 'purple-\|emerald-\|teal-\|slate-9\|slate-8\|slate-7\|bg-gradient-to-r' \
  src/components/DashboardHeader.tsx src/pages/admin/ src/pages/GatewayAccessAdminPage.tsx
```
Expected, after T3: the emerald Data link and teal Journal link are **gone**; what remains is the Admin trigger, the Account trigger (both may already be `LIQUID_MENU_TRIGGER` if T3 moved them wholesale — check), and the five page-header gradients. **Report the real list.** If T3 already tokenised the two triggers, say so and let this task be the five gradients plus the guard.

- [ ] **Step 2: Write the failing guard**

Create `frontend/tests/chromeTokens.test.ts`. Scope it to chrome files by an explicit list, not a directory, so it cannot silently stop covering anything:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Maintainer decision 2 (S6): the cloud follows the edge's corporate design.
// There is NO separate admin colour identity — distinction comes from labels.
// These are the app's chrome surfaces: headers and page-header bars. A raw
// Tailwind palette colour or a gradient in any of them is a regression.
const CHROME_FILES = [
  'components/AppHeader.tsx',
  'components/DashboardHeader.tsx',
  'pages/admin/AdminUsers.tsx',
  'pages/admin/AdminDevices.tsx',
  'pages/admin/AdminWorkRequests.tsx',
  'pages/admin/AdminPrediction.tsx',
  'pages/GatewayAccessAdminPage.tsx',
];

const srcRoot = path.resolve(import.meta.dirname, '../src');
const PALETTE =
  /\b(?:bg|text|border|from|via|to|ring|divide)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;

test('no chrome file uses a raw Tailwind palette colour', () => {
  const offenders: string[] = [];
  for (const rel of CHROME_FILES) {
    const source = fs.readFileSync(path.join(srcRoot, rel), 'utf8');
    for (const hit of source.match(PALETTE) ?? []) offenders.push(`${rel}: ${hit}`);
  }
  assert.deepEqual(offenders, []);
});

test('no chrome file paints a gradient', () => {
  const offenders: string[] = [];
  for (const rel of CHROME_FILES) {
    const source = fs.readFileSync(path.join(srcRoot, rel), 'utf8');
    if (/bg-gradient-to-/.test(source)) offenders.push(rel);
  }
  assert.deepEqual(offenders, []);
});

// Every file in the list must exist, or a rename silently empties the guard.
test('every chrome file in the list exists', () => {
  for (const rel of CHROME_FILES) {
    assert.ok(fs.existsSync(path.join(srcRoot, rel)), `${rel} is missing — update CHROME_FILES`);
  }
});
```

Run it and confirm it fails:
```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx tsx --test tests/chromeTokens.test.ts
```
Expected: the palette test FAILS listing the purple/slate/emerald hits from Step 1; the gradient test FAILS listing the 5 page files; the existence test PASSES. **If the palette test reports zero, the regex is broken — do not proceed.**

- [ ] **Step 3: Convert the two menu triggers to the glass material**

Both become `LIQUID_MENU_TRIGGER` (T3's export): `btn-liquid text-[var(--text)] font-bold px-3 py-2.5 text-base sm:px-6 sm:py-3 sm:text-lg`. This is the substitution reading 9 describes: **`variant="liquid"`/`btn-liquid` has zero plain-glass consumers in the cloud today**, so these are its first, and the CSS they need already ships in the byte-mirrored `primitives.css`. Remove `text-white` with the background — a white foreground on the glass material is not legible in the light theme, and `text-[var(--text)]` is what `LIQUID_MENU_TRIGGER` already carries.

- [ ] **Step 4: Convert the five page headers**

Replace each gradient header with the flat token chrome, and **change the foreground in the same edit** — this is the step where a half-done conversion produces white-on-white:

```tsx
<header className="bg-[var(--header-bg)] border-b border-[var(--border)] shadow-xl px-4 py-6">
```

Then, inside each of those five headers, replace `text-white` → `text-[var(--header-text)]` for the heading and `text-white/80`-style subtitles → `text-[var(--header-subtext)]`. **Measured, both themes:** `--header-text` on `--header-bg` **20.50 light / 15.85 dark**; `--header-subtext` on `--header-bg` **7.58 light / 10.41 dark**. Both clear AA comfortably in both themes.

**Enumerate every `text-white` (and `text-white/NN`, and `text-slate-*` used as a foreground) inside the five headers before editing, and list them in the report.** A gradient removed without its foreground converted is the single most likely defect in this task: the old text was white *because* the background was dark, and the new background is `#FFFFFF` in light. Note `text-white/80` cannot become `text-[var(--header-subtext)]/80` — Tailwind v3.4 compiles that to zero CSS (see the global constraint); use the plain token, whose ratio is already measured above.

`GatewayAccessAdminPage.tsx:399` additionally carries `border-b border-emerald-900/20`, which the replacement's `border-[var(--border)]` supersedes — do not keep both.

- [ ] **Step 5: Re-run the guard, then the suites, then mutation-test**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx tsx --test tests/chromeTokens.test.ts   # expect PASS
npm run test:unit && npm run build
npx tsx --test tests/noInertTokenAlpha.test.ts tests/errorTokenMisuse.test.ts tests/pageShellTokens.test.ts
```
All three pre-existing guards must stay green — reading 15 confirms they scan the whole `src` tree, so they do cover these files.

Mutation-test: put `bg-purple-600` back into `AdminUsers.tsx`, confirm `chromeTokens` goes red naming the file and the hit, revert, confirm green. Paste both.

- [ ] **Step 6: Visual check, both themes, and say what you looked at**

`tsc` cannot see a legibility regression. Load `/admin/users`, `/admin/devices`, `/admin/work-requests`, `/admin/prediction` and `/gateway-access` in **both** themes and confirm the heading and subtitle are legible on each. Report which pages you loaded and in which themes. If you cannot run the app, say so plainly rather than implying you checked.

- [ ] **Step 7: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/components/DashboardHeader.tsx frontend/src/pages/admin \
        frontend/src/pages/GatewayAccessAdminPage.tsx frontend/tests/chromeTokens.test.ts
git commit -m "fix(gui): chrome onto tokens — remove the admin/data/journal colour identities"
```

**Expected suite delta: cloud node-runner +3** (`chromeTokens.test.ts`), **cloud Vitest +0**. Any existing test asserting a purple/emerald class must be updated and named. Running total after T4: cloud 117 node / 703 Vitest.

---

### Task 5: De-orphan the routes

Scope B. Reading 18. Three routes with no in-app link (one of them only *partly* so — the brief overstates `/admin/prediction`, see the reference table) and two reachability holes where the gate sits on the link instead of the route.

**Files:**
- Create: `frontend/src/pages/AnalysisRoute.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/DashboardHeader.tsx` (Admin menu gains prediction)
- Modify: `frontend/src/components/farming/IrrigationZoneCard.tsx` (desktop zone-history path)
- Modify: the device card(s) that will link `/devices/:deviceEui` — determine which from `src/components/farming/deviceRegistry.tsx`
- Modify: 7× `public/locales/*/dashboard.json` and/or `devices.json`
- Create: `frontend/tests/routeReachability.test.ts`

**Interfaces:**
- Consumes: T3's `AppHeader` (already provides the Data tab, which is the *primary* `/history` entry point; this task adds the remaining paths).
- Produces: `export const AnalysisRoute: React.FC` — a route wrapper mirroring edge `pages/AnalysisRoute.tsx`. **Adds zero mutating handlers.**

- [ ] **Step 1: Write the failing reachability guard**

This guard is the one that stops the defect recurring, so it must be structural rather than a list of strings. Create `frontend/tests/routeReachability.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// S6 exists because routes shipped with no in-app link for four slices. This
// guard asserts that every authenticated route registered in App.tsx is named
// somewhere else in src/ as a navigation target. It is deliberately crude: it
// proves a path STRING appears outside the router, not that the link is
// reachable in the rendered UI. That is still enough to catch a route added
// with no entry point at all, which is the defect that actually happened.
//
// The needle MUST be delimiter-anchored. A bare `corpus.includes('/history')`
// is satisfied by 54 import specifiers in this tree (`from
// '../../history/types'`, `from '../../history/useFeatureFlags'`, …), and
// `/journal` (131) and `/analysis` (46) collide with their directory names the
// same way, so an unanchored guard is GREEN at baseline for every route S6
// exists to fix — it can never fail. Requiring a string/template-literal
// delimiter on each side removes the collision: measured at planning time,
// anchored `/history` has ZERO matches outside App.tsx and the __tests__ this
// walker skips, while `/journal` and `/analysis` each have one real link.
const srcRoot = path.resolve(import.meta.dirname, '../src');

// Routes exempt from needing an in-app link, each with its reason.
const EXEMPT = new Map<string, string>([
  ['/login', 'pre-auth entry point'],
  ['/register', 'pre-auth entry point'],
  ['/dashboard', 'the catch-all redirect target and every page back-link'],
  ['*', 'catch-all'],
]);

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === '__tests__' ? [] : files(full);
    return /\.tsx?$/.test(e.name) ? [full] : [];
  });
}

const appTsx = path.join(srcRoot, 'App.tsx');
const routes = [...fs.readFileSync(appTsx, 'utf8').matchAll(/path="([^"]+)"/g)].map((m) => m[1]);

test('App.tsx still registers the routes this guard was written against', () => {
  assert.ok(routes.length >= 14, `expected >= 14 routes, found ${routes.length}`);
});

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A literal route is linked as a whole string: `to="/history"`,
 * `` navigate(`/history?tab=x`) ``. So require a quote/backtick before it and a
 * quote/backtick or `?` after it — that rejects `'../../history/types'`, whose
 * `/history` is followed by `/`.
 *
 * A parameterised route is linked via a template literal that STARTS with the
 * static prefix: `` `/history/zones/${zone.id}` ``. So require the delimiter
 * before the prefix only — an import specifier can never match, because the
 * character immediately before its `/devices/` is never a quote.
 */
function needleFor(route: string): RegExp {
  if (route.includes('/:')) {
    return new RegExp(`["'\`]${escape(route.slice(0, route.indexOf('/:')))}/`);
  }
  return new RegExp(`["'\`]${escape(route)}["'\`?]`);
}

test('every authenticated route is named as a navigation target outside App.tsx', () => {
  const others = files(srcRoot).filter((f) => f !== appTsx);
  const corpus = others.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
  const orphans: string[] = [];
  for (const route of routes) {
    if (EXEMPT.has(route)) continue;
    const needle = needleFor(route);
    if (!needle.test(corpus)) orphans.push(`${route} (searched for ${needle})`);
  }
  assert.deepEqual(orphans, []);
});
```

Run it:
```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx tsx --test tests/routeReachability.test.ts
```
Expected, and **T3 has already landed** — it precedes T5 in plan order, so there is no "if T3 has not yet landed" branch to reason about:

- the first test PASSES (17 routes today, `>= 14` asserted);
- the second **FAILS naming exactly `/devices/:deviceEui`**, and nothing else. That is the whole point: T3's `AppHeader` introduced quoted literals `'/dashboard'`, `'/analysis'`, `'/history'` and `'/journal'`, so the tab routes are green on arrival; `/history/zones/:zoneId` is green via `` IrrigationZoneCard.tsx `to={`/history/zones/${zone.id}`}` ``; `/admin/prediction` is green because `PredictionCard.tsx:542-549` links `` `/admin/prediction?zoneId=…` `` (this is why `?` is in the closing character class); and `/account`, `/settings`, `/support-requests`, `/gateway-access`, `/admin/users`, `/admin/devices`, `/admin/work-requests` are green via the Account and Admin menus. `/devices/:deviceEui` is the one route with no quoted `'/devices/'` anywhere outside `App.tsx` — Step 4 fixes it.
- **If the second test passes on the first run, the anchoring is broken — stop and fix it.** An unanchored `corpus.includes()` version of this guard is green at baseline for every route in the file (54 `/history` import specifiers alone), which makes it worthless.

**State in the report exactly which routes the guard proves and which it merely fails to disprove.** The anchoring removes the directory-name collisions, but the guard still proves only that a path *string* appears in a source file — not that the link renders, not that the user can see it. It is crude by design and must not be oversold.

- [ ] **Step 2: `/analysis` — move the gate from the link to the route**

Create `frontend/src/pages/AnalysisRoute.tsx`, mirroring edge `pages/AnalysisRoute.tsx:10-12`:

This is the edge's actual file, read at planning time — the `lazy()` and the `Suspense` live **inside** `AnalysisRoute.tsx`, which is exactly what preserves the code-split. A snippet with a static `import { CrossZoneAnalysisPage } from './CrossZoneAnalysisPage'` would embody the very defect the paragraph below warns about, so it is not offered here:

```tsx
import { lazy, Suspense } from 'react';
import { Navigate } from 'react-router-dom';
import { isDesktopBrowser } from '../utils/isDesktopBrowser';

const CrossZoneAnalysisPage = lazy(() =>
  import('./CrossZoneAnalysisPage').then((module) => ({ default: module.CrossZoneAnalysisPage })),
);

export function AnalysisRoute() {
  if (!isDesktopBrowser()) {
    return <Navigate to="/history" replace />;
  }

  return (
    <Suspense fallback={<div className="p-6 text-sm text-[var(--text-secondary)]">Loading analysis...</div>}>
      <CrossZoneAnalysisPage />
    </Suspense>
  );
}
```

Add the doc comment the cloud needs and the edge does not: *desktop-only gate for the cross-zone analysis workspace; before S6 the cloud gated only the **link** (`Dashboard.tsx` computed `showDesktopData` and `DashboardHeader` decided whether to render it), so a phone that typed the URL got the full desktop workspace. `isDesktopBrowser()` fails OPEN to desktop when detection is impossible, which is the safer failure for this pair: an undetectable client keeps the richer surface rather than being bounced.*

**Re-read the edge file before copying** — the block above expires like every other citation here. `App.tsx:12-15` currently lazy-loads `CrossZoneAnalysisPage` to keep ECharts out of the main bundle (`// Lazy-loaded so ECharts is code-split into an /analysis-only chunk`); moving the `lazy()` into `AnalysisRoute.tsx` as the edge does keeps that, and the now-dead `lazy()` call **and its `lazy` import** must come out of `App.tsx` with it. Note `App.tsx:31,149` already wraps the whole `<Routes>` in `<Suspense fallback={null}>`, so that `Suspense` import stays and the inner one in `AnalysisRoute` is an upgrade to the fallback, not a requirement — keep it anyway, for edge parity and because `null` is a blank screen. **A static import in `AnalysisRoute.tsx` would silently undo the code-split.** Verify with the build output: compare `npm run build`'s chunk list before and after and confirm the ECharts chunk is still separate. **State the before/after chunk names and sizes in the report.** This is the highest-risk line in T5 and it is invisible to every test in the repo.

Then point `App.tsx`'s `/analysis` route at `AnalysisRoute` instead of `CrossZoneAnalysisPage`.

- [ ] **Step 3: `/history/zones/:zoneId` — give desktop a path**

`IrrigationZoneCard.tsx:261-267` renders the zone-history link only when `!isDesktopBrowser() && flags.historyUxEnabled`. Desktop therefore has no path at all (reading 18). **Remove both conditions** so the link renders unconditionally. Re-derive the line numbers first.

**Why the flag condition goes too, which is a change from this plan's first draft.** T3 Step 0 establishes that `historyUxEnabled` is a hardcoded `true` on the server (`SystemFeatureController.java:24-32`) and that `flags.historyUxEnabled` can only be `false` when `/api/v1/system/features` **errors** (`useFeatureFlags.ts:13,41`). Keeping the condition therefore does not gate an operator preference — it deletes a navigation link precisely in the failure mode where a user most needs the rest of the app to keep working. That is a fail-closed *link*, not a fail-closed *authority*, and D5 is about authority. Dropping it is also consistent with T3's option 1, which puts no flag on the Data tab. If `flags` becomes unused in the file after this, remove the `useFeatureFlags` import; `IrrigationZoneCard` reads other flags too, so check rather than assume.

**Do not** additionally build a desktop zone-history *card* surface — that is S4b's drill-down, explicitly out of scope. This step makes an existing route reachable; it does not add depth.

- [ ] **Step 4: `/devices/:deviceEui` — link it from the device cards**

Maintainer decision 1: **link it, don't delete it.** Find which component renders the device cards on the Dashboard (`src/components/farming/deviceRegistry.tsx` maps device types to cards; `GatewayCard.tsx` and the per-type cards are candidates — establish it by reading, and note that `GatewayCard.tsx` and `deviceRegistry.tsx` contain **zero** `Link`/`navigate` calls today, which is why the route is unreachable).

Add one link per device card to `/devices/${device.deviceEui}`. Requirements:
- **One entry point per card, not per row.** A "Details" link in the card's header or footer, not a link on every reading.
- It must be a real `<Link>`, so middle-click and copy-link work.
- Its label must be translated in all 7 locales (`devices.json`), and **`devices.json` has no full key-equality test** — the existing `addDeviceModalLocales`/`deviceDenialLocales` tests check hand-picked key lists. Add the new key to whichever of those lists is the better home, or state why a new guard is warranted.
- **It is a read affordance and must not be permission-gated.** `DeviceDetail` is a read page; reading 18's sibling finding is that gating *links* rather than *routes* is what produced these holes. Do not add a `canWrite` condition here.

- [ ] **Step 5: `/admin/prediction` — add it to the Admin menu**

`DashboardHeader.tsx`'s Admin menu (moved into `AppHeader`'s `actions` slot by T3) has three items. Add a fourth:

```tsx
{ key: 'prediction', label: t('adminMenu.prediction'), to: '/admin/prediction' },
```
with `adminMenu.prediction` added to all 7 `dashboard.json` files — covered by T3's new `dashboardLocales.test.ts`, which will fail until all 7 carry it. That is the guard working as intended.

**Note the asymmetry, because it affects where the item belongs:** `/admin/users` and `/admin/devices` are wrapped in `<AdminRoute superAdminOnly>`; `/admin/prediction` and `/admin/work-requests` are wrapped in plain `<AdminRoute>`. The Admin menu itself renders only when `isSuperAdmin`, so a plain-admin user can reach `/admin/prediction` by URL and by `PredictionCard`'s link but will not see the menu. **Do not fix that in this task** — changing who sees the Admin menu is an authorization-surface change, not a navigation fix. Record it in T10's ledger.

- [ ] **Step 6: Decide the fate of the "back to dashboard" links, and say which you chose**

Every page has one; the tab pill now provides the same affordance for the four parity pages. **Recommended: keep them.** They are the only in-app exit from the ten non-parity pages (which get no tab bar), removing them is churn in a task about *adding* reachability, and a redundant back link costs a row of chrome. If you remove them from the four parity pages for cohesion, that is a defensible D7 call — but do it deliberately, say so, and check each page's tests.

- [ ] **Step 7: Re-run the guard and the suites**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx tsx --test tests/routeReachability.test.ts tests/dashboardLocales.test.ts
npm run test:unit && npm run build
```
Expected: reachability PASSES with zero orphans; `dashboardLocales` PASSES with `adminMenu.prediction` in all 7. Mutation-test the reachability guard: add a throwaway `<Route path="/zzz" …>` to `App.tsx`, confirm it goes red naming `/zzz`, revert.

- [ ] **Step 8: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/App.tsx frontend/src/pages/AnalysisRoute.tsx frontend/src/components \
        frontend/public/locales frontend/tests/routeReachability.test.ts
git commit -m "fix(gui): de-orphan /history, /devices/:eui and /admin/prediction; gate /analysis at the route"
```

**Expected suite delta: cloud node-runner +2** (`routeReachability.test.ts`), **cloud Vitest +0 to +3** depending on whether you add a component test for the new device link — **name the exact number in the report; a range is not acceptable at T11.** Running total after T5: cloud 119 node / 703–706 Vitest.

---

### Task 6: The in-app brand mark

Scope D. Reading 11. **What the logged-in cloud app lacks is the brand *mark*, not the brand *word*** — the word already ships in the Dashboard `<h1>`, the History and Journal eyebrows, `Account.tsx:181`, a locale hint and a localStorage key, and `tests/agrolinkBranding.test.ts` already asserts several of them. This task adds an image mark and nothing else.

**Files:**
- Create: `frontend/src/branding/agrolink.ts`
- Create: `frontend/src/assets/agroscope/balken-horizontal-{en,de,fr,it}.png` (copied)
- Modify: `frontend/src/assets/agroscope/README.md`
- Modify: `frontend/src/index.css`
- Modify: `frontend/src/components/AppHeader.tsx` (T3's file)
- Modify: `frontend/tests/agrolinkBranding.test.ts`

**Interfaces:**
- Consumes: T3's `AppHeader.tsx`.
- Produces: `resolveAgroscopeAssetLocale(language?: string | null): AgroscopeAssetLocale` and `resolveAgroscopeAssets(language?: string | null): AgroscopeBrandAssets` where `AgroscopeAssetLocale = 'en' | 'de' | 'fr' | 'it'` and `AgroscopeBrandAssets = { locale: AgroscopeAssetLocale; balkenHorizontal: string }`. **Note the return type deliberately omits `logoHoch`** — see Step 2.

- [ ] **Step 0: The two-marks question is RESOLVED — "copy the edge". The alignment constant still has to be derived**

**(i) Two Agroscope marks in one session — answered by the product owner: copy the edge.** That is option 1 below and it was this step's recommended default, so **there is nothing to ask and nothing to wait for.** The port goes ahead: the Balken in the logged-in app, the Swiss-cross badge left alone on login. The context that made it a question is kept because the report should name the tradeoff that was accepted, not because it is still open — spec **D6** excludes the cloud login from visual parity and keeps its compact badge (`src/assets/agroscope/swiss-cross.jpg`, `Login.tsx:38-40`) because "the compact badge reads better than the edge login's letterhead treatment", so a user now sees a badge on login and a Balken bar immediately after. Both are official Agroscope assets, and decision 2 says the cloud follows the edge's corporate design.

The options as they were put, for the record:
1. **Port the Balken crown** — **chosen.** Route the login/app mark *relationship* to the designer review (that review still happens; it is not a gate on this task).
2. Use the existing Swiss-cross badge in the header — internally cohesive with the cloud's own login, no new assets, but deviates from the edge under D7. Not chosen.
3. Both, treating the transition as intended letterhead-vs-favicon usage. Not chosen as a separate outcome; it is what option 1 produces.

**The licensed-asset copy needs one confirming sentence in the task report, not a fresh question.** `src/assets/agroscope/README.md` states the assets come from an official Agroscope branding package and says *"Do not replace these with approximated logos or hand-drawn bars"* — copying the official files honours that, and "copy the edge" covers it. State in the report that you copied the four official PNGs unmodified and vendored no approximation, and name the edge commit they came from.

**(ii) The alignment arithmetic does not transfer, and this one is derivation, not ratification — nobody can answer it for you.** Edge `index.css:29-35` sets `.balken-crown { margin-left: max(16px, calc(50% - 784px)); }`, where **784 = 800 − 16** is derived from the edge's `max-w-[1600px]` content column. The cloud's column is **`max-w-7xl` (1280px)** — `DashboardHeader.tsx:28` before T3, and T3's `AppHeader` keeps `max-w-7xl`. So the edge constant is wrong here and the correct value is `max(16px, calc(50% - 624px))` (640 − 16). **Do not copy 784.** Confirm `max-w-7xl` is still what T3 shipped and derive the number from that, showing the arithmetic.

- [ ] **Step 1: Copy the four assets and only those four**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui/src/assets/agroscope
for l in en de fr it; do
  cp "balken-horizontal-$l.png" /home/phil/Repos/osi-server/.worktrees/agrolink/frontend/src/assets/agroscope/
done
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend/src/assets/agroscope && ls -la
```
Expected: `swiss-cross.jpg`, `README.md`, and the four new PNGs (19–24 KB each, ~84 KB total). **Do NOT copy the four `logo-*-hoch.png`** (60–70 KB each, 250 KB total): they are unused on the edge too (`grep '\.logoHoch\b'` returns only the definition), so copying them would add a quarter-megabyte of dead licensed binary to a second repo. Verify with `cmp` that each copy is byte-identical to its source, and append a provenance line to the cloud `README.md` naming the edge commit the assets came from.

- [ ] **Step 2: Create `frontend/src/branding/agrolink.ts`**

Adapt the edge's `src/branding/agrolink.ts`, dropping `logoHoch` and the four imports that feed it. Keep `resolveAgroscopeAssetLocale`'s exact prefix-matching semantics so both repos resolve identically — `de*`→de, `fr*`→fr, `it*`→it, **everything else including `es`, `pt` and `lg` falls back to `en`**:

```ts
import balkenHorizontalDe from '../assets/agroscope/balken-horizontal-de.png';
import balkenHorizontalEn from '../assets/agroscope/balken-horizontal-en.png';
import balkenHorizontalFr from '../assets/agroscope/balken-horizontal-fr.png';
import balkenHorizontalIt from '../assets/agroscope/balken-horizontal-it.png';

export type AgroscopeAssetLocale = 'en' | 'de' | 'fr' | 'it';

export interface AgroscopeBrandAssets {
  locale: AgroscopeAssetLocale;
  balkenHorizontal: string;
}

/* The Agroscope Balken lockup ships in four language variants only. The app
   serves seven locales, so es/pt/lg intentionally fall back to the English
   mark — Agroscope publishes no Spanish, Portuguese or Luganda Balken, and an
   approximated one is forbidden by the asset README. Mirrors the edge's
   resolveAgroscopeAssetLocale so both GUIs pick the same file for a locale.
   `logoHoch` is deliberately NOT vendored: nothing consumes it on the edge
   either (S6 T6 reading 11). */
const AGROSCOPE_ASSETS: Record<AgroscopeAssetLocale, AgroscopeBrandAssets> = {
  en: { locale: 'en', balkenHorizontal: balkenHorizontalEn },
  de: { locale: 'de', balkenHorizontal: balkenHorizontalDe },
  fr: { locale: 'fr', balkenHorizontal: balkenHorizontalFr },
  it: { locale: 'it', balkenHorizontal: balkenHorizontalIt },
};

export function resolveAgroscopeAssetLocale(language?: string | null): AgroscopeAssetLocale {
  const normalized = String(language ?? '').trim().toLowerCase();
  if (normalized.startsWith('de')) return 'de';
  if (normalized.startsWith('fr')) return 'fr';
  if (normalized.startsWith('it')) return 'it';
  return 'en';
}

export function resolveAgroscopeAssets(language?: string | null): AgroscopeBrandAssets {
  return AGROSCOPE_ASSETS[resolveAgroscopeAssetLocale(language)];
}
```

**Check the cloud's Vite/TS setup accepts PNG imports as strings** before assuming: the edge is Vite too, but confirm `vite-env.d.ts` (or equivalent) declares the asset module types, or `tsc` in `npm run build` will reject four imports. If the declaration is missing, add it — and note that `npm run build` runs `tsc` first, so this fails the build, not just the editor.

- [ ] **Step 3: Port the crown CSS with the corrected constant**

Append to `frontend/src/index.css` (16 lines today). Port **only** the dashboard rule and its `<640px` override. **Do not port `.login-scene .balken-crown`** — the cloud login keeps its Swiss-cross badge per D6 and has no `.login-scene`:

```css
/* Agroscope Balken crown. Scaled by height so it keeps its natural aspect,
   then offset so the crown's LEFT EDGE lands on the content column's left
   edge (16px inside the column). The constant is derived from THIS app's
   column: AppHeader uses max-w-7xl = 1280px, so half is 640 and the inset is
   640 - 16 = 624. The edge's own rule says 784 because its column is
   max-w-[1600px]; copying 784 here would misalign the mark by 160px. */
.balken-crown {
  display: block;
  height: 3rem;
  width: auto;
  max-width: none;
  margin-left: max(16px, calc(50% - 624px));
}

/* Below `sm` (640px) the fixed 3rem height gives this ~29.7:1 banner an
   intrinsic width of ~1427px, so only ~27% is visible on a 390px phone.
   Scale to the available width instead and show the whole mark — a
   proportionally thin strip, inherent to the aspect ratio, and approved as-is
   on the edge (maintainer, 2026-07-22). */
@media (max-width: 639px) {
  .balken-crown {
    height: auto;
    width: 100%;
    max-width: none;
    margin-left: 0;
    object-fit: contain;
  }
}

/* Brand typography: Noto Sans on brand surfaces — the Confederation's web
   substitute for the Frutiger used in the Balken. */
.font-brand {
  font-family: 'Noto Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto',
    'Helvetica Neue', sans-serif;
}
```

**`.font-brand` names 'Noto Sans' but neither repo bundles it** — check whether the edge loads it (a `@font-face`, a `<link>` in `index.html`, or a dependency) and mirror whatever you find. If the edge relies on the font being installed locally, then `.font-brand` silently falls through to the system stack on most machines and the cloud will do the same; **say so in the report rather than shipping a rule that looks like it does something it does not.**

- [ ] **Step 4: Mount the crown in `AppHeader`**

Wrap T3's `<header>` in the crown container, mirroring edge `AppHeader.tsx:74-85`. The crown sits in document flow and scrolls away; only the header sticks:

```tsx
  const { t, i18n } = useTranslation('dashboard');
  const { balkenHorizontal } = resolveAgroscopeAssets(i18n?.language ?? 'en');
  …
  return (
    <div className="font-brand">
      {/* Always on white in both themes: the asset's gradient tail ends in pure
          #FFFFFF and is designed to dissolve into a white page. In flow, so it
          scrolls away; the header below it sticks. */}
      <div className="overflow-hidden bg-white">
        <img src={balkenHorizontal} alt="Agroscope" className="balken-crown" />
      </div>
      <header className="glass-chrome sticky top-0 z-30 border-b border-[var(--border)]">
      …
      </header>
    </div>
  );
```

**Two deliberate differences from the edge, both to be stated in the report:** the edge's `alt` is `"Agroscope Balken"`, which names the asset rather than describing the image — use `"Agroscope"`, and note the divergence.

And `bg-white` on the crown wrapper is **intentional**: the asset's own gradient tail terminates in pure `#FFFFFF`, so a theme-aware token background would show a seam against the image in the dark theme. **Check what T4's guard actually does with it before adding anything.** `chromeTokens.test.ts`'s `PALETTE` regex requires a numeric shade (`-\d{2,3}`), so `bg-white` does **not** match it and needs **no allowlist entry** — the guard covers `AppHeader.tsx` but is blind to `bg-white` by construction. Confirm that by running the guard after this step and reporting that it passes. Do **not** add an allowlist mechanism the guard does not have, do **not** widen the regex to catch `white`/`black` (that would fire on this deliberate case and on nothing else useful in these seven files), and do **not** "fix" the `bg-white` to a token. Instead add a code comment at the crown wrapper stating why it is raw, so the next reader does not tidy it away — and note in T10's ledger that `chromeTokens` does not fence `white`/`black`, which is a real, deliberate hole in a guard this slice introduced.

- [ ] **Step 5: Extend the existing branding test**

`frontend/tests/agrolinkBranding.test.ts` already asserts `index.html`'s title/favicon, `Account.tsx`'s string and the locale keys. Add: the four PNGs exist; `resolveAgroscopeAssetLocale` maps `de-CH`→`de`, `fr`→`fr`, `it`→`it`, and `es`/`pt`/`lg`/`en`/`''`/`null`→`en`; and `AppHeader.tsx` renders `.balken-crown`. **Do not weaken any existing assertion** — the brand *word* coverage must survive intact, since that is what already ships.

- [ ] **Step 6: Suites and a real visual check**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx tsx --test tests/agrolinkBranding.test.ts tests/chromeTokens.test.ts
npm run test:unit && npm run build
```
Then load `/dashboard` at 1920px, 1280px and 390px in **both** themes and confirm: the wordmark's left edge aligns with the page content below it, the mark is not clipped, and the white crown band does not read as a seam against the dark theme. Report which widths and themes you checked, with the alignment result at each. Also confirm the build's asset list gained exactly four PNGs and report the total added bytes.

- [ ] **Step 7: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/branding frontend/src/assets/agroscope frontend/src/index.css \
        frontend/src/components/AppHeader.tsx frontend/tests/agrolinkBranding.test.ts frontend/tests/chromeTokens.test.ts
git commit -m "feat(gui): Agroscope Balken crown in the logged-in app, column-corrected"
```

**Expected suite delta: cloud node-runner +3** (assets exist, locale resolution, crown mounted), **cloud Vitest +0**. Running total after T6: cloud 122 node / 703–706 Vitest.

---

### Task 7: Edge — read-only users keep Settings

Scope E, maintainer decision 4. Reading 8. Today a granted read-only viewer on desktop cannot reach the language switcher, the theme control or the units control, because Settings is hidden from the header at four call sites **and** the route redirects them away. Luganda is behind that wall, and Luganda gates a Uganda deployment. This task also creates the `ReadOnlyNotice` component T8 mounts more widely.

**This is the one task in the plan that makes a surface MORE reachable, so it is the one place "fail-closed" pulls against the requirement.** The rule that resolves it, and which every step below is measured against: **reachability of a read-safe display preference is not a write authority.** A control may be exposed to a viewer only if it is provably non-mutating. Exactly one control in this page is not, and Step 4 gates it.

**Files:**
- Create: `web/react-gui/src/components/ReadOnlyNotice.tsx`
- Create: `web/react-gui/tests/settingsReadSafe.test.ts`, `web/react-gui/tests/readOnlyNoticeLocales.test.ts`
- Modify: `web/react-gui/src/App.tsx` (the `/settings` and `/support-requests` routes)
- Modify: `web/react-gui/src/components/DashboardHeader.tsx` (`:39`)
- Modify: `web/react-gui/src/pages/{JournalPage,HistoryDashboard,CrossZoneAnalysisPage}.tsx` (`:237`, `:413`, `:173`)
- Modify: `web/react-gui/src/pages/SettingsPage.tsx`
- Modify: 7× `web/react-gui/public/locales/*/{settings,common}.json`
- Possibly modify: `web/react-gui/src/components/WritableOnly.tsx` — see Step 3

**Interfaces:**
- Produces: `export const ReadOnlyNotice: React.FC<{ scope: 'farm' | 'section'; className?: string }>` from `web/react-gui/src/components/ReadOnlyNotice.tsx`, rendering a ui-core `Banner tone="info"`. **T8 consumes it.** Also produces the locale keys `common:readOnly.farm` and `common:readOnly.section`.
- Consumes: T2's ui-core changes are already in place but this task does not depend on them.

- [ ] **Step 1: Enumerate every control in `SettingsPage.tsx` and classify it — before changing anything**

`SettingsPage.tsx` contains **zero** `canWrite` references today (`grep -n canWrite pages/SettingsPage.tsx` → no hits). Its only protection is `WritableOnly` at the route. So removing that guard exposes **every** control at once, and the classification below is what stands between this task and a privilege escalation.

Re-derive the line ranges with `grep -n` and paste them; the ranges below were measured at `d2851111` and will shift:

| Lines | Section | Class | Why |
|---|---|---|---|
| ~370-375 | Language (`LanguageSwitcher`) | **read-safe** | the whole point of the task |
| ~377-384 | Appearance / theme | **read-safe** | per-user display preference |
| ~386-401 | Units (`swtUnit`, kPa/pF) | **read-safe** | per-user display preference |
| ~405-412 | Module: prediction advisory | **read-safe** | localStorage display toggle |
| ~413-419 | Module: water card | **read-safe** | localStorage display toggle |
| **~420-429** | **Module: irrigation schedule** | **WRITE-GATED** | **disabling it calls `irrigationZonesAPI.disableAllSchedules()` at `:287` — a real backend mutation across every zone** |
| ~430-436 | Module: environment card | **read-safe** | localStorage display toggle |
| ~450-457 | Data / auto-refresh | **read-safe** | per-user display preference |
| ~459-469 | Journal detail level | **read-safe** | per-user display preference |
| ~471-587 | Support request form | **read-safe for this purpose** | `supportRequestsAPI.create` mutates a *ticket*, not farm or gateway state, and decision 4 explicitly requires support to be reachable by viewers |

**For every row you classify read-safe, prove it**: trace the handler and show it writes only `localStorage`/`i18n`/component state, or calls no API at all. **If you find a second mutating control, stop and report it** — the plan asserts exactly one and a second would mean this table is wrong, not that you should gate it quietly. Paste the trace for each in the report.

- [ ] **Step 2: Write the failing tests**

**(a)** `web/react-gui/tests/settingsReadSafe.test.ts` — a static guard that the route is no longer write-gated and the one mutating call is:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const srcRoot = path.resolve(import.meta.dirname, '../src');
const read = (rel: string) => fs.readFileSync(path.join(srcRoot, rel), 'utf8');

// Maintainer decision 4 (S6): read-only users keep Settings. The language,
// theme and units controls are per-user display preferences and the only
// in-app language switcher an authenticated desktop viewer can reach; Luganda
// is behind them and Luganda gates Uganda.
//
// These two tests assert on the WHOLE of App.tsx, not on a sliced route block.
// A slice is not available: edge App.tsx contains ZERO `</Route>` occurrences
// — every route is self-closing `<Route … />`, including /settings (line 69,
// `<WritableOnly><SettingsPage /></WritableOnly>`) and /support-requests (57).
// `</Routes>` does not contain the substring `</Route>` either. So
// `indexOf('</Route>')` returns -1, `slice(0, -1 + 8)` is the first SEVEN
// characters, and a block-slicing version of these tests passes today with the
// read-only wall fully intact. Whole-file assertions are also strictly
// stronger here: WritableOnly wrapped exactly one route, so "App.tsx does not
// mention it" is the complete statement of the fix. Each test also asserts its
// route is still REGISTERED, so neither can be satisfied by deleting a route.
test('App.tsx no longer references WritableOnly anywhere, and /settings is still routed', () => {
  const app = read('App.tsx');
  assert.ok(app.includes('path="/settings"'), '/settings must still be registered');
  assert.ok(
    !app.includes('WritableOnly'),
    'Settings must be reachable by read-only users — no WritableOnly reference may remain in App.tsx',
  );
});

test('the WritableOnly import is gone from App.tsx, and /support-requests is still routed', () => {
  const app = read('App.tsx');
  assert.ok(app.includes('path="/support-requests"'), '/support-requests must still be registered');
  assert.doesNotMatch(
    app,
    /^\s*import\s.*WritableOnly.*$/m,
    'the WritableOnly import must be removed, not left dangling',
  );
});

// The header must not hide Settings from non-writers any more.
test('no caller passes a canWrite-derived showSettings', () => {
  const offenders: string[] = [];
  for (const rel of [
    'components/DashboardHeader.tsx',
    'pages/JournalPage.tsx',
    'pages/HistoryDashboard.tsx',
    'pages/CrossZoneAnalysisPage.tsx',
  ]) {
    for (const line of read(rel).split('\n')) {
      if (/showSettings\s*=\s*\{[^}]*canWrite/.test(line)) offenders.push(`${rel}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, []);
});

// The one genuinely mutating control stays gated, inside the page.
test('the irrigation-schedule module toggle is gated on canWrite', () => {
  const page = read('pages/SettingsPage.tsx');
  assert.ok(page.includes('canWrite'), 'SettingsPage must gate its one mutating control');
  const call = page.indexOf('disableAllSchedules');
  assert.ok(call > 0, 'disableAllSchedules must still exist');
  // The guard must be in the same function that makes the call, not merely
  // somewhere in the file.
  const before = page.slice(Math.max(0, call - 1200), call);
  assert.match(before, /canWrite/, 'the disableAllSchedules path must check canWrite');
});
```

**(b)** `web/react-gui/tests/readOnlyNoticeLocales.test.ts` — full 7-locale key equality for the two new `common.json` keys. `common.json` has **no** full key-equality test on the edge (only `tests/analysis-locales.test.ts`, which covers just the `analysis` subtree), so this task adds the coverage for what it writes. Model it on T3's `dashboardLocales.test.ts` traversal, asserting `readOnly.farm` and `readOnly.section` exist and are non-empty in all 7.

Run both, confirm they fail:
```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npx tsx --test tests/settingsReadSafe.test.ts tests/readOnlyNoticeLocales.test.ts
```
Expected: `settingsReadSafe` fails on **all four** tests — test 1 because `App.tsx:69` still wraps `SettingsPage` in `WritableOnly`, test 2 because `App.tsx:18` still imports it, test 3 with **four** `showSettings={canWrite…}` offenders (`DashboardHeader.tsx:39` plus the three pages), test 4 because `SettingsPage.tsx` contains no `canWrite`. `readOnlyNoticeLocales` fails on `readOnly.farm missing in en`.

**Verify the four-red claim by running it before touching anything.** Tests 3 and 4 were confirmed red at planning time. Tests 1 and 2 are the rewritten pair — the block-slicing versions this plan originally carried were **green at baseline** (see the comment in the snippet), which is exactly the failure mode this step exists to catch. If either passes on the first run, the test is wrong, not the code.

- [ ] **Step 3: Open the route, and decide `WritableOnly`'s fate explicitly**

In `App.tsx`, unwrap `/settings`:
```tsx
          <Route
            path="/settings"
            element={
              <PrivateRoute>
                <SettingsPage />
              </PrivateRoute>
            }
          />
```

**`WritableOnly` now has zero usages** — it wrapped exactly one route (reading 8). Three options; pick one and say which and why:
1. **Delete `WritableOnly.tsx`** and its test, if any. Cleanest; a component with no consumers is dead code.
2. **Keep it** for a future write-only route. Then it is unreferenced code and must be marked as such.
3. Keep it and use it on a *sub-section* — **rejected**: it redirects, and redirecting away from part of a page is not a thing.

Recommended: **delete it**, and record the deletion in T10's ledger so the next author does not reinvent it. Check for tests referencing it first (`grep -rn WritableOnly web/react-gui/`).

**Whichever option you pick, `App.tsx` must end up with no `WritableOnly` element and no `WritableOnly` import** — that is what Step 2's tests 1 and 2 assert, and they hold under option 1 and option 2 alike, because they are about `App.tsx`, not about whether the component file exists. Under option 2 you must also delete the import, or test 2 stays red on a dangling import for a component nothing uses.

For `/support-requests`: it currently redirects to `/settings` because the support form lives **inside** `SettingsPage.tsx` (~471-587). Once `/settings` is open, the redirect already achieves decision 4's requirement, so **the minimal correct fix is to leave the redirect in place** and let it now land somewhere reachable. **Do that**, and note the finding it exposes: `web/react-gui/src/pages/SupportRequests.tsx` (556 lines) **exists and is routed nowhere** — dead code since the form was folded into Settings. Do **not** wire it up in this task (that is a feature decision about which support surface is canonical); ledger it in T10.

- [ ] **Step 4: Gate the one mutating control inside the page**

`SettingsPage.tsx` must now obtain `canWrite` itself. Read how the other edge pages get it (the `ScopeContext`/`useScope` pattern the four `showSettings` call sites already use) and use the same hook — do not invent a second source of truth. **Fail closed while loading**, per D5: `const writable = canWrite && !scopeLoading;`.

Then, for the irrigation-schedule module row (~420-429):
- render the toggle **disabled** when `!writable` rather than hiding it, so the user learns the setting exists;
- render **one** `<ReadOnlyNotice scope="section" />` for that section — not per control;
- ensure the `disableAllSchedules` handler itself early-returns when `!writable`. **A disabled attribute is a UI affordance, not an authorization** — the handler check is the actual gate and the test in Step 2(b) asserts it sits in the same function as the call.

**Enumerate every handler in `SettingsPage.tsx` and state its gate in the report** (D5's per-handler sweep). The expected result is: one handler gated, all others provably non-mutating per Step 1's table.

- [ ] **Step 5: Create `ReadOnlyNotice`**

```tsx
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Banner } from '../ui-core';

interface ReadOnlyNoticeProps {
  /**
   * `farm` — the whole page is read-only for this user; mount ONCE per page.
   * `section` — only this section is, while the rest of the page is editable.
   */
  scope: 'farm' | 'section';
  className?: string;
}

/**
 * One explanation per surface, never one per control (maintainer decision 3(c),
 * S6). The edge hid controls at 18 sites with zero explanation; eighteen inline
 * notices would be clutter and would fight decision 3(a), which says a card
 * absent because no such device is connected is CORRECT and must stay silent.
 * So: a viewer learns "you have read-only access to this farm" once, and the
 * absence of a dendrometer card still says nothing, because there is nothing
 * to say.
 *
 * tone="info", not "warn": in a fail-closed product amber means "you cannot
 * write"; spending it on a stable, expected state devalues the signal. The
 * `info` tone and its --info-* tokens already ship (ui-core commit 1364b891).
 */
export const ReadOnlyNotice: React.FC<ReadOnlyNoticeProps> = ({ scope, className }) => {
  const { t } = useTranslation('common');
  return (
    <Banner tone="info" className={className}>
      {t(`readOnly.${scope}`)}
    </Banner>
  );
};
```

Add `readOnly.farm` and `readOnly.section` to all 7 `common.json`. English drafts:
- `readOnly.farm`: *"You have read-only access to this farm. You can view everything here; changes are made by the farm owner."*
- `readOnly.section`: *"These settings are managed by the farm owner. Your own display preferences above are yours to change."*

Translate `de-CH`, `fr`, `it`, `es`, `pt` properly. **`lg` is Luganda and gates Uganda — mark both `lg` strings as machine drafts pending the human-native gate, and use a straight apostrophe.** Do not present them as final.

**Verify `Banner` is exported from the edge's `ui-core` index and that `tone="info"` renders the `--info-*` triad** (`Banner.tsx:9`) before assuming — this is the edge's **second** `<Banner>` mount ever (`ScopeStatusBanner.tsx:12` is the first and only one today), so the import path is not yet well-trodden here.

- [ ] **Step 6: Unhide Settings at the four call sites**

Delete the `showSettings` prop from all four: `components/DashboardHeader.tsx:39` (`showSettings={canWrite}`) and `pages/{JournalPage.tsx:237, HistoryDashboard.tsx:413, CrossZoneAnalysisPage.tsx:173}` (`showSettings={canWrite && !scopeLoading}`). `AppHeader`'s default is already `showSettings = true` (`:54`), so deleting the prop is the whole change — **do not** pass `showSettings={true}`, which is noise.

Re-derive each line number first. **Leave `showAdmin` alone at all four sites** — admin visibility is a different authorization question and is not in decision 4.

Then check whether `canWrite`/`scopeLoading` become unused in any of those four files. If so, remove the now-dead computation; if they are still used for other gating (they are, in at least `JournalPage` and `IrrigationZoneCard`'s parents), leave them. `tsc` via `npm run build` catches an unused import but not an unused local, so check by reading.

- [ ] **Step 7: Tests, then suites**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npx tsx --test tests/settingsReadSafe.test.ts tests/readOnlyNoticeLocales.test.ts
npm run test:unit:tsx-runner && npm run test:unit:vitest && npm run build
```
Expected: both new files PASS; existing suites green. **Any existing test that asserted Settings is hidden from non-writers will now fail — that is a correct failure recording the old behaviour, and it must be updated to assert the new behaviour, not deleted.** Name each one in the report.

Mutation-test `settingsReadSafe`: re-wrap `/settings` in `WritableOnly` (which also restores the import), confirm **tests 1 and 2 both go red**, revert. Then re-add `showSettings={canWrite}` to one page, confirm test 3 goes red naming that page, revert. Paste each red run. Note that the mutation must produce red for the *stated reason* — if test 1 goes red but test 2 stays green, the import was left behind and the mutation was incomplete.

- [ ] **Step 8: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add web/react-gui/src/App.tsx web/react-gui/src/components web/react-gui/src/pages/SettingsPage.tsx \
        web/react-gui/src/pages/JournalPage.tsx web/react-gui/src/pages/HistoryDashboard.tsx \
        web/react-gui/src/pages/CrossZoneAnalysisPage.tsx web/react-gui/public/locales \
        web/react-gui/tests/settingsReadSafe.test.ts web/react-gui/tests/readOnlyNoticeLocales.test.ts
git commit -m "fix(gui): read-only users keep Settings — language, theme and units are not write authorities"
```

**Expected suite delta: edge node-runner +7** (4 `settingsReadSafe` + 3 `readOnlyNoticeLocales`), **edge Vitest +0 to +3** depending on whether you add a `ReadOnlyNotice` component test — **T8 adds that test, so keep this task at +0 Vitest** and say so. Running total after T7: edge 126 node / 1691 Vitest.

---

### Task 8: Edge — explain read-only once per surface

Scope E, maintainer decision 3(c). Reading 7. Eighteen sites hide controls with no explanation and there are zero explanations anywhere. **One notice per page, not per control**, and **decision 3(a) is untouched**: a card absent because no such device is connected stays silent, because that silence is the intended design.

**Files:**
- Modify: `web/react-gui/src/pages/{FarmingDashboard,JournalPage,HistoryDashboard}.tsx`
- Create: component test for `ReadOnlyNotice` + per-page mount tests

**Interfaces:**
- Consumes: `ReadOnlyNotice` and the `common:readOnly.*` keys from T7. **This task adds no new locale keys** — if you find yourself needing one, the notice is becoming per-control and you have drifted from decision 3(c).
- Produces: nothing consumed later. **Adds zero mutating handlers.**

- [ ] **Step 1: Re-derive the hiding inventory and assign each site to a page**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui/src
grep -rn 'canWrite\s*&&' . | grep -v __tests__
grep -rn '<CanWrite' . | grep -v __tests__
grep -rn 'readOnly={!canWrite}' . | grep -v __tests__
```
Expected at `d2851111`: 17 inline, 1 `<CanWrite>`, 10 `readOnly={!canWrite}`. **T7 removed exactly three of the 17**, so expect **14** inline now. The three are the `showSettings={canWrite && !scopeLoading}` sites at `pages/{JournalPage.tsx:237,HistoryDashboard.tsx:413,CrossZoneAnalysisPage.tsx:173}`. **T7 removes a fourth `showSettings` prop that was never one of the 17** — `DashboardHeader.tsx:39` is `showSettings={canWrite}`, with no `&&`, so it never matched `canWrite\s*&&` and must not be subtracted here. And **`FarmingDashboard.tsx:152` survives T7 untouched**: it is `canWrite={canWrite && !scopeLoading}`, a prop pass that feeds the Add-menu gating at `DashboardHeader.tsx:41`, not a Settings gate. 17 − 3 = **14**. **If the numbers differ, report them** — they are this task's drift detector and the plan's figures expire.

Then map each surviving site to the page that owns it:

| Page | Hidden/disabled controls it owns | Notice |
|---|---|---|
| `pages/FarmingDashboard.tsx` | `:152` (the `canWrite` prop pass that makes `DashboardHeader.tsx:41` hide the whole Add menu), `:186,355,361`, + all of `IrrigationZoneCard.tsx`'s 8 inline sites and its 10 `readOnly` disables (the card is rendered by this page) | **1** `<ReadOnlyNotice scope="farm" />` |
| `pages/JournalPage.tsx` | the `<CanWrite>` at `:332-341`, plus `JournalWorkspace.tsx:375` and `DetailPanel.tsx:432` beneath it | **1** `<ReadOnlyNotice scope="farm" />` |
| `pages/HistoryDashboard.tsx` | no write controls beyond the removed `showSettings` — **verify** | **0 if it has none** |

**If a page has no hidden write control, it gets no notice.** A read-only banner on a page that is read-only for everybody is noise, and shipping one would be the per-control instinct in disguise.

- [ ] **Step 2: Write the failing tests**

A component test for `ReadOnlyNotice` (T7 created the component; this task proves it behaves), plus one mount assertion per page that gets a notice:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReadOnlyNotice } from '../ReadOnlyNotice';

describe('ReadOnlyNotice', () => {
  it('renders as a polite status, not an alert — read-only is a stable state', () => {
    render(<ReadOnlyNotice scope="farm" />);
    const el = screen.getByRole('status');
    expect(el.getAttribute('aria-live')).toBe('polite');
  });

  it('uses the info tone, so amber keeps meaning "you cannot write"', () => {
    const { container } = render(<ReadOnlyNotice scope="farm" />);
    const el = container.firstElementChild!;
    expect(el.className).toContain('var(--info-bg)');
    expect(el.className).not.toContain('var(--warn-bg)');
  });
});
```
`Banner` sets `role="status"` and `aria-live="polite"` for every non-error tone (`Banner.tsx:19,23`) — confirm that from the file rather than trusting it, since the assertion depends on it.

For each page: assert **exactly one** notice renders when the user cannot write, and **none** when they can:
```tsx
it('explains read-only access once, not once per hidden control', () => {
  renderPageAsViewer();
  expect(screen.getAllByRole('status').filter(isReadOnlyNotice)).toHaveLength(1);
});
```
Read each page's existing test file to reuse its render harness and scope mocking; do not invent a new one.

Run them and confirm they fail on the mount assertions (0 notices found).

- [ ] **Step 3: Mount one notice per qualifying page**

Place it where a user reads it before reaching for a control — directly beneath the header, above the page content. Derive `writable` from the scope hook the page already uses, and **fail closed while loading** (`canWrite && !scopeLoading`), matching the pattern T7 established:

```tsx
{!writable && <ReadOnlyNotice scope="farm" />}
```

**Do not touch any of the 14 surviving inline `canWrite &&` sites, the `<CanWrite>` wrapper, or the 10 `readOnly` disables.** They keep hiding and disabling exactly as they do now. The change is that the user is now told why, once. Adding a second notice next to any individual control is a scope breach and a reviewer must reject it.

- [ ] **Step 4: Confirm decision 3(a) is untouched**

State explicitly in the report, having checked the diff: **no** placeholder, empty-state or "not connected" text was added for an absent device card. A clean interface showing only what applies to this farm is the intended design, and the notice this task adds is about *permission*, never about *relevance*. A reviewer must verify this from the diff, not from this sentence.

- [ ] **Step 5: Tests and suites**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npm run test:unit:vitest && npm run test:unit:tsx-runner && npm run build
```
Expected: all green. Mutation-test one mount: render a page as a *writer* and confirm zero notices; then as a viewer and confirm exactly one. A test that only ever checks the viewer case cannot catch a notice shown to everybody.

- [ ] **Step 6: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add web/react-gui/src/pages web/react-gui/src/components
git commit -m "fix(gui): tell read-only users why, once per surface instead of eighteen silences"
```

**Expected suite delta: edge Vitest +2 (component) +2 or +3 (one mount test per qualifying page — state the exact number once Step 1 settles whether `HistoryDashboard` qualifies), edge node-runner +0.** Running total after T8: edge 126 node / 1695–1696 Vitest.

---

### Task 9: Edge — state the reason when a feature is unavailable

Scope E, maintainer decision 3(b). **Reading 6 corrects the brief and narrows this task: the edge does NOT have "zero" such states.** `components/analysis/AnalysisSeriesTray.tsx:55-56,135` already renders an explicit `'unsupported'` reason with copy at `public/locales/en/common.json:44`, and `public/locales/en/journal.json:324` carries `"This activity is not available for the selected layout"`. What is genuinely missing is the same treatment everywhere else — and the "not available on **this gateway**" framing in D4 is cloud-shaped, since a gateway GUI never asks a remote gateway what it supports.

**So this task is scoped to per-feature capability silences on the edge, using the two existing states as the in-repo precedent for copy and shape.** It is the least well-specified task in the plan and the most likely to sprawl.

**Files:**
- Modify: `web/react-gui/src/components/farming/*` (the specific files Step 1 identifies)
- Modify: 7× `web/react-gui/public/locales/*/devices.json`
- Create: `web/react-gui/tests/capabilityStateLocales.test.ts`
- Create/modify: component tests for each changed card

**Interfaces:**
- Consumes: T7's `ReadOnlyNotice` only as a *pattern* reference. **A capability state is not a permission state and must not reuse `ReadOnlyNotice`** — conflating "you may not" with "it cannot" is exactly the confusion this slice is trying to remove.
- Produces: locale keys under `devices:unavailable.*`. **Adds zero mutating handlers.**

- [ ] **Step 1: Find the real silences, and bring the list back before building**

This step is investigation and it gates the rest of the task. A capability silence is a place where the edge renders **nothing** (or an inert control) because a device or gateway does not support a feature — as distinct from:
- **decision 3(a), relevance** — no dendrometer connected, so no dendrometer card. **Correct. Not a silence. Do not touch.**
- **permission** — T7/T8 own it.

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui/src
grep -rn 'supports\|capabilit\|unsupported\|available' components/farming/ | grep -v __tests__
grep -rn "'unsupported'\|availability" . | grep -v __tests__
```
Cross-read the **cloud's** two D4 implementations as the design reference (not a byte source):
- **journal domain**, the better-factored one: `frontend/src/journal/journalCapability.ts:27-57`'s `journalCaptureBlockedReason(state, catalog, workspace?)` returns a discriminated union `'loading' | 'no_gateway' | 'viewer' | 'blocked_authority' | 'unsupported_gateway' | 'catalog_incompatible'`, mapped to copy + tone at **two** call sites (`JournalCaptureModal.tsx:74-96`, `JournalPage.tsx:115-136`) — a duplication the cloud should collapse and this task should not copy.
- **zone domain**, the thin one: `frontend/src/contexts/gatewayCapabilities.ts:28-32`'s `zoneMutationsSupported(state)`, rendered ad hoc at `CreateZoneModal.tsx:113-117` and `IrrigationZoneCard.tsx:239-243` with the **same** locale key but two different shapes (a warn-styled `<p>` and a pill `<span>`).

**Deliverable of this step, before any code: a table of candidate sites, each classified silence / relevance / permission, with the file:line and the capability predicate that decides it.** Bring it to the maintainer with a recommendation for which subset T9 fixes. **If the list is empty or every candidate turns out to be relevance-shaped, say so and close T9 as not-applicable** — that is a legitimate outcome given reading 6, and inventing capability states to fill a task would be worse than closing it. This task's budget is the subset that survives that review, not "all capability gating on the edge".

- [ ] **Step 2: Write the failing tests for the agreed subset**

For each site in the agreed subset, a component test asserting that when the capability is absent the component renders a **stated reason** rather than nothing:

```tsx
it('states why the control is unavailable instead of rendering nothing', () => {
  renderCardWithCapability({ supported: false });
  expect(screen.getByText(/not available/i)).toBeTruthy();
});

it('renders the control normally when the capability is present', () => {
  renderCardWithCapability({ supported: true });
  expect(screen.queryByText(/not available/i)).toBeNull();
});
```
The second assertion is not optional: without it the test passes on a component that always shows the notice.

Plus `web/react-gui/tests/capabilityStateLocales.test.ts` — 7-locale equality for the new `devices:unavailable.*` keys, modelled on T3's traversal.

- [ ] **Step 3: Implement, following the edge's own precedent**

Reuse the shape `AnalysisSeriesTray` already established (a reason **code** resolved to a locale key at the render site) rather than inventing a third pattern. Requirements:
- **A reason, not a shrug.** "Not available on this gateway" alone is close to useless; where the predicate knows *why* (firmware too old, device model lacks the feature), say which.
- **Distinct from permission.** Different copy, different component, and — because `info` means "informational" and this is a hard limitation — consider `Banner tone="warn"`, which is what the cloud's journal domain uses for `unsupported_gateway` (`JournalPage.tsx:134-136`). Match the cloud's tone choice so the two GUIs agree, and state the choice in the report.
- **Fail closed (D5):** unknown capability ⇒ treat as unsupported and say so, never as supported.
- `lg` strings marked machine-draft, straight apostrophes.

- [ ] **Step 4: Tests, suites, mutation test**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npx tsx --test tests/capabilityStateLocales.test.ts
npm run test:unit:vitest && npm run test:unit:tsx-runner && npm run build
```
Mutation-test the locale guard by deleting one key from `it/devices.json`; confirm red naming `it`; restore.

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add web/react-gui/src/components/farming web/react-gui/public/locales \
        web/react-gui/tests/capabilityStateLocales.test.ts
git commit -m "fix(gui): state the reason a feature is unavailable instead of rendering nothing"
```

**Expected suite delta: unknown until Step 1 closes, and that is stated rather than guessed.** Once the subset is agreed, **write the exact expected delta into the task record before implementing**, so T11 has a number to assert. A task that reaches T11 with a range has not finished Step 1.

---

### Task 10: Update the GUI-parity matrix — S6 rows and ledger

**Files:**
- Modify: `docs/superpowers/plans/agrolink-gui-parity-matrix.md` (osi-os)

**Interfaces:** none. No suite delta.

- [ ] **Step 1: Add the S6 slice row to the spec's own table, and say why it was missing**

The matrix mirrors the spec's slice assignment. Add S6 — *"The app shell: primary navigation, chrome tokens, route reachability, in-app brand mark, and the edge's permission/capability explanations"* — and carry reading 1's finding in one sentence: **the spec's slice table is organised by feature, so no row owned the frame; that is why four slices could each close their own row while the assembled product read as "the very beginning".**

- [ ] **Step 2: Edit only the rows S6 touched, and only their dates**

Do **not** bulk-refresh dates — the matrix's own header says an untouched row keeping its old date is the signal that it still needs a look.

Rows to edit:
- **App header (glass chrome)** — currently `missing; confirmed: cloud's DashboardHeader.tsx has no AppHeader import and no glass-prefixed class anywhere`. This is the row S6 exists for. New status: `partial (pending walkthrough)` — the tab pill, glass chrome and crown now ship on all four cloud parity pages, consuming the byte-mirrored `glass-tabs`/`glass-tab`/`glass-chrome` material; deviations recorded (a `LanguageSwitcher` the edge lacks, a five-item Account menu, Admin as a separate trigger, no `logoHoch`).
- **Farming dashboard**, **History dashboard**, **Cross-zone analysis**, **Field journal** — each gains the shell. Keep every existing deviation note; the shell does not close any of them.
- **Analysis route** — the row currently records `no equivalent desktop-only redirect gate; mobile users reach the page instead of being routed to history`. **T5 closed it**; update with the new `AnalysisRoute.tsx` and re-date.
- **Settings** — record that the edge's Settings is now reachable by read-only users, that the one mutating control inside is gated in-page, and that `/support-requests` now lands somewhere reachable.
- **Device detail page** — record the first in-app link to `/devices/:deviceEui` (maintainer decision 1: link it, don't delete it).
- **Scope status banner** — record the edge's new `ReadOnlyNotice` as a sibling: `ScopeStatusBanner` reports a scope *load failure*, `ReadOnlyNotice` explains a *granted* read-only state. Two different things, deliberately two components.
- The two **`ui-core` platform rows** — T2's translucent scrim, `color-scheme`, and the `--danger-fg` pairing guard, re-vendored and locally verified in both directions.

**No row flips to `parity`.** The walkthrough still has not happened, and the matrix's walkthrough-evidence caveat (the double-downlink defect and the MQTT-broker hardcode) still gates any evidence gathered before those two edge fixes are deployed — reproduce it in the ledger.

- [ ] **Step 3: Add the S6 ledger section**

Append `### S6 additions (the app shell, 2026-08-11)` with every item below, **in this order**. The CI-ref item leads: it is the one thing here that will fail a merge, and a reader who stops after three bullets must not miss it.

1. **The cloud's `backend-ci.yml` pins `ref: AgroLink` for three gates while work happens on `feat/journal-cloud-primary`, and `ui-core` has already moved past that ref.** `backend-ci.yml:20,34` check out osi-os at `AgroLink` for the sync-contract, ui-core and journal-catalog vendor gates; the workflow triggers only on `main`/`master`, and the edge's `ui-core.yml` triggers only on `AgroLink` — so **neither gate runs on this branch at all**. Meanwhile edge `ui-core` diverged from `AgroLink` at commit `68e4af3c` and again in S6 T2. Consequence: the moment this branch is proposed for merge, the ui-core vendor gate compares the cloud's copy against a stale canonical and fails. **Not fixed in S6** — repointing a ref used by three gates across two repos is a release-engineering decision with a blast radius beyond a GUI slice. Record the fix shape: either advance `AgroLink` to the reviewed head, or parameterise the ref. **S6's only vendor evidence is the local both-directions verifier run in T2 and T11.**
2. **Maintainer decision 6 was already fully implemented before S6 started and no task touched it.** `BannerTone` and `ChipTone` both already carry `info` (`Banner.tsx:3`, `Chip.tsx:3`); `--info-bg/-text/-border` exist in both themes; every cloud loading state already maps to `info`; commit **`1364b891`** ("fix(ui-core): add info tone, stop spending warn on loading states", 2026-08-06) did the tone *and* the call-site migration together. On the edge there is nothing to migrate: **one** `<Banner>` mount in the whole GUI (`ScopeStatusBanner.tsx:12`, `tone="error"`), **zero** `<Chip>` mounts, **zero** `tone="warn"`. The S3 ledger's note that `warn` is "forced by the closed 8-primitive `BannerTone` set (no `'info'`)" is **stale and must not be re-quoted.** The two unions are separate types, not one shared union.
3. **`--danger-fg` was NOT changed, and the reason is a measurement.** Light `#DC2626` on `--bg` is **4.458** — but a parent-chain walk of all **9** live `text-[var(--danger-fg)]` sites (edge; the cloud has zero live ones) puts every one on `--card` `#FFFFFF` = **4.829, passing**. `SystemPanel.tsx:236` sets the background on the text's own element; the 8 `DetailPanel.tsx` sites sit inside the `bg-[var(--card)]` `<aside>` at `:330` through transparent `<form>`s. Darkening a byte-mirrored token would move a production farm GUI to fix a pairing that does not occur. **What T2 fixed instead:** `SystemPanel.tsx:236`'s hover state swapped its own background to `--border` `#CBD5E1` while keeping the danger text — **3.253**, a real failing state of a real control. Reference figures, all failing 4.5:1 as text and all clearing 3:1 as a border: on `--bg` 4.458, `--surface` 4.100, `--error-bg` 3.953, `--border` 3.253. Fenced by `dangerFgPairing.test.ts` in both repos — **whose tree scan is non-vacuous on the edge (proven red on `SystemPanel`) and vacuous on the cloud**, recorded so a future green run there is not read as evidence. **The guard is variant-aware and had to be:** it groups a class string's utilities by variant and resolves each variant's effective bg/text pair against the base, because T2's own fix puts `hover:bg-[var(--error-bg)]` and `hover:text-[var(--error-text)]` in the same variant and a substring guard would have flagged the corrected line. Five table assertions inside the test pin that behaviour in both directions, so the variant logic cannot silently rot into an always-green matcher.
4. **The Agroscope Balken alignment constant does not transfer between the two apps.** Edge `index.css:29-35` uses `margin-left: max(16px, calc(50% - 784px))`, derived from its `max-w-[1600px]` column. The cloud's column is `max-w-7xl` (1280px), so the correct constant is **624**. Copying 784 misaligns the mark by 160px. Also: the cloud now has **two** Agroscope marks in one session — the Swiss-cross badge on login (kept by D6) and the Balken in the app — routed to the designer review. And `logo-*-hoch.png` (4 files, ~250 KB) is **unused on the edge too** and was deliberately not vendored.
5. **`.font-brand` names 'Noto Sans' and neither repo bundles it** (whatever T6 Step 3 found, recorded here). If it resolves only when the font happens to be installed, the rule is decorative on most machines — a real finding about the edge, inherited by the cloud.
6. **Only ONE external theme migration exists, not two.** `theme/deepseek-migration` = `d646fc89`, 48 files, 365 insertions / 365 deletions. `theme/kimi-migration` = `74f40662`, which is deepseek's **parent**, with zero unique commits and an empty diff against `origin/AgroLink` — a label on the baseline. Whoever takes the theme-blind component sweep (~400 hardcoded palette instances, still out of scope) has **one** prior attempt to review and should not hunt for a second.
7. **The three guard tests scan the whole `src` tree, not `src/pages`.** `noInertTokenAlpha`, `errorTokenMisuse` and `pageShellTokens` all resolve their root to `../src` and recurse; `pageShellTokens`'s root variable is *named* `pagesRoot` and the name is a lie. **The S3 ledger's "scans only `src/pages`, so every component escapes it entirely" is wrong** and is corrected here. The still-open widening item is about **regex strength** (uppercase/digit token names, `outline-`/`accent-`/`divide-`, multi-line template literals), not scope.
7b. **`chromeTokens.test.ts`, a guard S6 itself introduced, does not fence `white`/`black`.** Its `PALETTE` regex requires a numeric shade, so `bg-white` and `text-black` pass. That is **deliberate**: T6's Balken crown wrapper needs a raw `bg-white` because the asset's gradient tail terminates in pure `#FFFFFF` and a token background would seam against it in the dark theme. Recorded because a guard's blind spots must be written down where the guard is described, not discovered later by someone who assumes it is total. Whoever takes the theme-blind component sweep should decide then whether a widened regex plus a one-entry allowlist is worth it across a bigger surface; across these seven chrome files it would fire on exactly one deliberate case.

8. **`routeReachability.test.ts` is a deliberately crude guard and must not be oversold — and its first draft could not fail at all.** It proves a route's path *string* appears somewhere outside `App.tsx`; it cannot prove the link renders, is reachable, or is not behind a permission the user lacks. **The near-miss worth recording:** the drafted version used `corpus.includes(route)`, which is satisfied by import specifiers — 54 files import from `'…/history/…'`, 131 from `'…/journal/…'`, 46 from `'…/analysis/…'`, and `'/devices/'` appears in `services/api.ts` and `services/websocket.ts` — so it was **green at baseline for every route S6 exists to fix**, before T3 and before any fix. The shipped version anchors each needle to a string/template-literal delimiter (`/["'\`]\/history["'\`?]/`, and a literal-start match for parameterised prefixes), which removes the directory-name collisions and made it correctly red on `/devices/:deviceEui` at T5 Step 1. Record which routes T5 proved by hand versus which the guard merely failed to disprove.
9. **`/admin/prediction` and `/admin/work-requests` are `<AdminRoute>` while `/admin/users` and `/admin/devices` are `<AdminRoute superAdminOnly>`, but the Admin menu renders only for `isSuperAdmin`** — so a plain admin can reach two of the four by URL and by `PredictionCard.tsx:542-549`'s link, and sees no menu. T5 deliberately did not change this: who sees the Admin menu is an authorization-surface question, not a navigation fix.
10. **The edge's `pages/SupportRequests.tsx` (556 lines) is routed nowhere** — `/support-requests` redirects to `/settings`, where the support form actually lives (`SettingsPage.tsx` ~471-587). Dead page since the fold. T7 made the redirect land somewhere reachable and deliberately did not pick a canonical support surface.
11. **`WritableOnly` had exactly one consumer and T7 removed it** — record whether the component was deleted or kept as unreferenced code, so the next author does not reinvent it.
12. **The edge's `AppHeader.tsx` ships three hardcoded English literals** in a 7-locale product: the two admin labels at `:137-138` (`'Manage users'`, `'Access grants'`) and the primary-nav landmark label `aria-label="Primary"` at `:92`. S6 did not fix any of them on the edge and **did not copy any of them into the cloud's port** — T3's cloud `<nav>` uses a translated `dashboard:tabs.ariaLabel` key instead, covered by the new `dashboardLocales` deep-equality guard, so the cloud carries **no** exception here. Untranslated literals, edge-only, unassigned.
13. **The active tab's Agroscope-red specular ring is hardcoded, not tokenised.** `primitives.css:138-139` uses `rgba(227, 6, 19, 0.35)` and `rgba(227, 6, 19, 0.18)` where `#E30613` *is* `--brand-red` — so the one place the brand red is visible in normal rendering bypasses the token, while the reduced-transparency fallback nobody sees (`:153,165`) uses it. Not fixed: `primitives.css` is byte-mirrored and a substitution there changes the edge's rendered chrome, needing ratification for zero visible gain.
14. **`--brand-red` is used only inside `ui-core`'s own fallback CSS and preset, never by app page or component code on either side** — 5 occurrences each. The S6 brief's "defined and used ZERO times" is wrong; the accurate framing is this one.
15. **T9's scope was set by investigation, not by the brief.** Record what T9 Step 1 found, which subset the maintainer agreed to, and — if T9 closed as not-applicable — that reading 6 is why. **The brief's "the edge has zero 'not available' states and therefore violates its own spec" is wrong:** `AnalysisSeriesTray.tsx:55-56,135` plus `common.json:44` and `journal.json:324` already ship such states. What is genuinely cloud-shaped is the "on **this gateway**" framing, because a gateway GUI never asks a remote gateway what it supports.
16. **The cloud has no shared app shell.** `AppHeader` is mounted per page on both sides. A routed layout element (`<Route element={<Shell/>}><Outlet/>`) is the better React idiom and was **rejected for S6** (reading 4): it would restructure all 14 routes in a slice whose reviewable claim is "navigation now exists", and it has no edge counterpart, so it would open a new structural divergence while closing a visual one. Revisit if a fifth parity page appears.
17. **`historyUxEnabled` is a hardcoded `true` on the server, and the only `false` it can produce is an endpoint failure — so anything gated on it is a fail-closed NAVIGATION hazard, not a fail-closed authority.** `SystemFeatureController.java:24-32` returns `new SystemFeatureFlags(true, true, true, false, false, journalV2CloudIssuerEnabled)`; `historyUxEnabled` is the first positional field of the record (`:35-41`) and is not configurable. The `false` an earlier draft of this plan cited is the **frontend fallback**: `useFeatureFlags.ts:13` declares it in `defaultHistoryFeatureFlags`, and `:41` returns those defaults **only on SWR `error`**. Consequence, and the reason it is ledgered: a link conditioned on this flag vanishes exactly when `/api/v1/system/features` is broken, which is the moment a user most needs the rest of the app to keep working. T3 Step 0's resolution is option 1 (no flag on the Data tab) and T5 Step 3 dropped the flag condition from the zone-history link for the same reason. Also record the flag's live value on `agro-link.ch` **with the caveat that the deployed instance runs the older `AgroLink` branch**, so it is evidence about what the maintainer currently sees, not about this branch.
17b. **`SystemFeatureFlags` is a six-boolean positional record and is constructed positionally, so a reordering would silently swap flags.** `SystemFeatureController.java:24-32` passes `true, true, true, false, false, journalV2CloudIssuerEnabled` with no field names at the call site; the record's declaration (`:35-41`) is the only thing that says which `true` is `historyUxEnabled`. Add a field there, or move one, and every caller and every JSON consumer silently re-binds. **Not fixed: the backend is out of S6's scope in every task** (T11 Step 1 asserts zero `backend/` changes). Ledger only. Fix shape when someone does own it: named construction or a builder, plus a test that pins the JSON field order.
18. **The journal V1/V2 fork, from T1** — a pointer to the corrected rows, so the ledger and the rows do not disagree.
19. **The walkthrough-evidence caveat still stands**, reproduced verbatim: until the double-downlink defect and the MQTT-broker hardcode are both fixed and deployed, any `agrolink-test-01` walkthrough shows distorted online/telemetry state and doubled config downlinks, and evidence gathered before those fixes does not establish parity for the affected rows.

- [ ] **Step 4: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add docs/superpowers/plans/agrolink-gui-parity-matrix.md
git commit -m "docs: matrix S6 rows — the shell ships; nineteen findings ledgered"
```

---

### Task 11: Full cross-repo verification sweep

**Files:** none modified except a report.

- [ ] **Step 1: All four suites and both builds, fresh**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npm run test:unit:tsx-runner && npm run test:unit:vitest && npm run build
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npm run test:unit && npm run build
```

**The cloud backend is not run because S6 touches zero backend files** — confirm that claim rather than assuming it:
```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink && git diff --name-only d091af2f..HEAD -- backend/
```
Expected: empty. **If it is not empty, S6 has breached its own scope — STOP and report.** Only then may you skip the backend suite; if you do run it, use `./gradlew cleanTest test` from `backend/` and parse the XML (see Global Constraints), never trusting `BUILD SUCCESSFUL`.

- [ ] **Step 2: Assert the totals against the arithmetic**

| | baseline | + | expected |
|---|---|---|---|
| edge node-runner | 117 | T2 +2, T7 +7, T9 +N₉ₙ | **126 + N₉ₙ** |
| edge Vitest | 1690 | T2 +1, T8 +N₈, T9 +N₉ᵥ | **1691 + N₈ + N₉ᵥ** across 169+ files |
| cloud node-runner | 110 | T2 +1, T3 +3, T4 +3, T5 +2, T6 +3 | **122** |
| cloud Vitest | 697 | T2 +1, T3 +5, T5 +N₅ | **703 + N₅** across 116+ files |
| cloud backend | 1542 | 0 | **1542**, 0 failures (not re-run; Step 1 proves zero backend files changed) |

**N₅, N₈, N₉ₙ and N₉ᵥ are pinned by their own tasks, not by T11.** T5 must state its exact Vitest delta (the device-link component test), T8 its exact Vitest delta (whether `HistoryDashboard` qualifies for a notice), and T9 both of its deltas once its Step 1 scope is agreed. **A task that arrives here without having pinned its number has not finished, and T11 must report that as a process failure rather than back-fitting the total from whatever the runner printed.** That is the whole purpose of this table: S3's T12 was handed a wrong target, measured the real baseline, refused to force-fit and reported it — which is the correct behaviour.

A total **lower** than expected means a test was skipped or deleted — STOP and find it. A total **higher** than expected is not automatically fine either: name every extra test and why it exists. The one expected pre-existing skip is cloud backend `journal.v2.JournalScannerBridgeIT` (Testcontainers-gated), skipped at baseline; a second skip appearing anywhere is a finding.

- [ ] **Step 3: `ui-core` byte parity, both directions — the only vendor evidence S6 has**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
OSI_SERVER_ROOT=/home/phil/Repos/osi-server/.worktrees/agrolink sh scripts/verify-ui-core-vendor.sh
sh scripts/verify-ui-core-vendor.test.sh
cd /home/phil/Repos/osi-server/.worktrees/agrolink
EDGE_UI_CORE_ROOT=/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep sh scripts/verify-ui-core-vendor.sh
sh scripts/verify-ui-core-vendor.test.sh
diff -r /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui/src/ui-core \
        /home/phil/Repos/osi-server/.worktrees/agrolink/frontend/src/ui-core
```
Expected: `verify-ui-core-vendor: OK` from both directions and an empty `diff -r`. Each script needs a **different** env var. **Paste the output** — reading 2 established that neither CI gate fires on this branch, so this local run is the entire evidentiary basis for D2 in S6. Do not write "CI green" anywhere in the report.

- [ ] **Step 4: Every new guard is non-vacuous**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx tsx --test tests/dangerFgPairing.test.ts tests/dashboardLocales.test.ts \
                tests/chromeTokens.test.ts tests/routeReachability.test.ts tests/agrolinkBranding.test.ts \
                tests/noInertTokenAlpha.test.ts tests/errorTokenMisuse.test.ts tests/pageShellTokens.test.ts
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npx tsx --test tests/dangerFgPairing.test.ts tests/settingsReadSafe.test.ts \
                tests/readOnlyNoticeLocales.test.ts tests/uiCoreTokens.test.ts \
                tests/noInertTokenAlpha.test.ts tests/errorTokenMisuse.test.ts \
                tests/pageShellTokens.test.ts

# T9 is explicitly allowed to close as not-applicable (its Step 1), in which
# case capabilityStateLocales.test.ts does not exist and naming it makes
# `tsx --test` error out on a missing path — which would read as a failure of
# the whole sweep. So run it CONDITIONALLY, and report which branch you took.
[ -f tests/capabilityStateLocales.test.ts ] \
  && npx tsx --test tests/capabilityStateLocales.test.ts \
  || echo "capabilityStateLocales.test.ts absent — expected iff T9 closed as not-applicable; confirm against T9's record"
```
`tests/pageShellTokens.test.ts` is added to the edge list because it exists on **both** sides and the cloud half of this step already runs it — omitting the edge one was an asymmetry, not a decision.

Then confirm each task performed its mutation test and **paste the red output**, not a claim that it happened. The six new guards and their required red proof:

| Guard | Repo | Mutation that must produce red |
|---|---|---|
| `dangerFgPairing` | edge | `hover:text-[var(--error-text)]` deleted from the corrected `SystemPanel.tsx:236`, leaving `hover:bg-[var(--error-bg)]` — must go red naming the **`hover` variant**. Plus `bg-[var(--surface)]` added to a `DetailPanel.tsx` danger-text `<p>` — red on the **`base`** variant |
| `dangerFgPairing` | cloud | **tree scan vacuous by construction** — zero live sites; its red proof is the edge run, say so. The five table assertions are **not** vacuous and run here too |
| `dashboardLocales` | cloud | `tabs.data` deleted from `fr/dashboard.json` |
| `chromeTokens` | cloud | `bg-purple-600` restored in `AdminUsers.tsx` |
| `routeReachability` | cloud | a throwaway `<Route path="/zzz">` added to `App.tsx`. **Also confirm it was red on `/devices/:deviceEui` at T5 Step 1** — an unanchored needle makes this guard green at baseline for every real route, so the `/zzz` mutation alone does not prove it works |
| `settingsReadSafe` | edge | `/settings` re-wrapped in `WritableOnly`, restoring the import — **tests 1 and 2 must BOTH go red**. Plus `showSettings={canWrite}` restored on one page → test 3 red |
| `readOnlyNoticeLocales` | edge | `readOnly.farm` deleted from one locale |
| `capabilityStateLocales` | edge | one key deleted from `it/devices.json` — **only if T9 shipped**; if T9 closed as not-applicable, record that instead of a mutation |
| `uiCoreTokens` (`color-scheme`) | edge | the dark declaration deleted |

**A guard that has never been seen to fail is not a guard.**

- [ ] **Step 5: The ECharts code-split survived T5**

The single highest-risk, least-test-covered change in the plan: `App.tsx:13-15` lazy-loads `CrossZoneAnalysisPage` to keep ECharts out of the main bundle, and T5 wraps that route in `AnalysisRoute`. A static import there silently undoes the split and no test in the repo would notice.

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend && npm run build
```
Confirm from the build's chunk list that an ECharts/analysis chunk is still emitted separately and that the main chunk did not grow by its size. **Report the chunk names and sizes.** If T5 recorded before/after figures, compare them; if it did not, that is a T5 process failure to report here.

- [ ] **Step 6: Scope audit — no unintended change on either side**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git diff --name-only d2851111..HEAD
```
Expected exactly: the T2 ui-core + test + `SystemPanel` paths, the T7 and T8 page/component/locale/test paths, T9's agreed subset, `docs/superpowers/plans/agrolink-gui-parity-matrix.md`, and this plan document. **Anything else — any `flows.json`, any `conf/` path, any `osi-journal/*.js`, any migration, any seed DB, any `database/` path — is a scope breach: STOP and report.**

**This plan document is untracked at `d2851111` and will NOT appear in `git diff --name-only` unless committed.** Check and act:
```bash
git status --porcelain -- docs/superpowers/plans/2026-08-11-agrolink-gui-parity-s6-shell.md
```
`??` means untracked — commit it at the start of T1 or the end of T10, and only then does the expected list include it. If it is still untracked at T11, the expected list is one path shorter and the plan document must be **reported as uncommitted**, not quietly omitted.

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git diff --name-only d091af2f..HEAD
```
Expected: only paths in the T2–T6 file map, all under `frontend/`. **Zero `backend/` paths** (Step 1 already asserted this — the two must agree).

Both baselines had **one unpushed commit** at planning time. If those were pushed before T1, the diff ranges above are still correct; if not, re-derive them from the real pre-T1 head and say which head you used.

- [ ] **Step 7: Push — edge first, then cloud, to `feat/journal-cloud-primary`**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git status -sb && git log --oneline d2851111..HEAD
git push origin HEAD:feat/journal-cloud-primary

cd /home/phil/Repos/osi-server/.worktrees/agrolink
git status -sb && git log --oneline d091af2f..HEAD
git push origin HEAD:feat/journal-cloud-primary
```

**Never `HEAD:AgroLink`.** `AgroLink` is the deployed rollback point and is 15/23 commits behind these heads; pushing there would put unreviewed work on the live deploy branch. The S4 plan's equivalent step says `AgroLink` and is wrong for this branch model.

Confirm both remotes advanced. **Do not expect a CI run to gate anything** — reading 2: the ui-core and backend workflows do not trigger on this branch. Say so in the report rather than leaving a reader to assume CI vouched for the vendor parity.

- [ ] **Step 8: Write the report**

Root cause per fix, deliberate tradeoffs, every measured number, and the full list of items ledgered rather than fixed. Include, explicitly:
- the gates and how each was closed. **Two were answered before execution started and must not be re-opened:** T3 Step 0 (`historyUxEnabled` — the premise was wrong, the flag is a hardcoded `true`, so option 1 stands) and T6 Step 0(i) (two marks — the product owner said "copy the edge", i.e. option 1). What remains is **derivation and investigation, not ratification:** T6 Step 0(ii)'s 624 constant (show the arithmetic), T6's one confirming sentence about the licensed-asset copy, and T9 Step 1's candidate-site table, which is the only genuine open question left and may legitimately close T9 as not-applicable. Report the `agro-link.ch` flag value with its caveat: the deployed instance runs the older `AgroLink` branch, so it says what the maintainer currently sees, not what this branch does;
- **the three blocking defects this plan carried before revision, because they are the reusable lesson:** a guard whose own task's fix trips it (`dangerFgPairing`, fixed by making it variant-aware), a guard born green and blind to the exact routes the slice exists to fix (`routeReachability`, fixed by anchoring the needle to a string delimiter), and two tests that passed at baseline because they sliced on a `</Route>` that does not exist in a self-closing-route file (`settingsReadSafe` 1-2, replaced with whole-file assertions). All three shared one shape: **a check that could not fail, presented as a check that had.**;
- **every claim in the S6 brief that turned out to be wrong**, with the evidence, so the next brief is written from corrected facts (readings 3, 5, 6, 7, 8, 9, 10, 16, 17 are the starting list — add any the tasks found);
- what S6 does **not** close: the CI-ref pin, the theme-blind component sweep, the six history visualizations, `lg` human-native translation, S5, and S4b.

The report is the PR body.

---

## Deferred, with the rationale

**S4b — history drill-down (~35 files).** Unchanged from the S4 plan's carve-out: no `HistoryCardDetailPage` on the cloud at all (edge: 851 lines), two unregistered card-detail routes, six of eleven visualizations missing plus `chartAxis.ts`, the edge-only `components/history/{desktop,mobile}/` subtrees, eleven edge-only history model modules, `sourceKey` absent end to end, `HistorySeries.depthCm` deleted, and zero cloud tests for any visualization. The maintainer has ruled that when it happens it copies the edge's separate-route approach. **S6 deliberately touches none of it** — T5 makes `/history/zones/:zoneId` reachable from desktop, which is a *reachability* fix to an existing route, not depth. Two of S6's changes do make S4b easier: the route gate now lives in `AnalysisRoute.tsx` where the edge keeps it, and the tab pill gives any new history route a place to be reached from.

**The theme-blind component sweep (~400 hardcoded palette instances).** Out of scope, and **there is one prior attempt to review, not two** (reading 16): `theme/deepseek-migration` `d646fc89` (48 files, 365/365). `theme/kimi-migration` carries no migration. T4 closes the **chrome** subset — 9 sites across 7 files — and its `chromeTokens.test.ts` fences exactly those files by name, so the sweep inherits a smaller surface and a guard that will not fight it.

**`lg` human-native translation.** Every `lg` string S6 adds is a machine draft pending the human-native gate, marked as such. This remains the Uganda ship gate and it is a translation task, not a GUI task. **S6 makes it materially more urgent and that is the point:** before T7, an authenticated desktop read-only viewer could not reach the language switcher at all, so the quality of the `lg` strings was moot for that user. Now they can select Luganda, so what they get matters.

**S5 — scoped-access administration.** Unchanged. The edge grant-list route still does not exist and both admin surfaces still need it. S6 touches admin pages only to remove their colour identity (T4) and add one menu item (T5); it changes no authorization, and it deliberately leaves the `<AdminRoute>` vs `<AdminRoute superAdminOnly>` asymmetry alone (ledger item 9).

**Super-admin actuation confirmation + audit.** Decided but belongs with the actuation surface, not the shell.

**The `backend-ci.yml` ref pin.** Ledger item 1, and the only deferred item that will actively fail something: the moment this branch is proposed for merge, the ui-core vendor gate compares against a stale canonical. Deferred because repointing a ref used by three gates across two repos is release engineering, not a GUI slice — but it is dated and located so it cannot surprise anyone at merge time.

**A routed layout element for the cloud shell.** Reading 4. The better React idiom, rejected for S6 because it would restructure all 14 routes in a slice whose reviewable claim is "navigation now exists", and because it has no edge counterpart. Revisit if a fifth parity page appears.

**Completing S6 does not close the parity program.** It closes the gap between "four slices shipped" and "a user can find them", which is the specific thing the maintainer's *"It looks like the very beginning"* was reporting. The walkthrough that every matrix row depends on has still never happened, and it remains the gate on every `parity` claim in this program.
