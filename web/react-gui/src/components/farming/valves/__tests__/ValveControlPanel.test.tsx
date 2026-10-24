import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    scheduleHelp: 'Weekly schedules run on each valve.',
    scheduleHelpLabel: 'About weekly schedules',
    empty: 'No STREGA valves registered yet.',
    actionFailed: 'The action could not be completed.',
    resumeRefusedClearPending: 'Resume is not possible yet: the valve has not confirmed its conditional clear.',
    loadFailed: 'Could not load valves.',
    'openDialog.error': 'Could not send the open command.',
    loading: 'Loading...',
    retry: 'Retry',
    cancelHelp: 'Cancel deletes the pending command. It does not close a valve that is already open.',
    'cancelOutcome.cancelled': 'The pending open was deleted.',
    'cancelOutcome.handed_off': 'The open may already have been sent to the valve, so it was not deleted.',
    'cancelOutcome.already_running': 'The valve is already open: there was no pending command to delete.',
    'cancelOutcome.uncertain': 'The gateway could not confirm that the pending open was deleted.',
    'cancelCollateral.title': 'Also removed from the valve queue:',
    'cancelCollateral.weekdayPlan': 'Plan for {{weekday}}',
    'cancelCollateral.planGroup': 'Plan update',
    'cancelCollateral.clockSync': 'Clock sync',
    'cancelCollateral.schedulerStatus': 'Scheduler status change',
    'cancelCollateral.open': 'Another pending open',
    'cancelCollateral.config': 'Configuration command (port {{fport}})',
    'cancelCollateral.configUnknown': 'Configuration command',
    'weekdays.1': 'Mon',
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

  it('replaces the subtitle with help available by pointer, keyboard and tap', async () => {
    vi.mocked(valvesAPI.list).mockResolvedValue([makeValve()]);
    render(<ValveControlPanel onUpdate={vi.fn()} canWrite />);
    expect(screen.queryByText('All valves, all zones. Weekly plans run on the valve itself.')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'About weekly schedules' })).not.toBeInTheDocument();
    const help=screen.getByRole('button',{name:'About weekly schedules'});
    fireEvent.mouseEnter(help.parentElement!);
    expect(screen.getByRole('region', { name: 'About weekly schedules' })).toHaveTextContent(/^Weekly schedules run on each valve\.$/);
    fireEvent.mouseLeave(help.parentElement!);
    expect(screen.queryByRole('region', { name: 'About weekly schedules' })).not.toBeInTheDocument();
    fireEvent.focus(help);
    expect(help).toHaveAttribute('aria-controls',screen.getByRole('region', { name: 'About weekly schedules' }).id);
    fireEvent.keyDown(help,{key:'Escape'});
    expect(screen.queryByRole('region', { name: 'About weekly schedules' })).not.toBeInTheDocument();
    fireEvent.click(help);
    expect(screen.getByRole('region', { name: 'About weekly schedules' })).toBeVisible();
    fireEvent.click(help);
    expect(screen.queryByRole('region', { name: 'About weekly schedules' })).not.toBeInTheDocument();
    fireEvent.blur(help);
    expect(screen.queryByRole('region', { name: 'About weekly schedules' })).not.toBeInTheDocument();
  });

  describe('schedule help', () => {
    const renderReadOnly = () => {
      vi.mocked(valvesAPI.list).mockResolvedValue([]);
      render(<ValveControlPanel onUpdate={vi.fn()} canWrite={false} />);
      return screen.getByRole('button', { name: 'About weekly schedules' });
    };

    it('opens on the first tap even when focus fires before click, and issues no valve command', () => {
      const help = renderReadOnly();
      expect(help).toHaveAttribute('type', 'button');
      fireEvent.pointerDown(help);
      fireEvent.focus(help);
      fireEvent.click(help);
      expect(screen.getByRole('region', { name: 'About weekly schedules' })).toHaveTextContent('Weekly schedules run on each valve.');
      for (const call of [devicesAPI.controlValve, devicesAPI.cancelIrrigation, devicesAPI.rename,
        valvesAPI.updateSettings, valvesAPI.setSchedulerStatus, valvesAPI.resendPlan]) {
        expect(call).not.toHaveBeenCalled();
      }
    });

    it('ties the tooltip to the button only while it is open', () => {
      const help = renderReadOnly();
      const regionId = help.getAttribute('aria-controls');
      expect(regionId).toBeTruthy();
      const closedRegion = document.getElementById(regionId!);
      expect(closedRegion).not.toBeNull();
      fireEvent.focus(help);
      const tooltip = screen.getByRole('region', { name: 'About weekly schedules' });
      expect(help).toHaveAttribute('aria-controls', tooltip.id);
      expect(tooltip).not.toHaveAttribute('aria-live');
      expect(tooltip.querySelector('button, a, input, select, textarea, [tabindex]')).toBeNull();
      fireEvent.blur(help);
      expect(help).toHaveAttribute('aria-controls', tooltip.id);
      expect(tooltip).toHaveAttribute('hidden');
    });

    it('dismisses on Escape while focus stays on the button', () => {
      const help = renderReadOnly();
      act(() => help.focus());
      expect(screen.getByRole('region', { name: 'About weekly schedules' })).toBeInTheDocument();
      fireEvent.keyDown(help, { key: 'Escape' });
      expect(screen.queryByRole('region', { name: 'About weekly schedules' })).not.toBeInTheDocument();
      expect(help).toHaveFocus();
    });

    it('dismisses hover-opened help on Escape although the button has no focus', () => {
      const help = renderReadOnly();
      fireEvent.mouseEnter(help.parentElement!);
      expect(screen.getByRole('region', { name: 'About weekly schedules' })).toBeInTheDocument();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByRole('region', { name: 'About weekly schedules' })).not.toBeInTheDocument();
    });

    it('dismisses on a tap outside, also on a non-focusable element', () => {
      const help = renderReadOnly();
      fireEvent.click(help);
      expect(screen.getByRole('region', { name: 'About weekly schedules' })).toBeInTheDocument();
      fireEvent.pointerDown(screen.getByRole('heading', { name: 'Valve control' }));
      expect(screen.queryByRole('region', { name: 'About weekly schedules' })).not.toBeInTheDocument();
      fireEvent.click(help);
      fireEvent.pointerDown(document.body);
      expect(screen.queryByRole('region', { name: 'About weekly schedules' })).not.toBeInTheDocument();
    });

    it('stays open when the pointer leaves while the button keeps focus', () => {
      const help = renderReadOnly();
      fireEvent.focus(help);
      fireEvent.mouseEnter(help.parentElement!);
      fireEvent.mouseLeave(help.parentElement!);
      expect(screen.getByRole('region', { name: 'About weekly schedules' })).toBeInTheDocument();
    });

    it('keeps a 48 px target and wraps narrow translated text inside the card', () => {
      const help = renderReadOnly();
      expect(help.className).toMatch(/\bmin-h-12\b/);
      expect(help.className).toMatch(/\bmin-w-12\b/);
      expect(help.className).toContain('focus-visible:ring-[var(--focus)]');
      fireEvent.focus(help);
      const tooltip = screen.getByRole('region', { name: 'About weekly schedules' });
      for (const cls of ['fixed', 'w-56', 'max-w-[calc(100vw-1rem)]', 'whitespace-normal', 'break-words']) {
        expect(tooltip.className.split(/\s+/)).toContain(cls);
      }
    });
  });

  // D19/Q01 = (a): a cancel is a whole-queue flush; the panel says what happened to the open and
  // lists the other queued items the flush removed.
  it('shows the cancel outcome and the collateral the flush removed', async () => {
    vi.mocked(valvesAPI.list).mockResolvedValue([makeValve()]);
    vi.mocked(devicesAPI.cancelIrrigation).mockResolvedValueOnce({
      outcome: 'cancelled',
      collateral: [
        { ownerType: 'push', ownerId: 'p-mon', purpose: 'WEEKDAY_PLAN', weekday: 1, fport: null, inQueue: true },
        { ownerType: 'opaque', ownerId: 'q3', purpose: null, weekday: null, fport: 11, inQueue: true },
        { ownerType: 'expectation', ownerId: 'e2', purpose: null, weekday: null, fport: null, inQueue: false },
      ],
    });
    render(<ValveControlPanel onUpdate={vi.fn()} canWrite />);
    fireEvent.click(await screen.findByRole('button', { name: `Cancel-${makeValve().deviceEui}` }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('The pending open was deleted.');
    expect(status).toHaveTextContent('Also removed from the valve queue:');
    expect(status).toHaveTextContent('Plan for Mon');
    expect(status).toHaveTextContent('Configuration command (port 11)');
    expect(status).not.toHaveTextContent('Another pending open');
  });

  it('shows a handed-off cancel honestly, with the D04 text, instead of a generic failure', async () => {
    vi.mocked(valvesAPI.list).mockResolvedValue([makeValve()]);
    vi.mocked(devicesAPI.cancelIrrigation).mockRejectedValueOnce({
      response: { status: 409, data: { error: 'actuation_handed_off', outcome: 'handed_off', collateral: [] } },
    });
    render(<ValveControlPanel onUpdate={vi.fn()} canWrite />);
    fireEvent.click(await screen.findByRole('button', { name: `Cancel-${makeValve().deviceEui}` }));
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('The open may already have been sent to the valve, so it was not deleted.');
    expect(status).toHaveTextContent('Cancel deletes the pending command. It does not close a valve that is already open.');
    expect(screen.queryByText('The action could not be completed.')).not.toBeInTheDocument();
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

  it('explains a refused Resume (conditional clear not confirmed) instead of the generic actionFailed', async () => {
    vi.mocked(valvesAPI.list).mockResolvedValue([makeValve()]);
    vi.mocked(valvesAPI.setSchedulerStatus).mockRejectedValueOnce(Object.assign(new Error('refused'), { code: 'conditional_readiness_pending' }));
    render(<ValveControlPanel onUpdate={vi.fn()} canWrite />);
    fireEvent.click(await screen.findByRole('button', { name: 'Resume-0016C001F1000001' }));
    expect(await screen.findByText('Resume is not possible yet: the valve has not confirmed its conditional clear.')).toBeInTheDocument();
    expect(screen.queryByText('The action could not be completed.')).not.toBeInTheDocument();
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
