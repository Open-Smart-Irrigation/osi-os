import React, { useEffect, useState } from 'react';
import type { Device, DendroDaily, ZoneRecommendation, IrrigationZone } from '../../../types/farming';
import { dendroAnalyticsAPI } from '../../../services/api';
import { IrrigationActionBanner } from './IrrigationActionBanner';
import { DendrometerTreeCard } from './DendrometerTreeCard';
import { DendrometerMonitor } from './DendrometerMonitor';
import { STRESS_CONFIG } from './stressConfig';
import { ZoneAnalysisCard } from './ZoneAnalysisCard';

interface Props {
  zone: IrrigationZone;
  /** All devices assigned to this zone */
  devices: Device[];
}

export const DendrometerSection: React.FC<Props> = ({ zone, devices }) => {
  const [collapsed, setCollapsed] = useState(true);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState<string | null>(null);

  // daily indicators keyed by deveui
  const [dailyMap, setDailyMap]   = useState<Record<string, DendroDaily[]>>({});
  // zone recommendations (newest first)
  const [zoneRecs, setZoneRecs]   = useState<ZoneRecommendation[]>([]);
  // which device's monitor drawer is open
  const [monitorDevice, setMonitorDevice] = useState<Device | null>(null);

  const dendroDevices = devices.filter(d => d.dendro_enabled === 1);

  useEffect(() => {
    if (dendroDevices.length === 0) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const [dailyResults, recs] = await Promise.all([
          Promise.all(dendroDevices.map(d => dendroAnalyticsAPI.getDailyIndicators(d.deveui!, 30))),
          dendroAnalyticsAPI.getZoneRecommendations(zone.id, 30),
        ]);
        if (cancelled) return;

        const map: Record<string, DendroDaily[]> = {};
        dendroDevices.forEach((d, i) => {
          map[d.deveui!] = dailyResults[i];
        });
        setDailyMap(map);
        setZoneRecs(recs);
      } catch (e: any) {
        if (!cancelled) setError(e.message ?? 'Failed to load dendrometer data');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  }, [zone.id, devices.map(d => d.deveui).join(',')]);

  if (dendroDevices.length === 0) return null;

  const today     = zoneRecs[0] ?? null;
  const history7  = [...zoneRecs].reverse().slice(-7); // oldest-first for dots

  return (
    <>
      {/* Section header */}
      <div className="mt-6 border-t border-[var(--border)] pt-5">
        <button
          className="w-full flex items-center justify-between text-left group"
          onClick={() => setCollapsed(c => !c)}
        >
          <span className="text-xs font-bold uppercase tracking-widest text-[var(--text-tertiary)] group-hover:text-[var(--text)] transition-colors">
            Dendrometer Monitoring
          </span>
          <span className="text-[var(--text-tertiary)] text-sm transition-transform duration-200" style={{ display: 'inline-block', transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)' }}>
            ▾
          </span>
        </button>

        {!collapsed && (
          <div className="mt-3 flex flex-col gap-4">
            {loading && (
              <div className="flex items-center gap-2 text-sm text-[var(--text-tertiary)] py-2">
                <div className="animate-spin h-4 w-4 border-2 border-[var(--primary)] border-t-transparent rounded-full" />
                Loading analytics…
              </div>
            )}

            {error && (
              <div className="text-sm text-[var(--error-text)] bg-[var(--error-bg)] rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            {!loading && !error && (
              <>
                {/* Zone recommendation banner */}
                {today ? (
                  <IrrigationActionBanner
                    action={today.irrigation_action}
                    reasoning={today.action_reasoning}
                    history={history7.map(r => ({ date: r.date, stress: r.zone_stress_summary }))}
                  />
                ) : (
                  <NoDataBanner />
                )}

                {/* Confidence pill — after action banner */}
                <ConfidencePill
                  zoneRec={today}
                  dailyMap={dailyMap}
                  dendroDevices={dendroDevices}
                />

                {/* Zone analysis card — per-parameter averages */}
                <ZoneAnalysisCard devices={dendroDevices} dailyMap={dailyMap} todayRec={zoneRecs[0] ?? null} />

                {/* Tree grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {dendroDevices.map(device => {
                    const rows = dailyMap[device.deveui!] ?? [];
                    const todayRow    = rows[0] ?? null;
                    const sparkline   = [...rows].reverse(); // oldest-first for sparkline
                    return (
                      <DendrometerTreeCard
                        key={device.deveui}
                        device={device}
                        today={todayRow}
                        history={sparkline}
                        onOpenMonitor={() => setMonitorDevice(device)}
                      />
                    );
                  })}
                </div>

                {/* Zone summary line */}
                {today && (
                  <ZoneSummaryRow
                    stress={today.zone_stress_summary}
                    rainfall={today.rainfall_mm}
                    water={today.water_delivered_liters}
                    deviceCount={dendroDevices.length}
                  />
                )}
              </>
            )}
          </div>
        )}
      </div>

      {/* Detail drawer */}
      {monitorDevice && (
        <DendrometerMonitor
          device={monitorDevice}
          daily={dailyMap[monitorDevice.deveui!] ?? []}
          onClose={() => setMonitorDevice(null)}
        />
      )}
    </>
  );
};

// ── ConfidencePill ────────────────────────────────────────────────────────────

interface ConfidencePillProps {
  zoneRec: ZoneRecommendation | null;
  dailyMap: Record<string, DendroDaily[]>;
  dendroDevices: Device[];
}

const ConfidencePill: React.FC<ConfidencePillProps> = ({ zoneRec, dailyMap, dendroDevices }) => {
  // Check if any tree still building baseline
  const anyBaselineIncomplete = dendroDevices.some(d => {
    const rows = dailyMap[d.deveui!] ?? [];
    return rows.length > 0 && rows[0].baseline_complete !== 1;
  });

  const confidence = zoneRec?.zone_confidence_score;
  const lowConfCount = zoneRec?.low_confidence_tree_count ?? 0;
  const usableCount  = zoneRec?.usable_tree_count ?? dendroDevices.length;

  if (anyBaselineIncomplete) {
    const maxDays = Math.max(
      ...dendroDevices.map(d => {
        const rows = dailyMap[d.deveui!] ?? [];
        return rows[0]?.baseline_days ?? 0;
      })
    );
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 bg-amber-100 border border-amber-300 text-amber-800 px-2.5 py-1 rounded-full font-medium">
          <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
          Building baseline ({maxDays}/14 days)
        </span>
        <span className="text-[var(--text-tertiary)]">v3 classification active until baseline complete</span>
      </div>
    );
  }

  if (confidence != null && confidence < 0.6) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 bg-orange-100 border border-orange-300 text-orange-800 px-2.5 py-1 rounded-full font-medium">
          <span className="w-2 h-2 rounded-full bg-orange-400" />
          Low confidence ({(confidence * 100).toFixed(0)}%)
        </span>
        {lowConfCount > 0 && (
          <span className="text-[var(--text-tertiary)]">{lowConfCount} of {usableCount} trees flagged</span>
        )}
      </div>
    );
  }

  if (confidence != null && confidence >= 0.6) {
    return (
      <div className="flex items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1.5 bg-green-100 border border-green-300 text-green-800 px-2.5 py-1 rounded-full font-medium">
          <span className="w-2 h-2 rounded-full bg-green-500" />
          High confidence ({(confidence * 100).toFixed(0)}%)
        </span>
        <span className="text-[var(--text-tertiary)]">{usableCount} tree{usableCount !== 1 ? 's' : ''} used</span>
      </div>
    );
  }

  return null;
};

// ── Sub-components ────────────────────────────────────────────────────────────

const NoDataBanner: React.FC = () => (
  <div className="rounded-lg border-2 border-[var(--border)] bg-[var(--surface)] px-4 py-3 text-sm text-[var(--text-secondary)]">
    No recommendations yet — analytics run daily at 08:00 UTC.
  </div>
);

interface ZoneSummaryProps {
  stress: string;
  rainfall: number;
  water: number;
  deviceCount: number;
}

const ZoneSummaryRow: React.FC<ZoneSummaryProps> = ({ stress, rainfall, water, deviceCount }) => {
  const cfg = STRESS_CONFIG[stress as keyof typeof STRESS_CONFIG] ?? STRESS_CONFIG.none;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[var(--text-tertiary)]">
      <span>
        Zone worst stress:{' '}
        <span className={`font-semibold ${cfg.badgeText}`}>{cfg.label}</span>
      </span>
      {rainfall > 0 && <span>🌧 {rainfall.toFixed(1)} mm rain</span>}
      {water > 0    && <span>💧 {water.toFixed(0)} L delivered</span>}
      <span>{deviceCount} sensor{deviceCount !== 1 ? 's' : ''}</span>
    </div>
  );
};
