'use strict';

const MAX_VALID_RESISTANCE_OHMS = 10000000;
const MIN_KPA = 0;
const MAX_KPA = 300;

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toFlag(value) {
  if (value === true) return true;
  if (typeof value === 'string') return value.trim().toLowerCase() === 'true' || value.trim() === '1';
  return Number(value || 0) === 1;
}

function roundTo(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return null;
  return Math.min(Math.max(value, min), max);
}

function normalizeArrayId(arrayId) {
  if (typeof arrayId !== 'string') return null;
  const upper = arrayId.toUpperCase();
  return /^[0-9A-F]{16}$/.test(upper) ? upper : null;
}

function resistanceOhmsToKpa(ohms, coefficients) {
  const resistanceOhms = toFiniteNumber(ohms);
  if (!coefficients || resistanceOhms === null
      || resistanceOhms <= 0 || resistanceOhms >= MAX_VALID_RESISTANCE_OHMS) {
    return null;
  }
  const resistanceKOhms = resistanceOhms / 1000;
  const kpa = coefficients.a * Math.log(resistanceKOhms)
            + coefficients.b * resistanceKOhms
            + coefficients.c;
  if (!Number.isFinite(kpa)) return null;
  return roundTo(clamp(kpa, MIN_KPA, MAX_KPA), 2);
}

function buildChameleonSwtMetrics(sample = {}, options = {}) {
  const { enabled = false, calibration = null } = options;
  const dataInvalid = toFlag(sample.i2cMissing) || toFlag(sample.timeout);
  const usable = enabled && !dataInvalid && calibration !== null;
  return {
    enabled: Boolean(enabled),
    dataInvalid,
    calibrationStatus: calibration !== null ? 'calibrated' : 'pending',
    swt1Kpa: usable && !toFlag(sample.ch1Open)
      ? resistanceOhmsToKpa(sample.r1OhmComp, calibration.swt1) : null,
    swt2Kpa: usable && !toFlag(sample.ch2Open)
      ? resistanceOhmsToKpa(sample.r2OhmComp, calibration.swt2) : null,
    swt3Kpa: usable && !toFlag(sample.ch3Open)
      ? resistanceOhmsToKpa(sample.r3OhmComp, calibration.swt3) : null,
  };
}

// Issue #356: the "Insert Chameleon Reading" and "calibration-local-backfill"
// bodies, moved here from those function nodes. db is the osi-db-helper
// facade the node opened; the node keeps logging, status and close.

function toNum(v) { return v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v); }
function toInt(v) { const n = toNum(v); return n === null ? null : Math.trunc(n); }
function toStr(v) { return v === null || v === undefined || v === '' ? null : String(v); }

const READING_INSERT_SQL = 'INSERT INTO chameleon_readings (deveui,recorded_at,payload_version,status_flags,data_invalid,comp_pending,i2c_missing,timeout,temp_fault,id_fault,ch1_open,ch2_open,ch3_open,temp_c,r1_ohm_comp,r2_ohm_comp,r3_ohm_comp,r1_ohm_raw,r2_ohm_raw,r3_ohm_raw,array_id,adc_ch0v,adc_ch1v,adc_ch4v,bat_v,payload_b64,f_port,f_cnt,calibration_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id';
const LINK_INSERT_SQL = 'INSERT INTO chameleon_reading_links (chameleon_reading_id, device_data_id) VALUES (?, ?)';

// The chameleon_readings row for one formattedData message, as "Apply
// Config" leaves it. Pure: no database access.
function buildReadingRow(d) {
  const statusFlags = toInt(d.chameleonStatusFlags);
  const dataInvalid = toInt(d.chameleonDataInvalid) === 1 || toInt(d.chameleonI2cMissing) === 1 || toInt(d.chameleonTimeout) === 1;
  const dataInvalidFlag = dataInvalid ? 1 : 0;
  const tempInvalid = dataInvalid || toInt(d.chameleonTempFault) === 1;
  const tempC = tempInvalid ? null : toNum(d.chameleonTempC);
  const arrayId = dataInvalid ? null : (normalizeArrayId(d.chameleonArrayId) || null);
  const r1OhmComp = dataInvalid ? null : toInt(d.chameleonR1OhmComp);
  const r2OhmComp = dataInvalid ? null : toInt(d.chameleonR2OhmComp);
  const r3OhmComp = dataInvalid ? null : toInt(d.chameleonR3OhmComp);
  const r1OhmRaw = dataInvalid ? null : toInt(d.chameleonR1OhmRaw);
  const r2OhmRaw = dataInvalid ? null : toInt(d.chameleonR2OhmRaw);
  const r3OhmRaw = dataInvalid ? null : toInt(d.chameleonR3OhmRaw);
  const deveui = String(d.devEui || '').trim().toUpperCase();
  // "LSN50 Normalize + Write" sets d.deviceDataId from its own
  // INSERT ... RETURNING id for this uplink. That id is the only association this
  // diagnostic gets; without it the diagnostic stays unlinked and the scheduler
  // ignores the canonical row. Timestamps never link the two.
  const deviceDataId = Number.isSafeInteger(d.deviceDataId) && d.deviceDataId > 0 ? d.deviceDataId : null;
  return {
    deveui,
    statusFlags,
    deviceDataId,
    params: [
      deveui,
      toStr(d.timestamp),
      toInt(d.chameleonPayloadVersion),
      statusFlags,
      dataInvalidFlag,
      toInt(d.chameleonCompPending),
      toInt(d.chameleonI2cMissing),
      toInt(d.chameleonTimeout),
      toInt(d.chameleonTempFault),
      toInt(d.chameleonIdFault),
      toInt(d.chameleonCh1Open),
      toInt(d.chameleonCh2Open),
      toInt(d.chameleonCh3Open),
      tempC,
      r1OhmComp,
      r2OhmComp,
      r3OhmComp,
      r1OhmRaw,
      r2OhmRaw,
      r3OhmRaw,
      arrayId,
      toNum(d.adcV),
      toNum(d.adcCh1V),
      toNum(d.adcCh4V),
      toNum(d.batV),
      // rawPayloadB64 is ChirpStack data.data: base64 LoRaWAN FRMPayload for offline replay.
      toStr(d.rawPayloadB64),
      toInt(d.fPort),
      toInt(d.fCnt),
      toStr(d.calibrationStatus)
    ],
  };
}

