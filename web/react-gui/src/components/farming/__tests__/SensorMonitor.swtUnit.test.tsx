// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { getHistory } = vi.hoisted(() => ({ getHistory: vi.fn() }));
vi.mock('../../../services/api', () => ({ sensorAPI: { getHistory } }));
vi.mock('../../../hooks/useModalFocus', () => ({ useModalFocus: () => undefined }));
vi.mock('../../../utils/datetime', () => ({ useDateFormat: () => ({ time: (value: string) => value, date: (value: string) => value }) }));
vi.mock('recharts', () => ({
  Area: () => null,
  AreaChart: () => <div />,
  CartesianGrid: () => null,
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Tooltip: () => null,
  XAxis: () => null,
  YAxis: () => null,
}));

import { SensorMonitor } from '../SensorMonitor';
import { writeDisplayPreferences } from '../../../utils/displayPreferences';

afterEach(() => { cleanup(); getHistory.mockReset(); localStorage.clear(); });

describe('SensorMonitor SWT display units', () => {
  it('reprojects mounted canonical SWT history without another API request', async () => {
    getHistory.mockResolvedValue([{ t: '2026-10-16T08:00:00Z', value: 1.97 }, { t: '2026-10-16T09:00:00Z', value: null }, { t: '2026-10-16T10:00:00Z', value: 0.1 }]);
    render(<SensorMonitor deveui='EDGE-1' deviceName='Tensiomark pair' field='swt_1' label='SWT' unit='kPa' onClose={() => undefined} />);

    await waitFor(() => expect(screen.getByText('2.0 kPa')).toBeInTheDocument());
    expect(getHistory).toHaveBeenCalledTimes(1);
    act(() => writeDisplayPreferences({ swtUnit: 'pF' }));

    expect(screen.getByText('1.29 pF')).toBeInTheDocument();
    expect(screen.getAllByText('0.00 pF')).toHaveLength(2);
    expect(screen.getByText('SWT (pF)')).toBeInTheDocument();
    expect(getHistory).toHaveBeenCalledTimes(1);
  });
});
