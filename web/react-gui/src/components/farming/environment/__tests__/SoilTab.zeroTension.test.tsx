// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Device, LocalEnvironment } from '../../../../types/farming';
import { SoilTab } from '../SoilTab';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key }),
}));

const local = { metrics: [] } as unknown as LocalEnvironment;
const devices = (swt: number): Device[] => [
  { deveui: 'A840410000000101', name: 'Probe', type_id: 'KIWI_SENSOR', latest_data: { swt_1: swt } },
];

beforeEach(() => window.localStorage.clear());
afterEach(cleanup);

describe('SoilTab measured zero tension', () => {
  it('shows a measured 0 kPa as 0.0 kPa in pF mode instead of a blank tile', () => {
    window.localStorage.setItem('osi.display.swtUnit', 'pF');
    render(<SoilTab local={local} devices={devices(0)} />);
    expect(screen.getByText('0.0 kPa')).toBeInTheDocument();
  });

  it('keeps pF for positive tension', () => {
    window.localStorage.setItem('osi.display.swtUnit', 'pF');
    render(<SoilTab local={local} devices={devices(30)} />);
    expect(screen.getByText('2.48 pF')).toBeInTheDocument();
  });
});
