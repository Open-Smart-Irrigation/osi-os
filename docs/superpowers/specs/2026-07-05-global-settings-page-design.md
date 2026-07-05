# Global Settings Page — Design

**Date:** 2026-07-05
**Status:** Revised after expert review (see
`docs/superpowers/prompts/swt-pf-settings-spec-review/review-2026-07-05.md`) —
ready for planning.
**Scope:** osi-os React GUI (plus one edge bulk-timezone endpoint).

## Problem

The dashboard header currently exposes language as a standalone button. That works for one preference, but the app now needs a cleaner home for global display choices such as language, view mode, and SWT unit preference. Adding more header toggles would make the dashboard noisy and create inconsistent state across pages.

## Decision

Introduce a global settings page and replace the header language button with a settings entry point. Language selection moves into the settings page. SWT unit preference also lives there.

This settings page is a separate UI plan from pF data support so it can be designed properly instead of being squeezed into the pF database/scheduler work.

Settings are split by persistence and blast radius:

- local display preferences: language, color theme, dashboard/view defaults, SWT display unit;
- farm defaults: timezone for new zones;
- bulk operational actions: applying a timezone to all existing zones.

This distinction keeps harmless UI changes instant while making operational changes explicit.

## Entry Point

Replace the header `LanguageSwitcher` control with a settings button/link. The control should be present where the current language button appears in `DashboardHeader`.

Recommended behavior:

- Desktop: header button labelled `Settings`.
- Mobile/small header: same control position and sizing pattern as the current language button.
- The existing account menu remains focused on account/link/logout actions.

The page route can be:

```text
/settings
```

## Settings Surface

The first settings page should include these sections:

### Language

Move the existing supported language list into the settings page:

```text
English
Deutsch (CH)
Français
Italiano
Español
Português
Luganda
```

Changing language should continue to use the existing i18next localStorage key, `i18n_language`.

### Appearance

Add color-theme selection:

```text
Theme: Light | Dark | System
```

Initial implementation must support the current light theme plus a dark theme. `System` follows `prefers-color-scheme` and falls back to light if the browser does not expose a preference.

Theme should be implemented through CSS custom properties, not per-component conditional styling. The current `:root` variables become the light theme. Add a dark variable set under a document-level selector such as:

```text
html[data-theme='dark']
```

The app should set `document.documentElement.dataset.theme` from the stored preference.

**Reality check on scope (from code inspection):** the `:root` variable set exists (`index.css`) but `var(--…)` usage is largely confined to `App.css`/`index.css`, while the `.tsx` components carry roughly 194 hardcoded hex colors in inline styles. Flipping root variables will restyle the shell and leave most card/chart interiors light. Therefore:

- The first shippable dark increment covers the **app shell**: header, page backgrounds, card container surfaces, and primary typography via the existing variables.
- Chart and data-visualization interiors are **explicitly exempt** — they keep a light card surface in dark mode until their inline hex colors are swept component-by-component. `WindRoseChart` (which already observes `data-theme` via a MutationObserver) is the reference pattern for making a chart theme-aware.
- The settings page ships independently of the theme slice; dark mode must not block it.
- Shell-first dark mode with visibly light chart cards is the accepted, non-broken increment; each subsequent component sweep is its own small change.

Future color themes can extend the same mechanism, but the first increment includes only light, dark, and system.

### Units And Display

Add global display/view preferences that are safe to persist locally:

```text
Dashboard density: Comfortable | Compact
SWT unit: kPa | pF
```

`Comfortable` is the current dashboard spacing and card density. `Compact` reduces vertical spacing and secondary text density for repeated field use, but it must not hide primary readings or actions.

The SWT unit preference controls ordinary display surfaces:

- live device cards,
- zone summaries,
- history cards,
- analysis axes and tooltips,
- soil profile values.

Schedule threshold input does not blindly follow this preference; it has its own explicit `kPa | pF` selector because that choice changes schedule semantics.

### Time And Zones

Add a global farm timezone control:

```text
Farm timezone: IANA timezone string, e.g. Europe/Zurich
Apply timezone to all zones
Use browser timezone
```

This setting has two related effects:

- it becomes the default timezone for newly created zones;
- when the user explicitly chooses `Apply timezone to all zones`, it updates every existing zone's `irrigation_zones.timezone`.

Do not silently overwrite all existing zones when the user merely changes the default. Applying to all zones is a separate confirmed action because zone timezone affects history ranges, daily environment aggregation, local-date rollups, and scheduler context.

The UI should show the number of zones that will be changed before applying. The action should be all-or-nothing from the user's perspective: if any update fails, report the failure and refresh zone state rather than pretending all zones changed.

**Bulk-apply semantics (edge):** the endpoint executes a single ownership-scoped statement —

```sql
UPDATE irrigation_zones
   SET timezone = ?, updated_at = ?, sync_version = sync_version + 1
 WHERE user_id = ? AND deleted_at IS NULL AND timezone <> ?
```

— which is atomic by construction, so all-or-nothing comes free. The existing zone `AFTER UPDATE` trigger already includes `timezone` in its change-detection list and emits one `UPSERT_ZONE` sync event per changed row, so cloud sync rides existing rails with no new sync machinery. Align the `sync_version` handling with the existing per-zone `PUT /api/irrigation-zones/:zone_id/timezone` handler. The response reports rows actually changed (`updatedZones`), not rows matched.

