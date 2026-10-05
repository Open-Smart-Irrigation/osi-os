import type { Device } from '../types/farming';

type LatestData = Device['latest_data'] | null | undefined;

export function toFiniteSwtValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function canonicalSwtChannels(data: LatestData): [number | null, number | null, number | null] {
  return [
    toFiniteSwtValue(data?.swt_1) ?? toFiniteSwtValue(data?.swt_wm1),
    toFiniteSwtValue(data?.swt_2) ?? toFiniteSwtValue(data?.swt_wm2),
    toFiniteSwtValue(data?.swt_3),
  ];
}

export function collectDeviceSwtValues(devices: Array<Pick<Device, 'latest_data'>>): number[] {
  return devices.flatMap((device) => canonicalSwtChannels(device.latest_data).filter((value): value is number => value != null));
}

export function summarizeSwtValues(values: number[]): { status: SwtWaterStatus | null; swt: number | null } {
  if (!values.length) {
    return { status: null, swt: null };
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const status = classifySwtWaterStatus(mean);
  return { status, swt: status === null ? null : mean };
}

export type SwtUnit = 'kPa' | 'pF';
export type SwtWaterStatus = 'wet' | 'moist' | 'dry';

export function classifySwtWaterStatus(value: unknown): SwtWaterStatus | null {
  const kpa = toFiniteSwtValue(value);
  if (kpa === null || kpa < 0 || kpa > 300) return null;
  if (kpa < 20) return 'wet';
  if (kpa <= 50) return 'moist';
  return 'dry';
}

/** Tension at or below which pF shows its floor of 0 (log10(0.1 * 10) = 0). */
export const PF_FLOOR_KPA = 0.1;

// pF = log10(tension in hPa); 1 kPa = 10 hPa. pF is never shown below 0: a
// finite tension at or below 0.1 kPa (where the formula gives 0, a negative
// or no value, e.g. a saturated probe at 0 kPa) derives the 0 pF floor.
// A missing or non-finite reading stays null (no value).
export function kpaToPf(kpa: unknown): number | null {
  const value = toFiniteSwtValue(kpa);
  if (value === null) return null;
  if (value <= PF_FLOOR_KPA) return 0;
  return Math.log10(value * 10);
}

// Inverse of kpaToPf, exact above the floor. 0 pF maps to the 0.1 kPa floor,
// so an entered 0 pF means "0.1 kPa", the wettest tension pF can tell apart.
// A negative pF is never shown and is rejected.
export function pfToKpa(pf: unknown): number | null {
  const value = toFiniteSwtValue(pf);
  if (value === null || value < 0) return null;
  const result = Math.pow(10, value) / 10;
  return Number.isFinite(result) ? result : null;
}

export function formatSwtValue(kpa: unknown, unit: SwtUnit): string | null {
  const value = toFiniteSwtValue(kpa);
  if (value === null) return null;
  if (unit === 'pF') {
    const pf = kpaToPf(value);
    return pf === null ? null : `${pf.toFixed(2)} pF`;
  }
  return `${value.toFixed(1)} kPa`;
}

// Cards show only readings inside the sensor range (0..300 kPa) in either unit;
// a saturated 0 kPa reading shows the 0 pF floor in pF mode.
export function formatSwtCardValue(kpa: unknown, unit: SwtUnit): string | null {
  if (classifySwtWaterStatus(kpa) === null) return null;
  return formatSwtValue(kpa, unit);
}
