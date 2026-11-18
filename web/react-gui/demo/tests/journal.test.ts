import assert from 'node:assert/strict';
import {test} from 'node:test';
import {api} from '../../src/services/api';
import {journalApi} from '../../src/services/journalApi';
import {buildCatalogModel, deriveActivityLeaves} from '../../src/journal/catalogModel';
import {buildEntryValues} from '../../src/journal/templateEngine';
import {buildCopyPayload} from '../../src/journal/entryCopy';
import {createDemoAdapter} from '../adapter';
import {Simulator} from '../model';

function install(sim = new Simulator({mode: 'public'})) {
  api.defaults.adapter = createDemoAdapter(sim);
  return sim;
}

test('journal catalog comes from the complete active seed vocabulary with capture definitions', async () => {
  install();
  const catalog = await journalApi.getCatalog({includeDefinitions: true});
  assert.equal(catalog.catalog_version, 11);
  assert.ok(catalog.vocab.length > 100);
  assert.equal(catalog.templates.length, 14);
  assert.equal(catalog.layouts.length, 13);
  assert.ok(catalog.templates.every(row => row.definition && Object.keys(row.definition).length));
  assert.ok(catalog.layouts.some(row => row.code === 'agroscope_open_field'));
});

test('native capture helpers resolve all active catalog choices and copied entries get a fresh version-zero identity', async () => {
  install();
  const catalog=await journalApi.getCatalog({includeDefinitions:true}),parsed=buildCatalogModel(catalog);
  assert.equal(parsed.ok,true);
  if(!parsed.ok)return;
  const activeLayouts=[...parsed.model.layouts.values()];
  const leaves=activeLayouts.flatMap(layout=>deriveActivityLeaves(parsed.model,layout));
  assert.ok(leaves.length>100);
  assert.ok(leaves.some(leaf=>leaf.activity_code==='seeding'));
  const template=catalog.templates.find(row=>row.code==='farmer_quick'&&row.active===1)!,layout=catalog.layouts.find(row=>row.code==='open_field'&&row.active===1)!;
  const plot=(await journalApi.listPlots())[0]!,activity='irrigation';
  const receipt=await journalApi.createEntry({entry_uuid:'copy-source',base_sync_version:0,status:'final',plot_uuid:plot.plot_uuid,activity_code:activity,
    template_code:template.code,template_version:template.version,layout_code:layout.code,layout_version:layout.version,
    occurred_start_local:'2026-10-10T06:00',occurred_timezone:'Africa/Kampala',values:[]});
  const aggregate=(await journalApi.listEntries({entry_uuid:receipt.entry_uuid})).entries[0]!;
  const copy=buildCopyPayload(aggregate,new Set(),[],{occurred_start_local:'2026-10-10T07:00',occurred_timezone:'Africa/Kampala',occurred_utc_offset_minutes:180,
    zone_uuid:plot.zone_uuid,season_crop:null,season_variety:null,template_code:template.code,template_version:template.version,layout_code:layout.code,layout_version:layout.version,note:null},'copy-fresh');
  assert.notEqual(copy.entry_uuid,aggregate.entry_uuid);
  assert.equal(copy.base_sync_version,0);
  assert.equal(copy.status,'final');
});

test('journal plot and group client mutations are versioned, readable, and pending sync work once', async () => {
  const sim = install();
  const before = (await journalApi.listPlots()).length;
  const plotUuid = 'sim-plot-new-01';
  const plot = await journalApi.createPlot({plot_uuid: plotUuid, base_sync_version: 0, plot_code: 'DEMO-3', name: 'New bed',
    zone_uuid: null, station_code: null, crop_hint: 'tomato', area_m2: 12, active: 1, layout_code: 'open_field', layout_version: 1});
  assert.equal(plot.sync_version, 1);
  assert.equal((await journalApi.listPlots()).length, before + 1);
  const group = await journalApi.createPlotGroup({group_uuid: 'sim-group-01', base_sync_version: 0, label: 'North beds', members: [plotUuid], resolved: true});
  assert.deepEqual(group.members, [plotUuid]);
  assert.equal((await journalApi.listPlotGroups())[0]?.group_uuid, group.group_uuid);
  const status = sim.request('GET', '/api/sync/state') as {pendingOutboxCount: number};
  assert.equal(status.pendingOutboxCount, 2);
});

