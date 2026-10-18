// Shared harness for the session-epoch tests (#378). It replaces only the
// network adapter of the real `api` instance, so the real interceptors,
// AuthProvider, session boundary and SWR all run unchanged.
import { act } from '@testing-library/react';
import {
  AxiosError,
  AxiosHeaders,
  CanceledError,
  type AxiosAdapter,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import type { ReactNode } from 'react';
import { api } from '../../services/api';
import { endAuthSession } from '../../services/authSession';
import { useAuth } from '../AuthContext';

type AuthValue = ReturnType<typeof useAuth>;

export interface FakeRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly body: unknown;
  readonly settled: boolean;
  respond(data: unknown): void;
  fail(status: number, data?: unknown): void;
}

export type Reply = { status: number; data: unknown } | 'defer';
type Route = { method: string; url: string; reply: (request: FakeRequest) => Reply };

function parseBody(data: unknown): unknown {
  if (typeof data !== 'string') return data ?? null;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

/** Synthetic tokens name the account so routes can answer per account. */
export function accountOf(request: FakeRequest): string | null {
  const match = /^Bearer token-([a-z]+)-\d+$/.exec(request.authorization ?? '');
  return match ? match[1] : null;
}

export function ok(data: unknown): Reply {
  return { status: 200, data };
}

export function createFakeNetwork() {
  const requests: FakeRequest[] = [];
  const routes: Route[] = [];
  let tokenCounter = 0;

  const adapter: AxiosAdapter = (config: InternalAxiosRequestConfig) =>
    new Promise<AxiosResponse>((resolve, reject) => {
      const headers = AxiosHeaders.from(config.headers);
      const authorization = headers.get('Authorization');
      let settled = false;
      const request: FakeRequest = {
        method: (config.method ?? 'get').toUpperCase(),
        url: config.url ?? '',
        authorization: typeof authorization === 'string' ? authorization : null,
        body: parseBody(config.data),
        get settled() {
          return settled;
        },
        respond(data) {
          if (settled) return;
          settled = true;
          resolve({ data, status: 200, statusText: 'OK', headers: {}, config });
        },
        fail(status, data = {}) {
          if (settled) return;
          settled = true;
          const response = { data, status, statusText: 'Error', headers: {}, config } as AxiosResponse;
          reject(new AxiosError(`HTTP ${status}`, 'ERR_BAD_RESPONSE', config, undefined, response));
        },
      };
      requests.push(request);
      // Like the browser transports: an aborted signal cancels the request.
      // `honourAbort = false` models a transport that settles regardless.
      config.signal?.addEventListener?.('abort', () => {
        if (settled || !network.honourAbort) return;
        settled = true;
        reject(new CanceledError());
      });
      const route = [...routes]
        .reverse()
        .find((candidate) => candidate.method === request.method && candidate.url === request.url);
      const reply = route?.reply(request) ?? 'defer';
      if (reply === 'defer') return;
      if (reply.status < 400) request.respond(reply.data);
      else request.fail(reply.status, reply.data);
    });

  const network = {
    adapter,
    requests,
    honourAbort: true,
    /** Later registrations win over earlier ones for the same method + URL. */
    on(method: string, url: string, reply: (request: FakeRequest) => Reply) {
      routes.push({ method, url, reply });
    },
    to(method: string, url: string): FakeRequest[] {
      return requests.filter((request) => request.method === method && request.url === url);
    },
  };

  network.on('POST', '/auth/login', (request) => {
    const username = (request.body as { username?: string } | null)?.username ?? 'nobody';
    tokenCounter += 1;
    return ok({ token: `token-${username}-${tokenCounter}` });
  });
  network.on('GET', '/api/me', (request) =>
    ok({
      username: accountOf(request),
      user_uuid: null,
      role: 'admin',
      zone_uuids: null,
      plot_uuids: null,
      features: { scoped_access: false },
    }));

  return network;
}

export type FakeNetwork = ReturnType<typeof createFakeNetwork>;

const originalAdapter = api.defaults.adapter;

/**
 * Clears storage and the tab's session store. The store is module state, so
 * without this a test would start inside the previous test's session.
 */
export function resetSession(): void {
  localStorage.clear();
  endAuthSession();
}

export function installFakeNetwork(): FakeNetwork {
  const network = createFakeNetwork();
  api.defaults.adapter = network.adapter;
  return network;
}

export function restoreNetwork(): void {
  api.defaults.adapter = originalAdapter;
}

/** Holds the latest AuthContext value rendered by <AuthCapture />. */
export function createAuthHandle() {
  const handle: { current: AuthValue | null } = { current: null };
  function AuthCapture() {
    handle.current = useAuth();
    return null;
  }
  const auth = () => {
    if (!handle.current) throw new Error('AuthCapture is not mounted');
    return handle.current;
  };
  return { handle, AuthCapture, auth };
}

export async function loginAs(auth: () => AuthValue, username: string): Promise<void> {
  await act(async () => {
    await auth().login({ username, password: 'synthetic-password' });
  });
}

export function logout(auth: () => AuthValue): void {
  act(() => {
    auth().logout();
  });
}

/** Writes the auth keys the way another tab would and delivers the event. */
export function writeFromOtherTab(token: string | null, username: string | null): void {
  const oldValue = localStorage.getItem('auth_token');
  if (token === null) localStorage.removeItem('auth_token');
  else localStorage.setItem('auth_token', token);
  if (username === null) localStorage.removeItem('username');
  else localStorage.setItem('username', username);
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: 'auth_token',
      oldValue,
      newValue: token,
      storageArea: localStorage,
    }),
  );
}

export function PrivateArea({ children }: { children: ReactNode }) {
  const { isAuthenticated, username } = useAuth();
  if (!isAuthenticated) return <p data-testid="who">signed-out</p>;
  return (
    <>
      <p data-testid="who">{username}</p>
      {children}
    </>
  );
}

export async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) await Promise.resolve();
}
