# AgroLink GUI Parity — Slice S3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cloud's thin free-text `JournalPage` with real v10 field-journal capture: the Agroscope catalog reaches the cloud as a vendored, CI-gated artifact; the gateway's own catalog version becomes the D4 capability gate; the catalog-driven entry form ships with its operation chip, operation-scoped fields/requirements, operation-narrowed product picker and the denominator gate intact; a workspace (scope rail + entry table + detail panel) replaces the `<ol>`; correction and create-only copy-an-entry land; and every cloud page finally paints the same token background the edge pages do.

**Architecture:** The cloud journal *transport* is already complete and correct — `JournalController` exposes list/upsert/void/export per resource kind, `JournalAccessService` enforces owner-plus-grant scope with the C9 PLOT_GROUP-ownership rule, `JournalMutationService` never writes journal rows directly but enqueues versioned `UPSERT_JOURNAL_ENTRY` / `VOID_JOURNAL_ENTRY` commands through `DesiredStateService`, and four `SyncEventApplier`s mirror the edge's aggregates into `journal_{entries,plots,plot_groups,vocab}_mirror`. What is missing is everything *above* the transport: the cloud has no activity catalog at all (verified — see reading 1), so `frontend/src/journal/builders.ts:35` hardcodes `template_code: 'cloud.quick'`, `layout_code: 'quick'`, `catalog_version: 10` and ships `values: []`, which the edge accepts without validating because its template/layout-driven checks are all guarded on the definition rows existing (reading 3). S3 closes that gap by vendoring the catalog data from osi-os (the governance the repo already trusts for the sync contract and ui-core), reading the catalog version the edge *already advertises and the cloud already throws away* (reading 2), and copy-adapting the edge's catalog resolver, template engine and entry form (D1) so the cloud renders the same v10 semantics from the same data.

**Tech Stack:** React 18, TypeScript, Tailwind v3.4 (cloud, `presets`), Vite 5, Vitest + `tsx --test` runners, SWR 2, Spring Boot 3 + JUnit 5/Mockito + Flyway (cloud backend), Node 22 + `sqlite3` CLI + POSIX `sh` (edge tooling and vendor verifiers).

**Working directories (both checkouts are on branch `AgroLink`):**
- Edge (canonical): `/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep`. GUI at `web/react-gui/`, journal module at `conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-journal/`. S3 modifies `scripts/`, `docs/`, `.github/workflows/field-journal.yml` and adds `.github/workflows/journal-catalog.yml` here; it modifies **no** edge runtime file (no `flows.json`, no `osi-journal/*.js`, no `web/react-gui/src/**`).
- Cloud (vendored): `/home/phil/Repos/osi-server/.worktrees/agrolink`. GUI at `frontend/`, backend at `backend/`.
- Never touch `/home/phil/Repos/osi-server/.worktrees/terra-rehaul-*` or `/home/phil/Repos/osi-os/.worktrees/firmware-image-builder`.

## Global Constraints

Copied from `docs/superpowers/specs/2026-08-04-agrolink-gui-parity-design.md` and the standing S1/S2 constraints; every task's requirements implicitly include these.

- S3 scope row: "Field journal full capture — v10 catalog, operation-level scoping, copy-an-entry, denominator gate; replaces the current thin `JournalPage`." History and analysis are **S4**; scoped-access administration is **S5**. S3 touches neither.
- "The edge stays canonical for farm state. Every cloud mutation rides the existing versioned-command and sync layer; **this program adds no new sync surface**." S3 adds no sync event, no command type and no aggregate type: capture rides the existing `UPSERT_JOURNAL_ENTRY` / `VOID_JOURNAL_ENTRY` commands, and the catalog reaches the cloud as a vendored build artifact, never as a sync payload (reading 1).
- `ui-core` is a **closed 8-primitive set** (`Banner`, `Button`, `Chip`, `EmptyState`, `FormField`+`INPUT_CLASS`, `Modal`, `Surface`, `TableShell`). S3 adds **zero** new primitives. "A primitive is admitted to `ui-core` only when both GUIs use it; single-sided components stay local."
- "`ui-core` canonical in osi-os, byte-mirrored to osi-server, CI-gated both sides" (D2). Canonical-first with **same-task re-vendor**: if a task needs a ui-core change it lands in osi-os and is re-vendored to osi-server *in that same task*, never split across tasks, and **both** byte-parity verifiers (`scripts/verify-ui-core-vendor.sh` in each repo) must stay green. The same rule now governs the journal catalog artifact (T2/T3).
- "This program works on the `AgroLink` branches only and does not modify Terra files; if a slice needs a file Terra also touches, the slice waits." No `terra-intelligence` path, no Terra composition root.
- "all GUI-parity work lands on the same pair of `AgroLink` branches, keeping the deploy-from-branch model intact." Both branches are `AgroLink`.
- D3: "Gateway context, not gateway chrome: one linked gateway means no selector anywhere; multiple linked gateways are switched on the Settings page."
- D4: "Capability-gated rendering — A page renders only what the selected gateway's capability handshake advertises; older gateways get an explicit 'not available on this gateway' state, never a broken page."
- D5: "Fail-closed scope UX ported from edge — the cloud pages adopt the edge `ScopeContext` pattern (deny-while-loading, closed scope on profile-fetch failure) mapped to the cloud's 403-on-dormant convention."
- D7: "Cohesion beats replication … Token and primitive parity (ui-core) still binds; the freedom is at page composition level."
- **7-locale key-set equality** (`en`, `de-CH`, `fr`, `it`, `es`, `pt`, `lg`) for every string S3 introduces, with `lg` flagged machine-draft pending the human-native gate. No new untranslated literal may enter a component S3 writes.
- **Every changed foreground/background pair states its contrast ratio in BOTH themes.** Reference ratios computed from `ui-core/tokens.css` at this head: `--text` on `--bg` 16.48 light / 17.21 dark; `--text` on `--card` 17.85 / 14.28; `--text` on `--surface` 15.16 / 15.85; `--text-secondary` on `--bg` 9.56 / 11.30; `--text-secondary` on `--card` 10.35 / 9.38; `--text-tertiary` on `--card` 4.76 / 5.65; `--text-tertiary` on `--bg` **4.39 / 6.80 — fails AA in light, so `--text-tertiary` is card-only**; `--primary` on `--card` 5.17 / 8.28; `--error-text` on `--error-bg` 8.20 / 8.20; `--warn-text` on `--warn-bg` 6.37 / 11.02; `--success-text` on `--success-bg` 8.30 / 11.35; `--header-text` on `--header-bg` 20.50 / 15.85.
- **Tailwind v3.4 cannot alpha-modify `var()` colors.** `bg-[var(--X)]/40` emits nothing. Use `bg-[color-mix(in_srgb,var(--X)_40%,transparent)]`. The existing `frontend/tests/noInertTokenAlpha.test.ts` guard fences the inert form; it must stay green.
- **Background tokens must never appear in `text-` / `placeholder-` / `caret-` / `decoration-` / `fill-` / `stroke-` utilities** (`frontend/tests/errorTokenMisuse.test.ts`, second guard). A `*-bg` token is a pale wash; foregrounds use the paired `-text`/`-fg` token.
- **Fail-closed props are required, not defaulted.** Where S2 made `readOnly` a REQUIRED device-card prop (tsc-enforced via `npm run build`), S3 applies the same discipline to the journal write surface: `canWrite` / `readOnly` on every journal component S3 writes is a required prop with no default, so an unthreaded mount is a build error.
- **Ownership is ALWAYS `isDeviceOwner`-style identity comparison, NEVER `gatewayRole == null`.** That trap cost two review rounds in S2. S3 introduces **no** ownership-gated affordance: the journal write surface it builds (capture, correct, copy, void) is gated by role plus capability plus catalog verdict only (reading 14), and plot-group mutation — the one journal path the backend guards with the C9 `owner_user_uuid` rule — lives in `JournalReferencePanel`, which S3 does not touch. Should a later slice surface that rule, the test is `canonical.owner_user_uuid === activeGateway.localUserUuid`, never a role-shaped inference. Every `gatewayRole === 'viewer'` check S3 writes is a role test by design and is not covered by this rule.
- **Every task states its expected suite delta, and T12 asserts the total.** A task that adds tests names how many node-runner tests and how many Vitest tests it adds, so a silently-skipped spec shows up as a wrong count rather than as a green run. T12 Step 6 adds the per-task numbers to the 2026-08-05 baselines and expects the sum.
- Matrix rule: rows may flip toward `parity` "only after a real side-by-side walkthrough against the edge GUI running on `agrolink-test-01`". This plan runs no walkthrough, so every row it touches ends at `partial (pending walkthrough)` with a dated provenance line.
- Suite baselines re-verified green on this machine 2026-08-05, at heads edge `e910c01f` (= `719b5e4e` plus the two edge fixes `6d63c15f` double-downlink and `e910c01f` MQTT broker hardcode) and cloud `65441f5f`: **edge** `web/react-gui` 107 node-runner tests + 1,689 Vitest across 169 files; **cloud** `frontend` 70 node-runner tests + 431 Vitest across 98 files. Counts grow during S3 — the only decrease anywhere is T9's single deleted `buildNewEntry` case — and every task states its own delta, with T12 Step 6 asserting the total (**96** node-runner, **542** Vitest across **109** files). The final task runs both builds and every vendor verifier and self-test on both sides.
- **The vendored catalog artifact is test-only data and never enters `src/`.** At runtime the cloud GUI reads its catalog from `GET /api/v1/journal/gateways/{eui}/catalog` (T5), served from the backend's own classpath resource. Every spec that reads the artifact file is therefore a node-runner test under `frontend/tests/` — which `tsconfig.json`'s `include: ["src"]` never typechecks, so `node:fs` needs no `@types/node` and the ~433 KB never touches `tsc` or the browser bundle. DOM specs stay Vitest tests under `src/` and use small hand-built catalog fixtures. T6 Step 6c enforces this with a guard test.

Plan-level readings of the spec, applied throughout (each states an ambiguity and its resolution):

1. **The cloud has no v10 catalog — none at all — so S3 must plumb the catalog data, not just the UI. It is vendored, not synced.** Verified on cloud head `65441f5f`: no catalog table (the only journal migration, `V2026_07_23_002__journal_mirrors.sql`, creates four mirror tables and nothing else), no catalog entity, no catalog endpoint, no vendored JSON, and `journal_vocab_mirror` holds only *user-created custom* terms (`code` is server-forced to `"custom." + uuid`, `scope = "custom"`). Every `catalog*` hit in the cloud tree belongs to the prediction or analysis catalogs. Three plumbing options were considered. (a) A new `JOURNAL_CATALOG_*` sync aggregate — **rejected**: the spec forbids new sync surface, and the catalog is build-time data, not farm state. (b) A Flyway seed — **rejected**: it would fork the catalog into a second source of truth updated by hand, exactly the drift the row-content gate exists to prevent. (c) **Chosen: a generated JSON artifact, canonical in osi-os at `docs/contracts/journal-catalog/journal-catalog.json`, byte-vendored into osi-server at `backend/src/main/resources/journal-catalog/journal-catalog.json`, with a verifier plus a self-test on each side and a CI job in each repo** — the governance already used for ui-core (`verify-ui-core-vendor.sh` + `verify-ui-core-vendor.test.sh`, run by the edge's dedicated `.github/workflows/ui-core.yml` and the cloud's `backend-ci.yml`) and for the sync contract (`verify-edge-sync-contract-vendor.sh`). Concretely, what S3 builds is: a new edge workflow `.github/workflows/journal-catalog.yml` triggered on the `AgroLink` branch, modelled line-for-line on `ui-core.yml` (same `.vendor/osi-server` checkout, same `OSI_SERVER_RO_TOKEN`, same prefer-matching-branch step), running the exporter's `--check`, the exporter's unit test and both edge vendor scripts (T2 Step 5); plus the same two exporter steps bolted onto `field-journal.yml` so a `main`/`master` merge cannot land a stale artifact either (T2 Step 6); plus a `Reject a stale vendored journal catalog` step in the cloud's `backend-ci.yml` (T3 Step 4). Naming the workflows matters: `field-journal.yml` triggers only on `branches: [main, master]`, which this program never pushes to, so it alone would gate nothing during S3.

  The artifact is exported *from the shipped `database/farming.db`* using the same queries, the same DTO shape **and the same JS sort comparators** the edge serves at `GET /api/journal/catalog?include=definitions` (`osi-journal/catalog.js:127-137` + `api.js:360-414`), so the vendored bytes are the same rows in the same DTO shape and the same order. Verified: SQLite's BINARY `ORDER BY code` and `catalogDto`'s `code.localeCompare(code)` **disagree** on the vocab list (BINARY sorts `unit.m2_area` before `unit.m_per_s`, `localeCompare` the reverse), so the exporter re-sorts in JS rather than trusting the SQL order, and `scripts/test-export-journal-catalog.js` asserts the ordering (T2 Steps 1-2). Templates, layouts, products and mappings agree in both orders; the vocab list is the only one that would have drifted.

  What the artifact is **not**: it is the **global (non-principal) subset** of what a gateway answers, not the whole answer. The edge's `loadCatalog(db, principal)` unions the core rows with the caller's `scope='custom'` vocab and `scope='farm'` products (`catalog.js:206-270`); the artifact carries only the `scope='core'` half, because a shared build-time file cannot carry per-principal rows. The consequence is a real deviation, recorded in reading 6. That the artifact derives from the shipped DB also means the existing row-content gate (`scripts/test-journal-schema.js`, which pins all seven bundled DBs column-by-column) transitively pins the artifact's content.
