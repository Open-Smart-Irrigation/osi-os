import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
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
