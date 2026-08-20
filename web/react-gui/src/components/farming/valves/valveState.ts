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
  const failed = (v.recentStaleState !== null && v.recentStaleState.startsWith('STALE_')) || v.pushState.failed > 0;
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

export function windowEnd(startTime: string, minutes: number): string {
  const [h, m] = startTime.split(':').map(Number);
  const end = (h * 60 + m + minutes) % 1440;
  return `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`;
}
