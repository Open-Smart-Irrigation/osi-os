import type {AccountLinkRequest, AccountLinkResult, AccountLinkStatus, ForceSyncResult, ScopeProfile, SyncStateSummary} from '../../src/services/api';
import {DemoError} from '../errors';

type LocalAccount = {username: string; password: string; userUuid: string};

export interface DemoSessionState {
  accounts: Map<string, LocalAccount>;
  activeUsername: string | null;
  activeUserUuid: string | null;
  tokenSequence: number;
  linked: AccountLinkStatus;
  pendingOutboxCount: number;
  rejectedOutboxCount: number;
  lastOutboxDeliverySuccessAt: string | null;
}

export function createSessionState(): DemoSessionState {
  const seed: LocalAccount = {
    username: 'Demo farmer', password: 'demo', userUuid: '00000000-0000-4000-8000-000000000001',
  };
  return {
    accounts: new Map([[normalizeUsername(seed.username), seed]]),
    activeUsername: seed.username,
    activeUserUuid: seed.userUuid,
    tokenSequence: 0,
    linked: {linked: false, serverUsername: null, linkedAt: null, serverUrl: null},
    pendingOutboxCount: 0,
    rejectedOutboxCount: 0,
    lastOutboxDeliverySuccessAt: null,
  };
}

function normalizeUsername(username: string): string {
  return username.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');
}

function reject(status: number, code: string, message: string): never {
  throw new DemoError(status, code, {error: code, message});
}

export function sessionProfile(state: DemoSessionState): ScopeProfile {
  const account = state.activeUsername && state.accounts.get(normalizeUsername(state.activeUsername));
  if (!account || !state.activeUserUuid) reject(401, 'unauthenticated', 'Sign in to continue');
  return {
    username: account.username,
    user_uuid: account.userUuid,
    role: 'researcher',
    zone_uuids: null,
    plot_uuids: null,
    features: {scoped_access: false},
  };
}

export function loginLocal(state: DemoSessionState, input: unknown): {token: string} {
  const body = input as {username?: unknown; password?: unknown};
  if (typeof body.username !== 'string' || typeof body.password !== 'string') {
    reject(400, 'invalid_credentials', 'Username and password are required');
  }
  const key = normalizeUsername(body.username);
  const account = state.accounts.get(key);
  if (!account || account.password !== body.password) {
    reject(401, 'invalid_credentials', 'Username or password is incorrect');
  }
  state.activeUsername = account.username;
  state.activeUserUuid = account.userUuid;
  state.tokenSequence += 1;
  return {token: `demo-session-${state.tokenSequence.toString(36)}`};
}

export function registerLocal(state: DemoSessionState, input: unknown): {success: true} {
  const body = input as {username?: unknown; password?: unknown};
  if (typeof body.username !== 'string' || !normalizeUsername(body.username)) {
    reject(400, 'invalid_username', 'Username is required');
  }
  if (typeof body.password !== 'string' || body.password.length < 6) {
    reject(400, 'invalid_password', 'Password must be at least 6 characters');
  }
  const key = normalizeUsername(body.username);
  if (state.accounts.has(key)) reject(409, 'username_exists', 'That username is already registered');
  const username = body.username.trim().replace(/\s+/g, ' ');
  const userUuid = `00000000-0000-4000-8000-${String(state.accounts.size + 1).padStart(12, '0')}`;
  state.accounts.set(key, {username, password: body.password, userUuid});
  return {success: true};
}

export function setSessionUser(state: DemoSessionState, username: string | null): void {
  if (username === null) {
    state.activeUsername = null;
    state.activeUserUuid = null;
    return;
  }
  const account = state.accounts.get(normalizeUsername(username));
  if (account) {
    state.activeUsername = account.username;
    state.activeUserUuid = account.userUuid;
  }
}

export function linkLocalAccount(state: DemoSessionState, input: unknown, now: number, deviceEuis: string[]): AccountLinkResult {
  const request = input as AccountLinkRequest;
  if (typeof request.serverUrl !== 'string' || !/^https?:\/\//i.test(request.serverUrl.trim())
    || typeof request.username !== 'string' || !request.username.trim()
    || typeof request.password !== 'string' || !request.password
    || (request.action !== 'login' && request.action !== 'register')) {
    reject(422, 'invalid_account_link', 'Enter a server URL, username, and password for the fictional link');
  }
  if (request.action === 'register' && (typeof request.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(request.email))) {
    reject(422, 'invalid_account_link', 'Enter an email address for the fictional registration');
  }
  const serverUsername = request.username.trim();
  state.linked = {
    linked: true,
    serverUsername,
    linkedAt: new Date(now).toISOString(),
    serverUrl: request.serverUrl.trim(),
  };
  // Only link metadata is retained. The submitted password and email are never stored.
  return {success: true, serverUsername, claimedDevices: [...deviceEuis], skippedDevices: []};
}

export function unlinkLocalAccount(state: DemoSessionState): void {
  state.linked = {linked: false, serverUsername: null, linkedAt: null, serverUrl: null};
}

export function syncSummary(state: DemoSessionState): SyncStateSummary {
  return {
    pendingOutboxCount: state.pendingOutboxCount,
    rejectedOutboxCount: state.rejectedOutboxCount,
    rejectedLast24h: 0,
    lastRejection: null,
    lastOutboxDeliverySuccessAt: state.lastOutboxDeliverySuccessAt,
    lastError: null,
  };
}

export function recordPendingMutation(state: DemoSessionState): void {
  state.pendingOutboxCount += 1;
}

export function forceLocalSync(state: DemoSessionState, now: number): ForceSyncResult {
  const forcedAt = new Date(now).toISOString();
  const before = state.pendingOutboxCount;
  state.pendingOutboxCount = 0;
  state.lastOutboxDeliverySuccessAt = forcedAt;
  return {
    success: true,
    forcedAt,
    refresh: {attempted: true, succeeded: true, statusCode: 200, syncTokenExpiresAt: null, error: null},
    bootstrap: {attempted: true, succeeded: true, applied: 0, skipped: 0, statusCode: 200, error: null},
    outbox: {
      attempted: true, succeeded: true, selected: before, applied: before, duplicate: 0, retryable: 0,
      rejected: 0, protocolErrors: 0, pendingAfter: 0, rejectedByCode: {}, beforeCount: before,
      deliveredCount: before, afterCount: 0, appliedLegacy: 0, skipped: 0, statusCode: 200, error: null,
    },
    pendingCommands: {
      attempted: true, succeeded: true, fetchedCount: 0, queuedCount: 0, appliesAfterResponse: false,
      applyPhase: 'NO_PENDING_COMMANDS', statusCode: 200, error: null,
    },
    lastError: null,
  };
}

export function permissionDenied(): never {
  return reject(403, 'forbidden', 'Administrator access is required');
}