test('journal draft finalize correction and stale base use actual client receipts and dependent reads', async () => {
  install();
  const catalog = await journalApi.getCatalog({includeDefinitions: true});
  const activity = catalog.vocab.find(row => row.kind === 'activity' && row.active === 1)!.code;
  const template = catalog.templates.find(row => row.active === 1)!;
  const layout = catalog.layouts.find(row => row.active === 1)!;
  const plots = await journalApi.listPlots();
  const uuid = 'sim-entry-draft-01';
  const common = {plot_uuid: plots[0]!.plot_uuid, activity_code: activity, template_code: template.code, template_version: template.version,
    layout_code: layout.code, layout_version: layout.version, occurred_start_local: '2026-10-10T06:00', occurred_timezone: 'Africa/Kampala', values: [], note: 'seed note'} as const;
  const draft = await journalApi.createEntry({...common, entry_uuid: uuid, status: 'draft', base_sync_version: 0});
  assert.equal(draft.sync_version, 0);
  assert.equal((await journalApi.listEntries({entry_uuid: uuid,status:'all'})).entries[0]?.note, 'seed note');
  const final = await journalApi.updateEntry(uuid, {...common, status: 'final', base_sync_version: 0});
  assert.equal(final.sync_version, 1);
  const correction = await journalApi.updateEntry(uuid, {...common, status: 'final', note: 'corrected', base_sync_version: 1});
  assert.equal(correction.sync_version, 2);
  assert.equal((await journalApi.listEntries({entry_uuid: uuid})).entries[0]?.note, 'corrected');
  await assert.rejects(journalApi.updateEntry(uuid, {...common, status: 'final', note: 'stale', base_sync_version: 1}), error =>
    (error as {response?: {status?: number}}).response?.status === 409);
  assert.equal((await journalApi.listEntries({entry_uuid: uuid})).entries[0]?.note, 'corrected');
});

test('journal group, date, status, activity, and cursor filters compose over complete entry aggregates', async () => {
  install();
  const catalog = await journalApi.getCatalog({includeDefinitions: true}), plots = await journalApi.listPlots();
  const template = catalog.templates.find(row => row.active === 1)!, layout = catalog.layouts.find(row => row.active === 1)!;
  const activities = catalog.vocab.filter(row => row.kind === 'activity' && row.active === 1).slice(0, 2);
  await journalApi.createPlotGroup({group_uuid: 'filter-group', base_sync_version: 0, label: 'First plot', members: [plots[0]!.plot_uuid], resolved: true});
  const make = (uuid: string, plotUuid: string, activity: string, local: string) => journalApi.createEntry({entry_uuid: uuid, base_sync_version: 0,
    status: 'final', plot_uuid: plotUuid, activity_code: activity, template_code: template.code, template_version: template.version,
    layout_code: layout.code, layout_version: layout.version, occurred_start_local: local, occurred_timezone: 'Africa/Kampala', values: [], note: uuid});
  await make('filter-entry-1', plots[0]!.plot_uuid, activities[0]!.code, '2026-10-10T05:00');
  await make('filter-entry-2', plots[1]!.plot_uuid, activities[0]!.code, '2026-10-10T06:00');
  const filtered = await journalApi.listEntries({group_uuid: 'filter-group', status: 'final', activity_code: activities[0]!.code,
    occurred_from: '2026-10-10T00:00:00.000Z', occurred_to: '2026-10-10T23:59:59.999Z', limit: 1});
  assert.deepEqual(filtered.entries.map(row => row.entry_uuid), ['filter-entry-1']);
  assert.equal(filtered.entries[0]?.owner_user_uuid, '00000000-0000-4000-8000-000000000001');
  assert.equal((await journalApi.listEntries({status: 'draft'})).entries.length, 0);
  const page1 = await journalApi.listEntries({status:'final',limit:1});
  assert.ok(page1.next_cursor);
  const page2 = await journalApi.listEntries({status:'final',limit:1,cursor:page1.next_cursor!});
  assert.equal(page2.entries.some(row=>row.entry_uuid===page1.entries[0]?.entry_uuid),false);
});

