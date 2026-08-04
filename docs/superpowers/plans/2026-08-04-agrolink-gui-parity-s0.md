# AgroLink GUI Parity — Slice S0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the shared `ui-core` design core (tokens, Tailwind preset, eight primitives) from the edge GUI, vendor it byte-identically to osi-server with CI gates, and give the cloud a `GatewayProvider` with a Settings-page gateway switcher.

**Architecture:** `ui-core` lives canonically at `web/react-gui/src/ui-core/` (osi-os) and is byte-mirrored to `frontend/src/ui-core/` (osi-server), governed exactly like the sync-contract vendor check. The edge adopts it through CSS import-path moves only (no edge TSX changes), so the edge production bundle stays byte-identical apart from hashed names and the one deliberate `--error-*` token fix. The cloud gains `GatewayProvider` (modeled on the edge `ScopeContext` fail-closed pattern) over `GET /api/v1/users/me/linked-gateways`, plus an "Active gateway" Settings section that renders only for multi-gateway accounts.

**Tech Stack:** React 18, TypeScript, Tailwind v4 (edge, CSS-first via `@tailwindcss/postcss`) / Tailwind v3.4 (cloud, `presets` array), Vite 5, Vitest + `tsx --test` runners in both repos, POSIX `sh` verifier scripts, GitHub Actions.

**Working directories (both checkouts are on branch `AgroLink`):**
- Edge (canonical): `/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep` — GUI at `web/react-gui/`
- Cloud (vendored): `/home/phil/Repos/osi-server/.worktrees/agrolink` — GUI at `frontend/`
- Never touch `/home/phil/Repos/osi-server/.worktrees/terra-rehaul-*` or `/home/phil/Repos/osi-os/.worktrees/firmware-image-builder`.

## Global Constraints

Copied from `docs/superpowers/specs/2026-08-04-agrolink-gui-parity-design.md`; every task's requirements implicitly include these.

- "`ui-core` canonical in osi-os, byte-mirrored to osi-server, CI-gated both sides" (D2).
- "Eight primitives, no more: glass surface/card, button, chip/badge, modal, banner, form field, table shell, empty state."
- "A primitive is admitted to `ui-core` only when both GUIs use it; single-sided components stay local."
- "one linked gateway means no selector anywhere; multiple linked gateways are switched on the Settings page" (D3).
- "Gate: the edge production bundle before and after adoption differs only in hashed asset names (verified by building both and diffing rendered CSS/JS content), and the full edge GUI suite (94 node tests + 1,671 Vitest at the time of writing) stays green."
- "The cloud login screen keeps its current design (Swiss-cross badge, commit `5280da76`) and is excluded from visual parity" (D6).
- "This program works on the `AgroLink` branches only and does not modify Terra files; if a slice needs a file Terra also touches, the slice waits."
- "all GUI-parity work lands on the same pair of `AgroLink` branches, keeping the deploy-from-branch model intact".

Two plan-level readings of the spec, applied throughout:

- S0 changes no edge `.tsx` file, so JS bundle parity is byte-level (after hash normalization). The only tolerated CSS difference is the light-theme `--error-bg`/`--error-text` fix, allowlisted in the gate script. The edge consumes the glass primitives today through their CSS classes (`btn-liquid` in `Login.tsx`/`AppHeader.tsx`, `glass-chrome`/`glass-tabs` in `AppHeader.tsx`); the TSX wrappers get their first page consumers in S1.
- "localStorage keyed by user uuid": cloud accounts expose no uuid (`UserProfile` has `id: number`), so the storage key is `agrolink.active-gateway.v1.<UserProfile.id>`.

## File map

| File | Repo | Task |
|---|---|---|
| `web/react-gui/src/ui-core/tokens.css` | osi-os | T1 |
| `web/react-gui/src/ui-core/tailwind-preset.js` | osi-os | T2 |
| `web/react-gui/src/ui-core/primitives.css`, `Surface.tsx`, `Button.tsx`, `Chip.tsx` | osi-os | T3 |
| `web/react-gui/src/ui-core/Modal.tsx`, `Banner.tsx`, `FormField.tsx` | osi-os | T4 |
| `web/react-gui/src/ui-core/TableShell.tsx`, `EmptyState.tsx`, `index.ts` | osi-os | T5 |
| `web/react-gui/scripts/verify-bundle-parity.sh`, `css-rule-diff*.mjs`; `src/index.css` rewrite | osi-os | T6 |
| `frontend/src/ui-core/**` (copy), `scripts/verify-ui-core-vendor.*` (both repos), CI wiring, branding-test extension | both | T7 |
| `frontend/src/contexts/GatewayContext.tsx`, `src/App.tsx` | osi-server | T8 |
| `frontend/src/pages/SettingsPage.tsx`, 7× `public/locales/*/settings.json` | osi-server | T9 |
| `frontend/src/index.css`, `frontend/tailwind.config.js` | osi-server | T10 |
| `docs/superpowers/plans/agrolink-gui-parity-matrix.md` | osi-os | T11 |

---

### Task 1: `ui-core/tokens.css` — merged token sheet with the error-pair fix

The edge `src/index.css` sheet (43 custom properties per theme) is a superset of the cloud sheet; the merge is the edge sheet verbatim with one fix. Today's light theme has `--error-bg: #DC2626` / `--error-text: #FFFFFF`, so the ~30-file bare `text-[var(--error-text)]` usage renders white-on-white. The fix follows the sheet's own success/warn convention (light wash background + dark 900-level text): `--error-bg: #FEE2E2` (already in the sheet as `--soil-dry-bg`) and `--error-text: #7F1D1D` (already in the sheet as the dark-theme `--error-bg`). Filled `bg-[var(--error-bg)] text-[var(--error-text)]` sites change from red/white to wash/dark-red, contrast-safe in both directions. The dark theme pair (`#7F1D1D`/`#FEE2E2`) already contrasts and stays unchanged.

**Files:**
- Create: `web/react-gui/src/ui-core/tokens.css`
- Test: `web/react-gui/tests/uiCoreTokens.test.ts`

**Interfaces:**
- Consumes: nothing (file is not imported until T6).
- Produces: `src/ui-core/tokens.css` defining `:root` and `html[data-theme='dark']` blocks: the exact variable set later tasks reference via `var(--…)` and T2 maps into the preset.

- [ ] **Step 1: Write the failing test**

Create `web/react-gui/tests/uiCoreTokens.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const tokensPath = path.resolve(import.meta.dirname, '../src/ui-core/tokens.css');

test('tokens.css carries exactly the :root and dark-theme blocks', () => {
  const css = fs.readFileSync(tokensPath, 'utf8');
  assert.equal((css.match(/\{/g) ?? []).length, 2, 'only :root and html[data-theme=dark] blocks');
  assert.match(css, /^:root \{/m);
  assert.match(css, /^html\[data-theme='dark'\] \{/m);
});

test('light theme fixes the error pair to wash background + dark text', () => {
  const css = fs.readFileSync(tokensPath, 'utf8');
  const light = css.slice(0, css.indexOf("html[data-theme='dark']"));
  assert.match(light, /--error-bg: #FEE2E2;/);
  assert.match(light, /--error-text: #7F1D1D;/);
  assert.doesNotMatch(light, /--error-text: #FFFFFF;/);
});

test('dark theme error pair is unchanged', () => {
  const css = fs.readFileSync(tokensPath, 'utf8');
  const dark = css.slice(css.indexOf("html[data-theme='dark']"));
  assert.match(dark, /--error-bg: #7F1D1D;/);
  assert.match(dark, /--error-text: #FEE2E2;/);
});

test('every cloud-sheet variable and the glass set exist in tokens.css', () => {
  const css = fs.readFileSync(tokensPath, 'utf8');
  const cloudNames = [
    '--bg', '--surface', '--card', '--text', '--text-secondary', '--text-tertiary',
    '--text-disabled', '--border', '--focus', '--primary', '--primary-hover',
    '--secondary-bg', '--header-bg', '--header-text', '--header-subtext',
    '--success-bg', '--success-text', '--success-border', '--warn-bg', '--warn-text',
    '--warn-border', '--error-bg', '--error-text', '--toggle-on', '--toggle-off', '--overlay',
  ];
  for (const name of cloudNames) assert.match(css, new RegExp(`${name}: #`), name);
  const glassNames = [
    '--glass-hi', '--glass-lo', '--glass-mid', '--glass-edge', '--glass-edge-dim',
    '--glass-spec', '--glass-sweep', '--chrome-hi', '--chrome-lo', '--brand-red',
  ];
  for (const name of glassNames) assert.match(css, new RegExp(`${name}:`), name);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npx tsx --test tests/uiCoreTokens.test.ts
```

Expected: FAIL — `ENOENT … src/ui-core/tokens.css`.

- [ ] **Step 3: Create `web/react-gui/src/ui-core/tokens.css`**

Content is the edge `src/index.css` `:root` + dark blocks (current lines 3–95) with the two light-theme error values changed and a comment recording why; every other declaration is byte-identical to the source. Full file:

```css
/* ui-core design tokens — canonical in osi-os (web/react-gui/src/ui-core),
   byte-mirrored to osi-server (frontend/src/ui-core). Edit ONLY on the
   osi-os AgroLink branch, then re-vendor; verify-ui-core-vendor gates CI. */

/* Light, high-contrast theme for field readability */
:root {
  --bg: #F4F6F8;
  --surface: #E8EDF2;
  --card: #FFFFFF;
  --text: #0F172A;
  --text-secondary: #334155;
  --text-tertiary: #64748B;
  --text-disabled: #94A3B8;
  --border: #CBD5E1;
  --focus: #2563EB;
  --primary: #2563EB;
  --primary-hover: #1D4ED8;
  --secondary-bg: #E2E8F0;
  --header-bg: #FFFFFF;
  --header-text: #040404;
  --header-subtext: #475569;
  --brand-red: #E30613;
  /* liquid-glass material (AgroLink iOS-26-style chrome) */
  --glass-hi: rgba(255, 255, 255, 0.60);
  --glass-lo: rgba(255, 255, 255, 0.20);
  --glass-mid: rgba(255, 255, 255, 0.40);
  --glass-edge: rgba(255, 255, 255, 0.80);
  --glass-edge-dim: rgba(4, 4, 4, 0.10);
  --glass-spec: rgba(255, 255, 255, 0.90);
  --glass-sweep: rgba(255, 255, 255, 0.75);
  --chrome-hi: rgba(255, 255, 255, 0.66);
  --chrome-lo: rgba(255, 255, 255, 0.46);
  --success-bg: #DCFCE7;
  --success-text: #14532D;
  --success-border: #16A34A;
  --warn-bg: #FEF3C7;
  --warn-text: #92400E;
  --warn-border: #F59E0B;
  /* error pair follows the success/warn convention (wash bg + dark text) so
     bare text-[var(--error-text)] reads on light surfaces; the old
     #DC2626/#FFFFFF pair rendered white-on-white in ~30 files. */
  --error-bg: #FEE2E2;
  --error-text: #7F1D1D;
  --danger-fg: #DC2626;
  --soil-wet: #3B82F6;
  --soil-wet-bg: #DBEAFE;
  --soil-moist: #22C55E;
  --soil-moist-bg: #DCFCE7;
  --soil-dry: #EF4444;
  --soil-dry-bg: #FEE2E2;
  --toggle-on: #16A34A;
  --toggle-off: #CBD5E1;
  --overlay: #334155;
}

