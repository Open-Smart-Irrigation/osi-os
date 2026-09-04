import type { ValveSummary } from '../../../types/farming';

export type ValveGlyphState = 'closed' | 'pending' | 'open' | 'closing' | 'failed';

export interface ValveGlyph {
  state: ValveGlyphState;
  remainingSeconds: number | null;
  progress: number | null;
  closesAt: string | null;
}

export function deriveValveGlyphState(v: ValveSummary, nowMs: number): ValveGlyph {
  const a = v.activeActuation;
  // A STALE_* reconciliation state is the valve contradicting itself — it reported open,
  // then stopped explaining itself. That is malfunction and earns the red badge.
  //
  // An unacknowledged plan downlink is NOT: the valve is fine, some of the plan just has
  // not landed yet, and the fix is a tap on Resend. Driving the alarm state off it turned
  // one stale bookkeeping row into a headline "Attention" on a healthy valve — which is
  // exactly the kind of false alarm that teaches a farmer to ignore real ones.
  const failed = v.recentStaleState !== null && v.recentStaleState.startsWith('STALE_');
  if (a && a.reconciliationState === 'PENDING_OBSERVATION') {
    return { state: 'pending', remainingSeconds: null, progress: null, closesAt: a.durationSeconds ? a.expectedCloseAt : null };
  }
  if (a && a.reconciliationState === 'OBSERVED_RUNNING') {
    const started = Date.parse(a.commandedAt);
    const closes = Date.parse(a.expectedCloseAt);
    if (!a.durationSeconds) return { state: 'open', remainingSeconds: null, progress: null, closesAt: null };
    const end = started + a.durationSeconds * 1000;
    if (nowMs >= closes) return { state: 'closing', remainingSeconds: 0, progress: 1, closesAt: new Date(end).toISOString() };
    const remaining = Math.max(0, Math.round((end - nowMs) / 1000));
    return {
      state: 'open',
      remainingSeconds: remaining,
      progress: Math.min(1, Math.max(0, (nowMs - started) / (a.durationSeconds * 1000))),
      closesAt: new Date(end).toISOString(),
    };
  }
  if (failed) return { state: 'failed', remainingSeconds: null, progress: null, closesAt: null };
  if (v.currentState === 'OPEN') return { state: 'open', remainingSeconds: null, progress: null, closesAt: null };
  return { state: 'closed', remainingSeconds: null, progress: null, closesAt: null };
}

export function estimateLiters(flowRateLpm: number | null, minutes: number): number | null {
  if (flowRateLpm === null || !Number.isFinite(flowRateLpm) || flowRateLpm <= 0) return null;
  return Math.round((flowRateLpm * minutes) / 10) * 10;
}

export function weekdaysFromMask(mask: number): number[] {
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => (mask >> d) & 1);
}

export function maskFromWeekdays(days: number[]): number {
  return days.reduce((m, d) => m | (1 << d), 0);
}

/**
 * Display order for weekday indices (STREGA `weekdays_mask` bit order: 0=Sunday…6=Saturday).
 * The mask encoding, weekday indices, and `weekdays.N` i18n keys stay 0=Sunday-based — this
 * only reorders how a set of weekday indices is presented on screen (Swiss convention:
 * Monday-first). Never use this for encoding/decoding the STREGA mask.
 */
export const WEEKDAY_DISPLAY_ORDER: ReadonlyArray<number> = [1, 2, 3, 4, 5, 6, 0];

/** Orders a set of weekday indices (0=Sunday…6=Saturday) for Monday-first display only. */
export function sortWeekdaysForDisplay(days: number[]): number[] {
  return [...days].sort((a, b) => WEEKDAY_DISPLAY_ORDER.indexOf(a) - WEEKDAY_DISPLAY_ORDER.indexOf(b));
}

export function windowEnd(startTime: string, minutes: number): string {
  const [h, m] = startTime.split(':').map(Number);
  const end = (h * 60 + m + minutes) % 1440;
  return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
}
