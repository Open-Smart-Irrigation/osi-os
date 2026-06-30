# Agroscope AgroLink Branding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved AgroLink branding and zone-first terminology slice for the Agroscope OSI OS branch.

**Architecture:** Add one central React brand module that owns product names, fixed attribution text, locale-aware official Agroscope asset resolution, and stable labels. Keep runtime/API/database contracts unchanged while updating user-visible GUI copy, the two supported full Raspberry Pi AP scripts, and the built Node-RED GUI bundle.

**Tech Stack:** React 18, TypeScript, Vite, Vitest, Testing Library, i18next locale JSON, ImageMagick, OpenWrt profile payload files.

---

## Source Documents

- Design spec: `docs/superpowers/specs/2026-06-29-agroscope-agrolink-branding-design.md`
- Domain glossary: `CONTEXT.md`
- TypeScript overlays: `architect.yaml`, `RULES.yaml`

## File Map

- Create: `web/react-gui/src/branding/agrolink.ts`
  - Single source of truth for AgroLink brand constants and locale-aware Agroscope asset selection.
- Create: `web/react-gui/src/branding/__tests__/agrolink.test.ts`
  - Unit coverage for brand constants, supported language mapping, fallback mapping, and asset imports.
- Modify: `web/react-gui/package.json`
  - Add `src/branding/__tests__` to the Vitest unit-test allow-list so brand resolver tests run under `npm run test:unit`.
- Create: `web/react-gui/src/assets/agroscope/README.md`
  - Provenance for copied official Agroscope assets.
- Create: `web/react-gui/src/assets/agroscope/logo-{en,de,fr,it}-hoch.png`
  - Official WBF Agroscope hoch logos copied from the provided Agroscope branding package.
- Create: `web/react-gui/src/assets/agroscope/balken-horizontal-{en,de,fr,it}.png`
  - Horizontal dashboard Balken assets generated from official vertical A4 Balken assets.
- Create: `web/react-gui/src/pages/__tests__/Login.branding.test.tsx`
  - Login screen branding regression test.
- Create: `web/react-gui/tests/agrolinkBranding.test.ts`
  - Node test for source locale terminology and supported-profile SSID contracts.
- Modify: `web/react-gui/src/pages/Login.tsx`
  - Show official Agroscope hoch logo, `AgroLink`, and fixed `Powered by OSI OS`.
- Modify: `web/react-gui/src/components/DashboardHeader.tsx`
  - Show `AgroLink Dashboard` and the horizontal Balken header motif.
- Modify: `web/react-gui/src/components/__tests__/DashboardHeader.test.tsx`
  - Update expectations for AgroLink title and Balken image while preserving existing menu behavior.
- Modify: `web/react-gui/public/locales/**/{auth,dashboard,devices,history}.json`
  - Remove visible Open Smart Irrigation product copy, align dormant dashboard titles to AgroLink, and remove visible irrigation-zone wording from zone copy.
- Modify: `web/react-gui/src/pages/FarmingDashboard.tsx`
  - Rename comments from irrigation-zone language to zone language when adjacent rendered copy is updated.
- Modify: `web/react-gui/src/pages/__tests__/FarmingDashboardHeaderWiring.test.tsx`
  - Update mocked dashboard copy from `Irrigation Zones` to `Zones`.
- Modify: `web/react-gui/src/components/history/__tests__/HistoryShell.test.tsx`
  - Update mocked no-zones history copy to say `zone`.
- Modify: `web/react-gui/src/components/history/__tests__/HistoryMobileOverview.test.tsx`
  - Update mocked no-zones history copy to say `zone`.
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/99_config_chirpstack_ap`
  - Change supported Pi 5 AP SSID to `AgroLink-${GWID_END}`.
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_config_chirpstack_ap`
  - Change supported Pi 4 AP SSID to `AgroLink-${GWID_END}` and keep byte parity with Pi 5 file.
- Modify: `feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/`
  - Refresh from `web/react-gui/build/` after the React build.

## Code Quality Notes

- DRY/SoC: keep brand decisions in `web/react-gui/src/branding/agrolink.ts`; do not repeat product strings or asset locale mapping inside page components.
- YAGNI: do not introduce build-time variants, white-label abstractions, profile registries, or API/database renames.
- Repo contracts: preserve `IrrigationZone` TypeScript names, `/api/irrigation-zones`, `irrigation_zone_id`, sync aggregates, and `OSI Server` service labels.
- Verification risk: `verify-sync-flow.js` is broad regression coverage, but SSID content needs explicit `rg` and `cmp` checks.

---

### Task 1: Brand Assets And Resolver

**Files:**
- Create: `web/react-gui/src/branding/__tests__/agrolink.test.ts`
- Create: `web/react-gui/src/branding/agrolink.ts`
- Modify: `web/react-gui/package.json`
- Create: `web/react-gui/src/assets/agroscope/README.md`
- Create: `web/react-gui/src/assets/agroscope/logo-en-hoch.png`
- Create: `web/react-gui/src/assets/agroscope/logo-de-hoch.png`
- Create: `web/react-gui/src/assets/agroscope/logo-fr-hoch.png`
- Create: `web/react-gui/src/assets/agroscope/logo-it-hoch.png`
- Create: `web/react-gui/src/assets/agroscope/balken-horizontal-en.png`
- Create: `web/react-gui/src/assets/agroscope/balken-horizontal-de.png`
- Create: `web/react-gui/src/assets/agroscope/balken-horizontal-fr.png`
- Create: `web/react-gui/src/assets/agroscope/balken-horizontal-it.png`