html[data-theme='dark'] {
  --bg: #101413;
  --surface: #171D1B;
  --card: #202623;
  --text: #F4F7F5;
  --text-secondary: #C3CCC7;
  --text-tertiary: #91A09A;
  --text-disabled: #65736D;
  --border: #3A4540;
  --focus: #2DD4BF;
  --primary: #2DD4BF;
  --primary-hover: #14B8A6;
  --secondary-bg: #26322E;
  --header-bg: #171D1B;
  --header-text: #F4F7F5;
  --header-subtext: #C3CCC7;
  --brand-red: #E30613;
  --glass-hi: rgba(70, 82, 77, 0.55);
  --glass-lo: rgba(38, 46, 43, 0.25);
  --glass-mid: rgba(52, 62, 58, 0.40);
  --glass-edge: rgba(255, 255, 255, 0.16);
  --glass-edge-dim: rgba(0, 0, 0, 0.35);
  --glass-spec: rgba(255, 255, 255, 0.22);
  --glass-sweep: rgba(255, 255, 255, 0.20);
  --chrome-hi: rgba(23, 29, 27, 0.72);
  --chrome-lo: rgba(23, 29, 27, 0.52);
  --success-bg: #123326;
  --success-text: #BBF7D0;
  --success-border: #22C55E;
  --warn-bg: #3A2B0B;
  --warn-text: #FDE68A;
  --warn-border: #F59E0B;
  --error-bg: #7F1D1D;
  --error-text: #FEE2E2;
  --danger-fg: #F87171;
  --soil-wet: #60A5FA;
  --soil-wet-bg: #172B48;
  --soil-moist: #4ADE80;
  --soil-moist-bg: #173827;
  --soil-dry: #F87171;
  --soil-dry-bg: #3B1717;
  --toggle-on: #22C55E;
  --toggle-off: #4B5A54;
  --overlay: #050807;
}
```

Do not add the undefined `--danger-bg`/`--danger-text`/`--danger-border` names some components (`ScopeStatusBanner.tsx`) reference; that repair is out of S0 scope because it would widen the T6 CSS allowlist.

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx tsx --test tests/uiCoreTokens.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add web/react-gui/src/ui-core/tokens.css web/react-gui/tests/uiCoreTokens.test.ts
git commit -m "feat: extract ui-core design tokens (tokens.css)"
```

(T6 derives the bundle-parity baseline from this exact commit subject; do not reword it.)

---

### Task 2: `ui-core/tailwind-preset.js` + edge config wiring

The edge runs Tailwind v4 CSS-first: its `tailwind.config.js` is currently inert (no `@config` directive anywhere). The `farm-*` colors it declares are used by zero source files (verified by grep in both repos), so activating the config via `@config` adds no utilities and the T6 gate verifies zero CSS drift.

**Files:**
- Create: `web/react-gui/src/ui-core/tailwind-preset.js`
- Modify: `web/react-gui/tailwind.config.js` (whole file), `web/react-gui/src/index.css` (add one `@config` line after the tailwind import)
- Test: `web/react-gui/tests/uiCoreTailwindPreset.test.ts`

**Interfaces:**
- Consumes: token names from T1 `tokens.css`.
- Produces: default-exported preset object with `theme.extend.colors`; both repos' `tailwind.config.js` reference it as `presets: [uiCorePreset]` (cloud side wired in T10).

- [ ] **Step 1: Write the failing test**

Create `web/react-gui/tests/uiCoreTailwindPreset.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const guiRoot = path.resolve(import.meta.dirname, '..');

test('tailwind-preset maps the farm palette and ui-core tokens', async () => {
  const preset = (await import('../src/ui-core/tailwind-preset.js')).default;
  const colors = preset.theme.extend.colors;
  assert.equal(colors['farm-green'], '#22c55e');
  assert.equal(colors.card, 'var(--card)');
  assert.equal(colors['error-text'], 'var(--error-text)');
  assert.equal(colors['brand-red'], 'var(--brand-red)');
});

test('edge tailwind.config extends the ui-core preset', () => {
  const config = fs.readFileSync(path.join(guiRoot, 'tailwind.config.js'), 'utf8');
  assert.match(config, /from '\.\/src\/ui-core\/tailwind-preset\.js'/);
  assert.match(config, /presets:\s*\[uiCorePreset\]/);
  assert.doesNotMatch(config, /'farm-green'/);
});

test('index.css loads the config so the preset is active under Tailwind v4', () => {
  const css = fs.readFileSync(path.join(guiRoot, 'src/index.css'), 'utf8');
  assert.match(css, /@config "\.\.\/tailwind\.config\.js";/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npx tsx --test tests/uiCoreTailwindPreset.test.ts
```

Expected: FAIL — cannot resolve `../src/ui-core/tailwind-preset.js`.

- [ ] **Step 3: Create the preset and wire the edge config**

Create `web/react-gui/src/ui-core/tailwind-preset.js`:

```js
/**
 * Shared Tailwind preset over the ui-core tokens (tokens.css).
 * Canonical in osi-os web/react-gui/src/ui-core; byte-mirrored to
 * osi-server frontend/src/ui-core. Consumed as `presets: [uiCorePreset]`
 * by each repo's tailwind.config.js (edge activates its config with
 * `@config` in src/index.css because Tailwind v4 is CSS-first).
 */
export default {
  theme: {
    extend: {
      colors: {
        /* Legacy palette moved here from the two repo tailwind configs. */
        'farm-green': '#22c55e',
        'farm-red': '#ef4444',
        'farm-blue': '#3b82f6',
        'farm-yellow': '#eab308',
        /* Semantic names over the ui-core tokens. */
        bg: 'var(--bg)',
        surface: 'var(--surface)',
        card: 'var(--card)',
        text: 'var(--text)',
        'text-secondary': 'var(--text-secondary)',
        'text-tertiary': 'var(--text-tertiary)',
        'text-disabled': 'var(--text-disabled)',
        border: 'var(--border)',
        focus: 'var(--focus)',
        primary: 'var(--primary)',
        'primary-hover': 'var(--primary-hover)',
        'secondary-bg': 'var(--secondary-bg)',
        'header-bg': 'var(--header-bg)',
        'header-text': 'var(--header-text)',
        'header-subtext': 'var(--header-subtext)',
        'brand-red': 'var(--brand-red)',
        'success-bg': 'var(--success-bg)',
        'success-text': 'var(--success-text)',
        'success-border': 'var(--success-border)',
        'warn-bg': 'var(--warn-bg)',
        'warn-text': 'var(--warn-text)',
        'warn-border': 'var(--warn-border)',
        'error-bg': 'var(--error-bg)',
        'error-text': 'var(--error-text)',
        'danger-fg': 'var(--danger-fg)',
        'soil-wet': 'var(--soil-wet)',
        'soil-wet-bg': 'var(--soil-wet-bg)',
        'soil-moist': 'var(--soil-moist)',
        'soil-moist-bg': 'var(--soil-moist-bg)',
        'soil-dry': 'var(--soil-dry)',
        'soil-dry-bg': 'var(--soil-dry-bg)',
        'toggle-on': 'var(--toggle-on)',
        'toggle-off': 'var(--toggle-off)',
        overlay: 'var(--overlay)',
      },
    },
  },
};
```

Replace `web/react-gui/tailwind.config.js` entirely with:

```js
import uiCorePreset from './src/ui-core/tailwind-preset.js';

/** @type {import('tailwindcss').Config} */
export default {
  presets: [uiCorePreset],
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {},
  },
  plugins: [],
}
```

In `web/react-gui/src/index.css`, insert directly below the line `@import "tailwindcss";`:

```css
@config "../tailwind.config.js";
```

- [ ] **Step 4: Run the test and a build sanity check**

```bash
npx tsx --test tests/uiCoreTailwindPreset.test.ts && npm run build
```

Expected: PASS (3 tests) and a successful Vite build. The T6 gate later proves the `@config` activation changed no emitted CSS; if T6 reports drift attributable to this line, remove the `@config` line and its test assertion there, and record the removal in the T6 commit body.

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add web/react-gui/src/ui-core/tailwind-preset.js web/react-gui/tailwind.config.js web/react-gui/src/index.css web/react-gui/tests/uiCoreTailwindPreset.test.ts
git commit -m "feat: ui-core tailwind preset; edge config extends it"
```

---

### Task 3: `primitives.css` + Surface, Button, Chip

Primitive class strings are copied from live edge call sites, never redesigned: the card/section treatment from `src/pages/admin/UsersPage.tsx`, buttons from `src/pages/FarmingDashboard.tsx` and `src/components/farming/CreateZoneModal.tsx`, the liquid variants from `src/pages/Login.tsx` / `src/components/AppHeader.tsx`, chips from the status-token badge pattern (`src/components/farming/dendrometer/ZoneAnalysisCard.tsx` shape over token colors).

**Files:**
- Create: `web/react-gui/src/ui-core/primitives.css`, `web/react-gui/src/ui-core/Surface.tsx`, `web/react-gui/src/ui-core/Button.tsx`, `web/react-gui/src/ui-core/Chip.tsx`
- Test: `web/react-gui/src/ui-core/__tests__/surfaces.test.tsx`

**Interfaces:**
- Consumes: `tokens.css` variables; glass classes defined in `primitives.css`.
- Produces: `Surface({ variant?: 'card' | 'muted' | 'chrome' })`, `Button({ variant?: 'primary' | 'secondary' | 'liquid' | 'liquid-red' })`, `Chip({ tone?: 'neutral' | 'success' | 'warn' | 'error' })`; `primitives.css` defining `.btn-liquid`, `.btn-liquid-red`, `.glass-chrome`, `.glass-tabs`, `.glass-tab`.

- [ ] **Step 1: Write the failing test**

Create `web/react-gui/src/ui-core/__tests__/surfaces.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from '../Button';
import { Chip } from '../Chip';
import { Surface } from '../Surface';

afterEach(cleanup);

describe('Surface', () => {
  it('renders the solid card treatment by default', () => {
    render(<Surface data-testid="s">content</Surface>);
    expect(screen.getByTestId('s').className).toContain('bg-[var(--card)]');
    expect(screen.getByTestId('s').className).toContain('rounded-2xl');
  });
  it('renders the glass chrome treatment', () => {
    render(<Surface variant="chrome" data-testid="s" />);
    expect(screen.getByTestId('s').className).toContain('glass-chrome');
  });
});

