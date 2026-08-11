# AgroLink GUI parity matrix

One row per edge screen and load-bearing widget. Cloud status: `missing` /
`partial` / `parity` / `excluded`. A slice is not done while its rows lack
walkthrough evidence (side-by-side against the edge GUI on `agrolink-test-01`).
Every edit to a row updates its provenance date.

The previous cross-repo parity artifact (the API matrix) went stale within a
week because nobody dated its rows, so a "checked once" entry looked identical
to a "never checked" one. Provenance here is per row, not per file: an edit to
one row's status must update only that row's date, so a stale neighbor stays
visibly stale instead of borrowing a fresh timestamp it didn't earn.

`seeded` = transcribed from the design spec's slice assignment, not yet
checked against a running app. `verified` = the cell reflects a same-day
read of the actual source file(s) on both sides (still not a live
`agrolink-test-01` walkthrough; see the Walkthrough evidence column).
`corrected` = a `seeded` entry inherited from the S0 task briefs turned out to
mismatch current repo state and was fixed here.

## S0 platform deliverables

These are S0's own output, not slice-assignment placeholders; status below
is real, checked against the commits that shipped it.

| Deliverable | Edge source | Cloud status | Walkthrough evidence | Provenance |
|---|---|---|---|---|
| `ui-core` design tokens + primitives (D1/D2) | `web/react-gui/src/ui-core/` (canonical) | parity: vendored byte-identical into `frontend/src/ui-core/` and CI-gated both directions (`scripts/verify-ui-core-vendor.sh`); edge commits `bbf761e0`, `a8ef3bd3`, `d16bc7a0`, cloud commit `b5a81158` | n/a (byte-diff verified, not a visual walkthrough) | 2026-08-04 verified (S0 T7) |
| Cloud consumes `ui-core` tokens.css + Tailwind preset | n/a (cloud-side integration step) | parity: cloud commit `09ac6f12` switches the app to the vendored tokens/preset; one follow-up fix commit `cebad498` repaired two token-adoption contrast regressions (header hover, error-banner border) | pending (visual regressions found and fixed in-slice; no independent walkthrough yet) | 2026-08-04 verified (S0 T7/T10) |
| Gateway context / `GatewayProvider` (D3) | n/a: edge is single-gateway per device, no edge file exists for this concept; spec ref `docs/superpowers/specs/2026-08-04-agrolink-gui-parity-design.md` D3 | parity for the single-gateway case (auto-select, no selector chrome per D3); multi-gateway switch UX ships with the next row; cloud commit `4ab7d91a` (`frontend/src/contexts/GatewayContext.tsx`) | n/a (multi-gateway accounts to verify visually once seeded test data exists) | 2026-08-04 verified (S0 T8) |
| Settings: active-gateway switcher | `web/react-gui/src/pages/SettingsPage.tsx` (edge has no switcher: edge is single-gateway) | partial: cloud-only feature, no edge counterpart to compare against by design; renders only when `hasMultipleGateways` (D3); cloud commit `cb107940` (`frontend/src/pages/SettingsPage.tsx` + 7-locale keys, `lg` machine-draft pending human gate) | pending | 2026-08-04 verified (S0 T9) |

## Edge screens and widgets

