# OSI GUI design

> OSI's own GUI: a light, high-contrast irrigation dashboard with solid token surfaces, blue actions, a navy header, soil status chips, and large touch targets.

This is OSI's own brand as `web/react-gui` implements it. It is not inspired by another brand. Values were checked against base commit `b3bfc4cee8e8f161948fd1bea876825ac9374e5b`, and the notes on text over `--primary` include the fix committed with this file. Paths below are relative to `web/react-gui` unless they name the repo root. If a value here disagrees with the code, the code wins.

`src/ui-core/tokens.css` defines both themes, and titles the light one "Light, high-contrast theme for field readability". It is byte-mirrored to osi-server, and its header comment sets the edit rule. `src/index.css` overrides the header tokens for the edge.

This file is adapted from the `osi-gui` system kept for the Open Design tool. That copy's contract token names and accent lint do not exist in this repo.

The GUI's stored theme preference defaults to `system` (`src/utils/displayPreferences.ts`), so a device set to dark mode opens dark.

## Color palette

Source: `src/ui-core/tokens.css`. Token names are the GUI's own.

| Token | Light | Dark |
|---|---|---|
| `--bg` | `#F4F6F8` | `#101413` |
| `--surface` | `#E8EDF2` | `#171D1B` |
| `--card` | `#FFFFFF` | `#202623` |
| `--text` | `#0F172A` | `#F4F7F5` |
| `--text-secondary` | `#334155` | `#C3CCC7` |
| `--text-tertiary` | `#576474` | `#91A09A` |
| `--text-disabled` | `#94A3B8` | `#65736D` |
| `--border` | `#CBD5E1` | `#3A4540` |
| `--field-border` | `#78899F` | `#66766F` |
| `--focus` | `#2563EB` | `#2DD4BF` |
| `--primary` | `#2563EB` | `#2DD4BF` |
| `--primary-hover` | `#1D4ED8` | `#14B8A6` |
| `--on-primary` | `#FFFFFF` | `#04100E` |
| `--secondary-bg` | `#E2E8F0` | `#26322E` |
| `--brand-red` | `#E30613` | `#E30613` |
| `--toggle-on` | `#16A34A` | `#22C55E` |
| `--toggle-off` | `#CBD5E1` | `#4B5A54` |
| `--overlay` | `#334155` | `#050807` |

### Surfaces

The GUI layers three grounds, and the order matters:

- `--bg` is the page.
- `--surface` is a zone or device card. It is darker than the page in the light theme.
- `--card` is the white reading tile inside a `--surface` card, or a modal or login panel.

### `--primary` and `--brand-red`

**`--primary` is the action colour.** Blue `#2563EB` in light and teal `#2DD4BF` in dark. It fills primary buttons and the active tab, and colours links, section eyebrows such as "Water balance", and water figures such as rain in mm. `--focus` has the same value in both themes. Text on it uses `--on-primary`: `#FFFFFF` in light, `#04100E` in dark.

**`--brand-red` is `#E30613` in both themes, and the GUI barely uses it.** No `.ts` or `.tsx` file references it. It appears only in `src/ui-core/primitives.css`, as the solid fallback for `.btn-liquid-red` and the active `.glass-tab` ring under `prefers-reduced-transparency`. The same red appears as `rgba(227, 6, 19, …)` in those classes' shadows and ring. The only `liquid-red` button in the GUI is a confirm action in `src/components/journal/desktop/DetailPanel.tsx`.

- Do not use `--brand-red` for errors. Errors use `--error-bg`, `--error-text` and `--danger-fg`.
- Do not use it for primary actions.
- It has no wider brand role (Phil, 2026-11-05), and the logo contains no red.

### Status

Each tone is a wash background, a dark text colour and a saturated border. Source: `src/ui-core/Banner.tsx`, `src/ui-core/Chip.tsx`.