- [ ] **Step 1: Write the failing brand resolver test**

Create `web/react-gui/src/branding/__tests__/agrolink.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  AGROLINK_BRAND,
  resolveAgroscopeAssetLocale,
  resolveAgroscopeAssets,
} from '../agrolink';

function basename(src: string): string {
  return src.split('/').pop() ?? src;
}

describe('AgroLink brand config', () => {
  it('exposes approved product copy', () => {
    expect(AGROLINK_BRAND.productName).toBe('AgroLink');
    expect(AGROLINK_BRAND.dashboardTitle).toBe('AgroLink Dashboard');
    expect(AGROLINK_BRAND.loginSubtitle).toBe('Powered by OSI OS');
    expect(AGROLINK_BRAND.ssidPrefix).toBe('AgroLink');
    expect(AGROLINK_BRAND.zoneLabel).toBe('Zone');
    expect(AGROLINK_BRAND.zonesLabel).toBe('Zones');
  });

  it('maps supported GUI languages to official Agroscope asset locales', () => {
    expect(resolveAgroscopeAssetLocale('en')).toBe('en');
    expect(resolveAgroscopeAssetLocale('de-CH')).toBe('de');
    expect(resolveAgroscopeAssetLocale('de')).toBe('de');
    expect(resolveAgroscopeAssetLocale('fr')).toBe('fr');
    expect(resolveAgroscopeAssetLocale('it')).toBe('it');
  });

  it('falls back to English assets for unsupported or missing languages', () => {
    expect(resolveAgroscopeAssetLocale('es')).toBe('en');
    expect(resolveAgroscopeAssetLocale('pt')).toBe('en');
    expect(resolveAgroscopeAssetLocale('lg')).toBe('en');
    expect(resolveAgroscopeAssetLocale(undefined)).toBe('en');
    expect(resolveAgroscopeAssetLocale(null)).toBe('en');
  });

  it('returns imported logo and horizontal Balken assets', () => {
    expect(basename(resolveAgroscopeAssets('en').logoHoch)).toContain('logo-en-hoch');
    expect(basename(resolveAgroscopeAssets('de-CH').logoHoch)).toContain('logo-de-hoch');
    expect(basename(resolveAgroscopeAssets('fr').logoHoch)).toContain('logo-fr-hoch');
    expect(basename(resolveAgroscopeAssets('it').logoHoch)).toContain('logo-it-hoch');
    expect(basename(resolveAgroscopeAssets('es').balkenHorizontal)).toContain('balken-horizontal-en');
  });
});
```

- [ ] **Step 2: Run the brand resolver test to verify it fails**

Run:

```bash
cd web/react-gui
./node_modules/.bin/vitest run src/branding/__tests__/agrolink.test.ts
```

Expected: FAIL because `../agrolink` does not exist.

- [ ] **Step 3: Copy and generate official Agroscope assets**

Run from the repo root:

```bash
mkdir -p web/react-gui/src/assets/agroscope
export AGROSCOPE_BRAND_ASSET_DIR=/path/to/official/agroscope/logo-folder

cp "$AGROSCOPE_BRAND_ASSET_DIR/96447-WBF_agroscope_e_rgb_pos_hoch.png" \
  web/react-gui/src/assets/agroscope/logo-en-hoch.png
cp "$AGROSCOPE_BRAND_ASSET_DIR/96443-WBF_agroscope_d_rgb_pos_hoch.png" \
  web/react-gui/src/assets/agroscope/logo-de-hoch.png
cp "$AGROSCOPE_BRAND_ASSET_DIR/96451-WBF_agroscope_f_rgb_pos_hoch.png" \
  web/react-gui/src/assets/agroscope/logo-fr-hoch.png
cp "$AGROSCOPE_BRAND_ASSET_DIR/96455-WBF_agroscope_i_rgb_pos_hoch.png" \
  web/react-gui/src/assets/agroscope/logo-it-hoch.png

magick "$AGROSCOPE_BRAND_ASSET_DIR/96432-A_Balken_A4_en.png" -rotate 90 \
  web/react-gui/src/assets/agroscope/balken-horizontal-en.png
magick "$AGROSCOPE_BRAND_ASSET_DIR/96457-A_Balken_A4_de.png" -rotate 90 \
  web/react-gui/src/assets/agroscope/balken-horizontal-de.png
magick "$AGROSCOPE_BRAND_ASSET_DIR/96433-A_Balken_A4_fr.png" -rotate 90 \
  web/react-gui/src/assets/agroscope/balken-horizontal-fr.png
magick "$AGROSCOPE_BRAND_ASSET_DIR/96434-A_Balken_A4_it.png" -rotate 90 \
  web/react-gui/src/assets/agroscope/balken-horizontal-it.png

identify -format '%f %wx%h\n' web/react-gui/src/assets/agroscope/*.png
```

Expected: four hoch logos with their source dimensions and four Balken files at `3508x118`.

- [ ] **Step 4: Add asset provenance README**

Create `web/react-gui/src/assets/agroscope/README.md`:

```md
# Agroscope Assets

These assets are copied from the official Agroscope branding package provided
outside this repository.

Login hoch logos:

- `logo-en-hoch.png` from `96447-WBF_agroscope_e_rgb_pos_hoch.png`
- `logo-de-hoch.png` from `96443-WBF_agroscope_d_rgb_pos_hoch.png`
- `logo-fr-hoch.png` from `96451-WBF_agroscope_f_rgb_pos_hoch.png`
- `logo-it-hoch.png` from `96455-WBF_agroscope_i_rgb_pos_hoch.png`

Dashboard Balken assets:

- `balken-horizontal-en.png` from `96432-A_Balken_A4_en.png`, rotated 90 degrees
- `balken-horizontal-de.png` from `96457-A_Balken_A4_de.png`, rotated 90 degrees
- `balken-horizontal-fr.png` from `96433-A_Balken_A4_fr.png`, rotated 90 degrees
- `balken-horizontal-it.png` from `96434-A_Balken_A4_it.png`, rotated 90 degrees

Do not replace these with approximated logos or hand-drawn bars.
```

- [ ] **Step 5: Create the brand resolver module**

Create `web/react-gui/src/branding/agrolink.ts`:

```ts
import logoDeHoch from '../assets/agroscope/logo-de-hoch.png';
import logoEnHoch from '../assets/agroscope/logo-en-hoch.png';
import logoFrHoch from '../assets/agroscope/logo-fr-hoch.png';
import logoItHoch from '../assets/agroscope/logo-it-hoch.png';
import balkenHorizontalDe from '../assets/agroscope/balken-horizontal-de.png';
import balkenHorizontalEn from '../assets/agroscope/balken-horizontal-en.png';
import balkenHorizontalFr from '../assets/agroscope/balken-horizontal-fr.png';
import balkenHorizontalIt from '../assets/agroscope/balken-horizontal-it.png';

export type AgroscopeAssetLocale = 'en' | 'de' | 'fr' | 'it';

export interface AgroscopeBrandAssets {
  locale: AgroscopeAssetLocale;
  logoHoch: string;
  balkenHorizontal: string;
}

export const AGROLINK_BRAND = {
  productName: 'AgroLink',
  dashboardTitle: 'AgroLink Dashboard',
  loginSubtitle: 'Powered by OSI OS',
  ssidPrefix: 'AgroLink',
  zoneLabel: 'Zone',
  zonesLabel: 'Zones',
  colors: {
    agroscopeRed: '#E30613',
    agroscopeBlack: '#040404',
  },
} as const;

const AGROSCOPE_ASSETS: Record<AgroscopeAssetLocale, AgroscopeBrandAssets> = {
  en: {
    locale: 'en',
    logoHoch: logoEnHoch,
    balkenHorizontal: balkenHorizontalEn,
  },
  de: {
    locale: 'de',
    logoHoch: logoDeHoch,
    balkenHorizontal: balkenHorizontalDe,
  },
  fr: {
    locale: 'fr',
    logoHoch: logoFrHoch,
    balkenHorizontal: balkenHorizontalFr,
  },
  it: {
    locale: 'it',
    logoHoch: logoItHoch,
    balkenHorizontal: balkenHorizontalIt,
  },
};

export function resolveAgroscopeAssetLocale(language?: string | null): AgroscopeAssetLocale {
  const normalized = String(language ?? '').trim().toLowerCase();

  if (normalized.startsWith('de')) return 'de';
  if (normalized.startsWith('fr')) return 'fr';
  if (normalized.startsWith('it')) return 'it';

  return 'en';
}

export function resolveAgroscopeAssets(language?: string | null): AgroscopeBrandAssets {
  return AGROSCOPE_ASSETS[resolveAgroscopeAssetLocale(language)];
}
```

- [ ] **Step 6: Run the brand resolver test to verify it passes**

Run:

```bash
cd web/react-gui
./node_modules/.bin/vitest run src/branding/__tests__/agrolink.test.ts
```

Expected: PASS.

- [ ] **Step 7: Add brand resolver tests to the suite gate**

In `web/react-gui/package.json`, replace:

```json
"test:unit:vitest": "vitest run src/analysis/__tests__ src/components/analysis/__tests__ src/components/farming/__tests__ src/components/history/__tests__ src/components/__tests__ src/pages/__tests__ src/utils/__tests__ src/channels/__tests__ --passWithNoTests"
```

with:

```json
"test:unit:vitest": "vitest run src/analysis/__tests__ src/components/analysis/__tests__ src/components/farming/__tests__ src/components/history/__tests__ src/components/__tests__ src/pages/__tests__ src/utils/__tests__ src/channels/__tests__ src/branding/__tests__ --passWithNoTests"
```

- [ ] **Step 8: Run the Vitest unit suite gate to verify branding tests are included**

Run:

```bash
cd web/react-gui
npm run test:unit:vitest
```

Expected: PASS. The command now includes `src/branding/__tests__` in the allow-list, so `agrolink.test.ts` runs under the same gate used by `npm run test:unit`.

- [ ] **Step 9: Commit the brand assets, resolver, and suite gate**

Run:

```bash
git add web/react-gui/src/branding/agrolink.ts \
  web/react-gui/src/branding/__tests__/agrolink.test.ts \
  web/react-gui/package.json \
  web/react-gui/src/assets/agroscope
git commit -m "feat: add AgroLink brand assets"
```

---

### Task 2: Login Branding

**Files:**
- Create: `web/react-gui/src/pages/__tests__/Login.branding.test.tsx`
- Modify: `web/react-gui/src/pages/Login.tsx`