| Edge screen / widget | Edge source | Cloud status | Walkthrough evidence | Provenance |
|---|---|---|---|---|
| Login | `web/react-gui/src/pages/Login.tsx` | excluded (D6: cloud keeps Swiss-cross badge, `5280da76`) | n/a | 2026-08-04 seeded (S0) |
| Register | `web/react-gui/src/pages/Register.tsx` | excluded (cloud has its own account flow) | n/a | 2026-08-04 seeded (S0) |
| Farming dashboard | `web/react-gui/src/pages/FarmingDashboard.tsx` (367 lines) | partial (pending walkthrough): cloud `pages/Dashboard.tsx` scopes zones by active gateway (S1) and now devices by their own `gatewayDeviceEui` (S2 T8); device-card write authority threads role-based `canWriteDevices` and owner-only `canOperateGateway` helpers (S2 T3), `readOnly` is a required card prop enforced by `tsc` (S2 T4); page composition still thinner than the edge page | pending | 2026-08-05 verified (S2) |
| History dashboard | `web/react-gui/src/pages/HistoryDashboard.tsx` (528 lines) | partial: cloud `pages/HistoryDashboard.tsx` (237 lines) exists and is routed at `/history` and `/history/zones/:zoneId`, confirmed thinner than the edge page; page shell rethemed to bg-[var(--bg)]/text-[var(--text)] from hardcoded bg-slate-100 (S3 T1 cohesion sweep; the page's inner surfaces are still S4's) | pending | 2026-08-06 verified (S3) |
| History card detail | `web/react-gui/src/pages/HistoryCardDetailPage.tsx` | missing; confirmed: cloud's `/history/zones/:zoneId` route re-renders the same `HistoryDashboard`, no distinct card-detail page/component exists | pending | 2026-08-04 verified (S0 self-review) |
| Analysis route | `web/react-gui/src/pages/AnalysisRoute.tsx` (lazy-loads `CrossZoneAnalysisPage`, gated by `isDesktopBrowser()`, redirects to `/history` on mobile) | partial, corrected from `missing`. Cloud's `/analysis` route in `App.tsx` lazy-loads `CrossZoneAnalysisPage` directly with no separate wrapper file and, on inspection of `App.tsx`, no equivalent desktop-only redirect gate; mobile users reach the page instead of being routed to history | pending | 2026-08-04 corrected (S0 self-review) |
| Cross-zone analysis | `web/react-gui/src/pages/CrossZoneAnalysisPage.tsx` (279 lines) | partial: cloud `pages/CrossZoneAnalysisPage.tsx` (275 lines) is close in size; feature/cohesion depth unverified without a walkthrough; page shell rethemed to bg-[var(--bg)]/text-[var(--text)] from bg-slate-100/text-slate-950, keeping h-screen (load-bearing for its min-h-0 scroll panes) — inner surfaces still S4's | pending | 2026-08-06 verified (S3) |
| Field journal | `web/react-gui/src/pages/JournalPage.tsx` (imports `components/journal/desktop/JournalWorkspace`) | partial (pending walkthrough): the cloud journal is now **two systems**, not one. A V1 gateway-scoped path (`/api/v1/journal/gateways/{eui}/…`, unchanged since S3) and a V2 workspace path (`/api/v2/journal/workspaces/{uuid}/…`) coexist, selected per workspace by `authority_state ∈ {legacy, blocked, cloud_primary}`; a workspace becomes `cloud_primary` only when server flag `journal.v2.cloud-issuer-enabled` is on (fails closed — `JournalWorkspaceAccessService.java:23`, default `false`). `JournalPage.tsx:174` branches its whole data flow on `cloudPrimary` and the page now composes a workspace selector/creator (`createWorkspace`, `JournalPage.tsx:394`) and a conflict-resolution section (`conflicts`/`dismissConflict`, `:186,416`) that S3 never had. Deviations carried from S3, single-plot only, final-only (drafts never sync), no cycle-opening/closing activities, core-scoped vocab and products only for the V1 path, no tank-mix pass, no DST fold selects, client-side filtering/paging | pending | 2026-08-11 verified (S6 T1) |
| Settings | `web/react-gui/src/pages/SettingsPage.tsx` | partial: cloud settings page exists plus the S0 active-gateway switcher (see platform table above) | pending | 2026-08-04 verified (S0 self-review) |
| Support requests | `web/react-gui/src/pages/SupportRequests.tsx` (556 lines) | partial: cloud `pages/SupportRequestsPage.tsx` (448 lines) exists and is routed; feature-parity depth unverified without a walkthrough | pending | 2026-08-04 seeded (S0) |
| Account link | `web/react-gui/src/pages/AccountLink.tsx` | excluded (edge-only linking flow; no cloud file exists) | n/a | 2026-08-04 verified (S0 self-review) |
| Admin: users | `web/react-gui/src/pages/admin/UsersPage.tsx` (152 lines) | partial (S5), corrected from `missing`. Cloud's `pages/admin/AdminUsers.tsx` (197 lines) already exists, is routed at `/admin/users`, and is live (SWR-backed role/enabled toggles); it visibly lacks the edge page's create-user and reset-password actions | pending | 2026-08-04 corrected (S0 self-review) |
| Admin: grants | `web/react-gui/src/pages/admin/GrantsPage.tsx` | missing (S5); confirmed: no grant/revoke UI exists on cloud; `GatewayAccessAdminPage.tsx` is a different concept (gateway access, not zone/plot grants) and does not cover this | pending | 2026-08-04 verified (S0 self-review) |
| App header (glass chrome) | `web/react-gui/src/components/AppHeader.tsx` (`glass-chrome`/`glass-tabs` classes) | missing; confirmed: cloud's `components/DashboardHeader.tsx` has no `AppHeader` import and no `glass`-prefixed class anywhere; it is a standalone header with no shared glass-chrome primitive | pending | 2026-08-04 verified (S0 self-review) |
| Gateway restart banner | `web/react-gui/src/components/GatewayRestartBanner.tsx` | missing | pending | 2026-08-04 seeded (S0) |
| Scope status banner | `web/react-gui/src/components/ScopeStatusBanner.tsx` (on ui-core `Banner` since S1 T3, fixing its undefined `--danger-*` classes) | partial (pending walkthrough): cloud `components/GatewayScopeBanner.tsx` ports the D5 fail-closed pattern over `useGateway()` with retry (S1 T4); both banners announce via explicit `aria-live` (S1 T2) | pending | 2026-08-05 verified (S1) |
| Valve card (STREGA) | `web/react-gui/src/components/farming/StregaValveCard.tsx` (867 lines) | partial (pending walkthrough): cloud card (832 lines) actuates via `OPEN_FOR_DURATION` with a 1–255 min duration control, no bare CLOSE (S2 T6, matching edge + STREGA rules); actor-carrying `VALVE_COMMAND` denials render legibly on both paths — immediate 403 `scope_denied` (S2 T2) and async edge `scope_denied`/`scope_actor_required` via `PendingStateNotice` (S2 T5); `readOnly` required (S2 T4). Deviations: no cancel-queued-open button (edge cancel is an edge-local route; no cloud→edge cancel command exists) and no today-liters line. Live `OPEN_FOR_DURATION` against `agrolink-test-01` still required before this row may flip (spec S2 gate) | pending | 2026-08-05 verified (S2) |
| Weather card (S2120) | `web/react-gui/src/components/farming/SenseCapWeatherCard.tsx` (420 lines) | partial (pending walkthrough): cloud card (434 lines); shared-read stations now appear in the cloud device list for scoped members (S2 T1 backend merge + T8 gateway-EUI scoping, matching the edge C6 behavior); ledger M3 (`text-[var(--error-bg)]` as text) and the pale error border fixed (S2 T7); card body still hardcodes English strings (i18n follow-up). Shared-read rows render read-only for every scoped non-owner (weather writes are owner-only), so the card affordance matches the backend authority (S2 T8) | pending | 2026-08-05 verified (S2) |
| Dendrometer monitor | `web/react-gui/src/components/farming/DendrometerMonitor.tsx` (359 lines) | partial (S2/S4), corrected from `missing`. Cloud has both `components/farming/DendrometerMonitor.tsx` (317 lines) and `components/farming/dendrometer/DendrometerMonitor.tsx`, referenced from `DraginoCard.tsx` and `dendrometer/DendrometerSection.tsx`; live, not stubs | pending | 2026-08-04 corrected (S0 self-review) |
| Zone / device modals | `web/react-gui/src/components/farming/CreateZoneModal.tsx` (on ui-core since S1 T9), `AddDeviceModal.tsx` (196 lines) | partial (pending walkthrough): cloud `CreateZoneModal` on ui-core targeting the active gateway (S1 T8); cloud `AddDeviceModal` likewise on the ui-core `Modal`/`FormField`/`Button` shell, registers on the active gateway with a Settings-switcher pointer, owner-gated fail-closed (S2 T9); cloud `ClaimGatewayModal.tsx` is orphaned dead code (admin-era direct claim, unmounted since the Dashboard rewrites — account linking owns gateway acquisition) | pending | 2026-08-05 verified (S2) |
| Journal entry table | `web/react-gui/src/components/journal/desktop/EntryTable.tsx` | partial (pending walkthrough): cloud `components/journal/workspace/EntryTable.tsx` still ships the same `occurred / activity / plot / status` columns, client-side sort and the 50-row pager (`ENTRY_PAGE_SIZE = 50`, `EntryTable.tsx:17`, `activePage` at `:159-170`) matching the edge's `PAGE_SIZE` — still accurate, re-verified. Rows now also carry conflict and stuck-photo badges (`conflictedEntryUuids`, `failedAttachmentEntryUuids`), populated only for `cloud_primary` workspaces. Deviation: the edge's filter-bound server cursor is still not ported on either journal path — V1 takes only `includeDeleted` and the new V2 entries endpoint (`JournalV2Controller.java:52`) takes **zero** query params, so the cloud still filters and pages client-side over the fetched list | pending | 2026-08-11 verified (S6 T1) |
| Irrigation zone card | `web/react-gui/src/components/farming/IrrigationZoneCard.tsx` (609 lines; S1 fixed its delete-button hover) | partial (pending walkthrough): cloud card (534 lines) gains `canWrite`/`mutationsSupported` gating with the explicit not-available state (S1 T5), water card rethemed onto ui-core tokens and SWT_1/2/3 chip labels (S1 T7); zone-level conflict/rejection surfacing already live via `PendingStateNotice` | pending | 2026-08-05 verified (S1) |
| Schedule section + advanced drawer | `web/react-gui/src/components/farming/ScheduleSection.tsx` (415 lines), `AdvancedScheduleDrawer.tsx` (471 lines) | partial (pending walkthrough): cloud `ScheduleSection.tsx` (505 lines) carries the full edge trigger vocabulary plus desired-state surfacing with retry (`ScheduleSection.desiredState.test.tsx`); cloud drawer (463 lines) close in size; mounts now write/capability gated at the card (S1 T5); cohesion depth needs the walkthrough | pending | 2026-08-05 verified (S1) |
| Zone config + irrigation calibration | `web/react-gui/src/components/farming/ZoneConfigModal.tsx` (536 lines) | partial (pending walkthrough): cloud modal (829 lines) already submits config and calibration through `updateConfig`/`updateCalibration` and renders `PendingStateNotice` for the calibration operation; access gated at the card (S1 T5); ui-core adoption inside the modal deliberately deferred (D7 cohesion, single-sided component) | pending | 2026-08-05 verified (S1) |
| Device detail page | n/a — the edge has no per-device detail route; drill-down is in-card `SensorMonitor`/`WindMonitor` overlays | partial: cloud-only page (D7 single-sided), `frontend/src/pages/DeviceDetail.tsx` at `/devices/:deviceEui`; S2 T7 rethemed its error box and `datetime-local` range inputs onto tokens; read paths cover shared-read weather devices via the backend `canReadDevice` widening; recharts chart chrome still hardcodes light-theme hex colors | pending | 2026-08-05 verified (S2) |
| Journal capture flow | `web/react-gui/src/components/journal/capture/JournalCaptureFlow.tsx` (2905 lines) + `EntryForm.tsx` (1064) | partial (pending walkthrough): `EntryForm`, `NutrientRepeater` and `NumberStepper` are copy-adapted onto tokens with a required `readOnly` prop and the edge component tests copied alongside (S3 T7); `ActivityPicker` likewise (S3 T8). The 2905-line flow itself is still deliberately NOT ported, re-verified — its bulk is crop cycles, tank-mix passes, batches, carry-forward, layout transitions and drafts, none of which the cloud mirror can express — so cloud `JournalCaptureModal.tsx` is a reduced D7 composition over the same `EntryForm`. Since S3, `JournalCaptureModal` has grown photo-upload state, cloud-primary validation and workspace/actor plumbing for the V2 path. **Single-plot only, re-verified**: `JournalCaptureModal.tsx:175` is still one `<select>` over a singular `plotUuid` state, in both the V1 and cloud-primary branch of the same modal | pending | 2026-08-11 verified (S6 T1) |
| Journal detail panel (view / correct / copy / void) | `web/react-gui/src/components/journal/desktop/DetailPanel.tsx` (1117 lines) | partial (pending walkthrough): cloud `components/journal/workspace/DetailPanel.tsx` renders stored `values`, moves Void out of `window.prompt` into a reasoned modal, and ships correction plus create-only copy as two separate modules with no shared mode flag, mirroring the edge's A7 split (S3 T10) — but this applies **only to V1 (`!cloudPrimary`) entries**. `DetailPanel.tsx` is byte-unchanged since S3 and is **not used at all for cloud-primary entries**: `JournalPage.tsx:661-709` renders it only when `!cloudPrimary`, rendering `EntryAttachmentsPanel` instead otherwise. So **correct / copy / void do not exist for cloud-primary entries** — a photo view/retry/remove surface is all a cloud-primary user gets. Copy is hidden — not disabled — for cycle activities on the V1 path, as on the edge | pending | 2026-08-11 verified (S6 T1) |
| Journal catalog delivery (v10) | `conf/.../osi-journal/catalog.js` + `api.js catalogDto` serving `GET /api/journal/catalog?include=definitions` | partial (pending walkthrough), **re-affirmed unchanged**: the cloud had **no catalog of any kind** before S3. It still serves the same byte-vendored artifact generated from the shipped `database/farming.db` (`scripts/export-journal-catalog.js` → `docs/contracts/journal-catalog/journal-catalog.json` → `backend/src/main/resources/journal-catalog/`), gated in CI on both sides (S3 T2/T3), behind `GET /api/v1/journal/gateways/{eui}/catalog` with a fail-closed compatibility verdict against the catalog version/hash the gateway already advertises at bootstrap (S3 T4/T5). The V2 workspace path added since S3 does not touch this delivery mechanism at all — it has its own catalog endpoint (`JournalV2Controller.java:79`) merging workspace-owned `journal_products_v2`/`journal_custom_vocab_v2` tables, a different mechanism (see the ledger below). No commit has touched `backend/src/main/resources/journal-catalog` since S3 T2b (`a0ed10ba`); `git log` over that path confirms it. Deviations unchanged: catalog labels stay English on both sides (S3 reading 9); the artifact is the **global** half of what a gateway serves, so the V1 caller's `scope='custom'` vocab and `scope='farm'` products are missing from the cloud's copy (S3 reading 6) | pending | 2026-08-11 verified (S6 T1) |

