// #378: the edge has no immutable principal in its token contract yet (U02),
// so every change of the stored token, a logout in another tab and
// storage.clear() must start a new session epoch. Login operations are
// fenced so a late response cannot replace a newer login or a logout.
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProviders } from '../../AppProviders';
import { useDraftsQueue } from '../../journal/useDraftsQueue';
import { authAPI } from '../../services/api';
import type { LoginResponse } from '../../types/farming';
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
  writeFromOtherTab,
  type FakeNetwork,
  type FakeRequest,
} from './sessionHarness';

const ENTRIES = '/api/journal/entries';

function DraftsView() {
  const { drafts, status } = useDraftsQueue(true);
  return <p data-testid="drafts">{`${status}:${drafts.map((draft) => draft.entry_uuid).join(',')}`}</p>;
}

const draftsText = () => screen.getByTestId('drafts').textContent ?? '';
const whoText = () => screen.getByTestId('who').textContent ?? '';

let network: FakeNetwork;
let authHandle: ReturnType<typeof createAuthHandle>;

function renderApp() {
  const { AuthCapture } = authHandle;
  return render(
    <AppProviders>
      <AuthCapture />
      <PrivateArea>
        <DraftsView />
      </PrivateArea>
    </AppProviders>,
  );
}

async function signInAliceWithDrafts() {
  const { auth } = authHandle;
  await loginAs(auth, 'alice');
  await waitFor(() => expect(draftsText()).toBe('ready:alice-private-draft'));
  return auth().sessionEpoch;
}

beforeEach(() => {
  resetSession();
  network = installFakeNetwork();
  network.on('GET', ENTRIES, (request) =>
    (accountOf(request) === 'alice'
      ? ok({ entries: [{ entry_uuid: 'alice-private-draft', status: 'draft' }], next_cursor: null })
      : 'defer'));
  authHandle = createAuthHandle();
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreNetwork();
  localStorage.clear();
});

