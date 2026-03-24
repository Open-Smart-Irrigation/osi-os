import React from 'react';
import type { Device, DendroDaily } from '../../../types/farming';
import { STRESS_CONFIG, tgrDirection } from './stressConfig';
import { StressBadge } from './StressBadge';

interface Props {
  device: Device;
  /** Latest computed daily indicators (may be absent if compute hasn't run yet today) */
  today: DendroDaily | null;
  /** Previous 7 days for the MDS sparkline (oldest first) */
  history: DendroDaily[];
  onOpenMonitor: () => void;
}

// ── Tiny SVG sparkline ────────────────────────────────────────────────────────
const MdsSparkline: React.FC<{ data: DendroDaily[]; color: string }> = ({ data, color }) => {
  const vals = data.map(d => d.mds_um).filter((v): v is number => v != null);
  if (vals.length < 2) return null;
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const range = max - min || 1;
  const W = 80, H = 24;
  const points = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * W;
    const y = H - ((v - min) / range) * H;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
};

// ── TGR arrow ─────────────────────────────────────────────────────────────────
const TgrArrow: React.FC<{ tgr: number | null }> = ({ tgr }) => {
  const dir = tgrDirection(tgr);
  if (dir === 'up')   return <span className="text-green-600 font-bold text-base leading-none">↑</span>;
  if (dir === 'down') return <span className="text-red-600  font-bold text-base leading-none">↓</span>;
  return                     <span className="text-gray-400 font-bold text-base leading-none">→</span>;
};

// ── SI bar ────────────────────────────────────────────────────────────────────
const SiBar: React.FC<{ si: number }> = ({ si }) => {
  // Bar centred at 1.0; range 0.5–2.5 maps to 0–100%
  const pct = Math.min(100, Math.max(0, ((si - 0.5) / 2.0) * 100));
  const midPct = ((1.0 - 0.5) / 2.0) * 100; // 25%
  const color = si <= 1.15 ? '#16a34a' : si <= 1.25 ? '#d97706' : si <= 1.4 ? '#ea580c' : '#dc2626';

  return (
    <div className="flex items-center gap-1.5 w-full">
      <span className="text-sm font-bold text-[var(--text)] tabular-nums w-8 shrink-0">
        {si.toFixed(2)}
      </span>
      <div className="relative flex-1 h-2 bg-[var(--border)] rounded-full overflow-hidden">
        {/* centre line at 1.0 */}
        <div className="absolute top-0 bottom-0 w-0.5 bg-[var(--text-tertiary)]" style={{ left: `${midPct}%` }} />
        <div
          className="absolute top-0 bottom-0 rounded-full"
          style={{ left: `${midPct}%`, width: `${Math.abs(pct - midPct)}%`, backgroundColor: color }}
        />
      </div>
    </div>
  );
};