describe('Button', () => {
  it('defaults to a primary solid button with the touch target', () => {
    render(<Button>Save</Button>);
    const button = screen.getByRole('button', { name: 'Save' });
    expect(button.getAttribute('type')).toBe('button');
    expect(button.className).toContain('touch-target');
    expect(button.className).toContain('bg-[var(--primary)]');
  });
  it('emits the liquid-glass class for the glass variants', () => {
    render(<Button variant="liquid-red">Log in</Button>);
    expect(screen.getByRole('button', { name: 'Log in' }).className).toContain('btn-liquid-red');
  });
});

describe('Chip', () => {
  it('renders tone classes from the status tokens', () => {
    render(<Chip tone="success">OK</Chip>);
    const chip = screen.getByText('OK');
    expect(chip.className).toContain('bg-[var(--success-bg)]');
    expect(chip.className).toContain('rounded-full');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npx vitest run src/ui-core/__tests__/surfaces.test.tsx
```

Expected: FAIL — cannot resolve `../Button` / `../Chip` / `../Surface`.

- [ ] **Step 3: Create `primitives.css` and the three components**

`web/react-gui/src/ui-core/primitives.css` — header comment plus two byte-for-byte copies from the current `web/react-gui/src/index.css`:

```css
/* ui-core primitive styles — liquid-glass material for the glass primitives.
   Copied verbatim from the edge index.css glass section; canonical in osi-os,
   byte-mirrored to osi-server. Glass is chrome-only: primary/danger semantics
   and data surfaces stay solid. */
```

1. Copy block A: from the line `/* ── Liquid-glass material ─────────────────────────────────────────────────` through the closing brace of `html[data-theme='dark'] .glass-tab[aria-current='page'] { … }` (pre-T2 line numbers 199–336; T2's `@config` insertion shifts everything down by one). Selectors covered: `.btn-liquid`, `.btn-liquid-red` (base, `::after`, `:hover`, `:active`, `:disabled`), `.glass-chrome`, `.glass-tabs`, `.glass-tab`, `@media (pointer: coarse)` `.glass-tab`, `.glass-tab[aria-current='page']` light and dark.
2. Copy block B: from the line `/* Accessibility + capability fallbacks: solid surfaces, no filters/motion. */` through the closing brace of the `@media (prefers-reduced-motion: reduce)` block (pre-T2 lines 352–382).

Do NOT copy the two `.login-scene` rules sitting between block A and block B: the edge login scene is single-consumer and stays in `index.css` (D6 keeps the cloud login untouched anyway). In this task `index.css` is left as is; T6 deletes the duplicated blocks there.

`web/react-gui/src/ui-core/Surface.tsx`:

```tsx
import type { HTMLAttributes } from 'react';

export type SurfaceVariant = 'card' | 'muted' | 'chrome';

const VARIANT_CLASSES: Record<SurfaceVariant, string> = {
  card: 'rounded-2xl border border-[var(--border)] bg-[var(--card)] shadow-sm',
  muted: 'rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm',
  chrome: 'glass-chrome',
};

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  variant?: SurfaceVariant;
}

export function Surface({ variant = 'card', className = '', ...rest }: SurfaceProps) {
  return <div className={`${VARIANT_CLASSES[variant]} ${className}`.trim()} {...rest} />;
}
```

`web/react-gui/src/ui-core/Button.tsx`:

```tsx
import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'liquid' | 'liquid-red';

const VARIANT_CLASSES: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--primary)] hover:bg-[var(--primary-hover)] text-white font-bold rounded-lg transition-colors ' +
    'disabled:bg-[var(--border)] disabled:text-[var(--text-disabled)] disabled:cursor-not-allowed',
  secondary:
    'bg-[var(--secondary-bg)] hover:bg-[var(--border)] text-[var(--text)] font-bold rounded-lg transition-colors',
  liquid: 'btn-liquid rounded-lg font-bold text-[var(--text)]',
  'liquid-red': 'btn-liquid-red rounded-lg font-bold disabled:cursor-not-allowed',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
}

export function Button({ variant = 'primary', className = '', type = 'button', ...rest }: ButtonProps) {
  return <button type={type} className={`touch-target ${VARIANT_CLASSES[variant]} ${className}`.trim()} {...rest} />;
}
```

`web/react-gui/src/ui-core/Chip.tsx`:

```tsx
import type { HTMLAttributes } from 'react';

export type ChipTone = 'neutral' | 'success' | 'warn' | 'error';

const TONE_CLASSES: Record<ChipTone, string> = {
  neutral: 'border-[var(--border)] bg-[var(--surface)] text-[var(--text-secondary)]',
  success: 'border-[var(--success-border)] bg-[var(--success-bg)] text-[var(--success-text)]',
  warn: 'border-[var(--warn-border)] bg-[var(--warn-bg)] text-[var(--warn-text)]',
  error: 'border-[var(--danger-fg)] bg-[var(--error-bg)] text-[var(--error-text)]',
};

export interface ChipProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: ChipTone;
}

