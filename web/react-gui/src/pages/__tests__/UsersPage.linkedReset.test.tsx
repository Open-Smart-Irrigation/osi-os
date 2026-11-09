// #521: the Users page offers a reset only for local accounts, explains
// linked and unknown sign-in types, and keeps the reset form intact on any
// failed reset or failed reload. Runs the real `api` client against a fake
// network adapter.
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installFakeNetwork,
  ok,
  resetSession,
  restoreNetwork,
  type FakeNetwork,
  type Reply,
} from '../../contexts/__tests__/sessionHarness';
import { UsersPage } from '../admin/UsersPage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

const LINKED_REFUSED = 'This account uses linked sign-in, so its password cannot be reset on this gateway. Ask the linked-identity administrator for the approved recovery process.';
const REFRESH_FAILED = 'The password reset was sent, but the user list could not be reloaded. The reset may already have been applied; reload the page before trying again.';

function row(username: string, authMode?: string) {
  return {
    username, user_uuid: `${username}-uuid`, role: 'researcher', disabled_at: null,
    created_at: '2026-01-01T00:00:00Z', ...(authMode === undefined ? {} : { auth_mode: authMode }),
  };
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

function renderPage() {
  render(<MemoryRouter><UsersPage /></MemoryRouter>);
}

function rowFor(username: string) {
  return screen.getByText(username).closest('tr') as HTMLElement;
}

async function openResetFor(username: string, value = 'new-pass-521', confirmation = value) {
  fireEvent.click(within(rowFor(username)).getByRole('button', { name: 'Reset password' }));
  fireEvent.change(screen.getByLabelText('New temporary password'), { target: { value } });
  fireEvent.change(screen.getByLabelText('Confirm temporary password'), { target: { value: confirmation } });
  fireEvent.click(screen.getByRole('button', { name: 'Save password' }));
}

function expectFormRetained(username: string, value = 'new-pass-521') {
  expect(screen.getByRole('heading', { name: `Reset password for ${username}` })).toBeInTheDocument();
  expect(screen.getByLabelText('New temporary password')).toHaveValue(value);
  expect(screen.getByLabelText('Confirm temporary password')).toHaveValue(value);
}

describe('Users page sign-in types', () => {
  it('offers a reset only on local rows and explains linked and unknown rows', async () => {
    network.on('GET', '/api/users', () => ok({ users: [row('local1', 'local'), row('linked1', 'server'), row('novel1', 'legacy-x')] }));
    renderPage();
    await screen.findByText('local1');
    expect(within(rowFor('local1')).getByRole('button', { name: 'Reset password' })).toBeInTheDocument();
    expect(within(rowFor('linked1')).queryByRole('button', { name: 'Reset password' })).toBeNull();
    expect(within(rowFor('linked1')).getByText('Linked sign-in')).toBeInTheDocument();
    expect(within(rowFor('linked1')).getByText(/approved linked-identity recovery process/)).toBeInTheDocument();
    expect(within(rowFor('novel1')).queryByRole('button', { name: 'Reset password' })).toBeNull();
    expect(within(rowFor('novel1')).getByText('Sign-in type unavailable. Ask the gateway administrator.')).toBeInTheDocument();
  });

  it('fails closed against an older gateway that sends no auth_mode', async () => {
    network.on('GET', '/api/users', () => ok({ users: [row('old1'), row('old2')] }));
    renderPage();
    await screen.findByText('old1');
    expect(screen.queryAllByRole('button', { name: 'Reset password' })).toHaveLength(0);
    expect(screen.getAllByText('Sign-in type unavailable. Ask the gateway administrator.')).toHaveLength(2);
  });
});

describe('Users page reset outcomes', () => {
  const failures: Array<[string, Reply, string | RegExp]> = [
    ['the exact linked refusal from a stale local row', { status: 409, data: { code: 'linked_account_password_reset_unsupported', message: 'server text' } }, LINKED_REFUSED],
    ['a generic 409', { status: 409, data: { message: 'Some other conflict' } }, 'Some other conflict'],
    ['a server error', { status: 500, data: { message: 'The password reset could not be completed. Reload the user list before trying again.' } }, /could not be completed/],
  ];
  it.each(failures)('keeps the form and shows the right message for %s', async (_label, reply, message) => {
    network.on('GET', '/api/users', () => ok({ users: [row('local1', 'local')] }));
    network.on('POST', '/api/users/local1-uuid/password-reset', () => reply);
    renderPage();
    await screen.findByText('local1');
    await openResetFor('local1');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    if (message !== LINKED_REFUSED) expect(alert).not.toHaveTextContent(/linked sign-in/);
    expectFormRetained('local1');
  });

  it('keeps the form and says the reset may have applied when only the reload fails', async () => {
    let loads = 0;
    network.on('GET', '/api/users', () => {
      loads += 1;
      return loads === 1 ? ok({ users: [row('local1', 'local')] }) : { status: 500, data: { message: 'list failed' } };
    });
    network.on('POST', '/api/users/local1-uuid/password-reset', () => ok({ success: true }));
    renderPage();
    await screen.findByText('local1');
    await openResetFor('local1');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(REFRESH_FAILED));
    expect(network.to('POST', '/api/users/local1-uuid/password-reset')).toHaveLength(1);
    expectFormRetained('local1');
  });

  it('closes and clears the form only after the reset and the reload succeed', async () => {
    network.on('GET', '/api/users', () => ok({ users: [row('local1', 'local')] }));
    network.on('POST', '/api/users/local1-uuid/password-reset', () => ok({ success: true }));
    renderPage();
    await screen.findByText('local1');
    await openResetFor('local1');
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Reset password for local1' })).toBeNull());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(network.to('GET', '/api/users').length).toBeGreaterThanOrEqual(2);
  });

  it('control: mismatched confirmation sends nothing', async () => {
    network.on('GET', '/api/users', () => ok({ users: [row('local1', 'local')] }));
    renderPage();
    await screen.findByText('local1');
    await openResetFor('local1', 'new-pass-521', 'different-521');
    expect(await screen.findByRole('alert')).toHaveTextContent('The passwords do not match.');
    expect(network.to('POST', '/api/users/local1-uuid/password-reset')).toHaveLength(0);
  });
});
