import React, { useEffect, useMemo, useState } from 'react';
import {
  AreaChart, Area, BarChart, Bar, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { dendroAPI, type DendroHistoryPoint } from '../../services/api';

interface Props {
  deveui: string;
  deviceName: string;
  onClose: () => void;
}

const TIME_WINDOWS = [
  { label: '12 h', hours: 12 },
  { label: '24 h', hours: 24 },
  { label: '7 d',  hours: 168 },
  { label: '30 d', hours: 720 },
  { label: '90 d', hours: 2160 },
];

const DELTA_INTERVALS = [
  { label: '30 min', minutes: 30 },
  { label: '1 h',   minutes: 60 },
  { label: '6 h',   minutes: 360 },
  { label: '12 h',  minutes: 720 },
];

// ─── tick / label formatters ────────────────────────────────────────────────

function fmtTickShort(iso: string, hours: number): string {
  const d = new Date(iso);
  if (hours <= 24) {
    return d.toLocaleString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  if (hours <= 168) {
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric' });
}

function fmtLabel(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

// ─── aggregated-delta computation ───────────────────────────────────────────

interface DeltaBucket {
  t: string;        // ISO of bucket start — used as chart dataKey
  tEnd: string;     // ISO of bucket end
  mean: number;     // mean position_mm across all uplinks in this bucket
  count: number;    // how many uplinks went into the mean
  delta: number | null; // mean(this) − mean(prev adjacent bucket); null when gap > 1.5× interval
}

function computeAggregatedDeltas(
  data: DendroHistoryPoint[],
  intervalMinutes: number,
): DeltaBucket[] {
  const valid = data.filter(d => d.valid === 1 && d.position_mm != null);
  if (valid.length === 0) return [];

  const intervalMs = intervalMinutes * 60 * 1000;

  // Group readings into fixed-width time buckets
  const bucketMap = new Map<number, number[]>();
  for (const pt of valid) {
    const ts = new Date(pt.t).getTime();
    const bucketStart = Math.floor(ts / intervalMs) * intervalMs;
    const arr = bucketMap.get(bucketStart) ?? [];
    arr.push(pt.position_mm);
    bucketMap.set(bucketStart, arr);
  }

  const sorted = [...bucketMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([startMs, vals]) => ({
      startMs,
      t: new Date(startMs).toISOString(),
      tEnd: new Date(startMs + intervalMs).toISOString(),
      mean: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 1000) / 1000,
      count: vals.length,
    }));

  return sorted.map((bucket, i) => {
    if (i === 0) return { ...bucket, delta: null };
    const prev = sorted[i - 1];
    // Only compare adjacent buckets — discard if gap is larger than 1.5× the interval
    // (accounts for a single missed uplink within the bucket)
    const gap = bucket.startMs - prev.startMs;
    const delta =
      gap <= intervalMs * 1.5
        ? Math.round((bucket.mean - prev.mean) * 1000) / 1000
        : null;
    return { ...bucket, delta };
  });
}

// ─── custom tooltips ────────────────────────────────────────────────────────

const TooltipPosition = ({ active, payload, label, hours }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-3 text-sm shadow-xl">
      <p className="text-[var(--text-tertiary)] mb-1">{fmtTickShort(label, hours)}</p>
      <p className="font-bold text-[var(--text)]">{payload[0].value?.toFixed(3)} mm</p>
      {payload[0].payload.adc_v !== undefined && (
        <p className="text-[var(--text-tertiary)] text-xs">ADC: {payload[0].payload.adc_v?.toFixed(3)} V</p>
      )}
    </div>
  );
};

const TooltipDelta = ({ active, payload, label, intervalMinutes, hours }: any) => {
  if (!active || !payload?.length) return null;
  const bucket: DeltaBucket = payload[0]?.payload;
  const v: number | null = payload[0].value;
  if (v == null) return null;
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-3 text-sm shadow-xl">
      <p className="text-[var(--text-tertiary)] mb-1">
        {fmtTickShort(label, hours)} → {fmtTickShort(bucket.tEnd, hours)}
      </p>
      <p className={`font-bold ${v >= 0 ? 'text-[#22c55e]' : 'text-[var(--error-text)]'}`}>
        {v >= 0 ? '+' : ''}{v.toFixed(3)} mm
      </p>
      <p className="text-[var(--text-tertiary)] text-xs mt-0.5">
        Mean: {bucket.mean.toFixed(3)} mm · {bucket.count} uplinks
      </p>
    </div>
  );
};

// ─── component ───────────────────────────────────────────────────────────────

export const DendrometerMonitor: React.FC<Props> = ({ deveui, deviceName, onClose }) => {
  const [hours, setHours] = useState(24);
  const [deltaIntervalMinutes, setDeltaIntervalMinutes] = useState(60);
  const [data, setData] = useState<DendroHistoryPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    dendroAPI.getHistory(deveui, hours)
      .then(rows => { if (!cancelled) { setData(rows); setLoading(false); } })
      .catch(err  => { if (!cancelled) { setError(err.message || 'Failed to load'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [deveui, hours]);

  // Tick reduction for position chart: ~8 ticks max
  const posTicks = useMemo(() => {
    if (!data.length) return [];
    const step = Math.max(1, Math.floor(data.length / 8));
    return data.filter((_, i) => i % step === 0).map(d => d.t);
  }, [data]);

  // Aggregated delta buckets (recomputed when data or interval changes)
  const deltaBuckets = useMemo(
    () => computeAggregatedDeltas(data, deltaIntervalMinutes),
    [data, deltaIntervalMinutes],
  );

  const deltaBucketsWithValue = deltaBuckets.filter(b => b.delta !== null);

  // Tick reduction for delta chart: ~8 ticks max
  const deltaTicks = useMemo(() => {
    if (!deltaBuckets.length) return [];
    const step = Math.max(1, Math.floor(deltaBuckets.length / 8));
    return deltaBuckets.filter((_, i) => i % step === 0).map(b => b.t);
  }, [deltaBuckets]);

  // Summary stats
  const validPositions = data.filter(d => d.valid === 1).map(d => d.position_mm);
  const minPos = validPositions.length ? Math.min(...validPositions) : null;
  const maxPos = validPositions.length ? Math.max(...validPositions) : null;
  const latest = data[data.length - 1];

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
              Dendrometer Monitor
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

        {/* Stats row */}
        {!loading && !error && data.length > 0 && (
          <div className="px-6 pt-4 grid grid-cols-3 gap-3 shrink-0">
            <div className="bg-[var(--card)] rounded-lg p-3 text-center">
              <p className="text-[var(--text-tertiary)] text-xs font-semibold">CURRENT</p>
              <p className="text-xl font-bold text-[var(--text)]">{latest?.position_mm?.toFixed(2)} mm</p>
            </div>
            <div className="bg-[var(--card)] rounded-lg p-3 text-center">
              <p className="text-[var(--text-tertiary)] text-xs font-semibold">MIN</p>
              <p className="text-xl font-bold text-[var(--text)]">
                {minPos !== null ? minPos.toFixed(2) : '—'} mm
              </p>
            </div>
            <div className="bg-[var(--card)] rounded-lg p-3 text-center">
              <p className="text-[var(--text-tertiary)] text-xs font-semibold">MAX</p>
              <p className="text-xl font-bold text-[var(--text)]">
                {maxPos !== null ? maxPos.toFixed(2) : '—'} mm
              </p>
            </div>
          </div>
        )}

        <div className="flex-1 px-6 py-4 flex flex-col gap-8">
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
                No dendrometer data in the last {hours} hours.
              </p>
            </div>
          )}

          {!loading && !error && data.length > 0 && (
            <>
              {/* Chart 1: Absolute position */}
              <div>
                <h3 className="text-[var(--text)] font-bold mb-3">Trunk Position (mm)</h3>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                    <defs>
                      <linearGradient id="posGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%"  stopColor="#22c55e" stopOpacity={0.35} />
                        <stop offset="95%" stopColor="#22c55e" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                    <XAxis
                      dataKey="t"
                      ticks={posTicks}
                      tickFormatter={v => fmtTickShort(v, hours)}
                      tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                      axisLine={{ stroke: 'var(--border)' }}
                      tickLine={false}
                    />
                    <YAxis
                      domain={['auto', 'auto']}
                      tickFormatter={v => v.toFixed(1)}
                      tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                      axisLine={false}
                      tickLine={false}
                      width={48}
                    />
                    <Tooltip content={<TooltipPosition hours={hours} />} />
                    <Area
                      type="monotone"
                      dataKey="position_mm"
                      stroke="#22c55e"
                      strokeWidth={2}
                      fill="url(#posGrad)"
                      dot={false}
                      activeDot={{ r: 4, fill: '#22c55e' }}
                      connectNulls={false}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>

              {/* Chart 2: Aggregated delta */}
              <div>
                {/* Header row with title + interval selector */}
                <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                  <h3 className="text-[var(--text)] font-bold">Change per Period (mm)</h3>
                  <div className="flex gap-1.5">
                    {DELTA_INTERVALS.map(iv => (
                      <button
                        key={iv.minutes}
                        onClick={() => setDeltaIntervalMinutes(iv.minutes)}
                        className={`px-3 py-1 rounded-lg text-xs font-semibold transition-colors ${
                          deltaIntervalMinutes === iv.minutes
                            ? 'bg-[var(--primary)] text-white'
                            : 'bg-[var(--card)] text-[var(--text)] hover:bg-[var(--border)]'
                        }`}
                      >
                        {iv.label}
                      </button>
                    ))}
                  </div>
                </div>

                {deltaBucketsWithValue.length < 2 ? (
                  <p className="text-[var(--text-tertiary)] text-sm py-4">
                    Not enough data for {DELTA_INTERVALS.find(i => i.minutes === deltaIntervalMinutes)?.label} intervals.
                    Try a smaller interval or a longer time window.
                  </p>
                ) : (
                  <>
                    <ResponsiveContainer width="100%" height={210}>
                      <BarChart
                        data={deltaBuckets}
                        margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                        barCategoryGap="20%"
                      >
                        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                        <XAxis
                          dataKey="t"
                          ticks={deltaTicks}
                          tickFormatter={v => fmtTickShort(v, hours)}
                          tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                          axisLine={{ stroke: 'var(--border)' }}
                          tickLine={false}
                        />
                        <YAxis
                          domain={['auto', 'auto']}
                          tickFormatter={v => `${v > 0 ? '+' : ''}${v.toFixed(2)}`}
                          tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }}
                          axisLine={false}
                          tickLine={false}
                          width={56}
                        />
                        <ReferenceLine y={0} stroke="var(--border)" strokeWidth={1.5} />
                        <Tooltip
                          content={<TooltipDelta intervalMinutes={deltaIntervalMinutes} hours={hours} />}
                          cursor={{ fill: 'var(--border)', opacity: 0.4 }}
                        />
                        <Bar dataKey="delta" radius={[2, 2, 0, 0]}>
                          {deltaBuckets.map((entry, index) => (
                            <Cell
                              key={`cell-${index}`}
                              fill={
                                entry.delta === null
                                  ? 'transparent'
                                  : entry.delta >= 0
                                  ? '#22c55e'
                                  : '#ef4444'
                              }
                              fillOpacity={entry.delta === null ? 0 : 0.85}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                    <p className="text-[var(--text-tertiary)] text-xs mt-1">
                      Each bar = mean position over a {DELTA_INTERVALS.find(i => i.minutes === deltaIntervalMinutes)?.label} window
                      minus the mean of the preceding window.
                      Gaps between non-adjacent windows are omitted.
                    </p>
                  </>
                )}
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
