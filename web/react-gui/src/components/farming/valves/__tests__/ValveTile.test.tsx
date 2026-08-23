import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ValveTile } from '../ValveTile';
import type { ValveSummary } from '../../../../types/farming';

const { translateForTest } = vi.hoisted(() => {
  const table: Record<string, string> = {
    open: 'Open',
    schedule: 'Schedule',
    cancel: 'Cancel',
    more: 'More',
    skipToday: 'Skip today',
    pauseSchedules: 'Pause schedules',
    resumeSchedules: 'Resume schedules',
    resendPlan: 'Resend plan',
    settings: 'Settings',
    unassignedZone: 'Unassigned',
    noSchedule: 'No schedule',
    schedulerPaused: 'Schedules paused',
    skippedToday: 'Skipped today',
    'state.closed': 'Closed',
    'state.pending': 'Pending',
    'state.open': 'Open',
    'state.closing': 'Closing',
    'state.failed': 'Failed',
    planFailed: '{{count}} downlink(s) not acknowledged in 24 h',
    'format.temperature': '{{value}} °C',
    'format.humidity': '{{value}} % RH',
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

function renderTile(overrides: Partial<ValveSummary> = {}) {
  return render(
    <ValveTile
      valve={makeValve(overrides)}
      nowMs={Date.now()}
      onOpen={vi.fn()}
      onSchedule={vi.fn()}
      onCancel={vi.fn()}
      onSkipToday={vi.fn()}
      onPause={vi.fn()}
      onResume={vi.fn()}
      onResend={vi.fn()}
      onSettings={vi.fn()}
      busy={false}
    />,
  );
}

describe('ValveTile touch targets', () => {
  it('gives the primary action (Open/Cancel) button a >=44px effective touch target', () => {
    renderTile();
    expect(screen.getByRole('button', { name: 'Open' })).toHaveClass('min-h-[44px]');
  });

  it('gives the Schedule button a >=44px effective touch target', () => {
    renderTile();
    expect(screen.getByRole('button', { name: 'Schedule' })).toHaveClass('min-h-[44px]');
  });

  it('gives the "more" menu button a >=44px square effective touch target', () => {
    renderTile();
    const moreButton = screen.getByRole('button', { name: 'More' });
    expect(moreButton).toHaveClass('min-h-[44px]');
    expect(moreButton).toHaveClass('min-w-[44px]');
  });

  it('gives every item in the overflow menu a >=44px effective touch target', () => {
    renderTile();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    for (const item of screen.getAllByRole('menuitem')) {
      expect(item).toHaveClass('min-h-[44px]');
    }
  });
});

describe('ValveTile enclosure climate reading', () => {
  it('shows the enclosure reading when a Gen1 valve has reported one', () => {
    renderTile({ stregaGeneration: 'GEN1', enclosureTemperatureC: 21.5, enclosureHumidityPct: 48.2 });
    expect(screen.getByText(/21[.,]5/)).toBeInTheDocument();
    expect(screen.getByText(/48/)).toBeInTheDocument();
  });

  it('renders a measured zero rather than treating it as missing', () => {
    renderTile({ stregaGeneration: 'GEN1', enclosureTemperatureC: 0, enclosureHumidityPct: 0 });
    expect(screen.getByText('0 °C · 0 % RH')).toBeInTheDocument();
  });

  it('shows nothing at all when a Gen1 valve has not reported a reading', () => {
    const { container } = renderTile({ stregaGeneration: 'GEN1', enclosureTemperatureC: null, enclosureHumidityPct: null });
    expect(container.textContent).not.toMatch(/°C|% RH/);
  });

  it('shows nothing at all for a Gen2 valve, even if a value somehow exists', () => {
    const { container } = renderTile({ stregaGeneration: 'GEN2', enclosureTemperatureC: 21.5, enclosureHumidityPct: 48 });
    expect(container.textContent).not.toMatch(/21\.5|48/);
  });

  it('keeps the pair unbreakable so humidity never orphans onto its own line', () => {
    renderTile({ stregaGeneration: 'GEN1', enclosureTemperatureC: 21.5, enclosureHumidityPct: 48 });
    const pair = screen.getByText(/21[.,]5 °C · 48 % RH/);
    expect(pair.className).toMatch(/whitespace-nowrap/);
    expect(pair.className).toMatch(/inline-block/);
  });
});

describe("ValveTile plan line", () => {
  it("shows no plan-delivery progress line while downlinks are still queued", () => {
    const { container } = renderTile({
      pushState: { queued: 3, acked: 4, failed: 0, lastPlanQueuedAt: null, lastPlanAckedAt: null },
    });
    expect(container.textContent).not.toMatch(/planDelivery|acknowledged/);
  });

  it("still surfaces the failed-downlink line when some downlinks are also queued", () => {
    renderTile({
      pushState: { queued: 2, acked: 1, failed: 2, lastPlanQueuedAt: null, lastPlanAckedAt: null },
    });
    expect(screen.getByText("2 downlink(s) not acknowledged in 24 h")).toBeInTheDocument();
  });

  it("surfaces the failed-downlink line when nothing is queued", () => {
    renderTile({
      pushState: { queued: 0, acked: 1, failed: 1, lastPlanQueuedAt: null, lastPlanAckedAt: null },
    });
    expect(screen.getByText("1 downlink(s) not acknowledged in 24 h")).toBeInTheDocument();
  });

  it("shows no plan line at all when every downlink is acknowledged", () => {
    const { container } = renderTile({
      pushState: { queued: 0, acked: 7, failed: 0, lastPlanQueuedAt: null, lastPlanAckedAt: null },
    });
    expect(container.textContent).not.toMatch(/downlink|acknowledged/);
  });
});
