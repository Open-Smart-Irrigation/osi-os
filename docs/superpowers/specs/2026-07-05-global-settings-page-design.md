# Global Settings Page — Design

**Date:** 2026-07-05
**Status:** Draft for user review
**Scope:** osi-os React GUI.

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

The app should set `document.documentElement.dataset.theme` from the stored preference. Components that already read CSS variables, such as charts, should continue to work when the root theme changes.

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

Timezone input must validate against browser-supported IANA zones where available. If validation support is missing, accept non-empty strings but show that they must be IANA names.

### Data And Refresh

Add only low-risk display defaults in the first increment:

```text
Default history range: Card default | 12h | 24h | 7d | 30d | Season
Auto-refresh dashboard: On | Off
```

`Card default` preserves the current per-card defaults. Choosing a concrete range overrides the default range used when opening history cards, but it must not remove each card's supported-range limits.

Auto-refresh should control frontend polling/refresh behavior only. It must not change sensor uplink intervals, LoRaWAN device settings, or scheduler cadence.

### About/Operational Context

Keep this section minimal. It may show app/build information later, but it should not become a diagnostics dumping ground in the first increment.

## Persistence

Use local browser persistence for the first increment:

```text
osi.display.swtUnit = 'kPa' | 'pF'
osi.display.dashboardDensity = 'comfortable' | 'compact'
osi.display.theme = 'light' | 'dark' | 'system'
osi.display.historyDefaultRange = string
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
formatSwtValue({ kpa, pf }, preferredUnit)
```

This prevents each card/chart from inventing its own pF fallback behavior.

Bulk timezone changes should use a dedicated edge API if available:

```text
PUT /api/settings/zones/timezone
```

Payload:

```json
{ "timezone": "Europe/Zurich" }
```

Response:

```json
{ "timezone": "Europe/Zurich", "updatedZones": 12 }
```

If the implementation starts by looping over existing per-zone config APIs, the UI must still present it as one action with clear progress and error handling. The dedicated endpoint is the cleaner target because it can validate, update, and report the bulk change consistently.

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
- Theme tests prove light/dark/system preferences set the document theme and survive reload.
- Timezone tests prove the default timezone persists locally and the bulk apply action updates zones only after confirmation.
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
