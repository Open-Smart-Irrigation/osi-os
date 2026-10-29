return (async () => {
  const db = new osiDb.Database('/data/db/farming.db');
  const close = () => new Promise(res => db.close(() => res()));
  const errorText = (e) => String(e && e.message ? e.message : e);

  const arrayIds = msg.calibrated || [];
  try {
    if (!arrayIds.length) return null;
    // Issue #356: one queued transaction, so no other node's statement runs
    // inside it and a failed BEGIN never rolls back another node's work.
    await db.transaction(async (t) => {
      for (const rawArrayId of arrayIds) {
        const arrayId = chameleon.normalizeArrayId(rawArrayId);
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
          const k1 = chameleon.resistanceOhmsToKpa(row.r1_ohm_comp, {a: cal.sensor1_a, b: cal.sensor1_b, c: cal.sensor1_c});
          const k2 = chameleon.resistanceOhmsToKpa(row.r2_ohm_comp, {a: cal.sensor2_a, b: cal.sensor2_b, c: cal.sensor2_c});
          const k3 = chameleon.resistanceOhmsToKpa(row.r3_ohm_comp, {a: cal.sensor3_a, b: cal.sensor3_b, c: cal.sensor3_c});
          // By row id: device_data has no unique device/time key.
          await t.run(
            'UPDATE device_data SET swt_1 = ?, swt_2 = ?, swt_3 = ? WHERE id = ?',
            [k1, k2, k3, row.id]
          );
        }
      }
    });
    return null;
  } catch (e) {
    node.warn('calibration-local-backfill failed: ' + errorText(e));
    return null;
  } finally {
    try { await close(); } catch (closeError) { node.warn('calibration-local-backfill close failed: ' + errorText(closeError)); }
  }
})();
