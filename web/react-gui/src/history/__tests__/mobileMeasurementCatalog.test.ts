import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => { if (typeof window !== 'undefined' && !window.matchMedia) window.matchMedia = (() => ({ matches: false, media: '', onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })) as typeof window.matchMedia; });
import type { AnalysisCatalogResponse } from '../../analysis/types';
import { initialMobileTensionSelection, normalizeMobileTensionCatalog } from '../mobileMeasurementCatalog';

const entry = (seriesId: string, overrides: Record<string, unknown> = {}) => ({
  seriesId,
  hubEui: 'AA',
  zoneId: 7,
  zoneName: 'North',
  cardType: 'soil',
  sourceKey: `device-${seriesId}`,
  channelKey: 'swt_1',
  displayName: `Probe ${seriesId}`,
  unit: 'kPa',
  availability: 'available' as const,
  deviceName: 'Probe',
  depthCm: 30,
  sourceKind: 'device',
  ...overrides,
});

const catalog = (channels: AnalysisCatalogResponse['channels']): AnalysisCatalogResponse => ({
  generatedAt: '2026-10-24T00:00:00.000Z',
  channels,
});

describe('edge mobile measurement catalog', () => {
  it('keeps eligible rows and visible other-supported rows without translating IDs', () => {
    const sources = normalizeMobileTensionCatalog(catalog([
      entry('opaque-1'),
      entry('other', { configurationState: 'other_supported', sourceKey: 'device-other' }),
      entry('wrong-zone', { zoneId: 8 }),
      entry('rain', { channelKey: 'rain_mm_delta' }),
      entry('legacy', { legacy: true }),
    ]), '7');

    expect(sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ seriesId: 'opaque-1', sourceKey: 'device-opaque-1', status: 'unknown' }),
      expect.objectContaining({ seriesId: 'other', status: 'other_supported' }),
    ]));
    expect(sources).toHaveLength(2);
    expect(initialMobileTensionSelection(sources, '7', undefined).selectedIds).toEqual(['opaque-1']);
  });

  it('selects eight by stable source ordering, caps saved selections at 25, and reports vanished IDs', () => {
    const sources = normalizeMobileTensionCatalog(catalog([
      ...Array.from({ length: 26 }, (_, index) => entry(`s${index}`, { sourceKey: `device-${String(index).padStart(2, '0')}`, depthCm: 30 })),
      entry('same-depth-other-device', { sourceKey: 'device-zz', depthCm: 30 }),
    ]), '7');
    expect(initialMobileTensionSelection(sources, '7', undefined).selectedIds).toHaveLength(8);
    expect(initialMobileTensionSelection(sources, '7', []).selectedIds).toEqual([]);
    expect(initialMobileTensionSelection(sources, '7', sources.map((source) => source.seriesId)).selectedIds).toHaveLength(25);
    expect(initialMobileTensionSelection(sources, '7', ['s0', 'vanished'])).toEqual({ selectedIds: ['s0'], unavailableIds: ['vanished'] });
    expect(sources.filter((source) => source.depthCm === 30).map((source) => source.sourceKey)).toContain('device-zz');
    expect(new Set(sources.filter((source) => source.depthCm === 30).map((source) => source.seriesId)).size).toBe(27);
  });
});