- [ ] **Step 1: Write the failing login branding test**

Create `web/react-gui/src/pages/__tests__/Login.branding.test.tsx`:

```tsx
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Login } from '../Login';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    login: vi.fn(),
  }),
}));

vi.mock('../../components/LanguageSwitcher', () => ({
  LanguageSwitcher: () => <div aria-label="language switcher" />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string) => {
      const map: Record<string, string> = {
        'login.subtitle': 'translated login subtitle',
        'login.username': 'Username',
        'login.usernamePlaceholder': 'Enter your username',
        'login.password': 'Password',
        'login.passwordPlaceholder': 'Enter your password',
        'login.signIn': 'Sign In',
        'login.signingIn': 'Signing In...',
        'login.noAccount': 'No account? Register here',
        'login.failed': 'Login failed. Please check your credentials.',
      };
      return map[key] ?? key;
    },
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Login AgroLink branding', () => {
  it('renders the official Agroscope logo, AgroLink title, and fixed OSI OS attribution', () => {
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    expect(screen.getByRole('img', { name: 'Agroscope' })).toHaveAttribute(
      'src',
      expect.stringContaining('logo-en-hoch'),
    );
    expect(screen.getByRole('heading', { name: 'AgroLink' })).toBeInTheDocument();
    expect(screen.getByText('Powered by OSI OS')).toBeInTheDocument();
    expect(screen.queryByText('translated login subtitle')).not.toBeInTheDocument();
    expect(screen.queryByText(/OSI OS v0\.6\.5/)).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the login branding test to verify it fails**

Run:

```bash
cd web/react-gui
./node_modules/.bin/vitest run src/pages/__tests__/Login.branding.test.tsx
```

Expected: FAIL because the current login screen still renders the OSI logo, `OSI OS v0.6.5 (Alpha)`, and translated `login.subtitle`.

- [ ] **Step 3: Update `Login.tsx` imports and translation hook**

In `web/react-gui/src/pages/Login.tsx`, remove:

```ts
import osiLogo from '../assets/osi_logo.png';
```

Add:

```ts
import { AGROLINK_BRAND, resolveAgroscopeAssets } from '../branding/agrolink';
```

Change:

```ts
const { t } = useTranslation('auth');
```

to:

```ts
const { t, i18n } = useTranslation('auth');
const { logoHoch } = resolveAgroscopeAssets(i18n.language);
```

- [ ] **Step 4: Replace the login brand block**

In `web/react-gui/src/pages/Login.tsx`, replace the current logo/title/subtitle block:

```tsx
<div className="text-center mb-5">
  <img src={osiLogo} alt="OSI OS Logo" className="mx-auto mb-4 h-14 w-14" />
  <h1 className="text-3xl font-bold text-[var(--text)] mb-2 high-contrast-text">
    OSI OS v0.6.5 (Alpha)
  </h1>
  <p className="text-[var(--text-secondary)] text-base">{t('login.subtitle')}</p>
</div>
```

with:

```tsx
<div className="text-center mb-5">
  <img
    src={logoHoch}
    alt="Agroscope"
    className="mx-auto mb-5 h-24 w-auto max-w-full object-contain"
  />
  <h1 className="text-3xl font-bold text-[var(--text)] mb-2 high-contrast-text">
    {AGROLINK_BRAND.productName}
  </h1>
  <p className="text-[var(--text-secondary)] text-base">{AGROLINK_BRAND.loginSubtitle}</p>
</div>
```

- [ ] **Step 5: Run the login branding test to verify it passes**

Run:

```bash
cd web/react-gui
./node_modules/.bin/vitest run src/pages/__tests__/Login.branding.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit the login branding change**

Run:

```bash
git add web/react-gui/src/pages/Login.tsx web/react-gui/src/pages/__tests__/Login.branding.test.tsx
git commit -m "feat: brand AgroLink login"
```

---

### Task 3: Dashboard Header Branding

**Files:**
- Modify: `web/react-gui/src/components/DashboardHeader.tsx`
- Modify: `web/react-gui/src/components/__tests__/DashboardHeader.test.tsx`

- [ ] **Step 1: Update the dashboard header test expectations first**

In `web/react-gui/src/components/__tests__/DashboardHeader.test.tsx`, update the `react-i18next` mock to include `i18n.language`:

```tsx
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, options?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        add: 'Add',
        'addMenu.zone': 'Zone',
        'addMenu.device': 'Device',
        data: 'Data',
        account: 'Account',
        'accountMenu.osiServer': 'OSI Server',
        logout: 'Logout',
      };
      if (key === 'welcome') return `Welcome ${String(options?.username ?? '')}`;
      return map[key] ?? key;
    },
  }),
}));
```

Replace the first test with:

