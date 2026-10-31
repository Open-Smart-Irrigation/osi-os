// #521: the exported helpers the Users page relies on. This file imports
// exports that #521 adds, so before #521 it cannot reach a behavioural
// assertion; api.adminUsers.test.ts carries the behavioural cases.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  installFakeNetwork,
  resetSession,
  restoreNetwork,
  type FakeNetwork,
} from '../../contexts/__tests__/sessionHarness';
import {
  LINKED_PASSWORD_RESET_UNSUPPORTED,
  LinkedPasswordResetError,
  isLinkedPasswordResetError,
  normaliseAdminAuthMode,
  resetPassword,
} from '../api';

const RESET = '/api/users/u-521/password-reset';

let network: FakeNetwork;

beforeEach(() => {
  resetSession();
  network = installFakeNetwork();
});

afterEach(() => {
  restoreNetwork();
  localStorage.clear();
});

describe('admin user service exports', () => {
  it('exposes the exact linked code and normalizes sign-in types', () => {
    expect(LINKED_PASSWORD_RESET_UNSUPPORTED).toBe('linked_account_password_reset_unsupported');
    expect(normaliseAdminAuthMode('local')).toBe('local');
    expect(normaliseAdminAuthMode('server')).toBe('server');
    for (const value of ['LOCAL', 'legacy-x', '', null, undefined, 1]) expect(normaliseAdminAuthMode(value)).toBe('unknown');
  });

  it('types the linked refusal as a LinkedPasswordResetError', async () => {
    network.on('POST', RESET, () => ({ status: 409, data: { code: LINKED_PASSWORD_RESET_UNSUPPORTED, message: 'linked text' } }));
    const error = await resetPassword('u-521', 'new-pass-521').then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(LinkedPasswordResetError);
    expect(isLinkedPasswordResetError(error)).toBe(true);
  });

  it('does not type any other failure', async () => {
    network.on('POST', RESET, () => ({ status: 409, data: { message: 'other' } }));
    const error = await resetPassword('u-521', 'new-pass-521').then(() => null, (cause: unknown) => cause);
    expect(isLinkedPasswordResetError(error)).toBe(false);
    expect(isLinkedPasswordResetError(new Error('plain'))).toBe(false);
  });
});