// ── TWDnorm bar ───────────────────────────────────────────────────────────────
const TwdNormBar: React.FC<{ value: number }> = ({ value }) => {
  const pct = Math.min(100, Math.max(0, value * 100));
  const color = value < 0.5 ? '#16a34a' : value < 0.8 ? '#d97706' : value < 1.2 ? '#dc2626' : '#7f1d1d';
  return (
    <div className="flex items-center gap-1.5 w-full">
      <span className="text-sm font-bold text-[var(--text)] tabular-nums w-8 shrink-0">
        {value.toFixed(2)}
      </span>
      <div className="relative flex-1 h-2 bg-[var(--border)] rounded-full overflow-hidden">
        <div className="absolute top-0 bottom-0 rounded-full" style={{ left: 0, width: `${pct}%`, backgroundColor: color }} />
      </div>
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────────
export const DendrometerTreeCard: React.FC<Props> = ({ device, today, history, onOpenMonitor }) => {
  const baselineComplete = today?.baseline_complete === 1;
  const stress = today?.stress_level ?? 'none';
  const cfg = STRESS_CONFIG[stress];
  const hasData = today != null && today.mds_um != null;
  const borderClass = !hasData || !baselineComplete ? 'border-l-gray-300' : cfg.border;

  return (
    <div
      className={`
        bg-[var(--card)] rounded-xl border border-[var(--border)] border-l-4 shadow-sm
        flex flex-col overflow-hidden
        ${borderClass}
      `}
    >
      {/* Card header */}
      <div className="px-4 pt-4 pb-2">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex-1 min-w-0">
            <p className="font-bold text-[var(--text)] text-base leading-tight truncate">{device.name}</p>
            <p className="text-[var(--text-tertiary)] text-xs truncate">{device.deveui}</p>
          </div>
          {device.is_reference_tree === 1 && (
            <span className="shrink-0 text-xs bg-[var(--secondary-bg)] text-[var(--text-secondary)] px-2 py-0.5 rounded-full font-semibold">
              REF
            </span>
          )}
        </div>
        {baselineComplete
          ? <StressBadge level={stress} />
          : <span className="inline-block text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full font-semibold">Building baseline</span>
        }
      </div>

      {/* Indicators */}
      <div className="px-4 py-2 flex flex-col gap-2 flex-1">
        {!hasData ? (
          <p className="text-[var(--text-tertiary)] text-sm italic">No data yet today</p>
        ) : !baselineComplete ? (
          <>
            <p className="text-sm text-[var(--text-secondary)]">
              📊 Day {today.baseline_days ?? 0}/14 — collecting reference data
            </p>
            <p className="text-xs text-[var(--text-tertiary)]">
              Stress indicators activate after 14 days of measurements.
            </p>
            {/* MDS still useful during baseline period */}
            <Row label="MDS">
              <span className="font-bold text-[var(--text)] tabular-nums">{today.mds_um} µm</span>
            </Row>
            <Row label="TGR">
              <span className="font-bold text-[var(--text)] tabular-nums">
                {today.tgr_um != null ? (today.tgr_um >= 0 ? '+' : '') + today.tgr_um + ' µm' : '—'}
              </span>
              <TgrArrow tgr={today.tgr_um} />
            </Row>
          </>
        ) : (
          <>
            {/* Low MDS_ref warning */}
            {today.mds_max_reference_um != null && today.mds_max_reference_um < 80 && (
              <p className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1">
                ⚠ Low MDS reference ({today.mds_max_reference_um} µm) — stress precision may be limited
              </p>
            )}

            {/* MDS */}
            <Row label="MDS">
              <span className="font-bold text-[var(--text)] tabular-nums">{today.mds_um} µm</span>
            </Row>

            {/* TGR */}
            <Row label="TGR">
              <span className="font-bold text-[var(--text)] tabular-nums">
                {today.tgr_um != null ? (today.tgr_um >= 0 ? '+' : '') + today.tgr_um + ' µm' : '—'}
              </span>
              <TgrArrow tgr={today.tgr_um} />
            </Row>

            {/* TWDnorm — primary v4 stress indicator (non-reference trees only) */}
            {device.is_reference_tree !== 1 && today.twd_norm_night != null && (
              <Row label="TWDn">
                <TwdNormBar value={today.twd_norm_night} />
              </Row>
            )}

            {/* Recovery Ratio — show when there's active TWD */}
            {device.is_reference_tree !== 1 && today.recovery_ratio_smoothed != null &&
              today.twd_norm_night != null && today.twd_norm_night >= 0.5 && (
              <Row label="RR">
                <span className={`font-bold tabular-nums text-sm ${today.recovery_ratio_smoothed >= 0.8 ? 'text-green-600' : 'text-orange-600'}`}>
                  {today.recovery_ratio_smoothed.toFixed(2)}
                </span>
              </Row>
            )}

            {/* Data quality warning */}
            {today.data_quality !== 'good' && (
              <p className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1">
                ⚠ {today.data_quality === 'insufficient' ? 'Insufficient data' : 'Unreliable data'}
                {' '}({today.valid_readings_count} readings)
              </p>
            )}
          </>
        )}
      </div>

      {/* Sparkline + history button */}
      <div className="px-4 pb-4 pt-1 flex items-end justify-between border-t border-[var(--border)] mt-2 pt-3">
        <div title="MDS trend — 7 days">
          <MdsSparkline data={history} color={cfg.hex} />
          <p className="text-[9px] text-[var(--text-tertiary)] mt-0.5">MDS 7-day</p>
        </div>
        <button
          onClick={onOpenMonitor}
          className="text-xs text-[var(--primary)] hover:text-[var(--primary-hover)] font-semibold flex items-center gap-1 transition-colors"
        >
          History <span aria-hidden>→</span>
        </button>
      </div>
    </div>
  );
};

// ── Helper layout row ─────────────────────────────────────────────────────────
const Row: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="flex items-center gap-2">
    <span className="text-xs text-[var(--text-tertiary)] w-8 shrink-0">{label}</span>
    <div className="flex items-center gap-1.5 flex-1">{children}</div>
  </div>
);
