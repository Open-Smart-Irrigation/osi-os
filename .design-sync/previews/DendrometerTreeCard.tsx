import React from 'react';
import { DendrometerTreeCard } from 'open-smart-irrigation';

// Fixtures modeled on DendroDaily (types/farming.ts) — µm-scale values in the
// ranges the v5 analytics actually emits for apple orchards (MDS 100–250 µm,
// TWDnorm = TWD_night / MDS_max_reference, recovery ratio 0–1).
const day = (daysAgo: number, over: Record<string, unknown>) => ({
  id: 1000 - daysAgo,
  deveui: 'A84041B2C1D50012',
  date: new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10),
  d_max_um: 12480, d_min_um: 12315, mds_um: 165, tgr_um: 28, tgr_smoothed_um: 24,
  twd_um: 34, dr_um: 158, recovery_delta_um: -7, signal_intensity: 0.92,
  twd_night_um: 32, twd_day_um: 148, twd_norm_night: 0.18, twd_norm_day: 0.82,
  mds_norm: 0.91, recovery_ratio: 0.96, recovery_ratio_smoothed: 0.94,
  r_delta_5day: -6, delta_twd_smoothed: -4, d_max_running_um: 12512,
  d_max_time: '06:40', d_min_time: '14:20',
  twd_episode_active: 0, twd_episode_start: null, twd_episode_max_um: null,
  envelope_ref_um: 180, twd_method: 'v5_envelope', confidence_score: 0.9,
  qa_flags_json: null, low_confidence_day: 0, tree_state_v5: 'none',
  baseline_complete: 1, baseline_days: 14, mds_max_reference_um: 180,
  stress_level: 'none', data_quality: 'good', valid_readings_count: 94,
  computed_at: new Date().toISOString(),
  ...over,
}) as any;

const history = (twdNorms: number[]) =>
  twdNorms.map((v, i) => day(twdNorms.length - 1 - i, { twd_norm_night: v }));

const tree = (name: string, deveui: string, over: Record<string, unknown> = {}) => ({
  deveui,
  name,
  type_id: 'DRAGINO_LSN50',
  last_seen: new Date(Date.now() - 9 * 60_000).toISOString(),
  dendro_enabled: 1,
  latest_data: { ext_temperature_c: 23.4, bat_v: 3.61 },
  ...over,
}) as any;

const W = { width: 360 };

// Well-watered tree: green stress badge, low TWDnorm bar, high recovery ratio,
// flat 7-day sparkline.
export function HealthyTree() {
  return (
    <div style={W}>
      <DendrometerTreeCard
        device={tree('Gala — Tree 12', 'A84041B2C1D50012')}
        today={day(0, {})}
        history={history([0.32, 0.28, 0.22, 0.25, 0.19, 0.21, 0.18])}
        onOpenMonitor={() => {}}
      />
    </div>
  );
}

// Active water-deficit episode: orange badge, TWDnorm 0.86, recovery ratio
// dropping, red episode box, rising sparkline.
export function ModerateStressEpisode() {
  return (
    <div style={W}>
      <DendrometerTreeCard
        device={tree('Gala — Tree 18', 'A84041B2C1D50018')}
        today={day(0, {
          tree_state_v5: 'moderate', stress_level: 'moderate',
          twd_norm_night: 0.86, twd_night_um: 155, twd_day_um: 262, twd_norm_day: 1.46,
          recovery_ratio_smoothed: 0.55, recovery_ratio: 0.51,
          mds_um: 212, tgr_um: -12, tgr_smoothed_um: -8,
          twd_episode_active: 1, twd_episode_max_um: 210,
          twd_episode_start: new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10),
        })}
        history={history([0.25, 0.34, 0.42, 0.58, 0.71, 0.79, 0.86])}
        onOpenMonitor={() => {}}
      />
    </div>
  );
}

// Worst case: severe stress with every warning strip active — low reference
// MDS, long episode, reduced data quality, low-confidence exclusion.
export function SevereWithWarnings() {
  return (
    <div style={W}>
      <DendrometerTreeCard
        device={tree('Braeburn — Tree 4', 'A84041B2C1D50004')}
        today={day(0, {
          tree_state_v5: 'severe', stress_level: 'severe',
          twd_norm_night: 1.38, twd_night_um: 412, twd_norm_day: 1.62,
          recovery_ratio_smoothed: 0.28, recovery_ratio: 0.24,
          mds_um: 96, tgr_um: -34, mds_max_reference_um: 62,
          twd_episode_active: 1, twd_episode_max_um: 412,
          twd_episode_start: new Date(Date.now() - 9 * 86_400_000).toISOString().slice(0, 10),
          data_quality: 'reduced', valid_readings_count: 41,
          low_confidence_day: 1, confidence_score: 0.42,
        })}
        history={history([0.62, 0.78, 0.95, 1.08, 1.21, 1.3, 1.38])}
        onOpenMonitor={() => {}}
      />
    </div>
  );
}

// First two weeks after install: amber baseline pill instead of a stress
// badge, indicators suppressed, no normalized sparkline yet.
export function BuildingBaseline() {
  return (
    <div style={W}>
      <DendrometerTreeCard
        device={tree('Fuji — Tree 21', 'A84041B2C1D50021')}
        today={day(0, {
          baseline_complete: 0, baseline_days: 6, mds_max_reference_um: null,
          twd_norm_night: null, twd_norm_day: null, mds_norm: null,
          recovery_ratio: null, recovery_ratio_smoothed: null,
          tree_state_v5: 'unknown', stress_level: 'unknown',
          data_quality: 'reduced', valid_readings_count: 88,
        })}
        history={[]}
        onOpenMonitor={() => {}}
      />
    </div>
  );
}

// Unirrigated control tree: REF chip, stress badge but no TWD/RR rows (those
// only apply to monitored trees).
export function ReferenceTree() {
  return (
    <div style={W}>
      <DendrometerTreeCard
        device={tree('Gala — Ref Tree 3', 'A84041B2C1D50003', { is_reference_tree: 1 })}
        today={day(0, { tree_state_v5: 'mild', stress_level: 'mild', twd_norm_night: 0.44 })}
        history={history([0.3, 0.35, 0.31, 0.38, 0.4, 0.42, 0.44])}
        onOpenMonitor={() => {}}
      />
    </div>
  );
}
