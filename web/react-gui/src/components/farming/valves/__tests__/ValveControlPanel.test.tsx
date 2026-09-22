import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ComponentProps } from 'react';

import { ValveControlPanel } from '../ValveControlPanel';
import { devicesAPI, valvesAPI } from '../../../../services/api';
import type { ValveTile as ValveTileType } from '../ValveTile';
import type { ValveOpenDialog as ValveOpenDialogType } from '../ValveOpenDialog';
import type { ValveSummary } from '../../../../types/farming';

const { translateForTest } = vi.hoisted(() => {
  const table: Record<string, string> = {
    title: 'Valve control',
    subtitle: 'All valves, all zones. Weekly plans run on the valve itself.',
    empty: 'No STREGA valves registered yet.',
    actionFailed: 'The action could not be completed.',
    loadFailed: 'Could not load valves.',
    'openDialog.error': 'Could not send the open command.',
    loading: 'Loading...',
    retry: 'Retry',
  };
  return {
    translateForTest: (key: string, options?: Record<string, unknown>): string => {
      const template = table[key] ?? key;
      return template.replace(/\{\{(\w+)\}\}/g, (_match, name) => String(options?.[name] ?? ''));
    },
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translateForTest, i18n: { language: 'en' } }),
}));

// The tile stub's rename button records how the panel's onRename promise
// settled, which is the whole point of the M4 test below: EditableName renders
// its error line from a rejection, so a rename that committed must not reject
// just because the list could not be revalidated afterwards.
const { renameOutcomes } = vi.hoisted(() => ({ renameOutcomes: [] as string[] }));

vi.mock('../../../../services/api', () => ({
  devicesAPI: {
    controlValve: vi.fn(),
    cancelIrrigation: vi.fn(),
    rename: vi.fn(),
  },
  valvesAPI: {
    list: vi.fn(),
    updateSettings: vi.fn(),
    setSchedulerStatus: vi.fn(),
    resendPlan: vi.fn(),
  },
}));

// ValveTile and the three dialogs are real, non-trivial UI; stub them so this suite only
// exercises ValveControlPanel's own orchestration (error labelling, open-submit isolation).
vi.mock('../ValveTile', () => ({
  ValveTile: (props: ComponentProps<typeof ValveTileType>) => (
    <div>
      <span>{props.busy ? `busy-${props.valve.deviceEui}` : `idle-${props.valve.deviceEui}`}</span>
      <button onClick={props.onOpen}>Open-{props.valve.deviceEui}</button>
      <button onClick={props.onCancel}>Cancel-{props.valve.deviceEui}</button>
      <button onClick={props.onSkipToday}>SkipToday-{props.valve.deviceEui}</button>
      <button onClick={props.onPause}>Pause-{props.valve.deviceEui}</button>
      <button onClick={props.onResume}>Resume-{props.valve.deviceEui}</button>
      <button onClick={props.onResend}>Resend-{props.valve.deviceEui}</button>
      <button onClick={props.onSettings}>Settings-{props.valve.deviceEui}</button>
      <button
        onClick={() => {
          props.onRename('Renamed valve').then(
            () => renameOutcomes.push('resolved'),
            () => renameOutcomes.push('rejected'),
          );
        }}
      >
        Rename-{props.valve.deviceEui}
      </button>
    </div>
  ),
}));

vi.mock('../ValveOpenDialog', () => ({
  ValveOpenDialog: (props: ComponentProps<typeof ValveOpenDialogType>) =>
    props.open ? <button onClick={() => props.onSubmit(10)}>SubmitOpen</button> : null,
}));

vi.mock('../ValveScheduleDialog', () => ({
  ValveScheduleDialog: () => null,
}));

vi.mock('../ValveSettingsDialog', () => ({
  ValveSettingsDialog: () => null,
}));

