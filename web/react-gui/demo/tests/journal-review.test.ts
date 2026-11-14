import assert from 'node:assert/strict';
import {test} from 'node:test';
import {api} from '../../src/services/api';
import {journalApi} from '../../src/services/journalApi';
import {buildCatalogModel} from '../../src/journal/catalogModel';
import {buildEntryValues} from '../../src/journal/templateEngine';
import {createDemoAdapter} from '../adapter';
import {Simulator} from '../model';

function setup() {
  const sim=new Simulator({mode:'public'}); api.defaults.adapter=createDemoAdapter(sim); return sim;
}
async function fixture(activity='crop_care') {
  const catalog=await journalApi.getCatalog({includeDefinitions:true}),plot=(await journalApi.listPlots())[0]!;
  const template=catalog.templates.find(row=>row.active===1)!,layout=catalog.layouts.find(row=>row.active===1)!;
  return {catalog,plot,template,layout,fields:{plot_uuid:plot.plot_uuid,activity_code:activity,template_code:template.code,template_version:template.version,
    layout_code:layout.code,layout_version:layout.version,occurred_start_local:'2026-10-10T06:00',occurred_timezone:'Africa/Kampala',values:[]} as const};
}

test('review I1: native capture numeric outputs round-trip canonical units, zero, and missing status',async()=>{
  setup(); const {catalog,plot,template,layout}=await fixture();
  const parsed=buildCatalogModel(catalog);assert.equal(parsed.ok,true);if(!parsed.ok)return;
  const produced=buildEntryValues(parsed.model,[
    {attribute_code:'attr.water_input',value:25,unit_code:'unit.l_water'},
    {attribute_code:'attr.water_input',value:0,unit_code:'unit.l_water',group_index:1},
    {attribute_code:'attr.water_input',value_status:'not_observed',group_index:2},
    {attribute_code:'attr.amount_volume_area_product',entered_value_num:2,entered_unit_code:'unit.m3_per_ha_product',group_index:3},
  ]);
  await journalApi.createEntry({entry_uuid:'review-numeric',base_sync_version:0,status:'final',...fixtureFields(plot.plot_uuid,template.code,template.version,layout.code,layout.version),values:produced});
  const values=(await journalApi.listEntries({entry_uuid:'review-numeric'})).entries[0]!.values;
  assert.deepEqual(values.map(value=>[value.group_index,value.value_status,value.value_num,value.entered_value_num,value.unit_code]),[
    [0,'observed',25,25,'unit.l_water'],[1,'observed',0,0,'unit.l_water'],[2,'not_observed',null,null,null],
    [3,'observed',2000,2,'unit.l_per_ha_product'],
  ]);
});

test('review R1: native boolean helper values survive real entry reads as numeric 1 and 0',async()=>{
  setup();const {catalog,plot,template,layout}=await fixture();
  const parsed=buildCatalogModel(catalog);assert.equal(parsed.ok,true);if(!parsed.ok)return;
  const produced=buildEntryValues(parsed.model,[
    {attribute_code:'attr.recirculation',value:true},
    {attribute_code:'attr.recirculation',value:false,group_index:1},
  ]);
  await journalApi.createEntry({entry_uuid:'review-boolean',base_sync_version:0,status:'final',...fixtureFields(plot.plot_uuid,template.code,template.version,layout.code,layout.version),values:produced});
  const values=(await journalApi.listEntries({entry_uuid:'review-boolean'})).entries[0]!.values;
  assert.deepEqual(values.map(value=>[value.group_index,value.value_status,value.value_num,value.value_text]),[[0,'observed',1,null],[1,'observed',0,null]]);
});

