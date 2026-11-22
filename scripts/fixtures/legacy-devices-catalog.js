'use strict';
// Synthetic catalog damage, not a captured gateway. Build the current real seed
// with pre-legacy_alter_table FK spellings; never edit sqlite_master to seed it.
const fs = require('node:fs');
const path = require('node:path');

const SHAPES = {
  healthy: 'devices',
  quoted: '"devices_old"',
  unquoted: 'devices_old',
  bracketed: '[devices_old]',
  lowercase: 'devices_old',
  rebuild: 'devices',
};
const TS = '2026-01-01T00:00:00.000Z';
const CHILD_INSERTS = {
  device_data: (e, i) => `INSERT INTO device_data (deveui,recorded_at,swt_1) VALUES ('${e}','${TS}',${10 + i}.125)`,
  dendrometer_readings: (e, i) => `INSERT INTO dendrometer_readings (deveui,recorded_at,position_um) VALUES ('${e}','${TS}',${1000 + i})`,
  chameleon_readings: e => `INSERT INTO chameleon_readings (deveui,recorded_at,r1_ohm_raw) VALUES ('${e}','${TS}',42000)`,
  dendro_baselines: e => `INSERT INTO dendro_baselines (deveui) VALUES ('${e}')`,
  valve_settings: e => `INSERT INTO valve_settings (device_eui,default_open_minutes) VALUES ('${e}',17)`,
  weather_station_zone_state: e => `INSERT INTO weather_station_zone_state (deveui) VALUES ('${e}')`,
  weather_station_zones: e => `INSERT INTO weather_station_zones (deveui,zone_id) VALUES ('${e}',1)`,
  weather_station_hours: e => `INSERT INTO weather_station_hours (deveui,hour_start,sample_count,computed_at) VALUES ('${e}','${TS}',3,'${TS}')`,
  zone_valve_assignments: (e, i) => `INSERT INTO zone_valve_assignments (zone_id,deveui,valve_channel) VALUES (1,'${e}',${i})`,
  sdi12_identify_attempts: e => `INSERT INTO sdi12_identify_attempts (deveui,stage,requested_at,updated_at) VALUES ('${e}','discovering','${TS}','${TS}')`,
  sdi12_recipe_deployments: e => `INSERT INTO sdi12_recipe_deployments (deveui,status,updated_at) VALUES ('${e}','not_applied','${TS}')`,
  valve_schedules: (e, i) => `INSERT INTO valve_schedules (schedule_uuid,device_eui,kind,fire_at,duration_minutes,timezone) VALUES ('fixture-${i}','${e}','ONCE','${TS}',15,'UTC')`,
  watermark_calibrations: e => `INSERT INTO watermark_calibrations (deveui,pullup_1_ohm,pulldown_1_ohm,series_fwd_1_ohm,series_rev_1_ohm,pullup_2_ohm,pulldown_2_ohm,series_fwd_2_ohm,series_rev_2_ohm) VALUES ('${e}',40000,40001,10,11,40002,40003,12,13)`,
};

function buildFixture(db, shape) {
  if (!(shape in SHAPES) && shape !== 'literal-only' && shape !== 'rename-damage') {
    throw new Error(`unknown legacy catalog shape: ${shape}`);
  }
  let seed = fs.readFileSync(path.join(__dirname, '../../database/seed-blank.sql'), 'utf8');
  if (shape in SHAPES) {
    const keyword = shape === 'lowercase' ? 'references' : 'REFERENCES';
    seed = seed.replace(/REFERENCES devices\(/g, `${keyword} ${SHAPES[shape]}(`);
  }
  if (shape === 'rebuild') seed = seed.replace(", 'RAK10701_FIELD_TESTER'", '').replace(",'RAK10701_FIELD_TESTER'", '');
  db.exec(seed);
  db.exec('PRAGMA foreign_keys=OFF');
  const children = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND lower(substr(name,1,7)) <> 'sqlite_' ORDER BY name")
    .all().filter(row => db.prepare(`PRAGMA foreign_key_list("${row.name}")`).all()
      .some(fk => fk.table === 'devices' || fk.table === 'devices_old')).map(row => row.name);
  for (const name of children) {
    if (!CHILD_INSERTS[name]) throw new Error(`unseeded devices child: ${name}`);
  }
  db.exec(`INSERT INTO users (id,username,password_hash,created_at,user_uuid) VALUES (1,'fixture','unused','${TS}','fixture-user');
    INSERT INTO farms (farm_id,claim_code_hash) VALUES ('fixture-farm','unused');
    INSERT INTO irrigation_zones (id,name,user_id,zone_uuid,sync_version) VALUES (1,'fixture zone',1,'fixture-zone',1);`);
  for (let i = 1; i <= 2; i++) {
    const e = `FFFF00000000000${i}`;
    db.exec(`INSERT INTO devices (deveui,name,type_id,created_at,updated_at,sync_version,chameleon_enabled,sdi12_identity)
      VALUES ('${e}','fixture-${i}','KIWI_SENSOR','${TS}','${TS}',1,1,'sentinel-${i}')`);
    for (const name of children) db.exec(CHILD_INSERTS[name](e, i));
  }
  if (shape === 'literal-only') {
    db.exec("CREATE TABLE legacy_note (id INTEGER PRIMARY KEY, note TEXT DEFAULT 'REFERENCES devices_old'); INSERT INTO legacy_note(id) VALUES (1)");
  }
  if (shape === 'rename-damage') {
    // Execute the historical failure sequence on populated tables. Modern SQLite
    // rewrites child FK and trigger SQL even though FK enforcement is OFF.
    const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name='devices'").get().sql;
    db.exec(`PRAGMA legacy_alter_table=OFF; ALTER TABLE devices RENAME TO devices_old;
      ${ddl}; INSERT INTO devices SELECT * FROM devices_old; DROP TABLE devices_old;`);
  }
  db.exec('PRAGMA foreign_keys=ON');
  return children;
}

module.exports = { buildFixture, SHAPES };