function makeValve(overrides: Partial<ValveSummary> = {}): ValveSummary {
  return {
    deviceEui: '0016C001F1000001',
    name: 'North Valve',
    zoneId: 1,
    zoneName: 'North Block',
    zoneUuid: 'uuid-1',
    timezone: 'Europe/Zurich',
    currentState: 'CLOSED',
    targetState: null,
    stregaGeneration: 'GEN1',
    flowRateLpm: null,
    flowRateSource: null,
    defaultOpenMinutes: null,
    schedulerStatus: 'ACTIVE',
    skipTodayDate: null,
    lastUplinkAt: null,
    activeActuation: null,
    recentStaleState: null,
    nextRun: null,
    scheduleCount: 0,
    pushState: { queued: 0, acked: 0, failed: 0, lastPlanQueuedAt: null, lastPlanAckedAt: null },
    lastClockSyncAckedAt: null,
    enclosureTemperatureC: null,
    enclosureHumidityPct: null,
    enclosureMeasuredAt: null,
    ...overrides,
  };
}

describe('ValveControlPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    renameOutcomes.length = 0;
  });

  it('labels a failed non-open action (cancel/skip/pause/resume/resend) with actionFailed, not the open error', async () => {
    vi.mocked(valvesAPI.list).mockResolvedValue([makeValve()]);
    vi.mocked(devicesAPI.cancelIrrigation).mockRejectedValueOnce(new Error('boom'));
    const onUpdate = vi.fn();

    render(<ValveControlPanel onUpdate={onUpdate} canWrite />);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel-0016C001F1000001' }));

    expect(await screen.findByText('The action could not be completed.')).toBeInTheDocument();
    expect(screen.queryByText('Could not send the open command.')).not.toBeInTheDocument();
  });

  it('isolates a failed default-open-minutes save from the open command: still refreshes, does not surface actionFailed', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(valvesAPI.list).mockResolvedValue([makeValve()]);
    vi.mocked(devicesAPI.controlValve).mockResolvedValueOnce(undefined);
    vi.mocked(valvesAPI.updateSettings).mockRejectedValueOnce(new Error('pref save failed'));
    const onUpdate = vi.fn();

    render(<ValveControlPanel onUpdate={onUpdate} canWrite />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open-0016C001F1000001' }));
    fireEvent.click(await screen.findByRole('button', { name: 'SubmitOpen' }));

    await waitFor(() => expect(devicesAPI.controlValve).toHaveBeenCalledWith(
      '0016C001F1000001',
      { action: 'OPEN_FOR_DURATION', duration_seconds: 600 },
    ));
    await waitFor(() => expect(valvesAPI.updateSettings).toHaveBeenCalled());
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    expect(warnSpy).toHaveBeenCalled();
    expect(screen.queryByText('The action could not be completed.')).not.toBeInTheDocument();

    warnSpy.mockRestore();
  });

  // M4: the rename has already committed on the gateway by the time the list
  // is revalidated. Awaiting the revalidation made its failure the rename's
  // failure, and EditableName shows a rejection as an error line under the
  // input: the operator would read "could not save" about a name that is
  // saved. The eight cards call onUpdate?.() unawaited for the same reason.
  it('does not report a failed revalidation after a committed rename as a save failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(valvesAPI.list).mockResolvedValue([makeValve()]);
    vi.mocked(devicesAPI.rename).mockResolvedValue({
      deveui: '0016C001F1000001',
      name: 'Renamed valve',
      sync_version: 2,
      changed: true,
      chirpstack: 'updated',
    });
    // The panel's refresh is `await mutate(); onUpdate();`. The dashboard's
    // onUpdate reloads its own data and can fail on its own, which is the
    // reachable way for the refresh to reject.
    const onUpdate = vi.fn(() => { throw new Error('dashboard reload failed'); });

    render(<ValveControlPanel onUpdate={onUpdate} canWrite />);
    fireEvent.click(await screen.findByRole('button', { name: 'Rename-0016C001F1000001' }));

    await waitFor(() => expect(devicesAPI.rename).toHaveBeenCalledWith('0016C001F1000001', 'Renamed valve'));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    await waitFor(() => expect(renameOutcomes).toEqual(['resolved']));
    expect(warnSpy).toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