test('review R2: correcting a closed opener preserves history without reopening or rewriting its cycle',async()=>{
  const sim=setup();const {catalog,plot,template,layout}=await fixture();
  const crops=catalog.vocab.filter(row=>row.kind==='choice'&&row.parent_code==='attr.crop'&&row.active===1).map(row=>row.code);
  const [crop,otherCrop]=crops;assert.ok(crop&&otherCrop&&crop!==otherCrop);
  const common={plot_uuid:plot.plot_uuid,template_code:template.code,template_version:template.version,layout_code:layout.code,layout_version:layout.version,occurred_timezone:'Africa/Kampala'};
  const seeded=await journalApi.createEntry({...common,entry_uuid:'review-r2-seed',base_sync_version:0,status:'final',activity_code:'seeding',occurred_start_local:'2026-10-10T06:00',values:[{attribute_code:'attr.crop',value:crop}]});
  const child=await journalApi.createEntry({...common,entry_uuid:'review-r2-child',base_sync_version:0,status:'final',activity_code:'crop_care',occurred_start_local:'2026-10-11T06:00',values:[]});
  const harvest=await journalApi.createEntry({...common,entry_uuid:'review-r2-harvest',base_sync_version:0,status:'final',activity_code:'harvest',occurred_start_local:'2026-10-12T06:00',values:[]});
  const historical=(await journalApi.listEntries({entry_uuid:child.entry_uuid})).entries[0]!;
  assert.equal(historical.season_crop,crop);
  const closed=(await journalApi.listEntries({entry_uuid:harvest.entry_uuid})).entries[0]!;
  assert.equal(closed.season_crop,null);assert.equal(closed.closed_crop_code,crop);
  const plotsBefore=await journalApi.listPlots(),pendingBefore=sim.request('GET','/api/sync/state');
  const frozenSeed=(await journalApi.listEntries({entry_uuid:seeded.entry_uuid})).entries[0]!;assert.equal(frozenSeed.season_crop,crop);
  await journalApi.updateEntry(seeded.entry_uuid,{...common,entry_uuid:seeded.entry_uuid,base_sync_version:frozenSeed.sync_version,status:'final',activity_code:'seeding',occurred_start_local:'2026-10-10T06:00',note:'corrected note',values:[{attribute_code:'attr.crop',value:crop}]});
  assert.equal((await journalApi.listPlots()).find(row=>row.plot_uuid===plot.plot_uuid)!.active_crop_cycles!.length,0);
  assert.deepEqual((await journalApi.listPlots()).find(row=>row.plot_uuid===plot.plot_uuid)!.active_crop_cycles,plotsBefore.find(row=>row.plot_uuid===plot.plot_uuid)!.active_crop_cycles);
  assert.equal((await journalApi.listEntries({entry_uuid:child.entry_uuid})).entries[0]?.season_crop,crop);
  const corrected=(await journalApi.listEntries({entry_uuid:seeded.entry_uuid})).entries[0]!;
  assert.equal(corrected.season_crop,crop);
  const beforeRejected={entries:await journalApi.listEntries({status:'all'}),plots:await journalApi.listPlots(),sync:sim.request('GET','/api/sync/state')};
  await assert.rejects(journalApi.updateEntry(seeded.entry_uuid,{...common,entry_uuid:seeded.entry_uuid,base_sync_version:corrected.sync_version,status:'final',activity_code:'seeding',occurred_start_local:'2026-10-09T06:00',values:[{attribute_code:'attr.crop',value:crop}]}),error=>(error as {response?:{data?:{error?:string}}}).response?.data?.error==='correction_would_desync_cycle');
  await assert.rejects(journalApi.updateEntry(seeded.entry_uuid,{...common,entry_uuid:seeded.entry_uuid,base_sync_version:corrected.sync_version,status:'final',activity_code:'seeding',occurred_start_local:'2026-10-10T06:00',values:[{attribute_code:'attr.crop',value:otherCrop}]}),error=>(error as {response?:{data?:{error?:string}}}).response?.data?.error==='correction_would_desync_cycle');
  await assert.rejects(journalApi.updateEntry(harvest.entry_uuid,{...common,entry_uuid:harvest.entry_uuid,base_sync_version:harvest.sync_version,status:'final',activity_code:'harvest',occurred_start_local:'2026-10-13T06:00',values:[]}),error=>(error as {response?:{data?:{error?:string}}}).response?.data?.error==='correction_would_desync_cycle');
  assert.deepEqual(await journalApi.listEntries({status:'all'}),beforeRejected.entries);assert.deepEqual(await journalApi.listPlots(),beforeRejected.plots);assert.deepEqual(sim.request('GET','/api/sync/state'),beforeRejected.sync);
  assert.ok(Number((pendingBefore as {pendingOutboxCount:number}).pendingOutboxCount)<Number((beforeRejected.sync as {pendingOutboxCount:number}).pendingOutboxCount));
  await journalApi.createEntry({...common,entry_uuid:'review-r2-reseed',base_sync_version:0,status:'final',activity_code:'seeding',occurred_start_local:'2026-10-13T06:00',values:[{attribute_code:'attr.crop',value:otherCrop}]});
  const cycles=(sim as unknown as {journal:{cycles:Map<string,{ended_by_entry_uuid?:string;crop_code:string}>}}).journal.cycles;
  assert.equal(cycles.size,2);assert.ok([...cycles.values()].some(cycle=>cycle.crop_code===crop&&cycle.ended_by_entry_uuid===harvest.entry_uuid));
  assert.equal((await journalApi.listPlots()).find(row=>row.plot_uuid===plot.plot_uuid)!.active_crop_cycles![0]?.crop_code,otherCrop);
});

