import {extraterrestrialRadiation, fao56Et0} from '@osi-edge/osi-agronomy-daily/et0.js';
import {gamma, lognormal, namedStream, normal, uniformInt} from './rng';
import {
  DAY_MS, FARM_SITE, HOUR_MS, WEATHER_START, dayOfYear, localDate,
  localDateStart, localDayStart, localMonth, nextLocalMidnight,
} from './time';
import {hundredths, round2} from './units';

// Table A rows: p01, p11, gamma scale, Tmax, Tmin, RH, wind at 2 m, solar radiation.
const MONTHLY = [
  [.129, .329, 10.67, 29.3, 15.6, 64, 1.54, 23.3],
  [.086, .286, 12.89, 30.6, 16.2, 60, 1.62, 24.2],
  [.168, .518, 10.67, 30.2, 16.8, 65, 1.64, 23.4],
  [.152, .502, 19.24, 28.5, 16.4, 73, 1.62, 20.9],
  [.105, .455, 16.00, 27.3, 15.1, 74, 1.51, 19.0],
  [.053, .253, 10.00, 26.9, 13.8, 69, 1.47, 16.3],
  [.026, .226, 14.67, 27.1, 13.2, 64, 1.73, 15.8],
  [.052, .252, 9.33, 27.7, 13.5, 63, 2.20, 17.0],
  [.080, .280, 6.22, 29.3, 14.2, 60, 2.48, 21.0],
  [.084, .434, 17.00, 29.6, 15.2, 63, 2.32, 21.9],
  [.217, .567, 12.80, 28.1, 16.0, 73, 1.87, 20.6],
  [.168, .518, 13.00, 28.0, 15.9, 72, 1.63, 21.6],
] as const;

export interface RainBurst {
  readonly startsAt: number;
  readonly endsAt: number;
}

export interface WeatherDay {
  readonly date: string;
  readonly startsAt: number;
  readonly wet: boolean;
  readonly rainMm: number;
  readonly burst: RainBurst | null;
  readonly hourlyRainMm: readonly number[];
  readonly tMinC: number;
  readonly tMaxC: number;
  readonly meanRhPct: number;
  readonly windSpeedMs: number;
  readonly solarRadMjM2: number;
  readonly et0Mm: number;
}

export const FORECAST_LOOKAHEAD_DAYS = 3;

export interface WeatherSource {
  actual(at: number): WeatherDay;
  asOf(date: string, now: number): WeatherDay | null;
  /** Equal issue times guarantee the same forecast for a given date. Defaults to the read instant. */
  forecastIssueAt?(now: number): number;
}

function rainDay(startsAt: number, rainMm: number, startHour: number, duration: number) {
  const amount = hundredths(rainMm);
  const wet = amount > 0;
  const burst = wet ? Object.freeze({
    startsAt: startsAt + startHour * HOUR_MS,
    endsAt: startsAt + (startHour + duration) * HOUR_MS,
  }) : null;
  const hourlyRainMm = Object.freeze(Array.from({length: 24}, (_, hour) => {
    if (!wet || hour < startHour || hour >= startHour + duration) return 0;
    const elapsed = hour - startHour;
    return (Math.round(amount * (elapsed + 1) / duration) - Math.round(amount * elapsed / duration)) / 100;
  }));
  return {wet, rainMm: amount / 100, burst, hourlyRainMm};
}

export class Weather implements WeatherSource {
  private readonly draw;
  private readonly days: WeatherDay[] = [];
  private readonly forecasts = new Map<string, WeatherDay>();
  private regimeStart = -Infinity;
  private regimeMultiplier = 1;

  constructor(private readonly seed: number, private readonly start = WEATHER_START) {
    if (localDayStart(start) !== start) throw new RangeError('Weather must start at local midnight');
    this.draw = namedStream(seed, 'weather');
  }

  actual(at: number): WeatherDay {
    const index = Math.floor((at - this.start) / DAY_MS);
    if (index < 0 || !Number.isFinite(index)) throw new RangeError('Day outside weather generator');
    while (this.days.length <= index) this.generate();
    return this.days[index];
  }

  forecastIssueAt(now: number): number { return localDayStart(now); }