## Using this matrix

Each later slice appends or edits rows for the screens/widgets it touches:
flip `missing`/`partial` toward `parity` only after a real side-by-side
walkthrough against the edge GUI running on `agrolink-test-01`, link the
walkthrough evidence (screenshot pair, recorded session, or review diff), and
update that row's provenance date. Do not bulk-refresh every date when
editing one row; an untouched row keeping its old date is the signal that it
still needs a look.

## Open retheme/parity ledger (not tied to a single row)

Carried forward from the S2 execution ledger's own close-out triage
(`.superpowers/sdd/2026-08-05-agrolink-gui-parity-s2/progress.md`); each item
belongs to the slice that next touches the named file.

**Walkthrough-evidence caveat:** until the double-downlink (HIGH, below) and
the MQTT broker hardcode (below) are both fixed, any `agrolink-test-01`
walkthrough will show distorted online/telemetry state (wrong-broker
heartbeats) and doubled config downlinks on partial-open/flush actions.
Evidence gathered before those fixes land does not establish real parity
for the affected rows.

- **HIGH — confirmed edge defect, pre-existing, affects live behavior:** in
  `flows.json` (both bcm2712/bcm2709 profiles), Route Command output 0 wires
  to `write-strega-expectation` *and* a link round-trip that re-enters the
  same node, so every cloud-dispatched command on that output runs it twice.
  For early-returning config types (partial-opening, flushing) both passes
  forward `msg` unchanged, publishing two identical downlinks to ChirpStack
  per request; for timed actuations the second pass hits the
  `expectation_id` primary key and logs a spurious "Write STREGA expectation
  failed" every time. Scheduler/manual paths enter via other link-outs and
  are unaffected. Needs a dedicated edge `flows.json` fix — candidate for S2
  close-out or the S3 edge budget.