test('review R2 same-date reseed: boundary entries remain ambiguous while earlier entries freeze to the old crop',async()=>{
  setup();const {catalog,plot,template,layout}=await fixture();const crops=catalog.vocab.filter(row=>row.kind==='choice'&&row.parent_code==='attr.crop'&&row.active===1).map(row=>row.code),[crop,replacement]=crops;
  assert.ok(crop&&replacement&&crop!==replacement);const common={plot_uuid:plot.plot_uuid,template_code:template.code,template_version:template.version,layout_code:layout.code,layout_version:layout.version,occurred_timezone:'Africa/Kampala'};
  await journalApi.createEntry({...common,entry_uuid:'review-r2-boundary-seed',base_sync_version:0,status:'final',activity_code:'seeding',occurred_start_local:'2026-10-10T06:00',values:[{attribute_code:'attr.crop',value:crop}]});
  const earlier=await journalApi.createEntry({...common,entry_uuid:'review-r2-before-boundary',base_sync_version:0,status:'final',activity_code:'crop_care',occurred_start_local:'2026-10-11T06:00',values:[]});
  const boundary=await journalApi.createEntry({...common,entry_uuid:'review-r2-on-boundary',base_sync_version:0,status:'final',activity_code:'crop_care',occurred_start_local:'2026-10-12T04:00',values:[]});
  const reseed=await journalApi.createEntry({...common,entry_uuid:'review-r2-boundary-reseed',base_sync_version:0,status:'final',activity_code:'seeding',occurred_start_local:'2026-10-12T06:00',values:[{attribute_code:'attr.crop',value:replacement}]});
  assert.equal((await journalApi.listEntries({entry_uuid:earlier.entry_uuid})).entries[0]?.season_crop,crop);
  assert.equal((await journalApi.listEntries({entry_uuid:boundary.entry_uuid})).entries[0]?.season_crop,null);
  assert.equal((await journalApi.listEntries({entry_uuid:reseed.entry_uuid})).entries[0]?.season_crop,null);
});

test('review R2 closer projection: note corrections derive closed crop and void removes the projection',async()=>{
  setup();const {catalog,plot,template,layout}=await fixture(),crop=catalog.vocab.find(row=>row.kind==='choice'&&row.parent_code==='attr.crop'&&row.active===1)!.code;
  const common={plot_uuid:plot.plot_uuid,template_code:template.code,template_version:template.version,layout_code:layout.code,layout_version:layout.version,occurred_timezone:'Africa/Kampala'};
  await journalApi.createEntry({...common,entry_uuid:'review-r2-projection-seed',base_sync_version:0,status:'final',activity_code:'seeding',occurred_start_local:'2026-10-10T06:00',values:[{attribute_code:'attr.crop',value:crop}]});
  const harvest=await journalApi.createEntry({...common,entry_uuid:'review-r2-projection-harvest',base_sync_version:0,status:'final',activity_code:'harvest',occurred_start_local:'2026-10-11T06:00',values:[]});
  const correction=await journalApi.updateEntry(harvest.entry_uuid,{...common,entry_uuid:harvest.entry_uuid,base_sync_version:harvest.sync_version,status:'final',activity_code:'harvest',occurred_start_local:'2026-10-11T06:00',note:'corrected harvest note',values:[]});
  assert.equal((await journalApi.listEntries({entry_uuid:harvest.entry_uuid})).entries[0]?.closed_crop_code,crop);
  await journalApi.voidEntry(harvest.entry_uuid,'wrong harvest',correction.sync_version);
  const voided=(await journalApi.listEntries({entry_uuid:harvest.entry_uuid,status:'all'})).entries[0]!;
  assert.equal(voided.closed_crop_code,undefined);
});

test('review R2 reopen collision: old harvest void rejects atomically until the newer crop cycle is voided',async()=>{
  const sim=setup();const {catalog,plot,template,layout}=await fixture(),crops=catalog.vocab.filter(row=>row.kind==='choice'&&row.parent_code==='attr.crop'&&row.active===1).map(row=>row.code),[crop,nextCrop]=crops;
  assert.ok(crop&&nextCrop&&crop!==nextCrop);const common={plot_uuid:plot.plot_uuid,template_code:template.code,template_version:template.version,layout_code:layout.code,layout_version:layout.version,occurred_timezone:'Africa/Kampala'};
  await journalApi.createEntry({...common,entry_uuid:'review-r2-collision-seed-a',base_sync_version:0,status:'final',activity_code:'seeding',occurred_start_local:'2026-10-10T06:00',values:[{attribute_code:'attr.crop',value:crop}]});
  const harvest=await journalApi.createEntry({...common,entry_uuid:'review-r2-collision-harvest-a',base_sync_version:0,status:'final',activity_code:'harvest',occurred_start_local:'2026-10-11T06:00',values:[]});
  const nextSeed=await journalApi.createEntry({...common,entry_uuid:'review-r2-collision-seed-b',base_sync_version:0,status:'final',activity_code:'seeding',occurred_start_local:'2026-10-12T06:00',values:[{attribute_code:'attr.crop',value:nextCrop}]});
  const state=(sim as unknown as {journal:{entries:Map<string,unknown>;cycles:Map<string,unknown>;sequence:number}}).journal;
  const before={entries:await journalApi.listEntries({status:'all'}),plots:await journalApi.listPlots(),cycles:structuredClone([...state.cycles]),sequence:state.sequence,sync:sim.request('GET','/api/sync/state')};
  await assert.rejects(journalApi.voidEntry(harvest.entry_uuid,'wrong old harvest',harvest.sync_version),error=>{
    const response=(error as {response?:{status?:number;data?:{error?:string;details?:{collidingCycleUuid?:string}}}}).response;
    assert.equal(response?.status,409);assert.equal(response?.data?.error,'reopen_collision');assert.equal(typeof response?.data?.details?.collidingCycleUuid,'string');return true;
  });
  assert.deepEqual(await journalApi.listEntries({status:'all'}),before.entries);assert.deepEqual(await journalApi.listPlots(),before.plots);assert.deepEqual([...state.cycles],before.cycles);assert.equal(state.sequence,before.sequence);assert.deepEqual(sim.request('GET','/api/sync/state'),before.sync);
  await journalApi.voidEntry(nextSeed.entry_uuid,'remove conflicting new seeding',nextSeed.sync_version);
  await journalApi.voidEntry(harvest.entry_uuid,'reopen old crop',harvest.sync_version);
  const active=(await journalApi.listPlots()).find(row=>row.plot_uuid===plot.plot_uuid)!.active_crop_cycles!;
  assert.deepEqual(active.map(cycle=>cycle.crop_code),[crop]);
});