```tsx
it('renders the AgroLink title, Agroscope Balken, welcome text, and language switcher', () => {
  renderHeader();
  expect(screen.getByRole('heading', { name: 'AgroLink Dashboard' })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: 'Agroscope Balken' })).toHaveAttribute(
    'src',
    expect.stringContaining('balken-horizontal-en'),
  );
  expect(screen.getByText('Welcome farmer')).toBeInTheDocument();
  expect(screen.getByLabelText('language switcher')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the dashboard header test to verify it fails**

Run:

```bash
cd web/react-gui
./node_modules/.bin/vitest run src/components/__tests__/DashboardHeader.test.tsx
```

Expected: FAIL because the current header still renders `OSI OS Dashboard` and no Balken image.

- [ ] **Step 3: Update `DashboardHeader.tsx` imports and translation hook**

In `web/react-gui/src/components/DashboardHeader.tsx`, add:

```ts
import { AGROLINK_BRAND, resolveAgroscopeAssets } from '../branding/agrolink';
```

Change:

```ts
const { t } = useTranslation('dashboard');
const showDesktopData = isDesktopBrowser();
```

to:

```ts
const { t, i18n } = useTranslation('dashboard');
const { balkenHorizontal } = resolveAgroscopeAssets(i18n.language);
const showDesktopData = isDesktopBrowser();
```

- [ ] **Step 4: Replace the header opening structure and title**

In `web/react-gui/src/components/DashboardHeader.tsx`, replace:

```tsx
<header className="bg-[var(--header-bg)] shadow-xl">
  <div className="max-w-7xl mx-auto px-4 py-6">
```

with:

```tsx
<header className="bg-[var(--header-bg)] shadow-xl overflow-hidden">
  <img
    src={balkenHorizontal}
    alt="Agroscope Balken"
    className="block h-10 w-full object-cover object-left"
  />
  <div className="max-w-7xl mx-auto px-4 py-6">
```

Replace:

```tsx
OSI OS Dashboard
```

with:

```tsx
{AGROLINK_BRAND.dashboardTitle}
```

- [ ] **Step 5: Run the dashboard header test to verify it passes**

Run:

```bash
cd web/react-gui
./node_modules/.bin/vitest run src/components/__tests__/DashboardHeader.test.tsx
```

Expected: PASS.

- [ ] **Step 6: Commit the dashboard header branding change**

Run:

```bash
git add web/react-gui/src/components/DashboardHeader.tsx \
  web/react-gui/src/components/__tests__/DashboardHeader.test.tsx
git commit -m "feat: brand AgroLink dashboard header"
```

---

### Task 4: Zone Terminology And Supported SSID Contracts

**Files:**
- Create: `web/react-gui/tests/agrolinkBranding.test.ts`
- Modify: `web/react-gui/public/locales/{en,de-CH,fr,it,es,pt,lg}/auth.json`
- Modify: `web/react-gui/public/locales/{en,de-CH,fr,it,es,pt,lg}/dashboard.json`
- Modify: `web/react-gui/public/locales/{en,de-CH,fr,it}/devices.json`
- Modify: `web/react-gui/public/locales/{en,de-CH,fr,it,es,pt,lg}/history.json`
- Modify: `web/react-gui/src/pages/FarmingDashboard.tsx`
- Modify: `web/react-gui/src/pages/__tests__/FarmingDashboardHeaderWiring.test.tsx`
- Modify: `web/react-gui/src/components/history/__tests__/HistoryShell.test.tsx`
- Modify: `web/react-gui/src/components/history/__tests__/HistoryMobileOverview.test.tsx`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/99_config_chirpstack_ap`
- Modify: `conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_config_chirpstack_ap`

- [ ] **Step 1: Write the failing cross-surface branding contract test**

Create `web/react-gui/tests/agrolinkBranding.test.ts`:

```ts
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const reactRoot = path.resolve(testDir, '..');
const repoRoot = path.resolve(reactRoot, '..', '..');

function readText(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readReactJson(relativePath: string): any {
  return JSON.parse(fs.readFileSync(path.join(reactRoot, relativePath), 'utf8'));
}

function listJsonFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return listJsonFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.json') ? [fullPath] : [];
  });
}

describe('AgroLink branding source contracts', () => {
  it('uses AgroLink auth copy in supported brand languages', () => {
    const expectedRegisterSubtitles: Record<string, string> = {
      en: 'Register for AgroLink',
      'de-CH': 'Für AgroLink registrieren',
      fr: "S'inscrire à AgroLink",
      it: 'Registrati ad AgroLink',
      es: 'Regístrate en AgroLink',
      pt: 'Registe-se no AgroLink',
      lg: 'Wandiika mu AgroLink',
    };

    for (const [locale, registerSubtitle] of Object.entries(expectedRegisterSubtitles)) {
      const auth = readReactJson(`public/locales/${locale}/auth.json`);
      assert.equal(auth.login.title, 'AgroLink', `${locale} login title`);
      assert.equal(auth.register.subtitle, registerSubtitle, `${locale} register subtitle`);
    }
  });

  it('does not leave Open Smart Irrigation product copy in locale resources', () => {
    const localeRoot = path.join(reactRoot, 'public', 'locales');
    const offenders = listJsonFiles(localeRoot).filter((filePath) => (
      /open smart irrigation/i.test(fs.readFileSync(filePath, 'utf8'))
    ));

    assert.deepEqual(offenders.map((filePath) => path.relative(reactRoot, filePath)), []);
  });

  it('keeps dormant dashboard title keys aligned with the brand module', () => {
    for (const locale of ['en', 'de-CH', 'fr', 'it', 'es', 'pt', 'lg']) {
      const dashboard = readReactJson(`public/locales/${locale}/dashboard.json`);
      assert.equal(dashboard.title, 'AgroLink Dashboard', `${locale} dashboard title`);
    }
  });

  it('keeps user-visible locale copy on zone terminology', () => {
    const localeRoot = path.join(reactRoot, 'public', 'locales');
    const forbidden = [
      /irrigation zone/i,
      /irrigation zones/i,
      /bewässerungszone/i,
      /bewässerungszonen/i,
      /zone d'irrigation/i,
      /zones d'irrigation/i,
      /zona di irrigazione/i,
      /zone di irrigazione/i,
    ];

    const offenders = listJsonFiles(localeRoot).flatMap((filePath) => {
      const text = fs.readFileSync(filePath, 'utf8');
      return forbidden
        .filter((pattern) => pattern.test(text))
        .map((pattern) => `${path.relative(reactRoot, filePath)} matches ${pattern}`);
    });

    assert.deepEqual(offenders, []);
  });

  it('sets the AgroLink SSID only on supported full Raspberry Pi profiles', () => {
    const pi5Ap = 'conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/99_config_chirpstack_ap';
    const pi4Ap = 'conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_config_chirpstack_ap';
    const unsupportedPi1Ap = 'conf/full_raspberrypi_bcm27xx_bcm2708/files/etc/uci-defaults/99_config_chirpstack_ap';
    const expectedLine = 'set wireless.default_radio0.ssid="AgroLink-${GWID_END}"';

    assert.ok(readText(pi5Ap).includes(expectedLine), 'Pi 5 AP script uses AgroLink SSID');
    assert.ok(readText(pi4Ap).includes(expectedLine), 'Pi 4 AP script uses AgroLink SSID');
    assert.equal(readText(pi4Ap), readText(pi5Ap), 'supported Pi 4/Pi 5 AP scripts must match');
    assert.doesNotMatch(readText(unsupportedPi1Ap), /AgroLink/);
  });
});
```

