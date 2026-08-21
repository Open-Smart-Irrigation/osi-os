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