test('review R2 self-collision: voiding a reseed reopens its superseded crop cycle',async()=>{
  setup();const {catalog,plot,template,layout}=await fixture(),crops=catalog.vocab.filter(row=>row.kind==='choice'&&row.parent_code==='attr.crop'&&row.active===1).map(row=>row.code),[crop,nextCrop]=crops;
  assert.ok(crop&&nextCrop&&crop!==nextCrop);const common={plot_uuid:plot.plot_uuid,template_code:template.code,template_version:template.version,layout_code:layout.code,layout_version:layout.version,occurred_timezone:'Africa/Kampala'};
  await journalApi.createEntry({...common,entry_uuid:'review-r2-self-collision-seed-a',base_sync_version:0,status:'final',activity_code:'seeding',occurred_start_local:'2026-10-10T06:00',values:[{attribute_code:'attr.crop',value:crop}]});
  const reseed=await journalApi.createEntry({...common,entry_uuid:'review-r2-self-collision-seed-b',base_sync_version:0,status:'final',activity_code:'seeding',occurred_start_local:'2026-10-12T06:00',values:[{attribute_code:'attr.crop',value:nextCrop}]});
  assert.deepEqual((await journalApi.listPlots()).find(row=>row.plot_uuid===plot.plot_uuid)!.active_crop_cycles!.map(cycle=>cycle.crop_code),[nextCrop]);
  const voided=await journalApi.voidEntry(reseed.entry_uuid,'undo replacement seeding',reseed.sync_version);
  assert.equal(voided.status,'voided');
  assert.deepEqual((await journalApi.listPlots()).find(row=>row.plot_uuid===plot.plot_uuid)!.active_crop_cycles!.map(cycle=>cycle.crop_code),[crop]);
});

test('review R3: batch provenance is immutable, including omitted and explicit-null correction payloads',async()=>{
  const sim=setup();const {fields}=await fixture();
  const created=await journalApi.createEntry({...fields,entry_uuid:'review-r3-entry',base_sync_version:0,status:'final',batch_uuid:'review-r3-batch'});
  const omitted=await journalApi.updateEntry(created.entry_uuid,{...fields,entry_uuid:created.entry_uuid,base_sync_version:created.sync_version,status:'final',note:'omitted batch field'});
  assert.equal((await journalApi.listEntries({batch_uuid:'review-r3-batch'})).entries[0]?.entry_uuid,created.entry_uuid);
  const same=await journalApi.updateEntry(created.entry_uuid,{...fields,entry_uuid:created.entry_uuid,base_sync_version:omitted.sync_version,status:'final',note:'same batch',batch_uuid:'review-r3-batch'});
  const stateBefore=await journalApi.listEntries({status:'all'}),syncBefore=sim.request('GET','/api/sync/state');
  for(const batch_uuid of ['different-batch',null])await assert.rejects(journalApi.updateEntry(created.entry_uuid,{...fields,entry_uuid:created.entry_uuid,base_sync_version:same.sync_version,status:'final',note:'invalid batch change',batch_uuid}),error=>(error as {response?:{data?:{error?:string}}}).response?.data?.error==='immutable_batch_uuid');
  assert.deepEqual(await journalApi.listEntries({status:'all'}),stateBefore);assert.deepEqual(sim.request('GET','/api/sync/state'),syncBefore);
  assert.equal((await journalApi.listEntries({batch_uuid:'review-r3-batch'})).entries[0]?.batch_uuid,'review-r3-batch');
});

