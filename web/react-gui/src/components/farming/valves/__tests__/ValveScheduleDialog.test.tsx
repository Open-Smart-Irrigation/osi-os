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
    'scheduleDialog.push.QUEUED': 'waiting for valve',
    'scheduleDialog.push.ACKED': 'acknowledged {{when}}',
    'scheduleDialog.push.FAILED': 'failed',
    bluetoothNote: 'Changes made on the valve over Bluetooth are not visible here.',
    noSchedule: 'No schedule',
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

function renderDialog(valve: ValveSummary, onChanged = vi.fn()) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ValveScheduleDialog valve={valve} open onClose={vi.fn()} onChanged={onChanged} />
    </SWRConfig>,
  );
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

  it('builds a one-time fireAt as the UTC instant of the chosen local date+time in the valve timezone', async () => {
    schedulesMock.mockResolvedValueOnce(emptyResponse());
    createScheduleMock.mockResolvedValueOnce({ schedule: {}, pushesQueued: 1 });
    renderDialog(makeValve({ timezone: 'Europe/Zurich' }));

    await screen.findByText('Schedules');
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-01-15' } });
    fireEvent.change(screen.getByLabelText('Time'), { target: { value: '07:00' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Save' })[1]);

    await waitFor(() => expect(createScheduleMock).toHaveBeenCalled());
    const [, input] = createScheduleMock.mock.calls[0];
    expect(input.kind).toBe('ONCE');
    // Zurich is UTC+1 in mid-January (no DST) -> 07:00 local == 06:00 UTC.
    expect(input.fireAt).toBe('2026-01-15T06:00:00.000Z');
  });
});
