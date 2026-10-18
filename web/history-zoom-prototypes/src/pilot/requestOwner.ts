import { PilotAuthError } from './types';
import type { PilotRequestOwner, PilotRunResult } from './types';

function defaultToken(): string | null {
  try { return typeof window === 'undefined' ? null : window.localStorage.getItem('auth_token'); } catch { return null; }
}
export function createRequestOwner(readToken: () => string | null = defaultToken): PilotRequestOwner {
  let epoch = 0;
  let generation = 0;
  let active: { generation: number; controller: AbortController } | null = null;
  let destroyed = false;
  let lastObservedToken = readToken();
  const observeToken = (token: string | null): void => {
    if (token !== lastObservedToken) { lastObservedToken = token; epoch += 1; }
  };
  const abortActive = (): void => {
    if (active) { active.controller.abort(); active = null; generation += 1; }
  };
  return {
    get sessionEpoch() { return epoch; },
    async run<T>({ load, apply }: { load(signal: AbortSignal, token: string): Promise<T>; apply(value: T): void }): Promise<PilotRunResult> {
      if (destroyed) return 'cancelled';
      const token = readToken();
      observeToken(token);
      if (!token) { abortActive(); return 'auth-required'; }
      abortActive();
      const ownGeneration = ++generation;
      const controller = new AbortController();
      active = { generation: ownGeneration, controller };
      try {
        const value = await load(controller.signal, token);
        const settledToken = readToken();
        observeToken(settledToken);
        const stillCurrent = !destroyed && active?.generation === ownGeneration && settledToken === token;
        if (!stillCurrent) {
          return destroyed ? 'cancelled' : 'superseded';
        }
        apply(value);
        return 'applied';
      } catch (error) {
        const settledToken = readToken();
        observeToken(settledToken);
        const stillCurrent = !destroyed && active?.generation === ownGeneration && settledToken === token;
        if (!stillCurrent) {
          return destroyed ? 'cancelled' : 'superseded';
        }
        if (error instanceof PilotAuthError) return 'auth-required';
        throw error;
      } finally {
        if (active?.generation === ownGeneration) active = null;
      }
    },
    cancel() {
      if (!active) return false;
      abortActive(); return true;
    },
    destroy() { if (!destroyed) { destroyed = true; abortActive(); } },
  };
}