test('review R4: resolved group rejects additions, removals and replacements atomically until explicitly unresolved',async()=>{
  const sim=setup();const plots=await journalApi.listPlots(),members=[plots[0]!.plot_uuid],created=await journalApi.createPlotGroup({group_uuid:'review-r4-group',base_sync_version:0,label:'Frozen group',members,resolved:true});
  const snapshot={group:(await journalApi.listPlotGroups()).find(group=>group.group_uuid===created.group_uuid),sync:sim.request('GET','/api/sync/state')};
  for(const next of [[...members,plots[1]!.plot_uuid],[],[plots[1]!.plot_uuid]])await assert.rejects(journalApi.updatePlotGroup(created.group_uuid,{...created,base_sync_version:created.sync_version,resolved:true,members:next}),error=>(error as {response?:{data?:{error?:string}}}).response?.data?.error==='resolved_group_members_frozen');
  assert.deepEqual((await journalApi.listPlotGroups()).find(group=>group.group_uuid===created.group_uuid),snapshot.group);assert.deepEqual(sim.request('GET','/api/sync/state'),snapshot.sync);
  const edited=await journalApi.updatePlotGroup(created.group_uuid,{...created,base_sync_version:created.sync_version,resolved:false,members:[...members,plots[1]!.plot_uuid]});
  assert.equal(edited.resolved_at,null);assert.deepEqual(edited.members.sort(),[...members,plots[1]!.plot_uuid].sort());
});

function fixtureFields(plot:string,tc:string,tv:number,lc:string,lv:number) {return {plot_uuid:plot,activity_code:'crop_care',template_code:tc,template_version:tv,layout_code:lc,layout_version:lv,
  occurred_start_local:'2026-10-10T06:00',occurred_timezone:'Africa/Kampala',values:[]};}

test('review I2: rejected create and void preserve entries, cycles, sync state and version',async()=>{
  const sim=setup(),{fields}=await fixture();
  const before={entries:await journalApi.listEntries({status:'all'}),plots:await journalApi.listPlots(),sync:sim.request('GET','/api/sync/state')};
  await assert.rejects(journalApi.createEntry({...fields,entry_uuid:'review-no-crop',base_sync_version:0,status:'final',activity_code:'seeding'}));
  assert.deepEqual(await journalApi.listEntries({status:'all'}),before.entries);
  assert.deepEqual(await journalApi.listPlots(),before.plots);assert.deepEqual(sim.request('GET','/api/sync/state'),before.sync);
  await journalApi.createEntry({...fields,entry_uuid:'review-correction-fail',base_sync_version:0,status:'draft',activity_code:'seeding'});
  const draftSync=sim.request('GET','/api/sync/state');
  await assert.rejects(journalApi.updateEntry('review-correction-fail',{...fields,entry_uuid:'review-correction-fail',base_sync_version:0,status:'final',activity_code:'seeding'}));
  assert.equal((await journalApi.listEntries({entry_uuid:'review-correction-fail',status:'all'})).entries[0]?.status,'draft');
  assert.deepEqual(sim.request('GET','/api/sync/state'),draftSync);
  const created=await journalApi.createEntry({...fields,entry_uuid:'review-void',base_sync_version:0,status:'final'});
  await assert.rejects(journalApi.voidEntry(created.entry_uuid,'',created.sync_version));
  assert.equal((await journalApi.listEntries({entry_uuid:created.entry_uuid})).entries[0]?.sync_version,created.sync_version);
  assert.deepEqual(sim.request('GET','/api/sync/state'),{...before.sync,pendingOutboxCount:1});
  await journalApi.voidEntry(created.entry_uuid,'valid reason',created.sync_version);
  const voided=(await journalApi.listEntries({entry_uuid:created.entry_uuid,status:'all'})).entries[0]!;
  const afterVoid=sim.request('GET','/api/sync/state');
  await assert.rejects(journalApi.voidEntry(created.entry_uuid,'second void',voided.sync_version));
  assert.deepEqual(sim.request('GET','/api/sync/state'),afterVoid);
});

test('review I9: local occurrence resolver honors seconds and explicit DST offsets, rejecting gaps',async()=>{
  setup();const {fields}=await fixture();
  const common={...fields,base_sync_version:0,status:'final' as const};
  await assert.rejects(journalApi.createEntry({...common,entry_uuid:'review-gap',occurred_start_local:'2026-03-29T02:30',occurred_timezone:'Europe/Zurich',occurred_utc_offset_minutes:60}));
  const first=await journalApi.createEntry({...common,entry_uuid:'review-fold-first',occurred_start_local:'2026-10-25T02:30:15',occurred_timezone:'Europe/Zurich',occurred_utc_offset_minutes:120});
  const second=await journalApi.createEntry({...common,entry_uuid:'review-fold-second',plot_uuid:(await journalApi.listPlots())[1]!.plot_uuid,occurred_start_local:'2026-10-25T02:30:15',occurred_timezone:'Europe/Zurich',occurred_utc_offset_minutes:60});
  const firstEntry=(await journalApi.listEntries({entry_uuid:first.entry_uuid})).entries[0]!,secondEntry=(await journalApi.listEntries({entry_uuid:second.entry_uuid})).entries[0]!;
  assert.equal(firstEntry.occurred_start,'2026-10-25T00:30:15.000Z');assert.equal(firstEntry.occurred_utc_offset_minutes,120);
  assert.equal(secondEntry.occurred_start,'2026-10-25T01:30:15.000Z');assert.equal(secondEntry.occurred_utc_offset_minutes,60);
});

