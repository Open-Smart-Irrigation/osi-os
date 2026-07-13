import React from 'react';
import { ZoneAnalysisCard } from 'open-smart-irrigation';

// The card averages today's DendroDaily row per monitored (non-reference)
// tree. Fixtures carry the fields it reads: mds_um, tgr_um, twd_norm_night,
// mds_norm, recovery_ratio_smoothed, baseline_complete.
const today = (deveui: string, over: Record<string, unknown>) => ({
  id: 1,
  deveui,
  date: new Date().toISOString().slice(0, 10),
  mds_um: 165, tgr_um: 26, twd_norm_night: 0.31, mds_norm: 0.88,
  recovery_ratio_smoothed: 0.9, baseline_complete: 1,
  computed_at: new Date().toISOString(),
  ...over,
}) as any;

const dev = (deveui: string, name: string, isRef = 0) => ({
  deveui, name, type_id: 'DRAGINO_LSN50', dendro_enabled: 1,
  is_reference_tree: isRef, latest_data: {},
}) as any;

const rec = (over: Record<string, unknown>) => ({
  id: 900, zone_id: 31,
  date: new Date().toISOString().slice(0, 10),
  zone_stress_summary: 'none', rainfall_mm: 0, water_delivered_liters: 320,
  irrigation_action: 'maintain', action_reasoning: '', recommendation_json: null,
  diagnostics: null, computed_at: new Date().toISOString(),
  rain_suppression_active: 0, recovery_verification_active: 0,
  vpd_max_kpa: 1.84, vpd_source: 'local_sensor',
  usable_tree_count: 3, low_confidence_tree_count: 0,
  outlier_filtered_tree_count: 0, zone_confidence_score: 0.91,
  ...over,
}) as any;

const W = { maxWidth: 520 };

// Healthy zone: 3 monitored trees + 1 reference (excluded), all three
// normalized indicator rows green, VPD from the local sensor, raw MDS/TGR line.
export function HealthyZoneAverages() {
  const devices = [
    dev('A84041D20A0031A1', 'Gala — Tree 12'),
    dev('A84041D20A0031A2', 'Gala — Tree 18'),
    dev('A84041D20A0031A3', 'Gala — Tree 24'),
    dev('A84041D20A0031A9', 'Gala — Ref Tree 3', 1),
  ];
  const dailyMap = {
    A84041D20A0031A1: [today('A84041D20A0031A1', { twd_norm_night: 0.24, mds_norm: 0.92, recovery_ratio_smoothed: 0.95, mds_um: 158, tgr_um: 31 })],
    A84041D20A0031A2: [today('A84041D20A0031A2', { twd_norm_night: 0.35, mds_norm: 0.86, recovery_ratio_smoothed: 0.88, mds_um: 174, tgr_um: 22 })],
    A84041D20A0031A3: [today('A84041D20A0031A3', { twd_norm_night: 0.29, mds_norm: 0.9, recovery_ratio_smoothed: 0.91, mds_um: 161, tgr_um: 27 })],
    A84041D20A0031A9: [today('A84041D20A0031A9', {})],
  };
  return (
    <div style={W}>
      <ZoneAnalysisCard devices={devices} dailyMap={dailyMap} todayRec={rec({})} />
    </div>
  );
}

// Stressed zone during rain: suppression + recovery-verification badges, red
// TWDnorm bar, shrinking trunks (negative TGR), rainfall shown next to VPD.
export function StressedWithRainSuppression() {
  const devices = [
    dev('A84041D20A0032B1', 'Braeburn — Tree 4'),
    dev('A84041D20A0032B2', 'Braeburn — Tree 7'),
  ];
  const dailyMap = {
    A84041D20A0032B1: [today('A84041D20A0032B1', { twd_norm_night: 1.34, mds_norm: 0.44, recovery_ratio_smoothed: 0.31, mds_um: 218, tgr_um: -28 })],
    A84041D20A0032B2: [today('A84041D20A0032B2', { twd_norm_night: 1.08, mds_norm: 0.52, recovery_ratio_smoothed: 0.42, mds_um: 196, tgr_um: -14 })],
  };
  return (
    <div style={W}>
      <ZoneAnalysisCard
        devices={devices}
        dailyMap={dailyMap}
        todayRec={rec({
          zone_stress_summary: 'significant',
          rain_suppression_active: 1, recovery_verification_active: 1,
          rainfall_mm: 6.4, vpd_max_kpa: 2.92, vpd_source: 'open_meteo',
          usable_tree_count: 2, zone_confidence_score: 0.62,
        })}
      />
    </div>
  );
}

// Baseline still building: normalized indicators replaced by the italic
// explainer; only the raw MDS/TGR reference line is available.
export function BaselineIncomplete() {
  const devices = [
    dev('A84041D20A0033C1', 'Fuji — Tree 21'),
    dev('A84041D20A0033C2', 'Fuji — Tree 22'),
  ];
  const dailyMap = {
    A84041D20A0033C1: [today('A84041D20A0033C1', { baseline_complete: 0, twd_norm_night: null, mds_norm: null, recovery_ratio_smoothed: null, mds_um: 142, tgr_um: 18 })],
    A84041D20A0033C2: [today('A84041D20A0033C2', { baseline_complete: 0, twd_norm_night: null, mds_norm: null, recovery_ratio_smoothed: null, mds_um: 129, tgr_um: 24 })],
  };
  return (
    <div style={W}>
      <ZoneAnalysisCard devices={devices} dailyMap={dailyMap} todayRec={null} />
    </div>
  );
}
