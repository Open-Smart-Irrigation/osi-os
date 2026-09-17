// @vitest-environment jsdom
//
// F100/X-01/X-16 (overnight 2026-09-17, T13m): for a linked gateway the
// cloud decides the water action and ships an English `reasoning` sentence
// on `water.action.reasoning`. The Water tab's "7-day water trend" note and
// the "Balance" tile's detail line both used to print that sentence, or the
// action's verb, without checking for a reason code or an insufficient-data
// source. These pin the same honesty rules IrrigationZoneCardLocale.test.tsx
// pins for the zone card's own water-balance subtitle and action tile.
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import { WaterTab } from '../environment/WaterTab';
import type { WaterAction, WaterEnvironment } from '../../../types/farming';

import enDevices from '../../../../public/locales/en/devices.json';
import frDevices from '../../../../public/locales/fr/devices.json';

vi.mock('recharts', () => {
  const Leaf = () => null;
  return {
    Bar: Leaf,
    BarChart: Leaf,
    CartesianGrid: Leaf,
    ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    Tooltip: Leaf,
    XAxis: Leaf,
    YAxis: Leaf,
  };
});

// The literal sentence ZoneEnvironmentService.resolveWaterAction ships today
// (a0161cad:422), curly apostrophe and all.
const CLOUD_FABRICATED_REASONING = 'Available rain and effective irrigation cover today’s estimated demand.';

function water(action: WaterAction | null): WaterEnvironment {
  return {
    available: true,
    observedAt: '2026-05-29T10:00:00.000Z',
    areaM2: 100,
    irrigationEfficiencyPct: 80,
    rainTodayMm: 2,
    irrigationTodayMeasuredLiters: 40,
    irrigationTodayEstimatedLiters: 75,
    measuredIrrigationNetMm: 0.32,
    estimatedIrrigationNetMm: 0.6,
    waterNeededTodayMm: 4,
    balanceTodayMm: -3.08,
    next24hRainMm: 1,
    action,
    daily: [{ date: '2026-05-28', rainMm: 0 }, { date: '2026-05-29', rainMm: 2 }],
    sensorHealth: {
      sensorCount: 1, freshSensorCount: 1, staleSensorCount: 0,
      rainGaugePresent: true, flowMeterPresent: true, warnings: [],
    },
  } as unknown as WaterEnvironment;
}

async function buildI18n(language: string) {
  const instance = i18next.createInstance();
  await instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['devices'],
    defaultNS: 'devices',
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
    resources: { en: { devices: enDevices }, fr: { devices: frDevices } },
  });
  return instance;
}

async function renderTrend(action: WaterAction | null, language: string) {
  const instance = await buildI18n(language);
  render(
    <I18nextProvider i18n={instance}>
      <WaterTab water={water(action)} />
    </I18nextProvider>,
  );
}

describe('WaterTab reason-code honesty (F100/X-01)', () => {
  it('suppresses the cloud bundle\'s fabricated reasoning prose even when a code is attached', async () => {
    await renderTrend(
      { code: 'delay_irrigation', source: 'heuristic', reasoning: CLOUD_FABRICATED_REASONING, recommendationDate: null },
      'fr',
    );
    expect(screen.queryByText(CLOUD_FABRICATED_REASONING)).not.toBeInTheDocument();
    expect(screen.getByText(frDevices.zone.water.reason.default)).toBeInTheDocument();
  });

  it('prefers a reasonCode and translates it over any raw reasoning text', async () => {
    await renderTrend(
      {
        code: 'delay_irrigation',
        source: 'heuristic',
        reasonCode: 'demand_exceeds_supply',
        reasoning: CLOUD_FABRICATED_REASONING,
        recommendationDate: null,
      },
      'fr',
    );
    expect(screen.getByText(frDevices.zone.water.reason.demand_exceeds_supply)).toBeInTheDocument();
    expect(screen.queryByText(CLOUD_FABRICATED_REASONING)).not.toBeInTheDocument();
  });

  it('still shows dendrometer-sourced reasoning verbatim', async () => {
    await renderTrend(
      { code: 'irrigate_today', source: 'dendro', reasoning: 'Tree 4 crossed its stress threshold overnight.', recommendationDate: null },
      'fr',
    );
    expect(screen.getByText('Tree 4 crossed its stress threshold overnight.')).toBeInTheDocument();
  });

  it('shows no action verb on the balance tile when the cloud source is insufficient_data', async () => {
    await renderTrend(
      { code: 'delay_irrigation', source: 'insufficient_data', reasonCode: 'balance_unknown', reasoning: null, recommendationDate: null },
      'fr',
    );
    expect(screen.queryByText(frDevices.zone.water.action.delay_irrigation)).not.toBeInTheDocument();
  });

  it('renders the translated action verb on the balance tile for a resolved, non-insufficient source', async () => {
    await renderTrend(
      { code: 'delay_irrigation', source: 'heuristic', reasonCode: 'demand_exceeds_supply', reasoning: null, recommendationDate: null },
      'fr',
    );
    expect(screen.getByText(frDevices.zone.water.action.delay_irrigation)).toBeInTheDocument();
  });
});
