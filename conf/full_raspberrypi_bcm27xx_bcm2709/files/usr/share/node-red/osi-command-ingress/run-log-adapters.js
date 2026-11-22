// Preserve the legacy Function bodies directive mode.
// Extracted from the frozen X2 baseline; preserve error and refusal semantics.

function formatStregaResponse(msg, { env, global, node, Date, Buffer, setTimeout }) {
if (msg._strega_local_action === 'MODEL') {
  msg.statusCode = 200;
  msg.payload = {
    status: 'APPLIED',
    confirmation: 'stored_locally',
    strega_model: msg._strega_model || null,
    motorized: msg._strega_model === 'MOTORIZED'
  };
  return msg;
}
msg.statusCode = 202;
if (msg._strega_local_action === 'TIMED_ACTION') {
  msg.payload = {
    status: 'PENDING',
    confirmation: 'downlink_queued',
    action: msg._strega_timed_action || null,
    unit: msg._strega_timed_unit || null,
    amount: Number(msg._strega_timed_amount || 0) || null,
    payload_hex: msg._strega_payload_hex || null,
    f_port: Number(msg._strega_fport || 0) || 2
  };
  return msg;
}
if (msg._strega_local_action === 'MAGNET_MODE') {
  msg.payload = {
    status: 'PENDING',
    confirmation: 'downlink_queued',
    enabled: msg._strega_enabled === true,
    payload_hex: msg._strega_payload_hex || null,
    f_port: Number(msg._strega_fport || 0) || 22
  };
  return msg;
}
if (msg._strega_local_action === 'PARTIAL_OPENING') {
  msg.payload = {
    status: 'PENDING',
    confirmation: 'downlink_queued',
    action: msg._strega_partial_action || null,
    percentage: Number(msg._strega_percentage || 0) || null,
    payload_hex: msg._strega_payload_hex || null,
    f_port: Number(msg._strega_fport || 0) || 27
  };
  return msg;
}
if (msg._strega_local_action === 'FLUSHING') {
  msg.payload = {
    status: 'PENDING',
    confirmation: 'downlink_queued',
    return_position: msg._strega_return_position || null,
    percentage: Number(msg._strega_percentage || 0) || null,
    payload_hex: msg._strega_payload_hex || null,
    f_port: Number(msg._strega_fport || 0) || 28
  };
  return msg;
}
msg.statusCode = 500;
msg.payload = { message: 'Unsupported local STREGA action' };
return msg;
}

function buildActuatorLog(msg, { env, global, node, Date, Buffer, setTimeout }) {
function esc(s) {
  return String(s ?? '').replace(/'/g, "''");
}

const ctx = msg._log_ctx || {};
if (!ctx.devEui || !ctx.action) return null;

/* ---------- irrigation_zone_id (STRICT) ---------- */
let z = 'NULL';
if (Number.isFinite(Number(ctx.zone_id)) && Number(ctx.zone_id) > 0) {
  z = Number(ctx.zone_id);
}

/* ---------- duration_minutes ---------- */
let dur = 'NULL';
if (Number.isFinite(Number(ctx.duration_minutes)) && Number(ctx.duration_minutes) > 0) {
  dur = Number(ctx.duration_minutes);
}

/* ---------- reason ---------- */
const rea =
  ctx.reason && String(ctx.reason).length
    ? `'${esc(ctx.reason)}'`
    : 'NULL';

/* ---------- created_at ---------- */
const createdAt =
  ctx.created_at
    ? `'${esc(ctx.created_at)}'`
    : "datetime('now')";

/* ---------- action (Task 4 / E2: carry the percentage the builder already
   computed instead of dropping it; no schema change, actuator_log.action stays
   the one free-text column this can live in) ---------- */
let actionText = String(ctx.action);
if (Number.isFinite(Number(ctx.percentage)) && Number(ctx.percentage) > 0) {
  actionText += ' ' + Number(ctx.percentage) + '%';
  if (ctx.returnPosition) actionText += ' -> ' + String(ctx.returnPosition);
}

/* ---------- SQL ---------- */
msg.topic = `
  INSERT INTO actuator_log
    (deveui, irrigation_zone_id, action, duration_minutes, reason, created_at)
  VALUES
    ('${esc(ctx.devEui)}', ${z}, '${esc(actionText)}', ${dur}, ${rea}, ${createdAt});
`.trim();
// devices.target_state is written by osi-valve-control liveEncoder at transport acceptance (#601).

return msg;

}

module.exports = { formatStregaResponse, buildActuatorLog };
