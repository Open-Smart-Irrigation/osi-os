#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..');
const flowPaths = [
  'conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/flows.json',
  'conf/full_raspberrypi_bcm27xx_bcm2709/files/usr/share/flows.json',
].map((entry) => path.join(repo, entry));
const contracts = {
  'al-link-build-req': '0353933a497d8f4ca59d460b3bbe6c1196d977fc9c8e71057a3ef2e3d7768d6e',
  'sync-bootstrap-build': '9df2b2875368fadecaa3e305bbf60b6ff390b22e745ef3bfe1db3a008dd05af0',
  'sync-force-build': '3b1d02989ff73cd623eb19dfb5f624edf54b77cc7552f25170340fdd90a9fa45',
  'zone-calibration-fn': 'b72c1ec9ee0bddc49010c1ccce85188c11a4271cd8090fea3228b188077ae8df',
};
const capabilityBefore =
  "const syncCapabilities = ['linked_auth_sync_v1', 'force_edge_sync_v1', 'zone_desired_state_v1'];";
const capabilityAfter =
  "const syncCapabilities = ['linked_auth_sync_v1', 'force_edge_sync_v1', 'zone_desired_state_v1', 'irrigation_config_desired_state_v1'];";
const scheduleQuery =
  '  const schedules = await q("SELECT iz.zone_uuid, s.trigger_metric, s.threshold_kpa, s.enabled, s.duration_minutes, s.response_mode, s.sync_version, s.deleted_at, s.last_applied_at FROM irrigation_schedules s JOIN irrigation_zones iz ON iz.id = s.irrigation_zone_id");';
const calibrationQuery = scheduleQuery + '\n' +
  '  const irrigationCalibrations = await q("SELECT iz.zone_uuid, iz.gateway_device_eui, zic.measured_flow_rate_lpm, zic.measurement_method, zic.measured_at, zic.sync_version, zic.deleted_at, zic.last_applied_at FROM zone_irrigation_calibration zic JOIN irrigation_zones iz ON iz.id = zic.zone_id");';
const schedulePayload = 'schedules: schedules.map(sanitizeSyncRow),';
const calibrationPayload = schedulePayload + '\n' +
  '    irrigationCalibrations: irrigationCalibrations.map(sanitizeSyncRow),';
const calibrationBefore = `  const owned = await q('SELECT id FROM irrigation_zones WHERE id = ? AND user_id = ? AND deleted_at IS NULL LIMIT 1', [zoneId, (msg._scopedZoneWriteAuthorized ? msg._scopedZoneOwnerId : auth.userId)]);
  if (!owned.length) {
    await close();
    return respond({ error: 'Zone not found or access denied' }, 404);
  }
  const now = new Date().toISOString();
  await run(
    'INSERT INTO zone_irrigation_calibration(zone_id, measured_flow_rate_lpm, measurement_method, measured_at, created_at, updated_at) VALUES(?,?,?,?,?,?) ' +
    'ON CONFLICT(zone_id) DO UPDATE SET measured_flow_rate_lpm=excluded.measured_flow_rate_lpm, measurement_method=excluded.measurement_method, measured_at=excluded.measured_at, updated_at=excluded.updated_at',
    [zoneId, measuredFlowRateLpm, measurementMethod, now, now, now]
  );`;
const calibrationAfter = `  const owned = await q(
    'SELECT iz.id, COALESCE(zic.sync_version, 0) AS calibration_sync_version ' +
    'FROM irrigation_zones iz LEFT JOIN zone_irrigation_calibration zic ON zic.zone_id = iz.id ' +
    'WHERE iz.id = ? AND iz.user_id = ? AND iz.deleted_at IS NULL LIMIT 1',
    [zoneId, (msg._scopedZoneWriteAuthorized ? msg._scopedZoneOwnerId : auth.userId)]
  );
  if (!owned.length) {
    await close();
    return respond({ error: 'Zone not found or access denied' }, 404);
  }
  const now = new Date().toISOString();
  const nextCalibrationSyncVersion = Number(owned[0].calibration_sync_version || 0) + 1;
  await run(
    'INSERT INTO zone_irrigation_calibration(' +
      'zone_id, measured_flow_rate_lpm, measurement_method, measured_at, created_at, updated_at, sync_version, deleted_at, last_applied_at' +
    ') VALUES(?,?,?,?,?,?,?,?,NULL) ' +
    'ON CONFLICT(zone_id) DO UPDATE SET ' +
      'measured_flow_rate_lpm=excluded.measured_flow_rate_lpm, ' +
      'measurement_method=excluded.measurement_method, ' +
      'measured_at=excluded.measured_at, updated_at=excluded.updated_at, ' +
      'sync_version=excluded.sync_version, deleted_at=NULL, last_applied_at=NULL',
    [zoneId, measuredFlowRateLpm, measurementMethod, now, now, now, nextCalibrationSyncVersion, null]
  );`;