| Token | Light | Dark |
|---|---|---|
| `--success-bg` | `#DCFCE7` | `#123326` |
| `--success-text` | `#14532D` | `#BBF7D0` |
| `--success-border` | `#16A34A` | `#22C55E` |
| `--warn-bg` | `#FEF3C7` | `#3A2B0B` |
| `--warn-text` | `#92400E` | `#FDE68A` |
| `--warn-border` | `#F59E0B` | `#F59E0B` |
| `--info-bg` | `#DBEAFE` | `#172B48` |
| `--info-text` | `#1E3A8A` | `#DBEAFE` |
| `--info-border` | `#3B82F6` | `#60A5FA` |
| `--error-bg` | `#FEE2E2` | `#7F1D1D` |
| `--error-text` | `#7F1D1D` | `#FEE2E2` |
| `--danger-fg` | `#DC2626` | `#F87171` |

Rule from the source comment: the error pair "follows the success/warn convention (wash bg + dark text) so bare text-[var(--error-text)] reads on light surfaces". There is no `--error-border`. Error banners and chips use `--danger-fg` for the border.

### Soil water

| Token | Light | Dark |
|---|---|---|
| `--soil-wet` | `#3B82F6` | `#60A5FA` |
| `--soil-wet-bg` | `#DBEAFE` | `#172B48` |
| `--soil-moist` | `#15803D` | `#4ADE80` |
| `--soil-moist-bg` | `#DCFCE7` | `#173827` |
| `--soil-dry` | `#EF4444` | `#F87171` |
| `--soil-dry-bg` | `#FEE2E2` | `#3B1717` |

Classification in `src/utils/swt.ts`: below 20 kPa is wet, 20 to 50 kPa is moist, above 50 kPa is dry.

Rule from `src/components/farming/shared/SwtStatusIndicator.tsx`: **never rely on hue alone**. The dot's fill is the non-colour cue: full for wet, half for moist, an empty ring for dry. The comment records that moist green and dry red collapse to near-identical olives for a red-green dichromat (CIEDE2000 5.4 light, 6.9 dark), "so the shape, not the hue, separates them".

### History calendar states

Four roles per tone, used by `src/components/history/visualizations/HistoryMonthCalendarView.tsx` and related history views.

Rules from the `tokens.css` comment:

- `bg` is the wash fill and `text` is the foreground.
- `border` is for borders and "NEVER text".
- `solid` is the saturated dot, swatch or ring fill and "NEVER text".
- Light values stay in `oklch()`: "a hex conversion would shift every one of them on a P3 display".
- In dark, `-solid` repeats `-border` on purpose. Consumers pick by role, not by value. The comment records 5.57 to 8.53 contrast against `--card`.

