// #378: cached data of one authenticated session must never reach the next
// one in the same tab. These cases render the application's real provider
// composition (AppProviders) with real SWR, the real api instance and its
// interceptors; only the network adapter is synthetic.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import useSWR from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../AppProviders';
import { useDraftsQueue, useRefreshDraftsQueue } from '../../journal/useDraftsQueue';
import { useJournalPlots } from '../../journal/useJournalPlots';
import { Login } from '../../pages/Login';
import { journalApi } from '../../services/journalApi';
import { useAuth } from '../AuthContext';
import {
  PrivateArea,
  accountOf,
  createAuthHandle,
  installFakeNetwork,
  loginAs,
  logout,
  ok,
  resetSession,
  restoreNetwork,
  type FakeNetwork,
} from './sessionHarness';

vi.mock('../../components/LanguageSwitcher', () => ({
  LanguageSwitcher: () => null,
}));

const ENTRIES = '/api/journal/entries';
const PLOTS = '/api/journal/plots';

function draftsFor(account: string) {
  return ok({ entries: [{ entry_uuid: `${account}-private-draft`, status: 'draft' }], next_cursor: null });
}

function DraftsView() {
  const { drafts, status } = useDraftsQueue(true);
  return <p data-testid="drafts">{`${status}:${drafts.map((draft) => draft.entry_uuid).join(',')}`}</p>;
}

const draftsText = () => screen.getByTestId('drafts').textContent ?? '';
const whoText = () => screen.getByTestId('who').textContent ?? '';

let network: FakeNetwork;
let authHandle: ReturnType<typeof createAuthHandle>;

function renderApp(children: ReactNode) {
  const { AuthCapture } = authHandle;
  return render(
    <AppProviders>
      <AuthCapture />
      <PrivateArea>{children}</PrivateArea>
    </AppProviders>,
  );
}

beforeEach(() => {
  resetSession();
  network = installFakeNetwork();
  authHandle = createAuthHandle();
});

afterEach(() => {
  restoreNetwork();
  localStorage.clear();
});

