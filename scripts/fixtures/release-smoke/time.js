'use strict';
// Shift only synthetic fixture instants, preserving the effect snapshot equations.
// Every read and write uses the runtime's native sqlite3 library asynchronously.
async function age(h,eui,minutes) {
  const shift=value=>typeof value==='string'?value.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g,text=>{
    const next=new Date(Date.parse(text)-minutes*60000).toISOString();
    return /\.\d+Z$/.test(text)?next:next.replace(/\.\d+Z$/,'Z');
  }):value;
  for(const r of await h.sql('SELECT rowid AS rid,* FROM valve_actuation_expectations WHERE device_eui=?',eui)) {
    const columns=['commanded_at','expected_close_at','created_at','observed_open_at','observed_close_at','transport_json'];
    await h.sql('UPDATE valve_actuation_expectations SET '+columns.map(c=>c+'=?').join(',')+' WHERE rowid=?',...columns.map(c=>shift(r[c])),r.rid);
  }
  for(const r of await h.sql('SELECT rowid AS rid,conditional_control_json FROM valve_settings WHERE device_eui=?',eui))await h.sql('UPDATE valve_settings SET conditional_control_json=? WHERE rowid=?',shift(r.conditional_control_json),r.rid);
  for(const r of await h.sql('SELECT rowid AS rid,updated_at FROM devices WHERE deveui=?',eui))await h.sql('UPDATE devices SET updated_at=? WHERE rowid=?',shift(r.updated_at),r.rid);
  for(const r of await h.sql('SELECT rowid AS rid,* FROM irrigation_occurrences WHERE device_eui=?',eui)) {
    const columns=['due_at','expires_at','decision_evidence_json','decision_at','reservation_start_at','reservation_end_at','claimed_at','attempted_at','sent_at','observed_open_at','observed_close_at','created_at','updated_at'];
    await h.sql('UPDATE irrigation_occurrences SET '+columns.map(c=>c+'=?').join(',')+' WHERE rowid=?',...columns.map(c=>shift(r[c])),r.rid);
  }
}
module.exports={age};
