import React from 'react';
import { DendrometerSection } from 'open-smart-irrigation';

// DendrometerSection fetches /api/dendrometer/<deveui>/daily per device and
// /api/irrigation-zones/<id>/recommendations. The shim's defaults return []
// — push shape-complete canned rows first (custom routes win). Rows are
// newest-first, exactly as the edge API returns them.
const dayStr = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

// Newest-first DendroDaily rows; twdNorms is oldest → newest for readability.
const mkDaily = (deveui: string, twdNorms: number[], todayOver: Record<string, unknown> = {}) =>
  twdNorms.map((v, i) => {
    const daysAgo = twdNorms.length - 1 - i;
    return {
      id: 5000 + i, deveui, date: dayStr(daysAgo),
      d_max_um: 12480, d_min_um: 12315, mds_um: 168, tgr_um: 24, twd_um: 38,
      twd_night_um: Math.round(v * 180), twd_norm_night: v, twd_norm_day: v + 0.6,
      mds_norm: 0.9, recovery_ratio: 0.93, recovery_ratio_smoothed: 0.92,
      d_max_running_um: 12512, twd_episode_active: 0,
      tree_state_v5: v < 0.3 ? 'none' : v < 0.7 ? 'mild' : v < 1.0 ? 'moderate' : v < 1.5 ? 'significant' : 'severe',
      stress_level: v < 0.3 ? 'none' : v < 0.7 ? 'mild' : 'moderate',
      baseline_complete: 1, baseline_days: 14, mds_max_reference_um: 180,
      data_quality: 'good', valid_readings_count: 94, low_confidence_day: 0,
      confidence_score: 0.9, computed_at: new Date().toISOString(),
      ...(daysAgo === 0 ? todayOver : {}),
    };
  }).reverse();

const rec = (daysAgo: number, over: Record<string, unknown> = {}) => ({
  id: 900 - daysAgo, zone_id: 31, date: dayStr(daysAgo),
  zone_stress_summary: 'none', rainfall_mm: 0, water_delivered_liters: 320,
  irrigation_action: 'maintain',
  action_reasoning: 'Zone TWDnorm 0.31 within target band; recovery ratio 92% — no change needed.',
  recommendation_json: null, computed_at: new Date().toISOString(),
  rain_suppression_active: 0, recovery_verification_active: 0,
  vpd_max_kpa: 1.84, vpd_source: 'local_sensor',
  usable_tree_count: 2, low_confidence_tree_count: 0,
  outlier_filtered_tree_count: 0, zone_confidence_score: 0.91,
  ...over,
});

const routes: Array<[RegExp, unknown]> = [
  // Zone 31 — healthy orchard block
  [/^\/api\/dendrometer\/A84041D20A0031A1\/daily/, mkDaily('A84041D20A0031A1', [0.34, 0.3, 0.27, 0.22, 0.25, 0.2, 0.22, 0.19])],
  [/^\/api\/dendrometer\/A84041D20A0031A2\/daily/, mkDaily('A84041D20A0031A2', [0.4, 0.38, 0.33, 0.35, 0.3, 0.31, 0.28, 0.26], { mds_um: 152, tgr_um: 29 })],
  [/^\/api\/dendrometer\/A84041D20A0031A9\/daily/, mkDaily('A84041D20A0031A9', [0.3, 0.32, 0.29, 0.33, 0.3, 0.28, 0.31, 0.3])],
  [/^\/api\/irrigation-zones\/31\/recommendations/, [
    rec(0), rec(1), rec(2, { zone_stress_summary: 'mild' }), rec(3),
    rec(4, { zone_stress_summary: 'mild', rainfall_mm: 3.2 }), rec(5), rec(6),
  ]],
  // Zone 32 — escalating stress, emergency advisory
  [/^\/api\/dendrometer\/A84041D20A0032B1\/daily/, mkDaily('A84041D20A0032B1', [0.55, 0.68, 0.84, 1.02, 1.21, 1.38, 1.49, 1.58], {
    tree_state_v5: 'severe', stress_level: 'severe', mds_um: 214, tgr_um: -31,
    recovery_ratio_smoothed: 0.27, twd_episode_active: 1, twd_episode_max_um: 402,
    twd_episode_start: dayStr(6), mds_norm: 0.41,
  })],
  [/^\/api\/dendrometer\/A84041D20A0032B2\/daily/, mkDaily('A84041D20A0032B2', [0.44, 0.52, 0.66, 0.79, 0.9, 1.04, 1.12, 1.19], {
    tree_state_v5: 'significant', stress_level: 'significant', mds_um: 187, tgr_um: -12,
    recovery_ratio_smoothed: 0.44, mds_norm: 0.55,
    data_quality: 'reduced', valid_readings_count: 47, low_confidence_day: 1,
  })],
  [/^\/api\/irrigation-zones\/32\/recommendations/, [
    rec(0, {
      zone_id: 32, zone_stress_summary: 'severe', irrigation_action: 'emergency_irrigate',
      action_reasoning: 'Zone TWDnorm 1.39, recovery ratio 34%, no rain in 72 h — irrigate immediately.',
      vpd_max_kpa: 3.12, vpd_source: 'open_meteo', water_delivered_liters: 0,
      usable_tree_count: 2, low_confidence_tree_count: 1, zone_confidence_score: 0.55,
    }),
    rec(1, { zone_id: 32, zone_stress_summary: 'severe', irrigation_action: 'increase_20' }),
    rec(2, { zone_id: 32, zone_stress_summary: 'significant', irrigation_action: 'increase_20' }),
    rec(3, { zone_id: 32, zone_stress_summary: 'significant', irrigation_action: 'increase_10' }),
    rec(4, { zone_id: 32, zone_stress_summary: 'moderate', irrigation_action: 'increase_10' }),
    rec(5, { zone_id: 32, zone_stress_summary: 'moderate', irrigation_action: 'maintain' }),
    rec(6, { zone_id: 32, zone_stress_summary: 'mild', irrigation_action: 'maintain' }),
  ]],
  // Zone 33 — first week after install: baseline still building, no recs yet
  [/^\/api\/dendrometer\/A84041D20A0033C1\/daily/, mkDaily('A84041D20A0033C1', [0, 0, 0, 0, 0], {
    mds_um: 142, tgr_um: 18,
  }).map(r => ({ ...r, baseline_complete: 0, baseline_days: 7, mds_max_reference_um: null, twd_norm_night: null, twd_norm_day: null, mds_norm: null, recovery_ratio: null, recovery_ratio_smoothed: null, tree_state_v5: 'unknown', stress_level: 'unknown' }))],
  [/^\/api\/dendrometer\/A84041D20A0033C2\/daily/, mkDaily('A84041D20A0033C2', [0, 0, 0, 0, 0], {
    mds_um: 129, tgr_um: 24,
  }).map(r => ({ ...r, baseline_complete: 0, baseline_days: 5, mds_max_reference_um: null, twd_norm_night: null, twd_norm_day: null, mds_norm: null, recovery_ratio: null, recovery_ratio_smoothed: null, tree_state_v5: 'unknown', stress_level: 'unknown' }))],
  [/^\/api\/irrigation-zones\/33\/recommendations/, []],
];
((window as any).__dsApiRoutes ??= []).push(...routes);

