import React from 'react';
import type { Device, DendroDaily } from '../../../types/farming';

interface Props {
  devices: Device[];
  dailyMap: Record<string, DendroDaily[]>;
}

function avg(vals: number[]) {
  if (!vals.length) return null;
  return Math.round(vals.reduce((s, v) => s + v, 0) / vals.length);
}

function fmt(v: number | null, unit: string, sign = false) {
  if (v == null) return '—';
  return (sign && v > 0 ? '+' : '') + v + ' ' + unit;
}

function fmtSi(v: number | null) {
  if (v == null) return '—';
  return v.toFixed(2);
}

interface Stat {
  label: string;
  unit: string;
  values: number[];
  sign?: boolean;
  note?: string;
}

export const ZoneAnalysisCard: React.FC<Props> = ({ devices, dailyMap }) => {
  const todays = devices.map(d => (dailyMap[d.deveui] ?? [])[0] ?? null);

  const monitored = devices.filter(d => d.is_reference_tree !== 1);
  const todaysMon = monitored.map(d => (dailyMap[d.deveui] ?? [])[0] ?? null);

  const mdsVals  = todays.map(r => r?.mds_um).filter((v): v is number => v != null);
  const tgrVals  = todays.map(r => r?.tgr_um).filter((v): v is number => v != null);
  const twdVals  = todays.map(r => r?.twd_um).filter((v): v is number => v != null);
  const siVals   = todaysMon.map(r => r?.signal_intensity).filter((v): v is number => v != null);

  const stats: { label: string; values: number[]; fmt: (v: number | null) => string; note?: string }[] = [
    {
      label: 'MDS',
      values: mdsVals,
      fmt: v => fmt(v, 'µm'),
    },
    {
      label: 'TGR',
      values: tgrVals,
      fmt: v => fmt(v, 'µm', true),
      note: 'trunk growth',
    },
    {
      label: 'TWD',
      values: twdVals,
      fmt: v => fmt(v, 'µm'),
      note: 'water deficit',
    },
    {
      label: 'SI',
      values: siVals,
      fmt: fmtSi,
      note: `monitored only (${monitored.length})`,
    },
  ];

  const hasAnyData = mdsVals.length > 0;
  if (!hasAnyData) return null;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3">
      <p className="text-xs font-bold uppercase tracking-widest text-[var(--text-tertiary)] mb-3">
        Zone Average — today ({devices.length} tree{devices.length !== 1 ? 's' : ''})
      </p>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="text-left text-xs text-[var(--text-tertiary)] font-semibold pb-1.5 pr-4 w-12">Param</th>
              <th className="text-right text-xs text-[var(--text-tertiary)] font-semibold pb-1.5 pr-4">Mean</th>
              <th className="text-right text-xs text-[var(--text-tertiary)] font-semibold pb-1.5 pr-4">Min</th>
              <th className="text-right text-xs text-[var(--text-tertiary)] font-semibold pb-1.5 pr-4">Max</th>
              <th className="text-right text-xs text-[var(--text-tertiary)] font-semibold pb-1.5">n</th>
            </tr>
          </thead>
          <tbody>
            {stats.map(({ label, values, fmt: fmtFn, note }) => {
              if (values.length === 0) return null;
              const meanVal = label === 'SI'
                ? (values.length ? +(values.reduce((s, v) => s + v, 0) / values.length).toFixed(2) : null)
                : avg(values);
              const minVal  = label === 'SI'
                ? +(Math.min(...values)).toFixed(2)
                : Math.min(...values);
              const maxVal  = label === 'SI'
                ? +(Math.max(...values)).toFixed(2)
                : Math.max(...values);
              return (
                <tr key={label} className="border-b border-[var(--border)] last:border-0">
                  <td className="py-1.5 pr-4">
                    <span className="font-semibold text-[var(--text)]">{label}</span>
                    {note && <span className="text-[var(--text-tertiary)] text-xs ml-1">({note})</span>}
                  </td>
                  <td className="py-1.5 pr-4 text-right font-bold tabular-nums text-[var(--text)]">
                    {fmtFn(meanVal)}
                  </td>
                  <td className="py-1.5 pr-4 text-right tabular-nums text-[var(--text-secondary)]">
                    {fmtFn(minVal)}
                  </td>
                  <td className="py-1.5 pr-4 text-right tabular-nums text-[var(--text-secondary)]">
                    {fmtFn(maxVal)}
                  </td>
                  <td className="py-1.5 text-right tabular-nums text-[var(--text-tertiary)] text-xs">
                    {values.length}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
