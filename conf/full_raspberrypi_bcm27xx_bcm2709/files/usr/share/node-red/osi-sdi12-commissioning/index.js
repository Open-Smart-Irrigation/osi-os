'use strict';

const { isDeepStrictEqual } = require('node:util');
const { compileSentekRecipe } = require('../osi-sdi12-recipe');

const ACTIVE_STATUSES = new Set(['queueing', 'queued']);
const CHIRPSTACK_CODES = new Set([
  'CANCELLED', 'UNKNOWN', 'INVALID_ARGUMENT', 'DEADLINE_EXCEEDED', 'NOT_FOUND',
  'ALREADY_EXISTS', 'PERMISSION_DENIED', 'RESOURCE_EXHAUSTED',
  'FAILED_PRECONDITION', 'ABORTED', 'OUT_OF_RANGE', 'UNIMPLEMENTED', 'INTERNAL',
  'UNAVAILABLE', 'DATA_LOSS', 'UNAUTHENTICATED',
]);
const STORED_ERROR_CODES = new Set([
  'device_queue_not_empty', 'queue_delivery_timeout', 'queueing_interrupted',
  'acquisition_observation_failed',
  ...[...CHIRPSTACK_CODES].map((code) => 'chirpstack_' + code.toLowerCase()),
]);

function commissioningError(statusCode, code) {
  const error = new Error('sdi12_commissioning_error');
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function normalizeDevEui(value) {
  const deveui = String(value || '').trim().toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(deveui)) throw commissioningError(400, 'invalid_deveui');
  return deveui;
}

function normalizeIso(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) throw commissioningError(400, 'invalid_timestamp');
  return new Date(timestamp).toISOString();
}

function deadlineFrom(now) {
  return new Date(Date.parse(now) + (12 * 60 * 60 * 1000)).toISOString();
}

function parseJson(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch (_error) {
    return null;
  }
}

function chirpStackFailure(error) {
  const raw = String(error && error.code || '').trim().toUpperCase();
  const code = 'chirpstack_' + (CHIRPSTACK_CODES.has(raw) ? raw : 'UNKNOWN').toLowerCase();
  return commissioningError(502, code);
}

function boundedStoredCode(value) {
  const code = String(value || '');
  return STORED_ERROR_CODES.has(code) ? code : (code ? 'chirpstack_unknown' : null);
}

function canonicalFromLayout(layout) {
  const compiled = compileSentekRecipe(layout);
  if (!compiled.ok) throw commissioningError(400, 'invalid_layout');
  const sensors = layout.sensors.map((sensor) => ({
    channel: sensor.channel,
    response_position: sensor.response_position,
    depth_cm: sensor.depth_cm,
    type: sensor.type,
  })).sort((first, second) => first.response_position - second.response_position);
  const canonicalLayout = { version: 1, address: compiled.recipe.address, sensors };
  const canonicalDepths = {};
  for (const sensor of sensors) {
    canonicalDepths['vwc_' + sensor.channel] = sensor.depth_cm;
    if (sensor.type === 'TRISCAN') canonicalDepths['soil_vic_' + sensor.channel] = sensor.depth_cm;
  }
  return { layout: canonicalLayout, depths: canonicalDepths, recipe: compiled.recipe };
}

function canonicalObjectJson(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const ordered = {};
  for (const key of Object.keys(value).sort()) ordered[key] = value[key];
  return JSON.stringify(ordered);
}

function assertDepthsMatch(provided, canonicalDepths) {
  if (canonicalObjectJson(provided) !== canonicalObjectJson(canonicalDepths)) {
    throw commissioningError(400, 'invalid_depths');
  }
}

async function changes(tx) {
  const row = await tx.get('SELECT changes() AS count', []);
  return Number(row && row.count || 0);
}

