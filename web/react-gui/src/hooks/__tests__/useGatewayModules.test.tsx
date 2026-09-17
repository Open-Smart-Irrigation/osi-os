import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// useSWR is stubbed rather than driven through a real fetcher: what is under
// test here is the decision this hook makes from the three states SWR reports
// (nothing yet / a response / a failed request), and driving a rejected fetcher
// through real SWR leaves an unattached rejection inside SWR's own bookkeeping
// that the runner reports as a test error. The states below are SWR's
// documented contract, including that `data` keeps the last successful response
// when a later revalidation fails.
const { swrState } = vi.hoisted(() => ({
  swrState: { current: { data: undefined as unknown, error: undefined as unknown } },
}));

vi.mock('swr', () => ({ default: () => swrState.current }));
vi.mock('../../services/api', () => ({ systemSettingsAPI: { get: vi.fn() } }));

import { useGatewayModules } from '../useGatewayModules';

const ALL_DEFAULTS_ON = {
  dataModuleEnabled: true,
  networkModuleEnabled: true,
  gatewayHubModuleEnabled: true,
  journalModuleEnabled: true,
};

function modulesFor(state: { data?: unknown; error?: unknown }) {
  swrState.current = { data: state.data, error: state.error };
  return renderHook(() => useGatewayModules()).result.current;
}

describe('useGatewayModules', () => {
  // The point of the null state: a gateway that ships a module hidden and one
  // that ships it visible are indistinguishable until the response arrives, so
  // rendering either answer first guarantees a visible flash of the wrong one on
  // one of them. Consumers render nothing while this is null.
  it('reports unknown while the settings request is still in flight', () => {
    expect(modulesFor({})).toBeNull();
  });

  it('follows the effective values once the response arrives', () => {
    expect(modulesFor({
      data: {
        gatewayTimezone: 'UTC',
        dataModuleEnabled: false,
        networkModuleEnabled: true,
        gatewayHubModuleEnabled: true,
        journalModuleEnabled: false,
        moduleDefaults: ALL_DEFAULTS_ON,
      },
    })).toEqual({ data: false, network: true, gatewayHub: true, journal: false });
  });

  // No compiled-in copy of the defaults in the browser: a module whose switch
  // has never been written comes back absent, and the gateway says in the same
  // response what absent means for it.
  it('takes an absent value from the defaults the gateway declared', () => {
    expect(modulesFor({
      data: {
        gatewayTimezone: 'UTC',
        moduleDefaults: {
          dataModuleEnabled: false,
          networkModuleEnabled: false,
          gatewayHubModuleEnabled: false,
          journalModuleEnabled: true,
        },
      },
    })).toEqual({ data: false, network: false, gatewayHub: false, journal: true });
  });

  it('prefers a stored value over the declared default', () => {
    expect(modulesFor({
      data: {
        gatewayTimezone: 'UTC',
        journalModuleEnabled: true,
        moduleDefaults: {
          dataModuleEnabled: false,
          networkModuleEnabled: false,
          gatewayHubModuleEnabled: false,
          journalModuleEnabled: false,
        },
      },
    })).toEqual({ data: false, network: false, gatewayHub: false, journal: true });
  });

  // A gateway older than this contract answers with neither the value nor the
  // defaults. It has no hidden modules, so everything is visible.
  it('falls back to visible for a gateway that declares no defaults', () => {
    expect(modulesFor({ data: { gatewayTimezone: 'UTC' } }))
      .toEqual({ data: true, network: true, gatewayHub: true, journal: true });
  });

  // An unreachable gateway is not evidence that a module was switched off, and a
  // dashboard with no way back to Data or Journal is worse than one showing an
  // entry point that turns out to be hidden. So: visible, but only once the
  // request has actually failed -- never before.
  it('falls back to visible when the request failed and nothing was ever loaded', () => {
    expect(modulesFor({ error: new Error('network down') }))
      .toEqual({ data: true, network: true, gatewayHub: true, journal: true });
  });

  // SWR keeps the last successful response alongside the error, so a gateway
  // that goes unreachable mid-session keeps the surface it last reported instead
  // of springing hidden modules back into view.
  it('keeps the last known response when a later request fails', () => {
    expect(modulesFor({
      data: {
        gatewayTimezone: 'UTC',
        dataModuleEnabled: false,
        networkModuleEnabled: false,
        gatewayHubModuleEnabled: false,
        journalModuleEnabled: false,
        moduleDefaults: ALL_DEFAULTS_ON,
      },
      error: new Error('network down'),
    })).toEqual({ data: false, network: false, gatewayHub: false, journal: false });
  });
});
