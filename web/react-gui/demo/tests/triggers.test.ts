import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {AxiosAdapter, AxiosResponse} from 'axios';
import {AxiosError} from 'axios';
import {api, irrigationZonesAPI} from '../../src/services/api';
import {DemoError, Simulator} from '../model';
import {VALVE_EUI} from '../fixtures';
import {dendroRuleDecision, selectDendroRecommendation, type DendroRecommendation} from '../model/triggers';

const outcomes = (sim: Simulator) => (sim.request('GET', '/api/irrigation/recent-actuations') as {
  actuations: Array<{trigger: string; status: string; commandedDurationSeconds: number; commandResultDetail: string | null}>;
}).actuations;

function installSimulator(sim: Simulator): void {
  const adapter: AxiosAdapter = async config => {
    const url = new URL(config.url ?? '', 'http://simulator.test');
    const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data ?? {};
    try {
      const data = sim.request(config.method ?? 'GET', `${url.pathname}${url.search}`, body as Record<string, unknown>);
      return {data, status: 200, statusText: 'OK', headers: {}, config} as AxiosResponse;
    } catch (error) {
      if (!(error instanceof DemoError)) throw error;
      throw new AxiosError(error.message, 'ERR_SIMULATOR', config, undefined, {
        data: error.data ?? {error: error.code, message: error.message}, status: error.status,
        statusText: 'Simulator', headers: {}, config,
      });
    }
  };
  api.defaults.adapter = adapter;
}

async function saveRule(sim: Simulator, patch: Record<string, unknown> = {}) {
  installSimulator(sim);
  return irrigationZonesAPI.updateSchedule(1, {trigger_metric: 'SWT_1', threshold_kpa: 45, enabled: true,
    duration_minutes: 5, ...patch} as Parameters<typeof irrigationZonesAPI.updateSchedule>[1]);
}

test('TR01 saves and rereads the native SWT rule, then disabling prevents its daily run', async () => {
  const sim = new Simulator({mode: 'public'});
  const saved = await saveRule(sim, {duration_minutes: 7});
  assert.equal(saved.duration_minutes, 7);
  assert.equal((await irrigationZonesAPI.getAll())[0]?.schedule?.duration_minutes, 7);
  await saveRule(sim, {enabled: false, duration_minutes: 7});
  sim.advanceTo(sim.now + 20_000);
  assert.equal(outcomes(sim).length, 0);
  assert.equal(sim.devices.find(device => device.deveui === VALVE_EUI)?.current_state, 'CLOSED');
});

test('TR02 runs at the daily event for equality, skips below threshold, and applies edits next UTC day', async () => {
  const sim = new Simulator({mode: 'public'});
  sim.readings.clear();
  sim.readings.append('00000000000000A1', sim.now, {swt_1: 45});
  await saveRule(sim, {threshold_kpa: 45});
  sim.advanceTo(sim.now + 20_000);
  const first = outcomes(sim)[0];
  assert.equal(first?.trigger, 'trigger_based');
  assert.equal(first?.status, 'RUNNING');
  assert.equal(first?.commandedDurationSeconds, 300);
  assert.equal(first?.commandResultDetail, 'daily-trigger:1');
  assert.equal(sim.state.triggerEvaluations[0]?.value, 45);
  const reread = (await irrigationZonesAPI.getAll())[0]?.schedule as (Record<string, unknown> & {last_triggered_at: string}) | null | undefined;
  assert.equal((reread?.last_evaluation as {reason: string}).reason, 'threshold_met');
  assert.equal(typeof reread?.last_triggered_at, 'string');
  sim.advanceTo(Date.parse('2026-10-10T03:05:02.000Z'));
  assert.equal(outcomes(sim)[0]?.status, 'COMPLETED');
  assert.equal(outcomes(sim)[0]?.estimatedGrossLiters, 30);

  await saveRule(sim, {threshold_kpa: 300});
  const beforeBelowThreshold = outcomes(sim).length;
  sim.advanceTo(Date.parse('2026-10-11T03:00:00.000Z'));
  assert.equal(outcomes(sim).length, beforeBelowThreshold);
  assert.equal(sim.state.triggerEvaluations[0]?.reason, 'below_threshold');
  await saveRule(sim, {threshold_kpa: 40, duration_minutes: 9});
  sim.advanceTo(Date.parse('2026-10-12T03:00:00.000Z'));
  const last = outcomes(sim)[0];
  assert.equal(last?.commandedDurationSeconds, 540);
});

