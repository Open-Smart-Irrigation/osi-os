import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sensorAPI, type SensorHistoryPoint } from '../../../services/api';
import type { WindRose } from '../../../utils/wind';
import { WindMonitor } from '../WindMonitor';

const { windRoseChartShouldThrow } = vi.hoisted(() => ({
  windRoseChartShouldThrow: { current: false },
}));

vi.mock('../../../services/api', () => ({
  sensorAPI: {
    getHistory: vi.fn(),
  },
}));

vi.mock('../WindRoseChart', () => ({
  WindRoseChart: ({ rose }: { rose: WindRose }) => {
    if (windRoseChartShouldThrow.current) {
      throw new Error('chart chunk failed');
    }
    return <div data-testid="wind-rose-chart">{rose.validSamples} samples · {Math.round(rose.calmPct)}% calm</div>;
  },
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

function offsetRows(field: 'speed' | 'gust' | 'direction', count: number): SensorHistoryPoint[] {
  return Array.from({ length: count }, (_, index) => ({
    t: `2026-07-02T${String(index).padStart(2, '0')}:30:00Z`,
    value: field === 'direction' ? (index * 30) % 360 : field === 'gust' ? 4 + index * 0.1 : 2 + index * 0.1,
  }));
}

describe('WindMonitor', () => {
  beforeEach(() => {
    windRoseChartShouldThrow.current = false;
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

  it('shows a fallback when fewer than ten paired wind samples load', async () => {
    vi.mocked(sensorAPI.getHistory).mockImplementation((_deveui, field) => {
      if (field === 'wind_speed_mps') return Promise.resolve(rows('speed', 9));
      if (field === 'wind_gust_mps') return Promise.resolve(rows('gust', 9));
      if (field === 'wind_direction_deg') return Promise.resolve(rows('direction', 9));
      return Promise.resolve([]);
    });

    render(<WindMonitor deveui="70B3D57ED0060123" deviceName="North weather station" onClose={vi.fn()} />);

    expect(await screen.findByText('Not enough wind data to plot a rose in this window.')).toBeInTheDocument();
    expect(screen.queryByTestId('wind-rose-chart')).not.toBeInTheDocument();
  });

  it('renders the wind rose at the ten-sample boundary', async () => {
    vi.mocked(sensorAPI.getHistory).mockImplementation((_deveui, field) => {
      if (field === 'wind_speed_mps') return Promise.resolve(rows('speed', 10));
      if (field === 'wind_gust_mps') return Promise.resolve(rows('gust', 10));
      if (field === 'wind_direction_deg') return Promise.resolve(rows('direction', 10));
      return Promise.resolve([]);
    });

    render(<WindMonitor deveui="70B3D57ED0060123" deviceName="North weather station" onClose={vi.fn()} />);

    expect(await screen.findByTestId('wind-rose-chart')).toHaveTextContent('10 samples · 0% calm');
    expect(screen.queryByText('Not enough wind data to plot a rose in this window.')).not.toBeInTheDocument();
  });

  it('pairs long-window speed buckets with direction samples inside the same buckets', async () => {
    vi.mocked(sensorAPI.getHistory).mockImplementation((_deveui, field, hours) => {
      if (hours === 168 && field === 'wind_speed_mps') return Promise.resolve(rows('speed', 12));
      if (hours === 168 && field === 'wind_gust_mps') return Promise.resolve(rows('gust', 12));
      if (hours === 168 && field === 'wind_direction_deg') return Promise.resolve(offsetRows('direction', 12));
      return Promise.resolve([]);
    });

    render(<WindMonitor deveui="70B3D57ED0060123" deviceName="North weather station" onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '7 d' }));

    expect(await screen.findByTestId('wind-rose-chart')).toHaveTextContent('12 samples · 0% calm');
  });

  it('keeps the modal usable when the lazy wind rose chart fails to render', async () => {
    const preventErrorReport = (event: ErrorEvent) => event.preventDefault();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    window.addEventListener('error', preventErrorReport);

    try {
      windRoseChartShouldThrow.current = true;

      render(<WindMonitor deveui="70B3D57ED0060123" deviceName="North weather station" onClose={vi.fn()} />);

      expect(await screen.findByText('Unable to load wind rose chart.')).toBeInTheDocument();
      expect(screen.getByText('Speed and gust (m/s)')).toBeInTheDocument();
    } finally {
      window.removeEventListener('error', preventErrorReport);
      consoleError.mockRestore();
    }
  });
});
