# design-sync notes — AgroLink (web/react-gui)

Repo-specific gotchas for re-syncs. Read before touching the config or previews.

## Build / converter

- This is an **app repo, not a packaged DS**: no dist library entry. `cfg.entry` deliberately points at a nonexistent `web/react-gui/dist/index.js` so the converter's PKG_DIR walker lands on `web/react-gui/package.json` and then falls back to synthesizing the entry from `src/`. The two `[NO_DIST]` warns on every build are **expected**.
- `source-kit.mjs` is forked (`.design-sync/overrides/`, declared in `cfg.libOverrides`): excludes `main.jsx` (app bootstrap — mounts the app + inits HTTP-backend i18n), `dsPreview.tsx` (ships via `extraEntries` instead), and the legacy `farming/DendrometerMonitor.tsx` (name collides with the canonical `dendrometer/DendrometerMonitor.tsx`; ambiguous star exports get dropped silently).
- `ValveCancelButton` is a default-only export — invisible to the synth entry's `export *`; re-exported by name from `dsPreview.tsx`. The `[EXPORT_COLLISION] ValveCancelButton` build warn is **expected and harmless** (both bindings are the same component).
- `cfg.cssEntry` = `build/ds-entry.css`, a stable-name copy of Vite's hashed CSS output; `cfg.buildCmd` regenerates it (`npm run build && cp build/assets/index-*.css build/ds-entry.css`). Tailwind v4 — never point cssEntry at `src/index.css` (raw `@import "tailwindcss"` doesn't resolve in esbuild).
- `.ds-sync` converter deps: `typescript@5.9.3` is **pinned** — typescript@7's ESM export shape hides `createSourceFile` from validate's namespace import and the `.d.ts` parse check silently skips. Playwright: cached chromium 1228 matches current playwright; both installed in `.ds-sync`.

## Preview environment (dsPreview.tsx)

- i18n: previews use an **isolated i18next instance** via `I18nextProvider` with inline `en` resources imported from `public/locales/en/*.json`. The app's own `src/i18n/config.ts` still executes at bundle load (LanguageSwitcher imports `SUPPORTED_LANGUAGES` from it) and inits the **global** singleton with an HTTP backend — the `/gui/locales/*.json` fetch errors in the preview console are expected noise, not a failure.
- Auth: `localStorage` is seeded with a fake token/username so auth-aware chrome renders logged-in state.
- **XHR shim**: all `/api/*` GETs are answered with canned data (zones incl. schedule, environment-summary, system stats/features, empty analytics/actuations); unknown `/api` routes get a clean 404. Previews can add routes by pushing `[regex, dataOrFn]` onto `window.__dsApiRoutes` before render.
- **CRITICAL fixture rule**: several components map over API arrays *before* their `available` guards (e.g. `WaterTab` does `water.daily.map` first) — canned fixtures must be **shape-complete** (all arrays present, even when `available: false`) or the whole preview tree unmounts blank.

## Preview authoring patterns

- Collapsed-by-default cards (`IrrigationZoneCard`: `useState(true)`, no prop): use the `AutoExpand` helper pattern from `.design-sync/previews/IrrigationZoneCard.tsx` — real clicks on the chevron toggle buttons (`button span[style*="rotate(-90deg)"]`), two passes 50 ms apart (nested toggles appear after the first expand).
- Realistic fixtures: crib from `src/components/farming/__tests__/*.test.tsx` and `src/types/farming.ts`. Device types seen live: `KIWI_SENSOR`, `DRAGINO_LSN50`, `SENSECAP_S2120`, `AQUASCOPE_LORAIN`, `STREGA_VALVE`.

## Product bug found during sync (branding branch)

- **DashboardHeader clips its own dropdown menus**: the AgroLink branding commit added `overflow-hidden` to `<header>` to crop the Balken image; the Add/Account `HeaderMenu` dropdowns are absolutely positioned inside the header and get clipped at its bottom edge — in the branded app itself, not just previews (mainline header has no `overflow-hidden`). Suggested fix: move `overflow-hidden` off `<header>` onto a wrapper div around the Balken `<img>`. Until fixed, the DashboardHeader preview deliberately has no open-menu story.

## Preview authoring patterns (wave learnings, 2026-07-13)

- **Frozen capture clock**: `Date.now()` inside the capture browser is not the wall date. Fixtures compared against "today" (calendars, day-dimming) must derive from `new Date()` at render time; relative offsets ("2 h ago") are safe; fixed chart-series timestamps are fine.
- **Capture frame is fixed 900×700** (`fullPage: false`); `cfg.overrides.<Name>.viewport` is config-level (orchestrator only). Compose tall stories to fit the top 700 px; below-the-fold clipping is acceptable when the essential content is in frame (IrrigationZoneCard precedent).
- **Capture flags cells whose text starts with `⚠`** as errors — a component whose own icon is `⚠` (emergency IrrigationActionBanner) needs a muted caption above it so the cell text doesn't lead with the icon.
- **Charts collapse at auto height**: history chart views (`flex-1` + absolute-inset container) need a fixed-height `display:flex; flex-direction:column` parent (~340 px).
- **`Number(null)` renders fake zeros** (LoRainGaugeCard `formatNumber`): empty-state fixtures must OMIT `latest_data` keys, never pass `null`.
- **Flex rows stretch dropdown anchors**: frame popover components (HeaderMenu, LanguageSwitcher) with `alignItems: 'flex-start'` or the dropdown detaches from its trigger.
- **WeatherIcon animations pass through `opacity: 0`** — use `animated={false}` in cells that must prove precipitation elements exist.
- **Self-fetch contracts**: StregaValveCard GETs `/api/v1/devices/<eui>/today-liters` (`{liters, source}`); HistoryCardFrame GETs `/api/history/zones/:id/cards/:cardId/data` and drops responses unless `cardId`/`cardType` echo the summary. Serve per-preview via `__dsApiRoutes`.
- **IrrigationOutcomesPanel persists** `osi.recentIrrigations.advancedView` in localStorage — previews driving that checkbox must reset it after the click.
- **ScheduleSection `applySchedule` reads `responseMode` camelCase only** while the rest of the schedule row is snake_case.
- **SystemPanel** (prop-less, one shared stats URL): variant axis = real-click internal states (e.g. reboot confirm), same idea as AutoExpand.
- **DeviceCardFooter derives percent from voltage** when `batteryPercent` absent — a voltage-only fixture showing a battery pill is correct behavior.
- Soil profile `status` vocabulary: `optimal`/`dry_stress`/`wet_excess`; calendar marker `labelKey`s must be real `history.calendar.marker.*` i18n keys.

## Known render warns (triaged legitimate)

- `[NO_DIST]` ×2 per build — synth-entry mode, expected.
- `[EXPORT_COLLISION] ValveCancelButton` — same binding, expected.
- Preview-console locale fetch errors (`/gui/locales/...`) — global i18n singleton noise, expected.

## Re-sync risks

- `build/ds-entry.css` is regenerated per build from a hashed filename glob — if Vite's output layout changes, the `cp` in buildCmd silently matches nothing; check the copy exists after build.
- Canned API fixtures in `dsPreview.tsx` mirror runtime types by hand (WaterEnvironment etc.); a backend/type change can silently break fixture shape → blank previews. The render check catches it; fix the fixture, not the component.
- The `source-kit.mjs` fork must be re-diffed against the bundled `lib/source-kit.mjs` after skill updates (offer to merge upstream changes).
- Grades/verification state live in the uploaded `_ds_sync.json`, not git.