test('TR03 accepts offered SWT3 and DENDRO rules with their exposed response settings', async () => {
  const sim = new Simulator({mode: 'public'});
  await saveRule(sim, {trigger_metric: 'SWT_3'});
  await saveRule(sim, {trigger_metric: 'DENDRO', threshold_kpa: 2, response_mode: 'proportional'});
  const reread = (await irrigationZonesAPI.getAll())[0]?.schedule;
  assert.equal(reread?.trigger_metric, 'DENDRO');
  assert.equal(reread?.response_mode, 'proportional');
});

test('invalid schedule settings retain the previous saved rule', async () => {
  const sim = new Simulator({mode: 'public'});
  await saveRule(sim);
  await assert.rejects(saveRule(sim, {duration_minutes: 241}), (error: unknown) => error instanceof AxiosError && error.response?.status === 400);
  const reread = (await irrigationZonesAPI.getAll())[0]?.schedule;
  assert.equal(reread?.duration_minutes, 5);
});

test('SWT_AVG averages each sample row before combining rows and excludes WATERMARK evidence', async () => {
  const sim = new Simulator({mode: 'public'});
  sim.readings.clear();
  const second = sim.devices.find(device => device.deveui.endsWith('A3'))!;
  second.irrigation_zone_id = 1;
  sim.readings.append('00000000000000A1', sim.now, {swt_1: 30, swt_2: null, swt_3: 60, swt_wm1: 99});
  sim.readings.append(second.deveui, sim.now, {swt_1: 60, swt_2: 60, swt_3: null});
  await saveRule(sim, {trigger_metric: 'SWT_AVG', threshold_kpa: 53});
  sim.advanceTo(sim.now + 20_000);
  assert.equal(sim.state.triggerEvaluations[0]?.value, 52.5);
  assert.equal(sim.state.triggerEvaluations[0]?.reason, 'below_threshold');

  const next = new Simulator({mode: 'public'});
  const watermarkEui = '00000000000000E5';
  const watermarkEvidence = next.readings.latestSample(watermarkEui)?.values.watermark;
  assert.ok(watermarkEvidence);
  next.readings.clear();
  next.devices.find(device => device.deveui === watermarkEui)!.irrigation_zone_id = 1;
  next.readings.append(watermarkEui, next.now, {swt_1: 90, watermark: watermarkEvidence});
  await saveRule(next, {threshold_kpa: 45});
  next.advanceTo(next.now + 20_000);
  assert.equal(next.state.triggerEvaluations[0]?.reason, 'no_data_last_hour');
  assert.equal(outcomes(next).length, 0);
});

test('ordinary Chameleon LSN50 rows have no Watermark evidence and remain eligible', async () => {
  const sim = new Simulator({mode: 'public'});
  const chameleon = sim.devices.find(device => device.deveui === '00000000000000E3')!;
  assert.equal(sim.readings.forDevice(chameleon.deveui).some(sample => sample.values.watermark !== undefined), false);
  sim.readings.clear();
  chameleon.irrigation_zone_id = 1;
  sim.readings.append(chameleon.deveui, sim.now, {swt_1: 90, swt_2: 80, swt_3: 70});
  assert.equal(sim.readings.latestSample(chameleon.deveui)?.values.watermark, undefined);
  await saveRule(sim, {threshold_kpa: 45});
  sim.advanceTo(sim.now + 20_000);
  assert.equal(sim.state.triggerEvaluations[0]?.value, 90);
  assert.equal(sim.state.triggerEvaluations[0]?.reason, 'threshold_met');
  assert.equal(outcomes(sim).length, 1);
});

test('missing and stale SWT samples both produce a truthful no-data decision', async () => {
  for (const offset of [null, -60 * 60 * 1000 - 1]) {
    const sim = new Simulator({mode: 'public'});
    sim.readings.clear();
    if (offset !== null) sim.readings.append('00000000000000A1', sim.now + offset, {swt_1: 90});
    await saveRule(sim, {threshold_kpa: 45});
    sim.advanceTo(sim.now + 20_000);
    assert.equal(sim.state.triggerEvaluations[0]?.reason, 'no_data_last_hour');
    assert.equal(outcomes(sim).length, 0);
  }
});

