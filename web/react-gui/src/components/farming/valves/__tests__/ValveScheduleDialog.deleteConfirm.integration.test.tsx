import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enValves from '../../../../../public/locales/en/valves.json';
import enCommon from '../../../../../public/locales/en/common.json';
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

function schedulesResponse() {
  return {
    data: {
      schedules: [
        {
          schedule_uuid: 'row-a', device_eui: eui, kind: 'WEEKLY', label: 'Morning soak',
          weekdays_mask: 4, start_time: '06:00', duration_minutes: 30,
          timezone: 'Europe/Zurich', enabled: 1,
        },
        {
          // A device_eui that differs from the displayed valve: normalization keeps the
          // row, but the delete must still target the valve the dialog was opened for.
          schedule_uuid: 'row-b', device_eui: 'A840410000000001', kind: 'WEEKLY', label: 'Evening',
          weekdays_mask: 8, start_time: '18:00', duration_minutes: 15,
          timezone: 'Europe/Zurich', enabled: 1,
        },
      ],
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

async function mount() {
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: 'en',
    ns: ['valves', 'common'],
    defaultNS: 'valves',
    resources: { en: { valves: enValves, common: enCommon } },
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
  await screen.findByText(enValves.scheduleDialog.list);
  return onChanged;
}

function rowByLabel(label: string): HTMLElement {
  return screen.getByText(label).closest('li') as HTMLElement;
}

beforeEach(() => {
  http.get.mockReset();
  http.post.mockReset();
  http.put.mockReset();
  http.delete.mockReset();
  http.get.mockResolvedValue(schedulesResponse());
});

describe('delete confirmation through service normalization and mocked HTTP transport', () => {
  it('issues zero DELETE requests on the first tap and on dismissal', async () => {
    await mount();

    fireEvent.click(within(rowByLabel('Morning soak')).getByRole('button', { name: enValves.scheduleDialog.delete }));
    const confirm = await screen.findByRole('alertdialog');
    expect(within(confirm).getByText(enValves.scheduleDialog.deleteConfirmTitle)).toBeInTheDocument();
    expect(http.delete).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(http.delete).not.toHaveBeenCalled();

    fireEvent.click(within(rowByLabel('Morning soak')).getByRole('button', { name: enValves.scheduleDialog.delete }));
    fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: enValves.cancel }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(http.delete).not.toHaveBeenCalled();
    expect(http.post).not.toHaveBeenCalled();
    expect(http.put).not.toHaveBeenCalled();
  });

  it('explicit confirmation sends exactly one bodyless DELETE to the displayed valve EUI and row UUID', async () => {
    // The success-path transport reply the gateway shape defines: {ok, pushes_queued}.
    http.delete.mockResolvedValueOnce({ data: { ok: true, pushes_queued: 0 } });
    const onChanged = await mount();

    fireEvent.click(within(rowByLabel('Evening')).getByRole('button', { name: enValves.scheduleDialog.delete }));
    const confirm = await screen.findByRole('alertdialog');
    fireEvent.click(within(confirm).getByRole('button', { name: enValves.scheduleDialog.deleteConfirmButton }));

    await waitFor(() => expect(http.delete).toHaveBeenCalledTimes(1));
    // A single-argument call proves the DELETE carries no request body, and the URL binds
    // to the displayed valve EUI + row UUID, never the row's own device_eui field.
    expect(http.delete.mock.calls[0]).toEqual(['/api/valves/' + eui + '/schedules/row-b']);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(http.post).not.toHaveBeenCalled();
    expect(http.put).not.toHaveBeenCalled();
  });

  it('keeps the ordinary add (POST) and enable-toggle (PUT) request contracts untouched beside the confirmation', async () => {
    await mount();

    fireEvent.click(screen.getByRole('button', { name: enValves.weekdays['2'] }));
    fireEvent.click(screen.getAllByRole('button', { name: enValves.scheduleDialog.save })[0]);
    await waitFor(() => expect(http.post).toHaveBeenCalledTimes(1));
    expect(http.post.mock.calls[0]).toEqual([
      '/api/valves/' + eui + '/schedules',
      { kind: 'WEEKLY', label: null, weekdays_mask: 4, start_time: '06:00', duration_minutes: 30, enabled: true },
    ]);

    fireEvent.click(within(rowByLabel('Morning soak')).getByRole('checkbox', { name: enValves.scheduleDialog.enabled }));
    await waitFor(() => expect(http.put).toHaveBeenCalledTimes(1));
    expect(http.put).toHaveBeenCalledWith('/api/valves/' + eui + '/schedules/row-a', { enabled: false });
    expect(http.delete).not.toHaveBeenCalled();
  });
});
