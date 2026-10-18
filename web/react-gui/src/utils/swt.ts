import type { Device } from '../types/farming';
import { kpaToPf as toMatricPotentialPf, pfToKpa as toMatricPotentialKpa } from './matricPotential';

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

// Common consumer domain; each device validates its physical range at ingestion.
export const SWT_KPA_RANGE = [0, 1_000_000] as const;

export type SwtUnit = 'kPa' | 'pF';
export type SwtWaterStatus = 'wet' | 'moist' | 'dry';

export function classifySwtWaterStatus(value: unknown): SwtWaterStatus | null {
  const kpa = toFiniteSwtValue(value);
  if (kpa === null || kpa < SWT_KPA_RANGE[0] || kpa > SWT_KPA_RANGE[1]) return null;
  if (kpa < 20) return 'wet';
  if (kpa <= 50) return 'moist';
  return 'dry';
}

export function kpaToPf(kpa: unknown): number | null {
  return toMatricPotentialPf(toFiniteSwtValue(kpa));
}

export function pfToKpa(pf: unknown): number | null {
  return toMatricPotentialKpa(toFiniteSwtValue(pf));
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

/**
 * `formatSwtValue` for a measured value on screen, except that a measured 0 kPa in pF mode
 * shows `0.0 kPa` instead of nothing. pF has no value at zero tension, and a saturated probe
 * must not read as a missing one (owner zero ruling, as the cloud card does).
 */
export function formatMeasuredSwtValue(kpa: unknown, unit: SwtUnit): string | null {
  return formatSwtValue(kpa, unit) ?? (toFiniteSwtValue(kpa) === 0 ? formatSwtValue(0, 'kPa') : null);
}

/** The value a device card shows: `formatMeasuredSwtValue` within the shared canonical SWT domain. */
export function formatSwtCardValue(kpa: unknown, unit: SwtUnit): string | null {
  if (classifySwtWaterStatus(kpa) === null) return null;
  return formatMeasuredSwtValue(kpa, unit);
}
