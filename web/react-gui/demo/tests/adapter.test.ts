import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isAxiosError, type InternalAxiosRequestConfig} from 'axios';
import {api, systemAPI, ValvePlanConflictError, valvesAPI} from '../../src/services/api';
import {createDemoAdapter} from '../adapter';
import {Simulator, VALVE_EUI} from '../model';

async function install(sim: Simulator) {
  const {createDemoAdapter} = await import('../adapter');
  api.defaults.adapter = createDemoAdapter(sim);
}

test('requestResponse retains status, headers, and data while request remains data-only', () => {
  const sim = new Simulator({mode: 'public'}) as Simulator & {requestResponse?: (method: string, path: string, body?: unknown) => unknown};
  assert.equal(typeof sim.requestResponse, 'function', 'Simulator.requestResponse is missing');
  const reply = sim.requestResponse!('GET', '/api/system/settings') as {status: number; headers: Record<string, string>; data: unknown};
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['content-type'], 'application/json');
  assert.deepEqual(reply.data, sim.request('GET', '/api/system/settings'));
});

test('legacy data-only request keeps accepting JSON-string bodies explicitly', () => {
  const sim = new Simulator({mode: 'public'});
  const settings = sim.request('PUT', '/api/system/settings', '{"gatewayTimezone":"Europe/Zurich"}') as {gatewayTimezone: string};
  assert.equal(settings.gatewayTimezone, 'Europe/Zurich');
});

test('the installed demo adapter preserves structured validation errors for the real valve client', async () => {
  const sim = new Simulator({mode: 'public'});
  await install(sim);
  const first = await valvesAPI.createSchedule(VALVE_EUI, {kind: 'WEEKLY', label: 'First', weekdaysMask: 1, startTime: '06:00', durationMinutes: 15, enabled: true});
  const second = await valvesAPI.createSchedule(VALVE_EUI, {kind: 'WEEKLY', label: 'Second', weekdaysMask: 1, startTime: '06:30', durationMinutes: 15, enabled: true});
  await assert.rejects(api.put(`/api/valves/${VALVE_EUI}/schedules/${second.schedule.scheduleUuid}`, {start_time: '06:10'}), (error: unknown) => {
    assert.ok(isAxiosError(error));
    assert.equal(error.response?.status, 422);
    assert.equal(error.response?.data?.error, 'plan_conflict');
    assert.ok(Array.isArray(error.response?.data?.details));
    return true;
  });
  await assert.rejects(valvesAPI.updateSchedule(VALVE_EUI, second.schedule.scheduleUuid, {startTime: '06:10'}), error => {
    assert.ok(error instanceof ValvePlanConflictError);
    assert.equal(error.details[0]?.code, 'overlap');
    return true;
  });
  assert.equal((await valvesAPI.schedules(VALVE_EUI)).schedules.find(row => row.scheduleUuid === second.schedule.scheduleUuid)?.startTime, '06:30');
  assert.ok(first.schedule.scheduleUuid);
});

test('real valve writes retain their source creation and accepted wire statuses', async () => {
  const sim = new Simulator({mode: 'public'});
  const seen: Array<{path: string; status: number}> = [];
  api.defaults.adapter = createDemoAdapter(sim, undefined, (_method, path, wire) => seen.push({path, status: wire.status}));
  await valvesAPI.createSchedule(VALVE_EUI, {kind: 'WEEKLY', label: 'Wire status', weekdaysMask: 1, startTime: '06:00', durationMinutes: 15, enabled: true});
  await valvesAPI.resendPlan(VALVE_EUI);
  await valvesAPI.setSchedulerStatus(VALVE_EUI, 'SKIP_TODAY');
  assert.equal(seen.find(row => row.path.endsWith('/schedules'))?.status, 201);
  assert.equal(seen.find(row => row.path.endsWith('/plan/resend'))?.status, 202);
  assert.equal(seen.find(row => row.path.endsWith('/scheduler-status'))?.status, 202);
});

test('the installed adapter rejects unknown routes without making a native request', async () => {
  const sim = new Simulator({mode: 'public'});
  await install(sim);
  await assert.rejects(api.get('/api/not-in-the-simulator-contract'), (error: unknown) => {
    assert.ok(isAxiosError(error));
    assert.equal(error.response?.status, 501);
    assert.equal(error.response?.data?.error, 'unsupported');
    return true;
  });
});

test('cloud-looking absolute requests fail inside the adapter before any native transport', async () => {
  let requests = 0;
  const sim = {requestResponse: () => {requests += 1; return {status: 200, headers: {}, data: {}};}} as unknown as Simulator;
  await install(sim);
  await assert.rejects(api.get('https://osicloud.ch/api/auth/login'), (error: unknown) => {
    assert.ok(isAxiosError(error));
    assert.equal(error.response?.status, 403);
    assert.deepEqual(error.response?.data, {error: 'blocked'});
    return true;
  });
  assert.equal(requests, 0);
});