- [ ] **Step 2: Run the contract test to verify it fails**

Run:

```bash
cd web/react-gui
./node_modules/.bin/tsx --test tests/agrolinkBranding.test.ts
```

Expected: FAIL because auth/dashboard locale copy still says Open Smart Irrigation, visible locale copy still contains irrigation-zone phrases, dormant dashboard title keys are not aligned to AgroLink, and supported AP scripts still use `OSI-OS-${GWID_END}`.

- [ ] **Step 3: Update auth locale product copy**

Set these exact keys in the source locale files:

```json
// web/react-gui/public/locales/en/auth.json
"login": {
  "title": "AgroLink"
},
"register": {
  "subtitle": "Register for AgroLink"
}

// web/react-gui/public/locales/de-CH/auth.json
"login": {
  "title": "AgroLink"
},
"register": {
  "subtitle": "Für AgroLink registrieren"
}

// web/react-gui/public/locales/fr/auth.json
"login": {
  "title": "AgroLink"
},
"register": {
  "subtitle": "S'inscrire à AgroLink"
}

// web/react-gui/public/locales/it/auth.json
"login": {
  "title": "AgroLink"
},
"register": {
  "subtitle": "Registrati ad AgroLink"
}

// web/react-gui/public/locales/es/auth.json
"login": {
  "title": "AgroLink"
},
"register": {
  "subtitle": "Regístrate en AgroLink"
}

// web/react-gui/public/locales/pt/auth.json
"login": {
  "title": "AgroLink"
},
"register": {
  "subtitle": "Registe-se no AgroLink"
}

// web/react-gui/public/locales/lg/auth.json
"login": {
  "title": "AgroLink"
},
"register": {
  "subtitle": "Wandiika mu AgroLink"
}
```

Do not change login input labels, register button labels, password validation messages, or `accountLink` OSI Server copy.

- [ ] **Step 4: Update dashboard product and zone copy**

In each of these files, set the top-level `title` to `AgroLink Dashboard`:

```text
web/react-gui/public/locales/en/dashboard.json
web/react-gui/public/locales/de-CH/dashboard.json
web/react-gui/public/locales/fr/dashboard.json
web/react-gui/public/locales/it/dashboard.json
web/react-gui/public/locales/es/dashboard.json
web/react-gui/public/locales/pt/dashboard.json
web/react-gui/public/locales/lg/dashboard.json
```

Also set these exact rendered zone keys in the source dashboard locale files:

Set these exact rendered zone keys in source dashboard locale files:

```json
// web/react-gui/public/locales/en/dashboard.json
"emptyState": {
  "subtitle": "Get started by creating a zone and adding devices"
},
"irrigationZones": "Zones",
"unassignedSubtitle": "These devices are not assigned to any zone"

// web/react-gui/public/locales/de-CH/dashboard.json
"emptyState": {
  "subtitle": "Erstellen Sie eine Zone und fügen Sie Geräte hinzu"
},
"irrigationZones": "Zonen",
"unassignedSubtitle": "Diese Geräte sind keiner Zone zugewiesen"

// web/react-gui/public/locales/fr/dashboard.json
"emptyState": {
  "subtitle": "Commencez par créer une zone et ajouter des appareils"
},
"irrigationZones": "Zones",
"unassignedSubtitle": "Ces appareils ne sont assignés à aucune zone"

// web/react-gui/public/locales/it/dashboard.json
"emptyState": {
  "subtitle": "Inizia creando una zona e aggiungendo dispositivi"
},
"irrigationZones": "Zone",
"unassignedSubtitle": "Questi dispositivi non sono assegnati a nessuna zona"
```

The rendered dashboard title still comes from `AGROLINK_BRAND.dashboardTitle`. The dormant `dashboard.title` keys are aligned so stale product copy does not survive in locale resources.