The confirmation dialog must state the real blast radius: the change affects scheduler timing, new daily rollups, and history range boundaries **from now on**; already-recorded daily history is not recomputed.

**Validation:** client-side against `Intl.supportedValuesOf('timeZone')`. Edge-side, validate with a `new Intl.DateTimeFormat('en', { timeZone: tz })` try/catch — but first verify the on-device Node build ships full ICU; if it is small-icu, fall back to client-side validation plus a server-side sanity pattern, and document that in the plan. Do not accept arbitrary non-empty strings silently.

**Default-timezone visibility:** the zone-creation form must display the effective timezone it will use (from `resolvePreferredTimezone()`: stored preference → browser `Intl` zone → `'UTC'`), so the per-browser nature of the local default is visible rather than silent.

### Data And Refresh

Add only low-risk display defaults in the first increment:

```text
Auto-refresh dashboard: On | Off
```

Auto-refresh should control frontend polling/refresh behavior only. It must not change sensor uplink intervals, LoRaWAN device settings, or scheduler cadence.

A global `Default history range` setting was considered and **cut from the first increment**: per-card range preferences already exist server-side (`PUT /api/history/zones/:zoneId/cards/:cardId/preferences`), and a second, competing default would create precedence confusion for no proven need.

### About/Operational Context

Keep this section minimal. It may show app/build information later, but it should not become a diagnostics dumping ground in the first increment.

## Persistence

Use local browser persistence for the first increment:

```text
osi.display.swtUnit = 'kPa' | 'pF'
osi.display.dashboardDensity = 'comfortable' | 'compact'
osi.display.theme = 'light' | 'dark' | 'system'
osi.display.dashboardAutoRefresh = 'on' | 'off'
osi.defaults.timezone = IANA timezone string
```

This is enough for the edge GUI and avoids adding account/preference sync before the product behavior is proven. A later cloud-backed preference model can migrate these values if needed.

Language remains owned by i18next's existing persistence mechanism.

Applying a timezone to all existing zones is not just local persistence. It updates zone records through the edge API and therefore participates in the existing zone sync path.

## Data Flow

Create a small frontend preference module or context:

```text
readDisplayPreferences()
writeDisplayPreferences(next)
useDisplayPreferences()
applyThemePreference(preference)
resolvePreferredTimezone()
```

Consumers should not read localStorage directly. This keeps unit formatting and preference changes testable.

SWT rendering should call a shared formatter:

```text
formatSwtValue({ kpa }, preferredUnit)
```

The formatter derives pF from kPa via the shared converters (see the pF spec: kPa is the only stored measurement unit). This prevents each card/chart from inventing its own pF fallback behavior.

Bulk timezone changes use a dedicated edge endpoint. To stay in the existing route namespace (all zone operations live under `/api/irrigation-zones/…`), the endpoint is:

```text
PUT /api/irrigation-zones/timezone
```

Payload:

```json
{ "timezone": "Europe/Zurich" }
```

Response:

```json
{ "timezone": "Europe/Zurich", "updatedZones": 12 }
```

The dedicated endpoint is required (not optional): a frontend loop over per-zone APIs cannot be atomic, while the single scoped UPDATE described under Time And Zones is. It validates, updates, and reports the bulk change in one place.

## UI Rules

- Use segmented controls for binary choices like `kPa | pF`.
- Use radio/select style lists for language.
- Use a segmented control or radio group for theme: `Light | Dark | System`.
- Use an input with detected suggestions for timezone, plus a clear `Apply to all zones` action.
- Require confirmation for any bulk setting that mutates zone data.
- Keep settings dense and operational, not a marketing/preferences landing page.
- Do not put a card inside another card.
- Use existing colors and header/layout conventions.

## Testing

Required verification:

- Header tests prove the language switcher is replaced by a settings entry point.
- Settings page tests prove language can be changed from the page.
- Preference tests prove SWT unit is persisted and reloaded.
- Theme tests prove light/dark/system preferences set the document theme, survive reload, and that exempted chart surfaces keep their light styling in dark mode.
- Timezone tests prove the default timezone persists locally, the zone-creation form shows the effective timezone, and the bulk apply action updates only the authenticated user's zones, only after confirmation, emitting one `UPSERT_ZONE` outbox row per changed zone (assert against SQLite) and reporting the actual changed count.
- Display tests prove a component renders kPa or pF based on the global preference.
- Schedule tests prove the threshold unit selector remains explicit and independent of global display preference.
- Regression tests prove auto-refresh preference does not change device uplink intervals or scheduler cadence.

## Non-Goals

- Do not sync settings to osi-server in the first increment.
- Do not redesign account management.
- Do not add every possible app preference before a real user need exists.
- Do not remove existing history card-specific settings menus; those are local to history cards, not global app settings.
- Do not silently bulk-update existing zones when changing a default timezone.
- Do not add multiple branded color palettes in the first increment; dark mode is the first additional theme.
- Do not add a global default-history-range preference in the first increment (see Data And Refresh).
- No settings-driven change may alter scheduler or irrigation-event semantics: the SWT unit preference is display-only; the schedule editor's explicit unit selector is the only semantic unit control.
