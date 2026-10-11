// #378: the simulator used SWR's process-global `mutate` to push simulated
// device changes into the app. Behind the session boundary that call would
// miss the app's cache, so the simulator now asks the mounted hooks to
// revalidate through the current session's own cache.
import { act, render, screen, waitFor } from '@testing-library/react';
import useSWR from 'swr';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { analysisAPI, api } from '../../services/api';
import type { AnalysisSeriesRequest } from '../../analysis/types';
import { createDemoAdapter } from '../../../demo/adapter';
import { demoRevalidation, requestDemoRevalidation, shouldRevalidateDemoResponse } from '../../../demo/revalidation';
import { Simulator } from '../../../demo/model';
import { AppProviders } from '../../AppProviders';
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

function AnalysisSeriesView({request}: {request: AnalysisSeriesRequest}) {
  const {data, error} = useSWR('analysis-series-revalidation-test', () => analysisAPI.getSeries(request));
  return <p data-testid="analysis-series">{error ? 'error' : data ? `series-${data.series.length}` : 'loading'}</p>;
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
  it('classifies only successful mutations for cache revalidation', () => {
    expect(shouldRevalidateDemoResponse('POST', '/api/analysis/series', 200)).toBe(false);
    expect(shouldRevalidateDemoResponse('POST', '/api/analysis/series?range=24h', 200)).toBe(false);
    expect(shouldRevalidateDemoResponse('POST', '/api/analysis/views', 201)).toBe(true);
    expect(shouldRevalidateDemoResponse('PUT', '/api/devices/00000000000000E3/dendro-config', 400)).toBe(false);
    expect(shouldRevalidateDemoResponse('GET', '/api/devices', 200)).toBe(false);
  });

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

  it('does not recursively invalidate a mounted analysis read when a real write revalidates it', async () => {
    const simulator = new Simulator({mode: 'public'});
    let analysisReads = 0;
    api.defaults.adapter = createDemoAdapter(simulator, undefined, (method, path, wire) => {
      if (path.split('?')[0] === '/api/analysis/series') {
        analysisReads += 1;
        // Bound the current recursion so the RED gives a count assertion rather
        // than hanging the test process. The production callback is unbounded.
        if (analysisReads > 2) return;
      }
      if (shouldRevalidateDemoResponse(method, path, wire.status)) requestDemoRevalidation(['*']);
    });
    const catalog = await analysisAPI.getChannels();
    const channel = catalog.channels.find(row => row.deviceName === 'Tomato soil probe' && row.channelKey === 'swt_1')!;
    const request: AnalysisSeriesRequest = {
      selectors: [{seriesId: channel.seriesId}],
      range: {mode: 'relative', label: '24h', from: null, to: null},
      aggregation: 'raw',
    };

    render(
      <SWRConfig value={DEMO_SWR_CONFIG}>
        <AnalysisSeriesView request={request} />
      </SWRConfig>,
    );
    await waitFor(() => expect(screen.getByTestId('analysis-series').textContent).toMatch(/^series-/));
    await act(async () => {
      await analysisAPI.saveView({name: 'Revalidation write', isDefault: false, viewJson: {
        schemaVersion: 1,
        selectors: [{seriesId: channel.seriesId}],
        range: request.range,
        mode: 'timeline',
      }});
    });
    await waitFor(() => expect(analysisReads).toBeGreaterThanOrEqual(2));

    expect(analysisReads, 'the mounted analysis read refetches once after a real successful write').toBe(2);
  });
});
