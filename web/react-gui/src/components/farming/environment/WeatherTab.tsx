import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ComposedChart, Bar, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
} from 'recharts';
import type { OnlineEnvironment, ForecastEnvironment, DailyForecast, HourlyForecast, EnvironmentLocation } from '../../../types/farming';
import { toCompassDirection } from '../../../utils/wind';
import { WeatherIcon } from './WeatherIcon';

interface Props {
  online: OnlineEnvironment;
  forecast: ForecastEnvironment;
  location: EnvironmentLocation;
}

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function fmtDay(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00');
  const today    = new Date();
  const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString())    return 'Today';
  if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow';
  return d.toLocaleDateString([], { weekday: 'short' });
}

function fmtHour(isoStr: string): string {
  return new Date(isoStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtEta(isoStr: string | null): string {
  if (!isoStr) return 'â€”';
  const d = new Date(isoStr);
  const today    = new Date();
  const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString())    return `${time} today`;
  if (d.toDateString() === tomorrow.toDateString()) return `${time} tomorrow`;
  return d.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

function rainClass(mm: number): string {
  if (mm < 2)  return 'bg-sky-50 text-sky-700 border-sky-200';
  if (mm < 10) return 'bg-blue-100 text-blue-800 border-blue-300';
  return              'bg-blue-200 text-blue-900 border-blue-400';
}

// â”€â”€ Current conditions bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const CurrentConditions: React.FC<{ online: OnlineEnvironment }> = ({ online }) => {
  if (!online.available || !online.current) return null;
  const c = online.current;

  return (
    <div className="flex items-center gap-3 bg-[var(--card)] rounded-xl px-4 py-3 border border-[var(--border)]">
      <WeatherIcon code={c.weatherCode} description={c.description} size={48} />
      <div className="flex-1 min-w-0">
        {c.description && (
          <p className="text-xs font-medium text-[var(--text-secondary)] capitalize mb-1 truncate">{c.description}</p>
        )}
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          {c.airTemperatureC != null && (
            <span className="text-2xl font-bold tabular-nums" style={{ color: '#f97316' }}>
              {c.airTemperatureC.toFixed(1)} Â°C
            </span>
          )}
          {c.relativeHumidityPct != null && (
            <span className="text-base font-semibold tabular-nums" style={{ color: '#06b6d4' }}>
              {c.relativeHumidityPct.toFixed(0)}% RH
            </span>
          )}
          {c.windSpeedMps != null && (
            <span className="text-xs text-[var(--text-secondary)] tabular-nums">
              {c.windSpeedMps.toFixed(1)} m/s
              {c.windDirectionDeg != null && ` ${toCompassDirection(c.windDirectionDeg) ?? ''}`}
            </span>
          )}
        </div>
      </div>
    </div>
  );
};

// â”€â”€ Rain summary pills â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface RainPillProps { label: string; value: string; highlight?: boolean }

const RainPill: React.FC<RainPillProps> = ({ label, value, highlight }) => (
  <div className={`flex flex-col items-center rounded-xl px-3 py-2 border ${highlight
    ? 'bg-blue-50 border-blue-200'
    : 'bg-[var(--card)] border-[var(--border)]'}`}>
    <span className="text-[10px] uppercase tracking-widest text-[var(--text-tertiary)] font-semibold mb-0.5">{label}</span>
    <span className={`text-sm font-bold tabular-nums ${highlight ? 'text-blue-700' : 'text-[var(--text)]'}`}>
      {value}
    </span>
  </div>
);

// â”€â”€ Daily strip â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const DayCard: React.FC<{ day: DailyForecast; isToday: boolean }> = ({ day, isToday }) => {
  const rain = day.rainMm ?? 0;
  return (
    <div className={`flex-shrink-0 w-20 flex flex-col items-center gap-1 rounded-xl p-2 border
      ${isToday
        ? 'bg-[var(--primary)]/10 border-[var(--primary)]'
        : 'bg-[var(--card)] border-[var(--border)]'}`}>
      <span className="text-xs font-semibold text-[var(--text-secondary)]">{fmtDay(day.date)}</span>
      <WeatherIcon code={day.weatherCode} description={day.description} size={40} animated={!isToday} />
      {(day.maxTempC != null || day.minTempC != null) && (
        <span className="text-xs font-medium tabular-nums text-[var(--text)]">
          {day.maxTempC != null ? `${day.maxTempC.toFixed(0)}Â°` : ''}
          {day.minTempC != null ? <span className="text-[var(--text-tertiary)]">/{day.minTempC.toFixed(0)}Â°</span> : ''}
        </span>
      )}
      {rain > 0 && (
        <span className={`text-[10px] font-semibold rounded-full px-1.5 py-0.5 border ${rainClass(rain)}`}>
          {rain.toFixed(1)} mm
        </span>
      )}
      {(day.rainProbabilityPct ?? 0) > 20 && (
        <span className="text-[10px] text-sky-600">
          {day.rainProbabilityPct!.toFixed(0)}%
        </span>
      )}
    </div>
  );
};

