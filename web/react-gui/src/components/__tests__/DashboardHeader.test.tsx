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
    i18n: { language: 'en' },
    t: (key: string, options?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        add: 'Add',
        title: 'Dashboard',
        'addMenu.zone': 'Zone',
        'addMenu.device': 'Device',
        'addMenu.activity': 'Log activity',
        'tabs.zones': 'Zones',
        'tabs.data': 'Data',
        'tabs.journal': 'Journal',
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
  vi.mocked(isDesktopBrowser).mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('DashboardHeader (osi-os)', () => {
  it('renders the plain Dashboard title, Agroscope Balken, welcome text, and Settings entry without a standalone language switcher', () => {
    renderHeader();
    expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Agroscope Balken' })).toHaveAttribute(
      'src',
      expect.stringContaining('balken-horizontal-en'),
    );
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

  it('renders the Add menu in a non-clipping action row', () => {
    renderHeader();

    const addTrigger = screen.getByRole('button', { name: 'Add' });
    expect(addTrigger).toHaveClass('btn-liquid');

    // The action row is a centered flex group, never a horizontal scroller
    // that would clip the dropdown.
    const actionGroup = addTrigger.closest('div')?.parentElement;
    expect(actionGroup).toHaveClass('items-center');
    expect(actionGroup).not.toHaveClass('overflow-x-auto');
  });

  it('opens the Add menu from the left edge on compact layouts', () => {
    renderHeader();

    fireEvent.click(screen.getByRole('button', { name: 'Add' }));

    expect(screen.getByRole('menu')).toHaveClass('left-0');
    expect(screen.getByRole('menu')).not.toHaveClass('right-0');
  });

  it('points the Data tab to the analysis workspace on desktop', () => {
    renderHeader();
    expect(screen.getByRole('link', { name: 'Data' })).toHaveAttribute('href', '/analysis');
  });

  it('points the Data tab to the mobile history view on phones/tablets', () => {
    vi.mocked(isDesktopBrowser).mockReturnValue(false);
    renderHeader();
    expect(screen.getByRole('link', { name: 'Data' })).toHaveAttribute('href', '/history');
  });

  it('renders the Zones/Data/Journal primary tabs, with Zones active on the dashboard', () => {
    renderHeader();
    const nav = screen.getByRole('navigation', { name: 'Primary' });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Zones' })).toHaveAttribute('href', '/dashboard');
    expect(screen.getByRole('link', { name: 'Journal' })).toHaveAttribute('href', '/journal');
    // Dashboard sets activeTab="zones"
    expect(screen.getByRole('link', { name: 'Zones' })).toHaveAttribute('aria-current', 'page');
  });

  it('offers Log activity in the Add menu', () => {
    renderHeader();
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByRole('menuitem', { name: 'Log activity' })).toBeInTheDocument();
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