test('final batch is atomic and preserves per-member values and one complete batch read', async () => {
  const sim = install();
  const catalog = await journalApi.getCatalog({includeDefinitions: true}), plots = await journalApi.listPlots();
  const template = catalog.templates.find(row => row.active === 1)!, layout = catalog.layouts.find(row => row.active === 1)!;
  const activity = catalog.vocab.find(row => row.kind === 'activity' && row.active === 1)!.code;
  const base = {status: 'final' as const, base_sync_version: 0 as const, batch_uuid: 'batch-01', activity_code: activity,
    template_code: template.code, template_version: template.version, layout_code: layout.code, layout_version: layout.version,
    occurred_start_local: '2026-10-10T06:00', occurred_timezone: 'Africa/Kampala', values: []};
  const beforeEntries = await journalApi.listEntries();
  const beforePlots = await journalApi.listPlots();
  const beforeGroups = await journalApi.listPlotGroups();
  const beforeSync = sim.request('GET', '/api/sync/state');
  await assert.rejects(journalApi.createFinalBatch({...base, members: [
    {plot_uuid: plots[0]!.plot_uuid, entry_uuid: 'batch-good', values: []}, {plot_uuid: 'missing-plot', entry_uuid: 'batch-bad', values: []},
  ]}), error => (error as {response?: {status?: number}}).response?.status === 422);
  assert.deepEqual(await journalApi.listEntries(), beforeEntries);
  assert.deepEqual(await journalApi.listPlots(), beforePlots);
  assert.deepEqual(await journalApi.listPlotGroups(), beforeGroups);
  assert.deepEqual(sim.request('GET', '/api/sync/state'), beforeSync);
  const batch = await journalApi.createFinalBatch({...base, members: [
    {plot_uuid: plots[0]!.plot_uuid, entry_uuid: 'batch-a', values: []}, {plot_uuid: plots[1]!.plot_uuid, entry_uuid: 'batch-b', values: []},
  ]});
  assert.equal(batch.entries.length, 2);
  assert.equal((await journalApi.listEntries({batch_uuid: 'batch-01'})).entries.length, 2);
});

test('draft discard, crop-cycle dependent confirmation, and final void preserve history', async () => {
  install();
  const catalog = await journalApi.getCatalog({includeDefinitions: true}), plot = (await journalApi.listPlots())[0]!;
  const template = catalog.templates.find(row => row.active === 1)!, layout = catalog.layouts.find(row => row.active === 1)!;
  const fields = {plot_uuid: plot.plot_uuid, template_code: template.code, template_version: template.version, layout_code: layout.code,
    layout_version: layout.version, occurred_start_local: '2026-10-10T06:00', occurred_timezone: 'Africa/Kampala', values: []};
  await journalApi.createEntry({...fields, entry_uuid: 'discard-me', base_sync_version: 0, status: 'draft', activity_code: 'crop_care'});
  assert.deepEqual(await journalApi.discardDraft('discard-me'), {entry_uuid: 'discard-me', discarded: true});
  assert.equal((await journalApi.listEntries({entry_uuid: 'discard-me'})).entries.length, 0);
  const crop = catalog.vocab.find(row=>row.kind==='choice'&&row.parent_code==='attr.crop'&&row.active===1)!.code;
  await journalApi.createEntry({...fields, entry_uuid: 'cycle-seed', base_sync_version: 0, status: 'final', activity_code: 'seeding', values:[{attribute_code:'attr.crop',value:crop}]});
  const dependent = await journalApi.createEntry({...fields, entry_uuid: 'cycle-child', base_sync_version: 0, status: 'final', activity_code: 'crop_care'});
  assert.equal(dependent.sync_version, 1);
  const active = (await journalApi.listPlots()).find(row => row.plot_uuid === plot.plot_uuid)!.active_crop_cycles!;
  assert.equal(active[0]?.opened_by_entry_uuid, 'cycle-seed');
  await assert.rejects(journalApi.voidEntry('cycle-seed', 'mistake', 1), error => {
    const data = (error as {response?: {data?: {error?: string; details?: {dependentEntryUuids?: string[]}}}}).response?.data;
    assert.equal(data?.error, 'cycle_has_dependents');
    assert.deepEqual(data?.details?.dependentEntryUuids, ['cycle-child']);
    return true;
  });
  const voided = await journalApi.voidEntry('cycle-seed', 'mistake', 1, true);
  assert.equal(voided.status, 'voided');
  assert.equal((await journalApi.listEntries({entry_uuid: 'cycle-seed',status:'all'})).entries[0]?.void_reason, 'mistake');
  assert.equal((await journalApi.listPlots()).find(row => row.plot_uuid === plot.plot_uuid)!.active_crop_cycles!.length, 0);
});