test('a daily trigger records same-UTC-day debounce and a missing valve without an outcome', async () => {
  const sim = new Simulator({mode: 'public'});
  await saveRule(sim, {threshold_kpa: 45});
  sim.advanceTo(sim.now + 20_000);
  sim.onDailyTrigger?.(sim.now);
  assert.equal(sim.state.triggerEvaluations[0]?.reason, 'same_logical_window');
  assert.match(sim.state.triggerEvaluations[0]?.advisory ?? '', /same UTC date/i);
  const withoutValve = new Simulator({mode: 'public'});
  withoutValve.devices = withoutValve.devices.filter(device => device.type_id !== 'STREGA_VALVE' || device.irrigation_zone_id !== 1);
  await saveRule(withoutValve, {threshold_kpa: 45});
  withoutValve.advanceTo(withoutValve.now + 20_000);
  assert.equal(withoutValve.state.triggerEvaluations[0]?.reason, 'missing_valve');
  assert.equal(outcomes(withoutValve).length, 0);
});

test('DENDRO evaluation uses the same configured reference cohort as the recommendation read', async () => {
  const sim = new Simulator({mode: 'public'});
  sim.readings.clear();
  const first = sim.devices.find(device => device.deveui === '00000000000000E3')!;
  const reference = sim.devices.find(device => device.deveui === '00000000000000E4')!;
  first.is_reference_tree = 0;
  reference.dendro_enabled = 1;
  sim.request('PUT', `/api/devices/${reference.deveui}/reference-tree`, {is_reference_tree: 1});
  sim.readings.append(first.deveui, sim.now - 60 * 60 * 1000, {dendro_position_mm: 10, dendro_valid: 1});
  sim.readings.append(first.deveui, sim.now, {dendro_position_mm: 10.5, dendro_valid: 1});
  sim.readings.append(reference.deveui, sim.now - 60 * 60 * 1000, {dendro_position_mm: 10, dendro_valid: 1});
  sim.readings.append(reference.deveui, sim.now, {dendro_position_mm: 10, dendro_valid: 1});
  const visible = sim.request('GET', '/api/irrigation-zones/2/recommendations?days=2') as Array<Record<string, unknown>>;
  assert.equal(visible.at(-1)?.zone_stress_summary, 'none');
  installSimulator(sim);
  await irrigationZonesAPI.updateSchedule(2, {trigger_metric: 'DENDRO', threshold_kpa: 3, enabled: true,
    duration_minutes: 20, response_mode: 'fixed'});
  sim.advanceTo(sim.now + 20_000);
  assert.equal(sim.state.triggerEvaluations[0]?.value, visible.at(-1)?.zone_stress_summary);
  assert.equal(sim.state.triggerEvaluations[0]?.reason, 'below_dendro_sensitivity');
});

test('DENDRO decision and advisory retain selected unknown shared evidence', () => {
  const now = Date.parse('2026-10-10T03:00:00.000Z');
  const shared = {source: 'dendro', irrigation_action: 'maintain_rain_suppression', zone_stress_summary: null,
    computed_at: new Date(now - 5 * 60 * 60 * 1000).toISOString(), action_reasoning: 'New rain: 15mm',
    zone_confidence_score: null, low_confidence_tree_count: 1, rainfall_mm: 15, rain_suppression_active: 1};
  const selected = selectDendroRecommendation(shared, null, now)!;
  const decision = dendroRuleDecision({irrigation_zone_id: 2, trigger_metric: 'DENDRO', threshold_kpa: 3,
    enabled: true, duration_minutes: 20, response_mode: 'fixed'}, selected, false, now);
  assert.equal(decision.reason, 'unknown_dendro_stress');
  assert.equal((decision as typeof decision & {evidence?: typeof shared}).evidence?.source, 'dendro');
  assert.equal((decision as typeof decision & {evidence?: typeof shared}).evidence?.computedAt, shared.computed_at);
  assert.equal((decision as typeof decision & {evidence?: typeof shared}).evidence?.action, shared.irrigation_action);
  assert.match(decision.advisory, /maintain_rain_suppression/);
  assert.match(decision.advisory, /New rain: 15mm/);
  assert.match(decision.advisory, /5\.0 hours old/i);
});