export function Chip({ tone = 'neutral', className = '', ...rest }: ChipProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-semibold ${TONE_CLASSES[tone]} ${className}`.trim()}
      {...rest}
    />
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/ui-core/__tests__/surfaces.test.tsx && npm run typecheck
```

Expected: PASS (5 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add web/react-gui/src/ui-core/primitives.css web/react-gui/src/ui-core/Surface.tsx web/react-gui/src/ui-core/Button.tsx web/react-gui/src/ui-core/Chip.tsx web/react-gui/src/ui-core/__tests__/surfaces.test.tsx
git commit -m "feat: ui-core glass surface, button and chip primitives"
```

---

### Task 4: Modal, Banner, FormField

Shell markup copied from `CreateZoneModal.tsx` (modal + form field, including the verbatim `bg-white` input treatment, a known dark-theme quirk that stays as-is, no redesign) and `GatewayRestartBanner.tsx` (banner).

**Files:**
- Create: `web/react-gui/src/ui-core/Modal.tsx`, `web/react-gui/src/ui-core/Banner.tsx`, `web/react-gui/src/ui-core/FormField.tsx`
- Test: `web/react-gui/src/ui-core/__tests__/feedback.test.tsx`

**Interfaces:**
- Consumes: `tokens.css` variables; `high-contrast-text` / `touch-target` utility classes (defined per-repo, outside ui-core).
- Produces: `Modal({ isOpen, title, onClose, closeLabel?, children })`, `Banner({ tone?: 'warn' | 'error' | 'success', className?, children })`, `FormField({ id, label, hint?, children })`, `INPUT_CLASS` string constant.

- [ ] **Step 1: Write the failing test**

Create `web/react-gui/src/ui-core/__tests__/feedback.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Banner } from '../Banner';
import { FormField, INPUT_CLASS } from '../FormField';
import { Modal } from '../Modal';

afterEach(cleanup);

describe('Modal', () => {
  it('renders nothing while closed', () => {
    const { container } = render(
      <Modal isOpen={false} title="Create zone" onClose={() => {}}>body</Modal>,
    );
    expect(container.innerHTML).toBe('');
  });
  it('renders a labelled dialog with a close control', () => {
    const onClose = vi.fn();
    render(<Modal isOpen title="Create zone" onClose={onClose}>body</Modal>);
    expect(screen.getByRole('dialog', { name: 'Create zone' })).toBeTruthy();
    screen.getByRole('button', { name: 'Close' }).click();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('Banner', () => {
  it('uses the warn tokens and a status role by default', () => {
    render(<Banner>Restarting</Banner>);
    expect(screen.getByRole('status').className).toContain('bg-[var(--warn-bg)]');
  });
  it('uses the error tokens and an alert role for tone="error"', () => {
    render(<Banner tone="error">Failed</Banner>);
    expect(screen.getByRole('alert').className).toContain('bg-[var(--error-bg)]');
  });
});

describe('FormField', () => {
  it('associates the label with the field content', () => {
    render(
      <FormField id="zone-name" label="Zone name">
        <input id="zone-name" className={INPUT_CLASS} />
      </FormField>,
    );
    expect(screen.getByLabelText('Zone name').className).toContain('touch-target');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npx vitest run src/ui-core/__tests__/feedback.test.tsx
```

Expected: FAIL — cannot resolve `../Banner` / `../FormField` / `../Modal`.

- [ ] **Step 3: Create the three components**

`web/react-gui/src/ui-core/Modal.tsx`:

```tsx
import type { ReactNode } from 'react';

export interface ModalProps {
  isOpen: boolean;
  title: string;
  onClose: () => void;
  closeLabel?: string;
  children: ReactNode;
}

export function Modal({ isOpen, title, onClose, closeLabel = 'Close', children }: ModalProps) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 bg-[var(--overlay)] flex items-center justify-center z-50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bg-[var(--card)] rounded-2xl shadow-2xl border-2 border-[var(--border)] max-w-lg w-full p-8"
      >
        <div className="flex justify-between items-center mb-6">
          <h2 className="text-3xl font-bold text-[var(--text)] high-contrast-text">{title}</h2>
          <button
            type="button"
            aria-label={closeLabel}
            onClick={onClose}
            className="text-[var(--text-tertiary)] hover:text-[var(--text)] text-3xl leading-none"
          >
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
```

`web/react-gui/src/ui-core/Banner.tsx`:

```tsx
import type { ReactNode } from 'react';

export type BannerTone = 'warn' | 'error' | 'success';

const TONE_CLASSES: Record<BannerTone, string> = {
  warn: 'border-[var(--warn-border)] bg-[var(--warn-bg)] text-[var(--warn-text)]',
  error: 'border-[var(--danger-fg)] bg-[var(--error-bg)] text-[var(--error-text)]',
  success: 'border-[var(--success-border)] bg-[var(--success-bg)] text-[var(--success-text)]',
};

export interface BannerProps {
  tone?: BannerTone;
  className?: string;
  children: ReactNode;
}

export function Banner({ tone = 'warn', className = '', children }: BannerProps) {
  const role = tone === 'error' ? 'alert' : 'status';
  return (
    <div
      role={role}
      className={`border-b px-4 py-3 text-center text-sm font-semibold ${TONE_CLASSES[tone]} ${className}`.trim()}
    >
      {children}
    </div>
  );
}
```

`web/react-gui/src/ui-core/FormField.tsx`:

```tsx
import type { ReactNode } from 'react';

/** Verbatim input treatment from the edge modals (CreateZoneModal / AddDeviceModal). */
export const INPUT_CLASS =
  'w-full px-4 py-4 touch-target bg-white border-2 border-[var(--border)] rounded-lg text-[var(--text)] text-lg ' +
  'placeholder:text-[var(--text-tertiary)] focus:outline-none focus:border-[var(--focus)] focus:ring-2 focus:ring-[var(--focus)]';

export interface FormFieldProps {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}

export function FormField({ id, label, hint, children }: FormFieldProps) {
  return (
    <div>
      <label htmlFor={id} className="block text-[var(--text)] text-lg font-semibold mb-2">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-sm text-[var(--text-tertiary)]">{hint}</p>}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
npx vitest run src/ui-core/__tests__/feedback.test.tsx && npm run typecheck
```

Expected: PASS (5 tests), typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add web/react-gui/src/ui-core/Modal.tsx web/react-gui/src/ui-core/Banner.tsx web/react-gui/src/ui-core/FormField.tsx web/react-gui/src/ui-core/__tests__/feedback.test.tsx
git commit -m "feat: ui-core modal, banner and form-field primitives"
```

---

### Task 5: TableShell, EmptyState, barrel export

Markup copied from `src/pages/admin/UsersPage.tsx` (table section) and `src/pages/FarmingDashboard.tsx` (empty state).

**Files:**
- Create: `web/react-gui/src/ui-core/TableShell.tsx`, `web/react-gui/src/ui-core/EmptyState.tsx`, `web/react-gui/src/ui-core/index.ts`
- Test: `web/react-gui/src/ui-core/__tests__/collections.test.tsx`

**Interfaces:**
- Consumes: `tokens.css` variables.
- Produces: `TableShell({ headers: ReactNode[], className?, children })`, `EmptyState({ title, subtitle?, children? })`; barrel `index.ts` re-exporting all eight primitives and their prop types.

- [ ] **Step 1: Write the failing test**

Create `web/react-gui/src/ui-core/__tests__/collections.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { EmptyState, TableShell } from '../index';

afterEach(cleanup);

describe('TableShell', () => {
  it('renders headers inside the bordered scroll container', () => {
    render(
      <TableShell headers={['Username', 'Role']}>
        <tr>
          <td className="p-4">amina</td>
          <td className="p-4">admin</td>
        </tr>
      </TableShell>,
    );
    expect(screen.getByRole('table').querySelectorAll('th')).toHaveLength(2);
    expect(screen.getByText('amina')).toBeTruthy();
  });
});

describe('EmptyState', () => {
  it('renders title, subtitle and centered actions', () => {
    render(
      <EmptyState title="No devices yet" subtitle="Add your first device">
        <button type="button">Add device</button>
      </EmptyState>,
    );
    expect(screen.getByText('No devices yet').className).toContain('font-bold');
    expect(screen.getByRole('button', { name: 'Add device' })).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
npx vitest run src/ui-core/__tests__/collections.test.tsx
```

Expected: FAIL — cannot resolve `../index`.

- [ ] **Step 3: Create the components and the barrel**

`web/react-gui/src/ui-core/TableShell.tsx`:

```tsx
import type { ReactNode } from 'react';

export interface TableShellProps {
  headers: ReactNode[];
  className?: string;
  children: ReactNode;
}

export function TableShell({ headers, className = '', children }: TableShellProps) {
  return (
    <div className={`overflow-x-auto rounded-2xl border border-[var(--border)] bg-[var(--surface)] shadow-sm ${className}`.trim()}>
      <table className="w-full text-left">
        <thead className="border-b border-[var(--border)] text-sm text-[var(--text-secondary)]">
          <tr>
            {headers.map((header, index) => (
              <th key={index} className="p-4">{header}</th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}
```

`web/react-gui/src/ui-core/EmptyState.tsx`:

```tsx
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  title: string;
  subtitle?: string;
  children?: ReactNode;
}

export function EmptyState({ title, subtitle, children }: EmptyStateProps) {
  return (
    <div className="text-center py-12 bg-[var(--surface)] rounded-xl border-2 border-[var(--border)]">
      <p className="text-[var(--text)] text-2xl font-bold mb-4">{title}</p>
      {subtitle && <p className="text-[var(--text-tertiary)] text-lg mb-6">{subtitle}</p>}
      {children && <div className="flex gap-4 justify-center">{children}</div>}
    </div>
  );
}
```

`web/react-gui/src/ui-core/index.ts`:

```ts
export { Banner } from './Banner';
export type { BannerProps, BannerTone } from './Banner';
export { Button } from './Button';
export type { ButtonProps, ButtonVariant } from './Button';
export { Chip } from './Chip';
export type { ChipProps, ChipTone } from './Chip';
export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';
export { FormField, INPUT_CLASS } from './FormField';
export type { FormFieldProps } from './FormField';
export { Modal } from './Modal';
export type { ModalProps } from './Modal';
export { Surface } from './Surface';
export type { SurfaceProps, SurfaceVariant } from './Surface';
export { TableShell } from './TableShell';
export type { TableShellProps } from './TableShell';
```

- [ ] **Step 4: Run the ui-core suite to verify it passes**

```bash
npx vitest run src/ui-core && npm run typecheck
```

Expected: PASS (12 tests across 3 files), typecheck clean.

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add web/react-gui/src/ui-core/TableShell.tsx web/react-gui/src/ui-core/EmptyState.tsx web/react-gui/src/ui-core/index.ts web/react-gui/src/ui-core/__tests__/collections.test.tsx
git commit -m "feat: ui-core table-shell and empty-state primitives + barrel"
```

---

### Task 6: Edge adoption (CSS import-path moves) + bundle-parity gate

`index.css` swaps its local token and glass blocks for ui-core imports. Vite minifies CSS to one line and inlines `@import`s, and moving blocks into imports reorders output, so the gate compares CSS as an order-independent set of `selector { declaration }` atoms; the only allowlisted atom drift is the `--error-bg`/`--error-text` fix. Everything that is not CSS must be byte-identical after normalizing the 8-character Vite content hashes (in file names and inside file contents, because dynamic-chunk preload arrays embed hashed CSS names).

**Files:**
- Modify: `web/react-gui/src/index.css`
- Create: `web/react-gui/scripts/css-rule-diff-lib.mjs`, `web/react-gui/scripts/css-rule-diff.mjs`, `web/react-gui/scripts/css-rule-diff.test.mjs`, `web/react-gui/scripts/verify-bundle-parity.sh`

**Interfaces:**
- Consumes: T1 `tokens.css`, T3 `primitives.css`; the T1 commit subject `feat: extract ui-core design tokens (tokens.css)` as the baseline anchor.
- Produces: `verify-bundle-parity.sh <baseline-ref>` (exit 0 = parity); `diffAtoms(beforeCss, afterCss): string[]` and `ALLOW` regex from `css-rule-diff-lib.mjs`.

- [ ] **Step 1: Write the failing differ test**

Create `web/react-gui/scripts/css-rule-diff.test.mjs`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { ALLOW, atoms, diffAtoms } from './css-rule-diff-lib.mjs';

test('reordered rules produce no diff', () => {
  const a = ':root{--bg:#fff;--text:#000}.card{color:red}';
  const b = '.card{color:red}:root{--text:#000;--bg:#fff}';
  assert.deepEqual(diffAtoms(a, b), []);
});

test('a changed declaration is reported from both sides and allowlisted', () => {
  const changed = diffAtoms(':root{--error-bg:#DC2626}', ':root{--error-bg:#FEE2E2}');
  assert.equal(changed.length, 2);
  assert.ok(changed.every((atom) => ALLOW.test(atom)));
});

test('non-error drift is not covered by ALLOW', () => {
  const changed = diffAtoms('.card{color:red}', '.card{color:blue}');
  assert.equal(changed.filter((atom) => !ALLOW.test(atom)).length, 2);
});

test('atoms keep at-rule context distinct', () => {
  const css = '@media (pointer:coarse){.glass-tab{min-height:44px}}';
  assert.ok(atoms(css).some((atom) => atom.startsWith('@media (pointer:coarse)')));
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui
node --test scripts/css-rule-diff.test.mjs
```

Expected: FAIL — cannot find `./css-rule-diff-lib.mjs`.

- [ ] **Step 3: Write the differ library and CLI**

`web/react-gui/scripts/css-rule-diff-lib.mjs`:

```js
// Order-independent CSS comparison at declaration granularity.
// An "atom" is `selector { single-declaration }`; moving rules between
// files reorders the bundle without changing the atom multiset.
export const ALLOW = /--error-(bg|text)\s*:/;

export function atoms(css) {
  const out = [];
  for (const fragment of css.split('}')) {
    const brace = fragment.indexOf('{');
    if (brace === -1) continue;
    const selector = fragment.slice(0, brace).trim();
    for (const declaration of fragment.slice(brace + 1).split(';')) {
      const trimmed = declaration.trim();
      if (trimmed) out.push(`${selector} { ${trimmed} }`);
    }
  }
  return out;
}

export function diffAtoms(beforeCss, afterCss) {
  const counts = new Map();
  for (const atom of atoms(beforeCss)) counts.set(atom, (counts.get(atom) ?? 0) + 1);
  for (const atom of atoms(afterCss)) counts.set(atom, (counts.get(atom) ?? 0) - 1);
  return [...counts.entries()].filter(([, count]) => count !== 0).map(([atom]) => atom);
}
```

`web/react-gui/scripts/css-rule-diff.mjs`:

```js
#!/usr/bin/env node
import fs from 'node:fs';
import process from 'node:process';
import { ALLOW, diffAtoms } from './css-rule-diff-lib.mjs';

const [beforePath, afterPath] = process.argv.slice(2);
if (!beforePath || !afterPath) {
  console.error('usage: css-rule-diff.mjs <before.css> <after.css>');
  process.exit(2);
}
const changed = diffAtoms(fs.readFileSync(beforePath, 'utf8'), fs.readFileSync(afterPath, 'utf8'));
const offenders = changed.filter((atom) => !ALLOW.test(atom));
if (offenders.length > 0) {
  console.error('css-rule-diff: unexpected CSS drift:');
  for (const atom of offenders) console.error(`  ${atom.slice(0, 200)}`);
  process.exit(1);
}
console.log(`css-rule-diff: OK (${changed.length} allowlisted atom changes)`);
```

Run `node --test scripts/css-rule-diff.test.mjs` — expected: PASS (4 tests).

- [ ] **Step 4: Write the gate script**

`web/react-gui/scripts/verify-bundle-parity.sh`:

```sh
#!/bin/sh
# Builds the GUI at <baseline-ref> and at the working tree, then proves the
# bundles match modulo 8-char Vite hashes; CSS may differ only in the
# allowlisted --error token atoms (css-rule-diff.mjs).
set -eu

baseline_ref=${1:?usage: verify-bundle-parity.sh <baseline-ref>}
gui_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
repo_root=$(CDPATH= cd -- "$gui_dir/../.." && pwd)
work=$(mktemp -d)
cleanup() {
  git -C "$repo_root" worktree remove --force "$work/baseline" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT HUP INT TERM

git -C "$repo_root" worktree add --detach "$work/baseline" "$baseline_ref" >/dev/null
(cd "$work/baseline/web/react-gui" && npm ci --no-audit --no-fund >/dev/null && npm run build >/dev/null)
(cd "$gui_dir" && npm run build >/dev/null)

normalize_tree() {
  src_dir=$1
  out_dir=$2
  (cd "$src_dir" && find . -type f | sort) | while read -r rel; do
    norm_rel=$(printf '%s' "$rel" | sed -E 's/-[A-Za-z0-9_-]{8}\.(js|css)/.HASH.\1/g')
    mkdir -p "$out_dir/$(dirname "$norm_rel")"
    case "$rel" in
      *.js|*.css|*.html)
        sed -E 's/-[A-Za-z0-9_-]{8}\.(js|css)/.HASH.\1/g' "$src_dir/$rel" > "$out_dir/$norm_rel" ;;
      *)
        cp "$src_dir/$rel" "$out_dir/$norm_rel" ;;
    esac
  done
}
normalize_tree "$work/baseline/web/react-gui/build" "$work/before"
normalize_tree "$gui_dir/build" "$work/after"

if ! diff -r --exclude='*.css' "$work/before" "$work/after"; then
  echo "verify-bundle-parity: FAILED — non-CSS assets differ" >&2
  exit 1
fi

for css in $(cd "$work/after" && find . -name '*.css' | sort); do
  node "$gui_dir/scripts/css-rule-diff.mjs" "$work/before/$css" "$work/after/$css"
done

echo "verify-bundle-parity: OK"
```

`chmod +x web/react-gui/scripts/verify-bundle-parity.sh web/react-gui/scripts/css-rule-diff.mjs`

- [ ] **Step 5: Run the gate before touching index.css (isolates the T2 `@config` effect)**

```bash
BASELINE=$(git log --format=%H --grep='^feat: extract ui-core design tokens' -n 1)~1
sh scripts/verify-bundle-parity.sh "$BASELINE"
```

Expected: `verify-bundle-parity: OK` with `css-rule-diff: OK (0 allowlisted atom changes)`. If CSS atoms drifted here, the T2 `@config` line caused it: remove that line and its assertion in `tests/uiCoreTailwindPreset.test.ts`, rerun, and record the removal in this task's commit body.

- [ ] **Step 6: Rewrite `src/index.css` to adopt ui-core**

Three edits, nothing else changes:

1. Replace the top of the file so it reads:

```css
@import "tailwindcss";
@import "./ui-core/tokens.css";
@import "./ui-core/primitives.css";
@config "../tailwind.config.js";
```

2. Delete the superseded local token sheet: the `/* Light, high-contrast theme for field readability */` comment, the whole `:root { … }` block and the whole `html[data-theme='dark'] { … }` block.
3. Delete the superseded glass styles: block A (`/* ── Liquid-glass material …` through the dark `.glass-tab[aria-current='page']` rule) and block B (the accessibility-fallback and reduced-motion blocks); these are the exact ranges T3 copied into `primitives.css`. Keep the `.login-scene` rules, `.balken-crown` rules, `.font-brand`, the `body` rule, `.touch-target`, and `.high-contrast-text` exactly where they are.

- [ ] **Step 7: Run the gate and the full edge suite**

```bash
BASELINE=$(git log --format=%H --grep='^feat: extract ui-core design tokens' -n 1)~1
sh scripts/verify-bundle-parity.sh "$BASELINE"
npm run typecheck && npm run test:unit
```

Expected: `css-rule-diff: OK (4 allowlisted atom changes)` (old + new atom for each of the two error tokens), `verify-bundle-parity: OK`, typecheck clean, and the full suite green (94 node tests plus the Vitest suite, now 1,683 with the 12 ui-core tests).

- [ ] **Step 8: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add web/react-gui/src/index.css web/react-gui/scripts/css-rule-diff-lib.mjs web/react-gui/scripts/css-rule-diff.mjs web/react-gui/scripts/css-rule-diff.test.mjs web/react-gui/scripts/verify-bundle-parity.sh
git commit -m "feat: edge adopts ui-core tokens/primitives.css (bundle-parity gated)"
```

---

### Task 7: Vendor to osi-server + `verify-ui-core-vendor` gates both repos + branding-test extension

Mirrors `scripts/verify-edge-sync-contract-vendor.sh` / `.test.sh` (osi-server) and its CI step in `.github/workflows/backend-ci.yml`. Directory comparison uses `diff -ru` instead of a fixed file list because ui-core files will be added per-slice. The osi-os side gets its own workflow using the `OSI_SERVER_RO_TOKEN` checkout pattern from `.github/workflows/migrations.yml` (osi-server is a private repo; osi-os is public, so the server-side checkout of osi-os needs no token).

**Files:**
- Create (osi-server): `frontend/src/ui-core/` (byte copy), `scripts/verify-ui-core-vendor.sh`, `scripts/verify-ui-core-vendor.test.sh`
- Modify (osi-server): `.github/workflows/backend-ci.yml`, `frontend/tests/agrolinkBranding.test.ts`
- Create (osi-os): `scripts/verify-ui-core-vendor.sh`, `scripts/verify-ui-core-vendor.test.sh`, `.github/workflows/ui-core.yml`

**Interfaces:**
- Consumes: the finalized `web/react-gui/src/ui-core/` tree from T1–T6.
- Produces: `frontend/src/ui-core/` (T8–T10 and S1+ import from it); `sh scripts/verify-ui-core-vendor.sh` on either side (exit 0 = byte parity); envs `EDGE_UI_CORE_ROOT` (server side) and `OSI_SERVER_ROOT` (os side).

- [ ] **Step 1: Write the failing verifier self-test (osi-server)**

Create `/home/phil/Repos/osi-server/.worktrees/agrolink/scripts/verify-ui-core-vendor.test.sh`:

```sh
#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
verifier="$script_dir/verify-ui-core-vendor.sh"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

edge_root="$tmp_dir/edge"
vendor_root="$tmp_dir/vendor"
mkdir -p "$edge_root/web/react-gui/src/ui-core/__tests__" "$vendor_root/__tests__"
printf 'tokens\n' > "$edge_root/web/react-gui/src/ui-core/tokens.css"
printf 'test\n' > "$edge_root/web/react-gui/src/ui-core/__tests__/surfaces.test.tsx"
cp "$edge_root/web/react-gui/src/ui-core/tokens.css" "$vendor_root/tokens.css"
cp "$edge_root/web/react-gui/src/ui-core/__tests__/surfaces.test.tsx" "$vendor_root/__tests__/surfaces.test.tsx"

EDGE_UI_CORE_ROOT="$edge_root" VENDOR_UI_CORE_ROOT="$vendor_root" sh "$verifier"

printf 'drift\n' >> "$vendor_root/tokens.css"
if EDGE_UI_CORE_ROOT="$edge_root" VENDOR_UI_CORE_ROOT="$vendor_root" sh "$verifier" >/dev/null 2>&1; then
  echo 'expected byte drift to fail' >&2
  exit 1
fi
cp "$edge_root/web/react-gui/src/ui-core/tokens.css" "$vendor_root/tokens.css"

printf 'extra\n' > "$vendor_root/extra.css"
if EDGE_UI_CORE_ROOT="$edge_root" VENDOR_UI_CORE_ROOT="$vendor_root" sh "$verifier" >/dev/null 2>&1; then
  echo 'expected an extra vendored file to fail' >&2
  exit 1
fi
rm "$vendor_root/extra.css"

rm -rf "$vendor_root"
if EDGE_UI_CORE_ROOT="$edge_root" VENDOR_UI_CORE_ROOT="$vendor_root" sh "$verifier" >/dev/null 2>&1; then
  echo 'expected a missing vendor directory to fail' >&2
  exit 1
fi

echo "verify-ui-core-vendor.test: OK"
```

Run: `cd /home/phil/Repos/osi-server/.worktrees/agrolink && sh scripts/verify-ui-core-vendor.test.sh`
Expected: FAIL — `verify-ui-core-vendor.sh: No such file or directory` (exit non-zero).

- [ ] **Step 2: Write the verifier (osi-server)**

Create `/home/phil/Repos/osi-server/.worktrees/agrolink/scripts/verify-ui-core-vendor.sh`:

```sh
#!/bin/sh
set -eu

if [ -z "${EDGE_UI_CORE_ROOT:-}" ]; then
  echo "EDGE_UI_CORE_ROOT is required (path to an osi-os checkout)" >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
server_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
canonical_root="$EDGE_UI_CORE_ROOT/web/react-gui/src/ui-core"
vendor_root=${VENDOR_UI_CORE_ROOT:-"$server_root/frontend/src/ui-core"}

for dir in "$canonical_root" "$vendor_root"; do
  if [ ! -d "$dir" ] || [ -z "$(ls -A "$dir")" ]; then
    echo "missing or empty ui-core directory: $dir" >&2
    exit 1
  fi
done

if ! diff -ru "$canonical_root" "$vendor_root"; then
  echo "vendored ui-core differs from canonical osi-os web/react-gui/src/ui-core" >&2
  exit 1
fi

echo "verify-ui-core-vendor: OK"
```

Run: `sh scripts/verify-ui-core-vendor.test.sh`
Expected: `verify-ui-core-vendor.test: OK`.

- [ ] **Step 3: Extend the branding test over ui-core (fails before the vendor copy exists)**

Append to `/home/phil/Repos/osi-server/.worktrees/agrolink/frontend/tests/agrolinkBranding.test.ts`:

```ts
test('ui-core shared primitives carry no OSI Cloud branding tokens', () => {
  const uiCoreRoot = path.join(frontendRoot, 'src/ui-core');
  const offenders = listFilesRecursive(uiCoreRoot, ['.ts', '.tsx', '.css', '.js'])
    .filter((filePath) => /OSI (Irrigation )?Cloud/.test(fs.readFileSync(filePath, 'utf8')))
    .map((filePath) => path.relative(frontendRoot, filePath));

  assert.deepEqual(offenders, []);
});

test('ui-core imports stay inside ui-core (react and test tooling excepted)', () => {
  const uiCoreRoot = path.join(frontendRoot, 'src/ui-core');
  const allowedBare = new Set(['react', 'vitest', '@testing-library/react']);
  const offenders: string[] = [];
  for (const filePath of listFilesRecursive(uiCoreRoot, ['.ts', '.tsx'])) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const match of source.matchAll(/from '([^']+)'/g)) {
      const specifier = match[1];
      if (allowedBare.has(specifier)) continue;
      if (specifier.startsWith('.') && path.resolve(path.dirname(filePath), specifier).startsWith(uiCoreRoot)) continue;
      offenders.push(`${path.relative(frontendRoot, filePath)}: ${specifier}`);
    }
  }
  assert.deepEqual(offenders, []);
});
```

Run: `cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend && npx tsx --test tests/agrolinkBranding.test.ts`
Expected: FAIL — `ENOENT … src/ui-core` (the vendor copy does not exist yet).

- [ ] **Step 4: Vendor the copy and verify byte parity**

```bash
rsync -a --delete /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/web/react-gui/src/ui-core/ /home/phil/Repos/osi-server/.worktrees/agrolink/frontend/src/ui-core/
cd /home/phil/Repos/osi-server/.worktrees/agrolink
EDGE_UI_CORE_ROOT=/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep sh scripts/verify-ui-core-vendor.sh
cd frontend && npx tsx --test tests/agrolinkBranding.test.ts
```

Expected: `verify-ui-core-vendor: OK`; branding tests PASS (8 existing + 2 new).

- [ ] **Step 5: Cloud suite + build compile the vendored code**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npm run test:unit && npm run build
```

Expected: green — the vendored `src/ui-core/__tests__` files now run inside the cloud Vitest pass (`--dir src`), and `tsc` compiles the vendored components.

- [ ] **Step 6: CI wiring (osi-server)**

In `/home/phil/Repos/osi-server/.worktrees/agrolink/.github/workflows/backend-ci.yml`, insert after the existing `Reject stale vendored sync contracts` step (keep that step unchanged):

```yaml
      - name: Check out canonical OSI OS ui-core
        uses: actions/checkout@v4
        with:
          repository: Open-Smart-Irrigation/osi-os
          ref: AgroLink
          path: .ui-core/osi-os
          persist-credentials: false
          fetch-depth: 1
      - name: Reject stale vendored ui-core
        env:
          EDGE_UI_CORE_ROOT: ${{ github.workspace }}/.ui-core/osi-os
        run: |
          sh scripts/verify-ui-core-vendor.test.sh
          sh scripts/verify-ui-core-vendor.sh
```

- [ ] **Step 6b: Fix the stale sync-contract checkout ref in the same file**

The existing `Check out canonical OSI OS sync contract` step in
`backend-ci.yml` still pins `ref: design-sync/agrolink` — that branch was
renamed to `AgroLink` on 2026-08-03 and the old ref was deleted from origin, so
the step fails on its next run. In the same edit, change that step's `ref:` to
`AgroLink`. No other change to the step.

```yaml
          ref: AgroLink
```

- [ ] **Step 7: Commit (osi-server)**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/ui-core scripts/verify-ui-core-vendor.sh scripts/verify-ui-core-vendor.test.sh .github/workflows/backend-ci.yml frontend/tests/agrolinkBranding.test.ts
git commit -m "feat: vendor osi-os ui-core with byte-parity CI gate and branding coverage

Also repoints the sync-contract checkout from the deleted
design-sync/agrolink ref to AgroLink."
```

- [ ] **Step 8: osi-os-side verifier + workflow (same TDD loop)**

Create `/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/scripts/verify-ui-core-vendor.test.sh`:

```sh
#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
verifier="$script_dir/verify-ui-core-vendor.sh"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT HUP INT TERM

canonical_root="$tmp_dir/canonical"
server_root="$tmp_dir/server"
mkdir -p "$canonical_root" "$server_root/frontend/src/ui-core"
printf 'tokens\n' > "$canonical_root/tokens.css"
cp "$canonical_root/tokens.css" "$server_root/frontend/src/ui-core/tokens.css"

CANONICAL_UI_CORE_ROOT="$canonical_root" OSI_SERVER_ROOT="$server_root" sh "$verifier"

printf 'drift\n' >> "$server_root/frontend/src/ui-core/tokens.css"
if CANONICAL_UI_CORE_ROOT="$canonical_root" OSI_SERVER_ROOT="$server_root" sh "$verifier" >/dev/null 2>&1; then
  echo 'expected byte drift to fail' >&2
  exit 1
fi
cp "$canonical_root/tokens.css" "$server_root/frontend/src/ui-core/tokens.css"

rm -rf "$server_root/frontend/src/ui-core"
if CANONICAL_UI_CORE_ROOT="$canonical_root" OSI_SERVER_ROOT="$server_root" sh "$verifier" >/dev/null 2>&1; then
  echo 'expected a missing vendor directory to fail' >&2
  exit 1
fi

echo "verify-ui-core-vendor.test: OK"
```

Run `sh scripts/verify-ui-core-vendor.test.sh` — expected FAIL (verifier missing). Then create `/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/scripts/verify-ui-core-vendor.sh`:

```sh
#!/bin/sh
set -eu

if [ -z "${OSI_SERVER_ROOT:-}" ]; then
  echo "OSI_SERVER_ROOT is required (path to an osi-server checkout on the AgroLink branch)" >&2
  exit 2
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
canonical_root=${CANONICAL_UI_CORE_ROOT:-"$repo_root/web/react-gui/src/ui-core"}
vendor_root="$OSI_SERVER_ROOT/frontend/src/ui-core"

for dir in "$canonical_root" "$vendor_root"; do
  if [ ! -d "$dir" ] || [ -z "$(ls -A "$dir")" ]; then
    echo "missing or empty ui-core directory: $dir" >&2
    exit 1
  fi
done

if ! diff -ru "$canonical_root" "$vendor_root"; then
  echo "vendored ui-core (osi-server frontend/src/ui-core) differs from canonical web/react-gui/src/ui-core" >&2
  exit 1
fi

echo "verify-ui-core-vendor: OK"
```

Run the self-test (`verify-ui-core-vendor.test: OK`) and the real comparison:

```bash
OSI_SERVER_ROOT=/home/phil/Repos/osi-server/.worktrees/agrolink sh scripts/verify-ui-core-vendor.sh
```

Expected: `verify-ui-core-vendor: OK`.

Create `/home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep/.github/workflows/ui-core.yml` (checkout pattern from `migrations.yml`; base ref `AgroLink` because ui-core exists only on that branch pair):

```yaml
name: UI Core Vendor Parity
on:
  push:
    branches: [ AgroLink ]
  pull_request:
    branches: [ AgroLink ]
jobs:
  vendor-parity:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false
      - uses: actions/checkout@v4
        with:
          repository: Open-Smart-Irrigation/osi-server
          token: ${{ secrets.OSI_SERVER_RO_TOKEN }}
          ref: AgroLink
          path: .vendor/osi-server
          persist-credentials: false
          fetch-depth: 1
      - name: Prefer matching osi-server branch
        env:
          OSI_SERVER_RO_TOKEN: ${{ secrets.OSI_SERVER_RO_TOKEN }}
          OSI_SERVER_REF: ${{ github.head_ref || github.ref_name }}
        run: |
          set -euo pipefail
          cd .vendor/osi-server
          auth_header="$(printf 'x-access-token:%s' "$OSI_SERVER_RO_TOKEN" | base64 | tr -d '\n')"
          if git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth_header}" \
              ls-remote --exit-code --heads origin "$OSI_SERVER_REF" >/dev/null; then
            git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${auth_header}" \
              fetch --depth=1 origin "refs/heads/${OSI_SERVER_REF}"
            git checkout --detach FETCH_HEAD
            echo "Using osi-server branch ${OSI_SERVER_REF}"
          else
            echo "No osi-server branch ${OSI_SERVER_REF}; using AgroLink checkout"
          fi
      - name: Reject stale vendored ui-core
        env:
          OSI_SERVER_ROOT: ${{ github.workspace }}/.vendor/osi-server
        run: |
          sh scripts/verify-ui-core-vendor.test.sh
          sh scripts/verify-ui-core-vendor.sh
```

- [ ] **Step 9: Commit (osi-os)**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add scripts/verify-ui-core-vendor.sh scripts/verify-ui-core-vendor.test.sh .github/workflows/ui-core.yml
git commit -m "feat: ui-core vendor-parity verifier and CI workflow (osi-os side)"
```

---

### Task 8: `GatewayProvider` on the cloud

Modeled on the edge `web/react-gui/src/contexts/ScopeContext.tsx` fail-closed pattern (deny-while-loading, closed value on fetch failure, `retry()`). Data source: `userAPI.getLinkedGateways()` → `GET /api/v1/users/me/linked-gateways` returning `LinkedGatewaySummary[]` (`frontend/src/services/api.ts:1257`, type in `frontend/src/types/farming.ts:239`). The summary itself carries the capability handshake flags (`fieldJournalSupported`, `scopedAccessCommandsSupported`, `zoneDesiredStateSupported`, …), so a switch re-runs the fetch to refresh them (D4).

**Files:**
- Create: `frontend/src/contexts/GatewayContext.tsx`
- Modify: `frontend/src/App.tsx`
- Test: `frontend/src/contexts/__tests__/GatewayContext.test.tsx`

**Interfaces:**
- Consumes: `userAPI.getMe(): Promise<UserProfile>`, `userAPI.getLinkedGateways(): Promise<LinkedGatewaySummary[]>`, `useAuth().token`.
- Produces (T9 and slices S1–S5 depend on these exact names):

```ts
export interface GatewayContextValue {
  loading: boolean;
  error: string | null;
  gateways: LinkedGatewaySummary[];
  activeGateway: LinkedGatewaySummary | null;
  hasMultipleGateways: boolean;
  selectGateway: (gatewayDeviceEui: string) => void;
  retry: () => void;
}
export function GatewayProvider({ children }: { children: React.ReactNode }): JSX.Element;
export function useGateway(): GatewayContextValue;
```

Storage key: `` `agrolink.active-gateway.v1.${UserProfile.id}` ``.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/contexts/__tests__/GatewayContext.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userAPI } from '../../services/api';
import type { LinkedGatewaySummary } from '../../types/farming';
import { GatewayProvider, useGateway } from '../GatewayContext';

vi.mock('../../services/api', () => ({
  userAPI: {
    getMe: vi.fn(),
    getLinkedGateways: vi.fn(),
  },
}));

vi.mock('../AuthContext', () => ({
  useAuth: () => ({ token: 'test-token' }),
}));

function summary(eui: string): LinkedGatewaySummary {
  return {
    gatewayDeviceEui: eui,
    offlineVerifierVersion: 1,
    authSyncStatus: 'IN_SYNC',
    linkedAuthSyncSupported: true,
    forceEdgeSyncSupported: true,
    fieldJournalSupported: true,
    scopedAccessSyncSupported: true,
    scopedAccessCommandsSupported: true,
    zoneDesiredStateSupported: true,
  };
}

function Probe() {
  const { loading, activeGateway, hasMultipleGateways, selectGateway } = useGateway();
  if (loading) return <p>loading</p>;
  return (
    <div>
      <p data-testid="active">{activeGateway?.gatewayDeviceEui ?? 'none'}</p>
      <p data-testid="multi">{String(hasMultipleGateways)}</p>
      <button type="button" onClick={() => selectGateway('EUI-B')}>switch</button>
    </div>
  );
}

describe('GatewayProvider', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(userAPI.getMe).mockResolvedValue({
      id: 7,
      username: 'amina',
      email: 'amina@example.org',
      role: 'USER',
      enabled: true,
      dataRetentionDays: 365,
      createdAt: '2026-01-01T00:00:00Z',
    });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('auto-selects a single linked gateway', async () => {
    vi.mocked(userAPI.getLinkedGateways).mockResolvedValue([summary('EUI-A')]);
    render(<GatewayProvider><Probe /></GatewayProvider>);
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('EUI-A'));
    expect(screen.getByTestId('multi').textContent).toBe('false');
  });

  it('honors the persisted selection for multi-gateway accounts', async () => {
    localStorage.setItem('agrolink.active-gateway.v1.7', 'EUI-B');
    vi.mocked(userAPI.getLinkedGateways).mockResolvedValue([summary('EUI-A'), summary('EUI-B')]);
    render(<GatewayProvider><Probe /></GatewayProvider>);
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('EUI-B'));
    expect(screen.getByTestId('multi').textContent).toBe('true');
  });

  it('falls back to the first gateway when the stored EUI is no longer linked', async () => {
    localStorage.setItem('agrolink.active-gateway.v1.7', 'EUI-GONE');
    vi.mocked(userAPI.getLinkedGateways).mockResolvedValue([summary('EUI-A'), summary('EUI-B')]);
    render(<GatewayProvider><Probe /></GatewayProvider>);
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('EUI-A'));
  });

  it('persists a switch and re-resolves the linked list', async () => {
    vi.mocked(userAPI.getLinkedGateways).mockResolvedValue([summary('EUI-A'), summary('EUI-B')]);
    render(<GatewayProvider><Probe /></GatewayProvider>);
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('EUI-A'));
    await act(async () => {
      screen.getByRole('button', { name: 'switch' }).click();
    });
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe('EUI-B'));
    expect(localStorage.getItem('agrolink.active-gateway.v1.7')).toBe('EUI-B');
    expect(vi.mocked(userAPI.getLinkedGateways).mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx vitest run --environment jsdom src/contexts/__tests__/GatewayContext.test.tsx
```

Expected: FAIL — cannot resolve `../GatewayContext`.

- [ ] **Step 3: Implement the provider**

Create `frontend/src/contexts/GatewayContext.tsx`:

```tsx
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { userAPI } from '../services/api';
import type { LinkedGatewaySummary } from '../types/farming';
import { useAuth } from './AuthContext';

const STORAGE_PREFIX = 'agrolink.active-gateway.v1.';

export interface GatewayContextValue {
  loading: boolean;
  error: string | null;
  gateways: LinkedGatewaySummary[];
  activeGateway: LinkedGatewaySummary | null;
  hasMultipleGateways: boolean;
  selectGateway: (gatewayDeviceEui: string) => void;
  retry: () => void;
}

const CLOSED: GatewayContextValue = {
  loading: false,
  error: null,
  gateways: [],
  activeGateway: null,
  hasMultipleGateways: false,
  selectGateway: () => {},
  retry: () => {},
};

const GatewayContext = createContext<GatewayContextValue>(CLOSED);

export function GatewayProvider({ children }: { children: React.ReactNode }) {
  const { token } = useAuth();
  const [gateways, setGateways] = useState<LinkedGatewaySummary[] | null>(null);
  const [storageKey, setStorageKey] = useState<string | null>(null);
  const [selectedEui, setSelectedEui] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [requestVersion, setRequestVersion] = useState(0);

  const retry = useCallback(() => {
    setGateways(null);
    setError(null);
    setLoading(true);
    setRequestVersion((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setGateways(null);
      setStorageKey(null);
      setSelectedEui(null);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    Promise.all([userAPI.getMe(), userAPI.getLinkedGateways()])
      .then(([profile, linked]) => {
        if (cancelled) return;
        const key = `${STORAGE_PREFIX}${profile.id}`;
        setStorageKey(key);
        setGateways(linked);
        setSelectedEui(localStorage.getItem(key));
        setLoading(false);
      })
      .catch(() => {
        if (!cancelled) {
          setGateways(null);
          setError('linked_gateways_unavailable');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [requestVersion, token]);

  const selectGateway = useCallback(
    (gatewayDeviceEui: string) => {
      setSelectedEui(gatewayDeviceEui);
      if (storageKey) localStorage.setItem(storageKey, gatewayDeviceEui);
      // Re-resolve the linked list so the selected gateway's capability
      // handshake flags are fresh (D4).
      setRequestVersion((current) => current + 1);
    },
    [storageKey],
  );

  const value = useMemo<GatewayContextValue>(() => {
    const list = gateways ?? [];
    let active: LinkedGatewaySummary | null = null;
    if (list.length === 1) {
      active = list[0];
    } else if (list.length > 1) {
      active = list.find((gateway) => gateway.gatewayDeviceEui === selectedEui) ?? list[0];
    }
    return {
      loading,
      error,
      gateways: list,
      activeGateway: loading || error !== null ? null : active,
      hasMultipleGateways: list.length > 1,
      selectGateway,
      retry,
    };
  }, [error, gateways, loading, retry, selectGateway, selectedEui]);

  return <GatewayContext.Provider value={value}>{children}</GatewayContext.Provider>;
}

export function useGateway(): GatewayContextValue {
  return useContext(GatewayContext);
}
```

In `frontend/src/App.tsx`, add the import next to the AuthProvider import:

```tsx
import { GatewayProvider } from './contexts/GatewayContext';
```

and wrap the provider directly inside `AuthProvider` (pages outside the parity surface simply never call `useGateway()`):

```tsx
      <AuthProvider>
        <GatewayProvider>
        <Suspense fallback={null}>
```

with the matching closing tag:

```tsx
        </Suspense>
        </GatewayProvider>
      </AuthProvider>
```

- [ ] **Step 4: Run the test and the cloud suite**

```bash
npx vitest run --environment jsdom src/contexts/__tests__/GatewayContext.test.tsx
npm run test:unit
```

Expected: 4 new tests PASS; full suite green.

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/contexts/GatewayContext.tsx frontend/src/contexts/__tests__/GatewayContext.test.tsx frontend/src/App.tsx
git commit -m "feat: GatewayProvider resolves linked gateways with persisted selection"
```

---

### Task 9: Settings "Active gateway" section + 7-locale keys

Renders only when `hasMultipleGateways` (D3: one gateway means no selector anywhere). New i18n keys in the `settings` namespace, all 7 locales (`de-CH`, `en`, `es`, `fr`, `it`, `lg`, `pt`): `activeGatewayTitle`, `activeGatewayHint`, `activeGatewayActive`, `activeGatewaySelect`.

**Files:**
- Modify: `frontend/src/pages/SettingsPage.tsx`, `frontend/public/locales/{de-CH,en,es,fr,it,lg,pt}/settings.json`
- Test: `frontend/src/pages/__tests__/SettingsPageActiveGateway.test.tsx`, `frontend/tests/settingsActiveGatewayLocales.test.ts`

**Interfaces:**
- Consumes: `useGateway()` from T8 (`gateways`, `activeGateway`, `hasMultipleGateways`, `selectGateway`); the existing `Section` component inside `SettingsPage.tsx`.
- Produces: the four `settings.*` keys above.

- [ ] **Step 1: Write the failing component test**

Create `frontend/src/pages/__tests__/SettingsPageActiveGateway.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { useGateway } from '../../contexts/GatewayContext';
import type { LinkedGatewaySummary } from '../../types/farming';
import { SettingsPage } from '../SettingsPage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../components/LanguageSwitcher', () => ({
  LanguageSwitcher: () => null,
}));
vi.mock('../../contexts/GatewayContext', () => ({
  useGateway: vi.fn(),
}));

function summary(eui: string): LinkedGatewaySummary {
  return {
    gatewayDeviceEui: eui,
    offlineVerifierVersion: 1,
    authSyncStatus: 'IN_SYNC',
    linkedAuthSyncSupported: true,
    forceEdgeSyncSupported: true,
    fieldJournalSupported: true,
    scopedAccessSyncSupported: true,
    scopedAccessCommandsSupported: true,
    zoneDesiredStateSupported: true,
  };
}

function gatewayState(euis: string[]) {
  const gateways = euis.map(summary);
  return {
    loading: false,
    error: null,
    gateways,
    activeGateway: gateways[0] ?? null,
    hasMultipleGateways: gateways.length > 1,
    selectGateway: vi.fn(),
    retry: vi.fn(),
  };
}

describe('SettingsPage active gateway section', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders no gateway section for a single-gateway account', () => {
    vi.mocked(useGateway).mockReturnValue(gatewayState(['EUI-A']));
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    expect(screen.queryByText('activeGatewayTitle')).toBeNull();
  });

  it('lists gateways and switches on click when several are linked', () => {
    const state = gatewayState(['EUI-A', 'EUI-B']);
    vi.mocked(useGateway).mockReturnValue(state);
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);
    expect(screen.getByText('activeGatewayTitle')).toBeTruthy();
    screen.getByRole('button', { name: /EUI-B/ }).click();
    expect(state.selectGateway).toHaveBeenCalledWith('EUI-B');
  });
});
```

- [ ] **Step 2: Write the failing locale test**

Create `frontend/tests/settingsActiveGatewayLocales.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const frontendRoot = path.resolve(import.meta.dirname, '..');
const LOCALES = ['de-CH', 'en', 'es', 'fr', 'it', 'lg', 'pt'];
const KEYS = ['activeGatewayTitle', 'activeGatewayHint', 'activeGatewayActive', 'activeGatewaySelect'];

test('every locale carries the active-gateway settings keys', () => {
  for (const locale of LOCALES) {
    const settings = JSON.parse(
      fs.readFileSync(path.join(frontendRoot, `public/locales/${locale}/settings.json`), 'utf8'),
    );
    for (const key of KEYS) {
      assert.equal(typeof settings[key], 'string', `${locale} settings.${key}`);
      assert.notEqual(settings[key].trim(), '', `${locale} settings.${key}`);
    }
  }
});
```

- [ ] **Step 3: Run both tests to verify they fail**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx vitest run --environment jsdom src/pages/__tests__/SettingsPageActiveGateway.test.tsx
npx tsx --test tests/settingsActiveGatewayLocales.test.ts
```

Expected: component test FAILS on the missing section (second `it`); locale test FAILS on missing keys.

- [ ] **Step 4: Implement the section and the locale strings**

In `frontend/src/pages/SettingsPage.tsx` add the import and hook call:

```tsx
import { useGateway } from '../contexts/GatewayContext';
```

inside `SettingsPage()` (first line of the function body, next to the existing hooks):

```tsx
  const { gateways, activeGateway, hasMultipleGateways, selectGateway } = useGateway();
```

Insert directly after the closing `</header>` tag and before `<Section title={t('languageTitle')}>`:

```tsx
        {hasMultipleGateways && (
          <Section title={t('activeGatewayTitle')}>
            <p className="max-w-2xl text-sm text-[var(--text-secondary)]">{t('activeGatewayHint')}</p>
            <div className="mt-4 grid gap-3">
              {gateways.map((gateway) => {
                const selected = gateway.gatewayDeviceEui === activeGateway?.gatewayDeviceEui;
                return (
                  <button
                    key={gateway.gatewayDeviceEui}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => selectGateway(gateway.gatewayDeviceEui)}
                    className={`flex min-h-11 items-center justify-between rounded-lg border border-[var(--border)] px-4 py-3 text-left ${
                      selected ? 'bg-[var(--primary)] text-white' : 'bg-[var(--surface)] hover:bg-[var(--secondary-bg)]'
                    }`}
                  >
                    <span className="font-semibold">{gateway.gatewayDeviceEui}</span>
                    <span className="text-sm font-bold">
                      {selected ? t('activeGatewayActive') : t('activeGatewaySelect')}
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>
        )}
```

Add these four keys to each locale's `settings.json` (tones match each file's existing register: de-CH/fr/pt formal, es/it informal; lg is a machine draft pending the human-native pass that gates Uganda):

| Locale | activeGatewayTitle | activeGatewayHint | activeGatewayActive | activeGatewaySelect |
|---|---|---|---|---|
| en | Active gateway | Choose which gateway this dashboard shows. The selection is saved for your account. | Active | Select |
| de-CH | Aktives Gateway | Wählen Sie, welches Gateway dieses Dashboard anzeigt. Die Auswahl wird für Ihr Konto gespeichert. | Aktiv | Auswählen |
| fr | Gateway actif | Choisissez le gateway affiché par ce tableau de bord. La sélection est enregistrée pour votre compte. | Actif | Sélectionner |
| it | Gateway attivo | Scegli quale gateway viene mostrato nella dashboard. La selezione viene salvata per il tuo account. | Attivo | Seleziona |
| es | Gateway activo | Elige qué gateway se muestra en este panel. La selección se guarda para tu cuenta. | Activo | Seleccionar |
| pt | Gateway ativo | Escolha qual gateway é mostrado neste painel. A seleção fica guardada na sua conta. | Ativo | Selecionar |
| lg | Gateway ekozesebwa | Londa gateway eragibwa ku dashboodi eno. By'olonze bikuumibwa ku akawunti yo. | Ekozesebwa | Londa |

- [ ] **Step 5: Run the tests and the full suite**

```bash
npx vitest run --environment jsdom src/pages/__tests__/SettingsPageActiveGateway.test.tsx
npx tsx --test tests/settingsActiveGatewayLocales.test.ts
npm run test:unit
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/pages/SettingsPage.tsx frontend/src/pages/__tests__/SettingsPageActiveGateway.test.tsx frontend/tests/settingsActiveGatewayLocales.test.ts frontend/public/locales/de-CH/settings.json frontend/public/locales/en/settings.json frontend/public/locales/es/settings.json frontend/public/locales/fr/settings.json frontend/public/locales/it/settings.json frontend/public/locales/lg/settings.json frontend/public/locales/pt/settings.json
git commit -m "feat: Settings active-gateway switcher for multi-gateway accounts (D3)"
```

---

### Task 10: Cloud tokens + preset adoption

The cloud `index.css` drops its local variable sheet for the vendored `tokens.css` and the config extends the vendored preset. Visible change: the cloud inherits the edge header tokens (`--header-bg` goes from `#1E3A8A` to `#FFFFFF`) plus the glass and soil variable sets: the sanctioned "no user-visible cloud change except tokens" of S0. The cloud login page keeps its own markup (D6); `primitives.css` is deliberately not imported until S1 renders the first glass primitive.

**Files:**
- Modify: `frontend/src/index.css`, `frontend/tailwind.config.js`
- Test: `frontend/tests/uiCoreTokensAdoption.test.ts`

**Interfaces:**
- Consumes: vendored `frontend/src/ui-core/tokens.css` and `tailwind-preset.js` from T7.
- Produces: cloud pages resolve the full ui-core token set via `var(--…)`.

- [ ] **Step 1: Write the failing test**

Create `frontend/tests/uiCoreTokensAdoption.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const frontendRoot = path.resolve(import.meta.dirname, '..');

test('index.css imports the vendored ui-core tokens and defines no local sheet', () => {
  const css = fs.readFileSync(path.join(frontendRoot, 'src/index.css'), 'utf8');
  assert.match(css, /@import '\.\/ui-core\/tokens\.css';/);
  assert.doesNotMatch(css, /--bg:\s*#/);
  assert.doesNotMatch(css, /--error-text:/);
});

test('tailwind.config extends the vendored ui-core preset', () => {
  const config = fs.readFileSync(path.join(frontendRoot, 'tailwind.config.js'), 'utf8');
  assert.match(config, /from '\.\/src\/ui-core\/tailwind-preset\.js'/);
  assert.match(config, /presets:\s*\[uiCorePreset\]/);
  assert.doesNotMatch(config, /'farm-green'/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink/frontend
npx tsx --test tests/uiCoreTokensAdoption.test.ts
```

Expected: FAIL on both tests.

- [ ] **Step 3: Implement**

Replace `frontend/src/index.css` in full with:

```css
@import './ui-core/tokens.css';

@tailwind base;
@tailwind components;
@tailwind utilities;

@layer components {
  .touch-target {
    min-height: 48px;
    min-width: 48px;
  }

  .high-contrast-text {
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
  }
}
```

(The `@import` precedes the `@tailwind` directives; CSS requires imports first, and Vite's built-in postcss-import inlines it.)

Replace `frontend/tailwind.config.js` in full with:

```js
import uiCorePreset from './src/ui-core/tailwind-preset.js';

/** @type {import('tailwindcss').Config} */
export default {
  presets: [uiCorePreset],
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {},
  },
  plugins: [],
};
```

- [ ] **Step 4: Visual smoke — branding tests plus a production build**

```bash
npx tsx --test tests/uiCoreTokensAdoption.test.ts
npm run test:unit && npm run build
```

Expected: all PASS and the build succeeds (the branding suite inside `test:unit` covers the "OSI Cloud"-free ui-core; the build proves Tailwind v3 accepts the vendored preset).

- [ ] **Step 5: Commit**

```bash
cd /home/phil/Repos/osi-server/.worktrees/agrolink
git add frontend/src/index.css frontend/tailwind.config.js frontend/tests/uiCoreTokensAdoption.test.ts
git commit -m "feat: cloud consumes ui-core tokens.css and tailwind preset"
```

---

### Task 11: Seed the GUI-parity matrix

The spec's Verification section requires `docs/superpowers/plans/agrolink-gui-parity-matrix.md` created in S0 with a dated provenance line per row (the API parity matrix went stale within a week; provenance is the countermeasure).

**Files:**
- Create: `docs/superpowers/plans/agrolink-gui-parity-matrix.md` (osi-os)

**Interfaces:**
- Consumes: edge screen inventory (`web/react-gui/src/pages/`, `src/components/`).
- Produces: the matrix file every later slice appends walkthrough evidence to.

- [ ] **Step 1: Create the matrix file**

```markdown
# AgroLink GUI parity matrix

One row per edge screen and load-bearing widget. Cloud status: `missing` /
`partial` / `parity` / `excluded`. A slice is not done while its rows lack
walkthrough evidence (side-by-side against the edge GUI on `agrolink-test-01`).
Every edit to a row updates its provenance date.

| Edge screen / widget | Edge source | Cloud status | Walkthrough evidence | Provenance |
|---|---|---|---|---|
| Login | `web/react-gui/src/pages/Login.tsx` | excluded (D6: cloud keeps Swiss-cross badge, `5280da76`) | n/a | 2026-08-04 seeded (S0) |
| Register | `web/react-gui/src/pages/Register.tsx` | excluded (cloud has its own account flow) | n/a | 2026-08-04 seeded (S0) |
| Farming dashboard | `web/react-gui/src/pages/FarmingDashboard.tsx` | missing | — | 2026-08-04 seeded (S0) |
| History dashboard | `web/react-gui/src/pages/HistoryDashboard.tsx` | partial (cloud `HistoryDashboard.tsx` is thinner) | — | 2026-08-04 seeded (S0) |
| History card detail | `web/react-gui/src/pages/HistoryCardDetailPage.tsx` | missing | — | 2026-08-04 seeded (S0) |
| Analysis route | `web/react-gui/src/pages/AnalysisRoute.tsx` | missing | — | 2026-08-04 seeded (S0) |
| Cross-zone analysis | `web/react-gui/src/pages/CrossZoneAnalysisPage.tsx` | partial (cloud page exists, depth unverified) | — | 2026-08-04 seeded (S0) |
| Field journal | `web/react-gui/src/pages/JournalPage.tsx` | partial (cloud `JournalPage.tsx` is the thin pre-v10 page) | — | 2026-08-04 seeded (S0) |
| Settings | `web/react-gui/src/pages/SettingsPage.tsx` | partial (cloud settings + S0 active-gateway switcher) | — | 2026-08-04 seeded (S0) |
| Support requests | `web/react-gui/src/pages/SupportRequests.tsx` | partial (cloud `SupportRequestsPage.tsx`) | — | 2026-08-04 seeded (S0) |
| Account link | `web/react-gui/src/pages/AccountLink.tsx` | excluded (edge-only linking flow) | n/a | 2026-08-04 seeded (S0) |
| Admin: users | `web/react-gui/src/pages/admin/UsersPage.tsx` | missing (S5) | — | 2026-08-04 seeded (S0) |
| Admin: grants | `web/react-gui/src/pages/admin/GrantsPage.tsx` | missing (S5; needs the edge grant-list route) | — | 2026-08-04 seeded (S0) |
| App header (glass chrome) | `web/react-gui/src/components/AppHeader.tsx` | missing | — | 2026-08-04 seeded (S0) |
| Gateway restart banner | `web/react-gui/src/components/GatewayRestartBanner.tsx` | missing | — | 2026-08-04 seeded (S0) |
| Scope status banner | `web/react-gui/src/components/ScopeStatusBanner.tsx` | missing (D5 port lands with S1) | — | 2026-08-04 seeded (S0) |
| Valve card (STREGA) | `web/react-gui/src/components/farming/StregaValveCard.tsx` | missing (S2) | — | 2026-08-04 seeded (S0) |
| Weather card (S2120) | `web/react-gui/src/components/farming/SenseCapWeatherCard.tsx` | missing (S2) | — | 2026-08-04 seeded (S0) |
| Dendrometer monitor | `web/react-gui/src/components/farming/DendrometerMonitor.tsx` | missing (S2/S4) | — | 2026-08-04 seeded (S0) |
| Zone / device modals | `web/react-gui/src/components/farming/CreateZoneModal.tsx`, `AddDeviceModal.tsx` | missing (S1/S2) | — | 2026-08-04 seeded (S0) |
| Journal entry table | `web/react-gui/src/components/journal/desktop/EntryTable.tsx` | missing (S3) | — | 2026-08-04 seeded (S0) |
```

- [ ] **Step 2: Commit**

```bash
cd /home/phil/Repos/osi-os/.worktrees/agrolink-parity-orchestrator-prep
git add docs/superpowers/plans/agrolink-gui-parity-matrix.md
git commit -m "docs: seed AgroLink GUI-parity matrix (S0)"
```
