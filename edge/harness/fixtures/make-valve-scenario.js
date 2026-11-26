#!/usr/bin/env node
'use strict';
// Builds scenarios/070-timed-open.json: one timed open end to end through the
// gRPC DeviceService stand-in (G1 item 3), with refusals, the valve's own
// OPEN and CLOSED reports, a second open, a cancel and the valve ticks.
// Setup mirrors the release smoke (devices claimed before the session).
const fs = require('node:fs'), path = require('node:path');
const VALVE = 'A840410000000001', SENSOR = 'A840410000000002', UNKNOWN = 'A84041000000000F';
const ZONE_UUID = '0b8f6a3e-6c1a-4f61-9a43-2f1d8b3e9c11';
const now = '2026-11-23T06:00:00.000Z';
let fcnt = 100, n = 0;
const report = (bit) => ({
  topic: 'application/synthetic-actuators-app/device/' + VALVE.toLowerCase() + '/event/up',
  payload: { deduplicationId: '00000000-0000-4000-8000-0000000007' + String(++n).padStart(2, '0'), time: '2026-11-23T06:0' + n + ':00.000Z', fCnt: ++fcnt, fPort: 4,
    deviceInfo: { devEui: VALVE.toLowerCase(), deviceProfileName: 'OSI STREGA Valve', applicationId: 'synthetic-actuators-app' },
    object: { Valve: String(bit), Battery: 90, Temperature: 21, Hygrometry: 40 } },
});
const open = (id, eui, body, auth = 'token') => ({ id, http: { method: 'POST', path: '/api/valve/' + eui, body, auth } });
const scenario = {
  name: 'timed-open',
  description: 'A timed open through the gRPC stand-in: INTENT/ATTEMPTED/enqueue/outcome rows and the frame bytes, refusals, valve reports, a second open, cancel, and the valve ticks.',
  steps: [
    { id: 'register', http: { method: 'POST', path: '/auth/register', body: { username: 'farmer', password: 'synthetic-pass-1' } } },
    { id: 'login', http: { method: 'POST', path: '/auth/login', body: { username: 'farmer', password: 'synthetic-pass-1' } }, capture: { token: 'json.token' } },
    { id: 'setup', why: 'devices discovered and claimed before the session, as in the release smoke', sql:
      `INSERT INTO irrigation_zones(name,user_id,timezone,zone_uuid,created_at,updated_at) VALUES ('Zone A',1,'UTC','${ZONE_UUID}','${now}','${now}');
       INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,claimed_at,irrigation_zone_id,current_state,strega_model) VALUES ('${VALVE}','Valve 1','STREGA_VALVE',1,'${now}','${now}','${now}',(SELECT id FROM irrigation_zones WHERE zone_uuid='${ZONE_UUID}'),'CLOSED','MOTORIZED');
       INSERT INTO devices(deveui,name,type_id,user_id,created_at,updated_at,claimed_at,irrigation_zone_id,current_state) VALUES ('${SENSOR}','Sensor 1','KIWI_SENSOR',1,'${now}','${now}','${now}',(SELECT id FROM irrigation_zones WHERE zone_uuid='${ZONE_UUID}'),NULL);` },
    { id: 'valves', http: { method: 'GET', path: '/api/valves', auth: 'token' } },
    open('open-no-token', VALVE, { action: 'OPEN_FOR_DURATION', duration_minutes: 2 }, 'none'),
    open('open-bare-refused', VALVE, { action: 'OPEN' }),
    open('open-zero-refused', VALVE, { action: 'OPEN_FOR_DURATION', duration_minutes: 0 }),
    open('open-256-refused', VALVE, { action: 'OPEN_FOR_DURATION', duration_minutes: 256 }),
    open('open-string-minutes', VALVE, { action: 'OPEN_FOR_DURATION', duration_minutes: '2' }),
    open('open-sensor-refused', SENSOR, { action: 'OPEN_FOR_DURATION', duration_minutes: 2 }),
    open('open-unknown-device', UNKNOWN, { action: 'OPEN_FOR_DURATION', duration_minutes: 2 }),
    open('open-lowercase-eui', VALVE.toLowerCase(), { action: 'OPEN_FOR_DURATION', duration_minutes: 2 }),
    { id: 'settle-after-open', waitMs: 300 },
    { id: 'report-open', uplink: report(1) },
    { id: 'report-closed', uplink: report(0) },
    open('open-again', VALVE, { action: 'OPEN_FOR_DURATION', duration_minutes: 3 }),
    { id: 'tick-once', timer: 'valve-once-tick' },
    { id: 'tick-clock', timer: 'valve-clock-tick' },
    { id: 'cancel', http: { method: 'POST', path: '/api/valve/' + VALVE + '/cancel', body: {}, auth: 'token' } },
    { id: 'close', http: { method: 'POST', path: '/api/valve/' + VALVE, body: { action: 'CLOSE' }, auth: 'token' } },
    { id: 'valves-after', http: { method: 'GET', path: '/api/valves', auth: 'token' } },
  ],
};
fs.writeFileSync(path.join(__dirname, '../scenarios/070-timed-open.json'), JSON.stringify(scenario, null, 1) + '\n');
console.log('wrote 070-timed-open.json', scenario.steps.length, 'steps');
