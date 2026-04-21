import React, { useEffect, useMemo, useState } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { sensorAPI, type SensorHistoryPoint } from '../../services/api';
import { formatWindDirection, roundWindDirectionDegrees, toCompassDirection } from '../../utils/wind';

interface Props {
  deveui: string;
  deviceName: string;
  onClose: () => void;
}

type WindHistoryPoint = {
  t: string;
  wind_speed_mps: number | null;
  wind_gust_mps: number | null;
  wind_direction_deg: number | null;
};

const TIME_WINDOWS = [
  { label: '12 h', hours: 12 },
  { label: '24 h', hours: 24 },
  { label: '7 d', hours: 168 },
  { label: '30 d', hours: 720 },
  { label: '90 d', hours: 2160 },
];

function fmtTick(iso: string, hours: number): string {
  const d = new Date(iso);
  if (hours <= 24) {
    return d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  if (hours <= 168) {
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric' });
}

function formatSpeed(value: number | null | undefined): string {
  return value != null ? `${value.toFixed(1)} m/s` : '—';
}

function mergeSeries(
  speedRows: SensorHistoryPoint[],
  gustRows: SensorHistoryPoint[],
  directionRows: SensorHistoryPoint[],
): WindHistoryPoint[] {
  const map = new Map<string, WindHistoryPoint>();
  const ensurePoint = (timestamp: string): WindHistoryPoint => {
    const existing = map.get(timestamp);
    if (existing) {
      return existing;
    }
    const next: WindHistoryPoint = {
      t: timestamp,
      wind_speed_mps: null,
      wind_gust_mps: null,
      wind_direction_deg: null,
    };
    map.set(timestamp, next);
    return next;
  };

  for (const row of speedRows) {
    ensurePoint(row.t).wind_speed_mps = row.value;
  }
  for (const row of gustRows) {
    ensurePoint(row.t).wind_gust_mps = row.value;
  }
  for (const row of directionRows) {
    ensurePoint(row.t).wind_direction_deg = row.value;
  }

  return Array.from(map.values()).sort((left, right) => new Date(left.t).getTime() - new Date(right.t).getTime());
}

const WindTooltip = ({ active, payload, label, hours }: any) => {
  if (!active || !payload?.length) return null;
  const point = payload[0]?.payload as WindHistoryPoint | undefined;
  if (!point) return null;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3 text-sm shadow-xl">
      <p className="mb-1 text-[var(--text-tertiary)]">{fmtTick(label, hours)}</p>
      {point.wind_speed_mps != null && (
        <p className="font-bold text-[var(--text)]">Speed: {point.wind_speed_mps.toFixed(1)} m/s</p>
      )}
      {point.wind_gust_mps != null && (
        <p className="text-[var(--text-secondary)]">Gust: {point.wind_gust_mps.toFixed(1)} m/s</p>
      )}
      {point.wind_direction_deg != null && (
        <p className="text-[var(--text-secondary)]">Direction: {formatWindDirection(point.wind_direction_deg)}</p>
      )}
    </div>
  );
};

export const WindMonitor: React.FC<Props> = ({ deveui, deviceName, onClose }) => {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<WindHistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      sensorAPI.getHistory(deveui, 'wind_speed_mps', hours),
      sensorAPI.getHistory(deveui, 'wind_gust_mps', hours),
      sensorAPI.getHistory(deveui, 'wind_direction_deg', hours),
    ])
      .then(([speedRows, gustRows, directionRows]) => {
        if (!cancelled) {
          setData(mergeSeries(speedRows, gustRows, directionRows));
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || 'Failed to load');
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [deveui, hours]);

  const ticks = useMemo(() => {
    if (!data.length) return [];
    const step = Math.max(1, Math.floor(data.length / 8));
    return data.filter((_, index) => index % step === 0).map((point) => point.t);
  }, [data]);

  const speedValues = data
    .map((point) => point.wind_speed_mps)
    .filter((value): value is number => value !== null);
  const gustValues = data
    .map((point) => point.wind_gust_mps)
    .filter((value): value is number => value !== null);
  const directionPoints = data.filter((point) => point.wind_direction_deg != null);
  const currentSpeed = speedValues.length ? speedValues[speedValues.length - 1] : null;
  const peakGust = gustValues.length ? Math.max(...gustValues) : null;
  const currentDirection = directionPoints.length ? directionPoints[directionPoints.length - 1].wind_direction_deg : null;
  const hasChartData = speedValues.length > 0 || gustValues.length > 0;
  const hasAnyData = hasChartData || directionPoints.length > 0;

  const sampledDirectionPoints = useMemo(() => {
    if (!directionPoints.length) return [];
    const maxSamples = 10;
    const step = Math.max(1, Math.ceil(directionPoints.length / maxSamples));
    const sampled = directionPoints.filter((_, index) => index % step === 0);
    const lastPoint = directionPoints[directionPoints.length - 1];
    if (sampled[sampled.length - 1]?.t !== lastPoint.t) {
      sampled.push(lastPoint);
    }
    return sampled;
  }, [directionPoints]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="flex h-full w-full max-w-2xl flex-col overflow-y-auto bg-[var(--bg)] shadow-2xl">
        <div className="flex shrink-0 items-center justify-between bg-[var(--header-bg)] px-6 py-4">
          <div>
            <h2 className="high-contrast-text text-2xl font-bold text-[var(--header-text)]">Wind</h2>
            <p className="mt-0.5 text-sm text-[var(--header-subtext)]">{deviceName} · {deveui}</p>
          </div>
          <button onClick={onClose} className="px-2 text-3xl font-light leading-none text-[var(--header-text)] hover:text-white">×</button>
        </div>

        <div className="flex flex-wrap gap-2 px-6 pt-4">
          {TIME_WINDOWS.map((window) => (
            <button
              key={window.hours}
              onClick={() => setHours(window.hours)}
              className={`rounded-lg px-4 py-1.5 text-sm font-semibold transition-colors ${
                hours === window.hours
                  ? 'bg-[var(--primary)] text-white'
                  : 'bg-[var(--card)] text-[var(--text)] hover:bg-[var(--border)]'
              }`}
            >
              {window.label}
            </button>
          ))}
        </div>

        {!loading && !error && hasAnyData && (
          <div className="grid grid-cols-3 gap-3 px-6 pt-4">
            <div className="rounded-lg bg-[var(--card)] p-3 text-center">
              <p className="text-xs font-semibold text-[var(--text-tertiary)]">CURRENT SPEED</p>
              <p className="text-xl font-bold text-[var(--text)]">{formatSpeed(currentSpeed)}</p>
            </div>
            <div className="rounded-lg bg-[var(--card)] p-3 text-center">
              <p className="text-xs font-semibold text-[var(--text-tertiary)]">PEAK GUST</p>
              <p className="text-xl font-bold text-[var(--text)]">{formatSpeed(peakGust)}</p>
            </div>
            <div className="rounded-lg bg-[var(--card)] p-3 text-center">
              <p className="text-xs font-semibold text-[var(--text-tertiary)]">CURRENT DIRECTION</p>
              <p className="text-xl font-bold text-[var(--text)]">{formatWindDirection(currentDirection)}</p>
            </div>
          </div>
        )}

        <div className="flex flex-1 flex-col gap-6 px-6 py-4">
          {loading && (
            <div className="flex flex-1 items-center justify-center">
              <div className="h-10 w-10 animate-spin rounded-full border-4 border-[var(--primary)] border-t-transparent" />
            </div>
          )}
          {error && (
            <div className="rounded-lg bg-[var(--error-bg)] p-4 text-center text-[var(--error-text)]">{error}</div>
          )}
          {!loading && !error && !hasAnyData && (
            <div className="flex flex-1 items-center justify-center">
              <p className="text-lg text-[var(--text-tertiary)]">No wind data in the last {hours} hours.</p>
            </div>
          )}
          {!loading && !error && hasAnyData && (
            <>
              <div>
                <h3 className="mb-3 font-bold text-[var(--text)]">Speed and gust (m/s)</h3>
                {hasChartData ? (
                  <ResponsiveContainer width="100%" height={260}>
                    <ComposedChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                      <defs>
                        <linearGradient id="wind-speed-fill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.35} />
                          <stop offset="95%" stopColor="#4f46e5" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
                      <XAxis
                        dataKey="t"
                        ticks={ticks}
                        tickFormatter={(value) => fmtTick(value, hours)}
                        tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                        axisLine={{ stroke: 'var(--border)' }}
                        tickLine={false}
                      />
                      <YAxis
                        domain={['auto', 'auto']}
                        tickFormatter={(value) => value.toFixed(1)}
                        tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                        axisLine={false}
                        tickLine={false}
                        width={56}
                      />
                      <Tooltip content={<WindTooltip hours={hours} />} />
                      <Area
                        type="monotone"
                        dataKey="wind_speed_mps"
                        stroke="#4f46e5"
                        strokeWidth={2}
                        fill="url(#wind-speed-fill)"
                        dot={false}
                        activeDot={{ r: 4, fill: '#4f46e5' }}
                        connectNulls={false}
                      />
                      <Line
                        type="monotone"
                        dataKey="wind_gust_mps"
                        stroke="#dc2626"
                        strokeWidth={2}
                        dot={false}
                        activeDot={{ r: 4, fill: '#dc2626' }}
                        connectNulls={false}
                      />
                    </ComposedChart>
                  </ResponsiveContainer>
                ) : (
                  <div className="rounded-lg bg-[var(--card)] p-4 text-sm text-[var(--text-tertiary)]">
                    No wind-speed or gust samples are available in this window.
                  </div>
                )}
              </div>

              <div>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <h3 className="font-bold text-[var(--text)]">Direction history</h3>
                  <p className="text-xs text-[var(--text-tertiary)]">{directionPoints.length} samples</p>
                </div>
                {sampledDirectionPoints.length > 0 ? (
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {sampledDirectionPoints.map((point) => {
                      const rounded = roundWindDirectionDegrees(point.wind_direction_deg);
                      const compass = toCompassDirection(point.wind_direction_deg);
                      return (
                        <div key={point.t} className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3">
                          <div className="mb-2 flex items-center gap-3">
                            <span
                              className="inline-block text-2xl text-[var(--primary)]"
                              style={{ transform: `rotate(${rounded ?? 0}deg)` }}
                            >
                              ↑
                            </span>
                            <div>
                              <p className="font-semibold text-[var(--text)]">{compass ?? '—'}</p>
                              <p className="text-xs text-[var(--text-tertiary)]">
                                {rounded != null ? `${rounded}°` : '—'}
                              </p>
                            </div>
                          </div>
                          <p className="text-xs text-[var(--text-tertiary)]">{fmtTick(point.t, hours)}</p>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="rounded-lg bg-[var(--card)] p-4 text-sm text-[var(--text-tertiary)]">
                    No wind-direction samples are available in this window.
                  </div>
                )}
              </div>

              <p className="pb-2 text-center text-xs text-[var(--text-tertiary)]">
                {data.length} timestamps · last {hours} h
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