const zone = (id: number, name: string) => ({
  id, name, device_count: 3,
  created_at: '2026-03-01T00:00:00.000Z', updated_at: new Date().toISOString(),
  schedule: null, crop_type: 'apple',
}) as any;

const tree = (deveui: string, name: string, isRef = 0) => ({
  deveui, name, type_id: 'DRAGINO_LSN50', dendro_enabled: 1,
  is_reference_tree: isRef,
  last_seen: new Date(Date.now() - 11 * 60_000).toISOString(),
  latest_data: { ext_temperature_c: 23.1, bat_v: 3.59 },
}) as any;

// The section mounts collapsed (internal useState). Click its chevron after
// mount — two passes, since data arrives async from the shim.
function AutoExpand({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const clickCollapsedToggles = () => {
      const spans = ref.current?.querySelectorAll('button span[style*="rotate(-90deg)"]') ?? [];
      spans.forEach((s) => (s as HTMLElement).closest('button')?.click());
    };
    clickCollapsedToggles();
    const t = setTimeout(clickCollapsedToggles, 60);
    return () => clearTimeout(t);
  }, []);
  return <div ref={ref}>{children}</div>;
}

const W = { maxWidth: 860 };

// Healthy block: maintain banner + 7-day dots, high-confidence pill, zone
// averages card, tree grid, summary row. Two trees keep the grid to one row
// so the whole section fits the 900x700 capture frame.
export function HealthyOrchard() {
  return (
    <div style={W}>
      <AutoExpand>
        <DendrometerSection
          zone={zone(31, 'Orchard — Block A')}
          devices={[
            tree('A84041D20A0031A1', 'Gala — Tree 12'),
            tree('A84041D20A0031A2', 'Gala — Tree 18'),
          ]}
          predictionAdvisoryEnabled
        />
      </AutoExpand>
    </div>
  );
}

// Drought escalation: emergency banner with worsening dots, low-confidence
// pill, red zone averages, severe tree with episode + quality warnings.
export function StressEmergency() {
  return (
    <div style={W}>
      <AutoExpand>
        <DendrometerSection
          zone={zone(32, 'Orchard — Block C (south slope)')}
          devices={[
            tree('A84041D20A0032B1', 'Braeburn — Tree 4'),
            tree('A84041D20A0032B2', 'Braeburn — Tree 7'),
          ]}
          predictionAdvisoryEnabled
        />
      </AutoExpand>
    </div>
  );
}

// Fresh install: no recommendations yet (analytics banner), amber baseline
// pill, tree cards showing day 7/14 and 5/14 progress.
export function BaselineBuilding() {
  return (
    <div style={W}>
      <AutoExpand>
        <DendrometerSection
          zone={zone(33, 'New planting — Fuji rows')}
          devices={[
            tree('A84041D20A0033C1', 'Fuji — Tree 21'),
            tree('A84041D20A0033C2', 'Fuji — Tree 22'),
          ]}
          predictionAdvisoryEnabled
        />
      </AutoExpand>
    </div>
  );
}
