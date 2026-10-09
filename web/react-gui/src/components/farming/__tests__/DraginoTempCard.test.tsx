import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Device } from '../../../types/farming';
import { DraginoTempCard } from '../DraginoTempCard';

const STATUS_LABELS: Record<string, string> = {
  'history.soil.state.wet': 'Wet',
  'history.soil.state.moist': 'Moist',
  'history.soil.state.dry': 'Dry',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => STATUS_LABELS[key] ?? key }),
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
  sensorAPI: { getHistory: vi.fn().mockResolvedValue([]) },
}));

const chameleonDevice: Device = {
  deveui: 'AA00000000000001',
  name: 'Chameleon 1',
  type_id: 'DRAGINO_LSN50',
  last_seen: '2026-07-05T12:00:00Z',
  chameleon_enabled: 1,
  chameleon_swt1_depth_cm: 5,
  chameleon_swt2_depth_cm: 15,
  chameleon_swt3_depth_cm: 30,
  latest_data: {
    swt_1: 30,
    swt_2: null,
    swt_3: null,
  },
} as Device;

describe('DraginoTempCard SWT unit preference', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders Chameleon SWT tiles in pF when the display preference is pF', () => {
    window.localStorage.setItem('osi.display.swtUnit', 'pF');
    render(<DraginoTempCard device={chameleonDevice} removeContext="farm" />);

    expect(screen.getByText('2.48 pF')).toBeInTheDocument();
    expect(screen.queryByText('30.0 kPa')).not.toBeInTheDocument();
  });
  it('keeps pF display while deriving three LSN50 statuses from kPa', () => {
    window.localStorage.setItem('osi.display.swtUnit', 'pF');
    render(<DraginoTempCard removeContext="farm" device={{
      ...chameleonDevice,
      last_seen: FRESH,
      latest_data: { swt_1: 10, swt_2: 30, swt_3: 60 },
    }} />);
    expect(screen.getByText('2.00 pF')).toBeInTheDocument();
    expect(screen.getByText('2.48 pF')).toBeInTheDocument();
    expect(screen.getByText('2.78 pF')).toBeInTheDocument();
    expect(screen.getByText('Wet')).toBeInTheDocument();
    expect(screen.getByText('Moist')).toBeInTheDocument();
    expect(screen.getByText('Dry')).toBeInTheDocument();
  });

  it('suppresses only the open LSN50 channel status', () => {
    render(<DraginoTempCard removeContext="farm" device={{
      ...chameleonDevice,
      last_seen: FRESH,
      latest_data: { swt_1: 10, swt_2: 30, chameleon_ch1_open: 1 },
    }} />);
    expect(screen.queryByText('Wet')).not.toBeInTheDocument();
    expect(screen.getByText('Moist')).toBeInTheDocument();
  });

  it.each([
    { chameleon_i2c_missing: 1 },
    { chameleon_timeout: 1 },
  ])('suppresses every LSN50 status for a global Chameleon fault: %o', (fault) => {
    render(<DraginoTempCard removeContext="farm" device={{
      ...chameleonDevice,
      last_seen: FRESH,
      latest_data: { swt_1: 10, swt_2: 30, ...fault },
    }} />);
    expect(screen.queryByText('Wet')).not.toBeInTheDocument();
    expect(screen.queryByText('Moist')).not.toBeInTheDocument();
    expect(screen.getByText('No valid Chameleon sample')).toBeInTheDocument();
  });

  it('withholds stale LSN50 status and keeps each status inside its one row button', () => {
    const { rerender } = render(<DraginoTempCard removeContext="farm" device={{
      ...chameleonDevice,
      last_seen: FRESH,
      latest_data: { swt_1: 10 },
    }} />);
    const rowButton = screen.getByText('SWT1').closest('button');
    expect(rowButton).toHaveAttribute('title', 'View SWT history');
    expect(rowButton).toContainElement(screen.getByText('Wet'));
    expect(rowButton?.querySelectorAll('button')).toHaveLength(0);
    expect(rowButton).toHaveClass('flex-wrap', 'gap-2');
    expect(screen.getByText('Wet').parentElement).toHaveClass('flex', 'flex-wrap');

    rerender(<DraginoTempCard removeContext="farm" device={{
      ...chameleonDevice,
      last_seen: STALE,
      latest_data: { swt_1: 10 },
    }} />);
    expect(screen.queryByText('Wet')).not.toBeInTheDocument();
  });

});

