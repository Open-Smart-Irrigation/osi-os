'use strict';

const { commissionedChannels, normalizeChannel, SWT_CHANNELS, VWC_CHANNELS } = require('./model');
const { parseInstant, sourceKey } = require('./evaluate');
const { validateTensiomarkLayout } = require('../osi-sdi12-normalize');

const SAMPLE_COLUMNS = Object.freeze({
  swt_1: 'COALESCE(dd.swt_1, dd.swt_wm1)',
  swt_2: 'COALESCE(dd.swt_2, dd.swt_wm2)',
  swt_3: 'dd.swt_3',
  vwc_1: 'dd.vwc_1', vwc_2: 'dd.vwc_2', vwc_3: 'dd.vwc_3', vwc_4: 'dd.vwc_4', vwc_5: 'dd.vwc_5',
  vwc_6: 'dd.vwc_6', vwc_7: 'dd.vwc_7', vwc_8: 'dd.vwc_8', vwc_9: 'dd.vwc_9', vwc_10: 'dd.vwc_10',
});

function asInteger(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

async function all(db, sql, params) {
  if (!db || typeof db.all !== 'function') throw new TypeError('readEvidence requires a scoped database reader');
  return db.all(sql, params);
}

async function zoneIdFor(db, policy) {
  if (policy.zone_id != null) return asInteger(policy.zone_id);
  if (policy.zoneId != null) return asInteger(policy.zoneId);
  if (policy.zone_uuid) {
    const rows = await all(db, 'SELECT id FROM irrigation_zones WHERE zone_uuid = ? AND deleted_at IS NULL', [policy.zone_uuid]);
    return rows[0] ? asInteger(rows[0].id) : null;
  }
  return null;
}

function zoneMatches(device, policyZoneId) {
  return policyZoneId != null && asInteger(device && device.irrigation_zone_id) === policyZoneId;
}

function hasFault(row, selectedChannel) {
  if (['i2c_missing', 'timeout', 'temp_fault', 'id_fault', 'data_invalid', 'comp_pending']
    .some((key) => Number(row && row[key]) === 1)) return true;
  const openByChannel = { swt_1: 'ch1_open', swt_2: 'ch2_open', swt_3: 'ch3_open' };
  const selectedOpen = openByChannel[normalizeChannel(selectedChannel)];
  return selectedOpen ? Number(row && row[selectedOpen]) === 1 : false;
}

async function chameleonEligibility(db, device, dueMs, selectedChannel) {
  if (Number(device.chameleon_enabled) !== 1) return { eligible: false, reason: 'sensor_not_enabled' };
  const rows = await all(db,
    'SELECT calibration_status, i2c_missing, timeout, temp_fault, id_fault, ch1_open, ch2_open, ch3_open, data_invalid, comp_pending, recorded_at, id FROM chameleon_readings WHERE deveui = ? AND (julianday(recorded_at) <= julianday(?) OR julianday(recorded_at) IS NULL) ORDER BY CASE WHEN julianday(recorded_at) IS NULL THEN 1 ELSE 0 END DESC, julianday(recorded_at) DESC, id DESC LIMIT 1',
    [device.deveui, new Date(dueMs).toISOString()]);
  const latest = rows[0];
  if (latest && parseInstant(latest.recorded_at) == null) return { eligible: false, reason: 'invalid_health_timestamp' };
  if (!latest || latest.calibration_status !== 'calibrated') return { eligible: false, reason: 'calibration_unavailable' };
  if (hasFault(latest, selectedChannel)) return { eligible: false, reason: 'sensor_fault' };
  return { eligible: true };
}

function parseObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function tensiomarkSwtChannels(device) {
  if (String(device && device.type_id || '').trim().toUpperCase() !== 'DRAGINO_SDI12'
      || String(device && device.sdi12_probe_profile || '').trim().toUpperCase() !== 'TENSIOMARK') return null;
  const layout = parseObject(device && device.sdi12_channel_layout_json);
  const validation = validateTensiomarkLayout(layout);
  if (!validation.ok) return [];
  return validation.layout.sensors.map((sensor) => `swt_${sensor.channel}`);
}

function declaredSwtChannels(device) {
  const type = String(device && device.type_id || '').trim().toUpperCase();
  if (type === 'KIWI_SENSOR') return ['swt_1', 'swt_2'];
  const tensiomark = tensiomarkSwtChannels(device);
  if (tensiomark !== null) return tensiomark;
  return null;
}

// One authoritative source gate is shared by source-option listing, policy
// mutation validation and the due worker.  Keep this separate from sample
// collection so a caller cannot accidentally make a source eligible merely by
// selecting a device type.  A valid VWC value count (including a commissioned
// channel whose latest value is zero) is the commissioning proof; SWT requires
// the live Chameleon calibration/health gate above.
async function resolveSourceEligibility(db, source, condition, policyZoneId, dueMs) {
  const normalized = {
    device_eui: String(source && source.device_eui == null ? '' : source && source.device_eui || '').trim().toUpperCase(),
    channel: normalizeChannel(source && source.channel),
  };
  const rows = await all(db, 'SELECT * FROM devices WHERE UPPER(deveui)=UPPER(?) AND deleted_at IS NULL', [normalized.device_eui]);
  const device = rows[0];
  const result = { ...normalized, eligible: false, device: device || null };
  if (!device) return { ...result, reason: 'device_not_found' };
  if (!zoneMatches(device, policyZoneId)) return { ...result, reason: 'device_not_assigned_to_zone' };
  const kind = String(condition && condition.kind || '').toUpperCase();
  if (kind === 'VWC') {
    if (!VWC_CHANNELS.has(normalized.channel)) return { ...result, reason: 'channel_not_allowed' };
    if (device.type_id !== 'DRAGINO_SDI12' || !commissionedChannels(device).includes(normalized.channel)) {
      return { ...result, reason: 'channel_not_commissioned' };
    }
    return { ...result, eligible: true };
  }
  if (kind !== 'SWT' || !SWT_CHANNELS.has(normalized.channel)) return { ...result, reason: 'channel_not_allowed' };
  const declared = declaredSwtChannels(device);
  if (declared !== null) {
    if (!declared.includes(normalized.channel)) return { ...result, reason: declared.length ? 'channel_not_declared' : 'channel_not_commissioned' };
    return { ...result, eligible: true };
  }
  if (String(device.type_id || '').trim().toUpperCase() !== 'DRAGINO_LSN50') {
    return { ...result, reason: 'sensor_not_enabled' };
  }
  const health = await chameleonEligibility(db, device, Number.isFinite(dueMs) ? dueMs : Date.now(), normalized.channel);
  if (!health.eligible) return { ...result, reason: health.reason };
  return { ...result, eligible: true };
}

function normalizedSamples(rows, dueMs, windowMinutes) {
  const lower = dueMs - windowMinutes * 60 * 1000;
  const best = new Map();
  for (const row of rows || []) {
    const atMs = parseInstant(row.recorded_at);
    if (atMs == null || atMs > dueMs || atMs < lower) continue;
    const previous = best.get(atMs);
    if (!previous || (Number(row.id) || 0) >= (Number(previous.id) || 0)) {
      best.set(atMs, {
        id: Number.isInteger(row.id) ? row.id : null,
        at: new Date(atMs).toISOString(),
        value: row.value,
        watermark_ineligible: Number(row.watermark_ineligible) === 1,
      });
    }
  }
  return [...best.values()]
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .filter((sample) => !sample.watermark_ineligible)
    .map(({ watermark_ineligible, ...sample }) => sample);
}

async function readSoilSource(db, source, condition, policyZoneId, dueMs, windowMinutes) {
  const eligibility = await resolveSourceEligibility(db, source, condition, policyZoneId, dueMs);
  const normalized = { device_eui: eligibility.device_eui, channel: eligibility.channel };
  const device = eligibility.device;
  const result = { ...normalized, eligible: false, samples: [] };
  if (!eligibility.eligible) return { ...result, reason: eligibility.reason };

  const expression = SAMPLE_COLUMNS[normalized.channel];
  if (!expression) return { ...result, reason: 'channel_not_allowed' };
  const samples = await all(db,
    `SELECT dd.id, dd.deveui, dd.recorded_at, ${expression} AS value,
      CASE WHEN EXISTS (SELECT 1 FROM watermark_readings wr WHERE wr.device_data_id = dd.id) THEN 1 ELSE 0 END AS watermark_ineligible
      FROM device_data dd
      WHERE dd.deveui = ? AND julianday(dd.recorded_at) >= julianday(?) AND julianday(dd.recorded_at) <= julianday(?)`,
    [normalized.device_eui, new Date(dueMs - windowMinutes * 60 * 1000).toISOString(), new Date(dueMs).toISOString()]);
  return { ...result, eligible: true, samples: normalizedSamples(samples, dueMs, windowMinutes) };
}

function rawAnalysisFromRecommendation(row) {
  if (!row || typeof row.recommendation_json !== 'string') return null;
  let parsed;
  try { parsed = JSON.parse(row.recommendation_json); } catch (_) { return null; }
  const rawEvidence = parsed.raw_evidence || parsed.rawEvidence;
  const rawDecision = parsed.raw_decision || parsed.rawDecision;
  if (!rawEvidence || !rawDecision) return null;
  const analysis = rawEvidence.analysis || rawEvidence;
  return {
    version: Number(rawEvidence.version || rawDecision.version || 1),
    ...analysis,
    computed_at: analysis.computed_at || rawDecision.computed_at || row.computed_at,
    action: analysis.action || rawDecision.action,
    stress: analysis.stress || rawDecision.stress || parsed.zone_stress,
    usable_tree_count: analysis.usable_tree_count ?? rawDecision.usable_tree_count ?? parsed.usable_tree_count,
  };
}

async function readDendroEvidence(db, policy, dueMs, windowMinutes) {
  const zoneId = await zoneIdFor(db, policy);
  if (zoneId == null) return { analysis: null, reason: 'zone_not_found', sources: [] };
  const rows = await all(db,
    'SELECT recommendation_json, computed_at, zone_stress_summary, irrigation_action, usable_tree_count FROM zone_daily_recommendations WHERE zone_id = ? ORDER BY computed_at DESC, id DESC',
    [zoneId]);
  const orderedRows = (rows || []).map((row) => ({ row, computedMs: parseInstant(row.computed_at) }))
    .filter((entry) => entry.computedMs != null)
    .sort((a, b) => b.computedMs - a.computedMs);
  for (const entry of orderedRows) {
    const row = entry.row;
    const computedMs = entry.computedMs;
    if (computedMs == null || computedMs > dueMs || dueMs - computedMs > 36 * 60 * 60 * 1000) continue;
    const analysis = rawAnalysisFromRecommendation(row);
    if (analysis) return { analysis, sources: [{ kind: 'DENDRO', version: analysis.version, computed_at: analysis.computed_at }] };
    return { analysis: null, reason: 'dendro_raw_evidence_missing', sources: [] };
  }
  return { analysis: null, reason: 'dendro_evidence_missing', sources: [] };
}

async function readEvidence({ db, policy, dueAt }) {
  const condition = policy && policy.condition;
  const dueMs = parseInstant(dueAt);
  const windowMinutes = policy && policy.observation_window_minutes == null ? 60 : Number(policy && policy.observation_window_minutes || 60);
  if (!condition || dueMs == null || !Number.isInteger(windowMinutes) || windowMinutes < 1 || windowMinutes > 1440) {
    return { sources: [], analysis: null, reason: 'invalid_observation_input' };
  }
  if (String(condition.kind || '').toUpperCase() === 'DENDRO') return readDendroEvidence(db, policy, dueMs, windowMinutes);
  const policyZoneId = await zoneIdFor(db, policy);
  const sources = [];
  for (const source of Array.isArray(condition.sources) ? condition.sources : []) {
    sources.push(await readSoilSource(db, source, { ...condition, kind: String(condition.kind || '').toUpperCase() }, policyZoneId, dueMs, windowMinutes));
  }
  return { sources, due_at: new Date(dueMs).toISOString(), observation_window_minutes: windowMinutes };
}

module.exports = {
  SAMPLE_COLUMNS,
  readEvidence,
  readSoilSource,
  resolveSourceEligibility,
  declaredSwtChannels,
  tensiomarkSwtChannels,
  readDendroEvidence,
  normalizedSamples,
  rawAnalysisFromRecommendation,
  sourceKey,
};
