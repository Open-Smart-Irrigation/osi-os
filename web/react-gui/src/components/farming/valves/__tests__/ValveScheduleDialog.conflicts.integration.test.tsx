import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enValves from '../../../../../public/locales/en/valves.json';
import enCommon from '../../../../../public/locales/en/common.json';
import deValves from '../../../../../public/locales/de-CH/valves.json';
import deCommon from '../../../../../public/locales/de-CH/common.json';
import conflict422 from './fixtures/planConflict422.json';
import type { ValveSummary } from '../../../../types/farming';

const { http } = vi.hoisted(() => {
  const interceptor = { use: vi.fn() };
  return {
    http: {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      interceptors: { request: interceptor, response: interceptor },
    },
  };
});

vi.mock('axios', () => {
  const axios = {
    create: vi.fn(() => http),
    isAxiosError: (error: unknown) => Boolean((error as { isAxiosError?: boolean } | null)?.isAxiosError),
  };
  return { default: axios, ...axios };
});

import { ValveScheduleDialog } from '../ValveScheduleDialog';

const eui = '0016C001F1000001';
const emptyDays = [[], [], [], [], [], [], []];

function axiosFailure(payload: unknown) {
  return Object.assign(new Error('Request failed with status code 422'), {
    isAxiosError: true,
    response: { status: 422, data: payload },
  });
}

function schedulesResponse(schedules: unknown[] = []) {
  return {
    data: {
      schedules,
      compiled: { days: emptyDays, errors: [] },
      push_state: [],
      settings: {
        strega_generation: 'GEN1',
        flow_rate_lpm: null,
        flow_rate_source: null,
        default_open_minutes: null,
      },
    },
  };
}

function valve(): ValveSummary {
  return {
    deviceEui: eui,
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
  };
}

async function mount(language: 'en' | 'de-CH' = 'en') {
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['valves', 'common'],
    defaultNS: 'valves',
    resources: {
      en: { valves: enValves, common: enCommon },
      'de-CH': { valves: deValves, common: deCommon },
    },
    interpolation: { escapeValue: false },
  });
  const onChanged = vi.fn();
  render(
    <I18nextProvider i18n={i18n}>
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, shouldRetryOnError: false }}>
        <ValveScheduleDialog valve={valve()} open onClose={vi.fn()} onChanged={onChanged} />
      </SWRConfig>
    </I18nextProvider>,
  );
  await screen.findByText(language === 'en' ? enValves.scheduleDialog.list : deValves.scheduleDialog.list);
  return onChanged;
}

function clickWeeklySave(language: 'en' | 'de-CH' = 'en') {
  const label = language === 'en' ? enValves.scheduleDialog.save : deValves.scheduleDialog.save;
  fireEvent.click(screen.getAllByRole('button', { name: label })[0]);
}

function errorText(expected: string) {
  return screen.findByText((_, element) => element?.tagName === 'P' && element.textContent === expected);
}

const enDetails = 'Overlaps another window on Mon. (<img src=x onerror=alert(1)>, Proposed)\nTue would have more than 4 windows. (First, Proposed)';

beforeEach(() => {
  http.get.mockReset();
  http.post.mockReset();
  http.put.mockReset();
  http.delete.mockReset();
  http.get.mockResolvedValue(schedulesResponse());
});

