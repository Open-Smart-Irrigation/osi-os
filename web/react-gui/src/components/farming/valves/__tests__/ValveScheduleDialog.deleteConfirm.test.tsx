import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SWRConfig, useSWRConfig } from 'swr';
import userEvent from '@testing-library/user-event';

import { ValveScheduleDialog } from '../ValveScheduleDialog';
import type { ValveSchedule, ValveSchedulesResponse, ValveSummary } from '../../../../types/farming';

const { translateForTest } = vi.hoisted(() => {
  const table: Record<string, string> = {
    'scheduleDialog.title': 'Schedules for {{name}}',
    'scheduleDialog.week': 'Compiled week (what the valve will run)',
    'scheduleDialog.windows': '{{count}} of 4 windows',
    'scheduleDialog.noWindows': '—',
    'scheduleDialog.list': 'Schedules',
    'scheduleDialog.addWeekly': '+ Weekly',
    'scheduleDialog.addOnce': '+ One-time',
    'scheduleDialog.editWeekly': 'Edit weekly schedule',
    'scheduleDialog.label': 'Label (optional)',
    'scheduleDialog.startTime': 'Start',
    'scheduleDialog.duration': 'Duration (min)',
    'scheduleDialog.preview': '{{days}} {{start}}–{{end}} · {{minutes}} min',
    'scheduleDialog.onceNote': 'One-time opens are sent by the gateway at that minute; the gateway must be online.',
    'scheduleDialog.save': 'Save',
    'scheduleDialog.saving': 'Saving…',
    'scheduleDialog.delete': 'Delete',
    'scheduleDialog.enabled': 'Enabled',
    'scheduleDialog.edit': 'Edit',
    'scheduleDialog.deleteFailed': 'Could not delete the schedule.',
    'scheduleDialog.updateFailed': 'Could not update the schedule.',
    'scheduleDialog.deleteConfirmTitle': 'Delete this schedule?',
    'scheduleDialog.deleteConfirmBody': '{{schedule}} on {{valve}} will be deleted. This does not undo watering that has already run.',
    'scheduleDialog.deleteConfirmButton': 'Yes, delete',
    'irrigationPolicy.openEditor': 'Edit conditional policy',
    cancel: 'Cancel',
    'weekdays.0': 'Sun',
    'weekdays.1': 'Mon',
    'weekdays.2': 'Tue',
    'weekdays.3': 'Wed',
    'weekdays.4': 'Thu',
    'weekdays.5': 'Fri',
    'weekdays.6': 'Sat',
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

const { schedulesMock, createScheduleMock, updateScheduleMock, deleteScheduleMock } = vi.hoisted(() => ({
  schedulesMock: vi.fn(),
  createScheduleMock: vi.fn(),
  updateScheduleMock: vi.fn(),
  deleteScheduleMock: vi.fn(),
}));

vi.mock('../../../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../../../services/api')>('../../../../services/api');
  return {
    ...actual,
    valvesAPI: {
      schedules: schedulesMock,
      createSchedule: createScheduleMock,
      updateSchedule: updateScheduleMock,
      deleteSchedule: deleteScheduleMock,
    },
  };
});

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

function responseWithTwoWeeklyRows(): ValveSchedulesResponse {
  return {
    // The second row carries a device EUI that differs from the displayed valve: the
    // confirmation must bind to valve.deviceEui, never to a row's own field.
    schedules: [
      {
        scheduleUuid: 'sched-a', deviceEui: '0016C001F1000001', kind: 'WEEKLY', label: 'Morning soak',
        weekdaysMask: 0b0000100, startTime: '06:00', fireAt: null, durationMinutes: 30,
        timezone: 'Europe/Zurich', enabled: true, onceState: null,
      },
      {
        scheduleUuid: 'sched-b', deviceEui: 'A840410000000001', kind: 'WEEKLY', label: 'Evening',
        weekdaysMask: 0b0001000, startTime: '18:00', fireAt: null, durationMinutes: 15,
        timezone: 'Europe/Zurich', enabled: true, onceState: null,
      },
    ],
    compiled: { days: [[], [], [], [], [], [], []], errors: [] },
    pushState: [],
    settings: { stregaGeneration: 'GEN1', flowRateLpm: null, flowRateSource: null, defaultOpenMinutes: null },
  };
}

function renderDialog(valve: ValveSummary = makeValve(), onChanged = vi.fn()) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <ValveScheduleDialog valve={valve} open onClose={vi.fn()} onChanged={onChanged} />
    </SWRConfig>,
  );
}

