import assert from 'node:assert/strict';
import {test} from 'node:test';
import {AxiosError} from 'axios';
import {api, supportRequestsAPI} from '../../src/services/api';
import type {SupportRequestCreateRequest} from '../../src/types/farming';
import {createDemoAdapter} from '../adapter';
import {Simulator} from '../model';

function install(sim: Simulator) { api.defaults.adapter = createDemoAdapter(sim); }

const request: SupportRequestCreateRequest = {
  type: 'bug', title: 'Demo support request', contact_email: null,
  description: 'A specific local simulator behavior to report.', expected: 'An honest response', actual: 'No response',
  steps: 'Open the settings screen', area: 'system', severity: 'workaround', consent_public: true,
  consent_diagnostics: false, route: '/settings', current_route: '/settings',
};

test('support submission keeps its exact text and consent in a local inbox receipt', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  const wire = sim.requestResponse('POST', '/api/improvement-requests', request);
  assert.equal(wire.status, 201);
  assert.equal((wire.data as {local_status: string}).local_status, 'QUEUED');
  assert.equal(sim.state.system.supportInbox.length, 1);
  const receipt = await supportRequestsAPI.create(request);
  assert.equal(receipt.local_status, 'QUEUED');
  assert.match(receipt.request_id, /^demo-support-/);
  assert.match(receipt.status_secret, /^demo-only-/);
  const row = sim.state.system.supportInbox[0]!;
  assert.equal(row.description, request.description);
  assert.equal(row.expected, request.expected);
  assert.equal(row.actual, request.actual);
  assert.equal(row.steps, request.steps);
  assert.equal(row.consent_diagnostics, false);
  assert.equal(row.cloud_status, null);
  const saved = (await supportRequestsAPI.list()).find(item => item.request_id === receipt.request_id);
  assert.equal(saved?.description_preview, request.description);
  assert.equal(saved?.title, request.title);
});

test('support diagnostics preview contains fictional current route and gateway context', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  const preview = await supportRequestsAPI.diagnosticsPreview('/settings');
  assert.equal(preview.generated_at, new Date(sim.now).toISOString());
  assert.equal(preview.diagnostics?.demo_mode, true);
  assert.equal(preview.diagnostics?.route, '/settings');
  assert.equal(preview.diagnostics?.gateway_timezone, 'Africa/Kampala');
  assert.equal(preview.diagnostics?.zone_count, 2);
});

test('invalid support requests return a validation error without adding to the inbox', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  await assert.rejects(supportRequestsAPI.create({...request, consent_public: false as true}), error => {
    assert.ok(error instanceof AxiosError);
    assert.equal(error.response?.status, 400);
    assert.deepEqual(error.response?.data, {error: 'consent_public must be true'});
    return true;
  });
  assert.equal(sim.state.system.supportInbox.length, 0);
});

test('support title limits and contact email validation preserve the source 400 wire response', async () => {
  const sim = new Simulator({mode: 'public'});
  install(sim);
  await assert.rejects(supportRequestsAPI.create({...request, title: 'x'.repeat(81)}), error => {
    assert.ok(error instanceof AxiosError);
    assert.equal(error.response?.status, 400);
    assert.deepEqual(error.response?.data, {error: 'Title must be 3-80 characters'});
    return true;
  });
  await assert.rejects(supportRequestsAPI.create({...request, contact_email: 'not-an-email'}), error => {
    assert.ok(error instanceof AxiosError);
    assert.equal(error.response?.status, 400);
    assert.deepEqual(error.response?.data, {error: 'Invalid contact_email'});
    return true;
  });
  assert.equal(sim.state.system.supportInbox.length, 0);
});
