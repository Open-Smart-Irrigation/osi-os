import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { devicesAPI } from '../../../services/api';
import type { Device } from '../../../types/farming';
import { LoRainGaugeCard } from '../LoRainGaugeCard';

vi.mock('../../../services/api', () => ({
  devicesAPI: {
    remove: vi.fn().mockResolvedValue(undefined),
  },
  getApiErrorMessage: (_err: unknown, fallback: string) => fallback,
}));

const lorainDevice: Device = {
  id: 1,
  deveui: '70B3D5E75E004201',
  name: 'North rain gauge',
  type_id: 'AQUASCOPE_LORAIN',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-05-01T00:00:00Z',
  irrigation_zone_id: null,
  is_claimed: true,
  claimed_by_username: 'test',
  claimed_by_user_uuid: 'uuid-1',
  dendro_ratio_at_retracted: null,
  dendro_ratio_at_extended: null,
  dendro_baseline_pending: false,
  last_seen: '2026-05-17T12:00:00Z',
  latest_data: {
    ambient_temperature: 20.5,
    bat_v: 3.3,
    rain_tips_delta: 3,
    rain_mm_delta: 1.5,
    rain_mm_per_10min: 1.5,
    rain_mm_today: 2.7,
    counter_interval_seconds: 600,
    rain_delta_status: 'ok',
  },
};

describe('LoRainGaugeCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders LoRain identity and rain telemetry', () => {
    render(<LoRainGaugeCard device={lorainDevice} />);

    expect(screen.getByText('North rain gauge')).toBeInTheDocument();
    expect(screen.getByText('LoRain')).toBeInTheDocument();
    expect(screen.getByText('70B3D5E75E004201')).toBeInTheDocument();
    expect(screen.getByText('1.5 mm')).toBeInTheDocument();
    expect(screen.getByText('2.7 mm')).toBeInTheDocument();
    expect(screen.getByText('1.5 mm / 10 min')).toBeInTheDocument();
    expect(screen.getByText('20.5 °C')).toBeInTheDocument();
    expect(screen.getByText(/3\.3 V/)).toBeInTheDocument();
  });

  it('handles missing telemetry without throwing', () => {
    render(<LoRainGaugeCard device={{ ...lorainDevice, latest_data: {} }} />);

    expect(screen.getByText('North rain gauge')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders invalid last-seen timestamps as never seen', () => {
    render(<LoRainGaugeCard device={{ ...lorainDevice, last_seen: 'not-a-date' }} />);

    expect(screen.getByText(/Never seen/)).toBeInTheDocument();
  });

  it('removes the device after confirmation', async () => {
    const onRemove = vi.fn();
    render(<LoRainGaugeCard device={lorainDevice} onRemove={onRemove} />);

    fireEvent.click(screen.getByTitle('Remove device'));
    fireEvent.click(screen.getByRole('button', { name: /yes, remove/i }));

    await waitFor(() => {
      expect(devicesAPI.remove).toHaveBeenCalledWith(lorainDevice.deveui);
    });
    expect(onRemove).toHaveBeenCalled();
  });

  it('clears confirmation state when removal succeeds without parent unmount', async () => {
    render(<LoRainGaugeCard device={lorainDevice} />);

    fireEvent.click(screen.getByTitle('Remove device'));
    fireEvent.click(screen.getByRole('button', { name: /yes, remove/i }));

    await waitFor(() => {
      expect(devicesAPI.remove).toHaveBeenCalledWith(lorainDevice.deveui);
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /yes, remove/i })).not.toBeInTheDocument();
    });
    expect(screen.getByTitle('Remove device')).toBeEnabled();
  });
});
