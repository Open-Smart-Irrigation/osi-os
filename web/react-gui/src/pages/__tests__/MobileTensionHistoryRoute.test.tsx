// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const getAll = vi.fn();
const useMobileTensionCatalog = vi.fn();
const analysisLoad = vi.fn();
const createMobileAnalysisLoader = vi.fn(() => analysisLoad);
const logout = vi.fn();
let shellProps: Record<string, unknown> | null = null;
const diagnosticsOwner = { source: 'edge-test-owner' };

class TestHistoryAuthError extends Error {
  status: 401 | 403;
  constructor(status: 401 | 403) {
    super(`auth ${status}`);
    this.status = status;
  }
}

vi.mock('@osi/history-uplot', () => ({
  HistoryAuthError: TestHistoryAuthError,
  MobileTensionHistory: (props: Record<string, unknown>) => {
    shellProps = props;
    useEffect(() => {
      const register = props.registerInternalDiagnostics as ((value: unknown) => void) | undefined;
      register?.(diagnosticsOwner);
      return () => register?.(null);
    }, [props.registerInternalDiagnostics]);
    return <div data-testid="mobile-shell">{String(props.zoneLabel)}</div>;
  },
}));
vi.mock('../../services/api', () => ({ irrigationZonesAPI: { getAll } }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ sessionIdentity: { serverInstance: 'edge', principalId: null, sessionEpoch: 3 }, logout }),
}));
vi.mock('../../services/authSession', () => ({ serializeSessionIdentity: (identity: unknown) => JSON.stringify(identity) }));
vi.mock('../../history/mobileAnalysisHistoryAdapter', () => ({ createMobileAnalysisLoader }));
vi.mock('../../history/useMobileTensionCatalog', () => ({ useMobileTensionCatalog }));
vi.mock('../../history/mobileTensionLabels', () => ({ mobileTensionLabels: () => ({}) }));
vi.mock('../../history/mobileHistoryInternalGate', () => ({
  MOBILE_HISTORY_INTERNAL_ENABLED: true,
  MOBILE_HISTORY_INTERNAL_DIAGNOSTICS_ENABLED: true,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en', resolvedLanguage: 'en' } }) }));

let MobileTensionHistoryRoute: (props?: Record<string, never>) => ReactNode;
let parseMobileHistoryZoneId: (value: string | undefined) => number | null;

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}</output>;
}

function NavigationControls() {
  const navigate = useNavigate();
  return <button type="button" data-testid="navigate-to-eight" onClick={() => navigate('/internal/mobile-history/zones/8')}>navigate</button>;
}

function routeTree(path: string) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/internal/mobile-history/zones/:zoneId" element={<MobileTensionHistoryRoute />} />
        <Route path="/history" element={<LocationProbe />} />
      </Routes>
      <NavigationControls />
    </MemoryRouter>
  );
}

function renderRoute(path: string) {
  return render(routeTree(path));
}

beforeAll(async () => {
  ({ MobileTensionHistoryRoute, parseMobileHistoryZoneId } = await import('../MobileTensionHistoryRoute'));
});

beforeEach(() => {
  getAll.mockReset();
  useMobileTensionCatalog.mockReset();
  createMobileAnalysisLoader.mockClear();
  analysisLoad.mockReset();
  logout.mockReset();
  shellProps = null;
  delete window.__osiMobileHistoryDiagnostics;
  useMobileTensionCatalog.mockReturnValue({ sources: [], defaultSelectedIds: [], error: null, isLoading: false, refreshForGeneration: vi.fn() });
});

afterEach(() => cleanup());

