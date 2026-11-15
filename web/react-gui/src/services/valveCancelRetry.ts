import { devicesAPI, valvesAPI } from './api';
import { activeRunExpectationId, type ValveCancelResult } from './valveCancel';

// V9 (v0.8.2): a valve cancel goes out unnamed at once, as before. With several opens active the
// gateway refuses it as 409 ambiguous_actuation before it changes anything (osi-valve-control/
// cancel.js resolveTarget and onlyQueuedOpen only read). Only then is GET /api/valves read fresh
// and the cancel sent once more, naming this valve's activeActuation from that read (the
// gateway's cancellable-only pass, listValvesForUser). A failed read, no row or no run rethrows
// the original refusal; a refused retry is the caller's reply like any other. Kept apart from
// valveCancel.ts, which api.ts imports.

function isAmbiguousRefusal(error: unknown): boolean {
  const response = (error as { response?: { status?: unknown; data?: unknown } } | null)?.response;
  const data = response?.data;
  return response?.status === 409 && !!data && typeof data === 'object'
    && (data as Record<string, unknown>).error === 'ambiguous_actuation';
}

async function freshRunId(deveui: string): Promise<string | null> {
  try {
    const eui = deveui.toUpperCase();
    const row = (await valvesAPI.list()).find((valve) => valve.deviceEui.toUpperCase() === eui);
    return activeRunExpectationId(row?.activeActuation);
  } catch (e) {
    console.warn('valve cancel: valve list unreadable after an ambiguous refusal: ' + (e instanceof Error ? e.message : String(e)));
    return null;
  }
}

export async function cancelIrrigationWithAmbiguityRetry(deveui: string): Promise<ValveCancelResult | null> {
  try {
    return await devicesAPI.cancelIrrigation(deveui);
  } catch (error) {
    if (!isAmbiguousRefusal(error)) throw error;
    const expectationId = await freshRunId(deveui);
    if (!expectationId) throw error;
    return devicesAPI.cancelIrrigation(deveui, { expectationId });
  }
}
