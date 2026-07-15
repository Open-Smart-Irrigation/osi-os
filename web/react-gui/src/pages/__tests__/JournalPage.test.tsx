import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  useJournalCatalog: vi.fn(),
  useJournalEntries: vi.fn(),
  useJournalPlots: vi.fn(),
  timeline: vi.fn(),
  retryCatalog: vi.fn(),
  retryEntries: vi.fn(),
  retryPlots: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ username: 'farmer', logout: vi.fn() }),
}));
vi.mock('../../components/AppHeader', () => ({ AppHeader: () => <header /> }));
vi.mock('../../journal/useJournalCatalog', () => ({
  useJournalCatalog: mocks.useJournalCatalog,
}));
vi.mock('../../journal/useJournalEntries', () => ({
  useJournalEntries: mocks.useJournalEntries,
}));
vi.mock('../../journal/useJournalPlots', () => ({
  useJournalPlots: mocks.useJournalPlots,
}));
vi.mock('../../components/journal/JournalTimeline', () => ({
  JournalTimeline: (props: unknown) => {
    mocks.timeline(props);
    return <div data-testid="timeline" />;
  },
}));

import { JournalPage } from '../JournalPage';

const catalog = {
  vocab: [{ code: 'irrigation', kind: 'activity', active: 1 }],
};
const entries = [{ entry_uuid: 'e1' }];
const plots = [{ plot_uuid: 'p1', plot_code: 'N-1', name: 'North field' }];

describe('JournalPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useJournalCatalog.mockReturnValue({
      catalog,
      available: true,
      unavailable: false,
      loading: false,
      error: undefined,
      retry: mocks.retryCatalog,
    });
    mocks.useJournalEntries.mockReturnValue({
      entries,
      loading: false,
      error: undefined,
      retry: mocks.retryEntries,
    });
    mocks.useJournalPlots.mockReturnValue({
      plots,
      loading: false,
      error: undefined,
      retry: mocks.retryPlots,
    });
  });

  it('keeps reads disabled while the catalog probe is loading', () => {
    mocks.useJournalCatalog.mockReturnValue({
      catalog: undefined,
      available: false,
      unavailable: false,
      loading: true,
      error: undefined,
      retry: mocks.retryCatalog,
    });

    render(<JournalPage />);

    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByText('timeline.loading')).toBeInTheDocument();
    expect(mocks.useJournalEntries).toHaveBeenCalledWith(expect.anything(), false);
    expect(mocks.useJournalPlots).toHaveBeenCalledWith(false);
  });

  it('renders capability absence only for unavailable gateways', () => {
    mocks.useJournalCatalog.mockReturnValue({
      catalog: undefined,
      available: false,
      unavailable: true,
      loading: false,
      error: undefined,
      retry: mocks.retryCatalog,
    });

    render(<JournalPage />);

    expect(screen.getByText('unavailable.title')).toBeInTheDocument();
    expect(screen.queryByText('error.title')).not.toBeInTheDocument();
  });

  it('renders and retries a catalog operational error', () => {
    mocks.useJournalCatalog.mockReturnValue({
      catalog: undefined,
      available: false,
      unavailable: false,
      loading: false,
      error: new Error('offline'),
      retry: mocks.retryCatalog,
    });

    render(<JournalPage />);

    expect(screen.getByText('error.title')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'error.retry' }));
    expect(mocks.retryCatalog).toHaveBeenCalledOnce();
  });

  it.each([
    ['entry', 'useJournalEntries'],
    ['plot', 'useJournalPlots'],
  ])('does not turn a failed %s read into the empty state', (_kind, hookName) => {
    if (hookName === 'useJournalEntries') {
      mocks.useJournalEntries.mockReturnValue({
        entries: [],
        loading: false,
        error: new Error('offline'),
        retry: mocks.retryEntries,
      });
    } else {
      mocks.useJournalPlots.mockReturnValue({
        plots: [],
        loading: false,
        error: new Error('offline'),
        retry: mocks.retryPlots,
      });
    }

    render(<JournalPage />);

    expect(screen.getByText('error.title')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'error.retry' }));
    expect(mocks.retryEntries).toHaveBeenCalledOnce();
    expect(mocks.retryPlots).toHaveBeenCalledOnce();
  });

  it('renders reads and applies final-only plot and activity filters', async () => {
    render(<JournalPage />);

    const logActivity = screen.getByRole('button', { name: 'logActivity' });
    expect(logActivity).toHaveClass('btn-liquid');
    expect(mocks.timeline).toHaveBeenCalledWith(expect.objectContaining({ entries, plots }));

    fireEvent.change(screen.getByLabelText('filters.plot'), {
      target: { value: 'p1' },
    });
    fireEvent.change(screen.getByLabelText('filters.activity'), {
      target: { value: 'irrigation' },
    });

    await waitFor(() => expect(mocks.useJournalEntries).toHaveBeenLastCalledWith(
      {
        status: 'final',
        limit: 50,
        plot_uuid: 'p1',
        activity_code: 'irrigation',
      },
      true,
    ));
  });
});
