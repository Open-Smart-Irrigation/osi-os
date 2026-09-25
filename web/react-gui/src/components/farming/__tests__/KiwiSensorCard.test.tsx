import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Device } from '../../../types/farming';
import { KiwiSensorCard } from '../KiwiSensorCard';

const STATUS_LABELS: Record<string, string> = {
  'history.soil.state.wet': 'Wet',
  'history.soil.state.moist': 'Moist',
  'history.soil.state.dry': 'Dry',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: { defaultValue?: string }) => STATUS_LABELS[key] ?? options?.defaultValue ?? key }),
}));

const NOW = Date.parse('2026-09-24T08:00:00.000Z');
const FRESH = new Date(NOW - 30 * 60 * 1000).toISOString();
const STALE = new Date(NOW - 4 * 60 * 60 * 1000).toISOString();
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  window.localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

vi.mock('../../../services/api', () => ({
  devicesAPI: { remove: vi.fn().mockResolvedValue(undefined) },
  deviceMetadataAPI: { setSoilMoistureDepths: vi.fn().mockResolvedValue(undefined) },
  kiwiAPI: {
    setUplinkInterval: vi.fn().mockResolvedValue(undefined),
    enableTemperatureHumidity: vi.fn().mockResolvedValue(undefined),
  },
  sensorAPI: { getHistory: vi.fn().mockResolvedValue([]) },
  getApiErrorMessage: (_err: unknown, fallback: string) => fallback,
}));

const kiwiDevice: Device = {
  id: 1,
  deveui: '70B3D5E75E004202',
  name: 'Kiwi row 3',
  type_id: 'KIWI_SENSOR',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
  irrigation_zone_id: null,
  is_claimed: true,
  claimed_by_username: 'test',
  claimed_by_user_uuid: 'uuid-1',
  last_seen: '2026-07-05T12:00:00Z',
  latest_data: {
    swt_1: 30,
  },
} as unknown as Device;

describe('KiwiSensorCard SWT unit preference', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders SWT in kPa by default', () => {
    render(<KiwiSensorCard device={kiwiDevice} removeContext="farm" />);
    expect(screen.getByText('30.0 kPa')).toBeInTheDocument();
    expect(screen.queryByText('2.48 pF')).not.toBeInTheDocument();
  });

  it('renders SWT in pF when the display preference is pF', () => {
    window.localStorage.setItem('osi.display.swtUnit', 'pF');
    render(<KiwiSensorCard device={kiwiDevice} removeContext="farm" />);
    expect(screen.getByText('2.48 pF')).toBeInTheDocument();
    expect(screen.queryByText('30.0 kPa')).not.toBeInTheDocument();
  });
  it('shows independently classified KIWI channels and withholds stale status', () => {
    const { rerender } = render(<KiwiSensorCard removeContext="farm" device={{
      ...kiwiDevice,
      last_seen: FRESH,
      latest_data: { swt_1: 10, swt_2: 55 },
    }} />);
    expect(screen.getByText('Wet')).toBeInTheDocument();
    expect(screen.getByText('Dry')).toBeInTheDocument();

    rerender(<KiwiSensorCard removeContext="farm" device={{
      ...kiwiDevice,
      last_seen: STALE,
      latest_data: { swt_1: 10 },
    }} />);
    expect(screen.queryByText('Wet')).not.toBeInTheDocument();
  });

  it('keeps zero visible in pF mode and gives it one Wet status', () => {
    window.localStorage.setItem('osi.display.swtUnit', 'pF');
    render(<KiwiSensorCard removeContext="farm" device={{
      ...kiwiDevice,
      last_seen: FRESH,
      latest_data: { swt_1: 0 },
    }} />);
    expect(screen.getByText('0.0 kPa')).toBeInTheDocument();
    expect(screen.queryByText('0.00 pF')).not.toBeInTheDocument();
    expect(screen.getAllByText('Wet')).toHaveLength(1);
  });

  it('keeps the KIWI history control separate from its status pill', () => {
    render(<KiwiSensorCard removeContext="farm" device={{
      ...kiwiDevice,
      last_seen: FRESH,
      latest_data: { swt_1: 10 },
    }} />);
    const badge = screen.getByText('Wet').closest('[data-swt-status]');
    expect(badge?.closest('button')).toBeNull();
    expect(badge?.parentElement).toHaveClass('flex', 'flex-wrap');
    expect(screen.getByTitle('View history')).toBeInTheDocument();
  });

  it.each([-1, 301, null])('opens history even when the SWT value is unavailable: %s', async (value) => {
    render(<KiwiSensorCard removeContext="farm" device={{
      ...kiwiDevice, last_seen: FRESH, latest_data: { swt_1: value },
    }} />);
    const history = screen.getByTitle('View history');
    expect(history).toHaveTextContent('na');
    expect(screen.queryByText('Wet')).not.toBeInTheDocument();
    expect(screen.queryByText('Dry')).not.toBeInTheDocument();
    fireEvent.click(history);
    expect(screen.getByRole('heading', { name: 'Soil Water Tension 1' })).toBeInTheDocument();
    expect(await screen.findByText('No soil water tension 1 data in the last 24 hours.')).toBeInTheDocument();
  });

  it('opens the second channel history when only that channel is invalid', async () => {
    render(<KiwiSensorCard removeContext="farm" device={{
      ...kiwiDevice, last_seen: FRESH, latest_data: { swt_1: 30, swt_2: 301 },
    }} />);
    fireEvent.click(screen.getByRole('button', { name: 'na' }));
    expect(screen.getByRole('heading', { name: 'Soil Water Tension 2' })).toBeInTheDocument();
    expect(await screen.findByText('No soil water tension 2 data in the last 24 hours.')).toBeInTheDocument();
  });

});