// â”€â”€ Hourly chart â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

interface ChartPoint { hour: string; rain: number; prob: number }

const HourlyChart: React.FC<{ hourly: HourlyForecast[] }> = ({ hourly }) => {
  const { t } = useTranslation('devices');
  if (hourly.length === 0) return null;

  const cutoff = Date.now() + 24 * 60 * 60 * 1000;
  const points: ChartPoint[] = hourly
    .filter(h => new Date(h.time).getTime() <= cutoff)
    .map(h => ({
      hour: fmtHour(h.time),
      rain: h.rainMm ?? 0,
      prob: h.rainProbabilityPct ?? 0,
    }));

  if (points.length === 0) return null;

  const maxRain = Math.max(...points.map(p => p.rain), 1);

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-bold uppercase tracking-widest text-[var(--text-tertiary)]">
        {t('environment.forecast.hourlyTitle', { defaultValue: 'Hourly rain (next 24 h)' })}
      </p>
      <ResponsiveContainer width="100%" height={130}>
        <ComposedChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="hour"
            tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }}
            interval="preserveStartEnd"
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            yAxisId="rain"
            domain={[0, maxRain * 1.2]}
            tick={{ fontSize: 10, fill: '#3b82f6' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={v => `${v.toFixed(0)}`}
          />
          <YAxis
            yAxisId="prob"
            orientation="right"
            domain={[0, 100]}
            tick={{ fontSize: 10, fill: '#94a3b8' }}
            tickLine={false}
            axisLine={false}
            tickFormatter={v => `${v}%`}
          />
          <Tooltip
            contentStyle={{
              background: 'var(--card)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 11,
            }}
            formatter={(val: number, name: string) =>
              name === 'rain' ? [`${val.toFixed(1)} mm`, 'Rain'] : [`${val.toFixed(0)}%`, 'Probability']}
          />
          <Bar yAxisId="rain" dataKey="rain" fill="#3b82f6" radius={[3,3,0,0]} opacity={0.85} />
          <Line
            yAxisId="prob"
            type="monotone"
            dataKey="prob"
            stroke="#94a3b8"
            strokeWidth={1.5}
            dot={false}
            strokeDasharray="4 2"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
};

// â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const WeatherTab: React.FC<Props> = ({ online, forecast, location }) => {
  const { t } = useTranslation('devices');

  const hasCurrent  = online.available && online.current != null;
  const hasForecast = forecast.available && forecast.rainFocus != null;

  if (!hasCurrent && !hasForecast) {
    const msg = location.source === 'unavailable'
      ? t('environment.forecast.noLocation', { defaultValue: 'Set zone coordinates to enable weather data' })
      : t('environment.forecast.noData', { defaultValue: 'No weather data available' });
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
      {/* Current conditions */}
      <CurrentConditions online={online} />

      {hasForecast && rf && (
        <>
          {/* Rain summary pills */}
          <div className="grid grid-cols-4 gap-2">
            <RainPill
              label={t('environment.forecast.next24h', { defaultValue: 'Next 24 h' })}
              value={`${rf.totalNext24hMm.toFixed(1)} mm`}
              highlight={rf.totalNext24hMm > 0}
            />
            <RainPill
              label={t('environment.forecast.next72h', { defaultValue: 'Next 72 h' })}
              value={`${rf.totalNext72hMm.toFixed(1)} mm`}
              highlight={rf.totalNext72hMm > 0}
            />
            <RainPill
              label={t('environment.forecast.nextRain', { defaultValue: 'Next rain' })}
              value={fmtEta(rf.nextRainEta)}
              highlight={rf.nextRainEta != null}
            />
            <RainPill
              label={t('environment.forecast.rainHours', { defaultValue: 'Rain hours' })}
              value={`${rf.rainHoursNext24h}h`}
              highlight={rf.rainHoursNext24h > 0}
            />
          </div>

          {/* Daily strip */}
          {rf.daily.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
              {rf.daily.map(day => (
                <DayCard
                  key={day.date}
                  day={day}
                  isToday={new Date(day.date + 'T12:00:00').toDateString() === todayStr}
                />
              ))}
            </div>
          )}

          {/* Hourly chart */}
          <HourlyChart hourly={rf.hourly} />
        </>
      )}
    </div>
  );
};
