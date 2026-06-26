import { describe, expect, it } from 'vitest';
import type { AnalysisViewRequest } from '../types';
import {
  adaptEdgeAnalysisView,
  adaptEdgeSavedViewResponse,
  adaptEdgeViewsResponse,
  toEdgeAnalysisViewPayload,
} from '../edgeAnalysisApi';

describe('edge analysis API adapters', () => {
  it('unwraps flattened edge view rows into the copied frontend view shape', () => {
    const view = adaptEdgeAnalysisView({
      id: 4,
      name: 'Morning comparison',
      schemaVersion: 1,
      selectors: [{ seriesId: 'abc123' }],
      range: { mode: 'relative', label: '7d', from: null, to: null },
      mode: 'timeline',
      layout: 'overlaid',
      toggles: { normalize: true },
      labelOverrides: { abc123: 'Zone A' },
      axisLabelOverrides: { swt_1: 'Soil tension' },
      isDefault: false,
      updatedAt: '2026-06-26T08:00:00.000Z',
    });

    expect(view).toEqual({
      id: 4,
      name: 'Morning comparison',
      schemaVersion: 1,
      isDefault: false,
      updatedAt: '2026-06-26T08:00:00.000Z',
      viewJson: {
        schemaVersion: 1,
        selectors: [{ seriesId: 'abc123' }],
        range: { mode: 'relative', label: '7d', from: null, to: null },
        mode: 'timeline',
        layout: 'overlaid',
        toggles: { normalize: true },
        labelOverrides: { abc123: 'Zone A' },
        axisLabelOverrides: { swt_1: 'Soil tension' },
      },
    });
  });

  it('unwraps GET /api/analysis/views response wrappers', () => {
    expect(adaptEdgeViewsResponse({ views: [{ id: 1, name: 'A', selectors: [] }] })).toHaveLength(1);
    expect(adaptEdgeViewsResponse([{ id: 2, name: 'B', selectors: [] }])).toHaveLength(1);
  });

  it('supports snake_case view metadata from edge rows', () => {
    const view = adaptEdgeAnalysisView({
      id: 5,
      name: 'Default',
      selectors: [],
      is_default: true,
      updated_at: '2026-06-26T09:00:00.000Z',
    });

    expect(view.isDefault).toBe(true);
    expect(view.updatedAt).toBe('2026-06-26T09:00:00.000Z');
  });

  it('throws for malformed GET /api/analysis/views payloads', () => {
    expect(() => adaptEdgeViewsResponse({ generatedAt: '2026-06-26T09:00:00.000Z' })).toThrow(
      /Invalid analysis views response/,
    );
  });

  it('throws for malformed saved-view responses', () => {
    expect(() => adaptEdgeSavedViewResponse({})).toThrow(/Invalid analysis saved view response/);
    expect(() => adaptEdgeSavedViewResponse({ view: {} })).toThrow(/Invalid analysis saved view response/);
  });

  it('flattens copied frontend save requests for POST /api/analysis/views', () => {
    const request: AnalysisViewRequest = {
      name: 'Saved',
      isDefault: false,
      viewJson: {
        schemaVersion: 1,
        selectors: [{ seriesId: 's1' }],
        range: { mode: 'relative', label: '24h', from: null, to: null },
        mode: 'timeline',
        layout: 'stacked',
        toggles: { normalize: false },
        labelOverrides: {},
        axisLabelOverrides: {},
      },
    };

    expect(toEdgeAnalysisViewPayload(request)).toEqual({
      schemaVersion: 1,
      selectors: [{ seriesId: 's1' }],
      range: { mode: 'relative', label: '24h', from: null, to: null },
      mode: 'timeline',
      layout: 'stacked',
      toggles: { normalize: false },
      labelOverrides: {},
      axisLabelOverrides: {},
      name: 'Saved',
      isDefault: false,
    });
  });
});
