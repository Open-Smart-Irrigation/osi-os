import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { sensorAPI, type SensorHistoryPoint } from '../../../services/api';
import type { RainHistory, RainHistoryDay } from '../../../utils/rain';
import { RainMonitor } from '../RainMonitor';

// The viewer sits far from the farm: day labels and the window must still be
// the farm's own days from the gateway, never the browser's.
(globalThis as unknown as { process: { env: Record<string, string> } }).process.env.TZ = 'America/Los_Angeles';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown>) =>
      String(options?.defaultValue ?? _key).replace(/\{\{(\w+)\}\}/g, (_m, name) => String(options?.[name] ?? '')),
  }),
}));

vi.mock('../../../services/api', () => ({
  sensorAPI: {
    getHistory: vi.fn(),
    getDailyRainHistory: vi.fn(),
  },
}));

// The chart stub renders what the real chart is given: the rows (bar values),
// the formatted day ticks, and the tooltip of the last bar.
vi.mock('recharts', () => {
  let rows: Array<Record<string, unknown>> = [];
  const Container = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Leaf = () => null;
  const BarChart = ({ data, children }: { data: Array<Record<string, unknown>>; children?: React.ReactNode }) => {
    rows = data;
    return (
      <div data-testid="rain-bar-chart" data-rows={JSON.stringify(data)}>
        {children}
      </div>
    );
  };
  const XAxis = ({ dataKey, tickFormatter }: { dataKey: string; tickFormatter?: (value: string) => string }) => (
    <ol data-testid="rain-x-ticks">
      {rows.map((row) => {
        const value = String(row[dataKey]);
        return <li key={value}>{tickFormatter ? tickFormatter(value) : value}</li>;
      })}
    </ol>
  );
  const Tooltip = ({ content }: { content?: React.ReactElement<Record<string, unknown>> }) => {
    if (!content || !rows.length) return null;
    const last = rows[rows.length - 1];
    return (
      <div data-testid="rain-last-tooltip">
        {React.cloneElement(content, { active: true, payload: [{ payload: last, value: last.total_mm }], label: last.day })}
      </div>
    );
  };
  return { Bar: Leaf, BarChart, CartesianGrid: Leaf, ResponsiveContainer: Container, Tooltip, XAxis, YAxis: Leaf };
});

const INTERVAL_ROWS: SensorHistoryPoint[] = [
  { t: '2026-07-04T08:00:00Z', value: 0.5 },
  { t: '2026-07-04T08:10:00Z', value: 0 },
  { t: '2026-07-04T08:20:00Z', value: 1.5 },
];

// 7 Zurich days ending 2026-07-02. The browser clock says 2026-07-02T05:00Z,
// which is still 1 July in Los Angeles.
const DAY_KEYS = ['2026-06-26', '2026-06-27', '2026-06-28', '2026-06-29', '2026-06-30', '2026-07-01', '2026-07-02'];

function history(overrides: Partial<Record<string, [number | null, number]>> = {}, extra: Partial<RainHistory> = {}): RainHistory {
  const values: Record<string, [number | null, number]> = {
    '2026-06-30': [0, 4],
    '2026-07-01': [3.4, 12],
    '2026-07-02': [1.2, 6],
    ...overrides,
  } as Record<string, [number | null, number]>;
  const days: RainHistoryDay[] = DAY_KEYS.map((day, index) => {
    const [total, samples] = values[day] ?? [null, 0];
    return {
      day,
      period_start: null,
      period_end: null,
      total_mm: total,
      samples,
      quality: 'received_only',
      so_far: index === DAY_KEYS.length - 1,
    };
  });
  return {
    timezone: 'Europe/Zurich',
    timezoneBasis: 'zone',
    periodStart: '2026-06-25T22:00:00.000Z',
    periodEnd: '2026-07-02T05:00:00.000Z',
    days,
    ...extra,
  };
}

function chartRows(): Array<{ day: string; total_mm: number | null }> {
  return JSON.parse(screen.getByTestId('rain-bar-chart').getAttribute('data-rows') || '[]');
}

async function openWeek() {
  render(<RainMonitor deveui="A840410000000001" deviceName="Orchard gauge" onClose={vi.fn()} />);
  await screen.findByText('2.0 mm');
  fireEvent.click(screen.getByRole('button', { name: '7 d' }));
  await screen.findByText('RAINY DAYS');
}

