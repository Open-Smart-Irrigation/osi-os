import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';

import { ValveServiceDialog } from '../ValveServiceDialog';
import { devicesAPI, stregaAPI } from '../../../../services/api';
import { holdValveOpen, isValveOpenHeld, resetValveCommandHoldsForTest } from '../../../../services/valveCommandHold';
import type { Device, ValveSummary } from '../../../../types/farming';

// The Service commands dialog sends three commands that open (timed OPEN, partial OPEN,
// flushing). They share the one open hold with every other valve surface, in both
// directions; their closing counterparts are never held.

const NO_ANSWER_OPEN = 'No answer yet; the command may have reached the valve.';
const NO_ANSWER_OTHER = 'No answer yet; the command may have reached the valve (other).';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'commandNoAnswer.open': NO_ANSWER_OPEN,
      'commandNoAnswer.other': NO_ANSWER_OTHER,
      'serviceDialog.timed.label': 'Timed action',
      'serviceDialog.timed.actionOpen': 'Open',
      'serviceDialog.timed.actionClose': 'Close',
      'serviceDialog.timed.amountLabel': 'Amount',
      'serviceDialog.timed.send': 'Send timed action',
      'serviceDialog.timed.confirmButton': 'Yes, send timed',
      'serviceDialog.timed.failed': 'Could not queue the timed action.',
      'serviceDialog.partial.label': 'Partial opening',
      'serviceDialog.partial.percentageLabel': 'Percentage',
      'serviceDialog.partial.send': 'Send partial opening',
      'serviceDialog.partial.confirmButton': 'Yes, send partial',
      'serviceDialog.flush.percentageLabel': 'Percentage',
      'serviceDialog.flush.send': 'Send flushing',
      'serviceDialog.flush.confirmButton': 'Yes, send flush',
    } as Record<string, string>)[key] ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../../../services/api', () => ({
  stregaAPI: {
    setUplinkInterval: vi.fn().mockResolvedValue(undefined),
    setModel: vi.fn().mockResolvedValue(undefined),
    setTimedAction: vi.fn().mockResolvedValue(undefined),
    setMagnetEnabled: vi.fn().mockResolvedValue(undefined),
    setPartialOpening: vi.fn().mockResolvedValue(undefined),
    setFlushing: vi.fn().mockResolvedValue(undefined),
  },
  devicesAPI: { getAll: vi.fn() },
}));

const EUI = '0016C001F1000001';
const valve = {
  deviceEui: EUI, name: 'North Valve', zoneId: 1, zoneName: 'North Block', zoneUuid: 'uuid-1',
  timezone: 'Europe/Zurich', currentState: 'CLOSED', targetState: null, stregaGeneration: 'GEN1',
  flowRateLpm: null, flowRateSource: null, defaultOpenMinutes: null, schedulerStatus: 'ACTIVE',
  skipTodayDate: null, lastUplinkAt: null, activeActuation: null, recentStaleState: null, nextRun: null,
  scheduleCount: 0, pushState: { queued: 0, acked: 0, failed: 0, lastPlanQueuedAt: null, lastPlanAckedAt: null },
  lastClockSyncAckedAt: null, enclosureTemperatureC: null, enclosureHumidityPct: null, enclosureMeasuredAt: null,
} as ValveSummary;
const motorized = { deveui: EUI, name: 'North Valve', type_id: 'STREGA_VALVE', latest_data: {}, strega_model: 'MOTORIZED' } as unknown as Device;
const timeout = () => Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' });

async function renderDialog() {
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ValveServiceDialog valve={valve} open onClose={vi.fn()} onChanged={vi.fn()} />
    </SWRConfig>,
  );
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send flushing' })).not.toBeDisabled());
}

const partialPercentage = () => screen.getByLabelText('Percentage', { selector: `#service-partial-percentage-${EUI}` });
const flushPercentage = () => screen.getByLabelText('Percentage', { selector: `#service-flush-percentage-${EUI}` });

describe('ValveServiceDialog and the open hold', () => {
  beforeEach(() => {
    resetValveCommandHoldsForTest();
    vi.clearAllMocks();
    vi.mocked(devicesAPI.getAll).mockResolvedValue([motorized]);
  });

  it('a hold from another surface disables every opening command here and leaves the closing ones', async () => {
    await renderDialog();
    act(() => { holdValveOpen(EUI); });

    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '5' } });
    expect(screen.getByRole('button', { name: 'Send timed action' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send partial opening' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Send flushing' })).toBeDisabled();

    // Timed CLOSE and partial CLOSE are never held.
    fireEvent.change(screen.getByLabelText('Timed action'), { target: { value: 'CLOSE' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send timed action' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, send timed' }));
    await waitFor(() => expect(stregaAPI.setTimedAction).toHaveBeenCalledWith(EUI, { action: 'CLOSE', unit: 'minutes', amount: 5 }));
    fireEvent.change(screen.getByLabelText('Partial opening'), { target: { value: 'CLOSE' } });
    expect(screen.getByRole('button', { name: 'Send partial opening' })).toBeEnabled();
    expect(stregaAPI.setFlushing).not.toHaveBeenCalled();
    expect(stregaAPI.setPartialOpening).not.toHaveBeenCalled();
  });

  it('a confirmation already shown when the hold begins cannot send', async () => {
    await renderDialog();
    fireEvent.change(flushPercentage(), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send flushing' }));
    const confirm = screen.getByRole('button', { name: 'Yes, send flush' });
    expect(confirm).toBeEnabled();
    act(() => { holdValveOpen(EUI); });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(stregaAPI.setFlushing).not.toHaveBeenCalled();
  });

  it('a timed OPEN with no answer says so and holds opening, here and on every other surface', async () => {
    vi.mocked(stregaAPI.setTimedAction).mockRejectedValueOnce(timeout());
    await renderDialog();
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send timed action' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, send timed' }));

    expect(await screen.findByText(NO_ANSWER_OPEN)).toBeInTheDocument();
    expect(screen.queryByText('Could not queue the timed action.')).not.toBeInTheDocument();
    expect(isValveOpenHeld(EUI)).toBe(true);
    expect(screen.getByRole('button', { name: 'Send timed action' })).toBeDisabled();
    fireEvent.change(partialPercentage(), { target: { value: '40' } });
    expect(screen.getByRole('button', { name: 'Send partial opening' })).toBeDisabled();
    expect(stregaAPI.setTimedAction).toHaveBeenCalledTimes(1);
  });

  it('a timed CLOSE with no answer says so and holds nothing', async () => {
    vi.mocked(stregaAPI.setTimedAction).mockRejectedValueOnce(timeout());
    await renderDialog();
    fireEvent.change(screen.getByLabelText('Timed action'), { target: { value: 'CLOSE' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send timed action' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, send timed' }));

    expect(await screen.findByText(NO_ANSWER_OTHER)).toBeInTheDocument();
    expect(isValveOpenHeld(EUI)).toBe(false);
    expect(screen.getByRole('button', { name: 'Send flushing' })).toBeEnabled();
  });
});