test('similar final entry returns the native duplicate candidate and acknowledged retry keeps its client UUID', async () => {
  install();
  const catalog=await journalApi.getCatalog({includeDefinitions:true}),plot=(await journalApi.listPlots())[0]!,template=catalog.templates.find(row=>row.active===1)!,layout=catalog.layouts.find(row=>row.active===1)!,activity=catalog.vocab.find(row=>row.kind==='activity'&&row.active===1)!.code;
  const base={plot_uuid:plot.plot_uuid,activity_code:activity,template_code:template.code,template_version:template.version,layout_code:layout.code,layout_version:layout.version,
    occurred_start_local:'2026-10-10T06:00',occurred_timezone:'Africa/Kampala',values:[]};
  await journalApi.createEntry({...base,entry_uuid:'duplicate-original',base_sync_version:0,status:'final'});
  await assert.rejects(journalApi.createEntry({...base,entry_uuid:'duplicate-retry',base_sync_version:0,status:'final'}),error=>{
    const data=(error as {response?:{status?:number;data?:{error?:string;details?:{duplicateCandidate?:{entryUuid?:string}}}}}).response?.data;
    assert.equal((error as {response?:{status?:number}}).response?.status,409);assert.equal(data?.error,'duplicate_candidate');assert.equal(data?.details?.duplicateCandidate?.entryUuid,'duplicate-original');return true;
  });
  const retry=await journalApi.createEntry({...base,entry_uuid:'duplicate-retry',base_sync_version:0,status:'final',duplicate_guard_ack_entry_uuid:'duplicate-original'});
  assert.equal(retry.entry_uuid,'duplicate-retry');
  assert.deepEqual((await journalApi.listEntries({activity_code:activity})).entries.map(row=>row.entry_uuid).sort(),['duplicate-original','duplicate-retry']);
});