test('shared unknown DENDRO evidence does not invent dry weather, no-stress history, or inactive flags', () => {
  const now = Date.parse('2026-10-10T03:00:00.000Z');
  const shared = {source: 'dendro', irrigation_action: 'maintain', zone_stress_summary: null,
    computed_at: new Date(now).toISOString(), action_reasoning: 'No reliable dendrometer data'};
  const decision = dendroRuleDecision({irrigation_zone_id: 2, trigger_metric: 'DENDRO', threshold_kpa: 2,
    enabled: true, duration_minutes: 20, response_mode: 'fixed'}, shared, false, now);
  assert.equal(decision.reason, 'unknown_dendro_stress');
  assert.match(decision.advisory, /Selected dendro recommendation.*maintain — No reliable dendrometer data/);
  assert.match(decision.advisory, /rain unknown; rain suppression unknown; recovery verification unknown/i);
  assert.match(decision.advisory, /Selected source advisory: maintain — No reliable dendrometer data/);
  assert.doesNotMatch(decision.advisory, /No stress ≥2 of 3 days|dry|rain suppression inactive|recovery verification inactive/i);
});

test('shared DENDRO rain suppression keeps its supplied source advisory beside the public rule', () => {
  const now = Date.parse('2026-10-10T03:00:00.000Z');
  const shared = {source: 'dendro', irrigation_action: 'maintain_rain_suppression', zone_stress_summary: 'moderate',
    computed_at: new Date(now).toISOString(), action_reasoning: 'Rain suppression (24h/72h)', rainfall_mm: 0,
    rain_suppression_active: 1};
  const decision = dendroRuleDecision({irrigation_zone_id: 2, trigger_metric: 'DENDRO', threshold_kpa: 2,
    enabled: true, duration_minutes: 20, response_mode: 'fixed'}, shared, false, now);
  assert.equal(decision.reason, 'threshold_met');
  assert.match(decision.advisory, /Selected dendro recommendation.*maintain_rain_suppression — Rain suppression \(24h\/72h\)/);
  assert.match(decision.advisory, /Illustrative simulator rule: moderate DENDRO stress met sensitivity 2; fixed response gives 20 minutes/i);
  assert.doesNotMatch(decision.advisory, /decrease_10|No stress ≥2 of 3 days/i);
});

test('local DENDRO advisory keeps confidence and reports unavailable shipped policy inputs', async () => {
  const sim = new Simulator({mode: 'public'});
  sim.readings.clear();
  sim.readings.append('00000000000000E3', sim.now - 60 * 60 * 1000, {dendro_position_mm: 10, dendro_valid: 1});
  sim.readings.append('00000000000000E3', sim.now, {dendro_position_mm: 10.35, dendro_valid: 1});
  sim.readings.append('00000000000000E2', sim.now, {rain_mm_delta: 15});
  installSimulator(sim);
  await irrigationZonesAPI.updateSchedule(2, {trigger_metric: 'DENDRO', threshold_kpa: 3, enabled: true,
    duration_minutes: 20, response_mode: 'fixed'});
  sim.advanceTo(sim.now + 20_000);
  const evaluation = sim.state.triggerEvaluations[0]!;
  assert.equal(evaluation.value, 'significant');
  assert.equal(evaluation.dendroEvidence?.source, 'local');
  assert.equal(evaluation.dendroEvidence?.action, 'increase_10');
  assert.equal(evaluation.dendroEvidence?.lowConfidenceTreeCount, 1);
  assert.equal(evaluation.dendroEvidence?.zoneConfidenceScore, 0.7);
  assert.match(evaluation.advisory, /rain 0 mm/);
  assert.match(evaluation.advisory, /Source analytics advisory unavailable/);
  assert.match(evaluation.advisory, /Illustrative simulator rule/);
});

test('deleting the final enabled trigger removes its queued daily event', async () => {
  const sim = new Simulator({mode: 'public'});
  await saveRule(sim, {threshold_kpa: 45});
  assert.ok(sim.clock.ids().some(id => id.startsWith('daily-trigger:')));
  sim.request('DELETE', '/api/irrigation-zones/1');
  assert.equal(sim.clock.ids().some(id => id.startsWith('daily-trigger:')), false);
  assert.equal(sim.jumpToNextEvent(), false);
  assert.equal(sim.state.triggerEvaluations.length, 0);
});

