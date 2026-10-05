// #378: the simulator used SWR's process-global `mutate` to push simulated
// device changes into the app. Behind the session boundary that call would
// miss the app's cache, so the simulator now asks the mounted hooks to
// revalidate through the current session's own cache.
import { act, render, screen, waitFor } from '@testing-library/react';
import useSWR from 'swr';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { demoRevalidation, requestDemoRevalidation } from '../../../demo/revalidation';
import { AppProviders } from '../../AppProviders';
import { api } from '../../services/api';
import {
  PrivateArea,
  accountOf,
  createAuthHandle,
  installFakeNetwork,
  loginAs,
  ok,
  resetSession,
  restoreNetwork,
  type FakeNetwork,
} from './sessionHarness';

const DEVICES = '/api/devices';
const DEMO_SWR_CONFIG = { use: [demoRevalidation] };

function DevicesView() {
  const { data } = useSWR<{ revision: number }>(DEVICES, async () => (await api.get(DEVICES)).data);
  return <p data-testid="devices">{data ? `revision-${data.revision}` : 'loading'}</p>;
}

function ValvesCount() {
  // A second hook on the same cache: one request must still cause one refetch.
  useSWR(DEVICES, async () => (await api.get(DEVICES)).data);
  return null;
}

let network: FakeNetwork;
let authHandle: ReturnType<typeof createAuthHandle>;

beforeEach(() => {
  resetSession();
  network = installFakeNetwork();
  let revision = 0;
  network.on('GET', DEVICES, (request) => {
    revision += 1;
    return ok({ revision, account: accountOf(request) });
  });
  authHandle = createAuthHandle();
});

afterEach(() => {
  restoreNetwork();
  localStorage.clear();
});

describe('simulator revalidation through the session cache (#378)', () => {
  it('refetches each listed key once in the current session cache', async () => {
    const { AuthCapture } = authHandle;
    render(
      <SWRConfig value={DEMO_SWR_CONFIG}>
        <AppProviders>
          <AuthCapture />
          <PrivateArea>
            <DevicesView />
            <ValvesCount />
          </PrivateArea>
        </AppProviders>
      </SWRConfig>,
    );
    await loginAs(authHandle.auth, 'alice');
    await waitFor(() => expect(screen.getByTestId('devices').textContent).toBe('revision-1'));
    expect(network.to('GET', DEVICES)).toHaveLength(1);

    await act(async () => {
      requestDemoRevalidation([DEVICES, '/api/valves']);
    });

    await waitFor(() => expect(screen.getByTestId('devices').textContent).toBe('revision-2'));
    expect(network.to('GET', DEVICES)).toHaveLength(2);
  });
});
