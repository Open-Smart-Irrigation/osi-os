import { describe, expect, it } from 'vitest';
import { resolveAnalysisRangeForRequest } from '../range';
import type { AnalysisRange } from '../types';

const now = new Date('2026-06-26T12:00:00.000Z');

function relative(label: string): AnalysisRange {
  return { mode: 'relative', label, from: null, to: null };
}

describe('resolveAnalysisRangeForRequest', () => {
  it('resolves relative 24h ranges to concrete ISO bounds for the edge backend', () => {
    expect(resolveAnalysisRangeForRequest(relative('24h'), now)).toEqual({
      mode: 'absolute',
      label: '24h',
      from: '2026-06-25T12:00:00.000Z',
      to: '2026-06-26T12:00:00.000Z',
    });
  });

  it('uses a 180 day edge season fallback', () => {
    expect(resolveAnalysisRangeForRequest(relative('season'), now).from).toBe('2025-12-28T12:00:00.000Z');
  });

  it('resolves relative 90d ranges emitted by copied analysis controls', () => {
    expect(resolveAnalysisRangeForRequest(relative('90d'), now)).toEqual({
      mode: 'absolute',
      label: '90d',
      from: '2026-03-28T12:00:00.000Z',
      to: '2026-06-26T12:00:00.000Z',
    });
  });

  it('keeps explicit ranges when both bounds are present', () => {
    const explicit: AnalysisRange = {
      mode: 'absolute',
      label: 'custom',
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-02T00:00:00.000Z',
    };
    expect(resolveAnalysisRangeForRequest(explicit, now)).toEqual(explicit);
  });
});