async function saveSentekLayout(db, input) {
  const deveui = normalizeDevEui(input && input.deveui);
  if (String(input && input.profileId || '') !== 'SENTEK_ENVIROSCAN') {
    throw commissioningError(409, 'wrong_probe_profile');
  }
  const canonical = canonicalFromLayout(input && input.layout);
  assertDepthsMatch(input && input.depths, canonical.depths);
  const layoutJson = JSON.stringify(canonical.layout);
  const depthsJson = JSON.stringify(canonical.depths);
  const recipeJson = JSON.stringify(canonical.recipe);
  const updatedAt = new Date().toISOString();

  return db.transaction(async (tx) => {
    const device = await tx.get('SELECT type_id FROM devices WHERE deveui = ?', [deveui]);
    if (!device) throw commissioningError(404, 'device_not_found');
    if (device.type_id !== 'DRAGINO_SDI12') throw commissioningError(409, 'wrong_device_type');
    const deployment = await tx.get(
      'SELECT status FROM sdi12_recipe_deployments WHERE deveui = ?',
      [deveui]
    );
    if (deployment && ACTIVE_STATUSES.has(deployment.status)) {
      throw commissioningError(409, 'deployment_in_progress');
    }

    await tx.run(
      'UPDATE devices SET sdi12_probe_profile = ?, sdi12_probe_status = ?, ' +
        'sdi12_channel_layout_json = ?, soil_moisture_probe_depths_json = ?, ' +
        'soil_moisture_probe_depths_configured = ?, sdi12_value_count = ?, ' +
        'sync_version = COALESCE(sync_version, ?) + ?, updated_at = ? WHERE deveui = ?',
      ['SENTEK_ENVIROSCAN', 'manual', layoutJson, depthsJson, 1, null, 0, 1, updatedAt, deveui]
    );

    if (deployment) {
      await tx.run(
        'UPDATE sdi12_recipe_deployments SET desired_version = desired_version + ?, ' +
          'desired_layout_hash = ?, desired_recipe_json = ?, status = ?, ' +
          'queue_item_ids_json = ?, queued_at = ?, queue_drained_at = ?, ' +
          'commissioning_deadline_at = ?, observed_count = ?, failed_observation_count = ?, ' +
          'last_observed_at = ?, last_error_code = ?, updated_at = ? ' +
          'WHERE deveui = ? AND status NOT IN (?, ?)',
        [1, canonical.recipe.layoutHash, recipeJson, 'not_applied', null, null, null, null,
          0, 0, null, null, updatedAt, deveui, 'queueing', 'queued']
      );
      if (await changes(tx) !== 1) throw commissioningError(409, 'deployment_in_progress');
    } else {
      await tx.run(
        'INSERT INTO sdi12_recipe_deployments (' +
          'deveui, desired_version, desired_layout_hash, desired_recipe_json, status, ' +
          'queue_item_ids_json, queued_at, queue_drained_at, commissioning_deadline_at, ' +
          'observed_count, failed_observation_count, last_observed_at, last_error_code, ' +
          'compatible_recipe_json, compatible_layout_json, compatible_at, updated_at' +
          ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [deveui, 1, canonical.recipe.layoutHash, recipeJson, 'not_applied', null, null, null,
          null, 0, 0, null, null, null, null, null, updatedAt]
      );
    }
    await tx.run('DELETE FROM sdi12_identify_attempts WHERE deveui = ?', [deveui]);
    return {
      profileId: 'SENTEK_ENVIROSCAN',
      status: 'manual',
      layout: canonical.layout,
      depths: canonical.depths,
      valueCount: null,
    };
  });
}

function projectDeployment(row) {
  if (!row) return null;
  const recipe = parseJson(row.desired_recipe_json);
  return {
    desired_version: Number(row.desired_version || 0),
    desired_layout_hash: row.desired_layout_hash || null,
    status: row.status || null,
    queued_at: row.queued_at || null,
    queue_drained_at: row.queue_drained_at || null,
    commissioning_deadline_at: row.commissioning_deadline_at || null,
    last_observed_at: row.last_observed_at || null,
    compatible_at: row.compatible_at || null,
    updated_at: row.updated_at || null,
    frame_count: recipe && Array.isArray(recipe.frames) ? recipe.frames.length : null,
    compatible_available: Boolean(row.compatible_recipe_json && row.compatible_layout_json),
    last_error_code: boundedStoredCode(row.last_error_code),
  };
}

