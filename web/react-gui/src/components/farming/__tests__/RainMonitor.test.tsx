import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sensorAPI, type SensorHistoryPoint } from '../../../services/api';
import { addDaysIso, localDayIso, type RainDay } from '../../../utils/rain';
import { RainMonitor } from '../RainMonitor';

vi.mock('../../../services/api', () => ({
  sensorAPI: {
    getHistory: vi.fn(),
    getDailyRainHistory: vi.fn(),
  },
}));

vi.mock('recharts', () => {
  const Container = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Leaf = () => null;
  return {
    Bar: Leaf,
    BarChart: () => <div data-testid="rain-bar-chart" />,
    CartesianGrid: Leaf,
    ResponsiveContainer: Container,
    Tooltip: Leaf,
    XAxis: Leaf,
    YAxis: Leaf,
  };
});

const INTERVAL_ROWS: SensorHistoryPoint[] = [
  { t: '2026-07-04T08:00:00Z', value: 0.5 },
  { t: '2026-07-04T08:10:00Z', value: 0 },
  { t: '2026-07-04T08:20:00Z', value: 1.5 },
];

function dailyRows(): RainDay[] {
  const today = localDayIso();
  return [
    { day: addDaysIso(today, -1), total_mm: 3.4, samples: 12 },
    { day: today, total_mm: 1.2, samples: 6 },
  ];
}

describe('RainMonitor', () => {
  beforeEach(() => {
    vi.mocked(sensorAPI.getHistory).mockReset();
    vi.mocked(sensorAPI.getDailyRainHistory).mockReset();
    vi.mocked(sensorAPI.getHistory).mockResolvedValue(INTERVAL_ROWS);
    vi.mocked(sensorAPI.getDailyRainHistory).mockResolvedValue(dailyRows());
  });

  it('loads 24 h interval deltas by default and summarizes them', async () => {
    render(<RainMonitor deveui="2CF7F1C0612345AB" deviceName="Orchard weather station" onClose={vi.fn()} />);

    expect(await screen.findByText('2.0 mm')).toBeInTheDocument(); // window total
    expect(screen.getByText('1.5 mm')).toBeInTheDocument(); // peak interval
    expect(screen.getByText('WET INTERVALS')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByTestId('rain-bar-chart')).toBeInTheDocument();
    expect(sensorAPI.getHistory).toHaveBeenCalledWith('2CF7F1C0612345AB', 'rain_mm_delta', 24);
    expect(sensorAPI.getDailyRainHistory).not.toHaveBeenCalled();
  });

  it('switches to daily totals for the 7 d window and zero-fills the window', async () => {
    render(<RainMonitor deveui="2CF7F1C0612345AB" deviceName="Orchard weather station" onClose={vi.fn()} />);
    await screen.findByText('2.0 mm');

    fireEvent.click(screen.getByRole('button', { name: '7 d' }));

    expect(await screen.findByText('4.6 mm')).toBeInTheDocument(); // window total
    expect(screen.getByText('3.4 mm')).toBeInTheDocument(); // wettest day
    expect(screen.getByText('RAINY DAYS')).toBeInTheDocument();
    expect(screen.getByText(/7 days · daily totals/)).toBeInTheDocument();
    expect(sensorAPI.getDailyRainHistory).toHaveBeenCalledWith('2CF7F1C0612345AB', 7, expect.any(Number));
  });

  it('shows an empty state when no daily rainfall rows exist', async () => {
    vi.mocked(sensorAPI.getDailyRainHistory).mockResolvedValue([]);
    render(<RainMonitor deveui="2CF7F1C0612345AB" deviceName="Orchard weather station" onClose={vi.fn()} />);
    await screen.findByText('2.0 mm');

    fireEvent.click(screen.getByRole('button', { name: '30 d' }));

    expect(await screen.findByText('No rainfall recorded in this window.')).toBeInTheDocument();
    expect(screen.queryByTestId('rain-bar-chart')).not.toBeInTheDocument();
  });

  it('surfaces fetch errors', async () => {
    vi.mocked(sensorAPI.getHistory).mockRejectedValue(new Error('boom'));
    render(<RainMonitor deveui="2CF7F1C0612345AB" deviceName="Orchard weather station" onClose={vi.fn()} />);

    expect(await screen.findByText('boom')).toBeInTheDocument();
  });

  it('excludes a samples === 0 (no-data) day from the daily summary tiles', async () => {
    // Same wettest-day total (3.4mm) as dailyRows(), plus one extra day that
    // has samples === 0 (station offline / no valid uplinks that day) and a
    // real measured-dry day (samples > 0, total_mm 0) mixed in. The no-data
    // day must not inflate RAINY DAYS or the window total, and must not win
    // wettest-day selection by virtue of being a "0.0 mm" entry.
    const today = localDayIso();
    vi.mocked(sensorAPI.getDailyRainHistory).mockResolvedValue([
      { day: addDaysIso(today, -2), total_mm: 0, samples: 0 }, // no data
      { day: addDaysIso(today, -1), total_mm: 3.4, samples: 12 }, // wettest
      { day: today, total_mm: 0, samples: 6 }, // measured dry
    ]);
    render(<RainMonitor deveui="2CF7F1C0612345AB" deviceName="Orchard weather station" onClose={vi.fn()} />);
    await screen.findByText('2.0 mm');

    fireEvent.click(screen.getByRole('button', { name: '7 d' }));

    await screen.findByText('RAINY DAYS');
    // Window total and wettest day are both 3.4 mm (the only rainy day) —
    // two tiles render the same text.
    expect(screen.getAllByText('3.4 mm')).toHaveLength(2);
    expect(screen.getByText('1')).toBeInTheDocument(); // only the wettest day counts as rainy
  });
});
