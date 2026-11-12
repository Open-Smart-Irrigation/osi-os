import { useSyncExternalStore } from 'react';

/*
 * A valve command whose HTTP answer never arrived may still have reached the
 * valve: the gateway can accept it and the answer can be lost on the way back.
 * After a timeout on a command that opens, this module holds every opening
 * command for that valve until a fresh valve reading has arrived or
 * VALVE_OPEN_HOLD_MS has passed, whichever comes first. Close is never held.
 *
 * - Enforced at dispatch: the API functions that send an opening command call
 *   assertValveOpenNotHeld before sending and holdValveOpen on a timeout
 *   (services/api.ts), so every caller is covered; surfaces also disable their
 *   controls and re-check before they call.
 * - A "valve reading" is a successful GET /api/valves that was started after
 *   the hold began (services/valveReading.ts). Ordering uses a request number,
 *   not the clock: each request takes the next number when it starts, a hold
 *   remembers the last number issued, and only a success with a higher number
 *   releases it.
 * - The minute runs on the monotonic clock (performance.now), and a timer ends
 *   the hold and notifies listeners, so a change of the wall clock neither
 *   shortens nor extends it within a page.
 * - The hold is kept in this tab's sessionStorage so a reload does not drop it.
 *   After a reload no monotonic reference survives; the remaining time is taken
 *   from the wall clock and capped at VALVE_OPEN_HOLD_MS, and only a request
 *   started after the reload releases it. Another tab or another device is out
 *   of reach for a client-side hold.
 */

export const VALVE_OPEN_HOLD_MS = 60_000;
const STORAGE_KEY = 'osi.valveOpenHolds.v1';

/** An axios timeout: the request went out and no answer came back. */
export function isNoAnswerTimeout(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { code, response } = error as { code?: unknown; response?: unknown };
  return response == null && (code === 'ECONNABORTED' || code === 'ETIMEDOUT');
}

/** Thrown instead of sending an opening command while the valve is held. */
export class ValveOpenHeldError extends Error {
  readonly code = 'valve_open_held';
  readonly deviceEui: string;
  constructor(deviceEui: string) {
    super('An earlier command that opens this valve got no answer yet');
    this.name = 'ValveOpenHeldError';
    this.deviceEui = deviceEui;
  }
}

export function isValveOpenHeldError(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'valve_open_held';
}

/** No answer, or refused locally because of an earlier one: the outcome on the valve is unknown. */
export function isUnknownValveOutcome(error: unknown): boolean {
  return isNoAnswerTimeout(error) || isValveOpenHeldError(error);
}

interface Hold { deadline: number; afterRequest: number }

const holds = new Map<string, Hold>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
let lastRequest = 0;

const monotonicNow = (): number => performance.now();

function keyOf(deviceEui: string): string {
  return String(deviceEui).trim().toUpperCase();
}

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function storage(): Storage | null {
  try { return typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { return null; }
}

function persist(): void {
  const store = storage();
  if (!store) return;
  const now = monotonicNow();
  const wall = Date.now();
  const saved: Record<string, number> = {};
  for (const [key, hold] of holds) saved[key] = wall + Math.max(0, hold.deadline - now);
  try {
    if (Object.keys(saved).length) store.setItem(STORAGE_KEY, JSON.stringify(saved));
    else store.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn('Could not keep the valve open hold for this tab', error);
  }
}

function release(key: string): void {
  const timer = timers.get(key);
  if (timer !== undefined) clearTimeout(timer);
  timers.delete(key);
  holds.delete(key);
}

function schedule(key: string): void {
  const hold = holds.get(key);
  if (!hold) return;
  const timer = timers.get(key);
  if (timer !== undefined) clearTimeout(timer);
  timers.set(key, setTimeout(() => {
    const current = holds.get(key);
    if (!current) return;
    if (monotonicNow() < current.deadline) { schedule(key); return; }
    release(key);
    persist();
    emit();
  }, Math.max(0, hold.deadline - monotonicNow())));
}

function restore(): void {
  const store = storage();
  if (!store) return;
  let saved: unknown;
  try { saved = JSON.parse(store.getItem(STORAGE_KEY) ?? 'null'); } catch { saved = null; }
  if (!saved || typeof saved !== 'object') return;
  const now = monotonicNow();
  const wall = Date.now();
  for (const [key, wallDeadline] of Object.entries(saved as Record<string, unknown>)) {
    if (typeof wallDeadline !== 'number' || !Number.isFinite(wallDeadline)) continue;
    const remaining = Math.min(VALVE_OPEN_HOLD_MS, wallDeadline - wall);
    if (remaining <= 0) continue;
    holds.set(keyOf(key), { deadline: now + remaining, afterRequest: lastRequest });
    schedule(keyOf(key));
  }
  persist();
}

restore();

/** Starts the hold for a valve whose opening command got no answer. */
export function holdValveOpen(deviceEui: string): void {
  const key = keyOf(deviceEui);
  holds.set(key, { deadline: monotonicNow() + VALVE_OPEN_HOLD_MS, afterRequest: lastRequest });
  schedule(key);
  persist();
  emit();
}

/** True while opening commands for this valve are held. */
export function isValveOpenHeld(deviceEui: string): boolean {
  const hold = holds.get(keyOf(deviceEui));
  return !!hold && monotonicNow() < hold.deadline;
}

/** Throws ValveOpenHeldError instead of letting an opening command go out. */
export function assertValveOpenNotHeld(deviceEui: string): void {
  if (isValveOpenHeld(deviceEui)) throw new ValveOpenHeldError(keyOf(deviceEui));
}

/**
 * A one-time schedule that starts while the hold lasts (due now, or before the hold can end)
 * is an open by another route and is refused like one. A one-time schedule that starts after
 * the hold can end, every weekly schedule, and disabling, deleting or re-sending a schedule
 * are not held: planning ahead is not a second press of Open.
 */
export function assertScheduleStartNotHeld(
  deviceEui: string,
  schedule: { kind?: string; fireAt?: string | null; enabled?: boolean },
): void {
  if (schedule.kind !== 'ONCE' || schedule.enabled === false) return;
  const hold = holds.get(keyOf(deviceEui));
  if (!hold) return;
  const remaining = hold.deadline - monotonicNow();
  if (remaining <= 0) return;
  const startsAt = schedule.fireAt ? Date.parse(schedule.fireAt) : NaN;
  // An unreadable start time is treated as due now: the gateway decides when it fires.
  if (Number.isNaN(startsAt) || startsAt <= Date.now() + remaining) throw new ValveOpenHeldError(keyOf(deviceEui));
}

/** Numbers a valve-list request at its start. */
export function beginValveReading(): number {
  lastRequest += 1;
  return lastRequest;
}

/** A valve-list request numbered `request` succeeded: it releases every hold that began before it started. */
export function completeValveReading(request: number): void {
  let changed = false;
  for (const [key, hold] of [...holds]) {
    if (request > hold.afterRequest) { release(key); changed = true; }
  }
  if (changed) { persist(); emit(); }
}

/** True while opening controls of this valve must stay disabled. */
export function useValveOpenHeld(deviceEui: string): boolean {
  const key = keyOf(deviceEui);
  const snapshot = () => holds.has(key);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Test-only: forget every hold and request number; `reload` re-reads this tab's storage as a page load does. */
export function resetValveCommandHoldsForTest(options: { keepStorage?: boolean; reload?: boolean } = {}): void {
  for (const key of [...holds.keys()]) release(key);
  lastRequest = 0;
  if (!options.keepStorage) storage()?.removeItem(STORAGE_KEY);
  if (options.reload) restore();
  emit();
}