describe('RainMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-07-02T05:00:00.000Z'));
    vi.mocked(sensorAPI.getHistory).mockReset();
    vi.mocked(sensorAPI.getDailyRainHistory).mockReset();
    vi.mocked(sensorAPI.getHistory).mockResolvedValue(INTERVAL_ROWS);
    vi.mocked(sensorAPI.getDailyRainHistory).mockResolvedValue(history());
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('loads 24 h interval deltas by default and summarizes them', async () => {
    render(<RainMonitor deveui="A840410000000001" deviceName="Orchard gauge" onClose={vi.fn()} />);

    expect(await screen.findByText('2.0 mm')).toBeInTheDocument(); // window total
    expect(screen.getByText('1.5 mm')).toBeInTheDocument(); // peak interval
    expect(screen.getByText('WET INTERVALS')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(sensorAPI.getHistory).toHaveBeenCalledWith('A840410000000001', 'rain_mm_delta', 24);
    expect(sensorAPI.getDailyRainHistory).not.toHaveBeenCalled();
  });

  it('asks the gateway for the farm days without a browser offset', async () => {
    await openWeek();

    expect(sensorAPI.getDailyRainHistory).toHaveBeenCalledWith('A840410000000001', 7);
    expect(vi.mocked(sensorAPI.getDailyRainHistory).mock.calls[0]).toHaveLength(2);
    expect(screen.getByText('4.6 mm')).toBeInTheDocument(); // window total
    expect(screen.getByText('3.4 mm')).toBeInTheDocument(); // wettest day
    expect(screen.getByText('7 days · daily totals (Europe/Zurich)')).toBeInTheDocument();
  });

  it("renders the server's days, labelled without the browser zone", async () => {
    await openWeek();

    expect(chartRows().map((row) => row.day)).toEqual(DAY_KEYS);
    const ticks = Array.from(screen.getByTestId('rain-x-ticks').querySelectorAll('li')).map((li) => li.textContent);
    expect(ticks).toEqual(['Jun 26', 'Jun 27', 'Jun 28', 'Jun 29', 'Jun 30', 'Jul 1', 'Jul 2']);
  });

  it('draws no bar for a no-data day and keeps a measured dry day at zero', async () => {
    await openWeek();

    const rows = chartRows();
    expect(rows.find((row) => row.day === '2026-06-29')?.total_mm).toBeNull();
    expect(rows.find((row) => row.day === '2026-06-30')?.total_mm).toBe(0);
  });

  it('labels the last day "so far"', async () => {
    await openWeek();

    expect(screen.getByTestId('rain-last-tooltip')).toHaveTextContent('1.2 mm · so far');
  });

  it('asks to check the zone time zone when it is an abbreviation or invalid', async () => {
    vi.mocked(sensorAPI.getDailyRainHistory).mockResolvedValue(history({}, { timezone: 'CET', timezoneBasis: 'abbreviation' }));
    await openWeek();

    expect(screen.getByText('7 days · daily totals (CET)')).toBeInTheDocument();
    expect(screen.getByText('Check the zone time zone in its settings.')).toBeInTheDocument();
  });

  it('does not ask for a check when the zone has a region name', async () => {
    await openWeek();

    expect(screen.queryByText('Check the zone time zone in its settings.')).not.toBeInTheDocument();
  });

  it('shows an empty state when no day of the window has data', async () => {
    vi.mocked(sensorAPI.getDailyRainHistory).mockResolvedValue(
      history({ '2026-06-30': [null, 0], '2026-07-01': [null, 0], '2026-07-02': [null, 0] }),
    );
    render(<RainMonitor deveui="A840410000000001" deviceName="Orchard gauge" onClose={vi.fn()} />);
    await screen.findByText('2.0 mm');

    fireEvent.click(screen.getByRole('button', { name: '30 d' }));

    expect(await screen.findByText('No rainfall recorded in this window.')).toBeInTheDocument();
    expect(screen.queryByTestId('rain-bar-chart')).not.toBeInTheDocument();
  });

  it('surfaces fetch errors', async () => {
    vi.mocked(sensorAPI.getHistory).mockRejectedValue(new Error('boom'));
    render(<RainMonitor deveui="A840410000000001" deviceName="Orchard gauge" onClose={vi.fn()} />);

    expect(await screen.findByText('boom')).toBeInTheDocument();
  });

  it('excludes a no-data day from the daily summary tiles', async () => {
    vi.mocked(sensorAPI.getDailyRainHistory).mockResolvedValue(
      history({ '2026-06-30': [null, 0], '2026-07-01': [3.4, 12], '2026-07-02': [0, 6] }),
    );
    await openWeek();

    // Window total and wettest day are both 3.4 mm (the only rainy day).
    expect(screen.getAllByText('3.4 mm')).toHaveLength(2);
    expect(screen.getByText('1')).toBeInTheDocument();
  });
});
