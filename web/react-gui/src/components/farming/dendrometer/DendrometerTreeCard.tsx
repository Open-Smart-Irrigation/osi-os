import React from 'react';
import type { Device, DendroDaily } from '../../../types/farming';
import { STRESS_CONFIG } from './stressConfig';
import { StressBadge } from './StressBadge';

interface Props {
  device: Device;
  /** Latest computed daily indicators (may be absent if compute hasn't run yet today) */
  today: DendroDaily | null;
  /** Previous 7 days for sparkline (oldest first) */
  history: DendroDaily[];
  onOpenMonitor: () => void;
}

// ── Sparkline (TWDnorm-night, 7 days) ─────────────────────────────────────────
const TwdSparkline: React.FC<{ data: DendroDaily[]; color: string }> = ({ data, color }) => {
  const vals = data.map(d => d.twd_norm_night ?? d.twd_norm_day).filter((v): v is number => v != null);
  if (vals.length < 2) return null;
  const min = 0;
  const max = Math.max(1.5, Math.max(...vals));
  const range = max - min || 1;
  const W = 80, H = 24;
  const points = vals.map((v, i) => {
    const x = (i / (vals.length - 1)) * W;
    const y = H - ((v - min) / range) * H;
    return `${x},${y}`;
  }).join(' ');

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="overflow-visible">
      {/* reference line at 1.0 (moderate stress) */}
      <line x1={0} y1={H - (1.0 / max) * H} x2={W} y2={H - (1.0 / max) * H}
        stroke="#e5e7eb" strokeWidth="1" strokeDasharray="3,2" />
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

// ── TWDnorm bar ───────────────────────────────────────────────────────────────
const TwdNormBar: React.FC<{ value: number }> = ({ value }) => {
  const pct = Math.min(100, Math.max(0, (value / 1.5) * 100));
  const color = value < 0.3 ? '#16a34a' : value < 0.7 ? '#d97706' : value < 1.0 ? '#ea580c' : value < 1.5 ? '#dc2626' : '#7f1d1d';
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

// ── Recovery ratio bar ────────────────────────────────────────────────────────
const RecoveryRatioBar: React.FC<{ value: number }> = ({ value }) => {
  const pct = Math.min(100, Math.max(0, value * 100));
  const color = value >= 0.8 ? '#16a34a' : value >= 0.5 ? '#d97706' : '#dc2626';
  return (
    <div className="flex items-center gap-1.5 w-full">
      <span className="text-sm font-bold tabular-nums w-8 shrink-0" style={{ color }}>
        {(value * 100).toFixed(0)}%
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
  const stress = today?.tree_state_v5 ?? today?.stress_level ?? 'none';
  const cfg = STRESS_CONFIG[stress] ?? STRESS_CONFIG.none;
  const hasData = today != null;
  const borderClass = !hasData || !baselineComplete ? 'border-l-gray-300' : cfg.border;

  // Use v5 tree_state_v5 if available, else fall back to stress_level
  const displayStress = today?.tree_state_v5 ?? today?.stress_level ?? 'none';

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
          ? <StressBadge level={displayStress} />
          : <span className="inline-block text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full font-semibold">
              Building baseline — day {today?.baseline_days ?? 0}/14
            </span>
        }
      </div>

      {/* Indicators */}
      <div className="px-4 py-2 flex flex-col gap-2 flex-1">
        {!hasData ? (
          <p className="text-[var(--text-tertiary)] text-sm italic">No data yet</p>
        ) : !baselineComplete ? (
          <p className="text-xs text-[var(--text-tertiary)]">
            Stress indicators activate after baseline is complete. Raw readings visible in History.
          </p>
        ) : (
          <>
            {/* Low MDS_ref warning */}
            {today.mds_max_reference_um != null && today.mds_max_reference_um < 80 && (
              <p className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1">
                ⚠ Low reference MDS ({today.mds_max_reference_um} µm) — stress precision limited
              </p>
            )}

            {/* Water deficit (TWDnorm) — primary stress indicator */}
            {device.is_reference_tree !== 1 && today.twd_norm_night != null ? (
              <Row label="TWD">
                <TwdNormBar value={today.twd_norm_night} />
              </Row>
            ) : device.is_reference_tree !== 1 && today.twd_night_um != null ? (
              <Row label="TWD">
                <span className="font-bold text-[var(--text)] tabular-nums text-sm">{today.twd_night_um} µm</span>
              </Row>
            ) : null}

            {/* Recovery ratio — shows when tree is recovering from stress */}
            {device.is_reference_tree !== 1 && today.recovery_ratio_smoothed != null && (
              <Row label="RR">
                <RecoveryRatioBar value={today.recovery_ratio_smoothed} />
              </Row>
            )}

            {/* TWD episode info */}
            {today.twd_episode_active === 1 && today.twd_episode_max_um != null && (
              <p className="text-xs text-red-700 bg-red-50 rounded px-2 py-1">
                Episode: peak {today.twd_episode_max_um} µm
                {today.twd_episode_start ? ` since ${today.twd_episode_start.slice(5, 10)}` : ''}
              </p>
            )}

            {/* Data quality warning */}
            {today.data_quality !== 'good' && (
              <p className="text-xs text-amber-700 bg-amber-50 rounded px-2 py-1">
                ⚠ {today.data_quality === 'insufficient' ? 'Insufficient data' : 'Reduced quality'}
                {' '}({today.valid_readings_count} readings)
              </p>
            )}

            {/* Low confidence flag */}
            {today.low_confidence_day === 1 && (
              <p className="text-xs text-orange-700 bg-orange-50 rounded px-2 py-1">
                Low confidence — day excluded from zone aggregation
              </p>
            )}
          </>
        )}
      </div>

      {/* Sparkline + history button */}
      <div className="px-4 pb-4 flex items-end justify-between border-t border-[var(--border)] mt-2 pt-3">
        <div title="TWD water deficit trend — 7 days">
          <TwdSparkline data={history} color={cfg.hex} />
          <p className="text-[9px] text-[var(--text-tertiary)] mt-0.5">TWD 7-day</p>
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
