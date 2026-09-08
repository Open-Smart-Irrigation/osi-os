// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScopeProvider, useScope } from '../../contexts/ScopeContext';
import { fetchScopeProfile } from '../../services/api';
import { ScopeStatusBanner } from '../ScopeStatusBanner';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ token: 'scope-test-token' }),
}));

vi.mock('../../services/api', () => ({
  fetchScopeProfile: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => ({
      'scope.loadError': 'Permissions could not be loaded.',
      'retry': 'Retry',
    })[key] ?? key,
  }),
}));

const mockedFetchScopeProfile = vi.mocked(fetchScopeProfile);

function AuthorityProbe() {
  const scope = useScope();
  return (
    <output data-testid="authority">
      {`${scope.loading}:${scope.canWrite}:${scope.isAdmin}`}
    </output>
  );
}

describe('ScopeStatusBanner', () => {
  beforeEach(() => {
    mockedFetchScopeProfile.mockReset();
  });

  it('shows a failed lookup, retries, and stays closed until resolution', async () => {
    let resolveRetry: ((profile: {
      username: string;
      user_uuid: string;
      role: 'admin';
      zone_uuids: null;
      plot_uuids: null;
      features: { scoped_access: false };
    }) => void) | undefined;
    mockedFetchScopeProfile
      .mockRejectedValueOnce(new Error('offline'))
      .mockReturnValueOnce(new Promise((resolve) => {
        resolveRetry = resolve;
      }));

    render(
      <ScopeProvider>
        <ScopeStatusBanner />
        <AuthorityProbe />
      </ScopeProvider>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Permissions could not be loaded.');
    expect(screen.getByTestId('authority')).toHaveTextContent('false:false:false');

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('authority')).toHaveTextContent('true:false:false');

    resolveRetry?.({
      username: 'admin',
      user_uuid: 'u-admin',
      role: 'admin',
      zone_uuids: null,
      plot_uuids: null,
      features: { scoped_access: false },
    });

    await waitFor(() => {
      expect(screen.getByTestId('authority')).toHaveTextContent('false:true:true');
    });
  });
});
