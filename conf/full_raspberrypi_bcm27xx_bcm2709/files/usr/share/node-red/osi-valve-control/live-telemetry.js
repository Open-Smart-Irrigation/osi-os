'use strict';

function liveStregaSql({ msg, node, osiDb, osiLib }) {
return (async () => {
  const d = msg.formattedData;
  if (!d || !d.devEui) {
    node.error('formattedData missing', msg);
    return null;
  }

  const devEui = String(d.devEui).trim().toUpperCase();
  const observedAt = d.timestamp || null;
  const recordedAt = String(d.timestamp || d.arrivalTimestamp || new Date().toISOString()).trim();
  const eventIdentity = {
    ...(d.eventIdentity && typeof d.eventIdentity === 'object' ? d.eventIdentity : {}),
    reportedAtRaw: d.rawTimestamp == null ? null : String(d.rawTimestamp),
  };
  const ambientTemperature = d.ambientTemperature ?? null;
  const relativeHumidity = d.relativeHumidity ?? null;
  const batPct = d.batPct ?? null;
  const observedState = d.currentState == null ? null : String(d.currentState).trim().toUpperCase();
  const db = new osiDb.Database('/data/db/farming.db');
  const valveLoad = osiLib.require('osi-valve-control');
  if (!valveLoad.ok || !valveLoad.value || typeof valveLoad.value.recordValveObservation !== 'function') {
    node.error('STREGA observation helper unavailable: ' + String(valveLoad.error || 'recordValveObservation missing'), msg);
    try { await db.close(); } catch (closeError) {
      node.warn('STREGA persistence database close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));
    }
    return null;
  }

  try {
    const persistRawTx = async (tx) => {
      await tx.run(
        'INSERT INTO device_data (deveui, recorded_at, ambient_temperature, relative_humidity, bat_pct) VALUES (?, ?, ?, ?, ?)',
        [devEui, recordedAt, ambientTemperature, relativeHumidity, batPct]
      );
    };
    if (observedState) {
      msg.observation = await valveLoad.value.recordValveObservation({
        db, deviceEui: devEui, observedState, observedAt,
        event_identity: eventIdentity,
        runtimeContext: msg.runtimeContext || d.runtimeContext || null,
        persistRawTx,
        warn: (message) => node.warn(message),
      });
    } else {
      await db.transaction(persistRawTx);
    }

    // The telemetry transaction is closed before the writer wait. CLOSED is explicit
    // evidence from the profile-gated STREGA decoder, never an inferred device timestamp.
    if (observedState === 'CLOSED') {
      try {
        msg.closedEvidence = await valveLoad.value.observeClosedEvidence({
          db: db, deviceEui: devEui, observedState: observedState, observedAt,
          event_identity: eventIdentity,
          runtimeContext: msg.runtimeContext || d.runtimeContext || null,
        });
      } catch (evidenceError) {
        node.warn('STREGA CLOSED evidence not quiesced: ' + String(evidenceError && evidenceError.message ? evidenceError.message : evidenceError));
      }
    }

    msg.payload = {
      source: 'strega-local-persistence',
      deveui: devEui,
      recorded_at: recordedAt,
      ambient_temperature: ambientTemperature,
      relative_humidity: relativeHumidity,
      bat_pct: batPct,
      current_state: observedState
    };
    node.status({ fill: 'blue', shape: 'dot', text: 'STREGA stored ' + devEui });
    return msg;
  } catch (error) {
    node.status({ fill: 'red', shape: 'ring', text: 'STREGA persist failed ' + devEui });
    node.error('STREGA persistence failed: ' + String(error && error.message ? error.message : error), msg);
    return null;
  } finally {
    try {
      await db.close();
    } catch (closeError) {
      node.warn('STREGA persistence database close failed: ' + String(closeError && closeError.message ? closeError.message : closeError));
    }
  }
})().catch((error) => {
  node.error('STREGA persistence failed: ' + String(error && error.message ? error.message : error), msg);
  return null;
});
}

module.exports = {
  liveStregaSql
};