- [ ] **Step 5: Update create-zone modal titles**

Set these exact keys in source devices locale files:

```json
// web/react-gui/public/locales/en/devices.json
"createZoneModal": {
  "title": "Create Zone"
}

// web/react-gui/public/locales/de-CH/devices.json
"createZoneModal": {
  "title": "Zone erstellen"
}

// web/react-gui/public/locales/fr/devices.json
"createZoneModal": {
  "title": "Créer une zone"
}

// web/react-gui/public/locales/it/devices.json
"createZoneModal": {
  "title": "Crea zona"
}

// web/react-gui/public/locales/es/devices.json
"createZoneModal": {
  "title": "Crear zona"
}

// web/react-gui/public/locales/pt/devices.json
"createZoneModal": {
  "title": "Criar zona"
}

// web/react-gui/public/locales/lg/devices.json
"createZoneModal": {
  "title": "Tondawo Ekifo"
}
```

- [ ] **Step 6: Update history no-zones fallback copy**

In each of these files, set `history.shell.noZonesBody` to localized zone-first copy:

```text
web/react-gui/public/locales/en/history.json
web/react-gui/public/locales/de-CH/history.json
web/react-gui/public/locales/fr/history.json
web/react-gui/public/locales/it/history.json
web/react-gui/public/locales/es/history.json
web/react-gui/public/locales/pt/history.json
web/react-gui/public/locales/lg/history.json
```

- [ ] **Step 7: Update source test fixtures and comments**

In `web/react-gui/src/pages/__tests__/FarmingDashboardHeaderWiring.test.tsx`, change the mocked translation:

```ts
irrigationZones: 'Zones',
```

In `web/react-gui/src/components/history/__tests__/HistoryShell.test.tsx`, change:

```ts
'history.shell.noZonesBody': 'Create a zone from the legacy dashboard before opening thematic history.',
```

In `web/react-gui/src/components/history/__tests__/HistoryMobileOverview.test.tsx`, change:

```ts
'history.shell.noZonesBody': 'Create a zone from the legacy dashboard before opening thematic history.',
```

In `web/react-gui/src/pages/FarmingDashboard.tsx`, update only comments:

```tsx
{/* Zones Section */}
```

Do not rename `IrrigationZoneCard`, `IrrigationZone` types, `irrigationZonesAPI`, API routes, or database-facing fields.

- [ ] **Step 8: Update supported AP scripts**

In both files:

```text
conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/99_config_chirpstack_ap
conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_config_chirpstack_ap
```

replace:

```sh
set wireless.default_radio0.ssid="OSI-OS-${GWID_END}"
```

with:

```sh
set wireless.default_radio0.ssid="AgroLink-${GWID_END}"
```

Do not edit:

```text
conf/full_raspberrypi_bcm27xx_bcm2708/files/etc/uci-defaults/99_config_chirpstack_ap
conf/base_raspberrypi_bcm27xx_bcm2708/files/etc/uci-defaults/99_config_chirpstack_ap
conf/base_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_config_chirpstack_ap
conf/base_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/99_config_chirpstack_ap
conf/rak_rak7391/files/etc/uci-defaults/99_config_chirpstack_ap
```

- [ ] **Step 9: Run focused contract verification**

Run:

```bash
cd web/react-gui
./node_modules/.bin/tsx --test tests/agrolinkBranding.test.ts
```

Expected: PASS.

- [ ] **Step 10: Run focused source grep checks**

Run from the repo root:

```bash
rg -n "irrigation zone|irrigation zones|Irrigation Zone|Irrigation Zones|Bewässerungszone|Bewässerungszonen|zone d'irrigation|zones d'irrigation|zona di irrigazione|zone di irrigazione" \
  web/react-gui/public/locales web/react-gui/src/pages web/react-gui/src/components

rg -n "Open Smart Irrigation|Open Smart irrigation" \
  web/react-gui/public/locales

rg -n 'set wireless\.default_radio0\.ssid="AgroLink-\$\{GWID_END\}"' \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/99_config_chirpstack_ap \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_config_chirpstack_ap

cmp -s \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/99_config_chirpstack_ap \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_config_chirpstack_ap
```

Expected:

- First `rg`: no output and exit code `1`; this means no matching visible forbidden zone terminology remains in the scanned source paths.
- Second `rg`: no output and exit code `1`; this means no stale Open Smart Irrigation product copy remains in source locale resources.
- Third `rg`: two matching SSID lines, one for each supported profile.
- `cmp`: exit code `0`.

- [ ] **Step 11: Commit terminology and SSID contracts**

Run:

```bash
git add web/react-gui/tests/agrolinkBranding.test.ts \
  web/react-gui/public/locales \
  web/react-gui/src/pages/FarmingDashboard.tsx \
  web/react-gui/src/pages/__tests__/FarmingDashboardHeaderWiring.test.tsx \
  web/react-gui/src/components/history/__tests__/HistoryShell.test.tsx \
  web/react-gui/src/components/history/__tests__/HistoryMobileOverview.test.tsx \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/99_config_chirpstack_ap \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_config_chirpstack_ap
git commit -m "feat: update AgroLink terminology and SSID"
```

---

### Task 5: Full React Verification And Firmware GUI Bundle Promotion

**Files:**
- Modify: `feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/`

- [ ] **Step 1: Run the complete frontend unit suite**

Run:

```bash
cd web/react-gui
npm run test:unit
```

Expected: PASS. This includes the new `tests/agrolinkBranding.test.ts`, brand resolver test, login branding test, and updated dashboard header test.

- [ ] **Step 2: Build the React GUI**

Run:

```bash
cd web/react-gui
npm run build
```

Expected: PASS and Vite writes the production build to `web/react-gui/build/`.

- [ ] **Step 3: Promote the built GUI into the Node-RED feed bundle**

Run from the repo root:

```bash
rsync -a --delete web/react-gui/build/ feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/
diff -qr web/react-gui/build feeds/chirpstack-openwrt-feed/apps/node-red/files/gui
```

Expected: `diff -qr` prints no output and exits `0`.

- [ ] **Step 4: Verify built/feed locale and asset content**

Run from the repo root:

```bash
rg -n "AgroLink|Powered by OSI OS|Create a zone|Zones|Agroscope" \
  feeds/chirpstack-openwrt-feed/apps/node-red/files/gui

rg -n "irrigation zone|irrigation zones|Irrigation Zone|Irrigation Zones|Bewässerungszone|Bewässerungszonen|zone d'irrigation|zones d'irrigation|zona di irrigazione|zone di irrigazione" \
  feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/locales

rg -n "Open Smart Irrigation|Open Smart irrigation" \
  feeds/chirpstack-openwrt-feed/apps/node-red/files/gui/locales
```

Expected:

- First `rg`: finds AgroLink/zone branding in built assets or copied locales.
- Second `rg`: no output and exit code `1`.
- Third `rg`: no output and exit code `1`.

- [ ] **Step 5: Run profile and sync regression verification**

Run from the repo root:

```bash
rg -n 'set wireless\.default_radio0\.ssid="AgroLink-\$\{GWID_END\}"' \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/99_config_chirpstack_ap \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_config_chirpstack_ap

cmp -s \
  conf/full_raspberrypi_bcm27xx_bcm2712/files/etc/uci-defaults/99_config_chirpstack_ap \
  conf/full_raspberrypi_bcm27xx_bcm2709/files/etc/uci-defaults/99_config_chirpstack_ap

node scripts/verify-profile-parity.js
node scripts/verify-sync-flow.js
git diff --check
```

Expected:

- `rg`: two matching SSID lines.
- `cmp`: exit code `0`.
- `verify-profile-parity.js`: ends with `All parity checks passed.`
- `verify-sync-flow.js`: prints `Sync flow verification passed` and exits `0`. In the current repo it also chains profile parity, but the success condition for this command is the sync-flow line plus exit code `0`; `verify-profile-parity.js` is checked explicitly above for the parity line.
- `git diff --check`: no output and exit code `0`.

- [ ] **Step 6: Confirm `web/react-gui/build/` is not staged**

Run:

```bash
git status --short
```

Expected: feed bundle files may be modified, but `web/react-gui/build/` should not appear because it is build output.

- [ ] **Step 7: Commit the promoted feed bundle**

Run:

```bash
git add feeds/chirpstack-openwrt-feed/apps/node-red/files/gui
git commit -m "build: promote AgroLink GUI bundle"
```

---

### Task 6: Final Review

**Files:**
- Review all changed files from Tasks 1-5.

- [ ] **Step 1: Inspect final branch state**

Run:

```bash
git status --short --branch
git log --oneline --decorate -8
```

Expected: branch is ahead of `origin/main`; no unstaged or untracked implementation files remain.

- [ ] **Step 2: Inspect final diff against `origin/main`**

Run:

```bash
git diff --stat origin/main...HEAD
git diff --name-only origin/main...HEAD
```

Expected implementation changed areas:

- `docs/superpowers/plans/2026-06-29-agroscope-agrolink-branding.md`
- `web/react-gui/package.json`
- `web/react-gui/src/branding/`
- `web/react-gui/src/assets/agroscope/`
- `web/react-gui/src/pages/Login.tsx`
- `web/react-gui/src/components/DashboardHeader.tsx`
- focused tests and locale files
- supported Pi 4/Pi 5 AP scripts
- feed GUI bundle

Previously committed design artifacts such as `CONTEXT.md` and
`docs/superpowers/specs/2026-06-29-agroscope-agrolink-branding-design.md` may
still appear in `origin/main...HEAD`; implementation tasks should not edit them
unless a new review finding requires a spec correction.

- [ ] **Step 3: Run final verification bundle once**

Run:

```bash
cd web/react-gui
npm run test:unit
npm run build
cd ../..
diff -qr web/react-gui/build feeds/chirpstack-openwrt-feed/apps/node-red/files/gui
node scripts/verify-profile-parity.js
node scripts/verify-sync-flow.js
git diff --check
```

Expected: all commands pass; `diff -qr` prints no output.

- [ ] **Step 4: Prepare closeout summary**

Summarize:

- Brand module and official Agroscope asset mapping added.
- Login shows official hoch logo, `AgroLink`, and fixed `Powered by OSI OS`.
- Dashboard header shows `AgroLink Dashboard` with horizontal official Balken asset.
- User-visible copy uses `Zone/Zones` instead of irrigation-zone wording.
- Supported Pi 4/Pi 5 AP scripts use `AgroLink-${GWID_END}` and remain byte-identical.
- Feed GUI bundle was rebuilt from `web/react-gui/build/` and promoted.
- Verification commands passed.
