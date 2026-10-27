'use strict';

const { normalizeChannel, STRESS_RANK, SWT_CHANNELS, VWC_CHANNELS } = require('./model');
const { parseInstant } = require('./timestamps');

function invalidNumber(value, kind) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return true;
  return kind === 'SWT' ? value < 0 || value > 1000000 : value < 0 || value > 100;
}

function sourceKey(source) {
  return `${String(source && source.device_eui || '').trim().toUpperCase()}:${normalizeChannel(source && source.channel)}`;
}

function deduplicatedSamples(source, condition, dueMs, windowMinutes) {
  const lower = dueMs - windowMinutes * 60 * 1000;
  const best = new Map();
  for (const sample of Array.isArray(source.samples) ? source.samples : []) {
    const atMs = parseInstant(sample && sample.at);
    if (atMs == null || atMs > dueMs || atMs < lower) continue;
    const key = String(atMs);
    const previous = best.get(key);
    const currentId = Number.isInteger(sample && sample.id) ? sample.id : -1;
    const previousId = previous && Number.isInteger(previous.id) ? previous.id : -1;
    if (!previous || currentId >= previousId) best.set(key, { ...sample, at: new Date(atMs).toISOString(), _atMs: atMs });
  }
  const sorted = [...best.values()].sort((a, b) => a._atMs - b._atMs);
  return sorted.filter((sample) => !invalidNumber(sample.value, condition.kind))
    .map(({ _atMs, ...sample }) => sample);
}

function result(status, reason, value, unit, sources) {
  return { status, reason, value: value == null ? null : value, unit: unit || null, sources: sources || [] };
}

function evaluateSoil(condition, evidence, dueMs, windowMinutes) {
  const allowed = condition.kind === 'SWT' ? SWT_CHANNELS : VWC_CHANNELS;
  const expected = condition.sources.map((source) => ({
    ...source,
    channel: normalizeChannel(source.channel),
  }));
  const provided = new Map((Array.isArray(evidence && evidence.sources) ? evidence.sources : [])
    .map((source) => [sourceKey(source), source]));
  const used = [];
  const sourceMeans = [];
  for (const selected of expected) {
    const sourceEvidence = provided.get(sourceKey(selected));
    if (!allowed.has(selected.channel) || !sourceEvidence || sourceEvidence.eligible !== true) {
      return result('UNKNOWN', sourceEvidence && sourceEvidence.reason || 'source_unavailable', null,
        condition.kind === 'SWT' ? 'kPa' : '%', used);
    }
    const samples = deduplicatedSamples(sourceEvidence, condition, dueMs, windowMinutes);
    if (!samples.length) return result('UNKNOWN', 'missing_evidence', null, condition.kind === 'SWT' ? 'kPa' : '%', used);
    const mean = samples.reduce((sum, sample) => sum + sample.value, 0) / samples.length;
    const normalized = { device_eui: selected.device_eui, channel: selected.channel, samples, mean };
    used.push(normalized);
    sourceMeans.push(mean);
  }
  const value = sourceMeans.reduce((sum, mean) => sum + mean, 0) / sourceMeans.length;
  const met = condition.kind === 'SWT' ? value >= condition.threshold_kpa : value <= condition.threshold_percent;
  const threshold = condition.kind === 'SWT' ? condition.threshold_kpa : condition.threshold_percent;
  return result(met ? 'MET' : 'NOT_MET', met ? 'threshold_met' : 'threshold_not_met', value,
    condition.kind === 'SWT' ? 'kPa' : '%', used.map((source) => ({
      device_eui: source.device_eui,
      channel: source.channel,
      mean: source.mean,
      samples: source.samples,
      threshold,
    })));
}

const KNOWN_ACTIONS = new Set([
  'decrease_20', 'decrease_10', 'maintain', 'increase_10', 'increase_20', 'emergency_irrigate',
  'maintain_recovery_hold', 'maintain_rain_suppression',
]);

function evaluateDendro(condition, evidence, dueMs) {
  const analysis = evidence && (evidence.analysis || evidence.local_analysis || evidence.raw_analysis);
  if (!analysis || typeof analysis !== 'object') return result('UNKNOWN', 'dendro_evidence_missing', null, 'stress', []);
  const computedMs = parseInstant(analysis.computed_at || analysis.computedAt);
  if (computedMs == null || computedMs > dueMs || dueMs - computedMs > 36 * 60 * 60 * 1000) {
    return result('UNKNOWN', 'dendro_evidence_stale', null, 'stress', []);
  }
  if (typeof analysis.usable_tree_count !== 'number' || !Number.isFinite(analysis.usable_tree_count)
      || !Number.isInteger(analysis.usable_tree_count) || analysis.usable_tree_count < 1) {
    return result('UNKNOWN', 'dendro_no_usable_trees', null, 'stress', []);
  }
  const stress = String(analysis.stress || analysis.zone_stress || analysis.zone_stress_summary || '').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(STRESS_RANK, stress) || stress === 'none') {
    return result('UNKNOWN', 'dendro_stress_unknown', null, 'stress', []);
  }
  const action = String(analysis.action || analysis.irrigation_action || '');
  if (!KNOWN_ACTIONS.has(action)) return result('UNKNOWN', 'dendro_action_unknown', stress, 'stress', []);
  if (action === 'maintain_recovery_hold' || action === 'maintain_rain_suppression') {
    return result('NOT_MET', action, stress, 'stress', [{ analysis }]);
  }
  const minimum = String(condition.minimum_stress || '').toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(STRESS_RANK, minimum) || minimum === 'none') {
    return result('UNKNOWN', 'dendro_threshold_unknown', stress, 'stress', [{ analysis }]);
  }
  const met = STRESS_RANK[stress] >= STRESS_RANK[minimum];
  return result(met ? 'MET' : 'NOT_MET', met ? 'stress_threshold_met' : 'stress_below_threshold', stress,
    'stress', [{ analysis }]);
}

function evaluateCondition(condition, evidence, dueAt, windowMinutes) {
  const dueMs = parseInstant(dueAt);
  if (dueMs == null) return result('UNKNOWN', 'invalid_due_at', null, null, []);
  const window = windowMinutes == null ? 60 : windowMinutes;
  if (!Number.isInteger(window) || window < 1 || window > 1440) return result('UNKNOWN', 'invalid_observation_window', null, null, []);
  if (!condition || typeof condition !== 'object') return result('UNKNOWN', 'invalid_condition', null, null, []);
  const kind = String(condition.kind || '').toUpperCase();
  if (kind === 'DENDRO') return evaluateDendro(condition, evidence, dueMs);
  if (kind !== 'SWT' && kind !== 'VWC' || !Array.isArray(condition.sources) || !condition.sources.length) {
    return result('UNKNOWN', 'invalid_condition', null, null, []);
  }
  const threshold = kind === 'SWT' ? condition.threshold_kpa : condition.threshold_percent;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold)
      || (kind === 'SWT' && (threshold <= 0 || threshold > 300))
      || (kind === 'VWC' && (threshold < 0 || threshold > 100))) {
    return result('UNKNOWN', 'invalid_condition', null, kind === 'SWT' ? 'kPa' : '%', []);
  }
  const normalized = { ...condition, kind, sources: condition.sources.map((source) => ({
    ...source, device_eui: String(source.device_eui || '').toUpperCase(), channel: normalizeChannel(source.channel),
  })) };
  return evaluateSoil(normalized, evidence, dueMs, window);
}

module.exports = { evaluateCondition, parseInstant, sourceKey, deduplicatedSamples };