describe('session data boundary (#378)', () => {
  it('does not render the previous account\'s drafts while the next account\'s request is stalled', async () => {
    network.on('GET', ENTRIES, (request) => (accountOf(request) === 'alice' ? draftsFor('alice') : 'defer'));
    renderApp(<DraftsView />);
    const { auth } = authHandle;

    await loginAs(auth, 'alice');
    await waitFor(() => expect(draftsText()).toBe('ready:alice-private-draft'));

    logout(auth);
    await loginAs(auth, 'bob');

    expect(whoText()).toBe('bob');
    expect(draftsText()).not.toContain('alice');
    await waitFor(() =>
      expect(network.to('GET', ENTRIES).some((request) => accountOf(request) === 'bob')).toBe(true));
    expect(draftsText()).toBe('loading:');
  });

  it('shows an error, not the previous account\'s data, when the next account\'s request fails', async () => {
    network.on('GET', ENTRIES, (request) =>
      (accountOf(request) === 'alice' ? draftsFor('alice') : { status: 500, data: {} }));
    renderApp(<DraftsView />);
    const { auth } = authHandle;

    await loginAs(auth, 'alice');
    await waitFor(() => expect(draftsText()).toBe('ready:alice-private-draft'));

    logout(auth);
    await loginAs(auth, 'bob');

    await waitFor(() => expect(draftsText()).toBe('error:'));
  });

  it('discards a response for the previous account that resolves after the next login', async () => {
    // A transport that cannot cancel: Alice's response still arrives.
    network.honourAbort = false;
    network.on('GET', ENTRIES, (request) => (accountOf(request) === 'bob' ? draftsFor('bob') : 'defer'));
    renderApp(<DraftsView />);
    const { auth } = authHandle;

    await loginAs(auth, 'alice');
    await waitFor(() => expect(network.to('GET', ENTRIES)).toHaveLength(1));
    const aliceRequest = network.to('GET', ENTRIES)[0];

    logout(auth);
    await loginAs(auth, 'bob');
    await waitFor(() => expect(draftsText()).toBe('ready:bob-private-draft'));

    await act(async () => {
      aliceRequest.respond({ entries: [{ entry_uuid: 'alice-private-draft', status: 'draft' }], next_cursor: null });
    });

    expect(draftsText()).toBe('ready:bob-private-draft');
  });

  it('does not serve the previous account\'s cache to a hook that never revalidates', async () => {
    network.on('GET', PLOTS, (request) =>
      ok({ plots: [{ plot_uuid: `${accountOf(request)}-plot`, name: `${accountOf(request)} private farm` }] }));

    function LoadPlots() {
      const { plots } = useJournalPlots(true);
      return <p data-testid="plots">{plots.map((plot) => plot.name).join(',')}</p>;
    }
    function CachedPlotsOnly() {
      const { data } = useSWR('journal:plots', () => journalApi.listPlots(), {
        revalidateOnMount: false,
        revalidateIfStale: false,
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
      });
      return <p data-testid="plots">{data ? data.map((plot) => plot.name).join(',') : 'no-data'}</p>;
    }
    function ByAccount() {
      const { username } = useAuth();
      return username === 'alice' ? <LoadPlots /> : <CachedPlotsOnly />;
    }

    renderApp(<ByAccount />);
    const { auth } = authHandle;
    await loginAs(auth, 'alice');
    await waitFor(() => expect(screen.getByTestId('plots').textContent).toBe('alice private farm'));

    logout(auth);
    await loginAs(auth, 'bob');

    expect(screen.getByTestId('plots').textContent).toBe('no-data');
  });

  it('starts an interactive re-login of the same account with an empty cache', async () => {
    let served = 0;
    network.on('GET', ENTRIES, () => {
      served += 1;
      return served === 1 ? draftsFor('alice') : 'defer';
    });
    renderApp(<DraftsView />);
    const { auth } = authHandle;

    await loginAs(auth, 'alice');
    await waitFor(() => expect(draftsText()).toBe('ready:alice-private-draft'));

    logout(auth);
    await loginAs(auth, 'alice');

    expect(draftsText()).toBe('loading:');
  });

  it('lets a drafts-queue refresh reach only the cache of the session that created it', async () => {
    network.on('GET', ENTRIES, (request) => draftsFor(accountOf(request) ?? 'nobody'));
    const refreshers: Record<string, () => Promise<unknown>> = {};
    function RefreshHandle() {
      const { username } = useAuth();
      const refresh = useRefreshDraftsQueue();
      if (username) refreshers[username] = refresh;
      return null;
    }

    renderApp(
      <>
        <DraftsView />
        <RefreshHandle />
      </>,
    );
    const { auth } = authHandle;

    await loginAs(auth, 'alice');
    await waitFor(() => expect(draftsText()).toBe('ready:alice-private-draft'));
    logout(auth);
    await loginAs(auth, 'bob');
    await waitFor(() => expect(draftsText()).toBe('ready:bob-private-draft'));

    const bobRequestsBefore = network.to('GET', ENTRIES).length;
    await act(async () => {
      await refreshers.alice();
    });
    expect(network.to('GET', ENTRIES)).toHaveLength(bobRequestsBefore);
    expect(draftsText()).toBe('ready:bob-private-draft');

    await act(async () => {
      await refreshers.bob();
    });
    expect(network.to('GET', ENTRIES)).toHaveLength(bobRequestsBefore + 1);
    expect(accountOf(network.to('GET', ENTRIES)[bobRequestsBefore])).toBe('bob');
  });

  it('advances the session epoch when the current session receives a 401', async () => {
    renderApp(<DraftsView />);
    const { auth } = authHandle;

    await loginAs(auth, 'alice');
    const epochBefore = auth().sessionEpoch;
    expect(typeof epochBefore).toBe('number');
    await waitFor(() => expect(network.to('GET', ENTRIES)).toHaveLength(1));

    await act(async () => {
      network.to('GET', ENTRIES)[0].fail(401);
    });

    await waitFor(() => expect(whoText()).toBe('signed-out'));
    expect(auth().sessionEpoch).toBeGreaterThan(epochBefore);
    expect(localStorage.getItem('auth_token')).toBeNull();
  });

  it('lands on the dashboard after signing in from the login page', async () => {
    // The real login page through the boundary: signing in replaces the
    // page's own subtree, and the navigation it starts must still apply.
    window.location.hash = '#/login';
    const { AuthCapture } = authHandle;
    const { container } = render(
      <AppProviders>
        <AuthCapture />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/dashboard" element={<PrivateArea><p data-testid="page">dashboard</p></PrivateArea>} />
        </Routes>
      </AppProviders>,
    );

    fireEvent.change(container.querySelector('#username')!, { target: { value: 'alice' } });
    fireEvent.change(container.querySelector('#password')!, { target: { value: 'synthetic-password' } });
    await act(async () => {
      fireEvent.submit(container.querySelector('form')!);
    });

    await waitFor(() => expect(screen.getByTestId('page').textContent).toBe('dashboard'));
    expect(whoText()).toBe('alice');
    expect(window.location.hash).toBe('#/dashboard');
  });

  it('keeps the cache and the epoch across navigation within one session', async () => {
    network.on('GET', ENTRIES, () => draftsFor('alice'));
    let showDrafts: (visible: boolean) => void = () => {};
    function Navigator() {
      const [visible, setVisible] = useState(true);
      showDrafts = setVisible;
      return visible ? <DraftsView /> : <p data-testid="drafts">elsewhere</p>;
    }

    renderApp(<Navigator />);
    const { auth } = authHandle;
    await loginAs(auth, 'alice');
    await waitFor(() => expect(draftsText()).toBe('ready:alice-private-draft'));
    const epoch = auth().sessionEpoch;
    expect(typeof epoch).toBe('number');
    expect(network.to('GET', ENTRIES)).toHaveLength(1);

    act(() => showDrafts(false));
    expect(draftsText()).toBe('elsewhere');
    act(() => showDrafts(true));

    expect(draftsText()).toBe('ready:alice-private-draft');
    expect(auth().sessionEpoch).toBe(epoch);
    expect(network.to('GET', ENTRIES)).toHaveLength(1);
  });
});