async function claimDesiredRecipe(db, deveui, now, deadline) {
  return db.transaction(async (tx) => {
    const device = await tx.get(
      'SELECT type_id, sdi12_probe_profile, sdi12_channel_layout_json FROM devices WHERE deveui = ?',
      [deveui]
    );
    if (!device) throw commissioningError(404, 'device_not_found');
    if (device.type_id !== 'DRAGINO_SDI12') throw commissioningError(409, 'wrong_device_type');
    if (device.sdi12_probe_profile !== 'SENTEK_ENVIROSCAN') {
      throw commissioningError(409, 'wrong_probe_profile');
    }
    const layout = parseJson(device.sdi12_channel_layout_json);
    const canonical = canonicalFromLayout(layout);
    const deployment = await tx.get('SELECT * FROM sdi12_recipe_deployments WHERE deveui = ?', [deveui]);
    if (!deployment || !deployment.desired_recipe_json) {
      throw commissioningError(409, 'desired_recipe_missing');
    }
    if (ACTIVE_STATUSES.has(deployment.status)) {
      throw commissioningError(409, 'deployment_in_progress');
    }
    if (deployment.desired_layout_hash !== canonical.recipe.layoutHash
      || !isDeepStrictEqual(parseJson(deployment.desired_recipe_json), canonical.recipe)) {
      throw commissioningError(409, 'desired_recipe_mismatch');
    }
    await tx.run(
      'UPDATE sdi12_recipe_deployments SET status = ?, queue_item_ids_json = ?, ' +
        'queued_at = ?, queue_drained_at = ?, commissioning_deadline_at = ?, ' +
        'observed_count = ?, failed_observation_count = ?, last_observed_at = ?, ' +
        'last_error_code = ?, updated_at = ? WHERE deveui = ? AND desired_version = ? ' +
        'AND status NOT IN (?, ?)',
      ['queueing', null, null, null, deadline, 0, 0, null, null, now, deveui,
        deployment.desired_version, 'queueing', 'queued']
    );
    if (await changes(tx) !== 1) throw commissioningError(409, 'deployment_in_progress');
    return { recipe: canonical.recipe, desiredVersion: deployment.desired_version };
  });
}

async function settleApplyFailure(db, deveui, claim, ids, now, code) {
  const partial = ids.length > 0;
  await db.transaction(async (tx) => {
    await tx.run(
      'UPDATE sdi12_recipe_deployments SET status = ?, queue_item_ids_json = ?, ' +
        'queued_at = ?, queue_drained_at = ?, commissioning_deadline_at = ?, ' +
        'observed_count = ?, failed_observation_count = ?, last_observed_at = ?, ' +
        'last_error_code = ?, updated_at = ? ' +
        'WHERE deveui = ? AND desired_version = ? AND status = ?',
      [partial ? 'degraded' : 'not_applied', partial ? JSON.stringify(ids) : null,
        partial ? now : null, null, partial ? deadlineFrom(now) : null, 0, 0, null,
        code, now, deveui,
        claim.desiredVersion, 'queueing']
    );
    if (await changes(tx) !== 1) throw commissioningError(409, 'deployment_claim_lost');
  });
}

async function applyDesiredRecipe(db, client, deveuiInput, options) {
  const deveui = normalizeDevEui(deveuiInput);
  const now = normalizeIso(options && options.now);
  const deadline = deadlineFrom(now);
  const claim = await claimDesiredRecipe(db, deveui, now, deadline);
  let queue;
  try {
    queue = await client.listDeviceQueue(deveui);
  } catch (error) {
    const bounded = chirpStackFailure(error);
    await settleApplyFailure(db, deveui, claim, [], now, bounded.code);
    throw bounded;
  }
  if (!Array.isArray(queue) || queue.length > 0) {
    await settleApplyFailure(db, deveui, claim, [], now, 'device_queue_not_empty');
    throw commissioningError(409, 'device_queue_not_empty');
  }

  const ids = [];
  try {
    for (const frame of claim.recipe.frames) {
      const accepted = await client.enqueueDeviceDownlink({
        devEui: deveui,
        fPort: 2,
        confirmed: false,
        data: Buffer.from(frame.base64, 'base64'),
      });
      const id = String(accepted && accepted.id || '').trim();
      if (!id) throw Object.assign(new Error('missing queue id'), { code: 'UNKNOWN' });
      ids.push(id);
    }
  } catch (error) {
    const bounded = chirpStackFailure(error);
    await settleApplyFailure(db, deveui, claim, ids, now, bounded.code);
    throw bounded;
  }

  await db.transaction(async (tx) => {
    await tx.run(
      'UPDATE sdi12_recipe_deployments SET status = ?, queue_item_ids_json = ?, ' +
        'queued_at = ?, queue_drained_at = ?, commissioning_deadline_at = ?, ' +
        'last_error_code = ?, updated_at = ? WHERE deveui = ? AND desired_version = ? AND status = ?',
      ['queued', JSON.stringify(ids), now, null, deadline, null, now, deveui,
        claim.desiredVersion, 'queueing']
    );
    if (await changes(tx) !== 1) throw commissioningError(409, 'deployment_claim_lost');
  });
  const row = await db.get('SELECT * FROM sdi12_recipe_deployments WHERE deveui = ?', [deveui]);
  return { statusCode: 202, deployment: projectDeployment(row) };
}

