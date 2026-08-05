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
| Farming dashboard | `web/react-gui/src/pages/FarmingDashboard.tsx` (367 lines) | partial (pending walkthrough): cloud `pages/Dashboard.tsx` now scopes zones/devices by the active gateway (D3), passes `canWrite`/`mutationsSupported` to zone cards (D4/D5), mounts `GatewayScopeBanner`, and renders its empty state on ui-core `EmptyState`/`Button` (S1 T6); edge empty state also on ui-core (S1 T10); page composition still thinner than the edge page | pending | 2026-08-05 verified (S1) |
| History dashboard | `web/react-gui/src/pages/HistoryDashboard.tsx` (528 lines) | partial: cloud `pages/HistoryDashboard.tsx` (237 lines) exists and is routed at `/history` and `/history/zones/:zoneId`, confirmed thinner than the edge page | pending | 2026-08-04 verified (S0 self-review) |
| History card detail | `web/react-gui/src/pages/HistoryCardDetailPage.tsx` | missing; confirmed: cloud's `/history/zones/:zoneId` route re-renders the same `HistoryDashboard`, no distinct card-detail page/component exists | pending | 2026-08-04 verified (S0 self-review) |
| Analysis route | `web/react-gui/src/pages/AnalysisRoute.tsx` (lazy-loads `CrossZoneAnalysisPage`, gated by `isDesktopBrowser()`, redirects to `/history` on mobile) | partial, corrected from `missing`. Cloud's `/analysis` route in `App.tsx` lazy-loads `CrossZoneAnalysisPage` directly with no separate wrapper file and, on inspection of `App.tsx`, no equivalent desktop-only redirect gate; mobile users reach the page instead of being routed to history | pending | 2026-08-04 corrected (S0 self-review) |
| Cross-zone analysis | `web/react-gui/src/pages/CrossZoneAnalysisPage.tsx` (279 lines) | partial: cloud `pages/CrossZoneAnalysisPage.tsx` (275 lines) is close in size; feature/cohesion depth unverified without a walkthrough | pending | 2026-08-04 seeded (S0) |
| Field journal | `web/react-gui/src/pages/JournalPage.tsx` (imports `components/journal/desktop/JournalWorkspace`) | partial: cloud `pages/JournalPage.tsx` exists (469 lines) but does not import any `desktop/` workspace module (confirmed by grep); it is the pre-v10 monolithic page, thinner in architecture despite having more raw lines than the edge page | pending | 2026-08-04 verified (S0 self-review) |
| Settings | `web/react-gui/src/pages/SettingsPage.tsx` | partial: cloud settings page exists plus the S0 active-gateway switcher (see platform table above) | pending | 2026-08-04 verified (S0 self-review) |
| Support requests | `web/react-gui/src/pages/SupportRequests.tsx` (556 lines) | partial: cloud `pages/SupportRequestsPage.tsx` (448 lines) exists and is routed; feature-parity depth unverified without a walkthrough | pending | 2026-08-04 seeded (S0) |
| Account link | `web/react-gui/src/pages/AccountLink.tsx` | excluded (edge-only linking flow; no cloud file exists) | n/a | 2026-08-04 verified (S0 self-review) |
| Admin: users | `web/react-gui/src/pages/admin/UsersPage.tsx` (152 lines) | partial (S5), corrected from `missing`. Cloud's `pages/admin/AdminUsers.tsx` (197 lines) already exists, is routed at `/admin/users`, and is live (SWR-backed role/enabled toggles); it visibly lacks the edge page's create-user and reset-password actions | pending | 2026-08-04 corrected (S0 self-review) |
| Admin: grants | `web/react-gui/src/pages/admin/GrantsPage.tsx` | missing (S5); confirmed: no grant/revoke UI exists on cloud; `GatewayAccessAdminPage.tsx` is a different concept (gateway access, not zone/plot grants) and does not cover this | pending | 2026-08-04 verified (S0 self-review) |
| App header (glass chrome) | `web/react-gui/src/components/AppHeader.tsx` (`glass-chrome`/`glass-tabs` classes) | missing; confirmed: cloud's `components/DashboardHeader.tsx` has no `AppHeader` import and no `glass`-prefixed class anywhere; it is a standalone header with no shared glass-chrome primitive | pending | 2026-08-04 verified (S0 self-review) |
| Gateway restart banner | `web/react-gui/src/components/GatewayRestartBanner.tsx` | missing | pending | 2026-08-04 seeded (S0) |
| Scope status banner | `web/react-gui/src/components/ScopeStatusBanner.tsx` (on ui-core `Banner` since S1 T3, fixing its undefined `--danger-*` classes) | partial (pending walkthrough): cloud `components/GatewayScopeBanner.tsx` ports the D5 fail-closed pattern over `useGateway()` with retry (S1 T4); both banners announce via explicit `aria-live` (S1 T2) | pending | 2026-08-05 verified (S1) |
| Valve card (STREGA) | `web/react-gui/src/components/farming/StregaValveCard.tsx` (867 lines) | partial (S2), corrected from `missing`. Cloud's `components/farming/StregaValveCard.tsx` (797 lines) already exists, is wired into `deviceRegistry.tsx`, and calls the real `stregaAPI`/`devicesAPI`; it is not a stub; ui-core primitive adoption and pixel/cohesion parity are the S2 work, not the component's existence | pending | 2026-08-04 corrected (S0 self-review) |
| Weather card (S2120) | `web/react-gui/src/components/farming/SenseCapWeatherCard.tsx` (420 lines) | partial (S2), corrected from `missing`. Cloud's `components/farming/SenseCapWeatherCard.tsx` (431 lines) already exists and is wired into `deviceRegistry.tsx`; this exact file was already touched once in S0 (commit `cebad498`, a token-contrast fix on its error-tint border) | pending | 2026-08-04 corrected (S0 self-review) |
| Dendrometer monitor | `web/react-gui/src/components/farming/DendrometerMonitor.tsx` (359 lines) | partial (S2/S4), corrected from `missing`. Cloud has both `components/farming/DendrometerMonitor.tsx` (317 lines) and `components/farming/dendrometer/DendrometerMonitor.tsx`, referenced from `DraginoCard.tsx` and `dendrometer/DendrometerSection.tsx`; live, not stubs | pending | 2026-08-04 corrected (S0 self-review) |
| Zone / device modals | `web/react-gui/src/components/farming/CreateZoneModal.tsx` (on ui-core since S1 T9), `AddDeviceModal.tsx` (196 lines) | partial (pending walkthrough): cloud `CreateZoneModal.tsx` targets the active gateway with no in-modal selector (D3) on the ui-core `Modal`/`FormField`/`Button` shell, fail-closed and capability-gated (S1 T8); `AddDeviceModal` untouched (S2) | pending | 2026-08-05 verified (S1) |
| Journal entry table | `web/react-gui/src/components/journal/desktop/EntryTable.tsx` | missing (S3); confirmed: no `EntryTable` file or reference exists anywhere under cloud `frontend/src`; cloud's only journal-adjacent component is `components/journal/JournalReferencePanel.tsx`, unrelated | pending | 2026-08-04 verified (S0 self-review) |
| Irrigation zone card | `web/react-gui/src/components/farming/IrrigationZoneCard.tsx` (609 lines; S1 fixed its delete-button hover) | partial (pending walkthrough): cloud card (534 lines) gains `canWrite`/`mutationsSupported` gating with the explicit not-available state (S1 T5), water card rethemed onto ui-core tokens and SWT_1/2/3 chip labels (S1 T7); zone-level conflict/rejection surfacing already live via `PendingStateNotice` | pending | 2026-08-05 verified (S1) |
| Schedule section + advanced drawer | `web/react-gui/src/components/farming/ScheduleSection.tsx` (415 lines), `AdvancedScheduleDrawer.tsx` (471 lines) | partial (pending walkthrough): cloud `ScheduleSection.tsx` (505 lines) carries the full edge trigger vocabulary plus desired-state surfacing with retry (`ScheduleSection.desiredState.test.tsx`); cloud drawer (463 lines) close in size; mounts now write/capability gated at the card (S1 T5); cohesion depth needs the walkthrough | pending | 2026-08-05 verified (S1) |
| Zone config + irrigation calibration | `web/react-gui/src/components/farming/ZoneConfigModal.tsx` (536 lines) | partial (pending walkthrough): cloud modal (829 lines) already submits config and calibration through `updateConfig`/`updateCalibration` and renders `PendingStateNotice` for the calibration operation; access gated at the card (S1 T5); ui-core adoption inside the modal deliberately deferred (D7 cohesion, single-sided component) | pending | 2026-08-05 verified (S1) |

## Using this matrix

Each later slice appends or edits rows for the screens/widgets it touches:
flip `missing`/`partial` toward `parity` only after a real side-by-side
walkthrough against the edge GUI running on `agrolink-test-01`, link the
walkthrough evidence (screenshot pair, recorded session, or review diff), and
update that row's provenance date. Do not bulk-refresh every date when
editing one row; an untouched row keeping its old date is the signal that it
still needs a look.
