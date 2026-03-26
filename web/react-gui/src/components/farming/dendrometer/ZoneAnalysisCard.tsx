import React from 'react';
import type { Device, DendroDaily, ZoneRecommendation } from '../../../types/farming';

interface Props {
  devices: Device[];
  dailyMap: Record<string, DendroDaily[]>;
  todayRec: ZoneRecommendation | null;
}

function avgN(vals: number[]): number | null {
  if (!vals.length) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function normBar(v: number, lo: number, hi: number, colorClass: string) {
  const pct = Math.min(100, Math.max(0, ((v - lo) / (hi - lo)) * 100));
  return (
    <div className="h-1.5 w-16 bg-[var(--border)] rounded-full overflow-hidden inline-block ml-2 align-middle">
      <div className={`h-full rounded-full ${colorClass}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export const ZoneAnalysisCard: React.FC<Props> = ({ devices, dailyMap, todayRec }) => {
  const nonRef = devices.filter(d => d.is_reference_tree !== 1);
  const todays = nonRef.map(d => (dailyMap[d.deveui ?? ''] ?? [])[0] ?? null);
  const baselineComplete = todays.some(r => r?.baseline_complete === 1);

  const mdsVals  = todays.map(r => r?.mds_um).filter((v): v is number => v != null);
  const tgrVals  = todays.map(r => r?.tgr_um).filter((v): v is number => v != null);
  const twdNVals = todays.map(r => r?.twd_norm_night).filter((v): v is number => v != null);
  const mdsNVals = todays.map(r => r?.mds_norm).filter((v): v is number => v != null);
  const rrVals   = todays.map(r => r?.recovery_ratio_smoothed).filter((v): v is number => v != null);

  if (mdsVals.length === 0) return null;

  const rainSuppressed = (todayRec?.rain_suppression_active ?? 0) === 1;
  const recoveryVerif  = (todayRec?.recovery_verification_active ?? 0) === 1;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] px-4 py-3 space-y-3">
      <p className="text-xs font-bold uppercase tracking-widest text-[var(--text-tertiary)]">
        Zone Average — today ({nonRef.length} monitored tree{nonRef.length !== 1 ? 's' : ''})
      </p>

      {/* State badges */}
      {(rainSuppressed || recoveryVerif) && (
        <div className="flex flex-wrap gap-1.5">
          {rainSuppressed && (
            <span className="text-xs bg-sky-100 text-sky-800 border border-sky-300 rounded-full px-2 py-0.5">
              🌧 Rain suppression active
            </span>
          )}
          {recoveryVerif && (
            <span className="text-xs bg-purple-100 text-purple-800 border border-purple-300 rounded-full px-2 py-0.5">
              ⏳ Recovery verification
            </span>
          )}
        </div>
      )}

      {/* VPD + Rainfall */}
      {todayRec && (todayRec.vpd_max_kpa != null || (todayRec.rainfall_mm != null && todayRec.rainfall_mm > 0)) && (
        <div className="flex gap-4 text-xs text-[var(--text-secondary)]">
          {todayRec.vpd_max_kpa != null && (
            <span>
              VPD <span className="font-semibold text-[var(--text)]">{todayRec.vpd_max_kpa.toFixed(2)} kPa</span>
              {todayRec.vpd_source && <span className="text-[var(--text-tertiary)] ml-1">({todayRec.vpd_source})</span>}
            </span>
          )}
          {todayRec.rainfall_mm != null && todayRec.rainfall_mm > 0 && (
            <span>Rain <span className="font-semibold text-[var(--text)]">{todayRec.rainfall_mm.toFixed(1)} mm</span></span>
          )}
        </div>
      )}

      {/* indicators — shown when at least one tree has baseline */}
      {baselineComplete && twdNVals.length > 0 ? (
        <div className="space-y-2">
          {(() => {
            const mean = avgN(twdNVals)!;
            const color = mean > 1.0 ? 'bg-red-500' : mean > 0.5 ? 'bg-amber-400' : 'bg-green-500';
            return (
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--text-secondary)] w-24">TWDnorm</span>
                <div className="flex items-center gap-1 flex-1 justify-end">
                  <span className="text-sm font-bold tabular-nums text-[var(--text)]">{mean.toFixed(3)}</span>
                  {normBar(mean, 0, 2, color)}
                  <span className="text-xs text-[var(--text-tertiary)] w-5">{twdNVals.length}</span>
                </div>
              </div>
            );
          })()}
          {mdsNVals.length > 0 && (() => {
            const mean = avgN(mdsNVals)!;
            const color = mean < 0.5 ? 'bg-amber-400' : mean < 0.7 ? 'bg-yellow-400' : 'bg-green-500';
            return (
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--text-secondary)] w-24">MDSnorm</span>
                <div className="flex items-center gap-1 flex-1 justify-end">
                  <span className="text-sm font-bold tabular-nums text-[var(--text)]">{mean.toFixed(3)}</span>
                  {normBar(mean, 0, 1.5, color)}
                  <span className="text-xs text-[var(--text-tertiary)] w-5">{mdsNVals.length}</span>
                </div>
              </div>
            );
          })()}
          {rrVals.length > 0 && (() => {
            const mean = avgN(rrVals)!;
            const color = mean >= 0.8 ? 'bg-green-500' : mean >= 0.5 ? 'bg-amber-400' : 'bg-red-400';
            return (
              <div className="flex items-center justify-between">
                <span className="text-xs text-[var(--text-secondary)] w-24">Rec. Ratio</span>
                <div className="flex items-center gap-1 flex-1 justify-end">
                  <span className="text-sm font-bold tabular-nums text-[var(--text)]">{(mean * 100).toFixed(0)}%</span>
                  {normBar(mean, 0, 1.2, color)}
                  <span className="text-xs text-[var(--text-tertiary)] w-5">{rrVals.length}</span>
                </div>
              </div>
            );
          })()}
        </div>
      ) : !baselineComplete && (
        <p className="text-xs text-[var(--text-tertiary)] italic">
          TWDnorm indicators available after baseline is established (14 days)
        </p>
      )}

      {/* Raw averages — secondary reference, visible in history drawer */}
      {(mdsVals.length > 0 || tgrVals.length > 0) && (
        <div className="border-t border-[var(--border)] pt-2 flex gap-6 text-[var(--text-tertiary)]">
          {mdsVals.length > 0 && (
            <span className="text-xs">
              MDS <span className="font-semibold tabular-nums text-[var(--text-secondary)]">{Math.round(avgN(mdsVals)!)} µm</span>
            </span>
          )}
          {tgrVals.length > 0 && (() => {
            const mean = avgN(tgrVals)!;
            return (
              <span className="text-xs">
                TGR{' '}
                <span className={`font-semibold tabular-nums ${mean > 0 ? 'text-green-600' : mean < 0 ? 'text-red-500' : 'text-[var(--text-secondary)]'}`}>
                  {(mean > 0 ? '+' : '') + Math.round(mean)} µm
                </span>
              </span>
            );
          })()}
        </div>
      )}
    </div>
  );
};
