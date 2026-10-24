import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
function flatten(value: Record<string,unknown>,prefix=''): Record<string,string> {
  return Object.fromEntries(Object.entries(value).flatMap(([key,item])=>typeof item==='string'?[[prefix+key,item]]:Object.entries(flatten(item as Record<string,unknown>,prefix+key+'.'))));
}
const read=(locale:string)=>flatten(JSON.parse(readFileSync(`public/locales/${locale}/valves.json`,'utf8')));
const english=read('en');
const shared=['openDialog.liters','scheduleDialog.noWindows','scheduleDialog.preview','scheduleDialog.previewLiters','settingsDialog.gen1','settingsDialog.gen2','format.temperature'];
// D04 cancel help and the cancel outcome/collateral lines (night run 2026-10-19), like the
// CMD-04 PR0 (owner decision Q02 c) containment strings, ship the English source text in every
// edge locale until a reviewed translation lands (lg: docs/i18n/pending-luganda-translations.md).
const CANCEL_KEYS=['cancelHelp','cancelHelpLabel','cancelOutcome.cancelled','cancelOutcome.handed_off','cancelOutcome.already_running','cancelOutcome.uncertain','cancelCollateral.title','cancelCollateral.weekdayPlan','cancelCollateral.planGroup','cancelCollateral.clockSync','cancelCollateral.schedulerStatus','cancelCollateral.open','cancelCollateral.config','cancelCollateral.configUnknown'];
const PENDING_TRANSLATION=['planLost','schedulerStatusLost','scheduleDialog.push.LOST',...CANCEL_KEYS];
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
  const allowed=new Set([...shared,...PENDING_TRANSLATION,...extra[locale]]);
  assert.deepEqual(Object.keys(copy).filter(key=>copy[key]===english[key]&&!allowed.has(key)),[]);
});
// The panel heading's information button replaced the visible subtitle; the
// approved English wording is pinned here so a copy edit is a reviewed change.
const SCHEDULE_HELP={scheduleHelp:'Weekly schedules run on each valve.',scheduleHelpLabel:'About weekly schedules'};
// Edge lg is human translation work product: a key without a human pass ships
// the English source text (docs/i18n/pending-luganda-translations.md).
// resumeRefusedClearPending (W29) is translated in every edge locale except lg (English, ledger).
// irrigationPolicy.vwcDisabled (R17-M1, W29) is translated in every edge locale except lg (English, ledger).
// cancelCollateral.planStillRunning (owner ruling 2026-10-24, R19 residual 1) is translated in every edge locale except lg (English, ledger).
const PENDING_HUMAN_LUGANDA=['scheduleHelp','scheduleHelpLabel',...PENDING_TRANSLATION,'resumeRefusedClearPending','irrigationPolicy.vwcDisabled','cancelCollateral.planStillRunning'];
// D04 (owner decision 2026-10-18): the cancel help text is verbatim.
test('cancel help is the verbatim D04 text',()=>{
  assert.equal(english.cancelHelp,'Cancel deletes the pending command. It does not close a valve that is already open.');
});
test('valve panel schedule help: approved English, every locale carries it, retired keys are gone',()=>{
  const raw=(locale:string)=>JSON.parse(readFileSync(`public/locales/${locale}/valves.json`,'utf8')) as Record<string,unknown>;
  assert.deepEqual({scheduleHelp:english.scheduleHelp,scheduleHelpLabel:english.scheduleHelpLabel},SCHEDULE_HELP);
  for(const locale of ['en','de-CH','fr','it','es','pt','lg']) {
    const copy=raw(locale);
    for(const key of Object.keys(SCHEDULE_HELP))assert.equal(typeof copy[key],'string',`${locale}:${key}`);
    for(const retired of ['subtitle','help','helpLabel'])assert.equal(copy[retired],undefined,`${locale}:${retired}`);
  }
  const luganda=read('lg');
  for(const key of PENDING_HUMAN_LUGANDA)assert.equal(luganda[key],english[key],`lg:${key} ships English until a human pass`);
});