async function claimRollback(db, deveui, now, deadline) {
  return db.transaction(async (tx) => {
    const device = await tx.get(
      'SELECT type_id, sdi12_probe_profile, sdi12_probe_status, sdi12_value_count, ' +
        'sdi12_channel_layout_json, soil_moisture_probe_depths_json, ' +
        'soil_moisture_probe_depths_configured, sync_version, updated_at ' +
        'FROM devices WHERE deveui = ?',
      [deveui]
    );
    if (!device) throw commissioningError(404, 'device_not_found');
    if (device.type_id !== 'DRAGINO_SDI12') throw commissioningError(409, 'wrong_device_type');
    const deployment = await tx.get('SELECT * FROM sdi12_recipe_deployments WHERE deveui = ?', [deveui]);
    if (!deployment || !deployment.compatible_recipe_json || !deployment.compatible_layout_json) {
      throw commissioningError(409, 'compatible_recipe_unavailable');
    }
    if (ACTIVE_STATUSES.has(deployment.status)) {
      throw commissioningError(409, 'deployment_in_progress');
    }
    let compatible;
    try {
      compatible = canonicalFromLayout(parseJson(deployment.compatible_layout_json));
    } catch (_error) {
      throw commissioningError(409, 'compatible_pair_mismatch');
    }
    if (!isDeepStrictEqual(parseJson(deployment.compatible_recipe_json), compatible.recipe)) {
      throw commissioningError(409, 'compatible_pair_mismatch');
    }

    const nextVersion = Number(deployment.desired_version) + 1;
    const layoutJson = JSON.stringify(compatible.layout);
    const depthsJson = JSON.stringify(compatible.depths);
    const recipeJson = JSON.stringify(compatible.recipe);
    await tx.run(
      'UPDATE devices SET sdi12_probe_profile = ?, sdi12_probe_status = ?, ' +
        'sdi12_value_count = ?, sdi12_channel_layout_json = ?, ' +
        'soil_moisture_probe_depths_json = ?, soil_moisture_probe_depths_configured = ?, ' +
        'sync_version = COALESCE(sync_version, ?) + ?, updated_at = ? WHERE deveui = ?',
      ['SENTEK_ENVIROSCAN', 'manual', null, layoutJson, depthsJson, 1, 0, 1, now, deveui]
    );
    await tx.run(
      'UPDATE sdi12_recipe_deployments SET desired_version = ?, desired_layout_hash = ?, ' +
        'desired_recipe_json = ?, status = ?, queue_item_ids_json = ?, queued_at = ?, ' +
        'queue_drained_at = ?, commissioning_deadline_at = ?, observed_count = ?, ' +
        'failed_observation_count = ?, last_observed_at = ?, last_error_code = ?, updated_at = ? ' +
        'WHERE deveui = ? AND desired_version = ? AND status NOT IN (?, ?)',
      [nextVersion, compatible.recipe.layoutHash, recipeJson, 'queueing', null, null, null,
        deadline, 0, 0, null, null, now, deveui, deployment.desired_version, 'queueing', 'queued']
    );
    if (await changes(tx) !== 1) throw commissioningError(409, 'deployment_in_progress');
    return {
      recipe: compatible.recipe,
      desiredVersion: nextVersion,
      appliedLayoutJson: layoutJson,
      appliedSyncVersion: Number(device.sync_version || 0) + 1,
      deviceBefore: device,
      deploymentBefore: deployment,
    };
  });
}

