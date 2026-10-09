import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { devicesAPI } from '../../../services/api';
import type { Device } from '../../../types/farming';
import { LoRainGaugeCard } from '../LoRainGaugeCard';

// t() returns the key itself, matching this codebase's convention; a count is appended
// so the tip line can be asserted.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options && options.count != null ? `${options.count} ${key}` : key),
  }),
}));

vi.mock('../../../services/api', () => ({
  devicesAPI: {
    remove: vi.fn().mockResolvedValue(undefined),
  },
  sensorAPI: { getHistory: vi.fn().mockResolvedValue([]) },
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
  dendro_baseline_pending: 0,
  last_seen: '2026-05-17T12:00:00Z',
  latest_data: {
    ambient_temperature: 20.5,
    bat_v: 3.3,
    rain_tips_delta: 3,
    rain_mm_delta: 1.5,
    rain_mm_per_10min: 1.5,
    rain_mm_today: 2.7,
    rain_day: '2026-05-17',
    rain_day_timezone: 'UTC',
    rain_day_timezone_basis: 'zone',
    counter_interval_seconds: 600,
    rain_delta_status: 'ok',
  },
} as unknown as Device;

// The "today" tile compares rain_day with the farm date of Date.now().
const NOW = Date.parse('2026-05-17T12:30:00Z');
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});
afterEach(() => vi.restoreAllMocks());

describe('LoRainGaugeCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders LoRain identity and rain telemetry', () => {
    render(<LoRainGaugeCard device={lorainDevice} removeContext="farm" />);

    expect(screen.getByText('North rain gauge')).toBeInTheDocument();
    expect(screen.getByText('LoRain')).toBeInTheDocument();
    expect(screen.getByText('70B3D5E75E004201')).toBeInTheDocument();
    expect(screen.getByText('1.5 mm')).toBeInTheDocument();
    expect(screen.getByText('2.7 mm')).toBeInTheDocument();
    expect(screen.getByText('20.5 °C')).toBeInTheDocument();
    expect(screen.getByText(/3\.3 V/)).toBeInTheDocument();
  });

  it('leads with amounts: no elapsed-time rate; the interval tile has amount and tips, "Last report" the time', () => {
    const { container } = render(<LoRainGaugeCard device={lorainDevice} removeContext="farm" />);

    expect(container.textContent).not.toMatch(/mm\/h|10 min/);
    const interval = screen.getByText('loRain.intervalRainfall').parentElement as HTMLElement;
    expect(interval).toHaveTextContent('1.5 mm');
    expect(interval).toHaveTextContent('3 loRain.tips');
    const tile = screen.getByTestId('lorain-last-report');
    expect(within(tile).getByText('loRain.lastReport')).toBeInTheDocument();
    expect(tile).not.toHaveTextContent('1.5 mm');
    expect(tile).not.toHaveTextContent('loRain.tips');
    expect(within(tile).getByTestId('lorain-last-report-time')).toHaveTextContent(/12:00/);
    expect(within(tile).getByTestId('lorain-last-report-time')).toHaveTextContent(/UTC/);
  });

  it('the interval tile says when the tip count is unavailable; the last report shows a dash without a report', () => {
    const noTips = { ...lorainDevice, latest_data: { ...lorainDevice.latest_data, rain_tips_delta: null } } as Device;
    const view = render(<LoRainGaugeCard device={noTips} removeContext="farm" />);
    expect(screen.getByText('loRain.intervalRainfall').parentElement).toHaveTextContent('loRain.tipsUnavailable');
    view.unmount();

    render(<LoRainGaugeCard device={{ ...lorainDevice, last_seen: null, latest_data: {} } as unknown as Device} removeContext="farm" />);
    expect(screen.getByTestId('lorain-last-report-time')).toHaveTextContent('—');
  });

  it('never labels a previous day\'s total as today', () => {
    const yesterday = { ...lorainDevice, latest_data: { ...lorainDevice.latest_data, rain_day: '2026-05-16' } } as Device;
    render(<LoRainGaugeCard device={yesterday} removeContext="farm" />);

    expect(screen.queryByText('2.7 mm')).not.toBeInTheDocument();
    expect(screen.getByText('rain.recordedToday')).toBeInTheDocument();
    expect(screen.getByText('rain.lastReportOn')).toBeInTheDocument();
  });

  it('a total without a farm day is not shown as today', () => {
    const undated = { ...lorainDevice, latest_data: { ...lorainDevice.latest_data, rain_day: undefined } } as Device;
    render(<LoRainGaugeCard device={undated} removeContext="farm" />);

    expect(screen.queryByText('2.7 mm')).not.toBeInTheDocument();
  });

  it('handles missing telemetry without throwing', () => {
    render(<LoRainGaugeCard device={{ ...lorainDevice, latest_data: {} }} removeContext="farm" />);

    expect(screen.getByText('North rain gauge')).toBeInTheDocument();
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('renders invalid last-seen timestamps as never seen', () => {
    render(<LoRainGaugeCard device={{ ...lorainDevice, last_seen: 'not-a-date' }} removeContext="farm" />);

    expect(screen.getByText(/Never seen/)).toBeInTheDocument();
  });

  it('removes the device after confirmation', async () => {
    const onRemove = vi.fn();
    render(<LoRainGaugeCard device={lorainDevice} onRemove={onRemove} removeContext="farm" />);

    fireEvent.click(screen.getByTitle('deviceRemoval.buttonFarm'));
    fireEvent.click(screen.getByText('deviceRemoval.confirmFarm'));

    await waitFor(() => {
      expect(devicesAPI.remove).toHaveBeenCalledWith(lorainDevice.deveui);
    });
    expect(onRemove).toHaveBeenCalled();
  });

  it('clears confirmation state when removal succeeds without parent unmount', async () => {
    render(<LoRainGaugeCard device={lorainDevice} removeContext="farm" />);

    fireEvent.click(screen.getByTitle('deviceRemoval.buttonFarm'));
    fireEvent.click(screen.getByText('deviceRemoval.confirmFarm'));

    await waitFor(() => {
      expect(devicesAPI.remove).toHaveBeenCalledWith(lorainDevice.deveui);
    });
    await waitFor(() => {
      expect(screen.queryByText('deviceRemoval.confirmFarm')).not.toBeInTheDocument();
    });
    expect(screen.getByTitle('deviceRemoval.buttonFarm')).toBeEnabled();
  });
});

