import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { SWRConfig } from 'swr';

import { ValveControlPanel } from '../ValveControlPanel';
import { devicesAPI, valvesAPI } from '../../../../services/api';
import { resetValveCommandHoldsForTest, VALVE_OPEN_HOLD_MS } from '../../../../services/valveCommandHold';
import type { ValveOpenDialog as ValveOpenDialogType } from '../ValveOpenDialog';
import type { ValveSummary } from '../../../../types/farming';

// An open whose answer never arrived may have reached the valve. The panel must say so, not
// "could not send", and hold the real tile's Open until the next valve reading or one minute.

const NO_ANSWER_OPEN = 'No answer from the gateway yet. The command may have reached the valve, so opening stays unavailable until the valve status updates, for one minute at most.';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      open: 'Open',
      'commandNoAnswer.open': NO_ANSWER_OPEN,
      'openDialog.error': 'Could not send the open command.',
      actionFailed: 'The action could not be completed.',
    } as Record<string, string>)[key] ?? key,
    i18n: { language: 'en' },
  }),
}));

vi.mock('../../../../services/api', () => ({
  devicesAPI: { controlValve: vi.fn(), cancelIrrigation: vi.fn(), rename: vi.fn() },
  valvesAPI: { list: vi.fn(), updateSettings: vi.fn(), setSchedulerStatus: vi.fn(), resendPlan: vi.fn() },
}));

// The dialog is not under test: submitting it runs the panel's open handler.
vi.mock('../ValveOpenDialog', () => ({
  ValveOpenDialog: (props: ComponentProps<typeof ValveOpenDialogType>) =>
    props.open ? <button onClick={() => { props.onSubmit(10).then(props.onClose, () => undefined); }}>SubmitOpen</button> : null,
}));
vi.mock('../ValveScheduleDialog', () => ({ ValveScheduleDialog: () => null }));
vi.mock('../ValveSettingsDialog', () => ({ ValveSettingsDialog: () => null }));
vi.mock('../ValveServiceDialog', () => ({ ValveServiceDialog: () => null }));

const EUI = '0016C001F1000001';

function makeValve(): ValveSummary {
  return {
    deviceEui: EUI, name: 'North Valve', zoneId: 1, zoneName: 'North Block', zoneUuid: 'uuid-1',
    timezone: 'Europe/Zurich', currentState: 'CLOSED', targetState: null, stregaGeneration: 'GEN1',
    flowRateLpm: null, flowRateSource: null, defaultOpenMinutes: null, schedulerStatus: 'ACTIVE',
    skipTodayDate: null, lastUplinkAt: null, activeActuation: null, recentStaleState: null, nextRun: null,
    scheduleCount: 0, pushState: { queued: 0, acked: 0, failed: 0, lastPlanQueuedAt: null, lastPlanAckedAt: null },
    lastClockSyncAckedAt: null, enclosureTemperatureC: null, enclosureHumidityPct: null, enclosureMeasuredAt: null,
  };
}

const timeout = () => Object.assign(new Error('timeout of 30000ms exceeded'), { code: 'ECONNABORTED' });

function renderPanel() {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ValveControlPanel onUpdate={vi.fn()} canWrite />
    </SWRConfig>,
  );
}

// Opens the valve through the real tile and lets the command time out. Every valve reading
// after the first stays pending until the test resolves it.
async function openAndTimeOut() {
  let resolveReading: (valves: ValveSummary[]) => void = () => undefined;
  vi.mocked(valvesAPI.list)
    .mockResolvedValueOnce([makeValve()])
    .mockImplementation(() => new Promise<ValveSummary[]>((resolve) => { resolveReading = resolve; }));
  vi.mocked(devicesAPI.controlValve).mockRejectedValueOnce(timeout());
  renderPanel();
  fireEvent.click(await screen.findByRole('button', { name: 'Open' }));
  fireEvent.click(screen.getByRole('button', { name: 'SubmitOpen' }));
  expect(await screen.findByText(NO_ANSWER_OPEN)).toBeInTheDocument();
  return { resolveReading: (valves: ValveSummary[]) => resolveReading(valves) };
}

describe('ValveControlPanel: an open that gets no answer', () => {
  beforeEach(() => {
    resetValveCommandHoldsForTest();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says no answer has arrived, not "could not send", and holds Open', async () => {
    await openAndTimeOut();
    expect(screen.queryByText('Could not send the open command.')).not.toBeInTheDocument();
    expect(screen.queryByText('The action could not be completed.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'SubmitOpen' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();
    expect(devicesAPI.controlValve).toHaveBeenCalledTimes(1);
    expect(valvesAPI.updateSettings).not.toHaveBeenCalled();
  });

  it('releases Open when the next valve reading arrives', async () => {
    const { resolveReading } = await openAndTimeOut();
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();
    await waitFor(() => expect(valvesAPI.list).toHaveBeenCalledTimes(2));
    await act(async () => { resolveReading([makeValve()]); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open' })).toBeEnabled());
  });

  it('releases Open after one minute when no reading arrives', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] });
    await openAndTimeOut();
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();
    await act(async () => { vi.advanceTimersByTime(VALVE_OPEN_HOLD_MS - 1_000); });
    expect(screen.getByRole('button', { name: 'Open' })).toBeDisabled();
    await act(async () => { vi.advanceTimersByTime(2_000); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Open' })).toBeEnabled());
    // Usable again without a question: the next press opens the dialog straight away.
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(screen.getByRole('button', { name: 'SubmitOpen' })).toBeInTheDocument();
  });
});
