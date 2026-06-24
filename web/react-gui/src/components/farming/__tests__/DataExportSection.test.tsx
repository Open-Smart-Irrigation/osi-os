import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DataExportSection } from '../DataExportSection';
import { zoneExportAPI } from '../../../services/api';

vi.mock('../../../services/api', () => ({
  zoneExportAPI: {
    download: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => {
      if (key === 'zone.export.rangeSummary') return `${params?.from ?? ''} to ${params?.to ?? ''}`;
      return key;
    },
  }),
}));

describe('DataExportSection', () => {
  beforeEach(() => {
    vi.mocked(zoneExportAPI.download).mockReset();
    vi.mocked(zoneExportAPI.download).mockResolvedValue(undefined);
  });

  it('downloads the selected range and granularity', async () => {
    render(<DataExportSection zoneId={12} todayIso="2026-06-03" />);

    fireEvent.doubleClick(screen.getByTestId('day-2026-06-01'));
    fireEvent.click(screen.getByRole('button', { name: /download/i }));

    await waitFor(() => {
      expect(zoneExportAPI.download).toHaveBeenCalledWith(12, {
        from: '2026-06-01',
        to: '2026-06-01',
        granularity: 'raw',
      });
    });
  });

  it('disables download until a range is chosen', () => {
    render(<DataExportSection zoneId={12} todayIso="2026-06-03" />);

    expect(screen.getByRole('button', { name: /download/i })).toBeDisabled();
  });

  it('renders calendar days and disables future days', () => {
    render(<DataExportSection zoneId={12} todayIso="2026-06-03" />);

    expect(screen.getByTestId('day-2026-06-01')).toBeEnabled();
    expect(screen.getByTestId('day-2026-06-04')).toBeDisabled();
  });

  it('shows the server suggestion when a range is too large', async () => {
    vi.mocked(zoneExportAPI.download).mockRejectedValueOnce({
      response: {
        data: {
          error: 'range too large for this granularity',
          suggestion: 'choose a coarser granularity',
        },
      },
    });
    render(<DataExportSection zoneId={12} todayIso="2026-06-03" />);

    fireEvent.doubleClick(screen.getByTestId('day-2026-06-01'));
    fireEvent.click(screen.getByRole('button', { name: /download/i }));

    expect(await screen.findByText('range too large for this granularity: choose a coarser granularity')).toBeInTheDocument();
  });
});