| Token | Light | Dark |
|---|---|---|
| `--cal-warn-bg` | `oklch(98.7% 0.022 95.277)` | `#3A2B0B` |
| `--cal-warn-text` | `oklch(27.9% 0.077 45.635)` | `#FDE68A` |
| `--cal-warn-border` | `oklch(87.9% 0.169 91.605)` | `#F59E0B` |
| `--cal-warn-solid` | `oklch(76.9% 0.188 70.08)` | `#F59E0B` |
| `--cal-good-bg` | `oklch(97.9% 0.021 166.113)` | `#123326` |
| `--cal-good-text` | `oklch(26.2% 0.051 172.552)` | `#BBF7D0` |
| `--cal-good-border` | `oklch(84.5% 0.143 164.978)` | `#22C55E` |
| `--cal-good-solid` | `oklch(69.6% 0.17 162.48)` | `#22C55E` |
| `--cal-cool-bg` | `oklch(97.7% 0.013 236.62)` | `#0C2A3A` |
| `--cal-cool-text` | `oklch(29.3% 0.066 243.157)` | `#BAE6FD` |
| `--cal-cool-border` | `oklch(82.8% 0.111 230.318)` | `#38BDF8` |
| `--cal-cool-solid` | `oklch(68.5% 0.169 237.323)` | `#38BDF8` |
| `--cal-bad-bg` | `oklch(97.1% 0.013 17.38)` | `#3B1717` |
| `--cal-bad-text` | `oklch(25.8% 0.092 26.042)` | `#FECACA` |
| `--cal-bad-border` | `oklch(80.8% 0.114 19.571)` | `#F87171` |
| `--cal-bad-solid` | `oklch(63.7% 0.237 25.331)` | `#F87171` |
| `--cal-alert-bg` | `oklch(98% 0.016 73.684)` | `#3A1F07` |
| `--cal-alert-text` | `oklch(26.6% 0.079 36.259)` | `#FED7AA` |
| `--cal-alert-border` | `oklch(83.7% 0.128 66.29)` | `#FB923C` |
| `--cal-alert-solid` | `oklch(70.5% 0.213 47.604)` | `#FB923C` |
| `--cal-humid-bg` | `oklch(98.4% 0.019 200.873)` | `#0B2E33` |
| `--cal-humid-text` | `oklch(30.2% 0.056 229.695)` | `#A5F3FC` |
| `--cal-humid-border` | `oklch(86.5% 0.127 207.078)` | `#22D3EE` |
| `--cal-humid-solid` | `oklch(71.5% 0.143 215.221)` | `#22D3EE` |
| `--cal-water-bg` | `oklch(97% 0.014 254.604)` | `#172B48` |
| `--cal-water-text` | `oklch(28.2% 0.091 267.935)` | `#BFDBFE` |
| `--cal-water-border` | `oklch(80.9% 0.105 251.813)` | `#60A5FA` |
| `--cal-water-solid` | `oklch(62.3% 0.214 259.815)` | `#60A5FA` |
| `--cal-mixed-bg` | `oklch(97.7% 0.014 308.299)` | `#2E1B47` |
| `--cal-mixed-text` | `oklch(29.1% 0.149 302.717)` | `#E9D5FF` |
| `--cal-mixed-border` | `oklch(82.7% 0.119 306.383)` | `#C084FC` |
| `--cal-mixed-solid` | `oklch(62.7% 0.265 303.9)` | `#C084FC` |
| `--cal-violet-bg` | `oklch(96.9% 0.016 293.756)` | `#251C46` |
| `--cal-violet-text` | `oklch(28.3% 0.141 291.089)` | `#DDD6FE` |
| `--cal-violet-border` | `oklch(81.1% 0.111 293.571)` | `#A78BFA` |
| `--cal-violet-solid` | `oklch(60.6% 0.25 292.717)` | `#A78BFA` |

### Glass

Comment in `src/ui-core/primitives.css`: "Glass is chrome-only: primary/danger semantics and data surfaces stay solid."

| Token | Light | Dark |
|---|---|---|
| `--glass-hi` | `rgba(255, 255, 255, 0.60)` | `rgba(70, 82, 77, 0.55)` |
| `--glass-lo` | `rgba(255, 255, 255, 0.20)` | `rgba(38, 46, 43, 0.25)` |
| `--glass-mid` | `rgba(255, 255, 255, 0.40)` | `rgba(52, 62, 58, 0.40)` |
| `--glass-edge` | `rgba(255, 255, 255, 0.80)` | `rgba(255, 255, 255, 0.16)` |
| `--glass-edge-dim` | `rgba(4, 4, 4, 0.10)` | `rgba(0, 0, 0, 0.35)` |
| `--glass-spec` | `rgba(255, 255, 255, 0.90)` | `rgba(255, 255, 255, 0.22)` |
| `--glass-sweep` | `rgba(255, 255, 255, 0.75)` | `rgba(255, 255, 255, 0.20)` |
| `--chrome-hi` | `rgba(255, 255, 255, 0.66)` | `rgba(23, 29, 27, 0.72)` |
| `--chrome-lo` | `rgba(255, 255, 255, 0.46)` | `rgba(23, 29, 27, 0.52)` |

