import React from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
} from 'recharts';
import type { ForecastEnvironment, DailyForecast, HourlyForecast, RainFocus } from '../../../types/farming';
import { formatForecastTemperature, formatWeatherValue, isIsolatedForecastProbability } from '../../../utils/forecastFormat';
import { WeatherIcon } from './WeatherIcon';
import { parseCalendarDay, useDateFormat, type DateFormatter } from '../../../utils/datetime';

interface Props {
  forecast: ForecastEnvironment;
  location: { source: string };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type Translate = TFunction<'devices'>;

function isSameCalendarDay(date: Date, offsetDays: number): boolean {
  const other = new Date();
  other.setDate(other.getDate() + offsetDays);
  return date.toDateString() === other.toDateString();
}

function fmtDay(dateStr: string, fmt: DateFormatter, t: Translate): string {
  const d = parseCalendarDay(dateStr);
  if (d === null) return '\u2014';
  if (isSameCalendarDay(d, 0)) return t('environment.forecast.dayToday', { defaultValue: 'Today' });
  if (isSameCalendarDay(d, 1)) return t('environment.forecast.dayTomorrow', { defaultValue: 'Tomorrow' });
  return fmt.weekday(d) ?? '\u2014';
}

function fmtHour(isoStr: string, fmt: DateFormatter): string {
  return fmt.time(isoStr) ?? '\u2014';
}

function fmtEta(isoStr: string | null, fmt: DateFormatter, t: Translate): string {
  const time = fmt.time(isoStr);
  if (isoStr === null || time === null) return '\u2014';
  const d = new Date(isoStr);
  if (isSameCalendarDay(d, 0)) return t('environment.forecast.etaToday', { time, defaultValue: '{{time}} today' });
  if (isSameCalendarDay(d, 1)) return t('environment.forecast.etaTomorrow', { time, defaultValue: '{{time}} tomorrow' });
  return fmt.weekday(d, { hour: '2-digit', minute: '2-digit' }) ?? time;
}

// ── Rain summary pills ────────────────────────────────────────────────────────

interface RainPillProps { label: string; value: string; highlight?: boolean; sub?: string | null }

const RainPill: React.FC<RainPillProps> = ({ label, value, highlight, sub }) => (
  <div className={`flex min-h-[44px] flex-col items-center justify-center rounded-xl px-3 py-2 border ${highlight
    ? 'bg-[var(--info-bg)] border-[var(--info-border)] text-[var(--info-text)]'
    : 'bg-[var(--card)] border-[var(--border)]'}`}>
    <span className={`text-[10px] uppercase tracking-widest font-semibold mb-0.5 ${highlight ? 'text-[var(--info-text)]' : 'text-[var(--text-secondary)]'}`}>{label}</span>
    <span className={`text-sm font-bold tabular-nums ${highlight ? 'text-[var(--info-text)]' : 'text-[var(--text)]'}`}>
      {value}
    </span>
    {sub && <span className={`text-[10px] tabular-nums ${highlight ? 'text-[var(--info-text)]' : 'text-[var(--text-secondary)]'}`}>{sub}</span>}
  </div>
);

// A forecast total is null when no hour of its horizon carries a rain value:
// unknown, so a dash rather than 0.0 mm. A partly covered 24 h total says how
// many hours it covers.
function formatRainTotal(mm: number | null | undefined, locale: string): string {
  return formatWeatherValue(mm, locale, 1, 'mm');
}

function coverageLabel(rf: RainFocus, t: Translate): string | null {
  const coverage = rf.next24hCoverage;
  if (!coverage || coverage.coveredHours >= coverage.expectedHours) return null;
  return t('environment.forecast.coverage', {
    covered: coverage.coveredHours,
    expected: coverage.expectedHours,
    defaultValue: '{{covered}} of {{expected}} h',
  });
}

// ── Daily strip ───────────────────────────────────────────────────────────────

const DayCard: React.FC<{ day: DailyForecast; isToday: boolean }> = ({ day, isToday }) => {
  const { t, i18n } = useTranslation('devices');
  const fmt = useDateFormat();
  const rain = day.rainMm;
  const hasTemperature = [day.maxTempC, day.minTempC].some(value => value != null && Number.isFinite(value));
  const temperature = hasTemperature
    ? `${formatForecastTemperature(day.maxTempC, i18n.language)} / ${formatForecastTemperature(day.minTempC, i18n.language)}`
    : t('environment.forecast.unavailable', { defaultValue: 'Unavailable' });
  return (
    <div className={`snap-start flex-shrink-0 w-36 flex flex-col items-center gap-1 rounded-xl p-2 border
      ${isToday
        ? 'bg-[var(--secondary-bg)] border-[var(--primary)]'
        : 'bg-[var(--card)] border-[var(--border)]'}`}>
      <span className="text-xs font-semibold text-[var(--text-secondary)]">{fmtDay(day.date, fmt, t)}</span>
      <WeatherIcon code={day.weatherCode} description={day.description} size={40} animated={!isToday} />
      <span className="min-h-[16px] text-xs font-medium tabular-nums text-[var(--text)] whitespace-nowrap">
        {temperature}
      </span>
      {rain != null && Number.isFinite(rain) && (
        <span className="text-[10px] font-semibold rounded-full px-1.5 py-0.5 border bg-[var(--info-bg)] text-[var(--info-text)] border-[var(--info-border)]">
          {formatWeatherValue(rain, i18n.language, 1, 'mm')}
        </span>
      )}
      {day.rainProbabilityPct != null && Number.isFinite(day.rainProbabilityPct) && (
        <span className="text-[10px] text-[var(--text-secondary)]">
          {formatWeatherValue(day.rainProbabilityPct, i18n.language, 0, '%')}
        </span>
      )}
    </div>
  );
};

// ── Hourly chart ──────────────────────────────────────────────────────────────

interface ChartPoint { hour: string; rain: number | null; prob: number | null }

const HourlyChart: React.FC<{ hourly: HourlyForecast[] }> = ({ hourly }) => {
  const { t, i18n } = useTranslation('devices');
  const fmt = useDateFormat();
  if (hourly.length === 0) return null;

  // Next 24 h only
  const cutoff = Date.now() + 24 * 60 * 60 * 1000;
  const points: ChartPoint[] = hourly
    .filter(h => new Date(h.time).getTime() <= cutoff)
    .map(h => ({
      hour: fmtHour(h.time, fmt),
      rain: h.rainMm,
      prob: h.rainProbabilityPct,
    }));

  if (points.length === 0) return null;

  const maxRain = Math.max(...points.map(p => p.rain ?? 0), 1);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-bold uppercase tracking-widest text-[var(--text-tertiary)]">
        {t('environment.forecast.hourlyTitle', { defaultValue: 'Hourly rain (next 24 h)' })}
      </p>
      <ResponsiveContainer width="100%" height={130}>
        <ComposedChart data={points} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="hour"
            tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }}
            interval="preserveStartEnd"
            minTickGap={24}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            yAxisId="rain"
            domain={[0, maxRain * 1.2]}
            tick={{ fontSize: 10, fill: 'var(--text-secondary)' }}
            tickLine={false}
            axisLine={false}
            unit={'\u00a0mm'}
            width={62}
            tickFormatter={v => new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 6, useGrouping: false }).format(v)}
          />
          <YAxis
            yAxisId="prob"
            orientation="right"
            domain={[0, 100]}
            tick={{ fontSize: 10, fill: 'var(--text-secondary)' }}
            tickLine={false}
            axisLine={false}
            width={54}
            tickFormatter={v => formatWeatherValue(v, i18n.language, 0, '%')}
          />
          <Tooltip
            contentStyle={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 11,
              color: 'var(--text)',
            }}
            formatter={(val: number, name: string) =>
              name === 'rain'
                ? [formatWeatherValue(val, i18n.language, 1, 'mm'), t('environment.forecast.rain', { defaultValue: 'Rain' })]
                : [formatWeatherValue(val, i18n.language, 0, '%'), t('environment.forecast.probability', { defaultValue: 'Probability' })]}
          />
          <Bar yAxisId="rain" dataKey="rain" fill="var(--primary)" radius={[3,3,0,0]} />
          <Line
            yAxisId="prob"
            type="monotone"
            dataKey="prob"
            stroke="var(--text-secondary)"
            strokeWidth={1.5}
            connectNulls={false}
            dot={({ cx, cy, index }: { cx?: number; cy?: number; index?: number }) => (
              index != null && cx != null && cy != null && isIsolatedForecastProbability(points, index)
                ? <circle key={`probability-${index}`} cx={cx} cy={cy} r={3} fill="var(--text-secondary)" />
                : <g key={`probability-${index}`} />
            )}
            strokeDasharray="4 2"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

