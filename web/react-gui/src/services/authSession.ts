// Owner of the authenticated session for this tab (#378).
//
// Every session transition — interactive login (even of the same account),
// logout, a 401 that ends the session, and any change of the stored token
// made by another tab — publishes a new snapshot with a new, never reused
// `sessionEpoch`. Cached client data and in-flight work are bound to one
// epoch (see contexts/AuthSessionDataBoundary.tsx and the interceptors in
// services/api.ts), so nothing from one session can reach the next.
//
// The edge token contract carries no verifiable immutable principal, so
// `principalId` is always null here and the epoch alone separates sessions.
// U02 adds the stable principal; until then the username is display data,
// never identity.
import { notifyAuthExpired, resetAuthExpiredSignal } from './authEvents';

export const AUTH_TOKEN_STORAGE_KEY = 'auth_token';
export const AUTH_USERNAME_STORAGE_KEY = 'username';

export interface AuthSessionSnapshot {
  readonly token: string | null;
  readonly username: string | null;
  /** Immutable account id; null until the edge exposes one (U02). */
  readonly principalId: string | null;
  readonly sessionEpoch: number;
}

/** What private client data is keyed by. */
export interface SessionIdentity {
  readonly serverInstance: string;
  readonly principalId: string | null;
  readonly sessionEpoch: number;
}

/** Axios config fragment for work that is queued or dispatched later. */
export interface SessionBoundRequest {
  readonly authSession: AuthSessionSnapshot;
}

export class StaleSessionRequestError extends Error {
  constructor() {
    super('The request belongs to a session that has ended');
    this.name = 'StaleSessionRequestError';
  }
}

export class AuthOperationSupersededError extends Error {
  constructor() {
    super('A newer sign-in or sign-out replaced this sign-in');
    this.name = 'AuthOperationSupersededError';
  }
}

let epochCounter = 0;
let operationGeneration = 0;
let current: AuthSessionSnapshot | null = null;
// Cancels the in-flight requests of the current epoch when it ends, so an
// awaited step of a multi-step mutation rejects instead of letting the next
// step go out under the following session.
let epochRequests = new AbortController();
const listeners = new Set<() => void>();

function readStoredCredentials(): { token: string | null; username: string | null } {
  try {
    return {
      token: localStorage.getItem(AUTH_TOKEN_STORAGE_KEY),
      username: localStorage.getItem(AUTH_USERNAME_STORAGE_KEY),
    };
  } catch {
    return { token: null, username: null };
  }
}

function writeStoredCredentials(token: string | null, username: string | null): void {
  try {
    if (token === null) {
      localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
      localStorage.removeItem(AUTH_USERNAME_STORAGE_KEY);
      return;
    }
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    if (username === null) localStorage.removeItem(AUTH_USERNAME_STORAGE_KEY);
    else localStorage.setItem(AUTH_USERNAME_STORAGE_KEY, username);
  } catch {
    // Storage may be unavailable; the in-memory session still applies.
  }
}

function newSnapshot(token: string | null, username: string | null): AuthSessionSnapshot {
  epochCounter += 1;
  return Object.freeze({
    token,
    username: token ? username : null,
    principalId: null,
    sessionEpoch: epochCounter,
  });
}

function publish(next: AuthSessionSnapshot): AuthSessionSnapshot {
  const ending = epochRequests;
  epochRequests = new AbortController();
  current = next;
  operationGeneration += 1;
  ending.abort();
  resetAuthExpiredSignal();
  for (const listener of [...listeners]) listener();
  return next;
}

/** The current session. Read lazily so storage written before first use counts. */
export function getAuthSession(): AuthSessionSnapshot {
  if (current === null) {
    const stored = readStoredCredentials();
    current = newSnapshot(stored.token, stored.username);
  }
  return current;
}

/** Aborts when the current epoch ends; attached to every api request. */
export function currentSessionSignal(): AbortSignal {
  getAuthSession();
  return epochRequests.signal;
}

export function subscribeAuthSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Interactive login: always a new epoch, even for the same account. */
export function beginAuthSession(token: string, username: string): AuthSessionSnapshot {
  writeStoredCredentials(token, username);
  return publish(newSnapshot(token, username));
}

/** Logout or expiry: a new, anonymous epoch. */
export function endAuthSession(): AuthSessionSnapshot {
  writeStoredCredentials(null, null);
  return publish(newSnapshot(null, null));
}

/**
 * Adopts the credentials in storage as a new epoch. With `force`, any call
 * rotates (a token key event from another tab); without it, only a stored
 * value that differs from the current session does (mount-time check, a
 * username-only event).
 */
export function adoptStoredAuthSession({ force }: { force: boolean }): boolean {
  const stored = readStoredCredentials();
  const session = getAuthSession();
  const storedUsername = stored.token ? stored.username : null;
  if (!force && stored.token === session.token && storedUsername === session.username) return false;
  publish(newSnapshot(stored.token, stored.username));
  return true;
}

export function isCurrentAuthSession(snapshot: AuthSessionSnapshot | null | undefined): boolean {
  if (!snapshot) return false;
  const session = getAuthSession();
  return snapshot.sessionEpoch === session.sessionEpoch && snapshot.token === session.token;
}

/**
 * Ends the session after a 401, but only when the failed request was sent
 * by the current, authenticated session. A late 401 for an earlier session
 * leaves the current account alone.
 */
export function expireAuthSession(captured: AuthSessionSnapshot | null | undefined): boolean {
  if (!captured?.token || !isCurrentAuthSession(captured)) return false;
  endAuthSession();
  notifyAuthExpired();
  return true;
}

/** Starts a login attempt; any later attempt or session change supersedes it. */
export function beginAuthOperation(): number {
  operationGeneration += 1;
  return operationGeneration;
}

export function isLatestAuthOperation(operation: number): boolean {
  return operation === operationGeneration;
}

export function currentServerInstance(): string {
  // The edge GUI only talks to the gateway that served it (api baseURL '/').
  return typeof window === 'undefined' ? 'edge' : `${window.location.origin}/`;
}

export function sessionIdentityOf(snapshot: AuthSessionSnapshot): SessionIdentity {
  return {
    serverInstance: currentServerInstance(),
    principalId: snapshot.principalId,
    sessionEpoch: snapshot.sessionEpoch,
  };
}

export function serializeSessionIdentity(identity: SessionIdentity): string {
  return JSON.stringify([identity.serverInstance, identity.principalId, identity.sessionEpoch]);
}
