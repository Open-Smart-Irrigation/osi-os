// Sign-in when the gateway asks the account for a new password: the Login
// page shows the new-password step instead of opening the dashboard, sends
// the new password with the next sign-in request, and offers "Continue for
// now" only when the gateway could not store it.
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import en from '../../../public/locales/en/auth.json';
import { Login } from '../Login';

const mocks = vi.hoisted(() => ({ login: vi.fn() }));

function translate(key: string): string {
  const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], en);
  return typeof value === 'string' ? value : key;
}

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: translate }) }));
vi.mock('../../components/LanguageSwitcher', () => ({ LanguageSwitcher: () => null }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ login: mocks.login }) }));

const TOKEN = 'synthetic.token';

function renderLogin() {
  render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<p>dashboard page</p>} />
      </Routes>
    </MemoryRouter>
  );
}

function signIn() {
  fireEvent.change(screen.getByLabelText(en.login.username), { target: { value: 'grower' } });
  fireEvent.change(screen.getByLabelText(en.login.password), { target: { value: 'current-pass' } });
  fireEvent.click(screen.getByRole('button', { name: en.login.signIn }));
}

function enterNewPassword(value: string, confirm = value) {
  fireEvent.change(screen.getByLabelText(en.passwordChange.newPassword), { target: { value } });
  fireEvent.change(screen.getByLabelText(en.passwordChange.confirmPassword), { target: { value: confirm } });
  fireEvent.click(screen.getByRole('button', { name: en.passwordChange.submit }));
}

const required = { status: 'password-change-required', response: { token: TOKEN, passwordChangeRequired: true } };

describe('Login with a required password change', () => {
  beforeEach(() => mocks.login.mockReset());

  it('opens the dashboard directly for an ordinary sign-in', async () => {
    mocks.login.mockResolvedValueOnce({ status: 'signed-in', response: { token: TOKEN } });
    renderLogin();
    signIn();
    expect(await screen.findByText('dashboard page')).toBeInTheDocument();
  });

  it('asks for a new password before the dashboard and sends it with the next sign-in', async () => {
    mocks.login
      .mockResolvedValueOnce(required)
      .mockResolvedValueOnce({ status: 'signed-in', response: { token: TOKEN, passwordChange: 'changed' } });
    renderLogin();
    signIn();
    expect(await screen.findByText(en.passwordChange.title)).toBeInTheDocument();
    expect(screen.queryByText('dashboard page')).not.toBeInTheDocument();

    enterNewPassword('abc');
    expect(screen.getByText(en.passwordChange.tooShort)).toBeInTheDocument();
    enterNewPassword('chosen-pass-42', 'chosen-pass-43');
    expect(screen.getByText(en.passwordChange.mismatch)).toBeInTheDocument();
    expect(mocks.login).toHaveBeenCalledTimes(1);

    enterNewPassword('chosen-pass-42');
    expect(await screen.findByText('dashboard page')).toBeInTheDocument();
    expect(mocks.login).toHaveBeenLastCalledWith({ username: 'grower', password: 'current-pass', newPassword: 'chosen-pass-42' });
    expect(screen.queryByText(en.passwordChange.continueForNow)).not.toBeInTheDocument();
  });

  it('refuses a new password over 72 bytes before sending it, and maps the gateway refusal', async () => {
    mocks.login
      .mockResolvedValueOnce(required)
      .mockResolvedValueOnce({
        status: 'password-change-required',
        response: { token: TOKEN, passwordChangeRequired: true, passwordChange: 'rejected', passwordChangeError: 'password_too_long' },
      });
    renderLogin();
    signIn();
    await screen.findByText(en.passwordChange.title);
    // 37 two-byte characters: 74 bytes.
    enterNewPassword('\u00e9'.repeat(37));
    expect(screen.getByText(en.passwordChange.tooLong)).toBeInTheDocument();
    expect(mocks.login).toHaveBeenCalledTimes(1);
    enterNewPassword('z'.repeat(72));
    expect(await screen.findByText(en.passwordChange.tooLong)).toBeInTheDocument();
    expect(mocks.login).toHaveBeenLastCalledWith({ username: 'grower', password: 'current-pass', newPassword: 'z'.repeat(72) });
  });

  it('shows a refused new password and stays on the step without a way past it', async () => {
    mocks.login
      .mockResolvedValueOnce(required)
      .mockResolvedValueOnce({
        status: 'password-change-required',
        response: { token: TOKEN, passwordChangeRequired: true, passwordChange: 'rejected', passwordChangeError: 'password_unchanged' },
      });
    renderLogin();
    signIn();
    await screen.findByText(en.passwordChange.title);
    enterNewPassword('current-pass');
    expect(await screen.findByText(en.passwordChange.unchanged)).toBeInTheDocument();
    expect(screen.queryByText(en.passwordChange.continueForNow)).not.toBeInTheDocument();
    expect(screen.queryByText('dashboard page')).not.toBeInTheDocument();
  });

  it('offers to continue for now when the gateway could not store the new password', async () => {
    mocks.login
      .mockResolvedValueOnce(required)
      .mockResolvedValueOnce({
        status: 'password-change-required',
        response: { token: TOKEN, passwordChangeRequired: true, passwordChange: 'failed' },
      })
      .mockResolvedValueOnce({ status: 'signed-in', response: { token: TOKEN, passwordChangeRequired: true } });
    renderLogin();
    signIn();
    await screen.findByText(en.passwordChange.title);
    enterNewPassword('chosen-pass-42');
    expect(await screen.findByText(en.passwordChange.storeFailed)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.passwordChange.continueForNow }));
    await waitFor(() => expect(screen.getByText('dashboard page')).toBeInTheDocument());
    expect(mocks.login).toHaveBeenLastCalledWith(
      { username: 'grower', password: 'current-pass' },
      { acceptPendingPasswordChange: true }
    );
  });
});