function rowByLabel(label: string): HTMLElement {
  const heading = screen.getByText(label);
  return heading.closest('li') as HTMLElement;
}

async function openDeleteConfirmation(label: string): Promise<HTMLElement> {
  await screen.findByText(label);
  fireEvent.click(within(rowByLabel(label)).getByRole('button', { name: 'Delete' }));
  return await screen.findByRole('alertdialog');
}


function renderRefreshableDialog(initialValve = makeValve()) {
  let mutateCache: ReturnType<typeof useSWRConfig>['mutate'] | undefined;
  const config = { provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false };
  const onClose = vi.fn();
  function CaptureCache() {
    mutateCache = useSWRConfig().mutate;
    return null;
  }
  const element = (valve: ValveSummary) => (
    <SWRConfig value={config}>
      <CaptureCache />
      <ValveScheduleDialog valve={valve} open onClose={onClose} onChanged={vi.fn()} />
    </SWRConfig>
  );
  const view = render(element(initialValve));
  return {
    onClose,
    switchValve: (valve: ValveSummary) => view.rerender(element(valve)),
    refresh: async (response: ValveSchedulesResponse) => {
      await act(async () => {
        if (!mutateCache) throw new Error('SWR cache was not mounted');
        await mutateCache(`/api/valves/${initialValve.deviceEui}/schedules`, response, { revalidate: false });
      });
    },
  };
}

