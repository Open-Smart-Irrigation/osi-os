# AgroLink design alignment — IA change and page audit

Decided 2026-07-14: the primary tabs become **Zones · Data · Journal**. History and
Analysis are the same job (inspecting recorded data) rendered for different form
factors, so they stop being separate destinations: the Data tab routes to
`/history` on mobile and `/analysis` on desktop (`isDesktopBrowser()` already
draws this line for the header's Data button). Journal waits for
`feat/field-journal-slice1` before its page is aligned.

This document is the work list only. Nothing here is implemented yet except the
reference design on the dashboard (Balken crown, glass chrome header,
`btn-liquid` actions, red active-tab underline; commits `18c301dc`,
`7b044b55`).

## IA work items

| # | Item | Detail |
|---|---|---|
| 1 | Extract a shared `AppHeader` | `DashboardHeader` is rendered only by `FarmingDashboard`. Crown + glass chrome + tabs must become one shared component that every top-level page mounts, with a slot for page-specific actions. |
| 2 | Tab set → Zones/Data/Journal | Replace `tabs.history`/`tabs.analysis` keys with `tabs.data`/`tabs.journal` in `dashboard.json` (all 7 locales + feed mirror under `feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/locales/`). |
| 3 | Device-aware Data target | Data tab links `/analysis` when `isDesktopBrowser()`, else `/history`. Active-state must match both paths (`/history`, `/history/*`, `/analysis`). |
| 4 | Trim the action row | Tabs make the Data and Journal header buttons redundant. Proposed row: Add · Settings · Account. Needs a decision before implementation. |
| 5 | `/journal` route | Replace the catch-all→dashboard fallback with the real route once the journal feature lands. |
| 6 | Contract tests | `tests/agrolinkBranding.test.ts` (locale mirror) and `DashboardHeader.test.tsx` (tab links, active state) must follow items 2–4. |

## Page audit

Reference = the aligned dashboard: Balken crown on white (scrolls away), sticky
`glass-chrome` header, `btn-liquid` actions, plain page title, red underline on
the active tab.

| Surface | Current state | Needed | Blocked on |
|---|---|---|---|
| `FarmingDashboard` (Zones) | Aligned (the reference) | Adopt shared `AppHeader` when extracted (item 1) | — |
| `HistoryDashboard` desktop header | Own solid header (`--header-bg` + `shadow-xl`), separate title key, `high-contrast-text` on a light surface, no crown, no tabs | Shared header with Data tab active; move its view controls into the actions slot as `btn-liquid` | Item 1 |
| `HistoryMobileHeader` | Compact solid bar, no crown | Crown (scroll-away) + `glass-chrome`; keep the compact height; this is the primary mobile surface | Item 1 |
| History detail routes (`HistoryCardDetailPage`, zone/card, gateway/card) | Mobile `HistoryDetailHeader` / desktop detail shells, plain surfaces | Subpage treatment: slim glass bar + back affordance. Whether subpages carry the crown is an open decision (see below) | Decision A |
| `AnalysisRoute` / `CrossZoneAnalysisPage` | `h-screen` flex layout; slim solid header with "back to dashboard" link + own title | Becomes the desktop Data target: shared header with tabs. The fixed-height layout scrolls internally, so a scroll-away crown does nothing there — either pin the crown or omit it (Decision A) | Item 1, Decision A |
| `SettingsPage` | Section list, no branded page header | Second tier: shared header (no tab active) or slim glass bar | Item 1 |
| `AccountLink`, `SupportRequests` | Unbranded utility pages | Second tier, same treatment as Settings | Item 1 |
| `Register` | Old pre-crown layout: bare title with `high-contrast-text`, solid blue CTA, flat background | Align with Login: Balken crown on the card, Noto Sans wordmark, `login-scene` backdrop, red-glass primary CTA | — (independent) |
| Monitor modals (`SensorMonitor`, `RainMonitor`, `WindMonitor`, legacy `DendrometerMonitor`) | Use `--header-*` tokens, so they already flipped to neutral | Optional polish: `glass-chrome` modal title bars | — (optional) |
| Journal page | Does not exist | Full alignment on arrival: shared header, Journal tab active | `feat/field-journal-slice1` |

## Decisions (resolved 2026-07-14)

- **A — crown placement.** Terminology: "top-level pages" are the tab
  destinations (Zones `/dashboard`; Data `/history` mobile / `/analysis`
  desktop; Journal `/journal`); "subpages" are the drill-in detail routes
  below them (history card detail, gateway card detail, cross-zone
  deep-dive). Every top-level page carries the full Balken crown — on the
  analysis page's fixed-height layout it sits pinned above the internal
  scroll area. Subpages get the slim glass bar with a back affordance and no
  crown.
- **B — action row**: confirmed as Add · Settings · Account; the Data and
  Journal buttons leave the header when the tabs take over.
- **C — touch sweep**: rejected; the hover sweep stays desktop-only.

## After each alignment lands

Re-run the design-sync driver so the affected cards (`HistoryMobileHeader`,
`HistoryDesktopShell`, analysis panels, modals) re-render and regrade in the
AgroLink Claude Design project; the conventions header already teaches the
glass vocabulary.
