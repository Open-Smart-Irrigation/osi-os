export function formatForecastHighLow(
  highC: number | null | undefined,
  lowC: number | null | undefined
): string {
  if (!Number.isFinite(highC) || !Number.isFinite(lowC)) return 'Unavailable';
  return `${Math.round(highC)}°/${Math.round(lowC)}°`;
}
