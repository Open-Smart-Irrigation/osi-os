import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Device } from '../../../types/farming';
import { KiwiSensorCard } from '../KiwiSensorCard';

vi.mock('../../../services/api', () => ({
  devicesAPI: { remove: vi.fn().mockResolvedValue(undefined) },
  deviceMetadataAPI: { setSoilMoistureDepths: vi.fn().mockResolvedValue(undefined) },
  kiwiAPI: {
    setUplinkInterval: vi.fn().mockResolvedValue(undefined),
    enableTemperatureHumidity: vi.fn().mockResolvedValue(undefined),
  },
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
    render(<KiwiSensorCard device={kiwiDevice} />);
    expect(screen.getByText('30.0 kPa')).toBeInTheDocument();
    expect(screen.queryByText('2.48 pF')).not.toBeInTheDocument();
  });

  it('renders SWT in pF when the display preference is pF', () => {
    window.localStorage.setItem('osi.display.swtUnit', 'pF');
    render(<KiwiSensorCard device={kiwiDevice} />);
    expect(screen.getByText('2.48 pF')).toBeInTheDocument();
    expect(screen.queryByText('30.0 kPa')).not.toBeInTheDocument();
  });
});
