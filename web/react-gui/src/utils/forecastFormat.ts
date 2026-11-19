export function formatForecastHighLow(
  highC: number | null | undefined,
  lowC: number | null | undefined
): string {
  if (highC == null || lowC == null) return 'Unavailable';
  if (!Number.isFinite(highC) || !Number.isFinite(lowC)) return 'Unavailable';
  return `${Math.round(highC)}°/${Math.round(lowC)}°`;
}

/** Display only: preserve canonical values and measured zeros. */
export function formatWeatherValue(
  value: number | null | undefined, locale: string, decimals: number, unit = '',
): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const number = new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: false,
  }).format(value);
  return unit ? `${number}\u00a0${unit}` : number;
}

export function formatForecastTemperature(value: number | null | undefined, locale: string): string {
  return formatWeatherValue(value, locale, 0, '°C');
}
