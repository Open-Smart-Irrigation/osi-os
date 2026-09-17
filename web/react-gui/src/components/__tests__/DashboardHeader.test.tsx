// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { isDesktopBrowser } from '../../utils/isDesktopBrowser';
import { DashboardHeader } from '../DashboardHeader';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        add: 'Add',
        title: 'Open Smart Irrigation Dashboard',
        'addMenu.zone': 'Zone',
        'addMenu.device': 'Device',
        'addMenu.activity': 'Activity',
        data: 'Data',
        'dashboard:network': 'Network',
        'settings:entryPoint': 'Settings',
        account: 'Account',
        'accountMenu.osiServer': 'OSI Server',
        'support:navLabel': 'Support & Requests',
        logout: 'Logout',
      };
      if (key === 'welcome') return `Welcome ${String(options?.username ?? '')}`;
      return map[key] ?? key;
    },
  }),
}));

vi.mock('../LanguageSwitcher', () => ({
  LanguageSwitcher: () => <button title="Change language">Lang EN</button>,
}));

vi.mock('../../utils/isDesktopBrowser', () => ({
  isDesktopBrowser: vi.fn(() => true),
}));

const gatewayModules = vi.hoisted(() => ({ journalEnabled: true }));

vi.mock('../../hooks/useGatewayModules', () => ({
  useJournalModuleEnabled: () => gatewayModules.journalEnabled,
}));

function renderHeader(overrides: Partial<ComponentProps<typeof DashboardHeader>> = {}) {
  const props: ComponentProps<typeof DashboardHeader> = {
    username: 'farmer',
    onAddZone: vi.fn(),
    onAddDevice: vi.fn(),
    onLogout: vi.fn(),
    ...overrides,
  };
  render(<BrowserRouter><DashboardHeader {...props} /></BrowserRouter>);
  return props;
}

beforeEach(() => {
  // The Data/Network header entries are gated on osi.modules.*; a leftover
  // key from a sibling test would silently change what this suite renders.
  window.localStorage.clear();
  gatewayModules.journalEnabled = true;
  vi.mocked(isDesktopBrowser).mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DashboardHeader (osi-os)', () => {
  it('renders the OSI OS title, welcome text, and Settings entry without a standalone language switcher', () => {
    renderHeader();
    expect(screen.getByRole('heading', { name: 'Open Smart Irrigation Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Welcome farmer')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Lang/i })).not.toBeInTheDocument();
    expect(screen.queryByTitle('Change language')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });

  it('fires add callbacks from the Add menu', () => {
    const { onAddZone, onAddDevice } = renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Zone' }));
    expect(onAddZone).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Device' }));
    expect(onAddDevice).toHaveBeenCalledOnce();
  });

  it('uses the wrapping server-style action layout so header menus are not clipped', () => {
    renderHeader();

    const addMenuWrapper = screen.getByRole('button', { name: 'Add' }).closest('div');
    expect(addMenuWrapper).toHaveClass('w-[calc(50%-4px)]');
    expect(addMenuWrapper).toHaveClass('sm:w-auto');

    const actionGroup = addMenuWrapper?.parentElement;
    expect(actionGroup).toHaveClass('flex-wrap');
    expect(actionGroup).not.toHaveClass('overflow-x-auto');
  });

  it('opens the Add menu from the left edge on compact layouts', () => {
    renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByRole('menu')).toHaveClass('left-0');
    expect(screen.getByRole('menu')).not.toHaveClass('right-0');
  });

  it('points the desktop Data link to the analysis view', () => {
    renderHeader();
    expect(screen.getByRole('link', { name: 'Data' })).toHaveAttribute('href', '/analysis');
  });

  it('hides the Data link on mobile/tablet browsers', () => {
    vi.mocked(isDesktopBrowser).mockReturnValue(false);
    renderHeader();
    expect(screen.queryByRole('link', { name: 'Data' })).not.toBeInTheDocument();
  });

  // Module visibility (2026-09-17): Data view / Network are switchable in
  // Settings. Defaults on main are ON; hiding is UI-only, the routes stay
  // reachable by URL.
  it('shows both the Data and Network links when their modules are on by default', () => {
    renderHeader();
    expect(screen.getByRole('link', { name: 'Data' })).toHaveAttribute('href', '/analysis');
    expect(screen.getByRole('link', { name: 'Network' })).toHaveAttribute('href', '/network');
  });

  it('hides the Data link when the data module is off, leaving Network alone', () => {
    window.localStorage.setItem('osi.modules.data', 'false');
    renderHeader();
    expect(screen.queryByRole('link', { name: 'Data' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Network' })).toBeInTheDocument();
  });

  it('hides the Network link when the network module is off, leaving Data alone', () => {
    window.localStorage.setItem('osi.modules.network', 'false');
    renderHeader();
    expect(screen.queryByRole('link', { name: 'Network' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Data' })).toBeInTheDocument();
  });

  // The journal module is gateway-level; with it off, the Add menu must not
  // offer the one entry point that lands on /journal.
  it('offers the journal capture entry in the Add menu when the journal module is on', () => {
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('menuitem', { name: 'Activity' })).toBeInTheDocument();
  });

  it('hides the journal capture entry from the Add menu when the journal module is off', () => {
    gatewayModules.journalEnabled = false;
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.queryByRole('menuitem', { name: 'Activity' })).not.toBeInTheDocument();
    // The other Add entries are untouched.
    expect(screen.getByRole('menuitem', { name: 'Zone' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Device' })).toBeInTheDocument();
  });

  it('keeps the Account menu scoped to account linking and logout', () => {
    const { onLogout } = renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Account' }));
    expect(screen.getByRole('menuitem', { name: 'OSI Server' })).toHaveAttribute('href', '/account-link');
    expect(screen.queryByRole('menuitem', { name: 'Support & Requests' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Logout' }));
    expect(onLogout).toHaveBeenCalledOnce();
  });
});