// Writes the diagnostic of buildReadingRow and, when the row carries a
// device_data id, its link. Resolves { readingId, linkError }; readingId is
// null when the insert returned no id. Rejects when the transaction fails.
//
// The diagnostic and its link are one queued transaction on the shared
// connection: no other statement or rollback can fall between them, so the
// returned id is never reused for another reading before it is linked. If
// another node holds a manual transaction, BEGIN fails and nothing is
// written; the canonical row stays unlinked and the scheduler ignores it.
async function insertReadingWithLink(db, row) {
  return db.transaction(async (t) => {
    const inserted = await t.get(READING_INSERT_SQL, row.params);
    const readingId = inserted && Number.isSafeInteger(Number(inserted.id)) ? Number(inserted.id) : null;
    if (readingId === null || row.deviceDataId === null) return { readingId, linkError: null };
    try {
      await t.run(LINK_INSERT_SQL, [readingId, row.deviceDataId]);
      return { readingId, linkError: null };
    } catch (linkError) {
      // A refused link keeps the diagnostic; the canonical row stays unlinked.
      return { readingId, linkError };
    }
  });
}

// Fills SWT on device_data rows that have none from the diagnostics of each
// calibrated array id. Rejects when the transaction fails; nothing is then
// written. An empty list opens no transaction.
async function backfillLocalCalibration(db, arrayIds) {
  if (!arrayIds.length) return;
  // One queued transaction, so no other node's statement runs
  // inside it and a failed BEGIN never rolls back another node's work.
  await db.transaction(async (t) => {
    for (const rawArrayId of arrayIds) {
      const arrayId = normalizeArrayId(rawArrayId);
      if (!arrayId) continue;
      const cal = await t.get(
        'SELECT sensor1_a, sensor1_b, sensor1_c, sensor2_a, sensor2_b, sensor2_c, sensor3_a, sensor3_b, sensor3_c FROM chameleon_calibrations WHERE array_id = ?',
        [arrayId]
      );
      if (!cal) continue;

      // A linked row takes values only from its own linked diagnostic.
      const linked = await t.all(
        'SELECT dd.id, cr.r1_ohm_comp, cr.r2_ohm_comp, cr.r3_ohm_comp ' +
        'FROM chameleon_reading_links l ' +
        'JOIN device_data dd ON dd.id = l.device_data_id ' +
        'JOIN chameleon_readings cr ON cr.id = l.chameleon_reading_id AND cr.deveui = dd.deveui ' +
        'WHERE cr.array_id = ? AND dd.swt_1 IS NULL AND dd.swt_2 IS NULL AND dd.swt_3 IS NULL ' +
        'ORDER BY dd.id',
        [arrayId]
      );
      // Rows stored before links existed keep the device and time fill for
      // history. They stay unlinked, so the scheduler never uses them. A
      // linked row or a linked diagnostic never takes part.
      const unlinked = await t.all(
        'SELECT dd.id, cr.r1_ohm_comp, cr.r2_ohm_comp, cr.r3_ohm_comp ' +
        'FROM device_data dd ' +
        'JOIN chameleon_readings cr ON cr.deveui = dd.deveui AND cr.recorded_at = dd.recorded_at ' +
        'WHERE cr.array_id = ? AND dd.swt_1 IS NULL AND dd.swt_2 IS NULL AND dd.swt_3 IS NULL ' +
        'AND NOT EXISTS (SELECT 1 FROM chameleon_reading_links l WHERE l.device_data_id = dd.id) ' +
        'AND NOT EXISTS (SELECT 1 FROM chameleon_reading_links l WHERE l.chameleon_reading_id = cr.id) ' +
        'ORDER BY dd.id, cr.id',
        [arrayId]
      );

      for (const row of linked.concat(unlinked)) {
        const k1 = resistanceOhmsToKpa(row.r1_ohm_comp, {a: cal.sensor1_a, b: cal.sensor1_b, c: cal.sensor1_c});
        const k2 = resistanceOhmsToKpa(row.r2_ohm_comp, {a: cal.sensor2_a, b: cal.sensor2_b, c: cal.sensor2_c});
        const k3 = resistanceOhmsToKpa(row.r3_ohm_comp, {a: cal.sensor3_a, b: cal.sensor3_b, c: cal.sensor3_c});
        // By row id: device_data has no unique device/time key.
        await t.run(
          'UPDATE device_data SET swt_1 = ?, swt_2 = ?, swt_3 = ? WHERE id = ?',
          [k1, k2, k3, row.id]
        );
      }
    }
  });
}

module.exports = {
  MAX_VALID_RESISTANCE_OHMS,
  normalizeArrayId,
  resistanceOhmsToKpa,
  buildChameleonSwtMetrics,
  toFiniteNumber,
  buildReadingRow,
  insertReadingWithLink,
  backfillLocalCalibration,
};
