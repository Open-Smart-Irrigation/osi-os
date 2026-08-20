import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SWRConfig } from 'swr';

import { ValveScheduleDialog } from '../ValveScheduleDialog';
import { ValvePlanConflictError } from '../../../../services/api';
import type { ValveSchedulesResponse, ValveSummary } from '../../../../types/farming';

const { translateForTest } = vi.hoisted(() => {
  const table: Record<string, string> = {
    'scheduleDialog.title': 'Schedules for {{name}}',
    'scheduleDialog.week': 'Compiled week (what the valve will run)',
    'scheduleDialog.windows': '{{count}} of 4 windows',
    'scheduleDialog.noWindows': '—',
    'scheduleDialog.list': 'Schedules',
    'scheduleDialog.addWeekly': '+ Weekly',
    'scheduleDialog.addOnce': '+ One-time',
    'scheduleDialog.label': 'Label (optional)',
    'scheduleDialog.startTime': 'Start',
    'scheduleDialog.duration': 'Duration (min)',
    'scheduleDialog.date': 'Date',
    'scheduleDialog.time': 'Time',
    'scheduleDialog.preview': '{{days}} {{start}}–{{end}} · {{minutes}} min',
    'scheduleDialog.previewLiters': '≈ {{liters}} L',
    'scheduleDialog.onceNote': 'One-time opens are sent by the gateway at that minute; the gateway must be online.',
    'scheduleDialog.save': 'Save',
    'scheduleDialog.saving': 'Saving…',
    'scheduleDialog.delete': 'Delete',
    'scheduleDialog.enabled': 'Enabled',
    'scheduleDialog.conflictTooMany': '{{weekday}} would have more than 4 windows.',
    'scheduleDialog.conflictOverlap': 'Overlaps another window on {{weekday}}.',
    'scheduleDialog.conflictGeneric': 'The schedule conflicts with the plan.',
    'scheduleDialog.conflictInvalidStart': 'A schedule has an invalid start time.',
    'scheduleDialog.invalidStartTime': 'That start time is not valid.',
    'scheduleDialog.saveFailed': 'Could not save the schedule.',
    'scheduleDialog.updateFailed': 'Could not update the schedule.',
    'scheduleDialog.deleteFailed': 'Could not delete the schedule.',
    'scheduleDialog.loadFailed': 'Could not load schedules.',
    'scheduleDialog.push.QUEUED': 'waiting for valve',
    'scheduleDialog.push.ACKED': 'acknowledged {{when}}',
    'scheduleDialog.push.FAILED': 'failed',
    bluetoothNote: 'Changes made on the valve over Bluetooth are not visible here.',
    noSchedule: 'No schedule',
    cancel: 'Cancel',
    loading: 'Loading...',
    retry: 'Retry',
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

const { schedulesMock, createScheduleMock } = vi.hoisted(() => ({
  schedulesMock: vi.fn(),
  createScheduleMock: vi.fn(),
}));

vi.mock('../../../../services/api', async () => {
  const actual = await vi.importActual<typeof import('../../../../services/api')>('../../../../services/api');
  return {
    ...actual,
    valvesAPI: {
      schedules: schedulesMock,
      createSchedule: createScheduleMock,
      updateSchedule: vi.fn().mockResolvedValue({ pushesQueued: 0 }),
      deleteSchedule: vi.fn().mockResolvedValue({ pushesQueued: 0 }),
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
    ...overrides,
  };
}

function emptyResponse(): ValveSchedulesResponse {
  return {
    schedules: [],
    compiled: { days: [[], [], [], [], [], [], []], errors: [] },
    pushState: [],
    settings: { stregaGeneration: 'GEN1', flowRateLpm: null, flowRateSource: null, defaultOpenMinutes: null },
  };
}

function responseWithTuesdayWindows(): ValveSchedulesResponse {
  return {
    schedules: [
      {
        scheduleUuid: 'sched-1',
        deviceEui: '0016C001F1000001',
        kind: 'WEEKLY',
        label: 'Morning soak',
        weekdaysMask: 0b0000100,
        startTime: '06:00',
        fireAt: null,
        durationMinutes: 30,
        timezone: 'Europe/Zurich',
        enabled: true,
        onceState: null,
      },
    ],
    compiled: {
      days: [
        [],
        [],
        [
          { onH: 6, onM: 0, offH: 6, offM: 30, scheduleUuid: 'sched-1', label: 'Morning soak' },
          { onH: 18, onM: 0, offH: 18, offM: 15, scheduleUuid: 'sched-2', label: null },
        ],
        [],
        [],
        [],
        [],
      ],
      errors: [],
    },
    pushState: [],
    settings: { stregaGeneration: 'GEN1', flowRateLpm: null, flowRateSource: null, defaultOpenMinutes: null },
  };
}

function responseWithNullStartTime(): ValveSchedulesResponse {
  return {
    schedules: [
      {
        scheduleUuid: 'sched-null-start',
        deviceEui: '0016C001F1000001',
        kind: 'WEEKLY',
        label: null,
        weekdaysMask: 0b0000010,
        startTime: null,
        fireAt: null,
        durationMinutes: 20,
        timezone: 'Europe/Zurich',
        enabled: true,
        onceState: null,
      },
    ],
    compiled: { days: [[], [], [], [], [], [], []], errors: [] },
    pushState: [],
    settings: { stregaGeneration: 'GEN1', flowRateLpm: null, flowRateSource: null, defaultOpenMinutes: null },
  };
}

function renderDialog(valve: ValveSummary, onChanged = vi.fn()) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
      <ValveScheduleDialog valve={valve} open onClose={vi.fn()} onChanged={onChanged} />
    </SWRConfig>,
  );
}

/** Formats a UTC ISO instant back to local HH:MM in `timeZone`, for DST round-trip assertions. */
function localHHMM(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(iso)).reduce<Record<string, string>>((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${hour}:${parts.minute}`;
}

async function saveOnceAndCaptureFireAt(date: string, time: string): Promise<string> {
  await screen.findByText('Schedules');
  fireEvent.change(screen.getByLabelText('Date'), { target: { value: date } });
  fireEvent.change(screen.getByLabelText('Time'), { target: { value: time } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[1]);
  await waitFor(() => expect(createScheduleMock).toHaveBeenCalled());
  const [, input] = createScheduleMock.mock.calls[0];
  expect(input.kind).toBe('ONCE');
  return input.fireAt as string;
}

describe('ValveScheduleDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders schedules returned by the API', async () => {
    schedulesMock.mockResolvedValueOnce(responseWithTuesdayWindows());
    renderDialog(makeValve());
    expect(await screen.findByText('Morning soak')).toBeInTheDocument();
  });

  it('shows the window count for a weekday with two compiled windows', async () => {
    schedulesMock.mockResolvedValueOnce(responseWithTuesdayWindows());
    renderDialog(makeValve());
    expect(await screen.findByText('2 of 4 windows')).toBeInTheDocument();
  });

  it('renders the conflict message when the API rejects a weekly save with a weekday-2 overlap', async () => {
    schedulesMock.mockResolvedValueOnce(emptyResponse());
    createScheduleMock.mockRejectedValueOnce(new ValvePlanConflictError([
      { code: 'overlap', weekday: 2, conflicts: ['sched-x'], labels: ['Existing window'] },
    ]));
    renderDialog(makeValve());

    await screen.findByText('Schedules');
    fireEvent.click(screen.getByRole('button', { name: 'Tue' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);

    expect(await screen.findByText('Overlaps another window on Tue.')).toBeInTheDocument();
  });

  it('renders a generic conflict message when the API rejects without weekday details', async () => {
    schedulesMock.mockResolvedValueOnce(emptyResponse());
    createScheduleMock.mockRejectedValueOnce(new ValvePlanConflictError([]));
    renderDialog(makeValve());

    await screen.findByText('Schedules');
    fireEvent.click(screen.getByRole('button', { name: 'Tue' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);

    expect(await screen.findByText('The schedule conflicts with the plan.')).toBeInTheDocument();
  });

  it('renders the invalid-start-time conflict message (i18n key, not a hardcoded literal) for an invalid_start_time conflict', async () => {
    schedulesMock.mockResolvedValueOnce(emptyResponse());
    createScheduleMock.mockRejectedValueOnce(new ValvePlanConflictError([
      { code: 'invalid_start_time', weekday: null, conflicts: [], labels: [] },
    ]));
    renderDialog(makeValve());

    await screen.findByText('Schedules');
    fireEvent.click(screen.getByRole('button', { name: 'Tue' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);

    expect(await screen.findByText('A schedule has an invalid start time.')).toBeInTheDocument();
  });

  it('labels a plain (non-conflict) weekly save failure via the scheduleDialog.saveFailed i18n key, not a hardcoded literal', async () => {
    schedulesMock.mockResolvedValueOnce(emptyResponse());
    createScheduleMock.mockRejectedValueOnce(new Error('network down'));
    renderDialog(makeValve());

    await screen.findByText('Schedules');
    fireEvent.click(screen.getByRole('button', { name: 'Tue' }));
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[0]);

    expect(await screen.findByText('Could not save the schedule.')).toBeInTheDocument();
  });

  it('guards a null WEEKLY startTime instead of rendering the literal "null"', async () => {
    schedulesMock.mockResolvedValueOnce(responseWithNullStartTime());
    renderDialog(makeValve());

    await screen.findByText('Schedules');
    expect(screen.getByText('Mon · — · 20 min')).toBeInTheDocument();
    expect(screen.queryByText(/null/)).not.toBeInTheDocument();
  });

  it('shows a loading state before the schedules request resolves', async () => {
    let resolveSchedules: (value: ValveSchedulesResponse) => void = () => {};
    schedulesMock.mockReturnValueOnce(new Promise((resolve) => { resolveSchedules = resolve; }));
    renderDialog(makeValve());

    expect(await screen.findByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByText('Schedules')).not.toBeInTheDocument();

    resolveSchedules(emptyResponse());
    await screen.findByText('Schedules');
  });

  it('shows a load-failure message with a retry that re-fetches the schedules', async () => {
    schedulesMock.mockRejectedValueOnce(new Error('network down'));
    renderDialog(makeValve());

    expect(await screen.findByText('Could not load schedules.')).toBeInTheDocument();
    // The dialog header (title + Cancel) is unconditional chrome, not part of the data view.
    expect(screen.queryByText('Schedules')).not.toBeInTheDocument();

    schedulesMock.mockResolvedValueOnce(emptyResponse());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await screen.findByText('Schedules');
    expect(schedulesMock).toHaveBeenCalledTimes(2);
  });

  describe('one-time fireAt: local date+time in the valve timezone -> UTC instant', () => {
    it('mid-January (no DST): 07:00 local -> 06:00Z', async () => {
      schedulesMock.mockResolvedValueOnce(emptyResponse());
      createScheduleMock.mockResolvedValueOnce({ schedule: {}, pushesQueued: 1 });
      renderDialog(makeValve({ timezone: 'Europe/Zurich' }));

      const fireAt = await saveOnceAndCaptureFireAt('2026-01-15', '07:00');
      expect(fireAt).toBe('2026-01-15T06:00:00.000Z');
    });

    it('mid-July (DST in effect): 06:00 local -> 04:00Z', async () => {
      schedulesMock.mockResolvedValueOnce(emptyResponse());
      createScheduleMock.mockResolvedValueOnce({ schedule: {}, pushesQueued: 1 });
      renderDialog(makeValve({ timezone: 'Europe/Zurich' }));

      const fireAt = await saveOnceAndCaptureFireAt('2026-07-15', '06:00');
      expect(fireAt).toBe('2026-07-15T04:00:00.000Z');
    });

    it('spring-forward transition day: 01:30 local (before the 02:00 gap) -> 00:30Z', async () => {
      schedulesMock.mockResolvedValueOnce(emptyResponse());
      createScheduleMock.mockResolvedValueOnce({ schedule: {}, pushesQueued: 1 });
      renderDialog(makeValve({ timezone: 'Europe/Zurich' }));

      const fireAt = await saveOnceAndCaptureFireAt('2026-03-29', '01:30');
      expect(fireAt).toBe('2026-03-29T00:30:00.000Z');
    });

    it('fall-back transition day: ambiguous 01:30 local round-trips back to 01:30 local', async () => {
      schedulesMock.mockResolvedValueOnce(emptyResponse());
      createScheduleMock.mockResolvedValueOnce({ schedule: {}, pushesQueued: 1 });
      renderDialog(makeValve({ timezone: 'Europe/Zurich' }));

      const fireAt = await saveOnceAndCaptureFireAt('2026-10-25', '01:30');
      // 01:30 occurs twice on this day (CEST then CET); a single-pass offset guess picks
      // the wrong one and round-trips to 02:30. Assert self-consistency instead of a fixed
      // instant: whichever occurrence the two-pass conversion picks must format back to 01:30.
      expect(localHHMM(fireAt, 'Europe/Zurich')).toBe('01:30');
    });
  });
});
