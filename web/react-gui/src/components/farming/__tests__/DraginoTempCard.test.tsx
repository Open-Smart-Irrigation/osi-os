import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Device } from '../../../types/farming';
import { DraginoTempCard } from '../DraginoTempCard';

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
    render(<DraginoTempCard device={chameleonDevice} />);

    expect(screen.getByText('2.48 pF')).toBeInTheDocument();
    expect(screen.queryByText('30.0 kPa')).not.toBeInTheDocument();
  });
});
