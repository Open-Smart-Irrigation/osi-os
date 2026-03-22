import React, { useEffect, useState } from 'react';
import {
  AreaChart, Area, BarChart, Bar, LineChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
  ResponsiveContainer, Legend,
} from 'recharts';
import type { Device, DendroDaily, DendroReading } from '../../../types/farming';
import { dendroAnalyticsAPI } from '../../../services/api';
import { STRESS_CONFIG, tgrDirection } from './stressConfig';
import { StressBadge } from './StressBadge';

interface Props {
  device: Device;
  /** Daily indicators — newest first (already fetched by parent) */
  daily: DendroDaily[];
  onClose: () => void;
}

type Tab = 'indicators' | 'mds_tgr' | 'twd' | 'position';

const TAB_LABELS: { id: Tab; label: string }[] = [
  { id: 'indicators', label: 'Table' },
  { id: 'mds_tgr',    label: 'MDS & TGR' },
  { id: 'twd',        label: 'Water Deficit' },
  { id: 'position',   label: '24h Position' },
];

function fmtDate(iso: string) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Custom tooltip shared by recharts ─────────────────────────────────────────
const ChartTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-lg p-3 text-sm shadow-xl">
      <p className="text-[var(--text-tertiary)] mb-1 text-xs">{label}</p>
      {payload.map((p: any) => (
        <p key={p.dataKey} className="font-semibold" style={{ color: p.color }}>
          {p.name}: {p.value != null ? `${p.value} µm` : '—'}
        </p>
      ))}
    </div>
  );
};