test('the adapter passes FormData, Blob, and ArrayBuffer request bodies through without stringification', async () => {
  const payload = new FormData();
  payload.append('capture', new Blob(['local bytes'], {type: 'text/plain'}), 'capture.txt');
  const binary = new Blob(['blob bytes'], {type: 'application/octet-stream'});
  const arrayBuffer = new Uint8Array([0, 1, 2, 255]).buffer;
  const received: unknown[] = [];
  const sim = {requestResponse: (_method: string, _path: string, body: unknown) => {
    received.push(body);
    return {status: 200, headers: {'content-type': 'application/json'}, data: {accepted: true}};
  }} as unknown as Simulator;
  await install(sim);
  const send = (data: FormData | Blob | ArrayBuffer, contentType: string) => api.defaults.adapter!({
    url: '/api/body-boundary-fixture', method: 'post', data, headers: {'Content-Type': contentType},
  } as unknown as InternalAxiosRequestConfig);
  await send(payload, 'multipart/form-data');
  await send(binary, 'application/octet-stream');
  await send(arrayBuffer, 'application/octet-stream');
  assert.deepEqual(received, [payload, binary, arrayBuffer]);
});

test('responseType blob contains the exact response bytes and content type', async () => {
  const sim = {requestResponse: () => ({status: 200, headers: {'content-type': 'text/csv', 'content-disposition': 'attachment; filename="samples.csv"'}, data: 'at,value\n2026-10-10,0\n'})} as unknown as Simulator;
  await install(sim);
  const response = await api.get<Blob>('/api/binary-boundary-fixture', {responseType: 'blob'});
  assert.equal(response.data.type, 'text/csv');
  assert.equal(response.headers['content-disposition'], 'attachment; filename="samples.csv"');
  assert.equal(await response.data.text(), 'at,value\n2026-10-10,0\n');
});

test('responseType arraybuffer preserves non-UTF8 blob bytes from the real adapter', async () => {
  const bytes = new Uint8Array([0, 128, 255, 1]);
  const sim = {requestResponse: () => ({status: 200, headers: {'content-type': 'application/octet-stream'}, data: new Blob([bytes])})} as unknown as Simulator;
  await install(sim);
  const response = await api.get<ArrayBuffer>('/api/binary-boundary-fixture', {responseType: 'arraybuffer'});
  assert.deepEqual([...new Uint8Array(response.data)], [...bytes]);
});

test('responseType error bodies preserve requested text and arraybuffer forms', async () => {
  const sim = {requestResponse: () => ({status: 422, headers: {'content-type': 'application/json'}, data: {error: 'invalid', count: 7}})} as unknown as Simulator;
  await install(sim);
  await assert.rejects(api.get('/api/error-boundary-fixture', {responseType: 'text'}), (error: unknown) => {
    assert.ok(isAxiosError(error));
    assert.equal(error.response?.data, '{"error":"invalid","count":7}');
    return true;
  });
  await assert.rejects(api.get('/api/error-boundary-fixture', {responseType: 'arraybuffer'}), (error: unknown) => {
    assert.ok(isAxiosError(error));
    assert.ok(error.response?.data instanceof ArrayBuffer);
    assert.equal(new TextDecoder().decode(error.response.data as ArrayBuffer), '{"error":"invalid","count":7}');
    return true;
  });
});

test('text/plain JSON-looking text cannot mutate a system setting through the real simulator adapter', async () => {
  const sim = new Simulator({mode: 'public'});
  await install(sim);
  const before = (await systemAPI.getStats()).fan_value;
  await assert.rejects(api.post('/api/system/fan', '{"speed":55}', {headers: {'Content-Type': 'text/plain'}}), (error: unknown) => {
    assert.ok(isAxiosError(error));
    assert.equal(error.response?.status, 415);
    assert.deepEqual(error.response?.data, {error: 'unsupported_body'});
    return true;
  });
  assert.equal((await systemAPI.getStats()).fan_value, before);
});

test('blob error responses retain their structured wire body bytes and status', async () => {
  await install(new Simulator({mode: 'public'}));
  let caught: unknown;
  try { await api.get('/api/not-in-the-simulator-contract', {responseType: 'blob'}); }
  catch (error) { caught = error; }
  assert.ok(isAxiosError(caught));
  assert.equal(caught.response?.status, 501);
  assert.ok(caught.response?.data instanceof Blob);
  assert.equal((caught.response.data as Blob).type, 'application/json');
  assert.deepEqual(JSON.parse(await (caught.response.data as Blob).text()), {error: 'unsupported'});
});