async function compensateRollback(db, deveui, claim) {
  await db.transaction(async (tx) => {
    const device = claim.deviceBefore;
    await tx.run(
      'UPDATE devices SET sdi12_probe_profile = ?, sdi12_probe_status = ?, ' +
        'sdi12_value_count = ?, sdi12_channel_layout_json = ?, ' +
        'soil_moisture_probe_depths_json = ?, soil_moisture_probe_depths_configured = ?, ' +
        'sync_version = ?, updated_at = ? WHERE deveui = ? AND sync_version = ? ' +
        'AND sdi12_channel_layout_json IS ?',
      [device.sdi12_probe_profile, device.sdi12_probe_status, device.sdi12_value_count,
        device.sdi12_channel_layout_json, device.soil_moisture_probe_depths_json,
        device.soil_moisture_probe_depths_configured, device.sync_version, device.updated_at,
        deveui, claim.appliedSyncVersion, claim.appliedLayoutJson]
    );
    if (await changes(tx) !== 1) throw commissioningError(409, 'rollback_compensation_conflict');

    const row = claim.deploymentBefore;
    await tx.run(
      'UPDATE sdi12_recipe_deployments SET desired_version = ?, desired_layout_hash = ?, ' +
        'desired_recipe_json = ?, status = ?, queue_item_ids_json = ?, queued_at = ?, ' +
        'queue_drained_at = ?, commissioning_deadline_at = ?, observed_count = ?, ' +
        'failed_observation_count = ?, last_observed_at = ?, last_error_code = ?, ' +
        'compatible_recipe_json = ?, compatible_layout_json = ?, compatible_at = ?, updated_at = ? ' +
        'WHERE deveui = ? AND desired_version = ? AND status = ?',
      [row.desired_version, row.desired_layout_hash, row.desired_recipe_json, row.status,
        row.queue_item_ids_json, row.queued_at, row.queue_drained_at,
        row.commissioning_deadline_at, row.observed_count, row.failed_observation_count,
        row.last_observed_at, row.last_error_code, row.compatible_recipe_json,
        row.compatible_layout_json, row.compatible_at, row.updated_at, deveui,
        claim.desiredVersion, 'queueing']
    );
    if (await changes(tx) !== 1) throw commissioningError(409, 'rollback_compensation_conflict');
  });
}

async function finishQueuedDeployment(db, deveui, desiredVersion, ids, now, deadline) {
  await db.transaction(async (tx) => {
    await tx.run(
      'UPDATE sdi12_recipe_deployments SET status = ?, queue_item_ids_json = ?, ' +
        'queued_at = ?, queue_drained_at = ?, commissioning_deadline_at = ?, ' +
        'last_error_code = ?, updated_at = ? WHERE deveui = ? AND desired_version = ? AND status = ?',
      ['queued', JSON.stringify(ids), now, null, deadline, null, now, deveui,
        desiredVersion, 'queueing']
    );
    if (await changes(tx) !== 1) throw commissioningError(409, 'deployment_claim_lost');
  });
}

async function rollbackCompatibleRecipe(db, client, deveuiInput, options) {
  const deveui = normalizeDevEui(deveuiInput);
  const now = normalizeIso(options && options.now);
  const deadline = deadlineFrom(now);
  const claim = await claimRollback(db, deveui, now, deadline);
  let queue;
  try {
    queue = await client.listDeviceQueue(deveui);
  } catch (error) {
    const bounded = chirpStackFailure(error);
    await compensateRollback(db, deveui, claim);
    throw bounded;
  }
  if (!Array.isArray(queue) || queue.length > 0) {
    await compensateRollback(db, deveui, claim);
    throw commissioningError(409, 'device_queue_not_empty');
  }

  const ids = [];
  try {
    for (const frame of claim.recipe.frames) {
      const accepted = await client.enqueueDeviceDownlink({
        devEui: deveui,
        fPort: 2,
        confirmed: false,
        data: Buffer.from(frame.base64, 'base64'),
      });
      const id = String(accepted && accepted.id || '').trim();
      if (!id) throw Object.assign(new Error('missing queue id'), { code: 'UNKNOWN' });
      ids.push(id);
    }
  } catch (error) {
    const bounded = chirpStackFailure(error);
    if (ids.length === 0) await compensateRollback(db, deveui, claim);
    else await settleApplyFailure(db, deveui, claim, ids, now, bounded.code);
    throw bounded;
  }

  await finishQueuedDeployment(db, deveui, claim.desiredVersion, ids, now, deadline);
  const row = await db.get('SELECT * FROM sdi12_recipe_deployments WHERE deveui = ?', [deveui]);
  return { statusCode: 202, deployment: projectDeployment(row) };
}

