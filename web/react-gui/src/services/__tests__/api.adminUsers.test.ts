// #521: the user list carries a normalized sign-in type, and only the exact
// linked refusal (HTTP 409 plus its code) becomes a typed error. This file
// imports only exports that already exist before #521, so on the old service
// every case reaches its behavioural assertion. The fake network replaces
// only the axios adapter of the real `api`, so the real interceptors run.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installFakeNetwork,
  ok,
  resetSession,
  restoreNetwork,
  type FakeNetwork,
} from '../../contexts/__tests__/sessionHarness';
import { createUser, listUsers, resetPassword } from '../api';

const UUID = '00000000-0000-4000-8000-000000000521';
const RESET = `/api/users/${UUID}/password-reset`;
const LINKED_CODE = 'linked_account_password_reset_unsupported';
const LINKED_BODY = {
  code: LINKED_CODE,
  message: 'This account uses linked sign-in. Its password cannot be reset on this gateway. '
    + 'Ask the linked-identity administrator for the approved recovery process.',
};

function row(username: string, extra: Record<string, unknown>) {
  return { username, user_uuid: `${username}-uuid`, role: 'viewer', disabled_at: null, created_at: '2026-01-01T00:00:00Z', ...extra };
}

function modeOf(user: unknown): unknown {
  return (user as { auth_mode?: unknown }).auth_mode;
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

let network: FakeNetwork;

beforeEach(() => {
  resetSession();
  network = installFakeNetwork();
});

afterEach(() => {
  restoreNetwork();
  localStorage.clear();
});

describe('admin user list normalization', () => {
  it('maps only exact local and server values and keeps the other fields', async () => {
    network.on('GET', '/api/users', () => ok({
      users: [
        row('local1', { auth_mode: 'local' }),
        row('linked1', { auth_mode: 'server' }),
        row('novel1', { auth_mode: 'legacy-x' }),
        row('old1', {}),
        row('null1', { auth_mode: null }),
        row('upper1', { auth_mode: 'LOCAL' }),
      ],
    }));
    const users = await listUsers();
    expect(users.map((user) => [user.username, modeOf(user)])).toEqual([
      ['local1', 'local'], ['linked1', 'server'], ['novel1', 'unknown'],
      ['old1', 'unknown'], ['null1', 'unknown'], ['upper1', 'unknown'],
    ]);
    expect(users[0]).toMatchObject({ user_uuid: 'local1-uuid', role: 'viewer', disabled_at: null });
  });

  it('rejects a list response that is not an array', async () => {
    network.on('GET', '/api/users', () => ok({ users: 'nope' }));
    await expect(listUsers()).rejects.toThrow(/unreadable user list/);
  });

  it('normalizes the create response too', async () => {
    network.on('POST', '/api/users', () => ok(row('created1', {})));
    expect(modeOf(await createUser({ username: 'created1', password: 'created-pass', role: 'viewer' }))).toBe('unknown');
  });
});

describe('password reset error typing', () => {
  it('control: a successful reset resolves and sends only the password', async () => {
    network.on('POST', RESET, () => ok({ success: true }));
    await resetPassword(UUID, 'new-pass-521');
    expect(network.to('POST', RESET)).toHaveLength(1);
    expect(network.to('POST', RESET)[0].body).toEqual({ password: 'new-pass-521' });
  });

  it('turns HTTP 409 with the exact linked code into a typed linked error', async () => {
    network.on('POST', RESET, () => ({ status: 409, data: LINKED_BODY }));
    const error = await rejection(resetPassword(UUID, 'new-pass-521'));
    expect((error as Error).name).toBe('LinkedPasswordResetError');
    expect((error as { code?: unknown }).code).toBe(LINKED_CODE);
    expect((error as Error).message).toBe(LINKED_BODY.message);
  });

  it.each([
    ['a generic 409', 409, { message: 'UNIQUE constraint failed: users.username' }],
    ['a 409 with another code', 409, { code: 'something_else', message: 'Other conflict' }],
    ['the linked code on a 500', 500, LINKED_BODY],
    ['a 401', 401, { message: 'Unauthorized' }],
    ['a 404', 404, { message: 'User not found' }],
  ])('control: leaves %s as the original HTTP error', async (_label, status, data) => {
    network.on('POST', RESET, () => ({ status, data }));
    const error = await rejection(resetPassword(UUID, 'new-pass-521'));
    expect((error as Error).name).not.toBe('LinkedPasswordResetError');
    expect((error as { response?: { status?: number } }).response?.status).toBe(status);
    expect((error as { response?: { data?: unknown } }).response?.data).toEqual(data);
  });
});