### Contrast, computed for this document

These WCAG 2 ratios were computed from the hex values for this document. The source does not publish them.

| Pair | Ratio |
|---|---|
| `--text` on `--bg` (light) | 16.48 |
| `--text-secondary` on `--surface` (light) | 8.79 |
| `--text-tertiary` on `--card` (light) | 6.03 |
| `--text-tertiary` on `--surface` (light) | 5.12 |
| `--text-disabled` on `--card` (light) | 2.56 |
| `--on-primary` on `--primary` (light) | 5.17 |
| `--primary` on `--surface` (light) | 4.39 |
| `--header-text` on `--header-bg`, `src/index.css` values (light) | 10.36 |
| `--success-text` on `--success-bg` (light) | 8.30 |
| `--warn-text` on `--warn-bg` (light) | 6.37 |
| `--info-text` on `--info-bg` (light) | 8.49 |
| `--error-text` on `--error-bg` (light) | 8.20 |
| `--soil-wet` on `--card` (light) | 3.68 |
| `--soil-moist` on `--card` (light) | 5.02 |
| `--soil-dry` on `--card` (light) | 3.76 |
| `--on-primary` on `--primary` (dark) | 10.39 |
| `#FFFFFF` on `--primary` (dark) | 1.86 |

Use `--on-primary` on `--primary`, because plain white fails in dark. `--soil-wet` and `--soil-dry` are below 4.5 on `--card`. `SwtStatusIndicator` uses them for the chip border and dot while the chip text stays `--text`. `--primary` on `--surface` is 4.39: the GUI uses it for `text-2xl` water figures, and also for the small `text-xs` "Local only" chip. Its eyebrow sits on `--card`, at 5.17. For new work, put small `--primary` text on `--card`, not `--surface`.

## Typography

**The GUI loads no web font.** There is no `@font-face` or font import in `src` or `index.html`, and no font package in `package.json`. The stack in `src/index.css` is:

```css
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', 'Fira Sans', 'Droid Sans', 'Helvetica Neue', sans-serif;
```

The typeface therefore differs by device. Display and body use the same stack, and the font smoothing is set beside it in `src/index.css`. Monospace is Tailwind's default `font-mono` (21 uses), including device IDs.

Sizes are Tailwind 4.1.18 defaults with no custom scale:

| Utility | Size / line height | Where the GUI uses it |
|---|---|---|
| `text-xs` | 12 / 16px | Chips, tile labels, footers (645 uses) |
| `text-sm` | 14 / 20px | Most body and button text (795 uses) |
| `text-base` | 16 / 24px | Body default, login subtitle |
| `text-lg` | 18 / 28px | Form labels and inputs, header buttons, welcome line |
| `text-xl` | 20 / 28px | Reading values on phones, login submit button |
| `text-2xl` | 24 / 32px | Reading values from 640px, water tile figures, section headings |
| `text-3xl` | 30 / 36px | Zone title, modal title, login title, header title on phones |
| `text-4xl` | 36 / 40px | Dashboard header title |

- **Weights:** `font-semibold` (600, 653 uses) and `font-bold` (700, 425 uses) dominate. Medium, normal and light are rare. Headings and buttons are bold, and labels are semibold.
- **Tile labels:** `text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]`.
- **Section eyebrow:** `text-xs font-bold uppercase tracking-[0.18em] text-[var(--primary)]`.
- **Numbers:** readings use `tabular-nums` (71 uses).
- **Page and card titles:** `.high-contrast-text` adds `text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5)`. `src/index.css` files it under "High contrast styles for accessibility (farmers in developing countries)". It is used on `h1` and `h2` titles only.

## Voice and tone

Source: `public/locales/en/*.json`. The GUI ships en, de-CH, es, fr, it, lg and pt.

