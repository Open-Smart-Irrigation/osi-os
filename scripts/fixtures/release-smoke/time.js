'use strict';
// Shift only synthetic fixture instants, preserving the effect snapshot equations.
function age(h, eui, minutes) {
  const shift = (s) => typeof s === 'string' ? s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, (m) => { const frac = /\.(\d+)Z$/.exec(m); const d = new Date(Date.parse(m) - minutes * 60000).toISOString(); return frac ? d : d.replace(/\.\d+Z$/, 'Z'); }) : s;
  const db = h.db();
  try {
    db.exec('PRAGMA busy_timeout=4000');
    for (const r of db.prepare('SELECT rowid AS rid, * FROM valve_actuation_expectations WHERE device_eui=?').all(eui)) {
      db.prepare('UPDATE valve_actuation_expectations SET commanded_at=?, expected_close_at=?, created_at=?, observed_open_at=?, observed_close_at=? WHERE rowid=?')
        .run(shift(r.commanded_at), shift(r.expected_close_at), shift(r.created_at), shift(r.observed_open_at), shift(r.observed_close_at), r.rid);
      if ('transport_json' in r) db.prepare('UPDATE valve_actuation_expectations SET transport_json=? WHERE rowid=?').run(shift(r.transport_json), r.rid);
    }
    for (const r of db.prepare('SELECT rowid AS rid, * FROM valve_settings WHERE device_eui=?').all(eui)) if ('conditional_control_json' in r) db.prepare('UPDATE valve_settings SET conditional_control_json=? WHERE rowid=?').run(shift(r.conditional_control_json), r.rid);
    for (const r of db.prepare('SELECT rowid AS rid, updated_at FROM devices WHERE deveui=?').all(eui)) db.prepare('UPDATE devices SET updated_at=? WHERE rowid=?').run(shift(r.updated_at), r.rid);
    const hasOcc = db.prepare("SELECT 1 AS x FROM sqlite_master WHERE name='irrigation_occurrences'").get();
    for (const r of hasOcc ? db.prepare('SELECT rowid AS rid, * FROM irrigation_occurrences WHERE device_eui=?').all(eui) : []) {
      const cols = ['due_at', 'expires_at', 'decision_evidence_json', 'decision_at', 'reservation_start_at', 'reservation_end_at', 'claimed_at', 'attempted_at', 'sent_at', 'observed_open_at', 'observed_close_at', 'created_at', 'updated_at'];
      db.prepare('UPDATE irrigation_occurrences SET ' + cols.map((c) => c + '=?').join(',') + ' WHERE rowid=?').run(...cols.map((c) => shift(r[c])), r.rid);
    }
  } finally { db.close(); }
}
module.exports={age};
