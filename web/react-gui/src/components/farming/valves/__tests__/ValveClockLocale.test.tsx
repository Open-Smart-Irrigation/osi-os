import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ValveTile } from '../ValveTile';
import type { ValveSummary } from '../../../../types/farming';

/**
 * The zone card formats its clock from `i18n.language`; the valve tile and the
 * schedule dialog each had their own `formatClock` calling
 * `new Intl.DateTimeFormat(undefined, …)`, and `undefined` means the operating
 * system's locale. On the French card that produced "Mis à jour 02:59" eleven
 * lines above "Prochaine ouverture : 05:30 AM" — on the one card where the
 * time decides whether water moves.
 *
 * The test host's own locale is en-US, which is exactly the configuration that
 * hides the bug from a German-only check.
 */

const { language } = vi.hoisted(() => ({ language: { current: 'en' } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const table: Record<string, string> = {
        nextRun: 'Next: {{when}} · {{minutes}} min',
        'openDialog.summary': 'closes at {{time}}',
        'openDialog.title': 'Open valve',
        'openDialog.minutes': 'Minutes',
        'openDialog.confirm': 'Open',
        enclosure: 'Valve enclosure',
        'format.temperature': '{{value}} °C',
        'format.humidity': '{{value}} % RH',
        'state.closed': 'Closed',
        'lastSeen.never': 'Last seen: never',
      };
      return (table[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_m, name) => String(options?.[name] ?? ''));
    },
    i18n: { language: language.current },
  }),
}));

function valve(): ValveSummary {
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
    // 05:30 in Europe/Zurich, the hour the report's screenshot showed as "05:30 AM".
    nextRun: { at: '2026-07-08T03:30:00.000Z', kind: 'WEEKLY', minutes: 25, scheduleUuid: 'sched-1' },
    scheduleCount: 1,
    pushState: { queued: 0, acked: 0, failed: 0, lastPlanQueuedAt: null, lastPlanAckedAt: null },
    lastClockSyncAckedAt: null,
    enclosureTemperatureC: null,
    enclosureHumidityPct: null,
    enclosureMeasuredAt: null,
  };
}

function renderTile() {
  return render(
    <ValveTile
      valve={valve()}
      nowMs={Date.parse('2026-07-08T02:00:00.000Z')}
      onOpen={vi.fn()}
      onSchedule={vi.fn()}
      onCancel={vi.fn()}
      onSkipToday={vi.fn()}
      onPause={vi.fn()}
      onResume={vi.fn()}
      onResend={vi.fn()}
      onSettings={vi.fn()}
      onService={vi.fn()}
      onDelete={vi.fn()}
      busy={false}
    />,
  );
}

afterEach(() => {
  cleanup();
  language.current = 'en';
});

describe('valve clock locale', () => {
  it('reads the app language, not the operating system, in French', () => {
    language.current = 'fr';
    renderTile();

    expect(screen.getByText(/Next: 05:30 · 25 min/)).toBeInTheDocument();
    expect(screen.queryByText(/AM/)).not.toBeInTheDocument();
  });

  it('reads the app language in Swiss German', () => {
    language.current = 'de-CH';
    renderTile();

    expect(screen.getByText(/Next: 05:30 · 25 min/)).toBeInTheDocument();
  });

  it('still formats in the valve zone timezone, not UTC', () => {
    language.current = 'fr';
    renderTile();

    // 03:30 UTC is 05:30 in Europe/Zurich in July.
    expect(screen.queryByText(/03:30/)).not.toBeInTheDocument();
  });
});

describe('valve enclosure climate', () => {
  it('names the enclosure rather than printing bare field conditions', () => {
    language.current = 'en';
    render(
      <ValveTile
        valve={{ ...valve(), enclosureTemperatureC: 24.5, enclosureHumidityPct: 47 }}
        nowMs={Date.parse('2026-07-08T02:00:00.000Z')}
        onOpen={vi.fn()}
        onSchedule={vi.fn()}
        onCancel={vi.fn()}
        onSkipToday={vi.fn()}
        onPause={vi.fn()}
        onResume={vi.fn()}
        onResend={vi.fn()}
        onSettings={vi.fn()}
        onService={vi.fn()}
        onDelete={vi.fn()}
        busy={false}
      />,
    );

    // box_temp / box_hum from inside the buried housing, landing in the same
    // device_data column the weather station writes. Unlabelled on the tile it
    // read as zone air temperature.
    expect(screen.getByText(/Valve enclosure/)).toBeInTheDocument();
  });
});

/**
 * The other two clocks on the valve surface, both still calling
 * `new Intl.DateTimeFormat(undefined, …)`: the legacy card's actuation
 * feedback ("closes at 03:26 AM" on a French screen) and the open dialog's
 * "closes at" summary, which is the line an operator reads before committing
 * to moving water.
 */
describe('valve clocks outside the tile', () => {
  it('formats the actuation feedback in the app language', async () => {
    const { getStregaActuationFeedback } = await import('../../StregaValveCard');
    const rows = [{
      expectationId: 'exp-1',
      deviceEui: '0016C001F1000001',
      deviceName: 'North Valve',
      zoneId: 1,
      zoneName: 'North Block',
      commandId: 'cmd-1',
      commandedAt: '2026-07-08T03:00:00.000Z',
      commandedDurationSeconds: 1800,
      expectedCloseAt: '2026-07-08T03:30:00.000Z',
      observedOpenAt: '2026-07-08T03:01:00.000Z',
      observedCloseAt: null,
      estimatedGrossLiters: null,
      flowRateLpm: null,
      reconciliationState: 'OBSERVED_RUNNING',
      cancelReason: null,
      trigger: null,
      commandResult: null,
      commandResultDetail: null,
      commandAppliedAt: null,
      status: 'RUNNING',
    }] as any;
    const translate = (key: string, options?: Record<string, unknown>) =>
      String(options?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_m, n) => String(options?.[n] ?? ''));

    const french = getStregaActuationFeedback('0016C001F1000001', rows, 'Europe/Zurich', translate as any, 'fr');
    expect(french?.label).toContain('05:30');
    expect(french?.label).not.toContain('AM');

    const swissGerman = getStregaActuationFeedback('0016C001F1000001', rows, 'Europe/Zurich', translate as any, 'de-CH');
    expect(swissGerman?.label).toContain('05:30');
  });

  it('formats the open dialog closing time in the app language', async () => {
    language.current = 'fr';
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-07-08T03:00:00.000Z'));
    try {
      const { ValveOpenDialog } = await import('../ValveOpenDialog');
      render(
        <ValveOpenDialog
          valve={{ ...valve(), defaultOpenMinutes: 30 }}
          open
          onClose={vi.fn()}
          onSubmit={vi.fn()}
        />,
      );

      // 03:00 UTC + 30 min is 05:30 in Europe/Zurich.
      // `textContent` runs the elements together, so the 12-hour marker is
      // matched against the time it would follow rather than on a word boundary.
      const text = document.body.textContent ?? '';
      expect(text).toContain('closes at 05:30');
      expect(text).not.toMatch(/05:30\s*[AP]M/);
    } finally {
      vi.useRealTimers();
    }
  });
});
