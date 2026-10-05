// #378: the api interceptors bind every request to the session it was
// created in. An explicit Authorization header is never replaced, a request
// captured under an earlier session is refused before it reaches the
// network, and a 401 ends the session only when it answers a request of the
// current session.
import { act, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProviders } from '../../AppProviders';
import {
  createAuthHandle,
  installFakeNetwork,
  loginAs,
  logout,
  ok,
  resetSession,
  restoreNetwork,
  type FakeNetwork,
} from '../../contexts/__tests__/sessionHarness';
import { AUTH_EXPIRED_EVENT } from '../authEvents';
import { api, authAPI } from '../api';
import { expireAuthSession, getAuthSession, type AuthSessionSnapshot } from '../authSession';

const PROBE = '/api/session-probe';

let network: FakeNetwork;
let authHandle: ReturnType<typeof createAuthHandle>;
let expiredEvents = 0;
const countExpired = () => {
  expiredEvents += 1;
};

function renderApp() {
  const { AuthCapture } = authHandle;
  render(createElement(AppProviders, null, createElement(AuthCapture)));
}

beforeEach(() => {
  resetSession();
  network = installFakeNetwork();
  authHandle = createAuthHandle();
  expiredEvents = 0;
  window.addEventListener(AUTH_EXPIRED_EVENT, countExpired);
});

afterEach(() => {
  window.removeEventListener(AUTH_EXPIRED_EVENT, countExpired);
  restoreNetwork();
  localStorage.clear();
});

