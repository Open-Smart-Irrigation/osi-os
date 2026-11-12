import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';

import { ValveScheduleDialog } from '../ValveScheduleDialog';
import {
  beginValveReading,
  completeValveReading,
  holdValveOpen,
  resetValveCommandHoldsForTest,
} from '../../../../services/valveCommandHold';
import type { ValveSchedulesResponse, ValveSummary } from '../../../../types/farming';

// A one-time irrigation due while an earlier open of this valve has no answer yet is a second
// open by another route (review S7). The form refuses it with the same explanation and sends
// nothing; a one-time irrigation for later, and the same one once the hold has ended, go out.

const NO_ANSWER_OPEN = 'No answer yet; the command may have reached the valve.';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'scheduleDialog.list': 'Schedules',
      'scheduleDialog.date': 'Date',
      'scheduleDialog.time': 'Time',
      'scheduleDialog.save': 'Save',
      'scheduleDialog.saveFailed': 'Could not save the schedule.',
      'scheduleDialog.update': 'Update',
      'scheduleDialog.edit': 'Edit',
      'scheduleDialog.enabled': 'Enabled',
      'commandNoAnswer.open': NO_ANSWER_OPEN,
    } as Record<string, string>)[key] ?? key,
    i18n: { language: 'en' },
  }),
}));

const { schedulesMock, createScheduleMock, updateScheduleMock } = vi.hoisted(() => ({
  schedulesMock: vi.fn(), createScheduleMock: vi.fn(), updateScheduleMock: vi.fn(),
}));

vi.mock('../../../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../../../services/api')>('../../../../services/api');
  return {
    ...actual,
    valvesAPI: {
      schedules: schedulesMock,
      createSchedule: createScheduleMock,
      updateSchedule: updateScheduleMock,
      deleteSchedule: vi.fn().mockResolvedValue({ pushesQueued: 0 }),
    },
  };
});

const EUI = '0016C001F1000001';
const TZ = 'Europe/Zurich';
const valve = {
  deviceEui: EUI, name: 'North Valve', zoneId: 1, zoneName: 'North Block', zoneUuid: 'uuid-1',
  timezone: TZ, currentState: 'CLOSED', targetState: null, stregaGeneration: 'GEN1',
  flowRateLpm: null, flowRateSource: null, defaultOpenMinutes: null, schedulerStatus: 'ACTIVE',
  skipTodayDate: null, lastUplinkAt: null, activeActuation: null, recentStaleState: null, nextRun: null,
  scheduleCount: 0, pushState: { queued: 0, acked: 0, failed: 0, lastPlanQueuedAt: null, lastPlanAckedAt: null },
  lastClockSyncAckedAt: null, enclosureTemperatureC: null, enclosureHumidityPct: null, enclosureMeasuredAt: null,
} as ValveSummary;
const empty: ValveSchedulesResponse = {
  schedules: [],
  compiled: { days: [[], [], [], [], [], [], []], errors: [] },
  pushState: [],
  settings: { stregaGeneration: 'GEN1', flowRateLpm: null, flowRateSource: null, defaultOpenMinutes: null },
};

