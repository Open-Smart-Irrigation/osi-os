import type { JobState } from '../types.js';

const TONES: Readonly<Record<JobState, 'neutral' | 'active' | 'success' | 'warning' | 'danger'>> = {
  queued: 'neutral',
  starting: 'active',
  preflight: 'active',
  source: 'active',
  release_gates: 'active',
  frontend: 'active',
  target_setup: 'active',
  feeds: 'active',
  config: 'active',
  building: 'active',
  verifying: 'active',
  publishing: 'warning',
  cancel_requested: 'warning',
  succeeded: 'success',
  failed: 'danger',
  cancelled: 'neutral',
  interrupted: 'warning',
};

function label(state: JobState): string {
  return state.replaceAll('_', ' ');
}

export interface StatusBadgeProps {
  readonly state: JobState;
}

export function StatusBadge({ state }: StatusBadgeProps) {
  return (
    <span className={`status-badge status-badge--${TONES[state]}`}>
      <span className="status-badge__dot" aria-hidden="true" />
      {label(state)}
    </span>
  );
}
