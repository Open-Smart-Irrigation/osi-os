import type {Device, IrrigationSchedule, IrrigationZone} from '../../src/types/farming';
import type {ReadingLedger, ReadingSample} from './readings';
import type {SimulationClock} from './clock';
import type {SimulatorState} from './state';
import {iso} from '../fixtures';

export type TriggerEvaluation = {
  zoneId: number;
  evaluatedAt: string;
  metric: string;
  status: 'started' | 'skipped';
  reason: string;
  value: number | string | null;
  threshold: number;
  durationMinutes: number | null;
  valveEui: string | null;
  advisory: string;
  dendroEvidence?: DendroEvaluationEvidence | null;
};

export type DendroRecommendation = {
  source: 'local' | 'dendro' | string;
  irrigation_action: string;
  zone_stress_summary: string | null;
  computed_at: string;
  action_reasoning?: string | null;
  rainfall_mm?: number | null;
  water_delivered_liters?: number | null;
  rain_suppression_active?: number | null;
  recovery_verification_active?: number | null;
  low_confidence_tree_count?: number | null;
  zone_confidence_score?: number | null;
};

export type DendroEvaluationEvidence = {
  source: string;
  computedAt: string;
  ageMs: number;
  action: string;
  actionReason: string | null;
  stress: string | null;
  rainfallMm: number | null;
  waterDeliveredLiters: number | null;
  rainSuppressionActive: boolean | null;
  recoveryVerificationActive: boolean | null;
  lowConfidenceTreeCount: number | null;
  zoneConfidenceScore: number | null;
};

export type TriggerDomainPort = {
  state: SimulatorState;
  clock: SimulationClock;
  now: number;
  zones: IrrigationZone[];
  devices: Device[];
  readings: ReadingLedger;
  evaluations: TriggerEvaluation[];
  startActuation(eui: string, durationSeconds: number, trigger: 'trigger_based', openDelayMs: number, autoClose: boolean, ruleId?: string): boolean;
  dendroCandidate(zoneId: number, at: number): {recommendation: DendroRecommendation | null; stale: boolean};
};

const STRESS_RANK: Record<string, number> = {none: 0, mild: 1, moderate: 2, significant: 3, severe: 4};
const DENDRO_ACTIONS = new Set(['decrease_20', 'decrease_10', 'maintain', 'maintain_rain_suppression',
  'maintain_recovery_hold', 'increase_10', 'increase_20', 'emergency_irrigate']);
const RESPONSE_FACTORS: Record<string, Record<string, number>> = {
  proportional: {mild: 1, moderate: 1.1, significant: 1.2, severe: 1.5},
  fixed: {mild: 1, moderate: 1, significant: 1, severe: 1},
  aggressive: {mild: 1, moderate: 1.2, significant: 1.4, severe: 2},
};

export function selectDendroRecommendation(server: DendroRecommendation | null, local: DendroRecommendation | null, now: number): DendroRecommendation | null {
  const serverAt = server ? Date.parse(server.computed_at) : NaN;
  if (server && server.source === 'dendro' && DENDRO_ACTIONS.has(server.irrigation_action) && now >= serverAt && now - serverAt <= 6 * 60 * 60 * 1000) return server;
  if (!local) return null;
  const localAt = Date.parse(local.computed_at);
  if (!Number.isFinite(localAt) || now < localAt || now - localAt > 36 * 60 * 60 * 1000) return null;
  return local;
}