- **MQTT broker hardcoded to the wrong environment:** both edge profile
  mirrors (`conf/full_raspberrypi_bcm27xx_bcm2712/.../flows.json` and the
  bcm2709 mirror) hardcode the MQTT node's broker URL to
  `wss://server.opensmartirrigation.org/mqtt`. A gateway linked to
  `agro-link.ch` still sends heartbeat/telemetry/status/command_ack over
  MQTT to the production/test-server broker instead of AgroLink's, so
  those signals arrive at the wrong environment. REST sync (pending-commands
  polling) and the valve/command path are unaffected — command
  acknowledgement rides the REST queue, not MQTT. Needs an edge fix in both
  profiles; schedule it *before* the walkthrough backfill so the matrix's
  evidence isn't collected against a misdirected broker.
- Cloud/edge classification asymmetry on STREGA partial-open/flush: the edge
  treats them as config (`scoped-device-config-guard`), the cloud treats them
  as physical actuation (T6b). Which side is canonical is undecided.
- Cloud `POST /devices/{eui}/gateway-command` (the `ROLE_ADMIN` passthrough)
  can emit any physical command with a caller-supplied `actor_user_uuid`,
  which forges the edge's originator/audit trail. Deliberately exempt today
  (`ROLE_ADMIN` + `claimedBy` only) but needs an explicit decision, not just
  an exemption.
- **Edge has no defense-in-depth `VALVE_COMMAND` action fence:** the edge
  does not itself reject a `VALVE_COMMAND` whose inner `action` isn't
  `OPEN_FOR_DURATION` — today the cloud's `CommandService` boundary is the
  only place that narrows the action set (S2 T6). Kept as a separate item
  from the ADMIN-passthrough bullet above rather than folded in: both are
  "single enforcement point" gaps, but the fixes live in different
  codebases (an edge `flows.json` action check here vs. a cloud endpoint
  decision there), so collapsing them would obscure that they need two
  independent fixes.
