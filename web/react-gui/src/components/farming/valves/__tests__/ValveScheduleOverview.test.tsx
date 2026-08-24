import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

import { ValveScheduleOverview } from '../ValveScheduleOverview';
import { valvesAPI } from '../../../../services/api';
import type { ValveSummary } from '../../../../types/farming';

const { translateForTest } = vi.hoisted(() => {
  const table: Record<string, string> = {
    'overview.title': 'Irrigation plan — all valves',
    'overview.subtitle': 'Every saved schedule across your valves.',
    'overview.loading': 'Loading…',
    'overview.off': 'off',
    noSchedule: 'No schedule yet',
    unassignedZone: 'Unassigned',
    'scheduleDialog.loadFailed': 'Could not load schedules',
    'weekdays.0': 'Sun', 'weekdays.1': 'Mon', 'weekdays.3': 'Wed',
    'weekdays.4': 'Thu', 'weekdays.6': 'Sat',
  };
  return { translateForTest: (k: string) => table[k] ?? k };
});

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translateForTest, i18n: { language: 'en' } }) }));
vi.mock('../../../../services/api', () => ({ valvesAPI: { schedules: vi.fn() } }));
vi.mock('swr', () => ({
  default: (key: string | null, fetcher: () => Promise<unknown>) => {
    const state = (globalThis as any).__swr ?? {};
    return state[key as string] ?? { data: undefined, error: undefined };
  },
}));

const valve = (eui: string, name: string, zoneName: string | null = 'North'): ValveSummary => ({
  deviceEui: eui, name, zoneId: 1, zoneName, zoneUuid: 'z', timezone: 'CET',
  currentState: 'CLOSED', targetState: null, stregaGeneration: 'GEN2', flowRateLpm: null,
  flowRateSource: null, defaultOpenMinutes: null, schedulerStatus: 'ACTIVE', skipTodayDate: null,
  lastUplinkAt: '2026-08-24T10:00:00Z', activeActuation: null, recentStaleState: null,
  nextRun: null, scheduleCount: 0,
  pushState: { queued: 0, acked: 0, failed: 0, lastPlanQueuedAt: null, lastPlanAckedAt: null },
  lastClockSyncAckedAt: null, enclosureTemperatureC: null, enclosureHumidityPct: null,
  enclosureMeasuredAt: null,
});

const sched = (uuid: string, mask: number, start: string, dur: number, extra = {}) => ({
  scheduleUuid: uuid, deviceEui: 'x', kind: 'WEEKLY' as const, label: null,
  weekdaysMask: mask, startTime: start, fireAt: null, durationMinutes: dur,
  timezone: 'CET', enabled: true, onceState: null, ...extra,
});

const resp = (schedules: any[]) => ({
  data: { schedules, compiled: { days: [], errors: [] }, pushState: [], settings: {} },
  error: undefined,
});

beforeEach(() => { (globalThis as any).__swr = {}; vi.clearAllMocks(); });

describe('ValveScheduleOverview', () => {
  it('shows every valve, not just one — this is a whole-holding view', () => {
    (globalThis as any).__swr = {
      '/api/valves/AAA/schedules': resp([sched('s1', 0x12, '06:00', 30)]),
      '/api/valves/BBB/schedules': resp([sched('s2', 0x49, '07:00', 45)]),
    };
    render(<ValveScheduleOverview valves={[valve('AAA', 'North valve'), valve('BBB', 'South valve')]} onOpenValve={vi.fn()} />);
    expect(screen.getByText('North valve')).toBeInTheDocument();
    expect(screen.getByText('South valve')).toBeInTheDocument();
    // and each valve's own schedule alongside it
    expect(screen.getByText(/Mon Thu/)).toBeInTheDocument();
    // Monday-first display over the 0=Sunday mask, so 0x49 reads 'Wed Sat Sun'.
    expect(screen.getByText(/Wed Sat Sun/)).toBeInTheDocument();
  });

  it('renders the weekday mask Monday-first while keeping the 0=Sunday encoding', () => {
    // mask 0x49 = bits 0,3,6 = Sun, Wed, Sat. Displayed Monday-first, so Sun comes LAST.
    (globalThis as any).__swr = { '/api/valves/AAA/schedules': resp([sched('s1', 0x49, '06:00', 45)]) };
    render(<ValveScheduleOverview valves={[valve('AAA', 'North valve')]} onOpenValve={vi.fn()} />);
    expect(screen.getByText(/Wed Sat Sun · 06:00–06:45 · 45 min/)).toBeInTheDocument();
  });

  it('says so when a valve has no schedule rather than leaving it blank', () => {
    (globalThis as any).__swr = { '/api/valves/AAA/schedules': resp([]) };
    render(<ValveScheduleOverview valves={[valve('AAA', 'North valve')]} onOpenValve={vi.fn()} />);
    expect(screen.getByText('No schedule yet')).toBeInTheDocument();
  });

  it('marks a disabled schedule as off instead of hiding it', () => {
    (globalThis as any).__swr = {
      '/api/valves/AAA/schedules': resp([sched('s1', 0x12, '06:00', 30, { enabled: false })]),
    };
    render(<ValveScheduleOverview valves={[valve('AAA', 'North valve')]} onOpenValve={vi.fn()} />);
    expect(screen.getByText(/off/)).toBeInTheDocument();
  });

  it('surfaces a load failure instead of implying the valve has no schedule', () => {
    (globalThis as any).__swr = { '/api/valves/AAA/schedules': { data: undefined, error: new Error('boom') } };
    render(<ValveScheduleOverview valves={[valve('AAA', 'North valve')]} onOpenValve={vi.fn()} />);
    expect(screen.getByText('Could not load schedules')).toBeInTheDocument();
    expect(screen.queryByText('No schedule yet')).not.toBeInTheDocument();
  });

  it('renders nothing at all when there are no valves', () => {
    const { container } = render(<ValveScheduleOverview valves={[]} onOpenValve={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
