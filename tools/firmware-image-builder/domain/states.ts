import { StateTransitionError, type BuilderError } from './errors.js';
import {
  ACTIVE_RECOVERY_STATES,
  STATE_TRANSITIONS,
  TERMINAL_STATES,
  isJobState,
  type JobState,
} from './types.js';

export function isActiveRecoveryState(value: unknown): value is (typeof ACTIVE_RECOVERY_STATES)[number] {
  return typeof value === 'string' && (ACTIVE_RECOVERY_STATES as readonly string[]).includes(value);
}

export function isTerminalState(value: unknown): value is (typeof TERMINAL_STATES)[number] {
  return typeof value === 'string' && (TERMINAL_STATES as readonly string[]).includes(value);
}

export function canTransition(from: unknown, to: unknown): boolean {
  if (!isJobState(from) || !isJobState(to)) return false;
  return (STATE_TRANSITIONS[from] as readonly JobState[]).includes(to);
}

export function assertTransition(from: JobState, to: JobState, requestId = 'domain'): void {
  if (!canTransition(from, to)) {
    throw new StateTransitionError(from, to, requestId);
  }
}

export const isAllowedState = isJobState;

export type { BuilderError };
