# SWT water-status colors implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show VIA Chameleon Wet, Moist, or Dry color status for every current SWT reading on KIWI, SDI-12 Tensiomark, LSN50 Chameleon, and Water cards.

**Architecture:** A pure `utils/swt.ts` classifier owns the 20/50 kPa rule. A presentation-only shared component renders a labeled color pill, while each consumer decides whether its measurement is current and valid. `zoneSoil.ts` supplies an honest current value by recognizing Tensiomark and excluding stale or faulted contributors; the Water card keeps its configurable trigger message separate from the fixed VIA status.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind utility classes with CSS custom properties, i18next, Vitest, Testing Library, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-24-swt-water-status-colors-design.md`

## Global constraints

- Classify canonical, unrounded kPa as Wet for `0 <= kPa < 20`, Moist for `20 <= kPa <= 50`, and Dry for `50 < kPa <= 300`.
- Return no status for missing, non-numeric, non-finite, negative, above-300, stale, or faulted telemetry.
- Treat a valid timestamp as current only when `nowMs` is finite and `-5 minutes <= nowMs - observedMs <= 3 hours`; both limits are inclusive.
- Derive status from kPa even when the displayed unit is pF; a real `0 kPa` reading remains visible as `0.0 kPa` in pF mode because pF is undefined at zero.
- Keep numeric values and label text neutral; use existing `--soil-*-bg` washes and `--soil-*` colors only for the status pill, border, and dot.
- Status must have visible localized text and must never rely on color alone or use a live-region role.
- Preserve device-card history buttons, focus rings, KIWI's dotted underline, LSN50's bordered-row hover treatment, depth labels, missing-data behavior, and the three-hour age limit with five minutes of allowed future clock skew.
- VIA status is independent of irrigation-trigger proximity. A value may be both Moist and At or past the trigger.
- Apply VIA bands only to SWT. Do not color VWC, VIC, temperature, EC, dendrometer values, or DENDRO's encoded `threshold_kpa`.
- Reuse the existing `history.history.soil.state.{wet,moist,dry}` translations in all seven locales; add no duplicate device-namespace strings.
- Do not edit `ui-core`, Node-RED flows, database schema, decoders, APIs, scheduler behavior, history classification, or cloud code.
- Use `superpowers:using-git-worktrees` after plan approval if the execution checkout needs isolation. Before editing, inspect the intended feature paths with `git status --short -- ...`; resolve any existing changes without overwriting them. Do not infer path conflicts from the branch name or unrelated untracked files.

## Review focus

- Exact thresholds: tests in Task 1 must distinguish `19.999/20` and `50/50.001`, and reject `-1/301`, so rounding cannot move a reading between states.
- Freshness mixtures: tests in Task 3 must prove that one fresh device cannot make a stale contributor look current and colored.
- Clock skew: Task 3 must reject observations more than five minutes ahead, including far-future values, while accepting both exact freshness boundaries.
- SDI-12 quantity: tests in Task 3 must route Tensiomark to SWT while keeping the current VWC profiles volumetric.
- Fault containment: tests in Tasks 3 and 4 must suppress LSN50 status for global I2C/timeout faults and for the matching per-channel open flag.
- Schedule fallback: tests in Task 5 must prove that a fallback channel gets a VIA badge but is not compared with another channel's configured trigger.

## File map

| File | Responsibility after this change |
|---|---|
| `web/react-gui/src/utils/swt.ts` | Canonical SWT parsing, 20/50 classification, pF conversion, card-display formatting |
| `web/react-gui/src/utils/__tests__/swt.test.ts` | Boundary and unit-invariance contract |
| `web/react-gui/src/components/farming/shared/SwtStatusIndicator.tsx` | Noninteractive, localized status pill |
| `web/react-gui/src/components/farming/__tests__/SwtStatusIndicator.test.tsx` | Accessible text, token styling, and real locale behavior |
| `web/react-gui/src/utils/zoneSoil.ts` | Sensor freshness, Tensiomark quantity selection, fault filtering, current zone summary |
| `web/react-gui/src/utils/__tests__/zoneSoil.test.ts` | Tension/VWC routing, stale aggregation, faults, requested-channel behavior |
| `web/react-gui/src/components/farming/KiwiSensorCard.tsx` | Per-channel KIWI indicators |
| `web/react-gui/src/components/farming/DraginoTempCard.tsx` | Per-channel LSN50 indicators and open-channel gating |
| `web/react-gui/src/components/farming/Sdi12SoilCard.tsx` | Tensiomark SWT indicator without coloring other quantities |
| `web/react-gui/src/components/farming/__tests__/{KiwiSensorCard,DraginoTempCard,Sdi12SoilCard}.test.tsx` | Device-card integration regressions |
| `web/react-gui/src/components/farming/IrrigationZoneCard.tsx` | Water-card indicator and separate trigger copy |
| `web/react-gui/src/components/farming/__tests__/IrrigationZoneCardSensorGating.test.tsx` | Water-card status, stale, fault, and trigger behavior |
| `web/react-gui/src/components/farming/__tests__/IrrigationZoneCardLocale.test.tsx` | Real French rendering with the history namespace loaded |

## Execution preflight and command convention

Run every command from the repository root. GUI commands in this plan use a subshell such as `(cd web/react-gui && npm run typecheck)`, so one step cannot silently change the next step's working directory.

Before Task 1, choose an execution checkout with clean feature paths. An isolated worktree is useful when the current checkout contains conflicting work. If using one, create it from a commit that contains this approved spec and plan. Run these checks in the execution checkout:

```bash
git cat-file -e HEAD:docs/superpowers/specs/2026-09-24-swt-water-status-colors-design.md
git cat-file -e HEAD:docs/superpowers/plans/2026-09-24-swt-water-status-colors.md
git status --short -- \
  web/react-gui/src/utils/swt.ts \
  web/react-gui/src/utils/zoneSoil.ts \
  web/react-gui/src/components/farming
```

Expected: both `cat-file` checks exit 0 and the feature-path status prints nothing. If the docs are still untracked, add them to the execution branch before relying on the `cat-file` checks; an untracked document is not part of `HEAD`. As checked on 2026-09-25, `975a40434` on `feat/rak10701-coverage` had no tracked modifications, while these two docs and unrelated artifacts were untracked. Recheck at execution time because that state can change. Record the starting commit for final review:

```bash
SWT_STATUS_GIT_DIR=$(git rev-parse --git-dir)
git rev-parse HEAD > "$SWT_STATUS_GIT_DIR/swt-water-status-base"
```

The `.git` marker is local repository metadata and is never staged.

### Task 1: Pin the VIA classifier and zero-safe display contract

**Files:**

- Modify: `web/react-gui/src/utils/swt.ts`
- Modify: `web/react-gui/src/utils/__tests__/swt.test.ts`

**Interfaces:**

- Produces: `type SwtWaterStatus = 'wet' | 'moist' | 'dry'`
- Produces: `classifySwtWaterStatus(value: unknown): SwtWaterStatus | null`
- Produces: `formatSwtCardValue(kpa: unknown, unit: SwtUnit): string | null`
- Preserves: `formatSwtValue()` as the strict unit formatter used by export and conversion tests

- [ ] **Step 1: Write failing classifier and display tests**

Extend the import and add these cases to `src/utils/__tests__/swt.test.ts`:

```ts
import {
  classifySwtWaterStatus,
  formatSwtCardValue,
  formatSwtValue,
  kpaToPf,
  pfToKpa,
} from '../swt';

