// The gateway now answers GET /api/v1/devices/:deveui/today-liters and
// PUT /api/devices/:deveui/reference-tree only to a signed-in session, in both
// scoped-access flag states. The dashboard reaches both through the shared
// `api` client, so each request must carry the current session's token; a
// call site that bypassed the client would start failing with 401.
import { render } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProviders } from '../../AppProviders';
import {
  createAuthHandle,
  installFakeNetwork,
  loginAs,
  ok,
  resetSession,
  restoreNetwork,
  type FakeNetwork,
} from '../../contexts/__tests__/sessionHarness';
import { dendroAnalyticsAPI, valveAPI } from '../api';

const DEVEUI = 'A840410000000001';
const TODAY_LITERS = `/api/v1/devices/${DEVEUI}/today-liters`;
const REFERENCE_TREE = `/api/devices/${DEVEUI}/reference-tree`;

let network: FakeNetwork;
let authHandle: ReturnType<typeof createAuthHandle>;

beforeEach(() => {
  resetSession();
  network = installFakeNetwork();
  authHandle = createAuthHandle();
  const { AuthCapture } = authHandle;
  render(createElement(AppProviders, null, createElement(AuthCapture)));
});

afterEach(() => {
  restoreNetwork();
  localStorage.clear();
});

describe('routes that need a signed-in session', () => {
  it('sends the session token with the valve litres read', async () => {
    network.on('GET', TODAY_LITERS, () => ok({ liters: 12.5, source: 'flow_meter' }));
    await loginAs(authHandle.auth, 'alice');
    const token = authHandle.auth().token;

    const result = await valveAPI.getTodayLiters(DEVEUI);

    expect(result).toEqual({ liters: 12.5, source: 'flow_meter' });
    expect(network.to('GET', TODAY_LITERS)[0].authorization).toBe(`Bearer ${token}`);
  });

  it('sends the session token with the reference-tree switch', async () => {
    network.on('PUT', REFERENCE_TREE, () => ok({ success: true, deveui: DEVEUI, is_reference_tree: 1 }));
    await loginAs(authHandle.auth, 'alice');
    const token = authHandle.auth().token;

    await dendroAnalyticsAPI.setReferenceTree(DEVEUI, true);

    const [request] = network.to('PUT', REFERENCE_TREE);
    expect(request.authorization).toBe(`Bearer ${token}`);
    expect(request.body).toEqual({ is_reference_tree: 1 });
  });
});
