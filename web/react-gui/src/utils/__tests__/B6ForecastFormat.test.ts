import { describe, expect, it } from 'vitest';
import { formatForecastTemperature, formatWeatherValue, isIsolatedForecastProbability } from '../forecastFormat';

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


describe('isolated forecast probability markers', () => {
  it('treats zero as a reading and missing neighbours as gaps', () => {
    expect(isIsolatedForecastProbability([{ prob: null }, { prob: 0 }, { prob: null }], 1)).toBe(true);
    expect(isIsolatedForecastProbability([{ prob: 80 }], 0)).toBe(true);
    expect(isIsolatedForecastProbability([{ prob: undefined }, { prob: 80 }, { prob: NaN }], 1)).toBe(true);
  });
  it('does not mark missing values or readings belonging to a connected run', () => {
    expect(isIsolatedForecastProbability([{ prob: null }], 0)).toBe(false);
    expect(isIsolatedForecastProbability([{ prob: NaN }], 0)).toBe(false);
    expect(isIsolatedForecastProbability([{ prob: 80 }, { prob: 60 }], 0)).toBe(false);
    expect(isIsolatedForecastProbability([{ prob: 80 }, { prob: 60 }], 1)).toBe(false);
  });
});