const watermarkDevice: Device = {
  deveui: 'AA00000000000002',
  name: 'Watermark 1',
  type_id: 'DRAGINO_LSN50',
  last_seen: FRESH,
  latest_data: {
    watermark: {
      recorded_at: FRESH,
      supply_mv: 3300,
      soil_temp_c: 19.9,
      soil_temp_source: 2,
      die_temp_c: 21.5,
      channels: [
        { status: 'ok', kpa: 56.4, kpa_upper_bound: null, r_solved: 9977, r_upper_bound: null, offset_mv: 0.6 },
        { status: 'saturated', kpa: 0, kpa_upper_bound: null, r_solved: null, r_upper_bound: null, offset_mv: null },
      ],
    },
  },
} as Device;

describe('DraginoTempCard WATERMARK probe section', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('renders the WATERMARK section and its values when latest_data.watermark is present', () => {
    render(<DraginoTempCard removeContext="farm" device={watermarkDevice} />);
    expect(screen.getByText('watermark.sectionTitle')).toBeInTheDocument();
    expect(screen.getByText('56.4 kPa')).toBeInTheDocument();
    expect(screen.getByText('0.0 kPa')).toBeInTheDocument();
  });

  it('renders no WATERMARK section when latest_data.watermark is absent', () => {
    render(<DraginoTempCard removeContext="farm" device={chameleonDevice} />);
    expect(screen.queryByText('watermark.sectionTitle')).not.toBeInTheDocument();
  });

  it('hides the Chameleon SWT block on a board reflashed to WATERMARK that still has chameleon_enabled set', () => {
    render(<DraginoTempCard removeContext="farm" device={{
      ...watermarkDevice,
      chameleon_enabled: 1,
      chameleon_swt1_depth_cm: 5,
      chameleon_swt2_depth_cm: 15,
      chameleon_swt3_depth_cm: 30,
    }} />);
    expect(screen.queryByText('Chameleon SWT')).not.toBeInTheDocument();
    expect(screen.getByText('watermark.sectionTitle')).toBeInTheDocument();
  });

  it('still shows the Chameleon SWT block for a Chameleon device without watermark', () => {
    render(<DraginoTempCard removeContext="farm" device={chameleonDevice} />);
    expect(screen.getByText('Chameleon SWT')).toBeInTheDocument();
  });
});

describe('DraginoTempCard WATERMARK history', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
  });

  it('opens the legacy history view for a probe value with its own series', async () => {
    const { sensorAPI } = await import('../../../services/api');
    render(<DraginoTempCard removeContext="farm" device={watermarkDevice} />);
    fireEvent.click(screen.getByText('0.0 kPa'));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await waitFor(() => expect(sensorAPI.getHistory).toHaveBeenCalledWith('AA00000000000002', 'swt_2', 24));
  });

  it('opens the soil temperature series from the measured soil temperature', async () => {
    const { sensorAPI } = await import('../../../services/api');
    render(<DraginoTempCard removeContext="farm" device={watermarkDevice} />);
    fireEvent.click(screen.getByRole('button', { name: 'watermark.soilTemp' }));
    expect(await screen.findByRole('dialog', { name: 'environment.soil.temperature' })).toBeInTheDocument();
    await waitFor(() => expect(sensorAPI.getHistory).toHaveBeenCalledWith('AA00000000000002', 'ext_temperature_c', 24));
  });
});

describe('DraginoTempCard rain gauge today line (rain review finding 10)', () => {
  const rainDevice = (rainDay: string | undefined): Device => ({
    deveui: 'AA00000000000002',
    name: 'Rain gauge node',
    type_id: 'DRAGINO_LSN50',
    last_seen: FRESH,
    rain_gauge_enabled: 1,
    latest_data: {
      rain_mm_today: 8,
      rain_mm_delta: 0.4,
      rain_day: rainDay,
      rain_day_timezone: 'UTC',
      rain_day_timezone_basis: 'unassigned_default',
    },
  } as unknown as Device);

  it('shows the total when its farm day is today', () => {
    render(<DraginoTempCard device={rainDevice('2026-09-24')} removeContext="farm" />);
    expect(screen.getByText('8.0 mm')).toBeInTheDocument();
    expect(screen.getByText(/rain\.recordedToday/)).toBeInTheDocument();
  });

  it('never labels yesterday\'s total as today', () => {
    render(<DraginoTempCard device={rainDevice('2026-09-23')} removeContext="farm" />);
    expect(screen.queryByText('8.0 mm')).not.toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(/rain\.lastReportOn/)).toBeInTheDocument();
    expect(screen.getByText(/\(UTC\)/)).toBeInTheDocument();
  });

  it('a total without a farm day is not shown as today', () => {
    render(<DraginoTempCard device={rainDevice(undefined)} removeContext="farm" />);
    expect(screen.queryByText('8.0 mm')).not.toBeInTheDocument();
  });
});