describe('server conflict payload through service normalization and mounted dialog', () => {
  it.each([
    { language: 'en' as const, day: 'Tue', expected: enDetails },
    {
      language: 'de-CH' as const,
      day: 'Di',
      expected: 'Überschneidet sich mit einem anderen Fenster am Mo. (<img src=x onerror=alert(1)>, Proposed)\nDi hätte mehr als 4 Fenster. (First, Proposed)',
    },
  ])('shows both route-bound details in $language and keeps the same Save request available', async ({ language, day, expected }) => {
    http.post
      .mockRejectedValueOnce(axiosFailure(conflict422))
      .mockResolvedValueOnce({ data: { schedule: { schedule_uuid: 'new-row' }, pushes_queued: 0 } });
    const onChanged = await mount(language);

    fireEvent.click(screen.getByRole('button', { name: day }));
    clickWeeklySave(language);
    const error = await errorText(expected);
    expect(error).toHaveClass('whitespace-pre-line');
    expect(error.querySelector('img')).toBeNull();

    clickWeeklySave(language);
    await waitFor(() => expect(http.post).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(http.post.mock.calls[0]).toEqual(http.post.mock.calls[1]);
    expect(http.post.mock.calls[0]).toEqual([
      '/api/valves/' + eui + '/schedules',
      { kind: 'WEEKLY', label: null, weekdays_mask: 4, start_time: '06:00', duration_minutes: 30, enabled: true },
    ]);
  });

  it.each([
    { name: 'empty array', details: [], expected: enValves.scheduleDialog.conflictGeneric },
    { name: 'non-array', details: 'invalid', expected: enValves.scheduleDialog.conflictGeneric },
    { name: 'null member', details: [null], expected: enValves.scheduleDialog.conflictGeneric },
    { name: 'unknown code', details: [{ code: 'future_code', weekday: 2, labels: ['Future'] }], expected: enValves.scheduleDialog.conflictGeneric + ' (Future)' },
    { name: 'malformed weekday', details: [{ code: 'overlap', weekday: 'Monday', labels: ['Existing'] }], expected: enValves.scheduleDialog.conflictGeneric + ' (Existing)' },
  ])('uses the real generic key for $name details', async ({ details, expected }) => {
    http.post.mockRejectedValueOnce(axiosFailure({ error: 'plan_conflict', details }));
    await mount();
    fireEvent.click(screen.getByRole('button', { name: enValves.weekdays['2'] }));
    clickWeeklySave();
    expect(await errorText(expected)).toBeInTheDocument();
  });

  it('retains the invalid-start key and the ordinary failure path', async () => {
    http.post
      .mockRejectedValueOnce(axiosFailure({ error: 'plan_conflict', details: [{ code: 'invalid_start_time', weekday: null, conflicts: [], labels: [] }] }))
      .mockRejectedValueOnce(new Error('network down'));
    await mount();
    fireEvent.click(screen.getByRole('button', { name: enValves.weekdays['2'] }));
    clickWeeklySave();
    expect(await errorText(enValves.scheduleDialog.conflictInvalidStart)).toBeInTheDocument();
    clickWeeklySave();
    expect(await errorText(enValves.scheduleDialog.saveFailed)).toBeInTheDocument();
    expect(http.post).toHaveBeenCalledTimes(2);
  });

  it('shows every detail on the one-time Save error surface', async () => {
    http.post.mockRejectedValueOnce(axiosFailure(conflict422));
    await mount();
    fireEvent.change(screen.getByLabelText(enValves.scheduleDialog.date), { target: { value: '2099-01-01' } });
    fireEvent.change(screen.getByLabelText(enValves.scheduleDialog.time), { target: { value: '06:00' } });
    fireEvent.click(screen.getAllByRole('button', { name: enValves.scheduleDialog.save })[1]);
    const error = await errorText(enDetails);
    expect(error).toHaveClass('whitespace-pre-line');
    expect(http.post).toHaveBeenCalledTimes(1);
  });

  it('shows every detail on the row update error surface', async () => {
    http.get.mockResolvedValue(schedulesResponse([{
      schedule_uuid: 'monday', device_eui: eui, kind: 'WEEKLY', label: 'Existing',
      weekdays_mask: 2, start_time: '06:00', duration_minutes: 30,
      timezone: 'Europe/Zurich', enabled: 1,
    }]));
    http.put.mockRejectedValueOnce(axiosFailure(conflict422));
    await mount();
    fireEvent.click(screen.getByRole('checkbox', { name: enValves.scheduleDialog.enabled }));
    const error = await errorText(enDetails);
    expect(error).toHaveClass('whitespace-pre-line');
    expect(http.put).toHaveBeenCalledWith('/api/valves/' + eui + '/schedules/monday', { enabled: false });
  });
});
