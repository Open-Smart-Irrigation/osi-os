export function getValidBatteryPercent(value: unknown): number | null {
  let numeric: number | null = null;

  if (typeof value === 'number') {
    numeric = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return null;
    }
    numeric = Number(trimmed);
  } else {
    return null;
  }

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