- Short, plain labels in sentence case: "Add", "Data", "Account", "Logout".
- Direct instructions in full sentences, naming the real next step: "Take it outdoors with a clear view of the sky and wait until it shows satellites."
- Plain states: "Wet", "Moist", "Dry", "Local only", "Last seen 5 min ago", "Not enough data to advise".
- Honest about uncertainty and failure: "Failed to load data", "Waiting for more data".
- Uppercase comes from CSS on tile labels, not from the copy.

A comment in `src/components/farming/valves/valveState.ts` warns against false alarms, "exactly the kind of false alarm that teaches a farmer to ignore real ones". Reserve alarm treatment for real faults.

## Logo

The repo contains **one logo file and one favicon**, and no other variants:

| File | Size | Format | Used at |
|---|---|---|---|
| `src/assets/osi_logo.png` | 430×404 | PNG, transparent background | `src/pages/Login.tsx` only, `h-14 w-14` (56px), centred above the login title, alt text "OSI OS Logo" |
| `public/favicon.png` | 64×64 | PNG | Browser tab icon, `index.html` |

The artwork is a green globe in a ring, with a blue water drop at lower right. The GUI's headers and `Register.tsx` show no logo.

The logo's sampled colours, about `#84A366` green and `#369BCA` blue, are **not tokens** and appear nowhere in the CSS. Do not use them as UI colours.

Not specified in the GUI: dark-background or single-colour logo variants, a wordmark, an SVG, clear space, minimum size, and logo licence terms separate from the repo's MIT `LICENSE`.

The product name appears as "Open Smart Irrigation" (`index.html` title), "Open Smart Irrigation Dashboard" (dashboard title) and "OSI OS v0.8.1 (Alpha)" (login heading).

## Imagery and iconography

There is no photography or illustration in the GUI, and no icon library in `package.json`. Icons are:

- **Valve glyph:** custom SVG, `src/components/farming/valves/ValveGlyph.tsx`. States are closed, pending, open, closing and failed. The body uses `--text-tertiary` closed and `--primary` open. Water is `#38BDF8` with edge `#0EA5E9` in light, and `#22D3EE` with edge `#0E7490` in dark. Pending badge is `#b45309` light, `#fbbf24` dark. Failed badge is `#dc2626` light, `#f87171` dark. Water animates only for a confirmed running valve. The CSS credits Material Symbols Rounded `valve` (Apache-2.0); the notice is in `docs/THIRD_PARTY_NOTICES.md` at the repo root.
- **Weather icons:** animated SVG, `src/components/farming/environment/WeatherIcon.tsx` and `weatherIconStyles.css`.
- **Text glyphs and emoji:** `⚙` for settings, `🌱` for crop chips, and small inline SVGs such as the rename pencil.

Valve and glass motion stops under `prefers-reduced-motion`. `weatherIconStyles.css` has no such rule. Solid fallbacks replace glass under `prefers-reduced-transparency`.

## Layout and spacing

Spacing is Tailwind's 4px base with no custom scale. The most used steps are 8px (`py-2`, `gap-2`), 12px (`px-3`, `gap-3`, `p-3`) and 16px (`px-4`, `p-4`).

- **Page:** `max-w-7xl mx-auto px-4 py-8` (1280px container, 16px gutter, 32px vertical). Section spacing is `mb-8`.
- **Breakpoints:** Tailwind defaults, with 640px (`sm`) the main switch. Tiles use one column below 640px.
- **Mobile first:** header buttons go to two columns on phones (`w-[calc(50%-4px)] sm:w-auto`). Long names wrap, and overflow is checked at 320 and 390px (`design-preview/README.md`).

| Radius | Value | Used on |
|---|---|---|
| `rounded-md` | 6px | Tabs, small controls |
| `rounded-lg` | 8px | Buttons, inputs, reading tiles (the most used, 541 uses) |
| `rounded-xl` | 12px | Zone cards, device cards, water tiles |
| `rounded-2xl` | 16px | `Surface`, modals, login panel, water card |
| `rounded-full` | full | Chips, status dots |

