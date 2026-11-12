import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StregaValveCard } from '../StregaValveCard';
import { devicesAPI } from '../../../services/api';
import { noteValveReading, resetValveCommandHolds } from '../../../services/valveCommandHold';
import type { Device } from '../../../types/farming';

// The zone card's open shares the panel's hold: after an open with no answer it says so,
// not "Failed to open valve", and its open button waits for the next reading.

const NO_ANSWER_OPEN = 'No answer yet; the command may have reached the valve.';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => ({
      'commandNoAnswer.open': NO_ANSWER_OPEN,
      'stregaValve.failedToOpen': 'Failed to open valve',
      'stregaValve.openFor': 'Open for 5 min',
      'stregaValve.confirmOpen': 'Confirm open',
    } as Record<string, string>)[key] ?? options?.defaultValue ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../../services/api', () => ({
  devicesAPI: { controlValve: vi.fn(), rename: vi.fn(), remove: vi.fn(), cancelIrrigation: vi.fn() },
  stregaAPI: {},
  valveAPI: { getTodayLiters: vi.fn().mockResolvedValue({ liters: null, source: 'unknown' }) },
  sensorAPI: { getHistory: vi.fn().mockResolvedValue([]) },
}));

const EUI = '0016C001F1000001';
const device = { deveui: EUI, name: 'North Valve', type_id: 'STREGA_VALVE', latest_data: {}, current_state: 'CLOSED', target_state: 'CLOSED' } as unknown as Device;

describe('StregaValveCard: an open that gets no answer', () => {
  beforeEach(() => {
    resetValveCommandHolds();
    vi.clearAllMocks();
  });

  it('says no answer has arrived and holds open until the next reading', async () => {
    vi.mocked(devicesAPI.controlValve).mockRejectedValueOnce(Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' }));
    const onUpdate = vi.fn();
    render(<StregaValveCard device={device} onUpdate={onUpdate} removeContext="farm" />);

    const openButton = screen.getByRole('button', { name: /Open for/ });
    fireEvent.click(openButton);
    fireEvent.click(screen.getByRole('button', { name: /Confirm open/ }));

    expect(await screen.findByText(NO_ANSWER_OPEN)).toBeInTheDocument();
    expect(screen.queryByText('Failed to open valve')).not.toBeInTheDocument();
    expect(onUpdate).toHaveBeenCalled();
    const held = screen.getByRole('button', { name: /Open for/ });
    expect(held).toBeDisabled();

    await act(async () => { noteValveReading(Date.now()); });
    await waitFor(() => expect(screen.getByRole('button', { name: /Open for/ })).toBeEnabled());
    expect(devicesAPI.controlValve).toHaveBeenCalledTimes(1);
  });
});
