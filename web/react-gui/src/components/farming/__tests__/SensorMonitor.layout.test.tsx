// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

const translation = { t: (key: string) => key, i18n: { language: 'en' } };
vi.mock('react-i18next', () => ({ useTranslation: () => translation }));

const { getHistory } = vi.hoisted(() => ({ getHistory: vi.fn() }));
vi.mock('../../../services/api', () => ({ sensorAPI: { getHistory } }));
vi.mock('../../../hooks/useModalFocus', () => ({ useModalFocus: () => undefined }));
vi.mock('../../../utils/datetime', () => ({ useDateFormat: () => ({ time: (value: string) => value, date: (value: string) => value }) }));

const yAxisWidths: Array<number | undefined> = [];
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  AreaChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Area: () => null,
  XAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  YAxis: ({ width }: { width?: number }) => { yAxisWidths.push(width); return null; },
}));

import { SensorMonitor } from '../SensorMonitor';

afterEach(() => {
  cleanup();
  getHistory.mockReset();
  yAxisWidths.length = 0;
  localStorage.clear();
});

const LONG_NAME = 'Soil probe at the far north-eastern corner of the lower block';

describe('SensorMonitor layout on a narrow screen', () => {
  test('truncates the title and device line with the full text in their titles', async () => {
    getHistory.mockResolvedValue([{ t: '2026-10-06T06:00:00Z', value: 22.5 }]);
    render(<SensorMonitor deveui="TEST-DEVICE-01" deviceName={LONG_NAME} field="vwc_1" label="Volumetric water content at 10 cm" unit="%" onClose={() => {}} />);
    const title = await screen.findByRole('heading', { level: 2 });
    expect(title).toHaveClass('truncate');
    expect(title).toHaveAttribute('title', 'Volumetric water content at 10 cm');
    expect(title.parentElement).toHaveClass('min-w-0');
    const deviceLine = screen.getByText(`${LONG_NAME} · TEST-DEVICE-01`);
    expect(deviceLine).toHaveClass('truncate');
    expect(deviceLine).toHaveAttribute('title', `${LONG_NAME} · TEST-DEVICE-01`);
    expect(screen.getByRole('button', { name: 'close' })).toHaveClass('shrink-0');
  });

  test('lets a stat unit wrap below its number instead of breaking the number', async () => {
    getHistory.mockResolvedValue([{ t: '2026-10-06T06:00:00Z', value: 85.3 }]);
    render(<SensorMonitor deveui="TEST-DEVICE-01" deviceName="Probe" field="ec" label="EC" unit="mS/cm" onClose={() => {}} />);
    const stats = await screen.findAllByText((_, el) => el?.tagName === 'P' && el.textContent === '85.3 mS/cm');
    expect(stats).toHaveLength(3);
    for (const stat of stats) {
      expect(stat).toHaveClass('flex-wrap');
      expect(stat.firstElementChild).toHaveClass('whitespace-nowrap');
    }
  });

  test('sizes the value axis to the labels instead of a fixed 52 px', async () => {
    getHistory.mockResolvedValue([{ t: '2026-10-06T06:00:00Z', value: 1250.5 }, { t: '2026-10-06T07:00:00Z', value: 14800.25 }]);
    render(<SensorMonitor deveui="TEST-DEVICE-01" deviceName="Probe" field="lux" label="Light" unit="lx" decimals={1} onClose={() => {}} />);
    await screen.findByRole('heading', { level: 3 });
    expect(yAxisWidths[yAxisWidths.length - 1]).toBeGreaterThan(52);
  });

  test('keeps a compact value axis for small numbers', async () => {
    getHistory.mockResolvedValue([{ t: '2026-10-06T06:00:00Z', value: 2 }, { t: '2026-10-06T07:00:00Z', value: 8 }]);
    render(<SensorMonitor deveui="TEST-DEVICE-01" deviceName="Probe" field="ec" label="EC" unit="mS/cm" decimals={0} onClose={() => {}} />);
    await screen.findByRole('heading', { level: 3 });
    expect(yAxisWidths[yAxisWidths.length - 1]).toBeLessThan(52);
  });
});