describe('ValveScheduleDialog delete confirmation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deleteScheduleMock.mockResolvedValue({ pushesQueued: 0 });
    updateScheduleMock.mockResolvedValue({ pushesQueued: 0 });
  });

  it('opens a confirmation on the first Delete tap and issues zero DELETE requests', async () => {
    schedulesMock.mockResolvedValue(responseWithTwoWeeklyRows());
    renderDialog();

    const confirm = await openDeleteConfirmation('Morning soak');
    expect(confirm).toBeInTheDocument();
    expect(deleteScheduleMock).not.toHaveBeenCalled();
  });

  it('shows the schedule identity and valve name in the confirmation', async () => {
    schedulesMock.mockResolvedValue(responseWithTwoWeeklyRows());
    renderDialog();

    const confirm = await openDeleteConfirmation('Morning soak');
    expect(within(confirm).getByText('Delete this schedule?')).toBeInTheDocument();
    expect(within(confirm).getByText(/Morning soak on North Valve will be deleted\./)).toBeInTheDocument();
    expect(within(confirm).getByText('Tue · 06:00–06:30 · 30 min')).toBeInTheDocument();
  });

  it.each(['success', 'failure'] as const)('keeps focus on the surviving close button during and after delete %s', async (outcome) => {
    const user = userEvent.setup();
    const rows = responseWithTwoWeeklyRows();
    let settle: () => void = () => {};
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    schedulesMock.mockResolvedValueOnce(rows).mockResolvedValue({ ...rows, schedules: rows.schedules.slice(1) });
    deleteScheduleMock.mockImplementationOnce(async () => {
      await pending;
      if (outcome === 'failure') throw new Error('delete failed');
      return { pushesQueued: 1 };
    });
    const onChanged = vi.fn();
    renderDialog(makeValve(), onChanged);
    const confirm = await openDeleteConfirmation('Morning soak');
    const close = screen.getByRole('button', { name: 'close' });
    await user.click(within(confirm).getByRole('button', { name: 'Yes, delete' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(close).toHaveFocus();
    await act(async () => { settle(); await pending; });
    if (outcome === 'success') {
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(screen.queryByText('Morning soak')).not.toBeInTheDocument();
    } else {
      await screen.findByText('Could not delete the schedule.');
      expect(onChanged).not.toHaveBeenCalled();
    }
    expect(close).toHaveFocus();
    expect(deleteScheduleMock).toHaveBeenCalledExactlyOnceWith('0016C001F1000001', 'sched-a');
  });

  it('cancel closes only the confirmation, keeps the dialog open, makes no request and restores focus to the trigger', async () => {
    schedulesMock.mockResolvedValue(responseWithTwoWeeklyRows());
    renderDialog();

    const confirm = await openDeleteConfirmation('Morning soak');
    const cancelButton = within(confirm).getByRole('button', { name: 'Cancel' });
    expect(cancelButton).toHaveFocus();

    fireEvent.click(cancelButton);

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.getByText('Schedules')).toBeInTheDocument();
    expect(deleteScheduleMock).not.toHaveBeenCalled();
    expect(within(rowByLabel('Morning soak')).getByRole('button', { name: 'Delete' })).toHaveFocus();
  });

  it('Escape closes only the confirmation, not the schedule dialog, and makes no request', async () => {
    const onClose = vi.fn();
    schedulesMock.mockResolvedValue(responseWithTwoWeeklyRows());
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        <ValveScheduleDialog valve={makeValve()} open onClose={onClose} onChanged={vi.fn()} />
      </SWRConfig>,
    );

    await openDeleteConfirmation('Morning soak');
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Schedules')).toBeInTheDocument();
    expect(deleteScheduleMock).not.toHaveBeenCalled();
  });

  it('a click on the confirmation backdrop closes only the confirmation', async () => {
    const onClose = vi.fn();
    schedulesMock.mockResolvedValue(responseWithTwoWeeklyRows());
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        <ValveScheduleDialog valve={makeValve()} open onClose={onClose} onChanged={vi.fn()} />
      </SWRConfig>,
    );

    const confirm = await openDeleteConfirmation('Morning soak');
    fireEvent.click(confirm.parentElement as HTMLElement);

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText('Schedules')).toBeInTheDocument();
    expect(deleteScheduleMock).not.toHaveBeenCalled();
  });

  it('closing the parent dialog drops the pending confirmation without a request', async () => {
    schedulesMock.mockResolvedValue(responseWithTwoWeeklyRows());
    const view = renderDialog();

    await openDeleteConfirmation('Morning soak');
    view.rerender(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        <ValveScheduleDialog valve={makeValve()} open={false} onClose={vi.fn()} onChanged={vi.fn()} />
      </SWRConfig>,
    );

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(deleteScheduleMock).not.toHaveBeenCalled();
  });

  it('confirm sends exactly one delete bound to the displayed valve EUI and the row UUID, then refreshes and notifies the parent', async () => {
    schedulesMock.mockResolvedValue(responseWithTwoWeeklyRows());
    const onChanged = vi.fn();
    renderDialog(makeValve(), onChanged);

    const confirm = await openDeleteConfirmation('Evening');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Yes, delete' }));

    await waitFor(() => expect(deleteScheduleMock).toHaveBeenCalledTimes(1));
    // valve.deviceEui, never the row's own A840410000000001 field; the UUID, never an index.
    expect(deleteScheduleMock).toHaveBeenCalledWith('0016C001F1000001', 'sched-b');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(updateScheduleMock).not.toHaveBeenCalled();
    expect(createScheduleMock).not.toHaveBeenCalled();
  });

  it('a rapid second activation of the confirm control cannot issue a second request', async () => {
    schedulesMock.mockResolvedValue(responseWithTwoWeeklyRows());
    renderDialog();

    const confirm = await openDeleteConfirmation('Morning soak');
    const confirmButton = within(confirm).getByRole('button', { name: 'Yes, delete' });
    fireEvent.click(confirmButton);
    fireEvent.click(confirmButton);
    fireEvent.keyDown(confirmButton, { key: 'Enter' });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(deleteScheduleMock).toHaveBeenCalledTimes(1));
    expect(deleteScheduleMock).not.toHaveBeenCalledTimes(2);
  });

  it('keyboard activation confirms with one request (Enter on the focused confirm control)', async () => {
    schedulesMock.mockResolvedValue(responseWithTwoWeeklyRows());
    renderDialog();

    const confirm = await openDeleteConfirmation('Morning soak');
    // A focused native button turns Enter into a click; simulate the browser pairing.
    const confirmButton = within(confirm).getByRole('button', { name: 'Yes, delete' });
    confirmButton.focus();
    expect(confirmButton).toHaveFocus();
    fireEvent.keyDown(confirmButton, { key: 'Enter' });
    fireEvent.click(confirmButton);

    await waitFor(() => expect(deleteScheduleMock).toHaveBeenCalledTimes(1));
    expect(deleteScheduleMock).toHaveBeenCalledWith('0016C001F1000001', 'sched-a');
  });

  it('drops the pending confirmation when the valve changes, without a request', async () => {
    schedulesMock.mockResolvedValue(responseWithTwoWeeklyRows());
    const view = renderDialog(makeValve());

    await openDeleteConfirmation('Morning soak');
    view.rerender(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        <ValveScheduleDialog valve={makeValve({ deviceEui: '0016C001F1000002', name: 'South Valve' })} open onClose={vi.fn()} onChanged={vi.fn()} />
      </SWRConfig>,
    );

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(deleteScheduleMock).not.toHaveBeenCalled();
  });

  it('drops the pending confirmation when the row disappears after a refresh, and that refresh path keeps the Enabled PUT intact', async () => {
    const twoRows = responseWithTwoWeeklyRows();
    const withoutRowA: ValveSchedulesResponse = { ...twoRows, schedules: twoRows.schedules.filter((s) => s.scheduleUuid !== 'sched-a') };
    schedulesMock.mockResolvedValueOnce(twoRows).mockResolvedValueOnce(withoutRowA).mockResolvedValue(withoutRowA);
    renderDialog();

    await openDeleteConfirmation('Morning soak');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    // An unrelated row mutation triggers the dialog's own refresh; the refreshed list no
    // longer carries sched-a, so the open confirmation must vanish and never authorize.
    fireEvent.click(within(rowByLabel('Evening')).getByRole('checkbox', { name: 'Enabled' }));
    await waitFor(() => expect(updateScheduleMock).toHaveBeenCalledTimes(1));
    expect(updateScheduleMock).toHaveBeenCalledWith('0016C001F1000001', 'sched-b', { enabled: false });

    expect(await screen.findByText('Evening')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(deleteScheduleMock).not.toHaveBeenCalled();
  });

  it('keeps the row controls busy while the authorized delete is in flight, then settles', async () => {
    let resolveDelete: (value: { pushesQueued: number }) => void = () => {};
    deleteScheduleMock.mockReturnValueOnce(new Promise((resolve) => { resolveDelete = resolve; }));
    schedulesMock.mockResolvedValue(responseWithTwoWeeklyRows());
    const onChanged = vi.fn();
    renderDialog(makeValve(), onChanged);

    const confirm = await openDeleteConfirmation('Morning soak');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Yes, delete' }));

    const row = rowByLabel('Morning soak');
    expect(within(row).getByRole('button', { name: 'Delete' })).toBeDisabled();
    expect(within(row).getByRole('checkbox', { name: 'Enabled' })).toBeDisabled();

    resolveDelete({ pushesQueued: 1 });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(within(rowByLabel('Morning soak')).getByRole('button', { name: 'Delete' })).toBeEnabled();
  });

  it.each(['delete request', 'refresh'] as const)('blocks a second delete selection during the pending %s, then restores confirmation focus', async (phase) => {
    const user = userEvent.setup();
    const rows = responseWithTwoWeeklyRows();
    let settle: () => void = () => {};
    const pending = new Promise<void>((resolve) => { settle = resolve; });
    schedulesMock.mockResolvedValue(rows);
    if (phase === 'delete request') {
      deleteScheduleMock.mockReturnValueOnce(pending.then(() => ({ pushesQueued: 1 })));
    } else {
      schedulesMock.mockResolvedValueOnce(rows).mockReturnValueOnce(pending.then(() => rows));
    }
    const onChanged = vi.fn();
    renderDialog(makeValve(), onChanged);
    try {
      const first = await openDeleteConfirmation('Morning soak');
      await user.click(within(first).getByRole('button', { name: 'Yes, delete' }));
      if (phase === 'refresh') await waitFor(() => expect(schedulesMock).toHaveBeenCalledTimes(2));
      const secondTrigger = within(rowByLabel('Evening')).getByRole('button', { name: 'Delete' });
      await user.click(secondTrigger);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(secondTrigger).toBeDisabled();
      expect(deleteScheduleMock).toHaveBeenCalledExactlyOnceWith('0016C001F1000001', 'sched-a');
      expect(onChanged).not.toHaveBeenCalled();
      await act(async () => { settle(); await pending; });
      await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
      expect(within(rowByLabel('Evening')).getByRole('button', { name: 'Delete' })).toBeEnabled();
      const second = await openDeleteConfirmation('Evening');
      const cancel = within(second).getByRole('button', { name: 'Cancel' });
      const confirm = within(second).getByRole('button', { name: 'Yes, delete' });
      expect(cancel).toBeEnabled();
      expect(confirm).toBeEnabled();
      expect(cancel).toHaveFocus();
      await user.tab({ shift: true });
      expect(confirm).toHaveFocus();
      await user.tab();
      expect(cancel).toHaveFocus();
      within(rowByLabel('Morning soak')).getByRole('checkbox', { name: 'Enabled' }).focus();
      expect(cancel).toHaveFocus();
      await user.keyboard(' ');
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(updateScheduleMock).not.toHaveBeenCalled();
      expect(createScheduleMock).not.toHaveBeenCalled();
      expect(deleteScheduleMock).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => { settle(); await pending; });
    }
  });

  it('resets an edit bound to the deleted schedule before refreshing', async () => {
    schedulesMock.mockResolvedValue(responseWithTwoWeeklyRows());
    renderDialog();

    await screen.findByText('Morning soak');
    fireEvent.click(within(rowByLabel('Morning soak')).getByRole('button', { name: 'Edit' }));
    expect(await screen.findByText('Edit weekly schedule')).toBeInTheDocument();

    const confirm = await openDeleteConfirmation('Morning soak');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Yes, delete' }));

    await waitFor(() => expect(screen.getByText('+ Weekly')).toBeInTheDocument());
    await waitFor(() => expect(schedulesMock).toHaveBeenCalledTimes(2));
    expect(deleteScheduleMock).toHaveBeenCalledWith('0016C001F1000001', 'sched-a');
  });

  it('shows the delete-failed message and re-enables the row when deletion is refused', async () => {
    deleteScheduleMock.mockRejectedValueOnce(new Error('network down'));
    schedulesMock.mockResolvedValue(responseWithTwoWeeklyRows());
    renderDialog();

    const confirm = await openDeleteConfirmation('Morning soak');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Yes, delete' }));

    expect(await screen.findByText('Could not delete the schedule.')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(within(rowByLabel('Morning soak')).getByRole('button', { name: 'Delete' })).toBeEnabled();
    expect(deleteScheduleMock).toHaveBeenCalledTimes(1);
  });

  it('conditional rows keep the policy-editor path and never expose the delete confirmation', async () => {
    const onOpenPolicyEditor = vi.fn();
    schedulesMock.mockResolvedValue({
      ...responseWithTwoWeeklyRows(),
      schedules: [{
        scheduleUuid: 'conditional-1', deviceEui: '0016C001F1000001', kind: 'WEEKLY', label: 'Conditional',
        weekdaysMask: 127, startTime: '06:00', fireAt: null, durationMinutes: 20, timezone: 'Europe/Zurich',
        enabled: true, onceState: null, conditionPolicyUuid: 'policy-1', execution: 'conditional', syncVersion: 3,
      }],
    });
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        <ValveScheduleDialog valve={makeValve()} open onClose={vi.fn()} onChanged={vi.fn()} onOpenPolicyEditor={onOpenPolicyEditor} />
      </SWRConfig>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Edit conditional policy' }));
    expect(onOpenPolicyEditor).toHaveBeenCalledWith(expect.objectContaining({ scheduleUuid: 'conditional-1' }));
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(deleteScheduleMock).not.toHaveBeenCalled();
  });
  it.each<[string, Partial<ValveSchedule>]>([
    ['time', { startTime: '07:00' }],
    ['label', { label: 'Changed remotely' }],
    ['duration', { durationMinutes: 45 }],
    ['enabled state', { enabled: false }],
    ['schedule kind', { kind: 'ONCE', fireAt: '2026-11-02T06:00:00Z' }],
  ])('invalidates a selected row when its %s changes under the same UUID', async (_name, change) => {
    const original = responseWithTwoWeeklyRows();
    schedulesMock.mockResolvedValue(original);
    const view = renderRefreshableDialog();
    const dialog = await openDeleteConfirmation('Morning soak');
    const staleConfirm = within(dialog).getByRole('button', { name: 'Yes, delete' });
    const changed = { ...original, schedules: original.schedules.map((row) => row.scheduleUuid === 'sched-a' ? { ...row, ...change } : row) };
    await view.refresh(changed);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    fireEvent.click(staleConfirm);
    expect(deleteScheduleMock).not.toHaveBeenCalled();
    const fresh = await openDeleteConfirmation(change.label ?? 'Morning soak');
    expect(deleteScheduleMock).not.toHaveBeenCalled();
    fireEvent.click(within(fresh).getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(deleteScheduleMock).toHaveBeenCalledExactlyOnceWith('0016C001F1000001', 'sched-a'));
  });

  it('invalidates an ordinary row replaced by a conditional row under the same UUID', async () => {
    const original = responseWithTwoWeeklyRows();
    schedulesMock.mockResolvedValue(original);
    const view = renderRefreshableDialog();
    const dialog = await openDeleteConfirmation('Morning soak');
    const staleConfirm = within(dialog).getByRole('button', { name: 'Yes, delete' });
    const changed: ValveSchedulesResponse = { ...original, schedules: original.schedules.map((row) => row.scheduleUuid === 'sched-a' ? { ...row, conditionPolicyUuid: 'policy-1', execution: 'conditional' } : row) };
    await view.refresh(changed);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(within(rowByLabel('Morning soak')).queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    fireEvent.click(staleConfirm);
    expect(deleteScheduleMock).not.toHaveBeenCalled();
    await view.refresh(original);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(await openDeleteConfirmation('Morning soak')).toBeInTheDocument();
    expect(deleteScheduleMock).not.toHaveBeenCalled();
  });

  it('does not resurrect a removed selection when the identical row reappears', async () => {
    const original = responseWithTwoWeeklyRows();
    schedulesMock.mockResolvedValue(original);
    const view = renderRefreshableDialog();
    await openDeleteConfirmation('Morning soak');
    await view.refresh({ ...original, schedules: original.schedules.slice(1) });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(view.onClose).toHaveBeenCalledTimes(1);
    await view.refresh(original);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(deleteScheduleMock).not.toHaveBeenCalled();
    expect(await openDeleteConfirmation('Morning soak')).toBeInTheDocument();
    expect(deleteScheduleMock).not.toHaveBeenCalled();
  });

  it('preserves confirmation for equal row content and changes to a different row', async () => {
    const original = responseWithTwoWeeklyRows();
    schedulesMock.mockResolvedValue(original);
    const view = renderRefreshableDialog();
    await openDeleteConfirmation('Morning soak');
    await view.refresh({ ...original, schedules: original.schedules.map((row) => ({ ...row, label: row.scheduleUuid === 'sched-b' ? 'Different evening' : row.label })) });
    const dialog = screen.getByRole('alertdialog');
    expect(within(dialog).getByText(/Morning soak on North Valve/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, delete' }));
    await waitFor(() => expect(deleteScheduleMock).toHaveBeenCalledExactlyOnceWith('0016C001F1000001', 'sched-a'));
  });

  it('requires fresh selection after switching away and back with the same schedule UUID', async () => {
    schedulesMock.mockResolvedValue(responseWithTwoWeeklyRows());
    const view = renderRefreshableDialog();
    await openDeleteConfirmation('Morning soak');
    view.switchValve(makeValve({ deviceEui: '0016C001F1000002', name: 'South Valve' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    view.switchValve(makeValve());
    await screen.findByText('Morning soak');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(deleteScheduleMock).not.toHaveBeenCalled();
    expect(await openDeleteConfirmation('Morning soak')).toBeInTheDocument();
  });

  it('loops Tab and Shift+Tab inside the confirmation and restores focus on Cancel', async () => {
    const user = userEvent.setup();
    schedulesMock.mockResolvedValue(responseWithTwoWeeklyRows());
    renderDialog();
    const dialog = await openDeleteConfirmation('Morning soak');
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    const confirm = within(dialog).getByRole('button', { name: 'Yes, delete' });
    expect(cancel).toHaveFocus();
    await user.tab({ shift: true });
    expect(confirm).toHaveFocus();
    await user.tab();
    expect(cancel).toHaveFocus();
    await user.tab();
    expect(confirm).toHaveFocus();
    await user.tab({ shift: true });
    expect(cancel).toHaveFocus();
    expect(updateScheduleMock).not.toHaveBeenCalled();
    expect(createScheduleMock).not.toHaveBeenCalled();
    expect(deleteScheduleMock).not.toHaveBeenCalled();
    await user.keyboard('{Enter}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(within(rowByLabel('Morning soak')).getByRole('button', { name: 'Delete' })).toHaveFocus();
    expect(deleteScheduleMock).not.toHaveBeenCalled();
  });

  it('returns attempted background focus to Cancel before keyboard activation', async () => {
    const user = userEvent.setup();
    schedulesMock.mockResolvedValue(responseWithTwoWeeklyRows());
    renderDialog();
    const dialog = await openDeleteConfirmation('Morning soak');
    const background = within(rowByLabel('Evening')).getByRole('checkbox', { name: 'Enabled' });
    background.focus();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.keyboard(' ');
    expect(updateScheduleMock).not.toHaveBeenCalled();
    expect(deleteScheduleMock).not.toHaveBeenCalled();
  });

});
