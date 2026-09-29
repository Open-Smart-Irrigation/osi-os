import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
function flatten(value: Record<string,unknown>,prefix=''): Record<string,string> {
  return Object.fromEntries(Object.entries(value).flatMap(([key,item])=>typeof item==='string'?[[prefix+key,item]]:Object.entries(flatten(item as Record<string,unknown>,prefix+key+'.'))));
}
const read=(locale:string)=>flatten(JSON.parse(readFileSync(`public/locales/${locale}/valves.json`,'utf8')));
const english=read('en');
const shared=['openDialog.liters','scheduleDialog.noWindows','scheduleDialog.preview','scheduleDialog.previewLiters','settingsDialog.gen1','settingsDialog.gen2','format.temperature'];
const extra:Record<string,string[]>={
  'de-CH':['scheduleDialog.startTime','trigger.cloud_command'],
  fr:['scheduleDialog.date','serviceDialog.configSection','serviceDialog.timed.unitMinutes'],
  it:['trigger.cloud_command'],es:['trigger.manual'],pt:['trigger.manual'],
};
for(const locale of ['de-CH','fr','it','es','pt','lg'])test(`valve locale ${locale} keeps keys and placeholders; copied English is explicit`,()=>{
  const copy=read(locale);
  assert.deepEqual(Object.keys(copy).sort(),Object.keys(english).sort());
  for(const [key,value] of Object.entries(english)) {
    assert.deepEqual((copy[key].match(/\{\{[^}]+\}\}/g)??[]).sort(),(value.match(/\{\{[^}]+\}\}/g)??[]).sort(),`${locale}:${key}`);
  }
  if(locale==='lg')return; // Production Luganda remains subject to human review.
  const allowed=new Set([...shared,...extra[locale]]);
  assert.deepEqual(Object.keys(copy).filter(key=>copy[key]===english[key]&&!allowed.has(key)),[]);
});