test('DENDRO uses exposed stress sensitivity and response mode with bounded durations', () => {
  const recommendation = (stress: string, action = 'maintain'): DendroRecommendation => ({source: 'local',
    irrigation_action: action, zone_stress_summary: stress, computed_at: new Date(0).toISOString()});
  const schedule = (threshold_kpa: number, response_mode: string, duration_minutes = 20) => ({
    irrigation_zone_id: 1, trigger_metric: 'DENDRO' as const, threshold_kpa, enabled: true, response_mode, duration_minutes,
  });
  assert.equal(dendroRuleDecision(schedule(3, 'fixed'), recommendation('moderate')).reason, 'below_dendro_sensitivity');
  assert.equal(dendroRuleDecision(schedule(2, 'fixed'), recommendation('moderate')).durationMinutes, 20);
  assert.equal(dendroRuleDecision(schedule(2, 'proportional'), recommendation('moderate')).durationMinutes, 22);
  assert.equal(dendroRuleDecision(schedule(2, 'aggressive'), recommendation('moderate')).durationMinutes, 24);
  assert.equal(dendroRuleDecision(schedule(2, 'proportional'), recommendation('significant')).durationMinutes, 24);
  assert.equal(dendroRuleDecision(schedule(2, 'aggressive'), recommendation('significant')).durationMinutes, 28);
  assert.equal(dendroRuleDecision(schedule(4, 'aggressive'), recommendation('severe')).durationMinutes, 40);
  assert.equal(dendroRuleDecision(schedule(4, 'aggressive', 240), recommendation('severe')).durationMinutes, 240);
  assert.equal(dendroRuleDecision(schedule(1, 'fixed'), recommendation('unknown')).reason, 'unknown_dendro_stress');
});

test('DENDRO selection accepts the shared six-hour boundary and falls back to fresh local data', () => {
  const now = Date.parse('2026-10-10T03:00:00.000Z');
  const row = (computedAt: number, source: string, action: string, stress: string): DendroRecommendation => ({
    source, irrigation_action: action, zone_stress_summary: stress, computed_at: new Date(computedAt).toISOString(),
  });
  const local = row(now, 'local', 'maintain', 'mild');
  const shared = row(now - 6 * 60 * 60 * 1000, 'dendro', 'increase_10', 'moderate');
  assert.equal(selectDendroRecommendation(shared, local, now), shared);
  assert.equal(selectDendroRecommendation(row(now - 6 * 60 * 60 * 1000 - 1, 'dendro', 'increase_10', 'moderate'), local, now), local);
  assert.equal(selectDendroRecommendation(row(now, 'wrong-source', 'increase_10', 'severe'), local, now), local);
  assert.equal(selectDendroRecommendation(row(now, 'dendro', 'unsupported', 'severe'), local, now), local);
  assert.equal(selectDendroRecommendation(row(now + 1, 'dendro', 'increase_10', 'severe'), local, now), local);
  assert.equal(selectDendroRecommendation(null, row(now - 36 * 60 * 60 * 1000, 'local', 'maintain', 'moderate'), now)?.zone_stress_summary, 'moderate');
  assert.equal(selectDendroRecommendation(null, row(now - 36 * 60 * 60 * 1000 - 1, 'local', 'maintain', 'moderate'), now), null);
});

test('DENDRO stale recommendation is distinguished from no recommendation in evaluation history', async () => {
  const sim = new Simulator({mode: 'public'});
  sim.readings.clear();
  sim.readings.append('00000000000000E3', sim.now - 36 * 60 * 60 * 1000 - 1,
    {dendro_position_mm: 12, dendro_valid: 1});
  installSimulator(sim);
  await irrigationZonesAPI.updateSchedule(2, {trigger_metric: 'DENDRO', threshold_kpa: 1, enabled: true,
    duration_minutes: 20, response_mode: 'fixed'});
  sim.advanceTo(sim.now + 20_000);
  assert.equal(sim.state.triggerEvaluations[0]?.reason, 'stale_dendro_recommendation');
});

test('a fresh significant local DENDRO recommendation runs with the saved proportional response', async () => {
  const sim = new Simulator({mode: 'public'});
  sim.readings.clear();
  sim.readings.append('00000000000000E3', sim.now - 60 * 60 * 1000,
    {dendro_position_mm: 10, dendro_valid: 1});
  sim.readings.append('00000000000000E3', sim.now,
    {dendro_position_mm: 10.35, dendro_valid: 1});
  installSimulator(sim);
  await irrigationZonesAPI.updateSchedule(2, {trigger_metric: 'DENDRO', threshold_kpa: 3,
    enabled: true, duration_minutes: 20, response_mode: 'proportional'});
  sim.advanceTo(sim.now + 20_000);
  const decision = sim.state.triggerEvaluations[0];
  assert.equal(decision?.value, 'significant');
  assert.equal(decision?.durationMinutes, 24);
  assert.match(decision?.advisory ?? '', /significant DENDRO stress met sensitivity 3; proportional response gives 24 minutes/);
  assert.equal(outcomes(sim)[0]?.trigger, 'trigger_based');
});

