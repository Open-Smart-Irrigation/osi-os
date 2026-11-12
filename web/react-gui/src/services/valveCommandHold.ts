import { useEffect, useState, useSyncExternalStore } from 'react';
import { valvesAPI } from './api';
import type { ValveSummary } from '../types/farming';

/*
 * A valve command whose HTTP answer never arrived may still have reached the
 * valve: the gateway can accept it and the answer can be lost on the way back.
 * After such a timeout the GUI says so instead of "could not send", and it
 * holds the open control of that valve until a fresh valve reading has
 * arrived or VALVE_OPEN_HOLD_MS has passed, whichever comes first, so a second
 * press cannot send a second open unseen. Close is never held: closing twice
 * does no harm, and the operator must always be able to close.
 *
 * A "valve reading" is a successful GET /api/valves whose request started
 * after the hold began, so it shows the gateway's state after the lost answer.
 * The hold is shared by every valve surface (panel tile, zone card).
 */

export const VALVE_OPEN_HOLD_MS = 60_000;

/** An axios timeout: the request went out and no answer came back. */
export function isNoAnswerTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, response } = error as { code?: unknown; response?: unknown };
  return response == null && (code === 'ECONNABORTED' || code === 'ETIMEDOUT');
}

const holds = new Map<string, number>();
let lastReadingStartedAt: number | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function keyOf(deviceEui: string): string {
  return String(deviceEui).trim().toUpperCase();
}

/** Starts the open hold for a valve whose open command got no answer. */
export function holdValveOpen(deviceEui: string, nowMs: number = Date.now()): void {
  holds.set(keyOf(deviceEui), nowMs);
  emit();
}

/** Records a successful valve reading whose request started at startedAtMs. */
export function noteValveReading(startedAtMs: number): void {
  if (lastReadingStartedAt === null || startedAtMs > lastReadingStartedAt) lastReadingStartedAt = startedAtMs;
  emit();
}

/** When the open hold on this valve ends, or null when it is not held. */
export function valveOpenHeldUntil(deviceEui: string, nowMs: number = Date.now()): number | null {
  const since = holds.get(keyOf(deviceEui));
  if (since === undefined) return null;
  const until = since + VALVE_OPEN_HOLD_MS;
  // >= : a reading requested in the same millisecond was requested after the hold began.
  const readingSince = lastReadingStartedAt !== null && lastReadingStartedAt >= since;
  return nowMs >= until || readingSince ? null : until;
}

/** The GET /api/valves fetcher every valve surface uses; each success is a valve reading. */
export async function fetchValveReading(): Promise<ValveSummary[]> {
  const startedAt = Date.now();
  const valves = await valvesAPI.list();
  noteValveReading(startedAt);
  return valves;
}

/** Test-only: forget every hold and reading. */
export function resetValveCommandHolds(): void {
  holds.clear();
  lastReadingStartedAt = null;
  emit();
}

/** True while the open control of this valve is held. */
export function useValveOpenHeld(deviceEui: string): boolean {
  const [nowMs, setNowMs] = useState(() => Date.now());
  // nowMs moves only by the timer below, so the snapshot stays stable between renders.
  const snapshot = () => valveOpenHeldUntil(deviceEui, nowMs);
  const until = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    if (until === null) return undefined;
    const id = setTimeout(() => setNowMs(Date.now()), Math.max(0, until - Date.now()));
    return () => clearTimeout(id);
  }, [until]);
  return until !== null;
}
