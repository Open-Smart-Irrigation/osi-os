import type {Device} from '../../src/types/farming';
import type {ReadingLedger} from './readings';
import {iso} from '../fixtures';

function dateAt(at: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(new Date(at));
  const row = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${row.year}-${row.month}-${row.day}`;
}
function shiftDate(day: string, amount: number): string {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + amount)).toISOString().slice(0, 10);
}
function midnight(day: string, timezone: string): number {
  const base = Date.parse(`${day}T00:00:00Z`);
  const fmt = new Intl.DateTimeFormat('en-CA', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
  for (let at = base - 18 * 3600000; at < base + 30 * 3600000; at += 60000) {
    const parts = Object.fromEntries(fmt.formatToParts(new Date(at)).map(part => [part.type, part.value]));
    if (`${parts.year}-${parts.month}-${parts.day}` === day && parts.hour === '00' && parts.minute === '00') return at;
  }
  throw new RangeError(`Could not resolve midnight for ${day} ${timezone}`);
}
export function dailyRainHistory(device: Device, ledger: ReadingLedger, now: number, days: number, timezone: string, timezoneBasis?: string) {
  const length = Math.min(90, Math.max(1, Math.floor(days) || 7));
  const current = dateAt(now, timezone);
  const rows = Array.from({length}, (_, index) => {
    const day = shiftDate(current, index - length + 1), start = midnight(day, timezone);
    const end = index === length - 1 ? now : midnight(shiftDate(day, 1), timezone) - 1;
    const samples = ledger.between(device.deveui, start, end).filter(sample => typeof sample.values.rain_mm_delta === 'number');
    const total = samples.length ? Number(samples.reduce((sum, sample) => sum + Number(sample.values.rain_mm_delta), 0).toFixed(2)) : null;
    return {day, period_start: iso(start), period_end: iso(end), total_mm: total, samples: samples.length,
      quality: samples.length ? 'received_only' : 'unknown', so_far: index === length - 1};
  });
  return {version: 2, timezone, timezone_basis: timezoneBasis ?? (device.irrigation_zone_id == null ? 'unassigned_default' : 'zone'),
    period_start: rows[0]?.period_start ?? null, period_end: rows.length ? rows[rows.length - 1].period_end : null, days: rows};
}

export function sensorHistory(device: Device, ledger: ReadingLedger, now: number, field: string, hours: number) {
  return ledger.between(device.deveui, now - Math.min(2160, Math.max(1, hours)) * 3600000, now)
    .filter(sample => sample.values[field] === null || typeof sample.values[field] === 'number')
    .map(sample => ({t: iso(sample.at), value: sample.values[field] as number | null}));
}
export function dendroHistory(device: Device, ledger: ReadingLedger, now: number, hours: number) {
  return ledger.between(device.deveui, now - Math.min(2160, Math.max(1, hours)) * 3600000, now)
    .map(sample => ({t: iso(sample.at), position_raw_mm: numberOrNull(sample.values.dendro_position_raw_mm),
      position_mm: numberOrNull(sample.values.dendro_position_mm), delta_mm: numberOrNull(sample.values.dendro_delta_mm),
      stem_change_um: numberOrNull(sample.values.dendro_stem_change_um), valid: Number(sample.values.dendro_valid ?? 0)}));
}
export function dendroRawReadings(device: Device, ledger: ReadingLedger, from: number, to: number) {
  return ledger.between(device.deveui, from, to).map((sample, index) => ({id: index + 1, deveui: device.deveui,
    position_um: numberOrNull(sample.values.dendro_position_mm) === null ? null : Number(sample.values.dendro_position_mm) * 1000,
    position_raw_um: numberOrNull(sample.values.dendro_position_raw_mm) === null ? null : Number(sample.values.dendro_position_raw_mm) * 1000,
    adc_v: numberOrNull(sample.values.adc_ch0v), adc_ch0v: numberOrNull(sample.values.adc_ch0v), adc_ch1v: numberOrNull(sample.values.adc_ch1v),
    dendro_ratio: numberOrNull(sample.values.dendro_ratio), dendro_mode_used: sample.values.dendro_mode_used ?? null,
    bat_v: numberOrNull(sample.values.bat_v), is_valid: Number(sample.values.dendro_valid ?? 0), is_outlier: 0,
    dendro_saturated: Number(sample.values.dendro_saturated ?? 0), dendro_saturation_side: sample.values.dendro_saturation_side ?? null,
    recorded_at: iso(sample.at)}));
}
export function dendroDailyIndicators(device: Device, ledger: ReadingLedger, now: number, days: number, timezone: string) {
  const count = Math.min(90, Math.max(1, Math.floor(days) || 7));
  const start = now - count * 86400000;
  const groups = new Map<string, Array<{at: number; position: number}>>();
  for (const sample of ledger.between(device.deveui, start, now)) {
    const position = numberOrNull(sample.values.dendro_position_mm);
    if (position === null || Number(sample.values.dendro_valid ?? 1) === 0) continue;
    const date = dateAt(sample.at, timezone), rows = groups.get(date) ?? [];
    rows.push({at: sample.at, position}); groups.set(date, rows);
  }
  const endDate = dateAt(now, timezone);
  const rows = Array.from({length: count}, (_, index) => {
    const date = shiftDate(endDate, index - count + 1), samples = groups.get(date) ?? [];
    const positions = samples.map(sample => sample.position);
    const max = positions.length ? Math.max(...positions) : null, min = positions.length ? Math.min(...positions) : null;
    const mds = max === null || min === null ? null : Number(((max - min) * 1000).toFixed(1));
    const stress = mds == null ? 'unknown' : mds >= 450 ? 'severe' : mds >= 300 ? 'significant' : mds >= 180 ? 'moderate' : mds >= 80 ? 'mild' : 'none';
    return {id: index + 1, deveui: device.deveui, date, d_max_um: max === null ? null : max * 1000,
      d_min_um: min === null ? null : min * 1000, mds_um: mds, tgr_um: null, tgr_smoothed_um: null, twd_um: null,
      dr_um: null, recovery_delta_um: null, signal_intensity: null, twd_night_um: null, twd_day_um: null,
      twd_norm_night: null, twd_norm_day: null, mds_norm: null, recovery_ratio: null, recovery_ratio_smoothed: null,
      r_delta_5day: null, delta_twd_smoothed: null, d_max_running_um: max === null ? null : max * 1000,
      d_max_time: samples.length ? new Intl.DateTimeFormat('en-GB', {timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(new Date(samples[0].at)) : null,
      d_min_time: null, twd_episode_active: 0, twd_episode_start: null, twd_episode_max_um: null,
      envelope_ref_um: null, twd_method: 'fictional_ledger_range', confidence_score: samples.length ? 0.7 : null,
      qa_flags_json: null, low_confidence_day: samples.length < 4 ? 1 : 0, tree_state_v5: stress,
      baseline_complete: 0, baseline_days: null, mds_max_reference_um: null, stress_level: stress,
      data_quality: samples.length ? 'reduced' : 'insufficient', valid_readings_count: samples.length, computed_at: iso(now)};
  });
  return rows;
}
export function zoneRecommendations(zoneId: number, devices: Device[], ledger: ReadingLedger, now: number, days: number, timezone: string,
  rainSource?: Device, flowSource?: Device, treeCohort?: Device[]) {
  const trees = treeCohort ?? zoneDendroCohort(zoneId, devices);
  if (!trees.length) return [];
  const indicator = dendroDailyIndicators(trees[0], ledger, now, days, timezone);
  return indicator.map((row, index) => {
    const start = midnight(row.date, timezone), end = Math.min(now, midnight(shiftDate(row.date, 1), timezone) - 1);
    const rainfall = rainSource ? ledger.aggregate(rainSource.deveui, 'rain_mm_delta', start, end) : null;
    const delivered = flowSource ? ledger.aggregate(flowSource.deveui, 'flow_liters_delta', start, end) : null;
    return {id: index + 1, zone_id: zoneId, date: row.date,
    zone_stress_summary: row.stress_level, rainfall_mm: rainfall ?? 0, water_delivered_liters: delivered ?? 0,
    irrigation_action: row.stress_level === 'severe' || row.stress_level === 'significant' ? 'increase_10' : 'maintain',
    action_reasoning: `Fictional ${row.stress_level} tree signal from ${trees.length} reference-cohort tree(s), ${row.valid_readings_count} ledger samples, ${rainfall ?? 0} mm rain and ${delivered ?? 0} L irrigation; illustrative public-simulator rule.`,
    recommendation_json: null, diagnostics: null, computed_at: iso(now), rain_suppression_active: 0,
    recovery_verification_active: 0, vpd_max_kpa: null, vpd_source: 'unavailable', usable_tree_count: trees.length,
    low_confidence_tree_count: Number(row.low_confidence_day), outlier_filtered_tree_count: 0, zone_confidence_score: row.confidence_score};
  });
}

export function zoneDendroCohort(zoneId: number, devices: Device[]): Device[] {
  const zoneTrees = devices.filter(device => device.irrigation_zone_id === zoneId && device.dendro_enabled === 1);
  return zoneTrees.some(device => device.is_reference_tree === 1)
    ? zoneTrees.filter(device => device.is_reference_tree === 1) : zoneTrees;
}

export function zoneRecommendationEvidence(zoneId: number, devices: Device[], ledger: ReadingLedger, now: number, days: number, timezone: string,
  rainSource?: Device, flowSource?: Device) {
  const cohort = zoneDendroCohort(zoneId, devices);
  const recommendations = zoneRecommendations(zoneId, devices, ledger, now, days, timezone, rainSource, flowSource, cohort);
  // zoneRecommendations derives the visible local indicator from this cohort's first tree.
  // Keep the freshness timestamp paired with that same input instead of rescanning an unrelated tree.
  const evidenceTree = cohort[0];
  const points = evidenceTree ? ledger.forDevice(evidenceTree.deveui).filter(sample => sample.at <= now &&
    Number(sample.values.dendro_valid ?? 1) !== 0 && typeof sample.values.dendro_position_mm === 'number') : [];
  const latestMeasurementAt = points.length ? points[points.length - 1]!.at : null;
  return {cohort, evidenceTree, recommendations, recommendation: recommendations.length ? recommendations[recommendations.length - 1]! : null,
    latestMeasurementAt, stale: latestMeasurementAt !== null && now - latestMeasurementAt > 36 * 60 * 60 * 1000};
}
function numberOrNull(value: unknown): number | null { return typeof value === 'number' ? value : null; }
