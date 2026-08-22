import { describe, it, expect } from 'vitest';
import { deriveValveGlyphState, estimateLiters, weekdaysFromMask, maskFromWeekdays, sortWeekdaysForDisplay, windowEnd } from '../valveState';
import type { ValveSummary } from '../../../../types/farming';

const base: ValveSummary = { deviceEui: '0016C001F1000001', name: 'A', zoneId: 1, zoneName: 'Z', zoneUuid: 'u', timezone: 'Europe/Zurich', currentState: 'CLOSED', targetState: null, stregaGeneration: 'GEN1', flowRateLpm: null, flowRateSource: null, defaultOpenMinutes: null, schedulerStatus: 'ACTIVE', skipTodayDate: null, lastUplinkAt: null, activeActuation: null, recentStaleState: null, nextRun: null, scheduleCount: 0, pushState: { queued: 0, acked: 0, failed: 0, lastPlanQueuedAt: null, lastPlanAckedAt: null }, lastClockSyncAckedAt: null, enclosureTemperatureC: null, enclosureHumidityPct: null, enclosureMeasuredAt: null };
const now = Date.parse('2026-08-19T10:00:00Z');

describe('deriveValveGlyphState', () => {
  it('closed when no actuation and state CLOSED', () => { expect(deriveValveGlyphState(base, now).state).toBe('closed'); });
  it('pending while PENDING_OBSERVATION', () => {
    const v = { ...base, activeActuation: { expectationId: 'e', reconciliationState: 'PENDING_OBSERVATION', commandedAt: '2026-08-19T09:59:00Z', expectedCloseAt: '2026-08-19T10:31:00Z', durationSeconds: 1800, trigger: 'manual' } };
    expect(deriveValveGlyphState(v, now).state).toBe('pending');
  });
  it('open with progress and remaining while OBSERVED_RUNNING before expected close', () => {
    const v = { ...base, currentState: 'OPEN' as const, activeActuation: { expectationId: 'e', reconciliationState: 'OBSERVED_RUNNING', commandedAt: '2026-08-19T09:50:00Z', expectedCloseAt: '2026-08-19T10:22:00Z', durationSeconds: 1800, trigger: 'on_valve_schedule' } };
    const r = deriveValveGlyphState(v, now);
    expect(r.state).toBe('open'); expect(r.remainingSeconds).toBe(1200); expect(r.progress).toBeCloseTo(1 / 3, 2);
  });
  it('closing after expected close while still OBSERVED_RUNNING', () => {
    const v = { ...base, currentState: 'OPEN' as const, activeActuation: { expectationId: 'e', reconciliationState: 'OBSERVED_RUNNING', commandedAt: '2026-08-19T09:00:00Z', expectedCloseAt: '2026-08-19T09:32:00Z', durationSeconds: 1800, trigger: 'manual' } };
    expect(deriveValveGlyphState(v, now).state).toBe('closing');
  });
  it('failed on a recent STALE state or a failed push', () => {
    expect(deriveValveGlyphState({ ...base, recentStaleState: 'STALE_NO_OBSERVATION' }, now).state).toBe('failed');
    expect(deriveValveGlyphState({ ...base, pushState: { ...base.pushState, failed: 1 } }, now).state).toBe('failed');
  });
  it('open with unknown duration (unexplained) has null progress', () => {
    const v = { ...base, currentState: 'OPEN' as const, activeActuation: { expectationId: 'e', reconciliationState: 'OBSERVED_RUNNING', commandedAt: '2026-08-19T09:50:00Z', expectedCloseAt: '2026-08-20T09:50:00Z', durationSeconds: 0, trigger: 'unexplained' } };
    const r = deriveValveGlyphState(v, now); expect(r.state).toBe('open'); expect(r.progress).toBeNull(); expect(r.remainingSeconds).toBeNull();
  });
});

describe('helpers', () => {
  it('estimateLiters rounds to 10 L and keeps null', () => { expect(estimateLiters(12.5, 30)).toBe(380); expect(estimateLiters(null, 30)).toBeNull(); });
  it('mask round trip', () => { expect(weekdaysFromMask(0b1000101)).toEqual([0, 2, 6]); expect(maskFromWeekdays([1, 3, 5])).toBe(0b0101010); });
  it('windowEnd wraps midnight', () => { expect(windowEnd('23:05', 65)).toBe('00:10'); expect(windowEnd('06:00', 90)).toBe('07:30'); });
  it('sortWeekdaysForDisplay orders Monday-first while leaving STREGA indices untouched', () => {
    expect(sortWeekdaysForDisplay([0, 3, 1])).toEqual([1, 3, 0]);
    expect(sortWeekdaysForDisplay([0, 1, 2, 3, 4, 5, 6])).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(sortWeekdaysForDisplay([6, 0])).toEqual([6, 0]);
    expect(sortWeekdaysForDisplay([])).toEqual([]);
    // Does not mutate the input array.
    const input = [0, 3, 1];
    sortWeekdaysForDisplay(input);
    expect(input).toEqual([0, 3, 1]);
  });
});
