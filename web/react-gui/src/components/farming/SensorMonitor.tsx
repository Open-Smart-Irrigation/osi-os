import React, { useEffect, useMemo, useState } from 'react';
import {
  AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { sensorAPI, type SensorHistoryPoint } from '../../services/api';

interface Props {
  deveui: string;
  deviceName: string;
  field: string;
  label: string;
  unit: string;
  color?: string;
  decimals?: number;
  onClose: () => void;
}

const TIME_WINDOWS = [
  { label: '12 h', hours: 12 },
  { label: '24 h', hours: 24 },
  { label: '7 d',  hours: 168 },
  { label: '30 d', hours: 720 },
  { label: '90 d', hours: 2160 },
];

function fmtTick(iso: string, hours: number): string {
  const d = new Date(iso);
  if (hours <= 24)  return d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (hours <= 168) return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric' });
}

function fmtLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

const ChartTooltip = ({ active, payload, label, unit, decimals, hours }: any) => {
  if (!active || !payload?.length) return null;
  const v: number = payload[0].value;
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-3 text-sm shadow-xl">
      <p className="text-[var(--text-tertiary)] mb-1">{fmtTick(label, hours)}</p>
      <p className="font-bold text-[var(--text)]">{v?.toFixed(decimals ?? 1)} {unit}</p>
    </div>
  );
};

export const SensorMonitor: React.FC<Props> = ({
  deveui, deviceName, field, label, unit, color = '#22c55e', decimals = 1, onClose,
}) => {
  const [hours, setHours] = useState(24);
  const [data, setData] = useState<SensorHistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    sensorAPI.getHistory(deveui, field, hours)
      .then(rows => { if (!cancelled) { setData(rows); setLoading(false); } })
      .catch(err  => { if (!cancelled) { setError(err.message || 'Failed to load'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [deveui, field, hours]);

  const ticks = useMemo(() => {
    if (!data.length) return [];
    const step = Math.max(1, Math.floor(data.length / 8));
    return data.filter((_, i) => i % step === 0).map(d => d.t);
  }, [data]);

  const values = data.map(d => d.value).filter((v): v is number => v !== null);
  const minVal = values.length ? Math.min(...values) : null;
  const maxVal = values.length ? Math.max(...values) : null;
  const latest = values.length ? values[values.length - 1] : null;

  // gradient id needs to be unique per field to avoid conflicts when multiple monitors are open
  const gradId = `grad-${field}`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-end"
      style={{ background: 'rgba(0,0,0,0.55)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-2xl bg-[var(--bg)] flex flex-col h-full overflow-y-auto shadow-2xl">

        {/* Header */}
        <div className="bg-[var(--header-bg)] px-6 py-4 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-2xl font-bold text-[var(--header-text)] high-contrast-text">
              {label}
            </h2>
            <p className="text-[var(--header-subtext)] text-sm mt-0.5">{deviceName} · {deveui}</p>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--header-text)] text-3xl font-light leading-none hover:text-white px-2"
          >
            ×
          </button>
        </div>

        {/* Time window selector */}
        <div className="px-6 pt-4 flex flex-wrap gap-2 shrink-0">
          {TIME_WINDOWS.map(w => (
            <button
              key={w.hours}
              onClick={() => setHours(w.hours)}
              className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition-colors ${
                hours === w.hours
                  ? 'bg-[var(--primary)] text-white'
                  : 'bg-[var(--card)] text-[var(--text)] hover:bg-[var(--border)]'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>

        {/* Stats */}
        {!loading && !error && data.length > 0 && (
          <div className="px-6 pt-4 grid grid-cols-3 gap-3 shrink-0">
            {[
              { label: 'CURRENT', val: latest },
              { label: 'MIN',     val: minVal },
              { label: 'MAX',     val: maxVal },
            ].map(({ label: lbl, val }) => (
              <div key={lbl} className="bg-[var(--card)] rounded-lg p-3 text-center">
                <p className="text-[var(--text-tertiary)] text-xs font-semibold">{lbl}</p>
                <p className="text-xl font-bold text-[var(--text)]">
                  {val !== null ? `${val.toFixed(decimals)} ${unit}` : '—'}
                </p>
              </div>
            ))}
          </div>
        )}

        <div className="flex-1 px-6 py-4 flex flex-col gap-6">
          {loading && (
            <div className="flex-1 flex items-center justify-center">
              <div className="animate-spin h-10 w-10 border-4 border-[var(--primary)] border-t-transparent rounded-full" />
            </div>
          )}
          {error && (
            <div className="bg-[var(--error-bg)] text-[var(--error-text)] rounded-lg p-4 text-center">
              {error}
            </div>
          )}
          {!loading && !error && data.length === 0 && (
            <div className="flex-1 flex items-center justify-center">
              <p className="text-[var(--text-tertiary)] text-lg">
                No {label.toLowerCase()} data in the last {hours} hours.
              </p>
            </div>
          )}

          {!loading && !error && data.length > 0 && (
            <>
              <div>
                <h3 className="text-[var(--text)] font-bold mb-3">{label} ({unit})</h3>
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor={color} stopOpacity={0.35} />
                        <stop offset="95%" stopColor={color} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      dataKey="t"
                      ticks={ticks}
                      tickFormatter={v => fmtTick(v, hours)}
                      tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                      axisLine={{ stroke: 'var(--border)' }}
                      tickLine={false}
                    />
                    <YAxis
                      domain={['auto', 'auto']}
                      tickFormatter={v => v.toFixed(decimals)}
                      tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                      axisLine={false}
                      tickLine={false}
                      width={52}
                    />
                    <Tooltip content={<ChartTooltip unit={unit} decimals={decimals} hours={hours} />} />
                    <Area
                      type="monotone"
                      dataKey="value"
                      stroke={color}
                      strokeWidth={2}
                      fill={`url(#${gradId})`}
                      dot={false}
                      activeDot={{ r: 4, fill: color }}
                      connectNulls={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <p className="text-[var(--text-tertiary)] text-xs text-center pb-2">
                {data.length} readings · last {hours} h
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