- `claimedBy`-only CONFIG downlinks (`strega/interval|model|magnet`,
  `lsn50/*`, `kiwi/*`) are unusable by granted scoped users — a parity gap
  for a later slice.
- Cloud `DeviceController.java:908-909`'s comment overstates edge
  re-enforcement for `setStregaTimedAction`: true only for `action=OPEN`
  (a `CLOSE` timed action early-returns at the `isTimedOpen` gate, so the
  actor is a no-op there too). The edge does enforce scope for partial/flush
  on its own local GUI PUT routes; the gap is specifically the
  cloud-dispatched, apply-time path.
- Missing app-wide `color-scheme: dark` means native date-picker glyphs
  render dark-on-dark on token surfaces in `DeviceDetail.tsx` and
  `PredictionConfigModal.tsx` (pre-existing, D7-deferred). `DeviceDetail`'s
  recharts internals (`#CBD5E1`/`#64748B`, white tooltip background) and
  `AnalysisControls`' un-themed slate/`bg-white` styling are both S4
  history/analysis candidates.
- The `--*-bg-as-foreground` guard test and its same-line class-pairing
  sibling are both currently 0-instance but not durable: the first misses
  uppercase/digit token names, whitespace inside `var()`, and
  `outline-`/`ring-`/`divide-`/`accent-` utilities; the second checks
  same-line rather than same-class-string (misses multi-line template
  literals, false-positives on same-line mutually-exclusive ternaries) and
  hardcodes `--error-bg` only, leaving warn/success fill+border shapes
  unguarded. Fixing this means extracting and testing each normalized
  className value, not patching the two known patterns.
- `IrrigationZoneCard.tsx:505-507` inline-duplicates `weatherRowReadOnly`'s
  predicate (it receives the derived boolean, not the raw state) and no
  component test exercises that inline copy — duplicated and untested is the
  shape that drifts into a bug. Collapse via a `weatherRowReadOnly(device)`
  callback prop or by passing `gatewayScope` down.
- `Dashboard.tsx:34`'s `const identity = { username, isSuperAdmin }` is a
  fresh object literal every render — harmless today (nothing memoizes on
  it) but only matters if a card in this tree is ever wrapped in
  `React.memo`.
- `AddDeviceModal`'s permission-denial box and its informational-hint box
  share byte-identical styling, so a denial reads as a hint; its `FormField`
  also sets `htmlFor` on a non-labelable `<p>`. Separately,
  `visibleOnActiveGateway`'s exact `===` EUI compare means any case/format
  skew between `LinkedGatewayAccount.gatewayDeviceEui` and `Device.deviceEui`
  silently denies registration (inherited coupling, same trap as the hub
  cards).
- ui-core `Modal` dims with an opaque `bg-[var(--overlay)]`, where the
  pre-S2 modal dimmed with `bg-black/50` — S1-inherited, open edge-shell
  parity question.
- Cloud `ClaimGatewayModal.tsx` + its `devices:claimGatewayModal.*` locale
  keys are dead code (see the Zone / device modals row) — cleanup sweep
  candidate.
- Full `devices:addModal.*` translation: S2 added the three new keys only;
  the modal's pre-existing strings still ride `t(key, 'English fallback')`
  (i18n follow-up bundle).
- ui-core `INPUT_CLASS` (`FormField.tsx`) carries a hardcoded `bg-white`
  input fill — light-only, inherited verbatim from the edge modals at S0
  extraction. A token pass on it is canonical-first ui-core work (D2
  re-vendor in the same change), out of S2 scope.

### S3 additions (field journal slice, 2026-08-06)

