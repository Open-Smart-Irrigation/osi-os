import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
const flatten=(obj:Record<string,unknown>,prefix=''):Record<string,string>=>Object.fromEntries(Object.entries(obj).flatMap(([k,v])=>typeof v==='string'?[[prefix+k,v]]:Object.entries(flatten(v as Record<string,unknown>,prefix+k+'.'))));
const read=(path:string)=>JSON.parse(readFileSync(path,'utf8'));
test('demo-only machine Luganda fills valve fallback strings and preserves interpolation',()=>{
  const english=flatten(read('public/locales/en/valves.json'));
  const overrides=read('demo/locales/lg-valves.json') as Record<string,string>;
  const copy={...flatten(read('public/locales/lg/valves.json')),...overrides};
  const shared=new Set(['openDialog.liters','scheduleDialog.noWindows','scheduleDialog.preview','scheduleDialog.previewLiters','settingsDialog.gen1','settingsDialog.gen2','format.temperature']);
  assert.deepEqual(Object.keys(copy).sort(),Object.keys(english).sort());
  for(const [key,value] of Object.entries(english)) {
    assert.deepEqual((copy[key].match(/\{\{[^}]+\}\}/g)??[]).sort(),(value.match(/\{\{[^}]+\}\}/g)??[]).sort(),key);
    if(!shared.has(key))assert.notEqual(copy[key],value,key);
  }
  assert.equal(read('public/locales/lg/valves.json').title,'Valve control');
});
