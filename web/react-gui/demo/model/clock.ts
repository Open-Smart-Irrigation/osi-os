export type ClockEventOptions = {
  id?: string;
  priority?: number;
  meaningful?: boolean;
  entity?: string;
  generation?: number;
};

type ClockEvent = ClockEventOptions & {
  atMs: number;
  sequence: number;
  callback: () => void;
};

const MAX_JUMP_MS = 8 * 24 * 60 * 60 * 1000;

/** One deterministic queue for all simulated domain events. */
export class SimulationClock {
  now: number;
  private sequence = 0;
  private generatedId = 0;
  private events: ClockEvent[] = [];
  private completed = new Set<string>();
  private generations = new Map<string, number>();
  revision = 0;

  constructor(startAtMs: number) { this.now = startAtMs; }

  schedule(atMs: number, callback: () => void, options: ClockEventOptions = {}): string {
    if (!Number.isFinite(atMs) || atMs < this.now) throw new RangeError('Cannot schedule an event before current time');
    const id = options.id ?? `event-${++this.generatedId}`;
    if (this.completed.has(id) || this.events.some(event => event.id === id)) return id;
    this.events.push({atMs, callback, sequence: this.sequence++, priority: 5, ...options, id});
    return id;
  }

  generation(entity: string): number { return this.generations.get(entity) ?? 0; }

  invalidate(entity: string): number {
    const next = this.generation(entity) + 1;
    this.generations.set(entity, next);
    return next;
  }

  cancel(id: string): void {
    this.events = this.events.filter(event => event.id !== id);
  }

  ids(): string[] { return this.events.map(event => event.id!).filter(Boolean); }

  advanceTo(targetMs: number): void {
    if (!Number.isFinite(targetMs)) throw new RangeError('Target time must be finite');
    if (targetMs < this.now) throw new RangeError('Simulation clock cannot move backward');
    for (;;) {
      this.events.sort((a, b) => a.atMs - b.atMs || (a.priority ?? 5) - (b.priority ?? 5) || a.sequence - b.sequence);
      const next = this.events[0];
      if (!next || next.atMs > targetMs) break;
      this.events.shift();
      this.now = next.atMs;
      this.revision++;
      if (next.id) this.completed.add(next.id);
      if (next.entity && next.generation !== undefined && this.generation(next.entity) !== next.generation) continue;
      next.callback();
    }
    this.now = targetMs;
  }

  nextEventAt(maxHorizonMs = MAX_JUMP_MS): number | null {
    const limit = this.now + Math.min(MAX_JUMP_MS, Math.max(0, maxHorizonMs));
    const next = this.events.filter(event => event.meaningful !== false && event.atMs > this.now && event.atMs <= limit &&
      (!event.entity || event.generation === undefined || this.generation(event.entity) === event.generation))
      .sort((a, b) => a.atMs - b.atMs || (a.priority ?? 5) - (b.priority ?? 5) || a.sequence - b.sequence)[0];
    return next?.atMs ?? null;
  }

  reset(startAtMs: number): void {
    this.now = startAtMs;
    this.sequence = 0;
    this.generatedId = 0;
    this.events = [];
    this.completed.clear();
    this.generations.clear();
    this.revision = 0;
  }
}

export {MAX_JUMP_MS};