describe('api session binding (#378)', () => {
  it('sends an ordinary request with the current session token', async () => {
    network.on('GET', PROBE, () => ok({}));
    renderApp();
    await loginAs(authHandle.auth, 'alice');
    const token = authHandle.auth().token;

    await api.get(PROBE);

    expect(network.to('GET', PROBE)[0].authorization).toBe(`Bearer ${token}`);
  });

  it('preserves an explicitly set Authorization header', async () => {
    network.on('GET', PROBE, () => ok({}));
    renderApp();
    await loginAs(authHandle.auth, 'alice');

    await api.get(PROBE, { headers: { Authorization: 'Bearer explicitly-captured' } });

    expect(network.to('GET', PROBE)[0].authorization).toBe('Bearer explicitly-captured');
  });

  it('sends a request captured under the current session with that session\'s token', async () => {
    network.on('GET', PROBE, () => ok({}));
    renderApp();
    await loginAs(authHandle.auth, 'alice');
    const snapshot = authHandle.auth().sessionSnapshot;

    await api.get(PROBE, { authSession: snapshot });

    expect(network.to('GET', PROBE)[0].authorization).toBe(`Bearer ${snapshot.token}`);
  });

  it('refuses a request captured under an earlier session before it reaches the network', async () => {
    network.on('GET', PROBE, () => ok({}));
    renderApp();
    const { auth } = authHandle;
    await loginAs(auth, 'alice');
    const aliceSnapshot = auth().sessionSnapshot;
    expect(aliceSnapshot).toBeTruthy();

    logout(auth);
    await loginAs(auth, 'bob');

    await expect(api.get(PROBE, { authSession: aliceSnapshot })).rejects.toMatchObject({
      name: 'StaleSessionRequestError',
    });
    expect(network.to('GET', PROBE)).toHaveLength(0);
  });

  it('ignores a 401 for the previous session that arrives after the next login', async () => {
    renderApp();
    const { auth } = authHandle;
    await loginAs(auth, 'alice');
    const aliceRequest = api.get(PROBE).catch((error: unknown) => error);
    await waitFor(() => expect(network.to('GET', PROBE)).toHaveLength(1));

    logout(auth);
    await loginAs(auth, 'bob');
    const bobToken = auth().token;
    const bobEpoch = auth().sessionEpoch;
    expiredEvents = 0;

    await act(async () => {
      network.to('GET', PROBE)[0].fail(401);
      await aliceRequest;
    });

    expect(auth().username).toBe('bob');
    expect(auth().token).toBe(bobToken);
    expect(auth().sessionEpoch).toBe(bobEpoch);
    expect(localStorage.getItem('auth_token')).toBe(bobToken);
    expect(localStorage.getItem('username')).toBe('bob');
    expect(expiredEvents).toBe(0);
  });

  it('cancels the ending session\'s in-flight requests on logout', async () => {
    renderApp();
    const { auth } = authHandle;
    await loginAs(auth, 'alice');
    const pending = api.get(PROBE).then(() => 'settled', (error: { code?: string }) => error.code);
    await waitFor(() => expect(network.to('GET', PROBE)).toHaveLength(1));

    logout(auth);

    expect(await pending).toBe('ERR_CANCELED');
  });

  it.each([
    ['a transport that cancels', true],
    ['a transport that cannot cancel', false],
  ])('does not send the next step of a multi-step write under the next session (%s)', async (_label, honourAbort) => {
    network.honourAbort = honourAbort;
    network.on('PUT', '/api/step-two', () => ok({}));
    renderApp();
    const { auth } = authHandle;
    await loginAs(auth, 'alice');
    const save = async () => {
      await api.put('/api/step-one', { owner: 'alice' });
      await api.put('/api/step-two', { owner: 'alice' });
    };
    const saving = save().catch(() => undefined);
    await waitFor(() => expect(network.to('PUT', '/api/step-one')).toHaveLength(1));

    logout(auth);
    await loginAs(auth, 'bob');
    await act(async () => {
      network.to('PUT', '/api/step-one')[0].respond({});
      await saving;
    });

    expect(network.to('PUT', '/api/step-two')).toHaveLength(0);
  });

  it('lets a 401 end the session only when its captured session is still current', async () => {
    renderApp();
    const { auth } = authHandle;
    await loginAs(auth, 'alice');
    const aliceSnapshot = auth().sessionSnapshot;
    logout(auth);
    await loginAs(auth, 'bob');
    const bob = getAuthSession();

    expect(expireAuthSession(aliceSnapshot)).toBe(false);
    expect(expireAuthSession({ ...bob, sessionEpoch: bob.sessionEpoch - 1 })).toBe(false);
    expect(expireAuthSession({ ...bob, token: 'token-bob-forged' })).toBe(false);
    expect(getAuthSession()).toBe(bob);
    expect(expiredEvents).toBe(0);
  });

  it('ends the current session on a 401 for one of its own requests', async () => {
    network.on('GET', PROBE, () => ({ status: 401, data: {} }));
    renderApp();
    const { auth } = authHandle;
    await loginAs(auth, 'alice');
    const epoch = auth().sessionEpoch;

    await act(async () => {
      await api.get(PROBE).catch(() => undefined);
    });

    expect(auth().isAuthenticated).toBe(false);
    expect(auth().sessionEpoch).toBeGreaterThan(epoch);
    expect(localStorage.getItem('auth_token')).toBeNull();
    expect(localStorage.getItem('username')).toBeNull();
    expect(expiredEvents).toBe(1);
  });

  it('lets a sign-in in progress finish when a late 401 ends the previous session', async () => {
    renderApp();
    const { auth } = authHandle;
    await loginAs(auth, 'alice');
    const aliceRequest = api.get(PROBE).catch(() => undefined);
    await waitFor(() => expect(network.to('GET', PROBE)).toHaveLength(1));
    const logins: Array<{ respond(data: unknown): void }> = [];
    network.on('POST', '/auth/login', (request) => {
      logins.push(request);
      return 'defer';
    });

    let bobLogin: Promise<void> = Promise.resolve();
    act(() => {
      bobLogin = auth().login({ username: 'bob', password: 'synthetic-password' });
    });
    const outcome = bobLogin.then(() => 'committed', (error: { name?: string; code?: string }) => error.code ?? error.name);
    await waitFor(() => expect(logins).toHaveLength(1));

    await act(async () => {
      network.to('GET', PROBE)[0].fail(401);
      await aliceRequest;
    });
    expect(auth().isAuthenticated).toBe(false);

    await act(async () => {
      logins[0].respond({ token: 'token-bob-5' });
      await outcome;
    });

    expect(await outcome).toBe('committed');
    expect(auth().username).toBe('bob');
    expect(auth().token).toBe('token-bob-5');
    expect(localStorage.getItem('auth_token')).toBe('token-bob-5');
  });

  it('never ends the current session on a 401 from login or register', async () => {
    network.on('POST', '/auth/register', () => ({ status: 401, data: {} }));
    renderApp();
    const { auth } = authHandle;
    await loginAs(auth, 'alice');
    const session = auth().sessionSnapshot;
    network.on('POST', '/auth/login', () => ({ status: 401, data: {} }));

    await act(async () => {
      await authAPI.login({ username: 'bob', password: 'wrong' }).catch(() => undefined);
      await authAPI.register({ username: 'bob', password: 'wrong' }).catch(() => undefined);
    });

    expect(auth().sessionSnapshot).toBe(session);
    expect(localStorage.getItem('auth_token')).toBe(session.token);
    expect(expiredEvents).toBe(0);
  });

  it('does not start a new epoch for a rejected sign-in while signed out', async () => {
    network.on('POST', '/auth/login', () => ({ status: 401, data: { message: 'invalid' } }));
    renderApp();
    const { auth } = authHandle;
    const epoch = auth().sessionEpoch;
    expect(typeof epoch).toBe('number');

    await act(async () => {
      await auth().login({ username: 'alice', password: 'wrong' }).catch(() => undefined);
    });

    expect(auth().sessionEpoch).toBe(epoch);
    expect(expiredEvents).toBe(0);
  });

  // The per-epoch abort turns any response that settles after a session
  // change into a cancellation before this handler runs, so the cases above
  // cannot tell whether the handler's own checks work. These call the
  // installed response handler directly with an already settled 401.
  describe('401 handler, without the transport abort', () => {
    type Handler = { rejected: (error: unknown) => Promise<unknown> };
    const handle401 = (config: { authSession?: AuthSessionSnapshot; skipAuthExpiry?: boolean }) => {
      const handlers = (api.interceptors.response as unknown as { handlers: Array<Handler | null> }).handlers;
      const handler = handlers.find((candidate): candidate is Handler => Boolean(candidate?.rejected));
      return act(async () => {
        await handler!.rejected({ response: { status: 401 }, config }).catch(() => undefined);
      });
    };

    it('ignores a 401 captured under the previous session', async () => {
      renderApp();
      const { auth } = authHandle;
      await loginAs(auth, 'alice');
      const alice = auth().sessionSnapshot;
      logout(auth);
      await loginAs(auth, 'bob');
      const bob = auth().sessionSnapshot;

      await handle401({ authSession: alice });

      expect(auth().sessionSnapshot).toBe(bob);
      expect(localStorage.getItem('auth_token')).toBe(bob.token);
      expect(expiredEvents).toBe(0);
    });

    it('ignores a 401 for a request sent without a token', async () => {
      renderApp();
      const { auth } = authHandle;
      const anonymous = auth().sessionSnapshot;

      await handle401({ authSession: anonymous });

      expect(auth().sessionSnapshot).toBe(anonymous);
      expect(expiredEvents).toBe(0);
    });

    it('ignores a 401 from a credential request of the current session', async () => {
      renderApp();
      const { auth } = authHandle;
      await loginAs(auth, 'alice');
      const alice = auth().sessionSnapshot;

      await handle401({ authSession: alice, skipAuthExpiry: true });

      expect(auth().sessionSnapshot).toBe(alice);
      expect(expiredEvents).toBe(0);
    });

    it('ends the session for a 401 captured under the current session', async () => {
      renderApp();
      const { auth } = authHandle;
      await loginAs(auth, 'alice');
      const alice = auth().sessionSnapshot;

      await handle401({ authSession: alice });

      expect(auth().isAuthenticated).toBe(false);
      expect(auth().sessionEpoch).toBeGreaterThan(alice.sessionEpoch);
      expect(expiredEvents).toBe(1);
    });
  });

  it('sends login and register without the current session\'s token', async () => {
    network.on('POST', '/auth/register', () => ok({}));
    renderApp();
    const { auth } = authHandle;
    await loginAs(auth, 'alice');

    await act(async () => {
      await authAPI.login({ username: 'bob', password: 'synthetic-password' });
      await authAPI.register({ username: 'carol', password: 'synthetic-password' });
    });

    const credentialRequests = [...network.to('POST', '/auth/login'), ...network.to('POST', '/auth/register')];
    expect(credentialRequests).toHaveLength(3);
    expect(credentialRequests.map((request) => request.authorization)).toEqual([null, null, null]);
  });
});
