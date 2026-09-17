const LSN50_MIN_BATTERY_VOLTAGE = 2.1;
const LSN50_NOMINAL_BATTERY_VOLTAGE = 3.6;

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') {
      return null;
    }
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : null;
  } else {
    return null;
  }
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

export function getValidBatteryPercent(value: unknown): number | null {
  const numeric = parseFiniteNumber(value);

  if (numeric == null || numeric < 0 || numeric > 100) {
    return null;
  }

  return Math.round(numeric);
}

export function getBatteryPercentFromVoltage(value: unknown): number | null {
  const voltage = parseFiniteNumber(value);
  if (voltage == null) {
    return null;
  }

  const usableRange = LSN50_NOMINAL_BATTERY_VOLTAGE - LSN50_MIN_BATTERY_VOLTAGE;
  return clampPercent(((voltage - LSN50_MIN_BATTERY_VOLTAGE) / usableRange) * 100);
}

/**
 * Whether the footer percentage came from the voltage curve rather than from a
 * reported `bat_pct`. The LSN50's LiSOCl2 cell holds ~3.6 V across most of its
 * life and then falls off a cliff, so the derived number reads 100 % until
 * shortly before the sensor goes silent mid-season — and it used to render
 * with the same glyph and format as a real measurement from an S2120 two rows
 * below.
 */
export function isDerivedBatteryPercent(input: { batPct: unknown; batV?: unknown }): boolean {
  return getValidBatteryPercent(input.batPct) == null && getBatteryPercentFromVoltage(input.batV) != null;
}

export function buildDeviceFooterMeta(input: {
  batPct: unknown;
  batV?: unknown;
  lastSeenLabel: string;
}): string {
  const reported = getValidBatteryPercent(input.batPct);
  const batteryPercent = reported ?? getBatteryPercentFromVoltage(input.batV);
  if (batteryPercent == null) return input.lastSeenLabel;
  const approximately = reported == null ? '≈ ' : '';
  return `🔋 ${approximately}${batteryPercent}% · ${input.lastSeenLabel}`;
}