describe('classifySwtWaterStatus', () => {
  it.each([
    [0, 'wet'],
    [19.999, 'wet'],
    [20, 'moist'],
    [50, 'moist'],
    [50.001, 'dry'],
    [300, 'dry'],
  ] as const)('classifies %s kPa as %s', (value, expected) => {
    expect(classifySwtWaterStatus(value)).toBe(expected);
  });

  it.each([
    -1,
    301,
    null,
    undefined,
    Number.NaN,
    Number.NEGATIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    '20',
  ])('returns null for %s', (value) => {
    expect(classifySwtWaterStatus(value)).toBeNull();
  });
});

describe('formatSwtCardValue', () => {
  it('uses the selected unit for positive tension', () => {
    expect(formatSwtCardValue(30, 'kPa')).toBe('30.0 kPa');
    expect(formatSwtCardValue(30, 'pF')).toBe('2.48 pF');
  });

  it('keeps a measured zero visible in pF mode without inventing zero pF', () => {
    expect(formatSwtCardValue(0, 'pF')).toBe('0.0 kPa');
  });

  it('keeps invalid and missing values unavailable', () => {
    expect(formatSwtCardValue(-1, 'pF')).toBeNull();
    expect(formatSwtCardValue(null, 'kPa')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the missing exports fail**

Run:

```bash
(cd web/react-gui && npx vitest run src/utils/__tests__/swt.test.ts)
```

Expected: FAIL because `classifySwtWaterStatus` and `formatSwtCardValue` are not exported.

- [ ] **Step 3: Add the classifier and card-display formatter**

Add beside `SwtUnit` in `src/utils/swt.ts`:

```ts
export type SwtWaterStatus = 'wet' | 'moist' | 'dry';

export function classifySwtWaterStatus(value: unknown): SwtWaterStatus | null {
  const kpa = toFiniteSwtValue(value);
  if (kpa === null || kpa < 0 || kpa > 300) return null;
  if (kpa < 20) return 'wet';
  if (kpa <= 50) return 'moist';
  return 'dry';
}
```

Add after `formatSwtValue()`:

```ts
export function formatSwtCardValue(kpa: unknown, unit: SwtUnit): string | null {
  const value = toFiniteSwtValue(kpa);
  if (value === null || value < 0 || value > 300) return null;
  return formatSwtValue(value, unit) ?? (value === 0 ? formatSwtValue(value, 'kPa') : null);
}
```

Replace the 20/60 branches in `summarizeSwtValues()` with a delegation so no second threshold rule survives:

```ts
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const status = classifySwtWaterStatus(mean);
  if (status === null) return { label: 'No soil sensor reading', swt: null };
  const label: Record<SwtWaterStatus, string> = { wet: 'Wet', moist: 'Moist', dry: 'Dry' };
  return { label: label[status], swt: mean };
```

- [ ] **Step 4: Run the focused tests**

Run: `(cd web/react-gui && npx vitest run src/utils/__tests__/swt.test.ts)`

Expected: PASS, including strict `formatSwtValue(0, 'pF') === null` and card-only zero fallback.

- [ ] **Step 5: Commit the domain contract**

```bash
git add web/react-gui/src/utils/swt.ts web/react-gui/src/utils/__tests__/swt.test.ts
git commit -m "feat(gui): classify SWT with VIA water-status bands"
```

### Task 2: Build the shared accessible indicator

**Files:**

- Create: `web/react-gui/src/components/farming/shared/SwtStatusIndicator.tsx`
- Create: `web/react-gui/src/components/farming/__tests__/SwtStatusIndicator.test.tsx`

**Interfaces:**

- Consumes: `SwtWaterStatus` from Task 1
- Produces: `SwtStatusIndicator({ status, className? })`
- Depends on: existing `history.history.soil.state.{wet,moist,dry}` locale entries and `--soil-*` CSS variables

- [ ] **Step 1: Write the component tests with real English and German resources**

Create `components/farming/__tests__/SwtStatusIndicator.test.tsx` so the existing `npm run test:unit:vitest` directory list includes it:

```tsx
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { describe, expect, it } from 'vitest';

import deHistory from '../../../../public/locales/de-CH/history.json';
import enHistory from '../../../../public/locales/en/history.json';
import { SwtStatusIndicator } from '../shared/SwtStatusIndicator';

async function renderIndicator(status: 'wet' | 'moist' | 'dry' | null, language = 'en') {
  const instance = i18next.createInstance();
  await instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['history'],
    defaultNS: 'history',
    resources: {
      en: { history: enHistory },
      'de-CH': { history: deHistory },
    },
    interpolation: { escapeValue: false },
  });
  return render(
    <I18nextProvider i18n={instance}>
      <SwtStatusIndicator status={status} />
    </I18nextProvider>,
  );
}

describe('SwtStatusIndicator', () => {
  it('renders a text label with the wet tokens and no live-region role', async () => {
    const view = await renderIndicator('wet');
    const badge = screen.getByText('Wet');
    expect(badge).toHaveAttribute('data-swt-status', 'wet');
    expect(badge.tagName).toBe('SPAN');
    expect(badge).toHaveStyle({
      backgroundColor: 'var(--soil-wet-bg)',
      borderColor: 'var(--soil-wet)',
    });
    expect(badge).toHaveClass('text-[var(--text)]');
    expect(badge).toHaveClass('shrink-0', 'whitespace-nowrap');
    expect(badge).not.toHaveAttribute('role', 'status');
    expect(badge).not.toHaveAttribute('tabindex');
    expect(badge.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    expect(view.container.querySelector('button')).not.toBeInTheDocument();
  });

  it('renders the real German label', async () => {
    await renderIndicator('moist', 'de-CH');
    expect(screen.getByText('Feucht')).toBeInTheDocument();
  });

  it('renders nothing without a valid status', async () => {
    const view = await renderIndicator(null);
    expect(view.container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run the focused test and confirm the missing module fails**

Run: `(cd web/react-gui && npx vitest run src/components/farming/__tests__/SwtStatusIndicator.test.tsx)`

Expected: FAIL because `SwtStatusIndicator.tsx` does not exist.

- [ ] **Step 3: Implement the presentation-only component**

Create `shared/SwtStatusIndicator.tsx`:

```tsx
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';

import type { SwtWaterStatus } from '../../../utils/swt';

interface SwtStatusIndicatorProps {
  status: SwtWaterStatus | null;
  className?: string;
}

const VISUALS: Record<SwtWaterStatus, { color: string; background: string }> = {
  wet: { color: 'var(--soil-wet)', background: 'var(--soil-wet-bg)' },
  moist: { color: 'var(--soil-moist)', background: 'var(--soil-moist-bg)' },
  dry: { color: 'var(--soil-dry)', background: 'var(--soil-dry-bg)' },
};

export function SwtStatusIndicator({ status, className = '' }: SwtStatusIndicatorProps) {
  const { t } = useTranslation('history');
  if (status === null) return null;

  const visual = VISUALS[status];
  const style: CSSProperties = {
    backgroundColor: visual.background,
    borderColor: visual.color,
  };

  return (
    <span
      data-swt-status={status}
      style={style}
      className={`inline-flex min-h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-1 text-xs font-semibold text-[var(--text)] ${className}`.trim()}
    >
      <span
        aria-hidden="true"
        className="h-3 w-3 shrink-0 rounded-full"
        style={{ backgroundColor: visual.color }}
      />
      {t(`history.soil.state.${status}`)}
    </span>
  );
}
```

- [ ] **Step 4: Run the component and locale tests**

Run:

```bash
(cd web/react-gui && npx vitest run src/components/farming/__tests__/SwtStatusIndicator.test.tsx src/history/__tests__/historyLocaleValues.test.ts)
```

Expected: PASS with Wet and Feucht rendered from real resources.

- [ ] **Step 5: Commit the shared visual**

```bash
git add web/react-gui/src/components/farming/shared/SwtStatusIndicator.tsx web/react-gui/src/components/farming/__tests__/SwtStatusIndicator.test.tsx
git commit -m "feat(gui): add accessible SWT status indicator"
```

### Task 3: Make the zone soil summary current, fault-aware, and Tensiomark-aware

**Files:**

- Modify: `web/react-gui/src/utils/zoneSoil.ts`
- Modify: `web/react-gui/src/utils/__tests__/zoneSoil.test.ts`

**Interfaces:**

- Produces: `isSensorObservationFresh(observedAt, nowMs?)`
- Changes: `summarizeZoneSoil()` treats `DRAGINO_SDI12/TENSIOMARK` as tension and excludes stale or faulted contributors from a current value
- Preserves: `ZoneSoilStatus`, channel selection, depth labels, last-valid stale state, and VWC behavior for non-Tensiomark profiles

- [ ] **Step 1: Add failing tests for freshness, Tensiomark, and Chameleon faults**

Add to `src/utils/__tests__/zoneSoil.test.ts`:

```ts
it('treats an SDI-12 Tensiomark as tension before and after its first sample', () => {
  const waiting = summarizeZoneSoil([device({
    type_id: 'DRAGINO_SDI12',
    sdi12_probe_profile: 'TENSIOMARK',
    last_seen: null,
    latest_data: {},
  })], NOW);
  expect(waiting).toMatchObject({ hasSensor: true, quantity: 'tension', value: null, stale: true });

  const reporting = summarizeZoneSoil([device({
    type_id: 'DRAGINO_SDI12',
    sdi12_probe_profile: 'TENSIOMARK',
    last_seen: FRESH,
    latest_data: { swt_1: 30.2, soil_temp_1: 21.5 },
  })], NOW);
  expect(reporting).toMatchObject({ quantity: 'tension', value: 30.2, channel: 'swt_1', stale: false });
});

it('keeps a non-Tensiomark SDI-12 probe volumetric', () => {
  const status = summarizeZoneSoil([device({
    type_id: 'DRAGINO_SDI12',
    sdi12_probe_profile: 'SENTEK_ENVIROSCAN',
    last_seen: FRESH,
    latest_data: { vwc_1: 28, vwc_2: 32 },
  })], NOW);
  expect(status).toMatchObject({ quantity: 'volumetric', value: 30 });
});

it('excludes stale contributors when a current reading exists', () => {
  const status = summarizeZoneSoil([
    device({ deveui: 'CURRENT', last_seen: FRESH, latest_data: { swt_1: 30 } }),
    device({ deveui: 'STALE', last_seen: STALE, latest_data: { swt_1: 90 } }),
  ], NOW, 'swt_1');
  expect(status).toMatchObject({ value: 30, observedAt: FRESH, stale: false });
});

it('retains stale values only when no current contributor exists', () => {
  const older = new Date(Date.parse(STALE) - 60_000).toISOString();
  const status = summarizeZoneSoil([
    device({ deveui: 'OLD-1', last_seen: STALE, latest_data: { swt_1: 60 } }),
    device({ deveui: 'OLD-2', last_seen: older, latest_data: { swt_1: 80 } }),
  ], NOW, 'swt_1');
  expect(status).toMatchObject({ value: 70, observedAt: STALE, stale: true });
});

it('does not use a stale contributor to choose or label a current channel depth', () => {
  const status = summarizeZoneSoil([
    device({
      deveui: 'CURRENT',
      last_seen: FRESH,
      soilMoistureProbeDepths: { swt_1: 60, swt_2: 30 },
      latest_data: { swt_1: 60, swt_2: 30 },
    }),
    device({
      deveui: 'STALE',
      last_seen: STALE,
      soilMoistureProbeDepths: { swt_1: 10 },
      latest_data: { swt_1: 10 },
    }),
  ], NOW);
  expect(status).toMatchObject({ value: 30, channel: 'swt_2', depthCm: 30, stale: false });
});

it.each([
  { swt_1: null, chameleon_i2c_missing: 1 },
  { swt_1: null, chameleon_timeout: 1 },
  { swt_1: null, chameleon_ch1_open: 1 },
  { swt_2: null, chameleon_ch2_open: 1 },
  { swt_3: null, chameleon_ch3_open: 1 },
])('rejects a faulted LSN50 sample even when its SWT value is null: %o', (latestData) => {
  const status = summarizeZoneSoil([device({
    type_id: 'DRAGINO_LSN50',
    chameleon_enabled: 1,
    last_seen: FRESH,
    latest_data: latestData,
  })], NOW);
  expect(status).toMatchObject({ value: null, invalid: true });
});
```

Also add a named test for the exported predicate. Pin both inclusive boundaries and the first millisecond outside each one:

```ts
it('accepts the three-hour age and five-minute skew boundaries only', () => {
  const oldestCurrent = new Date(NOW - SENSOR_FRESHNESS_WINDOW_MS).toISOString();
  const oneMsTooOld = new Date(NOW - SENSOR_FRESHNESS_WINDOW_MS - 1).toISOString();
  const furthestCurrent = new Date(NOW + 5 * 60_000).toISOString();
  const oneMsTooFarAhead = new Date(NOW + 5 * 60_000 + 1).toISOString();
  const farFuture = new Date(NOW + 24 * 60 * 60_000).toISOString();
  expect(isSensorObservationFresh(FRESH, NOW)).toBe(true);
  expect(isSensorObservationFresh(oldestCurrent, NOW)).toBe(true);
  expect(isSensorObservationFresh(oneMsTooOld, NOW)).toBe(false);
  expect(isSensorObservationFresh(furthestCurrent, NOW)).toBe(true);
  expect(isSensorObservationFresh(oneMsTooFarAhead, NOW)).toBe(false);
  expect(isSensorObservationFresh(farFuture, NOW)).toBe(false);
  expect(isSensorObservationFresh(null, NOW)).toBe(false);
  expect(isSensorObservationFresh('not-a-date', NOW)).toBe(false);
  expect(isSensorObservationFresh(FRESH, Number.NaN)).toBe(false);
  expect(isSensorObservationFresh(FRESH, Number.POSITIVE_INFINITY)).toBe(false);
});
```

- [ ] **Step 2: Run the focused test and confirm semantic failures**

Run: `(cd web/react-gui && npx vitest run src/utils/__tests__/zoneSoil.test.ts)`

Expected: FAIL because Tensiomark is volumetric, stale values enter the mean, fault flags are ignored, and the freshness predicate is absent.

- [ ] **Step 3: Add the shared freshness predicate and profile-aware quantity checks**

Export beside the constant:

```ts
export function isSensorObservationFresh(
  observedAt: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!observedAt || !Number.isFinite(nowMs)) return false;
  const observedMs = new Date(observedAt).getTime();
  const ageMs = nowMs - observedMs;
  return Number.isFinite(observedMs)
    && ageMs >= -5 * 60_000
    && ageMs <= SENSOR_FRESHNESS_WINDOW_MS;
}
```

Replace the sensor predicates with:

```ts
function isTensionSensor(device: Pick<Device, 'type_id' | 'chameleon_enabled' | 'sdi12_probe_profile'>): boolean {
  if (device.type_id === 'KIWI_SENSOR' || device.type_id === 'TEKTELIC_CLOVER') return true;
  if (device.type_id === 'DRAGINO_LSN50') return device.chameleon_enabled === 1;
  return device.type_id === 'DRAGINO_SDI12' && device.sdi12_probe_profile === 'TENSIOMARK';
}

function isVolumetricSensor(device: Pick<Device, 'type_id' | 'sdi12_probe_profile'>): boolean {
  return device.type_id === 'DRAGINO_SDI12' && device.sdi12_probe_profile !== 'TENSIOMARK';
}
```

- [ ] **Step 4: Split current and stale tension contributors and reject Chameleon faults**

Add these helpers above `summarizeTension()`:

```ts
interface TensionBucket {
  values: Map<SoilChannel, number[]>;
  observedAt: Map<SoilChannel, string | null>;
  depths: Map<SoilChannel, number | null>;
}

function emptyTensionBucket(): TensionBucket {
  return { values: new Map(), observedAt: new Map(), depths: new Map() };
}

function chameleonChannelFaulted(device: Device, channel: SoilChannel): boolean {
  if (device.type_id !== 'DRAGINO_LSN50') return false;
  const data = device.latest_data;
  if (data?.chameleon_i2c_missing === 1 || data?.chameleon_timeout === 1) return true;
  const openByChannel: Record<SoilChannel, number | null | undefined> = {
    swt_1: data?.chameleon_ch1_open,
    swt_2: data?.chameleon_ch2_open,
    swt_3: data?.chameleon_ch3_open,
  };
  return openByChannel[channel] === 1;
}

function appendTension(
  bucket: TensionBucket,
  channel: SoilChannel,
  value: number,
  observedAt: string | null | undefined,
  depth: number | null,
) {
  bucket.values.set(channel, [...(bucket.values.get(channel) ?? []), value]);
  bucket.observedAt.set(channel, newerInstant(bucket.observedAt.get(channel) ?? null, observedAt));
  if (depth != null) {
    const known = bucket.depths.get(channel);
    bucket.depths.set(channel, known == null ? depth : Math.min(known, depth));
  }
}
```

Refactor the `summarizeTension()` loop to fill `current` or `historical`:

```ts
  const current = emptyTensionBucket();
  const historical = emptyTensionBucket();
  let reportedCount = 0;
  let anyObservedAt: string | null = null;

  for (const device of devices) {
    const row = device.latest_data as Record<string, unknown> | null | undefined;
    const fresh = isSensorObservationFresh(device.last_seen, nowMs);
    for (const channel of TENSION_CHANNELS) {
      const legacy = LEGACY_ALIAS[channel];
      const raw = row?.[channel] ?? (legacy ? row?.[legacy] : undefined);
      const faulted = chameleonChannelFaulted(device, channel);
      if ((raw === null || raw === undefined) && !faulted) continue;
      reportedCount += 1;
      anyObservedAt = newerInstant(anyObservedAt, device.last_seen);
      if (faulted) continue;
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) continue;
      appendTension(fresh ? current : historical, channel, raw, device.last_seen, probeDepthCm(device, channel));
    }
  }

  const currentAvailable = TENSION_CHANNELS.filter((channel) => (current.values.get(channel)?.length ?? 0) > 0);
  const historicalAvailable = TENSION_CHANNELS.filter((channel) => (historical.values.get(channel)?.length ?? 0) > 0);
  const usingCurrent = currentAvailable.length > 0;
  const bucket = usingCurrent ? current : historical;
  const available = usingCurrent ? currentAvailable : historicalAvailable;
```

Use `bucket.values`, `bucket.observedAt`, and `bucket.depths` in the existing selection, mean, timestamp, and returned-depth calculation. Never select or label a fresh value with a stale contributor's depth. Return `stale: !usingCurrent` when a value exists; a configured sensor without any value also remains stale. Set `invalid: reportedCount > 0 && currentAvailable.length === 0 && historicalAvailable.length === 0`.

Do not change `selectChannel()` fallback. Task 5 prevents a fallback channel from receiving the requested channel's trigger message.

- [ ] **Step 5: Run the zone-soil tests**

Run: `(cd web/react-gui && npx vitest run src/utils/__tests__/zoneSoil.test.ts)`

Expected: PASS, including all pre-existing depth and alias cases.

- [ ] **Step 6: Commit the summary correction**

```bash
git add web/react-gui/src/utils/zoneSoil.ts web/react-gui/src/utils/__tests__/zoneSoil.test.ts
git commit -m "fix(gui): classify current zone SWT contributors honestly"
```

### Task 4: Integrate per-channel status into the three device-card families

**Files:**

- Modify: `web/react-gui/src/components/farming/KiwiSensorCard.tsx`
- Modify: `web/react-gui/src/components/farming/DraginoTempCard.tsx`
- Modify: `web/react-gui/src/components/farming/Sdi12SoilCard.tsx`
- Modify: `web/react-gui/src/components/farming/__tests__/KiwiSensorCard.test.tsx`
- Modify: `web/react-gui/src/components/farming/__tests__/DraginoTempCard.test.tsx`
- Modify: `web/react-gui/src/components/farming/__tests__/Sdi12SoilCard.test.tsx`

**Interfaces:**

- Consumes: `classifySwtWaterStatus()`, `formatSwtCardValue()`, `SwtStatusIndicator`, and `isSensorObservationFresh()`
- Produces: one status per current valid displayed SWT channel
- Preserves: all existing device actions, history controls, units, configuration, removal, and footer behavior

- [ ] **Step 1: Add failing device-card integration tests**

Freeze time in each suite so freshness is deterministic while Testing Library's async polling can still advance. Use:

```ts
const NOW = Date.parse('2026-09-24T08:00:00.000Z');
const FRESH = new Date(NOW - 30 * 60 * 1000).toISOString();
const STALE = new Date(NOW - 4 * 60 * 60 * 1000).toISOString();
```

Add `beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW }))` and matching `afterEach(() => vi.useRealTimers())` where absent. Preserve each suite's existing setup inside those hooks. Update fixtures used by new status assertions to `last_seen: FRESH`.

Use the same explicit translation mock in all three files instead of returning every key verbatim:

```ts
const STATUS_LABELS: Record<string, string> = {
  'history.soil.state.wet': 'Wet',
  'history.soil.state.moist': 'Moist',
  'history.soil.state.dry': 'Dry',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      STATUS_LABELS[key] ?? options?.defaultValue ?? key,
  }),
}));
```

Add this mock to the KIWI suite and replace the key-only mocks in the LSN50 and SDI-12 suites. This keeps existing key assertions intact while making the new dynamic history-namespace keys assertable as visible English labels.

Add these behaviors:

```tsx
it('shows independently classified KIWI channels and withholds stale status', () => {
  const { rerender } = render(<KiwiSensorCard removeContext="farm" device={{
    ...kiwiDevice,
    last_seen: FRESH,
    latest_data: { swt_1: 10, swt_2: 55 },
  }} />);
  expect(screen.getByText('Wet')).toBeInTheDocument();
  expect(screen.getByText('Dry')).toBeInTheDocument();

  rerender(<KiwiSensorCard removeContext="farm" device={{
    ...kiwiDevice,
    last_seen: STALE,
    latest_data: { swt_1: 10 },
  }} />);
  expect(screen.queryByText('Wet')).not.toBeInTheDocument();
});

