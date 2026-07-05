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

export function summarizeSwtValues(values: number[]): { label: string; swt: number | null } {
  if (!values.length) {
    return { label: 'No soil sensor reading', swt: null };
  }

  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean < 20) return { label: 'Wet', swt: mean };
  if (mean < 60) return { label: 'Moderate', swt: mean };
  return { label: 'Dry', swt: mean };
}

export type SwtUnit = 'kPa' | 'pF';

// pF = log10(tension in hPa); 1 kPa = 10 hPa. Non-positive tension has no pF.
export function kpaToPf(kpa: unknown): number | null {
  const value = toFiniteSwtValue(kpa);
  if (value === null || value <= 0) return null;
  return Math.log10(value * 10);
}

export function pfToKpa(pf: unknown): number | null {
  const value = toFiniteSwtValue(pf);
  if (value === null) return null;
  return Math.pow(10, value) / 10;
}

export function formatSwtValue(kpa: unknown, unit: SwtUnit): string | null {
  const value = toFiniteSwtValue(kpa);
  if (value === null) return null;
  if (unit === 'pF') {
    const pf = kpaToPf(value);
    return pf === null ? 'saturated' : `${pf.toFixed(2)} pF`;
  }
  return `${value.toFixed(1)} kPa`;
}
