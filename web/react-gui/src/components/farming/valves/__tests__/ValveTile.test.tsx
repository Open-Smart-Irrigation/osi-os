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
    cancelQueuedOpen: 'Cancel queued open',
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
    planIncomplete: 'Not yet confirmed on the valve for {{count}} day(s) — resend the plan',
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
    battery: 'Battery: {{percent}} %',
    // Deliberately distinct from `neverSeen` above (the big state-label override) so a
    // test asserting on this top-right label can never accidentally match that one --
    // both really do render "Never seen" in production copy (see valveCardHelpers.ts's
    // own doc comment on the ported-from-cloud duplication), but the test fixture text
    // only needs to be unambiguous, not production-accurate.
    'lastSeen.never': 'Last seen: never',
    'lastSeen.justNow': 'Last seen: just now',
    'lastSeen.minutesAgo_one': 'Last seen: {{count}} minute ago',
    'lastSeen.minutesAgo_other': 'Last seen: {{count}} minutes ago',
    'lastSeen.hoursAgo_one': 'Last seen: {{count}} hour ago',
    'lastSeen.hoursAgo_other': 'Last seen: {{count}} hours ago',
    'lastSeen.daysAgo_one': 'Last seen: {{count}} day ago',
    'lastSeen.daysAgo_other': 'Last seen: {{count}} days ago',
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

  it("still surfaces the incomplete-plan line when some downlinks are also queued", () => {
    renderTile({
      pushState: { queued: 2, acked: 1, failed: 2, lastPlanQueuedAt: null, lastPlanAckedAt: null },
    });
    expect(screen.getByText("Not yet confirmed on the valve for 2 day(s) — resend the plan")).toBeInTheDocument();
  });

  it("surfaces the incomplete-plan line when nothing is queued", () => {
    renderTile({
      pushState: { queued: 0, acked: 1, failed: 1, lastPlanQueuedAt: null, lastPlanAckedAt: null },
    });
    expect(screen.getByText("Not yet confirmed on the valve for 1 day(s) — resend the plan")).toBeInTheDocument();
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
  it('1. does NOT show the device EUI', () => {
    // Reversed by operator decision 2026-08-24: #171 listed the EUI as something the
    // surviving surface had to carry, but a 16-hex identifier is engineering detail a
    // farmer never acts on, and it crowds the line that shows valve state. It stays
    // available on the device card. Asserted rather than merely deleted so it does not
    // drift back in on the strength of the old checklist.
    renderTile({ deviceEui: '0016C001F1000042' });
    expect(screen.queryByText('0016C001F1000042')).not.toBeInTheDocument();
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

// I6 (final fix wave): last-seen top-right label + battery footer, ported from the
// OSI Server cloud's ValveTile.tsx placement. Tier logic itself (describeLastSeen) is unit
// tested directly in valveCardHelpers.test.ts; these assert the tile actually renders what
// that helper produces, and that the battery line is honestly omitted rather than "—".
describe('ValveTile last-seen label (I6)', () => {
  it('shows the "never" tier when the valve has no lastUplinkAt', () => {
    renderTile({ lastUplinkAt: null });
    expect(screen.getByText('Last seen: never')).toBeInTheDocument();
  });

  it('shows the "just now" tier for a contact under a minute old', () => {
    renderTile({ lastUplinkAt: new Date(Date.now() - 10_000).toISOString() });
    expect(screen.getByText('Last seen: just now')).toBeInTheDocument();
  });

  it('shows the singular minutes tier for a one-minute-old contact', () => {
    renderTile({ lastUplinkAt: new Date(Date.now() - 60_000).toISOString() });
    expect(screen.getByText('Last seen: 1 minute ago')).toBeInTheDocument();
  });

  it('shows the plural minutes tier for a contact several minutes old', () => {
    renderTile({ lastUplinkAt: new Date(Date.now() - 5 * 60_000).toISOString() });
    expect(screen.getByText('Last seen: 5 minutes ago')).toBeInTheDocument();
  });

  it('shows the hours tier for a contact several hours old', () => {
    renderTile({ lastUplinkAt: new Date(Date.now() - 3 * 3_600_000).toISOString() });
    expect(screen.getByText('Last seen: 3 hours ago')).toBeInTheDocument();
  });

  it('shows the days tier for a contact several days old', () => {
    renderTile({ lastUplinkAt: new Date(Date.now() - 2 * 86_400_000).toISOString() });
    expect(screen.getByText('Last seen: 2 days ago')).toBeInTheDocument();
  });
});

describe('ValveTile battery footer (I6)', () => {
  it('shows nothing at all when no battery data is available', () => {
    const { container } = renderTile();
    expect(container.textContent).not.toMatch(/Battery:/);
  });

  it('shows the battery percent when bat_pct is present', () => {
    renderTile({}, { batteryPercent: 72 });
    expect(screen.getByText('Battery: 72 %')).toBeInTheDocument();
  });

  it('falls back to the voltage-derived percent when bat_pct is absent', () => {
    // LSN50 usable range is 2.1V-3.6V (deviceCardBattery.ts) -- 3.6V is a full battery.
    renderTile({}, { batteryVoltage: 3.6 });
    expect(screen.getByText('Battery: 100 %')).toBeInTheDocument();
  });

  it('prefers bat_pct over the voltage fallback when both are present', () => {
    renderTile({}, { batteryPercent: 40, batteryVoltage: 3.6 });
    expect(screen.getByText('Battery: 40 %')).toBeInTheDocument();
    expect(screen.queryByText('Battery: 100 %')).not.toBeInTheDocument();
  });
});

// M-2 (final fix wave review): the pending-state primary action used to share the
// generic `cancel` key with every dismiss/close-dialog button in this file family, which read
// as a bare "Cancel" out of context. It now has its own key.
describe('ValveTile pending-cancel label (M-2)', () => {
  it('labels the primary action "Cancel queued open" (not the generic dismiss "Cancel") while a command is pending', () => {
    const onCancel = vi.fn();
    renderTile(
      {
        activeActuation: {
          expectationId: 'exp-1',
          reconciliationState: 'PENDING_OBSERVATION',
          commandedAt: new Date().toISOString(),
          expectedCloseAt: new Date(Date.now() + 300_000).toISOString(),
          durationSeconds: 300,
          trigger: 'manual',
        },
      },
      { onCancel },
    );
    expect(screen.queryByRole('button', { name: 'Open' })).not.toBeInTheDocument();
    const primary = screen.getByRole('button', { name: 'Cancel queued open' });
    fireEvent.click(primary);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
