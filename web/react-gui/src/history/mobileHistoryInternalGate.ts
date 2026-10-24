export function mobileHistoryInternalEnabled(value: unknown): boolean {
  return value === 'true';
}

export const MOBILE_HISTORY_INTERNAL_ENABLED = mobileHistoryInternalEnabled(
  import.meta.env.VITE_MOBILE_HISTORY_INTERNAL,
);

export const MOBILE_HISTORY_INTERNAL_DIAGNOSTICS_ENABLED = mobileHistoryInternalEnabled(
  import.meta.env.VITE_MOBILE_HISTORY_INTERNAL_DIAGNOSTICS,
);
