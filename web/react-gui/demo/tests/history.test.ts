import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Simulator, DEMO_EPOCH} from '../model';
import type {ZoneEnvironmentSummary} from '../../src/types/farming';
type Point={t:string;value:number};
const history=(sim:Simulator,eui:string,field:string,hours=168)=>sim.request('GET',`/api/devices/${eui}/sensor-history?field=${field}&hours=${hours}`) as Point[];
const value=(rows:Point[],time:string)=>rows.find(row=>Date.parse(row.t)===Date.parse(time))!.value;

test('soil histories dry between events and wet at shallow depth before the deep response',()=>{
  const sim=new Simulator();
  const shallow=history(sim,'00000000000000A1','swt_1');
  const deep=history(sim,'00000000000000A1','swt_2');
  assert.equal(shallow.length,673);
  assert.ok(value(shallow,'2026-09-23T15:30Z')>value(shallow,'2026-09-22T09:00Z')+8);
  assert.ok(value(shallow,'2026-09-23T20:00Z')<value(shallow,'2026-09-23T15:30Z')-12);
  assert.equal(value(deep,'2026-09-23T20:00Z'),value(deep,'2026-09-23T15:30Z'));
  assert.ok(value(deep,'2026-09-24T06:00Z')<value(deep,'2026-09-23T20:00Z')-7);
  assert.ok(value(shallow,'2026-09-25T20:00Z')<value(shallow,'2026-09-25T16:45Z')-12);
  assert.ok(value(shallow,'2026-09-29T04:30Z')<value(shallow,'2026-09-29T01:45Z')-6);
  assert.equal(shallow.at(-1)!.value,56);
  assert.equal(deep.at(-1)!.value,46);
});

test('shared rain and separate irrigation events match seven local-day water summaries',()=>{
  const sim=new Simulator();
  assert.deepEqual(history(sim,'00000000000000E1','rain_mm_delta'),history(sim,'00000000000000E2','rain_mm_delta'));
  for(const id of [1,2]) {
    const summary=sim.request('GET',`/api/irrigation-zones/${id}/environment-summary`) as ZoneEnvironmentSummary;
    assert.equal(summary.water.daily.length,7);
    for(const [field,property] of [['rain_mm_delta','rainMm'],['flow_liters_delta','measuredIrrigationLiters']] as const) {
      const rows=history(sim,`00000000000000E${id}`,field);
      for(const day of summary.water.daily) {
        const sum=rows.filter(row=>new Date(Date.parse(row.t)+3*3600000).toISOString().slice(0,10)===day.date).reduce((a,b)=>a+b.value,0);
        assert.ok(Math.abs(sum-day[property]!)<0.0001);
      }
    }
  }
  const rain=history(sim,'00000000000000E1','rain_mm_delta');
  assert.ok(rain.filter(row=>row.value>0).length>8);
});

test('history windows overlap exactly and latest samples agree with device cards',()=>{
  const sim=new Simulator();
  for(const device of sim.devices.filter(d=>d.type_id!=='STREGA_VALVE')) {
    for(const field of ['swt_1','swt_2','ambient_temperature','relative_humidity','light_lux','rain_mm_delta','flow_liters_today']) {
      const latest=device.latest_data[field as keyof typeof device.latest_data];
      if(typeof latest!=='number')continue;
      const week=history(sim,device.deveui,field),day=history(sim,device.deveui,field,24);
      assert.deepEqual(week.slice(-97),day);
      assert.deepEqual(history(sim,device.deveui,field,2160),week);
      assert.equal(day.at(-1)!.t,new Date(DEMO_EPOCH).toISOString());
      assert.equal(day.at(-1)!.value,latest);
      assert.ok(week.every(row=>Number.isFinite(row.value)&&row.value>=0));
    }
  }
});

test('local environmental histories have night/day cycles and rain intervals cool and humidify',()=>{
  const sim=new Simulator(),eui='00000000000000A1';
  const temp=history(sim,eui,'ambient_temperature'),rh=history(sim,eui,'relative_humidity'),light=history(sim,eui,'light_lux');
  assert.ok(value(temp,'2026-09-25T12:00Z')>value(temp,'2026-09-25T02:00Z')+5);
  assert.ok(value(rh,'2026-09-25T02:00Z')>value(rh,'2026-09-25T12:00Z')+15);
  assert.equal(value(light,'2026-09-25T22:00Z'),0);
  assert.ok(value(light,'2026-09-25T09:00Z')>10000);
  assert.ok(value(temp,'2026-09-23T16:30Z')<value(temp,'2026-09-22T16:30Z'));
  assert.ok(value(rh,'2026-09-23T16:30Z')>value(rh,'2026-09-22T16:30Z'));
});
