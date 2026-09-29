import assert from 'node:assert/strict';
import {test} from 'node:test';
import {environmentFixture, seedDevices, zoneFixture} from '../fixtures';
import {Simulator, VALVE_EUI} from '../model';
import {zoneHasFlowMeter, zoneHasRainGauge} from '../../src/utils/zoneSoil';
test('offline water summaries contain only local rain and measured irrigation, with real sensor sources',()=>{
  for(const id of [1,2]) {
    const devices=seedDevices().filter(d=>d.irrigation_zone_id===id);
    const summary=environmentFixture(zoneFixture(id,'Demo zone'),devices);
    const meter=devices.find(d=>d.flow_meter_enabled===1)!;
    assert.ok(zoneHasRainGauge(devices));
    assert.ok(zoneHasFlowMeter(devices));
    assert.equal(summary.water.rainTodayMm,meter.latest_data.rain_mm_today);
    assert.equal(summary.water.irrigationTodayMeasuredLiters,meter.latest_data.flow_liters_today);
    assert.equal(summary.water.irrigationTodayLiters,summary.water.irrigationTodayMeasuredLiters);
    assert.equal(summary.water.next24hRainMm,null);
    assert.equal(summary.water.waterNeededTodayMm,null);
    assert.equal(summary.water.balanceTodayMm,null);
    assert.equal(summary.water.action,null);
    assert.equal(summary.forecast.available,false);
    assert.equal(summary.forecast.rainFocus,null);
    assert.equal(summary.online.available,false);
    assert.equal(summary.water.sensorHealth.sensorCount,2);
    const today=summary.water.daily.at(-1)!;
    assert.equal(today.rainMm,summary.water.rainTodayMm);
    assert.equal(today.measuredIrrigationLiters,summary.water.irrigationTodayMeasuredLiters);
  }
});

test('removing a meter removes its readings instead of inventing measured zeros',()=>{
  const summary=environmentFixture(zoneFixture(3,'Trial'),seedDevices().filter(d=>d.type_id==='KIWI_SENSOR'));
  assert.equal(summary.water.rainTodayMm,null);
  assert.equal(summary.water.irrigationTodayMeasuredLiters,null);
  assert.equal(summary.water.sensorHealth.rainGaugePresent,false);
  assert.equal(summary.water.sensorHealth.flowMeterPresent,false);
});


test('historical rain and volume agree with daily totals and stay fixed during valve demonstrations',()=>{
  const sim=new Simulator();
  const initial=sim.request('GET','/api/irrigation-zones/1/environment-summary');
  for(const id of [1,2]) {
    for(const field of ['rain_mm','flow_liters']) {
      const history=sim.request('GET',`/api/devices/00000000000000E${id}/sensor-history?field=${field}_delta`) as {t:string;value:number}[];
      const meter=sim.devices.find(d=>d.deveui===`00000000000000E${id}`)!;
      const total=field==='rain_mm'?meter.latest_data.rain_mm_today:meter.latest_data.flow_liters_today;
      const today=history.filter(row=>new Date(Date.parse(row.t)+3*3600000).toISOString().slice(0,10)==='2026-09-29');
      assert.ok(Math.abs(today.reduce((sum,row)=>sum+row.value,0)-total!)<0.0001);
      assert.ok(history.every(row=>row.value>=0));
    }
  }
  sim.request('POST',`/api/valve/${VALVE_EUI}`,{action:'OPEN_FOR_DURATION',duration_seconds:60});
  sim.advance(2000);
  sim.request('POST',`/api/valve/${VALVE_EUI}`,{action:'CLOSE'});
  assert.deepEqual(sim.request('GET','/api/irrigation-zones/1/environment-summary'),initial);
});
