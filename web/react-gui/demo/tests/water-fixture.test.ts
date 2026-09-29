import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {environmentFixture, seedDevices, zoneFixture} from '../fixtures';
const require = createRequire(import.meta.url);
const {resolveWaterAction} = require('../../../../conf/full_raspberrypi_bcm27xx_bcm2712/files/usr/share/node-red/osi-zone-env/index.js');
test('simulated recommendations match the shipped backend heuristic and count only sensors',()=>{
  for(const id of [1,2]) {
    const zone=zoneFixture(id,id===1?'Tomato plot':'Demonstration bed');
    const summary=environmentFixture(zone,seedDevices().filter(d=>d.irrigation_zone_id===id));
    assert.deepEqual(summary.water.action,resolveWaterAction('2026-09-29',null,summary.water.balanceTodayMm,summary.water.next24hRainMm));
    assert.equal(summary.water.sensorHealth.sensorCount,1);
    assert.equal(summary.forecast.rainFocus?.totalNext24hMm,summary.water.next24hRainMm);
    summary.water.daily.forEach(day=>assert.equal(day.totalWaterMm,day.rainMm));
  }
});
