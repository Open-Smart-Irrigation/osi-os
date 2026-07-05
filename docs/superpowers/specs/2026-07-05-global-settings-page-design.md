# Global Settings Page — Design

**Date:** 2026-07-05
**Status:** Draft for user review
**Scope:** osi-os React GUI.

## Problem

The dashboard header currently exposes language as a standalone button. That works for one preference, but the app now needs a cleaner home for global display choices such as language, view mode, and SWT unit preference. Adding more header toggles would make the dashboard noisy and create inconsistent state across pages.

## Decision

Introduce a global settings page and replace the header language button with a settings entry point. Language selection moves into the settings page. SWT unit preference also lives there.

This settings page is a separate UI plan from pF data support so it can be designed properly instead of being squeezed into the pF database/scheduler work.

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

The first settings page should include three sections:

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

### Display

Add global display/view preferences that are safe to persist locally:

```text
Preferred dashboard view: default current behavior initially
SWT unit: kPa | pF
```

The SWT unit preference controls ordinary display surfaces:

- live device cards,
- zone summaries,
- history cards,
- analysis axes and tooltips,
- soil profile values.

Schedule threshold input does not blindly follow this preference; it has its own explicit `kPa | pF` selector because that choice changes schedule semantics.

### About/Operational Context

Keep this section minimal. It may show app/build information later, but it should not become a diagnostics dumping ground in the first increment.

## Persistence

Use local browser persistence for the first increment:

```text
osi.display.swtUnit = 'kPa' | 'pF'
osi.display.viewMode = string
```

This is enough for the edge GUI and avoids adding account/preference sync before the product behavior is proven. A later cloud-backed preference model can migrate these values if needed.

Language remains owned by i18next's existing persistence mechanism.

## Data Flow

Create a small frontend preference module or context:

```text
readDisplayPreferences()
writeDisplayPreferences(next)
useDisplayPreferences()
```

Consumers should not read localStorage directly. This keeps unit formatting and preference changes testable.

SWT rendering should call a shared formatter:

```text
formatSwtValue({ kpa, pf }, preferredUnit)
```

This prevents each card/chart from inventing its own pF fallback behavior.

## UI Rules

- Use segmented controls for binary choices like `kPa | pF`.
- Use radio/select style lists for language.
- Keep settings dense and operational, not a marketing/preferences landing page.
- Do not put a card inside another card.
- Use existing colors and header/layout conventions.

## Testing

Required verification:

- Header tests prove the language switcher is replaced by a settings entry point.
- Settings page tests prove language can be changed from the page.
- Preference tests prove SWT unit is persisted and reloaded.
- Display tests prove a component renders kPa or pF based on the global preference.
- Schedule tests prove the threshold unit selector remains explicit and independent of global display preference.

## Non-Goals

- Do not sync settings to osi-server in the first increment.
- Do not redesign account management.
- Do not add every possible app preference before a real user need exists.
- Do not remove existing history card-specific settings menus; those are local to history cards, not global app settings.