2. **The gateway's catalog version already reaches the cloud and is discarded; S3 keeps it and makes it the D4 gate.** The edge bootstrap payload already carries `journal_catalog_version`, `journal_catalog_hash` and `journal_manifest` alongside `syncCapabilities` (built by `loadJournalBootstrapAdvertisement()` in `flows.json`, both profile mirrors). The cloud's `EdgeSyncService.GatewayIdentity` record declares only `previousGatewayDeviceEuis`, `edgeBuildVersion`, `syncCapabilities`, `installationUuid`, `recoveryState`, `recoveryOperationUuid`, so Jackson drops the journal fields on the floor. T4 adds them to the record and persists them on `linked_gateway_accounts`; T5 compares them against the vendored artifact. **This requires no edge change and adds no capability string.** The gate is fail-closed: `compatible` only when the gateway's advertised version *and* hash both equal the vendored artifact's; `gateway_catalog_unknown` (never bootstrapped, or an older edge that predates the advertisement) and `gateway_catalog_mismatch` both render the D4 "not available on this gateway" state and disable capture while leaving reads working.
3. **Today's cloud-created entries are catalog orphans; S3 stops making them and does not retro-fix the existing ones.** `builders.ts` sends `template_code: 'cloud.quick'`/`template_version: 1` and `layout_code: 'quick'`/`layout_version: 1`. No such rows exist in any bundled `farming.db` (`grep -r "cloud.quick"` over the whole edge repo: zero hits). On apply, `lifecycle.validationDefinitions` looks both up by `(code, version)`, gets `null` for each, and `index.js validateEntry` skips every definition-driven check because they are all guarded on `_templateDef &&` / `_layoutDef &&` (`index.js:556-578`) — so the entry is stored **unvalidated**, and the edge GUI then cannot resolve its template/layout, which disables Correct and Copy on it in `DetailPanel`. S3's payload builder uses the plot's real layout and the catalog's real `full_record@10`. Rewriting the already-mirrored orphan rows would mean issuing corrections against entries whose stored template does not exist — out of scope, recorded in the matrix ledger as a data-repair follow-up.
4. **Layout comes from the plot; template comes from the layout.** Reproduced exactly from `JournalCaptureFlow.tsx:817-819, 986-996`: `layoutCode = plot.settings.layout_code`; the candidate templates are `layout.supported_templates` resolved through the catalog model and ordered `farmer_quick`, `full_record`, `research_observation`; the cloud pins `full_record` when the layout supports it and otherwise takes the first supported template. The cloud can do this because the mirrored plot aggregate carries `settings.layout_code` (required by the `JournalPlotSettings` contract schema and by `JournalMirrorService`'s "plot requires a settings object" check).
5. **Catalog DATA is byte-vendored; catalog LOGIC is copy-adapted (D1), and neither becomes a ninth ui-core primitive.** `catalogModel.ts` (1,071 lines), `templateEngine.ts` (374), `types/journal.ts` (384) and `types/journalCapture.ts` (207) are pure TypeScript with no React dependency and no edge-only imports, so they are copied **byte-identically** and pinned by a sha256 provenance test (`frontend/tests/journalCoreProvenance.test.ts`) plus a cross-repo `diff` in T12. The React components (`EntryForm`, `NutrientRepeater`, `NumberStepper`, `ActivityPicker`) are copy-adapted under D1/D7: logic untouched, import paths and color utilities changed, with the edge's own component tests copied alongside so a logic edit fails loudly. Extracting any of this into ui-core is explicitly out of scope — the spec caps ui-core at eight primitives and admits nothing that is not used by both GUIs as a *primitive*.
6. **Cloud capture is single-plot, final-only, no crop cycles, core products only — by construction, not by omission.** Drafts never reach the cloud: the edge's bootstrap advertisement selects `status IN ('final','voided')` and `JournalMutationService.applyKindIdentity` forces `status = "final"`, so a cloud drafts queue would have nothing to show and no way to write. Crop cycles (`journal_crop_cycles`, `journal_crop_cycle_plots`) and farm-scoped products (`journal_products WHERE scope='farm'`) have no mirror table and no sync event, so the cloud cannot disambiguate a cycle or offer a farm product. Batch/pass capture has no cloud command. Therefore: cloud capture writes one entry for one plot; the product picker offers `scope='core'` products only; and the **cycle-opening and cycle-closing activities are excluded from cloud capture with an explicit, translated refusal**, mirroring the edge's own `copyBlockedForActivity` precedent in `DetailPanel.tsx:75`, which blocks copy for exactly `SEEDING_ACTIVITY_CODES ∪ {'harvest'}` because the copy form has no cycle UI. Verified at `web/react-gui/src/journal/cropCycle.ts:30-32`, that set is exactly **`{'seeding', 'planting_transplanting', 'harvest'}`** — three codes, all present in the shipped catalog as `kind='activity'` vocab. The neighbouring `MANUAL_CLOSE_ACTIVITY_CODES = {'tillage_soil_work', 'mowing', 'plant_protection_application'}` is **NOT** part of the edge's block and must **not** be blocked on the cloud: those are three of the highest-frequency activities on the whole catalog, and excluding them would gut cloud capture for no reason the edge shares. Blocking exactly the edge's set, no more, is a hard requirement of T6 Step 5 and is pinned by a test there.

A fourth deviation the earlier draft missed: **custom vocab and farm products are invisible to cloud capture.** The vendored artifact carries `scope='core'` rows only (reading 1), while the edge merges the principal's `scope='custom'` vocab and `scope='farm'` products into every catalog it serves. The cloud already mirrors custom vocab in `journal_vocab_mirror` **and lets users create it** in `JournalReferencePanel`, so a cloud user can create a custom term on Monday and not find it in Tuesday's capture form. Closing this needs a principal-scoped merge on the cloud read path (the mirror has the rows; the artifact is the wrong carrier for them) — out of S3's scope, recorded in the matrix and the ledger, not silently accepted.

Every one of these is a matrix deviation, not a silent gap.
7. **The denominator gate is client-side, so porting the engine ports the gate.** Two things share the name. `layout.denominator_contract` is a validated-but-inert `string[]` (`catalogModel.ts:723-753` rejects a malformed layout wholesale; nothing reads the parsed value, on either side). The real gate is `templateEngine.ts:274-283` with `collectOperationScopedFieldCodes` at `:100-121`: a `layout.minimum_fields` entry that is *also* in `static_context_fields` *and* appears anywhere in the template's operation-scoping sets is not force-added, which is what stops `attr.denominator` appearing on tillage and weeding. `grep -n denominator` over the edge's `osi-journal/*.js` returns zero non-test hits — the edge backend does not resolve it. T6 copies the engine verbatim and T6 Step 6 pins the gate with a dedicated test against the vendored catalog.
8. **The operation chip ports as data, not as a special case.** `OPERATION_CONFIRMED_CHOICE_CODES = ['attr.agroscope.operation']` (`catalogModel.ts:25`) drives `EntryForm`'s read-only chip + "Change" affordance for any confirmed choice that already holds a value. The cloud passes the same constant, so the chip appears for the same field for the same reason.
9. **Catalog i18n is explicitly DEFERRED by S3; S3 ships the resolution path and the chrome translations only.** Verified: every `labels_json` in the shipped catalog is English-only (`grep -c '"de-CH"\|"fr"' `over `0019__journal_catalog_v1.sql` and `0032__journal_catalog_v10.sql` returns 0; v10's template row reads `'{"en":"Full record"}'` and nothing else). Both GUIs already resolve `catalogLabel(row, locale) = row.labels?.[locale] ?? row.labels?.en ?? row.code`, so translating the catalog is a **data change in `scripts/journal-catalog-core.js` plus a new catalog version** — an edge program task with a migration, a hash change and a row-content-gate update, not a cloud GUI task. Doing it inside S3 would put the whole GUI slice behind a catalog version bump. S3 therefore: (a) ships the locale-resolving path so translated labels light up the moment they exist, in both GUIs, with no code change; (b) translates **all** journal chrome strings it introduces into 7 locales; (c) records catalog i18n — with `lg` as the Uganda ship gate — as an open ledger item naming the exact file and mechanism. Anyone reading the matrix sees a dated, located follow-up, not a silence.
10. **The cloud journal page's in-page gateway `<select>` violates D3 and is removed.** `JournalPage.tsx:262-275` renders a gateway dropdown in page chrome. D3 is unambiguous: one linked gateway means no selector anywhere, several are switched on Settings. T9 deletes it and consumes `useGateway()`, the same way S1/S2 rewired zones and devices.
11. **Page-shell cohesion (maintainer finding, folded in as T1). The cream is a one-off, not a motif.** Verified: `#f4f1e8` occurs exactly once in the entire cloud tree, at `JournalPage.tsx:218`, and nowhere in `src/components`, `src/ui-core` or any locale/CSS file — there is no paper motif to preserve, so flattening to `bg-[var(--bg)]` deletes no design intent. Three page roots disagree with the other twelve and with the edge (where `FarmingDashboard`, `JournalPage`, `HistoryDashboard`, `SettingsPage`, `AccountLink`, `SupportRequests`, `HistoryCardDetailPage` are all `min-h-screen … bg-[var(--bg)]`): `JournalPage.tsx:218` `bg-[#f4f1e8] text-slate-950`, `HistoryDashboard.tsx:144` `bg-slate-100`, `CrossZoneAnalysisPage.tsx:160` `bg-slate-100 text-slate-950`. One correction to the brief: `CrossZoneAnalysisPage` *does* have a shell — `flex h-screen flex-col`, not `min-h-screen`, and the `h-screen` is load-bearing for its internal `min-h-0` scroll panes, so T1 changes its **colors only** and leaves `h-screen` alone. History/analysis pages belong to S4, but the fix is one class each and splitting it would leave the app visibly inconsistent between slices, so S3 owns the whole sweep. A new node guard test pins the invariant in the `noInertTokenAlpha`/`errorTokenMisuse` idiom.
12. **Recorded, NOT fixed by S3: the edge header's own sizing inconsistency.** Edge nav tabs are `glass-tab px-5 py-2 text-[15px]` while Settings/Account use `LIQUID_SIZING = px-3 py-2.5 text-base sm:px-6 sm:py-3 sm:text-lg` (18px desktop), so primary navigation reads as less important than secondary chrome. That is assigned to the dedicated frontend-designer review that runs after S3's code is complete; S3 must not touch it, and no S3 task may treat the edge header as a parity target.
13. **Entry list filtering and pagination are client-side in S3.** The cloud list endpoint takes only `includeDeleted`; the edge's is a filter-bound opaque cursor. Adding server-side filters would mean re-deriving the edge's cursor semantics on a Postgres mirror — S4 territory, where history depth and CSV live. Today's page already fetches every entry with no paging, so client-side filtering and a 50-row client pager regress nothing and match the edge's `PAGE_SIZE = 50`. Recorded as a deviation with an S4 pointer, not hidden.
14. **Journal write authority is a three-way conjunction, evaluated fail-closed.** `canWriteJournal(gatewayScope, catalogState)` is true only when: the gateway context is resolved (`!loading && error === null`), the active gateway's `gatewayRole !== 'viewer'`, `fieldJournalSupported === true`, and the catalog compatibility verdict is `compatible`. Zero-linked-gateway accounts are **denied** here — unlike zones and devices, a journal entry has no cloud-local form (every write is an edge command), so "cloud-local stays writable" does not transfer. That conjunction is the whole of `journalCapability.ts`: it carries **no ownership logic**, because none of the four surfaces S3 builds (capture, correct, copy, void) is owner-gated on the backend. The one journal path that is — plot-group mutation, guarded by the backend's C9 `owner_user_uuid` rule — lives in `JournalReferencePanel`, which S3 leaves untouched; the ledger already records that the panel does not surface that rule until the request fails (T11 Step 4).

## Reference: what exists on each side today (verified 2026-08-05)

Cloud backend, `backend/src/main/java/org/osi/server/journal/`:

| Class | Role | S3 changes |
|---|---|---|
| `JournalController` (336 l) | `/api/v1/journal/gateways/{eui}/{entries,custom-vocab,plots,plot-groups}` list + upsert + `/entries/{uuid}/void` + `export.{json,csv}` | T5 adds `GET …/catalog` |
| `JournalAccessService` (219 l) | `require(user, eui, mutation)` → `GatewayScope`; VIEWER read-only; 409 when `field_journal_v1` is unadvertised; owner-plus-grant visibility; C9 PLOT_GROUP ownership | T5 reuses `require(..., false)` |
| `JournalQueryService` (268 l) | scope-filtered JDBC reads over the four mirrors, with plot-group member redaction | unchanged |
| `JournalMutationService` (280 l) | canonical merge, `effect_key = <prefix>:<uuid>:<baseVersion>`, forces `status='final'`, author identity | unchanged |
| `JournalMirrorService` + 4 appliers | sync ingest into the mirror tables | unchanged |
| `JournalExportService` (96 l) | JSON/CSV export | unchanged |

Cloud frontend today: `pages/JournalPage.tsx` (469 l — bespoke green header, cream body, in-page gateway `<select>`, an `<ol>` with no filters/sort/paging, a 3-field editor `activityCode`/`plotUuid`/`note`, `window.prompt` void, CSV/JSON export buttons), `components/journal/JournalReferencePanel.tsx` (243 l, plots/groups/custom-vocab creation), `journal/builders.ts` (173 l), `types/journal.ts` (33 l, index-signature `JournalCanonical`), `journal/__tests__/{builders,journalLocales}.test.ts`, `pages/__tests__/JournalPage.test.tsx` (207 l), `services/__tests__/api.journal.test.ts` (136 l), and a `journal` locale namespace with 47 top-level keys × 7 locales.

Edge capture surface S3 draws from (all under `web/react-gui/src/`):

| Edge file | Lines | Fate on cloud |
|---|---|---|
| `types/journal.ts` | 384 | byte-copy (T6) |
| `types/journalCapture.ts` | 207 | byte-copy (T6) |
| `journal/catalogModel.ts` | 1071 | byte-copy (T6) |
| `journal/templateEngine.ts` | 374 | byte-copy (T6) |
| `journal/__tests__/templateEngine.test.ts` | 487 | byte-copy (T6) |
| `journal/__tests__/catalogModel.test.ts` | 1629 | **not copyable** — imports `scripts/journal-catalog-core.js`, `scripts/generate-journal-catalog.js` and the Agroscope source JSON from the edge repo root; T6 writes a cloud test against the vendored artifact instead |
| `components/journal/capture/EntryForm.tsx` | 1064 | copy-adapt (T7) |
| `components/journal/capture/NutrientRepeater.tsx` | 241 | copy-adapt (T7) |
| `components/journal/capture/NumberStepper.tsx` | 233 | copy-adapt (T7) |
| `components/journal/capture/ActivityPicker.tsx` | 427 | copy-adapt (T8) |
| `components/journal/capture/JournalCaptureFlow.tsx` | 2905 | **not ported** — its bulk is crop cycles, tank-mix passes, batches, carry-forward, layout transitions and drafts, none of which the cloud can express (reading 6). T8 writes a reduced cloud modal over the same `EntryForm`. |
| `components/journal/desktop/{ScopeRail,EntryTable,DetailPanel}.tsx` | 331 / 492 / 1117 | copy-adapt, reduced (T9/T10) |

Edge journal endpoints the cloud has no counterpart for, and why that is fine: `/api/journal/custom-vocab` (cloud has `POST/PUT …/custom-vocab` already), `/api/journal/export.adapt.json` (edge answers 501), plot/plot-group CRUD (cloud has them).

## File map

| File | Repo / area | Task |
|---|---|---|
| `frontend/src/pages/{JournalPage,HistoryDashboard,CrossZoneAnalysisPage}.tsx`, `frontend/tests/pageShellTokens.test.ts` | osi-server frontend | T1 |
| `scripts/export-journal-catalog.js`, `scripts/test-export-journal-catalog.js`, `scripts/verify-journal-catalog-vendor.{sh,test.sh}`, `docs/contracts/journal-catalog/{journal-catalog.json,README.md}`, `.github/workflows/journal-catalog.yml` (new), `.github/workflows/field-journal.yml` | osi-os | T2 |
| `backend/src/main/resources/journal-catalog/journal-catalog.json`, `scripts/verify-journal-catalog-vendor.{sh,test.sh}`, `.github/workflows/backend-ci.yml` | osi-server | T3 |
| `backend/src/main/resources/db/migration/V2026_08_05_001__journal_catalog_advertisement.sql`, `user/{LinkedGatewayAccount,LinkedGatewayAccountService,LinkedGatewaySyncService}.java`, `sync/EdgeSyncService.java`, `frontend/src/types/farming.ts`, backend tests | osi-server | T4 |
| `backend/src/main/java/org/osi/server/journal/{JournalCatalogService,JournalController,JournalAccessService}.java`, `.../scopedaccess/{GatewayScope,GatewayScopeService}.java`, `JournalCatalogServiceTest.java`, `JournalControllerTest.java` + five fixture-arity test classes (T5 Step 4c) | osi-server backend | T5 |
| `frontend/src/types/{journal,journalCapture,journalMirror}.ts`, `frontend/src/journal/{catalogModel,templateEngine,useJournalCatalog,journalCapability}.ts`, `frontend/src/services/api.ts`, `frontend/tests/helpers/vendoredCatalog.ts`, `frontend/tests/journal{CoreProvenance,CatalogVendored,CycleActivityContract,CatalogBundleFence}.test.ts`, copied + new tests | osi-server frontend | T6 |
| `frontend/src/components/journal/capture/{EntryForm,NutrientRepeater,NumberStepper}.tsx` + tests, `frontend/tests/journalCapture{Locales,ReadOnlyContract}.test.ts`, 7× locales | osi-server frontend | T7 |
| `frontend/src/components/journal/capture/{ActivityPicker,JournalCaptureModal}.tsx`, `frontend/src/journal/entryPayload.ts`, `frontend/tests/helpers/catalogOrphanContract.ts`, `frontend/tests/journalEntryPayload.test.ts` + tests, 7× locales | osi-server frontend | T8 |
| `frontend/src/pages/JournalPage.tsx`, `frontend/src/components/journal/workspace/{ScopeRail,EntryTable}.tsx`, `frontend/src/journal/builders.ts` (retires `buildNewEntry`) + tests, 7× locales | osi-server frontend | T9 |
| `frontend/src/components/journal/workspace/DetailPanel.tsx`, `frontend/src/journal/{entryCorrection,entryCopy}.ts`, `frontend/tests/journalEntryCopy.test.ts` + tests, 7× locales | osi-server frontend | T10 |
| `docs/superpowers/plans/agrolink-gui-parity-matrix.md` | osi-os | T11 |
| (verification only) | both | T12 |

---

### Task 1: Page-shell cohesion sweep, so every cloud page paints `bg-[var(--bg)]`

Maintainer finding, folded into S3 (reading 11). Three page roots disagree with the other twelve and with every edge page. This lands first because everything else in the slice renders inside one of these shells. Journal's inner surfaces stay as they are until T9 rewrites the page; T1 changes shell lines only.

**Files:**
- Modify: `frontend/src/pages/JournalPage.tsx`, `frontend/src/pages/HistoryDashboard.tsx`, `frontend/src/pages/CrossZoneAnalysisPage.tsx`
- Add (test): `frontend/tests/pageShellTokens.test.ts`

**Interfaces:** none; class strings only.

- [ ] **Step 1: Write the failing guard test**

Create `frontend/tests/pageShellTokens.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const pagesRoot = path.resolve(import.meta.dirname, '../src/pages');

function listPages(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...listPages(full));
    } else if (entry.name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

// Hardcoded fills and text colors are theme-blind: #f4f1e8 with text-slate-950
// reads as intended in light mode and as unreadable intent in dark mode.
const HARDCODED_BG =
  /\bbg-(?:\[#[0-9a-fA-F]{3,8}\]|(?:slate|gray|grey|zinc|neutral|stone|amber|emerald|red|blue|white|black)[-\w]*)\b/;
const HARDCODED_TEXT =
  /\btext-(?:\[#[0-9a-fA-F]{3,8}\]|(?:slate|gray|grey|zinc|neutral|stone|white|black)-\d{2,3})\b/;

// Collect class strings from both `className="…"` and `className={…}`, so the
// guard does not silently stop applying the day a shell becomes a template
// literal or a ternary. All 17 shells are plain string attributes today; that
// is exactly why the brace form has to be covered now rather than later.
const CLASS_ATTR = /class(?:Name)?=(?:"([^"]*)"|\{([\s\S]*?)\})/g;
const LITERAL = /(?:'([^']*)'|"([^"]*)"|`([^`$]*)`)/g;

function classStrings(source: string): string[] {
  const out: string[] = [];
  for (const m of source.matchAll(CLASS_ATTR)) {
    if (m[1] !== undefined) { out.push(m[1]); continue; }
    for (const lit of (m[2] ?? '').matchAll(LITERAL)) out.push(lit[1] ?? lit[2] ?? lit[3] ?? '');
  }
  return out;
}

// One test, per shell, both directions. A file-level `content.includes(...)`
// positive check passes a two-shell file when only one shell carries the token,
// which is precisely the regression this page sweep exists to prevent.
test('every viewport-claiming shell paints the app tokens and hardcodes nothing', () => {
  const offenders: string[] = [];
  for (const filePath of listPages(pagesRoot)) {
    const source = fs.readFileSync(filePath, 'utf8');
    const shells = classStrings(source).filter((c) => /\b(min-h-screen|h-screen)\b/.test(c));
    for (const shell of shells) {
      const rel = path.relative(pagesRoot, filePath);
      if (HARDCODED_BG.test(shell) || HARDCODED_TEXT.test(shell)) offenders.push(`${rel}: hardcoded color in shell: ${shell}`);
      if (!shell.includes('bg-[var(--bg)]')) offenders.push(`${rel}: shell does not paint bg-[var(--bg)]: ${shell}`);
    }
  }
  assert.deepEqual(offenders, []);
});
```

Run:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx tsx --test tests/pageShellTokens.test.ts
```

Expected: FAIL with exactly **six** offender strings — a `hardcoded color in shell` line and a `does not paint bg-[var(--bg)]` line for each of the three known shells: `JournalPage.tsx:218` (`min-h-screen bg-[#f4f1e8] text-slate-950`), `HistoryDashboard.tsx:144` (`min-h-screen bg-slate-100`), `CrossZoneAnalysisPage.tsx:160` (`analysis-page flex h-screen flex-col bg-slate-100 text-slate-950`). The repo has 17 viewport-claiming shells across 15 page files at this head; the other 14 already paint the token and hardcode nothing. A seventh offender means the caveat below fired — read it.

**Caveat to check first, before writing the fix.** Per-shell positive checking is stricter than the file-level check it replaces: it can flag *inner* viewport-height wrappers (loading spinners, centered-empty-state divs) that a file-level `includes` tolerated because some other shell in the file carried the token. Run the test first and read the offender list. On this head that should not happen — the four multi-shell files (`DeviceDetail.tsx:70,77`, `Register.tsx:49,60`) already paint `bg-[var(--bg)]` in every shell — but if it does, apply the **positive** rule to the first shell per file (the page root) and keep the **negative** rule per shell, with a comment in the test saying so. Do **not** silence it by reverting to a file-level `content.includes(...)`.

Expected suite delta for T1: **+1 node-runner test** (`tests/pageShellTokens.test.ts`), 0 Vitest.

- [ ] **Step 2: Fix the three shells**

`frontend/src/pages/JournalPage.tsx:218`:

```tsx
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
```

`frontend/src/pages/HistoryDashboard.tsx:144`:

```tsx
    <div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">
```

`frontend/src/pages/CrossZoneAnalysisPage.tsx:160` — keep `h-screen` and the flex column (load-bearing for the page's `min-h-0` scroll panes), change colors only:

```tsx
    <div className="analysis-page flex h-screen flex-col bg-[var(--bg)] text-[var(--text)]">
```

Contrast, all three: `--text` on `--bg` = **16.48:1 light / 17.21:1 dark** (AAA both). The replaced pairs were `#0F172A`-equivalent `text-slate-950` on `#f4f1e8` (17.0:1 light, but the token pair is theme-aware where the literal was not) and default text on `bg-slate-100`.

- [ ] **Step 3: Run the guard and the affected page tests**

```bash
npx tsx --test tests/pageShellTokens.test.ts
npx vitest run --environment jsdom src/pages/__tests__
```

Expected: guard PASSES; page tests stay green (no test asserts on the shell colors — verify by reading any failure rather than editing an assertion blind).

- [ ] **Step 4: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/pages/JournalPage.tsx frontend/src/pages/HistoryDashboard.tsx frontend/src/pages/CrossZoneAnalysisPage.tsx frontend/tests/pageShellTokens.test.ts
git commit -m "fix: every cloud page shell paints bg-[var(--bg)] like the edge (S3 T1 cohesion)"
```

---

### Task 2: Edge, export the v10 catalog as a vendorable JSON artifact

Canonical side of reading 1. The exporter reads the shipped `database/farming.db` (already pinned column-by-column by the row-content gate `scripts/test-journal-schema.js`) and emits exactly the DTO the edge serves at `GET /api/journal/catalog?include=definitions`, restricted to the global rows a gateway would serve to any principal (`scope='core'` vocab, all templates, all layouts, `scope='core'` products, mappings of core terms). No edge runtime file changes.

**Files:**
- Add: `scripts/export-journal-catalog.js`, `scripts/test-export-journal-catalog.js`, `scripts/verify-journal-catalog-vendor.sh`, `scripts/verify-journal-catalog-vendor.test.sh`
- Add (generated): `docs/contracts/journal-catalog/journal-catalog.json`, `docs/contracts/journal-catalog/README.md`
- Add (CI): `.github/workflows/journal-catalog.yml`
- Modify: `.github/workflows/field-journal.yml`

**Interfaces:**
- Consumes: `database/farming.db`, the `sqlite3` CLI (already required by `scripts/test-journal-schema.js`).
- Produces: `module.exports = { buildCatalogArtifact, artifactText, vocabDto, definitionDto, productDto, OUT_PATH, DB_PATH }` (the three row mappers are exported so the test can prove `catalog_errors` is derived rather than hardcoded); the artifact JSON `{catalog_version, catalog_hash, vocab[], templates[], layouts[], products[], mappings[]}` with 2-space indent and a trailing newline.

- [ ] **Step 1: Write the failing exporter test**

Create `scripts/test-export-journal-catalog.js`:

```js
#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');

const exporter = require('./export-journal-catalog');

const artifact = exporter.buildCatalogArtifact();

// The artifact on disk is exactly what the exporter would write today.
assert.equal(
  fs.readFileSync(exporter.OUT_PATH, 'utf8'),
  exporter.artifactText(artifact),
  'docs/contracts/journal-catalog/journal-catalog.json is stale; run node scripts/export-journal-catalog.js'
);

// Version/hash come from the shipped DB's journal_catalog_state, so the cloud
// can compare them against what a gateway advertises at bootstrap.
assert.equal(artifact.catalog_version, 10, 'shipped catalog must be v10');
assert.match(artifact.catalog_hash, /^[0-9a-f]{64}$/);

// v10 markers: the full_record@10 template carries the three operation maps.
const fullRecord10 = artifact.templates.find(
  (row) => row.code === 'full_record' && row.version === 10
);
assert.ok(fullRecord10, 'full_record@10 must be present');
for (const key of [
  'operation_fields_by_operation',
  'operation_requirements',
  'operation_product_kinds',
]) {
  assert.equal(
    typeof fullRecord10.definition[key],
    'object',
    `full_record@10 must carry ${key}`
  );
}
const operationSection = (fullRecord10.definition.sections || [])
  .find((section) => section.code === 'operation');
assert.equal(operationSection && operationSection.scoped_by_activity, true,
  'the operation section must stay scoped_by_activity');

// No principal-scoped rows may leak into a shared artifact.
for (const row of artifact.vocab) {
  assert.equal(row.scope, 'core', `vocab ${row.code} is not core-scoped`);
  assert.equal(row.owner_user_uuid, null, `vocab ${row.code} carries an owner`);
}
for (const row of artifact.products) {
  assert.equal(row.scope, 'core', `product ${row.product_uuid} is not core-scoped`);
}

// Every term is labelled, so catalogLabel() never has to fall back to a raw code.
for (const row of artifact.vocab) {
  assert.ok(row.labels && typeof row.labels.en === 'string' && row.labels.en.length > 0,
    `vocab ${row.code} has no en label`);
}

// Ordering must match api.js catalogDto's JS comparators, NOT SQLite's BINARY
// collation. They genuinely disagree: BINARY sorts 'unit.m2_area' before
// 'unit.m_per_s' ('2' = 0x32 < '_' = 0x5F) while localeCompare does the
// reverse. Without this the artifact is the right rows in the wrong order and
// the "same bytes a gateway would answer" claim is false (reading 1, L1).
assert.deepEqual(
  artifact.vocab.map((row) => row.code),
  [...artifact.vocab].sort((a, b) => a.code.localeCompare(b.code)).map((row) => row.code),
  'vocab must be ordered by code.localeCompare, matching api.js catalogDto'
);
for (const key of ['templates', 'layouts']) {
  assert.deepEqual(
    artifact[key].map((row) => `${row.code}@${row.version}`),
    [...artifact[key]]
      .sort((a, b) => a.code.localeCompare(b.code) || a.version - b.version)
      .map((row) => `${row.code}@${row.version}`),
    `${key} must be ordered by code.localeCompare then version`
  );
}
assert.deepEqual(
  artifact.products.map((row) => row.product_uuid),
  [...artifact.products]
    .sort((a, b) => a.product_uuid.localeCompare(b.product_uuid))
    .map((row) => row.product_uuid),
  'products must be ordered by product_uuid.localeCompare'
);

// catalog_errors is DERIVED, not hardcoded: a row whose *_json column does not
// parse to a plain object records the offending column name, exactly as
// catalog.js safeJson does. The shipped DB is clean, so every list is empty —
// but a future malformed row must not be exported as clean (L2).
for (const row of [...artifact.vocab, ...artifact.templates,
                   ...artifact.layouts, ...artifact.products]) {
  assert.ok(Array.isArray(row.catalog_errors),
    `${row.code || row.product_uuid} has no catalog_errors array`);
  assert.deepEqual(row.catalog_errors, [],
    `${row.code || row.product_uuid} carries catalog errors: ` +
    `${row.catalog_errors.join(',')} — the shipped catalog must be clean`);
}
// And the derivation actually fires: a hand-made malformed row is flagged.
assert.deepEqual(
  exporter.vocabDto({ code: 'x', scope: 'core', labels_json: '{not json',
                      constraints_json: null }).catalog_errors,
  ['labels_json']
);

// The DTO must not carry the raw *_json columns or mapping row ids.
for (const row of [...artifact.vocab, ...artifact.templates, ...artifact.layouts]) {
  assert.equal('labels_json' in row, false);
}
for (const row of artifact.mappings) {
  assert.equal('id' in row, false);
}

console.log(
  `test-export-journal-catalog: OK (v${artifact.catalog_version}, ` +
  `${artifact.vocab.length} vocab, ${artifact.templates.length} templates, ` +
  `${artifact.layouts.length} layouts, ${artifact.products.length} products)`
);
```

Run:

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
node scripts/test-export-journal-catalog.js
```

Expected: FAIL with `Cannot find module './export-journal-catalog'`.

- [ ] **Step 2: Write the exporter**

Create `scripts/export-journal-catalog.js`:

```js
#!/usr/bin/env node
'use strict';

// Emits the vendorable journal-catalog artifact: the same rows, in the same DTO
// shape and the same order, that the edge serves at
// GET /api/journal/catalog?include=definitions — restricted to the global
// (non-principal) rows, since a build-time file cannot carry a caller's
// scope='custom' vocab or scope='farm' products (reading 6 deviation).
// osi-server vendors this file and serves it to its GUI,
// which then runs the same catalogModel/templateEngine the edge GUI runs.
// Source of truth is the shipped database/farming.db, whose catalog rows are
// pinned column-by-column by scripts/test-journal-schema.js.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(REPO_ROOT, 'database/farming.db');
const OUT_PATH = path.join(
  REPO_ROOT,
  'docs/contracts/journal-catalog/journal-catalog.json'
);

function sqliteJson(sql) {
  const stdout = execFileSync('sqlite3', ['-json', DB_PATH, sql], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout.trim() ? JSON.parse(stdout) : [];
}

// Mirrors osi-journal/api.js parsedJson exactly (null-in => fallback out).
function parsedJson(raw, fallback) {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

// Mirrors osi-journal/catalog.js safeJson: anything that is not a plain object
// records the column name in catalog_errors instead of being silently dropped.
// The shipped catalog is clean today; hardcoding `catalog_errors: []` would
// export a future malformed row as if it were fine (L2).
function safeJson(raw, fallback, field, errors) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (_) {
    // Fall through: the catalog stays loadable, the defect is recorded.
  }
  errors.push(field);
  return fallback;
}

// osi-journal/catalog.js parseVocabRow + api.js catalogDto (includeDefinitions).
// Note the two-stage shape the edge has: parse*Row derives catalog_errors from
// safeJson, then catalogDto re-derives `constraints` with parsedJson(..., null),
// so a NULL constraints_json emits `null` (not `{}`) and contributes no error.
function vocabDto(row) {
  const errors = [];
  safeJson(row.labels_json, {}, 'labels_json', errors);
  if (row.constraints_json != null) {
    safeJson(row.constraints_json, {}, 'constraints_json', errors);
  }
  const out = Object.assign({}, row, {
    catalog_errors: errors,
    labels: parsedJson(row.labels_json, {}),
    constraints: parsedJson(row.constraints_json, null),
  });
  delete out.labels_json;
  delete out.constraints_json;
  return out;
}

function definitionDto(row) {
  const errors = [];
  safeJson(row.labels_json, {}, 'labels_json', errors);
  safeJson(row.definition_json, {}, 'definition_json', errors);
  const out = Object.assign({}, row, {
    catalog_errors: errors,
    labels: parsedJson(row.labels_json, {}),
    definition: parsedJson(row.definition_json, {}),
  });
  delete out.labels_json;
  delete out.definition_json;
  return out;
}

function productDto(row) {
  const errors = [];
  safeJson(row.composition_json, {}, 'composition_json', errors);
  const out = Object.assign({}, row, {
    catalog_errors: errors,
    composition: parsedJson(row.composition_json, {}),
  });
  delete out.composition_json;
  return out;
}

function mappingDto(row) {
  const out = Object.assign({}, row);
  delete out.id;
  return out;
}

function buildCatalogArtifact() {
  const state = sqliteJson(
    'SELECT catalog_version, catalog_hash FROM journal_catalog_state WHERE id=1'
  )[0];
  if (!state) throw new Error('journal_catalog_state row 1 is missing');

  // The SQL ORDER BY clauses match osi-journal/catalog.js readCoreCatalogTables,
  // but SQLite's BINARY collation is NOT api.js catalogDto's ordering: catalogDto
  // re-sorts vocab/templates/layouts/products in JS with localeCompare, and the
  // two disagree on the vocab list ('unit.m2_area' vs 'unit.m_per_s'). Apply the
  // same JS comparators so the artifact is the served payload's byte order.
  // Mappings are the one list catalogDto does NOT re-sort — it keeps the SQL
  // order — so this leaves them alone.
  const byCode = (left, right) => left.code.localeCompare(right.code);
  const byCodeVersion = (left, right) =>
    left.code.localeCompare(right.code) || left.version - right.version;

  const vocab = sqliteJson(
    "SELECT * FROM journal_vocab WHERE scope='core' ORDER BY code"
  ).map(vocabDto).sort(byCode);
  const mappings = sqliteJson(
    'SELECT m.* FROM journal_vocab_mappings AS m ' +
    "JOIN journal_vocab AS v ON v.code=m.term_code WHERE v.scope='core' " +
    'ORDER BY m.term_code,m.scheme_uri,m.mapping_role,m.external_id'
  ).map(mappingDto);
  const templates = sqliteJson(
    'SELECT * FROM journal_templates ORDER BY code, version'
  ).map(definitionDto).sort(byCodeVersion);
  const layouts = sqliteJson(
    'SELECT * FROM journal_layouts ORDER BY code, version'
  ).map(definitionDto).sort(byCodeVersion);
  const products = sqliteJson(
    "SELECT * FROM journal_products WHERE scope='core' ORDER BY product_uuid"
  ).map(productDto)
    .sort((left, right) => left.product_uuid.localeCompare(right.product_uuid));

  return {
    catalog_version: Number(state.catalog_version),
    catalog_hash: String(state.catalog_hash),
    vocab,
    templates,
    layouts,
    products,
    mappings,
  };
}

function artifactText(artifact) {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

function main(argv) {
  const check = argv.length === 1 && argv[0] === '--check';
  if (argv.length && !check) {
    throw new Error(`unsupported argument(s): ${argv.join(' ')}`);
  }
  const artifact = buildCatalogArtifact();
  const expected = artifactText(artifact);
  if (check) {
    const actual = fs.existsSync(OUT_PATH)
      ? fs.readFileSync(OUT_PATH, 'utf8')
      : '';
    if (actual !== expected) {
      throw new Error(
        'docs/contracts/journal-catalog/journal-catalog.json is stale; ' +
        'run node scripts/export-journal-catalog.js and re-vendor to osi-server'
      );
    }
    console.log(`export-journal-catalog: OK (v${artifact.catalog_version})`);
    return;
  }
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, expected);
  console.log(
    `export-journal-catalog: wrote v${artifact.catalog_version} ` +
    `(${artifact.catalog_hash})`
  );
}

module.exports = {
  buildCatalogArtifact, artifactText, vocabDto, definitionDto, productDto,
  DB_PATH, OUT_PATH,
};

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`export-journal-catalog: FAIL: ${error.message}`);
    process.exitCode = 1;
  }
}
```

- [ ] **Step 3: Generate the artifact and its README, then pass the test**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
node scripts/export-journal-catalog.js
node scripts/test-export-journal-catalog.js
node scripts/export-journal-catalog.js --check
```

Expected: the first writes the file, the second prints a `test-export-journal-catalog: OK (v10, ...)` line with the row counts, the third prints `export-journal-catalog: OK (v10)`.

Create `docs/contracts/journal-catalog/README.md`:

```markdown
# Journal catalog contract artifact

`journal-catalog.json` is generated; never hand-edit it. It holds the same rows,
in the same DTO shape and the same order, that the edge serves at
`GET /api/journal/catalog?include=definitions` — for the global (non-principal)
rows only: `scope='core'` vocab and their mappings, every template and layout
version, and `scope='core'` products, stamped with the `journal_catalog_state`
version and hash of `database/farming.db`. A caller's own `scope='custom'` vocab
and `scope='farm'` products are **not** here and cannot be: the edge merges those
per principal at request time (`osi-journal/catalog.js` `loadScopedRows`).

Regenerate with `node scripts/export-journal-catalog.js` after any catalog
change, and re-vendor it to osi-server (`backend/src/main/resources/journal-catalog/`)
in the same change. `scripts/verify-journal-catalog-vendor.sh` and the
osi-server twin gate CI on both sides: `.github/workflows/journal-catalog.yml`
here (on `AgroLink`), `.github/workflows/backend-ci.yml` there.

osi-server serves this artifact to its GUI and compares its `catalog_version` /
`catalog_hash` against the values a gateway advertises at bootstrap
(`journal_catalog_version` / `journal_catalog_hash`). A mismatch disables cloud
capture for that gateway rather than writing entries the gateway's own catalog
cannot validate.
```

- [ ] **Step 4: Write the edge-side vendor verifier and its self-test**

Create `scripts/verify-journal-catalog-vendor.sh` (mirrors `scripts/verify-ui-core-vendor.sh`):

```sh
#!/usr/bin/env sh
set -eu

if [ -z "${OSI_SERVER_ROOT:-}" ]; then
  echo "OSI_SERVER_ROOT is required (path to an osi-server checkout on the AgroLink branch)" >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
canonical_file=${CANONICAL_JOURNAL_CATALOG:-"$repo_root/docs/contracts/journal-catalog/journal-catalog.json"}
vendor_file="$OSI_SERVER_ROOT/backend/src/main/resources/journal-catalog/journal-catalog.json"

for file in "$canonical_file" "$vendor_file"; do
  if [ ! -f "$file" ] || [ ! -s "$file" ]; then
    echo "missing or empty journal catalog artifact: $file" >&2
    exit 1
  fi
done

if ! cmp -s "$canonical_file" "$vendor_file"; then
  echo "vendored journal catalog (osi-server backend/src/main/resources/journal-catalog) differs from canonical docs/contracts/journal-catalog" >&2
  exit 1
fi

echo "verify-journal-catalog-vendor: OK"
```

Create `scripts/verify-journal-catalog-vendor.test.sh`, the edge-side self-test proving the verifier actually fails on drift. This is what `verify-ui-core-vendor.test.sh` is for ui-core, and the edge side needs one for the same reason the cloud side does: an always-green verifier is worse than none. It uses `CANONICAL_JOURNAL_CATALOG` plus a synthetic `OSI_SERVER_ROOT`, so it needs neither checkout:

```sh
#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
verifier="$script_dir/verify-journal-catalog-vendor.sh"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM

vendor_dir="$work/server/backend/src/main/resources/journal-catalog"
mkdir -p "$vendor_dir"
printf '{"catalog_version":10}\n' > "$work/canonical.json"
cp "$work/canonical.json" "$vendor_dir/journal-catalog.json"

CANONICAL_JOURNAL_CATALOG="$work/canonical.json" OSI_SERVER_ROOT="$work/server" \
  sh "$verifier" >/dev/null

printf '{"catalog_version":9}\n' > "$vendor_dir/journal-catalog.json"
if CANONICAL_JOURNAL_CATALOG="$work/canonical.json" OSI_SERVER_ROOT="$work/server" \
     sh "$verifier" >/dev/null 2>&1; then
  echo 'verify-journal-catalog-vendor.test: FAIL — drift was not detected' >&2
  exit 1
fi

: > "$vendor_dir/journal-catalog.json"
if CANONICAL_JOURNAL_CATALOG="$work/canonical.json" OSI_SERVER_ROOT="$work/server" \
     sh "$verifier" >/dev/null 2>&1; then
  echo 'verify-journal-catalog-vendor.test: FAIL — empty vendor file was accepted' >&2
  exit 1
fi

rm -f "$vendor_dir/journal-catalog.json"
if CANONICAL_JOURNAL_CATALOG="$work/canonical.json" OSI_SERVER_ROOT="$work/server" \
     sh "$verifier" >/dev/null 2>&1; then
  echo 'verify-journal-catalog-vendor.test: FAIL — a missing vendor file was accepted' >&2
  exit 1
fi

echo "verify-journal-catalog-vendor.test: OK"
```

```bash
chmod +x scripts/export-journal-catalog.js scripts/test-export-journal-catalog.js \
         scripts/verify-journal-catalog-vendor.sh scripts/verify-journal-catalog-vendor.test.sh
sh scripts/verify-journal-catalog-vendor.test.sh
```

Expected: `verify-journal-catalog-vendor.test: OK`. (The verifier itself cannot pass against the real checkouts until T3 vendors the file; T3 Step 3 runs it. The self-test is independent of both checkouts and must pass now.)

- [ ] **Step 5: Add the dedicated `journal-catalog.yml` workflow**

`field-journal.yml` triggers on `branches: [main, master]` only — a branch this program never pushes to — so steps added there gate nothing during S3. The artifact needs the governance ui-core already has: a workflow on the `AgroLink` branch that checks osi-server out and runs both scripts. Create `.github/workflows/journal-catalog.yml`, modelled on `.github/workflows/ui-core.yml` (read that file and mirror its structure — same `.vendor/osi-server` checkout, same `OSI_SERVER_RO_TOKEN`, same prefer-matching-branch step):

```yaml
name: Journal Catalog Vendor Parity
on:
  push:
    branches: [ AgroLink ]
  pull_request:
    branches: [ AgroLink ]
jobs:
  catalog-parity:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
      - name: Journal catalog export is current
        run: node scripts/export-journal-catalog.js --check
      - name: Journal catalog export tests
        run: node scripts/test-export-journal-catalog.js
      - uses: actions/checkout@v4
        with:
          repository: Open-Smart-Irrigation/osi-server
          token: ${{ secrets.OSI_SERVER_RO_TOKEN }}
          ref: AgroLink
          path: .vendor/osi-server
          persist-credentials: false
          fetch-depth: 1
      - name: Prefer matching osi-server branch
        env:
          OSI_SERVER_RO_TOKEN: ${{ secrets.OSI_SERVER_RO_TOKEN }}
          OSI_SERVER_REF: ${{ github.head_ref || github.ref_name }}
        run: |
          set -euo pipefail
          cd .vendor/osi-server
          auth_header="$(printf 'x-access-token:%s' "$OSI_SERVER_RO_TOKEN" | base64 | tr -d '\n')"
          if git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth_header}" \
              ls-remote --exit-code --heads origin "$OSI_SERVER_REF" >/dev/null; then
            git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth_header}" \
              fetch --depth=1 origin "refs/heads/${OSI_SERVER_REF}"
            git checkout --detach FETCH_HEAD
            echo "Using osi-server branch ${OSI_SERVER_REF}"
          else
            echo "No osi-server branch ${OSI_SERVER_REF}; using AgroLink checkout"
          fi
      - name: Reject a stale vendored journal catalog
        env:
          OSI_SERVER_ROOT: ${{ github.workspace }}/.vendor/osi-server
        run: |
          sh scripts/verify-journal-catalog-vendor.test.sh
          sh scripts/verify-journal-catalog-vendor.sh
```

Copy the two `uses:` pins, the `repository:` slug and the secret name from `ui-core.yml` as they actually read at this head rather than from this snippet; if any differ, the file on disk wins and this plan is stale.

Reproduce the workflow's own steps locally (the checkout steps have no local equivalent; the vendor step runs in T3 Step 3):

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
node scripts/export-journal-catalog.js --check
node scripts/test-export-journal-catalog.js
sh scripts/verify-journal-catalog-vendor.test.sh
```

Expected: three OK lines.

- [ ] **Step 6: Wire the `field-journal.yml` steps too**

Keep the artifact gated on `main`/`master` merges as well, so a future merge of this branch cannot land a stale artifact. In `.github/workflows/field-journal.yml`, immediately after the existing `Catalog generated-file check` step (`node scripts/generate-journal-catalog.js --check`), add:

```yaml
      - name: Journal catalog export is current
        run: node scripts/export-journal-catalog.js --check
      - name: Journal catalog export tests
        run: node scripts/test-export-journal-catalog.js
```

These duplicate two of `journal-catalog.yml`'s steps on purpose: the two workflows fire on disjoint branch sets. The vendor verifiers stay out of `field-journal.yml`, which has no osi-server checkout.

Run the whole journal workflow's script set locally to prove nothing regressed:

```bash
node scripts/generate-journal-catalog.js --check
node scripts/test-journal-catalog-generator.js
node scripts/test-journal-schema.js 2>&1 | tail -5
node scripts/verify-agroscope-linkage.js 2>&1 | tail -3
```

Expected: all OK. S3 changed no catalog row, so the row-content gate and the Agroscope-linkage gate are unaffected.

- [ ] **Step 7: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add scripts/export-journal-catalog.js scripts/test-export-journal-catalog.js scripts/verify-journal-catalog-vendor.sh scripts/verify-journal-catalog-vendor.test.sh docs/contracts/journal-catalog .github/workflows/journal-catalog.yml .github/workflows/field-journal.yml
git commit -m "feat: export the v10 journal catalog as a vendorable contract artifact (S3 T2)"
```

Expected suite delta for T2: **0** cloud tests; two new edge script gates (`test-export-journal-catalog.js`, `verify-journal-catalog-vendor.test.sh`) that are not part of the edge's 107 + 1,689 GUI counts.

---

### Task 3: Cloud, vendor the catalog artifact and gate it both ways

Vendored side of reading 1, byte-identical, using the `verify-edge-sync-contract-vendor` pattern the repo already trusts. The artifact lives under `main/resources` (not `test/resources` like the sync contract) because T5 serves it at runtime.

**Files:**
- Add: `backend/src/main/resources/journal-catalog/journal-catalog.json` (byte copy)
- Add: `scripts/verify-journal-catalog-vendor.sh`, `scripts/verify-journal-catalog-vendor.test.sh`
- Modify: `.github/workflows/backend-ci.yml`

**Interfaces:** none (files and scripts only).

- [ ] **Step 1: Copy the artifact**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
mkdir -p backend/src/main/resources/journal-catalog
cp /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/docs/contracts/journal-catalog/journal-catalog.json \
   backend/src/main/resources/journal-catalog/journal-catalog.json
cmp backend/src/main/resources/journal-catalog/journal-catalog.json \
    /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/docs/contracts/journal-catalog/journal-catalog.json && echo BYTE-IDENTICAL
```

- [ ] **Step 2: Write the cloud verifier and its self-test**

Create `scripts/verify-journal-catalog-vendor.sh` (mirrors `scripts/verify-edge-sync-contract-vendor.sh`):

```sh
#!/usr/bin/env sh
set -eu

if [ -z "${EDGE_CATALOG_ROOT:-}" ]; then
  echo "EDGE_CATALOG_ROOT is required (path to an osi-os checkout on the AgroLink branch)" >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
server_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
canonical_file="$EDGE_CATALOG_ROOT/docs/contracts/journal-catalog/journal-catalog.json"
vendor_file=${VENDOR_CATALOG_FILE:-"$server_root/backend/src/main/resources/journal-catalog/journal-catalog.json"}

if [ ! -f "$canonical_file" ] || [ ! -s "$canonical_file" ]; then
  echo "missing or empty canonical catalog: docs/contracts/journal-catalog/journal-catalog.json" >&2
  exit 1
fi
if [ ! -f "$vendor_file" ] || [ ! -s "$vendor_file" ]; then
  echo "missing or empty vendored catalog: backend/src/main/resources/journal-catalog/journal-catalog.json" >&2
  exit 1
fi
if ! cmp -s "$canonical_file" "$vendor_file"; then
  echo "vendored journal catalog differs from canonical osi-os docs/contracts/journal-catalog" >&2
  exit 1
fi

echo "verify-journal-catalog-vendor: OK"
```

Create `scripts/verify-journal-catalog-vendor.test.sh`, a self-test proving the verifier actually fails on drift (same shape as `verify-ui-core-vendor.test.sh`):

```sh
#!/usr/bin/env sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

mkdir -p "$work/edge/docs/contracts/journal-catalog"
printf '{"catalog_version":10}\n' > "$work/edge/docs/contracts/journal-catalog/journal-catalog.json"
printf '{"catalog_version":10}\n' > "$work/vendored.json"

EDGE_CATALOG_ROOT="$work/edge" VENDOR_CATALOG_FILE="$work/vendored.json" \
  sh "$script_dir/verify-journal-catalog-vendor.sh" >/dev/null

printf '{"catalog_version":9}\n' > "$work/vendored.json"
if EDGE_CATALOG_ROOT="$work/edge" VENDOR_CATALOG_FILE="$work/vendored.json" \
     sh "$script_dir/verify-journal-catalog-vendor.sh" >/dev/null 2>&1; then
  echo "verify-journal-catalog-vendor.test: FAIL — drift was not detected" >&2
  exit 1
fi

: > "$work/vendored.json"
if EDGE_CATALOG_ROOT="$work/edge" VENDOR_CATALOG_FILE="$work/vendored.json" \
     sh "$script_dir/verify-journal-catalog-vendor.sh" >/dev/null 2>&1; then
  echo "verify-journal-catalog-vendor.test: FAIL — empty vendor file was accepted" >&2
  exit 1
fi

echo "verify-journal-catalog-vendor.test: OK"
```

- [ ] **Step 3: Run both verifiers, both directions**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
chmod +x scripts/verify-journal-catalog-vendor.sh scripts/verify-journal-catalog-vendor.test.sh
sh scripts/verify-journal-catalog-vendor.test.sh
EDGE_CATALOG_ROOT=/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep sh scripts/verify-journal-catalog-vendor.sh
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
OSI_SERVER_ROOT=/home/phil/Repos/osi-server/.worktrees/agrolink sh scripts/verify-journal-catalog-vendor.sh
```

Expected: three `OK` lines.

- [ ] **Step 4: Wire cloud CI**

In `.github/workflows/backend-ci.yml`, after the existing "Reject stale vendored ui-core" step (reusing the `.contract/osi-os` checkout that step's neighbour already makes), add:

```yaml
      - name: Reject a stale vendored journal catalog
        env:
          EDGE_CATALOG_ROOT: ${{ github.workspace }}/.contract/osi-os
        run: |
          sh scripts/verify-journal-catalog-vendor.test.sh
          sh scripts/verify-journal-catalog-vendor.sh
```

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add backend/src/main/resources/journal-catalog/journal-catalog.json scripts/verify-journal-catalog-vendor.sh scripts/verify-journal-catalog-vendor.test.sh .github/workflows/backend-ci.yml
git commit -m "feat: vendor the v10 journal catalog artifact with a byte-parity gate (S3 T3)"
```

Expected suite delta for T3: **0** node-runner and **0** Vitest tests (the new gate is a shell script, not part of `npm run test:unit`).

---

### Task 4: Cloud backend, keep the catalog version the edge already advertises

Reading 2. The edge sends `journal_catalog_version` / `journal_catalog_hash` in every bootstrap; the cloud's `GatewayIdentity` record does not declare them, so Jackson discards them. Persist them, expose them on the linked-gateway summary, and the D4 gate in T5 has something to compare against. No edge change, no new capability string.

**Files:**
- Add: `backend/src/main/resources/db/migration/V2026_08_05_001__journal_catalog_advertisement.sql`
- Modify: `backend/src/main/java/org/osi/server/user/LinkedGatewayAccount.java`, `.../user/LinkedGatewayAccountService.java`, `.../user/LinkedGatewaySyncService.java`, `.../sync/EdgeSyncService.java`, `frontend/src/types/farming.ts`
- Modify (tests): `backend/src/test/java/org/osi/server/user/LinkedGatewayAccountServiceTest.java`, `backend/src/test/java/org/osi/server/sync/EdgeSyncServiceTest.java`

**Interfaces:**
- Consumes: the existing bootstrap payload, with no edge change.
- Produces:

```java
// EdgeSyncService.GatewayIdentity gains two trailing components
public record GatewayIdentity(
        List<String> previousGatewayDeviceEuis,
        String edgeBuildVersion,
        List<String> syncCapabilities,
        String installationUuid,
        String recoveryState,
        String recoveryOperationUuid,
        Integer journalCatalogVersion,
        String journalCatalogHash) { /* compact constructor extended in Step 4 */ }

// LinkedGatewayAccountService
public LinkedGatewayAccount observeBootstrapIdentity(
        User user, String gatewayDeviceEui, String localUserUuid,
        String localUsernameSnapshot, String edgeBuildVersion,
        List<String> syncCapabilities, GatewayInstallation installation,
        Integer journalCatalogVersion, String journalCatalogHash);

// LinkedGatewaySyncService.LinkedGatewaySummary gains, after gatewayLastSeen:
//   Integer journalCatalogVersion, String journalCatalogHash
```

- [ ] **Step 1: Write the failing service test**

Append to `backend/src/test/java/org/osi/server/user/LinkedGatewayAccountServiceTest.java`:

```java
    @Test
    void observeBootstrapIdentityPersistsTheAdvertisedJournalCatalogStamp() {
        User user = User.builder().id(7L).username("amina").build();
        when(linkedGatewayAccountRepository.findByUserIdAndGatewayDeviceEui(7L, GATEWAY))
                .thenReturn(Optional.empty());
        when(linkedGatewayAccountRepository.save(any(LinkedGatewayAccount.class)))
                .thenAnswer(invocation -> invocation.getArgument(0));

        LinkedGatewayAccount saved = service.observeBootstrapIdentity(
                user, GATEWAY, LOCAL_UUID, "amina", "0.7.0",
                List.of("field_journal_v1"), null,
                10, "b4a62e4fd2f28a8e6b6dbf4e60376fb5a5b84f0cef1a5e37955de971fc43c16c");

        assertThat(saved.isFieldJournalSupported()).isTrue();
        assertThat(saved.getJournalCatalogVersion()).isEqualTo(10);
        assertThat(saved.getJournalCatalogHash())
                .isEqualTo("b4a62e4fd2f28a8e6b6dbf4e60376fb5a5b84f0cef1a5e37955de971fc43c16c");
    }

    @Test
    void gatewaysThatAdvertiseNoCatalogStampClearIt() {
        // An older edge, or a gateway whose journal tables are absent, sends no
        // journal_catalog_* fields. The stamp must go null (fail-closed for the
        // D4 gate), never keep a stale value from an earlier bootstrap.
        User user = User.builder().id(7L).username("amina").build();
        LinkedGatewayAccount existing = LinkedGatewayAccount.builder()
                .user(user).gatewayDeviceEui(GATEWAY)
                .journalCatalogVersion(9).journalCatalogHash("deadbeef")
                .build();
        when(linkedGatewayAccountRepository.findByUserIdAndGatewayDeviceEui(7L, GATEWAY))
                .thenReturn(Optional.of(existing));
        when(linkedGatewayAccountRepository.save(any(LinkedGatewayAccount.class)))
                .thenAnswer(invocation -> invocation.getArgument(0));

        LinkedGatewayAccount saved = service.observeBootstrapIdentity(
                user, GATEWAY, LOCAL_UUID, "amina", "0.6.0", List.of(), null, null, null);

        assertThat(saved.getJournalCatalogVersion()).isNull();
        assertThat(saved.getJournalCatalogHash()).isNull();
    }
```

(Reuse the file's existing `GATEWAY` / `LOCAL_UUID` constants and repository-mock idiom; if the class names them differently, keep the file's names rather than introducing new ones.)

Run:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend
./gradlew test --tests 'org.osi.server.user.LinkedGatewayAccountServiceTest' 2>&1 | tail -20
```

Expected: compile FAILURE (no 9-arg overload, no `getJournalCatalogVersion`).

- [ ] **Step 2: Migration + entity**

Create `backend/src/main/resources/db/migration/V2026_08_05_001__journal_catalog_advertisement.sql`:

```sql
-- The edge already advertises its journal catalog version and hash in every
-- bootstrap (flows.json loadJournalBootstrapAdvertisement); the cloud dropped
-- them. Persist them so cloud capture can refuse to write entries against a
-- catalog the gateway does not have (GUI parity slice S3, D4).
ALTER TABLE linked_gateway_accounts
    ADD COLUMN journal_catalog_version INTEGER;
ALTER TABLE linked_gateway_accounts
    ADD COLUMN journal_catalog_hash VARCHAR(64);
```

In `LinkedGatewayAccount.java`, after the `edgeBuildVersion` field:

```java
    @Column(name = "journal_catalog_version")
    private Integer journalCatalogVersion;

    @Column(name = "journal_catalog_hash", length = 64)
    private String journalCatalogHash;
```

- [ ] **Step 3: Thread the stamp through the service**

In `LinkedGatewayAccountService.java`: add the 9-arg `observeBootstrapIdentity` overload (the 7-arg one delegates with `null, null`), and extend `applyEdgeCapabilities`:

```java
    @Transactional
    public LinkedGatewayAccount observeBootstrapIdentity(
            User user,
            String gatewayDeviceEui,
            String localUserUuid,
            String localUsernameSnapshot,
            String edgeBuildVersion,
            List<String> syncCapabilities,
            GatewayInstallation installation,
            Integer journalCatalogVersion,
            String journalCatalogHash
    ) {
        LinkedGatewayAccount account = findOrCreate(user, gatewayDeviceEui);
        account.setServerUsernameSnapshot(trimToNull(user != null ? user.getUsername() : null));
        applyEdgeIdentity(account, localUserUuid, localUsernameSnapshot);
        applyEdgeCapabilities(account, edgeBuildVersion, syncCapabilities);
        applyJournalCatalogStamp(account, journalCatalogVersion, journalCatalogHash);
        if (installation != null) {
            account.setInstallation(installation);
        }
        if (account.getSyncStatus() != LinkedGatewayAccountSyncStatus.PENDING) {
            account.setSyncStatus(resolveSteadyState(account));
        }
        return linkedGatewayAccountRepository.save(account);
    }

    /**
     * A gateway that advertises no catalog stamp (older edge, or journal tables
     * absent) clears the stored one rather than keeping a stale value: the D4
     * capture gate must fail closed, and a remembered version would let the
     * cloud write entries against a catalog the gateway no longer has.
     */
    private void applyJournalCatalogStamp(
            LinkedGatewayAccount account, Integer version, String hash) {
        String normalizedHash = trimToNull(hash);
        boolean usable = version != null && version > 0
                && normalizedHash != null
                && normalizedHash.matches("[0-9a-f]{64}");
        account.setJournalCatalogVersion(usable ? version : null);
        account.setJournalCatalogHash(usable ? normalizedHash : null);
    }
```

Route the existing 7-arg overload through the new one with `null, null`, so no other caller changes.

Run the Step 1 command. Expected: PASS.

- [ ] **Step 4: Carry the fields off the wire**

The two new fields are the **only snake_case keys in an otherwise camelCase object**: `flows.json`'s `loadJournalBootstrapAdvertisement` writes `bootstrapGatewayIdentity.journal_catalog_version` / `.journal_catalog_hash` next to `previousGatewayDeviceEuis`, `edgeBuildVersion` and `syncCapabilities`. There is no `PropertyNamingStrategies` / `SNAKE_CASE` configuration anywhere in `backend/src/main` (verified: zero hits), so the default camelCase binding applies and `@JsonProperty` is **required**, not a contingency — without it Jackson silently binds `null` and the D4 gate reads `gateway_catalog_unknown` forever.

In `EdgeSyncService.GatewayIdentity`, add the two components with their explicit wire names and normalize them in the compact constructor:

```java
    public record GatewayIdentity(
            List<String> previousGatewayDeviceEuis,
            String edgeBuildVersion,
            List<String> syncCapabilities,
            String installationUuid,
            String recoveryState,
            String recoveryOperationUuid,
            // The edge sends these two in snake_case while its neighbours are
            // camelCase (flows.json loadJournalBootstrapAdvertisement); the
            // project configures no snake_case naming strategy, so bind them
            // by name. @JsonAlias keeps a future camelCase sender working.
            @JsonProperty("journal_catalog_version")
            @JsonAlias("journalCatalogVersion")
            Integer journalCatalogVersion,
            @JsonProperty("journal_catalog_hash")
            @JsonAlias("journalCatalogHash")
            String journalCatalogHash) {
        public GatewayIdentity {
            // Keep every existing normalization line in this constructor as is.
            journalCatalogVersion = journalCatalogVersion != null && journalCatalogVersion > 0
                    ? journalCatalogVersion
                    : null;
            journalCatalogHash = journalCatalogHash != null && !journalCatalogHash.isBlank()
                    ? journalCatalogHash.trim().toLowerCase(Locale.ROOT)
                    : null;
        }
```

(Add `com.fasterxml.jackson.annotation.JsonAlias` and `…JsonProperty` imports.)

Then fix the five sites that construct the record with six positional arguments, all in the same file or its bootstrap test — append `, null, null` to each:

- `EdgeSyncService.java:1756` — the 3-arg convenience constructor's `this(...)` delegation;
- `EdgeSyncService.java:1761` — the 1-arg convenience constructor's `this(...)` delegation;
- `EdgeSyncService.java:1765` — `GatewayIdentity.empty()`;
- `backend/src/test/java/org/osi/server/sync/EdgeSyncServiceBootstrapTest.java:893` — `new EdgeSyncService.GatewayIdentity(List.of("GW-OLD"), null, List.of(), installationUuid, null, null)`;
- `EdgeSyncServiceBootstrapTest.java:933` — the same shape with a null installation uuid.

The 1-arg and 3-arg call sites (`EdgeSyncControllerTest.java:324`, `EdgeSyncServiceBootstrapTest.java:185, 243, 849, 993`) keep compiling through the convenience constructors and must not be touched. Confirm the split before and after:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend
grep -rn "new GatewayIdentity(\|new EdgeSyncService.GatewayIdentity(\|this(previousGatewayDeviceEuis" src/
```

Expected: **ten** hits — the five above plus the five untouched convenience-constructor call sites. If the count differs, the line numbers have drifted; re-derive them from this grep rather than trusting the list.

and in `applyBootstrap`, extend the `observeBootstrapIdentity` call:

```java
                linkedGatewayAccountService.observeBootstrapIdentity(
                        resolvedUser,
                        request.gatewayDeviceEui(),
                        str(user, "user_uuid", "userUuid"),
                        str(user, "username"),
                        gatewayIdentity.edgeBuildVersion(),
                        gatewayIdentity.syncCapabilities(),
                        null,
                        gatewayIdentity.journalCatalogVersion(),
                        gatewayIdentity.journalCatalogHash()
                );
```

Add to `EdgeSyncServiceTest` a test that a bootstrap request whose `gatewayIdentity` JSON carries `journal_catalog_version` / `journal_catalog_hash` reaches `observeBootstrapIdentity` with those values (Mockito `ArgumentCaptor` on the 9-arg overload). The point of the test is that the record's Jackson binding actually picks the **snake_case** names the edge sends, so it must deserialize real JSON text through the application `ObjectMapper` rather than constructing the record directly — a test that news up a `GatewayIdentity` would pass with the annotations removed and prove nothing. Add a second case asserting that a `gatewayIdentity` object with **no** journal keys yields `null, null` (the older-edge path).

- [ ] **Step 5: Expose it on the summary and in TypeScript**

`LinkedGatewaySyncService.LinkedGatewaySummary`: add `Integer journalCatalogVersion, String journalCatalogHash` after `gatewayLastSeen`, and in `summary(...)` pass `account.getJournalCatalogVersion(), account.getJournalCatalogHash()`.

`frontend/src/types/farming.ts`, inside `LinkedGatewaySummary`:

```ts
  journalCatalogVersion?: number | null;
  journalCatalogHash?: string | null;
```

- [ ] **Step 6: Run the backend suites**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend
./gradlew test --tests 'org.osi.server.user.*' --tests 'org.osi.server.sync.EdgeSyncServiceTest' 2>&1 | tail -15
```

Expected: BUILD SUCCESSFUL.

- [ ] **Step 7: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add backend/src/main/resources/db/migration/V2026_08_05_001__journal_catalog_advertisement.sql backend/src/main/java/org/osi/server/user backend/src/main/java/org/osi/server/sync/EdgeSyncService.java backend/src/test/java/org/osi/server/user backend/src/test/java/org/osi/server/sync frontend/src/types/farming.ts
git commit -m "feat: persist the gateway-advertised journal catalog stamp (S3 T4, D4 gate input)"
```

Expected suite delta for T4: **0** frontend tests; **+4** JUnit tests (2 in `LinkedGatewayAccountServiceTest`, 2 in `EdgeSyncServiceTest`).

---

### Task 5: Cloud backend, serve the vendored catalog with a compatibility verdict

The GUI needs the catalog *and* an honest answer to "can this gateway accept what I am about to build?". One endpoint answers both, authorized through the existing journal read path.

**Files:**
- Add: `backend/src/main/java/org/osi/server/journal/JournalCatalogService.java`
- Modify: `backend/src/main/java/org/osi/server/journal/JournalController.java`, `.../scopedaccess/GatewayScope.java`, `.../scopedaccess/GatewayScopeService.java`, `.../journal/JournalAccessService.java`
- Add (tests): `backend/src/test/java/org/osi/server/journal/JournalCatalogServiceTest.java`
- Modify (tests): `backend/src/test/java/org/osi/server/journal/{JournalControllerTest,JournalAccessServiceTest,JournalQueryServiceTest}.java`, `.../scopedaccess/{ScopedAccessMutationServiceTest,ScopedAccessControllerTest}.java`, `.../recovery/RecoveryAdminAuthorizerTest.java` (fixture arity only — see Step 4c)

**Interfaces:**

```java
// GET /api/v1/journal/gateways/{gatewayEui}/catalog  → 200
public record JournalCatalogResponse(
        int catalogVersion,
        String catalogHash,
        String compatibility,          // compatible | gateway_catalog_unknown | gateway_catalog_mismatch
        Integer gatewayCatalogVersion,
        String gatewayCatalogHash,
        JsonNode catalog) {}
```

- [ ] **Step 1: Write the failing service test**

Create `backend/src/test/java/org/osi/server/journal/JournalCatalogServiceTest.java`:

```java
package org.osi.server.journal;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class JournalCatalogServiceTest {

    private final JournalCatalogService service =
            new JournalCatalogService(new ObjectMapper());

    @Test
    void loadsTheVendoredArtifactFromTheClasspath() {
        assertThat(service.catalogVersion()).isEqualTo(10);
        assertThat(service.catalogHash()).matches("[0-9a-f]{64}");
        assertThat(service.catalog().get("templates").isArray()).isTrue();
    }

    @Test
    void compatibilityIsFailClosedForUnknownAndMismatchedGateways() {
        assertThat(service.compatibility(null, null))
                .isEqualTo("gateway_catalog_unknown");
        assertThat(service.compatibility(10, null))
                .isEqualTo("gateway_catalog_unknown");
        assertThat(service.compatibility(9, service.catalogHash()))
                .isEqualTo("gateway_catalog_mismatch");
        assertThat(service.compatibility(10, "0".repeat(64)))
                .isEqualTo("gateway_catalog_mismatch");
        assertThat(service.compatibility(10, service.catalogHash().toUpperCase()))
                .isEqualTo("compatible");
        assertThat(service.compatibility(10, service.catalogHash()))
                .isEqualTo("compatible");
    }
}
```

Run:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend
./gradlew test --tests 'org.osi.server.journal.JournalCatalogServiceTest' 2>&1 | tail -20
```

Expected: compile FAILURE.

- [ ] **Step 2: Implement the service**

Create `backend/src/main/java/org/osi/server/journal/JournalCatalogService.java`:

```java
package org.osi.server.journal;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.util.Locale;

/**
 * Serves the journal catalog vendored byte-identically from osi-os
 * (docs/contracts/journal-catalog/journal-catalog.json; both repos gate the
 * copies in CI). The cloud never derives catalog content of its own: an entry
 * the cloud builds must name a template and layout version the target gateway
 * actually has, so the artifact is the gateway's catalog, not a cloud one.
 */
@Service
@RequiredArgsConstructor
public class JournalCatalogService {

    public static final String COMPATIBLE = "compatible";
    public static final String UNKNOWN = "gateway_catalog_unknown";
    public static final String MISMATCH = "gateway_catalog_mismatch";

    private static final String RESOURCE = "journal-catalog/journal-catalog.json";

    private final ObjectMapper objectMapper;

    private volatile JsonNode catalog;

    public JsonNode catalog() {
        JsonNode loaded = catalog;
        if (loaded == null) {
            synchronized (this) {
                loaded = catalog;
                if (loaded == null) {
                    loaded = read();
                    catalog = loaded;
                }
            }
        }
        return loaded;
    }

    public int catalogVersion() {
        return catalog().path("catalog_version").asInt();
    }

    public String catalogHash() {
        return catalog().path("catalog_hash").asText();
    }

    /**
     * Fail-closed (D4): capture is offered only when the gateway advertises the
     * exact catalog the cloud would build against. A gateway that advertises
     * nothing (older edge, or journal tables absent) is UNKNOWN, not assumed
     * compatible.
     */
    public String compatibility(Integer gatewayVersion, String gatewayHash) {
        if (gatewayVersion == null || gatewayHash == null || gatewayHash.isBlank()) {
            return UNKNOWN;
        }
        boolean sameVersion = gatewayVersion == catalogVersion();
        boolean sameHash = gatewayHash.trim().toLowerCase(Locale.ROOT)
                .equals(catalogHash().toLowerCase(Locale.ROOT));
        return sameVersion && sameHash ? COMPATIBLE : MISMATCH;
    }

    private JsonNode read() {
        try (InputStream stream = new ClassPathResource(RESOURCE).getInputStream()) {
            return objectMapper.readTree(stream);
        } catch (IOException cause) {
            throw new IllegalStateException(
                    "Vendored journal catalog is missing or unreadable: " + RESOURCE, cause);
        }
    }
}
```

Run the Step 1 command. Expected: PASS.

- [ ] **Step 3: Write the failing controller test**

The stamp rides on the `GatewayScope` that `accessService.require(...)` already returns (Step 4), so the controller test needs no new mock — it needs an `Access` fixture whose scope carries a stamp. Append to `backend/src/test/java/org/osi/server/journal/JournalControllerTest.java`, reusing the file's `GW` / `OWNER` constants and its `access(user)` helper idiom:

```java
    private static final String CATALOG_HASH =
            "b4a62e4fd2f28a8e6b6dbf4e60376fb5a5b84f0cef1a5e37955de971fc43c16c";

    // The file's access(user) helper goes through Access's 3-arg convenience
    // constructor, which builds a stampless scope. Catalog tests need one with
    // a stamp, so they build the scope explicitly.
    private static JournalAccessService.Access accessWithStamp(
            User user, Integer version, String hash) {
        Device gateway = Device.builder().id(9L).deviceEui(GW).claimedBy(user).build();
        GatewayScope scope = new GatewayScope(
                gateway, OWNER, GatewayScope.Role.RESEARCHER,
                Set.of(), Set.of(), Set.of(), Set.of(), true, version, hash);
        return new JournalAccessService.Access(gateway, OWNER, true, scope);
    }

    @Test
    void catalogIsReadableByAnyScopedMemberAndReportsTheGatewayVerdict() {
        User user = user();
        when(userService.findByUsername(USERNAME)).thenReturn(user);
        when(accessService.require(user, GW, false))
                .thenReturn(accessWithStamp(user, 10, CATALOG_HASH));

        JournalCatalogResponse response = controller.catalog(userDetails, GW);

        assertThat(response.compatibility()).isEqualTo("compatible");
        assertThat(response.catalogVersion()).isEqualTo(10);
        assertThat(response.catalog().get("vocab").isArray()).isTrue();
        // Read authorization, not mutation: a viewer may load the catalog.
        verify(accessService).require(user, GW, false);
        verify(accessService, never()).require(user, GW, true);
    }

    @Test
    void catalogReportsAMismatchWithoutFailingTheRequest() {
        User user = user();
        when(userService.findByUsername(USERNAME)).thenReturn(user);
        when(accessService.require(user, GW, false))
                .thenReturn(accessWithStamp(user, 6, "0".repeat(64)));

        JournalCatalogResponse response = controller.catalog(userDetails, GW);

        assertThat(response.compatibility()).isEqualTo("gateway_catalog_mismatch");
        assertThat(response.gatewayCatalogVersion()).isEqualTo(6);
    }

    @Test
    void catalogReportsUnknownForAGatewayThatNeverAdvertisedAStamp() {
        User user = user();
        when(userService.findByUsername(USERNAME)).thenReturn(user);
        when(accessService.require(user, GW, false))
                .thenReturn(accessWithStamp(user, null, null));

        JournalCatalogResponse response = controller.catalog(userDetails, GW);

        assertThat(response.compatibility()).isEqualTo("gateway_catalog_unknown");
        assertThat(response.gatewayCatalogVersion()).isNull();
        assertThat(response.gatewayCatalogHash()).isNull();
    }
```

(`USERNAME` / `user()` are this file's existing fixture names — use whatever it actually calls them; do not introduce new ones.)

- [ ] **Step 4: Carry the stamp on `GatewayScope`, then implement the endpoint**

`JournalAccessService` holds exactly two dependencies — `GatewayScopeService` and `JournalQueryService` — and **no** `LinkedGatewayAccountRepository`, so it cannot look the stamp up itself; `GatewayScopeService.normalizedGateway` is `private`, so it cannot normalize an EUI either. It does not need to. `GatewayScopeService.resolve()` already loads the `LinkedGatewayAccount` and reads `account.isFieldJournalSupported()` off it (`GatewayScopeService.java:40-42, 93-101`); the stamp comes off that same object, in that same query. Add it to the scope and let it flow to the controller through the `Access` the controller already holds. Zero new dependencies, zero extra queries.

**Step 4a — widen the record.** In `backend/src/main/java/org/osi/server/scopedaccess/GatewayScope.java`, append two components after `fieldJournalSupported`:

```java
public record GatewayScope(
        Device gateway,
        String localUserUuid,
        Role role,
        Set<String> ownedZoneUuids,
        Set<String> grantedZoneUuids,
        Set<String> ownedPlotUuids,
        Set<String> grantedPlotUuids,
        boolean fieldJournalSupported,
        // The gateway's own journal catalog stamp as advertised at its last
        // bootstrap (S3 T4). Null means "never advertised" — an older edge, or
        // journal tables absent. The D4 gate reads null as NOT compatible.
        Integer journalCatalogVersion,
        String journalCatalogHash) {
```

Leave the compact constructor's four `Set.copyOf` lines exactly as they are.

**Step 4b — populate it once.** In `GatewayScopeService.resolve()` (`GatewayScopeService.java:93-101`), extend the single `new GatewayScope(...)`:

```java
        return new GatewayScope(
                gateway,
                localUserUuid,
                GatewayScope.Role.from(membership.getGatewayRole()),
                ownedZones,
                grantedZones,
                ownedPlots,
                grantedPlots,
                account.isFieldJournalSupported(),
                account.getJournalCatalogVersion(),
                account.getJournalCatalogHash());
```

**Step 4c — fix every other construction site.** Fifteen call sites construct `GatewayScope`; the two above are the only ones with a real stamp to pass. Every other one appends `, null, null`. Verify the list before editing, because these line numbers drift:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend
grep -rn "new GatewayScope(" src/
```

Expected at this head — 15 hits:

| File | Lines | Edit |
|---|---|---|
| `src/main/java/org/osi/server/scopedaccess/GatewayScopeService.java` | 93 | Step 4b (real values) |
| `src/main/java/org/osi/server/journal/JournalAccessService.java` | 203 | `, null, null` — this is the `Access` 3-arg convenience constructor's inline scope; a stampless scope is correct there, and it is why the catalog tests build their scope explicitly |
| `src/test/java/org/osi/server/journal/JournalAccessServiceTest.java` | 163, 224, 256, 296, 336, 380, 431, 471 | `, null, null` on each of the eight inline fixtures |
| `src/test/java/org/osi/server/journal/JournalAccessServiceTest.java` | 514 | `, null, null` in the private `scope(...)` helper |
| `src/test/java/org/osi/server/journal/JournalQueryServiceTest.java` | 177 | `, null, null` |
| `src/test/java/org/osi/server/scopedaccess/ScopedAccessMutationServiceTest.java` | 54 | `, null, null` |
| `src/test/java/org/osi/server/scopedaccess/ScopedAccessControllerTest.java` | 96 | `, null, null` |
| `src/test/java/org/osi/server/recovery/RecoveryAdminAuthorizerTest.java` | 76 | `, null, null` |

Six of these sit outside the journal package and are easy to miss — `JournalAccessServiceTest`'s `scope(...)` helper at 514, `JournalQueryServiceTest`, both `scopedaccess` tests and `RecoveryAdminAuthorizerTest`. If the grep returns anything not in this table, add it; do not skip it.

**Step 4d — the endpoint.** In `JournalController`, add the endpoint next to the other reads. It reads the stamp off the `Access` it already has, so there is no second service call:

```java
    @GetMapping("/gateways/{gatewayEui}/catalog")
    public JournalCatalogResponse catalog(
            @AuthenticationPrincipal UserDetails userDetails,
            @PathVariable String gatewayEui) {
        User user = userService.findByUsername(userDetails.getUsername());
        // Read authorization only: a viewer may load the catalog; whether they
        // may *write* is decided by require(..., true) on the mutation paths.
        JournalAccessService.Access access = accessService.require(user, gatewayEui, false);
        GatewayScope scope = access.scope();
        return new JournalCatalogResponse(
                catalogService.catalogVersion(),
                catalogService.catalogHash(),
                catalogService.compatibility(
                        scope.journalCatalogVersion(), scope.journalCatalogHash()),
                scope.journalCatalogVersion(),
                scope.journalCatalogHash(),
                catalogService.catalog());
    }
```

Add the `JournalCatalogResponse` record to `JournalView` (or as a top-level record in the journal package, matching the file's existing convention) and add `private final JournalCatalogService catalogService;` to the controller's `@RequiredArgsConstructor` field list.

- [ ] **Step 5: Run every package the widened record touches**

`GatewayScope` is shared, so the blast radius is not just the journal package:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend
./gradlew test --tests 'org.osi.server.journal.*' --tests 'org.osi.server.scopedaccess.*' --tests 'org.osi.server.recovery.*' 2>&1 | tail -15
```

Expected: BUILD SUCCESSFUL. A compile error here names a `new GatewayScope(...)` site Step 4c missed — add it to the table rather than working around it.

- [ ] **Step 6: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add backend/src/main/java/org/osi/server/journal backend/src/main/java/org/osi/server/scopedaccess backend/src/test/java/org/osi/server/journal backend/src/test/java/org/osi/server/scopedaccess backend/src/test/java/org/osi/server/recovery
git commit -m "feat: GET journal/catalog serves the vendored v10 catalog with a fail-closed gateway verdict (S3 T5)"
```

Expected suite delta for T5: **0** frontend tests; **+5** JUnit tests (2 in `JournalCatalogServiceTest`, 3 in `JournalControllerTest`). The fixture-arity edits in the other five test classes change no test count.

---

### Task 6: Cloud frontend, the journal catalog core (byte-copied logic + gated hook)

Reading 5. Copy the four pure modules byte-identically, pin them with a provenance test, and add the cloud's own catalog hook and write-authority helper.

**Files:**
- Rename: `frontend/src/types/journal.ts` → `frontend/src/types/journalMirror.ts` (with importer updates)
- Add (byte copies): `frontend/src/types/journal.ts`, `frontend/src/types/journalCapture.ts`, `frontend/src/journal/catalogModel.ts`, `frontend/src/journal/templateEngine.ts`, `frontend/src/journal/__tests__/templateEngine.test.ts`
- Add: `frontend/src/journal/useJournalCatalog.ts`, `frontend/src/journal/journalCapability.ts`, `frontend/src/journal/__tests__/journalCapability.test.ts`
- Add (node-runner, `frontend/tests/`): `helpers/vendoredCatalog.ts` (shared artifact loader, not a spec), `journalCatalogVendored.test.ts`, `journalCycleActivityContract.test.ts`, `journalCatalogBundleFence.test.ts`, `journalCoreProvenance.test.ts`
- Modify: `frontend/src/services/api.ts` (add `journalAPI.getCatalog`)

**Interfaces:**

```ts
// frontend/src/journal/useJournalCatalog.ts
export interface JournalCatalogState {
  loading: boolean;
  error: unknown;
  catalog: JournalCatalog | undefined;      // byte-copied edge type
  model: JournalCaptureCatalogModel | undefined;
  modelErrors: string[];
  compatibility: 'compatible' | 'gateway_catalog_unknown' | 'gateway_catalog_mismatch' | 'unresolved';
  gatewayCatalogVersion: number | null;
  retry: () => void;
}
export function useJournalCatalog(gatewayEui: string | null): JournalCatalogState;

// frontend/src/journal/journalCapability.ts
export function canWriteJournal(state: GatewayScopeState, catalog: JournalCatalogState): boolean;
export function journalCaptureBlockedReason(
  state: GatewayScopeState, catalog: JournalCatalogState,
): 'loading' | 'no_gateway' | 'viewer' | 'unsupported_gateway' | 'catalog_incompatible' | null;
export const CYCLE_ACTIVITY_CODES: ReadonlySet<string>;
export function captureBlockedForActivity(activityCode: string): boolean;
```

- [ ] **Step 1: Free the `types/journal.ts` name**

The cloud's current `types/journal.ts` holds mirror/desired-state shapes (`JournalResourceKind`, `JournalCanonical`, `JournalResource`, `JournalMutation`), not catalog shapes. Rename it so the byte copy can land on the canonical name:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
git mv src/types/journal.ts src/types/journalMirror.ts
grep -rln "types/journal'" src | xargs sed -i "s|types/journal'|types/journalMirror'|g"
grep -rn "from '.*types/journal'" src | grep -v journalMirror   # expect: no output
```

- [ ] **Step 2: Copy the four modules and the copyable test, byte-identically**

```bash
EDGE=/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui/src
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
mkdir -p src/journal/__tests__
cp "$EDGE/types/journal.ts"                        src/types/journal.ts
cp "$EDGE/types/journalCapture.ts"                 src/types/journalCapture.ts
cp "$EDGE/journal/catalogModel.ts"                 src/journal/catalogModel.ts
cp "$EDGE/journal/templateEngine.ts"               src/journal/templateEngine.ts
cp "$EDGE/journal/__tests__/templateEngine.test.ts" src/journal/__tests__/templateEngine.test.ts
for f in src/types/journal.ts src/types/journalCapture.ts src/journal/catalogModel.ts src/journal/templateEngine.ts src/journal/__tests__/templateEngine.test.ts; do
  sha256sum "$f"
done
```

Do **not** edit these five files — not a comment, not an import. Their whole value is that a `diff` against the edge is empty (T12 Step 3 runs it). If one of them fails to typecheck against the cloud's `tsconfig`, that is a finding to report, not a file to patch.

- [ ] **Step 3: Pin the copies with a provenance test**

Create `frontend/tests/journalCoreProvenance.test.ts`:

```ts
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// These files are byte-copies of the edge journal core (osi-os
// web/react-gui/src). Copy-adapt is the program's sharing rule for page logic
// (D1) — ui-core is capped at eight primitives and admits nothing else — so the
// copies carry no vendor script; this test is the drift alarm. The recorded
// digests are the edge bytes at the commit named below. Changing a copy without
// changing the edge original (and this table) is the failure this catches.
const EDGE_COMMIT = 'e910c01f';
const EXPECTED: Record<string, string> = {
  'src/types/journal.ts': '<sha256 recorded in Step 2>',
  'src/types/journalCapture.ts': '<sha256 recorded in Step 2>',
  'src/journal/catalogModel.ts': '<sha256 recorded in Step 2>',
  'src/journal/templateEngine.ts': '<sha256 recorded in Step 2>',
  'src/journal/__tests__/templateEngine.test.ts': '<sha256 recorded in Step 2>',
};

const frontendRoot = path.resolve(import.meta.dirname, '..');

test(`journal core copies match osi-os @ ${EDGE_COMMIT}`, () => {
  const drifted: string[] = [];
  for (const [relative, expected] of Object.entries(EXPECTED)) {
    const digest = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(frontendRoot, relative)))
      .digest('hex');
    if (digest !== expected) drifted.push(`${relative}: ${digest}`);
  }
  assert.deepEqual(drifted, []);
});
```

Replace each `<sha256 recorded in Step 2>` with the real digest printed by Step 2. Run:

```bash
npx tsx --test tests/journalCoreProvenance.test.ts
```

Expected: PASS.

- [ ] **Step 4: Add the catalog API call and hook**

In `frontend/src/services/api.ts`, inside the existing `journalAPI` object (which already has `journalBase(eui)`):

```ts
  getCatalog: async (gatewayEui: string): Promise<JournalCatalogResponse> => {
    const response = await api.get<JournalCatalogResponse>(
      `${journalBase(gatewayEui)}/catalog`,
    );
    return response.data;
  },
```

with the response type declared next to the other journal types in `frontend/src/types/journalMirror.ts` (add `import type { JournalCatalog } from './journal';` at the top of that file):

```ts
export type JournalCatalogCompatibility =
  | 'compatible'
  | 'gateway_catalog_unknown'
  | 'gateway_catalog_mismatch';

export interface JournalCatalogResponse {
  catalogVersion: number;
  catalogHash: string;
  compatibility: JournalCatalogCompatibility;
  gatewayCatalogVersion: number | null;
  gatewayCatalogHash: string | null;
  catalog: JournalCatalog;
}
```

Create `frontend/src/journal/useJournalCatalog.ts`:

```ts
import useSWR from 'swr';
import { journalAPI } from '../services/api';
import { buildCatalogModel } from './catalogModel';
import type { JournalCatalog } from '../types/journal';
import type { JournalCaptureCatalogModel } from '../types/journalCapture';
import type { JournalCatalogCompatibility } from '../types/journalMirror';

export interface JournalCatalogState {
  loading: boolean;
  error: unknown;
  catalog: JournalCatalog | undefined;
  model: JournalCaptureCatalogModel | undefined;
  modelErrors: string[];
  compatibility: JournalCatalogCompatibility | 'unresolved';
  gatewayCatalogVersion: number | null;
  retry: () => void;
}

export function useJournalCatalog(gatewayEui: string | null): JournalCatalogState {
  const { data, error, isLoading, mutate } = useSWR(
    gatewayEui ? ['journal:catalog', gatewayEui] : null,
    () => journalAPI.getCatalog(gatewayEui as string),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );

  const parsed = data ? buildCatalogModel(data.catalog) : undefined;
  return {
    loading: Boolean(gatewayEui) && isLoading,
    error,
    catalog: data?.catalog,
    model: parsed && parsed.ok ? parsed.model : undefined,
    modelErrors: parsed && !parsed.ok ? parsed.errors : [],
    // Fail closed while unresolved: 'unresolved' is never treated as writable.
    compatibility: data?.compatibility ?? 'unresolved',
    gatewayCatalogVersion: data?.gatewayCatalogVersion ?? null,
    retry: () => { void mutate(); },
  };
}
```

(`buildCatalogModel`'s exact result shape is the copied `CatalogModelResult`; read `catalogModel.ts` and match its discriminant rather than assuming the field names above if they differ.)

- [ ] **Step 5: Write the capability helper and its tests**

Create `frontend/src/journal/journalCapability.ts`:

```ts
import type { GatewayScopeState } from '../contexts/gatewayCapabilities';
import type { JournalCatalogState } from './useJournalCatalog';

/**
 * Journal write authority (D4 + D5, reading 14). Unlike zones and devices,
 * there is no cloud-local journal: every write is an edge command, so a
 * zero-linked-gateway account is denied here rather than "writable".
 */
export function canWriteJournal(
  state: GatewayScopeState,
  catalog: JournalCatalogState,
): boolean {
  return journalCaptureBlockedReason(state, catalog) === null;
}

export type JournalCaptureBlock =
  | 'loading'
  | 'no_gateway'
  | 'viewer'
  | 'unsupported_gateway'
  | 'catalog_incompatible';

export function journalCaptureBlockedReason(
  state: GatewayScopeState,
  catalog: JournalCatalogState,
): JournalCaptureBlock | null {
  if (state.loading || catalog.loading) return 'loading';
  if (state.error !== null) return 'no_gateway';
  if (state.gateways.length === 0 || !state.activeGateway) return 'no_gateway';
  if (state.activeGateway.gatewayRole === 'viewer') return 'viewer';
  if (state.activeGateway.fieldJournalSupported !== true) return 'unsupported_gateway';
  if (catalog.compatibility !== 'compatible') return 'catalog_incompatible';
  return null;
}

/**
 * Activities the cloud cannot capture (reading 6): they open or close a crop
 * cycle, and crop cycles have no mirror table and no sync event, so the cloud
 * cannot disambiguate one. This is EXACTLY the edge's own copyBlockedForActivity
 * set (DetailPanel.tsx:75 = SEEDING_ACTIVITY_CODES ∪ {'harvest'}, where
 * SEEDING_ACTIVITY_CODES = {'seeding', 'planting_transplanting'} at
 * journal/cropCycle.ts:30-32), which blocks copy for the same reason.
 *
 * Two traps, both live: the code is `planting_transplanting`, NOT `planting`
 * — `planting` is not a catalog code, so a set containing it fails OPEN on a
 * real cycle-opening activity. And the neighbouring MANUAL_CLOSE_ACTIVITY_CODES
 * ({'tillage_soil_work','mowing','plant_protection_application'}) is NOT part
 * of the edge's block and must not be added here: those three are ordinary
 * high-frequency activities.
 */
export const CYCLE_ACTIVITY_CODES: ReadonlySet<string> = new Set([
  'seeding',
  'planting_transplanting',
  'harvest',
]);

export function captureBlockedForActivity(activityCode: string): boolean {
  return CYCLE_ACTIVITY_CODES.has(activityCode);
}
```

Create `frontend/src/journal/__tests__/journalCapability.test.ts` covering: loading → `'loading'`; `error !== null` → `'no_gateway'`; zero gateways → `'no_gateway'`; `gatewayRole: 'viewer'` → `'viewer'`; `fieldJournalSupported: false` → `'unsupported_gateway'`; `compatibility: 'gateway_catalog_unknown'` and `'gateway_catalog_mismatch'` and `'unresolved'` → `'catalog_incompatible'`; everything satisfied → `null` and `canWriteJournal === true`.

Plus the drift pair that stops the two repos diverging. The cloud cannot import `cropCycle.ts` (it is not one of the five byte-copied modules), so the binding is made two ways: a transcription pinned **by content** against the edge source, and an existence check against the vendored catalog that fires if the edge ever renames one of the codes. The second one reads the artifact, so **both live in `frontend/tests/journalCycleActivityContract.test.ts`** as node-runner tests — read Step 6's "where artifact-reading tests live" note before writing this file, and create `tests/helpers/vendoredCatalog.ts` (Step 6a) first:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { readVendoredCatalog } from './helpers/vendoredCatalog.ts';
import { CYCLE_ACTIVITY_CODES, captureBlockedForActivity } from '../src/journal/journalCapability.ts';

// Transcribed from osi-os web/react-gui/src/journal/cropCycle.ts:30-32 @ e910c01f.
// DetailPanel.tsx:75 blocks copy for SEEDING_ACTIVITY_CODES ∪ {'harvest'}, and
// cloud capture blocks exactly that — no more (MANUAL_CLOSE_ACTIVITY_CODES is
// deliberately absent), no less (`planting_transplanting`, never `planting`).
const EDGE_SEEDING_ACTIVITY_CODES = ['seeding', 'planting_transplanting'];

test('cloud capture blocks exactly the edge copy-block set, by content', () => {
  assert.deepEqual(
    [...CYCLE_ACTIVITY_CODES].sort(),
    [...EDGE_SEEDING_ACTIVITY_CODES, 'harvest'].sort(),
  );
  // The manual-crop-close activities are NOT blocked — blocking them would make
  // three of the most common activities uncapturable from the cloud.
  for (const code of ['tillage_soil_work', 'mowing', 'plant_protection_application']) {
    assert.equal(captureBlockedForActivity(code), false, `${code} must stay capturable`);
  }
});

test('every blocked code is a real activity in the shipped catalog', () => {
  const activityCodes = new Set(
    readVendoredCatalog().vocab
      .filter((row) => row.kind === 'activity')
      .map((row) => row.code),
  );
  for (const code of CYCLE_ACTIVITY_CODES) {
    assert.equal(activityCodes.has(code), true, `${code} is not a catalog activity`);
  }
  // The historical typo: `planting` is not a catalog code, so a set containing
  // it would silently let a cycle-opening activity through.
  assert.equal(activityCodes.has('planting'), false);
});
```


- [ ] **Step 6: Prove the copied engine against the vendored catalog (denominator gate included)**

This replaces the edge's `catalogModel.test.ts`, which cannot be copied (it imports the edge repo's generator scripts). It asserts the cloud's real question: does the vendored artifact drive the v10 semantics?

**Where artifact-reading tests live, and why — settle this once.** The running app **never** imports the vendored artifact. At runtime the cloud GUI gets its catalog from T5's `GET /api/v1/journal/gateways/{eui}/catalog`, which the backend serves from its own classpath resource. The artifact is **test-only data**, so it belongs on the test-only side of the boundary:

- Every spec that reads the artifact is a **node-runner test in `frontend/tests/`**, run by `tsx --test`, loading the file with `fs.readFileSync` + `JSON.parse`.
- `frontend/tsconfig.json` has `include: ["src"]`, so `tests/` is never typechecked — which is exactly why the existing guards (`errorTokenMisuse`, `deviceCardReadOnlyContract`, `agrolinkBranding`, …) already use `node:fs` and `node:path` with **no `@types/node` anywhere in the tree**. No new dependency, no tsc cost, and `tsx --test` never goes through Vite so Vite's `fs.allow` is irrelevant.
- A `vendoredCatalog.ts` under `src/` would be wrong even if tsc tolerated the 433 KB: it pays a typecheck cost forever and leaves a footgun where one accidental production import ships the whole catalog into the browser bundle. Step 6c makes that impossible rather than merely unlikely.
- **DOM-dependent specs stay Vitest specs in `src/`** and use a small hand-built catalog fixture, never the artifact. Those tests are about rendering behavior, not catalog content.

**Step 6a — the shared loader.** Create `frontend/tests/helpers/vendoredCatalog.ts` (a helper, not a spec: it does not match `*.test.ts`, so neither runner collects it):

```ts
import fs from 'node:fs';
import path from 'node:path';
import type { JournalCatalog } from '../../src/types/journal';

// The one place the vendored artifact is read. Test-only: the running app gets
// its catalog from GET /api/v1/journal/gateways/{eui}/catalog (T5), never from
// this file. Living under tests/ keeps it outside tsconfig's include: ["src"],
// so node:fs needs no @types/node and tsc never types the ~433 KB literal.
export function readVendoredCatalog(): JournalCatalog {
  return JSON.parse(
    fs.readFileSync(
      path.resolve(
        import.meta.dirname,
        '../../../backend/src/main/resources/journal-catalog/journal-catalog.json',
      ),
      'utf8',
    ),
  ) as JournalCatalog;
}
```

**Step 6b — the engine test.** Create `frontend/tests/journalCatalogVendored.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { readVendoredCatalog } from './helpers/vendoredCatalog.ts';
import { allowedProductKindsForOperation, buildCatalogModel } from '../src/journal/catalogModel.ts';
import { deriveFieldStates } from '../src/journal/templateEngine.ts';

const vendored = readVendoredCatalog();
const result = buildCatalogModel(vendored);
if (!result.ok) throw new Error(`vendored catalog does not parse: ${result.errors.join(', ')}`);
const model = result.model;
const layout = model.layouts.get('open_field')!;
const template = model.templates.get('full_record')!;

test('the vendored catalog parses with no model errors', () => {
  assert.equal(result.ok, true);
});

test('full_record@10 carries the v10 operation maps', () => {
  assert.equal(template.version, 10);
  for (const key of ['operation_fields_by_operation', 'operation_requirements',
                     'operation_product_kinds'] as const) {
    assert.ok(Object.keys(template[key] ?? {}).length > 0, `${key} is empty`);
  }
});

// Do NOT assert this with fertilization + mineral_fertilization: those two
// resolutions contain the SAME codes in a different sequence (the activity list
// and that operation's list are the same nine fields reordered), so a
// not-deep-equal check passes on ORDER alone and a subset check holds before and
// after the operation is picked — the test would prove nothing. Use an operation
// whose field list genuinely differs.
test('choosing an operation REPLACES the activity field list, it does not merge', () => {
  // fertilization + primary_tillage: the five product fields drop out,
  // the depth field appears.
  const a = new Set(deriveFieldStates(template, layout, { activity_code: 'fertilization' }).map(s => s.code));
  const b = new Set(deriveFieldStates(template, layout, {
    activity_code: 'fertilization',
    'attr.agroscope.operation': 'agroscope.operation.primary_tillage',
  }).map(s => s.code));
  assert.deepEqual([...a].filter(c => !b.has(c)), [
    'attr.product_uuid', 'attr.product', 'attr.amount_mass_area_product',
    'attr.amount_volume_area_product', 'attr.amount_nutrient_rate',
  ]);
  assert.equal(b.has('attr.amount_operation_depth'), true);
});

// The denominator gate (reading 7): attr.denominator is in open_field's
// minimum_fields AND its static_context_fields AND the template's operation
// scoping, so it must NOT force-appear on an activity whose resolved field
// list does not include it, while still appearing where it belongs.
test('attr.denominator is not forced onto unrelated activities', () => {
  const tillage = deriveFieldStates(template, layout, {
    activity_code: 'tillage_soil_work',
  }).map((state) => state.code);
  assert.equal(tillage.includes('attr.denominator'), false);

  const irrigation = deriveFieldStates(template, layout, {
    activity_code: 'irrigation',
    'attr.agroscope.operation': 'agroscope.operation.watering',
  }).map((state) => state.code);
  assert.equal(irrigation.includes('attr.denominator'), true);
});

test('the product picker narrows per operation', () => {
  assert.deepEqual(allowedProductKindsForOperation(template, {
    'attr.agroscope.operation': 'agroscope.operation.mineral_fertilization',
  }), ['mineral']);
  assert.equal(allowedProductKindsForOperation(template, {}), undefined);
});
```

Leave the denominator-gate test and the `allowedProductKindsForOperation` test semantically exactly as they are — both were run against the real catalog and both genuinely change behaviour; only their assertion syntax moved from Vitest to `node:assert`.

**Step 6c — fence the bundle.** Create `frontend/tests/journalCatalogBundleFence.test.ts`, so the test-only artifact can never reach the browser bundle:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const srcRoot = path.resolve(import.meta.dirname, '../src');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full)
      : /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

// The vendored catalog is TEST DATA. The app reads its catalog from
// GET /api/v1/journal/gateways/{eui}/catalog at runtime. One accidental import
// under src/ would ship ~433 KB of JSON into the browser bundle and add it to
// every `tsc` run, so no module under src/ may reference the artifact or the
// tests/ loader — not even a type-only import.
test('no module under src/ imports the vendored catalog or the tests/ loader', () => {
  const offenders: string[] = [];
  for (const filePath of walk(srcRoot)) {
    const source = fs.readFileSync(filePath, 'utf8');
    if (/journal-catalog\.json|helpers\/vendoredCatalog|readVendoredCatalog/.test(source)) {
      offenders.push(path.relative(srcRoot, filePath));
    }
  }
  assert.deepEqual(offenders, []);
});
```

Before running, confirm each activity/operation code above exists in the vendored artifact (`jq -r '.vocab[] | select(.kind=="activity") | .code'` and `… select(.parent_code=="attr.agroscope.operation") | .code`) and substitute the real codes if any differ — a test that asserts an invented code proves nothing. Also confirm `open_field` is the right layout for these assertions (`jq -r '.layouts[].code'`). For the replacement test specifically, the two field lists it pivots on are readable straight out of the template:

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
sqlite3 database/farming.db "SELECT json_extract(definition_json,'\$.operation_fields_by_activity.fertilization') FROM journal_templates WHERE code='full_record' AND version=10;"
sqlite3 database/farming.db "SELECT json_extract(definition_json,'\$.operation_fields_by_operation.\"agroscope.operation.primary_tillage\"') FROM journal_templates WHERE code='full_record' AND version=10;"
```

Expected: the first prints the nine fertilization fields including the five product ones; the second prints five tillage fields including `attr.amount_operation_depth` and none of the product ones. If they no longer do, the catalog moved and the expected array in the test must be re-derived from these two lists, not adjusted until it passes.

Never write a second read of the artifact — every test goes through `readVendoredCatalog()`. Two options that look plausible are dead ends, recorded here so nobody re-litigates them: a JSON `import` under `src/` compiles (`resolveJsonModule` is enabled) but drags ~433 KB through `tsc` on every build and is exactly what Step 6c forbids; a `?raw` import fails outright, because Vite's `fs.allow` applies under Vitest and `backend/` is outside the Vite root (`frontend/` has its own `package-lock.json`). Node-runner in `tests/` avoids both.

- [ ] **Step 7: Run everything this task touches**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx vitest run --environment jsdom src/journal/__tests__
npx tsx --test tests/journalCoreProvenance.test.ts tests/journalCatalogVendored.test.ts \
                tests/journalCycleActivityContract.test.ts tests/journalCatalogBundleFence.test.ts
npm run test:unit && npm run build
```

Expected: all PASS. `npm run build` is the typecheck proof that the byte-copied modules compile unchanged against the cloud's tsconfig — and, because `tests/` is outside `include: ["src"]`, proof that none of this task's node-runner tests added a single millisecond to it.

- [ ] **Step 8: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/types frontend/src/journal frontend/src/services/api.ts frontend/tests frontend/src/pages frontend/src/components
git commit -m "feat: journal catalog core on cloud — byte-copied model/engine, gated catalog hook (S3 T6)"
```

Expected suite delta for T6: **+9 node-runner tests across +4 files** — `tests/journalCoreProvenance.test.ts` **1**, `tests/journalCatalogVendored.test.ts` **5**, `tests/journalCycleActivityContract.test.ts` **2**, `tests/journalCatalogBundleFence.test.ts` **1**; **+26 Vitest tests across +2 files** — `templateEngine.test.ts` **17** (measured on the edge at head `e910c01f`; the byte copy must report the same 17, and a different number means the copy or its imports were altered) and `journalCapability.test.ts` **9** (one per blocked-reason bullet). `tests/helpers/vendoredCatalog.ts` is a helper and adds no test.

---

### Task 7: Cloud frontend, the catalog-driven entry form

Copy-adapt `EntryForm` and its two field widgets (D1). The rule for this task: **logic is not edited**. Only import paths and color utilities change, and the edge's own component tests come along to prove it.

**Files:**
- Add: `frontend/src/components/journal/capture/EntryForm.tsx`, `.../NutrientRepeater.tsx`, `.../NumberStepper.tsx`
- Add (tests): `frontend/src/components/journal/capture/__tests__/{EntryForm,NutrientRepeater,NumberStepper}.test.tsx`
- Modify: 7× `frontend/public/locales/*/journal.json`
- Add (test): `frontend/tests/journalCaptureLocales.test.ts`, `frontend/tests/journalCaptureReadOnlyContract.test.ts`

**Interfaces:** the copied `EntryForm` props are unchanged from the edge (`model, layout, fieldStates, values, onChange, selections, products, locale, showValidation, templateCode, fieldHints, allowedProductKinds, confirmedChoiceCodes`) plus one addition required by the Global Constraints:

```tsx
// EntryFormProps gains, with NO default (tsc-enforced fail-closed):
  readOnly: boolean;
```

- [ ] **Step 1: Copy the three components and their tests**

```bash
EDGE=/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui/src
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
mkdir -p src/components/journal/capture/__tests__
cp "$EDGE/components/journal/capture/EntryForm.tsx"        src/components/journal/capture/
cp "$EDGE/components/journal/capture/NutrientRepeater.tsx" src/components/journal/capture/
cp "$EDGE/components/journal/capture/NumberStepper.tsx"    src/components/journal/capture/
cp "$EDGE/components/journal/__tests__/capture/EntryForm.test.tsx"        src/components/journal/capture/__tests__/
cp "$EDGE/components/journal/__tests__/capture/NutrientRepeater.test.tsx" src/components/journal/capture/__tests__/
cp "$EDGE/components/journal/__tests__/capture/NumberStepper.test.tsx"    src/components/journal/capture/__tests__/
```

- [ ] **Step 2: Apply the bounded adaptation list — and nothing else**

For each copied file, in this order:

1. **Import depth.** The edge files sit at `src/components/journal/capture/`; so do the cloud copies, so `../../../journal/templateEngine` and `../../../types/journal*` resolve unchanged. Fix only imports that fail to resolve; record each one you changed.
2. **Provenance header.** Prepend to each of the three components (tests get the same, adjusted):

```tsx
// Copy-adapted from osi-os web/react-gui/src/components/journal/capture/<file>
// @ e910c01f (GUI parity D1: copy-adapt pages, share only ui-core). LOGIC IS A
// COPY — behavior changes belong on the edge original and come back through a
// re-copy. Only import paths and color utilities were adapted here.
```

3. **Color utilities → tokens: there is almost nothing to do, and that is the point.** These four files (the three here plus `ActivityPicker` in T8) are **already fully tokenized**. Verified by grepping every Tailwind color utility across all four: the only hardcoded color literal in the set is `text-white`, three times —

   - `EntryForm.tsx:756` — `selected ? 'bg-[var(--primary)] text-white' : …`
   - `EntryForm.tsx:916` — `? 'bg-[var(--primary)] text-white'`
   - `NutrientRepeater.tsx:172` — `? 'border-[var(--primary)] bg-[var(--primary)] text-white'`

   All three are `text-white` **on `bg-[var(--primary)]`**, which is ui-core's own primary-filled pairing (`ui-core/Button.tsx:7`: `bg-[var(--primary)] … text-white`). **Copy them unchanged.** Changing them here would make the journal chips disagree with every other primary-filled control on both GUIs, and the pairing's AA problem is system-wide, not something this task can fix locally — it is ledgered in T11 instead.

   Every other color these files use is already a token, and every one of those tokens is defined in the byte-shared `ui-core/tokens.css` (verified identical between repos at this head): `--border`, `--card`, `--error-bg`, `--error-text`, `--focus`, `--primary`, `--secondary-bg`, `--surface`, `--text`, `--text-disabled`, `--text-secondary`, `--text-tertiary`. Nothing to remap. **Do not go looking for hardcoded colors to replace** — the files this task copies are frozen except for the four adaptations listed here, and an unnecessary color edit is a byte-parity violation, not an improvement.

   The two standing constraints still bind on any class string this task does write: never `bg-[var(--X)]/NN` (Tailwind 3.4 emits nothing for an alpha-modified `var()` — use `bg-[color-mix(in_srgb,var(--X)_NN%,transparent)]`, guarded by `noInertTokenAlpha`), and never a `*-bg` token in a `text-`/`fill-`/`stroke-`/`caret-`/`placeholder-`/`decoration-` utility (guarded by `errorTokenMisuse`). `--text-tertiary` on `--bg` is **4.39:1 in light — below AA**, so it stays card-only.

4. **The required `readOnly` prop.** Add `readOnly: boolean` to `EntryFormProps` with **no default**, and thread it: every `<input>`, `<select>`, `<textarea>`, the "Change" button that unlocks the operation chip, and `NutrientRepeater`/`NumberStepper` receive `disabled={readOnly || …}`. Do not add a default value anywhere in the chain — the tsc error on an unthreaded mount is the guard. Note what this implies for Step 3: the copied test files land inside `src/`, `tsconfig.json` has `include: ["src"]`, and `npm run build` is `tsc && vite build`, so **every copied `<EntryForm …/>` mount is a compile error until it passes `readOnly`**. Fixing those mounts is expected work, not a copy violation — see Step 3.
5. **Nothing else.** No renamed function, no reordered field, no "while I'm here" cleanup. Any behavior difference you believe is required is a finding to report, not an edit.

- [ ] **Step 3: Make the copied tests pass**

```bash
npx vitest run --environment jsdom src/components/journal/capture/__tests__
```

Expect this to fail to *compile* before it fails to run: the copied specs mount `<EntryForm>` without `readOnly`, which Step 2 made required.

Fix failures in this priority order, and record which category each fix fell into:
- **required-prop plumbing** — add `readOnly={false}` at every copied mount and to any shared props fixture the spec builds. This is **not** a behavior edit: it is what makes the fail-closed prop tsc-enforced, and it is the direct consequence of Step 2 item 4. Without it `npm run build` in Step 5 cannot pass;
- **import/mount plumbing** (i18n provider, test-utils path): fix freely;
- **class-name assertions** that pinned an edge color utility: there should be none — the copied files carry no color literal but `text-white`, which is copied unchanged (Step 2 item 3). If a class-name assertion does fail, that is a finding to report, not an expectation to rewrite;
- **behavior assertions**: do **not** touch. A failing behavior assertion means the copy was altered; revert the alteration.

Then pin the requirement negatively, so a future `readOnly?:` or `= false` cannot slip back in unnoticed. Add to `frontend/src/components/journal/capture/__tests__/EntryForm.test.tsx`:

```tsx
it('does not compile without readOnly (fail-closed prop, tsc-enforced)', () => {
  // @ts-expect-error readOnly is required with no default: an unthreaded mount
  // must be a build error, not a silently writable form. If this line ever
  // stops erroring, @ts-expect-error itself fails the build — which is the
  // alarm. Deliberately never rendered; the assertion is the type check.
  const unthreaded = <EntryForm {...baseProps} readOnly={undefined as never} />;
  expect(unthreaded).toBeDefined();
});
```

Write it against whatever the file's real props fixture is called; the load-bearing part is that `@ts-expect-error` sits on a mount that omits (or nulls) `readOnly` and that `npm run build` in Step 5 covers this file.

- [ ] **Step 4: Locale keys**

The copied components call `t()` in the `journal` namespace with the edge's `capture.form.*`, `capture.validation.*` and `row.*` keys. The cloud's `journal.json` has 47 keys and none of those. Create `frontend/tests/journalCaptureLocales.test.ts` (same skeleton as `frontend/tests/deviceDenialLocales.test.ts`) that (a) collects every `t('…')` literal in `src/components/journal/**` and `src/pages/JournalPage.tsx`, and (b) asserts each key exists in **all seven** locale files. Run it (FAIL), then port the needed subtrees from the edge's `web/react-gui/public/locales/<locale>/journal.json` — copy the *existing translations* for each locale rather than re-translating, and keep `lg` as the edge has it (machine-draft, pending the human-native gate). Only invent a translation for a key the edge does not have; for those, follow the S2 table idiom and mark `lg` machine-draft.

```bash
npx tsx --test tests/journalCaptureLocales.test.ts
```

Expected: PASS, with all seven locales carrying an identical key set (the existing `src/journal/__tests__/journalLocales.test.ts` already enforces set equality and must stay green).

**What this test does not cover, stated so nobody mistakes it for exhaustive.** The copied capture surface's locale usage is **36 static `t('…')` keys plus one dynamic call**, `` t(`${code}:${groupIndex}`) ``, whose key is assembled at runtime from a catalog code and an index. A literal-collecting test cannot see that one, so a missing conditional-group label will not fail CI — it will render as a raw key in the GUI. Record it in the T11 ledger alongside catalog i18n; do not try to enumerate the dynamic keys here (the set is catalog-derived and moves with the catalog version).

- [ ] **Step 5: Add the journal `readOnly` node guard**

Sibling to S2's `frontend/tests/deviceCardReadOnlyContract.test.ts`, which pins the *declarations* where tsc only pins the call sites. Same ten-line shape, same reasoning, new file list:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const captureRoot = path.resolve(import.meta.dirname, '../src/components/journal/capture');
const CAPTURE_FILES = ['EntryForm.tsx', 'NutrientRepeater.tsx', 'NumberStepper.tsx'];

// Same reasoning as deviceCardReadOnlyContract: an optional prop or a
// `= false` default makes any unthreaded future mount silently writable.
// tsc enforces call sites; this enforces the declarations themselves.
test('journal capture components declare readOnly as required with no fail-open default', () => {
  for (const file of CAPTURE_FILES) {
    const source = fs.readFileSync(path.join(captureRoot, file), 'utf8');
    assert.ok(!/readOnly\?\s*:/.test(source), `${file}: optional readOnly?`);
    assert.ok(!/readOnly\s*=\s*false/.test(source), `${file}: readOnly = false default`);
    assert.ok(/readOnly\s*:/.test(source), `${file}: readOnly prop missing entirely`);
  }
});
```

Save as `frontend/tests/journalCaptureReadOnlyContract.test.ts`. T8 adds `ActivityPicker.tsx` to `CAPTURE_FILES` if that component takes `readOnly`; if it does not (it is a picker, not a field), leave the list at three and say so in a comment.

```bash
npx tsx --test tests/journalCaptureReadOnlyContract.test.ts
```

Expected: PASS.

- [ ] **Step 6: Run the task's suites**

```bash
npx vitest run --environment jsdom src/components/journal src/journal
npx tsx --test 'tests/**/*.test.ts'
npm run build
```

Expected: all PASS; the build proves `readOnly` is threaded everywhere it is required, and that the `@ts-expect-error` negative test still errors.

- [ ] **Step 7: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/components/journal/capture frontend/public/locales frontend/tests/journalCaptureLocales.test.ts frontend/tests/journalCaptureReadOnlyContract.test.ts
git commit -m "feat: catalog-driven journal EntryForm on cloud — operation chip, product kinds, required readOnly (S3 T7)"
```

Expected suite delta for T7: **+2 node-runner tests** (`journalCaptureLocales`, `journalCaptureReadOnlyContract`); **+41 Vitest tests across +3 files** — `EntryForm.test.tsx` **27** copied + **1** new `@ts-expect-error` test = 28, `NutrientRepeater.test.tsx` **4**, `NumberStepper.test.tsx` **9**. The three copied counts are measured on the edge at head `e910c01f`; a different number after copying means a spec was dropped or altered.

---

### Task 8: Cloud frontend, the capture modal and the real entry payload

Reading 4 and reading 6. `ActivityPicker` is copy-adapted; the 2,905-line `JournalCaptureFlow` is **not** ported — the cloud modal is a reduced composition over the same `EntryForm` (D7), and the payload builder replaces `builders.buildNewEntry`'s `cloud.quick` fiction (reading 3).

**Files:**
- Add: `frontend/src/components/journal/capture/ActivityPicker.tsx` (copy-adapt), `frontend/src/components/journal/capture/JournalCaptureModal.tsx`
- Add: `frontend/src/journal/entryPayload.ts`
- Add (tests): `frontend/src/components/journal/capture/__tests__/JournalCaptureModal.test.tsx` (Vitest — DOM, hand-built fixture)
- Add (node-runner, `frontend/tests/`): `journalEntryPayload.test.ts`, `helpers/catalogOrphanContract.ts` (shared assertion, not a spec)
- Modify: 7× locales

**T8 is purely additive on `builders.ts`.** `builders.buildNewEntry` **stays** until T9 removes its last caller: `frontend/src/pages/JournalPage.tsx:16` imports it and `:151` calls it, and T9 Step 3 is what rewrites that page. Deleting it here breaks `npm run build` at this task's own gate (Step 7). The deletion and the removal of its `builders.test.ts` case are T9 Step 3's work.

**Interfaces:**

```ts
// frontend/src/journal/entryPayload.ts
export interface CapturePlot {
  plot_uuid: string;
  plot_code: string;
  name: string | null;
  zone_uuid: string | null;
  crop_hint: string | null;
  owner_user_uuid: string;
  settings: { layout_code: string };
}
export interface CaptureInput {
  entryUuid: string;
  plot: CapturePlot;
  activityCode: string;
  templateCode: string;
  templateVersion: number;
  layoutCode: string;
  layoutVersion: number;
  catalogVersion: number;
  occurredStartUtc: string;      // ISO-8601 Z
  occurredTimezone: string;
  occurredUtcOffsetMinutes: number;
  note: string;
  values: CaptureEntryValueOutput[];   // from the copied templateEngine
}
export function buildCaptureEntry(input: CaptureInput): JournalCanonical;
export function resolveCaptureDefinitions(
  model: JournalCaptureCatalogModel, layoutCode: string,
): { layout: JournalLayoutDefinition; template: JournalTemplateDefinition } | null;
```

- [ ] **Step 1: Write the failing payload tests**

`entryPayload` is pure logic that reads the vendored artifact, so its spec is a **node-runner test in `frontend/tests/`** (T6 Step 6's rule). Create `frontend/tests/journalEntryPayload.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { readVendoredCatalog } from './helpers/vendoredCatalog.ts';       // T6 Step 6a
import { assertNoCatalogOrphan } from './helpers/catalogOrphanContract.ts'; // below
import { buildCatalogModel } from '../src/journal/catalogModel.ts';
import { buildCaptureEntry, resolveCaptureDefinitions } from '../src/journal/entryPayload.ts';

const vendored = readVendoredCatalog();
const parsed = buildCatalogModel(vendored);
if (!parsed.ok) throw new Error('vendored catalog does not parse');

const plot = {
  plot_uuid: '11111111-1111-4111-8111-111111111111',
  plot_code: 'A1',
  name: 'North strip',
  zone_uuid: '22222222-2222-4222-8222-222222222222',
  crop_hint: 'wheat',
  owner_user_uuid: '33333333-3333-4333-8333-333333333333',
  settings: { layout_code: 'open_field' },
};

function captureInput() {
  const resolved = resolveCaptureDefinitions(parsed.model, 'open_field')!;
  return {
    entryUuid: '44444444-4444-4444-8444-444444444444',
    plot,
    activityCode: 'irrigation',
    templateCode: resolved.template.code,
    templateVersion: resolved.template.version,
    layoutCode: resolved.layout.code,
    layoutVersion: resolved.layout.version,
    catalogVersion: vendored.catalog_version,
    occurredStartUtc: '2026-08-05T09:30:00.000Z',
    occurredTimezone: 'Europe/Zurich',
    occurredUtcOffsetMinutes: 120,
    note: ' watered the strip ',
    values: [],
  };
}

test('resolves the layout from the plot and the template from the layout', () => {
  const resolved = resolveCaptureDefinitions(parsed.model, 'open_field');
  assert.notEqual(resolved, null);
  assert.equal(resolved!.layout.code, 'open_field');
  assert.equal(resolved!.template.code, 'full_record');
  assert.ok(resolved!.layout.supported_templates.includes(resolved!.template.code));
});

test('returns null for a layout the catalog does not have', () => {
  assert.equal(resolveCaptureDefinitions(parsed.model, 'quick'), null);
});

test('never emits the cloud.quick placeholder the edge cannot resolve', () => {
  const entry = buildCaptureEntry(captureInput());

  assert.equal(entry.template_code, 'full_record');
  assert.equal(entry.layout_code, 'open_field');
  assert.equal(entry.catalog_version, 10);
  assert.equal(entry.status, 'final');
  assert.equal(entry.base_sync_version, 0);
  assert.equal(entry.plot_uuid, plot.plot_uuid);
  assert.equal(entry.zone_uuid, plot.zone_uuid);
  assert.equal(entry.note, 'watered the strip');
  assert.equal(entry.origin, 'cloud-ui');
  // Cycle-owning fields stay absent: the cloud cannot resolve a crop cycle.
  for (const field of ['season_uuid', 'season_crop', 'pass_uuid', 'batch_uuid'] as const) {
    assert.equal(entry[field], null, `${field} must be null`);
  }
});

test('emits every field the JournalEntry contract marks required', () => {
  const entry = buildCaptureEntry(captureInput());
  for (const field of [
    'contract_version', 'entry_uuid', 'plot_uuid', 'zone_uuid', 'device_eui',
    'season_uuid', 'season_crop', 'season_variety', 'campaign_uuid',
    'protocol_code', 'protocol_version', 'observation_unit_code', 'pass_uuid',
    'batch_uuid', 'activity_code', 'template_code', 'template_version',
    'layout_code', 'layout_version', 'catalog_version', 'occurred_start',
    'occurred_end', 'occurred_timezone', 'occurred_utc_offset_minutes',
    'recorded_at', 'origin', 'status', 'voided_at', 'voided_by_principal_uuid',
    'void_reason', 'note', 'context_json', 'created_at', 'updated_at',
    'deleted_at', 'values',
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(entry, field), `missing ${field}`);
  }
});

// Reading 3's orphan class, closed structurally. buildCaptureEntry cannot
// emit 'cloud.quick' — it copies the codes out of resolveCaptureDefinitions —
// but "cannot today" is not a guarantee, and the backend validates NOTHING
// about template_code (grep: zero hits for template_code/layout_code/
// catalog_version in backend/src/main/java/org/osi/server/journal/**).
test('emits only (code, version) pairs the vendored catalog contains', () => {
  assertNoCatalogOrphan(buildCaptureEntry(captureInput()));
});
```

(`owner_user_uuid`, `author_principal_uuid`, `author_label`, `sync_version` and `gateway_device_eui` are deliberately **not** in that list: `JournalMutationService.applyKindIdentity` stamps them server-side and a client value would be overwritten.)

Create the shared assertion `frontend/tests/helpers/catalogOrphanContract.ts`, used by this file and by T10's `journalEntryCopy.test.ts` — one rule, one place. It is a helper, not a spec, and it lives beside the loader on the test-only side of the boundary:

```ts
import assert from 'node:assert/strict';
import { readVendoredCatalog } from './vendoredCatalog.ts';
import type { JournalCanonical } from '../../src/types/journalMirror.ts';

const vendored = readVendoredCatalog();
const TEMPLATES = new Set(vendored.templates.map((row) => `${row.code}@${row.version}`));
const LAYOUTS = new Set(vendored.layouts.map((row) => `${row.code}@${row.version}`));

/**
 * Every payload any cloud journal module can emit must name a template and a
 * layout the target gateway's catalog actually contains. The pre-S3 page shipped
 * `cloud.quick@1` / `quick@1`, which no gateway catalog has; the edge stored
 * those entries UNVALIDATED (its definition-driven checks are all guarded on the
 * definition rows existing) and neither GUI can correct or copy them since.
 * Nothing server-side prevents a repeat, so the guard lives here.
 */
export function assertNoCatalogOrphan(entry: JournalCanonical): void {
  assert.ok(TEMPLATES.has(`${entry.template_code}@${entry.template_version}`),
    `unknown template ${entry.template_code}@${entry.template_version}`);
  assert.ok(LAYOUTS.has(`${entry.layout_code}@${entry.layout_version}`),
    `unknown layout ${entry.layout_code}@${entry.layout_version}`);
  assert.equal(entry.catalog_version, vendored.catalog_version);
}
```

Run:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx tsx --test tests/journalEntryPayload.test.ts
```

Expected: FAIL (module missing).

- [ ] **Step 2: Implement the payload module**

Create `frontend/src/journal/entryPayload.ts`, reproducing the edge's resolution rule (reading 4) and the contract's field set:

```ts
import type { JournalCanonical } from '../types/journalMirror';
import type {
  CaptureEntryValueOutput,
  JournalCaptureCatalogModel,
  JournalLayoutDefinition,
  JournalTemplateDefinition,
} from '../types/journalCapture';

// Edge rule (JournalCaptureFlow.tsx:817-819, 986-996): the layout comes from
// the plot's settings, the template from that layout's supported_templates,
// ordered farmer_quick < full_record < research_observation. The cloud pins
// full_record when the layout supports it — it is the template that carries the
// v10 operation scoping — and otherwise takes the first supported template.
const TEMPLATE_ORDER = ['farmer_quick', 'full_record', 'research_observation'];

export function resolveCaptureDefinitions(
  model: JournalCaptureCatalogModel,
  layoutCode: string,
): { layout: JournalLayoutDefinition; template: JournalTemplateDefinition } | null {
  const layout = model.layouts.get(layoutCode);
  if (!layout) return null;
  const supported = layout.supported_templates
    .map((code) => model.templates.get(code))
    .filter((candidate): candidate is JournalTemplateDefinition => candidate != null)
    .sort((left, right) =>
      TEMPLATE_ORDER.indexOf(left.code) - TEMPLATE_ORDER.indexOf(right.code)
      || left.code.localeCompare(right.code));
  const template = supported.find((candidate) => candidate.code === 'full_record')
    ?? supported[0];
  return template ? { layout, template } : null;
}

export function buildCaptureEntry(input: CaptureInput): JournalCanonical {
  const note = input.note.trim();
  return {
    contract_version: 1,
    entry_uuid: input.entryUuid,
    base_sync_version: 0,
    plot_uuid: input.plot.plot_uuid,
    zone_uuid: input.plot.zone_uuid,
    device_eui: null,
    season_uuid: null,
    season_crop: null,
    season_variety: null,
    campaign_uuid: null,
    protocol_code: null,
    protocol_version: null,
    observation_unit_code: null,
    pass_uuid: null,
    batch_uuid: null,
    activity_code: input.activityCode,
    template_code: input.templateCode,
    template_version: input.templateVersion,
    layout_code: input.layoutCode,
    layout_version: input.layoutVersion,
    catalog_version: input.catalogVersion,
    occurred_start: input.occurredStartUtc,
    occurred_end: null,
    occurred_timezone: input.occurredTimezone,
    occurred_utc_offset_minutes: input.occurredUtcOffsetMinutes,
    recorded_at: input.occurredStartUtc,
    origin: 'cloud-ui',
    status: 'final',
    voided_at: null,
    voided_by_principal_uuid: null,
    void_reason: null,
    note: note || null,
    context_json: null,
    created_at: input.occurredStartUtc,
    updated_at: input.occurredStartUtc,
    deleted_at: null,
    values: input.values,
  };
}
```

Leave `frontend/src/journal/builders.ts` alone in this task. `buildNewEntry` still has a live caller (`pages/JournalPage.tsx:16, :151`), so deleting it now would fail this task's own `npm run build` in Step 7; T9 Step 3 rewrites that page and takes the deletion with it. `browserEntryClock`, `buildEntryUpdate` (T10 replaces its body), `buildNewPlot`, `buildNewPlotGroup`, `buildNewCustomVocab` and `updateReferenceResource` all survive S3 — the reference panel still uses them.

Run the Step 1 command. Expected: PASS.

- [ ] **Step 3: Copy-adapt `ActivityPicker`**

```bash
EDGE=/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui/src
cp "$EDGE/components/journal/capture/ActivityPicker.tsx" \
   /home/phil/Repos/osi-server/.worktrees/agrolink/frontend/src/components/journal/capture/
cp "$EDGE/components/journal/__tests__/capture/ActivityPicker.test.tsx" \
   /home/phil/Repos/osi-server/.worktrees/agrolink/frontend/src/components/journal/capture/__tests__/
```

Apply the same bounded adaptation list as T7 Step 2 (provenance header, import fixes, `readOnly` if the component has any interactive control that must be disabled, no logic edits, and **no color edits** — `ActivityPicker.tsx` contains zero hardcoded color utilities, verified). If it does gain a required `readOnly`, add `'ActivityPicker.tsx'` to `CAPTURE_FILES` in `frontend/tests/journalCaptureReadOnlyContract.test.ts` (T7 Step 5); if it does not, leave that list at three and note why in the test's comment. The edge picker's shortlist sections (`plotRecent`, `seasonCommon`, `farmRecent`, `layoutFallback`, `zoneLinked`) come from `activityShortlist.ts`, which the cloud does not copy; pass the picker a shortlist built from the cloud's own mirrored entries (most-recent-first distinct `activity_code` on the selected plot, then on the gateway) or, if the copied component requires the full shortlist shape, supply the same shape with the cloud-derivable sections populated and the others empty. Whichever you choose, state it in the component's provenance header.

Additionally: activities in `CYCLE_ACTIVITY_CODES` (T6) render **disabled with the translated reason** `capture.activity.cycleUnavailableOnCloud` rather than being hidden — a farmer who expects "Seeding" must learn why it is not offered, not wonder where it went.

- [ ] **Step 4: Write the capture modal**

Create `frontend/src/components/journal/capture/JournalCaptureModal.tsx`. Composition (D7 — this deliberately does not replicate the edge's four-step wizard chrome; it is one scrolling ui-core `Modal` with the same field order):

```tsx
interface JournalCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  gatewayEui: string;
  plots: CapturePlot[];
  catalog: JournalCatalogState;
  gatewayScope: GatewayScopeState;
  onSaved: (mutation: JournalMutation) => void;
}
```

Body, top to bottom:

1. **Plot**: `FormField` + `<select className={INPUT_CLASS}>` over `plots` (label: `name ?? plot_code`). Selecting a plot resolves `resolveCaptureDefinitions(model, plot.settings.layout_code)`; a plot whose layout the catalog does not have renders the translated `capture.where.unknownLayout` message and blocks Next — never a silent fallback.
2. **Activity**: `<ActivityPicker>` over the resolved layout's activity leaves.
3. **When**: `FormField` + `<input type="datetime-local">` defaulting to now in the browser timezone, plus a read-only line showing the resolved timezone. The cloud does **not** port the edge's ambiguous-offset selects (DST fold handling): it sends `occurred_utc_offset_minutes` from the browser and lets the edge resolve. Record as a deviation.
4. **`<EntryForm …readOnly={false} confirmedChoiceCodes={OPERATION_CONFIRMED_CHOICE_CODES} allowedProductKinds={allowedProductKindsForOperation(template, selections)} products={catalog.catalog?.products ?? []} />`** — the whole v10 body, including the operation chip and the denominator gate, comes from T6/T7 with no cloud-specific branching.
5. **Save**: ui-core `<Button>`; `disabled={saving || !canWriteJournal(gatewayScope, catalog) || !plot || !activityCode || !formValid}`.

Gating, stated explicitly per the plan requirements:
- **Capability (D4):** when `journalCaptureBlockedReason(...) === 'unsupported_gateway'` or `'catalog_incompatible'`, the modal body is replaced by a ui-core `<Banner tone="warn">` carrying `capture.unavailable.title` + a reason-specific detail key, and the Save button is not rendered. `--warn-text` on `--warn-bg` = **6.37:1 light / 11.02:1 dark**.
- **Fail-closed scope (D5):** `'loading'` renders the same banner shell with `capture.unavailable.loading` and no Save button — denied while unresolved, never optimistically open. `'viewer'` and `'no_gateway'` likewise.
- **D3:** the modal shows the active gateway's EUI as read-only text with a Settings pointer when `hasMultipleGateways`; it never renders a gateway selector.

Save path:

```tsx
    const resolved = resolveCaptureDefinitions(catalog.model!, plot.settings.layout_code)!;
    const occurrence = occurrenceFromLocalInput(occurredLocal);   // local helper, tested
    const mutation = await journalAPI.createEntry(gatewayEui, buildCaptureEntry({
      entryUuid: crypto.randomUUID(),
      plot,
      activityCode,
      templateCode: resolved.template.code,
      templateVersion: resolved.template.version,
      layoutCode: resolved.layout.code,
      layoutVersion: resolved.layout.version,
      catalogVersion: catalog.catalog!.catalog_version,
      occurredStartUtc: occurrence.utc,
      occurredTimezone: occurrence.timezone,
      occurredUtcOffsetMinutes: occurrence.offsetMinutes,
      note,
      values: buildEntryValues(fieldStates, values),   // copied templateEngine
    }));
    onSaved(mutation);
```

- [ ] **Step 5: Modal tests**

Create `frontend/src/components/journal/capture/__tests__/JournalCaptureModal.test.tsx`. This is a **DOM spec, so it stays a Vitest test under `src/`** — and it therefore uses a small hand-built catalog fixture (one layout, one template, two or three activities), **never** the vendored artifact: it tests rendering and gating behaviour, not catalog content, and `src/` must stay free of any artifact reference (T6 Step 6c fences this). Cover, with real assertions:
- a compatible gateway renders the form and posts a payload whose `template_code` is `full_record` and whose `values` are non-empty when the form is filled;
- `compatibility: 'gateway_catalog_mismatch'` renders the not-available banner and **no** Save button (D4);
- `gatewayRole: 'viewer'` renders the banner and no Save button (D5);
- `catalog.loading === true` renders the loading banner and no Save button (deny while unresolved);
- selecting a cycle activity is impossible: the option is disabled and carries the translated reason (reading 6);
- `hasMultipleGateways` shows the Settings pointer and **no** `<select>` for gateways (D3) — assert `queryAllByRole('combobox')` contains no gateway control.

- [ ] **Step 6: Locale keys**

Add to all seven `journal.json` files: `capture.where.unknownLayout`, `capture.activity.cycleUnavailableOnCloud`, `capture.unavailable.title`, `capture.unavailable.loading`, `capture.unavailable.viewer`, `capture.unavailable.unsupportedGateway`, `capture.unavailable.catalogMismatch`, `capture.gatewayTarget`, `capture.switchOnSettings`, `capture.saving`, `capture.save`.

| Key | en | de-CH | fr | it | es | pt | lg (machine draft) |
|---|---|---|---|---|---|---|---|
| `capture.where.unknownLayout` | This plot uses a field layout this catalog does not contain. Record the entry on the gateway. | Diese Parzelle nutzt ein Feldlayout, das dieser Katalog nicht enthält. Erfassen Sie den Eintrag auf dem Gateway. | Cette parcelle utilise une disposition absente de ce catalogue. Saisissez l'entrée sur le gateway. | Questa particella usa un layout assente da questo catalogo. Registra la voce sul gateway. | Esta parcela usa un diseño que no está en este catálogo. Registra la entrada en el gateway. | Esta parcela usa um esquema ausente deste catálogo. Registe a entrada no gateway. | Ennimiro eno ekozesa entegeka etali mu katalogu eno. Wandiika ku gateway. |
| `capture.activity.cycleUnavailableOnCloud` | Activities that open or close a crop cycle are recorded on the gateway. | Tätigkeiten, die einen Kulturzyklus öffnen oder schliessen, werden auf dem Gateway erfasst. | Les activités qui ouvrent ou ferment un cycle de culture se saisissent sur le gateway. | Le attività che aprono o chiudono un ciclo colturale si registrano sul gateway. | Las actividades que abren o cierran un ciclo de cultivo se registran en el gateway. | As atividades que abrem ou fecham um ciclo de cultura registam-se no gateway. | Emirimu egisumulula oba egiggala omuzunguzo gw'ebirime giwandiikibwa ku gateway. |
| `capture.unavailable.title` | Recording is not available for this gateway | Erfassung für dieses Gateway nicht verfügbar | Saisie indisponible pour ce gateway | Registrazione non disponibile per questo gateway | Registro no disponible para este gateway | Registo indisponível para este gateway | Okuwandiika tekusoboka ku gateway eno |
| `capture.unavailable.loading` | Checking what this gateway supports… | Prüfe, was dieses Gateway unterstützt … | Vérification des capacités du gateway… | Verifica delle funzioni del gateway… | Comprobando qué admite este gateway… | A verificar o que este gateway suporta… | Tukebera bya gateway eno by'esobola… |
| `capture.unavailable.viewer` | Your access to this gateway is read-only. | Ihr Zugriff auf dieses Gateway ist schreibgeschützt. | Votre accès à ce gateway est en lecture seule. | Il tuo accesso a questo gateway è in sola lettura. | Tu acceso a este gateway es de solo lectura. | O seu acesso a este gateway é apenas de leitura. | Okuyingira kwo ku gateway eno kwa kusoma kwokka. |
| `capture.unavailable.unsupportedGateway` | This gateway does not run the field journal. | Auf diesem Gateway läuft das Feldjournal nicht. | Ce gateway n'exécute pas le journal de terrain. | Questo gateway non esegue il diario di campo. | Este gateway no ejecuta el diario de campo. | Este gateway não executa o diário de campo. | Gateway eno tekoze na jaanolo y'ennimiro. |
| `capture.unavailable.catalogMismatch` | This gateway runs a different activity catalog. Update the gateway, then record from here. | Dieses Gateway nutzt einen anderen Tätigkeitskatalog. Aktualisieren Sie das Gateway und erfassen Sie dann hier. | Ce gateway utilise un autre catalogue d'activités. Mettez-le à jour, puis saisissez ici. | Questo gateway usa un altro catalogo di attività. Aggiornalo, poi registra da qui. | Este gateway usa otro catálogo de actividades. Actualízalo y luego registra aquí. | Este gateway usa outro catálogo de atividades. Atualize-o e depois registe aqui. | Gateway eno ekozesa katalogu ya mirimu ndala. Gitereeze, olwo owandiike wano. |
| `capture.gatewayTarget` | Recording on gateway | Erfassung auf Gateway | Saisie sur le gateway | Registrazione sul gateway | Registro en el gateway | Registo no gateway | Okuwandiika ku gateway |
| `capture.switchOnSettings` | You can switch the active gateway on the Settings page. | Sie können das aktive Gateway auf der Einstellungsseite wechseln. | Vous pouvez changer de gateway actif sur la page des réglages. | Puoi cambiare il gateway attivo nella pagina delle impostazioni. | Puedes cambiar el gateway activo en la página de ajustes. | Pode mudar o gateway ativo na página de definições. | Osobola okukyusa gateway ekozesebwa ku lupapula lw'enteekateeka. |
| `capture.saving` | Saving… | Speichern … | Enregistrement… | Salvataggio… | Guardando… | A guardar… | Tuterekera… |
| `capture.save` | Save entry | Eintrag speichern | Enregistrer l'entrée | Salva voce | Guardar entrada | Guardar entrada | Tereka ekiwandiiko |

- [ ] **Step 7: Run**

```bash
npx vitest run --environment jsdom src/components/journal src/journal
npx tsx --test 'tests/**/*.test.ts'
npm run test:unit && npm run build
```

Expected: all PASS.

- [ ] **Step 8: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/components/journal/capture frontend/src/journal frontend/tests frontend/public/locales
git commit -m "feat: cloud journal capture modal writes real full_record@10 entries (S3 T8)"
```

Expected suite delta for T8: **+5 node-runner tests across +1 file** (`tests/journalEntryPayload.test.ts` — the four in the Step 1 snippet plus the orphan test); **+20 Vitest tests across +2 files** — `ActivityPicker.test.tsx` **14** (measured on the edge at head `e910c01f`), `JournalCaptureModal.test.tsx` **6** (one per Step 5 bullet). `tests/helpers/catalogOrphanContract.ts` is a helper, not a spec, and adds no test file.

---

### Task 9: Cloud frontend, the journal workspace replaces the thin page

Reading 10 and reading 13. The page loses its bespoke green header, its cream body (already flattened in T1), its in-page gateway selector and its `<ol>`; it gains a scope rail, a sortable entry table and the capture entry point.

**Files:**
- Rewrite: `frontend/src/pages/JournalPage.tsx`
- Add: `frontend/src/components/journal/workspace/ScopeRail.tsx`, `frontend/src/components/journal/workspace/EntryTable.tsx`
- Add (tests): `frontend/src/components/journal/workspace/__tests__/{ScopeRail,EntryTable}.test.tsx`
- Modify (tests): `frontend/src/pages/__tests__/JournalPage.test.tsx`, `frontend/src/journal/__tests__/builders.test.ts`
- Modify: `frontend/src/journal/builders.ts` (delete `buildNewEntry` — this task removes its last caller), 7× locales

**Interfaces:**

```ts
export interface JournalEntryFilters {
  plotUuid: string;          // '' = all plots
  activityCode: string;      // '' = all activities
  status: 'all' | 'final' | 'voided';
  occurredFrom: string;      // '' = unbounded, yyyy-mm-dd
  occurredTo: string;
  search: string;
}
export function filterEntries(
  entries: JournalResource[], filters: JournalEntryFilters,
): JournalResource[];
export const ENTRY_PAGE_SIZE = 50;
```

- [ ] **Step 1: Write the failing filter/table tests**

Create `frontend/src/components/journal/workspace/__tests__/EntryTable.test.tsx` asserting, against fixture resources: activity filter narrows; plot filter narrows; `status: 'voided'` shows only voided rows; the date range is inclusive on both ends and compares on `occurred_start` in the *entry's* timezone-independent UTC instant; free-text search matches note and activity label but not UUIDs; sorting by each column toggles direction; the pager shows 50 rows per page and the page resets when a filter changes (the S1/S2 pagination bug shape — a stale page index over a shortened list). Also assert that a row shows plot, status and author label, which today's `<ol>` omits.

Run:

```bash
npx vitest run --environment jsdom src/components/journal/workspace/__tests__
```

Expected: FAIL (modules missing).

- [ ] **Step 2: Implement `ScopeRail` and `EntryTable`**

`ScopeRail` (single-sided, cloud composition — the edge rail's station/group scopes have no cloud equivalent because the cloud list endpoint takes no scope argument): a `<Surface>` holding a search `<input className={INPUT_CLASS}>`, an activity `<select>` labelled with `catalogLabel(activityRow, locale)` from the copied model (**not** an i18n key — reading 9's resolution path), a status `<select>`, and two `<input type="date">` fields, all controlled by the page. Every label is a `t()` key.

`EntryTable`: a ui-core `<TableShell>` with `occurred | activity | plot | status` columns, client-side sort and a 50-row client pager (reading 13). Each row renders `PendingStateNotice` for its desired-state operation exactly as the current page does, so pending cloud writes stay visible. Rows are selectable and report the selection up (T10 mounts the detail panel on it).

Tokens: `--text` on `--card` for row text (17.85 / 14.28), `--text-secondary` for column headers (10.35 / 9.38), `--text-tertiary` for the timestamp *inside the card* (4.76 / 5.65 — card-only, per the Global Constraints). Status uses ui-core `<Chip>`: final → `tone="success"` (`--success-text` on `--success-bg`, 8.30 / 11.35), voided → `tone="warn"` (6.37 / 11.02).

- [ ] **Step 3: Rewrite the page**

`frontend/src/pages/JournalPage.tsx` becomes:

- shell: `<div className="min-h-screen bg-[var(--bg)] text-[var(--text)]">` (T1's line, unchanged);
- header: replace the bespoke `bg-[#123c2d]` block with a token header — `bg-[var(--header-bg)]` with `text-[var(--header-text)]` (**20.50:1 light / 15.85:1 dark**) and `--header-subtext` for the sign-in line — keeping the Refresh / Dashboard / Logout controls as ui-core `<Button variant="secondary">`. Do not import `DashboardHeader`: it is the dashboard's add-zone/add-device chrome and pulling it in would drag those affordances onto the journal page;
- **delete** the gateway `<select>` (D3) and consume `useGateway()`; when `hasMultipleGateways`, render the read-only active-EUI line + `capture.switchOnSettings` pointer;
- body: `lg:grid-cols-[300px_minmax(0,1fr)]` — `<ScopeRail>` left, `<EntryTable>` right — with the "Log activity" `<Button>` in the table header, rendered only when `canWriteJournal(gatewayScope, catalogState)`, opening `<JournalCaptureModal>`;
- capability/scope states, explicit: `journalCaptureBlockedReason` `'loading'` → a `<Banner tone="info">` above the table and no capture button (deny while unresolved, D5); `'viewer'` → `<Banner tone="info">` with `capture.unavailable.viewer`, table fully readable; `'unsupported_gateway'` / `'catalog_incompatible'` → `<Banner tone="warn">` with the matching key (D4's explicit not-available state, never a broken page); `'no_gateway'` → `<EmptyState>` pointing at account linking. **Reads keep working in every one of these states** — only capture is withheld;
- keep the CSV/JSON export buttons and `<JournalReferencePanel>` exactly as they are (they work and are not in S3's scope), moving the panel under the rail;
- keep the optimistic-insert behavior on save, which the existing page test pins.

**Then, and only now, retire `buildNewEntry`** (deferred here from T8 because this page was its last caller). The rewrite removes `frontend/src/pages/JournalPage.tsx:16`'s import and `:151`'s call; with those gone, delete `buildNewEntry` and its private `EntryDraft` interface from `frontend/src/journal/builders.ts`, and delete the `builds a complete final entry aggregate for edge validation` case plus the `buildNewEntry` import from `frontend/src/journal/__tests__/builders.test.ts`. Keep every other export in that module — `browserEntryClock`, `buildEntryUpdate` (T10 replaces its body), `buildNewPlot`, `buildNewPlotGroup`, `buildNewCustomVocab`, `updateReferenceResource` — all still used by `JournalReferencePanel`. Confirm the last caller is gone before deleting:

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
grep -rn "buildNewEntry" src/
```

Expected after the rewrite and before the deletion: two hits, both in `src/journal/` (the definition and the test import). Expected after the deletion: no output. If any `src/pages` or `src/components` hit remains, the rewrite is incomplete — finish it rather than keeping the function alive.

- [ ] **Step 4: Update the page test**

`frontend/src/pages/__tests__/JournalPage.test.tsx` keeps its three existing behaviors (renders desired state and submits while pending; a non-`field_journal_v1` gateway is read-only; continued pending edits rewrite against the original canonical version) and gains: no gateway `<select>` is rendered even with two linked gateways (D3); a `gateway_catalog_mismatch` gateway shows the warn banner and no capture button but still lists entries (D4).

- [ ] **Step 5: Locale keys**

Add `workspace.*` keys for the rail labels, table column headers, sort labels, pager text and the empty state, in all seven locales; port the edge's `journal.workspace.*` translations where a key matches, following T7 Step 4's rule (copy the edge's existing translations; only invent for keys the edge lacks, marking `lg` machine-draft). Re-run `tests/journalCaptureLocales.test.ts` and `src/journal/__tests__/journalLocales.test.ts`.

- [ ] **Step 6: Run**

```bash
npx vitest run --environment jsdom src/pages src/components/journal
npx tsx --test 'tests/**/*.test.ts'
npm run test:unit && npm run build
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/pages/JournalPage.tsx frontend/src/pages/__tests__/JournalPage.test.tsx frontend/src/components/journal/workspace frontend/src/journal/builders.ts frontend/src/journal/__tests__/builders.test.ts frontend/public/locales
git commit -m "feat: journal workspace replaces the thin page; no in-page gateway selector (S3 T9, D3/D4/D5)"
```

Expected suite delta for T9: **0** node-runner tests; **+14 Vitest tests across +2 files** — `EntryTable.test.tsx` **+9** (one per Step 1 bullet), `ScopeRail.test.tsx` **+4**, `JournalPage.test.tsx` **+2** (the two new D3/D4 cases, on top of its three existing ones), `builders.test.ts` **−1** (the deleted `buildNewEntry` case). This is the only task whose count moves in both directions; if the net is not +14, say which spec differed and why in the execution report rather than adjusting the total.

---

### Task 10: Cloud frontend, detail panel with correction and create-only copy

Reading 3 (corrections must carry real definitions) and the spec's copy-an-entry requirement. Copy semantics are create-only and never mutate the source; the cloud version is a reduced port of the edge's `EntryCopyForm` with the cycle-dependent parts removed (reading 6).

**Files:**
- Add: `frontend/src/components/journal/workspace/DetailPanel.tsx`
- Add: `frontend/src/journal/entryCorrection.ts`, `frontend/src/journal/entryCopy.ts`
- Add (tests): `frontend/src/journal/__tests__/entryCorrection.test.ts`, `frontend/src/components/journal/workspace/__tests__/DetailPanel.test.tsx` (Vitest — DOM, hand-built fixture)
- Add (node-runner, `frontend/tests/`): `journalEntryCopy.test.ts`
- Modify: `frontend/src/journal/builders.ts` (`buildEntryUpdate` now delegates), 7× locales

**Interfaces:**

```ts
export function buildCorrectionPayload(
  source: JournalCanonical, edited: { note: string; values: CaptureEntryValueOutput[] },
  baseSyncVersion: number, updatedAt: string,
): JournalCanonical;                       // PUT against the SOURCE entry_uuid

export const OMITTED_COPY_VALUE_CODE = 'attr.actuation_expectation_id';
export function buildCopyPayload(
  source: JournalCanonical, edited: { note: string; values: CaptureEntryValueOutput[] },
  copyEntryUuid: string, occurredStartUtc: string,
  occurredTimezone: string, occurredUtcOffsetMinutes: number,
  model: JournalCaptureCatalogModel,       // added: the copy must verify what it carries
): JournalCanonical | null;                // POST with a FRESH uuid, base_sync_version 0;
                                           // null when the source's definitions are
                                           // absent from the catalog (orphan source)
```

**Why `buildCopyPayload` takes the model and can return `null`.** `buildCaptureEntry` takes the `{layout, template}` object `resolveCaptureDefinitions` returns, rather than four loose `templateCode`/`templateVersion`/`layoutCode`/`layoutVersion` strings/numbers (S3 T8 review fix, finding 3) — so the codes it emits are read off an actual resolved catalog definition, not retyped by the caller. That makes a hand-fabricated `cloud.quick`-style orphan pair a deliberate act rather than an easy mistake — it is a much better default, **not a proof**: TypeScript is structurally typed, so a caller can still hand-build a matching object literal and pass it through. `assertNoCatalogOrphan` is the guard that actually closes that gap, and it stays regardless of this signature. `buildCopyPayload` has no such protection at all: it carries `template_code` / `template_version` / `layout_code` / `layout_version` **straight off the source entry**, and the backend validates none of them (verified: zero hits for `template_code`, `layout_code` or `catalog_version` anywhere in `backend/src/main/java/org/osi/server/journal/`). Copying a pre-S3 `cloud.quick@1` orphan would therefore mint a brand-new orphan. Returning `null` puts the guard **in the function**, not only in the panel that calls it: Step 3's detail panel already hides Correct and Copy for unresolvable entries, but a second call site added later would inherit the check for free.

- [ ] **Step 1: Write the failing copy/correction tests**

`buildCopyPayload` needs a catalog model to run its orphan guard, so its spec reads the vendored artifact and is therefore a **node-runner test**: create `frontend/tests/journalEntryCopy.test.ts` (`node:test` + `node:assert`, importing `readVendoredCatalog` and `assertNoCatalogOrphan` from `./helpers/`, and `buildCopyPayload` from `../src/journal/entryCopy.ts`), asserting the load-bearing properties, each traceable to the edge's `entryCopy.ts` header:
- the payload's `entry_uuid` is the caller-supplied fresh uuid, **never** the source's, and `base_sync_version` is `0` (A6: a copy is a create, not a correction);
- the same `copyEntryUuid` passed twice produces the same uuid, so an ack retry re-POSTs one create rather than two;
- `attr.actuation_expectation_id` is stripped from `values` (A3: carrying it would falsely link the copy to a valve command);
- `season_uuid`, `season_crop`, `season_variety` are `null` — never carried from the source (A5; the cloud cannot re-derive them without crop cycles, so it emits null and lets the edge resolve);
- `occurred_start` is the caller's new instant, `occurred_end` is `null`;
- `plot_uuid`, `campaign_uuid`, `protocol_code`, `protocol_version`, `observation_unit_code`, `activity_code`, `template_code/version`, `layout_code/version` carry from the source;
- `pass_uuid`, `batch_uuid`, `device_eui`, `context_json` are omitted/null;
- **the function never calls an update API** — assert structurally (the module imports no updater) and behaviorally (the returned payload's `base_sync_version` is 0, which a PUT would reject);
- **a source whose definitions the catalog does not contain yields `null`, not a payload** — pass a fixture source carrying `template_code: 'cloud.quick', template_version: 1, layout_code: 'quick', layout_version: 1` (the exact pre-S3 orphan shape) and assert `buildCopyPayload(...) === null`. Copying an orphan must not mint a second one;
- **every payload the module can emit passes the catalog contract** — reuse T8's shared assertion: `assertNoCatalogOrphan(buildCopyPayload(...)!)` for each non-null case in this file, importing it from `./helpers/catalogOrphanContract.ts`. Same import, same rule, in `tests/journalEntryPayload.test.ts` and `tests/journalEntryCopy.test.ts`, so neither builder can drift into emitting a template the gateway does not have.

`buildCorrectionPayload` needs no catalog, so its spec stays a Vitest test in `src/`: create `frontend/src/journal/__tests__/entryCorrection.test.ts` asserting: the payload keeps the source's `entry_uuid`; `base_sync_version` is the caller-supplied version (the page passes `desiredState?.baseSyncVersion ?? canonical.sync_version ?? 0`, the rule today's page test already pins); template/layout/catalog fields are carried from the source unchanged (a correction must not silently retemplate an entry); `status` stays `'final'`. The split across runners is not arbitrary — it is the artifact boundary: the module that reads the catalog is tested where the catalog may be read.

- [ ] **Step 2: Implement the two adapters**

Write `entryCorrection.ts` and `entryCopy.ts` as **separate modules with no shared mode flag**, matching the edge's deliberate split (comment A7 on `DetailPanel.tsx:895-901`): a copy that can accidentally become an update is the failure mode the split exists to prevent. `entryCopy.ts` must not import anything from `entryCorrection.ts` and must not reference `journalAPI.updateEntry`. Point `builders.buildEntryUpdate` at `buildCorrectionPayload` so there is one correction shape.

`buildCopyPayload` opens with the orphan guard, before it builds anything:

```ts
  const template = model.templates.get(source.template_code);
  const layout = model.layouts.get(source.layout_code);
  // A copy carries the source's template/layout verbatim, and nothing
  // server-side checks them. If the catalog has no such definition the source
  // is a pre-S3 orphan (reading 3) — refuse rather than mint a second one.
  if (!template || template.version !== source.template_version
      || !layout || layout.version !== source.layout_version) {
    return null;
  }
```

Match `model.templates` / `model.layouts`' real lookup shape from the byte-copied `catalogModel.ts` — if it indexes by `(code, version)` rather than by code with a `version` field, use its accessor rather than the shape assumed above.

- [ ] **Step 3: Build the detail panel**

`frontend/src/components/journal/workspace/DetailPanel.tsx`, a `<Surface>` beside the table with `mode: 'view' | 'correct' | 'copy'`:

- **view**: activity label (`catalogLabel`), status `<Chip>`, plot · occurred time, a `<dl>` of `campaign_uuid`, `protocol_code`, `observation_unit_code`, `season_crop`, `note`, then the `values` list rendered through the copied model (attribute label + value + unit label) — the cloud's first rendering of `values` at all;
- **actions row**, only when `canWrite && status === 'final' && mode === 'view'`: `Correct`, `Copy`, `Void`. `Void` moves here from the page's `window.prompt` into a `<Modal>` with a required reason `<textarea>`; the prompt goes away;
- **`Copy` is hidden entirely — not disabled — for `captureBlockedForActivity(activity_code)`** (the edge hides it for the same reason: the copy form has no cycle UI);
- **correct / copy** render `<EntryForm>` seeded from the entry's stored values, `readOnly={false}`, with the operation chip already holding the stored operation (T7's chip logic makes it read-only-with-Change automatically, which is the point of `confirmedChoiceCodes`);
- an entry whose `template_code`/`layout_code` the catalog cannot resolve (the pre-S3 `cloud.quick` orphans, reading 3) renders the translated `detail.unresolvableTemplate` line and offers **neither** Correct nor Copy — the same degradation the edge GUI shows for those rows, rather than a broken form.

- [ ] **Step 4: Panel tests**

`DetailPanel.test.tsx` is a DOM spec, so it stays a Vitest test in `src/` and uses a small hand-built catalog fixture, never the vendored artifact (T6 Step 6c fences `src/` against it). Cover: view renders values and the plot/status/author the old `<ol>` omitted; Copy is absent for a cycle activity; Copy posts a *create* with a fresh uuid while the source resource in state is untouched (assert the source object is referentially unchanged and no update call was made); Correct puts against the source uuid with the pinned base version; Void requires a non-empty reason and posts it; an unresolvable-template entry offers neither Correct nor Copy.

- [ ] **Step 5: Locale keys**

Add `detail.*` keys (field labels, the three actions, the void dialog, `detail.unresolvableTemplate`, `detail.copyUnavailableForActivity`) to all seven locales, porting the edge's `workspace.detail.*` translations where they match.

- [ ] **Step 6: Run**

```bash
npx vitest run --environment jsdom src/components/journal src/journal src/pages
npx tsx --test 'tests/**/*.test.ts'
npm run test:unit && npm run build
```

Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/components/journal/workspace frontend/src/journal frontend/tests frontend/public/locales
git commit -m "feat: journal detail panel with correction and create-only copy-an-entry (S3 T10)"
```

Expected suite delta for T10: **+9 node-runner tests across +1 file** (`tests/journalEntryCopy.test.ts` — one per Step 1 bullet, the last two being the orphan-source `null` case and the `assertNoCatalogOrphan` sweep); **+10 Vitest tests across +2 files** — `entryCorrection.test.ts` **4**, `DetailPanel.test.tsx` **6** (one per Step 4 bullet).

---

### Task 11: Update the GUI-parity matrix (S3 rows)

Per the matrix rules: only touched rows change, each touched row gets today's provenance date, and nothing flips to `parity` — S3 ran no `agrolink-test-01` walkthrough. All edits in `docs/superpowers/plans/agrolink-gui-parity-matrix.md` (osi-os).

**Files:**
- Modify: `docs/superpowers/plans/agrolink-gui-parity-matrix.md`

- [ ] **Step 1: Replace the two journal rows**

```markdown
| Field journal | `web/react-gui/src/pages/JournalPage.tsx` (imports `components/journal/desktop/JournalWorkspace`) | partial (pending walkthrough): the cloud page is no longer the pre-v10 monolith — it drops its in-page gateway selector (D3 violation, S3 T9), adopts the token page shell and header (S3 T1/T9), and composes a scope rail + entry table + detail panel over the byte-copied edge catalog model and template engine (S3 T6). Capture writes real `full_record@10` entries resolved from the plot's layout (S3 T8), replacing the `cloud.quick@1` placeholder that no gateway catalog contains. Deviations: single-plot only, final-only (drafts never sync), no cycle-opening/closing activities (exactly the edge's `{seeding, planting_transplanting, harvest}`), core-scoped vocab and products only — a user's own custom vocab and farm products are invisible to cloud capture even though the cloud mirrors and creates custom vocab — no tank-mix pass, no DST fold selects, client-side filtering/paging; all forced by what the cloud mirror and the build-time catalog artifact carry (S3 readings 6 and 13) | pending | 2026-08-05 verified (S3) |
| Journal entry table | `web/react-gui/src/components/journal/desktop/EntryTable.tsx` | partial (pending walkthrough), was `missing`: cloud `components/journal/workspace/EntryTable.tsx` ships the same `occurred / activity / plot / status` columns, client-side sort and a 50-row pager matching the edge's `PAGE_SIZE`; rows render plot, status and author, which the pre-S3 `<ol>` omitted, plus `PendingStateNotice` per row. Deviation: the edge's filter-bound server cursor is not ported — the cloud filters and pages client-side over the mirrored list (S3 reading 13, S4 candidate) | pending | 2026-08-05 verified (S3) |
```

- [ ] **Step 2: Append three S3 rows to "Edge screens and widgets"**

```markdown
| Journal capture flow | `web/react-gui/src/components/journal/capture/JournalCaptureFlow.tsx` (2905 lines) + `EntryForm.tsx` (1064) | partial (pending walkthrough): `EntryForm`, `NutrientRepeater` and `NumberStepper` are copy-adapted onto tokens with a required `readOnly` prop and the edge component tests copied alongside (S3 T7); `ActivityPicker` likewise (S3 T8). The 2905-line flow itself is deliberately NOT ported — its bulk is crop cycles, tank-mix passes, batches, carry-forward, layout transitions and drafts, none of which the cloud mirror can express — so cloud `JournalCaptureModal.tsx` is a reduced D7 composition over the same `EntryForm` | pending | 2026-08-05 verified (S3) |
| Journal detail panel (view / correct / copy / void) | `web/react-gui/src/components/journal/desktop/DetailPanel.tsx` (1117 lines) | partial (pending walkthrough), was absent from this matrix: cloud `components/journal/workspace/DetailPanel.tsx` renders stored `values` for the first time, moves Void out of `window.prompt` into a reasoned modal, and ships correction plus create-only copy as two separate modules with no shared mode flag, mirroring the edge's A7 split (S3 T10). Copy is hidden — not disabled — for cycle activities, as on the edge | pending | 2026-08-05 verified (S3) |
| Journal catalog delivery (v10) | `conf/.../osi-journal/catalog.js` + `api.js catalogDto` serving `GET /api/journal/catalog?include=definitions` | partial (pending walkthrough): the cloud had **no catalog of any kind** before S3. It now serves a byte-vendored artifact generated from the shipped `database/farming.db` (`scripts/export-journal-catalog.js` → `docs/contracts/journal-catalog/journal-catalog.json` → `backend/src/main/resources/journal-catalog/`), gated in CI on both sides (S3 T2/T3), behind `GET /api/v1/journal/gateways/{eui}/catalog` with a fail-closed compatibility verdict against the catalog version/hash the gateway already advertises at bootstrap (S3 T4/T5). Deviations: catalog labels stay English on both sides — the shipped `labels_json` has no non-`en` keys (S3 reading 9); and the artifact is the **global** half of what a gateway serves, so the caller's `scope='custom'` vocab and `scope='farm'` products — which the edge merges per principal in `loadCatalog` — are missing from the cloud's copy (S3 reading 6) | pending | 2026-08-05 verified (S3) |
```

- [ ] **Step 3: Update the page-shell state of the three swept pages**

Append to the "History dashboard" row's cloud-status cell, keeping its existing text and updating only its provenance date: `; page shell rethemed to bg-[var(--bg)]/text-[var(--text)] from hardcoded bg-slate-100 (S3 T1 cohesion sweep; the page's inner surfaces are still S4's)`. Do the same for "Cross-zone analysis": `; page shell rethemed to bg-[var(--bg)]/text-[var(--text)] from bg-slate-100/text-slate-950, keeping h-screen (load-bearing for its min-h-0 scroll panes) — inner surfaces still S4's`.

- [ ] **Step 4: Extend the open ledger**

Add to the "Open retheme/parity ledger" section:

```markdown
- **Catalog i18n is the Uganda `lg` ship gate and S3 explicitly did not do it.** Every `labels_json` in the shipped catalog is English-only (zero non-`en` keys in `0019__journal_catalog_v1.sql` and `0032__journal_catalog_v10.sql`), so a non-English user of either GUI gets a translated shell around English activity, attribute, unit and choice labels. Both GUIs already resolve `labels[locale] ?? labels.en ?? code`, so this is a **data** change: add locale keys to the `labels` in `scripts/journal-catalog-core.js`, publish a new catalog version through `scripts/generate-journal-catalog.js`, re-run the row-content gate, re-export and re-vendor the artifact. No GUI code changes. Owner: the journal catalog program, not a GUI slice.
- **Pre-S3 cloud journal entries are catalog orphans.** Every entry created by the old cloud page carries `template_code: 'cloud.quick'@1` / `layout_code: 'quick'@1`, which no gateway catalog contains; the edge stored them unvalidated (its definition-driven checks are all guarded on the definition rows existing) and neither GUI can Correct or Copy them. S3 stops creating them and degrades gracefully on them; repairing the existing rows needs a data decision (void-and-recapture vs. a targeted correction) and is not scheduled.
- **Cloud journal list has no server-side filter, sort or paging.** `GET …/journal/gateways/{eui}/entries` takes only `includeDeleted`; S3 filters and pages client-side over the whole mirrored list. The `(gateway_eui, plot_uuid, occurred_start DESC, entry_uuid)` index exists for the server-side version. S4 candidate.
- **Cloud capture omits the edge's DST fold handling.** The edge resolves an ambiguous local time with explicit offset selects; the cloud sends the browser's `occurred_utc_offset_minutes` and lets the edge resolve. An entry recorded during a fold hour can land in the wrong offset. Same defect class as the edge copy-form's ledgered DST fold-hour MINOR.
- **Edge header sizing inconsistency (recorded, unassigned to S3).** Edge nav tabs are `glass-tab px-5 py-2 text-[15px]` while Settings/Account use `LIQUID_SIZING` (`px-3 py-2.5 text-base sm:px-6 sm:py-3 sm:text-lg`, 18px desktop), so primary navigation reads as less important than secondary chrome. Assigned to the dedicated frontend-designer review scheduled after S3's code is complete.
- **Journal reference panel is unreviewed by S3.** `JournalReferencePanel.tsx` still creates plots with hardcoded `crop_hint: ''` / `area_m2: null` and custom vocab with `labels_json = {"en": label}` only, and its plot-group create path does not surface the backend's C9 owner-only rule until the request fails. S3 left it working and untouched; it belongs to whichever slice next owns journal reference data.
- **`text-white` on `var(--primary)` measures 5.17:1 light / 1.86:1 dark — fails AA in dark theme.** (Recomputed from `ui-core/tokens.css` at this head: `--primary` is `#2563EB` light, `#2DD4BF` dark; the review note's 5.31 light was slightly off, 5.17 is the figure, and it matches the `--primary`-on-`--card` 5.17 already in the Global Constraints because `--card` is `#FFFFFF` in light.) Pre-existing and system-wide: identical in `ui-core/Button.tsx:7`'s primary variant and in every primary-filled chip on BOTH GUIs (`EntryForm.tsx:756`, `:916`, `NutrientRepeater.tsx:172` are the three in the copied capture surface). The real fix is an `--on-primary` token in canonical ui-core, re-vendored to osi-server — a ui-core change, therefore out of S3's scope by the closed-primitive-set rule. Routed to the frontend-designer review scheduled after S3's code is complete. S3 copies the pairing unchanged rather than making the journal disagree with everything else.
- **Cloud capture cannot see custom vocab or farm products.** The vendored artifact is `scope='core'` only; the edge merges the caller's `scope='custom'` vocab and `scope='farm'` products into every catalog it serves (`osi-journal/catalog.js` `loadScopedRows`). The cloud already mirrors custom vocab in `journal_vocab_mirror` **and lets users create it** in `JournalReferencePanel`, so a cloud user can create a term and then not find it in the capture form. Fix shape: merge the principal's mirrored custom rows into `GET …/journal/gateways/{eui}/catalog`'s response on the read path (the rows are already there; the build-time artifact is the wrong carrier). Not scheduled.
- **Nothing server-side stops a cloud client from minting a catalog orphan.** S3 closes the door on the client: `buildCaptureEntry` derives its template/layout from the catalog, `buildCopyPayload` returns `null` for a source the catalog cannot resolve, and a shared test assertion checks every emittable payload against the vendored artifact. But `JournalMutationService` validates **no** `template_code`, `layout_code` or `catalog_version` (zero hits across `backend/src/main/java/org/osi/server/journal/`), so any other client — or a future cloud module that skips the builders — can still write `cloud.quick@1`. The only thing that truly closes the door is a server-side check in `JournalMutationService` against the vendored artifact, rejecting an unknown `(template_code, template_version)` / `(layout_code, layout_version)` with a 422. Small, well-scoped, not in S3.
- **The capture surface has one locale key a literal-collecting test cannot see.** `frontend/tests/journalCaptureLocales.test.ts` covers the 36 static `t('…')` keys in the copied capture components, but `EntryForm` also calls `` t(`${code}:${groupIndex}`) `` for conditional-group labels, assembled at runtime from a catalog code. A missing key there renders as a raw string in the GUI and fails no test. Its key set moves with the catalog version, so it belongs with catalog i18n above, not with the chrome translations.
```

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add docs/superpowers/plans/agrolink-gui-parity-matrix.md
git commit -m "docs: matrix S3 rows — journal capture partial pending walkthrough"
```

---

### Task 12: Full cross-repo verification sweep

No code changes. Every gate S3 could have disturbed runs once, from clean state.

- [ ] **Step 1: Edge journal CI set**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
node scripts/export-journal-catalog.js --check
node scripts/test-export-journal-catalog.js
sh scripts/verify-journal-catalog-vendor.test.sh
node scripts/generate-journal-catalog.js --check
node scripts/test-journal-catalog-generator.js
node scripts/test-journal-schema.js 2>&1 | tail -5
node scripts/verify-agroscope-linkage.js 2>&1 | tail -3
node scripts/verify-sync-contract.js 2>&1 | tail -3
node scripts/verify-profile-parity.js 2>&1 | tail -3
```

Expected: all OK. The row-content gate and the Agroscope-linkage gate must be untouched — S3 changed no catalog row, no migration and no bundled DB. If either moves, stop: something wrote to the catalog that should not have.

Also confirm the two new edge workflows exist and trigger where they must:

```bash
grep -A4 '^on:' .github/workflows/journal-catalog.yml
grep -c 'export-journal-catalog' .github/workflows/field-journal.yml
```

Expected: `journal-catalog.yml` triggers on `push`/`pull_request` for `AgroLink` (not `main`/`master`), and `field-journal.yml` carries the two exporter steps (`2`).

- [ ] **Step 2: Edge GUI suite (unchanged, proven unchanged)**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git status --short
git diff --stat 719b5e4e..HEAD -- web/react-gui conf
cd web/react-gui && npm run test:unit 2>&1 | grep -E '^# (tests|pass|fail)|Test Files|Tests '
```

Expected: the diff over `web/react-gui` and `conf` is **empty** (S3 touches only `scripts/`, `docs/` and `.github/` on the edge, plus the two pre-existing edge fixes already in the baseline); the suite still reports 107 node-runner tests and 1,689 Vitest across 169 files.

- [ ] **Step 3: Byte-parity of the copied journal core**

```bash
EDGE=/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui/src
CLOUD=/home/phil/Repos/osi-server/.worktrees/agrolink/frontend/src
for f in types/journal.ts types/journalCapture.ts journal/catalogModel.ts journal/templateEngine.ts journal/__tests__/templateEngine.test.ts; do
  diff -u "$EDGE/$f" "$CLOUD/$f" && echo "OK $f"
done
```

Expected: five `OK` lines and no diff output. A diff here means a copy was edited — revert the edit rather than re-recording the digest.

- [ ] **Step 4: Every vendor verifier and self-test, both directions**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
sh scripts/verify-ui-core-vendor.test.sh
EDGE_UI_CORE_ROOT=/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep sh scripts/verify-ui-core-vendor.sh
sh scripts/verify-journal-catalog-vendor.test.sh
EDGE_CATALOG_ROOT=/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep sh scripts/verify-journal-catalog-vendor.sh
sh scripts/verify-edge-sync-contract-vendor.test.sh
EDGE_CONTRACT_ROOT=/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep sh scripts/verify-edge-sync-contract-vendor.sh
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
sh scripts/verify-ui-core-vendor.test.sh
OSI_SERVER_ROOT=/home/phil/Repos/osi-server/.worktrees/agrolink sh scripts/verify-ui-core-vendor.sh
sh scripts/verify-journal-catalog-vendor.test.sh
OSI_SERVER_ROOT=/home/phil/Repos/osi-server/.worktrees/agrolink sh scripts/verify-journal-catalog-vendor.sh
```

Expected: ten `OK` lines — three verifier pairs plus the edge's two self-tests. S3 changed no ui-core file and no sync-contract file, so those are unchanged from S2; the journal catalog pair is new and must be byte-identical in both directions.

- [ ] **Step 5: Cloud backend**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/backend
./gradlew test --tests 'org.osi.server.journal.*' --tests 'org.osi.server.user.*' --tests 'org.osi.server.sync.*' 2>&1 | tail -10
```

Expected: BUILD SUCCESSFUL. If a Testcontainers IT in `org.osi.server.sync.*` needs the docker-java `api.version=1.44` workaround on this machine, apply it per the reference memory rather than skipping the test.

- [ ] **Step 6: Cloud frontend suite and build**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npm run test:unit 2>&1 | grep -E '^# (tests|pass|fail)|Test Files|Tests '
npm run build
```

Expected, as a number to check rather than a direction to observe. Summing the per-task deltas onto the 2026-08-05 baselines (**70** node-runner, **431 Vitest across 98 files**). Note where the tests live: every spec that reads the vendored artifact is a node-runner test in `frontend/tests/` (T6 Step 6), which is why the node-runner column carries most of the pure-logic work and the Vitest column is DOM specs plus the byte-copied `templateEngine`:

| Task | node-runner | Vitest | Vitest files |
|---|---|---|---|
| T1 `pageShellTokens` 1 | +1 | 0 | 0 |
| T6 `journalCoreProvenance` 1 + `journalCatalogVendored` 5 + `journalCycleActivityContract` 2 + `journalCatalogBundleFence` 1 / `templateEngine` 17 + `journalCapability` 9 | +9 | +26 | +2 |
| T7 `journalCaptureLocales` 1 + `journalCaptureReadOnlyContract` 1 / `EntryForm` 27+1 + `NutrientRepeater` 4 + `NumberStepper` 9 | +2 | +41 | +3 |
| T8 `journalEntryPayload` 5 / `ActivityPicker` 14 + `JournalCaptureModal` 6 | +5 | +20 | +2 |
| T9 — / `EntryTable` 9 + `ScopeRail` 4 + `JournalPage` 2 − `builders` 1 | 0 | +14 | +2 |
| T10 `journalEntryCopy` 9 / `entryCorrection` 4 + `DetailPanel` 6 | +9 | +10 | +2 |
| **Expected total** | **96** | **542** | **109** |

The five copied specs' counts (`templateEngine` 17, `EntryForm` 27, `NutrientRepeater` 4, `NumberStepper` 9, `ActivityPicker` 14) were measured on the edge at head `e910c01f` and must reproduce exactly; a copied spec that reports fewer tests lost a case in transit. The new specs' counts are one-per-bullet from their tasks and may legitimately differ by a case or two — if a total is off, say **which** file and by how many in the execution report, and do not adjust the table to match. A total *lower* than 96 / 542 is a stop condition: something is being skipped.

Two helper modules (`tests/helpers/vendoredCatalog.ts`, `tests/helpers/catalogOrphanContract.ts`) match neither runner's collection glob and must appear in **neither** count. If the node-runner file count is two higher than expected, the runner is collecting helpers as specs — fix the naming, do not accept the number.

Backend, over the same window: **+9 JUnit tests** (T4 +4, T5 +5). The build is also the tsc proof that every required `readOnly`/`canWrite` prop is threaded and that T7's `@ts-expect-error` mount still errors.

- [ ] **Step 7: Scope audit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git log --oneline -12 -- frontend backend scripts .github
git status --short
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git log --oneline -6
git status --short
```

Expected: only files named in this plan's File map appear in the S3 commits; no `terra-intelligence` or Terra composition-root path; no edge runtime file (`flows.json`, `osi-journal/*.js`, `web/react-gui/src/**`); both worktrees clean. If anything else shows up, stop and report before proceeding.