test('an automatic trigger records busy when a manual command already owns the valve', async () => {
  const sim = new Simulator({mode: 'public'});
  assert.equal(sim.startActuation(VALVE_EUI, 60, 'manual', 2000, true), true);
  await saveRule(sim, {threshold_kpa: 45});
  sim.advanceTo(sim.now + 20_000);
  assert.equal(sim.state.triggerEvaluations[0]?.reason, 'busy');
  assert.equal(outcomes(sim).filter(row => row.deviceEui === VALVE_EUI).length, 1);
});

test('SWT3 reads Chameleon canonical channel and SWT_WM1 reads the legacy alias', async () => {
  const chameleon = new Simulator({mode: 'public'});
  chameleon.readings.clear();
  chameleon.readings.append('00000000000000E3', chameleon.now, {swt_3: 66});
  installSimulator(chameleon);
  await irrigationZonesAPI.updateSchedule(2, {trigger_metric: 'SWT_3', threshold_kpa: 66, enabled: true, duration_minutes: 5});
  chameleon.advanceTo(chameleon.now + 20_000);
  assert.equal(chameleon.state.triggerEvaluations[0]?.value, 66);
  assert.equal(chameleon.state.triggerEvaluations[0]?.reason, 'threshold_met');

  const legacy = new Simulator({mode: 'public'});
  legacy.readings.clear();
  legacy.readings.append('00000000000000A1', legacy.now, {swt_1: null, swt_wm1: 47});
  await saveRule(legacy, {trigger_metric: 'SWT_WM1', threshold_kpa: 47});
  legacy.advanceTo(legacy.now + 20_000);
  assert.equal(legacy.state.triggerEvaluations[0]?.value, 47);
  assert.equal(legacy.state.triggerEvaluations[0]?.reason, 'threshold_met');
});

test('a plain LSN50 SWT row is excluded and the oldest created assigned valve receives the run', async () => {
  const sim = new Simulator({mode: 'public'});
  sim.readings.clear();
  const kiwi = sim.devices.find(device => device.deveui.endsWith('A1'))!;
  kiwi.irrigation_zone_id = null;
  sim.readings.append('00000000000000E1', sim.now, {swt_1: 90});
  await saveRule(sim, {threshold_kpa: 45});
  sim.advanceTo(sim.now + 20_000);
  assert.equal(sim.state.triggerEvaluations[0]?.reason, 'no_data_last_hour');

  const ordered = new Simulator({mode: 'public'});
  ordered.readings.clear();
  ordered.readings.append('00000000000000A1', ordered.now, {swt_1: 50});
  const valve = ordered.devices.find(device => device.deveui === VALVE_EUI)!;
  valve.created_at = new Date(ordered.now).toISOString();
  const older = {...structuredClone(valve), deveui: '00000000000000D0', name: 'Older valve', created_at: new Date(ordered.now - 1000).toISOString()};
  ordered.devices.push(older);
  await saveRule(ordered, {threshold_kpa: 45});
  ordered.advanceTo(ordered.now + 20_000);
  assert.equal(ordered.state.triggerEvaluations[0]?.valveEui, older.deveui);
  assert.equal(outcomes(ordered)[0]?.deviceEui, older.deveui);
});

test('weekly valve ownership blocks the same-time automatic start; repeat evaluation does not duplicate it', async () => {
  const sim = new Simulator({mode: 'public'});
  sim.request('POST', `/api/valves/${VALVE_EUI}/schedules`, {kind: 'WEEKLY', weekdays_mask: 64,
    start_time: '06:00', duration_minutes: 15, label: 'At the trigger'});
  await saveRule(sim, {threshold_kpa: 45});
  sim.advanceTo(sim.now + 20_000);
  assert.equal(sim.state.triggerEvaluations[0]?.reason, 'busy');
  assert.equal(outcomes(sim).filter(row => row.deviceEui === VALVE_EUI).length, 1);
  sim.onDailyTrigger?.(sim.now);
  assert.equal(sim.state.triggerEvaluations[0]?.reason, 'busy');
  assert.equal(outcomes(sim).filter(row => row.deviceEui === VALVE_EUI).length, 1);
});