export function dendroRuleDecision(schedule: IrrigationSchedule, recommendation: DendroRecommendation | null, stale = false, at = Date.now()): {
  reason: string; stress: string | null; durationMinutes: number | null; advisory: string; evidence: DendroEvaluationEvidence | null;
} {
  if (!recommendation) return {reason: stale ? 'stale_dendro_recommendation' : 'no_dendro_recommendation', stress: null, durationMinutes: null, evidence: null,
    advisory: stale ? 'Simulated DENDRO decision unavailable: the latest recommendation is older than 36 hours.'
      : 'Simulated DENDRO decision unavailable: no recommendation is available.'};
  const stress = String(recommendation.zone_stress_summary ?? '').toLowerCase();
  const computedAt = Date.parse(recommendation.computed_at);
  const evidence: DendroEvaluationEvidence = {source: recommendation.source, computedAt: recommendation.computed_at,
    ageMs: Number.isFinite(computedAt) ? Math.max(0, at - computedAt) : 0, action: recommendation.irrigation_action,
    actionReason: recommendation.action_reasoning ?? null, stress: stress || null,
    rainfallMm: recommendation.rainfall_mm ?? null, waterDeliveredLiters: recommendation.water_delivered_liters ?? null,
    rainSuppressionActive: recommendation.rain_suppression_active == null ? null : Number(recommendation.rain_suppression_active) === 1,
    recoveryVerificationActive: recommendation.recovery_verification_active == null ? null : Number(recommendation.recovery_verification_active) === 1,
    lowConfidenceTreeCount: recommendation.low_confidence_tree_count ?? null,
    zoneConfidenceScore: recommendation.zone_confidence_score ?? null};
  const ageHours = evidence.ageMs / (60 * 60 * 1000);
  const actionReason = evidence.actionReason?.trim().replace(/[.。]+$/, '') ?? '';
  const localAction = evidence.source === 'dendro' ? '' : `: ${evidence.action}${actionReason ? ` — ${actionReason}` : ''}`;
  const evidenceText = `Selected ${evidence.source} recommendation at ${evidence.computedAt} (${ageHours.toFixed(1)} hours old)${localAction}. ` +
    `Stress ${evidence.stress ?? 'unknown'}; zone confidence ${evidence.zoneConfidenceScore ?? 'unknown'}; low-confidence trees ${evidence.lowConfidenceTreeCount ?? 'unknown'}; ` +
    `rain ${evidence.rainfallMm == null ? 'unknown' : `${evidence.rainfallMm} mm`}; rain suppression ${evidence.rainSuppressionActive == null ? 'unknown' : evidence.rainSuppressionActive ? 'active' : 'inactive'}; ` +
    `recovery verification ${evidence.recoveryVerificationActive == null ? 'unknown' : evidence.recoveryVerificationActive ? 'active' : 'inactive'}. ` +
    (evidence.source === 'dendro'
      ? `Selected source advisory: ${evidence.action}${actionReason ? ` — ${actionReason}` : ''}. `
      : 'Source analytics advisory unavailable: the selected recommendation does not include the required source history and controller state. ');
  const rank = STRESS_RANK[stress];
  if (rank === undefined) return {reason: 'unknown_dendro_stress', stress: null, durationMinutes: null,
    evidence, advisory: `${evidenceText} Simulator opening skipped because selected stress is unknown.`};
  if (schedule.threshold_kpa < 1 || schedule.threshold_kpa > 4 || !Number.isInteger(schedule.threshold_kpa)) {
    return {reason: 'invalid_dendro_threshold', stress, durationMinutes: null, evidence,
      advisory: `${evidenceText} Simulated DENDRO ${stress} stress cannot use saved sensitivity ${schedule.threshold_kpa}.`};
  }
  if (rank < schedule.threshold_kpa) return {reason: 'below_dendro_sensitivity', stress, durationMinutes: null, evidence,
    advisory: `${evidenceText} Simulated DENDRO ${stress} stress is below sensitivity ${schedule.threshold_kpa}.`};
  const responseMode = String(schedule.response_mode ?? 'proportional').toLowerCase();
  const factor = RESPONSE_FACTORS[responseMode]?.[stress];
  if (factor === undefined) return {reason: 'invalid_response_mode', stress, durationMinutes: null, evidence,
    advisory: `${evidenceText} Simulated DENDRO ${stress} stress has unsupported response mode ${responseMode}.`};
  const base = Number(schedule.duration_minutes ?? 20);
  const durationMinutes = Math.min(240, Math.max(1, Math.round(base * factor)));
  return {reason: 'threshold_met', stress, durationMinutes, evidence,
    advisory: `${evidenceText} Illustrative simulator rule: ${stress} DENDRO stress met sensitivity ${schedule.threshold_kpa}; ${responseMode} response gives ${durationMinutes} minutes.`};
}

function swtField(metric: string): string | null {
  if (metric === 'SWT_1' || metric === 'SWT_WM1') return 'swt_1';
  if (metric === 'SWT_2' || metric === 'SWT_WM2') return 'swt_2';
  if (metric === 'SWT_3') return 'swt_3';
  return null;
}

function eligibleSwtDevice(device: Device, sample: ReadingSample): boolean {
  if (sample.values.watermark !== null && typeof sample.values.watermark === 'object') return false;
  if (device.type_id === 'KIWI_SENSOR' || device.type_id === 'TEKTELIC_CLOVER' || device.type_id === 'DRAGINO_SDI12') return true;
  if (device.type_id !== 'DRAGINO_LSN50') return false;
  const fields = device as Device & Record<string, unknown>;
  const mode = String(fields.lsn50_mode ?? fields.lsn50_mode_label ?? device.latest_data.lsn50_mode_label ?? '');
  return fields.chameleon_enabled === 1 && (mode === 'MOD3' || Number(mode) === 3);
}

