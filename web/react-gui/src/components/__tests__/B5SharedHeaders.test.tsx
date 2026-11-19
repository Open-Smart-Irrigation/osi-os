// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { AppHeader } from '../AppHeader';
import { DashboardHeader } from '../DashboardHeader';
import { HistoryMobileHeader } from '../history/mobile/HistoryMobileHeader';
import { HeaderMenu } from '../HeaderMenu';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../LanguageSwitcher', () => ({ LanguageSwitcher: () => <button>Language</button> }));
vi.mock('../../hooks/useGatewayModules', () => ({ useGatewayModules: () => ({ data: true, journal: true, network: true }) }));
vi.mock('../../utils/isDesktopBrowser', () => ({ isDesktopBrowser: () => true }));
afterEach(cleanup);

it.each(['dashboard', 'analysis', 'history'])('shares navigation and language controls on %s', (variant) => {
  const logout = vi.fn();
  render(<MemoryRouter initialEntries={[variant === 'dashboard' ? '/dashboard' : '/history']}>
    {variant === 'dashboard' ? <DashboardHeader username="user" onAddZone={vi.fn()} onAddDevice={vi.fn()} onLogout={logout} showAdmin />
      : variant === 'history' ? <HistoryMobileHeader onLogout={logout} showAdmin />
      : <AppHeader title="Analysis" username="user" onLogout={logout} showAdmin />}
  </MemoryRouter>);
  expect(screen.getByRole('navigation')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'tabs.journal' })).toHaveAttribute('href', '/journal');
  expect(screen.getByRole('button', { name: 'Language' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'header.menu' })).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('button', { name: 'admin' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'account' }));
  expect(screen.getByRole('menuitem', { name: 'adminMenu.users' })).toHaveAttribute('href', '/admin/users');
  expect(screen.getByRole('menuitem', { name: 'adminMenu.grants' })).toHaveAttribute('href', '/admin/grants');
  fireEvent.click(screen.getByRole('menuitem', { name: 'logout' }));
  expect(logout).toHaveBeenCalledOnce();
});

it('never offers administrator destinations without permission', () => {
  render(<MemoryRouter><AppHeader title="Analysis" username="user" onLogout={vi.fn()} /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'account' }));
  expect(screen.queryByRole('menuitem', { name: 'adminMenu.users' })).not.toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'adminMenu.grants' })).not.toBeInTheDocument();
});

it('uses a decorative SVG chevron that rotates with the menu state', () => {
  render(<HeaderMenu label="Account" triggerClassName="" items={[{ key: 'logout', label: 'Log out', onSelect: vi.fn() }]} />);
  const trigger = screen.getByRole('button', { name: 'Account' });
  const chevron = trigger.querySelector('svg');
  expect(chevron).toHaveAttribute('aria-hidden', 'true');
  expect(trigger).toHaveTextContent(/^Account$/);
  fireEvent.click(trigger);
  expect(chevron).toHaveClass('rotate-180');
});

it('keeps navigation available without write actions', () => {
  render(<MemoryRouter><DashboardHeader username="user" onAddZone={vi.fn()} onAddDevice={vi.fn()} onLogout={vi.fn()} canWrite={false} /></MemoryRouter>);
  expect(screen.queryByRole('button', { name: 'add' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'tabs.journal' })).toBeInTheDocument();
});

it('focuses the phone actions and dismisses them with Escape or outside click', () => {
  render(<MemoryRouter><AppHeader title="Analysis" username="user" onLogout={vi.fn()} /></MemoryRouter>);
  const toggle = screen.getByRole('button', { name: 'header.menu' });
  fireEvent.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('link', { name: 'settings:entryPoint' })).toHaveFocus();
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(toggle).toHaveFocus();
  fireEvent.click(toggle);
  fireEvent.mouseDown(document.body);
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
});