test('journal CSV JSON and research package clients download filtered bytes with independently verifiable ZIP members', async () => {
  const downloads: Array<{name: string; bytes: Uint8Array}> = [];
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;
  const originalDocument = globalThis.document;
  const urls = new Map<string, Blob>();
  let sequence = 0;
  URL.createObjectURL = ((blob: Blob) => {const url = `blob:journal-test-${++sequence}`; urls.set(url, blob); return url;}) as typeof URL.createObjectURL;
  URL.revokeObjectURL = ((url: string) => {urls.delete(url);}) as typeof URL.revokeObjectURL;
  const fakeDocument = {createElement: () => ({href: '', download: '', click() {}, remove() {}}), body: {appendChild(node: {href: string; download: string}) {
    const blob = urls.get(node.href);
    if (blob) void blob.arrayBuffer().then(buffer => downloads.push({name: node.download, bytes: new Uint8Array(buffer)}));
    return node;
  }}} as unknown as Document;
  Object.defineProperty(globalThis, 'document', {configurable: true, value: fakeDocument});
  try {
    const sim = install();
    const catalog = await journalApi.getCatalog({includeDefinitions: true}), plot = (await journalApi.listPlots())[0]!;
    const template = catalog.templates.find(row => row.active === 1)!, layout = catalog.layouts.find(row => row.active === 1)!;
    const activity = catalog.vocab.find(row => row.kind === 'activity' && row.active === 1)!.code;
    const captureModel=buildCatalogModel(catalog);assert.equal(captureModel.ok,true);if(!captureModel.ok)return;
    const booleans=buildEntryValues(captureModel.model,[{attribute_code:'attr.recirculation',value:true},{attribute_code:'attr.recirculation',value:false,group_index:1}]);
    const csv = await journalApi.createEntry({entry_uuid:'export-entry-01',base_sync_version:0,status:'final',plot_uuid:plot.plot_uuid,activity_code:activity,
      template_code:template.code,template_version:template.version,layout_code:layout.code,layout_version:layout.version,
      occurred_start_local:'2026-10-10T06:00',occurred_timezone:'Africa/Kampala',values:[...booleans,{attribute_code:'attr.actuation_expectation_id',value:'export-value'},{attribute_code:'attr.water_input',value:25,unit_code:'unit.l_water'}],note:'=formula'});
    assert.equal(csv.sync_version,1);
    await journalApi.exportEntriesCsv({activity_code: activity, limit: 1});
    await journalApi.exportEntriesJson({activity_code: activity, limit: 1});
    await journalApi.exportEntriesResearchPackage({activity_code: activity, limit: 1});
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(downloads.map(item => item.name), ['journal-entries.csv', 'journal-entries.json', 'journal-entries-package.zip']);
    const wideCsv = new TextDecoder().decode(downloads[0]!.bytes);
    assert.match(wideCsv, /value\.0\.attr\.actuation_expectation_id\.status/);
    assert.match(wideCsv, /value\.0\.attr\.water_input\.value/);
    assert.match(wideCsv, /export-entry-01/);
    assert.match(wideCsv, /export-value/);
    assert.match(wideCsv, /'=formula/);
    assert.match(wideCsv, /"observed",1,""/);assert.match(wideCsv, /"observed",0,""/);
    const researchJson = JSON.parse(new TextDecoder().decode(downloads[1]!.bytes)) as {research_metadata?: {record_counts?: {entries?: number}}; entries?: Array<{entry_uuid:string}>};
    assert.equal(researchJson.research_metadata?.record_counts?.entries, 1);
    assert.equal(researchJson.entries?.[0]?.entry_uuid, 'export-entry-01');
    assert.equal(downloads[2]!.bytes[0], 0x50);
    assert.equal(downloads[2]!.bytes[1], 0x4b);
    const archive = downloads[2]!.bytes;
    const eocdAt=archive.findIndex((value,index)=>value===0x50&&archive[index+1]===0x4b&&archive[index+2]===0x05&&archive[index+3]===0x06);
    assert.ok(eocdAt>0);
    const centralAt = archive.findIndex((value, index) => value === 0x50 && archive[index + 1] === 0x4b && archive[index + 2] === 0x01 && archive[index + 3] === 0x02);
    assert.ok(centralAt > 0);
    const read16 = (offset: number) => archive[offset]! | (archive[offset + 1]! << 8);
    const read32 = (offset: number) => (archive[offset]! | archive[offset + 1]! << 8 | archive[offset + 2]! << 16 | archive[offset + 3]! << 24) >>> 0;
    assert.equal(read16(eocdAt+10),5);
    assert.equal(read32(eocdAt+16),centralAt);
    assert.equal(read32(eocdAt+12),eocdAt-centralAt);
    const crc32Oracle=(bytes:Uint8Array)=>{let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1;}return (crc^0xffffffff)>>>0;};
    const members = new Map<string, Uint8Array>();
    let cursor = centralAt;
    while (read32(cursor) === 0x02014b50) {
      const nameLength = read16(cursor + 28), extraLength = read16(cursor + 30), commentLength = read16(cursor + 32), localAt = read32(cursor + 42);
      const name = new TextDecoder().decode(archive.slice(cursor + 46, cursor + 46 + nameLength));
      const localNameLength = read16(localAt + 26), localExtraLength = read16(localAt + 28), dataAt = localAt + 30 + localNameLength + localExtraLength;
      const compressedSize = read32(cursor + 20);
      const bytes=archive.slice(dataAt,dataAt+compressedSize);
      assert.equal(read32(cursor+16),crc32Oracle(bytes),`CRC ${name}`);
      assert.equal(read32(localAt),0x04034b50);
      members.set(name, bytes);
      cursor += 46 + nameLength + extraLength + commentLength;
    }
    assert.deepEqual([...members.keys()], ['entries.csv','values.csv','vocab_mappings.csv','records.ndjson','manifest.json']);
    const packageEntries=new TextDecoder().decode(members.get('entries.csv')!);
    const packageHeader=packageEntries.slice(0,packageEntries.indexOf('\r\n')).split(',').map(cell=>cell.replace(/^"|"$/g,''));
    assert.ok(packageHeader.includes('contract_version'));
    assert.ok(packageHeader.includes('occurred_utc_offset_minutes'));
    assert.ok(packageHeader.includes('recorded_at'));
    assert.ok(packageHeader.includes('context_json'));
    assert.match(packageEntries,/export-entry-01/);
    assert.match(new TextDecoder().decode(members.get('values.csv')!),/export-value/);
    assert.match(new TextDecoder().decode(members.get('values.csv')!),/25/);
    const packageValues=new TextDecoder().decode(members.get('values.csv')!);assert.match(packageValues,/"attr\.recirculation",0,"observed","","",1,"",""/);assert.match(packageValues,/"attr\.recirculation",1,"observed","","",0,"",""/);
    const manifest = JSON.parse(new TextDecoder().decode(members.get('manifest.json')!)) as {schema:string;members: Array<{name:string;size_bytes:number;sha256:string}>;record_counts:{entries:number};research_metadata:{definitions:{templates:Array<{definition_sha256:string|null}>;layouts:Array<{definition_sha256:string|null}>};mapping_sources:Array<{mapping_count:number}>;unit_transformations:Array<{definition_sha256:string|null;transformation:unknown}>}};
    assert.equal(manifest.schema, 'osi-journal-research-package-v1');
    assert.equal(manifest.record_counts.entries, 1);
    assert.ok(manifest.research_metadata.definitions.templates.every(row=>row.definition_sha256));
    assert.ok(manifest.research_metadata.definitions.layouts.every(row=>row.definition_sha256));
    assert.ok(manifest.research_metadata.mapping_sources.some(row=>row.mapping_count>0));
    assert.ok(manifest.research_metadata.unit_transformations.some(row=>row.definition_sha256&&row.transformation));
    const {createHash} = await import('node:crypto');
    for (const item of manifest.members) {
      const bytes = members.get(item.name)!;
      assert.equal(bytes.length, item.size_bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), item.sha256);
    }
  } finally {
    URL.createObjectURL = originalCreate;
    URL.revokeObjectURL = originalRevoke;
    Object.defineProperty(globalThis, 'document', {configurable: true, value: originalDocument});
  }
});