describe('cross-tab session changes (#378)', () => {
  it('starts a new epoch when another tab stores a different account\'s token, even an opaque one', async () => {
    renderApp();
    const epoch = await signInAliceWithDrafts();

    act(() => writeFromOtherTab('%%opaque-token-from-other-tab%%', 'bob'));

    const { auth } = authHandle;
    expect(auth().token).toBe('%%opaque-token-from-other-tab%%');
    expect(auth().username).toBe('bob');
    expect(auth().sessionEpoch).toBeGreaterThan(epoch);
    expect(whoText()).toBe('bob');
    expect(draftsText()).not.toContain('alice');
  });

  it('starts a new epoch when the same account\'s token changes in another tab', async () => {
    renderApp();
    const epoch = await signInAliceWithDrafts();

    act(() => writeFromOtherTab('token-alice-999', 'alice'));

    const { auth } = authHandle;
    expect(auth().token).toBe('token-alice-999');
    expect(auth().sessionEpoch).toBeGreaterThan(epoch);
    expect(draftsText()).not.toBe('ready:alice-private-draft');
  });

  it('ends the session when another tab logs out or clears storage', async () => {
    renderApp();
    const epoch = await signInAliceWithDrafts();

    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage }));
    });

    const { auth } = authHandle;
    expect(auth().isAuthenticated).toBe(false);
    expect(auth().sessionEpoch).toBeGreaterThan(epoch);
    expect(whoText()).toBe('signed-out');
  });

  it('keeps the session and its cache when an unrelated key changes in another tab', async () => {
    renderApp();
    const epoch = await signInAliceWithDrafts();

    act(() => {
      localStorage.setItem('osi.display.theme', 'dark');
      window.dispatchEvent(new StorageEvent('storage', {
        key: 'osi.display.theme', newValue: 'dark', storageArea: localStorage,
      }));
    });

    expect(authHandle.auth().sessionEpoch).toBe(epoch);
    expect(draftsText()).toBe('ready:alice-private-draft');
  });

  it('advances the epoch on every logout and every interactive login', async () => {
    renderApp();
    const { auth } = authHandle;
    const first = await signInAliceWithDrafts();

    logout(auth);
    const afterLogout = auth().sessionEpoch;
    expect(afterLogout).toBeGreaterThan(first);

    await loginAs(auth, 'alice');
    expect(auth().sessionEpoch).toBeGreaterThan(afterLogout);
  });

  it('commits only the latest of overlapping logins', async () => {
    const logins: FakeRequest[] = [];
    network.on('POST', '/auth/login', (request) => {
      logins.push(request);
      return 'defer';
    });
    renderApp();
    const { auth } = authHandle;

    let aliceResult: Promise<void> = Promise.resolve();
    let bobResult: Promise<void> = Promise.resolve();
    act(() => {
      aliceResult = auth().login({ username: 'alice', password: 'synthetic-password' });
      bobResult = auth().login({ username: 'bob', password: 'synthetic-password' });
    });
    const aliceOutcome = aliceResult.then(() => 'committed', () => 'rejected');
    await waitFor(() => expect(logins).toHaveLength(2));

    await act(async () => {
      logins[1].respond({ token: 'token-bob-2' });
      await bobResult;
    });
    await act(async () => {
      logins[0].respond({ token: 'token-alice-1' });
      await aliceOutcome;
    });

    expect(await aliceOutcome).toBe('rejected');
    expect(auth().username).toBe('bob');
    expect(auth().token).toBe('token-bob-2');
    expect(localStorage.getItem('auth_token')).toBe('token-bob-2');
    expect(localStorage.getItem('username')).toBe('bob');
  });

  it('does not resurrect a session when logout happens while login is pending', async () => {
    const logins: FakeRequest[] = [];
    network.on('POST', '/auth/login', (request) => {
      logins.push(request);
      return 'defer';
    });
    renderApp();
    const { auth } = authHandle;

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = auth().login({ username: 'alice', password: 'synthetic-password' });
    });
    const outcome = pending.then(() => 'committed', () => 'rejected');
    await waitFor(() => expect(logins).toHaveLength(1));

    logout(auth);
    await act(async () => {
      logins[0].respond({ token: 'token-alice-1' });
      await outcome;
    });

    expect(await outcome).toBe('rejected');
    expect(auth().isAuthenticated).toBe(false);
    expect(localStorage.getItem('auth_token')).toBeNull();
    expect(whoText()).toBe('signed-out');
  });

  // The two cases above go through axios, whose per-epoch abort already
  // cancels the losing request. These resolve outside axios, so only the
  // login operation generation can stop the late response from committing.
  describe('login operation generation, without the transport abort', () => {
    function deferredLogins() {
      const pending: Array<(response: LoginResponse) => void> = [];
      vi.spyOn(authAPI, 'login').mockImplementation(() => new Promise<LoginResponse>((resolve) => {
        pending.push(resolve);
      }));
      return pending;
    }

    it('lets only the latest of overlapping logins commit', async () => {
      const pending = deferredLogins();
      renderApp();
      const { auth } = authHandle;

      let aliceResult: Promise<void> = Promise.resolve();
      let bobResult: Promise<void> = Promise.resolve();
      act(() => {
        aliceResult = auth().login({ username: 'alice', password: 'synthetic-password' });
        bobResult = auth().login({ username: 'bob', password: 'synthetic-password' });
      });
      const aliceOutcome = aliceResult.then(() => 'committed', (error: Error) => error.name);

      await act(async () => {
        pending[1]({ token: 'token-bob-2' } as LoginResponse);
        await bobResult;
      });
      await act(async () => {
        pending[0]({ token: 'token-alice-1' } as LoginResponse);
        await aliceOutcome;
      });

      expect(await aliceOutcome).toBe('AuthOperationSupersededError');
      expect(auth().username).toBe('bob');
      expect(localStorage.getItem('auth_token')).toBe('token-bob-2');
    });

    it('keeps a logout made while login is pending', async () => {
      const pending = deferredLogins();
      renderApp();
      const { auth } = authHandle;

      let result: Promise<void> = Promise.resolve();
      act(() => {
        result = auth().login({ username: 'alice', password: 'synthetic-password' });
      });
      const outcome = result.then(() => 'committed', (error: Error) => error.name);
      logout(auth);
      await act(async () => {
        pending[0]({ token: 'token-alice-1' } as LoginResponse);
        await outcome;
      });

      expect(await outcome).toBe('AuthOperationSupersededError');
      expect(auth().isAuthenticated).toBe(false);
      expect(localStorage.getItem('auth_token')).toBeNull();
    });
  });
});
