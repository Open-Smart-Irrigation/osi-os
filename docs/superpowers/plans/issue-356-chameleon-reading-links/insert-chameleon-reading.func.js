return (async()=>{
const d = msg.formattedData;
if (!d || d.isChameleon !== true) return msg;

function toNum(v) { return v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v); }
function toInt(v) { const n = toNum(v); return n === null ? null : Math.trunc(n); }
function toStr(v) { return v === null || v === undefined || v === '' ? null : String(v); }
function errorText(e) { return String(e && e.message ? e.message : e); }

const statusFlags = toInt(d.chameleonStatusFlags);
const dataInvalid = toInt(d.chameleonDataInvalid) === 1 || toInt(d.chameleonI2cMissing) === 1 || toInt(d.chameleonTimeout) === 1;
const dataInvalidFlag = dataInvalid ? 1 : 0;
const tempInvalid = dataInvalid || toInt(d.chameleonTempFault) === 1;
const tempC = tempInvalid ? null : toNum(d.chameleonTempC);
const arrayId = dataInvalid ? null : (chameleon.normalizeArrayId(d.chameleonArrayId) || null);
const r1OhmComp = dataInvalid ? null : toInt(d.chameleonR1OhmComp);
const r2OhmComp = dataInvalid ? null : toInt(d.chameleonR2OhmComp);
const r3OhmComp = dataInvalid ? null : toInt(d.chameleonR3OhmComp);
const r1OhmRaw = dataInvalid ? null : toInt(d.chameleonR1OhmRaw);
const r2OhmRaw = dataInvalid ? null : toInt(d.chameleonR2OhmRaw);
const r3OhmRaw = dataInvalid ? null : toInt(d.chameleonR3OhmRaw);
const deveui = String(d.devEui || '').trim().toUpperCase();
// Issue #356: "LSN50 Normalize + Write" sets d.deviceDataId from its own
// INSERT ... RETURNING id for this uplink. That id is the only association this
// diagnostic gets; without it the diagnostic stays unlinked and the scheduler
// ignores the canonical row. Timestamps never link the two.
const deviceDataId = Number.isSafeInteger(d.deviceDataId) && d.deviceDataId > 0 ? d.deviceDataId : null;

const db = new osiDb.Database('/data/db/farming.db');
const close = () => new Promise((resolve) => db.close(() => resolve()));

try {
  // The diagnostic and its link are one queued transaction on the shared
  // connection: no other statement or rollback can fall between them, so the
  // returned id is never reused for another reading before it is linked. If
  // another node holds a manual transaction, BEGIN fails and nothing is
  // written; the canonical row stays unlinked and the scheduler ignores it.
  const outcome = await db.transaction(async (t) => {
    const inserted = await t.get(
      'INSERT INTO chameleon_readings (deveui,recorded_at,payload_version,status_flags,data_invalid,comp_pending,i2c_missing,timeout,temp_fault,id_fault,ch1_open,ch2_open,ch3_open,temp_c,r1_ohm_comp,r2_ohm_comp,r3_ohm_comp,r1_ohm_raw,r2_ohm_raw,r3_ohm_raw,array_id,adc_ch0v,adc_ch1v,adc_ch4v,bat_v,payload_b64,f_port,f_cnt,calibration_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id',
      [
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
      ]
    );
    const readingId = inserted && Number.isSafeInteger(Number(inserted.id)) ? Number(inserted.id) : null;
    if (readingId === null || deviceDataId === null) return { readingId, linkError: null };
    try {
      await t.run('INSERT INTO chameleon_reading_links (chameleon_reading_id, device_data_id) VALUES (?, ?)', [readingId, deviceDataId]);
      return { readingId, linkError: null };
    } catch (linkError) {
      // A refused link keeps the diagnostic; the canonical row stays unlinked.
      return { readingId, linkError };
    }
  });
  if (outcome.readingId === null) {
    node.error('Chameleon reading id unavailable for ' + deveui + '; the diagnostic stays unlinked', msg);
  } else if (outcome.linkError) {
    node.error('Chameleon link failed for reading ' + outcome.readingId + ' and device_data ' + deviceDataId + ': ' + errorText(outcome.linkError), msg);
  } else if (deviceDataId === null) {
    node.warn('Chameleon reading ' + outcome.readingId + ' for ' + deveui + ' has no device_data id; it stays unlinked and the scheduler ignores it');
  }
  node.status({ fill: statusFlags == null ? 'grey' : (statusFlags ? 'yellow' : 'green'), shape: 'dot', text: 'Chameleon stored ' + d.devEui });
  return msg;
} catch (error) {
  node.status({ fill: 'red', shape: 'ring', text: 'Chameleon persist failed' });
  node.error('Chameleon persistence failed: ' + errorText(error), msg);
  return msg;
} finally {
  try { await close(); } catch (closeError) { node.warn('Chameleon db close failed: ' + errorText(closeError)); }
}
})().catch((error) => {
  node.error('Chameleon persistence failed: ' + String(error && error.message ? error.message : error), msg);
  return msg;
});
