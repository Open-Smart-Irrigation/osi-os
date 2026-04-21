export function getValidBatteryPercent(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 100) {
    return null;
  }

  return Math.round(numeric);
}

export function buildDeviceFooterMeta(input: {
  batPct: unknown;
  lastSeenLabel: string;
}): string {
  const batteryPercent = getValidBatteryPercent(input.batPct);
  return batteryPercent == null
    ? input.lastSeenLabel
    : `🔋 ${batteryPercent}% · ${input.lastSeenLabel}`;
}
