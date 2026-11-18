import {buildCatalogModel} from '../../src/journal/catalogModel';
import {buildEntryValues} from '../../src/journal/templateEngine';
import type {EntryAggregate, EntryListFilters, EntryListResponse, JournalCatalog, JournalEntryWriteFields, JournalPlot, JournalPlotGroupWritePayload, JournalPlotWritePayload, PlotGroup} from '../../src/types/journal';
import catalogSeed from '../journal-catalog.json';
import catalogProvenance from '../journal-catalog-provenance.json';
import {DemoError} from '../errors';
import {sha256Hex as sha256} from './sha256';

type Entry = EntryAggregate & {clientKey?: string;local_date?:string};
type Cycle = {cycle_uuid:string;plot_uuid:string;crop_code:string;variety:string|null;seeded_on:string;opened_by_entry_uuid:string;ended_on?:string;ended_by_entry_uuid?:string;voided_by_entry_uuid?:string};
export interface JournalState {plots: Map<string, JournalPlot>; groups: Map<string, PlotGroup>; entries: Map<string, Entry>; cycles: Map<string, Cycle>; sequence: number}
export interface JournalPort {now: number; owner: string; gateway: string; zones: Array<{zone_uuid?: string | null; id: number; name: string}>; recordMutation(): void}

export function createJournalState(): JournalState {return {plots: new Map(), groups: new Map(), entries: new Map(), cycles: new Map(), sequence: 0};}
const clone = <T>(value: T): T => structuredClone(value);
const seed = catalogSeed as JournalCatalog;
const provenance=catalogProvenance as {templates:Array<{code:string;version:number;definition_sha256:string|null}>;layouts:Array<{code:string;version:number;definition_sha256:string|null}>;units:Array<{code:string;quantity_kind:string|null;basis:string|null;constraints_json:string|null;constraints_sha256:string|null}>};
const err = (status: number, code: string, message = code, details?: Record<string, unknown>): never => {
  throw new DemoError(status, code, {error: code, message, ...(details ? {details} : {})});
};
const iso = (at: number) => new Date(at).toISOString();
function uuid(state: JournalState, prefix: string): string {state.sequence += 1; return `sim-${prefix}-${String(state.sequence).padStart(8, '0')}`;}
function activeCatalog(includeDefinitions: boolean): JournalCatalog {
  const result = clone(seed);
  if (!includeDefinitions) {
    for (const row of result.vocab) {delete row.labels; delete row.constraints;}
    for (const row of [...result.templates, ...result.layouts]) {delete row.labels; delete row.definition;}
    for (const row of result.products) delete row.composition;
  }
  result.capture_permissions = {farm_wide: true};
  return result;
}
function ensurePlots(state: JournalState, port: JournalPort): void {
  if (state.plots.size) return;
  port.zones.forEach(zone => {
    const at = iso(port.now), id = zone.zone_uuid ?? `00000000-0000-4000-8000-${String(zone.id).padStart(12, '0')}`;
    const plot: JournalPlot = {contract_version: 2, plot_uuid: id, plot_code: `ZONE-${zone.id}`, name: zone.name,
      zone_uuid: id, station_code: null, crop_hint: null, area_m2: 100, active: 1, sync_version: 0,
      owner_user_uuid: port.owner, gateway_device_eui: port.gateway, created_at: at, updated_at: at, deleted_at: null,
      settings: {layout_code: 'open_field', updated_at: at, updated_by_principal_uuid: port.owner, sync_version: 0, context_json: null}, active_crop_cycles: [], zone_has_weather_source: true};
    state.plots.set(plot.plot_uuid, plot);
  });
}
function plotAggregate(plot: JournalPlot, state: JournalState): JournalPlot {
  const cycles = [...state.cycles.values()].filter(cycle => cycle.plot_uuid === plot.plot_uuid&&!cycle.ended_by_entry_uuid&&!cycle.voided_by_entry_uuid).map(cycle => ({cycle_uuid: cycle.cycle_uuid,
    crop_code: cycle.crop_code, variety: cycle.variety, seeded_on: cycle.seeded_on, opened_by_entry_uuid: cycle.opened_by_entry_uuid}));
  return {...clone(plot), active_crop_cycles: cycles};
}
function entryMatches(entry: Entry, filters: EntryListFilters, state: JournalState): boolean {
  if(entry.deleted_at!=null)return false;
  const plot=entry.plot_uuid?state.plots.get(entry.plot_uuid):undefined;
  for(const [key,value] of Object.entries(filters)){
    if(value==null||value===''||key==='limit'||key==='cursor')continue;
    if(key==='station_code'){if(plot?.station_code!==value)return false;continue;}
    if(key==='group_uuid'){if(!state.groups.get(String(value))?.members.includes(entry.plot_uuid??''))return false;continue;}
    if(key==='occurred_from'){if(entry.occurred_start<new Date(String(value)).toISOString())return false;continue;}
    if(key==='occurred_to'){if(entry.occurred_start>new Date(String(value)).toISOString())return false;continue;}
    if(key==='status'){if(value!=='all'&&entry.status!==value)return false;continue;}
    if((entry as unknown as Record<string,unknown>)[key]!==value)return false;
  }
  return true;
}
function normalizeFilters(raw: URLSearchParams | EntryListFilters, paging=true): EntryListFilters {
  const input=(raw instanceof URLSearchParams?Object.fromEntries(raw.entries()):raw) as EntryListFilters;
  const filters:EntryListFilters={};for(const [key,value] of Object.entries(input)){if(value==null||value==='')continue;if(key!=='cursor'&&key!=='limit')filters[key as keyof EntryListFilters]=value as never;}
  const scopes=['plot_uuid','station_code','group_uuid'].filter(key=>filters[key as keyof EntryListFilters]!=null);
  if(scopes.length>1)return err(400,'conflicting_scope_filters','Only one entry scope filter may be supplied');
  if(filters.status==null)filters.status='final';
  if(!['draft','final','voided','all'].includes(filters.status))return err(400,'invalid_filter','status filter is invalid');
  for(const key of ['occurred_from','occurred_to'] as const){const value=filters[key];if(value!=null){const time=Date.parse(value);if(!Number.isFinite(time))return err(400,'invalid_filter',`${key} must be an ISO timestamp`);filters[key]=new Date(time).toISOString();}}
  if(paging){const rawLimit=input.limit;const limit=rawLimit==null||rawLimit===0?50:Number(rawLimit);if(!Number.isInteger(limit)||limit<1)return err(400,'invalid_limit','limit must be a positive integer');filters.limit=Math.min(limit,100);if(input.cursor)filters.cursor=input.cursor;}
  return filters;
}
function scopePlotIds(state:JournalState,filters:EntryListFilters):string[]|null{
  if(filters.plot_uuid!=null){if(!state.plots.has(filters.plot_uuid))return err(404,'scope_not_found','Journal scope was not found');return [filters.plot_uuid];}
  if(filters.station_code!=null){const ids=[...state.plots.values()].filter(plot=>plot.station_code===filters.station_code&&!plot.deleted_at).map(plot=>plot.plot_uuid);if(!ids.length)return err(404,'scope_not_found','Journal scope was not found');return ids;}
  if(filters.group_uuid!=null){const group=state.groups.get(filters.group_uuid);if(!group||group.deleted_at)return err(404,'scope_not_found','Journal scope was not found');if(!group.members.length)return err(404,'scope_not_found','Journal scope was not found');return group.members;}
  return null;
}
function cursorHash(filters:EntryListFilters):string {
  const normalized={...filters};delete normalized.cursor;delete normalized.limit;
  const stable=Object.fromEntries(Object.entries(normalized).sort(([a],[b])=>a.localeCompare(b)));
  return sha256(new TextEncoder().encode(JSON.stringify(stable)));
}
function decodeEntryCursor(cursor:string,hash:string):{occurred_start:string;entry_uuid:string}{try{const parsed=JSON.parse(atob(cursor.replace(/-/g,'+').replace(/_/g,'/'))) as unknown;if(!Array.isArray(parsed)||parsed.length!==3||typeof parsed[0]!=='string'||typeof parsed[1]!=='string'||parsed[2]!==hash)throw new Error();return {occurred_start:parsed[0],entry_uuid:parsed[1]};}catch{return err(400,'invalid_cursor','Cursor does not match these filters');}}
function encodeEntryCursor(entry:Entry,hash:string):string{return btoa(JSON.stringify([entry.occurred_start,entry.entry_uuid,hash])).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
function filteredEntries(state:JournalState,raw:URLSearchParams|EntryListFilters,paging:boolean):{rows:Entry[];filters:EntryListFilters}{
  const filters=normalizeFilters(raw,paging),scope=scopePlotIds(state,filters),hash=cursorHash(filters),cursor=paging&&filters.cursor?decodeEntryCursor(filters.cursor,hash):null;
  let rows=[...state.entries.values()].filter(entry=>entryMatches(entry,filters,state)&&(!scope||scope.includes(entry.plot_uuid??'')))
    .sort((a,b)=>b.occurred_start.localeCompare(a.occurred_start)||a.entry_uuid.localeCompare(b.entry_uuid));
  if(cursor)rows=rows.filter(entry=>entry.occurred_start<cursor.occurred_start||(entry.occurred_start===cursor.occurred_start&&entry.entry_uuid>cursor.entry_uuid));
  return {rows,filters};
}
function entriesPage(state: JournalState, raw: URLSearchParams | EntryListFilters): EntryListResponse {
  const {rows,filters}=filteredEntries(state,raw,true),limit=filters.limit??50,page=rows.slice(0,limit),hasMore=rows.length>limit;
  return {entries:page.map(entry=>publicEntry(entry,state)),next_cursor:hasMore?encodeEntryCursor(page[page.length-1]!,cursorHash(filters)):null};
}
function requiredText(value: unknown, field: string): string {if (typeof value !== 'string' || !value.trim()) return err(422, 'required', `${field} is required`, {field}); return value.trim();}
function valuesFor(fields: JournalEntryWriteFields, catalog: JournalCatalog) {
  const model = buildCatalogModel(catalog);
  if (!model.ok) return err(422, 'invalid_catalog', 'Journal catalog could not be used');
  try {return buildEntryValues(model.model, fields.values ?? []).map(value => {
    const {value: semantic, ...rest} = value as typeof value & {value?: string | number | boolean};
    const attribute=model.model.vocabByCode.get(value.attribute_code);
    return {...rest, group_index: value.group_index ?? 0, value_status: value.value_status ?? 'observed',
      value_num: value.value_num ?? (typeof semantic === 'number' ? semantic : typeof semantic==='boolean'&&attribute?.value_type==='boolean'?(semantic?1:0):null),
      value_text: value.value_text ?? (typeof semantic === 'string' ? semantic : null),
      unit_code: value.unit_code ?? null, entered_value_num: value.entered_value_num ?? null,
      entered_unit_code: value.entered_unit_code ?? null} as EntryAggregate['values'][number];
  });}
  catch (cause) {return err(422, 'invalid_values', cause instanceof Error ? cause.message : 'Invalid journal values');}
}
function localOccurrence(value: unknown, timezone: unknown, explicitOffset?: unknown): {utc: string; timezone: string; offset: number; localDate:string} {
  const local = requiredText(value, 'occurred_start_local');
  const zone = requiredText(timezone, 'occurred_timezone');
  const match=local.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if(!match)return err(422,'invalid_local_time','Local time must use YYYY-MM-DDTHH:mm[:ss[.SSS]]');
  const fields={year:+match[1]!,month:+match[2]!,day:+match[3]!,hour:+match[4]!,minute:+match[5]!,second:+(match[6]??0),millisecond:+(match[7]??'').padEnd(3,'0')};
  const naive=new Date(0);naive.setUTCFullYear(fields.year,fields.month-1,fields.day);naive.setUTCHours(fields.hour,fields.minute,fields.second,fields.millisecond);
  if(naive.getUTCFullYear()!==fields.year||naive.getUTCMonth()!==fields.month-1||naive.getUTCDate()!==fields.day||naive.getUTCHours()!==fields.hour||naive.getUTCMinutes()!==fields.minute||naive.getUTCSeconds()!==fields.second)return err(422,'invalid_local_time','Local time contains an invalid calendar value');
  let formatter:Intl.DateTimeFormat;
  try{formatter=new Intl.DateTimeFormat('en-CA',{calendar:'iso8601',numberingSystem:'latn',timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23',minute:'2-digit',second:'2-digit'});}catch{return err(422,'invalid_timezone','Timezone is not supported');}
  const wall=(epoch:number)=>{const parts=Object.fromEntries(formatter.formatToParts(new Date(epoch)).filter(part=>part.type!=='literal').map(part=>[part.type,Number(part.value)]));return {year:parts.year,month:parts.month,day:parts.day,hour:parts.hour,minute:parts.minute,second:parts.second};};
  const offsetAt=(epoch:number)=>{const seconds=Math.floor(epoch/1000)*1000,w=wall(seconds);return Math.round((Date.UTC(w.year,w.month-1,w.day,w.hour,w.minute,w.second)-seconds)/60000);};
  if(explicitOffset!=null&&!Number.isInteger(explicitOffset))return err(422,'invalid_utc_offset','UTC offset must be an integer number of minutes');
  const offsets=new Set([-36,0,36].map(hours=>offsetAt(naive.getTime()+hours*3600000)));
  const matches=[...offsets].map(offset=>({offset,epoch:naive.getTime()-offset*60000})).filter(row=>{const w=wall(row.epoch);return w.year===fields.year&&w.month===fields.month&&w.day===fields.day&&w.hour===fields.hour&&w.minute===fields.minute&&w.second===fields.second&&new Date(row.epoch).getUTCMilliseconds()===fields.millisecond;});
  if(!matches.length)return err(422,'nonexistent_local_time','Local time does not exist in this timezone');
  if(explicitOffset!=null&&!matches.some(row=>row.offset===explicitOffset))return err(422,'invalid_utc_offset','UTC offset does not match this local time and timezone');
  if(explicitOffset==null&&matches.length>1)return err(422,'ambiguous_local_time','Local time is ambiguous in this timezone');
  const selected=matches.find(row=>row.offset===explicitOffset)??matches[0]!;
  return {utc:new Date(selected.epoch).toISOString(),timezone:zone,offset:selected.offset,localDate:`${match[1]}-${match[2]}-${match[3]}`};
}
function localEnd(value: unknown, timezone: string, offset?:unknown): string | null {return value == null || value === '' ? null : localOccurrence(value, timezone,offset).utc;}
function receipt(entry: Entry, event?: string) {return {entry_uuid: entry.entry_uuid, status: entry.status, sync_version: entry.sync_version, outbox_event_uuid: event ?? null, recorded_at: entry.recorded_at};}
function duplicateCandidate(state:JournalState,plotUuid:string,activity:string,at:number,pass:string|null,exclude?:string):Entry|undefined{return [...state.entries.values()].filter(row=>row.entry_uuid!==exclude&&row.status==='final'&&row.deleted_at==null&&row.plot_uuid===plotUuid&&row.activity_code===activity&&(!pass||!row.pass_uuid||row.pass_uuid!==pass)&&Math.abs(Date.parse(row.occurred_start)-at)<=60*60*1000).sort((a,b)=>Math.abs(Date.parse(a.occurred_start)-at)-Math.abs(Date.parse(b.occurred_start)-at)||a.entry_uuid.localeCompare(b.entry_uuid))[0];}
function saveEntry(state: JournalState, port: JournalPort, body: Record<string, unknown>, entryUuid?: string): unknown {
  const entries=clone(state.entries),cycles=clone(state.cycles),sequence=state.sequence;
  try{return saveEntryUnsafe(state,port,body,entryUuid);}catch(error){state.entries=entries;state.cycles=cycles;state.sequence=sequence;throw error;}
}
function saveEntryUnsafe(state: JournalState, port: JournalPort, body: Record<string, unknown>, entryUuid?: string): unknown {
  const create = !entryUuid;
  const uuidValue = create ? String(body.entry_uuid ?? uuid(state, 'entry')) : entryUuid!;
  const existing = state.entries.get(uuidValue);
  if (body.discard === true) {
    if (!existing || existing.status !== 'draft' || existing.sync_version !== 0) return err(409, 'draft_not_discardable');
    state.entries.delete(uuidValue); port.recordMutation(); return {entry_uuid: uuidValue, discarded: true};
  }
  const base = Number(body.base_sync_version);
  if (create && (base !== 0 || existing)) return err(409, 'stale_version', 'New resources require base_sync_version 0');
  if (!create && (!existing || existing.deleted_at)) return err(404, 'not_found', 'Journal entry was not found');
  if (!Number.isInteger(base) || base !== (existing?.sync_version ?? 0)) return err(409, 'stale_version', 'base_sync_version must match the current entry version', {current_sync_version: existing?.sync_version ?? 0});
  if (existing?.status === 'voided') return err(409, 'entry_voided');
  if(existing&&body.entry_uuid!=null&&body.entry_uuid!==existing.entry_uuid)return err(400,'path_body_mismatch','Path and body entry UUID differ');
  const status = body.status;
  if (status !== 'draft' && status !== 'final') return err(422, 'invalid_status');
  if(existing?.status==='final'&&status!=='final')return err(409,'invalid_state','Only a final journal entry can be corrected as final');
  const plotUuid = body.plot_uuid == null ? null : String(body.plot_uuid);
  const plot = plotUuid ? state.plots.get(plotUuid) : null;
  if (plotUuid && (!plot || plot.deleted_at || plot.active !== 1)) return err(422, 'invalid_plot');
  const activity = requiredText(body.activity_code, 'activity_code');
  const template = seed.templates.find(row => row.code === body.template_code && row.version === Number(body.template_version) && row.active === 1);
  const layout = seed.layouts.find(row => row.code === body.layout_code && row.version === Number(body.layout_version) && row.active === 1);
  if (!seed.vocab.some(row => row.code === activity && row.kind === 'activity' && row.active === 1)) return err(422, 'invalid_activity');
  if (!template || !layout) return err(422, 'invalid_definition');
  const occurrence = localOccurrence(body.occurred_start_local, body.occurred_timezone,body.occurred_utc_offset_minutes);
  const end = localEnd(body.occurred_end_local, occurrence.timezone,body.occurred_end_utc_offset_minutes);
  if (end && end < occurrence.utc) return err(422, 'invalid_occurrence_range');
  const values = valuesFor(body as unknown as JournalEntryWriteFields, activeCatalog(true));
  const final = status === 'final';
  if (final && !existing && plotUuid) {
    const at=Date.parse(occurrence.utc), pass=typeof body.pass_uuid==='string'?body.pass_uuid:null;
    const duplicate=duplicateCandidate(state,plotUuid,activity,at,pass);
    if(duplicate&&body.duplicate_guard_ack_entry_uuid!==duplicate.entry_uuid)return err(409,'duplicate_candidate','A similar final journal entry already exists',
      {duplicateCandidate:{entryUuid:duplicate.entry_uuid,occurredStart:duplicate.occurred_start,activityCode:duplicate.activity_code,plotUuid:duplicate.plot_uuid}});
  }
  const deviceEui=typeof body.device_eui==='string'?body.device_eui:existing?.device_eui??null;
  const seasonCrop=body.season_crop===undefined?(existing?.season_crop??null):typeof body.season_crop==='string'?body.season_crop:null;
  const seasonVariety=body.season_variety===undefined?(existing?.season_variety??null):typeof body.season_variety==='string'?body.season_variety:null;
  const campaign=typeof body.campaign_uuid==='string'?body.campaign_uuid:null,protocol=typeof body.protocol_code==='string'?body.protocol_code:null;
  const protocolVersion=typeof body.protocol_version==='string'?body.protocol_version:null,observationUnit=typeof body.observation_unit_code==='string'?body.observation_unit_code:null;
  const batchSupplied=Object.prototype.hasOwnProperty.call(body,'batch_uuid')&&body.batch_uuid!==undefined;
  const batchUuid=existing?(existing.batch_uuid??null):(typeof body.batch_uuid==='string'?body.batch_uuid:null);
  if(existing&&batchSupplied&&(body.batch_uuid??null)!==batchUuid)return err(409,'immutable_batch_uuid','A correction cannot change batch provenance');
  const passUuid=typeof body.pass_uuid==='string'?body.pass_uuid:null,note=typeof body.note==='string'?body.note:null;
  const contextJson=existing&&existing.plot_uuid===plotUuid&&existing.device_eui===deviceEui&&existing.occurred_start===occurrence.utc?existing.context_json:plot?.settings.context_json??null;
  if (existing && existing.status === status && existing.plot_uuid === plotUuid && existing.zone_uuid===(plot?.zone_uuid??null)&&existing.device_eui===deviceEui&&existing.activity_code === activity
    && existing.template_code === template.code && existing.template_version === template.version
    && existing.layout_code === layout.code && existing.layout_version === layout.version && existing.occurred_start === occurrence.utc
    && existing.occurred_end === end&&existing.occurred_timezone===occurrence.timezone&&existing.occurred_utc_offset_minutes===occurrence.offset&&existing.note===note&&existing.context_json===contextJson
    &&existing.campaign_uuid===campaign&&existing.protocol_code===protocol&&existing.protocol_version===protocolVersion&&existing.observation_unit_code===observationUnit
    &&existing.batch_uuid===batchUuid&&existing.pass_uuid===passUuid
    && JSON.stringify(existing.values) === JSON.stringify(values) && existing.season_crop === seasonCrop&&existing.season_variety===seasonVariety) return receipt(existing);
  const version = !final ? 0 : (existing?.sync_version ?? 0) + 1;
  const event = final ? uuid(state, 'outbox') : null;
  const now = iso(port.now);
  const entry: Entry = {contract_version: 2, entry_uuid: uuidValue, owner_user_uuid: existing?.owner_user_uuid??port.owner, author_principal_uuid: existing?.author_principal_uuid??port.owner,
    author_label: existing?.author_label??'Demo farmer', gateway_device_eui: existing?.gateway_device_eui??port.gateway, plot_uuid: plotUuid, zone_uuid: plot?.zone_uuid ?? null, device_eui:deviceEui,
    season_uuid: existing?.season_uuid??null, season_crop: seasonCrop, season_variety:seasonVariety,
    campaign_uuid: campaign, protocol_code: protocol,
    protocol_version: protocolVersion, observation_unit_code: observationUnit,
    activity_code: activity, template_code: String(body.template_code), template_version: Number(body.template_version), layout_code: String(body.layout_code), layout_version: Number(body.layout_version), catalog_version: seed.catalog_version,
    occurred_start: occurrence.utc, occurred_end: end, occurred_timezone: occurrence.timezone, occurred_utc_offset_minutes: occurrence.offset, origin: existing?.origin??'edge-ui', status,
    batch_uuid: batchUuid, pass_uuid: passUuid,
    voided_at: null, voided_by_principal_uuid: null, void_reason: null, note, context_json: contextJson,
    sync_version: version, recorded_at: existing?.recorded_at??now, created_at: existing?.created_at ?? now, updated_at: now, deleted_at: null, values,local_date:occurrence.localDate} as Entry;
  state.entries.set(uuidValue, entry);
  if (final) {const sideEffectWrites=applyCycle(state, entry, body,existing);for(let write=0;write<=sideEffectWrites;write++)port.recordMutation();}
  return receipt(entry, event ?? undefined);
}
function freezeClosedSpan(state:JournalState,cycle:Cycle,endsOn:string,closingEntryUuid:string,updatedAt:string):number{
  let changed=0;
  for(const row of state.entries.values()){
    const date=row.local_date??row.occurred_start.slice(0,10);
    if(row.entry_uuid===closingEntryUuid||row.plot_uuid!==cycle.plot_uuid||row.status!=='final'||date<cycle.seeded_on||date>endsOn)continue;
    const coveredByOther=[...state.cycles.values()].some(other=>other.cycle_uuid!==cycle.cycle_uuid&&other.plot_uuid===cycle.plot_uuid&&!other.ended_by_entry_uuid&&!other.voided_by_entry_uuid&&other.seeded_on<=date);
    if(coveredByOther)continue;
    row.season_crop=cycle.crop_code;row.season_variety=cycle.variety;row.season_uuid=null;row.sync_version+=1;row.updated_at=updatedAt;changed++;
  }return changed;
}
function applyCycle(state: JournalState, entry: Entry, body: Record<string, unknown>,previous?:Entry): number {
  if (!entry.plot_uuid) return 0;
  if(previous?.status==='final'){
    const opened=[...state.cycles.values()].find(cycle=>cycle.opened_by_entry_uuid===previous.entry_uuid&&!cycle.voided_by_entry_uuid);
    if(opened&&['seeding','planting_transplanting'].includes(previous.activity_code)&&!['seeding','planting_transplanting'].includes(entry.activity_code)){
      const dependents=[...state.entries.values()].filter(row=>row.entry_uuid!==entry.entry_uuid&&row.status!=='draft'&&row.plot_uuid===previous.plot_uuid&&(row.local_date??row.occurred_start.slice(0,10))>=opened.seeded_on);
      if(dependents.length)return err(409,'cycle_has_dependents','Correcting this seeding would invalidate dependent entries',{dependentEntryUuids:dependents.map(row=>row.entry_uuid)});
      opened.voided_by_entry_uuid=entry.entry_uuid;
    }
    if(opened&&['seeding','planting_transplanting'].includes(previous.activity_code)){
      const localDate=entry.local_date??entry.occurred_start.slice(0,10),crop=entry.values.find(value=>value.attribute_code==='attr.crop')?.value_text??null;
      const variety=entry.values.find(value=>value.attribute_code==='attr.variety')?.value_text??null;
      if(localDate!==opened.seeded_on)return err(409,'correction_would_desync_cycle','Correcting this seeding date would desynchronize its crop cycle');
      if(opened.ended_by_entry_uuid&&(crop!==null&&(crop!==opened.crop_code||variety!==opened.variety)))return err(409,'correction_would_desync_cycle','Correcting this closed seeding crop would desynchronize frozen history');
      if(!opened.ended_by_entry_uuid&&crop!==null){opened.crop_code=crop;opened.variety=variety;}
    }
    const closed=[...state.cycles.values()].find(cycle=>cycle.ended_by_entry_uuid===previous.entry_uuid);
    if(closed&&(entry.local_date??entry.occurred_start.slice(0,10))!==closed.ended_on)return err(409,'correction_would_desync_cycle','Correcting this closing entry date would desynchronize its crop cycle');
    return 0;
  }
  let sideEffectWrites=0;
  if (['seeding','planting_transplanting'].includes(entry.activity_code)) {
    const crop = entry.values.find(value => value.attribute_code === 'attr.crop')?.value_text;
    if (typeof crop !== 'string' || !crop) return err(422,'crop_required_for_seeding','A seeding/planting entry must record attr.crop to open a crop cycle');
    const localDate=entry.local_date??entry.occurred_start.slice(0,10);
    const open=[...state.cycles.values()].filter(cycle=>cycle.plot_uuid===entry.plot_uuid&&!cycle.ended_by_entry_uuid&&!cycle.voided_by_entry_uuid&&cycle.seeded_on<=localDate);
    if(open.length>1&&!body.cycle_uuid)return err(422,'cycle_uuid_required','Multiple open crop cycles cover this plot; specify cycle_uuid to select which one this seeding affects',{openCycles:open.map(({cycle_uuid,crop_code,variety})=>({cycle_uuid,crop_code,variety}))});
    const target=body.cycle_uuid?open.find(cycle=>cycle.cycle_uuid===body.cycle_uuid):open[0];
    if(body.cycle_uuid&&!target)return err(422,'cycle_not_found','cycle_uuid does not match an open crop cycle covering this plot',{openCycles:open.map(({cycle_uuid,crop_code,variety})=>({cycle_uuid,crop_code,variety}))});
    const variety=entry.values.find(value=>value.attribute_code==='attr.variety')?.value_text??null;
    const action=body.cycle_action??'continue';
    if(action!=='continue'&&action!=='new')return err(422,'invalid_cycle_action','cycle_action must be "continue" or "new"');
    if(target&&target.crop_code===crop&&target.variety===variety&&action==='continue')return 0;
    const cycleUuid = typeof body.cycle_uuid === 'string' && !target ? body.cycle_uuid : uuid(state, 'cycle');
    state.cycles.set(cycleUuid, {cycle_uuid:cycleUuid,plot_uuid:entry.plot_uuid,crop_code:crop,variety,seeded_on:localDate,opened_by_entry_uuid:entry.entry_uuid});
    if(target){target.ended_on=localDate;target.ended_by_entry_uuid=entry.entry_uuid;sideEffectWrites+=freezeClosedSpan(state,target,localDate,entry.entry_uuid,entry.updated_at);}
  } else if (entry.activity_code==='harvest'||(['tillage_soil_work','mowing','plant_protection_application'].includes(entry.activity_code)&&body.ends_crop_cycle===true)) {
    const localDate=entry.local_date??entry.occurred_start.slice(0,10);
    const candidates = [...state.cycles.values()].filter(cycle => cycle.plot_uuid === entry.plot_uuid&&!cycle.ended_by_entry_uuid&&!cycle.voided_by_entry_uuid&&cycle.seeded_on<=localDate);
    if(!candidates.length&&entry.activity_code==='harvest')return 0;
    if(!candidates.length)return err(422,'no_open_cycle','ends_crop_cycle was set but no open crop cycle covers this plot');
    const chosen = typeof body.cycle_uuid === 'string' ? candidates.find(cycle => cycle.cycle_uuid === body.cycle_uuid) : candidates.length === 1 ? candidates[0] : null;
    if(!chosen)return err(422,body.cycle_uuid?'cycle_not_found':'cycle_uuid_required',body.cycle_uuid?'cycle_uuid does not match an open crop cycle covering this plot':'Multiple open crop cycles cover this plot; specify cycle_uuid to select which one this closes',{openCycles:candidates.map(({cycle_uuid,crop_code,variety})=>({cycle_uuid,crop_code,variety}))});
    chosen.ended_on=localDate;chosen.ended_by_entry_uuid=entry.entry_uuid;
    entry.closed_crop_code=chosen.crop_code;entry.closed_crop_variety=chosen.variety;
    sideEffectWrites+=freezeClosedSpan(state,chosen,localDate,entry.entry_uuid,entry.updated_at);
  }
  return sideEffectWrites;
}
function voidEntry(state: JournalState, port: JournalPort, entryUuid: string, body: Record<string, unknown>): unknown {
  const entry = state.entries.get(entryUuid);
  if (!entry || entry.deleted_at) return err(404, 'not_found');
  if (Number(body.base_sync_version) !== entry.sync_version) return err(409, 'stale_version', 'base_sync_version must match the current entry version', {current_sync_version: entry.sync_version});
  if (entry.status === 'draft') return err(409, 'draft_not_voidable');
  if (entry.status === 'voided') return err(409,'entry_voided');
  const reason=requiredText(body.void_reason,'void_reason');
  const cycle = [...state.cycles.values()].find(item => item.opened_by_entry_uuid === entryUuid&&!item.voided_by_entry_uuid);
  const dependents = cycle&&!cycle.ended_by_entry_uuid ? [...state.entries.values()].filter(row => row.entry_uuid !== entryUuid && row.plot_uuid === entry.plot_uuid && row.status !== 'draft' && (row.local_date??row.occurred_start.slice(0,10)) >= cycle.seeded_on).map(row => row.entry_uuid) : [];
  if (dependents.length && body.cascade_ack !== true) return err(409, 'cycle_has_dependents', 'This crop cycle has dependent entries', {dependentEntryUuids: dependents});
  const closedCycle=[...state.cycles.values()].find(item=>item.ended_by_entry_uuid===entryUuid);
  if(closedCycle){const collision=[...state.cycles.values()].find(item=>item.cycle_uuid!==closedCycle.cycle_uuid&&item.cycle_uuid!==cycle?.cycle_uuid&&item.plot_uuid===closedCycle.plot_uuid&&!item.ended_by_entry_uuid&&!item.voided_by_entry_uuid);
    if(collision)return err(409,'reopen_collision','Another crop cycle is already open on this plot; resolve it before reopening the voided closure',{collidingCycleUuid:collision.cycle_uuid});}
  entry.status = 'voided'; entry.sync_version += 1; entry.voided_at = iso(port.now); entry.voided_by_principal_uuid = port.owner;
  entry.void_reason = reason; entry.updated_at = iso(port.now);
  if(cycle)cycle.voided_by_entry_uuid=entryUuid;
  let sideEffectWrites=0;if(closedCycle){for(const row of state.entries.values()){const date=row.local_date??row.occurred_start.slice(0,10);if(row.entry_uuid!==entryUuid&&row.plot_uuid===closedCycle.plot_uuid&&row.status==='final'&&date>=closedCycle.seeded_on&&date<=(closedCycle.ended_on??date)&&row.season_uuid==null&&row.season_crop===closedCycle.crop_code&&row.season_variety===closedCycle.variety){row.season_crop=null;row.season_variety=null;row.sync_version+=1;row.updated_at=iso(port.now);sideEffectWrites++;}}closedCycle.ended_by_entry_uuid=undefined;closedCycle.ended_on=undefined;delete entry.closed_crop_code;delete entry.closed_crop_variety;}
  const event=uuid(state,'outbox');for(let write=0;write<=sideEffectWrites;write++)port.recordMutation();return receipt(entry,event);
}
function upsertPlot(state: JournalState, port: JournalPort, body: JournalPlotWritePayload, pathUuid?: string): JournalPlot {
  if (pathUuid && pathUuid !== body.plot_uuid) return err(400, 'path_body_mismatch');
  const current = state.plots.get(body.plot_uuid);
  const base = Number(body.base_sync_version);
  if (base !== (current?.sync_version ?? 0) || (!current && base !== 0)) return err(409, 'stale_version', 'base_sync_version must match the current plot version', {current_sync_version: current?.sync_version ?? 0});
  const code=typeof body.plot_code==='string'?body.plot_code.trim():'';
  if(!code||new TextEncoder().encode(code).length>240)return err(422,'invalid_plot_code','plot_code is required and must not exceed 240 bytes');
  if([...state.plots.values()].some(plot=>plot.plot_uuid!==body.plot_uuid&&plot.plot_code===code&&!plot.deleted_at))return err(409,'plot_code_conflict','Plot code is already in use');
  if (!seed.layouts.some(row => row.code === body.layout_code && row.version === body.layout_version && row.active === 1)) return err(422, 'invalid_layout');
  if(body.zone_uuid!=null&&!port.zones.some(zone=>(zone.zone_uuid??`00000000-0000-4000-8000-${String(zone.id).padStart(12,'0')}`)===body.zone_uuid))return err(404,'zone_not_found');
  if(body.zone_uuid!=null&&body.active===1&&[...state.plots.values()].some(plot=>plot.plot_uuid!==body.plot_uuid&&plot.zone_uuid===body.zone_uuid&&plot.active===1&&!plot.deleted_at))return err(409,'zone_plot_conflict','This zone already has an active application plot');
  if(body.area_m2!=null&&(!Number.isFinite(Number(body.area_m2))||Number(body.area_m2)<=0))return err(422,'invalid_area','area_m2 must be a positive finite number');
  if(body.active!==0&&body.active!==1)return err(422,'invalid_active','active must be 0 or 1');
  if(current&&body.active===0&&[...state.groups.values()].some(group=>!group.deleted_at&&!group.resolved_at&&group.members.includes(body.plot_uuid)))return err(409,'plot_in_unresolved_group','Resolve or edit the plot group before deactivating this plot');
  if(current&&current.settings.layout_code!==body.layout_code){for(const group of state.groups.values())if(!group.deleted_at&&!group.resolved_at&&group.members.includes(body.plot_uuid)&&group.members.some(id=>id!==body.plot_uuid&&state.plots.get(id)?.settings.layout_code!==body.layout_code))return err(409,'heterogeneous_group','Layout change would make an unresolved plot group heterogeneous');}
  if(current&&current.plot_code===body.plot_code&&current.name===(body.name?.trim()||null)&&current.zone_uuid===body.zone_uuid&&current.station_code===body.station_code
    &&current.crop_hint===body.crop_hint&&current.area_m2===body.area_m2&&current.active===body.active&&current.settings.layout_code===body.layout_code
    &&current.settings.context_json===(body.context_json??null))return plotAggregate(current,state);
  const at = iso(port.now), version = (current?.sync_version ?? 0) + 1;
  const plot: JournalPlot = {contract_version: 2, plot_uuid: body.plot_uuid, plot_code: code, name: body.name?.trim() || null,
    zone_uuid: body.zone_uuid, station_code: body.station_code, crop_hint: body.crop_hint, area_m2: body.area_m2, active: body.active,
    sync_version: version, owner_user_uuid: current?.owner_user_uuid ?? port.owner, gateway_device_eui: port.gateway,
    created_at: current?.created_at ?? at, updated_at: at, deleted_at: body.active ? null : current?.deleted_at ?? at,
    settings: {layout_code: body.layout_code, updated_at: at, updated_by_principal_uuid: port.owner, sync_version: (current?.settings.sync_version ?? 0) + 1, context_json: body.context_json ?? null},
    active_crop_cycles: current?.active_crop_cycles ?? [], zone_has_weather_source: true};
  state.plots.set(plot.plot_uuid, plot); port.recordMutation(); return plotAggregate(plot, state);
}
function upsertGroup(state: JournalState, port: JournalPort, body: JournalPlotGroupWritePayload, pathUuid?: string): PlotGroup {
  if (pathUuid && pathUuid !== body.group_uuid) return err(400, 'path_body_mismatch');
  const current = state.groups.get(body.group_uuid), base = Number(body.base_sync_version);
  if (base !== (current?.sync_version ?? 0) || (!current && base !== 0)) return err(409, 'stale_version', 'base_sync_version must match the current group version', {current_sync_version: current?.sync_version ?? 0});
  if(!Array.isArray(body.members)||body.members.length>100)return err(422,'invalid_members','members must be an array of at most 100 plots');
  if(new Set(body.members).size!==body.members.length)return err(422,'duplicate_member','Plot group members must be unique');
  const members=[...body.members].sort();
  if (!body.label.trim() || members.some(id => !state.plots.has(id)||state.plots.get(id)?.active!==1||state.plots.get(id)?.deleted_at)) return err(422, 'invalid_group');
  if(!body.resolved&&!members.length)return err(422,'empty_active_group','An unresolved plot group must contain at least one plot');
  const layouts=new Set(members.map(id=>state.plots.get(id)!.settings.layout_code));if(layouts.size>1)return err(422,'heterogeneous_group','All plots in a group must use the same layout');
  if(current?.resolved_at&&body.resolved&&(current.members.length!==members.length||current.members.some((id,index)=>id!==members[index])))return err(409,'resolved_group_members_frozen','Unresolve the plot group before changing membership');
  if(current&&current.label===body.label.trim()&&current.members.length===members.length&&current.members.every((id,index)=>id===members[index])
    &&Boolean(current.resolved_at)===body.resolved)return clone(current);
  const at = iso(port.now), group: PlotGroup = {contract_version: 2, group_uuid: body.group_uuid, label: body.label.trim(), owner_user_uuid: port.owner,
    gateway_device_eui: port.gateway, created_by_principal_uuid: port.owner, created_at: current?.created_at ?? at,
    resolved_at: body.resolved ? current?.resolved_at ?? at : null, resolved_by_principal_uuid: body.resolved ? port.owner : null,
    sync_version: (current?.sync_version ?? 0) + 1, deleted_at: null, members};
  state.groups.set(group.group_uuid, group); port.recordMutation(); return group;
}
function crc32(data: Uint8Array): number {let crc = 0xffffffff; for (const byte of data) {crc ^= byte; for (let i=0;i<8;i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;} return (crc ^ 0xffffffff) >>> 0;}
function zipStored(members: Array<[string, Uint8Array]>): Uint8Array {
  const local: Uint8Array[] = [], central: Uint8Array[] = []; let offset=0;
  const put=(arr:Uint8Array[], data:Uint8Array)=>{arr.push(data);}; const header=(size:number)=>new Uint8Array(size); const u16=(v:DataView,o:number,n:number)=>v.setUint16(o,n,true); const u32=(v:DataView,o:number,n:number)=>v.setUint32(o,n>>>0,true);
  for(const [name,data] of members){const n=new TextEncoder().encode(name),crc=crc32(data),h=header(30),v=new DataView(h.buffer);u32(v,0,0x04034b50);u16(v,4,20);u16(v,6,0x08);u16(v,8,0);u16(v,26,n.length);put(local,h);put(local,n);put(local,data);const d=header(16),dv=new DataView(d.buffer);u32(dv,0,0x08074b50);u32(dv,4,crc);u32(dv,8,data.length);u32(dv,12,data.length);put(local,d);const c=header(46),cv=new DataView(c.buffer);u32(cv,0,0x02014b50);u16(cv,4,20);u16(cv,6,20);u16(cv,8,0x08);u16(cv,10,0);u32(cv,16,crc);u32(cv,20,data.length);u32(cv,24,data.length);u16(cv,28,n.length);u32(cv,42,offset);put(central,c);put(central,n);offset+=h.length+n.length+data.length+d.length;}
  const centralOffset=offset, centralSize=central.reduce((n,x)=>n+x.length,0), end=header(22),ev=new DataView(end.buffer);u32(ev,0,0x06054b50);u16(ev,8,members.length);u16(ev,10,members.length);u32(ev,12,centralSize);u32(ev,16,centralOffset);return concat([...local,...central,end]);
}
function concat(chunks: Uint8Array[]): Uint8Array {const size=chunks.reduce((n,c)=>n+c.length,0),out=new Uint8Array(size);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.length;}return out;}
function csvCell(value: unknown): string {
  if(typeof value==='number'&&Number.isFinite(value))return String(value);
  let text=value==null?'':typeof value==='object'?JSON.stringify(value):String(value);
  if(/^[ \u00a0]*(?:[=+\-@]|\t|\r)/u.test(text))text=`'${text}`;
  return `"${text.replace(/"/g,'""')}"`;
}
function exportRows(state: JournalState, filters: URLSearchParams): Entry[] {
  return filteredEntries(state,filters,false).rows.map(clone);
}
function wideCsv(entries: Entry[]): Uint8Array {
  const fixed=['entry_uuid','plot_uuid','zone_uuid','activity_code','template_code','template_version','layout_code','layout_version','occurred_start','occurred_end','occurred_timezone','status','campaign_uuid','protocol_code','protocol_version','observation_unit_code','pass_uuid','combination','batch_uuid','note','sync_version'];
  const cells=[...new Map(entries.flatMap(entry=>entry.values.map(value=>[`${value.group_index}\0${value.attribute_code}`,{group_index:value.group_index,attribute_code:value.attribute_code}]))).values()]
    .sort((a,b)=>a.group_index-b.group_index||a.attribute_code.localeCompare(b.attribute_code));
  const dynamic=cells.flatMap(value=>{const prefix=`value.${value.group_index}.${value.attribute_code}`;return [`${prefix}.status`,`${prefix}.value`,`${prefix}.unit`];});
  const columns=[...fixed,...dynamic], passNumbers=new Map<string,number>();
  const lines=[columns.map(csvCell).join(',')];
  for(const entry of entries){
    if(entry.pass_uuid&&!passNumbers.has(entry.pass_uuid))passNumbers.set(entry.pass_uuid,passNumbers.size+1);
    const row:Record<string,unknown>={...entry,combination:entry.pass_uuid?passNumbers.get(entry.pass_uuid):null};
    for(const value of entry.values){const prefix=`value.${value.group_index}.${value.attribute_code}`;row[`${prefix}.status`]=value.value_status;row[`${prefix}.value`]=value.value_num??value.value_text;row[`${prefix}.unit`]=value.unit_code;}
    lines.push(columns.map(column=>csvCell(row[column])).join(','));
  }
  return new TextEncoder().encode(lines.join('\r\n')+'\r\n');
}
const packageEntryColumns=['contract_version','entry_uuid','plot_uuid','zone_uuid','device_eui','season_uuid','season_crop','season_variety','campaign_uuid','protocol_code','protocol_version','observation_unit_code','pass_uuid','batch_uuid','activity_code','template_code','template_version','layout_code','layout_version','catalog_version','occurred_start','occurred_end','occurred_timezone','occurred_utc_offset_minutes','recorded_at','origin','status','voided_at','void_reason','note','context_json','sync_version','gateway_device_eui','created_at','updated_at','deleted_at'];
function packageEntryCsv(entries:Entry[],state:JournalState):Uint8Array{const lines=[packageEntryColumns.map(csvCell).join(',')];for(const entry of entries){const row=researchEntry(entry,state) as Record<string,unknown>;lines.push(packageEntryColumns.map(key=>csvCell(row[key])).join(','));}return new TextEncoder().encode(lines.join('\r\n')+'\r\n');}
function publicEntry(entry:Entry,state?:JournalState):Entry{const result=clone(entry);delete result.local_date;delete result.clientKey;if(state){const closed=[...state.cycles.values()].find(cycle=>cycle.ended_by_entry_uuid===entry.entry_uuid&&!cycle.voided_by_entry_uuid);if(closed){result.closed_crop_code=closed.crop_code;result.closed_crop_variety=closed.variety;}else{delete result.closed_crop_code;delete result.closed_crop_variety;}}return result;}
function researchEntry(entry: Entry,state?:JournalState): Record<string, unknown> {const result={...publicEntry(entry,state)} as Record<string,unknown>;for(const key of ['owner_user_uuid','author_principal_uuid','author_label','voided_by_principal_uuid'])delete result[key];return result;}
function canonicalText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonicalText((value as Record<string,unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function digestText(text: string): string {return sha256(new TextEncoder().encode(text));}
const schemaDescriptor={name:'osi-journal-research',version:1,entry_shape:'journal_entry_aggregate_without_author_or_owner_identity',value_shape:'typed_long_form_with_entered_and_canonical_units',missing_value_field:'value_status',package_members:['entries.csv','values.csv','vocab_mappings.csv','records.ndjson','manifest.json'],csv_string_safety:'formula-prefix apostrophe; exact source strings are in records.ndjson',lossless_member:'records.ndjson'};
const metadataDescriptor={name:'osi-journal-research-metadata',version:1,sections:['coverage','selection','source','exporter','schema','context_generator','catalog','definitions','mapping_sources','unit_transformations','record_counts','provenance'],unavailable_fact_shape:['value','reason']};
function metadataFor(entries: Entry[], filters: URLSearchParams, port: JournalPort, values: Entry['values'][number][]) {
  const sorted=(field:'occurred_start'|'recorded_at')=>entries.map(row=>row[field]).sort();
  const occurred=sorted('occurred_start'), recorded=sorted('recorded_at'), ends=entries.map(row=>row.occurred_end||row.occurred_start).sort();
  const versions=(field:'template_code'|'layout_code')=>[...new Map(entries.map(row=>[`${row[field]}:${row[field==='template_code'?'template_version':'layout_version']}`,{code:row[field],version:row[field==='template_code'?'template_version':'layout_version']}])).values()];
  const units=[...new Set(values.flatMap(row=>[row.entered_unit_code,row.unit_code]).filter((value):value is string=>Boolean(value)))].map(unit_code=>({unit_code,roles:[...(values.some(row=>row.entered_unit_code===unit_code)?['entered']:[]),...(values.some(row=>row.unit_code===unit_code)?['canonical']:[])]}));
  const metadata={metadata_contract:{name:metadataDescriptor.name,version:metadataDescriptor.version,hash_scope:'research_metadata_semantic_descriptor_v1',hash_sha256:digestText(canonicalText(metadataDescriptor))},
    dataset_uuid:uuid({sequence:0} as JournalState,'dataset'),export_uuid:uuid({sequence:0} as JournalState,'export'),generated_at:iso(port.now),
    coverage:{occurred_from:occurred[0]??null,occurred_to:occurred[occurred.length-1]??null,occurred_end_from:ends[0]??null,occurred_end_to:ends[ends.length-1]??null,occurred_end_semantics:'occurred_end_or_occurred_start_for_instantaneous_entries',recorded_from:recorded[0]??null,recorded_to:recorded[recorded.length-1]??null},
    selection:Object.fromEntries([...filters.entries()].filter(([key])=>key!=='cursor'&&key!=='limit').sort(([a],[b])=>a.localeCompare(b))),
    source:{system:'OSI OS edge',authority:'edge-canonical',gateway_device_eui:port.gateway,farm_identifier:{value:null,reason:'farm_identifier_not_recorded'},zone_uuids:[...new Set(entries.flatMap(row=>row.zone_uuid?[row.zone_uuid]:[]))].sort(),plot_uuids:[...new Set(entries.flatMap(row=>row.plot_uuid?[row.plot_uuid]:[]))].sort()},
    exporter:{name:'osi-journal',version:{value:'1.0.0',reason:null},edge_build_version:{value:null,reason:'edge_build_version_unavailable'},commit:{value:null,reason:'edge_build_commit_unavailable'}},
    schema:{name:schemaDescriptor.name,version:schemaDescriptor.version,hash_scope:'logical_research_schema_descriptor_v1',hash_sha256:digestText(canonicalText(schemaDescriptor)),package_members:schemaDescriptor.package_members,csv_string_safety:schemaDescriptor.csv_string_safety,lossless_member:schemaDescriptor.lossless_member},
    context_generator:{hash_scope:'frozen_context_json_generator_contract',pinned:[],per_capture_binary_hash:{value:null,reason:'context_generator_binary_hash_not_recorded_at_capture'},unpinned_entries:{count:0,reason:null},no_context_entries:{count:entries.filter(row=>row.context_json==null).length,reason:entries.some(row=>row.context_json==null)?'context_snapshot_not_recorded':null}},
    catalog:{hash_scope:'core_catalog_state',core_version:seed.catalog_version,core_hash:seed.catalog_hash,scoped_effective_hash:{value:null,reason:'scoped_catalog_hash_not_materialized'}},
    definitions:{templates:versions('template_code').map(row=>{const found=provenance.templates.find(item=>item.code===row.code&&item.version===row.version);return {code:row.code,version:row.version,hash_scope:'raw_definition_json_utf8',definition_sha256:found?.definition_sha256??null,reason:found?.definition_sha256?null:'template_definition_unavailable'};}),layouts:versions('layout_code').map(row=>{const found=provenance.layouts.find(item=>item.code===row.code&&item.version===row.version);return {code:row.code,version:row.version,hash_scope:'raw_definition_json_utf8',definition_sha256:found?.definition_sha256??null,reason:found?.definition_sha256?null:'layout_definition_unavailable'};})},
    mapping_sources:[...new Map(seed.mappings.map(row=>{const key=`${row.scheme_uri}\0${row.scheme_version}\0${row.source_uri??''}`;return [key,{scheme_uri:row.scheme_uri,scheme_version:row.scheme_version,source_uri:row.source_uri?{value:row.source_uri,reason:null}:{value:null,reason:'mapping_source_uri_not_recorded'},license:{value:null,reason:'mapping_license_not_recorded'},mapping_count:seed.mappings.filter(item=>item.scheme_uri===row.scheme_uri&&item.scheme_version===row.scheme_version&&item.source_uri===row.source_uri).length}];})).values()].sort((a,b)=>(a.scheme_uri??'').localeCompare(b.scheme_uri??'')||(a.scheme_version??'').localeCompare(b.scheme_version??'')),unit_transformations:units.map(row=>{const unit=provenance.units.find(item=>item.code===row.unit_code),constraints=unit?.constraints_json?JSON.parse(unit.constraints_json) as Record<string,unknown>:{};const toCanonical=constraints.to_canonical&&typeof constraints.to_canonical==='object'?constraints.to_canonical:null;return {unit_code:row.unit_code,roles:row.roles,transformation:unit?{quantity_kind:unit.quantity_kind,basis:unit.basis,dimension:constraints.dimension??null,to_canonical:toCanonical,formula:toCanonical?'canonical_value = entered_value * scale + offset':null}:null,hash_scope:'raw_constraints_json_utf8',definition_sha256:unit?.constraints_sha256??null,reason:!unit?'unit_definition_not_installed':toCanonical?null:'unit_transformation_not_recorded'};}),
    record_counts:{entries:entries.length,values:values.length,vocab_mappings:seed.mappings.length},provenance:{author_identity_included:false,owner_identity_included:false,context_snapshot_semantics:'frozen-at-entry-finalization',missing_values:'value_status distinguishes not_observed, not_applicable, and below_detection'}};
  return metadata;
}
function exportBytes(state: JournalState, path: string, filters: URLSearchParams, port: JournalPort): Uint8Array {
  const entries=exportRows(state,filters), entryCsvBytes=wideCsv(entries);
  const values=entries.flatMap(entry=>entry.values.map(value=>({entry_uuid:entry.entry_uuid,attribute_code:value.attribute_code,group_index:value.group_index,value_status:value.value_status,entered_value_num:value.entered_value_num,entered_unit_code:value.entered_unit_code,value_num:value.value_num,value_text:value.value_text,unit_code:value.unit_code}))); const valueColumns=['entry_uuid','attribute_code','group_index','value_status','entered_value_num','entered_unit_code','value_num','value_text','unit_code'];
  const metadata=metadataFor(entries,filters,port,values);
  const researchEntries=entries.map(entry=>researchEntry(entry,state));
  if(path.endsWith('.csv'))return entryCsvBytes;
  if(path.endsWith('.json')){
    const entryText=JSON.stringify(researchEntries), valueText=JSON.stringify(values);
    const json={schema:'osi-journal-research-v1',research_metadata:metadata,entries:researchEntries,record_counts:metadata.record_counts,checksums:{research_metadata_sha256:digestText(JSON.stringify(metadata)),entries_sha256:digestText(entryText),values_sha256:digestText(valueText)}};
    return new TextEncoder().encode(JSON.stringify(json));
  }
  const records=[...entries.map(row=>{const data=researchEntry(row,state);delete data.values;return JSON.stringify({record_type:'entry',data});}),...values.map(data=>JSON.stringify({record_type:'value',data})),...seed.mappings.map(data=>JSON.stringify({record_type:'vocab_mapping',data}))].join('\n')+'\n';
  const members: Array<[string,Uint8Array]> = [['entries.csv',packageEntryCsv(entries,state)],
    ['values.csv',new TextEncoder().encode(valueColumns.join(',')+'\r\n'+values.map(value=>valueColumns.map(key=>csvCell((value as unknown as Record<string,unknown>)[key])).join(',')).join('\r\n')+'\r\n')],
    ['vocab_mappings.csv',new TextEncoder().encode('term_code,scheme_uri,scheme_version,mapping_role,external_id,external_parent_id,mapping_relation,source_uri,active\r\n'+seed.mappings.map(row=>Object.values(row).map(csvCell).join(',')).join('\r\n')+'\r\n')],['records.ndjson',new TextEncoder().encode(records)]];
  const memberFacts=members.map(([name,data])=>({name,size_bytes:data.length,sha256:sha256(data)})); const manifest={schema:'osi-journal-research-package-v1',research_metadata:metadata,members:memberFacts,record_counts:metadata.record_counts,checksums:{research_metadata_sha256:sha256(new TextEncoder().encode(JSON.stringify(metadata)))},missing_value_semantics:'See values.csv value_status; blank values are not assumed observed.'};
  members.push(['manifest.json',new TextEncoder().encode(JSON.stringify(manifest))]);return zipStored(members);
}
export function handleJournalRoute(state: JournalState, port: JournalPort, method: string, url: URL, body: Record<string, unknown>): unknown {
  ensurePlots(state, port); const path=url.pathname;
  if(method==='GET'&&path==='/api/journal/catalog')return activeCatalog(url.searchParams.get('include')==='definitions');
  if(method==='GET'&&path==='/api/journal/plots')return {plots:[...state.plots.values()].filter(plot=>!plot.deleted_at).map(plot=>plotAggregate(plot,state))};
  if(method==='POST'&&path==='/api/journal/plots')return {plot:upsertPlot(state,port,body as unknown as JournalPlotWritePayload)};
  const plotMatch=path.match(/^\/api\/journal\/plots\/([^/]+)$/);
  if(method==='PUT'&&plotMatch)return {plot:upsertPlot(state,port,body as unknown as JournalPlotWritePayload,decodeURIComponent(plotMatch[1]!))};
  if(method==='GET'&&path==='/api/journal/plot-groups')return {plot_groups:[...state.groups.values()].filter(row=>!row.deleted_at).map(clone)};
  if(method==='POST'&&path==='/api/journal/plot-groups')return {plot_group:upsertGroup(state,port,body as unknown as JournalPlotGroupWritePayload)};
  const groupMatch=path.match(/^\/api\/journal\/plot-groups\/([^/]+)$/);
  if(method==='PUT'&&groupMatch)return {plot_group:upsertGroup(state,port,body as unknown as JournalPlotGroupWritePayload,decodeURIComponent(groupMatch[1]!))};
  if(method==='GET'&&path==='/api/journal/entries')return entriesPage(state,url.searchParams);
  if(method==='POST'&&path==='/api/journal/entries'){
    if(Array.isArray(body.members)){
      const members=body.members as Array<Record<string,unknown>>, before=clone(state.entries),cycles=clone(state.cycles),sequence=state.sequence,pending:unknown[]=[];
      const acks=body.duplicate_guard_ack_entry_uuids??[];if(!Array.isArray(acks)||acks.some(value=>typeof value!=='string')||new Set(acks).size!==acks.length)return err(422,'invalid_duplicate_ack','Batch duplicate acknowledgements are invalid');
      if(new Set(members.map(member=>member.entry_uuid)).size!==members.length)return err(422,'duplicate_member','Batch member entry UUIDs must be unique');
      const pass=typeof body.pass_uuid==='string'?body.pass_uuid:null;
      if(pass&&new Set(members.map(member=>member.plot_uuid)).size!==1)return err(422,'invalid_batch','A pass batch requires every member to share one plot');
      if(!pass&&new Set(members.map(member=>member.plot_uuid)).size!==members.length)return err(422,'duplicate_member','Batch member plot UUIDs must be unique');
      const duplicateByMember=new Map<string,Entry>(),candidateFacts=new Map<string,{entryUuid:string;occurredStart:string;activityCode:string;plotUuid:string|null}>();
      for(const member of members){if(typeof member.plot_uuid!=='string'||typeof member.entry_uuid!=='string')return err(422,'invalid_batch_member');const occurred=localOccurrence(body.occurred_start_local,body.occurred_timezone,body.occurred_utc_offset_minutes);const candidate=duplicateCandidate(state,member.plot_uuid,String(body.activity_code),Date.parse(occurred.utc),pass);if(candidate){duplicateByMember.set(member.entry_uuid,candidate);candidateFacts.set(candidate.entry_uuid,{entryUuid:candidate.entry_uuid,occurredStart:candidate.occurred_start,activityCode:candidate.activity_code,plotUuid:candidate.plot_uuid});}}
      const unknownAck=acks.filter(value=>!candidateFacts.has(value as string));if(unknownAck.length)return err(422,'invalid_duplicate_ack','A batch duplicate acknowledgement does not match a current candidate');
      const unacknowledged=[...candidateFacts.values()].filter(candidate=>!acks.includes(candidate.entryUuid));if(unacknowledged.length)return err(409,'duplicate_candidates','Similar final journal entries already exist',{duplicateCandidates:unacknowledged});
      const batchUuid=typeof body.batch_uuid==='string'?body.batch_uuid:uuid(state,'batch');
      let mutations=0;const batchPort={...port,recordMutation:()=>{mutations+=1;}};
      try{for(const member of members){const duplicate=duplicateByMember.get(String(member.entry_uuid));pending.push(saveEntry(state,batchPort,{...body,...member,batch_uuid:batchUuid,status:'final',plot_uuid:member.plot_uuid,entry_uuid:member.entry_uuid,base_sync_version:0,...(duplicate?{duplicate_guard_ack_entry_uuid:duplicate.entry_uuid}:{})}));}}
      catch(error){state.entries=before;state.cycles=cycles;state.sequence=sequence;throw error;}
      for(let i=0;i<mutations;i++)port.recordMutation();return {batch_uuid:batchUuid,entries:(pending as Array<Record<string,unknown>>).map((item,index)=>({plot_uuid:members[index]!.plot_uuid,entry_uuid:item.entry_uuid,outbox_event_uuid:item.outbox_event_uuid,sync_version:item.sync_version}))};
    }
    return saveEntry(state,port,body);
  }
  const entryMatch=path.match(/^\/api\/journal\/entries\/([^/]+)(?:\/(void))?$/);
  if(entryMatch){const id=decodeURIComponent(entryMatch[1]!);if(method==='PUT'&&body.discard===true)return saveEntry(state,port,body,id);if(method==='PUT')return saveEntry(state,port,body,id);if(method==='POST'&&entryMatch[2])return voidEntry(state,port,id,body);}
  if(method==='GET'&&['/api/journal/export.csv','/api/journal/export.json','/api/journal/export.package'].includes(path))return exportBytes(state,path,url.searchParams,port);
  return err(404,'not_found','Journal endpoint was not found');
}