function swtMean(port: TriggerDomainPort, zoneId: number, metric: string, at: number): number | null {
  const from = at - 60 * 60 * 1000;
  const rows: number[] = [];
  for (const device of port.devices) {
    if (device.irrigation_zone_id !== zoneId) continue;
    for (const sample of port.readings.between(device.deveui, from, at)) {
      if (!eligibleSwtDevice(device, sample)) continue;
      let point: number | null = null;
      if (metric === 'SWT_AVG') {
        const values = ['swt_1', 'swt_2', 'swt_3'].map((field, index) => {
          const value = sample.values[field] ?? (index === 0 ? sample.values.swt_wm1 : index === 1 ? sample.values.swt_wm2 : null);
          return typeof value === 'number' && Number.isFinite(value) ? value : null;
        }).filter((value): value is number => value !== null);
        if (values.length) point = values.reduce((sum, value) => sum + value, 0) / values.length;
      } else {
        const field = swtField(metric);
        if (!field) continue;
        const value = sample.values[field] ?? (field === 'swt_1' ? sample.values.swt_wm1 : field === 'swt_2' ? sample.values.swt_wm2 : null);
        if (typeof value === 'number' && Number.isFinite(value)) point = value;
      }
      if (point !== null) rows.push(point);
    }
  }
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
}

function oldestValve(port: TriggerDomainPort, zoneId: number): Device | undefined {
  const createdAt = (device: Device) => Date.parse(String((device as Device & Record<string, unknown>).created_at ?? ''));
  return port.devices.filter(device => device.type_id === 'STREGA_VALVE' && device.irrigation_zone_id === zoneId)
    .sort((a, b) => createdAt(a) - createdAt(b) || a.deveui.localeCompare(b.deveui))[0];
}

function record(port: TriggerDomainPort, entry: TriggerEvaluation) {
  port.evaluations.unshift(entry);
  if (port.evaluations.length > 100) port.evaluations.length = 100;
}

function hasSameUtcDay(previous: string | null | undefined, at: number): boolean {
  return !!previous && new Date(previous).toISOString().slice(0, 10) === new Date(at).toISOString().slice(0, 10);
}

export function evaluateAutomaticTriggers(port: TriggerDomainPort, at: number): void {
  for (const zone of port.zones) {
    const schedule = zone.schedule;
    if (!schedule?.enabled) continue;
    const metric = String(schedule.trigger_metric ?? '').toUpperCase();
    let value: number | string | null = null;
    let durationMinutes: number | null = null;
    let dendroEvidence: DendroEvaluationEvidence | null = null;
    let reason = 'no_data_last_hour';
    let advisory = `Simulated ${metric} evaluation has no eligible measurement in the last hour.`;

    if (metric === 'DENDRO') {
      const candidate = port.dendroCandidate(zone.id, at);
      const decision = dendroRuleDecision(schedule, candidate.recommendation, candidate.stale, at);
      ({reason, stress: value, durationMinutes, advisory} = decision);
      dendroEvidence = decision.evidence;
    } else {
      value = swtMean(port, zone.id, metric, at);
      if (value !== null) {
        reason = value >= schedule.threshold_kpa ? 'threshold_met' : 'below_threshold';
        advisory = `Simulated ${metric} mean ${value.toFixed(1)} kPa ${reason === 'threshold_met' ? 'met' : 'was below'} threshold ${schedule.threshold_kpa} kPa.`;
        if (reason === 'threshold_met') durationMinutes = Math.min(240, Math.max(1, Math.round(Number(schedule.duration_minutes ?? 20))));
      }
    }

    let valve: Device | undefined;
    if (reason === 'threshold_met') {
      valve = oldestValve(port, zone.id);
      if (!valve) reason = 'missing_valve';
      else if (hasSameUtcDay(schedule.last_triggered_at, at)) reason = 'same_logical_window';
      else if (port.state.activeCommands.has(valve.deveui) || port.state.timedCloseHolds.has(valve.deveui)) reason = 'busy';
      else if (!port.startActuation(valve.deveui, Number(durationMinutes) * 60, 'trigger_based', 2000, true, `daily-trigger:${zone.id}`)) reason = 'busy';
      else schedule.last_triggered_at = iso(at);
    }

    const started = reason === 'threshold_met';
    record(port, {zoneId: zone.id, evaluatedAt: iso(at), metric, status: started ? 'started' : 'skipped', reason,
      value, threshold: schedule.threshold_kpa, durationMinutes: started ? durationMinutes : null,
      valveEui: valve?.deveui ?? null, advisory: reason === 'missing_valve'
        ? `${advisory} Simulated ${metric} condition was met, but this zone has no assigned valve.`
        : reason === 'busy' ? `${advisory} Simulated ${metric} condition was met, but ${valve?.name ?? 'the valve'} already has an active owner.`
        : reason === 'same_logical_window' ? `${advisory} Skipped because this rule already triggered on the same UTC date.` : advisory,
      dendroEvidence: metric === 'DENDRO' ? dendroEvidence : null});
  }
}