test('journal plot and group edits preserve snapshots, enforce exact versions, and avoid false pending writes', async () => {
  const sim = install();
  const plot = (await journalApi.listPlots())[0]!;
  const edit = {...plot, base_sync_version: plot.sync_version, plot_code: 'EDITED-1', name: 'Edited plot', active: 1 as const,
    layout_code: 'open_field', layout_version: 1};
  const updated = await journalApi.updatePlot(plot.plot_uuid, edit);
  assert.equal(updated.sync_version, 1);
  await assert.rejects(journalApi.updatePlot(plot.plot_uuid, {...edit, base_sync_version: 0, name: 'stale'}), error =>
    (error as {response?: {status?:number}}).response?.status === 409);
  const group = await journalApi.createPlotGroup({group_uuid:'edit-group',base_sync_version:0,label:'A group',members:[plot.plot_uuid],resolved:false});
  const changed = await journalApi.updatePlotGroup(group.group_uuid,{group_uuid:group.group_uuid,base_sync_version:1,label:'Renamed group',members:[plot.plot_uuid],resolved:true});
  assert.equal(changed.resolved_at, new Date(sim.now).toISOString());
  await assert.rejects(journalApi.updatePlotGroup(group.group_uuid,{group_uuid:group.group_uuid,base_sync_version:0,label:'stale',members:[plot.plot_uuid],resolved:false}), error =>
    (error as {response?: {status?:number}}).response?.status === 409);
  assert.equal((await journalApi.listPlotGroups())[0]?.label, 'Renamed group');
});
