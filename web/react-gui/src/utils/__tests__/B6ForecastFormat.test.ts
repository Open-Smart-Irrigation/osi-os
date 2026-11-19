import { describe, expect, it } from 'vitest';
import { formatForecastTemperature, formatWeatherValue } from '../forecastFormat';

describe('B6 display-only weather formatting', () => {
  it.each(['fr', 'it', 'es', 'pt'])('uses %s decimal separators without rounding the source', locale => {
    const value = 12.3456789;
    expect(formatWeatherValue(value, locale, 1, 'mm')).toBe('12,3\u00a0mm');
    expect(value).toBe(12.3456789);
  });
  it('preserves zeros and distinguishes unavailable readings', () => {
    expect(formatWeatherValue(0, 'fr', 1, 'mm')).toBe('0,0\u00a0mm');
    for (const value of [null, undefined, NaN, Infinity]) {
      expect(formatWeatherValue(value, 'en', 1, 'mm')).toBe('—');
    }
    expect(formatForecastTemperature(0, 'en')).toBe('0\u00a0°C');
    expect(formatForecastTemperature(null, 'en')).toBe('—');
  });
});
