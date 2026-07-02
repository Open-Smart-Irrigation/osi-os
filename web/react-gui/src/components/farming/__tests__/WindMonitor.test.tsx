import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sensorAPI, type SensorHistoryPoint } from '../../../services/api';
import type { WindRose } from '../../../utils/wind';
import { WindMonitor } from '../WindMonitor';

vi.mock('../../../services/api', () => ({
  sensorAPI: {
    getHistory: vi.fn(),
  },
}));

vi.mock('../WindRoseChart', () => ({
  WindRoseChart: ({ rose }: { rose: WindRose }) => (
    <div data-testid="wind-rose-chart">{rose.validSamples} samples · {Math.round(rose.calmPct)}% calm</div>
  ),
}));

vi.mock('recharts', () => {
  const Container = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  const Leaf = () => null;

  return {
    Area: Leaf,
    CartesianGrid: Leaf,
    ComposedChart: () => <div data-testid="wind-speed-chart" />,
    Line: Leaf,
    ResponsiveContainer: Container,
    Tooltip: Leaf,
    XAxis: Leaf,
    YAxis: Leaf,
  };
});

function rows(field: 'speed' | 'gust' | 'direction', count: number): SensorHistoryPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    t: `2026-07-02T${String(index).padStart(2, '0')}:00:00Z`,
    value: field === 'direction' ? (index * 30) % 360 : field === 'gust' ? 4 + index * 0.1 : 2 + index * 0.1,
  }));
}

describe('WindMonitor', () => {
  beforeEach(() => {
    vi.mocked(sensorAPI.getHistory).mockReset();
    vi.mocked(sensorAPI.getHistory).mockImplementation((_deveui, field, hours) => {
      const count = hours === 24 ? 12 : 0;
      if (field === 'wind_speed_mps') return Promise.resolve(rows('speed', count));
      if (field === 'wind_gust_mps') return Promise.resolve(rows('gust', count));
      if (field === 'wind_direction_deg') return Promise.resolve(rows('direction', count));
      return Promise.resolve([]);
    });
  });

  it('renders a wind rose instead of the direction-history arrow grid when enough wind samples load', async () => {
    render(<WindMonitor deveui="70B3D57ED0060123" deviceName="North weather station" onClose={vi.fn()} />);

    expect(await screen.findByText('Wind rose (direction × speed)')).toBeInTheDocument();
    expect(await screen.findByTestId('wind-rose-chart')).toHaveTextContent('12 samples · 0% calm');
    expect(screen.queryByText('Direction history')).not.toBeInTheDocument();
  });
});