const responseBefore = `    measurement_method: measurementMethod,
    updated_at: now,`;
const responseAfter = `    measurement_method: measurementMethod,
    sync_version: nextCalibrationSyncVersion,
    updated_at: now,`;
const authSecretReadBefore = `      } catch (_) {}
    }
    const generated`;
const authSecretReadAfter = `      } catch (error) {
        node.warn('Zone calibration auth secret read failed: ' + String(error && error.message ? error.message : error));
      }
    }
    const generated`;
const authSecretWriteBefore = `      } catch (_) {}
    }
  }
  const err`;
const authSecretWriteAfter = `      } catch (error) {
        node.warn('Zone calibration auth secret write failed: ' + String(error && error.message ? error.message : error));
      }
    }
  }
  const err`;
const closeBefore = `} catch (e) {
  try { await close(); } catch (_) {}
  return respond`;
const closeAfter = `} catch (e) {
  try {
    await close();
  } catch (closeError) {
    node.warn('Zone calibration DB close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));
  }
  return respond`;

function digest(node) {
  return crypto.createHash('sha256').update(JSON.stringify(node)).digest('hex');
}

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Expected exactly one ${label} seam`);
  }
  return source.slice(0, first) + after + source.slice(first + before.length);
}

function serialize(flows, trailingNewline) {
  return JSON.stringify(flows, null, 2) + (trailingNewline ? '\n' : '');
}

function transform(raw, label) {
  const trailingNewline = raw.endsWith('\n');
  const flows = JSON.parse(raw);
  assert.equal(serialize(flows, trailingNewline), raw, `${label}: unstable JSON`);
  const byId = new Map(flows.map((node) => [node.id, node]));
  const current = Object.fromEntries(
    Object.keys(contracts).map((id) => [id, digest(byId.get(id))])
  );
  const dataCurrent =
    byId.get('al-link-build-req').func.includes(capabilityAfter) &&
    byId.get('sync-bootstrap-build').func.includes('irrigationCalibrations') &&
    byId.get('sync-force-build').func.includes('irrigationCalibrations') &&
    byId.get('zone-calibration-fn').func.includes('nextCalibrationSyncVersion');
  const calibration = byId.get('zone-calibration-fn');
  const alreadyCurrent =
    dataCurrent &&
    calibration.func.includes('Zone calibration auth secret read failed:') &&
    calibration.func.includes('Zone calibration auth secret write failed:') &&
    calibration.func.includes('Zone calibration DB close failed:');
  if (alreadyCurrent) return raw;
  if (!dataCurrent) {
    for (const [id, expected] of Object.entries(contracts)) {
      assert.equal(current[id], expected, `${label}: ${id} preimage drifted`);
    }
    for (const id of ['al-link-build-req', 'sync-bootstrap-build', 'sync-force-build']) {
      const node = byId.get(id);
      node.func = replaceOnce(node.func, capabilityBefore, capabilityAfter, `${id} capability`);
    }
    for (const id of ['sync-bootstrap-build', 'sync-force-build']) {
      const node = byId.get(id);
      node.func = replaceOnce(node.func, scheduleQuery, calibrationQuery, `${id} query`);
      node.func = replaceOnce(node.func, schedulePayload, calibrationPayload, `${id} payload`);
    }
    calibration.func = replaceOnce(
      calibration.func,
      calibrationBefore,
      calibrationAfter,
      'calibration local write'
    );
    calibration.func = replaceOnce(
      calibration.func,
      responseBefore,
      responseAfter,
      'calibration response'
    );
  }
  calibration.func = replaceOnce(
    calibration.func,
    authSecretReadBefore,
    authSecretReadAfter,
    'calibration auth secret read warning'
  );
  calibration.func = replaceOnce(
    calibration.func,
    authSecretWriteBefore,
    authSecretWriteAfter,
    'calibration auth secret write warning'
  );
  calibration.func = replaceOnce(
    calibration.func,
    closeBefore,
    closeAfter,
    'calibration DB close warning'
  );
  const next = serialize(flows, trailingNewline);
  assert.equal(transform(next, label), next, `${label}: not idempotent`);
  return next;
}

const before = flowPaths.map((file) => fs.readFileSync(file, 'utf8'));
assert.equal(before[0], before[1], 'maintained profiles differ before edit');
const after = flowPaths.map((file, index) =>
  transform(before[index], path.relative(repo, file))
);
assert.equal(after[0], after[1], 'maintained profiles differ after edit');
for (let index = 0; index < flowPaths.length; index += 1) {
  if (after[index] !== before[index]) fs.writeFileSync(flowPaths[index], after[index]);
}
process.stdout.write('migrate-flows-irrigation-config-capability: OK\n');
