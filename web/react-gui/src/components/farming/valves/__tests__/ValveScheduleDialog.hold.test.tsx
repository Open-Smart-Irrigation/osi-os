import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
      'commandNoAnswer.open': NO_ANSWER_OPEN,
    } as Record<string, string>)[key] ?? key,
    i18n: { language: 'en' },
  }),
}));

const { schedulesMock, createScheduleMock } = vi.hoisted(() => ({ schedulesMock: vi.fn(), createScheduleMock: vi.fn() }));

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
});
