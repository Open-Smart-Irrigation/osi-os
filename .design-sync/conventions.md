# Building with AgroLink components

## 1. Required wrapper — `DsPreviewProvider`

Wrap every app you build in `DsPreviewProvider` (a bundle export). It provides three contexts the components read internally, plus offline data:

- **i18n**: components call `useTranslation()` — without the provider they render raw translation keys instead of English text.
- **Router**: cards contain `<Link>`/navigation — they crash outside a router.
- **Auth**: `useAuth()` throws outside a provider; this one is pre-seeded as a logged-in user ("demo").
- **Canned API**: self-fetching components (`StregaValveCard`, `ScheduleSection`, `EnvironmentCard`, `SystemPanel`, `HistoryCardFrame`, `IrrigationOutcomesPanel`) get realistic canned `/api/*` responses instead of error banners. To feed your own data, push `[urlRegex, jsonOrFn]` entries onto `window.__dsApiRoutes` **before** rendering — custom routes win over the defaults. Keep responses shape-complete (arrays present even when empty); several components map over arrays before checking availability flags.

```jsx
import { DsPreviewProvider, DashboardHeader, IrrigationZoneCard } from 'open-smart-irrigation';

export default function App() {
  return (
    <DsPreviewProvider>
      <DashboardHeader username="demo" onAddZone={() => {}} onAddDevice={() => {}} onLogout={() => {}} />
      {/* screens go here */}
    </DsPreviewProvider>
  );
}
```

## 2. Styling idiom — tokens first; never invent Tailwind classes

- **Design tokens** are CSS custom properties defined for light (`:root`) and dark (`[data-theme=dark]` on `<html>`): surfaces `--bg --surface --card --border`; text `--text --text-secondary --text-tertiary --text-disabled`; actions `--primary --primary-hover --focus --secondary-bg`; header `--header-bg --header-text --header-subtext`; status `--success-bg --success-text --success-border --warn-bg --warn-text --warn-border --error-bg --error-text --danger-fg`; soil states `--soil-wet --soil-moist --soil-dry` (each with a `-bg` pair); toggles `--toggle-on --toggle-off`; `--overlay`.
- The stylesheet is **compiled Tailwind v4, content-scanned**: it contains only the utility classes the dashboard already uses. A class the app never used (e.g. `bg-purple-300`) resolves to nothing. Safe reusable patterns seen throughout the app: `bg-[var(--card)]`, `text-[var(--text-secondary)]`, `border-[var(--border)]`, `flex`, `grid`, `rounded-xl`.
- For **your own layout glue**, prefer inline styles with tokens: `style={{ background: 'var(--card)', border: '1px solid var(--border)', color: 'var(--text)' }}`. Never hardcode hex values the tokens already cover.
- **Liquid-glass chrome** (iOS-26-style, AgroLink's signature): `.btn-liquid` (translucent white glass button with hover light-sweep and press morph — the standard header/chrome button), `.btn-liquid-red` (Agroscope-red glass — reserved for the login Sign In moment, not a general CTA), `.glass-chrome` (translucent sticky-bar surface that blurs content scrolling beneath — pair with `sticky top-0`). `.login-scene` is the soft field-gradient page background behind the login card. Glass is chrome-only: never on data cards, tables, danger actions, or the Balken. All glass classes carry `prefers-reduced-transparency` solid fallbacks automatically.
- Helpers: `.touch-target` (48 px minimum tap area — this UI is used by farmers in the field), `.high-contrast-text`. Typography: `.font-brand` (Noto Sans, bundled) on brand surfaces; system stack elsewhere.
- Dark mode: set `data-theme="dark"` on the `<html>` element; every token flips automatically.

## 3. Brand

- `AGROLINK_BRAND` (bundle export) carries the brand strings and colors: `productName: 'AgroLink'`, `colors.agroscopeRed: '#E30613'`, `colors.agroscopeBlack: '#040404'`.
- `resolveAgroscopeAssets(language)` returns the localized Agroscope logo set (en/de/fr/it).
- `DashboardHeader` renders the complete branded header (Agroscope red Balken strip + blue AgroLink bar) on its own — put it at the top of every screen rather than rebuilding a header.

## 4. Where the truth lives

Read before styling: `styles.css` (imports `_ds_bundle.css` — all component styles plus both token themes). Per component: `components/<group>/<Name>/<Name>.d.ts` is the props contract; `<Name>.prompt.md` shows composition examples with realistic agronomic data (soil tension in kPa, dendrometer µm, battery V/%).
