'use strict';

// One profile 3 uplink -> one device_data row + one watermark_readings row,
// in one transaction. A rejected frame writes only a raw row. Spec section 6,
// "Ingest" and "Writes".

const conversion = require('./conversion');
const { CHANNEL_RESULT_COLUMNS } = require('./calibration');

const PROBE_CODE_COLUMNS = ['flags', 'fwd_early', 'fwd', 'rev_early', 'rev'];

function measuredSoilTemperature(frame) {
  return frame.soil_temp_source === 2 && !frame.ds18b20_failed ? frame.soil_temp_c : null;
}

function readingRow(base, frame, result) {
  const row = Object.assign({}, base, {
    frame_status: 'accepted', reject_reason: null,
    tag: frame.tag, profile: frame.profile, supply_mv: frame.supply_mv,
    soil_temp_c: frame.soil_temp_c, soil_temp_source: frame.soil_temp_source,
    die_temp_c: frame.die_temp_c, status_byte: frame.status_byte,
    calibration_sync_version: result.calibration_sync_version,
    conversion_version: result.conversion_version
  });
  [1, 2].forEach((n) => {
    const ch = result.channels[n - 1];
    PROBE_CODE_COLUMNS.forEach((c) => { row['ch' + n + '_' + c] = ch[c]; });
    CHANNEL_RESULT_COLUMNS.forEach((c) => { row['ch' + n + '_' + c] = ch[c]; });
  });
  return row;
}

async function insertRow(tx, row) {
  const cols = Object.keys(row);
  await tx.run(
    'INSERT INTO watermark_readings (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')',
    cols.map((c) => row[c])
  );
}

// deps.clampRecordedAt: osi-device-writer's clampRecordedAt.
// deps.writeDeviceData(tx, normalizeResult): writes the device_data row on tx.
async function ingestProfile3(db, input, deps) {
  const deveui = String(input.deveui || '').trim().toUpperCase();
  const bytes = Buffer.from(String(input.payloadB64 || ''), 'base64');
  const recordedAt = deps.clampRecordedAt(input.recordedAt).recordedAt;
  const fCnt = Number.isInteger(input.fCnt) ? input.fCnt : null;
  const base = { deveui, recorded_at: recordedAt, f_cnt: fCnt, device_data_id: null, payload_hex: bytes.toString('hex') };
  const parsed = conversion.parseProfile3(bytes);
  return db.transaction(async (tx) => {
    // device_data has a foreign key to devices: a frame from a DevEUI that is
    // not registered in OSI is skipped, not half-written.
    const device = await tx.get('SELECT 1 AS known FROM devices WHERE UPPER(deveui) = ? AND deleted_at IS NULL', [deveui]);
    if (!device) return { accepted: false, reason: 'unknown_device', recordedAt };
    if (!parsed.ok) {
      await insertRow(tx, Object.assign({}, base, {
        frame_status: 'frame_rejected', reject_reason: parsed.reason,
        conversion_version: conversion.CONVERSION_VERSION
      }));
      return { accepted: false, reason: parsed.reason, recordedAt };
    }
    const calibration = await tx.get(
      'SELECT * FROM watermark_calibrations WHERE deveui = ? AND deleted_at IS NULL', [deveui]
    );
    const result = conversion.convertFrame(parsed.frame, calibration || null);
    const written = await deps.writeDeviceData(tx, {
      recordedAt,
      channels: {
        swt_1: result.channels[0].kpa,
        swt_2: result.channels[1].kpa,
        ext_temperature_c: measuredSoilTemperature(parsed.frame)
      },
      unknown: {}
    });
    // Same connection, same transaction, and the writer's INSERT is its last
    // statement: last_insert_rowid() is this observation's device_data id.
    const idRow = written && written.inserted ? await tx.get('SELECT last_insert_rowid() AS id') : null;
    await insertRow(tx, Object.assign(readingRow(base, parsed.frame, result), { device_data_id: idRow ? idRow.id : null }));
    return { accepted: true, recordedAt, statuses: result.channels.map((c) => c.status) };
  });
}

module.exports = { ingestProfile3 };
