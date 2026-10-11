import {render, screen} from '@testing-library/react';
import {MemoryRouter} from 'react-router-dom';
import {afterEach, expect, it, vi} from 'vitest';
import {Login} from '../Login';

vi.mock('../../contexts/AuthContext', () => ({useAuth: () => ({login: vi.fn()})}));
vi.mock('../../components/LanguageSwitcher', () => ({LanguageSwitcher: () => null}));
vi.mock('react-i18next', () => ({useTranslation: () => ({t: (key: string) => key})}));

afterEach(() => vi.unstubAllEnvs());

it('prefills the public demo account and explains local re-entry without changing production defaults', () => {
  document.documentElement.dataset.publicSimulator = 'true';
  const {unmount} = render(<MemoryRouter><Login /></MemoryRouter>);
  expect((screen.getByLabelText('login.username') as HTMLInputElement).value).toBe('Demo farmer');
  expect((screen.getByLabelText('login.password') as HTMLInputElement).value).toBe('demo');
  expect(screen.getByText('login.demoHelp')).toBeTruthy();
  unmount();

  delete document.documentElement.dataset.publicSimulator;
  render(<MemoryRouter><Login /></MemoryRouter>);
  expect((screen.getByLabelText('login.username') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('login.password') as HTMLInputElement).value).toBe('');
  expect(screen.queryByText('login.demoHelp')).toBeNull();
});
