# Plan — Journal Slice A: Detail-level as a global per-user setting

**Spec:** [2026-07-20-journal-capture-streamlining-design.md](../specs/2026-07-20-journal-capture-streamlining-design.md) (D1, §7; effective-template guard §4)
**Branch:** `design-sync/agrolink` (agrolink worktree)
**Risk:** low · **Migration:** none

## Goal

Detail level (`Quick` / `Full` / `Research`) becomes a **global per-user preference**, default `Quick`, changed **only in Settings**. Remove the per-entry template picker from the capture flow. The chosen level drives which template the capture form uses, clamped to the plot layout's `supported_templates` (U4: an Agroscope researcher-only layout still floors to Research even for a Quick user).

## Program constraints (all slices)

- No `flows.json` node-graph edits. GUI + catalog + edge helper modules only.
- Historical entries keep resolving: never edit existing template/layout versions (`farmer_quick@1/@2`, catalog v1/v2); ship new behaviour as new versions.
- All user-facing strings via i18n keys across the 7 locales (`en, de-CH, fr, it, es, pt, lg`).
- No `any`; explicit prop/type interfaces; handle loading/empty/error states (frontend-design skill).
- Each slice ends: unit tests green → build → deploy to kaba100 via osi-live-ops-runbook → live re-test → owner sign-off. Never overwrite `/data/db/farming.db`.

## Context (verified)

- Preferences today are **client-side localStorage** via `web/react-gui/src/utils/displayPreferences.ts` (`osi.display.*` keys: theme, swtUnit, dashboardDensity, modules…), surfaced in `web/react-gui/src/pages/SettingsPage.tsx`. This is the right store: per-browser matches the capture→enrich hand-off (each viewer's device carries its own level) and needs no migration.
- `JournalCaptureFlow.tsx`: `const [templateCode, setTemplateCode] = useState('farmer_quick')` (~L572); templates derived from `layout.supported_templates` (~L680); `template = templates.find(c => c.code === templateCode) ?? templates[0]` (~L690). Template code/version is still recorded on the entry (`template_code`, `template_version`).

## Tasks

### Task A1 — Add `journalDetailLevel` to display preferences
- **Files:** `web/react-gui/src/utils/displayPreferences.ts` (+ `__tests__/displayPreferences.test.tsx`).
- Add key `osi.journal.detailLevel`, type `JournalDetailLevel = 'farmer_quick'|'full_record'|'research_observation'`, default `'farmer_quick'`. Add to `DisplayPreferences` interface + read/write + the `osi-display-preferences` event + any `usePreferences` hook.
- **Tests:** default is `farmer_quick`; set/get round-trips; unknown stored value falls back to default; change fires the event.

### Task A2 — Settings UI control
- **Files:** `web/react-gui/src/pages/SettingsPage.tsx` (+ `__tests__/SettingsPage.test.tsx`); locale files `web/react-gui/public/locales/<lang>/*.json` (all 7).
- Add a labelled 3-way segmented control "Journal detail level" with helper copy ("How much detail do you record? You can change this any time."). Options Quick / Full / Research. Wire to A1 pref.
- **Tests:** renders three options; selecting persists via the pref; reflects stored value on mount. i18n keys present in every locale.

### Task A3 — Capture flow reads the pref; remove per-entry picker; effective-template guard
- **Files:** `web/react-gui/src/components/journal/capture/JournalCaptureFlow.tsx` (+ its test); possibly `web/react-gui/src/journal/catalogModel.ts`/`templateEngine` only if a clamp helper belongs there.
- Initialise `templateCode` from the `journalDetailLevel` pref. Compute **effective template** = pref if `layout.supported_templates` includes it, else the layout's lowest supported template (order defined by the catalog's `supported_templates` array — first = lowest). Recompute on layout change and on draft resume (the *viewing* user's current pref governs — supports two-phase enrich).
- **Remove** the per-entry template selector UI (the Quick/Full/Research control in the flow) — this includes the now-dead `chooseTemplate` callback (~L1644), the `templateOptions` array (~L1721), and the `<select>` at ~L1837 — and update any `JournalCaptureFlow.test.tsx` assertions that expect the picker to be present. Keep `template_code`/`template_version` recording intact.
- **Tests:** with pref=Quick on `open_field` → `farmer_quick`; with pref=Quick on a researcher-only layout (`agroscope_open_field`, `supported_templates` excludes `farmer_quick`) → floors to `research_observation`; with pref=Research on `open_field` → `research_observation`; no template picker rendered.

## Verification

- **Unit:** `cd web/react-gui && npm run test:unit` (vitest) + tsx tests green; `npm run build` clean.
- **Live (kaba100, mobile + desktop UA):**
  1. Fresh login → capture an activity: default form is **Quick** depth, **no template picker** shown.
  2. Settings → set **Research** → new capture shows the deeper Research form.
  3. On an `agroscope_open_field` plot with pref=Quick → form still floors to **Research** (U4 preserved).
  4. Existing journal entries still open/resolve unchanged.

## Out of scope

Activity-scoping of fields (Slice BC), plot-context relocation (BC), crop-cycle (D). Slice A only changes *which template* is used and *how it's chosen* — not the fields within a template.
