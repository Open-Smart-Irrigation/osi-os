import { describe, expect, it } from 'vitest';
import {
  defaultDesktopView,
  desktopBoundsForData,
  desktopCardHeaderTitle,
  desktopRailCardLabel,
  desktopSourceOptions,
  isRawHistoryIdentifier,
  selectableDesktopViews,
} from '../desktopHistory';
import type { HistoryCardSummary } from '../types';

function card(overrides: Partial<HistoryCardSummary> = {}): HistoryCardSummary {
  return {
    cardId: 'zone-uuid:soil:root-zone',
    cardType: 'soil',
    scope: 'zone',
    title: 'Soil Moisture',
    subtitle: 'Root-zone tension',
    defaultView: 'soil-profile',
    views: ['soil-profile', 'line-chart', 'calendar', 'irrigation-response', 'advanced'],
    supportedRanges: ['24h', '7d', '30d', 'season'],
    defaultRange: '24h',
    sourceDeviceCount: 2,
    sourceLabels: ['Chameleon 1', 'Chameleon 2'],
    sourceDevices: [
      { name: 'Chameleon 1', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'soil-src-one' },
      { name: 'Chameleon 2', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'soil-src-two' },
    ],
    metadata: { coverageConfidence: 'unknown' },
    availability: { available: true, reasons: [] },
    ordering: { pinned: false, score: 0, recentRank: null },
    ...overrides,
  };
}

describe('desktopHistory helpers', () => {
  it('keeps raw DevEUI out of rail labels', () => {
    expect(desktopRailCardLabel(card({ title: 'A84041A75D5E7CFB', sourceLabel: null }))).toBe('soil');
  });

  it('recognizes route source keys as raw identifiers', () => {
    expect(isRawHistoryIdentifier('dendro-src-644b5cb59415')).toBe(true);
    expect(isRawHistoryIdentifier('soil-src-b45d0fbbfd95')).toBe(true);
    expect(isRawHistoryIdentifier('Chameleon 1')).toBe(false);
  });

  it('uses source label to distinguish repeated single-source dendro cards', () => {
    const dendro = card({
      cardId: 'zone-uuid:dendro:dendro-src-one',
      cardType: 'dendro',
      title: 'Dendro - Growth Timeline',
      sourceLabel: 'Dendro 3',
      sourceLabels: ['Dendro 3'],
      sourceDeviceCount: 1,
      defaultView: 'growth-timeline',
      views: ['growth-timeline', 'line-chart', 'stress-events', 'calendar', 'advanced'],
    });

    expect(desktopRailCardLabel(dendro)).toBe('Dendro 3');
    expect(desktopCardHeaderTitle(dendro, 'Zone A')).toBe('Dendro 3 - Growth Timeline Zone A');
  });

  it('uses title plus zone for merged soil cards', () => {
    expect(desktopCardHeaderTitle(card(), 'Zone B')).toBe('Soil Moisture Zone B');
  });

  it('builds All plus display-safe source options for merged cards', () => {
    expect(desktopSourceOptions(card())).toEqual([
      { key: null, label: 'All' },
      { key: 'soil-src-one', label: 'Chameleon 1' },
      { key: 'soil-src-two', label: 'Chameleon 2' },
    ]);
  });

  it('filters raw source names from source options', () => {
    const options = desktopSourceOptions(card({
      sourceDevices: [
        { name: 'A84041A75D5E7CFB', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'raw' },
        { name: 'Chameleon 1', typeId: 'DRAGINO_LSN50', role: 'soil', sourceKey: 'safe' },
      ],
    }));

    expect(options).toEqual([
      { key: null, label: 'All' },
      { key: 'safe', label: 'Chameleon 1' },
    ]);
  });

  it('keeps only card-advertised views', () => {
    expect(selectableDesktopViews(card()).map((entry) => entry.view)).toEqual([
      'soil-profile',
      'line-chart',
      'calendar',
      'irrigation-response',
      'advanced',
    ]);
  });

  it('chooses the card default view when it is selectable', () => {
    expect(defaultDesktopView(card())).toBe('soil-profile');
  });

  it('falls back to the first selectable view when default view is not selectable', () => {
    expect(defaultDesktopView(card({ defaultView: 'advanced', views: ['line-chart', 'calendar'] }))).toBe('line-chart');
  });

  it('unions requested bounds and data bounds so the viewport remains representable', () => {
    expect(desktopBoundsForData(
      { minMs: 100, maxMs: 200 },
      { minMs: 120, maxMs: 150 },
    )).toEqual({ minMs: 100, maxMs: 200 });
  });
});
