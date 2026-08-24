import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';

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
    service: 'Service',
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
    pendingHint: "Waiting for the valve's next contact",
    closesAt: 'closes ≈ {{time}}',
    lastContact: 'Last contact {{when}} ago',
    neverSeen: 'Never seen',
    deleteMenuItem: 'Delete valve',
    deleteConfirmTitle: 'Delete this valve?',
    deleteConfirmBody: 'This removes it from the dashboard. Schedules are not sent again.',
    deleteConfirmButton: 'Yes, delete',
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

function renderTile(overrides: Partial<ValveSummary> = {}, callbackOverrides: Partial<ComponentProps<typeof ValveTile>> = {}) {
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
      onService={vi.fn()}
      onDelete={vi.fn()}
      busy={false}
      {...callbackOverrides}
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

// The five items from osi-os#171's original acceptance criteria, brought onto the daily
// surface (ValveTile/ValveControlPanel) per the 2026-08-24 consolidation plan Task 2.
describe('ValveTile #171 disclosures', () => {
  it('1. shows the device EUI (legacy-only today)', () => {
    renderTile({ deviceEui: '0016C001F1000042' });
    expect(screen.getByText('0016C001F1000042')).toBeInTheDocument();
  });

  it('2. discloses a valve that has never reported instead of rendering it as closed and fine', () => {
    renderTile({ currentState: 'CLOSED', lastUplinkAt: null, activeActuation: null });
    expect(screen.getByText('Never seen')).toBeInTheDocument();
    expect(screen.queryByText('Closed')).not.toBeInTheDocument();
  });

  it('2b. does not show the never-seen disclosure once a valve has reported', () => {
    renderTile({ currentState: 'CLOSED', lastUplinkAt: '2026-08-20T10:00:00.000Z' });
    expect(screen.queryByText('Never seen')).not.toBeInTheDocument();
    expect(screen.getByText('Closed')).toBeInTheDocument();
  });

  it('2c. a never-uplinked valve with a pending open still shows the honest pending state, not "never seen"', () => {
    renderTile({
      lastUplinkAt: null,
      activeActuation: {
        expectationId: 'exp-1',
        reconciliationState: 'PENDING_OBSERVATION',
        commandedAt: new Date().toISOString(),
        expectedCloseAt: new Date(Date.now() + 300_000).toISOString(),
        durationSeconds: 300,
        trigger: 'manual',
      },
    });
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.queryByText('Never seen')).not.toBeInTheDocument();
  });

  it('3. says a commanded-but-unconfirmed open is pending, matching the honesty the legacy card already has', () => {
    renderTile({
      activeActuation: {
        expectationId: 'exp-1',
        reconciliationState: 'PENDING_OBSERVATION',
        commandedAt: new Date().toISOString(),
        expectedCloseAt: new Date(Date.now() + 300_000).toISOString(),
        durationSeconds: 300,
        trigger: 'manual',
      },
    });
    expect(screen.getByText('Pending')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for the valve's next contact/)).toBeInTheDocument();
  });

  it('4. tapping Open only invokes the onOpen callback -- it never calls an API directly (one tap must not move water)', () => {
    const onOpen = vi.fn();
    renderTile({}, { onOpen });
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('5. delete is reachable from the overflow menu (not adjacent to the primary Open button)', () => {
    renderTile();
    // Open is a top-level button, never inside the "more" menu.
    expect(screen.getByRole('button', { name: 'Open' }).closest('[role="menu"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const deleteItem = screen.getByRole('menuitem', { name: 'Delete valve' });
    expect(deleteItem.closest('[role="menu"]')).not.toBeNull();
  });

  it('5b. delete requires confirmation before calling onDelete -- one tap must not remove the valve', () => {
    const onDelete = vi.fn();
    renderTile({}, { onDelete });

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete valve' }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Yes, delete' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Yes, delete' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('adds a low-prominence Service entry point in the overflow menu, not a primary button', () => {
    const onService = vi.fn();
    renderTile({}, { onService });

    expect(screen.queryByRole('button', { name: 'Service' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Service' }));
    expect(onService).toHaveBeenCalledTimes(1);
  });
});
