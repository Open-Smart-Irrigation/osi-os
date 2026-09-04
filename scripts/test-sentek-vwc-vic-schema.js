'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const repo = path.resolve(__dirname, '..');
function seededDb() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sentek-schema-')), 'farming.db');
  const db = new DatabaseSync(file);
  db.exec(fs.readFileSync(path.join(repo, 'database/seed-blank.sql'), 'utf8'));
  db.exec(`INSERT OR REPLACE INTO sync_link_state(peer_node,linked,gateway_device_eui,updated_at) VALUES ('cloud',1,'0016C001F11715E2','2026-01-01');
    INSERT INTO devices(deveui,name,type_id,created_at,updated_at,gateway_device_eui)
    VALUES ('A840410000000120','Sentek','DRAGINO_SDI12','2026-01-01','2026-01-01','0016C001F11715E2');`);
  db.exec('DELETE FROM sync_outbox');
  return db;
}

test('device outbox decorator carries canonical Sentek layout as JSON', () => {
  const db = seededDb();
  try {
    const layout = JSON.stringify({ version: 1, address: 'L', sensors: [
      { channel: 9, response_position: 1, depth_cm: 70, type: 'TRISCAN' },
    ] });
    db.prepare(`UPDATE devices SET sdi12_channel_layout_json=?, sync_version=sync_version+1
      WHERE deveui='A840410000000120'`).run(layout);
    const event = db.prepare("SELECT payload_json FROM sync_outbox WHERE aggregate_type='DEVICE' ORDER BY occurred_at DESC LIMIT 1").get();
    assert.deepEqual(JSON.parse(event.payload_json).sdi12_channel_layout_json, JSON.parse(layout));
  } finally { db.close(); }
});

test('device-data outbox decorator carries VWC 9/10 and all VIC values without EC reuse', () => {
  const db = seededDb();
  try {
    db.prepare(`INSERT INTO device_data(deveui,recorded_at,vwc_9,vwc_10,soil_vic_1,soil_vic_10)
      VALUES ('A840410000000120','2026-08-25T20:00:00.000Z',9.1,10.2,0.125,0.25)`).run();
    const event = db.prepare("SELECT payload_json FROM sync_outbox WHERE aggregate_type='DEVICE_DATA' LIMIT 1").get();
    const payload = JSON.parse(event.payload_json);
    assert.equal(payload.vwc_9, 9.1);
    assert.equal(payload.vwc_10, 10.2);
    assert.equal(payload.soil_vic_1, 0.125);
    assert.equal(payload.soil_vic_10, 0.25);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'soil_ec_9'), false);
  } finally { db.close(); }
});