  asOf(date: string, now: number): WeatherDay | null {
    const issue = this.forecastIssueAt(now);
    const target = localDateStart(date);
    const lead = (target - issue) / DAY_MS;
    if (target < this.start || lead > FORECAST_LOOKAHEAD_DAYS) return null;
    if (lead < 0) return this.actual(target);

    const key = localDate(issue) + '/' + date;
    const cached = this.forecasts.get(key);
    if (cached) return cached;

    const actual = this.actual(target);
    const draw = namedStream(this.seed, 'forecast', localDate(issue), date);
    const wet = (draw() < .1 + .1 * lead) !== actual.wet;
    let amount = 0;
    let startHour = 1;
    let duration = 1;
    if (wet && actual.burst) {
      amount = Math.max(.01, actual.rainMm * lognormal(draw, .3 + .15 * lead));
      const shift = uniformInt(draw, -lead - 1, lead + 1);
      startHour = Math.max(1, Math.min(19, (actual.burst.startsAt - target) / HOUR_MS + shift));
      duration = (actual.burst.endsAt - actual.burst.startsAt) / HOUR_MS;
    } else if (wet) {
      amount = Math.max(.3, gamma(draw, .75, MONTHLY[localMonth(target) - 1][2]));
      startHour = uniformInt(draw, 1, 19);
      duration = uniformInt(draw, 1, 3);
    }
    const forecast = Object.freeze({...actual, ...rainDay(target, amount, startHour, duration)});
    this.forecasts.set(key, forecast);
    return forecast;
  }

  private generate(): void {
    const startsAt = this.start + this.days.length * DAY_MS;
    const date = localDate(startsAt);
    const month = localMonth(startsAt);
    const [p01, p11, scale, tMax, tMin, rh, wind, solar] = MONTHLY[month - 1];
    const regimeMonth = month >= 10 ? 10 : month >= 3 && month <= 5 ? 3 : null;
    let regime = 1;
    if (regimeMonth !== null) {
      const regimeDate = localDateStart(date.slice(0, 4) + (regimeMonth === 3 ? '-03-01' : '-10-01'));
      if (this.regimeStart !== regimeDate) {
        this.regimeStart = regimeDate;
        this.regimeMultiplier = Math.sqrt(lognormal(this.draw, .3));
      }
      regime = this.regimeMultiplier;
    }
    const yesterdayWet = this.days[this.days.length - 1]?.wet ?? false;
    const wet = this.draw() < (yesterdayWet ? p11 : p01) * regime;
    const amount = wet ? Math.max(.3, gamma(this.draw, .75, scale) * regime) : 0;
    const startHour = wet ? uniformInt(this.draw, 1, 19) : 1;
    const duration = wet ? uniformInt(this.draw, 1, 3) : 1;
    const tMinC = round2(tMin + 1.2 * normal(this.draw) + (wet ? .5 : 0));
    const tMaxC = Math.max(tMinC, round2(tMax + 1.5 * normal(this.draw) - (wet ? 2 : 0)));
    const meanRhPct = Math.max(15, Math.min(98, rh + (wet ? 10 : -3)));
    const windSpeedMs = round2(wind * lognormal(this.draw, .25));
    const yearDay = dayOfYear(startsAt);
    const rso = (.75 + 2e-5 * FARM_SITE.elevationM) * extraterrestrialRadiation(FARM_SITE.latDeg, yearDay);
    const solarRadMjM2 = round2(Math.max(.3 * rso, Math.min(.95 * rso, solar * (wet ? .70 : 1.07))));
    const et0Mm = fao56Et0({
      ...FARM_SITE, dayOfYear: yearDay, tMinC, tMaxC, meanRhPct, windSpeedMs, windHeightM: 2, solarRadMjM2,
    });
    if (et0Mm === null) throw new Error('Generated weather cannot produce ET0');
    this.days.push(Object.freeze({
      date, startsAt, ...rainDay(startsAt, amount, startHour, duration),
      tMinC, tMaxC, meanRhPct, windSpeedMs, solarRadMjM2, et0Mm,
    }));
  }
}

export function rainRateMmPerHour(day: WeatherDay, at: number): number {
  const {burst} = day;
  if (!burst || at < burst.startsAt || at >= burst.endsAt) return 0;
  return day.rainMm * HOUR_MS / (burst.endsAt - burst.startsAt);
}

export function rainInDay(day: WeatherDay, from: number, to: number): number {
  const {burst} = day;
  if (!burst) return 0;
  const overlap = Math.max(0, Math.min(to, burst.endsAt) - Math.max(from, burst.startsAt));
  return day.rainMm * overlap / (burst.endsAt - burst.startsAt);
}

export function rainBetween(weather: WeatherSource, from: number, to: number): number {
  let rain = 0;
  for (let at = from; at < to; at = nextLocalMidnight(at)) rain += rainInDay(weather.actual(at), at, to);
  return round2(rain);
}