function storedQueueIds(value) {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((id) => String(id || '').trim()).filter(Boolean);
}

function deadlineReached(row, now) {
  const deadline = Date.parse(String(row.commissioning_deadline_at || ''));
  return Number.isFinite(deadline) && Date.parse(now) >= deadline;
}

async function updatePolledState(db, row, now, fields) {
  await db.transaction(async (tx) => {
    await tx.run(
      'UPDATE sdi12_recipe_deployments SET status = ?, queue_drained_at = ?, ' +
        'last_error_code = ?, updated_at = ? WHERE deveui = ? AND desired_version = ? ' +
        'AND status = ? AND queue_drained_at IS ?',
      [fields.status, fields.queueDrainedAt, fields.lastErrorCode, now, row.deveui,
        row.desired_version, row.status, null]
    );
  });
}

async function pollDeployments(db, client, options) {
  const now = normalizeIso(options && options.now);
  const active = await db.all(
    'SELECT * FROM sdi12_recipe_deployments WHERE status IN (?, ?) AND queue_drained_at IS ?',
    ['queueing', 'queued', null]
  );
  let pollFailure = null;
  for (const row of active) {
    const ids = storedQueueIds(row.queue_item_ids_json);
    if (row.status === 'queueing') {
      if (ids.length === 0 && deadlineReached(row, now)) {
        await updatePolledState(db, row, now, {
          status: 'degraded', queueDrainedAt: null, lastErrorCode: 'queueing_interrupted',
        });
      }
      continue;
    }
    if (ids.length === 0) {
      if (deadlineReached(row, now)) {
        await updatePolledState(db, row, now, {
          status: 'degraded', queueDrainedAt: null, lastErrorCode: 'queueing_interrupted',
        });
      }
      continue;
    }

    let queue;
    try {
      queue = await client.listDeviceQueue(row.deveui);
    } catch (error) {
      if (!pollFailure) pollFailure = chirpStackFailure(error);
      continue;
    }
    if (!Array.isArray(queue)) continue;
    const queuedIds = new Set(queue.map((item) => String(item && item.id || '').trim()).filter(Boolean));
    const recipeIdsRemain = ids.some((id) => queuedIds.has(id));
    if (!recipeIdsRemain) {
      await updatePolledState(db, row, now, {
        status: 'queued', queueDrainedAt: now, lastErrorCode: null,
      });
    } else if (deadlineReached(row, now)) {
      await updatePolledState(db, row, now, {
        status: 'degraded', queueDrainedAt: null, lastErrorCode: 'queue_delivery_timeout',
      });
    }
  }
  if (pollFailure) throw pollFailure;
  const projected = [];
  for (const row of active) {
    projected.push(projectDeployment(await db.get(
      'SELECT * FROM sdi12_recipe_deployments WHERE deveui = ?',
      [row.deveui]
    )));
  }
  return projected;
}

function exactFiniteChannels(channels, prefix, expected) {
  const actual = Object.keys(channels).filter((key) => new RegExp('^' + prefix + '_\\d+$').test(key)).sort();
  const wanted = expected.slice().sort();
  return isDeepStrictEqual(actual, wanted) && wanted.every((key) => Number.isFinite(channels[key]));
}

