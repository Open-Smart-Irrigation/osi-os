import type {DailyWeatherInput, WeatherSource as SimulatorWeatherSource} from '@osi-demo/model/environment';
import {DAY_MS, WEATHER_START, localDate, localDayStart} from '../time';
import {FORECAST_LOOKAHEAD_DAYS, type WeatherSource} from '../weather';

const FIRST_DATE = localDate(WEATHER_START);

export function createWeatherSource(weather: WeatherSource): SimulatorWeatherSource {
  const actual = new Map<string, DailyWeatherInput | null>();
  const forecasts = new Map<string, DailyWeatherInput | null>();
  let issue: number | undefined;
  return (date, _zone, now) => {
    if (!Number.isFinite(now) || Math.abs(now) >= 8.64e15 - (FORECAST_LOOKAHEAD_DAYS + 1) * DAY_MS) return null;
    const target = Date.parse(date + 'T00:00:00Z');
    const midnight = localDayStart(now);
    const today = localDate(midnight);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(target)
      || new Date(target).toISOString().slice(0, 10) !== date
      || date < FIRST_DATE || date > localDate(midnight + FORECAST_LOOKAHEAD_DAYS * DAY_MS)) return null;
    const isForecast = date >= today;
    if (isForecast) {
      const nextIssue = weather.forecastIssueAt?.(now) ?? now;
      if (issue !== nextIssue) {
        forecasts.clear();
        issue = nextIssue;
      }
    }
    const cache = isForecast ? forecasts : actual;
    if (!cache.has(date)) {
      // WP3 computes FAO-56 from the day's weather. Its forecast changes rain only.
      const day = weather.asOf(date, now);
      cache.set(date, day && Object.freeze({
        et0: day.et0Mm, rain: day.rainMm, maxTemp: day.tMaxC,
        meanRhPct: day.meanRhPct, windSpeedMps: day.windSpeedMs,
        et0Source: 'fao56_daily_game_weather', et0Tier: 'fao56_daily', hourlyRainMm: day.hourlyRainMm,
      }));
    }
    return cache.get(date) ?? null;
  };
}