it('keeps zero visible in pF mode and gives it one Wet status', () => {
  window.localStorage.setItem('osi.display.swtUnit', 'pF');
  render(<KiwiSensorCard removeContext="farm" device={{
    ...kiwiDevice,
    last_seen: FRESH,
    latest_data: { swt_1: 0 },
  }} />);
  expect(screen.getByText('0.0 kPa')).toBeInTheDocument();
  expect(screen.queryByText('0.00 pF')).not.toBeInTheDocument();
  expect(screen.getAllByText('Wet')).toHaveLength(1);
});

it('keeps the KIWI history control separate from its status pill', () => {
  render(<KiwiSensorCard removeContext="farm" device={{
    ...kiwiDevice,
    last_seen: FRESH,
    latest_data: { swt_1: 10 },
  }} />);
  const badge = screen.getByText('Wet').closest('[data-swt-status]');
  expect(badge?.closest('button')).toBeNull();
  expect(badge?.parentElement).toHaveClass('flex', 'flex-wrap');
  expect(screen.getByTitle('View history')).toBeInTheDocument();
});
```

```tsx
it('keeps pF display while deriving three LSN50 statuses from kPa', () => {
  window.localStorage.setItem('osi.display.swtUnit', 'pF');
  render(<DraginoTempCard removeContext="farm" device={{
    ...chameleonDevice,
    last_seen: FRESH,
    latest_data: { swt_1: 10, swt_2: 30, swt_3: 60 },
  }} />);
  expect(screen.getByText('2.00 pF')).toBeInTheDocument();
  expect(screen.getByText('2.48 pF')).toBeInTheDocument();
  expect(screen.getByText('2.78 pF')).toBeInTheDocument();
  expect(screen.getByText('Wet')).toBeInTheDocument();
  expect(screen.getByText('Moist')).toBeInTheDocument();
  expect(screen.getByText('Dry')).toBeInTheDocument();
});