| Shadow | Value | Used on |
|---|---|---|
| `shadow-sm` | `0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)` | Surfaces, tiles |
| `shadow-lg` | `0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)` | Zone cards, header buttons |
| `shadow-xl` | `0 20px 25px -5px rgb(0 0 0 / 0.1), 0 8px 10px -6px rgb(0 0 0 / 0.1)` | Header, popovers |
| `shadow-2xl` | `0 25px 50px -12px rgb(0 0 0 / 0.25)` | Modals, login panel |

### Field use

The GUI's stated audience is farmers working outdoors: `FARMING_MODULE_GUIDE.md` lists "high contrast, large touch targets" and "Mobile-first responsive design".

- **Touch targets:** `.touch-target` is `min-height: 48px; min-width: 48px`. `Button` always applies it, and README checks expect 48px header controls.
- **Other targets:** 44px is the floor elsewhere: `.glass-tab` on coarse pointers, `min-h-[44px]`, `h-11`.
- **Reading tiles:** white on a grey card, with a large bold number.
- **Status:** colour plus a shape or a word.

## Components

Classes from the source, with layout-only utilities left out in places. The rendered values were measured in `design-preview`.

**Header** (`src/components/AppHeader.tsx`, `DashboardHeader.tsx`): `bg-[var(--header-bg)] shadow-xl`, navy `#1E3A8A` in light as rendered. Inner `max-w-7xl mx-auto px-4`. Title `font-bold` in `--header-text`, `text-4xl` in `DashboardHeader` and `text-3xl sm:text-4xl` in `AppHeader`, with `.high-contrast-text`. Welcome line `text-lg` in `--header-subtext`. Controls are `rounded-lg px-6 py-3 text-lg font-bold shadow-lg`. There is no logo and it is not sticky.

**Tab bar** (`AppHeader`): `inline-flex gap-1 rounded-lg bg-[var(--secondary-bg)] p-1`. Tab `rounded-md px-5 py-2 text-[15px] font-semibold`. Active is `bg-[var(--primary)] text-[var(--on-primary)] shadow`, inactive is `text-[var(--text-tertiary)]`.

**Buttons** (`src/ui-core/Button.tsx`): always `.touch-target`, `rounded-lg font-bold`.

- Primary: `--primary` fill, `--primary-hover` on hover, `--on-primary` text. Disabled uses `--border` fill and `--text-disabled` text.
- Secondary: `--secondary-bg` fill, `--border` on hover, `--text` text.
- `liquid` and `liquid-red`: glass, see `src/ui-core/primitives.css`.
- Destructive in cards: `--error-bg` fill with `--error-text`, with `.touch-target`.

**Zone card** (`src/components/farming/IrrigationZoneCard.tsx`): `bg-[var(--surface)] border-2 border-[var(--border)] rounded-xl p-6 shadow-lg mb-6`. Measured: 2px `#CBD5E1` border, 12px radius, 24px padding.

**Water card** (same file): `rounded-2xl border border-[var(--border)] bg-[var(--card)] p-4`, holding tiles of `rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 shadow-sm`. Figures are `text-2xl font-bold`, in `--primary` for water and `--success-text` for a measured flow.

**Device card** (`KiwiSensorCard.tsx`): `rounded-xl p-4 border shadow-sm bg-[var(--surface)] border-[var(--border)] hover:border-[var(--focus)]`.

**Reading tile** (`shared/SoilTensionReadings.tsx`): `rounded-lg bg-[var(--card)] p-3`, uppercase label, then value `text-xl sm:text-2xl font-bold tabular-nums`. A value that opens history has `underline decoration-dotted underline-offset-4`, and a 44px target.

**Status chip** (`shared/SwtStatusIndicator.tsx`): `inline-flex min-h-7 items-center gap-1.5 rounded-full border px-2 py-1 text-xs font-semibold text-[var(--text)]`. Border is the soil colour, background is the soil wash, and the 12px dot `border-2` carries the fill cue.