- **Catalog i18n is the Uganda `lg` ship gate and S3 explicitly did not do it.** Every `labels_json` in the shipped catalog is English-only (zero non-`en` keys in `0019__journal_catalog_v1.sql` and `0032__journal_catalog_v10.sql`), so a non-English user of either GUI gets a translated shell around English activity, attribute, unit and choice labels. Both GUIs already resolve `labels[locale] ?? labels.en ?? code`, so this is a **data** change: add locale keys to the `labels` in `scripts/journal-catalog-core.js`, publish a new catalog version through `scripts/generate-journal-catalog.js`, re-run the row-content gate, re-export and re-vendor the artifact. No GUI code changes. Owner: the journal catalog program, not a GUI slice.
- **Pre-S3 cloud journal entries are catalog orphans.** Every entry created by the old cloud page carries `template_code: 'cloud.quick'@1` / `layout_code: 'quick'@1`, which no gateway catalog contains; the edge stored them unvalidated (its definition-driven checks are all guarded on the definition rows existing) and neither GUI can Correct or Copy them. S3 stops creating them and degrades gracefully on them; repairing the existing rows needs a data decision (void-and-recapture vs. a targeted correction) and is not scheduled. **Maintainer-confirmed head count: `journal_entries_mirror` on the live `agro-link.ch` instance returned 0 rows on 2026-08-05** — the pre-S3 cloud journal frontend never shipped past `origin/main`, so this is zero affected rows as of 2026-08-05, verified on the live instance, not a latent-damage backlog.
- **Cloud journal list has no server-side filter, sort or paging — and the newer V2 path is barer, not fixed.** V1 `GET …/journal/gateways/{eui}/entries` still takes only `includeDeleted` (`JournalController.java:40-43`); S3's client-side filter/page over the whole mirrored list is unchanged. The new V2 `GET …/journal/workspaces/{workspaceUuid}/entries` (`JournalV2Controller.java:52-59`) takes **zero** query params — no filter, no sort, no page cursor at all. The `(gateway_eui, plot_uuid, occurred_start DESC, entry_uuid)` index exists for the server-side version but nothing calls it from either endpoint. S4 candidate; noted 2026-08-11 (S6 T1) that the fork made this worse, not better.
- **Cloud capture omits the edge's DST fold handling.** The edge resolves an ambiguous local time with explicit offset selects; the cloud sends the browser's `occurred_utc_offset_minutes` and lets the edge resolve. An entry recorded during a fold hour can land in the wrong offset. Same defect class as the edge copy-form's ledgered DST fold-hour MINOR.
- **Edge header sizing inconsistency (recorded, unassigned to S3).** Edge nav tabs are `glass-tab px-5 py-2 text-[15px]` while Settings/Account use `LIQUID_SIZING` (`px-3 py-2.5 text-base sm:px-6 sm:py-3 sm:text-lg`, 18px desktop), so primary navigation reads as less important than secondary chrome. Assigned to the dedicated frontend-designer review scheduled after S3's code is complete.
- **Journal reference panel is unreviewed by S3 apart from one fail-open fix.** `JournalReferencePanel.tsx` still creates plots with hardcoded `crop_hint: ''` / `area_m2: null` and custom vocab with `labels_json = {"en": label}` only, and its plot-group create path does not surface the backend's C9 owner-only rule until the request fails. The orchestrator did close one defect outside this list — the add-reference form rendered on `showForm` alone with no re-derived `writable` check, so a mounted panel with the form open kept a live Save after write authority was revoked (same fail-open shape as T7/T10's I3; fixed by gating the render on `writable && showForm`, covering test added) — but the component otherwise belongs to whichever slice next owns journal reference data.
- **`text-white` on `var(--primary)` measures 5.17:1 light / 1.86:1 dark — fails AA in dark theme.** (Recomputed from `ui-core/tokens.css` at this head: `--primary` is `#2563EB` light, `#2DD4BF` dark; the review note's 5.31 light was slightly off, 5.17 is the figure, and it matches the `--primary`-on-`--card` 5.17 already in the Global Constraints because `--card` is `#FFFFFF` in light.) Pre-existing and system-wide: identical in `ui-core/Button.tsx:7`'s primary variant and in every primary-filled chip on BOTH GUIs (`EntryForm.tsx:756`, `:916`, `NutrientRepeater.tsx:172` are the three in the copied capture surface). The real fix is an `--on-primary` token in canonical ui-core, re-vendored to osi-server — a ui-core change, therefore out of S3's scope by the closed-primitive-set rule. Routed to the frontend-designer review scheduled after S3's code is complete, bundled with the `liquid-red` item below. S3 copies the pairing unchanged rather than making the journal disagree with everything else.
- **The `liquid-red` AA miss (T10 fix round I1, maintainer-ruled out of scope for this slice).** White text on `.btn-liquid-red` over the light `--card` measures **4.50 / 4.53 / 4.52 / 4.47 / 4.38** across the gradient — the lower half sits below the 4.5:1 AA floor for its 14px bold label. Dark theme measures 5.82–9.42, fine. `DetailPanel`'s Void button is the **first production consumer of `liquid-red` in the cloud frontend**, so this is newly-shipped exposure, not inherited debt — do not let it age into "pre-existing". Not fixed in this slice: `primitives.css` is byte-mirrored from osi-os ui-core and vendor-gated, `liquid-red` is a pre-existing variant the edge also uses, and darkening the gradient changes the edge's rendered appearance — a design decision about a shared primitive, routed to the frontend-designer review bundled with the white-on-primary item above. Proposed fix for the designer to rule on: darken the stops, e.g. `rgba(227,6,19,1) -> rgba(190,4,14,0.92)`, measured by the reviewer at ≥4.9:1 over white.
- **Component-level theme-blind colors reopen half of the maintainer's original cohesion finding.** `JournalReferencePanel` uses hardcoded `border-stone-300` / `bg-white/70` / `bg-stone-100` — the same theme-blind-color defect Phil originally reported for page backgrounds. T1 fixed the **page** shells and `pageShellTokens.test.ts` guards them, but that guard scans only `src/pages`, so every **component** escapes it entirely. The cohesion problem is therefore only half-closed: pages are clean, components are unaudited. A repo-wide theme-blind-color audit of `src/components` is a **required designer-review input**, not a minor, and the guard should be considered for widening beyond `src/pages` once that audit says what the real surface looks like.
- **Older-template journal entries lose Correct and Copy, and this is common, not rare.** `catalogModel.ts`'s `activeDefinition()` indexes one definition per code at the latest **active** version, and the shipped catalog carries `full_record` at template versions 1, 5, 6, 7, 8, 9, 10 and `open_field` at layout versions 1, 3, 8, 9 (both confirmed directly from `docs/contracts/journal-catalog/journal-catalog.json`) — so any entry recorded at an older version hits this on every catalog bump, not just the pre-S3 `cloud.quick` orphans. `catalogModel.ts` is byte-identical to the edge (`diff` empty), so the indexing limit itself is shared, but the cloud is **deliberately stricter**: `DetailPanel.tsx:209-210` checks `template.version === source.template_version` / `layout.version === source.layout_version` before offering Correct/Copy, where the edge's `DetailPanel.tsx:305-306` resolves `model?.templates.get(aggregate.template_code)` by **code only**, with no version check anywhere in the file, and its copy path (`:999-1001`) writes the **current** `template.version`/`layout.version` onto the copy — always re-templating silently under whatever version is currently active. This is a known, accepted cloud/edge behavioral divergence (T10 fix round I6 ruling), not a bug to reconcile here — and the edge's looser behavior may itself be a latent defect (an operator-invisible re-templating of a correction/copy against a newer form definition), flagged for whoever next touches either `DetailPanel`.
- **Cloud capture cannot see custom vocab or farm products — still true for V1, no longer true for cloud-primary workspaces, and it is a different mechanism, not a fix.** The vendored artifact is `scope='core'` only; the edge merges the caller's `scope='custom'` vocab and `scope='farm'` products into every catalog it serves (`osi-journal/catalog.js` `loadScopedRows`). The V1 gap is unchanged: the cloud still mirrors custom vocab in `journal_vocab_mirror` **and lets users create it** in `JournalReferencePanel`, so a V1 cloud user can create a term and then not find it in the capture form. **For cloud-primary workspaces this no longer applies**: `JournalV2Controller`'s catalog endpoint (`:79-89`) merges `referenceService.products(workspaceUuid)` and `referenceService.customVocabulary(workspaceUuid)` from new **workspace-owned** tables (`journal_products_v2`, `journal_custom_vocab_v2`) — a separate mechanism from `journal_vocab_mirror`, not a repair of it. Fix shape for V1: merge the principal's mirrored custom rows into `GET …/journal/gateways/{eui}/catalog`'s response on the read path. Not scheduled. Noted 2026-08-11 (S6 T1).
- **Nothing server-side stops a cloud client from minting a catalog orphan — and the V2 path has the identical gap, independently.** S3 closes the door on the V1 client: `buildCaptureEntry` derives its template/layout from the catalog, `buildCopyPayload` returns `null` for a source the catalog cannot resolve, and a shared test assertion checks every emittable payload against the vendored artifact. But `JournalMutationService` validates **no** `template_code`, `layout_code` or `catalog_version` (zero hits across `backend/src/main/java/org/osi/server/journal/`), so any other client can still write `cloud.quick@1`. **The V2 path (`JournalRevisionService.applyEntry`, `:167-184`) validates structurally via `canonicalizer.validateEntry`/`validateAgainstLatestPlot` but performs no catalog lookup either** (zero `catalog`/`Catalog` references in `JournalRevisionService.java`) — two systems, one unclosed hole, not inherited but reproduced. The only thing that truly closes either door is a server-side check against the vendored artifact, rejecting an unknown `(template_code, template_version)` / `(layout_code, layout_version)` with a 422. Small, well-scoped, not in S3 or S6. Noted 2026-08-11 (S6 T1).
- **The capture surface has one locale key a literal-collecting test cannot see.** `frontend/tests/journalCaptureLocales.test.ts` covers the 36 static `t('…')` keys in the copied capture components, but `EntryForm` also calls `` t(`${code}:${groupIndex}`) `` for conditional-group labels, assembled at runtime from a catalog code. A missing key there renders as a raw string in the GUI and fails no test. Its key set moves with the catalog version, so it belongs with catalog i18n above, not with the chrome translations. A parallel, narrower hole exists in `NumberStepper.tsx:116/119/121`'s `t(issue.key)` (the union at `:39-41` resolves in all 7 locales today) and the pre-existing `JournalReferencePanel.tsx:198`'s `` t(`vocabKinds.${kind}`) `` (all four kinds resolve today) — neither renders a raw key today; both are pattern risk a literal-collecting test cannot see.

### S6 additions (journal V1/V2 fork correction, 2026-08-11)

Not verified without a running instance: whether `journal.v2.cloud-issuer-enabled` is on for any live gateway, and therefore whether any user can currently reach the V2 photo or conflict surfaces at all. No end-to-end confirmation of photo upload or conflict resolution exists — the evidence above is static code only.

**Carried forward from progress.md's per-task minors (S3, not otherwise closed above; none dropped):**

- **Edge exporter/generator (S3 T2, still open):** the verifier self-test's empty-file and missing-file negative cases are subsumed by `cmp -s` (defense-in-depth, not a hole); the `catalog_errors` derivation test exercises only `vocabDto`, leaving `definitionDto`/`productDto` with no malformed-row assertion (their `safeJson` calls are unconditional, so risk is low); `sqlite3` is invoked without `-readonly` (the read-only contract is incidental — SELECTs only, `journal_mode=delete` — not structural).
- **Edge exporter key-order fix (S3 T2b, cosmetic, still open):** `export-journal-catalog.js:66`'s comment says "byte-identical rows" — overreach, since the artifact is pretty-printed JSON and a gateway serves compact JSON (rows are key-order-identical, byte-identical only after whitespace normalization; the README wording is already accurate). `:64`'s parenthetical omits `constraints` from the derived-key list, though it is one of the two vocab keys the fix actually moved. The artifact's **top-level** key order is not pinned by any test, only per-row order (verified still matching `api.js:407-415` by hand). `docs/contracts/journal-catalog/README.md:3-6` has an unreflowed short line and nested em-dashes.
- **Cloud CI trigger scope (S3 T3, pre-existing, still open):** `backend-ci.yml` triggers only on push/PR to `main`/`master`, so this gate never runs on `AgroLink` pushes — it fires only when a PR targets main. Shared by the sync-contract and ui-core gates.
- **Cloud backend bootstrap (S3 T4, still open):** `applyJournalCatalogStamp` does not lowercase before its `[0-9a-f]{64}` test, so an uppercase hash arriving by any route other than the record (which lowercases) is judged unusable and CLEARED — harmless today, the only caller passes a record-normalized value. The two new Jackson binding tests use `new ObjectMapper()` rather than the Spring-managed mapper — equivalent today (zero Jackson customization in `src/main`) but would stop tracking the real HTTP path if a Jackson config bean is ever added.
- **Cloud backend catalog service (S3 T5, still open):** `catalog()` hands out the cached `JsonNode` itself, so a future mutating caller would corrupt the singleton (no current caller mutates; optional `.deepCopy()` hardening). No test pins the endpoint path at the HTTP layer — the controller tests call `controller().catalog(...)` directly rather than going through a real HTTP/Spring-context path (see T12's attempted `@WebMvcTest` closure).
- **Cloud frontend catalog wiring (S3 T6, still open):** `journalCaptureBlockedReason` never reads `catalog.error` directly — confirmed still true in the current source (`journalCapability.ts:44`'s own comment says so); it fails closed indirectly today only because a fetch error leaves `data` undefined, but a future refactor that defaults `compatibility` would silently open the error path. The operation-replacement test's `deepEqual` on a Set difference is order-sensitive (Set insertion order from `deriveFieldStates`), so a pure field reorder in the catalog would fail it spuriously — noted for whoever next touches that test.
- **Cloud capture components (S3 T7, still open):** the fix round's `expect(onChange).not.toHaveBeenCalled()` assertions can't fail while the paired `toBeDisabled()` assertions hold — they document intent, `toBeDisabled` is the real guard. `EntryForm.tsx`'s note `<textarea>` is gated with `disabled`, dropping it from the tab order for read-only viewers — a whole-surface `readOnly`-vs-`disabled` question for text inputs, now explicitly a designer-review input per this matrix rather than a T7-specific defect.
- **Cloud capture flow (S3 T8, still open):** `JournalCaptureModal.test.tsx`'s UTC-offset sign assertion compares against the same expression the implementation uses, so it is unverified on a UTC CI runner (the other two `occurred_*` assertions are real coverage). `journalCapability.ts:44` reuses the `'catalog_incompatible'` reason for a client-side parse failure the server called compatible, pointing the rendered remedy text at the wrong fix. `tests/journalEntryPayload.test.ts:90-91` still carries a pre-fix comment overstating what `buildCaptureEntry` can emit (self-qualified two lines later, not misleading in practice). `JournalCaptureModal.tsx:371`'s `!writable` check is unreachable by construction. After `onPick` nothing marks which activity leaf was chosen — the picker keeps rendering unselected above the now-visible form. `CapturePlot.owner_user_uuid`/`crop_hint` are brief-mandated required fields consumed by nothing. `lg/journal.json`'s `capture.unavailable.unsupportedGateway` uses a curly apostrophe where every other `lg` string uses a straight one (matches the brief's table; fix upstream if at all). `ActivityPicker.test.tsx:11` retains an inert fixture key (`capture.picker.more`) the copied component and cloud locales no longer contain.
- **Cloud entry table / scope rail (S3 T9, still open):** `filters.plotUuid` is honored by `filterEntries` but no UI control sets it, so it is inert UI state (same class as T8's unreachable `!writable`) — wire a control in S4 or comment why it is intentionally inert. `Banner tone="warn"` is used for the `'loading'` block reason, which is not a warning — forced by the closed 8-primitive `BannerTone` set (no `'info'`); routed to the designer review as a spec question, not an implementer call.
- **Cloud detail panel fix round (S3 T10, still open, ledgered by the fix round's own instruction):** Copy backdates `recorded_at`/`created_at`/`updated_at` to the copy's own `occurred` instant (slice-consistent with T8; the edge omits all three — a slice-wide follow-up, not T10-specific). `Surface`'s `overflow-y-auto` + `min-h-[240px]` has no height bound, so the internal scroll never engages on a real page — routed to the designer review, not an implementer/reviewer fix. The "no update API" scan in the node-runner test checks only static `import` lines, not dynamic import or re-export indirection (acceptable today, a known scan-strength ceiling). Raw `entry_uuid` is used directly in a few places where the page's own `resourceEntryUuid()` helper exists — cosmetic duplication, not a behavioral gap.

Note: the S1-ledgered pale border on `ScheduleSection.tsx:423`
(`border-[var(--error-bg)]` paired with the error wash) was closed by S2 T7 —
the line now reads `border-[var(--danger-fg)]`, confirmed by inspection. It
is not carried forward here.

Note: the T8 triage's "`weatherRowReadOnly` exported without restating its
fail-closed caveat" is also closed, not open — the function's docstring at
`gatewayCapabilities.ts:142-149` already states it ("the actual device
owner is never caught by the false positive documented on
weatherRowsReadOnly above ... A super-admin ... is likewise never forced
read-only"), confirmed by inspection. It is not carried forward here
either.

Note on the live `agrolink-test-01` valve command pairing: the edge already
runs the S2 command-ledger commit (`c8168986`, hash-identical to branch
head — deployed on-site mid-slice), ahead of the not-yet-deployed cloud
side. That live pair is currently **half-deployed and fail-closed**: any
valve command the still-old cloud sends is rejected (`invalid_expires_at`),
never mis-actuated. The pending cloud deploy completes the pair; no further
edge redeploy is needed for S2. The "cloud-first" deploy ordering (deploy
cloud before edge) only binds for *future* gateways being brought onto a
matching edge/cloud pair from scratch — it does not describe
`agrolink-test-01`'s current state, which is edge-ahead by design of the
on-site deployment.