function observationMatches(input, device, deployment) {
  if (String(input && input.profileId || '') !== 'SENTEK_ENVIROSCAN'
    || device.sdi12_probe_profile !== 'SENTEK_ENVIROSCAN') return false;
  let current;
  let observed;
  try {
    current = canonicalFromLayout(parseJson(device.sdi12_channel_layout_json));
    observed = canonicalFromLayout(input && input.layout);
  } catch (_error) {
    return false;
  }
  if (current.recipe.layoutHash !== deployment.desired_layout_hash
    || observed.recipe.layoutHash !== deployment.desired_layout_hash
    || !isDeepStrictEqual(parseJson(deployment.desired_recipe_json), current.recipe)) return false;

  const normalization = input && input.normalization;
  const outcome = input && input.outcome;
  const channels = normalization && normalization.channels;
  if (!normalization || normalization.noResponse === true
    || !channels || typeof channels !== 'object' || Array.isArray(channels)
    || !normalization.unknown || typeof normalization.unknown !== 'object'
    || Object.keys(normalization.unknown).length > 0
    || !outcome || outcome.inserted !== true
    || !Array.isArray(outcome.deadLettered) || outcome.deadLettered.length > 0
    || outcome.quarantined === true || outcome.writeFailed === true) return false;

  const expectedVwc = current.layout.sensors.map((sensor) => 'vwc_' + sensor.channel);
  const expectedVic = current.layout.sensors
    .filter((sensor) => sensor.type === 'TRISCAN')
    .map((sensor) => 'soil_vic_' + sensor.channel);
  return exactFiniteChannels(channels, 'vwc', expectedVwc)
    && exactFiniteChannels(channels, 'soil_vic', expectedVic);
}

async function observeAcquisition(db, input) {
  const deveui = normalizeDevEui(input && input.deveui);
  const observedAt = normalizeIso(input && input.observedAt);
  return db.transaction(async (tx) => {
    const device = await tx.get(
      'SELECT sdi12_probe_profile, sdi12_channel_layout_json FROM devices WHERE deveui = ?',
      [deveui]
    );
    if (!device) throw commissioningError(404, 'device_not_found');
    const deployment = await tx.get('SELECT * FROM sdi12_recipe_deployments WHERE deveui = ?', [deveui]);
    if (!deployment || !deployment.queue_drained_at
      || (deployment.status !== 'queued' && deployment.status !== 'observed_once')) return null;

    if (observationMatches(input, device, deployment)) {
      const observedCount = Number(deployment.observed_count || 0) + 1;
      const compatible = observedCount >= 2;
      if (compatible) {
        const current = canonicalFromLayout(parseJson(device.sdi12_channel_layout_json));
        await tx.run(
          'UPDATE sdi12_recipe_deployments SET status = ?, observed_count = ?, ' +
            'failed_observation_count = ?, last_observed_at = ?, last_error_code = ?, ' +
            'compatible_recipe_json = desired_recipe_json, compatible_layout_json = ?, ' +
            'compatible_at = ?, updated_at = ? WHERE deveui = ? AND desired_version = ? ' +
            'AND status IN (?, ?) AND queue_drained_at = ?',
          ['observed_compatible', observedCount, 0, observedAt, null,
            JSON.stringify(current.layout), observedAt, observedAt, deveui,
            deployment.desired_version, 'queued', 'observed_once', deployment.queue_drained_at]
        );
      } else {
        await tx.run(
          'UPDATE sdi12_recipe_deployments SET status = ?, observed_count = ?, ' +
            'failed_observation_count = ?, last_observed_at = ?, last_error_code = ?, ' +
            'updated_at = ? WHERE deveui = ? AND desired_version = ? AND status IN (?, ?) ' +
            'AND queue_drained_at = ?',
          ['observed_once', observedCount, 0, observedAt, null, observedAt, deveui,
            deployment.desired_version, 'queued', 'observed_once', deployment.queue_drained_at]
        );
      }
    } else {
      const failedCount = Number(deployment.failed_observation_count || 0) + 1;
      const degraded = failedCount >= 3;
      await tx.run(
        'UPDATE sdi12_recipe_deployments SET status = ?, observed_count = ?, ' +
          'failed_observation_count = ?, last_observed_at = ?, last_error_code = ?, ' +
          'updated_at = ? WHERE deveui = ? AND desired_version = ? AND status IN (?, ?) ' +
          'AND queue_drained_at = ?',
        [degraded ? 'degraded' : 'queued', 0, failedCount, observedAt,
          degraded ? 'acquisition_observation_failed' : null, observedAt, deveui,
          deployment.desired_version, 'queued', 'observed_once', deployment.queue_drained_at]
      );
    }
    if (await changes(tx) !== 1) return null;
    return projectDeployment(await tx.get(
      'SELECT * FROM sdi12_recipe_deployments WHERE deveui = ?',
      [deveui]
    ));
  });
}

module.exports = {
  saveSentekLayout,
  applyDesiredRecipe,
  rollbackCompatibleRecipe,
  pollDeployments,
  observeAcquisition,
  projectDeployment,
};