**Chip** (`src/ui-core/Chip.tsx`): `rounded-full border px-2 py-0.5 text-xs font-semibold`. Tones are neutral, success, warn, error and info.

**Banner** (`src/ui-core/Banner.tsx`): full width, `border-b px-4 py-3 text-center text-sm font-semibold`. Error uses `role="alert"`, the others `role="status"`.

**Form field** (`src/ui-core/FormField.tsx`): label `block text-lg font-semibold mb-2`. Input `w-full px-4 py-4 touch-target bg-[var(--card)] border-2 border-[var(--field-border)] rounded-lg text-lg`. Focus is `focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]`. Hint `mt-1 text-sm text-[var(--text-tertiary)]`.

**Modal** (`src/ui-core/Modal.tsx`): backdrop `color-mix(in srgb, var(--overlay) 70%, transparent)`. Panel `bg-[var(--card)] rounded-2xl shadow-2xl border-2 border-[var(--border)] max-w-lg p-8`. Title `text-3xl font-bold`.

**Table** (`src/ui-core/TableShell.tsx`): `rounded-2xl border bg-[var(--surface)] shadow-sm`. Head `border-b text-sm text-[var(--text-secondary)]`, cells `p-4`.

**Empty state** (`src/ui-core/EmptyState.tsx`): `text-center py-12 bg-[var(--surface)] rounded-xl border-2`. Title `text-2xl font-bold`.

**Toggle and live dot:** `--toggle-on` and `--toggle-off`. `StregaValveCard.tsx` pulses the open dot with `animate-pulse`.

### Charts

Three chart libraries are in use, with no single chart token set:

- **ECharts** for the desktop analysis workspace (`src/analysis/echartsOptions.ts`). The series palette, in order, from `src/analysis/seriesColors.ts`: `#0072B2`, `#E69F00`, `#009E73`, `#CC79A7`, `#56B4E9`, `#D55E00`, `#117733`, `#882255`.
- **Recharts** for the zone water chart (`src/components/farming/environment/WaterTab.tsx`). Rain is `#38bdf8`, measured irrigation `#14b8a6`, estimated irrigation `#22c55e`. Grid is `strokeDasharray="3 3"` in `var(--border)`, axis ticks are 11px in `var(--text-tertiary)`, bars have a 6px top radius, and the today line is dashed `var(--text-tertiary)`.
- **uPlot** for mobile history, through `@osi/history-uplot` (`../history-uplot-core`). Its styling is not documented here.

### Dark theme

Set by `html[data-theme='dark']`, with `color-scheme: dark`. Light sets `color-scheme: light`.

Grounds are near-black green (`#101413`, `#171D1B`, `#202623`). Action colour changes from blue to teal `#2DD4BF`, with dark `--on-primary` `#04100E`. All values are in the tables above.

The rendered dark header comes from `src/index.css`: `--header-bg` `#0B302C`, `--header-text` `#F8FFFC`, `--header-subtext` `#B7E4DA`. See the header conflict below.

## Source conflicts

These are recorded, not resolved, except where stated.

1. **Header tokens.** `src/ui-core/tokens.css`, the canonical file, sets the values in the table below. `src/index.css` overrides them for the edge GUI, with the comment "this branch's header keeps its own blue brand identity". The render confirms the override (`--header-bg` computes to `#1E3A8A`). Resolved (Phil, 2026-11-05): the navy header is the brand, so the edge's `--header-*` values are the ones in `src/index.css`.

| Token | Light | Dark |
|---|---|---|
| `--header-bg` | `#FFFFFF` | `#171D1B` |
| `--header-text` | `#040404` | `#F4F7F5` |
| `--header-subtext` | `#475569` | `#C3CCC7` |

