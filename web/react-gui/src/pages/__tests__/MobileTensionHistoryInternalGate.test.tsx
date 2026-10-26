// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const getAll = vi.fn();
const useMobileTensionCatalog = vi.fn();
const analysisLoad = vi.fn();
let shellProps: Record<string, unknown> | null = null;

class TestHistoryAuthError extends Error {
  status: 401 | 403;
  constructor(status: 401 | 403) { super(`auth ${status}`); this.status = status; }
}

vi.mock('@osi/history-uplot', () => ({
  HistoryAuthError: TestHistoryAuthError,
  MobileTensionHistory: (props: Record<string, unknown>) => {
    shellProps = props;
    return <div data-testid="mobile-shell">{String(props.zoneLabel)}</div>;
  },
}));
vi.mock('../../services/api', () => ({ irrigationZonesAPI: { getAll } }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ sessionIdentity: { serverInstance: 'edge', principalId: null, sessionEpoch: 3 }, logout: vi.fn() }),
}));
vi.mock('../../services/authSession', () => ({ serializeSessionIdentity: () => 'test-session-key' }));
vi.mock('../../history/mobileAnalysisHistoryAdapter', () => ({ createMobileAnalysisLoader: () => analysisLoad }));
vi.mock('../../history/useMobileTensionCatalog', () => ({ useMobileTensionCatalog }));
vi.mock('../../history/mobileTensionLabels', () => ({ mobileTensionLabels: () => ({}) }));
vi.mock('../../history/mobileHistoryInternalGate', () => ({
  MOBILE_HISTORY_INTERNAL_ENABLED: false,
  MOBILE_HISTORY_INTERNAL_DIAGNOSTICS_ENABLED: true,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en', resolvedLanguage: 'en' } }) }));

let MobileTensionHistoryRoute: typeof import('../MobileTensionHistoryRoute').MobileTensionHistoryRoute;

beforeAll(async () => {
  ({ MobileTensionHistoryRoute } = await import('../MobileTensionHistoryRoute'));
});

afterEach(() => {
  cleanup();
  shellProps = null;
  delete window.__osiMobileHistoryDiagnostics;
  vi.clearAllMocks();
});

describe('edge mobile history internal gate', () => {
  it('redirects with the internal gate disabled before any zone/catalog/diagnostics work', async () => {
    useMobileTensionCatalog.mockReturnValue({ sources: [], defaultSelectedIds: [], error: null, isLoading: false, refreshForGeneration: vi.fn() });
    render(
      <MemoryRouter initialEntries={['/internal/mobile-history/zones/7']}>
        <Routes>
          <Route path="/internal/mobile-history/zones/:zoneId" element={<MobileTensionHistoryRoute />} />
          <Route path="/history" element={<output data-testid="history-route">history</output>} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByTestId('history-route')).toBeInTheDocument());
    expect(getAll).not.toHaveBeenCalled();
    expect(useMobileTensionCatalog).not.toHaveBeenCalledWith(expect.objectContaining({ enabled: true }));
    expect(analysisLoad).not.toHaveBeenCalled();
    expect(shellProps).toBeNull();
    expect(window.__osiMobileHistoryDiagnostics).toBeUndefined();
  });
});