/** The valve-local date and minute of `offsetMs` from now, as the form's inputs take them. */
function localFields(offsetMs: number): { date: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(Date.now() + offsetMs)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour === '24' ? '00' : parts.hour}:${parts.minute}` };
}

async function saveOnce(offsetMs: number) {
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <ValveScheduleDialog valve={valve} open onClose={vi.fn()} onChanged={vi.fn()} />
    </SWRConfig>,
  );
  await screen.findByText('Schedules');
  const { date, time } = localFields(offsetMs);
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: date } });
  fireEvent.change(screen.getByLabelText('Time'), { target: { value: time } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[1]);
}

describe('ValveScheduleDialog and the open hold', () => {
  beforeEach(() => {
    resetValveCommandHoldsForTest();
    vi.clearAllMocks();
    schedulesMock.mockResolvedValue(empty);
    createScheduleMock.mockResolvedValue({ schedule: {}, pushesQueued: 0 });
    updateScheduleMock.mockResolvedValue({ pushesQueued: 0 });
  });

  it('refuses a one-time irrigation due now while held, explains why, and sends nothing', async () => {
    holdValveOpen(EUI);
    await saveOnce(0);
    expect(await screen.findByText(NO_ANSWER_OPEN)).toBeInTheDocument();
    expect(screen.queryByText('Could not save the schedule.')).not.toBeInTheDocument();
    expect(createScheduleMock).not.toHaveBeenCalled();
  });

  it('accepts a one-time irrigation that starts after the hold can end', async () => {
    holdValveOpen(EUI);
    await saveOnce(10 * 60_000);
    await waitFor(() => expect(createScheduleMock).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(NO_ANSWER_OPEN)).not.toBeInTheDocument();
  });

  it('accepts the same one-time irrigation once the hold has ended', async () => {
    holdValveOpen(EUI);
    completeValveReading(beginValveReading());
    await saveOnce(0);
    await waitFor(() => expect(createScheduleMock).toHaveBeenCalledTimes(1));
  });

  // Review r3, S7: the edit form must not rely on a cached "disabled" while its write leaves
  // the gateway's `enabled` untouched. Hold active; edit open on a disabled one-time schedule
  // whose stored start is later; a due time typed; the row then enabled (allowed: its stored
  // start is later). The form still believes the row is disabled.
  async function editDisabledRowThenEnableIt() {
    const later = new Date(Date.now() + 10 * 60_000).toISOString();
    schedulesMock.mockReset();
    schedulesMock.mockResolvedValueOnce({
      ...empty,
      schedules: [{ scheduleUuid: 'once-1', deviceEui: EUI, kind: 'ONCE', label: 'Later soak', weekdaysMask: null, startTime: null,
        fireAt: later, durationMinutes: 5, timezone: TZ, enabled: false, onceState: 'PENDING' }],
    });
    let failRefresh: (error: Error) => void = () => undefined;
    schedulesMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { failRefresh = reject; }));
    holdValveOpen(EUI);
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        <ValveScheduleDialog valve={valve} open onClose={vi.fn()} onChanged={vi.fn()} />
      </SWRConfig>,
    );
    await screen.findByText('Later soak');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const { date, time } = localFields(0);
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: date } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: time } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Enabled' }));
    await waitFor(() => expect(updateScheduleMock).toHaveBeenCalledTimes(1));
    // During the hold the enable carries the start it was checked against.
    expect(updateScheduleMock.mock.calls[0][2]).toEqual({ enabled: true, fireAt: later });
    await waitFor(() => expect(schedulesMock).toHaveBeenCalledTimes(2));
    return { failRefresh: (error: Error) => failRefresh(error) };
  }

  it('an edit that relies on a disabled row disables it in its own write, even after the refresh failed', async () => {
    const { failRefresh } = await editDisabledRowThenEnableIt();
    await act(async () => { failRefresh(new Error('offline')); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));

    // Either the edit is refused, or its own patch disables the row: never a due start with
    // `enabled` left to whatever the gateway now holds.
    await waitFor(() => expect(updateScheduleMock.mock.calls.length > 1 || !!screen.queryByText(NO_ANSWER_OPEN)).toBe(true));
    for (const [, , patch] of updateScheduleMock.mock.calls.slice(1)) {
      expect(patch).toMatchObject({ enabled: false });
    }
  });

  it('Update waits while a row change and its refresh are pending', async () => {
    await editDisabledRowThenEnableIt();
    expect(screen.getByRole('button', { name: 'Update' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    expect(updateScheduleMock).toHaveBeenCalledTimes(1);
  });

  // Review r4, S7 (reverse order): the due edit goes first and is saved with enabled false;
  // its list refresh is pending or fails, so the list still shows the row disabled with its
  // old, later start; the row is then enabled from that stale list. The enabling write must
  // carry the start it was checked against, so the gateway cannot end enabled and due.
  async function dueEditThenStaleList() {
    const later = new Date(Date.now() + 10 * 60_000).toISOString();
    schedulesMock.mockReset();
    schedulesMock.mockResolvedValueOnce({
      ...empty,
      schedules: [{ scheduleUuid: 'once-1', deviceEui: EUI, kind: 'ONCE', label: 'Later soak', weekdaysMask: null, startTime: null,
        fireAt: later, durationMinutes: 5, timezone: TZ, enabled: false, onceState: 'PENDING' }],
    });
    let failRefresh: (error: Error) => void = () => undefined;
    schedulesMock.mockImplementationOnce(() => new Promise((_resolve, reject) => { failRefresh = reject; }));
    holdValveOpen(EUI);
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        <ValveScheduleDialog valve={valve} open onClose={vi.fn()} onChanged={vi.fn()} />
      </SWRConfig>,
    );
    await screen.findByText('Later soak');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const { date, time } = localFields(0);
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: date } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: time } });
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(updateScheduleMock).toHaveBeenCalledTimes(1));
    // The due edit of a row the form believes disabled keeps it disabled in its own write.
    expect(updateScheduleMock.mock.calls[0][2]).toMatchObject({ enabled: false, fireAt: expect.any(String) });
    await waitFor(() => expect(schedulesMock).toHaveBeenCalledTimes(2));
    return { later, failRefresh: (error: Error) => failRefresh(error) };
  }

  it('reverse order, refresh pending: the row cannot be enabled from the stale list', async () => {
    await dueEditThenStaleList();
    const enabled = screen.getByRole('checkbox', { name: 'Enabled' });
    expect(enabled).toBeDisabled();
    fireEvent.click(enabled);
    expect(updateScheduleMock).toHaveBeenCalledTimes(1);
  });

  it('reverse order, refresh failed: enabling from the stale list writes the start it was checked against', async () => {
    const { later, failRefresh } = await dueEditThenStaleList();
    await act(async () => { failRefresh(new Error('offline')); });
    const enabled = screen.getByRole('checkbox', { name: 'Enabled' });
    await waitFor(() => expect(enabled).toBeEnabled());
    fireEvent.click(enabled);
    await waitFor(() => expect(updateScheduleMock).toHaveBeenCalledTimes(2));
    // The gateway ends with exactly this pair: enabled, starting at the later time that was
    // checked, not the due start the edit wrote.
    expect(updateScheduleMock.mock.calls[1][2]).toEqual({ enabled: true, fireAt: later });
  });
});