test('review I3: ordinary harvest closes and void reopens a retained local-date cycle',async()=>{
  setup();const {catalog,plot,template,layout}=await fixture(),crop=catalog.vocab.find(row=>row.kind==='choice'&&row.parent_code==='attr.crop'&&row.active===1)!.code;
  const common={plot_uuid:plot.plot_uuid,template_code:template.code,template_version:template.version,layout_code:layout.code,layout_version:layout.version,occurred_timezone:'Africa/Kampala'};
  await journalApi.createEntry({...common,entry_uuid:'review-seed',base_sync_version:0,status:'final',activity_code:'seeding',occurred_start_local:'2026-10-10T00:15',values:[{attribute_code:'attr.crop',value:crop}]});
  const opened=(await journalApi.listPlots()).find(row=>row.plot_uuid===plot.plot_uuid)!.active_crop_cycles![0]!;
  assert.ok(opened);
  assert.equal(opened.seeded_on,'2026-10-10');
  const harvest=await journalApi.createEntry({...common,entry_uuid:'review-harvest',base_sync_version:0,status:'final',activity_code:'harvest',occurred_start_local:'2026-10-11T00:15',values:[]});
  assert.equal((await journalApi.listPlots()).find(row=>row.plot_uuid===plot.plot_uuid)!.active_crop_cycles!.length,0);
  const harvested=(await journalApi.listEntries({entry_uuid:harvest.entry_uuid})).entries[0]!;
  assert.equal(harvested.season_crop,null);assert.equal(harvested.closed_crop_code,crop);
  await journalApi.voidEntry(harvest.entry_uuid,'mistaken harvest',harvest.sync_version);
  assert.equal((await journalApi.listPlots()).find(row=>row.plot_uuid===plot.plot_uuid)!.active_crop_cycles![0]?.cycle_uuid,opened.cycle_uuid);
});

test('review I3: intercropped harvest requires a cycle UUID and closes only the selected cycle',async()=>{
  const sim=setup();const {catalog,plot,template,layout}=await fixture(),crop=catalog.vocab.find(row=>row.kind==='choice'&&row.parent_code==='attr.crop'&&row.active===1)!.code;
  await journalApi.createEntry({entry_uuid:'review-intercrop-seed',base_sync_version:0,status:'final',plot_uuid:plot.plot_uuid,activity_code:'seeding',template_code:template.code,template_version:template.version,layout_code:layout.code,layout_version:layout.version,occurred_start_local:'2026-10-10T06:00',occurred_timezone:'Africa/Kampala',values:[{attribute_code:'attr.crop',value:crop}]});
  const state=(sim as unknown as {journal:{cycles:Map<string,{cycle_uuid:string;plot_uuid:string;crop_code:string;variety:null;seeded_on:string;opened_by_entry_uuid:string}>}}).journal;
  state.cycles.set('cycle-intercrop-2',{cycle_uuid:'cycle-intercrop-2',plot_uuid:plot.plot_uuid,crop_code:crop,variety:null,seeded_on:'2026-10-10',opened_by_entry_uuid:'legacy-intercrop-seed'});
  const harvest={entry_uuid:'review-intercrop-harvest',base_sync_version:0,status:'final' as const,plot_uuid:plot.plot_uuid,activity_code:'harvest',template_code:template.code,template_version:template.version,layout_code:layout.code,layout_version:layout.version,occurred_start_local:'2026-10-11T06:00',occurred_timezone:'Africa/Kampala',values:[]};
  await assert.rejects(journalApi.createEntry(harvest),error=>(error as {response?:{data?:{error?:string;details?:{openCycles?:unknown[]}}}}).response?.data?.error==='cycle_uuid_required');
  await journalApi.createEntry({...harvest,cycle_uuid:openedCycle(state.cycles,plot.plot_uuid)});
  assert.equal((await journalApi.listPlots()).find(row=>row.plot_uuid===plot.plot_uuid)!.active_crop_cycles!.length,1);
});

function openedCycle(cycles:Map<string,{cycle_uuid:string;plot_uuid:string}>,plotUuid:string):string{return [...cycles.values()].find(cycle=>cycle.plot_uuid===plotUuid)!.cycle_uuid;}

