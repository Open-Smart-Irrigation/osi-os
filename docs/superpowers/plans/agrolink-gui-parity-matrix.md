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
| Valve card (STREGA) | `web/react-gui/src/components/farming/StregaValveCard.tsx` (867 lines) | partial (pending walkthrough): cloud card (832 lines) actuates via `OPEN_FOR_DURATION` with a 1–255 min duration control, no bare CLOSE (S2 T6, matching edge + STREGA rules); actor-carrying `VALVE_COMMAND` denials render legibly on both paths — immediate 403 `scope_denied` (S2 T2) and async edge `scope_denied`/`scope_actor_required` via `PendingStateNotice` (S2 T5); `readOnly` required (S2 T4). Deviations: no cancel-queued-open button (edge cancel is an edge-local route; no cloud→edge cancel command exists) and no today-liters line. Live `OPEN_FOR_DURATION` against `agrolink-test-01` still required before this row may flip (spec S2 gate) | pending | 2026-08-05 verified (S2) |
| Weather card (S2120) | `web/react-gui/src/components/farming/SenseCapWeatherCard.tsx` (420 lines) | partial (pending walkthrough): cloud card (434 lines); shared-read stations now appear in the cloud device list for scoped members (S2 T1 backend merge + T8 gateway-EUI scoping, matching the edge C6 behavior); ledger M3 (`text-[var(--error-bg)]` as text) and the pale error border fixed (S2 T7); card body still hardcodes English strings (i18n follow-up). Shared-read rows render read-only for every scoped non-owner (weather writes are owner-only), so the card affordance matches the backend authority (S2 T8) | pending | 2026-08-05 verified (S2) |
| Dendrometer monitor | `web/react-gui/src/components/farming/DendrometerMonitor.tsx` (359 lines) | partial (S2/S4), corrected from `missing`. Cloud has both `components/farming/DendrometerMonitor.tsx` (317 lines) and `components/farming/dendrometer/DendrometerMonitor.tsx`, referenced from `DraginoCard.tsx` and `dendrometer/DendrometerSection.tsx`; live, not stubs | pending | 2026-08-04 corrected (S0 self-review) |
| Zone / device modals | `web/react-gui/src/components/farming/CreateZoneModal.tsx` (on ui-core since S1 T9), `AddDeviceModal.tsx` (196 lines) | partial (pending walkthrough): cloud `CreateZoneModal` on ui-core targeting the active gateway (S1 T8); cloud `AddDeviceModal` likewise on the ui-core `Modal`/`FormField`/`Button` shell, registers on the active gateway with a Settings-switcher pointer, owner-gated fail-closed (S2 T9); cloud `ClaimGatewayModal.tsx` is orphaned dead code (admin-era direct claim, unmounted since the Dashboard rewrites — account linking owns gateway acquisition) | pending | 2026-08-05 verified (S2) |
| Journal entry table | `web/react-gui/src/components/journal/desktop/EntryTable.tsx` | missing (S3); confirmed: no `EntryTable` file or reference exists anywhere under cloud `frontend/src`; cloud's only journal-adjacent component is `components/journal/JournalReferencePanel.tsx`, unrelated | pending | 2026-08-04 verified (S0 self-review) |
| Irrigation zone card | `web/react-gui/src/components/farming/IrrigationZoneCard.tsx` (609 lines; S1 fixed its delete-button hover) | partial (pending walkthrough): cloud card (534 lines) gains `canWrite`/`mutationsSupported` gating with the explicit not-available state (S1 T5), water card rethemed onto ui-core tokens and SWT_1/2/3 chip labels (S1 T7); zone-level conflict/rejection surfacing already live via `PendingStateNotice` | pending | 2026-08-05 verified (S1) |
| Schedule section + advanced drawer | `web/react-gui/src/components/farming/ScheduleSection.tsx` (415 lines), `AdvancedScheduleDrawer.tsx` (471 lines) | partial (pending walkthrough): cloud `ScheduleSection.tsx` (505 lines) carries the full edge trigger vocabulary plus desired-state surfacing with retry (`ScheduleSection.desiredState.test.tsx`); cloud drawer (463 lines) close in size; mounts now write/capability gated at the card (S1 T5); cohesion depth needs the walkthrough | pending | 2026-08-05 verified (S1) |
| Zone config + irrigation calibration | `web/react-gui/src/components/farming/ZoneConfigModal.tsx` (536 lines) | partial (pending walkthrough): cloud modal (829 lines) already submits config and calibration through `updateConfig`/`updateCalibration` and renders `PendingStateNotice` for the calibration operation; access gated at the card (S1 T5); ui-core adoption inside the modal deliberately deferred (D7 cohesion, single-sided component) | pending | 2026-08-05 verified (S1) |
| Device detail page | n/a — the edge has no per-device detail route; drill-down is in-card `SensorMonitor`/`WindMonitor` overlays | partial: cloud-only page (D7 single-sided), `frontend/src/pages/DeviceDetail.tsx` at `/devices/:deviceEui`; S2 T7 rethemed its error box and `datetime-local` range inputs onto tokens; read paths cover shared-read weather devices via the backend `canReadDevice` widening; recharts chart chrome still hardcodes light-theme hex colors | pending | 2026-08-05 verified (S2) |

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
- Cloud/edge classification asymmetry on STREGA partial-open/flush: the edge
  treats them as config (`scoped-device-config-guard`), the cloud treats them
  as physical actuation (T6b). Which side is canonical is undecided.
- Cloud `POST /devices/{eui}/gateway-command` (the `ROLE_ADMIN` passthrough)
  can emit any physical command with a caller-supplied `actor_user_uuid`,
  which forges the edge's originator/audit trail. Deliberately exempt today
  (`ROLE_ADMIN` + `claimedBy` only) but needs an explicit decision, not just
  an exemption.
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