// ── Main ──────────────────────────────────────────────────────────────────────

export const ForecastTab: React.FC<Props> = ({ forecast, location }) => {
  const { t, i18n } = useTranslation('devices');
  const fmt = useDateFormat();

  if (!forecast.available || !forecast.rainFocus) {
    const msg = location.source === 'unavailable'
      ? t('environment.forecast.noLocation', { defaultValue: 'Set zone coordinates to enable forecast' })
      : t('environment.forecast.noData', { defaultValue: 'No forecast available' });
    return (
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-4 py-5 text-sm text-[var(--text-secondary)] text-center">
        {msg}
      </div>
    );
  }

  const rf = forecast.rainFocus;
  const todayStr = new Date().toDateString();

  return (
    <div className="flex flex-col gap-4">
      {/* Rain summary pills */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <RainPill
          label={t('environment.forecast.next24h', { defaultValue: 'Next 24 h' })}
          value={formatRainTotal(rf.totalNext24hMm, i18n.language)}
          highlight={(rf.totalNext24hMm ?? 0) > 0}
          sub={coverageLabel(rf, t)}
        />
        <RainPill
          label={t('environment.forecast.next72h', { defaultValue: 'Next 72 h' })}
          value={formatRainTotal(rf.totalNext72hMm, i18n.language)}
          highlight={(rf.totalNext72hMm ?? 0) > 0}
        />
        <RainPill
          label={t('environment.forecast.nextRain', { defaultValue: 'Next rain' })}
          value={fmtEta(rf.nextRainEta, fmt, t)}
          highlight={rf.nextRainEta != null}
        />
        <RainPill
          label={t('environment.forecast.rainHours', { defaultValue: 'Rain hours' })}
          value={formatWeatherValue(rf.rainHoursNext24h, i18n.language, 0, 'h')}
          highlight={rf.rainHoursNext24h > 0}
        />
      </div>

      {/* Daily strip */}
      {rf.daily.length > 0 && (
        <div className="flex snap-x snap-mandatory gap-2 overflow-x-auto pb-1 -mx-1 px-1">
          {rf.daily.map(day => (
            <DayCard
              key={day.date}
              day={day}
              isToday={parseCalendarDay(day.date)?.toDateString() === todayStr}
            />
          ))}
        </div>
      )}

      {/* Hourly chart */}
      <HourlyChart hourly={rf.hourly} />
    </div>
  );
};
