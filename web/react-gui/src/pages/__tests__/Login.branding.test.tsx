// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Login } from '../Login';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    login: vi.fn(),
  }),
}));

vi.mock('../../components/LanguageSwitcher', () => ({
  LanguageSwitcher: () => <div aria-label="language switcher" />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string) => {
      const map: Record<string, string> = {
        'login.subtitle': 'translated login subtitle',
        'login.username': 'Username',
        'login.usernamePlaceholder': 'Enter your username',
        'login.password': 'Password',
        'login.passwordPlaceholder': 'Enter your password',
        'login.signIn': 'Sign in',
        'login.signingIn': 'Signing in…',
        'login.noAccount': 'Create account',
        'login.failed': 'Login failed. Please check your credentials.',
      };
      return map[key] ?? key;
    },
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Login AgroLink branding', () => {
  it('renders the Agroscope Balken crown, AgroLink title, and the quiet Register Account link', () => {
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );

    expect(screen.getByRole('img', { name: 'Agroscope' })).toHaveAttribute(
      'src',
      expect.stringContaining('balken-horizontal-en'),
    );
    expect(screen.getByRole('heading', { name: 'AgroLink' })).toBeInTheDocument();
    expect(screen.queryByText('Powered by OSI OS')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create account' })).toHaveAttribute('href', '/register');
    expect(screen.queryByText('translated login subtitle')).not.toBeInTheDocument();
    expect(screen.queryByText(/OSI OS v0\.6\.5/)).not.toBeInTheDocument();
  });
});
