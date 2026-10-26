function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Converts a finite matric potential in kPa to pF (log10 of its magnitude in hPa). */
export function kpaToPf(kpa: unknown): number | null {
  if (!finiteNumber(kpa) || kpa === 0) return null;
  const pf = Math.log10(Math.abs(kpa)) + 1;
  return Number.isFinite(pf) ? pf : null;
}

/** Converts a finite pF value to a positive finite matric potential in kPa. */
export function pfToKpa(pf: unknown): number | null {
  if (!finiteNumber(pf)) return null;
  const kpa = Math.pow(10, pf - 1);
  return Number.isFinite(kpa) && kpa > 0 ? kpa : null;
}
