---
name: osi-react-gui-patterns
description: Use when web/react-gui routes, pages, components, service APIs, feature flags, i18n strings, tests, build behavior, or TypeScript types are changed in osi-os.
---

# OSI React GUI Patterns

## Overview

The edge GUI is a static Vite build served by Node-RED under `/gui`. It must
work on-device without server-side routing and must preserve missing data as
missing, especially for agronomy and telemetry.

Verified sources to re-check before edits:

- `AGENTS.md` TypeScript and missing-data rules.
- Repo-root `architect.yaml` and `RULES.yaml`.
- `docs/agents/typescript-rule-overlays.md`.
- `web/react-gui/src/App.tsx`.
- `web/react-gui/vite.config.js`.
- `web/react-gui/src/services/api.ts`.
- `web/react-gui/src/i18n/config.ts`.
- `web/react-gui/package.json`.

## Serving and Routing

- Node-RED serves the built GUI under `/gui`.
- Vite uses `base: '/gui/'`; preserve this unless the Node-RED static path
  changes with it.
- `App.tsx` uses `HashRouter`. Deep links must be hash routes, not server
  paths that require BrowserRouter support.
- Avoid absolute asset paths outside `/gui/`; they break on-device even when
  they work in local Vite dev.

## Auth and Routes

- Authenticated routes use `PrivateRoute` from
  `web/react-gui/src/components/PrivateRoute.tsx`.
- Token storage, login/logout state, and auth-expiry cleanup live in
  `web/react-gui/src/contexts/AuthContext.tsx` and
  `web/react-gui/src/services/api.ts`.
- For new protected pages, copy the newest route block in `App.tsx` and keep
  auth behavior byte-for-byte where possible.

## i18n

- `web/react-gui/src/i18n/config.ts` wires `i18next`, `react-i18next`,
  `LanguageDetector`, and `HttpBackend`.
- Locale files are served from `/gui/locales/{{lng}}/{{ns}}.json`.
- Farmer-facing strings should use `t()` when adjacent/current pages are
  already localized.
- Add new keys to every locale directory under `web/react-gui/public/locales/`.
  Non-English strings may initially mirror English when the issue scope is key
  coverage.
- `LanguageSwitcher` already exists; reuse it instead of creating a separate
  language control.
- i18n coverage is incomplete (`AGENTS.md` issue #47). Copy the newest
  compliant page or test pattern instead of normalizing old hardcoded strings
  opportunistically.

## Service and Data Boundary

- REST calls go through `web/react-gui/src/services/api.ts`.
- Keep snake_case/camelCase compatibility and EUI normalization in service
  helpers, not presentational components.
- SWR is the existing fetch-hook pattern for dashboard, history, and analysis
  data.
- Shared domain types live in `web/react-gui/src/types/farming.ts`.
- System feature flags come from `/api/system/features`; client defaults stay
  all-false while loading (`useFeatureFlags`).

## Missing Data Rule

`null` means unavailable. Do not coerce nullish telemetry, weather, rain,
battery, SWT, dendrometer, or recommendation data into plausible values like
`0`, `24`, or `-42`. Render an unavailable state and test that zeros remain
valid when they are measured zeros.

Known helper/test precedent:

- SWT: `web/react-gui/src/utils/swt.ts` and `src/utils/__tests__/swt.test.ts`.
- Rain no-sample vs measured-dry behavior: `web/react-gui/src/utils/rain.ts`.
- Battery null handling: `web/react-gui/tests/deviceCardBattery.test.ts`.

## Rule Overlays

Before TypeScript edits:

1. Match the target file against repo-root `architect.yaml`.
2. Read the corresponding `RULES.yaml` section.
3. Apply it as an advisory overlay on the existing local pattern and tests.

The overlays do not replace TDD, explicit repo instructions, or verification
evidence.

## Verification

From `web/react-gui`:

```bash
npm run typecheck
npm run test:unit
npm run build
```

`npm run test:unit` chains:

- `npm run test:unit:tsx-runner` for `tests/**/*.test.ts`.
- `npm run test:unit:vitest` for `src/**/__tests__` and selected component
  test directories.

Also run `git diff --check` from the repo root before committing.

`npm run typecheck` (`tsc --noEmit`) is CI-gated; `vite build` does not
typecheck.

## Common Mistakes

- Replacing `HashRouter` with `BrowserRouter` and breaking on-device deep links.
- Adding `/assets/...` or `/locales/...` paths that bypass `/gui/`.
- Creating a route without the `PrivateRoute` wrapper.
- Putting API compatibility normalization inside a component.
- Adding English UI text without locale keys on localized pages.
- Treating feature flags as enabled while `/api/system/features` is still
  loading.
- Rendering missing agronomy data as a plausible numeric default.
- Running only Vitest and forgetting the `tests/**/*.test.ts` tsx runner.
- Relying on `npm run build` to catch type errors — `vite build` does not
  typecheck; run `npm run typecheck`.
