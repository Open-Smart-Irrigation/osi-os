import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Simulator, DEMO_EPOCH, VALVE_EUI, SPARE_EUI } from '../model';
import { classifySwtWaterStatus } from '../../src/utils/swt';

test('seed contains two populated zones and wet/moist/dry kPa, reproducible history', () => {
  const sim = new Simulator();
  assert.equal(sim.zones.length, 2);
  assert.ok(sim.zones.every(z => sim.devices.some(d => d.irrigation_zone_id === z.id)));
  const statuses = sim.devices.flatMap(d => [d.latest_data.swt_1, d.latest_data.swt_2]).filter(v => v != null).map(classifySwtWaterStatus);
  assert.deepEqual(new Set(statuses), new Set(['wet', 'moist', 'dry']));
  assert.deepEqual(sim.request('GET', `/api/devices/${SPARE_EUI}/sensor-history?field=swt_1`), new Simulator().request('GET', `/api/devices/${SPARE_EUI}/sensor-history?field=swt_1`));
});

test('zone validation, assignments and deletion preserve devices and initial zones', () => {
  const sim = new Simulator();
  assert.throws(() => sim.request('POST', '/api/irrigation-zones', {name: '  '}));
  const zone = sim.request('POST', '/api/irrigation-zones', {name: ' Trial '}) as {id: number; name: string};
  assert.equal(zone.name, 'Trial');
  sim.request('PUT', `/api/irrigation-zones/${zone.id}/devices/${SPARE_EUI}`);
  assert.equal(sim.devices.find(d => d.deveui === SPARE_EUI)?.irrigation_zone_id, zone.id);
  sim.request('DELETE', `/api/irrigation-zones/${zone.id}`);
  assert.equal(sim.devices.find(d => d.deveui === SPARE_EUI)?.irrigation_zone_id, null);
  assert.equal(sim.zones.length, 2);
  assert.throws(() => sim.request('PUT', '/api/irrigation-zones/999/devices/' + SPARE_EUI));
});

test('one clock governs acknowledgement, pause, acceleration, cancellation and expiry', () => {
  const sim = new Simulator();
  sim.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  assert.equal(sim.actuation?.reconciliation_state, 'PENDING_OBSERVATION');
  assert.throws(() => sim.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'OPEN_FOR_DURATION', duration_seconds: 60}));
  sim.advance(2000);
  assert.equal(sim.actuation?.reconciliation_state, 'OBSERVED_RUNNING');
  sim.active = false;
  sim.advance(120000);
  assert.equal(sim.now, DEMO_EPOCH + 2000);
  sim.active = true;
  sim.speed = 10;
  sim.advance(6000);
  assert.equal(sim.actuation, null);
  assert.equal(sim.devices.find(d => d.deveui === VALVE_EUI)?.current_state, 'CLOSED');
  sim.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  sim.request('POST', `/api/valve/${VALVE_EUI}/cancel`);
  sim.advance(6000);
  assert.equal(sim.actuation, null);
  assert.equal(sim.outcomes[0].status, 'CANCELLED');
});

test('reset removes active countdown and restores exact seed', () => {
  const sim = new Simulator();
  const seed = structuredClone(sim.devices);
  sim.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'OPEN_FOR_DURATION', duration_seconds: 60});
  sim.advance(2000);
  sim.reset();
  assert.deepEqual(sim.devices, seed);
  assert.equal(sim.now, DEMO_EPOCH);
  assert.equal(sim.actuation, null);
  assert.equal(sim.speed, 1);
});

test('unsupported routes and real origins fail closed; controls validate payloads', () => {
  const sim = new Simulator();
  assert.throws(() => sim.request('GET', 'https://example.com/api/devices'));
  assert.throws(() => sim.request('POST', '/api/system/reboot'));
  assert.throws(() => sim.request('POST', `/api/valve/${VALVE_EUI}`, {action: 'OPEN_FOR_DURATION', duration_seconds: -1}));
  assert.throws(() => sim.request('POST', `/api/valve/${SPARE_EUI}`, {action: 'OPEN_FOR_DURATION', duration_seconds: 60}));
});

test('manual override closes an observed valve; settings never silently accept unsupported changes', () => {
  const sim = new Simulator();
  sim.request('POST', `/api/valve/${VALVE_EUI}`, {action:'OPEN_FOR_DURATION',duration_seconds:60}); sim.advance(2000);
  sim.request('POST', `/api/valve/${VALVE_EUI}`, {action:'CLOSE'});
  assert.equal(sim.actuation, null); assert.equal(sim.outcomes[0].status, 'CANCELLED');
  assert.throws(() => sim.request('PUT', `/api/valves/${VALVE_EUI}/settings`, {default_open_minutes:1,flow_rate_lpm:10}));
});

test('trigger configuration and synthetic device registration remain local and validate inputs', () => {
  const sim = new Simulator();
  sim.request('POST','/api/devices',{deveui:'00000000000000B0',name:'Practice',type_id:'KIWI_SENSOR'});
  assert.equal(sim.devices.length,5);
  assert.throws(()=>sim.request('POST','/api/devices',{deveui:'1234567890123456',name:'Not a fixture',type_id:'KIWI_SENSOR'}));
  const schedule=sim.request('PUT','/api/irrigation-zones/1/schedule',{trigger_metric:'SWT_1',threshold_kpa:70,enabled:true,duration_minutes:5});
  assert.deepEqual(sim.zones[0].schedule,schedule);
  assert.throws(()=>sim.request('PUT','/api/irrigation-zones/1/schedule',{trigger_metric:'SWT_1',threshold_kpa:0,enabled:true,duration_minutes:5}));
});
