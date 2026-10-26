// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Device } from '../../../types/farming';
import { DraginoChameleonSwtSection } from '../DraginoChameleonSwtSection';

vi.mock('../../../services/api', () => ({
  lsn50API: { setChameleonDepth: vi.fn(), refreshChameleonCalibration: vi.fn() },
}));

const device = (latest: Device['latest_data']): Device => ({
  deveui: 'A840410000000102',
  name: 'Chameleon',
  type_id: 'DRAGINO_LSN50',
  chameleon_enabled: 1,
  latest_data: latest,
});

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('DraginoChameleonSwtSection measured zero tension', () => {
  it('keeps a measured 0 kPa live item in pF mode as 0.0 kPa', () => {
    window.localStorage.setItem('osi.display.swtUnit', 'pF');
    render(<DraginoChameleonSwtSection device={device({ swt_1: 0, swt_2: 30, swt_3: null })} onUpdate={vi.fn()} />);
    expect(screen.getByText('0.0 kPa')).toBeInTheDocument();
    expect(screen.getByText('2.48 pF')).toBeInTheDocument();
    expect(screen.getAllByText('SWT')).toHaveLength(2);
  });
});
