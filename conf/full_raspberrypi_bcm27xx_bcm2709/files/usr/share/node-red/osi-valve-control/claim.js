'use strict';

// The two REGISTER_DEVICE flows have different provisioning and SQL builders,
// but their final STREGA write has one safety boundary: a fresh claim fence,
// the valve writer, one SQLite transaction, and lifecycle invalidation in that
// transaction. Keep that boundary here so the adapters cannot drift.
const dispatch = require('./dispatch');
const push = require('./push');

function claimError(code, message) {
  return Object.assign(new Error(message || code), { code });
}

function sameClaimValue(left, right) {
  return left == null && right == null
    ? true
    : left == null || right == null
      ? false
      : String(left) === String(right);
}

async function readClaimStateTx(tx, deviceEui, strega) {
  const before = await tx.get(
    'SELECT id, user_id, irrigation_zone_id, deleted_at, type_id, sync_version FROM devices WHERE UPPER(deveui)=UPPER(?)',
    [deviceEui]
  );
  const beforeSettings = strega
    ? await tx.get('SELECT strega_generation FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)', [deviceEui])
    : null;
  return { before, beforeSettings };
}

async function assertAuthorizationTx(tx, authorization) {
  if (!authorization || authorization.userId == null) return;
  const row = await tx.get(
    'SELECT id, user_uuid, disabled_at FROM users WHERE id=? LIMIT 1',
    [Number(authorization.userId)]
  );
  if (!row || row.disabled_at != null
      || (authorization.userUuid && String(row.user_uuid || '') !== String(authorization.userUuid))) {
    throw claimError('claim_authorization_changed');
  }
}

function assertClaimFence(fence, before, beforeSettings) {
  if (!fence || !fence.exists) {
    if (before) throw claimError('claim_state_changed');
  } else if (!before
      || (fence.id != null && Number(before.id) !== Number(fence.id))
      || before.type_id !== fence.type_id
      || !sameClaimValue(before.user_id, fence.user_id)
      || !sameClaimValue(before.irrigation_zone_id, fence.irrigation_zone_id)
      || !sameClaimValue(before.deleted_at, fence.deleted_at)
      || Number(before.sync_version || 0) !== Number(fence.sync_version || 0)
      || (fence.strega_generation != null
        && String(beforeSettings && beforeSettings.strega_generation || 'GEN1') !== String(fence.strega_generation || 'GEN1'))) {
    throw claimError('claim_state_changed');
  }
}

function expectedBindingChanged(before, after, beforeSettings, afterSettings) {
  return Boolean(before && after && (
    before.user_id !== after.user_id
    || before.irrigation_zone_id !== after.irrigation_zone_id
    || before.deleted_at !== after.deleted_at
    || (beforeSettings && afterSettings && beforeSettings.strega_generation !== afterSettings.strega_generation)
  ));
}

function writerAvailable(db) {
  return Boolean(db && typeof db.transaction === 'function'
    && dispatch && typeof dispatch.withValveWriter === 'function'
    && push && typeof push.invalidateLifecycleClearTx === 'function');
}

/**
 * Apply the already-built local device SQL for a STREGA registration.
 * Provisioning must finish before this function is called. The SQL mutation,
 * generation promotion, optional zone assignment, and lifecycle invalidation
 * run in one short writer-owned transaction; no transport is called here.
 */
async function applyStregaClaim({
  db,
  deviceEui,
  sql,
  claimFence,
  expectedDeviceType = 'STREGA_VALVE',
  expectedUserId,
  authorization,
  stregaGeneration = 'GEN1',
  zoneId = null,
  assignZone = false,
  expectedAfterOwned = true,
  now,
  invalidateReason = 'claim_changed',
} = {}) {
  const eui = String(deviceEui || '').trim().toUpperCase();
  if (!writerAvailable(db)) throw claimError('strega_writer_unavailable', 'STREGA claim writer unavailable');
  if (!eui || typeof sql !== 'string' || !sql.trim()) throw claimError('claim_sql_required', 'STREGA claim SQL is required');
  const generation = stregaGeneration === 'GEN2' ? 'GEN2' : 'GEN1';
  return dispatch.withValveWriter(eui, () => db.transaction(async (tx) => {
    const { before, beforeSettings } = await readClaimStateTx(tx, eui, true);
    await assertAuthorizationTx(tx, authorization || { userId: expectedUserId });
    assertClaimFence(claimFence, before, beforeSettings);
    const run = (statement, params) => tx.run(statement, params);
    await run(sql);
    await run(
      "INSERT INTO valve_settings (device_eui, strega_generation) VALUES (?, ?) " +
      "ON CONFLICT(device_eui) DO UPDATE SET strega_generation = excluded.strega_generation, updated_at = datetime('now') " +
      "WHERE valve_settings.strega_generation <> excluded.strega_generation AND excluded.strega_generation = 'GEN2'",
      [eui, generation]
    );
    if (assignZone && zoneId !== null) {
      await run(
        'UPDATE devices SET irrigation_zone_id = ?, sync_version = COALESCE(sync_version, 0) + 1, ' +
        'updated_at = ? WHERE deveui = ? AND deleted_at IS NULL AND irrigation_zone_id IS NULL',
        [zoneId, now, eui]
      );
    }
    const after = await tx.get(
      'SELECT id, user_id, irrigation_zone_id, deleted_at, type_id, sync_version FROM devices WHERE UPPER(deveui)=UPPER(?)',
      [eui]
    );
    if (!after || after.type_id !== expectedDeviceType || after.deleted_at !== null
        || (expectedAfterOwned && Number(after.user_id) !== Number(expectedUserId))) {
      throw claimError('claim_write_not_applied');
    }
    const afterSettings = await tx.get(
      'SELECT strega_generation FROM valve_settings WHERE UPPER(device_eui)=UPPER(?)',
      [eui]
    );
    if (expectedBindingChanged(before, after, beforeSettings, afterSettings)) {
      await push.invalidateLifecycleClearTx(tx, eui, { reason: invalidateReason, now });
    }
    return { before, after, beforeSettings, afterSettings };
  }));
}

module.exports = { applyStregaClaim, writerAvailable };
