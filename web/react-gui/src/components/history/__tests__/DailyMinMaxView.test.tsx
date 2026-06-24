import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { buildNumericRows, DailyMinMaxView, expandSinglePointRows } from '../visualizations/DailyMinMaxView';
import type { HistoryCardDataResponse } from '../../../history/types';

const { translateForTest } = vi.hoisted(() => {
  const translations: Record<string, string> = {
    'history.dailyMinMax.title': 'Daily Min/Max',
    'history.dailyMinMax.emptyTitle': 'No daily min/max data',
    'history.dailyMinMax.emptyBody': 'Daily minimum and maximum readings are not available for this range.',
    'history.dailyMinMax.pointsCount': '{{count}} days',
    'history.dailyMinMax.axisLabel': '{{unit}}',
    'history.dailyMinMax.axisNoUnit': 'Value',
    'history.dailyMinMax.series.environment': 'Environment',
    'history.dailyMinMax.series.airTemperature': 'Air temperature',
    'history.dailyMinMax.tooltipMin': 'Min',
    'history.dailyMinMax.tooltipMax': 'Max',
    'history.dailyMinMax.tooltipMean': 'Mean',
    'history.cardFrame.placeholderBody': 'Charts for this view load here when card data APIs are enabled.',
  };

  return {
    translateForTest: (key: string, options?: Record<string, unknown>): string => {
      const template = translations[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ''));
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translateForTest }),
}));

vi.mock('recharts', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('recharts');
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});

function data(): HistoryCardDataResponse {
  return {
    schemaVersion: 1,
    cardId: 'zone-1:environment:merged',
    cardType: 'environment',
    scope: { type: 'zone', zoneId: 1 },
    range: {
      key: '7d',
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-03T00:00:00.000Z',
      timezone: 'UTC',
    },
    aggregation: {
      level: 'daily',
      bucketSizeSeconds: 86400,
      isApproximate: false,
      availableLevels: ['daily'],
      dominantStatusMethod: null,
    },
    limits: { maxPointsPerSeries: 1000, maxEvents: 100, maxInterpretations: 20, truncated: false },
    freshness: { generatedAt: '2026-06-03T00:00:00.000Z', syncState: 'local' },
    series: [
      {
        id: 'air_temperature',
        label: 'Air temperature',
        unit: 'C',
        points: [
          { t: '2026-06-01T00:00:00.000Z', min: 11, max: 24, mean: 17 },
          { t: '2026-06-02T00:00:00.000Z', min: 12, max: 26, mean: 18 },
        ],
      },
    ],
    events: [],
    interpretations: [],
    profiles: [],
    calendar: null,
    advanced: null,
  } as unknown as HistoryCardDataResponse;
}

describe('DailyMinMaxView', () => {
  it('rows carry epoch-ms timestamps for numeric axis clipping', () => {
    const rows = buildNumericRows({
      key: 'daily-temp',
      label: 'Air temperature',
      unit: 'C',
      points: [{ t: '2026-06-01T00:00:00Z', min: 11, max: 24, mean: 17 }],
    });

    expect(rows[0].tMs).toBe(Date.parse('2026-06-01T00:00:00Z'));
  });

  it('expands a single daily bucket into a segment so Recharts does not force dots', () => {
    const rows = buildNumericRows({
      key: 'daily-temp',
      label: 'Air temperature',
      unit: 'C',
      points: [{ t: '2026-06-01T00:00:00Z', min: 11, max: 24, mean: 17 }],
    });

    const expanded = expandSinglePointRows(rows);

    expect(expanded).toHaveLength(2);
    expect(expanded[0].tMs).toBeLessThan(rows[0].tMs);
    expect(expanded[1].tMs).toBeGreaterThan(rows[0].tMs);
    expect(expanded[0]['daily-temp-min']).toBe(11);
    expect(expanded[1]['daily-temp-max']).toBe(24);
    expect(expanded[1]['daily-temp-mean']).toBe(17);
  });

  it('renders min/max data as a real chart instead of a placeholder', () => {
    render(<DailyMinMaxView data={data()} />);

    expect(screen.getByRole('region', { name: /daily min\/max/i })).toBeInTheDocument();
    expect(screen.queryByText('Daily Min/Max')).not.toBeInTheDocument();
    expect(screen.queryByText(/\bdays\b/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Air temperature')).not.toBeInTheDocument();
    expect(screen.queryByText('11-24 C')).not.toBeInTheDocument();
    expect(screen.queryByText('12-26 C')).not.toBeInTheDocument();
    expect(screen.queryByText(/load here when card data APIs are enabled/i)).not.toBeInTheDocument();
  });
});