describe('LoRainGaugeCard history', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function openFrom(text: string) {
    const { sensorAPI } = await import('../../../services/api');
    render(<LoRainGaugeCard device={lorainDevice} removeContext="farm" />);
    fireEvent.click(screen.getByText(text));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    return sensorAPI.getHistory;
  }

  it('every value on the card is a history control', () => {
    render(<LoRainGaugeCard device={lorainDevice} removeContext="farm" />);
    // Interval, today and temperature; the last report is a time, not a series.
    expect(screen.getAllByTitle('common.viewHistory')).toHaveLength(3);
  });

  it('the rain history offers the interval amount and the daily total only', async () => {
    await openFrom('1.5 mm');
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).not.toMatch(/10 min|mm\/h/);
    expect(within(dialog).getAllByText('loRain.intervalRainfall').length).toBeGreaterThan(0);
    expect(within(dialog).getAllByText('rain.recordedToday').length).toBeGreaterThan(0);
  });

  it('opens the interval series from the interval value', async () => {
    const getHistory = await openFrom('1.5 mm');
    await waitFor(() => expect(getHistory).toHaveBeenCalledWith(lorainDevice.deveui, 'rain_mm_delta', 24));
  });

  it('opens the daily total series from the today value', async () => {
    const getHistory = await openFrom('2.7 mm');
    await waitFor(() => expect(getHistory).toHaveBeenCalledWith(lorainDevice.deveui, 'rain_mm_today', 24));
  });

  it('opens the temperature series from the temperature value', async () => {
    const getHistory = await openFrom('20.5 °C');
    await waitFor(() => expect(getHistory).toHaveBeenCalledWith(lorainDevice.deveui, 'ambient_temperature', 24));
  });
});