test('review I3: correction cannot remove a crop cycle while dependent entries remain',async()=>{
  setup();const {catalog,plot,template,layout}=await fixture(),crop=catalog.vocab.find(row=>row.kind==='choice'&&row.parent_code==='attr.crop'&&row.active===1)!.code;
  const fields={plot_uuid:plot.plot_uuid,template_code:template.code,template_version:template.version,layout_code:layout.code,layout_version:layout.version,occurred_start_local:'2026-10-10T06:00',occurred_timezone:'Africa/Kampala'};
  const seedEntry=await journalApi.createEntry({...fields,entry_uuid:'review-guard-seed',base_sync_version:0,status:'final',activity_code:'seeding',values:[{attribute_code:'attr.crop',value:crop}]});
  await journalApi.createEntry({...fields,entry_uuid:'review-guard-child',base_sync_version:0,status:'final',activity_code:'crop_care',values:[]});
  await assert.rejects(journalApi.updateEntry(seedEntry.entry_uuid,{...fields,entry_uuid:seedEntry.entry_uuid,base_sync_version:seedEntry.sync_version,status:'final',activity_code:'crop_care',values:[]}),error=>
    (error as {response?:{data?:{error?:string;details?:{dependentEntryUuids?:string[]}}}}).response?.data?.error==='cycle_has_dependents');
  assert.equal((await journalApi.listPlots()).find(row=>row.plot_uuid===plot.plot_uuid)!.active_crop_cycles!.length,1);
});

test('review I4: station scope, final default, filter-bound keyset cursor and exclusive scopes',async()=>{
  setup();const {plot,template,layout}=await fixture(),plots=await journalApi.listPlots(),first=plots[0]!,second=plots[1]!;
  await journalApi.updatePlot(first.plot_uuid,{...first,base_sync_version:first.sync_version,station_code:'Station 1',plot_code:first.plot_code,layout_code:first.settings.layout_code,layout_version:1});
  const common={template_code:template.code,template_version:template.version,layout_code:layout.code,layout_version:layout.version,occurred_timezone:'Africa/Kampala',activity_code:'crop_care',values:[]};
  await journalApi.createEntry({...common,plot_uuid:first.plot_uuid,entry_uuid:'review-final',base_sync_version:0,status:'final',occurred_start_local:'2026-10-10T08:00'});
  await journalApi.createEntry({...common,plot_uuid:first.plot_uuid,entry_uuid:'review-draft',base_sync_version:0,status:'draft',occurred_start_local:'2026-10-10T07:00'});
  assert.deepEqual((await journalApi.listEntries({station_code:'Station 1'})).entries.map(row=>row.entry_uuid),['review-final']);
  const a=await journalApi.listEntries({activity_code:'crop_care',status:'all',limit:1});assert.ok(a.next_cursor);
  await assert.rejects(journalApi.listEntries({activity_code:'fertilisation',status:'all',limit:1,cursor:a.next_cursor!}),error=>
    (error as {response?:{data?:{error?:string}}}).response?.data?.error==='invalid_cursor');
  await assert.rejects(journalApi.listEntries({plot_uuid:first.plot_uuid,station_code:'Station 1'}),error=>
    (error as {response?:{data?:{error?:string}}}).response?.data?.error==='conflicting_scope_filters');
  await assert.rejects(journalApi.listEntries({plot_uuid:'missing-plot'}),error=>(error as {response?:{data?:{error?:string}}}).response?.data?.error==='scope_not_found');
  await journalApi.createEntry({...common,plot_uuid:second.plot_uuid,entry_uuid:'review-page-a',base_sync_version:0,status:'final',occurred_start_local:'2026-10-10T06:00'});
  await journalApi.createEntry({...common,plot_uuid:second.plot_uuid,entry_uuid:'review-page-b',base_sync_version:0,status:'final',occurred_start_local:'2026-10-10T04:30'});
  const page1=await journalApi.listEntries({plot_uuid:second.plot_uuid,status:'all',limit:1,occurred_from:'2026-10-10T00:00:00+03:00'});
  assert.ok(page1.next_cursor);
  await journalApi.createEntry({...common,plot_uuid:second.plot_uuid,entry_uuid:'review-insert-newer',base_sync_version:0,status:'draft',occurred_start_local:'2026-10-10T09:00'});
  const page2=await journalApi.listEntries({plot_uuid:second.plot_uuid,status:'all',limit:1,occurred_from:'2026-10-10T00:00:00+03:00',cursor:page1.next_cursor!});
  assert.notEqual(page2.entries[0]?.entry_uuid,'review-insert-newer');
  void plot;
});