// ── Table tab ─────────────────────────────────────────────────────────────────
const IndicatorsTable: React.FC<{ rows: DendroDaily[] }> = ({ rows }) => {
  const ordered = [...rows].reverse(); // oldest first

  const TgrCell: React.FC<{ v: number | null }> = ({ v }) => {
    if (v == null) return <span className="text-[var(--text-tertiary)]">—</span>;
    const dir = tgrDirection(v);
    const arrow = dir === 'up' ? '↑' : dir === 'down' ? '↓' : '→';
    const color = dir === 'up' ? 'text-green-600' : dir === 'down' ? 'text-red-600' : 'text-gray-400';
    return <span className={`font-semibold tabular-nums ${color}`}>{v >= 0 ? '+' : ''}{v} {arrow}</span>;
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b-2 border-[var(--border)]">
            {['Date', 'MDS', 'TGR', 'TWD', 'SI', 'Stress', 'Quality'].map(h => (
              <th key={h} className="text-left text-[var(--text-tertiary)] text-xs font-semibold pb-2 pr-4 whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ordered.map(row => {
            const cfg = STRESS_CONFIG[row.stress_level];
            return (
              <tr key={row.date} className="border-b border-[var(--border)] hover:bg-[var(--surface)]">
                <td className="py-2 pr-4 text-[var(--text-secondary)] whitespace-nowrap">{fmtDate(row.date)}</td>
                <td className="py-2 pr-4 font-semibold tabular-nums">{row.mds_um ?? '—'}</td>
                <td className="py-2 pr-4"><TgrCell v={row.tgr_um} /></td>
                <td className="py-2 pr-4 tabular-nums">
                  {row.twd_um != null && row.twd_um > 0
                    ? <span className="text-orange-600 font-semibold">{row.twd_um}</span>
                    : <span className="text-green-600">0</span>}
                </td>
                <td className="py-2 pr-4 tabular-nums text-[var(--text-secondary)]">
                  {row.signal_intensity != null ? row.signal_intensity.toFixed(2) : '—'}
                </td>
                <td className="py-2 pr-4">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${cfg.badgeBg} ${cfg.badgeText}`}>
                    {cfg.label}
                  </span>
                </td>
                <td className="py-2">
                  <span className={`text-xs ${row.data_quality === 'good' ? 'text-green-700' : 'text-amber-700'}`}>
                    {row.data_quality}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {ordered.length === 0 && (
        <p className="text-[var(--text-tertiary)] text-sm py-4 text-center">No daily data yet.</p>
      )}
    </div>
  );
};

// ── MDS & TGR chart tab ───────────────────────────────────────────────────────
const MdsTgrChart: React.FC<{ rows: DendroDaily[] }> = ({ rows }) => {
  const data = [...rows].reverse().map(r => ({
    date: fmtDate(r.date),
    mds:  r.mds_um,
    tgr:  r.tgr_smoothed_um,
  }));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-xs text-[var(--text-tertiary)] font-semibold mb-2 uppercase tracking-wide">
          Maximum Daily Shrinkage (µm)
        </p>
        <ResponsiveContainer width="100%" height={160}>
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="mdsGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#ea580c" stopOpacity={0.25} />
                <stop offset="95%" stopColor="#ea580c" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} />
            <YAxis tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} unit=" µm" width={60} />
            <Tooltip content={<ChartTooltip />} />
            <Area type="monotone" dataKey="mds" name="MDS" stroke="#ea580c" strokeWidth={2} fill="url(#mdsGrad)" dot={{ r: 3, fill: '#ea580c' }} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div>
        <p className="text-xs text-[var(--text-tertiary)] font-semibold mb-2 uppercase tracking-wide">
          Trunk Growth Rate — 3-day smoothed (µm)
        </p>
        <ResponsiveContainer width="100%" height={140}>
          <BarChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} />
            <YAxis tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} unit=" µm" width={60} />
            <Tooltip content={<ChartTooltip />} />
            <ReferenceLine y={0} stroke="var(--text-tertiary)" strokeDasharray="4 2" />
            <Bar
              dataKey="tgr"
              name="TGR smoothed"
              radius={[3, 3, 0, 0]}
              fill="#3b82f6"
              // colour each bar: green if positive, red if negative
              label={false}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

// ── TWD chart tab ─────────────────────────────────────────────────────────────
const TwdChart: React.FC<{ rows: DendroDaily[] }> = ({ rows }) => {
  const data = [...rows].reverse().map(r => ({
    date: fmtDate(r.date),
    twd:  r.twd_um,
    dr:   r.dr_um,
  }));

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-[var(--text-tertiary)] font-semibold uppercase tracking-wide">
        Tree Water Deficit &amp; Daily Recovery (µm)
      </p>
      <p className="text-xs text-[var(--text-tertiary)]">
        TWD = accumulated deficit since 30-day peak. Zero = no deficit (healthy). DR = overnight rehydration.
      </p>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} />
          <YAxis tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} unit=" µm" width={60} />
          <Tooltip content={<ChartTooltip />} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <ReferenceLine y={0} stroke="var(--text-tertiary)" strokeDasharray="4 2" />
          <Line type="monotone" dataKey="twd" name="TWD (deficit)" stroke="#dc2626" strokeWidth={2} dot={{ r: 3 }} />
          <Line type="monotone" dataKey="dr"  name="DR (recovery)" stroke="#16a34a" strokeWidth={2} strokeDasharray="5 3" dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
};

// ── 24h position chart tab ────────────────────────────────────────────────────
const PositionChart: React.FC<{ device: Device }> = ({ device }) => {
  const [readings, setReadings] = useState<DendroReading[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const to   = new Date().toISOString();
    const from = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    dendroAnalyticsAPI.getRawReadings(device.deveui, from, to)
      .then(data => { if (!cancelled) { setReadings(data); setLoading(false); } })
      .catch(e  => { if (!cancelled) { setError(e.message); setLoading(false); } });
    return () => { cancelled = true; };
  }, [device.deveui]);

  if (loading) return <Spinner />;
  if (error)   return <ErrorMsg msg={error} />;

  const validReadings = readings.filter(r => r.is_valid === 1 && r.is_outlier === 0);
  const data = validReadings.map(r => ({
    t:   new Date(r.recorded_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }),
    pos: Math.round(r.position_um / 100) / 10, // → mm with 1 decimal
  }));

  const posVals = data.map(d => d.pos).filter(v => v != null);
  const dMax = posVals.length ? Math.max(...posVals).toFixed(1) : null;
  const dMin = posVals.length ? Math.min(...posVals).toFixed(1) : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-4 text-sm">
        <p className="text-xs text-[var(--text-tertiary)] font-semibold uppercase tracking-wide flex-1">
          Trunk position — last 24h (mm)
        </p>
        {dMax && <span className="text-xs text-green-700">D_max {dMax} mm</span>}
        {dMin && <span className="text-xs text-orange-700">D_min {dMin} mm</span>}
      </div>
      {data.length === 0 ? (
        <p className="text-[var(--text-tertiary)] text-sm py-4 text-center">No valid readings in the last 24h.</p>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="posGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#3b82f6" stopOpacity={0.2} />
                <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="t" tick={{ fontSize: 10, fill: 'var(--text-tertiary)' }} interval="preserveStartEnd" />
            <YAxis tick={{ fontSize: 11, fill: 'var(--text-tertiary)' }} unit=" mm" width={52} />
            <Tooltip formatter={(v: number) => [`${v} mm`, 'Position']} labelFormatter={l => `Time: ${l}`} />
            {dMax && <ReferenceLine y={parseFloat(dMax)} stroke="#16a34a" strokeDasharray="4 2" label={{ value: 'D_max', position: 'right', fontSize: 10, fill: '#16a34a' }} />}
            {dMin && <ReferenceLine y={parseFloat(dMin)} stroke="#ea580c" strokeDasharray="4 2" label={{ value: 'D_min', position: 'right', fontSize: 10, fill: '#ea580c' }} />}
            <Area type="monotone" dataKey="pos" name="Position" stroke="#3b82f6" strokeWidth={1.5} fill="url(#posGrad)" dot={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
      <p className="text-xs text-[var(--text-tertiary)]">
        {readings.length} total readings, {validReadings.length} valid shown.
        {readings.length - validReadings.length > 0 && ` ${readings.length - validReadings.length} outliers/invalid hidden.`}
      </p>
    </div>
  );
};

// ── Helpers ───────────────────────────────────────────────────────────────────
const Spinner = () => (
  <div className="flex items-center gap-2 py-8 justify-center text-[var(--text-tertiary)] text-sm">
    <div className="animate-spin h-5 w-5 border-2 border-[var(--primary)] border-t-transparent rounded-full" />
    Loading…
  </div>
);
const ErrorMsg = ({ msg }: { msg: string }) => (
  <div className="text-sm text-[var(--error-text)] bg-[var(--error-bg)] rounded-lg px-3 py-2 my-2">{msg}</div>
);

// ── Main component ────────────────────────────────────────────────────────────
export const DendrometerMonitor: React.FC<Props> = ({ device, daily, onClose }) => {
  const [tab, setTab] = useState<Tab>('indicators');
  const stress = daily[0]?.stress_level ?? 'none';
  const cfg    = STRESS_CONFIG[stress];

  return (
    <div className="fixed inset-0 z-50 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Drawer */}
      <div className="w-full max-w-lg bg-[var(--card)] flex flex-col shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-[var(--border)]" style={{ borderLeftWidth: 4, borderLeftColor: cfg.hex }}>
          <button
            onClick={onClose}
            className="text-[var(--text-tertiary)] hover:text-[var(--text)] transition-colors text-lg leading-none"
            aria-label="Close"
          >
            ←
          </button>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-[var(--text)] text-base truncate">{device.name}</p>
            <p className="text-[var(--text-tertiary)] text-xs">{device.deveui}</p>
          </div>
          <StressBadge level={stress} size="sm" />
        </div>

        {/* Tabs */}
        <div className="flex border-b border-[var(--border)] bg-[var(--surface)]">
          {TAB_LABELS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex-1 py-2.5 text-xs font-semibold transition-colors ${
                tab === id
                  ? 'text-[var(--primary)] border-b-2 border-[var(--primary)] bg-[var(--card)]'
                  : 'text-[var(--text-tertiary)] hover:text-[var(--text)]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {tab === 'indicators' && <IndicatorsTable rows={daily} />}
          {tab === 'mds_tgr'    && <MdsTgrChart    rows={daily} />}
          {tab === 'twd'        && <TwdChart        rows={daily} />}
          {tab === 'position'   && <PositionChart   device={device} />}
        </div>
      </div>
    </div>
  );
};
