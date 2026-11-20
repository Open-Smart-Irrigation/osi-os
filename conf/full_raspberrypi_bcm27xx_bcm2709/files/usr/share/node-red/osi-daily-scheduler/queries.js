'use strict';
// Legacy query construction; SWT eligibility SQL remains in scheduler-mean-query.
function buildZonesQuery(msg, { env, node, osiLib, crypto, osiDb, global, Date = globalThis.Date } = {}) {


msg.topic = `
  SELECT
    iz.id AS zone_id,
    iz.name AS zone_name,
    iz.user_id,
    COALESCE(iz.scheduling_mode, 'local') AS scheduling_mode,

    s.trigger_metric,
    s.threshold_kpa,
    s.duration_minutes,
    s.enabled,
    s.last_triggered_at,
    (
      SELECT COUNT(DISTINCT u.id)
      FROM users u
      WHERE u.disabled_at IS NULL
        AND (
          u.id = iz.user_id
          OR u.user_uuid IN (
            SELECT uza.user_uuid
            FROM user_zone_assignments uza
            WHERE uza.zone_uuid = iz.zone_uuid
              AND uza.deleted_at IS NULL
          )
        )
    ) AS enabled_scope_holders,

    (
      SELECT d.deveui
      FROM devices d
      WHERE d.irrigation_zone_id = iz.id
        AND d.type_id = 'STREGA_VALVE'
        AND d.user_id = iz.user_id
      ORDER BY d.created_at ASC
      LIMIT 1
    ) AS valve_deveui

    ,
    zse.summary_json AS shared_environment_json,
    zse.last_received_at AS shared_environment_received_at

  FROM irrigation_zones iz
  INNER JOIN irrigation_schedules s
    ON s.irrigation_zone_id = iz.id
  LEFT JOIN zone_shared_environment zse
    ON zse.zone_uuid = iz.zone_uuid

  WHERE s.enabled = 1
    AND iz.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM irrigation_policies p
      WHERE p.zone_uuid = iz.zone_uuid
        AND p.deleted_at IS NULL
    )

  ORDER BY iz.id ASC;
`.trim();

return msg;

}

function buildMeanQuery(msg, { env, node, osiLib, crypto, osiDb, global, Date = globalThis.Date } = {}) {
// For one zone row, compute mean SWT over last hour across ALL datapoints.
// IMPORTANT: recorded_at is stored as ISO-8601 with Z, so we also build ISO-8601 cutoff.

const z = msg.payload || {};
const zoneId = Number(z.zone_id);
const metric = String(z.trigger_metric || "").toUpperCase();

if (!Number.isFinite(zoneId)) return null;

if (metric === "DENDRO") {
  msg.zone = z;
  msg.topic = `
    SELECT
      zone_stress_summary,
      irrigation_action,
      action_reasoning,
      recommendation_json,
      date AS analytics_date,
      computed_at AS analytics_computed_at,
      rainfall_mm,
      water_delivered_liters,
      usable_tree_count,
      low_confidence_tree_count,
      outlier_filtered_tree_count,
      zone_confidence_score
    FROM zone_daily_recommendations
    WHERE zone_id = ${zoneId}
    ORDER BY date DESC, computed_at DESC
    LIMIT 1;
  `.trim();
  return msg;
}

// Issue #356: osi-scheduler-mean-query builds the SWT query (durable Chameleon
// link, per-source kPa domains, WATERMARK interlock). If it cannot load, no
// query is sent and this zone is not evaluated.
const meanQuery = osiLib.require("scheduler-mean-query");
if (!meanQuery.ok) { node.error("scheduler-mean-query unavailable: " + meanQuery.error, msg); return null; }

// Keep zone context for downstream nodes
msg.zone = z;

// Build ISO cutoff in JS to match recorded_at format exactly
const cutoffIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();

msg.topic = meanQuery.value.buildSwtMeanQuery(metric, zoneId, cutoffIso);

return msg;

}

module.exports = { buildZonesQuery, buildMeanQuery };
