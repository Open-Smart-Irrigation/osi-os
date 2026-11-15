import { valvesAPI } from './api';
import { activeRunExpectationId } from './valveCancel';

/**
 * The run a valve cancel names (V9): the activeActuation of this valve's row in a fresh read of
 * GET /api/valves, the gateway's cancellable-only pass (listValvesForUser). Never the device list's
 * newest active record, which that pass does not filter (a newer CLOSE owner can sit above a queued
 * open, review B1), and never a cached row, which can name a run that has already ended (review
 * B2). No row, no run or a failed read names no run, as before V9. Kept apart from valveCancel.ts,
 * which api.ts imports.
 */
export async function freshCancellableRunId(deveui: string): Promise<string | null> {
  try {
    const eui = deveui.toUpperCase();
    const row = (await valvesAPI.list()).find((valve) => valve.deviceEui.toUpperCase() === eui);
    return activeRunExpectationId(row?.activeActuation);
  } catch (e) {
    console.warn('valve cancel: valve list unreadable, cancelling without naming a run: ' + (e instanceof Error ? e.message : String(e)));
    return null;
  }
}