2. **Header style.** The `src/index.css` comment calls ui-core's header "canonical white/glass", and `.glass-chrome`, `.glass-tabs` and `.glass-tab` exist in `src/ui-core/primitives.css`. No edge component outside `ui-core` uses those classes: the edge header and tab bar are solid.
3. **`text-white` against `--on-primary`.** Resolved by the fix committed with this file. White on dark `--primary` is 1.86:1. Of the 106 source lines that set `bg-[var(--primary)]`, 100 now use `--on-primary` and none use `text-white`. The other 6 are two `/10` washes, three fills with no text, and the journal cluster style, which sets `--on-primary` on another line. `tests/primaryTextContrast.test.ts` fails on any class string that pairs a `--primary` fill with `text-white`.
4. **Dry soil colour.** `SwtStatusIndicator` shows dry in red `--soil-dry`, and `HistoryMonthCalendarView` shows `dry_stress` in amber `--cal-warn-*`.
5. **Input border.** `FormField` and its comment use `--field-border` with `py-4`. `Login.tsx` uses `--border` with `py-3`.
6. **Touch target minimum.** `.touch-target` and `FARMING_MODULE_GUIDE.md` say 48px. `.glass-tab` and many controls use 44px.
7. **Stale valve comment.** `valveGlyphStyles.css` says dark `--primary` "resolves to #4FAEE3" and that tokens live in `index.css`. `tokens.css` has dark `--primary` `#2DD4BF`.
8. **Stale guide.** `FARMING_MODULE_GUIDE.md` describes "Dark background (slate-900/slate-800)" and "White text". Tokens and render are light-first with dark text.
9. **`src/App.css` is not imported.** `src/main.jsx` imports only `src/index.css`, and nothing imports `App.css`. Its 8/12px radii and `.metric-card` patterns do not reach the rendered GUI, so no values here come from it.
10. **Hard-coded colours outside tokens.** Tailwind palette classes appear in components, such as `bg-slate-900` on the Account button, `bg-emerald-700` on Data, `bg-sky-700` on Network, and `bg-blue-50 text-blue-800` on the Soil tension chip. That chip stays light in dark mode. `src/analysis/echartsOptions.ts` hard-codes `#475569`, `#6e7079` and `#464646`, which are not theme-aware.
11. **Preset coverage.** `src/ui-core/tailwind-preset.js` does not expose `--on-primary`, `--field-border`, `--info-*`, `--cal-*`, `--glass-*` or `--chrome-*`. The GUI reaches them with `var()`. The preset's `farm-*` colours are unused in `.tsx` files.

## Not specified in the GUI

- A brand typeface. None is named anywhere. Nothing is self-hosted, so no font licence question arises.
- A custom type scale, spacing scale, breakpoints or letter-spacing for headings. These are Tailwind defaults.
- An active (pressed) colour for `--primary`. Only the glass buttons define a press, `scale(0.965)`.
- A semantic chart token set, a dark-specific chart palette, or an icon library.
- Logo variants and logo rules (see Logo).
- Photography or illustration direction.
- A stated WCAG target. Contrast rules exist only in the comments quoted above.

## Agent prompt guide

Build like the OSI field dashboard. Use `--bg` for the page, `--surface` with a border for cards, and `--card` for white reading tiles. Give primary actions `--primary` with `--on-primary` text, and never use `--brand-red` for actions or errors. Use the system font stack and do not load a web font. Make numbers large, bold and `tabular-nums`, with small uppercase `--text-tertiary` labels above them. Show soil state with the chip pattern, using the dot fill (full, half, empty) and a word, never colour alone. Status tones are wash, dark text and saturated border. Keep controls at 48px where touch matters, 8px radius on buttons and inputs, 12 to 16px on cards. Glass is for navigation chrome only, never for data. Keep data surfaces solid, and add no decorative imagery. Use `src/assets/osi_logo.png` as it is, at 56px on a light panel as on the login page, and do not recolour or redraw it. Do not take colours from the logo.