test('review I5: batch duplicate candidates use the plural acknowledgement contract and retain member values',async()=>{
  setup();const {plot,template,layout}=await fixture(),plots=await journalApi.listPlots(),common={activity_code:'crop_care',template_code:template.code,template_version:template.version,
    layout_code:layout.code,layout_version:layout.version,occurred_start_local:'2026-10-10T06:00',occurred_timezone:'Africa/Kampala',values:[]};
  await journalApi.createEntry({...common,plot_uuid:plot.plot_uuid,entry_uuid:'review-existing',base_sync_version:0,status:'final'});
  const batch={...common,status:'final' as const,base_sync_version:0 as const,batch_uuid:'review-batch',members:[
    {plot_uuid:plots[0]!.plot_uuid,entry_uuid:'review-batch-a',values:[{attribute_code:'attr.actuation_expectation_id',value:'one'}]},
    {plot_uuid:plots[1]!.plot_uuid,entry_uuid:'review-batch-b',values:[{attribute_code:'attr.actuation_expectation_id',value:'two'}]},
  ]};
  await assert.rejects(journalApi.createFinalBatch(batch),error=>{
    const response=(error as {response?:{data?:{error?:string;details?:{duplicateCandidates?:unknown[]}}}}).response?.data;
    assert.equal(response?.error,'duplicate_candidates');assert.ok(response?.details?.duplicateCandidates?.length);return true;
  });
  const done=await journalApi.createFinalBatch({...batch,duplicate_guard_ack_entry_uuids:['review-existing']});
  assert.equal(done.entries.length,2);
  assert.deepEqual((await journalApi.listEntries({batch_uuid:'review-batch'})).entries.map(row=>row.values[0]?.value_text),['one','two']);
});

test('review I6: final corrections cannot downgrade and preserve immutable provenance',async()=>{
  setup();const {fields}=await fixture();const created=await journalApi.createEntry({...fields,entry_uuid:'review-correction',base_sync_version:0,status:'final'});
  const before=(await journalApi.listEntries({entry_uuid:created.entry_uuid})).entries[0]!;
  await assert.rejects(journalApi.updateEntry(created.entry_uuid,{...fields,status:'draft',base_sync_version:created.sync_version}),error=>
    (error as {response?:{data?:{error?:string}}}).response?.data?.error==='invalid_state');
  assert.deepEqual((await journalApi.listEntries({entry_uuid:created.entry_uuid})).entries[0],before);
});

test('review I6: note-only correction preserves captured context, author, origin and recorded time',async()=>{
  setup();let {plot,template,layout}=await fixture();
  plot=await journalApi.updatePlot(plot.plot_uuid,{...plot,base_sync_version:plot.sync_version,layout_code:plot.settings.layout_code,layout_version:1,context_json:'{"captured":"old"}'});
  const created=await journalApi.createEntry({entry_uuid:'review-context',base_sync_version:0,status:'final',plot_uuid:plot.plot_uuid,activity_code:'crop_care',template_code:template.code,template_version:template.version,
    layout_code:layout.code,layout_version:layout.version,occurred_start_local:'2026-10-10T06:00',occurred_timezone:'Africa/Kampala',values:[]});
  const before=(await journalApi.listEntries({entry_uuid:created.entry_uuid})).entries[0]!;
  await journalApi.updatePlot(plot.plot_uuid,{...plot,base_sync_version:plot.sync_version,layout_code:plot.settings.layout_code,layout_version:1,context_json:'{"captured":"new"}'});
  await journalApi.updateEntry(created.entry_uuid,{entry_uuid:created.entry_uuid,base_sync_version:created.sync_version,status:'final',plot_uuid:plot.plot_uuid,activity_code:'crop_care',template_code:template.code,template_version:template.version,
    layout_code:layout.code,layout_version:layout.version,occurred_start_local:'2026-10-10T06:00',occurred_timezone:'Africa/Kampala',values:[],note:'corrected'});
  const after=(await journalApi.listEntries({entry_uuid:created.entry_uuid})).entries[0]!;
  assert.equal(after.context_json,before.context_json);assert.equal(after.recorded_at,before.recorded_at);assert.equal(after.author_principal_uuid,before.author_principal_uuid);assert.equal(after.origin,before.origin);
});

test('review I8: native plot codes and resolved empty groups are accepted; invalid areas and duplicate members reject',async()=>{
  setup();const {plot}=await fixture();
  const created=await journalApi.createPlot({plot_uuid:'review-plot',base_sync_version:0,plot_code:'Plot 3',name:'Plot three',zone_uuid:null,station_code:null,crop_hint:null,area_m2:12,active:1,layout_code:'open_field',layout_version:1});
  assert.equal(created.plot_code,'Plot 3');
  await assert.rejects(journalApi.createPlot({plot_uuid:'review-bad-area',base_sync_version:0,plot_code:'Plot 4',name:null,zone_uuid:null,station_code:null,crop_hint:null,area_m2:0,active:1,layout_code:'open_field',layout_version:1}),error=>
    (error as {response?:{data?:{error?:string}}}).response?.data?.error==='invalid_area');
  const empty=await journalApi.createPlotGroup({group_uuid:'review-empty',base_sync_version:0,label:'Empty resolved group',members:[],resolved:true});assert.deepEqual(empty.members,[]);
  await assert.rejects(journalApi.createPlotGroup({group_uuid:'review-duplicates',base_sync_version:0,label:'Duplicate members',members:[plot.plot_uuid,plot.plot_uuid],resolved:false}),error=>
    (error as {response?:{data?:{error?:string}}}).response?.data?.error==='duplicate_member');
});