describe('mobile tension history route', () => {
  it('uses both exact build flags and owner checked global cleanup for diagnostics', () => {
    const source = readFileSync(resolve(__dirname, '../MobileTensionHistoryRoute.tsx'), 'utf8');
    expect(source).toContain('MOBILE_HISTORY_INTERNAL_ENABLED && MOBILE_HISTORY_INTERNAL_DIAGNOSTICS_ENABLED');
    expect(source).toContain('window.__osiMobileHistoryDiagnostics === owner');
  });

  it('accepts only positive safe decimal integer zone ids', () => {
    expect(parseMobileHistoryZoneId('1')).toBe(1);
    expect(parseMobileHistoryZoneId('001')).toBe(1);
    expect(parseMobileHistoryZoneId('0')).toBeNull();
    expect(parseMobileHistoryZoneId('-1')).toBeNull();
    expect(parseMobileHistoryZoneId('1e2')).toBeNull();
    expect(parseMobileHistoryZoneId('9007199254740992')).toBeNull();
    expect(parseMobileHistoryZoneId(undefined)).toBeNull();
  });

  it('loads the zone before enabling the catalog and passes the exact edge shell contract', async () => {
    getAll.mockResolvedValue([{ id: 7, name: 'North block', timezone: 'UTC' }]);
    renderRoute('/internal/mobile-history/zones/7');
    await waitFor(() => expect(screen.getByTestId('mobile-shell')).toHaveTextContent('North block'));
    expect(useMobileTensionCatalog).toHaveBeenCalledWith(expect.objectContaining({ enabled: true, zoneId: '7' }));
    expect(shellProps?.context).toEqual({
      sessionKey: '{"serverInstance":"edge","principalId":null,"sessionEpoch":3}',
      scopeKey: 'zone:7',
      cardId: 'mobile-water-tension',
    });
    expect(shellProps?.locale).toBe('en');
    expect(shellProps?.timeZone).toBe('UTC');
    expect(shellProps?.zoneLabel).toBe('North block');
    expect(shellProps?.sources).toEqual([]);
    expect(shellProps?.defaultSelectedIds).toEqual([]);
    expect(shellProps?.catalogLoading).toBe(false);
    expect(shellProps?.catalogError).toBeNull();
    expect(typeof shellProps?.refreshCatalogForGeneration).toBe('function');
    expect((shellProps?.readPolicy as (request: { from: number; to: number }) => string)({ from: 0, to: 1 })).toBe('edge-hourly');
    await waitFor(() => expect(window.__osiMobileHistoryDiagnostics).toBe(diagnosticsOwner));
    const onAuthError = shellProps?.onAuthError as (error: unknown) => void;
    onAuthError(new TestHistoryAuthError(403));
    expect(logout).not.toHaveBeenCalled();
    onAuthError(new TestHistoryAuthError(401));
    expect(logout).toHaveBeenCalledTimes(1);
  });

  it('does not enable the catalog when the zone timezone is absent or invalid', async () => {
    getAll.mockResolvedValue([{ id: 7, name: 'North block', timezone: 'Not/AZone' }]);
    renderRoute('/internal/mobile-history/zones/7');
    await waitFor(() => expect(screen.getByText('history.mobileTension.route.timeZoneUnavailable')).toBeInTheDocument());
    expect(useMobileTensionCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    expect(shellProps).toBeNull();
    expect(analysisLoad).not.toHaveBeenCalled();
  });

  it('does not enable catalog or analysis for a missing timezone', async () => {
    getAll.mockResolvedValue([{ id: 7, name: 'North block' }]);
    renderRoute('/internal/mobile-history/zones/7');
    await waitFor(() => expect(screen.getByText('history.mobileTension.route.timeZoneUnavailable')).toBeInTheDocument());
    expect(useMobileTensionCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    expect(shellProps).toBeNull();
    expect(analysisLoad).not.toHaveBeenCalled();
  });

  it('does not carry the prior zone across a 7 to 8 navigation while the new list is loading', async () => {
    const resolvers: Array<(zones: Array<{ id: number; name: string; timezone: string }>) => void> = [];
    getAll.mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const view = renderRoute('/internal/mobile-history/zones/7');
    await waitFor(() => expect(resolvers).toHaveLength(1));
    resolvers[0]([{ id: 7, name: 'North block', timezone: 'UTC' }]);
    await waitFor(() => expect(screen.getByTestId('mobile-shell')).toHaveTextContent('North block'));
    fireEvent.click(screen.getByTestId('navigate-to-eight'));
    expect(screen.getByText('history.mobileTension.route.zoneLoading')).toBeInTheDocument();
    await waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]([{ id: 8, name: 'East block', timezone: 'UTC' }]);
    await waitFor(() => expect(screen.getByTestId('mobile-shell')).toHaveTextContent('East block'));
    expect(screen.queryByTestId('location')).not.toBeInTheDocument();
  });

  it('offers retry for a zone-list transport failure', async () => {
    getAll.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([{ id: 7, name: 'North block', timezone: 'UTC' }]);
    renderRoute('/internal/mobile-history/zones/7');
    await waitFor(() => expect(screen.getByText('history.mobileTension.route.zonesFailed')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'history.mobileTension.retry' }));
    await waitFor(() => expect(screen.getByTestId('mobile-shell')).toHaveTextContent('North block'));
    expect(getAll).toHaveBeenCalledTimes(2);
  });

  it('redirects malformed zone ids without loading zones or catalog data', async () => {
    renderRoute('/internal/mobile-history/zones/1e2');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/history'));
    expect(getAll).not.toHaveBeenCalled();
    expect(useMobileTensionCatalog).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('redirects an absent zone only after the successful zone list arrives', async () => {
    getAll.mockResolvedValue([{ id: 8, name: 'Other block', timezone: 'UTC' }]);
    renderRoute('/internal/mobile-history/zones/7');
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/history'));
  });

  it('keeps a catalog 403 local and does not log out', async () => {
    getAll.mockResolvedValue([{ id: 7, name: 'North block', timezone: 'UTC' }]);
    useMobileTensionCatalog.mockReturnValue({
      sources: [], defaultSelectedIds: [], error: new TestHistoryAuthError(403), isLoading: false, refreshForGeneration: vi.fn(),
    });
    renderRoute('/internal/mobile-history/zones/7');
    await waitFor(() => expect(screen.getByText('history.mobileTension.accessDenied')).toBeInTheDocument());
    expect(logout).not.toHaveBeenCalled();
  });

  it('clears the mounted shell on refetch 403 and only logs out when the refetch becomes 401', async () => {
    getAll.mockResolvedValue([{ id: 7, name: 'North block', timezone: 'UTC' }]);
    const view = renderRoute('/internal/mobile-history/zones/7');
    await waitFor(() => expect(screen.getByTestId('mobile-shell')).toBeInTheDocument());
    useMobileTensionCatalog.mockReturnValue({
      sources: [], defaultSelectedIds: [], error: new TestHistoryAuthError(403), isLoading: false, refreshForGeneration: vi.fn(),
    });
    view.rerender(routeTree('/internal/mobile-history/zones/7'));
    await waitFor(() => expect(screen.getByText('history.mobileTension.accessDenied')).toBeInTheDocument());
    expect(screen.queryByTestId('mobile-shell')).not.toBeInTheDocument();
    expect(window.__osiMobileHistoryDiagnostics).toBeUndefined();
    expect(logout).not.toHaveBeenCalled();
    useMobileTensionCatalog.mockReturnValue({
      sources: [], defaultSelectedIds: [], error: new TestHistoryAuthError(401), isLoading: false, refreshForGeneration: vi.fn(),
    });
    view.rerender(routeTree('/internal/mobile-history/zones/7'));
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  });

  it('leaves a replacement diagnostics owner when the route unmounts', async () => {
    getAll.mockResolvedValue([{ id: 7, name: 'North block', timezone: 'UTC' }]);
    const view = renderRoute('/internal/mobile-history/zones/7');
    await waitFor(() => expect(window.__osiMobileHistoryDiagnostics).toBe(diagnosticsOwner));
    const replacement = { source: 'replacement-owner' };
    window.__osiMobileHistoryDiagnostics = replacement;
    view.unmount();
    expect(window.__osiMobileHistoryDiagnostics).toBe(replacement);
  });

  it('uses the existing session-expiry path for a catalog 401', async () => {
    getAll.mockResolvedValue([{ id: 7, name: 'North block', timezone: 'UTC' }]);
    useMobileTensionCatalog.mockReturnValue({
      sources: [], defaultSelectedIds: [], error: new TestHistoryAuthError(401), isLoading: false, refreshForGeneration: vi.fn(),
    });
    renderRoute('/internal/mobile-history/zones/7');
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  });
});
