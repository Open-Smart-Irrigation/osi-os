export function formatForecastHighLow(
  highC: number | null | undefined,
  lowC: number | null | undefined
): string {
  if (highC == null || lowC == null) return 'Unavailable';
  if (!Number.isFinite(highC) || !Number.isFinite(lowC)) return 'Unavailable';
  return `${Math.round(highC)}°/${Math.round(lowC)}°`;
}
