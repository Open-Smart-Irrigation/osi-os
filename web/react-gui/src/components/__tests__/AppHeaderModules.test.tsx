// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppHeader } from '../AppHeader';
import { isDesktopBrowser } from '../../utils/isDesktopBrowser';

// Module visibility (2026-09-17): the Data view is switchable off in Settings.
// AppHeader carries the primary tab bar (Zones / Data / Journal), so it is the
// second place the Data entry has to disappear from — DashboardHeader is the
// other. Hiding is UI-only: /analysis and /history stay routable.

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        'tabs.zones': 'Zones',
        'tabs.data': 'Data',
        'tabs.journal': 'Journal',
        network: 'Network',
        admin: 'Admin',
        'adminMenu.users': 'Users',
        'adminMenu.grants': 'Grants',
        'settings:entryPoint': 'Settings',
        account: 'Account',
        'accountMenu.osiServer': 'OSI Server',
        logout: 'Logout',
      };
      if (key === 'welcome') return `Welcome ${String(options?.username ?? '')}`;
      return map[key] ?? key;
    },
  }),
}));

vi.mock('../../utils/isDesktopBrowser', () => ({
  isDesktopBrowser: vi.fn(() => true),
}));

// All four visibility modules are GATEWAY-level settings (Phil, 2026-09-17):
// every user of a gateway sees the same surface, and the choice survives a
// browser change. The header reads them through this hook.
// `flags` is null until the gateway answers -- the hook's unknown state, which
// the header has to render as "nothing gated yet" rather than guessing.
const gatewayModules = vi.hoisted(() => ({
  flags: { data: true, network: true, gatewayHub: true, journal: true } as
    { data: boolean; network: boolean; gatewayHub: boolean; journal: boolean } | null,
}));

vi.mock('../../hooks/useGatewayModules', () => ({
  useGatewayModules: () => gatewayModules.flags,
}));

function renderAppHeader() {
  render(
    <MemoryRouter initialEntries={['/journal']}>
      <AppHeader title="Field Journal" activeTab="journal" username="farmer" onLogout={vi.fn()} />
    </MemoryRouter>,
  );
}

function renderAppHeaderOnNetwork() {
  render(
    <MemoryRouter initialEntries={['/network']}>
      <AppHeader title="Network observations" activeTab="network" username="farmer" onLogout={vi.fn()} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  gatewayModules.flags = { data: true, network: true, gatewayHub: true, journal: true };
  vi.mocked(isDesktopBrowser).mockReturnValue(true);
});

afterEach(() => {
  cleanup();
});

describe('AppHeader module visibility', () => {
  it('renders every primary tab when the modules are on by default', () => {
    renderAppHeader();

    expect(screen.getByRole('link', { name: 'Zones' })).toHaveAttribute('href', '/dashboard');
    expect(screen.getByRole('link', { name: 'Data' })).toHaveAttribute('href', '/analysis');
    expect(screen.getByRole('link', { name: 'Journal' })).toHaveAttribute('href', '/journal');
  });

  // Rendering either answer before the gateway has given one flashes the wrong
  // header on some gateway: the tabs appear and are taken away, or the reverse.
  it('renders no gated tab while the gateway has not answered yet', () => {
    gatewayModules.flags = null;
    renderAppHeader();

    expect(screen.queryByRole('link', { name: 'Data' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Journal' })).not.toBeInTheDocument();
    // Ungated navigation is unaffected: this is about the switchable entries.
    expect(screen.getByRole('link', { name: 'Zones' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Settings' })).toBeInTheDocument();
  });

  it('hides the Data tab when the data module is off and keeps the others', () => {
    gatewayModules.flags!.data = false;
    renderAppHeader();

    expect(screen.queryByRole('link', { name: 'Data' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Zones' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Journal' })).toBeInTheDocument();
  });

  it('hides the Journal tab when the journal module is off and keeps the others', () => {
    gatewayModules.flags!.journal = false;
    renderAppHeader();

    expect(screen.queryByRole('link', { name: 'Journal' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Zones' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Data' })).toBeInTheDocument();
  });

  it('hides both the Data and Journal tabs when both modules are off', () => {
    gatewayModules.flags!.journal = false;
    gatewayModules.flags!.data = false;
    renderAppHeader();

    expect(screen.queryByRole('link', { name: 'Data' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Journal' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Zones' })).toBeInTheDocument();
  });

  it('keeps Settings and Account reachable with the data module off', () => {
    gatewayModules.flags!.data = false;
    renderAppHeader();

    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('button', { name: 'Account' })).toBeInTheDocument();
  });
});

// Coverage walk (2026-09-25): NetworkPage had no "way back" and no "where am
// I" -- a lone Zones pill next to it. Same gate as DashboardHeader's own
// Network link: desktop browser, module switched on for this gateway.
describe('AppHeader Network tab', () => {
  it('shows the Network tab, active, when the module is on and it is on the Network page', () => {
    renderAppHeaderOnNetwork();

    const link = screen.getByRole('link', { name: 'Network' });
    expect(link).toHaveAttribute('href', '/network');
    expect(link).toHaveAttribute('aria-current', 'page');
  });

  it('hides the Network tab when the network module is off and keeps the others', () => {
    gatewayModules.flags!.network = false;
    renderAppHeaderOnNetwork();

    expect(screen.queryByRole('link', { name: 'Network' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Zones' })).toBeInTheDocument();
  });

  it('renders no Network tab while the gateway has not answered yet', () => {
    gatewayModules.flags = null;
    renderAppHeaderOnNetwork();

    expect(screen.queryByRole('link', { name: 'Network' })).not.toBeInTheDocument();
  });

  it('hides the Network tab on a mobile browser even when the module is on', () => {
    vi.mocked(isDesktopBrowser).mockReturnValue(false);
    renderAppHeaderOnNetwork();

    expect(screen.queryByRole('link', { name: 'Network' })).not.toBeInTheDocument();
  });

  it('does not mark Network active on another page', () => {
    render(
      <MemoryRouter initialEntries={['/journal']}>
        <AppHeader title="Field Journal" activeTab="journal" username="farmer" onLogout={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'Network' })).not.toHaveAttribute('aria-current');
  });
});
