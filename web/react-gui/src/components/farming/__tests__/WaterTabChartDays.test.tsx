// @vitest-environment jsdom
//
// F41 (overnight 2026-09-17): the water chart labelled each bar with
// `fmt.date(day.date)`, and `day.date` is a bare `YYYY-MM-DD` calendar day.
// `new Date('2026-05-29')` is UTC midnight, so west of Greenwich every bar was
// labelled with the previous day.
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import { WaterTab } from '../environment/WaterTab';
import type { WaterEnvironment } from '../../../types/farming';

// The day labels come from the main x axis' tickFormatter (the plot prints
// "Today" for today's row), so the mock chart hands its rows to the axis and
// the axis prints what the formatter makes of each row's date.
vi.mock('recharts', async () => {
  const React = await import('react');
  const Leaf = () => null;
  type Row = { date: string };
  const XAxis = ({ xAxisId, tickFormatter, rows }: { xAxisId?: string; tickFormatter?: (value: string) => string; rows?: Row[] }) => (
    xAxisId ? null : <div data-testid="water-chart" data-days={JSON.stringify((rows ?? []).map((row) => tickFormatter?.(row.date) ?? row.date))} />
  );
  return {
    Bar: Leaf,
    BarChart: ({ data, children }: { data?: Row[]; children?: React.ReactNode }) => (
      <div>
        {React.Children.map(children, (child) => (
          React.isValidElement(child) && child.type === XAxis
            ? React.cloneElement(child as React.ReactElement<{ rows?: Row[] }>, { rows: data ?? [] })
            : child
        ))}
      </div>
    ),
    CartesianGrid: Leaf,
    Legend: Leaf,
    ReferenceLine: Leaf,
    ResponsiveContainer: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
    Tooltip: Leaf,
    XAxis,
    YAxis: Leaf,
  };
});

const water = (): WaterEnvironment => ({
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
  action: null,
  daily: [
    { date: '2026-05-28', rainMm: 0 },
    { date: '2026-05-29', rainMm: 2 },
  ],
  sensorHealth: {
    sensorCount: 1, freshSensorCount: 1, staleSensorCount: 0,
    rainGaugePresent: true, flowMeterPresent: true, warnings: [],
  },
} as unknown as WaterEnvironment);

async function englishI18n() {
  const instance = i18next.createInstance();
  await instance.use(initReactI18next).init({
    lng: 'en', fallbackLng: 'en', ns: ['devices'], defaultNS: 'devices',
    resources: { en: { devices: {} } },
  });
  return instance;
}

const chartDays = () => JSON.parse(screen.getByTestId('water-chart').getAttribute('data-days') ?? '[]');

describe('WaterTab chart day labels', () => {
  // Zone-independent once the dates are anchored at local noon: every run,
  // in every zone, must label the two rows with the days they name. Vitest
  // workers cache the timezone, so the negative-UTC reproduction runs from
  // the environment: TZ=America/Anchorage npx vitest run <this file>, which
  // reported ['May 27', 'May 28'] before the fix.
  it('labels each bar with the calendar day its row names', async () => {
    const i18n = await englishI18n();
    render(<I18nextProvider i18n={i18n}><WaterTab water={water()} /></I18nextProvider>);
    expect(chartDays()).toEqual(['May 28', 'May 29']);
  });

  it("labels today's row \"Today\" and every other row with its calendar day", async () => {
    const i18n = await englishI18n();
    render(<I18nextProvider i18n={i18n}><WaterTab water={{ ...water(), todayDate: '2026-05-29' }} /></I18nextProvider>);
    expect(chartDays()).toEqual(['May 28', 'Today']);
  });
});
