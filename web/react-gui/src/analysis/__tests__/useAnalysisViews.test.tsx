// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { SWRConfig } from 'swr';
import React from 'react';
import { useAnalysisViews } from '../useAnalysisViews';
import { analysisAPI } from '../../services/api';
import type { AnalysisViewResponse } from '../types';

vi.mock('../../services/api', () => ({
  analysisAPI: { listViews: vi.fn(), saveView: vi.fn() },
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

const view = (id: number, name: string): AnalysisViewResponse => ({
  id,
  name,
  schemaVersion: 1,
  isDefault: false,
  updatedAt: 't',
  viewJson: {
    schemaVersion: 1,
    selectors: [],
    range: { mode: 'relative', label: '7d', from: null, to: null },
    mode: 'timeline',
    layout: 'stacked',
    toggles: { normalize: false },
  },
});

describe('useAnalysisViews', () => {
  beforeEach(() => vi.clearAllMocks());

  it('lists views without exposing unsupported delete actions', async () => {
    (analysisAPI.listViews as ReturnType<typeof vi.fn>).mockResolvedValue([view(1, 'A'), view(2, 'B')]);

    const { result } = renderHook(() => useAnalysisViews(), { wrapper });
    await waitFor(() => expect(result.current.views).toHaveLength(2));

    expect(result.current).not.toHaveProperty('deleteView');
  });

  it('prepends a saved view to the cache', async () => {
    (analysisAPI.listViews as ReturnType<typeof vi.fn>).mockResolvedValue([view(2, 'B')]);
    (analysisAPI.saveView as ReturnType<typeof vi.fn>).mockResolvedValue(view(3, 'C'));

    const { result } = renderHook(() => useAnalysisViews(), { wrapper });
    await waitFor(() => expect(result.current.views).toHaveLength(1));

    await act(async () => {
      await result.current.saveView({ name: 'C', viewJson: view(3, 'C').viewJson, isDefault: false });
    });
    expect(result.current.views.map((v) => v.id)).toEqual([3, 2]);
  });
});