it('suppresses only the open LSN50 channel status', () => {
  render(<DraginoTempCard removeContext="farm" device={{
    ...chameleonDevice,
    last_seen: FRESH,
    latest_data: { swt_1: 10, swt_2: 30, chameleon_ch1_open: 1 },
  }} />);
  expect(screen.queryByText('Wet')).not.toBeInTheDocument();
  expect(screen.getByText('Moist')).toBeInTheDocument();
});

it.each([
  { chameleon_i2c_missing: 1 },
  { chameleon_timeout: 1 },
])('suppresses every LSN50 status for a global Chameleon fault: %o', (fault) => {
  render(<DraginoTempCard removeContext="farm" device={{
    ...chameleonDevice,
    last_seen: FRESH,
    latest_data: { swt_1: null, swt_2: null, ...fault },
  }} />);
  expect(screen.queryByText('Wet')).not.toBeInTheDocument();
  expect(screen.queryByText('Moist')).not.toBeInTheDocument();
  expect(screen.getByText('No valid Chameleon sample')).toBeInTheDocument();
});

it('withholds stale LSN50 status and keeps each status inside its one row button', () => {
  const { rerender } = render(<DraginoTempCard removeContext="farm" device={{
    ...chameleonDevice,
    last_seen: FRESH,
    latest_data: { swt_1: 10 },
  }} />);
  const rowButton = screen.getByText('SWT1').closest('button');
  expect(rowButton).toHaveAttribute('title', 'View SWT history');
  expect(rowButton).toContainElement(screen.getByText('Wet'));
  expect(rowButton?.querySelectorAll('button')).toHaveLength(0);
  expect(rowButton).toHaveClass('flex-wrap', 'gap-2');
  expect(screen.getByText('Wet').parentElement).toHaveClass('flex', 'flex-wrap');

  rerender(<DraginoTempCard removeContext="farm" device={{
    ...chameleonDevice,
    last_seen: STALE,
    latest_data: { swt_1: 10 },
  }} />);
  expect(screen.queryByText('Wet')).not.toBeInTheDocument();
});
```

```tsx
it('adds VIA status only to current SDI-12 SWT rows', () => {
  render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
    sdi12_probe_profile: 'TENSIOMARK',
    last_seen: FRESH,
    latest: { swt_1: 30.2, soil_temp_1: 21.5 },
  })} />);
  expect(screen.getByText('30.2 kPa · 2.48 pF')).toBeInTheDocument();
  expect(screen.getByText('Moist')).toBeInTheDocument();
  expect(screen.getAllByText(/Soil temperature/)).toHaveLength(1);
});

