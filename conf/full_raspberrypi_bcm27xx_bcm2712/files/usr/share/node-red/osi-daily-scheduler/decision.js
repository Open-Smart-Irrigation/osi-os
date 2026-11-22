'use strict';
// X1 preserves UTC-day suppression and event emission before dispatch acceptance.
function sameLogicalWindow(nowMs, lastTriggeredIso) {
  if (!lastTriggeredIso) return false;
  const t = Date.parse(String(lastTriggeredIso));
  if (!Number.isFinite(t)) return false;
  const a = new Date(nowMs);
  const b = new Date(t);
  return a.getUTCFullYear() === b.getUTCFullYear()
    && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

function decide(msg, { env, node, osiLib, crypto, osiDb, global, Date = globalThis.Date } = {}) {
// Use first valve deveui from zone query.
// Log every decision into irrigation_events.
// Update irrigation_schedules.last_triggered_at only when irrigating.

const zone = msg.zone || {};
const rows = Array.isArray(msg.payload) ? msg.payload : [];
const r = rows[0] || {};

const meanKpa = Number(r.mean_kpa);
const nPoints = Number(r.n_points);

const userId = Number(zone.user_id);
const zoneId = Number(zone.zone_id);
const threshold = Number(zone.threshold_kpa);
const valveDevEui = zone.valve_deveui;
const schedulingMode = String(zone.scheduling_mode || 'local').trim().toLowerCase() === 'server_preferred'
  ? 'server_preferred'
  : 'local';
const sharedEnvironmentJson = typeof zone.shared_environment_json === 'string' ? zone.shared_environment_json : null;
const sharedEnvironmentReceivedAt = zone.shared_environment_received_at || null;

const nowIso = new Date().toISOString();
const __scheduleDebounce = sameLogicalWindow(Date.now(), zone.last_triggered_at);
const triggerMetric = String(zone.trigger_metric || "").toUpperCase();
// Duration (minutes) comes from schedule; fallback to DB default (20)
let durationMinutesRaw =
  (zone && zone.duration_minutes != null) ? zone.duration_minutes :
    (zone && zone.schedule && zone.schedule.duration_minutes != null) ? zone.schedule.duration_minutes :
      20;

let durationMinutes = Number(durationMinutesRaw);

// Basic validation/clamp
if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) {
  durationMinutes = 10;
}

// Optional upper bound (prevents accidental multi-hour watering)
// Adjust if you want a different max.
if (durationMinutes > 240) {
  durationMinutes = 240;
}


function escapeSqlString(s) {
  return String(s).replace(/'/g, "''");
}
function applyDurationMultiplier(baseMinutes, action) {
  const factor =
    action === "decrease_20" ? 0.8 :
    action === "decrease_10" ? 0.9 :
    action === "increase_10" ? 1.1 :
    action === "increase_20" ? 1.2 :
    action === "emergency_irrigate" ? 1.5 :
    1.0;
  let scaled = Math.round(Number(baseMinutes) * factor);
  if (!Number.isFinite(scaled) || scaled <= 0) scaled = 10;
  return Math.min(240, Math.max(1, scaled));
}
function safeJsonParse(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}
function isFreshServerBundle(sharedBundle, receivedAtIso) {
  const display = sharedBundle && sharedBundle.display ? sharedBundle.display : null;
  const receivedAt = receivedAtIso || (display && display.lastReceivedAt) || (sharedBundle && sharedBundle.generatedAt) || null;
  if (!receivedAt) return false;
  const ageMs = Date.now() - new Date(receivedAt).getTime();
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 6 * 60 * 60 * 1000;
}
function supportedServerAction(action) {
  return [
    'decrease_20',
    'decrease_10',
    'maintain',
    'maintain_rain_suppression',
    'maintain_recovery_hold',
    'increase_10',
    'increase_20',
    'emergency_irrigate'
  ].includes(String(action || '').trim());
}

// Basic config validation
if (!Number.isFinite(userId) || !Number.isFinite(zoneId)) {
  return null;
}
if (String(env.get('OSI_SCOPED_ACCESS') || '') === '1' &&
    Number(zone.enabled_scope_holders || 0) < 1) {
  node.warn('scheduler: zone ' + zoneId +
    ' lost all enabled scope holders; schedule disabled pending admin review');
  return [
    null,
    null,
    {
      topic:
        'UPDATE irrigation_schedules ' +
        'SET enabled = 0, sync_version = COALESCE(sync_version, 0) + 1, ' +
        "updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') " +
        'WHERE irrigation_zone_id = ' + zoneId
    }
  ];
}

// If no valve, we still log SKIP (because it is actionable debugging)
const valveOk = (typeof valveDevEui === 'string' && valveDevEui.length > 0);

if (triggerMetric === "DENDRO") {
  const rec = rows[0] || {};
  const sharedBundle = safeJsonParse(sharedEnvironmentJson);
  const sharedWaterAction = sharedBundle && sharedBundle.water && sharedBundle.water.action
    ? sharedBundle.water.action
    : null;
  const sharedAction = sharedBundle && sharedBundle.water && sharedBundle.water.action
    ? String(sharedBundle.water.action.code || '').trim()
    : '';
  const useServerRecommendation = schedulingMode === 'server_preferred'
    && sharedBundle
    && isFreshServerBundle(sharedBundle, sharedEnvironmentReceivedAt)
    && supportedServerAction(sharedAction)
    && String(sharedWaterAction && sharedWaterAction.source || '').trim().toLowerCase() === 'dendro';
  const recommendationAction = useServerRecommendation
    ? sharedAction
    : String(rec.irrigation_action || "").trim();
  const recommendationReason = useServerRecommendation
    ? String(sharedWaterAction && sharedWaterAction.reasoning || '').trim()
    : String(rec.action_reasoning || "").trim();
  const zoneStress = useServerRecommendation
    ? String((sharedBundle.drift && sharedBundle.drift.serverActionCode) ? 'server_preferred' : (rec.zone_stress_summary || 'unknown')).trim().toLowerCase()
    : String(rec.zone_stress_summary || "unknown").trim().toLowerCase();
  const analyticsDate = useServerRecommendation
    ? ((sharedWaterAction && (sharedWaterAction.recommendationDate || sharedWaterAction.date)) || null)
    : (rec.analytics_date || null);
  const analyticsComputedAt = useServerRecommendation
    ? ((sharedBundle.display && sharedBundle.display.sharedGeneratedAt) || sharedEnvironmentReceivedAt || null)
    : (rec.analytics_computed_at || null);
  const recommendationSource = useServerRecommendation ? 'server_shared_bundle' : 'local_dendro';

  if (!recommendationAction) {
    const payloadJson = {
      zone_id: zoneId,
      action: "SKIP",
      reason: "no_dendro_recommendation",
      trigger_metric: triggerMetric,
      threshold_kpa: threshold,
      scheduling_mode: schedulingMode,
      valve_deveui: valveOk ? valveDevEui : null,
      timestamp: nowIso
    };
    const insertSql = `
      INSERT INTO irrigation_events
        (user_id, irrigation_zone_id, action, reason, aggregate_kpa, threshold_kpa, duration_minutes, valve_deveui, payload_json)
      VALUES
        (${userId}, ${zoneId}, 'SKIP', 'no_dendro_recommendation', NULL, ${threshold}, ${durationMinutes}, ${valveOk ? `'${escapeSqlString(valveDevEui)}'` : 'NULL'}, '${escapeSqlString(JSON.stringify(payloadJson))}');
    `.trim();
    return [null, { topic: insertSql }, null];
  }

  const analyticsAgeH = analyticsComputedAt ? ((Date.now() - new Date(analyticsComputedAt).getTime()) / 3600000) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(analyticsAgeH) || analyticsAgeH > 36) {
    const payloadJson = {
      zone_id: zoneId,
      action: "SKIP",
      reason: "stale_dendro_recommendation",
      trigger_metric: triggerMetric,
      threshold_kpa: threshold,
      scheduling_mode: schedulingMode,
      recommendation_source: recommendationSource,
      recommendation_action: recommendationAction,
      zone_stress: zoneStress,
      analytics_date: analyticsDate,
      analytics_computed_at: analyticsComputedAt,
      analytics_age_hours: Number.isFinite(analyticsAgeH) ? Math.round(analyticsAgeH * 10) / 10 : null,
      valve_deveui: valveOk ? valveDevEui : null,
      timestamp: nowIso
    };
    const insertSql = `
      INSERT INTO irrigation_events
        (user_id, irrigation_zone_id, action, reason, aggregate_kpa, threshold_kpa, duration_minutes, valve_deveui, payload_json)
      VALUES
        (${userId}, ${zoneId}, 'SKIP', 'stale_dendro_recommendation', NULL, ${threshold}, ${durationMinutes}, ${valveOk ? `'${escapeSqlString(valveDevEui)}'` : 'NULL'}, '${escapeSqlString(JSON.stringify(payloadJson))}');
    `.trim();
    return [null, { topic: insertSql }, null];
  }

  if (!valveOk) {
    const payloadJson = {
      zone_id: zoneId,
      action: "SKIP",
      reason: "missing_valve",
      trigger_metric: triggerMetric,
      threshold_kpa: threshold,
      scheduling_mode: schedulingMode,
      recommendation_source: recommendationSource,
      recommendation_action: recommendationAction,
      zone_stress: zoneStress,
      analytics_date: analyticsDate,
      timestamp: nowIso
    };
    const insertSql = `
      INSERT INTO irrigation_events
        (user_id, irrigation_zone_id, action, reason, aggregate_kpa, threshold_kpa, duration_minutes, valve_deveui, payload_json)
      VALUES
        (${userId}, ${zoneId}, 'SKIP', 'missing_valve', NULL, ${threshold}, ${durationMinutes}, NULL, '${escapeSqlString(JSON.stringify(payloadJson))}');
    `.trim();
    return [null, { topic: insertSql }, null];
  }

  const effectiveAction = recommendationAction;
  if (__scheduleDebounce) {
    node.warn(`clock_jump_backward_suppressed: dendro zone ${zoneId} already fired for today's window (last_triggered_at=${zone.last_triggered_at}); skipping re-fire`);
    const __suppressPayloadJson = {
      zone_id: zoneId, action: "SKIP", reason: "clock_jump_backward_suppressed",
      trigger_metric: triggerMetric, threshold_kpa: threshold
    };
    const __suppressSql = `
      INSERT INTO irrigation_events
        (user_id, irrigation_zone_id, action, reason, aggregate_kpa, threshold_kpa, duration_minutes, valve_deveui, payload_json)
      VALUES
        (${userId}, ${zoneId}, 'SKIP', 'clock_jump_backward_suppressed', NULL, ${threshold}, ${durationMinutes}, ${valveOk ? `'${escapeSqlString(valveDevEui)}'` : 'NULL'}, '${escapeSqlString(JSON.stringify(__suppressPayloadJson))}');
    `.trim();
    return [null, { topic: __suppressSql }, null];
  }
  const effectiveReason = recommendationReason || "Dendrometer recommendation";

  const finalDurationMinutes = applyDurationMultiplier(durationMinutes, effectiveAction);
  const cmd = {
    type: "actuator_command",
    device: { devEui: valveDevEui, zone_id: zoneId },
    data: {
      action: "OPEN_FOR_DURATION",
      duration_minutes: finalDurationMinutes,
      reason: "scheduler_dendro",
      scheduling_mode: schedulingMode,
      recommendation_source: recommendationSource,
      recommendation_action: recommendationAction,
      effective_action: effectiveAction,
      recommendation_reasoning: recommendationReason,
      effective_reasoning: effectiveReason,
      zone_stress_summary: zoneStress,
      analytics_date: analyticsDate,
      analytics_computed_at: analyticsComputedAt,
      trigger_metric: triggerMetric,
      threshold_kpa: threshold,
      base_duration_minutes: durationMinutes,
      timestamp: nowIso
    }
  };

  const payloadJson = {
    zone_id: zoneId,
    action: "IRRIGATE",
    reason: "scheduler_dendro",
    scheduling_mode: schedulingMode,
    recommendation_source: recommendationSource,
    trigger_metric: triggerMetric,
    threshold_kpa: threshold,
    recommendation_action: recommendationAction,
    effective_action: effectiveAction,
    recommendation_reasoning: recommendationReason,
    effective_reasoning: effectiveReason,
    zone_stress_summary: zoneStress,
    analytics_date: analyticsDate,
    analytics_computed_at: analyticsComputedAt,
    valve_deveui: valveDevEui,
    base_duration_minutes: durationMinutes,
    duration_minutes: finalDurationMinutes,
    timestamp: nowIso
  };

  const insertSql = `
    INSERT INTO irrigation_events
      (user_id, irrigation_zone_id, action, reason, aggregate_kpa, threshold_kpa, duration_minutes, valve_deveui, payload_json)
    VALUES
      (${userId}, ${zoneId}, 'IRRIGATE', 'scheduler_dendro', NULL, ${threshold}, ${finalDurationMinutes}, '${escapeSqlString(valveDevEui)}', '${escapeSqlString(JSON.stringify(payloadJson))}');
  `.trim();

  const updateSql = `
    UPDATE irrigation_schedules
    SET last_triggered_at = '${nowIso}',
        updated_at = '${nowIso}'
    WHERE irrigation_zone_id = ${zoneId};
  `.trim();

  return [{ payload: cmd, _systemActuation: true, _stregaInternalSource: "scheduler" }, { topic: insertSql }, { topic: updateSql }];
}

// If no datapoints, log SKIP
if (!Number.isFinite(meanKpa) || !Number.isFinite(nPoints) || nPoints <= 0) {
  const payloadJson = {
    zone_id: zoneId,
    action: "SKIP",
    reason: "no_data_last_hour",
    mean_kpa: null,
    threshold_kpa: threshold,
    n_points: nPoints || 0,
    valve_deveui: valveOk ? valveDevEui : null,
    window: { min_recorded_at: r.min_recorded_at || null, max_recorded_at: r.max_recorded_at || null },
    timestamp: nowIso
  };

  const insertSql = `
    INSERT INTO irrigation_events
      (user_id, irrigation_zone_id, action, reason, aggregate_kpa, threshold_kpa, duration_minutes, valve_deveui, payload_json)
    VALUES
      (${userId}, ${zoneId}, 'SKIP', 'no_data_last_hour', NULL, ${threshold}, ${durationMinutes}, ${valveOk ? `'${escapeSqlString(valveDevEui)}'` : 'NULL'}, '${escapeSqlString(JSON.stringify(payloadJson))}');
  `.trim();

  return [null, { topic: insertSql }, null];
}

// If valve missing, log SKIP
if (!valveOk) {
  const payloadJson = {
    zone_id: zoneId,
    action: "SKIP",
    reason: "missing_valve",
    mean_kpa: meanKpa,
    threshold_kpa: threshold,
    n_points: nPoints,
    valve_deveui: null,
    window: { min_recorded_at: r.min_recorded_at || null, max_recorded_at: r.max_recorded_at || null },
    timestamp: nowIso
  };

  const insertSql = `
    INSERT INTO irrigation_events
      (user_id, irrigation_zone_id, action, reason, aggregate_kpa, threshold_kpa, duration_minutes, valve_deveui, payload_json)
    VALUES
      (${userId}, ${zoneId}, 'SKIP', 'missing_valve', ${meanKpa}, ${threshold}, ${durationMinutes}, NULL, '${escapeSqlString(JSON.stringify(payloadJson))}');
  `.trim();

  return [null, { topic: insertSql }, null];
}

// Decision rule: irrigate when mean_kpa >= threshold
const __wouldIrrigate = (meanKpa >= threshold);
if (__wouldIrrigate && __scheduleDebounce) {
  node.warn(`clock_jump_backward_suppressed: zone ${zoneId} already fired for today's window (last_triggered_at=${zone.last_triggered_at}); skipping re-fire`);
  const __suppressPayload = {
    zone_id: zoneId, action: "SKIP", reason: "clock_jump_backward_suppressed",
    trigger_metric: zone.trigger_metric, threshold_kpa: threshold,
    mean_kpa: meanKpa, n_points: nPoints, valve_deveui: valveDevEui, timestamp: nowIso
  };
  const __suppressSql = `
    INSERT INTO irrigation_events
      (user_id, irrigation_zone_id, action, reason, aggregate_kpa, threshold_kpa, duration_minutes, valve_deveui, payload_json)
    VALUES
      (${userId}, ${zoneId}, 'SKIP', 'clock_jump_backward_suppressed', ${meanKpa}, ${threshold}, ${durationMinutes}, '${escapeSqlString(valveDevEui)}', '${escapeSqlString(JSON.stringify(__suppressPayload))}');
  `.trim();
  return [null, { topic: __suppressSql }, null];
}
const irrigate = (__wouldIrrigate && !__scheduleDebounce);

if (!irrigate) {
  const payloadJson = {
    zone_id: zoneId,
    action: "SKIP",
    reason: "below_threshold",
    mean_kpa: meanKpa,
    threshold_kpa: threshold,
    n_points: nPoints,
    valve_deveui: valveDevEui,
    window: { min_recorded_at: r.min_recorded_at || null, max_recorded_at: r.max_recorded_at || null },
    timestamp: nowIso
  };

  const insertSql = `
    INSERT INTO irrigation_events
      (user_id, irrigation_zone_id, action, reason, aggregate_kpa, threshold_kpa, duration_minutes, valve_deveui, payload_json)
    VALUES
      (${userId}, ${zoneId}, 'SKIP', 'below_threshold', ${meanKpa}, ${threshold}, ${durationMinutes}, '${escapeSqlString(valveDevEui)}', '${escapeSqlString(JSON.stringify(payloadJson))}');
  `.trim();

  return [null, { topic: insertSql }, null];
}

// Build actuator command
const cmd = {
  type: "actuator_command",
  device: { devEui: valveDevEui, zone_id: zoneId },
  data: {
    action: "OPEN_FOR_DURATION",
    duration_minutes: durationMinutes,
    reason: "scheduler_threshold",
    mean_kpa_last_hour: meanKpa,
    threshold_kpa: threshold,
    trigger_metric: zone.trigger_metric,
    n_points_last_hour: nPoints,
    window: { min_recorded_at: r.min_recorded_at || null, max_recorded_at: r.max_recorded_at || null },
    timestamp: nowIso
  }
};

// Log IRRIGATE
const payloadJson = {
  zone_id: zoneId,
  action: "IRRIGATE",
  reason: "scheduler_threshold",
  mean_kpa_last_hour: meanKpa,
  threshold_kpa: threshold,
  trigger_metric: zone.trigger_metric,
  n_points_last_hour: nPoints,
  valve_deveui: valveDevEui,
  duration_minutes: durationMinutes,
  window: { min_recorded_at: r.min_recorded_at || null, max_recorded_at: r.max_recorded_at || null },
  timestamp: nowIso
};

const insertSql = `
  INSERT INTO irrigation_events
    (user_id, irrigation_zone_id, action, reason, aggregate_kpa, threshold_kpa, duration_minutes, valve_deveui, payload_json)
  VALUES
    (${userId}, ${zoneId}, 'IRRIGATE', 'scheduler_threshold', ${meanKpa}, ${threshold}, ${durationMinutes}, '${escapeSqlString(valveDevEui)}', '${escapeSqlString(JSON.stringify(payloadJson))}');
`.trim();

const updateSql = `
  UPDATE irrigation_schedules
  SET last_triggered_at = '${nowIso}',
      updated_at = '${nowIso}'
  WHERE irrigation_zone_id = ${zoneId};
`.trim();

return [ { payload: cmd, _systemActuation: true, _stregaInternalSource: "scheduler" }, { topic: insertSql }, { topic: updateSql } ];

}

module.exports = { decide, sameLogicalWindow };
