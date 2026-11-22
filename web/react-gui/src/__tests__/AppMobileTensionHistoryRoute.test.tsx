// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { HashRouter } from 'react-router-dom';
vi.hoisted(() => {
  vi.stubEnv('VITE_MOBILE_HISTORY_INTERNAL', 'true');
  vi.stubEnv('VITE_MOBILE_HISTORY_INTERNAL_DIAGNOSTICS', 'true');
});

vi.mock('../pages/MobileTensionHistoryRoute', () => ({
  MobileTensionHistoryRoute: () => <div>DEFERRED_PHONE_CHART</div>,
}));

vi.mock('../AppProviders', () => ({
  AppProviders: ({ children }: { children: ReactNode }) => {
    return <HashRouter>{children}</HashRouter>;
  },
}));
vi.mock('../components/PrivateRoute', () => ({ PrivateRoute: ({ children }: { children: ReactNode }) => <div data-testid="private-route">{children}</div> }));
vi.mock('../components/ScopeStatusBanner', () => ({ ScopeStatusBanner: () => null }));
vi.mock('../components/GatewayRestartBanner', () => ({ GatewayRestartBanner: () => null }));
vi.mock('../components/AdminOnly', () => ({ AdminOnly: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock('../pages/Login', () => ({ Login: () => <div>LOGIN</div> }));
vi.mock('../pages/Register', () => ({ Register: () => <div>REGISTER</div> }));
vi.mock('../pages/FarmingDashboard', () => ({ FarmingDashboard: () => <div>DASHBOARD_PAGE</div> }));
vi.mock('../pages/JournalPage', () => ({ JournalPage: () => <div>JOURNAL_PAGE</div> }));
vi.mock('../pages/HistoryDashboard', () => ({ HistoryDashboard: () => <div>HISTORY_PAGE</div> }));
vi.mock('../pages/HistoryCardDetailPage', () => ({ HistoryCardDetailPage: () => <div>DETAIL_PAGE</div> }));
vi.mock('../pages/AccountLink', () => ({ AccountLink: () => <div>ACCOUNT_LINK</div> }));
vi.mock('../pages/SettingsPage', () => ({ SettingsPage: () => <div>SETTINGS_PAGE</div> }));
vi.mock('../pages/admin/UsersPage', () => ({ UsersPage: () => <div>USERS</div> }));
vi.mock('../pages/admin/GrantsPage', () => ({ GrantsPage: () => <div>GRANTS</div> }));
vi.mock('../pages/NetworkPage', () => ({ NetworkPage: () => <div>NETWORK</div> }));
vi.mock('../pages/AnalysisRoute', () => ({ AnalysisRoute: () => <div>ANALYSIS</div> }));

import App from '../App';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

describe('mobile tension history app route', () => {
  it('redirects the disabled route through the existing private route boundary', async () => {
    window.location.hash = '#/internal/mobile-history/zones/7';
    render(<App />);
    expect(await screen.findByText('HISTORY_PAGE')).toBeInTheDocument();
    expect(screen.getByTestId('private-route')).toBeInTheDocument();
  });
});