it('withholds stale and out-of-range SDI-12 status without hiding the row', () => {
  const { rerender } = render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
    sdi12_probe_profile: 'TENSIOMARK',
    last_seen: STALE,
    latest: { swt_1: 30.2 },
  })} />);
  expect(screen.queryByText('Moist')).not.toBeInTheDocument();

  rerender(<Sdi12SoilCard removeContext="farm" device={makeDevice({
    sdi12_probe_profile: 'TENSIOMARK',
    last_seen: FRESH,
    latest: { swt_1: 301 },
  })} />);
  expect(screen.getByText('—')).toBeInTheDocument();
  expect(screen.queryByText('Dry')).not.toBeInTheDocument();
});

it('renders zero once as kPa in pF mode and marks it Wet', () => {
  window.localStorage.setItem('osi.display.swtUnit', 'pF');
  render(<Sdi12SoilCard removeContext="farm" device={makeDevice({
    sdi12_probe_profile: 'TENSIOMARK',
    last_seen: FRESH,
    latest: { swt_1: 0 },
  })} />);
  expect(screen.getAllByText('0.0 kPa')).toHaveLength(1);
  expect(screen.queryByText('0.00 pF')).not.toBeInTheDocument();
  expect(screen.getByText('Wet')).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the three suites and confirm missing indicators**

Run:

```bash
(cd web/react-gui && npx vitest run \
  src/components/farming/__tests__/KiwiSensorCard.test.tsx \
  src/components/farming/__tests__/DraginoTempCard.test.tsx \
  src/components/farming/__tests__/Sdi12SoilCard.test.tsx)
```

Expected: FAIL because no card renders `SwtStatusIndicator`.

- [ ] **Step 3: Integrate KIWI without nesting controls**

Import the classifier, card formatter, freshness predicate, and indicator. Compute:

```ts
const swtIsCurrent = isSensorObservationFresh(device.last_seen);
```

Wrap each SWT value and its sibling indicator in a flex row:

```tsx
<div className="flex flex-wrap items-center gap-2">
  {renderValue('swt_1', formatSwtCardValue(swt1, swtUnit))}
  <SwtStatusIndicator status={swtIsCurrent ? classifySwtWaterStatus(swt1) : null} />
</div>
```

Replace the `swt_2` value with its exact sibling wrapper too:

```tsx
<div className="flex flex-wrap items-center gap-2">
  {renderValue('swt_2', formatSwtCardValue(swt2, swtUnit))}
  <SwtStatusIndicator status={swtIsCurrent ? classifySwtWaterStatus(swt2) : null} />
</div>
```

Leave non-SWT calls on their existing formatters. Each indicator is a sibling of the history button, never a button inside it.

- [ ] **Step 4: Integrate LSN50 inside each existing history row**

Replace `chameleonChannels` with these exact entries:

```ts
const chameleonChannels = [
  { field: 'swt_1', label: 'SWT1', value: data?.swt_1, depth: device.chameleon_swt1_depth_cm, color: '#0f766e', open: data?.chameleon_ch1_open === 1 },
  { field: 'swt_2', label: 'SWT2', value: data?.swt_2, depth: device.chameleon_swt2_depth_cm, color: '#2563eb', open: data?.chameleon_ch2_open === 1 },
  { field: 'swt_3', label: 'SWT3', value: data?.swt_3, depth: device.chameleon_swt3_depth_cm, color: '#7c3aed', open: data?.chameleon_ch3_open === 1 },
] as const;
```

Compute `chameleonIsCurrent` from `last_seen`. In the existing outer history button class, replace `flex items-center justify-between rounded-md` with `flex flex-wrap gap-2 items-center justify-between rounded-md`; leave its remaining border, hover, focus, and click behavior intact. The right side alone wrapping is insufficient at narrow widths. Replace the value-only right side with:

```tsx
<span className="flex flex-wrap items-center justify-end gap-2">
  <span className="text-lg font-bold tabular-nums text-[var(--text)]">
    {formatSwtCardValue(channel.value, swtUnit) ?? '—'}
  </span>
  <SwtStatusIndicator
    status={chameleonIsCurrent && !chameleonDataInvalid && !channel.open
      ? classifySwtWaterStatus(channel.value)
      : null}
  />
</span>
```

Keep the entire channel row as the one history button and retain its focus class and title.

- [ ] **Step 5: Integrate SDI-12 only for `kind === 'swt'`**

Import both `formatSwtCardValue()` and the strict `formatSwtValue()`. Change the helper's return type and SWT branch exactly as follows; the strict pF formatter prevents a zero value from appearing twice, while the nullable return keeps invalid SWT visibly unavailable:

```ts
function formatChannelValue(kind: SoilChannel, value: number): string | null {
  if (kind === 'swt') {
    const kpa = formatSwtCardValue(value, 'kPa');
    if (kpa === null) return null;
    const pf = formatSwtValue(value, 'pF');
    return pf ? `${kpa} · ${pf}` : kpa;
  }
  const channel = CHANNELS.find(({ kind: candidate }) => candidate === kind);
  return `${formatNumber(value, channel?.decimals ?? 1)} ${channel?.unit ?? ''}`.trim();
}
```

Compute `swtIsCurrent` once from `last_seen`. Render the row entry as:

```tsx
<span key={kind} className="inline-flex flex-wrap items-center gap-2">
  <span>
    <span className="text-[var(--text-tertiary)]">{channelLabel(kind)}: </span>
    <span className="tabular-nums">{value == null ? '—' : formatChannelValue(kind, value) ?? '—'}</span>
  </span>
  {kind === 'swt' && value != null && (
    <SwtStatusIndicator status={swtIsCurrent ? classifySwtWaterStatus(value) : null} />
  )}
</span>
```

Do not alter configured Sentek rows, which currently enumerate only VWC and VIC.

- [ ] **Step 6: Run the device-card tests and typecheck**

Run:

```bash
(cd web/react-gui && npx vitest run \
  src/components/farming/__tests__/KiwiSensorCard.test.tsx \
  src/components/farming/__tests__/DraginoTempCard.test.tsx \
  src/components/farming/__tests__/Sdi12SoilCard.test.tsx)
(cd web/react-gui && npm run typecheck)
```

Expected: PASS. No nested-interactive-element warning appears in test output.

- [ ] **Step 7: Commit the card integrations**

```bash
git add \
  web/react-gui/src/components/farming/KiwiSensorCard.tsx \
  web/react-gui/src/components/farming/DraginoTempCard.tsx \
  web/react-gui/src/components/farming/Sdi12SoilCard.tsx \
  web/react-gui/src/components/farming/__tests__/KiwiSensorCard.test.tsx \
  web/react-gui/src/components/farming/__tests__/DraginoTempCard.test.tsx \
  web/react-gui/src/components/farming/__tests__/Sdi12SoilCard.test.tsx
git commit -m "feat(gui): show VIA status on SWT device readings"
```

### Task 5: Add status to “Soil now” and keep trigger semantics separate

**Files:**

- Modify: `web/react-gui/src/components/farming/IrrigationZoneCard.tsx`
- Modify: `web/react-gui/src/components/farming/__tests__/IrrigationZoneCardSensorGating.test.tsx`
- Modify: `web/react-gui/src/components/farming/__tests__/IrrigationZoneCardLocale.test.tsx`

**Interfaces:**

- Consumes: the Task 1 classifier/formatter, Task 2 indicator, and Task 3 `ZoneSoilStatus`
- Produces: fixed VIA status next to a current tension value; trigger-relative text only when the displayed channel matches the configured channel
- Preserves: VWC wording, stale/invalid warnings, last-valid timestamps, DENDRO exclusion, and Water-card gating

- [ ] **Step 1: Update and extend the Water-card tests first**

In `IrrigationZoneCardSensorGating.test.tsx`:

- Extend the existing `react-i18next` mock so its `t()` starts with this exact lookup, then falls back to the suite's current `defaultValue` interpolation:

```ts
const statusLabel = ({
  'history.soil.state.wet': 'Wet',
  'history.soil.state.moist': 'Moist',
  'history.soil.state.dry': 'Dry',
} as Record<string, string>)[key];
if (statusLabel) return statusLabel;
```

- Change the fresh `45.2 kPa` expectation from Moderate to Moist.
- Change unscheduled `56.5 kPa` and the DENDRO case from Moderate to Dry.
- Keep scheduled `56.5 kPa` asserting both Dry and At or past the trigger.
- Keep stale `72 kPa` asserting no Dry status.

Add Tensiomark and fallback-channel cases:

```tsx
it('shows SDI-12 Tensiomark as moist tension', async () => {
  await openCard([sensor({
    type_id: 'DRAGINO_SDI12',
    sdi12_probe_profile: 'TENSIOMARK',
    last_seen: FRESH,
    latest_data: { swt_1: 30.2, soil_temp_1: 21.5 },
  })]);
  const tile = screen.getByTestId('water-soil-tile');
  expect(tile).toHaveTextContent('30.2 kPa');
  expect(tile).toHaveTextContent('Moist');
  expect(tile).not.toHaveTextContent('Volumetric water content');
});

it('does not apply an absent scheduled channel threshold to a fallback channel', async () => {
  await openScheduled([sensor({ last_seen: FRESH, latest_data: { swt_2: 56.5 } })]);
  const tile = screen.getByTestId('water-soil-tile');
  expect(tile).toHaveTextContent('Dry');
  expect(tile).not.toHaveTextContent('At or past the trigger');
  expect(tile).not.toHaveTextContent('Approaching the trigger');
  expect(tile).not.toHaveTextContent('Below the trigger');
});
```

In `IrrigationZoneCardLocale.test.tsx`, add:

```ts
import enHistory from '../../../../public/locales/en/history.json';
import frHistory from '../../../../public/locales/fr/history.json';
```

Change the i18next setup to `ns: ['devices', 'dashboard', 'common', 'history']`, add `history: enHistory` and `history: frHistory` to the respective resource objects, and freeze the suite at the fixture date without stalling async queries:

```ts
const NOW = Date.parse('2026-07-08T12:00:00.000Z');

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, now: NOW });
  // retain the existing setup below
});

afterEach(() => {
  vi.useRealTimers();
  // retain the existing cleanup below
});
```

After `await renderIn('fr')`, scope the assertion to the Water tile so another component cannot satisfy it:

```ts
const soilTile = within(screen.getByTestId('water-soil-tile'));
expect(soilTile.getByText('Humide')).toBeInTheDocument();
expect(soilTile.queryByText('Moist')).not.toBeInTheDocument();
```

- [ ] **Step 2: Run the two suites and confirm old labels/fallback behavior fail**

Run:

```bash
(cd web/react-gui && npx vitest run \
  src/components/farming/__tests__/IrrigationZoneCardSensorGating.test.tsx \
  src/components/farming/__tests__/IrrigationZoneCardLocale.test.tsx)
```

Expected: FAIL because the card still emits Moderate, has no status pill, and compares a fallback channel to `SWT_1`'s trigger. Task 3 already makes Tensiomark a tension source; this task proves the Water-card presentation of that source.

- [ ] **Step 3: Derive fixed status and independently gated trigger copy**

Import `SwtStatusIndicator`, `classifySwtWaterStatus`, and `formatSwtCardValue`. Change tension formatting to `formatSwtCardValue()`.

Replace the old `soilDescriptor` branch with:

```ts
  const soilWaterStatus = soilNow.quantity === 'tension'
    && soilNow.value !== null
    && !soilNow.stale
    && !soilNow.invalid
    ? classifySwtWaterStatus(soilNow.value)
    : null;
  const displayedChannelMatchesTrigger = triggerChannel !== null && soilNow.channel === triggerChannel;
  const soilDescriptor = soilNow.quantity === 'volumetric'
    ? t('zone.water.soil.volumetric', { defaultValue: 'Volumetric water content' })
    : soilNow.value !== null
      && displayedChannelMatchesTrigger
      && Number.isFinite(triggerThresholdKpa)
      && triggerThresholdKpa > 0
      ? soilNow.value >= triggerThresholdKpa
        ? t('zone.water.soil.atTrigger', { defaultValue: 'At or past the trigger' })
        : soilNow.value >= triggerThresholdKpa * 0.8
          ? t('zone.water.soil.nearTrigger', { defaultValue: 'Approaching the trigger' })
          : t('zone.water.soil.belowTrigger', { defaultValue: 'Below the trigger' })
      : null;
```

This deletes the duplicated 20/60 branch. `triggerChannelOf()` already returns null for DENDRO.

- [ ] **Step 4: Render the indicator beside the current value**

Replace the value paragraph with:

```tsx
<div className="mt-1 flex flex-wrap items-center gap-2">
  <p className="text-lg font-semibold text-[var(--text)]">
    {soilStatusLine === null ? soilValue ?? '—' : '—'}
  </p>
  {soilStatusLine === null && <SwtStatusIndicator status={soilWaterStatus} />}
</div>
```

Keep `soilDescriptor`, `soilStatusLine`, and `soilLastValid` below it. VWC gets no indicator because `soilWaterStatus` is null.

- [ ] **Step 5: Run Water-card, locale, and zone utility tests**

Run:

```bash
(cd web/react-gui && npx vitest run \
  src/components/farming/__tests__/IrrigationZoneCardSensorGating.test.tsx \
  src/components/farming/__tests__/IrrigationZoneCardLocale.test.tsx \
  src/utils/__tests__/zoneSoil.test.ts)
```

Expected: PASS with French Humide, Tensiomark tension, no stale badge, and no false fallback trigger comparison.

- [ ] **Step 6: Commit the Water-card behavior**

```bash
git add \
  web/react-gui/src/components/farming/IrrigationZoneCard.tsx \
  web/react-gui/src/components/farming/__tests__/IrrigationZoneCardSensorGating.test.tsx \
  web/react-gui/src/components/farming/__tests__/IrrigationZoneCardLocale.test.tsx
git commit -m "feat(gui): show VIA status in the Water card"
```

### Task 6: Verify the complete edge GUI and review the feature diff

**Files:**

- Verify only; modify a feature file only if a failing gate exposes a defect in Tasks 1–5

**Interfaces:**

- Consumes: all task outputs
- Produces: current verification evidence for type safety, both unit-test runners, production build, prose quality, real browser layout and interaction, and change-scope containment

- [ ] **Step 1: Run the full static and unit gates without piping output**

```bash
(cd web/react-gui && npm run typecheck)
(cd web/react-gui && npm run test:unit)
```

Expected: both commands exit 0. `test:unit` must run the tsx Node runner and Vitest; do not substitute one sub-runner.

- [ ] **Step 2: Build the production GUI**

Run: `(cd web/react-gui && npm run build)`

Expected: Vite exits 0 and writes the configured `build/` bundle without unresolved history-namespace imports or Tailwind class warnings.

- [ ] **Step 3: Run repository formatting and prose gates**

```bash
node .claude/skills/anti-slop-writing/slop-check.js \
  docs/superpowers/specs/2026-09-24-swt-water-status-colors-design.md \
  docs/superpowers/plans/2026-09-24-swt-water-status-colors.md
```

Expected: the prose checker prints `slop-check: PASS (no tier-1 findings)`.

- [ ] **Step 4: Run the deterministic fixture against the implemented cards**

The design preview uses `web/react-gui/design-preview/vite.config.mjs` to serve real React cards with local fixture API responses. Its default `SWT_PREVIEW_MODE=proposed` transforms source in memory to draw the proposed badge before implementation. That mode is design evidence only. Start the final browser gate with the transform disabled:

```bash
(cd web/react-gui && SWT_PREVIEW_MODE=implemented npx vite \
  --config design-preview/vite.config.mjs --host 127.0.0.1 --port 4178)
```

Open `http://127.0.0.1:4178/gui/design-preview/` in a browser. Its toolbar must say `implementation under test`; URL controls include `?theme=dark&lang=de-CH&unit=pF&scenario=fresh`. The fixture keeps the same zone and device data as the proposed-mode preview; only the source transform changes. If the implementation badge is absent in this mode, the gate fails.

- [ ] **Step 5: Capture and inspect the browser matrix**

With the server from Step 4 still running, run the capture gate from `web/react-gui`:

```bash
(cd web/react-gui && SWT_PREVIEW_MODE=implemented \
  SWT_PREVIEW_OUTPUT=../../docs/superpowers/previews/swt-water-status/implemented \
  node design-preview/capture.mjs)
```

If Playwright is unavailable, install it only for this local check with `(cd web/react-gui && npm install --no-save --package-lock=false playwright)` and `(cd web/react-gui && npx playwright install chromium)`, then rerun capture. An existing Playwright installation can be selected with `PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs` before the capture command; keep that host path out of the plan and product dependencies.

Expected: `capture.mjs` prints `PASS` for 23 cases and writes `checks.json` plus screenshots under `docs/superpowers/previews/swt-water-status/implemented/`. Its fresh matrix is widths 1440, 390, and 320, each in light and dark themes and English, Swiss German, and French (18 cases). Five 390 px pF cases cover English light stale, fault, zero, and future, plus Swiss German dark fresh. The future fixture is one year ahead, beyond the five-minute allowance. The gate checks translated Wet/Moist/Dry labels, expected badge counts, nested buttons, live regions, document and badge overflow, browser errors, and external requests. A proposed-mode pass does not satisfy this step.

Inspect the saved full-page screenshots at all three widths. Verify neutral numbers, dot and label placement, KIWI's badge outside its history button, LSN50's badge inside its single row button, and visible depth and focus affordances. In pF mode, changing units must leave status unchanged; zero must show `0.0 kPa` with Wet and no invented pF value. Stale and future scenarios must show no badge. The fault scenario suppresses affected Chameleon badges while leaving valid readings on other devices visible.

The script checks document and badge overflow. In the browser, also inspect the relevant card containers' `scrollWidth <= clientWidth` and tab through KIWI's history control and the LSN50 row control at 390 and 320 px. Verify visible focus, one activation per row with Enter, and no badge tab stop. Existing device-header controls may truncate at 320 px independently of this feature; record that separately, and do not count it as badge overflow without evidence. Record the results alongside `checks.json`. A `flex-wrap` class assertion or screenshot alone cannot prove these interaction checks. The feature is not ready for product use until this actual-source implemented-mode gate passes.

- [ ] **Step 6: Review the committed feature diff and enforce its allowlist**

```bash
SWT_STATUS_GIT_DIR=$(git rev-parse --git-dir)
SWT_STATUS_BASE=$(cat "$SWT_STATUS_GIT_DIR/swt-water-status-base")
git diff --check "$SWT_STATUS_BASE"..HEAD
git diff "$SWT_STATUS_BASE"..HEAD -- \
  web/react-gui/src/utils/swt.ts \
  web/react-gui/src/utils/__tests__/swt.test.ts \
  web/react-gui/src/utils/zoneSoil.ts \
  web/react-gui/src/utils/__tests__/zoneSoil.test.ts \
  web/react-gui/src/components/farming

SWT_STATUS_UNEXPECTED=0
while IFS= read -r SWT_STATUS_PATH; do
  case "$SWT_STATUS_PATH" in
    web/react-gui/src/utils/swt.ts|\
    web/react-gui/src/utils/__tests__/swt.test.ts|\
    web/react-gui/src/utils/zoneSoil.ts|\
    web/react-gui/src/utils/__tests__/zoneSoil.test.ts|\
    web/react-gui/src/components/farming/shared/SwtStatusIndicator.tsx|\
    web/react-gui/src/components/farming/__tests__/SwtStatusIndicator.test.tsx|\
    web/react-gui/src/components/farming/KiwiSensorCard.tsx|\
    web/react-gui/src/components/farming/DraginoTempCard.tsx|\
    web/react-gui/src/components/farming/Sdi12SoilCard.tsx|\
    web/react-gui/src/components/farming/__tests__/KiwiSensorCard.test.tsx|\
    web/react-gui/src/components/farming/__tests__/DraginoTempCard.test.tsx|\
    web/react-gui/src/components/farming/__tests__/Sdi12SoilCard.test.tsx|\
    web/react-gui/src/components/farming/IrrigationZoneCard.tsx|\
    web/react-gui/src/components/farming/__tests__/IrrigationZoneCardSensorGating.test.tsx|\
    web/react-gui/src/components/farming/__tests__/IrrigationZoneCardLocale.test.tsx) ;;
    *) printf 'Unexpected feature path: %s\n' "$SWT_STATUS_PATH"; SWT_STATUS_UNEXPECTED=1 ;;
  esac
done < <(git diff --name-only "$SWT_STATUS_BASE"..HEAD)
test "$SWT_STATUS_UNEXPECTED" -eq 0
git status --short
```

Expected: base-relative whitespace validation exits 0, the reviewed diff contains all committed Tasks 1–5, and the allowlist prints no unexpected feature path. Inspect `git status --short` for unstaged feature edits and untracked browser artifacts; do not call the checkout clean merely because tracked paths are clean. The committed feature diff must not change `ui-core`, locale JSON, Node-RED, database, scheduler, history backend, or cloud files. Unrelated untracked artifacts in a shared checkout do not belong in this feature commit.

- [ ] **Step 7: Commit any verification-only test correction, then stop for review**

If Steps 1–6 required no source change, make no empty commit. If a defect requires a correction, return to the owning task's red/green test, stage only its listed feature files, commit it, and then repeat the affected checks plus the full browser matrix. Use this message only for that correction:

```bash
git commit -m "test(gui): close SWT status verification gap"
```

Hand the branch to a fresh reviewer for a hunk-by-hunk check against the spec before merge.
